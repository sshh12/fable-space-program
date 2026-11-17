/**
 * The fake session against the real one (ARCHITECTURE 17.1: "each of its scenes has a conformance test against
 * the output of a real LocalSession in the same situation: field presence, units, frames, value ranges"), and
 * the scenes of the shared universe, which no session produces yet, against the contract and themselves.
 *
 * The real session is `createSession` on flat terrain at the QA scenarios (tests/unit/sim-world/helpers.ts).
 * The situations a session has today and the fake's scene for each:
 *   pad -> lunar-direct (on the pad), lowOrbit -> qa-leo, translunar -> qa-translunar,
 *   lunarOrbit -> qa-lunar-orbit, lunarSurface -> qa-lunar-surface, reentry -> qa-entry, chutes -> qa-drogues.
 * `ascent` has no scenario of its own: it is held against the pad session's shape (the same vessel, climbing).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { DefLibrary } from '@/core/contracts/defs';
import { TICKS_PER_SECOND } from '@/core/contracts/net';
import type { SimSnapshot, VesselSnapshot } from '@/core/contracts/sim';
import type { TerrainProvider } from '@/core/contracts/terrain';
import { createFakeSim } from '@/core/fakes/fakeSim';
import {
  createFakeSession,
  FAKE_ASSEMBLY_ID,
  FAKE_ECHO_PROJECTED_ID,
  FAKE_ECHO_RECORDED_ID,
  FAKE_SCENES,
  FAKE_STATION_ID,
  FAKE_TARGET_ID,
  FAKE_V2_SCENES,
  FAKE_VESSEL_ID,
  type FakeScene,
} from '@/core/fakes/fakeSession';
import { activeVesselOf, craftIdOf, partKeyOf, revisionOf, targetOf } from '@/core/fakes/snapshotAccess';
import { FRAME_HISTORY_EPOCHS, FrameEpochTracker, rebasePoint, rebaseVelocity } from '@/core/math/frame';
import { quat } from '@/core/math/quat';
import { v3 } from '@/core/math/vec3';
import { assembleVessel, vesselPartSnapshots } from '@/sim/vessel/public';
import { flatTerrain, loadLibrary, makeSim } from '../sim-world/helpers';

let defs: DefLibrary;
let terrain: TerrainProvider;
const VEHICLE = 'meridian-lunar';

beforeAll(async () => {
  defs = await loadLibrary();
  terrain = flatTerrain(defs, { earth: -100, moon: 0 });
});

const SCENARIO_OF: Record<FakeScene, string> = {
  pad: 'lunar-direct',
  ascent: 'lunar-direct',
  lowOrbit: 'qa-leo',
  translunar: 'qa-translunar',
  lunarOrbit: 'qa-lunar-orbit',
  lunarSurface: 'qa-lunar-surface',
  reentry: 'qa-entry',
  chutes: 'qa-drogues',
};

const fake = (scene: FakeScene): SimSnapshot => {
  const stages = defs.scenarios[SCENARIO_OF[scene]]!.stagesAlreadyFired;
  return createFakeSession(defs, { scene, vehicleId: VEHICLE, parts: vesselPartSnapshots(assembleVessel(defs, VEHICLE, { stagesAlreadyFired: stages })) }).snapshot();
};

const real = async (scene: FakeScene): Promise<SimSnapshot> => (await makeSim(defs, SCENARIO_OF[scene], terrain)).snapshot();

/**
 * Where two values do not state the same fields: the paths at which one object has a key the other lacks (an
 * optional field one producer leaves out), or the two hold values of different types. A null on either side
 * is a nullable field in another situation (no target, no orbit, no chute stage) and says nothing; arrays are
 * compared by their first elements when both have one.
 */
function fieldDifferences(a: unknown, b: unknown, path = ''): string[] {
  if (a === null || b === null) return [];
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return [`${path}: array against ${typeof (Array.isArray(a) ? b : a)}`];
    return a.length > 0 && b.length > 0 ? fieldDifferences(a[0], b[0], `${path}[0]`) : [];
  }
  if (typeof a !== typeof b) return [`${path}: ${typeof a} against ${typeof b}`];
  if (typeof a !== 'object') return [];
  const out: string[] = [];
  const ra = a as Record<string, unknown>;
  const rb = b as Record<string, unknown>;
  for (const key of new Set([...Object.keys(ra), ...Object.keys(rb)])) {
    const has = [ra[key] !== undefined, rb[key] !== undefined];
    if (has[0] !== has[1]) out.push(`${path}.${key}: ${has[0] ? 'only in the first' : 'only in the second'}`);
    else if (has[0]) out.push(...fieldDifferences(ra[key], rb[key], `${path}.${key}`));
  }
  return out;
}

