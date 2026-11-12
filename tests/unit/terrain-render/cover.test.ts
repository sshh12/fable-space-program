import { describe, expect, it } from 'vitest';
import { buildCoverMesh, COVER_LODS, COVER_SHAPES, COVER_VARIANTS, COVER_VERTEX_FLOATS } from '@/render/terrain/coverMesh';
import { buildSitePlan, MAX_SITE_SHAPES, packSiteShapes, SHAPE_GRAVEL, SHAPE_SLAB, siteGround } from '@/render/terrain/sitePlan';

const TUNABLES = { apronRadiusM: 140, apronMarginM: 6, apronShoulderM: 14 };

describe('site ground plan', () => {
  const structure = (offsetEnu: [number, number, number], headingDeg: number, params: Record<string, number | string>) => ({ model: 'structure', offsetEnu, headingDeg, params });
  const site = {
    pad: { flatRadius: 450, blendRadius: 900, clampHeight: 18 },
    structures: [
      structure([0, 0, 0], 0, { halfX: 62, halfZ: 62 }),
      structure([-260, -190, 0], 30, { halfX: 34, halfZ: 26 }),
      structure([-150, -62, 0], 0, { sizeX: 32, sizeZ: 14, height: 7 }),
      structure([-228, 0, 0], 90, { length: 330, trackWidth: 12, median: 14 }),
      structure([52, 86, 0], 0, { height: 165 }),
    ],
  };
  const plan = buildSitePlan(site, TUNABLES);

  it('takes slabs, building pads and lane beds from the footprint parameters of the structures', () => {
    expect(plan.shapes.map((s) => s.kind)).toEqual([SHAPE_SLAB, SHAPE_SLAB, SHAPE_SLAB, SHAPE_GRAVEL]);
    expect(plan.shapes[0]).toMatchObject({ e: 0, n: 0, halfX: 68, halfZ: 68 });
    expect(plan.shapes[2]).toMatchObject({ halfX: 22, halfZ: 13 });
    // The lane bed runs along the structure's z axis: at heading 90 that is east-west.
    expect(plan.shapes[3]!.halfZ).toBe(165);
    expect(plan.reach).toBeGreaterThan(Math.hypot(260, 190));
    expect(plan.shapes.length).toBeLessThanOrEqual(MAX_SITE_SHAPES);
  });

  it('measures signed distances to the concrete and to the gravel around it', () => {
    // Inside the main slab, on its edge, beyond it.
    expect(siteGround(plan, 0, 0).concrete).toBeCloseTo(-68, 6);
    expect(siteGround(plan, 68, 0).concrete).toBeCloseTo(0, 6);
    expect(siteGround(plan, 80, 0).concrete).toBeCloseTo(12, 6);
    // Corners are rounded by the margin: the corner point of the square is outside.
    expect(siteGround(plan, 68, 68).concrete).toBeGreaterThan(1);
    // The shoulder: gravel reaches 14 m beyond the concrete.
    expect(siteGround(plan, 80, 0).gravel).toBeCloseTo(-2, 6);
    expect(siteGround(plan, 68 + 14, 0).gravel).toBeCloseTo(0, 6);
    // The lane bed (east-west through -228, 0): inside it far from any slab, outside it to the north.
    expect(siteGround(plan, -330, 0).gravel).toBeLessThan(-10);
    expect(siteGround(plan, -330, 60).gravel).toBeGreaterThan(10);
    // The frame of the nearest slab: a point 10 m "structure-east" of the turned tank-farm slab.
    const h = (30 * Math.PI) / 180;
    const q = siteGround(plan, -260 + 10 * Math.cos(h), -190 - 10 * Math.sin(h));
    expect(q.qx).toBeCloseTo(10, 5);
    expect(q.qz).toBeCloseTo(0, 5);
  });

  it('gives a site without slabs one square hardstand, and a body without aprons nothing', () => {
    const bare = buildSitePlan({ pad: site.pad, structures: [] }, TUNABLES);
    expect(bare.shapes).toHaveLength(1);
    expect(bare.shapes[0]).toMatchObject({ kind: SHAPE_SLAB, halfX: 140, halfZ: 140 });
    expect(buildSitePlan(site, { ...TUNABLES, apronRadiusM: 0 }).shapes).toHaveLength(0);
  });

  it('packs two rows per shape', () => {
    const out = new Float32Array(plan.shapes.length * 8);
    packSiteShapes(plan, out, 0);
    expect(Array.from(out.subarray(8, 16))).toEqual([-260, -190, 40, 32, Math.fround(Math.cos((30 * Math.PI) / 180)), Math.fround(Math.sin((30 * Math.PI) / 180)), SHAPE_SLAB, 6]);
  });
});

