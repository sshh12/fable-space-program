/**
 * Check (f): exposure and HDR range with every render package present (ARCHITECTURE 10.4): a sunlit vehicle
 * against black space and a thin crescent Earth are exposed for the sunlit surface (within 0.5 EV of the
 * sunny-16 value, although almost nothing in the frame is lit), and the sun entering a dark-adapted frame
 * never produces a NaN or a value above HDR_MAX, in the scene target and after the resolve.
 */
import type { Page } from '@playwright/test';
import { EV_DARK_FLOOR } from '../../../src/render/core/post/exposure';
import { expect, test } from '../harness';
import { expectClean, openIntegration, record, requireFeatures, save } from './helpers';

test.describe.configure({ timeout: 600_000 });

const HDR_MAX = 60000;

interface Exposure {
  ev100: number;
  /** Factor from luminance (cd/m^2) to the pre-exposed values of the HDR targets. */
  exposure: number;
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
    return { ev100: e.ev100, exposure: e.exposure, sunny16: Math.log2(sun / (1.2 * Math.PI)), litFraction: e.litFraction, hdr, resolved };
  }, frames);
}

test('a sunlit vehicle against black space is exposed for sunlight, with every package present', async ({ page, pageLog }) => {
  const info = await openIntegration(page, 'scene=translunar&hud=0');
  requireFeatures(test, info, ['vehicle']);
  // From the sunlit side, 45 m away: the white hull fills a tenth of the frame against black space.
  await page.evaluate(() => window.__integration!.watchVesselFromSunSide(45, 35));
  const e = await exposure(page, 400);
  await save(page, 'exposure-vehicle-in-space');
  console.log(`vehicle in space [${info.loaded.join(', ')}]: EV100 ${e.ev100.toFixed(2)} vs sunny 16 ${e.sunny16.toFixed(2)}, lit ${(100 * e.litFraction).toFixed(2)} %, brightest ${(e.hdr.maxLuminance / e.exposure).toFixed(0)} cd/m^2, nan ${e.hdr.nanPixels} / ${e.resolved.nanPixels}`);
  record('f.vehicleInSpace', { loaded: info.loaded, ...e });
  expect(Math.abs(e.ev100 - e.sunny16)).toBeLessThan(0.5);
  // The sunlit hull is in the picture (a white surface in sunlight: thousands of cd/m^2), not its night side.
  expect(e.hdr.maxLuminance / e.exposure, 'brightest pixel of the frame (cd/m^2)').toBeGreaterThan(5000);
  expect(e.litFraction, 'share of the frame that holds lit geometry').toBeGreaterThan(0.005);
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
  // Dark adaptation proper: down to the floor (the last three stops take 25 s).
  await page.waitForFunction((floor) => window.__lab!.renderer.exposureInfo().ev100 <= floor + 0.02, EV_DARK_FLOOR, { timeout: 120_000 });
  dark = await exposure(page, 3);
  expect(dark.ev100, 'EV100 of the dark-adapted frame').toBeCloseTo(EV_DARK_FLOOR, 1);
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

test('from the seat the Earth in the window is shown at its own exposure and the cabin is keyed low (request cockpit-16); leaning to the window it fills the frame and is exposed as from outside (request cockpit-7)', async ({ page, pageLog }) => {
  const info = await openIntegration(page, 'scene=lowOrbit&roll=180&hud=0');
  requireFeatures(test, info, ['vehicle', 'cockpit']);
  interface WindowView {
    ev100: number;
    sunny16: number;
    outsideFraction: number;
    outsideWeight: number;
    evOutside: number;
    /** The gain on what lies beyond the cabin (1 = none) and the weight of the outside seen through the windows. */
    farGain: number;
    farWeight: number;
    /** Pre-exposed luminance (1 = display white before the tone curve) of what is seen through the windows and of the cabin. */
    outside: { mean: number; over: number };
    cabin: { mean: number };
  }
  /** The seat view aimed at the window with the Earth in it, the eye `lean` of the way to the window. */
  const view = (lean: number): Promise<WindowView | null> =>
    page.evaluate(async (l) => {
      if (!window.__integration!.sitAtWindowBelow(l)) return null;
      window.__lab!.camera.settings.fovY = (55 * Math.PI) / 180;
      const r = window.__lab!.renderer;
      for (let i = 0; i < 60; i++) {
        await window.__test!.waitFrames(30);
        const e = r.exposureInfo();
        if (Math.abs(e.ev100 - e.targetEv100) < 0.03) break;
      }
      await window.__test!.waitFrames(30);
      const e = r.exposureInfo();
      const depth = await r.readDepth();
      const img = await r.readHdrPixels('hdr');
      if (img.width !== depth.width || img.height !== depth.height) throw new Error('depth and colour targets differ in size');
      // Reversed z with the near plane of 0.05 m: geometry beyond the meter's interior range of 8 m.
      const farBelow = 0.05 / 8;
      let far = 0;
      let farSum = 0;
      let farOver = 0;
      let near = 0;
      let nearSum = 0;
      for (let i = 0; i < depth.data.length; i++) {
        const z = depth.data[i]!;
        if (z === 0) continue;
        const y = 0.2126 * img.data[i * 4]! + 0.7152 * img.data[i * 4 + 1]! + 0.0722 * img.data[i * 4 + 2]!;
        if (z < farBelow) {
          far++;
          farSum += y;
          if (y > 2) farOver++;
        } else {
          near++;
          nearSum += y;
        }
      }
      return {
        ev100: e.ev100,
        sunny16: Math.log2(r.frameContext!.sun.illuminance / (1.2 * Math.PI)),
        outsideFraction: e.outsideFraction,
        outsideWeight: e.outsideWeight,
        evOutside: e.evOutside,
        farGain: e.farGain,
        farWeight: e.farWeight,
        outside: { mean: farSum / Math.max(1, far), over: farOver / Math.max(1, far) },
        cabin: { mean: nearSum / Math.max(1, near) },
      };
    }, lean);

  const seat = await view(0);
  expect(seat, 'a cockpit seat and a window with the Earth in it').not.toBeNull();
  await save(page, 'exposure-window-from-seat');
  const leaning = await view(0.85);
  await save(page, 'exposure-window-leaning');
  const back = await view(0);
  const line = (v: WindowView): string =>
    `EV100 ${v.ev100.toFixed(2)}, outside ${(100 * v.outsideFraction).toFixed(1)} % of the frame (weight ${v.outsideWeight.toFixed(2)}), gain on it ${v.farGain.toFixed(4)} (weight ${v.farWeight.toFixed(2)}), outside shown at ${v.outside.mean.toFixed(2)} (${(100 * v.outside.over).toFixed(1)} % above 2), cabin at ${v.cabin.mean.toFixed(4)}`;
  console.log(`window metering [${info.loaded.join(', ')}], sunny 16 = ${seat!.sunny16.toFixed(2)}: from the seat ${line(seat!)}; leaning to the window ${line(leaning!)}; back in the seat ${line(back!)}`);
  record('f.windowMetering', { loaded: info.loaded, seat, leaning, back });
  // From the seat the windows are a twentieth of the frame: the cabin is metered and keyed low (two stops and
  // a quarter under mid-grey at most), and what shows through the windows has its own exposure: nine stops
  // over the cabin without it (every pixel far above white), now with its brightest tenth just under white.
  expect(seat!.outsideFraction).toBeLessThan(0.1);
  expect(seat!.outsideWeight).toBe(0);
  expect(seat!.farWeight).toBeGreaterThan(0.9);
  expect(seat!.ev100).toBeLessThan(seat!.sunny16 - 4);
  expect(seat!.farGain).toBeLessThan(0.1);
  // (The mean of the near pixels holds the flood lamp and the sunlit window wells, which clip: no upper bound.)
  expect(seat!.cabin.mean).toBeGreaterThan(0.008);
  expect(seat!.outside.mean).toBeGreaterThan(0.15);
  expect(seat!.outside.mean).toBeLessThan(1.6);
  expect(seat!.outside.over).toBeLessThan(0.15);
  // Leaning to the window the Earth fills the frame: exposed as an exterior camera exposes it (the day side a
  // stop or so under sunny 16), clouds below white, and the window frame a silhouette.
  expect(leaning!.outsideFraction).toBeGreaterThan(0.4);
  expect(leaning!.outsideWeight).toBe(1);
  // The exposure itself is the outside's there: the gain has nothing left to do.
  expect(leaning!.farGain).toBeGreaterThan(0.7);
  expect(leaning!.ev100).toBeGreaterThan(leaning!.sunny16 - 1.8);
  expect(leaning!.ev100).toBeLessThan(leaning!.sunny16 + 0.5);
  expect(leaning!.outside.mean).toBeGreaterThan(0.06);
  expect(leaning!.outside.mean).toBeLessThan(0.7);
  expect(leaning!.outside.over).toBeLessThan(0.02);
  expect(leaning!.cabin.mean).toBeLessThan(0.02);
  // Back in the seat the cabin is readable again, and the window has its own exposure again.
  expect(back!.outsideWeight).toBe(0);
  expect(back!.cabin.mean).toBeGreaterThan(0.008);
  expect(back!.farGain).toBeLessThan(0.1);
  await expectClean(page, pageLog, info);
});


test('on the pad, from the seat, the daylight sky in the windows has its own exposure (request cockpit-16)', async ({ page, pageLog }) => {
  const info = await openIntegration(page, 'scene=pad&hud=0');
  requireFeatures(test, info, ['vehicle', 'cockpit']);
  const seated = await page.evaluate(() => window.__integration!.sitInCockpit(0, 0));
  expect(seated).toBe(true);
  const e = await page.evaluate(async () => {
    const r = window.__lab!.renderer;
    for (let i = 0; i < 40; i++) {
      await window.__test!.waitFrames(30);
      const x = r.exposureInfo();
      if (Math.abs(x.ev100 - x.targetEv100) < 0.03) break;
    }
    await window.__test!.waitFrames(30);
    const x = r.exposureInfo();
    return { ev100: x.ev100, farGain: x.farGain, farLevel: x.farLevel, farWeight: x.farWeight, outsideFraction: x.outsideFraction, sunny16: Math.log2(r.frameContext!.sun.illuminance / (1.2 * Math.PI)) };
  });
  await save(page, 'exposure-pad-from-seat');
  console.log(`pad from the seat [${info.loaded.join(', ')}]: EV100 ${e.ev100.toFixed(2)} (sunny 16 = ${e.sunny16.toFixed(2)}), the outside's level ${e.farLevel.toFixed(0)} cd/m^2, weight ${e.farWeight.toFixed(2)}, gain ${e.farGain.toFixed(4)}, lit geometry beyond the cabin ${(100 * e.outsideFraction).toFixed(1)} % of the frame`);
  record('f.padFromSeat', { loaded: info.loaded, ...e });
  // Where the windows show the day (sky or ground), it is shown under white, not at the cabin's exposure.
  if (e.farWeight > 0.5) expect(e.farGain).toBeLessThan(0.5);
  expect(e.farGain).toBeLessThanOrEqual(1);
  await expectClean(page, pageLog, info);
});

test('the lunar surface scene stands in sunlight when no sun is pinned: a morning sun over the landing site and a daylight exposure (request vfx-10)', async ({ page, pageLog }) => {
  const info = await openIntegration(page, 'scene=lunarSurface&hud=0&hover=8');
  requireFeatures(test, info, ['terrain']);
  const e = await exposure(page, 300);
  // The sun's elevation over the ground under the camera (the camera stands a few metres from the site).
  const elevation = await page.evaluate(() => {
    const f = window.__lab!.renderer.frameContext!;
    const nearest = [...f.bodies].sort((a, b) => a.cameraAltitude - b.cameraAltitude)[0]!;
    const c = nearest.centerRelCam;
    const len = Math.hypot(c.x, c.y, c.z);
    const s = f.sun.dirRoot;
    return { body: nearest.id, deg: (Math.asin(-(c.x * s.x + c.y * s.y + c.z * s.z) / len) * 180) / Math.PI };
  });
  await save(page, 'exposure-lunar-surface-default-sun');
  console.log(`lunar surface, no sun pinned [${info.loaded.join(', ')}]: the sun ${elevation.deg.toFixed(1)} degrees over the ground of ${elevation.body}, EV100 ${e.ev100.toFixed(2)} (sunny 16 = ${e.sunny16.toFixed(2)}), brightest ${(e.hdr.maxLuminance / e.exposure).toFixed(0)} cd/m^2`);
  record('f.lunarSurfaceDefaultSun', { loaded: info.loaded, elevation, ...e });
  expect(elevation.deg).toBeGreaterThan(10);
  expect(elevation.deg).toBeLessThan(14);
  // A day exposure (the scene metered EV100 -0.6 in the dark), and sunlit ground in the frame.
  expect(e.ev100).toBeGreaterThan(9);
  expect(e.hdr.maxLuminance / e.exposure, 'brightest pixel of the frame (cd/m^2)').toBeGreaterThan(200);
  await expectClean(page, pageLog, info);
});

test('a cut to the cockpit is exposed for the cabin within half a second (request cockpit-14)', async ({ page, pageLog }) => {
  const info = await openIntegration(page, 'scene=lowOrbit&hud=0');
  requireFeatures(test, info, ['vehicle', 'cockpit']);
  // A sunlit exterior first: the vehicle from its sunlit side, the exposure settled on daylight.
  await page.evaluate(() => window.__integration!.watchVesselFromSunSide(45, 35));
  const outside = await exposure(page, 300);
  expect(Math.abs(outside.ev100 - outside.sunny16)).toBeLessThan(0.75);
  // The cut: the seat, one frame to the next.
  const seated = await page.evaluate(() => window.__integration!.sitInCockpit(0, 0));
  expect(seated).toBe(true);
  const after30 = await exposure(page, 30);
  await save(page, 'exposure-cut-to-cockpit-30-frames');
  const settled = await exposure(page, 600);
  await save(page, 'exposure-cut-to-cockpit-settled');
  console.log(`cut to the cockpit: outside EV100 ${outside.ev100.toFixed(2)}, 30 frames after the cut ${after30.ev100.toFixed(2)}, settled ${settled.ev100.toFixed(2)}`);
  record('f.cutToCockpit', { outside: outside.ev100, after30Frames: after30.ev100, settled: settled.ev100 });
  // The cabin is many stops under daylight, and half a second after the cut the exposure is the cabin's.
  expect(outside.ev100 - settled.ev100).toBeGreaterThan(4);
  expect(Math.abs(after30.ev100 - settled.ev100)).toBeLessThan(0.75);
  // And back out: daylight again within the same half second.
  await page.evaluate(() => window.__integration!.watchVesselFromSunSide(45, 35));
  const back = await exposure(page, 30);
  expect(Math.abs(back.ev100 - outside.ev100)).toBeLessThan(0.75);
  await expectClean(page, pageLog, info);
});
