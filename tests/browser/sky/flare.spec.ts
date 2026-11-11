import type { Page } from '@playwright/test';
import { assertDiscreteGpu, expect, expectNoErrors, openPage, saveScreenshot, test, waitIdle } from '../harness';

/**
 * Lens flare: energy under 1 % of the source (HDR readback, flare on minus off); the GPU image equals the CPU
 * model of the flare over the whole sphere (flare.ts flareRadiance) pixel by pixel wherever the sun is, on axis,
 * far off axis and outside the frame, so no term is cut by the geometry it is drawn with; the glare fades out
 * through the lens hood as the sun leaves the frame instead of ending; attenuated by the visible fraction of
 * the disc ('scene.depth') and by the cloud transmittance at the sun ('clouds.screen'.a, a synthetic opaque
 * layer published by the lab); suppressed for interior cameras.
 */
test.describe.configure({ timeout: 900_000 });

/** Sun `offAxisDeg` from the view axis (horizontally), camera on the active vessel, sim paused, static TAA input. */
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

interface FlareMeasure {
  /** On-screen flare illuminance / sun illuminance: GPU (HDR flare on - off) and the CPU model integrated over the same pixels. */
  fraction: number;
  cpuFraction: number;
  /** Largest relative per-pixel difference GPU vs CPU where the model exceeds 1e-3 (pre-exposed), outside 3 px of the disc. */
  maxRel: number;
  compared: number;
  maxDiff: number;
  drawn: boolean;
  /** Horizontal NDC of the sun. */
  sunNdcX: number;
  state: { visible: number; cloud: number; inView: number; hood: number };
}

async function flareMeasure(page: Page): Promise<FlareMeasure> {
  return page.evaluate(async () => {
    const lab = window.__lab!;
    const sky = window.__sky!;
    const read = async () => (await lab.renderer.readHdrPixels('hdr')).data;
    sky.sky!.parts.flare = true;
    await window.__test!.waitFrames(3);
    const on = await read();
    const drawn = sky.sky!.status().flareDrawn;
    const state = await sky.sky!.readFlareState();
    sky.sky!.parts.flare = false;
    await window.__test!.waitFrames(3);
    const off = await read();
    sky.sky!.parts.flare = true;
    const f = lab.renderer.frameContext!;
    const g = sky.flareGeometry()!;
    const [w, h] = f.renderSize;
    const { tanX, tanY } = g.view;
    const pixelAngle = (2 * tanY) / h;
    const lw = [0.2126, 0.7152, 0.0722];
    const source = [0, 1, 2].map((c) => f.sun.color[c]! * f.sun.illuminance * state.transmittance[c]! * state.visible * state.cloud * state.hood * f.exposure);
    const excl = f.sun.angularRadius + 3 * pixelAngle;
    let sum = 0;
    let sumCpu = 0;
    let maxRel = 0;
    let compared = 0;
    let maxDiff = 0;
    for (let y = 0; y < h; y++) {
      const yn = 1 - (2 * (y + 0.5)) / h;
      for (let x = 0; x < w; x++) {
        const xn = (2 * (x + 0.5)) / w - 1;
        const i = (y * w + x) * 4;
        const gpu = lw[0]! * (on[i]! - off[i]!) + lw[1]! * (on[i + 1]! - off[i + 1]!) + lw[2]! * (on[i + 2]! - off[i + 2]!);
        maxDiff = Math.max(maxDiff, Math.abs(gpu));
        const d = sky.cpu.ndcDirection(g.view, xn, yn);
        const L = drawn ? sky.cpu.flareRadiance(g, d, pixelAngle) : [0, 0, 0];
        const cpu = lw[0]! * L[0]! * source[0]! + lw[1]! * L[1]! * source[1]! + lw[2]! * L[2]! * source[2]!;
        // Pixel solid angle: on-axis value x cos^3 of the pixel's angle off the axis.
        const u = xn * tanX;
        const v = yn * tanY;
        const omega = ((2 * tanX) / w) * ((2 * tanY) / h) * (1 + u * u + v * v) ** -1.5;
        sum += gpu * omega;
        sumCpu += cpu * omega;
        const theta = Math.acos(Math.min(1, d.x * g.sun.x + d.y * g.sun.y + d.z * g.sun.z));
        if (cpu > 1e-3 && theta > excl) {
          compared++;
          maxRel = Math.max(maxRel, Math.abs(gpu - cpu) / cpu);
        }
      }
    }
    const e = f.exposure * f.sun.illuminance;
    return { fraction: sum / e, cpuFraction: sumCpu / e, maxRel, compared, maxDiff, drawn, sunNdcX: g.sunNdc[0], state: { visible: state.visible, cloud: state.cloud, inView: state.inView, hood: state.hood } };
  });
}

