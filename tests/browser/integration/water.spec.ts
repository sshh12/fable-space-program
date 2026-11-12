/**
 * Check (a): far and near water with the real terrain and the ocean feature (ARCHITECTURE 10.2).
 *
 *  - Climb from 2 m to 400 km above open ocean with frozen time: nothing pops. The camera rises by a
 *    constant factor per step, so the image changes smoothly; a hand-over that is not continuous (the near
 *    field switching on or off, a level-of-detail change of the sheet) is one step whose frame difference
 *    stands far above its neighbours. Three differences are kept per step: pixel by pixel, of the frames
 *    averaged over 16 px blocks, and of the means of an 8 x 6 grid of regions. Close to the water the wave
 *    pattern itself changes by 4-15 of 255 per step pixel by pixel and by about 1 in the block averages
 *    (the waves are larger than a block there), so there the region means are what is sensitive: a region
 *    holds many waves and its mean stays put unless the brightness changes, a ring passes or a patch
 *    appears or vanishes. A control test changes the brightness of the frame by 5 % within one step, which
 *    must be reported, and prints what switching the near field off within one step looks like.
 *  - At fadeStart the forward water equals the deferred sheet within 2 %: the same frame with the near field
 *    forced off, compared pixel by pixel where the sea is just inside fadeStart and between fadeStart and
 *    fadeEnd (where both representations must coincide: that is what "no ring" means).
 *  - A shoreline at 200 m: under the forward water the opaque depth is the real seabed (the height
 *    authority's value at each point), refraction changes the shallows and nothing else, foam lies on the
 *    waterline.
 *  - Without the ocean feature the terrain's water is complete on its own.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { expect, test } from '../harness';
import { cloudClock, coverageBox, coverageMap, expectClean, findSky, fixedToMapLon, frameDiff, freeze, grab, mapToFixedLon, openIntegration, record, repoRoot, requireFeatures, save, settle, spikes, type Shot } from './helpers';

test.describe.configure({ timeout: 40 * 60_000 });

const NEAR_PLANE = 0.05;
const WATER_ID = 3;
const SITE = JSON.parse(fs.readFileSync(path.join(repoRoot, 'data', 'defs', 'sites', 'ka-lae.location.json'), 'utf8')) as { latDeg: number; lonDeg: number };
const OCEAN = JSON.parse(fs.readFileSync(path.join(repoRoot, 'data', 'defs', 'render', 'earth.ocean.json'), 'utf8')) as { params: { nearFieldFadeStartM: number; nearFieldFadeEndM: number } };
const EARTH_RADIUS = (JSON.parse(fs.readFileSync(path.join(repoRoot, 'data', 'tiles', 'earth', 'manifest.json'), 'utf8')) as { radius: number }).radius;
const CLOUDS = JSON.parse(fs.readFileSync(path.join(repoRoot, 'data', 'defs', 'render', 'earth.clouds.json'), 'utf8')) as { bottomAltitude: number; topAltitude: number; params: { coverageDriftMps: number } };

interface Place {
  latDeg: number;
  lonDeg: number;
  /** The real cloud map is clear within 2.5 degrees of the place (false: no such place over deep water). */
  clear: boolean;
}

/**
 * Open ocean, deep and far from land, under a clear part of the real cloud map (the climb passes through
 * the cloud shell). The map drifts with the feature's cloud clock, read from the page; the sea around each
 * candidate is checked with the height authority in the page. Pins the sun there, 40 degrees up.
 */
let chosenOcean: Place | null = null;

async function openOcean(page: Page): Promise<Place> {
  const map = coverageMap();
  const clock = await cloudClock(page);
  const time = clock.time ?? 0;
  const drift = clock.drift ?? CLOUDS.params.coverageDriftMps;
  if (chosenOcean) {
    // Still clear by this page's clock (every page starts its clock alike; this guards against a change of that).
    const stillClear = !chosenOcean.clear || !map || coverageBox(map, chosenOcean.latDeg, fixedToMapLon(chosenOcean.lonDeg, time, drift, EARTH_RADIUS), 2).max <= 0.05;
    if (stillClear) {
      await page.evaluate((c) => window.__integration!.setSun({ bodyId: 'earth', latDeg: c.latDeg, lonDeg: c.lonDeg, alt: 0 }, 120, 40), chosenOcean);
      return chosenOcean;
    }
  }
  const candidates: Place[] = (map ? findSky(map, 'clear', 2.5, 40) : []).slice(0, 80).map((b) => ({ latDeg: b.latDeg, lonDeg: mapToFixedLon(b.lonMapDeg, time, drift, EARTH_RADIUS), clear: true }));
  candidates.push({ latDeg: 8, lonDeg: -140, clear: false });
  const at = await page.evaluate(async (list) => {
    const lab = window.__integration!;
    for (const c of list) {
      let deep = true;
      // The place itself and eight points 1.5 degrees around it.
      for (const [dLat, dLon] of [[0, 0], [1.5, 0], [-1.5, 0], [0, 1.5], [0, -1.5], [1, 1], [1, -1], [-1, 1], [-1, -1]] as const) {
        if ((await lab.groundHeight('earth', c.latDeg + dLat, c.lonDeg + dLon)) > -1000) {
          deep = false;
          break;
        }
      }
      if (deep) {
        lab.setSun({ bodyId: 'earth', latDeg: c.latDeg, lonDeg: c.lonDeg, alt: 0 }, 120, 40);
        return c;
      }
    }
    return null;
  }, candidates);
  if (!at) throw new Error('no open ocean among the candidates');
  chosenOcean = at;
  return at;
}

