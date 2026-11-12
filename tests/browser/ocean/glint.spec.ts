/**
 * Sun glint from one function (brdf_water):
 *  - from LEO (far water, deferred) the specular highlight is a broad patch at the mirror point whose angular
 *    width matches the Cox-Munk slope variance for the wind speed within 20 % (the variance of the water the glint
 *    lies on: the wind speed's value x the mean of the sea's roughness field over the glint);
 *  - at 2 m (near field, forward) it is a glitter path of sparkles toward the sun;
 *  - with the sun on the horizon no pixel exceeds HDR_MAX and none is NaN.
 * The glint is isolated exactly: image with the direct specular minus the same frame without it.
 */
import type { Page } from '@playwright/test';
import { assertDiscreteGpu, expect, expectNoErrors, openPage, saveScreenshot, test, waitIdle } from '../harness';

test.describe.configure({ timeout: 600_000 });

interface GlintPx {
  x: number;
  y: number;
  g: number;
  tanBeta: number;
  /** Facet slope that mirrors the sun into the pixel, along local east and north (tan, signed). */
  se: number;
  sn: number;
}

/** Per-pixel glint (luminance with specular minus without) and the facet slope that mirrors the sun into the pixel. */
async function glintImage(page: Page, step: number): Promise<{ px: GlintPx[]; w: number; h: number }> {
  const lum = async (): Promise<{ w: number; h: number; l: Float32Array }> => {
    const r = await page.evaluate(async () => {
      const img = await window.__lab!.renderer.readHdrPixels('hdr');
      const l: number[] = [];
      for (let i = 0; i < img.width * img.height; i++) l.push(0.2126 * img.data[i * 4]! + 0.7152 * img.data[i * 4 + 1]! + 0.0722 * img.data[i * 4 + 2]!);
      return { w: img.width, h: img.height, l };
    });
    return { w: r.w, h: r.h, l: Float32Array.from(r.l) };
  };
  const a = await lum();
  await page.evaluate(() => window.__ocean!.ocean!.debug.setDirectSpecular(false));
  await waitIdle(page, 6);
  const b = await lum();
  await page.evaluate(() => window.__ocean!.ocean!.debug.setDirectSpecular(true));
  await waitIdle(page, 6);
  const geo = await page.evaluate((st) => {
    const lab = window.__ocean!;
    const fc = lab.app.renderer.frameContext!;
    const [w, h] = fc.renderSize;
    const sun = fc.sun.dirRoot;
    const snap = lab.app.snapshot();
    const body = snap.bodies.find((x) => x.id === lab.site.bodyId)!;
    const qz = body.qFixedToRoot;
    // Rotate a body-fixed vector to ROOT axes (q v q*).
    const rot = (v: { x: number; y: number; z: number }): { x: number; y: number; z: number } => {
      const tx = 2 * (qz.y * v.z - qz.z * v.y);
      const ty = 2 * (qz.z * v.x - qz.x * v.z);
      const tz = 2 * (qz.x * v.y - qz.y * v.x);
      return { x: v.x + qz.w * tx + (qz.y * tz - qz.z * ty), y: v.y + qz.w * ty + (qz.z * tx - qz.x * tz), z: v.z + qz.w * tz + (qz.x * ty - qz.y * tx) };
    };
    const dot = (a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }): number => a.x * b.x + a.y * b.y + a.z * b.z;
    const out: { x: number; y: number; tanBeta: number; se: number; sn: number }[] = [];
    for (let y = 0; y < h; y += st) {
      for (let x = 0; x < w; x += st) {
        const hit = lab.seaHit(x, y);
        if (!hit) continue;
        const v = hit.dirFixed;
        const n = rot(v);
        // Local east = z x up, north = up x east (body-fixed), in ROOT axes.
        const el = Math.hypot(v.x, v.y);
        const e = rot({ x: -v.y / el, y: v.x / el, z: 0 });
        const nn = { x: n.y * e.z - n.z * e.y, y: n.z * e.x - n.x * e.z, z: n.x * e.y - n.y * e.x };
        const view = { x: -hit.ray.x, y: -hit.ray.y, z: -hit.ray.z };
        const hv = { x: view.x + sun.x, y: view.y + sun.y, z: view.z + sun.z };
        const hl = Math.hypot(hv.x, hv.y, hv.z);
        const c = dot(hv, n) / hl;
        // The facet whose normal is the half vector: its slope is -(h . e) / (h . n) along east (height rises against the tilt).
        out.push({ x, y, tanBeta: Math.sqrt(Math.max(0, 1 - c * c)) / c, se: -dot(hv, e) / dot(hv, n), sn: -dot(hv, nn) / dot(hv, n) });
      }
    }
    return { w, h, out };
  }, step);
  const px = geo.out.map((p) => ({ ...p, g: a.l[p.y * a.w + p.x]! - b.l[p.y * b.w + p.x]! }));
  return { px, w: geo.w, h: geo.h };
}

