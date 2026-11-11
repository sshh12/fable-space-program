import type { Page } from '@playwright/test';
import { PNG } from 'pngjs';
import { assertDiscreteGpu, expect, expectNoErrors, openPage, saveScreenshot, test, waitIdle } from '../harness';

/**
 * The solar disc: true angular size, per-channel limb darkening, mean luminance E / (pi sin^2 theta) at an
 * exposure low enough not to clamp, and exactly HDR_MAX without NaN at the dark-adapted EV100 -3.
 * Translunar space, no planet drawn, camera on the vessel looking at the sun.
 */
test.describe.configure({ timeout: 600_000 });

async function lookAtSun(page: Page, fovDeg: number): Promise<void> {
  await page.evaluate((fov) => {
    const f = window.__lab!.renderer.frameContext!;
    const p = window.__lab!.snapshot().vessels[0]!.rRoot;
    const s = f.sun.dirRoot;
    window.__lab!.setPaused(true);
    window.__sky!.lookFrom(p, s, Math.abs(s.z) < 0.9 ? { x: 0, y: 0, z: 1 } : { x: 1, y: 0, z: 0 }, fov);
  }, fovDeg);
}

test('the sun disc subtends 0.533 deg, darkens towards the limb per channel and has the photometric mean luminance', async ({ page, pageLog }) => {
  await openPage(page, '/labs/sky/?scene=translunar&planet=0&parts=-stars,-milkyWay,-flare,-impostors,-probe&hud=0&ev=18');
  await assertDiscreteGpu(page);
  await waitIdle(page, 4, 300_000);
  await lookAtSun(page, 1.2);
  await page.evaluate(() => window.__lab!.renderer.setJitter(false));
  await page.evaluate(() => window.__test!.waitFrames(8));
  const r = await page.evaluate(async () => {
    const lab = window.__lab!;
    const f = lab.renderer.frameContext!;
    const px = await lab.renderer.readHdrPixels('hdr');
    const [w, h] = f.renderSize;
    const tanY = Math.tan(f.camera.fovY / 2);
    const tanX = (tanY * w) / h;
    const c = window.__sky!.projectDir(f.sun.dirRoot)!;
    const pxAngle = (2 * tanY) / h;
    const omega = ((2 * tanX) / w) * ((2 * tanY) / h);
    const rs = f.sun.angularRadius;
    const emission = lab.defs.bodies[f.sun.bodyId]!.emission!;
    const u = emission.limbDarkening;
    // Per-pixel model: centre luminance of channel c x (1 - u_c (1 - mu)); the disc covers the pixel above half.
    let flux = 0;
    let n = 0;
    let lumSum = 0;
    let centre = 0;
    let rim = 0;
    let rimN = 0;
    let modelRim = 0;
    const lum = (i: number) => 0.2126 * px.data[i]! + 0.7152 * px.data[i + 1]! + 0.0722 * px.data[i + 2]!;
    let maxCh = 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        const L = lum(i);
        maxCh = Math.max(maxCh, px.data[i]!, px.data[i + 1]!, px.data[i + 2]!);
        flux += L * omega;
        const theta = Math.hypot(x + 0.5 - c.x, y + 0.5 - c.y) * pxAngle;
        if (theta < rs) {
          n++;
          lumSum += L;
        }
        if (theta < 0.05 * rs) centre = Math.max(centre, L);
        if (theta > 0.88 * rs && theta < 0.92 * rs) {
          rim += L;
          rimN++;
          const mu = Math.sqrt(1 - (theta / rs) ** 2);
          const col = emission.color;
          modelRim += [0, 1, 2].map((k) => [0.2126, 0.7152, 0.0722][k]! * col[k]! * (1 - u[k]! * (1 - mu)) / (1 - u[k]! / 3)).reduce((a, b) => a + b, 0);
        }
      }
    }
    // Disc diameter from the area above half the local model luminance.
    let area = 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const theta = Math.hypot(x + 0.5 - c.x, y + 0.5 - c.y) * pxAngle;
        const t = Math.min(theta / rs, 1);
        const mu = Math.sqrt(Math.max(0, 1 - t * t));
        const col = emission.color;
        const model = [0, 1, 2].map((k) => [0.2126, 0.7152, 0.0722][k]! * col[k]! * (1 - u[k]! * (1 - mu)) / (1 - u[k]! / 3)).reduce((a, b) => a + b, 0);
        const meanL = (f.sun.illuminance / (Math.PI * Math.sin(rs) ** 2)) * f.exposure;
        if (lum((y * w + x) * 4) > 0.5 * model * meanL) area++;
      }
    }
    const meanExpected = (f.sun.illuminance / (Math.PI * Math.sin(rs) ** 2)) * f.exposure;
    // Centre of a limb-darkened disc: mean / (1 - u/3) per channel, luminance-weighted.
    const centreModel = [0, 1, 2].map((k) => [0.2126, 0.7152, 0.0722][k]! * emission.color[k]! / (1 - u[k]! / 3)).reduce((a, b) => a + b, 0) * meanExpected;
    return {
      diameterDeg: (2 * Math.sqrt((area * omega) / Math.PI) * 180) / Math.PI,
      expectedDeg: (2 * rs * 180) / Math.PI,
      mean: lumSum / n,
      meanExpected,
      cdm2: lumSum / n / f.exposure,
      flux: flux / f.exposure,
      illuminance: f.sun.illuminance,
      centre,
      centreModel,
      rimRatio: rim / rimN / centre,
      rimModel: (modelRim / rimN) * meanExpected / centreModel,
      maxCh,
    };
  });
  console.log(`disc diameter ${r.diameterDeg.toFixed(4)} deg (expected ${r.expectedDeg.toFixed(4)} at this distance), mean luminance ${r.cdm2.toExponential(4)} cd/m^2 (E / pi sin^2 theta = ${(r.meanExpected / (r.mean / r.cdm2)).toExponential(4)}), ratio ${(r.mean / r.meanExpected).toFixed(4)}`);
  console.log(`integrated ${r.flux.toFixed(0)} lux vs illuminance ${r.illuminance.toFixed(0)} lux; centre ${r.centre.toFixed(1)} (model ${r.centreModel.toFixed(1)}), luminance at 0.9 R / centre ${r.rimRatio.toFixed(4)} (model ${r.rimModel.toFixed(4)}), max channel ${r.maxCh.toFixed(0)}`);
  expect(r.expectedDeg).toBeGreaterThan(0.522);
  expect(r.expectedDeg).toBeLessThan(0.545);
  expect(Math.abs(r.diameterDeg / r.expectedDeg - 1)).toBeLessThan(0.01);
  expect(Math.abs(r.mean / r.meanExpected - 1)).toBeLessThan(0.05);
  expect(Math.abs(r.flux / r.illuminance - 1)).toBeLessThan(0.02);
  expect(Math.abs(r.centre / r.centreModel - 1)).toBeLessThan(0.02);
  expect(r.rimRatio).toBeLessThan(0.8);
  expect(Math.abs(r.rimRatio / r.rimModel - 1)).toBeLessThan(0.03);
  expect(r.maxCh).toBeLessThan(60_000);
  // Through a "solar filter": EV100 33 puts the disc centre at about mid-grey, below the shoulder of the tone curve (at
  // EV 30.4 it sat at 208/255 and the shoulder flattened the profile to 0.89 at 0.9 R), so the limb darkening and its
  // reddening towards the limb (u is largest in blue) show in the display image as in a white-light photograph.
  await page.evaluate(() => window.__lab!.renderer.setExposureOverride(33));
  await page.evaluate(() => window.__test!.waitFrames(60));
  const shot = await saveScreenshot(page, 'sky', 'sun-disc-limb-darkening-filter');
  const c = await page.evaluate(() => ({ ...window.__sky!.projectDir(window.__lab!.renderer.frameContext!.sun.dirRoot)!, rPx: window.__lab!.renderer.frameContext!.sun.angularRadius / ((2 * Math.tan(window.__lab!.renderer.frameContext!.camera.fovY / 2)) / window.__lab!.renderer.frameContext!.renderSize[1]) }));
  const png = PNG.sync.read(shot.buffer);
  const lin = (v: number): number => (v / 255 <= 0.04045 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4);
  const ring = (a: number, b: number): [number, number, number] => {
    const s = [0, 0, 0];
    let n = 0;
    for (let y = Math.floor(c.y - c.rPx); y <= Math.ceil(c.y + c.rPx); y++) {
      for (let x = Math.floor(c.x - c.rPx); x <= Math.ceil(c.x + c.rPx); x++) {
        const t = Math.hypot(x + 0.5 - c.x, y + 0.5 - c.y) / c.rPx;
        if (t < a || t >= b) continue;
        const i = (y * png.width + x) * 4;
        for (let k = 0; k < 3; k++) s[k] = s[k]! + lin(png.data[i + k]!);
        n++;
      }
    }
    return [s[0]! / n, s[1]! / n, s[2]! / n];
  };
  const Y = (v: [number, number, number]): number => 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
  const centre = ring(0, 0.1);
  const r90 = ring(0.88, 0.92);
  const r98 = ring(0.97, 0.99);
  console.log(
    `through the filter (EV 33), display-linear: centre ${Y(centre).toFixed(3)}, 0.9 R / centre ${(Y(r90) / Y(centre)).toFixed(3)}, 0.98 R / centre ${(Y(r98) / Y(centre)).toFixed(3)}; R/B centre ${(centre[0] / centre[2]).toFixed(3)}, at 0.98 R ${(r98[0] / r98[2]).toFixed(3)} (white-light photographs: about 0.66 at 0.9 R, 0.5 at 0.98 R, warmer at the limb)`,
  );
  // The centre sits in the mid-tones, the limb is clearly darker and warmer than the centre.
  expect(Y(centre)).toBeGreaterThan(0.08);
  expect(Y(centre)).toBeLessThan(0.4);
  expect(Y(r90) / Y(centre)).toBeLessThan(0.75);
  expect(Y(r98) / Y(centre)).toBeLessThan(0.62);
  expect(r98[0] / r98[2]).toBeGreaterThan(1.1 * (centre[0] / centre[2]));
  await expectNoErrors(page, pageLog);
});

test('at EV100 -3 the sun disc writes exactly HDR_MAX and no NaN, with the flare on', async ({ page, pageLog }) => {
  await openPage(page, '/labs/sky/?scene=translunar&planet=0&hud=0&ev=-3');
  await assertDiscreteGpu(page);
  await waitIdle(page, 4, 300_000);
  await lookAtSun(page, 60);
  await page.evaluate(() => window.__test!.waitFrames(30));
  for (let i = 0; i < 8; i++) {
    const hdr = await page.evaluate(() => window.__lab!.renderer.readHdrStats('hdr'));
    const resolved = await page.evaluate(() => window.__lab!.renderer.readHdrStats('resolved'));
    if (i === 0) console.log(`EV -3: HDR target max ${hdr.maxLuminance} nan ${hdr.nanPixels}; resolved max ${resolved.maxLuminance} nan ${resolved.nanPixels}`);
    expect(hdr.maxLuminance).toBeCloseTo(60_000, 3);
    expect(hdr.nanPixels).toBe(0);
    expect(resolved.nanPixels).toBe(0);
    await page.evaluate(() => window.__test!.waitFrames(1));
  }
  await saveScreenshot(page, 'sky', 'sun-ev-3-saturated');
  await expectNoErrors(page, pageLog);
});
