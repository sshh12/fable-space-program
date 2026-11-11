import { expect, expectNoErrors, test } from '../harness';
import { hdrSummary, openLab, runAndSettle } from './helpers';

test.describe.configure({ timeout: 600_000 });

// ---- the analytic references, written out here independently of src/render/vfx/plumeModel.ts
const DEG = Math.PI / 180;
const GAMMA = 1.2; // plume.methalox-booster
const prandtlMeyer = (m: number, g: number): number => {
  const k = Math.sqrt((g + 1) / (g - 1));
  const b = Math.sqrt(m * m - 1);
  return k * Math.atan(b / k) - Math.atan(b);
};
const mach = (ratio: number, g: number): number => Math.sqrt((2 / (g - 1)) * (Math.pow(ratio, (g - 1) / g) - 1));
/** Expected lip half-angle (rad) and Prandtl-Pack cell spacing (m) of the booster engine. */
function reference(throttle: number, ambient: number, nozzleDeg: number): { theta: number; spacing: number; eta: number } {
  const re = 0.95;
  const pc = 30e6 * throttle;
  const pe = 70e3 * throttle;
  const eta = pe / ambient;
  const me = mach(30e6 / 70e3, GAMMA);
  const mj = mach(pc / ambient, GAMMA);
  const theta = Math.min(85 * DEG, Math.max(-8 * DEG, prandtlMeyer(mj, GAMMA) - prandtlMeyer(me, GAMMA) + nozzleDeg * DEG));
  const dj = 2 * re * Math.sqrt(Math.max(eta, 0.3));
  return { theta, spacing: 1.306 * dj * Math.sqrt(mj * mj - 1), eta };
}

test('plume boundary half-angle and shock-cell spacing match the analytic formulas within 10 % (rendered density slices)', async ({ page, pageLog }) => {
  // Three pressure ratios inside the shock-cell window: sea level at minimum throttle, sea level at full
  // throttle, 10 km at full throttle.
  const cases = [
    { name: 'sea level, 50 %', query: 'altkm=0&throttle=0.5', throttle: 0.5, ambient: 101325 },
    { name: 'sea level, 100 %', query: 'altkm=0&throttle=1', throttle: 1, ambient: 101325 },
    { name: '10 km, 100 %', query: 'altkm=10&throttle=1', throttle: 1, ambient: 26436 },
  ];
  for (const c of cases) {
    await openLab(page, `scene=engine&engine=atlas-9m&${c.query}`);
    await runAndSettle(page, null, 6);
    const ambient = await page.evaluate(() => window.__test!.state()!.vessels[0]!.aero.pressure);
    // The lab's engine stand hangs 400 m up, or at the stated altitude: within a few per cent of the nominal pressure.
    expect(ambient / c.ambient).toBeGreaterThan(0.93);
    expect(ambient / c.ambient).toBeLessThan(1.03);
    const ref = reference(c.throttle, ambient, 3);
    const measured = await page.evaluate(async () => {
      const debug = window.__vfx!.feature.debug;
      const nz = debug.clusters()[0]!.nozzles[0]!;
      const re = nz.exitRadius;
      // (1) Boundary near the lip: half-density contour of the gas at two stations.
      const W = 512;
      const H = 2048;
      const lip = await debug.plumeSlice(0, 0, 0, 0.3 * re, 1.3 * re, W, H);
      const boundary = (col: number): number => {
        const centre = lip.data[((H / 2) * W + col) * 4]!;
        // Walk outwards from the axis to where the density falls through half the axis value.
        for (let row = H / 2; row < H - 1; row++) {
          const a = lip.data[(row * W + col) * 4]!;
          const b = lip.data[((row + 1) * W + col) * 4]!;
          if (a >= 0.5 * centre && b < 0.5 * centre) {
            const f = (a - 0.5 * centre) / (a - b);
            return (((row + f + 0.5) / H) * 2 - 1) * lip.rMax;
          }
        }
        return NaN;
      };
      const xAt = (col: number): number => ((col + 0.5) / W) * (lip.x1 - lip.x0);
      const c0 = Math.round(W * 0.07);
      const c1 = Math.round(W * 0.74);
      const theta = Math.atan((boundary(c1) - boundary(c0)) / (xAt(c1) - xAt(c0)));
      // (2) Shock cells: maxima of the core density along the axis.
      const L = 5.2 * nz.shockSpacing;
      const axisW = 4096;
      const axial = await debug.plumeSlice(0, 0, 0, L, 0.05 * re, axisW, 4);
      const g = (col: number): number => axial.data[(2 * axisW + col) * 4 + 1]!;
      const peaks: number[] = [];
      for (let col = 2; col < axisW - 2; col++) {
        // A Mach disc is a jump: the density is at its highest right behind it.
        if (g(col) > g(col - 1) * 1.02 && g(col) >= g(col + 1) && g(col) > g(col - 2) * 1.05) peaks.push(((col + 0.5) / axisW) * L);
      }
      return { theta, peaks, re, modelTheta: nz.theta, modelSpacing: nz.shockSpacing, eta: nz.eta, r0: boundary(c0) };
    });
    const spacings = measured.peaks.slice(1, 5).map((p, i) => p - measured.peaks[i]!);
    const spacing = spacings.reduce((a, b) => a + b, 0) / spacings.length;
    console.log(
      `${c.name}: eta ${measured.eta.toFixed(3)} (reference ${ref.eta.toFixed(3)}); half-angle measured ${(measured.theta / DEG).toFixed(2)} deg, formula ${(ref.theta / DEG).toFixed(2)} deg; ` +
        `cell spacing measured ${spacing.toFixed(3)} m over ${spacings.length} cells, Prandtl-Pack ${ref.spacing.toFixed(3)} m`,
    );
    expect(measured.eta / ref.eta).toBeCloseTo(1, 2);
    expect(measured.peaks.length).toBeGreaterThanOrEqual(4);
    expect(Math.abs(measured.theta - ref.theta)).toBeLessThan(0.1 * Math.abs(ref.theta));
    expect(Math.abs(spacing - ref.spacing)).toBeLessThan(0.1 * ref.spacing);
    // The boundary starts at the exit radius.
    expect(measured.r0 / measured.re).toBeGreaterThan(0.97);
    expect(measured.r0 / measured.re).toBeLessThan(1.03);
    await expectNoErrors(page, pageLog);
  }
});

