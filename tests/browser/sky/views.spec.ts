import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { PNG } from 'pngjs';
import { assertDiscreteGpu, assertRealImage, expect, expectNoErrors, openPage, saveScreenshot, test, waitIdle } from '../harness';

/**
 * Reviewed screenshots of the sky feature (out/screens/sky). Every view waits for the sky data and a probe built
 * from it (isIdle), then lets TAA converge. Views are taken at the exposure the game reaches by itself (the
 * settled automatic exposure) unless their name says otherwise. The numbers are in the other specs of this
 * directory; the checks here are the ones that belong to a picture.
 */
test.describe.configure({ timeout: 900_000 });

const outDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'out', 'screens', 'sky');

async function settle(page: Page, frames = 90): Promise<void> {
  await waitIdle(page, 8, 300_000);
  await page.evaluate((n) => window.__test!.waitFrames(n), frames);
}

/** Wait until the automatic exposure has reached its target (dark adaptation takes tens of seconds), then return it. */
async function settledExposure(page: Page): Promise<number> {
  await page.waitForFunction(
    () => {
      const e = window.__lab!.renderer.exposureInfo();
      return Math.abs(e.ev100 - e.targetEv100) < 0.02;
    },
    undefined,
    { timeout: 240_000 },
  );
  return page.evaluate(() => window.__lab!.renderer.exposureInfo().ev100);
}

const vesselPos = (page: Page) => page.evaluate(() => window.__lab!.snapshot().vessels[0]!.rRoot);

/** The three star-field views: the galactic centre (70 deg), Orion (24 deg), Crux and Centaurus (30 deg). */
const FIELDS = [
  { name: 'starfield-deep-space', ra: 266.4, dec: -28.9, fov: 70 },
  { name: 'orion-closeup', ra: 83.8, dec: -1.0, fov: 24 },
  { name: 'crux-centaurus', ra: 187, dec: -60, fov: 30 },
] as const;

test('deep-space star field, the Orion region and the Southern Cross at the dark-adapted automatic exposure', async ({ page, pageLog }) => {
  // The night side of a low orbit with the planet not drawn: nothing lit is in view, so the exposure is the dark-adapted floor.
  await openPage(page, '/labs/sky/?scene=lowOrbit&night=1&planet=0&parts=-impostors&hud=0');
  await assertDiscreteGpu(page);
  const p = await vesselPos(page);
  await page.evaluate((pos) => window.__sky!.lookAtRaDec(266.4, -28.9, 70, pos), p);
  await settle(page);
  const st = await page.evaluate(() => window.__sky!.sky!.status());
  if (st.milkyWayFaceSize !== 1024 || st.milkyWayDetailSize !== 2048) throw new Error(`Milky Way cube ${st.milkyWayFaceSize} + detail ${st.milkyWayDetailSize}: not the default 1024 with the 2048 luminance layer`);
  const ev = await settledExposure(page);
  console.log(`nothing lit in view: the automatic exposure settles at EV100 ${ev.toFixed(2)}`);
  expect(ev).toBeLessThan(-5.5);
  for (const f of FIELDS) {
    await page.evaluate(([ra, dec, fov, pos]) => window.__sky!.lookAtRaDec(ra as number, dec as number, fov as number, pos as { x: number; y: number; z: number }), [f.ra, f.dec, f.fov, p] as const);
    await settle(page);
    const shot = await saveScreenshot(page, 'sky', `${f.name}-auto`);
    assertRealImage(shot.stats, f.name, { minNonBlack: 0.02, minStd: 2, minBuckets: 20 });
    // Stars as a picture: how many separate images stand above 16/255 and above 128/255, and how large the largest is.
    const png = PNG.sync.read(shot.buffer);
    const luma = (i: number): number => 0.2126 * png.data[i * 4]! + 0.7152 * png.data[i * 4 + 1]! + 0.0722 * png.data[i * 4 + 2]!;
    let peaks16 = 0;
    let peaks128 = 0;
    for (let y = 1; y < png.height - 1; y++) {
      for (let x = 1; x < png.width - 1; x++) {
        const i = y * png.width + x;
        const v = luma(i);
        if (v < 16) continue;
        let isPeak = true;
        for (let dy = -1; dy <= 1 && isPeak; dy++) for (let dx = -1; dx <= 1; dx++) if ((dx !== 0 || dy !== 0) && luma(i + dy * png.width + dx) > v) isPeak = false;
        if (!isPeak) continue;
        peaks16++;
        if (v >= 128) peaks128++;
      }
    }
    console.log(`${f.name} at EV100 ${ev.toFixed(1)}: ${peaks16} star images above 16/255, ${peaks128} above 128/255; mean level ${shot.stats.meanLuma.toFixed(1)}/255`);
    expect(peaks16).toBeGreaterThan(1000);
  }
  await expectNoErrors(page, pageLog);
});

