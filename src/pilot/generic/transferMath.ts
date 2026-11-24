/**
 * The arithmetic of the generic transfer pilot (src/pilot/generic/transfer.ts), from what a player sees: the
 * bodies' states and orbits in the snapshot. Patched conics between two bodies about one parent; Hohmann
 * transfers between the mean orbits; Lambert arcs between the bodies' positions propagated on their osculating
 * conics; the hyperbolic ejection from a parking orbit toward an asymptote in space. The pilot imports src/core
 * only (ARCHITECTURE 2), so this is its own copy of these formulas, not the planner of src/sim/nav (the
 * universal-variable Lambert below is the same method as src/sim/orbit/lambert.ts, with a bisection in place of
 * Brent's method; tests/unit/solar-system/transferMath.test.ts holds the two together).
 */
import type { BodySnapshot } from '@/core/contracts/sim';
import { conicFromState, conicPosition, conicRadiusCrossing, conicVelocity, timeSincePeriapsis, type ConicElements } from '@/core/math/conic';
import { v3, type Vec3 } from '@/core/math/vec3';

const TWO_PI = 2 * Math.PI;
export const wrap2pi = (x: number): number => ((x % TWO_PI) + TWO_PI) % TWO_PI;

/** Position and velocity of `body` relative to `parent` (both from the snapshot, ROOT axes). */
export function relativeTo(body: BodySnapshot, parent: BodySnapshot): { r: Vec3; v: Vec3 } {
  return { r: v3.sub(body.rRoot, parent.rRoot), v: v3.sub(body.vRoot, parent.vRoot) };
}

/** Mean motion (rad/s) and mean orbit radius of a body about its parent, from its orbit in the snapshot (or its state). */
export function meanOrbit(body: BodySnapshot, parent: BodySnapshot, muParent: number): { n: number; a: number } {
  const c = body.orbit;
  if (c && c.e < 1 && c.a > 0) return { n: Math.sqrt(muParent / (c.a * c.a * c.a)), a: c.a };
  const s = relativeTo(body, parent);
  const r = v3.len(s.r);
  return { n: Math.sqrt(muParent / (r * r * r)), a: r };
}

/** Phase angle of `to` ahead of `from` about their common parent, in `from`'s orbit plane, rad (-pi, pi]. */
export function phaseAngle(from: BodySnapshot, to: BodySnapshot, parent: BodySnapshot): number {
  const a = relativeTo(from, parent);
  const b = relativeTo(to, parent).r;
  const n = v3.normalize(v3.cross(a.r, a.v));
  const bp = v3.reject(b, n);
  return Math.atan2(v3.dot(v3.cross(a.r, bp), n), v3.dot(a.r, bp));
}

/** Hohmann transfer between circular orbits r1 -> r2 about mu: time of flight, the phase the target must lead by, the excess speeds. */
export function hohmann(mu: number, r1: number, r2: number): { tof: number; phase: number; vInfDepart: number; vInfArrive: number } {
  const a = (r1 + r2) / 2;
  const tof = Math.PI * Math.sqrt((a * a * a) / mu);
  const n2 = Math.sqrt(mu / (r2 * r2 * r2));
  return {
    tof,
    phase: Math.PI - n2 * tof,
    // signed: positive = faster than the departure body (an outward transfer)
    vInfDepart: Math.sqrt(mu / r1) * (Math.sqrt(r2 / a) - 1),
    vInfArrive: Math.sqrt(mu / r2) * (1 - Math.sqrt(r1 / a)),
  };
}

/** Synodic period of two circular orbits about mu of radius r1 and r2, s (Infinity for equal radii). */
export function synodic(mu: number, r1: number, r2: number): number {
  const d = Math.abs(Math.sqrt(mu / (r1 * r1 * r1)) - Math.sqrt(mu / (r2 * r2 * r2)));
  return d > 0 ? TWO_PI / d : Infinity;
}

/** Speed change at radius r (circular orbit) to leave on a hyperbola of excess speed vinf. */
export const ejectionDeltaV = (mu: number, r: number, vinf: number): number => Math.sqrt(vinf * vinf + (2 * mu) / r) - Math.sqrt(mu / r);

