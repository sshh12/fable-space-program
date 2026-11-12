#!/usr/bin/env node
/**
 * Writes build-info.json beside the server bundle inside the image (ARCHITECTURE 16.2):
 *   buildId = first 16 hex of SHA-256("<Node image digest>\n<bundle hash>")
 * The same function is deploy/buildInfo.ts `computeBuildId`; CI runs the same Dockerfile and records the id.
 *
 *   node deploy/build/stamp.mjs --bundle=/app/server/main.mjs --node-digest=sha256:... [--commit=<sha>]
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const opts = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split(/=(.*)/s).slice(0, 2)));
if (!opts.bundle || !opts['node-digest']) {
  console.error('usage: stamp.mjs --bundle=<main.mjs> --node-digest=<sha256:...> [--commit=<sha>]');
  process.exit(2);
}
if (!/^sha256:[0-9a-f]{64}$/.test(opts['node-digest'])) {
  console.error(`stamp: --node-digest must be sha256:<64 hex>, got ${opts['node-digest']}`);
  process.exit(2);
}
const bundleHash = createHash('sha256').update(fs.readFileSync(opts.bundle)).digest('hex').slice(0, 16);
const buildId = createHash('sha256').update(`${opts['node-digest']}\n${bundleHash}`).digest('hex').slice(0, 16);
const info = { buildId, nodeImageDigest: opts['node-digest'], bundleHash, commit: opts.commit || null };
fs.writeFileSync(path.join(path.dirname(opts.bundle), 'build-info.json'), `${JSON.stringify(info)}\n`);
console.log(JSON.stringify(info));
