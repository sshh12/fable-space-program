import type { Page } from '@playwright/test';
import { assertDiscreteGpu, assertRealImage, expect, expectNoErrors, openPage, saveScreenshot, test, type PageLog } from '../harness';

/**
 * Screenshots of every FakeSim scene with the full flight HUD at 1280 x 720 and 3840 x 2160, plus the
 * cockpit and map views, the key-help overlay, the mission-failed banner and the six MFD pages, saved to
 * out/screens/flight-ui/ for review by eye.
 */
const SCENES: [string, string][] = [
  ['pad', 'target=moon'],
  ['ascent', ''],
  ['lowOrbit', 'node=1'],
  ['translunar', ''],
  ['lunarOrbit', 'predicted=impact'],
  ['lunarSurface', ''],
  ['reentry', 'predicted=entry'],
  ['chutes', ''],
];

async function shoot(page: Page, log: PageLog, url: string, name: string, frames = 30): Promise<void> {
  await openPage(page, url);
  await assertDiscreteGpu(page);
  await page.evaluate((n) => window.__test!.waitFrames(n), frames);
  const shot = await saveScreenshot(page, 'flight-ui', name);
  assertRealImage(shot.stats, name, { minNonBlack: 0.05, minStd: 8, minBuckets: 40 });
  await expectNoErrors(page, log);
}

for (const [w, h, tag] of [
  [1280, 720, '720p'],
  [3840, 2160, '4k'],
] as const) {
  test.describe(`flight-ui screenshots ${tag}`, () => {
    test.use({ viewport: { width: w, height: h } });
    for (const [scene, extra] of SCENES) {
      test(`scene ${scene}`, async ({ page, pageLog }) => {
        await shoot(page, pageLog, `/labs/flight-ui/?scene=${scene}${extra ? `&${extra}` : ''}`, `${scene}-${tag}`);
        expect(await page.evaluate(() => window.__test!.page.name)).toBe('flight-ui');
      });
    }
    test('cockpit view', async ({ page, pageLog }) => {
      await shoot(page, pageLog, '/labs/flight-ui/?scene=lowOrbit&view=cockpit', `cockpit-lowOrbit-${tag}`);
    });
    test('map view', async ({ page, pageLog }) => {
      await shoot(page, pageLog, '/labs/flight-ui/?scene=lowOrbit&view=map&node=1', `map-lowOrbit-${tag}`);
    });
    test('key help overlay', async ({ page, pageLog }) => {
      await shoot(page, pageLog, '/labs/flight-ui/?scene=pad&help=1', `keyhelp-${tag}`);
    });
    test('mission failed banner', async ({ page, pageLog }) => {
      await shoot(page, pageLog, '/labs/flight-ui/?scene=reentry&failed=1', `failed-${tag}`);
    });
    test('terrain loading notice', async ({ page, pageLog }) => {
      await shoot(page, pageLog, '/labs/flight-ui/?scene=lunarSurface&terrainPending=1', `terrain-pending-${tag}`);
    });
    test('MFD pages', async ({ page, pageLog }) => {
      await shoot(page, pageLog, '/labs/flight-ui/?scene=lunarOrbit&mfd=1&predicted=impact&node=1', `mfd-pages-${tag}`, 10);
    });
  });
}
