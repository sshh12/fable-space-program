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

/**
 * Size of the target in device pixels; `pxScale` = device pixels per INTERFACE pixel (every pixel constant of
 * the map: line widths, icons, labels, the gizmo), `cssScale` = device pixels per CSS pixel (the pointer, the
 * DOM panel, describe()). They differ by the interface scale (`uiScale`), which follows the flight HUD's unit
 * (one hundredth of the height of a 16:9 frame): 1 at 1280 x 720, 1.5 at 1920 x 1080 CSS px. Without
 * `cssScale` the two are equal (interface scale 1).
 */
export interface Viewport {
  width: number;
  height: number;
  pxScale: number;
  cssScale?: number;
}

const UI_SCALE_STEPS = 16;

/**
 * Interface scale of a canvas of `cssWidth` x `cssHeight` CSS px: the flight HUD's unit
 * `min(1vh, 0.5625vw)` (src/ui/hud/hudStyles.ts) relative to 720p, so map labels, icons, the gizmo and the
 * node panel keep their size relative to the HUD panels beside them at every resolution. Floored at 0.8 (the
 * HUD's smallest text, 10 px at 720p, would fall under 8 px) and quantised to steps of 1/16 (exact at 720p,
 * 1080p and 4K; while a window is resized the glyph atlas is rebuilt only at those steps).
 */
export function uiScale(cssWidth: number, cssHeight: number): number {
  const raw = Math.max(0.8, Math.min(cssHeight, 0.5625 * cssWidth) / 720);
  if (!Number.isFinite(raw)) return 1;
  return Math.round(raw * UI_SCALE_STEPS) / UI_SCALE_STEPS;
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
  /** Device px per interface px (pixel constants of the map). */
  readonly pxScale: number;
  /** Device px per CSS px (pointer, DOM, describe()). */
  readonly cssScale: number;
  /** Device pixels per unit of tan(angle) from the view axis (focal length in pixels). */
  readonly focal: number;
  readonly cx: number;
  readonly cy: number;
  readonly near = NEAR_PLANE;
  readonly tanHalfX: number;
  readonly tanHalfY: number;
  readonly fovY: number;
  /** ROOT -> view rotation, row-major. */
  private readonly m00: number;
  private readonly m01: number;
  private readonly m02: number;
  private readonly m10: number;
  private readonly m11: number;
  private readonly m12: number;
  private readonly m20: number;
  private readonly m21: number;
  private readonly m22: number;

  constructor(camera: CameraState, viewport: Viewport) {
    this.eye = { x: camera.positionRoot.x, y: camera.positionRoot.y, z: camera.positionRoot.z };
    this.width = viewport.width;
    this.height = viewport.height;
    this.pxScale = viewport.pxScale;
    this.cssScale = viewport.cssScale ?? viewport.pxScale;
    this.fovY = camera.fovY;
    const t = Math.tan(camera.fovY / 2);
    this.focal = this.height / 2 / t;
    this.cx = this.width / 2;
    this.cy = this.height / 2;
    this.tanHalfY = t;
    this.tanHalfX = (t * this.width) / this.height;
    // R(view -> root) from the quaternion; its transpose maps ROOT components into view space.
    const { x, y, z, w } = camera.qViewToRoot;
    this.m00 = 1 - 2 * (y * y + z * z);
    this.m01 = 2 * (x * y + w * z);
    this.m02 = 2 * (x * z - w * y);
    this.m10 = 2 * (x * y - w * z);
    this.m11 = 1 - 2 * (x * x + z * z);
    this.m12 = 2 * (y * z + w * x);
    this.m20 = 2 * (x * z + w * y);
    this.m21 = 2 * (y * z - w * x);
    this.m22 = 1 - 2 * (x * x + y * y);
  }

  /** Rotate a camera-relative ROOT vector into view space. */
  rotate(v: Vec3, out: Vec3 = { x: 0, y: 0, z: 0 }): Vec3 {
    const x = this.m00 * v.x + this.m01 * v.y + this.m02 * v.z;
    const y = this.m10 * v.x + this.m11 * v.y + this.m12 * v.z;
    const z = this.m20 * v.x + this.m21 * v.y + this.m22 * v.z;
    out.x = x;
    out.y = y;
    out.z = z;
    return out;
  }

  /** ROOT position -> view space (float64: subtract the eye first, then rotate). */
  toView(p: Vec3, out: Vec3 = { x: 0, y: 0, z: 0 }): Vec3 {
    const dx = p.x - this.eye.x;
    const dy = p.y - this.eye.y;
    const dz = p.z - this.eye.z;
    out.x = this.m00 * dx + this.m01 * dy + this.m02 * dz;
    out.y = this.m10 * dx + this.m11 * dy + this.m12 * dz;
    out.z = this.m20 * dx + this.m21 * dy + this.m22 * dz;
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

  /** Is a screen point inside the viewport enlarged by `margin` device pixels? */
  onScreen(x: number, y: number, margin = 0): boolean {
    return x >= -margin && y >= -margin && x <= this.width + margin && y <= this.height + margin;
  }

  /** Projection matrix (view space -> clip) for the GPU; same as the engine's reversed-Z infinite projection. */
  projectionMatrix(): Mat4 {
    return (this.projection ??= mat4.perspectiveReversedZInfinite(this.fovY, this.width / this.height, this.near));
  }

  private projection: Mat4 | null = null;
}
