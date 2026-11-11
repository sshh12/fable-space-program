import type { Page } from '@playwright/test';
import { assertDiscreteGpu, expect, expectNoErrors, openPage, test, waitIdle } from '../harness';

/**
 * Scintillation: only inside an atmosphere, mean-preserving, growing with air mass. From the pad at night the
 * flux of one star is read every frame (HDR target before TAA, no jitter, 1/60 s steps of the presentation clock)
 * near the zenith and 10 deg above the horizon; in space the same readback is constant (stars.spec.ts).
 */
test.describe.configure({ timeout: 600_000 });

interface Series {
  name: string;
  elevationDeg: number;
  mean: number;
  sigma: number;
  steady: number;
}

async function series(page: Page, minEl: number, maxEl: number): Promise<Series> {
  return page.evaluate(
    async ([lo, hi]) => {
      const lab = window.__lab!;
      const sky = window.__sky!;
      const cat = sky.sky!.stars()!;
      const s = lab.snapshot();
      const v = s.vessels[0]!;
      const e = s.bodies.find((b) => b.id === v.bodyId)!;
      const u0 = { x: v.rRoot.x - e.rRoot.x, y: v.rRoot.y - e.rRoot.y, z: v.rRoot.z - e.rRoot.z };
      const ul = Math.hypot(u0.x, u0.y, u0.z);
      const up = { x: u0.x / ul, y: u0.y / ul, z: u0.z / ul };
      // The brightest catalogue star in the elevation band.
      let pick = -1;
      for (let i = 0; i < 400 && pick < 0; i++) {
        const d = { x: cat.records[i * 8]!, y: cat.records[i * 8 + 1]!, z: cat.records[i * 8 + 2]! };
        const el = (Math.asin(d.x * up.x + d.y * up.y + d.z * up.z) * 180) / Math.PI;
        if (el > lo! && el < hi!) pick = i;
      }
      const d = { x: cat.records[pick * 8]!, y: cat.records[pick * 8 + 1]!, z: cat.records[pick * 8 + 2]! };
      const el = (Math.asin(d.x * up.x + d.y * up.y + d.z * up.z) * 180) / Math.PI;
      sky.lookFrom(v.rRoot, d, up, 8);
      lab.setLoop(false);
      lab.renderFrame(1 / 60);
      const p = sky.projectDir(d)!;
      const half = 5;
      const flux: number[] = [];
      const readFlux = async () => {
        const px = await lab.renderer.readHdrPixels('hdr', { x: Math.round(p.x) - half, y: Math.round(p.y) - half, width: 2 * half + 1, height: 2 * half + 1 });
        let sum = 0;
        for (let i = 0; i < px.data.length; i += 4) sum += 0.2126 * px.data[i]! + 0.7152 * px.data[i + 1]! + 0.0722 * px.data[i + 2]!;
        return sum;
      };
      for (let k = 0; k < 360; k++) {
        lab.renderFrame(1 / 60);
        flux.push(await readFlux());
      }
      // Unmodulated flux: illuminance / pixel solid angle x exposure (the PSF integral, stars.spec.ts).
      const f = lab.renderer.frameContext!;
      const [w, h] = f.renderSize;
      const tanY = Math.tan(f.camera.fovY / 2);
      const fwd = { x: -f.view[2]!, y: -f.view[6]!, z: -f.view[10]! };
      const c3 = (d.x * fwd.x + d.y * fwd.y + d.z * fwd.z) ** 3;
      const steady = (cat.records[pick * 8 + 3]! / (((2 * tanY * w) / h / w) * ((2 * tanY) / h) * c3)) * f.exposure;
      lab.setLoop(true);
      const mean = flux.reduce((a, b) => a + b, 0) / flux.length;
      const sigma = Math.sqrt(flux.reduce((a, b) => a + (b - mean) ** 2, 0) / flux.length) / mean;
      return { name: `#${pick} V ${cat.records[pick * 8 + 7]!.toFixed(2)}`, elevationDeg: el, mean, sigma, steady };
    },
    [minEl, maxEl],
  );
}

test('stars twinkle inside an atmosphere, more towards the horizon, without changing their mean flux', async ({ page, pageLog }) => {
  await openPage(page, '/labs/sky/?scene=pad&parts=-milkyWay,-flare,-impostors,-probe&ev=-3&hud=0&night=1');
  await assertDiscreteGpu(page);
  await waitIdle(page, 4, 300_000);
  await page.evaluate(() => {
    window.__lab!.setPaused(true);
    window.__lab!.renderer.setJitter(false);
  });
  const zenith = await series(page, 70, 90);
  const low = await series(page, 9, 13);
  for (const s of [zenith, low]) {
    console.log(`star ${s.name} at ${s.elevationDeg.toFixed(1)} deg elevation: flux relative std ${(s.sigma * 100).toFixed(1)} % over 6 s, mean / unmodulated ${(s.mean / s.steady).toFixed(3)}`);
  }
  // Model (photometry.ts): sigma_I^2 = s / (1 + s), s = 0.03 X^(11/6): about 0.17 at the zenith, 0.6 at 11 deg.
  expect(zenith.sigma).toBeGreaterThan(0.08);
  expect(zenith.sigma).toBeLessThan(0.3);
  expect(low.sigma).toBeGreaterThan(0.35);
  expect(low.sigma).toBeLessThan(1.0);
  expect(low.sigma / zenith.sigma).toBeGreaterThan(2);
  // Log-normal with mean 1: the time average stays at the unmodulated flux (6 s of a few-Hz process: within 25 %).
  expect(Math.abs(zenith.mean / zenith.steady - 1)).toBeLessThan(0.1);
  expect(Math.abs(low.mean / low.steady - 1)).toBeLessThan(0.25);
  await expectNoErrors(page, pageLog);
});
