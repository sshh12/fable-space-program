/**
 * Verification of AWS Signature V4 presigned URLs (query-string form), for the local stand-in of the packs
 * bucket (deploy/local/bucketStandIn.ts): it accepts exactly what the real presigner produces and honours the
 * expiry the URL carries, so the pack list, the 403 refresh and the failover are exercised against real
 * signatures without a bucket.
 */
import { createHash, createHmac } from 'node:crypto';

export interface PresignedCheck {
  ok: boolean;
  /** Why it was refused: 'unsigned', 'malformed', 'expired', 'not-yet-valid', 'credential', 'signature'. */
  reason: string | null;
  expiresAtMs: number | null;
}

const enc = (s: string): string => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/** Parse 20261112T000000Z. */
export function parseAmzDate(s: string): number | null {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(s);
  if (!m) return null;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]));
}

/**
 * Check a presigned GET or HEAD. `rawPath` is the request path exactly as sent (still percent-encoded),
 * `query` its search params, `headers` the request headers (lower-case names).
 */
export function verifyPresigned(
  method: string,
  rawPath: string,
  query: URLSearchParams,
  headers: Record<string, string | string[] | undefined>,
  creds: { accessKeyId: string; secretAccessKey: string },
  nowMs: number,
): PresignedCheck {
  const sig = query.get('X-Amz-Signature');
  if (!sig) return { ok: false, reason: 'unsigned', expiresAtMs: null };
  const algo = query.get('X-Amz-Algorithm');
  const credential = query.get('X-Amz-Credential');
  const amzDate = query.get('X-Amz-Date');
  const expires = Number(query.get('X-Amz-Expires'));
  const signedHeaders = query.get('X-Amz-SignedHeaders');
  if (algo !== 'AWS4-HMAC-SHA256' || !credential || !amzDate || !signedHeaders || !Number.isFinite(expires)) return { ok: false, reason: 'malformed', expiresAtMs: null };
  const t = parseAmzDate(amzDate);
  if (t === null) return { ok: false, reason: 'malformed', expiresAtMs: null };
  const expiresAtMs = t + expires * 1000;
  const [akid, day, region, service, term] = credential.split('/');
  if (akid !== creds.accessKeyId || !day || !region || !service || term !== 'aws4_request' || amzDate.slice(0, 8) !== day) return { ok: false, reason: 'credential', expiresAtMs };
  if (nowMs < t - 15 * 60_000) return { ok: false, reason: 'not-yet-valid', expiresAtMs };
  if (nowMs > expiresAtMs) return { ok: false, reason: 'expired', expiresAtMs };

  const pairs: [string, string][] = [];
  for (const [k, v] of query) if (k !== 'X-Amz-Signature') pairs.push([enc(k), enc(v)]);
  pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  const canonicalQuery = pairs.map(([k, v]) => `${k}=${v}`).join('&');
  const names = signedHeaders.split(';');
  let canonicalHeaders = '';
  for (const n of names) {
    const v = headers[n];
    const value = Array.isArray(v) ? v.join(',') : (v ?? '');
    canonicalHeaders += `${n}:${value.trim().replace(/\s+/g, ' ')}\n`;
  }
  const canonicalRequest = [method, rawPath, canonicalQuery, canonicalHeaders, signedHeaders, 'UNSIGNED-PAYLOAD'].join('\n');
  const scope = `${day}/${region}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, createHash('sha256').update(canonicalRequest).digest('hex')].join('\n');
  const hmac = (key: Buffer | string, data: string): Buffer => createHmac('sha256', key).update(data).digest();
  const kSigning = hmac(hmac(hmac(hmac(`AWS4${creds.secretAccessKey}`, day), region), service), 'aws4_request');
  const expected = createHmac('sha256', kSigning).update(stringToSign).digest('hex');
  return expected === sig ? { ok: true, reason: null, expiresAtMs } : { ok: false, reason: 'signature', expiresAtMs };
}
