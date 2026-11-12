/**
 * The screen-space contact shadow near the camera (requests cockpit-10 and vehicle-pad-10), on the frames
 * the two requests name, with the rules of the march switched in the page (CoreRenderer.setContactShadow):
 *
 *  - the cockpit's lunar view as the critic saw it (the well floor of the left side window from 38 cm, the
 *    sun grazing it) and its pad view through the forward window: frozen noise, as the cockpit captures;
 *  - the vehicle lab's capsule hatch with its grab rails from 2.5 m: live, 72 frames, as the vehicle captures.
 *
 * Per view and rule set: the picture, a sheet of the crops side by side, the share of isolated dark or
 * bright pixels in the named regions (the stipple), the width of the dark band beside a rail, and the time
 * of the AO pass with the first rules and with the present ones.
 *
 *   node tools/dev/heavy.mjs --class=gpu -- npx playwright test tests/browser/integration/contact.spec.ts --project=functional
 *
 * Pictures: out/screens/integration/contact-*.png; numbers: out/integration/results.json (f.contact.*).
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { PNG } from 'pngjs';
import { applyRecipe, settleWorld, WORLD_VIEWS, type Recipe } from '../cockpit/world';
import { assertDiscreteGpu, expect, openPage, test, waitIdle } from '../harness';
import { record, repoRoot } from './helpers';

test.describe.configure({ timeout: 900_000 });

/** The pages compile the sun-shadow chunk with its A/B switches (ShadowSystem.debugFlags). */
const SWITCHES = 'shadowdebug=1';

type Contact = Record<string, unknown>;
/** The march as it was (src/render/core/lighting/ao.ts CONTACT_SHADOW_LEGACY). */
const LEGACY: Contact = { enabled: true, planeReject: false, refine: false, thinOnly: false, nearSteps: 10, nearRange: 0, fade: null, interiorFade: null };
const NEAR: Contact = { ...LEGACY, nearSteps: 20, nearRange: 8, planeReject: true, refine: true };

interface Variant {
  name: string;
  /** null = the renderer's own rules, as the page started with them. */
  contact: Contact | null;
  /** ShadowSystem.debugFlags: 1 = the cascade kernel is not turned per pixel, 2 = no dithered cross-fade between cascades. */
  shadowDebug?: number;
}
const VARIANTS: Variant[] = [
  { name: 'legacy', contact: LEGACY },
  { name: 'off', contact: { ...LEGACY, enabled: false } },
  // The plane and the bisection, every occluder two texels thick.
  { name: 'refine', contact: { ...NEAR, thinOnly: false, crossShare: 0 } },
  // Only occluders that touch the receiver or are thin.
  { name: 'thin', contact: { ...NEAR, thinOnly: true, crossShare: 0 } },
  // The game's rules: or whose visible face the ray enters.
  { name: 'default', contact: null },
];
/** Index of the game's rules in VARIANTS. */
const DEFAULT = 4;
/** What of a well face's grain is the cascade's: the game's contact rules with no cascade shadow at all. */
const FILTER_VARIANTS: Variant[] = [{ name: 'noshadow', contact: null, shadowDebug: 8 }];

