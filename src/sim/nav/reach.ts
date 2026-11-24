/**
 * Reach (ARCHITECTURE 8.1, 9.1): the delta-v a craft needs from a low parking orbit about the launch body to a
 * bound orbit about any body of the library, as a pure function of the definitions. fleet-data's
 * `analyzeVehicle` builds its can-reach ladder on it and the activation package its reachability table.
 *
 * The profile (patched conics, impulsive burns, then the stated allowances):
 *  - the origin itself: nothing beyond the parking orbit; the origin's parent (the star): escape from the
 *    parking orbit;
 *  - a moon of the origin: a Hohmann transfer from the parking orbit to the moon's mean distance, capture into a
 *    low circular orbit at the moon;
 *  - a body orbiting the origin's parent (a planet or a dwarf planet): a heliocentric leg (a Lambert arc at the
 *    best window departing in the search span, or a Hohmann transfer between the mean orbits), the departure
 *    burn from the parking orbit (or from the refuel point) and the capture into a BOUND CAPTURE ELLIPSE
 *    (periapsis at the low orbit altitude, apoapsis CAPTURE_APOAPSIS_SOI_SHARE of the sphere of influence;
 *    "orbit" at a giant is such an ellipse: ARCHITECTURE 9.1);
 *  - a moon of such a body: the cheaper of (A) a flyby with periapsis at the moon's orbit and the capture at the
 *    moon, and (B) a capture at the planet into an ellipse whose apoapsis touches the moon's orbit, then the
 *    capture at the moon (solar-system.md 6.2); the moon's orbit is a low circular one;
 *  - aerobraking where an atmosphere allows it (a body with a solid surface and an atmosphere): the capture burn
 *    becomes the periapsis raise out of the atmosphere at the first apoapsis;
 *  - the refuel point (optional): a high elliptical orbit about the origin (periapsis at the parking orbit,
 *    apoapsis REFUEL_HIGH_ORBIT_SOI_SHARE of the origin's sphere) or a low orbit about the origin's largest moon;
 *    the result states the delta-v before and after it (with full tanks there);
 *  - optionally a broken-plane heliocentric leg (ReachOptions.brokenPlane): its plane change is a leg of its own;
 *  - allowances: BURN_LOSS_SHARE of every burn (finite burns, steering), and a correction allowance per
 *    transfer leg (CORRECTION_PER_INTERPLANETARY_LEG, CORRECTION_PER_MOON_LEG).
 *
 * Generic: no body is named; the origin is the body of the library's launch sites unless stated.
 */
import type { DefLibrary } from '../../core/contracts/defs';
import { v3, type Vec3 } from '../../core/math/vec3';
import { createBodySystem, type BodySystem } from '../bodies/bodySystem';
import { surfaceRadiusRange } from '../bodies/shape';
import { bestTransfer, captureDeltaV, departureDeltaV, hohmannTransferTime, synodicPeriod, type TransferArc } from './transfer';

/** Share of every impulsive burn added for finite-burn and steering losses. */
export const BURN_LOSS_SHARE = 0.02;
/** Correction allowance per heliocentric (planet-to-planet) leg and per leg to a moon, m/s. */
export const CORRECTION_PER_INTERPLANETARY_LEG = 30;
export const CORRECTION_PER_MOON_LEG = 10;
/** Apoapsis of the bound capture ellipse at a planet, as a share of its sphere of influence. */
export const CAPTURE_APOAPSIS_SOI_SHARE = 0.1;
/** Apoapsis of the high elliptical refuel orbit about the origin, as a share of the origin's sphere. */
export const REFUEL_HIGH_ORBIT_SOI_SHARE = 0.4;
/** Default parking orbit altitude above the origin, m. */
export const DEFAULT_PARKING_ALTITUDE = 200e3;
/** Low orbit altitude rule: the larger of the atmosphere top and min(LOW_ORBIT_MAX_ALTITUDE, LOW_ORBIT_RADIUS_SHARE x radius); a body without a surface: GIANT_LOW_ORBIT_RADIUS_SHARE x radius above its reference surface. */
export const LOW_ORBIT_MAX_ALTITUDE = 100e3;
export const LOW_ORBIT_RADIUS_SHARE = 0.05;
export const GIANT_LOW_ORBIT_RADIUS_SHARE = 0.1;
/** Above the atmosphere top a low orbit keeps this share of it as a margin. */
export const ATMOSPHERE_MARGIN_SHARE = 0.05;

