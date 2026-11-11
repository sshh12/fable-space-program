/**
 * Level-of-detail selection for the vessel and site features.
 *
 * The mesh system cross-fades two LODs for as long as an instance's projected size sits inside a band round
 * a switch size, which leaves a part that happens to be parked at that distance half-dithered for good
 * (engine bells at 10 m, an interstage at 40 m). Here every LOD is its own single-LOD model and the feature
 * decides which to draw:
 *
 *  - by projected diameter in pixels with HYSTERESIS: an instance switches to the coarser LOD only below
 *    (1 - h) of the switch size and back only above (1 + h), so a still camera never straddles a switch;
 *  - a switch is a short cross-fade in TIME: for `fadeSeconds` the coarser of the two LODs is drawn solid
 *    and the finer one dithers in or out over it, then exactly one LOD is drawn. Nothing is ever left
 *    half-transparent because of where the camera stands;
 *  - while the frame does not animate (deterministic captures) a switch is immediate.
 */
import type { FrameContext } from '@/core/contracts/render';
import type { Quat, Vec3, Vec3Tuple } from '@/core/math';

/** Default switch sizes (projected diameter, px): LOD 1 below the first, LOD 2 below the second. */
export const DEFAULT_LOD_PIXELS: readonly number[] = [220, 60];

/** Relative half-width of the hysteresis round a switch size. */
const HYSTERESIS = 0.12;

export interface LodState {
  /** LOD in use (-1 before the first pick). */
  lod: number;
  /** LOD being left while a cross-fade runs (-1 = none). */
  from: number;
  /** Progress 0..1 of the cross-fade. */
  k: number;
}

export const newLodState = (): LodState => ({ lod: -1, from: -1, k: 1 });

export interface LodDraw {
  /** LOD drawn solid. */
  solid: number;
  /** LOD dithered over it (-1 = none) and its coverage 0..1. */
  fading: number;
  fade: number;
}

export class LodSelector {
  private pxScale = 1;
  private step = 1;
  private lastRealTime = Number.NaN;
  private readonly out: LodDraw = { solid: 0, fading: -1, fade: 0 };

  constructor(private readonly fadeSeconds = 0.25) {}

  /** Call once per frame before any `pick`. */
  begin(frame: FrameContext): void {
    // Projected diameter in pixels of a sphere of radius r at distance d: r / d * pxScale.
    this.pxScale = frame.renderSize[1] * frame.projUnjittered[5]!;
    const dt = Number.isFinite(this.lastRealTime) ? frame.realTime - this.lastRealTime : 0;
    this.lastRealTime = frame.realTime;
    this.step = !frame.animate || !(dt > 0) || this.fadeSeconds <= 0 ? 1 : Math.min(1, dt / this.fadeSeconds);
  }

  /**
   * Projected diameter (px) of a model's bounding sphere for an instance at `origin` (camera-relative)
   * with orientation `q`; `centre` and `radius` are the sphere in model space.
   */
  sizePx(origin: Vec3, q: Quat, centre: Vec3Tuple, radius: number, scale = 1): number {
    // origin + q * (centre * scale), written out (no allocation).
    const vx = centre[0] * scale;
    const vy = centre[1] * scale;
    const vz = centre[2] * scale;
    const tx = 2 * (q.y * vz - q.z * vy);
    const ty = 2 * (q.z * vx - q.x * vz);
    const tz = 2 * (q.x * vy - q.y * vx);
    const cx = origin.x + vx + q.w * tx + (q.y * tz - q.z * ty);
    const cy = origin.y + vy + q.w * ty + (q.z * tx - q.x * tz);
    const cz = origin.z + vz + q.w * tz + (q.x * ty - q.y * tx);
    const dist = Math.max(Math.hypot(cx, cy, cz), 1e-3);
    return ((radius * scale) / dist) * this.pxScale;
  }

  /**
   * Advance one instance's state for this frame and say what to draw. The returned object is reused by
   * the next call.
   */
  pick(state: LodState, sizePx: number, thresholds: readonly number[], lodCount: number): LodDraw {
    const last = lodCount - 1;
    let lod: number;
    if (state.lod < 0) {
      lod = 0;
      while (lod < last && sizePx < (thresholds[lod] ?? 0)) lod++;
      state.lod = lod;
      state.from = -1;
      state.k = 1;
    } else {
      lod = Math.min(state.lod, last);
      while (lod < last && sizePx < (thresholds[lod] ?? 0) * (1 - HYSTERESIS)) lod++;
      while (lod > 0 && sizePx > (thresholds[lod - 1] ?? 0) * (1 + HYSTERESIS)) lod--;
      if (lod !== state.lod) {
        state.from = state.lod;
        state.lod = lod;
        state.k = 0;
      }
      if (state.from >= 0) {
        state.k += this.step;
        if (state.k >= 1) {
          state.k = 1;
          state.from = -1;
        }
      }
    }
    const o = this.out;
    if (state.from < 0) {
      o.solid = state.lod;
      o.fading = -1;
      o.fade = 0;
    } else if (state.lod > state.from) {
      // Going coarser: the coarse LOD is there at once, the fine one dithers out over it.
      o.solid = state.lod;
      o.fading = state.from;
      o.fade = 1 - state.k;
    } else {
      // Going finer: the fine LOD dithers in over the coarse one.
      o.solid = state.from;
      o.fading = state.lod;
      o.fade = state.k;
    }
    return o;
  }
}
