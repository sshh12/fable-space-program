/**
 * Tile packs on synthetic terrain (CI has no baked tiles): the packer, the index, the pack source in every
 * mode (whole packs on disk, bucket ranges with real SigV4 presigned URLs, mirror ranges, mirror slices),
 * request coalescing, the failover rules and incremental packing.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TileManifest, TileSource } from '../../../src/core/contracts/terrain';
import { layerHasTile } from '../../../src/core/contracts/terrain';
import type { FaceId, TileKey } from '../../../src/core/geo/cubeSphere';
import { createFsTileSource } from '../../../src/terrain/fsTileSource';
import { createPackTileSource, type PackTileSource } from '../../../src/terrain/packSource';
import type { PackList } from '../../../src/terrain/packIndex';
import { startBucketStandIn, type StandIn } from '../../../deploy/local/bucketStandIn';
import { createPackListService, packSetsFromDir } from '../../../deploy/packs/packList';
import { createLocalPackFetch, LOCAL_PACK_LIST_URL } from '../../../tools/pack/localPacks';
import { packSet, readCurrent, type PackResult } from '../../../tools/pack/packer';
import { assertReleasable, verifySetBytes } from '../../../tools/pack/verify';
import { syntheticTileRoot } from '../../../tools/terrain-core/fixtures';

const SETS = ['fixture-earth', 'fixture-moon'];
const SMALL = { minBytes: 48 * 1024, maxBytes: 160 * 1024, cutModulus: 4, smallSetBytes: 0 };
const CREDS = { accessKeyId: 'stand-in-key', secretAccessKey: 'stand-in-secret' };
const DAY = 86400_000;

let tileRoot: string;
let out: string;
let standIn: StandIn;
const results: Record<string, PackResult> = {};
let clock = Date.UTC(2026, 10, 12, 15, 0, 0);

/** Every promised tile of a tile set (all layers), in a fixed order. */
async function promisedTiles(fsSource: TileSource, set: string): Promise<{ layer: string; key: TileKey }[]> {
  const m: TileManifest = await fsSource.manifest(set);
  const out: { layer: string; key: TileKey }[] = [];
  for (const [layer, lm] of Object.entries(m.layers)) {
    let maxL = lm.globalMaxLevel;
    for (const l of Object.keys(lm.coverage)) maxL = Math.max(maxL, Number(l));
    for (let level = 0; level <= maxL; level++) {
      const side = 2 ** level;
      for (let face = 0; face < 6; face++) {
        for (let y = 0; y < side; y++) {
          for (let x = 0; x < side; x++) {
            const key = { face: face as FaceId, level, x, y };
            if (layerHasTile(lm, key)) out.push({ layer, key });
          }
        }
      }
    }
  }
  return out;
}

function countingFetch(packList: () => Promise<PackList>, inner: typeof fetch = fetch): { fetch: typeof fetch; urls: string[] } {
  const urls: string[] = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    urls.push(url);
    if (url.endsWith('/packs.json')) return new Response(JSON.stringify(await packList()), { status: 200, headers: { 'Content-Type': 'application/json' } });
    return inner(input, init);
  }) as typeof fetch;
  return { fetch: f, urls };
}

function listService(order: ('bucket' | 'mirror')[], mode: 'ranges' | 'slices', sliceBytes = 64 * 1024) {
  return createPackListService({
    bucket: { bucket: 'packs', endpoint: standIn.url, region: 'us-east-1', ...CREDS, pathStyle: true },
    mirror: { base: `${standIn.url}/m/p/`, mode, sliceBytes },
    order,
    sets: () => packSetsFromDir(out),
    now: () => clock,
  });
}

