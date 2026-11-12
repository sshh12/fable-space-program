import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { PNG } from 'pngjs';
import { assertDiscreteGpu, assertRealImage, expect, expectNoErrors, openPage, saveScreenshot, test, type PageLog } from '../harness';

/**
 * Screenshots of every FakeSim scene with the full flight HUD at 1280 x 720 and 3840 x 2160, plus the
 * cockpit and map views, the key-help overlay, the mission-failed banner and the six MFD pages, saved to
 * out/screens/flight-ui/ for review by eye. Also: the HUD over the backdrop's worst case (a near-white cloud
 * deck / regolith and a pale sky) with a measured label contrast and plate uniformity, the coverage budget of
 * the HUD in every external scene, the active stage's tile, views that show markers off the nose, a real roll,
 * the g tube in its amber and red zones with the g-dose bar and the lift-vector marker, and the MFD pages at
 * 512 x 384 shown 1 : 1.
 */
const SCENES: [string, string][] = [
  ['pad', 'target=moon'],
  // Each scene carries the lab's coherent flight state (mission time, a powered climb, an entry whose q, height,
  // heating and sink match its g, a predicted impact only where the vessel comes down, the gear down after the
  // gear stage).
  ['ascent', ''],
  ['lowOrbit', 'node=1'],
  ['translunar', ''],
  ['lunarOrbit', ''],
  ['lunarSurface', ''],
  ['reentry', ''],
  ['chutes', ''],
];

/**
 * Stills of the real renderer (the integration package's flight views, 2560 x 1440, no HUD of their own) shown
 * behind the HUD in place of the lab backdrop, each with the FakeSim scene it was rendered from and the flight state
 * of that render, given with the integration lab's own parameters (tests/browser/integration/budget.perf.spec.ts
 * SCENES): the lift-off on the mount, the climb from 12 km at full throttle, the lander hovering 12 m over the
 * target on its descent engine, the last 120 m under the mains over the sea.
 */
const REAL_STILLS: [string, string, string][] = [
  ['pad', 'stage=1&throttle=1', '/out/screens/integration/budget-pad-lift-off.png'],
  ['ascent', 'start=12000&throttle=1', '/out/screens/integration/budget-ascent-10-40-km.png'],
  ['lowOrbit', 'node=1', '/out/screens/integration/budget-leo.png'],
  ['lunarSurface', 'throttle=0.4&hover=12', '/out/screens/integration/budget-lunar-descent.png'],
  ['reentry', '', '/out/screens/integration/budget-reentry.png'],
  ['chutes', 'start=120&ground=0', '/out/screens/integration/budget-splashdown.png'],
];
const repoPath = (url: string): string => path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', ...url.split('/').filter(Boolean));

/**
 * The flight state reads as one: the mission clock runs (only the pad before lift-off reads T+ 00:00:00), no text
 * on screen is a debug word of the lab, a vessel standing on the ground reads a radar altitude of about zero, a
 * vessel sinking faster than 50 m/s is on a path that meets the surface, a steady sink of less than 15 m/s through
 * the air comes only under the main chutes (every chute stage fired), and the mass is that of the parts carried.
 */
