/**
 * The three additions of the render core that the menu over the live scene builds on (ARCHITECTURE 18.8, 23;
 * RENDER_API section 19), shown over the integration lab's pad at noon, the scene a menu will stand over:
 *
 * 1. THE UI SCRIM. Four panel rectangles published as 'ui.scrimRects' (`__lab.setScrim`): inside them the
 *    picture is the scene blurred and dimmed, outside them not one pixel moves, a rectangle of opacity 0
 *    changes nothing, and with the rectangles taken away the picture is the first one to the bit.
 * 2. THE EXPOSURE HINT. `CameraState.exposureHint`: the exposure walks to the hint's target at the hint's
 *    rate, frame by frame, stays there, and goes back to the meter's target when the hint ends; a frame-exact
 *    capture with a hint is exposed at the hint's target.
 * 3. THE LENS SHIFT. `CameraState.lensShift`: the whole picture moves by that fraction of the half viewport
 *    and is otherwise the same picture (compared pixel by pixel where the two overlap), and the strips the
 *    shift brings into the frame are drawn (terrain, sea, sky: nothing is culled against the unshifted frame).
 *
 *   node tools/dev/heavy.mjs --class=gpu -- npx playwright test tests/browser/integration/menu-core.spec.ts --project=functional
 *
 * Pictures: out/screens/presentation-sweep/menu-core/.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { PNG } from 'pngjs';
import { assertDiscreteGpu, captureDeterministic, captureReference, expect, expectNoErrors, openPage, test, waitIdle } from '../harness';
import { repoRoot } from './helpers';

test.setTimeout(20 * 60_000);
const W = 1280;
const H = 720;
test.use({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });

const PAGE = '/labs/integration/?scene=pad&sun=180,65&sunsite=earth,18.987556,-155.603239&hud=0&governor=off';
const outDir = path.join(repoRoot, 'out', 'screens', 'presentation-sweep', 'menu-core');
const save = (name: string, png: Buffer): void => {
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, `${name}.png`), png);
};

interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  cornerRadius: number;
  blur: number;
  dim: number;
  opacity: number;
}
interface Hint {
  targetEv100: number;
  rateEvPerS: number;
}
interface DepthImage {
  width: number;
  height: number;
  data: Float32Array;
}
interface LabPage {
  __lab: {
    setScrim(rects: Rect[] | null): void;
    setLoop(running: boolean): void;
    renderFrame(realDt?: number): void;
    camera: { settings: { lensShift: [number, number] | null; exposureHint: Hint | null } };
    renderer: { exposureInfo(): { ev100: number; targetEv100: number; hint: Hint | null }; setExposureOverride(ev: number | null): void; readDepth(): Promise<DepthImage>; readHdrPixels(target: 'hdr' | 'resolved'): Promise<DepthImage> };
  };
}

/** Luma (0..255) of a picture, row-major. */
function lumaOf(png: Buffer): Float32Array {
  const p = PNG.sync.read(png);
  expect([p.width, p.height]).toEqual([W, H]);
  const out = new Float32Array(W * H);
  for (let i = 0; i < out.length; i++) out[i] = 0.2126 * p.data[i * 4]! + 0.7152 * p.data[i * 4 + 1]! + 0.0722 * p.data[i * 4 + 2]!;
  return out;
}
/** Mean luma and mean absolute difference between horizontal neighbours (a measure of detail) inside a box. */
function boxStats(l: Float32Array, x0: number, y0: number, x1: number, y1: number): { mean: number; detail: number } {
  let sum = 0;
  let grad = 0;
  let n = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1 - 1; x++) {
      sum += l[y * W + x]!;
      grad += Math.abs(l[y * W + x + 1]! - l[y * W + x]!);
      n++;
    }
  }
  return { mean: sum / n, detail: grad / n };
}
/** Pixels (rgb) that differ between two pictures inside / outside a set of boxes grown by `margin` pixels. */
function differing(a: Buffer, b: Buffer, boxes: readonly Rect[], margin: number): { inside: number; outside: number; outsideMax: number } {
  const A = PNG.sync.read(a);
  const B = PNG.sync.read(b);
  let inside = 0;
  let outside = 0;
  let outsideMax = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const d = Math.max(Math.abs(A.data[i]! - B.data[i]!), Math.abs(A.data[i + 1]! - B.data[i + 1]!), Math.abs(A.data[i + 2]! - B.data[i + 2]!));
      if (d === 0) continue;
      if (boxes.some((r) => x >= r.x0 - margin && x < r.x1 + margin && y >= r.y0 - margin && y < r.y1 + margin)) inside++;
      else {
        outside++;
        outsideMax = Math.max(outsideMax, d);
      }
    }
  }
  return { inside, outside, outsideMax };
}