describe('ground cover meshes', () => {
  it('are finite, indexed in range, with unit normals, and thin out with the level of detail', () => {
    for (const shape of COVER_SHAPES) {
      for (let variant = 0; variant < COVER_VARIANTS; variant++) {
        const counts: number[] = [];
        for (let lod = 0; lod < COVER_LODS; lod++) {
          const m = buildCoverMesh(shape, variant, lod);
          const n = m.vertices.length / COVER_VERTEX_FLOATS;
          expect(Number.isInteger(n)).toBe(true);
          expect(m.indices.length % 3).toBe(0);
          counts.push(m.indices.length / 3);
          for (const i of m.indices) expect(i).toBeLessThan(n);
          for (let v = 0; v < n; v++) {
            const o = v * COVER_VERTEX_FLOATS;
            for (let k = 0; k < COVER_VERTEX_FLOATS; k++) expect(Number.isFinite(m.vertices[o + k]!)).toBe(true);
            expect(Math.hypot(m.vertices[o + 3]!, m.vertices[o + 4]!, m.vertices[o + 5]!)).toBeCloseTo(1, 3);
          }
        }
        // (A grove's finest level is its middle one.)
        expect(counts[0]!).toBeGreaterThanOrEqual(counts[1]!);
        expect(counts[1]!).toBeGreaterThanOrEqual(counts[2]!);
        expect(counts[0]!).toBeGreaterThan(counts[2]!);
        // The far level is what thousands of instances are drawn with.
        expect(counts[2]!).toBeLessThanOrEqual(shape === 'grove' ? 140 : 100);
        // The finest level is drawn for a handful of instances near the eye (a tree's is its whole frame of
        // limbs, branches and twigs with four leaf sprays at every twig end).
        expect(counts[0]!).toBeLessThanOrEqual(shape === 'tree' ? 12000 : 3600);
      }
    }
  });

  it('plants keep their size across levels of detail: unit footprint and height, base on the ground', () => {
    for (const shape of ['tuft', 'bush', 'tree', 'grove'] as const) {
      for (let variant = 0; variant < COVER_VARIANTS; variant++) {
        for (let lod = 0; lod < COVER_LODS; lod++) {
          const m = buildCoverMesh(shape, variant, lod);
          let reach = 0;
          let top = 0;
          let low = Infinity;
          for (let o = 0; o < m.vertices.length; o += COVER_VERTEX_FLOATS) {
            reach = Math.max(reach, Math.hypot(m.vertices[o]!, m.vertices[o + 1]!));
            top = Math.max(top, m.vertices[o + 2]!);
            low = Math.min(low, m.vertices[o + 2]!);
          }
          // The finest level fills the unit cylinder; coarser levels have fewer, larger pieces of the same build.
          if (lod === 0) {
            expect(reach).toBeGreaterThan(0.9);
            expect(top).toBeGreaterThan(0.9);
          }
          expect(reach).toBeLessThan(1.75);
          expect(top).toBeLessThan(1.6);
          expect(low).toBeGreaterThan(-0.35);
        }
      }
    }
  });
});
