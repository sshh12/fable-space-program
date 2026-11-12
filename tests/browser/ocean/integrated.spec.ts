/**
 * The sea as the player sees it at the end of the flight, with every render package loaded (the integration lab on
 * the real tiles, real atmosphere and clouds, the real capsule under its parachutes): reviewed screenshots in
 * out/screens/ocean (`integrated-*`). The capsule of the FakeSim sinks at 8 m/s from 120 m; the first picture is
 * taken on the way down, the second with the heat shield at the water. A real image, no NaN, no errors.
 */
import { assertDiscreteGpu, assertRealImage, expect, expectNoErrors, saveScreenshot, test, waitIdle } from '../harness';
import { openIntegration } from '../integration/helpers';

test.describe.configure({ timeout: 900_000 });
test.use({ viewport: { width: 2560, height: 1440 } });

test('integrated: the capsule under its main chutes over the open sea, and at the water', async ({ page, pageLog }) => {
  const info = await openIntegration(page, 'scene=chutes&start=120&hud=0');
  await assertDiscreteGpu(page);
  test.skip(!info.loaded.includes('ocean'), 'the ocean package is not loaded in the integration lab');
  const frame = async (yaw: number, pitch: number, distance: number, along: number): Promise<void> => {
    await page.evaluate(
      ([y, p, d, a]) => {
        window.__integration!.orbitVesselPoint(y!, p!, d!, a!);
      },
      [yaw, pitch, distance, along] as const,
    );
  };
  // On the way down: the three canopies and the sea to the horizon.
  await frame(30, 8, 110, 25);
  await page.evaluate(() => window.__test!.waitFrames(120));
  await waitIdle(page, 30);
  const high = await saveScreenshot(page, 'ocean', 'integrated-chutes');
  assertRealImage(high.stats, 'integrated-chutes', { minNonBlack: 0.5, minStd: 6, minBuckets: 40 });
  // At the water: close to the capsule, a little above the swell.
  await page.evaluate(() => window.__test!.waitFrames(700));
  await frame(25, 6, 26, 2);
  await page.evaluate(() => window.__test!.waitFrames(60));
  await waitIdle(page, 30);
  const hdr = await page.evaluate(() => window.__test!.hdrStats());
  expect(hdr.nanPixels).toBe(0);
  const low = await saveScreenshot(page, 'ocean', 'integrated-capsule-at-the-water');
  assertRealImage(low.stats, 'integrated-capsule-at-the-water', { minNonBlack: 0.5, minStd: 6, minBuckets: 40 });
  // The sea from above the capsule, as the descent camera sees it.
  await frame(25, 55, 60, 2);
  await page.evaluate(() => window.__test!.waitFrames(60));
  await waitIdle(page, 30);
  await saveScreenshot(page, 'ocean', 'integrated-sea-from-above');
  await expectNoErrors(page, pageLog);
});
