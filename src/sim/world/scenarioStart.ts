/**
 * Start states of a scenario (ScenarioDef.start in src/core/contracts/defs.ts).
 *
 *  - 'pad':    the vehicle stands on the launch mount of the scenario's site, held by its clamps.
 *  - 'orbit':  classical elements about `bodyId` at startUt. Inclination, ascending node and argument of
 *              periapsis are referred to the BCI axes of the body (parallel to ROOT: Earth's equator and
 *              the J2000 equinox for every body), true anomaly from the periapsis.
 *  - 'landed': standing on the terrain at a latitude / longitude of `bodyId` (the world sets it down a
 *              little before startUt and lets it come to rest).
 *  - 'state':  a BCI state vector of `bodyId` at startUt with an attitude along the velocity
 *              ('prograde', default), against it ('retrograde') or along the local vertical ('radialOut').
 *
 * These functions only compute poses; the world owns the vessel list, terrain loading and modes.
 */
import type { LaunchSiteDef, ScenarioStart } from '@/core/contracts/defs';
import { quat, type Quat } from '@/core/math/quat';
import { DEG } from '@/core/math/scalar';
import { v3, type Vec3 } from '@/core/math/vec3';
import type { BodySystem } from '../bodies/bodySystem';
import { dirFromLatLon } from '../frames/bodyFrames';
import { padState } from '../frames/padState';
import { vesselBaseY } from '../vessel/structure';
import type { Vessel } from '../vessel/types';

export interface StartPose {
  bodyId: string;
  r: Vec3;
  v: Vec3;
  q: Quat;
  w: Vec3;
}

/** Attitude with the nose (+Y) along `nose` and the dorsal side (+Z) as close to `dorsalHint` as possible. */
export function attitudeAlong(nose: Vec3, dorsalHint: Vec3): Quat {
  const y = v3.normalize(nose);
  let z = v3.reject(dorsalHint, y);
  z = v3.len(z) > 1e-9 ? v3.normalize(z) : v3.anyOrthogonal(y);
  const x = v3.cross(y, z);
  return quat.fromBasis(x, y, z);
}

/** Pose of a vessel on the launch mount: the lowest point of the vessel on pad elevation + clamp height. */
export function padPose(system: BodySystem, site: LaunchSiteDef, vessel: Vessel, ut: number, padElevation: number): StartPose {
  const ps = padState(system, site, ut, padElevation, site.pad.clampHeight - vesselBaseY(vessel));
  return { bodyId: site.bodyId, r: ps.r, v: ps.v, q: ps.q, w: quat.rotateInv(ps.q, system.spin(site.bodyId)) };
}

/** State vector of classical elements in the BCI axes of the body. */
export function orbitPose(system: BodySystem, start: Extract<ScenarioStart, { kind: 'orbit' }>): StartPose {
  const body = system.body(start.bodyId);
  const rp = body.radius + start.periapsisAltitude;
  const ra = body.radius + start.apoapsisAltitude;
  if (!(rp > 0) || !(ra >= rp)) throw new Error("scenario start 'orbit': need apoapsisAltitude >= periapsisAltitude above the centre");
  const a = 0.5 * (rp + ra);
  const e = (ra - rp) / (ra + rp);
  const p = a * (1 - e * e);
  const nu = start.trueAnomalyDeg * DEG;
  const rMag = p / (1 + e * Math.cos(nu));
  const k = Math.sqrt(body.mu / p);
  // Perifocal -> BCI: Rz(lan) Rx(inc) Rz(argPe).
  const qPlane = quat.mul(quat.fromAxisAngle({ x: 0, y: 0, z: 1 }, start.lanDeg * DEG), quat.mul(quat.fromAxisAngle({ x: 1, y: 0, z: 0 }, start.inclinationDeg * DEG), quat.fromAxisAngle({ x: 0, y: 0, z: 1 }, start.argPeDeg * DEG)));
  const r = quat.rotate(qPlane, { x: rMag * Math.cos(nu), y: rMag * Math.sin(nu), z: 0 });
  const v = quat.rotate(qPlane, { x: -k * Math.sin(nu), y: k * (e + Math.cos(nu)), z: 0 });
  return { bodyId: start.bodyId, r, v, q: attitudeAlong(v, r), w: v3.zero() };
}

export function statePose(start: Extract<ScenarioStart, { kind: 'state' }>): StartPose {
  const r = v3.fromTuple(start.r);
  const v = v3.fromTuple(start.v);
  if (!(v3.len(r) > 0)) throw new Error("scenario start 'state': r must not be zero");
  const up = v3.normalize(r);
  const speed = v3.len(v);
  let q: Quat;
  switch (start.attitude ?? 'prograde') {
    case 'retrograde':
      q = speed > 1e-6 ? attitudeAlong(v3.neg(v), up) : attitudeAlong(up, v3.anyOrthogonal(up));
      break;
    case 'radialOut':
      q = attitudeAlong(up, speed > 1e-6 ? v3.neg(v) : v3.anyOrthogonal(up));
      break;
    default:
      q = speed > 1e-6 ? attitudeAlong(v, up) : attitudeAlong(up, v3.anyOrthogonal(up));
  }
  return { bodyId: start.bodyId, r, v, q, w: v3.zero() };
}

/**
 * Pose of a vessel standing upright with its lowest point `clearance` metres above a surface of height
 * `surfaceHeight` (above the reference radius) at a latitude / longitude, co-rotating with the body.
 * The ventral side (-Z) faces east.
 */
export function landedPose(system: BodySystem, bodyId: string, latDeg: number, lonDeg: number, vessel: Vessel, ut: number, surfaceHeight: number, clearance: number): StartPose {
  const body = system.body(bodyId);
  const dirFixed = dirFromLatLon(latDeg * DEG, lonDeg * DEG);
  const qf = system.orientation(bodyId, ut);
  const up = quat.rotate(qf, dirFixed);
  const r = v3.scale(up, body.radius + surfaceHeight + clearance - vesselBaseY(vessel));
  const spin = system.spin(bodyId);
  const pole = quat.rotate(qf, { x: 0, y: 0, z: 1 });
  let east = v3.cross(pole, up);
  east = v3.len(east) > 1e-9 ? v3.normalize(east) : v3.anyOrthogonal(up);
  const q = attitudeAlong(up, v3.neg(east));
  return { bodyId, r, v: v3.cross(spin, r), q, w: quat.rotateInv(q, spin) };
}

export function applyPose(vessel: Vessel, pose: StartPose): void {
  vessel.r = v3.clone(pose.r);
  vessel.v = v3.clone(pose.v);
  vessel.q = quat.clone(pose.q);
  vessel.w = v3.clone(pose.w);
  vessel.anchor = null;
}
