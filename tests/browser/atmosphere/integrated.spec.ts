/**
 * The sky and the clouds as the game shows them, with every other package drawing: pictures only, for the
 * visual review (out/screens/atmosphere/integrated-*.png), with the numbers that say what the frame looks
 * at (camera pitch, sun elevation at the camera, exposure).
 *
 *  - The real app under the drogues (scenario qa-drogues: 7 km over the recovery zone at dawn), where the
 *    whole-mission flight showed a uniform dark frame behind the canopies.
 *  - The integration lab at the pad, during the ascent, in low orbit and under the parachutes.
 *
 *   node tools/dev/heavy.mjs --class=gpu -- npx playwright test tests/browser/atmosphere/integrated.spec.ts --project=functional
 */
import type { Page } from '@playwright/test';
import { assertDiscreteGpu, expectNoErrors, openPage, saveScreenshot, test } from '../harness';

test.describe.configure({ timeout: 15 * 60_000 });

interface Looking {
  pitchDeg: number;
  sunElevationDeg: number;
  sunFromAxisDeg: number;
  altitudeKm: number;
  ev100: number | null;
}

/** Where the camera looks and where the sun stands, from the page's own state. */
async function looking(page: Page): Promise<Looking> {
  return page.evaluate(() => {
    const s = window.__test!.state()!;
    const c = window.__test!.camera()!;
    type V = { x: number; y: number; z: number };
    const rot = (q: { x: number; y: number; z: number; w: number }, p: V): V => {
      const cx = q.y * p.z - q.z * p.y;
      const cy = q.z * p.x - q.x * p.z;
      const cz = q.x * p.y - q.y * p.x;
      return { x: p.x + 2 * (q.w * cx + q.y * cz - q.z * cy), y: p.y + 2 * (q.w * cy + q.z * cx - q.x * cz), z: p.z + 2 * (q.w * cz + q.x * cy - q.y * cx) };
    };
    const dot = (a: V, b: V): number => a.x * b.x + a.y * b.y + a.z * b.z;
    const deg = 180 / Math.PI;
    const v = s.vessels.find((x) => x.id === s.activeVesselId)!;
    const body = s.bodies.find((b) => b.id === v.bodyId)!;
    const rel = { x: c.positionRoot.x - body.rRoot.x, y: c.positionRoot.y - body.rRoot.y, z: c.positionRoot.z - body.rRoot.z };
    const r = Math.hypot(rel.x, rel.y, rel.z);
    const up = { x: rel.x / r, y: rel.y / r, z: rel.z / r };
    const forward = rot(c.qViewToRoot, { x: 0, y: 0, z: -1 });
    const lab = (window as unknown as { __lab?: { renderer: { exposureInfo(): { ev100: number } } } }).__lab;
    return {
      pitchDeg: Math.asin(Math.max(-1, Math.min(1, dot(forward, up)))) * deg,
      sunElevationDeg: Math.asin(Math.max(-1, Math.min(1, dot(body.sunDir, up)))) * deg,
      sunFromAxisDeg: Math.acos(Math.max(-1, Math.min(1, dot(body.sunDir, forward)))) * deg,
      altitudeKm: s.readouts.altitudeAsl / 1000,
      ev100: lab ? lab.renderer.exposureInfo().ev100 : null,
    };
  });
}

const line = (name: string, l: Looking): string =>
  `[integrated] ${name}: altitude ${l.altitudeKm.toFixed(1)} km, camera pitch ${l.pitchDeg.toFixed(1)} deg, sun ${l.sunElevationDeg.toFixed(1)} deg above the horizon and ${l.sunFromAxisDeg.toFixed(0)} deg from the view axis${l.ev100 === null ? '' : `, EV100 ${l.ev100.toFixed(2)}`}`;

test('the real app under the drogues at dawn', async ({ page, pageLog }) => {
  await openPage(page, '/?scenario=qa-drogues&capture=0&mute=1&hud=0', { timeoutMs: 240_000 });
  await assertDiscreteGpu(page);
  await page.waitForFunction(() => window.__test!.isIdle(), undefined, { timeout: 240_000, polling: 200 });
  await page.evaluate(() => window.__test!.waitFrames(120));
  const l = await looking(page);
  const shot = await saveScreenshot(page, 'atmosphere', 'integrated-app-drogues');
  console.log(`${line('app, qa-drogues', l)}; mean luma of the frame ${shot.stats.meanLuma.toFixed(1)}`);
  await expectNoErrors(page, pageLog);
});

for (const scene of ['pad', 'ascent', 'lowOrbit', 'chutes'] as const) {
  test(`integration lab, ${scene}: every package drawing`, async ({ page, pageLog }) => {
    await openPage(page, `/labs/integration/?scene=${scene}&features=all&hud=0`, { timeoutMs: 240_000 });
    await assertDiscreteGpu(page);
    await page.waitForFunction(() => window.__test!.isIdle(), undefined, { timeout: 240_000, polling: 200 });
    await page.evaluate(() => window.__test!.waitFrames(90));
    const l = await looking(page);
    const shot = await saveScreenshot(page, 'atmosphere', `integrated-${scene}`);
    console.log(`${line(`lab, ${scene}`, l)}; mean luma of the frame ${shot.stats.meanLuma.toFixed(1)}`);
    await expectNoErrors(page, pageLog);
  });
}
