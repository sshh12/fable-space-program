/**
 * The UI scrim step of the tonemap pass (ARCHITECTURE 18.8): inside the rectangles published under
 * 'ui.scrimRects' the scene is replaced by a blurred, dimmed copy of itself, which is the backdrop of a DOM
 * panel drawn over the canvas (CSS `backdrop-filter` over the canvas is banned: the browser would read the
 * canvas back every frame).
 *
 * The blur costs nothing of its own: it is the DOWN chain of the bloom, which every frame builds anyway
 * (postProcess.ts: level l is the resolved image at 1 / 2^(l + 1) of the display size, each level a 13-tap
 * average of the one before). The scrim reads SCRIM_LEVELS neighbouring levels of it, the widest being the
 * widest level of the chain. The chain is counted from the frame height (`bloomLevelCount`), so the levels a
 * scrim reads are as wide, relative to the frame, at every resolution: a panel's backdrop looks the same at
 * 1080p and at 4K.
 *
 * This module holds what is not WGSL: the levels, the layout of the buffer (the contract's UI_SCRIM_*) and
 * its packing, and the same arithmetic on the CPU for the unit tests. The shader is in tonemap.ts.
 */
import { UI_SCRIM_BYTES, UI_SCRIM_SLOTS } from '@/core/contracts/render';

/** Levels of the bloom's down chain the scrim can read; `blur` 0..1 runs from the finest of them to the widest. */
export const SCRIM_LEVELS = 6;

/**
 * Indices into the bloom's down chain of the SCRIM_LEVELS textures the scrim binds, finest first, for a chain
 * of `chainLevels` levels: the widest SCRIM_LEVELS of the chain. A chain shorter than that (a frame under
 * 720 pixels high) repeats its finest level at the fine end.
 */
export function scrimLevelIndices(chainLevels: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < SCRIM_LEVELS; i++) out.push(Math.min(chainLevels - 1, Math.max(0, chainLevels - SCRIM_LEVELS + i)));
  return out;
}

/** One panel's backdrop (the contract's layout, UI_SCRIM_SLOTS in render.ts). */
export interface UiScrimRect {
  /** The rectangle in device pixels of the canvas, origin top-left; x1 > x0, y1 > y0. */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** Corner radius, device pixels (clamped to half the shorter side). */
  cornerRadius: number;
  /** 0..1: how wide the blur is (`scrimLevelOf`): 0 the finest scrim level, 1 the widest level of the bloom chain. */
  blur: number;
  /** 0..1: multiplier of the backdrop's luminance. */
  dim: number;
  /** 0..1: cross-fade of the scrim over the sharp scene (a panel fades in with it). */
  opacity: number;
}

/**
 * The contents of the 'ui.scrimRects' buffer for up to UI_SCRIM_SLOTS rectangles (more is an error: a ninth
 * panel would silently have no backdrop). Returns `out` (UI_SCRIM_BYTES / 4 floats), written whole: the
 * header and every slot, the unused ones zero.
 */
export function packScrimRects(rects: readonly UiScrimRect[], out: Float32Array = new Float32Array(UI_SCRIM_BYTES / 4)): Float32Array {
  if (rects.length > UI_SCRIM_SLOTS) throw new Error(`packScrimRects: ${rects.length} rectangles, the scrim step holds ${UI_SCRIM_SLOTS}`);
  if (out.length !== UI_SCRIM_BYTES / 4) throw new Error(`packScrimRects: the buffer has ${out.length} floats, 'ui.scrimRects' has ${UI_SCRIM_BYTES / 4}`);
  out.fill(0);
  out[0] = rects.length;
  rects.forEach((r, i) => {
    out.set([r.x0, r.y0, r.x1, r.y1, r.cornerRadius, r.blur, r.dim, r.opacity], 4 + i * 8);
  });
  return out;
}

/** The fractional scrim level of a `blur` value: 0 at the finest scrim level, SCRIM_LEVELS - 1 at the widest. */
export function scrimLevelOf(blur: number): number {
  return Math.min(Math.max(blur, 0), 1) * (SCRIM_LEVELS - 1);
}

/**
 * Share of a pixel (centre at `px`, `py`, device pixels) that a rectangle's scrim covers, before its opacity:
 * 1 inside, 0 outside, a one-pixel ramp across the edge of the rounded rectangle. The same arithmetic as the
 * shader's `scrimCover`.
 */
export function scrimCoverage(r: Pick<UiScrimRect, 'x0' | 'y0' | 'x1' | 'y1' | 'cornerRadius'>, px: number, py: number): number {
  const hx = 0.5 * (r.x1 - r.x0);
  const hy = 0.5 * (r.y1 - r.y0);
  // A rectangle without an area covers nothing (not a hairline along its edge).
  if (Math.min(hx, hy) <= 0) return 0;
  const radius = Math.min(Math.max(r.cornerRadius, 0), Math.min(hx, hy));
  const qx = Math.abs(px - 0.5 * (r.x0 + r.x1)) - hx + radius;
  const qy = Math.abs(py - 0.5 * (r.y0 + r.y1)) - hy + radius;
  const sd = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - radius;
  return Math.min(Math.max(0.5 - sd, 0), 1);
}
