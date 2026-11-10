/**
 * TerrainBaker: tile products for the renderer's workers, computed from the same height function the
 * physics uses (pure, worker-safe; data must have been made resident with prepareTile first).
 *
 * Geometry: 65 x 65 vertices at the tile's vertex grid, band limit tileSize/32 (2 quads), via exactly the
 * per-vertex evaluation of the collision surface, so at maxRenderLevel the result IS the collision surface.
 *
 * Normal/material map: 256 x 256 cell-registered texels (texel (i, j) centre at u = (i + 0.5)/256), band
 * limit tileSize/128 (2 texels). The height grid over the texel centres plus a 1-texel border is
 *   H = interp(coarse) + per-sample high band,
 * coarse: a 69 x 69 grid at the geometry vertex spacing (4 texels, 2 vertices of margin) evaluated with the
 * full point evaluator at band limit tileSize/16: data chain through level L-3, amplification, modulators,
 * coarse material; bicubic (heights) and bilinear (modulators) interpolation to the texels.
 * high band: data levels L-2..L continued per sample (separable scanline bicubic, coverage weights per
 * sample), and every amplification component whose weight differs between tileSize/128 and tileSize/16
 * (noise octaves per sample, craters and rocks gathered per tile and splatted).
 * Channels: r, g = 0.5 + 0.5 tanh(slope / slopeScale) of the directional derivatives of H along the unit
 * tangents tU = normalize(dP/du), tV = normalize(dP/dv) (m/m; tU . tV = -s t / sqrt((1 + s^2)(1 + t^2)) on
 * the gnomonic face, so reconstruct the gradient with the dual basis); b = AO from a two-scale concavity
 * (1 = open); a = material weight from the model (crater freshness on the Moon, rockiness on Earth).
 */
import type { FaceId, TileKey } from '../core/geo/cubeSphere';
import { CUBE_FACES } from '../core/geo/cubeSphere';
import { HEIGHT_TILE_CELLS, HEIGHT_TILE_STORED } from '../core/geo/tileCodec';
import type { BandRasterJob } from './amplification/types';
import { sampleRange } from './bicubic';
import { faceStDir, GEOMETRY_BAND_DIVISOR, GEOMETRY_GRID, NORMAL_BAND_DIVISOR, NORMAL_MAP_SIZE, type BodyTerrain } from './body';
import { vertexFaceCoord } from './collision';
import { weightFromMask } from './coverage';
import { applyDiscs } from './modifiers';
import { smootherstep01, tileNumber } from './util';

export interface GeometryBake {
  /** 65 x 65 heights (m above the reference radius), row-major, row = v. */
  heights: Float32Array;
  hMin: number;
  hMax: number;
  /** False when some data the tile reads was not resident (call prepareTile first). */
  complete: boolean;
}

export interface NormalMaterialBake {
  /** 256 x 256 x 4 bytes, row-major, row = v: r, g = encoded slopes, b = AO, a = material weight. */
  rgba: Uint8Array;
  /** Slope encoding scale of this tile: slope = slopeScale * atanh(2 * byte/255 - 1). */
  slopeScale: number;
  complete: boolean;
}

/** Strength of the concavity -> AO mapping of the normal/material map (AO = 1 - AO_GAIN * concavity). */
export const AO_GAIN = 2;
/** Band limit of the coarse part of a normal/material bake, as a divisor of the tile size. */
const LOW_BAND_DIVISOR = 16;
const CG = 69; // coarse grid samples per side (k = -2 .. 66)
const CG0 = 2; // index of k = 0
const NS = NORMAL_MAP_SIZE + 2; // texel centres incl. 1-texel border (i = -1 .. 256)
const NSS = NS * NS;

