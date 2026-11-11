/**
 * CPU mirrors of the WGSL parameterisations the atmosphere feature shares with the render core
 * (chunk "atmosphere_common") and of its own private tables. Pure float64 functions; every one takes an
 * optional rounding function so that tests can evaluate the exact float32 arithmetic the GPU performs
 * (`Math.fround`) and compare it against the float64 truth.
 */

export type Round = (x: number) => number;
const exact: Round = (x) => x;

export const TRANSMITTANCE_LUT_SIZE: readonly [number, number] = [256, 64];
export const MULTISCATTER_LUT_SIZE: readonly [number, number] = [32, 32];
export const SKY_IRRADIANCE_LUT_SIZE: readonly [number, number] = [64, 16];
export const SKY_VIEW_LUT_SIZE: readonly [number, number] = [192, 108];
export const AERIAL_SIZE = 32;

export const lutUnitToTexCoord = (x: number, size: number): number => 0.5 / size + x * (1 - 1 / size);
export const lutTexCoordToUnit = (u: number, size: number): number => (u - 0.5 / size) / (1 - 1 / size);

/**
 * Altitude (m) at distance t along a ray that starts at radius r0 / altitude h0 with mu = cos(angle to the
 * local vertical). The cancellation-free form of rendering-design 2.3 (WGSL `altitudeAt`).
 */
export function altitudeAt(t: number, r0: number, h0: number, mu: number, f: Round = exact): number {
  const q = f(f(f(f(2 * r0) * mu) * t) + f(t * t));
  const r = f(Math.sqrt(f(f(r0 * r0) + q)));
  return f(h0 + f(q / f(r + r0)));
}

/** The same quantity the naive way, |p0 + d t| - R, as float32 arithmetic would give it (for the test's contrast). */
export function altitudeNaive(t: number, r0: number, radius: number, mu: number, f: Round = exact): number {
  const r = f(Math.sqrt(f(f(f(r0 * r0) + f(f(f(2 * r0) * mu) * t)) + f(t * t))));
  return f(r - radius);
}

/** Float64 truth for the altitude along a ray, evaluated without cancellation. */
export function altitudeExact(t: number, r0: number, h0: number, mu: number): number {
  const q = 2 * r0 * mu * t + t * t;
  return h0 + q / (Math.sqrt(r0 * r0 + q) + r0);
}

/** Bruneton (r, mu) -> UV of the transmittance table (256 x 64). rb / rt = bottom / top radius. */
export function transmittanceUvFromRMu(r: number, mu: number, rb: number, rt: number, f: Round = exact): [number, number] {
  const H = f(Math.sqrt(f(f(rt * rt) - f(rb * rb))));
  const rho = f(Math.sqrt(Math.max(f(f(r * r) - f(rb * rb)), 0)));
  const d = Math.max(f(f(-r * mu) + f(Math.sqrt(Math.max(f(f(f(r * r) * f(f(mu * mu) - 1)) + f(rt * rt)), 0)))), 0);
  const dMin = f(rt - r);
  const dMax = f(rho + H);
  const xMu = f(f(d - dMin) / Math.max(f(dMax - dMin), 1e-3));
  const xR = f(rho / H);
  return [lutUnitToTexCoord(Math.min(Math.max(xMu, 0), 1), TRANSMITTANCE_LUT_SIZE[0]), lutUnitToTexCoord(Math.min(Math.max(xR, 0), 1), TRANSMITTANCE_LUT_SIZE[1])];
}

/** Inverse of transmittanceUvFromRMu: (r, mu). */
export function rMuFromTransmittanceUv(u: number, v: number, rb: number, rt: number, f: Round = exact): [number, number] {
  const xMu = lutTexCoordToUnit(u, TRANSMITTANCE_LUT_SIZE[0]);
  const xR = lutTexCoordToUnit(v, TRANSMITTANCE_LUT_SIZE[1]);
  const H = f(Math.sqrt(f(f(rt * rt) - f(rb * rb))));
  const rho = f(H * xR);
  const r = f(Math.sqrt(f(f(rho * rho) + f(rb * rb))));
  const dMin = f(rt - r);
  const dMax = f(rho + H);
  const d = f(dMin + f(xMu * f(dMax - dMin)));
  let mu = 1;
  if (d > 0) mu = Math.min(Math.max(f(f(f(f(H * H) - f(rho * rho)) - f(d * d)) / f(f(2 * r) * d)), -1), 1);
  return [r, mu];
}

/**
 * The texel of the transmittance table in the cancellation-free form the table is BUILT with: altitude
 * above the bottom radius, distance d to the top along the ray, and mu. `xMu`, `xR` are the unit
 * coordinates of the texel centre.
 */