/**
 * Direction of the ejection burn in a circular parking orbit of normal `h` (unit) for an outgoing asymptote
 * along `asymptote` (projected into the orbit plane): the periapsis of the hyperbola lies the true anomaly of
 * the asymptote, acos(-1/e), behind it, against the direction of motion.
 */
export function ejectionPoint(mu: number, r: number, vinf: number, asymptote: Vec3, h: Vec3): Vec3 {
  const e = 1 + (r * vinf * vinf) / mu;
  const nuInf = Math.acos(-1 / e);
  const a = v3.normalize(v3.reject(asymptote, h));
  // rotate a about h by -nuInf
  const b = v3.cross(h, a);
  return v3.add(v3.scale(a, Math.cos(nuInf)), v3.scale(b, -Math.sin(nuInf)));
}

/** Seconds until a circular orbit (position r, velocity v about mu) reaches the direction `dir` (in its plane). */
export function timeToDirection(mu: number, r: Vec3, v: Vec3, dir: Vec3): number {
  const h = v3.normalize(v3.cross(r, v));
  const rm = v3.len(r);
  const n = Math.sqrt(mu / (rm * rm * rm));
  const d = v3.normalize(v3.reject(dir, h));
  const ang = Math.atan2(v3.dot(v3.cross(r, d), h), v3.dot(r, d));
  return wrap2pi(ang) / n;
}

/**
 * Speed change at periapsis rp of a hyperbola of semi-major axis aHyp (< 0) about mu to stay in the bound ellipse
 * of periapsis rp and apoapsis ra (the capture burn, retrograde).
 */
export function captureDeltaV(mu: number, aHyp: number, rp: number, ra: number): number {
  const vHyp = Math.sqrt(mu * (2 / rp - 1 / aHyp));
  const vEll = Math.sqrt(mu * (2 / rp - 2 / (rp + ra)));
  return vHyp - vEll;
}

/** The same capture from the excess speed vinf of the arrival hyperbola. */
export const captureDeltaVFromExcess = (mu: number, vinf: number, rp: number, ra: number): number =>
  Math.sqrt(vinf * vinf + (2 * mu) / rp) - Math.sqrt(mu * (2 / rp - 2 / (rp + ra)));

// ------------------------------------------------------------------------------------- propagation

/**
 * State on a closed conic at time t (the conic's own frame: its parent's inertial axes): Kepler's equation by
 * Newton's method from the mean anomaly. For a body's orbit in the snapshot this is where the body will be
 * on its osculating orbit, which is what a player's map shows.
 */
export function stateOnConic(c: ConicElements, t: number): { r: Vec3; v: Vec3 } {
  if (c.period === null || !(c.e < 1)) throw new Error('stateOnConic: the conic is not closed');
  const M = wrap2pi((TWO_PI * (t - c.tPeriapsis)) / c.period);
  let E = c.e < 0.8 ? M : Math.PI;
  for (let i = 0; i < 50; i++) {
    const f = E - c.e * Math.sin(E) - M;
    const d = f / (1 - c.e * Math.cos(E));
    E -= d;
    if (Math.abs(d) < 1e-14) break;
  }
  const nu = 2 * Math.atan2(Math.sqrt(1 + c.e) * Math.sin(E / 2), Math.sqrt(1 - c.e) * Math.cos(E / 2));
  return { r: conicPosition(c, nu), v: conicVelocity(c, nu) };
}

/** Position on a conic of either kind at time t: Kepler's equation for an ellipse, the hyperbolic one (e sinh H - H = M) for a hyperbola. */
export function positionOnConic(c: ConicElements, t: number): Vec3 {
  if (c.e < 1 && c.period !== null) return stateOnConic(c, t).r;
  const a = -c.a;
  if (!(c.e > 1) || !(a > 0) || !Number.isFinite(a)) throw new Error('positionOnConic: neither a closed conic nor a hyperbola');
  const M = Math.sqrt(c.mu / (a * a * a)) * (t - c.tPeriapsis);
  let H = Math.asinh(M / c.e);
  for (let i = 0; i < 60; i++) {
    const d = (c.e * Math.sinh(H) - H - M) / (c.e * Math.cosh(H) - 1);
    H -= d;
    if (Math.abs(d) < 1e-13 * Math.max(1, Math.abs(H))) break;
  }
  return conicPosition(c, 2 * Math.atan(Math.sqrt((c.e + 1) / (c.e - 1)) * Math.tanh(H / 2)));
}

