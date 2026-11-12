#!/usr/bin/env node
/**
 * Writes a Railway bucket's S3 credential into the git-ignored .env under a prefix, reading the CLI's JSON
 * from stdin, printing nothing secret (ARCHITECTURE 16.2, "Secrets": the packs credential is kept in the
 * development machine's .env for the upload tool, and nowhere else outside Railway).
 *
 *   railway bucket credentials --bucket packs --json | node deploy/railway/env-from-bucket.mjs PACKS
 *   railway bucket credentials --bucket dumps --json | node deploy/railway/env-from-bucket.mjs DUMPS --public-only
 *       (the dumps credential is never kept on this machine: only its public settings are recorded)
 *
 * Only the two secret values go to .env (<P>_ACCESS_KEY_ID, <P>_SECRET_ACCESS_KEY, replacing earlier lines of
 * that prefix). The rest is not secret and is tracked in deploy/railway/buckets.json (the S3 bucket name,
 * which is not the display name, the endpoint, the region, the addressing style): tools read both.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const prefix = process.argv[2];
if (!/^[A-Z]+$/.test(prefix ?? '')) {
  console.error('usage: ... | node deploy/railway/env-from-bucket.mjs <PREFIX>');
  process.exit(2);
}
let input = '';
for await (const chunk of process.stdin) input += chunk;
const c = JSON.parse(input);
for (const k of ['bucketName', 'endpoint', 'region', 'accessKeyId', 'secretAccessKey', 'urlStyle']) {
  if (typeof c[k] !== 'string' || c[k] === '') {
    console.error(`env-from-bucket: the credential has no ${k}`);
    process.exit(1);
  }
}
const lines = {
  [`${prefix}_ACCESS_KEY_ID`]: c.accessKeyId,
  [`${prefix}_SECRET_ACCESS_KEY`]: c.secretAccessKey,
};
const here = path.dirname(fileURLToPath(import.meta.url));
const pubFile = path.join(here, 'buckets.json');
const pub = fs.existsSync(pubFile) ? JSON.parse(fs.readFileSync(pubFile, 'utf8')) : {};
pub[prefix.toLowerCase()] = { bucket: c.bucketName, endpoint: c.endpoint, region: c.region, pathStyle: c.urlStyle === 'path' };
fs.writeFileSync(pubFile, `${JSON.stringify(pub, null, 1)}
`);
if (process.argv[3] === '--public-only') {
  console.log(`env-from-bucket: ${prefix.toLowerCase()} settings written to deploy/railway/buckets.json; no credential stored`);
  process.exit(0);
}
const envFile = path.join(here, '..', '..', '.env');
const kept = fs.existsSync(envFile) ? fs.readFileSync(envFile, 'utf8').split(/\r?\n/).filter((l) => l !== '' && !l.startsWith(`${prefix}_`)) : [];
fs.writeFileSync(envFile, `${[...kept, ...Object.entries(lines).map(([k, v]) => `${k}=${v}`)].join('\n')}\n`);
console.log(`env-from-bucket: ${Object.keys(lines).join(', ')} written to .env; bucket, endpoint, region and style to deploy/railway/buckets.json`);
