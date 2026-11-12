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
 * Integrity: an entry's length is in its key. A file whose size is not that length (a truncated or 0-byte
 * file, whatever left it) is removed at open and is a miss on get. Every error of the cache - a quota error
 * on write, a file removed under it, a broken ledger - is a miss on get and a no-op on put: the cache can make
 * a read slower, never fail it.
 *
 * One owner: the directory and its ledger have one writer across the origin's tabs and workers, the holder of
 * the Web Lock `fsp-opfs-cache:<dir>` (taken when the cache opens, held until `close()` or the end of the
 * context). A context that does not get the lock opens the cache READ-ONLY: it reads entries by key (with the
 * same size check) and its puts are no-ops, so two writers can never evict, adopt or rewrite the ledger
 * against each other. Without the Web Locks API (none in Node) the cache is the owner.
 *
 * Works on the main thread and in workers (createWritable). Node has no OPFS: `openOpfsCache` rejects there.
 */

/** What the pack source needs of a cache. */
export interface ByteCache {
  get(key: string): Promise<Uint8Array | null>;
  put(key: string, bytes: Uint8Array): Promise<void>;
  /** Entries and bytes held (as this context knows them; a read-only cache knows none). */
  usage(): { entries: number; bytes: number };
  /** Write the ledger now. */
  flush(): Promise<void>;
  /** Whether this context owns the cache (holds the lock) or reads it only. */
  readonly mode: 'owner' | 'read-only';
  /** Write the ledger and give up ownership (the next context to open becomes the owner). */
  close(): Promise<void>;
}

export const OPFS_CACHE_DIR = 'fsp-packs';
const LEDGER = 'ledger.json';
const LEDGER_EVERY = 64;
const KEY_RE = /^[0-9a-f]{32}\.\d+\.(\d+)$/;

/** The length an entry's key promises, or null for a name that is not a content address. */
export function keyLength(key: string): number | null {
  const m = KEY_RE.exec(key);
  return m ? Number(m[1]) : null;
}

interface Ledger {
  v: 1;
  seq: number;
  entries: [string, number, number][];
}

/** Minimal shape of the OPFS API used here (the DOM library is not visible to headless code). */
export interface FsWritable {
  write(data: Uint8Array): Promise<void>;
  close(): Promise<void>;
  abort?(reason?: unknown): Promise<void>;
}
export interface FsFileHandle {
  getFile(): Promise<{ arrayBuffer(): Promise<ArrayBuffer>; size: number }>;
  createWritable(): Promise<FsWritable>;
}
export interface FsDirHandle {
  getFileHandle(name: string, o?: { create?: boolean }): Promise<FsFileHandle>;
  getDirectoryHandle(name: string, o?: { create?: boolean }): Promise<FsDirHandle>;
  removeEntry(name: string): Promise<void>;
  keys(): AsyncIterable<string>;
}
interface StorageLike {
  getDirectory(): Promise<FsDirHandle>;
}
/** The part of the Web Locks API used here. */
export interface LockManagerLike {
  request(name: string, options: { ifAvailable: boolean }, callback: (lock: unknown) => Promise<void>): Promise<void>;
}

/** Whether this context has the origin-private file system (a browser page or worker). */
export function opfsAvailable(): boolean {
  const storage = (globalThis as { navigator?: { storage?: StorageLike } }).navigator?.storage;
  return Boolean(storage && typeof storage.getDirectory === 'function');
}

function opfsRoot(): Promise<FsDirHandle> {
  const nav = (globalThis as { navigator?: { storage?: StorageLike } }).navigator;
  const storage = nav?.storage;
  if (!storage || typeof storage.getDirectory !== 'function') {
    return Promise.reject(new Error('opfs cache: the origin-private file system is not available here (a browser page or worker is needed)'));
  }
  return storage.getDirectory();
}

function webLocks(): LockManagerLike | null {
  const locks = (globalThis as { navigator?: { locks?: LockManagerLike } }).navigator?.locks;
  return locks && typeof locks.request === 'function' ? locks : null;
}

/**
 * Take the lock if nobody holds it. Resolves to a release function when taken, to null when another context
 * holds it.
 */
function tryLock(locks: LockManagerLike, name: string): Promise<(() => void) | null> {
  return new Promise((resolve, reject) => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((r) => (release = r));
    locks
      .request(name, { ifAvailable: true }, async (lock) => {
        if (!lock) {
          resolve(null);
          return;
        }
        resolve(release);
        await held; // held until released or the context ends
      })
      .catch(reject);
  });
}

export interface OpfsCacheOptions {
  maxBytes: number;
  dirName?: string;
  /** Injected for tests: the OPFS root and the lock manager (default: the browser's; null = no locking). */
  root?: FsDirHandle;
  locks?: LockManagerLike | null;
}

const noop = (): void => undefined;

