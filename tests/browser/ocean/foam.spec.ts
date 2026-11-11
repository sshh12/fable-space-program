/**
 * Whitecaps of the near field (the foam map: breakers of the combined surface and what they leave, drawn through
 * the foam lace), looking straight down from 150 m (pixels of 0.24 m), with the foam debug view (albedo-weighted
 * coverage x 2000 cd/m^2):
 *  - calibration: averaged over open ocean the foam covers what the far water's statistical whitecaps cover
 *    (brdf_water: Monahan & O'Muircheartaigh 3.84e-6 U^3.41 x 0.4 for aged foam), so the amount of foam does not
 *    change where the near field hands over to the far sheet; measured at nine planet-fixed places with frozen
 *    time (the foam a level starts with) and again after the sea has run for 12 s (breakers with their history);
 *  - shape: the foam lies in patches, not specks: half of the foam area is in connected patches of at least
 *    1.5 m^2, and a frame holds a few to a few dozen of them;
 *  - no repetition: the foam picture does not correlate with itself shifted by a cascade's patch length.
 */
import type { Page } from '@playwright/test';
import { assertDiscreteGpu, expect, expectNoErrors, openPage, saveScreenshot, test, waitIdle } from '../harness';

test.describe.configure({ timeout: 600_000 });

interface FoamFrame {
  mean: number;
  patches: number;
  largePatches: number;
  medianArea: number;
  largest: number;
  shiftCorrelation: number;
}

/** Foam statistics of the current frame (foam debug view on): coverage, connected patches, correlation at a shift. */
async function foamFrame(page: Page, shiftPx: number): Promise<FoamFrame> {
  return page.evaluate(async (shift) => {
    const img = await window.__lab!.renderer.readHdrPixels('hdr');
    const exposure = window.__lab!.renderer.exposureInfo().exposure;
    const w = img.width;
    const h = img.height;
    // The HDR target also holds the atmosphere's in-scatter (composited after the water): a smooth background
    // that the median of the frame (almost all of it foam-free) measures.
    const g = new Float32Array(w * h);
    for (let p = 0; p < w * h; p++) g[p] = img.data[p * 4 + 1]!;
    const background = Float32Array.from(g).sort()[(w * h) >> 1]!;
    const cov = new Float32Array(w * h);
    let sum = 0;
    for (let p = 0; p < w * h; p++) {
      cov[p] = Math.max(0, (g[p]! - background) / (2000 * exposure));
      sum += cov[p]!;
    }
    // Connected patches (4-neighbourhood) of pixels at least a quarter covered; a pixel is 0.24 m at 150 m.
    const lab = window.__ocean!;
    const a = lab.seaHit(w >> 1, h >> 1)!;
    const b = lab.seaHit((w >> 1) + 100, h >> 1)!;
    const R = 6371000;
    const metresPerPixel = (R * Math.acos(Math.min(1, a.dirFixed.x * b.dirFixed.x + a.dirFixed.y * b.dirFixed.y + a.dirFixed.z * b.dirFixed.z))) / 100;
    const seen = new Uint8Array(w * h);
    const areas: number[] = [];
    const stack: number[] = [];
    for (let p = 0; p < w * h; p++) {
      if (cov[p]! < 0.25 || seen[p]) continue;
      let area = 0;
      stack.push(p);
      seen[p] = 1;
      while (stack.length) {
        const q = stack.pop()!;
        area++;
        const x = q % w;
        const y = (q / w) | 0;
        if (x + 1 < w && cov[q + 1]! >= 0.25 && !seen[q + 1]) { seen[q + 1] = 1; stack.push(q + 1); }
        if (x > 0 && cov[q - 1]! >= 0.25 && !seen[q - 1]) { seen[q - 1] = 1; stack.push(q - 1); }
        if (y + 1 < h && cov[q + w]! >= 0.25 && !seen[q + w]) { seen[q + w] = 1; stack.push(q + w); }
        if (y > 0 && cov[q - w]! >= 0.25 && !seen[q - w]) { seen[q - w] = 1; stack.push(q - w); }
      }
      areas.push(area * metresPerPixel * metresPerPixel);
    }
    areas.sort((x, y) => x - y);
    const total = areas.reduce((x, y) => x + y, 0);
    // Area-weighted median: half of the foam area lies in patches at least this large.
    let acc = 0;
    let medianArea = 0;
    for (const v of areas) {
      acc += v;
      if (acc >= total / 2) {
        medianArea = v;
        break;
      }
    }
    // Correlation of the coverage with itself shifted by `shift` pixels along x and along y (the larger of the two).
    const mean = sum / (w * h);
    let varSum = 0;
    for (let p = 0; p < w * h; p++) varSum += (cov[p]! - mean) ** 2;
    const corr = (dx: number, dy: number): number => {
      let c = 0;
      let n = 0;
      for (let y = 0; y < h - dy; y += 1) {
        for (let x = 0; x < w - dx; x += 1) {
          c += (cov[y * w + x]! - mean) * (cov[(y + dy) * w + x + dx]! - mean);
          n++;
        }
      }
      return varSum > 0 ? c / n / (varSum / (w * h)) : 0;
    };
    return { mean, patches: areas.length, largePatches: areas.filter((v) => v >= 1).length, medianArea, largest: areas[areas.length - 1] ?? 0, shiftCorrelation: Math.max(corr(shift, 0), corr(0, shift)), metresPerPixel } as FoamFrame & { metresPerPixel: number };
  }, shiftPx);
}

