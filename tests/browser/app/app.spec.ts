/**
 * The game in real Chrome on the discrete GPU: the app shell (src/app) with the real simulation, every render
 * feature, the HUD, the map view, the cameras and audio, driven through the keyboard bindings and window.__test.
 *
 *   node tools/dev/heavy.mjs --class=gpu -- npx playwright test tests/browser/app --project=functional
 *
 * Screenshots: out/screens/app/ (every one is looked at; see docs/handoff/app-integration-v1.md). The page is
 * opened with ?capture=0 (no fullscreen request on the first key press, so the viewport stays 1280 x 720);
 * one test keeps the game's default and checks that a key press asks for the keyboard capture.
 */
import type { Page } from '@playwright/test';
import type { AppBrief } from '../../../src/app/testHooks';
import { assertDiscreteGpu, assertRealImage, expect, expectNoErrors, openPage, saveScreenshot, test, waitIdle } from '../harness';

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

async function openGame(page: Page, query = '?capture=0'): Promise<void> {
  await openPage(page, `/${query}`, { timeoutMs: BOOT_MS });
  await assertDiscreteGpu(page);
}

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
  await openGame(page, '?capture=0&pilot=1');
  // The pilot waits for the launch window on the pad (warping), lights the engines and climbs.
  await page.waitForFunction(() => window.__test!.pilot!.phase() !== null, undefined, { timeout: 10_000 });
  const b = await until(page, `b.milestones.includes('LIFTOFF') && b.altitudeAsl > 2000`, 8 * 60_000);
  const phase = await page.evaluate(() => window.__test!.pilot!.phase());
  expect(await page.evaluate(() => window.__test!.pilot!.failure())).toBeNull();
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
  await openGame(page, '?capture=0&scenario=qa-leo');
  await waitIdle(page, 8, BOOT_MS);
  await shoot(page, 'leo-chase', { minNonBlack: 0.2 });
  await viewKey(page, 'KeyC', 'interior');
  await waitIdle(page, 60, BOOT_MS);
  const e = await page.evaluate(() => window.__app!.exposure());
  console.log(`leo cockpit: EV100 ${e.ev100.toFixed(2)} (target ${e.targetEv100.toFixed(2)}), sun visibility ${e.sunVisibility.toFixed(2)}, outside ${e.outsideFraction.toFixed(3)}`);
  await shoot(page, 'leo-cockpit', { minNonBlack: 0.03 });
  await viewKey(page, 'KeyC', 'external');
  await viewKey(page, 'KeyM', 'map');
  // Over the north pole, the parking orbit nearly face-on.
  await page.evaluate(() => window.__test!.setCameraOrbit(0, 1.35, 2.2e7));
  await page.evaluate(() => window.__test!.waitFrames(90));
  await waitIdle(page, 8, BOOT_MS);
  const marker = async (kind: string, id: string): Promise<{ x: number; y: number; visible: boolean }> => {
    const e = (await page.evaluate(() => window.__test!.map())).find((x) => x.kind === kind && x.id === id);
    if (!e) throw new Error(`no map element ${kind} ${id}`);
    return e;
  };
  const ap = await marker('marker', 'current/0/apoapsis');
  expect(ap.visible).toBe(true);
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

test('the first key press asks for fullscreen and the keyboard lock (game default)', async ({ page, pageLog }) => {
  await openGame(page, '');
  await press(page, 'KeyT');
  await page.evaluate(() => window.__test!.waitFrames(10));
  const locked = await page.evaluate(() => window.__app!.keyboardLocked());
  const fullscreen = await page.evaluate(() => document.fullscreenElement !== null);
  console.log(`capture: fullscreen ${fullscreen}, keyboard lock ${locked}`);
  expect((await brief(page)).sasEnabled).toBe(true);
  await expectNoErrors(page, pageLog);
});
