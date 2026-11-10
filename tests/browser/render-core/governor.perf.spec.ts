import type { Page } from '@playwright/test';
import { assertDiscreteGpu, expect, expectNoErrors, openPage, test, waitIdle, withGpuLock } from '../harness';

test.use({ viewport: { width: 2560, height: 1440 } });

const BUDGET_MS = 11;

interface BurnSample {
  /** p50 GPU time of the heavy pass over the window, ms. */
  ms: number;
  qualityScale: number;
  renderScale: number;
  /** Cost of the pass at quality 1 and scale 1: ms / (quality x scale^2). */
  fullMs: number;
}

/**
 * GPU time of the heavy pass over a window of 120 frames during which the governor changed neither the
 * quality nor the resolution, reduced to quality 1 and scale 1. The pass marches
 * iterations x qualityScale steps per pixel of the internal resolution, so its cost is proportional to
 * qualityScale x renderScale^2.
 */
async function burnAtSteadyState(page: Page): Promise<BurnSample> {
  return page.evaluate(async () => {
    const t = window.__test!;
    for (let attempt = 0; attempt < 8; attempt++) {
      await t.waitFrames(240);
      t.resetPerf();
      const states = new Set<string>();
      for (let i = 0; i < 120; i++) {
        await t.waitFrames(1);
        const p = t.perf()!;
        states.add(`${p.qualityScale}|${p.renderScale}`);
      }
      if (states.size !== 1) continue;
      const p = t.perf()!;
      const ms = window.__lab!.renderer.passStats()['lab-heavy.burn']?.p50 ?? 0;
      return { ms, qualityScale: p.qualityScale, renderScale: p.renderScale, fullMs: ms / (p.qualityScale * p.renderScale * p.renderScale) };
    }
    throw new Error('the governor did not hold one quality / resolution for 120 frames');
  });
}

/**
 * A deliberately heavy pass (a fullscreen march whose step count scales with FrameContext.qualityScale)
 * pushes the frame far over the 11 ms GPU budget. The governor must lower qualityScale first, then the
 * internal resolution, and the frame must end up back at 60 fps.
 *
 * The load is calibrated UNDER LOAD. A short burst on an otherwise idle GPU reads several times too slow
 * (the GPU clocks down when it has 1-2 ms of work per frame: hand-off section 4.1), which made the
 * "4.5 x budget" load of an earlier version of this spec anything from 7 to 50 ms.
 */
