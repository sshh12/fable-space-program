import type { Page } from '@playwright/test';
import { assertDiscreteGpu, expect, expectNoErrors, openPage, saveScreenshot, test, waitIdle } from '../harness';

/**
 * Render `frames` frames by hand (fixed 1/60 s steps) and return, per frame, the mean absolute difference
 * to the previous frame over a centred crop of the resolved image, in 8-bit display units (0..255 scale,
 * after a c / (1 + c) curve), plus which cascades were re-rendered.
 */
async function diffSeries(page: Page, frames: number, crop = { w: 640, h: 360 }): Promise<{ diffs: number[]; rendered: number[] }> {
  return page.evaluate(
    async ({ frames: n, crop: c }) => {
      const lab = window.__lab!;
      lab.setLoop(false);
      const diffs: number[] = [];
      const rendered: number[] = [];
      let prev: Float32Array | null = null;
      for (let i = 0; i < n; i++) {
        lab.renderFrame(1 / 60);
        const [w, h] = lab.renderer.frameContext!.displaySize;
        const rect = { x: Math.max(0, (w - c.w) >> 1), y: Math.max(0, (h - c.h) >> 1), width: Math.min(w, c.w), height: Math.min(h, c.h) };
        const px = (await lab.renderer.readHdrPixels('resolved', rect)).data;
        const cur = new Float32Array(px.length);
        for (let k = 0; k < px.length; k++) cur[k] = (255 * px[k]!) / (1 + px[k]!);
        if (prev) {
          let sum = 0;
          for (let k = 0; k < cur.length; k += 4) sum += Math.abs(cur[k]! - prev[k]!) + Math.abs(cur[k + 1]! - prev[k + 1]!) + Math.abs(cur[k + 2]! - prev[k + 2]!);
          diffs.push(sum / ((cur.length / 4) * 3));
        }
        prev = cur;
        rendered.push(window.__test!.perf()!.counters.shadowCascadesRendered ?? 0);
      }
      lab.setLoop(true);
      return { diffs, rendered };
    },
    { frames, crop },
  );
}

/** Relative strength of a period-k component in a series (0 = none, 1 = everything happens every k-th frame). */
function periodStrength(d: number[], k: number): number {
  const n = Math.floor(d.length / k) * k;
  let re = 0;
  let im = 0;
  let sum = 0;
  const mean = d.slice(0, n).reduce((a, b) => a + b, 0) / n;
  for (let i = 0; i < n; i++) {
    re += (d[i]! - mean) * Math.cos((2 * Math.PI * i) / k);
    im += (d[i]! - mean) * Math.sin((2 * Math.PI * i) / k);
    sum += Math.abs(d[i]!);
  }
  return sum > 0 ? Math.hypot(re, im) / sum : 0;
}

