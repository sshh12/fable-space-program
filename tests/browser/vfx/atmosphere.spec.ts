import type { Page } from '@playwright/test';
import { expect, expectNoErrors, saveScreenshot, test } from '../harness';
import { openLab } from './helpers';

test.describe.configure({ timeout: 600_000 });

/** Mean pre-exposed rgb of a 3 x 3 block of the HDR scene target around a site-frame point, and the same `dx` pixels to the side. */
async function probe(page: Page, enu: { x: number; y: number; z: number }, dx: number): Promise<{ on: number[]; off: number[]; x: number; y: number } | null> {
  return page.evaluate(
    async ({ enu, dx }) => {
      const lab = window.__vfx!;
      const p = lab.project(enu);
      if (!p) return null;
      const size = lab.app.renderer.frameContext!.renderSize;
      // Mean of a block of 9 x 9 pixels: from 2 km a flame is two or three pixels wide, and a 3 x 3 block
      // would hold more or less of it as the sub-pixel jitter of the frame moves it; a much larger block is
      // mostly sky beside the flame.
      const N = 9;
      const block = async (cx: number, cy: number): Promise<number[]> => {
        const x = Math.min(size[0] - N, Math.max(0, Math.round(cx) - (N >> 1)));
        const y = Math.min(size[1] - N, Math.max(0, Math.round(cy) - (N >> 1)));
        const px = await lab.app.renderer.readHdrPixels('hdr', { x, y, width: N, height: N });
        const s = [0, 0, 0];
        for (let i = 0; i < N * N; i++) for (let c = 0; c < 3; c++) s[c]! += px.data[i * 4 + c]! / (N * N);
        return s;
      };
      return { on: await block(p.x, p.y), off: await block(p.x + dx, p.y), x: p.x, y: p.y };
    },
    { enu, dx },
  );
}
const lum = (c: number[]): number => 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
const signal = (p: { on: number[]; off: number[] }): number => lum(p.on) - lum(p.off);

test('with the default atmosphere inputs the output is bit-identical to a build without applyAtmosphere', async ({ page, pageLog }) => {
  // Plumes, pad smoke, ice particles and the trail, two seconds after lift-off. Same frames in both builds.
  const capture = async (noatmo: boolean): Promise<{ hash: string; sum: number; lit: number; defaults: boolean[]; stats: Record<string, number> }> => {
    await openLab(page, `scene=pad&ev=13.5${noatmo ? '&noatmo=1' : ''}`);
    await page.evaluate(() => window.__lab!.renderer.setJitter(false));
    await page.evaluate(() => window.__vfx!.renderExact(360, true));
    await page.evaluate(() => window.__vfx!.renderExact(80, false));
    return page.evaluate(async () => {
      const r = window.__lab!.renderer;
      const px = await r.readHdrPixels('hdr');
      const bits = new Uint32Array(px.data.buffer);
      let h = 0x811c9dc5;
      let sum = 0;
      let lit = 0;
      for (let i = 0; i < bits.length; i++) {
        h = Math.imul(h ^ bits[i]!, 0x01000193) >>> 0;
        sum += px.data[i]!;
        if (px.data[i]! > 1) lit++;
      }
      return {
        hash: h.toString(16),
        sum,
        lit,
        defaults: [r.resources.isDefault('atmosphere.aerialPerspective'), r.resources.isDefault('clouds.screen'), r.resources.isDefault('clouds.depth')],
        stats: window.__vfx!.feature.debug.stats(),
      };
    });
  };
  const a = await capture(false);
  await expectNoErrors(page, pageLog);
  const b = await capture(true);
  await expectNoErrors(page, pageLog);
  console.log(`with applyAtmosphere: hash ${a.hash}, sum ${a.sum.toFixed(3)}; without: hash ${b.hash}, sum ${b.sum.toFixed(3)}; ${a.stats.particles} particles, smoke ${a.stats.smoke}, ${a.stats.trailSegments} trail segments, ${a.stats.plumeInstances} plume cluster`);
  expect(a.defaults).toEqual([true, true, true]);
  expect(a.stats.plumeInstances).toBe(1);
  expect(a.stats.smoke).toBe(1);
  expect(a.stats.particles).toBeGreaterThan(500);
  expect(a.lit).toBeGreaterThan(1000);
  expect(b.sum).toBe(a.sum);
  expect(b.hash).toBe(a.hash);
});

