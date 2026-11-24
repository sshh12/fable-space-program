/**
 * The terrain guard's points that fleet-data's site files change, audited against the rule of the lead's
 * re-record (docs/handoff/lead-baseline-v2.md sections 18 and 27): ONLY points inside a NEW pad's flatten disc
 * may change. Samples the three height queries of the guard at every stored direction of the Earth on the
 * live library and tiles, lists every point that differs from the recording with its group, its place and the
 * new pad whose disc holds it (flat or blend zone, by `padZoneOf` with the radii the site files state), and
 * writes the list to terrain-guard-pad-changes.json beside this file. It fails (exit code 1) when a changed
 * point lies outside every new disc, or inside the disc of a pad that existed before (LC-1).
 *
 *   node tools/dev/heavy.mjs --class=cpu -- npx tsx tests/unit/fleet/guardAudit.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { padLocationOf, padsOf } from '@/core/defs/sites';
import { BAND_LIMITS, directionsOf, GUARD_DIR, HEIGHTS_FILE, heightDifferences, loadRealDefs, openTerrain, padZoneOf, sampleHeights, type GuardHeights, type GuardPad } from '../terrain-core/terrain-guard';

const PRE_EXISTING = new Set(['ka-lae/lc-1']);
const defs = await loadRealDefs();
const recorded = JSON.parse(fs.readFileSync(HEIGHTS_FILE, 'utf8')) as GuardHeights;
const earthId = 'earth' in recorded.bodies ? 'earth' : Object.keys(recorded.bodies)[0]!;
const body = recorded.bodies[earthId]!;
const newPads: (GuardPad & { site: string })[] = [];
const oldPads: GuardPad[] = [];
for (const site of Object.values(defs.sites).filter((s) => s.bodyId === earthId)) {
  for (const pad of padsOf(site)) {
    const at = padLocationOf(site, pad.id);
    const g = { id: `${site.id}/${pad.id}`, latDeg: at.latDeg, lonDeg: at.lonDeg, flatRadius: pad.flatRadius, blendRadius: pad.blendRadius };
    if (PRE_EXISTING.has(g.id)) oldPads.push(g);
    else newPads.push({ ...g, site: site.id });
  }
}
const terrain = await openTerrain(defs);
const sampled = await sampleHeights(terrain, earthId, directionsOf(body.directions));
const queries: [string, string, string][] = [['collision', body.collision, sampled.collision], ...BAND_LIMITS.map((l): [string, string, string] => [`band ${l} m`, body.band[String(l)]!, sampled.band[String(l)]!])];
interface Row {
  index: number;
  group: string;
  latDeg: number;
  lonDeg: number;
  pad: string | null;
  zone: string;
  queries: Record<string, { recorded: number; current: number }>;
}
const rows = new Map<number, Row>();
for (const [name, rec, cur] of queries) {
  for (const c of heightDifferences(body, rec, cur)) {
    let row = rows.get(c.index);
    if (!row) {
      const inside = padZoneOf(newPads, c, body.radius);
      const inOld = padZoneOf(oldPads, c, body.radius);
      row = { index: c.index, group: c.group, latDeg: c.latDeg, lonDeg: c.lonDeg, pad: inside && inside.zone !== 'outside' ? inside.pad : null, zone: inOld && inOld.zone !== 'outside' ? `old:${inOld.zone}` : (inside?.zone ?? 'outside'), queries: {} };
      rows.set(c.index, row);
    }
    row.queries[name] = { recorded: c.recorded, current: c.current };
  }
}
const list = [...rows.values()].sort((a, b) => a.index - b.index);
const byGroup: Record<string, number> = {};
const byPad: Record<string, number> = {};
for (const r of list) {
  byGroup[r.group] = (byGroup[r.group] ?? 0) + 1;
  if (r.pad) byPad[r.pad] = (byPad[r.pad] ?? 0) + 1;
}
const bad = list.filter((r) => r.pad === null || r.zone.startsWith('old:'));
const report = {
  rule: 'only points inside a NEW pad flatten disc (flat or blend zone, radii as the site files state) may change',
  tilesetContentHash: body.tilesetContentHash,
  changedPoints: list.length,
  byGroup,
  byPad,
  outsideEveryNewDisc: bad.length,
  newPads: newPads.map(({ id, latDeg, lonDeg, flatRadius, blendRadius }) => ({ id, latDeg, lonDeg, flatRadius, blendRadius })),
  points: list,
};
fs.writeFileSync(path.join(GUARD_DIR, '..', 'fleet', 'terrain-guard-pad-changes.json'), `${JSON.stringify(report, null, 1)}\n`);
console.log(`changed ${list.length} points; by group ${JSON.stringify(byGroup)}; outside every new disc or in an old one: ${bad.length}`);
for (const r of bad) console.log('  NOT IN A NEW DISC:', JSON.stringify(r));
process.exit(bad.length === 0 ? 0 : 1);
