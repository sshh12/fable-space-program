/**
 * The solver and the calibration controller (frontend-ux 14): on the shots recorded on the reference GPU (an
 * RTX 5090, 2560 x 1440: fixtures/shots-5090.json, written from out/capability-settings/calibration.json of
 * tests/browser/bench/calibration.perf.spec.ts) it gives Ultra; on the same timings x3 a valid profile under
 * the budget; the step-down loop terminates; the controller refuses while not resident, falls back to the
 * safe preset on a lost device, and measures whole presets without timestamp queries.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { QualityProfile } from '@/core/contracts/render';
import { CORE_QUALITY, QUALITY_LEVELS, type RegisteredSetting } from '@/render/core/quality';
import { ATMOSPHERE_QUALITY } from '@/render/atmosphere/quality';
import { TERRAIN_QUALITY } from '@/render/terrain/quality';
import { VFX_QUALITY } from '@/render/vfx/quality';
import { CalibrationNotReady, cpuScoreOf, GraphicsSettings, measureShot, parseQualityTable, predictShot, presetProfile, runCalibration, solve, stepDown, type CalibrationHost, type FrameSample, type ShotMeasurement } from '@/bench';

const repoRoot = path.resolve(import.meta.dirname, '..', '..', '..');
const table = parseQualityTable(JSON.parse(fs.readFileSync(path.join(repoRoot, 'data', 'defs', 'render', 'quality.json'), 'utf8')));
const settings: RegisteredSetting[] = [CORE_QUALITY, ATMOSPHERE_QUALITY, TERRAIN_QUALITY, VFX_QUALITY].flatMap((d) => d.settings.map((setting) => ({ featureId: d.featureId, setting })));
const raw = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'fixtures', 'shots-5090.json'), 'utf8')) as { displayPx: [number, number]; shots: ShotMeasurement[] };
/** The recorded shots, a group that is no setting of today's declarations folded into the fixed cost. */
const recorded = {
  displayPx: raw.displayPx,
  shots: raw.shots.map((s) => {
    const groups: Record<string, number> = {};
    for (const [g, v] of Object.entries(s.groups)) {
      const k = g === 'fixed' || settings.some((x) => x.setting.id === g) ? g : 'fixed';
      groups[k] = (groups[k] ?? 0) + v;
    }
    return { ...s, groups };
  }),
};
const ids = settings.map((s) => s.setting.id);
const display = recorded.displayPx;

const scaled = (k: number): ShotMeasurement[] =>
  recorded.shots.map((s) => ({ ...s, gpuP95: s.gpuP95 * k, gpuMean: s.gpuMean * k, groups: Object.fromEntries(Object.entries(s.groups).map(([g, v]) => [g, v * k])) }));

describe('the solver on the reference GPU', () => {
  it('gives Ultra at 2560 x 1440 on the recorded timings', () => {
    const r = solve({ table, settings, shots: recorded.shots, displayPx: display });
    expect(r.preset).toBe('ultra');
    expect(r.overBudget).toBe(false);
    expect(r.worstMs).toBeLessThanOrEqual(r.limitMs);
  });
  it('gives a valid profile under the budget on the same timings x3, and lower than Ultra', () => {
    const shots = scaled(3);
    const r = solve({ table, settings, shots, displayPx: display });
    expect(r.overBudget).toBe(false);
    expect(r.worstMs).toBeLessThanOrEqual(r.limitMs);
    expect(r.preset).not.toBe('ultra');
    expect(table.solver.pixelCaps).toContain(r.profile.pixelCap);
    for (const id of ids) expect(QUALITY_LEVELS).toContain(r.profile.levels[id]);
    for (const s of shots) expect(predictShot(s, settings, r.profile, display, table.attribution.fixedExponent)).toBeLessThanOrEqual(r.limitMs + 1e-9);
  });
  it('on timings x20 says it is over budget and offers the lowest profile', () => {
    const r = solve({ table, settings, shots: scaled(20), displayPx: display });
    expect(r.overBudget).toBe(true);
    expect(r.profile.pixelCap).toBe(table.solver.pixelCaps[0]);
  });
  it('the step-down loop terminates: each step lowers something, and at the bottom there is nothing left', () => {
    const confirm = recorded.shots.find((s) => s.shotId === table.confirm.shot)!;
    let p: QualityProfile | null = { ...presetProfile(table, 'ultra', ids) };
    let steps = 0;
    const seen = new Set<string>();
    while (p && steps < 100) {
      const key = JSON.stringify(p);
      expect(seen.has(key)).toBe(false);
      seen.add(key);
      p = stepDown({ table, settings, shots: recorded.shots, displayPx: display }, p, confirm);
      steps++;
    }
    expect(p).toBeNull();
    expect(steps).toBeLessThanOrEqual(ids.length * 3 + table.solver.pixelCaps.length);
  });
});

/** A pass name of each cost group (the table's attribution rules map it back). */
const PASS_OF: Record<string, string> = { shadows: 'vehicle.shadow', ambientOcclusion: 'core.ao', clouds: 'atmosphere.cloudMarch', atmosphere: 'atmosphere.march', terrain: 'terrain.gbuffer', effects: 'vfx.transparent', fixed: 'core.lighting' };