/**
 * Closest approach between a conic (a patch about a planet, from t0 to t1) and a moon of that planet on its
 * osculating orbit: the least distance over 256 samples, refined by golden-section search in the samples on
 * either side. What a player reads off the map when the moon is not the target yet.
 */
export function closestToMoon(c: ConicElements, t0: number, t1: number, moon: BodySnapshot, planet: BodySnapshot): { ut: number; distance: number } {
  const dist = (t: number): number => v3.len(v3.sub(positionOnConic(c, t), bodyStateAt(moon, planet, t).r));
  const n = 256;
  let bi = 0;
  let bd = Infinity;
  for (let i = 0; i <= n; i++) {
    const d = dist(t0 + ((t1 - t0) * i) / n);
    if (d < bd) {
      bd = d;
      bi = i;
    }
  }
  let a = t0 + ((t1 - t0) * Math.max(0, bi - 1)) / n;
  let b = t0 + ((t1 - t0) * Math.min(n, bi + 1)) / n;
  const g = (Math.sqrt(5) - 1) / 2;
  let x1 = b - g * (b - a);
  let x2 = a + g * (b - a);
  let f1 = dist(x1);
  let f2 = dist(x2);
  for (let i = 0; i < 60 && b - a > 0.5; i++) {
    if (f1 < f2) {
      b = x2;
      x2 = x1;
      f2 = f1;
      x1 = b - g * (b - a);
      f1 = dist(x1);
    } else {
      a = x1;
      x1 = x2;
      f1 = f2;
      x2 = a + g * (b - a);
      f2 = dist(x2);
    }
  }
  const t = f1 < f2 ? x1 : x2;
  const d = Math.min(f1, f2);
  return d < bd ? { ut: t, distance: d } : { ut: t0 + ((t1 - t0) * bi) / n, distance: bd };
}

/** Where a body will be relative to its parent at time t: on its osculating conic, else (no closed conic) where it is now. */
export function bodyStateAt(body: BodySnapshot, parent: BodySnapshot, t: number): { r: Vec3; v: Vec3 } {
  const c = body.orbit;
  if (c && c.period !== null && c.e < 1) return stateOnConic(c, t);
  return relativeTo(body, parent);
}

// ----------------------------------------------------------------------------------------- Lambert

function stumpff(z: number): { c2: number; c3: number } {
  // 1 - cos s = 2 sin^2(s/2) and cosh s - 1 = 2 sinh^2(s/2): no cancellation near s = 2 pi (the upper bracket)
  if (z > 1e-6) {
    const s = Math.sqrt(z);
    const h = Math.sin(s / 2);
    return { c2: (2 * h * h) / z, c3: (s - Math.sin(s)) / (s * s * s) };
  }
  if (z < -1e-6) {
    const s = Math.sqrt(-z);
    const h = Math.sinh(s / 2);
    return { c2: (2 * h * h) / -z, c3: (Math.sinh(s) - s) / (s * s * s) };
  }
  return { c2: 0.5 - z / 24 + (z * z) / 720, c3: 1 / 6 - z / 120 + (z * z) / 5040 };
}

/**
 * Lambert's problem by universal variables (Bate, Mueller and White 5.3): the conic about mu from r1 to r2 in
 * time tof, zero revolutions, prograde about `refNormal`. Null where the plane is undefined (transfer angle
 * within 1e-8 rad of 0 or pi) or no solution exists.
 */
