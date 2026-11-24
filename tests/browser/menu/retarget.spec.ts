/**
 * A refused spawn re-targets (shell-menu; frontend-ux 5.10, 5.11): the server refuses the first launch with an
 * alternative pad (the fixture's `refuseNext`), the transit rises back to the deploy flow with the reason and the
 * alternative, and taking it launches from there to control on the pad.
 *
 *   node tools/dev/heavy.mjs --class=gpu -- npx playwright test tests/browser/menu/retarget.spec.ts --project=functional
 */
import { expect, expectNoErrors, test } from '../harness';
import { hooks, openLab, press, shot, waitMain } from './menuPage';

test.setTimeout(10 * 60_000);

test('a refused launch rises back with the reason and the alternative, and the alternative launches', async ({ page, pageLog }) => {
  await openLab(page, '&queue=free&refuse=1');
  await press(page, 'Enter', 'hub/play', 'launch');
  await press(page, 'Enter', 'deploy/vehicle');
  await press(page, 'Enter', 'deploy/pad');
  await press(page, 'Enter', 'deploy/briefing', 'launch-commit');
  await press(page, 'Enter', 'transit');
  await page.waitForFunction(() => window.__shell!.hooks().spawn === 'refused' && window.__shell!.hooks().main === 'deploy', undefined, { timeout: 60_000 });
  const refused = page.locator('[data-testid="spawn-refused"]');
  await expect(refused).toContainText('The pad was taken a moment before you.');
  await expect(refused.locator('[data-focus="take-alternative"]')).toBeVisible();
  await shot(page, 'spawn-refused-1280');
  console.log(`[retarget] back at ${(await hooks(page)).state}`);
  await refused.locator('[data-focus="take-alternative"]').click();
  await page.waitForFunction(() => window.__shell!.hooks().state === 'deploy/briefing');
  await press(page, 'Enter', 'transit');
  await waitMain(page, 'flight');
  await expectNoErrors(page, pageLog);
});
