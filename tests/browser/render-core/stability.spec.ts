import type { Page } from '@playwright/test';
import { assertDiscreteGpu, expect, expectNoErrors, openPage, pngDiff, saveScreenshot, test, waitIdle } from '../harness';

/**
 * True-scale precision: a vessel-sized cylinder 30 m from the camera, 6,371 km from the origin, and the
 * Moon-sized LabPlanet 384,400 km away, in one frame and one depth buffer.
 */
async function setUp(page: Page): Promise<{ moonId: string; az: number; el: number }> {
  return page.evaluate(() => {
    const rc = window.__rc!;
    const moonId = rc.probes.ridgeSite.bodyId;
    const d = rc.directionAtSite(moonId);
    // Sun 140 deg of azimuth away from the Moon, 30 deg up: lights the cylinder and most of the lunar disc.
    rc.setSun([d.azDeg + 140, 30]);
    // Look past the cylinder (centre 20 m up, 28 m north of the site origin) at the Moon, 7 deg to its side.
    rc.lookAt([0, 28, 20], d.azDeg + 180 + 7, -d.elDeg, 30);
    return { moonId, az: d.azDeg, el: d.elDeg };
  });
}

test('static scene with TAA: frame-to-frame difference below 1/255 mean, near object and Moon in one depth buffer', async ({ page, pageLog }) => {
  await openPage(page, '/labs/render-core/?scene=pad&site=moonview&hud=0&fov=12&paused=1');
  await assertDiscreteGpu(page);
  const s = await setUp(page);
  expect(s.el).toBeGreaterThan(20);
  await waitIdle(page, 90);
  const a = await saveScreenshot(page, 'render-core', 'stability-near-and-moon');
  await page.evaluate(() => window.__test!.waitFrames(7));
  const b = await page.screenshot();
  await page.evaluate(() => window.__test!.waitFrames(13));
  const c = await page.screenshot();
  const d1 = pngDiff(a.buffer, b);
  const d2 = pngDiff(b, c);
  console.log(`static TAA diff: mean ${d1.meanAbsDiff.toFixed(4)} and ${d2.meanAbsDiff.toFixed(4)} of 255, max ${Math.max(d1.maxAbsDiff, d2.maxAbsDiff)}`);
  expect(d1.meanAbsDiff).toBeLessThan(1);
  expect(d2.meanAbsDiff).toBeLessThan(1);
  // No flicker anywhere: jitter, AO and shadow noise are fully resolved (a z-fight would toggle whole pixels).
  expect(Math.max(d1.maxAbsDiff, d2.maxAbsDiff)).toBeLessThanOrEqual(24);
  expect(a.stats.fractionNonBlack).toBeGreaterThan(0.2);

  // Both objects are in the depth buffer at their true distances (reversed-Z: depth = 0.05 m / distance).
  const depth = await page.evaluate(async (moonId) => {
    const lab = window.__lab!;
    const rc = window.__rc!;
    const d = await lab.renderer.readDepth();
    const m = rc.projectBody(moonId)!;
    const at = (x: number, y: number): number => d.data[Math.round(y) * d.width + Math.round(x)]!;
    const stack = rc.projectSitePoint([0, 28, 20])!;
    const moonDist = Math.hypot(...Object.values(lab.renderer.frameContext!.bodyPose(moonId).centerRelCam)) - lab.defs.bodies[moonId]!.radius;
    return { moon: at(m.x, m.y), stack: at(stack.x, stack.y), sky: at(m.x, m.y - m.radius * 1.6), moonDist, moonRadiusPx: m.radius };
  }, s.moonId);
  console.log(`depth: cylinder ${depth.stack.toExponential(3)} (${(0.05 / depth.stack).toFixed(2)} m), Moon ${depth.moon.toExponential(3)} (${(0.05 / depth.moon / 1e3).toFixed(0)} km), sky ${depth.sky}`);
  expect(0.05 / depth.stack).toBeGreaterThan(26);
  expect(0.05 / depth.stack).toBeLessThan(31);
  expect(0.05 / depth.moon / depth.moonDist).toBeGreaterThan(0.99);
  expect(0.05 / depth.moon / depth.moonDist).toBeLessThan(1.01);
  expect(depth.sky).toBe(0);
  expect(depth.moonRadiusPx).toBeGreaterThan(10);
  await expectNoErrors(page, pageLog);
});

