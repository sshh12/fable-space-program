import type { Page } from '@playwright/test';
import { PNG } from 'pngjs';
import { assertDiscreteGpu, expect, expectNoErrors, openPage, pngDiff, saveScreenshot, test, waitIdle } from '../harness';

/**
 * Catalogue stars and the Milky Way: orientation against literature J2000 coordinates, the Milky Way band,
 * PSF photometry by HDR readback, visibility at a daylight and at the dark-adapted exposure, exposure
 * independence, and TAA stability. Camera at the ROOT origin (no planet drawn) unless stated otherwise.
 */
test.describe.configure({ timeout: 600_000 });

const D = Math.PI / 180;
const dir = (raDeg: number, decDeg: number) => ({ x: Math.cos(decDeg * D) * Math.cos(raDeg * D), y: Math.cos(decDeg * D) * Math.sin(raDeg * D), z: Math.sin(decDeg * D) });

/** J2000 / ICRS positions from the literature (SIMBAD), independent of the baked catalogue. */
const STARS: Record<string, [number, number]> = {
  Sirius: [101.287154, -16.716117],
  Canopus: [95.987958, -52.695661],
  Polaris: [37.954542, 89.264111],
  Alnitak: [85.189696, -1.942572],
  Alnilam: [84.053375, -1.201917],
  Mintaka: [83.001667, -0.299083],
  Acrux: [186.649542, -63.099083],
  Mimosa: [191.930292, -59.688778],
  Gacrux: [187.7915, -57.113222],
  Imai: [183.786333, -58.748917],
};

async function look(page: Page, raDeg: number, decDeg: number, fovDeg: number, frames = 6): Promise<void> {
  await page.evaluate(([ra, dec, fov]) => window.__sky!.lookAtRaDec(ra!, dec!, fov!), [raDeg, decDeg, fovDeg]);
  await page.evaluate((n) => window.__test!.waitFrames(n), frames);
}

/** HDR luminance (pre-exposed, before TAA) of a w x h window centred on (cx, cy), row-major. */
async function hdrWindow(page: Page, cx: number, cy: number, half: number): Promise<{ x0: number; y0: number; n: number; lum: number[] }> {
  return page.evaluate(
    async ([x, y, h]) => {
      const x0 = Math.round(x!) - h!;
      const y0 = Math.round(y!) - h!;
      const n = 2 * h! + 1;
      const px = await window.__lab!.renderer.readHdrPixels('hdr', { x: x0, y: y0, width: n, height: n });
      const lum: number[] = [];
      for (let i = 0; i < n * n; i++) lum.push(0.2126 * px.data[i * 4]! + 0.7152 * px.data[i * 4 + 1]! + 0.0722 * px.data[i * 4 + 2]!);
      return { x0, y0, n, lum };
    },
    [cx, cy, half],
  );
}

test('orientation: Sirius, Canopus, Polaris, Orion\'s belt and the Southern Cross at their projected pixels within 1 px', async ({ page, pageLog }) => {
  await openPage(page, '/labs/sky/?scene=translunar&planet=0&parts=-milkyWay,-impostors,-flare,-sun,-probe&ev=0&hud=0');
  await assertDiscreteGpu(page);
  await waitIdle(page, 4, 300_000);
  await page.evaluate(() => window.__lab!.renderer.setJitter(false));
  // Each group is viewed off-centre (the projection off-axis is part of what is checked).
  const groups: { aim: [number, number]; fov: number; names: string[] }[] = [
    { aim: [99, -12], fov: 30, names: ['Sirius'] },
    { aim: [92, -48], fov: 30, names: ['Canopus'] },
    { aim: [60, 84], fov: 30, names: ['Polaris'] },
    { aim: [86.5, -3.5], fov: 20, names: ['Alnitak', 'Alnilam', 'Mintaka'] },
    { aim: [184, -58], fov: 20, names: ['Acrux', 'Mimosa', 'Gacrux', 'Imai'] },
  ];
  for (const g of groups) {
    await look(page, g.aim[0], g.aim[1], g.fov);
    for (const name of g.names) {
      const [ra, dec] = STARS[name]!;
      const p = (await page.evaluate((d) => window.__sky!.projectDir(d), dir(ra, dec)))!;
      const w = await hdrWindow(page, p.x, p.y, 4);
      // Brightest pixel, then the luminance-weighted centroid of the 5 x 5 block around it (pixel centres at +0.5).
      let best = 0;
      w.lum.forEach((v, i) => {
        if (v > w.lum[best]!) best = i;
      });
      const bx = best % w.n;
      const by = Math.floor(best / w.n);
      let sx = 0;
      let sy = 0;
      let s = 0;
      for (let j = Math.max(0, by - 2); j <= Math.min(w.n - 1, by + 2); j++) {
        for (let i = Math.max(0, bx - 2); i <= Math.min(w.n - 1, bx + 2); i++) {
          const v = w.lum[j * w.n + i]!;
          sx += (w.x0 + i + 0.5) * v;
          sy += (w.y0 + j + 0.5) * v;
          s += v;
        }
      }
      const err = Math.hypot(sx / s - p.x, sy / s - p.y);
      console.log(`${name.padEnd(8)} projected (${p.x.toFixed(2)}, ${p.y.toFixed(2)})  centroid (${(sx / s).toFixed(2)}, ${(sy / s).toFixed(2)})  error ${err.toFixed(3)} px`);
      expect(s).toBeGreaterThan(0);
      expect(err).toBeLessThan(1);
    }
    await saveScreenshot(page, 'sky', `orientation-${g.names[0]!.toLowerCase()}`);
  }
  await expectNoErrors(page, pageLog);
});

