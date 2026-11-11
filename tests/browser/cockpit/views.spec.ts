/**
 * Reviewed screenshots of the cockpit interior (out/screens/cockpit): every view the brief lists, from the
 * commander's seat, plus close-ups and the chase camera looking in through a window.
 */
import type { Page } from '@playwright/test';
import { assertDiscreteGpu, assertRealImage, expect, expectNoErrors, openPage, saveScreenshot, test, waitIdle } from '../harness';

test.use({ viewport: { width: 1600, height: 900 } });

/** Deterministic frames until the exposure has adapted (it moves 0.8 EV/s toward darker scenes) and TAA has converged. */
async function settle(page: Page, frames = 60): Promise<void> {
  await waitIdle(page, 8);
  await page.evaluate(() => window.__test!.setDeterministic(true));
  await page.waitForFunction(
    async () => {
      await window.__test!.waitFrames(30);
      const e = window.__cockpit!.debug().exposure;
      return Math.abs(e.ev100 - e.targetEv100) < 0.05;
    },
    undefined,
    { timeout: 120_000, polling: 100 },
  );
  await page.evaluate((n) => window.__test!.waitFrames(n), frames);
}

const shots: { name: string; url: string; setup?: (page: Page) => Promise<void>; dark?: boolean }[] = [
  { name: 'pad-noon-forward-window', url: 'scene=pad' },
  { name: 'leo-earth-side-window', url: 'scene=leo&look=-62,4' },
  { name: 'leo-sun-patch-console', url: 'scene=leo' },
  { name: 'night-displays-floods', url: 'scene=night', dark: true },
  { name: 'reentry-plasma', url: 'scene=reentry', dark: true },
  { name: 'moon-horizon', url: 'scene=moon' },
  { name: 'look-back-couches-hatch', url: 'scene=leo&look=104,-30&fov=85' },
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
