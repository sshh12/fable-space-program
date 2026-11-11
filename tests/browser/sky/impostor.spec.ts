import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { PNG } from 'pngjs';
import { assertDiscreteGpu, expect, expectNoErrors, openPage, test, waitIdle } from '../harness';

/**
 * Distant bodies: below 3 px a body is a PSF point carrying its phase-integrated flux (Lambert sphere,
 * BodyDef.render geometricAlbedo / meanColor), above 6 px its geometry, cross-faded between. The flux test uses
 * `maps=lambert`: the Earth's backdrop is a Lambert sphere whose geometric albedo is the body's geometricAlbedo,
 * so geometry and impostor describe the same body and the integrated flux must stay constant through the fade.
 */
test.describe.configure({ timeout: 900_000 });

const outDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'out', 'screens', 'sky');

/** Camera `distance` m from the root body's centre at phase angle `phaseDeg` (0 = full), perpendicular to the Moon. */
async function placeCamera(page: Page, distance: number, phaseDeg: number): Promise<{ x: number; y: number; diameterPx: number }> {
  return page.evaluate(
    async ([d, phase]) => {
      const lab = window.__lab!;
      const s = lab.snapshot();
      const earth = s.bodies.find((b) => b.id === lab.defs.rootBodyId)!;
      const moon = s.bodies.find((b) => b.id !== earth.id && b.id !== s.starId)!;
      const sun = earth.sunDir;
      const toMoon = { x: moon.rRoot.x - earth.rRoot.x, y: moon.rRoot.y - earth.rRoot.y, z: moon.rRoot.z - earth.rRoot.z };
      // Axis perpendicular to the sun direction and the Moon direction: rotating the sun direction about it keeps
      // the camera out of the Earth-Moon line.
      let ax = { x: sun.y * toMoon.z - sun.z * toMoon.y, y: sun.z * toMoon.x - sun.x * toMoon.z, z: sun.x * toMoon.y - sun.y * toMoon.x };
      const al = Math.hypot(ax.x, ax.y, ax.z);
      ax = { x: ax.x / al, y: ax.y / al, z: ax.z / al };
      const a = (phase! * Math.PI) / 180;
      // Rodrigues: rotate sun about ax by a.
      const c = Math.cos(a);
      const sn = Math.sin(a);
      const kd = ax.x * sun.x + ax.y * sun.y + ax.z * sun.z;
      const cr = { x: ax.y * sun.z - ax.z * sun.y, y: ax.z * sun.x - ax.x * sun.z, z: ax.x * sun.y - ax.y * sun.x };
      const out = { x: sun.x * c + cr.x * sn + ax.x * kd * (1 - c), y: sun.y * c + cr.y * sn + ax.y * kd * (1 - c), z: sun.z * c + cr.z * sn + ax.z * kd * (1 - c) };
      const pos = { x: earth.rRoot.x + out.x * d!, y: earth.rRoot.y + out.y * d!, z: earth.rRoot.z + out.z * d! };
      window.__sky!.lookFrom(pos, { x: -out.x, y: -out.y, z: -out.z }, ax, 60);
      await window.__test!.waitFrames(3);
      const f = lab.renderer.frameContext!;
      const p = window.__sky!.projectDir({ x: -out.x, y: -out.y, z: -out.z })!;
      const pxAngle = (2 * Math.tan(f.camera.fovY / 2)) / f.renderSize[1];
      return { x: p.x, y: p.y, diameterPx: (2 * Math.asin(lab.defs.bodies[earth.id]!.radius / d!)) / pxAngle };
    },
    [distance, phaseDeg],
  );
}

