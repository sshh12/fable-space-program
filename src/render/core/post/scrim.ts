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
 * its packing, the same arithmetic on the CPU for the unit tests, and WHERE the step is drawn: the scissor
 * rectangles of the published rectangles (`scrimScissors`), which the tonemap pass can only make from
 * rectangles it knows on the CPU (`writeScrimRects`). The shader is in tonemap.ts.
 */
import { UI_SCRIM_BYTES, UI_SCRIM_SLOTS } from '@/core/contracts/render';

/** Levels of the bloom's down chain the scrim can read; `blur` 0..1 runs from the finest of them to the widest. */
export const SCRIM_LEVELS = 6;

/**
 * What the scrim reads (PostOutputs.scrimLevels): SCRIM_LEVELS levels of the bloom's down chain, finest first,
 * and the size of the display they were made for. That is the canvas the tonemap pass draws to, in whose
 * device pixels the rectangles are stated and the scissors are set.
 */
export interface ScrimLevels {
  readonly views: readonly GPUTextureView[];
  readonly width: number;
  readonly height: number;
}

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

// ------------------------------------------------------------------------------- where the step is drawn
// The rectangles reach the core as a GPU buffer, which it cannot read while it encodes a frame. A publisher
// that writes its buffer through `writeScrimRects` tells the core what is in it; the tonemap pass then draws
// the scrim only over the pixels the rectangles can touch (tonemap.ts). A buffer written any other way is
// drawn as before the scissors existed: the scrim shader over the whole frame, the same picture.

/** What the core knows to be in a 'ui.scrimRects' buffer: the floats last written through `writeScrimRects`. */
const known = new WeakMap<GPUBuffer, Float32Array>();

/**
 * Write the rectangles into a buffer that is (or will be) published as 'ui.scrimRects', and tell the core
 * what is in it. This is how a publisher writes its buffer: `packScrimRects` and `queue.writeBuffer` in one.
 * A buffer written through this function must ALWAYS be written through it (a direct write the core does
 * not see would leave the scissors of the old rectangles), and before the frame is rendered, not from a
 * hook of the frame. Throws what `packScrimRects` throws, before anything is written.
 */
export function writeScrimRects(device: GPUDevice, buffer: GPUBuffer, rects: readonly UiScrimRect[]): void {
  const packed = packScrimRects(rects);
  device.queue.writeBuffer(buffer, 0, packed as Float32Array<ArrayBuffer>);
  // A new array with every write: the pass keeps its scissors for as long as it sees the same one.
  known.set(buffer, packed);
}

/** The floats last written into `buffer` through `writeScrimRects`; undefined for a buffer written otherwise. */
export function scrimRectsOf(buffer: GPUBuffer): Float32Array | undefined {
  return known.get(buffer);
}

/** A scissor rectangle of the canvas in device pixels (GPURenderPassEncoder.setScissorRect). */
export interface ScrimScissor {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * The pixels of a `width` x `height` canvas that the rectangles of a packed 'ui.scrimRects' buffer can
 * change, as scissor rectangles that do NOT overlap (a pixel under two panels is drawn once; the shader
 * composes the panels in their order whichever scissor the pixel is in).
 *
 * A rectangle changes a pixel only where its coverage (`scrimCoverage`, the shader's `scrimCover`) times its
 * opacity is above zero: within half a pixel of the rectangle's box. The scissor of a rectangle is that box
 * grown to whole pixels and by one more pixel on every side, so the anti-aliased ramp is inside it with a
 * pixel to spare (the shader's float arithmetic is good to a ten-thousandth of a pixel at these sizes), and
 * cut to the canvas. A rectangle without an area, one of opacity 0 and one that lies off the canvas have no
 * scissor: they cost nothing. The rounded corners are not cut out: the shader gives those pixels coverage 0
 * and leaves them as they are.
 *
 * Returns null when the contents cannot be read here as the shader reads them (a value that is not finite):
 * the caller then draws the scrim over the whole frame.
 */
export function scrimScissors(packed: Float32Array, width: number, height: number): ScrimScissor[] | null {
  if (packed.length !== UI_SCRIM_BYTES / 4) throw new Error(`scrimScissors: ${packed.length} floats, 'ui.scrimRects' has ${UI_SCRIM_BYTES / 4}`);
  const header = packed[0]!;
  if (!Number.isFinite(header)) return null;
  // The shader's count: min(u32(header.x), UI_SCRIM_SLOTS).
  const count = Math.min(Math.max(Math.trunc(header), 0), UI_SCRIM_SLOTS);
  const boxes: { x0: number; y0: number; x1: number; y1: number }[] = [];
  for (let i = 0; i < count; i++) {
    const o = 4 + i * 8;
    for (let k = 0; k < 8; k++) if (!Number.isFinite(packed[o + k]!)) return null;
    const rx0 = packed[o]!;
    const ry0 = packed[o + 1]!;
    const rx1 = packed[o + 2]!;
    const ry1 = packed[o + 3]!;
    // No area (the shader: min(half.x, half.y) <= 0) or not faded in at all (cover * clamp(opacity, 0, 1) = 0).
    if (!(rx1 > rx0 && ry1 > ry0) || !(packed[o + 7]! > 0)) continue;
    const x0 = Math.max(0, Math.floor(rx0) - 1);
    const y0 = Math.max(0, Math.floor(ry0) - 1);
    const x1 = Math.min(width, Math.ceil(rx1) + 1);
    const y1 = Math.min(height, Math.ceil(ry1) + 1);
    if (x1 > x0 && y1 > y0) boxes.push({ x0, y0, x1, y1 });
  }
  if (boxes.length === 0) return [];
  if (boxes.length === 1) return [{ x: boxes[0]!.x0, y: boxes[0]!.y0, width: boxes[0]!.x1 - boxes[0]!.x0, height: boxes[0]!.y1 - boxes[0]!.y0 }];

  // The union of the boxes as rectangles that do not overlap: horizontal bands between the boxes' rows; in
  // each band the merged column spans of the boxes that cross it; a span that continues from the band above
  // with the same columns extends that rectangle.
  const ys = [...new Set(boxes.flatMap((b) => [b.y0, b.y1]))].sort((a, b) => a - b);
  const out: ScrimScissor[] = [];
  let open = new Map<string, ScrimScissor>();
  for (let k = 0; k + 1 < ys.length; k++) {
    const ya = ys[k]!;
    const yb = ys[k + 1]!;
    const spans = boxes.filter((b) => b.y0 <= ya && b.y1 >= yb).sort((a, b) => a.x0 - b.x0);
    const next = new Map<string, ScrimScissor>();
    for (let s = 0; s < spans.length; ) {
      const xa = spans[s]!.x0;
      let xb = spans[s]!.x1;
      // Spans that overlap or touch are one span.
      for (s++; s < spans.length && spans[s]!.x0 <= xb; s++) xb = Math.max(xb, spans[s]!.x1);
      const key = `${xa}:${xb}`;
      const above = open.get(key);
      if (above) {
        above.height += yb - ya;
        next.set(key, above);
      } else {
        const made = { x: xa, y: ya, width: xb - xa, height: yb - ya };
        out.push(made);
        next.set(key, made);
      }
    }
    open = next;
  }
  return out;
}
