/**
 * The browser mission (docs/ARCHITECTURE.md 18.2): the real app in real Chrome on the discrete GPU, the scripted
 * test pilot inside the page (`/?scenario=lunar-direct&pilot=1`), flying lunar-direct from the pad to splashdown
 * in real time through `Sim.advance(realDt, onControlTick)`: the same controls a player uses (`sim.setControls`,
 * `sim.commands`), no state write, no debug call, no teleport. About 45 minutes (docs/handoff/sim-world-pilot.md).
 *
 *   node tools/dev/heavy.mjs --class=gpu -- npx playwright test --project=mission
 *
 * Judged on:
 *  - the milestone gates of the headless mission (tests/mission/full-mission.test.ts), read from
 *    window.__test.milestones() and window.__test.state(): every gate that is a fact of a milestone record or of the
 *    final snapshot (the headless harness's own observers - Kepler revolution, clearance, step cost, determinism,
 *    residency on every tick of the final descent - have no browser counterpart and stay with the headless suite);
 *  - cheatCounter 0, pad start, crew alive, no incomplete terrain query, window.__test.errors empty for the whole
 *    flight, no console error;
 *  - frame time per pilot phase against ARCHITECTURE 17 (GPU p99 <= 11 ms at 1440p internal, rAF p99 <= 17.5 ms and
 *    no delta >= 33 ms, main-thread frame p99 <= 6 ms) and 18.2 (rAF p95 < 16.7 ms), measured under the GPU lock at
 *    2560 x 1440, render scale 1, governor off. Each phase's number is the median over its windows (up to 240
 *    frames each, reset at every phase change and around every screenshot) of the window's percentile, as in
 *    tests/browser/app/app.perf.spec.ts. Asserted softly so the flight goes on: a miss is a finding, never a
 *    loosened line;
 *    The requestAnimationFrame lines are judged only when the harness clock (measured before and after the
 *    flight, tests/browser/harness.ts) is the nominal 60 Hz: with the monitor asleep Chrome paces frames at
 *    57.5 Hz and the lines cannot be judged (request app-integration-8); the spec then fails saying so;
 *  - a screenshot at every milestone in the chase view (and the cockpit at the parking orbit and on the lunar
 *    surface, ARCHITECTURE 17.1 / 18.3), each with an image-statistics assertion and the HDR target free of NaN.
 *    A picture in a view just switched to waits for the exposure to reach its target (request cockpit-15, read
 *    from the exposure, not a time); a chase picture is taken in the
 *    rig's default framing (nobody turns the camera in this spec), which keeps the Earth or the Moon in the
 *    frame (request app-integration-10): both are asserted.
 *
 * Output: out/screens/mission/*.png, out/mission/browser-mission.json (gates, windows, per-phase table, phase log).
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import type { AppBrief } from '../../../src/app/testHooks';
import type { FrameBreakdown } from '../../../src/app/timing';
import type { MilestoneRecord } from '../../../src/core/contracts/sim';
import { assertDiscreteGpu, assertRealImage, expect, expectNoErrors, expectNominalClock, measureHarnessClock, openPage, saveScreenshot, test, withGpuLock, type FrameClockStats } from '../harness';

const repoRoot = process.cwd();
const SCENARIO = 'lunar-direct';
const SHOTS = 'mission';
const WINDOW_FRAMES = 240;
const MIN_WINDOW_FRAMES = 60;
const FLIGHT_LIMIT_MS = 120 * 60_000;
const STALL_MS = 60_000;
const SURFACE_STAY_SECONDS = 600;
/** Milestones with a cockpit picture besides the chase one (17.1 "LEO cockpit", 18.3 "lunar surface from the cockpit"). */
const COCKPIT_AT = new Set(['EARTH_ORBIT', 'LUNAR_TOUCHDOWN']);
/** Milestones whose chase picture is mostly black space around the vehicle (relaxed image statistics). */
const SPACE = new Set(['EARTH_ORBIT', 'TLI_COMPLETE', 'MOON_SOI_ENTER', 'LUNAR_ORBIT', 'LUNAR_LIFTOFF', 'MOON_SOI_EXIT', 'EARTH_PERIGEE_TARGETED', 'ENTRY_INTERFACE']);

test.use({ viewport: { width: 2560, height: 1440 }, deviceScaleFactor: 1 });

interface Poll {
  b: AppBrief;
  phase: string | null;
  done: boolean;
  failure: string | null;
  errors: string[];
  inFlight: boolean;
  frames: number;
}

interface PerfWindow {
  phase: string;
  view: string;
  warp: number;
  frames: number;
  raf: { p50: number; p95: number; p99: number; max: number; over33ms: number };
  gpu: { p50: number; p95: number; p99: number };
  appCpu: { p50: number; p99: number; max: number };
  coreCpuP99: number;
  stages: Record<string, number>;
  features: Record<string, number>;
  /**
   * Main-thread time of each feature's hooks, p99 over the window, from the app's per-frame hook timers
   * (`core` = the render stage minus the hooks); added after the first full run.
   */
  featuresCpu: Record<string, number>;
  /** The two slowest frames of the window with their breakdown (stages, features, hooks, the app's note). */
  slowest: FrameBreakdown[];
  qualityScale: number;
  renderScale: number;
}