const fmt = (m: FlareMeasure): string =>
  `sun NDC x ${m.sunNdcX.toFixed(3)}: flare ${(m.fraction * 100).toFixed(4)} % on screen, CPU model ${(m.cpuFraction * 100).toFixed(4)} %, per-pixel max rel. difference ${(m.maxRel * 100).toFixed(2)} % over ${m.compared} px; visible ${m.state.visible.toFixed(3)}, hood ${m.state.hood.toFixed(4)}, in view ${m.state.inView}`;

test('flare energy is under 1 %, the image equals the whole-sphere flare model on and far off axis, and it vanishes behind a cloud layer', async ({ page, pageLog }) => {
  await openPage(page, '/labs/sky/?scene=translunar&planet=0&parts=-stars,-milkyWay,-impostors,-probe&ev=12&hud=0');
  await assertDiscreteGpu(page);
  await waitIdle(page, 4, 300_000);
  // 6 deg: the original check; 25 / 35 / 44 deg: the sun far off axis (the horizontal half-field is 45.7 deg),
  // where quads sized with the on-axis image scale used to cut the starburst and square the ghosts.
  const results: { off: number; m: FlareMeasure }[] = [];
  for (const off of [6, 25, 35, 44]) {
    await aimNearSun(page, off, 60);
    const m = await flareMeasure(page);
    console.log(`${String(off).padStart(2)} deg off axis: ${fmt(m)}`);
    results.push({ off, m });
    if (off === 35) {
      await page.evaluate(() => window.__test!.waitFrames(30));
      await saveScreenshot(page, 'sky', 'flare-off-axis-35deg-ev12');
    }
    if (off === 6) {
      await page.evaluate(() => window.__test!.waitFrames(30));
      await saveScreenshot(page, 'sky', 'flare-deep-space-ev12');
      // Three stops brighter: the glare's visible extent grows (by 2^(3/3) = 2 for the theta^-3 halo); it has no fixed rim.
      await page.evaluate(() => window.__lab!.renderer.setExposureOverride(9));
      await page.evaluate(() => window.__test!.waitFrames(30));
      await saveScreenshot(page, 'sky', 'flare-deep-space-ev9');
      await page.evaluate(() => window.__lab!.renderer.setExposureOverride(12));
      await page.evaluate(() => window.__test!.waitFrames(6));
    }
  }
  for (const { m } of results) {
    expect(m.drawn).toBe(true);
    expect(m.state.visible).toBe(1);
    expect(m.state.hood).toBe(1);
    expect(m.fraction).toBeGreaterThan(0.002);
    expect(m.fraction).toBeLessThan(0.01);
    expect(Math.abs(m.fraction / m.cpuFraction - 1)).toBeLessThan(0.01);
    expect(m.compared).toBeGreaterThan(100_000);
    expect(m.maxRel).toBeLessThan(0.02);
  }

  await aimNearSun(page, 6, 60);
  await page.evaluate(() => window.__sky!.setCloudCover(true));
  await page.evaluate(() => window.__test!.waitFrames(3));
  const cloudy = await flareMeasure(page);
  console.log(`opaque cloud layer in front of the sun: cloud transmittance ${cloudy.state.cloud.toFixed(3)}, flare contribution max ${cloudy.maxDiff}`);
  expect(cloudy.state.cloud).toBe(0);
  expect(cloudy.maxDiff).toBe(0);
  await page.evaluate(() => window.__sky!.setCloudCover(false));
  await expectNoErrors(page, pageLog);
});

