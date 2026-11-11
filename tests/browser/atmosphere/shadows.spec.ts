/**
 * Cloud shadows on what the deferred lighting shades (request atmosphere-clouds-3, resolved by core-support
 * commit b5dceb7): 'clouds.shadowMap' carries, per sun line, the optical depth of the whole layer AND where
 * the cloud begins, so a receiver is shaded only by the cloud between it and the sun.
 *
 * A white diffuse quad facing the sun (lab quad kind 'lit') stands in for a vehicle or a mountain top:
 *   under an overcast deck      in its shade (a fraction of the clear-sky value)
 *   6 km up, above the deck     as bright as without clouds (it was at 45 % before the fix)
 *   400 km up, in low orbit     as bright as without clouds (the near map is 960 km wide there)
 * Each case is rendered with the overcast and with clouds=0 from the same camera.
 */
import type { Page } from '@playwright/test';
import { expect, expectNoErrors, test } from '../harness';
import { luminance, openLab, PAD, setScene, settle, shot } from './lab';

const SUN = { azDeg: 195, elDeg: 50 };

interface Case {
  name: string;
  /** Height of the quad above the site origin (which lies on the reference radius), its half size, and the camera height (m). */
  up: number;
  half: number;
  cameraAlt: number;
  pitchDeg: number;
}

const CASES: Case[] = [
  { name: 'under the deck', up: 150, half: 40, cameraAlt: 420, pitchDeg: -80 },
  { name: 'above the deck', up: 6000, half: 60, cameraAlt: 6500, pitchDeg: -80 },
  { name: 'low orbit', up: 400_000, half: 60, cameraAlt: 400_500, pitchDeg: -80 },
];

/** Luminance of the lit quad of each case (cd/m^2) on the page as it is. */
async function measure(page: Page, screenshots: string | null): Promise<number[]> {
  const out: number[] = [];
  for (const c of CASES) {
    // The camera stands a little south of the quad and looks north and down at it.
    const back = (c.cameraAlt - c.up) / Math.tan((-c.pitchDeg * Math.PI) / 180);
    await page.evaluate(({ up, half, back: b }) => window.__atmo!.setQuads([{ id: 'lit', kind: 'lit', place: { type: 'site', enu: [0, b, up] }, halfSize: half, luminance: [0.8, 0.8, 0.8] }]), {
      up: c.up,
      half: c.half,
      back,
    });
    await setScene(page, { ...PAD, alt: c.cameraAlt, headingDeg: 0, pitchDeg: c.pitchDeg, fovDeg: 30 }, SUN);
    await settle(page, 40);
    if (screenshots) await shot(page, `${screenshots}-${c.name.replace(/ /g, '-')}`);
    const value = await page.evaluate(async () => {
      const lab = window.__atmo!;
      const p = lab.quads.project('lit');
      if (!p) return null;
      return { rgb: await lab.probe(p.x, p.y, 2), x: p.x, y: p.y, size: lab.app.renderer.frameContext!.renderSize };
    });
    expect(value, `${c.name}: the quad is in front of the camera`).not.toBeNull();
    expect(value!.x, `${c.name}: the quad is in the frame`).toBeGreaterThan(0.2 * value!.size[0]);
    expect(value!.x).toBeLessThan(0.8 * value!.size[0]);
    expect(value!.y).toBeGreaterThan(0.2 * value!.size[1]);
    expect(value!.y).toBeLessThan(0.8 * value!.size[1]);
    out.push(luminance(value!.rgb));
  }
  return out;
}

test.describe('cloud shadows on lit surfaces', () => {
  test.describe.configure({ mode: 'serial' });
  let overcast: number[] = [];
  let clear: number[] = [];

  test('overcast deck (tops below 3.5 km)', async ({ page, pageLog }) => {
    test.setTimeout(240_000);
    await openLab(page, 'cover=1,2&sky=0&relief=0');
    overcast = await measure(page, 'shadow-lit-quad');
    await expectNoErrors(page, pageLog);
  });

  test('no clouds', async ({ page, pageLog }) => {
    test.setTimeout(240_000);
    await openLab(page, 'clouds=0&sky=0&relief=0');
    clear = await measure(page, null);
    await expectNoErrors(page, pageLog);
  });

  test('a receiver is shaded only by the cloud between it and the sun', () => {
    test.skip(overcast.length !== CASES.length || clear.length !== CASES.length, 'needs the two render tests of this file (run the file as a whole)');
    CASES.forEach((c, i) => console.log(`[cloud shadow] lit quad ${c.name}: ${overcast[i]!.toFixed(0)} cd/m^2 under the overcast map, ${clear[i]!.toFixed(0)} without clouds (ratio ${(overcast[i]! / clear[i]!).toFixed(3)})`));
    // Under the deck: the sun is gone, what is left is the light of the sky and of the cloud base.
    expect(clear[0]!).toBeGreaterThan(5000);
    expect(overcast[0]! / clear[0]!).toBeLessThan(0.5);
    // Above it, and in orbit: nothing between the surface and the sun.
    expect(overcast[1]! / clear[1]!).toBeGreaterThan(0.96);
    expect(overcast[1]! / clear[1]!).toBeLessThan(1.1);
    expect(overcast[2]! / clear[2]!).toBeGreaterThan(0.96);
    expect(overcast[2]! / clear[2]!).toBeLessThan(1.1);
  });
});
