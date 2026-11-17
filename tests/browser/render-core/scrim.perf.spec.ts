/**
 * The cost of the UI scrim step (ARCHITECTURE 18.8; RENDER_API 19.3; finding 12 of the presentation sweep's
 * review): the tonemap pass (`core.tonemap`, GPU timestamps) at 2560 x 1440, drawn three ways in ONE run on
 * one page, the windows alternating so that a drift of the machine falls on all alike:
 *
 *   before   TONEMAP_BASE_WGSL alone: the pass as it was before the scrim existed (the text of 038cf6f)
 *   sweep    TONEMAP_WGSL in one draw over the whole frame: the pass as the presentation sweep made it (9c6d674)
 *   now      the pass as it runs: the pass without the scrim, then the scrim shader inside the scissors of
 *            the published rectangles (Tonemap.draw)
 *
 * each with no rectangle, one rectangle without an area, one rectangle over 5 % of the frame and one over
 * 40 %; the last two also with a menu's four panels (57 %, the case of the 0.1 ms line of ARCHITECTURE) and
 * with one rectangle over the whole frame, where the pass as it runs takes the one draw again by itself (the
 * scissors forced are measured beside it). A rectangle over 60 % of the frame is measured both ways: that is
 * where SCRIM_SPLIT_MAX_SHARE puts the change from scissors to the one draw.
 *
 * Method as in core.perf.spec.ts: a ballast pass keeps the GPU at the clock state of a real frame (an RTX 5090
 * with two milliseconds of work a frame slows its clock down and every pass takes several times longer). A
 * window is FRAMES frames of one series; its p50 and p99 are the recorder's (`renderer.passStats()`); a series
 * is stated as the median of its windows' p50 and the median (and the largest) of its windows' p99.
 *
 * What is asserted is what the finding asked for: with no rectangle and with a rectangle without an area the
 * pass as it runs costs what the pass before the scrim costs (the same draw); a rectangle costs by its area
 * (5 % of the frame: a small share of what the sweep's pass paid for any rectangle); nothing costs more than
 * the sweep's pass did; and the menu's four panels stay under the 0.1 ms line.
 *
 *   node tools/dev/heavy.mjs --class=gpu --label=core-scrim -- npx playwright test tests/browser/render-core/scrim.perf.spec.ts --project=perf
 *
 * The table is also written to out/core-support/scrim/scrim-perf.json.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import type { UiScrimRect } from '../../../src/render/core/post/scrim';
import type { TonemapDrawInfo, TonemapPath } from '../../../src/render/core/post/tonemap';
import { assertDiscreteGpu, expect, expectNoErrors, openPage, saveScreenshot, test, waitIdle, withGpuLock } from '../harness';

const W = 2560;
const H = 1440;
test.use({ viewport: { width: W, height: H } });

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const panel = (x0: number, y0: number, x1: number, y1: number, cornerRadius: number, blur: number, dim: number, opacity = 1): UiScrimRect => ({ x0, y0, x1, y1, cornerRadius, blur, dim, opacity });
/** A menu at 2560 x 1440: a tall panel, two side panels and a small one; 57 % of the frame. */
const MENU: UiScrimRect[] = [panel(80, 120, 880, 1320, 48, 0.6, 0.5), panel(1640, 80, 2480, 480, 32, 0.3, 1), panel(1640, 600, 2480, 1360, 80, 1, 0.7), panel(1040, 1000, 1520, 1320, 24, 0.6, 0.5, 0.5)];
const CASES = {
  none: null,
  // One rectangle without an area (x1 = x0), fully faded in.
  noArea: [panel(80, 120, 80, 1320, 48, 0.6, 0.5)],
  // 480 x 384 = 5.0 % and 1536 x 960 = 40.0 % of 2560 x 1440.
  small: [panel(1040, 528, 1520, 912, 24, 0.6, 0.5)],
  large: [panel(512, 240, 2048, 1200, 48, 0.6, 0.5)],
  menu: MENU,
  // 1916 x 1150 = 59.8 % of the frame; its scissor (two pixels more each way) holds 59.9 %: just under the share
  // from which the pass takes the one draw.
  threeFifths: [panel(322, 145, 2238, 1295, 48, 0.6, 0.5)],
  whole: [panel(0, 0, W, H, 0, 0.6, 0.5)],
} satisfies Record<string, UiScrimRect[] | null>;
type Case = keyof typeof CASES;
const covered = (c: Case): number => (CASES[c] ?? []).reduce((a, r) => a + Math.max(0, r.x1 - r.x0) * Math.max(0, r.y1 - r.y0), 0) / (W * H);

/** The three ways the pass is drawn, by the names of the table. */
const PATHS = { before: 'base', sweep: 'single', now: 'auto', scissors: 'split' } satisfies Record<string, TonemapPath>;
type Way = keyof typeof PATHS;

