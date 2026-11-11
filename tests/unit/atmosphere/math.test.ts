import { describe, expect, it } from 'vitest';
import {
  AERIAL_SIZE,
  MULTISCATTER_LUT_SIZE,
  SKY_IRRADIANCE_LUT_SIZE,
  SKY_VIEW_LUT_SIZE,
  TRANSMITTANCE_LUT_SIZE,
  aerialDistanceToSlice,
  aerialSliceToDistance,
  altitudeAt,
  altitudeExact,
  altitudeNaive,
  anglesFromSkyViewUv,
  expm1OverX,
  hMuSFromMultiScatterUv,
  multiScatterUvFromHMuS,
  rMuFromTransmittanceUv,
  rMuSFromSkyIrradianceUv,
  rayFrame,
  raySphere,
  raySphereStable,
  skyIrradianceUvFromRMuS,
  skyViewUvFromAngles,
  transmittanceTexel,
  transmittanceUvFromRMu,
} from '@/render/atmosphere/math';

const RB = 6371000;
const RT = RB + 100000;
const f32 = Math.fround;

describe('transmittance table parameterisation (Bruneton r, mu)', () => {
  it('round-trips every texel centre in float64', () => {
    let worst = 0;
    for (let j = 0; j < TRANSMITTANCE_LUT_SIZE[1]; j++) {
      for (let i = 0; i < TRANSMITTANCE_LUT_SIZE[0]; i++) {
        const u = (i + 0.5) / TRANSMITTANCE_LUT_SIZE[0];
        const v = (j + 0.5) / TRANSMITTANCE_LUT_SIZE[1];
        const [r, mu] = rMuFromTransmittanceUv(u, v, RB, RT);
        const [u2, v2] = transmittanceUvFromRMu(r, mu, RB, RT);
        worst = Math.max(worst, Math.abs(u2 - u) * TRANSMITTANCE_LUT_SIZE[0], Math.abs(v2 - v) * TRANSMITTANCE_LUT_SIZE[1]);
      }
    }
    // In texels: far below what bilinear filtering can show.
    expect(worst).toBeLessThan(1e-3);
  });

  it('round-trips in float32 arithmetic to a small fraction of a texel', () => {
    let worst = 0;
    for (let j = 0; j < TRANSMITTANCE_LUT_SIZE[1]; j += 3) {
      for (let i = 0; i < TRANSMITTANCE_LUT_SIZE[0]; i += 5) {
        const u = (i + 0.5) / TRANSMITTANCE_LUT_SIZE[0];
        const v = (j + 0.5) / TRANSMITTANCE_LUT_SIZE[1];
        const [r, mu] = rMuFromTransmittanceUv(u, v, RB, RT);
        const [u2, v2] = transmittanceUvFromRMu(f32(r), f32(mu), RB, RT, f32);
        worst = Math.max(worst, Math.abs(u2 - u) * TRANSMITTANCE_LUT_SIZE[0], Math.abs(v2 - v) * TRANSMITTANCE_LUT_SIZE[1]);
      }
    }
    expect(worst).toBeLessThan(0.3);
  });

  it('covers the ground horizon and the top of the shell at the table edges', () => {
    // v = bottom row: r = rb; u = last column: the horizon ray (mu = 0 at the ground).
    const [r0, muH] = rMuFromTransmittanceUv(1 - 0.5 / TRANSMITTANCE_LUT_SIZE[0], 0.5 / TRANSMITTANCE_LUT_SIZE[1], RB, RT);
    expect(r0).toBeCloseTo(RB, 3);
    expect(Math.abs(muH)).toBeLessThan(1e-6);
    // u = first column: straight up; v = top row: r = rt.
    const [r1, mu1] = rMuFromTransmittanceUv(0.5 / TRANSMITTANCE_LUT_SIZE[0], 1 - 0.5 / TRANSMITTANCE_LUT_SIZE[1], RB, RT);
    expect(r1).toBeCloseTo(RT, 3);
    expect(mu1).toBe(1);
  });

  it('builds texels in a cancellation-free form that agrees with the mapping', () => {
    for (const [xMu, xR] of [
      [0, 0],
      [1, 0],
      [0.5, 0.01],
      [0.3, 0.6],
      [1, 1],
    ] as const) {
      const t = transmittanceTexel(xMu, xR, RB, RT);
      const u = 0.5 / TRANSMITTANCE_LUT_SIZE[0] + xMu * (1 - 1 / TRANSMITTANCE_LUT_SIZE[0]);
      const v = 0.5 / TRANSMITTANCE_LUT_SIZE[1] + xR * (1 - 1 / TRANSMITTANCE_LUT_SIZE[1]);
      const [r, mu] = rMuFromTransmittanceUv(u, v, RB, RT);
      expect(t.r).toBeCloseTo(r, 4);
      expect(t.h).toBeCloseTo(r - RB, 4);
      expect(t.mu).toBeCloseTo(mu, 9);
      // The ray of length d ends exactly on the top sphere.
      expect(Math.sqrt(t.r * t.r + 2 * t.r * t.mu * t.d + t.d * t.d)).toBeCloseTo(RT, 2);
    }
  });
});