export class TileBaker {
  private readonly px = new Float64Array(NSS);
  private readonly py = new Float64Array(NSS);
  private readonly pz = new Float64Array(NSS);
  private readonly hgt = new Float64Array(NSS);
  private readonly dat = new Float64Array(NSS);
  private readonly band = new Float64Array(NSS);
  private readonly mat = new Float32Array(NSS);
  private readonly matBand = new Float32Array(NSS);
  private readonly cav = new Float32Array(NSS);
  private readonly sU = new Float64Array(NORMAL_MAP_SIZE * NORMAL_MAP_SIZE);
  private readonly sV = new Float64Array(NORMAL_MAP_SIZE * NORMAL_MAP_SIZE);
  private readonly ao = new Float64Array(NORMAL_MAP_SIZE * NORMAL_MAP_SIZE);
  private readonly cgCav = new Float64Array(CG * CG);
  private mod = new Float64Array(0);
  // coarse grid
  private readonly cgD = new Float64Array(CG * CG);
  private readonly cgA = new Float64Array(CG * CG);
  private readonly cgH = new Float64Array(CG * CG);
  private readonly cgMat = new Float64Array(CG * CG);
  private cgMod = new Float64Array(0);
  private readonly lam = new Float64Array(2);
  private readonly outs = new Float64Array(2);
  private readonly dOut = new Float64Array(2);
  private readonly aOut = new Float64Array(2);

  constructor(readonly body: BodyTerrain) {}

  // -------------------------------------------------------------------------------------------- geometry

  bakeGeometry(key: TileKey): GeometryBake {
    const b = this.body;
    const ev = b.vertexEval;
    const log2G = Math.log2(b.tileSize(key.level) / GEOMETRY_BAND_DIVISOR);
    const heights = new Float32Array(GEOMETRY_GRID * GEOMETRY_GRID);
    let complete = true;
    let lo = Infinity;
    let hi = -Infinity;
    for (let j = 0; j < GEOMETRY_GRID; j++) {
      const t = vertexFaceCoord(key.y, j, key.level);
      for (let i = 0; i < GEOMETRY_GRID; i++) {
        ev.setFaceSt(key.face, vertexFaceCoord(key.x, i, key.level), t);
        ev.incomplete = false;
        const h = ev.height(log2G);
        if (ev.incomplete) complete = false;
        const f = (heights[j * GEOMETRY_GRID + i] = h);
        if (f < lo) lo = f;
        if (f > hi) hi = f;
      }
    }
    return { heights, hMin: lo, hMax: hi, complete };
  }

  /** Geometry and normal/material map of one tile, sharing the coarse evaluation. */
  bakeTile(key: TileKey): { geometry: GeometryBake; normalMaterial: NormalMaterialBake } {
    const heights = new Float32Array(GEOMETRY_GRID * GEOMETRY_GRID);
    const r = this.coarseGrid(key, heights);
    let lo = Infinity;
    let hi = -Infinity;
    for (let k = 0; k < heights.length; k++) {
      const f = heights[k]!;
      if (f < lo) lo = f;
      if (f > hi) hi = f;
    }
    const nm = this.normalFromCoarse(key, r.complete);
    return { geometry: { heights, hMin: lo, hMax: hi, complete: r.complete }, normalMaterial: nm };
  }

  bakeNormalMaterial(key: TileKey): NormalMaterialBake {
    const r = this.coarseGrid(key, null);
    return this.normalFromCoarse(key, r.complete);
  }

  // ---------------------------------------------------------------------------------------- coarse grid

