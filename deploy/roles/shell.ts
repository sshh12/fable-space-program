/**
 * The `shell` role (ARCHITECTURE 10.4, 13.1, 16.1, 16.2): the static front end. No socket, no volume, CDN on.
 *
 *   /, /index.html          the client build's page, `no-cache` (the CDN would hold HTML for two hours)
 *   /endpoints.json         the endpoint document { v, build, gate[], api[], pub[], bootPack }, `no-cache`;
 *                           from ENDPOINT_GATE, ENDPOINT_API, ENDPOINT_PUB (comma-separated, in order)
 *   /assets/<name>-<hash>.* hashed build assets, immutable; other files of the build revalidate
 *   /boot/<hash>.pack       the boot pack, loaded ONCE at start from the packs bucket (p/<hash>, the hash and
 *                           size of BOOT_MANIFEST), verified by SHA-256, held in memory, immutable
 *   /p/<hash>[/<n>]         the packs mirror (deploy/roles/packs.ts), carried by shell up to stage 2
 *   /healthz                200 only once the boot pack is loaded and verified; 503 before
 *   /version.json           buildId, client build hash, boot manifest hash (the rollout checks them)
 *   /_whoami                the address headers the origin received (the CDN measurement)
 *
 * Egress budgets per UTC day (settings; ARCHITECTURE 16.2): the client build 3 GB (then 503 with Retry-After
 * for the build's files; the page and the endpoint document keep answering), the boot pack 1 GB (then a 302
 * to the presigned copy in the bucket), the mirror 8 GB (then 429). Every hashed route (/p/, /boot/, hashed
 * assets) answers 404 with no body to a request with a query string.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import type http from 'node:http';
import path from 'node:path';
import { getBytes, packKey, presignGet, s3For, bucketFromEnv, type BucketConfig } from '../packs/bucket';
import { addressHeaders, clientAddress, empty, IMMUTABLE, ISOLATION, json, SHARED_BYTES, splitUrl } from './http';
import { createMirrorHandler } from './packs';
import type { RoleContext, RoleHandle, RoleModule } from './types';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ktx2': 'image/ktx2',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.woff2': 'font/woff2',
  '.wgsl': 'text/plain; charset=utf-8',
  '.bin': 'application/octet-stream',
};

/** Vite's hashed output: assets/<name>-<hash>.<ext> directly under assets/. */
export const HASHED_ASSET = /^\/assets\/[^/]+-[A-Za-z0-9_-]{8,}\.[a-z0-9]+$/;

export interface BootManifestLite {
  hash: string;
  bytes: number;
}

export interface EndpointDocument {
  v: 1;
  build: string | null;
  gate: string[];
  api: string[];
  pub: string[];
  bootPack: { url: string; hash: string; bytes: number };
}

