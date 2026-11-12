/**
 * The `packs` mirror role (ARCHITECTURE 10.4, 16.1): a streaming proxy of the packs bucket with immutable
 * cache headers, for Railway's CDN to cache. Up to stage 2 it runs INSIDE the `shell` service (the shell
 * role adds this handler to its router); from stage 3 it is its own service (ROLES=packs).
 *
 *   GET|HEAD /p/<hash>/<S>/<n>   slice n of S bytes (S a power of two from 64 KiB to 4 MiB; the last slice of an
 *                                object is shorter). The slice size is in the URL, so the pack list (which states
 *                                it) is its one source of truth and a mismatch cannot exist. The mode in use:
 *                                Railway's CDN caches whole responses, never ranged ones (measured).
 *   GET /p/<hash>                with a closed `Range` of at most MIRROR_MAX_RANGE_BYTES (8 MiB): the ranges
 *                                mode, served only when MIRROR_MODE=ranges; otherwise 404. An open-ended, a
 *                                missing or an oversized range is refused (416): no request streams a whole pack.
 *
 * Bounds (16.2), all hard: a request with a query string gets 404 with no body (the CDN keys on it); every
 * response's length is reserved at admission against the mirror's daily budget (8 GB: then 429 until 00:00
 * UTC) and the client address's window (300 MB in 10 minutes), and given back if the stream ends early; at most
 * MIRROR_MAX_STREAMS responses stream at once, MIRROR_MAX_STREAMS_PER_ADDRESS per address (then 429). No disk
 * cache: the body is streamed from the bucket to the client.
 */
import { GetObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import type http from 'node:http';
import type { Readable } from 'node:stream';
import { bucketFromEnv, packKey, s3For, type BucketConfig } from '../packs/bucket';
import type { EgressMeter } from './egress';
import { clientAddress, empty, IMMUTABLE, SHARED_BYTES, splitUrl } from './http';
import type { Logger } from './log';
import type { RoleContext, RoleHandle, RoleModule, RouteHandler } from './types';

export const MIRROR_ROUTE = 'mirror';
export const MIN_SLICE_BYTES = 64 * 1024;
export const MAX_SLICE_BYTES = 4 * 1024 * 1024;
const SLICE_PATH = /^\/p\/([0-9a-f]{32})\/(\d{5,8})\/(\d{1,7})$/;
const RANGE_PATH = /^\/p\/([0-9a-f]{32})$/;

export interface MirrorOptions {
  client: S3Client;
  bucket: BucketConfig;
  /** `slices` (the default) or `ranges`. */
  mode: 'slices' | 'ranges';
  maxRangeBytes: number;
  egress: EgressMeter;
  log: Logger;
}

const statusOf = (e: unknown): number | undefined => (e as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
const isPow2 = (n: number): boolean => n > 0 && (n & (n - 1)) === 0;

/** A closed single range `bytes=a-b` of at most `max` bytes, or null. */
export function closedRange(h: string | undefined, max: number): { start: number; end: number } | null {
  const m = /^bytes=(\d+)-(\d+)$/.exec((h ?? '').trim());
  if (!m) return null;
  const start = Number(m[1]);
  const end = Number(m[2]) + 1;
  return end > start && end - start <= max ? { start, end } : null;
}

export function createMirrorHandler(o: MirrorOptions): RouteHandler {
  return async (req, res) => {
    const { path, query } = splitUrl(req);
    if (!path.startsWith('/p/')) return false;
    if (req.method === 'OPTIONS') return empty(res, 204, SHARED_BYTES);
    if (req.method !== 'GET' && req.method !== 'HEAD') return empty(res, 405, SHARED_BYTES);
    if (query !== null) return empty(res, 404, SHARED_BYTES);
    let hash: string;
    let start: number;
    let end: number;
    let slice = false;
    const sm = SLICE_PATH.exec(path);
    if (sm) {
      const S = Number(sm[2]);
      if (!isPow2(S) || S < MIN_SLICE_BYTES || S > MAX_SLICE_BYTES) return empty(res, 404, SHARED_BYTES);
      hash = sm[1]!;
      start = Number(sm[3]) * S;
      end = start + S;
      slice = true;
    } else {
      const rm = RANGE_PATH.exec(path);
      if (!rm || o.mode !== 'ranges') return empty(res, 404, SHARED_BYTES);
      const r = closedRange(typeof req.headers.range === 'string' ? req.headers.range : undefined, o.maxRangeBytes);
      if (!r) return empty(res, 416, SHARED_BYTES);
      hash = rm[1]!;
      ({ start, end } = r);
    }
    const headers: Record<string, string> = { ...SHARED_BYTES, 'Content-Type': 'application/octet-stream', 'Accept-Ranges': 'bytes', 'Cache-Control': IMMUTABLE };
    const addr = clientAddress(req);
    // HEAD sends no body: nothing to reserve. A GET reserves its whole length (a slice: S, the last one of an
    // object is shorter and gives the rest back) before the bucket is asked.
    const admission = req.method === 'HEAD' ? null : o.egress.admit(MIRROR_ROUTE, end - start, addr);
    if (req.method !== 'HEAD' && !admission) {
      const why = o.egress.lastRefusal;
      return empty(res, 429, { ...SHARED_BYTES, 'Retry-After': String(why === 'budget' ? o.egress.secondsToReset() : why === 'address' ? 600 : 5) });
    }
    let sent = 0;
    const settle = (): void => admission?.settle(sent);
    try {
      const r = await o.client.send(new GetObjectCommand({ Bucket: o.bucket.bucket, Key: packKey(hash), Range: `bytes=${start}-${end - 1}` }));
      const length = r.ContentLength ?? 0;
      headers['Content-Length'] = String(length);
      // A slice is a whole object of its own to the CDN and to the client: 200, no Content-Range.
      if (!slice && r.ContentRange) headers['Content-Range'] = r.ContentRange;
      res.writeHead(slice ? 200 : 206, headers);
      const body = r.Body as Readable;
      if (req.method === 'HEAD') {
        body.destroy();
        res.end();
        return true;
      }
      body.on('data', (chunk: Buffer) => (sent += chunk.length));
      // A client that goes away early: stop reading the bucket, give back the unsent rest, free the slot.
      res.on('close', () => {
        if (!body.destroyed) body.destroy();
        settle();
      });
      body.on('error', (e) => {
        o.log.warn('mirror-stream-error', { hash, error: (e as Error).message });
        res.destroy(e as Error);
      });
      body.pipe(res);
      return true;
    } catch (e) {
      settle();
      const s = statusOf(e);
      if (s === 404 || (e as { name?: string }).name === 'NoSuchKey') return empty(res, 404, SHARED_BYTES);
      if (s === 416 || (e as { name?: string }).name === 'InvalidRange') return empty(res, slice ? 404 : 416, SHARED_BYTES);
      o.log.warn('mirror-bucket-error', { hash, status: s ?? null, error: (e as Error).message });
      return empty(res, 502, SHARED_BYTES);
    }
  };
}

/** Mirror settings of a role: the packs bucket, the mode and the largest range. */
export function mirrorOptionsFromEnv(ctx: RoleContext): MirrorOptions {
  const bucket = bucketFromEnv('PACKS', ctx.env);
  if (!bucket) throw new Error('the packs mirror needs the PACKS_* bucket variables');
  const mode = (ctx.env.MIRROR_MODE ?? 'slices') as 'slices' | 'ranges';
  if (mode !== 'slices' && mode !== 'ranges') throw new Error('MIRROR_MODE must be slices or ranges');
  const maxRangeBytes = Number(ctx.env.MIRROR_MAX_RANGE_BYTES ?? 8 * 1024 * 1024);
  return { client: s3For(bucket), bucket, mode, maxRangeBytes, egress: ctx.egress, log: ctx.log };
}

/** ROLES=packs: the mirror as a role of its own (stage 3; the `launch` shape of the local stack). */
const packsRole: RoleModule = {
  kind: 'service',
  async start(ctx): Promise<RoleHandle> {
    const o = mirrorOptionsFromEnv(ctx);
    ctx.http.add(createMirrorHandler(o));
    ctx.log.info('packs-ready', { mode: o.mode });
    return { health: () => ({ ok: true }), drain: async () => undefined };
  },
};
export default packsRole;

export type { http };