test('the Milky Way band crosses Sagittarius, Cygnus, Cassiopeia, Carina and Crux and is dark at the galactic poles', async ({ page, pageLog }) => {
  await openPage(page, '/labs/sky/?scene=translunar&planet=0&parts=-stars,-impostors,-flare,-sun,-probe&ev=-3&hud=0');
  await assertDiscreteGpu(page);
  await waitIdle(page, 4, 300_000);
  const fields: [string, number, number][] = [
    ['Sagittarius (galactic centre)', 266.4, -28.9],
    ['Cygnus', 305, 40],
    ['Cassiopeia', 15, 61],
    ['Carina', 160, -60],
    ['Crux', 187, -61],
    ['north galactic pole (Coma)', 192.86, 27.13],
    ['south galactic pole (Sculptor)', 12.86, -27.13],
    ['Ursa Major (b = +55)', 165, 56],
  ];
  const lum: Record<string, number> = {};
  for (const [name, ra, dec] of fields) {
    await look(page, ra, dec, 20);
    const exp = await page.evaluate(() => window.__lab!.renderer.frameContext!.exposure);
    const w = await hdrWindow(page, 640, 360, 30);
    lum[name] = w.lum.reduce((a, b) => a + b, 0) / w.lum.length / exp;
    console.log(`${name.padEnd(32)} mean luminance ${lum[name]!.toExponential(3)} cd/m^2`);
  }
  const poles = Math.max(lum['north galactic pole (Coma)']!, lum['south galactic pole (Sculptor)']!);
  expect(lum['Sagittarius (galactic centre)']! / poles).toBeGreaterThan(10);
  for (const n of ['Cygnus', 'Cassiopeia', 'Carina', 'Crux']) expect(lum[n]! / poles).toBeGreaterThan(3);
  expect(lum['Ursa Major (b = +55)']! / poles).toBeLessThan(2);
  // The calibrated galactic-centre level of the bake (1e-3 .. 1e-2 cd/m^2 over 10 x 10 deg; this is 2.7 x 2.7 deg).
  expect(lum['Sagittarius (galactic centre)']!).toBeGreaterThan(5e-4);
  expect(lum['Sagittarius (galactic centre)']!).toBeLessThan(1e-2);
  await look(page, 280, -5, 90, 20);
  await saveScreenshot(page, 'sky', 'milky-way-band-ev-3');
  await expectNoErrors(page, pageLog);
});