test('Milky Way memory options side by side: 1024 colour only, the default (1024 colour + 2048 luminance), the full baked 2048', async ({ page, pageLog }) => {
  // Evidence for the VRAM decision (hand-off): crops of the same views, 3 x, at the dark-adapted exposure of the default.
  const variants = [
    { label: '1024', query: '&mwDetail=0' },
    { label: 'default', query: '' },
    { label: '2048', query: '&mwSize=2048' },
  ];
  const crops: Record<string, PNG[]> = {};
  let ev: number | null = null;
  for (const v of variants) {
    await openPage(page, `/labs/sky/?scene=lowOrbit&night=1&planet=0&parts=-impostors&hud=0${v.query}`);
    await assertDiscreteGpu(page);
    const p = await vesselPos(page);
    await page.evaluate((pos) => window.__sky!.lookAtRaDec(266.4, -28.9, 70, pos), p);
    await settle(page);
    ev ??= await settledExposure(page);
    await page.evaluate((e) => window.__lab!.renderer.setExposureOverride(e), ev);
    for (const f of [FIELDS[1], { name: 'galactic-centre', ra: 266.4, dec: -28.9, fov: 24 }]) {
      await page.evaluate(([ra, dec, fov, pos]) => window.__sky!.lookAtRaDec(ra as number, dec as number, fov as number, pos as { x: number; y: number; z: number }), [f.ra, f.dec, f.fov, p] as const);
      await settle(page);
      (crops[f.name] ??= []).push(PNG.sync.read(await page.screenshot({ clip: { x: 760, y: 420, width: 160, height: 120 } })));
    }
  }
  fs.mkdirSync(outDir, { recursive: true });
  for (const [name, list] of Object.entries(crops)) {
    const zoom = 3;
    const w = list[0]!.width;
    const h = list[0]!.height;
    const sheet = new PNG({ width: (w * zoom + 6) * list.length - 6, height: h * zoom });
    sheet.data.fill(255);
    list.forEach((img, k) => {
      for (let y = 0; y < h * zoom; y++) {
        for (let x = 0; x < w * zoom; x++) {
          const s = (Math.floor(y / zoom) * w + Math.floor(x / zoom)) * 4;
          const o = (y * sheet.width + k * (w * zoom + 6) + x) * 4;
          sheet.data[o] = img.data[s]!;
          sheet.data[o + 1] = img.data[s + 1]!;
          sheet.data[o + 2] = img.data[s + 2]!;
        }
      }
    });
    fs.writeFileSync(path.join(outDir, `milky-way-1024-default-2048-${name}-crop-3x.png`), PNG.sync.write(sheet));
    // The default keeps the baked resolution of the faint stars: its crop is as sharp as the full cube's (mean absolute
    // horizontal gradient of the luma), where the 1024 colour cube alone is clearly softer.
    const sharp = list.map((img) => {
      let s = 0;
      for (let y = 0; y < h; y++) for (let x = 1; x < w; x++) s += Math.abs(img.data[(y * w + x) * 4 + 1]! - img.data[(y * w + x - 1) * 4 + 1]!);
      return s / (w * h);
    });
    console.log(`${name}: sharpness (mean |d green / dx|, 8-bit) 1024 only ${sharp[0]!.toFixed(2)}, default ${sharp[1]!.toFixed(2)}, full 2048 ${sharp[2]!.toFixed(2)}`);
    expect(sharp[1]! / sharp[2]!).toBeGreaterThan(0.9);
    expect(sharp[1]! / sharp[0]!).toBeGreaterThan(1.1);
  }
  await expectNoErrors(page, pageLog);
});

test('the sun just above the limb of the Earth from low orbit, with flare, at the automatic exposure', async ({ page, pageLog }) => {
  await openPage(page, '/labs/sky/?scene=lowOrbit&hud=0&clouds=1&cloudUnder=1');
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
  const ev = await settledExposure(page);
  await settle(page, 60);
  console.log(`sun above the limb: automatic exposure EV100 ${ev.toFixed(2)}`);
  await saveScreenshot(page, 'sky', 'sun-at-earth-limb-leo-flare');
  await expectNoErrors(page, pageLog);
});

for (const v of [
  // The sun comes from the camera's right, a little behind it, so the left halves of the spheres show the
  // environment alone: the lit Earth below (the lab's cloud layer turned so that a cloud field lies under the
  // vessel) and black space above.
  { name: 'pbr-spheres-leo-day', url: '/labs/sky/?scene=lowOrbit&spheres=1&clouds=1&cloudUnder=1&hud=0&orbit=0,14,8', sun: { elevationDeg: 40, azimuthDeg: 100, fromCamera: true } as const },
  { name: 'pbr-spheres-leo-night', url: '/labs/sky/?scene=lowOrbit&spheres=1&clouds=1&cloudUnder=1&hud=0&orbit=0,14,8&night=1', sun: null },
  // At the mission's landing site, 1907.8 m below the Moon's reference radius, resting on the ground (origin 3 m up).
  { name: 'pbr-spheres-lunar-surface', url: '/labs/sky/?scene=lunarSurface&spheres=1&hud=0&orbit=0,8,8&valt=-1904.8&ground=-1907.8', sun: { elevationDeg: 35, azimuthDeg: 100, fromCamera: true } as const },
]) {
  test(`PBR spheres lit by the probe: ${v.name}`, async ({ page, pageLog }) => {
    await openPage(page, v.url);
    await assertDiscreteGpu(page);
    if (v.sun) await page.evaluate((sun) => window.__sky!.setSunForVessel(sun), v.sun);
    await settle(page, 150);
    const ev = await settledExposure(page);
    await settle(page, 60);
    const shot = await saveScreenshot(page, 'sky', v.name);
    console.log(`${v.name}: automatic exposure EV100 ${ev.toFixed(2)}, mean level ${shot.stats.meanLuma.toFixed(1)}/255`);
    if (v.sun) assertRealImage(shot.stats, v.name, { minNonBlack: 0.05, minStd: 5, minBuckets: 30 });
    await expectNoErrors(page, pageLog);
  });
}
