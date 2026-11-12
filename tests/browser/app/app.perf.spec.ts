/**
 * Frame time of the game at the pad and in the climb, against ARCHITECTURE 17 (RTX 5090, 60 fps): GPU p99 <= 11 ms
 * (sum of pass timestamps at 1440p internal), rAF p99 <= 17.5 ms with no delta >= 33 ms in steady flight, CPU
 * main thread per frame p99 <= 6 ms. Recorded, never loosened: a miss is a finding for the hand-off.
 *
 *   node tools/dev/heavy.mjs --class=gpu -- npx playwright test tests/browser/app/app.perf.spec.ts --project=perf
 *
 * 2560 x 1440 at render scale 1 (1440p internal), quality governor off (qualityScale 1), measured under the
 * machine-wide GPU lock (which serialises perf specs only: other agents' functional Chrome runs may share the GPU;
 * the hand-off notes the load). Each number is the median over three windows of 240 frames of the window's p99
 * (one hitch from another process IS a window's p99). A second run at 1280 x 720 is recorded for comparison.
 *
 * Main-thread attribution: the app times every render feature's hooks in every frame (src/app/featureTiming.ts),
 * keeps the slowest frames of a window with their whole breakdown and can trace consecutive frames. The windows
 * record both; the burn test traces an engine start and cut-off away from any terrain (lunar orbit) and says what
 * the slow frames are made of.
 * Output: out/app/perf-1440p.json, out/app/perf-720p.json, out/app/perf-burn.json.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import type { AppBrief } from '../../../src/app/testHooks';
import type { FrameBreakdown, FrameTrace } from '../../../src/app/timing';
import { assertDiscreteGpu, expect, openPage, test, waitIdle, withGpuLock } from '../harness';

test.setTimeout(20 * 60_000);

const WINDOWS = 3;
const WINDOW_FRAMES = 240;

interface WindowSample {
  raf: { p50: number; p95: number; p99: number; max: number; over33ms: number };
  gpu: { p50: number; p99: number };
  coreCpu: { p99: number };
  appCpu: { p50: number; p99: number; max: number };
  stages: Record<string, number>;
  features: Record<string, number>;
  featuresCpu: Record<string, number>;
  /** The app's own per-frame measurement of every feature's hooks (`core` = render stage minus the hooks): p50 and p99. */
  appFeatures: Record<string, { p50: number; p99: number }>;
  /** The four slowest frames of the window with their breakdown. */
  slowest: FrameBreakdown[];
  qualityScale: number;
  renderScale: number;
}

interface Checkpoint {
  name: string;
  altitudeStart: number;
  altitudeEnd: number;
  windows: WindowSample[];
  median: {
    rafP99: number;
    rafMax: number;
    over33ms: number;
    gpuP50: number;
    gpuP99: number;
    appCpuP50: number;
    appCpuP99: number;
    coreCpuP99: number;
    features: Record<string, number>;
    featuresCpu: Record<string, number>;
    appFeaturesP50: Record<string, number>;
    appFeaturesP99: Record<string, number>;
    stages: Record<string, number>;
  };
}

const ms = (x: number): string => x.toFixed(2);

/** One slow frame in words: what its main-thread time was made of. */
function describeFrame(b: FrameBreakdown): string {
  const top = (o: Record<string, number>, n: number): string =>
    Object.entries(o)
      .filter(([, v]) => v >= 0.1)
      .sort((a, c) => c[1] - a[1])
      .slice(0, n)
      .map(([k, v]) => `${k} ${ms(v)}`)
      .join(', ');
  return `frame ${b.frame} (${b.frame % 64} mod 64): ${ms(b.total)} ms = ${top(b.stages, 4)}; features: ${top(b.features, 5)}; hooks: ${top(b.hooks, 6)} [${b.note}]`;
}

/**
 * Open the game and wait for `ready` (the loading screen gone). A boot that does not finish in time fails with
 * what the loading screen was waiting for, instead of running into the test's timeout.
 */