test('behind a synthetic overcast deck the plume and its trail are hidden; below the deck they are not', async ({ page, pageLog }) => {
  // The stack climbs straight up at 300 m/s from 400 m; the deck hangs 2 km above the site. Camera on the ground, 1.8 km away.
  await openLab(page, 'scene=ascent&altkm=0.4&speed=300&tilt=0&ev=13.5');
  await page.evaluate(() => window.__vfx!.setCamera({ follow: undefined, target: { x: 0, y: 0, z: 1500 }, yawDeg: 270, pitchDeg: -39.77, distance: 2342, fovDeg: 62 }));
  const deck = 2000;
  const setDeck = async (on: boolean): Promise<void> => {
    await page.evaluate(({ on, deck }) => window.__vfx!.sky.setOvercast(on ? { altitude: deck, transmittance: 0.02 } : null), { on, deck });
    await page.evaluate(() => window.__vfx!.renderExact(3, false));
  };
  // The probe sits in the body of the flame, 25 m below the nozzles (the flame is about a vehicle length long
  // and ends in a ragged tip: a point further down is flame in one frame and sky in the next; since round 3
  // of the close-out the flame is narrower and dimmer towards its tip, and 40 m down, above the deck, the
  // reading swung between 4.7 and 18.6 from run to run).
  const plumeAt = async (): Promise<{ x: number; y: number; z: number }> => {
    const n = await page.evaluate(() => window.__vfx!.nozzleEnu('stack'));
    return { x: n.x, y: n.y, z: n.z - 25 };
  };

  // (1) The vehicle below the deck: the plume is seen the same with and without the deck.
  await page.evaluate(() => window.__vfx!.renderExact(120, true));
  let at = await plumeAt();
  expect(at.z).toBeLessThan(deck - 600);
  await setDeck(false);
  const lowClear = (await probe(page, at, 90))!;
  await setDeck(true);
  const lowDeck = (await probe(page, at, 90))!;
  await page.evaluate(() => window.__vfx!.resume());
  await saveScreenshot(page, 'vfx', 'overcast-plume-below-deck');

  // (2) The vehicle above the deck: the plume is hidden, the trail below the deck is still there.
  await setDeck(false);
  await page.evaluate(() => window.__vfx!.renderExact(480, true));
  at = await plumeAt();
  expect(at.z).toBeGreaterThan(deck + 600);
  const highClear = (await probe(page, at, 90))!;
  const trailBelowClear = (await probe(page, { x: 0, y: 0, z: 1100 }, 60))!;
  const trailAboveClear = (await probe(page, { x: 0, y: 0, z: deck + 500 }, 60))!;
  await setDeck(true);
  const highDeck = (await probe(page, at, 90))!;
  const trailBelowDeck = (await probe(page, { x: 0, y: 0, z: 1100 }, 60))!;
  const trailAboveDeck = (await probe(page, { x: 0, y: 0, z: deck + 500 }, 60))!;
  await page.evaluate(() => window.__vfx!.resume());
  await saveScreenshot(page, 'vfx', 'overcast-plume-above-deck');

  const fmt = (v: number): string => v.toExponential(2);
  console.log(
    `plume signal (plume pixel - sky beside it, pre-exposed): below the deck ${fmt(signal(lowClear))} clear / ${fmt(signal(lowDeck))} with deck; above the deck ${fmt(signal(highClear))} clear / ${fmt(signal(highDeck))} with deck`,
  );
  console.log(
    `trail signal: below the deck ${fmt(signal(trailBelowClear))} clear / ${fmt(signal(trailBelowDeck))} with deck; above the deck ${fmt(signal(trailAboveClear))} clear / ${fmt(signal(trailAboveDeck))} with deck`,
  );
  expect(signal(lowClear)).toBeGreaterThan(0.5);
  // The deck is behind the plume here, so nothing is taken from the plume; what differs is the sky seen through
  // the plume's own transparency (the deck replaces the blue sky behind it).
  expect(signal(lowDeck)).toBeGreaterThan(0.8 * signal(lowClear));
  expect(signal(lowDeck)).toBeLessThan(1.2 * signal(lowClear));
  expect(signal(highClear)).toBeGreaterThan(0.5);
  // 2 % of the deck's transmittance is left of it.
  expect(Math.abs(signal(highDeck))).toBeLessThan(0.05 * signal(highClear));
  expect(Math.abs(signal(trailBelowClear))).toBeGreaterThan(1e-3);
  expect(Math.abs(signal(trailBelowDeck) - signal(trailBelowClear))).toBeLessThan(0.1 * Math.abs(signal(trailBelowClear)));
  expect(Math.abs(signal(trailAboveClear))).toBeGreaterThan(1e-3);
  expect(Math.abs(signal(trailAboveDeck))).toBeLessThan(0.1 * Math.abs(signal(trailAboveClear)));
  await expectNoErrors(page, pageLog);
});

