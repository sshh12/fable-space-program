/**
 * Reviewed screenshots of the ocean (out/screens/ocean): open ocean at 2 m in midday sun, at sunset with a
 * low sun path, under overcast probe lighting, from 500 m, 3 km, 10 km, 30 km, 100 km and LEO with glint, a
 * shoreline with refraction and foam (from the beach and along it close to the water), the splashdown zone with a
 * floating capsule-sized object, night under moonlight. Every image is asserted to be a real image with no HDR
 * overflow or NaN.
 */
import { assertDiscreteGpu, assertRealImage, expect, expectNoErrors, openPage, saveScreenshot, test, waitIdle } from '../harness';

test.describe.configure({ timeout: 600_000 });

const ALL = ['midday', 'sunset', 'overcast', 'alt500', 'alt3k', 'alt10k', 'alt30k', 'alt100k', 'leo', 'shore', 'shoreAlong', 'refraction', 'splash', 'night'];
const only = process.env.OCEAN_PRESETS?.split(',').filter(Boolean);

for (const preset of only ?? ALL) {
  test(`ocean screenshot: ${preset}`, async ({ page, pageLog }) => {
    await openPage(page, `/labs/ocean/?preset=${preset}`);
    await assertDiscreteGpu(page);
    await page.evaluate(() => document.body.classList.add('shot'));
    // Let exposure adapt and TAA converge with live waves, then freeze presentation for the shot.
    await page.evaluate(() => window.__test!.waitFrames(90));
    await page.evaluate(() => window.__test!.setDeterministic(true));
    await waitIdle(page, 40);
    const hdr = await page.evaluate(() => window.__test!.hdrStats());
    const shot = await saveScreenshot(page, 'ocean', preset);
    const dark = preset === 'night';
    assertRealImage(shot.stats, preset, dark ? { minNonBlack: 0.01, minStd: 1, minBuckets: 10 } : { minNonBlack: 0.5, minStd: 6, minBuckets: 40 });
    expect(hdr.nanPixels).toBe(0);
    expect(hdr.maxLuminance).toBeLessThanOrEqual(60000);
    await expectNoErrors(page, pageLog);
  });
}
