/**
 * The UI scrim drawn inside scissors (finding 12 of the presentation sweep's review; RENDER_API 19.3): the
 * picture is, to the bit, the picture of the pass as the sweep made it.
 *
 * The tonemap pass draws the scene without the scrim over the whole frame and the scrim shader inside the
 * scissor rectangles of the published rectangles (src/render/core/post/tonemap.ts Tonemap.draw). The pass as
 * the sweep made it, the scrim shader in ONE draw over the whole frame, is kept behind the switch of tests
 * (`__lab.setTonemapPath('single')`). For every set of rectangles below the page is captured frame-exactly
 * under both and the two pictures are compared pixel by pixel:
 *
 *   no rectangle                         (also against the pass before the scrim existed, 'base')
 *   one rounded rectangle                (edges between pixels: the anti-aliased ramp, the corners)
 *   two overlapping rectangles           (in both orders: a later one is laid over an earlier one)
 *   rectangles partly off the canvas     (two corners)
 *   rectangles that change nothing       (no area, opacity 0, off the canvas: the pass without the scrim alone)
 *   eight rectangles                     (nested, touching, overlapping: many scissors)
 *   a rectangle over most of the frame   (the pass takes the one draw by itself; the scissors forced as well)
 *   a buffer written directly            (the core does not know its contents: the one draw)
 *
 * and the first three again under the curve as it was (look 1; the game's look is 2 since 2026-11-24). Two more tests: an overlay drawn after the scrim
 * (`drawOverlay`, in the same pass) is not cut by the scrim's scissors; and over the live scenes of two
 * reference images (the integration lab's pad at noon and its low orbit) the pass as it runs is the pass as
 * the sweep made it, with no rectangle and under a menu's four panels.
 *
 *   node tools/dev/heavy.mjs --class=gpu --label=core-scrim -- npx playwright test tests/browser/render-core/scrim.spec.ts --project=functional
 *
 * Pictures: out/screens/render-core/scrim/.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { PNG } from 'pngjs';
import { packScrimRects, scrimScissors, type ScrimScissor, type UiScrimRect } from '../../../src/render/core/post/scrim';
import { SCRIM_SPLIT_MAX_SHARE, type TonemapDrawInfo, type TonemapPath } from '../../../src/render/core/post/tonemap';
import { assertDiscreteGpu, captureReference, expect, expectNoErrors, openPage, test, waitIdle } from '../harness';

const W = 1280;
const H = 720;
test.use({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
test.describe.configure({ timeout: 25 * 60_000 });

const PAGE = '/labs/render-core/?sun=110,32&hud=0&governor=off&paused=1&deterministic=1';
const FRAMES = 32;
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const outDir = path.join(repoRoot, 'out', 'screens', 'render-core', 'scrim');
const save = (name: string, png: Buffer): void => {
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, `${name}.png`), png);
};

const panel = (x0: number, y0: number, x1: number, y1: number, cornerRadius: number, blur: number, dim: number, opacity = 1): UiScrimRect => ({ x0, y0, x1, y1, cornerRadius, blur, dim, opacity });

const ROUNDED = [panel(180.25, 90.5, 720.75, 520.25, 48, 0.6, 0.5)];
const OVERLAPPING = [panel(120, 80, 700, 460, 32, 0.3, 1), panel(480, 300, 1100, 640, 60, 1, 0.7, 0.6)];
const OFF_CANVAS = [panel(-150, -80.5, 400, 300, 40, 0.6, 0.5), panel(1000.5, 500, 1500, 900, 80, 0.3, 0.8)];
const NOTHING = [panel(300, 200, 300, 500, 24, 0.6, 0.5), panel(500, 100, 900, 400, 24, 0.6, 0.5, 0), panel(1400, 100, 1800, 400, 24, 0.6, 0.5), panel(200, 600, 100, 700, 0, 1, 0.5)];
const EIGHT = [
  panel(40, 40, 400, 680, 24, 0.6, 0.5),
  panel(80, 100, 360, 300, 12, 0.2, 1, 0.8),
  panel(400, 40, 640, 200, 0, 0.4, 0.7),
  panel(600, 160, 900, 420, 36, 1, 0.6, 0.7),
  panel(840, 380, 1240, 700, 64, 0.8, 0.9),
  panel(900, 20, 1270.5, 150.25, 500, 0.5, 0.5),
  panel(700.75, 500, 820.25, 560, 6, 0, 1),
  panel(1180, 300, 1320, 460, 20, 0.6, 0.3, 0.5),
];
const MOST = [panel(40, 20, 1240, 700, 32, 0.6, 0.5)];

/** The scissors the pass makes of a list (the unit tests hold what they are). */
const scissorsOf = (rects: readonly UiScrimRect[]): ScrimScissor[] => scrimScissors(packScrimRects(rects), W, H) ?? [];
const pixelsOf = (s: readonly ScrimScissor[]): number => s.reduce((a, q) => a + q.width * q.height, 0);