  /**
   * Evaluate the 69 x 69 coarse grid; when `geometry` is given, the 65 x 65 interior also yields the geometry
   * heights (same arithmetic as bakeGeometry / the collision surface).
   */
  private coarseGrid(key: TileKey, geometry: Float32Array | null): { complete: boolean } {
    const b = this.body;
    const ev = b.vertexEval;
    const M = b.model.modulatorCount;
    if (this.cgMod.length !== CG * CG * M) this.cgMod = new Float64Array(CG * CG * M);
    const ts = b.tileSize(key.level);
    const log2G = Math.log2(ts / GEOMETRY_BAND_DIVISOR);
    const log2Low = Math.log2(ts / LOW_BAND_DIVISOR);
    const log2N = Math.log2(ts / NORMAL_BAND_DIVISOR);
    const splitLevel = key.level - 3;
    const matMin = log2Low + 1;
    let complete = true;
    for (let l = 0; l < CG; l++) {
      const kv = l - CG0;
      const t = vertexFaceCoord(key.y, kv, key.level);
      for (let k = 0; k < CG; k++) {
        const ku = k - CG0;
        const o = l * CG + k;
        ev.setFaceSt(key.face, vertexFaceCoord(key.x, ku, key.level), t);
        ev.incomplete = false;
        const interior = geometry !== null && ku >= 0 && ku <= 64 && kv >= 0 && kv <= 64;
        if (interior) {
          this.lam[0] = log2G;
          this.lam[1] = log2Low;
          ev.heights(this.lam, 2, this.outs, Infinity, this.dOut, this.aOut);
          geometry[kv * GEOMETRY_GRID + ku] = this.outs[0]!;
          this.cgH[o] = this.outs[1]!;
          this.cgA[o] = this.aOut[1]!;
        } else {
          this.lam[0] = log2Low;
          ev.heights(this.lam, 1, this.outs, Infinity, this.dOut, this.aOut);
          this.cgH[o] = this.outs[0]!;
          this.cgA[o] = this.aOut[0]!;
        }
        this.cgD[o] = splitLevel >= 0 ? ev.dataChain(log2N, splitLevel) : ev.dataChain(log2N, 0);
        if (M > 0) {
          ev.modulators();
          for (let q = 0; q < M; q++) this.cgMod[o * M + q] = ev.mod[q]!;
          this.cgMat[o] = b.model.material(ev.px, ev.py, ev.pz, ev.mod, 0, matMin, Infinity);
        } else this.cgMat[o] = 0;
        if (ev.incomplete) complete = false;
      }
    }
    return { complete };
  }

  // ---------------------------------------------------------------------------------------- normal map

