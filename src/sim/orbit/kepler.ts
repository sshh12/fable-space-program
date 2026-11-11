/**
 * Universal-variable Kepler propagation (docs/research/sim-design.md 3.1).
 *
 * An Orbit is an epoch state {r0, v0, t0} about one body plus derived constants. `propagate` ALWAYS
 * evaluates from the epoch state (never incrementally), so rails warp accumulates no drift; elliptic
 * orbits reduce the time of flight modulo the period, so a state 1e6 periods ahead is as exact as one
 * period ahead. Laguerre-Conway iteration (n = 5) with a bisection fallback on the monotonic Kepler
 * function; Stumpff functions by power series for |psi| <= 1 and closed forms beyond.
 */
import type { StateVector } from '../../core/contracts/simInternal';
import { conicFromState, type ConicElements } from '../../core/math/conic';
import { v3, type Vec3 } from '../../core/math/vec3';
import { atanhOverX, atanOverX, timeFromPeriapsis } from './anomaly';

export interface Orbit {
  /** Central body; the state is in BCI(bodyId). */
  readonly bodyId: string;
  /** Gravitational parameter, m^3/s^2. */
  readonly mu: number;
  /** Epoch state and time (s since J2000). */
  readonly r0: Vec3;
  readonly v0: Vec3;
  readonly t0: number;
  // ---- derived (set by makeOrbit; never edit) ----
  readonly sqrtMu: number;
  /** |r0| */
  readonly r0m: number;
  /** dot(r0, v0) / sqrt(mu) */
  readonly sigma0: number;
  /** 1/a = 2/|r0| - |v0|^2/mu (> 0 ellipse, < 0 hyperbola). */
  readonly alpha: number;
  /**
   * Period (s) of every bound trajectory that is propagated as closed (ellipses with e < 1 - 1e-9, and
   * bound near-radial ones), else null. conic.period carries the same value whenever conic.e < 1.
   */
  readonly period: number | null;
  /**
   * Geometry of the conic (the Patch.conic wire format). `tPeriapsis` is the periapsis passage nearest t0
   * from the cancellation-free relations of ./anomaly.ts (from the universal anomaly of the state for
   * near-radial orbits); `period` is Orbit.period when e < 1, else null. Near-radial orbits carry
   * a = 1/alpha (finite) and e strictly on the side of 1 their energy says (e < 1 bound, e > 1 unbound).
   * A RADIAL trajectory has the documented degenerate conic { e: 1, p: 0, a: 1/alpha, P: -r_hat (the limit
   * periapsis direction, from the vessel's ray through the body centre), W: an arbitrary unit normal,
   * period: null }: the vessel is at true anomaly pi for the whole trajectory, and positions follow from
   * (a, tPeriapsis, P) by conicStateAtTime.
   */
  readonly conic: ConicElements;
  /** True when r0 x v0 vanishes (|h| <= 1e-12 |r0| max(|v0|, v_circ)): `conic` is the degenerate radial conic. */
  readonly radial: boolean;
  /**
   * Radial or nearly so (p < NEAR_RADIAL_P |r0|): anomaly-based event times are ill-conditioned there, so the
   * event finders work with the universal anomaly from the epoch instead.
   */
  readonly nearRadial: boolean;
}

/** Semi-latus rectum below this fraction of |r0| makes an orbit "near-radial". */
export const NEAR_RADIAL_P = 1e-6;

