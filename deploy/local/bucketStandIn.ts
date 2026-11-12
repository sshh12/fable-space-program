/**
 * The local stand-in for the packs bucket and for the `packs` mirror (ARCHITECTURE 16.4): a small HTTP server
 * over data/packs, so the pack path, the failover, the boot pack and the shell's load of it are exercised
 * without a bucket.
 *
 *   GET|HEAD /<bucket>/p/<hash>          the bucket. A presigned URL (AWS SigV4, query form) is verified with the
 *                                        stand-in's credential and its expiry honoured (403 when expired or
 *                                        wrong); an S3 client request with an Authorization header naming the
 *                                        stand-in's access key is served as well (the shell's mirror and boot
 *                                        load use the S3 client). Ranged GET (one range) with CORS.
 *   GET|HEAD /m/p/<hash>                 the mirror in `ranges` mode (no signature).
 *   GET|HEAD /m/p/<hash>/<n>             the mirror in `slices` mode: slice n of `sliceBytes`.
 *   OPTIONS  any of the above            CORS preflight.
 *   POST /_ctl/faults                    switches for the failover tests: {"add": [{"target": "bucket"|"mirror",
 *                                        "status": 403|404|429|500|503, "count": n, "hash"?: "<hash>"}]} answers
 *                                        the next n matching requests with that status (bucket faults hit the
 *                                        presigned client requests, not the roles' S3 requests); {"clear": true}.
 *   GET  /_ctl/stats                     requests and bytes per target, faults served.
 *
 * Objects are found by hash in data/packs/<set>/<hash>.pack|.idx and in data/packs/boot/<hash>.pack. CORS:
 * `Access-Control-Allow-Origin: *`, no exposed headers (nothing may depend on Content-Range), and
 * `Cross-Origin-Resource-Policy: cross-origin` on every answer except a 403 of the bucket, which, like Railway's
 * bucket (measured), carries no CORS headers.
 */
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { isContentHash } from '../../src/terrain/packIndex';
import { verifyPresigned } from '../packs/sigv4';

export interface StandInOptions {
  packsDir: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  sliceBytes: number;
  host?: string;
  port?: number;
  now?: () => number;
  log?: (line: string) => void;
}

export interface Fault {
  target: 'bucket' | 'mirror';
  status: number;
  count: number;
  hash?: string;
}

export interface StandInStats {
  requests: Record<string, number>;
  bytes: Record<string, number>;
  refused: Record<string, number>;
  faultsServed: number;
}

export interface StandIn {
  url: string;
  port: number;
  stats(): StandInStats;
  addFaults(f: Fault[]): void;
  clearFaults(): void;
  close(): Promise<void>;
}

const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Allow-Headers': 'Range, Authorization, x-amz-content-sha256, x-amz-date, x-amz-user-agent, amz-sdk-invocation-id, amz-sdk-request, x-amz-checksum-mode',
  'Access-Control-Max-Age': '600',
  'Cross-Origin-Resource-Policy': 'cross-origin',
  Vary: 'Origin',
};