interface PhaseRow {
  phase: string;
  realMinutes: number;
  frames: number;
  windows: number;
  warp: string;
  rafP50: number;
  rafP95: number;
  rafP99: number;
  rafWorstP99: number;
  over33ms: number;
  gpuP50: number;
  gpuP99: number;
  gpuWorstP99: number;
  cpuP50: number;
  cpuP99: number;
  topStages: string;
  topFeatures: string;
  topFeaturesCpu: string;
}

interface Shot {
  milestone: string;
  view: string;
  file: string;
  phase: string | null;
  altitudeAsl: number;
  stats: { meanLuma: number; stdLuma: number; fractionNonBlack: number; distinctColorBuckets: number };
  hdr: { maxLuminance: number; meanLuminance: number; nanPixels: number };
  audio: Record<string, number> | null;
  /** EV100 and the meter's target when the picture was taken. */
  exposure: { ev100: number; targetEv100: number };
  /** The chase rig's framing and the bodies in the frame (chase pictures). */
  framing: { auto: boolean; pitch: number; zoom: number; roll: number; distance: number };
  bodies: { id: string; star: boolean; x: number | null; y: number | null; heightShare: number }[];
}

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length === 0 ? NaN : s[Math.floor(s.length / 2)]!;
};
const km = (m: number): string => `${(m / 1000).toFixed(1)} km`;
const f2 = (x: number): string => (Number.isFinite(x) ? x.toFixed(2) : '-');

function deepestDataLevel(tileset: string): number {
  const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, 'data', 'tiles', tileset, 'manifest.json'), 'utf8')) as { layers: { height: { globalMaxLevel: number; coverage?: Record<string, unknown[]> } } };
  let deepest = manifest.layers.height.globalMaxLevel;
  for (const [level, rects] of Object.entries(manifest.layers.height.coverage ?? {})) if (rects.length > 0) deepest = Math.max(deepest, Number(level));
  return deepest;
}

/** Wait about 30 frames (at most 3 s, so a stopped loop cannot hang the spec), then read the cheap numbers. */
const poll = (page: Page): Promise<Poll> =>
  page.evaluate(async () => {
    await Promise.race([window.__test!.waitFrames(30), new Promise((r) => setTimeout(r, 3000))]);
    const t = window.__test!;
    const a = window.__app!;
    return { b: a.brief(), phase: t.pilot!.phase(), done: t.pilot!.done(), failure: t.pilot!.failure(), errors: t.errors.slice(), inFlight: a.inFlight(), frames: a.frames() };
  });

/** Read the perf window since the last reset and start a new one. */
const closeWindow = (page: Page, phase: string): Promise<PerfWindow> =>
  page.evaluate((ph) => {
    const p = window.__test!.perf()!;
    const c = window.__app!.cpu();
    const b = window.__app!.brief();
    window.__test!.resetPerf();
    return {
      phase: ph,
      view: b.viewMode,
      warp: b.warpFactor,
      frames: p.raf.count,
      raf: { p50: p.raf.p50, p95: p.raf.p95, p99: p.raf.p99, max: p.raf.max, over33ms: p.raf.over33ms },
      gpu: { p50: p.gpu.p50, p95: p.gpu.p95, p99: p.gpu.p99 },
      appCpu: { p50: c.frame.p50, p99: c.frame.p99, max: c.frame.max },
      coreCpuP99: p.cpu.p99,
      stages: Object.fromEntries(Object.entries(c.stages).map(([k, v]) => [k, v.p99])),
      features: Object.fromEntries(Object.entries(p.features).map(([k, v]) => [k, v.gpuMs])),
      featuresCpu: Object.fromEntries(Object.entries(c.features).map(([k, v]) => [k, v.p99])),
      slowest: window.__app!.cpuSlowest().slice(0, 2),
      qualityScale: p.qualityScale,
      renderScale: p.renderScale,
    };
  }, phase);

/** Start a new perf window; returns the frame counter at its start. */
const resetPerf = (page: Page): Promise<number> =>
  page.evaluate(() => {
    window.__test!.resetPerf();
    return window.__app!.frames();
  });

/** Small projection of the presented snapshot (state() copies everything: only at milestones and at the end). */
const stateFacts = (page: Page) =>
  page.evaluate(() => {
    const s = window.__test!.state()!;
    return {
      scenario: s.scenario,
      cheatCounter: s.cheatCounter,
      mission: s.mission,
      terrain: s.terrain,
      vessels: s.vessels.map((v) => ({ name: v.name, bodyId: v.bodyId, situation: v.situation, controllable: v.controllable, parts: v.parts.map((p) => p.def) })),
      surfaceTargets: s.surfaceTargets.map((t) => ({ kind: t.kind, name: t.name, radius: t.radius })),
    };
  });

async function setViewAndWait(page: Page, mode: string): Promise<void> {
  await page.evaluate((m) => window.__test!.setView(m), mode);
  // The view mode, not the camera kind: the cockpit rig's camera is of kind 'interior'.
  await page.waitForFunction((k) => !window.__app!.viewBlending() && window.__app!.viewMode() === k, mode, { polling: 100, timeout: 15_000 });
  await exposureSettled(page, `the switch to the ${mode} view`);
}

