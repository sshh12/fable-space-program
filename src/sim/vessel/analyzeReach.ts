/**
 * Where a craft can go from low orbit of its launch body: patched-conic estimates computed from the bodies of
 * the library (docs/ARCHITECTURE.md 8.1, 9.1, 9.2), for the "can reach" ladder of `analyzeVehicle`. Never
 * authored: every number comes from the bodies' masses, radii, orbits, spheres of influence and atmospheres.
 *
 * The method (stated, because it is an estimate and the reachability table of the activation package uses
 * solar-system-sim's `deltaVToOrbit` as the authority):
 *   - departure from a circular parking orbit at `parkingAltitude` above the launch body L (or from the
 *     perigee of a high elliptical orbit about L, for the refuelled profile);
 *   - transfers are Hohmann ellipses between circular coplanar orbits (the semi-major axes of the bodies'
 *     orbits); the hyperbolic excess speed of the departure is added at the parking orbit (Oberth);
 *   - "orbit" at a target is a LOOSE CAPTURE (fleet-docking 2.4): a burn at the periapsis of the arrival
 *     hyperbola into an ellipse with periapsis at `captureRadiusFactor` radii (above the atmosphere's top)
 *     and apoapsis at `captureApoapsisRadii` radii or `captureSoiShare` of the target's sphere of influence,
 *     whichever is lower; a bound capture ellipse at a giant, as ARCHITECTURE 9.1 offers;
 *   - a moon of another planet: Hohmann to the planet, then the craft falls to the moon's orbit on the
 *     arrival hyperbola and captures at the moon against the speed it has relative to the moon there;
 *   - the parent of L (the star): escape from L into an orbit like L's;
 *   - no aerobraking, no gravity assists, no plane changes (a few hundred m/s of real windows are not in it).
 * Pure functions of the definitions.
 */
import type { BodyDef, DefLibrary } from '@/core/contracts/defs';

/** One astronomical unit, m (IAU 2012): the mean distance of an orbit stated as the Almanac Sun formula. */
export const ASTRONOMICAL_UNIT = 149597870700;

export interface ReachAssumptions {
  /** Altitude of the circular parking orbit about the launch body, m. */
  parkingAltitude: number;
  /** Periapsis of a loose capture, in radii of the target (raised above the atmosphere's top where it is higher). */
  captureRadiusFactor: number;
  /** Apoapsis of a loose capture, in radii of the target, and at most this share of its sphere of influence. */
  captureApoapsisRadii: number;
  captureSoiShare: number;
}

export const REACH_ASSUMPTIONS: ReachAssumptions = { parkingAltitude: 200000, captureRadiusFactor: 1.2, captureApoapsisRadii: 200, captureSoiShare: 0.9 };

/** Delta-v from the parking orbit (m/s) to pass a body ('flyby': the departure alone) and to be captured about it ('orbit'). */
export interface TransferCost {
  flyby: number;
  orbit: number;
}

/** Semi-major axis of a body's orbit about its parent, m (null for the root). */
export function semiMajorAxis(body: BodyDef): number | null {
  if (!body.orbit) return null;
  return body.orbit.kind === 'kepler' ? body.orbit.a : ASTRONOMICAL_UNIT;
}

/** Sphere of influence radius, m: the stated one, or for 'auto' min(Hill, max(a (m/M)^0.4, 2.5 R)) (ARCHITECTURE 8.3). */
export function soiRadiusOf(defs: DefLibrary, body: BodyDef): number {
  if (typeof body.soiRadius === 'number') return body.soiRadius;
  const parent = body.parent ? defs.bodies[body.parent] : undefined;
  const a = semiMajorAxis(body);
  if (!parent || a === null) return Infinity;
  const ratio = body.mu / parent.mu;
  const e = body.orbit?.kind === 'kepler' ? body.orbit.e : 0;
  const hill = a * (1 - e) * Math.cbrt(ratio / 3);
  return Math.min(hill, Math.max(a * Math.pow(ratio, 0.4), 2.5 * body.radius));
}

const circular = (mu: number, r: number): number => Math.sqrt(mu / r);
/** Speed on an ellipse of radii r1 (where the speed is taken) and r2, about a body of parameter mu. */
const ellipseSpeed = (mu: number, r1: number, r2: number): number => Math.sqrt((2 * mu * r2) / (r1 * (r1 + r2)));

/** Loose capture about `body` from a hyperbolic excess speed vInf, m/s. */
export function captureDeltaV(defs: DefLibrary, body: BodyDef, vInf: number, a: ReachAssumptions = REACH_ASSUMPTIONS): number {
  const top = body.atmosphere ? body.radius + body.atmosphere.simTop : 0;
  const rp = Math.max(a.captureRadiusFactor * body.radius, top * 1.05);
  const ra = Math.max(rp, Math.min(a.captureApoapsisRadii * body.radius, a.captureSoiShare * soiRadiusOf(defs, body)));
  return Math.max(0, Math.sqrt(vInf * vInf + (2 * body.mu) / rp) - ellipseSpeed(body.mu, rp, ra));
}