async function sweep(src: TileSource, fsSource: TileSource, set: string, batch = 200): Promise<number> {
  const tiles = await promisedTiles(fsSource, set);
  expect(await src.manifest(set)).toEqual(await fsSource.manifest(set));
  for (let i = 0; i < tiles.length; i += batch) {
    const part = tiles.slice(i, i + batch);
    const [a, b] = await Promise.all([Promise.all(part.map((t) => src.tile(set, t.layer, t.key))), Promise.all(part.map((t) => fsSource.tile(set, t.layer, t.key)))]);
    for (let j = 0; j < part.length; j++) {
      expect(a[j], `${set} ${part[j]!.layer} ${JSON.stringify(part[j]!.key)}`).not.toBeNull();
      expect(Buffer.from(a[j]!).equals(Buffer.from(b[j]!)), `${set} ${part[j]!.layer} ${JSON.stringify(part[j]!.key)}`).toBe(true);
    }
  }
  return tiles.length;
}

beforeAll(async () => {
  tileRoot = await syntheticTileRoot();
  out = fs.mkdtempSync(path.join(os.tmpdir(), 'fsp-packs-'));
  for (const set of SETS) results[set] = await packSet({ dir: path.join(tileRoot, set), set, type: 'tiles', out, ...SMALL });
  standIn = await startBucketStandIn({ packsDir: out, bucket: 'packs', ...CREDS, now: () => clock });
}, 120_000);

afterAll(async () => {
  await standIn?.close();
  fs.rmSync(out, { recursive: true, force: true });
});

describe('the packer', () => {
  it('writes content-addressed packs within the size bounds, height apart from the other layers', () => {
    for (const set of SETS) {
      const r = results[set]!;
      expect(r.packs.length).toBeGreaterThan(2);
      for (const p of r.packs) {
        expect(p.hash).toMatch(/^[0-9a-f]{32}$/);
        expect(fs.statSync(path.join(out, set, `${p.hash}.pack`)).size).toBe(p.bytes);
        expect(p.bytes).toBeLessThanOrEqual(SMALL.maxBytes);
      }
      expect(readCurrent(out, set)!.index).toBe(r.index);
    }
  });

  it('is deterministic: the same tiles give the same pack and index names in another directory', async () => {
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'fsp-packs-b-'));
    try {
      const r = await packSet({ dir: path.join(tileRoot, 'fixture-moon'), set: 'fixture-moon', type: 'tiles', out: other, ...SMALL });
      expect(r.index).toBe(results['fixture-moon']!.index);
      expect(r.packs).toEqual(results['fixture-moon']!.packs);
    } finally {
      fs.rmSync(other, { recursive: true, force: true });
    }
  });

  it('is incremental: a re-run over unchanged tiles reads no tile and writes nothing; a changed tile rewrites only its own pack', async () => {
    const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'fsp-tiles-'));
    const outB = fs.mkdtempSync(path.join(os.tmpdir(), 'fsp-packs-c-'));
    try {
      fs.cpSync(path.join(tileRoot, 'fixture-earth'), path.join(copy, 'fixture-earth'), { recursive: true, preserveTimestamps: true });
      const dir = path.join(copy, 'fixture-earth');
      const first = await packSet({ dir, set: 'fixture-earth', type: 'tiles', out: outB, ...SMALL });
      const again = await packSet({ dir, set: 'fixture-earth', type: 'tiles', out: outB, ...SMALL });
      expect(again.written).toEqual([]);
      expect(again.filesRead).toBe(again.files); // the plain files only
      expect(again.index).toBe(first.index);
      // Re-bake one deep tile with other bytes of the same length.
      const victim = path.join(dir, 'height', '1', '5', '0', '0.hgt');
      const target = fs.existsSync(victim) ? victim : path.join(dir, 'height', '0', '2', '0', '0.hgt');
      const b = fs.readFileSync(target);
      b[b.length - 1] = b[b.length - 1]! ^ 0xff;
      fs.writeFileSync(target, b);
      const third = await packSet({ dir, set: 'fixture-earth', type: 'tiles', out: outB, ...SMALL });
      expect(third.written.length).toBe(1);
      expect(third.packs.length).toBe(first.packs.length);
      const changed = third.packs.filter((p, i) => p.hash !== first.packs[i]!.hash);
      expect(changed.length).toBe(1);
      expect(third.index).not.toBe(first.index);
    } finally {
      fs.rmSync(copy, { recursive: true, force: true });
      fs.rmSync(outB, { recursive: true, force: true });
    }
  }, 60_000);
});