async function openWithin(page: Page, pathAndQuery: string, timeoutMs: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      page
        .evaluate(() => window.__boot?.().steps.map((x) => `${x.id} ${x.state}${x.done !== null ? ` ${x.done}/${x.total}` : ''} ${x.detail}`))
        .then(
          (steps) => reject(new Error(`the game was not ready after ${timeoutMs / 1000} s; loading screen: ${JSON.stringify(steps)}`)),
          () => reject(new Error(`the game was not ready after ${timeoutMs / 1000} s (page not responding)`)),
        );
    }, timeoutMs);
  });
  try {
    await Promise.race([openPage(page, pathAndQuery, { timeoutMs }), late]);
  } finally {
    clearTimeout(timer);
  }
}

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length === 0 ? 0 : s[Math.floor(s.length / 2)]!;
};

async function measure(page: Page, name: string): Promise<Checkpoint> {
  const altitudeStart = (await page.evaluate(() => window.__app!.brief())).altitudeAsl;
  const windows: WindowSample[] = [];
  for (let w = 0; w < WINDOWS; w++) {
    windows.push(
      await page.evaluate(async (frames) => {
        window.__test!.resetPerf();
        await window.__test!.waitFrames(frames);
        const p = window.__test!.perf()!;
        const cpu = window.__app!.cpu();
        return {
          raf: { p50: p.raf.p50, p95: p.raf.p95, p99: p.raf.p99, max: p.raf.max, over33ms: p.raf.over33ms },
          gpu: { p50: p.gpu.p50, p99: p.gpu.p99 },
          coreCpu: { p99: p.cpu.p99 },
          appCpu: { p50: cpu.frame.p50, p99: cpu.frame.p99, max: cpu.frame.max },
          stages: Object.fromEntries(Object.entries(cpu.stages).map(([k, v]) => [k, v.p99])),
          features: Object.fromEntries(Object.entries(p.features).map(([k, v]) => [k, v.gpuMs])),
          featuresCpu: Object.fromEntries(Object.entries(p.features).map(([k, v]) => [k, v.cpuMs])),
          appFeatures: Object.fromEntries(Object.entries(cpu.features).map(([k, v]) => [k, { p50: v.p50, p99: v.p99 }])),
          slowest: window.__app!.cpuSlowest().slice(0, 4),
          qualityScale: p.qualityScale,
          renderScale: p.renderScale,
        };
      }, WINDOW_FRAMES),
    );
  }
  const altitudeEnd = (await page.evaluate(() => window.__app!.brief())).altitudeAsl;
  const featureIds = [...new Set(windows.flatMap((w) => Object.keys(w.features)))];
  const appFeatureIds = [...new Set(windows.flatMap((w) => Object.keys(w.appFeatures)))];
  const stageIds = [...new Set(windows.flatMap((w) => Object.keys(w.stages)))];
  const cp: Checkpoint = {
    name,
    altitudeStart,
    altitudeEnd,
    windows,
    median: {
      rafP99: median(windows.map((w) => w.raf.p99)),
      rafMax: Math.max(...windows.map((w) => w.raf.max)),
      over33ms: windows.reduce((n, w) => n + w.raf.over33ms, 0),
      gpuP50: median(windows.map((w) => w.gpu.p50)),
      gpuP99: median(windows.map((w) => w.gpu.p99)),
      appCpuP50: median(windows.map((w) => w.appCpu.p50)),
      appCpuP99: median(windows.map((w) => w.appCpu.p99)),
      coreCpuP99: median(windows.map((w) => w.coreCpu.p99)),
      features: Object.fromEntries(featureIds.map((id) => [id, median(windows.map((w) => w.features[id] ?? 0))])),
      featuresCpu: Object.fromEntries(featureIds.map((id) => [id, median(windows.map((w) => w.featuresCpu[id] ?? 0))])),
      appFeaturesP50: Object.fromEntries(appFeatureIds.map((id) => [id, median(windows.map((w) => w.appFeatures[id]?.p50 ?? 0))])),
      appFeaturesP99: Object.fromEntries(appFeatureIds.map((id) => [id, median(windows.map((w) => w.appFeatures[id]?.p99 ?? 0))])),
      stages: Object.fromEntries(stageIds.map((id) => [id, median(windows.map((w) => w.stages[id] ?? 0))])),
    },
  };
  const m = cp.median;
  console.log(
    `${name}: GPU p50 ${m.gpuP50.toFixed(2)} / p99 ${m.gpuP99.toFixed(2)} ms; rAF p99 ${m.rafP99.toFixed(2)} ms, max ${m.rafMax.toFixed(1)}, >=33 ms ${m.over33ms}; app CPU p99 ${m.appCpuP99.toFixed(2)} ms (window.__perf.cpu ${m.coreCpuP99.toFixed(2)}); stages ${Object.entries(m.stages)
      .map(([k, v]) => `${k} ${v.toFixed(2)}`)
      .join(', ')}; features ${Object.entries(m.features)
      .map(([k, v]) => `${k} ${v.toFixed(2)}`)
      .join(', ')}; feature CPU ${Object.entries(m.featuresCpu)
      .map(([k, v]) => `${k} ${v.toFixed(2)}`)
      .join(', ')}; scale ${windows.map((w) => `${w.qualityScale}/${w.renderScale}`).join(' ')}`,
  );
  console.log(
    `${name}: main thread p50 ${ms(m.appCpuP50)} / p99 ${ms(m.appCpuP99)} ms; per feature p50 / p99 (every frame, the app's hook timers): ${appFeatureIds
      .filter((id) => (m.appFeaturesP99[id] ?? 0) >= 0.05)
      .sort((a, c) => m.appFeaturesP99[c]! - m.appFeaturesP99[a]!)
      .map((id) => `${id} ${ms(m.appFeaturesP50[id]!)} / ${ms(m.appFeaturesP99[id]!)}`)
      .join(', ')}`,
  );
  for (const w of windows) for (const b of w.slowest.slice(0, 2)) console.log(`  ${name} slow ${describeFrame(b)}`);
  return cp;
}

