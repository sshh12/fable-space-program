/**
 * The solver of frontend-ux 9.3: the internal pixel cap and the level of every declared setting that
 * maximise the perceptual weight (the pixel cap's steps x resolutionWeight + each setting's weight x its
 * level) while every shot's predicted p95 stays under budgetShare x the governor's budget; then a snap to a
 * named preset when every setting is within one level of it and the preset itself fits; then the step-down
 * after a confirmation run that came out over the budget.
 *
 * The search, per pixel cap: every setting starts at Low; while the budget allows, the one step up with the
 * most weight per predicted millisecond is taken (a step that costs nothing is taken first). A cap at which
 * even every setting at Low does not fit is not a candidate. Deterministic, a few thousand predictions.
 */
import type { QualityLevelName, QualityProfile } from '@/core/contracts/render';
import { governorBudgetMs, QUALITY_LEVELS, type RegisteredSetting } from '@/render/core/quality';
import { predictGroups, predictShot, profilePixels, type ShotMeasurement } from './costModel';
import { PRESET_NAMES, presetProfile, type PresetName, type QualityTable } from './table';

export interface SolveInput {
  table: QualityTable;
  settings: readonly RegisteredSetting[];
  shots: readonly ShotMeasurement[];
  displayPx: readonly [number, number];
  /** Frame rate the governor holds (default: the table's). */
  targetFps?: number;
}

export interface SolveResult {
  profile: QualityProfile;
  /** The named preset the profile is, or 'custom'. */
  preset: PresetName | 'custom';
  /** Predicted p95 GPU ms per shot at the profile, and the worst of them. */
  predicted: Record<string, number>;
  worstMs: number;
  /** The limit the prediction was held under: budgetShare x the governor's budget, ms. */
  limitMs: number;
  /** True when not even the lowest pixel cap with every setting at Low fits (the result is then that profile). */
  overBudget: boolean;
}

const levelIndex = (l: QualityLevelName): number => QUALITY_LEVELS.indexOf(l);

export function worstPrediction(input: SolveInput, profile: QualityProfile): { predicted: Record<string, number>; worst: number } {
  const predicted: Record<string, number> = {};
  let worst = 0;
  for (const m of input.shots) {
    const ms = predictShot(m, input.settings, profile, input.displayPx, input.table.attribution.fixedExponent);
    predicted[m.shotId] = ms;
    worst = Math.max(worst, ms);
  }
  return { predicted, worst };
}

/** The perceptual score of a profile (what the solver maximises). */
export function scoreOf(input: SolveInput, profile: QualityProfile): number {
  const caps = input.table.solver.pixelCaps;
  let capStep = 0;
  for (let i = 0; i < caps.length; i++) if (profile.pixelCap >= caps[i]! - 1e-9) capStep = i;
  let s = capStep * input.table.solver.resolutionWeight;
  for (const { setting } of input.settings) s += setting.weight * levelIndex(profile.levels[setting.id] ?? 'ultra');
  return s;
}

/** The preset a profile is exactly (pixel cap, floor and every listed setting at its level), or null. */
export function presetOf(input: Pick<SolveInput, 'table' | 'settings'>, profile: QualityProfile): PresetName | null {
  for (const name of PRESET_NAMES) {
    const p = input.table.presets[name];
    if (Math.abs(p.pixelCap - profile.pixelCap) > 1e-9 || Math.abs(p.renderScaleMin - profile.renderScaleMin) > 1e-9) continue;
    if (input.settings.every(({ setting }) => (profile.levels[setting.id] ?? 'ultra') === name)) return name;
  }
  return null;
}

