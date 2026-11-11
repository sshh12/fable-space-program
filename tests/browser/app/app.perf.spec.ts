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
 * Output: out/app/perf-1440p.json, out/app/perf-720p.json.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import type { AppBrief } from '../../../src/app/testHooks';
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
  qualityScale: number;
  renderScale: number;
}

interface Checkpoint {
  name: string;
  altitudeStart: number;
  altitudeEnd: number;
  windows: WindowSample[];
  median: { rafP99: number; rafMax: number; over33ms: number; gpuP50: number; gpuP99: number; appCpuP99: number; coreCpuP99: number; features: Record<string, number>; featuresCpu: Record<string, number>; stages: Record<string, number> };
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
          qualityScale: p.qualityScale,
          renderScale: p.renderScale,
        };
      }, WINDOW_FRAMES),
    );
  }
  const altitudeEnd = (await page.evaluate(() => window.__app!.brief())).altitudeAsl;
  const featureIds = [...new Set(windows.flatMap((w) => Object.keys(w.features)))];
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
      appCpuP99: median(windows.map((w) => w.appCpu.p99)),
      coreCpuP99: median(windows.map((w) => w.coreCpu.p99)),
      features: Object.fromEntries(featureIds.map((id) => [id, median(windows.map((w) => w.features[id] ?? 0))])),
      featuresCpu: Object.fromEntries(featureIds.map((id) => [id, median(windows.map((w) => w.featuresCpu[id] ?? 0))])),
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
  return cp;
}

async function until(page: Page, predicate: string, timeout: number): Promise<AppBrief> {
  await page.waitForFunction(`(() => { const b = window.__app.brief(); return ${predicate}; })()`, undefined, { polling: 100, timeout });
  return page.evaluate(() => window.__app!.brief());
}

/**
 * Wait for streaming to finish; at 1440p the terrain on the pad never becomes idle (its tile pool is full and a
 * few hundred uploads wait for a slot for ever: request app-integration-7), so after a minute the frame is measured
 * as it is, with the busy features and the terrain's counters recorded beside the numbers.
 */
async function settle(page: Page): Promise<{ idle: boolean; busy: string[]; terrain: unknown }> {
  let idle = true;
  try {
    await waitIdle(page, 30, 60_000);
  } catch {
    idle = false;
    await page.evaluate(() => window.__test!.waitFrames(120));
  }
  return page.evaluate((i) => ({ idle: i, busy: window.__app!.busyFeatures(), terrain: window.__app!.terrainStats().stream }), idle);
}

/** Pad, then Z / T / Space and the climb from 200 m; the numbers go to out/app/perf-<label>.json. */
async function padAndClimb(page: Page, label: string): Promise<{ padStreaming: Awaited<ReturnType<typeof settle>>; checkpoints: Checkpoint[] }> {
  const run = await withGpuLock(async () => {
    await openPage(page, '/?capture=0&scale=1&governor=off&mute=1', { timeoutMs: 240_000 });
    await assertDiscreteGpu(page);
    const padStreaming = await settle(page);
    console.log(`${label} pad streaming: ${JSON.stringify(padStreaming)}`);
    const checkpoints: Checkpoint[] = [await measure(page, `${label} pad`)];
    const pad = await page.evaluate(() => window.__app!.brief());
    for (const code of ['KeyZ', 'KeyT', 'Space']) {
      await page.keyboard.press(code);
      await page.evaluate(() => window.__test!.waitFrames(2));
    }
    await until(page, `b.milestones.includes('LIFTOFF') && b.altitudeAsl > ${pad.altitudeAsl + 200}`, 90_000);
    checkpoints.push(await measure(page, `${label} climb`));
    return { padStreaming, checkpoints };
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
