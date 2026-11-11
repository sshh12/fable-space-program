/**
 * Procedural navball texture, drawn once with Canvas 2D into an equirectangular 2048 x 1024 image
 * (u = heading / 360, north at u = 0; v = (90 - pitch) / 180) plus its full mip chain, in two versions:
 *
 *   base     the painted ball without any lettering:
 *              - sky (pitch > 0) blue and ground brown hemispheres with a soft gradient toward the poles,
 *              - a bold horizon line with heading ticks every 5 / 10 / 30 deg,
 *              - meridians every 30 deg (cardinal ones heavier) and the pitch ladder every 10 deg (heavier every
 *                30 deg), both stopping at the pole rings,
 *              - zenith and nadir marks larger than the reticle hub drawn over them: a bold ring at 80 deg with
 *                four inward ticks and a cap from 87.5 deg, so the pole frames the reticle when the nose is on it;
 *   labelled the base with its lettering: heading labels every 30 deg just above the horizon (N, 030, 060, E ...)
 *              and pitch numerals centred on the ladder lines in the open between the meridians (NUMERAL_HEADINGS,
 *              NUMERAL_PITCHES: 20, 40 and 60 deg each side, never next to the poles).
 *
 * Every label is pre-stretched by 1 / cos(latitude), so it reads undistorted on the sphere, and is drawn over a
 * halo of the local background colour that knocks the grid out behind it (a line never runs through a glyph).
 * The shader shows `labelled` where a label is visible and `base` where it is faded, deciding per label (from
 * the label's anchor and extent, `LabelLayout`), so a numeral near the bezel's lip dims as a whole and the lines
 * under it come back: a glyph is never cut in half and never fades into a blurred copy of itself.
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

/** Heading labels: every HEADING_LABEL_STEP deg of heading, centred at this pitch (deg) above the horizon. */
export const HEADING_LABEL_STEP = 30;
export const HEADING_LABEL_PITCH = 7.2;
/** Pitch numerals: columns at these headings (between the meridians), on these ladder lines (both signs). */
export const NUMERAL_HEADINGS = [45, 135, 225, 315] as const;
export const NUMERAL_PITCHES = [20, 40, 60] as const;

/**
 * Font sizes on the 1024-texel-high texture (px). A label's cap height on the HUD ball at 720p is about
 * 0.7 x size / 1024 x pi x the ball radius in px (navball.test.ts keeps it at or above the HUD's 10 px type).
 */
export const LABEL_FONT_PX = { heading: 56, cardinal: 68, numeral: 54 } as const;

/**
 * Half-extents of the labels on the sphere (radians, as true angles: east along the latitude circle, north along
 * the meridian), glyph plus halo: the shader fades a label as a whole by where its farthest corner lies.
 */
export interface LabelLayout {
  headingHalfW: number;
  headingHalfH: number;
  numeralHalfW: number;
  numeralHalfH: number;
}

const rgb = (c: readonly number[], a = 1): string => `rgba(${c[0]},${c[1]},${c[2]},${a})`;

/** Background colour of the texture at a pitch (the hemisphere gradients). */
function background(pitch: number): number[] {
  const t = Math.min(1, Math.abs(pitch) / 90);
  const [a, b] = pitch >= 0 ? [BALL_COLORS.skyHorizon, BALL_COLORS.skyZenith] : [BALL_COLORS.groundHorizon, BALL_COLORS.groundNadir];
  return [0, 1, 2].map((i) => Math.round(a[i]! + (b[i]! - a[i]!) * t));
}

const headingName = (h: number): string => ({ 0: 'N', 90: 'E', 180: 'S', 270: 'W' })[h] ?? String(h).padStart(3, '0');
const numeralText = (p: number): string => (p > 0 ? String(p) : `−${-p}`);

export interface BallTextures {
  /** The painted ball without lettering. */
  base: OffscreenCanvas;
  /** The same ball with its heading labels and pitch numerals. */
  labelled: OffscreenCanvas;
  layout: LabelLayout;
}

