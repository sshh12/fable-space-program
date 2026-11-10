/**
 * Body-relative frames (docs/ARCHITECTURE.md section 3): BCI <-> BCBF, planetocentric latitude /
 * longitude / altitude, the local ENU horizon basis, surface-relative velocity.
 *
 * Conventions: `qFixedToInertial` maps BCBF components to BCI components (v_BCI = rotate(q, v_BCBF)).
 * Latitude is planetocentric, longitude east-positive in (-pi, pi], altitude above the reference radius.
 */
import { quat, type Quat } from '../../core/math/quat';
import { v3, type Vec3 } from '../../core/math/vec3';
import type { BodySystem } from '../bodies/bodySystem';

export const inertialToFixed = (qFixedToInertial: Quat, vInertial: Vec3): Vec3 => quat.rotateInv(qFixedToInertial, vInertial);
export const fixedToInertial = (qFixedToInertial: Quat, vFixed: Vec3): Vec3 => quat.rotate(qFixedToInertial, vFixed);

export interface LatLonAlt {
  latitude: number;
  longitude: number;
  altitude: number;
}

/** Latitude / longitude / altitude of a body-fixed position. */
export function latLonAlt(rFixed: Vec3, radius: number): LatLonAlt {
  return {
    latitude: Math.atan2(rFixed.z, Math.hypot(rFixed.x, rFixed.y)),
    longitude: Math.atan2(rFixed.y, rFixed.x),
    altitude: v3.len(rFixed) - radius,
  };
}

/** Unit body-fixed direction of a latitude/longitude. */
export function dirFromLatLon(latitude: number, longitude: number): Vec3 {
  const c = Math.cos(latitude);
  return { x: c * Math.cos(longitude), y: c * Math.sin(longitude), z: Math.sin(latitude) };
}

/** Body-fixed position at latitude/longitude and distance `radius` from the centre. */
export function fixedPosition(latitude: number, longitude: number, radius: number): Vec3 {
  return v3.scale(dirFromLatLon(latitude, longitude), radius);
}

export interface EnuBasis {
  east: Vec3;
  north: Vec3;
  up: Vec3;
}

/**
 * ENU basis at the point above `r` (any frame) given the spin axis `pole` in the same frame:
 * up = r/|r|, east = normalize(pole x up), north = up x east. At a pole (pole parallel to up) east is
 * taken as `fallbackEast` projected into the horizontal plane (the BCBF +Y axis is used by the callers
 * below, i.e. the east direction of longitude 0), so the basis is always defined.
 */
export function enuFromPole(r: Vec3, pole: Vec3, fallbackEast: Vec3): EnuBasis {
  const up = v3.normalize(r);
  let east = v3.cross(pole, up);
  if (v3.len(east) < 1e-12) {
    east = v3.reject(fallbackEast, up);
    east = v3.len(east) < 1e-12 ? v3.anyOrthogonal(up) : east;
  }
  east = v3.normalize(east);
  return { east, north: v3.cross(up, east), up };
}

/** ENU basis in BCI axes at a BCI position, for a body with orientation `qFixedToInertial`. */
export function enuBasis(qFixedToInertial: Quat, rInertial: Vec3): EnuBasis {
  const pole = quat.rotate(qFixedToInertial, { x: 0, y: 0, z: 1 });
  const yAxis = quat.rotate(qFixedToInertial, { x: 0, y: 1, z: 0 });
  return enuFromPole(rInertial, pole, yAxis);
}

/** ENU basis in BCBF axes at a body-fixed direction. */
export function enuBasisFixed(rFixed: Vec3): EnuBasis {
  return enuFromPole(rFixed, { x: 0, y: 0, z: 1 }, { x: 0, y: 1, z: 0 });
}

/** ENU -> BCI quaternion (components of the local horizon axes expressed in BCI). */
export function qEnuToInertial(basis: EnuBasis): Quat {
  return quat.fromBasis(basis.east, basis.north, basis.up);
}

/** Velocity relative to the rotating surface (and the co-rotating atmosphere): v - spin x r. */
export function surfaceVelocity(r: Vec3, v: Vec3, spin: Vec3): Vec3 {
  return v3.sub(v, v3.cross(spin, r));
}

/** Inertial velocity of a point fixed to the body at BCI position r: spin x r. */
export function corotationVelocity(r: Vec3, spin: Vec3): Vec3 {
  return v3.cross(spin, r);
}

/** Compass azimuth (rad, [0, 2 pi), clockwise from north) of a direction in an ENU basis. */
export function azimuthOf(dir: Vec3, b: EnuBasis): number {
  const a = Math.atan2(v3.dot(dir, b.east), v3.dot(dir, b.north));
  return a < 0 ? a + 2 * Math.PI : a;
}

/** Horizontal unit direction of a compass azimuth (rad) in an ENU basis. */
export function directionOfAzimuth(azimuth: number, b: EnuBasis): Vec3 {
  return v3.add(v3.scale(b.east, Math.sin(azimuth)), v3.scale(b.north, Math.cos(azimuth)));
}

// ------------------------------------------------------------------------- body-system convenience forms

/** BCI position -> BCBF position of body `bodyId` at ut. */
export function bciToBcbf(system: BodySystem, bodyId: string, ut: number, rInertial: Vec3): Vec3 {
  return inertialToFixed(system.orientation(bodyId, ut), rInertial);
}

/** BCBF position -> BCI position of body `bodyId` at ut. */
export function bcbfToBci(system: BodySystem, bodyId: string, ut: number, rFixed: Vec3): Vec3 {
  return fixedToInertial(system.orientation(bodyId, ut), rFixed);
}

/** Latitude / longitude / altitude of a BCI position over body `bodyId` at ut (body rotation included). */
export function latLonAltAt(system: BodySystem, bodyId: string, ut: number, rInertial: Vec3): LatLonAlt {
  return latLonAlt(bciToBcbf(system, bodyId, ut, rInertial), system.body(bodyId).radius);
}
