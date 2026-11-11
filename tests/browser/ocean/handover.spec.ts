/**
 * The near-field hand-over (ARCHITECTURE 10.2) against the LabPlanet, which implements the terrain side of the
 * rule (sheet discarded inside fadeStart, seabed at the depth the sheet encodes, with the sheet's albedo):
 *  - inside fadeStart 'scene.depthOpaque' holds the seabed, and a submerged object is refracted;
 *  - at fadeStart the forward pixel equals the deferred pixel of the same flat surface within 2 %;
 *  - across the band the image is the cross-fade of two equal images (A/B and a slow dolly show no line);
 *  - beyond fadeEnd nothing is drawn (bit-identical to the deferred-only image);
 *  - a climb from 2 m to 400 km with frozen time shows no ring or pop;
 *  - with the feature removed the far water alone is complete.
 * Images are the pre-TAA HDR target with jitter off, frozen time and a fixed exposure.
 */
import type { Page } from '@playwright/test';
import { assertDiscreteGpu, expect, expectNoErrors, openPage, saveScreenshot, test, waitIdle } from '../harness';

test.describe.configure({ timeout: 900_000 });

const LAB = '/labs/ocean/?preset=midday&governor=off&scale=1';

async function freeze(page: Page, ev = 13.5): Promise<void> {
  await page.evaluate((e) => {
    window.__test!.setPaused(true);
    window.__test!.setDeterministic(true);
    window.__lab!.renderer.setJitter(false);
    window.__lab!.renderer.setExposureOverride(e);
  }, ev);
}

/** Luminance of the HDR target and the eye distance to the sea sphere per pixel, sampled on a grid. */
async function grab(page: Page, step = 4): Promise<{ w: number; h: number; lum: number[]; dist: number[]; xs: number[]; ys: number[] }> {
  return page.evaluate(async (st) => {
    const img = await window.__lab!.renderer.readHdrPixels('hdr');
    const lab = window.__ocean!;
    const lum: number[] = [];
    const dist: number[] = [];
    const xs: number[] = [];
    const ys: number[] = [];
    for (let y = 0; y < img.height; y += st) {
      for (let x = 0; x < img.width; x += st) {
        const o = (y * img.width + x) * 4;
        lum.push(0.2126 * img.data[o]! + 0.7152 * img.data[o + 1]! + 0.0722 * img.data[o + 2]!);
        dist.push(lab.seaHit(x, y)?.dist ?? -1);
        xs.push(x);
        ys.push(y);
      }
    }
    return { w: img.width, h: img.height, lum, dist, xs, ys };
  }, step);
}

