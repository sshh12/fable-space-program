/**
 * Procedural navball texture, drawn once with Canvas 2D into an equirectangular 2048 x 1024 image
 * (u = heading / 360, north at u = 0; v = (90 - pitch) / 180) plus its full mip chain:
 *   - sky (pitch > 0) blue and ground brown hemispheres with a soft gradient toward the poles,
 *   - a bold horizon line with heading ticks every 5 / 10 / 30 deg and labels every 30 deg (N, 030, 060, E ...)
 *     just above it,
 *   - meridians every 30 deg (cardinal ones heavier) and the pitch ladder every 10 deg (heavier every 30 deg),
 *     both stopping at the pole rings,
 *   - pitch numerals centred on the ladder lines in the open between the meridians, 15 deg from every heading
 *     label: +-20 to +-60 on four columns (45, 135, 225, 315 deg), +-70 on two; none at +-10 (the first
 *     line off the horizon) and none at +-80, so the pole regions stay clean,
 *   - zenith and nadir marks that are larger than the reticle hub drawn over them: a bold ring at 80 deg with
 *     four inward ticks and a cap from 87.5 deg, so the pole frames the reticle when the nose is on it.
 * Every label is pre-stretched by 1 / cos(latitude), so it reads undistorted on the sphere, and is drawn over a
 * halo of the local background colour that knocks the grid out behind it (a line never runs through a glyph).
 */
import { BALL_TEXTURE_SIZE } from './navballMath';

const FONT = 'Bahnschrift, "DIN Alternate", "Segoe UI", system-ui, sans-serif';

type Ctx = OffscreenCanvasRenderingContext2D;

export const BALL_COLORS = {
  skyHorizon: [72, 140, 208],
  skyZenith: [22, 66, 124],
  groundHorizon: [164, 100, 48],
  groundNadir: [70, 40, 17],
} as const;

/** Latitude of the pole rings and the start of the pole caps, degrees. */
export const POLE_RING_DEG = 80;
export const POLE_CAP_DEG = 87.5;

const rgb = (c: readonly number[], a = 1): string => `rgba(${c[0]},${c[1]},${c[2]},${a})`;

/** Background colour of the texture at a pitch (the hemisphere gradients). */
function background(pitch: number): number[] {
  const t = Math.min(1, Math.abs(pitch) / 90);
  const [a, b] = pitch >= 0 ? [BALL_COLORS.skyHorizon, BALL_COLORS.skyZenith] : [BALL_COLORS.groundHorizon, BALL_COLORS.groundNadir];
  return [0, 1, 2].map((i) => Math.round(a[i]! + (b[i]! - a[i]!) * t));
}

