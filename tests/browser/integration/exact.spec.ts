/**
 * Frame-exact capture with every package present (request lead-3): the two pages of the lead's proof
 * (tests/browser/shell/baseline-tooling.spec.ts), captured twice on one page after different histories and
 * once more on a fresh load. Per capture: how many times the exposure had to be metered (a restart of the
 * temporal sequences that sets a feature to work costs a round of 64 frames), who was busy, and where two
 * captures differ.
 *
 *   node tools/dev/heavy.mjs --class=gpu -- npx playwright test tests/browser/integration/exact.spec.ts --project=functional
 *
 * Numbers go to out/integration/results.json (f.exact.<scene>), differing pictures to out/screens/integration.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { assertDiscreteGpu, expect, imageDifference, openPage, test } from '../harness';
import { record, repoRoot } from './helpers';

test.describe.configure({ timeout: 900_000 });

const FRAMES = 64;
/**
 * The pages, and whether two captures of one must be the same picture. The low-orbit page is since
 * 2026-11-12 (request core-4, done by atmosphere-clouds; the lab forwards `resetTemporal`, request
 * atmosphere-clouds-12): before, its captures differed along the edges of the clouds in 15 to 19 % of the
 * pixels. In the first run with it (22:13) the FIRST capture of the first page differed from the two later
 * ones, which agreed, in 261 single pixels on the vessel's bright metal and in its glare, by up to 7 levels.
 * In the next run (22:44) this page was identical three times, and so were five fresh pages without one
 * package each; the page WITHOUT THE TERRAIN differed again (550 pixels, 124 of them the same ones, by up
 * to 15 levels): without the terrain's streaming to wait for, the first capture comes earlier. A third run
 * (23:35) took one more package away from that page: without the sky, the cockpit or the atmosphere the
 * two captures are identical; without the vfx or the ocean they differ (637 and 496 pixels). So it is not
 * the terrain's, the vfx's or the ocean's; it needs the sky, the atmosphere and the cockpit together; and
 * it is the first capture of a page against any later one (the sky's probe had completed 12 or 13 cycles at
 * the first, 26 or 27 at the later), not a sequence that is not restarted. Request core-7 (sky-lighting).
 * The test asks for bit-identical captures (softly, beside the manifest's floor) and logs the sky probe's
 * state at each capture.
 */
const PAGES: Record<string, { url: string; exact: boolean }> = {
  'leo-day': { url: '/labs/integration/?scene=lowOrbit&orbit=30,15,60&hud=0&governor=off&deterministic=1&paused=1', exact: true },
  'translunar-earth': { url: '/labs/integration/?scene=translunar&hud=0&governor=off&deterministic=1&paused=1', exact: true },
};

interface Attempt {
  idle: boolean;
  /** Meterings of the lead-in (1 = the restart set nobody to work) and who was busy after the first. */
  rounds: number;
  busyLeadIn: string[];
  busyBefore: string[];
  busyAfter: string[];
  /** The sky's environment probe at the capture: cycles completed, bodies with an albedo map bound. */
  probe: { completed: number; albedoMaps: number } | null;
}

interface Capture {
  png: Buffer;
  attempts: Attempt[];
  ev100: number;
}

/** What tests/browser/harness.ts captureDeterministic does, with the names of the busy features per attempt. */
async function capture(page: Page): Promise<Capture> {
  const attempts: Attempt[] = [];
  for (let attempt = 0; attempt < 5; attempt++) {
    await page.waitForFunction(() => window.__test!.isIdle(), undefined, { timeout: 240_000 });
    const r = await page.evaluate(async (n) => {
      const held = await window.__test!.renderExact!(n);
      const renderer = window.__lab!.renderer;
      const sky = window.__integration!.handles['sky.createSkyFeature'] as { probe?: () => { completed: number; albedoMaps: string[] } } | undefined;
      const state = typeof sky?.probe === 'function' ? sky.probe() : null;
      return { held, info: renderer.exactInfo(), ev100: renderer.exposureInfo().ev100, probe: state ? { completed: state.completed, albedoMaps: state.albedoMaps.length } : null };
    }, FRAMES);
    expect(r.held.frames).toBe(FRAMES);
    attempts.push({ idle: r.held.idle, rounds: r.info?.rounds ?? 0, busyLeadIn: r.info?.busyLeadIn ?? [], busyBefore: r.info?.busyBefore ?? [], busyAfter: r.info?.busyAfter ?? [], probe: r.probe });
    if (r.held.idle) return { png: await page.screenshot(), attempts, ev100: r.ev100 };
  }
  throw new Error(`not idle through ${FRAMES} frames in 5 attempts: ${JSON.stringify(attempts)}`);
}