describe('the other table parameterisations', () => {
  it('sky irradiance (r, mu_s) round-trips and spans mu_s = -0.2 .. 1', () => {
    for (let j = 0; j < SKY_IRRADIANCE_LUT_SIZE[1]; j++) {
      for (let i = 0; i < SKY_IRRADIANCE_LUT_SIZE[0]; i++) {
        const u = (i + 0.5) / SKY_IRRADIANCE_LUT_SIZE[0];
        const v = (j + 0.5) / SKY_IRRADIANCE_LUT_SIZE[1];
        const [r, muS] = rMuSFromSkyIrradianceUv(u, v, RB, RT);
        const [u2, v2] = skyIrradianceUvFromRMuS(r, muS, RB, RT);
        expect(u2).toBeCloseTo(u, 10);
        expect(v2).toBeCloseTo(v, 9);
      }
    }
    expect(rMuSFromSkyIrradianceUv(0.5 / 64, 0.5 / 16, RB, RT)[1]).toBeCloseTo(-0.2, 12);
    expect(rMuSFromSkyIrradianceUv(1 - 0.5 / 64, 1 - 0.5 / 16, RB, RT)).toEqual([RT, 1]);
  });

  it('multi-scattering (h, mu_s) round-trips', () => {
    for (let j = 0; j < MULTISCATTER_LUT_SIZE[1]; j++) {
      for (let i = 0; i < MULTISCATTER_LUT_SIZE[0]; i++) {
        const u = (i + 0.5) / MULTISCATTER_LUT_SIZE[0];
        const v = (j + 0.5) / MULTISCATTER_LUT_SIZE[1];
        const [h, muS] = hMuSFromMultiScatterUv(u, v, 100000);
        const [u2, v2] = multiScatterUvFromHMuS(h, muS, 100000);
        expect(u2).toBeCloseTo(u, 10);
        expect(v2).toBeCloseTo(v, 10);
      }
    }
  });

  it('sky view (elevation, azimuth) round-trips and is densest at the horizontal', () => {
    for (let j = 0; j < SKY_VIEW_LUT_SIZE[1]; j++) {
      for (let i = 0; i < SKY_VIEW_LUT_SIZE[0]; i += 7) {
        const u = (i + 0.5) / SKY_VIEW_LUT_SIZE[0];
        const v = (j + 0.5) / SKY_VIEW_LUT_SIZE[1];
        const [el, az] = anglesFromSkyViewUv(u, v);
        const [u2, v2] = skyViewUvFromAngles(el, az);
        expect(u2).toBeCloseTo(u, 10);
        expect(v2).toBeCloseTo(v, 10);
      }
    }
    // Top row is (nearly) the zenith, bottom row the nadir; rows next to the middle are a fraction of a degree apart.
    expect(anglesFromSkyViewUv(0.5, 0.5 / 108)[0]).toBeGreaterThan(1.5);
    expect(anglesFromSkyViewUv(0.5, 1 - 0.5 / 108)[0]).toBeLessThan(-1.5);
    const near = anglesFromSkyViewUv(0.5, 53.5 / 108)[0] - anglesFromSkyViewUv(0.5, 54.5 / 108)[0];
    const far = anglesFromSkyViewUv(0.5, 10.5 / 108)[0] - anglesFromSkyViewUv(0.5, 11.5 / 108)[0];
    expect(near).toBeLessThan(0.001);
    expect(far).toBeGreaterThan(20 * near);
  });
});

