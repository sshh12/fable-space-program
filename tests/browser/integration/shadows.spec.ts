/**
 * Check (c): sun shadows of the real terrain at every distance (ARCHITECTURE 10.1).
 *
 *  - The lunar terminator from 20,000 km and 5,000 km shows crater shadows: the same frame with and without
 *    the terrain casting (`noshadow=terrain`); with the shadows, lit ground near the terminator goes dark.
 *  - The approach through 1,500 km (where the body-fitted cascade hands over to the camera-fitted ones) has
 *    no pop: the camera descends straight down by a constant factor per step while the field of view widens
 *    to keep the same ground in the frame, so the picture barely changes and a hand-over that is not
 *    continuous is one step far above its neighbours. The frame is the one the game's camera (60 degrees)
 *    sees at 1,500 km: a narrower one magnifies the cascades' texels (1.9 km and 1.5 km) to several pixels
 *    and reports the two texel grids as a jump that the game's camera cannot resolve.
 *  - On the pad, with the Earth turning under the cascades, and on a pass in a 100 km lunar orbit, shadow
 *    edges neither crawl nor jump: frame differences of consecutive frames (fixed time step, no jitter)
 *    stay bounded, without spikes and without a period-2, -4 or -8 pattern (the staggered cascades are
 *    re-rendered every 2nd, 4th or 8th frame).
 *  - At the landing site under an 8 degree sun the lander's shadow lies on the baked ground where the sun
 *    puts it (the ground 20 m down-sun is dark, the ground beside the lander is not), and the views the
 *    descent shows towards the sun from 60 m, 600 m and 5 km are saved for review.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { expect, test } from '../harness';
import { expectClean, frameDiff, freeze, grab, openIntegration, periodStrength, record, repoRoot, requireFeatures, save, settle, spikes, type Shot } from './helpers';

test.describe.configure({ timeout: 30 * 60_000 });

const MOON_RADIUS = (JSON.parse(fs.readFileSync(path.join(repoRoot, 'data', 'tiles', 'moon', 'manifest.json'), 'utf8')) as { radius: number }).radius;
const SITE = JSON.parse(fs.readFileSync(path.join(repoRoot, 'data', 'defs', 'sites', 'ka-lae.location.json'), 'utf8')) as { latDeg: number; lonDeg: number };

interface Luma {
  width: number;
  height: number;
  data: number[];
}

/** Luminance of the scene target (pre-exposed), every pixel. */
const readLuma = (page: Page): Promise<Luma> =>
  page.evaluate(async () => {
    const px = await window.__lab!.renderer.readHdrPixels('hdr');
    const out = new Array<number>(px.width * px.height);
    for (let i = 0; i < out.length; i++) out[i] = 0.2126 * px.data[i * 4]! + 0.7152 * px.data[i * 4 + 1]! + 0.0722 * px.data[i * 4 + 2]!;
    return { width: px.width, height: px.height, data: out };
  });

