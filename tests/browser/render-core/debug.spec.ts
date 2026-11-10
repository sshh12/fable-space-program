import { openPage, test } from '../harness';

/** Scratch spec for interactive debugging (skipped unless RC_DEBUG_URL is set). */
test('debug', async ({ page, pageLog }) => {
  test.skip(!process.env.RC_DEBUG_URL, 'set RC_DEBUG_URL to use');
  await openPage(page, process.env.RC_DEBUG_URL!).catch((e: unknown) => console.log('open failed', String(e)));
  await page.waitForTimeout(Number(process.env.RC_DEBUG_WAIT ?? 1500));
  const out = await page.evaluate(process.env.RC_DEBUG_EVAL ?? '(() => window.__test.errors)()');
  console.log('RESULT', JSON.stringify(out, null, 1));
  console.log('ERRORS', JSON.stringify(await page.evaluate(() => window.__test?.errors)));
  console.log('LOG', JSON.stringify(pageLog.messages.slice(0, 20)));
  if (process.env.RC_DEBUG_SHOT) await page.screenshot({ path: `out/screens/render-core/${process.env.RC_DEBUG_SHOT}.png` });
});
