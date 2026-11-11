/**
 * Shared PBR material library of the vehicle and the launch complex.
 *
 * Textures are tileable maps baked by tools/vehicle/bake-textures.ts into public/assets/vehicle/ (albedo
 * sRGB, tangent-space normal with +Y up, ORM = AO / roughness factor / metallic factor) and the decal atlas
 * baked by tools/vehicle/bake-decals.ts. `uvScale` is tiles per metre: meshes carry UVs in metres.
 *
 * Anisotropy: mesh tangents run ALONG the brushing / crinkle direction, and the lobe is widest across it,
 * so brushed and foil materials use a NEGATIVE anisotropy (the render core stretches the highlight along
 * the tangent for positive values).
 */
import type { PbrMaterialDef } from '@/core/contracts/render';
import type { Vec3Tuple } from '@/core/math';

const T = (name: string): string => `vehicle/${name}.png`;

interface Spec {
  color: Vec3Tuple;
  metallic: number;
  roughness: number;
  /** Tile size in metres (u, v); 0 = the UVs are already texture coordinates (decals). */
  tile?: [number, number];
  tex?: { a?: string; n?: string; o?: string; e?: string };
  clearcoat?: number;
  clearcoatRoughness?: number;
  anisotropy?: number;
  emissive?: Vec3Tuple;
  doubleSided?: boolean;
  shading?: PbrMaterialDef['shading'];
}

const paint = (color: Vec3Tuple, roughness = 0.46, clearcoat = 1, clearcoatRoughness = 0.14): Spec => ({
  color,
  metallic: 0,
  roughness,
  clearcoat,
  clearcoatRoughness,
  tile: [0.6, 0.6],
  tex: { n: 'paint_n', o: 'paint_orm' },
});

