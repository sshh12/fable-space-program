/**
 * Live audio in the lab: the context life cycle (created suspended, resumed by a REAL key press, tested
 * without the harness's autoplay flag), asset decoding, live bus meters reacting to throttle and pause,
 * real vehicle parts, a machine without an output device, and no console errors.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { chromeArgs } from '../chromeArgs';
import { assertDiscreteGpu, assertRealImage, expect, expectNoErrors, openPage, saveScreenshot, test } from '../harness';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

// No autoplay flag: the page gets exactly the policy a real user's browser applies.
test.use({ launchOptions: { args: chromeArgs().filter((a) => !a.startsWith('--autoplay-policy')) } });

const probe = (page: Page) => page.evaluate(() => window.__test!.audio()!);
const busRms = async (page: Page, bus: 'engines' | 'master'): Promise<number> => {
  // Lyra-D throttles 10-100 %: lever 0.1 is 19 % thrust, 10 dB below full by the engine law.
  // Average a few analyser windows (each 43 ms) so the number is stable.
  const v: number[] = [];
  for (let i = 0; i < 8; i++) {
    v.push((await probe(page)).buses[bus].rms);
    await page.evaluate(() => window.__test!.waitFrames(3));
  }
  return Math.sqrt(v.reduce((s, x) => s + x * x, 0) / v.length);
};

test('created suspended, resumed by a real key press; meters follow throttle and pause', async ({ page, pageLog }) => {
  await openPage(page, '/labs/audio/?scene=lunarSurface&stack=lander&kind=interior');
  await assertDiscreteGpu(page);
  const p0 = await probe(page);
  expect(p0.state).toBe('suspended');
  expect(p0.assetsTotal).toBe(36);
  expect(p0.assetsLoaded).toBe(p0.assetsTotal);
  expect(p0.sampleRate).toBeGreaterThan(0);

  await page.locator('#viewport').focus();
  await page.keyboard.press('KeyK');
  await page.waitForFunction(() => window.__test!.audio()!.state === 'running');

  await page.evaluate(() => {
    const live = window.__audioLabLive!;
    live.set({ pressure: 0, throttle: 1 });
    live.ignite();
  });
  await page.waitForFunction(() => window.__test!.audio()!.buses.engines.rms > 0.01, undefined, { timeout: 20_000 });
  await page.evaluate(() => window.__test!.waitFrames(60));
  const full = await busRms(page, 'engines');
  await page.evaluate(() => window.__audioLabLive!.set({ throttle: 0.1 }));
  await page.waitForFunction((f) => window.__test!.audio()!.buses.engines.rms < f / 2, full, { timeout: 20_000 });
  await page.evaluate(() => window.__test!.waitFrames(60));
  const low = await busRms(page, 'engines');
  expect(20 * Math.log10(full / low)).toBeGreaterThan(6);

  await page.evaluate(() => window.__audioLabLive!.set({ stack: 'booster', kind: 'external', distance: 120, pressure: 101325, throttle: 1, q: 30000, mach: 1.1 }));
  await page.evaluate(() => window.__audioLabLive!.ignite());
  await page.waitForFunction(() => window.__test!.audio()!.buses.aero.rms > 0.002, undefined, { timeout: 20_000 });
  const shot = await saveScreenshot(page, 'audio', 'lab-live-meters');
  assertRealImage(shot.stats, 'audio lab', { minNonBlack: 0.02, minStd: 5, minBuckets: 20 });

  // Main-thread cost of update() with the booster cluster, aero and cabin voices live (provisional while the bakes run).
  await page.evaluate(() => window.__test!.waitFrames(400));
  const cost = await page.evaluate(() => window.__audioLabLive!.updateCost());
  expect(cost.frames).toBeGreaterThan(300);
  await page.evaluate(() => window.__audioLabLive!.set({ paused: true }));
  await page.waitForFunction(() => window.__test!.audio()!.buses.master.peak === 0, undefined, { timeout: 20_000 });
  const p1 = await probe(page);
  expect(p1.activeVoices).toBeGreaterThan(0);
  fs.mkdirSync(path.join(repoRoot, 'out', 'audio'), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, 'out', 'audio', 'live.json'), JSON.stringify({ before: p0, enginesFullRms: full, enginesLowRms: low, throttleDropDb: 20 * Math.log10(full / low), updateCostMs: cost, paused: p1 }, null, 2));
  await expectNoErrors(page, pageLog);
});

test('real vehicle parts from data/defs/vehicles drive the engine voices', async ({ page, pageLog }) => {
  const vehicles = await (async () => {
    await openPage(page, '/labs/audio/?scene=pad');
    return page.evaluate(() => Object.keys(window.__audioLabLive!.engine.defs!.vehicles));
  })();
  test.skip(vehicles.length === 0, 'no vehicle definitions in data/defs/vehicles yet');
  await page.evaluate((id) => window.__audioLabLive!.set({ stack: `vehicle:${id}`, kind: 'interior', pressure: 101325, throttle: 1 }), vehicles[0]!);
  await page.locator('#viewport').focus();
  await page.keyboard.press('KeyK');
  await page.waitForFunction(() => window.__test!.audio()!.state === 'running');
  await page.evaluate(() => window.__audioLabLive!.ignite());
  await page.waitForFunction(() => window.__test!.audio()!.buses.engines.rms > 0.005, undefined, { timeout: 20_000 });
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
