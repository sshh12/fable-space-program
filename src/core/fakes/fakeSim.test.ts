import { describe, expect, it } from 'vitest';
import { NEUTRAL_CONTROLS } from '../contracts/controls';
import type { DefLibrary } from '../contracts/defs';
import { fsDefSource } from '../defs/fsSource';
import { loadDefs } from '../defs/loader';
import { conicPosition } from '../math/conic';
import { quat } from '../math/quat';
import { v3 } from '../math/vec3';
import { createFakeSim, type FakeScene } from './fakeSim';

const SCENES: FakeScene[] = ['pad', 'ascent', 'lowOrbit', 'translunar', 'lunarOrbit', 'lunarSurface', 'reentry', 'chutes'];

function allFinite(value: unknown, path = 'snapshot'): void {
  if (typeof value === 'number') {
    if (Number.isNaN(value)) throw new Error(`NaN at ${path}`);
    return;
  }
  if (Array.isArray(value)) value.forEach((v, i) => allFinite(v, `${path}[${i}]`));
  else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) allFinite(v, `${path}.${k}`);
}

describe('FakeSim', () => {
  let defs: DefLibrary;
  it('loads definitions', async () => {
    defs = await loadDefs(fsDefSource());
  });

  it.each(SCENES)('scene %s yields a consistent snapshot', (scene) => {
    const sim = createFakeSim(defs, { scene });
    sim.setControls({ ...NEUTRAL_CONTROLS, translate: v3.zero(), throttle: 0.7, pitch: 0.2 });
    for (let i = 0; i < 120; i++) sim.advance(1 / 60);
    const s = sim.snapshot();
    allFinite(s);
    expect(s.bodies.map((b) => b.id).sort()).toEqual(['earth', 'moon', 'sun']);
    const v = s.vessels[0]!;
    const body = s.bodies.find((b) => b.id === v.bodyId)!;
    expect(v3.dist(v.rRoot, v3.add(body.rRoot, v.r))).toBeLessThan(1e-3);
    expect(Math.hypot(v.q.x, v.q.y, v.q.z, v.q.w)).toBeCloseTo(1, 9);
    // navball markers are unit vectors in the vessel frame and opposite pairs cancel
    const m = s.navball.markers;
    expect(v3.len(m.prograde)).toBeCloseTo(1, 9);
    expect(v3.len(v3.add(m.prograde, m.retrograde))).toBeLessThan(1e-9);
    expect(Math.abs(v3.dot(m.prograde, m.normal))).toBeLessThan(1e-9);
    // horizon frame: the vessel nose pitch agrees with qVesselToHorizon (+Z up in the horizon frame)
    const noseHorizon = quat.rotate(s.navball.qVesselToHorizon, v3.unitY());
    expect(Math.asin(noseHorizon.z) * (180 / Math.PI)).toBeCloseTo(s.navball.pitchDeg, 6);
    expect(s.readouts.throttle).toBe(0.7);
    expect(s.cheatCounter).toBe(0);
    expect(s.scenario.startKind).toBe('state');
  });

  it('moves along its orbit, draws a closed patch through the vessel and supports node editing', () => {
    const sim = createFakeSim(defs, { scene: 'lowOrbit' });
    const a = sim.snapshot();
    sim.commands.setWarpLevel(6);
    for (let i = 0; i < 60; i++) sim.advance(1 / 60);
    const b = sim.snapshot();
    expect(b.ut - a.ut).toBeCloseTo(50, 4);
    expect(v3.dist(a.vessels[0]!.r, b.vessels[0]!.r)).toBeGreaterThan(300e3);
    const patch = b.patches.current[0]!;
    expect(patch.endReason).toBe('closed');
    expect(v3.dist(conicPosition(patch.conic, patch.nuStart), b.vessels[0]!.r)).toBeLessThan(1);
    expect(b.readouts.apoapsisAltitude).toBeCloseTo(200e3, -2);

    const id = sim.commands.addNode(b.ut + 600);
    expect(sim.commands.setNode(id, { dv: { prograde: 120 } }).ok).toBe(true);
    const c = sim.snapshot();
    expect(c.nodes).toHaveLength(1);
    expect(c.patches.planned[0]!.afterNodeId).toBe(id);
    expect(c.patches.planned[0]!.conic.e).toBeGreaterThan(0.01);
    expect(c.readouts.nodeBurn?.dvRemainingMag).toBeCloseTo(120, 9);
    expect(c.navball.markers.maneuver).not.toBeNull();
    expect(sim.commands.setSasMode('maneuver').ok).toBe(true);
    expect(sim.commands.removeNode(id).ok).toBe(true);
    expect(sim.snapshot().patches.planned).toHaveLength(0);
  });

  it('landed vessels ride the rotating body and refuse rails warp under thrust', () => {
    const sim = createFakeSim(defs, { scene: 'pad' });
    const s0 = sim.snapshot();
    expect(s0.vessels[0]!.situation).toBe('prelaunch');
    expect(s0.readouts.speedSurface).toBeLessThan(1e-6);
    expect(s0.readouts.speedOrbital).toBeGreaterThan(400);
    expect(s0.readouts.speedOrbital).toBeLessThan(470);
    expect(s0.readouts.latitude * (180 / Math.PI)).toBeCloseTo(19.1, 6);
    expect(s0.readouts.longitude * (180 / Math.PI)).toBeCloseTo(-155.5, 6);
    sim.setControls({ ...NEUTRAL_CONTROLS, translate: v3.zero(), throttle: 1 });
    expect(sim.commands.setWarpLevel(8).ok).toBe(false);
    expect(sim.commands.stage().ok).toBe(true);
    const snap = sim.snapshot();
    expect(snap.warp.index).toBe(3);
    const events = snap.events.map((e) => e.type);
    expect(events).toContain('stageFired');
    expect(events).toContain('warpChanged');
    expect(sim.snapshot().events).toHaveLength(0);
  });

  it('reports surface targets, landing-target navigation and the presentation/simulation times', async () => {
    const sim = createFakeSim(defs, { scene: 'lunarOrbit' });
    await sim.ready;
    expect(sim.terrainPending()).toBeNull();
    for (let i = 0; i < 30; i++) sim.advance(1 / 144);
    const s = sim.snapshot();
    expect(s.simUt).toBe(s.ut);
    expect(s.terrain).toEqual({ complete: true, pending: false, incompleteQueries: 0 });
    expect(s.surfaceTargets.map((t) => t.kind).sort()).toEqual(['landing', 'recovery', 'recovery', 'recovery', 'site']);
    const lt = s.readouts.landingTarget!;
    expect(lt.targetId).toBe('landing');
    // distance is the great-circle arc between the sub-point and the target on the reference sphere
    const target = s.surfaceTargets.find((t) => t.id === 'landing')!;
    const a = { lat: s.readouts.latitude, lon: s.readouts.longitude };
    const central = Math.acos(
      Math.sin(a.lat) * Math.sin(target.latitude) + Math.cos(a.lat) * Math.cos(target.latitude) * Math.cos(a.lon - target.longitude),
    );
    expect(lt.distance).toBeCloseTo(central * 1737400, 0);
    expect(Math.hypot(lt.downRange, lt.crossRange)).toBeCloseTo(lt.distance, 3);
    expect(lt.bearingDeg).toBeGreaterThanOrEqual(0);
    expect(lt.bearingDeg).toBeLessThan(360);
    // on Earth the nearest recovery zone is offered instead; on the pad there is no ground track
    const chutes = createFakeSim(defs, { scene: 'chutes' }).snapshot();
    expect(chutes.readouts.landingTarget?.targetId).toBe('recovery:0');
    expect(chutes.readouts.landingTarget!.distance).toBeLessThan(2000e3);
    const pad = createFakeSim(defs, { scene: 'pad' }).snapshot();
    expect(pad.readouts.landingTarget?.downRange).toBe(0);
  });

  it('debug calls are counted as cheats', () => {
    const sim = createFakeSim(defs, { scene: 'lowOrbit' });
    sim.debug.setUt(0);
    expect(sim.snapshot().cheatCounter).toBe(1);
  });
});