test('inside fadeStart the depth copy holds the seabed; a submerged object is refracted', async ({ page, pageLog }) => {
  await openPage(page, LAB);
  await assertDiscreteGpu(page);
  await freeze(page);
  await waitIdle(page, 8);
  const seabed = async (): Promise<number[]> =>
    page.evaluate(async () => {
      const lab = window.__ocean!;
      const fc = lab.app.renderer.frameContext!;
      const [w, h] = fc.renderSize;
      const px: [number, number][] = [];
      for (let i = 0; i < 24; i++) px.push([Math.round(((i % 6) + 0.5) * (w / 6)), Math.round(h * (0.75 + 0.05 * Math.floor(i / 6)))]);
      const d = await lab.ocean!.debug.readOpaqueDepth(px);
      const fwd = { x: -fc.view[2]!, y: -fc.view[6]!, z: -fc.view[10]! };
      return px.map(([x, y], i) => {
        const ray = lab.seaHit(x, y)!.ray;
        const t = 0.05 / d[i]! / (ray.x * fwd.x + ray.y * fwd.y + ray.z * fwd.z);
        return lab.altitudeAlong(x, y, t);
      });
    });
  const withNear = await seabed();
  await page.evaluate(() => window.__ocean!.ocean!.debug.forceNearFieldOff(true));
  await page.evaluate(() => window.__test!.waitFrames(4));
  const without = await seabed();
  await page.evaluate(() => window.__ocean!.ocean!.debug.forceNearFieldOff(false));
  console.log('opaque depth altitude, near field on:', withNear.map((a) => a.toFixed(2)).join(' '));
  console.log('opaque depth altitude, near field off:', without.map((a) => a.toFixed(3)).join(' '));
  // Open-ocean map: the sheet encodes 200 m, so the seabed lies 200 m down; without the near field the sheet is at 0.
  for (const a of withNear) expect(a).toBeLessThan(-150);
  for (const a of without) expect(Math.abs(a)).toBeLessThan(0.05);

  // Refraction of a submerged object (shallow shelf): the image around it changes with the refraction offset.
  await page.evaluate(() => {
    window.__ocean!.applyPreset('refraction');
    window.__lab!.renderer.setExposureOverride(13.5);
  });
  await waitIdle(page, 30);
  const window_ = await page.evaluate(async () => {
    const lab = window.__ocean!;
    const at = lab.props.submergedAt;
    const def = lab.app.defs.bodies[lab.site.bodyId]!;
    const p = lab.project(((d) => ({ x: d.x * (def.radius - at.depth), y: d.y * (def.radius - at.depth), z: d.z * (def.radius - at.depth) }))(lab.dirAt(at.east, at.north)))!;
    return { x: Math.round(p.x), y: Math.round(p.y) };
  });
  const crop = async (): Promise<number[]> =>
    page.evaluate(async (c) => {
      const img = await window.__lab!.renderer.readHdrPixels('hdr');
      const out: number[] = [];
      for (let y = c.y - 40; y <= c.y + 40; y += 2) for (let x = c.x - 60; x <= c.x + 60; x += 2) out.push(img.data[(y * img.width + x) * 4 + 1]!);
      return out;
    }, window_);
  const refracted = await crop();
  await saveScreenshot(page, 'ocean', 'handover-refraction');
  await page.evaluate(() => window.__ocean!.ocean!.debug.setRefractionScale(0));
  await page.evaluate(() => window.__test!.waitFrames(4));
  const straight = await crop();
  await page.evaluate(() => window.__ocean!.ocean!.debug.setRefractionScale(1));
  const mean = refracted.reduce((s, v) => s + v, 0) / refracted.length;
  const diff = refracted.reduce((s, v, i) => s + Math.abs(v - straight[i]!), 0) / refracted.length;
  console.log(`refraction: object at px ${JSON.stringify(window_)}, mean ${mean.toFixed(4)}, mean |refracted - unrefracted| ${diff.toFixed(4)}`);
  expect(diff / mean).toBeGreaterThan(0.03);
  await expectNoErrors(page, pageLog);
});