async function expectCoherentState(page: Page, scene: string): Promise<void> {
  const met = (await page.locator('.hud .clock .met').textContent())!.replace(/\s/g, ' ');
  if (scene === 'pad') expect(met, 'pad MET').toMatch(/^T\+ 00:00:00$/);
  // (The lift-off still shows the first seconds after the first stage fired.)
  else if (scene !== 'pad lift-off') expect(met, `${scene}: the mission clock runs`).not.toMatch(/^T\+ 00:00:0\d$/);
  const text = await page.locator('.hud').evaluate((e) => (e as HTMLElement).innerText);
  expect(text, `${scene}: no lab words on screen`).not.toMatch(/\blab\b|decoration|\bnone\b/i);
  const s = await page.evaluate(() => window.__test!.state()!);
  const r = s.readouts;
  const v = s.vessels.find((x) => x.id === s.activeVesselId)!;
  if (v.situation === 'landed' || v.situation === 'splashed') expect(r.altitudeRadar, `${scene}: radar altitude when landed`).toBeLessThan(5);
  if (r.verticalSpeed < -50) expect(r.periapsisAltitude, `${scene}: sinking at ${r.verticalSpeed.toFixed(0)} m/s on a path that meets the surface`).toBeLessThan(0);
  if (r.dynamicPressure > 0 && r.verticalSpeed < 0 && r.verticalSpeed > -15 && v.situation === 'flying' && r.thrust === 0) {
    const chutes = s.staging.stages.filter((x) => x.actionKinds.includes('deployParachute'));
    expect(chutes.length, `${scene}: chute stages`).toBeGreaterThan(0);
    for (const c of chutes) expect(c.fired, `${scene}: a ${(-r.verticalSpeed).toFixed(1)} m/s sink needs "${c.label}" fired`).toBe(true);
  }
  expect(v.mass, `${scene}: the snapshot's mass is the readout`).toBeCloseTo(r.mass, 3);
  expect(r.mass, `${scene}: not the FakeSim's constant 50 t`).not.toBe(50000);
  // Round 6 (the whole mission in the real app): no Mach number outside an atmosphere (the Moon, or above the
  // Earth's 140 km simulated top), the chute light names its chutes, the lift vector only in the heating entry,
  // and no title-cased milestone id ("Tli Complete") in a toast.
  if (v.bodyId !== 'earth' || r.altitudeAsl > 140_000) expect(text, `${scene}: no Mach number in vacuum`).not.toMatch(/\bM\s[\d.]+\b/);
  const chuteRow = page.locator('.hud .entry .row', { has: page.locator('.light') });
  if (await chuteRow.isVisible()) await expect(chuteRow.locator('.lbl'), `${scene}: chute light names its chutes`).toHaveText(/^(Drogue|Main) deploy$/);
  if (await page.locator('.hud .entry .lift').isVisible()) expect(r.heatFlux, `${scene}: lift vector only while the entry heats up`).toBeGreaterThan(1000);
  expect(text, `${scene}: milestones by their names`).not.toMatch(/\b(Tli|Soi)\b/);
}

/** The cockpit package's seat view in low orbit (16:9), shown behind the interior layout. */
const CABIN_STILL_URL = '/out/screens/cockpit/perf-1440p-leo-seat.png';
const CABIN_STILL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', ...CABIN_STILL_URL.split('/').filter(Boolean));

/** Largest share of a 16:9 frame the HUD may cover in an external view (plates, tiles, chips and the ball). */
const COVERAGE_BUDGET = 0.2;

async function shoot(page: Page, log: PageLog, url: string, name: string, frames = 30): Promise<Buffer> {
  await openPage(page, url);
  await assertDiscreteGpu(page);
  await page.evaluate((n) => window.__test!.waitFrames(n), frames);
  const shot = await saveScreenshot(page, 'flight-ui', name);
  assertRealImage(shot.stats, name, { minNonBlack: 0.05, minStd: 8, minBuckets: 40 });
  await expectNoErrors(page, log);
  return shot.buffer;
}

const lin = (c: number): number => {
  const x = c / 255;
  return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
};
const luminance = (r: number, g: number, b: number): number => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);

/**
 * WCAG contrast of every visible row label against its panel, measured on the screenshot: the text is the
 * brightest pixel inside the label's box (glyph cores), the plate the median pixel (most of the box).
 */
async function labelContrasts(page: Page, png: Buffer): Promise<{ text: string; ratio: number }[]> {
  const img = PNG.sync.read(png);
  const boxes = await page.locator('.hud .lcol .lbl, .hud .rcol .rn, .hud .lcol .ptitle > span:first-child, .hud .rcol .ptitle > span:first-child, .hud .lcol .ut, .hud .lcol .ltline, .hud .rcol .full, .hud .rcol .tile .meta').evaluateAll((els) =>
    els.filter((e) => e.getClientRects().length > 0 && (e.textContent ?? '').trim().length > 0).map((e) => ({ text: e.textContent!.trim(), r: e.getBoundingClientRect().toJSON() as DOMRect })),
  );
  const out: { text: string; ratio: number }[] = [];
  for (const b of boxes) {
    const lum: number[] = [];
    for (let y = Math.ceil(b.r.top); y < Math.floor(b.r.bottom); y++) {
      for (let x = Math.ceil(b.r.left); x < Math.floor(b.r.right); x++) {
        const i = (y * img.width + x) * 4;
        lum.push(luminance(img.data[i]!, img.data[i + 1]!, img.data[i + 2]!));
      }
    }
    if (lum.length < 20) continue;
    lum.sort((a, c) => a - c);
    const bg = lum[Math.floor(lum.length / 2)]!;
    const fg = lum[lum.length - 1]!;
    out.push({ text: b.text, ratio: (fg + 0.05) / (bg + 0.05) });
  }
  return out;
}

