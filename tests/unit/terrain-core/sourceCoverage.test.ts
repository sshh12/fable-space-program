/**
 * The height layer's optional `sourceCoverage` (docs/requests/terrain-core-1.md): where a sparse level holds
 * data genuinely finer than its parent. The bakes extend `coverage` beyond it with parent-identical data; the
 * effective level E keys on `sourceCoverage` (rising over SOURCE_BLEND_TILES inside its boundary), the data
 * blend D keeps using `coverage`. Checked on the synthetic sparse set with source rectangles added: region A has
 * source = coverage at levels 3-5; region B (straddling the face 0 / face 2 cube edge) has a one-tile margin of
 * parent-level data on each face at levels 3 and 4, and its source boundaries lie on both faces.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { TileManifest, TileRect, TileSource } from '../../../src/core/contracts/terrain';
import { tileUvToDir, type FaceId } from '../../../src/core/geo/cubeSphere';
import type { Vec3 } from '../../../src/core/math/vec3';
import { SOURCE_BLEND_TILES } from '../../../src/terrain/coverage';
import { createFsTileSource } from '../../../src/terrain/fsTileSource';
import { createTerrainProvider, type TerrainAuthority } from '../../../src/terrain/provider';
import { fixtureDefs, MOON_R } from '../../../tools/terrain-core/fixtures';
import { boundaryPoints, edgeStats, loadAround, truncatedSource, type BoundaryPoint, type LayerWithSource } from './edgeChecks';
import { fixtureRoot, prng, REPO_ROOT } from './helpers';

const SOURCE: Record<string, TileRect[]> = {
  '3': [
    { face: 0, x0: 3, y0: 3, x1: 5, y1: 5 },
    { face: 0, x0: 7, y0: 3, x1: 7, y1: 4 },
    { face: 2, x0: 0, y0: 3, x1: 0, y1: 4 },
  ],
  '4': [
    { face: 0, x0: 7, y0: 7, x1: 9, y1: 9 },
    { face: 0, x0: 14, y0: 7, x1: 15, y1: 8 },
    { face: 2, x0: 0, y0: 7, x1: 1, y1: 8 },
  ],
  '5': [{ face: 0, x0: 15, y0: 15, x1: 18, y1: 18 }],
};

/** The fixture source with `sourceCoverage` added to the moon height layer. */
function withSource(src: TileSource, sc: Record<string, TileRect[]>): TileSource {
  return {
    async manifest(tileset: string): Promise<TileManifest> {
      const m = JSON.parse(JSON.stringify(await src.manifest(tileset))) as TileManifest;
      if (tileset === 'fixture-moon') (m.layers['height'] as LayerWithSource).sourceCoverage = JSON.parse(JSON.stringify(sc)) as Record<string, TileRect[]>;
      return m;
    },
    tile: (t, l, k) => src.tile(t, l, k),
    file: (t, r) => src.file(t, r),
  };
}

/** Random points in the tiles of `level` that are in coverage but not in the source rectangles (the margin). */
function marginPoints(m: TileManifest, level: number, count: number, seed: number): Vec3[] {
  const tiles: { face: FaceId; x: number; y: number }[] = [];
  const inSource = (f: number, x: number, y: number): boolean => (SOURCE[String(level)] ?? []).some((r) => r.face === f && x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1);
  for (const r of m.layers['height']!.coverage[String(level)]!) {
    for (let x = r.x0; x <= r.x1; x++) for (let y = r.y0; y <= r.y1; y++) if (!inSource(r.face, x, y)) tiles.push({ face: r.face, x, y });
  }
  const rng = prng(seed);
  const out: Vec3[] = [];
  for (let i = 0; i < count; i++) {
    const t = tiles[Math.floor(rng.next() * tiles.length)]!;
    out.push(tileUvToDir({ face: t.face, level, x: t.x, y: t.y }, rng.next(), rng.next()));
  }
  return out;
}

