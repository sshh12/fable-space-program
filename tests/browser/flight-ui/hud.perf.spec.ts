import type { CDPSession, Page } from '@playwright/test';
import { assertDiscreteGpu, expect, expectNoErrors, openPage, test, withGpuLock } from '../harness';

/**
 * Budgets of the flight-ui package, measured under the machine-wide GPU lock:
 *  - HUD main-thread cost under 0.5 ms per frame on average (ARCHITECTURE 17: UI <= 0.5 ms). This is the
 *    WHOLE cost the HUD puts on the renderer's main thread: its JavaScript (update, navball encode + submit)
 *    plus the style recalculation, layout, paint and canvas commit its DOM changes cause. It is measured with
 *    the Chrome DevTools Protocol's Performance metrics (main-thread CPU time of every task), A/B against the
 *    same page with the HUD hidden (F2): cost = TaskDuration(visible) - TaskDuration(hidden) per frame, plus
 *    the hidden HUD's own update (it still renders the shared navball texture for the cockpit). Two scenes:
 *    a coast in low orbit with a planned node, and a powered atmospheric ascent at full throttle (more panels,
 *    every readout moving).
 *  - navball GPU time (ARCHITECTURE 17.1) under 0.05 ms p99 for the shared 512 x 512 texture ('ui.navball');
 *    the HUD's native-resolution copy ('ui.navball.hud') is reported alongside.
 *
 * Method for GPU time (docs/handoff/render-core.md 4.1): an RTX-class GPU that only has this lab's fraction of a
 * millisecond of work per frame drops into a low clock state, and a 0.01 ms pass then reads several times
 * slower with a p99 that jumps from run to run (measured on this machine: navball idle p99 0.025 to 0.077 ms
 * from run to run, 0.008 ms with the ballast; p50 0.014 idle against 0.0065 ms with the ballast). The
 * budget is for the game's frame, so everything is measured with the lab's ballast pass (labs/flight-ui/
 * ballast.ts, calibrated to about 7 ms per frame while it runs) submitted before the navball; the idle-GPU
 * numbers are logged for the record.
 */
test.use({ viewport: { width: 2560, height: 1440 } });

type Metrics = Record<string, number>;

/** GPU ballast per frame while measuring (ms): the game's frame keeps the GPU busy for 9-11 ms. */
const BALLAST_MS = 7;

async function metrics(cdp: CDPSession): Promise<Metrics> {
  const r = await cdp.send('Performance.getMetrics');
  return Object.fromEntries(r.metrics.map((m) => [m.name, m.value]));
}

interface Window_ {
  visible: boolean;
  frames: number;
  /** Main-thread time per frame (ms) without DevTools command handling. */
  taskMs: number;
  layoutMs: number;
  styleMs: number;
  scriptMs: number;
  layoutsPerFrame: number;
  /** Mean in-update HUD time over the window (hud.lastUpdateMs). */
  hudUpdateMs: number;
  textUpdatesPerFrame: number;
}

async function measureWindow(page: Page, cdp: CDPSession, visible: boolean, frames: number): Promise<Window_> {
  await page.evaluate((v) => window.__flightUi!.setHudVisible(v), visible);
  await page.evaluate(() => window.__test!.waitFrames(30));
  const start = await page.evaluate(() => ({ f: window.__flightUi!.frameCount(), t: performance.now(), text: window.__flightUi!.hudTiming().textUpdates }));
  const m0 = await metrics(cdp);
  await page.evaluate((n) => window.__test!.waitFrames(n), frames);
  const m1 = await metrics(cdp);
  const end = await page.evaluate((t0) => {
    const log = window.__flightUi!.frames().filter((f) => f.t > t0);
    return { f: window.__flightUi!.frameCount(), text: window.__flightUi!.hudTiming().textUpdates, hud: log.reduce((a, f) => a + f.hudMs, 0) / Math.max(1, log.length) };
  }, start.t);
  const n = end.f - start.f;
  const d = (k: string): number => ((m1[k] ?? 0) - (m0[k] ?? 0)) * 1000;
  return {
    visible,
    frames: n,
    taskMs: (d('TaskDuration') - d('DevToolsCommandDuration')) / n,
    layoutMs: d('LayoutDuration') / n,
    styleMs: d('RecalcStyleDuration') / n,
    scriptMs: d('ScriptDuration') / n,
    layoutsPerFrame: ((m1['LayoutCount'] ?? 0) - (m0['LayoutCount'] ?? 0)) / n,
    hudUpdateMs: end.hud,
    textUpdatesPerFrame: (end.text - start.text) / n,
  };
}

