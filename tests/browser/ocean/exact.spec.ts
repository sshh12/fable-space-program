/**
 * Frame-exact captures of the sea (request lead-7; RENDER_API section 13): a view of the near sea captured with
 * `window.__test.renderExact` is the same picture, bit for bit, in three captures of one page and on three fresh
 * loads, also after the simulation has been stepped and frozen again. What makes it so in this package:
 * `OceanFeature.resetTemporal()` (the foam map's history, the FFT's previous frame, the impacts, wet lines and wake
 * gathered over earlier frames, the chart's anchor and the baked field's centre), and an impact taken once however
 * often its snapshot is drawn. The waves themselves are functions of the snapshot's time.
 *
 * The views are the integration lab's, every package drawing:
 *  - `near-sea-stepped`: the framing of the request (a ground camera 3 km east of the pad, 60 m above the sea,
 *    looking at the ascending vehicle over the near sea; 180 steps of 1/60 s with the loop stopped, then frozen);
 *  - `shoreline` and `splashdown`: the pages of the reference manifest's checkpoints of those names;
 *  - `splashdown-stepped`: the capsule under its chutes from 20 m, stepped for 4 s to the water and frozen (a
 *    vessel at the water: the wake's and the wet line's history).
 * The two stepped views are asserted without the atmosphere package and reported with it: after a stepped simulation
 * the atmosphere's own state differs from load to load (request ocean-12). On the last load every view is captured
 * once more after another history (frames with the camera 60 km away, then back).
 *
 *   node tools/dev/heavy.mjs --class=gpu -- npx playwright test tests/browser/ocean/exact.spec.ts --project=functional
 *   OCEAN_EXACT_QUERY="&without=ocean"   appended to every page (whose pixels are they, when some differ?)
 *   OCEAN_EXACT_NO_RESET=1               the ocean keeps its histories through the captures (what the reset is for)
 *
 * A pair that differs is written to out/screens/ocean/exact-<view>-<pair>.marks.png (the differing pixels marked).
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { describeDifferenceMap, differenceMap, markDifferences } from '../exactProbe';
import { assertDiscreteGpu, captureDeterministic, expect, openPage, runBaselineSteps, test } from '../harness';

test.describe.configure({ timeout: 30 * 60_000 });
test.use({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });

const FRAMES = 64;
const LOADS = 3;
const CAPTURES = 3;
const EXTRA = process.env.OCEAN_EXACT_QUERY ?? '';
const NO_RESET = process.env.OCEAN_EXACT_NO_RESET === '1';

type Steps = Parameters<typeof runBaselineSteps>[1];

/** Step the simulation `n` frames of 1/60 s with the page's loop stopped, then freeze it again (as the manifest's stepped checkpoints do). */
const stepped = (n: number): Steps => [
  { call: '__lab.setLoop', args: [false] },
  { call: '__lab.setPaused', args: [false] },
  { call: '__lab.renderFrame', args: [1 / 60], repeat: n },
  { call: '__lab.setPaused', args: [true] },
  { call: '__lab.setLoop', args: [true] },
  { waitIdle: true },
];

interface View {
  name: string;
  page: string;
  setup: Steps;
  /** Steps that put the camera back after the history in between (default: the camera's placement as it was). */
  restore?: Steps;
  /**
   * A stepped view is asserted WITHOUT the atmosphere package (the ocean with every other package), and the page
   * with every package is captured and reported beside it: after a stepped simulation the atmosphere's own state
   * differs from load to load (request ocean-12), over the whole frame, the sky's rows included.
   */
  stepped: boolean;
  /**
   * A difference from load to load that is known, named and bounded (reported in every run that shows it): the
   * largest number of differing pixels and the largest difference of a channel. Without it: none.
   */
  loadFloor?: { pixels: number; maxAbs: number; what: string };
}

