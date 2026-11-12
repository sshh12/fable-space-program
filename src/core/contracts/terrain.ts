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
  /**
   * WebP image, 256 x 256, OPAQUE sRGB colour (extension "webp"). Image tiles never carry alpha: lossy WebP
   * rewrites colour under transparent pixels and browsers premultiply on decode, so masks are separate
   * frt1-u8 layers. Decode with createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' }).
   */
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
  /**
   * `height` layer only, optional: where each sparse level holds data GENUINELY FINER than its parent level.
   * Key = level (decimal string, a sparse level); value = rectangles of tiles, every one of them inside
   * `coverage` of that level (a manifest that lists a source tile outside the coverage, or at a global
   * level, is rejected). Bakes extend `coverage` one tile or more beyond the area their source data covers
   * and fill that margin with parent-identical (upsampled) data, so that the run-time blend ring lies on
   * data that equals the parent; `sourceCoverage` lists the tiles touching the area where the level's
   * source has a non-zero weight AND resolves wavelengths below the parent level's (a source coarser than
   * the parent level's posting adds nothing: such a level lists `[]`, or is left out).
   *
   * The height authority keys the effective level E on these rectangles (see SOURCE_BLEND_TILES), so
   * procedural amplification is replaced exactly where real detail begins; the data blend D,
   * `layerHasTile` and residency keep using `coverage`. Absent field = every sparse level is finer than its
   * parent over its whole coverage (E keys on `coverage`, the COVERAGE_BLEND_TILES recursion). When the
   * field is present, a sparse level without a key, or with an empty list, has no finer data anywhere.
   */
  sourceCoverage?: Record<string, TileRect[]>;
  /** frt1-height only: preferred metres-per-count per level (index = level); tiles may use a coarser power of two. */
  heightScales?: number[];
  /** frt1-u8 only: meaning of the byte values, e.g. land-cover class ids, or { land: 0, water: 255 }. */
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
  /** Layer name -> description. Standard names: height, albedo, watermask, night, landcover. */
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

/**
 * Standard layer names. A tile set may omit layers that make no sense for the body.
 * `watermask` (frt1-u8, 256 x 256, same coverage as `albedo`): 0 = land, 255 = open water, values between
 * for anti-aliased shorelines. Render-only (physics decides water from the height, ARCHITECTURE section 1).
 */
export const TILE_LAYER = { height: 'height', albedo: 'albedo', watermask: 'watermask', night: 'night', landcover: 'landcover' } as const;

/**
 * Width, in tiles of the level in question, of the ring along the edge of SPARSE coverage over which that
 * level's data is blended into its parent level (64 samples of a 256-cell tile).
 *
 * Coverage weight w_L(p) of level L at a point p (a pure function of the manifest, never of residency):
 *   - L <= globalMaxLevel: 1.   No level-L tile contains p: 0.
 *   - otherwise, with (u, v) in [0,1]^2 the coordinates of p in its level-L tile T:
 *       d = the smallest Euclidean distance, in tile units, from (u, v) to the unit square of any of the 8
 *           neighbouring level-L tile positions that the manifest does NOT contain (neighbours across a cube
 *           edge are found by mapping a point just beyond T's edge through dirToTile); Infinity if none;
 *       w_L = smootherstep(min(1, d / COVERAGE_BLEND_TILES)),  smootherstep(x) = x^3 (6 x^2 - 15 x + 10).
 * w_L is C2-continuous, 0 on the coverage boundary and 1 from a quarter tile inside it.
 *
 * Data height:      D_g = bicubic(level g = globalMaxLevel),  D_L = D_(L-1) + w_L (bicubic_L - D_(L-1)).
 * Effective level:  E_g = g,                                  E_L = E_(L-1) + s_L (L - E_(L-1)),
 *                   s_L = w_L when the height layer has no `sourceCoverage`; otherwise the SOURCE weight of
 *                   SOURCE_BLEND_TILES below.
 * So the surface is exactly the parent-level surface on a coverage boundary: no wall where high-resolution
 * regions end, whatever the two sources disagree by. The effective level (fractional) is what procedural
 * amplification keys its octave and crater-size weights on, so synthetic detail also fades smoothly there.
 * Bakes keep regions of interest at least COVERAGE_BLEND_TILES inside their coverage rectangles.
 */
export const COVERAGE_BLEND_TILES = 0.25;

/**
 * Width, in tiles of the level in question, of the ring inside a `TileLayerManifest.sourceCoverage` boundary
 * over which the effective level E rises to that level.
 *
 * Source weight s_L(p): computed exactly like the coverage weight w_L above, but on the rectangles of
 * `sourceCoverage[L]` instead of `coverage[L]` (0 where no source tile of level L contains p, and for a
 * level with no source tiles) and rising over SOURCE_BLEND_TILES instead of COVERAGE_BLEND_TILES:
 *   s_L = smootherstep(min(1, d / SOURCE_BLEND_TILES)).
 * Like w_L it is a pure function of the manifest. One tile, not a quarter: source rectangles are
 * tile-granular, so the real detail begins anywhere in the outermost source tile and fades in over the
 * bake's feather (measured on the Moon: 0.1-0.3 of its full value 0.2-0.3 tile inside the source boundary,
 * about 0.5 at half a tile, 0.8-1 at one tile); a quarter-tile ring switched the procedural detail off half
 * a tile before the real detail arrived.
 *
 * Consequences: inside a coverage margin (covered, but outside the source rectangles) the data equals the
 * parent's and E stays at the parent level, so the parent's procedural detail continues unchanged up to
 * where real data replaces it. Regions of interest (landing sites, the pad) lie at least SOURCE_BLEND_TILES
 * inside the source rectangles of every level they rely on.
 */