for (const view of [
  { km: 20_000, fovDeg: 13 },
  { km: 5_000, fovDeg: 40 },
]) {
  test(`(c) the lunar terminator from ${view.km} km shows crater shadows`, async ({ page, pageLog }) => {
    const query = (extra: string): string => `features=terrain,sky&scene=lunarOrbit&paused=1&hud=0&ev=13.5&governor=off&fov=${view.fovDeg}${extra}`;
    const look = async (): Promise<Luma> => {
      await freeze(page);
      // Half phase: the terminator runs through the middle of the disc. Distance from the surface.
      await page.evaluate(([d]) => window.__integration!.viewBodyAtPhase('moon', 90, d!), [MOON_RADIUS + view.km * 1000]);
      await settle(page, 24);
      return readLuma(page);
    };
    const info = await openIntegration(page, query('&probe=casters'));
    requireFeatures(test, info, ['terrain']);
    const shadowed = await look();
    const cascades = await page.evaluate(() => {
      const log = window.__integration!.cascadeLog();
      const last = log.length > 0 ? log[log.length - 1]!.frame : -1;
      return log.filter((c) => c.frame >= last - 8).map((c) => `${c.index}:${c.fit}:${c.anchor}:${c.texelSize.toFixed(0)} m`);
    });
    await save(page, `shadows-terminator-${view.km}km`);
    await expectClean(page, pageLog, info);

    await openIntegration(page, query('&noshadow=terrain'));
    const plain = await look();
    await save(page, `shadows-terminator-${view.km}km-no-terrain-shadows`);

    // Ground that is lit without the terrain's shadows and dark with them.
    const sorted = [...plain.data].filter((v) => v > 0).sort((a, b) => a - b);
    const bright = sorted[Math.floor(sorted.length * 0.9)] ?? 0;
    let lit = 0;
    let dark = 0;
    let brighter = 0;
    const columns: number[] = [];
    for (let i = 0; i < plain.data.length; i++) {
      const p = plain.data[i]!;
      if (p < 0.05 * bright) continue;
      lit++;
      const s = shadowed.data[i]!;
      if (s < 0.5 * p) {
        dark++;
        columns.push(i % plain.width);
      }
      if (s > 1.1 * p + 0.01 * bright) brighter++;
    }
    // Where they are: distance from the terminator (the vertical line through the disc centre), in disc radii.
    const discRadius = (plain.height / 2 / Math.tan((view.fovDeg * Math.PI) / 360)) * (MOON_RADIUS / (MOON_RADIUS + view.km * 1000));
    columns.sort((a, b) => a - b);
    const offsets = columns.map((x) => Math.abs(x + 0.5 - plain.width / 2) / discRadius).sort((a, b) => a - b);
    const median = offsets[offsets.length >> 1] ?? 0;
    console.log(`(c) terminator from ${view.km} km (fov ${view.fovDeg} deg, disc radius ${discRadius.toFixed(0)} px): ${dark} of ${lit} lit pixels are in a terrain shadow (${((100 * dark) / Math.max(1, lit)).toFixed(2)} %), median distance from the terminator ${median.toFixed(2)} disc radii; ${brighter} pixels brighter with shadows; cascades ${[...new Set(cascades)].join(', ')}`);
    record(`c.terminator.${view.km}km`, { loaded: info.loaded, lit, dark, brighter, medianOffset: median, discRadius, cascades: [...new Set(cascades)] });
    expect(lit).toBeGreaterThan(5_000);
    // Without casters that hold the relief this share was 0.01-0.02 % (a lit peak or two beyond the
    // terminator); with craters of 20 km and more in the body cascade it is 0.3-0.5 %.
    expect(dark, 'lit pixels that the terrain shadows').toBeGreaterThan(Math.max(150, 0.002 * lit));
    expect(median, 'the shadows lie along the terminator').toBeLessThan(0.4);
    expect(brighter / lit, 'shadows only darken').toBeLessThan(0.002);
  });
}

