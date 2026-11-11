/**
 * Check (b): transparents inside the real atmosphere and under the real cloud map (ARCHITECTURE 10.3).
 *
 *  - A launch under an overcast part of the cloud map: once the vehicle has climbed through the deck, its
 *    plume and trail are hidden from a camera on the ground. Measured as the difference between the frame
 *    with the vfx package drawing and the same frame without it (time frozen): nothing around the vehicle's
 *    position from below, a plain plume from a camera above the deck (the control: the effect is there and
 *    the comparison sees it).
 *  - A plume and trail 50 km away take aerial perspective. The same frozen launch, seen from the same
 *    camera 50 km away, in a page with the atmosphere and in a page without it: what the effect adds to the
 *    frame (with minus without vfx, summed over a window around the vehicle) must be smaller with the
 *    atmosphere by the transmittance of the air between the camera and the vehicle. (The plume is thousands
 *    of times brighter than the sky behind it, so the in-scatter in front of it does not count; the same
 *    camera in both pages keeps the effect's own level of detail out of the comparison.) The expected
 *    transmittance is integrated from the atmosphere definition, not taken from the renderer. The
 *    aerial-perspective volume of the render contract carries ONE transmittance per froxel ("a = mean
 *    transmittance"), so a transparent is dimmed alike in red, green and blue, by the mean of the three:
 *    that mean is what the test expects, and the missing reddening is recorded for the hand-off.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { expect, test } from '../harness';
import { airTransmittance, cloudClock, coverageBox, coverageMap, earthAtmosphere, expectClean, findSky, fixedToMapLon, freeze, mapToFixedLon, openIntegration, record, repoRoot, requireFeatures, save, type SkyBox } from './helpers';

test.describe.configure({ timeout: 20 * 60_000 });

const EARTH_RADIUS = (JSON.parse(fs.readFileSync(path.join(repoRoot, 'data', 'tiles', 'earth', 'manifest.json'), 'utf8')) as { radius: number }).radius;
const CLOUDS = JSON.parse(fs.readFileSync(path.join(repoRoot, 'data', 'defs', 'render', 'earth.clouds.json'), 'utf8')) as { topAltitude: number; params: { coverageDriftMps: number } };
const RAD = 180 / Math.PI;

/** Longitude offset (deg) of `metres` along a parallel. */
const eastDeg = (latDeg: number, metres: number): number => (metres / (EARTH_RADIUS * Math.cos(latDeg / RAD))) * RAD;

interface Launch {
  latDeg: number;
  lonDeg: number;
  box: SkyBox;
}

/**
 * Open the ascent scene under a part of the cloud map of the wanted kind. The map drifts with the
 * feature's cloud clock: a first, small page reports where that clock starts, the place is computed for
 * it, and the tests check it again with the clock of the page they run in.
 */
async function openLaunch(page: Page, kind: 'overcast' | 'clear', query: string): Promise<{ info: Awaited<ReturnType<typeof openIntegration>>; launch: Launch } | null> {
  const map = coverageMap();
  if (!map) return null;
  const boxes = findSky(map, kind, kind === 'overcast' ? 1.0 : 2.0, 50);
  const box = boxes[0];
  if (!box) return null;
  await openIntegration(page, 'features=atmosphere&scene=ascent&paused=1&hud=0');
  const start = await cloudClock(page);
  const launch: Launch = { latDeg: box.latDeg, lonDeg: mapToFixedLon(box.lonMapDeg, start.time ?? 0, start.drift ?? CLOUDS.params.coverageDriftMps, EARTH_RADIUS), box };
  const info = await openIntegration(page, `scene=ascent&at=${launch.latDeg},${launch.lonDeg}&throttle=1&hud=0&governor=off&sun=140,50&sunsite=earth,${launch.latDeg},${launch.lonDeg}&${query}`);
  return { info, launch };
}

