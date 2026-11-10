/**
 * Audio acceptance, rendered OFFLINE inside the lab page: the real SoundModel + graph in an
 * OfflineAudioContext (every bus and path on its own channel), with the decoded production assets.
 * Measurements are collected into out/audio/acceptance.json for the hand-off.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import type { AudioLabApi } from '../../../labs/audio/labApi';
import { assertDiscreteGpu, expect, expectNoErrors, openPage, test } from '../harness';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const outDir = path.join(repoRoot, 'out', 'audio');
const SEA = 101325;
const db = (a: number): number => (a > 0 ? 20 * Math.log10(a) : -Infinity);

/** Merge one criterion's measurements into out/audio/acceptance.json (single-test runs keep the others). */
function record(key: string, value: unknown): void {
  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, 'acceptance.json');
  const results = (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {}) as Record<string, unknown>;
  results[key] = value;
  fs.writeFileSync(path.join(outDir, 'acceptance.json'), JSON.stringify(results, (_, v: unknown) => (v === -Infinity ? '-Infinity' : v), 2));
}

async function lab(page: Page): Promise<void> {
  await openPage(page, '/labs/audio/?scene=pad');
  await assertDiscreteGpu(page);
  await page.waitForFunction(() => window.__audioLab !== undefined);
}

type Lab = AudioLabApi;
const call = <T>(page: Page, fn: (lab: Lab, arg: never) => Promise<T>, arg?: unknown): Promise<T> =>
  page.evaluate(([src, a]) => (new Function('lab', 'arg', `return (${src})(lab, arg);`) as (l: Lab, x: unknown) => Promise<T>)(window.__audioLab!, a), [fn.toString(), arg] as const);

// The first navigation pays Vite's cold transform of the lab; on a machine busy with bakes that alone can take minutes.
test.describe.configure({ mode: 'serial', timeout: 360_000 });

test('engine level rises monotonically with throttle (>= 12 dB from 10 % to 100 %)', async ({ page, pageLog }) => {
  await lab(page);
  const throttles = [0.1, 0.25, 0.5, 0.75, 1];
  const levels: number[] = [];
  for (const throttle of throttles) {
    const r = await call(page, (l, a: { throttle: number; sea: number }) =>
      l.steady({ stack: 'booster', throttle: a.throttle, nozzlePressure: a.sea, listener: { kind: 'external', mode: 'chase', position: { x: 60, y: 5, z: 80 }, lookAt: { x: 0, y: 20, z: 0 }, pressure: a.sea } }, [[0.5, 3]], ['engines']),
      { throttle, sea: SEA },
    );
    levels.push(r.taps['engines']!.windows[0]!.rmsDb);
  }
  record('throttle', { throttles, enginesRmsDb: levels, rise10to100Db: levels[4]! - levels[0]! });
  for (let i = 1; i < levels.length; i++) expect(levels[i]!).toBeGreaterThan(levels[i - 1]!);
  expect(levels[4]! - levels[0]!).toBeGreaterThanOrEqual(12);
  await expectNoErrors(page, pageLog);
});

test('engine class: booster cluster >= 10 dB above the lander engine at equal distance', async ({ page, pageLog }) => {
  await lab(page);
  const at = async (stack: string): Promise<number> => {
    const r = await call(page, (l, a: { stack: 'booster' | 'lander'; sea: number }) =>
      l.steady({ stack: a.stack, throttle: 1, nozzlePressure: a.sea, listener: { kind: 'external', mode: 'chase', position: { x: 70, y: 5, z: 70 }, lookAt: { x: 0, y: 5, z: 0 }, pressure: a.sea } }, [[0.5, 3]], ['engines']),
      { stack, sea: SEA },
    );
    return r.taps['engines']!.windows[0]!.rmsDb;
  };
  const booster = await at('booster');
  const lander = await at('lander');
  record('engineClass', { boosterRmsDb: booster, landerRmsDb: lander, differenceDb: booster - lander });
  expect(booster - lander).toBeGreaterThanOrEqual(10);
  await expectNoErrors(page, pageLog);
});

