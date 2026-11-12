#!/usr/bin/env node
/**
 * Proof of the dump role's retention on the real `dumps` bucket (platform-delivery acceptance: "the dump job
 * has written and pruned dumps"): writes N small objects named like dumps of the past (hourly, back over
 * `days` days, marker `retentionprobe`), so the next hourly run of the dump role must delete every one that
 * falls outside 24 hourly, 14 daily and 8 weekly copies. The credential is read from stdin (the Railway CLI's
 * JSON) and kept in memory only: the dumps credential is never stored on this machine.
 *
 *   railway bucket credentials --bucket dumps --json | node deploy/railway/retention-probe.mjs 60
 */
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

const days = Number(process.argv[2] ?? 60);
let input = '';
for await (const chunk of process.stdin) input += chunk;
const c = JSON.parse(input);
const s3 = new S3Client({
  endpoint: c.endpoint,
  region: c.region,
  forcePathStyle: c.urlStyle === 'path',
  credentials: { accessKeyId: c.accessKeyId, secretAccessKey: c.secretAccessKey },
  requestChecksumCalculation: 'WHEN_REQUIRED',
});
const now = Date.now();
const keys = [];
// One object every 6 hours over the window, starting 2 hours back (so the newest real dump stays newest).
for (let t = now - 2 * 3600_000; t > now - days * 86_400_000; t -= 6 * 3600_000) {
  const iso = new Date(t).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  keys.push(`dumps/${iso}-retentionprobe.dump`);
}
for (const k of keys) await s3.send(new PutObjectCommand({ Bucket: c.bucketName, Key: k, Body: 'retention probe: not a dump', ContentType: 'text/plain' }));
console.log(JSON.stringify({ written: keys.length, oldest: keys[keys.length - 1], newest: keys[0] }));
