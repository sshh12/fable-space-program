import { beforeAll, describe, expect, it } from 'vitest';
import type { CameraInput, CameraRig, CameraState } from '@/core/contracts/render';
import type { DefLibrary } from '@/core/contracts/defs';
import type { SimSnapshot } from '@/core/contracts/sim';
import type { TerrainProvider } from '@/core/contracts/terrain';
import { fsDefSource } from '@/core/defs/fsSource';
import { loadDefs } from '@/core/defs/loader';
import { createFakeSim, type FakeScene } from '@/core/fakes/fakeSim';
import { quat } from '@/core/math/quat';
import { DEG } from '@/core/math/scalar';
import { v3, type Vec3 } from '@/core/math/vec3';
import {
  buildAudioListener,
  chaseDistanceLimits,
  createChaseRig,
  createCockpitRig,
  createMapRig,
  createViewManager,
  MAP_MAX_DISTANCE,
  MAP_MIN_DISTANCE,
  resolveSeatPose,
  vesselComRoot,
  viewForward,
  type ViewFrame,
} from '@/camera';
import { labVehicleParts, tagLabVehicle, withLabVehicle } from '../../../labs/flight-ui/labVehicle';

let defs: DefLibrary;
beforeAll(async () => {
  defs = withLabVehicle(await loadDefs(fsDefSource()));
});

const IDLE: CameraInput = { yaw: 0, pitch: 0, zoom: 1 };
const DT = 1 / 60;

function sim(scene: FakeScene): { snap: () => SimSnapshot; advance: (dt: number) => void } {
  const s = createFakeSim(defs, { scene, parts: labVehicleParts(defs) });
  return { snap: () => tagLabVehicle(s.snapshot()), advance: (dt) => s.advance(dt) };
}

function rigs(terrain?: TerrainProvider): CameraRig[] {
  return [createChaseRig({ defs, terrain }), createCockpitRig({ defs }), createMapRig({ defs })];
}

const angleDeg = (a: CameraState, b: CameraState): number => quat.angleBetween(a.qViewToRoot, b.qViewToRoot) / DEG;

/** Positions relative to the active vessel's CoM, so a moving vessel does not count as camera motion. */
function rel(s: SimSnapshot, c: CameraState): Vec3 {
  const v = s.vessels.find((x) => x.id === s.activeVesselId)!;
  return v3.sub(c.positionRoot, vesselComRoot(v));
}

interface Rec {
  snap: SimSnapshot;
  frame: ViewFrame;
}

function runSwitch(scene: FakeScene, startMode: string, keys: ('toggleMap' | 'cycleCamera')[], moving: boolean): { recs: Rec[]; switchAt: number } {
  const src = sim(scene);
  const vm = createViewManager(rigs(), { defs, initialMode: startMode });
  const recs: Rec[] = [];
  let snap = src.snap();
  for (let i = 0; i < 30; i++) {
    recs.push({ snap, frame: vm.update(snap, IDLE, DT) });
    if (moving) {
      src.advance(DT);
      snap = src.snap();
    }
  }
  const switchAt = recs.length;
  recs.push({ snap, frame: vm.update(snap, IDLE, DT, new Set(keys)) });
  for (let i = 0; i < 80; i++) {
    if (moving) {
      src.advance(DT);
      snap = src.snap();
    }
    recs.push({ snap, frame: vm.update(snap, IDLE, DT) });
  }
  return { recs, switchAt };
}

function assertContinuousBlend(recs: Rec[], switchAt: number): void {
  // 1. No jump into the blend: the first blended frame continues the last frame before the switch.
  const before = recs[switchAt - 1]!;
  const first = recs[switchAt]!;
  expect(v3.dist(rel(before.snap, before.frame.camera), rel(first.snap, first.frame.camera))).toBeLessThan(0.01);
  expect(angleDeg(before.frame.camera, first.frame.camera)).toBeLessThan(0.1);
  // 2. No jump out of it: while blending, the presented camera converges onto the target rig's own output.
  const blendFrames = recs.slice(switchAt).filter((r) => r.frame.camera !== r.frame.target);
  expect(blendFrames.length).toBeGreaterThan(30);
  const lastBlend = blendFrames[blendFrames.length - 1]!;
  expect(v3.dist(lastBlend.frame.camera.positionRoot, lastBlend.frame.target.positionRoot)).toBeLessThan(0.01);
  expect(angleDeg(lastBlend.frame.camera, lastBlend.frame.target)).toBeLessThan(0.1);
  // 3. Smooth in between: no frame-to-frame step is a spike against its neighbours.
  const steps: number[] = [];
  const turns: number[] = [];
  for (let i = switchAt; i < recs.length; i++) {
    const a = recs[i - 1]!;
    const b = recs[i]!;
    steps.push(v3.dist(rel(a.snap, a.frame.camera), rel(b.snap, b.frame.camera)));
    turns.push(angleDeg(a.frame.camera, b.frame.camera));
  }
  for (let i = 1; i < steps.length - 1; i++) {
    expect(steps[i]!).toBeLessThanOrEqual(2.2 * Math.max(steps[i - 1]!, steps[i + 1]!) + 0.01);
    expect(turns[i]!).toBeLessThanOrEqual(2.2 * Math.max(turns[i - 1]!, turns[i + 1]!) + 0.1);
  }
}