describe('sourceCoverage: the effective level follows where data is finer than its parent', () => {
  let manifest: TileManifest;
  let src: TileSource;
  let plain: TileSource;
  let amp: TerrainAuthority;
  let ampPlain: TerrainAuthority;
  let none: TerrainAuthority;
  let nonePlain: TerrainAuthority;
  const srcPts = new Map<number, BoundaryPoint[]>();

  beforeAll(async () => {
    plain = createFsTileSource(await fixtureRoot());
    src = withSource(plain, SOURCE);
    manifest = await src.manifest('fixture-moon');
    const defsAmp = await fixtureDefs(REPO_ROOT);
    const defsNone = await fixtureDefs(REPO_ROOT, { model: 'none' });
    [amp, ampPlain, none, nonePlain] = await Promise.all([
      createTerrainProvider(defsAmp, src, { bodies: ['moon'] }),
      createTerrainProvider(defsAmp, plain, { bodies: ['moon'] }),
      createTerrainProvider(defsNone, src, { bodies: ['moon'] }),
      createTerrainProvider(defsNone, plain, { bodies: ['moon'] }),
    ]);
    const sourceLayer = { ...manifest.layers['height']!, coverage: SOURCE };
    for (const L of [3, 4]) {
      const p = boundaryPoints(sourceLayer, L, 300, prng(700 + L));
      srcPts.set(L, p);
      const dirs = p.map((q) => q.p);
      await Promise.all([loadAround(amp, 'moon', dirs, 2, `s${L}-`), loadAround(ampPlain, 'moon', dirs, 2, `s${L}-`)]);
    }
  }, 120_000);

  it('the data height D is unchanged (it keeps using coverage); only E and what keys on it change', async () => {
    const rng = prng(5);
    const pts: Vec3[] = [];
    for (const L of [3, 4]) pts.push(...marginPoints(manifest, L, 40, 10 + L));
    for (let i = 0; i < 40; i++) pts.push(tileUvToDir({ face: 0, level: 5, x: 15 + Math.floor(rng.next() * 4), y: 15 + Math.floor(rng.next() * 4) }, rng.next(), rng.next()));
    await Promise.all([loadAround(none, 'moon', pts, 2, 'd'), loadAround(nonePlain, 'moon', pts, 2, 'd')]);
    for (const p of pts) {
      for (const lam of [0.3, 5, 300]) expect(none.heightAt('moon', p, lam)).toBe(nonePlain.heightAt('moon', p, lam));
      expect(none.heightAt('moon', p)).toBe(nonePlain.heightAt('moon', p));
    }
  });

  it('in the coverage margin E is the parent-level E (the margin adds no level); deep inside a source rect E is the level', async () => {
    for (const L of [3, 4]) {
      const parent = await createTerrainProvider(await fixtureDefs(REPO_ROOT), truncatedSource(src, L), { bodies: ['moon'] });
      let worst = 0;
      for (const p of marginPoints(manifest, L, 200, 20 + L)) {
        const e = amp.residency('moon', p).effectiveLevel;
        worst = Math.max(worst, Math.abs(e - parent.residency('moon', p).effectiveLevel));
        expect(e).toBeLessThanOrEqual(L - 1 + 1e-12);
        // Without sourceCoverage the margin counts as level L (the defect this field fixes).
        expect(ampPlain.residency('moon', p).effectiveLevel).toBeGreaterThan(e);
      }
      expect(worst, `L${L}`).toBe(0);
    }
    // Level 5: source = coverage (4 x 4 tiles); the middle of the inner 2 x 2 tiles lies >= SOURCE_BLEND_TILES
    // from every missing neighbour.
    expect(SOURCE_BLEND_TILES).toBeLessThanOrEqual(1.25);
    const rng = prng(9);
    for (let i = 0; i < 100; i++) {
      const p = tileUvToDir({ face: 0, level: 5, x: 16 + Math.floor(rng.next() * 2), y: 16 + Math.floor(rng.next() * 2) }, 0.25 + 0.5 * rng.next(), 0.25 + 0.5 * rng.next());
      expect(Math.abs(amp.residency('moon', p).effectiveLevel - 5)).toBeLessThan(1e-12);
    }
  });

  it('E and what the source ring adds are continuous across source boundaries (incl. the cube edge)', () => {
    expect(new Set(srcPts.get(3)!.map((q) => q.key.face))).toEqual(new Set([0, 2]));
    for (const L of [3, 4]) {
      // Delta = H(sourceCoverage) - H(coverage-keyed E): what keying E on the source rectangles changes.
      const s = edgeStats(amp, ampPlain, 'moon', MOON_R, srcPts.get(L)!, 0.32, 0.32);
      console.log(`[sourceCoverage L${L} boundary]`, JSON.stringify(s));
      expect(s.maxEJump).toBeLessThan(1e-6);
      expect(s.deltaJump).toBeLessThan(1e-3);
      expect(s.deltaSlopeChange).toBeLessThan(0.005);
    }
  });

  it('the coverage-edge guarantees still hold with sourceCoverage: parent surface on the boundary, no jump, E continuous', async () => {
    for (const L of [3, 4, 5]) {
      const pts = boundaryPoints(manifest.layers['height']!, L, 300, prng(800 + L));
      const parent = await createTerrainProvider(await fixtureDefs(REPO_ROOT), truncatedSource(src, L), { bodies: ['moon'] });
      const dirs = pts.map((q) => q.p);
      await Promise.all([loadAround(amp, 'moon', dirs, 2, `c${L}-`), loadAround(parent, 'moon', dirs, 2, 'c')]);
      const s = edgeStats(amp, parent, 'moon', MOON_R, pts, 0.32, 0.32);
      console.log(`[sourceCoverage, coverage edge L${L}]`, JSON.stringify(s));
      expect(s.maxParentDiff).toBeLessThan(1e-6);
      expect(s.deltaJump).toBeLessThan(1e-3);
      expect(s.deltaSlopeChange).toBeLessThan(0.005);
      expect(s.maxEJump).toBeLessThan(1e-6);
    }
  });

  it('E stays a pure function of the manifest (independent of residency)', async () => {
    const fresh = await createTerrainProvider(await fixtureDefs(REPO_ROOT), src, { bodies: ['moon'] });
    for (const L of [3, 4]) {
      for (const q of srcPts.get(L)!.slice(0, 100)) {
        expect(fresh.residency('moon', q.inside).complete).toBe(false);
        expect(fresh.residency('moon', q.inside).effectiveLevel).toBe(amp.residency('moon', q.inside).effectiveLevel);
      }
    }
  });

  it('rejects a manifest whose sourceCoverage leaves the coverage', async () => {
    const bad = withSource(plain, { ...SOURCE, '5': [{ face: 0, x0: 14, y0: 15, x1: 17, y1: 18 }] });
    await expect(createTerrainProvider(await fixtureDefs(REPO_ROOT), bad, { bodies: ['moon'] })).rejects.toThrow(/sourceCoverage tile 5\/0\/14\/15 lies outside the coverage/);
    const global = withSource(plain, { '2': [{ face: 0, x0: 0, y0: 0, x1: 0, y1: 0 }] });
    await expect(createTerrainProvider(await fixtureDefs(REPO_ROOT), global, { bodies: ['moon'] })).rejects.toThrow(/not a sparse level/);
  });
});
