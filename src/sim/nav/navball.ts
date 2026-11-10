/**
 * Navball state (docs/research/sim-design.md 18.1, NavballState in src/core/contracts/sim.ts).
 *
 * Horizon frame = ENU at the vessel's sub-point of its SOI body (geocentric up). Markers are unit vectors
 * in the VES frame. Orbit mode: prograde = v (BCI); surface mode: prograde = v - spin x r. Normal follows
 * the node-frame convention, normal = normalize(r_hat x prograde), radialOut = prograde x normal.
 *
 * Robustness (never NaN): with |velocity| < MIN_SPEED (vessel at rest, on the pad) prograde = up; when
 * prograde is vertical the normal is the local north projected perpendicular to prograde (the continuous
 * limit of an eastward tilt). Pitch = asin(nose . up); heading = compass direction of the nose; when the
 * nose is vertical the heading is taken from the ventral side (nose up) / dorsal side (nose down), which is
 * the direction a pitch-down / pitch-up leaves the vertical in, and roll is then 0. Roll is positive for
 * a rotation about +Y (dorsal toward starboard), the sign of the roll control.
 */
import type { NavballMode } from '../../core/contracts/controls';
import type { NavballMarkers, NavballState } from '../../core/contracts/sim';
import { quat, type Quat } from '../../core/math/quat';
import { RAD } from '../../core/math/scalar';
import { v3, type Vec3 } from '../../core/math/vec3';
import { enuBasis, qEnuToInertial, surfaceVelocity, type EnuBasis } from '../frames/bodyFrames';

/** Speeds below this (m/s) have no defined direction. */
export const NAVBALL_MIN_SPEED = 1e-3;
/** Relative hysteresis band of the automatic surface/orbit switch. */
export const NAVBALL_SWITCH_HYSTERESIS = 0.05;

export interface NavballInput {
  mode: NavballMode;
  /** VES -> BCI (= ROOT axes) attitude. */
  q: Quat;
  /** State in BCI of the SOI body. */
  r: Vec3;
  v: Vec3;
  /** BCBF -> BCI orientation and spin vector (BCI axes) of the SOI body. */
  qFixedToInertial: Quat;
  spin: Vec3;
  /** Remaining node delta-v (ROOT axes) or null. */
  maneuverDv?: Vec3 | null;
  /** Direction from the vessel to the target (ROOT axes) or null. */
  targetDir?: Vec3 | null;
  /** Capsule lift direction in the VES frame (from the aerodynamics) or null. */
  liftVectorVes?: Vec3 | null;
}

/** Prograde / normal / radial-out directions (BCI axes) of a velocity at position r. */
export function flightDirections(r: Vec3, vel: Vec3, enu: EnuBasis): { prograde: Vec3; normal: Vec3; radialOut: Vec3 } {
  const rHat = v3.normalize(r);
  const prograde = v3.len(vel) >= NAVBALL_MIN_SPEED ? v3.normalize(vel) : enu.up;
  let normal = v3.cross(rHat, prograde);
  if (v3.len(normal) > 1e-9) normal = v3.normalize(normal);
  else {
    normal = v3.reject(enu.north, prograde);
    normal = v3.len(normal) > 1e-9 ? v3.normalize(normal) : v3.anyOrthogonal(prograde);
  }
  return { prograde, normal, radialOut: v3.cross(prograde, normal) };
}

