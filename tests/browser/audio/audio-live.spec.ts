/**
 * Live audio in the lab: the context life cycle (created suspended, resumed by a REAL key press, tested
 * without the harness's autoplay flag), asset decoding, live bus meters reacting to the throttle lever and
 * pause, real vehicle parts (and no voices for engines that do not fire), a machine without an output
 * device, a device that is slow to open, a device that fails and comes back, and no console errors.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { chromeArgs } from '../chromeArgs';
import { assertDiscreteGpu, assertRealImage, expect, expectNoErrors, openPage, saveScreenshot, test } from '../harness';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const outFile = path.join(repoRoot, 'out', 'audio', 'live.json');

/** Merge one test's measurements into out/audio/live.json. */
function record(key: string, value: unknown): void {
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  const all = (fs.existsSync(outFile) ? JSON.parse(fs.readFileSync(outFile, 'utf8')) : {}) as Record<string, unknown>;
  all[key] = value;
  fs.writeFileSync(outFile, JSON.stringify(all, null, 2));
}

// No autoplay flag: the page gets exactly the policy a real user's browser applies.
test.use({ launchOptions: { args: chromeArgs().filter((a) => !a.startsWith('--autoplay-policy')) } });

const probe = (page: Page) => page.evaluate(() => window.__test!.audio()!);
const busRms = async (page: Page, bus: 'engines' | 'master'): Promise<number> => {
  // Average a few analyser windows (each 43 ms) so the number is stable.
  const v: number[] = [];
  for (let i = 0; i < 12; i++) {
    v.push((await probe(page)).buses[bus].rms);
    await page.evaluate(() => window.__test!.waitFrames(3));
  }
  return Math.sqrt(v.reduce((s, x) => s + x * x, 0) / v.length);
};

/** Engine bus level at lever 1 and lever 0.1 (each settled), dB difference. */
async function leverDrop(page: Page): Promise<{ full: number; low: number; dropDb: number }> {
  await page.evaluate(() => window.__audioLabLive!.set({ throttle: 1 }));
  await page.evaluate(() => window.__test!.waitFrames(150));
  const full = await busRms(page, 'engines');
  await page.evaluate(() => window.__audioLabLive!.set({ throttle: 0.1 }));
  await page.waitForFunction((f) => window.__test!.audio()!.buses.engines.rms < f / 2, full, { timeout: 20_000 });
  await page.evaluate(() => window.__test!.waitFrames(150));
  const low = await busRms(page, 'engines');
  return { full, low, dropDb: 20 * Math.log10(full / low) };
}

test('created suspended, resumed by a real key press; meters follow the throttle lever and pause', async ({ page, pageLog }) => {
  await openPage(page, '/labs/audio/?scene=lunarSurface&stack=lander&kind=interior');
  await assertDiscreteGpu(page);
  const p0 = await probe(page);
  expect(p0.state).toBe('suspended');
  expect(p0.assetsTotal).toBe(38);
  expect(p0.assetsLoaded).toBe(p0.assetsTotal);
  expect(p0.sampleRate).toBeGreaterThan(0);

  await page.locator('#viewport').focus();
  await page.keyboard.press('KeyK');
  await page.waitForFunction(() => window.__test!.audio()!.state === 'running');

  // Lyra-D (real part, minThrottle 0.1) heard from the cabin in vacuum: structure-borne only.
  await page.evaluate(() => {
    const live = window.__audioLabLive!;
    live.set({ pressure: 0, throttle: 1 });
    live.ignite();
  });
  await page.waitForFunction(() => window.__test!.audio()!.buses.engines.rms > 0.01, undefined, { timeout: 20_000 });
  const lander = await leverDrop(page);

  // Atlas-9M cluster (real part, minThrottle 0.5: lever 0.1 is 55 % thrust) heard outside at sea level.
  await page.evaluate(() => window.__audioLabLive!.set({ scene: 'pad', stack: 'booster', kind: 'external', distance: 120, pressure: 101325, throttle: 1, q: 0, mach: 0 }));
  await page.evaluate(() => window.__audioLabLive!.ignite());
  await page.waitForFunction(() => window.__test!.audio()!.buses.engines.rms > 0.01, undefined, { timeout: 20_000 });
  const booster = await leverDrop(page);
  expect(lander.dropDb, 'Lyra-D lever 100 % -> 10 %').toBeGreaterThanOrEqual(12);
  expect(booster.dropDb, 'Atlas-9M cluster lever 100 % -> 10 %').toBeGreaterThanOrEqual(12);

  await page.evaluate(() => window.__audioLabLive!.set({ throttle: 1, q: 30000, mach: 0.9 }));
  await page.waitForFunction(() => window.__test!.audio()!.buses.aero.rms > 0.002, undefined, { timeout: 20_000 });
  const shot = await saveScreenshot(page, 'audio', 'lab-live-meters');
  assertRealImage(shot.stats, 'audio lab', { minNonBlack: 0.02, minStd: 5, minBuckets: 20 });

  // Main-thread cost of update() with the booster cluster, aero and ambience live (provisional while the bakes run).
  await page.evaluate(() => window.__test!.waitFrames(400));
  const cost = await page.evaluate(() => window.__audioLabLive!.updateCost());
  expect(cost.frames).toBeGreaterThan(300);
  const stats = await page.evaluate(() => window.__audioLabLive!.engine.stats());
  await page.evaluate(() => window.__audioLabLive!.set({ paused: true }));
  await page.waitForFunction(() => window.__test!.audio()!.buses.master.peak === 0, undefined, { timeout: 20_000 });
  const p1 = await probe(page);
  expect(p1.activeVoices).toBeGreaterThan(0);
  record('lifecycle', { before: p0, lander, booster, updateCostMs: cost, stats, paused: p1 });
  await expectNoErrors(page, pageLog);
});

