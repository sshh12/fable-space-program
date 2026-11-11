/**
 * The review matrix of the vfx package: every shot the brief lists, saved at full size under
 * out/screens/vfx/<sheet>/<name>.png and as half-size contact sheets out/screens/vfx/<sheet>.png
 * (tiles in reading order). The images are for a human (or an agent) to LOOK at; the assertions here only
 * make sure that every one of them is a real, error-free render.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { expect, expectNoErrors, pngStats, test, waitIdle } from '../harness';
import { openLab, saveSheet } from './helpers';

// A sheet takes 10 to 30 s; a page that hangs while another agent's edit restarts the dev server is retried.
test.describe.configure({ timeout: 300_000, retries: 1 });

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

interface Shot {
  name: string;
  query: string;
  /** Lab time to run to before the picture (null: the scene's initial state). */
  t?: number;
  /** Put the camera on the far side from the sun (canopies seen against the light). */
  backlit?: boolean;
  /** Aim the camera at the burning nozzles of this vessel plus an offset in the site frame (east, north, up; m): a chase view. */
  aim?: { vessel: string; offset: [number, number, number] };
  /** Put the camera side-on to the first so many metres of this vessel's plume. */
  frame?: { vessel: string; length: number };
}

async function shoot(page: Page, sheet: string, shot: Shot): Promise<Buffer> {
  await openLab(page, shot.query);
  if (shot.backlit) {
    await page.evaluate(() => {
      const lab = window.__vfx!;
      const s = lab.sunEnu();
      lab.setCamera({ yawDeg: (Math.atan2(-s.x, -s.y) * 180) / Math.PI + 14 });
    });
  }
  if (shot.t !== undefined) await page.evaluate((x) => window.__vfx!.runTo(x), shot.t);
  if (shot.aim) {
    await page.evaluate((aim) => {
      const lab = window.__vfx!;
      const n = lab.nozzleEnu(aim.vessel);
      const base = lab.camera.follow ? lab.vesselEnu(lab.camera.follow) : { x: 0, y: 0, z: 0 };
      lab.setCamera({ target: { x: n.x - base.x + aim.offset[0], y: n.y - base.y + aim.offset[1], z: n.z - base.z + aim.offset[2] } });
    }, shot.aim);
  }
  if (shot.frame) await page.evaluate((f) => window.__vfx!.framePlume(f.vessel, f.length), shot.frame);
  await waitIdle(page, 40);
  const dir = path.join(repoRoot, 'out', 'screens', 'vfx', sheet);
  fs.mkdirSync(dir, { recursive: true });
  const buffer = await page.screenshot({ path: path.join(dir, `${shot.name}.png`) });
  const stats = pngStats(buffer);
  expect(stats.width, shot.name).toBe(1280);
  expect(stats.distinctColorBuckets, `${shot.name}: a real image`).toBeGreaterThan(6);
  return buffer;
}

function sheetTest(sheet: string, title: string, columns: number, shots: Shot[]): void {
  test(`matrix: ${title}`, async ({ page, pageLog }) => {
    const images: Buffer[] = [];
    for (const shot of shots) {
      images.push(await shoot(page, sheet, shot));
      await expectNoErrors(page, pageLog);
    }
    const file = saveSheet(sheet, images, columns, true);
    console.log(`${file}: ${shots.map((s) => s.name).join(', ')}`);
  });
}