async function openLab(page: Page, extra: string): Promise<void> {
  await openPage(page, `${PAGE}${extra}`, { timeoutMs: 240_000 });
  await assertDiscreteGpu(page);
}

test('a scrim over the live pad: blurred and dimmed inside its rectangles, not a pixel moved outside them', async ({ page, pageLog }) => {
  await openLab(page, '&deterministic=1&paused=1');
  const base = (await captureReference(page, 64, 'the pad without a scrim')).image;
  save('scrim-0-none', base);

  // A menu's panels: a tall one on the left (frosted, half as bright), a lightly blurred one that is not dimmed,
  // the widest blur, and a small one half faded in.
  const rects: Rect[] = [
    { x0: 40, y0: 60, x1: 440, y1: 660, cornerRadius: 24, blur: 0.6, dim: 0.5, opacity: 1 },
    { x0: 820, y0: 40, x1: 1240, y1: 240, cornerRadius: 16, blur: 0.3, dim: 1, opacity: 1 },
    { x0: 820, y0: 300, x1: 1240, y1: 680, cornerRadius: 40, blur: 1, dim: 0.7, opacity: 1 },
    { x0: 520, y0: 500, x1: 760, y1: 660, cornerRadius: 12, blur: 0.6, dim: 0.5, opacity: 0.5 },
  ];
  await page.evaluate((r) => (window as unknown as LabPage).__lab.setScrim(r), rects);
  const withScrim = (await captureReference(page, 64, 'the pad under four scrim rectangles')).image;
  save('scrim-1-four-panels', withScrim);

  // Outside the rectangles (their edge ramp is one pixel wide: a margin of two) the picture is the same to the bit.
  const d = differing(base, withScrim, rects, 2);
  console.log(`four rectangles: ${d.inside} pixels changed inside them, ${d.outside} outside (by up to ${d.outsideMax} levels)`);
  expect(d.outside, 'pixels changed outside the rectangles').toBe(0);
  expect(d.inside).toBeGreaterThan(100_000);

  const a = lumaOf(base);
  const b = lumaOf(withScrim);
  const inner = (r: Rect): [number, number, number, number] => [r.x0 + r.cornerRadius, r.y0 + r.cornerRadius, r.x1 - r.cornerRadius, r.y1 - r.cornerRadius];
  const rows = rects.map((r) => ({ r, before: boxStats(a, ...inner(r)), after: boxStats(b, ...inner(r)) }));
  for (const { r, before, after } of rows) {
    console.log(`  blur ${r.blur}, dim ${r.dim}, opacity ${r.opacity}: mean luma ${before.mean.toFixed(1)} -> ${after.mean.toFixed(1)}, detail ${before.detail.toFixed(3)} -> ${after.detail.toFixed(3)}`);
  }
  // Blurred: the detail inside a fully opaque panel falls to a fraction (the wider the blur, the less is left).
  expect(rows[0]!.after.detail).toBeLessThan(0.25 * rows[0]!.before.detail);
  expect(rows[1]!.after.detail).toBeLessThan(0.6 * rows[1]!.before.detail);
  expect(rows[2]!.after.detail).toBeLessThan(0.15 * rows[2]!.before.detail);
  expect(rows[2]!.after.detail / rows[2]!.before.detail).toBeLessThan(rows[1]!.after.detail / rows[1]!.before.detail);
  // Dimmed where the panel says so, as bright as the scene where it does not (dim 1), in between when half faded.
  expect(rows[0]!.after.mean).toBeLessThan(0.85 * rows[0]!.before.mean);
  expect(Math.abs(rows[1]!.after.mean - rows[1]!.before.mean)).toBeLessThan(0.06 * rows[1]!.before.mean);
  expect(rows[2]!.after.mean).toBeLessThan(0.95 * rows[2]!.before.mean);
  expect(rows[3]!.after.mean).toBeLessThan(rows[3]!.before.mean);
  expect(rows[3]!.after.detail).toBeLessThan(rows[3]!.before.detail);
  expect(rows[3]!.after.detail).toBeGreaterThan(0.3 * rows[3]!.before.detail);

  // A rectangle that is not faded in at all changes nothing; and with the rectangles gone the picture is the first.
  await page.evaluate((r) => (window as unknown as LabPage).__lab.setScrim([{ ...r, opacity: 0 }]), rects[0]!);
  const faded = (await captureReference(page, 64, 'the pad under a rectangle of opacity 0')).image;
  expect(differing(base, faded, [], 0).outside, 'pixels changed by a rectangle of opacity 0').toBe(0);
  await page.evaluate(() => (window as unknown as LabPage).__lab.setScrim(null));
  const again = (await captureReference(page, 64, 'the pad after the scrim')).image;
  expect(differing(base, again, [], 0).outside, 'pixels that differ from the first picture once the rectangles are gone').toBe(0);
  await expectNoErrors(page, pageLog);
});

