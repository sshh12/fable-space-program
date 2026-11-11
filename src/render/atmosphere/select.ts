/**
 * Per-frame CPU selection for the atmosphere feature (pure float64, unit-tested): which frame bodies have
 * an atmosphere and which of them are worth marching this frame, how many march samples each gets, and the
 * screen rectangle that their shells can touch.
 */
import type { DefLibrary } from '@/core/contracts/defs';
import type { BodyPose } from '@/core/contracts/render';
import { v3, type Vec3 } from '@/core/math';

export interface AtmosphereLayer {
  /** Index into FrameContext.bodies (and frame.bodies in WGSL). */
  bodyIndex: number;
  /** Layer of the body's tables: its rank among the frame bodies that have an atmosphere. */
  layer: number;
  bodyId: string;
}

/** Frame bodies with an atmosphere, in frame order: the table layers. */
export function atmosphereLayers(bodies: readonly BodyPose[], defs: DefLibrary, maxBodies: number): AtmosphereLayer[] {
  const out: AtmosphereLayer[] = [];
  for (let i = 0; i < Math.min(maxBodies, bodies.length); i++) {
    const def = defs.bodies[bodies[i]!.id];
    if (def?.render.atmosphere) out.push({ bodyIndex: i, layer: out.length, bodyId: def.id });
  }
  return out;
}

export interface ViewFrustum {
  right: Vec3;
  up: Vec3;
  forward: Vec3;
  tanHalfFovX: number;
  tanHalfFovY: number;
}

/** NDC rectangle [x0, y0, x1, y1] (y up) that the sphere can cover, null when it is outside the view, 'full' when the eye is inside. */
export function sphereScreenBounds(centerRelCam: Vec3, radius: number, view: ViewFrustum): [number, number, number, number] | null | 'full' {
  const cx = v3.dot(centerRelCam, view.right);
  const cy = v3.dot(centerRelCam, view.up);
  const cz = v3.dot(centerRelCam, view.forward);
  if (cx * cx + cy * cy + cz * cz <= radius * radius) return 'full';
  const axis = (c: number, tanHalf: number): [number, number] | null | 'full' => {
    const d = Math.hypot(c, cz);
    if (d <= radius) return 'full';
    const centre = Math.atan2(c, cz);
    const half = Math.asin(radius / d);
    const lo = centre - half;
    const hi = centre + half;
    const limit = Math.PI / 2 - 1e-4;
    if (lo >= limit || hi <= -limit) return null;
    const a = lo <= -limit ? -Infinity : Math.tan(lo) / tanHalf;
    const b = hi >= limit ? Infinity : Math.tan(hi) / tanHalf;
    if (a >= 1 || b <= -1) return null;
    return [Math.max(a, -1), Math.min(b, 1)];
  };
  const x = axis(cx, view.tanHalfFovX);
  const y = axis(cy, view.tanHalfFovY);
  if (x === null || y === null) return null;
  const xr = x === 'full' ? [-1, 1] : x;
  const yr = y === 'full' ? [-1, 1] : y;
  if (xr[0] === -1 && xr[1] === 1 && yr[0] === -1 && yr[1] === 1) return 'full';
  return [xr[0]!, yr[0]!, xr[1]!, yr[1]!];
}

export interface MarchBody extends AtmosphereLayer {
  /** Distance of the camera from the body centre, m. */
  distance: number;
  /** March samples for this body this frame. */
  steps: number;
  /** NDC bounds of the shell (see sphereScreenBounds). */
  bounds: [number, number, number, number] | 'full';
}

export interface MarchSelection {
  /** Up to two bodies, nearest first. */
  bodies: MarchBody[];
  /** NDC rectangle covering every selected shell, or null when nothing is selected. */
  bounds: [number, number, number, number] | null;
}

export interface SelectOptions {
  /** Samples of a shell that fills the view (QualitySettings.atmosphereSteps). */
  baseSteps: number;
  qualityScale: number;
  /** Render height in px and vertical field of view, rad. */
  renderHeight: number;
  fovY: number;
  /** Fewest samples of a shell (when it subtends far less than `fullStepsPx`). */
  minSteps?: number;
  /** Angular diameter of the shell, in px, from which the full sample count is used. */
  fullStepsPx?: number;
  maxBodies?: number;
}

