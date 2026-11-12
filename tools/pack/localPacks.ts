/**
 * Whole-pack mode (Node): the pack source reading packs that are present as whole files on a disk (the
 * development machine's data/packs, a Modal volume), through the same code path as the network modes.
 *
 * `createLocalPackFetch(packsDir)` returns a `fetch`-compatible function that answers
 *   <base>/packs.json   a pack list with one mirror (`ranges`, base <base>/p/) over the packer's current pointers
 *   <base>/p/<hash>     a single byte range of a pack or index object, read from its file
 *   <base>/p/<hash>/<S>/<n>  slice n of S bytes (the mirror's slice mode; S is in the URL)
 * so `createPackTileSource({ packListUrl: LOCAL_PACK_LIST_URL, fetch })` reads every tile from local packs.
 */
import fs from 'node:fs';
import { PACK_FORMAT_VERSION, type PackList } from '../../src/terrain/packIndex';
import { createObjectFinder, parseRange } from '../../deploy/local/bucketStandIn';
import { packedSets } from './packer';

export const LOCAL_PACK_BASE = 'http://local.packs.invalid';
export const LOCAL_PACK_LIST_URL = `${LOCAL_PACK_BASE}/packs.json`;

export function localPackList(packsDir: string): PackList {
  const sets = packedSets(packsDir);
  return {
    v: PACK_FORMAT_VERSION,
    signedDay: null,
    refreshAfterS: 86400,
    mirrors: [{ id: 'local', mode: 'ranges', base: `${LOCAL_PACK_BASE}/p/` }],
    sets: Object.fromEntries(sets.map((s) => [s.set, { index: s.index, indexBytes: s.indexBytes }])),
  };
}

export function createLocalPackFetch(packsDir: string): typeof fetch {
  const find = createObjectFinder(packsDir);
  const fds = new Map<string, number>();
  const read = (file: string, start: number, end: number): Uint8Array<ArrayBuffer> => {
    let fd = fds.get(file);
    if (fd === undefined) fds.set(file, (fd = fs.openSync(file, 'r')));
    const buf = new Uint8Array(end - start);
    let got = 0;
    while (got < buf.length) {
      const n = fs.readSync(fd, buf, got, buf.length - got, start + got);
      if (n === 0) break;
      got += n;
    }
    return got === buf.length ? buf : buf.slice(0, got);
  };
  const local = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.pathname === '/packs.json') return new Response(JSON.stringify(localPackList(packsDir)), { status: 200, headers: { 'Content-Type': 'application/json' } });
    const m = /^\/p\/([0-9a-f]{32})(?:\/(\d+)\/(\d+))?$/.exec(url.pathname);
    const file = m ? find(m[1]!) : null;
    if (!file) return new Response(null, { status: 404 });
    const size = fs.statSync(file).size;
    if (m![2] !== undefined) {
      const S = Number(m![2]);
      const n = Number(m![3]);
      if (!S || n * S >= size) return new Response(null, { status: 404 });
      return new Response(read(file, n * S, Math.min(size, (n + 1) * S)), { status: 200 });
    }
    const h = new Headers(init?.headers);
    const r = parseRange(h.get('range') ?? undefined, size);
    if (r === 'unsatisfiable') return new Response(null, { status: 416 });
    if (r === null) return new Response(read(file, 0, size), { status: 200 });
    return new Response(read(file, r.start, r.end), { status: 206 });
  };
  return local as typeof fetch;
}
