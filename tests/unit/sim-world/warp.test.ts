/**
 * Time warp: the rails advance never passes an event - at 100 000x toward the Moon, falling back to the
 * Earth, and toward a maneuver node several revolutions ahead - altitude limits step the level down,
 * control input drops rails warp, a rotating vessel is refused, and the attitude is frozen or tracks the
 * SAS hold direction while on rails.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { DefLibrary } from '@/core/contracts/defs';
import { MAX_PHYSICS_WARP_INDEX, WARP_LEVELS } from '@/core/contracts/defs';
import type { Sim } from '@/core/contracts/sim';
import type { TerrainProvider } from '@/core/contracts/terrain';
import { quat } from '@/core/math/quat';
import { DEG } from '@/core/math/scalar';
import { v3 } from '@/core/math/vec3';
import { warpAltitudeLimit } from '@/sim/orbit';
import { active, controls, flatTerrain, loadLibrary, makeSim, orbitScenario } from './helpers';

let defs: DefLibrary;
let terrain: TerrainProvider;
beforeAll(async () => {
  defs = await loadLibrary();
  terrain = flatTerrain(defs, { earth: -100, moon: 0 });
});

const TOP = WARP_LEVELS.length - 1;
/** The look-ahead allows a level only while the event is at least 4 s of real time away: 10 000x is the highest a two-day leg admits. */
const HIGH = WARP_LEVELS.indexOf(10000);

/** One frame of a player holding the warp key down: ask for the top level, advance a 60 Hz frame. */
function frame(sim: Sim): void {
  sim.commands.setWarpLevel(TOP);
  sim.advance(1 / 60);
}

