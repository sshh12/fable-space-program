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
import type { DockingPortState, PartSnapshot, SimEvent, SimSnapshot, VesselSnapshot } from '@/core/contracts/sim';
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
import { activeVesselOf, craftIdOf, partKeyOf, revisionOf, targetOf } from '@/core/access/snapshotAccess';
import { FRAME_HISTORY_EPOCHS, FrameEpochTracker, rebasePoint, rebaseVelocity } from '@/core/math/frame';
import { quat } from '@/core/math/quat';
import { v3, type Vec3 } from '@/core/math/vec3';
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

/** The part of a vessel that a part key names. Keys are compared with the keys of the part list, never taken apart. */
const partByKey = (v: VesselSnapshot, key: string): PartSnapshot | undefined => v.parts.find((p) => partKeyOf(v, p) === key);

/** The vessel and the part a part key names in a snapshot; null when no part list has it. */
function findKey(s: SimSnapshot, key: string): { vessel: VesselSnapshot; part: PartSnapshot } | null {
  for (const vessel of s.vessels) {
    const part = partByKey(vessel, key);
    if (part) return { vessel, part };
  }
  return null;
}

/** Origin of a part in the ROOT frame, and the centre of its top face (the mating face of the fake's port part). */
const partRoot = (v: VesselSnapshot, p: PartSnapshot): Vec3 => v3.add(v.rRoot, quat.rotate(v.q, p.localPos));
const faceRoot = (v: VesselSnapshot, p: PartSnapshot): Vec3 => v3.add(v.rRoot, quat.rotate(v.q, v3.add(p.localPos, quat.rotate(p.localRot, v3.new(0, defs.parts[p.def]!.bounds.yMax, 0)))));
const faceAxisRoot = (v: VesselSnapshot, p: PartSnapshot): Vec3 => quat.rotate(v.q, quat.rotate(p.localRot, v3.unitY()));

/**
 * Ids are opaque and consistent (contracts/sim.ts, "Ids"): every part id that a helm, a dock link, the docking
 * instrument, a port state or an event states names a part that is in a part list of the snapshot, in the
 * vessel the field is about.
 */