// ---- every engine type at 100 % and at minimum throttle, at sea level, 10 km, 30 km, 60 km and in vacuum
const ALTITUDES: [string, string][] = [
  ['sl', 'altkm=0'],
  ['10km', 'altkm=10'],
  ['30km', 'altkm=30'],
  ['60km', 'altkm=60'],
  ['vac', 'altkm=200'],
];
for (const engine of ['atlas-9m', 'vela-2', 'vela-2v', 'lyra-d', 'lyra-a']) {
  sheetTest(
    `engine-${engine}`,
    `${engine} at 100 % (left) and minimum throttle (right); sea level, 10, 30, 60 km, vacuum (top to bottom)`,
    2,
    ALTITUDES.flatMap(([label, q]) => [
      { name: `${label}-full`, query: `scene=engine&engine=${engine}&${q}&throttle=1` },
      { name: `${label}-min`, query: `scene=engine&engine=${engine}&${q}&throttle=min` },
    ]),
  );
}
// Solid motors do not throttle: the escape motor (left) and the first stage's retro motors (right).
sheetTest(
  'engine-solids',
  'solid motors (escape motor left, retro motors right); sea level, 10, 30, 60 km, vacuum',
  2,
  ALTITUDES.flatMap(([label, q]) => [
    { name: `${label}-les`, query: `scene=engine&engine=kestrel-les&span=190&${q}` },
    { name: `${label}-retro`, query: `scene=engine&engine=meridian-m1-retro-motors&hide=meridian-m1-retro-motors&${q}`, frame: { vessel: 'engine', length: 26 } },
  ]),
);

// ---- the nine-engine booster at lift-off with smoke and steam: T+0, T+3 s, T+10 s, by day (left) and at night (right)
sheetTest('liftoff', 'lift-off at T+0, T+3 s, T+10 s by day (left) and at night (right)', 2, [
  { name: 't0-day', query: 'scene=pad', t: 4.0 },
  { name: 't0-night', query: 'scene=pad&night=1', t: 4.0 },
  { name: 't3-day', query: 'scene=pad', t: 7.0 },
  { name: 't3-night', query: 'scene=pad&night=1', t: 7.0 },
  { name: 't10-day', query: 'scene=pad', t: 14.0 },
  { name: 't10-night', query: 'scene=pad&night=1', t: 14.0 },
]);

// ---- the same lift-off from a chase camera 150 m away that follows the engines (left: day, right: night)
sheetTest('liftoff-chase', 'lift-off from a chase camera at 150 m: T+0, T+3 s, T+6 s, T+10 s by day (left) and at night (right)', 2, [
  { name: 't0-day', query: 'scene=pad&dist=150&pitch=4', t: 4.0, aim: { vessel: 'stack', offset: [0, 0, -8] } },
  { name: 't0-night', query: 'scene=pad&dist=150&pitch=4&night=1', t: 4.0, aim: { vessel: 'stack', offset: [0, 0, -8] } },
  { name: 't3-day', query: 'scene=pad&dist=150&pitch=4', t: 7.0, aim: { vessel: 'stack', offset: [0, 0, -14] } },
  { name: 't3-night', query: 'scene=pad&dist=150&pitch=4&night=1', t: 7.0, aim: { vessel: 'stack', offset: [0, 0, -14] } },
  { name: 't6-day', query: 'scene=pad&dist=150&pitch=4', t: 10.0, aim: { vessel: 'stack', offset: [0, 0, -20] } },
  { name: 't6-night', query: 'scene=pad&dist=150&pitch=4&night=1', t: 10.0, aim: { vessel: 'stack', offset: [0, 0, -20] } },
  { name: 't10-day', query: 'scene=pad&dist=150&pitch=4', t: 14.0, aim: { vessel: 'stack', offset: [0, 0, -30] } },
  { name: 't10-night', query: 'scene=pad&dist=150&pitch=4&night=1', t: 14.0, aim: { vessel: 'stack', offset: [0, 0, -30] } },
]);

// ---- engine plumes from chase distances of 45 to 110 m
sheetTest('plumes-close', 'plumes close up: booster at 45 m and 110 m (T+10 s), ascent at 12 km from 90 m, six vacuum engines from 60 m, staging from 70 m (separation, retro motors)', 2, [
  { name: 'booster-45m', query: 'scene=pad&dist=45&pitch=-4&fov=50', t: 14.0, aim: { vessel: 'stack', offset: [0, 0, -14] } },
  { name: 'booster-110m', query: 'scene=pad&dist=110&pitch=2&fov=45', t: 14.0, aim: { vessel: 'stack', offset: [0, 0, -30] } },
  { name: 'ascent-12km-90m', query: 'scene=ascent&altkm=12&speed=420&pad=0&dist=90', t: 3, aim: { vessel: 'stack', offset: [-12, 0, -30] } },
  { name: 'vacuum-60m', query: 'scene=vacuum&dist=60', t: 6.3 },
  { name: 'staging-separation-70m', query: 'scene=staging&dist=70', t: 2.56 },
  { name: 'staging-retro-70m', query: 'scene=staging&dist=70', t: 2.9 },
]);

