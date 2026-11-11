/**
 * Per-tile instance records (the CPU side of `TileRecord` in shaders/common.ts): the constant rows are
 * built once when a tile is first drawn, the two camera-dependent rows are written every frame.
 */
import { COVERAGE_BLEND_TILES, layerHasTile, type TileLayerManifest } from '@/core/contracts/terrain';
import { dirToFaceSt, type FaceId } from '@/core/geo/cubeSphere';
import type { Vec3 } from '@/core/math';
import { NIGHT_DARK, type BodyQuadtree, type TileNode } from './quadtree';
import { RECORD_FLOATS } from './shaders/common';
import { NOISE_PERIOD } from './shaders/surface';
import { frameDir } from './tileMath';


export interface PadDisc {
  /** Centre of the apron in the body-fixed frame (m) and its radius (m). */
  centre: Vec3;
  radius: number;
}

export interface RecordContext {
  tree: BodyQuadtree;
  /** Tiling lengths of the three detail scales, m. */
  detailScales: readonly [number, number, number];
  /** Base wavelength of the orbital noise, m. */
  orbitalWavelength: number;
  pads: readonly PadDisc[];
  /** Imagery (albedo) layer of the body's tile set. */
  albedoLayer: TileLayerManifest;
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
 * Constant rows of the record of a READY tile whose ancestors are READY. Rows 0 and 1 (camera-dependent)
 * are left zero.
 */
export function buildRecordConstants(n: TileNode, ctx: RecordContext): Float32Array {
  const f = new Float32Array(RECORD_FLOATS);
  const i = new Int32Array(f.buffer);
  const tree = ctx.tree;
  const fr = n.frame;
  const parent = n.parent ?? n;
  const size = tree.faceSize / 2 ** n.level;
  // rows 2..4: frame
  f.set([fr.cHat.x, fr.cHat.y, fr.cHat.z, n.h0], 8);
  f.set([fr.a.x, fr.a.y, fr.a.z, 0.015 * size + 0.1], 12);
  f.set([fr.b.x, fr.b.y, fr.b.z, n.level], 16);
  // row 5: layers
  i.set([n.heightLayer, parent.heightLayer, n.normalLayer, parent.normalLayer], 20);
  // row 6: images
  const io = n.imageOwner!;
  const pio = parent.imageOwner ?? io;
  const no = n.nightOwner;
  const pno = parent.nightOwner ?? no;
  const nightLayer = (o: TileNode | null): number => (o && o.nightLayer >= 0 ? o.nightLayer : -1);
  i.set([io.imageLayer, pio.imageLayer, nightLayer(no), nightLayer(pno)], 24);
  // row 7: parent uv, slope scales
  f.set([(n.key.x & 1) * 0.5, (n.key.y & 1) * 0.5, n.slopeScale, parent.slopeScale], 28);
  if (n.level === 0) f.set([0, 0], 28);
  // rows 8..11: image and night uv transforms
  uvInto(n, io, f, 32);
  uvInto(n, pio, f, 36);
  if (no) uvInto(n, no, f, 40);
  if (pno) uvInto(n, pno, f, 44);
  // rows 12..15: planet-fixed tiling origins and the imagery level at the corners
  const o = n.origin;
  const corner = (u: number, v: number): number => imageryLevelAt(ctx.albedoLayer, frameDir(fr, u, v));
  const s = ctx.detailScales;
  f.set([mod(o.x, s[0]), mod(o.y, s[0]), mod(o.z, s[0]), corner(0, 0)], 48);
  f.set([mod(o.x, s[1]), mod(o.y, s[1]), mod(o.z, s[1]), corner(1, 0)], 52);
  f.set([mod(o.x, s[2]), mod(o.y, s[2]), mod(o.z, s[2]), corner(0, 1)], 56);
  const w = ctx.orbitalWavelength;
  f.set([mod(o.x / w, NOISE_PERIOD), mod(o.y / w, NOISE_PERIOD), mod(o.z / w, NOISE_PERIOD), corner(1, 1)], 60);
  // row 16: nearest launch-pad apron
  let best: PadDisc | null = null;
  let bestD = Infinity;
  for (const p of ctx.pads) {
    const d = Math.hypot(p.centre.x - o.x, p.centre.y - o.y, p.centre.z - o.z);
    if (d < bestD && d < p.radius + 2 * size + 50) {
      best = p;
      bestD = d;
    }
  }
  if (best) f.set([best.centre.x - o.x, best.centre.y - o.y, best.centre.z - o.z, best.radius], 64);
  // row 17: flags
  i[68] = (pio !== io ? 1 : 0) | (nightLayer(pno) !== nightLayer(no) || pno !== no ? 2 : 0);
  return f;
}

/** Layer value for "this tile's night image is dark". Re-exported for the streamer. */
export { NIGHT_DARK };