function expectNamedParts(s: SimSnapshot, ports: readonly { partKey: string; state: DockingPortState }[], label: string): void {
  for (const v of s.vessels) {
    const helm = v.helm!;
    expect(v.crafts!.some((c) => c.id === helm.craftId), `${label} ${v.id}: the helm's craft is aboard`).toBe(true);
    // A vessel without parts has no control point (the empty string); every other names one of its parts, of the helm's craft.
    if (v.parts.length === 0) expect(helm.controlPart, `${label} ${v.id}`).toBe('');
    else expect(craftIdOf(v, partByKey(v, helm.controlPart)!), `${label} ${v.id}: the control part ${helm.controlPart} is a part of the helm's craft`).toBe(helm.craftId);
    for (const l of v.links ?? []) {
      const a = partByKey(v, l.a);
      const b = partByKey(v, l.b);
      expect(a && b, `${label} ${v.id}: the link ${l.a} - ${l.b} joins two parts of the vessel`).toBeTruthy();
      expect(craftIdOf(v, a!), `${label} ${v.id}: a dock link joins two craft`).not.toBe(craftIdOf(v, b!));
    }
    // Every craft of a vessel of several is joined to the others by its links (the forest of a docked vessel).
    const crafts = v.crafts!;
    const joined = new Set([crafts[0]!.id]);
    for (let grew = true; grew; ) {
      grew = false;
      for (const l of v.links ?? []) {
        const [a, b] = [craftIdOf(v, partByKey(v, l.a)!), craftIdOf(v, partByKey(v, l.b)!)];
        if (joined.has(a) !== joined.has(b)) {
          joined.add(a).add(b);
          grew = true;
        }
      }
    }
    expect([...joined].sort(), `${label} ${v.id}: the links join every craft`).toEqual(crafts.map((c) => c.id).sort());
  }
  const active = activeVesselOf(s)!;
  const docking = s.readouts.docking;
  if (docking) {
    expect(partByKey(active, docking.ownPort), `${label}: the own port ${docking.ownPort} is a part of the active vessel`).toBeDefined();
    expect(findKey(s, docking.targetPort), `${label}: the target port ${docking.targetPort} is a part of a vessel`).not.toBeNull();
  }
  for (const p of ports) {
    expect(findKey(s, p.partKey), `${label}: the port ${p.partKey} is a part of a vessel`).not.toBeNull();
    if (p.state.peer) expect(partByKey(s.vessels.find((v) => v.id === p.state.peer!.vesselId)!, p.state.peer.partKey), `${label}: the peer of ${p.partKey} is a part of the vessel it names`).toBeDefined();
  }
  for (const e of s.events) {
    if (e.type !== 'dockCapture' && e.type !== 'docked') continue;
    expect(s.vessels.some((v) => v.id === e.vesselId), `${label}: the vessel of ${e.type} is in the snapshot`).toBe(true);
    for (const key of [e.partId, e.otherPartId]) expect(findKey(s, key), `${label}: ${e.type} names the part ${key}`).not.toBeNull();
  }
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
    for (const l of v.links ?? []) for (const key of [l.a, l.b]) expect(partByKey(v, key), `${label}: the dock link's port ${key} is a part of the vessel`).toBeDefined();
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

  it('the v1 name gives the same session with the v1 render root: createFakeSim is createFakeSession about the root body', () => {
    for (const scene of FAKE_SCENES) {
      const a = createFakeSim(defs, { scene });
      const b = createFakeSession(defs, { scene, renderRoot: 'rootBody' });
      expect(a.peek().frame!.origin).toEqual({ kind: 'body', bodyId: defs.rootBodyId });
      // Asked for the session's root, the v1 name gives it.
      expect(createFakeSim(defs, { scene, renderRoot: 'focusBody' }).peek()).toEqual(createFakeSession(defs, { scene }).peek());
      for (let i = 0; i < 5; i++) {
        a.advance(1 / 60);
        b.advance(1 / 60);
      }
      expect(a.snapshot()).toEqual(b.snapshot());
    }
  });

  it('is deterministic: the same options and calls give the same snapshots, bit for bit', () => {
    const parts = vesselPartSnapshots(assembleVessel(defs, VEHICLE, { stagesAlreadyFired: 6 }));
    for (const scene of [...FAKE_SCENES, ...FAKE_V2_SCENES]) {
      const run = (): string => {
        // The scenes about ports and links need a part list; the flight scenes run without one as well.
        const s = createFakeSession(defs, (FAKE_V2_SCENES as readonly string[]).includes(scene) ? { scene, vehicleId: VEHICLE, parts } : { scene });
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

  it('a scene about ports and links is built from a part list and says so when it is given none', () => {
    expect(() => createFakeSession(defs, { scene: 'dockingApproach' })).toThrow(/needs a part list/);
    expect(() => createFakeSession(defs, { scene: 'assembly' })).toThrow(/needs a part list/);
    expect(v2('lowOrbit' as never).portStates()).toEqual([]);
    // A vessel without parts has no control point, and states none (a session states the empty string).
    for (const scene of ['rendezvous', 'echoes', 'timeLive'] as const) for (const v of createFakeSession(defs, { scene }).snapshot().vessels) expect(v.helm!.controlPart, `${scene} ${v.id}`).toBe('');
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
    // Every link joins two parts of two craft, each port part holds one craft, and the links reach every craft.
    expectNamedParts(s, session.portStates(), 'assembly');
    expect(new Set(v.links!.flatMap((l) => [l.a, l.b])).size).toBe(4);
    expect(v.helm).toEqual({ accountId: 'fake-account', callsign: 'YOU', craftId: FAKE_VESSEL_ID, controlPart: partKeyOf(v, v.parts[0]!) });
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
    // The panel lists the ports the links name, each with the craft docked there; the pilots aboard are seated.
    expect(view.crafts.map((c) => c.ports.map((p) => [p.portId, p.state, p.peerCraftId]))).toEqual([
      [
        [v.links![0]!.a, 'hard', 'fake-craft-b'],
        [v.links![1]!.a, 'hard', 'fake-craft-c'],
      ],
      [[v.links![0]!.b, 'hard', FAKE_VESSEL_ID]],
      [[v.links![1]!.b, 'hard', FAKE_VESSEL_ID]],
    ]);
    expect(view.crafts.map((c) => c.attended)).toEqual([true, true, false]);
    expect(view.anchorCraftId).toBe(FAKE_VESSEL_ID);
    expect(view.helm).toEqual({ accountId: v.helm!.accountId, callsign: v.helm!.callsign, craftId: v.helm!.craftId, request: null });
    expect(session.stores.census.get().get(FAKE_ASSEMBLY_ID)!.kind).toBe('assembly');
    expect(session.stores.ships.get().map((r) => [r.vesselId, r.isAssembly, r.members])).toEqual([[FAKE_ASSEMBLY_ID, true, ['VEGA']]]);
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
    // Every pad is taken (the viewer's own vessel stands on the first of its site), which is why the request waits.
    const pads = session.stores.pads.get();
    expect(pads.every((p) => p.state === 'occupied')).toBe(true);
    expect(pads.filter((p) => p.vesselId !== null).map((p) => [p.siteId, p.padId, p.vesselId])).toEqual([[first.request.site, first.request.pad, FAKE_VESSEL_ID]]);
    expect(session.stores.presence.get().summary.queued).toBe(1);
    let changes = 0;
    const off = store.subscribe(() => changes++);
    const version = store.version;
    for (let i = 0; i < 61 * 10; i++) session.advance(0.1);
    expect(store.get()!.position).toBe(2);
    expect(store.get()!.etaSeconds).toBeLessThan(first.etaSeconds);
    expect(store.version).toBeGreaterThan(version);
    expect(changes).toBe(store.version - version);
    // The request is the session's one spawn in flight: its promise is pending, and a second spawn is refused.
    const waiting = session.pendingSpawn!;
    expect(waiting).not.toBeNull();
    let settled = false;
    void waiting.then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(await session.universe.spawn(first.request)).toEqual({ ok: false, reason: 'A launch request of this session is already waiting for a pad', alternative: null });
    expect(store.get()!.position).toBe(2);
    // Leaving the queue (session.ts, LaunchQueueEntry, "left"): the store is null and the waiting spawn resolves
    // refused, with a reason that says the player left and no alternative.
    expect(await session.universe.cancelSpawn()).toEqual({ ok: true });
    expect(store.get()).toBeNull();
    expect(session.pendingSpawn).toBeNull();
    expect(await waiting).toEqual({ ok: false, reason: 'Left the launch queue', alternative: null });
    expect(session.stores.presence.get().summary.queued).toBe(0);
    // Nothing waits now: cancelSpawn reports it with a reason, as in a LocalSession.
    const none = await session.universe.cancelSpawn();
    expect(none.ok).toBe(false);
    expect(none.ok === false && none.reason).toBe('No launch request is waiting');
    // Asking again joins the queue again (every pad is still taken): the same promise is pending until it is left.
    const again = session.universe.spawn({ ...first.request, name: 'Second try' });
    expect(session.pendingSpawn).toBe(again);
    expect(store.get()).toMatchObject({ request: { name: 'Second try', pad: first.request.pad }, padClass: 'heavy', position: 3, etaSeconds: 540 });
    expect(session.stores.presence.get().summary.queued).toBe(1);
    for (let i = 0; i < 61 * 10; i++) session.advance(0.1);
    expect(store.get()!.position).toBe(2);
    expect(await session.universe.cancelSpawn()).toEqual({ ok: true });
    expect(await again).toEqual({ ok: false, reason: 'Left the launch queue', alternative: null });
    // A request for a pad the site does not have is refused at once and never waits.
    expect(await session.universe.spawn({ ...first.request, pad: 'no-such-pad' })).toEqual({ ok: false, reason: 'No such pad', alternative: null });
    expect(store.get()).toBeNull();
    expect(session.pendingSpawn).toBeNull();
    off();
    // A session that is not waiting has no entry and no spawn in flight, launches nothing and has nothing to leave.
    const other = v2('rendezvous');
    expect(other.stores.launchQueue.get()).toBeNull();
    expect(other.pendingSpawn).toBeNull();
    expect(await other.universe.spawn(first.request)).toEqual({ ok: false, reason: 'The fake session launches nothing', alternative: null });
    expect((await other.universe.cancelSpawn()).ok).toBe(false);
    expect(other.stores.link.get().state).toBe('local');
  });
});

/**
 * The docking scene, step by step (review finding 3). What a docked vessel is, is the simulation's definition
 * (docs/handoff/sim-core-v2.md, step 3; ARCHITECTURE 7.5): the heavier vessel is the base (equal mass: the
 * lower id), its craft come first, its helm stays (a vacant one is granted to the pilot aboard), the arriving
 * craft's parts are re-expressed in the base's frame as their own tree, a link joins the two port parts, the
 * vessel has an assembly id and the absorbed one is a tombstone.
 */
describe('the fake session: the docking approach, step by step', () => {
  type Session = ReturnType<typeof createFakeSession>;
  const start = (): Session => createFakeSession(defs, { scene: 'dockingApproach', vehicleId: VEHICLE, parts: vesselPartSnapshots(assembleVessel(defs, VEHICLE, { stagesAlreadyFired: 6 })) });

  /** Fly until an event of the type arrives: the snapshot that carries it, the one before it, and every event on the way. */
  function flyTo(session: Session, type: SimEvent['type']): { before: SimSnapshot; at: SimSnapshot; events: SimEvent[] } {
    const events: SimEvent[] = [];
    let before = session.snapshot();
    events.push(...before.events);
    for (let i = 0; i < 200 * 10; i++) {
      session.advance(0.1);
      const at = session.snapshot();
      events.push(...at.events);
      if (at.events.some((e) => e.type === type)) return { before, at, events };
      before = at;
    }
    throw new Error(`no ${type} event within 200 s`);
  }

  /** Every part of the snapshot by its key, as its offset from the origin of one part (the viewer's port part): the shape of the scene. */
  function shape(s: SimSnapshot, originKey: string): Map<string, Vec3> {
    const origin = findKey(s, originKey)!;
    const o = partRoot(origin.vessel, origin.part);
    const out = new Map<string, Vec3>();
    for (const v of s.vessels) for (const p of v.parts) out.set(partKeyOf(v, p), v3.sub(partRoot(v, p), o));
    return out;
  }

  it('before capture: two vessels of one craft each, the two ports name parts and face each other, the station is parked', () => {
    const session = start();
    const s = session.snapshot();
    expectContract(s, 'approach');
    expectNamedParts(s, session.portStates(), 'approach');
    expect(s.vessels.map((v) => v.id)).toEqual([FAKE_VESSEL_ID, FAKE_STATION_ID]);
    const [own, station] = s.vessels as [VesselSnapshot, VesselSnapshot];
    expect(s.vessels.map((v) => v.crafts!.map((c) => c.id))).toEqual([[FAKE_VESSEL_ID], [FAKE_STATION_ID]]);
    expect(s.vessels.map((v) => v.links)).toEqual([[], []]);
    const d = s.readouts.docking!;
    const t = s.readouts.target!;
    // The target is the station's port and the control point is the own one: both are parts, the first of each craft here.
    expect(t.ref).toEqual({ kind: 'port', vesselId: FAKE_STATION_ID, portId: d.targetPort });
    expect(d.ownPort).toBe(partKeyOf(own, own.parts[0]!));
    expect(d.targetPort).toBe(partKeyOf(station, station.parts[0]!));
    expect(own.helm).toEqual({ accountId: 'fake-account', callsign: 'YOU', craftId: FAKE_VESSEL_ID, controlPart: d.ownPort });
    // The station is another owner's and nobody is aboard: its helm is vacant and its owner is not in the roster.
    expect(station.crafts![0]!.ownerCallsign).toBe('VEGA');
    expect(station.helm).toEqual({ accountId: null, callsign: null, craftId: FAKE_STATION_ID, controlPart: d.targetPort });
    expect(session.stores.roster.get()).toEqual([]);
    // The two port faces look at each other along the line between them, 13.8 m apart; that gap is the instrument's.
    const ownPort = partByKey(own, d.ownPort)!;
    const theirPort = partByKey(station, d.targetPort)!;
    const gap = v3.sub(faceRoot(station, theirPort), faceRoot(own, ownPort));
    expect(v3.len(gap)).toBeCloseTo(13.8, 6);
    expect(v3.dot(faceAxisRoot(own, ownPort), v3.normalize(gap))).toBeGreaterThan(1 - 1e-9);
    expect(v3.dot(faceAxisRoot(station, theirPort), v3.normalize(gap))).toBeLessThan(-1 + 1e-9);
    expect(d.phase).toBe('approach');
    expect(d.axial).toBeCloseTo(13.8, 6);
    expect(t.range).toBeCloseTo(d.axial, 9);
    expect(t.rangeRate).toBeCloseTo(-0.1, 3);
    expect(d.closing).toBeCloseTo(0.1, 2);
    // Outside the lateral limit at first (0.4 m against 0.3), inside every other.
    expect(d.within).toEqual({ lateral: false, angle: true, roll: true, closing: true, lateralSpeed: true, rate: true });
    expect(s.readouts.sasModesAvailable).toContain('portAlign');
    expect(s.readouts.sasMode).toBe('portAlign');
    expect(session.portStates().map((p) => [p.partKey, p.state.state, p.state.armed, p.state.peer, p.state.progress])).toEqual([
      [d.ownPort, 'ready', true, null, 0],
      [d.targetPort, 'ready', true, null, 0],
    ]);
    // The stores: two ships in the census, the viewer's one a single craft, no assembly.
    const census = session.stores.census.get();
    expect([...census.keys()]).toEqual([FAKE_VESSEL_ID, FAKE_STATION_ID]);
    expect([...census.values()].map((c) => [c.kind, c.craftIds])).toEqual([
      ['ship', [FAKE_VESSEL_ID]],
      ['ship', [FAKE_STATION_ID]],
    ]);
    expect(session.stores.assembly.get()).toBeNull();
    expect(session.stores.ships.get().map((r) => [r.craftId, r.vesselId, r.isAssembly, r.members])).toEqual([[FAKE_VESSEL_ID, FAKE_VESSEL_ID, false, []]]);
    // Half-way in, nothing has happened yet.
    for (let i = 0; i < 600; i++) session.advance(0.1);
    const mid = session.snapshot();
    expect(mid.events).toEqual([]);
    expect(mid.readouts.docking!.phase).toBe('approach');
    expect(mid.readouts.docking!.axial).toBeCloseTo(13.8 - 60 * 0.1, 3);
    expectNamedParts(mid, session.portStates(), 'half-way');
  });

  it('captured: the faces meet, one event with the two port parts, soft capture between two vessels that stay two', () => {
    const session = start();
    const d0 = session.peek().readouts.docking!;
    const { at, events } = flyTo(session, 'dockCapture');
    expect(events).toEqual([{ type: 'dockCapture', ut: at.ut, vesselId: FAKE_VESSEL_ID, partId: d0.ownPort, otherVesselId: FAKE_STATION_ID, otherPartId: d0.targetPort }]);
    // 13.8 m at 0.1 m/s.
    expect(at.readouts.met).toBeGreaterThan(137.5);
    expect(at.readouts.met).toBeLessThan(138.5);
    expectContract(at, 'captured');
    expectNamedParts(at, session.portStates(), 'captured');
    expect(at.vessels.map((v) => v.id)).toEqual([FAKE_VESSEL_ID, FAKE_STATION_ID]);
    expect(at.vessels.map((v) => [v.crafts!.length, v.links!.length])).toEqual([
      [1, 0],
      [1, 0],
    ]);
    const [own, station] = at.vessels as [VesselSnapshot, VesselSnapshot];
    const d = at.readouts.docking!;
    expect([d.ownPort, d.targetPort]).toEqual([d0.ownPort, d0.targetPort]);
    expect(d.phase).toBe('soft');
    expect(d.axial).toBe(0);
    expect(d.closing).toBe(0);
    expect(at.readouts.target!.range).toBe(0);
    expect(d.within).toEqual({ lateral: true, angle: true, roll: true, closing: true, lateralSpeed: true, rate: true });
    // The faces lie on each other (the port hold kept the own axis on the station's).
    expect(v3.dist(faceRoot(own, partByKey(own, d.ownPort)!), faceRoot(station, partByKey(station, d.targetPort)!))).toBeLessThan(0.02);
    expect(session.portStates().map((p) => [p.partKey, p.state.state, p.state.peer])).toEqual([
      [d.ownPort, 'soft', { vesselId: FAKE_STATION_ID, partKey: d.targetPort }],
      [d.targetPort, 'soft', { vesselId: FAKE_VESSEL_ID, partKey: d.ownPort }],
    ]);
    // The soft capture makes its way to the hard dock: the progress grows, nothing else changes.
    expect(session.portStates()[0]!.state.progress).toBe(0);
    for (let i = 0; i < 50; i++) session.advance(0.1);
    const later = session.snapshot();
    expect(later.events).toEqual([]);
    expect(later.readouts.docking!.phase).toBe('soft');
    expect(session.portStates().map((p) => p.state.progress)).toEqual([0.5, 0.5].map((x) => expect.closeTo(x, 2)));
    expect(later.vessels.length).toBe(2);
    expect([...session.stores.census.get().keys()]).toEqual([FAKE_VESSEL_ID, FAKE_STATION_ID]);
    expect(session.stores.assembly.get()).toBeNull();
  });

  it('docked: one vessel of two craft in the frame of the base, a link between the port parts, the helm, the events, the stores', () => {
    const session = start();
    const d0 = session.peek().readouts.docking!;
    const seen = { census: 0, ships: 0, assembly: 0 };
    session.stores.census.subscribe(() => seen.census++);
    session.stores.ships.subscribe(() => seen.ships++);
    session.stores.assembly.subscribe(() => seen.assembly++);
    const { before, at, events } = flyTo(session, 'docked');
    expect(events.map((e) => e.type)).toEqual(['dockCapture', 'docked', 'helmChanged']);
    // Ten seconds of soft capture after the faces met.
    expect(at.ut - events[0]!.ut).toBeGreaterThan(9.9);
    expect(at.ut - events[0]!.ut).toBeLessThan(10.2);
    expectContract(at, 'docked');
    expectNamedParts(at, session.portStates(), 'docked');

    // One vessel is left. Its id is new (an assembly's) and neither of the two it was made of; the event says which
    // one was absorbed (the arriving vessel: the station is the base, the lower id of two equal masses).
    expect(at.vessels.length).toBe(1);
    const merged = at.vessels[0]!;
    expect(at.activeVesselId).toBe(merged.id);
    expect([FAKE_VESSEL_ID, FAKE_STATION_ID]).not.toContain(merged.id);
    expect(merged.id.includes('/')).toBe(false);
    expect(at.events).toEqual([
      { type: 'docked', ut: at.ut, vesselId: merged.id, partId: d0.targetPort, otherPartId: d0.ownPort, absorbedVesselId: FAKE_VESSEL_ID },
      { type: 'helmChanged', ut: at.ut, vesselId: merged.id, accountId: 'fake-account', callsign: 'YOU', craftId: FAKE_VESSEL_ID },
    ]);

    // The craft: the base's first, each with its id, its owner and its own stack (the station's lists none).
    expect(merged.crafts!.map((c) => [c.id, c.ownerCallsign, c.staging.stages.length > 0])).toEqual([
      [FAKE_STATION_ID, 'VEGA', false],
      [FAKE_VESSEL_ID, 'YOU', true],
    ]);
    expect(merged.name).toBe(before.vessels[1]!.name);
    expect(merged.links).toEqual([{ a: d0.targetPort, b: d0.ownPort, roll: 0 }]);
    // The base's helm stayed, and it was vacant: the pilot aboard has it, from the own port.
    expect(merged.helm).toEqual({ accountId: 'fake-account', callsign: 'YOU', craftId: FAKE_VESSEL_ID, controlPart: d0.ownPort });
    expect(merged.revision).toBe(before.vessels[0]!.revision! + 1);

    // The parts: every part of both vessels, the base's first and where they were in its frame; nothing vanished.
    const [own, station] = before.vessels as [VesselSnapshot, VesselSnapshot];
    expect(merged.parts.map((p) => partKeyOf(merged, p))).toEqual([...station.parts.map((p) => partKeyOf(station, p)), ...own.parts.map((p) => partKeyOf(own, p))]);
    expect(merged.parts.slice(0, station.parts.length).map((p) => [p.localPos, p.localRot])).toEqual(station.parts.map((p) => [p.localPos, p.localRot]));
    expect(merged.mass).toBeCloseTo(own.mass + station.mass, 6);
    for (const p of merged.parts) expect(v3.len(p.localPos), p.instanceId).toBeLessThanOrEqual(merged.boundingRadius);
    // The merge moved nothing: the shape of the scene (every part against the viewer's port part) is what it was
    // one snapshot earlier, to the few millimetres the port hold lagged; and the two faces are exactly on each other.
    const was = shape(before, d0.ownPort);
    const is = shape(at, d0.ownPort);
    expect([...is.keys()].sort()).toEqual([...was.keys()].sort());
    for (const [key, offset] of is) expect(v3.dist(offset, was.get(key)!), key).toBeLessThan(0.03);
    const ownPort = partByKey(merged, d0.ownPort)!;
    const basePort = partByKey(merged, d0.targetPort)!;
    expect(v3.dist(faceRoot(merged, ownPort), faceRoot(merged, basePort))).toBeLessThan(1e-6);
    expect(v3.dot(faceAxisRoot(merged, ownPort), faceAxisRoot(merged, basePort))).toBeCloseTo(-1, 9);

    // The instrument and the ports: docked, each port the other's peer in the one vessel.
    expect(at.readouts.target!.ref).toEqual({ kind: 'port', vesselId: FAKE_STATION_ID, portId: d0.targetPort });
    expect(at.readouts.target!.range).toBe(0);
    expect(at.readouts.docking).toMatchObject({ ownPort: d0.ownPort, targetPort: d0.targetPort, phase: 'hard', axial: 0, closing: 0 });
    expect(session.portStates().map((p) => [p.partKey, p.state.state, p.state.peer, p.state.progress])).toEqual([
      [d0.ownPort, 'hard', { vesselId: merged.id, partKey: d0.targetPort }, 0],
      [d0.targetPort, 'hard', { vesselId: merged.id, partKey: d0.ownPort }, 0],
    ]);

    // The stores state the merged vessel and no longer the two: each changed once, at the dock.
    expect(seen).toEqual({ census: 1, ships: 1, assembly: 1 });
    const census = session.stores.census.get();
    expect([...census.keys()]).toEqual([merged.id]);
    expect(census.get(merged.id)).toMatchObject({ kind: 'assembly', craftIds: [FAKE_STATION_ID, FAKE_VESSEL_ID], name: merged.name, ownerCallsigns: ['VEGA', 'YOU'], radius: merged.boundingRadius, revision: merged.revision });
    expect(session.stores.ships.get().map((r) => [r.craftId, r.vesselId, r.isAssembly, r.members])).toEqual([[FAKE_VESSEL_ID, merged.id, true, ['VEGA']]]);
    const view = session.stores.assembly.get()!;
    expect(view.vesselId).toBe(merged.id);
    expect(view.crafts.map((c) => [c.craftId, c.attended, c.seniority, c.ports.map((p) => [p.portId, p.state, p.peerCraftId])])).toEqual([
      [FAKE_STATION_ID, false, 0, [[d0.targetPort, 'hard', FAKE_VESSEL_ID]]],
      [FAKE_VESSEL_ID, true, 1, [[d0.ownPort, 'hard', FAKE_STATION_ID]]],
    ]);
    expect(view.links).toEqual([{ a: d0.targetPort, b: d0.ownPort }]);
    // The anchor is the most senior craft with an owner (the station); the helm is the viewer's.
    expect(view.anchorCraftId).toBe(FAKE_STATION_ID);
    expect(view.helm).toEqual({ accountId: 'fake-account', callsign: 'YOU', craftId: FAKE_VESSEL_ID, request: null });
    expect(session.stores.roster.get()).toEqual([]);

    // It stays docked, and the viewer flies the assembly: the helm's inputs turn the one vessel, the faces stay joined.
    session.commands.setSasEnabled(false);
    session.setControls({ pitch: 1, yaw: 0, roll: 0, translate: v3.zero(), throttle: 0 });
    for (let i = 0; i < 10; i++) session.advance(0.1);
    const flown = session.snapshot();
    expect(flown.events).toEqual([]);
    expect(flown.vessels.map((v) => v.id)).toEqual([merged.id]);
    const turned = flown.vessels[0]!;
    expect(quat.angleBetween(turned.q, merged.q)).toBeGreaterThan(0.2);
    expect(v3.len(turned.w)).toBeGreaterThan(0.1);
    expect(v3.dist(faceRoot(turned, partByKey(turned, d0.ownPort)!), faceRoot(turned, partByKey(turned, d0.targetPort)!))).toBeLessThan(1e-6);
    expect(flown.readouts.docking!.phase).toBe('hard');
    expect(seen).toEqual({ census: 1, ships: 1, assembly: 1 });
    expectNamedParts(flown, session.portStates(), 'flown docked');
  });
});
