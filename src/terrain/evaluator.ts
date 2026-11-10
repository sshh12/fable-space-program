/**
 * Point evaluation of the height function H = D + modifiers + amplification for one body.
 *
 * Data height D at band limit lambda (all lengths in metres, levels as in the manifest):
 *   lambda_L = data wavelength of level L (two texels) = lambda0 2^-L,  L_lambda = log2(lambda0 / lambda)
 *   beta_L   = smootherstep(L_lambda - L + 1)         (1 for L <= L_lambda, 0 for L >= L_lambda + 1)
 *   c_L      = beta_L * w_L                            (w_L = coverage weight, 1 for global levels)
 *   D        = chain over levels: D_base = bicubic_base, D_L = D_(L-1) + c_L (bicubic_L - D_(L-1))
 * with base = min(globalMaxLevel, floor(L_lambda)). Without a band limit (collision, full detail) every
 * beta is 1 and this is exactly the COVERAGE_BLEND_TILES recursion of terrain.ts. Band-limiting the data the
 * same way as the amplification is what makes coarse queries cheap and coarse render tiles independent of
 * fine data; it is C2 in lambda.
 * Effective level E: E = g, E_L = E_(L-1) + w_L (L - E_(L-1)) (manifest only).
 * Data scale: the chain at lambda_s = lambda_data(E) gives the data height and slope that drive the
 * amplification modulators (independent of the query's band limit).
 * Missing (not yet resident) tiles: the level's term is skipped (or the deepest resident ancestor stands in
 * for the base) and the evaluation is flagged incomplete.
 */
import { CUBE_FACES, type FaceId } from '../core/geo/cubeSphere';
import { IMAGE_TILE_SIZE } from '../core/geo/tileCodec';
import type { AmplificationModel, PointInfo } from './amplification/types';
import { bicubicSample } from './bicubic';
import type { LayerCoverage } from './coverage';
import { weightFromMask } from './coverage';
import { applyDiscs, flattenWeight, type FlattenDisc } from './modifiers';
import type { LayerRef, TileEntry, TileStore } from './tileStore';
import { smootherstep01, tileNumber } from './util';

/** What the evaluator needs to know about its body (BodyTerrain implements it). */
export interface EvalBody {
  readonly id: string;
  readonly radius: number;
  readonly log2Lambda0: number;
  readonly g: number;
  readonly heightCov: LayerCoverage;
  readonly heightRef: LayerRef;
  readonly lcCov: LayerCoverage | null;
  readonly lcRef: LayerRef | null;
  readonly lcClassCount: number;
  readonly store: TileStore;
  readonly model: AmplificationModel;
  readonly discs: readonly FlattenDisc[];
  /** 1 / meanTileSize per level (index = level). */
  readonly invTileSize: Float64Array;
  /** log2 of the longest amplification component anywhere (at E = g); band limits above it skip the model. */
  readonly ampMaxLog2: number;
  /** Evaluator currently running the model (service calls flag it incomplete). */
  active: HeightEvaluator | null;
}

const EPS1 = 1 - Number.EPSILON;
const MAXL = 32;

export class HeightEvaluator {
  face: FaceId = 0;
  s = 0;
  t = 0;
  dx = 1;
  dy = 0;
  dz = 0;
  px = 0;
  py = 0;
  pz = 0;
  /** Set when any tile needed by an evaluation since the last reset was not resident. */
  incomplete = false;