  private normalFromCoarse(key: TileKey, coarseComplete: boolean): NormalMaterialBake {
    const b = this.body;
    const R = b.radius;
    const M = b.model.modulatorCount;
    if (this.mod.length !== NSS * M) this.mod = new Float64Array(NSS * M);
    const n = 2 ** key.level;
    const ts = b.tileSize(key.level);
    const log2N = Math.log2(ts / NORMAL_BAND_DIVISOR);
    const log2Low = Math.log2(ts / LOW_BAND_DIVISOR);
    const splitLevel = Math.max(0, key.level - 3);
    let complete = coarseComplete;

    // Texel-centre positions (exact; beyond-face border samples are normalised cube points).
    for (let j = 0; j < NS; j++) {
      const t = -1 + (2 * (key.y + (j - 0.5) / NORMAL_MAP_SIZE)) / n;
      for (let i = 0; i < NS; i++) {
        const s = -1 + (2 * (key.x + (i - 0.5) / NORMAL_MAP_SIZE)) / n;
        const d = faceStDir(key.face, s, t);
        const o = j * NS + i;
        this.px[o] = d.x * R;
        this.py[o] = d.y * R;
        this.pz[o] = d.z * R;
      }
    }

    // Interpolate the coarse grid: data (chain through the split level), low-band amplification (bicubic),
    // modulators and coarse material (bilinear).
    interpBicubic(this.cgD, this.dat);
    interpBicubic(this.cgA, this.hgt);
    for (let q = 0; q < M; q++) interpBilinearStrided(this.cgMod, M, q, this.mod);
    interpBilinear(this.cgMat, this.mat);

    // Data levels above the split, per sample.
    const top = Math.min(key.level, b.heightCov.maxLevel);
    if (top > splitLevel) {
      if (!this.continueData(key, splitLevel, top, log2N)) complete = false;
    }

    // High band of the amplification.
    this.band.fill(0);
    const matBand = this.matBand;
    matBand.fill(0);
    if (M > 0) {
      const job = this.bandJob(key, log2N, log2Low, matBand);
      const ev = b.vertexEval;
      const prev = b.active;
      b.active = ev;
      ev.incomplete = false;
      try {
        b.model.addBandRaster(job);
      } finally {
        b.active = prev;
      }
      if (ev.incomplete) complete = false;
    }

    // Total height with modifiers.
    const H = this.hgt;
    const discs = b.discs;
    for (let o = 0; o < NSS; o++) H[o] = this.dat[o]! + H[o]! + this.band[o]!;
    if (discs.length > 0) {
      const near = discs.filter((d) => discNearTile(d, this.px, this.py, this.pz, R));
      if (near.length > 0) {
        for (let o = 0; o < NSS; o++) H[o] = applyDiscs(near, H[o]!, this.px[o]! / R, this.py[o]! / R, this.pz[o]! / R, R);
      }
    }
    for (let o = 0; o < NSS; o++) if (matBand[o]! > this.mat[o]!) this.mat[o] = matBand[o]!;

    // Coarse concavity (height above the mean of the 4 coarse neighbours, m), then bilinear to texels.
    const cgCav = this.cgCav;
    for (let l = 1; l < CG - 1; l++) {
      for (let k = 1; k < CG - 1; k++) {
        const o = l * CG + k;
        const c = this.cgH[o]!;
        cgCav[o] = (this.cgH[o - 1]! + this.cgH[o + 1]! - 2 * c) / 2 + (this.cgH[o - CG]! + this.cgH[o + CG]! - 2 * c) / 2;
      }
    }
    const cav = this.cav;
    interpBilinear(cgCav, cav);

    // Slopes, AO, material; encode.
    const rgba = new Uint8Array(NORMAL_MAP_SIZE * NORMAL_MAP_SIZE * 4);
    const sU = this.sU;
    const sV = this.sV;
    const ao = this.ao;
    const dsTexel = 2 / (n * NORMAL_MAP_SIZE);
    let sum2 = 0;
    for (let j = 0; j < NORMAL_MAP_SIZE; j++) {
      const t = -1 + (2 * (key.y + (j + 0.5) / NORMAL_MAP_SIZE)) / n;
      for (let i = 0; i < NORMAL_MAP_SIZE; i++) {
        const s = -1 + (2 * (key.x + (i + 0.5) / NORMAL_MAP_SIZE)) / n;
        const q = 1 + s * s + t * t;
        const mu = (R * Math.sqrt(1 + t * t) * dsTexel) / q;
        const mv = (R * Math.sqrt(1 + s * s) * dsTexel) / q;
        const o = (j + 1) * NS + (i + 1);
        const h = H[o]!;
        const su = (H[o + 1]! - H[o - 1]!) / (2 * mu);
        const sv = (H[o + NS]! - H[o - NS]!) / (2 * mv);
        const k = j * NORMAL_MAP_SIZE + i;
        sU[k] = su;
        sV[k] = sv;
        sum2 += su * su + sv * sv;
        const fine = ((H[o - 1]! + H[o + 1]!) / 2 - h) / mu + ((H[o - NS]! + H[o + NS]!) / 2 - h) / mv;
        // Coarse neighbours are 4 texels away.
        const coarse = cav[o]! / (4 * Math.sqrt(mu * mv));
        const c = fine + coarse;
        ao[k] = 1 - Math.min(1, AO_GAIN * (c > 0 ? c : 0));
      }
    }
    const rms = Math.sqrt(sum2 / (2 * NORMAL_MAP_SIZE * NORMAL_MAP_SIZE));
    const slopeScale = Math.min(8, Math.max(0.01, 2 * rms));
    const inv = 1 / slopeScale;
    for (let j = 0; j < NORMAL_MAP_SIZE; j++) {
      for (let i = 0; i < NORMAL_MAP_SIZE; i++) {
        const k = j * NORMAL_MAP_SIZE + i;
        const o = (j + 1) * NS + (i + 1);
        rgba[4 * k] = Math.round(255 * (0.5 + 0.5 * Math.tanh(sU[k]! * inv)));
        rgba[4 * k + 1] = Math.round(255 * (0.5 + 0.5 * Math.tanh(sV[k]! * inv)));
        rgba[4 * k + 2] = Math.round(255 * ao[k]!);
        const m = this.mat[o]!;
        rgba[4 * k + 3] = Math.round(255 * (m < 0 ? 0 : m > 1 ? 1 : m));
      }
    }
    return { rgba, slopeScale, complete };
  }

