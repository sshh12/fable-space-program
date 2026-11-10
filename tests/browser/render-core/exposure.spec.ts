import type { Page } from '@playwright/test';
import { assertDiscreteGpu, expect, expectNoErrors, openPage, saveScreenshot, test, waitIdle } from '../harness';

/** Sunny-16 EV100 for the frame's (unoccluded) solar illuminance. */
const sunny16 = (page: Page): Promise<number> => page.evaluate(() => Math.log2(window.__lab!.renderer.frameContext!.sun.illuminance / (1.2 * Math.PI)));
const exposure = (page: Page): ReturnType<typeof info> => info(page);
function info(page: Page): Promise<{ ev100: number; targetEv100: number; litFraction: number; histogramWeight: number; evPrior: number; evHistogram: number; sunVisibility: number }> {
  return page.evaluate(() => window.__lab!.renderer.exposureInfo());
}
const settled = (page: Page): Promise<unknown> =>
  page.waitForFunction(() => {
    const e = window.__lab!.renderer.exposureInfo();
    return Math.abs(e.ev100 - e.targetEv100) < 0.02;
  }, undefined, { timeout: 60_000 });

/** Put the sun at `phaseDeg` from the camera direction as seen from the active vessel (0 = behind the camera). */
async function sunAtPhase(page: Page, phaseDeg: number): Promise<void> {
  await page.evaluate((phase) => {
    window.__rc!.setSunOverride({
      dirRoot: (s) => {
        const cam = window.__lab!.cameraState().positionRoot;
        const v = s.vessels.find((x) => x.id === s.activeVesselId)!.rRoot;
        const d = { x: cam.x - v.x, y: cam.y - v.y, z: cam.z - v.z };
        const l = Math.hypot(d.x, d.y, d.z);
        const toCam = { x: d.x / l, y: d.y / l, z: d.z / l };
        // Any axis perpendicular to toCam; rotate toCam about it by the phase angle.
        const a = Math.abs(toCam.z) < 0.9 ? { x: 0, y: 0, z: 1 } : { x: 1, y: 0, z: 0 };
        const p = { x: toCam.y * a.z - toCam.z * a.y, y: toCam.z * a.x - toCam.x * a.z, z: toCam.x * a.y - toCam.y * a.x };
        const pl = Math.hypot(p.x, p.y, p.z);
        const c = Math.cos((phase * Math.PI) / 180);
        const sn = Math.sin((phase * Math.PI) / 180);
        return { x: toCam.x * c + (p.x / pl) * sn, y: toCam.y * c + (p.y / pl) * sn, z: toCam.z * c + (p.z / pl) * sn };
      },
    });
  }, phaseDeg);
}