test('whitecaps: calibrated to the statistical coverage of the far water, in patches, without repetition', async ({ page, pageLog }) => {
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
  const st = await page.evaluate(() => window.__ocean!.ocean!.debug.state());
  const statistical = Math.min(0.2, 3.84e-6 * st.windSpeed ** 3.41) * 0.4;
  // A pixel is about 0.24 m from 150 m: the patch length of the third cascade (72.5 m) is about 300 px.
  const shift = Math.round(st.cascades[2]!.length / 0.2416);
  const place = (k: number): Promise<void> => page.evaluate((i) => window.__ocean!.setCamera({ east: (i % 3) * 410 - 410, north: Math.floor(i / 3) * 530 - 530, alt: 150, heading: 0, pitch: -89.9 }), k);

  // Frozen time: each place shows the foam its level starts with.
  const frozen: FoamFrame[] = [];
  for (let i = 0; i < 9; i++) {
    await place(i);
    await waitIdle(page, 4);
    frozen.push(await foamFrame(page, shift));
    if (i === 4) await saveScreenshot(page, 'ocean', 'foam-coverage-debug');
  }
  // The running sea: breakers and what they have left behind over the last seconds.
  const running: FoamFrame[] = [];
  for (const i of [4, 0, 8]) {
    await place(i);
    await page.evaluate(() => window.__test!.setPaused(false));
    await page.evaluate(() => window.__test!.waitFrames(720));
    await page.evaluate(() => window.__test!.setPaused(true));
    await waitIdle(page, 4);
    running.push(await foamFrame(page, shift));
    if (i === 4) await saveScreenshot(page, 'ocean', 'foam-running-debug');
  }
  await page.evaluate(() => window.__ocean!.ocean!.debug.setDebugView('none'));
  await page.evaluate(() => window.__lab!.renderer.setExposureOverride(null));
  await waitIdle(page, 40);
  await saveScreenshot(page, 'ocean', 'foam-coverage-150m');

  const mean = (xs: FoamFrame[]): number => xs.reduce((a, b) => a + b.mean, 0) / xs.length;
  const line = (xs: FoamFrame[]): string => xs.map((s) => `${(s.mean * 100).toFixed(3)} % (${s.largePatches} patches of 1 m2 or more, half the area in patches of ${s.medianArea.toFixed(1)} m2 or more, largest ${s.largest.toFixed(0)} m2, correlation at ${shift} px ${s.shiftCorrelation.toFixed(3)})`).join('\n  ');
  console.log(`statistical (far water) ${(statistical * 100).toFixed(3)} %`);
  console.log(`frozen, per place:\n  ${line(frozen)}\n  mean ${(mean(frozen) * 100).toFixed(3)} %, ratio ${(mean(frozen) / statistical).toFixed(2)}`);
  console.log(`running 12 s:\n  ${line(running)}\n  mean ${(mean(running) * 100).toFixed(3)} %, ratio ${(mean(running) / statistical).toFixed(2)}`);
  expect(mean(frozen) / statistical).toBeGreaterThan(0.7);
  expect(mean(frozen) / statistical).toBeLessThan(1.4);
  expect(mean(running) / statistical).toBeGreaterThan(0.7);
  expect(mean(running) / statistical).toBeLessThan(1.4);
  // Patches, not specks.
  const all = [...frozen, ...running];
  const medians = all.map((s) => s.medianArea).sort((a, b) => a - b);
  expect(medians[medians.length >> 1]!).toBeGreaterThan(1.5);
  const patchCount = all.reduce((a, b) => a + b.largePatches, 0) / all.length;
  expect(patchCount).toBeGreaterThan(3);
  expect(patchCount).toBeLessThan(120);
  // No repetition at the cascade's period.
  for (const s of all) expect(s.shiftCorrelation).toBeLessThan(0.05);
  await expectNoErrors(page, pageLog);
});