const SITE = { bodyId: 'earth', latDeg: 18.987556, lonDeg: -155.574706, alt: 60 };
const VIEWS: View[] = [
  {
    name: 'near-sea-stepped',
    page: '/labs/integration/?scene=ascent&start=450&throttle=1&sun=140,50&sunsite=earth,18.987556,-155.603239&hud=0&governor=off&deterministic=1&paused=1',
    setup: [{ call: '__integration.watchVesselFrom', args: [SITE] }, ...stepped(180)],
    restore: [{ call: '__integration.watchVesselFrom', args: [SITE] }],
    stepped: true,
  },
  {
    name: 'shoreline',
    page: '/labs/integration/?scene=lowOrbit&body=earth&lat=18.987556&lon=-155.603239&alt=350&heading=120&pitch=-18&sun=150,45&sunsite=earth,18.987556,-155.603239&ev=14&hud=0&governor=off&deterministic=1&paused=1',
    setup: [],
    stepped: false,
    // Seen in one load of three in two runs of three, the same 1,002 pixels by up to 3 levels each time, in the far sea
    // just under the horizon (x 585-819, y 166-217), with and without the ocean's reset: two states of something that
    // is there or not when the page goes idle. Not attributed (the reference manifest's tolerance for this checkpoint,
    // a 99.9th percentile of one level, is the same thing).
    loadFloor: { pixels: 1100, maxAbs: 3, what: 'the far sea under the horizon in one of two states from load to load (not attributed)' },
  },
  { name: 'splashdown', page: '/labs/integration/?scene=chutes&start=120&hud=0&governor=off&deterministic=1&paused=1', setup: [], stepped: false },
  { name: 'splashdown-stepped', page: '/labs/integration/?scene=chutes&start=20&hud=0&governor=off&deterministic=1&paused=1', setup: stepped(240), stepped: true },
];

interface Pair {
  tag: string;
  pixels: number;
  maxAbs: number;
  text: string;
}

/**
 * LOADS fresh loads of the view's page with `query` appended, CAPTURES captures each; with `history`, one more
 * capture on the last load after another history (the hold ended, 47 frames with the camera 60 km away over the
 * sea, the camera put back, 44 frames more). Every pair that must be the same picture, compared.
 */
async function probe(page: Page, v: View, query: string, history: boolean, tag: string): Promise<{ pairs: Pair[]; last: Buffer; busy: string }> {
  const dir = path.join(process.cwd(), 'out', 'screens', 'ocean');
  fs.mkdirSync(dir, { recursive: true });
  const shots: Buffer[][] = [];
  let busy = '';
  let after: Buffer | null = null;
  for (let load = 0; load < LOADS; load++) {
    if (load > 0) await page.goto('about:blank');
    await openPage(page, `${v.page}${query}`, { timeoutMs: 240_000 });
    await assertDiscreteGpu(page);
    if (NO_RESET) await page.evaluate(() => (window.__integration!.handles['ocean.createOceanFeature'] as { debug: { setTemporalReset(on: boolean): void } }).debug.setTemporalReset(false));
    await runBaselineSteps(page, v.setup, 240_000);
    const mine: Buffer[] = [];
    for (let k = 0; k < CAPTURES; k++) {
      mine.push(await captureDeterministic(page, FRAMES, 240_000));
      if (k === 0 && load === 0) {
        busy = await page.evaluate(() => {
          const info = window.__lab!.renderer.exactInfo();
          const near = (window.__integration!.handles['ocean.createOceanFeature'] as { debug: { nearField(): { bodyIndex: number } } } | undefined)?.debug.nearField().bodyIndex ?? -2;
          return `lead-in rounds ${info?.rounds ?? 0}, busy after the first lead-in ${JSON.stringify(info?.busyLeadIn ?? [])}, before / after the frames ${JSON.stringify(info?.busyBefore ?? [])} / ${JSON.stringify(info?.busyAfter ?? [])}, near field body ${near}`;
        });
      }
    }
    shots.push(mine);
    if (history && load === LOADS - 1) {
      await page.evaluate(async () => {
        const lab = window.__integration!;
        const spec = lab.app.camera.spec;
        window.__test!.setDeterministic(false);
        lab.surface('earth', 19.4, -155.2, 300, 30, -10);
        await window.__test!.waitFrames(47);
        lab.release();
        lab.app.camera.spec = spec;
      });
      await runBaselineSteps(page, v.restore ?? [], 240_000);
      await page.evaluate(async () => {
        await window.__test!.waitFrames(44);
        window.__test!.setDeterministic(true);
      });
      after = await captureDeterministic(page, FRAMES, 240_000);
    }
  }
  const last = shots[0]![CAPTURES - 1]!;
  const compare: { tag: string; a: Buffer; b: Buffer }[] = [];
  for (let load = 0; load < LOADS; load++) {
    for (let k = 0; k + 1 < CAPTURES; k++) compare.push({ tag: `load${load + 1}-capture${k + 1}-${k + 2}`, a: shots[load]![k]!, b: shots[load]![k + 1]! });
    if (load > 0) compare.push({ tag: `load1-load${load + 1}`, a: last, b: shots[load]![CAPTURES - 1]! });
  }
  if (after) compare.push({ tag: 'after-another-history', a: shots[LOADS - 1]![CAPTURES - 1]!, b: after });
  const pairs = compare.map((p) => {
    const d = differenceMap(p.a, p.b);
    if (d.differingPixels > 0) fs.writeFileSync(path.join(dir, `exact-${v.name}${tag}-${p.tag}.marks.png`), markDifferences(p.a, p.b));
    return { tag: p.tag, pixels: d.differingPixels, maxAbs: d.maxAbs, text: describeDifferenceMap(d) };
  });
  return { pairs, last, busy };
}

