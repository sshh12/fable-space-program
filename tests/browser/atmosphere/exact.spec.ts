/**
 * Frame-exact captures of the atmosphere and the clouds (request core-4; RENDER_API section 13): a view
 * captured with `window.__test.renderExact` is the same picture, bit for bit, on the same page after another
 * history (animated frames, another view and another sun in between) and on two fresh loads. What makes it
 * so in this package: `AtmosphereFeature.resetTemporal()` (cloud history, shadow map, light-change detection,
 * cloud clock), and the march sequence and the shadow map's refresh phase on the core's sequence index
 * instead of the absolute frame index.
 *
 *   node tools/dev/heavy.mjs --class=gpu -- npx playwright test tests/browser/atmosphere/exact.spec.ts --project=functional
 *
 * A capture that differs is written to out/screens/atmosphere/exact-<view>-<comparison>.diff.png.
 *
 * The last test is the same with every package drawing (the integration lab's low-orbit page, the lead's
 * `leo-day` reference checkpoint): exactIntegrated.ts.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { assertDiscreteGpu, captureDeterministic, expect, expectNoErrors, imageDifference, openPage, test } from '../harness';
import { defineIntegratedExact } from './exactIntegrated';
import { PAD } from './lab';

test.describe.configure({ timeout: 600_000 });

const FRAMES = 64;

interface View {
  name: string;
  /** Lab query: the view and the sun are part of the URL, so that a fresh load is the scene without a script. */
  query: string;
  /** The sun of the query (azimuth, elevation, deg), to put it back after the history in between. */
  sun: [number, number];
}

const at = (alt: number, heading: number, pitch: number): string => `view=${PAD.latDeg},${PAD.lonDeg},${alt},${heading},${pitch}`;
const VIEWS: View[] = [
  // Low orbit, day side: cloud fields as clusters of cells, their shadows on the sea (the view of the request).
  { name: 'leo-day', query: `fov=60&sun=160,50&${at(400000, 60, -35)}`, sun: [160, 50] },
  // Low orbit towards a low sun: the shadow map with its long step count and its rounds of 48 frames.
  { name: 'leo-low-sun', query: `fov=60&sun=270,4&${at(400000, 270, -25)}`, sun: [270, 4] },
  // From the pad under fair-weather cumulus: resolved clouds, sub-pixel ray positions, the temporal resolve.
  { name: 'ground-cumulus', query: `fov=70&cover=0.4,3&sun=160,55&${at(30, 35, 14)}`, sun: [160, 55] },
];

const url = (v: View): string => `/labs/atmosphere/?hud=0&governor=off&deterministic=1&paused=1&${v.query}`;

async function capture(page: Page): Promise<{ png: Buffer; ev100: number }> {
  const png = await captureDeterministic(page, FRAMES);
  const ev100 = await page.evaluate(() => window.__atmo!.app.renderer.exposureInfo().ev100);
  return { png, ev100 };
}

for (const v of VIEWS) {
  test(`renderExact, ${v.name}: the same picture bit for bit after another history and on two fresh loads`, async ({ page, pageLog }) => {
    await openPage(page, url(v), { timeoutMs: 240_000 });
    await assertDiscreteGpu(page);
    const a = await capture(page);
    // Another history on the same page: the hold ends, animated frames pass with the camera somewhere else
    // and the sun moved, then the scene is put back and captured again.
    const scene = await page.evaluate(
      async ({ pad, sun }) => {
        const lab = window.__atmo!;
        const spec = { ...lab.app.camera.spec };
        const fovY = lab.app.camera.settings.fovY;
        window.__test!.setDeterministic(false);
        lab.view({ ...pad, alt: 9000, headingDeg: 200, pitchDeg: -10, fovDeg: 50 });
        lab.setSun(200, 20);
        await window.__test!.waitFrames(47);
        lab.app.camera.spec = spec;
        lab.app.camera.settings.fovY = fovY;
        lab.setSun(sun[0], sun[1]);
        await window.__test!.waitFrames(44);
        window.__test!.setDeterministic(true);
        return { clouds: lab.feature.debug.selection().cloudBodyId };
      },
      { pad: PAD, sun: v.sun },
    );
    expect(scene.clouds, 'clouds are drawn in this view').not.toBeNull();
    const b = await capture(page);
    await openPage(page, url(v), { timeoutMs: 240_000 });
    const c = await capture(page);
    await openPage(page, url(v), { timeoutMs: 240_000 });
    const d = await capture(page);

    const dir = path.join(process.cwd(), 'out', 'screens', 'atmosphere');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `exact-${v.name}.png`), a.png);
    const compared = (
      [
        ['same-page', b],
        ['fresh-load', c],
        ['second-fresh-load', d],
      ] as const
    ).map(([tag, other]) => {
      const diff = imageDifference(a.png, other.png);
      if (diff.maxAbs > 0) fs.writeFileSync(path.join(dir, `exact-${v.name}-${tag}.diff.png`), diff.diff);
      return { tag, ev100: other.ev100, meanAbs: diff.meanAbs, maxAbs: diff.maxAbs, differing: diff.differingFraction };
    });
    console.log(`[exact] ${v.name} (EV100 ${a.ev100}): ${compared.map((x) => `${x.tag}: mean ${x.meanAbs.toFixed(5)}, max ${x.maxAbs}, ${(100 * x.differing).toFixed(3)} % of pixels, EV100 ${x.ev100}`).join('; ')}`);
    for (const x of compared) {
      expect(x.ev100, `${x.tag}: exposure`).toBe(a.ev100);
      expect(x.maxAbs, `${x.tag}: largest difference of a channel, 8-bit levels`).toBe(0);
    }
    await expectNoErrors(page, pageLog);
  });
}

defineIntegratedExact();
