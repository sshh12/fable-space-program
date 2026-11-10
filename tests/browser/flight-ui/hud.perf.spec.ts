import { assertDiscreteGpu, expect, expectNoErrors, openPage, test, withGpuLock } from '../harness';

/**
 * Budgets of the flight-ui package, measured under the machine-wide GPU lock:
 *  - HUD update (CPU, including the navball encode + submit) under 0.5 ms per frame on average;
 *  - navball GPU time (ARCHITECTURE 17.1) under 0.05 ms for the shared 512 x 512 texture
 *    ('ui.navball'); the HUD's native-resolution copy ('ui.navball.hud') is reported alongside.
 */
test.use({ viewport: { width: 2560, height: 1440 } });

test('HUD update cost and navball GPU time', async ({ page, pageLog }) => {
  const result = await withGpuLock(async () => {
    await openPage(page, '/labs/flight-ui/?scene=lowOrbit&node=1');
    await assertDiscreteGpu(page);
    // Warm-up, with values changing every frame (orbit motion, a planned node).
    await page.evaluate(() => window.__test!.waitFrames(120));
    await page.evaluate(() => window.__flightUi!.resetTimes());
    const t0 = await page.evaluate(() => performance.now());
    await page.evaluate(() => window.__test!.waitFrames(400));
    return page.evaluate((start) => {
      const frames = window.__flightUi!.frames().filter((f) => f.t > start);
      const hud = frames.map((f) => f.hudMs).sort((a, b) => a - b);
      const gpu = window.__flightUi!.gpuTimes();
      const stats = (xs: number[]) => {
        const s = xs.slice().sort((a, b) => a - b);
        return { n: s.length, mean: s.reduce((a, b) => a + b, 0) / Math.max(1, s.length), p50: s[Math.floor(s.length * 0.5)] ?? NaN, p99: s[Math.floor(s.length * 0.99)] ?? NaN };
      };
      return { hud: stats(hud), navball: stats(gpu['ui.navball'] ?? []), navballHud: stats(gpu['ui.navball.hud'] ?? []) };
    }, t0);
  });
  console.log(`HUD update ms: ${JSON.stringify(result.hud)}`);
  console.log(`navball 512 GPU ms: ${JSON.stringify(result.navball)}`);
  console.log(`navball HUD canvas GPU ms: ${JSON.stringify(result.navballHud)}`);
  expect(result.hud.n).toBeGreaterThan(300);
  expect(result.hud.mean).toBeLessThan(0.5);
  expect(result.navball.n).toBeGreaterThan(50);
  expect(result.navball.p50).toBeLessThan(0.05);
  await expectNoErrors(page, pageLog);
});