  /** Continue the data chain over levels splitLevel+1 .. top per sample (into this.dat). */
  private continueData(key: TileKey, splitLevel: number, top: number, log2N: number): boolean {
    const b = this.body;
    const cov = b.heightCov;
    let complete = true;
    const Ll = b.log2Lambda0 - log2N;
    for (let L = splitLevel + 1; L <= top; L++) {
      const beta = smootherstep01(Ll - L + 1);
      if (beta === 0) break;
      const d = key.level - L;
      const ax = key.x >> d;
      const ay = key.y >> d;
      if (!cov.has(L, key.face, ax, ay)) break;
      const e = b.store.get(b.heightRef, L, tileNumber(L, key.face, ax, ay));
      if (!e) {
        complete = false;
        continue;
      }
      const mask = L > b.g ? cov.missingMask(L, key.face, ax, ay) : 0;
      // Interior texels map affinely into the ancestor tile: separable Catmull-Rom.
      const scale = 2 ** -d;
      const xo = key.x - (ax << d);
      const yo = key.y - (ay << d);
      const colI = new Int32Array(NORMAL_MAP_SIZE);
      const colW = new Float64Array(NORMAL_MAP_SIZE * 4);
      const colU = new Float64Array(NORMAL_MAP_SIZE);
      for (let i = 0; i < NORMAL_MAP_SIZE; i++) {
        const u = (xo + (i + 0.5) / NORMAL_MAP_SIZE) * scale;
        colU[i] = u;
        crSetup(u, colI, colW, i);
      }
      const rowJ = new Int32Array(NORMAL_MAP_SIZE);
      const rowW = new Float64Array(NORMAL_MAP_SIZE * 4);
      const rowV = new Float64Array(NORMAL_MAP_SIZE);
      for (let j = 0; j < NORMAL_MAP_SIZE; j++) {
        const v = (yo + (j + 0.5) / NORMAL_MAP_SIZE) * scale;
        rowV[j] = v;
        crSetup(v, rowJ, rowW, j);
      }
      const q = e.q!;
      const c0 = colI[0]! - 1;
      const c1 = colI[NORMAL_MAP_SIZE - 1]! + 2;
      const tmp = new Float64Array(HEIGHT_TILE_STORED);
      for (let j = 0; j < NORMAL_MAP_SIZE; j++) {
        const r0 = (rowJ[j]! - 1) * HEIGHT_TILE_STORED;
        const w0 = rowW[4 * j]!;
        const w1 = rowW[4 * j + 1]!;
        const w2 = rowW[4 * j + 2]!;
        const w3 = rowW[4 * j + 3]!;
        for (let c = c0; c <= c1; c++) {
          tmp[c] = w0 * q[r0 + c]! + w1 * q[r0 + HEIGHT_TILE_STORED + c]! + w2 * q[r0 + 2 * HEIGHT_TILE_STORED + c]! + w3 * q[r0 + 3 * HEIGHT_TILE_STORED + c]!;
        }
        for (let i = 0; i < NORMAL_MAP_SIZE; i++) {
          const c = colI[i]! - 1;
          const val = e.offset + e.scale * (colW[4 * i]! * tmp[c]! + colW[4 * i + 1]! * tmp[c + 1]! + colW[4 * i + 2]! * tmp[c + 2]! + colW[4 * i + 3]! * tmp[c + 3]!);
          const w = mask === 0 ? 1 : weightFromMask(mask, colU[i]!, rowV[j]!);
          const cc = beta * w;
          if (cc === 0) continue;
          const o = (j + 1) * NS + (i + 1);
          this.dat[o] = this.dat[o]! + cc * (val - this.dat[o]!);
        }
      }
    }
    // Border samples (outside the tile; possibly another data tile or face): the generic evaluator.
    const ev = b.vertexEval;
    const n = 2 ** key.level;
    for (let j = 0; j < NS; j++) {
      for (let i = 0; i < NS; i++) {
        if (j > 0 && j < NS - 1 && i > 0 && i < NS - 1) continue;
        const o = j * NS + i;
        const s = -1 + (2 * (key.x + (i - 0.5) / NORMAL_MAP_SIZE)) / n;
        const t = -1 + (2 * (key.y + (j - 0.5) / NORMAL_MAP_SIZE)) / n;
        ev.setFaceSt(key.face, s, t);
        ev.incomplete = false;
        this.dat[o] = ev.continueChain(this.dat[o]!, splitLevel, log2N);
        if (ev.incomplete) complete = false;
      }
    }
    return complete;
  }

