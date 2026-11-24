/**
 * A terrain provider created over a shard-wide decoded-tile store (src/terrain/sharedStore.ts; ARCHITECTURE
 * 10.5): every query answers bit for bit as over the tile source, the shared samples are never written (seam
 * reconciliation copies a shared tile first: about 11,700 seam writes per body here), every tile the provider
 * caches is held once in the store, and the provider's own cache holds bookkeeping only. The store here is the test's own (SharedArrayBuffer-backed,
 * decoding from a tile source); server-persistence implements the shard's.
 */
import { describe, expect, it } from 'vitest';
import type { TileSource } from '../../../src/core/contracts/terrain';
import { decodeTileFile } from '../../../src/core/geo/tileCodec';
import { Prng } from '../../../src/core/math/hash';
import { createFsTileSource } from '../../../src/terrain/fsTileSource';
import { createTerrainProvider } from '../../../src/terrain/provider';
import type { SharedTile, SharedTileKey, SharedTileStore } from '../../../src/terrain/sharedStore';
import { fixtureDefs, syntheticTileRoot } from '../../../tools/terrain-core/fixtures';
import { REPO_ROOT } from './helpers';

/** The test's store: decodes from a tile source into SharedArrayBuffers, counts acquires and releases. */
function sharedStoreOver(source: TileSource): SharedTileStore & { held: Map<string, number>; tiles: Map<string, SharedTile>; snapshot(): Map<string, Int16Array> } {
  const tiles = new Map<string, SharedTile>();
  const held = new Map<string, number>();
  const keyOf = (k: SharedTileKey): string => `${k.tileset}/${k.layer}/${k.face}/${k.level}/${k.x}/${k.y}`;
  return {
    capBytes: 256 * 1024 * 1024,
    tiles,
    held,
    peek(k) {
      return tiles.get(keyOf(k)) ?? null;
    },
    async acquire(k) {
      const id = keyOf(k);
      let t = tiles.get(id);
      if (!t) {
        const bytes = await source.tile(k.tileset, k.layer, { face: k.face as 0, level: k.level, x: k.x, y: k.y });
        if (bytes === null) return null;
        const r = await decodeTileFile(bytes);
        if (r.kind === 'height') {
          const q = new Int16Array(new SharedArrayBuffer(r.heights.length * 2));
          const inv = 1 / r.scale;
          for (let i = 0; i < r.heights.length; i++) q[i] = Math.round((r.heights[i]! - r.offset) * inv);
          t = { kind: 'height', q, scale: r.scale, offset: r.offset, hMin: r.hMin, hMax: r.hMax };
        } else {
          const data = new Uint8Array(new SharedArrayBuffer(r.data.length));
          data.set(r.data);
          t = { kind: 'u8', channels: r.channels, data };
        }
        tiles.set(id, t);
      }
      held.set(id, (held.get(id) ?? 0) + 1);
      return t;
    },
    release(k) {
      const id = keyOf(k);
      const n = (held.get(id) ?? 0) - 1;
      if (n < 0) throw new Error(`released a tile that was not acquired: ${id}`);
      if (n === 0) held.delete(id);
      else held.set(id, n);
    },
    snapshot() {
      const out = new Map<string, Int16Array>();
      for (const [id, t] of tiles) if (t.kind === 'height') out.set(id, t.q.slice());
      return out;
    },
  };
}

describe('a provider over a shared decoded-tile store', () => {
  it('answers every query bit for bit as over the tile source, never writes the shared samples, and releases what it drops', async () => {
    const root = await syntheticTileRoot();
    const defs = await fixtureDefs(REPO_ROOT);
    const source = createFsTileSource(root);
    const shared = sharedStoreOver(source);
    const plain = await createTerrainProvider(defs, source);
    const over = await createTerrainProvider(defs, source, { sharedStore: shared });
    const before = shared.snapshot();
    const rng = new Prng(77);
    for (const body of ['moon', 'earth']) {
      const centre = { x: 0.6, y: 0.3, z: Math.sqrt(1 - 0.45) };
      await plain.ensureLoaded(body, centre, 20000, 'probe');
      await over.ensureLoaded(body, centre, 20000, 'probe');
      for (let i = 0; i < 300; i++) {
        const d = { x: centre.x + (rng.next() - 0.5) * 0.004, y: centre.y + (rng.next() - 0.5) * 0.004, z: centre.z + (rng.next() - 0.5) * 0.004 };
        expect(Object.is(over.heightAt(body, d), plain.heightAt(body, d))).toBe(true);
        expect(Object.is(over.heightAt(body, d, 300), plain.heightAt(body, d, 300))).toBe(true);
      }
      expect(over.residency(body, centre)).toEqual(plain.residency(body, centre));
    }
    // the shared samples are as the store decoded them (seam writes went to private copies)
    for (const [id, q] of before) expect(shared.tiles.get(id)!.kind === 'height' && (shared.tiles.get(id) as { q: Int16Array }).q.every((x, i) => x === q[i]), id).toBe(true);
    expect(over.diagnostics().seamWrites).toEqual(plain.diagnostics().seamWrites);
    if (process.env['SOLAR_SYSTEM_VERBOSE']) console.log('seam writes', JSON.stringify(plain.diagnostics().seamWrites));
    // the provider's own cache: bookkeeping only (256 bytes an entry)
    const d = over.diagnostics().cache;
    expect(d.bytes).toBe(d.tiles * 256);
    // every tile of the provider's cache is held exactly once in the store
    const heldBefore = [...shared.held.values()].reduce((a, b) => a + b, 0);
    expect(heldBefore).toBe(d.tiles);
  });
});