describe('view manager blends', () => {
  it.each([
    ['chase -> cockpit', 'chase', ['cycleCamera'], false],
    ['cockpit -> chase', 'cockpit', ['cycleCamera'], false],
    ['chase -> map', 'chase', ['toggleMap'], false],
    ['map -> chase', 'map', ['toggleMap'], false],
    ['chase -> cockpit, vessel in orbit at 7.8 km/s', 'chase', ['cycleCamera'], true],
    ['chase -> map, vessel in orbit', 'chase', ['toggleMap'], true],
  ] as const)('%s is continuous (no step above 1 cm / 0.1 deg at either end, no spikes)', (_name, start, keys, moving) => {
    const { recs, switchAt } = runSwitch('lowOrbit', start, [...keys], moving);
    expect(recs[switchAt + 79]!.frame.camera.mode).not.toBe(start);
    assertContinuousBlend(recs, switchAt);
  });

  it('switches mode and kind at the midpoint and reports the matching listener', () => {
    const { recs, switchAt } = runSwitch('pad', 'cockpit', ['cycleCamera'], false);
    expect(recs[switchAt]!.frame.camera.kind).toBe('interior');
    expect(recs[switchAt]!.frame.listener.insideVesselId).not.toBeNull();
    const end = recs[recs.length - 1]!.frame;
    expect(end.camera.kind).toBe('external');
    expect(end.listener.kind).toBe('external');
    expect(end.listener.insideVesselId).toBeNull();
    // On the pad the listener is in air: near sea-level pressure.
    expect(end.listener.ambientPressure).toBeGreaterThan(80_000);
  });

  it('M toggles to the map and back to the last flight view; C does nothing in the map', () => {
    const src = sim('lowOrbit');
    const vm = createViewManager(rigs(), { defs, initialMode: 'cockpit' });
    const s = src.snap();
    vm.update(s, IDLE, DT);
    vm.update(s, IDLE, DT, new Set(['toggleMap']));
    expect(vm.mode).toBe('map');
    vm.update(s, IDLE, DT, new Set(['cycleCamera']));
    expect(vm.mode).toBe('map');
    vm.update(s, IDLE, DT, new Set(['toggleMap']));
    expect(vm.mode).toBe('cockpit');
  });

  it('accepts a rig with an unknown mode and treats it by its kind', () => {
    // A minimal third-party rig: only the CameraRig contract, no kind or availability hints.
    let activations = 0;
    const eva: CameraRig = {
      mode: 'eva-third-person',
      activate: () => {
        activations++;
      },
      update: (s) => {
        const v = s.vessels[0]!;
        const pos = v3.add(vesselComRoot(v), v3.new(0, 0, 30));
        return {
          mode: 'eva-third-person',
          kind: 'external',
          positionRoot: pos,
          qViewToRoot: quat.identity(),
          fovY: 1,
          insideVesselId: null,
          focusVesselId: v.id,
          focusBodyId: v.bodyId,
          exposureCompensation: 0,
          minEv100: null,
          fillLight: 0,
        };
      },
    };
    const src = sim('lowOrbit');
    const vm = createViewManager([createChaseRig({ defs }), createCockpitRig({ defs }), createMapRig({ defs }), eva], { defs });
    const s = src.snap();
    vm.update(s, IDLE, DT);
    vm.update(s, IDLE, DT, new Set(['cycleCamera']));
    expect(vm.mode).toBe('cockpit');
    vm.update(s, IDLE, DT, new Set(['cycleCamera']));
    expect(vm.mode).toBe('eva-third-person');
    expect(activations).toBe(1);
    let f: ViewFrame = vm.update(s, IDLE, DT);
    for (let i = 0; i < 60; i++) f = vm.update(s, IDLE, DT);
    expect(f.camera.mode).toBe('eva-third-person');
    expect(f.camera.kind).toBe('external');
    expect(f.listener.kind).toBe('external');
    expect(f.listener.mode).toBe('eva-third-person');
    expect(f.observers[0]!.positionRoot).toEqual(f.camera.positionRoot);
    // It is a flight view: M goes to the map and comes back to it.
    vm.update(s, IDLE, DT, new Set(['toggleMap']));
    vm.update(s, IDLE, DT, new Set(['toggleMap']));
    expect(vm.mode).toBe('eva-third-person');
  });

  it('lists the camera and vessels near a surface as LOD observers', () => {
    const pad = sim('pad');
    const vm = createViewManager(rigs(), { defs });
    const f = vm.update(pad.snap(), IDLE, DT);
    expect(f.observers.length).toBe(2);
    expect(f.observers[1]!.radiusBias).toBeGreaterThan(0);
    const orbit = sim('lowOrbit');
    const vm2 = createViewManager(rigs(), { defs });
    expect(vm2.update(orbit.snap(), IDLE, DT).observers.length).toBe(1);
  });
});

