/**
 * What the visual review of round 0 asked to be held in numbers (out/qa/wave2/atmosphere-clouds.md):
 *
 *   item 1    the share of the sky that fair-weather cumulus cover, seen from the ground, is the map's cover
 *   item 8    an overcast seen from above dims with the sun (a deck under a sun 10 degrees up is a fraction
 *             as bright as at 60 degrees: the flux on a level layer falls with the sine of the elevation)
 *   item 10   at sunset the cloud field has warm sunlit parts and cooler shaded ones, under a sky that is
 *             still blue overhead
 *   item 11   the cloud light follows the sun: no history of the scene before, and the texels at the border
 *             of the frame are lit like the ones next to them
 *   item 12   no isolated dark pixel on a planet seen from afar (the full-resolution tile march)
 */
import type { Page } from '@playwright/test';
import { expect, expectNoErrors, test, waitIdle } from '../harness';
import { decode, openLab, PAD, setScene, settle, shot } from './lab';

const EV = 14.6;

/** Mean luminance (cd/m^2) and mean rgb of a rectangle of the HDR target (fractions of the target size). */
async function region(page: Page, r: { x0: number; y0: number; x1: number; y1: number }): Promise<{ lum: number; rgb: [number, number, number]; rows: number[]; cols: number[] }> {
  return page.evaluate(async (rect) => {
    const lab = window.__atmo!;
    const [w, h] = lab.app.renderer.frameContext!.renderSize;
    const x = Math.floor(rect.x0 * w);
    const y = Math.floor(rect.y0 * h);
    const width = Math.max(1, Math.floor((rect.x1 - rect.x0) * w));
    const height = Math.max(1, Math.floor((rect.y1 - rect.y0) * h));
    const px = await lab.readLuminance({ x, y, width, height });
    const rgb: [number, number, number] = [0, 0, 0];
    const rows = new Array<number>(height).fill(0);
    const cols = new Array<number>(width).fill(0);
    for (let j = 0; j < height; j++) {
      for (let i = 0; i < width; i++) {
        const o = (j * width + i) * 4;
        const l = 0.2126 * px.data[o]! + 0.7152 * px.data[o + 1]! + 0.0722 * px.data[o + 2]!;
        rows[j]! += l / width;
        cols[i]! += l / height;
        for (let c = 0; c < 3; c++) rgb[c]! += px.data[o + c]! / (width * height);
      }
    }
    return { lum: 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2], rgb, rows, cols };
  }, r);
}

/** Mean opacity of the cloud buffer over its central part (fractions of the half-resolution target). */
async function cloudOpacity(page: Page, margin: number): Promise<number> {
  return page.evaluate(async (m) => {
    const b = await window.__atmo!.feature.debug.clouds()!.readBuffers();
    let sum = 0;
    let n = 0;
    for (let y = Math.floor(m * b.height); y < Math.ceil((1 - m) * b.height); y++) {
      for (let x = Math.floor(m * b.width); x < Math.ceil((1 - m) * b.width); x++) {
        sum += 1 - b.radiance[(y * b.width + x) * 4 + 3]!;
        n++;
      }
    }
    return sum / n;
  }, margin);
}

/** Pixels of a screenshot far darker than all eight of their neighbours (a hole in a cloud one pixel wide). */
function isolatedDarkPixels(png: Buffer): number {
  const { width, height, data } = decode(png);
  const luma = new Float32Array(width * height);
  for (let i = 0; i < width * height; i++) luma[i] = 0.2126 * data[i * 4]! + 0.7152 * data[i * 4 + 1]! + 0.0722 * data[i * 4 + 2]!;
  let n = 0;
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      let around = 1e9;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (dx !== 0 || dy !== 0) around = Math.min(around, luma[(y + dy) * width + x + dx]!);
      // (Half as bright as the darkest neighbour, on a part of the picture that is lit at all.)
      if (around > 40 && luma[y * width + x]! < 0.5 * around) n++;
    }
  }
  return n;
}

