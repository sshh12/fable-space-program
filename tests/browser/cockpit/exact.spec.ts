/**
 * Frame-exact captures of the cabin (request lead-5; RENDER_API section 13): a cockpit view captured with
 * `window.__test.renderExact` is the same picture, bit for bit, in two consecutive captures, on the same
 * page after another history (animated frames in between: the displays pace, the lamps blink, the probe
 * runs on) and on two fresh loads. What makes it so in this package: `CockpitFeature.resetTemporal()` (the
 * clock on the core's sequence index while time is frozen, the far level's light interval, the smoothed g,
 * the displays' pacing back to "nothing painted", the lamps' shadow maps, the probe built from nothing in the
 * next frame), display pages painted to their finished state within the frame while time is frozen, and
 * `isIdle()` (busy while a readable display is unpainted, the lamp maps are being rendered again or the
 * probe has not had its frames).
 *
 *   node tools/dev/heavy.mjs --class=gpu -- npx playwright test tests/browser/cockpit/exact.spec.ts --project=functional
 *
 * A capture that differs is written to out/screens/cockpit/exact/<view>-<comparison>.diff.png.
 *
 * FIRST CAPTURE. In this lab's seat views the very first capture of a cold browser context differs from every
 * later one (1 to 3 % of the pixels, up to 30 levels, on the edges of lamp and sun shadows and of highlights;
 * none when lamp shadows, reflections, detail maps, sources or screens are switched off; none in the outside
 * views; none in the integration lab's cockpit checkpoints). Every later capture, the first capture of every
 * later load included, is the same picture. The cause is not found. The recorder throws the first capture of
 * a load away, and so does this spec; the difference is logged, not asserted.
 */
import fs from 'node:fs';
import path from 'node:path';
import { assertDiscreteGpu, captureDeterministic, expect, expectNoErrors, imageDifference, openPage, test } from '../harness';

test.describe.configure({ timeout: 600_000 });

const FRAMES = 64;

const VIEWS: { name: string; query: string }[] = [
  // From the seat in the sun: the sun patch (its gathers turn with the frame), the three displays, the probe.
  { name: 'seat-leo', query: 'scene=leo' },
  // From the seat in the dark: floods through their shadow maps, the lamps' pools, the displays as light.
  { name: 'seat-night', query: 'scene=night' },
  // Entry: the plasma's wander and each window's share of it run on the cabin's clock.
  { name: 'seat-reentry', query: 'scene=reentry' },
  // From outside at night, the lit cabin behind its window: the far light interval, the probe from outside.
  { name: 'chase-lit-window', query: 'scene=night&view=chase&window=fwd-left&distance=0.7&fov=45' },
  // The same from farther off (the cabin at a far detail level: its light passes run every eighth frame).
  { name: 'chase-far-lit-windows', query: 'scene=night&view=chase&window=fwd-left&distance=9&fov=45' },
];

const url = (query: string): string => `/labs/cockpit/?${query}&hud=0&governor=off&deterministic=1&paused=1`;

for (const v of VIEWS) {
  test(`renderExact, ${v.name}: the same picture bit for bit in consecutive captures, after another history and on two fresh loads`, async ({ page, pageLog }) => {
    await openPage(page, url(v.query), { timeoutMs: 240_000 });
    await assertDiscreteGpu(page);
    // The first capture of a load is thrown away, as the recorder of the reference images does (request lead-5,
    // Acceptance). It is compared all the same and the result logged: see FIRST CAPTURE in the header.
    const first = await captureDeterministic(page, FRAMES);
    const a = await captureDeterministic(page, FRAMES);
    const again = await captureDeterministic(page, FRAMES);
    const third = await captureDeterministic(page, FRAMES);
    // Another history on the same page: the hold ends and animated frames pass (wall-clock pacing of the
    // displays, blinking lamps, the probe's alternating halves), then time is frozen again.
    await page.evaluate(async () => {
      window.__test!.setDeterministic(false);
      await window.__test!.waitFrames(53);
      window.__test!.setDeterministic(true);
    });
    const history = await captureDeterministic(page, FRAMES);
    await openPage(page, url(v.query), { timeoutMs: 240_000 });
    const freshFirst = await captureDeterministic(page, FRAMES);
    const fresh = await captureDeterministic(page, FRAMES);
    await openPage(page, url(v.query), { timeoutMs: 240_000 });
    await captureDeterministic(page, FRAMES);
    const fresh2 = await captureDeterministic(page, FRAMES);

    const dir = path.join(process.cwd(), 'out', 'screens', 'cockpit', 'exact');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${v.name}.png`), a);
    const compared = (
      [
        ['second-capture', again],
        ['third-capture', third],
        ['after-history', history],
        ['fresh-load', fresh],
        ['second-fresh-load', fresh2],
      ] as const
    ).map(([tag, other]) => {
      const diff = imageDifference(a, other);
      if (diff.maxAbs > 0) fs.writeFileSync(path.join(dir, `${v.name}-${tag}.diff.png`), diff.diff);
      return { tag, maxAbs: diff.maxAbs, differing: diff.differingFraction };
    });
    const d0 = imageDifference(a, first);
    const d1 = imageDifference(a, freshFirst);
    console.log(`[exact] ${v.name}: thrown-away first capture of the cold load: max ${d0.maxAbs}, ${(100 * d0.differingFraction).toFixed(4)} % of pixels; of the second load: max ${d1.maxAbs}, ${(100 * d1.differingFraction).toFixed(4)} % of pixels`);
    console.log(`[exact] ${v.name}: ${compared.map((x) => `${x.tag}: max ${x.maxAbs}, ${(100 * x.differing).toFixed(4)} % of pixels`).join('; ')}`);
    for (const x of compared) expect(x.maxAbs, `${v.name}, ${x.tag}: largest difference of a channel, 8-bit levels`).toBe(0);
    await expectNoErrors(page, pageLog);
  });
}