describe('byte verification and the release check (tools/pack/verify.ts)', () => {
  it('a clean set verifies in whole-pack mode and may be released; a changed pack byte or a newer bake may not', async () => {
    const packs = fs.mkdtempSync(path.join(os.tmpdir(), 'fsp-packs-v-'));
    const src = fs.mkdtempSync(path.join(os.tmpdir(), 'fsp-tiles-v-'));
    try {
      const sourceDir = path.join(src, 'fixture-moon');
      fs.cpSync(path.join(tileRoot, 'fixture-moon'), sourceDir, { recursive: true, preserveTimestamps: true });
      const r = await packSet({ dir: sourceDir, set: 'fixture-moon', type: 'tiles', out: packs, ...SMALL });
      // released before any verification: refused
      expect(() => assertReleasable(packs, 'fixture-moon', sourceDir)).toThrow(/no clean byte verification/);
      const v = await verifySetBytes({ packsDir: packs, sourceDir, set: 'fixture-moon' });
      expect(v.mismatches).toEqual([]);
      expect(v.tiles).toBeGreaterThan(100);
      expect(v.files).toBeGreaterThan(0);
      expect(v.index).toBe(r.index);
      expect(assertReleasable(packs, 'fixture-moon', sourceDir).index).toBe(r.index);
      // One byte of one pack changed on disk (what a bad reuse of an old chunk would look like).
      const victim = path.join(packs, 'fixture-moon', `${r.packs[1]!.hash}.pack`);
      const b = fs.readFileSync(victim);
      b[Math.floor(b.length / 2)] = b[Math.floor(b.length / 2)]! ^ 0xff;
      fs.writeFileSync(victim, b);
      const bad = await verifySetBytes({ packsDir: packs, sourceDir, set: 'fixture-moon' });
      expect(bad.mismatches.length).toBeGreaterThan(0);
      expect(() => assertReleasable(packs, 'fixture-moon', sourceDir)).toThrow(/no clean byte verification/);
      b[Math.floor(b.length / 2)] = b[Math.floor(b.length / 2)]! ^ 0xff;
      fs.writeFileSync(victim, b);
      expect((await verifySetBytes({ packsDir: packs, sourceDir, set: 'fixture-moon' })).mismatches).toEqual([]);
      // The tile set re-baked since it was packed: its manifest has another contentHash.
      const mf = path.join(sourceDir, 'manifest.json');
      const m = JSON.parse(fs.readFileSync(mf, 'utf8')) as { contentHash: string };
      fs.writeFileSync(mf, JSON.stringify({ ...m, contentHash: 'f'.repeat(16) }));
      expect(() => assertReleasable(packs, 'fixture-moon', sourceDir)).toThrow(/packed from contentHash .* the tile set is now f{16}: repack/);
      expect((await verifySetBytes({ packsDir: packs, sourceDir, set: 'fixture-moon' })).mismatches.some((x) => /manifest|contentHash/.test(x))).toBe(true);
    } finally {
      fs.rmSync(packs, { recursive: true, force: true });
      fs.rmSync(src, { recursive: true, force: true });
    }
  }, 60_000);
});

