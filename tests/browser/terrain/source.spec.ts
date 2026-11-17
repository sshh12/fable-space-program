/**
 * The tile-source seam (ARCHITECTURE 10.2, 10.4; presentation-sweep acceptance): the terrain lab streams
 * through a `TileSourceSpec` of kind `fetch` (the plain files under /tiles, the default of every page) and of
 * kind `pack` (content-addressed packs, read by ranges from the local stack's mirrors), and both draw the
 * same frames to the bit. Each view is captured frame-exactly (a lead-in capture and two that must be one
 * picture), once per source on a fresh page; the pack page must not have asked for one plain tile file, and
 * the plain-file page for no pack.
 *
 * Runs INSIDE the local stack, which serves the pack list and the packs of data/packs:
 *
 *   STACK_NAME=fsp-presentation-sweep npm run stack -- -- node tools/dev/heavy.mjs --class=gpu -- npx playwright test tests/browser/terrain/source.spec.ts --project=functional
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import type { StackState } from '../../../deploy/local/launcher';
import { assertDiscreteGpu, captureReference, expect, expectNoErrors, imageDifference, openPage, pngStats, test } from '../harness';
import { terrainStats, type Query } from './util';
import { applyView, VIEWS, viewUrl, type View } from './views';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const STATE = process.env.STACK_STATE;
test.skip(!STATE, 'runs inside the local stack: npm run stack -- -- ... playwright test tests/browser/terrain/source.spec.ts');
test.use({ viewport: { width: 1280, height: 720 } });

const state = (): StackState => JSON.parse(fs.readFileSync(STATE!, 'utf8')) as StackState;
const outDir = path.join(repoRoot, 'out', 'screens', 'presentation-sweep');

/**
 * Views that between them read every layer through the source: heights and albedo at every level down to
 * the ground, the water mask and the land cover (the cover's own reads on the main thread), the night
 * lights, the low-resolution colour map (the rocks), on both bodies with tiles down to the surface.
 */
const SETS: Record<'earth' | 'moon', string[]> = {
  earth: ['earth-leo-hawaii', 'earth-leo-nadir-night', 'earth-10km', 'pad-30m'],
  moon: ['moon-terminator-5000km', 'moon-2km', 'moon-standing'],
};

interface Requests {
  /** Plain tile files asked of the page's server (`/tiles/<set>/...`; the list of baked sets is not a tile file). */
  plain: string[];
  /** Requests to the stack's bucket stand-in and mirror (packs and their indexes). */
  packs: number;
  packList: number;
}

function watchRequests(page: Page): Requests {
  const s = state();
  const packOrigins = new Set([new URL(s.urls.bucket).origin, new URL(s.urls.shell).origin]);
  const list = new URL(s.urls.packList);
  const seen: Requests = { plain: [], packs: 0, packList: 0 };
  page.on('request', (r) => {
    const u = new URL(r.url());
    if (u.origin === list.origin && u.pathname === list.pathname) seen.packList++;
    else if (/^\/tiles\/[^/]+\//.test(u.pathname)) seen.plain.push(u.pathname);
    else if (packOrigins.has(u.origin) && /\/p\//.test(u.pathname)) seen.packs++;
  });
  return seen;
}

async function captureViews(page: Page, views: View[], source: 'fetch' | 'pack'): Promise<{ images: Map<string, Buffer>; ready: number }> {
  const extra: Query = source === 'pack' ? { source: 'pack', packs: state().urls.packList } : {};
  await openPage(page, viewUrl(views[0]!, { hud: 0, governor: 'off', deterministic: 1, ...extra }), { timeoutMs: 180_000 });
  await assertDiscreteGpu(page);
  const images = new Map<string, Buffer>();
  let ready = 0;
  for (const v of views) {
    await applyView(page, v);
    const taken = await captureReference(page, 64, `${v.name} through the ${source} source`, 300_000);
    images.set(v.name, taken.image);
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, `source-${source}-${v.name}.png`), taken.image);
    const st = await terrainStats(page);
    ready = st.stream.ready;
    expect(st.stream.incompleteBakes, `${v.name} (${source}): tiles baked on incomplete data`).toBe(0);
    expect(st.stream.droppedTotal, `${v.name} (${source}): tiles given up`).toBe(0);
  }
  return { images, ready };
}

for (const body of ['earth', 'moon'] as const) {
  test(`${body}: the same frames through a fetch spec and a pack spec`, async ({ browser, pageLog, page }) => {
    test.setTimeout(30 * 60_000);
    const views = SETS[body].map((name) => {
      const v = VIEWS.find((x) => x.name === name);
      if (!v) throw new Error(`no terrain view "${name}"`);
      return v;
    });

    const fetchRequests = watchRequests(page);
    const viaFetch = await captureViews(page, views, 'fetch');
    await expectNoErrors(page, pageLog);
    expect(fetchRequests.plain.length, 'plain tile files read through the fetch spec').toBeGreaterThan(100);
    expect(fetchRequests.packs, 'pack requests of the page on the fetch spec').toBe(0);
    expect(fetchRequests.packList).toBe(0);

    // A page of its own for the packs: nothing of the first page's memory or streaming state is left.
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const packPage = await context.newPage();
    const errors: string[] = [];
    packPage.on('pageerror', (e) => errors.push(e.message));
    packPage.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });
    const packRequests = watchRequests(packPage);
    const viaPack = await captureViews(packPage, views, 'pack');
    expect(errors, 'errors of the page on the pack spec').toEqual([]);
    expect(packRequests.plain, 'plain tile files asked for by the page on the pack spec').toEqual([]);
    expect(packRequests.packs, 'pack requests').toBeGreaterThan(0);
    expect(packRequests.packList, 'reads of the pack list').toBeGreaterThan(0);
    await context.close();

    for (const v of views) {
      const a = viaFetch.images.get(v.name)!;
      const b = viaPack.images.get(v.name)!;
      const stats = pngStats(a);
      const d = imageDifference(a, b);
      console.log(
        `${v.name}: fetch against pack ${(d.differingFraction * 100).toFixed(4)} % of pixels differ, max ${d.maxAbs} (mean luma ${stats.meanLuma.toFixed(1)}, ${(stats.fractionNonBlack * 100).toFixed(0)} % not black)`,
      );
      if (d.maxAbs > 0) fs.writeFileSync(path.join(outDir, `source-diff-${v.name}.png`), d.diff);
      expect(stats.fractionNonBlack, `${v.name}: a real picture`).toBeGreaterThan(0.05);
      expect(d.maxAbs, `${v.name}: the frame through the pack source against the frame through the fetch source`).toBe(0);
    }
    console.log(
      `${body}: ${fetchRequests.plain.length} plain tile files through fetch; ${packRequests.packs} pack requests and ${packRequests.packList} pack-list reads through pack; tiles resident at the last view ${viaFetch.ready} / ${viaPack.ready}`,
    );
  });
}