test('contact hardening is visible and there is no acne at 85 deg sun incidence', async ({ page, pageLog }) => {
  await openPage(page, '/labs/render-core/?sun=110,32&hud=0&paused=1&fov=60&ev=14.6');
  await assertDiscreteGpu(page);
  await page.evaluate(() => {
    window.__test!.setDeterministic(true);
    // Close enough for everything measured to lie in the finest (12 m, 1.2 cm per texel) cascade.
    window.__rc!.lookAt([0.2, -4.3, 0], 180, 55, 7.5);
  });
  await waitIdle(page, 40);
  await saveScreenshot(page, 'render-core', 'shadows-contact-hardening');
  // Penumbra width along the pole's shadow: sharp at the foot, wide at the tip. Sample the shadow edge
  // profile across the shadow 0.6 m and 5.4 m from the foot (the shadow runs away from the sun).
  const widths = await page.evaluate(async () => {
    const lab = window.__lab!;
    const rc = window.__rc!;
    const img = await lab.renderer.readHdrPixels('resolved');
    const az = (110 * Math.PI) / 180;
    const el = (32 * Math.PI) / 180;
    // Unit vector along the shadow on the ground (away from the sun) and across it.
    const along = [-Math.sin(az), -Math.cos(az)];
    const shift = (h: number): number => h / Math.tan(el);
    /** 10 %..90 % transition length (m) of the luminance profile along the ground segment a -> b. */
    const edgeWidth = (a: [number, number], b: [number, number]): number => {
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const n = Math.ceil(len / 0.005);
      const lum: number[] = [];
      for (let i = 0; i <= n; i++) {
        const p = rc.projectSitePoint([a[0] + ((b[0] - a[0]) * i) / n, a[1] + ((b[1] - a[1]) * i) / n, 0])!;
        // Bilinear lookup in the resolved image.
        const x = Math.min(img.width - 2, Math.max(0, p.x - 0.5));
        const y = Math.min(img.height - 2, Math.max(0, p.y - 0.5));
        const x0 = Math.floor(x);
        const y0 = Math.floor(y);
        const g = (xx: number, yy: number): number => img.data[(yy * img.width + xx) * 4 + 1]!;
        lum.push((g(x0, y0) * (1 - (x - x0)) + g(x0 + 1, y0) * (x - x0)) * (1 - (y - y0)) + (g(x0, y0 + 1) * (1 - (x - x0)) + g(x0 + 1, y0 + 1) * (x - x0)) * (y - y0));
      }
      const hi = Math.max(...lum);
      const lo = Math.min(...lum);
      if (!(hi > 3 * lo)) return NaN;
      return (lum.filter((v) => v > lo + 0.1 * (hi - lo) && v < lo + 0.9 * (hi - lo)).length * len) / n;
    };
    // Step (0.4 m high box at (6, -5), 2 m square): the shadow of its west top edge, 0.64 m from the wall.
    const stepEdge = 5 + along[0]! * shift(0.4);
    const contact = edgeWidth([stepEdge + 0.3, -5.2 + along[1]! * shift(0.4)], [stepEdge - 0.3, -5.2 + along[1]! * shift(0.4)]);
    // Floating bar (underside 2.85 m above the ground at (2, -5), 4 m long in x): the north edge of its shadow.
    const barY = -5 + 0.15 + along[1]! * shift(2.85);
    const barX = 2 + along[0]! * shift(3);
    const floating = edgeWidth([barX, barY - 0.35], [barX, barY + 0.35]);
    return { contact, floating };
  });
  console.log(`penumbra (10-90 %): ${(widths.contact * 100).toFixed(1)} cm for a caster 0.4 m up, ${(widths.floating * 100).toFixed(1)} cm for a caster 2.9 m up`);
  // Contact hardening: the shadow of the floating bar is several times softer than the one at a contact.
  expect(widths.contact).toBeGreaterThan(0);
  expect(widths.contact).toBeLessThan(0.06);
  expect(widths.floating).toBeGreaterThan(widths.contact * 1.8);

  // 85 deg incidence: sun 5 deg above the horizon. An open, unshadowed part of the slab must be evenly lit.
  await page.evaluate(() => {
    window.__rc!.setSun([110, 5]);
    window.__rc!.lookAt([30, -30, 0], 20, 55, 7);
  });
  await waitIdle(page, 40);
  await saveScreenshot(page, 'render-core', 'shadows-grazing-85deg');
  const flat = await page.evaluate(async () => {
    const lab = window.__lab!;
    const [w, h] = lab.renderer.frameContext!.displaySize;
    const px = (await lab.renderer.readHdrPixels('resolved', { x: (w >> 1) - 100, y: (h >> 1) - 60, width: 200, height: 120 })).data;
    let sum = 0;
    let min = Infinity;
    let n = 0;
    for (let i = 0; i < px.length; i += 4) {
      sum += px[i + 1]!;
      min = Math.min(min, px[i + 1]!);
      n++;
    }
    return { mean: sum / n, min };
  });
  console.log(`grazing light: mean ${flat.mean.toFixed(4)}, min ${flat.min.toFixed(4)}`);
  expect(flat.mean).toBeGreaterThan(0.005);
  expect(flat.min / flat.mean).toBeGreaterThan(0.9); // no acne speckle
  await expectNoErrors(page, pageLog);
});

