/**
 * Effects and the exposure (items 1 and 2 of the wave-2 visual review).
 *
 *  - By day an effect that enters the frame must not move the camera's exposure: the meter exposes for what
 *    is lit (docs/requests/vfx-4.md), the flame, the white water and the fireball clip. Measured on the sky,
 *    which nothing in the scene lights: its pre-exposed value is proportional to the exposure.
 *  - At night the plume must light what a player sees: the pad around the mount, in cd/m^2 and as displayed.
 */
import type {} from '../../../labs/vfx/main';
import { expect, expectNoErrors, test, waitIdle } from '../harness';
import { openLab } from './helpers';

test.describe.configure({ timeout: 600_000 });

/** Median pre-exposed luminance of a 9 x 9 patch of the HDR target around a pixel, and the EV100 of the frame. */
async function patch(page: import('@playwright/test').Page, at: { x: number; y: number }): Promise<{ value: number; ev100: number }> {
  return page.evaluate(async (p) => {
    const renderer = window.__vfx!.app.renderer;
    const px = await renderer.readHdrPixels('hdr', { x: Math.round(p.x) - 4, y: Math.round(p.y) - 4, width: 9, height: 9 });
    const lum: number[] = [];
    for (let i = 0; i < px.data.length; i += 4) lum.push(0.2126 * px.data[i]! + 0.7152 * px.data[i + 1]! + 0.0722 * px.data[i + 2]!);
    lum.sort((a, b) => a - b);
    return { value: lum[lum.length >> 1]!, ev100: renderer.exposureInfo().ev100 };
  }, at);
}

/** A pixel of open sky: top of the frame, a quarter of the width in from the left. */
const skyPixel = (page: import('@playwright/test').Page): Promise<{ x: number; y: number }> =>
  page.evaluate(() => {
    const [w, h] = window.__vfx!.app.renderer.frameContext!.renderSize;
    return { x: 0.25 * w, y: 0.06 * h };
  });

test('by day the sky of the pad scene keeps its exposure when nine engines are lit (less than half a stop)', async ({ page, pageLog }) => {
  await openLab(page, 'scene=pad');
  await page.evaluate(() => window.__vfx!.runTo(7));
  const sky = await skyPixel(page);
  const read = async (on: number): Promise<{ value: number; ev100: number }> => {
    await page.evaluate((x) => window.__vfx!.scene.controls!.engines!(x), on);
    await waitIdle(page, 90);
    return patch(page, sky);
  };
  const lit = await read(1);
  const off = await read(0);
  const again = await read(1);
  const stops = Math.log2(off.value / lit.value);
  console.log(`pad by day, T+3 s: EV100 ${lit.ev100.toFixed(2)} with the engines on, ${off.ev100.toFixed(2)} off, ${again.ev100.toFixed(2)} on again; sky ${lit.value.toFixed(4)} / ${off.value.toFixed(4)} pre-exposed (${stops.toFixed(2)} EV)`);
  expect(lit.value).toBeGreaterThan(0);
  expect(Math.abs(stops)).toBeLessThan(0.5);
  expect(Math.abs(lit.ev100 - off.ev100)).toBeLessThan(0.5);
  // A daylight exposure: within a stop and a half of sunny 16 (EV 14.7 at the ground).
  expect(lit.ev100).toBeGreaterThan(13.2);
  expect(lit.ev100).toBeLessThan(16.2);
  await expectNoErrors(page, pageLog);
});

test('the sky keeps its value through the splash sequence (within 5 % once the capsule is in the water)', async ({ page, pageLog }) => {
  // (The lab holds the camera of a sea scene at the exposure of a real sea; here the meter is left to itself.)
  await openLab(page, 'scene=splash&minev=-10');
  const sky = await skyPixel(page);
  const rows: { t: number; value: number; ev100: number }[] = [];
  // Just before the impact (2.05 s of lab time), then +0.1, +0.4, +1, +1.8 and +2.5 s.
  for (const t of [1.9, 2.15, 2.45, 3.05, 3.85, 4.55]) {
    await page.evaluate((x) => window.__vfx!.runTo(x), t);
    // (The first picture is the reference: the meter is given time to settle on the scene before the impact,
    // so that the step measured is the impact and not how far the meter had come since the page opened.)
    await waitIdle(page, t === 1.9 ? 240 : 60);
    rows.push({ t, ...(await patch(page, sky)) });
  }
  console.log(`splash: sky (pre-exposed) ${rows.map((r) => `${r.t} s: ${r.value.toFixed(4)} at EV ${r.ev100.toFixed(2)}`).join(', ')}`);
  // Crown, spray, mist and foam come and go between +0.1 s and +2.5 s: the sky does not notice. (Between the
  // last frame in the air and the first in the water the meter loses the white hull that went under: a
  // quarter of a stop in this lab, a change of the scene and not of the effect; bounded here all the same.)
  const before = rows[0]!.value;
  const inWater = rows[1]!.value;
  expect(before).toBeGreaterThan(0);
  expect(Math.abs(Math.log2(inWater / before))).toBeLessThan(0.4);
  for (const r of rows.slice(1)) expect(Math.abs(r.value / inWater - 1), `sky at ${r.t} s`).toBeLessThan(0.05);
  await expectNoErrors(page, pageLog);
});

