/**
 * The graphics side of the first minute (ARCHITECTURE 23, 24, 29.2), for the app shell: which profile the
 * renderer starts on, whether a calibration is due, and what is stored after one.
 *
 *  - `?safe=1`: the safe preset, no calibration offered (the recovery after a crash).
 *  - A stored record for this adapter fingerprint and benchmark version: its profile (the player's manual
 *    levels included); the floor prompt when the governor sat at its resolution floor in the last sessions.
 *  - Otherwise: the seed preset of the adapter class hint; the calibration is due at the first Play (or
 *    from Settings) and starts only when `residentFor(needs, ...)` is true.
 */
import type { QualityProfile } from '@/core/contracts/render';
import type { CalibrationResult } from './calibration';
import { readGraphics, wantsFloorPrompt, writeGraphics, type KeyValueStore, type RerunReason, type StoredGraphics } from './store';
import { presetProfile, seedPreset, type AdapterClass, type PresetName, type QualityTable } from './table';

export interface GraphicsBootInput {
  table: QualityTable;
  /** From the gate's report (`window.__fspGate.report`). */
  fingerprint: string;
  adapterClass: AdapterClass;
  safe: boolean;
  storage: KeyValueStore | null;
  /** The settings the renderer's features declare. */
  settingIds: readonly string[];
}

export interface GraphicsBoot {
  profile: QualityProfile;
  preset: PresetName | 'custom';
  stored: StoredGraphics | null;
  /** Why a calibration is due ('none' = not due; 'safe' = suppressed by ?safe=1). */
  calibrationDue: RerunReason | 'safe';
  /** "Your settings may be too high · Recalibrate?" */
  floorPrompt: boolean;
}

export function startGraphics(input: GraphicsBootInput): GraphicsBoot {
  const { table } = input;
  if (input.safe) return { profile: presetProfile(table, table.safePreset, input.settingIds), preset: table.safePreset, stored: null, calibrationDue: 'safe', floorPrompt: false };
  const { stored, rerun } = readGraphics(input.storage, input.fingerprint, table.benchVersion);
  if (stored && rerun === 'none') return { profile: stored.profile, preset: stored.preset, stored, calibrationDue: 'none', floorPrompt: wantsFloorPrompt(stored) };
  const seed = seedPreset(table, input.adapterClass, false);
  return { profile: presetProfile(table, seed, input.settingIds), preset: seed, stored, calibrationDue: rerun, floorPrompt: false };
}

/** Store a calibration's outcome for this fingerprint (manual levels start afresh). */
export function storeCalibration(input: GraphicsBootInput, result: CalibrationResult, wallMs: number): StoredGraphics {
  const rec: StoredGraphics = {
    fingerprint: input.fingerprint,
    benchVersion: input.table.benchVersion,
    measuredAt: wallMs,
    shots: result.shots,
    cpuScore: result.cpuScore,
    profile: result.profile,
    preset: result.preset,
    predictedGpuMs: Number.isFinite(result.predictedWorstMs) ? result.predictedWorstMs : null,
    overrides: {},
    floorShares: [],
    skipped: false,
  };
  writeGraphics(input.storage, rec);
  return rec;
}

/** The player skipped the calibration: the seed preset stays, and is not offered again until Settings asks. */
export function storeSkip(input: GraphicsBootInput, profile: QualityProfile, preset: PresetName | 'custom'): StoredGraphics {
  const rec: StoredGraphics = { fingerprint: input.fingerprint, benchVersion: input.table.benchVersion, measuredAt: null, shots: [], cpuScore: null, profile, preset, predictedGpuMs: null, overrides: {}, floorShares: [], skipped: true };
  writeGraphics(input.storage, rec);
  return rec;
}

/** A change on the settings screen: the new profile and which levels the player set by hand. */
export function storeManual(input: GraphicsBootInput, base: StoredGraphics, profile: QualityProfile, preset: PresetName | 'custom', predictedGpuMs: number | null): StoredGraphics {
  const overrides = { ...base.overrides };
  for (const [id, level] of Object.entries(profile.levels)) if (base.profile.levels[id] !== level) overrides[id] = level;
  const rec: StoredGraphics = { ...base, profile, preset, predictedGpuMs, overrides };
  writeGraphics(input.storage, rec);
  return rec;
}
