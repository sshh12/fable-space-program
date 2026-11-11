/**
 * Target geometry of the mission pilot, worked out from the snapshot (bodies, surface targets, patches):
 *  - where and when a lunar orbit passes over the landing target, and by how much it misses it sideways;
 *  - where a returning capsule comes down: the atmosphere-entry marker of the predicted trajectory carried
 *    along the entry ground track by the nominal lifting-entry down-range, and its distance from the
 *    recovery zones.
 */
import type { BodySnapshot, Marker, Patch, SurfaceTarget } from '@/core/contracts/sim';
import { conicPosition, conicVelocity, type ConicElements } from '@/core/math/conic';
import { quat } from '@/core/math/quat';
import { TWO_PI } from '@/core/math/scalar';
import { v3, type Vec3 } from '@/core/math/vec3';
import { arc, dirFromLatLon, horizonBasis, latLonOfDir, orientationAt, travel } from './math';

export interface PassOver {
  /** Time the orbit passes abeam of the target, s. */
  ut: number;
  /** Signed offset of the target from the ground track (positive toward the orbit normal): an angle (rad) from passOver, metres from the patch helpers. */
  crossTrack: number;
  /** Unit direction of the target at that time, inertial axes of the body. */
  targetDir: Vec3;
}

/**
 * The first pass of a circular orbit (plane normal W, position direction P0 at time t0, angular rate n in
 * the direction W x P0) over a surface target of a uniformly rotating body, at or after `tMin`.
 */
export function passOver(W: Vec3, P0: Vec3, t0: number, n: number, body: BodySnapshot, snapshotUt: number, target: SurfaceTarget, tMin: number): PassOver {
  const Q0 = v3.cross(W, P0);
  const dirFixed = dirFromLatLon(target.latitude, target.longitude);
  const targetAt = (t: number): Vec3 => quat.rotate(orientationAt(body, snapshotUt, t), dirFixed);
  const period = TWO_PI / n;
  // Angle of the vessel from P0 at tMin, then the first time its in-plane angle meets the target's.
  let t = tMin;
  for (let i = 0; i < 12; i++) {
    const d = targetAt(t);
    const phiT = Math.atan2(v3.dot(d, Q0), v3.dot(d, P0));
    const theta = n * (tMin - t0);
    let ahead = (phiT - theta) % TWO_PI;
    if (ahead < 0) ahead += TWO_PI;
    const tNew = tMin + ahead / n;
    // The target drifts slowly with the body's rotation: a pass that slipped just behind tMin belongs to the next revolution.
    if (Math.abs(tNew - t) < 1e-3) {
      t = tNew;
      break;
    }
    t = tNew;
  }
  if (t < tMin) t += period;
  const d = targetAt(t);
  return { ut: t, crossTrack: Math.asin(Math.max(-1, Math.min(1, v3.dot(d, W)))), targetDir: d };
}

/** passOver for the orbit of a closed patch (taken as circular at its mean motion), returning metres with the body radius. */
export function patchPassOver(c: ConicElements, body: BodySnapshot, bodyRadius: number, snapshotUt: number, target: SurfaceTarget, tMin: number): PassOver {
  const period = c.period ?? TWO_PI * Math.sqrt((c.p * c.p * c.p) / c.mu);
  const n = TWO_PI / period;
  // Position direction at tMin from the mean anomaly (the orbits used here are within a few percent of circular).
  const M = n * (tMin - c.tPeriapsis);
  const nu = M + 2 * c.e * Math.sin(M);
  const P0 = v3.normalize(conicPosition(c, nu));
  const p = passOver(c.W, P0, tMin, n, body, snapshotUt, target, tMin);
  return { ...p, crossTrack: p.crossTrack * bodyRadius };
}

/**
 * Pass-over for an arrival hyperbola that will be circularised at its periapsis: the circular orbit in the
 * hyperbola's plane starting at the periapsis direction at `tPeriapsis`.
 */
export function arrivalPassOver(c: ConicElements, body: BodySnapshot, bodyRadius: number, snapshotUt: number, target: SurfaceTarget, minLead: number): PassOver {
  const rp = c.p / (1 + c.e);
  const n = Math.sqrt(c.mu / (rp * rp * rp));
  const p = passOver(c.W, c.P, c.tPeriapsis, n, body, snapshotUt, target, c.tPeriapsis + minLead);
  return { ...p, crossTrack: p.crossTrack * bodyRadius };
}

export interface SplashPrediction {
  /** Predicted splash point, body-fixed. */
  latitude: number;
  longitude: number;
  /** Entry interface point (the atmosphereEntry marker). */
  entryLatitude: number;
  entryLongitude: number;
  entryUt: number;
  vacuumPerigeeAltitude: number;
  /** Compass heading of the entry ground track, rad. */
  heading: number;
}

