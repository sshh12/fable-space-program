/**
 * 'lunar-regolith': amplification of an airless, cratered regolith surface (data/defs/terrain/*.amplification.json).
 *
 *  - Regolith fBm: gradient-noise octaves 2^j m below the data wavelength, RMS slope per octave
 *    S (lambda / 1 m)^(H - 1). S = regolithSlope1m * multifractal factor (rougher where the data is rougher
 *    than the mare reference at the data scale), H between hurstMaria and hurstHighlands by the same
 *    roughness ratio. regolithSlope1m is calibrated against the NAC DTM (tools/terrain-core/calibrate-regolith.ts).
 *  - Craters (craters.ts): equilibrium size-frequency, half-octave classes from craterMinDiameterM up to
 *    craterMaxDiameterInPostings postings of the effective data level, freshness weighted to degraded craters.
 *  - Rocks (rocks.ts): Golombek-Rapp abundance k from rockAreaFractionMare up to rockAreaFractionFreshEjecta
 *    on the ejecta of fresh craters of at least rockSourceMinCraterDiameterM; rocks of at least
 *    rockCollisionMinDiameterM are bumps in the height function.
 * Modulators: [0] log2 data wavelength, [1] S (RMS slope at 1 m), [2] H.
 */
import type { TerrainAmplificationDef } from '../../core/contracts/defs';
import { CraterField, type CraterParams } from '../craters';
import { NOISE_MAX } from '../noise';
import { RockField, rockLog2Length } from '../rocks';
import { LatticeField } from '../smoothField';
import { smoothstep01, smootherstep01 } from '../util';
import { bandOctaves, minOf, multifractalFactor, noiseAmplitude, OctaveStack, param, splatCraters, splatRocks } from './common';
import type { AmplificationModel, BandRasterJob, ModelContext, PointInfo } from './types';

/** Crater-field parameters of a lunar-regolith definition (the model's own craters; also used by tests). */
export function lunarCraterParams(def: TerrainAmplificationDef, radius: number, globalMaxLevel: number, lambda0: number): CraterParams {
  const p = (k: string): number => param(def, k);
  const craterOffset = Math.log2(p('craterMaxDiameterInPostings') / 2);
  return {
    seed: (def.seed ^ 0x3c6ef372) >>> 0,
    radius,
    minDiameter: p('craterMinDiameterM'),
    maxDiameter: 2 ** (Math.log2(lambda0) - globalMaxLevel + craterOffset),
    equilibriumFraction: p('craterEquilibriumFraction'),
    extentRadii: p('craterEjectaExtentRadii'),
    freshDepthToDiameter: p('freshDepthToDiameter'),
    degradedDepthToDiameter: p('degradedDepthToDiameter'),
    rimHeightToDiameter: p('rimHeightToDiameter'),
    rimDegraded: p('degradedRimFraction'),
    freshnessExponent: p('craterFreshnessExponent'),
    rimRoundingFresh: p('rimRoundingFresh'),
    rimRoundingDegraded: p('rimRoundingDegraded'),
  };
}