export function drawBallTexture(width = BALL_TEXTURE_SIZE[0], height = BALL_TEXTURE_SIZE[1]): OffscreenCanvas {
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d') as Ctx;
  const W = width;
  const H = height;
  const yOf = (pitch: number): number => ((90 - pitch) / 180) * H;
  const xOf = (heading: number): number => (heading / 360) * W;
  const k = H / 1024;
  const cosd = (deg: number): number => Math.cos((deg * Math.PI) / 180);

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

  /**
   * Text centred at (heading, pitch), stretched horizontally by 1 / cos(pitch), over a halo of the background
   * colour (`halo` px wide) that clears the grid behind it. Wraps across the seam.
   */
  const label = (text: string, heading: number, pitch: number, px: number, color: string, weight = 600, halo = 9): void => {
    const stretch = Math.min(9, 1 / Math.max(0.11, cosd(pitch)));
    ctx.save();
    ctx.font = `${weight} ${Math.round(px * k)}px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const w = ctx.measureText(text).width * stretch;
    const bg = rgb(background(pitch));
    for (const dx of [0, -W, W]) {
      const x = xOf(heading) + dx;
      if (x + w / 2 + halo * stretch < 0 || x - w / 2 - halo * stretch > W) continue;
      ctx.save();
      ctx.translate(x, yOf(pitch));
      ctx.scale(stretch, 1);
      ctx.lineJoin = 'round';
      ctx.strokeStyle = bg;
      ctx.lineWidth = halo * k;
      ctx.strokeText(text, 0, 0);
      ctx.fillStyle = color;
      ctx.shadowColor = 'rgba(0,0,0,0.3)';
      ctx.shadowBlur = 2 * k;
      ctx.fillText(text, 0, 0);
      ctx.restore();
    }
    ctx.restore();
  };

  // Pitch ladder: full latitude circles every 10 deg up to 70, heavier every 30 deg.
  for (let p = -70; p <= 70; p += 10) {
    if (p === 0) continue;
    const major = p % 30 === 0;
    const a = p > 0 ? (major ? 0.66 : 0.42) : major ? 0.58 : 0.36;
    hline(p, (major ? 3.4 : 2.2) * k, `rgba(255,255,255,${a})`);
  }
  // Five-degree minor ticks along every meridian.
  for (let h = 0; h < 360; h += 30) {
    for (let p = -75; p <= 75; p += 5) {
      if (p % 10 === 0) continue;
      const half = (1.5 / Math.max(0.15, cosd(p))) * (W / 360);
      ctx.fillStyle = 'rgba(255,255,255,0.5)';
      for (const dx of [0, -W, W]) ctx.fillRect(xOf(h) + dx - half, yOf(p) - 1.1 * k, 2 * half, 2.2 * k);
    }
  }
  // Meridians every 30 deg, stopping at the pole rings; cardinal ones heavier.
  for (let h = 0; h < 360; h += 30) {
    const cardinal = h % 90 === 0;
    vline(h, -POLE_RING_DEG, POLE_RING_DEG, (cardinal ? 3.6 : 2.4) * k, `rgba(255,255,255,${cardinal ? 0.62 : 0.42})`);
  }
  // Horizon and its heading ticks.
  hline(0, 6.4 * k, 'rgba(255,255,255,0.97)');
  for (let h = 0; h < 360; h += 5) {
    const major = h % 10 === 0;
    const len = (h % 30 === 0 ? 3.0 : major ? 1.9 : 1.1) * (H / 180);
    ctx.fillStyle = 'rgba(255,255,255,0.92)';
    for (const dx of [0, -W, W]) ctx.fillRect(xOf(h) + dx - 1.5 * k, yOf(0) - len, 3 * k, 2 * len);
  }
  // Heading labels just above the horizon.
  const headingName = (h: number): string => ({ 0: 'N', 90: 'E', 180: 'S', 270: 'W' })[h] ?? String(h).padStart(3, '0');
  for (let h = 0; h < 360; h += 30) {
    const cardinal = h % 90 === 0;
    label(headingName(h), h, 6.6, cardinal ? 56 : 42, 'rgba(255,255,255,0.98)', cardinal ? 700 : 600, 10);
  }
  // Pitch numerals on the ladder lines between the meridians (45 deg off the cardinal headings).
  for (const h of [45, 135, 225, 315]) {
    for (let p = -70; p <= 70; p += 10) {
      if (Math.abs(p) < 20) continue;
      if (Math.abs(p) === 70 && h !== 45 && h !== 225) continue;
      const text = p > 0 ? String(p) : `−${-p}`;
      label(text, h, p, 40, p > 0 ? 'rgba(255,255,255,0.97)' : 'rgba(255,238,218,0.95)', 600, 11);
    }
  }
  // Poles: a bold ring with four inward ticks on the cardinal meridians, and a cap.
  const pole = (sign: 1 | -1, ring: string, cap: string, capEdge: string): void => {
    const pr = sign * POLE_RING_DEG;
    hline(pr, 7 * k, ring);
    for (let h = 0; h < 360; h += 90) vline(h, Math.min(pr, sign * 84), Math.max(pr, sign * 84), 4.6 * k, ring);
    const yc = yOf(sign * POLE_CAP_DEG);
    ctx.fillStyle = cap;
    if (sign > 0) ctx.fillRect(0, 0, W, yc);
    else ctx.fillRect(0, yc, W, H - yc);
    hline(sign * POLE_CAP_DEG, 3 * k, capEdge);
  };
  pole(1, 'rgba(255,255,255,0.96)', 'rgba(255,255,255,0.96)', 'rgba(255,255,255,1)');
  pole(-1, 'rgba(255,226,190,0.92)', 'rgba(26,13,4,0.97)', 'rgba(255,226,190,0.95)');
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