  private stamp = 1;
  private readonly idxStamp = new Int32Array(MAXL);
  private readonly lx = new Int32Array(MAXL);
  private readonly ly = new Int32Array(MAXL);
  private readonly lu = new Float64Array(MAXL);
  private readonly lv = new Float64Array(MAXL);
  // height samples per level for the current point
  private readonly hStamp = new Int32Array(MAXL);
  private readonly hEntry: (TileEntry | undefined)[] = new Array(MAXL).fill(undefined);
  private readonly hSmpStamp = new Int32Array(MAXL);
  private readonly hSmp = new Float64Array(3 * MAXL);
  private readonly hSlope = new Float64Array(MAXL);
  // per-level last-entry caches across points
  private readonly hLastNum = new Float64Array(MAXL).fill(-1);
  private readonly hLastEntry: (TileEntry | undefined)[] = new Array(MAXL).fill(undefined);
  private readonly lLastNum = new Float64Array(MAXL).fill(-1);
  private readonly lLastEntry: (TileEntry | undefined)[] = new Array(MAXL).fill(undefined);
  // coverage of the height layer for the current point
  private readonly w = new Float64Array(MAXL);
  private covDone = -1;
  private covEnd = false;
  private eStamp = 0;
  private eVal = 0;
  // data scale
  private dsStamp = 0;
  private dsHeight = 0;
  private dsSlope = 0;
  // scratch
  private readonly lcTmp: Float64Array;
  private readonly lcTmp2: Float64Array;
  readonly landcover: Float64Array;
  readonly mod: Float64Array;
  private readonly pt: PointInfo;
  private readonly bands = new Float64Array(4);
  private readonly amp = new Float64Array(4);
  private readonly data = new Float64Array(4);

  constructor(readonly body: EvalBody) {
    this.lcTmp = new Float64Array(Math.max(1, body.lcClassCount));
    this.lcTmp2 = new Float64Array(Math.max(1, body.lcClassCount));
    this.landcover = new Float64Array(Math.max(1, body.lcClassCount));
    this.mod = new Float64Array(Math.max(1, body.model.modulatorCount));
    this.pt = { px: 0, py: 0, pz: 0, E: 0, log2LambdaData: 0, dataHeight: 0, dataSlope: 0, landcover: body.lcRef ? this.landcover : null };
  }

  // ------------------------------------------------------------------------------------------- point

  private newPoint(): void {
    this.stamp++;
    if (this.stamp > 0x3fffffff) {
      this.stamp = 1;
      this.idxStamp.fill(0);
      this.hStamp.fill(0);
      this.hSmpStamp.fill(0);
      this.eStamp = 0;
      this.dsStamp = 0;
      this.modStamp = 0;
    }
    this.covDone = -1;
    this.covEnd = false;
  }

  /** Point from a unit body-fixed direction. */
  setDir(x: number, y: number, z: number): void {
    const ax = Math.abs(x);
    const ay = Math.abs(y);
    const az = Math.abs(z);
    let face: FaceId;
    if (ax >= ay && ax >= az) face = x >= 0 ? 0 : 1;
    else if (ay >= az) face = y >= 0 ? 2 : 3;
    else face = z >= 0 ? 4 : 5;
    const f = CUBE_FACES[face]!;
    const dn = x * f.n[0] + y * f.n[1] + z * f.n[2];
    this.face = face;
    this.s = (x * f.u[0] + y * f.u[1] + z * f.u[2]) / dn;
    this.t = (x * f.v[0] + y * f.v[1] + z * f.v[2]) / dn;
    this.dx = x;
    this.dy = y;
    this.dz = z;
    const R = this.body.radius;
    this.px = x * R;
    this.py = y * R;
    this.pz = z * R;
    this.newPoint();
  }

  /**
   * Point from face coordinates (exact affine tile parameters). Coordinates beyond the face are re-projected
   * onto the face that contains the direction.
   */
  setFaceSt(face: FaceId, s: number, t: number): void {
    const f = CUBE_FACES[face]!;
    const cx = f.n[0] + s * f.u[0] + t * f.v[0];
    const cy = f.n[1] + s * f.u[1] + t * f.v[1];
    const cz = f.n[2] + s * f.u[2] + t * f.v[2];
    const l = Math.sqrt(cx * cx + cy * cy + cz * cz);
    if (s < -1 || s > 1 || t < -1 || t > 1) {
      this.setDir(cx / l, cy / l, cz / l);
      return;
    }
    this.face = face;
    this.s = s;
    this.t = t;
    this.dx = cx / l;
    this.dy = cy / l;
    this.dz = cz / l;
    const R = this.body.radius;
    this.px = this.dx * R;
    this.py = this.dy * R;
    this.pz = this.dz * R;
    this.newPoint();
  }