export function lambert(mu: number, r1: Vec3, r2: Vec3, tof: number, refNormal: Vec3): { v1: Vec3; v2: Vec3 } | null {
  const r1n = v3.len(r1);
  const r2n = v3.len(r2);
  if (!(mu > 0) || !(tof > 0) || !(r1n > 0) || !(r2n > 0)) return null;
  const cosd = Math.max(-1, Math.min(1, v3.dot(r1, r2) / (r1n * r2n)));
  let dnu = Math.acos(cosd);
  if (v3.dot(v3.cross(r1, r2), refNormal) < 0) dnu = TWO_PI - dnu;
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
  let hi = TWO_PI * TWO_PI * (1 - 1e-9);
  let lo = -4 * Math.PI * Math.PI;
  if (A > 0 && yOf(lo) < 0) {
    let a = lo;
    let b = hi;
    for (let i = 0; i < 200 && b - a > 1e-12; i++) {
      const m = 0.5 * (a + b);
      if (yOf(m) < 0) a = m;
      else b = m;
    }
    lo = b;
  }
  for (let k = 0; F(lo) > 0 && k < 60; k++) lo -= 4 * Math.PI * Math.PI * 2 ** k;
  if (!(F(lo) <= 0) || !(F(hi) >= 0)) return null;
  for (let i = 0; i < 200; i++) {
    const m = 0.5 * (lo + hi);
    if (F(m) < 0) lo = m;
    else hi = m;
    if (hi - lo <= 1e-13 * Math.max(1, Math.abs(m))) break;
  }
  const z = 0.5 * (lo + hi);
  const y = yOf(z);
  if (!(y > 0)) return null;
  const f = 1 - y / r1n;
  const g = A * Math.sqrt(y / mu);
  const gdot = 1 - y / r2n;
  const v1 = v3.scale(v3.sub(r2, v3.scale(r1, f)), 1 / g);
  const v2 = v3.scale(v3.sub(v3.scale(r2, gdot), r1), 1 / g);
  return v3.isFinite(v1) && v3.isFinite(v2) ? { v1, v2 } : null;
}

// ------------------------------------------------------------------------------------------ ejection

/** A burn on a circular parking orbit: seconds from the orbit's present state, and the delta-v in the node frame. */
export interface EjectionBurn {
  dt: number;
  prograde: number;
  normal: number;
  radial: number;
  /** The burn's size, m/s. */
  deltaV: number;
  /** Plane change from the parking orbit to the departure hyperbola, rad. */
  planeChange: number;
}

/**
 * The impulsive burn on a circular parking orbit (state r, v about mu, now) that leaves on a hyperbola whose
 * outgoing asymptote is the excess velocity `vinf` (a vector): the burn point is a periapsis of the hyperbola,
 * so it lies at the asymptote's true anomaly acos(-1/e) before the asymptote - on the parking orbit that is
 * where the cone of those directions about the asymptote meets the orbit plane, at two points per revolution
 * when the asymptote is within acos(1/e) of the plane. Of those, the one with the smaller delta-v, at the
 * revolution whose burn falls nearest `nearDt` seconds from now. Null when the asymptote is too far out of the
 * plane (no periapsis on the orbit reaches it).
 */
export function ejectionBurn(mu: number, r: Vec3, v: Vec3, vinf: Vec3, nearDt: number): EjectionBurn | null {
  const rm = v3.len(r);
  const vinfM = v3.len(vinf);
  if (!(vinfM > 0)) return null;
  const P = v3.normalize(r);
  const W = v3.normalize(v3.cross(r, v));
  const Q = v3.cross(W, P);
  const s = v3.scale(vinf, 1 / vinfM);
  const e = 1 + (rm * vinfM * vinfM) / mu;
  const sp = v3.dot(s, P);
  const sq = v3.dot(s, Q);
  const rho = Math.hypot(sp, sq);
  const c = -1 / (e * rho);
  if (!(rho > 0) || Math.abs(c) > 1) return null;
  const phi0 = Math.atan2(sq, sp);
  const n = Math.sqrt(mu / (rm * rm * rm));
  const period = TWO_PI / n;
  const vc = Math.sqrt(mu / rm);
  const vp = Math.sqrt(vinfM * vinfM + (2 * mu) / rm);
  let best: EjectionBurn | null = null;
  let bestDv = Infinity;
  for (const sign of [1, -1]) {
    const phi = phi0 + sign * Math.acos(c);
    const u = v3.add(v3.scale(P, Math.cos(phi)), v3.scale(Q, Math.sin(phi)));
    const h = v3.normalize(v3.cross(u, s));
    const vDir = v3.cross(h, u);
    const along = v3.cross(W, u);
    const dvVec = v3.sub(v3.scale(vDir, vp), v3.scale(along, vc));
    const dv = v3.len(dvVec);
    // revolution nearest nearDt
    const base = wrap2pi(phi) / n;
    const k = Math.round((nearDt - base) / period);
    const dt = base + Math.max(0, k) * period;
    if (dv < bestDv) {
      bestDv = dv;
      best = { dt, prograde: v3.dot(dvVec, along), normal: v3.dot(dvVec, W), radial: v3.dot(dvVec, u), deltaV: dv, planeChange: Math.acos(Math.max(-1, Math.min(1, v3.dot(h, W)))) };
    }
  }
  return best;
}

