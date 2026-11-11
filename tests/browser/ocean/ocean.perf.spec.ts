/**
 * ARCHITECTURE 17.1, the ocean's line (GPU ms, p99 of timestamp queries, 1440p internal, qualityScale 1):
 * 0.8 at the pad, 0.9 at splashdown, 0.3 in the ascent (10-40 km), 0.1 in LEO. Brief: FFT under 0.3 ms, near pass
 * under 0.6 ms. Attribution mode (each hook in its own pass), governor off, a ballast of about 7 ms so the GPU
 * runs at the clock of a real frame (render-core hand-off 4.1).
 *
 * Every scene is asserted against its own line. Each runs six windows of 240 frames and reports the MEDIAN of
 * the windows' p99 (and p50), so one quiet or one disturbed window decides nothing.
 *
 * The far sheet is shaded by the core's deferred lighting through this package's brdf_water override; that
 * share is not a pass of the ocean. It is measured here as the difference of 'core.lighting' with and without
 * the ocean feature (same scene, same page settings) and reported; it counts against the core's lighting line.
 */
import type { Page } from '@playwright/test';
import { assertDiscreteGpu, expect, expectNoErrors, openPage, saveScreenshot, test, waitIdle, withGpuLock } from '../harness';

test.use({ viewport: { width: 2560, height: 1440 } });

interface Row {
  oceanP99: number;
  oceanP50: number;
  fftP99: number;
  wakeP99: number;
  reactiveP99: number;
  waterP99: number;
  waterP50: number;
  lightingP99: number;
  lightingP50: number;
  patches: number;
  frameP99: number;
  ballast: number;
}

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : 0.5 * (s[m - 1]! + s[m]!);
};

/** Six windows of 240 frames; every number is the median over the windows. */
async function measure(page: Page): Promise<Row & { windows: string }> {
  const rows: Row[] = [];
  for (let w = 0; w < 6; w++) {
    rows.push(
      await page.evaluate(async (first) => {
        await window.__test!.waitFrames(first ? 90 : 10);
        window.__test!.resetPerf();
        await window.__test!.waitFrames(240);
        const ps = window.__lab!.renderer.passStats();
        const perf = window.__test!.perf()!;
        const p99 = (n: string): number => ps[n]?.p99 ?? 0;
        const separate = ['ocean.fft', 'ocean.foam', 'ocean.wake', 'ocean.reactive', 'ocean.fieldBake'];
        const water = Object.entries(ps).filter(([n]) => n.startsWith('ocean.') && !separate.includes(n));
        const ocean = Object.entries(ps).filter(([n]) => n.startsWith('ocean.'));
        return {
          oceanP99: perf.features['ocean']?.gpuMs ?? 0,
          oceanP50: ocean.reduce((a, [, v]) => a + v.p50, 0),
          fftP99: p99('ocean.fft'),
          wakeP99: p99('ocean.wake'),
          reactiveP99: p99('ocean.reactive'),
          // The near (water) pass: everything of the ocean's but its compute passes and the reactive mask.
          waterP99: water.reduce((a, [, v]) => a + v.p99, 0),
          waterP50: water.reduce((a, [, v]) => a + v.p50, 0),
          lightingP99: p99('core.lighting'),
          lightingP50: ps['core.lighting']?.p50 ?? 0,
          patches: perf.counters['ocean.patches'] ?? 0,
          frameP99: perf.gpu.p99,
          ballast: ps['lab-ballast.burn']?.p50 ?? 0,
        };
      }, w === 0),
    );
  }
  const keys = Object.keys(rows[0]!) as (keyof Row)[];
  const out = {} as Row;
  for (const k of keys) out[k] = median(rows.map((r) => r[k]));
  return { ...out, windows: rows.map((r) => `${r.oceanP99.toFixed(3)}/${r.waterP99.toFixed(3)}/${r.fftP99.toFixed(3)}`).join(' ') };
}

/** Open a lab page at 1440p and calibrate the ballast under load (render-core 4.1): about 7 ms. */
async function openCalibrated(page: Page, url: string): Promise<void> {
  await openPage(page, url);
  await assertDiscreteGpu(page);
  await waitIdle(page, 60);
  const size = await page.evaluate(() => window.__lab!.renderer.frameContext!.renderSize);
  expect(size).toEqual([2560, 1440]);
  const per = await page.evaluate(async () => {
    window.__ocean!.ballast.iterations = 400;
    await window.__test!.waitFrames(90);
    window.__test!.resetPerf();
    await window.__test!.waitFrames(60);
    return (window.__lab!.renderer.passStats()['lab-ballast.burn']?.p50 ?? 0) / 400;
  });
  expect(per).toBeGreaterThan(0);
  await page.evaluate((n) => (window.__ocean!.ballast.iterations = n), Math.round(7 / per));
}

