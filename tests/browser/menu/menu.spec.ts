/**
 * The menu over the live scene (shell-menu): the deploy flow by keyboard only with a focus assertion per step,
 * Back from every screen, the credits, the visible launch queue, the holding drift of a slow acknowledgement,
 * the closed menu in flight (no DOM, no scrim), and the screens at four resolutions. Pictures in
 * out/screens/shell-menu/, each looked at.
 *
 *   node tools/dev/heavy.mjs --class=gpu -- npx playwright test tests/browser/menu --project=functional
 */
import type { Page } from '@playwright/test';
import { assertDiscreteGpu, expect, expectNoErrors, openPage, saveScreenshot, test } from '../harness';

test.setTimeout(15 * 60_000);

interface Hooks {
  state: string;
  main: string;
  side: string[];
  focus: string | null;
  scrimRects: number;
  spawn: string;
  practice: boolean;
}
declare global {
  interface Window {
    __shell?: { hooks(): Hooks; transit(): { u: number; holding: boolean; steps: number[]; acknowledged: boolean } | null; fixture: { setLink(s: string, r?: string | null): void } };
  }
}

const hooks = (page: Page): Promise<Hooks> => page.evaluate(() => window.__shell!.hooks());
const waitState = (page: Page, state: string, timeout = 120_000): Promise<unknown> => page.waitForFunction((s) => window.__shell?.hooks().state === s, state, { timeout });
const waitMain = (page: Page, main: string, timeout = 120_000): Promise<unknown> => page.waitForFunction((m) => window.__shell?.hooks().main === m, main, { timeout });
const settle = (page: Page): Promise<void> => page.evaluate(() => window.__test!.waitFrames(40));
const shot = async (page: Page, name: string): Promise<void> => {
  await settle(page);
  await saveScreenshot(page, 'shell-menu', name);
};
async function press(page: Page, key: string, state?: string, focus?: string): Promise<void> {
  await page.keyboard.press(key);
  if (state) await waitState(page, state);
  if (focus !== undefined) await page.waitForFunction((f) => window.__shell!.hooks().focus === f, focus, { timeout: 10_000 });
}
async function openLab(page: Page, query = ''): Promise<void> {
  await openPage(page, `/labs/shell/?governor=off${query}`, { timeoutMs: 600_000 });
  await assertDiscreteGpu(page);
  await waitState(page, 'title');
  await page.waitForFunction(() => document.querySelector('.sh-begin .sh-label')?.textContent === 'Press any key to begin', undefined, { timeout: 600_000 });
}

test('the deploy flow by keyboard only, with the focus at every step, to control on the pad and back', async ({ page, pageLog }) => {
  await openLab(page, '&queue=free');
  await shot(page, 'title-1280');
  await press(page, 'Enter', 'hub/play', 'launch');
  await shot(page, 'hub-play-1280');
  await press(page, 'Enter', 'deploy/vehicle', 'vehicle-meridian-lunar');
  await shot(page, 'deploy-vehicle-1280');
  await press(page, 'Enter', 'deploy/pad', 'pad-ka-lae-lc-1');
  await shot(page, 'deploy-pad-1280');
  await press(page, 'Enter', 'deploy/briefing', 'launch-commit');
  await shot(page, 'deploy-briefing-1280');
  await press(page, 'Enter', 'transit');
  expect((await hooks(page)).spawn === 'requesting' || (await hooks(page)).spawn === 'seated').toBe(true);
  await page.waitForFunction(() => (window.__shell!.transit()?.u ?? 0) > 0.35, undefined, { timeout: 60_000 });
  await saveScreenshot(page, 'shell-menu', 'transit-1280');
  await waitMain(page, 'flight');
  // A closed menu: nothing of the shell over the canvas, no scrim rectangle published.
  const closed = await page.evaluate(() => ({ hidden: (document.querySelector('.sh-root') as HTMLElement).hidden, scrim: window.__shell!.hooks().scrimRects }));
  expect(closed).toEqual({ hidden: true, scrim: 0 });
  await shot(page, 'flight-1280');
  await press(page, 'Escape', 'flightMenu', 'fm-resume');
  await expect(page.locator('[data-testid="leave-outcome"]')).toContainText('If you leave now');
  await shot(page, 'flight-menu-1280');
  await press(page, 'Escape', 'flight');
  await press(page, 'KeyP', 'flightMenu', 'fm-resume');
  for (const id of ['fm-settings', 'fm-controls', 'fm-rules', 'fm-leave']) await press(page, 'ArrowDown', undefined, id);
  await press(page, 'Enter', 'leaving');
  await waitState(page, 'hub/play');
  await expectNoErrors(page, pageLog);
});

