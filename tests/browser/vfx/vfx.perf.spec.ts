import type { Page } from '@playwright/test';
import type {} from '../../../labs/vfx/main';
import { assertDiscreteGpu, expect, expectNoErrors, openPage, saveScreenshot, test, waitIdle, withGpuLock } from '../harness';

test.use({ viewport: { width: 2560, height: 1440 } });

interface Scenario {
  name: string;
  /** Budget of the brief: p99 of the feature's summed GPU time per frame, ms, at 1440p internal. */
  budget: number;
  query: string;
  /** Lab time at which the measurement starts; it runs for WINDOWS windows of WINDOW_FRAMES frames. */
  from: number;
}

const WINDOWS = 4;
const WINDOW_FRAMES = 110;

/**
 * Budgets of the brief (GPU ms at 1440p internal resolution, half-resolution volumes). Each scenario is
 * measured over a window of the running scene, in attribution mode (every hook of every feature in its own
 * timestamped pass), with the governor off and a ballast pass of about 7 ms that keeps the GPU as busy as
 * the game's frame does (an idle RTX 5090 clocks down; see tests/browser/render-core/core.perf.spec.ts).
 * The figure compared with the budget is PerfSnapshot.features.vfx.gpuMs: the 99th percentile of the sum of
 * all vfx passes of a frame.
 *
 * The scene is measured in four consecutive windows and EVERY window's p99 must be under the budget, and so
 * must the mean of the per-frame sums with a fifth to spare. withGpuLock keeps other PERF specs away, but
 * other agents' functional specs render on the same GPU while this runs, and a switch to another process
 * lands as a spike of 0.2 ms to several ms on whatever pass is in flight: a window that fails on a busy
 * machine while the mean is far below the budget is such a spike (PACKAGE_RULES 16: the number is then
 * provisional, to be re-measured on a quiet machine, not asserted away). All four windows are logged.
 */
const SCENARIOS: Scenario[] = [
  // Ignition at 1 s, lift-off at 4 s: nine plumes, pad smoke and steam at full production, ice, trail.
  // Three cameras: the pad camera, a chase camera whose frame the cloud fills, and one inside the cloud.
  { name: 'lift-off worst case', budget: 1.3, query: 'scene=pad', from: 3.5 },
  { name: 'lift-off from a chase camera at 150 m', budget: 1.3, query: 'scene=pad&dist=150', from: 3.5 },
  { name: 'lift-off from inside the cloud', budget: 1.3, query: 'scene=pad&dist=75&tz=12&pitch=0&yaw=0', from: 3.5 },
  { name: 'ascent', budget: 1.0, query: 'scene=ascent&altkm=12&speed=420&pad=0', from: 3 },
  { name: 'vacuum burn', budget: 0.6, query: 'scene=vacuum', from: 3.2 },
  { name: 'lunar descent with dust', budget: 0.9, query: 'scene=lunar&h=8', from: 3 },
  { name: 'reentry', budget: 1.2, query: 'scene=reentry&plasma=1', from: 3 },
  // Three mains above the capsule (in the frame), splash at about 2 s, canopies cut away 3 s later.
  { name: 'chutes and splash', budget: 0.9, query: 'scene=splash&dist=120&tz=30&pitch=2', from: 1.0 },
];

interface Measured {
  /** p99 of the per-frame vfx GPU time in each window, and the mean per frame over all windows (sum of the pass means). */
  windows: number[];
  mean: number;
  passes: Record<string, { p50: number; p99: number; mean: number }>;
  ballast: number;
  gpu: { p50: number; p99: number };
  cpu: { p50: number; p99: number };
  cpuVfx: number;
  qualityScale: number;
  renderScale: number;
  stats: Record<string, number>;
  /** Living particles at the end of the measurement (counted in a readback of the pool). */
  alive: number;
  size: [number, number];
}

