/**
 * The game in real Chrome on the discrete GPU: the app shell (src/app) with the real simulation, every render
 * feature, the HUD, the map view, the cameras and audio, driven through the keyboard bindings and window.__test.
 *
 *   node tools/dev/heavy.mjs --class=gpu -- npx playwright test tests/browser/app --project=functional
 *
 * Screenshots: out/screens/app/ (every one is looked at; see docs/handoff/app-integration-v1.md). The game starts
 * windowed and uncaptured (the viewport stays 1280 x 720); `window.__test.ready` resolves when the loading screen
 * has gone, i.e. when the view at the start position is final.
 */
import { PNG } from 'pngjs';
import type { Page } from '@playwright/test';
import type { LoadingReport } from '../../../src/app/loading';
import type { AppBrief } from '../../../src/app/testHooks';
import { appUrl, assertDiscreteGpu, assertRealImage, expect, expectNoErrors, openPage, pngDiff, saveScreenshot, test, waitIdle } from '../harness';

test.setTimeout(12 * 60_000);

const BOOT_MS = 240_000;

async function shoot(page: Page, name: string, opts: { minNonBlack?: number; minStd?: number; minBuckets?: number } = {}): Promise<void> {
  const shot = await saveScreenshot(page, 'app', name);
  assertRealImage(shot.stats, name, opts);
}

const brief = (page: Page): Promise<AppBrief> => page.evaluate(() => window.__app!.brief());

/** Wait until a predicate over the brief holds (polled every 100 ms in the page). */
async function until(page: Page, predicate: string, timeout = 60_000): Promise<AppBrief> {
  await page.waitForFunction(`(() => { const b = window.__app.brief(); return ${predicate}; })()`, undefined, { polling: 100, timeout });
  return brief(page);
}

async function press(page: Page, code: string): Promise<void> {
  await page.keyboard.press(code);
  await page.evaluate(() => window.__test!.waitFrames(2));
}

/** Switch views with the keys and wait until the blend has finished on the wanted camera kind. */
async function viewKey(page: Page, code: string, kind: string): Promise<void> {
  await press(page, code);
  await page.waitForFunction((k) => !window.__app!.viewBlending() && window.__app!.brief().cameraKind === k, kind, { polling: 100, timeout: 10_000 });
  await page.evaluate(() => window.__test!.waitFrames(10));
}

/**
 * Open the game and wait for `ready` (the loading screen gone). A boot that does not finish in time fails with
 * what the loading screen was waiting for, instead of running into the test's timeout.
 */
async function openWithin(page: Page, pathAndQuery: string, timeoutMs: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      page
        .evaluate(() => window.__boot?.().steps.map((x) => `${x.id} ${x.state}${x.done !== null ? ` ${x.done}/${x.total}` : ''} ${x.detail}`))
        .then(
          (steps) => reject(new Error(`the game was not ready after ${timeoutMs / 1000} s; loading screen: ${JSON.stringify(steps)}`)),
          () => reject(new Error(`the game was not ready after ${timeoutMs / 1000} s (page not responding)`)),
        );
    }, timeoutMs);
  });
  try {
    await Promise.race([openPage(page, pathAndQuery, { timeoutMs }), late]);
  } finally {
    clearTimeout(timer);
  }
}

async function openGame(page: Page, query = ''): Promise<void> {
  await openWithin(page, `/${query}`, BOOT_MS);
  await assertDiscreteGpu(page);
}

/**
 * Share of blue-dominant pixels (open water under a daylight sky) in the band of the pad view between the horizon
 * and the site, left and right of the stack and the tower: lava plain and scrub there, never sea.
 */
function seaShare(png: Buffer): number {
  const img = PNG.sync.read(png);
  let sea = 0;
  let n = 0;
  for (const [x0, x1] of [
    [0.3, 0.45],
    [0.69, 0.98],
  ] as const) {
    for (let y = Math.floor(0.36 * img.height); y < Math.floor(0.5 * img.height); y++) {
      for (let x = Math.floor(x0 * img.width); x < Math.floor(x1 * img.width); x++) {
        const i = (y * img.width + x) * 4;
        if (img.data[i + 2]! > img.data[i]! + 8) sea++;
        n++;
      }
    }
  }
  return sea / n;
}

