/**
 * ARCHITECTURE 17.1, line "Cockpit interior + displays (cockpit)": 1.2 ms at 1440p internal in the cockpit
 * view. Brief split: interior G-buffer + shadow under 0.8 ms, glass under 0.2 ms, display uploads under
 * 0.2 ms GPU and 0.4 ms CPU per frame on average.
 *
 * Attribution mode (?perf=features: every hook of the feature in its own timed pass 'cockpit.shadow' (summed
 * over the cascades drawn in a frame), 'cockpit.gbuffer', 'cockpit.transparent', 'cockpit.overlay'; the
 * display upload and mip passes are 'cockpit.mfdUpload' (the canvas drawn into mip 0 included), the per-frame
 * cabin light pass 'cockpit.ambient' and the cabin's own sun map 'cockpit.sunMap', both counted with the
 * interior), qualityScale 1, renderScale 1, governor off. As in
 * core.perf.spec.ts the GPU is kept as busy as a game frame by a ~7 ms ballast pass; the idle numbers are
 * logged for the record. Scene: low orbit from the commander's seat looking at the console and the forward
 * windows (sunlit cabin, both forward panes and the display cover glasses in view, the 12 m vessel cascade
 * re-rendered every frame).
 */
import type { Page } from '@playwright/test';
import { assertDiscreteGpu, expect, expectNoErrors, openPage, saveScreenshot, test, waitIdle, withGpuLock } from '../harness';

test.use({ viewport: { width: 2560, height: 1440 } });

type Stats = Record<string, { p50: number; p99: number; mean: number }>;

async function measure(page: Page, frames: number): Promise<{ gpu: Stats; cpu: { paints: number; cpuMs: number; frames: number }; prepareMs: number }> {
  return page.evaluate(async (n) => {
    await window.__test!.waitFrames(90);
    window.__test!.resetPerf();
    window.__cockpit!.resetDisplayStats();
    let prepare = 0;
    for (let i = 0; i < n; i += 30) {
      await window.__test!.waitFrames(30);
      prepare += window.__cockpit!.stats().prepareMs;
    }
    const st = window.__cockpit!.stats();
    return { gpu: window.__lab!.renderer.passStats(), cpu: st.displays, prepareMs: prepare / Math.ceil(n / 30) };
  }, frames);
}

function summary(s: Stats): { interior: number; shadowP99: number; shadowMean: number; gbuffer: number; ambient: number; sunMap: number; glass: number; overlay: number; uploadMean: number; uploadP99: number; total: number } {
  const g = (k: string): { p50: number; p99: number; mean: number } => s[k] ?? { p50: 0, p99: 0, mean: 0 };
  const gbuffer = g('cockpit.gbuffer').p99;
  const shadow = g('cockpit.shadow');
  const glass = g('cockpit.transparent').p99;
  const overlay = g('cockpit.overlay').p99;
  const upload = g('cockpit.mfdUpload');
  const ambient = g('cockpit.ambient').p99;
  const sunMap = g('cockpit.sunMap').p99;
  const interior = gbuffer + shadow.p99 + ambient + sunMap;
  return { interior, shadowP99: shadow.p99, shadowMean: shadow.mean, gbuffer, ambient, sunMap, glass, overlay, uploadMean: upload.mean, uploadP99: upload.p99, total: interior + glass + overlay + upload.mean };
}

const fmt = (x: number): string => x.toFixed(4);

test('cockpit interior, glass and displays within their budget at 1440p', async ({ page, pageLog }) => {
  test.setTimeout(30 * 60_000);
  await withGpuLock(async () => {
    await openPage(page, '/labs/cockpit/?scene=leo&perf=features&scale=1&governor=off&ballast=0', { timeoutMs: 180_000 });
    await assertDiscreteGpu(page);
    await waitIdle(page, 60, 300_000);
    const size = await page.evaluate(() => window.__lab!.renderer.frameContext!.renderSize);
    expect(size).toEqual([2560, 1440]);
    const st0 = await page.evaluate(() => window.__cockpit!.stats());
    expect(st0.lod).toBe('lod0');
    expect(st0.inside).toBe(true);
    await saveScreenshot(page, 'cockpit', 'perf-1440p-leo-seat');

    const idle = await measure(page, 330);
    const si = summary(idle.gpu);
    console.log(
      `idle GPU (ms): interior p99 ${fmt(si.interior)} (gbuffer ${fmt(si.gbuffer)}, shadow ${fmt(si.shadowP99)}, ambient ${fmt(si.ambient)}, sun map ${fmt(si.sunMap)}), glass p99 ${fmt(si.glass)}, uploads mean ${fmt(si.uploadMean)}, total ${fmt(si.total)}`,
    );

    // Calibrate the ballast while it runs, then hold about 7 ms of other GPU work per frame.
    const perIteration = await page.evaluate(async () => {
      window.__cockpit!.setBallast(400);
      await window.__test!.waitFrames(90);
      window.__test!.resetPerf();
      await window.__test!.waitFrames(60);
      return (window.__lab!.renderer.passStats()['cockpit-lab-ballast.burn']?.p50 ?? 0) / 400;
    });
    expect(perIteration).toBeGreaterThan(0);
    await page.evaluate((n) => window.__cockpit!.setBallast(n), Math.round(7 / perIteration));
    const busy = await measure(page, 330);
    const s = summary(busy.gpu);
    const burn = busy.gpu['cockpit-lab-ballast.burn']?.p50 ?? 0;
    const cpuPerFrame = busy.cpu.cpuMs / Math.max(1, busy.cpu.frames);
    const paintsPerFrame = busy.cpu.paints / Math.max(1, busy.cpu.frames);
    console.log(
      `busy GPU (ballast ${burn.toFixed(2)} ms) (ms): interior p99 ${fmt(s.interior)} (gbuffer ${fmt(s.gbuffer)}, shadow p99 ${fmt(s.shadowP99)} mean ${fmt(s.shadowMean)}, ambient ${fmt(s.ambient)}, sun map ${fmt(s.sunMap)}), glass p99 ${fmt(s.glass)}, overlay p99 ${fmt(s.overlay)}, uploads mean ${fmt(s.uploadMean)} (p99 ${fmt(s.uploadP99)}), total ${fmt(s.total)}`,
    );
    for (const [k, v] of Object.entries(busy.gpu)) if (k.startsWith('cockpit')) console.log(`  ${k}: p50 ${fmt(v.p50)} p99 ${fmt(v.p99)} mean ${fmt(v.mean)}`);
    console.log(`CPU (ms/frame): display paint+upload+mips ${fmt(cpuPerFrame)} (${paintsPerFrame.toFixed(3)} paints/frame), prepare ${fmt(busy.prepareMs)}`);
    expect(burn, 'ballast held').toBeGreaterThan(5);
    expect(s.interior, 'interior G-buffer + shadow + ambient + sun map p99').toBeLessThan(0.8);
    expect(s.glass, 'glass p99').toBeLessThan(0.2);
    expect(s.uploadMean, 'display uploads GPU, mean per frame').toBeLessThan(0.2);
    expect(cpuPerFrame, 'display uploads CPU, mean per frame').toBeLessThan(0.4);
    expect(s.total, 'cockpit total (ARCHITECTURE 17.1)').toBeLessThan(1.2);
    await expectNoErrors(page, pageLog);
  });
});