test('real vehicle parts drive the engine voices; engines that do not fire get no voice', async ({ page, pageLog }) => {
  const vehicles = await (async () => {
    await openPage(page, '/labs/audio/?scene=pad');
    return page.evaluate(() => Object.keys(window.__audioLabLive!.engine.defs!.vehicles));
  })();
  test.skip(vehicles.length === 0, 'no vehicle definitions in data/defs/vehicles yet');
  await page.evaluate((id) => window.__audioLabLive!.set({ stack: `vehicle:${id}`, kind: 'interior', pressure: 101325, throttle: 1 }), vehicles[0]!);
  await page.locator('#viewport').focus();
  await page.keyboard.press('KeyK');
  await page.waitForFunction(() => window.__test!.audio()!.state === 'running');
  await page.evaluate(() => window.__test!.waitFrames(30));
  const idle = await page.evaluate(() => window.__audioLabLive!.engine.stats()!);
  expect(idle.engineVoices, 'voices on the pad before ignition').toBe(0);
  // The clusters that can still fire stand by with their nodes built (data/defs/audio/engines.json standbyVoices),
  // playing nothing: no voice is counted as active.
  expect(idle.standbyVoices, 'voices built ahead on the pad').toBeGreaterThan(0);
  expect(idle.delayLines).toBe(2 + idle.standbyVoices);
  await page.evaluate(() => window.__audioLabLive!.resetUpdateCost());
  await page.evaluate(() => window.__audioLabLive!.ignite());
  await page.waitForFunction(() => window.__test!.audio()!.buses.engines.rms > 0.005, undefined, { timeout: 20_000 });
  await page.evaluate(() => window.__test!.waitFrames(60));
  const lit = await page.evaluate(() => window.__audioLabLive!.engine.stats()!);
  const ignitionCostMs = await page.evaluate(() => window.__audioLabLive!.updateCost());
  // ignite() lights every throttleable engine of the vehicle: one voice per firing (vessel, profile) cluster.
  expect(lit.engineVoices).toBeGreaterThan(0);
  expect(lit.engineVoices).toBeLessThanOrEqual(4);
  // Every one of them stood by: the ignition made no voice (request app-integration-13; the cost of the
  // frames around it is recorded, 0.44 ms of a voice's millisecond is its delay line).
  expect(lit.engineVoices + lit.standbyVoices, 'voices sounding + still standing by').toBe(idle.standbyVoices);
  expect(lit.delayLines, 'delay lines after the ignition').toBe(idle.delayLines);
  record('vehicle', { vehicle: vehicles[0], idle, lit, ignitionCostMs });
  await expectNoErrors(page, pageLog);
});

