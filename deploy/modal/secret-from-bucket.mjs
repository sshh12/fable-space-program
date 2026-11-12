#!/usr/bin/env node
/**
 * Creates (or replaces) a Modal secret in environment `fsp` from a Railway bucket credential read on stdin,
 * printing nothing secret (ARCHITECTURE 16.2, "Secrets": the dumps credential exists outside Railway only as
 * the Modal secret `fsp-dumps`, for fsp-offsite and fsp-audit). The values pass through a temporary file in
 * the OS temp directory that is removed at once; never through a command line.
 *
 *   railway bucket credentials --bucket dumps --json | node deploy/modal/secret-from-bucket.mjs fsp-dumps DUMPS
 */
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const [name, prefix] = process.argv.slice(2);
if (!name || !/^[A-Z]+$/.test(prefix ?? '')) {
  console.error('usage: ... | node deploy/modal/secret-from-bucket.mjs <secret name> <PREFIX>');
  process.exit(2);
}
let input = '';
for await (const chunk of process.stdin) input += chunk;
const c = JSON.parse(input);
const values = {
  [`${prefix}_BUCKET`]: c.bucketName,
  [`${prefix}_ENDPOINT`]: c.endpoint,
  [`${prefix}_REGION`]: c.region,
  [`${prefix}_ACCESS_KEY_ID`]: c.accessKeyId,
  [`${prefix}_SECRET_ACCESS_KEY`]: c.secretAccessKey,
  [`${prefix}_PATH_STYLE`]: c.urlStyle === 'path' ? '1' : '0',
};
const tmp = path.join(os.tmpdir(), `fsp-secret-${randomBytes(8).toString('hex')}.json`);
fs.writeFileSync(tmp, JSON.stringify(values), { mode: 0o600 });
try {
  const r = spawnSync('modal', ['secret', 'create', '--env', 'fsp', '--force', '--from-json', tmp, name], { encoding: 'utf8', shell: process.platform === 'win32' });
  if (r.status !== 0) throw new Error(`modal secret create failed (exit ${r.status})`);
  console.log(`secret-from-bucket: Modal secret ${name} (environment fsp) holds ${Object.keys(values).join(', ')}`);
} finally {
  fs.rmSync(tmp, { force: true });
}
