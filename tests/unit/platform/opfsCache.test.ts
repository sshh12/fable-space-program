/**
 * The OPFS cache on an in-memory stand-in of the origin-private file system and of Web Locks (Node has
 * neither): entries whose size is not their key's length, quota errors, a broken ledger, and two contexts
 * (two workers or two tabs) opening the same directory. The real OPFS is exercised by
 * tests/browser/platform/packs.spec.ts.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createFsTileSource } from '../../../src/terrain/fsTileSource';
import { openOpfsCache, type FsDirHandle, type FsFileHandle, type FsWritable, type LockManagerLike } from '../../../src/terrain/opfsCache';
import { createPackTileSource } from '../../../src/terrain/packSource';
import { createLocalPackFetch, LOCAL_PACK_LIST_URL } from '../../../tools/pack/localPacks';
import { packSet } from '../../../tools/pack/packer';
import { syntheticTileRoot } from '../../../tools/terrain-core/fixtures';

const notFound = (): Error => Object.assign(new Error('not found'), { name: 'NotFoundError' });

/** A directory of files that commit on close, as OPFS does; `quota` bounds the bytes it holds. */
class MemDir implements FsDirHandle {
  files = new Map<string, Uint8Array>();
  dirs = new Map<string, MemDir>();
  quota = Infinity;
  writes = 0;
  used(): number {
    let n = 0;
    for (const b of this.files.values()) n += b.length;
    return n;
  }
  async getFileHandle(name: string, o?: { create?: boolean }): Promise<FsFileHandle> {
    if (!this.files.has(name)) {
      if (!o?.create) throw notFound();
      this.files.set(name, new Uint8Array(0));
    }
    const dir = this;
    return {
      async getFile() {
        const b = dir.files.get(name);
        if (!b) throw notFound();
        return { size: b.length, arrayBuffer: async () => b.slice().buffer };
      },
      async createWritable(): Promise<FsWritable> {
        const parts: Uint8Array[] = [];
        return {
          async write(data: Uint8Array) {
            const pending = parts.reduce((a, p) => a + p.length, 0) + data.length;
            if (dir.used() - (dir.files.get(name)?.length ?? 0) + pending > dir.quota) throw Object.assign(new Error('quota'), { name: 'QuotaExceededError' });
            parts.push(data.slice());
          },
          async close() {
            const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
            let o = 0;
            for (const p of parts) {
              out.set(p, o);
              o += p.length;
            }
            dir.files.set(name, out);
            dir.writes++;
          },
          async abort() {
            parts.length = 0;
          },
        };
      },
    };
  }
  async getDirectoryHandle(name: string, o?: { create?: boolean }): Promise<FsDirHandle> {
    let d = this.dirs.get(name);
    if (!d) {
      if (!o?.create) throw notFound();
      this.dirs.set(name, (d = new MemDir()));
    }
    return d;
  }
  async removeEntry(name: string): Promise<void> {
    if (!this.files.delete(name)) throw notFound();
  }
  async *keys(): AsyncIterable<string> {
    for (const k of [...this.files.keys()]) yield k;
  }
}

/** Web Locks with `ifAvailable`: a held name is refused to the next caller. */
function memLocks(): LockManagerLike & { held: Set<string> } {
  const held = new Set<string>();
  return {
    held,
    async request(name, _o, cb) {
      if (held.has(name)) return cb(null);
      held.add(name);
      try {
        await cb({ name });
      } finally {
        held.delete(name);
      }
    },
  };
}

const H = 'a'.repeat(32);
const key = (offset: number, length: number): string => `${H}.${offset}.${length}`;
const bytes = (n: number, v = 7): Uint8Array => new Uint8Array(n).fill(v);