test('pad scene: staggered cascades stay registered to the rotating ground (no period-2/4/8 pattern)', async ({ page, pageLog }) => {
  // Earth rotates, casters and camera are fixed in the body frame, the sun is pinned in the site frame.
  // Seen from 160 m with a narrow lens, the stand is shadowed through the staggered 300 m cascade.
  await openPage(page, '/labs/render-core/?scene=pad&sun=110,25&hud=0&fov=14&ev=14.6&probe=casters');
  await assertDiscreteGpu(page);
  await page.evaluate(() => {
    window.__test!.setDeterministic(true);
    window.__lab!.renderer.setJitter(false);
    window.__rc!.lookAt([0, 6, 2], 200, 18, 160);
  });
  await waitIdle(page, 40);
  await saveScreenshot(page, 'render-core', 'shadows-pad-far');
  const s = await diffSeries(page, 33);
  const log = await page.evaluate(() => window.__rc!.probes.cascadeLog().slice(-200));
  // The staggered cascades really are staggered here and hold the scene.
  expect(log.some((c) => !c.everyFrame)).toBe(true);
  expect(Math.min(...s.rendered)).toBeLessThan(Math.max(...s.rendered));
  const max = Math.max(...s.diffs);
  console.log(`pad: frame-to-frame diff max ${max.toExponential(2)} / 255, cascades rendered per frame ${Math.min(...s.rendered)}..${Math.max(...s.rendered)}`);
  // Bound: nothing moves relative to the camera and the noise is frozen, so the image must be static.
  // A cascade that slipped by one texel (0.29 m in the 300 m cascade) would change every shadow edge pixel
  // on re-render: about 2 % of the crop by tens of levels, i.e. a diff of 0.3 or more.
  expect(max).toBeLessThan(0.02);

  // The same with animated noise (as in flight): the residual is noise, without a period of 2, 4 or 8 frames.
  await page.evaluate(() => window.__test!.setDeterministic(false));
  await page.evaluate(() => window.__lab!.renderer.setJitter(false));
  await page.evaluate(() => window.__test!.waitFrames(30));
  const a = await diffSeries(page, 65);
  const strengths = [2, 4, 8].map((k) => periodStrength(a.diffs, k));
  console.log(`pad (animated noise): mean diff ${(a.diffs.reduce((x, y) => x + y, 0) / a.diffs.length).toFixed(4)} / 255, period strengths ${strengths.map((v) => v.toFixed(3)).join(', ')}`);
  expect(Math.max(...a.diffs)).toBeLessThan(1);
  for (const v of strengths) expect(v).toBeLessThan(0.2);
  await expectNoErrors(page, pageLog);
});

test('lunar orbit: flying 1.6 km/s over a body-fixed ridge, shadows from staggered cascades do not pulse', async ({ page, pageLog }) => {
  await openPage(page, '/labs/render-core/?scene=lunarOrbit&stand=0&probe=ridge,casters,mover&ridge=track&hud=0&fov=40&ev=14.3');
  await assertDiscreteGpu(page);
  await page.evaluate(() => {
    const rc = window.__rc!;
    window.__test!.setDeterministic(true);
    window.__lab!.renderer.setJitter(false);
    rc.setSunAtSite(rc.probes.ridgeSite, [80, 14]);
    rc.trackSiteFromVessel(rc.probes.ridgeSite, 40);
  });
  await waitIdle(page, 40);
  await saveScreenshot(page, 'render-core', 'shadows-lunar-orbit-ridge');
  const speed = await page.evaluate(() => {
    const s = window.__test!.state()!;
    const v = s.vessels[0]!.v;
    return Math.hypot(v.x, v.y, v.z);
  });
  expect(speed).toBeGreaterThan(1500);
  const s = await diffSeries(page, 65);
  const mean = s.diffs.reduce((x, y) => x + y, 0) / s.diffs.length;
  const max = Math.max(...s.diffs);
  const strengths = [2, 4, 8].map((k) => periodStrength(s.diffs, k));
  console.log(`lunar orbit: frame diff mean ${mean.toFixed(4)}, max ${max.toFixed(4)} / 255; period strengths ${strengths.map((v) => v.toFixed(3)).join(', ')}; cascades per frame ${Math.min(...s.rendered)}..${Math.max(...s.rendered)}`);
  // Bound: the ridge is about 100 km away and the camera moves 27 m per frame, so the picture turns by
  // 0.3 mrad (0.4 px at this field of view) per frame. Shadow edges (a few % of the crop, contrast up to
  // 200 levels) may therefore change by at most a few tenths of a level on average.
  expect(max).toBeLessThan(0.6);
  // No spikes when a staggered cascade is re-rendered, and no period of 2, 4 or 8 frames.
  expect(max).toBeLessThan(3 * mean + 0.02);
  for (const v of strengths) expect(v).toBeLessThan(0.2);
  expect(Math.min(...s.rendered)).toBeLessThan(Math.max(...s.rendered));

  // The vessel-frame caster (probe "mover") was never drawn into a staggered cascade.
  const r = await page.evaluate(() => ({ violations: window.__rc!.probes.movingCasterViolations(), log: window.__rc!.probes.cascadeLog().slice(-300) }));
  expect(r.violations).toBe(0);
  expect(r.log.some((c) => !c.everyFrame)).toBe(true);
  expect(r.log.some((c) => c.everyFrame)).toBe(true);
  expect(r.log.every((c) => c.anchor.startsWith('body:'))).toBe(true);
  await expectNoErrors(page, pageLog);
});

