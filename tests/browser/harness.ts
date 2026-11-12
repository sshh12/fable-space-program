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
 *  - Reference images (ARCHITECTURE 31.3): compare with compareToBaseline / expectBaseline; only the lead
 *    records (recordBaseline).
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
/** A harness clock whose mean period is within this of nominal is the monitor's vertical blank; the sleep-paced fallback is 0.7 ms off. */
export const NOMINAL_CLOCK_TOLERANCE_MS = 0.08;

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
  return Math.abs(clock.mean - NOMINAL_FRAME_MS) <= NOMINAL_CLOCK_TOLERANCE_MS;
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
 * Deterministic mode: the page is opened with frozen presentation time (the labs' `deterministic=1&paused=1`,
 * the app's window.__test.setDeterministic / setPaused), streaming is idle (window.__test.isIdle()), and
 * `frames` further frames have been presented so temporal accumulation has converged. The site data a
 * recording was made on (the tile sets' content hashes) is stored with it: a comparison against other data
 * says so.
 *
 * Difference measure, on 8-bit sRGB values, alpha ignored:
 *   meanAbs  mean over all pixels and the three channels of |a - b|
 *   p999     99.9th percentile over pixels of the largest channel difference of the pixel
 * so that a change of one pixel row of a 720-row image (0.139 % of the pixels) moves p999, and a faint
 * change everywhere moves meanAbs.
 *
 * Tolerance: each checkpoint is recorded twice (two fresh page loads); its tolerance is three times the
 * difference between the two recordings, and never below the manifest's floor.
 */
export interface BaselineTolerance {
  meanAbs: number;
  p999: number;
}

export interface BaselineCheckpoint {
  /** What the checkpoint shows (ARCHITECTURE 31.3). */
  what: string;
  /** Path and query of the page it is captured from, deterministic parameters included; null until the lead frames it. */
  page: string | null;
  /** Frames presented after the page is idle before the capture. */
  frames: number;
  status: 'pending' | 'recorded';
  /** Recorded checkpoints only. */
  file?: string;
  sha256?: string;
  width?: number;
  height?: number;
  tolerance?: BaselineTolerance;
  /** Difference between the two recordings the tolerance was derived from. */
  selfDifference?: BaselineTolerance;
  recorded?: { at: string; commit: string; chrome: string; adapter: string; tiles: Record<string, string>; note: string };
}

export interface BaselineManifest {
  version: 1;
  /** Directory of the PNG files, relative to the repository root. */
  dir: string;
  /** Capture size in CSS pixels at device scale factor 1. */
  viewport: [number, number];
  /** Smallest tolerance a checkpoint may have (two identical recordings would otherwise allow nothing). */
  floor: BaselineTolerance;
  checkpoints: Record<string, BaselineCheckpoint>;
}

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
  pass: boolean;
  /** Tile sets whose content hash differs from the recording's ("earth ab20... -> 77c1..."); empty when the data is the recorded snapshot. */
  dataChanged: string[];
  /** Written when the comparison fails: the capture and a difference image (differences amplified 8x), for looking at. */
  actualFile: string | null;
  diffFile: string | null;
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

/**
 * Bring the page to its deterministic, converged state and take the screenshot. The page must already be
 * open in deterministic mode (see above); this waits for idle streaming and `frames` presented frames.
 */
export async function captureDeterministic(page: Page, frames = 64, timeoutMs = 180_000): Promise<Buffer> {
  await page.waitForFunction(() => window.__test !== undefined && window.__test.isIdle(), undefined, { timeout: timeoutMs });
  await page.evaluate((n) => window.__test!.waitFrames(n), frames);
  // Streaming may have resumed while the frames were presented (a tile finished decoding): settle once more.
  await page.waitForFunction(() => window.__test!.isIdle(), undefined, { timeout: timeoutMs });
  await page.evaluate(() => window.__test!.waitFrames(4));
  return page.screenshot();
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
 * not assert (expectBaseline does). `capture` compares a PNG the caller already took instead of the page.
 */
export async function compareToBaseline(page: Page, name: string, opts: BaselineStore & { capture?: Buffer } = {}): Promise<BaselineComparison> {
  const m = readBaselineManifest(opts);
  const entry = baselineEntry(m, name);
  if (entry.status !== 'recorded' || !entry.file || !entry.sha256 || !entry.tolerance) throw new Error(`checkpoint "${name}" has no recorded reference image yet (status ${entry.status}); the lead records it`);
  const file = path.join(repoRoot, m.dir, entry.file);
  if (!fs.existsSync(file)) throw new Error(`reference image ${path.relative(repoRoot, file)} is missing (data/baselines is not in git: it is restored from the lead's recording, never re-recorded by a package)`);
  const reference = fs.readFileSync(file);
  if (sha256(reference) !== entry.sha256) throw new Error(`reference image ${path.relative(repoRoot, file)} is not the recorded one (sha256 ${sha256(reference).slice(0, 16)}, manifest ${entry.sha256.slice(0, 16)})`);
  const actual = opts.capture ?? (await captureDeterministic(page, entry.frames));
  const d = imageDifference(reference, actual);
  const pass = d.meanAbs <= entry.tolerance.meanAbs && d.p999 <= entry.tolerance.p999;
  const now = tileSnapshot();
  const then = entry.recorded?.tiles ?? {};
  const dataChanged = Object.keys({ ...then, ...now })
    .sort()
    .filter((k) => then[k] !== now[k])
    .map((k) => `${k} ${then[k] ?? 'absent'} -> ${now[k] ?? 'absent'}`);
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
  return { name, meanAbs: d.meanAbs, p999: d.p999, maxAbs: d.maxAbs, differingFraction: d.differingFraction, width: d.width, height: d.height, tolerance: entry.tolerance, pass, dataChanged, actualFile, diffFile };
}

/** One line for logs and failure messages. */
export function describeComparison(c: BaselineComparison): string {
  return (
    `${c.name}: mean |diff| ${c.meanAbs.toFixed(4)} (tolerance ${c.tolerance.meanAbs.toFixed(4)}), 99.9th percentile ${c.p999} (tolerance ${c.tolerance.p999}), ` +
    `max ${c.maxAbs}, ${(c.differingFraction * 100).toFixed(3)} % of pixels differ` +
    (c.dataChanged.length > 0 ? `; SITE DATA CHANGED since the recording: ${c.dataChanged.join(', ')}` : '') +
    (c.actualFile ? `; see ${path.relative(repoRoot, c.actualFile)} and ${path.relative(repoRoot, c.diffFile!)}` : '')
  );
}

/** compareToBaseline as an assertion: fails with the numbers, the files to look at, and a note when the site data differs. */
export async function expectBaseline(page: Page, name: string, opts: BaselineStore & { capture?: Buffer } = {}): Promise<BaselineComparison> {
  const c = await compareToBaseline(page, name, opts);
  if (!c.pass) throw new Error(`reference image differs: ${describeComparison(c)}. Re-recording needs a note signed by the lead.`);
  return c;
}

/**
 * Record the reference image of checkpoint `name` (THE LEAD'S ACT: `note` is the signed note that goes into
 * the manifest; a package never calls this). `open` navigates the page to the checkpoint in deterministic
 * mode; it is called twice, for two fresh loads. The first capture becomes the reference; the tolerance is
 * three times the difference between the two captures, at least the manifest's floor.
 */
export async function recordBaseline(
  page: Page,
  name: string,
  open: (page: Page) => Promise<void>,
  opts: BaselineStore & { note: string },
): Promise<{ entry: BaselineCheckpoint; selfDifference: ImageDifference }> {
  if (!opts.note || opts.note.trim().length < 8) throw new Error('recordBaseline needs the lead-signed note (who, when, why)');
  const manifestFile = opts.manifestFile ?? BASELINE_MANIFEST_FILE;
  const m = readBaselineManifest(opts);
  const entry = baselineEntry(m, name);
  await open(page);
  const first = await captureDeterministic(page, entry.frames);
  await page.goto('about:blank');
  await open(page);
  const second = await captureDeterministic(page, entry.frames);
  const self = imageDifference(first, second);
  const tolerance: BaselineTolerance = {
    meanAbs: Math.max(m.floor.meanAbs, 3 * self.meanAbs),
    p999: Math.max(m.floor.p999, 3 * self.p999),
  };
  const dir = path.join(repoRoot, m.dir);
  fs.mkdirSync(dir, { recursive: true });
  const file = `${name}.png`;
  fs.writeFileSync(path.join(dir, file), first);
  const adapter = await page.evaluate(() => window.__test?.adapter ?? null);
  const head = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' });
  const recorded: BaselineCheckpoint = {
    ...entry,
    status: 'recorded',
    file,
    sha256: sha256(first),
    width: self.width,
    height: self.height,
    tolerance,
    selfDifference: { meanAbs: self.meanAbs, p999: self.p999 },
    recorded: {
      at: new Date().toISOString(),
      commit: head.status === 0 ? head.stdout.trim() : 'unknown',
      chrome: page.context().browser()?.version() ?? 'unknown',
      adapter: adapter ? `${adapter.vendor} ${adapter.description}`.trim() : 'unknown',
      tiles: tileSnapshot(),
      note: opts.note.trim(),
    },
  };
  m.checkpoints[name] = recorded;
  fs.writeFileSync(manifestFile, `${JSON.stringify(m, null, 1)}\n`);
  return { entry: recorded, selfDifference: self };
}