/**
 * Share of the frame the HUD covers, from the layout: every visible plate, tile, pill and read-out chip as its
 * box, and the navball instrument as the disc of its bezel, rasterised into one mask (overlaps count once).
 */
async function hudCoverage(page: Page): Promise<number> {
  return page.evaluate(() => {
    const W = innerWidth;
    const H = innerHeight;
    const mask = new Uint8Array(W * H);
    const visible = (e: Element): boolean => e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden';
    const boxes = [...document.querySelectorAll('.hud .panel, .hud .later, .hud .tile:not(.compact), .hud .pill, .hud .helpbtn, .hud .more, .hud .housing, .hud .prw, .hud .toast')].filter(visible);
    for (const e of boxes) {
      const r = e.getBoundingClientRect();
      for (let y = Math.max(0, Math.floor(r.top)); y < Math.min(H, Math.ceil(r.bottom)); y++) mask.fill(1, y * W + Math.max(0, Math.floor(r.left)), y * W + Math.min(W, Math.ceil(r.right)));
    }
    const ball = document.querySelector('.hud .ball');
    if (ball && visible(ball)) {
      const r = ball.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      const R = (r.width / 2) * 0.985;
      for (let y = Math.floor(cy - R); y <= Math.ceil(cy + R); y++) {
        if (y < 0 || y >= H) continue;
        const half = Math.sqrt(Math.max(0, R * R - (y + 0.5 - cy) * (y + 0.5 - cy)));
        mask.fill(1, y * W + Math.max(0, Math.round(cx - half)), y * W + Math.min(W, Math.round(cx + half)));
      }
    }
    let n = 0;
    for (let i = 0; i < mask.length; i++) n += mask[i]!;
    return n / (W * H);
  });
}

/** Smallest text the HUD shows at 1280 x 720 (px): the hand-off's floor for anything that carries a value or a key. */
const TEXT_FLOOR_PX = 10;

/**
 * Every visible element of the HUD that holds text of its own, with its computed font size and whether that
 * text fits its box (a fixed-width read-out window or a contained line must not overflow).
 */
async function hudTexts(page: Page): Promise<{ text: string; size: number; overflow: number }[]> {
  return page.evaluate(() => {
    const out: { text: string; size: number; overflow: number }[] = [];
    for (const e of document.querySelectorAll('.hud *')) {
      if (!(e instanceof HTMLElement) || e.getClientRects().length === 0) continue;
      const own = [...e.childNodes].filter((n) => n.nodeType === Node.TEXT_NODE).map((n) => n.textContent ?? '').join('').trim();
      if (!own) continue;
      const cs = getComputedStyle(e);
      if (cs.visibility === 'hidden') continue;
      // Text wider than its box: measured on the text itself (a range), against the element's content box.
      const range = document.createRange();
      range.selectNodeContents(e);
      const t = range.getBoundingClientRect();
      const b = e.getBoundingClientRect();
      const overflow = Math.max(0, b.left - t.left, t.right - b.right);
      out.push({ text: own, size: parseFloat(cs.fontSize), overflow });
    }
    return out;
  });
}

async function expectTextFloor(page: Page, what: string): Promise<void> {
  const texts = await hudTexts(page);
  expect(texts.length, `${what}: HUD texts`).toBeGreaterThan(10);
  for (const t of texts) {
    expect(t.size, `${what}: font size of "${t.text}"`).toBeGreaterThanOrEqual(TEXT_FLOOR_PX - 0.05);
    expect(t.overflow, `${what}: "${t.text}" overflows its box (px)`).toBeLessThanOrEqual(1);
  }
}

/**
 * Fill of every visible plate along a column of its padding (no text there), below the plate's lit top
 * gradient: the spread in 8-bit levels of the brightest channel. A scene edge behind a plate shows up as spread.
 */