/** Hyperbolic excess speeds of a Hohmann transfer between circular orbits of radii r1 and r2 about mu: at departure and at arrival. */
function hohmannExcess(mu: number, r1: number, r2: number): { depart: number; arrive: number } {
  return { depart: Math.abs(ellipseSpeed(mu, r1, r2) - circular(mu, r1)), arrive: Math.abs(circular(mu, r2) - ellipseSpeed(mu, r2, r1)) };
}

/** The ancestors of a body, nearest first. */
function ancestors(defs: DefLibrary, body: BodyDef): BodyDef[] {
  const out: BodyDef[] = [];
  for (let b = body.parent ? defs.bodies[body.parent] : undefined; b; b = b.parent ? defs.bodies[b.parent] : undefined) out.push(b);
  return out;
}

/**
 * What it costs to reach `targetId` from the launch body's parking orbit; null when the bodies stand in a
 * relation the estimate does not cover. `departPeriapsisSpeed`: the speed at the parking radius of the orbit
 * the craft departs from (default: circular there; for the refuelled profile the perigee speed of a high
 * elliptical orbit), so the departure burn is the excess over it.
 */
export function transferCost(defs: DefLibrary, launchId: string, targetId: string, a: ReachAssumptions = REACH_ASSUMPTIONS, departPeriapsisSpeed?: number): TransferCost | null {
  const L = defs.bodies[launchId];
  const T = defs.bodies[targetId];
  if (!L || !T || L === T) return null;
  const r0 = L.radius + a.parkingAltitude;
  const vStart = departPeriapsisSpeed ?? circular(L.mu, r0);
  const depart = (vInf: number): number => Math.max(0, Math.sqrt(vInf * vInf + (2 * L.mu) / r0) - vStart);
  const aL = semiMajorAxis(L);
  // A moon of the launch body: Hohmann from the parking orbit to its orbit, capture there.
  if (T.parent === L.id) {
    const aT = semiMajorAxis(T)!;
    const burn = Math.max(0, ellipseSpeed(L.mu, r0, aT) - vStart);
    const vInf = Math.abs(circular(L.mu, aT) - ellipseSpeed(L.mu, aT, r0));
    return { flyby: burn, orbit: burn + captureDeltaV(defs, T, vInf, a) };
  }
  // The launch body's parent: escape into an orbit like the launch body's.
  if (L.parent === T.id) {
    const burn = depart(0);
    return { flyby: burn, orbit: burn };
  }
  const P = L.parent ? defs.bodies[L.parent] : undefined;
  if (!P || aL === null) return null;
  // A sibling of the launch body (a planet, when the launch body is a planet).
  if (T.parent === P.id) {
    const ex = hohmannExcess(P.mu, aL, semiMajorAxis(T)!);
    const burn = depart(ex.depart);
    return { flyby: burn, orbit: burn + captureDeltaV(defs, T, ex.arrive, a) };
  }
  // A moon of a sibling: to the planet, then down its arrival hyperbola to the moon's orbit.
  const S = T.parent ? defs.bodies[T.parent] : undefined;
  if (S && S.parent === P.id && ancestors(defs, T).some((b) => b.id === P.id)) {
    const ex = hohmannExcess(P.mu, aL, semiMajorAxis(S)!);
    const burn = depart(ex.depart);
    const aT = semiMajorAxis(T)!;
    const vAtMoonOrbit = Math.sqrt(ex.arrive * ex.arrive + (2 * S.mu) / aT);
    const vRel = Math.abs(vAtMoonOrbit - circular(S.mu, aT));
    return { flyby: burn, orbit: burn + captureDeltaV(defs, T, vRel, a) };
  }
  return null;
}

/**
 * The perigee speed of the high elliptical orbit the refuelled profile departs from: perigee at the parking
 * radius, apogee at half the orbit of the launch body's innermost moon (clear of its sphere of influence), or
 * at half the launch body's own sphere of influence when it has no moon.
 */
export function refuelOrbitPerigeeSpeed(defs: DefLibrary, launchId: string, a: ReachAssumptions = REACH_ASSUMPTIONS): { speed: number; apoapsisAltitude: number } {
  const L = defs.bodies[launchId]!;
  const r0 = L.radius + a.parkingAltitude;
  const moons = Object.values(defs.bodies).filter((b) => b.parent === L.id && b.gravityRole === 'attractor').map((b) => semiMajorAxis(b)!).sort((x, y) => x - y);
  const ra = moons.length > 0 ? 0.5 * moons[0]! : 0.5 * soiRadiusOf(defs, L);
  return { speed: ellipseSpeed(L.mu, r0, ra), apoapsisAltitude: ra - L.radius };
}
