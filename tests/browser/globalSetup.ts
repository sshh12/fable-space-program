import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createServer, type ViteDevServer } from 'vite';
import { ISOLATION_HEADERS } from '../../tools/server/dataPlugin';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

/**
 * Starts a private Vite dev server on an OS-assigned port for this test run and publishes its URL in
 * E2E_BASE_URL. Several agents can run browser tests at the same time without colliding.
 *
 * THE SERVER IS FROZEN AT THE START OF THE RUN, because other agents save files in the same working tree
 * while a run is under way:
 *  - it watches no file and has no hot reload (`watch: null`, `hmr: false`): it never reloads a page and
 *    never drops a module it has transformed;
 *  - before the first test, every module the pages can load is transformed once: the entry scripts of
 *    index.html and of every labs/<name>/index.html, and from them every module they import, statically or
 *    by a literal dynamic import (`freezeModules`). The harness keeps that text and answers every request
 *    for such a module with it, in front of the server's own handling (the server's cache alone was seen
 *    to give a module in its saved form). A module is served for the whole run as it was then;
 *  - the definition files are read once, at the server's start, and served from that copy
 *    (FSP_FREEZE_DEFS, tools/server/dataPlugin.ts).
 * So a run sees the source and the definitions AS THEY WERE WHEN IT STARTED, whatever is saved meanwhile.
 * NOT frozen: the HTML files themselves, the tile and sky data (read from disk at each request), a module
 * that only a non-literal dynamic import reaches, and the spec files, which Playwright loads as it goes.
 * At the end of the run the files that changed under it are printed (`reportChanges`): the pages did not
 * see those changes, but the specs and the data may have, so a failure of such a run is looked at twice.
 * Set E2E_BASE_URL yourself to test an already running server (e.g. `vite preview` of a build).
 *
 * Inside a local stack (`npm run stack -- [options] -- <command>`, ARCHITECTURE 16.4) the launcher has
 * already started the page a browser loads and hands its address in STACK_URL: no server is started here and
 * every spec of the run (the `functional` and `acceptance` projects are the ones run there) loads that
 * page, which serves the stack's endpoint document at /endpoints.json. STACK_URL wins over E2E_BASE_URL.
 */
export default async function globalSetup(): Promise<() => Promise<void>> {
  if (process.env.STACK_URL) {
    const url = process.env.STACK_URL;
    process.env.E2E_BASE_URL = url.endsWith('/') ? url.slice(0, -1) : url;
    return async () => undefined;
  }
  if (process.env.E2E_BASE_URL) return async () => undefined;
  let server: ViteDevServer | null = null;
  const port = await freePort();
  const startedMs = Date.now();
  const headAtStart = git(['rev-parse', 'HEAD']);
  process.env.FSP_FREEZE_DEFS = '1';
  server = await createServer({
    root: repoRoot,
    configFile: path.join(repoRoot, 'vite.config.ts'),
    logLevel: 'error',
    server: { port, strictPort: true, host: '127.0.0.1', hmr: false, watch: null },
  });
  await server.listen();
  const freezeFrom = Date.now();
  const frozen = await freezeModules(server);
  console.log(`[harness] page server frozen at the start of the run: ${frozen.modules} modules from ${frozen.pages} pages in ${Date.now() - freezeFrom} ms${frozen.failed.length > 0 ? `; NOT transformed (${frozen.failed.length}): ${frozen.failed.slice(0, 8).join(', ')}` : ''}; HEAD ${headAtStart.slice(0, 7)}`);
  process.env.E2E_BASE_URL = `http://127.0.0.1:${port}`;
  // For the spec that proves the freeze (tests/browser/shell/harness-freeze.spec.ts): this server is the frozen one.
  process.env.FSP_HARNESS_FROZEN = '1';
  return async () => {
    await server?.close();
    reportChanges(startedMs, headAtStart);
  };
}

function git(args: string[]): string {
  try {
    return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim();
  } catch {
    return '';
  }
}

/** The pages a browser test can open: index.html and every labs/<name>/index.html, as server paths. */
function htmlPages(): string[] {
  const pages = ['/index.html'];
  const labs = path.join(repoRoot, 'labs');
  for (const name of fs.existsSync(labs) ? fs.readdirSync(labs).sort() : []) {
    if (fs.existsSync(path.join(labs, name, 'index.html'))) pages.push(`/labs/${name}/index.html`);
  }
  return pages;
}

/**
 * Transform every module the pages can load, once, now: the module scripts of each page (an inline one
 * through the proxy module Vite makes of it), then everything they import. With no watcher the server keeps
 * each result for as long as it lives, so this is the source the whole run is served.
 */