  /** Tile indices and tile-local (u, v) of the point at `level` (same arithmetic as dirToTile). */
  private index(level: number): void {
    if (this.idxStamp[level] === this.stamp) return;
    this.idxStamp[level] = this.stamp;
    const n = 2 ** level;
    let fx = ((this.s + 1) / 2) * n;
    let fy = ((this.t + 1) / 2) * n;
    if (fx < 0) fx = 0;
    else if (fx > n * EPS1) fx = n * EPS1;
    if (fy < 0) fy = 0;
    else if (fy > n * EPS1) fy = n * EPS1;
    let x = Math.floor(fx);
    let y = Math.floor(fy);
    if (x > n - 1) x = n - 1;
    if (y > n - 1) y = n - 1;
    this.lx[level] = x;
    this.ly[level] = y;
    this.lu[level] = fx - x;
    this.lv[level] = fy - y;
  }

  tileX(level: number): number {
    this.index(level);
    return this.lx[level]!;
  }
  tileY(level: number): number {
    this.index(level);
    return this.ly[level]!;
  }

  // ----------------------------------------------------------------------------------------- coverage

  private ensureCoverage(level: number): void {
    const b = this.body;
    const max = Math.min(level, b.heightCov.maxLevel);
    while (this.covDone < max && !this.covEnd) {
      const L = this.covDone + 1;
      if (L <= b.g) {
        this.w[L] = 1;
        this.covDone = L;
        continue;
      }
      this.index(L);
      const x = this.lx[L]!;
      const y = this.ly[L]!;
      if (!b.heightCov.has(L, this.face, x, y)) {
        this.w[L] = 0;
        this.covEnd = true;
        break;
      }
      const mask = b.heightCov.missingMask(L, this.face, x, y);
      this.w[L] = mask === 0 ? 1 : weightFromMask(mask, this.lu[L]!, this.lv[L]!);
      this.covDone = L;
    }
  }

  /** Coverage weight w_L of the height layer at the current point. */
  coverage(level: number): number {
    if (level <= this.body.g) return 1;
    this.ensureCoverage(level);
    return level <= this.covDone ? this.w[level]! : 0;
  }

  /** Deepest height level with a tile at the current point. */
  availableLevel(): number {
    this.ensureCoverage(this.body.heightCov.maxLevel);
    return this.covDone;
  }

  /** Effective data level E (pure function of the manifest). */
  effectiveLevel(): number {
    if (this.eStamp === this.stamp) return this.eVal;
    const b = this.body;
    this.ensureCoverage(b.heightCov.maxLevel);
    let E = b.g;
    for (let L = b.g + 1; L <= this.covDone; L++) E += this.w[L]! * (L - E);
    this.eStamp = this.stamp;
    this.eVal = E;
    return E;
  }

  // ----------------------------------------------------------------------------------- height samples

  private heightEntry(level: number): TileEntry | undefined {
    if (this.hStamp[level] === this.stamp) return this.hEntry[level];
    this.hStamp[level] = this.stamp;
    this.index(level);
    const num = tileNumber(level, this.face, this.lx[level]!, this.ly[level]!);
    let e = this.hLastEntry[level];
    if (this.hLastNum[level] !== num || !e || e.removed) {
      e = this.body.heightRef.maps[level]?.get(num);
      this.hLastNum[level] = num;
      this.hLastEntry[level] = e;
    }
    this.hEntry[level] = e;
    return e;
  }

  /** Bicubic of `level` at the point; false when not resident. `primary` marks the tile as used. */
  private sample(level: number, primary: boolean): boolean {
    const e = this.heightEntry(level);
    if (!e) return false;
    if (primary) e.lastUse = this.body.store.tick;
    if (e.state !== 'resident') return false;
    if (this.hSmpStamp[level] !== this.stamp) {
      this.hSmpStamp[level] = this.stamp;
      bicubicSample(e, this.lu[level]!, this.lv[level]!, this.hSmp, 3 * level);
      const gu = this.hSmp[3 * level + 1]!;
      const gv = this.hSmp[3 * level + 2]!;
      this.hSlope[level] = Math.sqrt(gu * gu + gv * gv) * this.body.invTileSize[level]!;
    }
    return true;
  }

