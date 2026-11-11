/** Shared helpers of the vfx browser specs. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { PNG } from 'pngjs';
import type {} from '../../../labs/vfx/main';
import { assertDiscreteGpu, openPage, waitIdle } from '../harness';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** Open the vfx lab paused, without the HUD, in deterministic mode. */
export async function openLab(page: Page, query: string): Promise<void> {
  await openPage(page, `/labs/vfx/?${query}&paused=1&hud=0`);
  await assertDiscreteGpu(page);
  await page.evaluate(() => window.__test!.setDeterministic(true));
}

/** Run the lab clock to `t` seconds, then let the image settle with the sim paused. */
export async function runAndSettle(page: Page, t: number | null, frames = 40): Promise<void> {
  if (t !== null) await page.evaluate((x) => window.__vfx!.runTo(x), t);
  await waitIdle(page, frames);
}

export interface HdrSummary {
  /** Sum and maximum of the luminance of the HDR scene target (pre-exposed), and NaN / Inf pixel count. */
  sum: number;
  max: number;
  nan: number;
  width: number;
  height: number;
}

/** Luminance statistics of the HDR scene target (before TAA). */
export function hdrSummary(page: Page): Promise<HdrSummary> {
  return page.evaluate(async () => {
    const px = await window.__lab!.renderer.readHdrPixels('hdr');
    let sum = 0;
    let max = 0;
    let nan = 0;
    for (let i = 0; i < px.data.length; i += 4) {
      const l = 0.2126 * px.data[i]! + 0.7152 * px.data[i + 1]! + 0.0722 * px.data[i + 2]!;
      if (!Number.isFinite(l)) {
        nan++;
        continue;
      }
      sum += l;
      if (l > max) max = l;
    }
    return { sum, max, nan, width: px.width, height: px.height };
  });
}

/** Halve a PNG (2 x 2 box filter). */
function halve(src: PNG): PNG {
  const w = src.width >> 1;
  const h = src.height >> 1;
  const out = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      for (let c = 0; c < 4; c++) {
        const i = (2 * y * src.width + 2 * x) * 4 + c;
        out.data[(y * w + x) * 4 + c] = (src.data[i]! + src.data[i + 4]! + src.data[i + src.width * 4]! + src.data[i + src.width * 4 + 4]! + 2) >> 2;
      }
    }
  }
  return out;
}

/** Paste equally sized PNG buffers (halved when `half`) into one sheet of `columns` columns and save it under out/screens/vfx. */
export function saveSheet(name: string, images: Buffer[], columns: number, half = false): string {
  const decoded = images.map((b) => (half ? halve(PNG.sync.read(b)) : PNG.sync.read(b)));
  const w = decoded[0]!.width;
  const h = decoded[0]!.height;
  const rows = Math.ceil(decoded.length / columns);
  const sheet = new PNG({ width: w * columns, height: h * rows });
  sheet.data.fill(0);
  decoded.forEach((img, i) => {
    const ox = (i % columns) * w;
    const oy = Math.floor(i / columns) * h;
    for (let y = 0; y < h; y++) img.data.copy(sheet.data, ((oy + y) * sheet.width + ox) * 4, y * w * 4, (y + 1) * w * 4);
  });
  const dir = path.join(repoRoot, 'out', 'screens', 'vfx');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}.png`);
  fs.writeFileSync(file, PNG.sync.write(sheet));
  return file;
}
