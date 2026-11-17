/**
 * A/B of the display curve and the meter's bounds behind the render core's switch (RendererOptions.look;
 * requests ocean-10 and ocean-13): every scene of the lead's list rendered with the switch off and on, one
 * contact sheet per scene under out/screens/core-support/curve-ab/ (old left, new right, 2560 x 1440 reduced
 * by two), with the numbers that matter per picture, and the meter's inputs of every scene recorded under
 * .../meter/ for replaying its rules outside the browser (out/core-support/core_support_meter_replay.ts).
 *
 * Not a check: it asserts only that each page rendered. It is run by hand through the gate:
 *   CURVE_AB=static   the eleven still scenes, both looks
 *   CURVE_AB=flights  the two flights of the real app (the dawn splashdown, the entry) with CURVE_AB_LOOK=1|2
 *                     (one look per run: a flight is minutes long); the sheet is made when both looks exist
 *   node tools/dev/heavy.mjs --class=gpu -- npx playwright test tests/browser/integration/curve-ab.spec.ts --project=functional
 * Without CURVE_AB every test skips itself.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { PNG } from 'pngjs';
import { applyRecipe, settleWorld, WORLD_VIEWS } from '../cockpit/world';
import { captureDeterministic, expect, openPage, test, waitIdle } from '../harness';
import { repoRoot } from './helpers';

const MODE = process.env['CURVE_AB'] ?? '';
const FLIGHT_LOOK = process.env['CURVE_AB_LOOK'] === '2' ? 2 : 1;
const OUT = path.join(repoRoot, 'out', 'screens', 'core-support', 'curve-ab');
const PAD = 'earth,18.987556,-155.603239';

test.use({ viewport: { width: 2560, height: 1440 } });
test.describe.configure({ timeout: 40 * 60_000 });

interface Numbers {
  look: number;
  ev100: number;
  targetEv100: number;
  /** Illuminance of the sun at the camera x the visible share of its disc, lux (0: no sun). */
  sunLux: number;
  /** Display levels (0..255) the curve in use gives a sunlit white (albedo 0.9, square to the sun), a sunlit 18 % grey and a pre-exposed 0.18, at this exposure. */
  sunlitWhite: number | null;
  sunlitGrey: number | null;
  midGrey: number;
  /** Of the picture: share of pixels with every channel at 250 or more, share with any channel at 255, median and 95th percentile of Rec.709 luminance of the decoded pixels (0..1, as out/qa/ref/INDEX.md states its numbers). */
  white: number;
  anyClipped: number;
  medianY: number;
  p95Y: number;
}

interface CoreHandle {
  look: number;
  displayLevel(x: number): number;
  renderer: { exposureInfo(): { ev100: number; targetEv100: number; exposure: number }; meterInput(): { sunIlluminance: number; sunVisibility: number } | null };
}

const readCore = (page: Page): Promise<{ look: number; ev100: number; targetEv100: number; sunLux: number; sunlitWhite: number | null; sunlitGrey: number | null; midGrey: number; input: unknown }> =>
  page.evaluate(() => {
    const c = (globalThis as unknown as { __core?: CoreHandle }).__core;
    if (!c) throw new Error('no __core on this page: open it with coredebug=1');
    const e = c.renderer.exposureInfo();
    const m = c.renderer.meterInput();
    const sun = m ? m.sunIlluminance * m.sunVisibility : 0;
    return {
      look: c.look,
      ev100: e.ev100,
      targetEv100: e.targetEv100,
      sunLux: sun,
      sunlitWhite: sun > 1 ? c.displayLevel(((0.9 * sun) / Math.PI) * e.exposure) : null,
      sunlitGrey: sun > 1 ? c.displayLevel(((0.18 * sun) / Math.PI) * e.exposure) : null,
      midGrey: c.displayLevel(0.18),
      input: m,
    };
  });