test('a body-fixed ridge on a Moon-sized LabPlanet casts a visible shadow at the terminator from 20,000 km, and an approach through 1,500 km shows no pop', async ({ page, pageLog }) => {
  await openPage(page, '/labs/render-core/?scene=lunarOrbit&stand=0&probe=ridge,casters&hud=0&fov=5&ev=13.5&paused=1');
  await assertDiscreteGpu(page);
  await page.evaluate(() => {
    const rc = window.__rc!;
    window.__test!.setDeterministic(true);
    // Sun 6 deg above the eastern horizon at the ridge: the ridge sits just on the day side of the terminator.
    rc.setSunAtSite(rc.probes.ridgeSite, [90, 6]);
    rc.lookAt([-30e3, 0, 0], 180, 75, 2e7, rc.probes.ridgeSite);
  });
  await waitIdle(page, 40);
  await saveScreenshot(page, 'render-core', 'shadows-ridge-terminator-20000km');
  // West of the ridge (in its shadow, 6 km / tan 6 deg = 57 km long) against the lit ground east of it.
  const sample = async (): Promise<{ shadow: number; lit: number; fits: string[]; camTexel: number }> =>
    page.evaluate(async () => {
      const lab = window.__lab!;
      const rc = window.__rc!;
      const img = await lab.renderer.readHdrPixels('resolved');
      const lum = (enu: [number, number, number]): number => {
        const p = rc.projectSitePoint(enu, rc.probes.ridgeSite)!;
        let s = 0;
        let n = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const x = Math.round(p.x) + dx;
            const y = Math.round(p.y) + dy;
            if (x < 0 || y < 0 || x >= img.width || y >= img.height) continue;
            s += img.data[(y * img.width + x) * 4 + 1]!;
            n++;
          }
        }
        return n ? s / n : NaN;
      };
      const recent = rc.probes.cascadeLog().slice(-40);
      const fits = [...new Set(recent.map((c) => c.fit))];
      const camTexel = Math.max(...recent.filter((c) => c.fit === 'camera').map((c) => c.texelSize));
      // Mean of three points across the shadow / across the lit side (surface points: 0.8 km below the tangent plane at 35 km... negligible).
      return { shadow: (lum([-28e3, -20e3, 0]) + lum([-28e3, 0, 0]) + lum([-28e3, 20e3, 0])) / 3, lit: (lum([40e3, -20e3, 0]) + lum([40e3, 0, 0]) + lum([40e3, 20e3, 0])) / 3, fits, camTexel };
    });
  const far = await sample();
  console.log(`ridge from 20,000 km: shadow ${far.shadow.toFixed(4)}, lit ground ${far.lit.toFixed(4)}, cascades ${far.fits.join('+')}`);
  expect(far.fits).toContain('body');
  expect(far.lit).toBeGreaterThan(0.01);
  expect(far.shadow).toBeLessThan(0.15 * far.lit);

  // Approach: 3,000 km -> 600 km altitude in 49 steps. The shadow stays, and its darkness changes smoothly.
  const ratios: number[] = [];
  const fitsSeen = new Set<string>();
  let lastCamTexel = 0;
  let n = 0;
  for (let alt = 3000e3; alt >= 600e3; alt -= 50e3) {
    await page.evaluate((d) => {
      const rc = window.__rc!;
      window.__lab!.camera.settings.fovY = (20 * Math.PI) / 180;
      rc.lookAt([-10e3, 0, 0], 180, 70, d, rc.probes.ridgeSite);
    }, alt);
    await page.evaluate(() => window.__test!.waitFrames(10));
    const r = await sample();
    ratios.push(r.shadow / r.lit);
    for (const f of r.fits) fitsSeen.add(f);
    lastCamTexel = r.camTexel;
    if (n === 20 || n === 40) await saveScreenshot(page, 'render-core', `shadows-ridge-approach-${Math.round(alt / 1e3)}km`);
    n++;
  }
  console.log(`approach: shadow / lit ratio ${Math.min(...ratios).toFixed(3)} .. ${Math.max(...ratios).toFixed(3)}; cascade fits used: ${[...fitsSeen].join(', ')}`);
  // Both kinds of cascade were in use during the approach (hand-over happened) ...
  expect(fitsSeen.has('body')).toBe(true);
  expect(fitsSeen.has('camera')).toBe(true);
  // From 20,000 km only the 12 m and 60 m camera cascades exist; at the end the 1500 km camera cascade (1.46 km texels) covers the ridge.
  expect(far.camTexel).toBeLessThan(1);
  expect(lastCamTexel).toBeGreaterThan(1000);
  // ... the shadow never disappears, and never jumps from one step to the next.
  expect(Math.max(...ratios)).toBeLessThan(0.3);
  for (let i = 1; i < ratios.length; i++) expect(Math.abs(ratios[i]! - ratios[i - 1]!)).toBeLessThan(0.1);
  await expectNoErrors(page, pageLog);
});
