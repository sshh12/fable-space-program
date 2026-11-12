/**
 * The boot set (ARCHITECTURE 10.4, 29.2 "Cold start"): the first-paint chunks of the production client build
 * and the boot pack, at most 25 MB, loaded cold (clean profile, no cache) over a 50 Mbit/s throttle in under
 * 8 s, from the local stack's shell serving `npm run stack:client`'s build and the boot pack it loaded from the
 * bucket stand-in. The title itself is assembled later (app-integration-1): here the page's own requests beyond
 * the boot set are held back, so the measurement is the boot set alone. Runs INSIDE the stack with --page=build:
 *
 *   STACK_NAME=fsp-platform-delivery npm run stack -- --page=build -- node tools/dev/heavy.mjs --class=gpu -- npx playwright test tests/browser/platform/coldstart.spec.ts --project=functional
 */
import fs from 'node:fs';
import type { StackState } from '../../../deploy/local/launcher';
import { expect, test } from '../harness';

const STATE = process.env.STACK_STATE;
test.skip(!STATE, 'runs inside the local stack with --page=build');

const MBIT = 1e6 / 8;

test('the boot set: at most 25 MB, cold over 50 Mbit/s in under 8 s, cross-origin isolated', async ({ page }) => {
  const s = JSON.parse(fs.readFileSync(STATE!, 'utf8')) as StackState;
  test.skip(s.options.page !== 'build', 'needs --page=build (the shell serving the production build)');
  const shell = s.urls.shell;
  const html = await (await fetch(`${shell}/`)).text();
  const entry = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+\.(?:js|css))"/g)].map((m) => m[1]!);
  const allowed = (p: string): boolean => p === '/' || p === '/index.html' || p === '/endpoints.json' || p.startsWith('/boot/') || p.startsWith('/defs/') || entry.includes(p) || /^\/assets\/[^/]+-[A-Za-z0-9_-]{8,}\.js$/.test(p);
  const held: string[] = [];
  await page.route('**/*', async (route) => {
    const u = new URL(route.request().url());
    if (u.origin === new URL(shell).origin && allowed(u.pathname)) await route.continue();
    else {
      held.push(u.pathname);
      await route.abort('blockedbyclient');
    }
  });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
  await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 20, downloadThroughput: 50 * MBIT, uploadThroughput: 20 * MBIT });
  const sizes = new Map<string, number>();
  cdp.on('Network.loadingFinished', (e: { requestId: string; encodedDataLength: number }) => sizes.set(e.requestId, e.encodedDataLength));
  const t0 = Date.now();
  await page.goto(`${shell}/`, { waitUntil: 'load' });
  const boot = await page.evaluate(async () => {
    const ep = (await (await fetch('/endpoints.json')).json()) as { bootPack: { url: string; hash: string; bytes: number } };
    const r = await fetch(ep.bootPack.url);
    const b = new Uint8Array(await r.arrayBuffer());
    const d = new Uint8Array(await crypto.subtle.digest('SHA-256', b));
    return { bytes: b.length, hash: [...d.subarray(0, 16)].map((x) => x.toString(16).padStart(2, '0')).join(''), expect: ep.bootPack, isolated: crossOriginIsolated };
  });
  const ms = Date.now() - t0;
  const total = [...sizes.values()].reduce((n, x) => n + x, 0);
  console.log(`boot set cold over 50 Mbit/s: ${(total / 1e6).toFixed(2)} MB transferred in ${(ms / 1000).toFixed(2)} s (boot pack ${(boot.bytes / 1e6).toFixed(2)} MB, verified ${boot.hash === boot.expect.hash}); held back ${held.length} requests of the page beyond the boot set`);
  expect(boot.isolated).toBe(true);
  expect(boot.hash).toBe(boot.expect.hash);
  expect(boot.bytes).toBe(boot.expect.bytes);
  expect(total).toBeLessThanOrEqual(25e6);
  expect(ms).toBeLessThan(8000);
});
