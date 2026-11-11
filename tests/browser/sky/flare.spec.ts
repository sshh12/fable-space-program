import type { Page } from '@playwright/test';
import { PNG } from 'pngjs';
import { BLADES, RAY_REACH, SPIKE_COUNT, spikeBlade } from '../../../src/render/sky/flare';
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

/** Display-linear value of an 8-bit sRGB level. */
const toLinear = (v: number): number => {
  const x = v / 255;
  return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
};

interface SunGeo {
  /** The sun's render-target pixel. */
  x: number;
  y: number;
  /** Pixel angle at the image centre (rad), the sun's angular radius, render size. */
  pxAngle: number;
  rs: number;
  w: number;
  h: number;
}

async function sunGeo(page: Page): Promise<SunGeo> {
  return page.evaluate(() => {
    const f = window.__lab!.renderer.frameContext!;
    const p = window.__sky!.projectDir(f.sun.dirRoot)!;
    return { x: p.x, y: p.y, pxAngle: (2 * Math.tan(f.camera.fovY / 2)) / f.renderSize[1], rs: f.sun.angularRadius, w: f.renderSize[0], h: f.renderSize[1] };
  });
}

/**
 * Pixels on the cone of constant angle about `sun` whose radius is r px at the image centre (atan(r x pixel angle)),
 * 0.25 deg steps in azimuth from the image-plane up towards right (the flare's own azimuth: flare.ts rayProfile); off
 * axis that cone is not a circle on the screen. Pixels outside the frame are dropped.
 */
function coneOf(geo: SunGeo, sun: { x: number; y: number }, r: number): { phi: number; x: number; y: number }[] {
  const tanY = (geo.pxAngle * geo.h) / 2;
  const tanX = (tanY * geo.w) / geo.h;
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
}

/** Radius (px at the image centre) of the cone `deg` degrees about the sun. */
const pxOfDeg = (geo: SunGeo, deg: number): number => Math.tan((deg * Math.PI) / 180) / geo.pxAngle;

interface GlareReport {
  /** Clip radius: the first radius where the ring median falls under 250/255. */
  rc: number;
  /** Ring level (display-linear, trimmed mean) at 2, 4 and 7 clip radii. */
  at2: number;
  at4: number;
  at7: number;
  /** Log-log slope of the ring level over windows of 40 px at 720 lines (the same angle at any resolution). */
  slopes: { r0: number; r1: number; s: number }[];
  /** Ring-mean colour where the glare is between 6 and 60 of 255. */
  tints: { r: number; rg: number; bg: number }[];
  /** 8-bit ring medians, 2 px steps at 720 lines: monotonic? (largest rise) */
  worstRise: number;
  log: string;
}

/**
 * The glare as a picture (both critics of round 1): ring statistics on cones about the sun. The ring level is the
 * mean of the display-linear values between the 20th and the 60th percentile of three cones 0.5 px apart: the rays,
 * streaks and ghosts take the top of the distribution, and the mean of a thousand pixels is free of the 8-bit steps
 * that make a median useless for a slope at the level of a few /255.
 */
function glareReport(img: DisplayImage, geo: SunGeo): GlareReport {
  const k = geo.h / 720;
  const samples = (r: number): { x: number; y: number }[] => [-0.5, 0, 0.5].flatMap((d) => coneOf(geo, geo, r + d * k));
  const ring = (r: number): { level: number; median: number; n: number } => {
    const px = samples(r);
    const l = px.map((q) => img.luma(q.x, q.y));
    const v = l.map(toLinear).sort((a, b) => a - b);
    const lo = Math.floor(0.2 * v.length);
    const hi = Math.max(lo + 1, Math.ceil(0.6 * v.length));
    let s = 0;
    for (let i = lo; i < hi; i++) s += v[i]!;
    return { level: s / (hi - lo), median: median(l), n: px.length / 3 };
  };
  let rc = 0;
  for (let r = 2 * k; r < 200 * k; r += k) {
    if (ring(r).median < 250) {
      rc = r;
      break;
    }
  }
  let worstRise = 0;
  let last = Infinity;
  const lines: string[] = [];
  for (let r = rc; r < 0.5 * geo.w; r += 2 * k) {
    const g = ring(r);
    if (g.n < 700 * k) continue;
    worstRise = Math.max(worstRise, g.median - last);
    last = g.median;
  }
  const slopes: { r0: number; r1: number; s: number }[] = [];
  const W = 40 * k;
  for (let r0 = 2 * rc; r0 + W < 0.5 * geo.w; r0 += W) {
    const a = ring(r0);
    const b = ring(r0 + W);
    if (b.level < toLinear(6) || b.n < 700 * k) break;
    slopes.push({ r0, r1: r0 + W, s: -Math.log(b.level / a.level) / Math.log((r0 + W) / r0) });
  }
  const tints: { r: number; rg: number; bg: number }[] = [];
  for (let r = 2 * rc; r < 0.5 * geo.w; r += 24 * k) {
    const g = ring(r);
    if (g.median >= 60 || g.n < 700 * k) continue;
    if (g.median <= 6) break;
    const px = samples(r).map((q) => img.rgb(q.x, q.y)!);
    const c = [0, 1, 2].map((ch) => px.reduce((acc, v) => acc + v[ch]!, 0) / px.length);
    tints.push({ r, rg: c[0]! / c[1]!, bg: c[2]! / c[1]! });
  }
  const at = (m: number): number => ring(m * rc).level;
  lines.push(`clip radius ${rc.toFixed(0)} px; display-linear at 2 / 4 / 7 clip radii ${at(2).toFixed(3)} / ${at(4).toFixed(3)} / ${at(7).toFixed(4)} (photograph bright-sun-eva: 0.40 / 0.074 / 0.018)`);
  lines.push(`log-log slope over ${W.toFixed(0)} px windows: ${slopes.map((s) => `${s.r0.toFixed(0)}-${s.r1.toFixed(0)}: ${s.s.toFixed(2)}`).join('  ')}`);
  lines.push(`tint of the tail: ${tints.map((t) => `${t.r.toFixed(0)}: R/G ${t.rg.toFixed(2)} B/G ${t.bg.toFixed(2)}`).join('  ')}`);
  lines.push(`largest rise of the 8-bit ring median outwards: ${worstRise.toFixed(1)}`);
  return { rc, at2: at(2), at4: at(4), at7: at(7), slopes, tints, worstRise, log: lines.join('\n') };
}

