/**
 * The calibration's cost model (frontend-ux 9.3; the contract's `FeatureQualityDecl.costModel`):
 *
 *   ms_s(level, px) = constantMs + (measured_s - constantMs) x ratio_s(level) / ratio_s(measured level) x (px / px_measured) ^ exponent_s
 *   ms_fixed(px)    = measured_fixed x (px / px_measured) ^ fixedExponent
 *
 * per declared setting s, from the GPU passes of a shot attributed to it (quality.json `attribution`: a
 * rule's passes, or the passes of the feature that declares the setting), and for everything no setting
 * claims. The prediction of a shot's p95 is its measured p95 times the ratio of the predicted mean frame to
 * the measured mean frame: the measured spread of the frames is kept, the model only moves its level.
 */
import type { QualityLevelName, QualityProfile } from '@/core/contracts/render';
import { renderScaleCap, type RegisteredSetting } from '@/render/core/quality';
import type { QualityTable } from './table';

/** One frame of a shot: its GPU total (ballast excluded) and its passes (attribution mode), ms. */
export interface FrameSample {
  total: number;
  passes: Readonly<Record<string, number>>;
}

/** What a shot measured, reduced to what the solver and the settings screen need. */
export interface ShotMeasurement {
  shotId: string;
  /** Internal pixels it was rendered at and the levels in force. */
  pixels: number;
  levels: Record<string, QualityLevelName>;
  frames: number;
  /** p95 and mean of the frame's GPU total, ms. */
  gpuP95: number;
  gpuMean: number;
  /** Mean ms per cost group: the setting ids and 'fixed'. Absent groups cost nothing in this shot. */
  groups: Record<string, number>;
  /** p95 of the main thread's frame time, ms. */
  cpuP95: number;
  /** False when the browser had no timestamp queries: only `gpuP95` / `gpuMean` hold (from the queue's completion latency). */
  perPass: boolean;
}

export const FIXED_GROUP = 'fixed';

/** Assigns pass names to cost groups. */
export function passAssigner(settings: readonly RegisteredSetting[], attribution: QualityTable['attribution']): (pass: string) => string | null {
  const ignore = new RegExp(attribution.ignore);
  const declared = new Set(settings.map((s) => s.setting.id));
  const rules = Object.entries(attribution.rules)
    .filter(([id]) => declared.has(id))
    .map(([id, re]) => [id, new RegExp(re)] as const);
  const ruled = new Set(rules.map(([id]) => id));
  // A feature's passes go to the first of its settings that no rule describes.
  const byFeature = new Map<string, string>();
  for (const s of settings) if (!ruled.has(s.setting.id) && !byFeature.has(s.featureId)) byFeature.set(s.featureId, s.setting.id);
  const cache = new Map<string, string | null>();
  return (pass) => {
    const hit = cache.get(pass);
    if (hit !== undefined) return hit;
    let group: string | null;
    if (ignore.test(pass)) group = null;
    else {
      const rule = rules.find(([, re]) => re.test(pass));
      group = rule ? rule[0] : (byFeature.get(pass.split('.')[0]!) ?? FIXED_GROUP);
    }
    cache.set(pass, group);
    return group;
  };
}

const percentile = (xs: readonly number[], p: number): number => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))]!;
};

/** Reduce a shot's frames to its measurement. */
export function measureShot(
  shotId: string,
  frames: readonly FrameSample[],
  cpuFrameMs: readonly number[],
  pixels: number,
  levels: Record<string, QualityLevelName>,
  settings: readonly RegisteredSetting[],
  attribution: QualityTable['attribution'],
): ShotMeasurement {
  const assign = passAssigner(settings, attribution);
  const groups: Record<string, number> = {};
  const totals: number[] = [];
  let perPass = false;
  for (const f of frames) {
    let total = 0;
    const names = Object.keys(f.passes);
    if (names.length > 0) perPass = true;
    for (const name of names) {
      const g = assign(name);
      if (g === null) continue;
      const ms = f.passes[name]!;
      groups[g] = (groups[g] ?? 0) + ms;
      total += ms;
    }
    totals.push(names.length > 0 ? total : f.total);
  }
  const n = Math.max(1, frames.length);
  for (const g of Object.keys(groups)) groups[g]! /= n;
  const mean = totals.reduce((a, b) => a + b, 0) / n;
  return { shotId, pixels, levels: { ...levels }, frames: frames.length, gpuP95: percentile(totals, 0.95), gpuMean: mean, groups: perPass ? groups : {}, cpuP95: percentile(cpuFrameMs, 0.95), perPass };
}

/** Internal pixels a profile renders at on a display (the pixel cap, never more than the display). */
export function profilePixels(profile: Pick<QualityProfile, 'pixelCap'>, displayPx: readonly [number, number]): number {
  const s = renderScaleCap(profile.pixelCap, displayPx[0], displayPx[1]);
  return Math.round(displayPx[0] * s) * Math.round(displayPx[1] * s);
}

const ratioOf = (setting: RegisteredSetting['setting'], level: QualityLevelName): number => setting.costModel.ratios[level] ?? 1;

/** Predicted mean ms of each group of a shot at `levels` and `pixels`. */
export function predictGroups(m: ShotMeasurement, settings: readonly RegisteredSetting[], levels: Record<string, QualityLevelName>, pixels: number, fixedExponent: number): Record<string, number> {
  const k = pixels / Math.max(1, m.pixels);
  const out: Record<string, number> = {};
  for (const { setting } of settings) {
    const measured = m.groups[setting.id];
    if (measured === undefined) continue;
    const c = Math.min(setting.costModel.constantMs, measured);
    const from = ratioOf(setting, m.levels[setting.id] ?? 'ultra');
    const to = ratioOf(setting, levels[setting.id] ?? 'ultra');
    out[setting.id] = c + ((measured - c) * to) / from * k ** setting.costModel.exponent;
  }
  const fixed = m.groups[FIXED_GROUP];
  if (fixed !== undefined) out[FIXED_GROUP] = fixed * k ** fixedExponent;
  return out;
}

/** Predicted p95 GPU ms of a shot at a profile on a display. */
export function predictShot(m: ShotMeasurement, settings: readonly RegisteredSetting[], profile: QualityProfile, displayPx: readonly [number, number], fixedExponent: number): number {
  const px = profilePixels(profile, displayPx);
  if (!m.perPass) {
    // No per-pass split: only the resolution is modelled.
    return m.gpuP95 * (px / Math.max(1, m.pixels)) ** fixedExponent;
  }
  const g = predictGroups(m, settings, profile.levels, px, fixedExponent);
  const mean = Object.values(g).reduce((a, b) => a + b, 0);
  return m.gpuMean > 0 ? (m.gpuP95 * mean) / m.gpuMean : mean;
}
