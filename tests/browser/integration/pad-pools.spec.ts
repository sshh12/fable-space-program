/**
 * The game on the pad at its stated resolution (2560 x 1440 internal, ARCHITECTURE 17), requests
 * app-integration-6 and -7:
 *  - the view fits into the terrain's fixed tile pools: nothing waits for a layer, the terrain comes to rest
 *    (`window.__test.isIdle()`), and the streamer's share of the main thread is what an idle streamer costs;
 *  - a round trip through the map view shows the ground as it was left: the tiles of the view stay resident
 *    (no re-streaming on the way back) and the deepest level is there in the first frame after the blend.
 *
 *   node tools/dev/heavy.mjs --class=gpu -- npx playwright test tests/browser/integration/pad-pools.spec.ts --project=functional
 *
 * Numbers go to out/core-support/pad-pools.json.
 */
import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';
import { assertDiscreteGpu, expect, expectNoErrors, openPage, saveScreenshot, test, waitIdle } from '../harness';
import { repoRoot } from './helpers';

test.setTimeout(15 * 60_000);
test.use({ viewport: { width: 2560, height: 1440 } });

interface Stream {
  queued: number;
  loading: number;
  uploading: number;
  ready: number;
  stalled: number;
  stalledTotal: number;
  droppedTotal: number;
  uploadedTotal: number;
  evictedTotal: number;
  freeTileLayers: number;
  demandTiles: number;
  demandImages: number;
  lodScale: number;
}

function record(key: string, value: unknown): void {
  const dir = path.join(repoRoot, 'out', 'core-support');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'pad-pools.json');
  const all = (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {}) as Record<string, unknown>;
  all[key] = value;
  fs.writeFileSync(file, JSON.stringify(all, null, 1));
  console.log(`  ${key}: ${JSON.stringify(value)}`);
}

const terrain = (page: import('@playwright/test').Page): Promise<{ stream: Stream; earth: { deepestLevel: number; nodes: number; fading: number; K: number } }> =>
  page.evaluate(() => {
    const t = window.__app!.terrainStats();
    return { stream: t.stream as unknown as Stream, earth: t.bodies['earth'] as unknown as { deepestLevel: number; nodes: number; fading: number; K: number } };
  });

/** Mean absolute difference per channel (0..255) and the share of pixels that differ by more than 24. */
function diff(a: Buffer, b: Buffer): { mean: number; changed: number } {
  const p = PNG.sync.read(a);
  const q = PNG.sync.read(b);
  let sum = 0;
  let changed = 0;
  const n = p.width * p.height;
  for (let i = 0; i < n; i++) {
    let worst = 0;
    for (let c = 0; c < 3; c++) {
      const d = Math.abs(p.data[i * 4 + c]! - q.data[i * 4 + c]!);
      sum += d;
      if (d > worst) worst = d;
    }
    if (worst > 24) changed++;
  }
  return { mean: sum / (3 * n), changed: changed / n };
}

