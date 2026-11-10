/**
 * What ensureLoaded / prepareTile load is everything the height function and the bakers read:
 *  - the data-scale slope probes reach lambda_data(E) / 8 beyond a point (666 m at the fixture's global level),
 *    so a point next to a level-g tile border needs the neighbour tile;
 *  - render tiles coarser than the data under them (E > render level) read only levels up to their own;
 *  - shared samples of neighbouring tiles quantised with different scales are reconciled (seams.ts): the
 *    surface is continuous across such edges and corners, and a point whose stencil touches an
 *    unreconciled seam is incomplete until the neighbour is resident.
 * After loading, results are complete and do not change when more data is loaded.
 */
import { describe, expect, it } from 'vitest';
import { decodeTileFile, HEIGHT_TILE_STORED } from '../../../src/core/geo/tileCodec';
import { dirToTile, tileUvToDir, type FaceId, type TileKey } from '../../../src/core/geo/cubeSphere';
import type { Vec3 } from '../../../src/core/math/vec3';
import { createFsTileSource } from '../../../src/terrain/fsTileSource';
import { fixtureScaleFactor, FIXTURE_POINTS, MOON_R } from '../../../tools/terrain-core/fixtures';
import { fixtureProvider, fixtureRoot, moveToward, prng } from './helpers';

const G = 2;
const TS_G = (Math.PI * MOON_R) / 2 / 2 ** G;

/** Level-g tile of the global-only fixture area. */
const globalTile = (): TileKey => dirToTile(FIXTURE_POINTS.moonGlobal, G).key;

describe('load sets cover the data-scale slope probes', () => {
  it('ensureLoaded(P, 0) next to every edge of a level-g tile: complete, and nothing changes when more is loaded', async () => {
    const key = globalTile();
    const d = 300 / TS_G;
    for (const [name, u, v] of [
      ['-u', d, 0.5],
      ['+u', 1 - d, 0.5],
      ['-v', 0.5, d],
      ['+v', 0.5, 1 - d],
      ['+u+v corner', 1 - d, 1 - d],
    ] as const) {
      const tp = (await fixtureProvider({ bodies: ['moon'] })).tp;
      const p = tileUvToDir(key, u, v);
      await tp.ensureLoaded('moon', p, 0, 'touchdown');
      expect(tp.residency('moon', p).complete, name).toBe(true);
      const parts = tp.heightParts('moon', p, 0.32);
      expect(parts.complete, name).toBe(true);
      const c1 = tp.heightAt('moon', p);
      const n1 = tp.normalAt('moon', p, 0.5);
      await tp.ensureLoaded('moon', p, 20000, 'more');
      expect(tp.heightParts('moon', p, 0.32).height, name).toBe(parts.height);
      expect(tp.heightAt('moon', p), name).toBe(c1);
      expect(tp.normalAt('moon', p, 0.5), name).toEqual(n1);
    }
  }, 120_000);

  it('prepareTile: render tiles next to a level-g border and render tiles coarser than their data bake complete, independent of extra data', async () => {
    const g = globalTile();
    const cases: TileKey[] = [];
    for (const K of [8, 12, 15, 18]) {
      const s = 2 ** (K - G);
      cases.push({ face: g.face, level: K, x: (g.x + 1) * s - 2, y: g.y * s + (s >> 1) });
      cases.push({ face: g.face, level: K, x: g.x * s + (s >> 1), y: (g.y + 1) * s - 3 });
    }
    // Inside sparse region A (levels 3-5 at face 0): E = 5 above render levels 3 and 4.
    cases.push({ face: 0, level: 3, x: 4, y: 4 });
    cases.push({ face: 0, level: 4, x: 8, y: 8 });
    for (const key of cases) {
      const tp = (await fixtureProvider({ bodies: ['moon'] })).tp;
      await tp.prepareTile('moon', key);
      const geo = tp.bakeGeometry('moon', key);
      const both = tp.bakeTile('moon', key);
      const tag = JSON.stringify(key);
      expect(geo.complete, tag).toBe(true);
      expect(both.geometry.complete, tag).toBe(true);
      expect(both.normalMaterial.complete, tag).toBe(true);
      // Load far more around the tile (all levels): the products must not change.
      await tp.ensureLoaded('moon', tileUvToDir(key, 0.5, 0.5), 3 * (Math.PI * MOON_R) / 2 / 2 ** key.level + 2000, 'wide');
      const again = tp.bakeTile('moon', key);
      expect(Array.from(again.geometry.heights), tag).toEqual(Array.from(both.geometry.heights));
      expect(Array.from(again.normalMaterial.rgba), tag).toEqual(Array.from(both.normalMaterial.rgba));
      expect(again.normalMaterial.slopeScale, tag).toBe(both.normalMaterial.slopeScale);
    }
  }, 300_000);
});