interface ClimbSeries {
  altitudes: number[];
  /**
   * Per step: pixel-by-pixel mean and worst 16 px block; mean and worst difference of the block averages;
   * mean and worst change of the mean of an eighth-by-sixth region of the frame.
   */
  mean: number[];
  block: number[];
  coarse: number[];
  coarseBlock: number[];
  region: number[];
  regionBlock: number[];
}

interface Pop {
  series: 'mean' | 'block' | 'coarse' | 'coarseBlock' | 'region' | 'regionBlock';
  index: number;
  value: number;
  neighbours: number;
}

/**
 * Steps that stand out of a climb: several times the steps around them and plainly visible (pixel by pixel:
 * a mean above 1.5 of 255 or a block above 24; block averages: a mean above 0.75 or a block above 8; region
 * means: a mean above 0.75 or a region above 3). The region means are what sees a change of brightness
 * under a wave field of any contrast: the waves move the pixels and the 16 px blocks from step to step, a
 * region's mean they leave alone.
 */
function pops(c: ClimbSeries): Pop[] {
  const of = (series: Pop['series'], factor: number, floor: number): Pop[] => spikes(c[series], factor, floor).map((s) => ({ series, ...s }));
  return [...of('mean', 3, 1.5), ...of('block', 3, 24), ...of('coarse', 3, 0.75), ...of('coarseBlock', 3, 8), ...of('region', 3, 0.75), ...of('regionBlock', 3, 3)];
}

const describePops = (c: ClimbSeries, list: Pop[]): string => list.map((s) => `${c.altitudes[s.index]!.toFixed(0)} -> ${c.altitudes[s.index + 1]!.toFixed(0)} m: ${s.series} ${s.value.toFixed(2)} (around it ${s.neighbours.toFixed(2)})`).join('; ') || 'none';

async function climb(page: Page, at: { latDeg: number; lonDeg: number }, headingDeg: number, name: string): Promise<ClimbSeries> {
  const altitudes: number[] = [];
  for (let h = 2; h < 400_000; h *= 1.05) altitudes.push(h);
  altitudes.push(400_000);
  const mean: number[] = [];
  const block: number[] = [];
  const coarse: number[] = [];
  const coarseBlock: number[] = [];
  const region: number[] = [];
  const regionBlock: number[] = [];
  let prev: Shot | null = null;
  const keep = new Set([0, altitudes.findIndex((h) => h > 150), altitudes.findIndex((h) => h > 2_000), altitudes.findIndex((h) => h > 14_000), altitudes.findIndex((h) => h > 29_000), altitudes.findIndex((h) => h > 100_000), altitudes.length - 1]);
  for (let i = 0; i < altitudes.length; i++) {
    await page.evaluate(([lat, lon, h, heading]) => window.__integration!.surface('earth', lat!, lon!, h!, heading!, -20), [at.latDeg, at.lonDeg, altitudes[i]!, headingDeg]);
    await settle(page, 5);
    const shot = await grab(page);
    if (prev) {
      const d = frameDiff(prev, shot);
      mean.push(d.mean);
      block.push(d.blockMax);
      coarse.push(d.coarseMean);
      coarseBlock.push(d.coarseMax);
      region.push(d.regionMean);
      regionBlock.push(d.regionMax);
    }
    if (keep.has(i)) {
      const label = altitudes[i]! < 1000 ? `${Math.round(altitudes[i]!)}m` : `${Math.round(altitudes[i]! / 1000)}km`;
      await save(page, `water-climb-${name}-${label}`);
    }
    prev = shot;
  }
  return { altitudes, mean, block, coarse, coarseBlock, region, regionBlock };
}

for (const variant of [
  { name: 'water-only', query: 'features=terrain,ocean,sky', needs: ['terrain', 'ocean'] as const, title: 'terrain, ocean and sky alone' },
  { name: 'all', query: 'features=all', needs: ['terrain', 'ocean', 'atmosphere'] as const, title: 'every package' },
]) {
  test(`(a) climb from 2 m to 400 km above open ocean: no pop (${variant.title})`, async ({ page, pageLog }) => {
    const info = await openIntegration(page, `${variant.query}&scene=lowOrbit&paused=1&hud=0&ev=14&governor=off`);
    requireFeatures(test, info, variant.needs);
    await freeze(page);
    const at = await openOcean(page);
    const c = await climb(page, at, 120, variant.name);
    // With the atmosphere present the camera passes through the cloud shell, where a cloud around the
    // camera changes the frame from one step to the next: those steps are listed, and judged without the
    // clouds by the other variant of this test.
    const inShell = (s: { index: number }): boolean => info.loaded.includes('atmosphere') && c.altitudes[s.index + 1]! > 0.9 * CLOUDS.bottomAltitude && c.altitudes[s.index]! < 1.1 * CLOUDS.topAltitude;
    const all = pops(c);
    const found = all.filter((s) => !inShell(s));
    console.log(
      `(a) climb [${info.loaded.join(', ')}] at ${at.latDeg}, ${at.lonDeg.toFixed(2)}${at.clear ? ' (clear in the cloud map)' : ''}: ${c.mean.length} steps; frame difference pixel by pixel: mean ${Math.min(...c.mean).toFixed(2)} .. ${Math.max(...c.mean).toFixed(2)}, worst block ${Math.max(...c.block).toFixed(1)}; ` +
        `of the block averages: mean ${Math.min(...c.coarse).toFixed(2)} .. ${Math.max(...c.coarse).toFixed(2)}, worst block ${Math.max(...c.coarseBlock).toFixed(1)}; of the region means: mean ${Math.min(...c.region).toFixed(2)} .. ${Math.max(...c.region).toFixed(2)}, worst region ${Math.max(...c.regionBlock).toFixed(1)}; pops: ${describePops(c, found)}; inside the cloud shell: ${describePops(c, all.filter(inShell))}`,
    );
    record(`a.climb.${variant.name}`, { loaded: info.loaded, at, steps: c.mean.length, pops: found, inCloudShell: all.filter(inShell), ...c });
    expect(found, 'steps of the climb where the frame, or a part of it, jumps').toEqual([]);
    await expectClean(page, pageLog, info);
  });
}

