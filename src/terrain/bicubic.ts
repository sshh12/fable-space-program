/**
 * Catmull-Rom bicubic sampling of a decoded FRT1 height tile (259 x 259, 1-sample border, sample (i, j) at
 * tile u = (i - 1) / 256, v = (j - 1) / 256). The border makes the surface C0 across tile and cube-face
 * edges (edge samples are shared; at an edge the interpolation reproduces the edge samples exactly) and the
 * border samples keep it C1 there.
 */
import { HEIGHT_TILE_CELLS, HEIGHT_TILE_STORED } from '../core/geo/tileCodec';
import type { TileEntry } from './tileStore';

const S = HEIGHT_TILE_STORED;
const CELLS = HEIGHT_TILE_CELLS;

/**
 * Value and gradient of the bicubic at tile-local (u, v) in [0, 1]. Writes out[o] = height (m),
 * out[o + 1] = dh/du, out[o + 2] = dh/dv (metres per tile unit).
 */
export function bicubicSample(e: TileEntry, u: number, v: number, out: Float64Array, o: number): void {
  const q = e.q!;
  const fx = u * CELLS + 1;
  const fy = v * CELLS + 1;
  let i1 = Math.floor(fx);
  let j1 = Math.floor(fy);
  if (i1 < 1) i1 = 1;
  else if (i1 > CELLS) i1 = CELLS;
  if (j1 < 1) j1 = 1;
  else if (j1 > CELLS) j1 = CELLS;
  const tx = fx - i1;
  const ty = fy - j1;
  const wx0 = ((-tx + 2) * tx - 1) * tx * 0.5;
  const wx1 = ((3 * tx - 5) * tx * tx + 2) * 0.5;
  const wx2 = ((-3 * tx + 4) * tx + 1) * tx * 0.5;
  const wx3 = (tx - 1) * tx * tx * 0.5;
  const dx0 = (-3 * tx * tx + 4 * tx - 1) * 0.5;
  const dx1 = (9 * tx * tx - 10 * tx) * 0.5;
  const dx2 = (-9 * tx * tx + 8 * tx + 1) * 0.5;
  const dx3 = (3 * tx * tx - 2 * tx) * 0.5;
  const wy0 = ((-ty + 2) * ty - 1) * ty * 0.5;
  const wy1 = ((3 * ty - 5) * ty * ty + 2) * 0.5;
  const wy2 = ((-3 * ty + 4) * ty + 1) * ty * 0.5;
  const wy3 = (ty - 1) * ty * ty * 0.5;
  const dy0 = (-3 * ty * ty + 4 * ty - 1) * 0.5;
  const dy1 = (9 * ty * ty - 10 * ty) * 0.5;
  const dy2 = (-9 * ty * ty + 8 * ty + 1) * 0.5;
  const dy3 = (3 * ty * ty - 2 * ty) * 0.5;
  let r = (j1 - 1) * S + (i1 - 1);
  let a = q[r]!, b = q[r + 1]!, c = q[r + 2]!, d = q[r + 3]!;
  const v0 = wx0 * a + wx1 * b + wx2 * c + wx3 * d;
  const g0 = dx0 * a + dx1 * b + dx2 * c + dx3 * d;
  r += S;
  a = q[r]!; b = q[r + 1]!; c = q[r + 2]!; d = q[r + 3]!;
  const v1 = wx0 * a + wx1 * b + wx2 * c + wx3 * d;
  const g1 = dx0 * a + dx1 * b + dx2 * c + dx3 * d;
  r += S;
  a = q[r]!; b = q[r + 1]!; c = q[r + 2]!; d = q[r + 3]!;
  const v2 = wx0 * a + wx1 * b + wx2 * c + wx3 * d;
  const g2 = dx0 * a + dx1 * b + dx2 * c + dx3 * d;
  r += S;
  a = q[r]!; b = q[r + 1]!; c = q[r + 2]!; d = q[r + 3]!;
  const v3 = wx0 * a + wx1 * b + wx2 * c + wx3 * d;
  const g3 = dx0 * a + dx1 * b + dx2 * c + dx3 * d;
  const sc = e.scale;
  out[o] = e.offset + sc * (wy0 * v0 + wy1 * v1 + wy2 * v2 + wy3 * v3);
  out[o + 1] = sc * CELLS * (wy0 * g0 + wy1 * g1 + wy2 * g2 + wy3 * g3);
  out[o + 2] = sc * CELLS * (dy0 * v0 + dy1 * v1 + dy2 * v2 + dy3 * v3);
}

/** Minimum and maximum stored height over the samples that influence tile-local [u0, u1] x [v0, v1]. */
export function sampleRange(e: TileEntry, u0: number, u1: number, v0: number, v1: number): { lo: number; hi: number } {
  const q = e.q!;
  const clampI = (x: number): number => (x < 0 ? 0 : x > S - 1 ? S - 1 : x);
  const i0 = clampI(Math.floor(u0 * CELLS + 1) - 1);
  const i1 = clampI(Math.floor(u1 * CELLS + 1) + 2);
  const j0 = clampI(Math.floor(v0 * CELLS + 1) - 1);
  const j1 = clampI(Math.floor(v1 * CELLS + 1) + 2);
  let lo = Infinity;
  let hi = -Infinity;
  for (let j = j0; j <= j1; j++) {
    const row = j * S;
    for (let i = i0; i <= i1; i++) {
      const x = q[row + i]!;
      if (x < lo) lo = x;
      if (x > hi) hi = x;
    }
  }
  return { lo: e.offset + e.scale * lo, hi: e.offset + e.scale * hi };
}
