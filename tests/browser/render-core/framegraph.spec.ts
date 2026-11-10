import { PNG } from 'pngjs';
import { assertDiscreteGpu, expect, expectNoErrors, openPage, saveScreenshot, test, waitIdle } from '../harness';

// The first navigation of a run compiles the page through Vite; on a loaded machine that alone can take a minute.
test.describe.configure({ timeout: 600_000 });

const MARKER_X = (k: number): number => 8 + 24 * k + 8;
const MARKER_Y = 16;

/** Render one frame with the loop stopped and read the HDR target strip that holds the markers. */
async function readMarkers(page: import('@playwright/test').Page): Promise<number[][]> {
  return page.evaluate(async () => {
    const lab = window.__lab!;
    lab.setLoop(false);
    lab.renderFrame();
    const px = await lab.renderer.readHdrPixels('hdr', { x: 0, y: 0, width: 256, height: 32 });
    lab.setLoop(true);
    const out: number[][] = [];
    for (let k = 0; k < 8; k++) {
      const o = (16 * 256 + 8 + 24 * k + 8) * 4;
      out.push([px.data[o]!, px.data[o + 1]!, px.data[o + 2]!]);
    }
    return out;
  });
}

test('hooks run in ascending order then registration order, in frame-graph sequence', async ({ page, pageLog }) => {
  await openPage(page, '/labs/render-core/?probe=order&sun=120,40&hud=0');
  await assertDiscreteGpu(page);
  await waitIdle(page, 6);
  const log = await page.evaluate(() => window.__rc!.probes.hookLog());
  const hooks = ['prepare', 'compute', 'drawShadow', 'drawGBuffer', 'drawWater', 'drawBackground', 'compositeAtmosphere', 'preTransparent', 'drawTransparent', 'drawOverlay'];
  // Every hook was called, features in the order a (order -5), b, c (order 5, registration order).
  let lastStart = -1;
  for (const hook of hooks) {
    const calls = log.filter((l) => l.endsWith(`.${hook}`));
    expect(calls.length, hook).toBeGreaterThanOrEqual(3);
    expect(calls.length % 3, hook).toBe(0);
    for (let i = 0; i < calls.length; i += 3) expect(calls.slice(i, i + 3), hook).toEqual([`ord-a.${hook}`, `ord-b.${hook}`, `ord-c.${hook}`]);
    // Stages follow the table of ARCHITECTURE 10.0.
    const first = log.findIndex((l) => l.endsWith(`.${hook}`));
    const last = log.length - 1 - [...log].reverse().findIndex((l) => l.endsWith(`.${hook}`));
    expect(first, `${hook} starts after the previous stage`).toBeGreaterThan(lastStart);
    lastStart = last;
  }
  expect(await page.evaluate(() => window.__lab!.renderer.featureOrder().filter((id) => id.startsWith('ord-')))).toEqual(['ord-a', 'ord-b', 'ord-c']);
  // Nobody requires a colour copy here: none is made.
  const copies = await page.evaluate(() => [window.__lab!.renderer.resources.isDefault('scene.colorCopy'), window.__lab!.renderer.resources.isDefault('scene.colorCopyTransparent')]);
  expect(copies).toEqual([true, true]);
  await expectNoErrors(page, pageLog);
});

test('every hook has the attachments of the table and the scene copies hold this frame', async ({ page, pageLog }) => {
  await openPage(page, '/labs/render-core/?probe=hooks&planet=0&stand=0&sun=120,40&hud=0');
  await assertDiscreteGpu(page);
  await waitIdle(page, 6);
  for (let round = 0; round < 3; round++) {
    const m = await readMarkers(page);
    // Marker 0: G-buffer geometry with emissive 5 survives lighting, is NOT overwritten by the background
    // (depth != 0) nor by the transparent fragment behind it (depth test greater-equal, read-only).
    expect(m[0]![0]).toBeGreaterThanOrEqual(5);
    expect(m[0]![0]).toBeLessThan(6);
    // Marker 1 (drawWater): 'scene.depthOpaque' holds THIS frame's depth; 'scene.colorCopy' holds the lit scene.
    expect(m[1]![0]).toBeLessThan(0.01);
    expect(m[1]![1]).toBeGreaterThanOrEqual(5);
    expect(m[1]![2]).toBe(1);
    // Marker 2 (drawBackground): written where depth == 0.
    expect(m[2]).toEqual([7, 7, 7]);
    // Marker 3 (compositeAtmosphere): 'scene.depth' has the water pass's depth write and this frame's
    // G-buffer depth; 'scene.depthHalf' g = nearest (1 at the water marker), r = farthest.
    expect(m[3]![0]).toBeLessThan(0.01);
    expect(m[3]![1]).toBe(1);
    expect(m[3]![2]).toBeLessThan(0.01);
    // Marker 4 (drawTransparent): the half-resolution target written in preTransparent, upsampled.
    expect(m[4]).toEqual([3, 3, 3]);
    // Marker 5: 'scene.colorCopyTransparent' contains what the atmosphere stage drew at marker 3.
    expect(m[5]![1]).toBe(1);
    expect(m[5]![0]).toBeLessThan(0.01);
    // Marker 6: a transparent fragment in front of the sky passes the depth test.
    expect(m[6]).toEqual([9, 9, 9]);
  }
  // The colour copies exist because the probe requires them.
  const copies = await page.evaluate(() => [window.__lab!.renderer.resources.isDefault('scene.colorCopy'), window.__lab!.renderer.resources.isDefault('scene.colorCopyTransparent')]);
  expect(copies).toEqual([false, false]);
  // Marker 7 (drawOverlay): pure green in the LDR canvas, untouched by tonemapping.
  const shot = await saveScreenshot(page, 'render-core', 'framegraph-markers');
  const png = PNG.sync.read(shot.buffer);
  const o = (MARKER_Y * png.width + MARKER_X(7)) * 4;
  expect([png.data[o], png.data[o + 1], png.data[o + 2]]).toEqual([0, 255, 0]);
  await expectNoErrors(page, pageLog);
});

