/**
 * Per-tile records (the CPU side of `TileRecord` in shaders/common.ts): the constants of a resident tile,
 * built once when it is first drawn. What changes with the camera is `TileFrame`, written by the feature.
 */
import { COVERAGE_BLEND_TILES, layerHasTile, type TileLayerManifest } from '@/core/contracts/terrain';
import { dirToFaceSt, type FaceId } from '@/core/geo/cubeSphere';
import type { Vec3 } from '@/core/math';
import { NIGHT_DARK, type BodyQuadtree, type TileNode } from './quadtree';
import { RECORD_FLOATS } from './shaders/common';
import { HEX_PERIOD, NOISE_PERIOD } from './shaders/surface';
import { frameDir, snapDirection } from './tileMath';


export interface SiteDisc {
  /** Pad centre of a launch site in the body-fixed frame (m), and the reach of its ground plan from there (m). */
  centre: Vec3;
  radius: number;
  /** Index of the site in the material uniform's site tables. */
  index: number;
}

export interface RecordContext {
  tree: BodyQuadtree;
  /** Tiling lengths of the four detail scales, m. */
  detailScales: readonly [number, number, number, number];
  /** Base wavelength of the orbital noise, m. */
  orbitalWavelength: number;
  pads: readonly SiteDisc[];
  /** Imagery (albedo) layer of the body's tile set. */
  albedoLayer: TileLayerManifest;
  /** Night-light layer as the renderer reads it, when the body shows night lights. */
  nightLayer: TileLayerManifest | undefined;
}

const mod = (x: number, p: number): number => ((x % p) + p) % p;
const smootherstep = (x: number): number => x * x * x * (x * (x * 6 - 15) + 10);

/**
 * Coverage weight w_L of a sparse level at a point given by face coordinates: exactly the definition at
 * COVERAGE_BLEND_TILES in src/core/contracts/terrain.ts, for neighbours on the same cube face (sparse
 * imagery lies far inside a face; a neighbour position beyond the face edge counts as missing).
 */
export function coverageWeight(layer: TileLayerManifest, face: FaceId, level: number, s: number, t: number): number {
  if (level <= layer.globalMaxLevel) return 1;
  const n = 2 ** level;
  const fx = Math.min(n - 1e-9, Math.max(0, ((s + 1) / 2) * n));
  const fy = Math.min(n - 1e-9, Math.max(0, ((t + 1) / 2) * n));
  const x = Math.floor(fx);
  const y = Math.floor(fy);
  if (!layerHasTile(layer, { face, level, x, y })) return 0;
  const u = fx - x;
  const v = fy - y;
  let d = Infinity;
  for (let j = -1; j <= 1; j++) {
    for (let i = -1; i <= 1; i++) {
      if (i === 0 && j === 0) continue;
      const nx = x + i;
      const ny = y + j;
      if (nx >= 0 && ny >= 0 && nx < n && ny < n && layerHasTile(layer, { face, level, x: nx, y: ny })) continue;
      // Distance from (u, v) to the unit square of the missing neighbour at offset (i, j).
      const dx = i < 0 ? u : i > 0 ? 1 - u : 0;
      const dy = j < 0 ? v : j > 0 ? 1 - v : 0;
      d = Math.min(d, Math.hypot(dx, dy));
    }
  }
  return smootherstep(Math.min(1, d / COVERAGE_BLEND_TILES));
}

/**
 * Fractional level whose detail the imagery really carries at a direction: bakes feather each sparse
 * imagery level into its parent over the outer quarter tile of its coverage (ARCHITECTURE 7.1), which is the
 * recursion E_L = E_(L-1) + w_L (L - E_(L-1)) on the imagery layer's own coverage.
 */
export function imageryLevelAt(layer: TileLayerManifest, dir: Vec3): number {
  let e = layer.globalMaxLevel;
  const levels = Object.keys(layer.coverage)
    .map(Number)
    .filter((l) => l > layer.globalMaxLevel && (layer.coverage[String(l)]?.length ?? 0) > 0)
    .sort((a, b) => a - b);
  if (levels.length === 0) return e;
  const { face, s, t } = dirToFaceSt(dir);
  for (const level of levels) {
    const w = coverageWeight(layer, face, level, s, t);
    if (w <= 0) break;
    e += w * (level - e);
  }
  return e;
}

/** The ancestor of `n` (or `n`) at `level`. */
function ancestorAt(n: TileNode, level: number): TileNode {
  let a = n;
  while (a.level > level && a.parent) a = a.parent;
  return a;
}

/** Deepest level <= the tile's level at which `layer` has data over the tile. */
function dataLevel(layer: TileLayerManifest, n: TileNode): number {
  let k = n.key;
  while (k.level > 0 && !layerHasTile(layer, k)) k = { face: k.face, level: k.level - 1, x: k.x >> 1, y: k.y >> 1 };
  return k.level;
}

/** Does this tile fetch image data of its own for `layer` (its level has a data tile there)? */
export function ownsData(layer: TileLayerManifest | undefined, n: TileNode): boolean {
  return layer !== undefined && layerHasTile(layer, n.key);
}

/** Resolve which nodes' image and night layers a ready tile samples. */
export function resolveOwners(n: TileNode, albedo: TileLayerManifest, night: TileLayerManifest | undefined): void {
  n.imageOwner = ancestorAt(n, dataLevel(albedo, n));
  n.nightOwner = night ? ancestorAt(n, dataLevel(night, n)) : null;
}

