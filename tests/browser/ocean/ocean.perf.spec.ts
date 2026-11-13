/**
 * ARCHITECTURE 17.1, the ocean's line (GPU ms, p99 of timestamp queries, 1440p internal, qualityScale 1):
 * 0.8 at the pad, 0.9 at splashdown, 0.3 in the ascent (10-40 km), 0.1 in LEO. Brief: FFT under 0.3 ms, near pass
 * under 0.6 ms. Attribution mode (each hook in its own pass), governor off, a ballast of about 7 ms so the GPU
 * runs at the clock of a real frame (render-core hand-off 4.1).
 *
 * Every scene is asserted against its own line. Each runs six windows of 240 frames and reports the MEDIAN of
 * the windows' p99 (and p50), so one quiet or one disturbed window decides nothing. The near pass and the ocean's
 * total at the splashdown and at the coast do not meet their lines; they carry a bounded LEAD WAIVER (BudgetLine,
 * below), printed in every run beside the unchanged line.
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

/**
 * A line of the budget and, where the lead has granted one, its waiver (lead decision of 2026-11-12, hand-off
 * docs/handoff/ocean.md section 16.5). The line is NOT changed by a waiver: every run reports the scene against it.
 * While a waived line is not met, the test prints the waiver and holds the MEDIAN of the same number under the
 * waiver's ceiling instead (the numbers of the round-3 run plus 5 %; for the splashdown's whole ocean the line
 * itself, which its median meets: what stands above it there is the p99's stalls), so that a regression still
 * fails. The waivers end with the pipeline for the near patches and the quality scaling of the near pass; the
 * refracted bed and the shadow on the shelf are not to be dropped to meet the line (the same decision).
 */
interface BudgetLine {
  what: string;
  p99: number;
  p50: number;
  /** The line, ms (ARCHITECTURE_V1 17.1 and the brief). */
  line: number;
  /** The near pass's line is "under", the others "at most". */
  strict?: boolean;
  leadWaiver?: { until: string; ceiling: number };
}
const WAIVER_UNTIL = 'near-patch pipeline and quality scaling';

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

/**
 * Where the near pass's time goes: the water pass's median with one term switched off at a time
 * (OceanDebug.setProfileSkip), at the splashdown and above the coast. A measurement, no line of its own: it
 * says which term to cut when the budget test below fails. One window of 240 frames per switch.
 */
