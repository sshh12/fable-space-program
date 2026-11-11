import type { Page } from '@playwright/test';
import { assertDiscreteGpu, expect, expectNoErrors, openPage, saveScreenshot, test, waitIdle } from '../harness';

/**
 * Lens flare: energy under 1 % of the source (HDR readback, flare on minus off), attenuated by the visible
 * fraction of the disc ('scene.depth') and by the cloud transmittance at the sun ('clouds.screen'.a, a synthetic
 * opaque layer published by the lab), suppressed for interior cameras.
 */
test.describe.configure({ timeout: 600_000 });

/** Sun `offAxisDeg` from the view axis, camera on the active vessel, sim paused, static TAA input. */
async function aimNearSun(page: Page, offAxisDeg: number, fovDeg: number): Promise<void> {
  await page.evaluate(
    ([off, fov]) => {
      const lab = window.__lab!;
      lab.setPaused(true);
      lab.setDeterministic(true);
      lab.renderer.setJitter(false);
      const s = lab.renderer.frameContext!.sun.dirRoot;
      const a = Math.abs(s.z) < 0.9 ? { x: 0, y: 0, z: 1 } : { x: 1, y: 0, z: 0 };
      let p = { x: s.y * a.z - s.z * a.y, y: s.z * a.x - s.x * a.z, z: s.x * a.y - s.y * a.x };
      const pl = Math.hypot(p.x, p.y, p.z);
      p = { x: p.x / pl, y: p.y / pl, z: p.z / pl };
      const r = (off! * Math.PI) / 180;
      const f = { x: s.x * Math.cos(r) + p.x * Math.sin(r), y: s.y * Math.cos(r) + p.y * Math.sin(r), z: s.z * Math.cos(r) + p.z * Math.sin(r) };
      window.__sky!.lookFrom(lab.snapshot().vessels[0]!.rRoot, f, a, fov);
    },
    [offAxisDeg, fovDeg],
  );
  await page.evaluate(() => window.__test!.waitFrames(6));
}

/** Flare illuminance on screen relative to the source: sum over the HDR difference (flare on - off) x pixel solid angle. */
async function flareFraction(page: Page): Promise<{ fraction: number; maxDiff: number; drawn: boolean; state: { visible: number; cloud: number; inView: number } }> {
  return page.evaluate(async () => {
    const lab = window.__lab!;
    const sky = window.__sky!.sky!;
    const read = async () => (await lab.renderer.readHdrPixels('hdr')).data;
    sky.parts.flare = true;
    await window.__test!.waitFrames(3);
    const on = await read();
    const drawn = sky.status().flareDrawn;
    const state = await sky.readFlareState();
    sky.parts.flare = false;
    await window.__test!.waitFrames(3);
    const off = await read();
    sky.parts.flare = true;
    const f = lab.renderer.frameContext!;
    const [w, h] = f.renderSize;
    const tanY = Math.tan(f.camera.fovY / 2);
    const tanX = (tanY * w) / h;
    let sum = 0;
    let maxDiff = 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        const d = 0.2126 * (on[i]! - off[i]!) + 0.7152 * (on[i + 1]! - off[i + 1]!) + 0.0722 * (on[i + 2]! - off[i + 2]!);
        maxDiff = Math.max(maxDiff, Math.abs(d));
        // Pixel solid angle: on-axis value x cos^3 of the pixel's angle off the axis.
        const u = ((2 * (x + 0.5)) / w - 1) * tanX;
        const v = ((2 * (y + 0.5)) / h - 1) * tanY;
        const c3 = (1 + u * u + v * v) ** -1.5;
        sum += d * ((2 * tanX) / w) * ((2 * tanY) / h) * c3;
      }
    }
    return { fraction: sum / f.exposure / f.sun.illuminance, maxDiff, drawn, state: { visible: state.visible, cloud: state.cloud, inView: state.inView } };
  });
}

test('flare energy is under 1 % of the source and the flare vanishes behind a cloud layer', async ({ page, pageLog }) => {
  await openPage(page, '/labs/sky/?scene=translunar&planet=0&parts=-stars,-milkyWay,-impostors,-probe&ev=12&hud=0');
  await assertDiscreteGpu(page);
  await waitIdle(page, 4, 300_000);
  await aimNearSun(page, 6, 60);
  const clear = await flareFraction(page);
  console.log(`clear sky: flare draws ${(clear.fraction * 100).toFixed(3)} % of the sun's illuminance on screen (visible fraction ${clear.state.visible.toFixed(3)}, cloud transmittance ${clear.state.cloud.toFixed(3)})`);
  expect(clear.drawn).toBe(true);
  expect(clear.state.visible).toBe(1);
  expect(clear.fraction).toBeGreaterThan(0.002);
  expect(clear.fraction).toBeLessThan(0.01);
  await page.evaluate(() => window.__test!.waitFrames(30));
  await saveScreenshot(page, 'sky', 'flare-deep-space-ev12');

  await page.evaluate(() => window.__sky!.setCloudCover(true));
  await page.evaluate(() => window.__test!.waitFrames(3));
  const cloudy = await flareFraction(page);
  console.log(`opaque cloud layer in front of the sun: cloud transmittance ${cloudy.state.cloud.toFixed(3)}, flare contribution max ${cloudy.maxDiff}`);
  expect(cloudy.state.cloud).toBe(0);
  expect(cloudy.maxDiff).toBe(0);
  await page.evaluate(() => window.__sky!.setCloudCover(false));
  await expectNoErrors(page, pageLog);
});

test('flare follows the visible part of the disc behind the Earth\'s limb and is off for interior cameras', async ({ page, pageLog }) => {
  await openPage(page, '/labs/sky/?scene=lowOrbit&parts=-stars,-milkyWay,-impostors,-probe&ev=12&hud=0');
  await assertDiscreteGpu(page);
  await waitIdle(page, 4, 300_000);
  // The horizon dips 14.17 deg at 200 km: sun centre on the limb, then 1 deg above and 1 deg below it.
  const vis: number[] = [];
  for (const el of [-14.17 + 1, -14.17 + 0.0, -14.17 - 1]) {
    await page.evaluate((e) => window.__sky!.setSunForVessel({ elevationDeg: e, azimuthDeg: 0 }), el);
    await page.evaluate(() => window.__test!.waitFrames(3));
    await aimNearSun(page, 4, 30);
    const r = await flareFraction(page);
    vis.push(r.state.visible);
    console.log(`sun centre ${(el + 14.17).toFixed(2)} deg above the limb: visible fraction ${r.state.visible.toFixed(3)}, flare ${(r.fraction * 100).toFixed(3)} %`);
    await page.evaluate(() => {
      window.__lab!.setPaused(false);
      window.__lab!.setDeterministic(false);
    });
  }
  expect(vis[0]).toBe(1);
  expect(vis[1]).toBeGreaterThan(0.3);
  expect(vis[1]).toBeLessThan(0.7);
  expect(vis[2]).toBe(0);
  await page.evaluate(() => {
    window.__lab!.camera.settings.kind = 'interior';
  });
  await page.evaluate(() => window.__sky!.setSunForVessel({ elevationDeg: 20, azimuthDeg: 0 }));
  await aimNearSun(page, 4, 30);
  const interior = await page.evaluate(() => window.__sky!.sky!.status().flareDrawn);
  expect(interior).toBe(false);
  await expectNoErrors(page, pageLog);
});
