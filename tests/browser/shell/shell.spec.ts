import { appUrl, assertDiscreteGpu, expect, expectNoErrors, openPage, pngStats, test } from '../harness';

test.describe('app shell', () => {
  test('boots on the discrete GPU, loads definitions and presents frames', async ({ page, pageLog }) => {
    await openPage(page, '/');
    const adapter = await assertDiscreteGpu(page);
    expect(adapter.features).toContain('float32-filterable');
    expect(adapter.features).toContain('timestamp-query');
    expect(adapter.limits['maxTextureArrayLayers']).toBeGreaterThanOrEqual(2048);

    expect(await page.evaluate(() => window.crossOriginIsolated)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.dataset['bodies'])).toBe('earth,moon,sun');
    expect(await page.evaluate(() => window.__test!.page)).toEqual({ kind: 'app', name: 'main', scenarioId: null });

    await page.evaluate(() => window.__test!.waitFrames(5));
    const stats = pngStats(await page.screenshot());
    expect(stats.width).toBe(1280);
    expect(stats.height).toBe(720);
    // The shell clears to a dark blue-grey: non-zero and uniform. Real scenes use assertRealImage instead.
    expect(stats.maxLuma).toBeGreaterThan(2);
    expect(stats.center[2]).toBeGreaterThan(stats.center[0]);
    await expectNoErrors(page, pageLog);
  });

  test('serves definitions with isolation headers and 404s unknown tiles', async ({ request }) => {
    const index = await request.get(appUrl('/defs/index.json'));
    expect(index.ok()).toBe(true);
    expect(index.headers()['cross-origin-embedder-policy']).toBe('require-corp');
    const files = ((await index.json()) as { files: string[] }).files;
    expect(files).toContain('bodies/earth.json');
    expect(files).toContain('render/earth.atmosphere.json');
    const missing = await request.get(appUrl('/tiles/nowhere/height/0/0/0/0.hgt'));
    expect(missing.status()).toBe(404);
    const escape = await request.get(appUrl('/defs/..%2F..%2Fpackage.json'));
    expect([403, 404]).toContain(escape.status());
  });
});
