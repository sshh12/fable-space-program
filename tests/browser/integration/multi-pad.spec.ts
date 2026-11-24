/**
 * A site with several pads, in a picture (review minor 18 of the presentation sweep). The library's sites have
 * one pad each, so the per-pad paths (the site feature's runtime, structures and state per pad; the terrain's
 * levelled disc and ground plan per pad) were held by unit tests on synthetic data only. The integration
 * lab's `&pads=<n>` gives the first site n pads in memory (labs/integration/syntheticPads.ts: copies of its
 * pad 1,100 m apart in a row to the north-west, no definition file changes).
 *
 * Asserted: the site feature has a runtime and a state for every pad and draws them all; the terrain holds a
 * ground plan for the first four (MAX_SITES: the known limit, request presentation-sweep-6) and none for the
 * fifth. Pictures (looked at): out/screens/presentation-sweep/multi-pad-*.png.
 *
 *   node tools/dev/heavy.mjs --class=gpu -- npx playwright test tests/browser/integration/multi-pad.spec.ts --project=functional
 */
import { assertDiscreteGpu, expect, expectNoErrors, openPage, saveScreenshot, test, waitIdle } from '../harness';

test.setTimeout(15 * 60_000);
test.use({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });

const PADS = 5;
/** The first pad of the library's site (the pad-noon checkpoint's place) and the row of the synthetic ones. */
const FIRST = { lat: 18.987556, lon: -155.603239 };
const SPACING = 1100;
const BEARING = (320 * Math.PI) / 180;
const EARTH_RADIUS = 6_371_000;
const padPlace = (k: number): { lat: number; lon: number } => ({
  lat: FIRST.lat + ((SPACING * k * Math.cos(BEARING)) / EARTH_RADIUS) * (180 / Math.PI),
  lon: FIRST.lon + ((SPACING * k * Math.sin(BEARING)) / (EARTH_RADIUS * Math.cos((FIRST.lat * Math.PI) / 180))) * (180 / Math.PI),
});

interface SiteHandle {
  stats: { sites: number; pads: number; triangles: number };
  padIds(siteId: string): string[];
  state(siteId: string, padId?: string): unknown;
}
interface TerrainHandle {
  debug: { groundPlans(bodyId: string): number };
}
interface LabPage {
  __integration: { syntheticPads: { siteId: string; bodyId: string; padIds: string[] } | null; handles: Record<string, unknown> };
}

const page_ = (yaw: number, pitch: number, distance: number, at: { lat: number; lon: number }, pads: number | null): string =>
  `/labs/integration/?scene=pad${pads === null ? '' : `&pads=${pads}`}&sun=180,65&sunsite=earth,${FIRST.lat},${FIRST.lon}&orbit=${yaw},${pitch},${distance}&target=site:earth,${at.lat},${at.lon},120&ev=14&hud=0&governor=off`;

test('a site of five pads: a runtime, structures and a levelled disc per pad, a ground plan for the first four', async ({ page, pageLog }) => {
  const read = (): Promise<{ synthetic: LabPage['__integration']['syntheticPads']; padIds: string[]; states: boolean[]; drawn: { sites: number; pads: number; triangles: number }; plans: number }> =>
    page.evaluate(() => {
      const lab = (window as unknown as LabPage).__integration;
      const site = lab.handles['vehicle.createSiteFeature'] as SiteHandle;
      const terrain = lab.handles['terrain.createTerrainFeature'] as TerrainHandle;
      const s = lab.syntheticPads;
      const siteId = s?.siteId ?? 'ka-lae';
      const padIds = site.padIds(siteId);
      return { synthetic: s, padIds, states: padIds.map((id) => site.state(siteId, id) !== undefined), drawn: { ...site.stats }, plans: terrain.debug.groundPlans(s?.bodyId ?? 'earth') };
    });

  // The whole row from the south-east, 6 km out: every pad in the frame.
  const middle = padPlace((PADS - 1) / 2);
  await openPage(page, page_(140, 28, 6000, middle, PADS), { timeoutMs: 240_000 });
  await assertDiscreteGpu(page);
  await waitIdle(page, 60, 300_000);
  const row = await read();
  await saveScreenshot(page, 'presentation-sweep', 'multi-pad-row');
  console.log(`five pads: site ${row.synthetic?.siteId} has pads ${row.padIds.join(', ')}; drawn ${row.drawn.pads} pads of ${row.drawn.sites} site(s), ${row.drawn.triangles} triangles; ${row.plans} ground plans on ${row.synthetic?.bodyId}`);
  expect(row.synthetic?.padIds.length).toBe(PADS);
  expect(row.padIds).toEqual(row.synthetic!.padIds);
  expect(row.states, 'every pad has its own state').toEqual(new Array(PADS).fill(true));
  expect(row.drawn.pads, 'pads drawn with the whole row in the frame').toBe(PADS);
  // The terrain's material holds four plans (MAX_SITES): the fifth pad stands on bare ground (request presentation-sweep-6).
  expect(row.plans).toBe(4);
  await expectNoErrors(page, pageLog);

  // The third pad from 900 m (a copy: its own azimuth, its own levelled disc and ground plan), and the fifth (no plan).
  for (const k of [2, 4]) {
    await openPage(page, page_(120, 24, 900, padPlace(k), PADS), { timeoutMs: 240_000 });
    await waitIdle(page, 60, 300_000);
    await saveScreenshot(page, 'presentation-sweep', `multi-pad-pad-${k + 1}`);
    await expectNoErrors(page, pageLog);
  }

  // The library as it is: one pad, one plan, and the same structures once.
  await openPage(page, page_(140, 28, 6000, middle, null), { timeoutMs: 240_000 });
  await waitIdle(page, 60, 300_000);
  const one = await read();
  await saveScreenshot(page, 'presentation-sweep', 'multi-pad-row-one-pad');
  console.log(`one pad: pads ${one.padIds.join(', ')}; drawn ${one.drawn.pads} pad(s), ${one.drawn.triangles} triangles; ${one.plans} ground plan(s)`);
  expect(one.synthetic).toBeNull();
  expect(one.padIds.length).toBe(1);
  expect(one.plans).toBe(1);
  expect(row.drawn.triangles, 'five pads draw several times the structures of one').toBeGreaterThan(2 * one.drawn.triangles);
  await expectNoErrors(page, pageLog);
});
