import type { Page } from '@playwright/test';
import { PNG } from 'pngjs';
import { EV_DARK_FLOOR } from '../../../src/render/core/post/exposure';
import { displayLinear, srgbEncode } from '../../../src/render/core/post/tonemap';
import { assertDiscreteGpu, expect, expectNoErrors, openPage, saveScreenshot, test, waitIdle } from '../harness';

// The first navigation of a run compiles the page through Vite; on a loaded machine that alone can take a minute.
test.describe.configure({ timeout: 600_000 });

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

  // A fully dark frame: look away from the ball, the sun, the Earth and the Moon -> the dark-adapted floor.
  // The sim is paused and the sun pinned where it is first: the override above follows the camera, so
  // turning the camera would bring the sun along (35 deg off the view axis, inside the frame or not
  // depending on the moment), and the vessel flies 1.5 km/s past a camera that is fixed in ROOT axes.
  await page.evaluate(() => {
    const lab = window.__lab!;
    lab.setPaused(true);
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
    window.__rc!.setSunOverride({ dirRoot: () => up });
    const right = { x: fwd.y * up.z - fwd.z * up.y, y: fwd.z * up.x - fwd.x * up.z, z: fwd.x * up.y - fwd.y * up.x };
    // Quaternion of the rotation whose columns are (right, up, -forward); the branch with the largest
    // pivot keeps the division well conditioned for every orientation.
    const m00 = right.x, m01 = up.x, m02 = -fwd.x;
    const m10 = right.y, m11 = up.y, m12 = -fwd.y;
    const m20 = right.z, m21 = up.z, m22 = -fwd.z;
    const tr = m00 + m11 + m22;
    let q: { x: number; y: number; z: number; w: number };
    if (tr > 0) {
      const k = 2 * Math.sqrt(1 + tr);
      q = { w: k / 4, x: (m21 - m12) / k, y: (m02 - m20) / k, z: (m10 - m01) / k };
    } else if (m00 > m11 && m00 > m22) {
      const k = 2 * Math.sqrt(1 + m00 - m11 - m22);
      q = { w: (m21 - m12) / k, x: k / 4, y: (m01 + m10) / k, z: (m02 + m20) / k };
    } else if (m11 > m22) {
      const k = 2 * Math.sqrt(1 + m11 - m00 - m22);
      q = { w: (m02 - m20) / k, x: (m01 + m10) / k, y: k / 4, z: (m12 + m21) / k };
    } else {
      const k = 2 * Math.sqrt(1 + m22 - m00 - m11);
      q = { w: (m10 - m01) / k, x: (m02 + m20) / k, y: (m12 + m21) / k, z: k / 4 };
    }
    lab.camera.spec = { type: 'free', positionRoot: { x: v.x + fwd.x * 200, y: v.y + fwd.y * 200, z: v.z + fwd.z * 200 }, qViewToRoot: q };
  });
  await page.waitForFunction((ev) => window.__lab!.renderer.exposureInfo().targetEv100 === ev, EV_DARK_FLOOR, { timeout: 30_000 });
  // Down to EV -3 in a few seconds, then dark adaptation: 25 s for the last three stops.
  const t0 = Date.now();
  await page.waitForFunction(() => window.__lab!.renderer.exposureInfo().ev100 <= -3, undefined, { timeout: 30_000 });
  const toMinus3 = (Date.now() - t0) / 1000;
  await settled(page);
  const toFloor = (Date.now() - t0) / 1000 - toMinus3;
  const floor = await exposure(page);
  console.log(`dark frame: EV100 ${floor.ev100.toFixed(2)}; ${toMinus3.toFixed(1)} s down to EV -3, ${toFloor.toFixed(1)} s more to the floor`);
  expect(floor.ev100).toBeCloseTo(EV_DARK_FLOOR, 1);
  expect(toFloor, 'seconds of dark adaptation from EV -3 to the floor').toBeGreaterThan(18);
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

