#!/usr/bin/env node
/**
 * Creates (or replaces) a Modal secret in environment `fsp` from a Railway bucket credential read on stdin,
 * printing nothing secret (ARCHITECTURE 16.2, "Secrets": the dumps credential exists outside Railway only as
 * the Modal secret `fsp-dumps`, for fsp-offsite and fsp-audit).
 *
 * The values never touch a file or a command line: they go to a Python child on its stdin, which writes the
 * secret with the Modal SDK (delete, then create: the SDK has no replace).
 *
 *   railway bucket credentials --bucket dumps --json | node deploy/modal/secret-from-bucket.mjs fsp-dumps DUMPS
 *
 * As a module: `writeModalSecret(name, prefix, credential)` (deploy/railway/rotate-dumps.mjs).
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PY = `
import json, sys
import modal
d = json.loads(sys.stdin.read())
modal.Secret.objects.delete(d["name"], allow_missing=True, environment_name="fsp")
modal.Secret.objects.create(d["name"], d["values"], environment_name="fsp")
print("ok")
`;

/** The secret's variables from a Railway bucket credential (`railway bucket credentials --json`). */
export function secretValues(prefix, c) {
  return {
    [`${prefix}_BUCKET`]: c.bucketName,
    [`${prefix}_ENDPOINT`]: c.endpoint,
    [`${prefix}_REGION`]: c.region,
    [`${prefix}_ACCESS_KEY_ID`]: c.accessKeyId,
    [`${prefix}_SECRET_ACCESS_KEY`]: c.secretAccessKey,
    [`${prefix}_PATH_STYLE`]: c.urlStyle === 'path' ? '1' : '0',
  };
}

export function writeModalSecret(name, prefix, credential) {
  const values = secretValues(prefix, credential);
  const r = spawnSync('python', ['-I', '-c', PY], { input: JSON.stringify({ name, values }), encoding: 'utf8', windowsHide: true });
  // Neither stream is printed whole: an SDK error could quote its input.
  if (r.status !== 0 || !/\bok\b/.test(r.stdout)) throw new Error(`modal secret ${name}: the Modal SDK failed (exit ${r.status})`);
  return Object.keys(values);
}

const isMain = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const [name, prefix] = process.argv.slice(2);
  if (!name || !/^[A-Z]+$/.test(prefix ?? '')) {
    console.error('usage: ... | node deploy/modal/secret-from-bucket.mjs <secret name> <PREFIX>');
    process.exit(2);
  }
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  const keys = writeModalSecret(name, prefix, JSON.parse(input));
  console.log(`secret-from-bucket: Modal secret ${name} (environment fsp) holds ${keys.join(', ')}`);
}