test('(c) the approach to the Moon through 1,500 km has no shadow pop', async ({ page, pageLog }) => {
  const info = await openIntegration(page, 'features=terrain,sky&scene=lunarOrbit&paused=1&hud=0&ev=13&governor=off&probe=casters');
  requireFeatures(test, info, ['terrain']);
  await freeze(page);
  // A point of the nearside highlands with the sun 8 degrees up: long shadows over the whole frame.
  const at = { latDeg: -32, lonDeg: 12 };
  await page.evaluate(([lat, lon]) => window.__integration!.setSun({ bodyId: 'moon', latDeg: lat!, lonDeg: lon!, alt: 0 }, 95, 8), [at.latDeg, at.lonDeg]);
  const altitudes: number[] = [];
  for (let h = 3_000e3; h > 800e3; h *= 0.985) altitudes.push(h);
  // The frame keeps the ground half-height a 60 degree camera has at 1,500 km (866 km).
  const HALF = 1500e3 * Math.tan(Math.PI / 6);
  const mean: number[] = [];
  const block: number[] = [];
  const fits: string[] = [];
  let prev: Shot | null = null;
  for (const h of altitudes) {
    await page.evaluate(
      ([lat, lon, alt, half]) => {
        const lab = window.__integration!;
        lab.app.camera.settings.fovY = 2 * Math.atan(half! / alt!);
        lab.surface('moon', lat!, lon!, alt!, 0, -90);
        lab.clearCascadeLog();
      },
      [at.latDeg, at.lonDeg, h, HALF],
    );
    await settle(page, 10);
    fits.push(await page.evaluate(() => [...new Set(window.__integration!.cascadeLog().map((c) => `${c.index}:${c.fit}`))].sort().join(' ')));
    const shot = await grab(page);
    if (prev) {
      const d = frameDiff(prev, shot);
      mean.push(d.mean);
      block.push(d.blockMax);
    }
    prev = shot;
    if (Math.abs(h - 1_500e3) < 12e3 || h === altitudes[0] || h === altitudes[altitudes.length - 1]) await save(page, `shadows-approach-${Math.round(h / 1000)}km`);
  }
  const meanSpikes = spikes(mean, 3, 1.0);
  const blockSpikes = spikes(block, 3, 16);
  const changes = fits.map((f, i) => (i > 0 && f !== fits[i - 1] ? `${Math.round(altitudes[i]! / 1000)} km: ${fits[i - 1]} -> ${f}` : '')).filter(Boolean);
  const describe = (list: { index: number; value: number; neighbours: number }[]): string => list.map((s) => `${Math.round(altitudes[s.index + 1]! / 1000)} km: ${s.value.toFixed(2)} (around it ${s.neighbours.toFixed(2)})`).join('; ');
  console.log(`(c) approach 3,000 -> 800 km in ${altitudes.length} steps: frame difference mean ${Math.min(...mean).toFixed(2)} .. ${Math.max(...mean).toFixed(2)}, worst block ${Math.max(...block).toFixed(1)}; spikes: mean [${describe(meanSpikes)}] block [${describe(blockSpikes)}]; cascade sets change at ${changes.join('; ') || 'no step'}`);
  record('c.approach', { loaded: info.loaded, at, altitudes, mean, block, meanSpikes, blockSpikes, cascadeChanges: changes });
  expect(meanSpikes, 'steps of the approach where the frame jumps').toEqual([]);
  expect(blockSpikes, 'steps of the approach where a part of the frame jumps').toEqual([]);
  await expectClean(page, pageLog, info);
});

interface Series {
  /** Mean absolute luminance change between consecutive frames, relative to the frame's mean luminance. */
  mean: number[];
  /** Largest such change over 16 x 16 pixel blocks. */
  block: number[];
  cascades: string[];
}

/**
 * Step `frames` frames at the fixed time step and compare each resolved image with the one before, on the
 * pixels that hold geometry in both (the sky, the sun's disc and the stars are not shadow edges).
 */