test('quality governor acts first, dynamic resolution second, and 60 fps is held under a heavy pass', async ({ page, pageLog }) => {
  test.setTimeout(25 * 60_000);
  await withGpuLock(async () => {
    await openPage(page, '/labs/render-core/?sun=110,32&hud=0&probe=heavy&heavy=0');
    await assertDiscreteGpu(page);
    await waitIdle(page, 120);
    const base = await page.evaluate(async () => {
      window.__test!.resetPerf();
      await window.__test!.waitFrames(300);
      const p = window.__test!.perf()!;
      return { gpu: p.gpu.p50, raf: p.raf };
    });

    // Calibrate: a load near the budget keeps the GPU busy; wait until the governor has settled on it.
    const CALIBRATION_ITERATIONS = 3000;
    await page.evaluate((n) => window.__rc!.probes.setHeavy(n), CALIBRATION_ITERATIONS);
    const cal = await burnAtSteadyState(page);
    const perIteration = cal.fullMs / CALIBRATION_ITERATIONS;
    expect(perIteration).toBeGreaterThan(0);
    // Target: 4.5x the budget at quality 1, full resolution -> needs quality 0.5 AND a lower resolution.
    const iterations = Math.round((4.5 * BUDGET_MS) / perIteration);
    console.log(
      `baseline GPU ${base.gpu.toFixed(2)} ms, rAF p50 ${base.raf.p50.toFixed(2)} p95 ${base.raf.p95.toFixed(2)} ms (the display cadence of this run); ` +
        `calibration under load: ${CALIBRATION_ITERATIONS} iterations take ${cal.ms.toFixed(2)} ms at quality ${cal.qualityScale.toFixed(2)}, scale ${cal.renderScale.toFixed(3)} ` +
        `-> ${perIteration.toFixed(5)} ms per iteration -> ${iterations} iterations for ${(4.5 * BUDGET_MS).toFixed(1)} ms at quality 1, scale 1`,
    );

    // Let it recover fully, then apply the load and record the governor's trajectory.
    await page.evaluate(() => window.__rc!.probes.setHeavy(0));
    await page.waitForFunction(() => window.__test!.perf()!.qualityScale === 1 && window.__test!.perf()!.renderScale === 1, undefined, { timeout: 180_000 });
    const trace = await page.evaluate(async (n) => {
      const out: { q: number; s: number }[] = [];
      window.__rc!.probes.setHeavy(n);
      for (let i = 0; i < 700; i++) {
        await window.__test!.waitFrames(1);
        const p = window.__test!.perf()!;
        out.push({ q: p.qualityScale, s: p.renderScale });
      }
      window.__test!.resetPerf();
      await window.__test!.waitFrames(300);
      const p = window.__test!.perf()!;
      return { out, settled: { q: p.qualityScale, s: p.renderScale, gpu: p.gpu, raf: p.raf } };
    }, iterations);

    // The load that was really applied, measured at the settled state: at least 4x the budget.
    const applied = await burnAtSteadyState(page);
    const firstQuality = trace.out.findIndex((t) => t.q < 1);
    const firstScale = trace.out.findIndex((t) => t.s < 1);
    console.log(`applied load: ${applied.ms.toFixed(2)} ms at quality ${applied.qualityScale.toFixed(2)}, scale ${applied.renderScale.toFixed(3)} = ${applied.fullMs.toFixed(1)} ms at quality 1, scale 1 (${(applied.fullMs / BUDGET_MS).toFixed(2)} x budget)`);
    console.log(`governor: quality first lowered at frame ${firstQuality}, resolution at frame ${firstScale}; settled at quality ${trace.settled.q.toFixed(2)}, scale ${trace.settled.s.toFixed(3)}`);
    console.log(`settled: GPU p50 ${trace.settled.gpu.p50.toFixed(2)} p99 ${trace.settled.gpu.p99.toFixed(2)} ms; rAF p50 ${trace.settled.raf.p50.toFixed(2)} p95 ${trace.settled.raf.p95.toFixed(2)} p99 ${trace.settled.raf.p99.toFixed(2)} ms, frames over 33 ms: ${trace.settled.raf.over33ms} of ${trace.settled.raf.count}`);
    expect(applied.fullMs).toBeGreaterThanOrEqual(4 * BUDGET_MS);
    // Governor first: quality reaches its minimum before the resolution is touched.
    expect(firstQuality).toBeGreaterThanOrEqual(0);
    expect(firstScale).toBeGreaterThan(firstQuality);
    expect(trace.out[firstScale - 1]!.q).toBeCloseTo(0.5, 5);
    expect(trace.settled.q).toBeCloseTo(0.5, 5);
    expect(trace.settled.s).toBeLessThan(1);
    expect(trace.settled.s).toBeGreaterThanOrEqual(0.5);
    // 60 fps held: GPU inside the budget, vsync intervals not doubled.
    expect(trace.settled.gpu.p99).toBeLessThanOrEqual(BUDGET_MS);
    // The frame cadence is the same as without the load (17.5 ms is the budget on a 60 Hz display; the
    // cadence of the test browser itself is measured above and may sit slightly off 16.67 ms).
    expect(trace.settled.raf.p95).toBeLessThan(Math.max(17.5, base.raf.p95 + 0.5));
    expect(trace.settled.raf.over33ms).toBe(0);

    // Remove the load: resolution and quality come back (hysteresis: resolution first).
    await page.evaluate(() => window.__rc!.probes.setHeavy(0));
    await page.waitForFunction(() => window.__test!.perf()!.qualityScale === 1 && window.__test!.perf()!.renderScale === 1, undefined, { timeout: 180_000 });
    await expectNoErrors(page, pageLog);
  });
});