const isUnit = (v: { x: number; y: number; z: number }): boolean => Math.abs(v3.len(v) - 1) < 1e-9;
const isUnitQuat = (q: { x: number; y: number; z: number; w: number }): boolean => Math.abs(Math.hypot(q.x, q.y, q.z, q.w) - 1) < 1e-9;

/** What must hold of ANY session's snapshot: the frames and units the contract states. */
function expectContract(s: SimSnapshot, label: string): void {
  const active = activeVesselOf(s)!;
  expect(active, `${label}: the active vessel is in the snapshot`).not.toBeNull();
  const origin = s.frame!.origin;
  expect(origin.kind, label).toBe('body');
  // The render root is the centre of the active vessel's SOI body: that body at the origin, the vessel at its body-centred state.
  if (origin.kind === 'body') {
    const body = s.bodies.find((b) => b.id === origin.bodyId)!;
    expect(v3.len(body.rRoot), `${label}: origin body at the origin`).toBe(0);
    expect(v3.len(body.vRoot), label).toBe(0);
    expect(origin.bodyId, `${label}: the origin is the active vessel's SOI body`).toBe(active.bodyId);
  }
  expect(Array.isArray(s.frame!.previous), `${label}: the frame history is filled`).toBe(true);
  expect(s.simUt - s.ut).toBeGreaterThanOrEqual(0);
  expect(s.simUt - s.ut).toBeLessThan(1 / 120 + 1e-9);
  expect(revisionOf(s), label).toBe(s.revision);
  // The clock: ticks of 1/120 s of the snapshot's own time.
  expect(Math.abs(s.time!.myTick - s.simUt * TICKS_PER_SECOND), `${label}: myTick is the tick of simUt`).toBeLessThanOrEqual(1);
  expect(s.time!.myTick - s.time!.liveTick, label).toBe(s.time!.offset);
  expect(s.time!.relation, label).toBe(s.time!.offset === 0 ? 'live' : s.time!.offset > 0 ? 'ahead' : 'behind');
  for (const v of s.vessels) {
    const body = s.bodies.find((b) => b.id === v.bodyId)!;
    // rRoot = the body's ROOT position + the body-centred state (differences only: no origin is assumed).
    expect(v3.dist(v3.sub(v.rRoot, body.rRoot), v.r), `${label} ${v.id}: rRoot - body = r`).toBeLessThan(1e-6 * Math.max(1, v3.len(v.r)));
    expect(v3.dist(v3.sub(v.vRoot, body.vRoot), v.v), `${label} ${v.id}: vRoot - body = v`).toBeLessThan(1e-9 * Math.max(1, v3.len(v.v)) + 1e-9);
    expect(isUnitQuat(v.q), `${label} ${v.id}: unit attitude`).toBe(true);
    expect(v.boundingRadius).toBeGreaterThan(0);
    expect(v.mass).toBeGreaterThan(0);
    // Craft blocks: every part belongs to a craft of its vessel; part keys are unique in the vessel.
    const crafts = v.crafts!;
    expect(crafts.length, `${label} ${v.id}: at least one craft`).toBeGreaterThan(0);
    const craftIds = new Set(crafts.map((c) => c.id));
    for (const p of v.parts) expect(craftIds.has(craftIdOf(v, p)), `${label} ${v.id}/${p.instanceId}: the part's craft is a craft of the vessel`).toBe(true);
    expect(new Set(v.parts.map((p) => partKeyOf(v, p))).size, `${label} ${v.id}: part keys are unique`).toBe(v.parts.length);
    for (const c of crafts) {
      expect(c.chase.minDistance, label).toBeGreaterThan(0);
      expect(c.chase.maxDistance, label).toBeGreaterThanOrEqual(c.chase.defaultDistance);
      expect(c.chase.defaultDistance, label).toBeGreaterThanOrEqual(c.chase.minDistance);
      if (c.commandPart !== null) expect(v.parts.some((p) => p.instanceId === c.commandPart && craftIdOf(v, p) === c.id), `${label}: the command part is a part of the craft`).toBe(true);
      // No id of a craft contains the separators of a part key or a derived vessel id.
      expect(c.id.includes('/') || c.id.includes('~'), label).toBe(false);
    }
    expect(crafts.some((c) => c.id === v.helm!.craftId), `${label} ${v.id}: the helm's craft is aboard`).toBe(true);
    for (const l of v.links ?? []) for (const key of [l.a, l.b]) expect(craftIds.has(key.slice(0, key.lastIndexOf('/'))), `${label}: a dock link joins craft of the vessel`).toBe(true);
  }
  // The singleton blocks describe the active vessel: unit marker directions in the vessel frame.
  const m = s.navball.markers;
  for (const d of [m.prograde, m.retrograde, m.normal, m.antinormal, m.radialOut, m.radialIn]) expect(isUnit(d), `${label}: navball markers are unit vectors`).toBe(true);
  expect(isUnitQuat(s.navball.qVesselToHorizon), label).toBe(true);
  expect(s.readouts.latitude).toBeGreaterThanOrEqual(-Math.PI / 2);
  expect(s.readouts.latitude).toBeLessThanOrEqual(Math.PI / 2);
  expect(s.readouts.throttle).toBeGreaterThanOrEqual(0);
  expect(s.readouts.throttle).toBeLessThanOrEqual(1);
  for (const b of s.bodies) {
    expect(isUnitQuat(b.qFixedToRoot), label).toBe(true);
    if (b.id !== s.starId) expect(isUnit(b.sunDir), `${label}: sunDir of ${b.id}`).toBe(true);
  }
  for (const p of [...s.patches.current, ...s.patches.planned]) {
    // A patch about the origin body ends with that body at the origin.
    if (origin.kind === 'body' && p.bodyId === origin.bodyId) expect(v3.len(p.bodyPosAtEnd), `${label}: bodyPosAtEnd of a patch about the origin body`).toBe(0);
  }
}

