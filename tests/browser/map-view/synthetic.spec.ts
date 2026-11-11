/**
 * The synthetic multi-patch scene: the full Earth -> Moon -> Earth chain, every marker kind and both
 * nodes appear (through describe()), current-position and at-intercept drawing, and the 8-patch load case.
 */
import type { Page } from '@playwright/test';
import { assertRealImage, expect, expectNoErrors, saveScreenshot, test } from '../harness';
import { describeMap, frames, openLab, state } from './helpers';

const KINDS = ['apoapsis', 'periapsis', 'ascendingNode', 'descendingNode', 'soiEnter', 'soiExit', 'impact', 'atmosphereEntry', 'closestApproach'];

type Lab = { stats(): { lines: { id: string; visibleVertices: number }[] }; setIntercept(on: boolean): void };
const lab = <T>(page: Page, fn: (l: Lab) => T): Promise<T> => page.evaluate(`(${fn.toString()})(window.__mapLab)`) as Promise<T>;

const markerKind = (id: string): string => id.split('/')[2]!.replace(/#\d+$/, '');

test('synthetic chain: every marker kind, both nodes, current-position and at-intercept drawing', async ({ page, pageLog }) => {
  await openLab(page, 'scene=synthetic');
  const s = await state(page);
  expect(s.patches.current.map((p) => p.endReason)).toEqual(['soiEnter', 'impact']);
  expect(s.patches.planned.map((p) => p.endReason)).toEqual(['soiExit', 'maneuver', 'atmosphere']);

  const d = await describeMap(page);
  const markers = d.filter((e) => e.kind === 'marker' && !e.id.endsWith('/surface'));
  for (const k of KINDS) {
    const m = markers.filter((e) => markerKind(e.id) === k);
    expect(m.length, `marker kind ${k}`).toBeGreaterThan(0);
    expect(m.some((e) => e.visible), `marker kind ${k} visible`).toBe(true);
  }
  // impact and entry points are also drawn on the ground
  expect(d.some((e) => e.id.endsWith('/impact/surface'))).toBe(true);
  expect(d.some((e) => e.id.endsWith('/atmosphereEntry/surface'))).toBe(true);
  // both maneuver nodes (the second 2.5 revolutions ahead, on another patch)
  const nodes = d.filter((e) => e.kind === 'node');
  expect(nodes.map((n) => n.id).sort()).toEqual(s.nodes.map((n) => n.id).sort());
  expect(nodes.every((n) => n.visible)).toBe(true);
  // every patch of the chain is drawn and on screen
  const lines = (await lab(page, (l) => l.stats())).lines;
  for (const id of ['current/0', 'current/1', 'planned/0', 'planned/1', 'planned/2']) {
    expect(lines.find((l) => l.id === id)?.visibleVertices ?? 0, id).toBeGreaterThan(2);
  }
  // Debris are dots: no orbit is drawn until the pointer is on one (then exactly its orbit).
  expect(lines.filter((l) => l.id.startsWith('vessel:debris')).length).toBe(0);
  const shot = await saveScreenshot(page, 'map-view', 'synthetic-chain');
  assertRealImage(shot.stats, 'synthetic-chain', { minNonBlack: 0.002, minStd: 2, minBuckets: 20 });

  // At intercept: the lunar patches move to the Moon's position at the SOI entry of their encounter (the
  // planned flyby starts inside the current encounter at node A, so both share one ghost).
  const impactBefore = markers.find((e) => markerKind(e.id) === 'impact')!;
  await lab(page, (l) => l.setIntercept(true));
  await frames(page, 3);
  const d2 = await describeMap(page);
  const moonId = s.bodies.find((b) => b.orbit !== null)!.id;
  const ghost = d2.find((e) => e.kind === 'body' && e.id === `${moonId}@intercept`);
  expect(ghost?.visible).toBe(true);
  expect(d2.filter((e) => e.kind === 'body' && e.id.includes('@intercept')).map((e) => e.id)).toEqual([`${moonId}@intercept`]);
  const impactAfter = d2.find((e) => e.id === impactBefore.id)!;
  expect(Math.hypot(impactAfter.x - impactBefore.x, impactAfter.y - impactBefore.y)).toBeGreaterThan(20);
  // the impact now lies on the ghost Moon (within its projected radius)
  expect(Math.hypot(impactAfter.x - ghost!.x, impactAfter.y - ghost!.y)).toBeLessThan(15);
  // the departure ends where the encounter begins: SOI entry marker next to the ghost's SOI-sized neighbourhood
  const enter = d2.find((e) => markerKind(e.id) === 'soiEnter')!;
  const node1 = d2.find((e) => e.kind === 'node' && e.id === s.nodes[0]!.id)!;
  expect(Math.hypot(enter.x - ghost!.x, enter.y - ghost!.y)).toBeLessThan(80);
  expect(Math.hypot(node1.x - ghost!.x, node1.y - ghost!.y)).toBeLessThan(40);
  const shot2 = await saveScreenshot(page, 'map-view', 'synthetic-chain-intercept');
  assertRealImage(shot2.stats, 'synthetic-chain-intercept', { minNonBlack: 0.002, minStd: 2, minBuckets: 20 });
  await expectNoErrors(page, pageLog);
});

test('debris are dots; the hovered one shows its orbit', async ({ page, pageLog }) => {
  await openLab(page, 'scene=synthetic&dist=9e7&quiet=1');
  const d = await describeMap(page);
  expect((await lab(page, (l) => l.stats())).lines.filter((l) => l.id.startsWith('vessel:debris'))).toHaveLength(0);
  // a debris dot with nothing else near it (the pointer then picks it)
  const lone = d.find((e) => e.kind === 'vessel' && e.id.startsWith('debris') && e.visible && d.every((o) => o === e || !o.visible || Math.hypot(o.x - e.x, o.y - e.y) > 14))!;
  expect(lone).toBeDefined();
  await page.mouse.move(lone.x, lone.y);
  await frames(page, 3);
  const hovered = (await lab(page, (l) => l.stats())).lines.filter((l) => l.id.startsWith('vessel:debris'));
  expect(hovered.map((l) => l.id)).toEqual([`vessel:${lone.id}`]);
  await saveScreenshot(page, 'map-view', 'hover-debris-orbit');
  await page.mouse.move(5, 5);
  await frames(page, 3);
  expect((await lab(page, (l) => l.stats())).lines.filter((l) => l.id.startsWith('vessel:debris'))).toHaveLength(0);
  await expectNoErrors(page, pageLog);
});

test('synthetic load case has 8 patches and 20 debris orbits drawn', async ({ page, pageLog }) => {
  await openLab(page, 'scene=synthetic&perf=1');
  const s = await state(page);
  expect(s.patches.current.length + s.patches.planned.length).toBe(8);
  const lines = (await lab(page, (l) => l.stats())).lines;
  expect(lines.filter((l) => /^(current|planned)\//.test(l.id))).toHaveLength(8);
  expect(lines.filter((l) => l.id.startsWith('vessel:debris'))).toHaveLength(20);
  await saveScreenshot(page, 'map-view', 'synthetic-8-patches');
  await expectNoErrors(page, pageLog);
});