async function consecutiveFrames(page: Page, frames: number): Promise<Series> {
  return page.evaluate(async (n) => {
    const lab = window.__integration!;
    const r = lab.app.renderer;
    lab.app.setLoop(false);
    lab.clearCascadeLog();
    const mean: number[] = [];
    const block: number[] = [];
    let prev: Float32Array | null = null;
    let prevDepth: Float32Array | null = null;
    let W = 0;
    let H = 0;
    for (let i = 0; i <= n; i++) {
      lab.app.renderFrame();
      const px = await r.readHdrPixels('resolved');
      const depth = (await r.readDepth()).data;
      W = px.width;
      H = px.height;
      const luma = new Float32Array(W * H);
      for (let k = 0; k < luma.length; k++) luma[k] = 0.2126 * px.data[k * 4]! + 0.7152 * px.data[k * 4 + 1]! + 0.0722 * px.data[k * 4 + 2]!;
      if (prev && prevDepth) {
        const B = 16;
        const bw = Math.ceil(W / B);
        const sums = new Float64Array(bw * Math.ceil(H / B));
        let sum = 0;
        let total = 0;
        let count = 0;
        for (let y = 0; y < H; y++) {
          for (let x = 0; x < W; x++) {
            const k = y * W + x;
            if (depth[k]! <= 0 || prevDepth[k]! <= 0) continue;
            const d = Math.abs(luma[k]! - prev[k]!);
            sum += d;
            total += luma[k]!;
            count++;
            const b = Math.floor(y / B) * bw + Math.floor(x / B);
            sums[b] = sums[b]! + d;
          }
        }
        const level = total / Math.max(1, count) || 1e-12;
        mean.push(sum / Math.max(1, count) / level);
        block.push(Math.max(...sums) / (B * B) / level);
      }
      prev = luma;
      prevDepth = depth;
    }
    lab.app.setLoop(true);
    const cascades = [...new Set(lab.cascadeLog().map((c) => `${c.index}:${c.fit}:${c.everyFrame ? 'every frame' : 'staggered'}:${c.texelSize.toFixed(2)} m`))].sort();
    return { mean, block, cascades };
  }, frames);
}

/** Period-2, -4 and -8 strength of a series, counted only when the series varies visibly at all. */
function periods(series: number[], visible: number): { k: number; strength: number }[] {
  const spread = Math.max(...series) - Math.min(...series);
  return [2, 4, 8].map((k) => ({ k, strength: spread > visible ? periodStrength(series, k) : 0 }));
}

function judge(name: string, s: Series, bounds: { mean: number; block: number; spikesBelongToSomethingElse?: boolean }): void {
  const meanSpikes = spikes(s.mean, 4, bounds.mean / 4);
  const blockSpikes = spikes(s.block, 4, bounds.block / 4);
  const pMean = periods(s.mean, bounds.mean / 20);
  const pBlock = periods(s.block, bounds.block / 20);
  console.log(
    `(c) ${name}: ${s.mean.length} consecutive frames; change per frame, relative to the mean luminance: whole frame ${(100 * Math.min(...s.mean)).toFixed(4)} .. ${(100 * Math.max(...s.mean)).toFixed(4)} %, worst 16 px block ${(100 * Math.max(...s.block)).toFixed(3)} %; ` +
      `period strength (2, 4, 8): frame ${pMean.map((p) => p.strength.toFixed(2)).join(', ')}, block ${pBlock.map((p) => p.strength.toFixed(2)).join(', ')}; spikes ${meanSpikes.length} + ${blockSpikes.length}; cascades ${s.cascades.join(' | ')}`,
  );
  record(`c.stability.${name}`, { ...s, meanSpikes, blockSpikes, periodsMean: pMean, periodsBlock: pBlock, bounds });
  expect(Math.max(...s.mean), `${name}: largest change of the whole frame between two frames`).toBeLessThan(bounds.mean);
  expect(Math.max(...s.block), `${name}: largest change of a 16 px block between two frames`).toBeLessThan(bounds.block);
  if (!bounds.spikesBelongToSomethingElse) {
    expect(meanSpikes, `${name}: frames that jump`).toEqual([]);
    expect(blockSpikes, `${name}: frames where a block jumps`).toEqual([]);
  }
  for (const p of [...pMean, ...pBlock]) expect(p.strength, `${name}: share of the frame-to-frame variation that repeats every ${p.k} frames`).toBeLessThan(0.5);
}