test('the loading screen shows real progress and stays until the view at the pad is final; the first frame has land', async ({ page, pageLog }) => {
  test.setTimeout(15 * 60_000);
  // No HUD: the pictures of the revealed view are compared pixel by pixel.
  await page.goto(appUrl('/?hud=0'));
  await page.waitForFunction(() => window.__boot !== undefined, undefined, { timeout: 60_000 });

  interface Sample {
    boot: LoadingReport;
    overlay: { opacity: number; covers: boolean } | null;
    /** Once the game exists: what the renderer and the terrain say at the same instant. */
    game: { idle: boolean; busy: string[]; stream: Record<string, number>; audio: { loaded: number; total: number }; ut: number; frames: number } | null;
  }
  const sample = (): Promise<Sample> =>
    page.evaluate(() => {
      const el = document.querySelector('[data-app-loading]');
      const r = el?.getBoundingClientRect();
      const app = window.__app;
      const audio = window.__test!.audio();
      return {
        boot: window.__boot!(),
        overlay: el && r ? { opacity: Number(getComputedStyle(el).opacity), covers: r.left <= 0 && r.top <= 0 && r.right >= innerWidth && r.bottom >= innerHeight } : null,
        game: app ? { idle: window.__test!.isIdle(), busy: app.busyFeatures(), stream: app.terrainStats().stream, audio: { loaded: audio?.assetsLoaded ?? 0, total: audio?.assetsTotal ?? 0 }, ut: app.brief().ut, frames: app.frames() } : null,
      };
    });
  const step = (s: Sample, id: string): LoadingReport['steps'][number] => s.boot.steps.find((x) => x.id === id)!;

  // Poll until the screen has gone; a picture of the screen the first time each of these steps is seen active.
  const stages = ['defs', 'pipelines', 'terrain', 'view'];
  const shot = new Set<string>();
  const samples: Sample[] = [];
  const t0 = Date.now();
  await saveScreenshot(page, 'app', 'loading-0-first');
  for (;;) {
    const s = await sample();
    samples.push(s);
    if (!s.boot.active) break;
    if (!s.boot.fading) {
      const stage = stages.find((id) => step(s, id).state === 'active' && !shot.has(id));
      if (stage) {
        shot.add(stage);
        await saveScreenshot(page, 'app', `loading-${stages.indexOf(stage) + 1}-${stage}`);
      }
    }
    if (Date.now() - t0 > BOOT_MS) throw new Error(`still loading after ${BOOT_MS / 1000} s: ${JSON.stringify(s.boot.steps.map((x) => `${x.id} ${x.state} ${x.detail}`))}`);
    await page.waitForTimeout(150);
  }
  expect(await page.evaluate(() => window.__test!.ready)).toBe(true);
  const first = await saveScreenshot(page, 'app', 'loading-revealed-first');
  await assertDiscreteGpu(page);
  const report = await page.evaluate(() => window.__app!.loading());

  // The timeline, for the hand-off.
  const sec = (ms: number | null): string => (ms === null ? '-' : (ms / 1000).toFixed(1));
  console.log(`loading: ${sec(report.elapsedMs)} s to the revealed view; ${samples.length} samples; pictures of ${[...shot].join(', ')}`);
  for (const x of report.steps) console.log(`  ${x.label.padEnd(24)} ${sec(x.startMs).padStart(6)} -> ${sec(x.endMs).padStart(6)} s  ${x.done ?? ''}${x.total !== null ? ` / ${x.total}` : ''}  ${x.detail}`);
  console.log(`  reveal: ${JSON.stringify(report.reveal)}`);
  // The terrain under the screen, about every two seconds: resident / queued / baking / uploading tiles and frames.
  let lastPrinted = -1e9;
  for (const s of samples) {
    if (!s.game || s.boot.elapsedMs - lastPrinted < 2000) continue;
    lastPrinted = s.boot.elapsedMs;
    const st = s.game.stream;
    console.log(`  t ${sec(s.boot.elapsedMs).padStart(5)} s: frame ${String(s.game.frames).padStart(4)}, tiles ${st['ready']} resident, ${st['queued']} queued, ${st['loading']} baking, ${st['uploading']} uploading; ${step(s, 'pipelines').detail}; busy ${s.game.busy.join(' ')}`);
  }

  // 1. While the screen is up it covers the page, fully opaque, and the game does not run underneath.
  const up = samples.filter((s) => s.boot.active && !s.boot.fading);
  expect(up.length).toBeGreaterThan(5);
  for (const s of up) expect(s.overlay, 'loading screen present, opaque, covering the page').toEqual({ opacity: 1, covers: true });
  const uts = new Set(up.filter((s) => s.game).map((s) => s.game!.ut));
  expect(uts.size, 'simulation time held under the loading screen').toBeLessThanOrEqual(1);
  expect(up.filter((s) => s.game && s.game.frames > 0).length, 'frames rendered under the loading screen').toBeGreaterThan(0);

  // 2. It was up whenever something was still pending: no sample without the screen (or fading) has work left,
  //    and the frame loop's own record of the moment it let go says the same.
  const poolFull = report.reveal?.terrain.poolFull ?? false;
  expect(report.reveal).not.toBeNull();
  for (const s of samples.filter((x) => (!x.boot.active || x.boot.fading) && x.game)) {
    expect.soft(s.game!.stream['queued']! + s.game!.stream['loading']!, 'no tile queued or baking in a sample taken while the screen fades or right after').toBe(0);
    expect.soft(s.game!.busy.filter((id) => !(poolFull && id === 'terrain')), 'no feature busy in a sample taken while the screen fades or right after').toEqual([]);
  }
  expect(report.reveal!.busy.filter((id) => !(poolFull && id === 'terrain'))).toEqual([]);
  expect(report.reveal!.terrain.queued + report.reveal!.terrain.baking).toBe(0);
  if (!poolFull) expect(report.reveal!.terrain.uploading).toBe(0);
  expect(report.reveal!.settledFrames).toBeGreaterThanOrEqual(12);
  expect(Math.abs(report.reveal!.ev100 - report.reveal!.targetEv100)).toBeLessThanOrEqual(0.25);
  expect(report.reveal!.terrain.levelUnderVehicle, 'ground under the vehicle resident').not.toBeNull();
  expect(report.reveal!.terrain.levelUnderVehicle!).toBeGreaterThanOrEqual(12);

  // 3. The numbers are the subsystems' numbers: the terrain row is the streamer's counters and the sound row the
  //    engine's count, read in the same instant; counts never run past their totals; every step finished.
  let terrainRows = 0;
  for (const s of up) {
    for (const x of s.boot.steps) if (x.done !== null && x.total !== null) expect(x.done, `${x.id}: count within its total`).toBeLessThanOrEqual(x.total);
    if (!s.game) continue;
    const t = step(s, 'terrain');
    if (t.state === 'active' && !t.detail.includes('pool full')) {
      terrainRows++;
      expect(t.done, 'terrain row: resident tiles').toBe(s.game.stream['ready']);
      expect(t.total, 'terrain row: resident + pending').toBe(s.game.stream['ready']! + s.game.stream['queued']! + s.game.stream['loading']! + s.game.stream['uploading']!);
    }
    const a = step(s, 'audio');
    if (a.state === 'active') expect(a.done, 'sound row: decoded assets').toBe(s.game.audio.loaded);
  }
  expect(terrainRows, 'samples with the terrain streaming under the screen').toBeGreaterThan(0);
  const residentSeen = up.map((s) => step(s, 'terrain').done ?? 0);
  expect(Math.max(...residentSeen), 'tiles became resident while the screen was up').toBeGreaterThan(Math.min(...residentSeen));
  for (const x of report.steps) {
    expect(x.state, `${x.id} finished`).toBe('done');
    expect(x.endMs! >= x.startMs!, `${x.id} times`).toBe(true);
  }
  const defs = report.steps.find((x) => x.id === 'defs')!;
  const audio = report.steps.find((x) => x.id === 'audio')!;
  const pipelines = report.steps.find((x) => x.id === 'pipelines')!;
  const info = await page.evaluate(() => ({ audio: window.__test!.audio()!, features: window.__app!.features().length }));
  expect(audio.done).toBe(info.audio.assetsTotal);
  expect(audio.total).toBe(info.audio.assetsTotal);
  expect(pipelines.done).toBe(info.features + 1);
  expect(pipelines.total).toBe(info.features + 1);
  expect(defs.total).toBeGreaterThan(10);

  // 4. The first revealed frame has land where land is (it was sea for 40 s after boot at 1440p before), and is
  //    the picture the view keeps: ten seconds later, idle again, the same ground.
  const seaFirst = seaShare(first.buffer);
  assertRealImage(first.stats, 'loading-revealed-first');
  await page.evaluate(() => window.__test!.waitFrames(600));
  const later = await saveScreenshot(page, 'app', 'loading-revealed-later');
  const seaLater = seaShare(later.buffer);
  const diff = pngDiff(first.buffer, later.buffer);
  const after = await page.evaluate(() => ({ stream: window.__app!.terrainStats().stream, busy: window.__app!.busyFeatures(), ut: window.__app!.brief().ut }));
  console.log(
    `first revealed frame: sea share ${seaFirst.toFixed(4)} of the land band (10 s later ${seaLater.toFixed(4)}); mean abs difference to the later frame ${diff.meanAbsDiff.toFixed(2)} of 255, differing ${diff.differingFraction.toFixed(3)}; uploaded since the reveal ${after.stream['uploadedTotal']! - samples[samples.length - 1]!.game!.stream['uploadedTotal']!} tiles; busy ${JSON.stringify(after.busy)}`,
  );
  expect(seaFirst, 'sea-coloured share of the land band in the first revealed frame').toBeLessThan(0.1);
  expect(Math.abs(seaLater - seaFirst), 'the land band does not change after the reveal').toBeLessThan(0.05);
  expect(diff.meanAbsDiff, 'first revealed frame against the frame ten seconds later').toBeLessThan(6);
  expect(after.ut, 'the simulation runs once the screen has gone').toBeGreaterThan([...uts][0] ?? 0);
  await expectNoErrors(page, pageLog);
});

