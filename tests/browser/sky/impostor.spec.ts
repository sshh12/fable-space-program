import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { PNG } from 'pngjs';
import { assertDiscreteGpu, expect, expectNoErrors, openPage, test, waitIdle } from '../harness';

/**
 * Distant bodies: the analytic far image of a body (its sunlit sphere through the point-spread function, with the
 * body's own photometric function) is used while the SUNLIT PART is narrower than 4 px, hands over to the geometry
 * up to 7 px (and by 32 px of diameter in any case), in display pixels. The Earth tests use `maps=lambert`: the
 * backdrop is a Lambert sphere whose geometric albedo is the body's geometricAlbedo, so geometry and far image
 * describe the same body and flux, colour and shape must be continuous through the hand-over. The Moon test uses
 * the lab's regolith sphere with the tile set's albedo map (the Hapke function of the render core).
 */
test.describe.configure({ timeout: 900_000 });

const outDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'out', 'screens', 'sky');

interface Placement {
  x: number;
  y: number;
  diameterPx: number;
}

/**
 * Camera `distance` m from the centre of a body (`moon`: the first body that is neither the root nor the star) at
 * phase angle `phaseDeg` (0 = full), in the plane perpendicular to the direction of the other body, looking at it.
 */
async function placeCamera(page: Page, distance: number, phaseDeg: number, moon = false): Promise<Placement> {
  return page.evaluate(
    async ([d, phase, useMoon]) => {
      const lab = window.__lab!;
      const s = lab.snapshot();
      const root = s.bodies.find((b) => b.id === lab.defs.rootBodyId)!;
      const other = s.bodies.find((b) => b.id !== root.id && b.id !== s.starId)!;
      const body = useMoon ? other : root;
      const partner = useMoon ? root : other;
      const sun = body.sunDir;
      const toPartner = { x: partner.rRoot.x - body.rRoot.x, y: partner.rRoot.y - body.rRoot.y, z: partner.rRoot.z - body.rRoot.z };
      // Axis perpendicular to the sun direction and the partner's direction: rotating the sun direction about it
      // keeps the camera out of the line of the two bodies.
      let ax = { x: sun.y * toPartner.z - sun.z * toPartner.y, y: sun.z * toPartner.x - sun.x * toPartner.z, z: sun.x * toPartner.y - sun.y * toPartner.x };
      const al = Math.hypot(ax.x, ax.y, ax.z);
      ax = { x: ax.x / al, y: ax.y / al, z: ax.z / al };
      // Rodrigues: rotate sun about ax by the phase angle, to the side away from the partner (it must not be in the picture).
      const kd = ax.x * sun.x + ax.y * sun.y + ax.z * sun.z;
      const cr = { x: ax.y * sun.z - ax.z * sun.y, y: ax.z * sun.x - ax.x * sun.z, z: ax.x * sun.y - ax.y * sun.x };
      const rotated = (a: number) => {
        const c = Math.cos(a);
        const sn = Math.sin(a);
        return { x: sun.x * c + cr.x * sn + ax.x * kd * (1 - c), y: sun.y * c + cr.y * sn + ax.y * kd * (1 - c), z: sun.z * c + cr.z * sn + ax.z * kd * (1 - c) };
      };
      const a = ((phase as number) * Math.PI) / 180;
      const along = (o: { x: number; y: number; z: number }) => Math.abs(o.x * toPartner.x + o.y * toPartner.y + o.z * toPartner.z);
      // For the Moon the camera leaves the plane of the sun and the Earth altogether (the Earth must not come within
      // the measured window at any phase): the sun direction is turned towards the axis itself.
      const outOfPlane = { x: sun.x * Math.cos(a) + ax.x * Math.sin(a), y: sun.y * Math.cos(a) + ax.y * Math.sin(a), z: sun.z * Math.cos(a) + ax.z * Math.sin(a) };
      const out = useMoon ? outOfPlane : along(rotated(a)) <= along(rotated(-a)) ? rotated(a) : rotated(-a);
      const up = useMoon ? cr : ax;
      const dd = d as number;
      const pos = { x: body.rRoot.x + out.x * dd, y: body.rRoot.y + out.y * dd, z: body.rRoot.z + out.z * dd };
      window.__sky!.lookFrom(pos, { x: -out.x, y: -out.y, z: -out.z }, up, 60);
      await window.__test!.waitFrames(3);
      const f = lab.renderer.frameContext!;
      const p = window.__sky!.projectDir({ x: -out.x, y: -out.y, z: -out.z })!;
      const pxAngle = (2 * Math.tan(f.camera.fovY / 2)) / f.renderSize[1];
      return { x: p.x, y: p.y, diameterPx: (2 * Math.asin(lab.defs.bodies[body.id]!.radius / dd)) / pxAngle };
    },
    [distance, phaseDeg, moon] as const,
  );
}