interface Series {
  way: Way;
  rects: Case;
  /** What the pass must report having drawn in this series. */
  drawn: TonemapDrawInfo['drawn'];
}
const SERIES: Series[] = [
  ...(['none', 'noArea', 'small', 'large'] as const).flatMap((rects): Series[] => [
    { way: 'before', rects, drawn: 'base' },
    { way: 'sweep', rects, drawn: 'single' },
    { way: 'now', rects, drawn: rects === 'small' || rects === 'large' ? 'split' : 'base' },
  ]),
  { way: 'sweep', rects: 'menu', drawn: 'single' },
  { way: 'now', rects: 'menu', drawn: 'split' },
  { way: 'sweep', rects: 'threeFifths', drawn: 'single' },
  { way: 'now', rects: 'threeFifths', drawn: 'split' },
  { way: 'sweep', rects: 'whole', drawn: 'single' },
  { way: 'now', rects: 'whole', drawn: 'single' },
  { way: 'scissors', rects: 'whole', drawn: 'split' },
];
const key = (s: { way: Way; rects: Case }): string => `${s.way}/${s.rects}`;

const WINDOWS = 8;
const FRAMES = 180;
const SETTLE = 24;

const median = (v: number[]): number => {
  const s = [...v].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2]! : 0.5 * (s[s.length / 2 - 1]! + s[s.length / 2]!);
};

interface Timed {
  p50: number;
  p99: number;
  mean: number;
  drawn: string;
}
/** The tonemap pass over one window of frames of one series: the recorder's p50, p99 and mean, GPU ms. */
async function tonemapWindow(page: Page, s: Series): Promise<Timed> {
  return page.evaluate(
    async ([how, rects, settle, frames]) => {
      window.__lab!.setTonemapPath(how);
      window.__lab!.setScrim(rects);
      await window.__test!.waitFrames(settle);
      window.__test!.resetPerf();
      await window.__test!.waitFrames(frames);
      const t = window.__lab!.renderer.passStats()['core.tonemap'];
      if (!t) throw new Error('no core.tonemap pass in the statistics');
      return { p50: t.p50, p99: t.p99, mean: t.mean, drawn: window.__lab!.tonemapDraw()?.drawn ?? 'nothing' };
    },
    [PATHS[s.way], CASES[s.rects], SETTLE, FRAMES] as const,
  );
}

