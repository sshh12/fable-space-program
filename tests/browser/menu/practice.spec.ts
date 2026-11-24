/**
 * Practice (offline) by keyboard only (shell-menu): from the hub to control on the pad with every request to
 * another origin blocked (the page's own files come from the page server; the universe is unreachable), and
 * from a simulated unreachable server, where the connection banner offers Practice. The spawn goes to the
 * Practice session (the local rules' fixture), never to the lobby's.
 *
 *   node tools/dev/heavy.mjs --class=gpu -- npx playwright test tests/browser/menu/practice.spec.ts --project=functional
 */
import { expect, expectNoErrors, test } from '../harness';
import { hooks, openLab, press, shot, waitMain } from './menuPage';

test.setTimeout(15 * 60_000);

interface Fixtures {
  fixture: { requests: unknown[] };
  practice: { requests: unknown[] };
}
const requestCounts = (page: Parameters<typeof openLab>[0]): Promise<{ lobby: number; practice: number }> =>
  page.evaluate(() => {
    const s = window.__shell as unknown as Fixtures;
    return { lobby: s.fixture.requests.length, practice: s.practice.requests.length };
  });

test('Practice from the hub with every other origin blocked, to control on the pad', async ({ page, pageLog }) => {
  const blocked: string[] = [];
  await page.context().route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') return route.continue();
    blocked.push(url.href);
    return route.abort('internetdisconnected');
  });
  await openLab(page, '&queue=busy');
  await press(page, 'Enter', 'hub/play', 'launch');
  // Right along the cards to Practice (Resume is skipped when no ship can be resumed).
  for (let i = 0; i < 3 && (await hooks(page)).focus !== 'practice'; i++) await press(page, 'ArrowRight');
  expect((await hooks(page)).focus).toBe('practice');
  await press(page, 'Enter', 'deploy/vehicle', 'vehicle-*');
  expect((await hooks(page)).practice).toBe(true);
  await press(page, 'Enter', 'deploy/pad', 'pad-*');
  await press(page, 'Enter', 'deploy/briefing', 'launch-commit');
  await shot(page, 'practice-briefing-1280');
  await press(page, 'Enter', 'transit');
  await waitMain(page, 'flight');
  expect(await requestCounts(page)).toEqual({ lobby: 0, practice: 1 });
  console.log(`[practice] blocked requests to other origins: ${blocked.length}`);
  await expectNoErrors(page, pageLog);
});

test('an unreachable server: the banner offers Practice, and Practice reaches the pad', async ({ page, pageLog }) => {
  await openLab(page, '&queue=free&link=offline');
  await press(page, 'Enter', 'hub/play');
  await expect(page.locator('[data-testid="link-banner"]')).toContainText('unreachable');
  await shot(page, 'offline-banner-1280');
  // The banner's offer, by pointer (the cards' Practice is the keyboard's way, tested above).
  await page.locator('[data-focus="banner-practice"]').click();
  await page.waitForFunction(() => window.__shell!.hooks().state === 'deploy/vehicle');
  expect((await hooks(page)).practice).toBe(true);
  await press(page, 'Enter', 'deploy/pad');
  await press(page, 'Enter', 'deploy/briefing');
  await press(page, 'Enter', 'transit');
  await waitMain(page, 'flight');
  expect(await requestCounts(page)).toEqual({ lobby: 0, practice: 1 });
  await expectNoErrors(page, pageLog);
});