/** Peak (-b / 2c) of the least-squares fit g = a + b_e s_e + b_n s_n + c (s_e^2 + s_n^2). */
function paraboloidPeak(ps: GlintPx[]): [number, number] {
  const m = Array.from({ length: 4 }, () => new Array<number>(5).fill(0));
  for (const p of ps) {
    const row = [1, p.se, p.sn, p.se * p.se + p.sn * p.sn];
    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 4; j++) m[i]![j]! += row[i]! * row[j]!;
      m[i]![4]! += row[i]! * p.g;
    }
  }
  // Gaussian elimination with partial pivoting.
  for (let c = 0; c < 4; c++) {
    let piv = c;
    for (let r = c + 1; r < 4; r++) if (Math.abs(m[r]![c]!) > Math.abs(m[piv]![c]!)) piv = r;
    [m[c], m[piv]] = [m[piv]!, m[c]!];
    for (let r = 0; r < 4; r++) {
      if (r === c) continue;
      const f = m[r]![c]! / m[c]![c]!;
      for (let k = c; k < 5; k++) m[r]![k]! -= f * m[c]![k]!;
    }
  }
  const x = m.map((r, i) => r[4]! / r[i]!);
  return [-x[1]! / (2 * x[3]!), -x[2]! / (2 * x[3]!)];
}

