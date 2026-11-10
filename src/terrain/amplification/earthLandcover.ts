/**
 * 'earth-landcover': amplification of Earth's land and seabed, driven by the `landcover` layer
 * (LANDCOVER_CLASS ids, blended continuously: bilinear class weights, coverage-weighted across levels).
 *
 * Per land-cover class c (parameters "<name>.<class>" in the definition):
 *   slope1m    RMS slope at 1 m of the relief octaves (Hurst exponent hurstLand)
 *   ridged     fraction of that relief made of ridged noise 1 - 2|n| (bare rock, lava flows)
 *   ripple     weight of aeolian ripples (rippleWavelengthM, rippleAmplitudeM), aligned per wind cell
 *   dune       weight of dunes (duneWavelengthM, duneAmplitudeM)
 *   rockiness  material weight (alpha channel of the normal/material map)
 *   rockK      Golombek-Rapp rock area fraction k
 * Below sea level the character blends to a smooth seabed (seabedSlope1m, hurstSeabed) over
 * seabedDepthRampM of data depth; the bathymetry itself is never clamped. Relief amplitude is modulated by
 * the data slope at the data scale (multifractal), as on the Moon.
 * Modulators: [0] log2 data wavelength, [1] soft slope S, [2] ridged slope, [3] H, [4] ripple, [5] dune,
 * [6] rockiness.
 */
import type { TerrainAmplificationDef } from '../../core/contracts/defs';
import { LANDCOVER_CLASS, type LandcoverClassName } from '../../core/contracts/terrain';
import { hashToUnit, hashU32 } from '../../core/math/hash';
import { GradientNoise3, NOISE_MAX, NOISE_MEAN_ABS, subSeed } from '../noise';
import { RockField, rockLog2Length } from '../rocks';
import { LatticeField } from '../smoothField';
import { smoothstep01, smootherstep01 } from '../util';
import { bandDiff, bandOctaves, minOf, multifractalFactor, noiseAmplitude, OctaveStack, param, splatRocks } from './common';
import type { AmplificationModel, BandRasterJob, ModelContext, PointInfo } from './types';

const CLASS_NAMES = Object.keys(LANDCOVER_CLASS) as LandcoverClassName[];
export const LANDCOVER_CLASS_COUNT = Math.max(...Object.values(LANDCOVER_CLASS)) + 1;
const RIDGE_MEAN = 1 - 2 * NOISE_MEAN_ABS;

/**
 * Wind-aligned wave trains (ripples or dunes): in each wind cell (size W, 3-D hash grid) a fixed direction
 * tangent to the sphere at the cell centre and a phase; the eight cells around P are blended with a smooth
 * partition of unity so the field is continuous, with most of each cell dominated by one direction.
 * Value = shape(xi) with xi = P . w / wavelength + phase + meander noise; shape is skewed (gentle stoss,
 * steeper lee) with RMS ~0.6.
 */
class WaveTrains {
  private readonly hs: number;
  private readonly meander: GradientNoise3;
  constructor(
    seed: number,
    readonly wavelength: number,
    readonly cell: number,
    readonly R: number,
  ) {
    this.hs = hashU32(seed);
    this.meander = new GradientNoise3(subSeed(seed, 99));
  }

  value(px: number, py: number, pz: number): number {
    const inv = 1 / this.cell;
    const gx = px * inv - 0.5;
    const gy = py * inv - 0.5;
    const gz = pz * inv - 0.5;
    const bx = Math.floor(gx);
    const by = Math.floor(gy);
    const bz = Math.floor(gz);
    const tx = blend(gx - bx);
    const ty = blend(gy - by);
    const tz = blend(gz - bz);
    const mInv = 1 / (3 * this.wavelength);
    const meander = 0.35 * this.meander.value(px * mInv, py * mInv, pz * mInv);
    let sum = 0;
    for (let dx = 0; dx < 2; dx++) {
      const wx = dx ? tx : 1 - tx;
      if (wx === 0) continue;
      const hx = hashU32(((bx + dx) | 0) ^ this.hs);
      for (let dy = 0; dy < 2; dy++) {
        const wy = dy ? ty : 1 - ty;
        if (wy === 0) continue;
        const hy = hashU32(((by + dy) | 0) ^ hx);
        for (let dz = 0; dz < 2; dz++) {
          const wz = dz ? tz : 1 - tz;
          if (wz === 0) continue;
          const h = hashU32(((bz + dz) | 0) ^ hy);
          // Direction tangent to the sphere at the cell centre.
          const cx = (bx + dx + 1) * this.cell;
          const cy = (by + dy + 1) * this.cell;
          const cz = (bz + dz + 1) * this.cell;
          const cl = Math.sqrt(cx * cx + cy * cy + cz * cz) || 1;
          const nx = cx / cl;
          const ny = cy / cl;
          const nz = cz / cl;
          let rx = hashToUnit(hashU32(h ^ 1)) * 2 - 1;
          let ry = hashToUnit(hashU32(h ^ 2)) * 2 - 1;
          let rz = hashToUnit(hashU32(h ^ 3)) * 2 - 1;
          const dn = rx * nx + ry * ny + rz * nz;
          rx -= dn * nx;
          ry -= dn * ny;
          rz -= dn * nz;
          const rl = Math.sqrt(rx * rx + ry * ry + rz * rz) || 1;
          const phase = hashToUnit(hashU32(h ^ 4));
          // Phase measured from the cell centre keeps the argument small (precision).
          const xi = ((px - cx) * rx + (py - cy) * ry + (pz - cz) * rz) / (rl * this.wavelength) + phase + meander;
          const f = xi - Math.floor(xi);
          const s = Math.sin(2 * Math.PI * f);
          sum += wx * wy * wz * (s + 0.3 * Math.sin(4 * Math.PI * f + 0.6));
        }
      }
    }
    return sum;
  }
}

