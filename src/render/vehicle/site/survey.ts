/**
 * The surveyed ground of a launch site. A site's terrain is level only where its pad shape says so (the
 * hardstand and a few areas); between them a share of the natural relief is kept, so a road, a berm, a fence
 * or a pipe support that assumed the pad plane would be buried in one place and hang in the air in another.
 * Earthworks are therefore designed on a survey, as real ones are: the section `visuals/sites/<siteId>` holds
 * the highest and the lowest terrain round every node of a grid over the site, in the pad's east / north
 * frame and relative to the pad plane (written by `tools/vehicle/site-ground.ts survey` from the height
 * authority, i.e. from the surface the game draws and collides with; `... verify` checks it against the tiles).
 *
 * `hi` is an upper bound of the terrain and `lo` a lower bound everywhere inside the grid (bilinear between
 * nodes that each carry the extreme of their whole neighbourhood): what is built above `hi` is never buried,
 * and a skirt that reaches below `lo` never shows a gap.
 *
 * A site that has structures and no survey does not load: `siteGround` throws. Level ground is never assumed
 * (that assumption is what buried the roads); a caller that really draws the site on a level stand-in
 * surface (the vehicle lab's reference sphere, the survey tool measuring the extent of the structures) says
 * so by passing `LEVEL_GROUND`.
 */
import type { DefLibrary, LaunchSiteDef } from '@/core/contracts/defs';

export interface SiteSurveyDef {
  /** Where the heights come from (for a person: tile set, date). */
  source: string;
  /** Grid spacing, m. */
  step: number;
  /** East / north of node (0, 0) from the pad centre, m, and the number of nodes along east and north. */
  east0: number;
  north0: number;
  nx: number;
  ny: number;
  /** Highest and lowest terrain within one step of each node, cm above the pad plane; index = j * nx + i. */
  hiCm: number[];
  loCm: number[];
}

/** Terrain height bounds (m above the pad plane) at a point of some horizontal frame. */
export interface GroundField {
  hi(x: number, z: number): number;
  lo(x: number, z: number): number;
  /** False for `LEVEL_GROUND`. */
  surveyed: boolean;
}

/** Level ground at the pad plane: only for a caller that draws a site on a level stand-in surface. */
export const LEVEL_GROUND: GroundField = { hi: () => 0, lo: () => 0, surveyed: false };

/** Section key of a site's ground survey. */
export const surveySectionOf = (siteId: string): string => `visuals/sites/${siteId}`;

export function siteSurvey(defs: DefLibrary, site: LaunchSiteDef): SiteSurveyDef | null {
  const section = defs.sections[surveySectionOf(site.id)] as { survey?: SiteSurveyDef } | undefined;
  const s = section?.survey;
  if (!s) return null;
  if (!(s.step > 0) || s.nx < 2 || s.ny < 2 || s.hiCm.length !== s.nx * s.ny || s.loCm.length !== s.nx * s.ny) throw new Error(`site "${site.id}": malformed ground survey`);
  return s;
}

function sample(s: SiteSurveyDef, grid: number[], east: number, north: number): number {
  const fx = Math.max(0, Math.min(s.nx - 1, (east - s.east0) / s.step));
  const fy = Math.max(0, Math.min(s.ny - 1, (north - s.north0) / s.step));
  const i = Math.min(s.nx - 2, Math.floor(fx));
  const j = Math.min(s.ny - 2, Math.floor(fy));
  const u = fx - i;
  const v = fy - j;
  const k = j * s.nx + i;
  return ((grid[k]! * (1 - u) + grid[k + 1]! * u) * (1 - v) + (grid[k + s.nx]! * (1 - u) + grid[k + s.nx + 1]! * u) * v) / 100;
}

/**
 * The site's ground in its own frame: x = east, z = SOUTH of the pad centre (a structure frame at heading 0).
 * Throws for a site with structures and no survey (run `tools/vehicle/site-ground.ts survey`).
 */
export function siteGround(defs: DefLibrary, site: LaunchSiteDef): GroundField {
  const s = siteSurvey(defs, site);
  if (!s) {
    if (site.structures.length === 0) return LEVEL_GROUND;
    throw new Error(`site "${site.id}": no ground survey (section ${surveySectionOf(site.id)}); its structures cannot be built on the terrain. Run tools/vehicle/site-ground.ts survey`);
  }
  return { hi: (x, z) => sample(s, s.hiCm, x, -z), lo: (x, z) => sample(s, s.loCm, x, -z), surveyed: true };
}

/**
 * The ground in the model frame of a structure placed at `offsetEnu` with `headingDeg` (model +X = east turned
 * clockwise by the heading, +Z = against the heading direction: the site feature's placement).
 */
export function structureGround(ground: GroundField, offsetEnu: readonly [number, number, number], headingDeg: number): GroundField {
  if (!ground.surveyed) return ground;
  const h = (headingDeg * Math.PI) / 180;
  const c = Math.cos(h);
  const s = Math.sin(h);
  // east = E0 + x cos h - z sin h; north = N0 - x sin h - z cos h; the site frame's z is -north.
  const ex = (x: number, z: number): number => offsetEnu[0] + x * c - z * s;
  const sz = (x: number, z: number): number => -(offsetEnu[1] - x * s - z * c);
  return { hi: (x, z) => ground.hi(ex(x, z), sz(x, z)) - offsetEnu[2], lo: (x, z) => ground.lo(ex(x, z), sz(x, z)) - offsetEnu[2], surveyed: true };
}
