/**
 * Procedural navball texture, drawn once with Canvas 2D into an equirectangular 2048 x 1024 image
 * (u = heading / 360, north at u = 0; v = (90 - pitch) / 180) plus its full mip chain:
 *   - sky (pitch > 0) blue and ground brown hemispheres with a soft gradient toward the poles,
 *   - a bold horizon line, heading ticks every 10 deg and labels every 30 deg (N, 030, 060, E ...),
 *   - meridians every 30 deg, the pitch ladder every 10 deg (heavier every 30 deg) with numerals on every
 *     meridian, minus-signed below the horizon,
 *   - zenith and nadir pole marks.
 * Every label is pre-stretched by 1 / cos(latitude), so it reads undistorted on the sphere.
 */
import { BALL_TEXTURE_SIZE } from './navballMath';

const FONT = 'Bahnschrift, "DIN Alternate", "Segoe UI", system-ui, sans-serif';

type Ctx = OffscreenCanvasRenderingContext2D;

export const BALL_COLORS = {
  skyHorizon: [70, 136, 204],
  skyZenith: [24, 70, 128],
  groundHorizon: [160, 98, 48],
  groundNadir: [74, 42, 18],
} as const;

const rgb = (c: readonly number[], a = 1): string => `rgba(${c[0]},${c[1]},${c[2]},${a})`;