test('boots on the pad with every feature, the real sim and no error', async ({ page, pageLog }) => {
  await openGame(page);
  const info = await page.evaluate(() => ({
    page: window.__test!.page,
    features: window.__app!.features(),
    order: window.__app!.featureOrder(),
    state: window.__test!.state()!,
    audio: window.__test!.audio(),
  }));
  console.log(`features: ${info.features.map((f) => `${f.id}(${f.pkg})`).join(' ')}; hook order ${info.order.join(' ')}`);
  expect(info.page).toEqual({ kind: 'app', name: 'main', scenarioId: 'lunar-direct' });
  expect(info.features.map((f) => f.pkg).sort()).toEqual(['atmosphere', 'cockpit', 'map', 'ocean', 'sky', 'terrain', 'vehicle', 'vehicle', 'vfx']);
  expect(info.state.scenario).toEqual({ id: 'lunar-direct', startKind: 'pad', stagesAlreadyFired: 0 });
  expect(info.state.cheatCounter).toBe(0);
  const v = info.state.vessels.find((x) => x.id === info.state.activeVesselId)!;
  expect(v.situation).toBe('prelaunch');
  expect(info.state.terrain.complete).toBe(true);
  // The sound assets are decoded; the context waits for the first gesture.
  expect(info.audio!.assetsLoaded).toBe(info.audio!.assetsTotal);
  expect(await page.evaluate(() => window.__app!.inFlight())).toBe(false);
  await waitIdle(page, 8, BOOT_MS);
  await shoot(page, 'pad-chase');
  await expectNoErrors(page, pageLog);
});

