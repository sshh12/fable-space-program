import type { Page } from '@playwright/test';
import { assertDiscreteGpu, expect, expectNoErrors, openPage, saveScreenshot, test, waitIdle, withGpuLock } from '../harness';

test.use({ viewport: { width: 2560, height: 1440 } });

interface Measured {
  passes: Record<string, { p50: number; p99: number; mean: number }>;
  perf: { gpu: { p50: number; p99: number }; cpu: { p50: number; p99: number }; raf: { p95: number }; qualityScale: number; renderScale: number; features: Record<string, { gpuMs: number; cpuMs: number }> };
  tris: { instances: number; triangles: number; shadowTriangles: number };
}

async function measure(page: Page, frames: number): Promise<Measured> {
  return page.evaluate(async (n) => {
    await window.__test!.waitFrames(90);
    window.__test!.resetPerf();
    await window.__test!.waitFrames(n);
    return { passes: window.__lab!.renderer.passStats(), perf: window.__test!.perf()!, tris: { ...window.__rc!.stand!.batch().stats } };
  }, frames);
}

function summarise(r: Measured): { core: Record<string, number>; total: number; gbuffer: number; shadows: number } {
  const p99 = (name: string): number => r.passes[name]?.p99 ?? 0;
  const core = {
    aoContact: p99('core.ao'),
    lighting: p99('core.lighting'),
    taa: p99('core.taa'),
    bloom: p99('core.bloom'),
    tonemapExposure: p99('core.tonemap.clear') + p99('core.tonemap') + p99('core.histogram'),
    depthPyramid: p99('core.depthHalf'),
  };
  const sum = (suffix: string, key: 'p99' | 'mean'): number =>
    Object.entries(r.passes)
      .filter(([n]) => (n.endsWith(`.${suffix}`) || n === `core.${suffix}.clear`) && !n.startsWith('lab-heavy'))
      .reduce((a, [, v]) => a + v[key], 0);
  return { core, total: Object.values(core).reduce((a, b) => a + b, 0), gbuffer: sum('gbuffer', 'p99'), shadows: sum('shadow', 'mean') };
}

const fmt = (c: Record<string, number>): string =>
  Object.entries(c)
    .map(([k, v]) => `${k} ${v.toFixed(3)}`)
    .join(', ');

/**
 * ARCHITECTURE 17.1, "core fixed" line, at 1440p internal resolution, qualityScale 1 (p99 of GPU
 * timestamps, ms): AO + contact 0.6, lighting 1.0, TAA 0.55, bloom 0.3, tonemap / exposure 0.2,
 * copies + depth pyramid 0.35 = 3.0 in total. Lab scene with 1.5 M triangles: G-buffer + amortised
 * shadows under 2.0 ms; CPU frame under 2 ms.
 *
 * Method. An RTX 5090 that only has this lab's 2 ms of work per 16.7 ms frame drops into a low clock
 * state: the same passes then take 2-5 times longer and their p99 jumps around. The budgets are for the
 * game's frame (9-11 ms of GPU work), so the measurement that is ASSERTED runs with a ballast pass (the
 * `heavy` probe, about 7 ms) keeping the GPU as busy as a real frame. The idle-GPU numbers are logged for
 * the record.
 */