async function plateSpreads(page: Page, png: Buffer): Promise<{ cls: string; spread: number }[]> {
  const img = PNG.sync.read(png);
  // (The SAS controls and the gauges are regions of the housing, not plates: the housing is sampled instead.)
  const plates = await page.locator('.hud .lcol .panel, .hud .rcol .panel, .hud .later, .hud .tile.next, .hud .tile.active, .hud .bottom .panel:not(.sas):not(.gauges), .hud .housing').evaluateAll((els) =>
    els
      .filter((e) => e.getClientRects().length > 0)
      .map((e) => ({ cls: e.className, r: e.getBoundingClientRect().toJSON() as DOMRect, title: e.querySelector(':scope > .ptitle')?.getBoundingClientRect().bottom ?? -Infinity })),
  );
  return plates.map((p) => {
    const x = Math.round(p.r.left + 2);
    let lo = 255;
    let hi = 0;
    // Below the plate's lit top and below its title strip (a two-row panel is half title).
    for (let y = Math.ceil(Math.max(p.r.top + p.r.height * 0.45, p.title + 2)); y < Math.floor(p.r.bottom - 4); y++) {
      const i = (y * img.width + x) * 4;
      const v = Math.max(img.data[i]!, img.data[i + 1]!, img.data[i + 2]!);
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
    }
    return { cls: p.cls, spread: hi - lo };
  });
}

