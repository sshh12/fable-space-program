/**
 * Determinism and the decoded-tile cache: identical results across provider instances and load orders,
 * identical eviction for identical call sequences regardless of I/O timing, memory bounded by the budget,
 * per-slot pin replacement.
 */
import { describe, expect, it } from 'vitest';
import type { TileManifest, TileSource } from '../../../src/core/contracts/terrain';
import type { TileKey } from '../../../src/core/geo/cubeSphere';
import type { Vec3 } from '../../../src/core/math/vec3';
import { createFsTileSource } from '../../../src/terrain/fsTileSource';
import type { TerrainAuthority } from '../../../src/terrain/provider';
import { EARTH_R, FIXTURE_POINTS, MOON_R } from '../../../tools/terrain-core/fixtures';
import { fixtureProvider, fixtureRoot, offset, prng } from './helpers';

/** A tile source whose tile reads complete after a pseudo-random number of event-loop turns. */
function jitteredSource(src: TileSource, seed: number): TileSource {
  const rng = prng(seed);
  const turns = async (n: number): Promise<void> => {
    for (let i = 0; i < n; i++) await new Promise<void>((r) => queueMicrotask(r));
  };
  return {
    manifest: (t) => src.manifest(t),
    async tile(t, l, k) {
      const bytes = await src.tile(t, l, k);
      await turns(Math.floor(rng.next() * 40));
      return bytes;
    },
    file: (t, p) => src.file(t, p),
  };
}

function samplePoints(centre: Vec3, R: number, n: number, spread: number, seed: number): Vec3[] {
  const rng = prng(seed);
  return Array.from({ length: n }, () => offset(centre, rng.range(-spread, spread), rng.range(-spread, spread), R));
}

function snapshot(tp: TerrainAuthority, body: string, pts: Vec3[]): number[] {
  const out: number[] = [];
  for (const p of pts) {
    out.push(tp.heightAt(body, p), tp.heightAt(body, p, 0.5), tp.heightAt(body, p, 40), tp.residency(body, p).effectiveLevel);
    const n = tp.normalAt(body, p, 1);
    out.push(n.x, n.y, n.z);
  }
  return out;
}

