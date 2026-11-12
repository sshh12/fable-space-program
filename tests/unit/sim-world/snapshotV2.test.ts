/**
 * The session speaks the v2 snapshot (MIGRATION_V2 step 3.5; ARCHITECTURE section 3 and 7.2): the render
 * root at the active vessel's SOI body with a frame epoch and a rebase when it changes, a private clock,
 * the revision, craft blocks with stage figures and chase hints, part keys. The deprecated fields are
 * still filled, and the deprecated `createSim` keeps the v1 render root.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { DefLibrary } from '@/core/contracts/defs';
import type { SimSnapshot } from '@/core/contracts/sim';
import type { TerrainProvider } from '@/core/contracts/terrain';
import { FrameEpochTracker, rebasePoint, rebaseVelocity } from '@/core/math/frame';
import { v3 } from '@/core/math/vec3';
import { createSession, diagnosticsOf } from '@/session';
import { createSim } from '@/sim';
import { nearestTick } from '@/sim/clock';
import { active, controls, flatTerrain, loadLibrary, makeSim, orbitScenario, stepUntil } from './helpers';

let defs: DefLibrary;
let terrain: TerrainProvider;
beforeAll(async () => {
  defs = await loadLibrary();
  terrain = flatTerrain(defs, { earth: -100, moon: 0 });
});

const body = (s: SimSnapshot, id: string) => s.bodies.find((b) => b.id === id)!;

/** Advance on rails until the active vessel is in the sphere of influence of `bodyId`. */
function coastInto(sim: { peek(): SimSnapshot; advanceRails(t: number): number; nextEventUt: number; step(): void }, bodyId: string): void {
  for (let guard = 0; guard < 4000 && active(sim.peek()).bodyId !== bodyId; guard++) {
    const before = sim.peek().simUt;
    if (!(sim.advanceRails(Math.min(sim.nextEventUt, before + 20000)) > before)) sim.step();
  }
}

