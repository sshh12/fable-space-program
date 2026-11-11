/**
 * The acceptance screenshots of the package (out/screens/atmosphere): every camera regime from the pad to
 * the Moon's distance, clear and cloudy. Each scene also asserts what can be asserted in numbers (the frame
 * is not black, not blown out, the sky has the colour the caption claims); the pictures themselves are
 * reviewed by eye against photographs.
 */
import { expect, expectNoErrors, test, waitIdle } from '../harness';
import { clippedFraction, luminance, openLab, PAD, probe, shot, type LabView } from './lab';

interface Scene {
  name: string;
  view?: Partial<LabView>;
  sun?: { azDeg: number; elDeg: number };
  space?: { distance: number; phaseDeg: number; fovDeg: number };
  /** Forced EV100 (space scenes: a camera exposes for the sunlit planet, not for the black around it). */
  ev?: number;
  frames?: number;
  check?: (p: (fx: number, fy: number) => Promise<[number, number, number]>, stats: { meanLuma: number; clippedFraction: number }) => Promise<void>;
}

const DAY_EV = 14.6;

async function render(page: import('@playwright/test').Page, s: Scene): Promise<void> {
  await page.evaluate(
    ({ s: sc, pad }) => {
      const lab = window.__atmo!;
      lab.app.renderer.setExposureOverride(sc.ev ?? null);
      if (sc.space) {
        lab.viewFromSpace(sc.space.distance, sc.space.phaseDeg, sc.space.fovDeg);
      } else {
        const v = { ...pad, alt: 2, headingDeg: 40, pitchDeg: 8, ...sc.view };
        const sun = sc.sun ?? { azDeg: 135, elDeg: 55 };
        lab.setSun(sun.azDeg, sun.elDeg, { latDeg: v.latDeg, lonDeg: v.lonDeg });
        lab.view(v);
      }
      window.__test!.setPaused(true);
      window.__test!.setDeterministic(true);
    },
    { s: { name: s.name, view: s.view, sun: s.sun, space: s.space, ev: s.ev }, pad: PAD },
  );
  await waitIdle(page, s.frames ?? 40);
  const saved = await shot(page, s.name);
  const clipped = clippedFraction(saved.buffer);
  console.log(`[${s.name}] mean luma ${saved.stats.meanLuma.toFixed(1)}, clipped ${(clipped * 100).toFixed(2)} %`);
  expect(clipped, `${s.name}: blown out`).toBeLessThan(0.2);
  if (s.check) await s.check((fx, fy) => probe(page, fx, fy), { meanLuma: saved.stats.meanLuma, clippedFraction: clipped });
}

function group(title: string, query: string, scenes: Scene[]): void {
  test(title, async ({ page, pageLog }) => {
    test.setTimeout(240_000);
    await openLab(page, query);
    for (const s of scenes) await render(page, s);
    await expectNoErrors(page, pageLog);
  });
}

const blue = (c: [number, number, number]): number => c[2] / Math.max(c[0], 1e-9);

