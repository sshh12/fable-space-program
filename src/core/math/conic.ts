import type { Vec3 } from './vec3';
import { v3 } from './vec3';

/**
 * Geometry of a two-body conic, expressed in the body-centred inertial frame of its central body.
 * This is the wire format for every orbit that crosses a module boundary (snapshot patches, body orbits,
 * map view). Kepler propagation in time lives in src/sim/orbit; only time-free geometry and the
 * anomaly -> time relation live here so the UI can draw and hit-test conics without importing the sim.
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
  /** Orbital period in seconds, null when not closed (e >= 1). */
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

/**
 * Time since periapsis passage at true anomaly `nu` in (-pi, pi]: negative before periapsis.
 * Elliptic results lie in (-period/2, period/2].
 */
export function timeSincePeriapsis(c: ConicElements, nu: number): number {
  const e = c.e;
  if (e < 1 - PARABOLIC_EPS) {
    const E = 2 * Math.atan2(Math.sqrt(1 - e) * Math.sin(nu / 2), Math.sqrt(1 + e) * Math.cos(nu / 2));
    const M = E - e * Math.sin(E);
    return M * Math.sqrt((c.a * c.a * c.a) / c.mu);
  }
  if (e > 1 + PARABOLIC_EPS) {
    const th = Math.sqrt((e - 1) / (e + 1)) * Math.tan(nu / 2);
    if (Math.abs(th) >= 1) return th > 0 ? Infinity : -Infinity;
    const H = 2 * Math.atanh(th);
    const M = e * Math.sinh(H) - H;
    const aAbs = -c.a;
    return M * Math.sqrt((aAbs * aAbs * aAbs) / c.mu);
  }
  const D = Math.tan(nu / 2);
  return 0.5 * Math.sqrt((c.p * c.p * c.p) / c.mu) * (D + (D * D * D) / 3);
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