export type RefuelPoint = 'none' | 'highOrbit' | 'moonOrbit';

export interface ReachOptions {
  /** Body the profile starts from, in a low parking orbit (default: the body of the library's launch sites). */
  originId?: string;
  /** Parking orbit altitude, m (default 200 km). */
  parkingAltitude?: number;
  /** Where the craft takes on propellant before it departs (default 'none'). */
  refuel?: RefuelPoint;
  /** Aerobrake where the atmosphere allows (default true). */
  aerobrake?: boolean;
  /** The heliocentric leg: 'lambert' (default) or 'hohmann' (circular coplanar mean orbits). */
  method?: 'lambert' | 'hohmann';
  /** Start of the window search, s (default: the earliest scenario start of the library, else J2000). */
  fromUt?: number;
  /** Length of the window search, s (default one synodic period of the two planets; a longer span is searched one synodic period at a time). */
  searchSpan?: number;
  /**
   * Also try broken-plane heliocentric legs (src/sim/nav/transfer.ts `brokenPlaneArc`: in the departure plane,
   * one plane change on the way, then to the target's true position) and keep the cheaper (default false, the
   * direct Lambert arc: the numbers fleet-data's reach table holds). Lambert method only.
   */
  brokenPlane?: boolean;
}

export interface ReachLeg {
  name: string;
  /** Impulsive delta-v of the leg, m/s (before the allowances). */
  deltaV: number;
}

export interface ReachResult {
  bodyId: string;
  originId: string;
  /** Delta-v from the parking orbit to the bound orbit about the body, allowances included, m/s. */
  total: number;
  /** With a refuel point: what is burnt before it (parking orbit to the refuel point) and after it (from there, with full tanks). Without one: 0 and total. */
  beforeRefuel: number;
  afterRefuel: number;
  refuel: RefuelPoint;
  legs: ReachLeg[];
  allowances: { burnLosses: number; corrections: number };
  aerobraked: boolean;
  /** The orbit reached: a bound ellipse (planets), a circular low orbit (moons), or none (the origin; the star: escape). */
  capture: { kind: 'ellipse' | 'circular' | 'none'; periapsisAltitude: number; apoapsisAltitude: number };
  /** Coast time of the transfer legs, s; departure instant of the heliocentric leg (null without one). */
  transferTime: number;
  departUt: number | null;
}

const systems = new WeakMap<DefLibrary, BodySystem>();
function systemOf(defs: DefLibrary): BodySystem {
  let s = systems.get(defs);
  if (!s) systems.set(defs, (s = createBodySystem(defs)));
  return s;
}

/** The body of the library's launch sites (the first site in id order). */
export function launchBodyOf(defs: DefLibrary): string {
  const sites = Object.keys(defs.sites).sort();
  if (!sites.length) throw new Error('deltaVToOrbit: the library has no launch site; pass options.originId');
  return defs.sites[sites[0]!]!.bodyId;
}

function defaultFromUt(defs: DefLibrary): number {
  const starts = Object.values(defs.scenarios).map((s) => s.startUt);
  return starts.length ? Math.min(...starts) : 0;
}

/** Low orbit radius about a body (see LOW_ORBIT_* above). */
export function lowOrbitRadius(system: BodySystem, id: string): number {
  const b = system.body(id);
  const def = b.def;
  if (b.surface === 'none') return surfaceRadiusRange(def).max + GIANT_LOW_ORBIT_RADIUS_SHARE * b.radius;
  const top = def.atmosphere ? def.atmosphere.simTop * (1 + ATMOSPHERE_MARGIN_SHARE) : 0;
  return surfaceRadiusRange(def).max + Math.max(top, Math.min(LOW_ORBIT_MAX_ALTITUDE, LOW_ORBIT_RADIUS_SHARE * b.radius));
}

/** Mean distance of a body from its parent (semi-major axis of its osculating orbit at ut). */
function meanDistance(system: BodySystem, id: string, ut: number): number {
  const c = system.orbitConic(id, ut);
  return c && c.e < 1 ? c.a : v3.len(system.stateRelParent(id, ut).r);
}

const canAerobrake = (system: BodySystem, id: string): boolean => {
  const b = system.body(id);
  return b.surface === 'solid' && b.def.atmosphere !== null;
};