test.describe('acceptance screenshots', () => {
  group('pad, clear sky: noon, sunset, anti-twilight, night', 'clouds=0', [
    {
      name: 'pad-noon',
      view: { alt: 30, headingDeg: 35, pitchDeg: 12, fovDeg: 60 },
      sun: { azDeg: 160, elDeg: 70 },
      async check(p, stats) {
        expect(stats.meanLuma).toBeGreaterThan(60);
        // Deep blue above, pale at the horizon.
        const high = await p(0.5, 0.04);
        const low = await p(0.5, 0.6);
        expect(blue(high)).toBeGreaterThan(1.8);
        expect(blue(low)).toBeLessThan(blue(high) * 0.75);
        expect(luminance(low)).toBeGreaterThan(luminance(high) * 1.5);
      },
    },
    {
      name: 'pad-sunset-minus-10min',
      view: { alt: 30, headingDeg: 270, pitchDeg: 10, fovDeg: 75 },
      sun: { azDeg: 270, elDeg: 2.3 },
      async check(p) {
        const horizon = await p(0.3, 0.6);
        const high = await p(0.5, 0.03);
        expect(horizon[0]).toBeGreaterThan(horizon[2] * 1.4);
        expect(blue(high)).toBeGreaterThan(1.2);
      },
    },
    {
      name: 'pad-sunset',
      view: { alt: 30, headingDeg: 270, pitchDeg: 10, fovDeg: 75 },
      sun: { azDeg: 270, elDeg: -0.3 },
      async check(p) {
        const horizon = await p(0.3, 0.6);
        const high = await p(0.5, 0.03);
        // (Orange: with the Rayleigh coefficients of the sRGB primaries the red band loses more on the way
        // than a 680 nm wavelength would; the ratio was 1.8 with the three-wavelength table.)
        expect(horizon[0]).toBeGreaterThan(horizon[2] * 1.4);
        expect(horizon[0]).toBeGreaterThan(horizon[1] * 1.15);
        expect(blue(high)).toBeGreaterThan(1.3);
      },
    },
    {
      name: 'pad-anti-twilight',
      view: { alt: 30, headingDeg: 90, pitchDeg: 10, fovDeg: 75 },
      sun: { azDeg: 270, elDeg: -2.5 },
    },
    {
      // The sun eclipsed by the planet itself, 40 degrees under the horizon (an eclipse by another body is
      // rendered and measured in eclipse.spec.ts: pad-eclipse*.png).
      name: 'pad-night',
      view: { alt: 30, headingDeg: 90, pitchDeg: 25, fovDeg: 75 },
      sun: { azDeg: 270, elDeg: -40 },
      // A night exposure (the lab's metering floor is a daylight one): what a dark-adapted eye or a long
      // exposure sees. Any glow the atmosphere added would be amplified with the stars.
      ev: -1,
      async check(_p, stats) {
        // Stars on black: a dark frame with a few bright pixels.
        expect(stats.meanLuma).toBeLessThan(12);
        expect(stats.meanLuma).toBeGreaterThan(0.02);
      },
    },
  ]);

  group('ascent: 10, 25, 40 and 80 km', '', [
    { name: 'ascent-10km', view: { alt: 10000, headingDeg: 35, pitchDeg: 0, fovDeg: 60 }, sun: { azDeg: 160, elDeg: 50 }, ev: DAY_EV },
    { name: 'ascent-25km', view: { alt: 25000, headingDeg: 35, pitchDeg: -2, fovDeg: 60 }, sun: { azDeg: 160, elDeg: 50 }, ev: DAY_EV },
    { name: 'ascent-40km', view: { alt: 40000, headingDeg: 35, pitchDeg: -4, fovDeg: 60 }, sun: { azDeg: 160, elDeg: 50 }, ev: DAY_EV },
    {
      name: 'ascent-80km',
      view: { alt: 80000, headingDeg: 35, pitchDeg: -6, fovDeg: 60 },
      sun: { azDeg: 160, elDeg: 50 },
      ev: DAY_EV,
      async check(p) {
        // Black sky above a blue limb.
        expect(luminance(await p(0.5, 0.03))).toBeLessThan(5);
      },
    },
  ]);

  group('low orbit: day side, terminator, night-side limb glow', '', [
    { name: 'leo-day', view: { alt: 400000, headingDeg: 60, pitchDeg: -35, fovDeg: 60 }, sun: { azDeg: 160, elDeg: 50 }, ev: DAY_EV, frames: 60 },
    { name: 'leo-day-limb', view: { alt: 400000, headingDeg: 35, pitchDeg: -18, fovDeg: 60 }, sun: { azDeg: 160, elDeg: 50 }, ev: DAY_EV, frames: 60 },
    {
      // Along the terminator: the sun on the horizon to the left (west), the night to the right, the
      // twilight band and the red-lit cloud tops across the middle of the frame.
      name: 'leo-terminator',
      view: { alt: 400000, headingDeg: 0, pitchDeg: -25, fovDeg: 60 },
      sun: { azDeg: 270, elDeg: 0 },
      ev: 11,
      frames: 60,
      async check(p) {
        const day = luminance(await p(0.08, 0.75));
        const night = luminance(await p(0.95, 0.75));
        expect(day, 'the day side of the terminator').toBeGreaterThan(8 * Math.max(night, 1e-3));
      },
    },
    // Towards the low sun from orbit: long shadows and the bright limb (the view the perf spec measures).
    { name: 'leo-low-sun', view: { alt: 400000, headingDeg: 270, pitchDeg: -25, fovDeg: 60 }, sun: { azDeg: 270, elDeg: 4 }, ev: 13, frames: 60 },
    {
      name: 'leo-night-limb',
      view: { alt: 400000, headingDeg: 270, pitchDeg: -18, fovDeg: 60 },
      sun: { azDeg: 270, elDeg: -23 },
      ev: 9,
      frames: 60,
      async check(_p, stats) {
        expect(stats.meanLuma).toBeGreaterThan(0.3);
        expect(stats.meanLuma).toBeLessThan(60);
      },
    },
  ]);

  group('from deep space: 60,000 km and the Moon\'s distance', '', [
    { name: 'earth-60000km', space: { distance: 66371000, phaseDeg: 30, fovDeg: 25 }, ev: DAY_EV },
    { name: 'earth-60000km-crescent', space: { distance: 66371000, phaseDeg: 115, fovDeg: 25 }, ev: DAY_EV },
    { name: 'earth-moon-distance', space: { distance: 384400000, phaseDeg: 60, fovDeg: 2.5 }, ev: DAY_EV },
    {
      name: 'earth-moon-distance-wide',
      space: { distance: 384400000, phaseDeg: 60, fovDeg: 30 },
      ev: DAY_EV,
      async check(p) {
        // A 1.9 degree disc in a 30 degree view: bright, bluish-white, on black.
        const c = await p(0.497, 0.5);
        expect(luminance(c)).toBeGreaterThan(500);
        expect(luminance(await p(0.6, 0.5))).toBeLessThan(1);
      },
    },
  ]);

  group('clouds from the ground: fair-weather cumulus at noon and at sunset', 'cover=0.4,3', [
    { name: 'clouds-ground-cumulus', view: { alt: 30, headingDeg: 35, pitchDeg: 14, fovDeg: 70 }, sun: { azDeg: 160, elDeg: 55 }, ev: DAY_EV },
    { name: 'clouds-ground-cumulus-into-sun', view: { alt: 30, headingDeg: 170, pitchDeg: 18, fovDeg: 70 }, sun: { azDeg: 160, elDeg: 40 }, ev: DAY_EV },
    { name: 'clouds-ground-sunset', view: { alt: 30, headingDeg: 270, pitchDeg: 12, fovDeg: 75 }, sun: { azDeg: 268, elDeg: 3 } },
    { name: 'clouds-ground-after-sunset', view: { alt: 30, headingDeg: 270, pitchDeg: 12, fovDeg: 75 }, sun: { azDeg: 268, elDeg: -1.5 } },
  ]);

  group('flying through a deck', 'cover=0.9,4', [
    { name: 'clouds-under-deck', view: { alt: 300, headingDeg: 40, pitchDeg: 10, fovDeg: 70 }, sun: { azDeg: 160, elDeg: 55 } },
    { name: 'clouds-in-deck', view: { alt: 1900, headingDeg: 40, pitchDeg: 5, fovDeg: 70 }, sun: { azDeg: 160, elDeg: 55 }, ev: DAY_EV },
    { name: 'clouds-deck-top', view: { alt: 4150, headingDeg: 40, pitchDeg: -3, fovDeg: 70 }, sun: { azDeg: 160, elDeg: 35 }, ev: DAY_EV },
    { name: 'clouds-above-deck', view: { alt: 6000, headingDeg: 40, pitchDeg: -8, fovDeg: 70 }, sun: { azDeg: 160, elDeg: 35 }, ev: DAY_EV },
  ]);
});