test('(a) control: the climb reports a change of brightness of 5 % in one step', async ({ page, pageLog }) => {
  const info = await openIntegration(page, 'features=terrain,ocean,sky&scene=lowOrbit&paused=1&hud=0&ev=14&governor=off');
  requireFeatures(test, info, ['terrain', 'ocean']);
  await freeze(page);
  const at = await openOcean(page);
  // Twenty-one steps of the same climb from 2 km, where the waves of the near field fill the lower half of
  // the frame. `change` is applied before the eleventh frame.
  const run = async (change: () => Promise<void>): Promise<ClimbSeries> => {
    const c: ClimbSeries = { altitudes: [], mean: [], block: [], coarse: [], coarseBlock: [], region: [], regionBlock: [] };
    let prev: Shot | null = null;
    let h = 2000;
    for (let i = 0; i <= 20; i++, h *= 1.05) {
      c.altitudes.push(h);
      if (i === 10) await change();
      await page.evaluate(([lat, lon, alt]) => window.__integration!.surface('earth', lat!, lon!, alt!, 120, -20), [at.latDeg, at.lonDeg, h]);
      await settle(page, 5);
      const shot = await grab(page);
      if (prev) {
        const d = frameDiff(prev, shot);
        c.mean.push(d.mean);
        c.block.push(d.blockMax);
        c.coarse.push(d.coarseMean);
        c.coarseBlock.push(d.coarseMax);
        c.region.push(d.regionMean);
        c.regionBlock.push(d.regionMax);
      }
      prev = shot;
    }
    return c;
  };
  const at9 = (c: ClimbSeries, k: keyof Omit<ClimbSeries, 'altitudes'>): string => `${c[k][9]!.toFixed(2)} (before ${c[k][8]!.toFixed(2)}, after ${c[k][10]!.toFixed(2)})`;
  const describe = (c: ClimbSeries): string =>
    `pixel by pixel mean ${at9(c, 'mean')}, block ${at9(c, 'block')}; block averages mean ${at9(c, 'coarse')}, block ${at9(c, 'coarseBlock')}; region means mean ${at9(c, 'region')}, region ${at9(c, 'regionBlock')}; reported: ${describePops(c, pops(c))}`;

  // 1. The whole frame 5 % brighter from one step on (0.07 EV): reported.
  const brighter = await run(() => page.evaluate(() => window.__lab!.renderer.setExposureOverride(14 - 0.07)));
  await page.evaluate(() => window.__lab!.renderer.setExposureOverride(14));
  console.log(`(a) control, the frame 5 % brighter from 3.3 km on: ${describe(brighter)}`);
  // 2. The near field forced off from one step on: the waves give way to the smooth sheet. Pixel by pixel
  //    and in 16 px blocks that is no more than what the wave pattern changes from step to step anyway. The
  //    means of the regions differ a little between the two representations (0.85 of 255 when this was
  //    written, against 0.19 between ordinary steps), which the region series reports while that is so:
  //    printed and recorded, not asserted, because the agreement of the two is the business of the
  //    forward-against-deferred test below, and the better they agree the less there is to see here.
  const ocean = (off: boolean): Promise<void> => page.evaluate((o) => (window.__integration!.handles['ocean.createOceanFeature'] as { debug: { forceNearFieldOff(off: boolean): void } }).debug.forceNearFieldOff(o), off);
  const vanished = await run(() => ocean(true));
  await ocean(false);
  console.log(`(a) control, the near field switched off from 3.3 km on: ${describe(vanished)}`);
  record('a.climb.control', { loaded: info.loaded, at, brighter: { ...brighter, found: pops(brighter) }, vanished: { ...vanished, found: pops(vanished) } });
  expect(pops(brighter).map((s) => s.index), 'the step in which the frame became 5 % brighter').toContain(9);
  expect(pops(brighter).filter((s) => s.index !== 9), 'no other step is reported').toEqual([]);
  await expectClean(page, pageLog, info);
});

interface Agreement {
  band: string;
  /** Pixels compared, and pixels left out because two takes of the same state differ there. */
  pixels: number;
  unstable: number;
  worst: number;
  p99: number;
  mean: number;
}

/**
 * Forward against deferred water: the frame as it is and with the near field forced off, compared where the
 * sea lies at `d0..d1` metres from the eye (distance on the sea-level sphere along each pixel's ray).
 */
