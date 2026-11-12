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

test.describe.configure({ mode: 'serial' });

test('engine level rises monotonically with the throttle lever (>= 12 dB from 10 % to 100 %), real engines, sim law', async ({ page, pageLog }) => {
  await lab(page);
  // "Throttle" is the player's lever. Each engine's throttleActual follows the sim's law from its part's
  // minThrottle (Atlas-9M 0.5: lever 0.1 -> 55 % thrust; Lyra-D 0.1: lever 0.1 -> 19 % thrust).
  const levers = [0.1, 0.25, 0.5, 0.75, 1];
  const cases = [
    { stack: 'booster', listener: { kind: 'external', mode: 'chase', position: { x: 60, y: 5, z: 80 }, lookAt: { x: 0, y: 20, z: 0 }, pressure: SEA }, nozzle: SEA },
    { stack: 'lander', listener: { kind: 'external', mode: 'chase', position: { x: 40, y: 5, z: 50 }, lookAt: { x: 0, y: 5, z: 0 }, pressure: SEA }, nozzle: SEA },
  ] as const;
  const out: Record<string, { levers: number[]; enginesRmsDb: number[]; rise10to100Db: number }> = {};
  for (const c of cases) {
    const levels: number[] = [];
    for (const throttle of levers) {
      const r = await call(page, (l, a: { c: (typeof cases)[number]; throttle: number }) => l.steady({ stack: a.c.stack, throttle: a.throttle, nozzlePressure: a.c.nozzle, listener: a.c.listener }, [[0.5, 3]], ['engines']), { c, throttle });
      levels.push(r.taps['engines']!.windows[0]!.rmsDb);
    }
    out[c.stack] = { levers, enginesRmsDb: levels, rise10to100Db: levels[4]! - levels[0]! };
  }
  record('throttle', out);
  for (const c of cases) {
    const levels = out[c.stack]!.enginesRmsDb;
    for (let i = 1; i < levels.length; i++) expect(levels[i]!, `${c.stack} lever ${levers[i]}`).toBeGreaterThan(levels[i - 1]!);
    expect(out[c.stack]!.rise10to100Db, c.stack).toBeGreaterThanOrEqual(12);
  }
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
          // The Kestrel commander's seat on top of the TLI stage (labs/audio/labVehicle.ts labStack('tli')).
          listener: a.kind === 'interior' ? { kind: 'interior', mode: 'cockpit', position: { x: 0, y: 22.05, z: 0.1 }, pressure: a.pressure } : { kind: 'external', mode: 'chase', position: { x: 25, y: 10, z: 30 }, lookAt: { x: 0, y: 10, z: 0 }, pressure: a.pressure },
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
  // With air on the capsule (9 kPa at Mach 25: half of the load's reference) the roar and the rumble do not
  // wait for the glow: without plasma the bus is 4 to 12 dB under its level at full plasma, not silent.
  const loaded: number[] = [];
  for (const p of [0, 1]) loaded.push((await call(page, (l, a: number) => l.plasma(a, 'interior', 9000), p)).taps['reentry']!.windows[0]!.rms);
  record('reentryUnderLoad', { q: 9000, mach: 25, plasma: [0, 1], cabinRmsDb: loaded.map(db) });
  expect(loaded[0]!).toBeGreaterThan(0);
  expect(db(loaded[1]!) - db(loaded[0]!)).toBeGreaterThan(4);
  expect(db(loaded[1]!) - db(loaded[0]!)).toBeLessThan(12);
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

test('nothing clips: buses below full scale, the limiter holds the master below the soft ceiling', async ({ page, pageLog }) => {
  await lab(page);
  // The soft ceiling (a waveshaper) can never output more than mix.master.ceiling, so its output alone
  // proves nothing. What is measured is the signal it is fed (after compressor and limiter): it must stay
  // in the ceiling's exactly-linear range, i.e. no sample is shaped. Every bus is captured in stereo and
  // must stay below full scale (true sample peak) - in the loudest realistic scenes and with everything
  // at maximum at once.
  const linearUntil = 0.8;
  const ext = await call(page, (l) => l.maximum('external'));
  const cab = await call(page, (l) => l.maximum('interior'));
  const loud = await call(page, (l) => l.loud());
  const all = [ext, cab, ...loud];
  const rows = all.map((r) => ({ name: r.name, busPeaks: r.busPeaks, preCeilingPeak: r.preCeiling.peak, kneeShare: r.preCeiling.kneeShare, masterPeak: r.taps['master']!.maxAbs, masterRmsDb: r.taps['master']!.windows[0]!.rmsDb, maxStats: r.maxStats }));
  record('clipping', { linearUntil, scenes: rows });
  for (const r of rows) {
    for (const [bus, peak] of Object.entries(r.busPeaks)) expect(peak, `${r.name}: ${bus} bus true peak`).toBeLessThan(1);
    expect(r.preCeilingPeak, `${r.name}: master fed to the soft ceiling`).toBeLessThan(linearUntil);
    expect(r.kneeShare, `${r.name}: samples shaped by the soft ceiling`).toBe(0);
    expect(r.masterPeak, `${r.name}: master`).toBeLessThan(0.98);
  }
  // Loud enough to have proven something: the maximum scene drives the limiter.
  expect(rows[0]!.masterPeak).toBeGreaterThan(0.4);
  await expectNoErrors(page, pageLog);
});

test("the master section's small-signal gain is exactly the configured makeup (built-in makeups cancelled)", async ({ page, pageLog }) => {
  await lab(page);
  const g = await call(page, (l) => l.masterGain());
  record('masterGain', g);
  expect(Math.abs(g.measuredDb - g.expectedDb)).toBeLessThan(0.05);
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
  record('unknownMode', { ...r, tapDiffDbReTap: db(r.tapDiff), selfTapDiffDbReTap: db(r.selfTapDiff), masterDiffDbReMaster: db(r.masterDiff / r.masterRms), selfMasterDiffDbReMaster: db(r.selfMasterDiff / r.masterRms) });
  // The model decides everything that is heard: its targets must be identical for every frame.
  expect(r.modelIdentical).toBe(true);
  expect(r.frames).toBeGreaterThan(300);
  expect(r.enginesRms).toBeGreaterThan(0.003);
  // Chrome's offline renderer is not bit-reproducible for a graph this size: two renders of the SAME scene
  // either agree bit for bit or differ by float rounding, about -71 .. -75 dB re each tap's own RMS
  // (2e-4 .. 3e-4) and -80 .. -85 dB re the master's RMS, and which of the two happens is independent
  // from render to render. The unknown mode must sit inside that noise floor: no further from chase than
  // chase is from itself (x4), or than the floor itself, taken at twice the largest difference measured
  // (-66 dB per tap, -70 dB on the master), when this run's chase pair happened to be bit-exact. (The
  // floor used to be -100 dB / -80 dB in that case, which failed whenever the chase pair was exact and
  // the chase/unknown pair was not: 1 run in the lead's baseline, tapDiff 2.1e-4 against a bound of 1e-5.)
  // And far below audibility: every tap's largest sample difference at least 60 dB under that tap's RMS.
  expect(r.tapDiff).toBeLessThanOrEqual(Math.max(4 * r.selfTapDiff, 5e-4));
  expect(db(r.tapDiff)).toBeLessThan(-60);
  expect(r.masterDiff).toBeLessThanOrEqual(Math.max(4 * r.selfMasterDiff, 3e-4 * r.masterRms));
  await expectNoErrors(page, pageLog);
});

test("the mission's entry: the sound follows the aerodynamic load from the heat pulse to the drogues, for the chase camera and in the cabin", async ({ page, pageLog }) => {
  test.setTimeout(240_000);
  await lab(page);
  // labs/audio/entry.ts: the real Sim's capsule on the nominal lunar return (tools/audio/entryProfile.ts), six
  // seconds of real time every 30 s of the flight from the entry interface to the drogues.
  const starts: number[] = [];
  for (let t = 30; t <= 690; t += 30) starts.push(t);
  type Entry = Awaited<ReturnType<Lab['entry']>>;
  const run = (kind: 'interior' | 'external', rules: 'current' | 'plasmaOnly'): Promise<Entry> => call(page, (l, a: { kind: 'interior' | 'external'; starts: number[]; rules: 'current' | 'plasmaOnly' }) => l.entry(a.kind, a.starts, 6, a.rules), { kind, starts, rules });
  const out: Record<string, unknown> = {};
  for (const kind of ['external', 'interior'] as const) {
    const now = await run(kind, 'current');
    const was = await run(kind, 'plasmaOnly');
    expect(now.problems).toEqual([]);
    const rows = now.rows.map((r, i) => ({
      t: r.from,
      altitudeKm: r.state.altitude / 1000,
      mach: r.state.mach,
      q: r.state.q,
      plasma: r.state.plasma,
      gLoad: r.state.gLoad,
      masterDb: r.levels['master']!,
      aeroDb: r.levels['aero']!,
      reentryDb: r.levels['reentry']!,
      masterDbBefore: was.rows[i]!.levels['master']!,
    }));
    out[kind] = rows;
    console.log(`  ${kind}: t s, km, Mach, q Pa, plasma, g | master dBFS now (before the fix)`);
    for (const r of rows) console.log(`  ${String(r.t).padStart(4)} ${r.altitudeKm.toFixed(1).padStart(5)} ${r.mach.toFixed(1).padStart(5)} ${r.q.toFixed(0).padStart(6)} ${r.plasma.toFixed(2)} ${r.gLoad.toFixed(2)} | ${r.masterDb.toFixed(1).padStart(6)} (${Number.isFinite(r.masterDbBefore) ? r.masterDbBefore.toFixed(1) : '-inf'})`);
    const label = (r: (typeof rows)[number]): string => `${kind}, t ${r.t} s, ${r.altitudeKm.toFixed(1)} km, Mach ${r.mach.toFixed(1)}, q ${r.q.toFixed(0)} Pa`;
    // The heat pulse: full plasma at the largest dynamic pressure.
    const pulse = rows.filter((r) => r.plasma > 0.9).reduce((a, b) => (b.q > a.q ? b : a));
    expect(pulse.masterDb, 'the heat pulse is loud').toBeGreaterThan(-30);
    // Wherever the air loads the capsule (5 kPa and more: Mach 30 down to Mach 0.5) the game is within 14 dB of
    // the heat pulse; in hypersonic flight at 8 kPa and more (the second dip: 3.3 g with a tenth of the glow)
    // within 6.5 dB. The mission video had it 25 to 35 dB down there for the chase camera, then silent.
    const loaded = rows.filter((r) => r.q >= 5000);
    expect(loaded.length).toBeGreaterThanOrEqual(10);
    expect(Math.min(...loaded.map((r) => r.mach))).toBeLessThan(1);
    for (const r of loaded) {
      expect(pulse.masterDb - r.masterDb, label(r)).toBeLessThan(14);
      if (r.mach >= 8 && r.q >= 8000) expect(pulse.masterDb - r.masterDb, label(r)).toBeLessThan(6.5);
    }
    const dip = rows.filter((r) => r.t > 380 && r.mach >= 8 && r.q >= 8000 && r.plasma < 0.1);
    expect(dip.length).toBeGreaterThanOrEqual(2);
    // The loft between the two dips (q under 700 Pa) is quiet: the level is the load's, not a constant bed.
    const loft = rows.filter((r) => r.t > 200 && r.t < 340 && r.q < 700);
    expect(loft.length).toBeGreaterThanOrEqual(2);
    if (kind === 'external') {
      for (const r of loft) expect(pulse.masterDb - r.masterDb, label(r)).toBeGreaterThan(18);
      // What the fix changed: with the old rules the chase camera lost the second dip and heard nothing from
      // Mach 6 to Mach 1.
      for (const r of dip) expect(r.masterDb - r.masterDbBefore, `before the fix: ${label(r)}`).toBeGreaterThan(12);
      const fall = rows.filter((r) => r.t >= 510 && r.mach > 1.2);
      expect(fall.length).toBeGreaterThanOrEqual(3);
      for (const r of fall) expect(r.masterDb, label(r)).toBeGreaterThan(-40);
      // (Where the old rules were not silent in the fall, a thruster pulse of the pilot was in the window.)
      expect(fall.filter((r) => r.masterDbBefore < -80).length, 'windows of the supersonic fall that were silent before the fix').toBeGreaterThanOrEqual(2);
    }
  }
  record('missionEntry', out);
  await expectNoErrors(page, pageLog);
});
