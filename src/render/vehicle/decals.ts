/**
 * The decal sheet: markings of the vehicles and launch sites of a definition library, packed into one atlas
 * (public/assets/vehicle/decals.png, baked by tools/vehicle/bake-decals.ts).
 *
 * The list of markings is CONTENT and lives in the definition library (section `DECAL_SECTION`): names,
 * texts, colours and sizes of every word mark, flag, stencil and sign. Part visual files and site structure
 * files refer to a marking by its name; nothing in this package names one. Adding or changing a marking is
 * an edit of that section followed by a re-bake of the atlas.
 *
 * Two ways of putting a marking on a surface:
 *  - 'decal' / 'decal-foil' / 'decal-ground': the cells of the surface that carry the marking are assigned to
 *    the decal material and mapped to its atlas rectangle, background and all (a plate, a sign, a marking on
 *    a surface of one flat colour);
 *  - 'decal-cut': a patch a hair above the surface drawn from the cut-out copy of the atlas
 *    (decals_cut.png, tools/vehicle/decal-coverage.ts), in which a marking whose background is one of the
 *    sheet's `skinColors` keeps only its ink. The skin under it shows between the letters, with its own
 *    weathering, soot and frost: lettering on a weathered skin is paint, not a sticker.
 */
import type { DefLibrary } from '@/core/contracts/defs';
import { getSection } from '@/core/defs/loader';

/** Section of the definition library that holds the decal sheet (a `DecalSheetDef`). */
export const DECAL_SECTION = 'visuals/parts/livery';

export type DecalStyle = 'word' | 'stencil' | 'label' | 'flag' | 'roundel' | 'hazard' | 'sign' | 'arrow' | 'solid';

export interface DecalSpec {
  name: string;
  /** Size in atlas texels. */
  w: number;
  h: number;
  style: DecalStyle;
  text?: string;
  /** CSS colours of the marking and of the background paint (the paint of the surface it goes on). */
  fg: string;
  bg: string;
  /** Further colours of a 'flag' or 'roundel' (field, band, ground, emblem, outline), in the style's own order. */
  colors?: string[];
  /**
   * The marking is painted on bare metal film (a capsule's taped back shell), not on paint: `bg` is the film's
   * colour, and the bake writes the film as metal and the ink as paint into the atlas's ORM map
   * (decals_orm.png, material 'decal-foil').
   */
  foil?: boolean;
}

export interface DecalSheetDef {
  /** Atlas edge length in texels. */
  size: number;
  /** Texels between two decals (bleed for the mip chain). */
  padding: number;
  /**
   * Background colours ('#rrggbb') that stand for the surface a marking is painted on: in the cut-out atlas
   * such a background is keyed out. Any other background is a plate's own colour and is kept.
   */
  skinColors?: string[];
  decals: DecalSpec[];
}

export interface DecalRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface DecalSheet {
  readonly def: DecalSheetDef;
  /** Atlas rectangle of every decal, in texels. */
  readonly layout: Readonly<Record<string, DecalRect>>;
  has(name: string): boolean;
  /** Atlas rectangle of a decal as [uLeft, vTop, uRight, vBottom], inset by half a texel. */
  uv(name: string): [number, number, number, number];
  /** Width / height of a decal. */
  aspect(name: string): number;
  /** Is the decal painted on metal film (drawn with the 'decal-foil' material)? */
  foil(name: string): boolean;
}

/** Shelf packing in list order (deterministic: the bake tool and the meshes share it). */
export function layoutDecals(def: DecalSheetDef): Record<string, DecalRect> {
  const out: Record<string, DecalRect> = {};
  const pad = def.padding;
  let x = pad;
  let y = pad;
  let shelf = 0;
  for (const d of def.decals) {
    if (d.name in out) throw new Error(`decal sheet: duplicate decal "${d.name}"`);
    if (!(d.w > 0 && d.h > 0)) throw new Error(`decal sheet: decal "${d.name}" has no size`);
    if (x + d.w + pad > def.size) {
      x = pad;
      y += shelf + pad;
      shelf = 0;
    }
    if (x + d.w + pad > def.size || y + d.h + pad > def.size) throw new Error(`decal sheet: atlas overflow at "${d.name}"`);
    out[d.name] = { x, y, w: d.w, h: d.h };
    x += d.w + pad;
    shelf = Math.max(shelf, d.h);
  }
  return out;
}

export function createDecalSheet(def: DecalSheetDef): DecalSheet {
  if (!(def.size > 0) || !Array.isArray(def.decals)) throw new Error('decal sheet: "size" and "decals" are required');
  const layout = layoutDecals(def);
  const rect = (name: string): DecalRect => {
    const r = layout[name];
    if (!r) throw new Error(`unknown decal "${name}" (not in the decal sheet ${DECAL_SECTION})`);
    return r;
  };
  return {
    def,
    layout,
    has: (name) => name in layout,
    uv(name) {
      const r = rect(name);
      const s = def.size;
      return [(r.x + 0.5) / s, (r.y + 0.5) / s, (r.x + r.w - 0.5) / s, (r.y + r.h - 0.5) / s];
    },
    aspect(name) {
      const r = rect(name);
      return r.w / r.h;
    },
    foil: (name) => def.decals.find((d) => d.name === name)?.foil === true,
  };
}

const sheets = new WeakMap<DefLibrary, DecalSheet>();

/** The decal sheet of a definition library (built once per library). */
export function decalSheetOf(defs: DefLibrary): DecalSheet {
  let sheet = sheets.get(defs);
  if (!sheet) {
    sheet = createDecalSheet(getSection<DecalSheetDef>(defs, DECAL_SECTION));
    sheets.set(defs, sheet);
  }
  return sheet;
}
