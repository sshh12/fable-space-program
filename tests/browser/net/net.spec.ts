/**
 * The wire layer in real Chrome (the brief's acceptance: "the same test file passes in Node (vitest) and in
 * Chrome"): the page tests/browser/net/runner.html imports the case modules vitest runs
 * (tests/unit/net/cases), runs every case, checks the recorded fixtures and the WHATWG WebSocket transport
 * against an RFC 6455 server started here. The spec fails unless every case passes and the case list is the
 * one Node runs. No WebGPU is used by the page (so no adapter is asserted); the run still goes through the
 * GPU gate as every Chrome run does:
 *
 *   node tools/dev/heavy.mjs --class=gpu -- npx playwright test tests/browser/net --project=functional
 */
import { expect } from '@playwright/test';
import { appUrl, test } from '../harness';
import { ALL_CASES } from '../../unit/net/cases';
import { FIXTURE_FILES } from '../../unit/net/cases/fixtureCases';
import { startMiniWsServer, type MiniWsServer } from '../../unit/net/helpers/miniWsServer';

let server: MiniWsServer | null = null;

test.afterAll(async () => {
  await server?.stop();
});

test('the shared wire-layer cases pass in Chrome', async ({ page, pageLog }) => {
  test.setTimeout(10 * 60_000);
  server = await startMiniWsServer();
  server.onConnection = (c) => {
    c.onBinary = (b) => c.sendBinary(b);
  };
  // Name any resource that fails to load (a console 404 does not say which).
  const missing: string[] = [];
  page.on('response', (r) => {
    if (r.status() >= 400) missing.push(`${r.status()} ${r.url()}`);
  });
  await page.goto(appUrl(`/tests/browser/net/runner.html?ws=${server.port}`));
  await page.waitForFunction(() => window.__netResults?.done === true, undefined, { timeout: 9 * 60_000 });
  const report = await page.evaluate(() => window.__netResults!);
  const failed = report.results.filter((r) => !r.ok);
  console.log(`Chrome (${report.userAgent}): ${report.results.length} cases, ${failed.length} failed, ${report.results.reduce((s, r) => s + r.ms, 0).toFixed(0)} ms`);
  for (const r of report.results) console.log(`  ${r.ok ? 'ok  ' : 'FAIL'} ${r.ms.toFixed(0).padStart(6)} ms  ${r.name}${r.error ? `: ${r.error}` : ''}`);
  expect(failed, 'failed cases').toEqual([]);
  const expected = [...ALL_CASES.map((c) => c.name), ...FIXTURE_FILES.map((f) => `fixture ${f}: every frame re-encodes identically, every message round-trips`), 'the WHATWG WebSocket transport exchanges binary frames with an RFC 6455 server'];
  expect(report.results.map((r) => r.name)).toEqual(expected);
  expect(missing, 'resources that failed to load').toEqual([]);
  const errors = pageLog.messages.filter((m) => !/favicon/i.test(m));
  expect(errors, 'console errors and warnings').toEqual([]);
});