test('keyboard: throttle, SAS, navball mode, displays, views and map, warp, pause, HUD', async ({ page, pageLog }) => {
  await openGame(page);
  await waitIdle(page, 4, BOOT_MS);

  // Throttle: Z full, X cut, Shift raises the lever at 0.5 per second.
  await press(page, 'KeyZ');
  let b = await until(page, 'b.throttle === 1', 5_000);
  await press(page, 'KeyX');
  b = await until(page, 'b.throttle === 0', 5_000);
  await page.keyboard.down('ShiftLeft');
  await page.waitForFunction(() => window.__app!.lever() >= 0.4, undefined, { polling: 50, timeout: 5_000 });
  await page.keyboard.up('ShiftLeft');
  const lever = await page.evaluate(() => window.__app!.lever());
  expect(lever).toBeGreaterThan(0.35);
  expect(lever).toBeLessThan(0.6);
  await press(page, 'KeyX');
  await until(page, 'b.throttle === 0', 5_000);

  // SAS: T toggles it, a digit selects a hold mode and switches SAS on.
  b = await brief(page);
  const sasBefore = b.sasEnabled;
  await press(page, 'KeyT');
  b = await until(page, `b.sasEnabled === ${!sasBefore}`, 5_000);
  await press(page, 'KeyT');
  b = await until(page, `b.sasEnabled === ${sasBefore}`, 5_000);
  await press(page, 'Digit1');
  b = await until(page, `b.sasEnabled && b.sasMode === 'stability'`, 5_000);

  // Navball mode (Tab) and the cockpit displays (9, 0, -).
  const nav = b.navballMode;
  await press(page, 'Tab');
  await until(page, `b.navballMode !== '${nav}'`, 5_000);
  await press(page, 'Tab');
  await until(page, `b.navballMode === '${nav}'`, 5_000);
  const pages0 = await page.evaluate(() => window.__app!.mfdPages());
  await press(page, 'Digit9');
  const pages1 = await page.evaluate(() => window.__app!.mfdPages());
  expect(pages1[0]).not.toBe(pages0[0]);
  expect(pages1.slice(1)).toEqual(pages0.slice(1));

  // Views: C cycles chase -> cockpit -> chase, M toggles the map; every switch blends.
  expect((await brief(page)).viewMode).toBe('chase');
  await viewKey(page, 'KeyC', 'interior');
  expect((await brief(page)).viewMode).toBe('cockpit');
  await waitIdle(page, 8, BOOT_MS);
  await shoot(page, 'pad-cockpit', { minNonBlack: 0.2 });
  await viewKey(page, 'KeyC', 'external');
  await viewKey(page, 'KeyM', 'map');
  await waitIdle(page, 8, BOOT_MS);
  const elements = await page.evaluate(() => window.__test!.map());
  expect(elements.filter((e) => e.visible && (e.kind === 'body' || e.kind === 'vessel')).length).toBeGreaterThan(0);
  await shoot(page, 'pad-map', { minNonBlack: 0.05 });
  await viewKey(page, 'KeyM', 'external');
  expect((await brief(page)).viewMode).toBe('chase');

  // Warp: '.' up, '/' back to real time.
  await press(page, 'Period');
  b = await until(page, 'b.warpIndex > 0', 10_000);
  await press(page, 'Slash');
  b = await until(page, 'b.warpIndex === 0', 10_000);

  // Pause: P freezes simulation time (the picture keeps rendering), P again resumes.
  await press(page, 'KeyP');
  b = await until(page, 'b.paused', 5_000);
  const frozen = b.ut;
  await page.evaluate(() => window.__test!.waitFrames(30));
  expect((await brief(page)).ut).toBe(frozen);
  await shoot(page, 'pad-paused');
  await press(page, 'KeyP');
  await until(page, `!b.paused && b.ut > ${frozen}`, 5_000);

  // F2 hides and shows the HUD.
  await press(page, 'F2');
  expect(await page.evaluate(() => window.__app!.hudVisible())).toBe(false);
  await shoot(page, 'pad-chase-nohud');
  await press(page, 'F2');
  expect(await page.evaluate(() => window.__app!.hudVisible())).toBe(true);

  // Nothing above changed the vehicle: still on the pad, nothing fired, no cheat.
  const s = await page.evaluate(() => window.__test!.state()!);
  expect(s.staging.nextStage).toBe(0);
  expect(s.cheatCounter).toBe(0);
  await expectNoErrors(page, pageLog);
});