test('the tonemap pass before the scrim, as the sweep made it and as it runs: no rectangle costs nothing, a rectangle costs by its area', async ({ page, pageLog }) => {
  test.setTimeout(40 * 60_000);
  await withGpuLock(async () => {
    await openPage(page, '/labs/render-core/?sun=110,32&hud=0&perf=features&scale=1&governor=off&probe=heavy&heavy=0');
    await assertDiscreteGpu(page);
    await page.evaluate(() => window.__rc!.lookAt([0, 6, 1], 200, 28, 26));
    await waitIdle(page, 120);
    expect(await page.evaluate(() => window.__lab!.renderer.frameContext!.renderSize)).toEqual([W, H]);

    // Every pipeline of the three ways exists before anything is timed.
    for (const s of SERIES) {
      await page.evaluate(([how, rects]) => (window.__lab!.setTonemapPath(how), window.__lab!.setScrim(rects)), [PATHS[s.way], CASES[s.rects]] as const);
      await page.evaluate(() => window.__test!.waitFrames(4));
    }
    await waitIdle(page, 30);

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

    const windows = new Map<string, Timed[]>(SERIES.map((s) => [key(s), []]));
    for (let k = 0; k < WINDOWS; k++) {
      for (const s of SERIES) {
        const w = await tonemapWindow(page, s);
        expect(w.drawn, `${key(s)}: what the pass drew`).toBe(s.drawn);
        windows.get(key(s))!.push(w);
      }
    }
    const ballast = await page.evaluate(() => window.__lab!.renderer.passStats()['lab-heavy.burn']?.p50 ?? 0);
    await page.evaluate((r) => (window.__lab!.setTonemapPath('auto'), window.__lab!.setScrim(r)), MENU);
    await page.evaluate(() => window.__test!.waitFrames(8));
    await saveScreenshot(page, 'render-core', 'scrim-perf-1440p-four-panels');
    await page.evaluate(() => window.__lab!.setScrim(null));

    const stat = (way: Way, rects: Case): { p50: number; p99: number; p99Max: number; mean: number; spread: number; windows: Timed[] } => {
      const w = windows.get(key({ way, rects }));
      if (!w) throw new Error(`no series ${way}/${rects}`);
      const p50 = w.map((x) => x.p50);
      const p99 = w.map((x) => x.p99);
      return { p50: median(p50), p99: median(p99), p99Max: Math.max(...p99), mean: median(w.map((x) => x.mean)), spread: Math.max(...p50) - Math.min(...p50), windows: w };
    };
    const cell = (way: Way, rects: Case): string => {
      if (!windows.has(key({ way, rects }))) return '        -        ';
      const s = stat(way, rects);
      return `${s.p50.toFixed(4)} / ${s.p99.toFixed(4)}`;
    };
    console.log(`core.tonemap at ${W} x ${H}, GPU ms, p50 / p99 (medians of ${WINDOWS} alternating windows of ${FRAMES} frames; ballast ${ballast.toFixed(1)} ms a frame):`);
    console.log('  rectangles                   before the scrim    as the sweep made it  as it runs          scissors forced');
    for (const rects of Object.keys(CASES) as Case[]) {
      const label = `${rects} (${(100 * covered(rects)).toFixed(0)} %)`.padEnd(27);
      console.log(`  ${label}  ${cell('before', rects)}     ${cell('sweep', rects)}       ${cell('now', rects)}     ${cell('scissors', rects)}`);
    }
    for (const s of SERIES) {
      const t = stat(s.way, s.rects);
      console.log(`  ${key(s).padEnd(16)} p50 of the windows: ${t.windows.map((x) => x.p50.toFixed(4)).join(' ')} (spread ${t.spread.toFixed(4)}); p99: ${t.windows.map((x) => x.p99.toFixed(4)).join(' ')} (largest ${t.p99Max.toFixed(4)}); mean ${t.mean.toFixed(4)}`);
    }
    const dir = path.join(repoRoot, 'out', 'core-support', 'scrim');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'scrim-perf.json'),
      JSON.stringify({ at: new Date().toISOString(), size: [W, H], windows: WINDOWS, frames: FRAMES, ballastMs: ballast, covered: Object.fromEntries((Object.keys(CASES) as Case[]).map((c) => [c, covered(c)])), series: Object.fromEntries(SERIES.map((s) => [key(s), stat(s.way, s.rects)])) }, null, 1),
    );

    const before = stat('before', 'none');
    // Two measurements of one thing agree within the spread of their windows (at least a hundredth of a millisecond).
    const same = (a: { spread: number }, b: { spread: number }): number => Math.max(0.01, a.spread, b.spread);
    // No rectangle, and a rectangle without an area: the pass as it runs is the pass before the scrim.
    for (const rects of ['none', 'noArea'] as const) {
      const now = stat('now', rects);
      const ref = stat('before', rects);
      expect(Math.abs(now.p50 - ref.p50), `${rects}: the pass as it runs against the pass before the scrim, p50 ms`).toBeLessThanOrEqual(same(now, ref));
    }
    // A rectangle costs by its area: 5 % of the frame costs a small share of what the sweep's pass paid for it.
    const smallNow = stat('now', 'small').p50 - stat('before', 'small').p50;
    const smallSweep = stat('sweep', 'small').p50 - stat('before', 'small').p50;
    const largeNow = stat('now', 'large').p50 - stat('before', 'large').p50;
    const largeSweep = stat('sweep', 'large').p50 - stat('before', 'large').p50;
    console.log(`  the scrim over 5 % of the frame costs ${smallNow.toFixed(4)} ms (the sweep's pass: ${smallSweep.toFixed(4)}); over 40 %: ${largeNow.toFixed(4)} ms (the sweep's pass: ${largeSweep.toFixed(4)})`);
    expect(smallNow, 'the scrim over 5 % of the frame, ms').toBeLessThanOrEqual(Math.max(0.01, 0.25 * smallSweep));
    expect(largeNow, 'the scrim over 40 % of the frame against the sweep\'s pass, ms').toBeLessThanOrEqual(largeSweep + 0.005);
    expect(largeNow, 'the scrim over 40 % of the frame costs more than over 5 %').toBeGreaterThan(smallNow);
    // The line of ARCHITECTURE: a menu's four panels cost at most 0.1 ms.
    const menu = stat('now', 'menu').p50 - before.p50;
    console.log(`  a menu's four panels (57 %) cost ${menu.toFixed(4)} ms (the sweep's pass: ${(stat('sweep', 'menu').p50 - before.p50).toFixed(4)}); 60 % of the frame: ${(stat('now', 'threeFifths').p50 - before.p50).toFixed(4)} ms with scissors, ${(stat('sweep', 'threeFifths').p50 - before.p50).toFixed(4)} in the sweep's pass; the whole frame: ${(stat('now', 'whole').p50 - before.p50).toFixed(4)} ms as it runs, ${(stat('scissors', 'whole').p50 - before.p50).toFixed(4)} with the scissors forced, ${(stat('sweep', 'whole').p50 - before.p50).toFixed(4)} in the sweep's pass`);
    expect(menu, 'GPU time of the scrim step with four rectangles, ms').toBeLessThanOrEqual(0.1);
    expect(stat('now', 'menu').p50, 'four rectangles: the pass as it runs against the sweep\'s pass, ms').toBeLessThanOrEqual(stat('sweep', 'menu').p50 + 0.005);
    // At the share where the pass changes from scissors to the one draw, the scissors do not cost more than the one draw.
    expect(stat('now', 'threeFifths').p50, 'a rectangle over 60 % of the frame: with scissors against the one draw, ms').toBeLessThanOrEqual(stat('sweep', 'threeFifths').p50 + 0.003);
    // The whole frame: the pass takes the one draw, so it costs what the sweep's pass costs.
    expect(Math.abs(stat('now', 'whole').p50 - stat('sweep', 'whole').p50), 'the whole frame: the pass as it runs against the sweep\'s pass, ms').toBeLessThanOrEqual(same(stat('now', 'whole'), stat('sweep', 'whole')));
  });
  await expectNoErrors(page, pageLog);
});