interface Flux {
  /** Luminous flux at the camera (lux): HDR target averaged over two jitter cycles, and the temporally resolved image. */
  hdr: number;
  resolved: number;
  /** Mean colour of the resolved image over the window (luminance 1). */
  colour: [number, number, number];
  /** The far image's weight, its own flux (lux; 0 when the geometry is alone) and the lit width (px). */
  weight: number;
  image: number;
  litWidthPx: number;
  /** Lambert-sphere law for the root body at this distance and phase (lux). */
  lambert: number;
}

/** Flux of whatever is drawn within 52 px of (cx, cy): the far image's wings reach 48 px at most. */
async function measure(page: Page, at: Placement, moon = false): Promise<Flux> {
  return page.evaluate(
    async ([cx, cy, useMoon]) => {
      const lab = window.__lab!;
      const f0 = lab.renderer.frameContext!;
      const half = 52;
      const rect = { x: Math.round(cx as number) - half, y: Math.round(cy as number) - half, width: 2 * half + 1, height: 2 * half + 1 };
      const [w, h] = f0.renderSize;
      const tanY = Math.tan(f0.camera.fovY / 2);
      const omega = ((2 * tanY * w) / h / w) * ((2 * tanY) / h);
      const rgb = (d: Float32Array): [number, number, number] => {
        const s: [number, number, number] = [0, 0, 0];
        for (let j = 0; j < d.length; j += 4) {
          s[0] += d[j]!;
          s[1] += d[j + 1]!;
          s[2] += d[j + 2]!;
        }
        return s;
      };
      const lum = (c: [number, number, number]): number => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
      // Two full jitter cycles for the HDR mean (the geometry's coverage of pixel centres at 16 sub-pixel offsets),
      // then one more cycle of the resolved image, which by then has converged.
      let hdr = 0;
      const res: [number, number, number] = [0, 0, 0];
      lab.setLoop(false);
      for (let i = 0; i < 40; i++) {
        lab.renderFrame();
        const e = lab.renderer.frameContext!.exposure;
        if (i < 16) hdr += (lum(rgb((await lab.renderer.readHdrPixels('hdr', rect)).data)) * omega) / e / 16;
        if (i >= 32) {
          const c = rgb((await lab.renderer.readHdrPixels('resolved', rect)).data);
          for (let k = 0; k < 3; k++) res[k] = res[k]! + (c[k]! * omega) / e / 8;
        }
      }
      lab.setLoop(true);
      const s = lab.snapshot();
      const root = s.bodies.find((b) => b.id === lab.defs.rootBodyId)!;
      const body = useMoon ? s.bodies.find((b) => b.id !== root.id && b.id !== s.starId)! : root;
      const def = lab.defs.bodies[body.id]!;
      const em = lab.defs.bodies[s.starId]!.emission!;
      const cam = lab.cameraState().positionRoot;
      const to = { x: cam.x - body.rRoot.x, y: cam.y - body.rRoot.y, z: cam.z - body.rRoot.z };
      const dist = Math.hypot(to.x, to.y, to.z);
      const alpha = Math.acos((to.x * body.sunDir.x + to.y * body.sunDir.y + to.z * body.sunDir.z) / dist);
      const phi = (Math.sin(alpha) + (Math.PI - alpha) * Math.cos(alpha)) / Math.PI;
      const lambert = em.illuminance * (em.refDistance / body.sunDistance) ** 2 * def.render.geometricAlbedo * (def.radius / dist) ** 2 * phi;
      const imp = window.__sky!.sky!.impostors().find((i) => i.bodyId === body.id);
      const l = lum(res);
      return { hdr, resolved: l, colour: [res[0] / l, res[1] / l, res[2] / l] as [number, number, number], weight: imp?.weight ?? 0, image: imp?.illuminance ?? 0, litWidthPx: imp?.litWidthPx ?? 0, lambert };
    },
    [at.x, at.y, moon] as const,
  );
}