test('a short real flight: ignite, lift off and climb a few kilometres, in every view', async ({ page, pageLog }) => {
  await openGame(page);
  await waitIdle(page, 4, BOOT_MS);
  const pad = await brief(page);

  // Full throttle, SAS on (stability), Space: the engines light and the clamps let go.
  await press(page, 'KeyZ');
  await press(page, 'KeyT');
  await until(page, 'b.throttle === 1 && b.sasEnabled', 5_000);
  await press(page, 'Space');
  let b = await until(page, 'b.nextStage === 1', 5_000);
  expect(await page.evaluate(() => window.__app!.inFlight())).toBe(true);
  b = await until(page, `b.milestones.includes('LIFTOFF')`, 30_000);
  // The engines are heard (the key press resumed the audio context).
  const audio = await page.evaluate(() => window.__test!.audio()!);
  expect(audio.state).toBe('running');
  expect(audio.buses.engines.rms).toBeGreaterThan(0);
  await page.evaluate(() => window.__test!.waitFrames(60));
  await shoot(page, 'liftoff-chase');

  await until(page, `b.altitudeAsl > ${pad.altitudeAsl + 150}`, 60_000);
  await shoot(page, 'climb-chase-150m');
  await viewKey(page, 'KeyC', 'interior');
  await until(page, `b.altitudeAsl > ${pad.altitudeAsl + 1000}`, 90_000);
  await shoot(page, 'climb-cockpit-1km', { minNonBlack: 0.2 });
  await viewKey(page, 'KeyC', 'external');
  await until(page, `b.altitudeAsl > ${pad.altitudeAsl + 2000}`, 90_000);
  await shoot(page, 'climb-chase-2km');
  await viewKey(page, 'KeyM', 'map');
  await until(page, `b.altitudeAsl > ${pad.altitudeAsl + 3000}`, 90_000);
  await shoot(page, 'climb-map-3km', { minNonBlack: 0.05 });
  await viewKey(page, 'KeyM', 'external');
  b = await until(page, `b.altitudeAsl > ${pad.altitudeAsl + 4000}`, 90_000);
  await shoot(page, 'climb-chase-4km');

  const s = await page.evaluate(() => window.__test!.state()!);
  expect(s.mission.failed).toBe(false);
  expect(s.cheatCounter).toBe(0);
  expect(s.readouts.verticalSpeed).toBeGreaterThan(50);
  expect(s.milestones[0]!.id).toBe('LIFTOFF');
  console.log(`climb: ${(b.altitudeAsl / 1000).toFixed(2)} km at MET ${b.met.toFixed(1)} s, ${b.verticalSpeed.toFixed(0)} m/s up, perf ${JSON.stringify(await page.evaluate(() => window.__test!.perf()!.raf))}`);
  await expectNoErrors(page, pageLog);
});

