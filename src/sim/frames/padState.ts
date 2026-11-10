/**
 * State of a vessel standing on a launch pad (LaunchSiteDef): position, co-rotating velocity and the
 * pad attitude. On the pad the nose (+Y) points up (geocentric vertical) and the ventral side (-Z) faces
 * `padAzimuthDeg`, so pitching down tips the nose down-range (ARCHITECTURE section 3, control signs).
 */
import type { LaunchSiteDef } from '../../core/contracts/defs';
import { quat, type Quat } from '../../core/math/quat';
import { DEG } from '../../core/math/scalar';
import { v3, type Vec3 } from '../../core/math/vec3';
import type { BodySystem } from '../bodies/bodySystem';
import { corotationVelocity, directionOfAzimuth, enuBasis, fixedPosition, type EnuBasis } from './bodyFrames';

/**
 * Pad elevation above the reference radius: the definition's number, or - when the definition says
 * 'terrain' - the caller-supplied natural terrain height at the pad centre (from the TerrainProvider).
 * Throws when the definition says 'terrain' and no value is supplied.
 */
export function resolvePadElevation(site: LaunchSiteDef, terrainElevation?: number): number {
  const e = site.location.padElevation;
  if (typeof e === 'number') return e;
  if (terrainElevation === undefined || !Number.isFinite(terrainElevation)) {
    throw new Error(`sites/${site.id}.json: padElevation is 'terrain'; the caller must supply the terrain height at the pad`);
  }
  return terrainElevation;
}

export interface PadState {
  bodyId: string;
  /** Planetocentric latitude / east longitude of the pad centre, rad. */
  latitude: number;
  longitude: number;
  /** Pad surface elevation above the reference radius, m. */
  elevation: number;
  /** Body-fixed position of the reference point (pad surface + heightAbovePad along the vertical). */
  rFixed: Vec3;
  /** Same point in BCI(bodyId) and its co-rotating inertial velocity. */
  r: Vec3;
  v: Vec3;
  /** VES -> BCI attitude (nose up, ventral toward padAzimuthDeg) and VES -> BCBF. */
  q: Quat;
  qFixed: Quat;
  /** Local horizon basis in BCI axes. */
  enu: EnuBasis;
  /** Compass azimuth the ventral side faces, rad. */
  azimuth: number;
}

/**
 * Pad state at `ut`. `padElevation` comes from resolvePadElevation; `heightAbovePad` lifts the reference
 * point (e.g. the vessel root part origin) above the pad surface.
 */
export function padState(system: BodySystem, site: LaunchSiteDef, ut: number, padElevation: number, heightAbovePad = 0): PadState {
  const body = system.body(site.bodyId);
  const latitude = site.location.latDeg * DEG;
  const longitude = site.location.lonDeg * DEG;
  const rFixed = fixedPosition(latitude, longitude, body.radius + padElevation + heightAbovePad);
  const qFixedToInertial = system.orientation(site.bodyId, ut);
  const r = quat.rotate(qFixedToInertial, rFixed);
  const v = corotationVelocity(r, system.spin(site.bodyId));
  const enu = enuBasis(qFixedToInertial, r);
  const azimuth = site.padAzimuthDeg * DEG;
  const yAxis = enu.up;
  const zAxis = v3.neg(directionOfAzimuth(azimuth, enu));
  const xAxis = v3.cross(yAxis, zAxis);
  const q = quat.fromBasis(xAxis, yAxis, zAxis);
  return {
    bodyId: site.bodyId,
    latitude,
    longitude,
    elevation: padElevation,
    rFixed,
    r,
    v,
    q,
    qFixed: quat.normalize(quat.mul(quat.conj(qFixedToInertial), q)),
    enu,
    azimuth,
  };
}