test('from LEO the glint is a broad patch at the mirror point with the Cox-Munk width (within 20 %)', async ({ page, pageLog }) => {
  await openPage(page, '/labs/ocean/?preset=leo&governor=off&scale=1');
  await assertDiscreteGpu(page);
  await page.evaluate(() => {
    window.__test!.setPaused(true);
    window.__test!.setDeterministic(true);
    window.__lab!.renderer.setJitter(false);
    // The glint is the difference of two frames (with and without the direct specular): one exposure for both.
    window.__lab!.renderer.setExposureOverride(14);
    // Seen from nearly overhead under a high sun (the preset itself is the oblique view of orbital photographs): the
    // whole lobe lies inside the frame, every sector of every ring of facet slopes.
    window.__ocean!.setSun([0, 58]);
    window.__ocean!.setCamera({ alt: 400000, heading: 0, pitch: -55, fov: 60 });
  });
  await waitIdle(page, 12);
  await saveScreenshot(page, 'ocean', 'glint-leo');
  const { px } = await glintImage(page, 3);
  const st = await page.evaluate(() => window.__ocean!.ocean!.debug.state());
  // The slope variance of the water the glint lies on: Cox-Munk for the wind speed x the roughness field there
  // (calmer and rougher regions of the sea, mean 1 over the planet; averaged over the glint's own area, as the
  // footprint of a pixel from this height sees it).
  const local = await page.evaluate(() => {
    const lab = window.__ocean!;
    const fc = lab.app.renderer.frameContext!;
    const [w, h] = fc.renderSize;
    const sun = fc.sun.dirRoot;
    const body = lab.app.snapshot().bodies.find((x) => x.id === lab.site.bodyId)!;
    const q = body.qFixedToRoot;
    const rot = (v: { x: number; y: number; z: number }): { x: number; y: number; z: number } => {
      const tx = 2 * (q.y * v.z - q.z * v.y);
      const ty = 2 * (q.z * v.x - q.x * v.z);
      const tz = 2 * (q.x * v.y - q.y * v.x);
      return { x: v.x + q.w * tx + (q.y * tz - q.z * ty), y: v.y + q.w * ty + (q.z * tx - q.x * tz), z: v.z + q.w * tz + (q.x * ty - q.y * tx) };
    };
    const pixelAngle = (2 * Math.tan(lab.app.cameraState().fovY / 2)) / h;
    let sum = 0;
    let n = 0;
    for (let y = 0; y < h; y += 6) {
      for (let x = 0; x < w; x += 6) {
        const hit = lab.seaHit(x, y);
        if (!hit) continue;
        const up = rot(hit.dirFixed);
        const hv = { x: sun.x - hit.ray.x, y: sun.y - hit.ray.y, z: sun.z - hit.ray.z };
        const c = (hv.x * up.x + hv.y * up.y + hv.z * up.z) / Math.hypot(hv.x, hv.y, hv.z);
        // Inside the half-maximum radius of the Cox-Munk lobe (tan beta below 0.16).
        if (Math.sqrt(Math.max(0, 1 - c * c)) / c > 0.16) continue;
        sum += lab.roughness(hit.dirFixed, hit.dist * pixelAngle);
        n++;
      }
    }
    return { mean: sum / n, n };
  });
  const sigma = Math.sqrt(st.coxMunk * local.mean);
  const expectedHalf = sigma * Math.sqrt(Math.LN2);
  console.log(`roughness field over the glint: mean ${local.mean.toFixed(3)} (${local.n} samples)`);
  // Radial profile of the glint in facet-slope space.
  const bins = new Map<number, { s: number; n: number }>();
  const bw = 0.01;
  for (const p of px) {
    const k = Math.floor(p.tanBeta / bw);
    const e = bins.get(k) ?? { s: 0, n: 0 };
    e.s += p.g;
    e.n++;
    bins.set(k, e);
  }
  const prof = [...bins.entries()].sort((a, b) => a[0] - b[0]).map(([k, e]) => ({ t: (k + 0.5) * bw, g: e.s / e.n, n: e.n }));
  const peak = px.reduce((m, p) => (p.g > m.g ? p : m), px[0]!);
  // The top of the lobe: the mean glint within tan(beta) 0.04, a quarter of the half-maximum radius (the Gaussian
  // lobe is within 4 % of its peak there), so that one slick or one rough patch lying on the mirror point itself
  // does not set the level the half maximum is measured against.
  const top = px.filter((p) => p.tanBeta < 0.04);
  const g0 = top.reduce((s, p) => s + p.g, 0) / top.length;
  let half = NaN;
  for (let i = 1; i < prof.length; i++) {
    if (prof[i]!.g <= g0 / 2) {
      const a = prof[i - 1]!;
      const b = prof[i]!;
      half = a.t + ((a.g - g0 / 2) / (a.g - b.g)) * (b.t - a.t);
      break;
    }
  }
  console.log(`LEO glint: brightest pixel at tan(beta) ${peak.tanBeta.toFixed(4)} (px ${peak.x},${peak.y}); half maximum at tan(beta) ${half.toFixed(4)}, Cox-Munk ${expectedHalf.toFixed(4)} (sigma^2 ${st.coxMunk.toFixed(4)} x ${local.mean.toFixed(3)}); ratio ${(half / expectedHalf).toFixed(3)}`);
  console.log('profile:', prof.slice(0, 40).map((p) => `${p.t.toFixed(3)}:${p.g.toExponential(2)}`).join(' '));
  // At the mirror point, in facet-slope space (east, north), over discs the image covers completely (every sector
  // of every ring sampled, so the disc itself is centred):
  //  - the glint's centroid lies at zero slope (an offset glint pulls it by about offset x <s^2> / sigma^2);
  //  - the peak of the least-squares paraboloid g = a + b.s + c |s|^2 fitted to the glint, -b / 2c, is the
  //    location itself (unbiased, unlike the centroid, which the disc's own symmetry pulls towards zero).
  for (const R of [0.08, 0.12, 0.16]) {
    const inDisc = px.filter((p) => Math.hypot(p.se, p.sn) < R);
    const cells = new Set(inDisc.map((p) => `${Math.floor((Math.hypot(p.se, p.sn) / R) * 4)}:${Math.floor(((Math.atan2(p.sn, p.se) + Math.PI) / (2 * Math.PI)) * 16)}`));
    const sum = inDisc.reduce((s, p) => s + p.g, 0);
    const ce = inDisc.reduce((s, p) => s + p.g * p.se, 0) / sum;
    const cn = inDisc.reduce((s, p) => s + p.g * p.sn, 0) / sum;
    const peakAt = paraboloidPeak(inDisc);
    console.log(
      `slope-space glint over |s| < ${R}: centroid (${ce.toFixed(4)}, ${cn.toFixed(4)}) |c| ${Math.hypot(ce, cn).toFixed(4)}; fitted peak (${peakAt[0].toFixed(4)}, ${peakAt[1].toFixed(4)}) |p| ${Math.hypot(...peakAt).toFixed(4)}; ${inDisc.length} samples, ${cells.size}/64 cells`,
    );
    expect(cells.size).toBe(64);
    expect(Math.hypot(ce, cn)).toBeLessThan(0.02);
    if (R >= 0.12) expect(Math.hypot(...peakAt)).toBeLessThan(0.03);
  }
  expect(half / expectedHalf).toBeGreaterThan(0.8);
  expect(half / expectedHalf).toBeLessThan(1.2);
  // Broad: a sizeable part of the image glints (not a handful of sparkles).
  const lit = px.filter((p) => p.g > 0.25 * peak.g).length / px.length;
  expect(lit).toBeGreaterThan(0.02);
  await expectNoErrors(page, pageLog);
});