sheetTest('ascent', 'ascent chase views at 2, 12, 30 and 60 km', 2, [
  { name: '2km', query: 'scene=ascent&altkm=2&speed=180&pad=0', t: 6 },
  { name: '12km', query: 'scene=ascent&altkm=12&speed=420&pad=0', t: 6 },
  { name: '30km', query: 'scene=ascent&altkm=30&speed=900&pad=0', t: 6 },
  { name: '60km', query: 'scene=ascent&altkm=60&speed=1900&pad=0', t: 6 },
]);

sheetTest('vacuum-ignition', 'upper-stage ignition in vacuum: 0.05, 0.3, 1 and 4 s after ignition', 2, [
  { name: 'ignition-0.05s', query: 'scene=vacuum', t: 2.35 },
  { name: 'ignition-0.3s', query: 'scene=vacuum', t: 2.6 },
  { name: 'ignition-1s', query: 'scene=vacuum', t: 3.3 },
  { name: 'ignition-4s', query: 'scene=vacuum', t: 6.3 },
]);

sheetTest('lunar', 'lander above lunar ground: 30 m by day and with the sun down (plume-lit regolith), 10 m, 3 m', 2, [
  { name: '30m-day', query: 'scene=lunar&h=30', t: 6 },
  { name: '30m-night', query: 'scene=lunar&h=30&night=1', t: 6 },
  { name: '10m-day', query: 'scene=lunar&h=10', t: 6 },
  { name: '3m-night', query: 'scene=lunar&h=3&night=1', t: 6 },
  { name: '30m-day-close', query: 'scene=lunar&h=30&dist=38&pitch=10', t: 6 },
  { name: '5m-day-close', query: 'scene=lunar&h=5&dist=30&pitch=14', t: 6 },
]);

sheetTest('rcs', 'RCS firings from 26 m (a pulse, all thrusters) and from 12 m, sunlit (left) and in shadow (right)', 2, [
  { name: 'pulse-sun', query: 'scene=rcs', t: 1 },
  { name: 'pulse-shadow', query: 'scene=rcs&sun=-20', t: 1 },
  { name: 'all-sun', query: 'scene=rcs&all=1', t: 1 },
  { name: 'all-shadow', query: 'scene=rcs&all=1&sun=-20', t: 1 },
  { name: 'all-sun-12m', query: 'scene=rcs&all=1&dist=12', t: 1 },
  { name: 'all-shadow-12m', query: 'scene=rcs&all=1&dist=12&sun=-20', t: 1 },
]);

sheetTest('staging', 'staging: burn, ullage motors, retro motors and gas puffs at separation, coast, second-stage ignition', 2, [
  { name: '0.4s-burn', query: 'scene=staging', t: 0.4 },
  { name: '2.4s-ullage', query: 'scene=staging', t: 2.4 },
  { name: '2.56s-separation', query: 'scene=staging', t: 2.56 },
  { name: '2.9s-retro', query: 'scene=staging', t: 2.9 },
  { name: '3.6s-coast', query: 'scene=staging', t: 3.6 },
  { name: '4.6s-ignition', query: 'scene=staging', t: 4.6 },
]);

sheetTest('reentry', 'reentry from the chase camera at plasmaIntensity 0.3 and 1.0 (day, night) and the trail from 50 km away', 2, [
  { name: 'plasma-0.3-day', query: 'scene=reentry&plasma=0.3', t: 8 },
  { name: 'plasma-1.0-day', query: 'scene=reentry&plasma=1', t: 8 },
  { name: 'plasma-0.3-night', query: 'scene=reentry&plasma=0.3&night=1', t: 8 },
  { name: 'plasma-1.0-night', query: 'scene=reentry&plasma=1&night=1', t: 8 },
  { name: 'trail-50km-day', query: 'scene=reentry&plasma=1&far=1', t: 20 },
  { name: 'trail-50km-night', query: 'scene=reentry&plasma=1&far=1&night=1', t: 20 },
]);