async function until(page: Page, predicate: string, timeout: number): Promise<AppBrief> {
  await page.waitForFunction(`(() => { const b = window.__app.brief(); return ${predicate}; })()`, undefined, { polling: 100, timeout });
  return page.evaluate(() => window.__app!.brief());
}

interface TraceSummary {
  frames: number;
  total: { p50: number; p99: number; max: number };
  /** Frames of 6 ms or more: how many, and how many of them are the render core's attribution frames (frame % 64 == 32). */
  over6ms: number;
  over6msAttribution: number;
  /** Per feature: p50, p99 and max over the trace, ms. */
  features: Record<string, { p50: number; p99: number; max: number }>;
  /** The slowest frames: index in the trace, total, the features of 0.3 ms or more, the app's note. */
  slowest: { index: number; frame: number; total: number; render: number; sim: number; hud: number; audio: number; features: Record<string, number>; note: string }[];
  /** Index of the first frame with thrust and of the first frame without it afterwards (-1 = never). */
  thrustOn: number;
  thrustOff: number;
}

const quantile = (xs: number[], q: number): number => {
  const v = [...xs].sort((a, b) => a - b);
  return v.length === 0 ? 0 : v[Math.min(v.length - 1, Math.floor(q * (v.length - 1) + 0.5))]!;
};

