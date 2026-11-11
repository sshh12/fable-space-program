/**
 * The integration lab itself: it boots with whichever render packages are in the tree, a missing package is
 * simply absent, and a package whose owner has delivered must load without a problem.
 */
import { NEAR_PLANE } from '../../../src/core/contracts/render';
import { expect, test } from '../harness';
import { delivered, expectClean, freeze, openIntegration, record, requireFeatures, save, settle, type FeaturePackage } from './helpers';

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

test('with the cockpit loaded the capsule windows belong to the cockpit: the cabin is seen through them from outside; the vehicle alone closes them (request cockpit-8)', async ({ page, pageLog }) => {
  const DISTANCE = 1.2;
  /** View distance (m) of what the middle of the frame shows: median over a block of 21 x 21 pixels. */
  const centreDistance = (): Promise<number> =>
    page.evaluate(async (near) => {
      await window.__test!.waitFrames(20);
      const depth = await window.__lab!.renderer.readDepth();
      const d: number[] = [];
      for (let y = -10; y <= 10; y++) for (let x = -10; x <= 10; x++) d.push(depth.data[(Math.floor(depth.height / 2) + y) * depth.width + Math.floor(depth.width / 2) + x]!);
      d.sort((a, b) => a - b);
      const z = d[Math.floor(d.length / 2)]!;
      return z > 0 ? near / z : Infinity;
    }, NEAR_PLANE);

  // Every package: the camera 1.2 m outside a window, on the line from the seat through its centre.
  const info = await openIntegration(page, 'scene=lowOrbit&hud=0');
  requireFeatures(test, info, ['vehicle', 'cockpit']);
  const at = await page.evaluate((d) => window.__integration!.lookInThroughWindow(d), DISTANCE);
  expect(at, 'a cockpit model with a window').not.toBeNull();
  const open = await centreDistance();
  await save(page, 'lab-window-from-outside');
  await expectClean(page, pageLog, info);

  // The vehicle alone: the same camera looks at the closed outer pane.
  const alone = await openIntegration(page, 'scene=lowOrbit&hud=0&without=cockpit');
  expect(alone.loaded).not.toContain('cockpit');
  expect(await page.evaluate(([d, c]) => window.__integration!.lookInThroughWindow(d as number, c as { x: number; y: number; z: number }), [DISTANCE, at!.centre] as const)).not.toBeNull();
  const closed = await centreDistance();
  await save(page, 'lab-window-from-outside-without-cockpit');
  console.log(`capsule window ${at!.window} from ${DISTANCE} m outside: with the cockpit the middle of the frame is ${open.toFixed(2)} m away (the cabin behind the glazing), with the vehicle alone ${closed.toFixed(2)} m (its outer pane)`);
  record('lab.window', { window: at!.window, open, closed });
  // The pane sits at the window (the centre the cockpit reports lies within a hand's width of it) ...
  expect(closed).toBeGreaterThan(DISTANCE - 0.25);
  expect(closed).toBeLessThan(DISTANCE + 0.25);
  // ... and with the cockpit the eye goes on into the cabin: the couch and the far wall, not a sheet.
  expect(open).toBeGreaterThan(DISTANCE + 0.4);
  await expectClean(page, pageLog, alone);
});