test('profile of the near pass: the cost of each term at the splashdown and above the coast', async ({ page, pageLog }) => {
  test.setTimeout(45 * 60_000);
  const TERMS: [string, number][] = [
    ['none (the pass as shipped)', 0],
    ['glitter cells', 1],
    ['foam (map, lace, relief, surf, wake, lap)', 2],
    ['refraction, bed and caustics', 4],
    ['vessel image', 8],
    ['seabed depth (march and plane)', 16],
    ['wave layers (cascades, capillaries, long waves)', 32],
    ['swell in the fragment', 64],
    ['sun shadow lookup', 128],
    ['cloud lookup', 256],
    ['ambient term (sky reflection, body)', 512],
    ['direct sun term', 1024],
    ['seabed depth in the vertex stage', 4096],
    ['sun shadow + cloud + ambient + direct sun', 128 + 256 + 512 + 1024],
    ['everything after the G-buffer reads', 2048],
  ];
  await withGpuLock(async () => {
    await openCalibrated(page, '/labs/ocean/?preset=splash&perf=features&scale=1&governor=off');
    const scene = async (name: string): Promise<void> => {
      const rows: string[] = [];
      let base = 0;
      for (const [label, mask] of TERMS) {
        const p50 = await page.evaluate(async (m) => {
          window.__ocean!.ocean!.debug.setProfileSkip(m);
          await window.__test!.waitFrames(30);
          window.__test!.resetPerf();
          await window.__test!.waitFrames(240);
          const ps = window.__lab!.renderer.passStats();
          const separate = ['ocean.fft', 'ocean.foam', 'ocean.wake', 'ocean.reactive', 'ocean.fieldBake'];
          return Object.entries(ps)
            .filter(([n]) => n.startsWith('ocean.') && !separate.includes(n))
            .reduce((a, [, v]) => a + v.p50, 0);
        }, mask);
        if (mask === 0) base = p50;
        rows.push(`  ${label}: ${p50.toFixed(3)} ms${mask === 0 ? '' : ` (the term: ${(base - p50).toFixed(3)})`}`);
      }
      await page.evaluate(() => window.__ocean!.ocean!.debug.setProfileSkip(0));
      // The forward pass's chunk without the paths a near pixel with its waves at full strength never takes (the
      // evaluated roughness field, the far-wave bank): what their presence in the shader costs such a pixel.
      await page.evaluate(() => window.__ocean!.ocean!.debug.setForwardProbe(true));
      await waitIdle(page, 30);
      const lean = await page.evaluate(async () => {
        window.__test!.resetPerf();
        await window.__test!.waitFrames(240);
        const ps = window.__lab!.renderer.passStats();
        const separate = ['ocean.fft', 'ocean.foam', 'ocean.wake', 'ocean.reactive', 'ocean.fieldBake'];
        return Object.entries(ps)
          .filter(([n]) => n.startsWith('ocean.') && !separate.includes(n))
          .reduce((a, [, v]) => a + v.p50, 0);
      });
      await page.evaluate(() => window.__ocean!.ocean!.debug.setForwardProbe(false));
      await waitIdle(page, 30);
      rows.push(`  probe, the forward chunk without the evaluated field and the far-wave bank: ${lean.toFixed(3)} ms (their presence: ${(base - lean).toFixed(3)})`);
      console.log(`near pass p50 with one term off, ${name}:\n${rows.join('\n')}`);
    };
    await scene('splashdown');
    await page.evaluate(() => {
      window.__ocean!.applyPreset('shore');
      window.__ocean!.setCamera({ north: 120, alt: 60, heading: 70, pitch: -8 });
    });
    await page.evaluate(() => window.__test!.waitFrames(60));
    await scene('coast 60 m');
    await expectNoErrors(page, pageLog);
  });
});

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
    expect(splash.fftP99).toBeLessThan(0.3);
    expect(coast.fftP99).toBeLessThan(0.3);
    // The lines (unchanged): splashdown 0.9 and the pad 0.8 for the whole ocean, 0.6 for the near pass; the ascent at
    // 10-40 km 0.3; LEO 0.1 (near field inactive: no compute, no draw). Four of them carry a lead waiver.
    const lines: BudgetLine[] = [
      { what: 'splashdown, near pass', p99: splash.waterP99, p50: splash.waterP50, line: 0.6, strict: true, leadWaiver: { until: WAIVER_UNTIL, ceiling: 0.73 } },
      { what: 'splashdown, ocean', p99: splash.oceanP99, p50: splash.oceanP50, line: 0.9, leadWaiver: { until: WAIVER_UNTIL, ceiling: 0.9 } },
      { what: 'coast 60 m, near pass', p99: coast.waterP99, p50: coast.waterP50, line: 0.6, strict: true, leadWaiver: { until: WAIVER_UNTIL, ceiling: 0.94 } },
      { what: 'coast 60 m, ocean', p99: coast.oceanP99, p50: coast.oceanP50, line: 0.8, leadWaiver: { until: WAIVER_UNTIL, ceiling: 1.03 } },
      { what: '10 km, ocean', p99: high.oceanP99, p50: high.oceanP50, line: 0.3 },
      { what: 'LEO, ocean', p99: leo.oceanP99, p50: leo.oceanP50, line: 0.1 },
    ];
    for (const l of lines) {
      const met = l.strict ? l.p99 < l.line : l.p99 <= l.line;
      if (met) {
        console.log(`line ${l.what}: ${l.p99.toFixed(3)} ms p99 against ${l.line} ms: met${l.leadWaiver ? ' (its lead waiver is not needed)' : ''}`);
        continue;
      }
      if (!l.leadWaiver) {
        expect(l.p99, `${l.what}: p99 against its line`).toBeLessThanOrEqual(l.line);
        continue;
      }
      console.log(
        `LEAD WAIVER (until: ${l.leadWaiver.until}) ${l.what}: the line of ${l.line} ms is NOT met (${l.p99.toFixed(3)} ms p99, ${l.p50.toFixed(3)} ms p50); ` +
          `waived while the p50 is at most ${l.leadWaiver.ceiling} ms`,
      );
      expect(l.p50, `${l.what}: the line of ${l.line} ms is not met; p50 against the ceiling of its lead waiver`).toBeLessThanOrEqual(l.leadWaiver.ceiling);
    }
    await expectNoErrors(page, pageLog);
  });
});
