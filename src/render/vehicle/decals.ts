/**
 * Layout of the decal atlas (public/assets/vehicle/decals.png, baked by tools/vehicle/bake-decals.ts).
 *
 * The mesh system has no alpha-tested materials, so a decal is not a transparent overlay: the cells of a
 * surface that carry a marking are assigned to the 'decal' material and mapped to an atlas rectangle
 * whose background is the paint of the surface around it. The livery is fictional: no real agency,
 * company or national mark.
 */
export const DECAL_ATLAS_SIZE = 2048;
const PAD = 12;

export type DecalStyle = 'word' | 'stencil' | 'label' | 'flag' | 'roundel' | 'hazard' | 'sign' | 'arrow' | 'solid';

export interface DecalSpec {
  name: string;
  w: number;
  h: number;
  style: DecalStyle;
  text?: string;
  /** CSS colours of the marking and of the background paint. */
  fg: string;
  bg: string;
}

/** sRGB paint colours shared with the material library (materials.ts paint-white / paint-black, encoded). */
export const PAINT_WHITE = '#e7e7e4';
export const PAINT_BLACK = '#292929';
export const PAINT_NAVY = '#1c345d';
export const PAINT_RED = '#c0321f';
export const PAINT_YELLOW = '#dcbd2f';

export const DECALS: readonly DecalSpec[] = [
  { name: 'wordmark', w: 2000, h: 280, style: 'word', text: 'MERIDIAN', fg: PAINT_NAVY, bg: PAINT_WHITE },
  { name: 'wordmark-dark', w: 1000, h: 140, style: 'word', text: 'MERIDIAN', fg: PAINT_WHITE, bg: PAINT_BLACK },
  { name: 'kestrel', w: 900, h: 140, style: 'word', text: 'KESTREL', fg: PAINT_NAVY, bg: PAINT_WHITE },
  { name: 'heron', w: 700, h: 140, style: 'word', text: 'HERON', fg: PAINT_NAVY, bg: PAINT_WHITE },
  { name: 'spaceport', w: 1400, h: 150, style: 'sign', text: 'KA LAE PACIFIC SPACEPORT', fg: PAINT_WHITE, bg: PAINT_NAVY },
  { name: 'lc1', w: 420, h: 220, style: 'sign', text: 'LC-1', fg: PAINT_WHITE, bg: PAINT_NAVY },
  { name: 'flag', w: 480, h: 300, style: 'flag', fg: PAINT_NAVY, bg: PAINT_WHITE },
  { name: 'roundel', w: 300, h: 300, style: 'roundel', fg: PAINT_NAVY, bg: PAINT_WHITE },
  { name: 'm1', w: 420, h: 200, style: 'stencil', text: 'M-1', fg: PAINT_BLACK, bg: PAINT_WHITE },
  { name: 'm2', w: 420, h: 200, style: 'stencil', text: 'M-2', fg: PAINT_BLACK, bg: PAINT_WHITE },
  { name: 'm3', w: 420, h: 200, style: 'stencil', text: 'M-3', fg: PAINT_BLACK, bg: PAINT_WHITE },
  { name: 'serial', w: 420, h: 110, style: 'stencil', text: 'MV-07', fg: PAINT_BLACK, bg: PAINT_WHITE },
  { name: 'lox', w: 300, h: 110, style: 'stencil', text: 'LOX', fg: PAINT_BLACK, bg: PAINT_WHITE },
  { name: 'lch4', w: 300, h: 110, style: 'stencil', text: 'LCH4', fg: PAINT_BLACK, bg: PAINT_WHITE },
  { name: 'lh2', w: 300, h: 110, style: 'stencil', text: 'LH2', fg: PAINT_BLACK, bg: PAINT_WHITE },
  { name: 'gn2', w: 300, h: 110, style: 'stencil', text: 'GN2', fg: PAINT_BLACK, bg: PAINT_WHITE },
  { name: 'h2o', w: 300, h: 110, style: 'stencil', text: 'H2O', fg: PAINT_BLACK, bg: PAINT_WHITE },
  { name: 'vent', w: 300, h: 90, style: 'label', text: 'VENT', fg: PAINT_RED, bg: PAINT_WHITE },
  { name: 'fill', w: 420, h: 90, style: 'label', text: 'FILL / DRAIN', fg: PAINT_BLACK, bg: PAINT_WHITE },
  { name: 'nostep', w: 300, h: 90, style: 'label', text: 'NO STEP', fg: PAINT_RED, bg: PAINT_WHITE },
  { name: 'liftpoint', w: 360, h: 90, style: 'label', text: 'LIFT POINT', fg: PAINT_BLACK, bg: PAINT_WHITE },
  { name: 'danger', w: 520, h: 110, style: 'label', text: 'DANGER  PYROTECHNICS', fg: PAINT_RED, bg: PAINT_WHITE },
  { name: 'cryo', w: 520, h: 110, style: 'label', text: 'CAUTION  CRYOGENIC', fg: PAINT_BLACK, bg: PAINT_YELLOW },
  { name: 'rescue', w: 520, h: 150, style: 'arrow', text: 'RESCUE', fg: PAINT_BLACK, bg: PAINT_YELLOW },
  { name: 'hatch', w: 420, h: 90, style: 'label', text: 'HATCH RELEASE', fg: PAINT_RED, bg: PAINT_WHITE },
  { name: 'hazard', w: 768, h: 96, style: 'hazard', fg: PAINT_BLACK, bg: PAINT_YELLOW },
  { name: 'white', w: 48, h: 48, style: 'solid', fg: PAINT_WHITE, bg: PAINT_WHITE },
  { name: 'yellow', w: 48, h: 48, style: 'solid', fg: PAINT_YELLOW, bg: PAINT_YELLOW },
];

export interface DecalRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Shelf packing in list order (deterministic; the bake tool and the meshes share it). */
export function decalLayout(): Record<string, DecalRect> {
  const out: Record<string, DecalRect> = {};
  let x = PAD;
  let y = PAD;
  let shelf = 0;
  for (const d of DECALS) {
    if (x + d.w + PAD > DECAL_ATLAS_SIZE) {
      x = PAD;
      y += shelf + PAD;
      shelf = 0;
    }
    if (y + d.h + PAD > DECAL_ATLAS_SIZE) throw new Error(`decal atlas overflow at "${d.name}"`);
    out[d.name] = { x, y, w: d.w, h: d.h };
    x += d.w + PAD;
    shelf = Math.max(shelf, d.h);
  }
  return out;
}

let layout: Record<string, DecalRect> | null = null;

/** Atlas rectangle of a decal as [uLeft, vTop, uRight, vBottom], inset by half a texel. */
export function decalUv(name: string): [number, number, number, number] {
  layout ??= decalLayout();
  const r = layout[name];
  if (!r) throw new Error(`unknown decal "${name}"`);
  const s = DECAL_ATLAS_SIZE;
  return [(r.x + 0.5) / s, (r.y + 0.5) / s, (r.x + r.w - 0.5) / s, (r.y + r.h - 0.5) / s];
}

/** Width / height of a decal. */
export function decalAspect(name: string): number {
  const d = DECALS.find((x) => x.name === name);
  if (!d) throw new Error(`unknown decal "${name}"`);
  return d.w / d.h;
}
