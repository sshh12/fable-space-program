/**
 * Temporal stability: the wave field is fixed to the planet (no swimming when the camera translates), the
 * camera-centred mesh brings nothing of its own (moving away and back reproduces the frame exactly), and the
 * motion vectors of the animated waves are right (TAA keeps the detail of the moving sea).
 */
import { assertDiscreteGpu, expect, expectNoErrors, openPage, saveScreenshot, test, waitIdle } from '../harness';

test.describe.configure({ timeout: 600_000 });

test('the wave field is planet-fixed: the same surface from two camera positions 3 km apart', async ({ page, pageLog }) => {
  await openPage(page, '/labs/ocean/?preset=midday&governor=off&scale=1');
  await assertDiscreteGpu(page);
  await page.evaluate(() => window.__test!.setPaused(true));
  await page.evaluate(() => window.__test!.waitFrames(3));
  const sample = async (): Promise<number[]> =>
    page.evaluate(async () => {
      const lab = window.__ocean!;
      const dirs = Array.from({ length: 64 }, (_, i) => lab.dirAt(400 + 37 * (i % 8), 900 + 41 * Math.floor(i / 8)));
      const r = await lab.ocean!.debug.sampleSurface(dirs);
      return r.samples.map((s) => s.total);
    });
  const a = await sample();
  await page.evaluate(() => window.__ocean!.setCamera({ east: 2100, north: 2100, alt: 2, heading: 0, pitch: -9 }));
  await page.evaluate(() => window.__test!.waitFrames(3));
  const b = await sample();
  const worst = Math.max(...a.map((v, i) => Math.abs(v - b[i]!)));
  const spread = Math.max(...a) - Math.min(...a);
  console.log(`planet-fixed surface: worst difference ${(worst * 1000).toFixed(3)} mm over 64 points (surface spread ${spread.toFixed(3)} m)`);
  expect(spread).toBeGreaterThan(0.1);
  expect(worst).toBeLessThan(0.001);
  await expectNoErrors(page, pageLog);
});

test('moving the camera away and back reproduces the frame; TAA keeps the detail of the moving sea', async ({ page, pageLog }) => {
  await openPage(page, '/labs/ocean/?preset=midday&governor=off&scale=1');
  await assertDiscreteGpu(page);
  await page.evaluate(() => {
    window.__test!.setPaused(true);
    window.__test!.setDeterministic(true);
    window.__lab!.renderer.setJitter(false);
    window.__lab!.renderer.setExposureOverride(13.5);
  });
  await waitIdle(page, 6);
  const grab = async (): Promise<Float32Array> =>
    Float32Array.from(await page.evaluate(async () => Array.from((await window.__lab!.renderer.readHdrPixels('hdr')).data)));
  const a = await grab();
  // Walk the camera 250 m away in 25 steps (the patch selection, morphs and the chart reference all change) and back.
  for (let k = 1; k <= 25; k++) {
    await page.evaluate((n) => window.__ocean!.setCamera({ east: n * 10, alt: 2 + n * 4, heading: 12, pitch: -9 }), k);
    await page.evaluate(() => window.__test!.waitFrames(1));
  }
  await page.evaluate(() => window.__ocean!.setCamera({ alt: 2, heading: 12, pitch: -9 }));
  await page.evaluate(() => window.__test!.waitFrames(3));
  const b = await grab();
  let worst = 0;
  let sum = 0;
  for (let i = 0; i < a.length; i += 4) {
    const d = Math.abs(a[i + 1]! - b[i + 1]!) / Math.max(a[i + 1]!, 1e-4);
    worst = Math.max(worst, d);
    sum += d;
  }
  console.log(`away and back: worst relative difference ${worst.toExponential(2)}, mean ${(sum / (a.length / 4)).toExponential(2)}`);
  expect(worst).toBeLessThan(1e-3);

  // Motion vectors. A camera flying over a frozen sea is a static world: with exact motion vectors TAA keeps it
  // as sharp as with a still camera. The measure is the gradient energy of the TAA output relative to the
  // single jittered frame it was resolved from (same frame, rendered by hand). The animated sea's pattern
  // evolves (dispersive waves in many directions) and has no single motion vector: the ocean marks it in the
  // reactive mask ('post.reactive'), which must keep more of its detail than the history alone.
  await page.evaluate(() => {
    window.__ocean!.setSun([192, 40]);
    window.__lab!.renderer.setJitter(true);
    window.__test!.setDeterministic(false);
    window.__lab!.setLoop(false);
  });
  const sharpness = async (animate: boolean, fly: boolean): Promise<number> =>
    page.evaluate(
      async ([anim, moveCam]) => {
        const lab = window.__lab!;
        lab.setPaused(!anim);
        let k = 0;
        const step = (): void => {
          k++;
          if (moveCam) window.__ocean!.setCamera({ east: k * 0.08, north: k * 0.03, alt: 2 + 0.002 * k, heading: 12 + k * 0.05, pitch: -9 });
          lab.renderFrame(1 / 60);
        };
        for (let i = 0; i < 90; i++) step();
        const energy = (img: { width: number; height: number; data: Float32Array }): number => {
          let e = 0;
          let n = 0;
          for (let y = Math.floor(img.height * 0.65); y < img.height - 1; y++) {
            for (let x = 1; x < img.width - 1; x++) {
              const o = (y * img.width + x) * 4 + 1;
              const g = img.data[o]!;
              const dx = img.data[o + 4]! - img.data[o - 4]!;
              const dy = img.data[o + img.width * 4]! - g;
              e += (dx * dx + dy * dy) / Math.max(g * g, 1e-6);
              n++;
            }
          }
          return e / n;
        };
        let ratio = 0;
        for (let j = 0; j < 4; j++) {
          step();
          const hdr = await lab.renderer.readHdrPixels('hdr');
          const res = await lab.renderer.readHdrPixels('resolved');
          ratio += energy(res) / energy(hdr) / 4;
        }
        return ratio;
      },
      [animate, fly] as const,
    );
  const still = await sharpness(false, false);
  const flying = await sharpness(false, true);
  const animated = await sharpness(true, false);
  await page.evaluate(() => window.__ocean!.ocean!.debug.setReactiveScale(0));
  const animatedNoMask = await sharpness(true, false);
  await page.evaluate(() => window.__ocean!.ocean!.debug.setReactiveScale(1));
  await page.evaluate(() => window.__lab!.setLoop(true));
  await saveScreenshot(page, 'ocean', 'stability-animated');
  console.log(`TAA output / single frame gradient energy: still ${still.toFixed(3)}, camera flying 5 m/s and turning 3 deg/s over a frozen sea ${flying.toFixed(3)} (ratio ${(flying / still).toFixed(2)}), animated sea ${animated.toFixed(3)} (ratio ${(animated / still).toFixed(2)}; without the reactive mask ${(animatedNoMask / still).toFixed(2)})`);
  // Measured with this method: terrain (core mesh motion vectors) 0.81, this water 0.68, this water with its
  // motion vectors zeroed 0.40. Water keeps a little less than terrain because its shading is view-dependent
  // (reflections slide over the surface as the camera moves).
  expect(flying / still).toBeGreaterThan(0.6);
  // Without the mask the animated sea measured 0.47-0.48 of the still one (request ocean-4).
  expect(animated / still).toBeGreaterThan(0.6);
  expect(animated).toBeGreaterThan(animatedNoMask * 1.15);
  await expectNoErrors(page, pageLog);
});
