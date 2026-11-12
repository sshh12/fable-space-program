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

/**
 * A floor under the level ranges: tiles of `level` are used within `range` of an observer however small
 * they are on screen, and each coarser level within twice the range of the next. It keeps the relief of a
 * body in its geometry while the body is a small disc: the whole-body shadow cascade casts from the tiles
 * that are drawn, and a level-0 mesh has no craters to cast a shadow at the terminator.
 */
export interface ReliefFloor {
  level: number;
  range: number;
}

/** Distance within which tiles of `level` are used (= split distance of their parent). Infinite for level 0. */
export function levelRange(level: number, K: number, faceSize: number, relief?: ReliefFloor | null): number {
  if (level <= 0) return Infinity;
  const range = (2 * K * faceSize) / 2 ** level;
  return relief && level <= relief.level ? Math.max(range, relief.range * 2 ** (relief.level - level)) : range;
}

/** Distance-based morph factor of a level-`level` vertex at distance `d` (0 for level 0: nothing to morph to). */
export function morphFactor(level: number, d: number, K: number, faceSize: number, w: MorphWindow, relief?: ReliefFloor | null): number {
  if (level <= 0) return 0;
  const x = (d / levelRange(level, K, faceSize, relief) - w.m0) / (w.m1 - w.m0);
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

/** Seconds of frames whose slowest one is an observer's ground speed (GroundSpeed). */
export const SPEED_WINDOW_SECONDS = 0.25;
/** Doublings per second by which a ground speed may rise: the warp cap falls by at most this many levels a second. */
export const SPEED_RISE_LEVELS = 8;
/** Speed from which a rise is counted, m/s (below it no level of any body is capped). */
export const SPEED_FLOOR = 1;

/**
 * Ground speed of one LOD observer per wall-clock second, for its warp cap. The slowest frame of the last
 * SPEED_WINDOW_SECONDS is taken, so a camera cut, a view blend (0.6 s of a camera flying between two rigs)
 * and a single long frame are not flight; a speed that rises is followed by SPEED_RISE_LEVELS doublings a
 * second (the cap falls level by level, an eighth of a second each, and every level has faded into its parent
 * before it is dropped, whatever the jump: a smoothing of the speed itself let the cap fall six levels in the
 * first frame of a thousandfold warp), one that falls at once (the cap rises, and what comes back fades in
 * tile by tile anyway). The moment a camera comes to rest the ground under it
 * has its full detail again: after a return from the map view that used to take one to five seconds.
 */
export class GroundSpeed {
  speed = 0;
  private readonly speeds: number[] = [];
  private readonly spans: number[] = [];
  private total = 0;

  /** One frame in which the observer moved `step` metres over the ground in `dt` seconds. */
  update(step: number, dt: number): number {
    const span = Math.max(dt, 1e-4);
    this.speeds.push(step / span);
    this.spans.push(span);
    this.total += span;
    // Keep the shortest run of frames that covers the window, and never fewer than three (one long frame
    // with a cut in it is not flight either).
    while (this.spans.length > 3 && this.total - this.spans[0]! >= SPEED_WINDOW_SECONDS) {
      this.total -= this.spans.shift()!;
      this.speeds.shift();
    }
    let slowest = Infinity;
    for (const s of this.speeds) if (s < slowest) slowest = s;
    if (slowest <= this.speed) this.speed = slowest;
    else this.speed = Math.min(slowest, Math.max(this.speed, SPEED_FLOOR) * 2 ** (SPEED_RISE_LEVELS * span));
    return this.speed;
  }

  reset(): void {
    this.speed = 0;
    this.speeds.length = 0;
    this.spans.length = 0;
    this.total = 0;
  }
}

/**
 * Share of the largest pool that the live demand may take before the level ranges are shrunk (POOL_HIGH), the
 * share they are shrunk or grown to (POOL_TARGET) and the share below which they grow again (POOL_LOW).
 */
export const POOL_HIGH = 0.92;
export const POOL_TARGET = 0.86;
export const POOL_LOW = 0.78;
/** Smallest factor on the split distances (the ranges are never shrunk below LOD_K_MIN either). */
export const LOD_SCALE_MIN = 0.4;
/** Largest growth of the factor per second. */
export const LOD_SCALE_GROWTH = 0.5;

/**
 * The factor on K that fits a view into the tile pools (request app-integration-7). `ratio` = live demand /
 * capacity of the fullest pool, measured with the ranges at `usedScale` of their full size. The demand of a
 * view goes with the area of its rings, K^2, so the factor that brings it to POOL_TARGET is
 * usedScale sqrt(POOL_TARGET / ratio). It only moves when the demand leaves the band POOL_LOW..POOL_HIGH (a
 * tenth of K of hysteresis), down at once (K itself follows smoothly), up by LOD_SCALE_GROWTH per second.
 */
export function fitLodScale(scale: number, usedScale: number, ratio: number, dt: number): number {
  if (ratio > POOL_HIGH) return Math.max(LOD_SCALE_MIN, Math.min(scale, usedScale * Math.sqrt(POOL_TARGET / ratio)));
  if (scale < 1 && ratio < POOL_LOW) {
    const fit = usedScale * Math.sqrt(POOL_TARGET / Math.max(ratio, 0.01));
    return Math.min(1, Math.max(scale, Math.min(fit, scale * (1 + LOD_SCALE_GROWTH * Math.max(0, dt)))));
  }
  return scale;
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