test('overflow: sun disc and a mirror ball at the dark-adapted floor never produce NaN, the small disc keeps its energy through the resolve, and the image recovers as exposure adapts', async ({ page, pageLog }) => {
  // The sim is paused, so the camera that places the sun is the camera the frame is rendered with (in a
  // running sim the vessel moves 24 m per frame under a camera 40 m away).
  await openPage(page, '/labs/render-core/?scene=translunar&planet=0&stand=0&probe=ball,mirror,sun&orbit=20,10,40&hud=0&fov=100&paused=1&scale=1');
  await assertDiscreteGpu(page);
  // Sun 25 deg to the right of the view axis, taken from the camera's own basis: inside the 100 deg field
  // of view together with both balls. At this field of view the disc is about 3 px across.
  await page.evaluate(() => {
    const rotate = (q: { x: number; y: number; z: number; w: number }, v: { x: number; y: number; z: number }): { x: number; y: number; z: number } => {
      const cx = q.y * v.z - q.z * v.y + q.w * v.x;
      const cy = q.z * v.x - q.x * v.z + q.w * v.y;
      const cz = q.x * v.y - q.y * v.x + q.w * v.z;
      return { x: v.x + 2 * (q.y * cz - q.z * cy), y: v.y + 2 * (q.z * cx - q.x * cz), z: v.z + 2 * (q.x * cy - q.y * cx) };
    };
    window.__rc!.setSunOverride({
      dirRoot: () => {
        const q = window.__lab!.cameraState().qViewToRoot;
        const f = rotate(q, { x: 0, y: 0, z: -1 });
        const r = rotate(q, { x: 1, y: 0, z: 0 });
        const a = (25 * Math.PI) / 180;
        return { x: f.x * Math.cos(a) + r.x * Math.sin(a), y: f.y * Math.cos(a) + r.y * Math.sin(a), z: f.z * Math.cos(a) + r.z * Math.sin(a) };
      },
    });
  });
  await waitIdle(page, 10);
  const r = await page.evaluate(async (floorEv) => {
    const lab = window.__lab!;
    lab.renderer.setExposureOverride(floorEv);
    lab.setLoop(false);
    /** Where the sun is in the HDR target, and how many saturated SKY pixels (depth == 0) lie on its disc. */
    const sunOnScreen = async (): Promise<{ x: number; y: number; inFrame: boolean; saturatedSky: number; saturatedGeometry: number }> => {
      const f = lab.renderer.frameContext!;
      const s = f.sun.dirRoot;
      const m = f.view;
      const vx = m[0]! * s.x + m[4]! * s.y + m[8]! * s.z;
      const vy = m[1]! * s.x + m[5]! * s.y + m[9]! * s.z;
      const vz = m[2]! * s.x + m[6]! * s.y + m[10]! * s.z;
      const [w, h] = f.renderSize;
      const x = (((f.projUnjittered[0]! * vx) / -vz) * 0.5 + 0.5) * w;
      const y = (0.5 - ((f.projUnjittered[5]! * vy) / -vz) * 0.5) * h;
      const img = await lab.renderer.readHdrPixels('hdr');
      const depth = await lab.renderer.readDepth();
      let saturatedSky = 0;
      let saturatedGeometry = 0;
      for (let i = 0; i < w * h; i++) {
        if (!(img.data[i * 4 + 1]! > 50000)) continue;
        if (depth.data[i] !== 0) saturatedGeometry++;
        else if (Math.hypot((i % w) + 0.5 - x, Math.floor(i / w) + 0.5 - y) < 6) saturatedSky++;
      }
      return { x, y, inFrame: vz < 0 && x >= 0 && y >= 0 && x < w && y < h, saturatedSky, saturatedGeometry };
    };
    const frames: { hdr: { maxLuminance: number; nanPixels: number }; resolved: { maxLuminance: number; nanPixels: number }; sun: Awaited<ReturnType<typeof sunOnScreen>> }[] = [];
    for (let i = 0; i < 12; i++) {
      lab.renderFrame(1 / 60);
      frames.push({ hdr: await lab.renderer.readHdrStats('hdr'), resolved: await lab.renderer.readHdrStats('resolved'), sun: await sunOnScreen() });
    }
    // The resolved image around the sun only (the mirror ball saturates too): brightest pixel within 6 px of the disc centre.
    const sun = frames[frames.length - 1]!.sun;
    const box = { x: Math.max(0, Math.round(sun.x) - 6), y: Math.max(0, Math.round(sun.y) - 6), width: 13, height: 13 };
    const around = await lab.renderer.readHdrPixels('resolved', box);
    let resolvedSunMax = 0;
    for (let i = 0; i < around.data.length; i += 4) resolvedSunMax = Math.max(resolvedSunMax, around.data[i + 1]!);
    // Energy of the disc after the resolve has settled (the rim takes about two seconds): sums over the
    // box in the HDR target and in the resolved image, averaged over one jitter cycle.
    for (let i = 0; i < 180; i++) lab.renderFrame(1 / 60);
    let hdrEnergy = 0;
    let resolvedEnergy = 0;
    for (let i = 0; i < 8; i++) {
      lab.renderFrame(1 / 60);
      const h = await lab.renderer.readHdrPixels('hdr', box);
      const s = await lab.renderer.readHdrPixels('resolved', box);
      for (let k = 0; k < h.data.length; k += 4) {
        hdrEnergy += h.data[k + 1]! / 8;
        resolvedEnergy += s.data[k + 1]! / 8;
      }
    }
    // Release the override: exposure adapts from the floor upwards; check every frame on the way.
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
    return { frames, recovery, resolvedSunMax, hdrEnergy, resolvedEnergy };
  }, EV_DARK_FLOOR);
  for (const f of r.frames) {
    // The sun disc really is in the frame, on sky pixels, saturated: this is the overflow path under test.
    expect(f.sun.inFrame).toBe(true);
    expect(f.sun.saturatedSky).toBeGreaterThanOrEqual(1);
    expect(f.sun.saturatedGeometry).toBeGreaterThanOrEqual(1); // the glint on the mirror ball
    expect(f.hdr.nanPixels).toBe(0);
    expect(f.resolved.nanPixels).toBe(0);
    // The sun disc saturates exactly at HDR_MAX (60,000 per channel), never above.
    expect(f.hdr.maxLuminance).toBeGreaterThan(50000);
    expect(f.hdr.maxLuminance).toBeLessThanOrEqual(60001);
    expect(f.resolved.maxLuminance).toBeLessThanOrEqual(60001);
  }
  for (const f of r.recovery) expect(f.nan).toBe(0);
  const last = r.recovery[r.recovery.length - 1]!;
  const sun = r.frames[r.frames.length - 1]!.sun;
  console.log(
    `overflow: sun at (${sun.x.toFixed(0)}, ${sun.y.toFixed(0)}) with ${r.frames.map((f) => f.sun.saturatedSky).join(',')} saturated sky pixels per frame, ${sun.saturatedGeometry} saturated geometry pixels; ` +
      `HDR max ${r.frames[0]!.hdr.maxLuminance.toFixed(0)}, resolved max at the sun after 12 frames ${r.resolvedSunMax.toFixed(0)}; ` +
      `disc energy after 200 frames: resolved ${r.resolvedEnergy.toFixed(0)} of ${r.hdrEnergy.toFixed(0)} in the HDR target (${((100 * r.resolvedEnergy) / r.hdrEnergy).toFixed(0)} %); EV100 after recovery ${last.ev.toFixed(2)}`,
  );
  // ARCHITECTURE 10.4: the saturated disc still drives bloom. A disc of about 9 pixels comes out of the
  // resolve with its peak within a few frames (it used to stick at 4 % of HDR_MAX: 2,412) and with most of
  // its energy once the rim has converged (it used to keep under 1 %).
  expect(r.resolvedSunMax).toBeGreaterThan(0.5 * 60000);
  expect(r.resolvedEnergy).toBeGreaterThan(0.6 * r.hdrEnergy);
  expect(r.resolvedEnergy).toBeLessThan(1.1 * r.hdrEnergy);
  expect(last.ev).toBeGreaterThan(13);
  await page.evaluate(() => window.__test!.waitFrames(30));
  const shot = await saveScreenshot(page, 'render-core', 'overflow-recovered');
  // Recovered: a black sky with the sun (and its glow) and two back-lit balls, not a white-out.
  expect(shot.stats.meanLuma).toBeLessThan(60);
  expect(shot.stats.maxLuma).toBeGreaterThan(200);
  // The glow of the disc: the display image is clearly brighter in a ring 5-9 px from the disc centre
  // than far away from it on the same black sky.
  const png = PNG.sync.read(shot.buffer);
  const ringMean = (r0: number, r1: number): number => {
    let sum = 0;
    let n = 0;
    for (let y = Math.floor(sun.y - r1); y <= sun.y + r1; y++) {
      for (let x = Math.floor(sun.x - r1); x <= sun.x + r1; x++) {
        const d = Math.hypot(x + 0.5 - sun.x, y + 0.5 - sun.y);
        if (d < r0 || d > r1 || x < 0 || y < 0 || x >= png.width || y >= png.height) continue;
        const i = (y * png.width + x) * 4;
        sum += 0.2126 * png.data[i]! + 0.7152 * png.data[i + 1]! + 0.0722 * png.data[i + 2]!;
        n++;
      }
    }
    return sum / Math.max(1, n);
  };
  const glow = ringMean(5, 9);
  const sky = ringMean(70, 80);
  console.log(`overflow: glow around the recovered sun ${glow.toFixed(1)} / 255 at 5-9 px, sky ${sky.toFixed(1)} / 255 at 70-80 px`);
  expect(glow).toBeGreaterThan(sky + 12);
  await expectNoErrors(page, pageLog);
});