test('PSF photometry: the integrated luminance of an isolated star is illuminance / pixel solid angle x exposure within 5 %', async ({ page, pageLog }) => {
  await openPage(page, '/labs/sky/?scene=translunar&planet=0&parts=-milkyWay,-impostors,-flare,-sun,-probe&hud=0');
  await assertDiscreteGpu(page);
  await waitIdle(page, 4, 300_000);
  await page.evaluate(() => window.__lab!.renderer.setJitter(false));
  // Sirius on the axis and 14 deg off it (cos^3 of the pixel solid angle), Rigel, and a 5th-magnitude star.
  const cases: { star: number; ev: number; offset: [number, number]; fov: number }[] = [
    { star: 0, ev: 0, offset: [0, 0], fov: 10 },
    { star: 0, ev: 0, offset: [14, 0], fov: 40 },
    { star: 6, ev: -1, offset: [0, 0], fov: 10 },
    { star: 1200, ev: -3, offset: [0, 0], fov: 10 },
  ];
  for (const c of cases) {
    const r = await page.evaluate(async ({ star, ev, offset, fov }) => {
      const sky = window.__sky!;
      const cat = sky.sky!.stars()!;
      const o = star * 8;
      const d = { x: cat.records[o]!, y: cat.records[o + 1]!, z: cat.records[o + 2]! };
      const ra = (Math.atan2(d.y, d.x) * 180) / Math.PI;
      const dec = (Math.asin(d.z) * 180) / Math.PI;
      window.__lab!.renderer.setExposureOverride(ev);
      sky.lookAtRaDec(ra + offset[0] / Math.cos((dec * Math.PI) / 180), dec + offset[1], fov);
      await window.__test!.waitFrames(6);
      const f = window.__lab!.renderer.frameContext!;
      const p = sky.projectDir(d)!;
      // The window holds the whole image: its wings reach out to where they fall under the floor (photometry.ts starImageRadius).
      const [rw, rh] = f.renderSize;
      const ty = Math.tan(f.camera.fovY / 2);
      const fw = { x: -f.view[2]!, y: -f.view[6]!, z: -f.view[10]! };
      const om = ((2 * ty * rw) / rh / rw) * ((2 * ty) / rh) * (d.x * fw.x + d.y * fw.y + d.z * fw.z) ** 3;
      const radius = sky.cpu.starImageRadius((cat.records[o + 3]! / om) * f.exposure);
      const half = Math.ceil(radius) + 2;
      const px = await window.__lab!.renderer.readHdrPixels('hdr', { x: Math.round(p.x) - half, y: Math.round(p.y) - half, width: 2 * half + 1, height: 2 * half + 1 });
      let sum = 0;
      for (let i = 0; i < px.data.length; i += 4) sum += 0.2126 * px.data[i]! + 0.7152 * px.data[i + 1]! + 0.0722 * px.data[i + 2]!;
      // Pixel solid angle at the star: on-axis value x cos^3 of the off-axis angle.
      const [w, h] = f.renderSize;
      const tanY = Math.tan(f.camera.fovY / 2);
      const tanX = (tanY * w) / h;
      const fwd = { x: -f.view[2]!, y: -f.view[6]!, z: -f.view[10]! };
      const c3 = (d.x * fwd.x + d.y * fwd.y + d.z * fwd.z) ** 3;
      const omega = ((2 * tanX) / w) * ((2 * tanY) / h) * c3;
      return { lux: cat.records[o + 3]!, mag: cat.records[o + 7]!, sum, expected: (cat.records[o + 3]! / omega) * f.exposure, cosOff: Math.cbrt(c3), radius };
    }, c);
    console.log(`star ${c.star} (V ${r.mag.toFixed(2)}), off-axis cos ${r.cosOff.toFixed(4)}: integrated ${r.sum.toExponential(4)}, E / omega x exposure ${r.expected.toExponential(4)}, ratio ${(r.sum / r.expected).toFixed(4)} (image radius ${r.radius.toFixed(1)} px)`);
    expect(Math.abs(r.sum / r.expected - 1)).toBeLessThan(0.05);
  }
  await expectNoErrors(page, pageLog);
});

/** 8-bit sRGB pixels of the canvas. */
async function canvasPixels(page: Page): Promise<PNG> {
  return PNG.sync.read(await page.screenshot());
}