/** Build an Orbit (with derived constants and conic) from a state in BCI(bodyId) at time t0. */
export function makeOrbit(bodyId: string, mu: number, r0: Vec3, v0: Vec3, t0: number): Orbit {
  if (!(mu > 0)) throw new Error(`makeOrbit: mu must be positive (got ${mu})`);
  const r0m = v3.len(r0);
  if (!(r0m > 0) || !v3.isFinite(r0) || !v3.isFinite(v0) || !Number.isFinite(t0)) {
    throw new Error('makeOrbit: state must be finite with |r0| > 0');
  }
  const sqrtMu = Math.sqrt(mu);
  const alpha = 2 / r0m - v3.lenSq(v0) / mu;
  const sigma0 = v3.dot(r0, v0) / sqrtMu;
  const vRef = Math.max(v3.len(v0), Math.sqrt(mu / r0m));
  const hm = v3.len(v3.cross(r0, v0));
  const radial = !(hm > 1e-12 * r0m * vRef);
  const conic = radial ? radialConic(mu, r0, vRef, t0) : conicFromState(mu, r0, v0, t0);
  // Near-radial: the conic's anomalies are ill-conditioned (e -> 1, p -> 0); events use the universal
  // variable instead (events.ts). A bound (near-)radial trajectory is closed although e rounds to 1.
  const nearRadial = radial || conic.p < NEAR_RADIAL_P * r0m;
  if (nearRadial && !radial) {
    // e = sqrt(1 - p alpha) can lie within rounding of 1 here. When it rounded to the wrong side, take the
    // nearest double on the side the energy says: the geometry is carried by p (and a, tPeriapsis), and e
    // only has to classify the conic consistently with its period.
    if (alpha > 0 && conic.e >= 1) conic.e = 1 - 2 ** -53;
    else if (!(alpha > 0) && conic.e <= 1) conic.e = 1 + 2 ** -52;
  }
  if (nearRadial) {
    conic.a = alpha !== 0 ? 1 / alpha : Infinity;
    conic.tPeriapsis = t0 - timeSincePeriapsisOfState(sqrtMu, alpha, r0m, sigma0, conic.p / (1 + conic.e));
  } else {
    const nu0 = Math.atan2(v3.dot(r0, conic.Q), v3.dot(r0, conic.P));
    conic.tPeriapsis = t0 - timeFromPeriapsis(conic.e, conic.p, mu, nu0);
  }
  const period = alpha > 0 && (conic.period !== null || nearRadial) ? (2 * Math.PI) / (sqrtMu * alpha * Math.sqrt(alpha)) : null;
  conic.period = period !== null && conic.e < 1 ? period : null;
  return {
    bodyId,
    mu,
    r0: v3.clone(r0),
    v0: v3.clone(v0),
    t0,
    sqrtMu,
    r0m,
    sigma0,
    alpha,
    period,
    conic,
    radial,
    nearRadial,
  };
}

/**
 * Degenerate conic of a radial trajectory through r0: the plane, normal and angles of conicFromState for a
 * vanishing velocity perpendicular to r0 (whose eccentricity vector is exactly -r_hat), with e = 1, p = 0
 * and P = -r_hat exactly. a, tPeriapsis and period are set by makeOrbit.
 */
function radialConic(mu: number, r0: Vec3, vRef: number, t0: number): ConicElements {
  const c = conicFromState(mu, r0, v3.scale(v3.anyOrthogonal(r0), 1e-9 * vRef), t0);
  c.P = v3.neg(v3.normalize(r0));
  c.Q = v3.cross(c.W, c.P);
  c.e = 1;
  c.p = 0;
  return c;
}

/**
 * Universal anomaly chi from the periapsis passage to a state with radius r, sigma = r.v/sqrt(mu), on a
 * conic with 1/a = alpha: chi = E/sqrt(alpha) (ellipse), H/sqrt(-alpha) (hyperbola), sigma (parabola),
 * from e cos E = 1 - alpha r, e sin E = sigma sqrt(alpha) (cosh/sinh for hyperbolas). Well conditioned for
 * every energy and for (near-)radial states, without the conic's anomalies.
 */
function chiFromPeriapsis(alpha: number, r: number, sigma: number): number {
  const s = Math.sqrt(Math.abs(alpha));
  const x = 1 - alpha * r;
  if (alpha > 0 && !(x > 0)) return Math.atan2(sigma * s, x) / s;
  const w = (sigma * s) / x;
  return (sigma / x) * (alpha > 0 ? atanOverX(w) : alpha < 0 ? atanhOverX(w) : 1);
}

/**
 * Time since the periapsis passage (s; negative before it; elliptic results in [-P/2, P/2]) of a state with
 * radius r and sigma = r.v/sqrt(mu) on the conic with 1/a = alpha and periapsis radius rp:
 * sqrt(mu) dt = (1 - alpha rp) chi^3 c3(alpha chi^2) + rp chi (Kepler's equation from the periapsis).
 */
export function timeSincePeriapsisOfState(sqrtMu: number, alpha: number, r: number, sigma: number, rp: number): number {
  const chi = chiFromPeriapsis(alpha, r, sigma);
  stumpffSet(alpha * chi * chi);
  return ((1 - alpha * rp) * chi * chi * chi * C3 + rp * chi) / sqrtMu;
}