test('the glare fades out through the lens hood as the sun leaves the frame', async ({ page, pageLog }) => {
  await openPage(page, '/labs/sky/?scene=translunar&planet=0&parts=-stars,-milkyWay,-impostors,-probe&ev=12&hud=0');
  await assertDiscreteGpu(page);
  await waitIdle(page, 4, 300_000);
  await aimNearSun(page, 6, 60);
  const tanX = await page.evaluate(() => window.__sky!.flareGeometry()!.view.tanX);
  const edge = (Math.atan(tanX) * 180) / Math.PI;
  // Hood depth 2 pupil diameters: the pupil is fully shadowed 0.5 in tangent beyond the frame's half-tangent.
  const cutoff = (Math.atan(tanX + 0.5) * 180) / Math.PI;
  // 0.1 deg steps (1.2 px) across the edge (the disc's radius is 0.27 deg), then out to beyond the hood's cut-off.
  const fine = Array.from({ length: 11 }, (_, i) => -0.5 + 0.1 * i);
  const offsets = [-1, ...fine, 1, 3, 6, 9, cutoff - edge + 0.5];
  const rows: { off: number; m: FlareMeasure }[] = [];
  for (const o of offsets) {
    await aimNearSun(page, edge + o, 60);
    const m = await flareMeasure(page);
    console.log(`sun ${o >= 0 ? '+' : ''}${o.toFixed(2)} deg from the frame edge: ${fmt(m)}`);
    rows.push({ off: o, m });
    if (Math.abs(o - 0.3) < 1e-9) {
      await page.evaluate(() => window.__test!.waitFrames(30));
      await saveScreenshot(page, 'sky', 'flare-sun-just-outside-frame-ev12');
    }
  }
  // Leaving the frame does not cut the glare: across the edge every 0.1 deg pan changes what the screen shows by
  // under 10 % (the part of the halo core that leaves the frame); the disc, wholly outside, still counts as visible.
  for (let i = 1; i < fine.length; i++) {
    const a = rows.find((r) => Math.abs(r.off - fine[i - 1]!) < 1e-9)!.m;
    const b = rows.find((r) => Math.abs(r.off - fine[i]!) < 1e-9)!.m;
    expect(b.drawn).toBe(true);
    expect(Math.abs(b.fraction / a.fraction - 1)).toBeLessThan(0.1);
  }
  const justOut = rows.find((r) => Math.abs(r.off - 0.3) < 1e-9)!.m;
  expect(justOut.state.inView).toBe(0);
  expect(justOut.state.visible).toBe(1);
  // Beyond the edge it falls monotonically to nothing at the hood's cut-off.
  const outside = rows.filter((r) => r.off > 0);
  for (let i = 1; i < outside.length; i++) expect(outside[i]!.m.fraction).toBeLessThanOrEqual(outside[i - 1]!.m.fraction);
  const last = outside[outside.length - 1]!.m;
  expect(last.drawn).toBe(false);
  expect(last.maxDiff).toBe(0);
  // Wherever it is drawn, the image is the flare model (no term cut by its geometry).
  for (const { m } of rows) {
    if (!m.drawn) continue;
    expect(Math.abs(m.fraction - m.cpuFraction)).toBeLessThan(0.01 * m.cpuFraction + 1e-7);
    if (m.compared > 1000) expect(m.maxRel).toBeLessThan(0.02);
  }
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
    const r = await flareMeasure(page);
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
  // The sun just outside the frame and behind the limb: no glare (the frame bodies hide off-screen disc samples).
  await page.evaluate(() => window.__sky!.setSunForVessel({ elevationDeg: -14.17 - 1, azimuthDeg: 0 }));
  await page.evaluate(() => window.__test!.waitFrames(3));
  const tanX = await page.evaluate(() => window.__sky!.flareGeometry()!.view.tanX);
  await aimNearSun(page, (Math.atan(tanX) * 180) / Math.PI + 1, 30);
  const hidden = await flareMeasure(page);
  console.log(`sun 1 deg outside the frame and 1 deg below the limb: visible ${hidden.state.visible.toFixed(3)}, hood ${hidden.state.hood.toFixed(3)}, flare max ${hidden.maxDiff}`);
  expect(hidden.state.visible).toBe(0);
  expect(hidden.maxDiff).toBe(0);
  await page.evaluate(() => {
    window.__lab!.setPaused(false);
    window.__lab!.setDeterministic(false);
    window.__lab!.camera.settings.kind = 'interior';
  });
  await page.evaluate(() => window.__sky!.setSunForVessel({ elevationDeg: 20, azimuthDeg: 0 }));
  await aimNearSun(page, 4, 30);
  const interior = await page.evaluate(() => window.__sky!.sky!.status().flareDrawn);
  expect(interior).toBe(false);
  await expectNoErrors(page, pageLog);
});