for (const [name, { url, exact }] of Object.entries(PAGES)) {
  test(`renderExact with every package: ${name} is captured idle and equally exposed${exact ? ', the same picture after another history and on a fresh load' : ' (the picture: request core-4)'}`, async ({ page }) => {
    await openPage(page, url, { timeoutMs: 240_000 });
    await assertDiscreteGpu(page);
    const a = await capture(page);
    // Another history on the same page: the hold ends, 91 animated frames pass, deterministic again.
    await page.evaluate(() => window.__test!.setDeterministic(false));
    await page.evaluate(() => window.__test!.waitFrames(91));
    await page.evaluate(() => window.__test!.setDeterministic(true));
    const b = await capture(page);
    await openPage(page, url, { timeoutMs: 240_000 });
    const c = await capture(page);

    const dir = path.join(repoRoot, 'out', 'screens', 'integration');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `exact-${name}.png`), a.png);
    const compare = (x: Capture, y: Capture, tag: string): { meanAbs: number; p999: number; maxAbs: number; differingFraction: number } => {
      const d = imageDifference(x.png, y.png);
      if (d.maxAbs > 0) fs.writeFileSync(path.join(dir, `exact-${name}-${tag}.diff.png`), d.diff);
      return { meanAbs: d.meanAbs, p999: d.p999, maxAbs: d.maxAbs, differingFraction: d.differingFraction };
    };
    const samePage = compare(a, b, 'same-page');
    const freshLoad = compare(a, c, 'fresh-load');
    // Which of the three stands apart, when they are not the same: the later capture of the first page against the fresh load.
    const laterAgainstFresh = compare(b, c, 'later-vs-fresh');
    const line = (d: { meanAbs: number; p999: number; maxAbs: number; differingFraction: number }): string => `mean ${d.meanAbs.toFixed(5)}, p99.9 ${d.p999}, max ${d.maxAbs}, ${(100 * d.differingFraction).toFixed(3)} % of pixels`;
    console.log(`  ${name}: same page after another history: ${line(samePage)}; fresh load: ${line(freshLoad)}; the later capture against the fresh load: ${line(laterAgainstFresh)}; EV100 ${a.ev100} / ${b.ev100} / ${c.ev100}`);
    const all = [a.attempts, b.attempts, c.attempts];
    console.log(`  ${name}: attempts ${JSON.stringify(all)}`);
    record(`f.exact.${name}`, { exact, samePage, freshLoad, ev100: [a.ev100, b.ev100, c.ev100], attempts: all });

    // The exposure of the capture depends on the scene alone.
    expect(b.ev100).toBe(a.ev100);
    expect(c.ev100).toBe(a.ev100);
    if (!exact) return;
    // The manifest's floor (mean 0.02, 99.9th percentile 1): identical, or a rounding here and there.
    for (const d of [samePage, freshLoad]) {
      expect(d.meanAbs).toBeLessThanOrEqual(0.02);
      expect(d.p999).toBeLessThanOrEqual(1);
    }
    // And to the bit (soft: the diff pictures and the attempts' lines above say which capture stands apart).
    expect.soft(Math.max(samePage.maxAbs, freshLoad.maxAbs, laterAgainstFresh.maxAbs), 'the three captures are identical to the bit').toBe(0);
  });
}
