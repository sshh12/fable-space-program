/**
 * Cloud layers that the march does not resolve: seen edge-on from 5 to 10 km (a horizon bank hundreds of
 * kilometres away, two or three pixel rows deep) and towards the limb from low orbit. What is checked is
 * that the picture does not depend on the sampling:
 *
 *   frozen = accumulated   a deterministic frame (frozen step phase) is the frame that the animated,
 *                          temporally accumulated march converges to (no bars hidden by the accumulation)
 *   no row period          the rows of the layer carry no component of period two (the checkerboard lattice)
 *                          beyond the detail the picture has at three and four rows
 *
 * Screenshots: sampling-*.png (deterministic) and sampling-*-animated.png.
 */
import type { Page } from '@playwright/test';
import { expect, expectNoErrors, test, waitIdle } from '../harness';
import { openLab, PAD, setScene, shot, type LabView } from './lab';

interface View {
  name: string;
  view: LabView;
  /** Region of the unresolved layer, as fractions of the render target: x0, y0, x1, y1. */
  region: [number, number, number, number];
}

const SUN = { azDeg: 160, elDeg: 50 };
const VIEWS: View[] = [
  { name: 'ascent-10km-horizon', view: { ...PAD, alt: 10_000, headingDeg: 35, pitchDeg: 0, fovDeg: 60 }, region: [0.3, 0.5, 1.0, 0.63] },
  { name: 'ascent-5km-horizon', view: { ...PAD, alt: 5_000, headingDeg: 35, pitchDeg: 0, fovDeg: 60 }, region: [0.0, 0.47, 1.0, 0.6] },
  { name: 'low-orbit-limb', view: { ...PAD, alt: 400_000, headingDeg: 35, pitchDeg: -18, fovDeg: 60 }, region: [0.0, 0.5, 0.36, 0.85] },
];

interface Region {
  width: number;
  height: number;
  lum: number[];
}

async function readRegion(page: Page, r: [number, number, number, number]): Promise<Region> {
  return page.evaluate(async (rect) => {
    const lab = window.__atmo!;
    const [w, h] = lab.app.renderer.frameContext!.renderSize;
    const x = Math.floor(rect[0] * w);
    const y = Math.floor(rect[1] * h);
    const width = Math.min(w - x, Math.ceil((rect[2] - rect[0]) * w));
    const height = Math.min(h - y, Math.ceil((rect[3] - rect[1]) * h));
    // After the temporal anti-aliasing: what goes to the tone mapper.
    const px = await lab.readLuminance({ x, y, width, height }, 'resolved');
    const lum: number[] = [];
    for (let i = 0; i < width * height; i++) lum.push(0.2126 * px.data[i * 4]! + 0.7152 * px.data[i * 4 + 1]! + 0.0722 * px.data[i * 4 + 2]!);
    return { width, height, lum };
  }, r);
}

/** Amplitude of the component of period `period` rows in the row means of a region, relative to their local mean. */
function rowAmplitude(region: Region, period: number): number {
  const sums: number[] = [];
  for (let y = 0; y < region.height; y++) {
    let s = 0;
    for (let x = 0; x < region.width; x++) s += region.lum[y * region.width + x]!;
    sums.push(s);
  }
  const f = 1 / period;
  const response = 1 - (1 + Math.cos(2 * Math.PI * f)) / 2;
  let re = 0;
  let im = 0;
  let n = 0;
  for (let i = 1; i < sums.length - 1; i++) {
    const local = (sums[i - 1]! + 2 * sums[i]! + sums[i + 1]!) / 4;
    if (local <= 0) continue;
    const v = sums[i]! / local - 1;
    re += v * Math.cos(2 * Math.PI * f * i);
    im += v * Math.sin(2 * Math.PI * f * i);
    n++;
  }
  return n > 0 ? (2 * Math.hypot(re, im)) / n / response : 0;
}

test('unresolved cloud layers: a frozen step phase gives the accumulated picture, and no row lattice', async ({ page, pageLog }) => {
  test.setTimeout(300_000);
  await openLab(page, '');
  const failures: string[] = [];
  for (const v of VIEWS) {
    await page.evaluate(() => window.__atmo!.app.renderer.setExposureOverride(14.6));
    await setScene(page, v.view, SUN);
    await page.evaluate(() => {
      window.__test!.setPaused(true);
      window.__test!.setDeterministic(true);
    });
    await waitIdle(page, 64);
    await shot(page, `sampling-${v.name}`);
    const frozen = await readRegion(page, v.region);
    // The same view with the noise running (time stays frozen: the clouds do not move), left to accumulate.
    await page.evaluate(() => window.__test!.setDeterministic(false));
    await waitIdle(page, 96);
    await shot(page, `sampling-${v.name}-animated`);
    const animated = await readRegion(page, v.region);

    let sum = 0;
    let diff = 0;
    let off = 0;
    for (let i = 0; i < frozen.lum.length; i++) {
      const a = frozen.lum[i]!;
      const b = animated.lum[i]!;
      sum += 0.5 * (a + b);
      diff += Math.abs(a - b);
      if (Math.abs(a - b) > 0.25 * Math.max(0.5 * (a + b), 1)) off++;
    }
    const mean = diff / Math.max(sum, 1e-9);
    const share = off / frozen.lum.length;
    const p2 = rowAmplitude(frozen, 2);
    const ref = Math.max(rowAmplitude(frozen, 3), rowAmplitude(frozen, 4));
    console.log(
      `[sampling] ${v.name}: frozen vs accumulated mean difference ${(mean * 100).toFixed(2)} %, pixels off by more than 25 %: ${(share * 100).toFixed(2)} %; ` +
        `row period 2: ${(p2 * 100).toFixed(2)} % (detail at 3-4 rows ${(ref * 100).toFixed(2)} %)`,
    );
    if (mean > 0.03) failures.push(`${v.name}: frozen and accumulated frames differ by ${(mean * 100).toFixed(2)} % on average`);
    if (share > 0.02) failures.push(`${v.name}: ${(share * 100).toFixed(2)} % of the pixels differ by more than 25 %`);
    if (p2 > 0.004 + 1.5 * ref) failures.push(`${v.name}: rows alternate by ${(p2 * 100).toFixed(2)} % against ${(ref * 100).toFixed(2)} % of detail`);
  }
  expect(failures).toEqual([]);
  await expectNoErrors(page, pageLog);
});