  private bandJob(key: TileKey, log2N: number, log2Low: number, material: Float32Array): BandRasterJob {
    const b = this.body;
    const R = b.radius;
    const n = 2 ** key.level;
    const f = CUBE_FACES[key.face]!;
    // Smallest texel edge over the tile (gnomonic texels shrink away from the face centre: check corners).
    let minTexel = Infinity;
    for (const [cu, cv] of [
      [0, 0],
      [1, 0],
      [0, 1],
      [1, 1],
    ] as const) {
      const s = -1 + (2 * (key.x + cu)) / n;
      const t = -1 + (2 * (key.y + cv)) / n;
      const q = 1 + s * s + t * t;
      const ds = 2 / (n * NORMAL_MAP_SIZE);
      minTexel = Math.min(minTexel, (R * Math.sqrt(1 + t * t) * ds) / q, (R * Math.sqrt(1 + s * s) * ds) / q);
    }
    minTexel *= 0.9;
    const ts = b.tileSize(key.level);
    const px = this.px;
    const py = this.py;
    const pz = this.pz;
    return {
      count: NSS,
      px,
      py,
      pz,
      mod: this.mod,
      log2LambdaN: log2N,
      log2LambdaLow: log2Low,
      out: this.band,
      material,
      gatherPoints(spacing: number) {
        const margin = 4 / NORMAL_MAP_SIZE;
        const span = 1 + 2 * margin;
        const m = Math.max(2, Math.ceil((span * ts * 1.4) / spacing) + 1);
        const pts = new Float64Array(m * m * 3);
        let c = 0;
        for (let j = 0; j < m; j++) {
          const t = -1 + (2 * (key.y - margin + (span * j) / (m - 1))) / n;
          for (let i = 0; i < m; i++) {
            const s = -1 + (2 * (key.x - margin + (span * i) / (m - 1))) / n;
            const d = faceStDir(key.face as FaceId, s, t);
            pts[c++] = d.x * R;
            pts[c++] = d.y * R;
            pts[c++] = d.z * R;
          }
        }
        return { pts, count: m * m };
      },
      forEachNear(x: number, y: number, z: number, reach: number, fn: (i: number, d2: number) => void) {
        const dn = x * f.n[0] + y * f.n[1] + z * f.n[2];
        if (dn <= 0) return;
        const sc = (x * f.u[0] + y * f.u[1] + z * f.u[2]) / dn;
        const tc = (x * f.v[0] + y * f.v[1] + z * f.v[2]) / dn;
        const fi = (((sc + 1) / 2) * n - key.x) * NORMAL_MAP_SIZE - 0.5;
        const fj = (((tc + 1) / 2) * n - key.y) * NORMAL_MAP_SIZE - 0.5;
        const rT = reach / minTexel + 1;
        const i0 = Math.max(-1, Math.ceil(fi - rT));
        const i1 = Math.min(NORMAL_MAP_SIZE, Math.floor(fi + rT));
        const j0 = Math.max(-1, Math.ceil(fj - rT));
        const j1 = Math.min(NORMAL_MAP_SIZE, Math.floor(fj + rT));
        if (i0 > i1 || j0 > j1) return;
        const r2 = reach * reach;
        for (let j = j0; j <= j1; j++) {
          const row = (j + 1) * NS;
          for (let i = i0; i <= i1; i++) {
            const o = row + i + 1;
            const dx = px[o]! - x;
            const dy = py[o]! - y;
            const dz = pz[o]! - z;
            const d2 = dx * dx + dy * dy + dz * dz;
            if (d2 < r2) fn(o, d2);
          }
        }
      },
    };
  }

