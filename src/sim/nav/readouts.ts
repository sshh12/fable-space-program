/**
 * Orbital parts of the HUD readouts (Readouts in src/core/contracts/sim.ts) for a vessel about its SOI
 * body: altitude, sub-point, speeds, osculating apsides and times, inclination (to the body's equator),
 * eccentricity, period, and the navigation to a targeted body (`Readouts.target`: range and range rate to
 * its centre, relative inclination, the closest approach on the planned or else the current trajectory with
 * the speed relative to the body at it).
 */
import type { Patch, Readouts, TargetReadout } from '../../core/contracts/sim';
import { conicTrueAnomaly, conicVelocity } from '../../core/math/conic';
import { quat } from '../../core/math/quat';
import { v3, type Vec3 } from '../../core/math/vec3';
import type { BodySystem } from '../bodies/bodySystem';
import { surfaceVelocity } from '../frames/bodyFrames';
import { nextApsisTime } from '../orbit/events';
import { makeOrbit } from '../orbit/kepler';
import { relativeInclination } from '../orbit/relative';

export type OrbitalReadouts = Pick<
  Readouts,
  | 'altitudeAsl'
  | 'latitude'
  | 'longitude'
  | 'speedOrbital'
  | 'speedSurface'
  | 'verticalSpeed'
  | 'horizontalSpeed'
  | 'apoapsisAltitude'
  | 'periapsisAltitude'
  | 'timeToApoapsis'
  | 'timeToPeriapsis'
  | 'inclination'
  | 'eccentricity'
  | 'period'
  | 'targetRelativeInclination'
  | 'target'
>;

export interface OrbitalReadoutInput {
  system: BodySystem;
  bodyId: string;
  /** BCI(bodyId) state at ut. */
  r: Vec3;
  v: Vec3;
  ut: number;
  targetBodyId?: string | null;
  /** Predicted patches (for the target's closest approach). */
  patches?: { current: readonly Patch[]; planned: readonly Patch[] } | null;
}

/**
 * Closest approach to `targetId` on a patch list: the minimum over its 'closestApproach' markers and over
 * the periapsis markers of patches about the target itself (an encounter). Null when there is none.
 */
export function closestApproachOnPatches(patches: readonly Patch[], targetId: string): { ut: number; distance: number } | null {
  let best: { ut: number; distance: number } | null = null;
  for (const p of patches) {
    for (const m of p.markers) {
      let d: number | null = null;
      if (m.kind === 'closestApproach' && m.value !== undefined && p.bodyId !== targetId) d = m.value;
      else if (m.kind === 'periapsis' && p.bodyId === targetId) d = v3.len(m.r);
      if (d !== null && (!best || d < best.distance)) best = { ut: m.ut, distance: d };
    }
  }
  return best;
}

/**
 * Navigation to a targeted BODY (`Readouts.target`): range and range rate to its centre from the state
 * `r`, `v` about `bodyId` (a vessel inside the target's own sphere of influence is about the target),
 * with the relative inclination and the closest approach the caller found. What only a vessel or a port
 * target has is null.
 */
export function bodyTargetReadout(
  system: BodySystem,
  bodyId: string,
  r: Vec3,
  v: Vec3,
  ut: number,
  targetId: string,
  relativeInclination: number | null,
  closest: { ut: number; distance: number; relSpeed: number } | null,
): TargetReadout {
  const rel = targetId === bodyId ? null : system.stateRelative(targetId, bodyId, ut);
  const d = rel ? v3.sub(rel.r, r) : v3.neg(r);
  const dv = rel ? v3.sub(rel.v, v) : v3.neg(v);
  const range = v3.len(d);
  return {
    ref: { kind: 'body', id: targetId },
    name: system.body(targetId).def.name,
    presence: 'solid',
    timeOffset: 0,
    range,
    rangeRate: range > 0 ? v3.dot(d, dv) / range : 0,
    relVelocity: null,
    relSpeed: null,
    relativeInclination,
    closestApproaches: closest ? [closest] : [],
    lvlh: null,
    offer: null,
  };
}

