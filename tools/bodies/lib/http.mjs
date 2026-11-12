// Cached downloads for tools/bodies. Every download is untrusted data: it lives in its own directory under
// data/cache/bodies/<id>/ (scripts stay in tools/), and is only ever parsed as text or JSON, never executed.
// A side file <name>.meta.json records the URL, the time of retrieval, the byte count and the sha256, which the
// extracted source tables under tools/bodies/sources/ carry along with every number taken from the file.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
export const CACHE_ROOT = join(REPO_ROOT, 'data/cache/bodies');

/** A generic client name: no personal or project detail goes to the remote services. */
const USER_AGENT = 'body-ephemeris-tool/1.0 (node)';

export const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/**
 * Download `url` into data/cache/bodies/<id>/<name> unless it is already there (or `refresh`).
 * Returns { path, text, meta } with meta = { url, retrievedAt, bytes, sha256 }.
 */
export async function fetchCached(id, name, url, { refresh = false, retries = 3, headers = {} } = {}) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) throw new Error(`bad cache id "${id}"`);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) throw new Error(`bad cache file name "${name}"`);
  const dir = join(CACHE_ROOT, id);
  const path = join(dir, name);
  const metaPath = `${path}.meta.json`;
  if (!refresh && existsSync(path) && existsSync(metaPath)) {
    const buf = readFileSync(path);
    const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
    if (meta.sha256 !== sha256(buf)) throw new Error(`${path}: content does not match its recorded sha256 (delete it to re-fetch)`);
    return { path, text: buf.toString('utf8'), meta };
  }
  mkdirSync(dir, { recursive: true });
  let lastError = null;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT, Accept: '*/*', ...headers } });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      const buf = Buffer.from(await res.arrayBuffer());
      const meta = { url, retrievedAt: new Date().toISOString(), bytes: buf.length, sha256: sha256(buf), ...(headers.Range ? { range: headers.Range } : {}) };
      writeFileSync(path, buf);
      writeFileSync(metaPath, `${JSON.stringify(meta, null, 2)}\n`);
      return { path, text: buf.toString('utf8'), meta };
    } catch (err) {
      lastError = err;
      await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
    }
  }
  throw lastError;
}
