/**
 * The pack kind of TileSource (ARCHITECTURE 10.4): tile bytes read by HTTP range from content-addressed packs
 * through an ordered mirror list. Works unchanged on the main thread, in module workers and in Node (it only
 * needs `fetch`, `AbortSignal.timeout` and, for the optional cache, the origin-private file system).
 *
 * - The pack list (from `packListUrl`) names the mirrors in order, each mirror's addressing mode (`ranges` of
 *   `/p/<hash>` or fixed aligned `slices` `/p/<hash>/<S>/<n>` of S = `sliceBytes`) and every set's index object. The
 *   mode and the slice size come from the list; nothing of either is compiled in.
 * - Index objects are read lazily: the header first, then one section (at most 4096 records of one level and
 *   face) when a tile of it is first asked for.
 * - Requests made in the same turn are batched: wanted byte ranges of one pack are sorted and neighbouring
 *   ones (gap at most `coalesceGapBytes`) are merged into one range of at most `maxRangeBytes`. In slice mode
 *   a range maps to the slices it touches, and fetched slices are kept in memory (`sliceCacheBytes`) for the
 *   neighbours that follow.
 * - Failover, per request: the next mirror is tried on 429, any 5xx, a timeout or network error, a 404 for an
 *   object the index promises, any other 4xx, and a body whose length is not the one the index implies; a
 *   403 (an expired signature) first refreshes the pack list ONCE and retries the same mirror, then moves on.
 *   On a mirror of presigned URLs a network error gets the same single refresh first: the bucket's 403 for an
 *   expired URL carries no CORS headers, so a page sees it only as a network error.
 *   A mirror that failed (a 403 that persists after the refresh included) is put behind the others for the
 *   next PENALTY_READS reads. A request's time allowance is `timeoutMs` plus its bytes at `minBytesPerSecond`.
 * - A refreshed list that names another index object for a set (a release) drops what was read of the set:
 *   its index is read again from the new object. The status and the body
 *   length are checked against the offset and length known from the index; Content-Range is never read (it
 *   is not a CORS-safelisted response header).
 * - The optional cache is keyed by content address (`<hash>.<offset>.<length>`), so a changed URL never
 *   causes a re-download.
 * - A boot pack (FPB1) can be added: its tiles and files are served from memory before anything is fetched.
 */
import type { TileManifest, TileSource } from '../core/contracts/terrain';
import { layerHasTile } from '../core/contracts/terrain';
import type { TileKey } from '../core/geo/cubeSphere';
import type { ByteCache } from './opfsCache';
import {
  bootTileKey,
  decodeBootPack,
  decodeIndexHeader,
  decodeRecord,
  groupOrdinal,
  groupSet,
  indexHeaderLength,
  layerRange,
  recordBytes,
  validatePackList,
  type GroupSet,
  type PackList,
  type PackListMirror,
  type TilePackIndex,
} from './packIndex';
import { validateTileManifest } from './tileSource';

/** Reads after a failure during which a mirror is tried after the others. */
export const PENALTY_READS = 64;
/** First read of an index object (the header usually fits). */
const INDEX_HEAD_PROBE = 64 * 1024;

export interface PackSourceOptions {
  packListUrl: string;
  /** A ready cache, a promise of one (opened lazily by the caller), or null for none. */
  cache?: ByteCache | Promise<ByteCache> | null;
  /** Injected fetch (tests count requests with it); defaults to the global one. */
  fetch?: typeof fetch;
  /**
   * Per request, plus the time the request's bytes take at `minBytesPerSecond`: a mirror that does not answer
   * in time is failed over. Default 15 s.
   */
  timeoutMs?: number;
  /** The slowest link a request's time allowance is scaled for. Default 256 KiB/s (an 8 MiB range: 15 + 32 s). */
  minBytesPerSecond?: number;
  /** Neighbouring wanted ranges closer than this are fetched as one. Default 64 KiB. */
  coalesceGapBytes?: number;
  /** Largest merged range. Default 8 MiB. */
  maxRangeBytes?: number;
  /** Slices kept in memory in slice mode. Default 64 MiB. */
  sliceCacheBytes?: number;
  /** Microtask turns a batch waits for siblings before it is sent. Default 3. */
  batchTurns?: number;
  /** Requests in flight at once, over all mirrors (a burst of thousands of tiles is queued, not opened at once). Default 24. */
  maxConcurrent?: number;
  /**
   * Wall clock in ms, injected by the caller (src/terrain reads no clock). With it, the pack list is fetched
   * again once it is older than its `refreshAfterS`; without it, only after a 403.
   */
  now?: () => number;
}

