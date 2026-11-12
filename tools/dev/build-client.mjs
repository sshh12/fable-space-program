#!/usr/bin/env node
/**
 * The production client build, written OUTSIDE the shared dist/ (lead-owned).
 *
 *   npm run stack:client      node tools/dev/heavy.mjs --class=cpu -- node tools/dev/build-client.mjs --target=stack
 *       The page the local stack serves with --page=build (ARCHITECTURE 16.4). Written to
 *       data/stack/client/<source hash>/; a no-op when that directory is already complete, so running it
 *       twice builds once. It is the only client build a work package may run.
 *   npm run build:ci          (CI only) typecheck, then node tools/dev/build-client.mjs --target=ci
 *       The same build into out/ci/client/, for the image.
 *
 * Both use vite.config.ts unchanged (one configuration for CI and for the stack); only the output directory
 * differs. Nothing here writes to dist/: `npm run build` stays the lead's own command on a quiet tree.
 *
 * The source hash covers everything the bundle is made from: index.html, src/ (without tests), public/,
 * data/defs/ (the definitions ship with the build), the names of the baked tile sets (the build emits their
 * listing), the Vite and TypeScript configuration, the plugins it loads and the lockfile.
 *
 * Prints one line of JSON on success: { target, dir, hash, built, seconds, files, bytes }.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const COMPLETE = '.build-complete.json';

function fail(msg) {
  console.error(`build-client: ${msg}`);
  process.exit(2);
}

const opts = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = /^--([a-z-]+)(?:=(.*))?$/.exec(a);
    if (!m) fail(`bad option ${a} (usage: build-client.mjs --target=stack|ci [--print-hash])`);
    return [m[1], m[2] ?? true];
  }),
);
const target = opts.target;
if (target !== 'stack' && target !== 'ci') fail('--target must be stack or ci');

/** Every file under `dir` (relative to the repo, forward slashes), sorted, skipping names in `skip`. */
function walk(dir, keep) {
  const out = [];
  const abs = path.join(repoRoot, dir);
  if (!fs.existsSync(abs)) return out;
  const stack = [abs];
  while (stack.length > 0) {
    const d = stack.pop();
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile()) {
        const rel = path.relative(repoRoot, p).replace(/\\/g, '/');
        if (keep(rel)) out.push(rel);
      }
    }
  }
  return out.sort();
}

function clientSourceHash() {
  const files = [
    ...['index.html', 'package.json', 'package-lock.json', 'vite.config.ts', 'tsconfig.json'].filter((f) => fs.existsSync(path.join(repoRoot, f))),
    ...walk('src', (f) => !/\.test\.ts$/.test(f)),
    ...walk('public', () => true),
    ...walk('data/defs', (f) => f.endsWith('.json')),
    ...walk('tools/server', (f) => /\.(ts|mjs|js)$/.test(f) && !/\.test\.ts$/.test(f)),
    'tools/dev/stackEndpointsPlugin.ts',
    'tools/dev/build-client.mjs',
  ];
  const h = createHash('sha256');
  for (const f of files) {
    h.update(f);
    h.update('\0');
    h.update(fs.readFileSync(path.join(repoRoot, f)));
    h.update('\0');
  }
  // The build emits tiles/index.json: the names of the baked tile sets.
  const tilesRoot = path.join(repoRoot, 'data', 'tiles');
  const tilesets = fs.existsSync(tilesRoot)
    ? fs
        .readdirSync(tilesRoot, { withFileTypes: true })
        .filter((e) => e.isDirectory() && fs.existsSync(path.join(tilesRoot, e.name, 'manifest.json')))
        .map((e) => e.name)
        .sort()
    : [];
  h.update(`tilesets:${tilesets.join(',')}`);
  return { hash: h.digest('hex').slice(0, 16), fileCount: files.length };
}

function dirStats(dir) {
  let files = 0;
  let bytes = 0;
  const stack = [dir];
  while (stack.length > 0) {
    const d = stack.pop();
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else {
        files++;
        bytes += fs.statSync(p).size;
      }
    }
  }
  return { files, bytes };
}

const { hash, fileCount } = clientSourceHash();
if (opts['print-hash']) {
  console.log(hash);
  process.exit(0);
}

const outDir = target === 'stack' ? path.join(repoRoot, 'data', 'stack', 'client', hash) : path.join(repoRoot, 'out', 'ci', 'client');
const rel = path.relative(repoRoot, outDir).replace(/\\/g, '/');
const marker = path.join(outDir, COMPLETE);

if (target === 'stack' && fs.existsSync(marker)) {
  const done = JSON.parse(fs.readFileSync(marker, 'utf8'));
  console.log(JSON.stringify({ target, dir: rel, hash, built: false, seconds: 0, files: done.files, bytes: done.bytes }));
  process.exit(0);
}

// A half-written directory (an interrupted build) is rebuilt from nothing.
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

const t0 = Date.now();
const { build } = await import('vite');
await build({
  root: repoRoot,
  configFile: path.join(repoRoot, 'vite.config.ts'),
  logLevel: 'warn',
  build: { outDir, emptyOutDir: true },
});
const stats = dirStats(outDir);
const seconds = (Date.now() - t0) / 1000;
fs.writeFileSync(marker, `${JSON.stringify({ hash, sourceFiles: fileCount, ...stats, builtAt: new Date().toISOString() })}\n`);

if (target === 'stack') {
  // Keep the two most recent builds; older source hashes are intermediates (data/ has a size cap).
  const parent = path.dirname(outDir);
  const others = fs
    .readdirSync(parent, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name !== hash)
    .map((e) => ({ name: e.name, t: fs.statSync(path.join(parent, e.name)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  for (const o of others.slice(1)) fs.rmSync(path.join(parent, o.name), { recursive: true, force: true });
}

console.log(JSON.stringify({ target, dir: rel, hash, built: true, seconds: Number(seconds.toFixed(1)), ...stats }));
