/**
 * Where the interior's GPU time goes (visual round 5, item 1): the perf spec's view (scene=leo from the seat,
 * 2560 x 1440, about 7 ms of ballast) timed with single terms of the interior's shading switched off, single
 * draws left out and assembly families removed (CockpitFeature.setAblation; the masks are ABLATE in
 * src/render/cockpit/feature.ts). A measuring tool: it asserts only that the timings exist; the budget lines
 * are cockpit.perf.spec.ts's. The table goes to the console and to out/screens/cockpit/attribution.json.
 *
 *   node tools/dev/heavy.mjs --class=gpu -- npx playwright test tests/browser/cockpit/attribution.perf.spec.ts --project=perf
 *   (ATTRIBUTION_SCENE=leo or night for one of the two: the sunlit cabin, the cabin under its lamps alone)
 */
import fs from 'node:fs';
import path from 'node:path';
import { assertDiscreteGpu, expect, expectNoErrors, openPage, test, waitIdle, withGpuLock } from '../harness';

test.use({ viewport: { width: 2560, height: 1440 } });

const A = { polygonSources: 1, sun: 2, reflections: 4, detailTextures: 8, patterns: 16, bounce: 32, shading: 64, lampShadows: 128, shadeDraw: 256, decals: 512, screens: 1024, frustumCulling: 2048 };

const CONFIGS: [name: string, mask: number, without: string[]][] = [
  ['baseline', 0, []],
  ['every chunk drawn (no frustum culling)', A.frustumCulling, []],
  ['depth pre-pass only', A.shadeDraw, []],
  ['depth pre-pass only, every chunk', A.shadeDraw | A.frustumCulling, []],
  ['constant fragment', A.shading, []],
  ['constant fragment, no decals, no screens', A.shading | A.decals | A.screens, []],
  ['without polygon sources', A.polygonSources, []],
  ['without the sun', A.sun, []],
  ['without reflections', A.reflections, []],
  ['without detail textures', A.detailTextures, []],
  ['without procedural patterns', A.patterns, []],
  ['without bounce light', A.bounce, []],
  ['without lamp shadows', A.lampShadows, []],
  ['without sources, sun, reflections', A.polygonSources | A.sun | A.reflections, []],
  ['without textures and patterns', A.detailTextures | A.patterns, []],
  ['without label decals', A.decals, []],
  ['without screens and ball', A.screens, []],
  ['without the blankets and frames (skin)', 0, ['skin']],
  ['without the console', 0, ['console']],
  ['without the pressure shell', 0, ['shell']],
  ['without windows, hatches, mounts, fixtures', 0, ['windows', 'hatch', 'dockingHatch', 'mount', 'checklist', 'panel', 'locker', 'bag', 'cable', 'flood', 'duct', 'handhold', 'extinguisher', 'fdfPouch', 'floorRails']],
  ['without couches and harness', 0, ['couch', 'harness', 'couchPallet']],
  ['baseline again', 0, []],
];

for (const scene of (process.env.ATTRIBUTION_SCENE ?? 'leo,night').split(',')) {
  test(`interior cost by term, draw and assembly (${scene})`, async ({ page, pageLog }) => {
  test.setTimeout(30 * 60_000);
  await withGpuLock(async () => {
    await openPage(page, `/labs/cockpit/?scene=${scene}&perf=features&scale=1&governor=off&ballast=0`, { timeoutMs: 180_000 });
    await assertDiscreteGpu(page);
    await waitIdle(page, 60, 300_000);
    const perIteration = await page.evaluate(async () => {
      window.__cockpit!.setBallast(400);
      await window.__test!.waitFrames(90);
      window.__test!.resetPerf();
      await window.__test!.waitFrames(60);
      return (window.__lab!.renderer.passStats()['cockpit-lab-ballast.burn']?.p50 ?? 0) / 400;
    });
    expect(perIteration).toBeGreaterThan(0);
    await page.evaluate((n) => window.__cockpit!.setBallast(n), Math.round(7 / perIteration));
    const rows: { name: string; drawn: number; gbuffer: { p50: number; p99: number; mean: number }; probe: number; sunMap: number; shadow: number }[] = [];
    for (const [name, mask, without] of CONFIGS) {
      const r = await page.evaluate(
        async ([m, w]) => {
          window.__cockpit!.setAblation(m as number, w as string[]);
          await window.__test!.waitFrames(40);
          window.__test!.resetPerf();
          await window.__test!.waitFrames(200);
          const s = window.__lab!.renderer.passStats();
          const g = (k: string): { p50: number; p99: number; mean: number } => s[k] ?? { p50: 0, p99: 0, mean: 0 };
          return { drawn: window.__cockpit!.stats().drawnTriangles, gbuffer: g('cockpit.gbuffer'), probe: g('cockpit.probe').p50 + g('cockpit.probeFilter').p50, sunMap: g('cockpit.sunMap').p50, shadow: g('cockpit.shadow').p50 };
        },
        [mask, without] as const,
      );
      rows.push({ name, ...r });
      console.log(`${name.padEnd(46)} ${String(Math.round(r.drawn)).padStart(7)} tris  gbuffer p50 ${r.gbuffer.p50.toFixed(4)} p99 ${r.gbuffer.p99.toFixed(4)} mean ${r.gbuffer.mean.toFixed(4)}  probe ${r.probe.toFixed(4)} sunMap ${r.sunMap.toFixed(4)} shadow ${r.shadow.toFixed(4)}`);
    }
    await page.evaluate(() => window.__cockpit!.setAblation(0, []));
    const out = path.resolve('out/screens/cockpit');
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, `attribution-${scene}.json`), JSON.stringify(rows, null, 1));
    expect(rows[0]!.gbuffer.p50).toBeGreaterThan(0);
    await expectNoErrors(page, pageLog);
  });
  });
}

