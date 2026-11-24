/**
 * The capability gate in real Chrome (ARCHITECTURE 24, frontend-ux 9.7 and 14): the block pages for a phone
 * (device emulation), a browser without WebGPU (navigator.gpu taken away before the page runs) and an adapter
 * without a required feature (the real adapter wrapped), each with no request for the main bundle or any
 * tile in the network log; and on this machine a pass that loads the app with the report handed over.
 * Pictures: out/screens/capability-settings/gate-<reason>.png (looked at).
 */
import { devices, type BrowserContext, type Page } from '@playwright/test';
import { appUrl, expect, saveScreenshot, test } from '../harness';

/** Requests a blocked visitor must never make: the app's modules (dev) or chunks (build), tiles, sky, packs. */
const FORBIDDEN = /\/src\/(app|render|sim|session|terrain|shell|ui|map|audio|camera|input|bench)\/|\/assets\/main|\/tiles\/|\/sky\/|\/packs\//;

async function openBlocked(context: BrowserContext, reason: string): Promise<{ page: Page; requests: string[] }> {
  const page = await context.newPage();
  const requests: string[] = [];
  page.on('request', (r) => requests.push(r.url()));
  await page.goto(appUrl('/'));
  await page.waitForSelector(`#fsp-gate[data-reason="${reason}"]`, { timeout: 30_000 });
  // A stray request would show before the network has been quiet for 500 ms.
  await page.waitForLoadState('networkidle');
  return { page, requests };
}

async function checkBlockPage(page: Page, requests: string[], reason: string, headline: RegExp): Promise<void> {
  expect(requests.filter((u) => FORBIDDEN.test(u)), 'requests of the main bundle or data').toEqual([]);
  await expect(page.locator('#fsp-gate h1')).toHaveText(headline);
  await expect(page.locator('#fsp-gate button[data-action="copy-report"]')).toBeVisible();
  const handoff = await page.evaluate(() => window.__fspGate!);
  expect(handoff.report.pass).toBe(false);
  expect(handoff.report.reason).toBe(reason);
  expect(await page.evaluate(() => document.documentElement.dataset['gate'])).toBe(`blocked:${reason}`);
  expect(await page.evaluate(() => window.__test === undefined)).toBe(true);
  const shot = await saveScreenshot(page, 'capability-settings', `gate-${reason}`);
  expect(shot.stats.maxLuma).toBeGreaterThan(150);
}

test('a phone gets the mobile block page and never the main bundle', async ({ browser }) => {
  const context = await browser.newContext({ ...devices['Pixel 7'] });
  const { page, requests } = await openBlocked(context, 'mobile');
  await checkBlockPage(page, requests, 'mobile', /desktop computer/i);
  await expect(page.locator('#fsp-gate a', { hasText: 'E-mail me the link' })).toHaveAttribute('href', /^mailto:/);
  await context.close();
});

test('a browser without WebGPU gets the noWebGpu block page', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  await context.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, 'gpu', { get: () => undefined, configurable: true });
  });
  const { page, requests } = await openBlocked(context, 'noWebGpu');
  await checkBlockPage(page, requests, 'noWebGpu', /no WebGPU/i);
  await context.close();
});

test('an adapter without texture-compression-bc gets the missingFeature block page', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  await context.addInitScript(() => {
    const gpu = navigator.gpu;
    const real = gpu.requestAdapter.bind(gpu);
    gpu.requestAdapter = async (opts?: GPURequestAdapterOptions) => {
      const a = await real(opts);
      if (!a) return a;
      const features = new Set([...a.features].filter((f) => f !== 'texture-compression-bc'));
      return { features, limits: a.limits, info: a.info, requestDevice: (d?: GPUDeviceDescriptor) => a.requestDevice(d) } as unknown as GPUAdapter;
    };
  });
  const { page, requests } = await openBlocked(context, 'missingFeature');
  await checkBlockPage(page, requests, 'missingFeature', /missing something/i);
  await expect(page.locator('#fsp-gate')).toContainText('texture-compression-bc');
  await context.close();
});

test('on this machine the gate passes, hands the report over and loads the app', async ({ page }) => {
  const requests: string[] = [];
  page.on('request', (r) => requests.push(r.url()));
  await page.goto(appUrl('/?governor=off&mute=1&capturepill=0'));
  await page.waitForFunction(() => window.__test !== undefined, undefined, { timeout: 60_000 });
  const handoff = await page.evaluate(() => window.__fspGate!);
  expect(handoff.report.pass).toBe(true);
  expect(handoff.report.vendor).toBe(process.env.E2E_GPU_VENDOR ?? 'nvidia');
  expect(handoff.report.adapterClass).toBe('discrete');
  expect(handoff.report.fingerprint).toMatch(/^[0-9a-f]{16}$/);
  expect(handoff.safe).toBe(false);
  expect(handoff.ms).toBeLessThan(2000);
  expect(await page.locator('#fsp-gate').count()).toBe(0);
  // The gate's module came before the app's.
  const gateAt = requests.findIndex((u) => u.includes('/src/gate/'));
  const appAt = requests.findIndex((u) => u.includes('/src/app/main.ts'));
  expect(gateAt).toBeGreaterThanOrEqual(0);
  expect(appAt).toBeGreaterThan(gateAt);
  console.log(`[gate] pass in ${handoff.ms.toFixed(0)} ms: ${handoff.report.vendor} ${handoff.report.architecture}, ${handoff.report.browser}, fingerprint ${handoff.report.fingerprint}`);
});