test('the scripted test pilot flies inside the page through the controls', async ({ page, pageLog }) => {
  await openGame(page, '?pilot=1');
  // The pilot waits for the launch window on the pad (warping), lights the engines and climbs.
  await page.waitForFunction(() => window.__test!.pilot!.phase() !== null, undefined, { timeout: 10_000 });
  const b = await until(page, `b.milestones.includes('LIFTOFF') && b.altitudeAsl > 2000`, 8 * 60_000);
  const phase = await page.evaluate(() => window.__test!.pilot!.phase());
  expect(await page.evaluate(() => window.__test!.pilot!.failure())).toBeNull();
  // The shell's status line names the pilot and its phase.
  expect(await page.evaluate(() => document.querySelector('[data-app-status]')!.textContent)).toContain('TEST PILOT');
  await shoot(page, 'pilot-climb-chase');
  await page.evaluate(() => window.__test!.pilot!.stop());
  const s = await page.evaluate(() => window.__test!.state()!);
  expect(s.cheatCounter).toBe(0);
  expect(s.scenario.startKind).toBe('pad');
  console.log(`pilot: phase ${phase}, ${(b.altitudeAsl / 1000).toFixed(2)} km at MET ${b.met.toFixed(1)} s`);
  await expectNoErrors(page, pageLog);
});