// What a switched-off term looks like (out/screens/cockpit/attribution/): the cabin under its lamps with and
// without the lamps' shadow maps.
test.describe('pictures', () => {
  test.use({ viewport: { width: 1600, height: 900 } });
  const VIEWS: [name: string, query: string][] = [
    ['night-seat', 'scene=night'],
    ['night-look-back', 'scene=night&eye=0.2,-0.35,0.4&aim=hatchDoor&fov=80'],
    ['night-hatch', 'scene=night&at=0.36,0.8,-0.75&aim=hatchDoor&fov=75'],
    ['night-switches', 'scene=night&aim=switches&fov=26'],
    ['night-right', 'scene=night&look=75,5&fov=80'],
    ['night-left-up', 'scene=night&look=-60,20&fov=80'],
  ];
  for (const [name, query] of VIEWS) {
    for (const [tag, mask] of [['lamp-shadows', 0], ['baked-visibility', A.lampShadows]] as const) {
      test(`picture ${name} ${tag}`, async ({ page }) => {
        test.setTimeout(240_000);
        await openPage(page, `/labs/cockpit/?${query}&ablate=${mask}`, { timeoutMs: 120_000 });
        await waitIdle(page, 8);
        await page.evaluate(() => window.__test!.setDeterministic(true));
        await page.waitForFunction(
          async () => {
            await window.__test!.waitFrames(30);
            const e = window.__cockpit!.debug().exposure;
            return Math.abs(e.ev100 - e.targetEv100) < 0.05;
          },
          undefined,
          { timeout: 120_000, polling: 100 },
        );
        await page.evaluate(() => window.__test!.waitFrames(60));
        const dir = path.resolve('out/screens/cockpit/attribution');
        fs.mkdirSync(dir, { recursive: true });
        await page.screenshot({ path: path.join(dir, `${name}-${tag}.png`) });
        expect(await page.evaluate(() => window.__test!.errors)).toEqual([]);
      });
    }
  }
});

// Visual round 5, while the machine's one GPU slot is shared by seven agents (a turn every hour or two): the
// cockpit's functional suite (every reviewed picture) and its perf spec run in this run's slot, one after the
// other, as child runs against this run's server. Their output goes to out/screens/cockpit/attribution/.
test('the functional suite and the perf spec in this slot', async () => {
  test.setTimeout(120 * 60_000);
  const { spawnSync } = await import('node:child_process');
  const dir = path.resolve('out/screens/cockpit/attribution');
  fs.mkdirSync(dir, { recursive: true });
  const env: Record<string, string | undefined> = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(PW_|PLAYWRIGHT_|TEST_|E2E_RUN_ID)/.test(k)));
  // (Candidate framings of the round, shot by zz-probe.spec.ts when the list exists.)
  const probes = process.env.COCKPIT_ROUND_PROBES ?? path.join(process.env.TEMP ?? '', 'claude/27587f90db9339a2/ba338de1-7e7d-4ce7-bfa7-dd716f0b858a/scratchpad/cockpit-r5/probe1.json');
  if (fs.existsSync(probes)) {
    env.COCKPIT_PROBE = probes;
    env.COCKPIT_PROBE_OUT = path.join(dir, 'probe');
  }
  for (const [name, args] of [
    ['functional', 'tests/browser/cockpit --project=functional'],
    ['perf', 'tests/browser/cockpit/cockpit.perf.spec.ts --project=perf'],
  ] as const) {
    const r = spawnSync(`npx playwright test ${args}`, { shell: true, cwd: process.cwd(), encoding: 'utf8', maxBuffer: 1 << 28, env });
    fs.writeFileSync(path.join(dir, `batch-${name}.log`), `${r.stdout}\n${r.stderr}`);
    console.log(`child run ${name}: exit ${r.status}`);
    console.log((r.stdout ?? '').split('\n').slice(-60).join('\n'));
  }
});
