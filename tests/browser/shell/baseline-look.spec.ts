/**
 * Which display curve the checkpoints' pages run (the render core's look switch, RENDER_API 13.1): the
 * chain of custody of a recording or of a gate run that is made under a stated look.
 *
 *   BASELINE_EXPECT_LOOK=1 VITE_CORE_LOOK=1 node tools/dev/heavy.mjs --class=gpu -- npx playwright test tests/browser/shell/baseline-look.spec.ts tests/browser/shell/baselines.record.spec.ts --project=functional
 *
 * Run in the SAME invocation as the gate or the recorder: one server serves both (tests/browser/globalSetup.ts
 * starts it with this process's environment), so what this file reads is what the pictures were drawn with.
 * It opens the first checkpoint of every distinct page of the manifest (the integration lab and the app)
 * with `coredebug=1` added to the checkpoint's own address, and reads the look the renderer says it runs
 * (`window.__core.look`, the handle of src/render/core/renderer.ts). Skipped without BASELINE_EXPECT_LOOK.
 */
import { appUrl, expect, readBaselineManifest, test } from '../harness';

const expected = process.env.BASELINE_EXPECT_LOOK ?? '';

test.describe('the look of the checkpoints\' pages', () => {
  test.skip(expected === '', 'a custody check: BASELINE_EXPECT_LOOK=<1|2>');

  test('every page of the manifest runs the expected look', async ({ page }) => {
    test.setTimeout(600_000);
    const manifest = readBaselineManifest();
    const firstOfPage = new Map<string, { name: string; page: string }>();
    for (const [name, c] of Object.entries(manifest.checkpoints)) {
      if (c.page === null) continue;
      const pathname = c.page.split('?')[0]!;
      if (!firstOfPage.has(pathname)) firstOfPage.set(pathname, { name, page: c.page });
    }
    expect(firstOfPage.size).toBeGreaterThanOrEqual(2);
    const seen: string[] = [];
    for (const [pathname, c] of firstOfPage) {
      await page.goto(appUrl(`${c.page}${c.page.includes('?') ? '&' : '?'}coredebug=1`));
      await page.waitForFunction(() => (globalThis as unknown as { __core?: { look: number } }).__core !== undefined, undefined, { timeout: 240_000 });
      const look = await page.evaluate(() => (globalThis as unknown as { __core: { look: number } }).__core.look);
      seen.push(`${pathname} (${c.name}): look ${look}`);
      console.log(`[baseline look] ${pathname} (checkpoint ${c.name}): the renderer runs look ${look}; the server's VITE_CORE_LOOK is ${JSON.stringify(process.env.VITE_CORE_LOOK ?? null)}`);
      expect(String(look), seen.join('; ')).toBe(expected);
    }
  });
});