test('core fixed GPU budget at 1440p, 1.5 M triangle scene, CPU frame time', async ({ page, pageLog }) => {
  test.setTimeout(30 * 60_000);
  await withGpuLock(async () => {
    // Attribution mode: every feature hook in its own pass; governor off: quality 1 and scale 1 throughout.
    await openPage(page, '/labs/render-core/?sun=110,32&hud=0&perf=features&scale=1&governor=off&tris=1500000&probe=heavy&heavy=0');
    await assertDiscreteGpu(page);
    await page.evaluate(() => window.__rc!.lookAt([0, 6, 1], 200, 28, 26));
    await waitIdle(page, 120);
    const size = await page.evaluate(() => window.__lab!.renderer.frameContext!.renderSize);
    expect(size).toEqual([2560, 1440]);
    await saveScreenshot(page, 'render-core', 'perf-1440p-scene');

    // (1) GPU otherwise idle: for the record only.
    const idle = await measure(page, 330);
    const i = summarise(idle);
    console.log(`idle GPU    (p99 ms @ ${size.join('x')}): ${fmt(i.core)}; total ${i.total.toFixed(3)}; G-buffer ${i.gbuffer.toFixed(3)} + shadows ${i.shadows.toFixed(3)}; frame GPU p50 ${idle.perf.gpu.p50.toFixed(2)} ms`);

    // (2) With a ballast of about 7 ms per frame, as in the integrated game.
    const perIteration = await page.evaluate(async () => {
      window.__rc!.probes.setHeavy(400);
      await window.__test!.waitFrames(90);
      window.__test!.resetPerf();
      await window.__test!.waitFrames(60);
      return (window.__lab!.renderer.passStats()['lab-heavy.burn']?.p50 ?? 0) / 400;
    });
    expect(perIteration).toBeGreaterThan(0);
    await page.evaluate((n) => window.__rc!.probes.setHeavy(n), Math.round(7 / perIteration));
    const r = await measure(page, 330);
    const s = summarise(r);
    const ballast = r.passes['lab-heavy.burn']?.p50 ?? 0;
    console.log(`loaded GPU  (p99 ms, ballast ${ballast.toFixed(1)} ms): ${fmt(s.core)}; total ${s.total.toFixed(3)} (budget 3.0)`);
    console.log(`1.5 M triangle scene: ${r.tris.triangles} tris in the G-buffer; G-buffer p99 ${s.gbuffer.toFixed(3)} ms + shadows amortised ${s.shadows.toFixed(3)} ms = ${(s.gbuffer + s.shadows).toFixed(3)} (budget 2.0)`);
    console.log(`frame: GPU p50 ${r.perf.gpu.p50.toFixed(2)} p99 ${r.perf.gpu.p99.toFixed(2)} ms; CPU p50 ${r.perf.cpu.p50.toFixed(2)} p99 ${r.perf.cpu.p99.toFixed(2)} ms (idle run: p50 ${idle.perf.cpu.p50.toFixed(2)} p99 ${idle.perf.cpu.p99.toFixed(2)}); rAF p95 ${r.perf.raf.p95.toFixed(2)} ms`);
    console.log(`features (p99 GPU ms): ${JSON.stringify(Object.fromEntries(Object.entries(r.perf.features).map(([k, v]) => [k, +v.gpuMs.toFixed(3)])))}`);

    expect(ballast).toBeGreaterThan(5);
    expect(r.tris.triangles).toBeGreaterThanOrEqual(1_500_000);
    expect(r.perf.qualityScale).toBe(1);
    expect(r.perf.renderScale).toBe(1);
    expect(s.core.aoContact).toBeLessThanOrEqual(0.6);
    expect(s.core.lighting).toBeLessThanOrEqual(1.0);
    expect(s.core.taa).toBeLessThanOrEqual(0.55);
    expect(s.core.bloom).toBeLessThanOrEqual(0.3);
    expect(s.core.tonemapExposure).toBeLessThanOrEqual(0.2);
    expect(s.core.depthPyramid).toBeLessThanOrEqual(0.35);
    expect(s.total).toBeLessThanOrEqual(3.0);
    expect(s.gbuffer + s.shadows).toBeLessThan(2.0);
    expect(r.perf.cpu.p99).toBeLessThan(2.0);
    // The per-feature breakdown is complete: every feature and the core have a row.
    expect(Object.keys(r.perf.features)).toEqual(expect.arrayContaining(['core', 'lab-planet', 'lab-stand', 'lab-heavy']));
    expect(r.perf.features['lab-stand']!.gpuMs).toBeGreaterThan(0);
    await expectNoErrors(page, pageLog);
  });
});
