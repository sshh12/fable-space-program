import { assertDiscreteGpu, expect, expectNoErrors, openPage, saveScreenshot, test, waitIdle, withGpuLock } from '../harness';

test.use({ viewport: { width: 2560, height: 1440 } });

/**
 * ARCHITECTURE 17.1, "core fixed" line, at 1440p internal resolution, qualityScale 1 (p99 of GPU
 * timestamps, ms): AO + contact 0.6, lighting 1.0, TAA 0.55, bloom 0.3, tonemap / exposure 0.2,
 * copies + depth pyramid 0.35 = 3.0 in total. Lab scene with 1.5 M triangles: G-buffer + amortised
 * shadows under 2.0 ms; CPU frame under 2 ms.
 */
test('core fixed GPU budget at 1440p, 1.5 M triangle scene, CPU frame time', async ({ page, pageLog }) => {
  test.setTimeout(20 * 60_000);
  await withGpuLock(async () => {
    // Attribution mode: every feature hook in its own pass; governor held at quality 1 / scale 1.
    await openPage(page, '/labs/render-core/?sun=110,32&hud=0&perf=features&scale=1&governor=off&tris=1500000');
    await assertDiscreteGpu(page);
    await page.evaluate(() => window.__rc!.lookAt([0, 6, 1], 200, 28, 26));
    await waitIdle(page, 120);
    const size = await page.evaluate(() => window.__lab!.renderer.frameContext!.renderSize);
    expect(size).toEqual([2560, 1440]);
    await page.evaluate(() => window.__test!.resetPerf());
    await page.evaluate(() => window.__test!.waitFrames(330));
    const r = await page.evaluate(() => ({
      passes: window.__lab!.renderer.passStats(),
      perf: window.__test!.perf()!,
      tris: window.__rc!.stand!.batch().stats,
    }));
    await saveScreenshot(page, 'render-core', 'perf-1440p-scene');
    const p99 = (name: string): number => r.passes[name]?.p99 ?? 0;
    const core = {
      aoContact: p99('core.ao'),
      lighting: p99('core.lighting'),
      taa: p99('core.taa'),
      bloom: p99('core.bloom'),
      tonemapExposure: p99('core.tonemap.clear') + p99('core.tonemap') + p99('core.histogram'),
      depthPyramid: p99('core.depthHalf'),
    };
    const total = Object.values(core).reduce((a, b) => a + b, 0);
    const gbuffer = Object.entries(r.passes).filter(([n]) => n.endsWith('.gbuffer') || n === 'core.gbuffer.clear');
    const shadow = Object.entries(r.passes).filter(([n]) => n.endsWith('.shadow') || n === 'core.shadow.clear');
    const gbufferP99 = gbuffer.reduce((a, [, v]) => a + v.p99, 0);
    const shadowMean = shadow.reduce((a, [, v]) => a + v.mean, 0);
    console.log(`core fixed (p99 ms @ ${size.join('x')}): ${Object.entries(core).map(([k, v]) => `${k} ${v.toFixed(3)}`).join(', ')}; total ${total.toFixed(3)} (budget 3.0)`);
    console.log(`1.5 M triangle scene: ${r.tris.triangles} tris in the G-buffer; G-buffer p99 ${gbufferP99.toFixed(3)} ms + shadows amortised ${shadowMean.toFixed(3)} ms = ${(gbufferP99 + shadowMean).toFixed(3)} (budget 2.0)`);
    console.log(`frame: GPU p50 ${r.perf.gpu.p50.toFixed(2)} p99 ${r.perf.gpu.p99.toFixed(2)} ms; CPU p50 ${r.perf.cpu.p50.toFixed(2)} p99 ${r.perf.cpu.p99.toFixed(2)} ms; rAF p95 ${r.perf.raf.p95.toFixed(2)} ms; features ${JSON.stringify(Object.fromEntries(Object.entries(r.perf.features).map(([k, v]) => [k, +v.gpuMs.toFixed(3)])))}`);
    expect(r.tris.triangles).toBeGreaterThanOrEqual(1_500_000);
    expect(r.perf.qualityScale).toBe(1);
    expect(r.perf.renderScale).toBe(1);
    expect(core.aoContact).toBeLessThanOrEqual(0.6);
    expect(core.lighting).toBeLessThanOrEqual(1.0);
    expect(core.taa).toBeLessThanOrEqual(0.55);
    expect(core.bloom).toBeLessThanOrEqual(0.3);
    expect(core.tonemapExposure).toBeLessThanOrEqual(0.2);
    expect(core.depthPyramid).toBeLessThanOrEqual(0.35);
    expect(total).toBeLessThanOrEqual(3.0);
    expect(gbufferP99 + shadowMean).toBeLessThan(2.0);
    expect(r.perf.cpu.p99).toBeLessThan(2.0);
    // The per-feature breakdown is complete: every feature and the core have a row.
    expect(Object.keys(r.perf.features)).toEqual(expect.arrayContaining(['core', 'lab-planet', 'lab-stand']));
    expect(r.perf.features['lab-stand']!.gpuMs).toBeGreaterThan(0);
    await expectNoErrors(page, pageLog);
  });
});