describe('cockpit rig', () => {
  it('puts the eye at the commander seat resolved through the part pose', () => {
    const src = sim('lowOrbit');
    const s = src.snap();
    const v = s.vessels[0]!;
    const rig = createCockpitRig({ defs });
    expect(rig.isAvailable(s)).toBe(true);
    rig.activate(null, s);
    const c = rig.update(s, IDLE, DT);
    const capsule = v.parts.find((p) => p.instanceId === 'capsule')!;
    const seat = defs.parts['lab-capsule']!.modules.find((m) => m.type === 'command')!;
    if (seat.type !== 'command') throw new Error('no command module');
    const cdr = seat.seats.find((x) => x.id === 'cdr')!;
    const eyeVes = v3.add(capsule.localPos, quat.rotate(capsule.localRot, v3.fromTuple(cdr.pos)));
    const expected = v3.add(v.rRoot, quat.rotate(v.q, eyeVes));
    expect(v3.dist(c.positionRoot, expected)).toBeLessThan(1e-6);
    // Looking along the seat's look direction.
    const look = quat.rotate(v.q, v3.normalize(v3.fromTuple(cdr.lookDir)));
    expect(v3.angle(viewForward(c.qViewToRoot), look)).toBeLessThan(1e-9);
    expect(c.kind).toBe('interior');
    expect(c.insideVesselId).toBe(v.id);
    expect(resolveSeatPose(defs, v)!.eyeVes).toEqual(eyeVes);
  });

  it('limits mouse look and sways the head under a sudden acceleration, then settles', () => {
    const src = sim('lowOrbit');
    const base = src.snap();
    const rig = createCockpitRig({ defs });
    rig.activate(null, base);
    let c = rig.update(base, { yaw: 10, pitch: 10, zoom: 1 }, DT);
    expect(rig.lookYaw).toBeCloseTo(150 * DEG, 9);
    expect(rig.lookPitch).toBeCloseTo(75 * DEG, 9);
    const rest = rig.update(base, { yaw: -10, pitch: -10, zoom: 1 }, DT);
    expect(rig.lookPitch).toBeCloseTo(-60 * DEG, 9);
    // Stage kick: 3 g along +Y for 0.3 s.
    const kicked = { ...base, vessels: base.vessels.map((v) => ({ ...v, properAccel: v3.new(0, 30, 0) })) };
    let maxOffset = 0;
    for (let i = 0; i < 18; i++) {
      c = rig.update(kicked, IDLE, DT);
      maxOffset = Math.max(maxOffset, v3.dist(c.positionRoot, rest.positionRoot));
    }
    expect(maxOffset).toBeGreaterThan(0.01);
    expect(maxOffset).toBeLessThanOrEqual(0.05 + 1e-9);
    for (let i = 0; i < 600; i++) c = rig.update(kicked, IDLE, DT);
    // Settled under sustained thrust: only the small seat compression remains.
    expect(v3.dist(c.positionRoot, rest.positionRoot)).toBeLessThan(0.012);
  });

  it('resolves the cockpit seat of every vehicle in the library that has a cockpit', () => {
    const base = createFakeSim(defs, { scene: 'lowOrbit' }).snapshot();
    const withCockpit = Object.values(defs.vehicles).filter((v) => v.cockpit !== null);
    expect(withCockpit.length).toBeGreaterThan(0);
    for (const vehicle of withCockpit) {
      const parts = vehicle.parts.map((p) => ({ instanceId: p.id, def: p.def, localPos: v3.new(0, 10, 0), localRot: quat.identity(), tempSkin: 290, maxTemp: 1000, resources: {}, modules: [], shielded: false }));
      const s = { ...base, vessels: base.vessels.map((v) => ({ ...v, vehicleId: vehicle.id, parts })) };
      const pose = resolveSeatPose(defs, s.vessels[0]!);
      expect(pose, vehicle.id).not.toBeNull();
      expect(pose!.eyeVes.y).toBeGreaterThan(10);
    }
  });

  it('is unavailable for a vessel without a cockpit and the manager falls back to chase', () => {
    const s = createFakeSim(defs, { scene: 'lowOrbit' }).snapshot();
    const rig = createCockpitRig({ defs });
    expect(rig.isAvailable(s)).toBe(false);
    const vm = createViewManager(rigs(), { defs, initialMode: 'cockpit' });
    expect(vm.update(s, IDLE, DT).camera.mode).toBe('chase');
  });
});