/** The checks of both critics on a glare report: one power law from the clip radius out, tinted like the photographs. */
function expectPhotographicGlare(g: GlareReport): void {
  // Monotonic (one level of dither allowed) and no rim.
  expect(g.worstRise).toBeLessThanOrEqual(1);
  // As steep as the photographs: about 10 % at 4 clip radii, 1-2 % at 7 (the critics: 0.05 or less at 7).
  expect(g.at4).toBeLessThan(0.2);
  expect(g.at7).toBeLessThan(0.05);
  // One power law: the log-log slope between 1.5 and 3 in every window from 2 clip radii to the 6/255 level, and
  // no window more than 1.5 times as steep or as shallow as the one before it (a ball has a hump in this slope).
  expect(g.slopes.length).toBeGreaterThanOrEqual(4);
  for (const s of g.slopes) {
    expect(s.s).toBeGreaterThan(1.5);
    expect(s.s).toBeLessThan(3);
  }
  for (let i = 1; i < g.slopes.length; i++) {
    const q = g.slopes[i]!.s / g.slopes[i - 1]!.s;
    expect(q).toBeLessThan(1.5);
    expect(q).toBeGreaterThan(1 / 1.5);
  }
  // Tinted like the photographs' veiling glare (bright-sun-eva R/G 1.06, B/G 1.19; full-sunburst B/G 1.38), not grey.
  expect(g.tints.length).toBeGreaterThanOrEqual(2);
  for (const t of g.tints) {
    expect(t.bg).toBeGreaterThan(1.04);
    expect(t.bg).toBeLessThan(1.45);
    expect(t.rg).toBeGreaterThan(0.92);
    expect(t.rg).toBeLessThan(1.15);
  }
}

/** Unit vector of the ray of iris blade spikeBlade(j) in the flare's azimuth (from the image-plane up towards right). */
const rayAzimuth = (j: number): number => (j * 2 * Math.PI) / SPIKE_COUNT + BLADES[spikeBlade(j)]!.angle;
const wrap = (a: number): number => Math.atan2(Math.sin(a), Math.cos(a));

/**
 * Largest excess (8-bit) over the ring median at each of `degs` from the sun, with the ghosts' band left out: the
 * ghosts lie on the line through the sun and the image centre and reach up to 13 deg from it.
 */
function excessBeyond(img: DisplayImage, geo: SunGeo, sun: { x: number; y: number }, degs: number[]): { deg: number; excess: number; median: number }[] {
  const ax = geo.w / 2 - sun.x;
  const ay = geo.h / 2 - sun.y;
  const al = Math.hypot(ax, ay) || 1;
  const band = pxOfDeg(geo, 13);
  const out: { deg: number; excess: number; median: number }[] = [];
  for (const deg of degs) {
    const c = coneOf(geo, sun, pxOfDeg(geo, deg)).map((q) => ({ x: q.x, y: q.y, l: img.luma(q.x, q.y) }));
    if (c.length < 60) continue;
    const b = median(c.map((s) => s.l));
    // 2 deg windows (9 samples): the dither and the 8-bit steps leave the maximum.
    const smooth = c.map((s, i) => ({ ...s, l: [-4, -3, -2, -1, 0, 1, 2, 3, 4].reduce((acc, kk) => acc + c[Math.min(c.length - 1, Math.max(0, i + kk))]!.l, 0) / 9 }));
    const away = smooth.filter((s) => Math.abs(((s.x - sun.x) * ay - (s.y - sun.y) * ax) / al) > band);
    if (away.length === 0) continue;
    out.push({ deg, excess: Math.max(...away.map((s) => s.l)) - b, median: b });
  }
  return out;
}

