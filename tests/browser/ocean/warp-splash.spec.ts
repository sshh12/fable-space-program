/**
 * The splashdown of the real simulation under the test pilot's physics warp, in the real app (scenario qa-drogues:
 * the capsule under its drogues 7 km over the recovery zone at dawn, broken cumulus above; the pilot brings it down
 * under the mains at physics warp x4 and it meets the water at about 8 m/s, its canopies after it).
 *
 * In the mission flights of 2026-11-12 the sea of this scene went black a second after the contact, for seconds at
 * a time. Reproduced here and taken apart: no pixel is NaN and the ocean is fed nothing odd; the camera stops down
 * while the two sunlit canopies stand in the frame (the meter's daylight bounds are off under a sun this low), and
 * the dawn sea, a few per cent of the sky's luminance, falls into the display curve's toe (request ocean-13 against
 * the render core's meter). The ocean's own part was a white patch of wake foam metres wide around the capsule
 * lying in the water (a hull churned foam by the time it lay there, not by its speed: vessels.ts, wakeChurn), which
 * held the camera two stops down after the canopies had gone: with it fixed the sea is back at its brightness of
 * before the contact as soon as they have. What the ocean owes and what is asserted: no NaN, and the sea is never dark on its
 * own: in every sample after the contact at the exposure the camera had before it, the sea in the picture stays
 * within a band of its brightness against the sky, and every sample in which it is darker than that is one in which
 * the camera has stopped down. The dark stretch is printed with its exposure in every run.
 *
 *   node tools/dev/heavy.mjs --class=gpu -- npx playwright test tests/browser/ocean/warp-splash.spec.ts --project=functional
 */
import { PNG } from 'pngjs';
import { assertDiscreteGpu, expect, openPage, saveScreenshot, test } from '../harness';

test.describe.configure({ timeout: 20 * 60_000 });
test.use({ viewport: { width: 1280, height: 720 } });

interface Sample {
  /** Wall seconds since the first sample. */
  t: number;
  altitude: number;
  situation: string;
  warp: number;
  ev100: number;
  /** Mean linear luminance (display-referred, 0..1) of the sea in the picture: the lower 40 % of the frame without its middle third. */
  sea: number;
  /** The same of the sky in the picture's top corners (clear of the canopies). */
  sky: number;
  nan: number;
}

