import { expect, expectNoErrors, test } from '../harness';
import { openLab, settle, shot, terrainStats } from './util';
import { applyView, VIEWS, viewUrl } from './views';

test.use({ viewport: { width: 1920, height: 1080 } });

/**
 * The reviewed screenshots of the brief (out/screens/terrain/<view>.png). One page per body; every view
 * waits until the terrain has streamed in and settled. TERRAIN_VIEWS=name1,name2 limits the run;
 * TERRAIN_QUERY="p.earth.nightClusterM=0&rocks=0" adds lab query parameters (A/B of a tunable), and
 * TERRAIN_SUFFIX=<name> saves such a run as <view>-<name>.png beside the reviewed pictures.
 */
const only = process.env.TERRAIN_VIEWS?.split(',').filter(Boolean);
const wanted = VIEWS.filter((v) => !only || only.some((o) => v.name === o || (o.endsWith('*') && v.name.startsWith(o.slice(0, -1)))));

for (const body of ['earth', 'moon'] as const) {
  const views = wanted.filter((v) => v.body === body);
  if (views.length === 0) continue;
  test(`reviewed views: ${body}`, async ({ page, pageLog }) => {
    test.setTimeout(20 * 60_000);
    await openLab(page, { ...Object.fromEntries(new URLSearchParams(viewUrl(views[0]!).split('?')[1])), hud: 0, ...Object.fromEntries(new URLSearchParams(process.env.TERRAIN_QUERY ?? '')) });
    for (const v of views) {
      await applyView(page, v);
      await settle(page, 12);
      const s = await shot(page, v.name + (process.env.TERRAIN_SUFFIX ? `-${process.env.TERRAIN_SUFFIX}` : ''));
      const st = await terrainStats(page);
      const b = st.bodies[body]!;
      console.log(`${v.name}: ${b.visible}/${b.selected} tiles, deepest level ${b.deepestLevel}, water ${b.waterTiles}, rocks ${st.rocks.instances}, ready ${st.stream.ready}, evicted ${st.stream.evictedTotal}, mean luma ${s.stats.meanLuma.toFixed(1)}`);
      expect(s.stats.width).toBe(1920);
      expect(b.visible).toBeGreaterThan(0);
      expect(st.stream.nightDropped, 'tiles that lost their night lights to a full pool').toBe(0);
    }
    await expectNoErrors(page, pageLog);
  });
}
