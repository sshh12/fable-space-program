/**
 * The integration lab itself: it boots with whichever render packages are in the tree, a missing package is
 * simply absent, and a package whose owner has delivered must load without a problem.
 */
import { expect, test } from '../harness';
import { delivered, expectClean, freeze, openIntegration, record, save, settle, type FeaturePackage } from './helpers';

test.describe.configure({ timeout: 600_000 });

test('the lab loads every package that is in the tree; delivered packages build and initialise without problems', async ({ page, pageLog }) => {
  const info = await openIntegration(page, 'scene=lowOrbit&hud=0');
  console.log(`integration lab: in the tree [${info.available.join(', ')}], loaded [${info.loaded.join(', ')}], features [${info.featureIds.join(', ')}]`);
  for (const p of info.problems) console.log(`  problem: ${p}`);
  record('lab', { available: info.available, loaded: info.loaded, problems: info.problems, quarantined: info.quarantined, featureIds: info.featureIds });

  // A package whose owner has handed off must be loaded, and none of the recorded problems may be its.
  const all: FeaturePackage[] = ['terrain', 'vehicle', 'cockpit', 'ocean', 'sky', 'atmosphere', 'vfx'];
  for (const p of all.filter(delivered)) {
    expect(info.loaded, `${p} is delivered and must load`).toContain(p);
    expect(info.problems.filter((x) => x.startsWith(`${p}:`)), `${p} is delivered`).toEqual([]);
  }
  // Without the terrain package the LabPlanet stands in, so there is always a planet to look at.
  expect(info.featureIds.length).toBeGreaterThan(0);
  if (!info.loaded.includes('terrain')) expect(info.featureIds).toContain('lab-planet');

  await freeze(page);
  await settle(page);
  const shot = await save(page, 'lab-low-orbit');
  expect(shot.width).toBe(1280);
  await expectClean(page, pageLog, info);
});

test('a package can be left out: ?without= removes its features and nothing else', async ({ page, pageLog }) => {
  const all = await openIntegration(page, 'scene=lowOrbit&hud=0');
  test.skip(all.loaded.length === 0, 'no wave-2 render package is loaded yet');
  const drop = all.loaded[0]!;
  const fewer = await openIntegration(page, `scene=lowOrbit&hud=0&without=${drop}`);
  expect(fewer.loaded).toEqual(all.loaded.filter((p) => p !== drop));
  expect(fewer.featureIds.length).toBeLessThan(all.featureIds.length + (drop === 'terrain' ? 1 : 0));
  await expectClean(page, pageLog, fewer);
});