describe('the render root', () => {
  it('is the centre of the active vessel SOI body: that body at the origin, the vessel at its body-centred state', async () => {
    const sim = await makeSim(defs, 'qa-translunar', terrain);
    const s = sim.snapshot();
    expect(s.frame).toEqual({ epoch: 0, origin: { kind: 'body', bodyId: 'earth' }, rebase: null, previous: [] });
    expect(body(s, 'earth').rRoot).toEqual({ x: 0, y: 0, z: 0 });
    expect(active(s).rRoot).toEqual(active(s).r);
    expect(active(s).vRoot).toEqual(active(s).v);
    // A session that starts at the Moon starts with the Moon at the origin, in epoch 0.
    const lunar = await makeSim(defs, 'qa-lunar-orbit', terrain);
    const l = lunar.snapshot();
    expect(l.frame).toEqual({ epoch: 0, origin: { kind: 'body', bodyId: 'moon' }, rebase: null, previous: [] });
    expect(body(l, 'moon').rRoot).toEqual({ x: 0, y: 0, z: 0 });
    expect(v3.len(body(l, 'earth').rRoot)).toBeGreaterThan(3.5e8);
    expect(active(l).rRoot).toEqual(active(l).r);
    // A patch about the origin body ends with that body at the origin.
    for (const p of l.patches.current.filter((x) => x.bodyId === 'moon')) expect(p.bodyPosAtEnd).toEqual({ x: 0, y: 0, z: 0 });
  });

  it('is replaced at a sphere-of-influence change: a new epoch, a rebase that carries held positions over, the old origin in every later snapshot', async () => {
    const sim = await makeSim(defs, 'qa-translunar', terrain);
    const tracker = new FrameEpochTracker();
    const before = sim.snapshot();
    expect(tracker.observe(before.frame!)).toBeNull();
    // What a camera rig would hold: a point 40 m beside the vessel, and the vessel's ROOT velocity.
    const heldOffset = { x: 40, y: -10, z: 5 };
    coastInto(sim, 'moon');

    // peek() shows the pending rebase and does not drain it.
    const peeked = sim.peek();
    expect(peeked.frame!.epoch).toBe(1);
    expect(peeked.frame!.origin).toEqual({ kind: 'body', bodyId: 'moon' });
    expect(peeked.frame!.rebase).not.toBeNull();
    expect(sim.peek().frame!.rebase).not.toBeNull();

    const s = sim.snapshot();
    const frame = s.frame!;
    expect(frame.epoch).toBe(1);
    // The rebase is the old origin (the Earth) in the new frame at this snapshot's time.
    expect(frame.rebase!.offset).toEqual(body(s, 'earth').rRoot);
    expect(frame.rebase!.velocity).toEqual(body(s, 'earth').vRoot);
    expect(frame.previous).toEqual([{ epoch: 0, offset: body(s, 'earth').rRoot, velocity: body(s, 'earth').vRoot }]);
    expect(body(s, 'moon').rRoot).toEqual({ x: 0, y: 0, z: 0 });
    expect(active(s).rRoot).toEqual(active(s).r);

    // A position held in the old frame, rebased, is where it should be in the new one: the Earth-centred
    // position of "40 m beside the vessel" plus the rebase equals the Moon-centred one, to float rounding.
    const rebase = tracker.observe(frame)!;
    expect(rebase).toEqual(frame.rebase);
    const earthCentred = v3.add(v3.sub(active(s).rRoot, body(s, 'earth').rRoot), heldOffset);
    const carried = rebasePoint(earthCentred, rebase);
    expect(v3.dist(carried, v3.add(active(s).rRoot, heldOffset))).toBeLessThan(1e-6);
    expect(v3.dist(rebaseVelocity(v3.sub(active(s).vRoot, body(s, 'earth').vRoot), rebase), active(s).vRoot)).toBeLessThan(1e-9);

    // Drained: the next snapshot has no rebase, and still says where the old origin is now.
    sim.step();
    const next = sim.snapshot();
    expect(next.frame!.epoch).toBe(1);
    expect(next.frame!.rebase).toBeNull();
    expect(next.frame!.previous).toEqual([{ epoch: 0, offset: body(next, 'earth').rRoot, velocity: body(next, 'earth').vRoot }]);
    // A consumer that slept through the change rebases from the history.
    const sleeper = new FrameEpochTracker();
    sleeper.observe(before.frame!);
    expect(sleeper.observe(next.frame!)).toEqual({ offset: body(next, 'earth').rRoot, velocity: body(next, 'earth').vRoot });
    expect(next.cheatCounter).toBe(0);
  });

  it('the deprecated createSim keeps the v1 root: the library root body, one epoch, no rebase through the same change', async () => {
    const sim = createSim(defs, 'qa-translunar', { terrain });
    await sim.ready;
    coastInto(sim, 'moon');
    const s = sim.snapshot();
    expect(active(s).bodyId).toBe('moon');
    expect(s.frame).toEqual({ epoch: 0, origin: { kind: 'body', bodyId: defs.rootBodyId }, rebase: null, previous: [] });
    expect(body(s, defs.rootBodyId).rRoot).toEqual({ x: 0, y: 0, z: 0 });
    expect(v3.dist(active(s).rRoot, v3.add(body(s, 'moon').rRoot, active(s).r))).toBe(0);
    // The same flight through createSession ends in the same state: the render root is presentation only.
    const v2 = await makeSim(defs, 'qa-translunar', terrain);
    coastInto(v2, 'moon');
    expect(v2.stateHash()).toBe(sim.stateHash());
  });
});

describe('time, revision and the deprecated fields', () => {
  it('a private clock on the tick grid; revision beside the deprecated tick', async () => {
    const sim = await makeSim(defs, orbitScenario(defs.scenarios['lunar-direct']!, 't-v2-time', 'earth', 300000, 400000, 4), terrain);
    const s0 = sim.snapshot();
    expect(s0.time).toEqual({
      myTick: nearestTick(s0.simUt),
      liveTick: nearestTick(s0.simUt),
      rate: 1,
      maxRate: expect.any(Number),
      // 300 km up the altitude ladder of the body bounds the rate.
      limitedBy: { kind: 'altitude', text: 'Altitude too low for a higher warp level', vesselIds: [], accountIds: [] },
      relation: 'live',
      offset: 0,
      clockId: null,
      clockKind: 'private',
      members: [],
      proposals: [],
      offers: [],
    });
    expect(s0.revision).toBe(s0.tick);
    for (let i = 0; i < 5; i++) sim.step();
    const s1 = sim.snapshot();
    expect(s1.time!.myTick).toBe(s0.time!.myTick + 5);
    expect(s1.revision).toBe(s0.revision! + 5);
    expect(s1.tick).toBe(s1.revision);
    sim.commands.setWarpLevel(6);
    sim.advance(1 / 60);
    const s2 = sim.snapshot();
    expect(s2.time!.rate).toBe(s2.warp.factor);
    expect(s2.time!.rate).toBeGreaterThan(1);
    expect(s2.time!.maxRate).toBeGreaterThanOrEqual(s2.time!.rate);
    // The deprecated target fields are still there.
    expect(s2.readouts.targetBodyId).toBe('moon');
    expect('targetClosestApproach' in s2.readouts).toBe(true);
    // A burn bounds the clock: physics warp only, and the strip says why.
    sim.setControls(controls({ throttle: 1 }));
    sim.commands.stage();
    stepUntil(sim, (x) => x.readouts.thrust > 0, 600);
    const burning = sim.snapshot();
    expect(burning.time!.limitedBy).toMatchObject({ kind: 'physics', vesselIds: [], accountIds: [] });
    expect(burning.time!.limitedBy!.text).toBe(burning.warp.limitedBy);
  });
});

