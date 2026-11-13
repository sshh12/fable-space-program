/**
 * Real baked tiles (runs automatically when data/tiles/moon/manifest.json or data/tiles/earth/manifest.json
 * exists): LOLA benchmarks, the landing target, the launch pad, and the coverage-edge continuity suite on
 * every regional level of the real manifests.
 */
import { closeSync, existsSync, openSync, readFileSync, readSync } from 'node:fs';
import path from 'node:path';
import { constants as zlibConstants, inflateSync } from 'node:zlib';
import { beforeAll, describe, expect, it } from 'vitest';
import type { DefLibrary } from '../../../src/core/contracts/defs';
import type { TileLayerManifest, TileManifest } from '../../../src/core/contracts/terrain';
import { layerHasTile } from '../../../src/core/contracts/terrain';
import { dirToTile, latLonToDir, tilePath, tileUvToDir, type FaceId, type TileKey } from '../../../src/core/geo/cubeSphere';
import { DEG } from '../../../src/core/math/scalar';
import type { Vec3 } from '../../../src/core/math/vec3';
import { fsDefSource } from '../../../src/core/defs/fsSource';
import { loadDefs } from '../../../src/core/defs/loader';
import { createFsTileSource } from '../../../src/terrain/fsTileSource';
import { createTerrainProvider, type TerrainAuthority } from '../../../src/terrain/provider';
import { boundaryPoints, edgeStats, loadAround, sourceHeldSource, truncatedSource, type LayerWithSource } from './edgeChecks';
import { moveToward, offset, prng, REPO_ROOT } from './helpers';

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

/** Scale (m per count) of a height tile from the first bytes of its file (partial inflate of the FRT1 header). */
function tileScale(file: string): number {
  const fd = openSync(file, 'r');
  try {
    const buf = Buffer.alloc(1024);
    const n = readSync(fd, buf, 0, buf.length, 0);
    const head = inflateSync(buf.subarray(0, n), { finishFlush: zlibConstants.Z_SYNC_FLUSH });
    return new DataView(head.buffer, head.byteOffset, head.byteLength).getFloat32(12, true);
  } finally {
    closeSync(fd);
  }
}

/**
 * Tile borders of the real tile set at the global max level and every regional level: |H jump| < 1 mm across
 * shared edges, for every neighbour pair whose tiles use different scales (from the tile headers) and a sample
 * of same-scale pairs. Data only at band 0.01 m, and the amplified surface at the collision band.
 */