/** Distances (m) at which a body of `radius` m spans the given pixel diameters at 60 deg and 720 lines. */
const distancesFor = (radius: number, diametersPx: number[]): number[] => diametersPx.map((d) => radius / Math.sin((d * ((2 * Math.tan(Math.PI / 6)) / 720)) / 2));

for (const phase of [50, 125]) {
  test(`a body shrinking from 40 px to 0.5 px keeps its integrated flux and colour through the hand-over (phase ${phase} deg)`, async ({ page, pageLog }) => {
    await openPage(page, '/labs/sky/?scene=translunar&maps=lambert&parts=-stars,-milkyWay,-sun,-flare,-probe&ev=8&hud=0');
    await assertDiscreteGpu(page);
    await waitIdle(page, 4, 300_000);
    await page.evaluate(() => window.__lab!.setPaused(true));
    const radius = await page.evaluate(() => window.__lab!.defs.bodies[window.__lab!.defs.rootBodyId]!.radius);
    const steps = 30;
    const diameters = Array.from({ length: steps }, (_, k) => 40 * (0.5 / 40) ** (k / (steps - 1)));
    const rows: { px: number; f: Flux }[] = [];
    for (const [k, d] of distancesFor(radius, diameters).entries()) {
      const at = await placeCamera(page, d, phase);
      // The exposure follows the distance, so the body is equally bright at every size (as in the sheets).
      await page.evaluate((e) => window.__lab!.renderer.setExposureOverride(e), 14 - 2 * Math.log2(diameters[0]! / diameters[k]!));
      const f = await measure(page, at);
      rows.push({ px: at.diameterPx, f });
      console.log(
        `diameter ${at.diameterPx.toFixed(2).padStart(6)} px  lit width ${f.litWidthPx.toFixed(2).padStart(5)} px  weight ${f.weight.toFixed(3)}  HDR flux / Lambert sphere ${(f.hdr / f.lambert).toFixed(4)}  resolved / Lambert ${(f.resolved / f.lambert).toFixed(4)}  colour ${f.colour.map((c) => c.toFixed(3)).join(' ')}`,
      );
    }
    // The brief's criterion: flux continuous within 10 % (HDR; the far image is the Lambert-sphere law by construction).
    for (const r of rows) expect(Math.abs(r.f.hdr / r.f.lambert - 1), `HDR at ${r.px.toFixed(2)} px`).toBeLessThan(0.1);
    for (let k = 1; k < rows.length; k++) expect(Math.abs(rows[k]!.f.hdr / rows[k - 1]!.f.hdr / (rows[k]!.f.lambert / rows[k - 1]!.f.lambert) - 1)).toBeLessThan(0.1);
    // What the player sees (after the temporal resolve): no dip at an intermediate size, step to step within 15 %,
    // and wherever the far image carries the body it is within 10 % of the law.
    for (let k = 1; k < rows.length; k++) expect(Math.abs(rows[k]!.f.resolved / rows[k - 1]!.f.resolved / (rows[k]!.f.lambert / rows[k - 1]!.f.lambert) - 1), `resolved step at ${rows[k]!.px.toFixed(2)} px`).toBeLessThan(0.15);
    for (const r of rows.filter((q) => q.f.weight === 1)) expect(Math.abs(r.f.resolved / r.f.lambert - 1), `resolved at ${r.px.toFixed(2)} px`).toBeLessThan(0.1);
    for (const r of rows) expect(r.f.resolved / r.f.lambert, `resolved at ${r.px.toFixed(2)} px`).toBeGreaterThan(0.8);
    // One colour from a point to the resolved disc: channels within 4 % of the first row's.
    for (const r of rows) for (let c = 0; c < 3; c++) expect(Math.abs(r.f.colour[c]! / rows[0]!.f.colour[c]! - 1), `colour at ${r.px.toFixed(2)} px`).toBeLessThan(0.04);
    expect(rows[0]!.f.weight).toBe(0);
    expect(rows[rows.length - 1]!.f.weight).toBe(1);
    expect(rows.some((r) => r.f.weight > 0.05 && r.f.weight < 0.95)).toBe(true);
    await expectNoErrors(page, pageLog);
  });
}

