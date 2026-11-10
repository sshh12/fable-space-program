/** CameraState helpers for map tests and the map lab (look-at and orbit-about-a-point cameras). */
import type { CameraState } from '@/core/contracts/render';
import { quat } from '@/core/math/quat';
import { v3, type Vec3 } from '@/core/math/vec3';

export function lookAtCamera(eye: Vec3, target: Vec3, fovY = (50 * Math.PI) / 180, upHint: Vec3 = { x: 0, y: 0, z: 1 }): CameraState {
  const f = v3.normalize(v3.sub(target, eye));
  let right = v3.cross(f, upHint);
  if (v3.len(right) < 1e-9) right = v3.anyOrthogonal(f);
  right = v3.normalize(right);
  const up = v3.cross(right, f);
  return mapCamera(eye, quat.fromBasis(right, up, v3.neg(f)), fovY);
}

/**
 * Camera orbiting `focus`: offset direction (cos pitch cos yaw, cos pitch sin yaw, sin pitch) in ROOT axes,
 * at `distance`, looking at the focus with ROOT +Z up (continuous through the poles).
 */
export function orbitCamera(focus: Vec3, yaw: number, pitch: number, distance: number, fovY = (50 * Math.PI) / 180): CameraState {
  const d = { x: Math.cos(pitch) * Math.cos(yaw), y: Math.cos(pitch) * Math.sin(yaw), z: Math.sin(pitch) };
  const right = { x: -Math.sin(yaw), y: Math.cos(yaw), z: 0 };
  const f = v3.neg(d);
  const up = v3.cross(right, f);
  return mapCamera(v3.addScaled(focus, d, distance), quat.fromBasis(right, up, d), fovY);
}

export function mapCamera(eye: Vec3, qViewToRoot: CameraState['qViewToRoot'], fovY: number): CameraState {
  return {
    mode: 'map',
    kind: 'map',
    positionRoot: eye,
    qViewToRoot,
    fovY,
    insideVesselId: null,
    focusVesselId: null,
    focusBodyId: null,
    exposureCompensation: 0,
    minEv100: null,
    fillLight: 0.005,
  };
}