/**
 * Arrival at a body from a hyperbola of excess speed vinf: the capture burn (or the periapsis raise after an
 * aerobraking pass) into an orbit of periapsis rp and apoapsis ra.
 */
function arrive(system: BodySystem, id: string, vinf: number, rp: number, ra: number, aerobrake: boolean): { dv: number; aerobraked: boolean } {
  const mu = system.body(id).mu;
  if (aerobrake && canAerobrake(system, id)) {
    // the pass leaves the craft on an ellipse of apoapsis ra with its periapsis in the atmosphere (half way
    // down to the surface from the top); at that apoapsis the periapsis is raised back to rp
    const def = system.body(id).def;
    const rDip = surfaceRadiusRange(def).max + def.atmosphere!.simTop / 2;
    const vDip = Math.sqrt(mu * (2 / ra - 2 / (ra + rDip)));
    const vRaised = Math.sqrt(mu * (2 / ra - 2 / (ra + rp)));
    return { dv: Math.max(0, vRaised - vDip), aerobraked: true };
  }
  return { dv: captureDeltaV(mu, rp, ra, vinf), aerobraked: false };
}

interface Departure {
  /** Burns before the refuel point and the departure burn after it (vinf: the excess speed wanted at the origin's sphere). */
  before: ReachLeg[];
  depart: (vinf: number) => number;
  departName: string;
}

/** Departure from the parking orbit, or from the refuel point, toward an excess speed vinf at the origin's sphere. */
function departure(system: BodySystem, originId: string, rPark: number, refuel: RefuelPoint, ut: number): Departure {
  const o = system.body(originId);
  const mu = o.mu;
  const vCirc = Math.sqrt(mu / rPark);
  if (refuel === 'none') return { before: [], depart: (vinf) => departureDeltaV(mu, rPark, vinf), departName: 'departure from the parking orbit' };
  if (refuel === 'highOrbit') {
    if (o.soiRadius === null) throw new Error(`deltaVToOrbit: the origin ${originId} has no sphere of influence for a high refuel orbit`);
    const ra = REFUEL_HIGH_ORBIT_SOI_SHARE * o.soiRadius;
    const vPeri = Math.sqrt(mu * (2 / rPark - 2 / (rPark + ra)));
    return {
      before: [{ name: 'raise to the high refuel orbit', deltaV: vPeri - vCirc }],
      depart: (vinf) => Math.sqrt(vinf * vinf + (2 * mu) / rPark) - vPeri,
      departName: 'departure from the high refuel orbit (at its periapsis)',
    };
  }
  // the origin's largest moon
  const moons = o.childIds.slice().sort((a, b) => system.body(b).mu - system.body(a).mu || (a < b ? -1 : 1));
  const moonId = moons[0];
  if (!moonId) throw new Error(`deltaVToOrbit: the origin ${originId} has no moon for a moon-orbit refuel point`);
  const m = system.body(moonId);
  const aM = meanDistance(system, moonId, ut);
  const rLow = lowOrbitRadius(system, moonId);
  const vMoon = Math.sqrt(mu / aM);
  const toMoon = moonTransfer(system, originId, moonId, rPark, ut);
  return {
    before: [
      { name: 'transfer to the refuel moon', deltaV: toMoon.depart },
      { name: 'capture at the refuel moon', deltaV: captureDeltaV(m.mu, rLow, rLow, toMoon.vinfMoon) },
    ],
    depart: (vinf) => {
      // leave the moon so that, at the moon's distance, the craft moves at the speed that escapes the origin
      // with vinf, along the moon's motion
      const vNeed = Math.sqrt(vinf * vinf + (2 * mu) / aM);
      const vinfMoon = Math.max(0, vNeed - vMoon);
      return departureDeltaV(m.mu, rLow, vinfMoon);
    },
    departName: 'departure from the refuel moon orbit',
  };
}

/** Hohmann transfer from a circular orbit rPark about `parentId` to its moon `moonId`: departure burn and arrival excess speed. */
function moonTransfer(system: BodySystem, parentId: string, moonId: string, rPark: number, ut: number): { depart: number; vinfMoon: number; tof: number } {
  const mu = system.body(parentId).mu;
  const aM = meanDistance(system, moonId, ut);
  const vCirc = Math.sqrt(mu / rPark);
  const vPeri = Math.sqrt(mu * (2 / rPark - 2 / (rPark + aM)));
  const vApo = Math.sqrt(mu * (2 / aM - 2 / (rPark + aM)));
  const vMoon = Math.sqrt(mu / aM);
  return { depart: vPeri - vCirc, vinfMoon: Math.abs(vMoon - vApo), tof: hohmannTransferTime(mu, rPark, aM) };
}

