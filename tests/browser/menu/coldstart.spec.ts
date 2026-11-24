/**
 * Cold start (shell-menu; ARCHITECTURE 23, 29.2): with only the boot set resident (definitions, the type, the
 * LabPlanet instead of the render packages) and the hangar's data held back by the fixture, the title renders,
 * reports real progress per step in its status line, and does not begin on a key; when the hangar's data is
 * resident Play opens and a key begins.
 *
 *   node tools/dev/heavy.mjs --class=gpu -- npx playwright test tests/browser/menu/coldstart.spec.ts --project=functional
 */
import { assertDiscreteGpu, expect, expectNoErrors, openPage, saveScreenshot, test } from '../harness';
import { hooks, waitState } from './menuPage';

test.setTimeout(10 * 60_000);

test('the title reports the boot progress and opens Play only when the hangar data is resident', async ({ page, pageLog }) => {
  const asked: string[] = [];
  page.on('request', (r) => asked.push(new URL(r.url()).pathname));
  await openPage(page, '/labs/shell/?governor=off&planet=1&holdboot=1', { timeoutMs: 600_000 });
  await assertDiscreteGpu(page);
  await waitState(page, 'title');
  const status = page.locator('.sh-title-status');
  await expect(status).toBeVisible();
  await expect(status).toContainText('Definitions');
  await expect(status).toContainText('Hangar');
  // Every step but the hangar finishes; the hangar's stays open and Play with it.
  // (innerText carries the label's text-transform: compare without case.)
  await page.waitForFunction(() => /the view from orbit\s*done/i.test((document.querySelector('.sh-title-status') as HTMLElement | null)?.innerText ?? ''), undefined, { timeout: 120_000 });
  expect(await page.locator('.sh-begin .sh-label').textContent()).toBe('');
  await saveScreenshot(page, 'shell-menu', 'coldstart-loading-1280');
  await page.keyboard.press('Enter');
  await page.evaluate(() => window.__test!.waitFrames(20));
  expect((await hooks(page)).state).toBe('title');
  // Nothing of the render packages was fetched for the title (the boot set is enough).
  expect(asked.filter((p) => p.startsWith('/tiles/') || p.includes('/packs/'))).toEqual([]);
  await page.evaluate(() => (window.__shell as unknown as { releaseHangar(): void }).releaseHangar());
  await page.waitForFunction(() => document.querySelector('.sh-begin .sh-label')?.textContent === 'Press any key to begin', undefined, { timeout: 10_000 });
  await expect(status).toBeHidden();
  await page.keyboard.press('Enter');
  await waitState(page, 'hub/play');
  await expectNoErrors(page, pageLog);
});