  /** True when the height tile of `level` at the point is resident (no use marking). */
  heightResident(level: number): boolean {
    const e = this.heightEntry(level);
    return e !== undefined && e.state === 'resident';
  }

  /**
   * Data chain at band limit 2^log2Lambda; returns D and writes |grad D| (m/m, chain of per-level slope
   * magnitudes) to this.lastSlope. `stopLevel`: levels above it are left out (used by the bakers to split the
   * chain); Infinity = all.
   */
  dataChain(log2Lambda: number, stopLevel = Infinity): number {
    const b = this.body;
    const Ll = b.log2Lambda0 - log2Lambda;
    const fl = Math.floor(Ll);
    let base = Math.min(b.g, fl);
    if (base < 0) base = 0;
    if (base > stopLevel) base = stopLevel;
    let top = Math.min(b.heightCov.maxLevel, fl + 1, stopLevel);
    let D: number;
    let S: number;
    if (this.sample(base, true)) {
      D = this.hSmp[3 * base]!;
      S = this.hSlope[base]!;
    } else {
      this.incomplete = true;
      let L = base - 1;
      while (L >= 0 && !this.sample(L, false)) L--;
      if (L >= 0) {
        D = this.hSmp[3 * L]!;
        S = this.hSlope[L]!;
      } else {
        D = 0;
        S = 0;
      }
    }
    if (top > b.g) this.ensureCoverage(top);
    for (let L = base + 1; L <= top; L++) {
      const beta = smootherstep01(Ll - L + 1);
      if (beta === 0) break;
      let c = beta;
      if (L > b.g) {
        if (L > this.covDone) break;
        c *= this.w[L]!;
        if (c === 0) continue;
      }
      if (!this.sample(L, true)) {
        this.incomplete = true;
        continue;
      }
      D += c * (this.hSmp[3 * L]! - D);
      S += c * (this.hSlope[L]! - S);
    }
    this.lastSlope = S;
    return D;
  }
  lastSlope = 0;

  /** Data height and slope at the data scale (band limit = data wavelength at E). */
  dataScale(): void {
    if (this.dsStamp === this.stamp) return;
    const E = this.effectiveLevel();
    this.dsHeight = this.dataChain(this.body.log2Lambda0 - E);
    this.dsSlope = this.lastSlope;
    this.dsStamp = this.stamp;
  }
  get dataScaleHeight(): number {
    this.dataScale();
    return this.dsHeight;
  }

  /** True when every height tile the full-detail function reads at the point is resident. */
  heightComplete(): boolean {
    const b = this.body;
    if (!this.heightResident(b.g)) return false;
    this.ensureCoverage(b.heightCov.maxLevel);
    for (let L = b.g + 1; L <= this.covDone; L++) if (this.w[L]! > 0 && !this.heightResident(L)) return false;
    return true;
  }

  /** Deepest resident height level at the point. */
  residentLevel(): number {
    const b = this.body;
    this.ensureCoverage(b.heightCov.maxLevel);
    for (let L = this.covDone; L >= 0; L--) if (this.heightResident(L)) return L;
    return -1;
  }

  // ------------------------------------------------------------------------------------------ land cover

  private lcEntry(level: number, face: number, x: number, y: number): TileEntry | undefined {
    const num = tileNumber(level, face, x, y);
    let e = this.lLastEntry[level];
    if (this.lLastNum[level] !== num || !e || e.removed) {
      e = this.body.lcRef!.maps[level]?.get(num);
      this.lLastNum[level] = num;
      this.lLastEntry[level] = e;
    }
    return e;
  }

  /**
   * Class id of the land-cover texel (i, j) of tile (level, face, x, y), resolving neighbour tiles; -1 when a
   * needed tile is not resident. A neighbour the manifest does not contain (coverage edge, where the level's
   * weight goes to 0) is replaced by the nearest texel of the tile itself.
   */
  private lcTexel(level: number, face: FaceId, x: number, y: number, i: number, j: number, primary: boolean): number {
    const N = IMAGE_TILE_SIZE;
    if (i < 0 || i >= N || j < 0 || j >= N) {
      const k = this.lcNeighbour(level, face, x, y, i, j, primary);
      if (k !== -2) return k;
      return this.lcTexelIn(level, face, x, y, i < 0 ? 0 : i >= N ? N - 1 : i, j < 0 ? 0 : j >= N ? N - 1 : j, primary);
    }
    return this.lcTexelIn(level, face, x, y, i, j, primary);
  }

