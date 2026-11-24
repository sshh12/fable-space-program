/**
 * The calibration (ARCHITECTURE 24; frontend-ux 5.2, 9.3): the shots of the quality table flown at Ultra
 * through the host's real renderer, session and scripted pilot with the governor off and per-pass GPU
 * timestamps; the solver; a confirmation run of the confirmation shot with the governor on and at most
 * `confirmStepsMax` step-downs; the below-minimum verdict; the CPU score. The host is the page (the app, or
 * labs/bench): it knows the session, the pilot, the cameras and the renderer; this module knows none of them.
 *
 * It refuses to start while `host.resident()` is false: the shots' tiles and assets stream behind the title
 * and a slow mirror delays the calibration, never the title (ARCHITECTURE 23). A device lost in a shot ends
 * the calibration at the safe preset with a note, never in a loop (frontend-ux 5.2).
 */
import type { QualityProfile } from '@/core/contracts/render';
import { governorBudgetMs, type RegisteredSetting } from '@/render/core/quality';
import { measureShot, predictShot, profilePixels, type FrameSample, type ShotMeasurement } from './costModel';
import { cpuScoreOf, type CpuReference } from './cpuScore';
import { presetOf, solve, stepDown, type SolveInput } from './solver';
import { presetProfile, type PresetName, type QualityTable, type ShotDef } from './table';

/** One shot as the host flew it. */
export interface ShotRun {
  /** Every measured frame (after the settle time), ballast excluded by the attribution's ignore rule. */
  frames: FrameSample[];
  /** Main-thread frame times over the same frames, ms. */
  cpuFrameMs: number[];
  /** Internal pixels rendered. */
  pixels: number;
  /** The GPU device was lost during the shot. */
  lost: boolean;
}

export interface CalibrationHost {
  /** The quality settings the renderer's features declare (`coreOf(ctx).quality.settings()`). */
  settings(): readonly RegisteredSetting[];
  /** The display (canvas) size in device pixels. */
  displayPx(): [number, number];
  /** Every shot's tiles and assets are resident (the calibration does not start otherwise). */
  resident(): boolean;
  /**
   * Fly a shot at a profile: apply it (`Renderer.setQuality`), start the shot's scenario, settle for
   * `settleS`, then record `measureS` seconds of frames. With `governor` false the quality scale is pinned at 1.
   */
  runShot(shot: ShotDef, profile: QualityProfile, opts: { governor: boolean; settleS: number; measureS: number }): Promise<ShotRun>;
  /** Wall time of the fixed headless simulation workload of the CPU score (cpuScore.ts), ms. */
  cpuProbe(): Promise<number>;
}

export interface CalibrationProgress {
  phase: 'shot' | 'confirm' | 'cpu' | 'done';
  /** 1-based shot number of the run's shots (the confirmation counts as the last). */
  index: number;
  of: number;
  label: string;
  elapsedS: number;
}

/** The progress line of the pre-flight check (frontend-ux 5.2): "shot 2 of 4 · lift-off · 14 s". */
export const progressLine = (p: CalibrationProgress): string =>
  p.phase === 'done' ? 'calibration complete' : `${p.phase === 'confirm' ? 'confirmation' : p.phase === 'cpu' ? 'processor' : `shot ${p.index} of ${p.of}`} · ${p.label} · ${Math.round(p.elapsedS)} s`;

export interface CalibrationResult {
  profile: QualityProfile;
  preset: PresetName | 'custom';
  /** The solver's prediction for the profile: per shot and the worst, p95 GPU ms; the limit it was held under. */
  predicted: Record<string, number>;
  predictedWorstMs: number;
  limitMs: number;
  shots: ShotMeasurement[];
  confirm: { measuredP95: number; budgetMs: number; steps: number; held: boolean };
  /** Set when the minimum preset cannot hold the minimum frame time in the confirmation shot (a warning, never a block). */
  belowMinimum: { preset: PresetName; frameMs: number; limitMs: number } | null;
  cpuScore: number;
  /** Plain notes for the player and the log (a lost device, no timestamp queries, ...). */
  notes: string[];
  wallMs: number;
}

export class CalibrationNotReady extends Error {
  constructor() {
    super('calibration: the shots data is not resident yet');
    this.name = 'CalibrationNotReady';
  }
}

export interface CalibrationOptions {
  onProgress?: (p: CalibrationProgress) => void;
  /** Wall clock, ms. */
  now: () => number;
  targetFps?: number;
  cpuReference: CpuReference;
}