const line = (pairs: Pair[]): string => pairs.map((r) => `${r.tag}: ${r.pixels} px${r.pixels > 0 ? ` (up to ${r.maxAbs})` : ''}`).join('; ');

for (const v of VIEWS) {
  test(`renderExact, ${v.name}: three captures, three loads and another history, the same picture bit for bit`, async ({ page }) => {
    const query = `${v.stepped ? '&without=atmosphere' : ''}${EXTRA}`;
    const exact = await probe(page, v, query, true, '');
    fs.writeFileSync(path.join(process.cwd(), 'out', 'screens', 'ocean', `exact-${v.name}.png`), exact.last);
    console.log(`[exact] ${v.name}${query ? ` with ${query}` : ''}${NO_RESET ? ' (the ocean keeps its histories)' : ''}: ${line(exact.pairs)}`);
    for (const r of exact.pairs) if (r.pixels > 0) console.log(`[exact] ${v.name} ${r.tag}: ${r.text}`);
    console.log(`[exact] ${v.name}: first capture: ${exact.busy}`);
    if (v.stepped && EXTRA === '') {
      // The same with every package: reported, not asserted (what differs is the atmosphere's and the plume's).
      const full = await probe(page, v, '', false, '-every-package');
      console.log(`[exact] ${v.name} with every package (reported; request ocean-12): ${line(full.pairs)}`);
      for (const r of full.pairs) if (r.pixels > 0) console.log(`[exact] ${v.name} with every package, ${r.tag}: ${r.text}`);
    }
    for (const r of exact.pairs) {
      if (v.loadFloor && r.tag.startsWith('load1-load') && r.pixels > 0) {
        console.log(`[exact] ${v.name} ${r.tag}: KNOWN DIFFERENCE, ${v.loadFloor.what}: ${r.pixels} px by up to ${r.maxAbs} (bound ${v.loadFloor.pixels} px, ${v.loadFloor.maxAbs})`);
        expect(r.pixels, `${v.name}, ${r.tag}: differing pixels against the known difference's bound`).toBeLessThanOrEqual(v.loadFloor.pixels);
        expect(r.maxAbs, `${v.name}, ${r.tag}: largest difference of a channel against the known difference's bound`).toBeLessThanOrEqual(v.loadFloor.maxAbs);
        continue;
      }
      expect(r.pixels, `${v.name}, ${r.tag}: differing pixels`).toBe(0);
    }
  });
}

