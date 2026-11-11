/** Geometry kernel: every primitive is valid on its own (normals, tangents, winding, watertightness). */
import { describe, expect, it } from 'vitest';
import { MeshBuilder, xf, type BuiltMesh } from '@/render/vehicle/geom/builder';
import { Profile, arcPath, ball, beam, bolt, bottle, box, extrude, fillet, frustum, iSection, lathe, pipe, rectPoly, ringSolid, rod, section, torus, tube, zipLoops, TAU } from '@/render/vehicle/geom/prims';
import { checkMesh } from '@/render/vehicle/geom/validate';

function make(fn: (b: MeshBuilder) => void, lod = 0): BuiltMesh {
  const b = new MeshBuilder(lod);
  b.mat('paint-white');
  fn(b);
  return b.build();
}

/** Signed volume by the divergence theorem: positive for outward-facing closed surfaces. */
function volume(m: BuiltMesh): number {
  const P = m.positions;
  const I = m.indices;
  let v = 0;
  for (let t = 0; t < I.length; t += 3) {
    const a = I[t]! * 3;
    const b = I[t + 1]! * 3;
    const c = I[t + 2]! * 3;
    v += P[a]! * (P[b + 1]! * P[c + 2]! - P[b + 2]! * P[c + 1]!) + P[a + 1]! * (P[b + 2]! * P[c]! - P[b]! * P[c + 2]!) + P[a + 2]! * (P[b]! * P[c + 1]! - P[b + 1]! * P[c]!);
  }
  return v / 6;
}

/** Fraction of triangles whose geometric normal agrees with the vertex normals. */
function facingAgreement(m: BuiltMesh): number {
  const P = m.positions;
  const N = m.normals;
  const I = m.indices;
  let ok = 0;
  for (let t = 0; t < I.length; t += 3) {
    const a = I[t]! * 3;
    const b = I[t + 1]! * 3;
    const c = I[t + 2]! * 3;
    const ux = P[b]! - P[a]!;
    const uy = P[b + 1]! - P[a + 1]!;
    const uz = P[b + 2]! - P[a + 2]!;
    const vx = P[c]! - P[a]!;
    const vy = P[c + 1]! - P[a + 1]!;
    const vz = P[c + 2]! - P[a + 2]!;
    const gx = uy * vz - uz * vy;
    const gy = uz * vx - ux * vz;
    const gz = ux * vy - uy * vx;
    const d = gx * (N[a]! + N[b]! + N[c]!) + gy * (N[a + 1]! + N[b + 1]! + N[c + 1]!) + gz * (N[a + 2]! + N[b + 2]! + N[c + 2]!);
    if (d > 0) ok++;
  }
  return ok / (I.length / 3);
}

function expectValid(m: BuiltMesh, closed = true): void {
  const r = checkMesh(m);
  expect(r.badNormals, 'normals').toBe(0);
  expect(r.badTangents, 'tangents').toBe(0);
  expect(r.degenerate, 'degenerate triangles').toBe(0);
  if (closed) expect(r.leaks, 'leaks').toEqual([]);
  expect(facingAgreement(m), 'winding agrees with normals').toBeGreaterThan(0.999);
}

