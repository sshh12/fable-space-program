/**
 * The menu read over the scene (shell-menu): the contrast of every text box of every screen over what is behind
 * it, by day and at a night pad; the transit's camera on its own path every frame; and the night pad's exposure
 * at the hand-over within 1 EV of where the meter settles. The contrast tables are written to
 * out/screens/shell-menu/contrast-<scene>.json; the pictures with the text taken out (what the text is read
 * against) are saved beside them and looked at.
 *
 *   node tools/dev/heavy.mjs --class=gpu -- npx playwright test tests/browser/menu/legibility.spec.ts --project=functional
 */
import fs from 'node:fs';
import path from 'node:path';
import { expect, expectNoErrors, test } from '../harness';
import { openLab, press, settle, shot, textContrast, waitMain, waitState, type ContrastResult } from './menuPage';

test.setTimeout(20 * 60_000);

const MIN_CONTRAST = 4.5;
const outDir = path.join(process.cwd(), 'out', 'screens', 'shell-menu');

interface ScreenContrast {
  screen: string;
  texts: ContrastResult[];
}

function report(scene: string, screens: ScreenContrast[]): { screen: string; text: string; p2: number }[] {
  fs.mkdirSync(outDir, { recursive: true });
  const rows = screens.map((s) => {
    const texts = s.texts.sort((a, b) => a.p2 - b.p2);
    const active = texts.filter((t) => !t.disabled);
    return { screen: s.screen, worst: active[0]?.p2 ?? Infinity, worstText: active[0] ?? null, disabledTexts: texts.length - active.length, texts };
  });
  fs.writeFileSync(path.join(outDir, `contrast-${scene}.json`), JSON.stringify(rows, null, 1));
  for (const r of rows) console.log(`[contrast ${scene}] ${r.screen}: worst ${r.worst.toFixed(2)}:1 over ${r.texts.length - r.disabledTexts} texts${r.worstText ? ` ("${r.worstText.text}" ${r.worstText.px}px, worst pixel ${r.worstText.min.toFixed(2)}:1)` : ''}; ${r.disabledTexts} of disabled controls not held to it`);
  return screens.flatMap((s) => s.texts.filter((t) => t.p2 < MIN_CONTRAST && !t.disabled).map((t) => ({ screen: s.screen, text: t.text, p2: Math.round(t.p2 * 100) / 100 })));
}

async function measure(page: Parameters<typeof textContrast>[0], screens: ScreenContrast[], screen: string, scene: string): Promise<void> {
  await settle(page, 30);
  screens.push({ screen, texts: await textContrast(page, { save: `backdrop-${scene}-${screen}` }) });
}

test('every text of every screen is at least 4.5:1 over its backdrop, and the transit stays on its path (day at the pad)', async ({ page, pageLog }) => {
  const screens: ScreenContrast[] = [];
  await openLab(page, '&queue=busy');
  await measure(page, screens, 'title', 'day');
  await press(page, 'Enter', 'hub/play', 'launch');
  await measure(page, screens, 'hub-play', 'day');
  for (const tab of ['hangar', 'ships', 'universe', 'settings', 'credits']) {
    await press(page, 'KeyE', `hub/${tab}`);
    await measure(page, screens, `hub-${tab}`, 'day');
  }
  await press(page, 'KeyE', 'hub/play');
  await press(page, 'Enter', 'deploy/vehicle', 'vehicle-*');
  await measure(page, screens, 'deploy-vehicle', 'day');
  await press(page, 'Enter', 'deploy/pad', 'pad-*');
  await measure(page, screens, 'deploy-pad', 'day');
  await press(page, 'Enter', 'deploy/briefing', 'launch-commit');
  await measure(page, screens, 'deploy-briefing', 'day');
  await press(page, 'Enter', 'transit');
  await waitMain(page, 'flight');
  // The camera stood on the transit's path in every frame: no step longer than the path between its two points.
  const tr = (await page.evaluate(() => window.__shell!.lastTransit()))!;
  expect(tr.steps.length).toBeGreaterThan(100);
  const off = tr.steps.map((s, i) => ({ i, s, b: tr.bounds[i]! })).filter((x) => x.s > x.b + 0.01);
  console.log(`[transit day] ${tr.steps.length} frames, largest step ${Math.max(...tr.steps).toFixed(0)} m, off the path: ${off.length}`);
  expect(off).toEqual([]);
  await press(page, 'Escape', 'flightMenu', 'fm-resume');
  await measure(page, screens, 'flight-menu', 'day');
  const low = report('day', screens);
  console.log(`[contrast day] below ${MIN_CONTRAST}:1: ${JSON.stringify(low)}`);
  expect(low).toEqual([]);
  await expectNoErrors(page, pageLog);
});

test('at a night pad: the exposure at the hand-over is within 1 EV of settled, and every text is legible over the dark scene', async ({ page, pageLog }) => {
  const screens: ScreenContrast[] = [];
  await openLab(page, '&queue=free&padhour=1');
  await press(page, 'Enter', 'hub/play', 'launch');
  await press(page, 'Enter', 'deploy/vehicle', 'vehicle-*');
  await press(page, 'Enter', 'deploy/pad', 'pad-*');
  await measure(page, screens, 'deploy-pad', 'night');
  await press(page, 'Enter', 'deploy/briefing', 'launch-commit');
  await press(page, 'Enter', 'transit');
  await waitMain(page, 'flight');
  const at = (await page.evaluate(() => window.__shell!.lastTransit()))!;
  expect(at.handOverEv).not.toBeNull();
  await shot(page, 'flight-night-handover-1280');
  // The meter settles (the flight camera holds still on the pad); compare with the hand-over's exposure.
  await page.waitForFunction(() => (window.__shell!.lastTransit()?.secondsSince ?? 0) > 10, undefined, { timeout: 60_000 });
  const settled = (await page.evaluate(() => window.__shell!.lastTransit()))!;
  const ex = await page.evaluate(() => window.__shell!.exposure());
  console.log(`[night hand-over] EV100 at hand-over ${at.handOverEv!.toFixed(2)}, settled ${settled.evNow.toFixed(2)} (meter target ${ex.targetEv100.toFixed(2)}), difference ${(settled.evNow - at.handOverEv!).toFixed(2)} EV`);
  expect(Math.abs(settled.evNow - at.handOverEv!)).toBeLessThanOrEqual(1);
  const off = at.steps.map((s, i) => ({ i, s, b: at.bounds[i]! })).filter((x) => x.s > x.b + 0.01);
  expect(off).toEqual([]);
  await shot(page, 'flight-night-settled-1280');
  await press(page, 'Escape', 'flightMenu', 'fm-resume');
  await measure(page, screens, 'flight-menu', 'night');
  await shot(page, 'flight-menu-night-1280');
  const low = report('night', screens);
  console.log(`[contrast night] below ${MIN_CONTRAST}:1: ${JSON.stringify(low)}`);
  expect(low).toEqual([]);
  await press(page, 'Escape', 'flight');
  await waitState(page, 'flight');
  await expectNoErrors(page, pageLog);
});
