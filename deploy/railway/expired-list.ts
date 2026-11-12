/**
 * Pack lists for the deployed failover measurement (tests/browser/platform/deployed.spec.ts), from the deployed
 * game's /packs.json: out/platform/expired-list.json (every bucket URL signed eight days ago: 403 at the
 * bucket, and again after a refresh) and out/platform/missing-list.json (valid signatures for keys that do not
 * exist: 404). Uses the packs credential of the git-ignored .env; the files stay in out/.
 *
 *   npx tsx deploy/railway/expired-list.ts https://game-production-dfc41bff.up.railway.app
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { bucketFromEnv, PRESIGN_SECONDS, presignGet, s3For } from '../packs/bucket';
import type { PackList } from '../../src/terrain/packIndex';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const pub = JSON.parse(fs.readFileSync(path.join(REPO, 'deploy', 'railway', 'buckets.json'), 'utf8')).packs as { bucket: string; endpoint: string; region: string; pathStyle: boolean };
process.env.PACKS_BUCKET = pub.bucket;
process.env.PACKS_ENDPOINT = pub.endpoint;
process.env.PACKS_REGION = pub.region;
process.env.PACKS_PATH_STYLE = pub.pathStyle ? '1' : '0';
for (const l of fs.readFileSync(path.join(REPO, '.env'), 'utf8').split(/\r?\n/)) {
  const m = /^(PACKS_[A-Z_]+)=(.*)$/.exec(l);
  if (m) process.env[m[1]!] = m[2]!;
}
const b = bucketFromEnv('PACKS')!;
const client = s3For(b);
const game = process.argv[2];
if (!game) throw new Error('usage: expired-list.ts <game url>');
const list = (await (await fetch(`${game}/packs.json`)).json()) as PackList;
const bucket = list.mirrors.find((m) => m.id === 'bucket')!;
const eightDaysAgo = Date.now() - 8 * 86400_000;
const expired: Record<string, string> = {};
const missing: Record<string, string> = {};
for (const h of Object.keys(bucket.objects!)) {
  expired[h] = await presignGet(client, b, `p/${h}`, eightDaysAgo);
  missing[h] = await getSignedUrl(client, new GetObjectCommand({ Bucket: b.bucket, Key: `p/${h}-missing` }), { expiresIn: PRESIGN_SECONDS });
}
fs.mkdirSync(path.join(REPO, 'out', 'platform'), { recursive: true });
const write = (name: string, objects: Record<string, string>): void => fs.writeFileSync(path.join(REPO, 'out', 'platform', name), JSON.stringify({ ...list, mirrors: list.mirrors.map((m) => (m.id === 'bucket' ? { ...m, objects } : m)) }));
write('expired-list.json', expired);
write('missing-list.json', missing);
console.log(`expired-list.json and missing-list.json: ${Object.keys(expired).length} bucket URLs each`);
