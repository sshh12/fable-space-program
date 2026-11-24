/**
 * The graphics part of the settings screen (ARCHITECTURE 24; frontend-ux 5.14, 9.6) as a model the menu
 * renders (`shell-menu` hosts the screen; this is what the rows ARE): the preset, the internal resolution,
 * one row per declared setting with its levels, its apply class and the calibration's predicted cost, and
 * the estimated-GPU bar against the governor's budget. Any manual change makes the preset 'custom' unless
 * the result is exactly a preset; the predictions stay on screen. The contract's `SettingsModel.graphics` is
 * `contract()`.
 */
import type { QualityLevelName, QualityProfile } from '@/core/contracts/render';
import type { SettingsModel } from '@/core/contracts/ui';
import { governorBudgetMs, QUALITY_LEVELS, type RegisteredSetting } from '@/render/core/quality';
import { FIXED_GROUP, predictGroups, predictShot, profilePixels, type ShotMeasurement } from './costModel';
import { presetOf } from './solver';
import { presetProfile, type PresetName, type QualityTable } from './table';

export interface GraphicsRow {
  settingId: string;
  label: string;
  featureId: string;
  level: QualityLevelName;
  /** The levels the setting offers, lowest first. */
  levels: QualityLevelName[];
  /** 'live' = applies next frame; 'rebuild' = "restarts view 1 s". */
  apply: 'live' | 'rebuild';
  /** Predicted GPU ms of this setting in the heaviest shot at the current profile; null before a calibration. */
  predictedMs: number | null;
}

export interface GraphicsModel {
  preset: PresetName | 'custom';
  profile: QualityProfile;
  resolution: { pixelCap: number; internalPx: [number, number]; displayPx: [number, number]; caps: number[] };
  rows: GraphicsRow[];
  /** The estimated-GPU bar: the predicted worst-shot p95 against the governor's budget, ms. */
  estimate: { gpuMs: number | null; budgetMs: number };
  /** Wall time of the calibration the predictions come from (null: none; the seed preset). */
  calibratedWallMs: number | null;
}

export class GraphicsSettings {
  private current: QualityProfile;

  constructor(
    private readonly table: QualityTable,
    private readonly settings: readonly RegisteredSetting[],
    private readonly displayPx: [number, number],
    profile: QualityProfile,
    /** The calibration's shots (empty without one) and when it ran. */
    private readonly shots: readonly ShotMeasurement[] = [],
    private readonly calibratedWallMs: number | null = null,
  ) {
    this.current = { ...profile, levels: { ...profile.levels } };
  }

  profile(): QualityProfile {
    return { ...this.current, levels: { ...this.current.levels } };
  }

  setPreset(name: PresetName): QualityProfile {
    this.current = { ...presetProfile(this.table, name, this.settings.map((s) => s.setting.id)), targetFps: this.current.targetFps };
    return this.profile();
  }

  setLevel(settingId: string, level: QualityLevelName): QualityProfile {
    if (!this.settings.some((s) => s.setting.id === settingId)) throw new Error(`graphics settings: no setting "${settingId}"`);
    this.current = { ...this.current, levels: { ...this.current.levels, [settingId]: level } };
    return this.profile();
  }

  setPixelCap(pixelCap: number): QualityProfile {
    if (!this.table.solver.pixelCaps.includes(pixelCap)) throw new Error(`graphics settings: ${pixelCap} MP is not one of ${this.table.solver.pixelCaps.join(', ')}`);
    this.current = { ...this.current, pixelCap };
    return this.profile();
  }

  setTargetFps(targetFps: number): QualityProfile {
    this.current = { ...this.current, targetFps };
    return this.profile();
  }

  /** The heaviest shot at the current profile (the rows' numbers come from it). */
  private worst(): { shot: ShotMeasurement; ms: number } | null {
    let w: { shot: ShotMeasurement; ms: number } | null = null;
    for (const shot of this.shots) {
      const ms = predictShot(shot, this.settings, this.current, this.displayPx, this.table.attribution.fixedExponent);
      if (!w || ms > w.ms) w = { shot, ms };
    }
    return w;
  }

  model(): GraphicsModel {
    const w = this.worst();
    const px = profilePixels(this.current, this.displayPx);
    const groups = w && w.shot.perPass ? predictGroups(w.shot, this.settings, this.current.levels, px, this.table.attribution.fixedExponent) : null;
    const s = Math.sqrt(px / (this.displayPx[0] * this.displayPx[1]));
    return {
      preset: presetOf({ table: this.table, settings: this.settings }, this.current) ?? 'custom',
      profile: this.profile(),
      resolution: { pixelCap: this.current.pixelCap, internalPx: [Math.round(this.displayPx[0] * s), Math.round(this.displayPx[1] * s)], displayPx: [...this.displayPx], caps: [...this.table.solver.pixelCaps] },
      rows: this.settings.map(({ featureId, setting }) => ({
        settingId: setting.id,
        label: setting.label,
        featureId,
        level: this.current.levels[setting.id] ?? 'ultra',
        levels: QUALITY_LEVELS.filter((l) => setting.levels.some((x) => x.name === l)),
        apply: setting.apply,
        predictedMs: groups ? (groups[setting.id] ?? 0) : null,
      })),
      estimate: { gpuMs: w ? w.ms : null, budgetMs: governorBudgetMs(this.current.targetFps) },
      calibratedWallMs: this.calibratedWallMs,
    };
  }

  /** What the shell stores and hands on (`SettingsModel.graphics`). */
  contract(): SettingsModel['graphics'] {
    const m = this.model();
    return { preset: m.preset, profile: m.profile, predictedGpuMs: m.estimate.gpuMs, calibratedWallMs: this.calibratedWallMs };
  }

  /** Predicted fixed cost (everything no setting governs) in the heaviest shot, ms; null without a calibration. */
  fixedMs(): number | null {
    const w = this.worst();
    if (!w || !w.shot.perPass) return null;
    return predictGroups(w.shot, this.settings, this.current.levels, profilePixels(this.current, this.displayPx), this.table.attribution.fixedExponent)[FIXED_GROUP] ?? 0;
  }
}