/** The marker of a patch that says where on the ground it arrives: latitude and longitude as the map shows them. */
function arrivalPoint(p: Patch): (Marker & { latitude: number; longitude: number }) | undefined {
  const located = (m: Marker): m is Marker & { latitude: number; longitude: number } => m.latitude !== undefined && m.longitude !== undefined;
  for (const kind of ['atmosphereEntry', 'impact', 'periapsis'] as const) {
    const m = p.markers.find((x) => x.kind === kind);
    if (m && located(m)) return m;
  }
  return undefined;
}

/**
 * Splash point of a predicted return to `body`: the latitude and longitude of the atmosphereEntry marker
 * of the arriving patch (where the trajectory comes down through the top of the atmosphere, the body's
 * rotation until then included), advanced by `downRange(heading)` metres along the ground track there (the
 * surface-relative velocity direction at the marker; the body's rotation during the descent is in that
 * direction already to first order). For a trajectory whose perigee is still above the atmosphere the
 * periapsis marker takes the place of the entry marker, so that the prediction stays continuous while a
 * correction is being dragged through the atmosphere's edge.
 */
export function predictSplash(patches: readonly Patch[], body: BodySnapshot, bodyRadius: number, downRange: (heading: number) => number): SplashPrediction | null {
  let patch: Patch | undefined;
  for (const p of patches) {
    if (p.bodyId !== body.id) continue;
    if (p.endReason === 'atmosphere' || p.endReason === 'impact' || p.markers.some((m) => m.kind === 'periapsis')) {
      patch = p;
      break;
    }
  }
  if (!patch) return null;
  const c = patch.conic;
  if (!(c.p > 0)) return null;
  const marker = arrivalPoint(patch);
  if (!marker) return null;
  // Compass heading of the ground track at the marker: the velocity there relative to the turning surface.
  const nu = Math.atan2(v3.dot(marker.r, c.Q), v3.dot(marker.r, c.P));
  const surf = v3.sub(conicVelocity(c, nu), v3.cross(body.spinRoot, marker.r));
  const pole = v3.len(body.spinRoot) > 0 ? v3.normalize(body.spinRoot) : { x: 0, y: 0, z: 1 };
  const local = horizonBasis(marker.r, pole);
  const heading = Math.atan2(v3.dot(surf, local.east), v3.dot(surf, local.north));
  // The same heading from the marker's point on the body-fixed globe.
  const entryDir = dirFromLatLon(marker.latitude, marker.longitude);
  const fixed = horizonBasis(entryDir, { x: 0, y: 0, z: 1 });
  const track = v3.add(v3.scale(fixed.north, Math.cos(heading)), v3.scale(fixed.east, Math.sin(heading)));
  const ll = latLonOfDir(travel(entryDir, track, downRange(heading) / bodyRadius));
  return {
    latitude: ll.latitude,
    longitude: ll.longitude,
    entryLatitude: marker.latitude,
    entryLongitude: marker.longitude,
    entryUt: marker.ut,
    vacuumPerigeeAltitude: c.p / (1 + c.e) - bodyRadius,
    heading,
  };
}

export interface ZoneMiss {
  zone: SurfaceTarget;
  /** Distance from the zone centre, m, and the same as a fraction of the zone radius. */
  distance: number;
  fraction: number;
}

/** Distance of a body-fixed point from every recovery zone on `bodyId`, nearest (by fraction of its radius) first. */
export function zoneMisses(targets: readonly SurfaceTarget[], bodyId: string, bodyRadius: number, latitude: number, longitude: number): ZoneMiss[] {
  const d = dirFromLatLon(latitude, longitude);
  const out: ZoneMiss[] = [];
  for (const t of targets) {
    if (t.kind !== 'recovery' || t.bodyId !== bodyId) continue;
    const distance = arc(d, dirFromLatLon(t.latitude, t.longitude)) * bodyRadius;
    out.push({ zone: t, distance, fraction: t.radius > 0 ? distance / t.radius : Infinity });
  }
  out.sort((a, b) => a.fraction - b.fraction);
  return out;
}

/** Sun elevation (rad) at a body-fixed point at time t, from the body's snapshot (the Sun's direction changes by a degree a day). */
export function sunElevation(body: BodySnapshot, snapshotUt: number, latitude: number, longitude: number, t: number): number {
  const up = quat.rotate(orientationAt(body, snapshotUt, t), dirFromLatLon(latitude, longitude));
  return Math.asin(Math.max(-1, Math.min(1, v3.dot(up, body.sunDir))));
}