/** A trace of consecutive frames in numbers: where the slow frames are and what they are made of. */
function summariseTrace(name: string, t: FrameTrace): TraceSummary {
  const n = t.total.length;
  const thrust = t.notes.map((x) => Number(/thrust (-?\d+) kN/.exec(x)?.[1] ?? 0));
  const thrustOn = thrust.findIndex((x) => x > 0);
  const thrustOff = thrustOn < 0 ? -1 : thrust.findIndex((x, i) => i > thrustOn && x === 0);
  const order = t.total.map((_, i) => i).sort((a, b) => t.total[b]! - t.total[a]!);
  const slowest = order.slice(0, 12).map((i) => ({
    index: i,
    frame: t.firstFrame + i,
    total: t.total[i]!,
    render: t.render[i]!,
    sim: t.sim[i]!,
    hud: t.hud[i]!,
    audio: t.audio[i]!,
    features: Object.fromEntries(
      Object.entries(t.features)
        .map(([id, col]) => [id, col[i] ?? 0] as [string, number])
        .filter(([, v]) => v >= 0.3),
    ),
    note: t.notes[i]!,
  }));
  const over = t.total.map((x, i) => ({ x, i })).filter((e) => e.x >= 6);
  const summary: TraceSummary = {
    frames: n,
    total: { p50: quantile(t.total, 0.5), p99: quantile(t.total, 0.99), max: Math.max(...t.total) },
    over6ms: over.length,
    over6msAttribution: over.filter((e) => (t.firstFrame + e.i) % 64 === 32).length,
    features: Object.fromEntries(Object.entries(t.features).map(([id, col]) => [id, { p50: quantile(col, 0.5), p99: quantile(col, 0.99), max: Math.max(...col) }])),
    slowest,
    thrustOn,
    thrustOff,
  };
  console.log(
    `${name}: trace of ${n} frames from frame ${t.firstFrame}; main thread p50 ${ms(summary.total.p50)} / p99 ${ms(summary.total.p99)} / max ${ms(summary.total.max)} ms; ${over.length} frames of 6 ms or more (${summary.over6msAttribution} on frame % 64 == 32); thrust from index ${thrustOn} to ${thrustOff}`,
  );
  console.log(
    `  per feature p50 / p99 / max: ${Object.entries(summary.features)
      .filter(([, v]) => v.max >= 0.2)
      .sort((a, b) => b[1].p99 - a[1].p99)
      .map(([id, v]) => `${id} ${ms(v.p50)} / ${ms(v.p99)} / ${ms(v.max)}`)
      .join(', ')}`,
  );
  for (const f of slowest.slice(0, 8)) {
    console.log(
      `  slow index ${f.index} (frame ${f.frame}, ${f.frame % 64} mod 64): ${ms(f.total)} ms, render ${ms(f.render)}, sim ${ms(f.sim)}, hud ${ms(f.hud)}, audio ${ms(f.audio)}; ${Object.entries(f.features)
        .sort((a, b) => b[1] - a[1])
        .map(([k, v]) => `${k} ${ms(v)}`)
        .join(', ')} [${f.note}]`,
    );
  }
  return summary;
}

/**
 * Wait for streaming to finish; at 1440p the terrain on the pad never becomes idle (its tile pool is full and a
 * few hundred uploads wait for a slot for ever: request app-integration-7), so after a minute the frame is measured
 * as it is, with the busy features and the terrain's counters recorded beside the numbers.
 */
async function settle(page: Page): Promise<{ idle: boolean; busy: string[]; terrain: unknown; loading: string }> {
  // How long the loading screen was up and what each step took (performance.now() of the page, s).
  const loading = await page.evaluate(() => {
    const r = window.__app!.loading();
    const s = (x: number | null): string => (x === null ? '-' : (x / 1000).toFixed(1));
    return `${s(r.elapsedMs)} s to the revealed view: ${r.steps.map((x) => `${x.id} ${s(x.startMs)}-${s(x.endMs)}`).join(', ')}; pool full ${r.reveal?.terrain.poolFull}, ${r.reveal?.terrain.uploading} tiles waiting, level ${r.reveal?.terrain.levelUnderVehicle} under the vehicle`;
  });
  let idle = true;
  try {
    await waitIdle(page, 30, 60_000);
  } catch {
    idle = false;
    await page.evaluate(() => window.__test!.waitFrames(120));
  }
  return page.evaluate(({ i, l }) => ({ idle: i, busy: window.__app!.busyFeatures(), terrain: window.__app!.terrainStats().stream, loading: l }), { i: idle, l: loading });
}

