/**
 * The frame clock of the browser harness itself (request app-integration-8, lead-owned).
 *
 * Measures the requestAnimationFrame cadence of pages that do almost nothing, in the same Chrome and with the
 * same flags as every other spec, so that a perf spec's rAF numbers can be read against what the harness gives
 * an empty page:
 *
 *   raf      an empty document whose only work is the rAF callback
 *   dom      the same plus one text node rewritten every frame (a HUD-like main-thread commit)
 *   webgpu   a full-viewport WebGPU canvas: one clear pass and a present per frame, no application code
 *
 * Each case records, per frame, the timestamp Chrome hands the callback (the compositor's frame time) and
 * performance.now() at the callback, and reports the distribution of both deltas. The cases run through the
 * project's own `page` fixture (the configuration every spec runs in) and through browsers launched here with
 * variations (viewport, headed, extra flags named in FRAME_CLOCK_VARIANTS), one at a time under the GPU lock.
 *
 *   node tools/dev/heavy.mjs --class=gpu -- npx playwright test tests/browser/shell/frame-clock.perf.spec.ts --project=perf
 *
 * Results: out/qa/frame-clock/<variant>.json and the table printed at the end. The assertion is the harness
 * contract of docs/research/webgpu-harness.md section 3: the harness clock of the default configuration is
 * within HARNESS_CLOCK_TOLERANCE_MS of its nominal period, whatever that period is (see `nominalPeriodMs`).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from '@playwright/test';
import { chromeArgs } from '../chromeArgs';
import { expect, frameClockOf, test, withGpuLock, type FrameClockStats } from '../harness';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const outDir = path.join(repoRoot, 'out', 'qa', 'frame-clock');

type Mode = 'raf' | 'dom' | 'webgpu';

const BARE_ORIGIN = 'http://localhost';

/** The page under test: no application code, no assets, nothing but the measured loop. */
function barePage(): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;height:100%;background:#000;overflow:hidden}
canvas{position:fixed;inset:0;width:100vw;height:100vh;display:block}
#t{position:fixed;left:8px;top:8px;color:#9cf;font:12px monospace}
</style></head><body><canvas id="c"></canvas><div id="t"></div><script>
window.__probe = async (mode, frames, warm) => {
  const cv = document.getElementById('c');
  cv.width = innerWidth; cv.height = innerHeight;
  const label = document.getElementById('t');
  let draw = () => {};
  let adapterInfo = null;
  if (mode === 'webgpu') {
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    const device = await adapter.requestDevice();
    const ctx = cv.getContext('webgpu');
    ctx.configure({ device, format: navigator.gpu.getPreferredCanvasFormat(), alphaMode: 'opaque' });
    adapterInfo = { vendor: adapter.info.vendor, architecture: adapter.info.architecture, description: adapter.info.description };
    let k = 0;
    draw = () => {
      k = (k + 1) % 240;
      const enc = device.createCommandEncoder();
      const pass = enc.beginRenderPass({ colorAttachments: [{ view: ctx.getCurrentTexture().createView(), clearValue: { r: k / 480, g: 0.1, b: 0.2, a: 1 }, loadOp: 'clear', storeOp: 'store' }] });
      pass.end();
      device.queue.submit([enc.finish()]);
    };
  } else if (mode === 'dom') {
    let k = 0;
    draw = () => { label.textContent = 'frame ' + (k++); };
  }
  const frameTime = new Float64Array(frames);
  const callTime = new Float64Array(frames);
  await new Promise((resolve) => {
    let i = -warm;
    const loop = (ts) => {
      draw();
      if (i >= 0) { frameTime[i] = ts; callTime[i] = performance.now(); }
      i++;
      if (i < frames) requestAnimationFrame(loop); else resolve();
    };
    requestAnimationFrame(loop);
  });
  return { frameTime: Array.from(frameTime), callTime: Array.from(callTime), adapterInfo, width: cv.width, height: cv.height, dpr: devicePixelRatio, screen: [screen.width, screen.height], visibility: document.visibilityState };
};
</script></body></html>`;
}

interface CaseResult {
  variant: string;
  mode: Mode;
  viewport: [number, number];
  /** Deltas of the timestamp Chrome passes to the rAF callback (the compositor's frame clock). */
  frame: FrameClockStats;
  /** Deltas of performance.now() at the callback (frame clock plus main-thread scheduling). */
  call: FrameClockStats;
  adapter: string | null;
}

async function measure(page: Page, variant: string, mode: Mode, frames = 480, warm = 90): Promise<CaseResult> {
  await page.route(`${BARE_ORIGIN}/**`, (route) => route.fulfill({ status: 200, contentType: 'text/html', body: barePage() }));
  await page.goto(`${BARE_ORIGIN}/bare-${mode}.html`);
  const raw = await page.evaluate(([m, n, w]) => (window as unknown as { __probe(m: string, n: number, w: number): Promise<{ frameTime: number[]; callTime: number[]; adapterInfo: { vendor: string; description: string } | null; width: number; height: number }> }).__probe(m as string, n as number, w as number), [mode, frames, warm] as const);
  if (mode === 'webgpu' && raw.adapterInfo?.vendor !== (process.env.E2E_GPU_VENDOR ?? 'nvidia')) throw new Error(`frame clock probe: not on the discrete adapter (${JSON.stringify(raw.adapterInfo)})`);
  return {
    variant,
    mode,
    viewport: [raw.width, raw.height],
    frame: frameClockOf(raw.frameTime),
    call: frameClockOf(raw.callTime),
    adapter: raw.adapterInfo ? `${raw.adapterInfo.vendor} ${raw.adapterInfo.description}` : null,
  };
}

function row(r: CaseResult): string {
  const f = (s: FrameClockStats): string => `${s.p50.toFixed(3)} / ${s.p95.toFixed(3)} / ${s.p99.toFixed(3)} / ${s.max.toFixed(2)} (mean ${s.mean.toFixed(3)}, ${s.hz.toFixed(2)} Hz)`;
  return `${r.variant.padEnd(34)} ${r.mode.padEnd(7)} ${`${r.viewport[0]}x${r.viewport[1]}`.padEnd(10)} frame ${f(r.frame)} | call ${f(r.call)}`;
}

/**
 * Launch variations, `name:headed|headless:WxH:flag flag ...`, separated by ';'. The default set answers the
 * request (bare pages at 1280 x 720 and 2560 x 1440 with the harness flags, and the real monitor for
 * comparison); FRAME_CLOCK_VARIANTS replaces it for experiments with other flags.
 */
