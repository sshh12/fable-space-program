import { describe, expect, it } from 'vitest';
import { COVERAGE_BLEND_TILES, type TileLayerManifest } from '@/core/contracts/terrain';
import { CUBE_FACES, dirToFaceSt, tileUvToDir } from '@/core/geo/cubeSphere';
import { materialRegions, type MaterialRegion } from '@/render/terrain/materials';

const layer = (coverage: TileLayerManifest['coverage']): TileLayerManifest => ({ globalMaxLevel: 7, coverage }) as unknown as TileLayerManifest;

/** The twin of regionShare in shaders/surface.ts. */
function regionShare(regions: MaterialRegion[], dir: { x: number; y: number; z: number }): number {
  let share = 0;
  for (const r of regions) {
    const f = CUBE_FACES[r.face]!;
    const dn = dir.x * f.n[0] + dir.y * f.n[1] + dir.z * f.n[2];
    if (dn <= 0) continue;
    const s = (dir.x * f.u[0] + dir.y * f.u[1] + dir.z * f.u[2]) / dn;
    const t = (dir.x * f.v[0] + dir.y * f.v[1] + dir.z * f.v[2]) / dn;
    const d = Math.min(s - r.s0, r.s1 - s, t - r.t0, r.t1 - t);
    const x = Math.min(1, Math.max(0, d / r.feather));
    share = Math.max(share, x * x * (3 - 2 * x));
  }
  return share;
}

describe('regions of calibrated ground', () => {
  const rect = { face: 1 as const, x0: 182, y0: 172, x1: 189, y1: 179 };
  const regions = materialRegions(layer({ '8': [rect], '9': [{ face: 1, x0: 370, y0: 350, x1: 372, y1: 352 }] }), 7);

  it('are the rectangles of the first regional level of the imagery, in face coordinates', () => {
    expect(regions).toHaveLength(1);
    const r = regions[0]!;
    expect(r.face).toBe(1);
    expect(r.s0).toBeCloseTo(-1 + (2 * 182) / 256, 12);
    expect(r.s1).toBeCloseTo(-1 + (2 * 190) / 256, 12);
    expect(r.t0).toBeCloseTo(-1 + (2 * 172) / 256, 12);
    expect(r.t1).toBeCloseTo(-1 + (2 * 180) / 256, 12);
    expect(r.feather).toBeCloseTo((2 * COVERAGE_BLEND_TILES) / 256, 12);
  });

  it('cover a place whatever tile shows it: full inside, nothing outside, a feather of a quarter tile inside the edge', () => {
    // The middle of the region, the middle of a tile on its edge, a point a tenth of a tile inside, and tiles beyond.
    expect(regionShare(regions, tileUvToDir({ face: 1, level: 8, x: 185, y: 175 }, 0.5, 0.5))).toBe(1);
    expect(regionShare(regions, tileUvToDir({ face: 1, level: 8, x: 182, y: 175 }, 0.5, 0.5))).toBe(1);
    const inside = regionShare(regions, tileUvToDir({ face: 1, level: 8, x: 182, y: 175 }, 0.1, 0.5));
    expect(inside).toBeGreaterThan(0.2);
    expect(inside).toBeLessThan(0.5);
    expect(regionShare(regions, tileUvToDir({ face: 1, level: 8, x: 181, y: 175 }, 0.9, 0.5))).toBe(0);
    expect(regionShare(regions, tileUvToDir({ face: 1, level: 8, x: 185, y: 181 }, 0.5, 0.5))).toBe(0);
    // The same face coordinates on the opposite face are not the region.
    const st = dirToFaceSt(tileUvToDir({ face: 1, level: 8, x: 185, y: 175 }, 0.5, 0.5));
    expect(st.face).toBe(1);
    expect(regionShare(regions, tileUvToDir({ face: 0, level: 8, x: 185, y: 175 }, 0.5, 0.5))).toBe(0);
  });

  it('a body calibrated as a whole, or a layer without regional levels, has none', () => {
    expect(materialRegions(layer({ '8': [rect] }), -1)).toEqual([]);
    expect(materialRegions(layer({}), 7)).toEqual([]);
  });
});