test('sub-millimetre stability: moving the camera in 1 mm steps moves the image smoothly (no jitter, no z-fighting)', async ({ page, pageLog }) => {
  await openPage(page, '/labs/render-core/?scene=pad&site=moonview&hud=0&fov=12&paused=1&ev=14.8');
  await assertDiscreteGpu(page);
  const s = await setUp(page);
  await waitIdle(page, 30);
  // The camera circles the cylinder's centre at 30 m in steps of 1 mm (3.33e-5 rad). The cylinder stays put
  // on screen; the Moon, at infinity for this purpose, slides by that angle times cos(elevation): 0.09 px per step.
  const track = await page.evaluate(
    async ({ moonId, az, el }) => {
      const lab = window.__lab!;
      const rc = window.__rc!;
      lab.setLoop(false);
      const stepDeg = ((0.001 / 30) * 180) / Math.PI;
      const moonX: number[] = [];
      const edgeX: number[] = [];
      for (let i = 0; i < 24; i++) {
        rc.lookAt([0, 28, 20], az + 180 + 7 + i * stepDeg, -el, 30);
        for (let k = 0; k < 24; k++) lab.renderFrame(1 / 60);
        const img = await lab.renderer.readHdrPixels('resolved');
        const lum = (x: number, y: number): number => img.data[(y * img.width + x) * 4 + 1]!;
        // Luminance-weighted centroid of the lunar disc.
        const m = rc.projectBody(moonId)!;
        let sw = 0;
        let sx = 0;
        const r = Math.ceil(m.radius * 1.3);
        for (let y = Math.round(m.y) - r; y <= Math.round(m.y) + r; y++) {
          for (let x = Math.round(m.x) - r; x <= Math.round(m.x) + r; x++) {
            const l = lum(x, y);
            sw += l;
            sx += l * x;
          }
        }
        moonX.push(sx / sw);
        // Sub-pixel position of the cylinder's lit silhouette against the black sky, averaged over 40 rows:
        // where the luminance crosses half of its value 6 px inside the edge.
        const c = rc.projectSitePoint([0, 28, 20])!;
        let sum = 0;
        let rows = 0;
        for (let row = Math.round(c.y) - 20; row < Math.round(c.y) + 20; row++) {
          let x = img.width - 2;
          while (x > c.x && lum(x, row) < 0.01) x--;
          const plateau = lum(x - 6, row);
          let e = x + 2;
          while (e > c.x && lum(e, row) < 0.5 * plateau) e--;
          // Between e (above half) and e + 1 (below half).
          const a = lum(e, row);
          const b = lum(e + 1, row);
          sum += e + (a - 0.5 * plateau) / Math.max(a - b, 1e-9);
          rows++;
        }
        edgeX.push(sum / rows);
      }
      lab.setLoop(true);
      return { moonX, edgeX, stepPx: ((stepDeg * Math.PI) / 180 / lab.cameraState().fovY) * lab.renderer.frameContext!.displaySize[1] * Math.cos((el * Math.PI) / 180) };
    },
    { moonId: s.moonId, az: s.az, el: s.el },
  );
  // Least-squares line through the Moon track: slope = expected px per millimetre step, residual tiny.
  const n = track.moonX.length;
  const mx = (n - 1) / 2;
  const my = track.moonX.reduce((a, b) => a + b, 0) / n;
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < n; i++) {
    sxy += (i - mx) * (track.moonX[i]! - my);
    sxx += (i - mx) ** 2;
  }
  const slope = sxy / sxx;
  const residual = Math.max(...track.moonX.map((v, i) => Math.abs(v - (my + slope * (i - mx)))));
  const edgeSpread = Math.max(...track.edgeX) - Math.min(...track.edgeX);
  console.log(`1 mm steps: Moon moves ${slope.toFixed(4)} px/step (expected ${track.stepPx.toFixed(4)}), max residual ${residual.toFixed(4)} px; cylinder edge spread ${edgeSpread.toFixed(4)} px over 23 mm`);
  expect(Math.abs(Math.abs(slope) - track.stepPx)).toBeLessThan(0.15 * track.stepPx);
  expect(residual).toBeLessThan(0.08);
  // The cylinder is the pivot: its silhouette must not move by more than a few hundredths of a pixel.
  expect(edgeSpread).toBeLessThan(0.1);
  await saveScreenshot(page, 'render-core', 'stability-after-sweep');
  await expectNoErrors(page, pageLog);
});