interface ListState {
  doc: PackList;
  base: string;
  gen: number;
}

/** Counters of what crossed the network (a test and the capacity report read them). */
export interface PackSourceStats {
  /** HTTP requests sent, per mirror id, and for the pack list. */
  requests: Record<string, number>;
  /** Body bytes received per mirror id. */
  bytesReceived: Record<string, number>;
  /** Failures per mirror id and reason (`429`, `5xx`, `404`, `403`, `timeout`, `network`, `length`, `4xx`). */
  failures: Record<string, Record<string, number>>;
  /** Bytes the callers asked for that were not in memory or the cache (what had to cross the network). */
  bytesNeeded: number;
  /** Reads answered from the boot pack, the cache, the network. */
  fromBoot: number;
  fromCache: number;
  fromNetwork: number;
  packListLoads: number;
}

export interface PackTileSource extends TileSource {
  /** A byte range of a plain file of a set (for example the low mips at the end of a sky face). */
  fileRange(set: string, relPath: string, from: number, length: number): Promise<Uint8Array>;
  /** Serve the tiles and files of a boot pack (FPB1 bytes, already verified by the caller) from memory. */
  addBootPack(bytes: Uint8Array): void;
  /** The pack list in force. */
  packList(): Promise<PackList>;
  /** Names of the sets the pack list offers. */
  sets(): Promise<string[]>;
  stats(): PackSourceStats;
}

interface SetState {
  header: TilePackIndex;
  indexHash: string;
  manifest: Promise<TileManifest> | null;
  /** (kind, level, face) -> section numbers. */
  sectionsBy: Map<string, number[]>;
  sectionData: Map<number, Promise<DataView>>;
  groupSets: Map<string, GroupSet>;
  /** layer -> [kind number, position in the kind]. */
  layerKind: Map<string, [number, number]>;
}

interface Want {
  hash: string;
  offset: number;
  length: number;
  resolve: (b: Uint8Array) => void;
  reject: (e: unknown) => void;
}

class MirrorError extends Error {
  constructor(
    readonly reason: string,
    message: string,
  ) {
    super(message);
  }
}

const addTo = (rec: Record<string, number>, key: string, n: number): void => {
  rec[key] = (rec[key] ?? 0) + n;
};