function pictureNumbers(png: Buffer): { white: number; anyClipped: number; medianY: number; p95Y: number } {
  const img = PNG.sync.read(png);
  const lin = (v: number): number => {
    const x = v / 255;
    return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  };
  const table = Array.from({ length: 256 }, (_, i) => lin(i));
  const hist = new Uint32Array(1001);
  let white = 0;
  let any = 0;
  const n = img.width * img.height;
  for (let i = 0; i < n; i++) {
    const r = img.data[4 * i]!;
    const g = img.data[4 * i + 1]!;
    const b = img.data[4 * i + 2]!;
    if (r >= 250 && g >= 250 && b >= 250) white++;
    if (r === 255 || g === 255 || b === 255) any++;
    hist[Math.round(1000 * (0.2126 * table[r]! + 0.7152 * table[g]! + 0.0722 * table[b]!))]!++;
  }
  const pct = (p: number): number => {
    let acc = 0;
    for (let k = 0; k <= 1000; k++) {
      acc += hist[k]!;
      if (acc >= p * n) return k / 1000;
    }
    return 1;
  };
  return { white: white / n, anyClipped: any / n, medianY: pct(0.5), p95Y: pct(0.95) };
}

const caption = (n: Numbers): string =>
  `EV100 ${n.ev100.toFixed(2)} &middot; sunlit white ${n.sunlitWhite === null ? 'no sun' : `${n.sunlitWhite.toFixed(0)} of 255`} &middot; sunlit 18 % grey ${n.sunlitGrey === null ? '-' : n.sunlitGrey.toFixed(0)} &middot; pre-exposed 0.18 at ${n.midGrey.toFixed(0)} &middot; white pixels ${(100 * n.white).toFixed(2)} % (any channel at 255: ${(100 * n.anyClipped).toFixed(2)} %) &middot; picture median Y ${n.medianY.toFixed(3)}, p95 ${n.p95Y.toFixed(3)}`;

/** One contact sheet: rows of cells (picture + caption), a title above and the reference photograph's numbers below. */
async function sheet(page: Page, file: string, title: string, rows: { label: string; png: Buffer; caption: string }[][], reference: string, cellWidth: number): Promise<void> {
  const cell = (c: { label: string; png: Buffer; caption: string }): string =>
    `<figure><div class="l">${c.label}</div><img width="${cellWidth}" height="${Math.round((cellWidth * 9) / 16)}" src="data:image/png;base64,${c.png.toString('base64')}"><figcaption>${c.caption}</figcaption></figure>`;
  const html = `<!doctype html><meta charset="utf-8"><style>
    body{margin:0;background:#111;color:#ddd;font:15px/1.35 system-ui,Segoe UI,sans-serif}
    h1{font-size:20px;margin:10px 12px 6px;font-weight:600} .row{display:flex;gap:8px;padding:0 8px 8px}
    figure{margin:0;width:${cellWidth}px} img{display:block} .l{font-weight:600;padding:3px 2px;color:#fff}
    figcaption{padding:4px 2px;font-size:13px;color:#bbb} p{margin:2px 12px 12px;color:#9c9;font-size:13px;max-width:${2 * cellWidth}px}
  </style><h1>${title}</h1>${rows.map((r) => `<div class="row">${r.map(cell).join('')}</div>`).join('')}<p>Reference (out/qa/ref/INDEX.md): ${reference}</p>`;
  const columns = Math.max(...rows.map((r) => r.length));
  await page.setViewportSize({ width: columns * cellWidth + (columns + 1) * 8, height: 900 });
  await page.setContent(html, { waitUntil: 'load' });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, await page.screenshot({ fullPage: true }));
  await page.setViewportSize({ width: 2560, height: 1440 });
}

/** The exposure has arrived at the meter's target (a page that meters; a held or overridden exposure passes at once). */
async function exposureSettled(page: Page, tolerance = 0.03, maxFrames = 1500): Promise<void> {
  for (let waited = 0; waited < maxFrames; waited += 30) {
    const e = await readCore(page);
    if (Math.abs(e.ev100 - e.targetEv100) <= tolerance) return;
    await page.evaluate(() => window.__test!.waitFrames(30));
  }
}

interface Still {
  id: string;
  title: string;
  /** Page path and query, without the switches this spec adds. */
  url: string;
  /** After the page has loaded: place the view and wait; returns the picture if the page takes it itself (a frame-exact capture). */
  setup(page: Page): Promise<Buffer | void>;
  reference: string;
}