const fmt = (r: Row & { windows: string }): string =>
  `ocean ${r.oceanP99.toFixed(3)} p99 / ${r.oceanP50.toFixed(3)} p50 ms (FFT ${r.fftP99.toFixed(3)}, wake ${r.wakeP99.toFixed(3)}, reactive ${r.reactiveP99.toFixed(3)}, water pass ${r.waterP99.toFixed(3)} p99 / ${r.waterP50.toFixed(3)} p50), core.lighting ${r.lightingP99.toFixed(3)} / ${r.lightingP50.toFixed(3)}, ${r.patches} patches, frame p99 ${r.frameP99.toFixed(2)} ms, ballast ${r.ballast.toFixed(2)} ms; windows ocean/water/fft p99: ${r.windows}`;

test('ocean GPU budget at 1440p: splashdown, pad-like coast, ascent at 10 km, LEO; the far-water share of lighting', async ({ page, pageLog }) => {
  test.setTimeout(45 * 60_000);
  await withGpuLock(async () => {
    await openCalibrated(page, '/labs/ocean/?preset=splash&perf=features&scale=1&governor=off');
    const splash = await measure(page);
    await saveScreenshot(page, 'ocean', 'perf-splash-1440p');
    await page.evaluate(() => {
      window.__ocean!.applyPreset('shore');
      // A camera above the coast at pad height, looking along the shore: the near field covers part of the view.
      window.__ocean!.setCamera({ north: 120, alt: 60, heading: 70, pitch: -8 });
    });
    const coast = await measure(page);
    await saveScreenshot(page, 'ocean', 'perf-coast-1440p');
    await page.evaluate(() => window.__ocean!.applyPreset('alt10k'));
    const high = await measure(page);
    await saveScreenshot(page, 'ocean', 'perf-10km-1440p');
    await page.evaluate(() => window.__ocean!.applyPreset('leo'));
    const leo = await measure(page);
    await expectNoErrors(page, pageLog);

    // The same far-water views without the ocean feature: the core's default brdf_water.
    await openCalibrated(page, '/labs/ocean/?preset=leo&ocean=0&perf=features&scale=1&governor=off');
    const leoBare = await measure(page);
    await page.evaluate(() => window.__ocean!.applyPreset('alt10k'));
    const highBare = await measure(page);

    console.log(`splashdown : ${fmt(splash)}`);
    console.log(`coast 60 m : ${fmt(coast)}`);
    console.log(`10 km      : ${fmt(high)}`);
    console.log(`LEO        : ${fmt(leo)}`);
    console.log(`10 km, no ocean feature: core.lighting ${highBare.lightingP99.toFixed(3)} p99 / ${highBare.lightingP50.toFixed(3)} p50`);
    console.log(`LEO, no ocean feature  : core.lighting ${leoBare.lightingP99.toFixed(3)} p99 / ${leoBare.lightingP50.toFixed(3)} p50`);
    console.log(
      `brdf_water override in core.lighting: LEO +${(leo.lightingP50 - leoBare.lightingP50).toFixed(3)} p50 / +${(leo.lightingP99 - leoBare.lightingP99).toFixed(3)} p99 ms; ` +
        `10 km +${(high.lightingP50 - highBare.lightingP50).toFixed(3)} p50 / +${(high.lightingP99 - highBare.lightingP99).toFixed(3)} p99 ms`,
    );

    expect(splash.ballast).toBeGreaterThan(5);
    // Splashdown (0.9) and the pad (0.8): the whole ocean, the FFT and the near pass.
    expect(splash.fftP99).toBeLessThan(0.3);
    expect(splash.waterP99).toBeLessThan(0.6);
    expect(splash.oceanP99).toBeLessThanOrEqual(0.9);
    expect(coast.fftP99).toBeLessThan(0.3);
    expect(coast.waterP99).toBeLessThan(0.6);
    expect(coast.oceanP99).toBeLessThanOrEqual(0.8);
    // Ascent, 10-40 km: 0.3.
    expect(high.oceanP99).toBeLessThanOrEqual(0.3);
    // LEO, near field inactive: no compute, no draw.
    expect(leo.oceanP99).toBeLessThanOrEqual(0.1);
    await expectNoErrors(page, pageLog);
  });
});