async function run(page: Page, s: Scenario): Promise<Measured> {
  await openPage(page, `/labs/vfx/?${s.query}&paused=1&hud=0&perf=features&scale=1&governor=off`);
  await assertDiscreteGpu(page);
  await waitIdle(page, 60);
  // Ballast: measure the cost of one iteration, then ask for 7 ms.
  const perIteration = await page.evaluate(async () => {
    window.__vfx!.ballast.set(400);
    await window.__test!.waitFrames(90);
    window.__test!.resetPerf();
    await window.__test!.waitFrames(60);
    return (window.__lab!.renderer.passStats()['lab-ballast.burn']?.p50 ?? 0) / 400;
  });
  expect(perIteration).toBeGreaterThan(0);
  await page.evaluate((n) => window.__vfx!.ballast.set(n), Math.round(7 / perIteration));
  // Let the scene run in real time up to the window, then measure the window.
  await page.evaluate(() => window.__vfx!.app.setPaused(false));
  await page.waitForFunction((t) => window.__vfx!.sim.time >= t, s.from, { timeout: 120_000 });
  return page.evaluate(async ({ windows, frames }) => {
    const p99: number[] = [];
    let mean = 0;
    let perf = window.__test!.perf()!;
    let passes = window.__lab!.renderer.passStats();
    for (let w = 0; w < windows; w++) {
      window.__test!.resetPerf();
      await window.__test!.waitFrames(frames);
      perf = window.__test!.perf()!;
      passes = window.__lab!.renderer.passStats();
      p99.push(perf.features['vfx']!.gpuMs);
      for (const [n, v] of Object.entries(passes)) if (n.startsWith('vfx.')) mean += v.mean / windows;
    }
    window.__vfx!.app.setPaused(true);
    const pool = await window.__vfx!.feature.debug.readParticles();
    let alive = 0;
    for (let p = 7; p < pool.length; p += 24) if (pool[p]! > 0) alive++;
    return {
      alive,
      windows: p99,
      mean,
      passes: Object.fromEntries(Object.entries(passes).filter(([n]) => n.startsWith('vfx.'))),
      ballast: passes['lab-ballast.burn']?.p50 ?? 0,
      gpu: perf.gpu,
      cpu: perf.cpu,
      cpuVfx: perf.features['vfx']!.cpuMs,
      qualityScale: perf.qualityScale,
      renderScale: perf.renderScale,
      stats: window.__vfx!.feature.debug.stats(),
      size: window.__lab!.renderer.frameContext!.renderSize as [number, number],
    };
  }, { windows: WINDOWS, frames: WINDOW_FRAMES });
}

for (const s of SCENARIOS) {
  test(`vfx GPU budget at 1440p: ${s.name} < ${s.budget} ms`, async ({ page, pageLog }) => {
    test.setTimeout(30 * 60_000);
    await withGpuLock(async () => {
      const r = await run(page, s);
      await saveScreenshot(page, 'vfx', `perf-${s.name.replace(/[^a-z0-9]+/g, '-')}`);
      const worst = Math.max(...r.windows);
      const passes = Object.entries(r.passes)
        .filter(([, v]) => v.p99 > 0)
        .sort((a, b) => b[1].mean - a[1].mean)
        .map(([n, v]) => `${n.slice(4)} ${v.mean.toFixed(3)}/${v.p99.toFixed(3)}`)
        .join(', ');
      console.log(
        `${s.name} @ ${r.size.join('x')}: vfx p99 ${worst.toFixed(3)} ms in the worst of ${WINDOWS} windows (${r.windows.map((x) => x.toFixed(3)).join(', ')}), mean ${r.mean.toFixed(3)} ms (budget ${s.budget}); last window's passes mean/p99: ${passes}; ballast ${r.ballast.toFixed(1)} ms; frame GPU p50 ${r.gpu.p50.toFixed(2)} p99 ${r.gpu.p99.toFixed(2)} ms; ` +
          `vfx CPU p99 ${r.cpuVfx.toFixed(3)} ms; ${r.alive} particles alive; ${Object.entries(r.stats)
            .map(([k, v]) => `${k} ${Number.isInteger(v) ? v : v.toFixed(2)}`)
            .join(' ')}`,
      );
      expect(r.size).toEqual([2560, 1440]);
      expect(r.qualityScale).toBe(1);
      expect(r.renderScale).toBe(1);
      expect(r.ballast).toBeGreaterThan(5);
      expect(Math.min(...r.windows)).toBeGreaterThan(0);
      expect(r.mean, 'mean of the per-frame vfx GPU time').toBeLessThan(0.8 * s.budget);
      expect(worst, `p99 of every window (${r.windows.map((x) => x.toFixed(3)).join(', ')})`).toBeLessThan(s.budget);
      await expectNoErrors(page, pageLog);
    });
  });
}
