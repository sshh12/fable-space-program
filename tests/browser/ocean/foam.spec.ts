/**
 * Whitecap calibration: the near field's resolved foam (Jacobian folding with persistence, lace, breakup), averaged
 * over open ocean, covers what the far water's statistical whitecaps cover (brdf_water: Monahan &
 * O'Muircheartaigh 3.84e-6 U^3.41 x 0.4 for aged foam), so the foam does not change in amount where the near field
 * hands over to the far sheet. Measured with the foam debug view (coverage x 2000 cd/m^2) looking straight down from
 * 150 m (pixels of about 0.2 m: everything resolved) at nine planet-fixed places, frozen time.
 */
import { assertDiscreteGpu, expect, expectNoErrors, openPage, saveScreenshot, test, waitIdle } from '../harness';

test.describe.configure({ timeout: 600_000 });

test('resolved whitecap coverage matches the statistical coverage of the far water', async ({ page, pageLog }) => {
  await openPage(page, '/labs/ocean/?preset=midday&governor=off&scale=1');
  await assertDiscreteGpu(page);
  await page.evaluate(() => {
    window.__test!.setPaused(true);
    window.__test!.setDeterministic(true);
    window.__lab!.renderer.setJitter(false);
    window.__lab!.renderer.setExposureOverride(12);
    window.__ocean!.ocean!.debug.setDebugView('foam');
    document.body.classList.add('shot');
  });
  const samples: number[] = [];
  for (let i = 0; i < 9; i++) {
    await page.evaluate((k) => window.__ocean!.setCamera({ east: (k % 3) * 410 - 410, north: Math.floor(k / 3) * 530 - 530, alt: 150, heading: 0, pitch: -89.9 }), i);
    await waitIdle(page, 4);
    const mean = await page.evaluate(async () => {
      const img = await window.__lab!.renderer.readHdrPixels('hdr');
      const exposure = window.__lab!.renderer.exposureInfo().exposure;
      // The HDR target also holds the atmosphere's in-scatter (composited after the water): a smooth background
      // that the median of the frame (almost all of it foam-free) measures and the mean has to lose.
      const g: number[] = [];
      for (let p = 0; p < img.width * img.height; p++) g.push(img.data[p * 4 + 1]!);
      const sorted = [...g].sort((a, b) => a - b);
      const background = sorted[sorted.length >> 1]!;
      return (g.reduce((a, b) => a + b, 0) / g.length - background) / (2000 * exposure);
    });
    samples.push(mean);
    if (i === 4) await saveScreenshot(page, 'ocean', 'foam-coverage-debug');
  }
  await page.evaluate(() => window.__ocean!.ocean!.debug.setDebugView('none'));
  await waitIdle(page, 4);
  await saveScreenshot(page, 'ocean', 'foam-coverage-150m');
  const st = await page.evaluate(() => window.__ocean!.ocean!.debug.state());
  const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
  const statistical = Math.min(0.2, 3.84e-6 * st.windSpeed ** 3.41) * 0.4;
  console.log(`resolved foam coverage per place: ${samples.map((s) => (s * 100).toFixed(3)).join(' ')} %; mean ${(mean * 100).toFixed(3)} %, statistical (far water) ${(statistical * 100).toFixed(3)} %, ratio ${(mean / statistical).toFixed(2)}`);
  expect(mean / statistical).toBeGreaterThan(0.7);
  expect(mean / statistical).toBeLessThan(1.4);
  await expectNoErrors(page, pageLog);
});
