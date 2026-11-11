/**
 * Reviewed screenshots of the ocean (out/screens/ocean): open ocean at 2 m in midday sun, at sunset with a
 * low sun path, under overcast probe lighting, from 150 m straight down, from 500 m, 3 km, 10 km, 30 km, 100 km and
 * LEO with glint, a shoreline with refraction and foam (from the beach, along it close to the water, and from 60 m
 * above it), the splashdown zone with a floating capsule-sized object, night under moonlight. The close-up, the
 * shore and the hand-over view are also taken at 2560 x 1440 (`<preset>-1440p`), the resolution the foam, the
 * shoreline and the far sheet are judged at. Every image is taken at the exposure the renderer's meter chooses
 * (the lab fixes it only at night) and asserted to be a real image with no HDR overflow or NaN.
 */
import { assertDiscreteGpu, assertRealImage, expect, expectNoErrors, openPage, saveScreenshot, test, waitIdle } from '../harness';

test.describe.configure({ timeout: 600_000 });

const ALL = ['midday', 'sunset', 'overcast', 'down150', 'alt500', 'alt3k', 'alt10k', 'alt30k', 'alt100k', 'leo', 'shore', 'shoreAlong', 'coast60', 'refraction', 'splash', 'night'];
const NATIVE = ['splash', 'shore', 'alt10k'];
const only = process.env.OCEAN_PRESETS?.split(',').filter(Boolean);

async function shoot(page: import('@playwright/test').Page, pageLog: { messages: string[] }, preset: string, name: string): Promise<void> {
  await openPage(page, `/labs/ocean/?preset=${preset}`);
  await assertDiscreteGpu(page);
  await page.evaluate(() => document.body.classList.add('shot'));
  // Let exposure adapt and TAA converge with live waves, then freeze presentation for the shot.
  await page.evaluate(() => window.__test!.waitFrames(90));
  await page.evaluate(() => window.__test!.setDeterministic(true));
  await waitIdle(page, 40);
  const hdr = await page.evaluate(() => window.__test!.hdrStats());
  const ev = await page.evaluate(() => window.__lab!.renderer.exposureInfo().ev100);
  console.log(`${name}: EV ${ev.toFixed(2)}, max luminance ${hdr.maxLuminance.toFixed(0)}`);
  const shot = await saveScreenshot(page, 'ocean', name);
  const dark = preset === 'night';
  assertRealImage(shot.stats, name, dark ? { minNonBlack: 0.01, minStd: 1, minBuckets: 10 } : { minNonBlack: 0.5, minStd: 6, minBuckets: 40 });
  expect(hdr.nanPixels).toBe(0);
  expect(hdr.maxLuminance).toBeLessThanOrEqual(60000);
  await expectNoErrors(page, pageLog);
}

for (const preset of only ?? ALL) {
  test(`ocean screenshot: ${preset}`, async ({ page, pageLog }) => {
    await shoot(page, pageLog, preset, preset);
  });
}

test.describe('native resolution', () => {
  test.use({ viewport: { width: 2560, height: 1440 } });
  for (const preset of (only ?? NATIVE).filter((p) => NATIVE.includes(p))) {
    test(`ocean screenshot at 1440p: ${preset}`, async ({ page, pageLog }) => {
      await shoot(page, pageLog, preset, `${preset}-1440p`);
    });
  }
});
