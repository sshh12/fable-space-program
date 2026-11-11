/** Helpers shared by the vehicle lab specs. */
import type { Page } from '@playwright/test';
import { openPage, saveScreenshot, waitIdle, type PngStats } from '../harness';

export const LAB = '/labs/vehicle/';

/** Open the lab with a query string and wait for the lab handle. */
export async function openLab(page: Page, query: string): Promise<void> {
  await openPage(page, `${LAB}?hud=0&governor=off&${query}`, { timeoutMs: 120_000 });
  await page.waitForFunction(() => window.__veh !== undefined);
}

/**
 * Wait for textures, then let the picture converge LIVE: the renderer keeps its sub-pixel jitter and its
 * noise sequence running, so what is saved is what a player sees after standing still for a second
 * (dithered penumbrae and thin members resolved by the temporal anti-aliasing), not one frozen noise pattern.
 * `deterministic` freezes presentation time instead, for the pictures that are compared pixel by pixel.
 */
export async function settle(page: Page, frames = 72, deterministic = false): Promise<void> {
  await page.evaluate((on) => window.__test!.setDeterministic(on), deterministic);
  await waitIdle(page, frames);
}

export async function shot(page: Page, name: string, frames = 72): Promise<{ file: string; stats: PngStats; buffer: Buffer }> {
  await settle(page, frames);
  return saveScreenshot(page, 'vehicle', name);
}