async function freezeModules(server: ViteDevServer): Promise<{ modules: number; pages: number; failed: string[] }> {
  const env = server.environments.client;
  const queue: string[] = [];
  const pages = htmlPages();
  for (const page of pages) {
    try {
      const html = await server.transformIndexHtml(page, fs.readFileSync(path.join(repoRoot, page), 'utf8'));
      for (const m of html.matchAll(/<script\b[^>]*\btype="module"[^>]*\bsrc="([^"]+)"/g)) {
        // The address as the browser resolves it: against the page, with the HTML's `&amp;` read as `&`.
        const at = new URL(m[1]!.replaceAll('&amp;', '&'), `http://page${page}`);
        if (at.host === 'page') queue.push(at.pathname + at.search);
      }
    } catch {
      // A page that does not transform fails in the test that opens it, with its own message.
    }
  }
  const seen = new Set<string>();
  const failed: string[] = [];
  const taken = new Map<string, { body: Buffer; etag: string }>();
  while (queue.length > 0) {
    const url = queue.pop()!;
    if (seen.has(url) || /^(https?:)?\/\//.test(url)) continue;
    seen.add(url);
    try {
      const result = await env.transformRequest(url);
      if (!result) throw new Error('no result');
      // The text as the server sends it: the code, and its source map so that an error names the source line.
      const map = result.map && 'mappings' in result.map && result.map.mappings !== '' ? `\n//# sourceMappingURL=data:application/json;base64,${Buffer.from(JSON.stringify(result.map)).toString('base64')}` : '';
      const body = Buffer.from(result.code + map, 'utf8');
      taken.set(url, { body, etag: `"frozen-${taken.size.toString(36)}-${body.length.toString(36)}"` });
    } catch {
      failed.push(url);
      continue;
    }
    const node = await env.moduleGraph.getModuleByUrl(url);
    for (const dep of node?.importedModules ?? []) if (!seen.has(dep.url)) queue.push(dep.url);
  }
  // Answer for the frozen modules in FRONT of the server's own handling. A request for a style sheet, a page
  // or an image under the same address is not a module request and is passed on.
  const stack = (server.middlewares as unknown as { stack: { route: string; handle: (req: IncomingMessage, res: ServerResponse, next: () => void) => void }[] }).stack;
  stack.unshift({
    route: '',
    handle: (req, res, next) => {
      const dest = req.headers['sec-fetch-dest'];
      if ((req.method !== 'GET' && req.method !== 'HEAD') || !req.url || dest === 'style' || dest === 'document' || dest === 'image' || dest === 'font') return next();
      const hit = taken.get(req.url) ?? taken.get(withoutServerQueries(req.url));
      if (!hit) return next();
      const headers = { ...ISOLATION_HEADERS, 'Content-Type': 'text/javascript', 'Cache-Control': 'no-cache', ETag: hit.etag };
      if (req.headers['if-none-match'] === hit.etag) {
        res.writeHead(304, headers);
        res.end();
        return;
      }
      res.writeHead(200, { ...headers, 'Content-Length': String(hit.body.length) });
      res.end(req.method === 'HEAD' ? undefined : hit.body);
    },
  });
  return { modules: taken.size, pages: pages.length, failed };
}

/** A module address without the queries the server adds for its own book-keeping (`t=<time>` after an update, `import`). */
function withoutServerQueries(url: string): string {
  const q = url.indexOf('?');
  if (q < 0) return url;
  const kept = url
    .slice(q + 1)
    .split('&')
    .filter((p) => p !== 'import' && !/^t=\d+$/.test(p));
  return kept.length > 0 ? `${url.slice(0, q)}?${kept.join('&')}` : url.slice(0, q);
}

/**
 * What changed in the working tree while the run was under way: every tracked or untracked (not ignored)
 * file saved since the run started, and the commits made meanwhile. Printed at the end of the run. The
 * pages were served the modules and definitions of the start; a spec file, an HTML file or a data file
 * among these may have been read in its changed form.
 */
function reportChanges(startedMs: number, headAtStart: string): void {
  const changed: string[] = [];
  for (const f of git(['ls-files', '-co', '--exclude-standard']).split('\n')) {
    if (f === '') continue;
    try {
      if (fs.statSync(path.join(repoRoot, f)).mtimeMs > startedMs) changed.push(f);
    } catch {
      // Deleted meanwhile: named by the commit list or not at all.
    }
  }
  const headNow = git(['rev-parse', 'HEAD']);
  const commits = headAtStart !== '' && headNow !== headAtStart ? git(['log', '--oneline', `${headAtStart}..${headNow}`]).split('\n').filter((l) => l !== '') : [];
  if (changed.length === 0 && commits.length === 0) {
    console.log('[harness] the working tree did not change during this run');
    return;
  }
  const served = changed.filter((f) => /^(src|labs|data\/defs)\//.test(f) || f === 'index.html');
  console.log(
    `[harness] THE WORKING TREE CHANGED DURING THIS RUN: ${changed.length} file(s) saved, ${commits.length} commit(s) made (HEAD ${headAtStart.slice(0, 7)} -> ${headNow.slice(0, 7)}). ` +
      `The pages were served the modules and the definitions of the run's start; spec, HTML and data files are read as they are. A failure of this run may be discounted only after a look at this list.`,
  );
  if (served.length > 0) console.log(`[harness]   in what pages load (${served.length}): ${served.slice(0, 30).join(', ')}${served.length > 30 ? ', ...' : ''}`);
  const other = changed.filter((f) => !served.includes(f));
  if (other.length > 0) console.log(`[harness]   elsewhere (${other.length}): ${other.slice(0, 20).join(', ')}${other.length > 20 ? ', ...' : ''}`);
  for (const c of commits.slice(0, 12)) console.log(`[harness]   commit ${c.slice(0, 110)}`);
}
