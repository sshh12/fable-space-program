/**
 * The settings on this device and the first minute (frontend-ux 9.6; ARCHITECTURE 23, 24): per-fingerprint
 * records in localStorage, the re-run reasons, the floor prompt, a storage that refuses, and which profile
 * the renderer starts on.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { GRAPHICS_STORE_KEY, GRAPHICS_STORE_MAX, parseQualityTable, presetProfile, readGraphics, startGraphics, storeCalibration, storeManual, storeSkip, wantsFloorPrompt, withFloorShare, writeGraphics, type CalibrationResult, type KeyValueStore, type StoredGraphics } from '@/bench';

const repoRoot = path.resolve(import.meta.dirname, '..', '..', '..');
const table = parseQualityTable(JSON.parse(fs.readFileSync(path.join(repoRoot, 'data', 'defs', 'render', 'quality.json'), 'utf8')));
const ids = ['clouds', 'shadows'];

function memory(): KeyValueStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) };
}
const refusing: KeyValueStore = {
  getItem: () => {
    throw new Error('SecurityError');
  },
  setItem: () => {
    throw new Error('QuotaExceededError');
  },
};
const record = (fingerprint: string, o: Partial<StoredGraphics> = {}): StoredGraphics => ({ fingerprint, benchVersion: table.benchVersion, measuredAt: 1, shots: [], cpuScore: 100, profile: presetProfile(table, 'high', ids), preset: 'high', predictedGpuMs: 5, overrides: {}, floorShares: [], skipped: false, ...o });

describe('the store', () => {
  it('keeps one record per fingerprint, the newest first, at most GRAPHICS_STORE_MAX', () => {
    const s = memory();
    for (let i = 0; i < GRAPHICS_STORE_MAX + 2; i++) writeGraphics(s, record(`fp${i}`));
    const doc = JSON.parse(s.data.get(GRAPHICS_STORE_KEY)!) as { records: StoredGraphics[] };
    expect(doc.records.map((r) => r.fingerprint)).toEqual(['fp5', 'fp4', 'fp3', 'fp2']);
    expect(readGraphics(s, 'fp4', table.benchVersion).rerun).toBe('none');
    expect(readGraphics(s, 'fp0', table.benchVersion)).toEqual({ stored: null, rerun: 'firstRun' });
    expect(readGraphics(s, 'fp4', table.benchVersion + 1).rerun).toBe('benchVersion');
  });
  it('a storage that refuses gives nothing stored and does not throw', () => {
    expect(readGraphics(refusing, 'fp', 1)).toEqual({ stored: null, rerun: 'firstRun' });
    expect(writeGraphics(refusing, record('fp'))).toBe(false);
    expect(readGraphics(null, 'fp', 1).rerun).toBe('firstRun');
    const s = memory();
    s.setItem(GRAPHICS_STORE_KEY, '{not json');
    expect(readGraphics(s, 'fp', 1).stored).toBeNull();
  });
  it('prompts after three sessions in a row at the resolution floor for more than 30 % of the flight', () => {
    let r = record('fp');
    for (const share of [0.5, 0.4]) r = withFloorShare(r, share);
    expect(wantsFloorPrompt(r)).toBe(false);
    r = withFloorShare(r, 0.31);
    expect(wantsFloorPrompt(r)).toBe(true);
    r = withFloorShare(r, 0.1);
    expect(wantsFloorPrompt(r)).toBe(false);
  });
});

describe('the first minute', () => {
  const input = (storage: KeyValueStore | null, o: { safe?: boolean; cls?: 'discrete' | 'integrated' | 'unknown' } = {}) => ({ table, fingerprint: 'fp', adapterClass: o.cls ?? 'discrete', safe: o.safe ?? false, storage, settingIds: ids });
  it('starts on the seed preset of the class hint with the calibration due; ?safe=1 starts at Low with none', () => {
    const s = memory();
    const b = startGraphics(input(s));
    expect([b.preset, b.calibrationDue]).toEqual([table.classHint.discrete, 'firstRun']);
    expect(startGraphics(input(s, { cls: 'integrated' })).profile).toEqual(presetProfile(table, 'low', ids));
    const safe = startGraphics(input(s, { safe: true }));
    expect([safe.preset, safe.calibrationDue]).toEqual([table.safePreset, 'safe']);
  });
  it('after a calibration starts on its profile; a skip is remembered; a manual change keeps its overrides', () => {
    const s = memory();
    const result = { profile: presetProfile(table, 'ultra', ids), preset: 'ultra', shots: [], cpuScore: 98, predictedWorstMs: 6.2 } as unknown as CalibrationResult;
    const rec = storeCalibration(input(s), result, 1234);
    const b = startGraphics(input(s));
    expect([b.preset, b.calibrationDue, b.stored?.measuredAt]).toEqual(['ultra', 'none', 1234]);
    const manual = storeManual(input(s), rec, { ...rec.profile, levels: { ...rec.profile.levels, clouds: 'low' } }, 'custom', 5.5);
    expect(manual.overrides).toEqual({ clouds: 'low' });
    expect(startGraphics(input(s)).profile.levels['clouds']).toBe('low');
    const s2 = memory();
    storeSkip(input(s2), presetProfile(table, 'high', ids), 'high');
    expect(startGraphics(input(s2)).calibrationDue).toBe('none');
  });
});