test('a sunlit object covering 3 % of a black frame exposes within 0.5 EV of sunny 16; a dark frame reaches the floor; eclipse adapts', async ({ page, pageLog }) => {
  // Translunar space, no planet: only a white 5 m ball at the vessel, 33 m from the camera.
  await openPage(page, '/labs/render-core/?scene=translunar&planet=0&stand=0&probe=ball&orbit=20,10,33&hud=0');
  await assertDiscreteGpu(page);
  await sunAtPhase(page, 35);
  await waitIdle(page, 30);
  await settled(page);
  const e = await exposure(page);
  const s16 = await sunny16(page);
  console.log(`3 % object: EV100 ${e.ev100.toFixed(2)} (sunny 16 = ${s16.toFixed(2)}), lit fraction ${(e.litFraction * 100).toFixed(2)} %, histogram weight ${e.histogramWeight.toFixed(2)}, evHistogram ${e.evHistogram.toFixed(2)}`);
  expect(e.litFraction).toBeGreaterThan(0.015);
  expect(e.litFraction).toBeLessThan(0.045);
  expect(Math.abs(e.ev100 - s16)).toBeLessThan(0.5);
  const lit = await saveScreenshot(page, 'render-core', 'exposure-object-3pct');
  expect(lit.stats.maxLuma).toBeGreaterThan(150);
  expect(lit.stats.maxLuma).toBeLessThan(254.5); // not clipped

  // Eclipse: the Earth covers the sun as seen from the vessel. The object goes dark and the exposure opens up.
  await page.evaluate(() => {
    window.__rc!.setSunOverride({
      dirRoot: (s) => {
        const root = s.bodies.find((b) => b.id === window.__lab!.defs.rootBodyId)!.rRoot;
        const v = s.vessels.find((x) => x.id === s.activeVesselId)!.rRoot;
        const d = { x: root.x - v.x, y: root.y - v.y, z: root.z - v.z };
        const l = Math.hypot(d.x, d.y, d.z);
        return { x: d.x / l, y: d.y / l, z: d.z / l };
      },
    });
  });
  await page.waitForFunction(() => window.__lab!.renderer.exposureInfo().sunVisibility === 0);
  await page.waitForFunction(() => window.__lab!.renderer.exposureInfo().ev100 < 0, undefined, { timeout: 60_000 });
  await settled(page);
  const dark = await exposure(page);
  console.log(`eclipsed: EV100 ${dark.ev100.toFixed(2)}`);
  expect(dark.ev100).toBeLessThan(-2.5);
  await saveScreenshot(page, 'render-core', 'exposure-eclipsed');

  // Out of the eclipse again: back to the sunlit exposure.
  await sunAtPhase(page, 35);
  await page.waitForFunction(() => window.__lab!.renderer.exposureInfo().ev100 > 14, undefined, { timeout: 60_000 });
  await settled(page);
  expect(Math.abs((await exposure(page)).ev100 - s16)).toBeLessThan(0.5);

  // A fully dark frame: look away from the ball, the Earth and the Moon -> the dark-adapted floor.
  await page.evaluate(() => {
    const lab = window.__lab!;
    const s = lab.snapshot();
    const v = s.vessels.find((x) => x.id === s.activeVesselId)!.rRoot;
    const sun = s.bodies.find((b) => b.id === s.starId)!.rRoot;
    const root = s.bodies.find((b) => b.id === lab.defs.rootBodyId)!.rRoot;
    // Look along (vessel -> sun) x (vessel -> root): perpendicular to both the sun and the Earth.
    const a = { x: sun.x - v.x, y: sun.y - v.y, z: sun.z - v.z };
    const b = { x: root.x - v.x, y: root.y - v.y, z: root.z - v.z };
    const f = { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x };
    const fl = Math.hypot(f.x, f.y, f.z);
    const fwd = { x: f.x / fl, y: f.y / fl, z: f.z / fl };
    const al = Math.hypot(a.x, a.y, a.z);
    const up = { x: a.x / al, y: a.y / al, z: a.z / al };
    const right = { x: fwd.y * up.z - fwd.z * up.y, y: fwd.z * up.x - fwd.x * up.z, z: fwd.x * up.y - fwd.y * up.x };
    // Quaternion from the basis (right, up, -forward).
    const m = [right.x, up.x, -fwd.x, right.y, up.y, -fwd.y, right.z, up.z, -fwd.z];
    const tr = m[0]! + m[4]! + m[8]!;
    const w = Math.sqrt(Math.max(0, 1 + tr)) / 2;
    const q = { x: (m[7]! - m[5]!) / (4 * w), y: (m[2]! - m[6]!) / (4 * w), z: (m[3]! - m[1]!) / (4 * w), w };
    lab.camera.spec = { type: 'free', positionRoot: { x: v.x + fwd.x * 200, y: v.y + fwd.y * 200, z: v.z + fwd.z * 200 }, qViewToRoot: q };
  });
  await page.waitForFunction(() => window.__lab!.renderer.exposureInfo().targetEv100 === -3, undefined, { timeout: 30_000 });
  await settled(page);
  const floor = await exposure(page);
  expect(floor.ev100).toBeCloseTo(-3, 1);
  expect(floor.litFraction).toBe(0);
  await expectNoErrors(page, pageLog);
});

