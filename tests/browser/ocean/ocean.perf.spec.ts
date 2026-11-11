/**
 * ARCHITECTURE 17.1, the ocean's line (GPU ms, p99 of timestamp queries, 1440p internal, qualityScale 1):
 * 0.8 at the pad, 0.9 at splashdown, 0.1-0.3 with the near field inactive (ascent above fadeEnd, LEO,
 * reentry). Brief: FFT under 0.3 ms, near pass under 0.6 ms. Attribution mode (each hook in its own pass),
 * governor off, a ballast of about 7 ms so the GPU runs at the clock of a real frame (render-core hand-off
 * 4.1). The ocean's share of deferred lighting (brdf_water for the far sheet) is inside the core's line.
 */
import type { Page } from '@playwright/test';
import { assertDiscreteGpu, expect, expectNoErrors, openPage, saveScreenshot, test, waitIdle, withGpuLock } from '../harness';

test.use({ viewport: { width: 2560, height: 1440 } });

interface Row {
  oceanP99: number;
  waterP50: number;
  fftP99: number;
  wakeP99: number;
  reactiveP99: number;
  waterP99: number;
  patches: number;
  frameP99: number;
  ballast: number;
}

/**
 * Three windows of 240 frames; the least disturbed one counts. The GPU is shared with other agents' browser
 * tests (the GPU lock serialises perf specs only), and concurrent work can only add time to a pass.
 */
async function measure(page: Page): Promise<Row & { windows: string }> {
  const rows: Row[] = [];
  for (let w = 0; w < 3; w++) {
    rows.push(
      await page.evaluate(async (first) => {
        await window.__test!.waitFrames(first ? 90 : 10);
        window.__test!.resetPerf();
        await window.__test!.waitFrames(240);
        const ps = window.__lab!.renderer.passStats();
        const perf = window.__test!.perf()!;
        const p99 = (n: string): number => ps[n]?.p99 ?? 0;
        const separate = ['ocean.fft', 'ocean.wake', 'ocean.reactive'];
        return {
          oceanP99: perf.features['ocean']?.gpuMs ?? 0,
          fftP99: p99('ocean.fft'),
          wakeP99: p99('ocean.wake'),
          reactiveP99: p99('ocean.reactive'),
          // The near (water) pass: everything of the ocean's but its compute passes and the reactive mask.
          waterP99: Object.entries(ps)
            .filter(([n]) => n.startsWith('ocean.') && !separate.includes(n))
            .reduce((a, [, v]) => a + v.p99, 0),
          waterP50: Object.entries(ps)
            .filter(([n]) => n.startsWith('ocean.') && !separate.includes(n))
            .reduce((a, [, v]) => a + v.p50, 0),
          patches: perf.counters['ocean.patches'] ?? 0,
          frameP99: perf.gpu.p99,
          ballast: ps['lab-ballast.burn']?.p50 ?? 0,
        };
      }, w === 0),
    );
  }
  const best = rows.reduce((b, r) => (r.oceanP99 < b.oceanP99 ? r : b), rows[0]!);
  return { ...best, windows: rows.map((r) => `${r.oceanP99.toFixed(3)}/${r.waterP99.toFixed(3)}/${r.fftP99.toFixed(3)}`).join(' ') };
}

test('ocean GPU budget at 1440p: splashdown, pad-like coast, near field inactive', async ({ page, pageLog }) => {
  test.setTimeout(30 * 60_000);
  await withGpuLock(async () => {
    await openPage(page, '/labs/ocean/?preset=splash&perf=features&scale=1&governor=off');
    await assertDiscreteGpu(page);
    await waitIdle(page, 60);
    const size = await page.evaluate(() => window.__lab!.renderer.frameContext!.renderSize);
    expect(size).toEqual([2560, 1440]);
    // Calibrate the ballast under load (render-core 4.1): about 7 ms.
    const per = await page.evaluate(async () => {
      window.__ocean!.ballast.iterations = 400;
      await window.__test!.waitFrames(90);
      window.__test!.resetPerf();
      await window.__test!.waitFrames(60);
      return (window.__lab!.renderer.passStats()['lab-ballast.burn']?.p50 ?? 0) / 400;
    });
    expect(per).toBeGreaterThan(0);
    await page.evaluate((n) => (window.__ocean!.ballast.iterations = n), Math.round(7 / per));

    const splash = await measure(page);
    await saveScreenshot(page, 'ocean', 'perf-splash-1440p');
    await page.evaluate(() => {
      window.__ocean!.applyPreset('shore');
      // A camera above the coast at pad height, looking along the shore: the near field covers part of the view.
      window.__ocean!.setCamera({ north: 120, alt: 60, heading: 70, pitch: -8 });
    });
    const coast = await measure(page);
    await saveScreenshot(page, 'ocean', 'perf-coast-1440p');
    await page.evaluate(() => window.__ocean!.applyPreset('leo'));
    const leo = await measure(page);
    await page.evaluate(() => {
      window.__ocean!.applyPreset('alt10k');
    });
    const high = await measure(page);
    const fmt = (r: Row & { windows: string }): string =>
      `ocean ${r.oceanP99.toFixed(3)} ms (FFT ${r.fftP99.toFixed(3)}, wake ${r.wakeP99.toFixed(3)}, reactive ${r.reactiveP99.toFixed(3)}, water pass ${r.waterP99.toFixed(3)} p99 / ${r.waterP50.toFixed(3)} p50), ${r.patches} patches, frame p99 ${r.frameP99.toFixed(2)} ms, ballast ${r.ballast.toFixed(2)} ms; windows ocean/water/fft p99: ${r.windows}`;
    console.log(`splashdown : ${fmt(splash)}`);
    console.log(`coast 60 m : ${fmt(coast)}`);
    console.log(`10 km      : ${fmt(high)}`);
    console.log(`LEO        : ${fmt(leo)}`);
    expect(splash.ballast).toBeGreaterThan(5);
    expect(splash.fftP99).toBeLessThan(0.3);
    expect(splash.waterP99).toBeLessThan(0.6);
    expect(splash.oceanP99).toBeLessThanOrEqual(0.9);
    expect(coast.oceanP99).toBeLessThanOrEqual(0.8);
    expect(high.oceanP99).toBeLessThanOrEqual(0.9);
    // Near field inactive: no compute, no draw.
    expect(leo.oceanP99).toBeLessThanOrEqual(0.1);
    await expectNoErrors(page, pageLog);
  });
});
