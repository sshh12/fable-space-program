/**
 * Check (f): exposure and HDR range with every render package present (ARCHITECTURE 10.4): a sunlit vehicle
 * against black space and a thin crescent Earth are exposed for the sunlit surface (within 0.5 EV of the
 * sunny-16 value, although almost nothing in the frame is lit), and the sun entering a dark-adapted frame
 * never produces a NaN or a value above HDR_MAX, in the scene target and after the resolve.
 */
import type { Page } from '@playwright/test';
import { expect, test } from '../harness';
import { expectClean, openIntegration, record, requireFeatures, save } from './helpers';

test.describe.configure({ timeout: 600_000 });

const HDR_MAX = 60000;

interface Exposure {
  ev100: number;
  sunny16: number;
  litFraction: number;
  hdr: { maxLuminance: number; nanPixels: number };
  resolved: { maxLuminance: number; nanPixels: number };
}

/** Let the exposure adapt for `frames` frames, then read it with the HDR statistics of both targets. */
async function exposure(page: Page, frames: number): Promise<Exposure> {
  return page.evaluate(async (n) => {
    await window.__test!.waitFrames(n);
    const r = window.__lab!.renderer;
    const e = r.exposureInfo();
    const sun = r.frameContext!.sun.illuminance;
    const hdr = await r.readHdrStats('hdr');
    const resolved = await r.readHdrStats('resolved');
    return { ev100: e.ev100, sunny16: Math.log2(sun / (1.2 * Math.PI)), litFraction: e.litFraction, hdr, resolved };
  }, frames);
}

test('a sunlit vehicle against black space is exposed for sunlight, with every package present', async ({ page, pageLog }) => {
  const info = await openIntegration(page, 'scene=translunar&orbit=30,15,90&hud=0');
  requireFeatures(test, info, ['vehicle']);
  const e = await exposure(page, 400);
  await save(page, 'exposure-vehicle-in-space');
  console.log(`vehicle in space [${info.loaded.join(', ')}]: EV100 ${e.ev100.toFixed(2)} vs sunny 16 ${e.sunny16.toFixed(2)}, lit ${(100 * e.litFraction).toFixed(2)} %, nan ${e.hdr.nanPixels} / ${e.resolved.nanPixels}`);
  record('f.vehicleInSpace', { loaded: info.loaded, ...e });
  expect(Math.abs(e.ev100 - e.sunny16)).toBeLessThan(0.5);
  expect(e.hdr.nanPixels).toBe(0);
  expect(e.resolved.nanPixels).toBe(0);
  expect(e.hdr.maxLuminance).toBeLessThanOrEqual(HDR_MAX * 1.0001);
  await expectClean(page, pageLog, info);
});

test('a thin crescent Earth is exposed for its sunlit limb, not for the night side', async ({ page, pageLog }) => {
  const info = await openIntegration(page, 'scene=translunar&hud=0');
  await page.evaluate(() => {
    const lab = window.__integration!;
    lab.viewBodyAtPhase(lab.app.defs.rootBodyId, 160, 6e7);
  });
  const e = await exposure(page, 500);
  await save(page, 'exposure-crescent-earth');
  console.log(`crescent Earth [${info.loaded.join(', ') || 'LabPlanet only'}]: EV100 ${e.ev100.toFixed(2)} vs sunny 16 ${e.sunny16.toFixed(2)}, lit ${(100 * e.litFraction).toFixed(2)} %, nan ${e.hdr.nanPixels} / ${e.resolved.nanPixels}`);
  record('f.crescentEarth', { loaded: info.loaded, ...e });
  expect(e.litFraction).toBeLessThan(0.1);
  expect(Math.abs(e.ev100 - e.sunny16)).toBeLessThan(0.5);
  expect(e.hdr.nanPixels).toBe(0);
  expect(e.resolved.nanPixels).toBe(0);
  expect(e.hdr.maxLuminance).toBeLessThanOrEqual(HDR_MAX * 1.0001);
  await expectClean(page, pageLog, info);
});

test('the sun entering a dark-adapted frame saturates at HDR_MAX without NaN, and the exposure recovers', async ({ page, pageLog }) => {
  const info = await openIntegration(page, 'scene=translunar&hud=0');
  requireFeatures(test, info, ['sky']);
  // Look away from the sun, at a direction with nothing lit in view, until the eye is dark adapted.
  let dark: Exposure | null = null;
  let start = 0;
  const tried: string[] = [];
  for (const offset of [120, 150, 95, 170]) {
    await page.evaluate((o) => window.__integration!.lookNearSun(o, 400), offset);
    const e = await exposure(page, 420);
    tried.push(`${offset} deg from the sun: EV100 ${e.ev100.toFixed(2)}, lit ${(100 * e.litFraction).toFixed(3)} %`);
    if (e.litFraction < 0.005 && e.ev100 < 3) {
      dark = e;
      start = offset;
      break;
    }
  }
  expect(dark, `a dark-adapted view exists (${tried.join('; ')})`).not.toBeNull();
  // Turn towards the sun, 3 degrees per step, a few frames per step.
  let worstNan = 0;
  let peak = 0;
  for (let offset = start; offset >= 0; offset -= 3) {
    await page.evaluate((o) => window.__integration!.lookNearSun(o, 400), offset);
    const e = await exposure(page, 3);
    worstNan = Math.max(worstNan, e.hdr.nanPixels, e.resolved.nanPixels);
    peak = Math.max(peak, e.hdr.maxLuminance, e.resolved.maxLuminance);
  }
  await page.evaluate(() => window.__integration!.lookNearSun(0, 400));
  const atSun = await exposure(page, 6);
  await save(page, 'exposure-sun-enters-dark-frame');
  const settled = await exposure(page, 500);
  await save(page, 'exposure-sun-settled');
  console.log(`sun into a dark frame [${info.loaded.join(', ')}]: dark EV100 ${dark!.ev100.toFixed(2)}, peak ${peak.toFixed(0)}, NaN ${worstNan}, EV100 with the sun in view ${atSun.ev100.toFixed(2)} -> ${settled.ev100.toFixed(2)} (sunny 16 ${settled.sunny16.toFixed(2)})`);
  record('f.sunEntersDarkFrame', { loaded: info.loaded, darkEv: dark!.ev100, peak, worstNan, settledEv: settled.ev100, sunny16: settled.sunny16 });
  expect(worstNan).toBe(0);
  expect(atSun.hdr.nanPixels + atSun.resolved.nanPixels + settled.hdr.nanPixels + settled.resolved.nanPixels).toBe(0);
  // The disc saturates exactly at the limit (it is far brighter at this exposure) and never exceeds it.
  expect(peak).toBeGreaterThan(0.9 * HDR_MAX);
  expect(peak).toBeLessThanOrEqual(HDR_MAX * 1.0001);
  // With the disc in view the camera stops down again.
  expect(settled.ev100).toBeGreaterThan(dark!.ev100 + 8);
  await expectClean(page, pageLog, info);
});