describe('the pack source returns the bytes of the fs source for every tile', () => {
  const fsSource = (): TileSource => createFsTileSource(tileRoot);

  it('whole packs on disk', async () => {
    const src = createPackTileSource({ packListUrl: LOCAL_PACK_LIST_URL, fetch: createLocalPackFetch(out) });
    for (const set of SETS) expect(await sweep(src, fsSource(), set)).toBeGreaterThan(100);
  }, 60_000);

  for (const [name, order, mode] of [
    ['bucket ranges (presigned)', ['bucket', 'mirror'], 'ranges'],
    ['mirror ranges', ['mirror'], 'ranges'],
    ['mirror slices', ['mirror'], 'slices'],
  ] as const) {
    it(name, async () => {
      const svc = listService([...order], mode);
      const { fetch: f } = countingFetch(() => svc.get());
      const src = createPackTileSource({ packListUrl: `${standIn.url}/packs.json`, fetch: f });
      for (const set of SETS) await sweep(src, fsSource(), set);
      expect(src.stats().failures).toEqual({});
    }, 60_000);
  }

  it('plain files of a set (globals, the manifest) and byte ranges of them', async () => {
    const src = createPackTileSource({ packListUrl: LOCAL_PACK_LIST_URL, fetch: createLocalPackFetch(out) });
    const raw = fs.readFileSync(path.join(tileRoot, 'fixture-earth', 'manifest.json'));
    expect(Buffer.from(await src.file('fixture-earth', 'manifest.json')).equals(raw)).toBe(true);
    expect(Buffer.from(await src.fileRange('fixture-earth', 'manifest.json', 10, 20)).equals(raw.subarray(10, 30))).toBe(true);
  });
});

describe('requests', () => {
  it('neighbouring tiles asked for together are coalesced into few ranges', async () => {
    // Packs of a realistic size relative to the tiles (the fixture's 160 kB packs hold one or two groups).
    const big = fs.mkdtempSync(path.join(os.tmpdir(), 'fsp-packs-d-'));
    await packSet({ dir: path.join(tileRoot, 'fixture-earth'), set: 'fixture-earth', type: 'tiles', out: big, minBytes: 2e6, maxBytes: 8e6, cutModulus: 64 });
    const { fetch: f, urls } = countingFetch(async () => (await import('../../../tools/pack/localPacks')).localPackList(big), createLocalPackFetch(big));
    const src = createPackTileSource({ packListUrl: LOCAL_PACK_LIST_URL, fetch: f });
    const fsSrc = createFsTileSource(tileRoot);
    const tiles = (await promisedTiles(fsSrc, 'fixture-earth')).filter((t) => t.key.level === 2);
    await src.manifest('fixture-earth');
    const before = urls.length;
    await Promise.all(tiles.map((t) => src.tile('fixture-earth', t.layer, t.key)));
    const requests = urls.length - before;
    expect(tiles.length).toBeGreaterThan(50);
    expect(requests * 5).toBeLessThanOrEqual(tiles.length);
    fs.rmSync(big, { recursive: true, force: true });
  });

  it('a slice is fetched once for all the tiles inside it, and sends at most 1.5 bytes per byte needed', async () => {
    const svc = listService(['mirror'], 'slices');
    const { fetch: f, urls } = countingFetch(() => svc.get());
    const src = createPackTileSource({ packListUrl: `${standIn.url}/packs.json`, fetch: f });
    const tiles = (await promisedTiles(createFsTileSource(tileRoot), 'fixture-moon')).filter((t) => t.key.level <= 2);
    for (const t of tiles) await src.tile('fixture-moon', t.layer, t.key); // one at a time: no batching help
    const sliceUrls = urls.filter((u) => /\/m\/p\/[0-9a-f]{32}\/65536\/\d+$/.test(u));
    expect(sliceUrls.length).toBeGreaterThan(0);
    expect(new Set(sliceUrls).size).toBe(sliceUrls.length);
    const st = src.stats();
    expect(st.bytesReceived.mirror! / st.bytesNeeded).toBeLessThanOrEqual(1.5);
  });
});

