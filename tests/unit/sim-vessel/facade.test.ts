/**
 * The frozen public facade (no environment needed), the orchestrator facade (snapshots, readouts,
 * integration predicate, state hash), structural failure, the reduced tier, determinism, the fuzz run
 * and the step-time budget.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { NEUTRAL_CONTROLS, type ControlInputs } from '@/core/contracts/controls';
import type { DefLibrary } from '@/core/contracts/defs';
import type { SimEvent } from '@/core/contracts/sim';
import { createFakeSim } from '@/core/fakes/fakeSim';
import { Prng } from '@/core/math/hash';
import { quat } from '@/core/math/quat';
import { DEG } from '@/core/math/scalar';
import { v3 } from '@/core/math/vec3';
import { destroyParts, EXPLOSION_IMPULSE_PER_KG, EXPLOSION_MAX_DELTA_V, presentedArea } from '@/sim/dynamics/failure';
import {
  abort,
  assembleVessel as assembleInternal,
  cloneVessel,
  fireNextStage,
  isControllable,
  needsIntegration,
  radarAltitude,
  setLights,
  setRcsEnabled,
  setSasEnabled,
  setSasHoldDirection,
  setSasMode,
  stagingInfo,
  stepVessel,
  stepVesselReduced,
  surfaceSituation,
  toggleLegs,
  toVesselSnapshot,
  vesselBaseY,
  vesselReadouts,
  vesselStateHash,
  type Vessel,
} from '@/sim/vessel';
import { assembleVessel, setModuleStateForLab, splitForStage, vesselPartSnapshots } from '@/sim/vessel/public';
import type { StepContext } from '@/sim/vessel/types';
import { controls, DT, earthAir, isFiniteVessel, loadLibrary, makeEnv, placeUpright, run, runAll, STANDARD_DENSITY, VEHICLE, type FakeEnv } from './helpers';

let defs: DefLibrary;
beforeAll(async () => {
  defs = await loadLibrary();
});

describe('public facade (no VesselEnvironment)', () => {
  it('assembleVessel resolves attach nodes into a coaxial stack', () => {
    const v = assembleVessel(defs, VEHICLE);
    expect(v.parts[0]!.instanceId).toBe('capsule');
    expect(v.parts[0]!.pos).toEqual({ x: 0, y: 0, z: 0 });
    const pos = (id: string) => v.parts.find((p) => p.instanceId === id)!.pos;
    // Capsule on its adapter ring on the ascent stage on the separator on the descent stage ...
    expect(pos('capsule-adapter').y).toBeCloseTo(-0.6, 9);
    expect(pos('ascent-stage').y).toBeCloseTo(-4.2, 9);
    expect(pos('stage-separator').y).toBeCloseTo(-4.5, 9);
    expect(pos('descent-stage').y).toBeCloseTo(-7.9, 9);
    expect(pos('payload-adapter').y).toBeCloseTo(-9.5, 9);
    expect(pos('m3').y).toBeCloseTo(-20.5, 9);
    expect(pos('fairing').y).toBeCloseTo(-9.5, 9);
    expect(pos('interstage-2').y).toBeCloseTo(-23.5, 9);
    expect(pos('m2').y).toBeCloseTo(-55.5, 9);
    expect(pos('interstage-1').y).toBeCloseTo(-57.5, 9);
    expect(pos('m1').y).toBeCloseTo(-97.5, 9);
    expect(pos('apex-cover').y).toBeCloseTo(2.85, 9);
    expect(pos('les').y).toBeCloseTo(3.15, 9);
    // Mated interfaces meet exactly: child top = parent bottom along the stack.
    const top = (id: string) => pos(id).y + v.parts.find((p) => p.instanceId === id)!.def.bounds.yMax;
    const bottom = (id: string) => pos(id).y + v.parts.find((p) => p.instanceId === id)!.def.bounds.yMin;
    for (const [upper, lower] of [['capsule-adapter', 'ascent-stage'], ['ascent-stage', 'stage-separator'], ['stage-separator', 'descent-stage'], ['descent-stage', 'payload-adapter'], ['payload-adapter', 'm3'], ['m3', 'interstage-2'], ['interstage-2', 'm2'], ['m2', 'interstage-1'], ['interstage-1', 'm1']] as const) {
      expect(bottom(upper)).toBeCloseTo(top(lower), 9);
    }
    // The fairing reaches from the top of M-3 to the capsule's maximum diameter, where the boost cover starts.
    expect(top('fairing')).toBeCloseTo(0, 9);
    expect(bottom('les')).toBeCloseTo(0, 6);
    // Ring engines: eight on a 3.3 m circle plus the centre one, all hanging 2.4 m below the stage.
    const atlas = v.parts.filter((p) => p.def.id === 'atlas-9m');
    expect(atlas.filter((p) => Math.hypot(p.pos.x, p.pos.z) < 1e-9)).toHaveLength(1);
    expect(atlas.filter((p) => Math.abs(Math.hypot(p.pos.x, p.pos.z) - 3.3) < 1e-5)).toHaveLength(8);
    for (const p of atlas) expect(p.pos.y + p.def.bounds.yMin).toBeCloseTo(-99.9, 9);
    // Radial parts: the second RCS pod is turned half round, the clamps face the stage.
    const podB = v.parts.find((p) => p.instanceId === 'm3-rcs-pod-b')!;
    expect(quat.rotate(podB.rot, { x: 1, y: 0, z: 0 }).x).toBeCloseTo(-1, 9);
    const clamp = v.parts.find((p) => p.instanceId === 'clamp-2')!;
    expect(v3.dot(v3.normalize({ x: clamp.pos.x, y: 0, z: clamp.pos.z }), quat.rotate(clamp.rot, { x: 0, y: 0, z: 1 }))).toBeCloseTo(1, 9);
    // Stack parts keep an exactly identity rotation.
    for (const id of ['m1', 'm2', 'm3', 'descent-stage', 'atlas-4']) expect(v.parts.find((p) => p.instanceId === id)!.rot).toEqual({ x: 0, y: 0, z: 0, w: 1 });
    expect(v.r).toEqual({ x: 0, y: 0, z: 0 });
    // The clamps stand 3.5 m below the stage base: that is where the vehicle meets the launch mount.
    expect(vesselBaseY(v)).toBeCloseTo(-101, 9);
    expect(vesselBaseY(assembleVessel(defs, VEHICLE, { stagesAlreadyFired: 6 }))).toBeCloseTo(-7.9 - 0.7 - 0.4, 9);
    // Antennas stay folded on the pad and under the fairing, and unfold once exposed.
    const antenna = (x: Vessel, id: string) => x.parts.find((p) => p.instanceId === id)!.modules.find((m) => m.type === 'antenna');
    expect(antenna(v, 'm3')).toEqual({ type: 'antenna', deployed: false });
    expect(antenna(assembleVessel(defs, VEHICLE, { stagesAlreadyFired: 1 }), 'ascent-stage')).toEqual({ type: 'antenna', deployed: false });
    expect(antenna(assembleVessel(defs, VEHICLE, { stagesAlreadyFired: 3 }), 'ascent-stage')).toEqual({ type: 'antenna', deployed: true });
    expect(antenna(assembleVessel(defs, VEHICLE, { stagesAlreadyFired: 3 }), 'capsule')).toEqual({ type: 'antenna', deployed: true });
    expect(() => assembleVessel(defs, 'nope')).toThrow(/unknown vehicle/);
    expect(() => assembleVessel(defs, VEHICLE, { stagesAlreadyFired: 11 })).toThrow();
  });

  it('stagesAlreadyFired drops spent stages and arms the right engines', () => {
    const counts = [42, 38, 26, 23, 14, 9, 9, 5, 2, 1, 1];
    for (let n = 0; n <= 10; n++) {
      const v = assembleVessel(defs, VEHICLE, { stagesAlreadyFired: n });
      expect(v.parts.length, `after ${n} stages`).toBe(counts[n]);
      expect(v.crafts[0]!.nextStage).toBe(n);
      expect(v.parts[0]!.instanceId).toBe('capsule');
      expect(v.hold).toBe(n === 0 ? 'clamps' : null);
    }
    const eng = (v: Vessel, id: string) => v.parts.find((p) => p.instanceId === id)!.modules.find((m) => m.type === 'engine');
    expect(eng(assembleVessel(defs, VEHICLE, { stagesAlreadyFired: 1 }), 'atlas-3')).toMatchObject({ active: true, throttleActual: 0 });
    const two = assembleVessel(defs, VEHICLE, { stagesAlreadyFired: 2 });
    expect(eng(two, 'vela-2-6')).toMatchObject({ active: true });
    expect(eng(two, 'm2-ullage')).toMatchObject({ active: false });
    expect(two.parts.find((p) => p.instanceId === 'm2-ullage')!.resources[0]).toBe(0);
    const five = assembleVessel(defs, VEHICLE, { stagesAlreadyFired: 5 });
    expect(eng(five, 'lyra-d')).toMatchObject({ active: true });
    expect(five.rcsEnabled).toBe(true);
    const six = assembleVessel(defs, VEHICLE, { stagesAlreadyFired: 6 });
    expect(six.parts.find((p) => p.instanceId === 'landing-legs')!.modules[0]).toMatchObject({ deploy: 1 });
    const seven = assembleVessel(defs, VEHICLE, { stagesAlreadyFired: 7 });
    expect(eng(seven, 'lyra-a')).toMatchObject({ active: true });
    const ten = assembleVessel(defs, VEHICLE, { stagesAlreadyFired: 10 });
    const chutes = ten.parts[0]!.modules.filter((m) => m.type === 'parachute');
    expect(chutes[0]).toMatchObject({ state: 'cut' });
    expect(chutes[1]).toMatchObject({ state: 'full', inflation: 1 });
  });

  it('vesselPartSnapshots fits FakeSimOptions.parts and is a deep copy', () => {
    const v = assembleVessel(defs, VEHICLE);
    const parts = vesselPartSnapshots(v);
    expect(parts).toHaveLength(42);
    const cap = parts[0]!;
    expect(cap).toMatchObject({ instanceId: 'capsule', def: 'kestrel-capsule', shielded: true, maxTemp: 1400 });
    expect(cap.resources).toEqual({ RCSProp: 150, Ablator: 150 });
    expect(cap.modules.map((m) => m.type)).toEqual(defs.parts['kestrel-capsule']!.modules.map((m) => m.type));
    expect(cap.modules[0]).toEqual({ type: 'command', crew: 3, crewAlive: true });
    expect(parts.find((p) => p.instanceId === 'descent-stage')!.shielded).toBe(true);
    expect(parts.find((p) => p.instanceId === 'm1')!.shielded).toBe(false);
    for (const p of parts) expect(p.modules).toHaveLength(defs.parts[p.def]!.modules.length);
    // Mutating the snapshot leaves the vessel alone.
    cap.localPos.x = 99;
    (cap.modules[0] as { crew: number }).crew = 0;
    expect(v.parts[0]!.pos.x).toBe(0);
    expect(v.parts[0]!.modules[0]).toMatchObject({ crew: 3 });
    // The fake sim accepts them.
    const sim = createFakeSim(defs, { scene: 'pad', parts: vesselPartSnapshots(v) });
    const snap = sim.peek();
    expect(snap.vessels[0]!.parts).toHaveLength(42);
  });

  it('setModuleStateForLab patches one module in place', () => {
    const parts = vesselPartSnapshots(assembleVessel(defs, VEHICLE));
    setModuleStateForLab(parts, 'atlas-1', 0, { active: true, throttleActual: 1, thrust: 3.9e6 });
    expect(parts.find((p) => p.instanceId === 'atlas-1')!.modules[0]).toMatchObject({ type: 'engine', active: true, throttleActual: 1, thrust: 3.9e6 });
    expect(parts.find((p) => p.instanceId === 'atlas-2')!.modules[0]).toMatchObject({ throttleActual: 0 });
    setModuleStateForLab(parts, 'landing-legs', 0, { deploy: 1 });
    expect(parts.find((p) => p.instanceId === 'landing-legs')!.modules[0]).toMatchObject({ deploy: 1 });
    expect(() => setModuleStateForLab(parts, 'nope', 0, {})).toThrow(/no part/);
    expect(() => setModuleStateForLab(parts, 'atlas-1', 5, {})).toThrow(/no module/);
    expect(() => setModuleStateForLab(parts, 'atlas-1', 0, { type: 'legs' })).toThrow(/type/);
  });

  it('splitForStage walks the whole stage stack structurally', () => {
    let vessel = assembleVessel(defs, VEHICLE);
    const before = vesselPartSnapshots(vessel);
    const spawnedIds: string[][] = [];
    for (let s = 0; s < 10; s++) {
      const input = vessel;
      const inputParts = input.parts.length;
      const res = splitForStage(defs, input, s);
      expect(input.parts.length).toBe(inputParts);
      expect(res.vessel).not.toBe(input);
      spawnedIds.push(res.spawned.map((x) => x.id));
      for (const sp of res.spawned) {
        // Every separated vessel is where its parts were in the stack at the instant of separation.
        for (const p of sp.parts) {
          const original = before.find((o) => o.instanceId === p.instanceId.replace(/#panel\d$/, ''))!;
          const world = v3.add(sp.r, quat.rotate(sp.q, p.pos));
          // The continuing vessel stays at the origin, so stack coordinates are world coordinates.
          expect(v3.dist(world, original.localPos), `${p.instanceId} after stage ${s}`).toBeLessThan(1e-6);
          expect(quat.angleBetween(quat.mul(sp.q, p.rot), original.localRot)).toBeLessThan(1e-6);
        }
      }
      vessel = res.vessel;
    }
    expect(vesselPartSnapshots(assembleVessel(defs, VEHICLE))).toEqual(before);
    expect(spawnedIds).toEqual([
      ['meridian-lunar~clamp-1'],
      ['meridian-lunar~interstage-1'],
      ['meridian-lunar~les', 'meridian-lunar~fairing#panel0', 'meridian-lunar~fairing#panel1', 'meridian-lunar~fairing#panel2', 'meridian-lunar~fairing#panel3'],
      ['meridian-lunar~interstage-2'],
      ['meridian-lunar~payload-adapter'],
      [],
      ['meridian-lunar~stage-separator'],
      ['meridian-lunar~capsule-adapter'],
      ['meridian-lunar~apex-cover'],
      [],
    ]);
    expect(vessel.parts.map((p) => p.instanceId)).toEqual(['capsule']);
  });

  it('fairing panels and launch clamps follow the renderer conventions', () => {
    const stack = assembleVessel(defs, VEHICLE, { stagesAlreadyFired: 2 });
    const fairing = stack.parts.find((p) => p.instanceId === 'fairing')!;
    const { spawned } = splitForStage(defs, stack, 2);
    const panels = spawned.filter((x) => x.id.includes('#panel'));
    expect(panels).toHaveLength(4);
    panels.forEach((p, k) => {
      expect(p.parts).toHaveLength(1);
      const part = vesselPartSnapshots(p)[0]!;
      expect(part.instanceId).toBe(`fairing#panel${k}`);
      expect(part.def).toBe('meridian-lander-fairing');
      // Posed at the fairing's part frame: identity pose inside a vessel that sits at that frame.
      expect(part.localPos).toEqual({ x: 0, y: 0, z: 0 });
      expect(part.localRot).toEqual({ x: 0, y: 0, z: 0, w: 1 });
      expect(v3.dist(p.r, fairing.pos)).toBeLessThan(1e-9);
      expect(part.modules[0]).toEqual({ type: 'fairing', jettisoned: true });
      expect(p.mp.mass).toBeCloseTo(1500, 9);
      // Panel k covers the quarter centred on azimuth (k + 0.5) * 90 degrees (from +Z toward +X): its CoM lies there.
      const az = Math.atan2(p.mp.com.x, p.mp.com.z) / DEG;
      expect((az + 360) % 360).toBeCloseTo(45 + 90 * k, 6);
      // Kicked outward along that azimuth.
      const out = v3.normalize({ x: p.mp.com.x, y: 0, z: p.mp.com.z });
      const vCom = v3.add(p.v, v3.cross(p.w, p.mp.com));
      expect(v3.dot(vCom, out)).toBeCloseTo(9000 / 1500, 6);
    });
    const pad = splitForStage(defs, assembleVessel(defs, VEHICLE), 0);
    const clamps = pad.spawned[0]!;
    expect(clamps.parts.map((p) => p.instanceId)).toEqual(['clamp-1', 'clamp-2', 'clamp-3', 'clamp-4']);
    expect(clamps.hold).toBe('ground');
    for (const p of clamps.parts) expect(p.modules[0]).toEqual({ type: 'launchClamp', released: true });
    expect(pad.vessel.hold).toBeNull();
  });
});

describe('orchestrator facade', () => {
  it('snapshot carries the vessel-level state and is detached from the vessel', () => {
    const env = makeEnv({ atmosphere: earthAir });
    const v = assembleInternal(defs, VEHICLE, { stagesAlreadyFired: 1 });
    v.r = { x: 0, y: env.radius + 20000, z: 0 };
    v.v = { x: 0, y: 500, z: 0 };
    run(v, env, 3, controls({ throttle: 1 }));
    const snap = toVesselSnapshot(v, { bodyId: 'earth', tier: 'full', situation: 'flying', translationMode: 'integrated', rRoot: v.r, vRoot: v.v, sunVisibility: 1 });
    expect(snap).toMatchObject({ id: 'meridian-lunar', vehicleId: 'meridian-lunar', controllable: true, tier: 'full', situation: 'flying', bodyId: 'earth' });
    expect(snap.mass).toBeCloseTo(v.mp.mass, 6);
    expect(snap.comLocal).toEqual(v.mp.com);
    expect(snap.boundingRadius).toBeGreaterThan(100);
    expect(snap.boundingRadius).toBeLessThan(115);
    expect(snap.thrust).toBeGreaterThan(3.3e7);
    expect(snap.aero.q).toBeGreaterThan(5000);
    expect(snap.aero.mach).toBeGreaterThan(1.5);
    expect(snap.aero.airVelocity.y).toBeGreaterThan(480);
    expect(snap.gLoad).toBeGreaterThan(1.2);
    expect(snap.properAccel.y).toBeGreaterThan(12);
    expect(snap.parts).toHaveLength(38);
    snap.r.x = 5;
    snap.parts[0]!.resources['RCSProp'] = 0;
    expect(v.r.x).not.toBe(5);
    expect(v.parts[0]!.resources[0]).toBe(150);
    expect(surfaceSituation(v)).toBeNull();
    expect(isControllable(v)).toBe(true);
  });

  it('readouts: throttle, thrust, mass, RCS and ablator fractions, lights, legs', () => {
    const env = makeEnv({});
    const v = assembleInternal(defs, VEHICLE, { stagesAlreadyFired: 5 });
    v.r = { x: 0, y: env.radius + 200000, z: 0 };
    v.v = { x: 7700, y: 0, z: 0 };
    run(v, env, 3, controls({ throttle: 0.5 }));
    const r = vesselReadouts(v, env);
    expect(r.throttle).toBe(0.5);
    expect(r.thrust).toBeCloseTo(0.55 * 200000, -3);
    expect(r.mass).toBeCloseTo(v.mp.mass, 6);
    expect(r.twr).toBeCloseTo(r.thrust / (r.mass * (env.mu / v3.len(v.r) ** 2)), 6);
    expect(r.rcsFraction).toBeCloseTo(1, 2);
    expect(r.ablatorFraction).toBe(1);
    expect(r.legsDeployed).toBe(false);
    expect(r.lightsOn).toBe(false);
    expect(r.chuteEnvelope).not.toBeNull();
    expect(r.liftVectorUp).toBeNull();
    expect(r.gDoseLimit).toBe(15);
    expect(r.deltaVTotal).toBeGreaterThan(3408 + 3500);
    expect(r.sasEnabled).toBe(false);
    expect(toggleLegs(v, env.ut)).toHaveLength(1);
    setLights(v, true);
    const r2 = vesselReadouts(v, env);
    expect(r2.legsDeployed).toBe(true);
    expect(r2.lightsOn).toBe(true);
    expect(v.parts.flatMap((p) => p.modules).filter((m) => m.type === 'light').every((m) => m.type === 'light' && m.on)).toBe(true);
    // Staging info marks the fired stages and shows the running stage with its real propellant.
    const info = stagingInfo(v, env);
    expect(info.slice(0, 5).every((s) => s.fired)).toBe(true);
    expect(info[4]!.deltaVVac).toBeGreaterThan(3500);
    expect(info[4]!.deltaVVac).toBeLessThan(3547);
    expect(info[4]!.propellantFraction).toBeLessThan(1);
    expect(info[4]!.twr).toBeCloseTo(200000 / (v.mp.mass * (env.mu / v3.len(v.r) ** 2)), 3);
    expect(info[6]!.deltaVVac).toBeCloseTo(3408, 0);
    expect(info[0]!.actionKinds).toEqual(['igniteEngines', 'releaseClamps']);
  });

  it('needsIntegration follows the rules of sim-design 4.1', () => {
    const vac = makeEnv({});
    const v = assembleInternal(defs, VEHICLE, { stagesAlreadyFired: 5 });
    v.r = { x: 0, y: vac.radius + 300000, z: 0 };
    v.v = { x: 7700, y: 0, z: 0 };
    expect(needsIntegration(v, vac)).toBe(false);
    run(v, vac, 0.5, controls({ throttle: 0.3 }));
    expect(needsIntegration(v, vac)).toBe(true); // engine burning
    run(v, vac, 3, controls({ throttle: 0 }));
    expect(needsIntegration(v, vac)).toBe(false);
    run(v, vac, 0.1, controls({ translate: { x: 0, y: 1, z: 0 } }));
    expect(needsIntegration(v, vac)).toBe(true); // RCS translation
    run(v, vac, 0.1, controls());
    expect(needsIntegration(v, vac)).toBe(false);
    setSasEnabled(v, true);
    v.w = { x: 0.01, y: 0, z: 0 };
    run(v, vac, 0.1, controls());
    expect(needsIntegration(v, vac)).toBe(false); // rotation-only actuation does not force integration
    fireNextStage(v, vac);
    run(v, vac, 0.2, controls());
    expect(needsIntegration(v, vac)).toBe(true); // within 1 s after staging
    run(v, vac, 5, controls());
    expect(needsIntegration(v, vac)).toBe(false);
    // Atmosphere.
    const air = makeEnv({ atmosphere: earthAir });
    v.r = { x: 0, y: air.radius + 100000, z: 0 };
    expect(needsIntegration(v, air)).toBe(true);
    v.r = { x: 0, y: air.radius + 200000, z: 0 };
    expect(needsIntegration(v, air)).toBe(false);
    // Terrain proximity (a mountain 9 km high under the vessel).
    const hills = makeEnv({ terrain: () => 9000 });
    v.r = { x: 0, y: hills.radius + 9000 + 2000, z: 0 };
    expect(needsIntegration(v, hills)).toBe(true);
    expect(radarAltitude(v, hills)).toBeGreaterThan(1970);
    expect(radarAltitude(v, hills)).toBeLessThan(2000);
    v.r = { x: 0, y: hills.radius + 9000 + 4000, z: 0 };
    expect(needsIntegration(v, hills)).toBe(false);
  });

  it('the state hash is stable for equal states and sensitive to any change', () => {
    const a = assembleInternal(defs, VEHICLE, { stagesAlreadyFired: 4 });
    const b = cloneVessel(a);
    expect(vesselStateHash(a)).toMatch(/^[0-9a-f]{16}$/);
    expect(vesselStateHash(b)).toBe(vesselStateHash(a));
    b.r.x += 1e-9;
    expect(vesselStateHash(b)).not.toBe(vesselStateHash(a));
    const c = cloneVessel(a);
    c.parts[3]!.resources[0] = c.parts[3]!.resources[0]! - 1e-6;
    expect(vesselStateHash(c)).not.toBe(vesselStateHash(a));
    const d = cloneVessel(a);
    const m = d.parts.find((p) => p.instanceId === 'vela-2v')!.modules[0]!;
    if (m.type === 'engine') m.gimbal[1] = 1e-9;
    expect(vesselStateHash(d)).not.toBe(vesselStateHash(a));
    const e = cloneVessel(a);
    e.parts[0]!.temps[1] = 291;
    expect(vesselStateHash(e)).not.toBe(vesselStateHash(a));
  });
});

describe('structural failure', () => {
  it('a destroyed tank explodes, kicks its neighbours and sets its children free', () => {
    const env = makeEnv({});
    const v = assembleInternal(defs, VEHICLE, { stagesAlreadyFired: 2 });
    v.r = { x: 0, y: env.radius + 150000, z: 0 };
    v.v = { x: 5000, y: 0, z: 0 };
    const ctx: StepContext = { ut: 0, env, instant: false, events: [], spawned: [] };
    const index = v.parts.findIndex((p) => p.instanceId === 'm2');
    const v0 = v3.clone(v.v);
    destroyParts(v, [index], 'overstress', ctx);
    expect(ctx.events.find((e) => e.type === 'partDestroyed')).toMatchObject({ partId: 'm2', cause: 'overstress' });
    const boom = ctx.events.find((e) => e.type === 'explosion');
    expect(boom && boom.type === 'explosion' ? boom.energy : 0).toBeCloseTo(634000 * 4e6, -6);
    // Six engines and the ullage ring become debris; the upper stack flies on, kicked forward.
    expect(ctx.spawned.map((s) => s.parts[0]!.instanceId).sort()).toEqual(['m2-ullage', 'vela-2-1', 'vela-2-2', 'vela-2-3', 'vela-2-4', 'vela-2-5', 'vela-2-6']);
    expect(v.parts.some((p) => p.instanceId === 'm2')).toBe(false);
    expect(v.parts.some((p) => p.instanceId === 'capsule')).toBe(true);
    // The 164 t upper stack catches the share of the blast that its presented area cuts out of the sphere
    // at its distance (CoM some 24 m from the tank centre): a push of a few m/s, not a launch.
    const kick = v3.sub(v.v, v0);
    expect(kick.y).toBeGreaterThan(1);
    expect(kick.y).toBeLessThan(20);
    expect(Math.hypot(kick.x, kick.z)).toBeLessThan(1e-6 + 0.05 * kick.y);
    expect(v.crewAlive).toBe(true);
    // The engines right under the tank are thrown down and outward, each at a bounded speed.
    for (const s of ctx.spawned) {
      const dv = v3.sub(s.v, v0);
      expect(v3.dot(dv, { x: 0, y: -1, z: 0 })).toBeGreaterThan(0);
      expect(v3.len(dv)).toBeLessThanOrEqual(EXPLOSION_MAX_DELTA_V + 1e-9);
    }
  });

  it('an explosion pushes each piece by its presented area over distance squared, never beyond the cap', () => {
    const env = makeEnv({});
    // The whole stack with a full first stage: 1 760 t of propellant goes up.
    const v = assembleInternal(defs, VEHICLE, { stagesAlreadyFired: 1 });
    v.r = { x: 0, y: env.radius + 2000, z: 0 };
    v.v = { x: 0, y: 60, z: 0 };
    const ctx: StepContext = { ut: 0, env, instant: false, events: [], spawned: [] };
    const v0 = v3.clone(v.v);
    const m1 = v.parts.find((p) => p.instanceId === 'm1')!;
    const propellant = m1.resources.reduce((a, b) => a + b, 0);
    expect(propellant).toBeGreaterThan(1.7e6);
    const centre = v3.add(v.r, { x: 0, y: m1.pos.y + 20, z: 0 });
    destroyParts(v, [v.parts.indexOf(m1)], 'overstress', ctx);
    const pieces = [v, ...ctx.spawned];
    expect(pieces.length).toBeGreaterThanOrEqual(10);
    const log: string[] = [];
    for (const s of pieces) {
      const dv = v3.len(v3.sub(s.v, v0));
      const com = v3.add(s.r, quat.rotate(s.q, s.mp.com));
      const dist = v3.dist(com, centre);
      const area = presentedArea(s);
      const expected = Math.min((propellant * EXPLOSION_IMPULSE_PER_KG * area) / (4 * Math.PI * Math.max(dist, Math.sqrt(area / Math.PI)) ** 2) / s.mp.mass, EXPLOSION_MAX_DELTA_V);
      log.push(`${s.parts[0]!.instanceId} (${(s.mp.mass / 1000).toFixed(1)} t, ${dist.toFixed(0)} m): ${dv.toFixed(1)} m/s`);
      expect(dv).toBeCloseTo(expected, 6);
      expect(dv).toBeLessThanOrEqual(EXPLOSION_MAX_DELTA_V + 1e-9);
      // Radially away from the blast.
      if (dv > 1e-9) expect(v3.dot(v3.normalize(v3.sub(s.v, v0)), v3.normalize(v3.sub(com, centre)))).toBeGreaterThan(0.999);
    }
    console.log(`M-1 explosion with ${(propellant / 1000).toFixed(0)} t aboard:\n  ${log.join('\n  ')}`);
    // The crewed upper stack (about 850 t, CoM 38 m from the blast) is shoved by some m/s; giving every
    // piece the same absolute impulse would put hundreds of m/s on an engine.
    expect(v3.len(v3.sub(v.v, v0))).toBeGreaterThan(2);
    expect(v3.len(v3.sub(v.v, v0))).toBeLessThan(12);
    expect(presentedArea(v)).toBeGreaterThan(300);
    expect(presentedArea(v)).toBeLessThan(700);
  });

  it('a joint loaded beyond its acceleration limit for 0.2 s breaks', () => {
    const env = makeEnv({ densityTable: STANDARD_DENSITY });
    const v = assembleInternal(defs, VEHICLE, { stagesAlreadyFired: 7 });
    // Ascent stage + capsule slamming engine-first into dense air at 4 km/s: about 16 g against joints rated 8-12 g.
    v.r = { x: 0, y: env.radius + 30000, z: 0 };
    v.v = { x: 0, y: -4000, z: 0 };
    const vessels = [v];
    let brokeAt = -1;
    let gAtBreak = 0;
    const events: SimEvent[] = [];
    for (let i = 0; i < 240 && brokeAt < 0; i++) {
      events.push(...runAll(vessels, env, DT, controls()));
      if (events.some((e) => e.type === 'jointBroken')) {
        brokeAt = (i + 1) * DT;
        gAtBreak = v.gLoad;
      }
    }
    expect(brokeAt).toBeGreaterThan(0.2);
    expect(brokeAt).toBeLessThan(1.0);
    expect(gAtBreak).toBeGreaterThan(8);
    expect(vessels.length).toBeGreaterThan(1);
  });

  it('sustained deceleration above 10 g kills the crew by dose', () => {
    const env = makeEnv({ densityTable: STANDARD_DENSITY });
    const v = assembleInternal(defs, VEHICLE, { stagesAlreadyFired: 8 });
    // Steep ballistic entry: -30 degrees at 11 km/s.
    const gamma = -30 * DEG;
    v.r = { x: 0, y: env.radius + 100000, z: 0 };
    v.v = { x: 11000 * Math.cos(gamma), y: 11000 * Math.sin(gamma), z: 0 };
    const nose = v3.neg(v3.normalize(v.v));
    v.q = quat.fromTo({ x: 0, y: 1, z: 0 }, nose);
    const vessels = [v];
    let peak = 0;
    const events = runAll(vessels, env, 40, controls(), () => {
      peak = Math.max(peak, v.gLoad);
    });
    expect(peak).toBeGreaterThan(20);
    const lost = events.find((e) => e.type === 'crewLost');
    expect(lost && lost.type === 'crewLost' ? lost.cause : '').toMatch(/G-LOC/);
    expect(v.crewAlive).toBe(false);
    expect(v.gDose).toBeGreaterThan(15);
    expect(v.parts[0]!.modules[0]).toMatchObject({ crewAlive: false });
  });
});

describe('reduced tier', () => {
  it('follows the full-fidelity trajectory of a spent stage and brings it down', () => {
    const mk = (): { env: FakeEnv; m1: Vessel } => {
      const env = makeEnv({ densityTable: STANDARD_DENSITY, heating: defs.bodies['earth']!.atmosphere!.heating, terrain: () => -100, ocean: { density: 1025 } });
      const stack = assembleInternal(defs, VEHICLE, { stagesAlreadyFired: 1 });
      for (const p of stack.parts) if (p.def.id === 'meridian-m1') p.resources = [0, 0];
      const m1 = splitForStage(defs, stack, 1).spawned[0]!;
      m1.r = { x: 0, y: env.radius + 70000, z: 0 };
      m1.v = { x: 2000, y: 900, z: 0 };
      return { env, m1 };
    };
    const full = mk();
    run(full.m1, full.env, 60, controls());
    const red = mk();
    for (let i = 0; i < 120; i++) {
      const res = stepVesselReduced(red.m1, red.env, 0.5);
      red.env.advance(0.5);
      expect(res.removed).toBeNull();
    }
    // 60 s of mostly ballistic flight: the point-mass track agrees within a few hundred metres over 130 km.
    expect(v3.dist(red.m1.r, full.m1.r)).toBeLessThan(600);
    let result = stepVesselReduced(red.m1, red.env, 0.5);
    for (let i = 0; i < 2000 && result.removed === null; i++) {
      red.env.advance(0.5);
      result = stepVesselReduced(red.m1, red.env, 0.5);
    }
    expect(result.removed).toBe('impact');
    const downrange = Math.acos(result.impactDirFixed!.y) * red.env.radius;
    expect(downrange).toBeGreaterThan(300e3);
    expect(downrange).toBeLessThan(900e3);
    expect(red.m1.age).toBeGreaterThan(200);
  });

  it('a spent upper stage re-entering at orbital speed burns up; a light fairing panel flutters down', () => {
    const fall = (pick: (stack: Vessel) => Vessel): { result: ReturnType<typeof stepVesselReduced>; vessel: Vessel; peakFlux: number } => {
      const env = makeEnv({ densityTable: STANDARD_DENSITY, heating: defs.bodies['earth']!.atmosphere!.heating });
      const vessel = pick(assembleInternal(defs, VEHICLE, { stagesAlreadyFired: 2 }));
      vessel.r = { x: 0, y: env.radius + 95000, z: 0 };
      vessel.v = { x: 7600, y: -150, z: 0 };
      let peakFlux = 0;
      let result = stepVesselReduced(vessel, env, 0.5);
      for (let i = 0; i < 6000 && result.removed === null; i++) {
        env.advance(0.5);
        result = stepVesselReduced(vessel, env, 0.5);
        peakFlux = Math.max(peakFlux, vessel.aero.heatFlux);
      }
      return { result, vessel, peakFlux };
    };
    // M-2 with empty tanks: dense enough to carry its speed down to where the flux exceeds what an
    // aluminium-lithium skin (800 K) can radiate away.
    const m2 = fall((stack) => {
      for (const p of stack.parts) if (p.def.id === 'meridian-m2') p.resources = [0, 0];
      const after3 = splitForStage(defs, splitForStage(defs, stack, 2).vessel, 3);
      return after3.spawned[0]!;
    });
    expect(m2.result.removed).toBe('burnedUp');
    expect(m2.peakFlux).toBeGreaterThan(5e4);
    // A 1.5 t panel with 45 m^2 of area sheds its speed high up and reaches the ground.
    const panel = fall((stack) => splitForStage(defs, stack, 2).spawned.find((x) => x.id.includes('#panel'))!);
    expect(panel.result.removed).toBe('impact');
  });
});

/** A scripted but chaotic flight from the pad: random controls, staging, aborts and toggles. */
function chaos(seed: number, seconds: number, check?: (vessels: Vessel[], t: number) => void): { vessels: Vessel[]; events: number; hash: string } {
  const rng = new Prng(seed);
  const env = makeEnv({ densityTable: STANDARD_DENSITY, heating: defs.bodies['earth']!.atmosphere!.heating, spinRate: 7.2921159e-5, terrain: (d) => 30 * Math.sin(d.x * 4000) * Math.cos(d.z * 3000), ocean: { density: 1025 } });
  const v = assembleInternal(defs, VEHICLE);
  placeUpright(v, env, 150);
  const vessels = [v];
  let events = 0;
  const c: ControlInputs = { ...NEUTRAL_CONTROLS, translate: v3.zero() };
  const steps = Math.round(seconds / DT);
  for (let i = 0; i < steps; i++) {
    if (i % 30 === 0) {
      c.pitch = rng.range(-1, 1);
      c.yaw = rng.range(-1, 1);
      c.roll = rng.range(-1, 1);
      c.throttle = rng.next() < 0.15 ? 0 : rng.range(0.3, 1);
      c.translate = { x: rng.range(-1, 1), y: rng.range(-1, 1), z: rng.range(-1, 1) };
      const dice = rng.next();
      if (dice < 0.22) {
        const res = fireNextStage(v, env);
        vessels.push(...res.spawned);
        events += res.events.length;
      } else if (dice < 0.25 && i > 3000) {
        const res = abort(v, env);
        vessels.push(...res.spawned);
        events += res.events.length;
      } else if (dice < 0.35) setSasEnabled(v, !v.sas.enabled);
      else if (dice < 0.42) setRcsEnabled(v, !v.rcsEnabled);
      else if (dice < 0.5) {
        setSasMode(v, rng.next() < 0.5 ? 'stability' : 'prograde');
        setSasHoldDirection(v, v3.normalize({ x: rng.range(-1, 1), y: rng.range(-1, 1), z: rng.range(-1, 1) }));
      } else if (dice < 0.55) toggleLegs(v, env.ut);
    }
    for (let k = 0; k < vessels.length; k++) {
      const x = vessels[k]!;
      if (x.destroyed) continue;
      const res = stepVessel(x, env, k === 0 ? c : NEUTRAL_CONTROLS, DT);
      events += res.events.length;
      vessels.push(...res.spawned);
    }
    env.advance(DT);
    if (check && i % 60 === 0) check(vessels, i * DT);
  }
  let all = '';
  for (const x of vessels) all += vesselStateHash(x);
  return { vessels, events, hash: all };
}