interface TileStats {
  /** Display-linear luma summed over the tile, and its mean chromaticity r, g (of r + g + b). */
  sum: number;
  chroma: [number, number];
  /** Second moments of the display-linear luma about its centroid: along the major axis / along the minor axis (elongation). */
  elongation: number;
  /** Distance of the luma centroid from the body's projected centre, in body diameters. */
  offCentre: number;
}

/** A sheet of 96 px tiles (3x) around the body at each distance, the exposure opened by the fall of the flux with distance. */
async function approachSheet(page: Page, distances: number[], phase: number, ev: number, moon: boolean, file: string): Promise<{ stats: TileStats[]; labels: string[] }> {
  const tile = 96;
  const zoom = 3;
  const sheet = new PNG({ width: tile * zoom * distances.length, height: tile * zoom });
  const stats: TileStats[] = [];
  const labels: string[] = [];
  const srgb = (v: number): number => (v <= 0.04045 * 255 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4);
  for (let k = 0; k < distances.length; k++) {
    const at = await placeCamera(page, distances[k]!, phase, moon);
    await page.evaluate((e) => window.__lab!.renderer.setExposureOverride(e), ev - 2 * Math.log2(distances[k]! / distances[distances.length - 1]!));
    await page.evaluate(() => window.__test!.waitFrames(90));
    const shot = PNG.sync.read(await page.screenshot({ clip: { x: Math.round(at.x) - tile / 2, y: Math.round(at.y) - tile / 2, width: tile, height: tile } }));
    let sum = 0;
    const c = [0, 0, 0];
    let mx = 0;
    let my = 0;
    for (let i = 0; i < tile * tile; i++) {
      const l = 0.2126 * srgb(shot.data[i * 4]!) + 0.7152 * srgb(shot.data[i * 4 + 1]!) + 0.0722 * srgb(shot.data[i * 4 + 2]!);
      sum += l;
      for (let ch = 0; ch < 3; ch++) c[ch] = c[ch]! + srgb(shot.data[i * 4 + ch]!);
      mx += l * (i % tile);
      my += l * Math.floor(i / tile);
    }
    mx /= sum;
    my /= sum;
    let sxx = 0;
    let syy = 0;
    let sxy = 0;
    for (let i = 0; i < tile * tile; i++) {
      const l = 0.2126 * srgb(shot.data[i * 4]!) + 0.7152 * srgb(shot.data[i * 4 + 1]!) + 0.0722 * srgb(shot.data[i * 4 + 2]!);
      const dx = (i % tile) - mx;
      const dy = Math.floor(i / tile) - my;
      sxx += l * dx * dx;
      syy += l * dy * dy;
      sxy += l * dx * dy;
    }
    const tr = sxx + syy;
    const det = Math.sqrt(Math.max(0, (sxx - syy) ** 2 + 4 * sxy * sxy));
    stats.push({ sum, chroma: [c[0]! / (c[0]! + c[1]! + c[2]!), c[1]! / (c[0]! + c[1]! + c[2]!)], elongation: Math.sqrt((tr + det) / Math.max(tr - det, 1e-9)), offCentre: Math.hypot(mx + 0.5 - (tile / 2 + at.x - Math.round(at.x)), my + 0.5 - (tile / 2 + at.y - Math.round(at.y))) / at.diameterPx });
    for (let y = 0; y < tile * zoom; y++) {
      for (let x = 0; x < tile * zoom; x++) {
        const s = (Math.floor(y / zoom) * tile + Math.floor(x / zoom)) * 4;
        const o = (y * sheet.width + k * tile * zoom + x) * 4;
        sheet.data[o] = shot.data[s]!;
        sheet.data[o + 1] = shot.data[s + 1]!;
        sheet.data[o + 2] = shot.data[s + 2]!;
        sheet.data[o + 3] = 255;
      }
    }
    const info = await page.evaluate(() => window.__sky!.sky!.impostors().map((i) => ({ w: i.weight, lit: i.litWidthPx, d: i.diameterPx })));
    const mine = info.find((i) => Math.abs(i.d - at.diameterPx) < 0.02 * at.diameterPx + 0.01);
    labels.push(`${at.diameterPx.toFixed(1)} px (${mine ? `far image ${mine.w.toFixed(2)}, lit ${mine.lit.toFixed(1)} px` : 'geometry'}; display sum ${sum.toFixed(1)}, r ${stats[k]!.chroma[0].toFixed(3)} g ${stats[k]!.chroma[1].toFixed(3)}, elongation ${stats[k]!.elongation.toFixed(2)}, light ${stats[k]!.offCentre.toFixed(2)} diameters off centre)`);
  }
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, file), PNG.sync.write(sheet));
  return { stats, labels };
}

