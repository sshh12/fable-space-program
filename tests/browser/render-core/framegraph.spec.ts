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
    const px = await lab.renderer.readHdrPixels('hdr', { x: 0, y: 0, width: 320, height: 32 });
    lab.setLoop(true);
    const out: number[][] = [];
    for (let k = 0; k < 12; k++) {
      const o = (16 * 320 + 8 + 24 * k + 8) * 4;
      out.push([px.data[o]!, px.data[o + 1]!, px.data[o + 2]!]);
    }
    return out;
  });
}

/** Markers 9-11 against the inputs the hooks probe wrote at marker 8 (labs/render-core/probes.ts, GBUFFER_PROBE). */
function expectGBufferMarkers(m: number[][]): void {
  const G = { albedo: [0.25, 0.5, 0.75], normal: [0.3, -0.5, 0.8], roughness: 0.6, param: 0.4 };
  // RT0 is 8-bit sRGB: a linear value comes back within one code (0.004 at 0.25, 0.008 at 0.75).
  for (let i = 0; i < 3; i++) expect(Math.abs(m[9]![i]! - G.albedo[i]!), `albedo channel ${i}`).toBeLessThan(0.008);
  expect(m[10]![0]).toBeCloseTo(G.roughness, 2);
  expect(m[10]![1]).toBeCloseTo(3, 3); // MATERIAL_ID.water
  expect(m[10]![2]).toBeCloseTo(200 * G.param * G.param, 0); // decodeWaterDepth(0.4) = 32 m
  const len = Math.hypot(...G.normal);
  for (let i = 0; i < 3; i++) expect(Math.abs(m[11]![i]! - (0.5 + (0.5 * G.normal[i]!) / len)), `normal component ${i}`).toBeLessThan(0.002);
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
    // Markers 9-11 (drawWater): the G-buffer inputs of marker 8, read through 'gbuffer.albedo' (linear
    // colour out of the sRGB target), 'gbuffer.material' (roughness, material id, decoded water depth) and
    // 'gbuffer.normal' (decoded), which are not attachments of the water pass.
    expectGBufferMarkers(m);
  }
  // The colour copies exist because the probe requires them.
  const copies = await page.evaluate(() => [window.__lab!.renderer.resources.isDefault('scene.colorCopy'), window.__lab!.renderer.resources.isDefault('scene.colorCopyTransparent')]);
  expect(copies).toEqual([false, false]);
  // The G-buffer resources are the live targets: published (not the defaults), and re-published with the
  // new targets when the render resolution changes.
  const before = await page.evaluate(() => {
    const r = window.__lab!.renderer.resources;
    return { isDefault: [r.isDefault('gbuffer.albedo'), r.isDefault('gbuffer.normal'), r.isDefault('gbuffer.material')], version: r.version('gbuffer.albedo') };
  });
  expect(before.isDefault).toEqual([false, false, false]);
  await page.setViewportSize({ width: 1000, height: 600 });
  await page.waitForFunction(() => window.__lab!.renderer.frameContext?.renderSize[0] === 1000);
  await page.evaluate(() => window.__test!.waitFrames(3));
  expect(await page.evaluate(() => window.__lab!.renderer.resources.version('gbuffer.albedo'))).toBeGreaterThan(before.version);
  expectGBufferMarkers(await readMarkers(page));
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.waitForFunction(() => window.__lab!.renderer.frameContext?.renderSize[0] === 1280);
  await page.evaluate(() => window.__test!.waitFrames(3));
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
    // The far quad (40 m) halfway into a cloud that spans 30-50 m, and in front of one that begins at 60 m.
    rc.probes.setCloudLayer({ begin: 30, end: 50 });
    lab.renderFrame();
    const inside = await grab();
    rc.probes.setCloudLayer({ begin: 60, end: 80 });
    lab.renderFrame();
    const before = await grab();
    const spans = { inside: at(inside, 0.3, row0), insideBackground: at(inside, 0.3, row0 - 20), inFront: at(before, 0.3, row0), nearInside: at(inside, 0.3, row1) };
    rc.probes.setCloudLayer(false);
    lab.renderer.setJitter(true);
    lab.setLoop(true);
    return { towerMaxDiff, towerPixels, fogMaxDiff, neutral, cloud, spans, screen };
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
  // Halfway into the cloud's span (smoothstep(30, 50, 40) = 0.5): attenuated by 1 + (0.02 - 1) x 0.5 = 0.51.
  expect(Math.abs(r.spans.inside - (2 * 0.51 + (1 - 0.51) * r.spans.insideBackground))).toBeLessThan(0.05);
  // In front of the cloud, however close to it: untouched (request atmosphere-clouds-1).
  expect(r.spans.inFront).toBe(2);
  expect(r.spans.nearInside).toBe(2);
  await expectNoErrors(page, pageLog);
});