describe('robustness', () => {
  it('fuzz: 60 s of random controls, staging and aborts never produce a NaN', () => {
    for (const seed of [1, 2, 3]) {
      const res = chaos(seed, 60, (vessels, t) => {
        for (const x of vessels) {
          if (!x.destroyed) expect(isFiniteVessel(x), `seed ${seed}, ${x.id} at ${t.toFixed(1)} s`).toBe(true);
        }
      });
      expect(res.vessels.length).toBeGreaterThan(1);
      expect(res.events).toBeGreaterThan(10);
      for (const x of res.vessels) {
        if (x.destroyed) continue;
        expect(isFiniteVessel(x)).toBe(true);
        expect(Number.isFinite(x.mp.mass) && x.mp.mass > 0).toBe(true);
      }
    }
  }, 180000);

  it('determinism: two runs of the same script end in the identical hash', () => {
    const a = chaos(7, 40);
    const b = chaos(7, 40);
    expect(b.hash).toBe(a.hash);
    expect(b.events).toBe(a.events);
    expect(a.hash.length).toBeGreaterThanOrEqual(32);
    const c = chaos(8, 40);
    expect(c.hash).not.toBe(a.hash);
  }, 180000);

  it('timing: one step of the full stack takes less than 80 microseconds', () => {
    const env = makeEnv({ densityTable: STANDARD_DENSITY, heating: defs.bodies['earth']!.atmosphere!.heating });
    const v = assembleInternal(defs, VEHICLE, { stagesAlreadyFired: 1 });
    // Ascent near max-q: all nine engines burning, SAS holding, aerodynamics and heating active.
    v.r = { x: 0, y: env.radius + 12000, z: 0 };
    v.q = quat.fromAxisAngle({ x: 0, y: 0, z: 1 }, -20 * DEG);
    v.v = v3.scale(quat.rotate(v.q, { x: 0, y: 1, z: 0 }), 450);
    setSasEnabled(v, true);
    const c = controls({ throttle: 1 });
    for (let i = 0; i < 3000; i++) {
      stepVessel(v, env, c, DT);
      env.advance(DT);
    }
    expect(v.parts).toHaveLength(38);
    expect(v.aero.q).toBeGreaterThan(5000);
    const batches: number[] = [];
    for (let b = 0; b < 7; b++) {
      const t0 = performance.now();
      const n = 2000;
      for (let i = 0; i < n; i++) {
        stepVessel(v, env, c, DT);
        env.advance(DT);
      }
      batches.push(((performance.now() - t0) / n) * 1000);
    }
    batches.sort((x, y) => x - y);
    console.log(`full-stack step (38 parts, 9 engines burning, in atmosphere): best ${batches[0]!.toFixed(1)} us, median ${batches[3]!.toFixed(1)} us, worst ${batches[6]!.toFixed(1)} us per step`);
    expect(v.parts).toHaveLength(38);
    expect(batches[0]!).toBeLessThan(80);
  }, 60000);
});