const SPECS = {
  // ---- painted aluminium-lithium, orange-peel clearcoat
  'paint-white': paint([0.8, 0.8, 0.78]),
  'paint-white-b': paint([0.77, 0.775, 0.76], 0.52, 1, 0.2),
  'paint-black': paint([0.022, 0.022, 0.025], 0.42, 0.9, 0.16),
  'paint-navy': paint([0.012, 0.035, 0.11], 0.42, 1, 0.14),
  'paint-red': paint([0.52, 0.035, 0.02], 0.45, 1, 0.16),
  'paint-grey': paint([0.33, 0.35, 0.37], 0.5, 0.7, 0.25),
  'paint-yellow': paint([0.72, 0.5, 0.03], 0.5, 0.8, 0.22),
  /** Zinc-chromate style primer on internal structure. */
  primer: { color: [0.36, 0.42, 0.2], metallic: 0, roughness: 0.62, tile: [0.6, 0.6], tex: { n: 'paint_n', o: 'paint_orm' } },
  // ---- metals
  'steel-brushed': { color: [0.6, 0.6, 0.59], metallic: 1, roughness: 0.34, anisotropy: -0.72, tile: [0.4, 0.4], tex: { n: 'brushed_n', o: 'brushed_orm' } },
  'steel-bare': { color: [0.57, 0.57, 0.56], metallic: 1, roughness: 0.26, anisotropy: -0.35, tile: [0.4, 0.4], tex: { n: 'brushed_n', o: 'brushed_orm' } },
  'steel-dark': { color: [0.19, 0.19, 0.2], metallic: 1, roughness: 0.5, tile: [0.3, 0.3], tex: { n: 'cast_n', o: 'cast_orm' } },
  'alu-machined': { color: [0.86, 0.87, 0.88], metallic: 1, roughness: 0.36, anisotropy: -0.3, tile: [0.4, 0.4], tex: { n: 'brushed_n', o: 'brushed_orm' } },
  'alu-cast': { color: [0.62, 0.63, 0.64], metallic: 1, roughness: 0.55, tile: [0.3, 0.3], tex: { n: 'cast_n', o: 'cast_orm' } },
  /** Nickel alloy with oxide heat tint: albedo map runs straw -> purple -> blue along v (v = 0 hot end). */
  inconel: { color: [1, 1, 1], metallic: 1, roughness: 0.42, tile: [0.5, 1], tex: { a: 'heat_albedo', n: 'tubewall_n', o: 'cast_orm' } },
  /** Brazed tube-wall / milled-channel nozzle: vertical channel ridges in the normal map. */
  'nozzle-wall': { color: [0.52, 0.5, 0.47], metallic: 1, roughness: 0.38, anisotropy: 0.4, tile: [0.25, 1], tex: { n: 'tubewall_n', o: 'cast_orm' } },
  /** Radiatively cooled nozzle extension (niobium / carbon-carbon look). */
  'nozzle-ext': { color: [0.2, 0.19, 0.185], metallic: 0.85, roughness: 0.48, tile: [0.4, 0.4], tex: { n: 'cast_n', o: 'cast_orm' } },
  copper: { color: [0.86, 0.5, 0.33], metallic: 1, roughness: 0.38, tile: [0.3, 0.3], tex: { n: 'cast_n', o: 'cast_orm' } },
  galvanised: { color: [1, 1, 1], metallic: 0.9, roughness: 0.52, tile: [0.8, 0.8], tex: { a: 'galv_albedo', n: 'galv_n', o: 'galv_orm' } },
  grating: { color: [1, 1, 1], metallic: 0.9, roughness: 0.6, tile: [0.5, 0.5], tex: { a: 'grate_albedo', n: 'grate_n', o: 'grate_orm' } },
  // ---- composites, insulation, thermal protection
  carbon: { color: [1, 1, 1], metallic: 0, roughness: 0.42, clearcoat: 0.7, clearcoatRoughness: 0.18, tile: [0.25, 0.25], tex: { a: 'carbon_albedo', n: 'carbon_n', o: 'carbon_orm' } },
  'foam-orange': { color: [1, 1, 1], metallic: 0, roughness: 0.92, tile: [2.4, 2.4], tex: { a: 'foam_albedo', n: 'foam_n', o: 'foam_orm' } },
  /** The same foam where it has darkened in the sun (older closeouts, the windward side). */
  'foam-aged': { color: [0.8, 0.7, 0.6], metallic: 0, roughness: 0.92, tile: [2.4, 2.4], tex: { a: 'foam_albedo', n: 'foam_n', o: 'foam_orm' } },
  'foam-white': { color: [1, 1, 1], metallic: 0, roughness: 0.82, tile: [2.4, 2.4], tex: { a: 'foamwhite_albedo', n: 'foam_n', o: 'foam_orm' } },
  'foam-white-b': { color: [0.93, 0.92, 0.9], metallic: 0, roughness: 0.86, tile: [2.4, 2.4], tex: { a: 'foamwhite_albedo', n: 'foam_n', o: 'foam_orm' } },
  cork: { color: [1, 1, 1], metallic: 0, roughness: 0.94, tile: [0.7, 0.7], tex: { a: 'cork_albedo', n: 'cork_n', o: 'cork_orm' } },
  ablator: { color: [1, 1, 1], metallic: 0, roughness: 0.9, tile: [1.2, 1.2], tex: { a: 'ablator_albedo', n: 'ablator_n', o: 'ablator_orm' } },
  'tile-white': { color: [1, 1, 1], metallic: 0, roughness: 0.62, tile: [0.72, 0.72], tex: { a: 'tile_albedo', n: 'tile_n', o: 'tile_orm' } },
  'tile-black': { color: [0.07, 0.07, 0.075], metallic: 0, roughness: 0.55, tile: [0.72, 0.72], tex: { a: 'tile_albedo', n: 'tile_n', o: 'tile_orm' } },
  'mli-gold': { color: [0.95, 0.66, 0.2], metallic: 0.8, roughness: 0.4, anisotropy: -0.6, tile: [1.1, 1.1], tex: { n: 'mli_n', o: 'mli_orm' }, doubleSided: true },
  'mli-silver': { color: [0.88, 0.89, 0.9], metallic: 0.85, roughness: 0.38, anisotropy: -0.6, tile: [1.1, 1.1], tex: { n: 'mli_n', o: 'mli_orm' }, doubleSided: true },
  'mli-black': { color: [0.025, 0.025, 0.028], metallic: 0, roughness: 0.5, tile: [1.1, 1.1], tex: { n: 'mli_n', o: 'mli_orm' }, doubleSided: true },
  /** Quilted beta-cloth / acoustic blanket. */
  blanket: { color: [0.74, 0.72, 0.66], metallic: 0, roughness: 0.86, tile: [0.8, 0.8], tex: { n: 'quilt_n', o: 'quilt_orm' } },
  'blanket-silver': { color: [0.7, 0.71, 0.72], metallic: 0.9, roughness: 0.42, tile: [0.8, 0.8], tex: { n: 'quilt_n', o: 'quilt_orm' } },
  rubber: { color: [0.02, 0.02, 0.022], metallic: 0, roughness: 0.82, tile: [0.3, 0.3], tex: { n: 'cast_n' } },
  /** Carbon-phenolic solid-motor nozzles and throat inserts. */
  phenolic: { color: [0.035, 0.03, 0.028], metallic: 0, roughness: 0.7, tile: [0.3, 0.3], tex: { n: 'cast_n', o: 'cast_orm' } },
  glass: { color: [0.012, 0.014, 0.018], metallic: 0, roughness: 0.04, clearcoat: 1, clearcoatRoughness: 0.03 },
  /** Lamp lens: luminance set per instance through emissiveScale (0 = off). */
  lamp: { color: [0.75, 0.76, 0.78], metallic: 0, roughness: 0.25, emissive: [1, 0.97, 0.9] },
  /** Red obstruction light on masts. */
  'lamp-red': { color: [0.35, 0.02, 0.02], metallic: 0, roughness: 0.3, emissive: [1, 0.06, 0.03] },
  // ---- launch complex
  concrete: { color: [1, 1, 1], metallic: 0, roughness: 0.9, tile: [9, 9], tex: { a: 'concrete_albedo', n: 'concrete_n', o: 'concrete_orm' }, shading: 'terrain' },
  'concrete-wall': { color: [0.92, 0.92, 0.9], metallic: 0, roughness: 0.9, tile: [9, 9], tex: { a: 'concrete_albedo', n: 'concrete_n', o: 'concrete_orm' } },
  /** Refractory brick lining of the flame trench and deflector. */
  refractory: { color: [0.36, 0.25, 0.19], metallic: 0, roughness: 0.92, tile: [1.6, 1.6], tex: { a: 'tile_albedo', n: 'tile_n', o: 'tile_orm' } },
  gravel: { color: [1, 1, 1], metallic: 0, roughness: 0.95, tile: [3, 3], tex: { a: 'gravel_albedo', n: 'gravel_n', o: 'gravel_orm' }, shading: 'terrain' },
  // ---- decal atlas (UVs are atlas coordinates)
  decal: { color: [1, 1, 1], metallic: 0, roughness: 0.46, clearcoat: 1, clearcoatRoughness: 0.14, tile: [0, 0], tex: { a: 'decals' } },
  /** Markings painted on concrete (same atlas, matte, lit like the ground around them). */
  'decal-ground': { color: [1, 1, 1], metallic: 0, roughness: 0.88, tile: [0, 0], tex: { a: 'decals' }, shading: 'terrain' },
} satisfies Record<string, Spec>;

