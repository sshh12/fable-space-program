/** HTTP helpers shared by the static roles. */
import type http from 'node:http';

/** Cross-origin isolation of the page (SharedArrayBuffer, precise timers): every response of `shell` carries them. */
export const ISOLATION: Record<string, string> = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

/** Byte objects any isolated page may read with fetch (packs, slices, the boot pack). */
export const SHARED_BYTES: Record<string, string> = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Allow-Headers': 'Range',
  'Access-Control-Max-Age': '86400',
  'Cross-Origin-Resource-Policy': 'cross-origin',
};

export const IMMUTABLE = 'public, max-age=31536000, immutable';

/** Path and query of a request (the raw query string, '' when there is none, null when there is no '?'). */
export function splitUrl(req: http.IncomingMessage): { path: string; query: string | null } {
  const raw = req.url ?? '/';
  const i = raw.indexOf('?');
  return i < 0 ? { path: raw, query: null } : { path: raw.slice(0, i), query: raw.slice(i + 1) };
}

/**
 * The client's address as the origin sees it: the first X-Forwarded-For entry (Railway's edge and CDN set
 * it), else X-Real-IP, else the socket's peer. Whether the CDN passes it is measured (platform-delivery D5);
 * the daily budgets do not depend on it.
 */
export function clientAddress(req: http.IncomingMessage): string {
  const xff = req.headers['x-forwarded-for'];
  const first = (Array.isArray(xff) ? xff[0] : xff)?.split(',')[0]?.trim();
  if (first) return first;
  const real = req.headers['x-real-ip'];
  if (typeof real === 'string' && real) return real;
  return req.socket.remoteAddress ?? 'unknown';
}

/** Headers that can carry a client address, as received (for the measurement of what the CDN passes). */
export function addressHeaders(req: http.IncomingMessage): Record<string, string | string[] | undefined> {
  const names = ['x-forwarded-for', 'x-real-ip', 'forwarded', 'x-envoy-external-address', 'cf-connecting-ip', 'fastly-client-ip', 'true-client-ip', 'x-railway-edge', 'x-railway-request-id', 'via'];
  return Object.fromEntries(names.map((n) => [n, req.headers[n]]).filter(([, v]) => v !== undefined));
}

/** An empty answer: no body, Content-Length 0 (a 404 for a query-string variant sends no bytes at all). */
export function empty(res: http.ServerResponse, status: number, headers: Record<string, string> = {}): true {
  res.writeHead(status, { ...headers, 'Content-Length': '0', 'Cache-Control': 'no-store' });
  res.end();
  return true;
}

export function json(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): true {
  const b = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': String(b.length), 'Cache-Control': 'no-store', ...headers });
  res.end(b);
  return true;
}

/** The route of every response no role meters itself (deploy/roles/egress.ts `public`). */
export const PUBLIC_ROUTE = 'public';
/** Reserved per public response at admission; settled with the body bytes it actually sent. */
export const PUBLIC_RESERVE_BYTES = 64 * 1024;
/** Railway's health checks arrive with this Host (not reachable from the internet): answered past the budget. */
export const HEALTHCHECK_HOST = 'healthcheck.railway.app';

/**
 * Admission of a public response (the program entry calls it for every request no role meters itself): a
 * reservation against the public budget before the handler runs, settled at close with the body bytes the
 * response wrote. Past the budget it answers 429 with Retry-After (the reset at 00:00 UTC) and returns false,
 * except to Railway's health check of /healthz, so a deploy can still pass. A response larger than the
 * reservation is charged in full at close (the overshoot is bounded by one response per request in flight).
 */
export function admitPublic(egress: import('./egress').EgressMeter, req: http.IncomingMessage, res: http.ServerResponse, path: string): boolean {
  const admission = egress.admit(PUBLIC_ROUTE, PUBLIC_RESERVE_BYTES, clientAddress(req));
  if (!admission) {
    if (path === '/healthz' && req.headers.host === HEALTHCHECK_HOST) return true;
    res.writeHead(429, { 'Retry-After': String(egress.secondsToReset()), 'Content-Length': '0', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' });
    res.end();
    return false;
  }
  let n = 0;
  const size = (chunk: unknown): number => (typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk instanceof Uint8Array ? chunk.length : 0);
  const write = res.write.bind(res) as (...a: unknown[]) => boolean;
  const end = res.end.bind(res) as (...a: unknown[]) => http.ServerResponse;
  res.write = ((chunk: unknown, ...rest: unknown[]) => {
    n += size(chunk);
    return write(chunk, ...rest);
  }) as typeof res.write;
  res.end = ((chunk?: unknown, ...rest: unknown[]) => {
    if (typeof chunk !== 'function') n += size(chunk);
    return end(chunk, ...rest);
  }) as typeof res.end;
  res.on('close', () => admission.settle(n));
  return true;
}