export function drawBallTextures(width = BALL_TEXTURE_SIZE[0], height = BALL_TEXTURE_SIZE[1]): BallTextures {
  const base = new OffscreenCanvas(width, height);
  const ctx = base.getContext('2d') as Ctx;
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

  // The labelled version: the base with its lettering.
  const labelled = new OffscreenCanvas(width, height);
  const lc = labelled.getContext('2d') as Ctx;
  lc.drawImage(base, 0, 0);
  /** Largest glyph width (px, unstretched) and cap height of each label kind, for the layout. */
  const extent = { heading: { w: 0, h: 0, halo: 0 }, numeral: { w: 0, h: 0, halo: 0 } };

  /**
   * Text centred at (heading, pitch), stretched horizontally by 1 / cos(pitch), over a halo of the background
   * colour (`halo` px wide) that clears the grid behind it. Wraps across the seam.
   */
  const label = (kind: 'heading' | 'numeral', text: string, heading: number, pitch: number, px: number, color: string, weight: number, halo: number): void => {
    const stretch = Math.min(9, 1 / Math.max(0.11, cosd(pitch)));
    lc.save();
    lc.font = `${weight} ${Math.round(px * k)}px ${FONT}`;
    lc.textAlign = 'center';
    lc.textBaseline = 'middle';
    const m = lc.measureText(text);
    const e = extent[kind];
    e.w = Math.max(e.w, m.width);
    // Twice the larger of the glyph's reach above and below the anchor ('middle' baseline): a conservative box.
    e.h = Math.max(e.h, 2 * Math.max(m.actualBoundingBoxAscent || 0.4 * px * k, m.actualBoundingBoxDescent || 0.4 * px * k));
    e.halo = Math.max(e.halo, halo * k);
    const w = m.width * stretch;
    const bg = rgb(background(pitch));
    for (const dx of [0, -W, W]) {
      const x = xOf(heading) + dx;
      if (x + w / 2 + halo * stretch < 0 || x - w / 2 - halo * stretch > W) continue;
      lc.save();
      lc.translate(x, yOf(pitch));
      lc.scale(stretch, 1);
      lc.lineJoin = 'round';
      lc.strokeStyle = bg;
      lc.lineWidth = halo * k;
      lc.strokeText(text, 0, 0);
      lc.fillStyle = color;
      lc.shadowColor = 'rgba(0,0,0,0.3)';
      lc.shadowBlur = 2 * k;
      lc.fillText(text, 0, 0);
      lc.restore();
    }
    lc.restore();
  };

  // Heading labels just above the horizon.
  for (let h = 0; h < 360; h += HEADING_LABEL_STEP) {
    const cardinal = h % 90 === 0;
    label('heading', headingName(h), h, HEADING_LABEL_PITCH, cardinal ? LABEL_FONT_PX.cardinal : LABEL_FONT_PX.heading, 'rgba(255,255,255,0.98)', cardinal ? 700 : 600, 10);
  }
  // Pitch numerals on the ladder lines between the meridians.
  for (const h of NUMERAL_HEADINGS) {
    for (const a of NUMERAL_PITCHES) {
      for (const p of [a, -a]) label('numeral', numeralText(p), h, p, LABEL_FONT_PX.numeral, p > 0 ? 'rgba(255,255,255,0.97)' : 'rgba(255,238,218,0.95)', 600, 11);
    }
  }

  // Texels to radians: the texture spans 2 pi in u over W texels and pi in v over H texels.
  const radPerTexel = Math.PI / H;
  const half = (e: { w: number; h: number; halo: number }): [number, number] => [((e.w / 2 + e.halo / 2) * 2 * Math.PI) / W, (e.h / 2 + e.halo / 2) * radPerTexel];
  const [headingHalfW, headingHalfH] = half(extent.heading);
  const [numeralHalfW, numeralHalfH] = half(extent.numeral);
  return { base, labelled, layout: { headingHalfW, headingHalfH, numeralHalfW, numeralHalfH } };
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