/** The pad from 250 m to the south-east, 25 m up, the low sun behind the camera: `frames` consecutive frames. */
async function padSeries(page: Page, query: string, needs: readonly ('terrain' | 'vehicle')[], shot: string | null): Promise<{ info: Awaited<ReturnType<typeof openIntegration>>; series: Series }> {
  const info = await openIntegration(page, `${query}&scene=pad&hud=0&ev=13&governor=off&probe=casters&sun=105,9&sunsite=earth,${SITE.latDeg},${SITE.lonDeg}`);
  requireFeatures(test, info, needs);
  await freeze(page);
  await page.evaluate(([lat, lon]) => window.__integration!.aboveGround('earth', lat!, lon!, 25, 315, -8), [SITE.latDeg - 0.0016, SITE.lonDeg + 0.0017]);
  await settle(page, 40);
  if (shot) await save(page, shot);
  return { info, series: await consecutiveFrames(page, 64) };
}

test('(c) on the pad with the Earth turning, shadow edges neither crawl nor jump (the ground alone)', async ({ page, pageLog }) => {
  // Long shadows of the relief and the rocks run away from the eye across the whole frame.
  const { info, series } = await padSeries(page, 'features=terrain,sky', ['terrain'], 'shadows-pad-low-sun');
  // Nothing in the frame moves against the ground: the picture is still to within two thousandths, and no
  // 16 px block changes by more than a twentieth of the frame's mean luminance.
  judge('pad', series, { mean: 0.002, block: 0.05 });
  await expectClean(page, pageLog, info);
});

test('(c) on the pad with the Earth turning, the shadows of the site and the vehicle neither crawl nor jump', async ({ page, pageLog }) => {
  // The lattice towers are thinner than a pixel from here and, without the jitter of the temporal
  // anti-aliasing (off for frame comparisons), shimmer by themselves as the ground turns. So the same frames
  // are measured with the site and the vehicle casting no shadow, and what their shadows may add is bounded.
  const plain = await padSeries(page, 'features=terrain,vehicle,sky&noshadow=vehicle', ['terrain', 'vehicle'], null);
  const { info, series } = await padSeries(page, 'features=terrain,vehicle,sky', ['terrain', 'vehicle'], 'shadows-pad-with-the-site-low-sun');
  const worst = (x: number[]): number => Math.max(...x);
  console.log(`(c) pad with the site and the vehicle, their shadows off: whole frame up to ${(100 * worst(plain.series.mean)).toFixed(4)} %, worst block ${(100 * worst(plain.series.block)).toFixed(2)} % per frame`);
  // (Single frames in which a lattice member flips a pixel stand out of the series with and without the
  // shadows alike: the bound against the frames without shadows is the test here, not the spike count.)
  judge('pad with the site and the vehicle', series, { mean: 1.5 * worst(plain.series.mean) + 0.0005, block: 1.5 * worst(plain.series.block) + 0.02, spikesBelongToSomethingElse: true });
  await expectClean(page, pageLog, info);
});

