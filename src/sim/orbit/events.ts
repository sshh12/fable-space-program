/**
 * Events on a conic (docs/research/sim-design.md 3.3): analytic radius crossings (SOI exit, atmosphere
 * entry, altitude shells), terrain impact (max-elevation shell entry, then a march against a caller-supplied
 * coarse height function), child-SOI entry (guaranteed-safe sampling + Brent + grazing-minimum check) and
 * closest approach to a body.
 */
import { conicRadiusCrossing } from '../../core/math/conic';
import { quat } from '../../core/math/quat';
import { v3, type Vec3 } from '../../core/math/vec3';
import type { BodySystem } from '../bodies/bodySystem';
import { timeFromPeriapsis } from './anomaly';
import { propagateInto, type Orbit } from './kepler';
import { bisectToNonPositive, brentRoot, goldenMin } from './roots';

/**
 * Coarse solid-surface height (m above the reference radius) under a body-fixed unit direction. Supplied by
 * the caller from an always-resident, band-limited terrain level so prediction never waits for streaming.
 */
export type CoarseHeightFn = (bodyId: string, dirFixed: Vec3) => number;

/** Time accuracy of event roots, s. */
export const EVENT_TIME_TOLERANCE = 1e-3;
/** Bisection accuracy of the terrain impact time, s. */
export const IMPACT_TIME_TOLERANCE = 0.01;
/** Ground-track distance between terrain samples, m. */
export const TERRAIN_MARCH_STEP = 2000;
/** Smallest step of the SOI-entry sampler, s. */
export const SOI_MIN_STEP = 30;

/**
 * First time strictly after `tAfter` at which the orbit has true anomaly `nu` ((-pi, pi]); for open
 * orbits the single passage if it is after `tAfter`, else null.
 */
export function timeOfTrueAnomaly(o: Orbit, nu: number, tAfter: number): number | null {
  const c = o.conic;
  const tsp = timeFromPeriapsis(c.e, c.p, o.mu, nu);
  if (!Number.isFinite(tsp)) return null;
  let t = c.tPeriapsis + tsp;
  if (o.period !== null) {
    const P = o.period;
    t += P * (Math.floor((tAfter - t) / P) + 1);
    if (t <= tAfter) t += P;
    return t;
  }
  return t > tAfter ? t : null;
}

/** True anomaly ((-pi, pi]) of the orbit at time t (propagated from the epoch). */
export function trueAnomalyAt(o: Orbit, t: number): number {
  propagateInto(o, t, R_, V_);
  return Math.atan2(v3.dot(R_, o.conic.Q), v3.dot(R_, o.conic.P));
}

/**
 * True anomaly magnitude (in [0, pi]) at which the orbit's conic has radius R, or null if it never does
 * (core conicRadiusCrossing; near-radial orbits use universalEventTime instead).
 */
export const radiusCrossingAnomaly = (o: Orbit, R: number): number | null => conicRadiusCrossing(o.conic, R);

/**
 * First time strictly after `tAfter` at which |r| crosses R outbound (direction +1) or inbound (-1).
 * Null when the conic never reaches R (or, for open orbits, the crossing is already past).
 */
export function nextRadiusCrossing(o: Orbit, R: number, direction: 1 | -1, tAfter: number): number | null {
  if (o.nearRadial) return universalEventTime(o, { radius: R, direction }, tAfter);
  const nu = radiusCrossingAnomaly(o, R);
  if (nu === null) return null;
  return timeOfTrueAnomaly(o, direction * nu, tAfter);
}

/**
 * First periapsis (or, for closed orbits, apoapsis) passage strictly after `tAfter`; null when there is
 * none (apoapsis of an open orbit, periapsis of an open orbit already passed).
 */
export function nextApsisTime(o: Orbit, kind: 'periapsis' | 'apoapsis', tAfter: number): number | null {
  if (kind === 'apoapsis' && o.period === null) return null;
  if (o.nearRadial) return universalEventTime(o, kind, tAfter);
  return timeOfTrueAnomaly(o, kind === 'periapsis' ? 0 : Math.PI, tAfter);
}

/**
 * Event times from the universal anomaly relative to the epoch, without the conic's anomalies (which
 * degenerate for radial trajectories). With s = chi sqrt|alpha|:
 *   ellipse:   r = a + (r0 - a) cos s + sigma0 sqrt(a) sin s = a + A cos(s - phi),
 *              sqrt(mu) dt = a^1.5 (s - (1 - r0/a) sin s) + sigma0 a (1 - cos s)
 *   hyperbola: r = -|a| + (r0 + |a|) cosh s + sigma0 sqrt|a| sinh s = -|a| + Q cosh(s + delta),
 *              sqrt(mu) dt = |a|^1.5 ((1 + r0/|a|) sinh s - s) + sigma0 |a| (cosh s - 1)
 *   parabola:  r = r0 + sigma0 chi + chi^2/2,  sqrt(mu) dt = sigma0 chi^2/2 + chi^3/6 + r0 chi
 */
