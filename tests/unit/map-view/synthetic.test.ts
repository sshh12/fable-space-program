/**
 * The synthetic multi-patch fixtures are geometrically continuous (patch ends meet the next patch's start
 * in ROOT within 1 m at the shared time), carry every marker kind, two nodes on different patches (one of
 * them 2.5 revolutions ahead), 20 debris orbits and the surface targets the map draws.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { DefLibrary } from '@/core/contracts/defs';
import type { MarkerKind, Patch } from '@/core/contracts/sim';
import { fsDefSource } from '@/core/defs/fsSource';
import { loadDefs } from '@/core/defs/loader';
import { conicPosition, timeSincePeriapsis } from '@/core/math/conic';
import { v3 } from '@/core/math/vec3';
import { forwardTime } from '@/map/anomalyTime';
import { createSyntheticFixture, type SyntheticFixture } from '@/map/testing/syntheticSnapshots';

const ALL_KINDS: MarkerKind[] = ['apoapsis', 'periapsis', 'ascendingNode', 'descendingNode', 'soiEnter', 'soiExit', 'impact', 'atmosphereEntry', 'closestApproach', 'maneuverNode'];

let defs: DefLibrary;
let fx: SyntheticFixture;
let perf: SyntheticFixture;

beforeAll(async () => {
  defs = await loadDefs(fsDefSource());
  fx = createSyntheticFixture(defs);
  perf = createSyntheticFixture(defs, { correctionNodes: 3 });
});

const startRoot = (f: SyntheticFixture, p: Patch) => v3.add(f.bodyPosition(p.bodyId, p.tStart), conicPosition(p.conic, p.nuStart));
const endRoot = (p: Patch) => v3.add(p.bodyPosAtEnd, conicPosition(p.conic, p.nuEnd));

/** Duration implied by the conic between the patch anomalies (multi-revolution aware). */
function conicDuration(p: Patch): number {
  const c = p.conic;
  if (c.period === null) return timeSincePeriapsis(c, p.nuEnd) - timeSincePeriapsis(c, p.nuStart);
  const turns = Math.floor((p.nuEnd - p.nuStart) / (2 * Math.PI) + 1e-12);
  const rest = p.nuEnd - p.nuStart - turns * 2 * Math.PI;
  return turns * c.period + (rest > 1e-12 ? forwardTime(c, p.nuStart, p.nuStart + rest) : 0);
}

