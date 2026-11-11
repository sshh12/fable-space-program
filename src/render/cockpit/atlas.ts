/**
 * Label atlas: every placard, legend and lens text of the interior painted once with Canvas 2D into a
 * single-channel coverage texture (white ink on black), mip-mapped. Layout (rectangles) comes from the
 * build (pure); painting needs a browser.
 */
import { ATLAS_HEIGHT, ATLAS_WIDTH, type LabelAlloc } from './cabin/context';

const FONT = 'Bahnschrift, "DIN Alternate", "Segoe UI", system-ui, sans-serif';

/** Roll scale ring of the attitude indicator: ticks every 10 deg, long every 30 deg, index triangle at 0. */
function rollScale(ctx: OffscreenCanvasRenderingContext2D, x: number, y: number, w: number, h: number): void {
  const cx = x + w / 2;
  const cy = y + h / 2;
  const r = Math.min(w, h) / 2;
  ctx.strokeStyle = '#fff';
  ctx.lineCap = 'butt';
  for (let a = -90; a <= 90; a += 10) {
    const long = a % 30 === 0;
    const t = ((a - 90) * Math.PI) / 180;
    ctx.lineWidth = long ? r * 0.022 : r * 0.014;
    const r0 = r * (long ? 0.86 : 0.9);
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(t) * r0, cy + Math.sin(t) * r0);
    ctx.lineTo(cx + Math.cos(t) * r * 0.97, cy + Math.sin(t) * r * 0.97);
    ctx.stroke();
  }
  ctx.fillStyle = '#fff';
  ctx.beginPath();
  ctx.moveTo(cx, cy - r * 0.84);
  ctx.lineTo(cx - r * 0.04, cy - r * 0.98);
  ctx.lineTo(cx + r * 0.04, cy - r * 0.98);
  ctx.closePath();
  ctx.fill();
  ctx.font = `600 ${Math.round(r * 0.08)}px ${FONT}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (const a of [-60, -30, 30, 60]) {
    const t = ((a - 90) * Math.PI) / 180;
    ctx.fillText(String(Math.abs(a)), cx + Math.cos(t) * r * 0.76, cy + Math.sin(t) * r * 0.76);
  }
}

export function paintLabelAtlas(labels: readonly LabelAlloc[]): OffscreenCanvas {
  const canvas = new OffscreenCanvas(ATLAS_WIDTH, ATLAS_HEIGHT);
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, ATLAS_WIDTH, ATLAS_HEIGHT);
  for (const l of labels) {
    const [x, y, w, h] = l.px;
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, w, h);
    ctx.clip();
    if (l.text === '#ROLL') {
      rollScale(ctx, x, y, w, h);
      ctx.restore();
      continue;
    }
    ctx.fillStyle = '#fff';
    const lines = l.text.split('\n');
    // Two-line legends for lamp lenses whose text is wider than tall allows.
    const words = l.text.split(' ');
    const twoLines = lines.length === 1 && words.length >= 2 && w / h < l.text.length * 0.42 && h > 18;
    const rows = twoLines ? [words.slice(0, Math.ceil(words.length / 2)).join(' '), words.slice(Math.ceil(words.length / 2)).join(' ')] : lines;
    const px = (h / rows.length) * (l.style.box ? 0.62 : 0.78);
    ctx.font = `${l.style.weight} ${Math.max(6, Math.round(px))}px ${FONT}`;
    (ctx as unknown as { fontStretch?: string }).fontStretch = 'semi-condensed';
    ctx.textBaseline = 'middle';
    ctx.textAlign = l.style.align === 'left' ? 'left' : 'center';
    const tx = l.style.align === 'left' ? x + h * 0.08 : x + w / 2;
    rows.forEach((row, i) => {
      const ty = y + (h * (i + 0.5)) / rows.length + px * 0.04;
      ctx.fillText(row, tx, ty, w * (l.style.box ? 0.9 : 0.97));
    });
    if (l.style.box) {
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = Math.max(1, h * 0.05);
      ctx.strokeRect(x + ctx.lineWidth, y + ctx.lineWidth, w - 2 * ctx.lineWidth, h - 2 * ctx.lineWidth);
    }
    ctx.restore();
  }
  return canvas;
}