test('a body shrinking from 20 px to 0.5 px keeps its integrated flux through the impostor cross-fade', async ({ page, pageLog }) => {
  await openPage(page, '/labs/sky/?scene=translunar&maps=lambert&parts=-stars,-milkyWay,-sun,-flare,-probe&ev=8&hud=0');
  await assertDiscreteGpu(page);
  await waitIdle(page, 4, 300_000);
  await page.evaluate(() => window.__lab!.setPaused(true));
  const phase = 50;
  const rows: { d: number; px: number; ratio: number; weight: number }[] = [];
  const steps = 26;
  for (let k = 0; k < steps; k++) {
    const d = 3.9e8 * (1.6e10 / 3.9e8) ** (k / (steps - 1));
    const at = await placeCamera(page, d, phase);
    const r = await page.evaluate(
      async ([cx, cy, dpx]) => {
        const lab = window.__lab!;
        const f0 = lab.renderer.frameContext!;
        const half = Math.ceil(Math.max(dpx! * 0.75, 5) + 3);
        const x0 = Math.round(cx!) - half;
        const y0 = Math.round(cy!) - half;
        const n = 2 * half + 1;
        const [w, h] = f0.renderSize;
        const tanY = Math.tan(f0.camera.fovY / 2);
        const omega = ((2 * tanY * w) / h / w) * ((2 * tanY) / h);
        // Average over two full jitter cycles: the geometry's coverage of pixel centres is sampled at 16 sub-pixel offsets.
        let flux = 0;
        lab.setLoop(false);
        for (let i = 0; i < 16; i++) {
          lab.renderFrame();
          const px = await lab.renderer.readHdrPixels('hdr', { x: x0, y: y0, width: n, height: n });
          let s = 0;
          for (let j = 0; j < px.data.length; j += 4) s += 0.2126 * px.data[j]! + 0.7152 * px.data[j + 1]! + 0.0722 * px.data[j + 2]!;
          flux += (s * omega) / lab.renderer.frameContext!.exposure;
        }
        lab.setLoop(true);
        flux /= 16;
        // Expected: Lambert sphere with the body's geometric albedo at this phase.
        const s = lab.snapshot();
        const earth = s.bodies.find((b) => b.id === lab.defs.rootBodyId)!;
        const def = lab.defs.bodies[earth.id]!;
        const em = lab.defs.bodies[s.starId]!.emission!;
        const cam = lab.cameraState().positionRoot;
        const to = { x: cam.x - earth.rRoot.x, y: cam.y - earth.rRoot.y, z: cam.z - earth.rRoot.z };
        const dist = Math.hypot(to.x, to.y, to.z);
        const alpha = Math.acos((to.x * earth.sunDir.x + to.y * earth.sunDir.y + to.z * earth.sunDir.z) / dist);
        const phi = (Math.sin(alpha) + (Math.PI - alpha) * Math.cos(alpha)) / Math.PI;
        const e = em.illuminance * (em.refDistance / earth.sunDistance) ** 2 * def.render.geometricAlbedo * (def.radius / dist) ** 2 * phi;
        const imp = window.__sky!.sky!.impostors().find((i) => i.bodyId === earth.id);
        return { flux, expected: e, weight: imp?.weight ?? 0 };
      },
      [at.x, at.y, at.diameterPx],
    );
    rows.push({ d, px: at.diameterPx, ratio: r.flux / r.expected, weight: r.weight });
    console.log(`distance ${(d / 1e6).toFixed(0).padStart(6)} Mm  diameter ${at.diameterPx.toFixed(2).padStart(6)} px  impostor weight ${r.weight.toFixed(3)}  flux / Lambert sphere ${(r.flux / r.expected).toFixed(4)}`);
  }
  for (const r of rows) expect(Math.abs(r.ratio - 1), `at ${r.px.toFixed(2)} px`).toBeLessThan(0.1);
  for (let k = 1; k < rows.length; k++) expect(Math.abs(rows[k]!.ratio / rows[k - 1]!.ratio - 1)).toBeLessThan(0.1);
  expect(rows[0]!.weight).toBe(0);
  expect(rows[rows.length - 1]!.weight).toBe(1);
  expect(rows.some((r) => r.weight > 0.05 && r.weight < 0.95)).toBe(true);
  await expectNoErrors(page, pageLog);
});

test('crescent Earth: a point far beyond the Moon, resolving on approach to lunar distance', async ({ page, pageLog }) => {
  await openPage(page, '/labs/sky/?scene=translunar&clouds=1&parts=-flare&hud=0');
  await assertDiscreteGpu(page);
  await waitIdle(page, 4, 300_000);
  await page.evaluate(() => window.__lab!.setPaused(true));
  // Crescent: phase angle 125 deg. The exposure is that of the crescent at lunar distance, opened up by the fall of
  // the flux with distance (2 log2(d / d_lunar) EV), so every tile shows the body at the same brightness and only
  // its shape changes: point -> blob -> crescent.
  const distances = [1.6e10, 6.4e9, 3.2e9, 1.9e9, 1.2e9, 6.0e8, 3.84e8];
  await placeCamera(page, distances[distances.length - 1]!, 125);
  await page.waitForFunction(() => {
    const e = window.__lab!.renderer.exposureInfo();
    return Math.abs(e.ev100 - e.targetEv100) < 0.02;
  }, undefined, { timeout: 60_000 });
  const ev = await page.evaluate(() => window.__lab!.renderer.exposureInfo().ev100);
  await page.evaluate((e) => window.__lab!.renderer.setExposureOverride(e), ev);
  const tile = 96;
  const zoom = 3;
  const sheet = new PNG({ width: tile * zoom * distances.length, height: tile * zoom });
  const labels: string[] = [];
  for (let k = 0; k < distances.length; k++) {
    const at = await placeCamera(page, distances[k]!, 125);
    await page.evaluate((e) => window.__lab!.renderer.setExposureOverride(e), ev - 2 * Math.log2(distances[k]! / distances[distances.length - 1]!));
    await page.evaluate(() => window.__test!.waitFrames(90));
    const shot = PNG.sync.read(await page.screenshot({ clip: { x: Math.round(at.x) - tile / 2, y: Math.round(at.y) - tile / 2, width: tile, height: tile } }));
    for (let y = 0; y < tile * zoom; y++) {
      for (let x = 0; x < tile * zoom; x++) {
        const s = (Math.floor(y / zoom) * tile + Math.floor(x / zoom)) * 4;
        const o = (y * sheet.width + k * tile * zoom + x) * 4;
        sheet.data[o] = shot.data[s]!;
        sheet.data[o + 1] = shot.data[s + 1]!;
        sheet.data[o + 2] = shot.data[s + 2]!;
        sheet.data[o + 3] = 255;
      }
    }
    labels.push(`${(distances[k]! / 1e6).toFixed(0)} Mm: ${at.diameterPx.toFixed(1)} px`);
    if (k === distances.length - 1) await page.screenshot({ path: path.join(outDir, 'crescent-earth-lunar-distance.png') });
  }
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'crescent-earth-approach-sheet.png'), PNG.sync.write(sheet));
  console.log(`crescent Earth at EV100 ${ev.toFixed(2)}, tiles (3x zoom, left to right): ${labels.join(', ')}`);
  await expectNoErrors(page, pageLog);
});