test('a fireball by day does not darken the sky around it (within 5 %)', async ({ page, pageLog }) => {
  await openLab(page, 'scene=explosion');
  const sky = await skyPixel(page);
  const rows: { t: number; value: number }[] = [];
  for (const t of [0.9, 1.03, 1.2, 1.6, 2.5, 4.5]) {
    await page.evaluate((x) => window.__vfx!.runTo(x), t);
    await waitIdle(page, 60);
    rows.push({ t, value: (await patch(page, sky)).value });
  }
  console.log(`explosion by day: sky (pre-exposed) ${rows.map((r) => `${r.t} s: ${r.value.toFixed(4)}`).join(', ')}`);
  const before = rows[0]!.value;
  for (const r of rows) expect(Math.abs(r.value / before - 1), `sky at ${r.t} s`).toBeLessThan(0.05);
  await expectNoErrors(page, pageLog);
});

test('at night the plume lights the pad: the ground 100 to 300 m from the mount is seen at T+10 s', async ({ page, pageLog }) => {
  await openLab(page, 'scene=pad&night=1');
  await page.evaluate(() => window.__vfx!.runTo(14));
  await waitIdle(page, 90);
  const result = await page.evaluate(async () => {
    const lab = window.__vfx!;
    const renderer = lab.app.renderer;
    const [w, h] = renderer.frameContext!.renderSize;
    const ev100 = renderer.exposureInfo().ev100;
    const exposure = 1 / (1.2 * 2 ** ev100);
    const out: { distance: number; luminance: number; shown: number }[] = [];
    for (const distance of [100, 200, 300]) {
      // The DIMMEST of the eight directions that are in the frame: bare ground, not the lit cloud over it.
      let best = Infinity;
      for (let k = 0; k < 8; k++) {
        const a = (k / 8) * 2 * Math.PI;
        const p = lab.project({ x: distance * Math.cos(a), y: distance * Math.sin(a), z: 0.05 });
        if (!p || p.x < 6 || p.y < 6 || p.x > w - 7 || p.y > h - 7) continue;
        const px = await renderer.readHdrPixels('hdr', { x: Math.round(p.x) - 2, y: Math.round(p.y) - 2, width: 5, height: 5 });
        const lum: number[] = [];
        for (let i = 0; i < px.data.length; i += 4) lum.push(0.2126 * px.data[i]! + 0.7152 * px.data[i + 1]! + 0.0722 * px.data[i + 2]!);
        lum.sort((x, y) => x - y);
        best = Math.min(best, lum[12]!);
      }
      if (!Number.isFinite(best)) best = 0;
      out.push({ distance, luminance: best / exposure, shown: best });
    }
    return { ev100, out, lights: lab.feature.debug.lights().length };
  });
  console.log(`pad at night, T+10 s: EV100 ${result.ev100.toFixed(2)}, ${result.lights} lights; ground ${result.out.map((r) => `${r.distance} m: ${r.luminance.toFixed(0)} cd/m^2 (${r.shown.toFixed(3)} of white 1.0)`).join(', ')}`);
  // The camera has opened up for what the flame lights (a daylight exposure would be EV 14.7 and more).
  expect(result.ev100).toBeLessThan(14.5);
  // Lit ground: hundreds of cd/m^2 at 100 m, tens at 300 m, and out of the black as displayed.
  expect(result.out[0]!.luminance).toBeGreaterThan(300);
  expect(result.out[1]!.luminance).toBeGreaterThan(100);
  expect(result.out[2]!.luminance).toBeGreaterThan(40);
  for (const r of result.out) expect(r.shown, `ground at ${r.distance} m as displayed`).toBeGreaterThan(0.006);
  await expectNoErrors(page, pageLog);
});
