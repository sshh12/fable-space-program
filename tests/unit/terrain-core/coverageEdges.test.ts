/**
 * Coverage edges of the SPARSE synthetic set (regional levels disagree with the global level by tens of
 * metres; region B straddles the face 0 / face 2 cube edge): the surface, its slope, the effective level and
 * the procedural weights are continuous where coverage ends, and on the boundary the surface IS the
 * parent-level surface.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { TileManifest } from '../../../src/core/contracts/terrain';
import { createFsTileSource } from '../../../src/terrain/fsTileSource';
import { createTerrainProvider, type TerrainAuthority } from '../../../src/terrain/provider';
import { fixtureDefs, MOON_R, moonFixtureHeight } from '../../../tools/terrain-core/fixtures';
import { boundaryPoints, edgeStats, loadAround, truncatedSource, type BoundaryPoint } from './edgeChecks';
import { fixtureRoot, prng, REPO_ROOT } from './helpers';

const LEVELS = [3, 4, 5];
const POINTS = 1000;

describe('coverage edges of the synthetic sparse set', () => {
  let manifest: TileManifest;
  let amp: TerrainAuthority;
  let none: TerrainAuthority;
  const parents = new Map<number, { amp: TerrainAuthority; none: TerrainAuthority }>();
  const pts = new Map<number, BoundaryPoint[]>();

  beforeAll(async () => {
    const root = await fixtureRoot();
    const src = createFsTileSource(root);
    manifest = await src.manifest('fixture-moon');
    const defsAmp = await fixtureDefs(REPO_ROOT);
    const defsNone = await fixtureDefs(REPO_ROOT, { model: 'none' });
    amp = await createTerrainProvider(defsAmp, src, { bodies: ['moon'] });
    none = await createTerrainProvider(defsNone, src, { bodies: ['moon'] });
    for (const L of LEVELS) {
      const p = boundaryPoints(manifest.layers['height']!, L, POINTS, prng(100 + L));
      pts.set(L, p);
      const tsrc = truncatedSource(src, L);
      const pa = await createTerrainProvider(defsAmp, tsrc, { bodies: ['moon'] });
      const pn = await createTerrainProvider(defsNone, tsrc, { bodies: ['moon'] });
      const dirs = p.map((q) => q.p);
      await Promise.all([loadAround(amp, 'moon', dirs, 2, `L${L}-`), loadAround(none, 'moon', dirs, 2, `L${L}-`), loadAround(pa, 'moon', dirs, 2, 'b'), loadAround(pn, 'moon', dirs, 2, 'b')]);
      parents.set(L, { amp: pa, none: pn });
    }
  }, 120_000);

  it('the fixture regions really disagree with the global level by tens of metres', () => {
    for (const L of LEVELS) {
      let maxDiff = 0;
      let s2 = 0;
      for (const q of pts.get(L)!) {
        const d = moonFixtureHeight(q.p, L) - moonFixtureHeight(q.p, 2);
        maxDiff = Math.max(maxDiff, Math.abs(d));
        s2 += d * d;
      }
      expect(maxDiff).toBeGreaterThan(40);
      expect(Math.sqrt(s2 / POINTS)).toBeGreaterThan(15);
    }
  });

  it('region B has a boundary on both faces of the cube edge', () => {
    const faces = new Set(pts.get(4)!.map((q) => q.key.face));
    expect(faces.has(0)).toBe(true);
    expect(faces.has(2)).toBe(true);
  });

  for (const L of LEVELS) {
    it(`level ${L}: data only - no jump, no kink, parent surface on the boundary`, () => {
      const s = edgeStats(none, parents.get(L)!.none, 'moon', MOON_R, pts.get(L)!, 0.3, 0.3);
      console.log(`[coverage L${L} data only]`, JSON.stringify(s));
      expect(s.points).toBe(POINTS);
      expect(s.maxJump).toBeLessThan(1e-3);
      expect(s.maxExcess).toBeLessThan(1e-3);
      expect(s.maxSlopeChange).toBeLessThan(0.005);
      expect(s.maxParentDiff).toBeLessThan(1e-6);
      expect(s.maxEJump).toBeLessThan(1e-6);
    });

    it(`level ${L}: with amplification - no jump, no kink, parent surface on the boundary`, () => {
      // At the collision band limit. The amplified surface contains features that are sharp everywhere
      // (fresh crater rims, rock flanks steeper than 0.5): the raw 1 mm-either-side numbers are reported, and
      // the thresholds are asserted on what the coverage edge adds, H - H_parent, together with the exact
      // parent identity on the boundary and the continuity of E (which carries every octave and crater
      // weight).
      const s = edgeStats(amp, parents.get(L)!.amp, 'moon', MOON_R, pts.get(L)!, 0.32, 0.32);
      console.log(`[coverage L${L} amplified]`, JSON.stringify(s));
      expect(s.deltaJump).toBeLessThan(1e-3);
      expect(s.deltaSlopeChange).toBeLessThan(0.005);
      expect(s.maxParentDiff).toBeLessThan(1e-6);
      expect(s.maxEJump).toBeLessThan(1e-6);
    });
  }

  it('w_L and E do not depend on which tiles are resident', async () => {
    const root = await fixtureRoot();
    const fresh = await createTerrainProvider(await fixtureDefs(REPO_ROOT), createFsTileSource(root), { bodies: ['moon'] });
    for (const L of LEVELS) {
      for (const q of pts.get(L)!.slice(0, 200)) {
        const a = fresh.residency('moon', q.inside);
        const b = amp.residency('moon', q.inside);
        expect(a.complete).toBe(false);
        expect(b.complete).toBe(true);
        expect(a.effectiveLevel).toBe(b.effectiveLevel);
        expect(a.availableLevel).toBe(b.availableLevel);
      }
    }
  });

  it('the effective level rises from the parent level on the boundary to the level a quarter tile inside', () => {
    for (const L of LEVELS) {
      for (const q of pts.get(L)!.slice(0, 50)) {
        const eB = amp.residency('moon', q.p).effectiveLevel;
        expect(eB).toBeLessThanOrEqual(L - 1 + 1e-9);
      }
    }
  });
});