function tileBorderSuite(body: string, R: () => number, defsP: () => DefLibrary): void {
  it(`${body}: continuous across data-tile borders at every regional level, including tiles quantised with different scales`, async () => {
    const defs = defsP();
    const tileset = defs.bodies[body]!.terrain!.tileset;
    const m = JSON.parse(readFileSync(path.join(TILES, tileset, 'manifest.json'), 'utf8')) as TileManifest;
    const layer = m.layers['height']!;
    const src = createFsTileSource(TILES);
    const none = await createTerrainProvider(withModel(defs, body, 'none'), src, { bodies: [body] });
    const amp = await createTerrainProvider(defs, src, { bodies: [body] });
    const lamC = (Math.PI * R()) / 2 / 2 ** defs.bodies[body]!.terrain!.maxRenderLevel / 32;
    const rng = prng(4242);
    let mixedTotal = 0;
    for (const L of Object.keys(layer.coverage).map(Number).sort((a, b) => a - b)) {
      const scales = new Map<string, number>();
      for (const r of layer.coverage[String(L)]!) {
        for (let x = r.x0; x <= r.x1; x++) for (let y = r.y0; y <= r.y1; y++) scales.set(`${r.face}/${x}/${y}`, tileScale(path.join(TILES, tilePath(tileset, 'height', { face: r.face, level: L, x, y }, layer.ext))));
      }
      const mixed: [TileKey, 'u' | 'v'][] = [];
      const same: [TileKey, 'u' | 'v'][] = [];
      for (const [k, s] of scales) {
        const [f, x, y] = k.split('/').map(Number) as [number, number, number];
        for (const axis of ['u', 'v'] as const) {
          const o = scales.get(axis === 'u' ? `${f}/${x + 1}/${y}` : `${f}/${x}/${y + 1}`);
          if (o === undefined) continue;
          (o !== s ? mixed : same).push([{ face: f as FaceId, level: L, x, y }, axis]);
        }
      }
      const picked = [...mixed];
      for (let i = 0; i < 12 && same.length > 0; i++) picked.push(same[Math.floor(rng.next() * same.length)]!);
      let worstNone = 0;
      let worstAmp = 0;
      for (const [key, axis] of picked) {
        const pairs: [Vec3, Vec3][] = [];
        for (let k = 0; k < 16; k++) {
          const t = 0.02 + 0.96 * rng.next();
          const on = axis === 'u' ? tileUvToDir(key, 1, t) : tileUvToDir(key, t, 1);
          const inside = axis === 'u' ? tileUvToDir(key, 0.9, t) : tileUvToDir(key, t, 0.9);
          pairs.push([moveToward(on, inside, 1e-6, R()), moveToward(on, inside, -1e-6, R())]);
        }
        const slot = `border-${L}-${key.x}-${key.y}-${axis}`;
        await Promise.all([none.ensureLoaded(body, pairs[0]![0], 2, slot), amp.ensureLoaded(body, pairs[0]![0], 2, slot)]);
        await Promise.all(pairs.map(([a], i) => Promise.all([none.ensureLoaded(body, a, 1, `${slot}-${i}`), amp.ensureLoaded(body, a, 1, `${slot}-${i}`)])));
        for (const [a, b] of pairs) {
          expect(none.residency(body, a).complete).toBe(true);
          worstNone = Math.max(worstNone, Math.abs(none.heightAt(body, a, 0.01) - none.heightAt(body, b, 0.01)));
          worstAmp = Math.max(worstAmp, Math.abs(amp.heightAt(body, a, lamC) - amp.heightAt(body, b, lamC)));
        }
      }
      mixedTotal += mixed.length;
      console.log(`[real ${body} tile borders L${L}] ${scales.size} tiles, ${mixed.length} mixed-scale neighbour pairs (all tested) + ${picked.length - mixed.length} same-scale: worst jump over 2 um ${worstNone.toExponential(2)} m (data only), ${worstAmp.toExponential(2)} m (amplified)`);
      expect(worstNone, `L${L}`).toBeLessThan(1e-3);
      expect(worstAmp, `L${L}`).toBeLessThan(1e-3);
    }
    console.log(`[real ${body} tile borders] ${mixedTotal} mixed-scale pairs in total; seam samples rewritten: ${none.diagnostics().seamWrites[body]}`);
  }, 900_000);
}

/**
 * Texture across the coverage margins and source rings of every regional level (docs/requests/terrain-core-1.md).
 * Statistic: RMS slope over a baseline b of the band-pass height H(b/4) - H(4 b), b = 1 and 4 postings of level
 * L, six baselines around each point, divided by the same statistic of the PARENT-LEVEL surface (the manifest
 * without level L and deeper) at the SAME points, so regional differences of the terrain cancel.
 *  - Coverage margin (0.12 / 0.4 / 0.8 tile inside the coverage boundary, in level-L tiles outside the source
 *    rectangles): the bakes store parent-identical data there, so the surface must keep the parent's texture
 *    (ratio 1). Keying E on coverage (the contract's literal recursion) gave 0.35-0.77 there: the parent's
 *    procedural detail was switched off with nothing to replace it.
 *  - Source ring (0.1 / 0.5 / 1 tile inside the source boundary): the ratio against the parent-level surface
 *    (real data against the model) is reported, not asserted. Where the ring of level L starts (0.1 tile)
 *    level L must not step: asserted against the SAME surface without level L's source ring (the manifest
 *    with no source tiles at level L; data and every other level's ring unchanged), ratio 1.
 *    The ring-start assertion used to be the ratio against the parent-level surface (0.8-1.25). That held
 *    only while the source rectangles of the levels did not share boundaries. Since the Earth bake lists
 *    exactly the tiles that hold land (docs/requests/terrain-core-4.md), the source sets of levels 8-12 share
 *    the coast: 0.1 level-9 tile inside the level-9 boundary lies 0.8 level-12 tile inside the level-12
 *    boundary, where the level-12 ring is almost complete (E about 11.8) and full-weight 10 m land data has
 *    replaced the model. The ratio against the parent there (Earth level 9: 0.80 at one posting) is real
 *    coast against the model, the same quantity as "further in", not a step of level 9's ring.
 */