interface Difference {
  /** Pixels whose red, green or blue differs. */
  differing: number;
  inside: number;
  outside: number;
  max: number;
  /** The first of them: "x,y a -> b". */
  first: string[];
}
/** The pixels that differ between two pictures, counted inside and outside a set of scissors. */
function difference(a: Buffer, b: Buffer, scissors: readonly ScrimScissor[] = []): Difference {
  const A = PNG.sync.read(a);
  const B = PNG.sync.read(b);
  expect([A.width, A.height, B.width, B.height]).toEqual([W, H, W, H]);
  const d: Difference = { differing: 0, inside: 0, outside: 0, max: 0, first: [] };
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const m = Math.max(Math.abs(A.data[i]! - B.data[i]!), Math.abs(A.data[i + 1]! - B.data[i + 1]!), Math.abs(A.data[i + 2]! - B.data[i + 2]!));
      if (m === 0) continue;
      d.differing++;
      d.max = Math.max(d.max, m);
      if (scissors.some((s) => x >= s.x && x < s.x + s.width && y >= s.y && y < s.y + s.height)) d.inside++;
      else d.outside++;
      if (d.first.length < 12) d.first.push(`${x},${y} ${[...A.data.subarray(i, i + 3)].join('/')} -> ${[...B.data.subarray(i, i + 3)].join('/')}`);
    }
  }
  return d;
}
const told = (d: Difference): string => (d.differing === 0 ? '0 pixels differ' : `${d.differing} pixels differ (${d.inside} inside the scissors, ${d.outside} outside; by up to ${d.max} of 255): ${d.first.join('; ')}`);

interface Shot {
  image: Buffer;
  draw: TonemapDrawInfo;
}
/** The frame-exact picture of the page with the tonemap pass drawn as `how`, and what the pass did in it. */
async function shot(page: Page, how: TonemapPath, what: string): Promise<Shot> {
  await page.evaluate((p) => window.__lab!.setTonemapPath(p), how);
  const image = (await captureReference(page, FRAMES, `${what} (tonemap pass: ${how})`)).image;
  const draw = await page.evaluate(() => window.__lab!.tonemapDraw());
  if (!draw) throw new Error('the tonemap pass has not drawn');
  return { image, draw };
}
const publish = (page: Page, rects: readonly UiScrimRect[] | null, how: 'tracked' | 'raw' = 'tracked'): Promise<void> =>
  page.evaluate(([r, h]) => window.__lab!.setScrim(r, h), [rects, how] as const);

async function openLab(page: Page, extra = ''): Promise<void> {
  await openPage(page, `${PAGE}${extra}`);
  await assertDiscreteGpu(page);
  await page.evaluate(() => window.__rc!.lookAt([0, 6, 1], 200, 28, 26));
  await waitIdle(page, 60);
}

/** The red, green and blue of one pixel of a picture. */
function pixel(png: Buffer, x: number, y: number): number[] {
  const p = PNG.sync.read(png);
  const i = (y * p.width + x) * 4;
  return [p.data[i]!, p.data[i + 1]!, p.data[i + 2]!];
}

/**
 * One list of rectangles: the picture of the one draw, the picture of the pass as it runs, and their
 * difference, which must be nothing. Returns the picture of the one draw.
 */
async function sameAsOneDraw(page: Page, name: string, rects: readonly UiScrimRect[], none: Buffer, opts: { minChanged?: number } = {}): Promise<Buffer> {
  const scissors = scissorsOf(rects);
  await publish(page, rects);
  const single = await shot(page, 'single', name);
  expect(single.draw.drawn, `${name}: the one draw`).toBe('single');
  const auto = await shot(page, 'auto', name);
  save(`${name}-one-draw`, single.image);
  save(`${name}-scissors`, auto.image);
  expect(auto.draw, `${name}: what the pass drew`).toMatchObject({ drawn: 'split', scissors: scissors.length, scissorPixels: pixelsOf(scissors) });
  const d = difference(single.image, auto.image, scissors);
  // The rectangles do something, and only inside their scissors.
  const changed = difference(none, single.image, scissors);
  console.log(`  ${name}: ${scissors.length} scissors holding ${pixelsOf(scissors)} pixels (${((100 * pixelsOf(scissors)) / (W * H)).toFixed(1)} % of the frame); against the one draw ${told(d)}; the rectangles change ${changed.inside} pixels inside the scissors and ${changed.outside} outside`);
  expect(d.differing, `${name}: pixels that differ from the one draw: ${told(d)}`).toBe(0);
  expect(changed.inside, `${name}: pixels the rectangles change`).toBeGreaterThan(opts.minChanged ?? 20_000);
  expect(changed.outside, `${name}: pixels changed outside the scissors`).toBe(0);
  return single.image;
}

