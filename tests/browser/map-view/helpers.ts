/** Shared helpers for the map-view specs (lab at /labs/map-view/). */
import type { Page } from '@playwright/test';
import type { MapElementInfo } from '../../../src/core/contracts/ui';
import type { SimSnapshot } from '../../../src/core/contracts/sim';
import { assertDiscreteGpu, openPage } from '../harness';

/**
 * Test timeout for map-view specs: the first page of a run waits for the dev server's cold dependency scan,
 * which takes many minutes while data/tiles holds hundreds of thousands of files (docs/requests/map-view-2.md).
 */
export const MAP_SPEC_TIMEOUT_MS = 15 * 60_000;

export async function openLab(page: Page, query: string): Promise<void> {
  await openPage(page, `/labs/map-view/?${query}`);
  await assertDiscreteGpu(page);
  await page.evaluate(() => window.__test!.waitFrames(3));
}

export const describeMap = (page: Page): Promise<MapElementInfo[]> => page.evaluate(() => window.__test!.map());
export const state = (page: Page): Promise<SimSnapshot> => page.evaluate(() => window.__test!.state()!);

export async function element(page: Page, kind: MapElementInfo['kind'], id: string): Promise<MapElementInfo> {
  const all = await describeMap(page);
  const e = all.find((x) => x.kind === kind && x.id === id);
  if (!e) throw new Error(`map element ${kind} ${id} not found; have ${all.map((x) => `${x.kind}:${x.id}`).join(', ')}`);
  return e;
}

export async function frames(page: Page, n = 3): Promise<void> {
  await page.evaluate((k) => window.__test!.waitFrames(k), n);
}

/** Orbit the lab camera so it looks along -dir (dir in ROOT axes) at its focus from `distance`. */
export async function lookAlong(page: Page, dir: { x: number; y: number; z: number }, distance: number): Promise<void> {
  const l = Math.hypot(dir.x, dir.y, dir.z);
  const yaw = Math.atan2(dir.y, dir.x);
  const pitch = Math.asin(Math.max(-1, Math.min(1, dir.z / l)));
  await page.evaluate(([y, p, d]) => window.__test!.setCameraOrbit(y!, p!, d!), [yaw, pitch, distance]);
  await frames(page, 3);
}

/** Move the mouse in small steps (each lands in a separate frame often enough for drags). */
export async function moveInSteps(page: Page, x0: number, y0: number, x1: number, y1: number, steps: number): Promise<void> {
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(x0 + ((x1 - x0) * i) / steps, y0 + ((y1 - y0) * i) / steps);
    await frames(page, 1);
  }
}