async function agreement(page: Page, altitude: number, pitchDeg: number, bands: [string, number, number][]): Promise<Agreement[]> {
  return page.evaluate(
    async ([h, pitch, bandList, radius]) => {
      const lab = window.__integration!;
      const ocean = lab.handles['ocean.createOceanFeature'] as { debug: { forceNearFieldOff(off: boolean): void } };
      const r = lab.app.renderer;
      await window.__test!.waitFrames(16);
      const forward = await r.readHdrPixels('hdr');
      ocean.debug.forceNearFieldOff(true);
      await window.__test!.waitFrames(16);
      const deferred = await r.readHdrPixels('hdr');
      ocean.debug.forceNearFieldOff(false);
      await window.__test!.waitFrames(16);
      // The frame as it is, once more: a pixel that differs between the two takes of the SAME state (a cloud
      // that is not frozen, a sparkle that is re-drawn) says nothing about forward against deferred.
      const again = await r.readHdrPixels('hdr');
      const W = forward.width;
      const H = forward.height;
      const f = H / 2 / Math.tan(lab.app.camera.settings.fovY / 2);
      const p = (-(pitch as number) * Math.PI) / 180;
      const rc = (radius as number) + (h as number);
      const luma = (img: { data: Float32Array }, o: number): number => 0.2126 * img.data[o]! + 0.7152 * img.data[o + 1]! + 0.0722 * img.data[o + 2]!;
      // A value below 1 % of the frame's median sea luminance is noise of the comparison, not a ring.
      const all: number[] = [];
      for (let y = 0; y < H; y += 7) for (let x = 0; x < W; x += 7) all.push(luma(deferred, (y * W + x) * 4));
      all.sort((a, b) => a - b);
      const floor = 0.01 * (all[all.length >> 1] ?? 0);
      return (bandList as [string, number, number][]).map(([band, d0, d1]) => {
        const diffs: number[] = [];
        let unstable = 0;
        for (let y = 0; y < H; y++) {
          for (let x = 0; x < W; x++) {
            const cx = x + 0.5 - W / 2;
            const cy = y + 0.5 - H / 2;
            const sinDip = (f * Math.sin(p) + cy * Math.cos(p)) / Math.hypot(f, cx, cy);
            const under = radius * radius - rc * rc * (1 - sinDip * sinDip);
            if (sinDip <= 0 || under < 0) continue;
            const d = rc * sinDip - Math.sqrt(under);
            if (d < d0 || d > d1) continue;
            const o = (y * W + x) * 4;
            const a = luma(forward, o);
            const b = luma(deferred, o);
            const a2 = luma(again, o);
            if (Math.abs(a - a2) > 0.003 * Math.max(a, a2, floor)) {
              unstable++;
              continue;
            }
            diffs.push(Math.abs(a - b) / Math.max(a, b, floor));
          }
        }
        diffs.sort((a, b) => a - b);
        return { band, pixels: diffs.length, unstable, worst: diffs[diffs.length - 1] ?? 0, p99: diffs[Math.floor(diffs.length * 0.99)] ?? 0, mean: diffs.reduce((s, v) => s + v, 0) / Math.max(1, diffs.length) };
      });
    },
    [altitude, pitchDeg, bands, EARTH_RADIUS] as const,
  );
}

for (const variant of [
  { name: 'water-only', query: 'features=terrain,ocean,sky', title: 'terrain, ocean and sky alone' },
  { name: 'all', query: 'features=all&without=vfx,vehicle,cockpit', title: 'under the real atmosphere and clouds' },
]) {
  test(`(a) at fadeStart the forward water equals the deferred sheet within 2 %, and they coincide out to fadeEnd (${variant.title})`, async ({ page, pageLog }) => {
    const fadeStart = OCEAN.params.nearFieldFadeStartM;
    const fadeEnd = OCEAN.params.nearFieldFadeEndM;
    const info = await openIntegration(page, `${variant.query}&scene=lowOrbit&paused=1&hud=0&ev=14&governor=off`);
    requireFeatures(test, info, ['terrain', 'ocean']);
    await freeze(page);
    const at = await openOcean(page);
    const results: (Agreement & { altitude: number; heading: number })[] = [];
    // Towards the sun's glitter and away from it; steep (6 km up: fadeStart is 24 degrees below the horizon),
    // shallow (1 km up, under the cloud shell: 4 degrees) and from near the top of the near field's
    // altitude range (14 km up).
    for (const view of [
      { altitude: 6_000, pitch: -22, heading: 120 },
      { altitude: 6_000, pitch: -22, heading: 300 },
      { altitude: 1_000, pitch: -8, heading: 120 },
      { altitude: 1_000, pitch: -8, heading: 300 },
      { altitude: 14_000, pitch: -55, heading: 200 },
    ]) {
      await page.evaluate(([lat, lon, h, heading, pitch]) => window.__integration!.surface('earth', lat!, lon!, h!, heading!, pitch!), [at.latDeg, at.lonDeg, view.altitude, view.heading, view.pitch]);
      await settle(page, 12);
      const bands = await agreement(page, view.altitude, view.pitch, [
        // The control: well inside fadeStart the forward water has its waves and the sheet has none. If the
        // two frames agree here, the comparison saw no sea (a cloud around the camera) or the switch did nothing.
        ['well inside fadeStart', 0.15 * fadeStart, 0.65 * fadeStart],
        // The ocean's own acceptance band (wave detail runs out linearly over the last 30 % of fadeStart:
        // 300 m inside, a fifteenth of it is left) and the last 50 m, where the two must have met.
        ['last 300 m inside fadeStart', fadeStart - 300, fadeStart - 5],
        ['last 50 m inside fadeStart', fadeStart - 50, fadeStart - 5],
        // 30 m of guard: the bands are cut on the sea-level sphere, the surface inside fadeStart has waves.
        ['fadeStart to fadeEnd', fadeStart + 30, fadeEnd],
        ['beyond fadeEnd', fadeEnd + 50, fadeEnd * 3],
      ]);
      for (const b of bands) results.push({ ...b, altitude: view.altitude, heading: view.heading });
      if (view.altitude === 6_000 && view.heading === 120) await save(page, `water-fadestart-6km-${variant.name}`);
    }
    for (const r of results) console.log(`(a) forward vs deferred [${info.loaded.join(', ')}], ${r.altitude} m up, heading ${r.heading}, ${r.band}: ${r.pixels} pixels, worst ${(100 * r.worst).toFixed(2)} %, p99 ${(100 * r.p99).toFixed(2)} %, mean ${(100 * r.mean).toFixed(3)} %`);
    record(`a.fadeStartAgreement.${variant.name}`, { loaded: info.loaded, at, fadeStart, fadeEnd, results });
    const control = results.filter((r) => r.band === 'well inside fadeStart' && r.pixels > 2000);
    expect(control.length, 'views with sea well inside fadeStart').toBeGreaterThan(1);
    // In the open (no atmosphere) every view must show the difference; under the real sky the camera may
    // stand in a cloud in some of them, so one view that plainly shows it is asked for.
    const seen = control.filter((r) => r.p99 > 0.03);
    expect(seen.length, 'views in which the near field visibly differs from the sheet well inside fadeStart (the control)').toBeGreaterThanOrEqual(variant.name === 'all' ? 1 : control.length);
    // The comparison stands on the pixels that hold still: at least half of each band must.
    for (const r of results.filter((x) => x.band !== 'well inside fadeStart' && x.pixels + x.unstable > 0)) expect(r.unstable / (r.pixels + r.unstable), `${r.band}, ${r.altitude} m up: share of pixels that change between two takes of the same frame`).toBeLessThan(0.5);
    const inside = results.filter((r) => r.band === 'last 50 m inside fadeStart');
    expect(inside.reduce((n, r) => n + r.pixels, 0), 'pixels in the last 50 m inside fadeStart').toBeGreaterThan(300);
    // Every band holds pixel by pixel without the atmosphere, and under it from below the cloud base (1 km
    // up). From 6 km and 14 km up the real clouds lie between the camera and the sea, and a small share of
    // the pixels (cloud edges, also beyond fadeEnd where there is no forward water at all) differs between
    // the frame with and without the near field: the clouds' own resolve reacts to the sea's depth, which is
    // not a ring in the water. There the mean is held and the outliers are logged (recorded in
    // docs/handoff/core-support.md for the atmosphere's owner and the lead).
    for (const r of results.filter((x) => x.band !== 'well inside fadeStart')) {
      const strict = variant.name !== 'all' || r.altitude < CLOUDS.bottomAltitude;
      if (strict) expect(r.worst, `${r.band}, ${r.altitude} m up, heading ${r.heading}: largest relative difference between forward and deferred water`).toBeLessThan(0.02);
      else expect(r.mean, `${r.band}, ${r.altitude} m up, heading ${r.heading}: mean relative difference between the frame with and without the near field`).toBeLessThan(0.01);
    }
    await expectClean(page, pageLog, info);
  });
}