  /** Texel outside tile (x, y): class id, -1 when not resident, -2 when the neighbour tile does not exist. */
  private lcNeighbour(level: number, face: FaceId, x: number, y: number, i: number, j: number, primary: boolean): number {
    const N = IMAGE_TILE_SIZE;
    const n = 2 ** level;
    let tx = x;
    let ty = y;
    let ii = i;
    let jj = j;
    if (ii < 0) {
      tx--;
      ii += N;
    } else if (ii >= N) {
      tx++;
      ii -= N;
    }
    if (jj < 0) {
      ty--;
      jj += N;
    } else if (jj >= N) {
      ty++;
      jj -= N;
    }
    if (tx < 0 || tx >= n || ty < 0 || ty >= n) {
      // Across a cube edge: map the texel centre through the cube.
      const s = -1 + (2 * (x + (i + 0.5) / N)) / n;
      const t = -1 + (2 * (y + (j + 0.5) / N)) / n;
      const f = CUBE_FACES[face]!;
      const cx = f.n[0] + s * f.u[0] + t * f.v[0];
      const cy = f.n[1] + s * f.u[1] + t * f.v[1];
      const cz = f.n[2] + s * f.u[2] + t * f.v[2];
      const ax = Math.abs(cx);
      const ay = Math.abs(cy);
      const az = Math.abs(cz);
      const nf: FaceId = ax >= ay && ax >= az ? (cx >= 0 ? 0 : 1) : ay >= az ? (cy >= 0 ? 2 : 3) : cz >= 0 ? 4 : 5;
      const g = CUBE_FACES[nf]!;
      const dn = cx * g.n[0] + cy * g.n[1] + cz * g.n[2];
      const s2 = (cx * g.u[0] + cy * g.u[1] + cz * g.u[2]) / dn;
      const t2 = (cx * g.v[0] + cy * g.v[1] + cz * g.v[2]) / dn;
      const fx = Math.min(Math.max(((s2 + 1) / 2) * n, 0), n * EPS1);
      const fy = Math.min(Math.max(((t2 + 1) / 2) * n, 0), n * EPS1);
      tx = Math.min(Math.floor(fx), n - 1);
      ty = Math.min(Math.floor(fy), n - 1);
      ii = Math.min(N - 1, Math.floor((fx - tx) * N));
      jj = Math.min(N - 1, Math.floor((fy - ty) * N));
      if (!this.body.lcCov!.has(level, nf, tx, ty)) return -2;
      return this.lcTexelIn(level, nf, tx, ty, ii, jj, primary);
    }
    if (!this.body.lcCov!.has(level, face, tx, ty)) return -2;
    return this.lcTexelIn(level, face, tx, ty, ii, jj, primary);
  }

  private lcTexelIn(level: number, face: number, x: number, y: number, i: number, j: number, primary: boolean): number {
    const b = this.body;
    const e = this.lcEntry(level, face, x, y);
    if (!e) return -1;
    if (primary) e.lastUse = b.store.tick;
    if (e.state !== 'resident') return -1;
    return e.data![j * IMAGE_TILE_SIZE + i]!;
  }