describe('determinism', () => {
  it('two provider instances give bit-identical heights, normals, rocks and bakes', async () => {
    const a = (await fixtureProvider()).tp;
    const b = (await fixtureProvider()).tp;
    for (const [body, centre, R] of [
      ['moon', FIXTURE_POINTS.moonDeep, MOON_R],
      ['earth', offset(FIXTURE_POINTS.padDir, 2000, 2000, EARTH_R), EARTH_R],
    ] as const) {
      await a.ensureLoaded(body, centre, 600, 'x');
      await b.ensureLoaded(body, centre, 600, 'x');
      const pts = samplePoints(centre, R, 300, 500, 1);
      expect(snapshot(a, body, pts)).toEqual(snapshot(b, body, pts));
      expect(a.rocksNear(body, centre, 40, 0.05)).toEqual(b.rocksNear(body, centre, 40, 0.05));
      const key: TileKey = { face: 0, level: 17, x: 0, y: 0 };
      const k2 = { ...key, ...(await keyAt(a, body, centre, 17)) };
      await a.prepareTile(body, k2);
      await b.prepareTile(body, k2);
      const ta = a.bakeTile(body, k2);
      const tb = b.bakeTile(body, k2);
      expect(Array.from(ta.geometry.heights)).toEqual(Array.from(tb.geometry.heights));
      expect(Array.from(ta.normalMaterial.rgba)).toEqual(Array.from(tb.normalMaterial.rgba));
    }
  }, 120_000);

  it('results do not depend on which coarser tiles were loaded first, nor on I/O timing', async () => {
    const root = await fixtureRoot();
    const centre = FIXTURE_POINTS.moonDeep;
    const pts = samplePoints(centre, MOON_R, 200, 300, 2);
    // A: straight to the final area. B: first a wide coarse area elsewhere, queries on partial data (which
    // memoise provisional collision vertices), then the final area, with jittered I/O.
    const a = (await fixtureProvider({ bodies: ['moon'] })).tp;
    await a.ensureLoaded('moon', centre, 400, 'final');
    const b = (await fixtureProvider({ bodies: ['moon'], source: jitteredSource(createFsTileSource(root), 9) })).tp;
    for (const p of pts.slice(0, 50)) b.heightAt('moon', p);
    await b.ensureLoaded('moon', offset(centre, 150e3, 0, MOON_R), 20e3, 'wide');
    const pending = b.ensureLoaded('moon', centre, 400, 'final');
    for (const p of pts.slice(0, 50)) b.heightAt('moon', p, 1);
    await pending;
    for (const p of pts) expect(b.residency('moon', p).complete).toBe(true);
    expect(snapshot(b, 'moon', pts)).toEqual(snapshot(a, 'moon', pts));
  }, 120_000);

  it('identical call sequences give identical cache contents and eviction, whatever the I/O timing', async () => {
    const root = await fixtureRoot();
    // Resident pyramid (levels 0-1, 30 tiles) ~4 MB; the budget leaves room for ~22 more height tiles,
    // fewer than the ~54 distinct tiles the sequence touches.
    const budget = 6.5 * 1024 * 1024;
    const run = async (seed: number): Promise<string[][]> => {
      const tp = (await fixtureProvider({ bodies: ['moon'], cacheBytes: budget, source: jitteredSource(createFsTileSource(root), seed) })).tp;
      const states: string[][] = [];
      const rng = prng(77);
      for (let k = 0; k < 12; k++) {
        const c = offset(FIXTURE_POINTS.moonDeep, rng.range(-1500e3, 1500e3), rng.range(-1500e3, 1500e3), MOON_R);
        const p = tp.ensureLoaded('moon', c, 20e3, `slot${k % 2}`);
        tp.heightAt('moon', c, 10);
        await p;
        states.push(tp.cachedTiles());
        expect(tp.diagnostics().cache.bytes).toBeLessThanOrEqual(budget);
      }
      return states;
    };
    const s1 = await run(1);
    const s2 = await run(2);
    expect(s1).toEqual(s2);
    // Eviction happened (the sequence needs more than the budget in total).
    expect(new Set(s1.flat()).size).toBeGreaterThan(s1[s1.length - 1]!.length);
  }, 120_000);

  it('memory stays within the budget; a request larger than the budget is refused', async () => {
    const budget = 8 * 1024 * 1024;
    const tp = (await fixtureProvider({ bodies: ['moon'], cacheBytes: budget })).tp;
    const rng = prng(4);
    for (let k = 0; k < 20; k++) {
      await tp.ensureLoaded('moon', offset(FIXTURE_POINTS.moonDeep, rng.range(-1500e3, 1500e3), rng.range(-1500e3, 1500e3), MOON_R), 20e3, 'moving');
      expect(tp.diagnostics().cache.bytes).toBeLessThanOrEqual(budget);
    }
    await expect(tp.ensureLoaded('moon', FIXTURE_POINTS.moonDeep, 2000e3, 'huge')).rejects.toThrow(/budget/);
    expect(tp.diagnostics().cache.bytes).toBeLessThanOrEqual(budget);
  }, 120_000);

  it('a new call for a slot replaces that slot\'s pin', async () => {
    const a = FIXTURE_POINTS.moonGlobal;
    const b = offset(a, 2500e3, 0, MOON_R);
    const c = offset(a, -2500e3, 0, MOON_R);
    // Measure what each area needs on top of the resident pyramid, then size the budget so that any two
    // areas fit but not all three.
    const probe = (await fixtureProvider({ bodies: ['moon'] })).tp;
    const base = probe.diagnostics().cache.bytes;
    const need: number[] = [];
    for (const p of [a, b, c]) {
      const before = probe.diagnostics().cache.bytes;
      await probe.ensureLoaded('moon', p, 200e3, `probe${need.length}`);
      need.push(probe.diagnostics().cache.bytes - before);
    }
    expect(Math.min(...need)).toBeGreaterThan(0);
    const budget = base + need[0]! + need[1]! + need[2]! - 1;
    const tp = (await fixtureProvider({ bodies: ['moon'], cacheBytes: budget })).tp;
    await tp.ensureLoaded('moon', a, 200e3, 'vessel:1');
    await tp.ensureLoaded('moon', b, 200e3, 'other');
    // With both slots pinned a third area does not fit...
    await expect(tp.ensureLoaded('moon', c, 200e3, 'third')).rejects.toThrow(/budget/);
    // ...but once vessel:1 moves on (re-pinned at c), a's tiles become evictable and c fits.
    await tp.ensureLoaded('moon', c, 200e3, 'vessel:1');
    expect(tp.diagnostics().cache.bytes).toBeLessThanOrEqual(budget);
    expect(tp.residency('moon', c).complete).toBe(true);
    expect(tp.residency('moon', b).complete).toBe(true);
  }, 120_000);

  it('manifests are pure: every layer the provider reads is promised by the manifest', async () => {
    const root = await fixtureRoot();
    const seen: string[] = [];
    const base = createFsTileSource(root);
    const spy: TileSource = {
      manifest: (t) => base.manifest(t),
      async tile(t, l, k) {
        const m: TileManifest = await base.manifest(t);
        const lm = m.layers[l]!;
        const promised = k.level <= lm.globalMaxLevel || (lm.coverage[String(k.level)] ?? []).some((r) => r.face === k.face && k.x >= r.x0 && k.x <= r.x1 && k.y >= r.y0 && k.y <= r.y1);
        if (!promised) seen.push(`${t}/${l}/${k.face}/${k.level}/${k.x}/${k.y}`);
        return base.tile(t, l, k);
      },
      file: (t, p) => base.file(t, p),
    };
    const tp = (await fixtureProvider({ source: spy })).tp;
    await tp.ensureLoaded('moon', FIXTURE_POINTS.moonCubeEdge, 50e3, 'a');
    await tp.ensureLoaded('earth', FIXTURE_POINTS.padDir, 50e3, 'b');
    expect(seen).toEqual([]);
  }, 120_000);
});

async function keyAt(tp: TerrainAuthority, _body: string, dir: Vec3, level: number): Promise<TileKey> {
  const { dirToTile } = await import('../../../src/core/geo/cubeSphere');
  void tp;
  return dirToTile(dir, level).key;
}
