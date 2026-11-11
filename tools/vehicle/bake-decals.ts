/**
 * Bakes the decal atlas public/assets/vehicle/decals.png from the decal sheet of the definition library
 * (section DECAL_SECTION of src/render/vehicle/decals.ts, i.e. data/defs/visuals/parts/livery.json): the
 * list of markings, their texts and colours are data; this tool only knows how each STYLE is drawn.
 *
 *   node tools/dev/heavy.mjs --class=gpu -- npx tsx tools/vehicle/bake-decals.ts
 *
 * The atlas is drawn on a 2D canvas in the installed Chrome (headless, via Playwright) so that the
 * lettering is properly anti-aliased type; no network, no API key. Every decal is opaque: its background
 * is the paint of the surface it goes on. The livery must stay fictional (no real agency, company or
 * national mark).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { fsDefSource } from '../../src/core/defs/fsSource';
import { loadDefs } from '../../src/core/defs/loader';
import { decalSheetOf, type DecalRect, type DecalSpec } from '../../src/render/vehicle/decals';

const out = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'public', 'assets', 'vehicle', 'decals.png');

/** Runs in the page: draws every decal into the canvas. */
function paint(args: { size: number; decals: DecalSpec[]; layout: Record<string, DecalRect> }): string {
  const { size, decals, layout } = args;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const g = canvas.getContext('2d')!;
  g.fillStyle = '#808080';
  g.fillRect(0, 0, size, size);
  const font = (px: number, weight = 700, stretch = 'condensed'): string => `${weight} ${stretch} ${px}px Bahnschrift, "DIN Alternate", "Arial Narrow", Arial, sans-serif`;

  /** Text fitted into a box, optionally with stencil bridges cut through every glyph. */
  const text = (s: string, x: number, y: number, w: number, h: number, colour: string, bg: string, opts: { weight?: number; stretch?: string; stencil?: boolean; spacing?: number; fill?: number } = {}): void => {
    const fill = opts.fill ?? 0.78;
    let px = h * fill;
    g.font = font(px, opts.weight ?? 700, opts.stretch ?? 'condensed');
    g.letterSpacing = `${(opts.spacing ?? 0.04) * px}px`;
    const m = g.measureText(s);
    if (m.width > w * 0.94) {
      px *= (w * 0.94) / m.width;
      g.font = font(px, opts.weight ?? 700, opts.stretch ?? 'condensed');
      g.letterSpacing = `${(opts.spacing ?? 0.04) * px}px`;
    }
    const mm = g.measureText(s);
    g.fillStyle = colour;
    g.textBaseline = 'alphabetic';
    const ascent = mm.actualBoundingBoxAscent;
    const descent = mm.actualBoundingBoxDescent;
    const tx = x + (w - mm.width) / 2;
    const ty = y + (h + ascent - descent) / 2;
    g.fillText(s, tx, ty);
    if (opts.stencil) {
      // Bridges: a thin vertical cut through the middle of every glyph and one horizontal cut.
      g.fillStyle = bg;
      let cx = tx;
      for (const ch of s) {
        const cw = g.measureText(ch).width;
        if (ch !== ' ' && ch !== '-' && ch !== '1' && ch !== 'I') g.fillRect(cx + cw * 0.5 - px * 0.035 - (opts.spacing ?? 0.04) * px * 0.5, ty - ascent - 2, px * 0.07, ascent + descent + 4);
        cx += cw;
      }
    }
    g.letterSpacing = '0px';
  };

  for (const d of decals) {
    const r = layout[d.name]!;
    g.save();
    // Bleed the background into the padding so that mip levels never pick up a neighbour.
    g.fillStyle = d.bg;
    g.fillRect(r.x - 6, r.y - 6, r.w + 12, r.h + 12);
    g.beginPath();
    g.rect(r.x, r.y, r.w, r.h);
    g.clip();
    const cx = r.x + r.w / 2;
    const cy = r.y + r.h / 2;
    switch (d.style) {
      case 'word': {
        // Word mark: wide bold capitals with a meridian arc through the first letter.
        text(d.text!, r.x + r.h * 0.9, r.y, r.w - r.h * 1.0, r.h, d.fg, d.bg, { weight: 700, stretch: 'normal', spacing: 0.16, fill: 0.74 });
        g.strokeStyle = d.fg;
        g.lineWidth = r.h * 0.075;
        g.beginPath();
        g.arc(r.x + r.h * 0.5, cy, r.h * 0.33, 0, Math.PI * 2);
        g.stroke();
        g.beginPath();
        g.ellipse(r.x + r.h * 0.5, cy, r.h * 0.13, r.h * 0.33, 0, 0, Math.PI * 2);
        g.stroke();
        g.beginPath();
        g.moveTo(r.x + r.h * 0.17, cy);
        g.lineTo(r.x + r.h * 0.83, cy);
        g.stroke();
        break;
      }
      case 'sign':
        text(d.text!, r.x, r.y, r.w, r.h, d.fg, d.bg, { weight: 700, stretch: 'normal', spacing: 0.1, fill: 0.62 });
        g.strokeStyle = d.fg;
        g.lineWidth = Math.max(3, r.h * 0.035);
        g.strokeRect(r.x + r.h * 0.08, r.y + r.h * 0.08, r.w - r.h * 0.16, r.h - r.h * 0.16);
        break;
      case 'stencil':
        text(d.text!, r.x, r.y, r.w, r.h, d.fg, d.bg, { weight: 700, stretch: 'condensed', stencil: true, spacing: 0.08, fill: 0.86 });
        break;
      case 'label':
        text(d.text!, r.x, r.y, r.w, r.h, d.fg, d.bg, { weight: 600, stretch: 'condensed', spacing: 0.06, fill: 0.6 });
        g.strokeStyle = d.fg;
        g.lineWidth = Math.max(2, r.h * 0.04);
        g.strokeRect(r.x + r.h * 0.1, r.y + r.h * 0.1, r.w - r.h * 0.2, r.h - r.h * 0.2);
        break;
      case 'arrow': {
        text(d.text!, r.x + r.w * 0.3, r.y, r.w * 0.68, r.h, d.fg, d.bg, { weight: 700, stretch: 'condensed', spacing: 0.08, fill: 0.62 });
        g.fillStyle = d.fg;
        const ax = r.x + r.w * 0.05;
        const aw = r.w * 0.24;
        g.beginPath();
        g.moveTo(ax, cy);
        g.lineTo(ax + aw * 0.45, cy - r.h * 0.32);
        g.lineTo(ax + aw * 0.45, cy - r.h * 0.13);
        g.lineTo(ax + aw, cy - r.h * 0.13);
        g.lineTo(ax + aw, cy + r.h * 0.13);
        g.lineTo(ax + aw * 0.45, cy + r.h * 0.13);
        g.lineTo(ax + aw * 0.45, cy + r.h * 0.32);
        g.closePath();
        g.fill();
        g.strokeStyle = d.fg;
        g.lineWidth = r.h * 0.04;
        g.strokeRect(r.x + r.h * 0.06, r.y + r.h * 0.06, r.w - r.h * 0.12, r.h - r.h * 0.12);
        break;
      }
      case 'flag': {
        // A flag of no nation: a field, a band low across it, ground under the band, a sun-and-horizon disc
        // (colours: field, band, ground, sun, outline).
        const [field, bandColour, ground, sun, outline] = [d.colors?.[0] ?? d.fg, d.colors?.[1] ?? d.bg, d.colors?.[2] ?? d.fg, d.colors?.[3] ?? d.bg, d.colors?.[4] ?? d.fg];
        const m = r.h * 0.035;
        g.fillStyle = field;
        g.fillRect(r.x + m, r.y + m, r.w - 2 * m, r.h - 2 * m);
        g.fillStyle = bandColour;
        g.fillRect(r.x + m, r.y + r.h * 0.62, r.w - 2 * m, r.h * 0.1);
        g.fillStyle = ground;
        g.fillRect(r.x + m, r.y + r.h * 0.72, r.w - 2 * m, r.h * 0.28 - m);
        g.fillStyle = sun;
        g.beginPath();
        g.arc(r.x + r.w * 0.34, r.y + r.h * 0.62, r.h * 0.2, Math.PI, 0);
        g.closePath();
        g.fill();
        for (let i = 0; i < 7; i++) {
          const a = Math.PI + (Math.PI * (i + 0.5)) / 7;
          g.beginPath();
          g.moveTo(r.x + r.w * 0.34 + Math.cos(a) * r.h * 0.25, r.y + r.h * 0.62 + Math.sin(a) * r.h * 0.25);
          g.lineTo(r.x + r.w * 0.34 + Math.cos(a) * r.h * 0.36, r.y + r.h * 0.62 + Math.sin(a) * r.h * 0.36);
          g.strokeStyle = sun;
          g.lineWidth = r.h * 0.03;
          g.stroke();
        }
        g.strokeStyle = outline;
        g.lineWidth = Math.max(2, r.h * 0.012);
        g.strokeRect(r.x + m, r.y + m, r.w - 2 * m, r.h - 2 * m);
        break;
      }
      case 'roundel': {
        // Disc in the marking colour with an orbit, a meridian and a star (colours: lines, star).
        const R = r.h * 0.45;
        g.fillStyle = d.fg;
        g.beginPath();
        g.arc(cx, cy, R, 0, Math.PI * 2);
        g.fill();
        g.strokeStyle = d.colors?.[0] ?? d.bg;
        g.lineWidth = R * 0.07;
        g.beginPath();
        g.arc(cx, cy, R * 0.86, 0, Math.PI * 2);
        g.stroke();
        // Orbit ellipse and a meridian with a rising star.
        g.beginPath();
        g.ellipse(cx, cy, R * 0.62, R * 0.24, -0.45, 0, Math.PI * 2);
        g.stroke();
        g.beginPath();
        g.ellipse(cx, cy, R * 0.2, R * 0.62, 0, 0, Math.PI * 2);
        g.stroke();
        g.fillStyle = d.colors?.[1] ?? d.bg;
        g.beginPath();
        for (let i = 0; i < 8; i++) {
          const a = (i / 8) * Math.PI * 2 - Math.PI / 2;
          const rr = i % 2 === 0 ? R * 0.16 : R * 0.055;
          g.lineTo(cx + R * 0.4 + Math.cos(a) * rr, cy - R * 0.3 + Math.sin(a) * rr);
        }
        g.closePath();
        g.fill();
        break;
      }
      case 'hazard': {
        g.fillStyle = d.fg;
        const step = r.h * 1.0;
        for (let x = r.x - r.h; x < r.x + r.w + r.h; x += step) {
          g.beginPath();
          g.moveTo(x, r.y + r.h);
          g.lineTo(x + step * 0.5, r.y + r.h);
          g.lineTo(x + step * 0.5 + r.h, r.y);
          g.lineTo(x + r.h, r.y);
          g.closePath();
          g.fill();
        }
        break;
      }
      case 'solid':
        break;
    }
    g.restore();
  }
  return canvas.toDataURL('image/png');
}

async function main(): Promise<void> {
  const sheet = decalSheetOf(await loadDefs(fsDefSource()));
  const browser = await chromium.launch({ channel: process.env.E2E_CHANNEL ?? 'chrome', headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<!doctype html><html><body></body></html>');
    // tsx keeps function names with a helper that does not exist in the page.
    await page.addScriptTag({ content: 'globalThis.__name = (f) => f;' });
    await page.evaluate(() => document.fonts.ready);
    const url = await page.evaluate(paint, { size: sheet.def.size, decals: sheet.def.decals, layout: { ...sheet.layout } });
    const png = Buffer.from(url.slice(url.indexOf(',') + 1), 'base64');
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, png);
    console.log(`decals.png ${sheet.def.size}x${sheet.def.size} ${(png.length / 1024).toFixed(0)} KiB, ${sheet.def.decals.length} decals -> ${out}`);
  } finally {
    await browser.close();
  }
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