describe('failover', () => {
  const tile = { layer: 'height', key: { face: 0 as FaceId, level: 1, x: 1, y: 0 } };
  const fresh = async (svcOrder: ('bucket' | 'mirror')[] = ['bucket', 'mirror']): Promise<{ src: PackTileSource; urls: string[] }> => {
    const svc = listService(svcOrder, 'slices');
    const { fetch: f, urls } = countingFetch(() => svc.get());
    const src = createPackTileSource({ packListUrl: `${standIn.url}/packs.json`, fetch: f });
    await src.manifest('fixture-moon');
    return { src, urls };
  };
  const expected = (): Promise<Uint8Array | null> => createFsTileSource(tileRoot).tile('fixture-moon', tile.layer, tile.key);

  for (const status of [429, 500, 503, 404]) {
    it(`moves to the mirror when the bucket answers ${status}`, async () => {
      const { src } = await fresh();
      standIn.addFaults([{ target: 'bucket', status, count: 1 }]);
      const got = await src.tile('fixture-moon', tile.layer, tile.key);
      expect(Buffer.from(got!).equals(Buffer.from((await expected())!))).toBe(true);
      const s = src.stats();
      expect(s.failures.bucket?.[status === 404 ? '404' : status === 429 ? '429' : '5xx']).toBe(1);
      expect(s.requests.mirror).toBeGreaterThan(0);
      standIn.clearFaults();
    });
  }

  it('an expired signature: the pack list is fetched once more and the bucket is used with the new URL', async () => {
    const svc = listService(['bucket', 'mirror'], 'slices');
    const real = clock;
    clock = real - 8 * DAY; // the first list is signed eight days ago: its URLs expired yesterday
    let lists = 0;
    const { fetch: f } = countingFetch(async () => {
      lists++;
      const l = await svc.get();
      clock = real; // whatever is signed next is today's
      return l;
    });
    const src = createPackTileSource({ packListUrl: `${standIn.url}/packs.json`, fetch: f });
    try {
      const got = await src.tile('fixture-moon', tile.layer, tile.key);
      expect(Buffer.from(got!).equals(Buffer.from((await expected())!))).toBe(true);
      const s = src.stats();
      expect(lists).toBe(2);
      expect(s.failures.bucket?.['403']).toBe(1);
      expect(s.requests.mirror ?? 0).toBe(0);
    } finally {
      clock = real;
    }
  });

  it('a 403 that persists after one refresh moves to the mirror', async () => {
    const { src } = await fresh();
    standIn.addFaults([{ target: 'bucket', status: 403, count: 2 }]);
    const got = await src.tile('fixture-moon', tile.layer, tile.key);
    expect(Buffer.from(got!).equals(Buffer.from((await expected())!))).toBe(true);
    const s = src.stats();
    expect(s.failures.bucket?.['403']).toBe(2);
    expect(s.packListLoads).toBe(2);
    expect(s.requests.mirror).toBeGreaterThan(0);
    standIn.clearFaults();
  });

  it('every mirror failing rejects with what each one said', async () => {
    const { src } = await fresh();
    standIn.addFaults([
      { target: 'bucket', status: 500, count: 1 },
      { target: 'mirror', status: 429, count: 10 },
    ]);
    await expect(src.tile('fixture-moon', tile.layer, tile.key)).rejects.toThrow(/failed on every mirror.*bucket: HTTP 500.*mirror: 429/);
    standIn.clearFaults();
  });

  it('a body of the wrong length is a mirror fault, not data', async () => {
    const svc = listService(['bucket', 'mirror'], 'slices');
    const { fetch: f } = countingFetch(
      () => svc.get(),
      async (input, init) => {
        const r = await fetch(input, init);
        const url = typeof input === 'string' ? input : (input as Request).url;
        if (url.includes('/packs/p/') && r.status === 206) return new Response((await r.arrayBuffer()).slice(1), { status: 206 });
        return r;
      },
    );
    const src = createPackTileSource({ packListUrl: `${standIn.url}/packs.json`, fetch: f });
    const got = await src.tile('fixture-moon', tile.layer, tile.key);
    expect(Buffer.from(got!).equals(Buffer.from((await expected())!))).toBe(true);
    expect(src.stats().failures.bucket?.length).toBeGreaterThan(0);
  });

  it('a 403 that persists after the refresh puts the bucket behind the mirror for the next reads', async () => {
    const { src } = await fresh();
    standIn.addFaults([{ target: 'bucket', status: 403, count: 2 }]);
    await src.tile('fixture-moon', tile.layer, tile.key);
    const bucketAfterFirst = src.stats().requests.bucket ?? 0;
    const other = { face: 3 as FaceId, level: 1, x: 0, y: 1 };
    const got = await src.tile('fixture-moon', 'height', other);
    const want = await createFsTileSource(tileRoot).tile('fixture-moon', 'height', other);
    expect(Buffer.from(got!).equals(Buffer.from(want!))).toBe(true);
    // the second read went to the mirror first: no further bucket request
    expect(src.stats().requests.bucket ?? 0).toBe(bucketAfterFirst);
    standIn.clearFaults();
  });

  it("a network error on the bucket's presigned URLs refreshes the list once and retries the bucket (its 403 has no CORS headers)", async () => {
    const svc = listService(['bucket', 'mirror'], 'slices');
    let failed = 0;
    const { fetch: f } = countingFetch(
      () => svc.get(),
      async (input, init) => {
        const url = typeof input === 'string' ? input : (input as Request).url;
        if (url.includes('/packs/p/') && failed === 0) {
          failed++;
          throw new TypeError('fetch failed'); // what a page sees of a 403 without CORS headers
        }
        return fetch(input, init);
      },
    );
    const src = createPackTileSource({ packListUrl: `${standIn.url}/packs.json`, fetch: f });
    const got = await src.tile('fixture-moon', tile.layer, tile.key);
    expect(Buffer.from(got!).equals(Buffer.from((await expected())!))).toBe(true);
    const s = src.stats();
    expect(failed).toBe(1);
    expect(s.failures.bucket?.network).toBe(1);
    expect(s.packListLoads).toBe(2);
    expect(s.requests.mirror ?? 0).toBe(0);
  });

  it('keeps at most 24 requests in flight however many tiles are asked for at once', async () => {
    const svc = listService(['mirror'], 'ranges');
    let inFlight = 0;
    let peak = 0;
    const { fetch: f } = countingFetch(
      () => svc.get(),
      async (input, init) => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        try {
          await new Promise((r) => setTimeout(r, 15));
          return await fetch(input, init);
        } finally {
          inFlight--;
        }
      },
    );
    // No coalescing: every tile is a request of its own.
    const src = createPackTileSource({ packListUrl: `${standIn.url}/packs.json`, fetch: f, coalesceGapBytes: 0, maxRangeBytes: 1 });
    const tiles = (await promisedTiles(createFsTileSource(tileRoot), 'fixture-moon')).filter((t) => t.key.level >= 2).slice(0, 200);
    await src.manifest('fixture-moon');
    peak = 0;
    const got = await Promise.all(tiles.map((t) => src.tile('fixture-moon', t.layer, t.key)));
    expect(got.every((b) => b !== null)).toBe(true);
    expect(tiles.length).toBeGreaterThan(100);
    expect(peak).toBeLessThanOrEqual(24);
    expect(peak).toBeGreaterThanOrEqual(20);
  });

  it("a request's time allowance grows with its bytes", async () => {
    const svc = listService(['mirror'], 'ranges');
    const slow = (ms: number): typeof fetch =>
      countingFetch(
        () => svc.get(),
        async (input, init) => {
          const url = typeof input === 'string' ? input : (input as Request).url;
          if (url.includes('/m/p/')) await new Promise((r) => setTimeout(r, ms));
          return fetch(input, init);
        },
      ).fetch;
    // 40 ms base: a 300 ms answer fails at 1 GB/s (no allowance for bytes) and passes at 100 B/s (a tile of
    // 40 bytes is then allowed 440 ms).
    const fast = createPackTileSource({ packListUrl: `${standIn.url}/packs.json`, fetch: slow(300), timeoutMs: 40, minBytesPerSecond: 1e9 });
    await expect(fast.tile('fixture-moon', tile.layer, tile.key)).rejects.toThrow(/failed on every mirror/);
    expect(fast.stats().failures.mirror?.timeout).toBeGreaterThan(0);
    const scaled = createPackTileSource({ packListUrl: `${standIn.url}/packs.json`, fetch: slow(300), timeoutMs: 40, minBytesPerSecond: 100 });
    const got = await scaled.tile('fixture-moon', tile.layer, tile.key);
    expect(Buffer.from(got!).equals(Buffer.from((await expected())!))).toBe(true);
  });
});