export function transmittanceTexel(xMu: number, xR: number, rb: number, rt: number): { h: number; r: number; mu: number; d: number } {
  const H = Math.sqrt((rt - rb) * (rt + rb));
  const rho = H * xR;
  const r = Math.sqrt(rho * rho + rb * rb);
  const h = (rho * rho) / (r + rb);
  const dMin = rt - rb - h;
  const dMax = rho + H;
  const d = dMin + xMu * (dMax - dMin);
  const mu = d > 0 ? Math.min(Math.max((H * H - rho * rho - d * d) / (2 * r * d), -1), 1) : 1;
  return { h, r, mu, d };
}

/** (r, mu_s) -> UV of the sky irradiance table (64 x 16): u = (mu_s + 0.2) / 1.2, v = (r - rb) / (rt - rb). */
export function skyIrradianceUvFromRMuS(r: number, muS: number, rb: number, rt: number): [number, number] {
  return [
    lutUnitToTexCoord(Math.min(Math.max((muS + 0.2) / 1.2, 0), 1), SKY_IRRADIANCE_LUT_SIZE[0]),
    lutUnitToTexCoord(Math.min(Math.max((r - rb) / (rt - rb), 0), 1), SKY_IRRADIANCE_LUT_SIZE[1]),
  ];
}
export function rMuSFromSkyIrradianceUv(u: number, v: number, rb: number, rt: number): [number, number] {
  return [rb + lutTexCoordToUnit(v, SKY_IRRADIANCE_LUT_SIZE[1]) * (rt - rb), lutTexCoordToUnit(u, SKY_IRRADIANCE_LUT_SIZE[0]) * 1.2 - 0.2];
}

/** (altitude, mu_s) -> UV of the private multi-scattering table (32 x 32): u = mu_s / 2 + 1 / 2, v = h / (rt - rb). */
export function multiScatterUvFromHMuS(h: number, muS: number, top: number): [number, number] {
  return [
    lutUnitToTexCoord(Math.min(Math.max(muS * 0.5 + 0.5, 0), 1), MULTISCATTER_LUT_SIZE[0]),
    lutUnitToTexCoord(Math.min(Math.max(h / top, 0), 1), MULTISCATTER_LUT_SIZE[1]),
  ];
}
export function hMuSFromMultiScatterUv(u: number, v: number, top: number): [number, number] {
  return [lutTexCoordToUnit(v, MULTISCATTER_LUT_SIZE[1]) * top, lutTexCoordToUnit(u, MULTISCATTER_LUT_SIZE[0]) * 2 - 1];
}

/**
 * Elevation above the local horizontal and azimuth from the sun's azimuth -> UV of the sky-view table
 * (192 x 108), as `skyViewUv` of the core computes it: u = az / 2 pi + 1 / 2,
 * v = 1 / 2 - 1 / 2 sign(l) sqrt(|l| / (pi / 2)).
 */
export function skyViewUvFromAngles(elevation: number, azimuth: number): [number, number] {
  return [azimuth / (2 * Math.PI) + 0.5, 0.5 - 0.5 * Math.sign(elevation) * Math.sqrt(Math.abs(elevation) / (Math.PI / 2))];
}
export function anglesFromSkyViewUv(u: number, v: number): [number, number] {
  const c = (0.5 - v) * 2;
  return [Math.sign(c) * c * c * (Math.PI / 2), (u - 0.5) * 2 * Math.PI];
}

/** Distance (m) of aerial-perspective slice coordinate s in [0, 32]; the texel centre of layer k is s = k + 0.5. */
export const aerialSliceToDistance = (s: number): number => 50 * (2 ** (0.5 * s) - 1);
export const aerialDistanceToSlice = (d: number): number => Math.min(Math.max(2 * Math.log2(Math.max(d, 0) / 50 + 1), 0), AERIAL_SIZE);

/**
 * Distances along a unit ray from a point at radius r0 (mu = cos to the local vertical) to the sphere of
 * radius rs around the body centre: [near, far], or null when the ray's line misses it. Cancellation-free:
 * uses the altitude difference `dh = r0 - rs` supplied from float64.
 */
export function raySphere(r0: number, dh: number, mu: number, rs: number): [number, number] | null {
  const b = r0 * mu;
  // r0^2 (mu^2 - 1) + rs^2  ==  b^2 - dh (r0 + rs)
  const disc = b * b - dh * (r0 + rs);
  if (disc < 0) return null;
  const s = Math.sqrt(disc);
  const c = dh * (r0 + rs);
  // Roots of t^2 + 2 b t + c = 0 without cancellation.
  const q = b >= 0 ? -(b + s) : -b + s;
  const t0 = q;
  const t1 = q !== 0 ? c / q : -b;
  return t0 <= t1 ? [t0, t1] : [t1, t0];
}

