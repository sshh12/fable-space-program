import type { Page } from '@playwright/test';
import { assertDiscreteGpu, expect, expectNoErrors, openPage, saveScreenshot, test, waitIdle, withGpuLock } from '../harness';

test.use({ viewport: { width: 2560, height: 1440 } });

/**
 * ARCHITECTURE 17.1, line "Sky background + probe + flare (sky-lighting)": 0.2 ms, 0.3 ms in orbit where the
 * whole frame is sky; brief: background under 0.08 ms with the sky covering half the frame, probe under 0.08 ms
 * per frame amortised, flare under 0.04 ms. 1440p internal, qualityScale 1, attribution mode (every hook of the
 * feature in its own timed pass: 'sky.background', 'sky.transparent'; own passes 'sky.probe', 'sky.flareVis').
 *
 * Scene: low orbit, the camera on the vessel looking at the horizon (the Earth fills the lower half, space the
 * upper half), the sun 12 deg above the horizon in view (flare drawn), all stars and the Milky Way, the probe
 * cycling. As in core.perf.spec.ts the GPU is kept as busy as a game frame by a ~7 ms ballast pass (an RTX 5090
 * with 1-2 ms of work clocks down and reads 2-5 x slower); idle numbers are logged for the record.
 */
async function measure(page: Page, frames: number): Promise<Record<string, { p50: number; p99: number; mean: number }>> {
  return page.evaluate(async (n) => {
    await window.__test!.waitFrames(90);
    window.__test!.resetPerf();
    await window.__test!.waitFrames(n);
    return window.__lab!.renderer.passStats();
  }, frames);
}

function summary(s: Record<string, { p50: number; p99: number; mean: number }>): { background: number; probeMean: number; probeP99: number; flare: number; total: number } {
  const g = (k: string) => s[k] ?? { p50: 0, p99: 0, mean: 0 };
  const background = g('sky.background').p99;
  const probe = ['sky.probe.face', 'sky.probe.mips', 'sky.probe.prefilter'].map(g);
  const probeMean = probe.reduce((acc, x) => acc + x.mean, 0);
  const flare = g('sky.flareVis').p99 + g('sky.transparent').p99;
  return { background, probeMean, probeP99: Math.max(...probe.map((x) => x.p99)), flare, total: background + probeMean + flare };
}

test('sky background, probe and flare within their GPU budget at 1440p', async ({ page, pageLog }) => {
  test.setTimeout(30 * 60_000);
  await withGpuLock(async () => {
    await openPage(page, '/labs/sky/?scene=lowOrbit&perf=features&scale=1&governor=off&heavy=0&hud=0');
    await assertDiscreteGpu(page);
    await page.evaluate(() => {
      window.__sky!.setSunForVessel({ elevationDeg: -2, azimuthDeg: 0 });
      window.__lab!.onFrame((s) => {
        const v = s.vessels[0]!;
        const e = s.bodies.find((b) => b.id === v.bodyId)!;
        const up0 = { x: v.rRoot.x - e.rRoot.x, y: v.rRoot.y - e.rRoot.y, z: v.rRoot.z - e.rRoot.z };
        const l = Math.hypot(up0.x, up0.y, up0.z);
        const up = { x: up0.x / l, y: up0.y / l, z: up0.z / l };
        // North in the horizontal plane, then 14.2 deg down: the horizon through the image centre.
        const n0 = { x: -up.z * up.x, y: -up.z * up.y, z: 1 - up.z * up.z };
        const nl = Math.hypot(n0.x, n0.y, n0.z);
        const dip = (14.17 * Math.PI) / 180;
        const f = { x: (n0.x / nl) * Math.cos(dip) - up.x * Math.sin(dip), y: (n0.y / nl) * Math.cos(dip) - up.y * Math.sin(dip), z: (n0.z / nl) * Math.cos(dip) - up.z * Math.sin(dip) };
        window.__sky!.lookFrom(v.rRoot, f, up, 60);
      });
    });
    await waitIdle(page, 120, 300_000);
    const size = await page.evaluate(() => window.__lab!.renderer.frameContext!.renderSize);
    expect(size).toEqual([2560, 1440]);
    const skyFraction = await page.evaluate(async () => {
      const d = await window.__lab!.renderer.readDepth();
      let n = 0;
      for (const v of d.data) if (v === 0) n++;
      return n / d.data.length;
    });
    await saveScreenshot(page, 'sky', 'perf-1440p-leo-horizon');

    const idle = summary(await measure(page, 330));
    console.log(`idle GPU   (ms): background p99 ${idle.background.toFixed(4)}, probe mean ${idle.probeMean.toFixed(4)} (p99 ${idle.probeP99.toFixed(4)}), flare p99 ${idle.flare.toFixed(4)}`);

    const perIteration = await page.evaluate(async () => {
      window.__sky!.setHeavy(400);
      await window.__test!.waitFrames(90);
      window.__test!.resetPerf();
      await window.__test!.waitFrames(60);
      return (window.__lab!.renderer.passStats()['sky-lab-heavy.burn']?.p50 ?? 0) / 400;
    });
    expect(perIteration).toBeGreaterThan(0);
    await page.evaluate((n) => window.__sky!.setHeavy(n), Math.round(7 / perIteration));
    const stats = await measure(page, 330);
    const s = summary(stats);
    const ballast = stats['sky-lab-heavy.burn']?.p50 ?? 0;
    const perf = await page.evaluate(() => window.__test!.perf()!);
    console.log(`loaded GPU (ms, ballast ${ballast.toFixed(1)} ms, sky ${(skyFraction * 100).toFixed(1)} % of the frame): background p99 ${s.background.toFixed(4)} (budget 0.08), probe mean ${s.probeMean.toFixed(4)} p99 ${s.probeP99.toFixed(4)} (budget 0.08 amortised), flare p99 ${s.flare.toFixed(4)} (budget 0.04), sum ${s.total.toFixed(4)} (line 0.3 in orbit)`);
    console.log(`feature row 'sky' (p99 GPU): ${perf.features['sky']?.gpuMs.toFixed(4)} ms; qualityScale ${perf.qualityScale}, renderScale ${perf.renderScale}`);
    const row = (k: string) => `${k} p50 ${(stats[k]?.p50 ?? 0).toFixed(4)} p99 ${(stats[k]?.p99 ?? 0).toFixed(4)} mean ${(stats[k]?.mean ?? 0).toFixed(4)}`;
    console.log(['sky.background', 'sky.probe.face', 'sky.probe.mips', 'sky.probe.prefilter', 'sky.flareVis', 'sky.transparent', 'core.taa', 'core.lighting', 'core.background.clear', 'sky-lab-heavy.tail'].map(row).join('\n'));
    expect(ballast).toBeGreaterThan(5);
    expect(skyFraction).toBeGreaterThan(0.4);
    expect(skyFraction).toBeLessThan(0.6);
    expect(perf.qualityScale).toBe(1);
    expect(perf.renderScale).toBe(1);
    expect(stats['sky.flareVis']?.p50 ?? 0).toBeGreaterThan(0);
    expect(s.background).toBeLessThan(0.08);
    expect(s.probeMean).toBeLessThan(0.08);
    expect(s.flare).toBeLessThan(0.04);
    expect(s.total).toBeLessThan(0.2);
    await expectNoErrors(page, pageLog);
  });
});
