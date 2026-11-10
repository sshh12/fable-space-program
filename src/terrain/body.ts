/**
 * Per-body runtime state of the height authority: manifest layers and coverage, the amplification model,
 * modifiers, evaluators and the services models call back into.
 */
import type { BodyDef, LaunchSiteDef } from '../core/contracts/defs';
import type { TileManifest } from '../core/contracts/terrain';
import { LANDCOVER_CLASS } from '../core/contracts/terrain';
import { CUBE_FACES, dirToTile, type FaceId } from '../core/geo/cubeSphere';
import { IMAGE_TILE_SIZE } from '../core/geo/tileCodec';
import type { Vec3 } from '../core/math/vec3';
import { createAmplificationModel } from './amplification/registry';
import { tilesInDisc } from './discTiles';
import type { AmplificationModel, BodyServices } from './amplification/types';
import { LayerCoverage } from './coverage';
import { HeightEvaluator, type EvalBody } from './evaluator';
import { buildFlattenDiscs, flattenWeight, type FlattenDisc } from './modifiers';
import { LayerRef, type TileRequest, type TileStore } from './tileStore';
import { meanTileSizeAt } from './util';

/** Divisors of the tile size giving the band limits of baked geometry (2 quads) and normal maps (2 texels). */
export const GEOMETRY_BAND_DIVISOR = 32;
export const NORMAL_BAND_DIVISOR = 128;
/** Vertices per side of a geometry tile (64 x 64 quads). */
export const GEOMETRY_GRID = 65;
export const GEOMETRY_QUADS = 64;
/** Texels per side of a normal/material map. */
export const NORMAL_MAP_SIZE = 256;

export class BodyTerrain implements EvalBody {
  readonly id: string;
  readonly radius: number;
  readonly lambda0: number;
  readonly log2Lambda0: number;
  readonly g: number;
  readonly heightCov: LayerCoverage;
  readonly heightRef: LayerRef;
  readonly lcCov: LayerCoverage | null;
  readonly lcRef: LayerRef | null;
  readonly lcClassCount: number;
  readonly model: AmplificationModel;
  readonly discs: FlattenDisc[];
  readonly ampMaxLog2: number;
  active: HeightEvaluator | null = null;
  readonly maxRenderLevel: number;
  /** Band limit (log2 m) of the collision surface: the geometry band of maxRenderLevel tiles. */
  readonly collisionLog2Lambda: number;
  readonly residentLevel: number;
  readonly seaLevel: number | null;
  readonly services: BodyServices;
  /** Evaluator for public point queries. */
  readonly main: HeightEvaluator;
  /** Evaluator used by service calls (never the one being evaluated). */
  private readonly aux: HeightEvaluator;
  /** Evaluator for collision vertices and bakes. */
  readonly vertexEval: HeightEvaluator;
  /** Evaluator of the finite-difference data slope (dataScale) of the other evaluators. */
  readonly slopeEval: HeightEvaluator;

  constructor(
    readonly def: BodyDef,
    readonly manifest: TileManifest,
    readonly store: TileStore,
    sites: readonly LaunchSiteDef[],
    residentLevelOverride: number | undefined,
  ) {
    const terrain = def.terrain;
    if (!terrain) throw new Error(`body "${def.id}" has no terrain definition`);
    this.id = def.id;
    this.radius = def.radius;
    if (Math.abs(manifest.radius - def.radius) > 1) {
      throw new Error(`tile set "${terrain.tileset}": manifest radius ${manifest.radius} m does not match bodies/${def.id}.json radius ${def.radius} m`);
    }
    const hl = manifest.layers['height'];
    if (!hl || hl.encoding !== 'frt1-height') throw new Error(`tile set "${terrain.tileset}": no frt1-height "height" layer`);
    this.heightCov = new LayerCoverage(hl);
    this.heightRef = new LayerRef(terrain.tileset, 'height', 'height', this.heightCov, 1);
    this.g = hl.globalMaxLevel;
    this.lambda0 = (Math.PI * this.radius) / 256;
    this.log2Lambda0 = Math.log2(this.lambda0);
    this.lcClassCount = Math.max(...Object.values(LANDCOVER_CLASS)) + 1;
    this.maxRenderLevel = terrain.maxRenderLevel;
    this.collisionLog2Lambda = Math.log2(meanTileSizeAt(this.radius, this.maxRenderLevel) / GEOMETRY_BAND_DIVISOR);
    this.residentLevel = Math.min(this.g, residentLevelOverride ?? manifest.residentHeightLevel);
    this.seaLevel = def.ocean ? def.ocean.seaLevel : null;
    this.discs = buildFlattenDiscs(def, sites);

    this.services = {
      bodyId: def.id,
      radius: this.radius,
      seaLevel: this.seaLevel,
      flattenAt: (x, y, z) => {
        if (this.discs.length === 0) return 0;
        const l = Math.sqrt(x * x + y * y + z * z);
        return flattenWeight(this.discs, x / l, y / l, z / l, this.radius);
      },
      effectiveLevelAt: (x, y, z) => {
        const l = Math.sqrt(x * x + y * y + z * z);
        this.aux.setDir(x / l, y / l, z / l);
        return this.aux.effectiveLevel();
      },
      landcoverAt: (x, y, z, out) => {
        if (!this.lcRef) return 0;
        const l = Math.sqrt(x * x + y * y + z * z);
        const a = this.aux;
        a.setDir(x / l, y / l, z / l);
        a.incomplete = false;
        a.landcoverWeights(this.log2Lambda0 - a.effectiveLevel(), out);
        if (!a.incomplete) return 1;
        if (this.active) this.active.incomplete = true;
        return 2;
      },
      dataGeneration: () => this.dataGeneration(),
      markIncomplete: () => {
        if (this.active) this.active.incomplete = true;
      },
    };

    // The model must exist before the evaluators (they size their buffers from it).
    const finest = Math.log2(meanTileSizeAt(this.radius, this.maxRenderLevel) / NORMAL_BAND_DIVISOR);
    this.model = createAmplificationModel(terrain.amplification, {
      services: this.services,
      globalMaxLevel: this.g,
      log2FinestLambda: finest,
      lambda0: this.lambda0,
    });
    const ll = manifest.layers['landcover'];
    if (this.model.usesLandcover && ll) {
      if (ll.encoding !== 'frt1-u8') throw new Error(`tile set "${terrain.tileset}": landcover layer must be frt1-u8`);
      this.lcCov = new LayerCoverage(ll);
      this.lcRef = new LayerRef(terrain.tileset, 'landcover', 'u8', this.lcCov, 1);
    } else {
      this.lcCov = null;
      this.lcRef = null;
    }
    this.ampMaxLog2 = this.model.maxLengthLog2(this.log2Lambda0 - this.g);
    this.main = new HeightEvaluator(this);
    this.aux = new HeightEvaluator(this);
    this.vertexEval = new HeightEvaluator(this);
    this.slopeEval = new HeightEvaluator(this);
  }

