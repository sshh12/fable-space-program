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
}

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
