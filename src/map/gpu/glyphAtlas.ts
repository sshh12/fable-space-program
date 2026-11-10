/**
 * Monospace glyph atlas rasterised with Canvas 2D at the exact device pixel size, so text is copied 1:1
 * to whole-pixel positions and stays crisp (no font-atlas resampling, no SDF blur). Two channels: R = glyph
 * coverage, G = coverage of a 3 px dark halo that keeps labels legible over lit planets.
 */
import { FONT_PX, LABEL_LINE_PX } from '../constants';
import type { TextMetricsLike } from '../drawList';
import { LABEL_CHARSET } from '../format';

const FONT_FAMILY = "Consolas, 'Cascadia Mono', 'DejaVu Sans Mono', ui-monospace, monospace";

export interface GlyphCell {
  /** Top-left texel of the cell in the atlas. */
  u: number;
  v: number;
}

export class GlyphAtlas {
  readonly texture: GPUTexture;
  readonly view: GPUTextureView;
  readonly metrics: TextMetricsLike;
  /** Cell size in texels (the glyph advance plus the halo margin on each side). */
  readonly cellW: number;
  readonly cellH: number;
  /** Offset of the glyph origin inside its cell (halo margin). */
  readonly margin: number;
  readonly pxScale: number;
  private readonly cells = new Map<string, GlyphCell>();

  constructor(device: GPUDevice, pxScale: number) {
    this.pxScale = pxScale;
    const fontPx = Math.round(FONT_PX * pxScale);
    const font = `${fontPx}px ${FONT_FAMILY}`;
    const probe = new OffscreenCanvas(8, 8).getContext('2d')!;
    probe.font = font;
    const advance = probe.measureText('M').width;
    const lineHeight = Math.round(LABEL_LINE_PX * pxScale);
    this.metrics = { advance, lineHeight };
    this.margin = Math.ceil(2 * pxScale);
    this.cellW = Math.ceil(advance) + 2 * this.margin + 1;
    this.cellH = lineHeight + 2 * this.margin;
    const chars = [...LABEL_CHARSET];
    const cols = 16;
    const rows = Math.ceil(chars.length / cols);
    const width = cols * this.cellW;
    const height = rows * this.cellH;

    const draw = (halo: boolean): Uint8ClampedArray => {
      const canvas = new OffscreenCanvas(width, height);
      const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
      ctx.clearRect(0, 0, width, height);
      ctx.font = font;
      ctx.textBaseline = 'middle';
      ctx.fillStyle = '#fff';
      ctx.strokeStyle = '#fff';
      ctx.lineJoin = 'round';
      ctx.lineWidth = 3 * pxScale;
      chars.forEach((ch, i) => {
        const x = (i % cols) * this.cellW + this.margin;
        const y = Math.floor(i / cols) * this.cellH + this.margin + lineHeight / 2 + 0.5 * pxScale;
        if (halo) ctx.strokeText(ch, x, y);
        ctx.fillText(ch, x, y);
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
    chars.forEach((ch, i) => this.cells.set(ch, { u: (i % cols) * this.cellW, v: Math.floor(i / cols) * this.cellH }));
    this.texture = device.createTexture({
      label: 'map.glyphAtlas',
      size: { width, height },
      format: 'rg8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    device.queue.writeTexture({ texture: this.texture }, data, { bytesPerRow: width * 2 }, { width, height });
    this.view = this.texture.createView();
  }

  cell(ch: string): GlyphCell | undefined {
    return this.cells.get(ch) ?? this.cells.get('?');
  }

  destroy(): void {
    this.texture.destroy();
  }
}