test('at the exposure of a sunlit Earth (EV100 14-15) no star exceeds 1/255; in Earth\'s shadow the 100 brightest stars and the Milky Way are visible', async ({ page, pageLog }) => {
  // Day: low orbit, the sunlit Earth (with the lab's cloud layer) fills the lower part of the frame and meters
  // the exposure; then the comparison is made at EV100 14 and 15, the stated range.
  await openPage(page, '/labs/sky/?scene=lowOrbit&clouds=1&parts=-flare&hud=0&orbit=0,14,30');
  await assertDiscreteGpu(page);
  await page.evaluate(() => window.__sky!.setSunForVessel({ elevationDeg: 50, azimuthDeg: 180, fromCamera: true }));
  await waitIdle(page, 4, 300_000);
  await page.waitForFunction(() => {
    const e = window.__lab!.renderer.exposureInfo();
    return Math.abs(e.ev100 - e.targetEv100) < 0.02;
  }, undefined, { timeout: 60_000 });
  const metered = await page.evaluate(() => window.__lab!.renderer.exposureInfo().ev100);
  console.log(`sunlit Earth in view (lab cloud layer, no atmosphere): auto EV100 ${metered.toFixed(2)}`);
  await saveScreenshot(page, 'sky', 'leo-day-stars-invisible');

  // At EV100 14 and 15 the whole sky (Sirius and Canopus in view, the galactic centre too) changes no display pixel
  // by more than the dither. Measured on a pure sky frame (no planet): sky pixels are depth 0 either way, and the
  // frame is then exactly static (sim paused, no jitter, frozen noise), so the difference is the stars' alone.
  const sky = await page.context().newPage();
  await openPage(sky, '/labs/sky/?scene=lowOrbit&planet=0&parts=-flare,-sun&hud=0');
  await waitIdle(sky, 4, 300_000);
  await sky.evaluate(() => {
    window.__sky!.lookAtRaDec(100, -35, 70, window.__lab!.snapshot().vessels[0]!.rRoot);
    window.__lab!.setPaused(true);
    window.__lab!.setDeterministic(true);
    window.__lab!.renderer.setJitter(false);
  });
  for (const ev of [14, 15]) {
    await sky.evaluate((e) => window.__lab!.renderer.setExposureOverride(e), ev);
    await sky.evaluate(() => window.__test!.waitFrames(90));
    const withStars = await sky.screenshot();
    await sky.evaluate(() => window.__test!.waitFrames(5));
    const again = await sky.screenshot();
    await sky.evaluate(() => {
      window.__sky!.sky!.parts.stars = false;
      window.__sky!.sky!.parts.milkyWay = false;
    });
    await sky.evaluate(() => window.__test!.waitFrames(90));
    const without = await sky.screenshot();
    await sky.evaluate(() => {
      window.__sky!.sky!.parts.stars = true;
      window.__sky!.sky!.parts.milkyWay = true;
    });
    const floor = pngDiff(withStars, again);
    const day = pngDiff(withStars, without);
    console.log(`EV100 ${ev}: stars + Milky Way change the display by at most ${day.maxAbsDiff}/255 (${(day.differingFraction * 100).toFixed(4)} % of channels; static floor ${floor.maxAbsDiff})`);
    expect(floor.maxAbsDiff).toBe(0);
    expect(day.maxAbsDiff).toBeLessThanOrEqual(1);
  }
  await sky.close();

  // Night: in Earth's shadow, nothing lit in view: the core's dark-adapted exposure, reached by slow dark adaptation.
  await page.evaluate(() => window.__sky!.setSunForVessel('night'));
  await page.waitForFunction(
    () => {
      const e = window.__lab!.renderer.exposureInfo();
      return e.ev100 < 0 && Math.abs(e.ev100 - e.targetEv100) < 0.02;
    },
    undefined,
    { timeout: 240_000 },
  );
  await page.evaluate(() => window.__lab!.setDeterministic(true));
  const night = await page.evaluate(() => window.__lab!.renderer.exposureInfo().ev100);
  console.log(`Earth's shadow: EV100 ${night.toFixed(2)} (dark-adapted floor)`);
  expect(night).toBeLessThan(-5.5);
  await page.evaluate(() => window.__test!.waitFrames(60));
  const nightShot = PNG.sync.read((await saveScreenshot(page, 'sky', 'leo-night-dark-adapted')).buffer);
  // The night sky as a picture, at the exposure the game reaches by itself: star images above 16/255 (local maxima).
  {
    const luma = (i: number): number => 0.2126 * nightShot.data[i * 4]! + 0.7152 * nightShot.data[i * 4 + 1]! + 0.0722 * nightShot.data[i * 4 + 2]!;
    let images = 0;
    let lifted = 0;
    for (let y = 1; y < nightShot.height - 1; y++) {
      for (let x = 1; x < nightShot.width - 1; x++) {
        const i = y * nightShot.width + x;
        const v = luma(i);
        if (v > 8) lifted++;
        if (v < 16) continue;
        let isPeak = true;
        for (let dy = -1; dy <= 1 && isPeak; dy++) for (let dx = -1; dx <= 1; dx++) if ((dx !== 0 || dy !== 0) && luma(i + dy * nightShot.width + dx) > v) isPeak = false;
        if (isPeak) images++;
      }
    }
    console.log(`low orbit at night, automatic exposure: ${images} star images above 16/255, ${((lifted / (nightShot.width * nightShot.height)) * 100).toFixed(1)} % of the frame above 8/255`);
    expect(images).toBeGreaterThan(1000);
  }
  // The check of the 100 brightest is made 20,000 km up, still in the Earth's shadow (the night side then hides 1.5 %
  // of the sky, not a third), at the core's dark-adapted floor (pinned: the sunlit Moon in one of the views would
  // otherwise stop the exposure down for that view).
  await page.evaluate(() => {
    window.__sky!.setVesselAltitude(20e6);
  });
  await page.evaluate((e) => window.__lab!.renderer.setExposureOverride(e), night);
  const brightest = await page.evaluate(() => {
    const cat = window.__sky!.sky!.stars()!;
    return Array.from({ length: 100 }, (_, i) => ({ i, d: { x: cat.records[i * 8]!, y: cat.records[i * 8 + 1]!, z: cat.records[i * 8 + 2]! }, v: cat.records[i * 8 + 7]! }));
  });
  const seen = new Map<number, number>();
  const views: [number, number][] = [
    [0, 0],
    [90, 0],
    [180, 0],
    [270, 0],
    [0, 89],
    [0, -89],
    [45, 45],
    [225, -45],
  ];
  for (const [ra, dec] of views) {
    await page.evaluate(([r, d]) => {
      window.__sky!.lookAtRaDec(r!, d!, 90, window.__lab!.snapshot().vessels[0]!.rRoot);
    }, [ra, dec]);
    await page.evaluate(() => window.__test!.waitFrames(90));
    const png = await canvasPixels(page);
    const depth = await page.evaluate(async () => {
      const d = await window.__lab!.renderer.readDepth();
      return { w: d.width, h: d.height, data: Array.from(d.data) };
    });
    const proj = await page.evaluate((stars) => stars.map((s) => window.__sky!.projectDir(s.d)), brightest);
    proj.forEach((p, k) => {
      if (!p || p.x < 4 || p.y < 4 || p.x > png.width - 5 || p.y > png.height - 5) return;
      if (depth.data[Math.floor(p.y) * depth.w + Math.floor(p.x)] !== 0) return; // behind the night side of the Earth
      let peak = 0;
      for (let j = -2; j <= 2; j++) {
        for (let i = -2; i <= 2; i++) {
          const o = ((Math.floor(p.y) + j) * png.width + Math.floor(p.x) + i) * 4;
          peak = Math.max(peak, png.data[o]!, png.data[o + 1]!, png.data[o + 2]!);
        }
      }
      seen.set(k, Math.max(seen.get(k) ?? 0, peak));
    });
  }
  const values = [...seen.values()];
  console.log(`100 brightest stars: ${seen.size} in view (not behind the night Earth or the Moon) in at least one of ${views.length} views; faintest peak ${Math.min(...values)}/255, median ${values.sort((a, b) => a - b)[values.length >> 1]}/255`);
  expect(seen.size).toBeGreaterThanOrEqual(95);
  for (const [k, peak] of seen) expect(peak, `star #${k} (V ${brightest[k]!.v.toFixed(2)})`).toBeGreaterThanOrEqual(128);

  // The Milky Way at the dark-adapted exposure: faint but visible (stars off for the measurement).
  await page.evaluate(() => {
    window.__sky!.sky!.parts.stars = false;
  });
  const band: number[] = [];
  const bandRgb: [number, number, number][] = [];
  for (const [ra, dec] of [
    [266.4, -28.9],
    [305, 40],
    [187, -61],
    [192.86, 27.13],
    [12.86, -27.13],
  ] as [number, number][]) {
    await page.evaluate(([r, d]) => window.__sky!.lookAtRaDec(r!, d!, 20, window.__lab!.snapshot().vessels[0]!.rRoot), [ra, dec]);
    await page.evaluate(() => window.__test!.waitFrames(60));
    const blocked = await page.evaluate(async () => (await window.__lab!.renderer.readDepth()).data[360 * 1280 + 640] !== 0);
    const png = await canvasPixels(page);
    let s = 0;
    let n = 0;
    const c: [number, number, number] = [0, 0, 0];
    for (let y = 330; y < 390; y++) {
      for (let x = 610; x < 670; x++) {
        const o = (y * png.width + x) * 4;
        s += 0.2126 * png.data[o]! + 0.7152 * png.data[o + 1]! + 0.0722 * png.data[o + 2]!;
        for (let k = 0; k < 3; k++) c[k] = c[k]! + png.data[o + k]!;
        n++;
      }
    }
    band.push(blocked ? NaN : s / n);
    bandRgb.push([c[0] / n, c[1] / n, c[2] / n]);
  }
  console.log(`Milky Way at EV ${night.toFixed(1)} (8-bit mean): galactic centre ${band[0]?.toFixed(1)}, Cygnus ${band[1]?.toFixed(1)}, Crux ${band[2]?.toFixed(1)}, poles ${band[3]?.toFixed(1)} / ${band[4]?.toFixed(1)} (NaN = behind the Earth)`);
  const plane = band.slice(0, 3).filter((v) => Number.isFinite(v));
  const poles = band.slice(3).filter((v) => Number.isFinite(v));
  expect(plane.length).toBeGreaterThan(0);
  expect(poles.length).toBeGreaterThan(0);
  // The Milky Way is the main feature of the night sky: every field of the plane in view at 12/255 or more (the
  // galactic centre and Crux well above), the poles dark beside it.
  for (const v of plane) expect(v).toBeGreaterThanOrEqual(12);
  expect(Math.max(...plane)).toBeGreaterThan(25);
  expect(Math.max(...plane)).toBeLessThan(140);
  expect(Math.max(...plane) / Math.max(...poles)).toBeGreaterThan(3);
  // Faint light keeps its hue: the band's channel ratios three stops under this exposure (where it sits deep in the
  // display's toe) are within 20 % of the ratios here.
  const field = band.findIndex((v) => Number.isFinite(v));
  const [ra0, dec0] = [
    [266.4, -28.9],
    [305, 40],
    [187, -61],
  ][field]!;
  await page.evaluate(([r, d]) => window.__sky!.lookAtRaDec(r!, d!, 20, window.__lab!.snapshot().vessels[0]!.rRoot), [ra0!, dec0!]);
  await page.evaluate((e) => window.__lab!.renderer.setExposureOverride(e), night + 3);
  await page.evaluate(() => window.__test!.waitFrames(60));
  const dim = await canvasPixels(page);
  const d: [number, number, number] = [0, 0, 0];
  for (let y = 330; y < 390; y++) for (let x = 610; x < 670; x++) for (let k = 0; k < 3; k++) d[k] = d[k]! + dim.data[(y * dim.width + x) * 4 + k]! / 3600;
  const here = bandRgb[field]!;
  console.log(
    `hue of the band: at EV ${night.toFixed(1)} (${here.map((v) => v.toFixed(1)).join(', ')}) R/G ${(here[0] / here[1]).toFixed(2)} R/B ${(here[0] / here[2]).toFixed(2)}; at EV ${(night + 3).toFixed(1)} (${d.map((v) => v.toFixed(1)).join(', ')}) R/G ${(d[0] / d[1]).toFixed(2)} R/B ${(d[0] / d[2]).toFixed(2)}`,
  );
  expect(Math.abs(d[0] / d[1] / (here[0] / here[1]) - 1)).toBeLessThan(0.2);
  expect(Math.abs(d[0] / d[2] / (here[0] / here[2]) - 1)).toBeLessThan(0.2);
  await expectNoErrors(page, pageLog);
});

