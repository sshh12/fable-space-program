import { mkdirSync, writeFileSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { expect, expectNoErrors, pngDiff, test } from '../harness';
import { LUNAR_SITE, PAD, magentaFraction, openLab, settle, shot, terrainStats } from './util';

/**
 * Integrity of the terrain surface: no cracks or holes, image tiles decoded without premultiplication,
 * the mesh equal to the collision surface, the ocean near-field hand-over, sub-millimetre stability.
 */

async function place(page: Page, body: string, lat: number, lon: number, height: number, heading: number, pitch: number, agl = true): Promise<void> {
  await page.evaluate(([b, la, lo, h, hd, pt, a]) => window.__terrain!.placeCamera(b as string, la as number, lo as number, h as number, hd as number, pt as number, a as boolean), [body, lat, lon, height, heading, pitch, agl] as const);
}

/** Heights of a scripted descent (m above the ground) with the pitch the camera looks down at. */
const DESCENT: [number, number][] = [
  [400e3, -70],
  [150e3, -60],
  [60e3, -50],
  [20e3, -40],
  [8e3, -35],
  [3e3, -30],
  [1e3, -25],
  [300, -22],
  [100, -18],
  [30, -15],
  [8, -12],
  [2, -9],
];

for (const site of [
  { body: 'earth', ...PAD, heading: 30, sun: '105,31', silhouette: -150 },
  { body: 'moon', ...LUNAR_SITE, heading: 280, sun: '92,11', silhouette: -9130 },
]) {
  test(`no cracks or holes along a descent: ${site.body}`, async ({ page, pageLog }) => {
    test.setTimeout(10 * 60_000);
    // Magenta is drawn behind everything where a ray hits the sphere R + silhouette: any hole shows it.
    await openLab(page, { scene: site.body === 'moon' ? 'lunarOrbit' : 'lowOrbit', paused: 1, magenta: 1, silhouette: site.silhouette, body: site.body, lat: site.lat, lon: site.lon, alt: 500e3, heading: site.heading, pitch: -70, sun: site.sun });
    let worst = 0;
    for (const [height, pitch] of DESCENT) {
      await place(page, site.body, site.lat, site.lon, height, site.heading, pitch);
      // While the tiles of the new position stream in (ancestors and skirts must cover everything) ...
      for (const frames of [2, 6, 20]) {
        await page.evaluate((n) => window.__test!.waitFrames(n), frames);
        const capture = await page.screenshot();
        const mid = magentaFraction(capture);
        worst = Math.max(worst, mid.count);
        if (mid.count > 0) {
          mkdirSync('out/screens/terrain', { recursive: true });
          writeFileSync(`out/screens/terrain/holes-${site.body}-${height}-${frames}.png`, capture);
        }
        expect(mid.count, `magenta pixels while streaming at ${height} m, ${frames} frames after the move (${mid.box}; out/screens/terrain/holes-${site.body}-${height}-${frames}.png)`).toBe(0);
      }
      // ... and once everything has arrived and settled.
      await settle(page, 6);
      const s = await shot(page, `cracks-${site.body}-${height}`);
      const m = magentaFraction(s.buffer);
      worst = Math.max(worst, m.count);
      expect(m.count, `magenta pixels at ${height} m (${m.box}; out/screens/terrain/cracks-${site.body}-${height}.png)`).toBe(0);
      expect(s.stats.fractionNonBlack, `image at ${height} m`).toBeGreaterThan(0.3);
    }
    const st = await terrainStats(page);
    console.log(`${site.body}: 0 magenta pixels over ${DESCENT.length} heights x 4 captures (worst ${worst}); deepest level ${st.bodies[site.body]!.deepestLevel}; incomplete bakes ${st.stream.incompleteBakes}`);
    await expectNoErrors(page, pageLog);
  });
}

test('the hole marker works: a silhouette sphere above the terrain shows as a magenta ring at the limb', async ({ page, pageLog }) => {
  // With the marker sphere 30 km above the datum, rays that graze it miss the terrain below: magenta.
  await openLab(page, { scene: 'lunarOrbit', paused: 1, magenta: 1, silhouette: 30_000, body: 'moon', lat: LUNAR_SITE.lat, lon: LUNAR_SITE.lon, alt: 400e3, heading: 280, pitch: -35, sun: '92,30' });
  await settle(page, 6);
  const m = magentaFraction(await page.screenshot());
  expect(m.fraction).toBeGreaterThan(0.002);
  await expectNoErrors(page, pageLog);
});

test('image tiles: albedo equals a reference decode on land and water, the water mask equals tileCodec exactly', async ({ page, pageLog }) => {
  await openLab(page, { scene: 'lowOrbit', paused: 1, body: 'earth', lat: PAD.lat, lon: PAD.lon + 0.01, alt: 4000, heading: 0, pitch: -89.9, sun: '105,31' });
  await settle(page, 6);
  const r = await page.evaluate(
    async ([lat, lon]) => {
      const t = window.__terrain!;
      // A level-12 tile on the shore east of the pad: it holds both land and open water.
      const out: { key: string; land: number; water: number; maxLand: number; maxWater: number; maskDiffs: number; coverDiffs: number; meanLand: number; meanRef: number }[] = [];
      const seen = new Set<string>();
      for (const [dLat, dLon] of [[0, 0.004], [0, 0.012], [0.02, 0.012], [-0.02, 0.008], [0.03, 0.02]] as const) {
        const key = t.debug.readyTileAt('earth', lat! + dLat, lon! + dLon, 12);
        if (!key || key.level !== 12 || seen.has(`${key.x}/${key.y}`)) continue;
        seen.add(`${key.x}/${key.y}`);
        const gpu = await t.debug.readTile('earth', key);
        const ref = await t.referenceTile('earth', key);
        if (!gpu.albedo || !gpu.aux || !ref.watermask || !ref.landcover) continue;
        let land = 0;
        let water = 0;
        let maxLand = 0;
        let maxWater = 0;
        let maskDiffs = 0;
        let coverDiffs = 0;
        let sumLand = 0;
        let sumRef = 0;
        for (let i = 0; i < 256 * 256; i++) {
          const isWater = ref.watermask[i]! > 127;
          let d = 0;
          for (let c = 0; c < 3; c++) d = Math.max(d, Math.abs(gpu.albedo[i * 4 + c]! - ref.albedo[i * 4 + c]!));
          if (isWater) {
            water++;
            maxWater = Math.max(maxWater, d);
          } else {
            land++;
            maxLand = Math.max(maxLand, d);
            sumLand += gpu.albedo[i * 4]! + gpu.albedo[i * 4 + 1]! + gpu.albedo[i * 4 + 2]!;
            sumRef += ref.albedo[i * 4]! + ref.albedo[i * 4 + 1]! + ref.albedo[i * 4 + 2]!;
          }
          if (gpu.aux[i * 2] !== ref.watermask[i]) maskDiffs++;
          if (gpu.aux[i * 2 + 1] !== ref.landcover[i]) coverDiffs++;
        }
        out.push({ key: `${key.face}/${key.level}/${key.x}/${key.y}`, land, water, maxLand, maxWater, maskDiffs, coverDiffs, meanLand: sumLand / Math.max(1, land * 3), meanRef: sumRef / Math.max(1, land * 3) });
      }
      return out;
    },
    [PAD.lat, PAD.lon] as const,
  );
  console.log(JSON.stringify(r));
  const coastal = r.filter((t) => t.land > 2000 && t.water > 2000);
  expect(coastal.length, 'a tile with both land and water was read back').toBeGreaterThan(0);
  for (const t of r) {
    expect(t.maxLand, `${t.key}: land texels within 2 / 255`).toBeLessThanOrEqual(2);
    expect(t.maxWater, `${t.key}: water texels within 2 / 255`).toBeLessThanOrEqual(2);
    // Land is not darkened by any premultiplication: its mean equals the reference.
    expect(Math.abs(t.meanLand - t.meanRef)).toBeLessThan(0.5);
    expect(t.maskDiffs, `${t.key}: water mask`).toBe(0);
    expect(t.coverDiffs, `${t.key}: land cover`).toBe(0);
  }
  await expectNoErrors(page, pageLog);
});

for (const site of [
  { body: 'earth', ...PAD, lon: PAD.lon - 0.004, sun: '105,31' },
  { body: 'moon', ...LUNAR_SITE, sun: '92,11' },
]) {
  test(`the mesh at the deepest level is the collision surface: ${site.body}`, async ({ page, pageLog }) => {
    await openLab(page, { scene: site.body === 'moon' ? 'lunarOrbit' : 'lowOrbit', paused: 1, body: site.body, lat: site.lat, lon: site.lon, agl: 1.7, heading: 40, pitch: -20, sun: site.sun });
    await settle(page, 6);
    const r = await page.evaluate(([b, la, lo]) => window.__terrain!.surfaceMatch(b as string, la as number, lo as number, 1000), [site.body, site.lat, site.lon] as const);
    console.log(`${site.body}: ${r.samples} vertices of ${r.tiles} deepest-level tiles: max |GPU - heightAt| ${(r.maxAbs * 1000).toFixed(3)} mm, rms ${(r.rms * 1000).toFixed(3)} mm`);
    expect(r.samples).toBe(1000);
    expect(r.tiles).toBeGreaterThanOrEqual(4);
    expect(r.maxAbs).toBeLessThan(0.03);
    await expectNoErrors(page, pageLog);
  });
}

test('ocean near field: the sheet is absent inside fadeStart and depth holds the seabed; without it the water is unchanged', async ({ page, pageLog }) => {
  // 3 km above the sea, 6 km east of the pad, looking down at 35 degrees: open water near and far.
  await openLab(page, { scene: 'lowOrbit', paused: 1, deterministic: 1, body: 'earth', lat: PAD.lat - 0.02, lon: PAD.lon + 0.06, alt: 3000, heading: 190, pitch: -33, sun: '105,31' });
  await settle(page, 8);
  const size = await page.evaluate(() => window.__lab!.renderer.frameContext!.renderSize);
  // Bottom of the frame: the sea 3.3 km away. Top: 2 degrees below the horizontal, the sea 50 km away.
  const near: [number, number] = [Math.round(size[0] / 2), Math.round(size[1] * 0.92)];
  const far: [number, number] = [Math.round(size[0] / 2), Math.round(size[1] * 0.03)];
  const probe = async (): Promise<{ near: number; far: number }> =>
    page.evaluate(async ([n, f]) => ({ near: await window.__terrain!.probeAltitude('earth', n![0]!, n![1]!), far: await window.__terrain!.probeAltitude('earth', f![0]!, f![1]!) }), [near, far] as const);

  const before = await probe();
  const shotBefore = await shot(page, 'handover-without-nearfield');
  // Without a near field the sea-level sheet is in depth everywhere.
  expect(Math.abs(before.near)).toBeLessThan(2);
  expect(Math.abs(before.far)).toBeLessThan(60);

  await page.evaluate(() => window.__terrain!.setNearField({ bodyId: 'earth', fadeStart: 15_000, fadeEnd: 30_000 }));
  await page.evaluate(() => window.__test!.waitFrames(12));
  const during = await probe();
  await shot(page, 'handover-with-nearfield');
  // Inside 15 km the sheet is gone: depth holds the seabed (the solid surface below sea level) ...
  expect(during.near).toBeLessThan(-5);
  // ... and the far pixel (more than 15 km away) still holds the sheet.
  const farDistance = await page.evaluate(async ([f]) => {
    const d = await window.__lab!.renderer.readDepth();
    return 0.05 / d.data[f![1]! * d.width + f![0]!]!;
  }, [far] as const);
  expect(farDistance).toBeGreaterThan(30_000);
  expect(Math.abs(during.far)).toBeLessThan(60);
  // Every pixel down the middle of the frame holds either the seabed (inside the near field) or the
  // sheet (outside it): there is no hole at the hand-over.
  const column = await page.evaluate(async ([w, h]) => {
    const out: number[] = [];
    for (let y = 4; y < h!; y += 8) out.push(await window.__terrain!.probeAltitude('earth', Math.round(w! / 2), y));
    return out;
  }, size);
  expect(column.every((a) => Number.isFinite(a) && a < 60 && a > -6000), `altitudes down the frame: ${column.map((a) => a.toFixed(0)).join(' ')}`).toBe(true);
  console.log(`near pixel: sea ${before.near.toFixed(2)} m -> seabed ${during.near.toFixed(1)} m with the near field; far pixel (${(farDistance / 1000).toFixed(1)} km along the view axis): ${before.far.toFixed(2)} m -> ${during.far.toFixed(2)} m`);

  await page.evaluate(() => window.__terrain!.setNearField(null));
  // Long enough for the exposure (which metered the darker seabed meanwhile) and the temporal filter to return.
  await page.evaluate(() => window.__test!.waitFrames(240));
  const after = await probe();
  const shotAfter = await page.screenshot();
  expect(Math.abs(after.near)).toBeLessThan(2);
  // The default resource again: the picture is the one from before.
  const diff = pngDiff(shotBefore.buffer, shotAfter);
  expect(diff.meanAbsDiff).toBeLessThan(0.15);
  await expectNoErrors(page, pageLog);
});

for (const site of [
  { body: 'earth', lat: PAD.lat, lon: PAD.lon - 0.004, sun: '105,31' },
  { body: 'moon', ...LUNAR_SITE, sun: '92,11' },
]) {
  test(`no vertex jitter while the camera moves by millimetres: ${site.body}`, async ({ page, pageLog }) => {
    await openLab(page, { scene: site.body === 'moon' ? 'lunarOrbit' : 'lowOrbit', paused: 1, deterministic: 1, body: site.body, lat: site.lat, lon: site.lon, agl: 1.7, heading: 70, pitch: -28, sun: site.sun });
    await settle(page, 8);
    // 24 steps of 1 mm towards the east (1 mm = 9e-9 degrees of longitude on Earth), jitter off so that
    // the only change between frames is the camera.
    const diffs = await page.evaluate(
      async ([body, lat, lon]) => {
        const lab = window.__lab!;
        const t = window.__terrain!;
        lab.renderer.setJitter(false);
        const radius = lab.defs.bodies[body as string]!.radius;
        const ground = await t.groundHeight(body as string, lat as number, lon as number);
        const stepDeg = (0.001 / (radius * Math.cos(((lat as number) * Math.PI) / 180))) * (180 / Math.PI);
        const out: number[] = [];
        let prev: Uint8ClampedArray | null = null;
        lab.setLoop(false);
        for (let i = 0; i < 40; i++) {
          // The first 16 frames let the temporal filter converge on the starting position.
          const k = Math.max(0, i - 16);
          lab.camera.spec = { type: 'surface', bodyId: body as string, latDeg: lat as number, lonDeg: (lon as number) + k * stepDeg, alt: ground + 1.7, headingDeg: 70, pitchDeg: -28 };
          lab.renderFrame(1 / 60);
          const now = t.grab(960, 540).slice();
          if (prev && i > 16) {
            let sum = 0;
            for (let p = 0; p < now.length; p += 4) sum += Math.abs(now[p]! - prev[p]!) + Math.abs(now[p + 1]! - prev[p + 1]!) + Math.abs(now[p + 2]! - prev[p + 2]!);
            out.push(sum / (960 * 540 * 3));
          }
          prev = now;
          await new Promise(requestAnimationFrame);
        }
        lab.setLoop(true);
        lab.renderer.setJitter(true);
        return out;
      },
      [site.body, site.lat, site.lon] as const,
    );
    const sorted = [...diffs].sort((a, b) => a - b);
    const median = sorted[sorted.length >> 1]!;
    const max = sorted[sorted.length - 1]!;
    console.log(`${site.body}: frame-to-frame difference over 23 steps of 1 mm: median ${median.toFixed(4)}, max ${max.toFixed(4)} (8-bit levels)`);
    // A 1 mm step moves the nearest ground (3.6 m away) by 0.3 px at most: the image barely changes (well
    // under one 8-bit level on average), and every step changes it by the same small amount. Vertex
    // jitter would show as steps that stand out from the others.
    expect(median).toBeLessThan(1);
    expect(max).toBeLessThan(Math.max(1.5 * median, 0.05));
    await shot(page, `jitter-${site.body}`);
    await expectNoErrors(page, pageLog);
  });
}