/** Pitch, heading (0..360) and roll of a VES -> BCI attitude in a horizon basis, degrees. */
export function attitudeAngles(q: Quat, enu: EnuBasis): { pitchDeg: number; headingDeg: number; rollDeg: number } {
  const nose = quat.rotate(q, { x: 0, y: 1, z: 0 });
  const dorsal = quat.rotate(q, { x: 0, y: 0, z: 1 });
  const up = enu.up;
  const sinP = Math.max(-1, Math.min(1, v3.dot(nose, up)));
  const pitchDeg = Math.asin(sinP) * RAD;
  let horiz = v3.reject(nose, up);
  let upRef: Vec3;
  if (v3.len(horiz) > 1e-9) {
    upRef = v3.normalize(v3.reject(up, nose));
  } else {
    // Nose vertical: heading of the side a pitch manoeuvre tips the nose toward.
    horiz = v3.reject(sinP >= 0 ? v3.neg(dorsal) : dorsal, up);
    upRef = v3.len(horiz) > 1e-12 ? v3.normalize(v3.scale(horiz, -Math.sign(sinP || 1))) : dorsal;
  }
  let headingDeg = Math.atan2(v3.dot(horiz, enu.east), v3.dot(horiz, enu.north)) * RAD;
  if (headingDeg < 0) headingDeg += 360;
  if (headingDeg >= 360) headingDeg -= 360;
  const right = v3.cross(nose, upRef);
  const rollDeg = Math.atan2(v3.dot(dorsal, right), v3.dot(dorsal, upRef)) * RAD;
  return { pitchDeg, headingDeg, rollDeg };
}

/** Angle between the nose and the local vertical, rad. */
export function tiltFromVertical(q: Quat, r: Vec3): number {
  return v3.angle(quat.rotate(q, { x: 0, y: 1, z: 0 }), r);
}

/** Navball state for one vessel. */
export function computeNavball(input: NavballInput): NavballState {
  const { q, r, v, mode } = input;
  const enu = enuBasis(input.qFixedToInertial, r);
  const vel = mode === 'surface' ? surfaceVelocity(r, v, input.spin) : v;
  const dirs = flightDirections(r, vel, enu);
  const toVes = (d: Vec3): Vec3 => v3.normalize(quat.rotateInv(q, d));
  const unitOrNull = (d: Vec3 | null | undefined): Vec3 | null => (d && v3.len(d) > 1e-9 ? v3.normalize(d) : null);
  const man = unitOrNull(input.maneuverDv);
  const tgt = unitOrNull(input.targetDir);
  const lift = unitOrNull(input.liftVectorVes);
  const markers: NavballMarkers = {
    prograde: toVes(dirs.prograde),
    retrograde: toVes(v3.neg(dirs.prograde)),
    normal: toVes(dirs.normal),
    antinormal: toVes(v3.neg(dirs.normal)),
    radialOut: toVes(dirs.radialOut),
    radialIn: toVes(v3.neg(dirs.radialOut)),
    maneuver: man ? toVes(man) : null,
    target: tgt ? toVes(tgt) : null,
    antiTarget: tgt ? toVes(v3.neg(tgt)) : null,
    liftVector: lift,
  };
  const qHorizonToInertial = qEnuToInertial(enu);
  const qVesselToHorizon = quat.normalize(quat.mul(quat.conj(qHorizonToInertial), q));
  return { mode, qVesselToHorizon, markers, ...attitudeAngles(q, enu) };
}

/** Navball mode for a vessel without history: surface below the switch altitude, orbit above. */
export function defaultNavballMode(altitude: number, switchAltitude: number): NavballMode {
  return altitude < switchAltitude ? 'surface' : 'orbit';
}

/**
 * Automatic switch, edge-triggered with 5 % hysteresis: 'surface' -> 'orbit' when the altitude rises
 * through 1.05 x switchAltitude, 'orbit' -> 'surface' when it falls through 0.95 x. Between crossings the
 * mode is kept (so a manual choice sticks until the next crossing).
 */
export function navballModeAfter(mode: NavballMode, prevAltitude: number, altitude: number, switchAltitude: number): NavballMode {
  if (!(switchAltitude > 0)) return mode;
  const hi = switchAltitude * (1 + NAVBALL_SWITCH_HYSTERESIS);
  const lo = switchAltitude * (1 - NAVBALL_SWITCH_HYSTERESIS);
  if (prevAltitude < hi && altitude >= hi) return 'orbit';
  if (prevAltitude > lo && altitude <= lo) return 'surface';
  return mode;
}