test('in low orbit: the map takes the pointer, a node is added and Shift-dragged, the throttle stays at 0', async ({ page, pageLog }) => {
  // The QA scenario in the parking orbit (a state start: not a mission proof, recorded as such in the snapshot).
  await openGame(page, '?scenario=qa-leo');
  await waitIdle(page, 8, BOOT_MS);
  await shoot(page, 'leo-chase', { minNonBlack: 0.2 });
  await viewKey(page, 'KeyC', 'interior');
  await waitIdle(page, 60, BOOT_MS);
  const e = await page.evaluate(() => window.__app!.exposure());
  console.log(`leo cockpit: EV100 ${e.ev100.toFixed(2)} (target ${e.targetEv100.toFixed(2)}), sun visibility ${e.sunVisibility.toFixed(2)}, outside ${e.outsideFraction.toFixed(3)}`);
  await shoot(page, 'leo-cockpit', { minNonBlack: 0.03 });
  await viewKey(page, 'KeyC', 'external');
  await viewKey(page, 'KeyM', 'map');
  const marker = async (kind: string, id: string): Promise<{ x: number; y: number; visible: boolean }> => {
    const e = (await page.evaluate(() => window.__test!.map())).find((x) => x.kind === kind && x.id === id);
    if (!e) throw new Error(`no map element ${kind} ${id}`);
    return e;
  };
  // The parking orbit runs 180-260 km above the limb, so its far side is behind the Earth from most directions:
  // turn the map camera until the apoapsis marker is on the near side, on the scene and clear of the HUD.
  let ap: { x: number; y: number; visible: boolean } | null = null;
  const tried: string[] = [];
  for (const yaw of [0, 1.05, 2.1, 3.14, 4.19, 5.24]) {
    await page.evaluate((y) => window.__test!.setCameraOrbit(y, 0.7, 2.2e7), yaw);
    await page.evaluate(() => window.__test!.waitFrames(90));
    const m = await marker('marker', 'current/0/apoapsis');
    const onScene = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y) === document.getElementById('viewport'), m);
    tried.push(`yaw ${yaw}: visible ${m.visible}, at ${m.x.toFixed(0)},${m.y.toFixed(0)}, on the scene ${onScene}`);
    if (m.visible && onScene) {
      ap = m;
      break;
    }
  }
  if (!ap) throw new Error(`the apoapsis marker is never visible on the scene: ${tried.join('; ')}`);
  await waitIdle(page, 8, BOOT_MS);
  await page.mouse.click(ap.x, ap.y);
  await page.waitForFunction(() => window.__test!.state()!.nodes.length === 1, undefined, { timeout: 10_000 });
  await page.evaluate(() => window.__test!.waitFrames(4));
  const id = (await page.evaluate(() => window.__test!.state()!)).nodes[0]!.id;
  // Shift-drag on the prograde handle: the map owns the pointer, Shift is the editor's fine modifier, and the lever
  // must not move (ARCHITECTURE 11 and 18.2).
  const n = await marker('node', id);
  const h = await marker('nodeHandle', `${id}/prograde`);
  const l = Math.hypot(h.x - n.x, h.y - n.y);
  const [ux, uy] = [(h.x - n.x) / l, (h.y - n.y) / l];
  const before = (await page.evaluate(() => window.__test!.state()!)).nodes[0]!.dv.prograde;
  await page.mouse.move(h.x, h.y);
  await page.evaluate(() => window.__test!.waitFrames(2));
  await page.keyboard.down('ShiftLeft');
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) {
    await page.mouse.move(h.x + ux * 10 * i, h.y + uy * 10 * i);
    await page.evaluate(() => window.__test!.waitFrames(1));
  }
  await page.mouse.up();
  await page.keyboard.up('ShiftLeft');
  await page.evaluate(() => window.__test!.waitFrames(30));
  const s = await page.evaluate(() => window.__test!.state()!);
  const fine = s.nodes[0]!.dv.prograde - before;
  console.log(`node ${id}: prograde +${fine.toFixed(3)} m/s from a 100 px Shift-drag; lever ${await page.evaluate(() => window.__app!.lever())}`);
  expect(fine).toBeGreaterThan(0.5);
  expect(fine).toBeLessThan(2);
  expect(await page.evaluate(() => window.__app!.lever())).toBe(0);
  expect(s.appliedControls.throttle).toBe(0);
  expect(s.patches.planned.length).toBeGreaterThan(0);
  await shoot(page, 'leo-map-node', { minNonBlack: 0.05 });
  expect(s.scenario.startKind).toBe('state');
  expect(s.cheatCounter).toBe(0);
  await expectNoErrors(page, pageLog);
});

