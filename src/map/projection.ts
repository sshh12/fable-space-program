/**
 * Float64 camera projection shared by drawing and hit-testing. Everything the map view places on screen
 * goes through one Projector built from the CameraState of the frame, so what is drawn and what the
 * pointer is tested against are the same numbers.
 *
 * Conventions (docs/ARCHITECTURE.md sections 3 and 4): positions are ROOT-frame float64; the camera eye is
 * the origin of "view" space (+X right, +Y up, looking down -Z); the projection is
 * mat4.perspectiveReversedZInfinite(fovY, aspect, NEAR_PLANE). Screen coordinates are device pixels with
 * the origin at the top-left corner and +y down (the framebuffer convention of WebGPU).
 */
import type { CameraState } from '@/core/contracts/render';
import { NEAR_PLANE } from '@/core/contracts/render';
import { mat4, type Mat4 } from '@/core/math/mat';
import type { Vec3 } from '@/core/math/vec3';

/** Size of the target in device pixels and the number of device pixels per CSS pixel. */
export interface Viewport {
  width: number;
  height: number;
  pxScale: number;
}

export interface ScreenPoint {
  x: number;
  y: number;
  /** Distance along the view axis (-z of view space), metres. */
  depth: number;
  /** True when the point lies in front of the near plane. */
  front: boolean;
}

export class Projector {
  readonly eye: Vec3;
  readonly width: number;
  readonly height: number;
  readonly pxScale: number;
  /** Device pixels per unit of tan(angle) from the view axis (focal length in pixels). */
  readonly focal: number;
  readonly cx: number;
  readonly cy: number;
  readonly near = NEAR_PLANE;
  readonly tanHalfX: number;
  readonly tanHalfY: number;
  readonly fovY: number;
  /** ROOT -> view rotation, row-major. */
  private readonly m: Float64Array;

  constructor(camera: CameraState, viewport: Viewport) {
    this.eye = { x: camera.positionRoot.x, y: camera.positionRoot.y, z: camera.positionRoot.z };
    this.width = viewport.width;
    this.height = viewport.height;
    this.pxScale = viewport.pxScale;
    this.fovY = camera.fovY;
    const t = Math.tan(camera.fovY / 2);
    this.focal = this.height / 2 / t;
    this.cx = this.width / 2;
    this.cy = this.height / 2;
    this.tanHalfY = t;
    this.tanHalfX = (t * this.width) / this.height;
    // R(view -> root) from the quaternion; its transpose maps ROOT components into view space.
    const q = camera.qViewToRoot;
    const { x, y, z, w } = q;
    const r00 = 1 - 2 * (y * y + z * z);
    const r01 = 2 * (x * y - w * z);
    const r02 = 2 * (x * z + w * y);
    const r10 = 2 * (x * y + w * z);
    const r11 = 1 - 2 * (x * x + z * z);
    const r12 = 2 * (y * z - w * x);
    const r20 = 2 * (x * z - w * y);
    const r21 = 2 * (y * z + w * x);
    const r22 = 1 - 2 * (x * x + y * y);
    this.m = new Float64Array([r00, r10, r20, r01, r11, r21, r02, r12, r22]);
  }

  /** Rotate a camera-relative ROOT vector into view space. */
  rotate(v: Vec3, out: Vec3 = { x: 0, y: 0, z: 0 }): Vec3 {
    const m = this.m;
    const x = m[0]! * v.x + m[1]! * v.y + m[2]! * v.z;
    const y = m[3]! * v.x + m[4]! * v.y + m[5]! * v.z;
    const z = m[6]! * v.x + m[7]! * v.y + m[8]! * v.z;
    out.x = x;
    out.y = y;
    out.z = z;
    return out;
  }

  /** Rotate a view-space vector back into ROOT axes. */
  unrotate(v: Vec3): Vec3 {
    const m = this.m;
    return {
      x: m[0]! * v.x + m[3]! * v.y + m[6]! * v.z,
      y: m[1]! * v.x + m[4]! * v.y + m[7]! * v.z,
      z: m[2]! * v.x + m[5]! * v.y + m[8]! * v.z,
    };
  }

  /** ROOT position -> view space (float64: subtract the eye first, then rotate). */
  toView(p: Vec3, out: Vec3 = { x: 0, y: 0, z: 0 }): Vec3 {
    const dx = p.x - this.eye.x;
    const dy = p.y - this.eye.y;
    const dz = p.z - this.eye.z;
    const m = this.m;
    out.x = m[0]! * dx + m[1]! * dy + m[2]! * dz;
    out.y = m[3]! * dx + m[4]! * dy + m[5]! * dz;
    out.z = m[6]! * dx + m[7]! * dy + m[8]! * dz;
    return out;
  }

  /** View-space point -> screen. Points at or behind the near plane are flagged (their x/y are not meaningful). */
  projectView(v: Vec3): ScreenPoint {
    const depth = -v.z;
    if (!(depth > this.near)) return { x: NaN, y: NaN, depth, front: false };
    const k = this.focal / depth;
    return { x: this.cx + v.x * k, y: this.cy - v.y * k, depth, front: true };
  }

  projectRoot(p: Vec3): ScreenPoint {
    return this.projectView(this.toView(p));
  }

  /** Unit view-space direction of the ray through a screen point. */
  rayView(sx: number, sy: number): Vec3 {
    const x = (sx - this.cx) / this.focal;
    const y = -(sy - this.cy) / this.focal;
    const l = Math.hypot(x, y, 1);
    return { x: x / l, y: y / l, z: -1 / l };
  }

  /** Is a screen point inside the viewport enlarged by `margin` device pixels? */
  onScreen(x: number, y: number, margin = 0): boolean {
    return x >= -margin && y >= -margin && x <= this.width + margin && y <= this.height + margin;
  }

  /** Projection matrix (view space -> clip) for the GPU; same as the engine's reversed-Z infinite projection. */
  projectionMatrix(): Mat4 {
    return mat4.perspectiveReversedZInfinite(this.fovY, this.width / this.height, this.near);
  }
}
