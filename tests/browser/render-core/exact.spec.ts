/**
 * Frame-exact capture (request lead-3): `window.__test.renderExact(n)` restarts every temporal sequence at its
 * origin, renders exactly n frames and holds the last one. The same page state and the same n give the same
 * picture whatever the page rendered before, and on a fresh load; the held frame stays on screen until the
 * hold ends.
 *
 *   node tools/dev/heavy.mjs --class=gpu -- npx playwright test tests/browser/render-core/exact.spec.ts --project=functional
 */
import type { Page } from '@playwright/test';
import { assertDiscreteGpu, expect, expectNoErrors, openPage, pngDiff, saveScreenshot, test, waitIdle } from '../harness';

test.describe.configure({ timeout: 600_000 });

const PAGE = '/labs/render-core/?scene=pad&site=moonview&hud=0&fov=12&paused=1&deterministic=1';
const FRAMES = 32;

/** The view of stability.spec.ts: a cylinder 30 m away, sunlit, with its shadow, and the Moon behind it. */
async function setUp(page: Page): Promise<void> {
  await page.evaluate(() => {
    const rc = window.__rc!;
    const moonId = rc.probes.ridgeSite.bodyId;
    const d = rc.directionAtSite(moonId);
    rc.setSun([d.azDeg + 140, 30]);
    rc.lookAt([0, 28, 20], d.azDeg + 180 + 7, -d.elDeg, 30);
  });
}

const exact = (page: Page, frames: number) => page.evaluate((n) => window.__test!.renderExact!(n), frames);
const state = (page: Page) =>
  page.evaluate(() => {
    const r = window.__lab!.renderer;
    return { frameIndex: r.frameContext!.frameIndex, ev100: r.exposureInfo().ev100, holding: r.holding };
  });

test('renderExact: the same picture after different histories and on a fresh load, and the frame is held', async ({ page, pageLog }) => {
  await openPage(page, PAGE);
  await assertDiscreteGpu(page);
  expect(await page.evaluate(() => typeof window.__test!.renderExact)).toBe('function');
  await setUp(page);
  await waitIdle(page, 30);

  const first = await exact(page, FRAMES);
  expect(first.frames).toBe(FRAMES);
  expect(first.idle).toBe(true);
  expect(first.renderScale).toBeGreaterThan(0);
  const a = await saveScreenshot(page, 'render-core', 'exact-a');
  expect(a.stats.fractionNonBlack, 'the held frame is a picture').toBeGreaterThan(0.2);
  const s0 = await state(page);
  expect(s0.holding).toBe(true);
  // The sequences started at a multiple of the alignment (SEQUENCE_ALIGN) and exactly FRAMES frames followed.
  expect((s0.frameIndex - (FRAMES - 1)) % 64).toBe(0);

  // Held: the display's frames pass (waitFrames still returns), nothing is rendered, the picture stays.
  await page.evaluate(() => window.__test!.waitFrames(20));
  const s1 = await state(page);
  expect(s1.frameIndex).toBe(s0.frameIndex);
  const held = await page.screenshot();
  expect(pngDiff(a.buffer, held).maxAbsDiff, 'the same frame 20 display frames later').toBe(0);

  // A different history: the hold ends with deterministic mode, 37 animated frames pass (another jitter and
  // noise phase, the exposure adapting, staggered shadow cascades somewhere in their rounds), then again.
  await page.evaluate(() => window.__test!.setDeterministic(false));
  await page.evaluate(() => window.__test!.waitFrames(37));
  const s2 = await state(page);
  expect(s2.holding).toBe(false);
  expect(s2.frameIndex).toBeGreaterThan(s1.frameIndex + 30);
  await page.evaluate(() => window.__test!.setDeterministic(true));
  await page.evaluate(() => window.__test!.waitFrames(5));
  const second = await exact(page, FRAMES);
  expect(second).toEqual(first);
  const b = await page.screenshot();
  const s3 = await state(page);
  const ab = pngDiff(a.buffer, b);
  console.log(`  exact, same page after another history: mean ${ab.meanAbsDiff.toFixed(5)}, max ${ab.maxAbsDiff}; ev100 ${s0.ev100} / ${s3.ev100}`);
  expect(s3.ev100, 'the exposure of the capture depends on the scene alone').toBe(s0.ev100);
  expect(ab.maxAbsDiff, 'same page, another history').toBe(0);

  // Another number of frames is another frame of the sequences (the resolve has gathered fewer samples).
  const fewer = await exact(page, 3);
  expect(fewer.frames).toBe(3);
  const c = await page.screenshot();
  expect(pngDiff(a.buffer, c).maxAbsDiff, 'three frames are not thirty-two').toBeGreaterThan(0);

  // Without deterministic mode the call is refused, and the page renders on.
  await page.evaluate(() => window.__test!.setDeterministic(false));
  const refused = await page.evaluate(() =>
    window.__test!.renderExact!(4).then(
      () => 'resolved',
      (e: unknown) => String(e),
    ),
  );
  expect(refused).toContain('deterministic');
  await expectNoErrors(page, pageLog);

  // A fresh load of the same page.
  await openPage(page, PAGE);
  await setUp(page);
  await waitIdle(page, 30);
  const third = await exact(page, FRAMES);
  expect(third).toEqual(first);
  const d = await page.screenshot();
  const s4 = await state(page);
  const ad = pngDiff(a.buffer, d);
  console.log(`  exact, fresh load: mean ${ad.meanAbsDiff.toFixed(5)}, max ${ad.maxAbsDiff}; ev100 ${s4.ev100}`);
  expect(s4.ev100).toBe(s0.ev100);
  expect(ad.maxAbsDiff, 'fresh load').toBe(0);
  await expectNoErrors(page, pageLog);
});
