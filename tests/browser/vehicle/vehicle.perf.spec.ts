/**
 * GPU and CPU budget of the vessel and site features (brief): at 1440p internal, qualityScale 1, with the
 * full stack on the pad filling the view,
 *   vehicle G-buffer < 0.8 ms, vehicle shadows < 0.4 ms, site structures G-buffer + shadow < 0.5 ms (GPU, p99
 *   of timestamp queries), CPU instance update of the vessel feature < 0.3 ms.
 * Attribution mode (each hook in its own pass), governor off, a ballast of about 7 ms so the GPU runs at the
 * clock of a real frame (render-core hand-off 4.1). A second view from the tower at 15 m, where most of
 * the frame is LOD 0 geometry, is held to the same budgets.
 */
import type { Page } from '@playwright/test';
import { assertDiscreteGpu, expect, expectNoErrors, saveScreenshot, test, waitIdle, withGpuLock } from '../harness';
import { openLab } from './lab';

test.use({ viewport: { width: 2560, height: 1440 } });

interface Row {
  vehicleGbuffer: number;
  vehicleShadow: number;
  siteGbuffer: number;
  siteShadow: number;
  ballast: number;
  frameP99: number;
  triangles: number;
  shadowTriangles: number;
  instances: number;
  updateP50: number;
  updateP95: number;
  siteUpdateP50: number;
}

const PERF = 'perf=features&scale=1&governor=off';
const VIEWS = {
  // The 109 m stack and its tower from 96 m with a 60 degree lens: the stack spans the height of the frame.
  fill: 'scene=pad&sun=205,40&eye=60,-50,75&at=0,-50,0&fov=60',
  // From the tower at 15 m: the frame is filled by LOD 0 tank, interstage and arm geometry.
  tower: 'scene=pad&sun=205,40&eye=5,-62,-19.5&at=0,-55,0&fov=72',
};

/**
 * Three windows of 240 frames; the least disturbed one counts (the GPU is shared with other agents'
 * browser tests, and concurrent work can only add time to a pass).
 */
async function measure(page: Page): Promise<Row & { windows: string }> {
  const rows: Row[] = [];
  for (let w = 0; w < 3; w++) {
    rows.push(
      await page.evaluate(async (first) => {
        const lab = window.__veh!;
        await window.__test!.waitFrames(first ? 90 : 10);
        window.__test!.resetPerf();
        const update: number[] = [];
        const siteUpdate: number[] = [];
        for (let i = 0; i < 240; i++) {
          await window.__test!.waitFrames(1);
          update.push(lab.vehicle.stats.updateMs);
          siteUpdate.push(lab.site!.stats.updateMs);
        }
        update.sort((a, b) => a - b);
        siteUpdate.sort((a, b) => a - b);
        const ps = window.__lab!.renderer.passStats();
        const perf = window.__test!.perf()!;
        const p99 = (n: string): number => ps[n]?.p99 ?? 0;
        return {
          vehicleGbuffer: p99('vehicle.gbuffer'),
          vehicleShadow: p99('vehicle.shadow'),
          siteGbuffer: p99('site.gbuffer'),
          siteShadow: p99('site.shadow'),
          ballast: ps['lab-ballast.burn']?.p50 ?? 0,
          frameP99: perf.gpu.p99,
          triangles: lab.vehicle.stats.triangles,
          shadowTriangles: lab.vehicle.stats.shadowTriangles,
          instances: lab.vehicle.stats.instances,
          updateP50: update[120]!,
          updateP95: update[228]!,
          siteUpdateP50: siteUpdate[120]!,
        };
      }, w === 0),
    );
  }
  const cost = (r: Row): number => r.vehicleGbuffer + r.vehicleShadow + r.siteGbuffer + r.siteShadow;
  const best = rows.reduce((b, r) => (cost(r) < cost(b) ? r : b), rows[0]!);
  // The CPU figure is the quietest window's too: another agent's job on the same cores only adds time.
  const update = rows.reduce((b, r) => (r.updateP50 < b.updateP50 ? r : b), rows[0]!);
  return {
    ...best,
    updateP50: update.updateP50,
    updateP95: update.updateP95,
    windows: rows.map((r) => `${r.vehicleGbuffer.toFixed(3)}/${r.vehicleShadow.toFixed(3)}/${(r.siteGbuffer + r.siteShadow).toFixed(3)}/${r.updateP50.toFixed(3)}`).join(' '),
  };
}

test('vehicle and site budgets at 1440p with the full stack on the pad', async ({ page, pageLog }) => {
  test.setTimeout(30 * 60_000);
  await withGpuLock(async () => {
    // Calibrate the ballast under load: about 7 ms.
    await openLab(page, `${VIEWS.fill}&${PERF}&ballast=400`);
    await assertDiscreteGpu(page);
    await waitIdle(page, 60);
    const size = await page.evaluate(() => window.__lab!.renderer.frameContext!.renderSize);
    expect(size).toEqual([2560, 1440]);
    const per = await page.evaluate(async () => {
      await window.__test!.waitFrames(90);
      window.__test!.resetPerf();
      await window.__test!.waitFrames(60);
      return (window.__lab!.renderer.passStats()['lab-ballast.burn']?.p50 ?? 0) / 400;
    });
    expect(per).toBeGreaterThan(0);
    const iterations = Math.round(7 / per);

    const results: Record<string, Row & { windows: string }> = {};
    for (const [name, view] of Object.entries(VIEWS)) {
      await openLab(page, `${view}&${PERF}&ballast=${iterations}`);
      await waitIdle(page, 60);
      results[name] = await measure(page);
      await saveScreenshot(page, 'vehicle', `perf-${name}-1440p`);
      await expectNoErrors(page, pageLog);
    }
    for (const [name, r] of Object.entries(results)) {
      console.log(
        `${name.padEnd(6)}: vehicle G-buffer ${r.vehicleGbuffer.toFixed(3)} ms, vehicle shadows ${r.vehicleShadow.toFixed(3)} ms, site G-buffer ${r.siteGbuffer.toFixed(3)} + shadow ${r.siteShadow.toFixed(3)} ms (p99); ` +
          `instance update ${r.updateP50.toFixed(3)} ms p50 / ${r.updateP95.toFixed(3)} ms p95 (site ${r.siteUpdateP50.toFixed(3)} ms); ` +
          `${r.instances} instances, ${r.triangles} triangles, ${r.shadowTriangles} shadow triangles; frame p99 ${r.frameP99.toFixed(2)} ms, ballast ${r.ballast.toFixed(2)} ms; ` +
          `windows gbuffer/shadow/site/update: ${r.windows}`,
      );
    }
    for (const r of Object.values(results)) {
      expect(r.ballast).toBeGreaterThan(5);
      expect(r.vehicleGbuffer).toBeGreaterThan(0);
      expect(r.vehicleGbuffer).toBeLessThan(0.8);
      expect(r.vehicleShadow).toBeLessThan(0.4);
      expect(r.siteGbuffer + r.siteShadow).toBeLessThan(0.5);
      expect(r.updateP50).toBeLessThan(0.3);
    }
  });
});
