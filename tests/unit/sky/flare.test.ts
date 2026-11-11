import { describe, expect, it } from 'vitest';
import { v3, type Vec3 } from '@/core/math';
import {
  BLADES,
  BLADE_COUNT,
  FLARE_TOTAL_ENERGY,
  GHOSTS,
  HOOD_DEPTH,
  RAY_REACH,
  SPIKE_COUNT,
  SPIKE_LAMBDA,
  STARBURST,
  STREAKS,
  STREAK_COUNT,
  bladeAngle,
  coneNdcBounds,
  flareNormalisation,
  flareRadiance,
  ghostFrame,
  ghostImage,
  ghostShape,
  ghostSupport,
  hoodTransmission,
  ndcDirection,
  rayProfile,
  spikeAmplitude,
  spikeBlade,
  streakProfile,
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
          for (const blue of [false, true]) {
            expect(ghostShape(gh, f, edge * 1.0001 * Math.sin(phi), edge * 1.0001 * Math.cos(phi), blue)).toBe(0);
            inside = Math.max(inside, ghostShape(gh, f, 0.8 * gh.radius * Math.sin(phi), 0.8 * gh.radius * Math.cos(phi), blue));
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

const lumaOf = (c: readonly number[]): number => 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;

describe('flare model over the whole sphere', () => {
  it('stays under 1 % of the source, and the terms integrate to their energies', () => {
    expect(FLARE_TOTAL_ENERGY).toBeLessThan(0.01);
    expect(GHOSTS.reduce((s, g) => s + g.energy, 0)).toBeLessThan(0.00036);
    // Luminance of the on-axis model integrated over the sphere outside the disc's 1.5 px rim. Rings in log steps;
    // the azimuth step follows the narrowest streak (half its width).
    let sum = 0;
    const nt = 420;
    const la = Math.log(SUN_RADIUS + 1.5e-3);
    const lb = Math.log(Math.PI);
    for (let i = 0; i < nt; i++) {
      const th = Math.exp(la + ((i + 0.5) * (lb - la)) / nt);
      const sigma = Math.hypot(STARBURST.rayDiscSigma * SUN_RADIUS, STARBURST.streakFan * th);
      const np = th < RAY_REACH ? Math.min(4000, Math.max(336, Math.ceil((4 * Math.PI * th) / sigma))) : 8;
      let ring = 0;
      for (let j = 0; j < np; j++) ring += lumaOf(flareRadiance(onAxis, aroundAxis(th, -Math.PI + ((j + 0.5) * 2 * Math.PI) / np), 1e-3));
      sum += ((ring * 2 * Math.PI) / np) * Math.sin(th) * ((th * (lb - la)) / nt);
    }
    // The ring between the disc and its 1.5 px rim (excluded by the model) holds a few per cent of the rays; the red
    // and blue rays are a little longer / shorter than the green ones the set is normalised with.
    expect(sum / FLARE_TOTAL_ENERGY).toBeGreaterThan(0.93);
    expect(sum / FLARE_TOTAL_ENERGY).toBeLessThan(1.03);
  });

  it('the halo has no rim: it falls monotonically to the far side of the sphere, never faster than theta^-3, in one tint', () => {
    // Beyond the reach of the rays and of the ghosts of an on-axis sun only the halo is left.
    const at = (theta: number): [number, number, number] => flareRadiance(onAxis, aroundAxis(theta, 0.3), 1e-3);
    const n = flareNormalisation(SUN_RADIUS);
    let prev = at(RAY_REACH + 0.01)[1];
    for (let th = RAY_REACH + 0.02; th < 3.1; th += 0.01) {
      const l = at(th);
      expect(l[1]).toBeGreaterThan(0);
      expect(l[1]).toBeLessThan(prev);
      expect(l[1] / prev).toBeGreaterThan((1 - 0.01 / th) ** 3);
      for (let c = 0; c < 3; c++) expect(l[c]! / (STARBURST.haloEnergy * n.halo * STARBURST.haloTint[c]!)).toBeCloseTo((1 + (th / STARBURST.haloAngle) ** 2) ** -1.5, 10);
      prev = l[1];
    }
    // Level under the bloom's shoulder: within 4 deg of the sun the halo changes by under 12 %.
    expect((1 + (0.07 / STARBURST.haloAngle) ** 2) ** -1.5).toBeGreaterThan(0.88);
    // Violet-blue: blue above red above green, luminance 1.
    expect(lumaOf(STARBURST.haloTint)).toBeCloseTo(1, 12);
    expect(STARBURST.haloTint[2]).toBeGreaterThan(1.3 * STARBURST.haloTint[1]);
    expect(STARBURST.haloTint[0]).toBeGreaterThan(STARBURST.haloTint[1]);
  });

  it('a ray is a thin wedge that ends: as wide as the disc at its base, wider further out, zero beyond its length, red at its tip', () => {
    const angleOf = (j: number): number => (j * 2 * Math.PI) / SPIKE_COUNT + BLADES[spikeBlade(j)]!.angle;
    const ray = (theta: number, dphi: number, j = 0, lambda = 1): number => rayProfile(theta, angleOf(j) + dphi, SUN_RADIUS, lambda);
    // Full width at half maximum across the ray at angle theta (rad).
    const fwhm = (theta: number, j = 0): number => {
      const peak = ray(theta, 0, j);
      let d = 0;
      while (ray(theta, d / theta, j) > 0.5 * peak) d += 1e-5;
      return 2 * d;
    };
    // (2 deg out: nearer the sun neighbouring rays run into each other.)
    expect(fwhm(0.035)).toBeGreaterThan(SUN_RADIUS);
    expect(fwhm(0.035)).toBeLessThan(1.5 * SUN_RADIUS);
    expect(fwhm(0.2)).toBeGreaterThan(1.3 * fwhm(0.02));
    // Thin: 11 deg from the sun the widest ray is under 1.5 deg across.
    for (let j = 0; j < SPIKE_COUNT; j++) if (BLADES[spikeBlade(j)]!.length > 0.2) expect(fwhm(0.19, j)).toBeLessThan(0.026);
    for (let j = 0; j < SPIKE_COUNT; j++) {
      const len = BLADES[spikeBlade(j)]!.length;
      // It ends exactly at its length (times the wavelength) without a step: the last half per cent is under 1e-5 of the base.
      expect(ray(len * 1.0001, 0, j)).toBe(0);
      expect(ray(len * 0.995, 0, j)).toBeGreaterThan(0);
      expect(ray(len * 0.995, 0, j) / ray(0.02, 0, j)).toBeLessThan(1e-5);
      // Red reaches further than green, green further than blue.
      expect(ray(len * 0.97, 0, j, SPIKE_LAMBDA[0])).toBeGreaterThan(ray(len * 0.97, 0, j, 1));
      expect(ray(len * 0.97, 0, j, SPIKE_LAMBDA[2])).toBe(0);
      expect(len * SPIKE_LAMBDA[0]).toBeLessThanOrEqual(RAY_REACH);
    }
    expect(SPIKE_LAMBDA[0] / SPIKE_LAMBDA[2]).toBeGreaterThan(1.15);
    // Colour fringes along a ray: red over blue swings by more than a factor 1.5 between 2 deg and half its length.
    const long = BLADES.indexOf(BLADES.reduce((a, b) => (b.length > a.length ? b : a)));
    let lo = Infinity;
    let hi = 0;
    for (let th = 0.035; th < 0.5 * BLADES[long]!.length; th += 0.001) {
      const q = ray(th, 0, 2 * long, SPIKE_LAMBDA[0]) / ray(th, 0, 2 * long, SPIKE_LAMBDA[2]);
      lo = Math.min(lo, q);
      hi = Math.max(hi, q);
    }
    expect(hi / lo).toBeGreaterThan(1.5);
    // Blades differ strongly: one pair more than twice as long as the median, one nearly missing; a blade's two rays differ.
    const lens = BLADES.map((b) => b.length).sort((a, b) => a - b);
    expect(lens[BLADE_COUNT - 1]! / lens[0]!).toBeGreaterThan(3);
    expect(lens[BLADE_COUNT - 1]! / lens[3]!).toBeGreaterThan(1.7);
    const amps = Array.from({ length: SPIKE_COUNT }, (_, j) => spikeAmplitude(j));
    expect(Math.max(...amps) / Math.min(...amps)).toBeGreaterThan(5);
    for (let b = 0; b < BLADE_COUNT; b++) {
      expect(0.5 * (spikeAmplitude(2 * b) + spikeAmplitude(2 * b + BLADE_COUNT))).toBeCloseTo(BLADES[b]!.amplitude, 12);
      expect(spikeAmplitude(2 * b) / spikeAmplitude(2 * b + BLADE_COUNT)).toBeCloseTo(BLADES[b]!.asymmetry, 12);
    }
    expect(Math.max(...BLADES.map((b) => Math.abs(b.angle)))).toBeGreaterThan(0.07);
  });

  it('streaks: one per azimuth cell, a few strong and long among many faint ones, continuous across the cells', () => {
    expect(STREAKS).toHaveLength(STREAK_COUNT);
    const cell = (2 * Math.PI) / STREAK_COUNT;
    STREAKS.forEach((s, i) => {
      expect(s.azimuth).toBeGreaterThan(-Math.PI + i * cell);
      expect(s.azimuth).toBeLessThan(-Math.PI + (i + 1) * cell);
      expect(s.length * SPIKE_LAMBDA[0]).toBeLessThanOrEqual(RAY_REACH);
    });
    const amps = STREAKS.map((s) => s.amplitude).sort((a, b) => a - b);
    expect(amps[STREAK_COUNT >> 1]! / amps[STREAK_COUNT - 1]!).toBeLessThan(0.3);
    const lens = STREAKS.map((s) => s.length).sort((a, b) => a - b);
    expect(lens[STREAK_COUNT - 1]! / lens[STREAK_COUNT >> 1]!).toBeGreaterThan(2);
    // A pixel visits three cells: stepping across a cell border changes the sum by under 1 % of the ring's peak
    // (from 4 deg out, where a streak is narrower than a cell).
    for (const theta of [0.07, 0.12, 0.25]) {
      let peak = 0;
      for (let i = 0; i < 7200; i++) peak = Math.max(peak, streakProfile(theta, -Math.PI + ((i + 0.5) * 2 * Math.PI) / 7200, SUN_RADIUS, 1));
      expect(peak).toBeGreaterThan(0);
      for (let i = 1; i < STREAK_COUNT; i++) {
        const border = -Math.PI + i * cell;
        expect(Math.abs(streakProfile(theta, border - 1e-9, SUN_RADIUS, 1) - streakProfile(theta, border + 1e-9, SUN_RADIUS, 1))).toBeLessThan(0.01 * peak);
      }
    }
    expect(streakProfile(RAY_REACH, 0.1, SUN_RADIUS, 1)).toBe(0);
  });

  it('ghosts are dim iris images, no two alike: sharp and defocused, an oval, a ring, a crescent, a colour fringe on one side only', () => {
    const n = flareNormalisation(SUN_RADIUS);
    // EV100 14.4 (a sunlit Earth): mid-grey is 0.18 x 1.2 x 2^14.4 cd/m^2; the sun delivers 130,000 lux.
    const midGrey = 0.18 * 1.2 * 2 ** 14.4;
    const f = ghostFrame(view, [0.5, 0.3], SUN_RADIUS);
    for (const [i, gh] of GHOSTS.entries()) {
      expect(gh.blur).toBeGreaterThanOrEqual(1);
      let peak = 0;
      for (let k = 0; k < 4000; k++) {
        const r = gh.radius * 1.6 * Math.sqrt((k + 0.5) / 4000);
        const phi = k * 2.39996323;
        peak = Math.max(peak, ...ghostImage(gh, f, r * Math.sin(phi), r * Math.cos(phi)));
      }
      const luminance = 130_000 * gh.energy * n.ghosts[i]! * peak * Math.max(...gh.tint);
      expect(luminance).toBeLessThan(midGrey / 8);
    }
    // Edge softness (blur over apothem) spans far more than a factor 3; three ghosts are defocused blobs.
    const soft = GHOSTS.map((g) => (g.blur * SUN_RADIUS) / g.radius).sort((a, b) => a - b);
    expect(soft[soft.length - 1]! / soft[0]!).toBeGreaterThan(5);
    expect(soft.filter((s) => s > 0.4).length).toBeGreaterThanOrEqual(3);
    // No two share their shape parameters, and they are not evenly spaced on the axis.
    const keys = new Set(GHOSTS.map((g) => [g.blur, g.round, g.rim, g.hollow, g.aspect, g.bite, g.flip].join('/')));
    expect(keys.size).toBe(GHOSTS.length);
    const ks = GHOSTS.map((g) => g.k).sort((a, b) => a - b);
    const gaps = ks.slice(1).map((k, i) => k - ks[i]!);
    expect(Math.max(...gaps) / Math.min(...gaps)).toBeGreaterThan(8);
    // Lateral colour on one side only: along the axis the blue image ends where the others end on the side towards
    // the image centre and reaches further out on the far side.
    const gh = GHOSTS.find((g) => g.chroma > 0 && g.bite === 0 && g.hollow === 0)!;
    const edge = (blue: boolean, sign: number): number => {
      const ref = ghostShape(gh, f, 0, 0, blue);
      let t = 0;
      while (ghostShape(gh, f, sign * f.axis[0] * t, sign * f.axis[1] * t, blue) > 0.5 * ref) t += gh.radius / 4000;
      return t;
    };
    expect(edge(true, 1) - edge(false, 1)).toBeGreaterThan(1.2 * gh.chroma * gh.radius);
    expect(Math.abs(edge(true, -1) - edge(false, -1))).toBeLessThan(0.35 * gh.chroma * gh.radius);
    // The crescent: nothing at the centre of the cut, light on the far side of the ghost.
    const cr = GHOSTS.find((g) => g.bite > 0)!;
    expect(ghostShape(cr, f, f.axis[0] * cr.biteShift * cr.radius, f.axis[1] * cr.biteShift * cr.radius)).toBe(0);
    expect(ghostShape(cr, f, -f.axis[0] * 0.75 * cr.radius, -f.axis[1] * 0.75 * cr.radius)).toBeGreaterThan(0.3);
    // The ring: its centre is nearly empty.
    const ring = GHOSTS.find((g) => g.hollow > 0.9)!;
    const fr = ghostFrame(view, [0, 0], SUN_RADIUS);
    expect(ghostShape(ring, fr, 0, 0) / ghostShape(ring, fr, 0.9 * ring.radius, 0)).toBeLessThan(0.15);
  });
});