test('a thin crescent of a body exposes within 0.5 EV of sunny 16', async ({ page, pageLog }) => {
  await openPage(page, '/labs/render-core/?scene=lunarOrbit&stand=0&hud=0&fov=12');
  await assertDiscreteGpu(page);
  // Camera 20,000 km from the Moon, 150 deg from the sun direction: a thin sunlit crescent.
  await page.evaluate(() => window.__rc!.viewBodyAtPhase(window.__rc!.probes.ridgeSite.bodyId, 150, 2e7));
  await waitIdle(page, 30);
  await settled(page);
  const e = await exposure(page);
  const s16 = await sunny16(page);
  console.log(`crescent: EV100 ${e.ev100.toFixed(2)} (sunny 16 = ${s16.toFixed(2)}), lit fraction ${(e.litFraction * 100).toFixed(2)} %, evHistogram ${e.evHistogram.toFixed(2)}`);
  expect(e.litFraction).toBeGreaterThan(0.001);
  expect(e.litFraction).toBeLessThan(0.06);
  expect(Math.abs(e.ev100 - s16)).toBeLessThan(0.5);
  const shot = await saveScreenshot(page, 'render-core', 'exposure-crescent');
  expect(shot.stats.maxLuma).toBeGreaterThan(40);
  expect(shot.stats.fractionNonBlack).toBeLessThan(0.12);
  await expectNoErrors(page, pageLog);
});

test('overflow: sun disc and a mirror ball at EV100 -3 never produce NaN, and the image recovers as exposure adapts', async ({ page, pageLog }) => {
  await openPage(page, '/labs/render-core/?scene=translunar&planet=0&stand=0&probe=ball,mirror,sun&orbit=20,10,40&hud=0&fov=100');
  await assertDiscreteGpu(page);
  // Sun 40 deg off the view axis: inside the 100 deg field of view together with both balls.
  await sunAtPhase(page, 140);
  await waitIdle(page, 10);
  const r = await page.evaluate(async () => {
    const lab = window.__lab!;
    lab.renderer.setExposureOverride(-3);
    lab.setLoop(false);
    const frames: { hdr: { maxLuminance: number; nanPixels: number }; resolved: { maxLuminance: number; nanPixels: number } }[] = [];
    for (let i = 0; i < 12; i++) {
      lab.renderFrame(1 / 60);
      frames.push({ hdr: await lab.renderer.readHdrStats('hdr'), resolved: await lab.renderer.readHdrStats('resolved') });
    }
    // Release the override: exposure adapts from EV -3 upwards; check every frame on the way.
    lab.renderer.setExposureOverride(null);
    const recovery: { ev: number; nan: number; max: number }[] = [];
    for (let i = 0; i < 400; i++) {
      lab.renderFrame(1 / 60);
      if (i % 20 === 0 || i > 390) {
        const a = await lab.renderer.readHdrStats('hdr');
        const b = await lab.renderer.readHdrStats('resolved');
        recovery.push({ ev: lab.renderer.exposureInfo().ev100, nan: a.nanPixels + b.nanPixels, max: Math.max(a.maxLuminance, b.maxLuminance) });
      }
    }
    lab.setLoop(true);
    return { frames, recovery };
  });
  for (const f of r.frames) {
    expect(f.hdr.nanPixels).toBe(0);
    expect(f.resolved.nanPixels).toBe(0);
    // The sun disc saturates exactly at HDR_MAX (60,000 per channel), never above.
    expect(f.hdr.maxLuminance).toBeGreaterThan(50000);
    expect(f.hdr.maxLuminance).toBeLessThanOrEqual(60001);
    expect(f.resolved.maxLuminance).toBeLessThanOrEqual(60001);
  }
  for (const f of r.recovery) expect(f.nan).toBe(0);
  const last = r.recovery[r.recovery.length - 1]!;
  console.log(`overflow: EV100 after recovery ${last.ev.toFixed(2)}; frames at EV -3 max ${r.frames[0]!.hdr.maxLuminance.toFixed(0)}`);
  expect(last.ev).toBeGreaterThan(13);
  await page.evaluate(() => window.__test!.waitFrames(30));
  const shot = await saveScreenshot(page, 'render-core', 'overflow-recovered');
  // Recovered: a black sky with a small sun and two balls, not a white-out.
  expect(shot.stats.meanLuma).toBeLessThan(60);
  expect(shot.stats.maxLuma).toBeGreaterThan(200);
  await expectNoErrors(page, pageLog);
});