test('vacuum: no airborne energy outside; cabin keeps a muffled structure-borne engine sound', async ({ page, pageLog }) => {
  await lab(page);
  const taps = ['engines', 'engines.air', 'engines.body'] as const;
  const run = (kind: 'interior' | 'external', pressure: number) =>
    call(page, (l, a: { kind: 'interior' | 'external'; pressure: number; taps: typeof taps }) =>
      l.steady(
        {
          stack: 'tli',
          throttle: 1,
          nozzlePressure: a.pressure,
          listener: a.kind === 'interior' ? { kind: 'interior', mode: 'cockpit', position: { x: 0, y: 22.4, z: 0.4 }, pressure: a.pressure } : { kind: 'external', mode: 'chase', position: { x: 25, y: 10, z: 30 }, lookAt: { x: 0, y: 10, z: 0 }, pressure: a.pressure },
        },
        [[0.5, 3]],
        [...a.taps],
      ),
      { kind, pressure, taps },
    );
  const extVac = await run('external', 0);
  const cabinVac = await run('interior', 0);
  const cabinSea = await run('interior', SEA);
  const v = cabinVac.taps['engines']!.windows[0]!;
  const s = cabinSea.taps['engines']!.windows[0]!;
  record('vacuum', {
    externalAirborneMaxAbs: extVac.taps['engines.air']!.maxAbs,
    externalBodyRmsDb: extVac.taps['engines.body']!.windows[0]!.rmsDb,
    cabinVacuumRmsDb: v.rmsDb,
    cabinVacuumHighDb: v.highDb,
    cabinSeaLevelRmsDb: s.rmsDb,
    cabinSeaLevelHighDb: s.highDb,
    highBandDropDb: s.highDb - v.highDb,
  });
  expect(extVac.taps['engines.air']!.maxAbs).toBe(0);
  expect(v.rms).toBeGreaterThan(1e-3);
  expect(cabinVac.taps['engines.body']!.windows[0]!.rms).toBeGreaterThan(1e-3);
  expect(s.highDb - v.highDb).toBeGreaterThanOrEqual(25);
  await expectNoErrors(page, pageLog);
});

test('distance: 50 m -> 2 km drops >= 25 dB and delays the ignition onset by distance / 340 s', async ({ page, pageLog }) => {
  await lab(page);
  const near = await call(page, (l) => l.ignition('booster', 50, ['engines', 'engines.air'], [[2.5, 4]]));
  const far = await call(page, (l) => l.ignition('booster', 2000, ['engines', 'engines.air'], [[8, 9]]));
  const nearDb = near.taps['engines']!.windows[0]!.rmsDb;
  const farDb = far.taps['engines']!.windows[0]!.rmsDb;
  const dOnset = far.onsets['engines.air']! - near.onsets['engines.air']!;
  const expected = (2000 - 50) / 340;
  record('distance', { nearRmsDb: nearDb, farRmsDb: farDb, dropDb: nearDb - farDb, nearOnset: near.onsets['engines.air'], farOnset: far.onsets['engines.air'], onsetDifference: dOnset, expected, errorMs: (dOnset - expected) * 1000 });
  expect(nearDb - farDb).toBeGreaterThanOrEqual(25);
  expect(Math.abs(dOnset - expected)).toBeLessThanOrEqual(0.05);
  await expectNoErrors(page, pageLog);
});

test('reentry bus tracks plasmaIntensity', async ({ page, pageLog }) => {
  await lab(page);
  const plasma = [0, 0.1, 0.3, 0.6, 1];
  const cabin: number[] = [];
  const chase: number[] = [];
  for (const p of plasma) {
    cabin.push((await call(page, (l, a: number) => l.plasma(a, 'interior'), p)).taps['reentry']!.windows[0]!.rms);
    chase.push((await call(page, (l, a: number) => l.plasma(a, 'external'), p)).taps['reentry']!.windows[0]!.rms);
  }
  record('reentry', { plasma, cabinRmsDb: cabin.map(db), chaseRmsDb: chase.map(db) });
  expect(cabin[0]).toBe(0);
  expect(chase[0]).toBe(0);
  for (let i = 1; i < plasma.length; i++) {
    expect(cabin[i]!).toBeGreaterThan(cabin[i - 1]!);
    expect(chase[i]!).toBeGreaterThan(chase[i - 1]!);
  }
  // Tracks: level follows 20 log10(plasma) within a few dB over a decade (0.1 -> 1).
  expect(db(cabin[4]!) - db(cabin[1]!)).toBeGreaterThan(14);
  await expectNoErrors(page, pageLog);
});

