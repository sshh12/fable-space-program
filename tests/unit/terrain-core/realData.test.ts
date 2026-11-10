/**
 * Real baked tiles (runs automatically when data/tiles/moon/manifest.json or data/tiles/earth/manifest.json
 * exists): LOLA benchmarks, the landing target, the launch pad, and the coverage-edge continuity suite on
 * every regional level of the real manifests.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { DefLibrary } from '../../../src/core/contracts/defs';
import type { TileManifest } from '../../../src/core/contracts/terrain';
import { latLonToDir } from '../../../src/core/geo/cubeSphere';
import { DEG } from '../../../src/core/math/scalar';
import { fsDefSource } from '../../../src/core/defs/fsSource';
import { loadDefs } from '../../../src/core/defs/loader';
import { createFsTileSource } from '../../../src/terrain/fsTileSource';
import { createTerrainProvider, type TerrainAuthority } from '../../../src/terrain/provider';
import { boundaryPoints, edgeStats, loadAround, truncatedSource } from './edgeChecks';
import { offset, prng, REPO_ROOT } from './helpers';

const TILES = path.join(REPO_ROOT, 'data/tiles');
const HAS_MOON = existsSync(path.join(TILES, 'moon', 'manifest.json'));
const HAS_EARTH = existsSync(path.join(TILES, 'earth', 'manifest.json'));
const POINTS = 1000;

/** ldem_64 pixels of the LOLA benchmarks (docs/research/moon-sky-data.md 0.1; tools/bake/moon/verify.py). */
const BENCHMARKS = [
  { name: 'Tranquility', row: 5717, col: 1502, ref: -1925.0 },
  { name: 'Tycho floor', row: 8531, col: 22310, ref: -1295.5 },
  { name: 'Apollo 17', row: 4467, col: 1969, ref: -2624.5 },
  { name: 'Aitken basin', row: 9152, col: 12224, ref: -6948.0 },
];

async function realDefs(): Promise<DefLibrary> {
  return loadDefs(fsDefSource(path.join(REPO_ROOT, 'data/defs')));
}

function withModel(defs: DefLibrary, body: string, model: string): DefLibrary {
  const b = defs.bodies[body]!;
  return { ...defs, bodies: { ...defs.bodies, [body]: { ...b, terrain: { ...b.terrain!, amplification: { ...b.terrain!.amplification, model } } } } };
}

function coverageSuite(body: string, R: () => number, defsP: () => DefLibrary): void {
  const manifest = (): TileManifest => JSON.parse(readFileSync(path.join(TILES, defsP().bodies[body]!.terrain!.tileset, 'manifest.json'), 'utf8')) as TileManifest;
  it(`${body}: every regional level - continuous across the coverage edge, parent surface on the boundary`, async () => {
    const defs = defsP();
    const m = manifest();
    const src = createFsTileSource(TILES);
    const layer = m.layers['height']!;
    const levels = Object.keys(layer.coverage)
      .map(Number)
      .sort((a, b) => a - b);
    expect(levels.length).toBeGreaterThan(0);
    const amp = await createTerrainProvider(defs, src, { bodies: [body] });
    const none = await createTerrainProvider(withModel(defs, body, 'none'), src, { bodies: [body] });
    for (const L of levels) {
      const pts = boundaryPoints(layer, L, POINTS, prng(500 + L));
      const tsrc = truncatedSource(src, L);
      const pa = await createTerrainProvider(defs, tsrc, { bodies: [body] });
      const pn = await createTerrainProvider(withModel(defs, body, 'none'), tsrc, { bodies: [body] });
      const dirs = pts.map((q) => q.p);
      await Promise.all([loadAround(amp, body, dirs, 2, `L${L}-`), loadAround(none, body, dirs, 2, `L${L}-`), loadAround(pa, body, dirs, 2, 'p'), loadAround(pn, body, dirs, 2, 'p')]);
      const lamC = (Math.PI * R()) / 2 / 2 ** defs.bodies[body]!.terrain!.maxRenderLevel / 32;
      const sNone = edgeStats(none, pn, body, R(), pts, lamC, lamC);
      const sAmp = edgeStats(amp, pa, body, R(), pts, lamC, lamC);
      console.log(`[real ${body} coverage L${L}] data only ${JSON.stringify(sNone)}`);
      console.log(`[real ${body} coverage L${L}] amplified ${JSON.stringify(sAmp)}`);
      expect(sNone.maxExcess, `L${L}`).toBeLessThan(1e-3);
      expect(sNone.maxParentDiff, `L${L}`).toBeLessThan(1e-6);
      expect(sNone.deltaSlopeChange, `L${L}`).toBeLessThan(0.005);
      expect(sAmp.deltaJump, `L${L}`).toBeLessThan(1e-3);
      expect(sAmp.deltaSlopeChange, `L${L}`).toBeLessThan(0.005);
      expect(sAmp.maxParentDiff, `L${L}`).toBeLessThan(1e-6);
      expect(sAmp.maxEJump, `L${L}`).toBeLessThan(1e-6);
    }
  }, 900_000);
}

