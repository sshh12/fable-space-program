/**
 * Swell agreement (brief, ACCEPTANCE): the drawn surface carries the physics swell exactly.
 *  1. GPU readback of the displaced surface (the vertex shader's own function) at 200 points and three times
 *     equals oceanSwellHeight (float64, CPU) within 2 cm; the FFT term is reported separately.
 *  2. Inside a floating vessel's damping zone (three hull radii) the total surface is within 5 cm of the swell.
 *  3. The RASTERISED surface: heights reconstructed from the depth buffer at 120 pixels near the camera equal
 *     the physics height (chop off) and the readback total (chop on) - and a screenshot shows marker spheres
 *     centred on the physics height sitting half-submerged in the drawn water.
 */
import { assertDiscreteGpu, expect, expectNoErrors, openPage, saveScreenshot, test, waitIdle } from '../harness';

test.describe.configure({ timeout: 600_000 });

test('readback: the displaced surface equals oceanSwellHeight within 2 cm at 200 points and 3 times', async ({ page, pageLog }) => {
  await openPage(page, '/labs/ocean/?preset=midday');
  await assertDiscreteGpu(page);
  const rows: { ut: number; worst: number; fftRms: number; fftMax: number; residual: number; identity: number }[] = [];
  for (let k = 0; k < 3; k++) {
    await page.evaluate(() => window.__test!.setPaused(false));
    await page.evaluate((n) => window.__test!.waitFrames(n), 20 + 37 * k);
    await page.evaluate(() => window.__test!.setPaused(true));
    await page.evaluate(() => window.__test!.waitFrames(3));
    const r = await page.evaluate(async (seed) => {
      const lab = window.__ocean!;
      let s = seed;
      const rnd = (): number => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
      const dirs = Array.from({ length: 200 }, () => {
        const r = 2000 * Math.sqrt(rnd());
        const a = rnd() * 2 * Math.PI;
        return lab.dirAt(r * Math.cos(a), r * Math.sin(a));
      });
      const { ut, samples } = await lab.ocean!.debug.sampleSurface(dirs);
      let worst = 0;
      let fft2 = 0;
      let fftMax = 0;
      let residual = 0;
      let identity = 0;
      for (const p of samples) {
        worst = Math.max(worst, Math.abs(p.swell - p.swellCpu));
        fft2 += p.fft * p.fft;
        fftMax = Math.max(fftMax, Math.abs(p.fft));
        residual = Math.max(residual, p.residual);
        identity = Math.max(identity, Math.abs(p.total - p.swell - p.fft - p.ripple));
      }
      return { ut, worst, fftRms: Math.sqrt(fft2 / samples.length), fftMax, residual, identity };
    }, 12345 + k);
    rows.push(r);
  }
  console.log('swell readback per time:', JSON.stringify(rows));
  // Three distinct sim times.
  expect(new Set(rows.map((r) => r.ut.toFixed(3))).size).toBe(3);
  for (const r of rows) {
    expect(r.worst).toBeLessThan(0.02);
    expect(r.identity).toBeLessThan(1e-4);
    // The Lagrangian solve lands on the query (no folding in a 7 m/s sea).
    expect(r.residual).toBeLessThan(0.01);
    // The FFT chop is real and reported: centimetres to decimetres.
    expect(r.fftRms).toBeGreaterThan(0.02);
  }
  await expectNoErrors(page, pageLog);
});

test('damping zone: within three hull radii of a floating vessel the surface is within 5 cm of the swell', async ({ page, pageLog }) => {
  await openPage(page, '/labs/ocean/?preset=splash');
  await assertDiscreteGpu(page);
  await page.evaluate(() => window.__test!.waitFrames(30));
  const res: { zones: number; worst: number; outsideRms: number }[] = [];
  for (let k = 0; k < 3; k++) {
    await page.evaluate(() => window.__test!.setPaused(false));
    await page.evaluate((n) => window.__test!.waitFrames(n), 25 + 31 * k);
    await page.evaluate(() => window.__test!.setPaused(true));
    await page.evaluate(() => window.__test!.waitFrames(3));
    res.push(
      await page.evaluate(async () => {
        const lab = window.__ocean!;
        const f = lab.world.floating!;
        const hull = f.boundingRadius;
        const inside = Array.from({ length: 120 }, (_, i) => {
          const r = 3 * hull * Math.sqrt((i + 0.5) / 120);
          const a = i * 2.39996323;
          return lab.dirAt(f.east + r * Math.cos(a), f.north + r * Math.sin(a));
        });
        const outside = Array.from({ length: 60 }, (_, i) => {
          const r = 8 * hull + 20 * ((i + 0.5) / 60);
          const a = i * 2.39996323;
          return lab.dirAt(f.east + r * Math.cos(a), f.north + r * Math.sin(a));
        });
        const a = await lab.ocean!.debug.sampleSurface(inside);
        const b = await lab.ocean!.debug.sampleSurface(outside);
        const worst = Math.max(...a.samples.map((p) => Math.abs(p.total - p.swellCpu)));
        const outsideRms = Math.sqrt(b.samples.reduce((s, p) => s + (p.total - p.swellCpu) ** 2, 0) / b.samples.length);
        return { zones: lab.ocean!.debug.state().vesselZones, worst, outsideRms };
      }),
    );
  }
  console.log('damping zone:', JSON.stringify(res));
  for (const r of res) {
    expect(r.zones).toBeGreaterThan(0);
    expect(r.worst).toBeLessThan(0.05);
    // Outside the zone the chop is back (the test would pass trivially with no chop at all).
    expect(r.outsideRms).toBeGreaterThan(0.04);
  }
  await expectNoErrors(page, pageLog);
});