export async function openOpfsCache(o: OpfsCacheOptions): Promise<ByteCache> {
  if (!(o.maxBytes > 0)) throw new Error('opfs cache: maxBytes must be positive');
  const root = o.root ?? (await opfsRoot());
  const dirName = o.dirName ?? OPFS_CACHE_DIR;
  const dir = await root.getDirectoryHandle(dirName, { create: true });
  const locks = o.locks === undefined ? webLocks() : o.locks;
  const release = locks ? await tryLock(locks, `fsp-opfs-cache:${dirName}`) : noop;

  /** A file's bytes when its size is the key's length; null for a miss. Never throws. */
  const readChecked = async (key: string): Promise<Uint8Array | null> => {
    try {
      const f = await (await dir.getFileHandle(key)).getFile();
      if (f.size !== keyLength(key)) return null;
      const b = new Uint8Array(await f.arrayBuffer());
      return b.length === keyLength(key) ? b : null;
    } catch {
      return null;
    }
  };

  if (release === null) {
    // Another tab or worker owns the cache: read what it wrote, write nothing.
    return {
      mode: 'read-only',
      get: (key) => (keyLength(key) === null ? Promise.resolve(null) : readChecked(key)),
      put: async () => undefined,
      usage: () => ({ entries: 0, bytes: 0 }),
      flush: async () => undefined,
      close: async () => undefined,
    };
  }

  const entries = new Map<string, { bytes: number; used: number }>();
  let seq = 0;
  let total = 0;
  let putsSinceSave = 0;
  const remove = (name: string): Promise<void> => dir.removeEntry(name).catch(() => undefined);

  // Read the ledger (a broken one is ignored: the files are adopted below); keep only entries whose length
  // agrees with their key.
  try {
    const f = await (await dir.getFileHandle(LEDGER)).getFile();
    const led = JSON.parse(new TextDecoder().decode(await f.arrayBuffer())) as Ledger;
    if (led.v === 1 && Array.isArray(led.entries)) {
      seq = Number(led.seq) || 0;
      for (const [k, b, u] of led.entries) if (keyLength(k) === b && b > 0) entries.set(k, { bytes: b, used: u });
    }
  } catch {
    // no ledger yet, or an unreadable one
  }
  // Every file of the directory: entries whose size is not their key's length are removed (a truncated or
  // 0-byte file); entries the ledger does not know (written after its last save; OPFS commits a file on close)
  // are adopted as the least recently used; anything else is removed.
  const seen = new Set<string>();
  try {
    for await (const name of dir.keys()) {
      if (name === LEDGER) continue;
      const want = keyLength(name);
      if (want === null || want === 0) {
        await remove(name);
        continue;
      }
      let size = -1;
      try {
        size = (await (await dir.getFileHandle(name)).getFile()).size;
      } catch {
        // unreadable: removed below
      }
      if (size !== want) {
        entries.delete(name);
        await remove(name);
        continue;
      }
      seen.add(name);
      if (!entries.has(name)) entries.set(name, { bytes: size, used: 0 });
    }
  } catch {
    // a listing that fails part-way: what was seen is kept
  }
  // Ledger entries without a file are gone.
  for (const k of [...entries.keys()]) if (!seen.has(k)) entries.delete(k);
  for (const e of entries.values()) total += e.bytes;

  const save = async (): Promise<void> => {
    putsSinceSave = 0;
    try {
      const led: Ledger = { v: 1, seq, entries: [...entries.entries()].map(([k, e]) => [k, e.bytes, e.used]) };
      const w = await (await dir.getFileHandle(LEDGER, { create: true })).createWritable();
      try {
        await w.write(new TextEncoder().encode(JSON.stringify(led)));
        await w.close();
      } catch (e) {
        await w.abort?.(e).catch(noop);
        throw e;
      }
    } catch {
      // A ledger that cannot be written (quota): the files are adopted at the next open.
    }
  };

  const evictTo = async (limit: number): Promise<void> => {
    const order = [...entries.entries()].sort((a, b) => a[1].used - b[1].used);
    for (const [k, e] of order) {
      if (total <= limit) break;
      entries.delete(k);
      total -= e.bytes;
      await remove(k);
    }
    await save();
  };

  const drop = async (key: string): Promise<void> => {
    const e = entries.get(key);
    if (e) {
      entries.delete(key);
      total -= e.bytes;
    }
    await remove(key);
  };

  let closed = false;
  return {
    mode: 'owner',
    async get(key) {
      if (closed || !entries.has(key)) return null;
      const b = await readChecked(key);
      if (!b) {
        await drop(key);
        return null;
      }
      const e = entries.get(key);
      if (e) e.used = ++seq;
      return b;
    },
    async put(key, bytes) {
      if (closed || keyLength(key) !== bytes.length || bytes.length === 0 || entries.has(key) || bytes.length > o.maxBytes) return;
      try {
        const w = await (await dir.getFileHandle(key, { create: true })).createWritable();
        try {
          await w.write(bytes);
          await w.close();
        } catch (e) {
          await w.abort?.(e).catch(noop);
          throw e;
        }
      } catch {
        // Quota or any other write error: no entry. Make room for the next one and leave no partial file.
        await remove(key);
        await evictTo(Math.min(total, o.maxBytes) * 0.75).catch(noop);
        return;
      }
      entries.set(key, { bytes: bytes.length, used: ++seq });
      total += bytes.length;
      if (total > o.maxBytes) await evictTo(o.maxBytes * 0.9);
      else if (++putsSinceSave >= LEDGER_EVERY) await save();
    },
    usage: () => ({ entries: entries.size, bytes: total }),
    flush: save,
    async close() {
      if (closed) return;
      await save();
      closed = true;
      release();
    },
  };
}
