/**
 * Terrain data contracts: tile manifests, tile access, and the height authority that both the renderer
 * and the physics use. Implemented by src/terrain (CPU, no DOM/GPU); consumed by src/sim and src/render.
 */
import type { FaceId, TileKey } from '../geo/cubeSphere';
import type { Vec3 } from '../math/vec3';

/** Inclusive rectangle of tiles at one level on one face. */
export interface TileRect {
  face: FaceId;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export type TileLayerEncoding =
  /** FRT1 kind 1, zlib-compressed, 259 x 259 samples (extension "hgt"). Metres above the reference radius. */
  | 'frt1-height'
  /** FRT1 kind 2, zlib-compressed, 256 x 256 (extension "u8"). */
  | 'frt1-u8'
  /** WebP image, 256 x 256, sRGB colour; optional alpha with layer-specific meaning (extension "webp"). */
  | 'webp';

export interface TileLayerManifest {
  encoding: TileLayerEncoding;
  /** File extension without the dot. */
  ext: string;
  /** Every tile of levels 0..globalMaxLevel exists on all six faces. */
  globalMaxLevel: number;
  /**
   * Sparse deeper coverage. Key = level (as a decimal string); value = rectangles of existing tiles at that
   * level. The pyramid is complete: every listed tile's parent exists (via a rect one level up or the global
   * levels). A tile is fetchable iff level <= globalMaxLevel or it lies in a rect of its level.
   */
  coverage: Record<string, TileRect[]>;
  /** frt1-height only: preferred metres-per-count per level (index = level); tiles may use a coarser power of two. */
  heightScales?: number[];
  /** webp only: meaning of the alpha channel. */
  alpha?: 'none' | 'waterMask';
  /** frt1-u8 only: meaning of the byte values, e.g. land-cover class ids. */
  classes?: Record<string, number>;
  /** Data provenance for the credits screen. */
  sources: string[];
}

/** Whole-body rasters that are not tiled (equirectangular, row 0 = north, column 0 = lon -180). */
export interface GlobalMapManifest {
  /** Path relative to the tile set root. */
  path: string;
  width: number;
  height: number;
  /** Channel meaning, e.g. ["coverage", "cloudTop"] or ["r", "g", "b"]. */
  channels: string[];
  format: 'png' | 'webp';
}

/** /tiles/{tileset}/manifest.json */
export interface TileManifest {
  formatVersion: 1;
  tileset: string;
  /** Reference radius the heights are relative to, m. */
  radius: number;
  mapping: 'gnomonic-cube';
  /** Layer name -> description. Standard names: height, albedo, night, landcover. */
  layers: Record<string, TileLayerManifest>;
  globals: Record<string, GlobalMapManifest>;
  /** Coarse height pyramid level that is small enough to keep resident for the whole body (impact prediction). */
  residentHeightLevel: number;
  attribution: string[];
  /** Changes whenever tiles are re-baked (cache busting). */
  contentHash: string;
}

/**
 * Class ids of the standard `landcover` layer (frt1-u8, one channel). Bakes map their sources (ESA
 * WorldCover regionally, a documented colour/height heuristic globally) onto these ids; the terrain
 * amplification and the detail-material selection key off them.
 */
export const LANDCOVER_CLASS = {
  unknown: 0,
  water: 1,
  bareRock: 2,
  sand: 3,
  sparseScrub: 4,
  grass: 5,
  shrub: 6,
  trees: 7,
  crop: 8,
  builtUp: 9,
  snowIce: 10,
  wetland: 11,
} as const;
export type LandcoverClassName = keyof typeof LANDCOVER_CLASS;

/** Standard layer names. A tile set may omit layers that make no sense for the body. */
export const TILE_LAYER = { height: 'height', albedo: 'albedo', night: 'night', landcover: 'landcover' } as const;

/** Does `layer` contain tile `key`? Pure function of the manifest. */
export function layerHasTile(layer: TileLayerManifest, key: TileKey): boolean {
  if (key.level <= layer.globalMaxLevel) return true;
  const rects = layer.coverage[String(key.level)];
  if (!rects) return false;
  for (const r of rects) {
    if (r.face === key.face && key.x >= r.x0 && key.x <= r.x1 && key.y >= r.y0 && key.y <= r.y1) return true;
  }
  return false;
}

/** Deepest level <= maxLevel at which `layer` has a tile containing the given tile (walks up the pyramid). */
export function deepestAvailable(layer: TileLayerManifest, key: TileKey): TileKey {
  let k = key;
  while (k.level > 0 && !layerHasTile(layer, k)) k = { face: k.face, level: k.level - 1, x: k.x >> 1, y: k.y >> 1 };
  return k;
}

/**
 * Byte-level access to a tile root. Implementations: fetch-based (browser, workers) and fs-based (vitest,
 * tools). Returns the file exactly as stored (still zlib-compressed for FRT1 layers).
 */
export interface TileSource {
  manifest(tileset: string): Promise<TileManifest>;
  /** Resolves null when the manifest says the tile does not exist; rejects on I/O errors for tiles that should. */
  tile(tileset: string, layer: string, key: TileKey): Promise<Uint8Array | null>;
  /** Raw bytes of a global map or other file under the tile set root. */
  file(tileset: string, relPath: string): Promise<Uint8Array>;
}

export type SurfaceKind = 'land' | 'water';

/** Where the terrain under a point currently stands in terms of loaded detail. */
export interface TerrainResidency {
  /** Deepest data level resident at the point, and the deepest level the manifest offers there. */
  residentLevel: number;
  availableLevel: number;
  /** True when residentLevel === availableLevel (collision uses final data). */
  complete: boolean;
}

/**
 * THE height authority. One implementation (src/terrain) serves physics (collision, radar altitude, impact
 * prediction), tile baking for the renderer (in workers) and rock/crater placement. Requirements:
 *  - Deterministic and pure given the same resident data; never throws for a valid direction.
 *  - height = bicubic sample of the deepest resident data tile + site/terrain modifiers + band-limited
 *    procedural amplification with wavelengths >= lambdaMin.
 *  - With `lambdaMin` omitted the full collision detail is returned (finest amplification octave used for
 *    physics, about 0.3 m); the rendered max-level mesh must match it within 3 cm.
 *  - Synchronous: queries never wait for I/O. If finer data is still loading, the best resident ancestor
 *    is used (see residency()); callers that need final data await ensureLoaded() first.
 * All directions are unit vectors in the body-fixed frame; heights are metres above the reference radius.
 */
export interface TerrainProvider {
  heightAt(bodyId: string, dir: Vec3, lambdaMin?: number): number;
  /** Unit outward surface normal in the body-fixed frame, by central differences over `baseline` metres. */
  normalAt(bodyId: string, dir: Vec3, baseline: number): Vec3;
  /** 'water' where the body has an ocean and the solid surface is below sea level. */
  surfaceKind(bodyId: string, dir: Vec3): SurfaceKind;
  /** Load (and keep resident) the deepest data within `radius` metres of the point. */
  ensureLoaded(bodyId: string, dir: Vec3, radius: number): Promise<void>;
  residency(bodyId: string, dir: Vec3): TerrainResidency;
  /** Highest / lowest terrain anywhere on the body (from the definition), m. */
  elevationRange(bodyId: string): { min: number; max: number };
}

/** A collidable rock placed by the shared hash (same instances are drawn by the renderer). */
export interface RockInstance {
  /** Unit body-fixed direction of the rock's base point and its height above the reference radius. */
  dir: Vec3;
  baseHeight: number;
  /** Bounding radius, m. */
  radius: number;
  /** Mesh variant index and deterministic orientation/scale seed. */
  variant: number;
  seed: number;
}

/** Optional extension of the terrain authority for scattered surface objects. */
export interface RockField {
  /** All rocks with radius >= minRadius whose base lies within `radius` metres of `dir`. Deterministic. */
  rocksNear(bodyId: string, dir: Vec3, radius: number, minRadius: number): RockInstance[];
}