test('the canvas is the display transform of the resolved image: AgX above three stops under mid-grey, the linear toe below four', async ({ page, pageLog }) => {
  // The LabPlanet from low orbit with no bloom to speak of and a still camera: the canvas pixel must be what
  // the CPU port of the tonemap pass makes of the resolved HDR pixel, at the daylight exposure and four to
  // seven stops under it (where the toe decides: request sky-lighting-3).
  await openPage(page, '/labs/render-core/?scene=lowOrbit&stand=0&hud=0&paused=1&deterministic=1&scale=1&governor=off&body=earth&lat=10&lon=-150&alt=300000&pitch=-60');
  await assertDiscreteGpu(page);
  await page.evaluate(() => window.__lab!.renderer.setJitter(false));
  await waitIdle(page, 20);
  const s16 = await sunny16(page);
  const rows: string[] = [];
  for (const stopsUnder of [0, 4, 5.5, 7]) {
    await page.evaluate((ev) => window.__lab!.renderer.setExposureOverride(ev), s16 + stopsUnder);
    await page.evaluate(() => window.__test!.waitFrames(24));
    const hdr = await page.evaluate(async () => {
      const px = await window.__lab!.renderer.readHdrPixels('resolved');
      return { width: px.width, height: px.height, data: Array.from(px.data) };
    });
    const png = PNG.sync.read(await page.screenshot());
    expect([png.width, png.height]).toEqual([hdr.width, hdr.height]);
    const errors: number[] = [];
    let darkest = Infinity;
    let brightest = -Infinity;
    let inToe = 0;
    for (let y = 8; y < hdr.height - 8; y += 12) {
      for (let x = 8; x < hdr.width - 8; x += 12) {
        const at = (dx: number, dy: number, c: number): number => hdr.data[((y + dy) * hdr.width + x + dx) * 4 + c]!;
        // Smooth places only: where the four neighbours agree within 2 %, sharpening and bloom change nothing.
        let smooth = at(0, 0, 1) > 1e-7;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [3, 3], [-3, -3]] as const) for (let c = 0; c < 3; c++) if (Math.abs(at(dx, dy, c) - at(0, 0, c)) > 0.02 * at(0, 0, c) + 1e-6) smooth = false;
        if (!smooth) continue;
        const want = displayLinear([at(0, 0, 0), at(0, 0, 1), at(0, 0, 2)]).map((v) => 255 * srgbEncode(v));
        const o = (y * png.width + x) * 4;
        for (let c = 0; c < 3; c++) errors.push(Math.abs(png.data[o + c]! - want[c]!));
        const level = Math.log2(Math.max(0.2126 * at(0, 0, 0) + 0.7152 * at(0, 0, 1) + 0.0722 * at(0, 0, 2), 1e-12) / 0.18);
        darkest = Math.min(darkest, level);
        brightest = Math.max(brightest, level);
        if (level < -4) inToe++;
      }
    }
    errors.sort((a, b) => a - b);
    const p = (q: number): number => errors[Math.min(errors.length - 1, Math.floor(q * errors.length))] ?? NaN;
    rows.push(`${stopsUnder} stops under daylight: ${errors.length / 3} smooth pixels from ${darkest.toFixed(1)} to ${brightest.toFixed(1)} stops around mid-grey (${inToe} below -4), canvas against the CPU transform: median ${p(0.5).toFixed(2)}, 99th percentile ${p(0.99).toFixed(2)} of 255`);
    expect(errors.length, 'smooth pixels compared').toBeGreaterThan(3000);
    // One level of dither on each side, and the sharpening's and the bloom's last per cent.
    expect(p(0.5)).toBeLessThan(1.0);
    expect(p(0.99)).toBeLessThan(2.5);
    if (stopsUnder >= 5.5) expect(inToe, 'smooth pixels more than four stops under mid-grey (the linear toe)').toBeGreaterThan(2000);
  }
  for (const row of rows) console.log(row);
  await page.evaluate(() => window.__lab!.renderer.setExposureOverride(null));
  await expectNoErrors(page, pageLog);
});

