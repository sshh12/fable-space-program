/**
 * Lambert's problem (ARCHITECTURE 8.4; the interplanetary planner): the conic about a body with
 * gravitational parameter mu that goes from r1 to r2 in a given time of flight, by universal variables
 * (Bate, Mueller and White 5.3; Vallado algorithm 58). Zero revolutions; prograde or retrograde with respect
 * to a reference normal (default +Z of ICRF, which every ecliptic-near orbit shares). Pure float64.
 *
 *   A = sin(dnu) sqrt(r1 r2 / (1 - cos dnu)),  y(z) = r1 + r2 + A (z S(z) - 1) / sqrt(C(z)),
 *   sqrt(mu) t(z) = (y / C)^(3/2) S + A sqrt(y),  solved for z (monotonic in z on the single-revolution branch,
 *   z < (2 pi)^2) by Brent's method on a bracket where y > 0;
 *   f = 1 - y / r1, g = A sqrt(y / mu), gdot = 1 - y / r2;  v1 = (r2 - f r1) / g,  v2 = (gdot r2 - r1) / g.
 *
 * Returns null where the geometry has no unique plane (dnu within 1e-8 rad of 0 or pi) or no solution exists.
 */
import { v3, type Vec3 } from '../../core/math/vec3';
import { stumpff } from './kepler';
import { brentRoot } from './roots';

export interface LambertSolution {
  v1: Vec3;
  v2: Vec3;
  /** Transfer angle, rad (0, 2 pi). */
  dnu: number;
}

const TWO_PI = 2 * Math.PI;

export function solveLambert(mu: number, r1: Vec3, r2: Vec3, tof: number, prograde = true, refNormal: Vec3 = { x: 0, y: 0, z: 1 }): LambertSolution | null {
  if (!(mu > 0) || !(tof > 0)) return null;
  const r1n = v3.len(r1);
  const r2n = v3.len(r2);
  if (!(r1n > 0) || !(r2n > 0)) return null;
  const cosd = Math.max(-1, Math.min(1, v3.dot(r1, r2) / (r1n * r2n)));
  const h = v3.cross(r1, r2);
  const s = v3.dot(h, refNormal);
  let dnu = Math.acos(cosd);
  if ((prograde && s < 0) || (!prograde && s >= 0)) dnu = TWO_PI - dnu;
  if (Math.abs(Math.sin(dnu)) < 1e-8) return null;
  const A = Math.sin(dnu) * Math.sqrt((r1n * r2n) / (1 - Math.cos(dnu)));
  const sqrtMu = Math.sqrt(mu);
  const yOf = (z: number): number => {
    const { c2, c3 } = stumpff(z);
    return r1n + r2n + (A * (z * c3 - 1)) / Math.sqrt(c2);
  };
  const F = (z: number): number => {
    const { c2, c3 } = stumpff(z);
    const y = r1n + r2n + (A * (z * c3 - 1)) / Math.sqrt(c2);
    if (y < 0) return -sqrtMu * tof - 1;
    const x = Math.sqrt(y / c2);
    return x * x * x * c3 + A * Math.sqrt(y) - sqrtMu * tof;
  };
  // Bracket: zHi just under (2 pi)^2 (t -> infinity there), zLo low enough for a fast hyperbola with y > 0.
  const zHi = TWO_PI * TWO_PI * (1 - 1e-9);
  let zLo = -4 * Math.PI * Math.PI;
  // When A > 0, y < 0 for low z: move the low end up to where y >= 0.
  if (A > 0) {
    let lo = zLo;
    let hi = zHi;
    if (yOf(lo) < 0) {
      for (let i = 0; i < 200 && hi - lo > 1e-12; i++) {
        const m = (lo + hi) / 2;
        if (yOf(m) < 0) lo = m;
        else hi = m;
      }
      zLo = hi;
    }
  }
  let fLo = F(zLo);
  // A very short time of flight (a fast hyperbola) needs a lower z.
  for (let k = 0; fLo > 0 && k < 60; k++) {
    zLo -= 4 * Math.PI * Math.PI * 2 ** k;
    fLo = F(zLo);
  }
  const fHi = F(zHi);
  if (!(fLo <= 0) || !(fHi >= 0)) return null;
  let z: number;
  try {
    z = brentRoot(F, zLo, zHi, 1e-14 * Math.max(1, Math.abs(zLo)), fLo, fHi);
  } catch {
    return null;
  }
  const y = yOf(z);
  if (!(y > 0)) return null;
  const f = 1 - y / r1n;
  const g = A * Math.sqrt(y / mu);
  const gdot = 1 - y / r2n;
  const v1 = v3.scale(v3.sub(r2, v3.scale(r1, f)), 1 / g);
  const v2 = v3.scale(v3.sub(v3.scale(r2, gdot), r1), 1 / g);
  if (!v3.isFinite(v1) || !v3.isFinite(v2)) return null;
  return { v1, v2, dnu };
}
