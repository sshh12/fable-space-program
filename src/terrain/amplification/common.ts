/**
 * Building blocks shared by the amplification models: parameter access, the multifractal amplitude
 * modulation, and octave stacks of gradient noise with their per-point and band-raster evaluation.
 */
import type { TerrainAmplificationDef } from '../../core/contracts/defs';
import { CraterField, profile, type CraterClass } from '../craters';
import { GradientNoise3, NOISE_GRAD_RMS, subSeed } from '../noise';
import { acceptanceRatio, rockBump, type RockField } from '../rocks';
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
    splatClass(field, c, job, wb, ext, log2MaxDOf);
  }
}

function splatClass(field: CraterField, c: CraterClass, job: BandRasterJob, wb: number, ext: number, log2MaxDOf: (i: number) => number): void {
  const g = job.gatherPoints(c.cell / 2);
  const list = field.gather(c, g.pts, g.count);
  for (const r of list) {
    const reach = Math.sqrt(r.reach2);
    job.forEachNear(r.cx, r.cy, r.cz, reach, (i, d2) => {
      const wE = smootherstep01(log2MaxDOf(i) - c.log2DHi);
      if (wE === 0) return;
      const rr = Math.sqrt(d2) * r.invHalfD;
      job.out[i] = job.out[i]! + wb * wE * profile(rr, r.depth, r.rim, r.rounding, ext);
      const fresh = wE * r.freshness * (1 - smoothFall(1, ext, rr));
      if (fresh > job.material[i]!) job.material[i] = fresh;
    });
  }
}

const smoothFall = (e0: number, e1: number, x: number): number => {
  const t = (x - e0) / (e1 - e0);
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  return t * t * (3 - 2 * t);
};

/** Splat accepted rocks of the high band (bumps weighted by the band difference). */
export function splatRocks(rocks: RockField, job: BandRasterJob, abundance: (x: number, y: number, z: number) => number): void {
  const top = job.log2LambdaLow + 1;
  for (const c of rocks.classes) {
    // Rock length = 4 D (see RockField.addBumps).
    if (Math.log2(4 * c.dLo) >= top) continue;
    if (Math.log2(4 * c.dHi) <= job.log2LambdaN) break;
    const g = job.gatherPoints(c.cell / 2);
    const seen = new Set<string>();
    for (let i = 0; i < g.count; i++) {
      const bx = Math.floor(g.pts[3 * i]! * c.invCell) | 0;
      const by = Math.floor(g.pts[3 * i + 1]! * c.invCell) | 0;
      const bz = Math.floor(g.pts[3 * i + 2]! * c.invCell) | 0;
      for (let dx = -1; dx <= 1; dx++)
        for (let dy = -1; dy <= 1; dy++)
          for (let dz = -1; dz <= 1; dz++) {
            const key = `${bx + dx},${by + dy},${bz + dz}`;
            if (seen.has(key)) continue;
            seen.add(key);
            c.cellRocks(bx + dx, by + dy, bz + dz, (rk) => {
              const log2Len = Math.log2(4 * rk.diameter);
              const wb = bandDiff(log2Len, job.log2LambdaN, job.log2LambdaLow);
              if (wb === 0) return;
              if (rk.accept >= acceptanceRatio(rk.diameter, abundance(rk.cx, rk.cy, rk.cz), rocks.p.kMax)) return;
              const rad = rk.diameter / 2;
              const r2 = rad * rad;
              const hR = rk.heightRatio * rad;
              job.forEachNear(rk.cx, rk.cy, rk.cz, rad, (si, d2) => {
                job.out[si] = job.out[si]! + wb * rockBump(d2, r2, hR);
                if (job.material[si]! < 1) job.material[si] = 1;
              });
            });
          }
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