const orbitStack = (page: Page, yaw: number, pitch: number, distance: number): Promise<void> =>
  page.evaluate(
    ([y, p, d]) => {
      const lab = window.__integration!;
      const e = lab.vesselExtent() ?? { yMin: 0, yMax: 0 };
      lab.orbitVesselPoint(y!, p!, d!, 0.5 * (e.yMin + e.yMax));
    },
    [yaw, pitch, distance],
  );

const STILLS: Still[] = [
  {
    id: '01-pad-noon',
    title: 'The pad at noon (integration lab, the reference checkpoint pad-noon)',
    url: `/labs/integration/?scene=pad&sun=180,65&sunsite=${PAD}&hud=0&governor=off&deterministic=1&paused=1`,
    setup: (page) => captureDeterministic(page, 64, 300_000),
    reference: 'launch-pad/sls-pad-blue-sky.jpg: "Sky goes from Y 0.15 (80,108,156) up high to Y 0.33 (141,152,168) near the horizon. The white core stage in sun is Y 0.63, the concrete hardstand Y 0.18 (119,104,88) and the grass Y 0.09 olive."; section: "sunlit concrete apron Y 0.26-0.45"',
  },
  {
    id: '02-liftoff-flame',
    title: 'The lift-off flame (integration lab, first stage at full throttle on the mount)',
    url: '/labs/integration/?scene=pad&stage=1&throttle=1&hud=0&scale=1&governor=off',
    setup: async (page) => {
      await orbitStack(page, 35, 8, 190);
      await waitIdle(page, 120, 300_000);
    },
    reference: 'liftoff-ascent/apollo4-liftoff.jpg: "Y ~0.67 at the base and clipped at the core, ~10x the blue sky (9,72,141)"; artemis2-launch-2.jpg: "the plume is only modestly brighter than the white clouds and steam (0.8% clipped)"; section: "the plume core is clipped (Y 1.0) in EVERY exposure. By day it is ~9-10x the sky"',
  },
  {
    id: '03-cockpit-sun-patch',
    title: 'The cockpit with a sun patch on the console (integration lab, the cockpit recipe world-leo-sun-patch-console)',
    url: '/labs/integration/?scene=lowOrbit&roll=180&hud=0&paused=1',
    setup: async (page) => {
      await page.evaluate(() => window.__test!.waitFrames(5));
      await applyRecipe(page, WORLD_VIEWS.find((v) => v.name === 'world-leo-sun-patch-console')!.recipe);
      await settleWorld(page);
    },
    reference: 'cockpit-interiors/aldrin-lm-interior.jpg: "The window is blown out (Y 0.7 to clipped), the shaded cabin Y 0.03: ~22x."; apollo7-schirra-inflight.jpg: "(p95 Y 0.62) ... (face 8x the cabin). The cabin around is dark (Y 0.03)"',
  },
  {
    id: '04-leo-cloud-tops',
    title: 'Low orbit over the day side, cloud tops (integration lab, the reference checkpoint leo-day)',
    url: '/labs/integration/?scene=lowOrbit&orbit=30,15,60&hud=0&governor=off&deterministic=1&paused=1',
    setup: (page) => captureDeterministic(page, 64, 300_000),
    reference: 'earth-orbit-clouds/cloud-gazing-pacific.jpg: "Ocean is Y 0.042, rgb (25,60,95); cloud median Y 0.39 and p95 0.62, about 15x the ocean."; building-cb.jpg: "Lit tops clip (2.6% of pixels)"; thunderheads-borneo.jpg: "Sea is Y 0.044 (31,62,87) and tower tops p95 Y 0.72, about 16x."',
  },
  ...(['alt3k', 'leo'] as const).map(
    (preset, i): Still => ({
      id: `05${'ab'[i]}-glint-${preset === 'alt3k' ? '3km' : 'orbit'}`,
      title: `The sun's glint on the sea from ${preset === 'alt3k' ? '3 km' : 'orbit (400 km)'} (ocean lab, preset ${preset})`,
      url: `/labs/ocean/?preset=${preset}`,
      setup: async (page) => {
        await page.evaluate(() => document.body.classList.add('shot'));
        await page.evaluate(() => window.__test!.waitFrames(90));
        await page.evaluate(() => window.__test!.setDeterministic(true));
        await waitIdle(page, 40, 300_000);
      },
      reference:
        preset === 'alt3k'
          ? 'earth-orbit-ocean/glint-from-aircraft-hawaii.jpg: "a column of discrete clipped sparkles (Y 1.0) ... (Y 0.016, rgb 31,33,34), at least 39x darker"'
          : 'earth-orbit-ocean/florida-bahamas-glint.jpg: "Core Y 0.32 (p95 0.73) ... off-glint sea Y 0.042 ... ~7.5x"; glint-clouds-south-america.jpg: "Glint core Y 0.51 ... sea off the glint Y 0.061 ... about 8.3x"; cloudscape-philippine-sea.jpg: "glint area reaches Y 0.74"',
    }),
  ),
  {
    id: '06-frosted-stage',
    title: 'The frosted stage before launch (vehicle lab, frost-prelaunch)',
    url: '/labs/vehicle/?hud=0&governor=off&scene=pad&site=0&sun=120,35&eye=18,-60,-30&at=0,-66,0&fov=40',
    setup: async (page) => {
      await page.waitForFunction(() => (window as unknown as { __veh?: unknown }).__veh !== undefined, undefined, { timeout: 240_000 });
      await page.evaluate(() => window.__test!.setDeterministic(false));
      await waitIdle(page, 72, 300_000);
    },
    reference: 'no photograph of frost in the index; nearest launch-pad/sls-artemis2-launchday.jpg (venting, no numbers) and launch-pad/sls-pad-blue-sky.jpg: "The white core stage in sun is Y 0.63"',
  },
  {
    id: '07-lunar-surface',
    title: 'The lunar surface under a low sun (integration lab, the terrain view integrated-game-lunar-surface)',
    url: '/labs/integration/?features=all&scene=lunarSurface&paused=1&sun=92,11&sunsite=moon,0.661471,23.435999&hud=0',
    setup: (page) => waitIdle(page, 20, 300_000),
    reference: 'moon-surface/aldrin-visor.jpg: "Low sun (~15 deg) ... Regolith Y 0.38 (160,162,165) is neutral; the sky is black (Y 0.003)."; section: "Black sky Y 0.003 is ~1/130 of sunlit regolith."',
  },
  {
    id: '08-splashdown-overcast',
    title: 'Splashdown under overcast (integration lab, the ocean view overcast-sea-sun35)',
    url: '/labs/integration/?scene=chutes&start=40&hud=0&governor=off&scale=1&at=-36,85&sun=25,35&sunsite=earth,-36,85',
    setup: async (page) => {
      await page.evaluate(() => window.__test!.waitFrames(420));
      await page.evaluate(() => window.__integration!.orbitVesselPoint(25, 6, 26, 2));
      await page.evaluate(() => window.__test!.waitFrames(90));
      await waitIdle(page, 30, 300_000);
    },
    reference: 'sea-surface-close/rough-sea-nato.jpg: "About 6% of the sea area is foam ... Sea Y 0.13 (85,95,104) is 0.2x the overcast sky (207,211,215)."; sky-ground-clouds/overcast-landscape.jpg: "cloud p5-p95 Y 0.136-0.243 (1.8x)"',
  },
  {
    id: '11a-night-side-from-orbit',
    title: "The Earth's night side from orbit (integration lab, the reference checkpoint leo-night)",
    url: '/labs/integration/?scene=lowOrbit&orbit=30,15,60&hud=0&governor=off&deterministic=1&paused=1',
    setup: async (page) => {
      await page.evaluate(() => window.__integration!.setSunInVesselFrame({ x: 0, y: 0, z: -1 }));
      await waitIdle(page, 8, 300_000);
      return captureDeterministic(page, 64, 300_000);
    },
    reference: 'earth-orbit-clouds/airglow-red-yellow.jpg: "median scene Y 0.014, brightest clouds Y 0.19"; limb-panorama.jpg: "sky Y 0.008, airglow peak Y 0.16 ... (Y ~0.015)"',
  },
  {
    id: '11b-pad-at-night',
    title: 'The pad at night under its floodlights (integration lab, the sun 24 degrees under the horizon)',
    url: `/labs/integration/?scene=pad&sun=290,-24&sunsite=${PAD}&hud=0&scale=1&governor=off`,
    setup: async (page) => {
      await orbitStack(page, 35, 8, 190);
      await waitIdle(page, 120, 300_000);
    },
    reference: 'liftoff-ascent/artemis1-launch-1.jpg (a night pad, with a plume): "scene median Y 0.025, night sky Y 0.006 (~175x) ... towers are lit warm (Y 0.055) ... 8% of pixels clip"',
  },
];

