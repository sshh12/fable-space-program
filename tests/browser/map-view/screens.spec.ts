/**
 * Visual review screenshots (out/screens/map-view/*.png): every lab scene, close-ups of the synthetic
 * chain around the Earth and the Moon (current-position and at-intercept drawing), and the node gizmo
 * with its panel. Each is asserted to be a real image; all are reviewed by eye.
 */
import { PNG } from 'pngjs';
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
  // The node lies just behind the Earth's limb; its gizmo is a control and keeps its full colour (prograde
  // handle #d7e85a, normal #e35cf5).
  const all = await page.evaluate(() => window.__test!.map());
  const node = all.find((e) => e.kind === 'node')!;
  expect(node.visible).toBe(false);
  const png = PNG.sync.read(shot.buffer);
  const peak = (id: string): [number, number, number] => {
    const h = all.find((e) => e.kind === 'nodeHandle' && e.id.endsWith(`/${id}`))!;
    const best: [number, number, number] = [0, 0, 0];
    for (let y = Math.round(h.y) - 6; y <= Math.round(h.y) + 6; y++) {
      for (let x = Math.round(h.x) - 6; x <= Math.round(h.x) + 6; x++) {
        const o = (y * png.width + x) * 4;
        if (png.data[o]! + png.data[o + 1]! + png.data[o + 2]! > best[0] + best[1] + best[2]) {
          best[0] = png.data[o]!;
          best[1] = png.data[o + 1]!;
          best[2] = png.data[o + 2]!;
        }
      }
    }
    return best;
  };
  const pro = peak('prograde');
  expect(pro[0]).toBeGreaterThan(190);
  expect(pro[1]).toBeGreaterThan(205);
  const nrm = peak('normal');
  expect(nrm[0]).toBeGreaterThan(200);
  expect(nrm[2]).toBeGreaterThan(215);
  await expectNoErrors(page, pageLog);
});

test('screenshot: a recovery zone near the limb (continuous ring, cut at the limb)', async ({ page, pageLog }) => {
  await openLab(page, 'scene=lowOrbit&paused=1&quiet=1');
  // Put the first recovery zone 82 degrees from the sub-camera point.
  await page.evaluate(() => {
    const s = window.__test!.state()!;
    const z = s.surfaceTargets.find((t) => t.kind === 'recovery')!;
    const b = s.bodies.find((x) => x.id === z.bodyId)!;
    const q = b.qFixedToRoot;
    const d = { x: Math.cos(z.latitude) * Math.cos(z.longitude), y: Math.cos(z.latitude) * Math.sin(z.longitude), z: Math.sin(z.latitude) };
    // rotate the body-fixed direction into ROOT: v + 2w (q x v) + 2 q x (q x v)
    const cross = (a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }) => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });
    const t = cross(q, d);
    const tt = cross(q, t);
    const n = { x: d.x + 2 * q.w * t.x + 2 * tt.x, y: d.y + 2 * q.w * t.y + 2 * tt.y, z: d.z + 2 * q.w * t.z + 2 * tt.z };
    const side = { x: -n.y, y: n.x, z: 0 };
    const sl = Math.hypot(side.x, side.y) || 1;
    const a = (82 * Math.PI) / 180;
    const e = { x: n.x * Math.cos(a) + (side.x / sl) * Math.sin(a), y: n.y * Math.cos(a) + (side.y / sl) * Math.sin(a), z: n.z * Math.cos(a) };
    window.__test!.setCameraOrbit(Math.atan2(e.y, e.x), Math.asin(Math.max(-1, Math.min(1, e.z / Math.hypot(e.x, e.y, e.z)))), 1.6e7);
  });
  await frames(page, 5);
  const shot = await saveScreenshot(page, 'map-view', 'zone-near-limb');
  assertRealImage(shot.stats, 'zone-near-limb', { minNonBlack: 0.002, minStd: 2, minBuckets: 20 });
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

/**
 * The glyph atlas, icons and lines at device pixel ratio 2 (1920 x 1080 CSS px, a 3840 x 2160 frame): the node
 * editor in low orbit and the synthetic chain around the Moon. Labels must be as crisp as at 1x (the atlas is
 * rasterised at the device size), the panel the same CSS size.
 */
test.describe('device pixel ratio 2 (4K)', () => {
  test.use({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 2 });
  for (const [name, query, node] of [
    ['dpr2-lowOrbit-node', 'scene=lowOrbit&paused=1', null],
    ['dpr2-synthetic-moon', 'scene=synthetic&dist=1.4e8', 'node-a'],
  ] as const) {
    test(`screenshot: ${name}`, async ({ page, pageLog }) => {
      await openLab(page, query);
      await page.evaluate(
        ([n]) => {
          const lab = (window as unknown as { __mapLab: { view: { selectNode(id: string | null): void }; setFocus(f: { bodyId?: string }): void } }).__mapLab;
          const s = window.__test!.state()!;
          if (n) {
            lab.setFocus({ bodyId: s.bodies.find((b) => b.orbit !== null)!.id });
            lab.view.selectNode(n);
          } else {
            const id = window.__test!.commands!.addNode(s.ut + 1500);
            window.__test!.commands!.setNode(id, { dv: { prograde: 420, normal: 60, radial: -40 } });
            lab.view.selectNode(id);
          }
        },
        [node] as const,
      );
      await frames(page, 5);
      const shot = await saveScreenshot(page, 'map-view', name);
      expect(shot.stats.width).toBe(3840);
      assertRealImage(shot.stats, name, { minNonBlack: 0.002, minStd: 2, minBuckets: 20 });
      await expect(page.locator('[data-map-panel]')).toBeVisible();
      await expectNoErrors(page, pageLog);
    });
  }
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