describe('chase rig', () => {
  const flatTerrain = (height: number): TerrainProvider => ({
    heightAt: (_b, dir) => height + 40 * dir.x,
    normalAt: (_b, dir) => dir,
    surfaceKind: () => 'land',
    ensureLoaded: () => Promise.resolve(),
    prewarmCollision: () => 0,
    residency: () => ({ availableLevel: 0, finalLevel: 0, complete: true }) as unknown as ReturnType<TerrainProvider['residency']>,
    elevationRange: () => ({ min: 0, max: height + 40 }),
  });

  it('never goes below a fake terrain', () => {
    const src = sim('pad');
    const s = src.snap();
    const terrain = flatTerrain(45);
    const rig = createChaseRig({ defs, terrain, clearance: 2.5 });
    rig.activate(null, s);
    const body = s.bodies.find((b) => b.id === 'earth')!;
    for (const el of [-80, -45, -10, 0, 20]) {
      rig.setOrbit(0.7, el * DEG, 90);
      const c = rig.update(s, IDLE, DT);
      const rel2 = v3.sub(c.positionRoot, body.rRoot);
      const dirFixed = v3.normalize(quat.rotateInv(body.qFixedToRoot, rel2));
      const ground = defs.bodies['earth']!.radius + terrain.heightAt('earth', dirFixed);
      expect(v3.len(rel2) - ground).toBeGreaterThanOrEqual(2.5 - 1e-6);
    }
  });

  it('keeps zoom within the vehicle limits', () => {
    const src = sim('lowOrbit');
    const s = src.snap();
    const rig = createChaseRig({ defs });
    rig.activate(null, s);
    const lim = chaseDistanceLimits(defs, s.vessels[0]!);
    // Vehicle def: 30 .. 2500 m; the minimum is raised to 1.05 x the bounding radius (55 m in the FakeSim).
    expect(lim).toEqual({ def: 95, min: Math.max(30, 1.05 * 55), max: 2500 });
    for (let i = 0; i < 200; i++) rig.update(s, { yaw: 0, pitch: 0, zoom: 0.5 }, DT);
    expect(rig.distance).toBeCloseTo(lim.min, 6);
    for (let i = 0; i < 400; i++) rig.update(s, { yaw: 0, pitch: 0, zoom: 2 }, DT);
    expect(rig.distance).toBeCloseTo(lim.max, 6);
  });

  it('blends the reference frame on a navball-mode change without swinging the view', () => {
    const fake = createFakeSim(defs, { scene: 'lowOrbit', parts: labVehicleParts(defs) });
    const rig = createChaseRig({ defs });
    let s = tagLabVehicle(fake.snapshot());
    rig.activate(null, s);
    let prev = rig.update(s, IDLE, DT);
    fake.commands.setNavballMode('surface');
    let maxTurn = 0;
    for (let i = 0; i < 150; i++) {
      s = tagLabVehicle(fake.snapshot());
      const c = rig.update(s, IDLE, DT);
      maxTurn = Math.max(maxTurn, angleDeg(prev, c));
      prev = c;
    }
    expect(maxTurn).toBeLessThan(0.5);
  });
});