const withSwitches = (url: string, look: number): string => `${url}&coredebug=1${look === 2 ? '&corelook=2' : ''}`;

for (const s of STILLS) {
  test(`curve A/B: ${s.id}`, async ({ page }) => {
    test.skip(MODE !== 'static', 'CURVE_AB=static runs the still scenes');
    const cells: { label: string; png: Buffer; caption: string }[] = [];
    const record: { scene: string; samples: { label: string; t: number; ev100: number; input: unknown }[]; numbers: Numbers[] } = { scene: s.id, samples: [], numbers: [] };
    for (const look of [1, 2]) {
      await openPage(page, withSwitches(s.url, look), { timeoutMs: 300_000 });
      const taken = await s.setup(page);
      if (!taken) await exposureSettled(page);
      const png = taken ?? (await page.screenshot());
      const core = await readCore(page);
      expect(core.look, `${s.id}: the page runs look ${look}`).toBe(look);
      const numbers: Numbers = { look, ev100: core.ev100, targetEv100: core.targetEv100, sunLux: core.sunLux, sunlitWhite: core.sunlitWhite, sunlitGrey: core.sunlitGrey, midGrey: core.midGrey, ...pictureNumbers(png) };
      record.numbers.push(numbers);
      if (look === 1) record.samples.push({ label: s.id, t: 0, ev100: core.ev100, input: core.input });
      fs.mkdirSync(path.join(OUT, 'single'), { recursive: true });
      fs.writeFileSync(path.join(OUT, 'single', `${s.id}-look${look}.png`), png);
      cells.push({ label: look === 1 ? 'as it is (look 1)' : 'the camera curve and the meter\'s bounds (look 2)', png, caption: caption(numbers) });
      console.log(`[curve-ab] ${s.id} look ${look}: ${caption(numbers).replace(/&middot;/g, '|')}`);
    }
    fs.mkdirSync(path.join(OUT, 'meter'), { recursive: true });
    fs.writeFileSync(path.join(OUT, 'meter', `${s.id}.json`), JSON.stringify(record));
    await sheet(page, path.join(OUT, `${s.id}.png`), s.title, [cells], s.reference, 1280);
  });
}

