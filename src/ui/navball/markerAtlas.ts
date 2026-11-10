/**
 * Navball marker atlas: every marker icon and the vessel reticle drawn with Canvas 2D (coloured, with a dark
 * outline for contrast) into a 1024 x 256 premultiplied RGBA atlas of 128 px cells. Each mip level is drawn
 * natively from the vector icons, so markers stay crisp at any ball size.
 */
import { drawIcon, MARKER_COLORS, MARKER_ICONS, RETICLE_COLOR, RETICLE_ICON, type MarkerIconName } from '../icons';

export const ATLAS_SIZE: [number, number] = [1024, 256];
const CELL = 128;

export type AtlasEntry = MarkerIconName | 'reticle';

/** Cell rectangles in atlas UV (u0, v0, u1, v1). */
export const ATLAS_LAYOUT: Record<AtlasEntry, [number, number, number, number]> = (() => {
  const order: MarkerIconName[] = ['prograde', 'retrograde', 'normal', 'antinormal', 'radialOut', 'radialIn', 'maneuver', 'target', 'antiTarget', 'liftVector', 'stability'];
  const out = {} as Record<AtlasEntry, [number, number, number, number]>;
  order.forEach((name, i) => {
    const cx = i % 8;
    const cy = Math.floor(i / 8);
    out[name] = [(cx * CELL) / ATLAS_SIZE[0], (cy * CELL) / ATLAS_SIZE[1], ((cx + 1) * CELL) / ATLAS_SIZE[0], ((cy + 1) * CELL) / ATLAS_SIZE[1]];
  });
  // The reticle spans two cells (48 x 24 icon box) at the end of the second row.
  out.reticle = [(6 * CELL) / ATLAS_SIZE[0], CELL / ATLAS_SIZE[1], (8 * CELL) / ATLAS_SIZE[0], (2 * CELL) / ATLAS_SIZE[1]];
  return out;
})();

/** Fraction of a cell the 24-unit icon box occupies. */
export const ICON_FILL = 0.84;

function drawAtlasLevel(scale: number): OffscreenCanvas {
  const w = Math.max(1, Math.round(ATLAS_SIZE[0] * scale));
  const h = Math.max(1, Math.round(ATLAS_SIZE[1] * scale));
  const c = new OffscreenCanvas(w, h);
  const ctx = c.getContext('2d') as OffscreenCanvasRenderingContext2D;
  const cell = CELL * scale;
  for (const [name, rect] of Object.entries(ATLAS_LAYOUT) as [AtlasEntry, [number, number, number, number]][]) {
    const cx = ((rect[0] + rect[2]) / 2) * w;
    const cy = ((rect[1] + rect[3]) / 2) * h;
    if (name === 'reticle') drawIcon(ctx, RETICLE_ICON, cx, cy, cell * ICON_FILL, RETICLE_COLOR, 'rgba(10,6,2,0.9)', [48, 24]);
    else drawIcon(ctx, MARKER_ICONS[name], cx, cy, cell * ICON_FILL, MARKER_COLORS[name]);
  }
  return c;
}

/** Atlas mip chain (level 0 = 1024 x 256). */
export function drawMarkerAtlas(): OffscreenCanvas[] {
  const levels: OffscreenCanvas[] = [];
  let scale = 1;
  for (;;) {
    levels.push(drawAtlasLevel(scale));
    const last = levels[levels.length - 1]!;
    if (last.width === 1 && last.height === 1) break;
    scale /= 2;
  }
  return levels;
}