function universalEventTime(o: Orbit, ev: { radius: number; direction: 1 | -1 } | 'periapsis' | 'apoapsis', tAfter: number): number | null {
  const r0 = o.r0m;
  const s0 = o.sigma0;
  const ar = o.alpha * r0;
  if (ar > 1e-9) {
    const a = 1 / o.alpha;
    const sa = Math.sqrt(a);
    const C = r0 - a;
    const S = s0 * sa;
    const A = Math.hypot(C, S);
    const phi = Math.atan2(S, C);
    let s: number;
    if (ev === 'apoapsis') s = phi;
    else if (ev === 'periapsis') s = phi + Math.PI;
    else {
      if (!(A > 0)) return null;
      const c = (ev.radius - a) / A;
      if (c < -1 || c > 1) return null;
      const d = Math.acos(c);
      s = ev.direction < 0 ? phi + d : phi - d;
    }
    let t = o.t0 + (a * sa * (s - (1 - r0 / a) * Math.sin(s)) + s0 * a * (1 - Math.cos(s))) / o.sqrtMu;
    const P = o.period!;
    t += P * (Math.floor((tAfter - t) / P) + 1);
    if (t <= tAfter) t += P;
    return t;
  }
  let t: number;
  if (ar < -1e-9) {
    const aa = -1 / o.alpha;
    const sa = Math.sqrt(aa);
    const C = r0 + aa;
    const S = s0 * sa;
    const Q = Math.sqrt(Math.max(0, C * C - S * S));
    const dh = Math.atanh(Math.max(-1 + 1e-16, Math.min(1 - 1e-16, S / C)));
    let s: number;
    if (ev === 'periapsis') s = -dh;
    else if (ev === 'apoapsis') return null;
    else {
      const K = ev.radius + aa;
      if (K < Q) return null;
      const g = Math.acosh(K / Q);
      s = ev.direction < 0 ? -dh - g : -dh + g;
    }
    t = o.t0 + (aa * sa * ((1 + r0 / aa) * Math.sinh(s) - s) + s0 * aa * (Math.cosh(s) - 1)) / o.sqrtMu;
  } else {
    let chi: number;
    if (ev === 'periapsis') chi = -s0;
    else if (ev === 'apoapsis') return null;
    else {
      const disc = s0 * s0 - 2 * (r0 - ev.radius);
      if (disc < 0) return null;
      chi = ev.direction < 0 ? -s0 - Math.sqrt(disc) : -s0 + Math.sqrt(disc);
    }
    t = o.t0 + ((s0 * chi * chi) / 2 + (chi * chi * chi) / 6 + r0 * chi) / o.sqrtMu;
  }
  return t > tAfter ? t : null;
}

const R_ = { x: 0, y: 0, z: 0 };
const V_ = { x: 0, y: 0, z: 0 };

/** Radius and radial rate at time t. */
function radialState(o: Orbit, t: number): { r: number; rdot: number } {
  propagateInto(o, t, R_, V_);
  const r = Math.hypot(R_.x, R_.y, R_.z);
  return { r, rdot: (R_.x * V_.x + R_.y * V_.y + R_.z * V_.z) / r };
}

/**
 * SOI exit time searched from `tFrom`: tFrom itself when the vessel is already at or beyond `soiRadius`
 * and moving outward, else the next outbound crossing of `soiRadius` (null when it never leaves).
 */
export function soiExitTime(o: Orbit, soiRadius: number, tFrom: number): number | null {
  const s = radialState(o, tFrom);
  if (s.r >= soiRadius && s.rdot > 0) return tFrom;
  return nextRadiusCrossing(o, soiRadius, 1, tFrom);
}

/**
 * Atmosphere-entry time (inbound crossing of radius + simTop) strictly after `tFrom`, or null. A vessel
 * already inside and descending has no entry on this pass (its impact is found instead).
 */
export function atmosphereEntryTime(system: BodySystem, o: Orbit, tFrom: number): number | null {
  const body = system.body(o.bodyId);
  const atm = body.def.atmosphere;
  if (!atm) return null;
  const R = body.radius + atm.simTop;
  if (o.conic.p / (1 + o.conic.e) >= R) return null;
  return nextRadiusCrossing(o, R, -1, tFrom);
}

export interface ImpactEvent {
  t: number;
  /** State at impact, BCI of the orbit body. */
  r: Vec3;
  v: Vec3;
  /** Surface height at the impact point above the reference radius, m. */
  height: number;
}

