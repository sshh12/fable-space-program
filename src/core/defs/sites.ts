/**
 * The pads of a launch site (docs/ARCHITECTURE.md 9.3; MIGRATION_V2 step 3.6).
 *
 * A site has a list of pads (`LaunchSiteDef.pads`, `PadDef`); the first pad stands at the site's reference
 * point (`location.latDeg`, `lonDeg`, `padElevation`), every other pad at its resolved coordinates
 * (`location.pads[<pad id>]`, written by the site-resolve bake tool). The deprecated single pad
 * (`pad`, `padAzimuthDeg`, `structures`) IS the first pad: the loader fills the two forms from each other,
 * so a loaded library always has both; a site that was built in memory with the single pad only is read
 * through `padsOf`, which gives that pad as the one pad of the site.
 *
 * Everything that needs a pad goes through these functions: the scenario start (the pad a vehicle stands
 * on), the terrain's flatten discs (one per pad) and the surface targets.
 */
import type { LaunchSiteDef, PadDef } from '../contracts/defs';

/** Where a pad is: planetocentric latitude and east longitude, deg, and the pad surface elevation above the reference radius, m ('terrain' = natural height at the pad centre). */
export interface PadLocation {
  latDeg: number;
  lonDeg: number;
  padElevation: number | 'terrain';
}

/** Id of the one pad of a site that states the deprecated single pad and no pad list. */
export const SINGLE_PAD_ID = 'pad';

const derived = new WeakMap<LaunchSiteDef, PadDef[]>();

/**
 * The deprecated single pad of a site as a `PadDef`: at the reference point, facing `padAzimuthDeg`, with
 * the single pad's disc, mount height and structures. v1 stated no class and no limits: the pad hosts
 * every class and has none.
 */
export function singlePadOf(site: LaunchSiteDef): PadDef {
  return {
    id: SINGLE_PAD_ID,
    name: site.name,
    offsetEnu: [0, 0],
    azimuthDeg: site.padAzimuthDeg,
    class: 'heavy',
    maxLiftoffMass: Number.POSITIVE_INFINITY,
    maxDiameter: Number.POSITIVE_INFINITY,
    flatRadius: site.pad.flatRadius,
    blendRadius: site.pad.blendRadius,
    ...(site.pad.shape ? { shape: site.pad.shape } : {}),
    mountHeight: site.pad.clampHeight,
    structures: site.structures,
  };
}

/** The pads of a site, first pad first: its pad list, or the deprecated single pad as the one pad. */
export function padsOf(site: LaunchSiteDef): PadDef[] {
  if (site.pads && site.pads.length > 0) return site.pads;
  let pads = derived.get(site);
  if (!pads) {
    pads = [singlePadOf(site)];
    derived.set(site, pads);
  }
  return pads;
}

/** The pad `padId` of a site; absent = the site's first pad (`ScenarioDef.pad`). Throws naming the site, the id and the pads it has. */
export function padOf(site: LaunchSiteDef, padId?: string): PadDef {
  const pads = padsOf(site);
  if (padId === undefined) return pads[0]!;
  const pad = pads.find((p) => p.id === padId);
  if (!pad) throw new Error(`sites/${site.id}.json: no pad "${padId}" (pads: ${pads.map((p) => p.id).join(', ')})`);
  return pad;
}

/**
 * Where the pad `padId` of a site is (absent = the first pad): its resolved coordinates, and for the first
 * pad the site's reference point. Throws when another pad has no resolved coordinates: an elevation
 * cannot be derived from an offset.
 */
export function padLocationOf(site: LaunchSiteDef, padId?: string): PadLocation {
  const pad = padOf(site, padId);
  const resolved = site.location.pads?.[pad.id];
  if (resolved) return resolved;
  if (pad === padsOf(site)[0]) return { latDeg: site.location.latDeg, lonDeg: site.location.lonDeg, padElevation: site.location.padElevation };
  throw new Error(`sites/${site.id}.json: pad "${pad.id}" has no resolved coordinates (location.pads["${pad.id}"], written by the site-resolve bake tool)`);
}

/** What a pad is called in full: "<site>, <pad>"; the site's name alone for a site that states the single pad only. */
export function padTitle(site: LaunchSiteDef, padId?: string): string {
  const pad = padOf(site, padId);
  return site.pads && site.pads.length > 0 ? `${site.name}, ${pad.name}` : site.name;
}
