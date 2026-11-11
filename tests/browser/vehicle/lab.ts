/** Helpers shared by the vehicle lab specs. */
import type { Page } from '@playwright/test';
import { openPage, saveScreenshot, waitIdle, type PngStats } from '../harness';

export const LAB = '/labs/vehicle/';

/** Open the lab with a query string and wait for the lab handle. */
export async function openLab(page: Page, query: string): Promise<void> {
  await openPage(page, `${LAB}?hud=0&${query}`, { timeoutMs: 120_000 });
  await page.waitForFunction(() => window.__veh !== undefined);
}

/** Freeze presentation time, wait for textures and let TAA converge. */
export async function settle(page: Page, frames = 48): Promise<void> {
  await page.evaluate(() => window.__test!.setDeterministic(true));
  await waitIdle(page, frames);
}

export async function shot(page: Page, name: string, frames = 48): Promise<{ file: string; stats: PngStats; buffer: Buffer }> {
  await settle(page, frames);
  return saveScreenshot(page, 'vehicle', name);
}
