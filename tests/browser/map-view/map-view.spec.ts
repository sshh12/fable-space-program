/**
 * Map view acceptance in the real browser against the FakeSim (labs/map-view): node creation by clicking
 * the orbit, handle drags (plain and Shift), sliding a node in time, +1 orbit, typed values, delete,
 * occlusion of markers, the Moon's orbit and SOI, surface targets on rotating bodies, and pixel-stable
 * lines across zoom levels with a static camera.
 */
import type { Page } from '@playwright/test';
import { latLonToDir } from '../../../src/core/geo/cubeSphere';
import { quat } from '../../../src/core/math/quat';
import { expect, expectNoErrors, pngDiff, saveScreenshot, test } from '../harness';
import { describeMap, element, frames, lookAlong, MAP_SPEC_TIMEOUT_MS, moveInSteps, openLab, state } from './helpers';

test.setTimeout(MAP_SPEC_TIMEOUT_MS);

type Lab = {
  view: { selectedNodeId: string | null; setActive(a: boolean): void };
  stats(): { lines: { id: string; kind: string; visibleVertices: number }[] };
  setFocus(f: { bodyId?: string; vesselId?: string }): void;
  results(): { consumed: boolean }[];
};
/** Run `fn(window.__mapLab)` in the page (fn must be self-contained: it is sent as source text). */
const lab = <T>(page: Page, fn: (l: Lab) => T): Promise<T> => page.evaluate(`(${fn.toString()})(window.__mapLab)`) as Promise<T>;

/** lowOrbit seen from above the orbit plane: the whole orbit is a circle just outside the Earth disc. */
async function topView(page: Page): Promise<void> {
  const s = await state(page);
  await lookAlong(page, s.patches.current[0]!.conic.W, 2.4e7);
}

async function addNodeAtApoapsis(page: Page): Promise<string> {
  const ap = await element(page, 'marker', 'current/0/apoapsis');
  expect(ap.visible).toBe(true);
  await page.mouse.click(ap.x, ap.y);
  await page.waitForFunction(() => window.__test!.state()!.nodes.length === 1);
  await frames(page, 2);
  return (await state(page)).nodes[0]!.id;
}

async function dragHandle(page: Page, nodeId: string, handle: string, px: number): Promise<void> {
  const n = await element(page, 'node', nodeId);
  const h = await element(page, 'nodeHandle', `${nodeId}/${handle}`);
  const l = Math.hypot(h.x - n.x, h.y - n.y);
  const ux = (h.x - n.x) / l;
  const uy = (h.y - n.y) / l;
  await page.mouse.move(h.x, h.y);
  await frames(page, 1);
  await page.mouse.down();
  await frames(page, 1);
  await moveInSteps(page, h.x, h.y, h.x + ux * px, h.y + uy * px, 10);
  await page.mouse.up();
  await frames(page, 2);
}

