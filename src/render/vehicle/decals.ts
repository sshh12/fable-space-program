/**
 * The decal sheet: markings of the vehicles and launch sites of a definition library, packed into one atlas
 * (public/assets/vehicle/decals.png, baked by tools/vehicle/bake-decals.ts).
 *
 * The list of markings is CONTENT and lives in the definition library (section `DECAL_SECTION`): names,
 * texts, colours and sizes of every word mark, flag, stencil and sign. Part visual files and site structure
 * files refer to a marking by its name; nothing in this package names one. Adding or changing a marking is
 * an edit of that section followed by a re-bake of the atlas.
 *
 * The mesh system has no alpha-tested materials, so a decal is not a transparent overlay: the cells of a
 * surface that carry a marking are assigned to the 'decal' material and mapped to an atlas rectangle
 * whose background is the paint of the surface around it.
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
}

export interface DecalSheetDef {
  /** Atlas edge length in texels. */
  size: number;
  /** Texels between two decals (bleed for the mip chain). */
  padding: number;
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
