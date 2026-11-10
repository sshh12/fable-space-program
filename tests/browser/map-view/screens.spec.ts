/**
 * Visual review screenshots (out/screens/map-view/*.png): every lab scene, close-ups of the synthetic
 * chain around the Earth and the Moon (current-position and at-intercept drawing), and the node gizmo
 * with its panel. Each is asserted to be a real image; all are reviewed by eye.
 */
import { assertRealImage, expect, expectNoErrors, saveScreenshot, test } from '../harness';
import { frames, MAP_SPEC_TIMEOUT_MS, openLab } from './helpers';

test.setTimeout(MAP_SPEC_TIMEOUT_MS);

const SCENES: [string, string][] = [
  ['lowOrbit', 'scene=lowOrbit&paused=1'],
  ['translunar', 'scene=translunar&paused=1'],
  ['lunarOrbit', 'scene=lunarOrbit&paused=1'],
  ['synthetic', 'scene=synthetic'],
  ['synthetic-intercept', 'scene=synthetic&intercept=1'],
];

for (const [name, query] of SCENES) {
  test(`screenshot: ${name}`, async ({ page, pageLog }) => {
    await openLab(page, query);
    await frames(page, 5);
    const shot = await saveScreenshot(page, 'map-view', `scene-${name}`);
    expect(shot.stats.width).toBe(1280);
    assertRealImage(shot.stats, name, { minNonBlack: 0.002, minStd: 2, minBuckets: 20 });
    await expectNoErrors(page, pageLog);
  });
}

test('screenshot: low orbit with a planned burn, gizmo and panel', async ({ page, pageLog }) => {
  await openLab(page, 'scene=lowOrbit&paused=1');
  await page.evaluate(() => {
    const t = window.__test!;
    const s = t.state()!;
    const id = t.commands!.addNode(s.ut + 1500);
    t.commands!.setNode(id, { dv: { prograde: 420, normal: 60, radial: -40 } });
    (window as unknown as { __mapLab: { view: { selectNode(id: string): void } } }).__mapLab.view.selectNode(id);
  });
  await frames(page, 5);
  const shot = await saveScreenshot(page, 'map-view', 'lowOrbit-node');
  assertRealImage(shot.stats, 'lowOrbit-node', { minNonBlack: 0.002, minStd: 2, minBuckets: 20 });
  await expect(page.locator('[data-map-panel]')).toBeVisible();
  await expectNoErrors(page, pageLog);
});

const CLOSEUPS: [string, string, string | null][] = [
  ['synthetic-earth', 'scene=synthetic&dist=9e7', 'node-b'],
  ['synthetic-moon', 'scene=synthetic&dist=1.4e8', 'node-a'],
  ['synthetic-moon-intercept', 'scene=synthetic&dist=1.4e8&intercept=1', 'node-a'],
];

for (const [name, query, node] of CLOSEUPS) {
  test(`screenshot: ${name}`, async ({ page, pageLog }) => {
    await openLab(page, query);
    await page.evaluate(
      ([n, moon, ghost]) => {
        const lab = (window as unknown as { __mapLab: { view: { selectNode(id: string | null): void }; setFocus(f: { bodyId?: string }): void } }).__mapLab;
        const s = window.__test!.state()!;
        const moonId = s.bodies.find((b) => b.orbit !== null)!.id;
        if (moon) lab.setFocus({ bodyId: ghost ? `${moonId}@intercept` : moonId });
        lab.view.selectNode(n);
      },
      [node, name.includes('moon'), name.includes('intercept')] as const,
    );
    await frames(page, 5);
    const shot = await saveScreenshot(page, 'map-view', name);
    assertRealImage(shot.stats, name, { minNonBlack: 0.002, minStd: 2, minBuckets: 20 });
    await expectNoErrors(page, pageLog);
  });
}