/**
 * Wait until the exposure has reached the meter's target (request cockpit-15): a picture taken while it still
 * adapts from the previous view's value shows a black cabin or a burnt-out sky. A change of camera kind is a cut
 * for the core, so this returns within a few frames; it reads the exposure, it does not wait for a time.
 */
async function exposureSettled(page: Page, what: string): Promise<void> {
  try {
    await page.waitForFunction(
      () => {
        const e = window.__app!.exposure();
        return Math.abs(e.ev100 - e.targetEv100) < 0.1;
      },
      undefined,
      { polling: 100, timeout: 30_000 },
    );
  } catch {
    // The flight goes on: the picture is taken as it is and the miss is reported.
    const e = await page.evaluate(() => window.__app!.exposure());
    expect.soft(`EV100 ${e.ev100.toFixed(2)}, target ${e.targetEv100.toFixed(2)}`, `the exposure did not reach its target within 30 s after ${what}`).toBe('on target');
  }
  await page.evaluate(() => window.__test!.waitFrames(4));
}

function aggregate(windows: PerfWindow[], phaseLog: { phase: string; wallMs: number }[], endMs: number): PhaseRow[] {
  const order: string[] = [];
  for (const w of windows) if (!order.includes(w.phase)) order.push(w.phase);
  const realMs = new Map<string, number>();
  for (let i = 0; i < phaseLog.length; i++) {
    const e = phaseLog[i]!;
    const next = phaseLog[i + 1]?.wallMs ?? endMs;
    realMs.set(e.phase, (realMs.get(e.phase) ?? 0) + next - e.wallMs);
  }
  return order.map((phase) => {
    const ws = windows.filter((w) => w.phase === phase);
    const warps = [...new Set(ws.map((w) => w.warp))].sort((a, b) => a - b);
    const stageIds = Object.keys(ws[0]!.stages);
    const featureIds = [...new Set(ws.flatMap((w) => Object.keys(w.features)))];
    const top = (ids: string[], pick: (w: PerfWindow, id: string) => number): string =>
      ids
        .map((id) => [id, median(ws.map((w) => pick(w, id)))] as const)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([id, v]) => `${id} ${v.toFixed(1)}`)
        .join(', ');
    return {
      phase,
      realMinutes: phase.endsWith('(cockpit)') ? 0 : (realMs.get(phase) ?? 0) / 60_000,
      frames: ws.reduce((n, w) => n + w.frames, 0),
      windows: ws.length,
      warp: warps.length > 2 ? `${warps[0]}-${warps[warps.length - 1]}` : warps.join(', '),
      rafP50: median(ws.map((w) => w.raf.p50)),
      rafP95: median(ws.map((w) => w.raf.p95)),
      rafP99: median(ws.map((w) => w.raf.p99)),
      rafWorstP99: Math.max(...ws.map((w) => w.raf.p99)),
      over33ms: ws.reduce((n, w) => n + w.raf.over33ms, 0),
      gpuP50: median(ws.map((w) => w.gpu.p50)),
      gpuP99: median(ws.map((w) => w.gpu.p99)),
      gpuWorstP99: Math.max(...ws.map((w) => w.gpu.p99)),
      cpuP50: median(ws.map((w) => w.appCpu.p50)),
      cpuP99: median(ws.map((w) => w.appCpu.p99)),
      topStages: top(stageIds, (w, id) => w.stages[id] ?? 0),
      topFeatures: top(featureIds, (w, id) => w.features[id] ?? 0),
      topFeaturesCpu: top(featureIds, (w, id) => w.featuresCpu?.[id] ?? 0),
    };
  });
}