test('a half-resolution volume from preTransparent is occluded by opaque geometry; applyAtmosphere is neutral by default and hides what is behind a cloud', async ({ page, pageLog }) => {
  await openPage(page, '/labs/render-core/?probe=volume,cloud&sun=120,40&hud=0&paused=1&ev=14.5');
  await assertDiscreteGpu(page);
  await page.evaluate(() => window.__test!.setDeterministic(true));
  await waitIdle(page, 6);
  await saveScreenshot(page, 'render-core', 'framegraph-volume');

  const r = await page.evaluate(async () => {
    const lab = window.__lab!;
    const rc = window.__rc!;
    lab.setLoop(false);
    // Identical sub-pixel sampling in every frame, so that A/B readbacks differ only by what is toggled.
    lab.renderer.setJitter(false);
    const grab = async (): Promise<{ width: number; height: number; data: Float32Array }> => {
      lab.renderFrame();
      return lab.renderer.readHdrPixels('hdr');
    };
    rc.probes.setVolume(true);
    const on = await grab();
    const depth = await lab.renderer.readDepth();
    const screen = rc.probes.volumeScreen()!;
    rc.probes.setVolume(false);
    const off = await grab();
    // Row through the fog sphere centre: tower pixels (nearer than the fog) must not change, fog over background must.
    const y = Math.round(screen.y);
    const cx = Math.round(screen.x);
    let towerMaxDiff = 0;
    let towerPixels = 0;
    let fogMaxDiff = 0;
    const centreDepth = depth.data[y * depth.width + cx]!;
    for (let x = Math.round(cx - screen.radius * 0.8); x <= Math.round(cx + screen.radius * 0.8); x++) {
      const o = (y * on.width + x) * 4;
      const diff = Math.abs(on.data[o]! - off.data[o]!) + Math.abs(on.data[o + 1]! - off.data[o + 1]!) + Math.abs(on.data[o + 2]! - off.data[o + 2]!);
      const d = depth.data[y * depth.width + x]!;
      // Interior tower pixels: same depth as the centre (within 20 %) and both neighbours too (skip silhouette pixels).
      const dl = depth.data[y * depth.width + x - 2]!;
      const dr = depth.data[y * depth.width + x + 2]!;
      const isTower = (v: number): boolean => Math.abs(v - centreDepth) < 0.2 * centreDepth;
      if (isTower(d) && isTower(dl) && isTower(dr)) {
        towerPixels++;
        towerMaxDiff = Math.max(towerMaxDiff, diff);
      } else if (!isTower(d) && !isTower(dl) && !isTower(dr)) {
        fogMaxDiff = Math.max(fogMaxDiff, diff);
      }
    }

    // Transparent bands: band 0 is 40 m away, band 1 is 5 m away, both with pre-exposed radiance 2.
    const w = off.width;
    const h = off.height;
    const at = (img: { data: Float32Array }, fx: number, row: number): number => img.data[(row * w + Math.floor(w * fx)) * 4]!;
    const row0 = Math.floor(h * 0.3) + 12;
    const row1 = row0 + 40;
    const neutral = { farLeft: at(off, 0.3, row0), farRight: at(off, 0.7, row0), nearLeft: at(off, 0.3, row1), nearRight: at(off, 0.7, row1) };
    rc.probes.setCloudLayer(true);
    lab.renderFrame();
    const clouded = await grab();
    const cloud = { farLeft: at(clouded, 0.3, row0), farRight: at(clouded, 0.7, row0), nearLeft: at(clouded, 0.3, row1), nearRight: at(clouded, 0.7, row1), background: at(clouded, 0.3, row0 - 20) };
    rc.probes.setCloudLayer(false);
    lab.renderer.setJitter(true);
    lab.setLoop(true);
    return { towerMaxDiff, towerPixels, fogMaxDiff, neutral, cloud, screen };
  });
  expect(r.towerPixels).toBeGreaterThan(4);
  expect(r.fogMaxDiff).toBeGreaterThan(0.05);
  expect(r.towerMaxDiff).toBeLessThan(r.fogMaxDiff * 0.02);
  // Default resources: applyAtmosphere returns its input exactly.
  expect(r.neutral).toEqual({ farLeft: 2, farRight: 2, nearLeft: 2, nearRight: 2 });
  // Synthetic cloud (transmittance 0.02 at 20 m over the left half): only the far quad on the left is hidden.
  // The far quad contributes 2 % of its radiance and lets 98 % of the background through.
  expect(Math.abs(r.cloud.farLeft - (0.04 + 0.98 * r.cloud.background))).toBeLessThan(0.05);
  expect(r.cloud.farLeft).toBeLessThan(0.6);
  expect(r.cloud.farRight).toBe(2);
  expect(r.cloud.nearLeft).toBe(2);
  expect(r.cloud.nearRight).toBe(2);
  await expectNoErrors(page, pageLog);
});
