/**
 * ARCHITECTURE 17.1, the two lines of this package (GPU ms, p99 of timestamp queries, 1440p internal):
 *   atmosphere tables + march + composite + aerial volume   0.9 (0.8 at the pad)
 *   clouds (shadow map + march + resolve)                   1.3 at qualityScale 1, 0.9 at 0.7
 * Attribution mode, render scale pinned at 1, a ballast of about 7 ms so the GPU runs at the clock of a real
 * frame (render-core hand-off 4.1), everything under the machine-wide GPU lock.
 */
import type { Page } from '@playwright/test';
import { assertDiscreteGpu, expect, expectNoErrors, openPage, saveScreenshot, test, waitIdle, withGpuLock } from '../harness';
import { PAD, type LabView } from './lab';

test.use({ viewport: { width: 2560, height: 1440 } });

interface Scene {
  name: string;
  view?: LabView;
  sun?: { azDeg: number; elDeg: number };
  space?: { distance: number; phaseDeg: number; fovDeg: number };
  atmosphereMax: number;
}

interface Row {
  atmosphere: number;
  clouds: number;
  atmosphereP50: number;
  cloudsP50: number;
  passes: string;
  ballast: number;
  quality: number;
  frame: number;
}

/** Three windows of 200 frames; the least disturbed one counts (concurrent GPU work can only add time). */
async function measure(page: Page): Promise<Row & { windows: string }> {
  const rows: Row[] = [];
  for (let w = 0; w < 3; w++) {
    rows.push(
      await page.evaluate(async (first) => {
        await window.__test!.waitFrames(first ? 60 : 8);
        window.__test!.resetPerf();
        await window.__test!.waitFrames(200);
        const ps = window.__atmo!.app.renderer.passStats();
        const perf = window.__test!.perf()!;
        const mine = Object.entries(ps).filter(([n]) => n.startsWith('atmosphere.'));
        const sum = (cloud: boolean, key: 'p99' | 'p50'): number => mine.filter(([n]) => n.startsWith('atmosphere.cloud') === cloud).reduce((a, [, v]) => a + v[key], 0);
        return {
          atmosphere: sum(false, 'p99'),
          clouds: sum(true, 'p99'),
          atmosphereP50: sum(false, 'p50'),
          cloudsP50: sum(true, 'p50'),
          passes: mine.map(([n, v]) => `${n.slice(11)} ${v.p50.toFixed(3)}/${v.p99.toFixed(3)}`).join(', '),
          ballast: ps['lab-heavy.burn']?.p50 ?? 0,
          quality: perf.qualityScale,
          frame: perf.gpu.p99,
        };
      }, w === 0),
    );
  }
  const best = rows.reduce((b, r) => (r.atmosphere + r.clouds < b.atmosphere + b.clouds ? r : b), rows[0]!);
  return { ...best, windows: rows.map((r) => `${r.atmosphere.toFixed(3)}/${r.clouds.toFixed(3)}`).join(' ') };
}

async function place(page: Page, s: Scene): Promise<void> {
  await page.evaluate(
    ({ s: sc }) => {
      const lab = window.__atmo!;
      if (sc.space) lab.viewFromSpace(sc.space.distance, sc.space.phaseDeg, sc.space.fovDeg);
      else {
        lab.setSun(sc.sun!.azDeg, sc.sun!.elDeg, { latDeg: sc.view!.latDeg, lonDeg: sc.view!.lonDeg });
        lab.view(sc.view!);
      }
    },
    { s },
  );
  await waitIdle(page, 30);
}

async function calibrate(page: Page): Promise<void> {
  const per = await page.evaluate(async () => {
    window.__atmo!.heavy.set(400);
    await window.__test!.waitFrames(90);
    window.__test!.resetPerf();
    await window.__test!.waitFrames(60);
    return (window.__atmo!.app.renderer.passStats()['lab-heavy.burn']?.p50 ?? 0) / 400;
  });
  expect(per).toBeGreaterThan(0);
  await page.evaluate((n) => window.__atmo!.heavy.set(n), Math.round(7 / per));
}