test("'post.reactive' lowers the history weight where a feature asks for it: a pattern without a motion vector is shown as it is", async ({ page, pageLog }) => {
  await openPage(page, '/labs/render-core/?probe=reactive&planet=0&stand=0&sun=120,40&hud=0&ev=14');
  await assertDiscreteGpu(page);
  await waitIdle(page, 30);
  // The patch is per-pixel noise (0 or 2), new in every frame, with zero velocity: its neighbourhood is so
  // contrasty that the history clip accepts any history, and the resolve averages successive patterns.
  // Measured: the mean absolute change between two consecutive resolved frames, under the mask (left half
  // of the patch) and beside it (right half).
  const change = (): Promise<{ masked: number; plain: number; isDefault: boolean }> =>
    page.evaluate(async () => {
      const lab = window.__lab!;
      lab.setLoop(false);
      const rows: Float32Array[] = [];
      for (let i = 0; i < 2; i++) {
        lab.renderFrame();
        rows.push((await lab.renderer.readHdrPixels('resolved', { x: 400, y: 320, width: 400, height: 60 })).data);
      }
      lab.setLoop(true);
      const mean = (x0: number, x1: number): number => {
        let sum = 0;
        let n = 0;
        for (let y = 0; y < 60; y++) {
          for (let x = x0; x < x1; x++) {
            sum += Math.abs(rows[0]![(y * 400 + x) * 4]! - rows[1]![(y * 400 + x) * 4]!);
            n++;
          }
        }
        return sum / n;
      };
      return { masked: mean(20, 180), plain: mean(220, 380), isDefault: lab.renderer.resources.isDefault('post.reactive') };
    });
  const off = await change();
  expect(off.isDefault).toBe(false); // the probe requires the mask, so the core's target is published
  await page.evaluate(() => window.__rc!.probes.setReactive(1));
  await page.evaluate(() => window.__test!.waitFrames(6));
  const on = await change();
  await page.evaluate(() => window.__rc!.probes.setReactive(0.5));
  await page.evaluate(() => window.__test!.waitFrames(6));
  const half = await change();
  console.log(`reactive mask: frame-to-frame change of the resolved noise patch: mask 0: ${off.masked.toFixed(3)} (beside it ${off.plain.toFixed(3)}), mask 0.5: ${half.masked.toFixed(3)}, mask 1: ${on.masked.toFixed(3)} (beside it ${on.plain.toFixed(3)})`);
  // Without the mask both halves are the same slow average.
  expect(Math.abs(off.masked - off.plain)).toBeLessThan(0.3 * off.plain);
  // Mask 1: every frame is the current pattern alone; the change between frames is several times larger.
  expect(on.masked).toBeGreaterThan(3 * off.masked);
  // Beside the mask nothing changed, and half a mask lies in between.
  expect(Math.abs(on.plain - off.plain)).toBeLessThan(0.3 * off.plain);
  expect(half.masked).toBeGreaterThan(1.3 * off.masked);
  expect(half.masked).toBeLessThan(0.9 * on.masked);
  await expectNoErrors(page, pageLog);
});