describe('warp never passes an event', () => {
  it('with the top level requested toward the Moon (10 000x by the look-ahead): SOI entry exactly, then the level steps down with the altitude limits', async () => {
    const sim = await makeSim(defs, 'qa-translunar', terrain);
    const predicted = sim.peek().patches.current[0]!.tEnd;
    let sawHigh = false;
    let entered = false;
    let minAltitudeOnRails = Infinity;
    for (let i = 0; i < 200000; i++) {
      const before = sim.peek();
      const eventUt = sim.nextEventUt;
      frame(sim);
      const s = sim.peek();
      const v = active(s);
      if (s.warp.index >= HIGH) sawHigh = true;
      // The advance stops at the event; it is never jumped.
      if (s.warp.onRails) expect(s.simUt).toBeLessThanOrEqual(Math.max(eventUt, before.simUt) + 1e-6);
      if (!entered && v.bodyId === 'moon') {
        entered = true;
        expect(Math.abs(s.simUt - predicted)).toBeLessThan(1e-3 + 1e-9 * predicted);
        // Across the SOI change warp is held to 50x at most.
        expect(s.warp.index).toBeLessThanOrEqual(WARP_LEVELS.indexOf(50));
      }
      if (v.bodyId === 'moon' && s.warp.onRails) {
        // Never on rails below the altitude limit of the level in use.
        const limit = warpAltitudeLimit(defs.bodies['moon']!, s.warp.index);
        if (limit !== null) expect(s.readouts.altitudeAsl).toBeGreaterThanOrEqual(limit - 1);
        minAltitudeOnRails = Math.min(minAltitudeOnRails, s.readouts.altitudeAsl);
      }
      // Past the perilune and climbing again: done.
      if (entered && s.readouts.verticalSpeed > 0 && s.readouts.altitudeAsl > 2e5) break;
      expect(s.mission.failed).toBe(false);
    }
    expect(sawHigh).toBe(true);
    expect(entered).toBe(true);
    // The arrival passes about 100 km over the Moon; it was followed down without ever being overrun.
    expect(minAltitudeOnRails).toBeLessThan(2e5);
    expect(minAltitudeOnRails).toBeGreaterThan(5e4);
  });

  it('falling back to the Earth with the top level requested: rails end exactly at the top of the atmosphere', async () => {
    const sim = await makeSim(defs, 'qa-trans-earth', terrain);
    const simTop = defs.bodies['earth']!.atmosphere!.simTop;
    let sawHigh = false;
    let integratedAt = NaN;
    for (let i = 0; i < 300000; i++) {
      frame(sim);
      const s = sim.peek();
      const v = active(s);
      if (s.warp.index >= HIGH) sawHigh = true;
      if (v.translationMode === 'rails') {
        expect(s.readouts.altitudeAsl).toBeGreaterThanOrEqual(simTop - 0.5);
        const limit = warpAltitudeLimit(defs.bodies['earth']!, s.warp.index);
        if (limit !== null && s.warp.onRails) expect(s.readouts.altitudeAsl).toBeGreaterThanOrEqual(limit - 1);
      } else {
        integratedAt = s.readouts.altitudeAsl;
        break;
      }
    }
    expect(sawHigh).toBe(true);
    // Integration takes over at the atmosphere boundary (within the travel of a physics step).
    expect(integratedAt).toBeLessThanOrEqual(simTop + 1);
    expect(integratedAt).toBeGreaterThan(simTop - 200);
    expect(sim.peek().warp.index).toBeLessThanOrEqual(MAX_PHYSICS_WARP_INDEX);
    expect(sim.needsIntegration).toBe(true);
  });

  it('falling through the altitude limits costs one level at a time: no level is taken away by the shell of a higher one', async () => {
    // Top level requested all the way down from 320 000 km: 10 000x, then each lower level once, in order.
    const top = await makeSim(defs, 'qa-trans-earth', terrain);
    const seen: number[] = [];
    let frames = 0;
    for (; frames < 300000; frames++) {
      frame(top);
      const s = top.peek();
      if (seen[seen.length - 1] !== s.warp.index) seen.push(s.warp.index);
      if (active(s).translationMode !== 'rails') break;
    }
    const rails = seen.filter((i) => i > MAX_PHYSICS_WARP_INDEX);
    expect(rails).toEqual([HIGH, HIGH - 1, HIGH - 2, HIGH - 3, HIGH - 4, HIGH - 5]);
    // Each step down waits out its four seconds of look-ahead at the level above: 65 hours in about two minutes.
    expect(frames).toBeLessThan(8000);
    // A player who comes down at 100x keeps it through the shells of the levels above (30 000 km and 6 000 km).
    const held = await makeSim(defs, 'qa-trans-earth', terrain);
    while (held.peek().readouts.altitudeAsl > 4e7) frame(held);
    const level = WARP_LEVELS.indexOf(100);
    const ownShell = warpAltitudeLimit(defs.bodies['earth']!, level)!;
    const higherShell = warpAltitudeLimit(defs.bodies['earth']!, level + 2)!;
    let lowest = Infinity;
    for (let i = 0; i < 300000; i++) {
      held.commands.setWarpLevel(level);
      held.advance(1 / 60);
      const s = held.peek();
      if (s.warp.index !== level) break;
      lowest = s.readouts.altitudeAsl;
    }
    // It is given up only for its own shell (250 km), four seconds of real time ahead of it.
    expect(higherShell).toBe(6e6);
    expect(lowest).toBeLessThan(higherShell - 5e5);
    expect(lowest).toBeGreaterThan(ownShell);
    expect(held.peek().warp.index).toBe(level - 1);
    expect(held.peek().warp.limitedBy).toMatch(/altitude/i);
  });

  it('a node 3.4 revolutions ahead: warp stops at its lead time, the planned trajectory is never lost', async () => {
    const sim = await makeSim(defs, orbitScenario(defs.scenarios['lunar-direct']!, 't-node', 'earth', 300000, 320000, 4), terrain);
    const s0 = sim.peek();
    const period = s0.readouts.period!;
    const nodeUt = s0.simUt + 3.4 * period;
    const id = sim.commands.addNode(nodeUt);
    sim.commands.setNode(id, { dv: { prograde: 120 } });
    const s1 = sim.peek();
    expect(s1.patches.planned.length).toBeGreaterThan(0);
    expect(s1.patches.planned[0]!.tStart).toBeCloseTo(nodeUt, 6);
    expect(s1.patches.planned[0]!.afterNodeId).toBe(id);
    // The current patch is followed to the node over several revolutions.
    const cur = s1.patches.current[0]!;
    expect(cur.endReason).toBe('maneuver');
    expect(cur.nuEnd - cur.nuStart).toBeGreaterThan(3 * 2 * Math.PI);
    const burn = s1.readouts.nodeBurn!;
    expect(burn.burnTime).toBeGreaterThan(5);
    const lead = nodeUt - burn.burnTime! / 2 - 30;
    let stoppedAt = NaN;
    for (let i = 0; i < 200000; i++) {
      frame(sim);
      const s = sim.peek();
      expect(s.nodes).toHaveLength(1);
      expect(s.patches.planned.length).toBeGreaterThan(0);
      if (s.warp.onRails) expect(s.simUt).toBeLessThanOrEqual(lead + 1e-6);
      if (s.simUt >= lead - 1e-6) {
        stoppedAt = s.simUt;
        break;
      }
    }
    expect(stoppedAt).toBeGreaterThanOrEqual(lead - 1e-6);
    expect(stoppedAt).toBeLessThan(lead + 0.2);
    // From the lead time on only physics warp is offered.
    const res = sim.commands.setWarpLevel(TOP);
    const s = sim.peek();
    expect(s.warp.index).toBeLessThanOrEqual(MAX_PHYSICS_WARP_INDEX);
    expect(res.ok && s.warp.index > MAX_PHYSICS_WARP_INDEX).toBe(false);
    expect(s.warp.limitedBy).toMatch(/node/i);
  });
});

