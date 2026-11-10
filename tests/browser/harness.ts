/**
 * Shared helpers for Playwright specs (lead-owned). Import from every spec:
 *
 *   import { test, expect, appUrl, openPage, assertDiscreteGpu, saveScreenshot, withGpuLock } from '../harness';
 *
 * Conventions:
 *  - Every page under test exposes window.__test (src/core/contracts/testApi.ts).
 *  - Close loops on state (`page.waitForFunction`) instead of sleeping.
 *  - Screenshots go to out/screens/<package>/<name>.png (git-ignored) and are asserted to be real images.
 *  - Perf numbers are only valid inside withGpuLock(); take the lock BEFORE navigating.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test as base, type Page } from '@playwright/test';
import { PNG } from 'pngjs';
import type { AdapterReport } from '../../src/core/contracts/testApi';

export { expect };

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export interface PageLog {
  messages: string[];
}

/** `test` with a fixture that records console errors/warnings and page errors. */
export const test = base.extend<{ pageLog: PageLog }>({
  pageLog: async ({ page }, use) => {
    const log: PageLog = { messages: [] };
    page.on('console', (m) => {
      if (m.type() === 'error' || m.type() === 'warning') log.messages.push(`${m.type()}: ${m.text()}`);
    });
    page.on('pageerror', (e) => log.messages.push(`pageerror: ${e.message}`));
    await use(log);
  },
});

export function appUrl(pathAndQuery = '/'): string {
  const baseUrl = process.env.E2E_BASE_URL;
  if (!baseUrl) throw new Error('E2E_BASE_URL is not set (globalSetup did not run)');
  return baseUrl + (pathAndQuery.startsWith('/') ? pathAndQuery : `/${pathAndQuery}`);
}

/** Navigate, wait for window.__test.ready, and fail on any recorded initialisation error. */
export async function openPage(page: Page, pathAndQuery = '/', opts: { timeoutMs?: number } = {}): Promise<void> {
  await page.goto(appUrl(pathAndQuery));
  await page.waitForFunction(() => window.__test !== undefined, undefined, { timeout: opts.timeoutMs ?? 60_000 });
  const ok = await page.evaluate(() => window.__test!.ready);
  const errors = await page.evaluate(() => window.__test!.errors);
  if (!ok || errors.length > 0) throw new Error(`page failed to initialise: ${JSON.stringify(errors)}`);
}

/** Fails unless WebGPU runs on a discrete (non-fallback) NVIDIA adapter. Call in every spec before asserting visuals or perf. */
export async function assertDiscreteGpu(page: Page): Promise<AdapterReport> {
  const a = await page.evaluate(() => window.__test!.adapter);
  if (!a) throw new Error('no WebGPU adapter reported');
  if (a.isFallbackAdapter) throw new Error(`fallback adapter in use: ${JSON.stringify(a)}`);
  const expectVendor = process.env.E2E_GPU_VENDOR ?? 'nvidia';
  if (a.vendor !== expectVendor) throw new Error(`expected ${expectVendor} adapter, got ${a.vendor} (${a.description})`);
  return a;
}

/** Console noise that is known and harmless. Keep this list short and specific. */
const IGNORED_CONSOLE: RegExp[] = [
  /favicon/i,
  // Chrome on Windows ignores powerPreference (crbug.com/369219127); we assert the adapter instead.
  /powerPreference option is currently ignored/,
];

export async function expectNoErrors(page: Page, log?: PageLog): Promise<void> {
  const errors = await page.evaluate(() => window.__test!.errors);
  expect(errors, 'window.__test.errors').toEqual([]);
  if (log) {
    const real = log.messages.filter((m) => !IGNORED_CONSOLE.some((re) => re.test(m)));
    expect(real, 'console errors/warnings').toEqual([]);
  }
}

export interface PngStats {
  width: number;
  height: number;
  meanLuma: number;
  stdLuma: number;
  minLuma: number;
  maxLuma: number;
  fractionNonBlack: number;
  distinctColorBuckets: number;
  center: [number, number, number, number];
}

