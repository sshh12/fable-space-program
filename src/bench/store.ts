/**
 * The graphics settings on this device (frontend-ux 9.6; user decision: settings stay on the device):
 * `localStorage['fsp.graphics.v1']` holds one record per adapter fingerprint (a laptop that switches GPUs
 * keeps both), each with the calibration it came from, the profile, the player's manual levels and the
 * governor's record of the last sessions. Every access is wrapped: a private window that refuses storage
 * gives "nothing stored" and the game runs on the seed preset.
 *
 * The calibration runs again (`rerunReason`) when nothing is stored for this fingerprint, when the stored
 * record is of another benchmark version, or (a prompt, not a forced run) when the governor sat at its
 * resolution floor for more than 30 % of the flight time in each of the last three sessions.
 */
import type { QualityLevelName, QualityProfile } from '@/core/contracts/render';
import type { ShotMeasurement } from './costModel';
import type { PresetName } from './table';

export const GRAPHICS_STORE_KEY = 'fsp.graphics.v1';
/** Fingerprints kept, the most recently used first. */
export const GRAPHICS_STORE_MAX = 4;
/** The floor prompt: sessions in a row, and the share of flight time at the resolution floor in each. */
export const FLOOR_SESSIONS = 3;
export const FLOOR_SHARE = 0.3;

export interface StoredGraphics {
  fingerprint: string;
  benchVersion: number;
  /** Wall time of the calibration (ms since the epoch); null when the profile is a seed preset. */
  measuredAt: number | null;
  shots: ShotMeasurement[];
  cpuScore: number | null;
  profile: QualityProfile;
  preset: PresetName | 'custom';
  /** The calibration's predicted worst-shot GPU ms for `profile`; null without a calibration. */
  predictedGpuMs: number | null;
  /** Levels the player chose by hand. */
  overrides: Record<string, QualityLevelName>;
  /** Share of each recent session's flight time the governor spent at the resolution floor (newest last). */
  floorShares: number[];
  /** The player skipped the calibration (the title says "Calibration skipped · Run it in Settings"). */
  skipped: boolean;
}

export type KeyValueStore = Pick<Storage, 'getItem' | 'setItem'>;

type Document = { records: StoredGraphics[] };

function readAll(storage: KeyValueStore | null): Document {
  if (!storage) return { records: [] };
  try {
    const raw = storage.getItem(GRAPHICS_STORE_KEY);
    if (!raw) return { records: [] };
    const doc = JSON.parse(raw) as Partial<Document>;
    return { records: Array.isArray(doc.records) ? doc.records.filter((r) => r && typeof r.fingerprint === 'string' && r.profile && typeof r.profile.pixelCap === 'number') : [] };
  } catch {
    return { records: [] };
  }
}

export type RerunReason = 'none' | 'firstRun' | 'benchVersion';

export function readGraphics(storage: KeyValueStore | null, fingerprint: string, benchVersion: number): { stored: StoredGraphics | null; rerun: RerunReason } {
  const rec = readAll(storage).records.find((r) => r.fingerprint === fingerprint) ?? null;
  if (!rec) return { stored: null, rerun: 'firstRun' };
  if (rec.benchVersion !== benchVersion) return { stored: rec, rerun: 'benchVersion' };
  return { stored: rec, rerun: rec.measuredAt === null && !rec.skipped ? 'firstRun' : 'none' };
}

/** Store a record (this fingerprint's replaced, moved to the front). False when the storage refused. */
export function writeGraphics(storage: KeyValueStore | null, rec: StoredGraphics): boolean {
  if (!storage) return false;
  const doc = readAll(storage);
  const records = [rec, ...doc.records.filter((r) => r.fingerprint !== rec.fingerprint)].slice(0, GRAPHICS_STORE_MAX);
  try {
    storage.setItem(GRAPHICS_STORE_KEY, JSON.stringify({ records }));
    return true;
  } catch {
    return false;
  }
}

/** The record after a session whose governor sat at the resolution floor for `share` of the flight time. */
export function withFloorShare(rec: StoredGraphics, share: number): StoredGraphics {
  return { ...rec, floorShares: [...rec.floorShares, Math.max(0, Math.min(1, share))].slice(-FLOOR_SESSIONS) };
}

/** "Your settings may be too high · Recalibrate?": the last FLOOR_SESSIONS sessions were all at the floor for more than FLOOR_SHARE of the flight. */
export function wantsFloorPrompt(rec: StoredGraphics): boolean {
  return rec.floorShares.length >= FLOOR_SESSIONS && rec.floorShares.slice(-FLOOR_SESSIONS).every((s) => s > FLOOR_SHARE);
}