interface ShorePoint {
  latDeg: number;
  lonDeg: number;
  /** Terrain height above sea level (negative = seabed), m. */
  ground: number;
  /** Distance from the waterline along the seaward bearing, m. */
  offshore: number;
  x: number;
  y: number;
  viewZ: number;
  distance: number;
}

test('(a) a shoreline from 200 m: the forward water lies over the real seabed, refraction acts in the shallows, foam on the waterline', async ({ page, pageLog }) => {
  const info = await openIntegration(page, `features=all&without=vfx,vehicle,cockpit&scene=lowOrbit&hud=0&ev=14&governor=off&sun=150,45&sunsite=earth,${SITE.latDeg},${SITE.lonDeg}&body=earth&lat=${SITE.latDeg}&lon=${SITE.lonDeg}&alt=400&pitch=-30`);
  requireFeatures(test, info, ['terrain', 'ocean']);
  // Find the waterline nearest to the site and the bearing out to sea, with the height authority.
  const shore = await page.evaluate(
    async ([lat0, lon0, radius]) => {
      const lab = window.__integration!;
      const RAD = 180 / Math.PI;
      const move = (lat: number, lon: number, bearingDeg: number, dist: number): [number, number] => {
        const d = dist / radius!;
        const b = bearingDeg / RAD;
        const la = lat / RAD;
        const la2 = Math.asin(Math.sin(la) * Math.cos(d) + Math.cos(la) * Math.sin(d) * Math.cos(b));
        const lo2 = lon / RAD + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(la), Math.cos(d) - Math.sin(la) * Math.sin(la2));
        return [la2 * RAD, lo2 * RAD];
      };
      let best: { bearing: number; dist: number } | null = null;
      for (let bearing = 0; bearing < 360; bearing += 20) {
        for (let dist = 150; dist <= 9000; dist += 150) {
          if (best && dist >= best.dist) break;
          const [la, lo] = move(lat0!, lon0!, bearing, dist);
          if ((await lab.groundHeight('earth', la, lo)) < -1.5) {
            best = { bearing, dist };
            break;
          }
        }
      }
      if (!best) return null;
      // The waterline on that bearing, by bisection between the last land sample and the first sea sample.
      let lo = best.dist - 150;
      let hi = best.dist;
      for (let i = 0; i < 12; i++) {
        const mid = (lo + hi) / 2;
        const [la, ln] = move(lat0!, lon0!, best.bearing, mid);
        if ((await lab.groundHeight('earth', la, ln)) < 0) hi = mid;
        else lo = mid;
      }
      const [sLat, sLon] = move(lat0!, lon0!, best.bearing, (lo + hi) / 2);
      // Sample points: a fan out to sea from the waterline, and a few on land.
      const points: { latDeg: number; lonDeg: number; ground: number; offshore: number }[] = [];
      for (const spread of [-30, -20, -10, 0, 10, 20, 30]) {
        for (const off of [-80, -40, 4, 8, 14, 22, 32, 45, 60, 80, 110, 150, 200, 280, 380, 520, 700, 950, 1300]) {
          const [la, ln] = move(sLat, sLon, best.bearing + (off < 0 ? 180 : 0) + spread, Math.abs(off));
          points.push({ latDeg: la, lonDeg: ln, ground: await lab.groundHeight('earth', la, ln), offshore: off });
        }
      }
      const [cLat, cLon] = move(sLat, sLon, best.bearing + 180, 150);
      const camGround = await lab.groundHeight('earth', cLat, cLon);
      return { bearing: best.bearing, shoreLat: sLat, shoreLon: sLon, cameraLat: cLat, cameraLon: cLon, cameraAlt: Math.max(200, camGround + 60), points };
    },
    [SITE.latDeg, SITE.lonDeg, EARTH_RADIUS] as const,
  );
  expect(shore, 'a waterline within 9 km of the site').not.toBeNull();
  const s = shore!;
  // Let the sea run for two seconds, then freeze it for the comparisons.
  await page.evaluate(([lat, lon, alt, heading]) => window.__integration!.surface('earth', lat!, lon!, alt!, heading!, -35), [s.cameraLat, s.cameraLon, s.cameraAlt, s.bearing]);
  await settle(page, 120);
  await page.evaluate(() => window.__test!.setPaused(true));
  await freeze(page);
  await settle(page, 16);
  await save(page, 'water-shoreline-200m');

  const measured = await page.evaluate(
    async ([pts, near]) => {
      const lab = window.__integration!;
      const ocean = lab.handles['ocean.createOceanFeature'] as { debug: { readOpaqueDepth(p: [number, number][]): Promise<number[]>; setRefractionScale(s: number): void; setDebugView(v: string): void; nearField(): unknown } };
      const r = lab.app.renderer;
      const W = r.frameContext!.renderSize[0];
      const H = r.frameContext!.renderSize[1];
      const placed = (pts as { latDeg: number; lonDeg: number; ground: number; offshore: number }[]).map((p) => {
        // Water points are looked up where the SEABED is; land points on the ground.
        const at = lab.project('earth', p.latDeg, p.lonDeg, p.ground);
        return { ...p, x: at ? Math.round(at.x - 0.5) : -1, y: at ? Math.round(at.y - 0.5) : -1, viewZ: at?.viewZ ?? 0, distance: at?.distance ?? 0 };
      });
      const visible = placed.filter((p) => p.x >= 4 && p.y >= 4 && p.x < W - 4 && p.y < H - 4);
      const depth = await ocean.debug.readOpaqueDepth(visible.map((p) => [p.x, p.y]));
      const window5 = (img: { width: number; data: Float32Array }, x: number, y: number, channel: (o: number) => number): number => {
        let sum = 0;
        for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) sum += channel(((y + dy) * img.width + x + dx) * 4);
        return sum / 25;
      };
      const lit = await r.readHdrPixels('hdr');
      ocean.debug.setRefractionScale(0);
      await window.__test!.waitFrames(12);
      const flat = await r.readHdrPixels('hdr');
      ocean.debug.setRefractionScale(1);
      // Foam at five instants a second apart (the swash comes and goes with the run-up): per pixel, the most.
      const exposure = r.frameContext!.exposure;
      let foam = lit;
      for (let k = 0; k < 5; k++) {
        ocean.debug.setDebugView('foam');
        await window.__test!.waitFrames(10);
        const take = await r.readHdrPixels('hdr');
        if (k === 0) foam = take;
        else for (let i = 1; i < take.data.length; i += 4) foam.data[i] = Math.max(foam.data[i]!, take.data[i]!);
        ocean.debug.setDebugView('none');
        if (k < 4) {
          window.__test!.setPaused(false);
          await window.__test!.waitFrames(60);
          window.__test!.setPaused(true);
        }
      }
      await window.__test!.waitFrames(6);
      lab.showGBuffer('material');
      await window.__test!.waitFrames(6);
      const material = await r.readHdrPixels('hdr');
      lab.showGBuffer(null);
      await window.__test!.waitFrames(6);
      const luma = (img: { data: Float32Array }) => (o: number): number => 0.2126 * img.data[o]! + 0.7152 * img.data[o + 1]! + 0.0722 * img.data[o + 2]!;
      return {
        nearField: ocean.debug.nearField(),
        points: visible.map((p, i) => {
          const a = window5(lit, p.x, p.y, luma(lit));
          let change = 0;
          for (let dy = -2; dy <= 2; dy++) {
            for (let dx = -2; dx <= 2; dx++) {
              const o = ((p.y + dy) * lit.width + p.x + dx) * 4;
              change += Math.abs(luma(lit)(o) - luma(flat)(o));
            }
          }
          return {
            ...p,
            opaqueZ: (near as number) / Math.max(depth[i]!, 1e-30),
            luminance: a,
            refraction: change / 25 / Math.max(a, 1e-9),
            // The foam view writes coverage x 2000 cd/m^2 through the frame's exposure.
            foam: window5(foam, p.x, p.y, (o) => foam.data[o + 1]!) / (2000 * exposure),
            materialId: Math.round(material.data[(p.y * material.width + p.x) * 4 + 1]!),
          };
        }),
      };
    },
    [s.points, NEAR_PLANE] as const,
  );
  const pts = measured.points as (ShorePoint & { opaqueZ: number; luminance: number; refraction: number; foam: number; materialId: number })[];

  // 1. The seabed: where the height authority says the bottom is 3-40 m down, the opaque depth under the
  //    forward water is that bottom, not the sea-level sheet. Error along the ray, turned into metres of height.
  const bed = pts.filter((p) => p.ground <= -3 && p.ground >= -40);
  const bedErrors = bed.map((p) => {
    const sinDip = (s.cameraAlt - p.ground) / p.distance;
    const rangeScale = p.distance / p.viewZ;
    return { ground: p.ground, error: Math.abs(p.opaqueZ - p.viewZ) * rangeScale * sinDip, sheetError: Math.abs(p.ground) };
  });
  const bedWorst = Math.max(0, ...bedErrors.map((e) => e.error - 0.15 * Math.abs(e.ground)));
  // 2. Refraction: the image changes in the shallows when refraction is switched off, and not on land or over deep water.
  const mean = (list: number[]): number => list.reduce((a, b) => a + b, 0) / Math.max(1, list.length);
  const shallow = pts.filter((p) => p.ground <= -0.4 && p.ground >= -6);
  const deep = pts.filter((p) => p.ground < -60);
  const land = pts.filter((p) => p.ground > 1.5);
  const refraction = { shallow: mean(shallow.map((p) => p.refraction)), deep: mean(deep.map((p) => p.refraction)), land: mean(land.map((p) => p.refraction)) };
  // 3. Foam: on the waterline (bottom within the shore-foam depth), not out at sea.
  const swash = pts.filter((p) => p.ground <= -0.05 && p.ground >= -0.8);
  const offshore = pts.filter((p) => p.ground < -15);
  const foam = { swash: mean(swash.map((p) => p.foam)), offshore: mean(offshore.map((p) => p.foam)) };
  console.log(
    `(a) shoreline at ${s.shoreLat.toFixed(5)}, ${s.shoreLon.toFixed(5)} (bearing out to sea ${s.bearing}), camera ${s.cameraAlt.toFixed(0)} m up: ${pts.length} points on screen; ` +
      `seabed under the water at ${bed.length} points 3-40 m deep: worst height error beyond 15 % of the depth ${bedWorst.toFixed(2)} m (errors ${bedErrors.map((e) => e.error.toFixed(1)).join(' ')}); ` +
      `refraction changes the image by ${(100 * refraction.shallow).toFixed(2)} % in the shallows (${shallow.length}), ${(100 * refraction.deep).toFixed(3)} % over deep water (${deep.length}), ${(100 * refraction.land).toFixed(3)} % on land (${land.length}); ` +
      `foam coverage ${foam.swash.toFixed(3)} on the waterline (${swash.length}), ${foam.offshore.toFixed(3)} offshore (${offshore.length})`,
  );
  record('a.shoreline', { loaded: info.loaded, shore: { lat: s.shoreLat, lon: s.shoreLon, bearing: s.bearing, cameraAlt: s.cameraAlt }, nearField: measured.nearField, bed: bedErrors, bedWorst, refraction, foam, points: pts });
  expect(bed.length, 'sample points with 3-40 m of water on screen').toBeGreaterThan(8);
  expect(bedWorst, 'height error of the opaque depth under the water against the real seabed, beyond 15 % of the depth (m)').toBeLessThan(1.5);
  expect(shallow.length).toBeGreaterThan(4);
  expect(refraction.shallow, 'refraction visibly moves the bottom in the shallows').toBeGreaterThan(0.005);
  expect(refraction.land, 'refraction does not touch the land').toBeLessThan(0.1 * refraction.shallow);
  if (deep.length > 0) expect(refraction.deep, 'refraction of an invisible bottom changes nothing').toBeLessThan(0.3 * refraction.shallow);
  expect(swash.length).toBeGreaterThan(2);
  // The swash is lace, not a white band: a tenth of the 5 x 5 pixel windows on the waterline is foam on
  // average, more than twice the whitecap cover of the open sea beside it.
  expect(foam.swash, 'foam on the waterline').toBeGreaterThan(0.08);
  expect(foam.swash).toBeGreaterThan(2 * foam.offshore);
  await expectClean(page, pageLog, info);
});