/** With the vfx package drawing and without it: the frame's HDR pixels in a window around the image centre. */
async function withAndWithoutVfx(page: Page, half: number): Promise<{ sum: [number, number, number]; absolute: [number, number, number]; absSum: number; background: number; peak: number; noise: number; pixels: number }> {
  return page.evaluate(async (h) => {
    const lab = window.__integration!;
    const r = lab.app.renderer;
    const W = r.frameContext!.renderSize[0];
    const H = r.frameContext!.renderSize[1];
    const rect = { x: Math.round(W / 2 - h), y: Math.round(H / 2 - h), width: 2 * h, height: 2 * h };
    const read = async (): Promise<Float32Array> => {
      await window.__test!.waitFrames(24);
      return (await r.readHdrPixels('hdr', rect)).data;
    };
    const on = await read();
    const again = await read();
    lab.setEnabled('vfx', false);
    const off = await read();
    lab.setEnabled('vfx', true);
    await window.__test!.waitFrames(8);
    const luma = (d: Float32Array, o: number): number => 0.2126 * d[o]! + 0.7152 * d[o + 1]! + 0.0722 * d[o + 2]!;
    const sum: [number, number, number] = [0, 0, 0];
    let absSum = 0;
    let background = 0;
    let peak = 0;
    let noise = 0;
    const n = rect.width * rect.height;
    for (let i = 0; i < n; i++) {
      const o = i * 4;
      for (let c = 0; c < 3; c++) sum[c] = sum[c]! + (on[o + c]! - off[o + c]!);
      const d = Math.abs(luma(on, o) - luma(off, o));
      absSum += d;
      peak = Math.max(peak, d);
      background += luma(off, o);
      noise += Math.abs(luma(on, o) - luma(again, o));
    }
    // Everything relative to the mean luminance of the window without the effect.
    const mean = background / n || 1e-12;
    const exposure = r.frameContext!.exposure;
    // `absolute`: what the effect adds, summed over the window, in cd/m^2 x pixels.
    return { sum: [sum[0] / mean, sum[1] / mean, sum[2] / mean], absolute: [sum[0] / exposure, sum[1] / exposure, sum[2] / exposure], absSum: absSum / n / mean, background: mean / exposure, peak: peak / mean, noise: noise / n / mean, pixels: n };
  }, half);
}

const vfxStats = (page: Page): Promise<Record<string, number>> => page.evaluate(() => (window.__integration!.handles['vfx.createVfxFeature'] as { debug: { stats(): Record<string, number> } }).debug.stats());

test('(b) above an overcast deck of the real cloud map, plume and trail are hidden from the pad camera', async ({ page, pageLog }) => {
  const opened = await openLaunch(page, 'overcast', 'ev=13');
  test.skip(!opened, 'the Earth tile set has no cloud coverage map, or no overcast place in it');
  const { info, launch } = opened!;
  requireFeatures(test, info, ['atmosphere', 'vfx']);
  await freeze(page);
  // The vehicle starts 9 km up at 350 m/s: fly until it is well above the top of the cloud shell.
  const clearOfClouds = CLOUDS.topAltitude + 1500;
  await page.waitForFunction((h) => window.__lab!.snapshot().readouts.altitudeAsl > h, clearOfClouds, { timeout: 240_000, polling: 250 });
  await page.evaluate(() => window.__test!.setPaused(true));
  const clock = await cloudClock(page);
  expect(clock.time, 'the atmosphere feature has a cloud system for the Earth').not.toBeNull();
  const column = coverageBox(coverageMap()!, launch.latDeg, fixedToMapLon(launch.lonDeg, clock.time!, clock.drift!, EARTH_RADIUS), 0.3);
  expect(column.min, 'coverage of the map over the launch point as the feature reads it now').toBeGreaterThan(0.9);
  const altitude = await page.evaluate(() => window.__lab!.snapshot().readouts.altitudeAsl);
  const stats = await vfxStats(page);

  // The pad camera: on the ground 3 km east of the launch point, looking at the vehicle.
  const ground = await page.evaluate(([lat, lon]) => window.__integration!.groundHeight('earth', lat!, lon!), [launch.latDeg, launch.lonDeg + eastDeg(launch.latDeg, 3000)]);
  await page.evaluate(([lat, lon, alt]) => window.__integration!.watchVesselFrom({ bodyId: 'earth', latDeg: lat!, lonDeg: lon!, alt: alt! }), [launch.latDeg, launch.lonDeg + eastDeg(launch.latDeg, 3000), Math.max(ground, 0) + 30]);
  const below = await withAndWithoutVfx(page, 240);
  await save(page, 'clouds-plume-from-the-pad-under-the-deck');
  // The control: level with the vehicle, 4 km away, above the deck.
  await page.evaluate(([lat, lon, alt]) => window.__integration!.watchVesselFrom({ bodyId: 'earth', latDeg: lat!, lonDeg: lon!, alt: alt! }), [launch.latDeg, launch.lonDeg + eastDeg(launch.latDeg, 4000), altitude]);
  const above = await withAndWithoutVfx(page, 240);
  await save(page, 'clouds-plume-from-above-the-deck');

  console.log(
    `(b) overcast launch at ${launch.latDeg}, ${launch.lonDeg.toFixed(2)} (map coverage ${column.min.toFixed(2)}-${column.max.toFixed(2)}, tops ${(column.topM / 1000).toFixed(1)} km), vehicle ${(altitude / 1000).toFixed(1)} km up, ` +
      `${stats['plumeInstances']} plume instance(s), ${stats['trailSegments']} trail segment(s). With minus without vfx, relative to the window's mean luminance: ` +
      `from the pad ${(100 * below.absSum).toFixed(4)} % (peak pixel ${(100 * below.peak).toFixed(3)} %, repeat noise ${(100 * below.noise).toFixed(4)} %), background ${below.background.toFixed(0)} cd/m^2; ` +
      `from above the deck ${(100 * above.absSum).toFixed(3)} % (peak pixel ${(100 * above.peak).toFixed(0)} %)`,
  );
  record('b.hiddenByDeck', { loaded: info.loaded, launch, column, altitude, stats, below, above });
  expect(stats['plumeInstances'], 'the engines burn').toBeGreaterThan(0);
  expect(stats['trailSegments'], 'the vehicle leaves a trail').toBeGreaterThan(0);
  // The effect is there and plain from above ...
  expect(above.peak, 'brightest pixel of the effect from above the deck, in units of the mean luminance').toBeGreaterThan(0.5);
  expect(above.absSum).toBeGreaterThan(20 * Math.max(below.absSum, 1e-6));
  // ... and gone from below: no pixel changes by 1 % of the deck's luminance, beyond the repeat noise of the frame.
  expect(below.peak, 'largest change any pixel shows from the pad, in units of the mean luminance').toBeLessThan(0.01 + 4 * below.noise);
  expect(below.absSum).toBeLessThan(0.001 + 2 * below.noise);
  await expectClean(page, pageLog, info);
});

