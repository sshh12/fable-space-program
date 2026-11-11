/**
 * Launch-complex structures: generator registry keyed by `LaunchSiteDef.structures[].model`.
 *
 * Model frame of every structure: +Y up, +X east and +Z south at heading 0 (so -Z is the structure's
 * "north"); the site feature rotates it clockwise by `headingDeg` about the vertical and puts its origin at
 * `offsetEnu` from the pad centre, on the pad surface. Geometry starts a little below y = 0 so nothing floats.
 */
import type { DefLibrary, LaunchSiteDef } from '@/core/contracts/defs';
import type { QuatTuple, Vec3Tuple } from '@/core/math';
import type { PartLight, PartModel } from '../parts/types';

export type StructureParams = Record<string, number | string>;

export interface SiteGenContext {
  params: StructureParams;
  site: LaunchSiteDef;
  defs: DefLibrary;
}

/** Presentation state of the launch complex. */
export interface SiteState {
  /** 0 by day .. 1 at night: lamps on. */
  night: number;
  /** Umbilical swing arms: 0 = connected to the vehicle, 1 = fully retracted. */
  arms: number;
  /** Crew access arm: 0 = at the hatch, 1 = retracted. */
  crewArm: number;
}

export interface SiteItemOpts {
  /** Multiplier on lamp materials' luminance. */
  emissive?: number;
  /** True while the item is moving relative to the ground (drawn as a moving shadow caster). */
  moving?: boolean;
  castShadow?: boolean;
  /**
   * Cast a sun shadow only into the cascades fine enough to resolve it (texel under `NEAR_SHADOW_TEXEL`):
   * low pipe runs and other long, thin structures whose shadow is a line on the ground beside them.
   */
  nearShadowOnly?: boolean;
  /**
   * Cast a sun shadow only into the FINE cascades (texel under `FINE_SHADOW_TEXEL`): lattice members,
   * stairs, rails. In a coarser cascade a member thinner than a texel is a row of dots; there the structure's
   * `shadowProxy` item casts instead.
   */
  fineShadowOnly?: boolean;
  /**
   * The item is not drawn at all; it only casts the sun shadow of a thin structure into the cascades too
   * coarse to resolve its members (texel over `FINE_SHADOW_TEXEL`): a solid, slender stand-in, so that the
   * shadow of a mast or a pipe run stays a continuous band at any distance instead of breaking up or
   * dropping out. Together with `fineShadowOnly` it is the opposite: a simplified caster for the FINE
   * cascades of a lattice so dense (rails, treads, plates on every level) that drawing all of it into the
   * every-frame cascades costs more than its shadow shows.
   */
  shadowProxy?: boolean;
  /** 0..1 multiplier on the model's vertex grime weights (weathering, blast staining; default 0). */
  grime?: number;
}

/** Coarsest shadow-map texel (m) in which a `nearShadowOnly` item is still drawn: the 300 m cascade. */
export const NEAR_SHADOW_TEXEL = 0.35;

/** Coarsest shadow-map texel (m) that still resolves lattice members: the 12 m and 60 m cascades. */
export const FINE_SHADOW_TEXEL = 0.1;

export type SiteSink = (model: string, pos: Vec3Tuple | null, rot: QuatTuple | null, opts?: SiteItemOpts) => void;

export interface SiteVisual {
  models: Record<string, PartModel>;
  pose(state: SiteState, emit: SiteSink, moving: { arms: boolean; crewArm: boolean }): void;
  /** Lamps of the structure in its model frame (registered as local lights at night). */
  lights?: PartLight[];
}

export type SiteGenerator = (ctx: SiteGenContext) => SiteVisual;

const generators = new Map<string, SiteGenerator>();

export function registerSiteGenerator(id: string, g: SiteGenerator): void {
  generators.set(id, g);
}

export function siteGeneratorIds(): string[] {
  return [...generators.keys()].sort();
}

export function generateStructure(defs: DefLibrary, site: LaunchSiteDef, model: string, params: StructureParams): SiteVisual {
  const g = generators.get(model);
  if (!g) throw new Error(`site "${site.id}": unknown structure model "${model}"`);
  return g({ params, site, defs });
}

/** Numeric structure parameter with a default. */
export function numParam(p: StructureParams, key: string, fallback: number): number {
  const v = p[key];
  if (v === undefined) return fallback;
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`structure parameter "${key}" must be a number`);
  return v;
}

export function strParam(p: StructureParams, key: string, fallback: string): string {
  const v = p[key];
  if (v === undefined) return fallback;
  if (typeof v !== 'string') throw new Error(`structure parameter "${key}" must be a string`);
  return v;
}

/** Static structure: one 'body' model. */
export const staticSite = (_state: SiteState, emit: SiteSink): void => emit('body', null, null);

/**
 * Static structure that casts no sun shadow: slabs flush with the ground and thin wires. Their shadows are
 * below what the cascades resolve, and a slab as large as the apron would fill every near cascade. The
 * vertex grime weights of the model (stains, weathering) are shown in full.
 */
export const flatSite = (_state: SiteState, emit: SiteSink): void => emit('body', null, null, { castShadow: false, grime: 1 });

/** Static structure that is close to the ground and thin: its shadow is drawn in the near cascades only. */
export const lowSite = (_state: SiteState, emit: SiteSink): void => emit('body', null, null, { nearShadowOnly: true });