  /** Mean tile size of a level, m. */
  tileSize(level: number): number {
    return meanTileSizeAt(this.radius, level);
  }

  /** Data generation: changes whenever any tile of this body becomes resident or is evicted. */
  dataGeneration(): number {
    return this.heightRef.generation + (this.lcRef ? this.lcRef.generation * 4096 : 0);
  }

  /** Requests for every tile of levels 0..level (all faces) of the height layer and land cover. */
  pyramidRequests(level: number): TileRequest[] {
    const out: TileRequest[] = [];
    const push = (ref: LayerRef, cov: LayerCoverage, maxL: number): void => {
      for (let l = 0; l <= Math.min(maxL, cov.globalMaxLevel); l++) {
        const n = 2 ** l;
        for (let face = 0; face < 6; face++) for (let x = 0; x < n; x++) for (let y = 0; y < n; y++) out.push({ ref, level: l, face, x, y });
      }
    };
    push(this.heightRef, this.heightCov, level);
    if (this.lcRef && this.lcCov) push(this.lcRef, this.lcCov, level);
    return out;
  }

  /**
   * Tiles of every layer and level the height function can read within `radius` m of `dir` (all band
   * limits): levels 0..maxLevel of the height layer (and land cover when used), each tile that intersects
   * the disc widened by `margin` m.
   */
  discRequests(dir: Vec3, radius: number, margin: number, maxLevel = Infinity): TileRequest[] {
    const out: TileRequest[] = [];
    const layers: [LayerRef, LayerCoverage, number][] = [[this.heightRef, this.heightCov, 0]];
    // Land cover is cell-registered: its bilinear weights reach half a texel into neighbour tiles.
    if (this.lcRef && this.lcCov) layers.push([this.lcRef, this.lcCov, 1]);
    for (const [ref, cov, texelMargin] of layers) {
      for (let level = 0; level <= Math.min(cov.maxLevel, maxLevel); level++) {
        const r = radius + margin + texelMargin * (this.tileSize(level) / IMAGE_TILE_SIZE);
        for (const k of tilesInDisc(dir, r, level, this.radius, (f, x, y) => cov.has(level, f, x, y))) out.push({ ref, level, face: k.face, x: k.x, y: k.y });
      }
    }
    return out;
  }

  /**
   * Tiles the bakers read for render tile (face, level, x, y): levels 0..min(level, maxLevel) of every layer,
   * over the tile widened by `marginTiles` (fraction of the tile) on every side.
   */
  tileRequests(face: FaceId, level: number, x: number, y: number, marginTiles: number): TileRequest[] {
    const out: TileRequest[] = [];
    const layers: [LayerRef, LayerCoverage][] = [[this.heightRef, this.heightCov]];
    if (this.lcRef && this.lcCov) layers.push([this.lcRef, this.lcCov]);
    const n = 2 ** level;
    const N = 12;
    for (const [ref, cov] of layers) {
      for (let l = 0; l <= Math.min(level, cov.maxLevel); l++) {
        const seen = new Set<string>();
        for (let a = 0; a <= N; a++) {
          for (let b = 0; b <= N; b++) {
            const u = -marginTiles + ((1 + 2 * marginTiles) * a) / N;
            const v = -marginTiles + ((1 + 2 * marginTiles) * b) / N;
            const s = -1 + (2 * (x + u)) / n;
            const t = -1 + (2 * (y + v)) / n;
            const d = faceStDir(face, s, t);
            const k = dirToTile(d, l);
            if (!cov.has(l, k.key.face, k.key.x, k.key.y)) continue;
            const key = `${k.key.face}/${k.key.x}/${k.key.y}`;
            if (seen.has(key)) continue;
            seen.add(key);
            out.push({ ref, level: l, face: k.key.face, x: k.key.x, y: k.key.y });
          }
        }
      }
    }
    return out;
  }
}

/** Unit direction of face coordinates (s, t), which may lie beyond the face (normalised cube point). */
export function faceStDir(face: FaceId, s: number, t: number): Vec3 {
  const f = CUBE_FACES[face]!;
  const x = f.n[0] + s * f.u[0] + t * f.v[0];
  const y = f.n[1] + s * f.u[1] + t * f.v[1];
  const z = f.n[2] + s * f.u[2] + t * f.v[2];
  const l = Math.sqrt(x * x + y * y + z * z);
  return { x: x / l, y: y / l, z: z / l };
}