export function createLunarRegolith(def: TerrainAmplificationDef, ctx: ModelContext): AmplificationModel {
  const p = (k: string): number => param(def, k);
  const R = ctx.services.radius;
  const hurstMaria = p('hurstMaria');
  const hurstHighlands = p('hurstHighlands');
  const hurstRange = p('hurstRoughnessRange');
  const slope1m = p('regolithSlope1m');
  const mfGain = p('multifractalGain');
  const mfMax = p('multifractalMax');
  const craterPostings = p('craterMaxDiameterInPostings');
  // log2 of the largest procedural crater = log2(craterPostings * posting(E)) = log2LambdaData + log2(craterPostings / 2).
  const craterOffset = Math.log2(craterPostings / 2);
  const log2LambdaDataMax = Math.log2(ctx.lambda0) - ctx.globalMaxLevel;
  const kMare = p('rockAreaFractionMare');
  const kFresh = p('rockAreaFractionFreshEjecta');
  const rockSourceMinD = p('rockSourceMinCraterDiameterM');

  const craters = new CraterField(lunarCraterParams(def, R, ctx.globalMaxLevel, ctx.lambda0));
  const rocks = new RockField({
    seed: (def.seed ^ 0xa54ff53a) >>> 0,
    radius: R,
    minDiameter: p('rockMinDiameterM'),
    maxDiameter: p('rockMaxDiameterM'),
    collisionMinDiameter: p('rockCollisionMinDiameterM'),
    kMax: Math.max(kMare, kFresh),
    heightRatioMin: p('rockHeightRatioMin'),
    heightRatioMax: p('rockHeightRatioMax'),
    variants: p('rockVariants'),
  });
  const stack = new OctaveStack(def.seed >>> 0, Math.floor(ctx.log2FinestLambda), Math.ceil(log2LambdaDataMax));
  // Inner scale of the regolith fBm: octaves fade out below regolithInnerScaleM (full at >= inner, zero at
  // <= inner / 2). Below it the surface is fine dust: small craters and rocks carry the relief.
  const log2Inner = Math.log2(p('regolithInnerScaleM'));
  const innerW = new Float64Array(stack.jMax - stack.jMin + 1);
  for (let j = stack.jMin; j <= stack.jMax; j++) innerW[j - stack.jMin] = smootherstep01(j - log2Inner + 1);
  const svc = ctx.services;

  // Rock abundance k: mare background plus fresh crater ejecta. A smooth field (ejecta of craters of at
  // least rockSourceMinCraterDiameterM), so it is sampled on a lattice and interpolated; it depends only on
  // the manifest (E) and the crater hash, never on resident data.
  const abundanceField = new LatticeField(
    p('rockAbundanceGridM'),
    R,
    (x, y, z) => {
      const E = svc.effectiveLevelAt(x, y, z);
      const src = craters.rockSource(x, y, z, Math.log2(ctx.lambda0) - E + craterOffset, rockSourceMinD);
      return kMare + (kFresh - kMare) * src;
    },
    null,
  );
  const rockAbundance = (x: number, y: number, z: number): number => {
    const flat = svc.flattenAt(x, y, z);
    if (flat >= 1) return 0;
    return abundanceField.at(x, y, z) * (1 - flat);
  };
  const halfGrid = abundanceField.spacing / 2;
  const rockAbundanceBound = (x: number, y: number, z: number, extent: number): number => (extent <= halfGrid ? abundanceField.blockMax(x, y, z) : Infinity);

  const M = 3;
  return {
    name: 'lunar-regolith',
    modulatorCount: M,
    usesLandcover: false,
    rocks,

    modulators(pt: PointInfo, m: Float64Array, o: number): void {
      const m0 = pt.log2LambdaData;
      const sRef = slope1m * 2 ** (m0 * (hurstMaria - 1));
      const ratio = pt.dataSlope / sRef;
      m[o] = m0;
      m[o + 1] = slope1m * multifractalFactor(ratio, mfGain, mfMax);
      m[o + 2] = hurstMaria + (hurstHighlands - hurstMaria) * smoothstep01((ratio - 1) / hurstRange);
    },

    maxLengthLog2(log2LambdaData: number): number {
      return Math.max(log2LambdaData, log2LambdaData + craterOffset, rockLog2Length(rocks.p.maxDiameter));
    },

    add(px, py, pz, m, o, log2Lambdas, n, out, skipAboveLog2, withRocks): void {
      const m0 = m[o]!;
      const S = m[o + 1]!;
      const H = m[o + 2]!;
      const lmin = minOf(log2Lambdas, n);
      const top = stack.top(m0, skipAboveLog2);
      const bot = stack.bottom(lmin);
      if (top >= bot) {
        let a = noiseAmplitude(S, top, H);
        const r = 2 ** -H;
        for (let j = top; j >= bot; j--, a *= r) {
          const wE = smootherstep01(m0 - j) * innerW[j - stack.jMin]!;
          if (wE === 0) continue;
          const inv = 2 ** -j;
          const v = a * wE * stack.noise(j).value(px * inv, py * inv, pz * inv);
          for (let b = 0; b < n; b++) out[b] = out[b]! + smootherstep01(j - log2Lambdas[b]!) * v;
        }
      }
      craters.add(px, py, pz, m0 + craterOffset, log2Lambdas, n, out, skipAboveLog2);
      if (withRocks) rocks.addBumps(px, py, pz, log2Lambdas, n, out, skipAboveLog2, rockAbundance);
    },

    material(px, py, pz, m, o, minLog2, maxLog2): number {
      return craters.freshness(px, py, pz, m[o]! + craterOffset, minLog2, maxLog2);
    },

    addBandRaster(job: BandRasterJob): void {
      const { top, bot, wb } = bandOctaves(stack, job);
      const mod = job.mod;
      for (let i = 0; i < job.count; i++) {
        const m0 = mod[i * M]!;
        const S = mod[i * M + 1]!;
        const H = mod[i * M + 2]!;
        const jt = Math.min(top, Math.ceil(m0) - 1);
        if (jt < bot) continue;
        let a = noiseAmplitude(S, jt, H);
        const r = 2 ** -H;
        const px = job.px[i]!;
        const py = job.py[i]!;
        const pz = job.pz[i]!;
        let sum = 0;
        for (let j = jt; j >= bot; j--, a *= r) {
          const w = wb[j - bot]! * innerW[j - stack.jMin]!;
          if (w === 0) continue;
          const wE = smootherstep01(m0 - j);
          if (wE === 0) continue;
          const inv = 2 ** -j;
          sum += w * wE * a * stack.noise(j).value(px * inv, py * inv, pz * inv);
        }
        job.out[i] = job.out[i]! + sum;
      }
      splatCraters(craters, job, (i) => mod[i * M]! + craterOffset);
      splatRocks(rocks, job, rockAbundance, rockAbundanceBound);
    },

    rockAbundance,
    rockAbundanceBound,

    amplitudeBound(log2Lambda: number, minE: number): number {
      const m0 = Math.log2(ctx.lambda0) - minE;
      let sum = 0;
      for (let j = Math.ceil(m0) - 1; j > log2Lambda && j >= stack.jMin; j--) {
        const a = Math.max(noiseAmplitude(slope1m * mfMax, j, hurstMaria), noiseAmplitude(slope1m * mfMax, j, hurstHighlands));
        sum += a * NOISE_MAX;
      }
      const log2MaxD = m0 + craterOffset;
      for (const c of craters.classes) {
        if (c.log2DHi > log2MaxD + 1 || c.log2DLo <= log2Lambda) continue;
        sum += 2 * CraterField.reliefBound(craters.p, c.dHi);
      }
      sum += (rocks.p.maxDiameter / 2) * rocks.p.heightRatioMax;
      return sum;
    },

    octaveBound(log2Lambda: number, m: Float64Array, o: number): number {
      const S = m[o + 1]!;
      const H = m[o + 2]!;
      const j1 = Math.floor(log2Lambda) + 1;
      const noise = Math.max(noiseAmplitude(S, j1, H), noiseAmplitude(S, j1 - 1, H)) * NOISE_MAX;
      let crater = 0;
      for (const c of craters.classes) {
        if (c.log2DLo - log2Lambda > -1 && c.log2DLo - log2Lambda < 1) crater += CraterField.reliefBound(craters.p, c.dHi);
      }
      // Rocks whose weight changes between lambda and lambda / 2 have D in (lambda / 4, lambda): height <= ratio * D / 2.
      const rock = rocks.p.heightRatioMax * (2 ** log2Lambda / 2);
      return noise + crater + rock;
    },
  };
}