describe('a refreshed pack list', () => {
  it('naming another index object for a set (a release) makes the source read the set again from it', async () => {
    const alt = fs.mkdtempSync(path.join(os.tmpdir(), 'fsp-packs-rel-'));
    try {
      fs.cpSync(path.join(out, 'fixture-moon'), path.join(alt, 'fixture-moon'), { recursive: true });
      const before = readCurrent(alt, 'fixture-moon')!;
      // The "release": the same tiles packed with other bounds, so other packs and another index object.
      const after = await packSet({ dir: path.join(tileRoot, 'fixture-moon'), set: 'fixture-moon', type: 'tiles', out: alt, minBytes: 300 * 1024, maxBytes: 1024 * 1024, cutModulus: 8, smallSetBytes: 0 });
      expect(after.index).not.toBe(before.index);
      let now = Date.UTC(2026, 10, 12, 15, 0, 0);
      let release = false;
      const doc = (index: string, indexBytes: number): PackList => ({ v: 1, signedDay: null, refreshAfterS: 60, mirrors: [{ id: 'local', mode: 'ranges', base: 'http://local.packs.invalid/p/' }], sets: { 'fixture-moon': { index, indexBytes } } });
      const { fetch: f, urls } = countingFetch(async () => (release ? doc(after.index, after.indexBytes) : doc(before.index, before.indexBytes)), createLocalPackFetch(alt));
      const src = createPackTileSource({ packListUrl: LOCAL_PACK_LIST_URL, fetch: f, now: () => now });
      const want = await expected();
      expect(Buffer.from((await src.tile('fixture-moon', tile.layer, tile.key))!).equals(Buffer.from(want!))).toBe(true);
      expect(urls.some((u) => u.includes(after.index))).toBe(false);
      release = true;
      now += 61_000; // the list is older than its refreshAfterS: read again on the next use
      const other = { face: 2 as FaceId, level: 1, x: 1, y: 1 };
      const got = await src.tile('fixture-moon', 'height', other);
      expect(Buffer.from(got!).equals(Buffer.from((await createFsTileSource(tileRoot).tile('fixture-moon', 'height', other))!))).toBe(true);
      expect(urls.some((u) => u.includes(after.index))).toBe(true);
      const newPacks = new Set(after.packs.map((p) => p.hash));
      const oldOnly = new Set(before.packs.map((p) => p.hash).filter((h) => !newPacks.has(h)));
      const lastPackUrl = urls.filter((u) => /\/p\/[0-9a-f]{32}$/.test(u) && !u.includes(after.index)).at(-1)!;
      expect(oldOnly.has(lastPackUrl.slice(-32))).toBe(false);
    } finally {
      fs.rmSync(alt, { recursive: true, force: true });
    }
  }, 60_000);

  const tile = { layer: 'height', key: { face: 0 as FaceId, level: 1, x: 1, y: 0 } };
  const expected = (): Promise<Uint8Array | null> => createFsTileSource(tileRoot).tile('fixture-moon', tile.layer, tile.key);
});