function uvInto(n: TileNode, owner: TileNode, out: Float32Array, o: number): void {
  const d = n.level - owner.level;
  const scale = 1 / 2 ** d;
  out[o] = (n.key.x - owner.key.x * 2 ** d) * scale;
  out[o + 1] = (n.key.y - owner.key.y * 2 ** d) * scale;
  out[o + 2] = scale;
  out[o + 3] = owner.level;
}

/**
 * The record of a READY tile whose ancestors are READY. Image owners of the tile and of its parent are
 * resolved here when they are not yet known: a parent that has never been drawn itself (a camera cut onto
 * resident tiles draws the children first) must still be the image the morph blends towards.
 */
export function buildRecordConstants(n: TileNode, ctx: RecordContext): Float32Array {
  const f = new Float32Array(RECORD_FLOATS);
  const i = new Int32Array(f.buffer);
  const tree = ctx.tree;
  const fr = n.frame;
  const parent = n.parent ?? n;
  if (n.imageOwner === null) resolveOwners(n, ctx.albedoLayer, ctx.nightLayer);
  if (parent.imageOwner === null) resolveOwners(parent, ctx.albedoLayer, ctx.nightLayer);
  const size = tree.faceSize / 2 ** n.level;
  // rows 0..2: frame
  f.set([fr.cHat.x, fr.cHat.y, fr.cHat.z, n.h0], 0);
  f.set([fr.a.x, fr.a.y, fr.a.z, 0.015 * size + 0.1], 4);
  f.set([fr.b.x, fr.b.y, fr.b.z, n.level], 8);
  // row 3: layers
  i.set([n.heightLayer, parent.heightLayer, n.normalLayer, parent.normalLayer], 12);
  // row 4: images
  const io = n.imageOwner!;
  const pio = parent.imageOwner!;
  const no = n.nightOwner;
  const pno = parent.nightOwner;
  const nightLayer = (o: TileNode | null): number => (o && o.nightLayer >= 0 ? o.nightLayer : -1);
  i.set([io.imageLayer, pio.imageLayer, nightLayer(no), nightLayer(pno)], 16);
  // row 5: parent uv, slope scales
  f.set([(n.key.x & 1) * 0.5, (n.key.y & 1) * 0.5, n.slopeScale, parent.slopeScale], 20);
  if (n.level === 0) f.set([0, 0], 20);
  // rows 6..9: image and night uv transforms
  uvInto(n, io, f, 24);
  uvInto(n, pio, f, 28);
  if (no) uvInto(n, no, f, 32);
  if (pno) uvInto(n, pno, f, 36);
  // rows 10..13: planet-fixed tiling origins and the imagery level at the corners. The detail origins are
  // kept modulo HEX_PERIOD tiling lengths: the hexagon pattern that breaks the repetition has that period.
  const o = n.origin;
  const corner = (u: number, v: number): number => imageryLevelAt(ctx.albedoLayer, frameDir(fr, u, v));
  const s = ctx.detailScales.map((x) => x * HEX_PERIOD) as [number, number, number, number];
  f.set([mod(o.x, s[0]), mod(o.y, s[0]), mod(o.z, s[0]), corner(0, 0)], 40);
  f.set([mod(o.x, s[1]), mod(o.y, s[1]), mod(o.z, s[1]), corner(1, 0)], 44);
  f.set([mod(o.x, s[2]), mod(o.y, s[2]), mod(o.z, s[2]), corner(0, 1)], 48);
  const w = ctx.orbitalWavelength;
  f.set([mod(o.x / w, NOISE_PERIOD), mod(o.y / w, NOISE_PERIOD), mod(o.z / w, NOISE_PERIOD), corner(1, 1)], 52);
  // row 14: nearest launch site (its ground plan: concrete, gravel)
  let best: SiteDisc | null = null;
  let bestD = Infinity;
  for (const p of ctx.pads) {
    const d = Math.hypot(p.centre.x - o.x, p.centre.y - o.y, p.centre.z - o.z);
    if (d < bestD && d < p.radius + 2 * size + 50) {
      best = p;
      bestD = d;
    }
  }
  if (best) f.set([best.centre.x - o.x, best.centre.y - o.y, best.centre.z - o.z, best.radius], 56);
  // row 15: flags
  const [slideU, slideV] = snapDirection(n.key.face);
  i[60] = (pio !== io ? 1 : 0) | (nightLayer(pno) !== nightLayer(no) || pno !== no ? 2 : 0) | (slideU > 0 ? 4 : 0) | (slideV > 0 ? 8 : 0);
  // row 16: tiling origin of the fourth detail scale, and the site of row 14
  f.set([mod(o.x, s[3]), mod(o.y, s[3]), mod(o.z, s[3]), best ? best.index : 0], 64);
  return f;
}

/** Bit of the record's flag word: the parent samples another image than the tile (the morph blends the two). */
export const RECORD_FLAG_PARENT_IMAGE = 1;
/** Float index of the flag word in a record. */
export const RECORD_FLAGS_AT = 60;

/** Layer value for "this tile's night image is dark". Re-exported for the streamer. */
export { NIGHT_DARK };
