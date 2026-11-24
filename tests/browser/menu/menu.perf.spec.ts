/**
 * What the menu costs (shell-menu), under the GPU lock: the menu DOM's main-thread time per frame (CDP task
 * time with the menu open minus the same scene with the menu hidden, the HUD's method), its text refresh rate,
 * and the transit's frame times (none at or above 33 ms). Numbers in out/screens/shell-menu/perf.json.
 *
 *   node tools/dev/heavy.mjs --class=gpu -- npx playwright test tests/browser/menu/menu.perf.spec.ts --project=perf
 */
import fs from 'node:fs';
import path from 'node:path';
import type { CDPSession, Page } from '@playwright/test';
import { expect, expectNoErrors, test, withGpuLock } from '../harness';
import { hooks, openLab, press, waitMain } from './menuPage';

test.setTimeout(30 * 60_000);

const MENU_BUDGET_MS = 0.5;
const TEXT_HZ_MAX = 10;
const FRAME_LIMIT_MS = 33;

async function taskSeconds(cdp: CDPSession): Promise<number> {
  const r = await cdp.send('Performance.getMetrics');
  const m = Object.fromEntries(r.metrics.map((x) => [x.name, x.value]));
  return (m['TaskDuration'] ?? 0) - (m['DevToolsCommandDuration'] ?? 0);
}

async function window_(page: Page, cdp: CDPSession, hidden: boolean, frames: number): Promise<{ msPerFrame: number; refreshHz: number }> {
  await page.evaluate((h) => window.__shell!.setMenuHidden(h), hidden);
  await page.evaluate(() => window.__test!.waitFrames(30));
  const t0 = await page.evaluate(() => ({ t: performance.now(), r: window.__shell!.hooks().textRefreshes }));
  const a = await taskSeconds(cdp);
  await page.evaluate((n) => window.__test!.waitFrames(n), frames);
  const b = await taskSeconds(cdp);
  const t1 = await page.evaluate(() => ({ t: performance.now(), r: window.__shell!.hooks().textRefreshes }));
  return { msPerFrame: ((b - a) * 1000) / frames, refreshHz: ((t1.r - t0.r) * 1000) / (t1.t - t0.t) };
}

const median = (xs: number[]): number => {
  const s = xs.slice().sort((p, q) => p - q);
  return s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2;
};

test('the menu DOM costs at most 0.5 ms of main thread a frame, refreshes text at most at 10 Hz, and no transit frame reaches 33 ms', async ({ page, pageLog }) => {
  const out: Record<string, unknown> = {};
  await withGpuLock(async () => {
    await openLab(page, '&queue=busy');
    await press(page, 'Enter', 'hub/play', 'launch');
    const cdp = await page.context().newCDPSession(page);
    try {
      await cdp.send('Performance.enable', { timeDomain: 'threadTicks' });
    } catch {
      await cdp.send('Performance.enable');
    }
    await page.evaluate(() => window.__test!.waitFrames(120));
    for (const screen of ['hub-play', 'deploy-pad']) {
      if (screen === 'deploy-pad') {
        await press(page, 'Enter', 'deploy/vehicle');
        await press(page, 'Enter', 'deploy/pad');
        await page.evaluate(() => window.__test!.waitFrames(60));
      }
      const open: number[] = [];
      const hidden: number[] = [];
      const hz: number[] = [];
      for (let round = 0; round < 5; round++) {
        for (const h of round % 2 === 0 ? [false, true] : [true, false]) {
          const w = await window_(page, cdp, h, 240);
          (h ? hidden : open).push(w.msPerFrame);
          if (!h) hz.push(w.refreshHz);
        }
      }
      await page.evaluate(() => window.__shell!.setMenuHidden(false));
      const cost = median(open) - median(hidden);
      out[screen] = { menuMsPerFrame: cost, openMs: open, hiddenMs: hidden, textRefreshHz: hz };
      console.log(`[menu perf] ${screen}: menu ${cost.toFixed(3)} ms/frame (open ${median(open).toFixed(3)}, hidden ${median(hidden).toFixed(3)}), text ${Math.max(...hz).toFixed(1)} Hz`);
      expect(cost).toBeLessThanOrEqual(MENU_BUDGET_MS);
      expect(Math.max(...hz)).toBeLessThanOrEqual(TEXT_HZ_MAX + 0.5);
    }
    await cdp.detach();
    await press(page, 'Enter', 'deploy/briefing');
    await press(page, 'Enter', 'transit');
    await waitMain(page, 'flight');
    const tr = (await page.evaluate(() => window.__shell!.lastTransit()))!;
    const sorted = tr.frameMs.slice().sort((p, q) => p - q);
    const worst = sorted[sorted.length - 1] ?? 0;
    out['transit'] = { frames: tr.frameMs.length, p50: sorted[Math.floor(sorted.length * 0.5)], p99: sorted[Math.floor(sorted.length * 0.99)], worst, over33: tr.frameMs.filter((f) => f >= FRAME_LIMIT_MS).length };
    console.log(`[menu perf] transit: ${JSON.stringify(out['transit'])}`);
    expect(worst).toBeLessThan(FRAME_LIMIT_MS);
    expect((await hooks(page)).scrimRects).toBe(0);
  });
  const dir = path.join(process.cwd(), 'out', 'screens', 'shell-menu');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'perf.json'), JSON.stringify(out, null, 1));
  await expectNoErrors(page, pageLog);
});