/** The state just after an impulsive burn on a circular parking orbit (state r, v about mu at nowUt), `burn.dt` later. */
export function stateAfterBurn(mu: number, r: Vec3, v: Vec3, nowUt: number, burn: EjectionBurn): { ut: number; r: Vec3; v: Vec3 } {
  const ut = nowUt + burn.dt;
  const at = stateOnConic(conicFromState(mu, r, v, nowUt), ut);
  const pro = v3.normalize(at.v);
  const nrm = v3.normalize(v3.cross(at.r, at.v));
  const rad = v3.cross(pro, nrm);
  return { ut, r: at.r, v: v3.add(at.v, v3.add(v3.scale(pro, burn.prograde), v3.add(v3.scale(nrm, burn.normal), v3.scale(rad, burn.radial)))) };
}

/** A departure aimed through the origin's sphere: the burn, the excess velocity it was built for, where and when it leaves the sphere. */
export interface DepartureAim {
  burn: EjectionBurn;
  vInf: Vec3;
  exitUt: number;
  /** Parent-frame state at the sphere's edge. */
  exit: { r: Vec3; v: Vec3 };
  /** Last correction of the excess velocity, m/s (how well the iteration closed). */
  residual: number;
}

/**
 * The departure burn whose trajectory, as patched conics hand it over at the origin's sphere of influence
 * (radius `soi`: the craft leaves it at the speed sqrt(vinf^2 + 2 mu / soi), from a point a sphere's radius
 * out), continues on the Lambert arc to `target` (parent frame) at `arriveUt`. The excess velocity is iterated
 * from `vInf0` (the arc between the bodies' centres): eject, follow the hyperbola to the sphere, solve Lambert
 * from there, and correct by the difference of the velocities; a few passes close it to millimetres per second.
 * Without that, a departure aimed by the arc between the centres leaves about 130 m/s fast for Mars and misses by
 * gigametres after 280 days. Null when an ejection or a Lambert arc fails on the way.
 */
export function aimDeparture(
  mu: number,
  r: Vec3,
  v: Vec3,
  nowUt: number,
  soi: number,
  origin: BodySnapshot,
  parent: BodySnapshot,
  muParent: number,
  target: Vec3,
  arriveUt: number,
  vInf0: Vec3,
  nearDt: number,
): DepartureAim | null {
  let vInf = vInf0;
  let out: DepartureAim | null = null;
  for (let k = 0; k < 12; k++) {
    const burn = ejectionBurn(mu, r, v, vInf, nearDt);
    if (!burn) return out;
    const s = stateAfterBurn(mu, r, v, nowUt, burn);
    const hyp = conicFromState(mu, s.r, s.v, s.ut);
    const nu = conicRadiusCrossing(hyp, soi);
    if (nu === null) return out;
    const exitUt = hyp.tPeriapsis + timeSincePeriapsis(hyp, nu);
    if (!Number.isFinite(exitUt) || !(arriveUt > exitUt)) return out;
    const o = bodyStateAt(origin, parent, exitUt);
    const R = v3.add(o.r, conicPosition(hyp, nu));
    const V = v3.add(o.v, conicVelocity(hyp, nu));
    const sol = lambert(muParent, R, target, arriveUt - exitUt, v3.normalize(v3.cross(o.r, o.v)));
    if (!sol) return out;
    const d = v3.sub(sol.v1, V);
    out = { burn, vInf, exitUt, exit: { r: R, v: V }, residual: v3.len(d) };
    if (out.residual < 1e-3) break;
    vInf = v3.add(vInf, d);
  }
  return out;
}

