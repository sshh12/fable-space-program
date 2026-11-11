/**
 * Reviewed screenshots of the cockpit interior (out/screens/cockpit): every view the brief lists, from the
 * commander's seat, plus close-ups and the chase camera looking in through a window.
 */
import type { Page } from '@playwright/test';
import { assertDiscreteGpu, assertRealImage, expect, expectNoErrors, openPage, saveScreenshot, test, waitIdle } from '../harness';

test.use({ viewport: { width: 1600, height: 900 } });

async function settle(page: Page, frames = 90): Promise<void> {
  await waitIdle(page, 8);
  await page.evaluate(async (n) => {
    window.__test!.setDeterministic(true);
    await window.__test!.waitFrames(n);
  }, frames);
}

const shots: { name: string; url: string; setup?: (page: Page) => Promise<void>; dark?: boolean }[] = [
  { name: 'pad-noon-forward-window', url: 'scene=pad' },
  { name: 'leo-earth-side-window', url: 'scene=leo&look=-62,4' },
  { name: 'leo-sun-patch-console', url: 'scene=leo' },
  { name: 'night-displays-floods', url: 'scene=night', dark: true },
  { name: 'reentry-plasma', url: 'scene=reentry', dark: true },
  { name: 'moon-horizon', url: 'scene=moon' },
  { name: 'look-back-couches-hatch', url: 'scene=leo&look=118,-48' },
  { name: 'closeup-mfd', url: 'scene=leo&aim=mfd0&fov=24' },
  { name: 'closeup-fdai', url: 'scene=leo&aim=fdai&fov=22' },
  { name: 'closeup-switches', url: 'scene=leo&aim=switches&fov=26' },
  { name: 'chase-window', url: 'scene=leo&view=chase&window=fwd-left&distance=2.2&fov=45' },
];

for (const s of shots) {
  test(`screenshot ${s.name}`, async ({ page, pageLog }) => {
    test.setTimeout(240_000);
    await openPage(page, `/labs/cockpit/?${s.url}`, { timeoutMs: 120_000 });
    await assertDiscreteGpu(page);
    await settle(page);
    const shot = await saveScreenshot(page, 'cockpit', s.name);
    assertRealImage(shot.stats, s.name, s.dark ? { minNonBlack: 0.05, minStd: 3, minBuckets: 20 } : {});
    const st = await page.evaluate(() => window.__cockpit!.stats());
    expect(st.active).toBe(true);
    await expectNoErrors(page, pageLog);
  });
}