describe('conformance: the fake session against createSession in the same situation', () => {
  for (const scene of FAKE_SCENES) {
    it(`${scene} (${SCENARIO_OF[scene]}): the same fields, frames, units and ranges`, async () => {
      const f = fake(scene);
      const r = await real(scene);
      expectContract(f, `fake ${scene}`);
      expectContract(r, `real ${SCENARIO_OF[scene]}`);

      // Field presence: the snapshot, its singleton blocks and the active vessel state the same fields. (What
      // the fake states and no session produces yet, the navigation readouts of wave 4, is taken out first.)
      const strip = (s: SimSnapshot): Record<string, unknown> => {
        const { target: _t, docking: _d, ...readouts } = s.readouts;
        const { relativePrograde: _p, relativeRetrograde: _r, ...markers } = s.navball.markers;
        const { vessels: _v, events: _e, milestones: _m, patches, ...top } = s;
        // A patch without what depends on how it ends and on the kinds of its markers (compared by kind below).
        const bare = (list: SimSnapshot['patches']['current']): unknown[] => list.map(({ markers: _mk, nextBodyId: _nb, afterNodeId: _an, ...p }) => p);
        return { ...top, readouts, navball: { ...s.navball, markers }, patches: { current: bare(patches.current), planned: bare(patches.planned) } };
      };
      expect(fieldDifferences(strip(f), strip(r))).toEqual([]);
      // Markers of one kind state the same fields (the sub-point of an apsis is optional in the contract).
      const markersOf = (s: SimSnapshot): SimSnapshot['patches']['current'][number]['markers'] => s.patches.current.flatMap((p) => p.markers);
      for (const m of markersOf(f)) {
        const twin = markersOf(r).find((x) => x.kind === m.kind);
        if (!twin) continue;
        const { latitude: _la, longitude: _lo, ...rest } = twin;
        expect(fieldDifferences(m, rest), `marker ${m.kind}`).toEqual([]);
      }
      const fv = activeVesselOf(f)!;
      const rv = activeVesselOf(r)!;
      expect(fieldDifferences({ ...fv, parts: [] }, { ...rv, parts: [] })).toEqual([]);
      // A part: the same fields, the same part of the same craft (the fake is given the session's own part list).
      expect(fieldDifferences({ ...fv.parts[0]!, modules: [], resources: {} }, { ...rv.parts[0]!, modules: [], resources: {} })).toEqual([]);
      expect(fv.parts.map((p) => p.instanceId)).toEqual(rv.parts.map((p) => p.instanceId));
      expect(fv.parts.map((p) => [p.stageGroup, p.stageLabel])).toEqual(rv.parts.map((p) => [p.stageGroup, p.stageLabel]));

      // The same situation: the same body, the same origin, the craft of the same vehicle with the same cabin and
      // chase distances; a vessel of one launched craft has that craft's id.
      expect(f.frame!.origin).toEqual(r.frame!.origin);
      expect(f.frame!.epoch).toBe(0);
      expect(f.frame!.rebase).toBeNull();
      expect(fv.bodyId).toBe(rv.bodyId);
      expect(fv.crafts!.length).toBe(1);
      expect(fv.crafts![0]!.id).toBe(fv.id);
      expect(rv.crafts![0]!.id).toBe(rv.id);
      const same = (v: VesselSnapshot): unknown => {
        const c = v.crafts![0]!;
        return { vehicleId: c.vehicleId, parent: c.parent, commandPart: c.commandPart, cockpit: c.cockpit, chase: c.chase, policy: c.policy, links: v.links, presence: v.presence, timeOffset: v.timeOffset };
      };
      expect(same(fv)).toEqual(same(rv));
      expect(f.time!.clockKind).toBe(r.time!.clockKind);
      expect(f.time!.relation).toBe('live');

      // Value ranges, in the units of the contract: the fake is in the same regime as the flight it stands for.
      const speed = (v: VesselSnapshot): number => v3.len(v.v);
      const radius = (v: VesselSnapshot): number => v3.len(v.r);
      const bodyRadius = defs.bodies[fv.bodyId]!.radius;
      if (scene === 'ascent') {
        // No session starts in a climb: the fake's ascent is the pad's vessel a few kilometres up, in the air.
        expect(radius(fv) - bodyRadius).toBeGreaterThan(1000);
        expect(radius(fv) - bodyRadius).toBeLessThan(150e3);
        expect(fv.aero.pressure).toBeGreaterThan(0);
      } else {
        // Within a factor of the real flight's altitude and speed (metres, metres per second). The entry is the
        // widest: the scenario starts on the way down to the interface, the fake stands at peak heating.
        const altF = radius(fv) - bodyRadius;
        const altR = radius(rv) - bodyRadius;
        if (Math.abs(altR) > 1000) {
          expect(altF / altR, `${scene}: altitude ${altF} against ${altR}`).toBeGreaterThan(scene === 'reentry' ? 0.05 : 0.1);
          expect(altF / altR, `${scene}: altitude ${altF} against ${altR}`).toBeLessThan(10);
        } else expect(Math.abs(altF), `${scene}: on the ground`).toBeLessThan(5000);
        expect(speed(fv) / speed(rv), `${scene}: speed ${speed(fv)} against ${speed(rv)}`).toBeGreaterThan(0.3);
        expect(speed(fv) / speed(rv), `${scene}: speed`).toBeLessThan(3);
      }
      expect(f.readouts.altitudeAsl).toBeCloseTo(radius(fv) - bodyRadius, 3);
      expect(f.readouts.speedOrbital).toBeCloseTo(speed(fv), 6);
    });
  }
});

