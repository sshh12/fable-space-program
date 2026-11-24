/**
 * A vessel as the target (ARCHITECTURE 21; island-core scope D): `Readouts.target` through the navigation
 * functions of src/sim/nav/target.ts, the navball's target direction, relative markers and target mode, the
 * SAS modes that hold toward the target and away from it, and what happens when the target is deselected
 * or gone. Two capsules that part in low orbit; nothing here docks.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { DefLibrary, ScenarioDef, VehicleDef } from '@/core/contracts/defs';
import type { LocalSession } from '@/core/contracts/session';
import type { SimSnapshot, VesselSnapshot } from '@/core/contracts/sim';
import type { TerrainProvider } from '@/core/contracts/terrain';
import { quat } from '@/core/math/quat';
import { v3, type Vec3 } from '@/core/math/vec3';
import { dockFace, type Vessel } from '@/sim/vessel';
import { active, comState, controls, flatTerrain, loadLibrary, makeSim, orbitScenario } from './helpers';

const CAPSULE = 'kestrel-capsule';
const others = (s: SimSnapshot): VesselSnapshot[] => s.vessels.filter((v) => v.id !== s.activeVesselId);
const steps = (sim: LocalSession, n: number): void => {
  for (let i = 0; i < n; i++) sim.step();
};

describe('a vessel target', () => {
  let lib: DefLibrary;
  let terrain: TerrainProvider;
  let scenario: ScenarioDef;
  beforeAll(async () => {
    const defs = await loadLibrary();
    const mission = defs.vehicles[defs.scenarios['lunar-direct']!.vehicle]!;
    // Two capsules joined by the capsule adapter; the stage button parts them.
    const vehicle: VehicleDef = {
      ...mission,
      id: 't-twin',
      name: 'Twin capsules',
      parts: [
        { id: 'capsule-a', def: CAPSULE, parent: null, stageGroup: 'a' },
        { id: 'joint', def: 'heron-capsule-adapter', parent: 'capsule-a', parentNode: 'bottom', node: 'top', stageGroup: 'b' },
        { id: 'capsule-b', def: CAPSULE, parent: 'joint', parentNode: 'bottom', node: 'top', stageGroup: 'b' },
      ],
      stageGroups: [
        { id: 'a', label: 'Capsule A' },
        { id: 'b', label: 'Capsule B' },
      ],
      stages: [{ label: 'Part', icon: 'decoupler', actions: [{ kind: 'decouple', part: 'joint' }] }],
      abort: [],
      actionGroups: {},
      cockpit: null,
    };
    lib = { ...defs, vehicles: { ...defs.vehicles, [vehicle.id]: vehicle } };
    terrain = flatTerrain(lib);
    scenario = { ...orbitScenario(lib.scenarios['lunar-direct']!, 't-target', 'earth', 300000, 300000, 0), vehicle: vehicle.id };
  });

  /** The two capsules a few seconds after they parted, and the id of the one the pilot is not in. */
  async function parted(): Promise<{ sim: LocalSession; other: string }> {
    const sim = await makeSim(lib, scenario, terrain);
    expect(sim.commands.stage().ok).toBe(true);
    steps(sim, 600);
    const s = sim.snapshot();
    expect(s.vessels).toHaveLength(2);
    return { sim, other: others(s)[0]!.id };
  }

  it('is refused for a vessel that is not there, for the pilot\'s own vessel and for a port that is none; the target that was selected stays', async () => {
    const { sim, other } = await parted();
    const own = sim.peek().activeVesselId!;
    expect(sim.commands.setTarget({ kind: 'vessel', id: 'nobody' })).toEqual({ ok: false, reason: 'Unknown vessel' });
    expect(sim.commands.setTarget({ kind: 'vessel', id: own })).toEqual({ ok: false, reason: 'A vessel cannot target itself' });
    expect(sim.commands.setTarget({ kind: 'port', vesselId: other, portId: 'x/y' })).toEqual({ ok: false, reason: 'Unknown docking port' });
    expect(sim.peek().readouts.target?.ref ?? null).toEqual(sim.scenario.target ? { kind: 'body', id: sim.scenario.target } : null);
    expect(sim.commands.setSasMode('target')).toEqual({ ok: false, reason: 'No vessel or port target' });
    expect(sim.commands.setNavballMode('target')).toEqual({ ok: false, reason: 'No vessel or port target' });
  });

  it('gives the read-out between the two centres of mass, the navball\'s direction to the target and its relative markers', async () => {
    const { sim, other } = await parted();
    expect(sim.commands.setTarget({ kind: 'vessel', id: other })).toEqual({ ok: true });
    const s = sim.peek();
    const a = active(s);
    const b = others(s)[0]!;
    const t = s.readouts.target!;
    expect(t.ref).toEqual({ kind: 'vessel', id: other });
    expect(t.name).toBe(b.name);
    expect(t.presence).toBe('solid');
    expect(t.timeOffset).toBe(0);
    expect(t.offer).toBeNull();
    const ca = comState(a);
    const cb = comState(b);
    const d = v3.sub(cb.r, ca.r);
    const dv = v3.sub(cb.v, ca.v);
    const range = v3.len(d);
    expect(range).toBeGreaterThan(1);
    expect(t.range).toBeCloseTo(range, 6);
    expect(t.rangeRate).toBeCloseTo(v3.dot(d, dv) / range, 6);
    // They were pushed apart: the range opens.
    expect(t.rangeRate).toBeGreaterThan(0);
    expect(t.relSpeed!).toBeCloseTo(v3.len(dv), 6);
    expect(v3.len(t.relVelocity!)).toBeCloseTo(t.relSpeed!, 9);
    expect(t.relativeInclination!).toBeLessThan(1e-3);
    // A few metres apart on one orbit: the local-vertical frame of the target is meaningful, and the offset has the range's length.
    expect(t.lvlh).not.toBeNull();
    expect(Math.hypot(t.lvlh!.radial, t.lvlh!.along, t.lvlh!.cross)).toBeCloseTo(range, 6);
    expect(t.closestApproaches.length).toBeLessThanOrEqual(3);
    for (const c of t.closestApproaches) expect(c.ut).toBeGreaterThanOrEqual(s.simUt - 1e-6);
    expect(s.readouts.docking).toBeNull();
    // The navball: the target marker points along the line to the target, in vessel axes; the relative markers oppose each other.
    const m = s.navball.markers;
    const toTarget = quat.rotateInv(a.q, v3.normalize(d));
    expect(v3.dist(m.target!, toTarget)).toBeLessThan(1e-6);
    expect(v3.dist(m.antiTarget!, v3.neg(toTarget))).toBeLessThan(1e-6);
    expect(m.relativePrograde).not.toBeNull();
    expect(v3.dist(m.relativePrograde!, v3.neg(m.relativeRetrograde!))).toBeLessThan(1e-9);
    // Own velocity relative to the target: opposite to the target's relative to the pilot.
    expect(v3.dist(m.relativePrograde!, quat.rotateInv(a.q, v3.normalize(v3.neg(dv))))).toBeLessThan(1e-6);
    // The modes on offer follow the target: the two that need a vessel, not the one that needs a port.
    expect(s.readouts.sasModesAvailable).toContain('target');
    expect(s.readouts.sasModesAvailable).toContain('antiTarget');
    expect(s.readouts.sasModesAvailable).not.toContain('portAlign');
    expect(sim.commands.setSasMode('portAlign')).toEqual({ ok: false, reason: 'No docking port to align' });
    // Once the two are a few hundred metres apart both coast (outside the armed margin nothing is integrated). Two hours
    // of rails later, more than a revolution: the list holds what lies ahead, with its distances and speeds, never an
    // approach that has passed.
    for (let k = 0; k < 40 && sim.peek().readouts.target!.range < 400; k++) steps(sim, 120 * 60);
    expect(sim.peek().readouts.target!.range).toBeGreaterThan(400);
    steps(sim, 240);
    const from = sim.peek().simUt;
    sim.commands.setWarpLevel(6);
    sim.advanceRails(from + 7200);
    const later = sim.peek();
    expect(later.simUt - from).toBeGreaterThan(3600);
    const ahead = later.readouts.target!.closestApproaches;
    for (const c of ahead) {
      expect(c.ut).toBeGreaterThanOrEqual(later.simUt);
      expect(c.distance).toBeGreaterThanOrEqual(0);
      expect(c.distance).toBeLessThan(1e7);
      expect(c.relSpeed).toBeLessThan(1000);
    }
    for (let k = 1; k < ahead.length; k++) expect(ahead[k]!.ut).toBeGreaterThan(ahead[k - 1]!.ut);
  });

  it('the navball\'s target mode shows the velocity relative to the target as prograde, and is the pilot\'s to keep', async () => {
    const { sim, other } = await parted();
    sim.commands.setTarget({ kind: 'vessel', id: other });
    expect(sim.commands.setNavballMode('target')).toEqual({ ok: true });
    steps(sim, 240);
    const s = sim.peek();
    expect(s.navball.mode).toBe('target');
    expect(v3.dist(s.navball.markers.prograde!, s.navball.markers.relativePrograde!)).toBeLessThan(1e-9);
    // Deselecting the target ends the mode: back to the mode of the altitude.
    expect(sim.commands.setTarget(null)).toEqual({ ok: true });
    expect(sim.peek().navball.mode).toBe('orbit');
    expect(sim.peek().readouts.target).toBeNull();
    expect(sim.peek().navball.markers.relativePrograde).toBeNull();
  });

  it('the SAS target modes turn the nose toward the target and away from it; without a target the mode falls back to stability', async () => {
    const { sim, other } = await parted();
    sim.commands.setTarget({ kind: 'vessel', id: other });
    expect(sim.commands.setSasEnabled(true).ok).toBe(true);
    /** Angle between the pilot's nose and the line to the target, rad. */
    const offNose = (): number => {
      const s = sim.peek();
      const a = active(s);
      const d = v3.sub(comState(others(s)[0]!).r, comState(a).r);
      return v3.angle(quat.rotate(a.q, { x: 0, y: 1, z: 0 }), d);
    };
    expect(sim.commands.setSasMode('target')).toEqual({ ok: true });
    expect(sim.peek().readouts.sasMode).toBe('target');
    steps(sim, 120 * 120);
    expect(offNose()).toBeLessThan(0.05);
    expect(sim.commands.setSasMode('antiTarget')).toEqual({ ok: true });
    steps(sim, 120 * 120);
    expect(offNose()).toBeGreaterThan(Math.PI - 0.05);
    expect(sim.commands.setTarget(null)).toEqual({ ok: true });
    expect(sim.peek().readouts.sasMode).toBe('stability');
    expect(sim.peek().readouts.sasModesAvailable).not.toContain('target');
  }, 120_000);

  it('a docking port as the target: centre to centre until the control part is a port, then port to port; portAlign brings the two port axes against each other', async () => {
    // Capsule A with a C port on its nose; capsule B, hung nose down under the adapter, with one on its own.
    const twin = lib.vehicles['t-twin']!;
    const vehicle: VehicleDef = {
      ...twin,
      id: 't-twin-ports',
      parts: [
        twin.parts[0]!,
        { id: 'port-a', def: 'dock-port-c', parent: 'capsule-a', parentNode: 'top', node: 'bottom', stageGroup: 'a' },
        twin.parts[1]!,
        { id: 'capsule-b', def: CAPSULE, parent: 'joint', parentNode: 'bottom', node: 'bottom', stageGroup: 'b' },
        { id: 'port-b', def: 'dock-port-c', parent: 'capsule-b', parentNode: 'top', node: 'bottom', stageGroup: 'b' },
      ],
    };
    const ported = { ...lib, vehicles: { ...lib.vehicles, [vehicle.id]: vehicle } };
    const sim = await makeSim(ported, { ...scenario, id: 't-target-ports', vehicle: vehicle.id }, flatTerrain(ported));
    expect(sim.commands.stage().ok).toBe(true);
    steps(sim, 600);
    let s = sim.snapshot();
    expect(s.vessels).toHaveLength(2);
    const b = others(s)[0]!;
    const portB = b.parts.find((p) => p.instanceId === 'port-b')!;
    const portKey = `${portB.craftId}/port-b`;
    expect(sim.commands.setTarget({ kind: 'port', vesselId: b.id, portId: `${portB.craftId}/capsule-b` })).toEqual({ ok: false, reason: 'Unknown docking port' });
    expect(sim.commands.setTarget({ kind: 'port', vesselId: b.id, portId: portKey })).toEqual({ ok: true });
    s = sim.peek();
    expect(s.readouts.target!.ref).toEqual({ kind: 'port', vesselId: b.id, portId: portKey });
    expect(s.readouts.sasModesAvailable).toContain('portAlign');
    // The pilot flies from the capsule: the range is between the centres of mass, and there is no port to align.
    const centres = v3.dist(comState(active(s)).r, comState(others(s)[0]!).r);
    expect(s.readouts.target!.range).toBeCloseTo(centres, 6);
    expect(sim.commands.setSasMode('portAlign')).toEqual({ ok: false, reason: 'No docking port to align' });
    // The helm moves to the own port (a helm grant: the island's input).
    const a = active(s);
    const portA = a.parts.find((p) => p.instanceId === 'port-a')!;
    const host = sim as unknown as { seat: { input(i: unknown): { accepted: boolean } }; island: { applyInput(i: unknown): { accepted: boolean }; tick: number }; touch(): void };
    expect(host.island.applyInput({ kind: 'helm', tick: host.island.tick, accountId: 'local', seq: 0, vesselId: a.id, pilot: 'local', craftId: null, controlPartKey: `${portA.craftId}/port-a` }).accepted).toBe(true);
    host.touch();
    /** The mating face of a port part of a vessel and its outward axis, BCI (read off the session's own vessels). */
    const roster = (sim as unknown as { roster: Vessel[] }).roster;
    const face = (v: VesselSnapshot, id: string): { r: Vec3; axis: Vec3 } => {
      const vessel = roster.find((x) => x.id === v.id)!;
      const f = dockFace(vessel.parts.find((x) => x.instanceId === id)!)!;
      return { r: v3.add(vessel.r, quat.rotate(vessel.q, f.pos)), axis: quat.rotate(vessel.q, f.dir) };
    };
    s = sim.peek();
    const ports = v3.dist(face(active(s), 'port-a').r, face(others(s)[0]!, 'port-b').r);
    expect(Math.abs(ports - centres)).toBeGreaterThan(0.5);
    expect(s.readouts.target!.range).toBeCloseTo(ports, 6);
    // portAlign: the own port's axis turns against the target port's.
    expect(sim.commands.setSasEnabled(true).ok).toBe(true);
    expect(sim.commands.setSasMode('portAlign')).toEqual({ ok: true });
    const against = (): number => {
      const now = sim.peek();
      return v3.angle(face(active(now), 'port-a').axis, v3.neg(face(others(now)[0]!, 'port-b').axis));
    };
    // (They hang nose to nose: turn the pilot's vessel away first, with the thrusters or wheels it has, SAS off.)
    expect(sim.commands.setSasEnabled(false).ok).toBe(true);
    sim.setControls(controls({ pitch: 1 }));
    steps(sim, 120 * 4);
    sim.setControls(controls());
    const before = against();
    expect(before).toBeGreaterThan(0.2);
    expect(sim.commands.setSasEnabled(true).ok).toBe(true);
    expect(sim.peek().readouts.sasMode).toBe('portAlign');
    steps(sim, 120 * 150);
    expect(sim.peek().readouts.sasMode).toBe('portAlign');
    expect(against()).toBeLessThan(0.1);
    expect(against()).toBeLessThan(before);
    // A vessel target instead of the port: nothing to align any more.
    expect(sim.commands.setTarget({ kind: 'vessel', id: b.id })).toEqual({ ok: true });
    expect(sim.peek().readouts.sasMode).toBe('stability');
  }, 120_000);
});