/**
 * State at time t on a conic, from its periapsis passage (universal variables anchored at the periapsis,
 * 1/a = 1/conic.a, rp = p/(1 + e)):
 *   x = rp - chi^2 c2,  y = sqrt(p) chi (1 - psi c3)                         (along P, Q)
 *   vx = sqrt(mu) chi (psi c3 - 1)/r,  vy = sqrt(mu p) (1 - psi c2)/r,  r = (1 - alpha rp) chi^2 c2 + rp
 * with chi from Kepler's equation from the periapsis (bracketed Newton, monotonic). Nothing divides by p
 * or 1 - e, so this stays exact for radial (p = 0) and near-radial conics, where reconstructing from the
 * true anomaly loses ~1e-16 r^2/p; its accuracy is that of t - tPeriapsis (|v| x ~1e-7 s at ut ~ 1e9).
 */
export function conicStateAtTime(c: ConicElements, t: number): StateVector {
  const sqrtMu = Math.sqrt(c.mu);
  const alpha = Number.isFinite(c.a) ? 1 / c.a : 0;
  const rp = c.p / (1 + c.e);
  const k = 1 - alpha * rp;
  let dt = t - c.tPeriapsis;
  let lo: number;
  let hi: number;
  if (alpha > 0) {
    const sa = Math.sqrt(alpha);
    const P = (2 * Math.PI) / (sqrtMu * alpha * sa);
    dt -= P * Math.round(dt / P);
    lo = -Math.PI / sa;
    hi = Math.PI / sa;
  } else {
    // c3 >= 1/6 for psi <= 0, so |G(chi)| >= k |chi|^3/6 + rp |chi| - |target|: this bound brackets the root.
    const at = sqrtMu * Math.abs(dt);
    const b = Math.min(Math.cbrt((6 * at) / k), rp > 0 ? at / rp : Infinity);
    lo = dt >= 0 ? 0 : -b;
    hi = dt >= 0 ? b : 0;
  }
  const target = sqrtMu * dt;
  let chi = 0.5 * (lo + hi);
  for (let i = 0; i < 200; i++) {
    const chi2 = chi * chi;
    stumpffSet(alpha * chi2);
    const g = k * chi2 * chi * C3 + rp * chi - target;
    if (g === 0) break;
    if (g > 0) hi = chi;
    else lo = chi;
    let next = chi - g / (k * chi2 * C2 + rp);
    if (!(next > lo && next < hi)) next = 0.5 * (lo + hi);
    if (next === chi || Math.abs(next - chi) <= 1e-15 * Math.abs(next)) {
      chi = next;
      break;
    }
    chi = next;
  }
  const chi2 = chi * chi;
  const psi = alpha * chi2;
  stumpffSet(psi);
  const r = k * chi2 * C2 + rp;
  const sp = Math.sqrt(c.p);
  const x = rp - chi2 * C2;
  const y = sp * chi * (1 - psi * C3);
  const vx = (sqrtMu * chi * (psi * C3 - 1)) / r;
  const vy = (sqrtMu * sp * (1 - psi * C2)) / r;
  return {
    r: { x: c.P.x * x + c.Q.x * y, y: c.P.y * x + c.Q.y * y, z: c.P.z * x + c.Q.z * y },
    v: { x: c.P.x * vx + c.Q.x * vy, y: c.P.y * vx + c.Q.y * vy, z: c.P.z * vx + c.Q.z * vy },
  };
}

// --------------------------------------------------------------------------------------------- Stumpff

/** 1/n! for n = 2..21 (index n - 2). */
const INV_FACT: number[] = [];
{
  let f = 1;
  for (let n = 1; n <= 21; n++) {
    f *= n;
    if (n >= 2) INV_FACT.push(1 / f);
  }
}

let C2 = 0.5;
let C3 = 1 / 6;

/** Sets the module scratch C2 = c2(psi), C3 = c3(psi). */
function stumpffSet(psi: number): void {
  if (psi > 1) {
    const s = Math.sqrt(psi);
    const h = Math.sin(0.5 * s);
    C2 = (2 * h * h) / psi;
    C3 = (s - Math.sin(s)) / (psi * s);
  } else if (psi < -1) {
    const s = Math.sqrt(-psi);
    C2 = (Math.cosh(s) - 1) / -psi;
    C3 = (Math.sinh(s) - s) / (-psi * s);
  } else {
    // c2 = sum (-psi)^k/(2k+2)!, c3 = sum (-psi)^k/(2k+3)!, k = 0..9
    const x = -psi;
    let a2 = INV_FACT[18]!; // 1/20!
    let a3 = INV_FACT[19]!; // 1/21!
    for (let k = 8; k >= 0; k--) {
      a2 = a2 * x + INV_FACT[2 * k]!;
      a3 = a3 * x + INV_FACT[2 * k + 1]!;
    }
    C2 = a2;
    C3 = a3;
  }
}