for (const [w, h, tag] of [
  [1280, 720, '720p'],
  [3840, 2160, '4k'],
] as const) {
  test.describe(`flight-ui screenshots ${tag}`, () => {
    test.use({ viewport: { width: w, height: h } });
    for (const [scene, extra] of SCENES) {
      test(`scene ${scene}`, async ({ page, pageLog }) => {
        await shoot(page, pageLog, `/labs/flight-ui/?scene=${scene}${extra ? `&${extra}` : ''}`, `${scene}-${tag}`);
        expect(await page.evaluate(() => window.__test!.page.name)).toBe('flight-ui');
        if (tag === '720p') {
          const c = await hudCoverage(page);
          console.log(`HUD coverage ${scene}: ${(c * 100).toFixed(1)} %`);
          expect(c, `${scene}: HUD coverage`).toBeLessThanOrEqual(COVERAGE_BUDGET);
          await expectTextFloor(page, scene);
          await expectCoherentState(page, scene);
        }
      });
    }
    for (const [scene, extra, still] of REAL_STILLS) {
      test(`scene ${scene} over the real renderer`, async ({ page, pageLog }) => {
        test.skip(!fs.existsSync(repoPath(still)), `needs ${repoPath(still)} (integration package screenshots)`);
        await shoot(page, pageLog, `/labs/flight-ui/?scene=${scene}${extra ? `&${extra}` : ''}&still=${encodeURIComponent(still)}`, `real-${scene}-${tag}`);
        if (tag === '720p') {
          expect(await hudCoverage(page), `${scene}: HUD coverage`).toBeLessThanOrEqual(COVERAGE_BUDGET);
          await expectTextFloor(page, `${scene} over the real renderer`);
          await expectCoherentState(page, scene === 'pad' ? 'pad lift-off' : scene);
        }
      });
    }
    test('markers off the nose and a 25 degree roll (normal, radial, anti-target, maneuver)', async ({ page, pageLog }) => {
      await shoot(page, pageLog, '/labs/flight-ui/?scene=lowOrbit&node=1&target=moon&attitude=24,-14,25', `attitude-lowOrbit-${tag}`);
    });
    test('high-g entry: g tube in its red zone, g-dose line, lift-vector marker, retrograde off the nose', async ({ page, pageLog }) => {
      // The instrument never moves through the flight's phases: the throttle and g tubes sit where they sit on the
      // pad, in the climb, in orbit and in the plain entry (the g-dose line is always there).
      const boxes: { scene: string; thr: { x: number; y: number; width: number; height: number }; g: { x: number; y: number; width: number; height: number } }[] = [];
      for (const scene of ['pad', 'ascent', 'lowOrbit', 'reentry']) {
        await openPage(page, `/labs/flight-ui/?scene=${scene}`);
        await page.evaluate(() => window.__test!.waitFrames(10));
        boxes.push({ scene, thr: (await page.locator('.hud .gauge.thr .tube').boundingBox())!, g: (await page.locator('.hud .gauge.g .tube').boundingBox())! });
      }
      // The plain entry's clock: the high-g view is a later moment of the same entry.
      const entryMet = (await page.locator('.hud .clock .met').textContent())!;
      await shoot(page, pageLog, '/labs/flight-ui/?scene=reentry&flight=0,11.2&dose=6.4&lift=35&attitude=-8,10,-18', `entry-highg-${tag}`);
      const g = (await page.locator('.hud .gauge.g .tube').boundingBox())!;
      const thr = (await page.locator('.hud .gauge.thr .tube').boundingBox())!;
      for (const b of boxes) {
        for (const k of ['x', 'y', 'width', 'height'] as const) {
          expect(Math.abs(g[k] - b.g[k]), `g tube ${k}: high-g entry against ${b.scene}`).toBeLessThanOrEqual(0.5);
          expect(Math.abs(thr[k] - b.thr[k]), `throttle tube ${k}: high-g entry against ${b.scene}`).toBeLessThanOrEqual(0.5);
        }
      }
      expect((await page.locator('.hud .clock .met').textContent())!, 'the high-g moment comes later in the entry').not.toBe(entryMet);
      const st = await page.evaluate(() => window.__test!.state()!);
      expect(st.readouts.gLoad).toBeGreaterThan(11);
      expect(st.readouts.periapsisAltitude, 'an entry meets the surface').toBeLessThan(0);
      // The dose has its own labelled tape inside the gauges panel: 6.4 of the 15 g s limit.
      const doseTube = page.locator('.hud .gauge.dose .tube');
      await expect(doseTube).toBeVisible();
      await expect(page.locator('.hud .gauge.dose .gl')).toHaveText(/dose/i);
      await expect(page.locator('.hud .gauge.dose .gv')).toHaveText(/^43\s%$/);
      const lb = (await page.locator('.hud .gauge.dose .gl').boundingBox())!;
      const pb = (await page.locator('.hud .gauges').boundingBox())!;
      expect(lb.x).toBeGreaterThanOrEqual(pb.x);
      expect(lb.x + lb.width).toBeLessThanOrEqual(pb.x + pb.width + 0.5);
      expect(lb.y + lb.height).toBeLessThanOrEqual(pb.y + pb.height + 0.5);
      if (tag === '720p') await expectTextFloor(page, 'entry-highg');
    });
    test('retrograde held on the nose under chutes', async ({ page, pageLog }) => {
      await shoot(page, pageLog, '/labs/flight-ui/?scene=chutes&sas=retrograde', `retrograde-hold-${tag}`);
      await expect(page.locator('.hud .modecap')).toHaveText(/retrograde/i);
    });
    test('cockpit view', async ({ page, pageLog }) => {
      await shoot(page, pageLog, '/labs/flight-ui/?scene=lowOrbit&view=cockpit', `cockpit-lowOrbit-${tag}`);
    });
    test('cockpit view over the cabin (the cockpit package render of the seat view in low orbit)', async ({ page, pageLog }) => {
      // A still of the real cabin behind the interior layout: the cockpit's own seat-view screenshot.
      test.skip(!fs.existsSync(CABIN_STILL), `needs ${CABIN_STILL} (tests/browser/cockpit perf spec)`);
      // The dev server's root is the repository, so the still is served from its own path.
      // The lab's clock and attitude set to the still's state (its own clocks read 00:00:05, its ADI roll -90 deg).
      await shoot(page, pageLog, `/labs/flight-ui/?scene=lowOrbit&view=cockpit&met=5&attitude=0,0,-90&still=${encodeURIComponent(CABIN_STILL_URL)}`, `cockpit-cabin-lowOrbit-${tag}`);
      if (tag === '720p') await expectTextFloor(page, 'cockpit over the cabin');
    });
    test('map view', async ({ page, pageLog }) => {
      await shoot(page, pageLog, '/labs/flight-ui/?scene=lowOrbit&view=map&node=1', `map-lowOrbit-${tag}`);
    });
    test('key help overlay', async ({ page, pageLog }) => {
      await shoot(page, pageLog, '/labs/flight-ui/?scene=pad&help=1', `keyhelp-${tag}`);
      if (tag === '720p') await expectTextFloor(page, 'key help');
    });
    test('mission failed banner', async ({ page, pageLog }) => {
      const png = await shoot(page, pageLog, '/labs/flight-ui/?scene=reentry&failed=1', `failed-${tag}`);
      if (tag === '720p') {
        // Powered down, not see-through: no scene edge prints through a dimmed plate.
        const spreads = await plateSpreads(page, png);
        expect(spreads.length).toBeGreaterThan(3);
        for (const x of spreads) expect(x.spread, `dimmed plate "${x.cls}" fill spread (8-bit levels)`).toBeLessThanOrEqual(8);
      }
    });
    test('terrain loading notice', async ({ page, pageLog }) => {
      await shoot(page, pageLog, '/labs/flight-ui/?scene=lunarSurface&terrainPending=1', `terrain-pending-${tag}`);
    });
    test('MFD pages', async ({ page, pageLog }) => {
      await shoot(page, pageLog, '/labs/flight-ui/?scene=lunarOrbit&mfd=1&node=1', `mfd-pages-${tag}`, 10);
    });
    test('MFD pages, landed 400 m from the target (no ground track: north-up scope)', async ({ page, pageLog }) => {
      await shoot(page, pageLog, '/labs/flight-ui/?scene=lunarSurface&mfd=1&targetOffset=400,30', `mfd-pages-hover-${tag}`, 10);
    });
  });
}

