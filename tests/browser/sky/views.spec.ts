import type { Page } from '@playwright/test';
import { assertDiscreteGpu, assertRealImage, expectNoErrors, openPage, saveScreenshot, test, waitIdle } from '../harness';

/**
 * Reviewed screenshots of the sky feature (out/screens/sky). Every view waits for the sky data and a probe built
 * from it (isIdle), then lets TAA converge. The checks here only assert real images; the numbers are in the
 * other specs of this directory.
 */
test.describe.configure({ timeout: 600_000 });

async function settle(page: Page, frames = 90): Promise<void> {
  await waitIdle(page, 8, 300_000);
  await page.evaluate((n) => window.__test!.waitFrames(n), frames);
}

const vesselPos = (page: Page) => page.evaluate(() => window.__lab!.snapshot().vessels[0]!.rRoot);

test('deep-space star field at long exposure and the Orion region', async ({ page, pageLog }) => {
  await openPage(page, '/labs/sky/?scene=translunar&planet=0&parts=-impostors&ev=-5&hud=0');
  await assertDiscreteGpu(page);
  const p = await vesselPos(page);
  await page.evaluate((pos) => window.__sky!.lookAtRaDec(266.4, -28.9, 70, pos), p);
  await settle(page);
  if ((await page.evaluate(() => window.__sky!.sky!.status().milkyWayFaceSize)) !== 1024) throw new Error('Milky Way cube not at the default 1024 per face');
  assertRealImage((await saveScreenshot(page, 'sky', 'starfield-deep-space-ev-5')).stats, 'star field', { minNonBlack: 0.02, minStd: 2, minBuckets: 20 });
  await page.evaluate((pos) => window.__sky!.lookAtRaDec(83.8, -1.0, 24, pos), p);
  await settle(page);
  assertRealImage((await saveScreenshot(page, 'sky', 'orion-closeup-ev-5')).stats, 'Orion', { minNonBlack: 0.01, minStd: 2, minBuckets: 20 });
  await page.evaluate((pos) => window.__sky!.lookAtRaDec(187, -60, 30, pos), p);
  await settle(page);
  await saveScreenshot(page, 'sky', 'crux-centaurus-ev-5');
  await expectNoErrors(page, pageLog);
});

test('Milky Way cube at the full baked 2048 per face (the default keeps 1024 in VRAM): comparison views', async ({ page, pageLog }) => {
  // Evidence for the VRAM decision (hand-off): the same views as above with the finest mip uploaded.
  await openPage(page, '/labs/sky/?scene=translunar&planet=0&parts=-impostors&ev=-5&hud=0&mwSize=2048');
  await assertDiscreteGpu(page);
  const p = await vesselPos(page);
  await page.evaluate((pos) => window.__sky!.lookAtRaDec(266.4, -28.9, 70, pos), p);
  await settle(page);
  if ((await page.evaluate(() => window.__sky!.sky!.status().milkyWayFaceSize)) !== 2048) throw new Error('Milky Way cube not at 2048 per face');
  await saveScreenshot(page, 'sky', 'starfield-deep-space-ev-5-mw2048');
  await page.evaluate((pos) => window.__sky!.lookAtRaDec(83.8, -1.0, 24, pos), p);
  await settle(page);
  await saveScreenshot(page, 'sky', 'orion-closeup-ev-5-mw2048');
  await expectNoErrors(page, pageLog);
});

test('the sun just above the limb of the Earth from low orbit, with flare', async ({ page, pageLog }) => {
  await openPage(page, '/labs/sky/?scene=lowOrbit&hud=0&clouds=1');
  await assertDiscreteGpu(page);
  // Sun 7 deg above the limb (the horizon dips 14.2 deg at 200 km): the ground towards it is lit at grazing sun in a
  // band below the limb; camera looking at it from the vessel.
  await page.evaluate(() => {
    window.__sky!.setSunForVessel({ elevationDeg: -7, azimuthDeg: 90 });
    window.__lab!.camera.settings.fovY = (60 * Math.PI) / 180;
    window.__lab!.onFrame((s) => {
      const v = s.vessels[0]!;
      const sun = s.bodies.find((b) => b.id === s.starId)!;
      const d = { x: sun.rRoot.x - v.rRoot.x, y: sun.rRoot.y - v.rRoot.y, z: sun.rRoot.z - v.rRoot.z };
      const e = s.bodies.find((b) => b.id === v.bodyId)!;
      const up = { x: v.rRoot.x - e.rRoot.x, y: v.rRoot.y - e.rRoot.y, z: v.rRoot.z - e.rRoot.z };
      // Look 8 deg below the sun so the limb is in the lower part of the frame.
      const l = Math.hypot(d.x, d.y, d.z);
      const ul = Math.hypot(up.x, up.y, up.z);
      const f = { x: d.x / l - (0.14 * up.x) / ul, y: d.y / l - (0.14 * up.y) / ul, z: d.z / l - (0.14 * up.z) / ul };
      window.__sky!.lookFrom(v.rRoot, f, up);
    });
  });
  await settle(page, 150);
  await saveScreenshot(page, 'sky', 'sun-at-earth-limb-leo-flare');
  await expectNoErrors(page, pageLog);
});

for (const v of [
  // The sun comes from the camera's right, a little behind it, so the left halves of the spheres show the
  // environment alone: the lit Earth (with the lab's cloud layer) or Moon below, black space above.
  { name: 'pbr-spheres-leo-day', url: '/labs/sky/?scene=lowOrbit&spheres=1&clouds=1&hud=0&orbit=0,14,8', sun: { elevationDeg: 40, azimuthDeg: 100, fromCamera: true } as const },
  { name: 'pbr-spheres-leo-night', url: '/labs/sky/?scene=lowOrbit&spheres=1&clouds=1&hud=0&orbit=0,14,8&night=1', sun: null },
  // At the mission's landing site, 1907.8 m below the Moon's reference radius, resting on the ground (origin 3 m up).
  { name: 'pbr-spheres-lunar-surface', url: '/labs/sky/?scene=lunarSurface&spheres=1&hud=0&orbit=0,8,8&valt=-1904.8&ground=-1907.8', sun: { elevationDeg: 35, azimuthDeg: 100, fromCamera: true } as const },
]) {
  test(`PBR spheres lit by the probe: ${v.name}`, async ({ page, pageLog }) => {
    await openPage(page, v.url);
    await assertDiscreteGpu(page);
    if (v.sun) await page.evaluate((sun) => window.__sky!.setSunForVessel(sun), v.sun);
    await settle(page, 150);
    const shot = await saveScreenshot(page, 'sky', v.name);
    if (v.sun) assertRealImage(shot.stats, v.name, { minNonBlack: 0.05, minStd: 5, minBuckets: 30 });
    await expectNoErrors(page, pageLog);
  });
}