interface Region {
  name: string;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

const lum = (png: PNG, x: number, y: number): number => {
  const i = (y * png.width + x) * 4;
  return 0.2126 * png.data[i]! + 0.7152 * png.data[i + 1]! + 0.0722 * png.data[i + 2]!;
};

/**
 * Isolated pixels of a region: the share that stands off the median of its eight neighbours by more than
 * `levels` (an edge moves the median with it; a stipple does not), darker and brighter counted apart.
 */
function speckle(png: PNG, r: Region, levels = 24): { dark: number; bright: number; mean: number; std: number } {
  let dark = 0;
  let bright = 0;
  let n = 0;
  let sum = 0;
  let sum2 = 0;
  const around: number[] = [];
  for (let y = Math.max(1, r.y0); y < Math.min(png.height - 1, r.y1); y++) {
    for (let x = Math.max(1, r.x0); x < Math.min(png.width - 1, r.x1); x++) {
      around.length = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (dx !== 0 || dy !== 0) around.push(lum(png, x + dx, y + dy));
      around.sort((a, b) => a - b);
      const median = 0.5 * (around[3]! + around[4]!);
      const v = lum(png, x, y);
      if (v < median - levels) dark++;
      else if (v > median + levels) bright++;
      n++;
      sum += v;
      sum2 += v * v;
    }
  }
  const mean = sum / Math.max(n, 1);
  return { dark: dark / Math.max(n, 1), bright: bright / Math.max(n, 1), mean, std: Math.sqrt(Math.max(0, sum2 / Math.max(n, 1) - mean * mean)) };
}

/** The dark band of a region, row by row: pixels under 40 % of the row's bright level (its 85th percentile). Mean width and its spread over the rows, px. */
function darkBand(png: PNG, r: Region): { width: number; spread: number } {
  const widths: number[] = [];
  for (let y = r.y0; y < r.y1; y++) {
    const row: number[] = [];
    for (let x = r.x0; x < r.x1; x++) row.push(lum(png, x, y));
    const sorted = [...row].sort((a, b) => a - b);
    const level = sorted[Math.floor(0.85 * (sorted.length - 1))]!;
    widths.push(row.filter((v) => v < 0.4 * level).length);
  }
  const mean = widths.reduce((a, b) => a + b, 0) / Math.max(widths.length, 1);
  return { width: mean, spread: Math.sqrt(widths.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(widths.length, 1)) };
}

/** The crops of one region from every picture, `scale` times enlarged, in a grid of `columns`. */
function sheet(pictures: PNG[], r: Region, columns: number, scale: number, margin = 16): PNG {
  const x0 = Math.max(0, r.x0 - margin);
  const y0 = Math.max(0, r.y0 - margin);
  const w = Math.min(pictures[0]!.width, r.x1 + margin) - x0;
  const h = Math.min(pictures[0]!.height, r.y1 + margin) - y0;
  const gap = 6;
  const rows = Math.ceil(pictures.length / columns);
  const out = new PNG({ width: columns * (w * scale + gap) - gap, height: rows * (h * scale + gap) - gap });
  out.data.fill(255);
  pictures.forEach((png, k) => {
    const ox = (k % columns) * (w * scale + gap);
    const oy = Math.floor(k / columns) * (h * scale + gap);
    for (let y = 0; y < h * scale; y++) {
      for (let x = 0; x < w * scale; x++) {
        const s = ((y0 + Math.floor(y / scale)) * png.width + x0 + Math.floor(x / scale)) * 4;
        const d = ((oy + y) * out.width + ox + x) * 4;
        out.data[d] = png.data[s]!;
        out.data[d + 1] = png.data[s + 1]!;
        out.data[d + 2] = png.data[s + 2]!;
        out.data[d + 3] = 255;
      }
    }
  });
  return out;
}

const outDir = path.join(repoRoot, 'out', 'screens', 'integration');

/** Switch the rules, let the picture settle and take it. */
async function shoot(page: Page, view: string, v: Variant, own: Contact, frames: number): Promise<PNG> {
  await page.evaluate(
    async ({ contact, debug, n }) => {
      const r = window.__lab!.renderer;
      r.setContactShadow(contact);
      r.setShadowDebug(debug);
      await window.__test!.waitFrames(n);
    },
    { contact: v.contact ?? own, debug: v.shadowDebug ?? 0, n: frames },
  );
  fs.mkdirSync(outDir, { recursive: true });
  const buffer = await page.screenshot({ path: path.join(outDir, `contact-${view}-${v.name}.png`) });
  return PNG.sync.read(buffer);
}

/** Median and 99th percentile of the AO pass over `frames` frames with the given rules, ms. */
async function aoTime(page: Page, contact: Contact, frames: number): Promise<{ p50: number; p99: number }> {
  return page.evaluate(
    async ({ c, n }) => {
      const r = window.__lab!.renderer;
      r.setContactShadow(c);
      r.setShadowDebug(0);
      await window.__test!.waitFrames(30);
      window.__test!.resetPerf();
      await window.__test!.waitFrames(n);
      const s = r.passStats()['core.ao'];
      return { p50: s?.p50 ?? 0, p99: s?.p99 ?? 0 };
    },
    { c: contact, n: frames },
  );
}

const fmt = (s: { dark: number; bright: number; std: number }): string => `dark ${(100 * s.dark).toFixed(2)} %, bright ${(100 * s.bright).toFixed(2)} %, std ${s.std.toFixed(1)}`;

test.describe('the cockpit views: a window well at arm\'s length', () => {
  test.use({ viewport: { width: 1600, height: 900 } });

  /** The lunar view as the round-3 critic saw it (tests/browser/cockpit/world.ts at 0e184e5; the cockpit re-aimed it since). */
  const MOON: Recipe = {
    sun: { ves: [-0.5, 0.5, 0.7] },
    lights: true,
    free: { kind: 'interior', eye: { through: 'side-left', from: { seat: [0, 0, 0] }, out: -0.38 }, look: { horizon: 'side-left', out: 10, drop: -1.8 }, up: 'nose' },
    fovDeg: 62,
  };
  const VIEWS: { name: string; query: string; recipe: Recipe; regions: Region[] }[] = [
    {
      name: 'moon-well',
      query: 'scene=lunarSurface',
      recipe: MOON,
      regions: [
        { name: 'well floor', x0: 740, y0: 640, x1: 960, y1: 800 },
        { name: 'well wall, upper right', x0: 1230, y0: 190, x1: 1290, y1: 260 },
      ],
    },
    {
      name: 'pad-well',
      query: 'scene=pad',
      recipe: WORLD_VIEWS.find((v) => v.name === 'world-pad-noon-forward-window')!.recipe,
      regions: [
        { name: 'well floor', x0: 590, y0: 730, x1: 880, y1: 880 },
        { name: 'right window', x0: 1150, y0: 480, x1: 1350, y1: 880 },
      ],
    },
  ];

  for (const view of VIEWS) {
    test(`${view.name}: no stipple on the well's faces with the present rules; the first rules, none, and each rule on its own beside it`, async ({ page }) => {
      await openPage(page, `/labs/integration/?${view.query}&hud=0&paused=1&${SWITCHES}`, { timeoutMs: 240_000 });
      await assertDiscreteGpu(page);
      expect(await page.evaluate(() => window.__lab!.renderer.contactShader), "the page runs the contact shadow with the near field's rules").toBe('near');
      const placed = await applyRecipe(page, view.recipe);
      expect(placed.ok, placed.why).toBe(true);
      await settleWorld(page);
      const own = (await page.evaluate(() => window.__lab!.renderer.contactShadow())) as unknown as Contact;

      const variants = [...VARIANTS, ...FILTER_VARIANTS];
      const pictures: PNG[] = [];
      const numbers: Record<string, Record<string, ReturnType<typeof speckle>>> = {};
      for (const v of variants) {
        const png = await shoot(page, view.name, v, own, 45);
        pictures.push(png);
        numbers[v.name] = Object.fromEntries(view.regions.map((r) => [r.name, speckle(png, r)]));
        console.log(`  ${view.name}, ${v.name}: ${view.regions.map((r) => `${r.name}: ${fmt(numbers[v.name]![r.name]!)}`).join('; ')}`);
      }
      view.regions.forEach((r, i) => fs.writeFileSync(path.join(outDir, `contact-${view.name}-sheet${i}.png`), PNG.sync.write(sheet(pictures, r, 2, 2))));
      console.log(`  ${view.name}: sheets in the order ${variants.map((v) => v.name).join(', ')} (two columns, row by row)`);

      // What a player sees: the noise running, the resolve averaging it.
      await page.evaluate(() => window.__test!.setDeterministic(false));
      const live: Record<string, Record<string, ReturnType<typeof speckle>>> = {};
      const livePictures: PNG[] = [];
      for (const v of [VARIANTS[0]!, VARIANTS[DEFAULT]!]) {
        const png = await shoot(page, `${view.name}-live`, v, own, 90);
        livePictures.push(png);
        live[v.name] = Object.fromEntries(view.regions.map((r) => [r.name, speckle(png, r)]));
        console.log(`  ${view.name}, live, ${v.name}: ${view.regions.map((r) => `${r.name}: ${fmt(live[v.name]![r.name]!)}`).join('; ')}`);
      }
      fs.writeFileSync(path.join(outDir, `contact-${view.name}-live-sheet0.png`), PNG.sync.write(sheet(livePictures, view.regions[0]!, 2, 2)));

      const before = await aoTime(page, LEGACY, 150);
      const after = await aoTime(page, own, 150);
      console.log(`  ${view.name}: AO pass with the first rules p50 ${before.p50.toFixed(3)} ms (p99 ${before.p99.toFixed(3)}), with the present ones p50 ${after.p50.toFixed(3)} ms (p99 ${after.p99.toFixed(3)})`);
      record(`f.contact.${view.name}`, { frozen: numbers, live, aoMs: { before, after }, order: variants.map((v) => v.name) });

      // The game's rules leave no stipple of the contact shadow on the well's faces (frozen noise: the
      // hardest case): no more isolated pixels than with no contact shadow at all, and on the lunar view,
      // where the first rules drew 4.4 % of the floor as isolated dark pixels (1.2 % since the cabin was
      // rebuilt on the pilot's couch), a tenth of a per cent at most.
      for (const r of view.regions) {
        const s = numbers.default![r.name]!;
        const none = numbers.off![r.name]!;
        expect.soft(s.dark, `${r.name}: isolated dark pixels against none`).toBeLessThan(none.dark + 0.001);
        expect.soft(s.bright, `${r.name}: isolated bright pixels against none`).toBeLessThan(none.bright + 0.001);
        if (view.name === 'moon-well') expect.soft(s.dark + s.bright, `${r.name}: isolated pixels`).toBeLessThan(0.001);
      }
      expect(await page.evaluate(() => window.__test!.errors.length)).toBe(0);
    });
  }
});

test('the capsule hatch from 2.5 m: a grab rail casts a line, not a ragged band (request vehicle-pad-10)', async ({ page }) => {
  await openPage(page, `/labs/vehicle/?hud=0&governor=off&scene=lowOrbit&planet=0&stage=8&sunv=0.85,0.45,-0.1&eye=1.0,1.8,-3.4&at=0,1.2,-1.2&fov=40&${SWITCHES}`, { timeoutMs: 180_000 });
  await assertDiscreteGpu(page);
  expect(await page.evaluate(() => window.__lab!.renderer.contactShader), "the page runs the contact shadow with the near field's rules").toBe('near');
  await page.waitForFunction(() => (window as unknown as { __veh?: unknown }).__veh !== undefined);
  // Live, as the vehicle's own pictures are taken: the jitter and the noise running, 72 frames.
  await page.evaluate(() => window.__test!.setDeterministic(false));
  await waitIdle(page, 72);
  const own = (await page.evaluate(() => window.__lab!.renderer.contactShadow())) as unknown as Contact;
  const regions: Region[] = [
    { name: 'left rail', x0: 395, y0: 270, x1: 485, y1: 535 },
    { name: 'hatch handle', x0: 515, y0: 330, x1: 575, y1: 420 },
    { name: 'right hinges', x0: 725, y0: 235, x1: 800, y1: 475 },
  ];
  const pictures: PNG[] = [];
  const numbers: Record<string, Record<string, { speckle: ReturnType<typeof speckle>; band: ReturnType<typeof darkBand> }>> = {};
  for (const v of VARIANTS) {
    const png = await shoot(page, 'hatch', v, own, 90);
    pictures.push(png);
    numbers[v.name] = Object.fromEntries(regions.map((r) => [r.name, { speckle: speckle(png, r), band: darkBand(png, r) }]));
    console.log(`  hatch, ${v.name}: ${regions.map((r) => `${r.name}: dark band ${numbers[v.name]![r.name]!.band.width.toFixed(1)} px (spread ${numbers[v.name]![r.name]!.band.spread.toFixed(1)}), ${fmt(numbers[v.name]![r.name]!.speckle)}`).join('; ')}`);
  }
  regions.forEach((r, i) => fs.writeFileSync(path.join(outDir, `contact-hatch-sheet${i}.png`), PNG.sync.write(sheet(pictures, r, 3, 2))));
  console.log(`  hatch: sheets in the order ${VARIANTS.map((v) => v.name).join(', ')} (three columns, row by row)`);
  // The same with the noise frozen (what a reference capture holds).
  await page.evaluate(() => window.__test!.setDeterministic(true));
  const frozen: PNG[] = [];
  for (const v of [VARIANTS[0]!, VARIANTS[2]!, VARIANTS[DEFAULT]!]) frozen.push(await shoot(page, 'hatch-frozen', v, own, 45));
  fs.writeFileSync(path.join(outDir, 'contact-hatch-frozen-sheet0.png'), PNG.sync.write(sheet(frozen, regions[0]!, 3, 2)));
  await page.evaluate(() => window.__test!.setDeterministic(false));

  const before = await aoTime(page, LEGACY, 150);
  const after = await aoTime(page, own, 150);
  console.log(`  hatch: AO pass with the first rules p50 ${before.p50.toFixed(3)} ms (p99 ${before.p99.toFixed(3)}), with the present ones p50 ${after.p50.toFixed(3)} ms (p99 ${after.p99.toFixed(3)})`);
  record('f.contact.hatch', { live: numbers, aoMs: { before, after }, order: VARIANTS.map((v) => v.name) });

  // The band beside the bar is a line that stands off it: narrower than it was (28.5 px -> 15.3 measured;
  // 23.6 without the rule for thin occluders) and more even (spread over the rows 7.8 -> 4.4).
  const rail = numbers.default!['left rail']!.band;
  const was = numbers.legacy!['left rail']!.band;
  expect.soft(rail.width, 'dark band beside the left rail, px').toBeLessThan(0.7 * was.width);
  expect.soft(rail.spread, 'its spread over the rows, px').toBeLessThan(was.spread);
  expect(await page.evaluate(() => window.__test!.errors.length)).toBe(0);
});