/** A host whose GPU costs `k` times the recorded shots, the confirmation measured by the same model. */
function fakeHost(k: number, opts: { resident?: boolean; lostAt?: number; perPass?: boolean; confirmBias?: number } = {}): CalibrationHost & { runs: string[] } {
  const runs: string[] = [];
  return {
    runs,
    settings: () => settings,
    displayPx: () => display,
    resident: () => opts.resident ?? true,
    async runShot(shot, profile, o) {
      runs.push(`${shot.id}${o.governor ? ' (confirm)' : ''}`);
      if (opts.lostAt !== undefined && runs.length === opts.lostAt) return { frames: [], cpuFrameMs: [], pixels: 0, lost: true };
      const m = scaled(k).find((s) => s.shotId === shot.id)!;
      const ms = predictShot(m, settings, profile, display, table.attribution.fixedExponent) * (o.governor ? (opts.confirmBias ?? 1) : 1);
      const frames: FrameSample[] = Array.from({ length: 60 }, () => (opts.perPass === false ? { total: ms, passes: {} } : { total: ms, passes: Object.fromEntries(Object.entries(m.groups).map(([g, v]) => [PASS_OF[g]!, (v * ms) / m.gpuMean])) }));
      return { frames, cpuFrameMs: frames.map(() => 4), pixels: m.pixels, lost: false };
    },
    cpuProbe: async () => 100,
  };
}

describe('the calibration controller', () => {
  const opts = { now: () => 0, cpuReference: { frameP95Ms: 4, simMs: 100, simSteps: 1200 } };
  it('refuses to start while the shots data is not resident', async () => {
    await expect(runCalibration(fakeHost(1, { resident: false }), table, opts)).rejects.toBeInstanceOf(CalibrationNotReady);
  });
  it('falls back to the safe preset with a note when the device is lost in a shot, and never loops', async () => {
    const host = fakeHost(1, { lostAt: 2 });
    const r = await runCalibration(host, table, opts);
    expect(r.preset).toBe(table.safePreset);
    expect(r.notes[0]).toMatch(/lost in shot 2/);
    expect(host.runs).toHaveLength(2);
  });
  it('steps down at most confirmStepsMax times when the confirmation stays over the budget', async () => {
    const host = fakeHost(3, { confirmBias: 10 });
    const r = await runCalibration(host, table, opts);
    expect(r.confirm.steps).toBe(table.solver.confirmStepsMax);
    expect(r.confirm.held).toBe(false);
    expect(host.runs.filter((x) => x.endsWith('(confirm)'))).toHaveLength(1 + table.solver.confirmStepsMax);
  });
  it('without per-pass timings measures whole presets from the top down', async () => {
    const r = await runCalibration(fakeHost(3, { perPass: false }), table, opts);
    expect(r.notes.join(' ')).toMatch(/no per-pass GPU timings/);
    expect(r.confirm.held).toBe(true);
    expect(['low', 'medium', 'high']).toContain(r.preset);
  });
  it('the CPU score is 100 on the reference and halves with a client half as fast in both', () => {
    expect(cpuScoreOf({ frameP95Ms: 4, simMs: 100 }, opts.cpuReference)).toBe(100);
    expect(cpuScoreOf({ frameP95Ms: 8, simMs: 200 }, opts.cpuReference)).toBe(50);
  });
});

describe('the graphics settings model', () => {
  it('rows from the declarations with predictions, a manual change makes Custom, a preset is a preset again', () => {
    const g = new GraphicsSettings(table, settings, display, presetProfile(table, 'ultra', ids), recorded.shots, 1);
    const m = g.model();
    expect(m.preset).toBe('ultra');
    expect(m.rows.map((r) => r.settingId)).toEqual(ids);
    expect(m.rows.every((r) => r.predictedMs !== null && r.levels.length === 4)).toBe(true);
    expect(m.estimate.gpuMs).toBeGreaterThan(0);
    expect(m.estimate.budgetMs).toBeCloseTo(11, 6);
    g.setLevel('clouds', 'low');
    expect(g.model().preset).toBe('custom');
    expect(g.model().estimate.gpuMs!).toBeLessThan(m.estimate.gpuMs!);
    g.setPreset('medium');
    expect(g.contract().preset).toBe('medium');
    expect(g.model().resolution.internalPx[0]).toBeLessThan(display[0]);
  });
  it('measureShot attributes passes by the table rules', () => {
    const frames: FrameSample[] = [{ total: 3, passes: { 'atmosphere.cloudMarch': 1, 'atmosphere.march': 0.5, 'core.ao': 0.25, 'terrain-rocks.gbuffer': 0.5, 'vehicle.shadow': 0.25, 'core.lighting': 0.5, 'lab-ballast.overlay': 7 } }];
    const m = measureShot('x', frames, [4], 100, {}, settings, table.attribution);
    expect(m.groups).toEqual({ clouds: 1, atmosphere: 0.5, ambientOcclusion: 0.25, terrain: 0.5, shadows: 0.25, fixed: 0.5 });
    expect(m.gpuP95).toBe(3);
  });
});