/** (1 - exp(-x)) / x, accurate for small x (the analytic segment integral of Hillaire's march). */
export function expm1OverX(x: number): number {
  return x < 1e-2 ? 1 - 0.5 * x + (x * x) / 6 : (1 - Math.exp(-x)) / x;
}

/** Rayleigh phase function, 1 / sr. */
export const phaseRayleigh = (cosTheta: number): number => (3 / (16 * Math.PI)) * (1 + cosTheta * cosTheta);

/** Cornette-Shanks phase function, 1 / sr. */
export function phaseCornetteShanks(cosTheta: number, g: number): number {
  const g2 = g * g;
  return ((3 / (8 * Math.PI)) * (1 - g2) * (1 + cosTheta * cosTheta)) / ((2 + g2) * Math.max(1 + g2 - 2 * g * cosTheta, 1e-4) ** 1.5);
}

/** Henyey-Greenstein phase function, 1 / sr. */
export function phaseHenyeyGreenstein(cosTheta: number, g: number): number {
  const g2 = g * g;
  return (1 - g2) / (4 * Math.PI * Math.max(1 + g2 - 2 * g * cosTheta, 1e-4) ** 1.5);
}

/**
 * Float32-faithful mirror of the WGSL `atmoRaySphere`: signed distances (near, far) along a unit ray to the
 * sphere of radius rs, from a point at radius r0 = rs + dh with vertical cosine mu; null when the line
 * misses. The gap between the sphere and the ray's perigee is formed from dh, so nothing cancels at the
 * surface.
 */
export function raySphereStable(r0: number, dh: number, mu: number, rs: number, f: Round = exact): [number, number] | null {
  const s = f(Math.sqrt(Math.max(f(1 - f(mu * mu)), 0)));
  const gap = f(f(r0 * f(f(mu * mu) / f(1 + s))) - dh);
  const disc = f(gap * f(rs + f(r0 * s)));
  if (disc < 0) return null;
  const sq = f(Math.sqrt(disc));
  const b = f(r0 * mu);
  const c = f(dh * f(r0 + rs));
  if (b > 0) {
    const t0 = f(-f(b + sq));
    return [t0, f(c / t0)];
  }
  const t1 = f(sq - b);
  if (t1 <= 0) return [0, 0];
  return [f(c / t1), t1];
}

/** Start of a camera ray's path through an atmosphere shell (mirror of the WGSL `AtmoRay`). */
export interface RayFrame {
  /** Distance from the eye to the start of the path (0 with the eye inside the shell). */
  t0: number;
  /** Length of the path inside the shell and in front of the reference sphere (<= 0: none). */
  len: number;
  /** Radius, altitude and vertical cosine of the ray at the start of the path. */
  r: number;
  h: number;
  mu: number;
  ground: boolean;
}

/**
 * Float32-faithful mirror of the WGSL `atmoRay`. `cosUp` = dot(ray, camera up), `sinUp` = |cross(ray, camera up)|
 * (both as the shader has them, i.e. already rounded); r0 / h0 = camera radius / altitude from float64.
 */
export function rayFrame(r0: number, h0: number, cosUp: number, sinUp: number, rb: number, rt: number, f: Round = exact): RayFrame {
  const top = f(rt - rb);
  if (h0 <= top) {
    const mu = Math.abs(cosUp) < 0.7 ? cosUp : Math.sign(cosUp) * f(Math.sqrt(Math.max(f(1 - f(sinUp * sinUp)), 0)));
    const out = raySphereStable(r0, f(h0 - top), mu, rt, f);
    let len = out ? out[1] : -1;
    let ground = false;
    if (mu < 0 && h0 > 0) {
      const g = raySphereStable(r0, h0, mu, rb, f);
      if (g && g[1] > g[0] && g[0] > 0) {
        len = Math.min(len, g[0]);
        ground = true;
      }
    }
    return { t0: 0, len, r: r0, h: h0, mu, ground };
  }
  const p = f(r0 * sinUp);
  if (cosUp >= 0 || p >= rt) return { t0: 0, len: -1, r: rt, h: top, mu: 0, ground: false };
  const sinA = f(p / rt);
  const cosA = f(Math.sqrt(Math.max(f(1 - f(sinA * sinA)), 0)));
  const t0 = Math.max(f(f(r0 * f(Math.sqrt(Math.max(f(1 - f(sinUp * sinUp)), 0)))) - f(rt * cosA)), 0);
  let len = f(f(2 * rt) * cosA);
  let ground = false;
  if (p < rb) {
    const q = f(p / rb);
    len = f(f(rt * cosA) - f(rb * f(Math.sqrt(Math.max(f(1 - f(q * q)), 0)))));
    ground = true;
  }
  return { t0, len, r: rt, h: top, mu: -cosA, ground };
}
