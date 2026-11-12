/**
 * The two buckets (ARCHITECTURE 10.4): `packs` (packs, index objects and the boot pack; its credential is held
 * by game, shell and the upload tool) and `dumps` (database dumps and sampled journals; its credential is held
 * only by the dump role and, as a Modal secret, by fsp-offsite and fsp-audit).
 *
 * Configuration comes from the environment, one prefix per bucket (PACKS_ or DUMPS_):
 *   <P>_BUCKET             bucket name
 *   <P>_ENDPOINT           S3 endpoint URL (Railway's storage endpoint; MinIO or the stand-in locally)
 *   <P>_REGION             signing region
 *   <P>_ACCESS_KEY_ID      credential (secret: never logged)
 *   <P>_SECRET_ACCESS_KEY  credential (secret: never logged)
 *   <P>_PATH_STYLE         1 for path-style addressing (MinIO, the stand-in); default virtual-hosted
 *
 * Object keys in `packs`: `p/<hash>` for every content-addressed object (packs, indexes, boot packs). Nothing
 * in this repository deletes or overwrites a key under `p/`: uploads use If-None-Match: * and skip what exists.
 */
import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

export interface BucketConfig {
  bucket: string;
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  pathStyle: boolean;
}

export type BucketPrefix = 'PACKS' | 'DUMPS';

/** The bucket configured under `prefix`, or null when its variables are absent (the error names the missing ones). */
export function bucketFromEnv(prefix: BucketPrefix, env: Record<string, string | undefined> = process.env): BucketConfig | null {
  const names = ['BUCKET', 'ENDPOINT', 'REGION', 'ACCESS_KEY_ID', 'SECRET_ACCESS_KEY'] as const;
  const got = names.map((n) => env[`${prefix}_${n}`]);
  if (got.every((v) => v === undefined || v === '')) return null;
  const missing = names.filter((_, i) => !got[i]);
  if (missing.length > 0) throw new Error(`bucket ${prefix}: missing ${missing.map((n) => `${prefix}_${n}`).join(', ')}`);
  return {
    bucket: got[0]!,
    endpoint: got[1]!,
    region: got[2]!,
    accessKeyId: got[3]!,
    secretAccessKey: got[4]!,
    pathStyle: env[`${prefix}_PATH_STYLE`] === '1',
  };
}

export function s3For(b: BucketConfig): S3Client {
  return new S3Client({
    endpoint: b.endpoint,
    region: b.region,
    forcePathStyle: b.pathStyle,
    credentials: { accessKeyId: b.accessKeyId, secretAccessKey: b.secretAccessKey },
    // Railway buckets and MinIO accept the classic checksums only when asked; keep requests plain.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
}

export const packKey = (hash: string): string => `p/${hash}`;

/** Start of the UTC day of `ms` (the signing date of every URL of that day). */
export const utcDayStart = (ms: number): Date => {
  const d = new Date(ms);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
};
export const utcDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/** The presigner's longest lifetime: 7 days. */
export const PRESIGN_SECONDS = 7 * 24 * 3600;

/** A GET URL for `key`, signed at the start of the UTC day of `nowMs`, valid 7 days from then. */
export function presignGet(client: S3Client, b: BucketConfig, key: string, nowMs: number): Promise<string> {
  return getSignedUrl(client, new GetObjectCommand({ Bucket: b.bucket, Key: key }), { expiresIn: PRESIGN_SECONDS, signingDate: utcDayStart(nowMs) });
}

/** Size of an object, or null when it does not exist. */
export async function headSize(client: S3Client, b: BucketConfig, key: string): Promise<number | null> {
  try {
    const r = await client.send(new HeadObjectCommand({ Bucket: b.bucket, Key: key }));
    return r.ContentLength ?? null;
  } catch (e) {
    const status = (e as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
    if (status === 404 || (e as { name?: string }).name === 'NotFound') return null;
    throw e;
  }
}

/** Whole object as bytes. */
export async function getBytes(client: S3Client, b: BucketConfig, key: string): Promise<Uint8Array> {
  const r = await client.send(new GetObjectCommand({ Bucket: b.bucket, Key: key }));
  if (!r.Body) throw new Error(`bucket ${b.bucket}: ${key} has no body`);
  return r.Body.transformToByteArray();
}

/**
 * Put an object that must not exist yet (content-addressed: an existing key already holds these bytes).
 * Returns false when it existed. Never overwrites.
 */
export async function putIfAbsent(client: S3Client, b: BucketConfig, key: string, body: Uint8Array | NodeJS.ReadableStream, bytes: number): Promise<boolean> {
  const existing = await headSize(client, b, key);
  if (existing !== null) {
    if (existing !== bytes) throw new Error(`bucket ${b.bucket}: ${key} exists with ${existing} bytes, not ${bytes}: a content address cannot hold other bytes`);
    return false;
  }
  await client.send(new PutObjectCommand({ Bucket: b.bucket, Key: key, Body: body as Uint8Array, ContentLength: bytes, ContentType: 'application/octet-stream', IfNoneMatch: '*' }));
  return true;
}