describe('the OPFS cache', () => {
  it('a truncated or 0-byte entry is removed at open and is a miss on get', async () => {
    const root = new MemDir();
    const locks = memLocks();
    const c = await openOpfsCache({ maxBytes: 1e6, root, locks });
    await c.put(key(0, 100), bytes(100));
    await c.put(key(100, 50), bytes(50));
    await c.flush();
    await c.close();
    const dir = root.dirs.get('fsp-packs')!;
    // Something cut one file short and left another empty (a crash, the browser clearing storage part-way).
    dir.files.set(key(0, 100), bytes(60));
    dir.files.set(key(500, 10), new Uint8Array(0));
    const c2 = await openOpfsCache({ maxBytes: 1e6, root, locks });
    expect(c2.mode).toBe('owner');
    expect(await c2.get(key(0, 100))).toBeNull();
    expect(dir.files.has(key(0, 100))).toBe(false);
    expect(dir.files.has(key(500, 10))).toBe(false);
    expect(c2.usage()).toEqual({ entries: 1, bytes: 50 });
    expect(await c2.get(key(100, 50))).toEqual(bytes(50));
    // A file cut short while the cache is open is a miss too, and is dropped.
    dir.files.set(key(100, 50), bytes(49));
    expect(await c2.get(key(100, 50))).toBeNull();
    expect(c2.usage()).toEqual({ entries: 0, bytes: 0 });
    // A put whose bytes are not the key's length is refused (no entry).
    await c2.put(key(0, 10), bytes(9));
    expect(await c2.get(key(0, 10))).toBeNull();
  });

  it('a quota error on write is a no-op: no entry, no partial file, room made for the next one; a ledger that cannot be written is ignored', async () => {
    const root = new MemDir();
    const c = await openOpfsCache({ maxBytes: 1e6, root, locks: null });
    const dir = root.dirs.get('fsp-packs')!;
    for (let i = 0; i < 4; i++) await c.put(key(i * 100, 100), bytes(100, i));
    dir.quota = 450; // the browser's quota for the origin is less than the cache's budget
    await expect(c.put(key(1000, 100), bytes(100))).resolves.toBeUndefined();
    expect(dir.files.has(key(1000, 100))).toBe(false);
    expect(await c.get(key(1000, 100))).toBeNull();
    // the oldest entries were let go to make room
    expect(c.usage().bytes).toBeLessThanOrEqual(300);
    await expect(c.put(key(2000, 100), bytes(100, 9))).resolves.toBeUndefined();
    expect(await c.get(key(2000, 100))).toEqual(bytes(100, 9));
    dir.quota = 0;
    await expect(c.flush()).resolves.toBeUndefined();
  });

  it('through the pack source: a cache whose every call throws, or that never opened, is a miss, never a failed read', async () => {
    const tiles = await syntheticTileRoot();
    const packs = fs.mkdtempSync(path.join(os.tmpdir(), 'fsp-opfs-'));
    try {
      await packSet({ dir: path.join(tiles, 'fixture-moon'), set: 'fixture-moon', type: 'tiles', out: packs });
      const k = { face: 1 as const, level: 1, x: 0, y: 1 };
      const want = await createFsTileSource(tiles).tile('fixture-moon', 'height', k);
      const broken = { mode: 'owner' as const, get: async () => Promise.reject(new Error('boom')), put: async () => Promise.reject(new Error('boom')), usage: () => ({ entries: 0, bytes: 0 }), flush: async () => undefined, close: async () => undefined };
      for (const cache of [broken, Promise.reject(new Error('no opfs'))]) {
        const src = createPackTileSource({ packListUrl: LOCAL_PACK_LIST_URL, fetch: createLocalPackFetch(packs), cache });
        const got = await src.tile('fixture-moon', 'height', k);
        expect(Buffer.from(got!).equals(Buffer.from(want!))).toBe(true);
        expect(src.stats().cacheErrors).toBeGreaterThan(0);
        expect(src.stats().fromNetwork).toBeGreaterThan(0);
      }
    } finally {
      fs.rmSync(packs, { recursive: true, force: true });
    }
  });

  it('two contexts (two workers, two tabs): one owner writes, the other reads what it wrote and writes nothing', async () => {
    const root = new MemDir();
    const locks = memLocks();
    const a = await openOpfsCache({ maxBytes: 1000, root, locks });
    const b = await openOpfsCache({ maxBytes: 1000, root, locks });
    expect(a.mode).toBe('owner');
    expect(b.mode).toBe('read-only');
    await a.put(key(0, 100), bytes(100, 1));
    expect(await b.get(key(0, 100))).toEqual(bytes(100, 1));
    const writesBefore = root.dirs.get('fsp-packs')!.writes;
    await b.put(key(100, 100), bytes(100, 2));
    await b.flush();
    expect(root.dirs.get('fsp-packs')!.writes).toBe(writesBefore);
    expect(await a.get(key(100, 100))).toBeNull();
    // The owner evicts under the reader: the reader sees a miss, not an error.
    for (let i = 1; i <= 12; i++) await a.put(key(i * 1000, 100), bytes(100, 3));
    expect(await b.get(key(0, 100))).toBeNull();
    // Ownership passes on when the owner closes (or its context ends).
    await a.close();
    await new Promise((r) => setTimeout(r, 0)); // the lock is let go when the owner's callback returns
    const c = await openOpfsCache({ maxBytes: 1000, root, locks });
    expect(c.mode).toBe('owner');
    expect(c.usage().entries).toBeGreaterThan(0);
  });
});
