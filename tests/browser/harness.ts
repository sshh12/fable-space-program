/**
 * Shared helpers for Playwright specs (lead-owned). Import from every spec:
 *
 *   import { test, expect, appUrl, openPage, assertDiscreteGpu, saveScreenshot, withGpuLock } from '../harness';
 *
 * Conventions:
 *  - Every page under test exposes window.__test (src/core/contracts/testApi.ts).
 *  - Close loops on state (`page.waitForFunction`) instead of sleeping.
 *  - Screenshots go to out/screens/<package>/<name>.png (git-ignored) and are asserted to be real images.
 *  - Perf numbers are only valid inside withGpuLock(); take the lock BEFORE navigating. The lock also keeps
 *    the display awake, because Chrome paces frames at about 57.5 Hz while the monitor sleeps (see
 *    keepDisplayAwake). A spec that judges requestAnimationFrame pacing measures the harness clock first
 *    (measureHarnessClock) and judges only on a nominal one (expectNominalClock).
 *  - Reference images (ARCHITECTURE 31.3): open a checkpoint with openCheckpoint and compare with
 *    compareToBaseline / expectBaseline; only the lead records (recordBaseline). A reference capture is a
 *    lead-in that is thrown away and two captures that must be identical to the bit (baselineLogic.ts).
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test as base, type Page } from '@playwright/test';
import { PNG } from 'pngjs';
import type { AdapterReport } from '../../src/core/contracts/testApi';
import { captureFrameExact, describeStep, manifestProblems, type BaselineCheckpoint, type BaselineManifest, type BaselineStep, type BaselineTolerance, type ExactPair } from './baselineLogic';

export { captureFrameExact, exactPairVerdict, manifestProblems, NotFrameExactError } from './baselineLogic';
export type { BaselineCheckpoint, BaselineManifest, BaselineStep, BaselineTolerance, ExactCapture, ExactPair } from './baselineLogic';

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
  // A sleeping monitor slows Chrome's frame clock to about 57.5 Hz (keepDisplayAwake): measurements need 60.
  const releaseDisplay = await keepDisplayAwake();
  try {
    return await fn();
  } finally {
    releaseDisplay();
    try {
      fs.unlinkSync(lock);
    } catch {
      /* already gone */
    }
  }
}

// ------------------------------------------------------------------------------------------------ display

/**
 * What the helper below runs: wake the display with a net-zero pointer movement, then hold a power request
 * that keeps the display and the system awake until standard input closes.
 */
const KEEP_AWAKE_PS = `
$ErrorActionPreference = 'Stop'
Add-Type -Namespace Fable -Name Power -MemberDefinition @'
[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint esFlags);
[DllImport("kernel32.dll")] public static extern uint GetTickCount();
[DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, int dx, int dy, uint dwData, System.UIntPtr dwExtraInfo);
[DllImport("user32.dll")] public static extern bool GetLastInputInfo(ref LASTINPUTINFO plii);
[StructLayout(LayoutKind.Sequential)] public struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }
'@
$lii = New-Object Fable.Power+LASTINPUTINFO
$lii.cbSize = [System.Runtime.InteropServices.Marshal]::SizeOf($lii)
[void][Fable.Power]::GetLastInputInfo([ref]$lii)
$idle = [int](([Fable.Power]::GetTickCount() - $lii.dwTime) / 1000)
[Fable.Power]::mouse_event(1, 1, 0, 0, [System.UIntPtr]::Zero)
[Fable.Power]::mouse_event(1, -1, 0, 0, [System.UIntPtr]::Zero)
[void][Fable.Power]::SetThreadExecutionState([uint32]2147483651)
if ($idle -gt 60) { Start-Sleep -Milliseconds 3000 }
[Console]::Out.WriteLine("awake idle=$idle")
[Console]::Out.Flush()
while ($null -ne [Console]::In.ReadLine()) { }
`;

/** Seconds without user input when the display was last woken by keepDisplayAwake (null before the first call). */
export let lastDisplayIdleSeconds: number | null = null;