describe('the fake session: frames', () => {
  it('states ROOT positions about the focus body by default and about the library root body on request, with the same differences', () => {
    const parts = vesselPartSnapshots(assembleVessel(defs, VEHICLE, { stagesAlreadyFired: 6 }));
    const focus = createFakeSession(defs, { scene: 'lunarOrbit', parts, vehicleId: VEHICLE }).snapshot();
    const root = createFakeSession(defs, { scene: 'lunarOrbit', parts, vehicleId: VEHICLE, renderRoot: 'rootBody' }).snapshot();
    expect(focus.frame!.origin).toEqual({ kind: 'body', bodyId: 'moon' });
    expect(root.frame!.origin).toEqual({ kind: 'body', bodyId: defs.rootBodyId });
    const moonF = focus.bodies.find((b) => b.id === 'moon')!;
    const moonR = root.bodies.find((b) => b.id === 'moon')!;
    expect(v3.len(moonF.rRoot)).toBe(0);
    expect(v3.len(moonR.rRoot)).toBeGreaterThan(3.5e8);
    // Every difference of two ROOT positions is the same in both frames (to the rounding of the far origin).
    for (const id of focus.bodies.map((b) => b.id)) {
      const a = v3.sub(focus.bodies.find((b) => b.id === id)!.rRoot, focus.vessels[0]!.rRoot);
      const b = v3.sub(root.bodies.find((x) => x.id === id)!.rRoot, root.vessels[0]!.rRoot);
      expect(v3.dist(a, b)).toBeLessThan(1e-6 * Math.max(1, v3.len(a)) * 1e-3 + 1e-6);
    }
    // Body-centred state, attitude and every readout are the same numbers.
    expect(focus.vessels[0]!.r).toEqual(root.vessels[0]!.r);
    expect(focus.vessels[0]!.q).toEqual(root.vessels[0]!.q);
    expect(focus.readouts).toEqual(root.readouts);
    expect(focus.navball).toEqual(root.navball);
  });

  it('the v1 name gives the same session: createFakeSim is createFakeSession', () => {
    for (const scene of FAKE_SCENES) {
      const a = createFakeSim(defs, { scene });
      const b = createFakeSession(defs, { scene });
      for (let i = 0; i < 5; i++) {
        a.advance(1 / 60);
        b.advance(1 / 60);
      }
      expect(a.snapshot()).toEqual(b.snapshot());
    }
  });

  it('is deterministic: the same options and calls give the same snapshots, bit for bit', () => {
    for (const scene of [...FAKE_SCENES, ...FAKE_V2_SCENES]) {
      const run = (): string => {
        const s = createFakeSession(defs, { scene });
        const out: SimSnapshot[] = [s.snapshot()];
        s.setControls({ pitch: 0.3, yaw: -0.1, roll: 0, translate: v3.zero(), throttle: 0.5 });
        for (let i = 0; i < 20; i++) s.advance(1 / 60);
        out.push(s.snapshot());
        for (let i = 0; i < 10; i++) s.step();
        out.push(s.peek());
        return JSON.stringify(out);
      };
      expect(run(), scene).toBe(run());
    }
  });

  it('replaces the render root as a sphere-of-influence change does: an epoch, a rebase that carries a held position over, the history', () => {
    const s = createFakeSession(defs, { scene: 'lunarOrbit' });
    const tracker = new FrameEpochTracker();
    const before = s.snapshot();
    expect(tracker.observe(before.frame)).toBeNull();
    const vessel = before.vessels[0]!;
    // What a rig holds: a point 40 m beside the vessel and the vessel's ROOT velocity.
    const held = v3.add(vessel.rRoot, v3.new(40, -10, 5));
    s.setRenderRoot(defs.rootBodyId);
    // peek() shows the pending rebase without draining it; snapshot() drains it.
    expect(s.peek().frame!.rebase).not.toBeNull();
    const after = s.snapshot();
    expect(after.frame!.epoch).toBe(1);
    expect(after.frame!.origin).toEqual({ kind: 'body', bodyId: defs.rootBodyId });
    expect(s.snapshot().frame!.rebase).toBeNull();
    const rebase = tracker.observe(after.frame)!;
    expect(rebase).not.toBeNull();
    const moved = rebasePoint(held, rebase);
    expect(v3.dist(moved, v3.add(after.vessels[0]!.rRoot, v3.new(40, -10, 5)))).toBeLessThan(1e-6);
    expect(v3.dist(rebaseVelocity(vessel.vRoot, rebase), after.vessels[0]!.vRoot)).toBeLessThan(1e-9);
    // The old origin is in every later snapshot, where it is then; a holder that slept through the change still rebases.
    for (let i = 0; i < 30; i++) s.advance(1 / 60);
    const later = s.snapshot();
    expect(later.frame!.previous!.map((p) => p.epoch)).toEqual([0]);
    const moon = later.bodies.find((b) => b.id === 'moon')!;
    expect(v3.dist(later.frame!.previous![0]!.offset, moon.rRoot)).toBeLessThan(1e-6);
    const sleeper = new FrameEpochTracker();
    sleeper.observe(before.frame);
    expect(sleeper.observe(later.frame)!.offset).toEqual(later.frame!.previous![0]!.offset);
    // Back and forth: the history is bounded and newest first.
    for (let i = 0; i < FRAME_HISTORY_EPOCHS + 3; i++) s.setRenderRoot(i % 2 === 0 ? 'moon' : defs.rootBodyId);
    const many = s.snapshot();
    expect(many.frame!.previous!.length).toBe(FRAME_HISTORY_EPOCHS);
    expect(many.frame!.previous![0]!.epoch).toBe(many.frame!.epoch - 1);
  });
});

