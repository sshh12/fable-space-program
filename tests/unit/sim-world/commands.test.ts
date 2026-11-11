/**
 * PlayerCommands, maneuver nodes with burn bookkeeping, targets, navball mode, the cheat counter, the
 * state hash, mission failure states, debris tiers and the vessel list.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { DefLibrary } from '@/core/contracts/defs';
import { PHYSICS_DT } from '@/core/contracts/defs';
import type { Sim, SimSnapshot } from '@/core/contracts/sim';
import type { TerrainProvider } from '@/core/contracts/terrain';
import { DEG, G0 } from '@/core/math/scalar';
import { v3 } from '@/core/math/vec3';
import { active, controls, flatTerrain, loadLibrary, makeSim, orbitScenario, stepUntil } from './helpers';

let defs: DefLibrary;
let terrain: TerrainProvider;
beforeAll(async () => {
  defs = await loadLibrary();
  terrain = flatTerrain(defs, { earth: 21.62, moon: -1900 });
});

const steps = (sim: Sim, seconds: number): void => {
  for (let i = 0; i < Math.round(seconds / PHYSICS_DT); i++) sim.step();
};
const pointingError = (s: SimSnapshot): number => (s.navball.markers.maneuver ? Math.acos(Math.max(-1, Math.min(1, s.navball.markers.maneuver.y))) : Math.PI);

describe('maneuver nodes', () => {
  it('add, edit, burn bookkeeping and automatic completion', async () => {
    const sim = await makeSim(defs, 'qa-leo', terrain);
    const s0 = sim.peek();
    expect(s0.nodes).toHaveLength(0);
    expect(s0.readouts.sasModesAvailable).not.toContain('maneuver');
    expect(sim.commands.setSasMode('maneuver').ok).toBe(false);
    const id = sim.commands.addNode(s0.simUt + 400);
    expect(sim.commands.setNode(id, { dv: { prograde: 60, normal: 8 } }).ok).toBe(true);
    expect(sim.commands.setNode('nope', { ut: 1 }).ok).toBe(false);
    let s = sim.peek();
    expect(s.nodes).toEqual([{ id, ut: s0.simUt + 400, dv: { prograde: 60, normal: 8, radial: 0 } }]);
    expect(s.readouts.sasModesAvailable).toContain('maneuver');
    // Planned patches start at the node; the current trajectory carries its marker.
    expect(s.patches.planned[0]!.tStart).toBeCloseTo(s0.simUt + 400, 6);
    expect(s.patches.planned[0]!.afterNodeId).toBe(id);
    expect(s.patches.current[0]!.markers.some((m) => m.kind === 'maneuverNode' && m.nodeId === id)).toBe(true);
    const nb = s.readouts.nodeBurn!;
    expect(nb.nodeId).toBe(id);
    expect(nb.dvRemainingMag).toBeCloseTo(Math.hypot(60, 8), 6);
    // Burn time by the rocket equation with the armed Vela-2V (1 MN, 452 s).
    const ve = 452 * G0;
    const expected = ((s.readouts.mass - s.readouts.mass * Math.exp(-nb.dvRemainingMag / ve)) * ve) / 1e6;
    expect(nb.burnTime!).toBeCloseTo(expected, 3);
    expect(nb.timeToBurnStart!).toBeCloseTo(400 - expected / 2, 3);
    expect(nb.insufficientDeltaV).toBe(false);
    expect(s.navball.markers.maneuver).not.toBeNull();
    // Hold the maneuver marker and fly the burn by hand.
    sim.commands.setSasEnabled(true);
    sim.commands.setRcsEnabled(true);
    expect(sim.commands.setSasMode('maneuver').ok).toBe(true);
    expect(stepUntil(sim, (x) => pointingError(x) < 0.5 * DEG, 120 * 200)).toBeGreaterThan(0);
    sim.commands.setWarpLevel(5);
    while ((sim.peek().readouts.nodeBurn!.timeToBurnStart ?? 0) > 31 && sim.peek().warp.index > 3) sim.advance(1 / 60);
    // Warp stopped by itself at the node's lead time.
    expect(sim.peek().readouts.nodeBurn!.timeToBurnStart!).toBeGreaterThan(29.5);
    expect(stepUntil(sim, (x) => (x.readouts.nodeBurn?.timeToBurnStart ?? 0) <= 0, 120 * 60)).toBeGreaterThan(0);
    sim.setControls(controls({ throttle: 1 }));
    let last = Infinity;
    let decreasing = true;
    let cut = false;
    // The remaining delta-v falls while the engine thrusts (the thrusters that hold the attitude are counted
    // too: a few 1e-6 m/s either way once the engine is off).
    const done = stepUntil(
      sim,
      (x) => {
        const b = x.readouts.nodeBurn;
        if (!b) return true;
        if (!cut && b.dvRemainingMag > last + 1e-9) decreasing = false;
        last = b.dvRemainingMag;
        if (b.dvRemainingMag < 4 && !cut) {
          cut = true;
          sim.setControls(controls({ throttle: 0 }));
        }
        return cut && x.readouts.thrust < 5000;
      },
      120 * 60,
    );
    expect(done).toBeGreaterThan(0);
    sim.setControls(controls());
    steps(sim, 2);
    s = sim.peek();
    expect(decreasing).toBe(true);
    expect(last).toBeLessThan(4);
    expect(last).toBeGreaterThan(0.5);
    // Throttle cut with a few m/s to go: the node stays until it is finished or removed.
    expect(s.nodes).toHaveLength(1);
    expect(s.readouts.nodeBurn!.dvRemainingMag).toBeCloseTo(last, 2);
    expect(sim.commands.removeNode(id).ok).toBe(true);
    expect(sim.commands.removeNode(id).ok).toBe(false);
    expect(sim.peek().nodes).toHaveLength(0);
    expect(sim.peek().readouts.sasMode).not.toBe('maneuver');
    // The orbit really changed by about the planned amount.
    expect(sim.peek().readouts.apoapsisAltitude).toBeGreaterThan(s0.readouts.apoapsisAltitude + 100000);
  });

  it('a node flown to within 0.1 m/s completes by itself and is announced', async () => {
    const sim = await makeSim(defs, 'qa-lunar-orbit', terrain);
    const s0 = sim.peek();
    const id = sim.commands.addNode(s0.simUt + 90);
    sim.commands.setNode(id, { dv: { prograde: -3 } });
    sim.commands.setSasEnabled(true);
    sim.commands.setRcsEnabled(true);
    sim.commands.setSasMode('maneuver');
    stepUntil(sim, (x) => (x.readouts.nodeBurn?.timeToBurnStart ?? 0) <= 0 && pointingError(x) < 1 * DEG, 120 * 200);
    // Finish on the thrusters, along the marker.
    const fin = stepUntil(
      sim,
      (x) => {
        const m = x.navball.markers.maneuver;
        if (!m || !x.readouts.nodeBurn) return true;
        sim.setControls(controls({ translate: { x: m.x, y: m.y, z: m.z } }));
        return false;
      },
      120 * 400,
    );
    expect(fin).toBeGreaterThan(0);
    sim.setControls(controls());
    const s = sim.peek();
    expect(s.nodes).toHaveLength(0);
    expect(s.events.some((e) => e.type === 'nodeCompleted' && e.nodeId === id)).toBe(true);
    expect(s.readouts.sasMode).toBe('stability');
    expect(s.readouts.rcsFraction!).toBeLessThan(1);
  });
});

describe('commands and read-outs', () => {
  it('target, navball mode, lights, fine control, legs, staging lock-out', async () => {
    const sim = await makeSim(defs, 'qa-lunar-orbit', terrain);
    let s = sim.peek();
    expect(s.readouts.targetBodyId).toBe('moon');
    expect(sim.commands.setTarget('nowhere').ok).toBe(false);
    expect(sim.commands.setTarget(null).ok).toBe(true);
    expect(sim.peek().readouts.targetBodyId).toBeNull();
    expect(sim.peek().navball.markers.target).toBeNull();
    expect(sim.commands.setTarget('earth').ok).toBe(true);
    expect(sim.peek().navball.markers.target).not.toBeNull();
    // 100 km over the Moon is above the 20 km switch altitude: orbit mode, and a manual choice sticks.
    expect(s.navball.mode).toBe('orbit');
    sim.commands.setNavballMode('surface');
    steps(sim, 1);
    expect(sim.peek().navball.mode).toBe('surface');
    sim.commands.toggleLights();
    sim.commands.setFineControl(true);
    s = sim.peek();
    expect(s.readouts.lightsOn).toBe(true);
    expect(s.readouts.fineControl).toBe(true);
    expect(s.readouts.legsDeployed).toBe(false);
    expect(sim.commands.toggleLegs().ok).toBe(true);
    expect(sim.peek().readouts.legsDeployed).toBe(true);
    expect(sim.peek().events.some((e) => e.type === 'legsToggled' && e.deployed)).toBe(true);
    // The stage button: gear (already down: a harmless press), then locked out for half a second.
    expect(sim.commands.stage().ok).toBe(true);
    expect(sim.peek().staging.lockout).toBe(true);
    expect(sim.commands.stage().ok).toBe(false);
    steps(sim, 1);
    expect(sim.peek().staging.lockout).toBe(false);
    expect(sim.commands.cycleActiveVessel(1).ok).toBe(false);
    expect(sim.peek().staging.stages).toHaveLength(10);
    expect(sim.peek().staging.stages[4]!.deltaVVac).toBeGreaterThan(3000);
  });

  it('the navball switches mode by itself when the switch altitude is crossed', async () => {
    const sim = await makeSim(defs, 'lunar-direct', terrain);
    expect(sim.peek().navball.mode).toBe('surface');
    sim.commands.setSasEnabled(true);
    sim.setControls(controls({ throttle: 1 }));
    sim.commands.stage();
    expect(stepUntil(sim, (s) => s.readouts.altitudeAsl > 64000, 120 * 200)).toBeGreaterThan(0);
    expect(sim.peek().navball.mode).toBe('orbit');
    // MET runs from the release of the clamps.
    expect(sim.peek().readouts.met).toBeGreaterThan(60);
  });

  it('the debug API changes state and is counted as cheating', async () => {
    const sim = await makeSim(defs, orbitScenario(defs.scenarios['lunar-direct']!, 't-debug', 'earth', 300000, 300000, 5), terrain);
    expect(sim.cheatCounter).toBe(0);
    const s0 = sim.peek();
    const v = active(s0);
    sim.debug.setResource(v.id, 'descent-stage', 'LOX', 1000);
    expect(sim.cheatCounter).toBe(1);
    expect(active(sim.peek()).parts.find((p) => p.instanceId === 'descent-stage')!.resources['LOX']).toBe(1000);
    sim.debug.setVesselState(v.id, 'moon', { x: 1837400, y: 0, z: 0 }, { x: 0, y: 1633, z: 0 });
    expect(sim.cheatCounter).toBe(2);
    let s = sim.peek();
    expect(active(s).bodyId).toBe('moon');
    expect(s.readouts.altitudeAsl).toBeGreaterThan(90000);
    expect(s.readouts.altitudeAsl).toBeLessThan(110000);
    sim.debug.setUt(s.simUt + 1000);
    expect(sim.cheatCounter).toBe(3);
    s = sim.peek();
    expect(s.simUt).toBe(s0.simUt + 1000);
    expect(s.cheatCounter).toBe(3);
    expect(() => sim.debug.setResource('nobody', 'x', 'LOX', 1)).toThrow();
  });

  it('the state hash is the same for the same calls and differs after any difference', async () => {
    const make = () => makeSim(defs, 'qa-leo', terrain);
    const a = await make();
    const b = await make();
    const c = await make();
    expect(a.stateHash()).toBe(b.stateHash());
    for (const sim of [a, b]) {
      sim.commands.setSasEnabled(true);
      sim.setControls(controls({ throttle: 1, yaw: 0.2 }));
      steps(sim, 3);
      sim.setControls(controls());
      steps(sim, 2);
    }
    c.commands.setSasEnabled(true);
    c.setControls(controls({ throttle: 1, yaw: 0.2 }));
    steps(c, 3);
    c.setControls(controls({ throttle: 0.001 }));
    steps(c, 2);
    expect(a.stateHash()).toBe(b.stateHash());
    expect(a.stateHash()).not.toBe(c.stateHash());
    const before = a.stateHash();
    // Reading never changes the state.
    a.peek();
    a.snapshot();
    expect(a.stateHash()).toBe(before);
    a.step();
    expect(a.stateHash()).not.toBe(before);
  });

  it('snapshot() drains the event queue once; peek() leaves it', async () => {
    const sim = await makeSim(defs, 'qa-lunar-orbit', terrain);
    sim.commands.toggleLegs();
    expect(sim.peek().events.some((e) => e.type === 'legsToggled')).toBe(true);
    expect(sim.peek().events.some((e) => e.type === 'legsToggled')).toBe(true);
    const first = sim.snapshot();
    expect(first.events.some((e) => e.type === 'legsToggled')).toBe(true);
    expect(sim.snapshot().events).toHaveLength(0);
    expect(sim.peek().events).toHaveLength(0);
    // Snapshots are independent objects: a consumer keeping one is not affected by the next.
    const kept = sim.peek();
    const r = { ...active(kept).r };
    steps(sim, 1);
    expect(active(kept).r).toEqual(r);
    expect(active(sim.peek()).r).not.toEqual(r);
  });
});

describe('mission state and the vessel list', () => {
  it('losing the crew fails the mission and says why', async () => {
    // The capsule under drogues alone: without the mains the water impact is fatal.
    const sim = await makeSim(defs, 'qa-drogues', flatTerrain(defs, { earth: -3000 }));
    const hit = stepUntil(sim, (s) => s.mission.failed, 120 * 400);
    expect(hit).toBeGreaterThan(0);
    const s = sim.peek();
    expect(s.mission.failed).toBe(true);
    expect(s.mission.failureReason).toBeTruthy();
    expect(s.events.some((e) => e.type === 'missionFailed')).toBe(true);
    // The simulation goes on (the player watches the wreck).
    const t = s.simUt;
    steps(sim, 2);
    expect(sim.peek().simUt).toBeGreaterThan(t);
    expect(Number.isFinite(sim.peek().readouts.altitudeAsl)).toBe(true);
  });

  it('staging leaves debris vessels: full fidelity nearby, on rails or reduced far away, removed at impact', async () => {
    const sim = await makeSim(defs, 'lunar-direct', terrain);
    sim.commands.setSasEnabled(true);
    sim.setControls(controls({ throttle: 1 }));
    sim.commands.stage();
    steps(sim, 5);
    let s = sim.peek();
    // The clamps stay behind as a vessel fixed to the ground.
    expect(s.vessels).toHaveLength(2);
    const clamps = s.vessels.find((v) => v.id !== s.activeVesselId)!;
    expect(clamps.situation).toBe('landed');
    expect(clamps.translationMode).toBe('landed');
    expect(clamps.controllable).toBe(false);
    // Straight up to burnout, then separate: the first stage is a full-fidelity vessel next to the stack.
    stepUntil(sim, (x) => x.readouts.met > 30 && x.readouts.thrust < 1e6, 120 * 200);
    sim.commands.stage();
    steps(sim, 6);
    s = sim.peek();
    const m1 = s.vessels.find((v) => v.parts.some((p) => p.def === 'meridian-m1'))!;
    expect(m1).toBeDefined();
    expect(m1.tier).toBe('full');
    expect(m1.controllable).toBe(false);
    expect(v3.dist(m1.r, active(s).r)).toBeLessThan(2000);
    expect(s.events.some((e) => e.type === 'decoupled')).toBe(true);
    // By now the clamps are far below: beyond the bubble they are no longer stepped.
    expect(s.vessels.find((v) => v.id === clamps.id)!.tier).toBe('rails');
    // The second stage pulls away; the spent stage falls back and is removed when it hits.
    const gone = stepUntil(sim, (x) => !x.vessels.some((v) => v.id === m1.id), 120 * 900);
    expect(gone).toBeGreaterThan(0);
    const fate = sim.debrisLog().find((f) => f.vesselId === m1.id)!;
    expect(fate.reason === 'impact' || fate.reason === 'burnedUp').toBe(true);
    expect(sim.peek().events.some((e) => e.type === 'vesselRemoved' && e.vesselId === m1.id)).toBe(true);
    expect(sim.peek().mission.failed).toBe(false);
  });
});
