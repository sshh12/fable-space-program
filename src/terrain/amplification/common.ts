/**
 * Building blocks shared by the amplification models: parameter access, the multifractal amplitude
 * modulation, and octave stacks of gradient noise with their per-point and band-raster evaluation.
 */
import type { TerrainAmplificationDef } from '../../core/contracts/defs';
import { CRATER_O, CRATER_STRIDE, profile, type CraterClass, type CraterField } from '../craters';
import { GradientNoise3, NOISE_GRAD_RMS, subSeed } from '../noise';
import { acceptanceRatio, ROCK_STRIDE, rockBump, rockLog2Length, type RockAbundance, type RockAbundanceBound, type RockField } from '../rocks';
import { smootherstep01 } from '../util';
import type { BandRasterJob } from './types';

/** Read a required numeric parameter; a missing or non-finite value is a data error naming the model. */
export function param(def: TerrainAmplificationDef, key: string): number {
  const v = def.params[key];
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`terrain amplification "${def.model}": parameter "${key}" is missing or not a number`);
  return v;
}

/**
 * Multifractal amplitude factor from the local data slope relative to the expected slope at the data scale:
 * 1 on terrain no rougher than the reference, rising smoothly (C1) toward maxFactor on rough terrain.
 */
export function multifractalFactor(ratio: number, gain: number, maxFactor: number): number {
  const x = ratio - 1;
  if (x <= 0) return 1;
  const ramp = (x * x) / (x + 0.5);
  return 1 + (maxFactor - 1) * (1 - Math.exp(-gain * ramp));
}

/**
 * Gradient-noise octaves with wavelengths 2^j m, j in [jMin, jMax]. Octave j has RMS slope
 * S * (2^j)^(H - 1), i.e. height amplitude a_j = S 2^(j H) / NOISE_GRAD_RMS, weighted by
 * wE = smootherstep(log2LambdaData - j) and wLambda = smootherstep(j - log2 lambdaMin).
 */
export class OctaveStack {
  readonly noises: GradientNoise3[] = [];

  constructor(
    seed: number,
    readonly jMin: number,
    readonly jMax: number,
  ) {
    for (let j = jMin; j <= jMax; j++) this.noises.push(new GradientNoise3(subSeed(seed, j - jMin + 7)));
  }

  /** Highest octave index with non-zero weight for a data wavelength 2^log2LambdaData and a skip limit. */
  top(log2LambdaData: number, skipAboveLog2: number): number {
    let jt = Math.ceil(log2LambdaData) - 1;
    if (skipAboveLog2 !== Infinity) jt = Math.min(jt, Math.ceil(skipAboveLog2) - 1);
    return Math.min(jt, this.jMax);
  }

  /** Lowest octave index with non-zero weight for the smallest band limit. */
  bottom(minLog2Lambda: number): number {
    return Math.max(this.jMin, Math.floor(minLog2Lambda) + 1);
  }

  noise(j: number): GradientNoise3 {
    return this.noises[j - this.jMin]!;
  }
}

export const minOf = (a: Float64Array, n: number): number => {
  let m = Infinity;
  for (let b = 0; b < n; b++) if (a[b]! < m) m = a[b]!;
  return m;
};

/** Band weight difference w(len; lambdaN) - w(len; lambdaLow) for log2 lengths. */
export const bandDiff = (log2Len: number, log2N: number, log2Low: number): number =>
  smootherstep01(log2Len - log2N) - smootherstep01(log2Len - log2Low);

/**
 * Splat the craters of every class whose diameter lies in the high band of `job` into job.out and
 * job.material. `log2MaxDOf(i)` gives the per-sample log2 of the largest procedural crater diameter.
 */
export function splatCraters(field: CraterField, job: BandRasterJob, log2MaxDOf: (i: number) => number): void {
  const ext = field.p.extentRadii;
  const top = job.log2LambdaLow + 1;
  for (const c of field.classes) {
    if (c.log2DLo >= top) continue;
    if (c.log2DLo <= job.log2LambdaN) break;
    const wb = bandDiff(c.log2DLo, job.log2LambdaN, job.log2LambdaLow);
    if (wb === 0) continue;
    splatClass(c, job, wb, ext, log2MaxDOf);
  }
}

/** Typed record buffer of the craters gathered for one class (grown on demand, reused). */
let splatBuf = new Float64Array(CRATER_STRIDE * 512);
/** Typed record buffer of the rock candidates gathered for one class (grown on demand, reused). */
let rockBuf = new Float64Array(ROCK_STRIDE * 512);