const list = (v: string | undefined): string[] =>
  (v ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

/** The client build's own hash: `.build-complete.json` of the build directory (written by tools/dev/build-client.mjs). */
export function clientBuildHash(dir: string): string | null {
  try {
    return (JSON.parse(fs.readFileSync(path.join(dir, '.build-complete.json'), 'utf8')) as { hash?: string }).hash ?? null;
  } catch {
    return null;
  }
}

export const sha32 = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex').slice(0, 32);

/** Load the boot pack from the bucket and verify it; throws with the reason (the caller retries). */
export async function loadBootPack(b: BucketConfig, m: BootManifestLite): Promise<Uint8Array> {
  const bytes = await getBytes(s3For(b), b, packKey(m.hash));
  if (bytes.length !== m.bytes) throw new Error(`boot pack ${m.hash}: ${bytes.length} bytes in the bucket, the manifest says ${m.bytes}`);
  const h = sha32(bytes);
  if (h !== m.hash) throw new Error(`boot pack ${m.hash}: the bucket object hashes to ${h}`);
  return bytes;
}

const shellRole: RoleModule = {
  kind: 'service',
  async start(ctx: RoleContext): Promise<RoleHandle> {
    const env = ctx.env;
    // STATIC_DIR is the client build. Unset only on the local stack with --page=dev, where the page comes
    // from the Vite dev server and shell serves the boot pack, the mirror and the endpoint document alone.
    const staticDir = env.STATIC_DIR ? path.resolve(env.STATIC_DIR) : null;
    if (staticDir && !fs.existsSync(path.join(staticDir, 'index.html'))) throw new Error(`shell: STATIC_DIR ${staticDir} has no index.html`);
    const clientBuild = env.CLIENT_BUILD ?? (staticDir ? clientBuildHash(staticDir) : null);
    const manifestFile = env.BOOT_MANIFEST ?? 'deploy/boot-manifest.json';
    const boot = JSON.parse(fs.readFileSync(manifestFile, 'utf8')) as BootManifestLite;
    if (!/^[0-9a-f]{32}$/.test(boot.hash) || !(boot.bytes > 0)) throw new Error(`shell: ${manifestFile} has no valid hash and size`);
    const bucket = bucketFromEnv('PACKS', env);
    if (!bucket) throw new Error('shell: the PACKS_* bucket variables are needed (the boot pack and the mirror)');
    const client = s3For(bucket);
    const endpoints: EndpointDocument = {
      v: 1,
      build: clientBuild,
      gate: list(env.ENDPOINT_GATE),
      api: list(env.ENDPOINT_API),
      pub: list(env.ENDPOINT_PUB),
      bootPack: { url: `/boot/${boot.hash}.pack`, hash: boot.hash, bytes: boot.bytes },
    };
    const endpointsBody = Buffer.from(JSON.stringify(endpoints));
    let bootBytes: Uint8Array | null = null;
    let bootError: string | null = null;
    let bootAttempts = 0;
    const t0 = performance.now();
    let stopped = false;

    // Load the boot pack; until it is in, the health check fails, so a deployment with a missing or wrong
    // pack never takes traffic. Retries back off to 30 s.
    void (async () => {
      let wait = 500;
      while (!stopped && bootBytes === null) {
        bootAttempts++;
        try {
          bootBytes = await loadBootPack(bucket, boot);
          bootError = null;
          ctx.log.info('boot-pack-loaded', { hash: boot.hash, bytes: boot.bytes, ms: Math.round(performance.now() - t0), attempts: bootAttempts });
        } catch (e) {
          bootError = (e as Error).message;
          ctx.log.error('boot-pack-not-loaded', { hash: boot.hash, error: bootError, attempt: bootAttempts });
          await new Promise((r) => setTimeout(r, wait));
          wait = Math.min(30_000, wait * 2);
        }
      }
    })();

    const version = (): Record<string, unknown> => ({ buildId: ctx.build.buildId, commit: ctx.build.commit, clientBuild, bootPack: boot.hash, bootLoaded: bootBytes !== null });

    const sendStatic = (req: http.IncomingMessage, res: http.ServerResponse, rel: string, cache: string, metered: boolean): boolean => {
      if (!staticDir) return false;
      const file = path.normalize(path.join(staticDir, rel));
      if (!file.startsWith(staticDir + path.sep) && file !== staticDir) return empty(res, 404, ISOLATION);
      let st: fs.Stats;
      try {
        st = fs.statSync(file);
      } catch {
        return false;
      }
      if (!st.isFile()) return false;
      const etag = `"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
      const headers: Record<string, string> = { ...ISOLATION, 'Content-Type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream', 'Cache-Control': cache, ETag: etag };
      if (req.headers['if-none-match'] === etag) {
        res.writeHead(304, headers).end();
        return true;
      }
      headers['Content-Length'] = String(st.size);
      res.writeHead(200, headers);
      if (req.method === 'HEAD') {
        res.end();
        return true;
      }
      if (metered) ctx.egress.record('client', st.size);
      fs.createReadStream(file).pipe(res);
      return true;
    };

    ctx.http.add(async (req, res) => {
      const { path: p, query } = splitUrl(req);
      if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS') return false;
      if (p === '/endpoints.json') {
        res.writeHead(200, { ...ISOLATION, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache', 'Content-Length': String(endpointsBody.length) });
        res.end(req.method === 'HEAD' ? undefined : endpointsBody);
        return true;
      }
      if (p === '/version.json') return json(res, 200, version(), ISOLATION);
      if (p === '/_whoami') return json(res, 200, { remote: req.socket.remoteAddress, address: clientAddress(req), headers: addressHeaders(req) }, ISOLATION);
      const bm = /^\/boot\/([0-9a-f]{32})\.pack$/.exec(p);
      if (bm) {
        if (req.method === 'OPTIONS') return empty(res, 204, SHARED_BYTES);
        if (query !== null || bm[1] !== boot.hash) return empty(res, 404, SHARED_BYTES);
        if (bootBytes === null) return empty(res, 503, { ...SHARED_BYTES, 'Retry-After': '5' });
        if (!ctx.egress.open('boot')) {
          ctx.egress.refuse('boot');
          const url = await presignGet(client, bucket, packKey(boot.hash), Date.now());
          res.writeHead(302, { ...SHARED_BYTES, Location: url, 'Cache-Control': 'no-store', 'Content-Length': '0' });
          res.end();
          return true;
        }
        ctx.egress.request('boot');
        const headers = { ...SHARED_BYTES, 'Content-Type': 'application/octet-stream', 'Cache-Control': IMMUTABLE, 'Accept-Ranges': 'bytes' };
        const r = /^bytes=(\d+)-(\d*)$/.exec(typeof req.headers.range === 'string' ? req.headers.range : '');
        let body = bootBytes;
        let status = 200;
        const extra: Record<string, string> = {};
        if (r) {
          const start = Number(r[1]);
          const end = r[2] === '' ? bootBytes.length : Math.min(bootBytes.length, Number(r[2]) + 1);
          if (start >= end) return empty(res, 416, { ...SHARED_BYTES, 'Content-Range': `bytes */${bootBytes.length}` });
          body = bootBytes.subarray(start, end);
          status = 206;
          extra['Content-Range'] = `bytes ${start}-${end - 1}/${bootBytes.length}`;
        }
        res.writeHead(status, { ...headers, ...extra, 'Content-Length': String(body.length) });
        if (req.method === 'HEAD') res.end();
        else {
          ctx.egress.record('boot', body.length);
          res.end(body);
        }
        return true;
      }
      if (p.startsWith('/p/')) return false; // the mirror handler, added below
      if (p === '/' || p === '/index.html') return sendStatic(req, res, 'index.html', 'no-cache', false);
      const hashed = HASHED_ASSET.test(p);
      if (hashed && query !== null) return empty(res, 404, ISOLATION);
      if (!ctx.egress.open('client')) {
        ctx.egress.refuse('client');
        return empty(res, 503, { ...ISOLATION, 'Retry-After': String(ctx.egress.secondsToReset()) });
      }
      ctx.egress.request('client');
      return sendStatic(req, res, decodeURIComponent(p.slice(1)), hashed ? IMMUTABLE : 'no-cache', true);
    });
    ctx.http.add(createMirrorHandler({ client, bucket, sliceBytes: Number(env.MIRROR_SLICE_BYTES ?? 2 * 1024 * 1024), egress: ctx.egress, log: ctx.log }));
    ctx.log.info('shell-ready', { staticDir, clientBuild, bootPack: boot.hash, endpoints: { gate: endpoints.gate.length, api: endpoints.api.length, pub: endpoints.pub.length } });

    return {
      health: () => ({ ok: bootBytes !== null, detail: { ...version(), bootError, bootAttempts } }),
      drain: async () => {
        stopped = true;
      },
    };
  },
};

export default shellRole;