test('at fadeStart the forward pixel equals the deferred pixel; across the band two equal images; nothing beyond fadeEnd', async ({ page, pageLog }) => {
  await openPage(page, LAB);
  await assertDiscreteGpu(page);
  // 6 km up looking down at 22 deg: eye distances from about 9 to 60 km on screen.
  await page.evaluate(() => window.__ocean!.setCamera({ alt: 6000, heading: 20, pitch: -22 }));
  await freeze(page, 14);
  await waitIdle(page, 12);
  const A = await grab(page);
  await saveScreenshot(page, 'ocean', 'handover-near-on');
  await page.evaluate(() => window.__ocean!.ocean!.debug.forceNearFieldOff(true));
  await waitIdle(page, 6);
  const B = await grab(page);
  await saveScreenshot(page, 'ocean', 'handover-near-off');
  await page.evaluate(() => window.__ocean!.ocean!.debug.forceNearFieldOff(false));
  const nf = await page.evaluate(() => window.__ocean!.ocean!.debug.nearField());
  const band = (lo: number, hi: number): { n: number; worst: number; mean: number } => {
    let n = 0;
    let worst = 0;
    let sum = 0;
    A.dist.forEach((d, i) => {
      if (d < lo || d > hi) return;
      const r = Math.abs(A.lum[i]! - B.lum[i]!) / Math.max(B.lum[i]!, 1e-9);
      n++;
      sum += r;
      worst = Math.max(worst, r);
    });
    return { n, worst, mean: n ? sum / n : 0 };
  };
  const atStart = band(nf.fadeStart - 300, nf.fadeStart - 5);
  const across = band(nf.fadeStart, nf.fadeEnd);
  const beyond = band(nf.fadeEnd + 50, 1e9);
  let identical = 0;
  let beyondCount = 0;
  A.dist.forEach((d, i) => {
    if (d > nf.fadeEnd + 50) {
      beyondCount++;
      if (A.lum[i] === B.lum[i]) identical++;
    }
  });
  console.log(`fadeStart ${nf.fadeStart} / fadeEnd ${nf.fadeEnd}; just inside fadeStart: ${JSON.stringify(atStart)}; band: ${JSON.stringify(across)}; beyond: ${JSON.stringify(beyond)}, identical ${identical}/${beyondCount}`);
  expect(atStart.n).toBeGreaterThan(50);
  expect(atStart.worst).toBeLessThan(0.02);
  expect(across.n).toBeGreaterThan(200);
  expect(across.worst).toBeLessThan(0.02);
  expect(beyondCount).toBeGreaterThan(200);
  expect(identical).toBe(beyondCount);

  // Slow dolly with frozen time: frame differences must not peak at the fade radii (no line).
  const ringStats: { start: number; end: number; elsewhere: number }[] = [];
  let prev = A;
  for (let k = 1; k <= 6; k++) {
    await page.evaluate((s) => window.__ocean!.setCamera({ alt: 6000, north: s * 40, heading: 20, pitch: -22 }), k);
    await page.evaluate(() => window.__test!.waitFrames(3));
    const cur = await grab(page);
    const acc = { start: [0, 0], end: [0, 0], elsewhere: [0, 0] };
    cur.dist.forEach((d, i) => {
      if (d < 0) return;
      const v = Math.abs(cur.lum[i]! - prev.lum[i]!) / Math.max(cur.lum[i]!, 1e-9);
      const key = Math.abs(d - nf.fadeStart) < 400 ? 'start' : Math.abs(d - nf.fadeEnd) < 400 ? 'end' : d > nf.fadeStart - 4000 && d < nf.fadeEnd + 4000 ? 'elsewhere' : null;
      if (!key) return;
      acc[key][0]! += v;
      acc[key][1]!++;
    });
    ringStats.push({ start: acc.start[0]! / acc.start[1]!, end: acc.end[0]! / acc.end[1]!, elsewhere: acc.elsewhere[0]! / acc.elsewhere[1]! });
    prev = cur;
  }
  console.log('dolly frame differences (relative, mean):', JSON.stringify(ringStats));
  for (const r of ringStats) {
    expect(r.start).toBeLessThan(Math.max(1.5 * r.elsewhere, 0.004));
    expect(r.end).toBeLessThan(Math.max(1.5 * r.elsewhere, 0.004));
  }
  await expectNoErrors(page, pageLog);
});