// ------------------------------------------------------------------------------------------ the two flights

interface AppHooks {
  brief(): { altitudeAsl: number; situation: string; warpFactor: number };
  setPictureStops(stops: { id: string; trigger: Record<string, unknown>; seconds?: number }[]): void;
  pictureStop(): { id: string } | null;
  resumeFromPictureStop(): void;
}
const app = (): AppHooks => (window as unknown as { __app: AppHooks }).__app;

interface FlightShot {
  label: string;
  png: Buffer;
  numbers: Numbers;
}

/** Keep what a flight with one look produced, and make the sheet once both looks have flown. */
async function flightSheet(page: Page, id: string, title: string, shots: FlightShot[], samples: { label: string; t: number; ev100: number; input: unknown }[], reference: string): Promise<void> {
  const dir = path.join(OUT, 'flights');
  fs.mkdirSync(dir, { recursive: true });
  shots.forEach((s, i) => fs.writeFileSync(path.join(dir, `${id}-look${FLIGHT_LOOK}-${i}.png`), s.png));
  fs.writeFileSync(path.join(dir, `${id}-look${FLIGHT_LOOK}.json`), JSON.stringify(shots.map((s) => ({ label: s.label, numbers: s.numbers }))));
  if (FLIGHT_LOOK === 1) {
    fs.mkdirSync(path.join(OUT, 'meter'), { recursive: true });
    fs.writeFileSync(path.join(OUT, 'meter', `${id}.json`), JSON.stringify({ scene: id, samples }));
  }
  const rows: { label: string; png: Buffer; caption: string }[][] = [];
  for (const look of [1, 2]) {
    const meta = path.join(dir, `${id}-look${look}.json`);
    if (!fs.existsSync(meta)) return;
    const list = JSON.parse(fs.readFileSync(meta, 'utf8')) as { label: string; numbers: Numbers }[];
    rows.push(list.map((m, i) => ({ label: `${look === 1 ? 'as it is' : 'look 2'}: ${m.label}`, png: fs.readFileSync(path.join(dir, `${id}-look${look}-${i}.png`)), caption: caption(m.numbers) })));
  }
  await sheet(page, path.join(OUT, `${id}.png`), title, rows, reference, 640);
}

