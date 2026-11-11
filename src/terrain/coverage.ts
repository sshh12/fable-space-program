/**
 * Coverage of one tile layer: existence of tiles (layerHasTile) and the coverage weight w_L of sparse levels,
 * exactly as specified at COVERAGE_BLEND_TILES in src/core/contracts/terrain.ts (also used for the height
 * layer's `sourceCoverage`, with SOURCE_BLEND_TILES). Everything here is a pure function of the manifest (never
 * of residency), memoised per tile.
 */
import type { FaceId } from '../core/geo/cubeSphere';
import { dirToTile, tileUvToDir } from '../core/geo/cubeSphere';
import type { TileLayerManifest, TileRect } from '../core/contracts/terrain';
import { COVERAGE_BLEND_TILES, SOURCE_BLEND_TILES } from '../core/contracts/terrain';
import { smootherstep01, tileNumber } from './util';

/** Neighbour offsets, bit k of a missing-neighbour mask refers to NEIGHBOURS[k]. */
const NEIGHBOURS: readonly (readonly [number, number])[] = [
  [-1, -1],
  [0, -1],
  [1, -1],
  [-1, 0],
  [1, 0],
  [-1, 1],
  [0, 1],
  [1, 1],
];

/** How far beyond the tile edge (tile units) the probe point for a cross-face neighbour lies. */
const EDGE_PROBE = 1e-7;

export class LayerCoverage {
  readonly globalMaxLevel: number;
  /** Deepest level with any tile (globalMaxLevel when the layer has no sparse coverage). */
  readonly maxLevel: number;
  private readonly rectsByLevel: (TileRect[] | undefined)[] = [];
  private readonly masks: Map<number, number>[] = [];

  constructor(readonly layer: TileLayerManifest) {
    this.globalMaxLevel = layer.globalMaxLevel;
    let maxLevel = layer.globalMaxLevel;
    for (const [k, rects] of Object.entries(layer.coverage ?? {})) {
      const level = Number(k);
      if (!Number.isInteger(level) || level <= layer.globalMaxLevel) continue;
      if (rects.length === 0) continue;
      this.rectsByLevel[level] = rects;
      if (level > maxLevel) maxLevel = level;
    }
    this.maxLevel = maxLevel;
    for (let l = 0; l <= maxLevel; l++) this.masks.push(new Map());
  }

  /** layerHasTile, without allocating a TileKey. */
  has(level: number, face: number, x: number, y: number): boolean {
    if (level <= this.globalMaxLevel) return true;
    const rects = this.rectsByLevel[level];
    if (!rects) return false;
    for (let i = 0; i < rects.length; i++) {
      const r = rects[i]!;
      if (r.face === face && x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1) return true;
    }
    return false;
  }

  /** True when `level` has sparse coverage (a level above globalMaxLevel with at least one rect). */
  isSparse(level: number): boolean {
    return level > this.globalMaxLevel && this.rectsByLevel[level] !== undefined;
  }

  /**
   * Bit mask of the 8 neighbour tile positions of (level, face, x, y) that the manifest does NOT contain.
   * Neighbours across a cube edge are found by mapping a point just beyond the tile edge through dirToTile.
   */
  missingMask(level: number, face: number, x: number, y: number): number {
    if (level <= this.globalMaxLevel) return 0;
    const memo = this.masks[level];
    const key = tileNumber(level, face, x, y);
    const hit = memo?.get(key);
    if (hit !== undefined) return hit;
    const n = 2 ** level;
    let mask = 0;
    for (let k = 0; k < NEIGHBOURS.length; k++) {
      const [dx, dy] = NEIGHBOURS[k]!;
      const nx = x + dx;
      const ny = y + dy;
      let present: boolean;
      if (nx >= 0 && nx < n && ny >= 0 && ny < n) present = this.has(level, face, nx, ny);
      else {
        const u = dx < 0 ? -EDGE_PROBE : dx > 0 ? 1 + EDGE_PROBE : 0.5;
        const v = dy < 0 ? -EDGE_PROBE : dy > 0 ? 1 + EDGE_PROBE : 0.5;
        const dir = tileUvToDir({ face: face as FaceId, level, x, y }, u, v);
        const t = dirToTile(dir, level);
        present = this.has(level, t.key.face, t.key.x, t.key.y);
      }
      if (!present) mask |= 1 << k;
    }
    memo?.set(key, mask);
    return mask;
  }

  /**
   * Coverage weight w_L at tile-local (u, v) of tile (level, face, x, y): 1 for global levels, 0 when the tile
   * does not exist, else smootherstep(min(1, d / COVERAGE_BLEND_TILES)) with d the distance (tile units) to
   * the nearest missing neighbour square.
   */
  weight(level: number, face: number, x: number, y: number, u: number, v: number): number {
    if (level <= this.globalMaxLevel) return 1;
    if (!this.has(level, face, x, y)) return 0;
    const mask = this.missingMask(level, face, x, y);
    if (mask === 0) return 1;
    return weightFromMask(mask, u, v);
  }
}

/**
 * Width of the source ring over which the effective level rises (the source weight s_L; evaluator.ts): the
 * contract's constant (src/core/contracts/terrain.ts, where the measurement behind it is stated),
 * re-exported for the modules of this package.
 */
export { SOURCE_BLEND_TILES };

/** Coverage weight from a missing-neighbour mask and tile-local (u, v), rising over `blend` tiles. */
export function weightFromMask(mask: number, u: number, v: number, blend = COVERAGE_BLEND_TILES): number {
  let d2 = Infinity;
  for (let k = 0; k < 8; k++) {
    if ((mask & (1 << k)) === 0) continue;
    const off = NEIGHBOURS[k]!;
    const du = off[0] > 0 ? (u < 1 ? 1 - u : 0) : off[0] < 0 ? (u > 0 ? u : 0) : 0;
    const dv = off[1] > 0 ? (v < 1 ? 1 - v : 0) : off[1] < 0 ? (v > 0 ? v : 0) : 0;
    const e = du * du + dv * dv;
    if (e < d2) d2 = e;
  }
  const d = Math.sqrt(d2);
  return smootherstep01(d >= blend ? 1 : d / blend);
}
