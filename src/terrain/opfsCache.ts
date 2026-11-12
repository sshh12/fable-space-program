/**
 * Content-addressed byte cache for the pack source (ARCHITECTURE 10.4), in the origin-private file system.
 *
 * Keys are content addresses: `<object hash>.<offset>.<length>` (a byte range of an immutable pack or index
 * object), so a changed URL - a new day's signature, another mirror - never causes a re-download, and an
 * entry can never be stale. The cache keeps at most `maxBytes`; past it, the least recently used entries are
 * removed until 90 % of the budget is in use. Recency is a counter, not a clock (src/terrain is headless).
 *
 * Layout: one directory (`fsp-packs` by default) holding one file per entry and `ledger.json` (entry, bytes,
 * last use). The ledger is written after every LEDGER_EVERY puts, after every eviction and on `flush()`; at
 * open, entry files the ledger does not know (written after its last save) are adopted as the least recently
 * used, so nothing is lost or orphaned, and anything else in the directory is removed.
 *
 * Works on the main thread and in workers (createWritable). Node has no OPFS: `openOpfsCache` rejects there,
 * and a `TileSourceSpec` that asks for the OPFS cache is a configuration error, not something to ignore.
 */

/** What the pack source needs of a cache. */
export interface ByteCache {
  get(key: string): Promise<Uint8Array | null>;
  put(key: string, bytes: Uint8Array): Promise<void>;
  /** Entries and bytes held. */
  usage(): { entries: number; bytes: number };
  /** Write the ledger now. */
  flush(): Promise<void>;
}

export const OPFS_CACHE_DIR = 'fsp-packs';
const LEDGER = 'ledger.json';
const LEDGER_EVERY = 64;
const KEY_RE = /^[0-9a-f]{32}\.\d+\.\d+$/;

interface Ledger {
  v: 1;
  seq: number;
  entries: [string, number, number][];
}

/** Minimal shape of the OPFS API used here (the DOM library is not visible to headless code). */
interface FsWritable {
  write(data: Uint8Array): Promise<void>;
  close(): Promise<void>;
}
interface FsFileHandle {
  getFile(): Promise<{ arrayBuffer(): Promise<ArrayBuffer>; size: number }>;
  createWritable(): Promise<FsWritable>;
}
interface FsDirHandle {
  getFileHandle(name: string, o?: { create?: boolean }): Promise<FsFileHandle>;
  getDirectoryHandle(name: string, o?: { create?: boolean }): Promise<FsDirHandle>;
  removeEntry(name: string): Promise<void>;
  keys(): AsyncIterable<string>;
}
interface StorageLike {
  getDirectory(): Promise<FsDirHandle>;
}

function opfsRoot(): Promise<FsDirHandle> {
  const nav = (globalThis as { navigator?: { storage?: StorageLike } }).navigator;
  const storage = nav?.storage;
  if (!storage || typeof storage.getDirectory !== 'function') {
    return Promise.reject(new Error('opfs cache: the origin-private file system is not available here (a browser page or worker is needed)'));
  }
  return storage.getDirectory();
}

const isNotFound = (e: unknown): boolean => (e as { name?: string })?.name === 'NotFoundError';

export async function openOpfsCache(o: { maxBytes: number; dirName?: string }): Promise<ByteCache> {
  if (!(o.maxBytes > 0)) throw new Error('opfs cache: maxBytes must be positive');
  const root = await opfsRoot();
  const dir = await root.getDirectoryHandle(o.dirName ?? OPFS_CACHE_DIR, { create: true });
  const entries = new Map<string, { bytes: number; used: number }>();
  let seq = 0;
  let total = 0;
  let putsSinceSave = 0;

  // Read the ledger; drop files it does not know.
  try {
    const f = await (await dir.getFileHandle(LEDGER)).getFile();
    const led = JSON.parse(new TextDecoder().decode(await f.arrayBuffer())) as Ledger;
    if (led.v === 1 && Array.isArray(led.entries)) {
      seq = led.seq;
      for (const [k, b, u] of led.entries) {
        entries.set(k, { bytes: b, used: u });
        total += b;
      }
    }
  } catch (e) {
    if (!isNotFound(e) && !(e instanceof SyntaxError)) throw e;
  }
  // Files the ledger does not know were written after its last save. A file exists only once its writable
  // was closed (OPFS commits on close), so it is a complete entry: adopt it as the least recently used.
  for await (const name of dir.keys()) {
    if (name === LEDGER || entries.has(name)) continue;
    if (!KEY_RE.test(name)) {
      await dir.removeEntry(name).catch(() => undefined);
      continue;
    }
    const size = (await (await dir.getFileHandle(name)).getFile()).size;
    entries.set(name, { bytes: size, used: 0 });
    total += size;
  }

  const save = async (): Promise<void> => {
    putsSinceSave = 0;
    const led: Ledger = { v: 1, seq, entries: [...entries.entries()].map(([k, e]) => [k, e.bytes, e.used]) };
    const w = await (await dir.getFileHandle(LEDGER, { create: true })).createWritable();
    await w.write(new TextEncoder().encode(JSON.stringify(led)));
    await w.close();
  };

  const evict = async (): Promise<void> => {
    if (total <= o.maxBytes) return;
    const order = [...entries.entries()].sort((a, b) => a[1].used - b[1].used);
    for (const [k, e] of order) {
      if (total <= o.maxBytes * 0.9) break;
      entries.delete(k);
      total -= e.bytes;
      await dir.removeEntry(k).catch((err: unknown) => {
        if (!isNotFound(err)) throw err;
      });
    }
    await save();
  };

  return {
    async get(key) {
      const e = entries.get(key);
      if (!e) return null;
      try {
        const f = await (await dir.getFileHandle(key)).getFile();
        if (f.size !== e.bytes) throw new Error(`opfs cache: ${key} holds ${f.size} bytes, the ledger says ${e.bytes}`);
        e.used = ++seq;
        return new Uint8Array(await f.arrayBuffer());
      } catch (err) {
        if (!isNotFound(err)) throw err;
        entries.delete(key);
        total -= e.bytes;
        return null;
      }
    },
    async put(key, bytes) {
      if (!KEY_RE.test(key)) throw new Error(`opfs cache: ${key} is not a content address`);
      if (entries.has(key) || bytes.length > o.maxBytes) return;
      const w = await (await dir.getFileHandle(key, { create: true })).createWritable();
      await w.write(bytes);
      await w.close();
      entries.set(key, { bytes: bytes.length, used: ++seq });
      total += bytes.length;
      if (total > o.maxBytes) await evict();
      else if (++putsSinceSave >= LEDGER_EVERY) await save();
    },
    usage: () => ({ entries: entries.size, bytes: total }),
    flush: save,
  };
}
