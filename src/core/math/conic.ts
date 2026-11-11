import type { Vec3 } from './vec3';
import { v3 } from './vec3';

/**
 * Geometry of a two-body conic, expressed in the body-centred inertial frame of its central body.
 * This is the wire format for every orbit that crosses a module boundary (snapshot patches, body orbits,
 * map view). Kepler propagation in time lives in src/sim/orbit; only time-free geometry and the
 * anomaly -> time relation live here so the UI can draw and hit-test conics without importing the sim.
 *
 * RADIAL trajectories (h = r x v = 0: a vessel at rest relative to the body's centre, or moving exactly
 * along the vertical) have no conic geometry. `conicFromState` throws for them; the sim publishes them in
 * `Patch.conic` with this degenerate convention, which consumers detect with `p === 0`:
 *   e = 1 and p = 0; a = 1/alpha from the energy (finite unless parabolic, Infinity then); P = minus the
 *   vessel's radial direction (the limit of the periapsis direction); W = an arbitrary unit vector normal
 *   to P, Q = W x P; period = null.
 * The vessel stays at true anomaly pi (`Patch.nuStart = nuEnd = pi`), so the anomaly-based helpers below
 * (`conicRadius`, `conicPosition`, `conicVelocity`, `timeSincePeriapsis`, `conicRadiusCrossing`) do not
 * apply. Drawing code treats such a patch as the straight segment between its start and end positions
 * (the vessel position at `tStart` and the end marker's `r`).
 */
export interface ConicElements {
  /** Gravitational parameter of the central body, m^3/s^2. */
  mu: number;
  /** Semi-latus rectum, m. */
  p: number;
  /** Eccentricity (>= 0). */
  e: number;
  /** Semi-major axis, m. Negative for hyperbolas, Infinity for a parabola. */
  a: number;
  /** Unit vector to periapsis. For circular orbits: the position direction at the epoch the elements were built. */
  P: Vec3;
  /** Unit vector 90 degrees ahead of P in the orbit plane (Q = W x P). */
  Q: Vec3;
  /** Unit orbit normal (direction of angular momentum). */
  W: Vec3;
  /** UT (s) of the periapsis passage nearest the epoch. */
  tPeriapsis: number;
  /**
   * Orbital period in seconds; null when the conic is not closed (e >= 1) and also in the near-parabolic
   * band e >= 1 - 1e-9, where `a` is reported as Infinity (`conicFromState`). Test `period !== null` for
   * "closed", never `e < 1`.
   */
  period: number | null;
  /** Inclination to the central body's inertial XY plane, rad. */
  inc: number;
  /** Longitude of the ascending node, rad (0 when equatorial). */
  lan: number;
  /** Argument of periapsis, rad. */
  argPe: number;
}

const PARABOLIC_EPS = 1e-9;
const CIRCULAR_EPS = 1e-10;

/** Build conic elements from a state vector at time `t`. Radial (h = 0) trajectories are not supported. */
export function conicFromState(mu: number, r: Vec3, v: Vec3, t: number): ConicElements {
  const h = v3.cross(r, v);
  const hLen = v3.len(h);
  if (!(hLen > 0)) throw new Error('conicFromState: degenerate (radial) trajectory');
  const W = v3.scale(h, 1 / hLen);
  const rLen = v3.len(r);
  const rHat = v3.scale(r, 1 / rLen);
  const evec = v3.sub(v3.scale(v3.cross(v, h), 1 / mu), rHat);
  const e = v3.len(evec);
  const P = e > CIRCULAR_EPS ? v3.scale(evec, 1 / e) : rHat;
  const Q = v3.cross(W, P);
  const p = (hLen * hLen) / mu;
  const oneMinusE2 = 1 - e * e;
  const a = Math.abs(oneMinusE2) < PARABOLIC_EPS ? Infinity : p / oneMinusE2;
  const nu0 = Math.atan2(v3.dot(r, Q), v3.dot(r, P));
  const partial: ConicElements = { mu, p, e, a, P, Q, W, tPeriapsis: 0, period: null, inc: 0, lan: 0, argPe: 0 };
  partial.period = e < 1 - PARABOLIC_EPS ? 2 * Math.PI * Math.sqrt((a * a * a) / mu) : null;
  partial.tPeriapsis = t - timeSincePeriapsis(partial, nu0);
  partial.inc = Math.acos(Math.max(-1, Math.min(1, W.z)));
  const nx = -W.y;
  const ny = W.x;
  const nLen = Math.hypot(nx, ny);
  if (nLen < 1e-12) {
    partial.lan = 0;
    partial.argPe = Math.atan2(P.y * Math.sign(W.z || 1), P.x);
  } else {
    partial.lan = Math.atan2(ny, nx);
    const n: Vec3 = { x: nx / nLen, y: ny / nLen, z: 0 };
    partial.argPe = Math.atan2(v3.dot(v3.cross(n, P), W), v3.dot(n, P));
  }
  return partial;
}