async function ringTexture(body: string, defs: DefLibrary, R: number): Promise<{ level: number; margin: number[]; ringStart: number[]; row: string }[]> {
  const tileset = defs.bodies[body]!.terrain!.tileset;
  const layer = (JSON.parse(readFileSync(path.join(TILES, tileset, 'manifest.json'), 'utf8')) as TileManifest).layers['height'] as LayerWithSource;
  const sc = layer.sourceCoverage;
  if (!sc) throw new Error(`${tileset}: the height layer has no sourceCoverage`);
  const srcLayer = { ...layer, coverage: sc };
  const base = createFsTileSource(TILES);
  const out: { level: number; margin: number[]; ringStart: number[]; row: string }[] = [];
  for (const L of Object.keys(layer.coverage).map(Number).sort((a, b) => a - b)) {
    const opts = { bodies: [body], cacheBytes: 768 * 1024 * 1024 };
    const tp = await createTerrainProvider(defs, base, opts);
    const par = await createTerrainProvider(defs, truncatedSource(base, L), opts);
    const ts = (Math.PI * R) / 2 / 2 ** L;
    const stat = (t: TerrainAuthority, cs: Vec3[], b: number): number => {
      const hp = (d: Vec3): number => t.heightAt(body, d, b / 4) - t.heightAt(body, d, 4 * b);
      let s2 = 0;
      for (const c of cs) {
        for (let k = 0; k < 6; k++) {
          const a = (k / 6) * Math.PI;
          const off = (k - 2.5) * 3 * b;
          const p = offset(c, off * Math.sin(a), -off * Math.cos(a), R);
          const g = (hp(offset(p, (Math.cos(a) * b) / 2, (Math.sin(a) * b) / 2, R)) - hp(offset(p, (-Math.cos(a) * b) / 2, (-Math.sin(a) * b) / 2, R))) / b;
          s2 += g * g;
        }
      }
      return Math.sqrt(s2 / (6 * cs.length));
    };
    /** Ratios at 1 and 4 postings for the points moved `w` tiles inward (stencils reach 0.125 tile). */
    const ratios = async (cs: Vec3[], tag: string): Promise<number[]> => {
      await Promise.all(cs.map((c, i) => Promise.all([tp.ensureLoaded(body, c, 0.14 * ts, `t${i}`), par.ensureLoaded(body, c, 0.14 * ts, `t${i}`)])));
      for (const c of cs) expect(tp.residency(body, c).complete && par.residency(body, c).complete, tag).toBe(true);
      return [1, 4].map((m) => stat(tp, cs, (m * ts) / 256) / stat(par, cs, (m * ts) / 256));
    };
    const cells: string[] = [];
    const margin: number[] = [];
    const cov = boundaryPoints(layer, L, 40, prng(300 + L));
    for (const w of [0.12, 0.4, 0.8]) {
      const cs = cov.map((q) => moveToward(q.p, q.inside, w * ts, R)).filter((c) => !layerHasTile(srcLayer, dirToTile(c, L).key));
      expect(cs.length, `L${L} margin points at ${w}`).toBeGreaterThan(10);
      const r = await ratios(cs, `L${L} margin ${w}`);
      margin.push(...r);
      cells.push(`margin ${w}: ${r.map((x) => x.toFixed(2)).join('/')}`);
    }
    const ringStart: number[] = [];
    // A level whose source is no finer than its parent lists no source tiles (docs/requests/terrain-core-4.md,
    // Moon level 9): it has no source ring, the whole level is margin and E stays at the parent level.
    const hasSource = (sc[String(L)] ?? []).length > 0;
    if (!hasSource) cells.push('no source tiles at this level (source no finer than the parent level)');
    const sp = hasSource ? boundaryPoints(srcLayer, L, 40, prng(600 + L)) : [];
    for (const w of hasSource ? [0.1, 0.5, 1] : []) {
      const r = await ratios(
        sp.map((q) => moveToward(q.p, q.inside, w * ts, R)),
        `L${L} source ${w}`,
      );
      cells.push(`source +${w}: ${r.map((x) => x.toFixed(2)).join('/')}`);
    }
    if (hasSource) {
      // The same surface without level L's source ring: what this ring changes where it starts.
      const held = await createTerrainProvider(defs, sourceHeldSource(base, L), opts);
      const cs = sp.map((q) => moveToward(q.p, q.inside, 0.1 * ts, R));
      await Promise.all(cs.map((c, i) => held.ensureLoaded(body, c, 0.14 * ts, `h${i}`)));
      for (const c of cs) expect(held.residency(body, c).complete, `L${L} ring start`).toBe(true);
      ringStart.push(...[1, 4].map((m) => stat(tp, cs, (m * ts) / 256) / stat(held, cs, (m * ts) / 256)));
      cells.push(`ring start vs the same surface without this ring: ${ringStart.map((x) => x.toFixed(3)).join('/')}`);
    }
    out.push({ level: L, margin, ringStart, row: cells.join(', ') });
  }
  return out;
}

