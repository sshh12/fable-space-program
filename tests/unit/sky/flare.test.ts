import { describe, expect, it } from 'vitest';
import { v3, type Vec3 } from '@/core/math';
import { GHOSTS, HOOD_DEPTH, coneNdcBounds, flareRadiance, ghostProfile, ghostSupport, hoodTransmission, ndcDirection, type FlareView } from '@/render/sky/flare';

/** A 60 deg x 16:9 camera looking along -Z with +Y up (right = +X). */
const view: FlareView = { right: { x: 1, y: 0, z: 0 }, up: { x: 0, y: 1, z: 0 }, forward: { x: 0, y: 0, z: -1 }, tanY: Math.tan(Math.PI / 6), tanX: Math.tan(Math.PI / 6) * (16 / 9) };

const project = (d: Vec3): [number, number] => {
  const w = v3.dot(d, view.forward);
  return [v3.dot(d, view.right) / (w * view.tanX), v3.dot(d, view.up) / (w * view.tanY)];
};

/** Deterministic directions spread over the cone of half-angle `angle` around c (rim included). */
function coneSamples(c: Vec3, angle: number, n: number): Vec3[] {
  const e1 = v3.normalize(v3.anyOrthogonal(c));
  const e2 = v3.cross(c, e1);
  const out: Vec3[] = [];
  for (let i = 0; i < n; i++) {
    const r = angle * Math.sqrt((i % 50) / 49);
    const phi = (i * 2.39996323) % (2 * Math.PI);
    out.push(v3.normalize(v3.add(v3.scale(c, Math.cos(r)), v3.add(v3.scale(e1, Math.sin(r) * Math.cos(phi)), v3.scale(e2, Math.sin(r) * Math.sin(phi))))));
  }
  return out;
}

describe('ghost quads: bounding boxes of their cones', () => {
  // Centres on the axis, far off axis (the ghosts of a sun near the frame edge) and outside the frame.
  for (const [x, y] of [
    [0, 0],
    [0.7, 0],
    [-0.94, 0.1],
    [0.9, 0.85],
    [-1.6, 0.3],
  ] as const) {
    it(`contains every direction of the cone and is tight (centre NDC ${x}, ${y})`, () => {
      const c = ndcDirection(view, x, y);
      for (const g of GHOSTS) {
        const angle = ghostSupport(g);
        const [x0, y0, x1, y1] = coneNdcBounds(view, c, angle);
        let mx0 = Infinity;
        let my0 = Infinity;
        let mx1 = -Infinity;
        let my1 = -Infinity;
        for (const d of coneSamples(c, angle, 4000)) {
          const [px, py] = project(d);
          expect(px).toBeGreaterThanOrEqual(x0);
          expect(px).toBeLessThanOrEqual(x1);
          expect(py).toBeGreaterThanOrEqual(y0);
          expect(py).toBeLessThanOrEqual(y1);
          mx0 = Math.min(mx0, px);
          my0 = Math.min(my0, py);
          mx1 = Math.max(mx1, px);
          my1 = Math.max(my1, py);
        }
        // Off axis the cone projects larger than angle / tan (the old quads): the box follows it within 1 %.
        expect((x1 - x0) / (mx1 - mx0)).toBeLessThan(1.01);
        expect((y1 - y0) / (my1 - my0)).toBeLessThan(1.01);
      }
    });
  }

  it('every ghost profile is zero beyond its support in all channels and not before it', () => {
    for (const gh of GHOSTS) {
      const edge = ghostSupport(gh) / gh.radius;
      for (const s of [-gh.chroma, 0, gh.chroma]) expect(ghostProfile(edge * 1.0001, gh.softness, s)).toBe(0);
      expect(ghostProfile(edge * 0.999, gh.softness, -gh.chroma)).toBeGreaterThan(0);
    }
  });
});

describe('lens hood', () => {
  it('passes everything inside the frame and nothing beyond its cut-off, continuously and monotonically', () => {
    expect(hoodTransmission(0, 0)).toBe(1);
    expect(hoodTransmission(1 / HOOD_DEPTH, 0)).toBe(0);
    expect(hoodTransmission(0, 1 / HOOD_DEPTH + 0.1)).toBe(0);
    // Half the pupil lit when the hood's shadow edge crosses its centre.
    expect(hoodTransmission(0.5 / HOOD_DEPTH, 0)).toBeCloseTo(0.5, 12);
    let prev = 1;
    for (let i = 1; i <= 1000; i++) {
      const t = hoodTransmission(i / (1000 * HOOD_DEPTH), 0);
      expect(t).toBeLessThanOrEqual(prev);
      expect(prev - t).toBeLessThan(0.003);
      prev = t;
    }
    expect(hoodTransmission(0.1, 0.1)).toBeCloseTo(hoodTransmission(0.1, 0) ** 2, 12);
  });
});

describe('flare model over the whole sphere', () => {
  it('the glare halo has no rim: it keeps falling as a power law out to the far side of the frame', () => {
    const sun = ndcDirection(view, 0, 0);
    const g = { view, sun, sunRadius: 0.00465, sunNdc: [0, 0] as [number, number] };
    // Between the spikes (half a spike spacing from the image-plane up direction), so only the halo and spike tails remain.
    const along = (theta: number) => {
      const phi = Math.PI / 14;
      const d = v3.normalize({ x: Math.sin(theta) * Math.sin(phi), y: Math.sin(theta) * Math.cos(phi), z: -Math.cos(theta) });
      return flareRadiance(g, d, 1e-3)[1];
    };
    // Beyond the ghosts (centred on the sun here; the largest reaches 0.084 rad).
    let prev = along(0.09);
    for (let th = 0.1; th < 1.2; th += 0.01) {
      const l = along(th);
      expect(l).toBeGreaterThan(0);
      expect(l).toBeLessThan(prev);
      // theta^-3 falls by (1 - 0.01 / theta)^3 per step: never a step to zero.
      expect(l / prev).toBeGreaterThan(0.5);
      prev = l;
    }
  });
});
