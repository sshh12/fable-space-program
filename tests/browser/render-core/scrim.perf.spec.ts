/**
 * The cost of the UI scrim step (ARCHITECTURE 18.8; presentation-sweep acceptance): at most 0.1 ms of GPU
 * time with four rectangles, and nothing measurable with none.
 *
 * The scrim is part of the tonemap pass (`core.tonemap`), so its cost is the difference of that pass with
 * and without rectangles, at 1440p. Method as in core.perf.spec.ts: a ballast pass keeps the GPU at the clock
 * state of a real frame (an RTX 5090 with two milliseconds of work a frame slows its clock down and every
 * pass takes several times longer); the windows alternate (none, four, none, four, ...) so that a drift of the
 * machine falls on both alike, and the medians of the windows are compared. The four rectangles are a menu's:
 * together they cover 57 % of the frame, one of them with the widest blur.
 *
 * A third series has ONE rectangle WITHOUT AN AREA: it says what the step costs for being there at all. As
 * measured on 2026-11-17 (RTX 5090, 2560 x 1440): no rectangle 0.032 ms, four rectangles 0.109 ms (the scrim:
 * 0.077 ms), one rectangle of no area 0.104 ms. So the cost is that of having ANY rectangle, not of the area
 * covered: the compiled shader evaluates the taps of every slot for every pixel once the header is not zero
 * (the conditions inside the loop are flattened), and only the branch on the header is a real one.
 *
 * "Nothing measurable with none" has two parts. Here: a rectangle list that is empty and the default buffer
 * are the same pass (the shader takes one branch on the header), measured as two more series of windows whose
 * medians agree within the spread of the windows. Against the pass as it was before the scrim existed: the
 * budget gate (tests/browser/integration/budget.perf.spec.ts with BUDGET_COMPARE=1), whose rows did not move.
 *
 *   node tools/dev/heavy.mjs --class=gpu -- npx playwright test tests/browser/render-core/scrim.perf.spec.ts --project=perf
 */
import type { Page } from '@playwright/test';
import { assertDiscreteGpu, expect, expectNoErrors, openPage, saveScreenshot, test, waitIdle, withGpuLock } from '../harness';

test.use({ viewport: { width: 2560, height: 1440 } });

interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  cornerRadius: number;
  blur: number;
  dim: number;
  opacity: number;
}
interface LabPage {
  __lab: { setScrim(rects: Rect[] | null): void };
}

/** A menu at 2560 x 1440: a tall panel, two side panels and a small one; 57 % of the frame. */
const RECTS: Rect[] = [
  { x0: 80, y0: 120, x1: 880, y1: 1320, cornerRadius: 48, blur: 0.6, dim: 0.5, opacity: 1 },
  { x0: 1640, y0: 80, x1: 2480, y1: 480, cornerRadius: 32, blur: 0.3, dim: 1, opacity: 1 },
  { x0: 1640, y0: 600, x1: 2480, y1: 1360, cornerRadius: 80, blur: 1, dim: 0.7, opacity: 1 },
  { x0: 1040, y0: 1000, x1: 1520, y1: 1320, cornerRadius: 24, blur: 0.6, dim: 0.5, opacity: 0.5 },
];
const COVERED = RECTS.reduce((a, r) => a + (r.x1 - r.x0) * (r.y1 - r.y0), 0) / (2560 * 1440);

const median = (v: number[]): number => {
  const s = [...v].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2]! : 0.5 * (s[s.length / 2 - 1]! + s[s.length / 2]!);
};

/** The tonemap pass over one window of frames: its median and mean GPU time, ms. */
async function tonemapWindow(page: Page, rects: Rect[] | null, frames: number): Promise<{ p50: number; mean: number }> {
  return page.evaluate(
    async ([r, n]) => {
      (window as unknown as LabPage).__lab.setScrim(r);
      await window.__test!.waitFrames(30);
      window.__test!.resetPerf();
      await window.__test!.waitFrames(n);
      const t = window.__lab!.renderer.passStats()['core.tonemap'];
      if (!t) throw new Error('no core.tonemap pass in the statistics');
      return { p50: t.p50, mean: t.mean };
    },
    [rects, frames] as const,
  );
}