describe('map rig', () => {
  it('spans 100 km .. 2e9 m from the focus surface without precision loss', () => {
    const src = sim('lunarOrbit');
    const s = src.snap();
    const rig = createMapRig({ defs });
    rig.activate(null, s);
    const moon = s.bodies.find((b) => b.id === 'moon')!;
    const R = defs.bodies['moon']!.radius;
    expect(v3.len(moon.rRoot)).toBeGreaterThan(3e8);
    for (const d of [MAP_MIN_DISTANCE, 1e6, 1e8, MAP_MAX_DISTANCE]) {
      rig.setOrbit(0.3, 0.2, d);
      const c = rig.update(s, IDLE, DT);
      // float64 end to end: the eye-to-focus distance is exact to ~10 micrometres at 2e9 m (float32: ~100 m).
      expect(Math.abs(v3.dist(c.positionRoot, moon.rRoot) - (R + d))).toBeLessThan(1e-5);
      expect(c.positionRoot.x).not.toBe(Math.fround(c.positionRoot.x));
      expect(v3.angle(viewForward(c.qViewToRoot), v3.sub(moon.rRoot, c.positionRoot))).toBeLessThan(1e-9);
      expect(c.kind).toBe('map');
      expect(c.fillLight).toBe(0.005);
      expect(c.minEv100).not.toBeNull();
    }
    // Exponential zoom reaches both ends with the wheel.
    for (let i = 0; i < 400; i++) rig.update(s, { yaw: 0, pitch: 0, zoom: 0.8 }, DT);
    expect(rig.distance).toBeCloseTo(MAP_MIN_DISTANCE, 3);
    for (let i = 0; i < 600; i++) rig.update(s, { yaw: 0, pitch: 0, zoom: 1.25 }, DT);
    expect(rig.distance / MAP_MAX_DISTANCE).toBeCloseTo(1, 6);
  });

  it('moves smoothly to a new focus', () => {
    const src = sim('lowOrbit');
    const s = src.snap();
    const rig = createMapRig({ defs });
    rig.activate(null, s);
    let prev = rig.update(s, IDLE, DT);
    for (let i = 0; i < 120; i++) prev = rig.update(s, IDLE, DT);
    const moon = s.bodies.find((b) => b.id === 'moon')!;
    const steps: number[] = [];
    let c = rig.update(s, { ...IDLE, focusBodyId: 'moon' }, DT);
    steps.push(v3.dist(prev.positionRoot, c.positionRoot));
    prev = c;
    for (let i = 0; i < 200; i++) {
      c = rig.update(s, IDLE, DT);
      steps.push(v3.dist(prev.positionRoot, c.positionRoot));
      prev = c;
    }
    expect(rig.focus).toEqual({ kind: 'body', id: 'moon' });
    expect(c.focusBodyId).toBe('moon');
    // The first frame after the request barely moves; no frame jumps against its neighbours.
    const total = steps.reduce((a, b) => a + b, 0);
    expect(steps[0]!).toBeLessThan(total * 1e-6);
    for (let i = 1; i < steps.length - 1; i++) expect(steps[i]!).toBeLessThanOrEqual(2.2 * Math.max(steps[i - 1]!, steps[i + 1]!) + 1);
    expect(v3.angle(viewForward(c.qViewToRoot), v3.sub(moon.rRoot, c.positionRoot))).toBeLessThan(1e-6);
  });

  it('starts on the ray through the previous camera', () => {
    const src = sim('lowOrbit');
    const s = src.snap();
    const chase = createChaseRig({ defs });
    chase.activate(null, s);
    const from = chase.update(s, IDLE, DT);
    const rig = createMapRig({ defs });
    rig.activate(from, s);
    const c = rig.update(s, IDLE, 0);
    const earth = s.bodies.find((b) => b.id === 'earth')!;
    expect(v3.angle(v3.sub(c.positionRoot, earth.rRoot), v3.sub(from.positionRoot, earth.rRoot))).toBeLessThan(1e-9);
  });
});

describe('audio listener', () => {
  it('is silent (0 Pa) in vacuum and in the map, positioned in the vessel frame', () => {
    const src = sim('lowOrbit');
    const s = src.snap();
    const chase = createChaseRig({ defs });
    chase.activate(null, s);
    const c = chase.update(s, IDLE, DT);
    const l = buildAudioListener(defs, s, c);
    expect(l.ambientPressure).toBe(0);
    const v = s.vessels[0]!;
    expect(v3.dist(quat.rotate(v.q, l.positionVes), v3.sub(c.positionRoot, v.rRoot))).toBeLessThan(1e-6);
    expect(v3.len(l.forwardVes)).toBeCloseTo(1, 12);
  });
});
