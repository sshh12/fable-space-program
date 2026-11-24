/**
 * The deploy flow by mouse only (shell-menu): the pointer moves the focus (hover) and a click activates, from the
 * title to control on the pad, with the focus asserted at every step; Back by the prompt bar from every deploy
 * screen; the hub's tabs by click; the flight menu's Leave by click. Pictures in out/screens/shell-menu/.
 *
 *   node tools/dev/heavy.mjs --class=gpu -- npx playwright test tests/browser/menu/mouse.spec.ts --project=functional
 */
import { expect, expectNoErrors, test } from '../harness';
import { click, clickPrompt, hooks, openLab, press, shot, waitMain, waitState } from './menuPage';

test.setTimeout(15 * 60_000);

test('the deploy flow by mouse only, Back by the prompt bar, the tabs by click, Leave by click', async ({ page, pageLog }) => {
  await openLab(page, '&queue=free');
  // A click on the scene begins from the title.
  await page.mouse.click(Math.round(page.viewportSize()!.width * 0.7), Math.round(page.viewportSize()!.height * 0.5));
  await waitState(page, 'hub/play');
  for (const tab of ['hangar', 'ships', 'universe', 'settings', 'credits', 'play']) await click(page, `tab-${tab}`, `hub/${tab}`);
  await click(page, 'launch', 'deploy/vehicle');
  const vehicle = await page.locator('.sh-main [data-focus^="vehicle-"]:not([aria-disabled="true"])').first().getAttribute('data-focus');
  await click(page, vehicle!, 'deploy/pad');
  await clickPrompt(page, 'Back', 'deploy/vehicle');
  await click(page, vehicle!, 'deploy/pad');
  const pad = await page.locator('.sh-main [data-focus^="pad-"]:not([aria-disabled="true"])').first().getAttribute('data-focus');
  await click(page, pad!, 'deploy/briefing');
  await shot(page, 'mouse-briefing-1280');
  await clickPrompt(page, 'Back', 'deploy/pad');
  await click(page, pad!, 'deploy/briefing');
  await click(page, 'launch-commit', 'transit');
  await waitMain(page, 'flight');
  expect(await page.evaluate(() => ({ hidden: (document.querySelector('.sh-root') as HTMLElement).hidden, scrim: window.__shell!.hooks().scrimRects }))).toEqual({ hidden: true, scrim: 0 });
  await press(page, 'Escape', 'flightMenu', 'fm-resume');
  await click(page, 'fm-leave', 'leaving');
  await waitState(page, 'hub/play');
  // Back from the hub by the prompt bar reaches the title.
  await clickPrompt(page, 'Back', 'title');
  expect((await hooks(page)).spawn).not.toBe('queued');
  await expectNoErrors(page, pageLog);
});