export function solve(input: SolveInput): SolveResult {
  const { table, settings } = input;
  const targetFps = input.targetFps ?? table.targetFps;
  const limitMs = table.solver.budgetShare * governorBudgetMs(targetFps);
  const ids = settings.map((s) => s.setting.id);
  const floorFor = (cap: number): number => {
    // The floor of the preset whose cap is the nearest at or below this one.
    let floor = table.presets.low.renderScaleMin;
    for (const n of PRESET_NAMES) if (table.presets[n].pixelCap <= cap + 1e-9) floor = table.presets[n].renderScaleMin;
    return floor;
  };
  let best: { profile: QualityProfile; score: number } | null = null;
  for (const cap of table.solver.pixelCaps) {
    const levels: Record<string, QualityLevelName> = Object.fromEntries(ids.map((id) => [id, 'low' as QualityLevelName]));
    const profile = (): QualityProfile => ({ pixelCap: cap, renderScaleMin: floorFor(cap), targetFps, levels: { ...levels } });
    let current = worstPrediction(input, profile()).worst;
    if (current > limitMs) continue;
    for (;;) {
      let pick: { id: string; value: number; ms: number } | null = null;
      for (const { setting } of settings) {
        const i = levelIndex(levels[setting.id]!);
        if (i >= QUALITY_LEVELS.length - 1) continue;
        const was = levels[setting.id]!;
        levels[setting.id] = QUALITY_LEVELS[i + 1]!;
        const ms = worstPrediction(input, profile()).worst;
        levels[setting.id] = was;
        if (ms > limitMs) continue;
        const value = setting.weight / Math.max(1e-4, ms - current);
        if (!pick || value > pick.value) pick = { id: setting.id, value, ms };
      }
      if (!pick) break;
      levels[pick.id] = QUALITY_LEVELS[levelIndex(levels[pick.id]!) + 1]!;
      current = pick.ms;
    }
    const p = profile();
    const score = scoreOf(input, p);
    if (!best || score > best.score || (score === best.score && worstPrediction(input, p).worst < worstPrediction(input, best.profile).worst)) best = { profile: p, score };
  }
  if (!best) {
    const lowest = { ...presetProfile(table, 'low', ids), pixelCap: table.solver.pixelCaps[0]!, targetFps };
    const w = worstPrediction(input, lowest);
    return { profile: lowest, preset: presetOf(input, lowest) ?? 'custom', predicted: w.predicted, worstMs: w.worst, limitMs, overBudget: true };
  }
  // Snap to the highest named preset that fits and that every setting of the solution is within one level of.
  let chosen = best.profile;
  for (const name of [...PRESET_NAMES].reverse()) {
    const p = { ...presetProfile(table, name, ids), targetFps };
    const near = settings.every(({ setting }) => Math.abs(levelIndex(best.profile.levels[setting.id]!) - levelIndex(name)) <= 1);
    const capStep = (c: number): number => table.solver.pixelCaps.findIndex((x) => x >= c - 1e-9);
    if (!near || Math.abs(capStep(p.pixelCap) - capStep(best.profile.pixelCap)) > 1) continue;
    if (worstPrediction(input, p).worst <= limitMs) {
      chosen = p;
      break;
    }
  }
  const w = worstPrediction(input, chosen);
  return { profile: chosen, preset: presetOf(input, chosen) ?? 'custom', predicted: w.predicted, worstMs: w.worst, limitMs, overBudget: false };
}

/**
 * One step down after a confirmation run over the budget: the setting whose one-level step saves the most
 * predicted milliseconds in the confirmation shot, or the pixel cap's step when that saves more. Null when
 * nothing can be lowered any more.
 */
export function stepDown(input: SolveInput, profile: QualityProfile, confirmShot: ShotMeasurement): QualityProfile | null {
  const px = profilePixels(profile, input.displayPx);
  const now = predictGroups(confirmShot, input.settings, profile.levels, px, input.table.attribution.fixedExponent);
  const total = (g: Record<string, number>): number => Object.values(g).reduce((a, b) => a + b, 0);
  let best: { profile: QualityProfile; saved: number } | null = null;
  for (const { setting } of input.settings) {
    const i = levelIndex(profile.levels[setting.id] ?? 'ultra');
    if (i === 0) continue;
    const levels = { ...profile.levels, [setting.id]: QUALITY_LEVELS[i - 1]! };
    const saved = total(now) - total(predictGroups(confirmShot, input.settings, levels, px, input.table.attribution.fixedExponent));
    if (!best || saved > best.saved) best = { profile: { ...profile, levels }, saved };
  }
  const caps = input.table.solver.pixelCaps;
  const lower = [...caps].reverse().find((c) => c < profile.pixelCap - 1e-9);
  if (lower !== undefined) {
    const p = { ...profile, pixelCap: lower, renderScaleMin: Math.min(profile.renderScaleMin, input.table.presets.low.renderScaleMin) };
    const saved = total(now) - total(predictGroups(confirmShot, input.settings, p.levels, profilePixels(p, input.displayPx), input.table.attribution.fixedExponent));
    if (!best || saved > best.saved) best = { profile: p, saved };
  }
  return best ? best.profile : null;
}