interface SeaCensus {
  altitude: number;
  /** Pixels at least a quarter of a degree below the sea horizon. */
  below: number;
  /** Of those: deferred water at sea level; water material below sea level; the terrain material; no geometry at all; anything else. */
  sheet: number;
  waterBelowSea: number;
  terrain: number;
  noGeometry: number;
  other: number;
  /** Pixels at least 20 % darker than both neighbours along a row or along a column (a thin dark line). */
  dark: number;
  /** Mean luminance of the sea, cd/m^2, and NaN pixels of the frame. */
  luminance: number;
  nan: number;
}

/** What the frame holds where the sea should be: G-buffer material and the altitude of the geometry behind each sea pixel. */
async function seaCensus(page: Page, at: Place, altitude: number, headingDeg: number, pitchDeg: number): Promise<SeaCensus> {
  await page.evaluate(([lat, lon, h, heading, pitch]) => window.__integration!.surface('earth', lat!, lon!, h!, heading!, pitch!), [at.latDeg, at.lonDeg, altitude, headingDeg, pitchDeg]);
  await settle(page, 12);
  return page.evaluate(
    async ([h, pitch, radius, waterId, near]) => {
      const lab = window.__integration!;
      const r = lab.app.renderer;
      const lit = await r.readHdrPixels('hdr');
      const stats = await r.readHdrStats('hdr');
      const depth = await r.readDepth();
      lab.showGBuffer('material');
      await window.__test!.waitFrames(6);
      const material = await r.readHdrPixels('hdr');
      lab.showGBuffer(null);
      await window.__test!.waitFrames(4);
      const W = lit.width;
      const H = lit.height;
      const f = H / 2 / Math.tan(lab.app.camera.settings.fovY / 2);
      const p = (-(pitch as number) * Math.PI) / 180;
      const rc = (radius as number) + (h as number);
      const horizon = Math.sqrt(1 - (radius * radius) / (rc * rc));
      const luma = (o: number): number => 0.2126 * lit.data[o]! + 0.7152 * lit.data[o + 1]! + 0.0722 * lit.data[o + 2]!;
      const c = { altitude: h as number, below: 0, sheet: 0, waterBelowSea: 0, terrain: 0, noGeometry: 0, other: 0, dark: 0, luminance: 0, nan: stats.nanPixels };
      for (let y = 1; y < H - 1; y++) {
        for (let x = 1; x < W - 1; x++) {
          const cx = x + 0.5 - W / 2;
          const cy = y + 0.5 - H / 2;
          const norm = Math.hypot(f, cx, cy);
          const sinDip = (f * Math.sin(p) + cy * Math.cos(p)) / norm;
          if (sinDip < horizon + 0.0045) continue;
          c.below++;
          const o = (y * W + x) * 4;
          const l = luma(o);
          c.luminance += l;
          if (l < 0.8 * Math.min(luma(o - 4), luma(o + 4)) || l < 0.8 * Math.min(luma(o - W * 4), luma(o + W * 4))) c.dark++;
          const d = depth.data[y * depth.width + x]!;
          const id = Math.round(material.data[o + 1]!);
          if (d <= 0) {
            c.noGeometry++;
            continue;
          }
          // Altitude of what the depth buffer holds on this pixel's ray.
          const range = (((near as number) / d) * norm) / f;
          const alt = Math.sqrt(rc * rc + range * range - 2 * rc * range * sinDip) - radius;
          if (id === waterId && alt > -30) c.sheet++;
          else if (id === waterId) c.waterBelowSea++;
          else if (id === 1) c.terrain++;
          else c.other++;
        }
      }
      c.luminance /= Math.max(1, c.below) * r.frameContext!.exposure;
      return c;
    },
    [altitude, pitchDeg, EARTH_RADIUS, WATER_ID, NEAR_PLANE] as const,
  );
}