export function createPackTileSource(o: PackSourceOptions): PackTileSource {
  const doFetch: typeof fetch = o.fetch ?? ((input, init) => fetch(input, init));
  const timeoutMs = o.timeoutMs ?? 15_000;
  const minRate = o.minBytesPerSecond ?? 256 * 1024;
  const timeoutFor = (bytes: number): number => timeoutMs + Math.ceil((bytes / minRate) * 1000);
  const gap = o.coalesceGapBytes ?? 64 * 1024;
  const maxRange = o.maxRangeBytes ?? 8 * 1024 * 1024;
  const sliceCacheBytes = o.sliceCacheBytes ?? 64 * 1024 * 1024;
  const batchTurns = o.batchTurns ?? 3;
  const maxConcurrent = o.maxConcurrent ?? 24;
  let active = 0;
  const queue: (() => void)[] = [];
  const acquire = (): Promise<void> => {
    if (active < maxConcurrent) {
      active++;
      return Promise.resolve();
    }
    return new Promise((resolve) => queue.push(resolve));
  };
  const release = (): void => {
    const next = queue.shift();
    if (next) next();
    else active--;
  };
  let cache: ByteCache | null = null;
  const cacheReady: Promise<void> = Promise.resolve(o.cache ?? null).then((c) => {
    cache = c;
  });
  // A cache that cannot open fails every read with its reason (awaited below); this only keeps an unused
  // source from raising an unhandled rejection.
  cacheReady.catch(() => undefined);

  const stats: PackSourceStats = { requests: {}, bytesReceived: {}, failures: {}, bytesNeeded: 0, fromBoot: 0, fromCache: 0, fromNetwork: 0, packListLoads: 0 };
  let list: Promise<ListState> | null = null;
  let listGeneration = 0;
  let listLoadedAt: number | null = null;
  const objectBytes = new Map<string, number>();
  const sets = new Map<string, Promise<SetState>>();
  /** The index object each loaded set was read from (a refreshed list naming another one drops the set). */
  const setIndex = new Map<string, string>();
  const penalty = new Map<string, number>();
  let readCounter = 0;
  const boot = { tiles: new Map<string, Uint8Array>(), files: new Map<string, Uint8Array>(), ranges: new Map<string, Uint8Array>() };

  // ----------------------------------------------------------------------------------------- pack list
  const loadList = (): Promise<ListState> => {
    const p = (async (): Promise<ListState> => {
      stats.packListLoads++;
      addTo(stats.requests, 'packList', 1);
      const r = await doFetch(o.packListUrl, { cache: 'no-store', signal: AbortSignal.timeout(timeoutMs) });
      if (!r.ok) throw new Error(`pack list ${o.packListUrl}: HTTP ${r.status}`);
      const doc = validatePackList(await r.json());
      for (const s of Object.values(doc.sets)) objectBytes.set(s.index, s.indexBytes);
      // A set whose index object changed (a new release) or that the list no longer offers is read again.
      for (const [name, index] of setIndex) {
        if (doc.sets[name]?.index !== index) {
          setIndex.delete(name);
          sets.delete(name);
        }
      }
      listLoadedAt = o.now ? o.now() : null;
      return { doc, base: r.url || o.packListUrl, gen: ++listGeneration };
    })();
    p.catch(() => {
      if (list === p) list = null;
    });
    list = p;
    return p;
  };
  /** The list in force; fetched again once it is older than its `refreshAfterS` (only with an injected clock). */
  const getList = async (): Promise<ListState> => {
    const p = list ?? loadList();
    const cur = await p;
    if (o.now && listLoadedAt !== null && list === p && o.now() - listLoadedAt > cur.doc.refreshAfterS * 1000) {
      listLoadedAt = null; // one refresh, however many readers notice at once
      return loadList();
    }
    return cur;
  };
  /** After a 403 on a list of generation `gen`: one shared refresh (a newer list is used as it is). */
  const refreshAfter = async (gen: number): Promise<ListState> => {
    const cur = await (list ?? loadList());
    return cur.gen > gen ? cur : loadList();
  };

  const mirrorUrl = (m: PackListMirror, base: string, hash: string, slice: number | null): string => {
    // A slice URL names its size (/p/<hash>/<S>/<n>): the list's sliceBytes is the one source of truth for S.
    const raw = m.objects ? m.objects[hash] : `${m.base!}${hash}${slice === null ? '' : `/${m.sliceBytes!}/${slice}`}`;
    if (raw === undefined) throw new MirrorError('404', `mirror ${m.id} lists no URL for object ${hash}`);
    return new URL(raw, base).toString();
  };

  // ------------------------------------------------------------------------------------- one request
  const sizeOf = (hash: string): number => {
    const n = objectBytes.get(hash);
    if (n === undefined) throw new Error(`pack source: size of object ${hash} unknown (no index names it)`);
    return n;
  };

  /** One HTTP request for [start, end) of object `hash` from one mirror (ranges mode), or one whole slice (`whole` = its length). */
  const request = async (m: PackListMirror, url: string, hash: string, start: number, end: number, whole: number | null): Promise<Uint8Array> => {
    await acquire();
    try {
      return await requestNow(m, url, hash, start, end, whole);
    } finally {
      release();
    }
  };
  const requestNow = async (m: PackListMirror, url: string, hash: string, start: number, end: number, whole: number | null): Promise<Uint8Array> => {
    addTo(stats.requests, m.id, 1);
    let r: Response;
    try {
      const signal = AbortSignal.timeout(timeoutFor(whole ?? end - start));
      r = await doFetch(url, whole === null ? { headers: { Range: `bytes=${start}-${end - 1}` }, signal } : { signal });
    } catch (e) {
      const name = (e as { name?: string })?.name;
      throw new MirrorError(name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'network', `${m.id}: ${(e as Error).message}`);
    }
    if (r.status === 429) throw new MirrorError('429', `${m.id}: 429`);
    if (r.status >= 500) throw new MirrorError('5xx', `${m.id}: HTTP ${r.status}`);
    if (r.status === 404) throw new MirrorError('404', `${m.id}: 404 for an object the index promises`);
    if (r.status === 403) throw new MirrorError('403', `${m.id}: 403`);
    if (r.status >= 400) throw new MirrorError('4xx', `${m.id}: HTTP ${r.status}`);
    let body: Uint8Array;
    try {
      body = new Uint8Array(await r.arrayBuffer());
    } catch (e) {
      const name = (e as { name?: string })?.name;
      throw new MirrorError(name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'network', `${m.id}: body: ${(e as Error).message}`);
    }
    addTo(stats.bytesReceived, m.id, body.length);
    if (whole !== null) {
      if (r.status !== 200 || body.length !== whole) throw new MirrorError('length', `${m.id}: slice answered ${r.status} with ${body.length} bytes, expected 200 and ${whole}`);
      return body;
    }
    if (r.status === 206 && body.length === end - start) return body;
    // A server that ignores Range answers 200 with the whole object: usable only if it is exactly that.
    if (r.status === 200 && body.length === sizeOf(hash)) return body.subarray(start, end);
    throw new MirrorError('length', `${m.id}: answered ${r.status} with ${body.length} bytes for a range of ${end - start}`);
  };

  // Slice mode: in-memory slices (LRU by a counter) and in-flight dedup.
  const slices = new Map<string, { bytes: Uint8Array; used: number }>();
  const slicesInFlight = new Map<string, Promise<Uint8Array>>();
  let sliceBytesHeld = 0;
  let sliceSeq = 0;
  const keepSlice = (key: string, bytes: Uint8Array): void => {
    if (slices.has(key)) return;
    slices.set(key, { bytes, used: ++sliceSeq });
    sliceBytesHeld += bytes.length;
    if (sliceBytesHeld > sliceCacheBytes) {
      for (const [k, s] of [...slices.entries()].sort((a, b) => a[1].used - b[1].used)) {
        if (sliceBytesHeld <= sliceCacheBytes * 0.75) break;
        slices.delete(k);
        sliceBytesHeld -= s.bytes.length;
      }
    }
  };

  const viaMirror = async (m: PackListMirror, base: string, hash: string, start: number, end: number): Promise<Uint8Array> => {
    if (m.mode === 'ranges') return request(m, mirrorUrl(m, base, hash, null), hash, start, end, null);
    const S = m.sliceBytes!;
    const size = sizeOf(hash);
    const out = new Uint8Array(end - start);
    const n0 = Math.floor(start / S);
    const n1 = Math.floor((end - 1) / S);
    await Promise.all(
      Array.from({ length: n1 - n0 + 1 }, async (_, i) => {
        const n = n0 + i;
        const key = `${m.id}/${hash}/${S}/${n}`;
        let bytes = slices.get(key)?.bytes;
        if (bytes) slices.get(key)!.used = ++sliceSeq;
        else {
          let p = slicesInFlight.get(key);
          if (!p) {
            const len = Math.min(S, size - n * S);
            p = request(m, mirrorUrl(m, base, hash, n), hash, 0, len, len);
            slicesInFlight.set(key, p);
            p.then(
              (b) => {
                slicesInFlight.delete(key);
                keepSlice(key, b);
              },
              () => slicesInFlight.delete(key),
            );
          }
          bytes = await p;
        }
        const s0 = n * S;
        const a = Math.max(start, s0);
        const b = Math.min(end, s0 + bytes.length);
        out.set(bytes.subarray(a - s0, b - s0), a - start);
      }),
    );
    return out;
  };

  /** [start, end) of an object, failing over through the mirrors. */
  const fetchRange = async (hash: string, start: number, end: number): Promise<Uint8Array> => {
    const read = ++readCounter;
    let { doc, base, gen } = await getList();
    const tried: string[] = [];
    let refreshed = false;
    const order = doc.mirrors.map((m, i) => ({ m, i })).sort((a, b) => Number((penalty.get(a.m.id) ?? 0) > read) - Number((penalty.get(b.m.id) ?? 0) > read) || a.i - b.i);
    for (let j = 0; j < order.length; j++) {
      const id = order[j]!.m.id;
      const m = doc.mirrors.find((x) => x.id === id) ?? order[j]!.m;
      try {
        return await viaMirror(m, base, hash, start, end);
      } catch (e) {
        if (!(e instanceof MirrorError)) throw e;
        stats.failures[m.id] ??= {};
        addTo(stats.failures[m.id]!, e.reason, 1);
        tried.push(e.message);
        // An expired signature: fetch the list once more and retry this mirror with its new URL. A browser
        // cannot always SEE the 403: Railway's bucket sends its "Request has expired" answer without CORS
        // headers (measured 2026-11-12), so the page gets a network error. On a mirror of presigned URLs a
        // network error is therefore treated like a 403 once: one refresh, the same mirror, then the next.
        if ((e.reason === '403' || (e.reason === 'network' && m.objects !== undefined)) && !refreshed) {
          refreshed = true;
          ({ doc, base, gen } = await refreshAfter(gen));
          j--;
          continue;
        }
        // Failed (a 403 that persists after the refresh included): behind the others for a while.
        penalty.set(m.id, read + PENALTY_READS);
      }
    }
    throw new Error(`pack source: object ${hash} [${start}, ${end}) failed on every mirror: ${tried.join('; ')}`);
  };

  // ------------------------------------------------------------------------------------------ batching
  let pending: Want[] = [];
  let scheduled = false;
  const inFlight = new Map<string, Promise<Uint8Array>>();

  const flush = (): void => {
    scheduled = false;
    const batch = pending;
    pending = [];
    const byHash = new Map<string, Want[]>();
    for (const w of batch) {
      let l = byHash.get(w.hash);
      if (!l) byHash.set(w.hash, (l = []));
      l.push(w);
    }
    for (const [hash, wants] of byHash) {
      wants.sort((a, b) => a.offset - b.offset || a.length - b.length);
      let group: Want[] = [];
      let gStart = 0;
      let gEnd = 0;
      const send = (): void => {
        if (group.length === 0) return;
        const members = group;
        const s = gStart;
        const e = gEnd;
        fetchRange(hash, s, e).then(
          (bytes) => {
            for (const w of members) w.resolve(bytes.subarray(w.offset - s, w.offset - s + w.length));
          },
          (err) => {
            for (const w of members) w.reject(err);
          },
        );
        group = [];
      };
      for (const w of wants) {
        const wEnd = w.offset + w.length;
        if (group.length > 0 && w.offset <= gEnd + gap && Math.max(gEnd, wEnd) - gStart <= maxRange) {
          group.push(w);
          gEnd = Math.max(gEnd, wEnd);
        } else {
          send();
          group = [w];
          gStart = w.offset;
          gEnd = wEnd;
        }
      }
      send();
    }
  };

  const schedule = (): void => {
    if (scheduled) return;
    scheduled = true;
    let p: Promise<void> = Promise.resolve();
    for (let i = 0; i < batchTurns; i++) p = p.then(() => undefined);
    void p.then(flush);
  };

  /** Bytes [offset, offset + length) of an immutable object: cache, then the network (batched). */
  const readBytes = (hash: string, offset: number, length: number): Promise<Uint8Array> => {
    const key = `${hash}.${offset}.${length}`;
    const existing = inFlight.get(key);
    if (existing) return existing;
    const p = (async () => {
      await cacheReady;
      const c = cache;
      if (c) {
        const hit = await c.get(key);
        if (hit) {
          stats.fromCache++;
          return hit;
        }
      }
      stats.fromNetwork++;
      stats.bytesNeeded += length;
      const bytes = await new Promise<Uint8Array>((resolve, reject) => {
        pending.push({ hash, offset, length, resolve, reject });
        schedule();
      });
      if (c) await c.put(key, bytes.slice());
      return bytes;
    })();
    inFlight.set(key, p);
    p.then(
      () => inFlight.delete(key),
      () => inFlight.delete(key),
    );
    return p;
  };

  // ---------------------------------------------------------------------------------------- the sets
  const loadSet = async (set: string): Promise<SetState> => {
    // The list in force first: a list past its refreshAfterS is read again here, and a set whose index object
    // it changed is dropped (loadList), so this read already uses the new index.
    if (o.now) await getList();
    let p = sets.get(set);
    if (!p) {
      p = (async () => {
        const { doc } = await getList();
        const entry = doc.sets[set];
        if (!entry) throw new Error(`pack source: the pack list offers no set "${set}"`);
        setIndex.set(set, entry.index);
        const probe = Math.min(INDEX_HEAD_PROBE, entry.indexBytes);
        let head = await readBytes(entry.index, 0, probe);
        const len = indexHeaderLength(head.subarray(0, 8));
        if (8 + len > head.length) head = await readBytes(entry.index, 0, 8 + len);
        const header = decodeIndexHeader(head.subarray(8, 8 + len));
        if (header.set !== set) throw new Error(`pack source: index ${entry.index} is of set "${header.set}", not "${set}"`);
        for (const pk of header.packs) objectBytes.set(pk.hash, pk.bytes);
        const sectionsBy = new Map<string, number[]>();
        header.sections.forEach((s, i) => {
          const k = `${s.k}/${s.l}/${s.f}`;
          let l = sectionsBy.get(k);
          if (!l) sectionsBy.set(k, (l = []));
          l.push(i);
        });
        const layerKind = new Map<string, [number, number]>();
        header.kinds.forEach((k, ki) => k.layers.forEach((layer, li) => layerKind.set(layer, [ki, li])));
        return { header, indexHash: entry.index, manifest: null, sectionsBy, sectionData: new Map(), groupSets: new Map(), layerKind };
      })();
      p.catch(() => {
        if (sets.get(set) === p) sets.delete(set);
      });
      sets.set(set, p);
    }
    return p;
  };

  const section = (st: SetState, i: number): Promise<DataView> => {
    let p = st.sectionData.get(i);
    if (!p) {
      const s = st.header.sections[i]!;
      p = readBytes(st.indexHash, s.offset, s.bytes).then((b) => new DataView(b.buffer, b.byteOffset, b.byteLength));
      p.catch(() => st.sectionData.delete(i));
      st.sectionData.set(i, p);
    }
    return p;
  };

  const readFile = async (set: string, relPath: string): Promise<Uint8Array> => {
    const rel = relPath.replace(/^\/+/, '');
    const b = boot.files.get(`${set}/${rel}`);
    if (b) {
      stats.fromBoot++;
      return b;
    }
    const st = await loadSet(set);
    const e = st.header.files[rel];
    if (!e) throw new Error(`pack source: set "${set}" has no file ${rel}`);
    return readBytes(st.header.packs[e[0]]!.hash, e[1], e[2]);
  };

  const manifest = async (set: string): Promise<TileManifest> => {
    const st = await loadSet(set);
    if (st.header.type !== 'tiles') throw new Error(`pack source: set "${set}" is a file set, it has no tile manifest`);
    if (!st.manifest) {
      const p = readFile(set, 'manifest.json').then((b) => validateTileManifest(JSON.parse(new TextDecoder().decode(b)) as unknown, set));
      p.catch(() => {
        if (st.manifest === p) st.manifest = null;
      });
      st.manifest = p;
    }
    return st.manifest;
  };

  return {
    manifest,
    async tile(set: string, layer: string, key: TileKey): Promise<Uint8Array | null> {
      const m = await manifest(set);
      const lm = m.layers[layer];
      if (!lm || !layerHasTile(lm, key)) return null;
      const b = boot.tiles.get(bootTileKey(set, layer, key));
      if (b) {
        stats.fromBoot++;
        return b;
      }
      const st = await loadSet(set);
      const lk = st.layerKind.get(layer);
      if (!lk) throw new Error(`pack source: set "${set}" packs no layer ${layer}`);
      const [k, li] = lk;
      const gk = `${k}/${key.level}/${key.face}`;
      let gs = st.groupSets.get(gk);
      if (!gs) st.groupSets.set(gk, (gs = groupSet(m, st.header.kinds[k]!, key.level, key.face)));
      const ord = groupOrdinal(gs, key);
      const secs = st.sectionsBy.get(gk) ?? [];
      const si = secs.find((i) => {
        const s = st.header.sections[i]!;
        return ord >= s.first && ord < s.first + s.count;
      });
      if (ord < 0 || si === undefined) throw new Error(`pack source: ${set}/${layer} ${key.face}/${key.level}/${key.x}/${key.y} is promised by the manifest but not in the index`);
      const view = await section(st, si);
      const kind = st.header.kinds[k]!;
      const rec = decodeRecord(view, (ord - st.header.sections[si]!.first) * recordBytes(kind.layers.length), kind.layers.length);
      const r = layerRange(rec, li);
      if (!r) throw new Error(`pack source: ${set}/${layer} ${key.face}/${key.level}/${key.x}/${key.y} is promised by the manifest but absent from its group`);
      return readBytes(st.header.packs[rec.pack]!.hash, r.offset, r.length);
    },
    file: readFile,
    async fileRange(set, relPath, from, length) {
      const rel = relPath.replace(/^\/+/, '');
      const b = boot.ranges.get(`${set}/${rel}@${from}+${length}`);
      if (b) {
        stats.fromBoot++;
        return b;
      }
      const st = await loadSet(set);
      const e = st.header.files[rel];
      if (!e) throw new Error(`pack source: set "${set}" has no file ${rel}`);
      if (from < 0 || from + length > e[2]) throw new Error(`pack source: ${set}/${rel} [${from}, ${from + length}) is outside the file`);
      return readBytes(st.header.packs[e[0]]!.hash, e[1] + from, length);
    },
    addBootPack(bytes) {
      const { header, data } = decodeBootPack(bytes);
      for (const e of header.entries) {
        const b = data.subarray(e.o, e.o + e.n);
        if ('layer' in e) boot.tiles.set(bootTileKey(e.set, e.layer, { face: e.face as TileKey['face'], level: e.level, x: e.x, y: e.y }), b);
        else if (e.from === undefined) boot.files.set(`${e.set}/${e.path}`, b);
        else boot.ranges.set(`${e.set}/${e.path}@${e.from}+${e.n}`, b);
      }
    },
    packList: async () => (await getList()).doc,
    sets: async () => Object.keys((await getList()).doc.sets).sort(),
    stats: () => structuredClone(stats),
  };
}
