import { assertDiscreteGpu, expect, expectNoErrors, openPage, test, waitIdle, withGpuLock } from '../harness';

test.use({ viewport: { width: 2560, height: 1440 } });

/**
 * A deliberately heavy pass (a fullscreen march whose step count scales with FrameContext.qualityScale)
 * pushes the frame far over the 11 ms GPU budget. The governor must lower qualityScale first, then the
 * internal resolution, and the frame must end up back at 60 fps.
 */
test('quality governor acts first, dynamic resolution second, and 60 fps is held under a heavy pass', async ({ page, pageLog }) => {
  test.setTimeout(20 * 60_000);
  await withGpuLock(async () => {
    await openPage(page, '/labs/render-core/?sun=110,32&hud=0&probe=heavy&heavy=0');
    await assertDiscreteGpu(page);
    await waitIdle(page, 120);
    // Calibrate: GPU cost of the heavy pass per iteration at full resolution and quality 1.
    const base = await page.evaluate(async () => {
      window.__test!.resetPerf();
      await window.__test!.waitFrames(300);
      const p = window.__test!.perf()!;
      return { gpu: p.gpu.p50, raf: p.raf };
    });
    const perIteration = await page.evaluate(async () => {
      window.__rc!.probes.setHeavy(40);
      await window.__test!.waitFrames(40);
      const s = window.__lab!.renderer.passStats()['lab-heavy.burn'];
      // The governor may already have reacted; use the largest sample of the window.
      return (s?.p99 ?? 0) / 40;
    });
    expect(perIteration).toBeGreaterThan(0);
    // Target: 4.5x the budget at quality 1, full resolution -> needs quality 0.5 AND a lower resolution.
    const iterations = Math.round((4.5 * 11) / perIteration);
    console.log(`baseline GPU ${base.gpu.toFixed(2)} ms, rAF p50 ${base.raf.p50.toFixed(2)} p95 ${base.raf.p95.toFixed(2)} ms (the display cadence of this run); heavy pass ${perIteration.toFixed(4)} ms per iteration -> ${iterations} iterations (about ${(iterations * perIteration).toFixed(0)} ms at quality 1, scale 1)`);

    // Let it recover fully, then apply the load and record the governor's trajectory.
    await page.evaluate(() => window.__rc!.probes.setHeavy(0));
    await page.waitForFunction(() => window.__test!.perf()!.qualityScale === 1 && window.__test!.perf()!.renderScale === 1, undefined, { timeout: 120_000 });
    const trace = await page.evaluate(async (n) => {
      const out: { q: number; s: number; gpu: number }[] = [];
      window.__rc!.probes.setHeavy(n);
      for (let i = 0; i < 700; i++) {
        await window.__test!.waitFrames(1);
        const p = window.__test!.perf()!;
        out.push({ q: p.qualityScale, s: p.renderScale, gpu: p.passes['lab-heavy.burn']?.gpuMs ?? 0 });
      }
      window.__test!.resetPerf();
      await window.__test!.waitFrames(300);
      const p = window.__test!.perf()!;
      return { out, settled: { q: p.qualityScale, s: p.renderScale, gpu: p.gpu, raf: p.raf } };
    }, iterations);

    const firstQuality = trace.out.findIndex((t) => t.q < 1);
    const firstScale = trace.out.findIndex((t) => t.s < 1);
    console.log(`governor: quality first lowered at frame ${firstQuality}, resolution at frame ${firstScale}; settled at quality ${trace.settled.q.toFixed(2)}, scale ${trace.settled.s.toFixed(3)}`);
    console.log(`settled: GPU p50 ${trace.settled.gpu.p50.toFixed(2)} p99 ${trace.settled.gpu.p99.toFixed(2)} ms; rAF p50 ${trace.settled.raf.p50.toFixed(2)} p95 ${trace.settled.raf.p95.toFixed(2)} p99 ${trace.settled.raf.p99.toFixed(2)} ms, frames over 33 ms: ${trace.settled.raf.over33ms} of ${trace.settled.raf.count}`);
    // Governor first: quality reaches its minimum before the resolution is touched.
    expect(firstQuality).toBeGreaterThanOrEqual(0);
    expect(firstScale).toBeGreaterThan(firstQuality);
    expect(trace.out[firstScale - 1]!.q).toBeCloseTo(0.5, 5);
    expect(trace.settled.q).toBeCloseTo(0.5, 5);
    expect(trace.settled.s).toBeLessThan(1);
    expect(trace.settled.s).toBeGreaterThanOrEqual(0.5);
    // 60 fps held: GPU inside the budget, vsync intervals not doubled.
    expect(trace.settled.gpu.p99).toBeLessThanOrEqual(11);
    // The frame cadence is the same as without the load (17.5 ms is the budget on a 60 Hz display; the
    // cadence of the test browser itself is measured above and may sit slightly off 16.67 ms).
    expect(trace.settled.raf.p95).toBeLessThan(Math.max(17.5, base.raf.p95 + 0.5));
    expect(trace.settled.raf.over33ms).toBe(0);

    // Remove the load: resolution and quality come back (hysteresis: resolution first).
    await page.evaluate(() => window.__rc!.probes.setHeavy(0));
    await page.waitForFunction(() => window.__test!.perf()!.qualityScale === 1 && window.__test!.perf()!.renderScale === 1, undefined, { timeout: 120_000 });
    await expectNoErrors(page, pageLog);
  });
});