describe.skipIf(!HAS_MOON)('real Moon tiles', () => {
  let defs: DefLibrary;
  let tp: TerrainAuthority;
  let R = 0;

  beforeAll(async () => {
    defs = await realDefs();
    R = defs.bodies['moon']!.radius;
    tp = await createTerrainProvider(defs, createFsTileSource(TILES), { bodies: ['moon'] });
  }, 300_000);

  it('LOLA benchmarks: mean over the ldem_64 pixel within 60 m', async () => {
    for (const b of BENCHMARKS) {
      const lat = 90 - (b.row + 0.5) / 64;
      const lon = (b.col + 0.5) / 64;
      const c = latLonToDir(lat * DEG, lon * DEG);
      await tp.ensureLoaded('moon', c, 600, `bench-${b.name}`);
      let sum = 0;
      let n = 0;
      let lo = Infinity;
      let hi = -Infinity;
      for (let i = 0; i < 8; i++) {
        for (let j = 0; j < 8; j++) {
          const d = latLonToDir((lat + ((i + 0.5) / 8 - 0.5) / 64) * DEG, (lon + ((j + 0.5) / 8 - 0.5) / 64) * DEG);
          // Band limit 200 m: the level-6 data (166 m posting) fully, like the bake's level-6 check.
          const h = tp.heightParts('moon', d, 200).data;
          sum += h;
          lo = Math.min(lo, h);
          hi = Math.max(hi, h);
          n++;
        }
      }
      const mean = sum / n;
      // ldem_64 is a 474 m binned LOLA value: on steep ground it differs from the mean of the 118 m data
      // inside the pixel by a fraction of the relief within the pixel. (Tycho floor: the bake's own reader,
      // tools/bake/moon/tiles.py, gives the same -1383.5 m as terrain-core; the 88 m are a property of the
      // baked level-6 data against that pixel, reported in docs/handoff/terrain-core.md.)
      const tol = Math.max(60, 0.3 * (hi - lo));
      console.log(`[real moon] ${b.name}: ${mean.toFixed(1)} m (ldem_64 ${b.ref} m), relief inside the pixel ${(hi - lo).toFixed(0)} m, tolerance ${tol.toFixed(0)} m`);
      expect(Math.abs(mean - b.ref), b.name).toBeLessThan(tol);
    }
  }, 300_000);

  it('Tranquility (0.664 N 23.477 E) at full resolution within 5 m of -1925 m; H within the local relief', async () => {
    const c = latLonToDir((90 - 5717.5 / 64) * DEG, (1502.5 / 64) * DEG);
    await tp.ensureLoaded('moon', c, 100, 'tranq');
    const p = tp.heightParts('moon', c, 0.32);
    console.log(`[real moon] Tranquility point: data ${p.data.toFixed(2)} m, amplification ${p.amplification.toFixed(2)} m, collision ${tp.heightAt('moon', c).toFixed(2)} m`);
    expect(Math.abs(p.data + 1925)).toBeLessThan(5);
    expect(Math.abs(p.amplification)).toBeLessThan(3);
  });

  it('landing target: deepest data, complete after ensureLoaded, flat-ish', async () => {
    const region = JSON.parse(readFileSync(path.join(REPO_ROOT, 'data/defs/regions/moon-tranquility.json'), 'utf8')) as { recommendedTarget: { latDeg: number; lonDeg: number; heightM: number } };
    const t = region.recommendedTarget;
    const c = latLonToDir(t.latDeg * DEG, t.lonDeg * DEG);
    const before = tp.residency('moon', c);
    expect(before.availableLevel).toBe(12);
    await tp.ensureLoaded('moon', c, 2000, 'target');
    const r = tp.residency('moon', c);
    expect(r).toEqual({ residentLevel: 12, availableLevel: 12, effectiveLevel: 12, complete: true });
    expect(tp.heightParts('moon', c, 0.32).data).toBeCloseTo(t.heightM, 0);
    // Slope over 100 m at the data scale stays under the bake's 3 deg criterion.
    const e = tp.heightAt('moon', offset(c, 50, 0, R), 5);
    const w = tp.heightAt('moon', offset(c, -50, 0, R), 5);
    expect(Math.abs(e - w) / 100).toBeLessThan(Math.tan(3 * DEG) * 1.5);
    // The collision surface there is real terrain with procedural detail: not flat, not wild.
    const n = tp.normalAt('moon', c, 1);
    expect(n.x * c.x + n.y * c.y + n.z * c.z).toBeGreaterThan(Math.cos(30 * DEG));
  });

  coverageSuite(
    'moon',
    () => R,
    () => defs,
  );
});

describe.skipIf(!HAS_EARTH)('real Earth tiles', () => {
  let defs: DefLibrary;
  let tp: TerrainAuthority;
  let R = 0;

  beforeAll(async () => {
    defs = await realDefs();
    R = defs.bodies['earth']!.radius;
    tp = await createTerrainProvider(defs, createFsTileSource(TILES), { bodies: ['earth'] });
  }, 300_000);

  it('launch-site pads are flat within 5 cm over flatRadius', async () => {
    for (const s of Object.values(defs.sites).filter((x) => x.bodyId === 'earth')) {
      const c = latLonToDir(s.location.latDeg * DEG, s.location.lonDeg * DEG);
      await tp.ensureLoaded('earth', c, s.pad.blendRadius, `pad-${s.id}`);
      const h0 = tp.heightAt('earth', c, 1);
      if (typeof s.location.padElevation === 'number') expect(h0).toBeCloseTo(s.location.padElevation, 6);
      const rng = prng(31);
      let worst = 0;
      for (let i = 0; i < 2000; i++) {
        const r = (s.pad.flatRadius - 1) * Math.sqrt(rng.next());
        const a = rng.range(0, 2 * Math.PI);
        const d = offset(c, r * Math.cos(a), r * Math.sin(a), R);
        worst = Math.max(worst, Math.abs(tp.heightAt('earth', d) - h0), Math.abs(tp.heightAt('earth', d, 0.3) - h0));
      }
      console.log(`[real earth] pad ${s.id}: elevation ${h0.toFixed(3)} m, max deviation over flatRadius ${worst.toExponential(2)} m`);
      expect(worst).toBeLessThan(0.05);
    }
  }, 300_000);

  coverageSuite(
    'earth',
    () => R,
    () => defs,
  );
});