test('the meter sees what is lit, not what emits in front of it: a flame over sunlit ground clips and the day stays a day (request vfx-4)', async ({ page, pageLog }) => {
  // Sunlit ground fills the frame; the flame probe draws an additive transparent over 9 % of it.
  await openPage(page, '/labs/render-core/?scene=lowOrbit&stand=0&hud=0&probe=flame&scale=1&governor=off&body=earth&lat=10&lon=-150&alt=300000&pitch=-60');
  await assertDiscreteGpu(page);
  await waitIdle(page, 30);
  await settled(page);
  const before = await exposure(page);
  const s16 = await sunny16(page);
  const centre = async (): Promise<number> => {
    const png = PNG.sync.read(await page.screenshot());
    const o = (Math.floor(png.height / 2) * png.width + Math.floor(png.width / 2)) * 4;
    return Math.min(png.data[o]!, png.data[o + 1]!, png.data[o + 2]!);
  };
  const groundLevel = await centre();
  // A flame of 2e7 cd/m^2 (five hundred times sunlit white) for two seconds.
  await page.evaluate(() => window.__rc!.probes.setFlame(2e7));
  await page.evaluate(() => window.__test!.waitFrames(120));
  const during = await exposure(page);
  const flameLevel = await centre();
  await saveScreenshot(page, 'render-core', 'exposure-flame-over-ground');
  await page.evaluate(() => window.__rc!.probes.setFlame(0));
  console.log(`flame over sunlit ground: EV100 ${before.ev100.toFixed(2)} -> ${during.ev100.toFixed(2)} (target ${before.targetEv100.toFixed(2)} -> ${during.targetEv100.toFixed(2)}, sunny 16 = ${s16.toFixed(2)}); centre pixel ${groundLevel} -> ${flameLevel} of 255`);
  expect(Math.abs(during.targetEv100 - before.targetEv100), 'change of the exposure target when the flame appears (EV)').toBeLessThan(0.05);
  expect(Math.abs(during.ev100 - before.ev100)).toBeLessThan(0.05);
  expect(flameLevel, 'the flame clips').toBeGreaterThanOrEqual(250);
  expect(groundLevel).toBeLessThan(240);
  await expectNoErrors(page, pageLog);
});