describe('craft blocks and part keys', () => {
  it('the active vessel: one craft with the staging panel figures, chase hints, command part, helm and part keys', async () => {
    const sim = await makeSim(defs, 'qa-leo', terrain);
    const s = sim.snapshot();
    const v = active(s);
    const vehicle = defs.vehicles['meridian-lunar']!;
    expect(v.crafts).toHaveLength(1);
    const craft = v.crafts![0]!;
    expect(craft.id).toBe(v.id);
    expect(craft).toMatchObject({ vehicleId: 'meridian-lunar', name: vehicle.name, ownerId: null, ownerCallsign: null, commandPart: 'capsule', chase: vehicle.cameras.chase });
    expect(craft.policy).toEqual({ lendAttitude: true, lendEngines: false, lendPropellant: false, helm: 'crew' });
    expect(craft.staging.nextStage).toBe(s.staging.nextStage);
    expect(craft.staging.lockout).toBe(s.staging.lockout);
    expect(craft.staging.stages).toEqual(s.staging.stages);
    expect(craft.staging.stages.length).toBe(vehicle.stages.length);
    expect(v.links).toEqual([]);
    expect(v.helm).toEqual({ accountId: null, callsign: null, craftId: v.id, controlPart: `${v.id}/capsule` });
    expect(v.presence).toBe('solid');
    expect(v.timeOffset).toBe(0);
    for (const p of v.parts) {
      expect(p.craftId).toBe(v.id);
      const placement = vehicle.parts.find((x) => x.id === p.instanceId)!;
      expect(p.stageGroup).toBe(placement.stageGroup);
      expect(p.stageLabel).toBe(vehicle.stageGroups.find((g) => g.id === placement.stageGroup)!.label);
    }
    expect(v.boundingRadius).toBeGreaterThan(5);
  });

  it('debris carries its craft: the id of the craft it came from, no command part, no stages; the vessel revision moves with the orbit', async () => {
    // The trans-Earth coast: the next stage is the capsule separation, which leaves the ascent stage behind.
    const sim = await makeSim(defs, 'qa-trans-earth', terrain);
    const r0 = active(sim.snapshot()).revision!;
    expect(sim.commands.stage().ok).toBe(true);
    stepUntil(sim, (x) => x.vessels.length > 1, 2400);
    const s = sim.snapshot();
    expect(s.vessels.length).toBeGreaterThan(1);
    const v = active(s);
    const debris = s.vessels.find((x) => x.id !== v.id)!;
    expect(debris.id.startsWith(`${v.id}~`)).toBe(true);
    expect(debris.crafts).toHaveLength(1);
    expect(debris.crafts![0]).toMatchObject({ id: v.id, vehicleId: 'meridian-lunar', commandPart: null });
    expect(debris.crafts![0]!.staging.stages).toEqual([]);
    expect(debris.controllable).toBe(false);
    for (const p of debris.parts) expect(p.craftId).toBe(v.id);
    // The separation pushed the capsule onto another orbit: once it coasts on rails again its revision has moved.
    expect(stepUntil(sim, (x) => active(x).translationMode === 'rails', 60000)).toBeGreaterThan(0);
    expect(active(sim.snapshot()).revision!).toBeGreaterThan(r0);
  });
});

describe('createSession', () => {
  it('gives the session as a LocalSession and its diagnostics apart', async () => {
    const session = createSession(defs, 'qa-leo', { terrain });
    await session.ready;
    expect(session.scenario.id).toBe('qa-leo');
    session.step();
    const d = diagnosticsOf(session);
    expect(d.stats().steps).toBe(1);
    expect(d.debrisLog()).toEqual([]);
    expect(session.peek().frame!.origin).toEqual({ kind: 'body', bodyId: 'earth' });
    expect(() => diagnosticsOf({} as never)).toThrow(/not a session made by createSession/);
  });
});