describe('aerial-perspective slice mapping', () => {
  it('is the inverse pair 50 m x (2^(s/2) - 1)', () => {
    for (let s = 0; s <= AERIAL_SIZE; s += 0.25) {
      expect(aerialDistanceToSlice(aerialSliceToDistance(s))).toBeCloseTo(s, 9);
    }
    expect(aerialSliceToDistance(0)).toBe(0);
    expect(aerialSliceToDistance(2)).toBeCloseTo(50, 9);
    // Texel centres: first layer under 10 m, last layer about 2,755 km.
    expect(aerialSliceToDistance(0.5)).toBeCloseTo(9.46, 2);
    expect(aerialSliceToDistance(31.5) / 1000).toBeCloseTo(2755.4, 0);
  });

  it('clamps outside the volume and is monotonic', () => {
    expect(aerialDistanceToSlice(-5)).toBe(0);
    expect(aerialDistanceToSlice(1e9)).toBe(AERIAL_SIZE);
    let prev = -1;
    for (let d = 0; d < 3.2e6; d = d * 1.3 + 1) {
      const s = aerialDistanceToSlice(d);
      expect(s).toBeGreaterThan(prev);
      prev = s;
    }
  });
});

describe('stable altitude along a ray against float64', () => {
  // Tolerances: the formula's only rounding is in q = 2 r0 mu t + t^2, i.e. a relative 6e-8 of the altitude
  // gained along the ray: millimetres within 50 km, a decimetre over 1000 km.
  const cases: { name: string; r0: number; h0: number; mus: number[]; ts: number[]; tol: number }[] = [
    { name: 'standing on the pad, out to 50 km', r0: RB + 2, h0: 2, mus: [1, 0.5, 0.02, 0, -1e-4], ts: [1, 30, 1e3, 5e4], tol: 0.005 },
    { name: 'standing on the pad, out to 1000 km', r0: RB + 2, h0: 2, mus: [1, 0.5, 0.02, 0], ts: [2e5, 1e6], tol: 0.1 },
    { name: 'ascent at 40 km', r0: RB + 40000, h0: 40000, mus: [1, 0.2, -0.05, -0.11], ts: [10, 1e4, 3e5, 1.2e6], tol: 0.1 },
    { name: 'low orbit at 400 km', r0: RB + 4e5, h0: 4e5, mus: [-1, -0.8, -0.35, -0.33], ts: [4e5, 6e5, 2e6, 2.6e6], tol: 0.6 },
  ];
  for (const c of cases) {
    it(`${c.name}: float32 evaluation within ${c.tol} m of float64`, () => {
      let worst = 0;
      let worstNaive = 0;
      for (const mu of c.mus) {
        for (const t of c.ts) {
          const truth = altitudeExact(t, c.r0, c.h0, mu);
          worst = Math.max(worst, Math.abs(altitudeAt(f32(t), f32(c.r0), f32(c.h0), f32(mu), f32) - truth));
          worstNaive = Math.max(worstNaive, Math.abs(altitudeNaive(f32(t), f32(c.r0), RB, f32(mu), f32) - truth));
        }
      }
      expect(worst).toBeLessThan(c.tol);
      // The naive |p| - R form in float32 is off by the rounding of a 6.4e6 m radius: 0.25 m and more.
      expect(worstNaive).toBeGreaterThan(0.2);
    });
  }

  it('in float64 the formula is the exact altitude', () => {
    const r0 = RB + 1234.5;
    for (const mu of [1, 0.3, -0.01]) {
      for (const t of [1, 1e3, 1e6, 1e8]) {
        const p = Math.sqrt(r0 * r0 + 2 * r0 * mu * t + t * t) - RB;
        expect(altitudeAt(t, r0, 1234.5, mu)).toBeCloseTo(p, 5);
      }
    }
  });
});

