#!/usr/bin/env node
/**
 * The server bundle: deploy/main.ts and every role it can start, with their npm dependencies (pg, the S3
 * client), bundled into ONE ES module for Node 24. The image runs it (`node /app/server/main.mjs`), and so
 * does the local stack (host processes), so both run the same artefact type.
 *
 *   node deploy/build/build-server.mjs --out=<dir>     writes <dir>/main.mjs and prints { out, bundleHash, bytes, built }
 *
 * Deterministic: the same sources and lockfile give the same bytes (no timestamps, no absolute paths in the
 * output), which is what lets CI's buildId equal Railway's. A no-op when <dir>/main.mjs already holds the
 * bundle of the current sources.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const outArg = process.argv.slice(2).find((a) => a.startsWith('--out='));
if (!outArg) {
  console.error('usage: node deploy/build/build-server.mjs --out=<dir>');
  process.exit(2);
}
const outDir = path.resolve(repoRoot, outArg.slice('--out='.length));
fs.mkdirSync(outDir, { recursive: true });

const result = await build({
  absWorkingDir: repoRoot,
  entryPoints: ['deploy/main.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  write: false,
  outfile: path.join(outDir, 'main.mjs'),
  legalComments: 'none',
  sourcemap: false,
  logLevel: 'warning',
  // pg's optional native binding is never used (pure JavaScript client).
  external: ['pg-native', 'cloudflare:sockets'],
  // The bundled CommonJS dependencies call require() for Node built-ins.
  banner: { js: "import { createRequire as __fspCreateRequire } from 'node:module'; const require = __fspCreateRequire(import.meta.url);" },
});
const file = result.outputFiles.find((f) => f.path.endsWith('main.mjs'));
if (!file) throw new Error('build-server: esbuild wrote no main.mjs');
const bytes = file.contents;
const bundleHash = createHash('sha256').update(bytes).digest('hex').slice(0, 16);
const target = path.join(outDir, 'main.mjs');
const same = fs.existsSync(target) && createHash('sha256').update(fs.readFileSync(target)).digest('hex').slice(0, 16) === bundleHash;
if (!same) fs.writeFileSync(target, bytes);
console.log(JSON.stringify({ out: path.relative(repoRoot, target).replace(/\\/g, '/'), bundleHash, bytes: bytes.length, built: !same }));