/** At a planet reached with excess speed vinf: the cheaper of the two ways into a low orbit about its moon. */
function moonOfPlanet(system: BodySystem, planetId: string, moonId: string, vinf: number, aerobrake: boolean, ut: number): { legs: ReachLeg[]; aerobraked: boolean } {
  const muP = system.body(planetId).mu;
  const aM = meanDistance(system, moonId, ut);
  const vMoon = Math.sqrt(muP / aM);
  const rLow = lowOrbitRadius(system, moonId);
  // A: periapsis of the approach hyperbola at the moon's orbit, tangential, then the capture at the moon
  const vPassA = Math.sqrt(vinf * vinf + (2 * muP) / aM);
  const capA = arrive(system, moonId, Math.abs(vPassA - vMoon), rLow, rLow, aerobrake);
  const totalA = capA.dv;
  // B: capture at the planet (low periapsis) into an ellipse touching the moon's orbit, then the capture at the moon
  const rpP = lowOrbitRadius(system, planetId);
  const capP = arrive(system, planetId, vinf, rpP, Math.max(aM, rpP), aerobrake);
  const vApoB = Math.sqrt(muP * (2 / aM - 2 / (rpP + aM)));
  const capB = arrive(system, moonId, Math.abs(vMoon - vApoB), rLow, rLow, aerobrake);
  const totalB = capP.dv + capB.dv;
  if (totalA <= totalB) return { legs: [{ name: 'capture at the moon (flyby of the planet at the moon’s orbit)', deltaV: capA.dv }], aerobraked: capA.aerobraked };
  return {
    legs: [
      { name: 'capture at the planet into an ellipse touching the moon’s orbit', deltaV: capP.dv },
      { name: 'capture at the moon', deltaV: capB.dv },
    ],
    aerobraked: capP.aerobraked || capB.aerobraked,
  };
}

