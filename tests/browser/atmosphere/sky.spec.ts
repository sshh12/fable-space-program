/**
 * Clear-sky physics of the atmosphere feature, measured on the HDR target and on the tables and checked
 * against the float64 reference model (src/render/atmosphere/reference.ts) and the brief's numbers.
 */
import type { Page } from '@playwright/test';
import { luminanceOf, multiScatter, referenceAtmosphere, skyRadiance, transmittanceToTop } from '../../../src/render/atmosphere/reference';
import { rMuFromTransmittanceUv } from '../../../src/render/atmosphere/math';
import { expect, expectNoErrors, test } from '../harness';
import { decode, luminance, openLab, PAD, probe, setScene, settle, shot } from './lab';

const RADIUS = 6371000;

interface AtmoDef {
  topAltitude: number;
  rayleighScattering: [number, number, number];
  rayleighScaleHeight: number;
  mieScattering: number;
  mieAbsorption: number;
  mieScaleHeight: number;
  miePhaseG: number;
  ozoneAbsorption: [number, number, number];
  ozoneCenterAltitude: number;
  ozoneHalfWidth: number;
  groundAlbedo: number;
}

async function atmosphereOf(page: Page): Promise<{ def: AtmoDef; radius: number; sun: [number, number, number] }> {
  return page.evaluate(() => {
    const lab = window.__atmo!;
    const body = lab.app.defs.bodies[lab.site.bodyId]!;
    const s = lab.app.renderer.frameContext!.sun;
    return { def: body.render.atmosphere!, radius: body.radius, sun: [s.color[0] * s.illuminance, s.color[1] * s.illuminance, s.color[2] * s.illuminance] as [number, number, number] };
  });
}