test.describe('flight-ui over a near-white backdrop (720p)', () => {
  test.use({ viewport: { width: 1280, height: 720 } });
  for (const [scene, extra] of [
    ['pad', 'target=moon'],
    ['ascent', ''],
    ['reentry', ''],
    ['lunarSurface', ''],
  ] as const) {
    test(`scene ${scene}: every label keeps 4.5 : 1 against its panel, no scene edge prints through a plate, the HUD stays in its budget`, async ({ page, pageLog }) => {
      const png = await shoot(page, pageLog, `/labs/flight-ui/?scene=${scene}&backdrop=bright${extra ? `&${extra}` : ''}`, `bright-${scene}-720p`);
      const c = await labelContrasts(page, png);
      expect(c.length).toBeGreaterThanOrEqual(4);
      for (const x of c) expect(x.ratio, `label "${x.text}"`).toBeGreaterThanOrEqual(4.5);
      // A plate over the horizon (sunlit regolith or cloud deck against the sky) keeps one tone.
      const spreads = await plateSpreads(page, png);
      expect(spreads.length).toBeGreaterThan(3);
      for (const p of spreads) expect(p.spread, `plate "${p.cls}" fill spread (8-bit levels)`).toBeLessThanOrEqual(8);
      expect(await hudCoverage(page), `${scene}: HUD coverage`).toBeLessThanOrEqual(COVERAGE_BUDGET);
    });
  }
});

test.describe('flight-ui milestones (720p)', () => {
  test.use({ viewport: { width: 1280, height: 720 } });
  test('a milestone is announced by its name, once, with the sphere-of-influence change it hangs on', async ({ page, pageLog }) => {
    // The mission's MOON_SOI_ENTER arrives with the sim's soiChange (out/screens/mission/08 showed both, the
    // milestone title-cased as "Moon Soi Enter").
    await openPage(page, '/labs/flight-ui/?scene=translunar&milestone=MOON_SOI_ENTER&soi=earth,moon');
    await page.waitForFunction(() => document.querySelectorAll('.hud .toast').length > 0);
    await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished)));
    await expect(page.locator('.hud .toast')).toHaveCount(1);
    await expect(page.locator('.hud .toast')).toHaveText("Entered the Moon's sphere of influence");
    await saveScreenshot(page, 'flight-ui', 'milestone-soi-720p');
    await expectNoErrors(page, pageLog);
    await openPage(page, '/labs/flight-ui/?scene=lowOrbit&milestone=TLI_COMPLETE');
    await page.waitForFunction(() => document.querySelectorAll('.hud .toast').length > 0);
    await expect(page.locator('.hud .toast')).toHaveText('TLI complete');
    await expectNoErrors(page, pageLog);
  });
});