const NOON = { azDeg: 160, elDeg: 55 };
const REAL: Scene[] = [
  { name: 'pad', view: { ...PAD, alt: 2, headingDeg: 35, pitchDeg: 12, fovDeg: 60 }, sun: NOON, atmosphereMax: 0.8 },
  { name: 'ascent 10 km', view: { ...PAD, alt: 10000, headingDeg: 35, pitchDeg: 0, fovDeg: 60 }, sun: NOON, atmosphereMax: 0.9 },
  { name: 'low orbit', view: { ...PAD, alt: 400000, headingDeg: 60, pitchDeg: -35, fovDeg: 60 }, sun: NOON, atmosphereMax: 0.9 },
  { name: 'low orbit terminator', view: { ...PAD, alt: 400000, headingDeg: 270, pitchDeg: -25, fovDeg: 60 }, sun: { azDeg: 270, elDeg: 4 }, atmosphereMax: 0.9 },
  { name: '60,000 km', space: { distance: 66371000, phaseDeg: 30, fovDeg: 25 }, atmosphereMax: 0.9 },
];
// The heaviest cloud views: a sky full of cumulus from the ground, the inside of a deck, a cloud sea from above.
const CUMULUS: Scene[] = [{ name: 'ground, cumulus overhead', view: { ...PAD, alt: 30, headingDeg: 35, pitchDeg: 14, fovDeg: 70 }, sun: NOON, atmosphereMax: 0.8 }];
const DECK: Scene[] = [
  { name: 'inside a deck', view: { ...PAD, alt: 1900, headingDeg: 40, pitchDeg: 5, fovDeg: 70 }, sun: NOON, atmosphereMax: 0.9 },
  { name: 'above a deck', view: { ...PAD, alt: 6000, headingDeg: 40, pitchDeg: -8, fovDeg: 70 }, sun: { azDeg: 160, elDeg: 35 }, atmosphereMax: 0.9 },
];

for (const quality of [1, 0.7]) {
  test(`atmosphere and cloud GPU budget at 1440p, qualityScale ${quality}`, async ({ page, pageLog }) => {
    test.setTimeout(40 * 60_000);
    const cloudMax = quality === 1 ? 1.3 : 0.9;
    await withGpuLock(async () => {
      const results: { scene: Scene; row: Row & { windows: string } }[] = [];
      for (const [query, scenes] of [
        ['', REAL],
        ['cover=0.4,3', CUMULUS],
        ['cover=0.9,4', DECK],
      ] as const) {
        const q = quality === 1 ? 'governor=off' : `quality=${quality}`;
        await openPage(page, `/labs/atmosphere/?hud=0&perf=features&scale=1&${q}${query ? `&${query}` : ''}`);
        await assertDiscreteGpu(page);
        await waitIdle(page, 60);
        expect(await page.evaluate(() => window.__atmo!.app.renderer.frameContext!.renderSize)).toEqual([2560, 1440]);
        await calibrate(page);
        for (const s of scenes) {
          await place(page, s);
          const row = await measure(page);
          results.push({ scene: s, row });
          if (quality === 1) await saveScreenshot(page, 'atmosphere', `perf-${s.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-1440p`);
        }
      }
      for (const { scene, row } of results) {
        console.log(
          `${scene.name.padEnd(26)} quality ${row.quality.toFixed(2)}: atmosphere ${row.atmosphere.toFixed(3)} ms p99 (${row.atmosphereP50.toFixed(3)} p50), clouds ${row.clouds.toFixed(3)} ms p99 (${row.cloudsP50.toFixed(3)} p50); ` +
            `ballast ${row.ballast.toFixed(2)} ms, frame p99 ${row.frame.toFixed(2)} ms; windows atm/clouds: ${row.windows}\n    ${row.passes}`,
        );
      }
      for (const { scene, row } of results) {
        expect(row.ballast, scene.name).toBeGreaterThan(5);
        expect(row.quality, scene.name).toBeCloseTo(quality, 2);
        expect(row.atmosphere, `${scene.name}: atmosphere`).toBeLessThanOrEqual(scene.atmosphereMax);
        expect(row.clouds, `${scene.name}: clouds`).toBeLessThanOrEqual(cloudMax);
      }
      await expectNoErrors(page, pageLog);
    });
  });
}