test('(c) on a pass in a 100 km lunar orbit, shadow edges neither crawl nor jump', async ({ page, pageLog }) => {
  const info = await openIntegration(page, 'features=terrain,sky&scene=lunarOrbit&hud=0&ev=13&governor=off&probe=casters&fov=20');
  requireFeatures(test, info, ['terrain']);
  await freeze(page);
  // A ground point 20 km ahead of the vessel on its track, with the sun 10 degrees up there.
  const target = await page.evaluate(() => {
    const lab = window.__integration!;
    const s = lab.app.snapshot();
    const v = s.vessels.find((x) => x.id === s.activeVesselId)!;
    const b = s.bodies.find((x) => x.id === v.bodyId)!;
    const radius = lab.app.defs.bodies[b.id]!.radius;
    const up = Math.hypot(v.r.x, v.r.y, v.r.z);
    const speed = Math.hypot(v.v.x, v.v.y, v.v.z);
    // Sub-vessel direction turned 20 km along the velocity, in ROOT axes, then into the body frame.
    const a = 20e3 / radius;
    const dirRoot = { x: (v.r.x / up) * Math.cos(a) + (v.v.x / speed) * Math.sin(a), y: (v.r.y / up) * Math.cos(a) + (v.v.y / speed) * Math.sin(a), z: (v.r.z / up) * Math.cos(a) + (v.v.z / speed) * Math.sin(a) };
    const q = b.qFixedToRoot;
    // Rotate by the conjugate quaternion (ROOT -> body-fixed).
    const ix = -q.x;
    const iy = -q.y;
    const iz = -q.z;
    const tx = 2 * (iy * dirRoot.z - iz * dirRoot.y);
    const ty = 2 * (iz * dirRoot.x - ix * dirRoot.z);
    const tz = 2 * (ix * dirRoot.y - iy * dirRoot.x);
    const f = { x: dirRoot.x + q.w * tx + (iy * tz - iz * ty), y: dirRoot.y + q.w * ty + (iz * tx - ix * tz), z: dirRoot.z + q.w * tz + (ix * ty - iy * tx) };
    const site = { bodyId: b.id, latDeg: (Math.asin(f.z / Math.hypot(f.x, f.y, f.z)) * 180) / Math.PI, lonDeg: (Math.atan2(f.y, f.x) * 180) / Math.PI, alt: 0 };
    lab.setSun(site, 100, 10);
    lab.watchSiteFromVessel(site, 40);
    return site;
  });
  await settle(page, 40);
  await save(page, 'shadows-lunar-orbit-pass');
  const s = await consecutiveFrames(page, 96);
  // The vessel moves 27 m per frame, 100 km up: the ground point stays centred and the frame turns slowly.
  judge('lunar orbit pass', s, { mean: 0.02, block: 0.25 });
  record('c.stability.lunar orbit target', target);
  await expectClean(page, pageLog, info);
});

