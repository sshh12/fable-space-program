/**
 * Volumetric clouds: registration against the baked coverage map, cloud shadows, temporal stability
 * (static camera, fast ascent) and the governor's quality scale.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { PNG } from 'pngjs';
import { expect, expectNoErrors, test, waitIdle } from '../harness';
import { luminance, openLab, PAD, setScene, settle, shot } from './lab';

const EV = 14.6;

/** Luminance of every pixel of a rectangle of the HDR target (fractions of the target size). */
async function frameLuminance(page: Page, rect: { x0: number; y0: number; x1: number; y1: number }, target: 'hdr' | 'resolved' = 'hdr'): Promise<number[]> {
  return page.evaluate(async ({ r, target: t }) => {
    const lab = window.__atmo!;
    const [w, h] = lab.app.renderer.frameContext!.renderSize;
    const px = await lab.readLuminance({ x: Math.floor(r.x0 * w), y: Math.floor(r.y0 * h), width: Math.floor((r.x1 - r.x0) * w), height: Math.floor((r.y1 - r.y0) * h) }, t);
    const out: number[] = [];
    for (let i = 0; i < px.data.length; i += 4) out.push(0.2126 * px.data[i]! + 0.7152 * px.data[i + 1]! + 0.0722 * px.data[i + 2]!);
    return out;
  }, { r: rect, target });
}

const mean = (a: number[]): number => a.reduce((s, v) => s + v, 0) / a.length;

