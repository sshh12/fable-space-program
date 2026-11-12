/**
 * Named surface places of a scenario (SurfaceTarget in src/core/contracts/sim.ts): the scenario's
 * suggested landing ('landing', point target), the launch site ('site', radius = pad flat radius) and the
 * site's recovery zones ('recovery', radius from radiusKm). Ids: 'landing', 'site:<siteId>',
 * 'recovery:<index>' (index in LaunchSiteDef.recoveryZones).
 */
import type { DefLibrary, ScenarioDef } from '../../core/contracts/defs';
import type { SurfaceTarget } from '../../core/contracts/sim';
import { DEG } from '../../core/math/scalar';
import { padLocationOf, padOf, padTitle } from '../../core/defs/sites';

export function buildSurfaceTargets(defs: DefLibrary, scenario: ScenarioDef): SurfaceTarget[] {
  const out: SurfaceTarget[] = [];
  const l = scenario.suggestedLanding;
  if (l) {
    if (!defs.bodies[l.bodyId]) throw new Error(`scenarios/${scenario.id}.json: suggestedLanding on unknown body "${l.bodyId}"`);
    out.push({ id: 'landing', name: l.name, bodyId: l.bodyId, kind: 'landing', latitude: l.latDeg * DEG, longitude: l.lonDeg * DEG, radius: 0 });
  }
  const site = defs.sites[scenario.site];
  if (!site) throw new Error(`scenarios/${scenario.id}.json: unknown site "${scenario.site}"`);
  // The launch site as a target is the pad the scenario stands on: its place, its flat ground, its full name.
  const pad = padOf(site, scenario.pad);
  const where = padLocationOf(site, pad.id);
  out.push({
    id: `site:${site.id}`,
    name: padTitle(site, pad.id),
    bodyId: site.bodyId,
    kind: 'site',
    latitude: where.latDeg * DEG,
    longitude: where.lonDeg * DEG,
    radius: pad.flatRadius,
  });
  site.recoveryZones.forEach((z, i) => {
    out.push({ id: `recovery:${i}`, name: z.name, bodyId: site.bodyId, kind: 'recovery', latitude: z.latDeg * DEG, longitude: z.lonDeg * DEG, radius: z.radiusKm * 1000 });
  });
  return out;
}
