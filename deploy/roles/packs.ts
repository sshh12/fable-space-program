/**
 * The `packs` mirror role (ARCHITECTURE 10.4, 16.1): a streaming proxy of the packs bucket with immutable
 * cache headers, for Railway's CDN to cache. Up to stage 2 it runs INSIDE the `shell` service (the shell
 * role adds this handler to its router); from stage 3 it is its own service (ROLES=packs).
 *
 *   GET|HEAD /p/<hash>        ranges mode: the client's Range is passed to the bucket
 *   GET|HEAD /p/<hash>/<n>    slices mode: fixed aligned slice n of MIRROR_SLICE_BYTES (the last one shorter)
 *
 * Both forms are always served; the pack list says which one clients use. Rules (16.2): a request with a
 * query string gets 404 with no body (the CDN keys on the query string, so cache-busting variants would
 * all be billed misses); origin bytes per client address are limited (300 MB in 10 minutes by default);
 * the mirror's daily byte budget (8 GB) answers 429 when spent, so clients stay on the bucket. No disk
 * cache: the body is streamed from the bucket to the client.
 */
import { GetObjectCommand, HeadObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import type { Readable } from 'node:stream';
import { bucketFromEnv, packKey, s3For, type BucketConfig } from '../packs/bucket';
import type { EgressMeter } from './egress';
import { clientAddress, empty, IMMUTABLE, SHARED_BYTES, splitUrl } from './http';
import type { Logger } from './log';
import type { RoleContext, RoleHandle, RoleModule, RouteHandler } from './types';

export const MIRROR_ROUTE = 'mirror';
const PATH = /^\/p\/([0-9a-f]{32})(?:\/(\d{1,7}))?$/;

export interface MirrorOptions {
  client: S3Client;
  bucket: BucketConfig;
  sliceBytes: number;
  egress: EgressMeter;
  log: Logger;
}

const statusOf = (e: unknown): number | undefined => (e as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;

export function createMirrorHandler(o: MirrorOptions): RouteHandler {
  return async (req, res) => {
    const { path, query } = splitUrl(req);
    const m = PATH.exec(path);
    if (!m) return false;
    if (req.method === 'OPTIONS') return empty(res, 204, SHARED_BYTES);
    if (req.method !== 'GET' && req.method !== 'HEAD') return empty(res, 405, SHARED_BYTES);
    if (query !== null) return empty(res, 404, SHARED_BYTES);
    const addr = clientAddress(req);
    if (!o.egress.open(MIRROR_ROUTE)) {
      o.egress.refuse(MIRROR_ROUTE);
      return empty(res, 429, { ...SHARED_BYTES, 'Retry-After': String(o.egress.secondsToReset()) });
    }
    if (!o.egress.addressOpen(MIRROR_ROUTE, addr)) {
      o.egress.refuse(MIRROR_ROUTE);
      return empty(res, 429, { ...SHARED_BYTES, 'Retry-After': '600' });
    }
    o.egress.request(MIRROR_ROUTE);
    const hash = m[1]!;
    const slice = m[2] === undefined ? null : Number(m[2]);
    let range: string | undefined;
    if (slice !== null) range = `bytes=${slice * o.sliceBytes}-${(slice + 1) * o.sliceBytes - 1}`;
    else if (typeof req.headers.range === 'string') range = req.headers.range;
    try {
      if (req.method === 'HEAD' && slice === null) {
        const h = await o.client.send(new HeadObjectCommand({ Bucket: o.bucket.bucket, Key: packKey(hash) }));
        res.writeHead(200, { ...SHARED_BYTES, 'Content-Type': 'application/octet-stream', 'Content-Length': String(h.ContentLength ?? 0), 'Accept-Ranges': 'bytes', 'Cache-Control': IMMUTABLE });
        res.end();
        return true;
      }
      const r = await o.client.send(new GetObjectCommand({ Bucket: o.bucket.bucket, Key: packKey(hash), Range: range }));
      const headers: Record<string, string> = {
        ...SHARED_BYTES,
        'Content-Type': 'application/octet-stream',
        'Accept-Ranges': 'bytes',
        'Cache-Control': IMMUTABLE,
        'Content-Length': String(r.ContentLength ?? 0),
      };
      if (r.ETag && slice === null) headers.ETag = r.ETag;
      // A slice is a whole object of its own to the CDN and the client: 200, no Content-Range.
      const status = slice === null && r.ContentRange ? 206 : 200;
      if (status === 206) headers['Content-Range'] = r.ContentRange!;
      res.writeHead(status, headers);
      if (req.method === 'HEAD') {
        (r.Body as Readable | undefined)?.destroy();
        res.end();
        return true;
      }
      const body = r.Body as Readable;
      body.on('data', (chunk: Buffer) => o.egress.record(MIRROR_ROUTE, chunk.length, addr));
      body.on('error', (e) => {
        o.log.warn('mirror-stream-error', { hash, error: (e as Error).message });
        res.destroy(e as Error);
      });
      body.pipe(res);
      return true;
    } catch (e) {
      const s = statusOf(e);
      if (s === 404 || (e as { name?: string }).name === 'NoSuchKey') return empty(res, 404, SHARED_BYTES);
      if (s === 416 || (e as { name?: string }).name === 'InvalidRange') return empty(res, slice !== null ? 404 : 416, SHARED_BYTES);
      o.log.warn('mirror-bucket-error', { hash, status: s ?? null, error: (e as Error).message });
      return empty(res, 502, SHARED_BYTES);
    }
  };
}

/** Mirror settings of a role: the packs bucket and the slice size. */
export function mirrorOptionsFromEnv(ctx: RoleContext): MirrorOptions {
  const bucket = bucketFromEnv('PACKS', ctx.env);
  if (!bucket) throw new Error('the packs mirror needs the PACKS_* bucket variables');
  const sliceBytes = Number(ctx.env.MIRROR_SLICE_BYTES ?? 2 * 1024 * 1024);
  if (!(sliceBytes > 0)) throw new Error('MIRROR_SLICE_BYTES must be positive');
  return { client: s3For(bucket), bucket, sliceBytes, egress: ctx.egress, log: ctx.log };
}

/** ROLES=packs: the mirror as a role of its own (stage 3; the `launch` shape of the local stack). */
const packsRole: RoleModule = {
  kind: 'service',
  async start(ctx): Promise<RoleHandle> {
    ctx.http.add(createMirrorHandler(mirrorOptionsFromEnv(ctx)));
    ctx.log.info('packs-ready', { sliceBytes: Number(ctx.env.MIRROR_SLICE_BYTES ?? 2 * 1024 * 1024) });
    return { health: () => ({ ok: true }), drain: async () => undefined };
  },
};
export default packsRole;