const median = (xs: number[]): number => {
  const s = xs.slice().sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2;
};
const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
const stats = (xs: number[]) => {
  const s = xs.slice().sort((a, b) => a - b);
  return { n: s.length, mean: mean(s), p50: s[Math.floor(s.length * 0.5)] ?? NaN, p99: s[Math.floor(s.length * 0.99)] ?? NaN };
};

interface SceneResult {
  scene: string;
  windows: Window_[];
  hud: {
    mainThreadMs: number;
    visibleMinusHiddenMs: number;
    layoutMs: number;
    scriptMs: number;
    layoutsPerFrame: number;
    inUpdateMs: number;
    hiddenUpdateMs: number;
    textUpdatesPerFrame: number;
  };
  /** With the ballast running (asserted). */
  navball: ReturnType<typeof stats>;
  navballHud: ReturnType<typeof stats>;
  ballast: ReturnType<typeof stats>;
  ballastTail: ReturnType<typeof stats>;
  /** With an otherwise idle GPU (logged only). */
  idleNavball: ReturnType<typeof stats>;
  idleNavballHud: ReturnType<typeof stats>;
}

async function measureScene(page: Page, query: string, throttle: number): Promise<SceneResult & { timeDomain: string }> {
  await openPage(page, `/labs/flight-ui/?${query}`);
  await assertDiscreteGpu(page);
  if (throttle > 0) await page.evaluate((t) => window.__test!.setControls({ throttle: t }), throttle);
  const cdp = await page.context().newCDPSession(page);
  // Thread CPU time where supported: other processes on the machine do not inflate it.
  let timeDomain = 'threadTicks';
  try {
    await cdp.send('Performance.enable', { timeDomain: 'threadTicks' });
  } catch {
    timeDomain = 'timeTicks';
    await cdp.send('Performance.enable');
  }
  // Warm-up, with values changing every frame.
  await page.evaluate(() => window.__test!.waitFrames(120));
  // (1) Navball GPU time with an otherwise idle GPU: for the record only (low clock state, see the header).
  const idleGpu = await page.evaluate(async () => {
    window.__flightUi!.resetTimes();
    await window.__test!.waitFrames(600);
    return window.__flightUi!.gpuTimes();
  });
  // (2) Calibrate the ballast to about 7 ms per frame while it runs, then measure everything with it.
  const perIteration = await page.evaluate(async () => {
    window.__flightUi!.setBallast(400);
    await window.__test!.waitFrames(90);
    window.__flightUi!.resetTimes();
    await window.__test!.waitFrames(60);
    const xs = (window.__flightUi!.gpuTimes()['lab.ballast'] ?? []).slice().sort((a, b) => a - b);
    return (xs[Math.floor(xs.length / 2)] ?? 0) / 400;
  });
  expect(perIteration).toBeGreaterThan(0);
  await page.evaluate((n) => window.__flightUi!.setBallast(n), Math.round(BALLAST_MS / perIteration));
  await page.evaluate(() => window.__test!.waitFrames(60));
  await page.evaluate(() => window.__flightUi!.resetTimes());
  const windows: Window_[] = [];
  for (let round = 0; round < 5; round++) {
    // Alternate the order so a slow drift of the machine load does not bias one side.
    const order = round % 2 === 0 ? [true, false] : [false, true];
    for (const visible of order) windows.push(await measureWindow(page, cdp, visible, 240));
  }
  await page.evaluate(() => window.__flightUi!.setHudVisible(true));
  await cdp.detach();
  const gpu = await page.evaluate(() => window.__flightUi!.gpuTimes());
  await page.evaluate(() => window.__flightUi!.setBallast(0));
  const vis = windows.filter((w) => w.visible);
  const hid = windows.filter((w) => !w.visible);
  const delta = (k: keyof Window_): number => median(vis.map((w) => w[k] as number)) - median(hid.map((w) => w[k] as number));
  return {
    scene: query,
    timeDomain,
    windows,
    hud: {
      // The hidden HUD still updates (navball texture for the cockpit, toasts); add its own time back.
      mainThreadMs: delta('taskMs') + mean(hid.map((w) => w.hudUpdateMs)),
      visibleMinusHiddenMs: delta('taskMs'),
      layoutMs: delta('layoutMs'),
      scriptMs: delta('scriptMs'),
      layoutsPerFrame: median(vis.map((w) => w.layoutsPerFrame)),
      inUpdateMs: mean(vis.map((w) => w.hudUpdateMs)),
      hiddenUpdateMs: mean(hid.map((w) => w.hudUpdateMs)),
      textUpdatesPerFrame: median(vis.map((w) => w.textUpdatesPerFrame)),
    },
    navball: stats(gpu['ui.navball'] ?? []),
    navballHud: stats(gpu['ui.navball.hud'] ?? []),
    ballast: stats(gpu['lab.ballast'] ?? []),
    ballastTail: stats(gpu['lab.ballast.tail'] ?? []),
    idleNavball: stats(idleGpu['ui.navball'] ?? []),
    idleNavballHud: stats(idleGpu['ui.navball.hud'] ?? []),
  };
}

