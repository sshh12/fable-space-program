/** Temporary diagnosis of round 2 (removed before the hand-off): debug views of the surf zone. */
import { assertDiscreteGpu, openPage, saveScreenshot, test, waitIdle } from '../harness';

test.describe.configure({ timeout: 600_000 });

for (const preset of ['coast60', 'shoreAlong']) {
  test(`diag: ${preset}`, async ({ page }) => {
    await openPage(page, `/labs/ocean/?preset=${preset}`);
    await assertDiscreteGpu(page);
    await page.evaluate(() => document.body.classList.add('shot'));
    await page.evaluate(() => window.__test!.waitFrames(60));
    for (const view of ['foamMap', 'surf'] as const) {
      await page.evaluate((v) => window.__ocean!.ocean!.debug.setDebugView(v), view);
      await waitIdle(page, 12);
      await saveScreenshot(page, 'ocean', `diag-${preset}-${view}`);
    }
  });
}
