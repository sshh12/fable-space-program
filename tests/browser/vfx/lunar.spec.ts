/**
 * Dust under a lander on the Moon, in the integration lab (the real terrain, the real lander, every feature).
 * Without air the dust leaves in a flat sheet along the ground: it does not rise in front of the sky and it
 * does not hide the ground (critics of round 2: "a haze glow 8 to 9 degrees above the horizon and a full
 * grey-out in the hover"). Measured against the same view with the engine off, under a pinned low sun (the
 * grey-out the critics saw was the lab's own: its site lies in the dark, and a camera that looks towards the
 * sun below that horizon is washed out by the lens flare with the engine off as well; request vfx-10).
 */
import { PNG } from 'pngjs';
import { assertDiscreteGpu, expect, expectNoErrors, openPage, saveScreenshot, test } from '../harness';

test.describe.configure({ timeout: 600_000 });

// The sun of the lab's landing site is pinned 12 degrees up in the east-south-east (an Apollo morning: by
// default the site lies in the dark at the lab's epoch, exposed at EV100 -0.6, where the lander's own light
// decides the exposure). The eye stands south of the lander, the sun to its right and behind it.
const SUN = 'sun=110,12&sunsite=moon,0.661471,23.435999';
const VIEW = 'window.__integration.orbitVesselPoint(170, 12, 34, -2)';

async function hover(page: import('@playwright/test').Page, throttle: number, name: string): Promise<PNG> {
  await openPage(page, `/labs/integration/?scene=lunarSurface&features=all&hud=0&hover=8&throttle=${throttle}&${SUN}`);
  await assertDiscreteGpu(page);
  await page.evaluate(VIEW);
  await page.evaluate((n) => window.__test!.waitFrames(n), 240);
  const shot = await saveScreenshot(page, 'vfx/lunar-probe', name);
  return PNG.sync.read(shot.buffer);
}

const lum = (im: PNG, x: number, y: number): number => {
  const a = (y * im.width + x) * 4;
  return (0.2126 * im.data[a]! + 0.7152 * im.data[a + 1]! + 0.0722 * im.data[a + 2]!) / 255;
};

/** Standard deviation of the luminance in the 16 x 16 block at (bx, by). */
function contrast(im: PNG, bx: number, by: number): number {
  let s = 0;
  let s2 = 0;
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      const v = lum(im, bx * 16 + x, by * 16 + y);
      s += v;
      s2 += v * v;
    }
  }
  const mean = s / 256;
  return Math.sqrt(Math.max(0, s2 / 256 - mean * mean));
}

test('a hover at 8 m on the Moon: the sky stays black to the horizon and the ground keeps its detail', async ({ page, pageLog }) => {
  const off = await hover(page, 0, 'hover-engine-off');
  const on = await hover(page, 0.5, 'hover-engine-on');
  // The horizon of each column: the first row from the top whose luminance with the engine off is the ground's.
  const horizon: number[] = [];
  for (let x = 0; x < off.width; x++) {
    let y = 0;
    while (y < off.height && lum(off, x, y) < 0.06) y++;
    horizon.push(y);
  }
  // The sky from 5 to 10 degrees above the horizon (the lab's field of view is 50 degrees over the height).
  const perDegree = off.height / 50;
  let sky = 0;
  let skyOff = 0;
  let n = 0;
  for (let x = 0; x < on.width; x += 4) {
    for (let y = Math.round(horizon[x]! - 10 * perDegree); y < horizon[x]! - 5 * perDegree; y += 4) {
      if (y < 0) continue;
      sky += lum(on, x, y);
      skyOff += lum(off, x, y);
      n++;
    }
  }
  expect(n, 'sky samples above the horizon').toBeGreaterThan(500);
  sky /= n;
  skyOff /= n;
  // The ground: blocks of 16 x 16 pixels below the horizon that show detail with the engine off.
  let blocks = 0;
  let kept = 0;
  let ground = 0;
  let groundOff = 0;
  for (let by = 0; by < Math.floor(off.height / 16); by++) {
    for (let bx = 0; bx < Math.floor(off.width / 16); bx++) {
      if (by * 16 < horizon[bx * 16 + 8]! + 8) continue;
      const c0 = contrast(off, bx, by);
      ground += lum(on, bx * 16 + 8, by * 16 + 8);
      groundOff += lum(off, bx * 16 + 8, by * 16 + 8);
      if (c0 < 0.004) continue;
      blocks++;
      if (contrast(on, bx, by) >= 0.5 * c0) kept++;
    }
  }
  console.log(
    `lunar hover at 8 m, engine on / off: sky 5 to 10 degrees above the horizon ${(100 * sky).toFixed(2)} / ${(100 * skyOff).toFixed(2)} % of white; ` +
      `ground blocks that keep half of their contrast ${kept} of ${blocks}; mean ground ${(100 * ground).toFixed(0)} / ${(100 * groundOff).toFixed(0)} (arbitrary)`,
  );
  expect(sky, 'sky 5 to 10 degrees above the horizon with the engine on, share of white').toBeLessThan(0.02);
  expect(blocks, 'ground blocks with detail').toBeGreaterThan(100);
  expect(kept / blocks, 'share of the ground blocks that keep at least half of their local contrast').toBeGreaterThan(0.5);
  await expectNoErrors(page, pageLog);
});