test.describe('map view on the FakeSim', () => {
  test('click on the orbit adds a node with a dashed planned patch; handle drags edit delta-v', async ({ page, pageLog }) => {
    await openLab(page, 'scene=lowOrbit&paused=1');
    await topView(page);
    const camBefore = await page.evaluate(() => window.__test!.camera()!.qViewToRoot);
    const id = await addNodeAtApoapsis(page);
    const s1 = await state(page);
    expect(s1.nodes).toHaveLength(1);
    expect(s1.patches.planned[0]?.afterNodeId).toBe(id);
    const planned = (await lab(page, (l) => l.stats())).lines.find((x) => x.id === 'planned/0');
    expect(planned?.kind).toBe('planned');
    expect(planned!.visibleVertices).toBeGreaterThan(10);
    expect(await page.evaluate(() => window.__test!.camera()!.qViewToRoot)).toEqual(camBefore); // the click did not move the camera
    expect(await lab(page, (l) => l.view.selectedNodeId)).toBe(id);
    await saveScreenshot(page, 'map-view', 'accept-node-added');

    // The planned apoapsis before the burn (dv = 0: it coincides with the orbit).
    const earth = await element(page, 'body', s1.vessels[0]!.bodyId);
    const apBefore = await element(page, 'marker', 'planned/0/apoapsis');
    const altBefore = s1.patches.planned[0]!.markers.find((m) => m.kind === 'apoapsis')!.altitude!;

    // Prograde handle 100 px outward: +10 m/s.
    await dragHandle(page, id, 'prograde', 100);
    const s2 = await state(page);
    expect(s2.nodes[0]!.dv.prograde).toBeGreaterThan(9.5);
    expect(s2.nodes[0]!.dv.prograde).toBeLessThan(10.5);
    const altAfter = s2.patches.planned[0]!.markers.find((m) => m.kind === 'apoapsis')!.altitude!;
    expect(altAfter).toBeGreaterThan(altBefore + 20e3);
    const apAfter = await element(page, 'marker', 'planned/0/apoapsis');
    const dist = (p: { x: number; y: number }) => Math.hypot(p.x - earth.x, p.y - earth.y);
    expect(dist(apAfter)).toBeGreaterThan(dist(apBefore) + 0.5);
    await saveScreenshot(page, 'map-view', 'accept-prograde-drag');

    // Shift-drag: ten times finer.
    const before = s2.nodes[0]!.dv.prograde;
    await page.keyboard.down('Shift');
    await dragHandle(page, id, 'prograde', 100);
    await page.keyboard.up('Shift');
    const fine = (await state(page)).nodes[0]!.dv.prograde - before;
    expect(fine).toBeGreaterThan(0.95);
    expect(fine).toBeLessThan(1.05);
    // The pointer was consumed for the whole drag (the camera never moved).
    expect(await page.evaluate(() => window.__test!.camera()!.qViewToRoot)).toEqual(camBefore);
    await expectNoErrors(page, pageLog);
  });

  test('dragging the node slides it along the orbit; +1 orbit, typed values and delete', async ({ page, pageLog }) => {
    await openLab(page, 'scene=lowOrbit&paused=1');
    await topView(page);
    const id = await addNodeAtApoapsis(page);
    const s0 = await state(page);
    const earth = await element(page, 'body', s0.vessels[0]!.bodyId);
    const n = await element(page, 'node', id);
    const r = Math.hypot(n.x - earth.x, n.y - earth.y);
    const a0 = Math.atan2(n.y - earth.y, n.x - earth.x);
    // Seen from +W the motion is counter-clockwise in y-up axes: a decreasing atan2 angle in y-down screen axes.
    await page.mouse.move(n.x, n.y);
    await frames(page, 1);
    await page.mouse.down();
    await frames(page, 1);
    const uts: number[] = [s0.nodes[0]!.ut];
    for (let k = 1; k <= 10; k++) {
      const a = a0 - k * 0.05;
      await page.mouse.move(earth.x + r * Math.cos(a), earth.y + r * Math.sin(a));
      await frames(page, 2);
      uts.push((await state(page)).nodes[0]!.ut);
    }
    await page.mouse.up();
    await frames(page, 2);
    for (let i = 1; i < uts.length; i++) expect(uts[i]!).toBeGreaterThan(uts[i - 1]!);
    expect(uts[10]! - uts[0]!).toBeGreaterThan(300);

    // +1 orbit: exactly one period later; the node is still drawn.
    const period = s0.patches.current[0]!.conic.period!;
    const ut1 = (await state(page)).nodes[0]!.ut;
    const panel = page.locator('[data-map-panel]');
    await expect(panel).toBeVisible();
    await panel.locator('button[data-action="plusOrbit"]').click();
    await page.waitForFunction((t) => window.__test!.state()!.nodes[0]!.ut > t + 1, ut1);
    expect((await state(page)).nodes[0]!.ut).toBeCloseTo(ut1 + period, 3);
    await frames(page, 2);
    expect((await element(page, 'node', id)).visible).toBe(true);
    expect((await state(page)).patches.planned).toHaveLength(1);

    // Typed values are applied; the panel holds the pointer/keyboard while focused.
    const pro = panel.locator('input[data-field="prograde"]');
    await pro.click();
    await pro.fill('25');
    await pro.press('Enter');
    await page.waitForFunction(() => window.__test!.state()!.nodes[0]!.dv.prograde === 25);
    await frames(page, 2);
    expect((await lab(page, (l) => l.results())).slice(-1)[0]!.consumed).toBe(true);
    const ut = panel.locator('input[data-field="ut"]');
    const target = Math.round(((await state(page)).nodes[0]!.ut + 120.5) * 10) / 10;
    await ut.fill(target.toFixed(1));
    await ut.press('Enter');
    await page.waitForFunction((t) => Math.abs(window.__test!.state()!.nodes[0]!.ut - t) < 1e-3, target);
    await saveScreenshot(page, 'map-view', 'accept-panel');

    // Delete.
    await panel.locator('button[data-action="delete"]').click();
    await page.waitForFunction(() => window.__test!.state()!.nodes.length === 0);
    await frames(page, 2);
    await expect(panel).toBeHidden();
    await expectNoErrors(page, pageLog);
  });

  test('markers behind a body are faded out', async ({ page, pageLog }) => {
    await openLab(page, 'scene=lowOrbit&paused=1&quiet=1');
    const s = await state(page);
    const v = s.vessels[0]!;
    // In the orbit plane, on the vessel's side: periapsis (at the vessel) in front, apoapsis behind the Earth.
    const rl = Math.hypot(v.r.x, v.r.y, v.r.z);
    const W = s.patches.current[0]!.conic.W;
    await lookAlong(page, { x: v.r.x / rl + 0.15 * W.x, y: v.r.y / rl + 0.15 * W.y, z: v.r.z / rl + 0.15 * W.z }, 3e7);
    const ap = await element(page, 'marker', 'current/0/apoapsis');
    const pe = await element(page, 'marker', 'current/0/periapsis');
    expect(ap.visible).toBe(false);
    expect(pe.visible).toBe(true);
    const on = await saveScreenshot(page, 'map-view', 'accept-occlusion');
    await lab(page, (l) => l.view.setActive(false));
    await frames(page, 3);
    const off = await page.screenshot();
    const { PNG } = await import('pngjs');
    const A = PNG.sync.read(on.buffer);
    const B = PNG.sync.read(off);
    const diffAt = (x: number, y: number): number => {
      let m = 0;
      for (let dy = -2; dy <= 2; dy++)
        for (let dx = -2; dx <= 2; dx++) {
          const i = ((Math.round(y) + dy) * A.width + Math.round(x) + dx) * 4;
          for (let c = 0; c < 3; c++) m = Math.max(m, Math.abs(A.data[i + c]! - B.data[i + c]!));
        }
      return m;
    };
    expect(diffAt(ap.x, ap.y)).toBeLessThan(6); // nothing of the hidden marker is drawn
    expect(diffAt(pe.x, pe.y)).toBeGreaterThan(60); // the visible one is
    await expectNoErrors(page, pageLog);
  });

  test("the Moon's orbit and SOI are drawn in the translunar scene", async ({ page, pageLog }) => {
    await openLab(page, 'scene=translunar&paused=1');
    const s = await state(page);
    const moon = s.bodies.find((b) => b.orbit !== null)!;
    const stats = await lab(page, (l) => l.stats());
    expect(stats.lines.find((l) => l.id === `orbit:${moon.id}`)!.visibleVertices).toBeGreaterThan(20);
    expect(stats.lines.find((l) => l.id === `soi:${moon.id}`)!.visibleVertices).toBeGreaterThan(20);
    expect((await element(page, 'body', moon.id)).visible).toBe(true);
    await saveScreenshot(page, 'map-view', 'accept-translunar');
    await expectNoErrors(page, pageLog);
  });

  test('the landing target is drawn on the Moon (lunarOrbit) and recovery zones on the Earth (lowOrbit)', async ({ page, pageLog }) => {
    const facing = (s: Awaited<ReturnType<typeof state>>, kind: string) => {
      const t = s.surfaceTargets.find((x) => x.kind === kind)!;
      const b = s.bodies.find((x) => x.id === t.bodyId)!;
      return { t, dir: quat.rotate(b.qFixedToRoot, latLonToDir(t.latitude, t.longitude)) };
    };
    await openLab(page, 'scene=lunarOrbit&paused=1');
    const s = await state(page);
    const { t, dir } = facing(s, 'landing');
    await lookAlong(page, dir, 6e6);
    const pin = await element(page, 'surfaceTarget', t.id);
    expect(pin.visible).toBe(true);
    expect(Math.hypot(pin.x - 640, pin.y - 360)).toBeLessThan(1); // the camera looks straight down at it
    const shot = await saveScreenshot(page, 'map-view', 'accept-landing-target');
    const { PNG } = await import('pngjs');
    const img = PNG.sync.read(shot.buffer);
    // The pin's head ring sits ~12 px above the point: look for the landing red there.
    let red = 0;
    for (let y = Math.round(pin.y - 18); y <= Math.round(pin.y - 6); y++)
      for (let x = Math.round(pin.x - 6); x <= Math.round(pin.x + 6); x++) {
        const i = (y * img.width + x) * 4;
        if (img.data[i]! > 200 && img.data[i + 1]! < 130 && img.data[i + 2]! < 130) red++;
      }
    expect(red).toBeGreaterThan(10);
    // From the far side it is hidden.
    await lookAlong(page, { x: -dir.x, y: -dir.y, z: -dir.z }, 6e6);
    expect((await element(page, 'surfaceTarget', t.id)).visible).toBe(false);

    await openLab(page, 'scene=lowOrbit&paused=1');
    const e = await state(page);
    const z = facing(e, 'recovery');
    await lookAlong(page, z.dir, 2.2e7);
    expect((await element(page, 'surfaceTarget', z.t.id)).visible).toBe(true);
    const zones = (await lab(page, (l) => l.stats())).lines.filter((l) => l.kind === 'recoveryZone');
    expect(zones.length).toBe(e.surfaceTargets.filter((x) => x.kind === 'recovery').length);
    expect(zones.find((l) => l.id === `zone:${z.t.id}`)!.visibleVertices).toBeGreaterThan(20);
    await saveScreenshot(page, 'map-view', 'accept-recovery-zones');
    await expectNoErrors(page, pageLog);
  });

  test('lines are pixel-stable with a static camera from 200 km to 1e9 m', async ({ page, pageLog }) => {
    await openLab(page, 'scene=lowOrbit&paused=1&quiet=1');
    const s = await state(page);
    await lab(page, (l) => l.setFocus({ vesselId: window.__test!.state()!.activeVesselId }));
    await frames(page, 2);
    const W = s.patches.current[0]!.conic.W;
    for (const distance of [2e5, 2e6, 2e7, 2e8, 1e9]) {
      await lookAlong(page, { x: W.x + 0.3, y: W.y - 0.2, z: W.z + 0.1 }, distance);
      await frames(page, 4);
      const a = await page.screenshot();
      await frames(page, 6);
      const b = await page.screenshot();
      const d = pngDiff(a, b);
      expect(d.maxAbsDiff, `distance ${distance}`).toBe(0);
      const cam = await page.evaluate(() => window.__test!.camera()!);
      const v = (await state(page)).vessels[0]!.rRoot;
      expect(Math.hypot(cam.positionRoot.x - v.x, cam.positionRoot.y - v.y, cam.positionRoot.z - v.z)).toBeCloseTo(distance, -1);
      const visible = (await lab(page, (l) => l.stats())).lines.find((l) => l.id === 'current/0')!.visibleVertices;
      expect(visible, `orbit visible at ${distance}`).toBeGreaterThan(1);
      if (distance === 2e5 || distance === 1e9) await saveScreenshot(page, 'map-view', `accept-zoom-${distance === 2e5 ? '200km' : '1e9m'}`);
    }
    expect((await describeMap(page)).length).toBeGreaterThan(0);
    await expectNoErrors(page, pageLog);
  });
});