export const SOURCE_BLEND_TILES = 1;

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

/**
 * Where tile bytes come from (v2; ARCHITECTURE 10.2, 10.4). Plain data, so a tile worker receives it in its
 * init message and the same worker code streams from any source. `createTileSource(spec)` in src/terrain
 * turns it into a `TileSource`.
 *   fs     a directory of plain tile files (Node only: vitest and tools)
 *   fetch  plain files over HTTP (the dev server's /tiles)
 *   pack   content-addressed, range-readable packs from an ordered mirror list (production and the local
 *          stack). `packListUrl` answers with the pack list: the mirrors in order, their addressing mode and
 *          slice size, and per tile set the index location; nothing of it is compiled into the client.
 *          `cache` adds the OPFS cache in front of the network (absent or null = none).
 * `TilePackIndex` (the index format) is defined by `platform-delivery` in src/terrain/packIndex.ts and
 * lifted into this file by the lead afterwards.
 */
export type TileSourceSpec =
  | { kind: 'fs'; root: string }
  | { kind: 'fetch'; baseUrl: string }
  | { kind: 'pack'; packListUrl: string; cache?: { kind: 'opfs'; maxBytes: number } | null };

export type SurfaceKind = 'land' | 'water';

/** Where the terrain under a point currently stands in terms of loaded detail. */
export interface TerrainResidency {
  /** Deepest data level resident at the point, and the deepest level the manifest offers there. */
  residentLevel: number;
  availableLevel: number;
  /**
   * Fractional effective data level E at the point (see COVERAGE_BLEND_TILES and SOURCE_BLEND_TILES): the
   * level whose real detail the surface carries there. It equals `availableLevel` well inside the source
   * rectangles of every level (at least SOURCE_BLEND_TILES from their boundary; without `sourceCoverage`,
   * COVERAGE_BLEND_TILES inside the coverage). It is LOWER, by design, in a coverage margin and at a level
   * whose source is no finer than its parent: tiles of `availableLevel` exist and are loaded there, but
   * they hold parent-identical data, and procedural amplification fills in from E down.
   */
  effectiveLevel: number;
  /** True when every level that contributes at the point is resident (collision uses final data). */
  complete: boolean;
}

/**
 * THE height authority. One implementation (src/terrain) serves physics (collision, radar altitude, impact
 * prediction), tile baking for the renderer (in workers) and rock/crater placement. Requirements:
 *  - Deterministic and pure given the same resident data; never throws for a valid direction.
 *  - height = data height D (Catmull-Rom bicubic of the data tiles, blended across the edges of sparse
 *    coverage exactly as specified at COVERAGE_BLEND_TILES) + site/terrain modifiers + band-limited
 *    procedural amplification with wavelengths >= lambdaMin. The function is continuous everywhere:
 *    across tiles, cube faces, coverage edges, and in lambdaMin.
 *  - With `lambdaMin` omitted the COLLISION SURFACE is returned: the bilinear interpolation of the height
 *    function sampled on the vertex grid of the body's max-render-level tiles (65 x 65 vertices per tile,
 *    band limit = 2 quads). That is exactly the mesh the renderer draws at full detail, so legs, wheels and
 *    boots touch what is drawn (difference < 3 cm). Collision vertices are evaluated LAZILY, one at a
 *    time, and memoised: a collision query evaluates at most the 4 vertices of the quad it falls in (well
 *    under 0.1 ms the first time, a table lookup afterwards). No query ever builds a whole 65 x 65 grid.
 *  - With `lambdaMin` given, the height function is evaluated analytically with amplification wavelengths
 *    >= lambdaMin only (cost falls as lambdaMin grows); used for altimetry, prediction and tile baking.
 *  - Amplification starts below the data resolution that the MANIFEST offers at the point (its fractional
 *    effective level E, which varies smoothly across coverage edges), not below the level that happens to
 *    be resident, so detail never doubles up while finer data is streaming and never ends at a wall.
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
  /**
   * Load (and keep resident until the next call for the same `slot`) every data tile the height function
   * reads within `radius` metres of the point, at all contributing levels. `slot` names the requester's
   * purpose ("vessel:<id>", "impact", "pad") so that a moving vessel replaces its own pin instead of
   * accumulating pins. Resolves when all of it is resident.
   */
  ensureLoaded(bodyId: string, dir: Vec3, radius: number, slot?: string): Promise<void>;
  /**
   * Evaluate up to `maxVertices` not-yet-memoised collision-surface vertices within `radius` metres of the
   * point, nearest first, and return how many are still missing. Deterministic (a count budget, no clock).
   * Lets the sim spread the cost of warming the touchdown area over many steps before contact.
   */
  prewarmCollision(bodyId: string, dir: Vec3, radius: number, maxVertices: number): number;
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