/**
 * Keep the display awake until the returned function is called (Windows; elsewhere a no-op).
 *
 * Why (request app-integration-8, measured 2026-11-11 with tests/browser/shell/frame-clock.perf.spec.ts): on
 * Windows, Chrome's GPU process takes its frame clock from the monitor's vertical blank
 * (IDXGIOutput::WaitForVBlank). While the monitor SLEEPS that wait returns at once, and Chrome falls back to
 * sleeping one frame interval rounded up to a whole millisecond (17 ms), which with the scheduling overhead
 * gives a steady 17.4 ms: every page that presents frames, headless or headed, however light, runs at about
 * 57.5 Hz. An unattended run (the display turns itself off after a few idle minutes) therefore cannot meet a
 * line such as "rAF p95 < 16.7 ms" although no frame is late. With the display awake the clock is the
 * monitor's own 60 Hz and the lines mean what they say.
 *
 * The helper is one PowerShell process: it wakes the display with a pointer movement of +1 and -1 pixel
 * (the pointer does not move), waits 3 s for the panel when the machine had been idle, and holds
 * ES_CONTINUOUS | ES_DISPLAY_REQUIRED | ES_SYSTEM_REQUIRED until its input closes or its parent dies. If it
 * cannot start, the run continues with a console note; expectNominalClock then says why pacing was not judged.
 */
export async function keepDisplayAwake(): Promise<() => void> {
  if (process.platform !== 'win32' || process.env.E2E_NO_DISPLAY_WAKE) return () => undefined;
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(KEEP_AWAKE_PS, 'utf16le').toString('base64')], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const release = (): void => {
    try {
      child.stdin.end();
    } catch {
      /* already closed */
    }
    // The helper leaves its loop when its input closes; do not leave it behind if it does not.
    setTimeout(() => {
      if (child.exitCode === null) child.kill();
    }, 2000).unref();
  };
  const ready = await new Promise<string | null>((resolve) => {
    let out = '';
    let err = '';
    const timer = setTimeout(() => resolve(null), 20_000);
    child.stdout.on('data', (d: Buffer) => {
      out += d.toString('utf8');
      const m = /awake idle=(\d+)/.exec(out);
      if (m) {
        clearTimeout(timer);
        resolve(m[1]!);
      }
    });
    child.stderr.on('data', (d: Buffer) => {
      err += d.toString('utf8');
    });
    child.on('error', () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.on('exit', () => {
      clearTimeout(timer);
      if (!/awake idle=/.test(out)) console.warn(`[harness] the display keep-awake helper exited early: ${err.trim().slice(0, 300)}`);
      resolve(null);
    });
  });
  if (ready === null) {
    console.warn('[harness] the display could not be kept awake: frame pacing may run on a 57.5 Hz clock (see keepDisplayAwake)');
    release();
    return () => undefined;
  }
  lastDisplayIdleSeconds = Number(ready);
  return release;
}

// ------------------------------------------------------------------------------------------- frame clock

/** Distribution of the deltas of a series of frame timestamps, ms. */
export interface FrameClockStats {
  count: number;
  mean: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  /** 1000 / mean: the rate the page was actually presented at. */
  hz: number;
}

/** Statistics of the frame-to-frame deltas of `timestamps` (ms, ascending), e.g. the rAF callback times. */
export function frameClockOf(timestamps: readonly number[]): FrameClockStats {
  const d: number[] = [];
  for (let i = 1; i < timestamps.length; i++) d.push(timestamps[i]! - timestamps[i - 1]!);
  if (d.length === 0) throw new Error('frameClockOf: needs at least two timestamps');
  const sorted = [...d].sort((a, b) => a - b);
  const q = (p: number): number => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))]!;
  const mean = d.reduce((s, x) => s + x, 0) / d.length;
  return { count: d.length, mean, p50: q(0.5), p95: q(0.95), p99: q(0.99), max: sorted[sorted.length - 1]!, hz: 1000 / mean };
}

/** Period of the clock the perf lines of ARCHITECTURE 29 are written for, ms (60 Hz). */
export const NOMINAL_FRAME_MS = 1000 / 60;
/**
 * A harness clock whose MEDIAN period is within this of nominal is the monitor's vertical blank; the
 * sleep-paced fallback is 0.5 to 0.7 ms off. The median, not the mean: a frame the bare page drops on a busy
 * machine adds a whole period to the mean and says nothing about the clock.
 */
export const NOMINAL_CLOCK_TOLERANCE_MS = 0.2;

