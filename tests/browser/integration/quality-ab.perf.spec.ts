/**
 * A/B of the Ultra preset against no profile, in ONE page (capability-settings): the budget table's LEO row
 * (the integration lab, 2560 x 1440, attribution mode, governor off, scale 1, the end ballast filling the
 * frame to about 9 ms), measured alternately without a profile and with the Ultra preset applied through
 * Renderer.setQuality, four rounds of six windows of 240 frames each; per round the median of the windows' p99
 * per package, the simulation paused (a page that flies drifts: the terrain under the orbit changes). A page
 * cannot go back to no profile, so the rounds run without, then with; the verdict compares the round just
 * before the switch with the one just after it, against the spread of the rounds without (measured
 * 2026-11-24 unpaused: two rounds of no change differed by 3.6 %, the core p99 by 0.13 ms).
 *
 *   node tools/dev/heavy.mjs --class=gpu -- npx playwright test tests/browser/integration/quality-ab.perf.spec.ts --project=perf
 */
import fs from 'node:fs';
import path from 'node:path';
import { expect, test, withGpuLock } from '../harness';
import { expectClean, openIntegration, repoRoot } from './helpers';

test.use({ viewport: { width: 2560, height: 1440 } });
test.setTimeout(30 * 60_000);

const WINDOWS = 6;
const FRAMES = 240;

test('the Ultra preset costs what no profile costs (LEO row, one page, alternating)', async ({ page, pageLog }) => {
  await withGpuLock(async () => {
    const info = await openIntegration(page, 'scene=lowOrbit&orbit=30,15,60&hud=0&perf=features&scale=1&governor=off&ballast=1&paused=1', { timeoutMs: 240_000 });
    await page.waitForFunction(() => window.__test!.isIdle(), undefined, { timeout: 180_000 });
    // The ballast to about 9 ms of frame, as the budget spec does.
    await page.evaluate(async () => {
      const lab = window.__integration!;
      const r = window.__lab!.renderer;
      let n = 64;
      for (let i = 0; i < 5; i++) {
        lab.setBallast(n);
        r.resetPerf();
        await window.__test!.waitFrames(60);
        const total = Object.entries(window.__perf!.features).reduce((a, [k, v]) => a + (k === 'lab-ballast' ? 0 : v.gpuMs), 0);
        const ms = r.passStats()['lab-ballast.overlay']?.p50 ?? 0;
        if (ms > 0) n = Math.max(1, Math.round((n * Math.max(1, 9 - total)) / ms));
      }
      lab.setBallast(n);
    });
    const measure = async (): Promise<Record<string, number>> => {
      const per: Record<string, number[]> = {};
      for (let w = 0; w < WINDOWS; w++) {
        const f = await page.evaluate(async (frames) => {
          window.__lab!.renderer.resetPerf();
          await window.__test!.waitFrames(frames);
          return window.__perf!.features;
        }, FRAMES);
        for (const [k, v] of Object.entries(f)) if (k !== 'lab-ballast') (per[k] ??= []).push(v.gpuMs);
      }
      const med = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
      return Object.fromEntries(Object.entries(per).map(([k, xs]) => [k, med(xs)]));
    };
    const ultra = (): Promise<void> => page.evaluate(() => window.__lab!.renderer.setQuality!({ pixelCap: 3.7, renderScaleMin: 0.6, targetFps: 60, levels: Object.fromEntries(window.__lab!.renderer.core.quality.settings().map((x) => [x.setting.id, 'ultra' as const])) }));
    const rounds: { kind: string; packages: Record<string, number>; sum: number }[] = [];
    // A page has no way back to "no profile": first the rounds without, then with, then the comparison of the sums.
    for (let i = 0; i < 2; i++) {
      const p = await measure();
      rounds.push({ kind: 'none', packages: p, sum: Object.values(p).reduce((a, b) => a + b, 0) });
    }
    await ultra();
    for (let i = 0; i < 2; i++) {
      const p = await measure();
      rounds.push({ kind: 'ultra', packages: p, sum: Object.values(p).reduce((a, b) => a + b, 0) });
    }
    for (const r of rounds) console.log(`[ab] ${r.kind.padEnd(5)} sum ${r.sum.toFixed(3)} core ${r.packages['core']?.toFixed(3)} ${JSON.stringify(Object.fromEntries(Object.entries(r.packages).map(([k, v]) => [k, Number(v.toFixed(3))])))}`);
    fs.mkdirSync(path.join(repoRoot, 'out', 'capability-settings'), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, 'out', 'capability-settings', 'quality-ab.json'), JSON.stringify(rounds, null, 2));
    const none = rounds.filter((r) => r.kind === 'none').map((r) => r.sum);
    const withUltra = rounds.filter((r) => r.kind === 'ultra').map((r) => r.sum);
    const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;
    console.log(`[ab] no profile ${mean(none).toFixed(3)} ms, Ultra ${mean(withUltra).toFixed(3)} ms (${((100 * (mean(withUltra) - mean(none))) / mean(none)).toFixed(1)} %)`);
    const spread = Math.abs(none[1]! - none[0]!);
    const step = withUltra[0]! - none[1]!;
    console.log(`[ab] across the switch ${step.toFixed(3)} ms; between the rounds without ${spread.toFixed(3)} ms`);
    expect(Math.abs(step)).toBeLessThanOrEqual(Math.max(0.03 * none[1]!, spread));
    await expectClean(page, pageLog, info);
  });
});
