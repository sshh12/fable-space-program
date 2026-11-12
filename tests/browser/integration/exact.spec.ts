/**
 * Frame-exact capture with every package present (request lead-3): the two pages of the lead's proof
 * (tests/browser/shell/baseline-tooling.spec.ts), captured twice on one page after different histories and
 * once more on a fresh load. Per capture: who was busy when a capture was not idle (so that a feature that a
 * restart of the temporal sequences sets to work is named), and where two captures differ.
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
const PAGES: Record<string, string> = {
  'leo-day': '/labs/integration/?scene=lowOrbit&orbit=30,15,60&hud=0&governor=off&deterministic=1&paused=1',
  'translunar-earth': '/labs/integration/?scene=translunar&hud=0&governor=off&deterministic=1&paused=1',
};

interface Capture {
  png: Buffer;
  attempts: { idle: boolean; busyBefore: string[]; busyAfter: string[] }[];
  ev100: number;
}

/** What tests/browser/harness.ts captureDeterministic does, with the names of the busy features per attempt. */
async function capture(page: Page): Promise<Capture> {
  const attempts: Capture['attempts'] = [];
  for (let attempt = 0; attempt < 5; attempt++) {
    await page.waitForFunction(() => window.__test!.isIdle(), undefined, { timeout: 240_000 });
    const r = await page.evaluate(async (n) => {
      const held = await window.__test!.renderExact!(n);
      const renderer = window.__lab!.renderer;
      return { held, info: renderer.exactInfo(), ev100: renderer.exposureInfo().ev100 };
    }, FRAMES);
    expect(r.held.frames).toBe(FRAMES);
    attempts.push({ idle: r.held.idle, busyBefore: r.info?.busyBefore ?? [], busyAfter: r.info?.busyAfter ?? [] });
    if (r.held.idle) return { png: await page.screenshot(), attempts, ev100: r.ev100 };
  }
  throw new Error(`not idle through ${FRAMES} frames in 5 attempts: ${JSON.stringify(attempts)}`);
}

for (const [name, url] of Object.entries(PAGES)) {
  test(`renderExact with every package: ${name} is the same picture after another history and on a fresh load`, async ({ page }) => {
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
    const line = (d: { meanAbs: number; p999: number; maxAbs: number; differingFraction: number }): string => `mean ${d.meanAbs.toFixed(5)}, p99.9 ${d.p999}, max ${d.maxAbs}, ${(100 * d.differingFraction).toFixed(3)} % of pixels`;
    console.log(`  ${name}: same page after another history: ${line(samePage)}; fresh load: ${line(freshLoad)}; EV100 ${a.ev100} / ${b.ev100} / ${c.ev100}`);
    console.log(`  ${name}: attempts ${JSON.stringify([a.attempts, b.attempts, c.attempts])}`);
    record(`f.exact.${name}`, { samePage, freshLoad, ev100: [a.ev100, b.ev100, c.ev100], attempts: [a.attempts, b.attempts, c.attempts] });

    // The exposure of the capture depends on the scene alone.
    expect(b.ev100).toBe(a.ev100);
    expect(c.ev100).toBe(a.ev100);
    // The manifest's floor (mean 0.02, 99.9th percentile 1): identical, or a rounding here and there.
    for (const d of [samePage, freshLoad]) {
      expect(d.meanAbs).toBeLessThanOrEqual(0.02);
      expect(d.p999).toBeLessThanOrEqual(1);
    }
  });
}