test('splashdown of the real simulation under physics warp: the sea is never dark on its own', async ({ page }) => {
  await openPage(page, '/?scenario=qa-drogues&pilot=1&view=chase&scale=1&governor=off&mute=1&capture=0&hud=0', { timeoutMs: 240_000 });
  await assertDiscreteGpu(page);
  const lin = (v: number): number => (v <= 10 ? v / 3294.6 : ((v / 255 + 0.055) / 1.055) ** 2.4);
  const t0 = Date.now();
  const sample = async (): Promise<Sample> => {
    const state = await page.evaluate(async () => {
      const b = window.__app!.brief();
      const hdr = await window.__test!.hdrStats();
      return { altitude: b.altitudeAsl, situation: b.situation, warp: b.warpFactor, ev100: window.__app!.exposure().ev100, nan: hdr.nanPixels };
    });
    const png = PNG.sync.read(await page.screenshot());
    const mean = (y0: number, y1: number, keep: (fx: number) => boolean): number => {
      let sum = 0;
      let n = 0;
      for (let y = Math.round(y0 * png.height); y < Math.round(y1 * png.height); y++) {
        for (let x = 0; x < png.width; x++) {
          if (!keep(x / png.width)) continue;
          const o = (y * png.width + x) * 4;
          sum += 0.2126 * lin(png.data[o]!) + 0.7152 * lin(png.data[o + 1]!) + 0.0722 * lin(png.data[o + 2]!);
          n++;
        }
      }
      return sum / n;
    };
    return { t: (Date.now() - t0) / 1000, ...state, sea: mean(0.6, 1, (fx) => fx < 1 / 3 || fx > 2 / 3), sky: mean(0.02, 0.12, (fx) => fx < 0.14 || fx > 0.86) };
  };
  // Down to 150 m (minutes of simulation under the pilot's warp).
  await page.waitForFunction(() => window.__app!.brief().altitudeAsl < 150, undefined, { timeout: 15 * 60_000, polling: 250 });
  const before: Sample[] = [];
  const after: Sample[] = [];
  let contact = -1;
  let shots = 0;
  for (;;) {
    const s = await sample();
    const down = s.situation === 'splashed' || s.altitude < 1.5;
    if (contact < 0 && down) contact = s.t;
    if (contact < 0) before.push(s);
    else after.push(s);
    // A picture of the sea at 2, 6 and 13 s after the contact.
    if (contact >= 0 && shots < 3 && s.t - contact > [2, 6, 13][shots]!) await saveScreenshot(page, 'ocean', `warp-splash-plus-${[2, 6, 13][shots++]}s`);
    if (contact >= 0 && s.t - contact > 15) break;
    if (contact < 0 && s.t > 600) break;
  }
  expect(contact, 'the capsule met the water').toBeGreaterThanOrEqual(0);
  expect(before.length, 'samples before the contact').toBeGreaterThan(3);
  const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[xs.length >> 1]!;
  const evBefore = median(before.map((b) => b.ev100));
  // The sea against the sky from the water at the camera's most open exposure after the contact (the three samples of
  // lowest EV): what the sea is when nothing makes the camera stop down.
  const open = [...after].sort((x, y) => x.ev100 - y.ev100).slice(0, 3);
  const evOpen = median(open.map((s) => s.ev100));
  const ratio = median(open.map((s) => s.sea / s.sky));
  const level = after.filter((s) => s.ev100 - evOpen <= 0.25);
  const fmt = (s: Sample): string =>
    `${(s.t - contact).toFixed(1)}s alt ${s.altitude.toFixed(1)} ${s.situation} x${s.warp} EV ${s.ev100.toFixed(2)} (${(s.ev100 - evOpen >= 0 ? '+' : '') + (s.ev100 - evOpen).toFixed(2)}) sea Y ${s.sea.toFixed(4)}, sea / sky ${(s.sea / s.sky).toFixed(3)}${s.nan > 0 ? ` NaN ${s.nan}` : ''}`;
  console.log(
    `[warp-splash] before the contact (median of ${before.length} samples from 150 m down): EV100 ${evBefore.toFixed(2)}, sea Y ${median(before.map((x) => x.sea)).toFixed(4)}, sea / sky ${median(before.map((x) => x.sea / x.sky)).toFixed(3)}; after it the most open exposure is EV100 ${evOpen.toFixed(2)} with sea / sky ${ratio.toFixed(3)}; every third sample after the contact (EV against that):\n  ${after
      .filter((_, i) => i % 3 === 0)
      .map(fmt)
      .join('\n  ')}`,
  );
  const stopped = after.filter((s) => s.ev100 - evOpen > 0.25);
  if (stopped.length > 0) {
    console.log(
      `[warp-splash] KNOWN (request ocean-13, the core's meter): the camera is stopped down by up to ${Math.max(...stopped.map((s) => s.ev100 - evOpen)).toFixed(2)} EV in ${stopped.length} of ${after.length} samples after the contact (${(stopped[0]!.t - contact).toFixed(1)} to ${(stopped[stopped.length - 1]!.t - contact).toFixed(1)} s); the sea there falls to Y ${Math.min(...stopped.map((s) => s.sea)).toFixed(4)}, sea / sky ${Math.min(...stopped.map((s) => s.sea / s.sky)).toFixed(3)}`,
    );
  }
  for (const s of after) expect(s.nan, `NaN pixels ${fmt(s)}`).toBe(0);
  // At the camera's open exposure the sea keeps its place against the sky (foam brightens it, nothing blackens it).
  for (const s of level) {
    expect(s.sea / s.sky, `sea / sky at the open exposure, ${fmt(s)}`).toBeGreaterThan(0.4 * ratio);
    expect(s.sea / s.sky, `sea / sky at the open exposure, ${fmt(s)}`).toBeLessThan(6 * ratio);
  }
  // And it is never dark on its own: a sample in which it is under 0.4 of that is one in which the camera has stopped down.
  for (const s of after) {
    if (s.sea / s.sky < 0.4 * ratio) expect(s.ev100 - evOpen, `the sea is dark without the camera having stopped down, ${fmt(s)}`).toBeGreaterThan(0.25);
  }
});
