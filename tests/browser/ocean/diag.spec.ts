import { expectNoErrors, openPage, saveScreenshot, test, waitIdle } from '../harness';

test.describe.configure({ timeout: 600_000 });

test('ocean diagnostics', async ({ page, pageLog }) => {
  const preset = process.env.OCEAN_PRESET ?? 'midday';
  await openPage(page, `/labs/ocean/?preset=${preset}${process.env.OCEAN_QUERY ?? ''}`);
  await page.evaluate(() => document.body.classList.add('shot'));
  await page.evaluate(() => window.__test!.waitFrames(60));
  console.log(JSON.stringify(await page.evaluate(() => window.__lab!.renderer.exposureInfo())));
  await page.evaluate(() => {
    window.__test!.setPaused(true);
    window.__test!.setDeterministic(true);
    window.__lab!.renderer.setExposureOverride(window.__lab!.renderer.exposureInfo().ev100);
  });
  await waitIdle(page, 60);
  await saveScreenshot(page, 'ocean', `diag-${preset}`);
  const views = (process.env.OCEAN_VIEWS ?? '').split(',').filter(Boolean) as ('skyReflection' | 'body' | 'sunSpecular' | 'foam' | 'normal' | 'roughness')[];
  const probe = async (): Promise<string> =>
    page.evaluate(async () => {
      const img = await window.__lab!.renderer.readHdrPixels('hdr');
      const at = (x: number, y: number): string => Array.from(img.data.slice((y * img.width + x) * 4, (y * img.width + x) * 4 + 3)).map((v) => v.toFixed(3)).join(',');
      return `bottom ${at(640, 700)}  mid ${at(640, 450)}  far ${at(640, 300)}  sky ${at(640, 100)}`;
    });
  console.log(`full: ${await probe()}`);
  for (const v of views) {
    await page.evaluate((view) => window.__ocean!.ocean!.debug.setDebugView(view), v);
    await waitIdle(page, 40);
    await saveScreenshot(page, 'ocean', `diag-${preset}-${v}`);
    console.log(`${v}: ${await probe()}`);
  }
  await expectNoErrors(page, pageLog);
});
