/**
 * The sea as the player sees it at the end of the flight, with every render package loaded (the integration lab on
 * the real tiles, real atmosphere and clouds, the real capsule under its parachutes): reviewed screenshots in
 * out/screens/ocean (`integrated-*`). The capsule of the FakeSim sinks at 8 m/s from 120 m; the first picture is
 * taken on the way down, the second with the heat shield at the water. A real image, no NaN, no errors.
 */
import { PNG } from 'pngjs';
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
  // The sea against the sky in that picture as a viewer of the PNG measures it (display-referred luminance of the
  // sRGB-decoded pixels; left and right thirds of the frame, the bands of the round-2 critique: the sky just above
  // the horizon, the sea just under it, the near water). Whatever the sky over the recovery zone is at the scene's
  // time, water is not brighter than the sky it lies under (overcast.spec.ts asserts it on the linear image).
  {
    const png = PNG.sync.read(low.buffer);
    const lin = (v: number): number => (v <= 10 ? v / 3294.6 : ((v / 255 + 0.055) / 1.055) ** 2.4);
    const band = (y0: number, y1: number): number => {
      let sum = 0;
      let n = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = 0; x < png.width; x++) {
          if (x > 0.3 * png.width && x < 0.7 * png.width) continue;
          const o = (y * png.width + x) * 4;
          sum += 0.2126 * lin(png.data[o]!) + 0.7152 * lin(png.data[o + 1]!) + 0.0722 * lin(png.data[o + 2]!);
          n++;
        }
      }
      return sum / n;
    };
    const s = png.height / 1440;
    const sky = band(Math.round(540 * s), Math.round(580 * s));
    const sea = band(Math.round(600 * s), Math.round(640 * s));
    const near = band(Math.round(1250 * s), Math.round(1400 * s));
    console.log(`integrated-capsule-at-the-water (display-referred): sky above the horizon Y ${sky.toFixed(3)}, sea under it Y ${sea.toFixed(3)} (${(sea / sky).toFixed(2)} x), near water Y ${near.toFixed(3)} (${(near / sky).toFixed(2)} x)`);
    expect(sea, 'the sea under the horizon against the sky above it (display-referred)').toBeLessThan(sky);
    expect(near, 'the near water against the sky above the horizon (display-referred)').toBeLessThan(sky);
  }
  // The sea from above the capsule, as the descent camera sees it.
  await frame(25, 55, 60, 2);
  await page.evaluate(() => window.__test!.waitFrames(60));
  await waitIdle(page, 30);
  await saveScreenshot(page, 'ocean', 'integrated-sea-from-above');
  await expectNoErrors(page, pageLog);
});