test('the exposure follows a hint at its rate, holds its target and goes back to the meter', async ({ page, pageLog }) => {
  await openLab(page, '&paused=1');
  // The scene streamed in and at rest first: the frames below are rendered in one go, and no tile arrives
  // between them (a page that is still streaming shows the coarse levels, with the sea over the shore).
  await waitIdle(page, 60, 240_000);
  // Frames by hand, a sixtieth of a second each.
  const step = (frames: number): Promise<{ ev100: number; targetEv100: number; hint: Hint | null }> =>
    page.evaluate((n) => {
      (window as unknown as LabPage).__lab.setLoop(false);
      for (let i = 0; i < n; i++) (window as unknown as LabPage).__lab.renderFrame(1 / 60);
      return (window as unknown as LabPage).__lab.renderer.exposureInfo();
    }, frames);
  const settled = await step(240);
  expect(settled.hint).toBeNull();
  expect(Math.abs(settled.ev100 - settled.targetEv100), 'the metered exposure is at rest').toBeLessThan(0.05);
  save('hint-0-metered', await page.screenshot());

  const hint: Hint = { targetEv100: settled.ev100 + 2, rateEvPerS: 1 };
  await page.evaluate((h) => {
    (window as unknown as LabPage).__lab.camera.settings.exposureHint = h;
  }, hint);
  // One EV a second: half way after a second, there after two, and there it stays.
  const half = await step(60);
  expect(half.hint).toEqual(hint);
  expect(half.ev100).toBeCloseTo(settled.ev100 + 1, 6);
  const there = await step(60);
  expect(there.ev100).toBeCloseTo(hint.targetEv100, 9);
  const held = await step(90);
  expect(held.ev100).toBe(hint.targetEv100);
  const dark = await page.screenshot();
  save('hint-1-two-stops-down', dark);
  console.log(`metered EV100 ${settled.ev100.toFixed(3)}; with the hint ${half.ev100.toFixed(3)} after 1 s, ${there.ev100.toFixed(3)} after 2 s, ${held.ev100.toFixed(3)} held (meter's own target meanwhile ${held.targetEv100.toFixed(3)})`);

  // Two stops down is a darker picture.
  const before = boxStats(lumaOf(await page.screenshot()), 0, 0, W, H);
  await page.evaluate(() => {
    (window as unknown as LabPage).__lab.camera.settings.exposureHint = null;
  });
  const back = await step(600);
  expect(back.hint).toBeNull();
  expect(Math.abs(back.ev100 - back.targetEv100), 'back on the meter after the hint').toBeLessThan(0.1);
  const after = boxStats(lumaOf(await page.screenshot()), 0, 0, W, H);
  console.log(`mean luma at the hint's target ${before.mean.toFixed(1)}, back on the meter ${after.mean.toFixed(1)} (EV100 ${back.ev100.toFixed(3)})`);
  expect(before.mean).toBeLessThan(0.6 * after.mean);

  // A rate of zero holds the exposure where it is, whatever the target.
  await page.evaluate((ev) => {
    (window as unknown as LabPage).__lab.camera.settings.exposureHint = { targetEv100: ev + 5, rateEvPerS: 0 };
  }, back.ev100);
  expect((await step(60)).ev100).toBe(back.ev100);
  await expectNoErrors(page, pageLog);

  // A frame-exact capture with a hint is exposed at the hint's target.
  await openLab(page, `&deterministic=1&paused=1&evhint=${(settled.ev100 + 2).toFixed(4)},1`);
  save('hint-2-exact-capture', await captureDeterministic(page, 64));
  const exact = await page.evaluate(() => (window as unknown as LabPage).__lab.renderer.exposureInfo());
  expect(exact.ev100).toBeCloseTo(settled.ev100 + 2, 4);
});