  // -------------------------------------------------------------------------------------------- bounds

  /**
   * Conservative height range of render tile `key` at its geometry band limit, without baking it: hull of
   * the resident data samples covering the tile at every contributing level (+30 % Catmull-Rom overshoot),
   * widened by the model's amplitude bound and including any flatten-disc elevation that reaches the tile.
   */
  tileBounds(key: TileKey): { hMin: number; hMax: number } {
    const b = this.body;
    const cov = b.heightCov;
    let lo = Infinity;
    let hi = -Infinity;
    const top = Math.min(key.level - 1, cov.maxLevel);
    for (let L = 0; L <= Math.max(0, top); L++) {
      const d = key.level - L;
      if (d < 0) break;
      const ax = key.x >> d;
      const ay = key.y >> d;
      if (!cov.has(L, key.face, ax, ay)) break;
      const e = b.store.peek(b.heightRef, L, tileNumber(L, key.face, ax, ay));
      if (!e) continue;
      const sc = 2 ** -d;
      const u0 = (key.x - (ax << d)) * sc;
      const v0 = (key.y - (ay << d)) * sc;
      const r = sampleRange(e, u0, u0 + sc, v0, v0 + sc);
      const pad = 0.3 * (r.hi - r.lo);
      lo = Math.min(lo, r.lo - pad);
      hi = Math.max(hi, r.hi + pad);
    }
    if (lo > hi) {
      const tr = b.def.terrain!;
      lo = tr.minElevation;
      hi = tr.maxElevation;
    }
    const amp = b.model.modulatorCount > 0 ? b.model.amplitudeBound(Math.log2(b.tileSize(key.level) / GEOMETRY_BAND_DIVISOR), b.g) : 0;
    lo -= amp;
    hi += amp;
    for (const disc of b.discs) {
      const R = b.radius;
      const c = faceStDir(key.face, vertexFaceCoord(key.x, 32, key.level), vertexFaceCoord(key.y, 32, key.level));
      const dist = R * Math.acos(Math.max(-1, Math.min(1, c.x * disc.cx + c.y * disc.cy + c.z * disc.cz)));
      if (dist < disc.blendRadius + b.tileSize(key.level)) {
        lo = Math.min(lo, disc.elevation);
        hi = Math.max(hi, disc.elevation);
      }
    }
    return { hMin: lo, hMax: hi };
  }
}

/** Does any sample of the grid lie within the blend radius of disc d? (cheap test on the 4 corners + centre). */
function discNearTile(d: { cx: number; cy: number; cz: number; blendRadius: number }, px: Float64Array, py: Float64Array, pz: Float64Array, R: number): boolean {
  const idx = [0, NS - 1, (NS - 1) * NS, NSS - 1];
  let maxChord = 0;
  for (const a of idx) for (const c of idx) maxChord = Math.max(maxChord, Math.hypot(px[a]! - px[c]!, py[a]! - py[c]!, pz[a]! - pz[c]!));
  const ci = (NS >> 1) * NS + (NS >> 1);
  const dist = Math.hypot(px[ci]! / R - d.cx, py[ci]! / R - d.cy, pz[ci]! / R - d.cz) * R;
  return dist < d.blendRadius + maxChord;
}