describe('warp at 100 000x', () => {
  it('a node three revolutions ahead on a 15-day orbit is reached at 100 000x and never overrun', async () => {
    const sim = await makeSim(defs, orbitScenario(defs.scenarios['lunar-direct']!, 't-node-far', 'earth', 2.5e8, 2.5e8, 5), terrain);
    const s0 = sim.peek();
    const period = s0.readouts.period!;
    expect(period).toBeGreaterThan(12 * 86400);
    const nodeUt = s0.simUt + 3.2 * period;
    const id = sim.commands.addNode(nodeUt);
    sim.commands.setNode(id, { dv: { prograde: -40 } });
    const burn = sim.peek().readouts.nodeBurn!;
    const lead = nodeUt - burn.burnTime! / 2 - 30;
    let framesAtTop = 0;
    let frames = 0;
    for (; frames < 100000; frames++) {
      frame(sim);
      const s = sim.peek();
      if (s.warp.index === TOP) framesAtTop++;
      expect(s.simUt).toBeLessThanOrEqual(lead + 1e-6 + (s.warp.onRails ? 0 : 1));
      expect(s.patches.planned[0]!.tStart).toBeCloseTo(nodeUt, 5);
      if (s.simUt >= lead - 1e-6) break;
    }
    // 48 days in a few thousand frames, most of them at the top level, the last ones stepping down.
    expect(framesAtTop).toBeGreaterThan(1000);
    expect(frames).toBeLessThan(20000);
    const s = sim.peek();
    expect(s.simUt).toBeGreaterThanOrEqual(lead - 1e-6);
    expect(s.simUt).toBeLessThan(lead + 0.2);
    expect(s.warp.index).toBeLessThanOrEqual(MAX_PHYSICS_WARP_INDEX);
    // Rails propagation from the epoch state: no drift after three revolutions at 100 000x.
    const v = active(s);
    expect(Math.abs(v3.len(v.r) - (defs.bodies['earth']!.radius + 2.5e8))).toBeLessThan(50);
  });
});