test('the scrim inside scissors is the scrim of the one draw to the bit: none, rounded, overlapping, off the canvas, eight, most of the frame', async ({ page, pageLog }) => {
  await openLab(page);

  // No rectangle: the pass as the sweep made it (one branch on the header), the pass before the scrim, the pass as it runs.
  await publish(page, null);
  const none = await shot(page, 'single', 'no rectangle');
  const before = await shot(page, 'base', 'no rectangle');
  const now = await shot(page, 'auto', 'no rectangle');
  save('none-one-draw', none.image);
  save('none-before-the-scrim', before.image);
  expect(none.draw.drawn).toBe('single');
  expect(before.draw.drawn).toBe('base');
  // (The page runs the game's look: 2 since the lead's decision of 2026-11-24; it was 1.)
  expect(now.draw, 'no rectangle: the pass without the scrim alone').toMatchObject({ drawn: 'base', scissors: 0, scissorPixels: 0, look: 2 });
  const dBefore = difference(none.image, before.image);
  const dNow = difference(none.image, now.image);
  console.log(`  no rectangle: the pass before the scrim against the one draw: ${told(dBefore)}; the pass as it runs: ${told(dNow)}`);
  expect(dBefore.differing, `no rectangle, the pass before the scrim: ${told(dBefore)}`).toBe(0);
  expect(dNow.differing, `no rectangle, the pass as it runs: ${told(dNow)}`).toBe(0);

  await sameAsOneDraw(page, 'rounded', ROUNDED, none.image);
  const ab = await sameAsOneDraw(page, 'overlapping', OVERLAPPING, none.image);
  const ba = await sameAsOneDraw(page, 'overlapping-reversed', [...OVERLAPPING].reverse(), none.image);
  // The order is part of the picture: where the two overlap, the other order is another picture.
  const order = difference(ab, ba, scissorsOf(OVERLAPPING));
  console.log(`  overlapping, the two orders against each other: ${order.differing} pixels differ`);
  expect(order.differing, 'pixels that depend on the order of two overlapping rectangles').toBeGreaterThan(5_000);
  expect(order.outside).toBe(0);
  await sameAsOneDraw(page, 'off-canvas', OFF_CANVAS, none.image);
  await sameAsOneDraw(page, 'eight', EIGHT, none.image);

  // Rectangles that cannot change a pixel: the pass without the scrim alone, and the picture without a rectangle.
  await publish(page, NOTHING);
  const nothingSingle = await shot(page, 'single', 'rectangles that change nothing');
  const nothing = await shot(page, 'auto', 'rectangles that change nothing');
  expect(nothing.draw, 'rectangles that change nothing').toMatchObject({ drawn: 'base', scissors: 0, scissorPixels: 0 });
  const dNothing = difference(none.image, nothing.image);
  const dNothingSingle = difference(none.image, nothingSingle.image);
  console.log(`  no area / opacity 0 / off the canvas: against the picture without a rectangle ${told(dNothing)}; the one draw with them: ${told(dNothingSingle)}`);
  expect(dNothing.differing, told(dNothing)).toBe(0);
  expect(dNothingSingle.differing, told(dNothingSingle)).toBe(0);

  // Most of the frame: the pass takes the one draw by itself; with the scissors forced the picture is the same.
  const most = scissorsOf(MOST);
  expect(pixelsOf(most) / (W * H)).toBeGreaterThan(SCRIM_SPLIT_MAX_SHARE);
  await publish(page, MOST);
  const mostSingle = await shot(page, 'single', 'most of the frame');
  const mostAuto = await shot(page, 'auto', 'most of the frame');
  const mostSplit = await shot(page, 'split', 'most of the frame');
  save('most-one-draw', mostSingle.image);
  expect(mostAuto.draw.drawn, 'most of the frame: the pass as it runs').toBe('single');
  expect(mostSplit.draw).toMatchObject({ drawn: 'split', scissors: 1, scissorPixels: pixelsOf(most) });
  const dMost = difference(mostSingle.image, mostSplit.image, most);
  const dMostAuto = difference(mostSingle.image, mostAuto.image, most);
  console.log(`  most of the frame (${((100 * pixelsOf(most)) / (W * H)).toFixed(1)} %): the scissors forced against the one draw: ${told(dMost)}; the pass as it runs: ${told(dMostAuto)}`);
  expect(dMost.differing, told(dMost)).toBe(0);
  expect(dMostAuto.differing, told(dMostAuto)).toBe(0);

  // A buffer the core does not know the contents of: the one draw, the same picture as with the known buffer.
  await publish(page, OVERLAPPING, 'raw');
  const raw = await shot(page, 'auto', 'a buffer written directly');
  expect(raw.draw.drawn, 'a buffer written directly').toBe('single');
  const dRaw = difference(ab, raw.image, scissorsOf(OVERLAPPING));
  console.log(`  a buffer written directly: against the known buffer ${told(dRaw)}`);
  expect(dRaw.differing, told(dRaw)).toBe(0);

  // And with the rectangles gone the picture is the first one.
  await publish(page, null);
  const again = await shot(page, 'auto', 'no rectangle again');
  expect(again.draw.drawn).toBe('base');
  expect(difference(none.image, again.image).differing, 'pixels that differ from the first picture once the rectangles are gone').toBe(0);
  await page.evaluate(() => window.__lab!.setTonemapPath('auto'));
  await expectNoErrors(page, pageLog);
});

