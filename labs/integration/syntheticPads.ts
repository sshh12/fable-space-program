/**
 * A SYNTHETIC multi-pad site for the integration lab (`&pads=<n>`), to look at the paths that are per pad:
 * the site feature's runtime, structures and arm state per pad, the terrain's levelled disc and ground plan
 * per pad, the ground cover's clearing. The library's sites have one pad each today; the sites of the shared
 * universe will have many (ARCHITECTURE 9).
 *
 * Nothing on disk changes: the definitions are loaded as they are and the first site is given `n` pads IN
 * MEMORY, copies of its own pad in a row to the north-west, each with its own id, azimuth and resolved
 * coordinates (`location.pads`) at the height of the natural ground there (a number, asked of a height
 * authority that does not know the new pads yet: `elevationAt`), and with the first pad's ground
 * survey (a copied pad has no survey of its own ground: beyond its levelled disc the footings of its far
 * structures stand on the first pad's relief, which is good enough to look at and nothing to measure).
 */
import type { DefLibrary, LaunchSiteDef, PadDef } from '@/core/contracts/defs';
import { padLocationOf, padOf } from '@/core/defs/sites';
import { DEG } from '@/core/math';

/** Distance between two neighbouring synthetic pads, m (their levelled discs do not touch). */
export const SYNTHETIC_PAD_SPACING = 1100;
/** Compass direction of the row of pads, deg. */
export const SYNTHETIC_PAD_BEARING = 320;

export interface SyntheticPads {
  defs: DefLibrary;
  siteId: string;
  bodyId: string;
  /** Every pad of the site, the library's own first. */
  padIds: string[];
}

/**
 * The library with `count` pads on its first site (the site's own pad and `count - 1` copies).
 * `elevationAt(latDeg, lonDeg)`: the natural ground's height above the body's reference radius there, m.
 */
export async function withSyntheticPads(defs: DefLibrary, count: number, elevationAt: (latDeg: number, lonDeg: number) => Promise<number>): Promise<SyntheticPads> {
  const site: LaunchSiteDef | undefined = Object.values(defs.sites)[0];
  if (!site) throw new Error('synthetic pads: the library has no launch site');
  if (!Number.isInteger(count) || count < 2 || count > 8) throw new Error(`synthetic pads: ${count} pads asked for; 2 to 8`);
  const body = defs.bodies[site.bodyId];
  if (!body) throw new Error(`synthetic pads: site "${site.id}" is on an unknown body "${site.bodyId}"`);
  const first = padOf(site);
  const at = padLocationOf(site);
  const pads: PadDef[] = [first];
  const locations: NonNullable<LaunchSiteDef['location']['pads']> = { ...site.location.pads, [first.id]: at };
  const sectionKey = `visuals/sites/${site.id}`;
  const section = (defs.sections[sectionKey] ?? {}) as { survey?: unknown; pads?: Record<string, { survey?: unknown } | undefined> };
  const surveys: Record<string, { survey?: unknown } | undefined> = { ...section.pads };
  for (let k = 1; k < count; k++) {
    const east = SYNTHETIC_PAD_SPACING * k * Math.sin(SYNTHETIC_PAD_BEARING * DEG);
    const north = SYNTHETIC_PAD_SPACING * k * Math.cos(SYNTHETIC_PAD_BEARING * DEG);
    const id = `lab-pad-${k + 1}`;
    pads.push({ ...first, id, name: `Lab pad ${k + 1}`, offsetEnu: [first.offsetEnu[0] + east, first.offsetEnu[1] + north], azimuthDeg: (first.azimuthDeg + 45 * k) % 360 });
    const latDeg = at.latDeg + north / body.radius / DEG;
    const lonDeg = at.lonDeg + east / (body.radius * Math.cos(at.latDeg * DEG)) / DEG;
    locations[id] = { latDeg, lonDeg, padElevation: await elevationAt(latDeg, lonDeg) };
    if (section.survey !== undefined) surveys[id] = { survey: section.survey };
  }
  const multi: LaunchSiteDef = { ...site, pads, location: { ...site.location, pads: locations } };
  return {
    defs: { ...defs, sites: { ...defs.sites, [site.id]: multi }, sections: { ...defs.sections, [sectionKey]: { ...section, pads: surveys } } },
    siteId: site.id,
    bodyId: site.bodyId,
    padIds: pads.map((p) => p.id),
  };
}