test('integrated plume luminance rises monotonically with throttle; the plume light is proportional to thrust', async ({ page, pageLog }) => {
  await openLab(page, 'scene=engine&engine=atlas-9m&altkm=0&ev=13&sun=-30');
  await runAndSettle(page, null, 6);
  const rows: { throttle: number; sum: number; thrust: number; light: number }[] = [];
  for (const throttle of [0, 0.5, 0.6, 0.7, 0.8, 0.9, 1]) {
    await page.evaluate((thr) => window.__vfx!.scene.controls!.throttle!(thr), throttle);
    await page.evaluate(() => window.__vfx!.renderExact(3, false));
    const sum = (await hdrSummary(page)).sum;
    const info = await page.evaluate(() => {
      const lights = window.__vfx!.feature.debug.lights();
      const l = lights[0];
      return { thrust: window.__test!.state()!.vessels[0]!.thrust, light: l ? 0.2126 * l.intensity[0] + 0.7152 * l.intensity[1] + 0.0722 * l.intensity[2] : 0, kind: l?.kind ?? 'none', count: lights.length };
    });
    rows.push({ throttle, sum, thrust: info.thrust, light: info.light });
    if (throttle > 0) {
      expect(info.count).toBe(1);
      expect(info.kind).toBe('capsule');
    } else expect(info.count).toBe(0);
  }
  await page.evaluate(() => window.__vfx!.resume());
  const base = rows[0]!.sum;
  console.log(`throttle -> plume luminance (sum over the frame, pre-exposed): ${rows.map((r) => `${r.throttle}: ${(r.sum - base).toFixed(1)}`).join(', ')}`);
  console.log(`throttle -> light intensity / thrust (cd/N): ${rows.slice(1).map((r) => `${r.throttle}: ${(r.light / r.thrust).toFixed(4)}`).join(', ')}`);
  for (let i = 1; i < rows.length; i++) expect(rows[i]!.sum, `throttle ${rows[i]!.throttle}`).toBeGreaterThan(rows[i - 1]!.sum * 1.01);
  const efficacy = rows[1]!.light / rows[1]!.thrust;
  expect(efficacy).toBeGreaterThan(0);
  for (const r of rows.slice(1)) expect(r.light / r.thrust / efficacy).toBeCloseTo(1, 6);
  await expectNoErrors(page, pageLog);
});

test('nine plumes in view at EV100 -3: nothing above HDR_MAX, no NaN', async ({ page, pageLog }) => {
  await openLab(page, 'scene=pad&night=1&ev=-3&dist=260&fov=40');
  await runAndSettle(page, 5.5, 20);
  const info = await page.evaluate(() => ({ clusters: window.__vfx!.feature.debug.clusters().map((c) => c.nozzles.length), stats: window.__vfx!.feature.debug.stats(), ev: window.__lab!.renderer.exposureInfo().ev100 }));
  expect(info.clusters).toEqual([9]);
  expect(info.ev).toBe(-3);
  expect(info.stats.smoke).toBe(1);
  const hdr = await hdrSummary(page);
  const resolved = await page.evaluate(() => window.__lab!.renderer.readHdrStats('resolved'));
  console.log(`EV -3, nine plumes + smoke + particles (${info.stats.particles} alive): HDR max ${hdr.max.toFixed(0)}, NaN ${hdr.nan}; resolved max ${resolved.maxLuminance.toFixed(0)}, NaN ${resolved.nanPixels}`);
  expect(hdr.nan).toBe(0);
  expect(hdr.max).toBeLessThanOrEqual(60000);
  // The plume saturates at this exposure: the clamp is what is being tested.
  expect(hdr.max).toBeGreaterThan(10000);
  expect(resolved.nanPixels).toBe(0);
  expect(resolved.maxLuminance).toBeLessThanOrEqual(60000 * 1.001);
  await expectNoErrors(page, pageLog);
});