test('a trail 50 km away takes the colour of a synthetic aerial-perspective volume', async ({ page, pageLog }) => {
  await openLab(page, 'scene=ascent&altkm=12&speed=420&ev=13.5&pad=0');
  await page.evaluate(() => window.__vfx!.setCamera({ follow: 'stack', target: { x: -900, y: 0, z: -3000 }, yawDeg: 180, pitchDeg: 0, distance: 50000, fovDeg: 14 }));
  await page.evaluate(() => window.__vfx!.renderExact(840, true));
  // A point of the trail 3.2 km behind the vehicle along its path (climbing 18 degrees off the vertical).
  const v = await page.evaluate(() => window.__vfx!.vesselEnu('stack'));
  const back = 3200;
  const point = { x: v.x - Math.sin((18 * Math.PI) / 180) * back, y: v.y, z: v.z - Math.cos((18 * Math.PI) / 180) * back };
  const haze: [number, number, number] = [9000, 3000, 1000];
  const clear = (await probe(page, point, 70))!;
  const distance = (await page.evaluate((p) => window.__vfx!.project(p), point))!.distance;
  await page.evaluate((h) => window.__vfx!.sky.setHaze({ length: 20000, luminance: h }), haze);
  await page.evaluate(() => window.__vfx!.renderExact(3, false));
  const hazed = (await probe(page, point, 70))!;
  await page.evaluate(() => window.__vfx!.resume());
  await saveScreenshot(page, 'vfx', 'haze-trail-50km');
  const diff = (p: { on: number[]; off: number[] }): number[] => p.on.map((c, i) => c - p.off[i]!);
  const chroma = (c: number[]): number[] => c.map((x) => x / (c[0]! + c[1]! + c[2]!));
  const dClear = diff(clear);
  const dHaze = diff(hazed);
  const hazeChroma = chroma(haze);
  console.log(
    `trail at ${(distance / 1000).toFixed(1)} km: contribution without haze ${dClear.map((x) => x.toExponential(2)).join(' ')} (chroma ${chroma(dClear).map((x) => x.toFixed(3)).join(' ')}); ` +
      `with haze ${dHaze.map((x) => x.toExponential(2)).join(' ')} (chroma ${chroma(dHaze).map((x) => x.toFixed(3)).join(' ')}); haze chroma ${hazeChroma.map((x) => x.toFixed(3)).join(' ')}`,
  );
  expect(distance).toBeGreaterThan(45000);
  expect(distance).toBeLessThan(56000);
  // Sunlit condensation is white; seen through 50 km of the orange haze (transmittance 8 %) it is the haze's colour.
  expect(lum(dClear)).toBeGreaterThan(0.02);
  expect(Math.abs(chroma(dClear)[0]! - chroma(dClear)[2]!)).toBeLessThan(0.08);
  for (let c = 0; c < 3; c++) expect(Math.abs(chroma(dHaze)[c]! - hazeChroma[c]!)).toBeLessThan(0.05);
  await expectNoErrors(page, pageLog);
});
