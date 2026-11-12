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
import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';
import type { Page } from '@playwright/test';
import type { LoadingReport } from '../../../src/app/loading';
import type { AppBrief } from '../../../src/app/testHooks';
import type { FrameBreakdown } from '../../../src/app/timing';
import { appUrl, assertDiscreteGpu, assertRealImage, captureDeterministic, expect, expectNoErrors, openPage, pngDiff, saveScreenshot, test, waitIdle } from '../harness';

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
 * How water-like the picture is around a point: the share of the pixels of a 13 x 13 patch that are both smooth
 * (the luminance steps to the right and the lower neighbour together within 4 % of the pixel's luminance, taken
 * as 16 of 255 at least) and bluish (blue at least 3 above red). Open water under a daylight sky is both; lava
 * plain and scrub are textured and neutral to brown. Measured on this spec's and the browser mission's pictures:
 * 0.37-0.65 on sea (the frame of 2026-11-11 in which the land around the pad was drawn as sea: 0.62-0.65; the real
 * sea off the pad's coast outside the sun's glitter: 0.37-0.45), 0.00-0.06 on land, 0.11 on the pad's concrete in
 * shadow. Colour alone does not tell them apart (fresh lava is blue-grey), and a smoothness in absolute levels
 * takes dark ground in shadow for water (0.19-0.42 with a step of 2 of 255). Two things it cannot tell from
 * water: the sun's glitter on real water (bright, warm, rough: 0.00) and the white of the vehicle in shade
 * (0.67), so a land point hidden behind the stack reads as water: the limit on the share of points leaves room.
 */
function waterLikeAt(img: PNG, cx: number, cy: number): number {
  const lum = (i: number): number => 0.2126 * img.data[i]! + 0.7152 * img.data[i + 1]! + 0.0722 * img.data[i + 2]!;
  let water = 0;
  let n = 0;
  for (let y = Math.max(0, Math.round(cy) - 6); y <= Math.min(img.height - 2, Math.round(cy) + 6); y++) {
    for (let x = Math.max(0, Math.round(cx) - 6); x <= Math.min(img.width - 2, Math.round(cx) + 6); x++) {
      const i = (y * img.width + x) * 4;
      const l = lum(i);
      if (Math.abs(l - lum(i + 4)) + Math.abs(l - lum(i + img.width * 4)) <= 0.04 * Math.max(l, 16) && img.data[i + 2]! - img.data[i]! >= 3) water++;
      n++;
    }
  }
  return n === 0 ? 0 : water / n;
}

interface GroundSample {
  distance: number;
  bearingDeg: number;
  kind: string;
  heightAboveSea: number | null;
  x: number | null;
  y: number | null;
}

/**
 * "Land where land is", whatever the camera shows: of the ground points around the pad that the height authority
 * calls land at least 3 m above the sea and that fall into the frame, the share whose patch of the picture looks
 * like water (waterLikeAt at 0.25 or more). The same for the points the authority calls water, as a reading of
 * the statistic on real sea when the view has some.
 */
