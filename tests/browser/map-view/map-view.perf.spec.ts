/**
 * Overlay budget (ARCHITECTURE 17.1: map overlay up to 0.1 ms GPU, drawn only in map view; UI CPU 0.5 ms):
 * the 8-patch synthetic chain plus 20 debris orbits, the camera orbiting continuously so the whole scene
 * (adaptive sampling, projection, labels, upload) is rebuilt every frame. Measured under the GPU lock.
 */
import type { Page } from '@playwright/test';
import { expect, expectNoErrors, test, withGpuLock } from '../harness';
import { frames, openLab } from './helpers';

interface Pct {
  p50: number;
  p95: number;
  p99: number;
  max: number;
  count: number;
}
interface Perf {
  cpu: Pct;
  gpu: Pct | null;
  /** CPU split: MapView.update (hit-testing), feature.prepare (scene build, draw list, upload), drawOverlay (encoding). */
  phases: { update: Pct; prepare: Pct; draw: Pct };
}
const perf = (page: Page): Promise<Perf> => page.evaluate('window.__mapLab.perf()') as Promise<Perf>;

// The machine-wide GPU lock may be held by other packages' perf runs for many minutes.
test.setTimeout(25 * 60_000);

for (const [name, query] of [
  ['overview', 'scene=synthetic&perf=1&quiet=1&spin=0.002'],
  ['earth close-up', 'scene=synthetic&perf=1&quiet=1&spin=0.002&dist=9e7'],
] as const) {
  test(`map overlay budget (${name}): GPU p99 < 0.1 ms, CPU p99 < 0.5 ms`, async ({ page, pageLog }, testInfo) => {
    const result = await withGpuLock(async () => {
      await openLab(page, query);
      await frames(page, 90); // warm-up: pipelines, atlas, JIT
      await page.evaluate('window.__mapLab.resetPerf()');
      await frames(page, 600);
      return perf(page);
    });
    testInfo.annotations.push({ type: 'perf', description: JSON.stringify(result) });
    console.log(`[map-view perf ${name}] ${JSON.stringify(result)}`);
    expect(result.gpu, 'timestamp-query available').not.toBeNull();
    expect(result.gpu!.count).toBeGreaterThan(300);
    expect(result.gpu!.p99).toBeLessThan(0.1);
    expect(result.cpu.count).toBeGreaterThan(500);
    expect(result.cpu.p99).toBeLessThan(0.5);
    await expectNoErrors(page, pageLog);
  });
}