function splatClass(c: CraterClass, job: BandRasterJob, wb: number, ext: number, log2MaxDOf: (i: number) => number): void {
  const cells = job.cells(c.cell, c.shellHalf, c.reach);
  let count = 0;
  for (let k = 0; k < cells.length; k += 3) {
    if ((count + c.slots) * CRATER_STRIDE > splatBuf.length) {
      const grown = new Float64Array(Math.max(2 * splatBuf.length, (count + c.slots) * CRATER_STRIDE));
      grown.set(splatBuf);
      splatBuf = grown;
    }
    count = c.cellCratersInto(cells[k]!, cells[k + 1]!, cells[k + 2]!, splatBuf, count);
  }
  const buf = splatBuf;
  const out = job.out;
  const material = job.material;
  const log2DHi = c.log2DHi;
  for (let r = 0; r < count; r++) {
    const o = r * CRATER_STRIDE;
    const invHalfD = buf[o + CRATER_O.invHalfD]!;
    const depth = buf[o + CRATER_O.depth]!;
    const rim = buf[o + CRATER_O.rim]!;
    const rounding = buf[o + CRATER_O.rounding]!;
    const freshness = buf[o + CRATER_O.freshness]!;
    job.forEachNear(buf[o + CRATER_O.cx]!, buf[o + CRATER_O.cy]!, buf[o + CRATER_O.cz]!, Math.sqrt(buf[o + CRATER_O.reach2]!), (i, d2) => {
      const wE = smootherstep01(log2MaxDOf(i) - log2DHi);
      if (wE === 0) return;
      const rr = Math.sqrt(d2) * invHalfD;
      out[i] = out[i]! + wb * wE * profile(rr, depth, rim, rounding, ext);
      const fresh = wE * freshness * (1 - smoothFall(1, ext, rr));
      if (fresh > material[i]!) material[i] = fresh;
    });
  }
}

const smoothFall = (e0: number, e1: number, x: number): number => {
  const t = (x - e0) / (e1 - e0);
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  return t * t * (3 - 2 * t);
};

/**
 * Splat accepted collidable rocks of the high band (bumps weighted by the band difference). Only rocks that
 * are bumps in the height function (diameter >= collisionMinDiameter): smaller rocks are visual only, drawn as
 * meshes by the renderer, and the normal map must match H.
 */
export function splatRocks(rocks: RockField, job: BandRasterJob, abundance: RockAbundance, bound: RockAbundanceBound): void {
  const top = job.log2LambdaLow + 1;
  const minD = rocks.p.collisionMinDiameter;
  for (const c of rocks.classes) {
    if (c.dHi < minD) break;
    if (rockLog2Length(c.dLo) >= top) continue;
    if (rockLog2Length(c.dHi) <= job.log2LambdaN) break;
    const cells = job.cells(c.cell, c.shellHalf, c.dHi / 2);
    // Candidates as typed records (same survivors in the same order as RockField.cellsCandidates).
    const s = c.cell;
    const extent = s / 2 + c.shellHalf;
    let count = 0;
    for (let i = 0; i < cells.length; i += 3) {
      const ix = cells[i]!;
      const iy = cells[i + 1]!;
      const iz = cells[i + 2]!;
      const kb = bound((ix + 0.5) * s, (iy + 0.5) * s, (iz + 0.5) * s, extent);
      if (kb <= 0) continue;
      if ((count + c.slots) * ROCK_STRIDE > rockBuf.length) {
        const grown = new Float64Array(Math.max(2 * rockBuf.length, (count + c.slots) * ROCK_STRIDE));
        grown.set(rockBuf);
        rockBuf = grown;
      }
      count = c.cellRocksInto(ix, iy, iz, rockBuf, count, kb);
    }
    const buf = rockBuf;
    const out = job.out;
    const material = job.material;
    for (let r = 0; r < count; r++) {
      const o = r * ROCK_STRIDE;
      const D = buf[o + 3]!;
      if (D < minD) continue;
      const log2Len = rockLog2Length(D);
      const wb = bandDiff(log2Len, job.log2LambdaN, job.log2LambdaLow);
      if (wb === 0) continue;
      const cx = buf[o]!;
      const cy = buf[o + 1]!;
      const cz = buf[o + 2]!;
      const rad = D / 2;
      // The cells of the largest, rarest rocks are kilometres wide: most candidates cannot touch the tile.
      // They are dropped before the abundance (land cover at the rock) is read, which is only resident
      // around the tile (docs/requests/terrain-render-1.md) and is the expensive part.
      if (!job.reaches(cx, cy, cz, rad)) continue;
      if (buf[o + 5]! >= acceptanceRatio(D, abundance(cx, cy, cz), rocks.p.kMax)) continue;
      const r2 = rad * rad;
      const hR = buf[o + 4]! * rad;
      job.forEachNear(cx, cy, cz, rad, (si, d2) => {
        out[si] = out[si]! + wb * rockBump(d2, r2, hR);
        if (material[si]! < 1) material[si] = 1;
      });
    }
  }
}

/**
 * Octave range and band weights of the high band of a raster job: octaves j in [bot, top] with
 * weight wb[j - bot] = bandDiff(j, log2LambdaN, log2LambdaLow) (zero entries are skipped by callers).
 */
export function bandOctaves(stack: OctaveStack, job: BandRasterJob): { top: number; bot: number; wb: Float64Array } {
  const top = Math.min(stack.jMax, Math.ceil(job.log2LambdaLow + 1) - 1);
  const bot = stack.bottom(job.log2LambdaN);
  const wb = new Float64Array(Math.max(0, top - bot + 1));
  for (let j = bot; j <= top; j++) wb[j - bot] = bandDiff(j, job.log2LambdaN, job.log2LambdaLow);
  return { top, bot, wb };
}

export const noiseAmplitude = (slope1m: number, j: number, hurst: number): number => (slope1m * 2 ** (j * hurst)) / NOISE_GRAD_RMS;