const shotOf = async (page: Page, label: string): Promise<FlightShot & { input: unknown }> => {
  const png = await page.screenshot();
  const core = await readCore(page);
  return { label, png, numbers: { look: core.look, ev100: core.ev100, targetEv100: core.targetEv100, sunLux: core.sunLux, sunlitWhite: core.sunlitWhite, sunlitGrey: core.sunlitGrey, midGrey: core.midGrey, ...pictureNumbers(png) }, input: core.input };
};

test('curve A/B: 09-splashdown-at-dawn (the real app, the test pilot down to the water; before the contact, +3 s, +8 s, +15 s of wall time)', async ({ page }) => {
  test.skip(MODE !== 'flights', 'CURVE_AB=flights runs the two flights');
  await openPage(page, withSwitches('/?scenario=qa-drogues&pilot=1&view=chase&scale=1&governor=off&mute=1&capture=0&hud=0', FLIGHT_LOOK), { timeoutMs: 300_000 });
  await page.waitForFunction(() => (window as unknown as { __app: AppHooks }).__app.brief().altitudeAsl < 150, undefined, { timeout: 15 * 60_000, polling: 250 });
  const shots: FlightShot[] = [];
  const samples: { label: string; t: number; ev100: number; input: unknown }[] = [];
  const wanted = [3, 8, 15];
  const t0 = Date.now();
  let contact: number | null = null;
  for (;;) {
    const t = (Date.now() - t0) / 1000;
    const b = await page.evaluate(() => (window as unknown as { __app: AppHooks }).__app.brief());
    const core = await readCore(page);
    const down = b.situation === 'splashed' || b.altitudeAsl < 1.5;
    if (shots.length === 0) shots.push(await shotOf(page, `before the contact (${b.altitudeAsl.toFixed(0)} m)`));
    if (contact === null && down) contact = t;
    samples.push({ label: contact === null ? `down to the water, ${b.altitudeAsl.toFixed(0)} m` : `contact +${(t - contact).toFixed(1)} s`, t, ev100: core.ev100, input: core.input });
    if (contact !== null && wanted.length > 0 && t - contact >= wanted[0]!) shots.push(await shotOf(page, `contact +${wanted.shift()} s (wall)`));
    if (contact !== null && t - contact > 16.5) break;
    if (contact === null && t > 600) throw new Error('no contact with the water in 600 s');
  }
  const evs = samples.filter((s) => s.label.startsWith('contact')).map((s) => s.ev100);
  console.log(`[curve-ab] 09-splashdown-at-dawn look ${FLIGHT_LOOK}: EV100 before the contact ${shots[0]!.numbers.ev100.toFixed(2)}; after it ${Math.min(...evs).toFixed(2)} .. ${Math.max(...evs).toFixed(2)}; ${shots.map((s) => `${s.label}: EV ${s.numbers.ev100.toFixed(2)}, median Y ${s.numbers.medianY.toFixed(3)}`).join('; ')}`);
  await flightSheet(
    page,
    '09-splashdown-at-dawn',
    'Splashdown at dawn with the canopies in frame (the real app, scenario qa-drogues; wall time after the contact, physics warp x4)',
    shots,
    samples,
    'no dawn photograph in the index; reentry-chutes/artemis2-mains.jpg: "canopies are darker than the sky (white stripes Y ~0.36 in the translucent shade)"; sea-surface-close/artemis2-floating-2.jpg: "Sky just above the horizon Y 0.56 ... sea just below the horizon Y 0.25 ... 0.45x ... sea near the camera Y 0.073 ... 0.13x"; soyuz-ms17-chute.jpg: "Canopy in sun Y 0.56 ... canopy/ground 3.65x"',
  );
});