/**
 * Terrain impact in [tFrom, tTo]. With a height function: entry of the max-elevation shell (analytic, or
 * tFrom when already inside), then a march with ground step <= TERRAIN_MARCH_STEP comparing |r| with
 * radius + h(body-fixed direction at the sample time, body rotation included), first sign change bisected
 * to IMPACT_TIME_TOLERANCE; repeated for every shell pass inside the window. Heights are clamped to the
 * body's [minElevation, maxElevation] and raised to sea level where the body has an ocean (water is a
 * surface). Without a height function (or terrain definition) the surface is the reference sphere (or the
 * sea surface) and the impact is its analytic inbound crossing.
 */
export function findImpact(system: BodySystem, o: Orbit, tFrom: number, tTo: number, heightFn: CoarseHeightFn | null): ImpactEvent | null {
  if (!(tTo > tFrom)) return null;
  const body = system.body(o.bodyId);
  const def = body.def;
  const R = body.radius;
  const sea = def.ocean ? def.ocean.seaLevel : -Infinity;
  const rp = o.conic.p / (1 + o.conic.e);
  const finish = (t: number, height: number): ImpactEvent => {
    const r = { x: 0, y: 0, z: 0 };
    const v = { x: 0, y: 0, z: 0 };
    propagateInto(o, t, r, v);
    return { t, r, v, height };
  };
  if (!heightFn || !def.terrain) {
    const h = Math.max(0, sea);
    if (rp >= R + h) return null;
    const s = radialState(o, tFrom);
    if (s.r <= R + h) return finish(tFrom, h);
    const t = nextRadiusCrossing(o, R + h, -1, tFrom);
    return t !== null && t <= tTo ? finish(t, h) : null;
  }
  const { minElevation, maxElevation } = def.terrain;
  const top = Math.max(maxElevation, sea);
  const shell = R + top;
  if (rp >= shell) return null;
  const q0 = system.orientation(o.bodyId, tFrom);
  const rot = body.rotation;
  const surfaceH = (dirFixed: Vec3): number => {
    let h = heightFn(o.bodyId, dirFixed);
    h = h < minElevation ? minElevation : h > maxElevation ? maxElevation : h;
    return h < sea ? sea : h;
  };
  let lastH = 0;
  let lastSpeed = 0;
  const g = (t: number): number => {
    propagateInto(o, t, R_, V_);
    const q = rot.kind === 'none' ? q0 : system.orientation(o.bodyId, t);
    const rm = Math.hypot(R_.x, R_.y, R_.z);
    const d = quat.rotateInv(q, R_);
    lastH = surfaceH({ x: d.x / rm, y: d.y / rm, z: d.z / rm });
    lastSpeed = Math.hypot(V_.x, V_.y, V_.z);
    return rm - (R + lastH);
  };
  let tPass: number | null = radialState(o, tFrom).r < shell ? tFrom : nextRadiusCrossing(o, shell, -1, tFrom);
  while (tPass !== null && tPass < tTo) {
    const tOut = nextRadiusCrossing(o, shell, 1, tPass);
    const tEnd = tOut === null ? tTo : Math.min(tOut, tTo);
    let ta = tPass;
    let ga = g(ta);
    if (ga <= 0) return finish(ta, lastH);
    while (ta < tEnd) {
      const dt = Math.max(TERRAIN_MARCH_STEP / Math.max(lastSpeed, 1), IMPACT_TIME_TOLERANCE);
      const tb = Math.min(ta + dt, tEnd);
      const gb = g(tb);
      if (gb <= 0) {
        const t = bisectToNonPositive(g, ta, tb, IMPACT_TIME_TOLERANCE);
        g(t);
        return finish(t, lastH);
      }
      ta = tb;
      ga = gb;
    }
    if (o.period === null || tOut === null) break;
    tPass = nextRadiusCrossing(o, shell, -1, tOut);
  }
  return null;
}

const RV_ = { x: 0, y: 0, z: 0 };
const VV_ = { x: 0, y: 0, z: 0 };

/** Speed at periapsis of a conic with gravitational parameter mu (the speed bound on the whole conic). */
const periapsisSpeed = (mu: number, p: number, e: number): number => Math.sqrt(mu / p) * (1 + e);

/**
 * First entry into the SOI of `childId` (which orbits the orbit's body) in [tFrom, tTo], or null.
 *
 * d(t) = |r_vessel(t) - r_child(t)| - R_soi. Because |d'| <= V = (vessel periapsis speed) + (child
 * periapsis speed), a step h <= d/V cannot jump over a root; the sampler steps by max(d/V, SOI_MIN_STEP),
 * so far from the SOI it takes long steps and no encounter can be missed there. Inside the minimum-step band
 * a sampled local minimum (a grazing pass that dips in and out between samples) is refined by golden-section
 * search and, if negative, its first root is found. Roots are refined by Brent to EVENT_TIME_TOLERANCE.
 * A vessel that starts inside the SOI and is moving out is followed until it is outside; one that starts
 * inside and moving in returns tFrom.
 */
