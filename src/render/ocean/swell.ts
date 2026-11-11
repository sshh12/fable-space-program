/**
 * The shared analytic swell (src/core/geo/oceanSwell.ts) prepared for the GPU. oceanSwellHeight evaluates
 * A_i w_i cos(k_i R (d_i . n) - omega_i t + phi_i): the phase k_i R (d_i . n) is of order 1e6 rad on Earth and
 * cannot be formed in float32. Each frame the CPU evaluates the phase at a reference point c (the camera's
 * nadir on the sea-level sphere) in float64 and reduces it modulo 2 pi; the shader adds only the small,
 * well-conditioned term k_i (d_i . delta) where delta = R (n - c) is the point's offset from the reference
 * in metres (cancellation-free form in WGSL `oceanSphereOffset`). The result equals oceanSwellHeight to
 * float32 rounding of quantities of order one, anywhere on the planet.
 */
import type { SwellComponent } from '@/core/geo/oceanSwell';
import { TWO_PI, type Vec3 } from '@/core/math';

/** Most swell components a body may define (uniform array size). */
export const MAX_SWELL = 8;

export interface PreparedSwell {
  count: number;
  /** Per component (MAX_SWELL x 4 floats each). dir: unit body-fixed direction xyz, w = wavenumber k (rad/m). */
  dirK: Float32Array;
  /** x = amplitude (m), y = phase at the reference point and time t, reduced to [0, 2 pi), z = d . c, w = omega (rad/s). */
  ampPhase: Float32Array;
}

const smooth = (e0: number, e1: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

/**
 * Prepare the swell for reference direction `c` (unit, body-fixed) at time `t` (s). `radius` and `gravity`
 * must be exactly what the physics passes to oceanSwellHeight (sea-level radius, surface gravity).
 */
export function prepareSwell(swell: readonly SwellComponent[], gravity: number, radius: number, c: Vec3, t: number, out?: PreparedSwell): PreparedSwell {
  if (swell.length > MAX_SWELL) throw new Error(`ocean: ${swell.length} swell components, at most ${MAX_SWELL} are supported`);
  const p = out ?? { count: 0, dirK: new Float32Array(MAX_SWELL * 4), ampPhase: new Float32Array(MAX_SWELL * 4) };
  p.count = swell.length;
  p.dirK.fill(0);
  p.ampPhase.fill(0);
  swell.forEach((s, i) => {
    const k = TWO_PI / s.wavelength;
    const omega = Math.sqrt(gravity * k);
    const dc = s.dir[0] * c.x + s.dir[1] * c.y + s.dir[2] * c.z;
    // float64: k R (d.c) - omega t + phi, reduced exactly to [0, 2 pi).
    let ph = (k * radius * dc - omega * t + s.phase) % TWO_PI;
    if (ph < 0) ph += TWO_PI;
    p.dirK.set([s.dir[0], s.dir[1], s.dir[2], k], i * 4);
    p.ampPhase.set([s.amplitude, ph, dc, omega], i * 4);
  });
  return p;
}

/**
 * Float32 emulation of the WGSL evaluation (`oceanSwellEval` in shaders.ts) at offset `delta` = R (n - c)
 * (metres, body-fixed): every operation rounded to float32 like the GPU. Used by the unit tests that prove
 * the preparation exact; the shader is the same expression.
 */
export function swellHeightF32(p: PreparedSwell, radius: number, delta: Vec3): number {
  const f = Math.fround;
  const dx = f(delta.x);
  const dy = f(delta.y);
  const dz = f(delta.z);
  const invR = f(1 / radius);
  let eta = 0;
  for (let i = 0; i < p.count; i++) {
    const d0 = p.dirK[i * 4]!;
    const d1 = p.dirK[i * 4 + 1]!;
    const d2 = p.dirK[i * 4 + 2]!;
    const k = p.dirK[i * 4 + 3]!;
    const a = p.ampPhase[i * 4]!;
    const ph0 = p.ampPhase[i * 4 + 1]!;
    const dc = p.ampPhase[i * 4 + 2]!;
    const dd = f(f(f(d0 * dx) + f(d1 * dy)) + f(d2 * dz));
    const dn = f(dc + f(dd * invR));
    const sinAng = f(Math.sqrt(Math.max(0, f(1 - f(dn * dn)))));
    const w = f(smooth(0.15, 0.5, sinAng));
    const ph = f(ph0 + f(k * dd));
    eta = f(eta + f(f(a * w) * f(Math.cos(ph))));
  }
  return eta;
}

/** Slope variance (both axes summed) of the swell where every component is fully present (w = 1). */
export function swellSlopeVariance(swell: readonly SwellComponent[]): number {
  return swell.reduce((s, c) => s + ((c.amplitude * TWO_PI) / c.wavelength) ** 2 / 2, 0);
}

/** Bound on the swell's surface elevation, m. */
export const swellAmplitudeBound = (swell: readonly SwellComponent[]): number => swell.reduce((s, c) => s + c.amplitude, 0);
