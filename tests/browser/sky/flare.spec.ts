import type { Page } from '@playwright/test';
import { PNG } from 'pngjs';
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

/** EV100 a sunlit Earth meters to in this lab (stars.spec: 14.4): the exposure the flare is seen at in play. */
const METERED_EV = 14.4;

/** Screenshot at another hand-set exposure, then back to EV 12 (the exposure of the HDR measurements). */
async function shootAt(page: Page, ev: number, name: string): Promise<Buffer> {
  await page.evaluate((e) => window.__lab!.renderer.setExposureOverride(e), ev);
  await page.evaluate(() => window.__test!.waitFrames(30));
  const shot = await saveScreenshot(page, 'sky', name);
  await page.evaluate(() => window.__lab!.renderer.setExposureOverride(12));
  await page.evaluate(() => window.__test!.waitFrames(6));
  return shot.buffer;
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
      await shootAt(page, METERED_EV, 'flare-off-axis-35deg-ev14');
    }
    if (off === 6) {
      await page.evaluate(() => window.__test!.waitFrames(30));
      await saveScreenshot(page, 'sky', 'flare-deep-space-ev12');
      // The exposure of a sunlit scene, and 5.4 stops over it (the glare veils the whole frame; it has no rim).
      await shootAt(page, METERED_EV, 'flare-deep-space-ev14');
      await shootAt(page, 9, 'flare-deep-space-ev9');
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
      await shootAt(page, METERED_EV, 'flare-sun-just-outside-frame-ev14');
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

/** Decoded display image with luma and channel lookups (nearest pixel; -1 outside the frame). */
function displayImage(buffer: Buffer): { w: number; h: number; luma(x: number, y: number): number; rgb(x: number, y: number): [number, number, number] | null } {
  const png = PNG.sync.read(buffer);
  const at = (x: number, y: number): number => (Math.round(y) * png.width + Math.round(x)) * 4;
  const inside = (x: number, y: number): boolean => Math.round(x) >= 0 && Math.round(y) >= 0 && Math.round(x) < png.width && Math.round(y) < png.height;
  return {
    w: png.width,
    h: png.height,
    luma: (x, y) => (inside(x, y) ? 0.2126 * png.data[at(x, y)]! + 0.7152 * png.data[at(x, y) + 1]! + 0.0722 * png.data[at(x, y) + 2]! : -1),
    rgb: (x, y) => (inside(x, y) ? [png.data[at(x, y)]!, png.data[at(x, y) + 1]!, png.data[at(x, y) + 2]!] : null),
  };
}
const median = (v: number[]): number => [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)]!;

