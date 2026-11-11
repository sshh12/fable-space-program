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
  await expectNoErrors(page, pageLog);
});