describe('vehicle geometry kernel', () => {
  it('box, beam, frustum, rod, ring, torus, ball and bottle are watertight with outward faces', () => {
    const cases: [string, (b: MeshBuilder) => void, number][] = [
      ['box', (b) => box(b, 2, 3, 4, [1, 1, 1]), 24],
      ['beam', (b) => beam(b, [0, 0, 0], [3, 4, 0], 0.2, 0.1), 5 * 0.2 * 0.1],
      ['frustum', (b) => frustum(b, 1, 1, 0, 2, 64), Math.PI * 2],
      ['rod', (b) => rod(b, [1, 2, 3], [4, 6, 3], 0.5, 48), Math.PI * 0.25 * 5],
      ['ring', (b) => ringSolid(b, 1, 2, 0, 1, 64), Math.PI * 3],
      ['torus', (b) => torus(b, 3, 0.5, 1, 64, 24), 2 * Math.PI ** 2 * 3 * 0.25],
      ['ball', (b) => ball(b, 1, 0, 48, 24), (4 / 3) * Math.PI],
      ['bottle', (b) => bottle(b, 0.5, 2, 0.5, 48), Math.PI * 0.25 * 2 + (4 / 3) * Math.PI * 0.125],
    ];
    for (const [name, fn, vol] of cases) {
      const m = make(fn);
      expectValid(m);
      expect(volume(m) / vol, name).toBeGreaterThan(0.97);
      expect(volume(m) / vol, name).toBeLessThan(1.01);
    }
  });

  it('extrusions of convex and concave sections are watertight', () => {
    const m = make((b) => {
      extrude(b, rectPoly(1, 0.5, 0.1), 0, 2);
      b.at(xf.translate(5, 0, 0), () => extrude(b, iSection(0.4, 0.6, 0.04), 0, 3));
      section(b, iSection(0.2, 0.3, 0.02), [0, 5, 0], [2, 7, 1]);
      b.at(xf.translate(0, 0, 5), () => bolt(b, 0.02, 0.01));
    });
    expectValid(m);
    // I-section area = 2 flanges + web.
    const iArea = 2 * 0.4 * 0.04 + (0.6 - 0.08) * 0.04;
    const rectArea = 2 * 1 - 2 * 0.1 * 0.1;
    const sectionLength = Math.hypot(2, 2, 1);
    expect(volume(m)).toBeCloseTo(rectArea * 2 + iArea * 3 + (2 * 0.2 * 0.02 + 0.26 * 0.02) * sectionLength + 1.5 * Math.sqrt(3) * 0.02 ** 2 * 0.01, 5);
  });

  it('tubes follow bends, cap their ends and close loops without a twist', () => {
    const m = make((b) => {
      pipe(b, [[0, 0, 0], [0, 2, 0], [1.5, 2, 0], [1.5, 2, 2], [3, 0.5, 2]], 0.08, 0.3);
      tube(b, arcPath(2, 5, 0, TAU, 48), 0.1, { loop: true });
      // A loop out of plane (twist must be distributed).
      const path = [];
      for (let i = 0; i < 40; i++) {
        const a = (i / 40) * TAU;
        path.push([3 * Math.cos(a), 8 + Math.sin(2 * a), 3 * Math.sin(a)] as [number, number, number]);
      }
      tube(b, path, 0.07, { loop: true });
      tube(b, fillet([[0, 10, 0], [1, 10, 0], [1, 11, 0]], 0.2, 4), (i, n) => 0.05 + 0.02 * Math.sin((i / n) * 20));
    });
    expectValid(m);
    expect(volume(m)).toBeGreaterThan(0);
  });

  it('lathe: hard creases split normals, regions keep the surface watertight and map decal UVs', () => {
    const m = make((b) => {
      const p = Profile.at(0, 0).corner(2, 0).mark('a').to(2, 1).to(2, 3).to(2, 4).hard().mark('b').corner(0, 4);
      lathe(b, p, {
        segs: 64,
        regions: [
          { phi0: 0.5, phi1: 1.5, y0: 1, y1: 3, mat: 'decal', uv: [0.1, 0.2, 0.5, 0.4], span: ['a', 'b'] },
          { phi0: 6, phi1: 6.6, y0: 0, y1: 1, mat: 'paint-black', span: ['a', 'b'] },
        ],
        phis: undefined,
      });
    });
    expectValid(m);
    expect(volume(m) / (Math.PI * 16)).toBeGreaterThan(0.99);
    expect([...m.materialIds].sort()).toEqual(['decal', 'paint-black', 'paint-white']);
    // Decal UVs stay inside the atlas rectangle.
    const g = m.groups[m.materialIds.indexOf('decal')]!;
    for (let i = g.start; i < g.start + g.count; i++) {
      const v = m.indices[i]!;
      expect(m.uvs[v * 2]!).toBeGreaterThanOrEqual(0.1 - 0.02);
      expect(m.uvs[v * 2]!).toBeLessThanOrEqual(0.5 + 0.02);
      expect(m.uvs[v * 2 + 1]!).toBeGreaterThanOrEqual(0.2 - 1e-6);
      expect(m.uvs[v * 2 + 1]!).toBeLessThanOrEqual(0.4 + 1e-6);
    }
  });

  it('lathe: corrugation and partial revolutions', () => {
    const m = make((b) => {
      const p = Profile.at(1.9, 0).to(2, 0.1).mark('c0').to(2, 1.9).mark('c1').to(1.9, 2);
      lathe(b, p, { segs: 240, corr: { n: 40, amp: 0.02, span: ['c0', 'c1'] }, closed: false });
    });
    expectValid(m, false);
    let rMax = 0;
    for (let i = 0; i < m.positions.length; i += 3) rMax = Math.max(rMax, Math.hypot(m.positions[i]!, m.positions[i + 2]!));
    expect(rMax).toBeCloseTo(2.02, 3);
  });

  it('zipLoops triangulates the band between two loops with different vertex counts', () => {
    const m = make((b) => {
      b.begin(false, 'band');
      const A: number[] = [];
      const angA: number[] = [];
      const B: number[] = [];
      const angB: number[] = [];
      for (let i = 0; i < 20; i++) {
        const a = 0.3 + (i / 20) * TAU;
        A.push(b.v(2 * Math.cos(a), 0, -2 * Math.sin(a), 0, 1, 0, 1, 0, 0, 0, 0));
        angA.push(a);
      }
      for (let i = 0; i < 33; i++) {
        const a = -1 + (i / 33) * TAU;
        B.push(b.v(Math.cos(a), 0, -Math.sin(a), 0, 1, 0, 1, 0, 0, 0, 0));
        angB.push(a);
      }
      zipLoops(b, A, angA, B, angB);
    });
    const r = checkMesh(m);
    expect(r.degenerate).toBe(0);
    expect(m.indices.length / 3).toBe(53);
    expect(facingAgreement(m)).toBe(1);
    // Area of the annulus between the two polygons.
    let area = 0;
    const P = m.positions;
    for (let t = 0; t < m.indices.length; t += 3) {
      const a = m.indices[t]! * 3;
      const c = m.indices[t + 1]! * 3;
      const d = m.indices[t + 2]! * 3;
      area += 0.5 * Math.abs((P[c]! - P[a]!) * (P[d + 2]! - P[a + 2]!) - (P[c + 2]! - P[a + 2]!) * (P[d]! - P[a]!));
    }
    const poly = (n: number, r: number): number => 0.5 * n * r * r * Math.sin(TAU / n);
    expect(area).toBeCloseTo(poly(20, 2) - poly(33, 1), 6);
  });
});
