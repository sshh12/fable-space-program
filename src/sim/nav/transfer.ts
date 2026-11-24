/**
 * Transfer planning between bodies that orbit one parent (ARCHITECTURE 8.4, 21; the planning service and the
 * transfer pilot): Hohmann numbers, the phase angle, the departure and capture burns of the patched-conic
 * method, and the search for transfer windows by Lambert arcs between the bodies' real ephemerides.
 *
 * All pure functions of the body system and of times; SI units, radians. "Parent" is the common parent of
 * the two bodies (the star for two planets, a planet for two of its moons).
 */
import { v3, type Vec3 } from '../../core/math/vec3';
import type { BodySystem } from '../bodies/bodySystem';
import { solveLambert } from '../orbit/lambert';
import { goldenMin } from '../orbit/roots';

const TWO_PI = 2 * Math.PI;

/** Time of flight of a Hohmann transfer between circular orbits of radius r1 and r2 about mu, s. */
export function hohmannTransferTime(mu: number, r1: number, r2: number): number {
  const a = (r1 + r2) / 2;
  return Math.PI * Math.sqrt((a * a * a) / mu);
}

/**
 * Phase angle (rad) the target must lead the departure body by at departure for a Hohmann transfer between
 * circular orbits r1 -> r2: pi - n2 T (negative = the target trails, an inward transfer).
 */
export function hohmannPhaseAngle(mu: number, r1: number, r2: number): number {
  const n2 = Math.sqrt(mu / (r2 * r2 * r2));
  return Math.PI - n2 * hohmannTransferTime(mu, r1, r2);
}

/** Synodic period of two circular orbits of radius r1 and r2 about mu, s (Infinity for equal radii). */
export function synodicPeriod(mu: number, r1: number, r2: number): number {
  const n1 = Math.sqrt(mu / (r1 * r1 * r1));
  const n2 = Math.sqrt(mu / (r2 * r2 * r2));
  return TWO_PI / Math.abs(n1 - n2);
}

/** Speed change at radius r about mu to leave on a hyperbola with excess speed vinf from a circular orbit (Oberth). */
export function departureDeltaV(mu: number, r: number, vinf: number): number {
  return Math.sqrt(vinf * vinf + (2 * mu) / r) - Math.sqrt(mu / r);
}

/**
 * Speed change at periapsis rp to turn an arrival hyperbola of excess speed vinf into the bound ellipse of
 * periapsis rp and apoapsis ra (ra = rp: a circular orbit).
 */
export function captureDeltaV(mu: number, rp: number, ra: number, vinf: number): number {
  const vHyp = Math.sqrt(vinf * vinf + (2 * mu) / rp);
  const vEll = Math.sqrt(mu * (2 / rp - 2 / (rp + ra)));
  return vHyp - vEll;
}

/** The common parent of two bodies (they must orbit the same body). */
function commonParent(system: BodySystem, fromId: string, toId: string): string {
  const pf = system.body(fromId).parentId;
  const pt = system.body(toId).parentId;
  if (pf === null || pf !== pt) throw new Error(`transfer: ${fromId} and ${toId} do not orbit the same body`);
  return pf;
}

/**
 * Phase angle of `toId` ahead of `fromId` about their common parent at `ut`, rad in (-pi, pi]: the angle from
 * the departure body's position to the target's projected into the departure body's orbit plane, positive in
 * the direction of the departure body's motion.
 */
export function phaseAngle(system: BodySystem, fromId: string, toId: string, ut: number): number {
  const parent = commonParent(system, fromId, toId);
  const a = system.stateRelative(fromId, parent, ut);
  const b = system.stateRelative(toId, parent, ut).r;
  const n = v3.normalize(v3.cross(a.r, a.v));
  const bp = v3.reject(b, n);
  return Math.atan2(v3.dot(v3.cross(a.r, bp), n), v3.dot(a.r, bp));
}

export interface TransferArc {
  /** Departure and arrival instants (s) and the time of flight. */
  departUt: number;
  arriveUt: number;
  tof: number;
  /** Hyperbolic excess velocities about the departure and the arrival body (parent axes), m/s. */
  vInfDepart: Vec3;
  vInfArrive: Vec3;
  /** The phase angle of the target at departure, rad. */
  phaseAngle: number;
  /** The search's cost of the arc (default |vInfDepart| + |vInfArrive|). */
  cost: number;
}

export interface TransferSearchOptions {
  /** Time of flight range as multiples of the Hohmann time between the mean orbit radii (default [0.6, 1.5]). */
  tofRange?: [number, number];
  /** Cost of an arc from its excess velocities (default the sum of their magnitudes). */
  cost?: (vInfDepart: Vec3, vInfArrive: Vec3) => number;
  /** Grid of the coarse search: departure samples per searched span and time-of-flight samples (default 48, 24). */
  departureSamples?: number;
  tofSamples?: number;
}