test('(b) a plume and trail 50 km away take aerial perspective: their light falls by the transmittance of the air in between', async ({ page, pageLog }) => {
  const map = coverageMap();
  test.skip(!map, 'the Earth tile set has no cloud coverage map');
  const box = findSky(map!, 'clear', 2.0, 50)[0];
  test.skip(!box, 'no clear place in the cloud map');
  await openIntegration(page, 'features=atmosphere&scene=ascent&paused=1&hud=0');
  const start = await cloudClock(page);
  const launch: Launch = { latDeg: box!.latDeg, lonDeg: mapToFixedLon(box!.lonMapDeg, start.time ?? 0, start.drift ?? CLOUDS.params.coverageDriftMps, EARTH_RADIUS), box: box! };
  // The far camera: 50 km east at 4 km (above the fair-weather cumulus the clear parts of the map carry),
  // 2 degrees of field (the vehicle and its plume fill the middle of the frame).
  const site = { bodyId: 'earth', latDeg: launch.latDeg, lonDeg: launch.lonDeg + eastDeg(launch.latDeg, 50_000), alt: 4000 };
  const view = async (without: string): Promise<{ info: Awaited<ReturnType<typeof openIntegration>>; stats: Record<string, number>; altitude: number; camera: [number, number, number]; vessel: [number, number, number]; diff: Awaited<ReturnType<typeof withAndWithoutVfx>> }> => {
    // Frozen from the first frame; then exactly 300 steps of 1/60 s with the engines burning (9 km -> 10.75 km).
    const info = await openIntegration(page, `scene=ascent&at=${launch.latDeg},${launch.lonDeg}&throttle=1&paused=1&deterministic=1&hud=0&governor=off&ev=13&fov=2&sun=140,50&sunsite=earth,${launch.latDeg},${launch.lonDeg}${without}`);
    await freeze(page);
    const placed = await page.evaluate(async (s) => {
      const lab = window.__integration!;
      lab.app.setLoop(false);
      lab.app.setPaused(false);
      for (let i = 0; i < 300; i++) lab.app.renderFrame();
      lab.app.setPaused(true);
      lab.watchVesselFrom(s);
      lab.app.setLoop(true);
      await window.__test!.waitFrames(8);
      const snap = lab.app.snapshot();
      const c = lab.app.cameraState().positionRoot;
      const b = snap.bodies.find((x) => x.id === 'earth')!.rRoot;
      const v = snap.vessels.find((x) => x.id === snap.activeVesselId)!.rRoot;
      return { altitude: snap.readouts.altitudeAsl, camera: [c.x - b.x, c.y - b.y, c.z - b.z] as [number, number, number], vessel: [v.x - b.x, v.y - b.y, v.z - b.z] as [number, number, number] };
    }, site);
    const stats = info.loaded.includes('vfx') ? await vfxStats(page) : {};
    return { info, stats, ...placed, diff: info.loaded.includes('vfx') ? await withAndWithoutVfx(page, 150) : ({} as Awaited<ReturnType<typeof withAndWithoutVfx>>) };
  };

  const air = await view('');
  requireFeatures(test, air.info, ['atmosphere', 'vfx']);
  const clock = await cloudClock(page);
  const column = coverageBox(map!, launch.latDeg, fixedToMapLon(launch.lonDeg, clock.time!, clock.drift!, EARTH_RADIUS), 1.0);
  expect(column.max, 'coverage of the map around the launch point as the feature reads it now').toBeLessThan(0.1);
  await save(page, 'clouds-plume-50km');
  await expectClean(page, pageLog, air.info);
  const vacuum = await view('&without=atmosphere');
  await save(page, 'clouds-plume-50km-no-atmosphere');
  expect(Math.abs(vacuum.altitude - air.altitude), 'the two pages froze the same launch (m)').toBeLessThan(1);

  const expected = airTransmittance(earthAtmosphere(), EARTH_RADIUS, air.camera, air.vessel);
  // The mean of the three transmittances, between the plain and the luminance-weighted one.
  const mean = 0.5 * ((expected[0] + expected[1] + expected[2]) / 3 + 0.2126 * expected[0] + 0.7152 * expected[1] + 0.0722 * expected[2]);
  const ratio = [0, 1, 2].map((c) => air.diff.absolute[c]! / vacuum.diff.absolute[c]!) as [number, number, number];
  const distance = Math.hypot(air.camera[0] - air.vessel[0], air.camera[1] - air.vessel[1], air.camera[2] - air.vessel[2]);
  console.log(
    `(b) clear launch at ${launch.latDeg}, ${launch.lonDeg.toFixed(2)} (map coverage up to ${column.max.toFixed(2)}), vehicle ${(air.altitude / 1000).toFixed(2)} km up, ${air.stats['plumeInstances']} plume instance(s), ${air.stats['trailSegments']} trail segment(s), camera ${(distance / 1000).toFixed(1)} km away at 4 km. ` +
      `What the effect adds (r, g, b), with the atmosphere / without: ${ratio.map((v) => v.toFixed(3)).join(', ')}; transmittance of the air in between from the definitions: ${expected.map((v) => v.toFixed(3)).join(', ')}, mean ${mean.toFixed(3)} ` +
      `(the effect: ${air.diff.absolute.map((v) => v.toExponential(2)).join(', ')} against ${vacuum.diff.absolute.map((v) => v.toExponential(2)).join(', ')} cd/m^2 x pixels; brightest pixel ${(100 * air.diff.peak).toFixed(0)} % of the sky behind it)`,
  );
  record('b.aerialPerspective', { loaded: air.info.loaded, launch, stats: air.stats, altitude: air.altitude, distance, air: air.diff, vacuum: vacuum.diff, ratio, expected, mean });
  expect(air.stats['plumeInstances']).toBeGreaterThan(0);
  expect(air.diff.peak, 'the plume is far brighter than the sky behind it').toBeGreaterThan(20);
  // Without aerial perspective the ratio is 1 in every colour. With it: the mean transmittance of the air.
  for (let c = 0; c < 3; c++) expect(Math.abs(ratio[c]! - mean), `with / without the atmosphere of what the effect adds, channel ${'rgb'[c]}: ${ratio[c]!.toFixed(3)} against the air's mean transmittance ${mean.toFixed(3)}`).toBeLessThan(0.06);
  expect(Math.max(...ratio), 'the effect is dimmed by the air').toBeLessThan(0.9);
});