test('the UI scrim step: at most 0.1 ms of GPU time with four rectangles, nothing measurable with none', async ({ page, pageLog }) => {
  test.setTimeout(30 * 60_000);
  await withGpuLock(async () => {
    await openPage(page, '/labs/render-core/?sun=110,32&hud=0&perf=features&scale=1&governor=off&probe=heavy&heavy=0');
    await assertDiscreteGpu(page);
    await page.evaluate(() => window.__rc!.lookAt([0, 6, 1], 200, 28, 26));
    await waitIdle(page, 120);
    expect(await page.evaluate(() => window.__lab!.renderer.frameContext!.renderSize)).toEqual([2560, 1440]);

    // The ballast: about 7 ms a frame, as the game's frame.
    const perIteration = await page.evaluate(async () => {
      window.__rc!.probes.setHeavy(400);
      await window.__test!.waitFrames(90);
      window.__test!.resetPerf();
      await window.__test!.waitFrames(60);
      return (window.__lab!.renderer.passStats()['lab-heavy.burn']?.p50 ?? 0) / 400;
    });
    expect(perIteration).toBeGreaterThan(0);
    await page.evaluate((n) => window.__rc!.probes.setHeavy(n), Math.round(7 / perIteration));
    await page.evaluate(() => window.__test!.waitFrames(120));

    const WINDOWS = 8;
    const FRAMES = 180;
    const series: Record<'none' | 'four' | 'empty' | 'defaultAgain', { p50: number; mean: number }[]> = { none: [], four: [], empty: [], defaultAgain: [] };
    for (let k = 0; k < WINDOWS; k++) {
      series.none.push(await tonemapWindow(page, null, FRAMES));
      series.four.push(await tonemapWindow(page, RECTS, FRAMES));
      // One rectangle without an area (the step is entered and covers nothing), and the default again.
      series.empty.push(await tonemapWindow(page, [{ ...RECTS[0]!, opacity: 0, x1: RECTS[0]!.x0 }], FRAMES));
      series.defaultAgain.push(await tonemapWindow(page, null, FRAMES));
    }
    await page.evaluate((r) => (window as unknown as LabPage).__lab.setScrim(r), RECTS);
    await page.evaluate(() => window.__test!.waitFrames(8));
    await saveScreenshot(page, 'presentation-sweep', 'scrim-perf-1440p-four-panels');
    await page.evaluate(() => (window as unknown as LabPage).__lab.setScrim(null));

    const p50 = (k: keyof typeof series): number[] => series[k].map((w) => w.p50);
    const mean = (k: keyof typeof series): number[] => series[k].map((w) => w.mean);
    const spread = (v: number[]): number => Math.max(...v) - Math.min(...v);
    const none = median(p50('none'));
    const four = median(p50('four'));
    const again = median(p50('defaultAgain'));
    const empty = median(p50('empty'));
    const fmt = (v: number[]): string => v.map((x) => x.toFixed(3)).join(' ');
    console.log(`core.tonemap at 2560 x 1440, ${WINDOWS} windows of ${FRAMES} frames each, GPU ms (median of a window; the rectangles cover ${(COVERED * 100).toFixed(0)} % of the frame):`);
    console.log(`  no rectangle        ${fmt(p50('none'))}   median ${none.toFixed(4)}  (means: median ${median(mean('none')).toFixed(4)})`);
    console.log(`  four rectangles     ${fmt(p50('four'))}   median ${four.toFixed(4)}  (means: median ${median(mean('four')).toFixed(4)})`);
    console.log(`  one of no area      ${fmt(p50('empty'))}   median ${empty.toFixed(4)}`);
    console.log(`  no rectangle again  ${fmt(p50('defaultAgain'))}   median ${again.toFixed(4)}`);
    console.log(`  the scrim with four rectangles costs ${(four - none).toFixed(4)} ms (by the means: ${(median(mean('four')) - median(mean('none'))).toFixed(4)} ms); two series without a rectangle differ by ${(again - none).toFixed(4)} ms; spread of the windows without ${spread(p50('none')).toFixed(4)} ms`);

    expect(four - none, 'GPU time of the scrim step with four rectangles, ms').toBeLessThanOrEqual(0.1);
    expect(median(mean('four')) - median(mean('none')), 'the same by the windows’ means, ms').toBeLessThanOrEqual(0.1);
    // With none: the two series without a rectangle agree as two measurements of one thing do.
    expect(Math.abs(again - none), 'two series without a rectangle, ms').toBeLessThanOrEqual(Math.max(0.01, spread(p50('none'))));
  });
  await expectNoErrors(page, pageLog);
});