test('stars do not influence auto-exposure', async ({ page, pageLog }) => {
  await openPage(page, '/labs/sky/?scene=lowOrbit&parts=-flare&hud=0&orbit=0,14,30');
  await assertDiscreteGpu(page);
  await page.evaluate(() => window.__sky!.setSunForVessel({ elevationDeg: 50, azimuthDeg: 180, fromCamera: true }));
  await waitIdle(page, 4, 300_000);
  const settle = async (): Promise<number> => {
    await page.evaluate(() => window.__test!.waitFrames(30));
    await page.waitForFunction(() => {
      const e = window.__lab!.renderer.exposureInfo();
      return Math.abs(e.ev100 - e.targetEv100) < 0.005;
    }, undefined, { timeout: 60_000 });
    return page.evaluate(() => window.__lab!.renderer.exposureInfo().ev100);
  };
  const on = await settle();
  await page.evaluate(() => {
    window.__sky!.sky!.parts.stars = false;
    window.__sky!.sky!.parts.milkyWay = false;
  });
  const off = await settle();
  console.log(`settled EV100 with stars and Milky Way ${on.toFixed(4)}, without ${off.toFixed(4)}`);
  expect(Math.abs(on - off)).toBeLessThan(0.01);
  await expectNoErrors(page, pageLog);
});