/** Stumpff functions c2(psi), c3(psi). */
export function stumpff(psi: number): { c2: number; c3: number } {
  stumpffSet(psi);
  return { c2: C2, c3: C3 };
}

// ------------------------------------------------------------------------------------------ propagation

/**
 * Time of flight from the epoch reduced to (-period/2, period/2] for closed orbits. `offset` is added to
 * t - t0: a caller that keeps time as a base instant plus a small offset passes them apart, so the time
 * of flight keeps the offset's precision (at epochs of 1e9 s a float64 instant resolves only 1.2e-7 s).
 */
function reducedDt(o: Orbit, t: number, offset = 0): number {
  let dt = t - o.t0 + offset;
  const P = o.period;
  if (P !== null) {
    dt %= P;
    if (dt > 0.5 * P) dt -= P;
    else if (dt < -0.5 * P) dt += P;
  }
  return dt;
}

/** Kepler function F(chi) = sigma0 chi^2 c2 + (1 - alpha r0) chi^3 c3 + r0 chi - sqrt(mu) dt (monotonic: F' = r > 0). */
function keplerF(o: Orbit, dt: number, chi: number): number {
  const chi2 = chi * chi;
  stumpffSet(chi2 * o.alpha);
  return o.sigma0 * chi2 * C2 + (1 - o.alpha * o.r0m) * chi2 * chi * C3 + o.r0m * chi - o.sqrtMu * dt;
}

function initialChi(o: Orbit, dt: number): number {
  const a = o.alpha;
  const r0 = o.r0m;
  const ar = a * r0;
  const sm = o.sqrtMu;
  if (ar > 1e-6) return sm * dt * a;
  if (ar < -1e-6) {
    const aa = 1 / a;
    const sg = dt >= 0 ? 1 : -1;
    const num = -2 * o.mu * a * dt;
    const den = o.sigma0 * sm + sg * Math.sqrt(-o.mu * aa) * (1 - r0 * a);
    const arg = num / den;
    if (arg > 0 && Number.isFinite(arg)) {
      const chi = sg * Math.sqrt(-aa) * Math.log(arg);
      if (Number.isFinite(chi) && chi * sg > 0) return chi;
    }
    return (sm * dt) / r0;
  }
  // Near-parabolic: real root of the parabolic Kepler cubic chi^3/6 + sigma0 chi^2/2 + r0 chi = sqrt(mu) dt.
  const s0 = o.sigma0;
  const p = 6 * r0 - 3 * s0 * s0;
  const q = 2 * s0 * s0 * s0 - 6 * r0 * s0 - 6 * sm * dt;
  if (p > 0) {
    const disc = Math.sqrt((q * q) / 4 + (p * p * p) / 27);
    return Math.cbrt(-q / 2 + disc) + Math.cbrt(-q / 2 - disc) - s0;
  }
  return (sm * dt) / r0;
}

/** Bisection on the monotonic Kepler function (fallback when Laguerre-Conway does not converge). */
function bisectChi(o: Orbit, dt: number, guess: number): number {
  let lo = guess;
  let hi = guess;
  let step = Math.max(Math.abs(guess), Math.sqrt(o.r0m) * 1e-3, 1e-12);
  if (keplerF(o, dt, guess) > 0) {
    lo = guess - step;
    while (keplerF(o, dt, lo) > 0) {
      step *= 2;
      lo = guess - step;
    }
  } else {
    hi = guess + step;
    while (keplerF(o, dt, hi) < 0) {
      step *= 2;
      hi = guess + step;
    }
  }
  for (let i = 0; i < 400; i++) {
    const mid = 0.5 * (lo + hi);
    if (mid <= lo || mid >= hi) break;
    if (keplerF(o, dt, mid) > 0) hi = mid;
    else lo = mid;
  }
  return 0.5 * (lo + hi);
}

/**
 * Universal anomaly chi for a (reduced) time of flight `dt` from the epoch. `maxIterations` bounds the
 * Laguerre-Conway loop (tests pass 0 to exercise the bisection fallback).
 */
