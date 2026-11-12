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
 * A build is written to <output>.tmp-<pid> and renamed into place when complete; one builder at a time per
 * output (a lock file with the builder's pid; a second caller waits and then finds the finished build).
 * After a stack build, older builds are removed, except the most recent other one and every build IN USE: a
 * build is in use while a file data/stack/client/<hash>.use-<pid> with a live pid exists, which the stack
 * launcher writes before it serves the build and removes when it stops.
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

const parent = target === 'stack' ? path.join(repoRoot, 'data', 'stack', 'client') : path.join(repoRoot, 'out', 'ci');
const outDir = target === 'stack' ? path.join(parent, hash) : path.join(parent, 'client');
const rel = path.relative(repoRoot, outDir).replace(/\\/g, '/');
const marker = path.join(outDir, COMPLETE);
const lockFile = path.join(parent, `${path.basename(outDir)}.lock`);

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

function reportExisting() {
  const done = JSON.parse(fs.readFileSync(marker, 'utf8'));
  console.log(JSON.stringify({ target, dir: rel, hash, built: false, seconds: 0, files: done.files, bytes: done.bytes }));
}

if (target === 'stack' && fs.existsSync(marker)) {
  reportExisting();
  process.exit(0);
}

// One builder per output directory: an exclusive lock file with the builder's pid. A second caller waits for
// the first and then finds the finished directory; a lock whose builder is dead is taken over.
fs.mkdirSync(parent, { recursive: true });
for (let waited = 0; ; waited += 500) {
  try {
    fs.writeFileSync(lockFile, String(process.pid), { flag: 'wx' });
    break;
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    const holder = Number(fs.readFileSync(lockFile, 'utf8').trim());
    if (!Number.isInteger(holder) || !alive(holder)) {
      fs.rmSync(lockFile, { force: true });
      continue;
    }
    if (waited > 15 * 60_000) fail(`another build of ${rel} (pid ${holder}) has held its lock for 15 minutes`);
    await new Promise((r) => setTimeout(r, 500));
  }
}
const unlock = () => fs.rmSync(lockFile, { force: true });
process.on('exit', unlock);

if (target === 'stack' && fs.existsSync(marker)) {
  // The builder we waited for finished it.
  reportExisting();
  process.exit(0);
}

// Build into a directory of our own and rename it into place when it is complete: a reader never sees a
// half-written build, and an interrupted one leaves only a .tmp-<pid> directory that the next run removes.
const tmpDir = `${outDir}.tmp-${process.pid}`;
fs.rmSync(tmpDir, { recursive: true, force: true });
fs.mkdirSync(tmpDir, { recursive: true });

const t0 = Date.now();
const { build } = await import('vite');
await build({
  root: repoRoot,
  configFile: path.join(repoRoot, 'vite.config.ts'),
  logLevel: 'warn',
  // Source maps carry the private repository's sources: the stack's build keeps them (local only), the CI and
  // image build has none and no sourceMappingURL comment (lead decision, platform-delivery fix round item 1).
  build: { outDir: tmpDir, emptyOutDir: true, sourcemap: target === 'stack' },
});
const stats = dirStats(tmpDir);
const seconds = (Date.now() - t0) / 1000;
fs.writeFileSync(path.join(tmpDir, COMPLETE), `${JSON.stringify({ hash, sourceFiles: fileCount, ...stats, builtAt: new Date().toISOString() })}\n`);
// An incomplete directory under the final name (a build interrupted before this scheme) gives way.
fs.rmSync(outDir, { recursive: true, force: true });
fs.renameSync(tmpDir, outDir);

if (target === 'stack') {
  // Housekeeping (data/ has a size cap). A build is IN USE while a file <hash>.use-<pid> with a live pid lies
  // beside it: the stack launcher writes one before it serves a build and removes it when it stops. Kept:
  // this build, every build in use, and the most recent other one. Removed: older builds, the .tmp-<pid>
  // directories and the use files of processes that are gone.
  const entries = fs.readdirSync(parent, { withFileTypes: true });
  const inUse = new Set();
  for (const e of entries) {
    const m = /^([0-9a-f]{16})\.use-(\d+)$/.exec(e.name);
    if (!m) continue;
    if (alive(Number(m[2]))) inUse.add(m[1]);
    else fs.rmSync(path.join(parent, e.name), { force: true });
  }
  for (const e of entries) {
    const m = /^[0-9a-f]{16}\.tmp-(\d+)$/.exec(e.name);
    if (m && e.isDirectory() && !alive(Number(m[1]))) fs.rmSync(path.join(parent, e.name), { recursive: true, force: true });
  }
  const others = entries
    .filter((e) => e.isDirectory() && /^[0-9a-f]{16}$/.test(e.name) && e.name !== hash && !inUse.has(e.name))
    .map((e) => ({ name: e.name, t: fs.statSync(path.join(parent, e.name)).mtimeMs }))
    .sort((x, y) => y.t - x.t);
  for (const o of others.slice(1)) fs.rmSync(path.join(parent, o.name), { recursive: true, force: true });
}

console.log(JSON.stringify({ target, dir: rel, hash, built: true, seconds: Number(seconds.toFixed(1)), ...stats }));
