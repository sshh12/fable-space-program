import { appUrl, assertDiscreteGpu, assertRealImage, expect, expectNoErrors, openPage, pngStats, test } from '../harness';

test.describe('app shell', () => {
  test('boots on the discrete GPU, loads definitions and presents frames', async ({ page, pageLog, request }) => {
    // Since app integration v1 the page at / is the game (request app-integration-2): it waits for the pad
    // terrain, every feature's start-up and the sound assets. No fullscreen capture on a key press.
    test.setTimeout(6 * 60_000);
    await openPage(page, '/?capture=0', { timeoutMs: 240_000 });
    const adapter = await assertDiscreteGpu(page);
    expect(adapter.features).toContain('float32-filterable');
    expect(adapter.features).toContain('timestamp-query');
    expect(adapter.limits['maxTextureArrayLayers']).toBeGreaterThanOrEqual(2048);

    expect(await page.evaluate(() => window.crossOriginIsolated)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.dataset['bodies'])).toBe('earth,moon,sun');
    const scenarios = ((await (await request.get(appUrl('/defs/index.json'))).json()) as { files: string[] }).files.filter((f) => f.startsWith('scenarios/')).map((f) => f.replace(/^scenarios\/|\.json$/g, ''));
    const info = (await page.evaluate(() => window.__test!.page)) as { kind: string; name: string; scenarioId: string | null };
    expect({ kind: info.kind, name: info.name }).toEqual({ kind: 'app', name: 'main' });
    expect(scenarios).toContain(info.scenarioId);

    await page.evaluate(() => window.__test!.waitFrames(5));
    const stats = pngStats(await page.screenshot());
    expect(stats.width).toBe(1280);
    expect(stats.height).toBe(720);
    // The game shows the pad: a real picture.
    assertRealImage(stats, 'the game at boot');
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