test('curve A/B: 10-entry (the real app, scenario qa-entry flown by the test pilot; peak heating and peak g)', async ({ page }) => {
  test.skip(MODE !== 'flights', 'CURVE_AB=flights runs the two flights');
  await openPage(page, withSwitches('/?scenario=qa-entry&pilot=1&view=chase&scale=1&governor=off&mute=1&capture=0&hud=0', FLIGHT_LOOK), { timeoutMs: 300_000 });
  await page.evaluate(() =>
    (window as unknown as { __app: AppHooks }).__app.setPictureStops([
      { id: 'peak-heating', trigger: { peak: 'heatFlux', floor: 1e6, drop: 0.03 } },
      { id: 'peak-g', trigger: { peak: 'gLoad', floor: 3, drop: 0.05 } },
    ]),
  );
  const shots: FlightShot[] = [];
  const samples: { label: string; t: number; ev100: number; input: unknown }[] = [];
  const t0 = Date.now();
  let seen = 0;
  while (seen < 2) {
    const t = (Date.now() - t0) / 1000;
    if (t > 25 * 60) throw new Error(`the entry did not reach its ${seen === 0 ? 'peak heating' : 'peak g'} in 25 minutes`);
    const stop = await page.evaluate(() => (window as unknown as { __app: AppHooks }).__app.pictureStop()?.id ?? null);
    const b = await page.evaluate(() => (window as unknown as { __app: AppHooks }).__app.brief());
    const core = await readCore(page);
    samples.push({ label: stop ? `stop ${stop}` : `${(b.altitudeAsl / 1000).toFixed(1)} km`, t, ev100: core.ev100, input: core.input });
    // Before the sheath, while the thrusters hold the attitude: the frame as the camera has it then (not held).
    if (shots.length === 0 && !stop && b.altitudeAsl < 135_000) shots.push(await shotOf(page, `before the sheath, thrusters holding the attitude (${(b.altitudeAsl / 1000).toFixed(0)} km, in flight)`));
    if (stop) {
      await exposureSettled(page, 0.1, 600);
      const s = await shotOf(page, `${stop === 'peak-heating' ? 'peak heating' : 'peak g'} (${(b.altitudeAsl / 1000).toFixed(1)} km)`);
      shots.push(s);
      samples.push({ label: `settled at ${stop}`, t: (Date.now() - t0) / 1000, ev100: s.numbers.ev100, input: s.input });
      seen++;
      await page.evaluate(() => (window as unknown as { __app: AppHooks }).__app.resumeFromPictureStop());
      await page.evaluate(() => window.__test!.waitFrames(10));
    } else {
      await page.waitForTimeout(700);
    }
  }
  console.log(`[curve-ab] 10-entry look ${FLIGHT_LOOK}: ${shots.map((s) => `${s.label}: EV ${s.numbers.ev100.toFixed(2)}, white pixels ${(100 * s.numbers.white).toFixed(1)} %, median Y ${s.numbers.medianY.toFixed(3)}`).join('; ')}`);
  await flightSheet(
    page,
    '10-entry',
    'Entry on the night side: peak heating and peak g (the real app, scenario qa-entry)',
    shots,
    samples,
    'no exterior photograph of a plasma sheath in the index; reentry-chutes/eft1-plasma-side-window.jpg (from inside): "pink-magenta to salmon field (mean rgb 120,95,109) ... hot white-yellow core at the window edge"',
  );
});