test.describe('cloud light', () => {
  test('fair-weather cumulus cover the share of the sky that the map gives', async ({ page, pageLog }) => {
    test.setTimeout(240_000);
    const cover = 0.4;
    await openLab(page, `cover=${cover},3&relief=0&sky=0&ev=${EV}`);
    // Straight up from sixteen places 0.2 degrees (22 km) apart: the field is clustered at tens of
    // kilometres, so one place sees a cluster or a lane; the map's cover is their mean.
    const seen: number[] = [];
    for (let j = 0; j < 4; j++) {
      for (let i = 0; i < 4; i++) {
        await setScene(page, { latDeg: PAD.latDeg + (j - 1.5) * 0.2, lonDeg: PAD.lonDeg + (i - 1.5) * 0.2, alt: 2, headingDeg: 0, pitchDeg: 89.5, fovDeg: 60 }, { azDeg: 160, elDeg: 55 });
        await settle(page, 12);
        seen.push(await cloudOpacity(page, 0.1));
      }
    }
    const mean = seen.reduce((a, b) => a + b, 0) / seen.length;
    console.log(`[cloud light] share of the sky covered, straight up from 16 places: ${seen.map((v) => v.toFixed(2)).join(' ')}; mean ${mean.toFixed(3)} (map cover ${cover})`);
    expect(mean).toBeGreaterThan(cover - 0.1);
    expect(mean).toBeLessThan(cover + 0.1);
    // Clear lanes and clusters both exist.
    expect(Math.min(...seen)).toBeLessThan(0.2);
    expect(Math.max(...seen)).toBeGreaterThan(0.55);
    await expectNoErrors(page, pageLog);
  });

  test('an overcast seen from above dims with the sun', async ({ page, pageLog }) => {
    test.setTimeout(240_000);
    await openLab(page, `cover=1,2&relief=0&sky=0&ev=${EV}`);
    const view = { ...PAD, alt: 25_000, headingDeg: 250, pitchDeg: -40, fovDeg: 30 };
    const out: { el: number; lum: number }[] = [];
    for (const el of [60, 30, 10, 3]) {
      // (The sun 90 degrees to the side of the view: neither the forward nor the backward lobe.)
      await setScene(page, view, { azDeg: 160, elDeg: el });
      await settle(page, 40);
      if (el === 10) await shot(page, 'clouds-overcast-sun-10deg');
      out.push({ el, lum: (await region(page, { x0: 0.2, y0: 0.3, x1: 0.8, y1: 0.9 })).lum });
    }
    const at = (el: number): number => out.find((o) => o.el === el)!.lum;
    console.log(
      `[cloud light] overcast from 25 km: ${out.map((o) => `sun ${o.el} deg: ${o.lum.toFixed(0)} cd/m^2 (${(o.lum / at(60)).toFixed(3)} of 60 deg, sine ratio ${(Math.sin((o.el * Math.PI) / 180) / Math.sin(Math.PI / 3)).toFixed(3)})`).join('; ')}`,
    );
    // Brightness follows the flux on the layer (the sine of the elevation), within a band: the sky's own
    // light and the low-order scattering do not fall as fast, and the sun is redder and dimmer when low.
    expect(at(30) / at(60)).toBeGreaterThan(0.35);
    expect(at(30) / at(60)).toBeLessThan(0.85);
    expect(at(10) / at(60)).toBeGreaterThan(0.06);
    expect(at(10) / at(60)).toBeLessThan(0.4);
    expect(at(3) / at(60)).toBeGreaterThan(0.005);
    expect(at(3) / at(60)).toBeLessThan(0.2);
    await expectNoErrors(page, pageLog);
  });

  test('the cloud light follows the sun, to the edge of the frame', async ({ page, pageLog }) => {
    test.setTimeout(240_000);
    await openLab(page, 'cover=0.4,3&relief=0&sky=0&ev=11');
    const view = { ...PAD, alt: 30, headingDeg: 270, pitchDeg: 12, fovDeg: 75 };
    const rect = { x0: 0, y0: 0, x1: 1, y1: 0.55 };
    await setScene(page, view, { azDeg: 268, elDeg: 3 });
    await settle(page, 48);
    const before = await region(page, rect);
    // The sun goes down by 4.5 degrees between two frames (a time warp): no reset of the temporal state.
    await page.evaluate((v) => window.__atmo!.setSun(268, -1.5, { latDeg: v.latDeg, lonDeg: v.lonDeg }), view);
    await page.evaluate(() => window.__test!.waitFrames(8));
    const soon = await region(page, rect);
    await waitIdle(page, 96);
    const settled = await region(page, rect);
    console.log(
      `[cloud light] sun 3 deg -> -1.5 deg: mean luminance ${before.lum.toFixed(1)} cd/m^2 before, ${soon.lum.toFixed(2)} eight frames after the step, ${settled.lum.toFixed(2)} settled (ratio ${(soon.lum / settled.lum).toFixed(3)}); ` +
        `rows 0 / 2 ${(soon.rows[0]! / soon.rows[2]!).toFixed(3)}, columns 0 / 2 ${(soon.cols[0]! / soon.cols[2]!).toFixed(3)}, last / third last column ${(soon.cols[soon.cols.length - 1]! / soon.cols[soon.cols.length - 3]!).toFixed(3)}`,
    );
    expect(settled.lum).toBeLessThan(0.5 * before.lum);
    expect(Math.abs(soon.lum / settled.lum - 1)).toBeLessThan(0.08);
    // No frame of texels that are lit differently from their neighbours.
    expect(Math.abs(soon.rows[0]! / soon.rows[2]! - 1)).toBeLessThan(0.08);
    expect(Math.abs(soon.cols[0]! / soon.cols[2]! - 1)).toBeLessThan(0.08);
    expect(Math.abs(soon.cols[soon.cols.length - 1]! / soon.cols[soon.cols.length - 3]! - 1)).toBeLessThan(0.08);
    await expectNoErrors(page, pageLog);
  });

  test('sunset under broken cumulus: warm sunlit cloud, cooler shade, blue sky overhead', async ({ page, pageLog }) => {
    await openLab(page, 'cover=0.4,3&relief=0&sky=0');
    await setScene(page, { ...PAD, alt: 30, headingDeg: 200, pitchDeg: 25, fovDeg: 75 }, { azDeg: 268, elDeg: 3 });
    await settle(page, 48);
    await shot(page, 'clouds-ground-sunset-side');
    // Cloud pixels (the buffer's opaque ones) by brightness: the brightest tenth is sunlit, the darkest
    // third in shade. Colours from the HDR target at the same pixels.
    const r = await page.evaluate(async () => {
      const lab = window.__atmo!;
      const [w, h] = lab.app.renderer.frameContext!.renderSize;
      const b = await lab.feature.debug.clouds()!.readBuffers();
      const px = await lab.readLuminance({ x: 0, y: 0, width: w, height: h });
      const cloud: { l: number; rgb: [number, number, number] }[] = [];
      const sky: [number, number, number] = [0, 0, 0];
      let nSky = 0;
      for (let y = 4; y < b.height - 4; y += 2) {
        for (let x = 4; x < b.width - 4; x += 2) {
          const t = b.radiance[(y * b.width + x) * 4 + 3]!;
          const o = (Math.min(h - 1, y * 2) * w + Math.min(w - 1, x * 2)) * 4;
          const rgb: [number, number, number] = [px.data[o]!, px.data[o + 1]!, px.data[o + 2]!];
          if (t < 0.02) cloud.push({ l: 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2], rgb });
          else if (t > 0.999 && y < 0.3 * b.height) {
            for (let c = 0; c < 3; c++) sky[c]! += rgb[c]!;
            nSky++;
          }
        }
      }
      cloud.sort((a, c) => a.l - c.l);
      const mean = (list: typeof cloud): [number, number, number] => {
        const s: [number, number, number] = [0, 0, 0];
        for (const p of list) for (let c = 0; c < 3; c++) s[c]! += p.rgb[c]! / list.length;
        return s;
      };
      return { n: cloud.length, lit: mean(cloud.slice(Math.floor(cloud.length * 0.9))), shade: mean(cloud.slice(0, Math.floor(cloud.length / 3))), sky: sky.map((v) => v / Math.max(nSky, 1)), nSky };
    });
    const ratio = (c: number[]): string => `R/B ${(c[0]! / c[2]!).toFixed(2)}`;
    console.log(`[cloud light] sunset, sun 3 deg up: ${r.n} cloud samples; sunlit ${r.lit.map((v) => v.toFixed(0)).join(', ')} (${ratio(r.lit)}); shade ${r.shade.map((v) => v.toFixed(0)).join(', ')} (${ratio(r.shade)}); sky overhead ${r.sky.map((v) => v.toFixed(0)).join(', ')} (${ratio(r.sky)}, ${r.nSky} samples)`);
    expect(r.n).toBeGreaterThan(500);
    expect(r.nSky).toBeGreaterThan(200);
    // Warm against cool: the sunlit parts are far redder than the shaded ones, and the sky is blue.
    expect(r.lit[0] / r.lit[2]).toBeGreaterThan(2);
    expect(r.lit[0] / r.lit[2]).toBeGreaterThan(1.5 * (r.shade[0] / r.shade[2]));
    expect(r.sky[2]! / r.sky[0]!).toBeGreaterThan(1.3);
    await expectNoErrors(page, pageLog);
  });

  test('a planet seen from afar has no isolated dark pixels', async ({ page, pageLog }) => {
    test.setTimeout(180_000);
    await openLab(page, `ev=${EV}`);
    const views: { name: string; distance: number; phaseDeg: number; fovDeg: number }[] = [
      { name: '60000km', distance: 66371000, phaseDeg: 30, fovDeg: 25 },
      { name: '60000km-crescent', distance: 66371000, phaseDeg: 115, fovDeg: 25 },
      { name: 'moon-distance', distance: 384400000, phaseDeg: 60, fovDeg: 2.5 },
      { name: 'moon-distance-wide', distance: 384400000, phaseDeg: 60, fovDeg: 30 },
    ];
    const counts: string[] = [];
    let worst = 0;
    for (const v of views) {
      await page.evaluate((s) => window.__atmo!.viewFromSpace(s.distance, s.phaseDeg, s.fovDeg), v);
      await settle(page, 40);
      const saved = await shot(page, `clouds-far-${v.name}`);
      const n = isolatedDarkPixels(saved.buffer);
      counts.push(`${v.name}: ${n}`);
      worst = Math.max(worst, n);
    }
    console.log(`[cloud light] isolated dark pixels (half as bright as every neighbour): ${counts.join(', ')}`);
    expect(worst).toBeLessThanOrEqual(6);
    await expectNoErrors(page, pageLog);
  });
});