test('a machine without an audio output device still initialises and renders', async ({ page, pageLog }) => {
  await page.addInitScript(() => {
    const Real = window.AudioContext;
    class NoDevice extends Real {
      constructor(opts?: AudioContextOptions & { sinkId?: unknown }) {
        const sink = opts?.sinkId as { type?: string } | undefined;
        if (sink?.type !== 'none') throw new DOMException('No audio output device', 'NotSupportedError');
        super(opts);
      }
    }
    window.AudioContext = NoDevice as unknown as typeof AudioContext;
  });
  await openPage(page, '/labs/audio/?scene=pad');
  const status = await page.evaluate(() => window.__audioLabLive!.engine.status);
  expect(status.output).toBe('none');
  const p = await probe(page);
  expect(p.assetsLoaded).toBe(p.assetsTotal);
  await page.locator('#viewport').focus();
  await page.keyboard.press('KeyK');
  await page.waitForFunction(() => window.__test!.audio()!.state === 'running');
  await page.evaluate(() => {
    window.__audioLabLive!.set({ distance: 80, throttle: 1 });
    window.__audioLabLive!.ignite();
  });
  await page.waitForFunction(() => window.__test!.audio()!.buses.engines.rms > 0.01, undefined, { timeout: 20_000 });
  await expectNoErrors(page, pageLog);
});

test('a device that is slow to open is waited for, not abandoned', async ({ page, pageLog }) => {
  // The first resume() takes 4.5 s to settle (a Bluetooth headset waking up).
  await page.addInitScript(() => {
    const real = AudioContext.prototype.resume;
    let first = true;
    AudioContext.prototype.resume = function (this: AudioContext): Promise<void> {
      if (!first) return real.call(this);
      first = false;
      return new Promise<void>((r) => setTimeout(r, 4500)).then(() => real.call(this));
    };
  });
  await openPage(page, '/labs/audio/?scene=pad');
  await page.locator('#viewport').focus();
  await page.keyboard.press('KeyK');
  await page.waitForFunction(() => window.__audioLabLive!.engine.status.message !== null, undefined, { timeout: 10_000 });
  const waiting = await page.evaluate(() => ({ ...window.__audioLabLive!.engine.status, state: window.__test!.audio()!.state }));
  expect(waiting.output).toBe('device');
  expect(waiting.state).not.toBe('running');
  await page.waitForFunction(() => window.__test!.audio()!.state === 'running', undefined, { timeout: 20_000 });
  const after = await page.evaluate(() => window.__audioLabLive!.engine.status);
  expect(after).toEqual({ output: 'device', message: null });
  record('slowDevice', { waiting, after });
  await expectNoErrors(page, pageLog);
});

test('a device error falls back to the null sink and the device comes back on the next gesture', async ({ page, pageLog }) => {
  await openPage(page, '/labs/audio/?scene=pad');
  await page.locator('#viewport').focus();
  await page.keyboard.press('KeyK');
  await page.waitForFunction(() => window.__test!.audio()!.state === 'running');
  await page.evaluate(() => window.__audioLabLive!.engine.context!.dispatchEvent(new Event('error')));
  await page.waitForFunction(() => window.__audioLabLive!.engine.status.output === 'none', undefined, { timeout: 10_000 });
  const fallback = await page.evaluate(() => ({ ...window.__audioLabLive!.engine.status }));
  // Still rendering on the null sink.
  await page.evaluate(() => {
    window.__audioLabLive!.set({ distance: 80, throttle: 1 });
    window.__audioLabLive!.ignite();
  });
  await page.waitForFunction(() => window.__test!.audio()!.buses.engines.rms > 0.01, undefined, { timeout: 20_000 });
  await page.keyboard.press('KeyK');
  await page.waitForFunction(() => window.__audioLabLive!.engine.status.output === 'device', undefined, { timeout: 10_000 });
  const back = await page.evaluate(() => ({ ...window.__audioLabLive!.engine.status, state: window.__test!.audio()!.state }));
  expect(back.state).toBe('running');
  record('deviceError', { fallback, back });
  await expectNoErrors(page, pageLog);
});