test('keyboard capture and fullscreen are opt-in: off by default, on and off with the HUD control, ?capture=1, footage switches', async ({ page, pageLog }) => {
  const captured = (): Promise<{ locked: boolean; fullscreen: boolean }> => page.evaluate(() => ({ locked: window.__app!.keyboardLocked(), fullscreen: document.fullscreenElement !== null }));
  const visible = (selector: string): Promise<boolean> =>
    page.evaluate((sel) => {
      const e = document.querySelector(sel);
      return e !== null && e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden';
    }, selector);

  // Default: keys and clicks on the scene fly the vehicle and capture nothing.
  await openGame(page);
  await press(page, 'KeyT');
  await page.mouse.click(640, 300);
  await press(page, 'KeyZ');
  await page.evaluate(() => window.__test!.waitFrames(20));
  expect(await captured()).toEqual({ locked: false, fullscreen: false });
  const b = await brief(page);
  expect(b.sasEnabled).toBe(true);
  expect(b.throttle).toBe(1);
  await press(page, 'KeyX');
  // The HUD's control: fullscreen and the keyboard lock on a click...
  expect(await visible('.hud .kbcap')).toBe(true);
  await page.click('.hud .kbcap');
  await page.waitForFunction(() => document.fullscreenElement !== null, undefined, { timeout: 10_000 });
  await page.evaluate(() => window.__test!.waitFrames(20));
  const on = await captured();
  console.log(`capture by the HUD control: fullscreen ${on.fullscreen}, keyboard lock ${on.locked}`);
  expect(on.fullscreen).toBe(true);
  await shoot(page, 'capture-on');
  expect(await page.getAttribute('.hud .kbcap', 'aria-checked')).toBe('true');
  // ...and off again with a second click on the same switch (Esc does the same).
  await page.click('.hud .kbcap');
  await page.waitForFunction(() => document.fullscreenElement === null, undefined, { timeout: 10_000 });
  await page.evaluate(() => window.__test!.waitFrames(20));
  expect(await captured()).toEqual({ locked: false, fullscreen: false });
  expect(await visible('.hud .kbcap')).toBe(true);
  expect(await page.getAttribute('.hud .kbcap', 'aria-checked')).toBe('false');
  await press(page, 'KeyT');
  expect((await brief(page)).sasEnabled).toBe(false);
  await expectNoErrors(page, pageLog);

  // ?capture=1: the first key press asks; the footage switches hide the capture control and the pilot's label.
  await openGame(page, '?capture=1&pilot=1&capturepill=0&pilotlabel=0');
  await page.waitForFunction(() => window.__test!.pilot!.phase() !== null, undefined, { timeout: 10_000 });
  expect(await visible('.hud .kbcap')).toBe(false);
  expect(await visible('.hud .helpbtn')).toBe(true);
  expect(await visible('[data-app-status]')).toBe(false);
  await press(page, 'F9');
  await page.waitForFunction(() => document.fullscreenElement !== null, undefined, { timeout: 10_000 });
  const auto = await captured();
  console.log(`?capture=1, first key: fullscreen ${auto.fullscreen}, keyboard lock ${auto.locked}`);
  expect(auto.fullscreen).toBe(true);
  // PAUSED still shows with the pilot's label switched off.
  await page.evaluate(() => window.__test!.setPaused(true));
  await page.evaluate(() => window.__test!.waitFrames(4));
  expect(await visible('[data-app-status]')).toBe(true);
  expect(await page.evaluate(() => document.querySelector('[data-app-status]')!.textContent)).not.toContain('TEST PILOT');
  await shoot(page, 'footage-switches');
  await page.evaluate(() => window.__test!.pilot!.stop());
  await expectNoErrors(page, pageLog);
});
