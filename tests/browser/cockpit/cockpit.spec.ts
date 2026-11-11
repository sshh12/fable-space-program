/**
 * Functional checks of the cockpit in the lab (real renderer, FakeSim with the Kestrel stack):
 *  - the interior is drawn from the seat with the three displays painting at 15 Hz, no errors;
 *  - CockpitControls: cyclePage walks every page and wraps; setPage shows up in 'ui.mfd' within 100 ms
 *    (read back from the texture: the accent underline sits under the new page's tab);
 *  - the lab forwards real key presses 9 / 0 / minus to cyclePage(0 / 1 / 2);
 *  - crew overlay: tunnel vision above the onset g in the interior view only; vibration under thrust;
 *  - the reduced detail level outside, and the full one inside.
 */
import type { Page } from '@playwright/test';
import { assertDiscreteGpu, expect, expectNoErrors, openPage, test, waitIdle } from '../harness';

test.use({ viewport: { width: 1280, height: 720 } });

const PAGES = ['flight', 'orbit', 'systems', 'staging', 'entry', 'landing'] as const;
// MFD header geometry of the shared painter (src/ui/mfd/mfdPainter.ts) at 1024 x 768: header height
// round(0.085 h), six tabs over 0.62 w, the active tab underlined in the accent colour just above the rule.
const W = 1024;
const H = 768;
const HH = Math.round(H * 0.085);
const TAB_W = (W * 0.62) / PAGES.length;
const UNDERLINE_Y = HH - 2;

async function open(page: Page, query: string): Promise<void> {
  await openPage(page, `/labs/cockpit/?${query}`, { timeoutMs: 120_000 });
  await assertDiscreteGpu(page);
  await waitIdle(page, 8);
}

/** Index of the tab whose underline is lit on display `layer` (-1 when none is). */
async function activeTab(page: Page, layer: number): Promise<number> {
  const px = await page.evaluate(([l, y, w]) => window.__cockpit!.mfdPixels(l, 0, y, w, 1), [layer, UNDERLINE_Y, Math.ceil(TAB_W * PAGES.length)] as const);
  let found = -1;
  for (let i = 0; i < PAGES.length; i++) {
    const x = Math.round(i * TAB_W + TAB_W / 2);
    const [r, g, b] = [px[x * 4]!, px[x * 4 + 1]!, px[x * 4 + 2]!];
    // Accent #55d4ff against the header panel #0b121b.
    if (b > 200 && g > 160 && r < 140) {
      expect(found, 'only one tab is underlined').toBe(-1);
      found = i;
    }
  }
  return found;
}

test('draws the interior from the seat, three displays painting at 15 Hz, no errors', async ({ page, pageLog }) => {
  test.setTimeout(240_000);
  await open(page, 'scene=leo');
  const geo = await page.evaluate(() => window.__cockpit!.geometry());
  expect(geo.triangles.lod0).toBeGreaterThan(50_000);
  expect(geo.windows).toBe(5);
  await page.evaluate(() => window.__cockpit!.resetDisplayStats());
  const t0 = await page.evaluate(() => performance.now());
  await page.waitForTimeout(3000);
  const st = await page.evaluate(() => window.__cockpit!.stats());
  const seconds = (await page.evaluate(() => performance.now())) - t0;
  expect(st.active).toBe(true);
  expect(st.inside).toBe(true);
  expect(st.lod).toBe('lod0');
  expect(st.layout).toBe('kestrel');
  const rate = st.displays.paints / 3 / (seconds / 1000);
  expect(rate, 'paints per display per second').toBeGreaterThan(11);
  expect(rate).toBeLessThan(16.5);
  // Staggered: never more than one display per frame except for page changes (none here).
  expect(st.displays.paints).toBeLessThanOrEqual(st.displays.frames);
  const dbg = await page.evaluate(() => window.__cockpit!.debug());
  expect(dbg.mfdDefault).toBe(false);
  expect(dbg.navballDefault).toBe(false);
  await expectNoErrors(page, pageLog);
});