describe('warp rules', () => {
  it('rails levels respect the altitude limits of the body', async () => {
    const sim = await makeSim(defs, orbitScenario(defs.scenarios['lunar-direct']!, 't-alt', 'earth', 185000, 190000, 4), terrain);
    sim.commands.setWarpLevel(TOP);
    const s = sim.peek();
    // 185 km: 50x needs 160 km, 100x needs 250 km.
    expect(WARP_LEVELS[s.warp.index]).toBe(50);
    expect(s.warp.maxIndex).toBe(s.warp.index);
    expect(s.warp.limitedBy).toMatch(/altitude/i);
  });

  it('control input, throttle and staging drop rails warp to 1x', async () => {
    const sim = await makeSim(defs, orbitScenario(defs.scenarios['lunar-direct']!, 't-drop', 'earth', 300000, 320000, 4), terrain);
    sim.commands.setWarpLevel(5);
    sim.advance(1 / 60);
    expect(sim.peek().warp.index).toBe(5);
    sim.setControls(controls({ pitch: 0.2 }));
    expect(sim.peek().warp.index).toBe(0);
    sim.setControls(controls());
    // The stack now has a little rate: stop it with the SAS, then warp again.
    sim.commands.setSasEnabled(true);
    sim.commands.setRcsEnabled(true);
    for (let i = 0; i < 120 * 30; i++) sim.step();
    expect(sim.commands.setWarpLevel(5).ok).toBe(true);
    sim.advance(1 / 60);
    expect(sim.peek().warp.index).toBe(5);
    sim.setControls(controls({ throttle: 0.4 }));
    expect(sim.peek().warp.index).toBe(0);
    sim.setControls(controls());
    for (let i = 0; i < 120 * 3; i++) sim.step();
    sim.commands.setWarpLevel(5);
    if (sim.peek().warp.index === 5) {
      sim.commands.stage();
      expect(sim.peek().warp.index).toBe(0);
    }
    const reasons = sim
      .peek()
      .events.filter((e) => e.type === 'warpChanged')
      .map((e) => (e.type === 'warpChanged' ? e.reason : null));
    expect(reasons).toContain('Control input');
  });

  it('a rotating vessel is refused rails warp', async () => {
    const sim = await makeSim(defs, orbitScenario(defs.scenarios['lunar-direct']!, 't-rot', 'earth', 300000, 320000, 4), terrain);
    sim.commands.setRcsEnabled(true);
    sim.setControls(controls({ yaw: 1 }));
    for (let i = 0; i < 120 * 20; i++) sim.step();
    sim.setControls(controls());
    sim.step();
    expect(v3.len(active(sim.peek()).w)).toBeGreaterThan(0.5 * DEG);
    const res = sim.commands.setWarpLevel(6);
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/rotating/i);
    expect(sim.peek().warp.index).toBeLessThanOrEqual(MAX_PHYSICS_WARP_INDEX);
    // Physics warp is always allowed.
    expect(sim.commands.setWarpLevel(3).ok).toBe(true);
    expect(sim.peek().warp.index).toBe(3);
  });

  it('attitude on rails: frozen in inertial space, or tracking the SAS hold direction', async () => {
    const base = orbitScenario(defs.scenarios['lunar-direct']!, 't-att', 'earth', 300000, 320000, 4);
    // Frozen: no SAS direction mode.
    const frozen = await makeSim(defs, base, terrain);
    const q0 = active(frozen.peek()).q;
    const t0 = frozen.peek().simUt;
    while (frozen.peek().simUt < t0 + 1400) {
      frozen.commands.setWarpLevel(6);
      frozen.advance(1 / 60);
    }
    const q1 = active(frozen.peek()).q;
    expect(quat.angleBetween(q0, q1)).toBeLessThan(1e-9);
    // Tracking: SAS prograde, aligned when the warp starts. A quarter of a revolution later the nose is
    // still on the prograde marker although the prograde direction has turned by ninety degrees.
    const track = await makeSim(defs, { ...base, id: 't-att-track' }, terrain);
    track.commands.setSasEnabled(true);
    track.commands.setRcsEnabled(true);
    track.commands.setSasMode('prograde');
    for (let i = 0; i < 120 * 60; i++) track.step();
    const err = (sim: Sim): number => Math.acos(Math.max(-1, Math.min(1, sim.peek().navball.markers.prograde.y)));
    expect(err(track)).toBeLessThan(2 * DEG);
    const nose0 = quat.rotate(active(track.peek()).q, { x: 0, y: 1, z: 0 });
    const tStart = track.peek().simUt;
    const quarter = track.peek().readouts.period! / 4;
    while (track.peek().simUt < tStart + quarter) {
      track.commands.setWarpLevel(6);
      track.advance(1 / 60);
    }
    const nose1 = quat.rotate(active(track.peek()).q, { x: 0, y: 1, z: 0 });
    expect(v3.angle(nose0, nose1) / DEG).toBeGreaterThan(80);
    expect(err(track)).toBeLessThan(2 * DEG);
    expect(v3.len(active(track.peek()).w)).toBe(0);
  });

  it('a vessel on the pad can warp at any level and rides the Earth exactly', async () => {
    const sim = await makeSim(defs, 'lunar-direct', flatTerrain(defs, { earth: 21.62 }));
    const s0 = sim.peek();
    expect(active(s0).situation).toBe('prelaunch');
    expect(sim.commands.setWarpLevel(8).ok).toBe(true);
    for (let i = 0; i < 30; i++) sim.advance(1 / 60);
    const s = sim.peek();
    expect(s.simUt - s0.simUt).toBeCloseTo(30 * (1000 / 60), 4);
    expect(s.readouts.speedSurface).toBeLessThan(1e-6);
    expect(s.readouts.latitude).toBeCloseTo(s0.readouts.latitude, 10);
    expect(s.readouts.longitude).toBeCloseTo(s0.readouts.longitude, 10);
    expect(s.readouts.launchWindow!.timeToPlaneCrossing).toBeCloseTo(s0.readouts.launchWindow!.timeToPlaneCrossing - 500, 3);
  });
});