test.describe('clouds', () => {
  test('from 60,000 km the clouds are where the coverage map puts them', async ({ page, pageLog }) => {
    test.setTimeout(180_000);
    await openLab(page, `relief=0&sky=0&ev=${EV}`);
    await page.evaluate(() => window.__atmo!.viewFromSpace(66371000, 30, 25));
    await settle(page, 40);
    await shot(page, 'clouds-orbit-vs-map');
    // Opacity of the cloud buffer the frame shows at a grid of pixels, with the geographic position each one
    // looks at (the sphere 3 km above the reference radius: inside the layer). A disc this small is drawn
    // from the full-resolution tile march (select.ts); the half-resolution buffers are then only what the
    // transparents read, and the opacity they hold is printed beside it.
    const samples = await page.evaluate(async () => {
      const lab = window.__atmo!;
      const clouds = lab.feature.debug.clouds()!;
      const sel = lab.feature.debug.selection();
      const half = await clouds.readBuffers();
      // Opacity of render-target pixel (x, y) in the half-resolution buffer and in the one shown.
      const halfAt = (x: number, y: number): number => 1 - half.radiance[(Math.floor(y / 2) * half.width + Math.floor(x / 2)) * 4 + 3]!;
      let shownAt = halfAt;
      if (sel.fine && sel.scissor) {
        const [sx, sy, sw, sh] = sel.scissor;
        const tile = await clouds.readFineBuffers({ x: 0, y: 0, width: sw, height: sh });
        shownAt = (x, y) => {
          const tx = Math.floor(x) - sx;
          const ty = Math.floor(y) - sy;
          if (tx < 0 || ty < 0 || tx >= sw || ty >= sh) return 0;
          return 1 - tile.radiance[(ty * tile.width + tx) * 4 + 3]!;
        };
      }
      const out: { lat: number; lon: number; opacity: number; halfOpacity: number }[] = [];
      for (let y = 2; y < half.height; y += 3) {
        for (let x = 2; x < half.width; x += 3) {
          const p = lab.surfacePoint(x * 2 + 0.5, y * 2 + 0.5, 3000);
          if (!p) continue;
          // Leave the limb out: there a pixel spans hundreds of kilometres of map.
          const q = lab.surfacePoint(x * 2 + 8.5, y * 2 + 0.5, 3000);
          if (!q || Math.abs(q.distance - p.distance) > 250000) continue;
          // (The shown buffer over the 2 x 2 pixels of the half-resolution texel the map's footprint is
          // measured for.)
          const shown = (shownAt(x * 2, y * 2) + shownAt(x * 2 + 1, y * 2) + shownAt(x * 2, y * 2 + 1) + shownAt(x * 2 + 1, y * 2 + 1)) / 4;
          out.push({ lat: p.latDeg, lon: p.lonDeg, opacity: shown, halfOpacity: halfAt(x * 2, y * 2) });
        }
      }
      return { samples: out, fine: sel.fine, offsetDeg: (clouds.coverageLongitudeOffset() * 180) / Math.PI };
    });
    expect(samples.samples.length).toBeGreaterThan(1000);
    const png = PNG.sync.read(fs.readFileSync(path.resolve('data/tiles/earth/globals/cloudCoverage.png')));
    const coverageAt = (lat: number, lon: number): number => {
      // Mean over the footprint of a half-resolution pixel (about 45 km at this distance): 9 x 9 texels.
      const cx = ((((lon + 180) % 360) + 360) % 360 / 360) * png.width;
      const cy = ((90 - lat) / 180) * png.height;
      let sum = 0;
      let n = 0;
      for (let dy = -4; dy <= 4; dy++) {
        for (let dx = -4; dx <= 4; dx++) {
          const x = ((Math.floor(cx) + dx) % png.width + png.width) % png.width;
          const y = Math.min(png.height - 1, Math.max(0, Math.floor(cy) + dy));
          sum += png.data[(y * png.width + x) * 4]! / 255;
          n++;
        }
      }
      return sum / n;
    };
    // The map drifts with the wind: the clouds over longitude L are the map's at L + offset.
    const pairs = samples.samples.map((s) => ({ c: coverageAt(s.lat, s.lon + samples.offsetDeg), o: s.opacity }));
    const mc = mean(pairs.map((p) => p.c));
    const mo = mean(pairs.map((p) => p.o));
    let sxy = 0;
    let sxx = 0;
    let syy = 0;
    for (const p of pairs) {
      sxy += (p.c - mc) * (p.o - mo);
      sxx += (p.c - mc) ** 2;
      syy += (p.o - mo) ** 2;
    }
    const corr = sxy / Math.sqrt(sxx * syy);
    const bins = [0, 0.1, 0.3, 0.5, 0.7, 0.9, 1.01];
    const binned = bins.slice(0, -1).map((lo, i) => {
      const inBin = pairs.filter((p) => p.c >= lo && p.c < bins[i + 1]!);
      return { lo, n: inBin.length, opacity: inBin.length ? mean(inBin.map((p) => p.o)) : NaN };
    });
    console.log(`${pairs.length} pixels (${samples.fine ? 'full-resolution tile' : 'half resolution'}): correlation of cloud opacity with map coverage ${corr.toFixed(3)}; mean coverage ${mc.toFixed(3)}, mean opacity ${mo.toFixed(3)} (half-resolution buffer for transparents ${mean(samples.samples.map((s) => s.halfOpacity)).toFixed(3)}); map drift ${samples.offsetDeg.toFixed(2)} deg`);
    console.log(`opacity by map coverage: ${binned.map((b) => `${b.lo.toFixed(1)}+: ${b.opacity.toFixed(2)} (${b.n})`).join(', ')}`);
    expect(corr).toBeGreaterThan(0.8);
    // Clear map: only the thin fair-weather fields the model adds. Overcast map: opaque.
    expect(binned[0]!.opacity).toBeLessThan(0.3);
    expect(binned[binned.length - 1]!.opacity).toBeGreaterThan(0.9);
    for (let i = 1; i < binned.length; i++) if (binned[i]!.n > 20 && binned[i - 1]!.n > 20) expect(binned[i]!.opacity).toBeGreaterThan(binned[i - 1]!.opacity);
    await expectNoErrors(page, pageLog);
  });

  test('cloud shadows: the ground under a deck is in shade, and the shadow map is placed for the core', async ({ page, pageLog }) => {
    const groundAndPlacement = async (query: string): Promise<{ ground: number; placement: boolean; halfExtent: number }> => {
      await openLab(page, `${query}&relief=0&sky=0&ev=${EV}`);
      await setScene(page, { ...PAD, alt: 300, headingDeg: 20, pitchDeg: -30, fovDeg: 50 }, { azDeg: 200, elDeg: 55 });
      await settle(page, 40);
      return page.evaluate(async () => {
        const lab = window.__atmo!;
        const [w, h] = lab.app.renderer.frameContext!.renderSize;
        const c = await lab.probe(w * 0.5, h * 0.6, 6);
        const p = lab.feature.debug.clouds()?.shadowPlacement() ?? null;
        return { ground: 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2], placement: p !== null, halfExtent: p?.halfExtent ?? 0 };
      });
    };
    const clear = await groundAndPlacement('clouds=0');
    const overcast = await groundAndPlacement('cover=0.9,4');
    await shot(page, 'clouds-shadow-under-deck');
    console.log(`ground luminance 500 m ahead: ${clear.ground.toFixed(0)} cd/m^2 under a clear sky, ${overcast.ground.toFixed(0)} under the deck (ratio ${(overcast.ground / clear.ground).toFixed(3)}); shadow map half extent ${(overcast.halfExtent / 1000).toFixed(0)} km`);
    expect(clear.placement).toBe(false);
    expect(overcast.placement).toBe(true);
    expect(overcast.halfExtent).toBeGreaterThanOrEqual(30000);
    // The direct sun is gone under the deck; the sky's share and the haze in between stay.
    expect(overcast.ground / clear.ground).toBeLessThan(0.45);
    expect(overcast.ground / clear.ground).toBeGreaterThan(0.03);
    await expectNoErrors(page, pageLog);
  });

  test('static camera, clouds drifting: consecutive frames differ by a fraction of a percent', async ({ page, pageLog }) => {
    await openLab(page, `cover=0.4,3&relief=0&sky=0&ev=${EV}`);
    await setScene(page, { ...PAD, alt: 30, headingDeg: 35, pitchDeg: 25, fovDeg: 70 }, { azDeg: 160, elDeg: 55 });
    // Animated noise, sub-pixel jitter, temporal accumulation, sim running: the frame as the game shows it.
    await page.evaluate(() => {
      window.__test!.setDeterministic(false);
      window.__test!.setPaused(false);
    });
    await waitIdle(page, 90);
    const rect = { x0: 0.05, y0: 0.05, x1: 0.95, y1: 0.6 };
    const frames: number[][] = [];
    await page.evaluate(() => window.__atmo!.app.setLoop(false));
    for (let i = 0; i < 6; i++) {
      await page.evaluate(() => window.__atmo!.app.renderFrame(1 / 60));
      frames.push(await frameLuminance(page, rect, 'resolved'));
    }
    await page.evaluate(() => window.__atmo!.app.setLoop(true));
    await shot(page, 'clouds-static-animated');
    let worstMean = 0;
    let worstP99 = 0;
    const m = mean(frames[0]!);
    for (let i = 1; i < frames.length; i++) {
      const d = frames[i]!.map((v, k) => Math.abs(v - frames[i - 1]![k]!)).sort((a, b) => a - b);
      worstMean = Math.max(worstMean, mean(d) / m);
      worstP99 = Math.max(worstP99, d[Math.floor(d.length * 0.99)]! / m);
    }
    const drift = await page.evaluate(() => window.__atmo!.feature.debug.clouds()!.time());
    console.log(`static camera, after temporal anti-aliasing: mean frame-to-frame difference ${(worstMean * 100).toFixed(3)} % of the mean luminance (${m.toFixed(0)} cd/m^2), 99th percentile ${(worstP99 * 100).toFixed(2)} %; cloud clock ${drift.toFixed(2)} s`);
    // The clouds move 8 m/s: at 3 km that is 0.03 pixels per frame, so what is left is the temporal noise
    // of the dithered march after accumulation. A percent of mean difference would be visible shimmer.
    expect(drift).toBeGreaterThan(0.5);
    expect(worstMean).toBeLessThan(0.006);
    expect(worstP99).toBeLessThan(0.06);
    await expectNoErrors(page, pageLog);
  });

  test('2 km/s ascent through a cumulus layer: no ghost trails', async ({ page, pageLog }) => {
    test.setTimeout(180_000);
    await openLab(page, `cover=0.4,3&relief=0&sky=0&ev=${EV}`);
    const view = { ...PAD, headingDeg: 35, pitchDeg: 5, fovDeg: 70 };
    await setScene(page, { ...view, alt: 400 }, { azDeg: 160, elDeg: 55 });
    await page.evaluate(() => {
      window.__test!.setDeterministic(false);
      window.__test!.setPaused(true);
    });
    await waitIdle(page, 60);
    const rect = { x0: 0.05, y0: 0.05, x1: 0.95, y1: 0.95 };
    // 90 frames at 33.3 m per frame: from under the layer, through it, to 3.4 km. The frame right after the
    // last step is compared with the same view left to converge.
    const stops = [1800, 3400];
    for (const stop of stops) {
      const moving = await page.evaluate(
        async ({ v, stop: end }) => {
          const lab = window.__atmo!;
          lab.app.setLoop(false);
          for (let alt = end - 30 * 33.3; alt <= end + 0.01; alt += 33.3) {
            lab.view({ ...v, alt });
            lab.app.renderFrame(1 / 60);
          }
          const [w, h] = lab.app.renderer.frameContext!.renderSize;
          const px = await lab.readLuminance({ x: Math.floor(0.05 * w), y: Math.floor(0.05 * h), width: Math.floor(0.9 * w), height: Math.floor(0.9 * h) });
          const out: number[] = [];
          for (let i = 0; i < px.data.length; i += 4) out.push(0.2126 * px.data[i]! + 0.7152 * px.data[i + 1]! + 0.0722 * px.data[i + 2]!);
          lab.app.setLoop(true);
          return out;
        },
        { v: view, stop },
      );
      await shot(page, `clouds-ascent-2kms-${stop}m-moving`);
      await waitIdle(page, 60);
      const still = await frameLuminance(page, rect);
      await shot(page, `clouds-ascent-2kms-${stop}m-converged`);
      const m = mean(still);
      // A trail: a pixel far from what the converged frame shows there.
      let off = 0;
      let sum = 0;
      for (let i = 0; i < still.length; i++) {
        const d = Math.abs(moving[i]! - still[i]!);
        sum += d;
        if (d > 0.3 * Math.max(still[i]!, 0.2 * m)) off++;
      }
      console.log(`ascent at 2 km/s, ${stop} m: mean difference from the converged frame ${((sum / still.length / m) * 100).toFixed(2)} %, pixels off by more than 30 %: ${((off / still.length) * 100).toFixed(2)} %`);
      expect(sum / still.length / m).toBeLessThan(0.06);
      expect(off / still.length).toBeLessThan(0.03);
    }
    await expectNoErrors(page, pageLog);
  });

  test('quality scale 1 -> 0.7 changes the mean cloud luminance by under 3 %', async ({ page, pageLog }) => {
    test.setTimeout(240_000);
    const scenes: { name: string; query: string; view: Parameters<typeof setScene>[1]; rect: { x0: number; y0: number; x1: number; y1: number } }[] = [
      { name: 'ground', query: 'cover=0.4,3', view: { ...PAD, alt: 30, headingDeg: 35, pitchDeg: 25, fovDeg: 70 }, rect: { x0: 0, y0: 0, x1: 1, y1: 0.6 } },
      { name: 'above-deck', query: 'cover=0.9,4', view: { ...PAD, alt: 6000, headingDeg: 40, pitchDeg: -8, fovDeg: 70 }, rect: { x0: 0, y0: 0.45, x1: 1, y1: 1 } },
      { name: 'orbit', query: '', view: { ...PAD, alt: 400000, headingDeg: 60, pitchDeg: -35, fovDeg: 60 }, rect: { x0: 0, y0: 0.35, x1: 1, y1: 1 } },
    ];
    for (const s of scenes) {
      const at = async (quality: number): Promise<{ mean: number; quality: number; grain: number }> => {
        // (Render scale pinned: the governor would lower the resolution next, which is not what is compared here.)
        await openLab(page, `${s.query}&relief=0&sky=0&ev=${EV}&scale=1&${quality === 1 ? 'governor=off' : `quality=${quality}`}`);
        await setScene(page, s.view, { azDeg: 160, elDeg: 50 });
        await page.evaluate(() => {
          window.__test!.setDeterministic(false);
          window.__test!.setPaused(true);
        });
        await waitIdle(page, 120);
        const q = await page.evaluate(() => window.__atmo!.app.renderer.frameContext!.qualityScale);
        if (quality < 1) await shot(page, `clouds-quality-0.7-${s.name}`);
        const lum = await frameLuminance(page, s.rect);
        // Grain: how far a pixel stands out from the mean of its two neighbours in the row (the flat array
        // wraps at the row ends, which a few thousand rows of pixels do not notice), relative to the mean.
        let hp = 0;
        for (let i = 1; i < lum.length - 1; i++) hp += Math.abs(lum[i]! - 0.5 * (lum[i - 1]! + lum[i + 1]!));
        return { mean: mean(lum), quality: q, grain: hp / (lum.length - 2) / mean(lum) };
      };
      const full = await at(1);
      const low = await at(0.7);
      console.log(`${s.name}: mean luminance ${full.mean.toFixed(1)} cd/m^2 at quality ${full.quality.toFixed(2)}, ${low.mean.toFixed(1)} at ${low.quality.toFixed(2)} (${((low.mean / full.mean - 1) * 100).toFixed(2)} %)`);
      expect(full.quality).toBe(1);
      expect(low.quality).toBeCloseTo(0.7, 2);
      console.log(`${s.name}: grain (mean departure of a pixel from its row neighbours) ${(full.grain * 100).toFixed(3)} % at quality 1, ${(low.grain * 100).toFixed(3)} % at 0.7`);
      expect(Math.abs(low.mean / full.mean - 1)).toBeLessThan(0.03);
      // A lower quality scale may soften the clouds; it must not put a texture on them.
      expect(low.grain).toBeLessThan(1.3 * full.grain + 0.001);
    }
    await expectNoErrors(page, pageLog);
  });

  test('wind: the clouds move with simulation time', async ({ page, pageLog }) => {
    await openLab(page, `cover=0.4,3&relief=0&sky=0&ev=${EV}`);
    await setScene(page, { ...PAD, alt: 30, headingDeg: 35, pitchDeg: 25, fovDeg: 70 }, { azDeg: 160, elDeg: 55 });
    await page.evaluate(() => {
      window.__test!.setDeterministic(false);
      window.__test!.setPaused(false);
    });
    await waitIdle(page, 30);
    const run = await page.evaluate(async () => {
      const lab = window.__atmo!;
      const clouds = lab.feature.debug.clouds()!;
      lab.app.setLoop(false);
      const t0 = clouds.time();
      const o0 = clouds.coverageLongitudeOffset();
      for (let i = 0; i < 120; i++) lab.app.renderFrame(1 / 60);
      const t1 = clouds.time();
      const o1 = clouds.coverageLongitudeOffset();
      lab.app.setLoop(true);
      return { seconds: t1 - t0, metres: (o0 - o1) * lab.app.defs.bodies[lab.site.bodyId]!.radius, drift: clouds.activeParams()!.coverageDriftMps };
    });
    console.log(`cloud clock: ${run.seconds.toFixed(3)} s over 120 frames of 1/60 s; the coverage map moved ${run.metres.toFixed(2)} m east (${run.drift} m/s)`);
    expect(run.seconds).toBeCloseTo(2, 1);
    expect(run.metres / run.seconds).toBeCloseTo(run.drift, 0);
    await expectNoErrors(page, pageLog);
  });
});
