/**
 * The generic cratered-surface models of the simple bodies (ARCHITECTURE 8.5): 'rocky-generic' and
 * 'icy-generic', both DERIVED FROM 'lunar-regolith' (lunarRegolith.ts, frozen): the same regolith fBm with
 * multifractal roughness, the same equilibrium crater population and the same Golombek-Rapp rocks, evaluated
 * by the same code, so the band-limit, effective-level and continuity guarantees the Moon's tests prove hold
 * unchanged. What differs is the data: each key has its parameter file
 * (data/defs/terrain/<key>.amplification.json) and every body's terrain section may override single
 * parameters (a body with almost no small craters, such as Venus or Io, lowers craterEquilibriumFraction).
 *
 * The same crater population, at diameters above what the run-time model renders, is baked into the tiles of
 * bodies with no global map (tools/bake/planet/procedural.ts): the run-time model takes class weight
 * w_E = smootherstep(log2MaxD(E) - log2 D_hi) and the bake takes 1 - w_E at E = globalMaxLevel, so every crater
 * is drawn once.
 */
import type { TerrainAmplificationDef } from '../../core/contracts/defs';
import type { CraterClass, CraterParams } from '../craters';
import { smootherstep01 } from '../util';
import { createLunarRegolith, lunarCraterParams } from './lunarRegolith';
import type { AmplificationModel, ModelContext } from './types';

/** Registry keys of the generic models. */
export const GENERIC_MODELS = ['rocky-generic', 'icy-generic'] as const;
export type GenericModelName = (typeof GENERIC_MODELS)[number];

/** Every parameter a generic model reads (the lunar-regolith set); a body's definition must give all of them. */
export const GENERIC_PARAMS = [
  'hurstMaria',
  'hurstHighlands',
  'hurstRoughnessRange',
  'regolithSlope1m',
  'regolithInnerScaleM',
  'multifractalGain',
  'multifractalMax',
  'craterEquilibriumFraction',
  'craterMaxDiameterInPostings',
  'craterMinDiameterM',
  'craterEjectaExtentRadii',
  'freshDepthToDiameter',
  'degradedDepthToDiameter',
  'rimHeightToDiameter',
  'degradedRimFraction',
  'craterFreshnessExponent',
  'rimRoundingFresh',
  'rimRoundingDegraded',
  'rockAreaFractionMare',
  'rockAreaFractionFreshEjecta',
  'rockSourceMinCraterDiameterM',
  'rockAbundanceGridM',
  'rockMinDiameterM',
  'rockMaxDiameterM',
  'rockCollisionMinDiameterM',
  'rockHeightRatioMin',
  'rockHeightRatioMax',
  'rockVariants',
] as const;

function checkDef(name: GenericModelName, def: TerrainAmplificationDef, bodyId: string): void {
  if (def.model !== name) throw new Error(`body "${bodyId}": amplification model "${def.model}" given to the ${name} factory`);
  const missing = GENERIC_PARAMS.filter((k) => typeof def.params[k] !== 'number' || !Number.isFinite(def.params[k]));
  if (missing.length > 0) throw new Error(`body "${bodyId}": terrain amplification "${name}" is missing parameters ${missing.join(', ')}`);
  const unknown = Object.keys(def.params).filter((k) => !(GENERIC_PARAMS as readonly string[]).includes(k) && !k.startsWith('calibration'));
  if (unknown.length > 0) throw new Error(`body "${bodyId}": terrain amplification "${name}" has unknown parameters ${unknown.join(', ')}`);
}

export function createGenericModel(name: GenericModelName, def: TerrainAmplificationDef, ctx: ModelContext): AmplificationModel {
  checkDef(name, def, ctx.services.bodyId);
  return { ...createLunarRegolith(def, ctx), name };
}

/**
 * Crater-field parameters of a generic definition with the classes extended up to `maxDiameter` (m). Classes
 * are indexed from craterMinDiameterM upward with a seed per class, so the classes below the run-time limit
 * are exactly the run-time model's.
 */
export function genericCraterParams(def: TerrainAmplificationDef, radius: number, globalMaxLevel: number, lambda0: number, maxDiameter: number): CraterParams {
  const p = lunarCraterParams(def, radius, globalMaxLevel, lambda0);
  return { ...p, maxDiameter: Math.max(p.maxDiameter, maxDiameter) };
}

/** log2 of the largest crater diameter the run-time model draws where the effective data level is E. */
export function runtimeCraterLog2MaxD(def: TerrainAmplificationDef, lambda0: number, E: number): number {
  const postings = def.params['craterMaxDiameterInPostings'];
  if (typeof postings !== 'number') throw new Error(`terrain amplification "${def.model}": craterMaxDiameterInPostings missing`);
  return Math.log2(lambda0) - E + Math.log2(postings / 2);
}

/**
 * Weight of a crater class in the bake of a procedural body (tools/bake/planet/procedural.ts): the complement
 * of the run-time model's weight smootherstep(log2MaxD_rt - log2 D_hi) (CraterField.add), times the bake's own
 * sampling fade smootherstep(log2 D_lo - log2 lambda), so run time and bake together draw each crater once.
 */
export function bakeCraterWeight(c: Pick<CraterClass, 'log2DLo' | 'log2DHi'>, log2MaxDRuntime: number, log2Lambda: number): number {
  return (1 - smootherstep01(log2MaxDRuntime - c.log2DHi)) * smootherstep01(c.log2DLo - log2Lambda);
}