/** Pad, then Z / T / Space and the climb from 200 m; the numbers go to out/app/perf-<label>.json. */
async function padAndClimb(page: Page, label: string): Promise<{ padStreaming: Awaited<ReturnType<typeof settle>>; checkpoints: Checkpoint[]; ignition: TraceSummary }> {
  const run = await withGpuLock(async () => {
    await openWithin(page, '/?scale=1&governor=off&mute=1', 300_000);
    await assertDiscreteGpu(page);
    const padStreaming = await settle(page);
    console.log(`${label} pad streaming: ${JSON.stringify(padStreaming)}`);
    const checkpoints: Checkpoint[] = [await measure(page, `${label} pad`)];
    const pad = await page.evaluate(() => window.__app!.brief());
    await page.evaluate(() => window.__app!.startCpuTrace(1500));
    await page.evaluate(() => window.__test!.waitFrames(60));
    for (const code of ['KeyZ', 'KeyT', 'Space']) {
      await page.keyboard.press(code);
      await page.evaluate(() => window.__test!.waitFrames(2));
    }
    await until(page, `b.milestones.includes('LIFTOFF') && b.altitudeAsl > ${pad.altitudeAsl + 200}`, 90_000);
    const ignition = summariseTrace(`${label} ignition and lift-off`, (await page.evaluate(() => window.__app!.takeCpuTrace()))!);
    checkpoints.push(await measure(page, `${label} climb`));
    return { padStreaming, checkpoints, ignition };
  });
  const dir = path.join(process.cwd(), 'out', 'app');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `perf-${label}.json`), JSON.stringify({ when: new Date().toISOString(), ...run }, null, 2));
  return run;
}

test.describe('1440p internal (the budget resolution)', () => {
  test.use({ viewport: { width: 2560, height: 1440 }, deviceScaleFactor: 1 });
  test('frame time at the pad and in the climb (ARCHITECTURE 17)', async ({ page }) => {
    const { checkpoints } = await padAndClimb(page, '1440p');
    for (const cp of checkpoints) {
      expect.soft(cp.median.gpuP99, `${cp.name}: GPU p99 (budget 11 ms)`).toBeLessThanOrEqual(11);
      expect.soft(cp.median.rafP99, `${cp.name}: rAF p99 (budget 17.5 ms)`).toBeLessThanOrEqual(17.5);
      expect.soft(cp.median.over33ms, `${cp.name}: frames of 33 ms or more`).toBe(0);
      expect.soft(cp.median.appCpuP99, `${cp.name}: main-thread frame p99 (budget 6 ms)`).toBeLessThanOrEqual(6);
    }
  });
});

