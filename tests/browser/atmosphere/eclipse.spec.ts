/**
 * The eclipse term of the atmosphere: with the sun behind another body (the root body's moon, seen from the
 * point that has it at the zenith) the sky dims with the share of the solar disc that is left, and brightens
 * again towards the horizon, where the air is outside the shadow. Screenshots: pad-eclipse.png (central),
 * pad-eclipse-partial.png (sun a quarter of a degree off), pad-eclipse-none.png (the same sky, sun 5 degrees off).
 */
import { expect, expectNoErrors, test } from '../harness';
import { luminance, openLab, probe, settle, shot } from './lab';

test('a solar eclipse dims the sky by the share of the sun that is covered', async ({ page, pageLog }) => {
  test.setTimeout(240_000);
  await openLab(page, 'clouds=0&relief=0');
  const run = async (offsetDeg: number, name: string): Promise<{ fraction: number; sky: number; low: number }> => {
    const fraction = await page.evaluate((offset) => {
      const lab = window.__atmo!;
      const other = Object.values(lab.app.defs.bodies).find((b) => b.parent === lab.site.bodyId)!;
      // One exposure for the three frames: they are compared in the screenshots too.
      lab.app.renderer.setExposureOverride(11);
      return lab.viewEclipse(other.id, offset, 55, 75).visibleFraction;
    }, offsetDeg);
    await settle(page, 40);
    await shot(page, name);
    // The sky 40 degrees from the sun, and just above the horizon.
    return { fraction, sky: luminance(await probe(page, 0.2, 0.55, 3)), low: luminance(await probe(page, 0.5, 0.97, 3)) };
  };
  const none = await run(5, 'pad-eclipse-none');
  const partial = await run(0.25, 'pad-eclipse-partial');
  const central = await run(0, 'pad-eclipse');
  for (const [label, r] of [
    ['sun 5 deg off', none],
    ['sun 0.25 deg off', partial],
    ['central', central],
  ] as const) {
    console.log(`[eclipse] ${label}: visible share of the solar disc ${r.fraction.toFixed(4)}, sky ${r.sky.toFixed(1)} cd/m^2 (${(r.sky / none.sky).toFixed(4)} of the open sun), near the horizon ${r.low.toFixed(1)} cd/m^2`);
  }
  expect(none.fraction).toBe(1);
  expect(none.sky).toBeGreaterThan(500);
  expect(partial.fraction).toBeGreaterThan(0.02);
  expect(partial.fraction).toBeLessThan(0.98);
  // A partial eclipse: the sky follows the visible share of the disc (the share varies by a few percent over
  // the air that the ray crosses).
  expect(partial.sky / none.sky).toBeGreaterThan(partial.fraction * 0.8);
  expect(partial.sky / none.sky).toBeLessThan(partial.fraction * 1.25);
  // Central: never brighter than the share that is left allows plus what distant air outside the shadow
  // scatters in, and far darker than the open sky.
  expect(central.fraction).toBeLessThan(0.2);
  expect(central.sky / none.sky).toBeLessThan(Math.max(2 * central.fraction, 0.12));
  expect(central.sky / none.sky).toBeGreaterThanOrEqual(central.fraction * 0.8);
  await expectNoErrors(page, pageLog);
});