test('crescent Earth: a point far beyond the Moon, a sliver from a few pixels up, resolving on approach to lunar distance', async ({ page, pageLog }) => {
  await openPage(page, '/labs/sky/?scene=translunar&maps=lambert&parts=-flare&hud=0');
  await assertDiscreteGpu(page);
  await waitIdle(page, 4, 300_000);
  await page.evaluate(() => window.__lab!.setPaused(true));
  const radius = await page.evaluate(() => window.__lab!.defs.bodies[window.__lab!.defs.rootBodyId]!.radius);
  // Crescent: phase angle 125 deg, from half a pixel to 40 px (the geometry alone from 32 px). The exposure is the
  // automatic one of the largest tile, opened up by the fall of the flux with distance, so every tile shows the
  // body at the same brightness and only its shape changes.
  const diameters = [0.5, 1.2, 2.5, 4.2, 6.6, 9.5, 13.2, 20.7, 28, 40];
  const distances = distancesFor(radius, diameters);
  await placeCamera(page, distances[distances.length - 1]!, 125);
  await page.waitForFunction(
    () => {
      const e = window.__lab!.renderer.exposureInfo();
      return Math.abs(e.ev100 - e.targetEv100) < 0.02;
    },
    undefined,
    { timeout: 60_000 },
  );
  const ev = await page.evaluate(() => window.__lab!.renderer.exposureInfo().ev100);
  const { stats, labels } = await approachSheet(page, distances, 125, ev, false, 'crescent-earth-approach-sheet.png');
  await placeCamera(page, distancesFor(radius, [20.7])[0]!, 125);
  await page.evaluate((e) => window.__lab!.renderer.setExposureOverride(e), ev - 2 * Math.log2(distancesFor(radius, [20.7])[0]! / distances[distances.length - 1]!));
  await page.evaluate(() => window.__test!.waitFrames(60));
  await page.screenshot({ path: path.join(outDir, 'crescent-earth-lunar-distance.png') });
  console.log(`crescent Earth (Lambert backdrop) at EV100 ${ev.toFixed(2)}, tiles (3x zoom, left to right):\n  ${labels.join('\n  ')}`);
  // On the display nothing dips at an intermediate size: no tile is dimmer than its smaller neighbour by more than
  // 10 % or brighter by more than 35 % (the display burns out more of a point's light than of a crescent's, so the
  // sum grows with the size, smoothly), and the colour is one colour.
  for (let k = 1; k < stats.length; k++) {
    expect(stats[k]!.sum / stats[k - 1]!.sum, `display sum at ${diameters[k]} px`).toBeGreaterThan(0.9);
    expect(stats[k]!.sum / stats[k - 1]!.sum, `display sum at ${diameters[k]} px`).toBeLessThan(1.35);
  }
  for (const s of stats) {
    // (A point burns out more of its light than a crescent: the display whitens it a little, 0.03 in r at most.)
    expect(Math.abs(s.chroma[0] - stats[stats.length - 1]!.chroma[0])).toBeLessThan(0.04);
    expect(Math.abs(s.chroma[1] - stats[stats.length - 1]!.chroma[1])).toBeLessThan(0.04);
  }
  // Shape: from a few pixels up the light sits off centre, on the sunlit side (the photocentre of a crescent at
  // this phase is 0.38 diameters from the centre), and the image is longer than wide once the disc is resolved.
  for (const d of [4.2, 6.6, 9.5, 13.2, 20.7]) expect(stats[diameters.indexOf(d)]!.offCentre, `off centre at ${d} px`).toBeGreaterThan(0.25);
  expect(stats[diameters.indexOf(13.2)]!.elongation).toBeGreaterThan(1.25);
  expect(stats[diameters.indexOf(20.7)]!.elongation).toBeGreaterThan(1.5);
  await expectNoErrors(page, pageLog);
});

