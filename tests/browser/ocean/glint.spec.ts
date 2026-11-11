/**
 * Sun glint from one function (brdf_water):
 *  - from LEO (far water, deferred) the specular highlight is a broad patch at the mirror point whose angular
 *    width matches the Cox-Munk slope variance for the wind speed within 20 %;
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
    const out: { x: number; y: number; tanBeta: number }[] = [];
    for (let y = 0; y < h; y += st) {
      for (let x = 0; x < w; x += st) {
        const hit = lab.seaHit(x, y);
        if (!hit) continue;
        const qz = body.qFixedToRoot;
        // Rotate the body-fixed normal to ROOT axes (q v q*).
        const v = hit.dirFixed;
        const tx = 2 * (qz.y * v.z - qz.z * v.y);
        const ty = 2 * (qz.z * v.x - qz.x * v.z);
        const tz = 2 * (qz.x * v.y - qz.y * v.x);
        const n = { x: v.x + qz.w * tx + (qz.y * tz - qz.z * ty), y: v.y + qz.w * ty + (qz.z * tx - qz.x * tz), z: v.z + qz.w * tz + (qz.x * ty - qz.y * tx) };
        const view = { x: -hit.ray.x, y: -hit.ray.y, z: -hit.ray.z };
        const hx = view.x + sun.x;
        const hy = view.y + sun.y;
        const hz = view.z + sun.z;
        const hl = Math.hypot(hx, hy, hz);
        const c = (hx * n.x + hy * n.y + hz * n.z) / hl;
        out.push({ x, y, tanBeta: Math.sqrt(Math.max(0, 1 - c * c)) / c });
      }
    }
    return { w, h, out };
  }, step);
  const px = geo.out.map((p) => ({ ...p, g: a.l[p.y * a.w + p.x]! - b.l[p.y * b.w + p.x]! }));
  return { px, w: geo.w, h: geo.h };
}

test('from LEO the glint is a broad patch at the mirror point with the Cox-Munk width (within 20 %)', async ({ page, pageLog }) => {
  await openPage(page, '/labs/ocean/?preset=leo&governor=off&scale=1');
  await assertDiscreteGpu(page);
  await page.evaluate(() => {
    window.__test!.setPaused(true);
    window.__test!.setDeterministic(true);
    window.__lab!.renderer.setJitter(false);
  });
  await waitIdle(page, 12);
  await saveScreenshot(page, 'ocean', 'glint-leo');
  const { px } = await glintImage(page, 3);
  const st = await page.evaluate(() => window.__ocean!.ocean!.debug.state());
  const sigma = Math.sqrt(st.coxMunk);
  const expectedHalf = sigma * Math.sqrt(Math.LN2);
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
  const g0 = prof[0]!.g;
  let half = NaN;
  for (let i = 1; i < prof.length; i++) {
    if (prof[i]!.g <= g0 / 2) {
      const a = prof[i - 1]!;
      const b = prof[i]!;
      half = a.t + ((a.g - g0 / 2) / (a.g - b.g)) * (b.t - a.t);
      break;
    }
  }
  console.log(`LEO glint: peak at tan(beta) ${peak.tanBeta.toFixed(4)} (px ${peak.x},${peak.y}); half maximum at tan(beta) ${half.toFixed(4)}, Cox-Munk ${expectedHalf.toFixed(4)} (sigma^2 ${st.coxMunk.toFixed(4)}); ratio ${(half / expectedHalf).toFixed(3)}`);
  console.log('profile:', prof.slice(0, 40).map((p) => `${p.t.toFixed(3)}:${p.g.toExponential(2)}`).join(' '));
  // At the mirror point, and with the Cox-Munk width.
  expect(peak.tanBeta).toBeLessThan(0.03);
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