test('a lens shift moves the whole picture and brings the rest of the scene into the frame', async ({ page, pageLog }) => {
  // A fixed exposure: the meter would read the two frames (they show different parts of the scene) differently.
  const EV = 14;
  await openLab(page, `&deterministic=1&paused=1&ev=${EV}`);
  const base = (await captureReference(page, 64, 'the pad, no lens shift')).image;
  save('shift-0-none', base);
  // The depth of the frame the capture holds, kept in the page for the comparison below.
  await page.evaluate(async () => {
    (window as unknown as { __depth0: DepthImage }).__depth0 = await (window as unknown as LabPage).__lab.renderer.readDepth();
    (window as unknown as { __hdr0: DepthImage }).__hdr0 = await (window as unknown as LabPage).__lab.renderer.readHdrPixels('hdr');
  });
  // The picture moves 128 pixels right and 64 up (a fifth of the half width, 0.178 of the half height): whole
  // pixels, so every pixel of the shifted frame looks along the ray of a pixel of the unshifted one, and
  // multiples of the 64 pixel blue-noise tile and of the quarter-resolution lattices, so the stochastic parts
  // of the frame (dither, shadow taps, march offsets, the cloud lattice) fall on the same scene points too.
  const dx = 128;
  const dy = 64;
  const shift: [number, number] = [dx / (W / 2), dy / (H / 2)];
  await page.evaluate((s) => {
    (window as unknown as LabPage).__lab.camera.settings.lensShift = s;
  }, shift);
  const shifted = (await captureReference(page, 64, `the pad, lens shift ${shift[0].toFixed(3)}, ${shift[1].toFixed(3)}`)).image;
  save('shift-1-right-and-up', shifted);

  // THE GEOMETRY, from the depth buffers (no shading, no noise): where both frames show the scene, the shifted
  // frame has at (x, y) the depth the unshifted one has at (x - dx, y + dy).
  const depth = await page.evaluate(
    async ([sx, sy]) => {
      const a = (window as unknown as { __depth0: DepthImage }).__depth0;
      const b = await (window as unknown as LabPage).__lab.renderer.readDepth();
      const w = a.width;
      const h = a.height;
      let n = 0;
      let off = 0;
      let offByOnePixel = 0;
      for (let y = 0; y < h - sy; y++) {
        for (let x = sx + 1; x < w; x++) {
          const d = b.data[y * w + x]!;
          const at = (px: number): boolean => {
            const e = a.data[(y + sy) * w + px]!;
            return Math.abs(e - d) > 1e-3 * Math.max(e, d);
          };
          n++;
          if (at(x - sx)) off++;
          if (at(x - sx - 1)) offByOnePixel++;
        }
      }
      // The lit scene before the temporal resolve (one jittered frame, rgba float): pixels whose luminance
      // differs by more than a twentieth.
      const p = (window as unknown as { __hdr0: DepthImage }).__hdr0;
      const q = await (window as unknown as LabPage).__lab.renderer.readHdrPixels('hdr');
      const lum = (im: DepthImage, x: number, y: number): number => 0.2126 * im.data[(y * w + x) * 4]! + 0.7152 * im.data[(y * w + x) * 4 + 1]! + 0.0722 * im.data[(y * w + x) * 4 + 2]!;
      let litOff = 0;
      for (let y = 0; y < h - sy; y++) {
        for (let x = sx + 1; x < w; x++) {
          const u = lum(p, x - sx, y + sy);
          const v = lum(q, x, y);
          if (Math.abs(u - v) > 0.05 * Math.max(u, v, 1e-6)) litOff++;
        }
      }
      return { width: w, height: h, n, off, offByOnePixel, litOff, same: b.width === w && b.height === h && q.width === w && p.width === w };
    },
    [dx, dy] as const,
  );
  expect([depth.width, depth.height, depth.same], 'the depth buffers are at the display resolution').toEqual([W, H, true]);
  console.log(
    `depth where both frames show the scene (${depth.n} pixels): ${depth.off} (${((100 * depth.off) / depth.n).toFixed(3)} %) differ by more than a thousandth; against the pixel beside the right one ${((100 * depth.offByOnePixel) / depth.n).toFixed(1)} % would; the lit scene before the temporal resolve differs by more than a twentieth in ${((100 * depth.litOff) / depth.n).toFixed(2)} % of them`,
  );
  expect(depth.off / depth.n, 'share of the overlap whose depth differs by more than a thousandth').toBeLessThan(0.005);
  expect(depth.offByOnePixel / depth.n, 'the depth comparison is sensitive to one pixel').toBeGreaterThan(20 * Math.max(depth.off / depth.n, 0.0005));

  // THE PICTURE. Not to the bit: thin things (lattice members, the fence, leaves, cloud edges) are drawn with a
  // coverage that is decided per pixel and frame, and they land on other pixels of the frame.
  const A = PNG.sync.read(base);
  const B = PNG.sync.read(shifted);
  // Where the two overlap: shifted (x, y) shows what the unshifted frame shows at (x - dx, y + dy).
  let n = 0;
  let sum = 0;
  let far = 0;
  let same = 0;
  for (let y = 0; y < H - dy; y++) {
    for (let x = dx; x < W; x++) {
      const i = (y * W + x) * 4;
      const j = ((y + dy) * W + (x - dx)) * 4;
      const d = Math.max(Math.abs(A.data[j]! - B.data[i]!), Math.abs(A.data[j + 1]! - B.data[i + 1]!), Math.abs(A.data[j + 2]! - B.data[i + 2]!));
      sum += d;
      if (d === 0) same++;
      if (d > 8) far++;
      n++;
    }
  }
  // The same comparison one pixel off, as a measure of what a wrong shift would look like in this picture.
  let offSum = 0;
  for (let y = 0; y < H - dy; y++) {
    for (let x = dx + 1; x < W; x++) {
      const i = (y * W + x) * 4;
      const j = ((y + dy) * W + (x - dx - 1)) * 4;
      offSum += Math.max(Math.abs(A.data[j]! - B.data[i]!), Math.abs(A.data[j + 1]! - B.data[i + 1]!), Math.abs(A.data[j + 2]! - B.data[i + 2]!));
    }
  }
  const mean = sum / n;
  const offMean = offSum / n;
  console.log(
    `lens shift ${shift[0].toFixed(4)}, ${shift[1].toFixed(4)} = ${dx}, ${dy} px: over the ${n} pixels both frames show, mean difference ${mean.toFixed(3)} levels, ${((100 * same) / n).toFixed(1)} % identical, ${((100 * far) / n).toFixed(2)} % by more than 8 levels; one pixel off the mean would be ${offMean.toFixed(3)}`,
  );
  expect(mean, 'mean difference where the two frames overlap, levels').toBeLessThan(1.5);
  expect(same / n, 'share of the overlap that is the same to the bit').toBeGreaterThan(0.4);
  expect(far / n, 'share of the overlap that differs by more than 8 levels').toBeLessThan(0.04);
  expect(offMean, 'the comparison is sensitive to one pixel').toBeGreaterThan(4 * mean);

  // What the shift brought into the frame (a strip on the left, a strip at the bottom) is drawn: no black hole
  // where a tile, the sea or the sky was culled against the unshifted frame.
  const l = lumaOf(shifted);
  const strips = { left: boxStats(l, 0, 0, dx, H), bottom: boxStats(l, 0, H - dy, W, H), rest: boxStats(l, dx, 0, W, H - dy) };
  let black = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if ((x < dx || y >= H - dy) && l[y * W + x]! < 2) black++;
  console.log(`strips brought in: left mean luma ${strips.left.mean.toFixed(1)}, bottom ${strips.bottom.mean.toFixed(1)} (the rest ${strips.rest.mean.toFixed(1)}); ${black} black pixels in them`);
  expect(black, 'black pixels in the strips the shift brought into the frame').toBe(0);
  expect(strips.left.mean).toBeGreaterThan(0.3 * strips.rest.mean);
  expect(strips.bottom.mean).toBeGreaterThan(0.3 * strips.rest.mean);
  expect(strips.left.detail).toBeGreaterThan(0.05);
  expect(strips.bottom.detail).toBeGreaterThan(0.05);
  await expectNoErrors(page, pageLog);
});
