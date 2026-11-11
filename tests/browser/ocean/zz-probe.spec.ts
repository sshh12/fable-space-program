/**
 * Probe (development aid, run by hand): opens an ocean lab view and prints the scene luminance (cd/m^2, the HDR
 * target divided by the exposure) at given render pixels for a list of debug views, with an optional screenshot.
 *   PROBE_PRESET=refraction PROBE_POINTS="640,500;640,680" PROBE_VIEWS="none,body,skyReflection" \
 *   PROBE_SETUP="window.__ocean.ocean.debug.setRefractionScale(0)" PROBE_SHOT=name PROBE_SIZE=2560x1440 \
 *   npx playwright test tests/browser/ocean/zz-probe.spec.ts --project=functional
 * Skipped unless PROBE_PRESET is set.
 */
import { assertDiscreteGpu, expectNoErrors, openPage, saveScreenshot, test, waitIdle } from '../harness';

const preset = process.env.PROBE_PRESET;
const size = (process.env.PROBE_SIZE ?? '1280x720').split('x').map(Number) as [number, number];
test.use({ viewport: { width: size[0], height: size[1] } });

test('ocean probe', async ({ page, pageLog }) => {
  test.skip(!preset, 'PROBE_PRESET is not set');
  test.setTimeout(300_000);
  await openPage(page, `/labs/ocean/?preset=${preset}${process.env.PROBE_QUERY ?? ''}`);
  await assertDiscreteGpu(page);
  await page.evaluate(() => document.body.classList.add('shot'));
  await page.evaluate(() => window.__test!.waitFrames(90));
  await page.evaluate(() => window.__test!.setDeterministic(true));
  if (process.env.PROBE_SETUP) await page.evaluate(process.env.PROBE_SETUP);
  await waitIdle(page, 40);
  const points = (process.env.PROBE_POINTS ?? '').split(';').filter(Boolean).map((p) => p.split(',').map(Number) as [number, number]);
  const info = await page.evaluate(() => ({ ev: window.__lab!.renderer.exposureInfo(), state: window.__ocean!.ocean?.debug.state() }));
  console.log(`EV ${info.ev.ev100.toFixed(2)} (target ${info.ev.targetEv100.toFixed(2)}), camera ${info.state?.cameraHeight.toFixed(1)} m, layers ${info.state?.layerMask}, patches ${info.state?.patches}`);
  for (const view of (process.env.PROBE_VIEWS ?? 'none').split(',')) {
    await page.evaluate((v) => window.__ocean!.ocean!.debug.setDebugView(v as 'none'), view);
    await waitIdle(page, 6);
    const vals = await page.evaluate(async (pts) => {
      const img = await window.__lab!.renderer.readHdrPixels('hdr');
      const e = window.__lab!.renderer.exposureInfo().exposure;
      // Mean over 5 x 5 pixels around each point, and frame statistics.
      const at = pts.map(([x, y]) => {
        const s = [0, 0, 0];
        for (let j = -2; j <= 2; j++) for (let i = -2; i <= 2; i++) {
          const o = ((y + j) * img.width + x + i) * 4;
          for (let c = 0; c < 3; c++) s[c]! += img.data[o + c]! / 25 / e;
        }
        return s.map((v) => Math.round(v));
      });
      let sum = 0;
      let max = 0;
      for (let p = 0; p < img.width * img.height; p++) {
        const l = (0.2126 * img.data[p * 4]! + 0.7152 * img.data[p * 4 + 1]! + 0.0722 * img.data[p * 4 + 2]!) / e;
        sum += l;
        max = Math.max(max, l);
      }
      return { at, mean: Math.round(sum / (img.width * img.height)), max: Math.round(max) };
    }, points);
    console.log(`view ${view}: frame mean ${vals.mean} cd/m2, max ${vals.max}; ${points.map((p, i) => `(${p[0]},${p[1]}) = [${vals.at[i]!.join(', ')}]`).join('  ')}`);
    if (process.env.PROBE_SHOT) await saveScreenshot(page, 'ocean', `probe-${process.env.PROBE_SHOT}-${view}`);
  }
  await expectNoErrors(page, pageLog);
});