const describeCensus = (c: SeaCensus): string =>
  `${c.altitude} m up: of ${c.below} sea pixels ${((100 * c.sheet) / c.below).toFixed(2)} % are the sheet at sea level, ${((100 * c.waterBelowSea) / c.below).toFixed(2)} % water material below sea level, ${((100 * c.terrain) / c.below).toFixed(2)} % seabed, ${((100 * c.noGeometry) / c.below).toFixed(2)} % no geometry, ${c.dark} thin dark pixels; ${c.luminance.toFixed(0)} cd/m^2`;

test('(a) without the ocean feature the terrain draws the whole sea itself', async ({ page, pageLog }) => {
  const views: [number, number, number][] = [
    [200, 300, -15],
    [3_000, 300, -30],
    [10_000, 120, -20],
    [14_232, 120, -20],
    [20_000, 300, -30],
  ];
  const query = (features: string): string => `${features}&scene=lowOrbit&paused=1&hud=0&ev=14&governor=off`;
  const run = async (): Promise<SeaCensus[]> => {
    await freeze(page);
    const at = await openOcean(page);
    const out: SeaCensus[] = [];
    for (const [altitude, heading, pitch] of views) out.push(await seaCensus(page, at, altitude, heading, pitch));
    return out;
  };

  // Every package but the ocean (and the ones that draw nothing here).
  const info = await openIntegration(page, query('features=all&without=vfx,vehicle,cockpit,ocean'));
  requireFeatures(test, info, ['terrain']);
  const alone = await run();
  await save(page, 'water-without-ocean-20km');
  const at = await openOcean(page);
  await page.evaluate(([lat, lon]) => window.__integration!.surface('earth', lat!, lon!, 200, 300, -15), [at.latDeg, at.lonDeg]);
  await settle(page, 12);
  await save(page, 'water-without-ocean-200m');
  await expectClean(page, pageLog, info);

  // The sheet by itself, without the atmosphere over it: thin lines along its tile edges show here.
  await openIntegration(page, query('features=terrain,sky'));
  const bare = await run();
  await page.evaluate(([lat, lon]) => window.__integration!.surface('earth', lat!, lon!, 14_232, 120, -20), [at.latDeg, at.lonDeg]);
  await settle(page, 12);
  await save(page, 'water-without-ocean-sheet-14km');

  // The same views with the ocean, for the comparison of what the sea looks like (when it is in the tree).
  const withOcean = await openIntegration(page, query('features=all&without=vfx,vehicle,cockpit'));
  const both = withOcean.loaded.includes('ocean') ? await run() : null;

  for (const c of alone) console.log(`(a) without the ocean [${info.loaded.join(', ')}], ${describeCensus(c)}`);
  for (const c of bare) console.log(`(a) terrain and sky alone, ${describeCensus(c)}`);
  if (both) for (const c of both) console.log(`(a) with the ocean, ${describeCensus(c)}`);
  record('a.withoutOcean', { loaded: info.loaded, at, alone, bare, withOcean: both });
  for (const c of [...alone, ...bare]) {
    expect(c.below).toBeGreaterThan(40_000);
    expect(c.sheet / c.below, `${c.altitude} m up: share of the sea that is the deferred sheet at sea level`).toBeGreaterThan(0.999);
    expect(c.noGeometry, `${c.altitude} m up: sea pixels with no geometry behind them`).toBe(0);
    expect(c.nan).toBe(0);
    expect(c.luminance, 'the sea is lit').toBeGreaterThan(50);
  }
  for (const c of bare) expect(c.dark, `${c.altitude} m up: thin dark pixels in the bare sheet (cracks along tile edges)`).toBeLessThan(4);
  if (both) {
    // Far beyond the near field both draw the same sheet; the ocean changes its shading model's inputs only.
    const ratio = alone[alone.length - 1]!.luminance / both[both.length - 1]!.luminance;
    expect(ratio, 'sea luminance from 20 km without the ocean feature against with it').toBeGreaterThan(0.5);
    expect(ratio).toBeLessThan(2);
  }
});