test('an overlay drawn after the scrim is not cut by the scrim\'s scissors', async ({ page, pageLog }) => {
  await openLab(page);
  // An overlay that sets no scissor of its own (as a HUD feature draws): pure green over 16 x 16 pixels in the
  // top-left and in the bottom-right corner of the canvas, nothing elsewhere.
  await page.evaluate(
    async ([w, h]) => {
      const lab = window.__lab!;
      const fragment = `@fragment fn fs(in: FullscreenOut) -> @location(0) vec4f {
  let p = in.position.xy;
  if (!((p.x < 16.0 && p.y < 16.0) || (p.x > ${w - 16}.0 && p.y > ${h - 16}.0))) { discard; }
  return vec4f(0.0, 1.0, 0.0, 1.0);
}`;
      const pipeline = lab.renderer.core.fullscreenPipeline({ label: 'scrim.spec.overlay', fragment, targets: [{ format: lab.gpu.canvasFormat }] });
      await lab.renderer.addFeature({
        id: 'scrim-spec-overlay',
        init() {},
        drawOverlay(_frame, pass) {
          pass.setPipeline(pipeline.get());
          pass.draw(3);
        },
      });
    },
    [W, H] as const,
  );
  await waitIdle(page, 30);
  const corners = (s: Shot): number[][] => [pixel(s.image, 4, 4), pixel(s.image, 11, 11), pixel(s.image, W - 5, H - 5), pixel(s.image, W - 12, H - 12)];
  const green = [0, 255, 0];

  await publish(page, null);
  const none = await shot(page, 'auto', 'an overlay, no rectangle');
  expect(none.draw.drawn).toBe('base');
  expect(corners(none)).toEqual([green, green, green, green]);
  expect(pixel(none.image, 40, 40)).not.toEqual(green);

  // A panel in the middle: its scissor holds neither corner. Were the scissor left set, the overlay would be cut to it.
  await publish(page, [panel(400, 200, 900, 500, 24, 0.6, 0.5)]);
  const middle = await shot(page, 'auto', 'an overlay, a panel in the middle');
  expect(middle.draw).toMatchObject({ drawn: 'split', scissors: 1 });
  expect(corners(middle), 'the overlay in both corners with a panel between them').toEqual([green, green, green, green]);
  save('overlay-panel-in-the-middle', middle.image);
  // Two panels that do not reach the corners either, the last scissor at the left edge.
  await publish(page, [panel(600, 100, 1000, 300, 24, 0.6, 0.5), panel(100, 400, 500, 650, 24, 0.6, 0.5)]);
  const two = await shot(page, 'auto', 'an overlay, two panels');
  expect(two.draw).toMatchObject({ drawn: 'split', scissors: 2 });
  expect(corners(two), 'the overlay in both corners with two panels').toEqual([green, green, green, green]);
  // A panel under the overlay: the overlay is drawn over the scrim, not blurred into it.
  await publish(page, [panel(-20, -20, 300, 200, 24, 1, 0.5)]);
  const under = await shot(page, 'auto', 'an overlay over a panel');
  expect(under.draw).toMatchObject({ drawn: 'split', scissors: 1 });
  expect(corners(under), 'the overlay over a panel in the top-left corner').toEqual([green, green, green, green]);
  // Outside the overlay and the panels nothing moved.
  const d = difference(none.image, middle.image, scissorsOf([panel(400, 200, 900, 500, 24, 0.6, 0.5)]));
  expect(d.outside, `pixels outside the panel's scissor: ${told(d)}`).toBe(0);
  await publish(page, null);
  await expectNoErrors(page, pageLog);
});