const CLOCK_PAGE = `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;background:#000;color:#234;font:12px monospace}</style></head>
<body><div id="t"></div><script>
window.__clock = (frames, warm) => new Promise((resolve) => {
  const label = document.getElementById('t');
  const ts = [];
  let i = -warm;
  const loop = (t) => {
    label.textContent = 'frame ' + i;
    if (i >= 0) ts.push(t);
    i++;
    if (i < frames) requestAnimationFrame(loop); else resolve(ts);
  };
  requestAnimationFrame(loop);
});
</script></body></html>`;

/**
 * The frame clock the harness gives a page that does almost nothing: a second page in the same browser
 * context that rewrites one text node per frame (so every frame is presented) for `frames` frames after
 * `warm`. Call it under the GPU lock, before or after the measurement it qualifies, never during it. With
 * the display awake it reports 16.67 ms p50 and 60.00 Hz; about 17.4 ms and 57.5 Hz means the monitor is
 * asleep or absent (keepDisplayAwake).
 */
export async function measureHarnessClock(page: Page, frames = 240, warm = 45): Promise<FrameClockStats> {
  const probe = await page.context().newPage();
  try {
    const url = 'http://localhost/__harness-clock.html';
    await probe.route(url, (route) => route.fulfill({ status: 200, contentType: 'text/html', body: CLOCK_PAGE }));
    await probe.goto(url);
    await probe.bringToFront();
    const ts = await probe.evaluate(([n, w]) => (window as unknown as { __clock(n: number, w: number): Promise<number[]> }).__clock(n!, w!), [frames, warm] as const);
    return frameClockOf(ts);
  } finally {
    await probe.close();
    await page.bringToFront();
  }
}

/** True when the measured harness clock is the nominal 60 Hz vertical blank. */
export function isNominalClock(clock: FrameClockStats): boolean {
  return Math.abs(clock.p50 - NOMINAL_FRAME_MS) <= NOMINAL_CLOCK_TOLERANCE_MS;
}

/**
 * Fails with the reason when the harness clock is not nominal. A spec calls this before it asserts a
 * requestAnimationFrame line of ARCHITECTURE 29 or 31: a pacing line is judged on the 60 Hz clock it was
 * written for, or not at all. It is never judged against a slower clock with a wider number, and never
 * passed unjudged.
 */
export function expectNominalClock(clock: FrameClockStats, label = 'harness clock'): void {
  if (isNominalClock(clock)) return;
  throw new Error(
    `${label}: the page clock runs at ${clock.hz.toFixed(2)} Hz (p50 ${clock.p50.toFixed(2)} ms, mean ${clock.mean.toFixed(3)} ms), not at 60 Hz. ` +
      'Chrome paces frames with a 17 ms sleep while the monitor is asleep or absent, so requestAnimationFrame lines cannot be judged in this run. ' +
      'Run the measurement inside withGpuLock (it keeps the display awake) on a machine with its monitor connected' +
      (lastDisplayIdleSeconds !== null ? ` (the display had been idle ${lastDisplayIdleSeconds} s when it was last woken).` : '.'),
  );
}

// ------------------------------------------------------------------------------------- reference images

/**
 * Reference images (ARCHITECTURE 31.3). The lead records one PNG per checkpoint in deterministic mode into
 * data/baselines/ (git-ignored) and tracks tests/browser/baselines.manifest.json: per checkpoint the page it
 * is captured from, the file, its sha256 and its tolerance. Packages that touch the renderer compare with
 * compareToBaseline / expectBaseline and never record.
 *
 * Deterministic, FRAME-EXACT capture. The page is opened with frozen presentation time (the labs'
 * `deterministic=1&paused=1`, the app's window.__test.setDeterministic / setPaused). When streaming is idle
 * the harness calls window.__test.renderExact(frames): the page restarts every temporal sequence (jitter,
 * noise, histories, exposure), renders exactly `frames` frames and holds the last one on screen; the
 * screenshot is of that held frame. Waiting "about N frames" and then taking a screenshot from Node is NOT
 * a capture: anything that integrates over frames is then at a different phase on every load (measured:
 * 18 % of the pixels of a low-orbit view differed between two loads, which forced a tolerance a 130 x 130
 * pixel change could pass under). A page without renderExact cannot be a source of reference images.
 * The environment a recording was made in (the tile sets' content hashes, the Chrome version, the adapter)
 * is stored with it: a comparison made in another environment says so.
 *
 * Difference measure, on 8-bit sRGB values, alpha ignored:
 *   meanAbs  mean over all pixels and the three channels of |a - b|
 *   p999     99.9th percentile over pixels of the largest channel difference of the pixel
 * so that a change of one pixel row of a 720-row image (0.139 % of the pixels) moves p999, and a faint
 * change everywhere moves meanAbs.
 *
 * Tolerance: each checkpoint is captured from three or more fresh page loads; its tolerance is three times
 * the largest difference between any two of them, and never below the manifest's floor. With a frame-exact
 * capture that difference is what the GPU itself does not repeat, which is nothing or nearly nothing; a
 * checkpoint whose loads differ visibly is not accepted as a reference until the cause is found.
 *
 * The first-capture rule (request core-7; baselineLogic.ts): the capture of a load, for a recording and for
 * a comparison alike, is a lead-in that is thrown away and two more captures that must be identical to the
 * bit; the second of them is used. A page whose two captures differ is not frame-exact and fails as such.
 *
 * A checkpoint is its page plus its setup: steps run on the page's test handles after it has loaded (a
 * camera of the integration lab, the app's deterministic switches, frames stepped with the loop stopped).
 * openCheckpoint runs both, so that a recording and every later comparison stand at the same view.
 */