/** Catmull-Rom cell index and weights of tile-local coordinate u for a bordered height tile. */
function crSetup(u: number, idx: Int32Array, w: Float64Array, k: number): void {
  const fx = u * HEIGHT_TILE_CELLS + 1;
  let i1 = Math.floor(fx);
  if (i1 < 1) i1 = 1;
  else if (i1 > HEIGHT_TILE_CELLS) i1 = HEIGHT_TILE_CELLS;
  const t = fx - i1;
  idx[k] = i1;
  w[4 * k] = ((-t + 2) * t - 1) * t * 0.5;
  w[4 * k + 1] = ((3 * t - 5) * t * t + 2) * 0.5;
  w[4 * k + 2] = ((-3 * t + 4) * t + 1) * t * 0.5;
  w[4 * k + 3] = (t - 1) * t * t * 0.5;
}

// Interpolation from the coarse grid (k = -2..66, spacing 4 texels) to texel centres i = -1..256:
// coarse coordinate of texel i is (i + 0.5) / 4.
const CR_IDX = new Int32Array(NS);
const CR_W = new Float64Array(NS * 4);
const BL_IDX = new Int32Array(NS);
const BL_T = new Float64Array(NS);
for (let a = 0; a < NS; a++) {
  const kc = (a - 1 + 0.5) / 4 + CG0;
  const k0 = Math.floor(kc);
  const t = kc - k0;
  CR_IDX[a] = k0;
  CR_W[4 * a] = ((-t + 2) * t - 1) * t * 0.5;
  CR_W[4 * a + 1] = ((3 * t - 5) * t * t + 2) * 0.5;
  CR_W[4 * a + 2] = ((-3 * t + 4) * t + 1) * t * 0.5;
  CR_W[4 * a + 3] = (t - 1) * t * t * 0.5;
  BL_IDX[a] = k0;
  BL_T[a] = t;
}

function interpBicubic(src: Float64Array, dst: Float64Array): void {
  const row = new Float64Array(CG);
  for (let j = 0; j < NS; j++) {
    const r = CR_IDX[j]! - 1;
    const w0 = CR_W[4 * j]!;
    const w1 = CR_W[4 * j + 1]!;
    const w2 = CR_W[4 * j + 2]!;
    const w3 = CR_W[4 * j + 3]!;
    for (let c = 0; c < CG; c++) row[c] = w0 * src[r * CG + c]! + w1 * src[(r + 1) * CG + c]! + w2 * src[(r + 2) * CG + c]! + w3 * src[(r + 3) * CG + c]!;
    for (let i = 0; i < NS; i++) {
      const c = CR_IDX[i]! - 1;
      dst[j * NS + i] = CR_W[4 * i]! * row[c]! + CR_W[4 * i + 1]! * row[c + 1]! + CR_W[4 * i + 2]! * row[c + 2]! + CR_W[4 * i + 3]! * row[c + 3]!;
    }
  }
}

function interpBilinear(src: Float64Array, dst: Float32Array): void {
  for (let j = 0; j < NS; j++) {
    const r = BL_IDX[j]!;
    const tv = BL_T[j]!;
    for (let i = 0; i < NS; i++) {
      const c = BL_IDX[i]!;
      const tu = BL_T[i]!;
      const a = src[r * CG + c]! + tu * (src[r * CG + c + 1]! - src[r * CG + c]!);
      const bb = src[(r + 1) * CG + c]! + tu * (src[(r + 1) * CG + c + 1]! - src[(r + 1) * CG + c]!);
      dst[j * NS + i] = a + tv * (bb - a);
    }
  }
}

function interpBilinearStrided(src: Float64Array, M: number, q: number, dst: Float64Array): void {
  for (let j = 0; j < NS; j++) {
    const r = BL_IDX[j]!;
    const tv = BL_T[j]!;
    for (let i = 0; i < NS; i++) {
      const c = BL_IDX[i]!;
      const tu = BL_T[i]!;
      const s00 = src[(r * CG + c) * M + q]!;
      const s10 = src[(r * CG + c + 1) * M + q]!;
      const s01 = src[((r + 1) * CG + c) * M + q]!;
      const s11 = src[((r + 1) * CG + c + 1) * M + q]!;
      const a = s00 + tu * (s10 - s00);
      const bb = s01 + tu * (s11 - s01);
      dst[(j * NS + i) * M + q] = a + tv * (bb - a);
    }
  }
}
