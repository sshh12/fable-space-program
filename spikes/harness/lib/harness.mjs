// Shared harness helpers: static server on an ephemeral port + browser launch with real-GPU WebGPU.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { PNG } from 'pngjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const OUT = path.join(ROOT, 'out');
fs.mkdirSync(OUT, { recursive: true });

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.wasm': 'application/wasm', '.wgsl': 'text/plain; charset=utf-8', '.bin': 'application/octet-stream' };

/** Static server bound to 127.0.0.1 on port 0 (OS-assigned): concurrent harness instances never collide. */
export function startServer(root = path.join(ROOT, 'page')) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      const file = path.join(root, rel === '/' ? 'index.html' : rel);
      if (!file.startsWith(root)) { res.writeHead(403).end(); return; }
      fs.readFile(file, (err, data) => {
        if (err) { res.writeHead(404).end('not found'); return; }
        res.writeHead(200, {
          'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream',
          'Cache-Control': 'no-store',
          // cross-origin isolation: enables SharedArrayBuffer and 5 us performance.now() resolution
          'Cross-Origin-Opener-Policy': 'same-origin',
          'Cross-Origin-Embedder-Policy': 'require-corp',
        });
        res.end(data);
      });
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ url: `http://127.0.0.1:${port}`, port, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }) });
    });
  });
}

/** Flags for the baseline config. Kept minimal on purpose: see docs/research/webgpu-harness.md. */
export function chromeArgs({ uncapped = false, preciseGpuTimers = true, audio = true, muteAudio = true, extraArgs = [] } = {}) {
  const args = [
    // Never let background/occluded state throttle rAF or timers (headed windows of concurrent agents overlap).
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    '--disable-features=CalculateNativeWinOcclusion',
    // Dual-GPU laptop/desktop: prefer the discrete adapter for everything (compositor + WebGPU default adapter).
    '--force_high_performance_gpu',
  ];
  if (audio) args.push('--autoplay-policy=no-user-gesture-required');
  if (muteAudio) args.push('--mute-audio');
  if (preciseGpuTimers) args.push('--enable-webgpu-developer-features'); // un-quantised timestamp-query
  if (uncapped) args.push('--disable-frame-rate-limit', '--disable-gpu-vsync');
  return [...args, ...extraArgs];
}

/**
 * Launch a browser. Playwright creates a fresh temp user-data-dir per launch() and talks over a pipe
 * (no remote-debugging port), so any number of instances can run concurrently.
 */
export async function launch({ channel = 'chrome', headless = true, width = 1280, height = 720, dpr = 1, args, ...argOpts } = {}) {
  const browser = await chromium.launch({
    channel: channel === 'chromium' ? undefined : channel,
    headless,
    args: args ?? chromeArgs(argOpts),
    // Playwright's default headless args include --mute-audio already; ignoreDefaultArgs could remove it.
  });
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: dpr });
  const page = await context.newPage();
  const consoleLog = [];
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') consoleLog.push(`${m.type()}: ${m.text()}`); });
  page.on('pageerror', (e) => consoleLog.push('pageerror: ' + e.message));
  return { browser, context, page, consoleLog };
}

export async function openScene(page, baseUrl, query = '') {
  await page.goto(`${baseUrl}/index.html${query ? '?' + query : ''}`);
  const ok = await page.evaluate(() => window.__harness.ready);
  const errors = await page.evaluate(() => window.__harness.errors);
  if (!ok || errors.length) throw new Error('scene failed to init: ' + JSON.stringify(errors));
  return page.evaluate(() => ({ adapter: window.__harness.adapter, size: window.__harness.size, scene: window.__harness.scene }));
}