describe('ray / shell geometry', () => {
  it('finds both roots without cancellation at the surface (float32 against float64)', () => {
    // Eye 2 m above the ground looking slightly down: the ground hit is 100 m to 5 km away.
    for (const mu of [-0.5, -0.02, -0.001, -0.0008]) {
      const exact = raySphere(RB + 2, 2, mu, RB)!;
      const got = raySphereStable(f32(RB + 2), 2, f32(mu), RB, f32)!;
      expect(got[0] / exact[0]).toBeCloseTo(1, 3);
    }
    // The top of the shell from inside.
    for (const mu of [1, 0.3, 0, -0.01]) {
      const exact = raySphere(RB + 2, 2 - 100000, mu, RT)!;
      const got = raySphereStable(f32(RB + 2), 2 - 100000, f32(mu), RT, f32)!;
      expect(got[1] / exact[1]).toBeCloseTo(1, 5);
    }
    expect(raySphereStable(RB + 2e5, 1e5, -0.1, RT)).toBeNull();
  });

  it('from lunar distance the ray frame resolves the shell to tens of metres in float32', () => {
    const r0 = 384_400_000;
    const h0 = r0 - RB;
    // Impact parameters from the centre of the disc to the limb.
    for (const p of [0, 1e6, 5e6, RB - 5000, RB + 20000, RT - 2000]) {
      const sinUp = p / r0;
      const cosUp = -Math.sqrt(1 - sinUp * sinUp);
      const ref = rayFrame(r0, h0, cosUp, sinUp, RB, RT);
      const got = rayFrame(f32(r0), f32(h0), f32(cosUp), f32(sinUp), RB, RT, f32);
      expect(got.ground).toBe(ref.ground);
      // Entry distance: float32 at 3.8e8 m has 32 m steps.
      expect(Math.abs(got.t0 - ref.t0)).toBeLessThan(150);
      expect(Math.abs(got.len - ref.len)).toBeLessThan(Math.max(60, 2e-4 * ref.len));
      // Altitudes along the path from the entry point: the lowest point of the path is where it matters.
      for (const frac of [0.25, 0.5, 1]) {
        const s = ref.len * frac;
        const truth = altitudeExact(s, ref.r, ref.h, ref.mu);
        const mine = altitudeAt(f32(got.len * frac), f32(got.r), f32(got.h), f32(got.mu), f32);
        expect(Math.abs(mine - truth)).toBeLessThan(60);
      }
    }
    // The same camera through the camera-origin formula alone is kilometres off: this is what the frame avoids.
    const sinUp = (RB - 5000) / r0;
    const cosUp = -Math.sqrt(1 - sinUp * sinUp);
    const tGround = r0 * -cosUp - Math.sqrt(RB * RB - (RB - 5000) ** 2);
    const direct = altitudeAt(f32(tGround), f32(r0), f32(h0), f32(cosUp), f32);
    expect(Math.abs(direct)).toBeGreaterThan(500);
  });

  it('with the eye inside the shell the frame is the eye itself', () => {
    const f = rayFrame(RB + 10, 10, 0.5, Math.sqrt(0.75), RB, RT);
    expect(f.t0).toBe(0);
    expect(f.r).toBe(RB + 10);
    expect(f.h).toBe(10);
    expect(f.ground).toBe(false);
    const down = rayFrame(RB + 10, 10, -0.5, Math.sqrt(0.75), RB, RT);
    expect(down.ground).toBe(true);
    expect(down.len).toBeCloseTo(20, 1);
    // Looking away from the body from outside: no path.
    expect(rayFrame(RB + 4e5, 4e5, 0.2, 0.98, RB, RT).len).toBeLessThan(0);
  });
});

describe('segment integral', () => {
  it('(1 - exp(-x)) / x is accurate for tiny and large x', () => {
    expect(expm1OverX(0)).toBe(1);
    expect(expm1OverX(1e-9)).toBeCloseTo(1 - 0.5e-9, 14);
    expect(expm1OverX(1e-3)).toBeCloseTo((1 - Math.exp(-1e-3)) / 1e-3, 9);
    expect(expm1OverX(0.5)).toBeCloseTo((1 - Math.exp(-0.5)) / 0.5, 12);
    expect(expm1OverX(50)).toBeCloseTo(0.02, 10);
  });
});