type DisplayImage = ReturnType<typeof displayImage>;

test('display image at the exposure of a sunlit scene: one power-law glare tinted like a real lens, rays of unequal length that end, dim ghosts, the sun outside the frame', async ({ page, pageLog }) => {
  await openPage(page, '/labs/sky/?scene=translunar&planet=0&parts=-stars,-milkyWay,-impostors,-probe&ev=12&hud=0');
  await assertDiscreteGpu(page);
  await waitIdle(page, 4, 300_000);
  await aimNearSun(page, 6, 60);
  const geo = await sunGeo(page);
  const img = displayImage(await shootAt(page, METERED_EV, 'flare-display-check-ev14'));
  expect(img.w).toBe(geo.w);

  // (a) Glare.
  const glare = glareReport(img, geo);
  console.log(`720p, EV ${METERED_EV}, sun 6 deg off axis:\n${glare.log}`);
  expectPhotographicGlare(glare);

  // (b) Rays. At 60 px from the sun the strongest stands well over the glare and is not a hairline.
  const ringL = (r: number): { phi: number; l: number }[] => coneOf(geo, geo, r).map((q) => ({ phi: q.phi, l: img.luma(q.x, q.y) }));
  const at60 = ringL(60);
  const base60 = median(at60.map((s) => s.l));
  const peak60 = at60.reduce((a, b) => (b.l > a.l ? b : a));
  let half = 0;
  for (const s of at60) {
    const d = Math.abs(wrap(s.phi - peak60.phi));
    if (d < 0.2 && s.l - base60 > 0.5 * (peak60.l - base60)) half = Math.max(half, d);
  }
  const widthPx = 2 * half * 60;
  console.log(`strongest ray at 60 px: ${peak60.l.toFixed(0)}/255 over a glare of ${base60.toFixed(0)}/255, ${widthPx.toFixed(1)} px wide at half maximum (solar disc ${((2 * geo.rs) / geo.pxAngle).toFixed(1)} px)`);
  expect(peak60.l - base60).toBeGreaterThan(30);
  expect(widthPx).toBeGreaterThanOrEqual(3);
  // Every ray: its peak over the glare at 4 deg and how far it reaches (more than 4 levels over the ring median
  // within 3 px of its line).
  const peaks: number[] = [];
  const reach: number[] = [];
  const rings: { r: number; ring: { phi: number; l: number }[]; base: number }[] = [];
  for (let r = 24; r < pxOfDeg(geo, 32); r += 4) {
    const c = ringL(r);
    if (c.length < 200) continue;
    rings.push({ r, ring: c, base: median(c.map((s) => s.l)) });
  }
  const r4 = pxOfDeg(geo, 4);
  for (let j = 0; j < SPIKE_COUNT; j++) {
    const a = rayAzimuth(j);
    const over = (q: { r: number; ring: { phi: number; l: number }[]; base: number }): number => {
      const win = Math.max(0.009, 3 / q.r);
      const on = q.ring.filter((s) => Math.abs(wrap(s.phi - a)) < win);
      return on.length ? Math.max(...on.map((s) => s.l)) - q.base : 0;
    };
    peaks.push(over(rings.reduce((b, q) => (Math.abs(q.r - r4) < Math.abs(b.r - r4) ? q : b))));
    let far = 0;
    for (const q of rings) if (over(q) > 4) far = q.r;
    reach.push((Math.atan(far * geo.pxAngle) * 180) / Math.PI);
  }
  const sortedReach = [...reach].sort((a, b) => a - b);
  console.log(`rays: peak over the glare at 4 deg ${peaks.map((v) => v.toFixed(0)).join(' ')}; reach (deg) ${reach.map((v) => v.toFixed(1)).join(' ')}`);
  // Unequal: one pair twice as long as the median ray, one nearly missing (under a third of the strongest at 4 deg).
  expect(sortedReach[SPIKE_COUNT - 1]!).toBeGreaterThan(1.8 * sortedReach[SPIKE_COUNT >> 1]!);
  expect(Math.min(...peaks)).toBeLessThan(Math.max(...peaks) / 3);
  // ... and they end: beyond the longest ray nothing stands more than 3 levels over the glare around it.
  const reachDeg = (RAY_REACH * 180) / Math.PI;
  const beyond = excessBeyond(img, geo, geo, [reachDeg + 1, reachDeg + 4, reachDeg + 8]);
  console.log(`beyond the rays' reach (${reachDeg.toFixed(1)} deg): ${beyond.map((b) => `${b.deg.toFixed(1)} deg +${b.excess.toFixed(1)} over ${b.median.toFixed(0)}`).join('  ')}`);
  expect(beyond.length).toBeGreaterThan(0);
  for (const b of beyond) expect(b.excess).toBeLessThanOrEqual(3);

  // (c) Ghosts: at this exposure none is brighter than a quarter of mid-grey (55/255): the brightest pixel more than
  // 20 deg from the sun within 10 deg of the ghosts' line.
  await aimNearSun(page, 30, 60);
  const g30 = await sunGeo(page);
  const ghosts = displayImage(await shootAt(page, METERED_EV, 'flare-off-axis-30deg-ev14'));
  const tanY = (geo.pxAngle * geo.h) / 2;
  const tanX = (tanY * geo.w) / geo.h;
  const viewDir = (x: number, y: number): [number, number, number] => {
    const d = [((2 * x) / geo.w - 1) * tanX, (1 - (2 * y) / geo.h) * tanY, 1];
    const l = Math.hypot(d[0]!, d[1]!, d[2]!);
    return [d[0]! / l, d[1]! / l, d[2]! / l];
  };
  const sun30 = viewDir(g30.x, g30.y);
  // Normal of the plane through the eye, the sun and the view axis: the ghosts' line.
  const nrm = [sun30[1], -sun30[0], 0];
  const nl = Math.hypot(nrm[0]!, nrm[1]!);
  let ghostMax = 0;
  for (let y = 0; y < ghosts.h; y += 2) {
    for (let x = 0; x < ghosts.w; x += 2) {
      const d = viewDir(x, y);
      const offLine = Math.abs(Math.asin((d[0] * nrm[0]! + d[1] * nrm[1]!) / nl));
      if (offLine < (10 * Math.PI) / 180 && d[0] * sun30[0] + d[1] * sun30[1] + d[2] * sun30[2] < Math.cos((20 * Math.PI) / 180)) ghostMax = Math.max(ghostMax, ghosts.luma(x, y));
    }
  }
  console.log(`sun 30 deg off axis: brightest pixel on the ghosts' line further than 20 deg from the sun ${ghostMax.toFixed(0)}/255`);
  expect(ghostMax).toBeLessThan(55);

  // (d) The sun outside the frame: its rays still reach in from the edge, dimmed by the hood (as a real lens with a
  // hood images them); beyond the longest ray only the halo's haze.
  for (const outside of [0.3, 3]) {
    await aimNearSun(page, (Math.atan(tanX) * 180) / Math.PI + outside, 60);
    const name = outside < 1 ? 'flare-sun-outside-display-check-ev14' : 'flare-sun-3deg-outside-frame-ev14';
    const out = displayImage(await shootAt(page, METERED_EV, name));
    const sunOut = await sunGeo(page);
    const ex = excessBeyond(out, geo, sunOut, [reachDeg + 1, reachDeg + 4, reachDeg + 8, reachDeg + 14]);
    const inReach = excessBeyond(out, geo, sunOut, [6, 10, 16]);
    console.log(
      `sun ${outside} deg outside the frame: rays ${inReach.map((b) => `${b.deg} deg +${b.excess.toFixed(1)}`).join('  ')}; beyond their reach ${ex.map((b) => `${b.deg.toFixed(1)} deg +${b.excess.toFixed(1)} over ${b.median.toFixed(0)}`).join('  ')}`,
    );
    for (const b of ex) expect(b.excess).toBeLessThanOrEqual(3);
  }
  await expectNoErrors(page, pageLog);
});

test.describe('1440p', () => {
  test.use({ viewport: { width: 2560, height: 1440 } });
  test('display image at 1440 lines: the same glare in angle, one power law, tinted', async ({ page, pageLog }) => {
    await openPage(page, '/labs/sky/?scene=translunar&planet=0&parts=-stars,-milkyWay,-impostors,-probe&ev=12&hud=0&scale=1');
    await assertDiscreteGpu(page);
    await waitIdle(page, 4, 300_000);
    await aimNearSun(page, 6, 60);
    const geo = await sunGeo(page);
    expect(geo.h).toBe(1440);
    const img = displayImage(await shootAt(page, METERED_EV, 'flare-display-check-1440p-ev14'));
    const glare = glareReport(img, geo);
    console.log(`1440p, EV ${METERED_EV}, sun 6 deg off axis:\n${glare.log}`);
    expectPhotographicGlare(glare);
    await expectNoErrors(page, pageLog);
  });
});