/** Decode a PNG buffer and compute statistics proving it is a real, non-black, non-uniform image. */
export function pngStats(buf) {
  const png = PNG.sync.read(buf);
  const { width, height, data } = png;
  let sum = 0, sumSq = 0, min = 255, max = 0, nonBlack = 0;
  const hist = new Set();
  const n = width * height;
  for (let i = 0; i < data.length; i += 4) {
    const l = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
    sum += l; sumSq += l * l; if (l < min) min = l; if (l > max) max = l; if (l > 8) nonBlack++;
    if ((i & 0xff) === 0) hist.add((data[i] >> 3) << 10 | (data[i + 1] >> 3) << 5 | (data[i + 2] >> 3));
  }
  const mean = sum / n;
  const px = (x, y) => { const o = (y * width + x) * 4; return [data[o], data[o + 1], data[o + 2], data[o + 3]]; };
  return { width, height, meanLuma: +mean.toFixed(2), stdLuma: +Math.sqrt(Math.max(0, sumSq / n - mean * mean)).toFixed(2), minLuma: +min.toFixed(1), maxLuma: +max.toFixed(1), fractionNonBlack: +(nonBlack / n).toFixed(4), distinctColorBuckets: hist.size, center: px(width >> 1, height >> 1), topLeft: px(4, 4) };
}

export function assertRealImage(stats, label = 'image') {
  if (stats.fractionNonBlack < 0.5) throw new Error(`${label}: mostly black (${stats.fractionNonBlack})`);
  if (stats.stdLuma < 10) throw new Error(`${label}: nearly uniform (std ${stats.stdLuma})`);
  if (stats.distinctColorBuckets < 50) throw new Error(`${label}: too few colours (${stats.distinctColorBuckets})`);
}

/** Per-pixel comparison of two PNG buffers; returns max and mean absolute channel difference. */
export function pngDiff(a, b) {
  const A = PNG.sync.read(a), B = PNG.sync.read(b);
  if (A.width !== B.width || A.height !== B.height) return { sameSize: false };
  let max = 0, sum = 0, differing = 0;
  for (let i = 0; i < A.data.length; i++) { const d = Math.abs(A.data[i] - B.data[i]); if (d) { differing++; sum += d; if (d > max) max = d; } }
  return { sameSize: true, maxAbsDiff: max, meanAbsDiff: +(sum / A.data.length).toFixed(5), differingChannels: differing };
}

export async function gpuReport(browser) {
  // chrome://gpu is the ground truth for which adapter the GPU process uses and whether features are hardware accelerated.
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  try {
    await page.goto('chrome://gpu', { waitUntil: 'load' });
    await page.waitForTimeout(1500);
    const text = await page.evaluate(() => {
      const root = document.querySelector('info-view')?.shadowRoot ?? document;
      return (root.querySelector('#content') ?? root.body ?? root).innerText ?? root.textContent;
    });
    return text;
  } catch (e) {
    return 'chrome://gpu unavailable: ' + e.message;
  } finally { await ctx.close(); }
}

export async function commandLine(browser) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  try {
    await page.goto('chrome://version', { waitUntil: 'load' });
    return await page.evaluate(() => ({ cmd: document.querySelector('#command_line')?.textContent, version: document.querySelector('#version')?.textContent, profile: document.querySelector('#profile_path')?.textContent, exe: document.querySelector('#executable_path')?.textContent }));
  } catch (e) { return { error: e.message }; } finally { await ctx.close(); }
}

/**
 * Machine-wide mutex for sections whose numbers depend on having the GPU alone (perf assertions).
 * Uses exclusive file creation in the OS temp dir; a lock whose owner pid is dead is treated as stale.
 */
import os from 'node:os';
export async function withGpuLock(fn, { name = 'fable-gpu-perf', timeoutMs = 10 * 60_000 } = {}) {
  const lock = path.join(os.tmpdir(), `${name}.lock`);
  const t0 = Date.now();
  for (;;) {
    try {
      const fd = fs.openSync(lock, 'wx');
      fs.writeSync(fd, String(process.pid)); fs.closeSync(fd);
      break;
    } catch (e) {
      if (e.code !== 'EEXIST' && e.code !== 'EPERM') throw e;
      let stale = false;
      try { const pid = parseInt(fs.readFileSync(lock, 'utf8'), 10); if (!pid) stale = Date.now() - fs.statSync(lock).mtimeMs > 5000; else process.kill(pid, 0); } catch (k) { stale = k.code === 'ESRCH'; }
      if (stale) { try { fs.unlinkSync(lock); } catch {} continue; }
      if (Date.now() - t0 > timeoutMs) throw new Error('timed out waiting for GPU lock ' + lock);
      await new Promise((r) => setTimeout(r, 100 + Math.random() * 100));
    }
  }
  const waitedMs = Date.now() - t0;
  try { return await fn(waitedMs); } finally { try { fs.unlinkSync(lock); } catch {} }
}