test('HUD main-thread cost and navball GPU time', async ({ page, pageLog }) => {
  // withGpuLock waits up to 20 minutes while other packages measure; the two scenes take about 3 minutes.
  test.setTimeout(25 * 60_000);
  const results = await withGpuLock(async () => {
    const out: (SceneResult & { timeDomain: string })[] = [];
    for (const [query, throttle] of [
      ['scene=lowOrbit&node=1', 0],
      ['scene=ascent', 1],
    ] as const) {
      out.push(await measureScene(page, query, throttle));
      await expectNoErrors(page, pageLog);
    }
    return out;
  });
  const r3 = (x: number): string => x.toFixed(3);
  for (const r of results) {
    console.log(`--- ${r.scene}`);
    for (const w of r.windows) {
      console.log(`  ${w.visible ? 'visible' : 'hidden '} frames ${w.frames}: task ${r3(w.taskMs)} layout ${r3(w.layoutMs)} script ${r3(w.scriptMs)} layouts/frame ${w.layoutsPerFrame.toFixed(2)} hud.update ${r3(w.hudUpdateMs)} text/frame ${w.textUpdatesPerFrame.toFixed(2)}`);
    }
    console.log(`HUD main-thread ms per frame (${r.timeDomain}): ${JSON.stringify(r.hud)}`);
    console.log(`ballast GPU ms: ${JSON.stringify(r.ballast)}; its empty tail pass: ${JSON.stringify(r.ballastTail)}`);
    console.log(`navball 512 GPU ms (with ballast): ${JSON.stringify(r.navball)}`);
    console.log(`navball HUD canvas GPU ms (with ballast): ${JSON.stringify(r.navballHud)}`);
    console.log(`idle GPU, for the record: navball 512 ${JSON.stringify(r.idleNavball)}; HUD canvas ${JSON.stringify(r.idleNavballHud)}`);
  }
  for (const r of results) {
    expect(r.windows.every((w) => w.frames > 200)).toBe(true);
    expect(r.hud.mainThreadMs, r.scene).toBeLessThan(0.5);
    expect(r.hud.inUpdateMs, r.scene).toBeLessThan(0.5);
    expect(r.ballast.p50, r.scene).toBeGreaterThan(5);
    expect(r.navball.n).toBeGreaterThan(50);
    expect(r.navball.p99, r.scene).toBeLessThan(0.05);
  }
});

test('MFD ORB page: every paint bounded while the orbit changes (request cockpit-17)', async ({ page, pageLog }) => {
  // The page at 1024 x 768 with the albedo and cloud maps, its orbit's periapsis swinging and its plane tilting on
  // every paint, so the body graphic is always being re-shaded: the app painter's default budget spreads it.
  test.setTimeout(25 * 60_000);
  const times = await withGpuLock(async () => {
    await openPage(page, '/labs/flight-ui/?scene=lunarOrbit&mfd=1');
    await assertDiscreteGpu(page);
    await page.evaluate(() => window.__test!.waitFrames(10));
    // (Warm-up paints first: the page's chrome and the first graphic.)
    await page.evaluate(() => window.__flightUi!.orbPaintMs(40));
    const t = await page.evaluate(() => window.__flightUi!.orbPaintMs(240));
    await expectNoErrors(page, pageLog);
    return t;
  });
  const sorted = [...times].sort((a, b) => a - b);
  const q = (p: number): number => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!;
  const mean = times.reduce((a, b) => a + b, 0) / times.length;
  console.log(`ORB page paint ms while the orbit changes: mean ${mean.toFixed(3)} p50 ${q(0.5).toFixed(3)} p99 ${q(0.99).toFixed(3)} max ${sorted[sorted.length - 1]!.toFixed(3)} (n ${times.length})`);
  expect(q(0.99)).toBeLessThan(1.5);
  expect(mean).toBeLessThan(1);
});
