/**
 * Small numeric helpers shared by the terrain height authority. Pure functions, no allocation.
 */

/** C2 ramp x^3 (6x^2 - 15x + 10) on [0, 1], clamped outside. */
export function smootherstep01(x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  return x * x * x * (x * (x * 6 - 15) + 10);
}

/** C1 ramp 3x^2 - 2x^3 on [0, 1], clamped outside. */
export function smoothstep01(x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  return x * x * (3 - 2 * x);
}

/** Smoothstep between two edges (e0 may be greater than e1 for a falling ramp). */
export function smoothstepEdges(e0: number, e1: number, x: number): number {
  return smoothstep01((x - e0) / (e1 - e0));
}

/**
 * Polynomial smooth minimum (C1): equals min(a, b) whenever |a - b| >= k, rounds the crease within k.
 */
export function smoothMin(a: number, b: number, k: number): number {
  if (k <= 0) return a < b ? a : b;
  const d = a - b;
  const ad = d < 0 ? -d : d;
  if (ad >= k) return a < b ? a : b;
  const h = (k - ad) / k;
  return (a < b ? a : b) - (h * h * k) / 4;
}

/**
 * Weight of a component of characteristic length `len` under a band limit `lambdaMin`:
 * 0 at len <= lambdaMin, 1 at len >= 2 lambdaMin, smootherstep in log2 between (C2 in lambdaMin).
 * Arguments are log2 values so callers can precompute them.
 */
export function bandWeightLog2(log2Len: number, log2LambdaMin: number): number {
  return smootherstep01(log2Len - log2LambdaMin);
}

/** Unit vector components of (x, y, z) written to `out` at `o`; returns the length. */
export function normalizeInto(x: number, y: number, z: number, out: Float64Array, o: number): number {
  const l = Math.sqrt(x * x + y * y + z * z);
  out[o] = x / l;
  out[o + 1] = y / l;
  out[o + 2] = z / l;
  return l;
}

/** Mean tile edge length at `level` on a sphere of `radius` (same formula as cubeSphere.meanTileSize). */
export function meanTileSizeAt(radius: number, level: number): number {
  return (Math.PI * radius) / 2 / 2 ** level;
}

/**
 * Data wavelength of a level: two texels of a 256-cell tile, i.e. meanTileSize / 128. For a fractional
 * (effective) level the same formula is a smooth function of the level.
 */
export function dataWavelength(radius: number, level: number): number {
  return (Math.PI * radius) / 256 / 2 ** level;
}

/** 2^k for k = 0..40 (levels, lattice sizes): a table read instead of Math.pow in hot paths. */
export const POW2: Float64Array = (() => {
  const t = new Float64Array(41);
  for (let k = 0; k <= 40; k++) t[k] = 2 ** k;
  return t;
})();

/** Numeric key of tile (face, x, y) within one level (exact for level <= 24). */
export function tileNumber(level: number, face: number, x: number, y: number): number {
  const n = POW2[level]!;
  return (face * n + x) * n + y;
}
