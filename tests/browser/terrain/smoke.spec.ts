import { expect, expectNoErrors, test } from '../harness';
import { openLab, settle, shot, terrainStats } from './util';

test('terrain lab boots, streams tiles for both bodies and draws the low-orbit scene', async ({ page, pageLog }) => {
  await openLab(page, { scene: 'lowOrbit', sun: '120,50' });
  await settle(page, 8, 60_000);
  const stats = await terrainStats(page);
  expect(Object.keys(stats.bodies).sort()).toEqual(['earth', 'moon']);
  expect(stats.bodies.earth!.visible).toBeGreaterThan(10);
  expect(stats.stream.ready).toBeGreaterThan(100);
  // Fixed pools: the arrays are allocated once and stay about 1.1 GB.
  expect(stats.stream.poolBytes).toBeLessThan(1.15 * 2 ** 30);
  const s = await shot(page, 'smoke-low-orbit');
  expect(s.stats.fractionNonBlack).toBeGreaterThan(0.2);
  // Progress numbers for a loading screen (request app-integration-11): at rest every wanted tile is resident,
  // level by level, and nothing compiles or loads.
  const progress = await page.evaluate(() => {
    const core = window.__lab!.renderer.core;
    return { earth: window.__terrain!.debug.residency('earth'), none: window.__terrain!.debug.residency('no-such-body'), shaders: core.shaders.compilations(), textures: core.meshes.loads() };
  });
  expect(progress.none).toBeNull();
  const e = progress.earth!;
  expect(e.wanted.length).toBe(21);
  expect(e.wantedLevel).toBeGreaterThanOrEqual(4);
  expect(e.residentLevel).toBe(e.wantedLevel);
  expect(e.resident).toEqual(e.wanted);
  expect(e.wanted.reduce((a, b) => a + b, 0)).toBeGreaterThan(50);
  expect(e.wanted.slice(e.wantedLevel + 1).every((n) => n === 0)).toBe(true);
  expect(progress.shaders.pending).toBe(0);
  expect(progress.shaders.total).toBeGreaterThan(5);
  expect(progress.textures.pending).toBe(0);
  expect(progress.textures.total).toBeGreaterThanOrEqual(0);
  // The view fits the pools: nothing waits for a layer, nothing was given up, the ranges are at full size.
  expect(stats.stream.stalled).toBe(0);
  expect(stats.stream.droppedTotal).toBe(0);
  expect(stats.lodScale).toBe(1);
  await expectNoErrors(page, pageLog);
});