  /** Bilinear one-hot class weights of `level` at the point into out; false when a texel is missing. */
  private lcLevel(level: number, out: Float64Array, primary: boolean): boolean {
    this.index(level);
    const N = IMAGE_TILE_SIZE;
    const fx = this.lu[level]! * N - 0.5;
    const fy = this.lv[level]! * N - 0.5;
    const i0 = Math.floor(fx);
    const j0 = Math.floor(fy);
    const a = fx - i0;
    const c = fy - j0;
    const x = this.lx[level]!;
    const y = this.ly[level]!;
    const k00 = this.lcTexel(level, this.face, x, y, i0, j0, primary);
    const k10 = this.lcTexel(level, this.face, x, y, i0 + 1, j0, primary);
    const k01 = this.lcTexel(level, this.face, x, y, i0, j0 + 1, primary);
    const k11 = this.lcTexel(level, this.face, x, y, i0 + 1, j0 + 1, primary);
    if (k00 < 0 || k10 < 0 || k01 < 0 || k11 < 0) return false;
    out.fill(0);
    const cc = this.body.lcClassCount;
    // Unknown class ids (beyond LANDCOVER_CLASS) count as class 0 ('unknown').
    const q00 = k00 < cc ? k00 : 0;
    const q10 = k10 < cc ? k10 : 0;
    const q01 = k01 < cc ? k01 : 0;
    const q11 = k11 < cc ? k11 : 0;
    out[q00] = out[q00]! + (1 - a) * (1 - c);
    out[q10] = out[q10]! + a * (1 - c);
    out[q01] = out[q01]! + (1 - a) * c;
    out[q11] = out[q11]! + a * c;
    return true;
  }

  /**
   * Land-cover class weights at band limit 2^log2Lambda (same level chain as heights, with the landcover
   * layer's own coverage weights). Returns false when the body has no landcover layer.
   */
  landcoverWeights(log2Lambda: number, out: Float64Array): boolean {
    const b = this.body;
    const cov = b.lcCov;
    if (!cov) return false;
    const Ll = b.log2Lambda0 - log2Lambda;
    const fl = Math.floor(Ll);
    let base = Math.min(cov.globalMaxLevel, fl);
    if (base < 0) base = 0;
    const top = Math.min(cov.maxLevel, fl + 1);
    let L = base;
    if (!this.lcLevel(base, out, true)) {
      this.incomplete = true;
      L = base - 1;
      while (L >= 0 && !this.lcLevel(L, out, false)) L--;
      if (L < 0) {
        out.fill(0);
        out[0] = 1;
      }
    }
    const tmp = this.lcTmp;
    for (let k = base + 1; k <= top; k++) {
      const beta = smootherstep01(Ll - k + 1);
      if (beta === 0) break;
      let c = beta;
      if (k > cov.globalMaxLevel) {
        this.index(k);
        const x = this.lx[k]!;
        const y = this.ly[k]!;
        if (!cov.has(k, this.face, x, y)) break;
        const mask = cov.missingMask(k, this.face, x, y);
        c *= mask === 0 ? 1 : weightFromMask(mask, this.lu[k]!, this.lv[k]!);
        if (c === 0) continue;
      }
      if (!this.lcLevel(k, tmp, true)) {
        this.incomplete = true;
        continue;
      }
      for (let i = 0; i < out.length; i++) out[i] = out[i]! + c * (tmp[i]! - out[i]!);
    }
    return true;
  }

  /** True when every land-cover tile the full-detail function reads at the point is resident. */
  landcoverComplete(): boolean {
    if (!this.body.lcRef) return true;
    const before = this.incomplete;
    this.incomplete = false;
    this.landcoverWeights(this.body.log2Lambda0 - this.effectiveLevel(), this.lcTmp2);
    const ok = !this.incomplete;
    this.incomplete = before || !ok;
    return ok;
  }

  // ---------------------------------------------------------------------------------------- full height

  private modStamp = 0;

  /** Fill this.mod with the model modulators at the point (lambda-independent; computed once per point). */
  modulators(): void {
    const b = this.body;
    if (b.model.modulatorCount === 0 || this.modStamp === this.stamp) return;
    this.modStamp = this.stamp;
    const E = this.effectiveLevel();
    this.dataScale();
    const pt = this.pt;
    pt.px = this.px;
    pt.py = this.py;
    pt.pz = this.pz;
    pt.E = E;
    pt.log2LambdaData = b.log2Lambda0 - E;
    pt.dataHeight = this.dsHeight;
    pt.dataSlope = this.dsSlope;
    if (b.model.usesLandcover && b.lcRef) this.landcoverWeights(b.log2Lambda0 - E, this.landcover);
    b.model.modulators(pt, this.mod, 0);
  }