/** Sharpened partition of unity on [0, 1] (smoothstep of a steeper ramp), C1. */
const blend = (t: number): number => smoothstep01((t - 0.25) * 2);

export function createEarthLandcover(def: TerrainAmplificationDef, ctx: ModelContext): AmplificationModel {
  const p = (k: string): number => param(def, k);
  const R = ctx.services.radius;
  const svc = ctx.services;
  const perClass = (name: string): Float64Array => {
    const a = new Float64Array(LANDCOVER_CLASS_COUNT);
    for (const c of CLASS_NAMES) a[LANDCOVER_CLASS[c]] = p(`${name}.${c}`);
    return a;
  };
  const slope1m = perClass('slope1m');
  const ridged = perClass('ridged');
  const ripple = perClass('ripple');
  const dune = perClass('dune');
  const rockiness = perClass('rockiness');
  const rockK = perClass('rockK');
  const hurstLand = p('hurstLand');
  const hurstSeabed = p('hurstSeabed');
  const seabedSlope1m = p('seabedSlope1m');
  const seabedRamp = p('seabedDepthRampM');
  const mfGain = p('multifractalGain');
  const mfMax = p('multifractalMax');
  const steepRockSlope = p('steepRockSlope');
  const rippleL = p('rippleWavelengthM');
  const rippleA = p('rippleAmplitudeM');
  const duneL = p('duneWavelengthM');
  const duneA = p('duneAmplitudeM');
  const windCell = p('windCellM');
  const log2RippleL = Math.log2(rippleL);
  const log2DuneL = Math.log2(duneL);
  const log2LambdaDataMax = Math.log2(ctx.lambda0) - ctx.globalMaxLevel;
  let kMax = 0;
  for (let c = 0; c < LANDCOVER_CLASS_COUNT; c++) kMax = Math.max(kMax, rockK[c]!);

  const stack = new OctaveStack(def.seed >>> 0, Math.floor(ctx.log2FinestLambda), Math.ceil(log2LambdaDataMax));
  const ripples = new WaveTrains(subSeed(def.seed >>> 0, 501), rippleL, windCell, R);
  const dunes = new WaveTrains(subSeed(def.seed >>> 0, 502), duneL, windCell, R);
  const rocks =
    kMax > 0
      ? new RockField({
          seed: (def.seed ^ 0xa54ff53a) >>> 0,
          radius: R,
          minDiameter: p('rockMinDiameterM'),
          maxDiameter: p('rockMaxDiameterM'),
          collisionMinDiameter: p('rockCollisionMinDiameterM'),
          kMax,
          heightRatioMin: p('rockHeightRatioMin'),
          heightRatioMax: p('rockHeightRatioMax'),
          variants: p('rockVariants'),
        })
      : null;

  // Rock abundance k from land cover, a smooth field sampled on a lattice (land-cover texels are 9.5 m or
  // coarser); nodes computed while land-cover tiles were missing are provisional (smoothField.ts).
  const lc = new Float64Array(LANDCOVER_CLASS_COUNT);
  let lcIncomplete = false;
  const abundanceField = new LatticeField(
    p('rockAbundanceGridM'),
    R,
    (x, y, z) => {
      const r = svc.landcoverAt(x, y, z, lc);
      lcIncomplete = r === 2;
      if (r === 0) {
        lc.fill(0);
        lc[LANDCOVER_CLASS.unknown] = 1;
      }
      let k = 0;
      for (let c = 0; c < LANDCOVER_CLASS_COUNT; c++) k += lc[c]! * rockK[c]!;
      return k;
    },
    { generation: () => svc.dataGeneration(), lastRawIncomplete: () => lcIncomplete, onIncompleteUse: () => svc.markIncomplete() },
  );
  const rockAbundance = (x: number, y: number, z: number): number => {
    const flat = svc.flattenAt(x, y, z);
    if (flat >= 1) return 0;
    return abundanceField.at(x, y, z) * (1 - flat);
  };
  const halfGrid = abundanceField.spacing / 2;
  const rockAbundanceBound = (x: number, y: number, z: number, extent: number): number => (extent <= halfGrid ? abundanceField.blockMax(x, y, z) : Infinity);

  const M = 7;
  // Land cover read away from a query point: abundance nodes around rock centres (a rock reaches a point from
  // up to D/2 away; trilinear nodes lie within sqrt(3) grid of the rock centre) and the 3 x 3 x 3 node bounds
  // of candidate cells (cell extent <= half a grid, nodes within 1.5 sqrt(3) grid of the cell centre).
  const landcoverReach = rocks ? rocks.p.maxDiameter / 2 + abundanceField.spacing * (0.5 + 1.5 * Math.sqrt(3)) + halfGrid : 0;
  return {
    name: 'earth-landcover',
    modulatorCount: M,
    usesLandcover: true,
    rocks,
    landcoverReach,

    modulators(pt: PointInfo, m: Float64Array, o: number): void {
      const w = pt.landcover;
      let sSoft = 0;
      let sRidge = 0;
      let rip = 0;
      let dun = 0;
      let rk = 0;
      for (let c = 0; c < LANDCOVER_CLASS_COUNT; c++) {
        const wc = w ? w[c]! : c === LANDCOVER_CLASS.unknown ? 1 : 0;
        if (wc === 0) continue;
        sSoft += wc * slope1m[c]! * (1 - ridged[c]!);
        sRidge += wc * slope1m[c]! * ridged[c]!;
        rip += wc * ripple[c]!;
        dun += wc * dune[c]!;
        rk += wc * rockiness[c]!;
      }
      const sb = svc.seaLevel === null ? 0 : smoothstep01((svc.seaLevel - pt.dataHeight) / seabedRamp);
      const m0 = pt.log2LambdaData;
      const landRef = (sSoft + sRidge) * 2 ** (m0 * (hurstLand - 1));
      const mf = landRef > 0 ? multifractalFactor(pt.dataSlope / landRef, mfGain, mfMax) : 1;
      m[o] = m0;
      m[o + 1] = mf * ((1 - sb) * sSoft + sb * seabedSlope1m);
      m[o + 2] = mf * (1 - sb) * sRidge;
      m[o + 3] = hurstLand + (hurstSeabed - hurstLand) * sb;
      m[o + 4] = (1 - sb) * rip;
      m[o + 5] = (1 - sb) * dun;
      m[o + 6] = Math.min(1, (1 - sb) * (rk + (1 - rk) * smoothstep01((pt.dataSlope - steepRockSlope) / steepRockSlope)));
    },

    maxLengthLog2(log2LambdaData: number): number {
      return Math.max(log2LambdaData, rocks ? rockLog2Length(rocks.p.maxDiameter) : -Infinity);
    },

    add(px, py, pz, m, o, log2Lambdas, n, out, skipAboveLog2, withRocks): void {
      const m0 = m[o]!;
      const sSoft = m[o + 1]!;
      const sRidge = m[o + 2]!;
      const H = m[o + 3]!;
      const lmin = minOf(log2Lambdas, n);
      const top = stack.top(m0, skipAboveLog2);
      const bot = stack.bottom(lmin);
      if (top >= bot && sSoft + sRidge > 0) {
        let aS = noiseAmplitude(sSoft, top, H);
        // Ridged noise 1 - 2|n| has twice the gradient of n: halve it to keep the slope specification.
        let aR = noiseAmplitude(sRidge, top, H) * 0.5;
        const r = 2 ** -H;
        for (let j = top; j >= bot; j--, aS *= r, aR *= r) {
          const wE = smootherstep01(m0 - j);
          if (wE === 0) continue;
          const inv = 2 ** -j;
          const nz = stack.noise(j).value(px * inv, py * inv, pz * inv);
          const v = wE * (aS * nz + aR * (1 - 2 * Math.abs(nz) - RIDGE_MEAN));
          for (let b = 0; b < n; b++) out[b] = out[b]! + smootherstep01(j - log2Lambdas[b]!) * v;
        }
      }
      const dw = m[o + 5]!;
      if (dw > 0 && log2DuneL < skipAboveLog2) {
        const wE = smootherstep01(m0 - log2DuneL);
        if (wE > 0) {
          const v = wE * dw * duneA * dunes.value(px, py, pz);
          for (let b = 0; b < n; b++) out[b] = out[b]! + smootherstep01(log2DuneL - log2Lambdas[b]!) * v;
        }
      }
      const rw = m[o + 4]!;
      if (rw > 0 && log2RippleL < skipAboveLog2) {
        const wE = smootherstep01(m0 - log2RippleL);
        let any = false;
        for (let b = 0; b < n; b++) if (log2RippleL > log2Lambdas[b]!) any = true;
        if (wE > 0 && any) {
          const v = wE * rw * rippleA * ripples.value(px, py, pz);
          for (let b = 0; b < n; b++) out[b] = out[b]! + smootherstep01(log2RippleL - log2Lambdas[b]!) * v;
        }
      }
      if (rocks && withRocks) rocks.addBumps(px, py, pz, log2Lambdas, n, out, skipAboveLog2, rockAbundance);
    },

    material(_px, _py, _pz, m, o): number {
      return m[o + 6]!;
    },

    addBandRaster(job: BandRasterJob): void {
      const { top, bot, wb } = bandOctaves(stack, job);
      const mod = job.mod;
      const wDune = bandDiff(log2DuneL, job.log2LambdaN, job.log2LambdaLow);
      const wRip = bandDiff(log2RippleL, job.log2LambdaN, job.log2LambdaLow);
      for (let i = 0; i < job.count; i++) {
        const o = i * M;
        const m0 = mod[o]!;
        const sSoft = mod[o + 1]!;
        const sRidge = mod[o + 2]!;
        const H = mod[o + 3]!;
        const px = job.px[i]!;
        const py = job.py[i]!;
        const pz = job.pz[i]!;
        let sum = 0;
        const jt = Math.min(top, Math.ceil(m0) - 1);
        if (jt >= bot && sSoft + sRidge > 0) {
          let aS = noiseAmplitude(sSoft, jt, H);
          let aR = noiseAmplitude(sRidge, jt, H) * 0.5;
          const r = 2 ** -H;
          for (let j = jt; j >= bot; j--, aS *= r, aR *= r) {
            const w = wb[j - bot]!;
            if (w === 0) continue;
            const wE = smootherstep01(m0 - j);
            if (wE === 0) continue;
            const inv = 2 ** -j;
            const nz = stack.noise(j).value(px * inv, py * inv, pz * inv);
            sum += w * wE * (aS * nz + aR * (1 - 2 * Math.abs(nz) - RIDGE_MEAN));
          }
        }
        if (wDune !== 0 && mod[o + 5]! > 0) sum += wDune * smootherstep01(m0 - log2DuneL) * mod[o + 5]! * duneA * dunes.value(px, py, pz);
        if (wRip !== 0 && mod[o + 4]! > 0) sum += wRip * smootherstep01(m0 - log2RippleL) * mod[o + 4]! * rippleA * ripples.value(px, py, pz);
        job.out[i] = job.out[i]! + sum;
      }
      if (rocks) splatRocks(rocks, job, rockAbundance, rockAbundanceBound);
    },

    rockAbundance,
    rockAbundanceBound,

    amplitudeBound(log2Lambda: number, minE: number): number {
      const m0 = Math.log2(ctx.lambda0) - minE;
      let sMax = seabedSlope1m;
      for (let c = 0; c < LANDCOVER_CLASS_COUNT; c++) sMax = Math.max(sMax, slope1m[c]!);
      let sum = 0;
      for (let j = Math.ceil(m0) - 1; j > log2Lambda && j >= stack.jMin; j--) {
        sum += Math.max(noiseAmplitude(sMax * mfMax, j, hurstLand), noiseAmplitude(sMax * mfMax, j, hurstSeabed)) * NOISE_MAX;
      }
      if (log2DuneL > log2Lambda) sum += 1.3 * duneA;
      if (log2RippleL > log2Lambda) sum += 1.3 * rippleA;
      if (rocks) sum += (rocks.p.maxDiameter / 2) * rocks.p.heightRatioMax;
      return sum;
    },

    octaveBound(log2Lambda: number, m: Float64Array, o: number): number {
      const H = m[o + 3]!;
      const j1 = Math.floor(log2Lambda) + 1;
      const s = m[o + 1]! + m[o + 2]!;
      let b = Math.max(noiseAmplitude(s, j1, H), noiseAmplitude(s, j1 - 1, H)) * NOISE_MAX;
      if (Math.abs(log2DuneL - log2Lambda) < 1) b += 1.3 * duneA * m[o + 5]!;
      if (Math.abs(log2RippleL - log2Lambda) < 1) b += 1.3 * rippleA * m[o + 4]!;
      // Rocks whose weight changes between lambda and lambda / 2 have D in (lambda / 4, lambda): height <= ratio * D / 2.
      if (rocks) b += rocks.p.heightRatioMax * (2 ** log2Lambda / 2);
      return b;
    },
  };
}