export type MatId = keyof typeof SPECS;

/** Luminance of a lit lamp lens, cd/m^2 (PbrMaterialDef.emissive is scaled by MeshInstance.emissiveScale). */
export const LAMP_LUMINANCE = 6.0e5;
export const OBSTRUCTION_LUMINANCE = 2.0e4;

const cache = new Map<string, PbrMaterialDef>();

export function isMatId(id: string): id is MatId {
  return id in SPECS;
}

/** The PbrMaterialDef of a library material (one shared object per id). */
export function materialDef(id: MatId): PbrMaterialDef {
  let def = cache.get(id);
  if (def) return def;
  const s: Spec = SPECS[id];
  if (!s) throw new Error(`vehicle materials: unknown material "${String(id)}"`);
  const lum = id === 'lamp' ? LAMP_LUMINANCE : id === 'lamp-red' ? OBSTRUCTION_LUMINANCE : 1;
  def = {
    name: id,
    shading: s.shading ?? 'standard',
    baseColor: s.color,
    metallic: s.metallic,
    roughness: s.roughness,
    ...(s.emissive ? { emissive: [s.emissive[0] * lum, s.emissive[1] * lum, s.emissive[2] * lum] as Vec3Tuple } : {}),
    ...(s.clearcoat !== undefined ? { clearcoat: s.clearcoat, clearcoatRoughness: s.clearcoatRoughness ?? 0.1 } : {}),
    ...(s.anisotropy !== undefined ? { anisotropy: s.anisotropy } : {}),
    ...(s.doubleSided ? { doubleSided: true } : {}),
    ...(s.tex
      ? {
          textures: {
            ...(s.tex.a ? { baseColor: T(s.tex.a) } : {}),
            ...(s.tex.n ? { normal: T(s.tex.n) } : {}),
            ...(s.tex.o ? { orm: T(s.tex.o) } : {}),
            ...(s.tex.e ? { emissive: T(s.tex.e) } : {}),
          },
        }
      : {}),
    uvScale: s.tile && s.tile[0] > 0 ? [1 / s.tile[0], 1 / s.tile[1]] : [1, 1],
  };
  cache.set(id, def);
  return def;
}

/** Texture tiles per metre along u for a material (1 for untextured and decal materials). */
export function uTilesPerMetre(id: MatId): number {
  const s: Spec = SPECS[id];
  return s.tile && s.tile[0] > 0 ? 1 / s.tile[0] : 0;
}

export const MATERIAL_IDS = Object.keys(SPECS) as MatId[];

/** Every texture file the library refers to (relative to the assets base URL). */
export function materialTextureFiles(): string[] {
  const out = new Set<string>();
  for (const id of MATERIAL_IDS) {
    const t = materialDef(id).textures;
    if (t) for (const f of Object.values(t)) if (f) out.add(f);
  }
  return [...out].sort();
}
