import { describe, expect, it } from 'vitest';
import { NEUTRAL_CONTROLS } from '../contracts/controls';
import type { DefLibrary } from '../contracts/defs';
import type { ModuleState, PartSnapshot } from '../contracts/sim';
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

  it('engines keep time since ignition and since shutdown, like the real engine module', () => {
    const engineDef = Object.values(defs.parts).find((p) => p.modules.some((m) => m.type === 'engine'))!;
    const engineAt = engineDef.modules.findIndex((m) => m.type === 'engine');
    const part = (id: string, active: boolean): PartSnapshot => ({
      instanceId: id,
      def: engineDef.id,
      localPos: v3.zero(),
      localRot: { x: 0, y: 0, z: 0, w: 1 },
      tempSkin: 290,
      maxTemp: 2000,
      resources: {},
      modules: engineDef.modules.map((m, i) =>
        i === engineAt
          ? { type: 'engine', active, throttleActual: 0, thrust: 0, massFlow: 0, ambientPressure: 0, pressureRatio: 1, gimbal: [0, 0], ignitionAge: -1, shutdownAge: -1, ignitionsLeft: null, flameout: false }
          : ({ type: m.type } as unknown as ModuleState),
      ),
      shielded: false,
    });
    const sim = createFakeSim(defs, { scene: 'lowOrbit', parts: [part('burning', true), part('idle', false)] });
    const engine = (id: string): Extract<ModuleState, { type: 'engine' }> => sim.snapshot().vessels[0]!.parts.find((p) => p.instanceId === id)!.modules[engineAt] as Extract<ModuleState, { type: 'engine' }>;
    expect(engine('burning').ignitionAge).toBe(-1);
    expect(engine('burning').shutdownAge).toBe(-1);
    sim.setControls({ ...NEUTRAL_CONTROLS, translate: v3.zero(), throttle: 1 });
    // The throttle spools up: the engines light on the first step that takes it past 2 %.
    let steps = 0;
    while (engine('burning').ignitionAge < 0 && steps < 20) {
      sim.advance(1 / 60);
      steps++;
    }
    expect(engine('burning').ignitionAge).toBe(0);
    for (let i = 0; i < 120; i++) sim.advance(1 / 60);
    // Two seconds later the age is two seconds (it used to stay at 1/60 s for ever: request vfx-2).
    expect(engine('burning').ignitionAge).toBeCloseTo(2, 6);
    expect(engine('burning').shutdownAge).toBe(-1);
    expect(engine('burning').thrust).toBeGreaterThan(0);
    // An engine that staging has not activated never lights.
    expect(engine('idle').ignitionAge).toBe(-1);
    expect(engine('idle').thrust).toBe(0);
    // Throttle to zero: the shutdown clock starts at 0 on the step the engines go out and counts from there.
    sim.setControls({ ...NEUTRAL_CONTROLS, translate: v3.zero(), throttle: 0 });
    const burned = (): number => engine('burning').ignitionAge;
    let out = 0;
    while (engine('burning').shutdownAge < 0 && out < 200) {
      sim.advance(1 / 60);
      out++;
    }
    expect(engine('burning').shutdownAge).toBe(0);
    const frozen = burned();
    for (let i = 0; i < 60; i++) sim.advance(1 / 60);
    expect(engine('burning').shutdownAge).toBeCloseTo(1, 6);
    expect(burned()).toBe(frozen);
  });

  it('names the vehicle it was told it flies (features look the vehicle definition up by it)', () => {
    const vehicleId = Object.keys(defs.vehicles)[0]!;
    const sim = createFakeSim(defs, { scene: 'lowOrbit', vehicleId });
    expect(sim.scenario.vehicle).toBe(vehicleId);
    expect(sim.snapshot().vessels[0]!.vehicleId).toBe(vehicleId);
    // The default stays "no vehicle": the placeholder vessel belongs to none.
    expect(createFakeSim(defs, { scene: 'lowOrbit' }).snapshot().vessels[0]!.vehicleId).toBe('');
  });

  it('the surface scenes can be placed away from the site', () => {
    const sim = createFakeSim(defs, { scene: 'ascent', location: { latDeg: -42.5, lonDeg: 101.25 } });
    const s = sim.snapshot();
    expect(s.readouts.latitude * (180 / Math.PI)).toBeCloseTo(-42.5, 6);
    expect(s.readouts.longitude * (180 / Math.PI)).toBeCloseTo(101.25, 6);
    expect(s.readouts.altitudeAsl).toBeCloseTo(9000, 3);
    // The default is the site, as before.
    const site = defs.sites[sim.scenario.site]!;
    expect(createFakeSim(defs, { scene: 'ascent' }).snapshot().readouts.latitude * (180 / Math.PI)).toBeCloseTo(site.location.latDeg, 6);
  });

  it('stands on the real ground when told where it is: origin, radar altitude and the floor of a descent', () => {
    // A launch mount: ground 21.6 m above the reference radius, the stack's lowest point 18 m above it, the
    // origin 60 m above the lowest point.
    const pad = createFakeSim(defs, { scene: 'pad', ground: { height: 21.6, originHeight: 60, clearance: 18 } }).snapshot();
    expect(pad.readouts.altitudeAsl).toBeCloseTo(21.6 + 18 + 60, 6);
    expect(pad.readouts.altitudeRadar).toBeCloseTo(18, 6);
    // A mare floor 1,900 m below the reference radius: the landed vessel stands on it, not on the sphere.
    const moon = createFakeSim(defs, { scene: 'lunarSurface', location: { latDeg: 0.66, lonDeg: 23.44 }, ground: { height: -1900, originHeight: 4.5 } }).snapshot();
    expect(moon.readouts.altitudeAsl).toBeCloseTo(-1895.5, 6);
    expect(moon.readouts.altitudeRadar).toBeCloseTo(0, 6);
    expect(moon.readouts.latitude * (180 / Math.PI)).toBeCloseTo(0.66, 6);
    expect(moon.readouts.longitude * (180 / Math.PI)).toBeCloseTo(23.44, 6);
    // A descent under parachutes ends with the lowest point on the water, and the radar altitude says so on the way.
    const sim = createFakeSim(defs, { scene: 'chutes', ground: { height: 0, originHeight: 2 } });
    expect(sim.snapshot().readouts.altitudeRadar).toBeCloseTo(2498, 6);
    sim.advanceRails(sim.snapshot().ut + 600);
    const down = sim.snapshot();
    expect(down.readouts.altitudeAsl).toBeCloseTo(2, 6);
    expect(down.readouts.altitudeRadar).toBeCloseTo(0, 6);
    // A flying scene can start lower (the last metres under the canopies) or higher.
    const low = createFakeSim(defs, { scene: 'chutes', altitude: 120, ground: { height: 0, originHeight: 2 } }).snapshot();
    expect(low.readouts.altitudeAsl).toBeCloseTo(120, 6);
    expect(low.readouts.altitudeRadar).toBeCloseTo(118, 6);
    expect(createFakeSim(defs, { scene: 'ascent', altitude: 12000 }).snapshot().readouts.altitudeAsl).toBeCloseTo(12000, 6);
    // Without it nothing changes: the scene's altitude above the reference radius is also the radar altitude.
    const plain = createFakeSim(defs, { scene: 'pad' }).snapshot();
    expect(plain.readouts.altitudeAsl).toBe(60);
    expect(plain.readouts.altitudeRadar).toBe(60);
  });

  it('a capsule under parachutes hangs nose up (the lines leave at the apex), heat shield towards the ground', () => {
    const s = createFakeSim(defs, { scene: 'chutes' }).snapshot();
    const v = s.vessels[0]!;
    const up = v3.normalize(v.r);
    expect(v3.dot(quat.rotate(v.q, v3.unitY()), up)).toBeCloseTo(1, 9);
    expect(s.navball.pitchDeg).toBeCloseTo(90, 3);
    // Reentry, for comparison: the nose trails, the heat shield leads.
    const e = createFakeSim(defs, { scene: 'reentry' }).snapshot().vessels[0]!;
    expect(v3.dot(quat.rotate(e.q, v3.unitY()), v3.normalize(e.v))).toBeLessThan(-0.99);
  });

  it('landed vessels ride the rotating body and refuse rails warp under thrust', () => {
    const sim = createFakeSim(defs, { scene: 'pad' });
    const s0 = sim.snapshot();
    expect(s0.vessels[0]!.situation).toBe('prelaunch');
    expect(s0.readouts.speedSurface).toBeLessThan(1e-6);
    expect(s0.readouts.speedOrbital).toBeGreaterThan(400);
    expect(s0.readouts.speedOrbital).toBeLessThan(470);
    // The pad stands where the site definition says (the Earth bake snapped it to real terrain; this test
    // used to pin the nominal 19.1 N 155.5 W of ARCHITECTURE section 1).
    const site = defs.sites[sim.scenario.site]!;
    expect(s0.readouts.latitude * (180 / Math.PI)).toBeCloseTo(site.location.latDeg, 6);
    expect(s0.readouts.longitude * (180 / Math.PI)).toBeCloseTo(site.location.lonDeg, 6);
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

  it('rollDeg has the sign of the roll control: positive = rotation about +Y, dorsal toward starboard (request sim-orbits-2)', () => {
    for (const scene of ['lowOrbit', 'translunar', 'lunarOrbit', 'reentry'] as const) {
      const sim = createFakeSim(defs, { scene });
      const before = sim.snapshot().navball;
      sim.setControls({ ...NEUTRAL_CONTROLS, translate: v3.zero(), roll: 1 });
      sim.advance(1 / 60);
      sim.advance(1 / 60);
      const after = sim.snapshot().navball;
      let d = after.rollDeg - before.rollDeg;
      d -= 360 * Math.round(d / 360);
      expect(d, scene).toBeGreaterThan(0);
      expect(d, scene).toBeLessThan(10);
      // The published angles are those of the published quaternion (horizon frame: +X east, +Y north, +Z up).
      const nose = quat.rotate(after.qVesselToHorizon, v3.unitY());
      const dorsal = quat.rotate(after.qVesselToHorizon, v3.unitZ());
      const upRef = v3.normalize(v3.reject(v3.unitZ(), nose));
      const roll = Math.atan2(v3.dot(dorsal, v3.cross(nose, upRef)), v3.dot(dorsal, upRef)) * (180 / Math.PI);
      expect(after.rollDeg).toBeCloseTo(roll, 6);
      expect(after.pitchDeg).toBeCloseTo(Math.asin(nose.z) * (180 / Math.PI), 6);
      expect(after.headingDeg).toBeCloseTo(((Math.atan2(nose.x, nose.y) * (180 / Math.PI)) + 360) % 360, 6);
    }
    // Nose vertical on the pad: roll 0, heading = the side the ventral face looks at (east in the pad scene).
    const pad = createFakeSim(defs, { scene: 'pad' }).snapshot().navball;
    expect(pad.pitchDeg).toBeCloseTo(90, 6);
    expect(pad.rollDeg).toBe(0);
    expect(pad.headingDeg).toBeCloseTo(90, 6);
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
