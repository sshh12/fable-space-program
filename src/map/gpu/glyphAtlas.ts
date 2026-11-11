/**
 * Glyph atlas rasterised with Canvas 2D at the exact device pixel size, in the HUD's type family (theme.ts),
 * so map labels match the flight HUD and text is copied 1:1 to whole-pixel positions (no resampling, no SDF
 * blur). Glyphs are proportional, each with its own advance; the ten digits share one advance (tabular
 * figures, as in the HUD), so numbers that change do not shift. Two channels: R = glyph coverage, G =
 * coverage of a thin dark halo that separates the letters from whatever is behind their backing plate.
 */
import { FONT_PX, LABEL_LINE_PX } from '../constants';
import type { TextMetricsLike } from '../drawList';
import { LABEL_CHARSET } from '../format';
import { MAP_FONT_FAMILY, MAP_FONT_WEIGHT } from '../theme';

export interface GlyphCell {
  /** Top-left texel of the cell in the atlas and its width (the cell height is the atlas' cellH). */
  u: number;
  v: number;
  w: number;
  /** Pen advance in device px. */
  advance: number;
}

const isDigit = (code: number): boolean => code >= 48 && code <= 57;

export class GlyphAtlas {
  readonly texture: GPUTexture;
  readonly view: GPUTextureView;
  readonly metrics: TextMetricsLike;
  readonly cellH: number;
  /** Offset of the glyph origin inside its cell (halo margin). */
  readonly margin: number;
  readonly pxScale: number;
  /** Cells of ASCII code units (dense) and of the few non-ASCII symbols. */
  private readonly ascii: (GlyphCell | undefined)[] = new Array<GlyphCell | undefined>(128).fill(undefined);
  private readonly extra = new Map<number, GlyphCell>();
  private readonly fallback: GlyphCell;

  constructor(device: GPUDevice, pxScale: number) {
    this.pxScale = pxScale;
    const fontPx = Math.round(FONT_PX * pxScale);
    const font = `${MAP_FONT_WEIGHT} ${fontPx}px ${MAP_FONT_FAMILY}`;
    const probe = new OffscreenCanvas(8, 8).getContext('2d')!;
    probe.font = font;
    const chars = [...LABEL_CHARSET];
    const own = chars.map((ch) => probe.measureText(ch).width);
    let digit = 0;
    chars.forEach((ch, i) => {
      if (isDigit(ch.charCodeAt(0))) digit = Math.max(digit, own[i]!);
    });
    const advances = chars.map((ch, i) => (isDigit(ch.charCodeAt(0)) ? digit : own[i]!));
    const lineHeight = Math.round(LABEL_LINE_PX * pxScale);
    this.margin = Math.ceil(2 * pxScale);
    this.cellH = lineHeight + 2 * this.margin;

    // Pack the cells into rows of at most 512 texels.
    const ROW = 512;
    const cells: GlyphCell[] = [];
    let x = 0;
    let y = 0;
    for (let i = 0; i < chars.length; i++) {
      const w = Math.ceil(Math.max(advances[i]!, own[i]!)) + 2 * this.margin + 2;
      if (x + w > ROW) {
        x = 0;
        y += this.cellH;
      }
      cells.push({ u: x, v: y, w, advance: advances[i]! });
      x += w;
    }
    const width = ROW;
    const height = y + this.cellH;

    const draw = (halo: boolean): Uint8ClampedArray => {
      const canvas = new OffscreenCanvas(width, height);
      const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
      ctx.clearRect(0, 0, width, height);
      ctx.font = font;
      ctx.textBaseline = 'middle';
      ctx.fillStyle = '#fff';
      ctx.strokeStyle = '#fff';
      ctx.lineJoin = 'round';
      ctx.lineWidth = 2.4 * pxScale;
      chars.forEach((ch, i) => {
        const c = cells[i]!;
        // digits are centred in the shared tabular advance
        const gx = c.u + this.margin + (advances[i]! - own[i]!) / 2;
        const gy = c.v + this.margin + lineHeight / 2 + 0.5 * pxScale;
        if (halo) ctx.strokeText(ch, gx, gy);
        ctx.fillText(ch, gx, gy);
      });
      return ctx.getImageData(0, 0, width, height).data;
    };
    const fill = draw(false);
    const halo = draw(true);
    const data = new Uint8Array(width * height * 2);
    for (let i = 0; i < width * height; i++) {
      data[2 * i] = fill[4 * i + 3]!;
      data[2 * i + 1] = halo[4 * i + 3]!;
    }
    chars.forEach((ch, i) => {
      const code = ch.charCodeAt(0);
      if (code < 128) this.ascii[code] = cells[i]!;
      else this.extra.set(code, cells[i]!);
    });
    this.fallback = this.ascii['?'.charCodeAt(0)]!;
    this.metrics = { lineHeight, advance: (code) => this.cell(code).advance };
    this.texture = device.createTexture({
      label: 'map.glyphAtlas',
      size: { width, height },
      format: 'rg8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    device.queue.writeTexture({ texture: this.texture }, data, { bytesPerRow: width * 2 }, { width, height });
    this.view = this.texture.createView();
  }

  /** Atlas cell of a UTF-16 code unit ('?' for characters outside the label charset). */
  cell(code: number): GlyphCell {
    return (code < 128 ? this.ascii[code] : this.extra.get(code)) ?? this.fallback;
  }

  destroy(): void {
    this.texture.destroy();
  }
}