function ringTextureSuite(body: string, R: () => number, defsP: () => DefLibrary): void {
  it(`${body}: texture of every coverage margin equals the parent level's; no step where a level's source ring starts (band-pass slope ratios, 1 and 4 postings)`, async () => {
    const rows = await ringTexture(body, defsP(), R());
    for (const r of rows) console.log(`[real ${body} ring texture L${r.level}] ${r.row}`);
    for (const r of rows) {
      for (const x of r.margin) {
        expect(x, `L${r.level} margin`).toBeGreaterThan(0.9);
        expect(x, `L${r.level} margin`).toBeLessThan(1.1);
      }
      for (const x of r.ringStart) {
        expect(x, `L${r.level} source ring start`).toBeGreaterThan(0.95);
        expect(x, `L${r.level} source ring start`).toBeLessThan(1.05);
      }
    }
  }, 900_000);
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
    // The regions of the tile set, one at a time: the coverage rectangles of one cube face (the Earth's two
    // regional pyramids, Ka Lae on face 1 and Madrakah on face 2, lie on different faces). Each region has
    // its own pair of providers, dropped when its levels are done, and within a region the points of a
    // level take the slots of the level before. So what is pinned is one level of one region; before, one
    // provider kept the boundary tiles of every level of every region, which the two regions' no longer
    // fit into its cache budget (request site-bake-2). The points: POINTS per level and region, where it
    // was POINTS per level over all regions; the first region's are the ones drawn before.
    const faces = [...new Set(levels.flatMap((L) => layer.coverage[String(L)]!.map((r) => r.face)))].sort((a, b) => a - b);
    let checked = 0;
    for (const [nth, face] of faces.entries()) {
      const region: TileLayerManifest = { ...layer, coverage: Object.fromEntries(Object.entries(layer.coverage).map(([k, rects]) => [k, rects.filter((r) => r.face === face)])) };
      const amp = await createTerrainProvider(defs, src, { bodies: [body] });
      const none = await createTerrainProvider(withModel(defs, body, 'none'), src, { bodies: [body] });
      for (const L of levels) {
        if (region.coverage[String(L)]!.length === 0) continue;
        const at = `face ${face} L${L}`;
        const pts = boundaryPoints(region, L, POINTS, prng(500 + L + 1000 * nth));
        expect(pts.length, `${at}: points on the coverage edge`).toBe(POINTS);
        const tsrc = truncatedSource(src, L);
        const pa = await createTerrainProvider(defs, tsrc, { bodies: [body] });
        const pn = await createTerrainProvider(withModel(defs, body, 'none'), tsrc, { bodies: [body] });
        const dirs = pts.map((q) => q.p);
        await Promise.all([loadAround(amp, body, dirs, 2, 'e'), loadAround(none, body, dirs, 2, 'e'), loadAround(pa, body, dirs, 2, 'p'), loadAround(pn, body, dirs, 2, 'p')]);
        const lamC = (Math.PI * R()) / 2 / 2 ** defs.bodies[body]!.terrain!.maxRenderLevel / 32;
        const sNone = edgeStats(none, pn, body, R(), pts, lamC, lamC);
        const sAmp = edgeStats(amp, pa, body, R(), pts, lamC, lamC);
        console.log(`[real ${body} coverage ${at}] data only ${JSON.stringify(sNone)}`);
        console.log(`[real ${body} coverage ${at}] amplified ${JSON.stringify(sAmp)}`);
        expect(sNone.maxExcess, at).toBeLessThan(1e-3);
        expect(sNone.maxParentDiff, at).toBeLessThan(1e-6);
        expect(sNone.deltaSlopeChange, at).toBeLessThan(0.005);
        expect(sAmp.deltaJump, at).toBeLessThan(1e-3);
        expect(sAmp.deltaSlopeChange, at).toBeLessThan(0.005);
        expect(sAmp.maxParentDiff, at).toBeLessThan(1e-6);
        expect(sAmp.maxEJump, at).toBeLessThan(1e-6);
        checked++;
      }
    }
    // Every regional level of every region was checked.
    expect(checked).toBe(levels.reduce((n, L) => n + new Set(layer.coverage[String(L)]!.map((r) => r.face)).size, 0));
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
      // tools/bake/moon/tiles.py, gives the same -1383.5 m as terrain-core; ldem_64 is offset by 1-2 pixels of
      // 118 m against the 256 ppd LOLA products and the pixel sits on the central peak: docs/requests/bake-moon-sky-1.md.)
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

  tileBorderSuite(
    'moon',
    () => R,
    () => defs,
  );

  ringTextureSuite(
    'moon',
    () => R,
    () => defs,
  );
});