test('Back from every screen, every hub tab, the credits and the rules', async ({ page, pageLog }) => {
  await openLab(page, '&queue=busy');
  await press(page, 'Space', 'hub/play', 'launch');
  for (const [tab, name] of [
    ['hangar', 'hub-hangar'],
    ['ships', 'hub-ships'],
    ['universe', 'hub-universe'],
    ['settings', 'hub-settings'],
    ['credits', 'hub-credits'],
  ] as const) {
    await press(page, 'KeyE', `hub/${tab}`);
    await shot(page, `${name}-1280`);
  }
  // Every source and licence line of the credits section is on the Credits screen.
  const credits = await page.evaluate(async () => (await (await fetch('/defs/visuals/credits.json')).json()) as { entries: { id: string; title: string; attribution: string; licence: string }[] });
  const text = await page.locator('[data-testid="credits"]').innerText();
  const flat = (s: string): string => s.replace(/\s+/g, ' ').toLowerCase();
  for (const e of credits.entries) {
    expect(flat(text), e.id).toContain(flat(e.title));
    expect(flat(text), e.id).toContain(flat(e.attribution));
    expect(flat(text), e.id).toContain(flat(e.licence));
  }
  await press(page, 'Escape', 'hub/play');
  await press(page, 'KeyQ', 'hub/credits');
  await press(page, 'Backspace', 'hub/play');
  // The deploy screens go back one at a time, and Back from the hub reaches the title.
  await press(page, 'Enter', 'deploy/vehicle');
  await press(page, 'Enter', 'deploy/pad');
  await press(page, 'Enter', 'deploy/briefing');
  await press(page, 'Escape', 'deploy/pad');
  await press(page, 'Escape', 'deploy/vehicle');
  await press(page, 'Escape', 'hub/play');
  await page.goBack();
  await waitState(page, 'title');
  await press(page, 'Enter', 'hub/play');
  await expectNoErrors(page, pageLog);
});

test('a full pad class shows the launch queue with the place and an honest wait, and the way out', async ({ page, pageLog }) => {
  await openLab(page, '&queue=full');
  await press(page, 'Enter', 'hub/play');
  await press(page, 'Enter', 'deploy/vehicle');
  await press(page, 'Enter', 'deploy/pad');
  await expect(page.locator('[data-testid="class-outlook"]')).toContainText('No launch slot is free inside the cohort horizon');
  await press(page, 'Enter', 'deploy/briefing');
  await press(page, 'Enter');
  await waitState(page, 'deploy/briefing');
  await expect(page.locator('[data-testid="launch-queue"]')).toContainText('in line');
  await expect(page.locator('[data-testid="launch-queue"]')).toContainText('can grow as well as shrink');
  expect((await hooks(page)).spawn).toBe('queued');
  await shot(page, 'launch-queue-1280');
  await page.evaluate(() => window.__shell!.fixture.setLink('reconnecting', 'The server is not answering.'));
  await expect(page.locator('[data-testid="launch-queue"]')).toContainText('this place may have moved');
  await shot(page, 'launch-queue-reconnecting-1280');
  await page.evaluate(() => window.__shell!.fixture.setLink('online'));
  await page.keyboard.press('KeyR');
  await expect(page.locator('[data-testid="spawn-refused"]')).toContainText('You left the launch queue');
  await shot(page, 'launch-queue-left-1280');
  await expectNoErrors(page, pageLog);
});

test('a slow acknowledgement holds the transit in its drift at the hold altitude, never a stall', async ({ page, pageLog }) => {
  await openLab(page, '&queue=free&ack=25');
  await press(page, 'Enter', 'hub/play');
  await press(page, 'Enter', 'deploy/vehicle');
  await press(page, 'Enter', 'deploy/pad');
  await press(page, 'Enter', 'deploy/briefing');
  await press(page, 'Enter', 'transit');
  await page.waitForFunction(() => window.__shell!.transit()?.holding === true, undefined, { timeout: 60_000 });
  const a = await page.evaluate(() => window.__shell!.transit()!);
  await page.evaluate(() => window.__test!.waitFrames(30));
  const b = await page.evaluate(() => window.__shell!.transit()!);
  // Holding: the progress stands at the hold while the camera keeps moving (the drift).
  expect(b.u).toBeCloseTo(a.u, 9);
  expect(b.steps.slice(-20).every((s) => s > 0)).toBe(true);
  await expect(page.locator('.sh-transit')).toContainText('Securing range');
  await saveScreenshot(page, 'shell-menu', 'transit-holding-1280');
  await waitMain(page, 'flight', 120_000);
  await expectNoErrors(page, pageLog);
});

for (const [w, h] of [
  [2560, 1440],
  [3840, 2160],
  [3440, 1440],
] as const) {
  test(`the screens at ${w} x ${h}`, async ({ page, pageLog }) => {
    await page.setViewportSize({ width: w, height: h });
    await openLab(page, '&queue=busy');
    await shot(page, `title-${w}x${h}`);
    await press(page, 'Enter', 'hub/play', 'launch');
    await shot(page, `hub-play-${w}x${h}`);
    await press(page, 'Enter', 'deploy/vehicle');
    await press(page, 'Enter', 'deploy/pad');
    await shot(page, `deploy-pad-${w}x${h}`);
    await press(page, 'Escape', 'deploy/vehicle');
    await press(page, 'Escape', 'hub/play');
    await press(page, 'KeyE', 'hub/hangar');
    await press(page, 'KeyE', 'hub/ships');
    await press(page, 'KeyE', 'hub/universe');
    await shot(page, `hub-universe-${w}x${h}`);
    await expectNoErrors(page, pageLog);
  });
}