export function solveUniversalAnomaly(o: Orbit, dt: number, maxIterations = 50): number {
  if (dt === 0) return 0;
  let chi = initialChi(o, dt);
  const a = o.alpha;
  const r0 = o.r0m;
  const s0 = o.sigma0;
  const omar = 1 - a * r0;
  const target = o.sqrtMu * dt;
  let prev = Infinity;
  for (let it = 0; it < maxIterations; it++) {
    const chi2 = chi * chi;
    const psi = chi2 * a;
    stumpffSet(psi);
    const F = s0 * chi2 * C2 + omar * chi2 * chi * C3 + r0 * chi - target;
    const dF = s0 * chi * (1 - psi * C3) + omar * chi2 * C2 + r0;
    const ddF = s0 * (1 - psi * C2) + omar * chi * (1 - psi * C3);
    const root = Math.sqrt(Math.abs(16 * dF * dF - 20 * F * ddF));
    const den = dF + (dF >= 0 ? root : -root);
    if (!(den !== 0) || !Number.isFinite(den)) break;
    const delta = (5 * F) / den;
    chi -= delta;
    const ad = Math.abs(delta);
    const scale = Math.abs(chi);
    if (ad <= 1e-14 * scale || ad === 0) return chi;
    if (ad <= 1e-10 * scale && ad >= prev) return chi; // stagnated at rounding level
    prev = ad;
  }
  return bisectChi(o, dt, Number.isFinite(chi) ? chi : initialChi(o, dt));
}

/** Lagrange coefficients f, g, fdot, gdot at time t (for diagnostics and tests). */
export function lagrangeCoefficients(o: Orbit, t: number): { f: number; g: number; fdot: number; gdot: number; chi: number; r: number } {
  const dt = reducedDt(o, t);
  const chi = solveUniversalAnomaly(o, dt);
  const chi2 = chi * chi;
  const psi = chi2 * o.alpha;
  stumpffSet(psi);
  const f = 1 - (chi2 * C2) / o.r0m;
  const g = dt - (chi2 * chi * C3) / o.sqrtMu;
  const rx = f * o.r0.x + g * o.v0.x;
  const ry = f * o.r0.y + g * o.v0.y;
  const rz = f * o.r0.z + g * o.v0.z;
  const rm = Math.hypot(rx, ry, rz);
  const fdot = (o.sqrtMu * chi * (psi * C3 - 1)) / (rm * o.r0m);
  const gdot = 1 - (chi2 * C2) / rm;
  return { f, g, fdot, gdot, chi, r: rm };
}

/** State at time t (+ offset, see reducedDt) written into outR / outV (allocation-free; for hot loops). */
export function propagateInto(o: Orbit, t: number, outR: Vec3, outV: Vec3, offset = 0): void {
  const dt = reducedDt(o, t, offset);
  const chi = solveUniversalAnomaly(o, dt);
  const chi2 = chi * chi;
  const psi = chi2 * o.alpha;
  stumpffSet(psi);
  const f = 1 - (chi2 * C2) / o.r0m;
  const g = dt - (chi2 * chi * C3) / o.sqrtMu;
  const r0 = o.r0;
  const v0 = o.v0;
  const rx = f * r0.x + g * v0.x;
  const ry = f * r0.y + g * v0.y;
  const rz = f * r0.z + g * v0.z;
  const rm = Math.hypot(rx, ry, rz);
  const fdot = (o.sqrtMu * chi * (psi * C3 - 1)) / (rm * o.r0m);
  const gdot = 1 - (chi2 * C2) / rm;
  outR.x = rx;
  outR.y = ry;
  outR.z = rz;
  outV.x = fdot * r0.x + gdot * v0.x;
  outV.y = fdot * r0.y + gdot * v0.y;
  outV.z = fdot * r0.z + gdot * v0.z;
}

/**
 * State at time t (BCI of the orbit's body). Always evaluated from the epoch state. With `offset` the
 * state is that at t + offset, the two kept apart for precision (see reducedDt).
 */
export function propagate(o: Orbit, t: number, offset = 0): StateVector {
  const r = { x: 0, y: 0, z: 0 };
  const v = { x: 0, y: 0, z: 0 };
  propagateInto(o, t, r, v, offset);
  return { r, v };
}

/** Position only at time t. */
export function positionAt(o: Orbit, t: number): Vec3 {
  const r = { x: 0, y: 0, z: 0 };
  propagateInto(o, t, r, SCRATCH_V);
  return r;
}
const SCRATCH_V: Vec3 = { x: 0, y: 0, z: 0 };

/** Orbit re-anchored at time t (same trajectory, new epoch). */
export function reanchor(o: Orbit, t: number): Orbit {
  const s = propagate(o, t);
  return makeOrbit(o.bodyId, o.mu, s.r, s.v, t);
}

/** Specific orbital energy v^2/2 - mu/r (conserved). */
export const specificEnergy = (mu: number, r: Vec3, v: Vec3): number => 0.5 * v3.lenSq(v) - mu / v3.len(r);
