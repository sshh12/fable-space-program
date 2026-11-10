/**
 * Navigation to surface targets (LandingTargetReadout and SurfaceTarget in src/core/contracts/sim.ts).
 *
 * Great-circle geometry on the body's reference sphere, body-fixed frame:
 *  - distance = R x central angle; bearing = initial great-circle course, clockwise from north.
 *  - down-range / cross-range: the separation resolved along the ground track as spherical along-track
 *    and cross-track distances: with central angle delta and relative bearing D = bearing - track,
 *    crossRange = R asin(sin delta sin D) (> 0: target right of the track), downRange =
 *    R atan2(sin delta cos D, cos delta) (> 0: ahead). For small delta these are delta cos D and delta sin D.
 *  - predicted arrival: the first 'impact' or 'atmosphereEntry' marker on the body in the current patches
 *    (patches end at atmosphere entry, so an impact after an entry does not exist); its miss distance and
 *    bearing go from the target centre to the arrival point.
 */
import type { LandingTargetReadout, Marker, Patch, SurfaceTarget } from '../../core/contracts/sim';
import { RAD, TWO_PI } from '../../core/math/scalar';
import { v3, type Vec3 } from '../../core/math/vec3';
import type { BodySystem } from '../bodies/bodySystem';
import { dirFromLatLon, enuBasisFixed, surfaceVelocity } from '../frames/bodyFrames';
import { quat } from '../../core/math/quat';

/** Surface speed below which the ground track (and down/cross-range) is undefined, m/s. */
export const GROUND_TRACK_MIN_SPEED = 0.1;

export interface GreatCircle {
  /** Central angle, rad in [0, pi]. */
  angle: number;
  /** Initial course from `from` toward `to`, rad clockwise from north in [0, 2 pi); 0 when coincident. */
  bearing: number;
}

/** Central angle and initial bearing between two body-fixed unit directions. */
export function greatCircle(from: Vec3, to: Vec3): GreatCircle {
  const a = v3.normalize(from);
  const b = v3.normalize(to);
  const angle = v3.angle(a, b);
  const enu = enuBasisFixed(a);
  const t = v3.reject(b, a);
  if (!(v3.len(t) > 1e-15)) return { angle, bearing: 0 };
  let bearing = Math.atan2(v3.dot(t, enu.east), v3.dot(t, enu.north));
  if (bearing < 0) bearing += TWO_PI;
  return { angle, bearing };
}

/** Body-fixed direction of a target. */
export const targetDirection = (t: SurfaceTarget): Vec3 => dirFromLatLon(t.latitude, t.longitude);

/**
 * Horizontal ground-track direction (body-fixed unit vector) of a BCI state over body `bodyId` at ut, or
 * null when the surface speed is below GROUND_TRACK_MIN_SPEED.
 */
export function groundTrackDirection(system: BodySystem, bodyId: string, r: Vec3, v: Vec3, ut: number): Vec3 | null {
  const body = system.body(bodyId);
  const vs = surfaceVelocity(r, v, body.spin);
  if (v3.len(vs) < GROUND_TRACK_MIN_SPEED) return null;
  const h = v3.reject(vs, v3.normalize(r));
  if (!(v3.len(h) > 1e-9)) return null;
  return quat.rotateInv(system.orientation(bodyId, ut), v3.normalize(h));
}

/** First arrival marker (impact, else atmosphere entry) on body `bodyId` in a patch list. */
export function arrivalMarker(patches: readonly Patch[], bodyId: string): Marker | null {
  for (const p of patches) {
    if (p.bodyId !== bodyId) continue;
    for (const m of p.markers) {
      if ((m.kind === 'impact' || m.kind === 'atmosphereEntry') && m.latitude !== undefined && m.longitude !== undefined) return m;
    }
  }
  return null;
}

/**
 * Landing-target readout exactly as the contract documents it; null when `bodyId` has no 'landing' or
 * 'recovery' target. `subPointDirFixed` and `groundTrackDirFixed` are body-fixed (the latter horizontal,
 * or null when the surface speed is below 0.1 m/s).
 */
export function computeLandingTargetReadout(
  targets: readonly SurfaceTarget[],
  bodyId: string,
  subPointDirFixed: Vec3,
  groundTrackDirFixed: Vec3 | null,
  bodyRadius: number,
  currentPatches: readonly Patch[],
): LandingTargetReadout | null {
  const candidates = targets.filter((t) => t.bodyId === bodyId && (t.kind === 'landing' || t.kind === 'recovery'));
  if (candidates.length === 0) return null;
  const sub = v3.normalize(subPointDirFixed);
  const arrival = arrivalMarker(currentPatches, bodyId);
  const arrivalDir = arrival ? dirFromLatLon(arrival.latitude!, arrival.longitude!) : null;
  const ref = arrivalDir ?? sub;
  let best = candidates[0]!;
  let bestAngle = Infinity;
  for (const t of candidates) {
    const a = v3.angle(ref, targetDirection(t));
    if (a < bestAngle) {
      bestAngle = a;
      best = t;
    }
  }
  const tDir = targetDirection(best);
  const gc = greatCircle(sub, tDir);
  let downRange = 0;
  let crossRange = 0;
  if (groundTrackDirFixed && gc.angle > 0) {
    const enu = enuBasisFixed(sub);
    const track = v3.reject(groundTrackDirFixed, sub);
    if (v3.len(track) > 1e-12) {
      const trackBearing = Math.atan2(v3.dot(track, enu.east), v3.dot(track, enu.north));
      const D = gc.bearing - trackBearing;
      const sd = Math.sin(gc.angle);
      crossRange = bodyRadius * Math.asin(Math.max(-1, Math.min(1, sd * Math.sin(D))));
      downRange = bodyRadius * Math.atan2(sd * Math.cos(D), Math.cos(gc.angle));
    }
  }
  let predicted: LandingTargetReadout['predicted'] = null;
  if (arrival && arrivalDir) {
    const miss = greatCircle(tDir, arrivalDir);
    predicted = {
      kind: arrival.kind === 'impact' ? 'impact' : 'entry',
      ut: arrival.ut,
      latitude: arrival.latitude!,
      longitude: arrival.longitude!,
      missDistance: miss.angle * bodyRadius,
      missBearingDeg: miss.bearing * RAD,
    };
  }
  return {
    targetId: best.id,
    distance: gc.angle * bodyRadius,
    bearingDeg: gc.bearing * RAD,
    downRange,
    crossRange,
    predicted,
  };
}