export async function runCalibration(host: CalibrationHost, table: QualityTable, opts: CalibrationOptions): Promise<CalibrationResult> {
  if (!host.resident()) throw new CalibrationNotReady();
  const t0 = opts.now();
  const elapsed = (): number => (opts.now() - t0) / 1000;
  const settings = host.settings();
  const ids = settings.map((s) => s.setting.id);
  const displayPx = host.displayPx();
  const targetFps = opts.targetFps ?? table.targetFps;
  const budgetMs = governorBudgetMs(targetFps);
  const notes: string[] = [];
  const of = table.shots.length + 1;
  const report = (phase: CalibrationProgress['phase'], index: number, label: string): void => opts.onProgress?.({ phase, index, of, label, elapsedS: elapsed() });

  // The shots at Ultra: every setting at its top level, the internal resolution at most the reference's.
  const ultra = { ...presetProfile(table, 'ultra', ids), targetFps };
  const safe = (why: string): CalibrationResult => {
    notes.push(why);
    const profile = { ...presetProfile(table, table.safePreset, ids), targetFps };
    return { profile, preset: table.safePreset, predicted: {}, predictedWorstMs: Number.NaN, limitMs: table.solver.budgetShare * budgetMs, shots, confirm: { measuredP95: Number.NaN, budgetMs, steps: 0, held: false }, belowMinimum: null, cpuScore: Number.NaN, notes, wallMs: opts.now() - t0 };
  };
  const shots: ShotMeasurement[] = [];
  for (const [i, shot] of table.shots.entries()) {
    report('shot', i + 1, shot.label);
    const run = await host.runShot(shot, ultra, { governor: false, settleS: shot.settleS, measureS: shot.measureS });
    if (run.lost) return safe(`The graphics device was lost in shot ${i + 1} (${shot.label}): the ${table.safePreset} preset is used.`);
    shots.push(measureShot(shot.id, run.frames, run.cpuFrameMs, run.pixels, ultra.levels, settings, table.attribution));
  }
  const input: SolveInput = { table, settings, shots, displayPx, targetFps };
  const confirmDef = table.shots.find((s) => s.id === table.confirm.shot)!;
  const confirmShot = shots.find((s) => s.shotId === confirmDef.id)!;
  let profile: QualityProfile;
  let predicted: Record<string, number>;
  let predictedWorstMs: number;
  const limitMs = table.solver.budgetShare * budgetMs;
  const confirmRun = async (p: QualityProfile): Promise<number> => {
    report('confirm', of, confirmDef.label);
    const run = await host.runShot(confirmDef, p, { governor: true, settleS: confirmDef.settleS, measureS: table.confirm.measureS });
    if (run.lost) throw new Error('lost');
    return measureShot(confirmDef.id, run.frames, run.cpuFrameMs, run.pixels, p.levels, settings, table.attribution).gpuP95;
  };
  let measuredP95 = Number.NaN;
  let steps = 0;
  try {
    if (!shots.every((s) => s.perPass)) {
      // No timestamp queries: presets only, each confirmed by measurement from the top down.
      notes.push('This browser gives no per-pass GPU timings: the presets were measured whole.');
      profile = { ...presetProfile(table, 'low', ids), targetFps };
      for (const name of ['ultra', 'high', 'medium', 'low'] as const) {
        const p = { ...presetProfile(table, name, ids), targetFps };
        measuredP95 = await confirmRun(p);
        profile = p;
        if (measuredP95 <= budgetMs) break;
        steps++;
      }
      predicted = {};
      predictedWorstMs = Number.NaN;
    } else {
      const solved = solve(input);
      if (solved.overBudget) notes.push('Even the lowest settings are predicted over the frame budget.');
      profile = solved.profile;
      measuredP95 = await confirmRun(profile);
      while (measuredP95 > budgetMs && steps < table.solver.confirmStepsMax) {
        const lower = stepDown(input, profile, confirmShot);
        if (!lower) break;
        profile = lower;
        steps++;
        measuredP95 = await confirmRun(profile);
      }
      const w = { predicted: {} as Record<string, number>, worst: 0 };
      for (const m of shots) {
        const ms = predictShot(m, settings, profile, displayPx, table.attribution.fixedExponent);
        w.predicted[m.shotId] = ms;
        w.worst = Math.max(w.worst, ms);
      }
      predicted = w.predicted;
      predictedWorstMs = w.worst;
    }
  } catch (e) {
    if (e instanceof Error && e.message === 'lost') return safe(`The graphics device was lost in the confirmation run: the ${table.safePreset} preset is used.`);
    throw e;
  }

  // Below the minimum: the minimum preset over the minimum frame time in the confirmation shot.
  const min = table.solver.minimum;
  const minProfile = { ...presetProfile(table, min.preset, ids), targetFps };
  const atMinimum = presetOf(input, profile) === min.preset ? measuredP95 : confirmShot.perPass ? predictShot(confirmShot, settings, minProfile, displayPx, table.attribution.fixedExponent) : measuredP95;
  const belowMinimum = atMinimum > min.frameMs ? { preset: min.preset, frameMs: atMinimum, limitMs: min.frameMs } : null;
  if (belowMinimum) notes.push(`At the ${min.preset} preset the lift-off takes ${atMinimum.toFixed(1)} ms of GPU time per frame; the minimum is ${min.frameMs} ms.`);

  report('cpu', of, 'processor');
  const simMs = await host.cpuProbe();
  const cpuScore = cpuScoreOf({ frameP95Ms: confirmShot.cpuP95, simMs }, opts.cpuReference);
  report('done', of, 'done');
  const pixels = profilePixels(profile, displayPx);
  if (pixels < profilePixels(ultra, displayPx)) notes.push(`Internal resolution ${(pixels / 1e6).toFixed(2)} MP.`);
  return {
    profile,
    preset: presetOf(input, profile) ?? 'custom',
    predicted,
    predictedWorstMs,
    limitMs,
    shots,
    confirm: { measuredP95, budgetMs, steps, held: measuredP95 <= budgetMs },
    belowMinimum,
    cpuScore,
    notes,
    wallMs: opts.now() - t0,
  };
}