test.describe('720p (comparison: what depends on the resolution)', () => {
  test.use({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
  test('frame time at the pad and in the climb, recorded only', async ({ page }) => {
    const { checkpoints } = await padAndClimb(page, '720p');
    expect(checkpoints).toHaveLength(2);
  });
});

test.describe('an engine burn away from terrain (1440p): what the slow main-thread frames are made of', () => {
  test.use({ viewport: { width: 2560, height: 1440 }, deviceScaleFactor: 1 });
  test('lunar orbit: coast, engine start, burn, cut-off', async ({ page }) => {
    const run = await withGpuLock(async () => {
      // 100 km lunar orbit with the lander stack: where the mission's LOI tail and the circularisation burns were slow.
      await openWithin(page, '/?scenario=qa-lunar-orbit&scale=1&governor=off&mute=1', 300_000);
      await assertDiscreteGpu(page);
      const streaming = await settle(page);
      console.log(`orbit streaming: ${JSON.stringify(streaming)}`);
      const coast = await measure(page, 'orbit coast');

      // A trace across the engine start, 6 s of burn and the cut-off.
      await page.evaluate(() => window.__app!.startCpuTrace(1500));
      await page.evaluate(() => window.__test!.waitFrames(200));
      await page.keyboard.press('KeyZ');
      try {
        await until(page, 'b.thrust > 0', 5_000);
      } catch {
        // The stage that holds the engine has not been fired in this scenario: fire it.
        await page.keyboard.press('Space');
        await until(page, 'b.thrust > 0', 20_000);
      }
      await page.evaluate(() => window.__test!.waitFrames(360));
      await page.keyboard.press('KeyX');
      await until(page, 'b.thrust === 0', 20_000);
      await page.evaluate(() => window.__test!.waitFrames(300));
      const trace = summariseTrace('orbit burn', (await page.evaluate(() => window.__app!.takeCpuTrace()))!);

      // Steady windows: burning, and after the burn. The cockpit's displays are painted in the chase view too:
      // what that costs (Canvas 2D painting, upload, mips), with the displays' pages as they are and with the
      // orbit page taken off its display.
      const mfd = async (name: string): Promise<{ name: string; pages: string[]; cockpit: unknown; perPaint: { paint: number; copy: number; mips: number }; paintsPerFrame: number }> => {
        const s = await page.evaluate(() => ({ pages: window.__app!.mfdPages(), cockpit: window.__app!.cockpitFrame(), stats: window.__app!.mfdPaintStats(true) }));
        const n = Math.max(1, s.stats?.paints ?? 0);
        const out = { name, pages: s.pages, cockpit: s.cockpit, perPaint: { paint: (s.stats?.paintMs ?? 0) / n, copy: (s.stats?.copyMs ?? 0) / n, mips: (s.stats?.mipMs ?? 0) / n }, paintsPerFrame: (s.stats?.paints ?? 0) / Math.max(1, s.stats?.frames ?? 0) };
        console.log(`${name}: displays ${out.pages.join(' / ')}, cockpit ${JSON.stringify(out.cockpit)}; ${out.paintsPerFrame.toFixed(2)} display paints per frame, mean per paint: Canvas 2D ${ms(out.perPaint.paint)} ms, upload ${ms(out.perPaint.copy)}, mips ${ms(out.perPaint.mips)}`);
        return out;
      };
      await mfd('before the burn windows (since boot)');
      await page.keyboard.press('KeyZ');
      await until(page, 'b.thrust > 0', 20_000);
      await page.evaluate(() => window.__test!.waitFrames(60));
      await page.evaluate(() => window.__app!.mfdPaintStats(true));
      const burn = await measure(page, 'orbit burn');
      const displays = [await mfd('orbit burn')];
      // Cycle every display that shows the orbit page to its next page and measure the same burn again.
      const pages = await page.evaluate(() => window.__app!.mfdPages());
      const keys = ['Digit9', 'Digit0', 'Minus'];
      for (let i = 0; i < pages.length; i++) {
        if (pages[i] !== 'orbit') continue;
        await page.keyboard.press(keys[i]!);
        await page.evaluate(() => window.__test!.waitFrames(4));
      }
      await page.evaluate(() => window.__app!.mfdPaintStats(true));
      const burnNoOrbit = await measure(page, 'orbit burn, no display on the orbit page');
      displays.push(await mfd('orbit burn, no display on the orbit page'));
      await page.keyboard.press('KeyX');
      await until(page, 'b.thrust === 0', 20_000);
      await page.evaluate(() => window.__app!.mfdPaintStats(true));
      const after = await measure(page, 'orbit after the burn');
      displays.push(await mfd('orbit after the burn'));
      return { streaming, checkpoints: [coast, burn, burnNoOrbit, after], trace, displays };
    });
    const dir = path.join(process.cwd(), 'out', 'app');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'perf-burn.json'), JSON.stringify({ when: new Date().toISOString(), ...run }, null, 2));
    expect(run.trace.thrustOn, 'the engine lit inside the trace').toBeGreaterThan(0);
    for (const cp of run.checkpoints) {
      expect.soft(cp.median.gpuP99, `${cp.name}: GPU p99 (budget 11 ms)`).toBeLessThanOrEqual(11);
      expect.soft(cp.median.appCpuP99, `${cp.name}: main-thread frame p99 (budget 6 ms)`).toBeLessThanOrEqual(6);
    }
  });
});