export function pngStats(buf: Buffer): PngStats {
  const png = PNG.sync.read(buf);
  const { width, height, data } = png;
  let sum = 0;
  let sumSq = 0;
  let min = 255;
  let max = 0;
  let nonBlack = 0;
  const buckets = new Set<number>();
  const n = width * height;
  for (let i = 0; i < data.length; i += 4) {
    const l = 0.2126 * data[i]! + 0.7152 * data[i + 1]! + 0.0722 * data[i + 2]!;
    sum += l;
    sumSq += l * l;
    if (l < min) min = l;
    if (l > max) max = l;
    if (l > 8) nonBlack++;
    if ((i & 0xff) === 0) buckets.add(((data[i]! >> 3) << 10) | ((data[i + 1]! >> 3) << 5) | (data[i + 2]! >> 3));
  }
  const mean = sum / n;
  const o = ((height >> 1) * width + (width >> 1)) * 4;
  return {
    width,
    height,
    meanLuma: mean,
    stdLuma: Math.sqrt(Math.max(0, sumSq / n - mean * mean)),
    minLuma: min,
    maxLuma: max,
    fractionNonBlack: nonBlack / n,
    distinctColorBuckets: buckets.size,
    center: [data[o]!, data[o + 1]!, data[o + 2]!, data[o + 3]!],
  };
}

/** Throws when the image is (nearly) black or uniform. Thresholds can be relaxed for legitimately dark scenes. */
export function assertRealImage(stats: PngStats, label: string, opts: { minNonBlack?: number; minStd?: number; minBuckets?: number } = {}): void {
  const { minNonBlack = 0.5, minStd = 10, minBuckets = 50 } = opts;
  if (stats.fractionNonBlack < minNonBlack) throw new Error(`${label}: mostly black (${stats.fractionNonBlack.toFixed(3)})`);
  if (stats.stdLuma < minStd) throw new Error(`${label}: nearly uniform (std ${stats.stdLuma.toFixed(2)})`);
  if (stats.distinctColorBuckets < minBuckets) throw new Error(`${label}: too few colours (${stats.distinctColorBuckets})`);
}

/** Max / mean absolute per-channel difference between two PNG buffers of equal size. */
export function pngDiff(a: Buffer, b: Buffer): { maxAbsDiff: number; meanAbsDiff: number; differingFraction: number } {
  const A = PNG.sync.read(a);
  const B = PNG.sync.read(b);
  if (A.width !== B.width || A.height !== B.height) throw new Error('pngDiff: size mismatch');
  let max = 0;
  let sum = 0;
  let differing = 0;
  for (let i = 0; i < A.data.length; i++) {
    const d = Math.abs(A.data[i]! - B.data[i]!);
    if (d) {
      differing++;
      sum += d;
      if (d > max) max = d;
    }
  }
  return { maxAbsDiff: max, meanAbsDiff: sum / A.data.length, differingFraction: differing / A.data.length };
}

/** Take a screenshot, store it under out/screens/<pkg>/<name>.png and return its statistics. */
export async function saveScreenshot(page: Page, pkg: string, name: string): Promise<{ file: string; stats: PngStats; buffer: Buffer }> {
  const dir = path.join(repoRoot, 'out', 'screens', pkg);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}.png`);
  const buffer = await page.screenshot({ path: file });
  return { file, stats: pngStats(buffer), buffer };
}

/** Wait until the page reports no pending streaming/compilation, then for `frames` more presented frames. */
export async function waitIdle(page: Page, frames = 4, timeoutMs = 120_000): Promise<void> {
  await page.waitForFunction(() => window.__test!.isIdle(), undefined, { timeout: timeoutMs });
  await page.evaluate((n) => window.__test!.waitFrames(n), frames);
}

/**
 * Machine-wide mutex for measurements that need the GPU alone. Concurrent browsers multiply GPU pass times
 * by 3-4x, so every perf assertion must run inside this lock, and the lock must be taken before the page
 * starts rendering.
 */
export async function withGpuLock<T>(fn: () => Promise<T>, timeoutMs = 20 * 60_000): Promise<T> {
  const lock = path.join(os.tmpdir(), 'fable-gpu-perf.lock');
  const t0 = Date.now();
  for (;;) {
    try {
      const fd = fs.openSync(lock, 'wx');
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      break;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST' && code !== 'EPERM') throw e;
      let stale = false;
      try {
        const pid = parseInt(fs.readFileSync(lock, 'utf8'), 10);
        if (!pid) stale = Date.now() - fs.statSync(lock).mtimeMs > 5000;
        else process.kill(pid, 0);
      } catch (k) {
        stale = (k as NodeJS.ErrnoException).code === 'ESRCH';
      }
      if (stale) {
        try {
          fs.unlinkSync(lock);
        } catch {
          /* another waiter removed it */
        }
        continue;
      }
      if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for GPU lock ${lock}`);
      await new Promise((r) => setTimeout(r, 150 + Math.random() * 150));
    }
  }
  try {
    return await fn();
  } finally {
    try {
      fs.unlinkSync(lock);
    } catch {
      /* already gone */
    }
  }
}