test('lunar-direct flown by the test pilot in the page, pad to splashdown, in real time', async ({ page, pageLog }) => {
  const scenarioMilestones = (JSON.parse(fs.readFileSync(path.join(repoRoot, 'data', 'defs', 'scenarios', `${SCENARIO}.json`), 'utf8')) as { milestones: { id: string }[] }).milestones.map((m) => m.id);
  expect(scenarioMilestones).toHaveLength(17);

  const windows: PerfWindow[] = [];
  const shots: Shot[] = [];
  const phaseLog: { phase: string; wallMs: number; met: number; ut: number; warp: number; altitudeAsl: number }[] = [];
  const atMilestone: Record<string, { wallMs: number; phase: string | null; cheatCounter: number; failed: boolean }> = {};
  const errorsSeen = new Set<string>();
  let flightEndMs = 0;
  let t0 = 0;
  /** The harness clock before and after the flight (the page's own frame clock without the game's load). */
  const clock: { start: FrameClockStats | null; end: FrameClockStats | null } = { start: null, end: null };
  const dump = (record: Record<string, unknown>): string => {
    const dir = path.join(repoRoot, 'out', 'mission');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'browser-mission.json');
    const rows = windows.length > 0 ? aggregate(windows, phaseLog, flightEndMs || Date.now()) : [];
    fs.writeFileSync(file, JSON.stringify({ when: new Date().toISOString(), realMinutes: ((flightEndMs || Date.now()) - t0) / 60_000, clock, ...record, phases: rows, atMilestone, shots, errors: [...errorsSeen], console: pageLog.messages.slice(0, 50), phaseLog, windows }, null, 2));
    return file;
  };

  const shoot = async (milestone: string, index: number, phase: string | null): Promise<void> => {
    const views = COCKPIT_AT.has(milestone) ? ['chase', 'cockpit'] : ['chase'];
    for (const view of views) {
      if (view !== 'chase') await setViewAndWait(page, view);
      const name = `${String(index).padStart(2, '0')}-${milestone.toLowerCase().replace(/_/g, '-')}-${view}`;
      const shot = await saveScreenshot(page, SHOTS, name);
      const info = await page.evaluate(async () => ({
        hdr: await window.__test!.hdrStats(),
        audio: window.__test!.audio(),
        b: window.__app!.brief(),
        exposure: window.__app!.exposure(),
        framing: window.__app!.chaseFraming(),
        bodies: window.__app!.bodiesInFrame(),
      }));
      if (view === 'chase') {
        // The default framing (nothing in this spec turns the camera), and with it a body in the picture.
        expect.soft(info.framing.auto && Math.abs(info.framing.pitch) < 1e-9 && Math.abs(info.framing.zoom - 1) < 1e-9, `${name}: the chase rig's default framing (${JSON.stringify(info.framing)})`).toBe(true);
        expect.soft(info.bodies.filter((x) => !x.star).map((x) => x.id), `${name}: the Earth or the Moon in the frame`).not.toEqual([]);
      }
      const space = view === 'chase' && SPACE.has(milestone);
      try {
        assertRealImage(shot.stats, name, space ? { minNonBlack: 0.02, minStd: 4, minBuckets: 20 } : { minNonBlack: 0.3, minStd: 8, minBuckets: 40 });
      } catch (e) {
        expect.soft(String(e), `image statistics of ${name}`).toBe('a real image');
      }
      expect.soft(info.hdr.nanPixels, `${name}: NaN pixels in the HDR target`).toBe(0);
      const s = shot.stats;
      shots.push({
        milestone,
        view,
        file: path.relative(repoRoot, shot.file).replace(/\\/g, '/'),
        phase,
        altitudeAsl: info.b.altitudeAsl,
        stats: { meanLuma: s.meanLuma, stdLuma: s.stdLuma, fractionNonBlack: s.fractionNonBlack, distinctColorBuckets: s.distinctColorBuckets },
        hdr: info.hdr,
        audio: info.audio ? Object.fromEntries(Object.entries(info.audio.buses).map(([k, v]) => [k, v.rms])) : null,
        exposure: { ev100: info.exposure.ev100, targetEv100: info.exposure.targetEv100 },
        framing: info.framing,
        bodies: info.bodies.map((x) => ({ id: x.id, star: x.star, x: x.x, y: x.y, heightShare: x.heightShare })),
      });
      console.log(
        `[${((Date.now() - t0) / 60_000).toFixed(1)} min] shot ${name}: alt ${km(info.b.altitudeAsl)}, luma ${s.meanLuma.toFixed(1)} +/- ${s.stdLuma.toFixed(1)}, non-black ${(s.fractionNonBlack * 100).toFixed(0)} %, EV100 ${info.exposure.ev100.toFixed(2)} (target ${info.exposure.targetEv100.toFixed(2)}), in frame: ${info.bodies.map((x) => `${x.id}${x.x !== null && x.y !== null ? ` at ${x.x.toFixed(2)},${x.y.toFixed(2)}` : ' (limb)'}`).join(', ') || 'no body'}`,
      );
      if (view === 'cockpit') {
        // The cockpit column of ARCHITECTURE 17.1: one window in the cabin, then back to the chase view.
        await resetPerf(page);
        await page.evaluate((n) => window.__test!.waitFrames(n), WINDOW_FRAMES);
        windows.push(await closeWindow(page, `${phase ?? '?'} (cockpit)`));
        await setViewAndWait(page, 'chase');
      }
    }
  };

  await withGpuLock(async () => {
    // `ready` resolves when the loading screen has gone (the view at the pad final); the pilot starts with it.
    await openPage(page, `/?scenario=${SCENARIO}&pilot=1&view=chase&scale=1&governor=off`, { timeoutMs: 240_000 });
    await assertDiscreteGpu(page);
    t0 = Date.now();
    const pageInfo = await page.evaluate(() => window.__test!.page);
    expect(pageInfo).toEqual({ kind: 'app', name: 'main', scenarioId: SCENARIO });
    const start = await stateFacts(page);
    expect(start.scenario).toEqual({ id: SCENARIO, startKind: 'pad', stagesAlreadyFired: 0 });
    expect(start.cheatCounter).toBe(0);
    // The page's frame clock before the flight's first window (the game's loop stands still while the probe page
    // is in front: the pilot is waiting on the pad).
    clock.start = await measureHarnessClock(page);
    console.log(`harness clock before the flight: p50 ${clock.start.p50.toFixed(2)} ms, ${clock.start.hz.toFixed(2)} Hz`);
    // A key the game does not bind: the first gesture resumes the AudioContext (the engines are heard), nothing else.
    await page.keyboard.press('F9');

    let p = await poll(page);
    await shoot('PAD', 0, p.phase);
    let phase = p.phase ?? 'prelaunch';
    phaseLog.push({ phase, wallMs: Date.now(), met: p.b.met, ut: p.b.ut, warp: p.b.warpFactor, altitudeAsl: p.b.altitudeAsl });
    const handled = new Set<string>();
    let lastFrames = p.frames;
    let lastFramesAt = Date.now();
    let windowFrames0 = await resetPerf(page);

    for (;;) {
      p = await poll(page);
      const now = Date.now();
      for (const e of p.errors)
        if (!errorsSeen.has(e)) {
          errorsSeen.add(e);
          console.log(`window.__test.errors: ${e}`);
        }
      if (p.frames !== lastFrames) {
        lastFrames = p.frames;
        lastFramesAt = now;
      } else if (now - lastFramesAt > STALL_MS) throw new Error(`the frame loop stopped in phase ${p.phase} (errors ${JSON.stringify([...errorsSeen])}; ${JSON.stringify(p.b)})`);
      if (p.failure !== null) throw new Error(`the pilot gave up in phase ${p.phase}: ${p.failure} (${JSON.stringify(p.b)}; report ${JSON.stringify(await page.evaluate(() => window.__app!.pilotReport()))})`);
      if (!p.done && !p.inFlight && p.b.milestones.includes('LIFTOFF')) {
        const s = await stateFacts(page);
        if (s.mission.failed) throw new Error(`mission failed in phase ${p.phase}: ${s.mission.failureReason} (${JSON.stringify(p.b)})`);
      }
      if (now - t0 > FLIGHT_LIMIT_MS) throw new Error(`no splashdown after ${FLIGHT_LIMIT_MS / 60_000} minutes (phase ${p.phase}, ${JSON.stringify(p.b)})`);

      const fresh = p.b.milestones.filter((id) => !handled.has(id));
      const phaseNow = p.phase ?? phase;
      const phaseChanged = phaseNow !== phase;
      const full = p.frames - windowFrames0 >= WINDOW_FRAMES;
      if (fresh.length > 0 || phaseChanged || full) {
        if (p.frames - windowFrames0 >= MIN_WINDOW_FRAMES) windows.push(await closeWindow(page, phase));
        if (phaseChanged) {
          console.log(`[${((now - t0) / 60_000).toFixed(1)} min] phase ${phase} -> ${phaseNow} (MET ${(p.b.met / 3600).toFixed(2)} h, ${km(p.b.altitudeAsl)}, warp ${p.b.warpFactor}x)`);
          phase = phaseNow;
          phaseLog.push({ phase, wallMs: now, met: p.b.met, ut: p.b.ut, warp: p.b.warpFactor, altitudeAsl: p.b.altitudeAsl });
        }
        for (const id of fresh) {
          handled.add(id);
          const facts = await stateFacts(page);
          atMilestone[id] = { wallMs: now - t0, phase: p.phase, cheatCounter: facts.cheatCounter, failed: facts.mission.failed };
          console.log(`[${((now - t0) / 60_000).toFixed(1)} min] milestone ${id} in phase ${p.phase} (MET ${(p.b.met / 3600).toFixed(2)} h)`);
          await shoot(id, scenarioMilestones.indexOf(id) + 1, p.phase);
        }
        windowFrames0 = await resetPerf(page);
      }
      if (p.done && scenarioMilestones.every((id) => handled.has(id))) break;
      // Done but a milestone never came: two minutes of grace, then the gates say which one is missing.
      if (p.done && now - phaseLog[phaseLog.length - 1]!.wallMs > 120_000) break;
    }
    flightEndMs = Date.now();
    clock.end = await measureHarnessClock(page);
    console.log(`harness clock after the flight: p50 ${clock.end.p50.toFixed(2)} ms, ${clock.end.hz.toFixed(2)} Hz`);
  }, 60 * 60_000).catch(async (e: unknown) => {
    // Keep what was measured and seen for the diagnosis, then fail.
    flightEndMs = Date.now();
    const brief = await page.evaluate(() => ({ b: window.__app?.brief(), report: window.__app?.pilotReport(), milestones: window.__test?.milestones(), errors: window.__test?.errors })).catch(() => null);
    dump({ failure: String(e), brief });
    throw e;
  });

  // ------------------------------------------------------------------------------------- the record
  const milestones: MilestoneRecord[] = await page.evaluate(() => window.__test!.milestones());
  const last = await stateFacts(page);
  const rows = aggregate(windows, phaseLog, flightEndMs);
  const realMinutes = (flightEndMs - t0) / 60_000;
  const gates: { milestone: string; measured: string; gate: string }[] = [];
  const note = (id: string, measured: string, gate: string): void => {
    gates.push({ milestone: id, measured, gate });
  };
  const m = (id: string): MilestoneRecord => {
    const r = milestones.find((x) => x.id === id);
    if (!r) throw new Error(`milestone ${id} missing (have ${milestones.map((x) => x.id).join(' ')})`);
    return r;
  };
  const deepest = deepestDataLevel('moon');

  const writeRecord = (): string => dump({ gates, milestones, last });
  writeRecord();

  // ------------------------------------------------------------------------------------- the gates
  // Run to the end under the rules.
  expect.soft(last.scenario).toEqual({ id: SCENARIO, startKind: 'pad', stagesAlreadyFired: 0 });
  expect.soft(last.cheatCounter, 'cheatCounter').toBe(0);
  for (const [id, a] of Object.entries(atMilestone)) expect.soft(a.cheatCounter, `cheatCounter at ${id}`).toBe(0);
  expect.soft(last.mission.failed, `mission failed: ${last.mission.failureReason}`).toBe(false);
  expect.soft(last.mission.crewAlive).toBe(true);
  expect.soft(last.terrain.incompleteQueries, 'terrain.incompleteQueries').toBe(0);
  expect.soft([...errorsSeen], 'window.__test.errors during the flight').toEqual([]);
  expect.soft(milestones.map((x) => x.id), 'the seventeen milestones in order').toEqual(scenarioMilestones);
  for (let i = 1; i < milestones.length; i++) expect.soft(milestones[i]!.ut).toBeGreaterThanOrEqual(milestones[i - 1]!.ut);
  for (const r of milestones) for (const [k, v] of Object.entries(r.data)) expect.soft(Number.isFinite(v), `${r.id}.${k} finite`).toBe(true);

  // 1-2.
  const lift = m('LIFTOFF').data;
  expect.soft(lift['speedSurface']!).toBeLessThan(0.1);
  expect.soft(Math.abs(lift['speedOrbital']! - 439)).toBeLessThan(2);
  note('LIFTOFF', `surface speed ${lift['speedSurface']!.toFixed(3)} m/s, inertial ${lift['speedOrbital']!.toFixed(1)} m/s`, '< 0.1 m/s; 439 +/- 2 m/s');
  const q = m('MAX_Q').data;
  expect.soft(q['peakDynamicPressure']!).toBeGreaterThan(20000);
  expect.soft(q['peakDynamicPressure']!).toBeLessThan(40000);
  note('MAX_Q', `${(q['peakDynamicPressure']! / 1000).toFixed(2)} kPa at ${km(q['peakDynamicPressureAltitude']!)}`, '20-40 kPa');
  // 3.
  const s1 = m('STAGE_SEP_1').data;
  const fj = m('FAIRING_JETTISON').data;
  const s2 = m('STAGE_SEP_2').data;
  expect.soft(s1['vesselsSeparated']!).toBeGreaterThanOrEqual(1);
  expect.soft(fj['vesselsSeparated']!).toBeGreaterThanOrEqual(1);
  expect.soft(s2['vesselsSeparated']!).toBeGreaterThanOrEqual(1);
  expect.soft(fj['altitude']!).toBeGreaterThan(80000);
  note('STAGE_SEP_1', `${km(s1['altitude']!)}, ${s1['speedSurface']!.toFixed(0)} m/s, ${s1['vesselsSeparated']} debris vessel(s)`, 'leaves debris');
  note('FAIRING_JETTISON', `${km(fj['altitude']!)}, ${fj['vesselsSeparated']} debris vessels`, 'above 80 km, leaves debris');
  note('STAGE_SEP_2', `${km(s2['altitude']!)}, ${s2['speedOrbital']!.toFixed(0)} m/s, ${s2['vesselsSeparated']} debris vessel(s)`, 'leaves debris');
  // 4.
  const eo = m('EARTH_ORBIT').data;
  expect.soft(eo['periapsisAltitude']!).toBeGreaterThanOrEqual(160000);
  expect.soft(eo['apoapsisAltitude']!).toBeLessThanOrEqual(400000);
  note('EARTH_ORBIT', `${km(eo['periapsisAltitude']!)} x ${km(eo['apoapsisAltitude']!)}, incl. ${eo['inclinationDeg']!.toFixed(2)} deg`, 'Pe >= 160 km, Ap <= 400 km');
  // 5-7.
  const tli = m('TLI_COMPLETE');
  expect.soft(tli.data['predictedSoiUt']!).toBeGreaterThan(tli.ut);
  note('TLI_COMPLETE', `Moon encounter predicted ${((tli.data['predictedSoiUt']! - tli.ut) / 3600).toFixed(1)} h ahead`, 'patches contain a Moon encounter');
  const soi = m('MOON_SOI_ENTER').data;
  expect.soft(soi['soiTimeError']!).toBeLessThanOrEqual(2);
  note('MOON_SOI_ENTER', `${soi['soiTimeError']!.toFixed(3)} s from the predicted time`, '+/- 2 s');
  const lo = m('LUNAR_ORBIT').data;
  expect.soft(lo['eccentricity']!).toBeLessThan(0.05);
  expect.soft(lo['periapsisAltitude']!).toBeGreaterThan(60000);
  note('LUNAR_ORBIT', `${km(lo['periapsisAltitude']!)} x ${km(lo['apoapsisAltitude']!)}, e ${lo['eccentricity']!.toFixed(4)}`, 'e < 0.05, Pe > 60 km');
  // 8.
  const td = m('LUNAR_TOUCHDOWN').data;
  expect.soft(td['distanceToLandingTarget']!).toBeGreaterThanOrEqual(0);
  expect.soft(td['distanceToLandingTarget']!).toBeLessThanOrEqual(1500);
  expect.soft(td['availableLevel'], 'available data level at touchdown').toBe(deepest);
  expect.soft(td['residentLevel'], 'resident data level at touchdown').toBe(deepest);
  expect.soft(td['terrainComplete']).toBe(1);
  expect.soft(td['touchdownVerticalSpeed']!).toBeLessThan(2.5);
  expect.soft(td['touchdownHorizontalSpeed']!).toBeLessThan(1.0);
  expect.soft(td['touchdownTiltDeg']!).toBeLessThan(12);
  expect.soft(td['tiltDeg']!).toBeLessThan(12);
  expect.soft(td['legs']).toBe(4);
  expect.soft(td['legsBroken']).toBe(0);
  expect.soft(td['legsIntact']).toBe(1);
  const ll = m('LUNAR_LIFTOFF');
  expect.soft(ll.ut - m('LUNAR_TOUCHDOWN').ut, 'time on the surface').toBeGreaterThan(SURFACE_STAY_SECONDS);
  note(
    'LUNAR_TOUCHDOWN',
    `${td['distanceToLandingTarget']!.toFixed(2)} m from the target; data level ${td['residentLevel']} resident of ${td['availableLevel']} available (deepest ${deepest}); ${td['touchdownVerticalSpeed']!.toFixed(2)} m/s down, ${td['touchdownHorizontalSpeed']!.toFixed(3)} m/s across, tilt ${td['touchdownTiltDeg']!.toFixed(2)} deg (${td['tiltDeg']!.toFixed(2)} at the record), ${td['legs']! - td['legsBroken']!} of ${td['legs']} legs intact; ${(ll.ut - m('LUNAR_TOUCHDOWN').ut).toFixed(0)} s on the surface`,
    '<= 1,500 m; deepest level; < 2.5 m/s; < 1.0 m/s; < 12 deg; legs intact; > 600 s landed',
  );
  // 9-10.
  expect.soft(ll.data['vesselsLeftOnSurface']!).toBeGreaterThanOrEqual(1);
  const left = last.vessels.filter((v) => v.bodyId === 'moon' && v.situation === 'landed' && !v.controllable);
  expect.soft(left, 'the descent stage landed on the Moon at the end').toHaveLength(1);
  expect.soft(left[0]?.parts.includes('heron-descent-stage')).toBe(true);
  note('LUNAR_LIFTOFF', `after ${ll.data['surfaceStay']!.toFixed(0)} s on the surface; "${left[0]?.name ?? '?'}" still landed at the end`, 'descent stage stays behind as landed debris');
  const exit = m('MOON_SOI_EXIT').data;
  expect.soft(exit['soiTimeError']!).toBeLessThanOrEqual(2);
  note('MOON_SOI_EXIT', `${exit['soiTimeError']!.toFixed(3)} s from the predicted time`, 'reached, +/- 2 s');
  const pe = m('EARTH_PERIGEE_TARGETED').data;
  expect.soft(pe['predictedPeriapsisAltitude']!).toBeGreaterThanOrEqual(30000);
  expect.soft(pe['predictedPeriapsisAltitude']!).toBeLessThanOrEqual(60000);
  note('EARTH_PERIGEE_TARGETED', `vacuum perigee ${km(pe['predictedPeriapsisAltitude']!)}`, '30-60 km');
  // 11-12.
  const ei = m('ENTRY_INTERFACE').data;
  expect.soft(Math.abs(ei['altitude']! - 122000)).toBeLessThan(50);
  expect.soft(ei['speedOrbital']!).toBeGreaterThan(10900);
  expect.soft(ei['speedOrbital']!).toBeLessThan(11100);
  const sp = m('SPLASHDOWN').data;
  const drogue = m('DROGUE_DEPLOY').data;
  const main = m('MAIN_DEPLOY').data;
  expect.soft(sp['peakG']!).toBeLessThan(10);
  expect.soft(sp['peakGDose']!).toBeLessThan(5);
  expect.soft(sp['ablatorFraction']!).toBeGreaterThan(0.25);
  expect.soft(drogue['rcsFraction']!).toBeGreaterThan(0.2);
  note('ENTRY_INTERFACE', `${km(ei['altitude']!)}, ${(ei['speedOrbital']! / 1000).toFixed(3)} km/s; peak ${sp['peakG']!.toFixed(2)} g, g-dose ${sp['peakGDose']!.toFixed(2)}, ablator left ${(sp['ablatorFraction']! * 100).toFixed(1)} %, capsule RCS left at drogues ${(drogue['rcsFraction']! * 100).toFixed(1)} %`, '122 km, 10.9-11.1 km/s; < 10 g; dose < 5; ablator > 25 %; RCS > 20 %');
  expect.soft(drogue['chuteEnvelope']).toBe(0);
  expect.soft(main['chuteEnvelope']).toBe(0);
  note('DROGUE_DEPLOY', `${drogue['deployAltitude']!.toFixed(0)} m, Mach ${drogue['deployMach']!.toFixed(2)}, ${(drogue['deployDynamicPressure']! / 1000).toFixed(2)} kPa`, 'inside the envelope');
  note('MAIN_DEPLOY', `${main['deployAltitude']!.toFixed(0)} m, ${main['deploySpeed']!.toFixed(1)} m/s, ${(main['deployDynamicPressure']! / 1000).toFixed(2)} kPa`, 'inside the envelope');
  // 13.
  expect.soft(sp['surfaceWater']).toBe(1);
  expect.soft(sp['insideRecoveryZone']).toBe(1);
  expect.soft(sp['recoveryZoneDistance']!).toBeGreaterThanOrEqual(0);
  expect.soft(sp['recoveryZoneDistance']!).toBeLessThan(sp['recoveryZoneRadius']!);
  expect.soft(sp['touchdownVerticalSpeed']!).toBeLessThanOrEqual(9.5);
  expect.soft(sp['crewAlive']).toBe(1);
  expect.soft(sp['settledFor']!).toBeGreaterThanOrEqual(30);
  expect.soft(sp['tiltDeg']!).toBeLessThan(25);
  const zone = last.surfaceTargets.filter((t) => t.kind === 'recovery').find((t) => Math.abs(t.radius - sp['recoveryZoneRadius']!) < 1);
  note(
    'SPLASHDOWN',
    `${sp['latitudeDeg']!.toFixed(2)} deg, ${sp['longitudeDeg']!.toFixed(2)} deg on water, ${km(sp['recoveryZoneDistance']!)} from the centre of "${zone?.name ?? '?'}" (radius ${km(sp['recoveryZoneRadius']!)}); ${sp['touchdownVerticalSpeed']!.toFixed(2)} m/s; upright at ${sp['tiltDeg']!.toFixed(1)} deg after ${sp['settledFor']!.toFixed(0)} s`,
    'water, inside a recovery zone; <= 9.5 m/s; crew alive; upright after 30 s',
  );
  // 14 (the part a milestone record holds).
  const days = (m('SPLASHDOWN').ut - milestones[0]!.ut) / 86400;
  expect.soft(days).toBeLessThan(14);
  note('budgets', `${days.toFixed(2)} days from lift-off to splashdown; ${realMinutes.toFixed(1)} minutes of real time from ready to splashdown`, '< 14 days');

  const file = writeRecord();
  console.log(`\nBrowser mission (${file}), ${realMinutes.toFixed(1)} min:`);
  for (const g of gates) console.log(`  ${g.milestone.padEnd(22)} ${g.measured}   [gate: ${g.gate}]`);
  console.log('\n  phase                          min  frames  warp      rAF p50/p95/p99 (worst)   >=33  GPU p50/p99 (worst)   CPU p50/p99   stages p99 | GPU features p99 | CPU features p99');
  for (const r of rows)
    console.log(
      `  ${r.phase.padEnd(30)} ${r.realMinutes.toFixed(1).padStart(4)} ${String(r.frames).padStart(7)}  ${r.warp.padEnd(9)} ${f2(r.rafP50)}/${f2(r.rafP95)}/${f2(r.rafP99)} (${f2(r.rafWorstP99)})  ${String(r.over33ms).padStart(4)}  ${f2(r.gpuP50)}/${f2(r.gpuP99)} (${f2(r.gpuWorstP99)})  ${f2(r.cpuP50)}/${f2(r.cpuP99)}  ${r.topStages} | ${r.topFeatures} | ${r.topFeaturesCpu}`,
    );

  // ------------------------------------------------------------------------------------- frame time (17, 18.2)
  for (const r of rows) {
    expect.soft(r.gpuP99, `${r.phase}: GPU p99 (17: <= 11 ms)`).toBeLessThanOrEqual(11);
    expect.soft(r.cpuP99, `${r.phase}: main-thread frame p99 (17: <= 6 ms)`).toBeLessThanOrEqual(6);
  }
  // The requestAnimationFrame lines: on the nominal 60 Hz clock, or not at all (and then the spec says why).
  let nominal = true;
  try {
    if (!clock.start || !clock.end) throw new Error('the harness clock was not measured');
    expectNominalClock(clock.start, 'harness clock before the flight');
    expectNominalClock(clock.end, 'harness clock after the flight');
  } catch (e) {
    nominal = false;
    expect.soft(e instanceof Error ? e.message : String(e), 'the requestAnimationFrame lines were not judged').toBe('a nominal 60 Hz harness clock');
  }
  if (nominal) {
    for (const r of rows) {
      expect.soft(r.rafP99, `${r.phase}: rAF p99 (17: <= 17.5 ms)`).toBeLessThanOrEqual(17.5);
      expect.soft(r.over33ms, `${r.phase}: rAF deltas >= 33 ms (17: none in steady flight)`).toBe(0);
      expect.soft(r.rafP95, `${r.phase}: rAF p95 (18.2: < 16.7 ms)`).toBeLessThan(16.7);
    }
  }
  await expectNoErrors(page, pageLog);
});