export function drawBallTexture(width = BALL_TEXTURE_SIZE[0], height = BALL_TEXTURE_SIZE[1]): OffscreenCanvas {
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d') as Ctx;
  const W = width;
  const H = height;
  const yOf = (pitch: number): number => ((90 - pitch) / 180) * H;
  const xOf = (heading: number): number => (heading / 360) * W;
  const k = H / 1024;

  // Hemispheres.
  const sky = ctx.createLinearGradient(0, 0, 0, H / 2);
  sky.addColorStop(0, rgb(BALL_COLORS.skyZenith));
  sky.addColorStop(1, rgb(BALL_COLORS.skyHorizon));
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, W, H / 2);
  const ground = ctx.createLinearGradient(0, H / 2, 0, H);
  ground.addColorStop(0, rgb(BALL_COLORS.groundHorizon));
  ground.addColorStop(1, rgb(BALL_COLORS.groundNadir));
  ctx.fillStyle = ground;
  ctx.fillRect(0, H / 2, W, H / 2);

  const hline = (pitch: number, thickness: number, color: string, x0 = 0, x1 = W): void => {
    ctx.fillStyle = color;
    ctx.fillRect(x0, yOf(pitch) - thickness / 2, x1 - x0, thickness);
  };
  const vline = (heading: number, p0: number, p1: number, thickness: number, color: string): void => {
    ctx.fillStyle = color;
    for (const dx of [0, -W, W]) ctx.fillRect(xOf(heading) + dx - thickness / 2, yOf(p1), thickness, yOf(p0) - yOf(p1));
  };

  /** Text centred at (heading, pitch), stretched horizontally by 1 / cos(pitch). Wraps across the seam. */
  const label = (text: string, heading: number, pitch: number, px: number, color: string, weight = 600): void => {
    const stretch = Math.min(9, 1 / Math.max(0.11, Math.cos((pitch * Math.PI) / 180)));
    ctx.save();
    ctx.font = `${weight} ${Math.round(px * k)}px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = color;
    const w = ctx.measureText(text).width * stretch;
    for (const dx of [0, -W, W]) {
      const x = xOf(heading) + dx;
      if (x + w / 2 < 0 || x - w / 2 > W) continue;
      ctx.save();
      ctx.translate(x, yOf(pitch));
      ctx.scale(stretch, 1);
      ctx.shadowColor = 'rgba(0,0,0,0.35)';
      ctx.shadowBlur = 2 * k;
      ctx.fillText(text, 0, 0);
      ctx.restore();
    }
    ctx.restore();
  };

  // Pitch ladder: full latitude circles every 10 deg, heavier every 30 deg.
  for (let p = -80; p <= 80; p += 10) {
    if (p === 0) continue;
    const major = p % 30 === 0;
    const a = p > 0 ? (major ? 0.62 : 0.4) : major ? 0.55 : 0.34;
    hline(p, (major ? 3.2 : 2.0) * k, `rgba(255,255,255,${a})`);
  }
  // Five-degree minor ticks along every meridian.
  for (let h = 0; h < 360; h += 30) {
    for (let p = -85; p <= 85; p += 5) {
      if (p % 10 === 0) continue;
      const half = (1.4 / Math.max(0.15, Math.cos((p * Math.PI) / 180))) * (W / 360);
      ctx.fillStyle = 'rgba(255,255,255,0.45)';
      for (const dx of [0, -W, W]) ctx.fillRect(xOf(h) + dx - half, yOf(p) - 1 * k, 2 * half, 2 * k);
    }
  }
  // Meridians every 30 deg; cardinal ones heavier.
  for (let h = 0; h < 360; h += 30) {
    const cardinal = h % 90 === 0;
    vline(h, -84, 84, (cardinal ? 3.4 : 2.2) * k, `rgba(255,255,255,${cardinal ? 0.6 : 0.4})`);
  }
  // Horizon and its heading ticks.
  hline(0, 6 * k, 'rgba(255,255,255,0.97)');
  for (let h = 0; h < 360; h += 5) {
    const major = h % 10 === 0;
    const len = (h % 30 === 0 ? 3.2 : major ? 2.0 : 1.1) * (H / 180);
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    for (const dx of [0, -W, W]) ctx.fillRect(xOf(h) + dx - 1.4 * k, yOf(0) - len, 2.8 * k, 2 * len);
  }
  // Heading labels just above and below the horizon.
  const headingName = (h: number): string => ({ 0: 'N', 90: 'E', 180: 'S', 270: 'W' })[h] ?? String(h).padStart(3, '0');
  for (let h = 0; h < 360; h += 30) {
    const cardinal = h % 90 === 0;
    label(headingName(h), h, 6.2, cardinal ? 50 : 38, 'rgba(255,255,255,0.98)', cardinal ? 700 : 600);
  }
  // Pitch numerals on every other meridian (offset to the right of the line).
  for (let h = 0; h < 360; h += 60) {
    for (let p = -80; p <= 80; p += 10) {
      if (p === 0) continue;
      const offset = 6 / Math.max(0.12, Math.cos((p * Math.PI) / 180));
      const text = p > 0 ? String(p) : `−${-p}`;
      label(text, (h + 15 + offset) % 360, p, 32, p > 0 ? 'rgba(255,255,255,0.95)' : 'rgba(255,236,214,0.92)');
    }
  }
  // Poles: a ring and a centre dot at the zenith (light) and the nadir (dark).
  hline(86.2, 2.6 * k, 'rgba(255,255,255,0.75)');
  ctx.fillStyle = 'rgba(255,255,255,0.95)';
  ctx.fillRect(0, 0, W, yOf(88.6));
  hline(-86.2, 2.6 * k, 'rgba(255,230,200,0.6)');
  ctx.fillStyle = 'rgba(30,16,6,0.95)';
  ctx.fillRect(0, yOf(-88.6), W, H - yOf(-88.6));
  return canvas;
}

/** Mip chain of a canvas by successive high-quality halving (level 0 = the input). */
export function buildMipChain(base: OffscreenCanvas): OffscreenCanvas[] {
  const levels: OffscreenCanvas[] = [base];
  let w = base.width;
  let h = base.height;
  while (w > 1 || h > 1) {
    const nw = Math.max(1, w >> 1);
    const nh = Math.max(1, h >> 1);
    const c = new OffscreenCanvas(nw, nh);
    const ctx = c.getContext('2d') as Ctx;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(levels[levels.length - 1]!, 0, 0, nw, nh);
    levels.push(c);
    w = nw;
    h = nh;
  }
  return levels;
}
