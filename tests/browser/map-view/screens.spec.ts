/**
 * Visual review screenshots (out/screens/map-view/*.png): every lab scene, close-ups of the synthetic
 * chain around the Earth and the Moon (current-position and at-intercept drawing), and the node gizmo
 * with its panel. Each is asserted to be a real image; all are reviewed by eye.
 */
import { assertRealImage, expect, expectNoErrors, saveScreenshot, test } from '../harness';
import { frames, openLab } from './helpers';

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

test('screenshot: hover details on a marker and the add-maneuver preview on the orbit', async ({ page, pageLog }) => {
  await openLab(page, 'scene=synthetic&dist=1.4e8');
  await page.evaluate(() => {
    const s = window.__test!.state()!;
    (window as unknown as { __mapLab: { setFocus(f: { bodyId?: string }): void } }).__mapLab.setFocus({ bodyId: s.bodies.find((b) => b.orbit !== null)!.id });
  });
  await frames(page, 4);
  const impact = (await page.evaluate(() => window.__test!.map())).find((e) => e.kind === 'marker' && e.id === 'current/1/impact')!;
  expect(impact.visible).toBe(true);
  await page.mouse.move(impact.x + 2, impact.y + 1);
  await frames(page, 3);
  const tip = await saveScreenshot(page, 'map-view', 'hover-impact-details');
  assertRealImage(tip.stats, 'hover-impact-details', { minNonBlack: 0.002, minStd: 2, minBuckets: 20 });

  // A point on the visible orbit away from any marker: the add-maneuver preview appears there.
  await openLab(page, 'scene=lowOrbit&paused=1');
  const line = await page.evaluate(() => {
    type Scene = { verts: { sx: Float64Array; sy: Float64Array }; lines: { id: string; start: number; count: number }[]; vessels: { x: number; y: number }[] };
    const ctl = (window as unknown as { __mapLab: { view: { controller: { currentScene: Scene; hitTest(s: Scene, x: number, y: number, lines: boolean): { type: string } | null } } } }).__mapLab.view.controller;
    const sc = ctl.currentScene;
    const l = sc.lines.find((x) => x.id === 'current/0')!;
    const v = sc.vessels[0]!;
    // the first vertex, going forward from the vessel, that is a clickable part of the orbit 80+ px away
    for (let i = l.start; i < l.start + l.count; i++) {
      const x = sc.verts.sx[i]!;
      const y = sc.verts.sy[i]!;
      if (Math.hypot(x - v.x, y - v.y) > 80 && ctl.hitTest(sc, x, y, true)?.type === 'line') return { x, y };
    }
    throw new Error('no visible orbit point');
  });
  await page.mouse.move(line.x, line.y);
  await frames(page, 3);
  const add = await saveScreenshot(page, 'map-view', 'hover-add-maneuver');
  assertRealImage(add.stats, 'hover-add-maneuver', { minNonBlack: 0.002, minStd: 2, minBuckets: 20 });
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
    // Every panel field shows its whole text (multi-day times to the node included).
    const fields = await page.locator('[data-map-panel] input').evaluateAll((els) =>
      els.map((e) => ({ field: (e as HTMLInputElement).dataset['field'], value: (e as HTMLInputElement).value, fits: e.scrollWidth <= e.clientWidth })),
    );
    expect(fields).toHaveLength(6);
    for (const f of fields) expect(f.fits, `${f.field} "${f.value}"`).toBe(true);
    await expectNoErrors(page, pageLog);
  });
}
