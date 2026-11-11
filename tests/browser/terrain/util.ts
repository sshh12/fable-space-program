/**
 * Helpers shared by the terrain specs: opening the lab at a camera placement, waiting until the terrain
 * has streamed in and settled, and looking at the image.
 */
import type { Page } from '@playwright/test';
import { PNG } from 'pngjs';
import { assertDiscreteGpu, openPage, saveScreenshot, type PngStats } from '../harness';

export const PAD = { lat: 18.987556, lon: -155.603239 };
export const LUNAR_SITE = { lat: 0.661471, lon: 23.435999 };

export type Query = Record<string, string | number>;

export function labUrl(query: Query): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) q.set(k, String(v));
  return `/labs/terrain/?${q.toString()}`;
}

/** Open the terrain lab and wait for the first tiles. */
export async function openLab(page: Page, query: Query, timeoutMs = 120_000): Promise<void> {
  await openPage(page, labUrl({ hud: 0, ...query }), { timeoutMs });
  await assertDiscreteGpu(page);
}

/** Wait until nothing is streaming or fading, then for `frames` more frames. */
export async function settle(page: Page, frames = 8, timeoutMs = 180_000): Promise<void> {
  await page.waitForFunction(() => window.__test!.isIdle(), undefined, { timeout: timeoutMs, polling: 100 });
  await page.evaluate((n) => window.__test!.waitFrames(n), frames);
  // Fades and prefetch can start work again right after the first idle moment.
  await page.waitForFunction(() => window.__test!.isIdle(), undefined, { timeout: timeoutMs, polling: 100 });
  await page.evaluate((n) => window.__test!.waitFrames(n), frames);
}

export async function shot(page: Page, name: string): Promise<{ file: string; stats: PngStats; buffer: Buffer }> {
  return saveScreenshot(page, 'terrain', name);
}

/** Fraction of pixels that are magenta-tinted (red and blue well above green): the lab's hole marker. */
export function magentaFraction(buffer: Buffer): { fraction: number; count: number; box: string } {
  const png = PNG.sync.read(buffer);
  let count = 0;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -1;
  let y1 = -1;
  for (let i = 0; i < png.data.length; i += 4) {
    const r = png.data[i]!;
    const g = png.data[i + 1]!;
    const b = png.data[i + 2]!;
    if (r - g > 40 && b - g > 40) {
      count++;
      const x = (i / 4) % png.width;
      const y = Math.floor(i / 4 / png.width);
      x0 = Math.min(x0, x);
      y0 = Math.min(y0, y);
      x1 = Math.max(x1, x);
      y1 = Math.max(y1, y);
    }
  }
  return { fraction: count / (png.width * png.height), count, box: count > 0 ? `x ${x0}..${x1}, y ${y0}..${y1} of ${png.width} x ${png.height}` : 'none' };
}

export async function terrainStats(page: Page): Promise<ReturnType<NonNullable<Window['__terrain']>['debug']['stats']>> {
  return page.evaluate(() => window.__terrain!.debug.stats());
}