test('at 2 m the glint is a glitter path of sparkles toward the sun; HDR_MAX and NaN with the sun on the horizon', async ({ page, pageLog }) => {
  await openPage(page, '/labs/ocean/?preset=sunset&governor=off&scale=1');
  await assertDiscreteGpu(page);
  await page.evaluate(() => {
    window.__test!.setPaused(true);
    window.__test!.setDeterministic(true);
    window.__lab!.renderer.setJitter(false);
    window.__lab!.renderer.setExposureOverride(13);
    window.__ocean!.setSun([268, 6]);
  });
  await waitIdle(page, 12);
  const { px, w } = await glintImage(page, 2);
  const sunX = await page.evaluate(() => {
    const lab = window.__ocean!;
    const fc = lab.app.renderer.frameContext!;
    const s = fc.sun.dirRoot;
    const cam = lab.app.cameraState();
    const q = cam.qViewToRoot;
    // View-space sun direction: rotate by the inverse of qViewToRoot.
    const qi = { x: -q.x, y: -q.y, z: -q.z, w: q.w };
    const tx = 2 * (qi.y * s.z - qi.z * s.y);
    const ty = 2 * (qi.z * s.x - qi.x * s.z);
    const tz = 2 * (qi.x * s.y - qi.y * s.x);
    const v = { x: s.x + qi.w * tx + (qi.y * tz - qi.z * ty), z: s.z + qi.w * tz + (qi.x * ty - qi.y * tx) };
    const tanX = Math.tan(cam.fovY / 2) * (fc.renderSize[0] / fc.renderSize[1]);
    return ((v.x / -v.z / tanX + 1) / 2) * fc.renderSize[0];
  });
  const water = px.filter((p) => p.g > 0);
  const total = water.reduce((s, p) => s + p.g, 0);
  const cx = water.reduce((s, p) => s + p.g * p.x, 0) / total;
  // Sparkle: within the path the glint is a few bright glints among dark troughs (high contrast), not a smooth sheen.
  const path = water.filter((p) => Math.abs(p.x - sunX) < 0.06 * w);
  const mean = path.reduce((s, p) => s + p.g, 0) / path.length;
  const sd = Math.sqrt(path.reduce((s, p) => s + (p.g - mean) ** 2, 0) / path.length);
  const offPath = water.filter((p) => Math.abs(p.x - sunX) > 0.3 * w).reduce((s, p) => s + p.g, 0) / total;
  console.log(`glitter path: sun at x ${sunX.toFixed(1)}, glint centroid x ${cx.toFixed(1)}, coefficient of variation in the path ${(sd / mean).toFixed(2)}, energy off the path ${(offPath * 100).toFixed(2)} %`);
  expect(Math.abs(cx - sunX)).toBeLessThan(0.04 * w);
  expect(sd / mean).toBeGreaterThan(1.0);
  expect(offPath).toBeLessThan(0.1);
  await saveScreenshot(page, 'ocean', 'glint-surface');

  // The sun on the horizon (and just above / below), at a dark-adapted exposure where the glint saturates.
  for (const el of [0.4, 0, -0.3]) {
    for (const ev of [13, 4]) {
      await page.evaluate(
        ([e, v]) => {
          window.__ocean!.setSun([268, e]);
          window.__lab!.renderer.setExposureOverride(v);
        },
        [el, ev] as const,
      );
      await page.evaluate(() => window.__test!.waitFrames(4));
      const s = await page.evaluate(() => window.__test!.hdrStats());
      console.log(`sun elevation ${el} deg, EV ${ev}: max ${s.maxLuminance.toFixed(1)}, NaN ${s.nanPixels}`);
      expect(s.nanPixels).toBe(0);
      expect(s.maxLuminance).toBeLessThanOrEqual(60000);
    }
  }
  await expectNoErrors(page, pageLog);
});
