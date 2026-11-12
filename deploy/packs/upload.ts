/**
 * Upload of packs, indexes and the boot pack to the packs bucket (S3 API), and the bucket's CORS rule.
 *
 * Resumable at the granularity of one object: every key is content-addressed (`p/<hash>`), an object that
 * exists already is skipped after its size is checked, and nothing is ever overwritten or deleted. After a
 * set is complete, deploy/pack-sets.json (tracked) records it: that file is what the pack-list service of
 * the deployed roles offers. The boot pack is recorded in deploy/boot-manifest.json the same way.
 */
import fs from 'node:fs';
import path from 'node:path';
import { GetBucketCorsCommand, PutBucketCorsCommand, type S3Client } from '@aws-sdk/client-s3';
import { headSize, packKey, putIfAbsent, type BucketConfig } from './bucket';
import type { PackSetEntry, PackSetsDoc } from './packList';

export interface UploadProgress {
  key: string;
  bytes: number;
  uploaded: boolean;
  seconds: number;
}

/** Upload one object file under `p/<hash>`; skipped when it exists with the same size. */
export async function uploadObject(client: S3Client, b: BucketConfig, hash: string, file: string): Promise<UploadProgress> {
  const bytes = fs.statSync(file).size;
  const t0 = performance.now();
  const uploaded = await putIfAbsent(client, b, packKey(hash), fs.createReadStream(file), bytes);
  return { key: packKey(hash), bytes, uploaded, seconds: (performance.now() - t0) / 1000 };
}

/** Upload every object of the named sets (packs first, the index last, so an index never names a missing pack). */
export async function uploadSets(o: {
  client: S3Client;
  bucket: BucketConfig;
  packsDir: string;
  sets: string[];
  setsFile: string;
  log: (line: string) => void;
}): Promise<{ objects: number; uploaded: number; bytes: number; seconds: number }> {
  let objects = 0;
  let uploaded = 0;
  let bytes = 0;
  const t0 = performance.now();
  const doc: PackSetsDoc = fs.existsSync(o.setsFile) ? (JSON.parse(fs.readFileSync(o.setsFile, 'utf8')) as PackSetsDoc) : { v: 1, uploadedAt: '', sets: {} };
  for (const set of o.sets) {
    const cur = JSON.parse(fs.readFileSync(path.join(o.packsDir, set, 'current.json'), 'utf8')) as PackSetEntry & { set: string };
    const list = [...cur.packs.map((p) => ({ hash: p.hash, file: path.join(o.packsDir, set, `${p.hash}.pack`) })), { hash: cur.index, file: path.join(o.packsDir, set, `${cur.index}.idx`) }];
    for (const { hash, file } of list) {
      const r = await uploadObject(o.client, o.bucket, hash, file);
      objects++;
      if (r.uploaded) {
        uploaded++;
        bytes += r.bytes;
      }
      o.log(`${set}: ${r.key} ${(r.bytes / 1e6).toFixed(1)} MB ${r.uploaded ? `uploaded in ${r.seconds.toFixed(1)} s (${((r.bytes * 8) / 1e6 / r.seconds).toFixed(1)} Mbit/s)` : 'present'}`);
    }
    doc.sets[set] = { type: cur.type, index: cur.index, indexBytes: cur.indexBytes, packs: cur.packs, contentHash: cur.contentHash };
    doc.uploadedAt = new Date().toISOString();
    fs.writeFileSync(o.setsFile, `${JSON.stringify(doc, null, 1)}\n`);
  }
  return { objects, uploaded, bytes, seconds: (performance.now() - t0) / 1000 };
}

/** Check that every object a pack-sets document names is in the bucket with its size. */
export async function verifySets(client: S3Client, b: BucketConfig, doc: PackSetsDoc): Promise<{ missing: string[]; checked: number }> {
  const missing: string[] = [];
  let checked = 0;
  for (const s of Object.values(doc.sets)) {
    for (const { hash, bytes } of [...s.packs, { hash: s.index, bytes: s.indexBytes }]) {
      checked++;
      const n = await headSize(client, b, packKey(hash));
      if (n !== bytes) missing.push(`${hash} (${n === null ? 'absent' : `${n} bytes, expected ${bytes}`})`);
    }
  }
  return { missing, checked };
}

/** CORS for ranged GET from a cross-origin-isolated page: any origin, GET and HEAD, the Range header. */
/**
 * Who may read the packs bucket from a page: the deployed shell's origin (the client) and the local stack's
 * page (port 47200: the browser specs against the deployed stage run inside the stack, whose page is their
 * origin). Nothing else: the presigned URLs work from any program, but no other site's page can read the bytes.
 * Railway's bucket (Tigris) takes no wildcard in an origin (measured: http://127.0.0.1:* is not honoured), so
 * the origins are exact. PACKS_CORS_ORIGINS (comma-separated) replaces the list, for a new shell domain.
 */
export const PACKS_CORS_ORIGINS = ['https://shell-production-b6007648.up.railway.app', 'http://127.0.0.1:47200', 'http://localhost:47200'];

export const PACKS_CORS = {
  CORSRules: [
    {
      AllowedOrigins: process.env.PACKS_CORS_ORIGINS ? process.env.PACKS_CORS_ORIGINS.split(',').map((x) => x.trim()) : PACKS_CORS_ORIGINS,
      AllowedMethods: ['GET', 'HEAD'],
      AllowedHeaders: ['Range'],
      ExposeHeaders: ['Content-Range', 'Content-Length', 'ETag'],
      MaxAgeSeconds: 86400,
    },
  ],
};

export async function setPacksCors(client: S3Client, b: BucketConfig): Promise<unknown> {
  await client.send(new PutBucketCorsCommand({ Bucket: b.bucket, CORSConfiguration: PACKS_CORS }));
  const r = await client.send(new GetBucketCorsCommand({ Bucket: b.bucket }));
  return r.CORSRules;
}