test('every event type produces a one-shot on the events bus within 50 ms', async ({ page, pageLog }) => {
  await lab(page);
  const r = await call(page, (l) => l.events());
  const required = ['stageFired', 'decoupled', 'fairingJettisoned', 'lesFired', 'legsToggled', 'chuteDeployed', 'chuteInflated', 'chuteFailed', 'touchdown', 'splash', 'partDestroyed', 'explosion', 'rcsPulse'];
  const types = r.schedule.map((s) => s.type);
  for (const t of required) expect(types, `event type ${t} has a sound`).toContain(t);
  const late = r.onsets.map((o) => ({ ...o, latencyMs: o.onset === null ? null : (o.onset - o.t) * 1000 }));
  record('events', late);
  for (const o of late) {
    expect(o.onset, `${o.type} produced sound`).not.toBeNull();
    expect(o.silentBefore, `${o.type}: events bus silent before the event`).toBe(true);
    expect(o.latencyMs!, `${o.type} latency`).toBeGreaterThanOrEqual(0);
    expect(o.latencyMs!, `${o.type} latency`).toBeLessThanOrEqual(50);
    expect(r.oneShots.some((s) => s.cause === o.type && s.bus === 'events'), `${o.type} one-shot on the events bus`).toBe(true);
  }
  await expectNoErrors(page, pageLog);
});

test('nothing clips: master peak < 0.98 with everything at maximum', async ({ page, pageLog }) => {
  await lab(page);
  const ext = await call(page, (l) => l.maximum('external'));
  const cab = await call(page, (l) => l.maximum('interior'));
  const peaks = { external: ext.taps['master']!.maxAbs, interior: cab.taps['master']!.maxAbs };
  record('clipping', { masterPeak: peaks, busPeaks: { external: Object.fromEntries(Object.entries(ext.taps).map(([k, v]) => [k, v.maxAbs])), interior: Object.fromEntries(Object.entries(cab.taps).map(([k, v]) => [k, v.maxAbs])) } });
  expect(peaks.external).toBeLessThan(0.98);
  expect(peaks.interior).toBeLessThan(0.98);
  expect(peaks.external).toBeGreaterThan(0.3);
  await expectNoErrors(page, pageLog);
});

test('time warp above 4x fades the engines to silence within 1 s', async ({ page, pageLog }) => {
  await lab(page);
  const r = await call(page, (l, sea: number) =>
    l.steady(
      { stack: 'booster', throttle: 1, nozzlePressure: sea, duration: 4, warpFactor: (t: number) => (t >= 1.5 ? 10 : 1), listener: { kind: 'external', mode: 'chase', position: { x: 60, y: 5, z: 80 }, lookAt: { x: 0, y: 20, z: 0 }, pressure: sea } },
      [
        [0.5, 1.5],
        [2.5, 4],
      ],
      ['engines'],
    ),
    SEA,
  );
  const [before, after] = r.taps['engines']!.windows;
  record('warp', { beforeRmsDb: before!.rmsDb, afterRms: after!.rms, warpAt: 1.5, silentFrom: 2.5 });
  expect(before!.rms).toBeGreaterThan(0.01);
  expect(after!.rms).toBe(0);
  await expectNoErrors(page, pageLog);
});

test('an unknown view mode of kind external sounds exactly like the chase camera', async ({ page, pageLog }) => {
  await lab(page);
  const r = await call(page, (l) => l.modes('eva-third-person'));
  record('unknownMode', { ...r, tapDiffDbReEngines: db(r.tapDiff / r.enginesRms), selfTapDiffDbReEngines: db(r.selfTapDiff / r.enginesRms), masterDiffDbReMaster: db(r.masterDiff / r.masterRms), selfMasterDiffDbReMaster: db(r.selfMasterDiff / r.masterRms) });
  // The model decides everything that is heard: its targets must be identical for every frame.
  expect(r.modelIdentical).toBe(true);
  expect(r.frames).toBeGreaterThan(300);
  expect(r.enginesRms).toBeGreaterThan(0.01);
  // Chrome's offline renderer is not bit-reproducible for a graph this size (re-rendering the SAME scene
  // differs by float rounding); the unknown mode must sit inside that noise floor, far below audibility.
  expect(db(r.tapDiff / r.enginesRms)).toBeLessThan(-80);
  expect(r.masterDiff).toBeLessThanOrEqual(Math.max(4 * r.selfMasterDiff, 1e-4 * r.masterRms));
  await expectNoErrors(page, pageLog);
});