/** The pages of two reference images (tests/browser/baselines.manifest.json): the pad at noon, low orbit. */
const LIVE = [
  { name: 'pad', page: '/labs/integration/?scene=pad&sun=180,65&sunsite=earth,18.987556,-155.603239&hud=0&governor=off&deterministic=1&paused=1' },
  { name: 'low-orbit', page: '/labs/integration/?scene=lowOrbit&orbit=30,15,60&hud=0&governor=off&deterministic=1&paused=1' },
];
const MENU = [panel(40, 60, 440, 660, 24, 0.6, 0.5), panel(820, 40, 1240, 240, 16, 0.3, 1), panel(820, 300, 1240, 680, 40, 1, 0.7), panel(520, 500, 760, 660, 12, 0.6, 0.5, 0.5)];

for (const live of LIVE) {
  test(`over the live scene of a reference image (${live.name}): the pass as it runs is the pass as the sweep made it, with no rectangle and under a menu`, async ({ page, pageLog }) => {
    await openPage(page, live.page, { timeoutMs: 240_000 });
    await assertDiscreteGpu(page);
    await waitIdle(page, 30, 240_000);
    await publish(page, null);
    const sweep = await shot(page, 'single', `${live.name}, no rectangle`);
    const before = await shot(page, 'base', `${live.name}, no rectangle`);
    const now = await shot(page, 'auto', `${live.name}, no rectangle`);
    save(`live-${live.name}-none`, now.image);
    expect(sweep.draw.drawn).toBe('single');
    expect(now.draw).toMatchObject({ drawn: 'base', scissors: 0, look: 2 });
    const dBefore = difference(sweep.image, before.image);
    const dNow = difference(sweep.image, now.image);
    console.log(`  ${live.name}, no rectangle: the pass before the scrim against the sweep's pass: ${told(dBefore)}; the pass as it runs: ${told(dNow)}`);
    expect(dBefore.differing, told(dBefore)).toBe(0);
    expect(dNow.differing, told(dNow)).toBe(0);
    await sameAsOneDraw(page, `live-${live.name}-menu`, MENU, sweep.image, { minChanged: 100_000 });
    await publish(page, null);
    await page.evaluate(() => window.__lab!.setTonemapPath('auto'));
    await expectNoErrors(page, pageLog);
  });
}

test('under the curve as it was (look 1, kept for one round as the comparison) both shaders of the pass carry that curve: the same comparisons', async ({ page, pageLog }) => {
  // (`corelook` is the page's switch. The tests above run the game's look, 2; this one was their look-2 twin while the default was 1.)
  await openLab(page, '&corelook=1');
  await publish(page, null);
  const none = await shot(page, 'single', 'look 1, no rectangle');
  const before = await shot(page, 'base', 'look 1, no rectangle');
  const now = await shot(page, 'auto', 'look 1, no rectangle');
  expect(none.draw.look, 'the page runs the curve as it was').toBe(1);
  expect(now.draw).toMatchObject({ drawn: 'base', look: 1 });
  save('look1-none-one-draw', none.image);
  const dBefore = difference(none.image, before.image);
  const dNow = difference(none.image, now.image);
  console.log(`  look 1, no rectangle: the pass without the scrim against the one draw: ${told(dBefore)}; the pass as it runs: ${told(dNow)}`);
  expect(dBefore.differing, told(dBefore)).toBe(0);
  expect(dNow.differing, told(dNow)).toBe(0);
  await sameAsOneDraw(page, 'look1-rounded', ROUNDED, none.image);
  await sameAsOneDraw(page, 'look1-overlapping', OVERLAPPING, none.image);
  await publish(page, null);
  await page.evaluate(() => window.__lab!.setTonemapPath('auto'));
  await expectNoErrors(page, pageLog);
});