// ------------------------------------------------------------------------------------- the window

export interface WindowArc {
  /** Departure from the origin's centre and arrival at the planet's centre (UT, s), time of flight. */
  departUt: number;
  arriveUt: number;
  tof: number;
  /** Excess velocities at departure and at arrival (parent axes), m/s. */
  vInfDepart: Vec3;
  vInfArrive: Vec3;
  /** Departure burn from the parking orbit plus capture at the planet (the search's cost), m/s. */
  cost: number;
}

export interface WindowSearch {
  /** The origin, the planet and their common parent in the snapshot, and the parent's mu. */
  origin: BodySnapshot;
  planet: BodySnapshot;
  parent: BodySnapshot;
  muParent: number;
  /** Departure cost from a parking orbit about the origin (from the excess velocity), and arrival cost at the planet (from the excess speed). */
  departCost: (vinf: Vec3) => number;
  arriveCost: (vinf: number) => number;
  /** Departures searched in [fromUt, toUt]; times of flight as multiples of the Hohmann time. */
  fromUt: number;
  toUt: number;
  tofRange?: [number, number];
}

/** The arc departing at `departUt` with time of flight `tof` between the bodies' osculating conics; null when Lambert has none. */
export function windowArc(w: WindowSearch, departUt: number, tof: number): WindowArc | null {
  const o = bodyStateAt(w.origin, w.parent, departUt);
  const p = bodyStateAt(w.planet, w.parent, departUt + tof);
  const sol = lambert(w.muParent, o.r, p.r, tof, v3.normalize(v3.cross(o.r, o.v)));
  if (!sol) return null;
  const vInfDepart = v3.sub(sol.v1, o.v);
  const vInfArrive = v3.sub(sol.v2, p.v);
  return { departUt, arriveUt: departUt + tof, tof, vInfDepart, vInfArrive, cost: w.departCost(vInfDepart) + w.arriveCost(v3.len(vInfArrive)) };
}

/**
 * The cheapest arc of a porkchop over departures in [fromUt, toUt] and times of flight in tofRange (x the Hohmann
 * time between the mean orbits), refined by halving the grid about the best cell. Null when no arc of finite cost exists.
 */
export function bestWindow(w: WindowSearch): WindowArc | null {
  const r1 = meanOrbit(w.origin, w.parent, w.muParent).a;
  const r2 = meanOrbit(w.planet, w.parent, w.muParent).a;
  const th = hohmann(w.muParent, r1, r2).tof;
  const [k0, k1] = w.tofRange ?? [0.6, 1.5];
  const nd = 60;
  const nt = 30;
  let best: WindowArc | null = null;
  for (let i = 0; i <= nd; i++) {
    const td = w.fromUt + ((w.toUt - w.fromUt) * i) / nd;
    for (let j = 0; j <= nt; j++) {
      const arc = windowArc(w, td, th * (k0 + ((k1 - k0) * j) / nt));
      if (arc && Number.isFinite(arc.cost) && (!best || arc.cost < best.cost)) best = arc;
    }
  }
  if (!best) return null;
  let dd = (w.toUt - w.fromUt) / nd;
  let dt = (th * (k1 - k0)) / nt;
  for (let pass = 0; pass < 32; pass++) {
    const c: WindowArc = best;
    for (const [a, b] of [
      [-1, 0],
      [1, 0],
      [0, -1],
      [0, 1],
      [-1, -1],
      [1, 1],
      [-1, 1],
      [1, -1],
    ] as const) {
      const td = Math.min(w.toUt, Math.max(w.fromUt, c.departUt + a * dd));
      const tof = Math.min(th * k1, Math.max(th * k0, c.tof + b * dt));
      const arc = windowArc(w, td, tof);
      if (arc && arc.cost < best.cost) best = arc;
    }
    if (best === c) {
      dd /= 2;
      dt /= 2;
    }
  }
  return best;
}
