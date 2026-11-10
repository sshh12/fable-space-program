/**
 * Anomaly <-> time relations on a conic that stay well conditioned for every eccentricity, including the
 * near-parabolic band where the classical E - e sin E form loses most of its digits.
 *
 * Time since periapsis is written in terms of D = tan(nu/2) and w = sqrt(|1 - e| / (1 + e)) D:
 *
 *   t - tp = sqrt(p^3/mu) [ 2 A D / (1+e)^2 + 8 e S3 A^3 D^3 / (1+e)^3 ]
 *
 * with A = atan(w)/w, S3 = (E - sin E)/E^3, E = 2 atan(w) for ellipses, and A = atanh(w)/w,
 * S3 = (sinh H - H)/H^3, H = 2 atanh(w) for hyperbolas. At e = 1 it reduces to Barker's equation
 * (D/2 + D^3/6). Every factor is evaluated without cancellation (series near zero). For ellipses with
 * |E| > pi/2 the classical form is used instead (no cancellation there and D may be infinite).
 *
 * This is the same relation as timeSincePeriapsis in src/core/math/conic.ts (what UI consumers of
 * Patch.conic evaluate), conditioned for the near-parabolic band where the core form E - e sin E / its
 * Barker band lose digits; tests/unit/sim-orbits/anomaly.test.ts asserts the two agree for e in [0, 5].
 * docs/requests/sim-orbits-3.md asks core to adopt this form, after which the sim calls the core function.
 */

/** atan(w)/w, exact at 0. */
export function atanOverX(w: number): number {
  const w2 = w * w;
  if (w2 < 1e-6) return 1 - w2 / 3 + (w2 * w2) / 5;
  return Math.atan(w) / w;
}

/** atanh(w)/w, exact at 0 (|w| < 1). */
export function atanhOverX(w: number): number {
  const w2 = w * w;
  if (w2 < 1e-6) return 1 + w2 / 3 + (w2 * w2) / 5;
  return Math.atanh(w) / w;
}

// 1/(2k+3)! for k = 0..7
const S3_SERIES = [1 / 6, 1 / 120, 1 / 5040, 1 / 362880, 1 / 39916800, 1 / 6227020800, 1 / 1307674368000, 1 / 355687428096000];

/** (E - sin E)/E^3 (sign = -1) or (sinh H - H)/H^3 (sign = +1), cancellation-free. */
function remainder3(x: number, sign: 1 | -1): number {
  const x2 = x * x;
  if (x2 < 0.25) {
    // sum_k (sign x^2)^k / (2k+3)!
    const s = sign * x2;
    let acc = S3_SERIES[7]!;
    for (let k = 6; k >= 0; k--) acc = acc * s + S3_SERIES[k]!;
    return acc;
  }
  return sign < 0 ? (x - Math.sin(x)) / (x2 * x) : (Math.sinh(x) - x) / (x2 * x);
}

/**
 * Time since periapsis (s) at true anomaly `nu` in (-pi, pi] for a conic of eccentricity `e`, semi-latus
 * rectum `p` and gravitational parameter `mu`. Negative before periapsis. Elliptic results lie in
 * (-period/2, period/2]; beyond a hyperbola's asymptote the result is +/-Infinity.
 */
export function timeFromPeriapsis(e: number, p: number, mu: number, nu: number): number {
  const half = 0.5 * nu;
  const sh = Math.sin(half);
  const ch = Math.cos(half);
  const k = Math.sqrt((p * p * p) / mu);
  const ope = 1 + e;
  if (e < 1) {
    const s = Math.sqrt((1 - e) / ope);
    if (Math.abs(s * sh) <= Math.abs(ch)) {
      const D = sh / ch;
      const w = s * D;
      const A = atanOverX(w);
      const E = 2 * Math.atan(w);
      const S3 = remainder3(E, -1);
      return k * ((2 * A * D) / (ope * ope) + (8 * e * S3 * A * A * A * D * D * D) / (ope * ope * ope));
    }
    const E = 2 * Math.atan2(s * sh, ch);
    const M = E - e * Math.sin(E);
    const a = p / (1 - e * e);
    return M * Math.sqrt((a * a * a) / mu);
  }
  if (!(ch > 0)) return sh > 0 ? Infinity : -Infinity;
  const s = Math.sqrt((e - 1) / ope);
  const D = sh / ch;
  const w = s * D;
  if (Math.abs(w) >= 1) return w > 0 ? Infinity : -Infinity;
  const A = atanhOverX(w);
  const H = 2 * Math.atanh(w);
  const S3 = remainder3(H, 1);
  return k * ((2 * A * D) / (ope * ope) + (8 * e * S3 * A * A * A * D * D * D) / (ope * ope * ope));
}

/** Mean anomaly (rad, (-pi, pi]) of an ellipse (e < 1) at true anomaly `nu` in (-pi, pi]. */
export function meanAnomalyFromTrue(e: number, nu: number): number {
  const E = 2 * Math.atan2(Math.sqrt(1 - e) * Math.sin(0.5 * nu), Math.sqrt(1 + e) * Math.cos(0.5 * nu));
  return E - e * Math.sin(E);
}

/** True anomaly of an ellipse from its eccentric anomaly. */
export function trueFromEccentric(e: number, E: number): number {
  return 2 * Math.atan2(Math.sqrt(1 + e) * Math.sin(0.5 * E), Math.sqrt(1 - e) * Math.cos(0.5 * E));
}

/**
 * Eccentric anomaly of an ellipse for mean anomaly `M` (any value; result in the same revolution as M
 * reduced to (-pi, pi]). Newton iteration from a third-order starter, converged to machine precision.
 */
export function eccentricFromMean(e: number, M: number): number {
  const Mr = M - 2 * Math.PI * Math.floor((M + Math.PI) / (2 * Math.PI));
  let E = e < 0.8 ? Mr + e * Math.sin(Mr) : Mr >= 0 ? Math.PI : -Math.PI;
  for (let i = 0; i < 60; i++) {
    const f = E - e * Math.sin(E) - Mr;
    const fp = 1 - e * Math.cos(E);
    const fpp = e * Math.sin(E);
    // Halley step
    const d = f / (fp - (0.5 * f * fpp) / fp);
    E -= d;
    if (Math.abs(d) <= 1e-15 * Math.max(1, Math.abs(E))) break;
  }
  return E;
}