/**
 * Bodies whose atmosphere is marched this frame: the shell must reach into the view and be at least half a
 * pixel across. Sample counts scale with FrameContext.qualityScale and fall off linearly below
 * `fullStepsPx` of angular diameter (a few-pixel shell seen from another world needs 8 samples, not 24).
 */
export function selectMarchBodies(layers: readonly AtmosphereLayer[], bodies: readonly BodyPose[], defs: DefLibrary, view: ViewFrustum, opts: SelectOptions): MarchSelection {
  const minSteps = opts.minSteps ?? 8;
  const fullPx = opts.fullStepsPx ?? 64;
  const pxPerRad = opts.renderHeight / opts.fovY;
  const found: MarchBody[] = [];
  for (const l of layers) {
    const pose = bodies[l.bodyIndex]!;
    const def = defs.bodies[l.bodyId]!;
    const rt = def.radius + def.render.atmosphere!.topAltitude;
    const distance = v3.len(pose.centerRelCam);
    const bounds = sphereScreenBounds(pose.centerRelCam, rt, view);
    if (bounds === null) continue;
    const diameterPx = distance <= rt ? Infinity : 2 * Math.asin(rt / distance) * pxPerRad;
    if (diameterPx < 0.5) continue;
    const scale = Math.min(1, Math.max(diameterPx / fullPx, minSteps / opts.baseSteps));
    const steps = Math.max(minSteps, Math.round(opts.baseSteps * opts.qualityScale * scale));
    found.push({ ...l, distance, steps, bounds });
  }
  found.sort((a, b) => a.distance - b.distance);
  const picked = found.slice(0, opts.maxBodies ?? 2);
  let rect: [number, number, number, number] | null = null;
  for (const b of picked) {
    const r: [number, number, number, number] = b.bounds === 'full' ? [-1, -1, 1, 1] : b.bounds;
    rect = rect ? [Math.min(rect[0], r[0]), Math.min(rect[1], r[1]), Math.max(rect[2], r[2]), Math.max(rect[3], r[3])] : r;
  }
  return { bodies: picked, bounds: rect };
}

/**
 * Side (px) of the tile targets of the full-resolution march. While the screen rectangle of the selected
 * shells fits into it, the atmosphere and its clouds are marched once per full-resolution pixel of that
 * rectangle instead of at half resolution (see marchFsWgsl): a planet seen from afar, where one
 * half-resolution texel spans more than the atmosphere is deep.
 */
export const FINE_TILE_SIZE = 1024;

/** A half-resolution texel coarser than this share of the shell's depth cannot carry the shell: the tile is used. */
export const FINE_TEXEL_SHARE = 0.2;

/**
 * Whether a full-resolution scissor rectangle [x, y, w, h] is marched in the full-resolution tile: it has
 * to fit, and one half-resolution texel on the nearest marched body (`texelM`, m) has to be coarse against
 * the depth of that body's atmosphere (`shellDepthM`, m). A shell that half resolution resolves is left to
 * it, whatever its size on the screen.
 */
export function fitsFineTile(scissor: readonly [number, number, number, number], texelM = Infinity, shellDepthM = 0): boolean {
  return scissor[2] > 0 && scissor[3] > 0 && scissor[2] <= FINE_TILE_SIZE && scissor[3] <= FINE_TILE_SIZE && texelM > FINE_TEXEL_SHARE * shellDepthM;
}

/** Pixel scissor rectangle [x, y, w, h] (y down) of an NDC rectangle on a target, grown by `margin` px. */
export function scissorOf(bounds: readonly [number, number, number, number], width: number, height: number, margin: number): [number, number, number, number] {
  const x0 = Math.max(0, Math.floor((bounds[0] * 0.5 + 0.5) * width) - margin);
  const x1 = Math.min(width, Math.ceil((bounds[2] * 0.5 + 0.5) * width) + margin);
  const y0 = Math.max(0, Math.floor((0.5 - bounds[3] * 0.5) * height) - margin);
  const y1 = Math.min(height, Math.ceil((0.5 - bounds[1] * 0.5) * height) + margin);
  return [x0, y0, Math.max(0, x1 - x0), Math.max(0, y1 - y0)];
}