function landAsWater(png: Buffer, samples: GroundSample[], annotated?: string): { land: number; landAsWater: number; water: number; waterAsWater: number; flagged: string[] } {
  const img = PNG.sync.read(png);
  const inFrame = samples.filter((p) => p.x !== null && p.y !== null);
  const land = inFrame.filter((p) => p.kind === 'land' && (p.heightAboveSea === null || p.heightAboveSea >= 3));
  const water = inFrame.filter((p) => p.kind === 'water');
  const looksLikeWater = new Map(inFrame.map((p) => [p, waterLikeAt(img, p.x!, p.y!) >= 0.25]));
  const share = (list: GroundSample[]): number => (list.length === 0 ? 0 : list.filter((p) => looksLikeWater.get(p)).length / list.length);
  if (annotated !== undefined) {
    // The points on the picture, to look at: land green (red where it reads as water), water blue (white where it
    // reads as water), land under 3 m above the sea grey.
    const out = PNG.sync.read(png);
    for (const p of inFrame) {
      const isLand = land.includes(p);
      const colour = isLand ? (looksLikeWater.get(p) ? [255, 40, 40] : [60, 255, 90]) : p.kind === 'water' ? (looksLikeWater.get(p) ? [255, 255, 255] : [60, 140, 255]) : [150, 150, 150];
      for (let y = Math.round(p.y!) - 4; y <= Math.round(p.y!) + 4; y++) {
        for (let x = Math.round(p.x!) - 4; x <= Math.round(p.x!) + 4; x++) {
          if (x < 0 || y < 0 || x >= out.width || y >= out.height) continue;
          // A ring: the picture under the point stays visible.
          if (Math.max(Math.abs(x - Math.round(p.x!)), Math.abs(y - Math.round(p.y!))) < 3) continue;
          const i = (y * out.width + x) * 4;
          out.data[i] = colour[0]!;
          out.data[i + 1] = colour[1]!;
          out.data[i + 2] = colour[2]!;
        }
      }
    }
    fs.writeFileSync(annotated, PNG.sync.write(out));
  }
  const flagged = land.filter((p) => looksLikeWater.get(p)).map((p) => `${p.distance} m at ${p.bearingDeg} deg (${p.x!.toFixed(0)}, ${p.y!.toFixed(0)})`);
  return { land: land.length, landAsWater: share(land), water: water.length, waterAsWater: share(water), flagged };
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
    game: {
      idle: boolean;
      busy: string[];
      stream: Record<string, number>;
      residency: { wanted: number; resident: number; wantedLevel: number; residentLevel: number } | null;
      loads: { shaders: { pending: number; total: number }; textures: { pending: number; total: number }; atmosphere: { done: number; total: number } };
      audio: { loaded: number; total: number };
      ut: number;
      frames: number;
    } | null;
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
        game: app
          ? {
              idle: window.__test!.isIdle(),
              busy: app.busyFeatures(),
              stream: app.terrainStats().stream,
              residency: app.terrainResidency(),
              loads: app.renderLoads(),
              audio: { loaded: audio?.assetsLoaded ?? 0, total: audio?.assetsTotal ?? 0 },
              ut: app.brief().ut,
              frames: app.frames(),
            }
          : null,
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
  const inits = await page.evaluate(() => ({ features: window.__app!.featureInitMs(), warm: window.__app!.warmMs() }));
  console.log(`  feature start-up, s: ${Object.entries(inits.features).map(([id, t]) => `${id} ${sec(t)}`).join(', ')}; pipelines created ahead (renderer.warm) ${sec(inits.warm)} s`);
  // The first frames (pipelines were created ahead by `renderer.warm()`): how far the frame counter was at each
  // sample up to frame 40, and the slowest frames since the start with what their main-thread time was made of.
  // A gap between two samples is the page not answering: one long task.
  for (const s of samples.filter((x) => x.game && x.game.frames <= 40)) {
    const g = s.game!;
    console.log(`  t ${sec(s.boot.elapsedMs).padStart(5)} s: frame ${String(g.frames).padStart(3)}; shaders ${g.loads.shaders.total - g.loads.shaders.pending} / ${g.loads.shaders.total}, textures ${g.loads.textures.total - g.loads.textures.pending} / ${g.loads.textures.total}, atmosphere ${g.loads.atmosphere.done} / ${g.loads.atmosphere.total}; busy ${g.busy.join(' ')}`);
  }
  const slowest: FrameBreakdown[] = await page.evaluate(() => window.__app!.cpuSlowest());
  const top = (o: Record<string, number>, n: number): string =>
    Object.entries(o)
      .filter(([, v]) => v >= 1)
      .sort((a, c) => c[1] - a[1])
      .slice(0, n)
      .map(([k, v]) => `${k} ${v.toFixed(0)}`)
      .join(', ');
  for (const b of slowest.slice(0, 6)) console.log(`  slow frame ${b.frame} under the loading screen: ${b.total.toFixed(0)} ms = ${top(b.stages, 4)}; features: ${top(b.features, 5)}; hooks: ${top(b.hooks, 6)}`);
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
  expect(report.reveal).not.toBeNull();
  for (const s of samples.filter((x) => (!x.boot.active || x.boot.fading) && x.game)) {
    expect.soft(s.game!.stream['queued']! + s.game!.stream['loading']!, 'no tile queued or baking in a sample taken while the screen fades or right after').toBe(0);
    expect.soft(s.game!.busy, 'no feature busy in a sample taken while the screen fades or right after').toEqual([]);
  }
  expect(report.reveal!.busy).toEqual([]);
  expect(report.reveal!.terrain.queued + report.reveal!.terrain.baking + report.reveal!.terrain.uploading).toBe(0);
  // Residency is final: every tile the view wants is there, down to the deepest level it wants.
  expect(report.reveal!.terrain.resident).toBe(report.reveal!.terrain.wanted);
  expect(report.reveal!.terrain.wanted).toBeGreaterThan(100);
  expect(report.reveal!.terrain.residentLevel).toBe(report.reveal!.terrain.wantedLevel);
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
    if (t.state === 'active' && s.game.residency) {
      terrainRows++;
      expect(t.done, 'terrain row: tiles of the view that are resident').toBe(s.game.residency.resident);
      expect(t.total, 'terrain row: tiles the view wants').toBe(s.game.residency.wanted);
      expect(t.detail, 'terrain row: levels').toContain(`level ${Math.max(0, s.game.residency.residentLevel)} of ${s.game.residency.wantedLevel}`);
    }
    const p = step(s, 'pipelines');
    if (p.state === 'active') {
      expect(p.done, 'pipelines row: shader modules compiled').toBe(s.game.loads.shaders.total - s.game.loads.shaders.pending);
      expect(p.total, 'pipelines row: shader modules created').toBe(s.game.loads.shaders.total);
    }
    const m = step(s, 'models');
    if (m.state === 'active') expect(m.total, 'models row: texture loads started').toBe(s.game.loads.textures.total);
    const at = step(s, 'atmosphere');
    if (at.state === 'active') expect({ done: at.done, total: at.total }, 'atmosphere row: tables, cloud noise and coverage maps, done / in all').toEqual(s.game.loads.atmosphere);
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
  expect(pipelines.done).toBe(pipelines.total);
  expect(pipelines.total!).toBeGreaterThan(20);
  expect(pipelines.detail).toContain(`${info.features} features`);
  expect(defs.total).toBeGreaterThan(10);

  // 4. The first revealed frame has land where land is (it was sea for 40 s after boot at 1440p before), and is
  //    the picture the view keeps: ten seconds later, idle again, the same ground. The land is asked of the
  //    height authority at 120 points between 300 m and 1.8 km from the pad (beyond the site's concrete) and
  //    looked for where those points fall in the frame, so the check holds whichever way the default view looks
  //    (it has turned twice since it was written).
  const ground: GroundSample[] = await page.evaluate(() => window.__app!.groundSamples([300, 500, 800, 1200, 1800], 24));
  const seaFirst = landAsWater(first.buffer, ground, path.join(path.dirname(first.file), 'loading-revealed-first-land-points.png'));
  assertRealImage(first.stats, 'loading-revealed-first');
  await page.evaluate(() => window.__test!.waitFrames(600));
  const later = await saveScreenshot(page, 'app', 'loading-revealed-later');
  const seaLater = landAsWater(later.buffer, ground);
  const diff = pngDiff(first.buffer, later.buffer);
  const after = await page.evaluate(() => ({ stream: window.__app!.terrainStats().stream, busy: window.__app!.busyFeatures(), ut: window.__app!.brief().ut }));
  console.log(
    `first revealed frame: ${seaFirst.land} land points in the frame, ${(seaFirst.landAsWater * 100).toFixed(1)} % of them look like water (10 s later ${(seaLater.landAsWater * 100).toFixed(1)} %); ${seaFirst.water} water points in the frame, ${(seaFirst.waterAsWater * 100).toFixed(1)} % of them look like water; mean abs difference to the later frame ${diff.meanAbsDiff.toFixed(2)} of 255, differing ${diff.differingFraction.toFixed(3)}; uploaded since the reveal ${after.stream['uploadedTotal']! - samples[samples.length - 1]!.game!.stream['uploadedTotal']!} tiles; busy ${JSON.stringify(after.busy)}`,
  );
  expect(seaFirst.land, 'land points of the pad surroundings in the first revealed frame').toBeGreaterThanOrEqual(15);
  if (seaFirst.flagged.length > 0) console.log(`  land points that read as water in the first frame: ${seaFirst.flagged.join('; ')}`);
  expect(seaFirst.landAsWater, 'share of the land points that look like water in the first revealed frame').toBeLessThan(0.25);
  expect(Math.abs(seaLater.landAsWater - seaFirst.landAsWater), 'the land does not change after the reveal').toBeLessThan(0.1);
  expect(diff.meanAbsDiff, 'first revealed frame against the frame ten seconds later').toBeLessThan(6);
  expect(after.ut, 'the simulation runs once the screen has gone').toBeGreaterThan([...uts][0] ?? 0);
  await expectNoErrors(page, pageLog);
});