test('the pad at 1440p fits the tile pools, comes to rest, and a map round trip shows the ground as it was left', async ({ page, pageLog }) => {
  await openPage(page, '/?capture=0&scale=1&governor=off&mute=1', { timeoutMs: 240_000 });
  await assertDiscreteGpu(page);
  // It comes to rest at all: with the vessel observer's bounding sphere the view asked for 1,660 of 1,280 tile
  // layers, 380 tiles waited for a layer for ever and this wait never returned.
  await waitIdle(page, 30, 180_000);
  // Seconds from the page's navigation to the terrain at rest (the load: of it the terrain's part is the stream).
  const restAt = (await page.evaluate(() => performance.now())) / 1000;
  const rest = await terrain(page);
  expect(rest.stream.stalled, 'tiles waiting for a layer').toBe(0);
  expect(rest.stream.uploading + rest.stream.queued + rest.stream.loading).toBe(0);
  expect(rest.stream.droppedTotal, 'tiles given up for want of room').toBe(0);
  expect(rest.earth.deepestLevel).toBe(20);
  expect(rest.stream.demandTiles).toBeLessThanOrEqual(0.93 * 1280);
  expect(rest.stream.lodScale).toBeGreaterThan(0.85);
  expect(rest.stream.lodScale).toBeLessThanOrEqual(1);

  // Main thread of the terrain over 300 frames at rest.
  const cpu = await page.evaluate(async () => {
    window.__test!.resetPerf();
    const rows: Record<string, number>[] = [];
    for (let i = 0; i < 300; i++) {
      await window.__test!.waitFrames(1);
      rows.push({ ...window.__app!.terrainStats().cpu });
    }
    const out: Record<string, { p50: number; p99: number }> = {};
    for (const k of Object.keys(rows[0]!)) {
      const v = rows.map((x) => x[k]!).sort((a, b) => a - b);
      out[k] = { p50: Math.round(v[150]! * 1000) / 1000, p99: Math.round(v[296]! * 1000) / 1000 };
    }
    const app = window.__app!.cpu();
    return { terrain: out, frame: { p50: app.frame.p50, p99: app.frame.p99 } };
  });
  record('pad-1440p', { restAtSeconds: Math.round(restAt * 10) / 10, stream: rest.stream, earth: rest.earth, cpu });
  // The streamer at rest: requests, dispatch and uploads of nothing (it was 2.6 ms p50 looking for a layer).
  expect(cpu.terrain['stream']!.p99, 'streamer main-thread p99, ms').toBeLessThan(0.5);
  const still = await saveScreenshot(page, 'core-support', 'pad-1440p-rest');

  // Into the map for three seconds and back.
  await page.evaluate(() => window.__test!.setView!('map'));
  await page.waitForFunction(() => !window.__app!.viewBlending(), undefined, { timeout: 30_000, polling: 'raf' });
  await page.evaluate(() => window.__test!.waitFrames(180));
  const inMap = await terrain(page);
  // The vessel's ground keeps its depth under the map camera (it fell to level 11: the camera's warp cap).
  expect(inMap.earth.deepestLevel).toBe(20);
  await page.evaluate(() => window.__test!.setView!('chase'));
  await page.waitForFunction(() => !window.__app!.viewBlending(), undefined, { timeout: 30_000, polling: 'raf' });
  const back = await terrain(page);
  const first = await saveScreenshot(page, 'core-support', 'pad-1440p-back-first');
  await page.evaluate(() => window.__test!.waitFrames(45));
  const later = await terrain(page);
  const settled = await saveScreenshot(page, 'core-support', 'pad-1440p-back-settled');
  await waitIdle(page, 8, 60_000);
  const idle = await terrain(page);
  const round = {
    uploadedInMap: inMap.stream.uploadedTotal - rest.stream.uploadedTotal,
    evictedInMap: inMap.stream.evictedTotal - rest.stream.evictedTotal,
    uploadedAfterReturn: idle.stream.uploadedTotal - inMap.stream.uploadedTotal,
    deepest: { rest: rest.earth.deepestLevel, inMap: inMap.earth.deepestLevel, firstFrameBack: back.earth.deepestLevel, later: later.earth.deepestLevel },
    firstFrameVsBefore: diff(still.buffer, first.buffer),
    settledVsBefore: diff(still.buffer, settled.buffer),
  };
  record('map-round-trip-1440p', round);
  // The first frame after the blend has the finest level again, and nothing of the view had to be streamed anew.
  expect(back.earth.deepestLevel).toBe(20);
  expect(round.uploadedAfterReturn, 'tiles streamed again after the return').toBeLessThanOrEqual(8);
  // The picture is the one that was left. In the first frame the temporal resolve is still gathering after the
  // 0.6 s flight of the camera (lattice towers and markings a little soft: 5 % of the pixels); three quarters of
  // a second later only the clouds have drifted. (With the ground gone to its coarse parents the first frame
  // had the land as sea: a third of the pixels.)
  expect(round.firstFrameVsBefore.changed, 'share of pixels that differ in the first frame back').toBeLessThan(0.09);
  expect(round.firstFrameVsBefore.mean).toBeLessThan(7);
  expect(round.settledVsBefore.changed).toBeLessThan(0.02);
  await expectNoErrors(page, pageLog);
});