/** Locate an object by hash under the packs directory (any set, or the boot directory). */
export function createObjectFinder(packsDir: string): (hash: string) => string | null {
  const known = new Map<string, string>();
  const scan = (): void => {
    if (!fs.existsSync(packsDir)) return;
    for (const d of fs.readdirSync(packsDir, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      for (const f of fs.readdirSync(path.join(packsDir, d.name))) {
        const m = /^([0-9a-f]{32})\.(pack|idx)$/.exec(f);
        if (m) known.set(m[1]!, path.join(packsDir, d.name, f));
      }
    }
  };
  scan();
  return (hash) => {
    if (!isContentHash(hash)) return null;
    let p = known.get(hash);
    if (!p) {
      scan();
      p = known.get(hash);
    }
    return p ?? null;
  };
}

/** Parse one `bytes=a-b` / `bytes=a-` / `bytes=-n` range against `size`; null = no or unusable header. */
export function parseRange(h: string | undefined, size: number): { start: number; end: number } | 'unsatisfiable' | null {
  if (!h) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(h.trim());
  if (!m) return null;
  let start: number;
  let end: number;
  if (m[1] === '') {
    const n = Number(m[2]);
    if (!(n > 0)) return 'unsatisfiable';
    start = Math.max(0, size - n);
    end = size;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? size : Math.min(size, Number(m[2]) + 1);
  }
  if (start >= size || start >= end) return 'unsatisfiable';
  return { start, end };
}

export function startBucketStandIn(o: StandInOptions): Promise<StandIn> {
  const now = o.now ?? (() => Date.now());
  const log = o.log ?? (() => undefined);
  const find = createObjectFinder(o.packsDir);
  const faults: Fault[] = [];
  const stats: StandInStats = { requests: {}, bytes: {}, refused: {}, faultsServed: 0 };
  const count = (rec: Record<string, number>, k: string, n = 1): void => {
    rec[k] = (rec[k] ?? 0) + n;
  };

  const sendFile = (req: http.IncomingMessage, res: http.ServerResponse, target: string, file: string, slice: { start: number; end: number } | null): void => {
    const size = fs.statSync(file).size;
    let start = 0;
    let end = size;
    let status = 200;
    const headers: Record<string, string> = { ...CORS, 'Content-Type': 'application/octet-stream', 'Accept-Ranges': 'bytes', 'Cache-Control': 'public, max-age=31536000, immutable' };
    if (slice) {
      if (slice.start >= size) {
        res.writeHead(404, { ...CORS, 'Content-Length': '0' }).end();
        return;
      }
      start = slice.start;
      end = Math.min(size, slice.end);
    } else {
      const r = parseRange(req.headers.range, size);
      if (r === 'unsatisfiable') {
        res.writeHead(416, { ...headers, 'Content-Range': `bytes */${size}`, 'Content-Length': '0' }).end();
        return;
      }
      if (r) {
        start = r.start;
        end = r.end;
        status = 206;
        headers['Content-Range'] = `bytes ${start}-${end - 1}/${size}`;
      }
    }
    headers['Content-Length'] = String(end - start);
    res.writeHead(status, headers);
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    count(stats.bytes, target, end - start);
    fs.createReadStream(file, { start, end: end - 1 }).pipe(res);
  };

  const takeFault = (target: 'bucket' | 'mirror', hash: string): number | null => {
    const i = faults.findIndex((f) => f.target === target && (!f.hash || f.hash === hash) && f.count > 0);
    if (i < 0) return null;
    const f = faults[i]!;
    f.count--;
    if (f.count <= 0) faults.splice(i, 1);
    stats.faultsServed++;
    return f.status;
  };

  const server = http.createServer((req, res) => {
    const raw = req.url ?? '/';
    const qi = raw.indexOf('?');
    const rawPath = qi >= 0 ? raw.slice(0, qi) : raw;
    const query = new URLSearchParams(qi >= 0 ? raw.slice(qi + 1) : '');
    if (req.method === 'OPTIONS') {
      res.writeHead(204, CORS).end();
      return;
    }
    if (rawPath === '/_ctl/stats') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...CORS }).end(JSON.stringify(stats));
      return;
    }
    if (rawPath === '/_ctl/faults' && req.method === 'POST') {
      let body = '';
      req.on('data', (c: Buffer) => (body += c.toString('utf8')));
      req.on('end', () => {
        try {
          const j = JSON.parse(body || '{}') as { add?: Fault[]; clear?: boolean };
          if (j.clear) faults.length = 0;
          for (const f of j.add ?? []) faults.push({ ...f });
          res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ faults }));
        } catch (e) {
          res.writeHead(400).end((e as Error).message);
        }
      });
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, CORS).end();
      return;
    }
    const bucketPrefix = `/${o.bucket}/p/`;
    if (rawPath.startsWith(bucketPrefix)) {
      count(stats.requests, 'bucket');
      const hash = rawPath.slice(bucketPrefix.length);
      const auth = req.headers.authorization;
      if (auth) {
        // The S3 client's header-signed request (shell, upload tool): the credential must be ours.
        if (!auth.includes(`Credential=${o.accessKeyId}/`)) {
          count(stats.refused, 'credential');
          res.writeHead(403, { ...CORS, 'Content-Length': '0' }).end();
          return;
        }
      } else {
        const check = verifyPresigned(req.method!, rawPath, query, req.headers, o, now());
        if (!check.ok) {
          count(stats.refused, check.reason ?? 'refused');
          log(`stand-in: 403 ${check.reason} ${hash}`);
          // Like Railway's bucket: the 403 of a refused signature carries no CORS headers (a page sees a
          // network error, not the status).
          res.writeHead(403, { 'Content-Length': '0' }).end();
          return;
        }
      }
      // Faults stand for the bucket failing the CLIENTS' presigned path (a CORS break, an incident, a rate
      // limit): the S3 requests of the roles (the shell's mirror, the boot load) still go through, which is the
      // case the mirror exists for.
      const fault = auth ? null : takeFault('bucket', hash);
      if (fault !== null) {
        // A planted 403 behaves like the bucket's own (no CORS headers); the other statuses carry them.
        res.writeHead(fault, { ...(fault === 403 ? {} : CORS), 'Content-Length': '0' }).end();
        return;
      }
      const file = find(hash);
      if (!file) {
        res.writeHead(404, { ...CORS, 'Content-Length': '0' }).end();
        return;
      }
      sendFile(req, res, 'bucket', file, null);
      return;
    }
    const mm = /^\/m\/p\/([0-9a-f]{32})(?:\/(\d+))?$/.exec(rawPath);
    if (mm) {
      count(stats.requests, mm[2] === undefined ? 'mirror-range' : 'mirror-slice');
      const hash = mm[1]!;
      if (qi >= 0) {
        res.writeHead(404, { ...CORS, 'Content-Length': '0' }).end();
        return;
      }
      const fault = takeFault('mirror', hash);
      if (fault !== null) {
        res.writeHead(fault, { ...CORS, 'Content-Length': '0' }).end();
        return;
      }
      const file = find(hash);
      if (!file) {
        res.writeHead(404, { ...CORS, 'Content-Length': '0' }).end();
        return;
      }
      const n = mm[2] === undefined ? null : Number(mm[2]);
      sendFile(req, res, 'mirror', file, n === null ? null : { start: n * o.sliceBytes, end: (n + 1) * o.sliceBytes });
      return;
    }
    res.writeHead(404, { ...CORS, 'Content-Length': '0' }).end();
  });
  server.keepAliveTimeout = 5000;

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(o.port ?? 0, o.host ?? '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      const url = `http://${o.host ?? '127.0.0.1'}:${port}`;
      log(`stand-in: bucket ${url}/${o.bucket}/p/, mirror ${url}/m/p/ (slices of ${o.sliceBytes})`);
      resolve({
        url,
        port,
        stats: () => structuredClone(stats),
        addFaults: (f) => faults.push(...f.map((x) => ({ ...x }))),
        clearFaults: () => {
          faults.length = 0;
        },
        close: () =>
          new Promise<void>((r) => {
            server.closeAllConnections();
            server.close(() => r());
          }),
      });
    });
  });
}