/**
 * What the feature writes is constant for a static camera (frame difference exactly 0 in the HDR target without
 * jitter: no animated noise outside an atmosphere). With the TAA jitter on, the resolved image of a sigma 1.0 px
 * PSF follows the 8-phase jitter cycle of the core's resolve (its 3 x 3 reconstruction is not an interpolator for
 * a point source); the amplitude is measured and bounded here, frames stepped synchronously.
 */
test('static camera: the star field is constant; through TAA it varies only with the resolve\'s jitter cycle', async ({ page, pageLog }) => {
  await openPage(page, '/labs/sky/?scene=translunar&planet=0&parts=-impostors,-flare,-sun,-probe&ev=-3&hud=0');
  await assertDiscreteGpu(page);
  await waitIdle(page, 4, 300_000);
  await page.evaluate(() => {
    window.__sky!.lookAtRaDec(83.8, -1.0, 40, window.__lab!.snapshot().vessels[0]!.rRoot);
    window.__lab!.setPaused(true);
    window.__lab!.setDeterministic(true);
    window.__lab!.setLoop(false);
  });
  const r = await page.evaluate(async () => {
    const lab = window.__lab!;
    const read = async (target: 'hdr' | 'resolved') => (await lab.renderer.readHdrPixels(target)).data;
    // (1) Feature output without jitter: two consecutive frames.
    lab.renderer.setJitter(false);
    for (let i = 0; i < 4; i++) lab.renderFrame();
    const a = await read('hdr');
    lab.renderFrame();
    const b = await read('hdr');
    let hdrMax = 0;
    for (let i = 0; i < a.length; i++) hdrMax = Math.max(hdrMax, Math.abs(a[i]! - b[i]!));
    // (2) Through TAA with jitter: converge, then two full jitter cycles.
    lab.renderer.setJitter(true);
    for (let i = 0; i < 400; i++) lab.renderFrame();
    const frames: Float32Array[] = [];
    for (let i = 0; i < 17; i++) {
      lab.renderFrame();
      frames.push(await read('resolved'));
    }
    const lum = (d: Float32Array, i: number) => 0.2126 * d[i]! + 0.7152 * d[i + 1]! + 0.0722 * d[i + 2]!;
    let worst = 0;
    let sum = 0;
    let n = 0;
    let period = 0;
    for (let k = 1; k < frames.length; k++) {
      for (let i = 0; i < frames[k]!.length; i += 4) {
        const l0 = lum(frames[k - 1]!, i);
        const l1 = lum(frames[k]!, i);
        if (Math.max(l0, l1) < 0.05) continue;
        const rel = Math.abs(l1 - l0) / Math.max(l0, l1);
        worst = Math.max(worst, rel);
        sum += rel;
        n++;
      }
    }
    // Frames 8 apart (same jitter phase) agree much better than neighbours: the variation is the jitter cycle.
    for (let i = 0; i < frames[0]!.length; i += 4) {
      const l0 = lum(frames[0]!, i);
      const l8 = lum(frames[8]!, i);
      if (Math.max(l0, l8) >= 0.05) period = Math.max(period, Math.abs(l8 - l0) / Math.max(l0, l8));
    }
    lab.setLoop(true);
    return { hdrMax, worst, mean: sum / Math.max(n, 1), pixels: n / 16, period };
  });
  console.log(`HDR target, static camera, no jitter: max frame difference ${r.hdrMax}`);
  console.log(`resolved (TAA), ${r.pixels.toFixed(0)} star pixels above 0.05: consecutive frames differ by ${(r.mean * 100).toFixed(2)} % on average, ${(r.worst * 100).toFixed(1)} % at most; same jitter phase 8 frames apart: ${(r.period * 100).toFixed(2)} % at most`);
  expect(r.hdrMax).toBe(0);
  // Measured with the 1.0 px core: 0.35 % / 3.1 % / 2.3 % (with the 0.7 px core it was 0.82 % / 7.5 % / 2.8 %).
  expect(r.mean).toBeLessThan(0.01);
  expect(r.worst).toBeLessThan(0.06);
  expect(r.period).toBeLessThan(0.04);
  await expectNoErrors(page, pageLog);
});
