/**
 * Local solar time and the sun's elevation at a point of a body, from the snapshot's body pose (frontend-ux
 * fact 17: the pad's time of day follows the shared clock; every site card shows both). Pure: the body's
 * fixed-to-ROOT rotation and its sun direction are all it needs, so it works for any body and any site.
 */
import type { BodySnapshot } from '@/core/contracts/sim';
import { latLonToDir } from '@/core/geo/cubeSphere';
import { quat } from '@/core/math/quat';
import { DEG } from '@/core/math/scalar';
import { v3 } from '@/core/math/vec3';

export interface SolarView {
  /** Hours since local solar midnight, 0..24 (12 = the sun on the meridian). */
  localSolarHours: number;
  /** Elevation of the sun's centre above the local horizon, deg (the geometric horizon of the reference sphere). */
  sunElevationDeg: number;
  /** A word for the time of day: night, dawn, day or dusk (the sun within 6 deg of the horizon is dawn or dusk). */
  phase: 'night' | 'dawn' | 'day' | 'dusk';
}

/** Width of the twilight band either side of the horizon, deg (civil twilight). */
const TWILIGHT_DEG = 6;

export function solarViewAt(body: Pick<BodySnapshot, 'qFixedToRoot' | 'sunDir' | 'spinRoot'>, latDeg: number, lonDeg: number): SolarView {
  const upFixed = latLonToDir(latDeg * DEG, lonDeg * DEG);
  const up = quat.rotate(body.qFixedToRoot, upFixed);
  const sun = v3.normalize(body.sunDir);
  const sunElevationDeg = Math.asin(Math.max(-1, Math.min(1, v3.dot(up, sun)))) / DEG;
  // The sun's hour angle: its direction and the local vertical projected on the equatorial plane, the angle
  // between them about the spin axis (the body turns toward the east, so the sun moves west across the sky).
  const spinAxis = v3.len(body.spinRoot) > 0 ? v3.normalize(body.spinRoot) : quat.rotate(body.qFixedToRoot, v3.new(0, 0, 1));
  const sunEq = v3.sub(sun, v3.scale(spinAxis, v3.dot(sun, spinAxis)));
  const upEq = v3.sub(up, v3.scale(spinAxis, v3.dot(up, spinAxis)));
  let localSolarHours: number;
  if (v3.len(sunEq) < 1e-9 || v3.len(upEq) < 1e-9) {
    // At a pole (or with the sun on the axis) the hour angle is undefined: the meridian through the sun is noon.
    localSolarHours = 12;
  } else {
    const a = v3.normalize(upEq);
    const b = v3.normalize(sunEq);
    // Angle from the local meridian to the sun, positive when the sun is west of it (afternoon).
    const angle = Math.atan2(v3.dot(v3.cross(b, a), spinAxis), v3.dot(a, b));
    localSolarHours = (((12 + angle / (15 * DEG)) % 24) + 24) % 24;
  }
  const phase = sunElevationDeg > TWILIGHT_DEG ? 'day' : sunElevationDeg < -TWILIGHT_DEG ? 'night' : localSolarHours < 12 ? 'dawn' : 'dusk';
  return { localSolarHours, sunElevationDeg, phase };
}

/** "06:14" from hours. */
export function formatSolarClock(hours: number): string {
  const total = Math.round(hours * 60) % (24 * 60);
  const h = Math.floor(total / 60);
  const m = total % 60;
  return `${h < 10 ? '0' : ''}${h}:${m < 10 ? '0' : ''}${m}`;
}
