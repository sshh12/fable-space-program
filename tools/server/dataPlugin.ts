/**
 * Vite plugin: serves the data directories next to the app in dev and preview, and ships definitions
 * with the production build.
 *
 *   /tiles/**          <- data/tiles/**   baked tile pyramids  ({tileset}/{layer}/{face}/{level}/{x}/{y}.{ext})
 *   /tiles/index.json  generated listing { tilesets: string[] } of the tile sets that are baked (the
 *                      directories under data/tiles that contain a manifest.json), so a page can skip a
 *                      missing tile set without a 404 (which Chrome logs as a console error)
 *   /sky/**            <- data/sky/**     baked star maps / catalogs
 *   /defs/**           <- data/defs/**    JSON definitions
 *   /defs/index.json   generated listing { files: string[] } of every JSON file under data/defs
 *
 * Responses carry COOP/COEP/CORP headers so the page is cross-origin isolated (SharedArrayBuffer,
 * 5 microsecond timers). Tiles are large and never copied into dist: `vite preview` serves them from
 * data/ through the same middleware; only the listing tiles/index.json (as of build time) is emitted. A
 * request with a `?v=` query is treated as content-addressed (immutable); anything else revalidates with
 * an ETag.
 */
import fs from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import type { Plugin } from 'vite';

const MIME: Record<string, string> = {
  '.json': 'application/json; charset=utf-8',
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ktx2': 'image/ktx2',
  '.hgt': 'application/octet-stream',
  '.u8': 'application/octet-stream',
  '.bin': 'application/octet-stream',
  '.dds': 'application/octet-stream',
  '.txt': 'text/plain; charset=utf-8',
};

export const ISOLATION_HEADERS: Record<string, string> = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

function listJson(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, rel: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(dir, e.name), r);
      else if (e.name.endsWith('.json')) out.push(r);
    }
  };
  walk(root, '');
  return out.sort();
}

/** Ids of the baked tile sets: sub-directories of `tilesRoot` that hold a manifest.json, sorted. */
export function listTilesets(tilesRoot: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(tilesRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory() && fs.existsSync(path.join(tilesRoot, e.name, 'manifest.json')))
    .map((e) => e.name)
    .sort();
}

/**
 * The definition files as they are NOW: the listing and every file's bytes. A server started with
 * FSP_FREEZE_DEFS=1 (the browser tests' server: tests/browser/globalSetup.ts) serves /defs from this copy
 * for as long as it lives, so that every page of a run loads the same library whatever another agent
 * saves under data/defs meanwhile. (Tiles and sky data are not copied: they are large, and a bake that
 * rewrites them while a run reads them is a thing to avoid, not to hide.)
 */
export function snapshotDefs(defsRoot: string): { listing: string; files: Map<string, Buffer> } {
  const files = new Map<string, Buffer>();
  const names = listJson(defsRoot);
  for (const f of names) files.set(f, fs.readFileSync(path.join(defsRoot, f)));
  return { listing: JSON.stringify({ files: names }), files };
}

export function fableDataPlugin(repoRoot: string, options: { freezeDefs?: boolean } = {}): Plugin {
  const mounts: { prefix: string; dir: string }[] = [
    { prefix: '/tiles/', dir: path.join(repoRoot, 'data', 'tiles') },
    { prefix: '/sky/', dir: path.join(repoRoot, 'data', 'sky') },
    { prefix: '/defs/', dir: path.join(repoRoot, 'data', 'defs') },
  ];
  const defsRoot = path.join(repoRoot, 'data', 'defs');
  const tilesRoot = path.join(repoRoot, 'data', 'tiles');
  const frozen = (options.freezeDefs ?? process.env.FSP_FREEZE_DEFS === '1') ? snapshotDefs(defsRoot) : null;

  const handler = (req: IncomingMessage, res: ServerResponse, next: () => void): void => {
    const rawUrl = req.url ?? '/';
    const q = rawUrl.indexOf('?');
    const pathname = decodeURIComponent(q >= 0 ? rawUrl.slice(0, q) : rawUrl);
    const versioned = q >= 0 && /(^|&)v=/.test(rawUrl.slice(q + 1));
    const mount = mounts.find((m) => pathname.startsWith(m.prefix));
    if (!mount) {
      next();
      return;
    }
    const send = (status: number, headers: Record<string, string>, body?: Buffer | string): void => {
      res.writeHead(status, { ...ISOLATION_HEADERS, ...headers });
      res.end(body);
    };
    if (frozen && mount.prefix === '/defs/') {
      // The library as it was when this server started (see snapshotDefs).
      if (pathname === '/defs/index.json') {
        send(200, { 'Content-Type': MIME['.json']!, 'Cache-Control': 'no-cache' }, frozen.listing);
        return;
      }
      const body = frozen.files.get(pathname.slice(mount.prefix.length));
      if (!body) send(404, { 'Cache-Control': 'no-store' }, 'not found');
      else send(200, { 'Content-Type': MIME['.json']!, 'Content-Length': String(body.length), 'Cache-Control': 'no-cache' }, req.method === 'HEAD' ? undefined : body);
      return;
    }
    if (pathname === '/defs/index.json') {
      send(200, { 'Content-Type': MIME['.json']!, 'Cache-Control': 'no-cache' }, JSON.stringify({ files: listJson(defsRoot) }));
      return;
    }
    if (pathname === '/tiles/index.json') {
      send(200, { 'Content-Type': MIME['.json']!, 'Cache-Control': 'no-cache' }, JSON.stringify({ tilesets: listTilesets(tilesRoot) }));
      return;
    }
    const file = path.normalize(path.join(mount.dir, pathname.slice(mount.prefix.length)));
    if (!file.startsWith(mount.dir + path.sep)) {
      send(403, {}, 'forbidden');
      return;
    }
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) {
        send(404, { 'Cache-Control': 'no-store' }, 'not found');
        return;
      }
      const etag = `"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
      const headers: Record<string, string> = {
        'Content-Type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
        'Content-Length': String(st.size),
        ETag: etag,
        'Cache-Control': versioned ? 'public, max-age=31536000, immutable' : 'no-cache',
      };
      if (req.headers['if-none-match'] === etag) {
        delete headers['Content-Length'];
        send(304, headers);
        return;
      }
      if (req.method === 'HEAD') {
        send(200, headers);
        return;
      }
      res.writeHead(200, { ...ISOLATION_HEADERS, ...headers });
      fs.createReadStream(file).pipe(res);
    });
  };

  return {
    name: 'fable-data',
    configureServer(server) {
      server.middlewares.use(handler);
    },
    configurePreviewServer(server) {
      server.middlewares.use(handler);
    },
    generateBundle() {
      const files = listJson(defsRoot);
      for (const f of files) {
        this.emitFile({ type: 'asset', fileName: `defs/${f}`, source: fs.readFileSync(path.join(defsRoot, f)) });
      }
      this.emitFile({ type: 'asset', fileName: 'defs/index.json', source: JSON.stringify({ files }) });
      this.emitFile({ type: 'asset', fileName: 'tiles/index.json', source: JSON.stringify({ tilesets: listTilesets(tilesRoot) }) });
    },
  };
}