const DEFAULT_VARIANTS = 'launch-720:headless:1280x720:;launch-1440:headless:2560x1440:;headed-720:headed:1280x720:';

test.describe('frame clock of the harness', () => {
  test('rAF cadence of bare pages: the project fixture and launched variants', async ({ page }) => {
    test.setTimeout(15 * 60_000);
    fs.mkdirSync(outDir, { recursive: true });
    const results: CaseResult[] = [];
    await withGpuLock(async () => {
      // 1. The configuration every spec runs in (playwright.config.ts: 1280 x 720, deviceScaleFactor 1).
      for (const mode of ['raf', 'dom', 'webgpu'] as const) results.push(await measure(page, 'fixture', mode));
      await page.goto('about:blank');

      // 2. Launched variants.
      const variants = (process.env.FRAME_CLOCK_VARIANTS ?? DEFAULT_VARIANTS).split(';').filter((v) => v.trim() !== '');
      for (const spec of variants) {
        const [name, head, size, flags] = spec.split(':');
        const [w, h] = (size ?? '1280x720').split('x').map(Number) as [number, number];
        const extra = (flags ?? '').split(' ').filter((f) => f !== '');
        let browser: Browser | null = null;
        try {
          browser = await chromium.launch({ channel: process.env.E2E_CHANNEL ?? 'chrome', headless: head !== 'headed', args: [...chromeArgs(), ...extra] });
          const context = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
          const p = await context.newPage();
          for (const mode of ['raf', 'webgpu'] as const) results.push(await measure(p, name!, mode));
          await context.close();
        } finally {
          await browser?.close();
        }
      }
    });

    const table = results.map(row).join('\n');
    console.log(`\n[frame clock] rAF delta p50 / p95 / p99 / max, ms\n${table}\n`);
    fs.writeFileSync(path.join(outDir, `${process.env.FRAME_CLOCK_LABEL ?? 'default'}.json`), `${JSON.stringify({ chrome: page.context().browser()?.version(), when: new Date().toISOString(), results }, null, 1)}\n`);

    // The harness contract: the fixture's bare WebGPU page ticks at the harness clock's nominal period with
    // almost no spread. A wider spread means the machine was loaded during the measurement.
    const fixture = results.find((r) => r.variant === 'fixture' && r.mode === 'webgpu')!;
    expect(fixture.frame.p99 - fixture.frame.p50, 'spread of the harness clock (p99 - p50), ms').toBeLessThan(1.5);
  });
});
