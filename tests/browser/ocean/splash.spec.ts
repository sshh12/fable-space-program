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
  /**
   * Foam (coverage x opacity x albedo relative to fresh foam, 0..1: the 'foam' debug view) on the water in front of
   * the float, at 75 points of the half disc towards the camera: `inner` = 1.3 to 1.7 hull radii from its centre,
   * `outer` = 2.1 to 2.9.
   */
  const foam = (): Promise<{ inner: number; outer: number }> =>
    page.evaluate(async () => {
      const lab = window.__ocean!;
      lab.ocean!.debug.setDebugView('foam');
      await window.__test!.waitFrames(3);
      const img = await lab.app.renderer.readHdrPixels('hdr');
      const exposure = lab.app.renderer.exposureInfo().exposure;
      lab.ocean!.debug.setDebugView('none');
      await window.__test!.waitFrames(2);
      const radius = lab.app.defs.bodies[lab.site.bodyId]!.radius;
      // Unit vector from the float (0, 22) towards the camera of the preset (-6, -2), and across it.
      const c = [-6 / Math.hypot(6, 24), -24 / Math.hypot(6, 24)] as const;
      const sums = [0, 0];
      const counts = [0, 0];
      const R0 = 2.6;
      [1.3, 1.7, 2.1, 2.5, 2.9].forEach((rr, ring) => {
        for (let k = 0; k < 15; k++) {
          const th = ((-70 + 10 * k) * Math.PI) / 180;
          const e = rr * R0 * (Math.cos(th) * c[0] - Math.sin(th) * c[1]);
          const n = 22 + rr * R0 * (Math.cos(th) * c[1] + Math.sin(th) * c[0]);
          const dir = lab.dirAt(e, n);
          const r = radius + lab.waterAt(e, n);
          const p = lab.project({ x: dir.x * r, y: dir.y * r, z: dir.z * r });
          if (!p || p.x < 0 || p.y < 0 || p.x >= img.width || p.y >= img.height) continue;
          const o = (Math.floor(p.y) * img.width + Math.floor(p.x)) * 4;
          const i = ring < 2 ? 0 : 1;
          sums[i] = sums[i]! + img.data[o]! / (2000 * exposure);
          counts[i] = counts[i]! + 1;
        }
      });
      return { inner: sums[0]! / Math.max(1, counts[0]!), outer: sums[1]! / Math.max(1, counts[1]!) };
    });
  const foamAt: Record<string, { inner: number; outer: number }> = {};
  // What lies there before the impact (a whitecap, the lap at the float) is not the patch.
  const foamBefore = await foam();
  // The float of the preset lies 22 m north of the site; its bounding radius is the impact's R0.
  const t0 = await page.evaluate(() => {
    window.__ocean!.world.splash(7.8);
    return window.__ocean!.app.snapshot().ut;
  });
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
    if (t >= 1) {
      const f = await foam();
      foamAt[label] = { inner: f.inner - foamBefore.inner, outer: f.outer - foamBefore.outer };
    }
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
  console.log(
    `foam in front of the float (coverage x opacity; 1.3-1.7 / 2.1-2.9 hull radii out): ${Object.entries(foamAt)
      .map(([k, v]) => `+${k} ${v.inner.toFixed(3)} / ${v.outer.toFixed(3)}`)
      .join(', ')}`,
  );
  // The patch ages: brightest in its first second, torn by 3 s, a faint film at 10 s, and it has stopped growing.
  expect(foamAt['1s']!.inner).toBeGreaterThan(0.3);
  expect(foamAt['3s']!.inner).toBeLessThan(0.85 * foamAt['1s']!.inner);
  expect(foamAt['10s']!.inner).toBeLessThan(0.2 * foamAt['1s']!.inner);
  expect(foamAt['10s']!.outer).toBeLessThan(0.5 * Math.max(foamAt['3s']!.outer, 0.02));
  const hdr = await page.evaluate(() => window.__test!.hdrStats());
  expect(hdr.nanPixels).toBe(0);
  await expectNoErrors(page, pageLog);
});