/** A neighbour pair: tile a and the tile across its +u (or +v) edge, possibly on another face. */
interface Pair {
  a: TileKey;
  b: TileKey;
  axis: 'u' | 'v';
}

function neighbourAcross(a: TileKey, axis: 'u' | 'v'): TileKey {
  return dirToTile(tileUvToDir(a, axis === 'u' ? 1 + 1e-7 : 0.5, axis === 'v' ? 1 + 1e-7 : 0.5), a.level).key;
}

/** Fixture tiles that exist (global levels 0-2, region A/B rects at 3-5). */
function exists(key: TileKey): boolean {
  if (key.level <= G) return true;
  const rects: Record<number, { face: number; x0: number; y0: number; x1: number; y1: number }[]> = {
    3: [
      { face: 0, x0: 3, y0: 3, x1: 5, y1: 5 },
      { face: 0, x0: 6, y0: 3, x1: 7, y1: 4 },
      { face: 2, x0: 0, y0: 3, x1: 1, y1: 4 },
    ],
    4: [
      { face: 0, x0: 7, y0: 7, x1: 9, y1: 9 },
      { face: 0, x0: 13, y0: 7, x1: 15, y1: 8 },
      { face: 2, x0: 0, y0: 7, x1: 2, y1: 8 },
    ],
    5: [{ face: 0, x0: 15, y0: 15, x1: 18, y1: 18 }],
  };
  return (rects[key.level] ?? []).some((r) => r.face === key.face && key.x >= r.x0 && key.x <= r.x1 && key.y >= r.y0 && key.y <= r.y1);
}

/** Pairs with different scale factors at every level, including cube edges (a at the face's last column/row). */
function mixedPairs(): Pair[] {
  const out: Pair[] = [];
  const candidates: TileKey[] = [];
  for (let level = 0; level <= G; level++) {
    const n = 2 ** level;
    for (const face of [0, 2, 4] as FaceId[]) for (let x = 0; x < n; x++) for (let y = 0; y < n; y++) candidates.push({ face, level, x, y });
  }
  for (const [level, x0, y0, x1, y1, face] of [
    [3, 3, 3, 7, 5, 0],
    [3, 0, 3, 1, 4, 2],
    [4, 7, 7, 9, 9, 0],
    [4, 13, 7, 15, 8, 0],
    [5, 15, 15, 18, 18, 0],
  ] as const) {
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) candidates.push({ face: face as FaceId, level, x, y });
  }
  for (const a of candidates) {
    if (!exists(a)) continue;
    for (const axis of ['u', 'v'] as const) {
      const b = neighbourAcross(a, axis);
      if (!exists(b) || fixtureScaleFactor(a) === fixtureScaleFactor(b)) continue;
      out.push({ a, b, axis });
    }
  }
  return out;
}