/**
 * The same approach as `closestApproachOnPatches` with the speed relative to the target at it: the
 * vessel's velocity on the patch at the marker (the marker's position is on the conic) less the target's
 * about the patch's body at that time; for a periapsis about the target itself, the speed at periapsis.
 */
export function closestApproachToBody(system: BodySystem, patches: readonly Patch[], targetId: string): { ut: number; distance: number; relSpeed: number } | null {
  let best: { ut: number; distance: number; patch: Patch; r: Vec3 } | null = null;
  for (const p of patches) {
    for (const m of p.markers) {
      let d: number | null = null;
      if (m.kind === 'closestApproach' && m.value !== undefined && p.bodyId !== targetId) d = m.value;
      else if (m.kind === 'periapsis' && p.bodyId === targetId) d = v3.len(m.r);
      if (d !== null && (!best || d < best.distance)) best = { ut: m.ut, distance: d, patch: p, r: m.r };
    }
  }
  if (!best) return null;
  const own = conicVelocity(best.patch.conic, conicTrueAnomaly(best.patch.conic, best.r));
  const relSpeed = best.patch.bodyId === targetId ? v3.len(own) : v3.len(v3.sub(own, system.stateRelative(targetId, best.patch.bodyId, best.ut).v));
  return { ut: best.ut, distance: best.distance, relSpeed };
}

export function computeOrbitalReadouts(input: OrbitalReadoutInput): OrbitalReadouts {
  const { system, bodyId, r, v, ut } = input;
  const body = system.body(bodyId);
  const def = body.def;
  const R = body.radius;
  const rm = v3.len(r);
  const up = v3.scale(r, 1 / rm);
  const vs = surfaceVelocity(r, v, body.spin);
  const verticalSpeed = v3.dot(v, up);
  const fixed = quat.rotateInv(system.orientation(bodyId, ut), r);
  const o = makeOrbit(bodyId, body.mu, r, v, ut);
  const c = o.conic;
  const rp = c.p / (1 + c.e);
  const closed = o.period !== null;
  // 2a - rp is exact for every closed orbit and stays finite for (near-)radial ones, where p/(1 - e) is 0/0.
  const ra = closed ? 2 / o.alpha - rp : Infinity;
  const tPe = nextApsisTime(o, 'periapsis', ut);
  const tAp = nextApsisTime(o, 'apoapsis', ut);
  const pole = body.rotation.kind === 'uniform' ? body.rotation.pole : { x: 0, y: 0, z: 1 };

  const targetId = input.targetBodyId ?? null;
  let relInc: number | null = null;
  let closest: { ut: number; distance: number; relSpeed: number } | null = null;
  if (targetId !== null && targetId !== bodyId) {
    const tb = system.body(targetId);
    if (tb.parentId === bodyId && tb.ephemeris) relInc = relativeInclination(c.W, tb.ephemeris.normalAt(ut));
    const pp = input.patches;
    if (pp) closest = closestApproachToBody(system, pp.planned.length ? pp.planned : pp.current, targetId);
  }
  const target = targetId === null ? null : bodyTargetReadout(system, bodyId, r, v, ut, targetId, relInc, closest);

  return {
    altitudeAsl: rm - R - (def.ocean ? def.ocean.seaLevel : 0),
    latitude: Math.atan2(fixed.z, Math.hypot(fixed.x, fixed.y)),
    longitude: Math.atan2(fixed.y, fixed.x),
    speedOrbital: v3.len(v),
    speedSurface: v3.len(vs),
    verticalSpeed,
    horizontalSpeed: v3.len(v3.reject(vs, up)),
    apoapsisAltitude: ra - R,
    periapsisAltitude: rp - R,
    timeToApoapsis: tAp === null ? null : tAp - ut,
    timeToPeriapsis: tPe === null ? null : tPe - ut,
    inclination: v3.angle(c.W, pole),
    eccentricity: c.e,
    period: o.period,
    targetRelativeInclination: relInc,
    target,
  };
}