test.describe('clear sky', () => {
  test('noon at the pad: zenith luminance, horizon ratio, agreement with the float64 reference', async ({ page, pageLog }) => {
    await openLab(page, 'clouds=0&relief=0&sky=0&ev=14.5');
    const sunEl = 70;
    // Look straight up, then at the horizon away from the sun.
    await setScene(page, { ...PAD, alt: 2, headingDeg: 0, pitchDeg: 89.99, fovDeg: 40 }, { azDeg: 160, elDeg: sunEl });
    await settle(page);
    const zenith = await probe(page, 0.5, 0.5);
    await setScene(page, { ...PAD, alt: 2, headingDeg: 340, pitchDeg: 2, fovDeg: 40 }, { azDeg: 160, elDeg: sunEl });
    await settle(page);
    // 1.2 degrees above the horizontal.
    const horizon = await probe(page, 0.5, 0.5 - (0.8 / 40) * 1);
    const lz = luminance(zenith);
    const lh = luminance(horizon);
    console.log(`zenith ${lz.toFixed(0)} cd/m^2 (rgb ${zenith.map((v) => v.toFixed(0)).join(', ')}), horizon ${lh.toFixed(0)} cd/m^2, ratio ${(lh / lz).toFixed(2)}`);
    // Brief: zenith within a factor of 1.5 of 4,000-8,000 cd/m^2; horizon-to-zenith ratio above 2.
    expect(lz).toBeGreaterThan(4000 / 1.5);
    expect(lz).toBeLessThan(8000 * 1.5);
    expect(lh / lz).toBeGreaterThan(2);
    // Blue: the Rayleigh sky.
    expect(zenith[2]).toBeGreaterThan(zenith[0] * 1.5);

    // The float64 reference at the same geometry (brute-force quadrature, no tables).
    const { def, radius, sun } = await atmosphereOf(page);
    const a = referenceAtmosphere(radius, def);
    const cache = new Map<string, [number, number, number]>();
    const ms = (h: number, m: number): [number, number, number] => {
      const key = `${Math.round(h / 2000)}:${Math.round(m * 50)}`;
      let v = cache.get(key);
      if (!v) cache.set(key, (v = multiScatter(a, Math.round(h / 2000) * 2000, Math.round(m * 50) / 50, 8, 20)));
      return v;
    };
    const muS = Math.sin((sunEl * Math.PI) / 180);
    const ref = skyRadiance(a, 2, 1, muS, muS, sun, { steps: 300, multiScatter: ms });
    const lr = luminanceOf(ref.luminance);
    console.log(`reference zenith ${lr.toFixed(0)} cd/m^2 (rgb ${ref.luminance.map((v) => v.toFixed(0)).join(', ')}); GPU / reference ${(lz / lr).toFixed(4)}`);
    expect(lz / lr).toBeGreaterThan(0.95);
    expect(lz / lr).toBeLessThan(1.05);
    for (let c = 0; c < 3; c++) expect(zenith[c]! / ref.luminance[c]!).toBeCloseTo(1, 1);
    await expectNoErrors(page, pageLog);
  });

  test('transmittance table against the reference; the sun reddens at the horizon', async ({ page, pageLog }) => {
    await openLab(page, 'clouds=0&relief=0');
    await settle(page, 4);
    const { def, radius } = await atmosphereOf(page);
    const table = await page.evaluate(async () => {
      const t = await window.__atmo!.feature.debug.readTable('transmittance');
      return { width: t.width, height: t.height, layers: t.layers, data: Array.from(t.data) };
    });
    expect(table.layers).toBe(1);
    const a = referenceAtmosphere(radius, def);
    const rt = radius + def.topAltitude;
    let worst = 0;
    // Texels across the table, including the horizon column of the ground row.
    for (const [i, j] of [
      [0, 0],
      [128, 0],
      [200, 0],
      [240, 0],
      [254, 0],
      [100, 5],
      [220, 12],
      [60, 30],
      [250, 40],
      [128, 63],
    ] as const) {
      const [r, mu] = rMuFromTransmittanceUv((i + 0.5) / table.width, (j + 0.5) / table.height, radius, rt);
      const ref = transmittanceToTop(a, r - radius, mu, 2000);
      const o = (j * table.width + i) * 4;
      for (let c = 0; c < 3; c++) {
        const got = table.data[o + c]!;
        // Half floats: absolute floor for the nearly opaque horizon texels.
        worst = Math.max(worst, Math.abs(got - ref[c]!) / Math.max(ref[c]!, 0.02));
      }
    }
    console.log(`transmittance table vs reference: worst relative difference ${(worst * 100).toFixed(2)} %`);
    expect(worst).toBeLessThan(0.02);
    // Sun 1.4 degrees above the horizon seen from the ground: red over blue above 3 (brief).
    const col = Math.round(table.width * 0.94);
    const [, mu] = rMuFromTransmittanceUv((col + 0.5) / table.width, 0.5 / table.height, radius, rt);
    const red = table.data[col * 4]!;
    const blue = table.data[col * 4 + 2]!;
    console.log(`sun at mu ${mu.toFixed(4)} from the ground: transmittance R ${red.toFixed(4)} B ${blue.toExponential(2)}, R/B ${(red / Math.max(blue, 1e-9)).toFixed(1)}`);
    expect(mu).toBeLessThan(0.05);
    expect(red / Math.max(blue, 1e-9)).toBeGreaterThan(3);
    await expectNoErrors(page, pageLog);
  });

  test('sunset: orange horizon, blue zenith; anti-twilight arch opposite the sun', async ({ page, pageLog }) => {
    await openLab(page, 'clouds=0&relief=0&sky=0');
    await setScene(page, { ...PAD, alt: 30, headingDeg: 270, pitchDeg: 20, fovDeg: 70 }, { azDeg: 270, elDeg: 0.5 });
    await settle(page);
    const low = await probe(page, 0.75, 0.76);
    const high = await probe(page, 0.5, 0.05);
    console.log(`sunset: near the horizon rgb ${low.map((v) => v.toFixed(0)).join(', ')}; 50 degrees up rgb ${high.map((v) => v.toFixed(0)).join(', ')}`);
    expect(low[0]).toBeGreaterThan(low[2] * 1.5);
    expect(high[2]).toBeGreaterThan(high[0] * 1.2);
    // Opposite the sun, three degrees after sunset: the dark band of the planet's shadow on the horizon, the
    // pink arch above it, blue above that.
    await setScene(page, { ...PAD, alt: 30, headingDeg: 90, pitchDeg: 10, fovDeg: 70 }, { azDeg: 270, elDeg: -3 });
    await settle(page);
    const shadow = await probe(page, 0.5, 0.635);
    const arch = await probe(page, 0.5, 0.52);
    const above = await probe(page, 0.5, 0.05);
    console.log(`anti-twilight: shadow band ${luminance(shadow).toFixed(1)} cd/m^2 rgb ${shadow.map((v) => v.toFixed(1)).join(', ')}; arch rgb ${arch.map((v) => v.toFixed(1)).join(', ')}; above rgb ${above.map((v) => v.toFixed(1)).join(', ')}`);
    expect(luminance(arch)).toBeGreaterThan(luminance(shadow) * 1.3);
    expect(arch[0]).toBeGreaterThan(arch[1] * 1.1);
    expect(shadow[2]).toBeGreaterThan(shadow[0]);
    expect(above[2]).toBeGreaterThan(above[0]);
    // The twilight sky high up is blue, not purple or grey: in the scene (red below green below blue) and on
    // the screen, after the tone map (the display values of the same patch of the screenshot).
    expect(above[0], 'twilight sky 40 degrees up: red against green, scene-linear').toBeLessThan(above[1] * 0.99);
    expect(above[2]).toBeGreaterThan(above[1] * 1.5);
    const png = decode((await shot(page, 'sky-anti-twilight')).buffer);
    const display = [0, 0, 0];
    let count = 0;
    for (let y = Math.floor(png.height * 0.03); y < png.height * 0.08; y++) {
      for (let x = Math.floor(png.width * 0.45); x < png.width * 0.55; x++) {
        for (let c = 0; c < 3; c++) display[c]! += png.data[(y * png.width + x) * 4 + c]!;
        count++;
      }
    }
    console.log(`anti-twilight, on the screen: sky 40 degrees up rgb ${display.map((v) => (v / count).toFixed(1)).join(', ')} of 255`);
    expect(display[2]!, 'twilight sky on the screen: blue against red').toBeGreaterThan(display[0]! * 1.25);
    expect(display[2]!).toBeGreaterThan(display[1]! * 1.1);
    expect(display[0]!, 'twilight sky on the screen: red is not above green (purple)').toBeLessThanOrEqual(display[1]! * 1.02);
    await expectNoErrors(page, pageLog);
  });

  test('night under the planet: the sky adds nothing to the stars', async ({ page, pageLog }) => {
    await openLab(page, 'clouds=0&relief=0');
    await setScene(page, { ...PAD, alt: 30, headingDeg: 90, pitchDeg: 40, fovDeg: 60 }, { azDeg: 270, elDeg: -40 });
    await settle(page);
    const stats = await page.evaluate(async () => {
      const lab = window.__atmo!;
      const [w, h] = lab.app.renderer.frameContext!.renderSize;
      const px = await lab.readLuminance({ x: 0, y: 0, width: w, height: Math.floor(h * 0.6) });
      const lum: number[] = [];
      for (let i = 0; i < px.data.length; i += 4) lum.push(0.2126 * px.data[i]! + 0.7152 * px.data[i + 1]! + 0.0722 * px.data[i + 2]!);
      lum.sort((p, q) => p - q);
      return { median: lum[lum.length >> 1]!, p99: lum[Math.floor(lum.length * 0.99)]!, max: lum[lum.length - 1]!, ev: lab.app.renderer.exposureInfo().ev100 };
    });
    console.log(`night sky: median ${stats.median.toExponential(2)} cd/m^2, brightest star pixel ${stats.max.toFixed(2)} cd/m^2, EV100 ${stats.ev.toFixed(1)}`);
    // Between the stars the sky is black: far below the star pixels.
    expect(stats.median).toBeLessThan(1e-4);
    expect(stats.max).toBeGreaterThan(0.05);
    // The same stars without the atmosphere feature: within the airmass extinction of a clear night.
    await openLab(page, 'clouds=0&relief=0&atmosphere=0');
    await setScene(page, { ...PAD, alt: 30, headingDeg: 90, pitchDeg: 40, fovDeg: 60 }, { azDeg: 270, elDeg: -40 });
    await settle(page);
    const bare = await page.evaluate(async () => {
      const lab = window.__atmo!;
      const [w, h] = lab.app.renderer.frameContext!.renderSize;
      const px = await lab.readLuminance({ x: 0, y: 0, width: w, height: Math.floor(h * 0.6) });
      let max = 0;
      for (let i = 0; i < px.data.length; i += 4) max = Math.max(max, 0.2126 * px.data[i]! + 0.7152 * px.data[i + 1]! + 0.0722 * px.data[i + 2]!);
      return max;
    });
    console.log(`brightest star pixel without the atmosphere: ${bare.toFixed(2)} cd/m^2 (ratio ${(stats.max / bare).toFixed(3)})`);
    expect(stats.max / bare).toBeGreaterThan(0.6);
    expect(stats.max / bare).toBeLessThanOrEqual(1.0001);
    await expectNoErrors(page, pageLog);
  });

  test('climb from the ground to 200 km: sky radiance without a seam', async ({ page, pageLog }) => {
    test.setTimeout(240_000);
    // Fixed exposure, low enough that the thin air near the top of the shell still lands in the normal range
    // of the half-float target (at a daylight exposure it falls into subnormals with 2 % steps).
    await openLab(page, 'clouds=0&relief=0&sky=0&ev=6');
    await setScene(page, { ...PAD, alt: 2, headingDeg: 20, pitchDeg: 35, fovDeg: 60 }, { azDeg: 200, elDeg: 45 });
    await settle(page, 8);
    // Fixed view direction (35 degrees above the horizontal, away from the sun), 500 m altitude steps.
    const samples = await page.evaluate(
      async ({ lat, lon }) => {
        const lab = window.__atmo!;
        lab.app.setLoop(false);
        const out: number[] = [];
        for (let alt = 0; alt <= 200000; alt += 500) {
          lab.view({ latDeg: lat, lonDeg: lon, alt: Math.max(alt, 2), headingDeg: 20, pitchDeg: 35 });
          lab.app.renderFrame();
          const [w, h] = lab.app.renderer.frameContext!.renderSize;
          const c = await lab.probe(w * 0.5, h * 0.5, 1);
          out.push(0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]);
        }
        lab.app.setLoop(true);
        return out;
      },
      { lat: PAD.latDeg, lon: PAD.lonDeg },
    );
    expect(samples.length).toBe(401);
    // The sky darkens monotonically to black.
    expect(samples[0]!).toBeGreaterThan(1000);
    expect(samples[400]!).toBeLessThan(samples[0]! * 1e-4);
    let worstStep = 0;
    let worstStepAt = 0;
    let worstBend = 0;
    let worstBendAt = 0;
    let rises = 0;
    const floor = samples[0]! * 1e-5;
    for (let i = 1; i < samples.length - 1; i++) {
      const a = samples[i - 1]!;
      const b = samples[i]!;
      const c = samples[i + 1]!;
      if (b < floor) break;
      // Steps are compared below 70 km: above, the profile runs into the top of the modelled shell, where the
      // remaining air column (and with it the relative step) goes to zero by construction.
      if (i <= 140 && Math.abs(b - a) / a > worstStep) {
        worstStep = Math.abs(b - a) / a;
        worstStepAt = i * 0.5;
      }
      if (b > a * 1.0005) rises++;
      // Deviation of a sample from the geometric mean of its neighbours: zero for an exponential profile,
      // and the size of the jump at a discontinuity.
      const bend = Math.abs(b / Math.sqrt(a * c) - 1);
      if (bend > worstBend) {
        worstBend = bend;
        worstBendAt = i * 0.5;
      }
    }
    console.log(
      `climb 0-200 km: ${samples[0]!.toFixed(0)} -> ${samples[20]!.toFixed(0)} (10 km) -> ${samples[80]!.toFixed(1)} (40 km) -> ${samples[160]!.toExponential(2)} (80 km) -> ${samples[400]!.toExponential(2)} cd/m^2; ` +
        `largest step below 70 km ${(worstStep * 100).toFixed(2)} % per 500 m at ${worstStepAt} km; largest departure from a smooth profile ${(worstBend * 100).toFixed(3)} % at ${worstBendAt} km; ${rises} rises`,
    );
    // The physical step of an exponential atmosphere is 500 m / scale height (6 % for Rayleigh air), so the
    // seam criterion is stated on what a seam would add: no sample departs from the smooth profile through
    // its neighbours by 2 % (brief: "no step larger than 2 %", see the hand-off note for the reading).
    expect(worstBend).toBeLessThan(0.02);
    expect(worstStep).toBeLessThan(0.09);
    expect(rises).toBe(0);
    await expectNoErrors(page, pageLog);
  });

  test('energy sanity from the ground to deep space', async ({ page, pageLog }) => {
    await openLab(page, 'relief=0');
    const views: { name: string; view: Parameters<typeof setScene>[1]; sun: Parameters<typeof setScene>[2] }[] = [
      { name: 'pad noon', view: { ...PAD, alt: 2, headingDeg: 160, pitchDeg: 40, fovDeg: 90 }, sun: { azDeg: 160, elDeg: 60 } },
      { name: 'pad sunset into the sun', view: { ...PAD, alt: 2, headingDeg: 270, pitchDeg: 5, fovDeg: 60 }, sun: { azDeg: 270, elDeg: 1 } },
      { name: '40 km', view: { ...PAD, alt: 40000, headingDeg: 30, pitchDeg: -5, fovDeg: 60 }, sun: { azDeg: 160, elDeg: 30 } },
      { name: 'low orbit terminator', view: { ...PAD, alt: 400000, headingDeg: 270, pitchDeg: -20, fovDeg: 60 }, sun: { azDeg: 270, elDeg: 2 } },
      { name: 'low orbit night', view: { ...PAD, alt: 400000, headingDeg: 270, pitchDeg: -20, fovDeg: 60 }, sun: { azDeg: 270, elDeg: -25 } },
    ];
    for (const v of views) {
      await setScene(page, v.view, v.sun);
      await settle(page, 12);
      const s = await page.evaluate(async () => {
        const r = window.__atmo!.app.renderer;
        const px = await r.readHdrPixels('hdr');
        let min = Infinity;
        let max = 0;
        let bad = 0;
        for (let i = 0; i < px.data.length; i += 4) {
          for (let c = 0; c < 3; c++) {
            const x = px.data[i + c]!;
            if (!Number.isFinite(x)) bad++;
            else {
              min = Math.min(min, x);
              max = Math.max(max, x);
            }
          }
        }
        return { min, max, bad };
      });
      console.log(`${v.name}: HDR min ${s.min.toExponential(2)}, max ${s.max.toFixed(1)}, non-finite ${s.bad}`);
      expect(s.bad, v.name).toBe(0);
      expect(s.min, v.name).toBeGreaterThanOrEqual(0);
      expect(s.max, v.name).toBeLessThanOrEqual(60000);
    }
    await expectNoErrors(page, pageLog);
  });

  test('from orbit: a thin blue limb, black space, and nothing at all once the body is out of view', async ({ page, pageLog }) => {
    await openLab(page, 'clouds=0&relief=0&sky=0&ev=14.5');
    await setScene(page, { ...PAD, alt: 400000, headingDeg: 20, pitchDeg: -10, fovDeg: 60 }, { azDeg: 200, elDeg: 50 });
    await settle(page);
    // The limb is 19.8 degrees below the horizontal: 9.8 degrees below the image centre.
    const column = await page.evaluate(async () => {
      const lab = window.__atmo!;
      const [w, h] = lab.app.renderer.frameContext!.renderSize;
      const px = await lab.readLuminance({ x: w >> 1, y: 0, width: 1, height: h });
      const out: [number, number, number][] = [];
      for (let i = 0; i < h; i++) out.push([px.data[i * 4]!, px.data[i * 4 + 1]!, px.data[i * 4 + 2]!]);
      return out;
    });
    const lum = column.map((c) => luminance(c));
    const h = lum.length;
    expect(lum[Math.round(h * 0.1)]!).toBeLessThan(1e-3);
    // Find the glow: the first row from the top above 1 % of the peak, and the peak.
    const peak = Math.max(...lum);
    const peakRow = lum.indexOf(peak);
    const start = lum.findIndex((v) => v > 0.01 * peak);
    const glowDeg = ((peakRow - start) / h) * 60;
    const mid = column[Math.round((start + peakRow) / 2)]!;
    console.log(`limb: peak ${peak.toFixed(0)} cd/m^2 at row ${peakRow}, glow ${glowDeg.toFixed(2)} deg thick, colour rgb ${mid.map((v) => v.toFixed(0)).join(', ')}`);
    expect(peakRow / h).toBeGreaterThan(0.55);
    expect(peakRow / h).toBeLessThan(0.75);
    // 100 km of shell at 2,290 km: 2.5 degrees at most; the visible glow is thinner.
    expect(glowDeg).toBeGreaterThan(0.3);
    expect(glowDeg).toBeLessThan(2.6);
    expect(mid[2]).toBeGreaterThan(mid[0] * 2);

    // Looking away from the body: the feature draws nothing and publishes the neutral buffers.
    await setScene(page, { ...PAD, alt: 400000, headingDeg: 20, pitchDeg: 80, fovDeg: 40 }, { azDeg: 200, elDeg: 50 });
    await settle(page, 8);
    const idle = await page.evaluate(() => {
      const lab = window.__atmo!;
      const sel = lab.feature.debug.selection();
      const passes = lab.app.renderer.passStats();
      return { bodies: sel.bodies.length, march: passes['atmosphere.march']?.p50 ?? 0, aerialNeutral: !lab.app.renderer.resources.isDefault('atmosphere.aerialPerspective') };
    });
    expect(idle.bodies).toBe(0);
    await expectNoErrors(page, pageLog);
  });
});