/** Distance from the focus at true anomaly `nu`. Infinite/negative values mean "beyond the asymptote". */
export const conicRadius = (c: ConicElements, nu: number): number => c.p / (1 + c.e * Math.cos(nu));

/** Position at true anomaly `nu` (central-body inertial frame). */
export function conicPosition(c: ConicElements, nu: number): Vec3 {
  const r = conicRadius(c, nu);
  const cs = Math.cos(nu) * r;
  const sn = Math.sin(nu) * r;
  return { x: c.P.x * cs + c.Q.x * sn, y: c.P.y * cs + c.Q.y * sn, z: c.P.z * cs + c.Q.z * sn };
}

/** Velocity at true anomaly `nu`. */
export function conicVelocity(c: ConicElements, nu: number): Vec3 {
  const k = Math.sqrt(c.mu / c.p);
  const a = -Math.sin(nu) * k;
  const b = (c.e + Math.cos(nu)) * k;
  return { x: c.P.x * a + c.Q.x * b, y: c.P.y * a + c.Q.y * b, z: c.P.z * a + c.Q.z * b };
}

/** True anomaly of a position vector (need not lie exactly on the conic), in (-pi, pi]. */
export const conicTrueAnomaly = (c: ConicElements, r: Vec3): number => Math.atan2(v3.dot(r, c.Q), v3.dot(r, c.P));

/** Periapsis and apoapsis radii (apoapsis Infinity when open). */
export const conicApsides = (c: ConicElements): { rp: number; ra: number } => ({
  rp: c.p / (1 + c.e),
  ra: c.e < 1 - PARABOLIC_EPS ? c.p / (1 - c.e) : Infinity,
});

/** Largest true anomaly that is still on the conic (pi for ellipses, the asymptote angle for hyperbolas). */
export const conicMaxTrueAnomaly = (c: ConicElements): number =>
  c.e < 1 - PARABOLIC_EPS ? Math.PI : Math.acos(Math.max(-1, -1 / Math.max(c.e, 1)));

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
 *
 * Well conditioned for every eccentricity, including the near-parabolic band where the classical
 * E - e sin E / e sinh H - H forms lose most of their digits. With D = tan(nu/2) and
 * w = sqrt(|1 - e| / (1 + e)) D:
 *
 *   t - tp = sqrt(p^3/mu) [ 2 A D / (1+e)^2 + 8 e S3 A^3 D^3 / (1+e)^3 ]
 *
 * where A = atan(w)/w, S3 = (E - sin E)/E^3, E = 2 atan(w) for ellipses, and A = atanh(w)/w,
 * S3 = (sinh H - H)/H^3, H = 2 atanh(w) for hyperbolas. At e = 1 it is Barker's equation
 * (D/2 + D^3/6) exactly; there is no parabolic band. Every factor is evaluated without cancellation
 * (series near zero). For ellipses with |E| > pi/2 the classical form is used instead (no cancellation
 * there, and D may be infinite). The one relation for the sim (tPeriapsis, event times) and for UI
 * consumers of Patch.conic.
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

/**
 * Time since periapsis passage at true anomaly `nu` in (-pi, pi]: negative before periapsis.
 * Elliptic results lie in (-period/2, period/2]; beyond a hyperbola's asymptote the result is +/-Infinity.
 * Uses only `c.e`, `c.p` and `c.mu` (never `c.a`): see `timeFromPeriapsis`. Not meaningful for a radial
 * conic (`c.p === 0`).
 */
export function timeSincePeriapsis(c: ConicElements, nu: number): number {
  return timeFromPeriapsis(c.e, c.p, c.mu, nu);
}

/**
 * True anomalies (+/-) at which the conic crosses radius `R`, or null when it never does.
 * The outbound crossing is +nu, the inbound crossing is -nu.
 */
export function conicRadiusCrossing(c: ConicElements, R: number): number | null {
  if (c.e < CIRCULAR_EPS) return null;
  const cosNu = (c.p / R - 1) / c.e;
  if (cosNu < -1 || cosNu > 1) return null;
  return Math.acos(cosNu);
}
