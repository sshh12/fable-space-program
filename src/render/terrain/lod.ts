/**
 * CDLOD ranges, the morph window and the warp-aware level cap (rendering-design 4.2 / 4.3, ARCHITECTURE 7.3).
 * Pure float64 maths shared by the CPU selection and (through per-tile uniforms) the vertex shader.
 *
 * Levels: 0 = one tile per cube face; `faceSize` = mean edge of a level-0 tile = pi R / 2.
 *   size(l)  = faceSize / 2^l                          mean tile edge (the same for every tile of a level)
 *   range(l) = 2 K size(l) = splitDist(l - 1)          tiles of level l are used within this distance
 * A node of level l is replaced by its children where a child's shell patch comes within range(l + 1) of
 * an observer (tested per child, so the L / L+1 border always lies at a distance >= range(l + 1)).
 *
 * Morph factor of a vertex of a level-l tile at distance d:  k = clamp((d / range(l) - m0) / (m1 - m0), 0, 1).
 * Crack-freedom needs (a) k = 1 wherever a level-l tile borders level l-1 geometry: every such border is at
 * d >= range(l) > m1 range(l); and (b) k = 0 on the coarser side there: border points are at most one tile
 * diagonal beyond range(l), so the coarser level (range twice as long) must not start morphing before
 * 0.5 + diag / (4 K size) of ITS range. With the gnomonic cube a tile is up to 1.27 x the mean size, so
 * m0 >= 0.5 + 0.5 / K covers it with margin; at the default K = 2.44 that is the 0.70 of the design.
 */

/** Quads per tile edge. */
export const GRID_QUADS = 64;
/** Vertices per tile edge. */
export const GRID_VERTS = GRID_QUADS + 1;

/** Smallest K the selection runs with (very wide fields of view would otherwise break the morph window). */
export const LOD_K_MIN = 1.25;
export const LOD_K_MAX = 64;

/**
 * Split-distance factor K: a tile at distance K x size shows its quads at `pxPerQuad` pixels.
 * `renderHeightPx` is the INTERNAL render height, so dynamic resolution relieves geometry too.
 */
export function lodK(renderHeightPx: number, fovY: number, pxPerQuad: number): number {
  const k = renderHeightPx / (2 * Math.tan(fovY / 2) * GRID_QUADS * pxPerQuad);
  return Math.min(LOD_K_MAX, Math.max(LOD_K_MIN, k));
}

export interface MorphWindow {
  /** Morph starts at m0 x range(l) and is complete at m1 x range(l). */
  m0: number;
  m1: number;
}

export function morphWindow(K: number): MorphWindow {
  const m0 = Math.min(0.9, Math.max(0.7, 0.5 + 0.5 / K));
  return { m0, m1: Math.max(0.95, m0 + 0.08) };
}

/** Distance within which tiles of `level` are used (= split distance of their parent). Infinite for level 0. */
export function levelRange(level: number, K: number, faceSize: number): number {
  return level <= 0 ? Infinity : (2 * K * faceSize) / 2 ** level;
}

/** Distance-based morph factor of a level-`level` vertex at distance `d` (0 for level 0: nothing to morph to). */
export function morphFactor(level: number, d: number, K: number, faceSize: number, w: MorphWindow): number {
  if (level <= 0) return 0;
  const x = (d / levelRange(level, K, faceSize) - w.m0) / (w.m1 - w.m0);
  return x <= 0 ? 0 : x >= 1 ? 1 : x;
}

/** Seconds a tile must stay useful under time warp (ARCHITECTURE 7.3). */
export const WARP_TILE_SECONDS = 2;

/**
 * Continuous level cap under fast ground motion: c = log2(faceSize / (groundSpeedPerWallSecond x 2 s)).
 * The deepest level requested is floor(c); a tile of level l is drawn with a morph factor of at least
 * clamp(l + 1 - c, 0, 1), so the finest allowed level has always faded into its parent before it is
 * dropped and nothing pops at any warp factor.
 */
export function warpLevelCap(faceSize: number, groundSpeed: number, maxLevel: number): number {
  if (!(groundSpeed > 0)) return maxLevel + 1;
  const c = Math.log2(faceSize / (groundSpeed * WARP_TILE_SECONDS));
  return Math.min(maxLevel + 1, Math.max(0, c));
}

/** Morph floor the cap imposes on tiles of `level` (see warpLevelCap). */
export function capMorph(level: number, cap: number): number {
  const k = level + 1 - cap;
  return k <= 0 ? 0 : k >= 1 ? 1 : k;
}

/** Deepest level the cap allows to be requested and drawn. */
export function capMaxLevel(cap: number, maxLevel: number): number {
  return Math.max(0, Math.min(maxLevel, Math.floor(cap)));
}

/** smoothstep(0, 1, x). */
export const smooth01 = (x: number): number => {
  const t = x <= 0 ? 0 : x >= 1 ? 1 : x;
  return t * t * (3 - 2 * t);
};

/** Seconds a newly drawn tile takes to relax from the fully morphed state (rendering-design 4.7). */
export const FADE_IN_SECONDS = 0.35;

/** Forced morph of a tile `age` seconds after it was first drawn: 1 at 0, 0 from FADE_IN_SECONDS on. */
export function fadeMorph(age: number): number {
  return 1 - smooth01(age / FADE_IN_SECONDS);
}
