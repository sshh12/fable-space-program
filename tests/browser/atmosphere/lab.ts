/**
 * Helpers shared by the atmosphere specs: lab URL, view / sun placement through window.__atmo, settled
 * screenshots into out/screens/atmosphere, and luminance probes of the HDR target.
 */
import type { Page } from '@playwright/test';
import { assertDiscreteGpu, openPage, saveScreenshot, waitIdle } from '../harness';

export const PKG = 'atmosphere';

export interface LabView {
  latDeg: number;
  lonDeg: number;
  alt: number;
  headingDeg: number;
  pitchDeg: number;
  fovDeg?: number;
}

/** The lab's default site (the launch pad of the first site definition). */
export const PAD = { latDeg: 18.987556, lonDeg: -155.603239 };

export async function openLab(page: Page, query = ''): Promise<void> {
  await openPage(page, `/labs/atmosphere/?hud=0${query ? `&${query}` : ''}`);
  await assertDiscreteGpu(page);
}

/** Place the camera and the sun (azimuth / elevation in deg at the camera's ground point unless `sunAt` is given). */
export async function setScene(page: Page, view: LabView, sun: { azDeg: number; elDeg: number; at?: { latDeg: number; lonDeg: number } }): Promise<void> {
  await page.evaluate(
    ({ view: v, sun: s }) => {
      const lab = window.__atmo!;
      lab.setSun(s.azDeg, s.elDeg, s.at ?? { latDeg: v.latDeg, lonDeg: v.lonDeg });
      lab.view(v);
    },
    { view, sun },
  );
}

/** Deterministic rendering, everything loaded, exposure settled, then `frames` more frames. */
export async function settle(page: Page, frames = 24): Promise<void> {
  await page.evaluate(() => {
    window.__test!.setPaused(true);
    window.__test!.setDeterministic(true);
  });
  await waitIdle(page, frames);
}

export async function shot(page: Page, name: string): Promise<Awaited<ReturnType<typeof saveScreenshot>>> {
  return saveScreenshot(page, PKG, name);
}

/** Mean luminance (cd/m^2, rgb) around a render-target pixel given as fractions of the target size. */
export async function probe(page: Page, fx: number, fy: number, half = 2): Promise<[number, number, number]> {
  return page.evaluate(
    async ({ fx: x, fy: y, half: h }) => {
      const lab = window.__atmo!;
      const [w, hgt] = lab.app.renderer.frameContext!.renderSize;
      return lab.probe(x * w, y * hgt, h);
    },
    { fx, fy, half },
  );
}

export const luminance = (c: readonly [number, number, number]): number => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