test('a climb from 2 m to 400 km above open ocean shows no ring or pop (frozen time)', async ({ page, pageLog }) => {
  await openPage(page, LAB);
  await assertDiscreteGpu(page);
  await freeze(page, 14);
  await waitIdle(page, 8);
  const steps = 150;
  const diffs: { alt: number; mean: number; ringStart: number; ringEnd: number; around: number }[] = [];
  let prev: number[] | null = null;
  for (let k = 0; k < steps; k++) {
    const alt = 2 * Math.pow(400000 / 2, k / (steps - 1));
    await page.evaluate((a) => window.__ocean!.setCamera({ alt: a, heading: 20, pitch: -25 }), alt);
    await page.evaluate(() => window.__test!.waitFrames(2));
    const cur = await page.evaluate(async () => {
      const img = await window.__lab!.renderer.readHdrPixels('hdr');
      const lum: number[] = [];
      const dist: number[] = [];
      for (let y = 4; y < img.height; y += 8)
        for (let x = 4; x < img.width; x += 8) {
          const o = (y * img.width + x) * 4;
          lum.push(0.2126 * img.data[o]! + 0.7152 * img.data[o + 1]! + 0.0722 * img.data[o + 2]!);
          dist.push(window.__ocean!.seaHit(x, y)?.dist ?? -1);
        }
      return { lum, dist };
    });
    if (prev) {
      let s = 0;
      const acc = { ringStart: [0, 0], ringEnd: [0, 0], around: [0, 0] };
      for (let i = 0; i < cur.lum.length; i++) {
        const v = Math.abs(cur.lum[i]! - prev[i]!) / Math.max(prev[i]!, 1e-6);
        s += v;
        const d = cur.dist[i]!;
        if (d < 0) continue;
        const key = Math.abs(d / 15000 - 1) < 0.04 ? 'ringStart' : Math.abs(d / 30000 - 1) < 0.04 ? 'ringEnd' : d > 11000 && d < 37500 ? 'around' : null;
        if (key) {
          acc[key][0]! += v;
          acc[key][1]!++;
        }
      }
      const m = (a: number[]): number => (a[1]! > 20 ? a[0]! / a[1]! : 0);
      diffs.push({ alt, mean: s / cur.lum.length, ringStart: m(acc.ringStart), ringEnd: m(acc.ringEnd), around: m(acc.around) });
    }
    prev = cur.lum;
    if (k === 60 || k === 95 || k === 110) await saveScreenshot(page, 'ocean', `climb-${Math.round(alt)}m`);
  }
  // A pop is a step that stands out from the smooth trend of its neighbours.
  const spikes = diffs
    .map((d, i) => {
      const nb = diffs.slice(Math.max(0, i - 4), i).concat(diffs.slice(i + 1, i + 5)).map((x) => x.mean).sort((a, b) => a - b);
      const med = nb[Math.floor(nb.length / 2)] ?? d.mean;
      return { alt: d.alt, mean: d.mean, ratio: d.mean / Math.max(med, 1e-4) };
    })
    .sort((a, b) => b.ratio - a.ratio);
  // A ring is a step whose change concentrates at the fade radii.
  const rings = diffs.filter((d) => d.around > 0 && (d.ringStart > 0 || d.ringEnd > 0)).map((d) => ({ alt: d.alt, start: d.ringStart / d.around, end: d.ringEnd / d.around }));
  const worstRing = rings.reduce((w, r) => Math.max(w, r.start, r.end), 0);
  console.log('largest step ratios:', JSON.stringify(spikes.slice(0, 5)));
  console.log(`steps with the fade radii on screen: ${rings.length}; worst ring ratio ${worstRing.toFixed(3)}`);
  expect(spikes[0]!.ratio).toBeLessThan(2.5);
  expect(rings.length).toBeGreaterThan(20);
  expect(worstRing).toBeLessThan(1.6);
  await expectNoErrors(page, pageLog);
});

test('with the ocean feature removed the far water alone is complete', async ({ page, pageLog }) => {
  await openPage(page, '/labs/ocean/?preset=midday&ocean=0&governor=off&scale=1');
  await assertDiscreteGpu(page);
  await freeze(page);
  await waitIdle(page, 8);
  const r = await page.evaluate(async () => {
    const lab = window.__ocean!;
    const depth = await lab.app.renderer.readDepth();
    const img = await lab.app.renderer.readHdrPixels('hdr');
    let water = 0;
    let holes = 0;
    for (let y = 2; y < depth.height; y += 6) {
      for (let x = 2; x < depth.width; x += 6) {
        if (!lab.seaHit(x, y)) continue;
        water++;
        const o = (y * img.width + x) * 4;
        if (depth.data[y * depth.width + x]! <= 0 || img.data[o + 2]! <= 0) holes++;
      }
    }
    return { water, holes, oceanFeature: lab.ocean !== null };
  });
  await saveScreenshot(page, 'ocean', 'far-water-alone');
  console.log('far water alone:', JSON.stringify(r));
  expect(r.oceanFeature).toBe(false);
  expect(r.water).toBeGreaterThan(1000);
  expect(r.holes).toBe(0);
  await expectNoErrors(page, pageLog);
});
