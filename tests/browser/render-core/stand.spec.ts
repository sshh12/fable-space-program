import { assertDiscreteGpu, assertRealImage, expect, expectNoErrors, openPage, saveScreenshot, test, waitIdle } from '../harness';

// The first navigation of a run compiles the page through Vite; on a loaded machine that alone can take a minute.
test.describe.configure({ timeout: 600_000 });

/** The test stand under a pinned sun: material sweep, shadow casters, emissive objects on the LabPlanet. */
test('stand renders with materials, emissive objects and no errors', async ({ page, pageLog }) => {
  await openPage(page, '/labs/render-core/?sun=120,40&hud=0');
  await assertDiscreteGpu(page);
  await page.evaluate(() => window.__test!.setDeterministic(true));
  await waitIdle(page, 30);
  const shot = await saveScreenshot(page, 'render-core', 'stand-overview');
  assertRealImage(shot.stats, 'stand-overview', { minNonBlack: 0.4, minStd: 15, minBuckets: 80 });
  const hdr = await page.evaluate(() => window.__test!.hdrStats());
  expect(hdr.nanPixels).toBe(0);
  expect(hdr.maxLuminance).toBeGreaterThan(0.05);
  await expectNoErrors(page, pageLog);
});