test('(c) at the landing site under a low sun the lander casts its shadow on the real ground, and the craters theirs', async ({ page, pageLog }) => {
  // The lander standing on the baked terrain at the scenario's landing target, the sun 8 degrees up in the
  // east-south-east (the mission lands at 7 to 32 degrees): the cascades hold a moving caster and the relief.
  const landing = (JSON.parse(fs.readFileSync(path.join(repoRoot, 'data', 'defs', 'scenarios', 'lunar-direct.json'), 'utf8')) as { suggestedLanding: { bodyId: string; latDeg: number; lonDeg: number } }).suggestedLanding;
  const SUN_AZ = 100;
  const SUN_EL = 8;
  const info = await openIntegration(page, `scene=lunarSurface&hud=0&ev=12&governor=off&probe=casters&sun=${SUN_AZ},${SUN_EL}&sunsite=${landing.bodyId},${landing.latDeg},${landing.lonDeg}&orbit=40,12,45`);
  requireFeatures(test, info, ['terrain', 'vehicle']);
  await freeze(page);
  await settle(page, 60);
  await save(page, 'shadows-landing-site-low-sun');
  // The landed lander stands on its deployed legs, its foot pads on the ground (request vehicle-pad-5).
  const stand = await page.evaluate(() => {
    const s = window.__integration!.app.snapshot();
    const v = s.vessels.find((x) => x.id === s.activeVesselId)!;
    const legs = v.parts.flatMap((p) => p.modules).filter((m) => m.type === 'legs') as { deploy: number }[];
    return { deploy: legs.map((m) => m.deploy), radar: s.readouts.altitudeRadar };
  });
  console.log(`(c) landing site: legs deployed ${stand.deploy.join(', ')}, radar altitude of the lowest point ${stand.radar.toFixed(3)} m`);
  expect(stand.deploy.length, 'legs modules on the lander').toBeGreaterThan(0);
  for (const d of stand.deploy) expect(d).toBe(1);
  expect(Math.abs(stand.radar)).toBeLessThan(0.05);
  // Ground points 20 m from the lander: down-sun (in its shadow, which is 60 m long at this elevation) and
  // across the sun line on either side (in the sun).
  const offset = (bearingDeg: number, metres: number): { latDeg: number; lonDeg: number } => ({
    latDeg: landing.latDeg + ((metres * Math.cos((bearingDeg * Math.PI) / 180)) / MOON_RADIUS) * (180 / Math.PI),
    lonDeg: landing.lonDeg + ((metres * Math.sin((bearingDeg * Math.PI) / 180)) / (MOON_RADIUS * Math.cos((landing.latDeg * Math.PI) / 180))) * (180 / Math.PI),
  });
  const sample = async (bearingDeg: number): Promise<number | null> =>
    page.evaluate(
      async ([lat, lon, body]) => {
        const lab = window.__integration!;
        const ground = await lab.groundHeight(body as string, lat as number, lon as number);
        const p = lab.project(body as string, lat as number, lon as number, ground + 0.05);
        const [W, H] = lab.app.renderer.frameContext!.renderSize;
        if (!p || p.x < 4 || p.y < 4 || p.x > W - 5 || p.y > H - 5) return null;
        const px = await lab.app.renderer.readHdrPixels('hdr', { x: Math.round(p.x) - 2, y: Math.round(p.y) - 2, width: 5, height: 5 });
        let sum = 0;
        for (let i = 0; i < 25; i++) sum += 0.2126 * px.data[i * 4]! + 0.7152 * px.data[i * 4 + 1]! + 0.0722 * px.data[i * 4 + 2]!;
        return sum / 25 / lab.app.renderer.frameContext!.exposure;
      },
      [offset(bearingDeg, 20).latDeg, offset(bearingDeg, 20).lonDeg, landing.bodyId] as const,
    );
  const shadow = await sample(SUN_AZ + 180);
  const sunlit = [await sample(SUN_AZ + 90), await sample(SUN_AZ - 90)].filter((v): v is number => v !== null);
  expect(shadow, 'the point 20 m down-sun of the lander is in the picture').not.toBeNull();
  expect(sunlit.length, 'points beside the lander are in the picture').toBeGreaterThan(0);
  const lit = Math.max(...sunlit);
  // The same ground from 60 m and 600 m up, looking towards the sun: the pictures the descent shows.
  const cascades: string[] = [];
  for (const [height, pitch, name] of [[60, -25, '60m'], [600, -30, '600m'], [5000, -20, '5km']] as const) {
    await page.evaluate(([lat, lon, h, p]) => window.__integration!.aboveGround('moon', lat!, lon! - 0.002, h!, 80, p!), [landing.latDeg, landing.lonDeg, height, pitch]);
    await settle(page, 60);
    cascades.push(`${name}: ${await page.evaluate(() => {
      const lab = window.__integration!;
      const list = [...new Set(lab.cascadeLog().map((c) => `${c.index}:${c.fit}:${c.texelSize.toFixed(2)} m`))].sort().join(' | ');
      lab.clearCascadeLog();
      return list;
    })}`);
    await save(page, `shadows-landing-site-low-sun-${name}`);
  }
  console.log(`(c) landing site, sun ${SUN_EL} deg up: ground 20 m down-sun of the lander ${shadow!.toFixed(1)} cd/m^2, beside it ${sunlit.map((v) => v.toFixed(0)).join(' / ')} cd/m^2 (${(100 * (shadow! / lit)).toFixed(1)} %); cascades ${cascades.join('; ')}`);
  record('c.landingSite', { loaded: info.loaded, landing, sunElevationDeg: SUN_EL, shadow, sunlit, cascades });
  // A regolith plain under an 8 degree sun reflects some hundred cd/m^2; inside the lander's shadow only
  // what the ground around and the lander itself throw back reaches it.
  expect(lit, 'sunlit ground beside the lander (cd/m^2)').toBeGreaterThan(100);
  expect(shadow! / lit, 'ground in the lander shadow against sunlit ground beside it').toBeLessThan(0.1);
  await expectClean(page, pageLog, info);
});