test('crescent Moon (regolith, the tile set\'s albedo map): the far image has the brightness, colour and shape of the geometry it hands over to', async ({ page, pageLog }) => {
  await openPage(page, '/labs/sky/?scene=translunar&parts=-flare&hud=0');
  await assertDiscreteGpu(page);
  await waitIdle(page, 4, 300_000);
  await page.evaluate(() => window.__lab!.setPaused(true));
  const radius = await page.evaluate(() => {
    const lab = window.__lab!;
    const s = lab.snapshot();
    return lab.defs.bodies[s.bodies.find((b) => b.id !== lab.defs.rootBodyId && b.id !== s.starId)!.id]!.radius;
  });
  const results: Record<number, { px: number; f: Flux }[]> = {};
  for (const phase of [30, 90, 125]) {
    const diameters = [1.5, 3, 4.5, 6, 8, 11, 15, 20, 26, 34, 44];
    const rows: { px: number; f: Flux }[] = [];
    for (const [k, d] of distancesFor(radius, diameters).entries()) {
      const at = await placeCamera(page, d, phase, true);
      await page.evaluate((e) => window.__lab!.renderer.setExposureOverride(e), 13 - 2 * Math.log2(diameters[diameters.length - 1]! / diameters[k]!));
      const f = await measure(page, at, true);
      rows.push({ px: at.diameterPx, f });
      // Flux x distance^2 is constant for a fixed phase: reported relative to the geometry alone (the largest size).
      console.log(`phase ${phase} deg  diameter ${at.diameterPx.toFixed(1).padStart(5)} px  weight ${f.weight.toFixed(3)}  HDR flux x d^2 ${(f.hdr * d * d).toExponential(4)}  resolved x d^2 ${(f.resolved * d * d).toExponential(4)}  colour ${f.colour.map((c) => c.toFixed(3)).join(' ')}`);
    }
    results[phase] = rows;
    const dist = distancesFor(radius, diameters);
    const geometry = rows[rows.length - 1]!.f.hdr * dist[dist.length - 1]! ** 2;
    const image = rows[0]!.f.hdr * dist[0]! ** 2;
    console.log(`phase ${phase} deg: far image / geometry (HDR flux) ${(image / geometry).toFixed(3)}`);
    // The far image is the body's Hapke sphere with the mean albedo of the face it shows (from the albedoLowRes map);
    // the geometry is the same function with the map itself: the two agree in flux within 10 % and in colour within
    // 4 %, at every phase and from every side (a Lambert sphere would be 3 x too bright at quadrature).
    expect(image / geometry).toBeGreaterThan(0.9);
    expect(image / geometry).toBeLessThan(1.1);
    for (let c = 0; c < 3; c++) expect(Math.abs(rows[0]!.f.colour[c]! / rows[rows.length - 1]!.f.colour[c]! - 1)).toBeLessThan(0.04);
    for (let k = 1; k < rows.length; k++) expect(Math.abs((rows[k]!.f.resolved * dist[k]! ** 2) / (rows[k - 1]!.f.resolved * dist[k - 1]! ** 2) - 1), `resolved step at ${rows[k]!.px.toFixed(1)} px, phase ${phase}`).toBeLessThan(0.2);
  }
  const diameters = [1.5, 3, 4.5, 6.2, 9, 12.5, 18, 26, 40];
  const distances = distancesFor(radius, diameters);
  // Hand-set to the exposure of sunlit regolith (a crescent this small is too little of the frame for the meter).
  const ev = 13.5;
  const { labels } = await approachSheet(page, distances, 125, ev, true, 'crescent-moon-approach-sheet.png');
  console.log(`crescent Moon at EV100 ${ev.toFixed(2)}, tiles (3x zoom, left to right):\n  ${labels.join('\n  ')}`);
  await expectNoErrors(page, pageLog);
});