test('the rasterised surface: depth-buffer heights near the camera equal the physics swell (chop off) and the readback (chop on)', async ({ page, pageLog }) => {
  await openPage(page, '/labs/ocean/?preset=midday');
  await assertDiscreteGpu(page);
  await page.evaluate(() => {
    window.__ocean!.setCamera({ alt: 2, heading: 40, pitch: -30 });
    window.__lab!.renderer.setJitter(false);
    window.__test!.setPaused(true);
  });
  const measure = async (chop: number): Promise<{ n: number; worstSwell: number; worstTotal: number; meanAbs: number }> => {
    await page.evaluate((c) => window.__ocean!.ocean!.debug.setChopScale(c), chop);
    await page.evaluate(() => window.__test!.waitFrames(6));
    return page.evaluate(async () => {
      const lab = window.__ocean!;
      const depth = await lab.app.renderer.readDepth();
      const pts: { x: number; y: number; t: number }[] = [];
      for (let j = 0; j < 12; j++) {
        for (let i = 0; i < 10; i++) {
          const x = Math.round(((i + 0.5) / 10) * depth.width);
          const y = Math.round(depth.height * (0.6 + 0.38 * ((j + 0.5) / 12)));
          const d = depth.data[y * depth.width + x]!;
          const ray = lab.seaHit(x, y)!;
          // Eye distance along the ray from the reversed-Z depth: viewZ = near / d, t = viewZ / cos(off-axis).
          const fc = lab.app.renderer.frameContext!;
          const fwd = { x: -fc.view[2]!, y: -fc.view[6]!, z: -fc.view[10]! };
          const cos = ray.ray.x * fwd.x + ray.ray.y * fwd.y + ray.ray.z * fwd.z;
          pts.push({ x, y, t: 0.05 / d / cos });
        }
      }
      const dirs = pts.map((p) => lab.dirAlong(p.x, p.y, p.t));
      const s = await lab.ocean!.debug.sampleSurface(dirs);
      let worstSwell = 0;
      let worstTotal = 0;
      let sum = 0;
      pts.forEach((p, i) => {
        const alt = lab.altitudeAlong(p.x, p.y, p.t);
        const q = s.samples[i]!;
        worstSwell = Math.max(worstSwell, Math.abs(alt - q.swellCpu));
        worstTotal = Math.max(worstTotal, Math.abs(alt - q.total));
        sum += Math.abs(alt - q.total);
      });
      return { n: pts.length, worstSwell, worstTotal, meanAbs: sum / pts.length };
    });
  };
  const off = await measure(0);
  const on = await measure(1);
  console.log('rasterised surface, chop off:', JSON.stringify(off), ' chop on:', JSON.stringify(on));
  expect(off.worstSwell).toBeLessThan(0.02);
  expect(on.worstTotal).toBeLessThan(0.03);

  // Markers centred on the physics height, close up, chop off then on: half-submerged spheres.
  await page.evaluate(() => {
    const lab = window.__ocean!;
    lab.props.markers = Array.from({ length: 7 }, (_, i) => ({ east: -2.4 + i * 0.8, north: 3.2 + (i % 2) * 0.6 }));
    lab.setCamera({ alt: 1.1, heading: 0, pitch: -14 });
    window.__lab!.renderer.setJitter(true);
    window.__test!.setDeterministic(true);
  });
  await page.evaluate(() => window.__ocean!.ocean!.debug.setChopScale(0));
  await waitIdle(page, 40);
  await saveScreenshot(page, 'ocean', 'markers-swell-only');
  await page.evaluate(() => window.__ocean!.ocean!.debug.setChopScale(1));
  await waitIdle(page, 40);
  await saveScreenshot(page, 'ocean', 'markers-with-chop');
  await expectNoErrors(page, pageLog);
});