describe('seams between tiles quantised with different scales', () => {
  const pairs = mixedPairs();

  it('the fixture really has shared samples that disagree (tens of cm) at every level, incl. cube edges', async () => {
    const src = createFsTileSource(await fixtureRoot());
    const decode = async (k: TileKey): Promise<Float32Array> => {
      const r = await decodeTileFile((await src.tile('fixture-moon', 'height', k))!);
      if (r.kind !== 'height') throw new Error('height tile expected');
      return r.heights;
    };
    const levels = new Set<number>();
    let cube = 0;
    for (const p of pairs) {
      if (p.a.face !== p.b.face) cube++;
      if (p.a.face !== p.b.face || p.axis !== 'u') continue;
      const A = await decode(p.a);
      const B = await decode(p.b);
      let worst = 0;
      for (let j = 1; j <= 257; j++) worst = Math.max(worst, Math.abs(A[j * HEIGHT_TILE_STORED + 257]! - B[j * HEIGHT_TILE_STORED + 1]!));
      if (worst > 0.05) levels.add(p.a.level);
    }
    expect([...levels].sort()).toEqual([1, 2, 3, 4, 5]);
    expect(cube).toBeGreaterThan(3);
  });

  it('|H jump| < 1 mm across every mixed-scale edge and around their corners (data only and amplified), complete after ensureLoaded', async () => {
    const none = (await fixtureProvider({ bodies: ['moon'], model: 'none' })).tp;
    const amp = (await fixtureProvider({ bodies: ['moon'] })).tp;
    const rng = prng(77);
    let worst = 0;
    let corners = 0;
    for (const p of pairs) {
      const pts: [Vec3, Vec3][] = [];
      for (let k = 0; k < 12; k++) {
        const t = k < 10 ? 0.01 + 0.98 * rng.next() : k === 10 ? 0 : 1;
        const on = p.axis === 'u' ? tileUvToDir(p.a, 1, t) : tileUvToDir(p.a, t, 1);
        const inside = p.axis === 'u' ? tileUvToDir(p.a, 0.9, Math.min(0.9, Math.max(0.1, t))) : tileUvToDir(p.a, Math.min(0.9, Math.max(0.1, t)), 0.9);
        pts.push([moveToward(on, inside, 1e-6, MOON_R), moveToward(on, inside, -1e-6, MOON_R)]);
        if (k >= 10) corners++;
      }
      for (const tp of [none, amp]) await Promise.all(pts.map(([a], i) => tp.ensureLoaded('moon', a, 1, `seam-${p.a.level}-${p.a.face}-${p.a.x}-${p.a.y}-${p.axis}-${i}`)));
      for (const [a, b] of pts) {
        for (const [tp, lam] of [
          [none, 0.01],
          [none, 50],
          [amp, 0.32],
        ] as const) {
          expect(tp.residency('moon', a).complete).toBe(true);
          expect(tp.residency('moon', b).complete).toBe(true);
          const j = Math.abs(tp.heightAt('moon', a, lam) - tp.heightAt('moon', b, lam));
          worst = Math.max(worst, j);
          expect(j, `L${p.a.level} ${JSON.stringify(p.a)} | ${JSON.stringify(p.b)} lambda ${lam}`).toBeLessThan(1e-3);
        }
      }
    }
    expect(corners).toBeGreaterThan(0);
    expect(none.diagnostics().seamWrites['moon']!).toBeGreaterThan(0);
    console.log(`[seams] ${pairs.length} mixed-scale edges (levels 0-5, ${pairs.filter((p) => p.a.face !== p.b.face).length} across cube edges): worst jump over 2 um ${worst.toExponential(2)} m`);
  }, 300_000);

  it('a point whose stencil reaches an unreconciled seam is incomplete until the neighbour is resident; the final value does not depend on load order', async () => {
    const p = pairs.find((q) => q.a.level === G && q.a.face === q.b.face && q.axis === 'u')!;
    // Half a sample inside a's +u edge: its stencil uses the shared edge and border columns.
    const q = tileUvToDir(p.a, 1 - 0.5 / 256, 0.5);
    const tp = (await fixtureProvider({ bodies: ['moon'], model: 'none' })).tp;
    await tp.ensureLoaded('moon', tileUvToDir(p.a, 0.5, 0.5), 1, 'centre');
    expect(tp.residency('moon', q).complete).toBe(false);
    expect(tp.heightParts('moon', q, 0.01).complete).toBe(false);
    await tp.ensureLoaded('moon', q, 0, 'edge');
    expect(tp.residency('moon', q).complete).toBe(true);
    const hA = tp.heightAt('moon', q, 0.01);
    // Other order: the neighbour first, then a.
    const tp2 = (await fixtureProvider({ bodies: ['moon'], model: 'none' })).tp;
    await tp2.ensureLoaded('moon', tileUvToDir(p.b, 0.5, 0.5), 1, 'centre');
    await tp2.ensureLoaded('moon', q, 0, 'edge');
    expect(tp2.heightAt('moon', q, 0.01)).toBe(hA);
  }, 120_000);
});