  /** True when no amplification component can reach any of the band limits (min log2 band given). */
  ampInactive(minLog2Lambda: number): boolean {
    const b = this.body;
    if (b.model.modulatorCount === 0) return true;
    // E >= g everywhere, so components never exceed their length at the coarsest data wavelength.
    return minLog2Lambda >= b.ampMaxLog2;
  }

  /** Run the model's add() for the current point (modulators must be current). */
  addAmplification(log2Lambdas: Float64Array, n: number, out: Float64Array, skipAboveLog2: number, withRocks: boolean): void {
    const b = this.body;
    const prev = b.active;
    b.active = this;
    try {
      b.model.add(this.px, this.py, this.pz, this.mod, 0, log2Lambdas, n, out, skipAboveLog2, withRocks);
    } finally {
      b.active = prev;
    }
  }

  /**
   * Heights at band limits 2^log2Lambdas[0..n) into out (m), with modifiers applied. Optionally also the
   * data and amplification parts (before modifiers) into dataOut / ampOut. `skipAboveLog2` removes
   * amplification components of length >= 2^skip (band splitting by the normal-map baker); `withRocks` =
   * false leaves rock bumps out (rock base heights).
   */
  heights(
    log2Lambdas: Float64Array,
    n: number,
    out: Float64Array,
    skipAboveLog2 = Infinity,
    dataOut?: Float64Array,
    ampOut?: Float64Array,
    withRocks = true,
  ): void {
    const b = this.body;
    let lmin = Infinity;
    for (let k = 0; k < n; k++) if (log2Lambdas[k]! < lmin) lmin = log2Lambdas[k]!;
    for (let k = 0; k < n; k++) this.data[k] = this.dataChain(log2Lambdas[k]!);
    const amp = this.amp;
    for (let k = 0; k < n; k++) amp[k] = 0;
    if (!this.ampInactive(lmin)) {
      this.modulators();
      this.addAmplification(log2Lambdas, n, amp, skipAboveLog2, withRocks);
    }
    for (let k = 0; k < n; k++) {
      let h = this.data[k]! + amp[k]!;
      if (b.discs.length > 0) h = applyDiscs(b.discs, h, this.dx, this.dy, this.dz, b.radius);
      out[k] = h;
      if (dataOut) dataOut[k] = this.data[k]!;
      if (ampOut) ampOut[k] = amp[k]!;
    }
  }

  /** Height at one band limit. */
  height(log2Lambda: number, withRocks = true): number {
    this.bands[0] = log2Lambda;
    this.heights(this.bands, 1, this.bands, Infinity, undefined, undefined, withRocks);
    return this.bands[0]!;
  }

  /** Flattening weight of the modifiers at the point (0 = natural). */
  flatten(): number {
    const b = this.body;
    return b.discs.length === 0 ? 0 : flattenWeight(b.discs, this.dx, this.dy, this.dz, b.radius);
  }

  /** Natural data height at full detail (no amplification, no modifiers). */
  naturalDataHeight(): number {
    return this.dataChain(-Infinity);
  }

  /**
   * Continue a data chain whose value through level `fromLevel` is `D` over the levels above it, at band
   * limit 2^log2Lambda (the baker interpolates the coarse part and continues per sample).
   */
  continueChain(D: number, fromLevel: number, log2Lambda: number): number {
    const b = this.body;
    const Ll = b.log2Lambda0 - log2Lambda;
    const top = Math.min(b.heightCov.maxLevel, Math.floor(Ll) + 1);
    if (top > b.g) this.ensureCoverage(top);
    for (let L = fromLevel + 1; L <= top; L++) {
      const beta = smootherstep01(Ll - L + 1);
      if (beta === 0) break;
      let c = beta;
      if (L > b.g) {
        if (L > this.covDone) break;
        c *= this.w[L]!;
        if (c === 0) continue;
      }
      if (!this.sample(L, true)) {
        this.incomplete = true;
        continue;
      }
      D += c * (this.hSmp[3 * L]! - D);
    }
    return D;
  }
}