test.describe('flight-ui stage stack (720p)', () => {
  test.use({ viewport: { width: 1280, height: 720 } });
  test('the mass is that of the parts carried: it falls as the stack is staged, and the MFD shows it', async ({ page, pageLog }) => {
    const masses: number[] = [];
    for (const scene of ['pad', 'ascent', 'lowOrbit', 'lunarOrbit', 'lunarSurface', 'reentry']) {
      await openPage(page, `/labs/flight-ui/?scene=${scene}`);
      await page.evaluate(() => window.__test!.waitFrames(5));
      const s = await page.evaluate(() => window.__test!.state()!);
      masses.push(s.readouts.mass);
      const row = (await page.evaluate(() => window.__flightUi!.mfdRows('systems'))).find((r) => r.label === 'Mass')!;
      expect(row.value.replace(/\s/g, ' ')).toMatch(s.readouts.mass >= 10000 ? new RegExp(`^${(s.readouts.mass / 1000).toFixed(1).replace('.', '\\.')}`) : /kg$/);
      await expectNoErrors(page, pageLog);
    }
    for (let i = 1; i < masses.length; i++) expect(masses[i], `mass after scene ${i}`).toBeLessThan(masses[i - 1]!);
  });
  test('the burning stage has its own tile with live delta-v, TWR, burn time and propellant, named for what burns', async ({ page, pageLog }) => {
    for (const [scene, extra, number] of [
      ['ascent', '', '1'],
      ['lunarOrbit', '', '5'],
      ['lunarSurface', '', '5'],
    ] as const) {
      await openPage(page, `/labs/flight-ui/?scene=${scene}${extra ? `&${extra}` : ''}`);
      await page.evaluate(() => window.__test!.waitFrames(10));
      const s = await page.evaluate(() => window.__test!.state()!);
      const info = s.staging.stages[Number(number) - 1]!;
      expect(info.fired).toBe(true);
      expect(info.propellantFraction).not.toBeNull();
      const tile = page.locator('.hud .stages .tile.active');
      await expect(tile).toHaveCount(1);
      await expect(tile.locator('.sn')).toHaveText(number);
      await expect(tile.locator('.dv')).toHaveText(/^Δv [\d\s]+\sm\/s$/);
      const dv = Number((await tile.locator('.dv').textContent())!.replace(/[^\d]/g, ''));
      expect(Math.abs(dv - info.deltaVNow)).toBeLessThanOrEqual(1);
      await expect(tile.locator('.meta')).toHaveText(/^TWR [\d.]+\s+[\d:]+$/);
      await expect(tile.locator('.bar.prop')).toBeVisible();
      // The active tile sits under the next stage's tile, at the bottom of the stack.
      const a = (await tile.boundingBox())!;
      const n = (await page.locator('.hud .stages .tile.next').boundingBox())!;
      expect(a.y).toBeGreaterThan(n.y + n.height - 1);
      // Titled with what burns: the stage group whose propellant drains in the resources panel (one group in use),
      // not the event that lit it.
      const title = (await tile.locator('.name').textContent())!;
      expect(title).not.toBe(info.label);
      const drained = await page.locator('.hud .res .rrow .rn').allTextContents();
      expect(drained).toEqual([title]);
      // The MFD staging strip shows the same stage by the same name.
      const rows = await page.evaluate(() => window.__flightUi!.mfdRows('staging'));
      expect(rows.find((r) => r.label === 'Active stage')!.value).toBe(`${number} · ${title}`);
      expect(rows.find((r) => r.label === 'Stage Δv')!.value).not.toBe('—');
      await expectNoErrors(page, pageLog);
    }
  });
});

test.describe('flight-ui MFD pages at 512 x 384, 1 : 1', () => {
  test.use({ viewport: { width: 1600, height: 840 } });
  test('lunar orbit with a node', async ({ page, pageLog }) => {
    await shoot(page, pageLog, '/labs/flight-ui/?scene=lunarOrbit&mfd=native&node=1', 'mfd-pages-native', 10);
  });
  test('reentry (predicted impact inside the recovery zone)', async ({ page, pageLog }) => {
    await shoot(page, pageLog, '/labs/flight-ui/?scene=reentry&mfd=native', 'mfd-pages-native-reentry', 10);
  });
});
