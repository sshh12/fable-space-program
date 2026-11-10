/**
 * Orbital parts of the HUD readouts (Readouts in src/core/contracts/sim.ts) for a vessel about its SOI
 * body: altitude, sub-point, speeds, osculating apsides and times, inclination (to the body's equator),
 * eccentricity, period, and the target relations (relative inclination, closest approach on the planned or
 * else the current trajectory).
 */
import type { Patch, Readouts } from '../../core/contracts/sim';
import { quat } from '../../core/math/quat';
import { v3, type Vec3 } from '../../core/math/vec3';
import type { BodySystem } from '../bodies/bodySystem';
import { surfaceVelocity } from '../frames/bodyFrames';
import { timeOfTrueAnomaly } from '../orbit/events';
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
  | 'targetBodyId'
  | 'targetRelativeInclination'
  | 'targetClosestApproach'
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
  const ra = closed ? c.p / (1 - c.e) : Infinity;
  const tPe = timeOfTrueAnomaly(o, 0, ut);
  const tAp = closed ? timeOfTrueAnomaly(o, Math.PI, ut) : null;
  const pole = body.rotation.kind === 'uniform' ? body.rotation.pole : { x: 0, y: 0, z: 1 };

  const targetId = input.targetBodyId ?? null;
  let relInc: number | null = null;
  let closest: { ut: number; distance: number } | null = null;
  if (targetId !== null && targetId !== bodyId) {
    const target = system.body(targetId);
    if (target.parentId === bodyId && target.kepler) relInc = relativeInclination(c.W, target.kepler.normal);
    const pp = input.patches;
    if (pp) closest = closestApproachOnPatches(pp.planned.length ? pp.planned : pp.current, targetId);
  }

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
    targetBodyId: targetId,
    targetRelativeInclination: relInc,
    targetClosestApproach: closest,
  };
}