sheetTest('reentry-views', 'reentry at plasmaIntensity 1.0 (left) and 0.3 (right): from the front, from behind (the camera rides in the wake), close from the side', 2, [
  { name: 'front-1.0', query: 'scene=reentry&plasma=1&yaw=70&pitch=10&dist=18', t: 8 },
  { name: 'front-0.3', query: 'scene=reentry&plasma=0.3&yaw=70&pitch=10&dist=18', t: 8 },
  { name: 'behind-1.0', query: 'scene=reentry&plasma=1&yaw=265&pitch=8&dist=16', t: 8 },
  { name: 'behind-0.3', query: 'scene=reentry&plasma=0.3&yaw=265&pitch=8&dist=16', t: 8 },
  { name: 'side-close-1.0', query: 'scene=reentry&plasma=1&yaw=170&pitch=6&dist=11', t: 8 },
  { name: 'side-close-0.3', query: 'scene=reentry&plasma=0.3&yaw=170&pitch=6&dist=11', t: 8 },
]);

sheetTest('chutes', 'drogues reefed and full; three mains at each reefing stage (8 %, 30 %, full) against the light, and full with the sun behind the camera', 2, [
  { name: 'drogues-reefed', query: 'scene=chutes&chute=drogue&inflation=0.4' },
  { name: 'drogues-full', query: 'scene=chutes&chute=drogue&inflation=1' },
  { name: 'mains-reef1-backlit', query: 'scene=chutes&chute=main&inflation=0.08', backlit: true },
  { name: 'mains-reef2-backlit', query: 'scene=chutes&chute=main&inflation=0.3', backlit: true },
  { name: 'mains-full-backlit', query: 'scene=chutes&chute=main&inflation=1', backlit: true },
  { name: 'mains-full-frontlit', query: 'scene=chutes&chute=main&inflation=1' },
]);

sheetTest('splash', 'splashdown: just before, at impact (+0.1 s), +0.4 s, +1 s, +1.8 s, +2.5 s, +5 s (mains cut away), and +0.4 s / +1 s from 20 m', 2, [
  { name: 'before', query: 'scene=splash', t: 1.9 },
  { name: 'impact-0.1s', query: 'scene=splash', t: 2.15 },
  { name: 'impact-0.4s', query: 'scene=splash', t: 2.45 },
  { name: 'impact-1s', query: 'scene=splash', t: 3.05 },
  { name: 'impact-1.8s', query: 'scene=splash', t: 3.85 },
  { name: 'impact-2.5s', query: 'scene=splash', t: 4.55 },
  { name: 'impact-5s', query: 'scene=splash', t: 7.05 },
  { name: 'cut-away-6s', query: 'scene=splash&dist=120&tz=30&pitch=2', t: 8.05 },
  { name: 'close-0.4s', query: 'scene=splash&dist=20', t: 2.45 },
  { name: 'close-1s', query: 'scene=splash&dist=20', t: 3.05 },
]);

sheetTest('explosion', 'explosion: +0.03 s, +0.2 s, +0.6 s, +1.5 s, +3.5 s, +7 s by day; +0.2 s and +1.5 s at night', 2, [
  { name: 'day-0.03s', query: 'scene=explosion', t: 1.03 },
  { name: 'day-0.2s', query: 'scene=explosion', t: 1.2 },
  { name: 'day-0.6s', query: 'scene=explosion', t: 1.6 },
  { name: 'day-1.5s', query: 'scene=explosion', t: 2.5 },
  { name: 'day-3.5s', query: 'scene=explosion', t: 4.5 },
  { name: 'day-7s', query: 'scene=explosion', t: 8 },
  { name: 'night-0.2s', query: 'scene=explosion&night=1', t: 1.2 },
  { name: 'night-1.5s', query: 'scene=explosion&night=1', t: 2.5 },
  { name: 'close-0.6s', query: 'scene=explosion&dist=350', t: 1.6 },
  { name: 'close-2.5s', query: 'scene=explosion&dist=350', t: 3.5 },
]);
