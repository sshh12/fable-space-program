/**
 * The water's answer to a vessel entering it (request vfx-9): at a 'splash' event of the snapshot the surface
 * itself moves (the cavity and its rebound at the centre, ring waves running out) and a foam patch spreads and
 * ages, in the ocean's own displacement and foam. A time sequence in the ocean lab (the capsule-sized float of the
 * `splash` preset, a 'splash' event at 7.8 m/s): reviewed screenshots `splash-impact-<t>` at +0.2, +1, +3 and
 * +10 s, and the displaced surface read back: the cavity at the centre at +0.2 s, the ring waves outside the hull
 * at +1 s and +3 s, nothing left of them where they have not arrived.
 */
import { assertDiscreteGpu, expect, expectNoErrors, openPage, saveScreenshot, test } from '../harness';

test.describe.configure({ timeout: 600_000 });

test('splash: cavity, ring waves and a foam patch at the impact, as a time sequence', async ({ page, pageLog }) => {
  await openPage(page, '/labs/ocean/?preset=splash');
  await assertDiscreteGpu(page);
  await page.evaluate(() => document.body.classList.add('shot'));
  await page.evaluate(() => window.__test!.waitFrames(90));
  const before = await page.evaluate(() => window.__test!.hdrStats());
  expect(before.nanPixels).toBe(0);
  // The float of the preset lies 22 m north of the site; its bounding radius is the impact's R0.
  const t0 = await page.evaluate(() => {
    window.__ocean!.world.splash(7.8);
    return window.__ocean!.app.snapshot().ut;
  });
  /**
   * Ripple part of the surface (m) at 24 points around the float, `radius` to `radius` + 5.25 m from its centre (more
   * than a wavelength of the ring waves, so that a crest or a trough is among them whatever the phase); 0 = the
   * centre alone.
   */
  const ring = (radius: number): Promise<number[]> =>
    page.evaluate(async (rad) => {
      const lab = window.__ocean!;
      const dirs = Array.from({ length: rad === 0 ? 1 : 24 }, (_, i) => {
        const r = rad === 0 ? 0 : rad + 0.75 * (i % 8);
        return lab.dirAt(r * Math.cos((i * Math.PI) / 12), 22 + r * Math.sin((i * Math.PI) / 12));
      });
      const r = await lab.ocean!.debug.sampleSurface(dirs);
      return r.samples.map((s) => s.ripple);
    }, radius);
  const report: string[] = [];
  for (const [label, t] of [
    ['0.2s', 0.2],
    ['1s', 1],
    ['3s', 3],
    ['10s', 10],
  ] as const) {
    await page.waitForFunction((at) => window.__ocean!.app.snapshot().ut >= at, t0 + t, { timeout: 120_000 });
    const centre = (await ring(0))[0]!;
    const near = await ring(4);
    const far = await ring(30);
    const amp = (xs: number[]): number => Math.max(...xs.map((x) => Math.abs(x)));
    report.push(`+${label}: centre ${centre.toFixed(3)} m, 4-9 m out up to ${amp(near).toFixed(3)} m, 30-35 m out up to ${amp(far).toFixed(3)} m`);
    await saveScreenshot(page, 'ocean', `splash-impact-${label}`);
    // (The read-back comes a few frames after the instant: the bounds leave room for that.)
    if (t === 0.2) {
      // The cavity: a third of the hull's radius deep at the centre.
      expect(centre).toBeLessThan(-0.3);
      expect(amp(far)).toBeLessThan(0.01);
    }
    if (t === 1) {
      // The cavity and its rebound are over; the first crests stand outside the hull.
      expect(Math.abs(centre)).toBeLessThan(0.25);
      expect(amp(near)).toBeGreaterThan(0.08);
      expect(amp(far)).toBeLessThan(0.01);
    }
    if (t === 3) expect(amp(near)).toBeGreaterThan(0.03);
    if (t === 10) {
      // The train has run out past 20 m and is nearly spent; nothing is left at the hull.
      expect(amp(near)).toBeLessThan(0.03);
      expect(amp(far)).toBeLessThan(0.12);
    }
  }
  console.log(`splash at 7.8 m/s, ripple part of the surface:\n  ${report.join('\n  ')}`);
  const hdr = await page.evaluate(() => window.__test!.hdrStats());
  expect(hdr.nanPixels).toBe(0);
  await expectNoErrors(page, pageLog);
});