test('display image at the exposure of a sunlit scene: wedge rays that end, a glare without a rim, dim ghosts, haze only from a sun outside the frame', async ({ page, pageLog }) => {
  await openPage(page, '/labs/sky/?scene=translunar&planet=0&parts=-stars,-milkyWay,-impostors,-probe&ev=12&hud=0');
  await assertDiscreteGpu(page);
  await waitIdle(page, 4, 300_000);
  await aimNearSun(page, 6, 60);
  const geo = await page.evaluate(() => {
    const f = window.__lab!.renderer.frameContext!;
    const p = window.__sky!.projectDir(f.sun.dirRoot)!;
    return { x: p.x, y: p.y, pxAngle: (2 * Math.tan(f.camera.fovY / 2)) / f.renderSize[1], rs: f.sun.angularRadius, w: f.renderSize[0], h: f.renderSize[1] };
  });
  const img = displayImage(await shootAt(page, METERED_EV, 'flare-display-check-ev14'));
  expect(img.w).toBe(geo.w);
  const pxOf = (deg: number): number => Math.tan((deg * Math.PI) / 180) / geo.pxAngle;
  /**
   * Pixels on the cone of constant angle from the sun whose radius is r px at the image centre (atan(r x pixel
   * angle)), 0.25 deg steps in azimuth from the image-plane up towards right; off axis that cone is not a circle
   * on the screen. Pixels outside the frame are dropped.
   */
  const tanY = (geo.pxAngle * geo.h) / 2;
  const tanX = (tanY * geo.w) / geo.h;
  const coneOf = (sun: { x: number; y: number }, r: number): { phi: number; x: number; y: number }[] => {
    // View space: x right, y up, z along the view axis.
    const s0 = [((2 * sun.x) / geo.w - 1) * tanX, (1 - (2 * sun.y) / geo.h) * tanY, 1];
    const sl = Math.hypot(s0[0]!, s0[1]!, s0[2]!);
    const sv = s0.map((v) => v / sl);
    const upRaw = [-sv[0]! * sv[1]!, 1 - sv[1]! * sv[1]!, -sv[2]! * sv[1]!];
    const ul = Math.hypot(upRaw[0]!, upRaw[1]!, upRaw[2]!);
    const up = upRaw.map((v) => v / ul);
    // right = up x s for these axes (x right, y up, z forward).
    const rt = [up[1]! * sv[2]! - up[2]! * sv[1]!, up[2]! * sv[0]! - up[0]! * sv[2]!, up[0]! * sv[1]! - up[1]! * sv[0]!];
    const theta = Math.atan(r * geo.pxAngle);
    const out: { phi: number; x: number; y: number }[] = [];
    for (let i = 0; i < 1440; i++) {
      const phi = (i * Math.PI) / 720;
      const d = [0, 1, 2].map((k) => sv[k]! * Math.cos(theta) + (up[k]! * Math.cos(phi) + rt[k]! * Math.sin(phi)) * Math.sin(theta));
      if (d[2]! <= 1e-6) continue;
      const x = ((d[0]! / d[2]! / tanX + 1) / 2) * geo.w;
      const y = ((1 - d[1]! / d[2]! / tanY) / 2) * geo.h;
      if (x >= 0 && y >= 0 && x <= geo.w - 1 && y <= geo.h - 1) out.push({ phi, x, y });
    }
    return out;
  };
  const ring = (r: number): { phi: number; l: number; x: number; y: number }[] => coneOf(geo, r).map((q) => ({ ...q, l: img.luma(q.x, q.y) }));

  // (a) Glare: the median over the azimuth falls monotonically and meets black without a rim.
  const radii: number[] = [];
  for (let r = 16; r < 0.5 * geo.w; r += 4) radii.push(r);
  const profile = radii.map((r) => ({ r, m: median(ring(r).map((s) => s.l)), n: ring(r).length })).filter((p) => p.n > 700);
  console.log(`glare profile (median 8-bit luma at r px): ${profile.filter((_, i) => i % 6 === 0).map((p) => `${p.r}: ${p.m.toFixed(1)}`).join('  ')}`);
  for (let i = 1; i < profile.length; i++) expect(profile[i]!.m).toBeLessThanOrEqual(profile[i - 1]!.m + 1);
  const r16 = profile.find((p) => p.m < 16)!;
  const far = profile.filter((p) => p.r >= 2 * r16.r);
  console.log(`glare under 16/255 from ${r16.r} px; at twice that radius ${far[0]?.m.toFixed(1)}/255; steepest fall beyond it ${Math.max(...profile.filter((p) => p.r >= r16.r).map((p, i, a) => (i > 0 ? (a[i - 1]!.m - p.m) / 4 : 0))).toFixed(3)} levels/px`);
  expect(far.length).toBeGreaterThan(0);
  // From the radius where it is under 16/255 it takes more than a doubling of the radius to reach black.
  expect(far[0]!.m).toBeGreaterThanOrEqual(1);
  // No rim: once it is under 16/255 (from a quarter beyond that radius: the theta^-2 skirt itself falls 0.25 levels
  // per px where it crosses the knee of the tone curve) it sinks slowly, under 0.15 levels per px (8 px baseline: the
  // medians are quantised to one level).
  const tail = profile.filter((p) => p.r >= 1.25 * r16.r);
  for (let i = 2; i < tail.length; i++) expect((tail[i - 2]!.m - tail[i]!.m) / 8).toBeLessThan(0.15);
  // No colour cast where it fades: the tail keeps the colour of the source (the sun's own slightly warm white) to
  // within 3 % in R/G and B/G, at every radius (ring means: the medians are quantised).
  const sunColour = await page.evaluate(() => window.__lab!.renderer.frameContext!.sun.color);
  const casts: string[] = [];
  for (const p of profile.filter((q) => q.m < 60 && q.m > 6 && q.r % 24 === 0)) {
    const px = ring(p.r).map((s) => img.rgb(s.x, s.y)!);
    const c = [0, 1, 2].map((k) => px.reduce((acc, v) => acc + v[k]!, 0) / px.length);
    casts.push(`${p.r}: R/G ${(c[0]! / c[1]!).toFixed(3)} B/G ${(c[2]! / c[1]!).toFixed(3)}`);
    expect(Math.abs(c[0]! / c[1]! - sunColour[0] / sunColour[1])).toBeLessThan(0.03);
    expect(Math.abs(c[2]! / c[1]! - sunColour[2] / sunColour[1])).toBeLessThan(0.03);
  }
  console.log(`colour along the tail (the sun: R/G ${(sunColour[0] / sunColour[1]).toFixed(3)} B/G ${(sunColour[2] / sunColour[1]).toFixed(3)}): ${casts.join('  ')}`);

  // (b) Rays: at 60 px from the sun the strongest ray is at least as wide as the solar disc (half maximum over the glare).
  const at60 = ring(60);
  const base60 = median(at60.map((s) => s.l));
  const peak60 = at60.reduce((a, b) => (b.l > a.l ? b : a));
  let half = 0;
  for (const s of at60) {
    const d = Math.abs(Math.atan2(Math.sin(s.phi - peak60.phi), Math.cos(s.phi - peak60.phi)));
    if (d < 0.2 && s.l - base60 > 0.5 * (peak60.l - base60)) half = Math.max(half, d);
  }
  const widthPx = 2 * half * 60;
  const discPx = (2 * geo.rs) / geo.pxAngle;
  console.log(`strongest ray at 60 px: ${peak60.l.toFixed(0)}/255 over a glare of ${base60.toFixed(0)}/255, ${widthPx.toFixed(1)} px wide at half maximum (solar disc ${discPx.toFixed(1)} px)`);
  expect(peak60.l - base60).toBeGreaterThan(10);
  expect(widthPx).toBeGreaterThanOrEqual(discPx);
  // Rays differ: the fourteen peaks at 4 deg spread by more than 8 levels.
  const at4 = ring(pxOf(4));
  const base4 = median(at4.map((s) => s.l));
  const peaks: number[] = [];
  for (let j = 0; j < 14; j++) {
    const centre = (j * 2 * Math.PI) / 14;
    peaks.push(Math.max(...at4.filter((s) => Math.abs(Math.atan2(Math.sin(s.phi - centre), Math.cos(s.phi - centre))) < 0.12).map((s) => s.l)) - base4);
  }
  console.log(`ray peaks over the glare at 4 deg: ${peaks.map((v) => v.toFixed(0)).join(' ')}`);
  expect(Math.max(...peaks) - Math.min(...peaks)).toBeGreaterThan(8);
  // ... and they end: beyond 8.5 deg nothing stands more than 3 levels over the glare around it.
  for (const deg of [8.5, 10, 14, 20]) {
    const c = ring(pxOf(deg));
    const b = median(c.map((s) => s.l));
    // Ghosts are not rays: only directions outside the ghost line (within 12 deg of the axis through the image centre) count.
    const axis = Math.atan2(geo.w / 2 - geo.x, -(geo.h / 2 - geo.y));
    // A ray is at least a degree wide here: the ring is averaged over 2 deg windows (9 samples), which takes the
    // dither and the 8-bit steps out of the maximum.
    const smooth = c.map((s, i) => ({ phi: s.phi, l: [-4, -3, -2, -1, 0, 1, 2, 3, 4].reduce((acc, k) => acc + c[(i + k + c.length) % c.length]!.l, 0) / 9 }));
    // (the ghosts lie on the line through the image centre, on both sides of the sun, and are up to 5 deg wide: 1 rad about it is left out)
    const off = smooth.filter((s) => Math.abs(Math.atan2(Math.sin(s.phi - axis), Math.cos(s.phi - axis))) > 1.0 && Math.abs(Math.atan2(Math.sin(s.phi - axis - Math.PI), Math.cos(s.phi - axis - Math.PI))) > 1.0);
    const excess = Math.max(...off.map((s) => s.l)) - b;
    console.log(`${deg} deg from the sun: the brightest 2 deg of the ring stand ${excess.toFixed(1)}/255 over its median ${b.toFixed(0)}/255`);
    expect(excess).toBeLessThanOrEqual(3);
  }

  // (c) Ghosts: at this exposure none is brighter than a quarter of mid-grey over its surroundings (mid-grey 117/255, a quarter 55/255).
  await aimNearSun(page, 30, 60);
  const off30 = await page.evaluate(() => window.__sky!.projectDir(window.__lab!.renderer.frameContext!.sun.dirRoot)!);
  const ghosts = displayImage(await shootAt(page, METERED_EV, 'flare-off-axis-30deg-ev14'));
  // Beyond 20 deg from the sun (true angle: the glare is under 15/255 there) the brightest thing is a ghost.
  const viewDir = (x: number, y: number): [number, number, number] => {
    const d = [((2 * x) / geo.w - 1) * tanX, (1 - (2 * y) / geo.h) * tanY, 1];
    const l = Math.hypot(d[0]!, d[1]!, d[2]!);
    return [d[0]! / l, d[1]! / l, d[2]! / l];
  };
  const sun30 = viewDir(off30.x, off30.y);
  let ghostMax = 0;
  for (let y = 0; y < ghosts.h; y += 2) {
    for (let x = 0; x < ghosts.w; x += 2) {
      const d = viewDir(x, y);
      if (d[0] * sun30[0] + d[1] * sun30[1] + d[2] * sun30[2] < Math.cos((20 * Math.PI) / 180)) ghostMax = Math.max(ghostMax, ghosts.luma(x, y));
    }
  }
  console.log(`sun 30 deg off axis: brightest pixel further than 20 deg from the sun ${ghostMax.toFixed(0)}/255`);
  expect(ghostMax).toBeLessThan(55);

  // (d) Sun 0.3 deg outside the frame: haze at that edge and nothing else (no line, no bright ghost).
  await aimNearSun(page, (Math.atan(tanX) * 180) / Math.PI + 0.3, 60);
  const out = displayImage(await shootAt(page, METERED_EV, 'flare-sun-outside-display-check-ev14'));
  const sunOut = await page.evaluate(() => window.__sky!.projectDir(window.__lab!.renderer.frameContext!.sun.dirRoot)!);
  let worst = 0;
  for (const deg of [9, 12, 16, 24, 40]) {
    const r = pxOf(deg);
    const vals = coneOf(sunOut, r).map((q) => out.luma(q.x, q.y));
    if (vals.length < 40) continue;
    worst = Math.max(worst, Math.max(...vals) - median(vals));
  }
  console.log(`sun 0.3 deg outside the frame: largest excess over the ring median beyond 9 deg ${worst.toFixed(1)}/255`);
  expect(worst).toBeLessThan(12);
  await expectNoErrors(page, pageLog);
});