describe('synthetic map fixtures', () => {
  it.each([
    ['main', () => fx],
    ['8-patch', () => perf],
  ])('%s chain is continuous in ROOT within 1 m', (_name, get) => {
    const f = get();
    const s = f.snapshot;
    for (const list of [s.patches.current, s.patches.planned]) {
      for (let i = 0; i + 1 < list.length; i++) {
        const a = list[i]!;
        const b = list[i + 1]!;
        expect(Math.abs(a.tEnd - b.tStart)).toBeLessThan(1e-3);
        expect(v3.dist(endRoot(a), startRoot(f, b))).toBeLessThan(1);
      }
      for (const p of list) {
        expect(Math.abs(conicDuration(p) - (p.tEnd - p.tStart))).toBeLessThan(0.05);
        // bodyPosAtEnd is the fixture's body position at tEnd
        expect(v3.dist(p.bodyPosAtEnd, f.bodyPosition(p.bodyId, p.tEnd))).toBeLessThan(1e-3);
      }
    }
    // The planned chain starts at node A on current[1], at the same ROOT point.
    const a = s.patches.planned[0]!;
    const pre = s.patches.current[1]!;
    const nodeMarker = pre.markers.find((m) => m.kind === 'maneuverNode')!;
    expect(nodeMarker.nodeId).toBe(a.afterNodeId);
    expect(Math.abs(nodeMarker.ut - a.tStart)).toBeLessThan(1e-3);
    expect(v3.dist(v3.add(f.bodyPosition(pre.bodyId, a.tStart), nodeMarker.r), startRoot(f, a))).toBeLessThan(1);
    // The vessel sits at the start of the current chain.
    const vessel = s.vessels.find((v) => v.id === s.activeVesselId)!;
    expect(v3.dist(vessel.rRoot, startRoot(f, s.patches.current[0]!))).toBeLessThan(1);
  });

  it('is the Earth -> Moon -> Earth chain with a lunar impact and every marker kind', () => {
    const s = fx.snapshot;
    const cur = s.patches.current;
    const pl = s.patches.planned;
    expect(cur.map((p) => [p.bodyId, p.endReason])).toEqual([
      [fx.rootId, 'soiEnter'],
      [fx.moonId, 'impact'],
    ]);
    expect(pl.map((p) => [p.bodyId, p.endReason])).toEqual([
      [fx.moonId, 'soiExit'],
      [fx.rootId, 'maneuver'],
      [fx.rootId, 'atmosphere'],
    ]);
    expect(cur[0]!.conic.e).toBeLessThan(1); // departure ellipse
    expect(cur[1]!.conic.e).toBeGreaterThan(1); // lunar hyperbola
    expect(pl[0]!.conic.e).toBeGreaterThan(1); // flyby hyperbola
    const kinds = new Set([...cur, ...pl].flatMap((p) => p.markers.map((m) => m.kind)));
    for (const k of ALL_KINDS) expect(kinds.has(k), k).toBe(true);
    const flyby = pl[0]!.markers.find((m) => m.kind === 'periapsis')!;
    expect(flyby.altitude!).toBeGreaterThan(100e3);
    const entry = pl[2]!.markers.find((m) => m.kind === 'atmosphereEntry')!;
    expect(entry.latitude).toBeTypeOf('number');
    expect(entry.longitude).toBeTypeOf('number');
    expect(entry.flightPathAngle!).toBeLessThan(0);
    expect(entry.vacuumPeriapsisAltitude!).toBeGreaterThan(20e3);
    expect(entry.vacuumPeriapsisAltitude!).toBeLessThan(80e3);
    const impact = cur[1]!.markers.find((m) => m.kind === 'impact')!;
    expect(impact.latitude).toBeTypeOf('number');
    expect(v3.len(impact.r)).toBeCloseTo(defs.bodies[fx.moonId]!.radius, -1);
    expect(s.readouts.landingTarget?.predicted?.kind).toBe('impact');
  });

  it('has two nodes on different patches, the second 2.5 revolutions ahead', () => {
    const s = fx.snapshot;
    expect(s.nodes.map((n) => n.id)).toEqual([fx.nodeA.id, fx.nodeB.id]);
    const holder = (id: string) => [...s.patches.current, ...s.patches.planned].findIndex((p) => p.markers.some((m) => m.kind === 'maneuverNode' && m.nodeId === id));
    expect(holder(fx.nodeA.id)).not.toBe(holder(fx.nodeB.id));
    const orbit = s.patches.planned[1]!;
    expect(orbit.endReason).toBe('maneuver');
    expect(orbit.tEnd).toBeCloseTo(fx.nodeB.ut, 3);
    expect((orbit.nuEnd - orbit.nuStart) / (2 * Math.PI)).toBeCloseTo(2.5, 9);
    expect(orbit.conic.period).not.toBeNull();
  });

  it('has 20 debris orbits, another vessel and the landing, site and recovery targets', () => {
    const s = fx.snapshot;
    expect(s.vessels.filter((v) => !v.controllable)).toHaveLength(20);
    expect(s.vessels.filter((v) => v.controllable && v.id !== s.activeVesselId).length).toBeGreaterThan(0);
    const kinds = s.surfaceTargets.map((t) => t.kind);
    expect(kinds).toContain('landing');
    expect(kinds).toContain('site');
    expect(kinds.filter((k) => k === 'recovery').length).toBeGreaterThan(0);
  });

  it('the load case has 8 patches', () => {
    const s = perf.snapshot;
    expect(s.patches.current.length + s.patches.planned.length).toBe(8);
  });
});