export interface ImageDifference {
  meanAbs: number;
  p999: number;
  maxAbs: number;
  /** Fraction of pixels with any difference. */
  differingFraction: number;
  width: number;
  height: number;
}

export interface BaselineComparison extends ImageDifference {
  name: string;
  tolerance: BaselineTolerance;
  /** The checkpoint is marked exact in the manifest: it passes only when no pixel differs (the tolerance is not consulted). */
  exact: boolean;
  pass: boolean;
  /** Tile sets whose content hash differs from the recording's ("earth ab20... -> 77c1..."); empty when the data is the recorded snapshot. */
  dataChanged: string[];
  /** What else differs from the recording's environment: the Chrome version, the adapter ("chrome 157.0.8103.78 -> 158.0.8200.10"). */
  environmentChanged: string[];
  /** Written when the comparison fails: the capture and a difference image (differences amplified 8x), for looking at. */
  actualFile: string | null;
  diffFile: string | null;
  /** How the discarded lead-in capture differed from the capture that was compared (request core-7); null when the caller supplied the capture. */
  leadIn: ExactPair | null;
}

export interface BaselineStore {
  /** Manifest file (default tests/browser/baselines.manifest.json). */
  manifestFile?: string;
}

export const BASELINE_MANIFEST_FILE = path.join(repoRoot, 'tests', 'browser', 'baselines.manifest.json');

export function readBaselineManifest(store: BaselineStore = {}): BaselineManifest {
  const file = store.manifestFile ?? BASELINE_MANIFEST_FILE;
  const m = JSON.parse(fs.readFileSync(file, 'utf8')) as BaselineManifest;
  if (m.version !== 1) throw new Error(`${file}: unknown baseline manifest version ${String(m.version)}`);
  return m;
}

/** Run a checkpoint's setup steps on the page (see BaselineStep). A call that returns false or null fails the setup. */
export async function runBaselineSteps(page: Page, steps: readonly BaselineStep[], timeoutMs = 180_000): Promise<void> {
  for (const step of steps) {
    if ('waitIdle' in step) {
      await page.waitForFunction(() => window.__test !== undefined && window.__test.isIdle(), undefined, { timeout: timeoutMs });
    } else if ('waitFrames' in step) {
      await page.evaluate((n) => window.__test!.waitFrames(n), step.waitFrames);
    } else {
      const outcome = await page.evaluate(
        async ({ path: dotted, args, repeat }) => {
          const parts = dotted.split('.');
          let owner: unknown = window;
          for (const part of parts.slice(0, -1)) {
            owner = (owner as Record<string, unknown> | null | undefined)?.[part];
            if (owner === null || owner === undefined) return `${part} is not on this page`;
          }
          const fn = (owner as Record<string, unknown>)[parts[parts.length - 1]!];
          if (typeof fn !== 'function') return `${dotted} is not a function on this page`;
          let result: unknown;
          for (let i = 0; i < repeat; i++) result = await (fn as (...a: unknown[]) => unknown).apply(owner, args);
          return result === false || result === null ? `it returned ${String(result)}: the page could not do what the step asks` : null;
        },
        { path: step.call, args: step.args ?? [], repeat: step.repeat ?? 1 },
      );
      if (outcome !== null) throw new Error(`checkpoint setup step ${describeStep(step)} failed: ${outcome}`);
    }
  }
}