describe('the fake session: scenes of the shared universe', () => {
  const v2 = (scene: (typeof FAKE_V2_SCENES)[number]): ReturnType<typeof createFakeSession> => createFakeSession(defs, { scene, vehicleId: VEHICLE, parts: vesselPartSnapshots(assembleVessel(defs, VEHICLE, { stagesAlreadyFired: 6 })) });

  it('every scene keeps the contract of a snapshot', () => {
    for (const scene of FAKE_V2_SCENES) {
      const s = v2(scene);
      expectContract(s.snapshot(), scene);
      for (let i = 0; i < 30; i++) s.advance(1 / 60);
      expectContract(s.snapshot(), `${scene} after half a second`);
    }
  });

  it('rendezvous: two craft, the other selected, a target readout that agrees with where the two are', () => {
    const session = v2('rendezvous');
    const s = session.snapshot();
    expect(s.vessels.map((v) => v.id)).toEqual([FAKE_VESSEL_ID, FAKE_TARGET_ID]);
    const [own, other] = s.vessels as [VesselSnapshot, VesselSnapshot];
    const t = s.readouts.target!;
    expect(t.ref).toEqual({ kind: 'vessel', id: FAKE_TARGET_ID });
    expect(targetOf(s.readouts)).toBe(t);
    expect(t.name).toBe(other.name);
    expect(t.presence).toBe('solid');
    expect(t.range).toBeCloseTo(v3.dist(own.rRoot, other.rRoot), 6);
    expect(t.range).toBeGreaterThan(1900);
    expect(t.range).toBeLessThan(2100);
    expect(t.relSpeed!).toBeCloseTo(v3.dist(own.vRoot, other.vRoot), 9);
    // The relative velocity is stated in the control frame: rotated back, it is the difference of the ROOT velocities.
    expect(v3.dist(quat.rotate(own.q, t.relVelocity!), v3.sub(own.vRoot, other.vRoot))).toBeLessThan(1e-9);
    // Lower and behind: the viewer is below the target and catches up.
    expect(t.lvlh!.radial).toBeCloseTo(-150, 0);
    expect(t.lvlh!.along).toBeLessThan(-1900);
    expect(t.rangeRate).toBeLessThan(0);
    expect(t.closestApproaches.length).toBeGreaterThanOrEqual(1);
    expect(t.closestApproaches[0]!.distance).toBeCloseTo(150, 6);
    expect(t.closestApproaches[0]!.ut).toBeGreaterThan(s.ut);
    // The range really is smallest there: step the fake to that time.
    session.advanceRails(t.closestApproaches[0]!.ut);
    const at = session.snapshot();
    expect(at.readouts.target!.range).toBeCloseTo(150, 0);
    // The holds and the navball mode that need a target are offered and taken; a body target withdraws them.
    expect(s.readouts.sasModesAvailable).toEqual(expect.arrayContaining(['target', 'antiTarget']));
    expect(s.readouts.sasModesAvailable).not.toContain('portAlign');
    expect(s.navball.markers.relativePrograde).not.toBeNull();
    expect(session.commands.setSasMode('target').ok).toBe(true);
    expect(session.commands.setNavballMode('target').ok).toBe(true);
    expect(session.commands.setSasMode('portAlign').ok).toBe(false);
    expect(session.commands.setTarget({ kind: 'body', id: 'moon' }).ok).toBe(true);
    const body = session.snapshot();
    expect(body.readouts.sasMode).toBe('stability');
    expect(body.navball.mode).toBe('orbit');
    expect(body.readouts.target!.ref).toEqual({ kind: 'body', id: 'moon' });
    expect(body.readouts.target!.relVelocity).toBeNull();
    expect(body.readouts.targetBodyId).toBe('moon');
    expect(session.commands.setTarget({ kind: 'vessel', id: 'no-such-vessel' }).ok).toBe(false);
    expect(session.commands.setTarget(null).ok).toBe(true);
    expect(session.snapshot().readouts.target).toBeNull();
  });

  it('dockingApproach: the docking readout, the port states, soft capture and hard dock as events', () => {
    const session = v2('dockingApproach');
    const s = session.snapshot();
    expect(s.vessels.map((v) => v.id)).toEqual([FAKE_VESSEL_ID, FAKE_STATION_ID]);
    const d = s.readouts.docking!;
    expect(s.readouts.target!.ref.kind).toBe('port');
    expect(d.ownPort).toBe(`${FAKE_VESSEL_ID}/port`);
    expect(d.targetPort).toBe(`${FAKE_STATION_ID}/port`);
    expect(s.vessels[0]!.helm!.controlPart).toBe(d.ownPort);
    expect(d.phase).toBe('approach');
    expect(d.axial).toBeCloseTo(v3.dist(s.vessels[0]!.rRoot, s.vessels[1]!.rRoot) - 1.2, 6);
    expect(d.closing).toBeCloseTo(0.1, 2);
    // Outside the lateral limit at first (0.4 m against 0.3), inside every other.
    expect(d.within).toEqual({ lateral: false, angle: true, roll: true, closing: true, lateralSpeed: true, rate: true });
    expect(s.readouts.sasModesAvailable).toContain('portAlign');
    expect(session.portStates().map((p) => [p.partKey, p.state.state, p.state.armed, p.state.peer])).toEqual([
      [d.ownPort, 'ready', true, null],
      [d.targetPort, 'ready', true, null],
    ]);
    // Fly the approach: 13.8 m at 0.1 m/s, then ten seconds of soft capture.
    const events: string[] = [];
    let last = s;
    for (let i = 0; i < 160 * 10 && last.readouts.docking?.phase !== 'hard'; i++) {
      session.advance(0.1);
      last = session.snapshot();
      for (const e of last.events) events.push(e.type);
    }
    expect(events).toEqual(['dockCapture', 'docked']);
    expect(last.readouts.docking!.phase).toBe('hard');
    expect(last.readouts.docking!.axial).toBeCloseTo(0, 6);
    expect(last.readouts.docking!.within.lateral).toBe(true);
    // Docked: the station's own vessel is gone, and each port names the other as its peer.
    expect(last.vessels.map((v) => v.id)).toEqual([FAKE_VESSEL_ID]);
    expect(session.portStates().map((p) => p.state.state)).toEqual(['hard', 'hard']);
    expect(session.portStates()[0]!.state.peer).toEqual({ vesselId: FAKE_STATION_ID, partKey: d.targetPort });
    expect(v2('lowOrbit' as never).portStates()).toEqual([]);
  });

  it('assembly: three craft of one vehicle in one vessel, links, the helm, a radius that spans them, the store', () => {
    const session = v2('assembly');
    const s = session.snapshot();
    expect(s.vessels.length).toBe(1);
    const v = s.vessels[0]!;
    expect(v.id).toBe(FAKE_ASSEMBLY_ID);
    expect(s.activeVesselId).toBe(FAKE_ASSEMBLY_ID);
    expect(v.crafts!.map((c) => c.id)).toEqual([FAKE_VESSEL_ID, 'fake-craft-b', 'fake-craft-c']);
    expect(new Set(v.crafts!.map((c) => c.vehicleId))).toEqual(new Set([VEHICLE]));
    expect(v.crafts!.map((c) => c.ownerCallsign)).toEqual(['YOU', 'VEGA', null]);
    expect(v.links!.length).toBe(2);
    expect(v.helm).toEqual({ accountId: 'fake-account', callsign: 'YOU', craftId: FAKE_VESSEL_ID, controlPart: `${FAKE_VESSEL_ID}/${v.parts[0]!.instanceId}` });
    // Three times the parts, the same instance ids in each craft, every part key once.
    const perCraft = v.parts.length / 3;
    expect(v.parts.slice(0, perCraft).map((p) => p.instanceId)).toEqual(v.parts.slice(perCraft, 2 * perCraft).map((p) => p.instanceId));
    expect(new Set(v.parts.map((p) => partKeyOf(v, p))).size).toBe(v.parts.length);
    // The bounding radius holds every part of every craft.
    for (const p of v.parts) expect(v3.len(p.localPos)).toBeLessThanOrEqual(v.boundingRadius);
    expect(v.boundingRadius).toBeGreaterThan(2 * s.vessels[0]!.crafts![0]!.chase.minDistance);
    // Only the helm's craft lists stage figures (a craft nobody here can fire lists none).
    expect(v.crafts!.map((c) => c.staging.stages.length > 0)).toEqual([true, false, false]);
    const view = session.stores.assembly.get()!;
    expect(view.vesselId).toBe(FAKE_ASSEMBLY_ID);
    expect(view.crafts.map((c) => c.craftId)).toEqual(v.crafts!.map((c) => c.id));
    expect(view.links).toEqual(v.links!.map((l) => ({ a: l.a, b: l.b })));
    expect(session.stores.census.get().get(FAKE_ASSEMBLY_ID)!.kind).toBe('assembly');
  });

  it('echoes: a recorded echo behind the clock and a projected one ahead of it, each with the offer that reaches it', () => {
    const session = v2('echoes');
    const s = session.snapshot();
    const byId = new Map(s.vessels.map((v) => [v.id, v]));
    const recorded = byId.get(FAKE_ECHO_RECORDED_ID)!;
    const projected = byId.get(FAKE_ECHO_PROJECTED_ID)!;
    expect(recorded.presence).toBe('recordedEcho');
    expect(recorded.timeOffset).toBe(-3600 * TICKS_PER_SECOND);
    expect(projected.presence).toBe('projectedEcho');
    expect(projected.timeOffset).toBe(7200 * TICKS_PER_SECOND);
    expect(byId.get(FAKE_VESSEL_ID)!.presence).toBe('solid');
    const t = s.readouts.target!;
    expect(t.ref).toEqual({ kind: 'vessel', id: FAKE_ECHO_RECORDED_ID });
    expect(t.presence).toBe('recordedEcho');
    expect(t.timeOffset).toBe(recorded.timeOffset);
    expect(t.offer).toMatchObject({ kind: 'askAdvance', vesselId: FAKE_ECHO_RECORDED_ID });
    expect(session.commands.setTarget({ kind: 'vessel', id: FAKE_ECHO_PROJECTED_ID }).ok).toBe(true);
    const p = session.snapshot().readouts.target!;
    expect(p.presence).toBe('projectedEcho');
    expect(p.offer).toMatchObject({ kind: 'jump', vesselId: FAKE_ECHO_PROJECTED_ID, toTick: s.time!.myTick + projected.timeOffset! });
    expect(session.stores.roster.get().map((r) => r.timeOffset)).toEqual([recorded.timeOffset, projected.timeOffset]);
  });

  it('a time-strip scene for each relation of the clock to the live clock', () => {
    const live = v2('timeLive').snapshot().time!;
    expect(live).toMatchObject({ relation: 'live', offset: 0, clockKind: 'shared', maxRate: 1 });
    expect(live.members.map((m) => [m.callsign, m.bound, m.accepted])).toEqual([
      ['YOU', true, true],
      ['VEGA', true, false],
    ]);
    expect(live.limitedBy!.kind).toBe('members');
    expect(live.limitedBy!.vesselIds).toEqual([FAKE_TARGET_ID]);
    expect(live.proposals).toHaveLength(1);
    expect(live.offers.map((o) => o.kind)).toEqual(['follow']);
    expect(v2('timeLive').stores.prompts.get().map((p) => p.kind)).toEqual(['warpProposal']);
    const ahead = v2('timeAhead').snapshot().time!;
    expect(ahead).toMatchObject({ relation: 'ahead', offset: 7200 * TICKS_PER_SECOND, clockKind: 'private' });
    expect(ahead.myTick - ahead.liveTick).toBe(ahead.offset);
    expect(ahead.offers.map((o) => o.kind)).toEqual(['hold']);
    const behind = v2('timeBehind').snapshot().time!;
    expect(behind).toMatchObject({ relation: 'behind', offset: -900 * TICKS_PER_SECOND });
    expect(behind.limitedBy!.kind).toBe('held');
    expect(behind.offers).toEqual([{ kind: 'rejoin', toTick: behind.liveTick, label: 'Rejoin the live clock' }]);
    // A session on its own: a private clock on the live one, nobody else, nothing offered.
    expect(v2('rendezvous').snapshot().time).toMatchObject({ relation: 'live', offset: 0, clockKind: 'private', clockId: null, members: [], proposals: [], offers: [] });
  });

  it('launchQueue: a launch request waits for a pad, moves up, and is left by cancelSpawn', async () => {
    const session = v2('launchQueue');
    const store = session.stores.launchQueue;
    const first = store.get()!;
    expect(first.position).toBe(3);
    expect(first.etaSeconds).toBe(540);
    expect(first.request.vehicleId).toBe(VEHICLE);
    expect(first.request.slot).toEqual({ kind: 'live' });
    const site = defs.sites[first.request.site]!;
    expect(site).toBeDefined();
    expect(first.padClass).toBe('heavy');
    // Every pad is taken, which is why the request waits.
    expect(session.stores.pads.get().every((p) => p.state === 'occupied')).toBe(true);
    let changes = 0;
    const off = store.subscribe(() => changes++);
    const version = store.version;
    for (let i = 0; i < 61 * 10; i++) session.advance(0.1);
    expect(store.get()!.position).toBe(2);
    expect(store.get()!.etaSeconds).toBeLessThan(first.etaSeconds);
    expect(store.version).toBeGreaterThan(version);
    expect(changes).toBe(store.version - version);
    expect(await session.universe.cancelSpawn()).toEqual({ ok: true });
    expect(store.get()).toBeNull();
    expect((await session.universe.cancelSpawn()).ok).toBe(false);
    off();
    // A session that is not waiting has no entry, as a LocalSession never has.
    expect(v2('rendezvous').stores.launchQueue.get()).toBeNull();
    expect(v2('rendezvous').stores.link.get().state).toBe('local');
  });
});