test('the loading screen lets go in other starts too: a dark cabin on the Moon, a coast in deep space', async ({ page, pageLog }) => {
  // Starts whose exposure adapts slowly (a dark cabin) or whose view has no terrain near it: the screen must not hang.
  for (const [name, query] of [
    ['start-lunar-surface-cockpit', '?scenario=qa-lunar-surface&view=cockpit'],
    ['start-trans-earth', '?scenario=qa-trans-earth'],
  ] as const) {
    await openGame(page, query);
    const report = await page.evaluate(() => window.__app!.loading());
    const r = report.reveal!;
    console.log(
      `${name}: ${(report.elapsedMs / 1000).toFixed(1)} s to the revealed view; terrain ${r.terrain.resident} of ${r.terrain.wanted} tiles, level ${r.terrain.residentLevel} of ${r.terrain.wantedLevel}, level ${r.terrain.levelUnderVehicle ?? '-'} under the vehicle; EV100 ${r.ev100.toFixed(2)} (target ${r.targetEv100.toFixed(2)}); busy ${JSON.stringify(r.busy)}`,
    );
    expect(report.active).toBe(false);
    for (const x of report.steps) expect(x.state, `${name}: ${x.id} finished`).toBe('done');
    expect(r.busy).toEqual([]);
    expect(r.terrain.queued + r.terrain.baking + r.terrain.uploading).toBe(0);
    expect(r.terrain.resident).toBe(r.terrain.wanted);
    // The chase rig's default framing keeps the Earth or the Moon in the frame (request app-integration-10).
    const view = await page.evaluate(() => ({ mode: window.__app!.viewMode(), framing: window.__app!.chaseFraming(), bodies: window.__app!.bodiesInFrame() }));
    if (view.mode === 'chase') {
      console.log(`${name}: chase framing ${JSON.stringify(view.framing)}; in frame: ${view.bodies.map((x) => `${x.id} at ${x.x?.toFixed(2)},${x.y?.toFixed(2)} (${(x.heightShare * 50).toFixed(1)} % of the height)`).join(', ') || 'no body'}`);
      expect(view.framing.auto).toBe(true);
      expect(view.bodies.filter((x) => !x.star).map((x) => x.id), `${name}: a body in the default chase frame`).not.toEqual([]);
    }
    await shoot(page, name, { minNonBlack: 0.02, minStd: 4, minBuckets: 20 });
    await expectNoErrors(page, pageLog);
  }
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
  // Picture stops (what the browser mission takes its pictures at): the game holds the simulation in the frame
  // a named moment is reached and runs on when told.
  await page.evaluate(() =>
    window.__app!.setPictureStops([
      { id: 'stage', trigger: { event: 'stageFired', active: true } },
      { id: 'liftoff', trigger: { milestone: 'LIFTOFF' } },
      { id: 'liftoff+1s', trigger: { milestone: 'LIFTOFF' }, seconds: 1 },
      { id: 'never', trigger: { peak: 'gLoad', floor: 3, drop: 0.05 }, after: 'A_MILESTONE_THIS_FLIGHT_HAS_NOT' },
    ]),
  );
  const heldAt = async (id: string): Promise<{ id: string; ut: number; triggerUt: number }> => {
    await page.waitForFunction((want) => window.__app!.pictureStop()?.id === want, id, { polling: 50, timeout: 60_000 });
    const stop = (await page.evaluate(() => window.__app!.pictureStop()))!;
    const frames0 = await page.evaluate(() => window.__app!.frames());
    await page.evaluate(() => window.__test!.waitFrames(20));
    const after = await page.evaluate(() => ({ ut: window.__app!.brief().ut, frames: window.__app!.frames(), paused: window.__app!.paused() }));
    expect(after.ut, `${id}: the simulation stands still at the stop`).toBe(stop.ut);
    expect(after.frames, `${id}: the picture keeps rendering at the stop`).toBeGreaterThan(frames0);
    expect(after.paused, `${id}: a stop is not the pause (no PAUSED line in the picture)`).toBe(false);
    return stop;
  };
  const runOn = (): Promise<void> => page.evaluate(() => window.__app!.resumeFromPictureStop());

  await press(page, 'Space');
  let b = await until(page, 'b.nextStage === 1', 5_000);
  expect(await page.evaluate(() => window.__app!.inFlight())).toBe(true);
  const stage = await heldAt('stage');
  expect(stage.ut - stage.triggerUt, 'held in the frame the stage fired').toBeLessThan(0.1);
  await shoot(page, 'stop-stage-fired');
  await runOn();
  const liftoff = await heldAt('liftoff');
  expect(liftoff.ut - liftoff.triggerUt, 'held in the frame of the lift-off').toBeLessThan(0.1);
  b = await brief(page);
  expect(b.milestones).toContain('LIFTOFF');
  // The engines are heard (the key press resumed the audio context), also while the simulation is held.
  const audio = await page.evaluate(() => window.__test!.audio()!);
  expect(audio.state).toBe('running');
  expect(audio.buses.engines.rms).toBeGreaterThan(0);
  await shoot(page, 'stop-liftoff');
  await runOn();
  const later = await heldAt('liftoff+1s');
  expect(later.ut - later.triggerUt).toBeGreaterThanOrEqual(1);
  expect(later.ut - later.triggerUt, 'the first frame at or past one second after the lift-off').toBeLessThan(1.1);
  await shoot(page, 'stop-liftoff-plus-1s');
  await runOn();
  expect((await page.evaluate(() => window.__app!.pictureStopsFired())).map((x) => x.id)).toEqual(['stage', 'liftoff', 'liftoff+1s']);
  await page.evaluate(() => window.__test!.waitFrames(60));
  expect(await page.evaluate(() => window.__app!.pictureStop()), 'the flight runs on after the last stop').toBeNull();
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
  // The default chase framing has the Earth in the frame; the player's turn is kept, the reset returns to it.
  const framing = (): Promise<{ auto: boolean; pitch: number; zoom: number; roll: number; distance: number }> => page.evaluate(() => window.__app!.chaseFraming());
  const earthInFrame = async (): Promise<boolean> => (await page.evaluate(() => window.__app!.bodiesInFrame())).some((x) => !x.star);
  expect((await framing()).auto).toBe(true);
  expect(await earthInFrame(), 'the Earth in the default chase frame in low orbit').toBe(true);
  await page.keyboard.down('ArrowUp');
  await page.keyboard.down('ArrowLeft');
  await page.evaluate(() => window.__test!.waitFrames(45));
  await page.keyboard.up('ArrowUp');
  await page.keyboard.up('ArrowLeft');
  await page.evaluate(() => window.__test!.waitFrames(10));
  const turned = await framing();
  expect(turned.auto).toBe(false);
  expect(Math.abs(turned.pitch)).toBeGreaterThan(0.01);
  // Home: the binding of `ui:resetCamera` (request app-integration-14).
  await press(page, 'Home');
  await page.waitForFunction(() => window.__app!.chaseFraming().auto, undefined, { polling: 100, timeout: 10_000 });
  // The swing back takes a second and a half.
  await page.evaluate(() => window.__test!.waitFrames(120));
  const back = await framing();
  expect(back.auto && Math.abs(back.pitch) < 1e-9 && Math.abs(back.zoom - 1) < 1e-9, `default framing after the reset (${JSON.stringify(back)})`).toBe(true);
  expect(await earthInFrame(), 'the Earth in the frame again after the reset').toBe(true);
  await shoot(page, 'leo-chase-reset', { minNonBlack: 0.2 });
  // The scenario starts heads-up (roll 0: the forward windows look at space). A crew flies this orbit heads-down
  // to have the Earth in the forward windows: SAS on, roll with the E key until the navball reads 180 degrees, as
  // a player would (RCS as well if the reaction wheels do not turn the stack).
  const roll = async (): Promise<number> => (await brief(page)).rollDeg;
  if (!(await brief(page)).sasEnabled) await press(page, 'KeyT');
  await until(page, 'b.sasEnabled', 5_000);
  const roll0 = await roll();
  await page.keyboard.down('KeyE');
  await page.evaluate(() => window.__test!.waitFrames(180));
  if (Math.abs((await roll()) - roll0) < 2) {
    await page.keyboard.press('KeyR');
    await until(page, 'b.rcsEnabled', 5_000);
  }
  await page.waitForFunction(() => Math.abs(window.__app!.brief().rollDeg) > 168, undefined, { polling: 50, timeout: 240_000 });
  await page.keyboard.up('KeyE');
  // SAS takes the roll rate out and holds what is left.
  await page.waitForFunction(
    async () => {
      const a = window.__app!.brief().rollDeg;
      await window.__test!.waitFrames(30);
      return Math.abs(window.__app!.brief().rollDeg - a) < 0.05;
    },
    undefined,
    { polling: 500, timeout: 120_000 },
  );
  const headsDown = await brief(page);
  console.log(`low orbit, heads down: roll ${roll0.toFixed(1)} -> ${headsDown.rollDeg.toFixed(1)} deg, pitch ${headsDown.pitchDeg.toFixed(1)} deg, SAS ${headsDown.sasMode}, RCS ${headsDown.rcsEnabled}`);
  expect(Math.abs(headsDown.rollDeg), 'the stack is heads-down').toBeGreaterThan(150);
  await shoot(page, 'leo-chase-heads-down', { minNonBlack: 0.2 });
  await viewKey(page, 'KeyC', 'interior');
  await waitIdle(page, 60, BOOT_MS);
  await page.waitForFunction(
    () => {
      const x = window.__app!.exposure();
      return Math.abs(x.ev100 - x.targetEv100) < 0.1;
    },
    undefined,
    { polling: 100, timeout: 30_000 },
  );
  const e = await page.evaluate(() => window.__app!.exposure());
  console.log(`leo cockpit: EV100 ${e.ev100.toFixed(2)} (target ${e.targetEv100.toFixed(2)}), sun visibility ${e.sunVisibility.toFixed(2)}, outside ${e.outsideFraction.toFixed(3)}`);
  await shoot(page, 'leo-cockpit', { minNonBlack: 0.03 });
  // V: the next couch (`ui:nextSeat`, request core-6). The view starts in the cockpit layout's default seat; the
  // key moves the eye, the HUD names the seat, and as many presses as there are seats bring it back.
  const seat0 = await page.evaluate(() => window.__app!.seat());
  expect(seat0, 'the cockpit view sits in a seat').not.toBeNull();
  const seats = [seat0];
  for (let i = 0; i < 8; i++) {
    await press(page, 'KeyV');
    await page.evaluate(() => window.__test!.waitFrames(6));
    const now = await page.evaluate(() => window.__app!.seat());
    if (now === seat0) break;
    seats.push(now);
    expect(await page.evaluate(() => window.__app!.notifications()), `the HUD names the seat ${now}`).toEqual(expect.arrayContaining([expect.stringMatching(/^Seat: /)]));
    if (seats.length === 2) await shoot(page, 'leo-cockpit-next-seat', { minNonBlack: 0.03 });
  }
  console.log(`cockpit seats, in the order of the V key: ${seats.join(' -> ')} -> ${seat0}`);
  expect(seats.length, 'the cabin has more than one seat to sit in').toBeGreaterThan(1);
  expect(new Set(seats).size).toBe(seats.length);
  expect(await page.evaluate(() => window.__app!.seat()), 'the key wraps round to the first seat').toBe(seat0);
  // In the chase view the key does nothing.
  await viewKey(page, 'KeyC', 'external');
  await press(page, 'KeyV');
  await viewKey(page, 'KeyC', 'interior');
  expect(await page.evaluate(() => window.__app!.seat())).toBe(seat0);
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

test('frame-exact capture: renderExact renders the frames asked for and holds the last (request lead-3)', async ({ page, pageLog }) => {
  // No HUD: its clock and read-outs are not part of a reference image of the scene.
  await openGame(page, '?hud=0');
  await waitIdle(page, 8, BOOT_MS);
  // The precondition of TestApi.renderExact: deterministic mode, presentation time frozen.
  await page.evaluate(() => {
    window.__test!.setPaused(true);
    window.__test!.setDeterministic(true);
  });
  expect(await page.evaluate(() => typeof window.__test!.renderExact)).toBe('function');
  const held = await page.evaluate(() => window.__test!.renderExact!(8));
  expect(held.frames).toBe(8);
  // The harness's capture (waits for idle, asks for 64 frames, takes the picture only of an idle capture).
  const first = await captureDeterministic(page, 64);
  // The hold: the display's frames go on counting, the game renders none and the picture does not change.
  const before = await page.evaluate(() => ({ game: window.__app!.frames(), ut: window.__app!.brief().ut }));
  await page.evaluate(() => window.__test!.waitFrames(40));
  const after = await page.evaluate(() => ({ game: window.__app!.frames(), ut: window.__app!.brief().ut }));
  expect(after.game, 'the game renders no frame of its own while the core holds').toBe(before.game);
  expect(after.ut).toBe(before.ut);
  const still = await page.screenshot();
  expect(pngDiff(first, still).maxAbsDiff, 'the held frame stays on screen').toBe(0);
  // A second capture of the same state, after a different history (the hold, 40 display frames): the same
  // picture to the bit, because every temporal sequence restarts (the core's, and each feature's `resetTemporal`
  // through the app's feature wrapper, request core-5). When it is not, the log says where the pictures differ
  // (a 4 x 4 grid of the frame, row by row from the top) and the difference is saved as a picture to look at.
  const second = await captureDeterministic(page, 64);
  const d = pngDiff(first, second);
  const info = await page.evaluate(() => window.__app!.exactInfo());
  console.log(`renderExact at the pad: two captures of 64 frames differ by max ${d.maxAbsDiff}, mean ${d.meanAbsDiff.toFixed(4)} of 255 (${(d.differingFraction * 100).toFixed(2)} % of the values); last capture: ${JSON.stringify(info)}`);
  const dir = await saveScreenshot(page, 'app', 'exact-pad');
  assertRealImage(dir.stats, 'exact-pad');
  if (d.maxAbsDiff > 0) {
    const [A, B] = [PNG.sync.read(first), PNG.sync.read(second)];
    const out = new PNG({ width: A.width, height: A.height });
    const cells = Array.from({ length: 16 }, () => ({ sum: 0, n: 0, max: 0 }));
    for (let y = 0; y < A.height; y++) {
      for (let x = 0; x < A.width; x++) {
        const i = (y * A.width + x) * 4;
        const e = Math.max(Math.abs(A.data[i]! - B.data[i]!), Math.abs(A.data[i + 1]! - B.data[i + 1]!), Math.abs(A.data[i + 2]! - B.data[i + 2]!));
        const c = cells[Math.min(3, Math.floor((4 * y) / A.height)) * 4 + Math.min(3, Math.floor((4 * x) / A.width))]!;
        c.sum += e;
        c.n++;
        if (e > c.max) c.max = e;
        // The difference sixteen times over, so that one level shows.
        out.data[i] = out.data[i + 1] = out.data[i + 2] = Math.min(255, e * 16);
        out.data[i + 3] = 255;
      }
    }
    fs.writeFileSync(path.join(path.dirname(dir.file), 'exact-pad-difference.png'), PNG.sync.write(out));
    for (let r = 0; r < 4; r++) console.log(`  difference, row ${r + 1} of 4 from the top (mean / max per cell, left to right): ${cells.slice(r * 4, r * 4 + 4).map((c) => `${(c.sum / c.n).toFixed(3)} / ${c.max}`).join('   ')}`);
  }
  // Leaving deterministic mode ends the hold: the game runs again.
  await page.evaluate(() => {
    window.__test!.setDeterministic(false);
    window.__test!.setPaused(false);
  });
  await page.waitForFunction((ut) => window.__app!.brief().ut > ut, after.ut, { polling: 100, timeout: 10_000 });
  expect(await page.evaluate(() => window.__app!.frames())).toBeGreaterThan(after.game);
  await expectNoErrors(page, pageLog);
  expect(d.maxAbsDiff, 'two frame-exact captures of the same state are the same picture (out/screens/app/exact-pad-difference.png shows where they are not)').toBe(0);
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