/**
 * Open a checkpoint as its reference image was (or will be) recorded: its page at the manifest's viewport,
 * on the discrete GPU, then its setup steps. Follow with expectBaseline(page, name).
 */
export async function openCheckpoint(page: Page, name: string, opts: BaselineStore & { timeoutMs?: number } = {}): Promise<BaselineCheckpoint> {
  const m = readBaselineManifest(opts);
  const entry = baselineEntry(m, name);
  if (entry.page === null) throw new Error(`checkpoint "${name}" is not framed: it has no page`);
  const [width, height] = m.viewport;
  const size = page.viewportSize();
  if (!size || size.width !== width || size.height !== height) throw new Error(`checkpoint "${name}" is captured at ${width} x ${height} (the manifest's viewport); the page is ${size ? `${size.width} x ${size.height}` : 'of no fixed size'}: test.use({ viewport, deviceScaleFactor: 1 })`);
  await openPage(page, entry.page, { timeoutMs: opts.timeoutMs ?? 180_000 });
  await assertDiscreteGpu(page);
  await runBaselineSteps(page, entry.setup ?? [], opts.timeoutMs ?? 180_000);
  return entry;
}

const sha256 = (buf: Buffer): string => createHash('sha256').update(buf).digest('hex');

/** Content hashes of the baked tile sets on this machine (the site-data snapshot of a capture). */
export function tileSnapshot(): Record<string, string> {
  const root = path.join(repoRoot, 'data', 'tiles');
  const out: Record<string, string> = {};
  if (!fs.existsSync(root)) return out;
  for (const e of fs.readdirSync(root, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const manifest = path.join(root, e.name, 'manifest.json');
    if (e.isDirectory() && fs.existsSync(manifest)) out[e.name] = (JSON.parse(fs.readFileSync(manifest, 'utf8')) as { contentHash?: string }).contentHash ?? 'unknown';
  }
  return out;
}

/** The difference measure of the reference images between two PNG buffers of equal size. */
export function imageDifference(a: Buffer, b: Buffer): ImageDifference & { diff: Buffer } {
  const A = PNG.sync.read(a);
  const B = PNG.sync.read(b);
  if (A.width !== B.width || A.height !== B.height) throw new Error(`imageDifference: size mismatch (${A.width}x${A.height} against ${B.width}x${B.height})`);
  const n = A.width * A.height;
  const histogram = new Uint32Array(256);
  const out = new PNG({ width: A.width, height: A.height });
  let sum = 0;
  let max = 0;
  let differing = 0;
  for (let p = 0, i = 0; p < n; p++, i += 4) {
    const dr = Math.abs(A.data[i]! - B.data[i]!);
    const dg = Math.abs(A.data[i + 1]! - B.data[i + 1]!);
    const db = Math.abs(A.data[i + 2]! - B.data[i + 2]!);
    const d = Math.max(dr, dg, db);
    sum += dr + dg + db;
    histogram[d]!++;
    if (d > 0) differing++;
    if (d > max) max = d;
    out.data[i] = Math.min(255, dr * 8);
    out.data[i + 1] = Math.min(255, dg * 8);
    out.data[i + 2] = Math.min(255, db * 8);
    out.data[i + 3] = 255;
  }
  // 99.9th percentile: the smallest value v such that at least 99.9 % of the pixels differ by v or less.
  const need = Math.ceil(0.999 * n);
  let seen = 0;
  let p999 = 0;
  for (let v = 0; v < 256; v++) {
    seen += histogram[v]!;
    if (seen >= need) {
      p999 = v;
      break;
    }
  }
  return { meanAbs: sum / (n * 3), p999, maxAbs: max, differingFraction: differing / n, width: A.width, height: A.height, diff: PNG.sync.write(out) };
}

/** Loads a frame-exact capture may need before streaming stays idle through its frames. */
const EXACT_ATTEMPTS = 5;

/**
 * The frame-exact capture of a reference image: wait for idle, have the page restart its temporal sequences,
 * render exactly `frames` frames and hold the last (window.__test.renderExact), then take the screenshot of
 * the held frame. If work arrived while the frames were rendered the frame is not the reference frame: wait
 * for idle and ask again. The page must already be open in deterministic mode.
 */
export async function captureDeterministic(page: Page, frames = 64, timeoutMs = 180_000): Promise<Buffer> {
  await page.waitForFunction(() => window.__test !== undefined, undefined, { timeout: timeoutMs });
  if (!(await page.evaluate(() => typeof window.__test!.renderExact === 'function'))) {
    throw new Error('this page has no window.__test.renderExact (request lead-3): a reference image cannot be captured frame-exactly from it. For a screenshot that is not a reference use captureSettled.');
  }
  for (let attempt = 1; attempt <= EXACT_ATTEMPTS; attempt++) {
    await page.waitForFunction(() => window.__test!.isIdle(), undefined, { timeout: timeoutMs });
    const held = await page.evaluate((n) => window.__test!.renderExact!(n), frames);
    if (held.frames !== frames) throw new Error(`renderExact(${frames}) held frame ${held.frames}`);
    if (held.idle) return page.screenshot();
  }
  throw new Error(`streaming did not stay idle through ${frames} frames in ${EXACT_ATTEMPTS} attempts: the page is not settled enough for a reference image`);
}

/**
 * The capture of a reference image under the first-capture rule: a lead-in frame-exact capture that is
 * thrown away, then two more that must be identical to the bit (NotFrameExactError otherwise); the second
 * is the capture. `what` names the checkpoint in the failure.
 */
export async function captureReference(page: Page, frames = 64, what = 'the page', timeoutMs = 180_000): Promise<{ image: Buffer; leadIn: ExactPair }> {
  return captureFrameExact(() => captureDeterministic(page, frames, timeoutMs), what);
}

/**
 * A screenshot of a settled page for looking at, NOT a reference image: waits for idle, lets `frames` frames
 * pass and takes the picture. Which frame it shows differs from load to load.
 */
export async function captureSettled(page: Page, frames = 64, timeoutMs = 180_000): Promise<Buffer> {
  await page.waitForFunction(() => window.__test !== undefined && window.__test.isIdle(), undefined, { timeout: timeoutMs });
  await page.evaluate((n) => window.__test!.waitFrames(n), frames);
  await page.waitForFunction(() => window.__test!.isIdle(), undefined, { timeout: timeoutMs });
  await page.evaluate(() => window.__test!.waitFrames(4));
  return page.screenshot();
}

/** The Chrome version and the adapter of a page, as stored with a recording. */
async function environmentOf(page: Page): Promise<{ chrome: string; adapter: string }> {
  const adapter = await page.evaluate(() => window.__test?.adapter ?? null);
  return { chrome: page.context().browser()?.version() ?? 'unknown', adapter: adapter ? `${adapter.vendor} ${adapter.description}`.trim() : 'unknown' };
}

function baselineEntry(m: BaselineManifest, name: string): BaselineCheckpoint {
  const entry = m.checkpoints[name];
  if (!entry) throw new Error(`no checkpoint "${name}" in the baseline manifest (known: ${Object.keys(m.checkpoints).join(', ')})`);
  return entry;
}

/**
 * Compare the page, as it is now, with the recorded reference image of checkpoint `name`. The caller has
 * opened the checkpoint's page (`readBaselineManifest().checkpoints[name].page`) at the manifest's viewport.
 * Reports the mean absolute difference and the 99.9th percentile against the checkpoint's tolerance; it does
 * not assert (expectBaseline does). The page is captured under the first-capture rule (a lead-in, then two
 * captures that must be identical: a page that is not frame-exact throws NotFrameExactError and is not
 * compared). `capture` compares a PNG the caller already took instead of the page.
 */
export async function compareToBaseline(page: Page, name: string, opts: BaselineStore & { capture?: Buffer } = {}): Promise<BaselineComparison> {
  const m = readBaselineManifest(opts);
  const entry = baselineEntry(m, name);
  if (entry.status !== 'recorded' || !entry.file || !entry.sha256 || !entry.tolerance) throw new Error(`checkpoint "${name}" has no recorded reference image yet (status ${entry.status}); the lead records it`);
  const file = path.join(repoRoot, m.dir, entry.file);
  if (!fs.existsSync(file)) throw new Error(`reference image ${path.relative(repoRoot, file)} is missing (data/baselines is not in git: it is restored from the lead's recording, never re-recorded by a package)`);
  const reference = fs.readFileSync(file);
  if (sha256(reference) !== entry.sha256) throw new Error(`reference image ${path.relative(repoRoot, file)} is not the recorded one (sha256 ${sha256(reference).slice(0, 16)}, manifest ${entry.sha256.slice(0, 16)})`);
  const taken = opts.capture ? null : await captureReference(page, entry.frames, `checkpoint "${name}"`);
  const actual = opts.capture ?? taken!.image;
  const d = imageDifference(reference, actual);
  // An exact checkpoint (its recording's loads were one picture) must not move a pixel; the others are held to their tolerance.
  const exact = entry.exact === true;
  const pass = exact ? d.maxAbs === 0 : d.meanAbs <= entry.tolerance.meanAbs && d.p999 <= entry.tolerance.p999;
  const now = tileSnapshot();
  const then = entry.recorded?.tiles ?? {};
  const dataChanged = Object.keys({ ...then, ...now })
    .sort()
    .filter((k) => then[k] !== now[k])
    .map((k) => `${k} ${then[k] ?? 'absent'} -> ${now[k] ?? 'absent'}`);
  const env = await environmentOf(page);
  const environmentChanged: string[] = [];
  if (entry.recorded && entry.recorded.chrome !== env.chrome) environmentChanged.push(`chrome ${entry.recorded.chrome} -> ${env.chrome}`);
  if (entry.recorded && entry.recorded.adapter !== env.adapter) environmentChanged.push(`adapter ${entry.recorded.adapter} -> ${env.adapter}`);
  let actualFile: string | null = null;
  let diffFile: string | null = null;
  if (!pass) {
    const dir = path.join(repoRoot, 'out', 'screens', 'baselines');
    fs.mkdirSync(dir, { recursive: true });
    actualFile = path.join(dir, `${name}.actual.png`);
    diffFile = path.join(dir, `${name}.diff.png`);
    fs.writeFileSync(actualFile, actual);
    fs.writeFileSync(diffFile, d.diff);
  }
  return { name, meanAbs: d.meanAbs, p999: d.p999, maxAbs: d.maxAbs, differingFraction: d.differingFraction, width: d.width, height: d.height, tolerance: entry.tolerance, exact, pass, dataChanged, environmentChanged, actualFile, diffFile, leadIn: taken?.leadIn ?? null };
}

/** One line for logs and failure messages. */
export function describeComparison(c: BaselineComparison): string {
  return (
    (c.exact
      ? `${c.name}: EXACT (no pixel may differ): ${Math.round(c.differingFraction * c.width * c.height)} pixels differ, by up to ${c.maxAbs} level(s) (mean |diff| ${c.meanAbs.toFixed(4)}, 99.9th percentile ${c.p999})`
      : `${c.name}: mean |diff| ${c.meanAbs.toFixed(4)} (tolerance ${c.tolerance.meanAbs.toFixed(4)}), 99.9th percentile ${c.p999} (tolerance ${c.tolerance.p999}), ` +
        `max ${c.maxAbs}, ${(c.differingFraction * 100).toFixed(3)} % of pixels differ`) +
    (c.dataChanged.length > 0 ? `; SITE DATA CHANGED since the recording: ${c.dataChanged.join(', ')}` : '') +
    (c.environmentChanged.length > 0 ? `; ENVIRONMENT CHANGED since the recording: ${c.environmentChanged.join(', ')}` : '') +
    (c.leadIn && !c.leadIn.identical ? `; the discarded lead-in capture differed in ${c.leadIn.differingPixels} pixels (request core-7)` : '') +
    (c.actualFile ? `; see ${path.relative(repoRoot, c.actualFile)} and ${path.relative(repoRoot, c.diffFile!)}` : '')
  );
}

/** compareToBaseline as an assertion: fails with the numbers, the files to look at, and a note when the site data differs. */
export async function expectBaseline(page: Page, name: string, opts: BaselineStore & { capture?: Buffer } = {}): Promise<BaselineComparison> {
  const c = await compareToBaseline(page, name, opts);
  if (!c.pass) throw new Error(`reference image differs: ${describeComparison(c)}. Re-recording needs a note signed by the lead.`);
  return c;
}

/** Fresh page loads a recording is made from (the tolerance comes from their largest pairwise difference). */
export const BASELINE_LOADS = 3;

/**
 * Record the reference image of checkpoint `name` (THE LEAD'S ACT: `note` is the signed note that goes into
 * the manifest; a package never calls this). `open` navigates the page to the checkpoint in deterministic
 * mode (openCheckpoint); it is called once per load, `loads` times (at least three), each a fresh
 * navigation. Each load is captured under the first-capture rule: a lead-in that is thrown away and two
 * captures that must be identical to the bit; a load that is not frame-exact throws NotFrameExactError and
 * NOTHING is recorded. The first load's capture becomes the reference; the tolerance is three times the
 * largest difference between any two of the loads' captures, at least the manifest's floor.
 */
export async function recordBaseline(
  page: Page,
  name: string,
  open: (page: Page) => Promise<void>,
  opts: BaselineStore & { note: string; loads?: number },
): Promise<{ entry: BaselineCheckpoint; selfDifference: ImageDifference; loads: number; leadInDifferingPixels: number[] }> {
  if (!opts.note || opts.note.trim().length < 8) throw new Error('recordBaseline needs the lead-signed note (who, when, why)');
  const loads = opts.loads ?? BASELINE_LOADS;
  if (loads < BASELINE_LOADS) throw new Error(`a reference image is recorded from at least ${BASELINE_LOADS} loads (asked for ${loads})`);
  const manifestFile = opts.manifestFile ?? BASELINE_MANIFEST_FILE;
  const m = readBaselineManifest(opts);
  const entry = baselineEntry(m, name);
  const problems = manifestProblems({ ...m, checkpoints: { [name]: { ...entry, status: 'pending' } } });
  if (problems.length > 0) throw new Error(`checkpoint "${name}" cannot be recorded as the manifest frames it: ${problems.join('; ')}`);
  const captures: Buffer[] = [];
  const leadInDifferingPixels: number[] = [];
  for (let k = 0; k < loads; k++) {
    if (k > 0) await page.goto('about:blank');
    await open(page);
    const taken = await captureReference(page, entry.frames, `checkpoint "${name}" (load ${k + 1} of ${loads})`);
    captures.push(taken.image);
    leadInDifferingPixels.push(taken.leadIn.differingPixels);
  }
  const first = captures[0]!;
  // The largest difference between any two loads, statistic by statistic.
  let self = imageDifference(first, first);
  for (let a = 0; a < captures.length; a++) {
    for (let b = a + 1; b < captures.length; b++) {
      const d = imageDifference(captures[a]!, captures[b]!);
      self = { ...d, meanAbs: Math.max(self.meanAbs, d.meanAbs), p999: Math.max(self.p999, d.p999), maxAbs: Math.max(self.maxAbs, d.maxAbs), differingFraction: Math.max(self.differingFraction, d.differingFraction) };
    }
  }
  const tolerance: BaselineTolerance = {
    meanAbs: Math.max(m.floor.meanAbs, 3 * self.meanAbs),
    p999: Math.max(m.floor.p999, 3 * self.p999),
  };
  const dir = path.join(repoRoot, m.dir);
  fs.mkdirSync(dir, { recursive: true });
  const file = `${name}.png`;
  fs.writeFileSync(path.join(dir, file), first);
  const env = await environmentOf(page);
  const head = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' });
  // Exact when the loads are one picture; otherwise the entry keeps the lead's reason, or gets an empty one
  // that the manifest's validation rejects until the lead has written it.
  const identical = self.maxAbs === 0;
  const { exact: _wasExact, notExact: reasonBefore, ...kept } = entry;
  void _wasExact;
  const recorded: BaselineCheckpoint = {
    ...kept,
    ...(identical ? { exact: true } : { notExact: reasonBefore ?? { reason: '', request: '' } }),
    status: 'recorded',
    file,
    sha256: sha256(first),
    width: self.width,
    height: self.height,
    tolerance,
    selfDifference: { meanAbs: self.meanAbs, p999: self.p999 },
    loads,
    recorded: {
      at: new Date().toISOString(),
      commit: head.status === 0 ? head.stdout.trim() : 'unknown',
      chrome: env.chrome,
      adapter: env.adapter,
      tiles: tileSnapshot(),
      note: opts.note.trim(),
      leadInDifferingPixels,
    },
  };
  m.checkpoints[name] = recorded;
  fs.writeFileSync(manifestFile, `${JSON.stringify(m, null, 1)}\n`);
  return { entry: recorded, selfDifference: self, loads, leadInDifferingPixels };
}
