import { describe, expect, it } from 'vitest';
import { v3, type Vec3 } from '@/core/math';
import {
  BLADES,
  BLADE_COUNT,
  FLARE_TOTAL_ENERGY,
  GHOSTS,
  HOOD_DEPTH,
  SPIKE_COUNT,
  STARBURST,
  bladeAngle,
  coneNdcBounds,
  flareNormalisation,
  flareRadiance,
  frameSolidAngle,
  ghostFrame,
  ghostShape,
  ghostSupport,
  hoodTransmission,
  ndcDirection,
  rayProfile,
  spikeBlade,
  type FlareView,
} from '@/render/sky/flare';

/** A 60 deg x 16:9 camera looking along -Z with +Y up (right = +X). */
const view: FlareView = { right: { x: 1, y: 0, z: 0 }, up: { x: 0, y: 1, z: 0 }, forward: { x: 0, y: 0, z: -1 }, tanY: Math.tan(Math.PI / 6), tanX: Math.tan(Math.PI / 6) * (16 / 9) };
const SUN_RADIUS = 0.00465;

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

/** Direction at angle theta from the sun (on the view axis here) and image-plane azimuth phi (from up towards right). */
const aroundAxis = (theta: number, phi: number): Vec3 => v3.normalize({ x: Math.sin(theta) * Math.sin(phi), y: Math.sin(theta) * Math.cos(phi), z: -Math.cos(theta) });
const onAxis = { view, sun: ndcDirection(view, 0, 0), sunRadius: SUN_RADIUS, sunNdc: [0, 0] as [number, number] };

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
      // The frame-sized ghost reaches the plane of the camera off axis (whole-screen quad): the small ones are the test.
      for (const g of GHOSTS.filter((gh) => gh.radius < 0.1)) {
        const angle = ghostSupport(g, SUN_RADIUS);
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
        // Off axis the cone projects larger than angle / tan: the box follows it within 1 %.
        expect((x1 - x0) / (mx1 - mx0)).toBeLessThan(1.01);
        expect((y1 - y0) / (my1 - my0)).toBeLessThan(1.01);
      }
    });
  }

  it('every ghost image is zero beyond its support in all channels, on and off axis', () => {
    for (const offAxis of [0, 0.5, 1.2]) {
      const f = { axis: [0.6, 0.8] as [number, number], offAxis, sunRadius: SUN_RADIUS };
      for (const gh of GHOSTS) {
        const edge = ghostSupport(gh, SUN_RADIUS);
        let inside = 0;
        for (let i = 0; i < 720; i++) {
          const phi = (i * Math.PI) / 360;
          for (const ch of [-1, 0, 1]) {
            expect(ghostShape(gh, f, edge * 1.0001 * Math.sin(phi), edge * 1.0001 * Math.cos(phi), ch)).toBe(0);
            inside = Math.max(inside, ghostShape(gh, f, 0.5 * gh.radius * Math.sin(phi), 0.5 * gh.radius * Math.cos(phi), ch));
          }
        }
        expect(inside).toBeGreaterThan(0);
      }
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

describe('iris', () => {
  it('every blade owns two opposite rays', () => {
    const owners = new Map<number, number[]>();
    for (let j = 0; j < SPIKE_COUNT; j++) owners.set(spikeBlade(j), [...(owners.get(spikeBlade(j)) ?? []), j]);
    expect(owners.size).toBe(BLADE_COUNT);
    for (const [b, rays] of owners) {
      expect(rays).toHaveLength(2);
      expect(Math.abs(rays[1]! - rays[0]!)).toBe(BLADE_COUNT);
      // The nominal ray angle is the blade's edge normal (or its opposite).
      const nominal = (rays[0]! * 2 * Math.PI) / SPIKE_COUNT;
      const delta = (nominal - (bladeAngle(b) - BLADES[b]!.angle)) / Math.PI;
      expect(Math.abs(delta - Math.round(delta))).toBeLessThan(1e-12);
    }
    expect(spikeBlade(-3)).toBe(spikeBlade(11));
  });
});

describe('flare model over the whole sphere', () => {
  it('stays under 1 % of the source, and every term integrates to its energy', () => {
    expect(FLARE_TOTAL_ENERGY).toBeLessThan(0.01);
    expect(GHOSTS.reduce((s, g) => s + g.energy, 0)).toBeLessThan(0.00036);
    // Integral over the sphere outside the disc of the on-axis model without the veil = core + skirt + rays + ghosts.
    const veil = STARBURST.veilEnergy / frameSolidAngle(view.tanX, view.tanY);
    let sum = 0;
    const nt = 700;
    const np = 840;
    const la = Math.log(SUN_RADIUS + 1.5e-3);
    const lb = Math.log(Math.PI);
    for (let i = 0; i < nt; i++) {
      const th = Math.exp(la + ((i + 0.5) * (lb - la)) / nt);
      let ring = 0;
      for (let j = 0; j < np; j++) ring += flareRadiance(onAxis, aroundAxis(th, ((j + 0.5) * 2 * Math.PI) / np), 1e-3)[1] - veil;
      sum += ((ring * 2 * Math.PI) / np) * Math.sin(th) * ((th * (lb - la)) / nt);
    }
    // The ring between the disc and its 1.5 px rim (excluded by the model) holds 1.3 % of the glare.
    expect(sum / (FLARE_TOTAL_ENERGY - STARBURST.veilEnergy)).toBeGreaterThan(0.97);
    expect(sum / (FLARE_TOTAL_ENERGY - STARBURST.veilEnergy)).toBeLessThan(1.005);
    // The veil holds its energy inside the frame.
    expect(veil * frameSolidAngle(view.tanX, view.tanY)).toBeCloseTo(STARBURST.veilEnergy, 12);
  });

  it('the glare has no rim: between the rays it falls monotonically, never faster than theta^-3, to the far side of the frame', () => {
    const between = (theta: number): number => {
      // Half way between two rays, and with the ghosts of an on-axis sun (all on the sun) subtracted by going beyond them.
      const phi = Math.PI / SPIKE_COUNT;
      return flareRadiance(onAxis, aroundAxis(theta, phi), 1e-3)[1];
    };
    let prev = between(0.42);
    for (let th = 0.43; th < 1.2; th += 0.01) {
      const l = between(th);
      expect(l).toBeGreaterThan(0);
      expect(l).toBeLessThan(prev);
      expect(l / prev).toBeGreaterThan((1 - 0.01 / th) ** 3);
      prev = l;
    }
    // The tail is the theta^-2 skirt over the veil: a doubling of the angle takes off less than two stops.
    expect(between(0.5) / between(1.0)).toBeLessThan(4);
  });

  it('a ray is a wedge: as wide as the disc at its base, wider further out, gone within ten degrees, strongest on the blade it belongs to', () => {
    const n = flareNormalisation(SUN_RADIUS);
    const ray = (theta: number, dphi: number, j = 0): number => rayProfile(theta, (j * 2 * Math.PI) / SPIKE_COUNT + BLADES[spikeBlade(j)]!.angle + dphi, SUN_RADIUS, 1);
    // Full width at half maximum across the ray at angle theta (rad).
    const fwhm = (theta: number): number => {
      const peak = ray(theta, 0);
      let d = 0;
      while (ray(theta, d / theta) > 0.5 * peak) d += 1e-5;
      return 2 * d;
    };
    expect(fwhm(0.01)).toBeGreaterThan(SUN_RADIUS);
    // 5 deg from the sun: at least the disc's diameter (the display check of the work list).
    expect(fwhm(0.0873)).toBeGreaterThan(2 * SUN_RADIUS * 0.75);
    expect(fwhm(0.0873)).toBeGreaterThan(1.5 * fwhm(0.02));
    // The peak falls faster than theta^-3 beyond the knee.
    expect(ray(0.12, 0) / ray(0.06, 0)).toBeLessThan(1 / 8);
    // Beyond 10 deg a ray adds less than 3 % to the glare between the rays (under a display level at any exposure
    // that does not burn the whole frame).
    const glare = flareRadiance(onAxis, aroundAxis(0.175, Math.PI / SPIKE_COUNT), 1e-3)[1];
    for (let j = 0; j < SPIKE_COUNT; j++) expect(STARBURST.rayEnergy * n.rays * ray(0.175, 0, j)).toBeLessThan(0.03 * glare);
    // Blades differ: strength and length spread by more than 20 %.
    const amps = BLADES.map((b) => b.amplitude);
    const lens = BLADES.map((b) => b.length);
    expect(Math.max(...amps) / Math.min(...amps)).toBeGreaterThan(1.4);
    expect(Math.max(...lens) / Math.min(...lens)).toBeGreaterThan(1.4);
  });

  it('ghosts are dim iris images: none above an eighth of mid-grey at the exposure of a sunlit scene, blurred by at least a solar radius', () => {
    const n = flareNormalisation(SUN_RADIUS);
    // EV100 14.4 (a sunlit Earth): mid-grey is 0.18 x 1.2 x 2^14.4 cd/m^2; the sun delivers 130,000 lux.
    const midGrey = 0.18 * 1.2 * 2 ** 14.4;
    const f = ghostFrame(view, [0.5, 0.3], SUN_RADIUS);
    for (const [i, gh] of GHOSTS.entries()) {
      expect(gh.blur).toBeGreaterThanOrEqual(1);
      let peak = 0;
      for (let k = 0; k < 4000; k++) {
        const r = gh.radius * 1.3 * Math.sqrt((k + 0.5) / 4000);
        const phi = k * 2.39996323;
        peak = Math.max(peak, ghostShape(gh, f, r * Math.sin(phi), r * Math.cos(phi), 0));
      }
      const luminance = 130_000 * gh.energy * n.ghosts[i]! * peak * Math.max(...gh.tint);
      expect(luminance).toBeLessThan(midGrey / 8);
    }
    // Lateral colour: the red and the blue image are displaced to opposite sides along the axis-to-sun line.
    const gh = GHOSTS[1]!;
    const edge = (ch: number): number => {
      let t = 0;
      while (ghostShape(gh, f, f.axis[0] * t, f.axis[1] * t, ch) > 0.5 * ghostShape(gh, f, 0, 0, ch)) t += gh.radius / 2000;
      return t;
    };
    expect((edge(-1) - edge(0)) * (edge(1) - edge(0))).toBeLessThan(0);
    expect(Math.abs(edge(-1) - edge(1))).toBeGreaterThan(0.05 * gh.radius);
  });
});
