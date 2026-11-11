/**
 * Ad-hoc screenshots while working on a model: not part of the acceptance run (skipped unless VEH_ADHOC is
 * set). Entries are separated by ';', each "name|query string of the vehicle lab":
 *
 *   VEH_ADHOC="pad|scene=pad&sun=205,40&eye=60,-50,75&at=0,-50,0&fov=60" [VEH_SIZE=2560x1440] [VEH_EVAL=<js run in the page>] \
 *     node tools/dev/heavy.mjs --class=gpu -- npx playwright test tests/browser/vehicle/adhoc.spec.ts --project=functional
 *
 * Errors of the page are printed, not asserted, so a half-built model can still be looked at.
 */
import { appUrl, saveScreenshot, test, waitIdle } from '../harness';
import { LAB } from './lab';

const entries = (process.env.VEH_ADHOC ?? '').split(';').filter((e) => e.includes('|'));

test.skip(entries.length === 0, 'set VEH_ADHOC to take ad-hoc screenshots');
if (process.env.VEH_SIZE) {
  const [w, h] = process.env.VEH_SIZE.split('x').map(Number);
  test.use({ viewport: { width: w!, height: h! } });
}

test('ad-hoc vehicle lab screenshots', async ({ page }) => {
  test.setTimeout(Math.max(2, entries.length) * 45_000);
  for (const entry of entries) {
    const [name, query] = entry.split('|') as [string, string];
    await page.goto(appUrl(`${LAB}?hud=0&governor=off&${query}`));
    await page.waitForFunction(() => window.__veh !== undefined || (window.__test?.errors.length ?? 0) > 0, undefined, { timeout: 120_000 });
    const errors = await page.evaluate(() => window.__test!.errors);
    if (errors.length > 0) console.log(`[${name}] page errors:\n  ${errors.slice(0, 12).join('\n  ')}`);
    const script = process.env.VEH_EVAL;
    if (script) await page.evaluate(script);
    // Live, like the acceptance views: jitter and noise run and the temporal anti-aliasing converges.
    await waitIdle(page, Number(process.env.VEH_FRAMES ?? 72));
    const s = await saveScreenshot(page, 'vehicle', `adhoc-${name}`);
    const stats = await page.evaluate(() => ({ ...window.__veh!.vehicle.stats, site: window.__veh!.site ? { ...window.__veh!.site.stats } : null, ev: window.__lab!.renderer.exposureInfo().ev100 }));
    console.log(`[${name}] ${s.file} mean ${s.stats.meanLuma.toFixed(1)} ${JSON.stringify(stats)}`);
  }
});