export function findSoiEntry(system: BodySystem, o: Orbit, childId: string, tFrom: number, tTo: number): number | null {
  if (!(tTo > tFrom)) return null;
  const child = system.body(childId);
  const kep = child.kepler;
  const Rsoi = child.soiRadius;
  if (!kep || Rsoi === null || child.parentId !== o.bodyId) return null;
  const c = o.conic;
  const rpV = c.p / (1 + c.e);
  // 2a - rp: exact for every bound orbit, including near-radial ones where p/(1 - e) has lost its digits.
  const raV = o.period !== null ? 2 / o.alpha - rpV : Infinity;
  const rpC = kep.a * (1 - kep.e);
  const raC = kep.a * (1 + kep.e);
  if (rpV > raC + Rsoi || raV < rpC - Rsoi) return null;
  const V = periapsisSpeed(o.mu, c.p, c.e) + periapsisSpeed(kep.mu, kep.a * (1 - kep.e * kep.e), kep.e);
  const D = (t: number): number => {
    propagateInto(o, t, RV_, VV_);
    const s = kep.stateAt(t);
    return Math.hypot(RV_.x - s.r.x, RV_.y - s.r.y, RV_.z - s.r.z) - Rsoi;
  };
  const span = tTo - tFrom;
  const hMin = Math.min(SOI_MIN_STEP, span / 16);
  let t = tFrom;
  let d = D(t);
  if (d <= 0) {
    const s = kep.stateAt(t);
    const rel = v3.sub(RV_, s.r);
    const vel = v3.sub(VV_, s.v);
    if (v3.dot(rel, vel) < 0) return tFrom;
    while (d <= 0 && t < tTo) {
      t = Math.min(t + hMin, tTo);
      d = D(t);
    }
    if (d <= 0) return null;
  }
  let tPrev = NaN;
  let dPrev = Infinity;
  let safePrev = true;
  while (t < tTo) {
    const safeH = d / V;
    const safe = safeH >= hMin;
    const tn = Math.min(t + (safe ? safeH : hMin), tTo);
    const dn = D(tn);
    if (dn <= 0) return brentRoot(D, t, tn, EVENT_TIME_TOLERANCE, d, dn);
    if (d < dPrev && d <= dn && !(safe && safePrev) && Number.isFinite(tPrev)) {
      const m = goldenMin(D, tPrev, tn, EVENT_TIME_TOLERANCE);
      if (m.fx <= 0) return brentRoot(D, tPrev, m.x, EVENT_TIME_TOLERANCE, dPrev, m.fx);
    }
    tPrev = t;
    dPrev = d;
    safePrev = safe;
    t = tn;
    d = dn;
  }
  return null;
}

export interface ClosestApproach {
  t: number;
  distance: number;
  /** Vessel position at t, BCI of the orbit body. */
  r: Vec3;
}

/**
 * Local minima of the distance to body `targetId` (which must orbit the orbit's body) over
 * [tFrom, min(tTo, tFrom + one period)], sampled at `samples` points and refined by golden section to 1 s;
 * the first `maxCount` in time order.
 */
export function closestApproaches(system: BodySystem, o: Orbit, targetId: string, tFrom: number, tTo: number, samples = 64, maxCount = 2): ClosestApproach[] {
  const target = system.body(targetId);
  if (target.parentId !== o.bodyId || !(tTo > tFrom)) return [];
  const t1 = o.period !== null ? Math.min(tTo, tFrom + o.period) : tTo;
  const D = (t: number): number => {
    propagateInto(o, t, RV_, VV_);
    const s = system.stateRelParent(targetId, t);
    return Math.hypot(RV_.x - s.r.x, RV_.y - s.r.y, RV_.z - s.r.z);
  };
  const n = Math.max(8, samples);
  const ts: number[] = [];
  const ds: number[] = [];
  for (let i = 0; i <= n; i++) {
    const t = tFrom + ((t1 - tFrom) * i) / n;
    ts.push(t);
    ds.push(D(t));
  }
  const out: ClosestApproach[] = [];
  for (let i = 1; i < n && out.length < maxCount; i++) {
    if (ds[i]! < ds[i - 1]! && ds[i]! <= ds[i + 1]!) {
      const m = goldenMin(D, ts[i - 1]!, ts[i + 1]!, 1);
      const r = { x: 0, y: 0, z: 0 };
      propagateInto(o, m.x, r, VV_);
      out.push({ t: m.x, distance: m.fx, r });
    }
  }
  return out;
}