test('cyclePage walks every page and wraps; setPage reaches ui.mfd within 100 ms', async ({ page, pageLog }) => {
  test.setTimeout(240_000);
  await open(page, 'scene=leo');
  for (let d = 0; d < 3; d++) {
    const start = await page.evaluate((i) => window.__cockpit!.page(i), d);
    const walk: string[] = [start];
    for (let k = 0; k < PAGES.length; k++) {
      await page.evaluate((i) => window.__cockpit!.cyclePage(i), d);
      walk.push(await page.evaluate((i) => window.__cockpit!.page(i), d));
    }
    const s = PAGES.indexOf(start as (typeof PAGES)[number]);
    expect(walk).toEqual([...PAGES.slice(s), ...PAGES.slice(0, s), start]);
  }
  for (const [display, p] of [
    [0, 'entry'],
    [1, 'landing'],
    [2, 'flight'],
    [0, 'staging'],
  ] as const) {
    // Timed in the page: from setPage to the frame whose GPU work wrote the new page into the texture.
    const ms = await page.evaluate(
      async ([i, pg]) => {
        const api = window.__cockpit!;
        const t0 = performance.now();
        api.setPage(i, pg);
        for (;;) {
          await new Promise((r) => requestAnimationFrame(() => r(null)));
          if (api.stats().painted[i]!.page === pg) break;
          if (performance.now() - t0 > 2000) return Infinity;
        }
        // One more frame: the copy is submitted with the frame that painted it.
        await window.__test!.waitFrames(1);
        return performance.now() - t0;
      },
      [display, p] as const,
    );
    expect(ms, `setPage(${display}, ${p}) -> ui.mfd`).toBeLessThan(100);
    expect(await activeTab(page, display)).toBe(PAGES.indexOf(p));
  }
  await expectNoErrors(page, pageLog);
});

test('the lab forwards real key presses 9, 0 and minus to cyclePage', async ({ page, pageLog }) => {
  test.setTimeout(240_000);
  await open(page, 'scene=leo');
  const before = await page.evaluate(() => [0, 1, 2].map((i) => window.__cockpit!.page(i)));
  await page.locator('canvas').first().click({ position: { x: 20, y: 20 } });
  await page.keyboard.press('9');
  await page.keyboard.press('0');
  await page.keyboard.press('0');
  await page.keyboard.press('Minus');
  const after = await page.evaluate(() => [0, 1, 2].map((i) => window.__cockpit!.page(i)));
  const step = (p: string, n: number): string => PAGES[(PAGES.indexOf(p as (typeof PAGES)[number]) + n) % PAGES.length]!;
  expect(after).toEqual([step(before[0]!, 1), step(before[1]!, 2), step(before[2]!, 1)]);
  expect(await page.evaluate(() => window.__cockpit!.keysSeen())).toEqual(['Digit9', 'Digit0', 'Digit0', 'Minus']);
  // The texture follows the keys.
  await page.evaluate(() => window.__test!.waitFrames(6));
  expect(await activeTab(page, 1)).toBe(PAGES.indexOf(after[1] as (typeof PAGES)[number]));
  await expectNoErrors(page, pageLog);
});

test('tunnel vision above the onset g in the interior view only; vibration under thrust', async ({ page, pageLog }) => {
  test.setTimeout(240_000);
  await open(page, 'scene=leo');
  expect((await page.evaluate(() => window.__cockpit!.stats())).tunnel).toBe(0);
  await page.evaluate(() => window.__cockpit!.set({ g: 9.5 }));
  // Low-pass with a 2.5 s time constant: after 6 s the filtered load is well above the 6 g onset.
  await page.waitForTimeout(6000);
  const t = (await page.evaluate(() => window.__cockpit!.stats())).tunnel;
  expect(t).toBeGreaterThan(0.2);
  expect(t).toBeLessThanOrEqual(1);
  await page.evaluate(() => window.__cockpit!.chase('fwd-left', 2.5));
  await page.evaluate(() => window.__test!.waitFrames(4));
  const outside = await page.evaluate(() => window.__cockpit!.stats());
  expect(outside.tunnel).toBe(0);
  expect(outside.inside).toBe(false);
  expect(outside.lod).toBe('lod0');
  await page.evaluate(() => window.__cockpit!.chase('fwd-left', 40));
  await page.evaluate(() => window.__test!.waitFrames(4));
  expect(['lod1', 'lod2']).toContain((await page.evaluate(() => window.__cockpit!.stats())).lod);
  await page.evaluate(() => {
    window.__cockpit!.cockpit();
    window.__cockpit!.set({ g: 1, throttle: 0 });
  });
  await page.evaluate(() => window.__test!.waitFrames(4));
  expect((await page.evaluate(() => window.__cockpit!.stats())).vibration).toBe(0);
  await page.evaluate(() => window.__cockpit!.set({ throttle: 1 }));
  await page.evaluate(() => window.__test!.waitFrames(10));
  const v = (await page.evaluate(() => window.__cockpit!.stats())).vibration;
  expect(v).toBeGreaterThan(1e-4);
  expect(v).toBeLessThanOrEqual(0.004);
  await expectNoErrors(page, pageLog);
});
