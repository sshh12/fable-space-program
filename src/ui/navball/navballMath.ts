/**
 * Navball geometry, shared by the WebGPU renderer (which evaluates the same formulas per pixel / per marker)
 * and the tests.
 *
 * The ball is viewed from behind the vessel along its nose: screen right = VES +X (starboard), screen up =
 * VES +Z (dorsal), into the screen = VES +Y (nose). The point of the ball at normalised screen position
 * (sx, sy) inside the unit disc shows the direction  d_VES = (sx, sqrt(1 - sx^2 - sy^2), sy),  i.e. the
 * hemisphere in front of the nose seen orthographically, with the texture fixed in the local horizon frame
 * (ENU: +X east, +Y north, +Z up): d_horizon = rotate(qVesselToHorizon, d_VES). The centre of the ball (the
 * reticle) therefore shows where the nose points, and a navball marker given in VES lies at (d.x, d.z) when
 * d.y > 0 (on the visible hemisphere).
 */
import type { Quat } from '@/core/math/quat';
import { quat } from '@/core/math/quat';
import type { Vec3 } from '@/core/math/vec3';

/** Ball radius as a fraction of half the render target (margin for edge anti-aliasing and limb markers). */
export const BALL_RADIUS_FRACTION = 0.93;

/** Half-size of a marker icon in normalised ball units (fraction of the ball radius). */
export const MARKER_HALF_SIZE = 0.19;

/** Equirectangular ball texture: u = heading / 360 deg (north at u = 0, east at 0.25), v = (90 - pitch) / 180. */
export const BALL_TEXTURE_SIZE: [number, number] = [2048, 1024];

export interface ProjectedMarker {
  /** Normalised ball coordinates (unit disc), +y up. */
  sx: number;
  sy: number;
  /** Pixel position in a square target of `sizePx` (y down), using BALL_RADIUS_FRACTION. */
  px: number;
  py: number;
  /** On the visible (forward) hemisphere. */
  visible: boolean;
  /** 0..1 fade toward the limb. */
  alpha: number;
}

/** Fade of a marker approaching the limb: 0 behind, 1 once its forward component exceeds 0.12. */
export function limbFade(forward: number): number {
  const t = Math.max(0, Math.min(1, forward / 0.12));
  return t * t * (3 - 2 * t);
}

/** Screen position of a VES-frame unit direction on a navball rendered into a sizePx x sizePx target. */
export function projectMarker(dirVes: Vec3, sizePx: number): ProjectedMarker {
  const half = sizePx / 2;
  const R = BALL_RADIUS_FRACTION * half;
  return {
    sx: dirVes.x,
    sy: dirVes.z,
    px: half + dirVes.x * R,
    py: half - dirVes.z * R,
    visible: dirVes.y > 0,
    alpha: limbFade(dirVes.y),
  };
}

/** VES direction shown at normalised ball position (sx, sy); null outside the disc. */
export function ballDirectionVes(sx: number, sy: number): Vec3 | null {
  const r2 = sx * sx + sy * sy;
  if (r2 > 1) return null;
  return { x: sx, y: Math.sqrt(1 - r2), z: sy };
}

/** Horizon-frame (ENU) direction shown at normalised ball position (sx, sy) for a vessel attitude. */
export function ballDirectionHorizon(sx: number, sy: number, qVesselToHorizon: Quat): Vec3 | null {
  const d = ballDirectionVes(sx, sy);
  return d ? quat.rotate(qVesselToHorizon, d) : null;
}

/** Pitch (elevation above the horizon) and compass heading of a horizon-frame direction, degrees. */
export function pitchHeadingOf(dHorizon: Vec3): { pitchDeg: number; headingDeg: number } {
  const pitchDeg = (Math.asin(Math.max(-1, Math.min(1, dHorizon.z))) * 180) / Math.PI;
  const headingDeg = (((Math.atan2(dHorizon.x, dHorizon.y) * 180) / Math.PI) % 360 + 360) % 360;
  return { pitchDeg, headingDeg };
}

/** Texture coordinates (u, v) of the ball texture for a horizon-frame direction. */
export function ballTextureUv(dHorizon: Vec3): [number, number] {
  const { pitchDeg, headingDeg } = pitchHeadingOf(dHorizon);
  return [headingDeg / 360, (90 - pitchDeg) / 180];
}