describe.skipIf(!HAS_EARTH)('real Earth tiles: bakes of prepared render tiles are complete', () => {
  it('geometry and normal / material map are complete at every render level near the pad, also below level 14 where rocks reach the normal band', async () => {
    // docs/requests/terrain-render-1.md: from level 14 on the normal map was reported incomplete, because rock
    // candidates kilometres from the tile had their abundance (land cover) read before they were rejected.
    const defs = await loadDefs(fsDefSource(path.join(REPO_ROOT, 'data/defs')));
    const site = Object.values(defs.sites).find((s) => s.bodyId === 'earth')!;
    // A point 900 m from the pad (outside the flatten disc, where rocks exist).
    const dir = latLonToDir((site.location.latDeg + 0.004) * DEG, (site.location.lonDeg - 0.007) * DEG);
    // The worker configuration of the renderer: a small resident pyramid and cache.
    const tp = await createTerrainProvider(defs, createFsTileSource(TILES), { bodies: ['earth'], residentLevel: 2, cacheBytes: 96 * 1024 * 1024 });
    for (const level of [12, 13, 14, 15, 16, 18, 20]) {
      const key = dirToTile(dir, level).key;
      await tp.prepareTile('earth', key, 'render');
      const bake = tp.bakeTile('earth', key);
      expect(bake.geometry.complete, `geometry of level ${level}`).toBe(true);
      expect(bake.normalMaterial.complete, `normal / material map of level ${level}`).toBe(true);
    }
  });
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

  it('launch-site pads are flat within 5 cm: over flatRadius, or over the core and the areas of a shaped pad', async () => {
    for (const s of Object.values(defs.sites).filter((x) => x.bodyId === 'earth')) {
      const c = latLonToDir(s.location.latDeg * DEG, s.location.lonDeg * DEG);
      await tp.ensureLoaded('earth', c, s.pad.blendRadius, `pad-${s.id}`);
      const h0 = tp.heightAt('earth', c, 1);
      if (typeof s.location.padElevation === 'number') expect(h0).toBeCloseTo(s.location.padElevation, 6);
      const rng = prng(31);
      const deviation = (east: number, north: number): number => {
        const d = offset(c, east, north, R);
        return Math.max(Math.abs(tp.heightAt('earth', d) - h0), Math.abs(tp.heightAt('earth', d, 0.3) - h0));
      };
      const shape = s.pad.shape;
      // The exactly flat part: the whole disc, or (request terrain-render-6) the core of a shaped pad.
      const flat = shape ? shape.coreRadius : s.pad.flatRadius;
      let worst = 0;
      for (let i = 0; i < 2000; i++) {
        const r = (flat - 1) * Math.sqrt(rng.next());
        const a = rng.range(0, 2 * Math.PI);
        worst = Math.max(worst, deviation(r * Math.cos(a), r * Math.sin(a)));
      }
      console.log(`[real earth] pad ${s.id}: elevation ${h0.toFixed(3)} m, max deviation over ${shape ? 'the core' : 'flatRadius'} (${flat} m) ${worst.toExponential(2)} m`);
      expect(worst).toBeLessThan(0.05);
      if (!shape) continue;
      // Its level areas (rectangles in the pad's east / north frame, turned clockwise by their heading).
      let worstArea = 0;
      for (const area of shape.areas) {
        const h = area.headingDeg * DEG;
        for (let i = 0; i < 200; i++) {
          const x = (area.halfEast - 1) * rng.range(-1, 1);
          const y = (area.halfNorth - 1) * rng.range(-1, 1);
          worstArea = Math.max(worstArea, deviation(area.east + x * Math.cos(h) + y * Math.sin(h), area.north - x * Math.sin(h) + y * Math.cos(h)));
        }
      }
      // Elsewhere inside flatRadius the ground keeps a share of its relief: not flat, and not the natural slope either.
      let relief = 0;
      for (let i = 0; i < 2000; i++) {
        const r = (s.pad.flatRadius - 1) * Math.sqrt(rng.next());
        const a = rng.range(0, 2 * Math.PI);
        relief = Math.max(relief, deviation(r * Math.cos(a), r * Math.sin(a)));
      }
      console.log(`[real earth] pad ${s.id}: max deviation on the ${shape.areas.length} areas ${worstArea.toExponential(2)} m, inside flatRadius (${s.pad.flatRadius} m, relief share ${shape.reliefShare}) ${relief.toFixed(2)} m`);
      expect(worstArea).toBeLessThan(0.05);
      if (shape.reliefShare > 0) expect(relief).toBeGreaterThan(0.05);
      expect(relief).toBeLessThan(15);
    }
  }, 300_000);

  coverageSuite(
    'earth',
    () => R,
    () => defs,
  );

  tileBorderSuite(
    'earth',
    () => R,
    () => defs,
  );

  ringTextureSuite(
    'earth',
    () => R,
    () => defs,
  );
});