/** The Lambert arc departing at `departUt` and arriving after `tof`, with its excess velocities; null when none. */
export function transferArc(system: BodySystem, fromId: string, toId: string, departUt: number, tof: number, cost?: (a: Vec3, b: Vec3) => number): TransferArc | null {
  const parent = commonParent(system, fromId, toId);
  const s1 = system.stateRelative(fromId, parent, departUt);
  const s2 = system.stateRelative(toId, parent, departUt + tof);
  const ref = v3.normalize(v3.cross(s1.r, s1.v));
  const sol = solveLambert(system.body(parent).mu, s1.r, s2.r, tof, true, ref);
  if (!sol) return null;
  const vInfDepart = v3.sub(sol.v1, s1.v);
  const vInfArrive = v3.sub(sol.v2, s2.v);
  return {
    departUt,
    arriveUt: departUt + tof,
    tof,
    vInfDepart,
    vInfArrive,
    phaseAngle: phaseAngle(system, fromId, toId, departUt),
    cost: cost ? cost(vInfDepart, vInfArrive) : v3.len(vInfDepart) + v3.len(vInfArrive),
  };
}

/** Mean orbit radius of a body about its parent (the semi-major axis of its osculating conic at ut). */
function meanRadius(system: BodySystem, id: string, ut: number): number {
  const c = system.orbitConic(id, ut);
  if (c && c.e < 1) return c.a;
  return v3.len(system.stateRelParent(id, ut).r);
}

/**
 * The best transfer arc departing in [fromUt, toUt] (a porkchop search: a grid of departure times and times
 * of flight, then the best cell refined by alternating golden-section searches in departure time and time of
 * flight). Null when no arc exists.
 */
export function bestTransfer(system: BodySystem, fromId: string, toId: string, fromUt: number, toUt: number, opts: TransferSearchOptions = {}): TransferArc | null {
  const parent = commonParent(system, fromId, toId);
  const mu = system.body(parent).mu;
  const r1 = meanRadius(system, fromId, fromUt);
  const r2 = meanRadius(system, toId, fromUt);
  const th = hohmannTransferTime(mu, r1, r2);
  const [k0, k1] = opts.tofRange ?? [0.6, 1.5];
  const nd = Math.max(2, opts.departureSamples ?? 48);
  const nt = Math.max(2, opts.tofSamples ?? 24);
  let best: TransferArc | null = null;
  for (let i = 0; i <= nd; i++) {
    const td = fromUt + ((toUt - fromUt) * i) / nd;
    for (let j = 0; j <= nt; j++) {
      const tof = th * (k0 + ((k1 - k0) * j) / nt);
      const arc = transferArc(system, fromId, toId, td, tof, opts.cost);
      if (arc && (!best || arc.cost < best.cost)) best = arc;
    }
  }
  if (!best) return null;
  // refine: alternate in departure time and time of flight within one grid cell each way
  let td = best.departUt;
  let tof = best.tof;
  let dd = (toUt - fromUt) / nd;
  let dt = (th * (k1 - k0)) / nt;
  const costOf = (a: number, b: number): number => transferArc(system, fromId, toId, a, b, opts.cost)?.cost ?? Infinity;
  for (let pass = 0; pass < 6; pass++) {
    const lo = Math.max(fromUt, td - dd);
    const hi = Math.min(toUt, td + dd);
    if (hi > lo) td = goldenMin((x) => costOf(x, tof), lo, hi, Math.max(1, (hi - lo) * 1e-4)).x;
    const tlo = Math.max(th * k0, tof - dt);
    const thi = Math.min(th * k1, tof + dt);
    if (thi > tlo) tof = goldenMin((x) => costOf(td, x), tlo, thi, Math.max(1, (thi - tlo) * 1e-4)).x;
    dd /= 2;
    dt /= 2;
  }
  const refined = transferArc(system, fromId, toId, td, tof, opts.cost);
  return refined && refined.cost <= best.cost ? refined : best;
}

/**
 * The transfer windows departing in [fromUt, toUt]: the best arc of every synodic period of the two mean
 * orbits in the span (one window per period), in time order.
 */
export function transferWindows(system: BodySystem, fromId: string, toId: string, fromUt: number, toUt: number, opts: TransferSearchOptions = {}): TransferArc[] {
  const parent = commonParent(system, fromId, toId);
  const mu = system.body(parent).mu;
  const syn = synodicPeriod(mu, meanRadius(system, fromId, fromUt), meanRadius(system, toId, fromUt));
  const span = Number.isFinite(syn) ? syn : toUt - fromUt;
  const out: TransferArc[] = [];
  for (let t = fromUt; t < toUt; t += span) {
    const arc = bestTransfer(system, fromId, toId, t, Math.min(toUt, t + span), opts);
    if (arc) out.push(arc);
  }
  return out;
}