/** Delta-v from a low parking orbit about the origin to a bound orbit about `bodyId` (see the module comment). */
export function deltaVToOrbit(defs: DefLibrary, bodyId: string, options: ReachOptions = {}): ReachResult {
  const system = systemOf(defs);
  const originId = options.originId ?? launchBodyOf(defs);
  const origin = system.body(originId);
  const target = system.body(bodyId);
  const rPark = origin.radius + (options.parkingAltitude ?? DEFAULT_PARKING_ALTITUDE);
  const refuel = options.refuel ?? 'none';
  const aerobrake = options.aerobrake ?? true;
  const fromUt = options.fromUt ?? defaultFromUt(defs);
  const dep = departure(system, originId, rPark, refuel, fromUt);
  const legs: ReachLeg[] = [...dep.before];
  const beforeCount = dep.before.length;
  let capture: ReachResult['capture'] = { kind: 'none', periapsisAltitude: 0, apoapsisAltitude: 0 };
  let aerobraked = false;
  let corrections = 0;
  let transferTime = 0;
  let departUt: number | null = null;
  const rLowT = lowOrbitRadius(system, bodyId);
  const altOf = (r: number): number => r - target.radius;

  if (bodyId === originId) {
    // already there
  } else if (target.parentId === originId) {
    // a moon of the origin
    const mt = moonTransfer(system, originId, bodyId, rPark, fromUt);
    if (refuel !== 'none') throw new Error(`deltaVToOrbit: a refuel point is not used for a moon of the origin (${bodyId})`);
    legs.push({ name: 'transfer to the moon', deltaV: mt.depart });
    const cap = arrive(system, bodyId, mt.vinfMoon, rLowT, rLowT, aerobrake);
    legs.push({ name: 'capture into a low orbit', deltaV: cap.dv });
    aerobraked = cap.aerobraked;
    corrections += CORRECTION_PER_MOON_LEG;
    transferTime = mt.tof;
    capture = { kind: 'circular', periapsisAltitude: altOf(rLowT), apoapsisAltitude: altOf(rLowT) };
  } else if (origin.parentId !== null && bodyId === origin.parentId) {
    // the origin's parent: escape from the origin
    legs.push({ name: dep.departName, deltaV: dep.depart(0) });
  } else {
    // a body about the origin's parent, or a moon of one
    const planetId = target.parentId === origin.parentId ? bodyId : target.parentId;
    if (planetId === null || system.body(planetId).parentId !== origin.parentId) throw new Error(`deltaVToOrbit: ${bodyId} is not reachable by this profile from ${originId}`);
    const planet = system.body(planetId);
    const isMoon = planetId !== bodyId;
    const rp = lowOrbitRadius(system, planetId);
    const ra = Math.max(rp, CAPTURE_APOAPSIS_SOI_SHARE * planet.soiRadius!);
    const arrival = (vinf: number): { legs: ReachLeg[]; aerobraked: boolean } => {
      if (isMoon) return moonOfPlanet(system, planetId, bodyId, vinf, aerobrake, fromUt);
      const c = arrive(system, bodyId, vinf, rp, ra, aerobrake);
      return { legs: [{ name: c.aerobraked ? 'periapsis raise after the aerobraking pass' : 'capture into the bound ellipse', deltaV: c.dv }], aerobraked: c.aerobraked };
    };
    const costOf = (vd: number, va: number): number => dep.depart(vd) + arrival(va).legs.reduce((s, l) => s + l.deltaV, 0);
    let vd: number;
    let va: number;
    let breakDeltaV = 0;
    const parentMu = system.body(origin.parentId!).mu;
    const r1 = meanDistance(system, originId, fromUt);
    const r2 = meanDistance(system, planetId, fromUt);
    if ((options.method ?? 'lambert') === 'hohmann') {
      const a = (r1 + r2) / 2;
      vd = Math.abs(Math.sqrt(parentMu / r1) * (Math.sqrt(r2 / a) - 1));
      va = Math.abs(Math.sqrt(parentMu / r2) * (1 - Math.sqrt(r1 / a)));
      transferTime = hohmannTransferTime(parentMu, r1, r2);
    } else {
      // one synodic period at a time (each on its own grid): a longer span is the best of its windows
      const syn = Math.min(synodicPeriod(parentMu, r1, r2), 20 * 365.25 * 86400);
      const span = options.searchSpan ?? syn;
      const search = { cost: (a: Vec3, b: Vec3): number => costOf(v3.len(a), v3.len(b)), brokenPlane: options.brokenPlane ?? false };
      let arc: TransferArc | null = null;
      for (let t = fromUt; t < fromUt + span; t += syn) {
        const w = bestTransfer(system, originId, planetId, t, Math.min(fromUt + span, t + syn), search);
        if (w && (!arc || w.cost < arc.cost)) arc = w;
      }
      if (!arc) throw new Error(`deltaVToOrbit: no transfer arc from ${originId} to ${planetId} departing in the search span`);
      vd = v3.len(arc.vInfDepart);
      va = v3.len(arc.vInfArrive);
      transferTime = arc.tof;
      departUt = arc.departUt;
      breakDeltaV = arc.breakDeltaV ?? 0;
    }
    legs.push({ name: dep.departName, deltaV: dep.depart(vd) });
    if (breakDeltaV > 0) legs.push({ name: 'plane change of the broken-plane arc', deltaV: breakDeltaV });
    const arr = arrival(va);
    legs.push(...arr.legs);
    aerobraked = arr.aerobraked;
    corrections += CORRECTION_PER_INTERPLANETARY_LEG + (isMoon ? CORRECTION_PER_MOON_LEG : 0);
    capture = isMoon
      ? { kind: 'circular', periapsisAltitude: altOf(rLowT), apoapsisAltitude: altOf(rLowT) }
      : { kind: 'ellipse', periapsisAltitude: altOf(rp), apoapsisAltitude: altOf(ra) };
  }

  const impulsive = legs.reduce((s, l) => s + l.deltaV, 0);
  const burnLosses = BURN_LOSS_SHARE * impulsive;
  const total = impulsive + burnLosses + corrections;
  const beforeImpulsive = legs.slice(0, beforeCount).reduce((s, l) => s + l.deltaV, 0);
  const beforeRefuel = refuel === 'none' ? 0 : beforeImpulsive * (1 + BURN_LOSS_SHARE);
  return {
    bodyId,
    originId,
    total,
    beforeRefuel,
    afterRefuel: total - beforeRefuel,
    refuel,
    legs,
    allowances: { burnLosses, corrections },
    aerobraked,
    capture,
    transferTime,
    departUt,
  };
}
