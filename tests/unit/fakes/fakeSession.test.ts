/**
 * The fake session against the real one (ARCHITECTURE 17.1: "each of its scenes has a conformance test against
 * the output of a real LocalSession in the same situation: field presence, units, frames, value ranges"), and
 * the scenes of the shared universe, which no session produces yet, against the contract and themselves.
 *
 * THE SAME SITUATION. The real session is `createSession` on flat terrain at the QA scenarios
 * (tests/unit/sim-world/helpers.ts), after its first step (before it nothing of the environment has been
 * evaluated: no air on the pad, no contact). The fake is made for that situation: the session's time, its
 * part list, its vehicle, the stages the scenario starts with fired, the scenario's target and landing
 * point, the vessel's name. The situations a session has today and the fake's scene for each:
 *   pad -> lunar-direct (on the pad), lowOrbit -> qa-leo, translunar -> qa-translunar,
 *   lunarOrbit -> qa-lunar-orbit, lunarSurface -> qa-lunar-surface, reentry -> qa-entry, chutes -> qa-drogues,
 *   ascent -> lunar-direct launched and flown for a minute at full thrust (the fake put at its altitude).
 *
 * THE COMPARISON walks the two snapshots together: every vessel, every part, every element of every array,
 * every field. Two values agree when they are equal (numbers to the rounding, ids one to one). Where the fake
 * legitimately simplifies, ONE table, `TOLERANCES`, states the field, the scenes, what still must hold (a
 * range in the field's unit, a factor, an angle) and the reason; a row that no scene needs fails the test,
 * and so does a value that is wrong on purpose (the last block).
 *
 * What a session cannot be asked yet (the scenes of the shared universe) is held to the contract's
 * invariants: ids opaque and consistent, the craft blocks summing to the vessel, the stores agreeing with the
 * snapshot, `Readouts.target` and `.docking` present exactly when the contract says.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { NEUTRAL_CONTROLS } from '@/core/contracts/controls';
import { WARP_LEVELS, type DefLibrary, type ParachuteEnvelope, type ScenarioDef } from '@/core/contracts/defs';
import { TICKS_PER_SECOND, type TargetRef } from '@/core/contracts/net';
import type { ChuteEnvelope, DockingPortState, PartSnapshot, SimEvent, SimSnapshot, VesselSnapshot } from '@/core/contracts/sim';
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
  type FakeSession,
  type FakeSessionOptions,
} from '@/core/fakes/fakeSession';
import { activeVesselOf, craftIdOf, partKeyOf, revisionOf, targetOf } from '@/core/access/snapshotAccess';
import { FRAME_HISTORY_EPOCHS, FrameEpochTracker, rebasePoint, rebaseVelocity } from '@/core/math/frame';
import { quat, type Quat } from '@/core/math/quat';
import { DEG } from '@/core/math/scalar';
import { v3, type Vec3 } from '@/core/math/vec3';
import { assembleVessel, vesselPartSnapshots } from '@/sim/vessel/public';
import { flatTerrain, loadLibrary, makeSim, settleTerrain } from '../sim-world/helpers';

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

/** The ascent the session flies before it is compared, s, and the time the fake's engines are given to spool up, s. */
const ASCENT_SECONDS = 60;
const SPOOL_SECONDS = 5;
/** The fake's ascent climbs at this rate, m/s (fakeSession.ts, the scene's specification). */
const FAKE_CLIMB_RATE = 350;

interface Situation {
  scene: FakeScene;
  scenario: ScenarioDef;
  /** The options the fake was made with: the session's situation, stated to the fake. */
  options: FakeSessionOptions;
  session: FakeSession;
  fake: SimSnapshot;
  real: SimSnapshot;
}

/** A session of the scene's scenario in its situation, and the fake made for the same one. */
async function makeSituation(scene: FakeScene): Promise<Situation> {
  const scenario = defs.scenarios[SCENARIO_OF[scene]]!;
  const sim = await makeSim(defs, scenario.id, terrain);
  const full = { ...NEUTRAL_CONTROLS, translate: v3.zero(), throttle: 1 };
  if (scene === 'ascent') {
    // No scenario starts in a climb: the session launches from the pad and flies straight up for a minute.
    sim.setControls(full);
    expect(sim.commands.stage().ok).toBe(true);
    for (let i = 0; i < ASCENT_SECONDS * TICKS_PER_SECOND; i++) {
      if (i % TICKS_PER_SECOND === 0) await settleTerrain(sim);
      sim.step();
    }
  } else sim.step();
  await settleTerrain(sim);
  const real = sim.snapshot();
  const rv = activeVesselOf(real)!;
  const lead = scene === 'ascent' ? SPOOL_SECONDS : 0;
  const options: FakeSessionOptions = {
    scene,
    ut: real.ut - lead,
    vehicleId: scenario.vehicle,
    parts: rv.parts,
    vesselName: rv.name,
    stagesAlreadyFired: real.staging.nextStage,
    target: scenario.target === null ? null : { kind: 'body', id: scenario.target },
    landing: scenario.suggestedLanding,
    legsDeployed: real.readouts.legsDeployed === true,
    ...(scenario.start.kind === 'landed' ? { location: { latDeg: scenario.start.latDeg, lonDeg: scenario.start.lonDeg } } : {}),
    ...(scene === 'ascent' ? { altitude: real.readouts.altitudeAsl - FAKE_CLIMB_RATE * lead } : {}),
  };
  const session = createFakeSession(defs, options);
  if (scene === 'ascent') {
    // The fake's engines spool up over frames; it was put that much lower and earlier, and arrives at the session's height and time.
    session.setControls(full);
    for (let i = 0; i < lead * 60; i++) session.advance(1 / 60);
  }
  return { scene, scenario, options, session, fake: session.snapshot(), real };
}

const situations = new Map<FakeScene, Promise<Situation>>();
/** The situation of a scene, made once for the file (nothing in it is changed by a test: a test that drives a session makes its own). */
function situationOf(scene: FakeScene): Promise<Situation> {
  let made = situations.get(scene);
  if (!made) {
    made = makeSituation(scene);
    situations.set(scene, made);
  }
  return made;
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


// ---------------------------------------------------------------------------------- the contract's invariants

/**
 * The mass of a part list by the test's own sum: every part's dry mass (a fairing petal its share) and
 * everything in its tanks; a launch clamp that still holds is ground structure and weighs nothing in flight.
 */
function massOf(parts: readonly PartSnapshot[]): number {
  let mass = 0;
  for (const p of parts) {
    if (p.modules.some((m) => m.type === 'launchClamp' && !m.released)) continue;
    mass += defs.parts[p.def]!.dryMass / (p.panel ? p.panel.count : 1);
    for (const kg of Object.values(p.resources)) mass += kg;
  }
  return mass;
}

/**
 * The craft blocks sum to the vessel: every vessel weighs what its parts weigh, holds them all inside its
 * bounding radius with its centre of mass, is of its base craft's vehicle; and the blocks about the active
 * vessel (the stage stack, the read-outs) state that vessel. `massTolerance` is relative.
 */
function expectWhole(s: SimSnapshot, label: string, massTolerance = 1e-9): void {
  for (const v of s.vessels) {
    const crafts = v.crafts!;
    expect(v.vehicleId, `${label} ${v.id}: the vessel is of its base craft's vehicle`).toBe(crafts[0]!.vehicleId);
    if (v.parts.length === 0) continue;
    const perCraft = crafts.map((c) => massOf(v.parts.filter((p) => craftIdOf(v, p) === c.id)));
    for (const [i, m] of perCraft.entries()) expect(m, `${label} ${v.id}: the craft ${crafts[i]!.id} has parts and they weigh something`).toBeGreaterThan(0);
    const sum = perCraft.reduce((a, b) => a + b, 0);
    expect(Math.abs(v.mass - sum) / sum, `${label} ${v.id}: the mass ${v.mass} is the mass of its craft ${sum}`).toBeLessThanOrEqual(massTolerance);
    for (const p of v.parts) expect(v3.len(p.localPos), `${label} ${v.id}/${p.instanceId}: inside the bounding radius`).toBeLessThanOrEqual(v.boundingRadius);
    expect(v3.len(v.comLocal), `${label} ${v.id}: the centre of mass is inside the bounding radius`).toBeLessThanOrEqual(v.boundingRadius);
  }
  const active = activeVesselOf(s)!;
  const helmCraft = active.crafts!.find((c) => c.id === active.helm!.craftId)!;
  expect(s.staging, `${label}: the stage stack is the helm craft's`).toEqual(helmCraft.staging);
  expect(s.readouts.mass, `${label}: the read-out states the active vessel's mass`).toBe(active.mass);
  expect(s.readouts.thrust, label).toBe(active.thrust);
  expect(s.readouts.gLoad, label).toBeCloseTo(active.gLoad, 12);
  expect(s.readouts.dynamicPressure, label).toBe(active.aero.q);
  expect(s.readouts.mach, label).toBe(active.aero.mach);
}

/**
 * The staging invariants of a craft of the test vehicle: the stack is the vehicle's (count, labels, icons,
 * action kinds), the stages before `nextStage` are fired and no other, at least those the scenario started
 * with; a stage that states no propellant states no burn, at most one fired stage still burns, and the
 * remaining delta-v is the sum of the stages'.
 */
function expectStack(s: SimSnapshot, label: string): void {
  const vehicle = defs.vehicles[VEHICLE]!;
  const { stages, nextStage } = s.staging;
  expect(stages.map((x) => [x.label, x.icon, x.actionKinds]), `${label}: the stack is the vehicle's`).toEqual(vehicle.stages.map((x) => [x.label, x.icon, x.actions.map((a) => a.kind)]));
  expect(nextStage, label).toBeGreaterThanOrEqual(s.scenario.stagesAlreadyFired);
  expect(nextStage, label).toBeLessThanOrEqual(stages.length);
  expect(stages.map((x) => x.fired), `${label}: fired stages`).toEqual(stages.map((_, i) => i < nextStage));
  for (const [i, x] of stages.entries()) {
    const figures = [x.deltaVVac, x.deltaVNow, x.twr, x.burnTime];
    if (x.propellantFraction === null) expect(figures, `${label}: stage ${i} burns nothing`).toEqual([0, 0, 0, 0]);
    else {
      for (const f of figures) expect(f, `${label}: stage ${i}`).toBeGreaterThan(0);
      expect(x.propellantFraction, `${label}: stage ${i}`).toBeGreaterThanOrEqual(0);
      expect(x.propellantFraction, `${label}: stage ${i}`).toBeLessThanOrEqual(1);
      expect(x.thrustVac, `${label}: stage ${i} burns with engines`).toBeGreaterThan(0);
    }
  }
  expect(stages.filter((x) => x.fired && x.propellantFraction !== null).length, `${label}: one burn under way at most`).toBeLessThanOrEqual(1);
  const sum = stages.reduce((a, x) => a + x.deltaVVac, 0);
  expect(Math.abs(s.readouts.deltaVTotal - sum), `${label}: the remaining delta-v is the sum of the stages'`).toBeLessThanOrEqual(1e-9 * Math.max(1, sum));
}

/**
 * The light of the next parachute stage as the contract defines it (`Readouts.chuteEnvelope`,
 * `StageInfo.chuteEnvelopes`), from the snapshot's own state: none where there is no air or no parachute stage
 * is left; else the flight condition against the two envelopes of the first stage from `nextStage` on that
 * deploys a canopy.
 */
function chuteLightOf(s: SimSnapshot): ChuteEnvelope | null {
  const v = activeVesselOf(s)!;
  if (!(v.aero.airDensity > 0)) return null;
  const next = s.staging.stages.slice(s.staging.nextStage).find((x) => x.chuteEnvelopes)?.chuteEnvelopes;
  if (!next) return null;
  const speed = v3.len(v.aero.airVelocity);
  const within = (e: ParachuteEnvelope): boolean => !(e.maxAlt !== undefined && s.readouts.altitudeAsl > e.maxAlt) && !(e.maxMach !== undefined && v.aero.mach > e.maxMach) && !(e.maxSpeed !== undefined && speed > e.maxSpeed) && v.aero.q <= e.maxQ;
  return !within(next.destroy) ? 'unsafe' : within(next.safe) ? 'safe' : 'risky';
}

/**
 * `Readouts.target` and `.docking` are present exactly when the contract says, and what goes with a target
 * goes with it: navigation to the selected target and nothing without one; the docking instrument when a port
 * is targeted and an own port is the control point, else none; the navball's target markers, the holds and
 * the deprecated pair, which states what `target` states for a body and nothing for a vessel or a port.
 */
function expectTargets(s: SimSnapshot, selected: TargetRef | null, label: string): void {
  const r = s.readouts;
  const m = s.navball.markers;
  const active = activeVesselOf(s)!;
  expect(r.target === null, `${label}: a target read-out exactly with a target`).toBe(selected === null);
  expect(r.target?.ref ?? null, `${label}: the target is the one selected`).toEqual(selected);
  expect(m.target === null, `${label}: the target marker`).toBe(selected === null);
  expect(m.antiTarget === null, label).toBe(selected === null);
  const craft = selected !== null && selected.kind !== 'body';
  expect(r.sasModesAvailable.includes('target') && r.sasModesAvailable.includes('antiTarget'), `${label}: the holds on a vessel`).toBe(craft);
  expect(r.sasModesAvailable.includes('portAlign'), `${label}: the hold on a port`).toBe(selected?.kind === 'port');
  // The docking instrument: a port is targeted and the control point is an own port.
  const docking = r.docking ?? null;
  expect(docking !== null, `${label}: the docking instrument exactly with a port target`).toBe(selected?.kind === 'port');
  if (docking !== null && selected?.kind === 'port') {
    expect(docking.targetPort, label).toBe(selected.portId);
    expect(docking.ownPort, `${label}: the own port is the control point`).toBe(active.helm!.controlPart);
  }
  const t = r.target ?? null;
  if (t !== null) {
    if (t.ref.kind === 'body') {
      // A body: always solid and on the viewer's clock, no relative velocity, no local-vertical frame, no offer.
      expect([t.presence, t.timeOffset, t.relVelocity, t.relSpeed, t.lvlh, t.offer], label).toEqual(['solid', 0, null, null, null, null]);
      expect(m.relativePrograde ?? null, label).toBeNull();
    } else {
      expect(t.relVelocity, label).not.toBeNull();
      expect(t.relSpeed, label).toBeCloseTo(v3.len(t.relVelocity!), 9);
      expect((m.relativePrograde ?? null) !== null, `${label}: the relative markers above 1 mm/s`).toBe(t.relSpeed! >= 1e-3);
      expect((m.relativeRetrograde ?? null) !== null, label).toBe(t.relSpeed! >= 1e-3);
      expect(t.offer === null, `${label}: an offer exactly for an echo`).toBe(t.presence === 'solid');
    }
    expect(t.range, label).toBeGreaterThanOrEqual(0);
    expect(t.closestApproaches.length, label).toBeLessThanOrEqual(3);
  }
  // The deprecated pair, read through the access module as every consumer reads it: taken alone it states the
  // body target and its inclination, and no target at all for a vessel or a port.
  const deprecated = targetOf({ ...r, target: undefined });
  if (selected !== null && selected.kind === 'body') expect(deprecated, `${label}: the deprecated pair states the body target`).toMatchObject({ ref: selected, relativeInclination: t!.relativeInclination });
  else expect(deprecated, `${label}: the deprecated pair states no body target`).toBeNull();
}

/**
 * The stores agree with the snapshot: the census lists exactly its vessels with their craft, owners, body and
 * size; the account's ship is in the active vessel; the assembly panel is there exactly for a vessel of
 * several craft and states its craft, links and helm; the roster, the pads and the clock name vessels that exist.
 */
function expectStores(session: FakeSession, s: SimSnapshot, label: string): void {
  const active = activeVesselOf(s)!;
  const census = session.stores.census.get();
  expect([...census.keys()].sort(), `${label}: the census lists the vessels of the snapshot`).toEqual(s.vessels.map((v) => v.id).sort());
  for (const v of s.vessels) {
    const entry = census.get(v.id)!;
    const crafts = v.crafts!;
    const landed = v.situation === 'prelaunch' || v.situation === 'landed' || v.situation === 'splashed';
    expect(
      { vesselId: entry.vesselId, craftIds: entry.craftIds, kind: entry.kind, name: entry.name, vehicleId: entry.vehicleId, ownerIds: entry.ownerIds, ownerCallsigns: entry.ownerCallsigns, bodyId: entry.bodyId, radius: entry.radius, revision: entry.revision },
      `${label}: the census entry of ${v.id}`,
    ).toEqual({ vesselId: v.id, craftIds: crafts.map((c) => c.id), kind: crafts.length > 1 ? 'assembly' : 'ship', name: v.name, vehicleId: v.vehicleId, ownerIds: crafts.map((c) => c.ownerId), ownerCallsigns: crafts.map((c) => c.ownerCallsign), bodyId: v.bodyId, radius: v.boundingRadius, revision: v.revision });
    expect(entry.landed !== null, `${label}: ${v.id} is listed as landed exactly when it stands`).toBe(landed);
    expect(entry.patches.length > 0, `${label}: ${v.id} has a chain exactly when it flies`).toBe(!landed);
    for (const p of entry.patches) expect(p.bodyId, label).toBe(v.bodyId);
  }
  const ships = session.stores.ships.get();
  expect(ships.map((r) => [r.craftId, r.vesselId, r.isAssembly, r.situation, r.bodyId]), `${label}: the account's ship`).toEqual([[FAKE_VESSEL_ID, active.id, active.crafts!.length > 1, active.situation, active.bodyId]]);
  expect(active.crafts!.some((c) => c.id === FAKE_VESSEL_ID), `${label}: the ship's craft is aboard the vessel it is listed in`).toBe(true);
  const view = session.stores.assembly.get();
  expect(view !== null, `${label}: the assembly panel exactly for a vessel of several craft`).toBe(active.crafts!.length > 1);
  if (view !== null) {
    expect(view.vesselId, label).toBe(active.id);
    expect(view.crafts.map((c) => [c.craftId, c.name, c.ownerId, c.seniority]), label).toEqual(active.crafts!.map((c, i) => [c.id, c.name, c.ownerId, i]));
    expect(view.links, label).toEqual(active.links!.map((l) => ({ a: l.a, b: l.b })));
    expect(view.helm, label).toEqual({ accountId: active.helm!.accountId, callsign: active.helm!.callsign, craftId: active.helm!.craftId, request: null });
    expect(active.crafts!.some((c) => c.id === view.anchorCraftId), `${label}: the anchor is a craft of the assembly`).toBe(true);
    // Every port the panel lists is a part of its craft, and its peer is the craft at the other end of a link.
    for (const c of view.crafts) {
      for (const port of c.ports) {
        expect(craftIdOf(active, partByKey(active, port.portId)!), `${label}: the port ${port.portId} is a part of ${c.craftId}`).toBe(c.craftId);
        expect(view.crafts.some((x) => x.craftId === port.peerCraftId), label).toBe(true);
      }
      expect(c.ports.length, `${label}: ${c.craftId} is docked by a port`).toBeGreaterThan(0);
    }
  }
  for (const entry of session.stores.roster.get()) {
    expect(s.vessels.some((v) => v.id === entry.vesselId), `${label}: the roster's ${entry.callsign} is in a vessel of the snapshot`).toBe(true);
    if (entry.relation === 'docked') expect(entry.vesselId, label).toBe(active.id);
  }
  for (const pad of session.stores.pads.get()) {
    if (pad.vesselId !== null) expect(census.has(pad.vesselId), `${label}: the vessel on the pad ${pad.padId} is in the census`).toBe(true);
    expect(pad.state === 'occupied', label).toBe(pad.accountId !== null);
  }
  for (const member of s.time!.members) if (member.vesselId !== null) expect(census.has(member.vesselId), `${label}: the clock's member ${member.callsign} flies a vessel of the census`).toBe(true);
  for (const id of s.time!.limitedBy?.vesselIds ?? []) expect(census.has(id), label).toBe(true);
  const waiting = session.stores.launchQueue.get();
  expect(waiting !== null, `${label}: a launch waits exactly while its spawn is in flight`).toBe(session.pendingSpawn !== null);
  expect(session.stores.presence.get().summary.queued, label).toBe(waiting === null ? 0 : 1);
}

// ------------------------------------------------------------------------------------------- the comparison

/** What must hold of the fake's value against the session's where the two need not be equal. */
type Check =
  /** Numbers that agree to a tolerance: |a - b| <= abs + rel * max(|a|, |b|). */
  | { is: 'close'; rel: number; abs: number }
  /** Numbers of one sign within a factor of each other (zero only against zero). */
  | { is: 'factor'; by: number }
  /** Each a number of the field's unit inside the range; the two need not agree. */
  | { is: 'within'; min: number; max: number }
  /** A stand-in figure: zero exactly where the session's is zero, else both above zero and at most `max`. */
  | { is: 'standIn'; max: number }
  /** Each one of the listed values. */
  | { is: 'among'; values: readonly unknown[] }
  /** Values of the same type (a switch, a sentence): each producer's own. */
  | { is: 'kind' }
  /** An opaque id: the fake's ids stand for the session's one to one, the same one everywhere. */
  | { is: 'id' }
  /** A part key: it names the same part (by its place in the part list) of the corresponding vessel. */
  | { is: 'partKey' }
  /** A vector: the lengths by `length`; the directions within `angleDeg` (absent: each producer's own). */
  | { is: 'vector'; length: Check; angleDeg?: number }
  /** A unit vector; within `angleDeg` of the session's (absent: each producer's own direction). */
  | { is: 'unit'; angleDeg?: number }
  /** A unit quaternion; the rotation within `angleDeg` of the session's (absent: each producer's own). */
  | { is: 'rotation'; angleDeg?: number }
  /** The same fields of the same types all through the value; the numbers are each producer's own. */
  | { is: 'shape' }
  /** Not compared field by field: `by` names the check below the table that holds it. */
  | { is: 'apart'; by: string };

interface Row {
  /** The fields: paths in the snapshot with `[]` for every element of an array; a trailing `*` is every field that begins so. */
  at: readonly string[];
  /** The scenes the row is for (absent: every scene). */
  scenes?: readonly FakeScene[];
  check: Check;
  /** True: one of the two may be null (or absent) where the other is not. Else null goes with null. */
  nullable?: boolean;
  why: string;
}

const close = (rel: number, abs = 0): Check => ({ is: 'close', rel, abs });
const factor = (by: number): Check => ({ is: 'factor', by });
const within = (min: number, max: number): Check => ({ is: 'within', min, max });
const vector = (length: Check, angleDeg?: number): Check => (angleDeg === undefined ? { is: 'vector', length } : { is: 'vector', length, angleDeg });
const unit = (angleDeg?: number): Check => (angleDeg === undefined ? { is: 'unit' } : { is: 'unit', angleDeg });
const rotation = (angleDeg?: number): Check => (angleDeg === undefined ? { is: 'rotation' } : { is: 'rotation', angleDeg });
const apart = (by: string): Check => ({ is: 'apart', by });

const STANDING: readonly FakeScene[] = ['pad', 'lunarSurface'];
const ORBITS: readonly FakeScene[] = ['lowOrbit', 'translunar', 'lunarOrbit', 'reentry'];
const IN_AIR: readonly FakeScene[] = ['pad', 'ascent', 'reentry', 'chutes'];
const FLIGHT = "the flight itself is the fake's own: it stands on a circle about the body, or climbs and sinks at a constant rate, where the session flies its scenario's trajectory";
const ATTITUDE = "the attitude is the fake's own: it follows the inputs directly and starts along its own velocity";
const STAGE_FIGURES = 'the fake runs no staging analysis (src/sim/vessel/facade.ts, stagingInfo): a stage that burns states stand-in figures; that a stage burns at all is held exactly (zero against zero)';
const NO_PREDICTION = 'the fake predicts nothing: no arrival point, no approach, no plane crossing';

/**
 * THE TABLE: every field in which the fake need not equal the session, the scenes it is true of, what still
 * holds, and why. A field that is not here is equal in every scene. Rows for particular scenes come before a
 * row of the same field for every scene.
 */
const TOLERANCES: readonly Row[] = [
  // ---- ids
  { at: ['activeVesselId', 'vessels[].id', 'vessels[].crafts[].id', 'vessels[].helm.craftId', 'vessels[].parts[].craftId', 'scenario.id'], check: { is: 'id' }, why: "ids are opaque: the fake issues its own ('fake-vessel', 'fake-pad') where the session issues its craft's and its scenario's" },
  { at: ['vessels[].helm.controlPart'], check: { is: 'partKey' }, why: 'a part key is composed of the craft id: it names the same part of the same craft' },
  { at: ['vessels'], check: apart('vessel by vessel: the active vessel against the active vessel (compare); a vessel only the session has is a row of its own'), why: 'the list is matched by role, not by position' },
  { at: ['vessels(session only)'], scenes: ['ascent'], check: apart('named in the row'), why: 'the launch mount the session leaves standing on the pad at lift-off is a vessel of its own (ground structure); the fake starts in the climb and never had one' },

  // ---- clocks and counters
  { at: ['tick', 'revision', 'vessels[].revision'], check: within(0, 1e7), why: 'counters: the session has taken its first step (and counted the rails it went on); the fake counts its own steps and its vessel never changes its orbit' },
  { at: ['vessels[].age', 'readouts.met'], check: within(0, 600), why: 's: each producer counts from its own start (the session has stepped once, or flown its ascent)' },
  { at: ['scenario.stagesAlreadyFired'], scenes: ['ascent'], check: within(0, 1), why: 'the session fired its first stage in flight (its scenario starts on the pad with none fired); the fake starts with it fired' },
  { at: ['scenario.startKind'], check: { is: 'among', values: ['pad', 'orbit', 'landed', 'state'] }, why: "every scene of the fake is published as a 'state' start: it has no scenario files" },

  // ---- warp
  { at: ['warp.maxIndex'], check: within(0, WARP_LEVELS.length - 1), why: 'the fake limits warp for one reason, integration; a session also by altitude and by an event ahead' },
  { at: ['time.maxRate'], check: { is: 'among', values: WARP_LEVELS }, why: 'the rate of that index' },
  { at: ['warp.limitedBy'], check: { is: 'kind' }, nullable: true, why: 'the sentence of the limit is each producer\'s own, and the fake has fewer limits' },
  { at: ['time.limitedBy'], check: { is: 'shape' }, nullable: true, why: 'the same limit as a block: its kind and sentence are each producer\'s own' },
  { at: ['warp.onRails'], check: { is: 'kind' }, why: 'the fake integrates nothing: it is on rails whenever nothing burns and there is no air; a session goes on rails at its first advance' },

  // ---- bodies
  { at: ['bodies[].rRoot', 'bodies[].vRoot'], check: vector(factor(1.08), 8), why: "the fake moves a body on the circle of its orbit's size, in its plane and with its period (bodyState: 'Circular approximation'): within the eccentricity of the distance and a few degrees of the place" },
  { at: ['bodies[].orbit'], check: { is: 'shape' }, why: 'the elements of that circle: the same fields, no eccentricity' },
  { at: ['bodies[].qFixedToRoot'], check: rotation(12), why: 'a tidally locked body faces the centre of that circle; its pole is the normal of its orbit' },
  { at: ['bodies[].spinRoot'], check: vector(close(1e-6), 8), why: 'the same rate about that pole' },
  { at: ['bodies[].sunDir'], check: unit(), why: 'a unit vector; the direction is held to 0.2 degree for every body but the star below (the star\'s own is undefined: the fake states +X)' },
  { at: ['bodies[].sunDistance'], check: close(1e-3), why: 'the distance to the star from that circle' },

  // ---- where the vessel is and how it moves
  { at: ['vessels[].r', 'vessels[].rRoot'], scenes: ['pad', 'ascent'], check: vector(close(1e-4), 0.1), why: 'the same pad: the fake stands with its origin 60 m up on a body without relief (the ascent: put at the session\'s altitude)' },
  { at: ['vessels[].v', 'vessels[].vRoot'], scenes: ['pad'], check: vector(close(1e-4), 0.1), why: 'the ground\'s velocity at that height' },
  { at: ['vessels[].v', 'vessels[].vRoot'], scenes: ['ascent'], check: vector(factor(1.5), 40), why: 'the ground\'s velocity and the climb: the fake climbs at 350 m/s, the session at what a minute of thrust gave it' },
  { at: ['vessels[].r', 'vessels[].rRoot', 'vessels[].v', 'vessels[].vRoot'], scenes: ['lunarSurface'], check: vector(close(1e-4), 8), why: 'the same landing point on a Moon that the fake turns about the pole of its circular orbit' },
  { at: ['vessels[].r', 'vessels[].rRoot', 'vessels[].v', 'vessels[].vRoot'], scenes: ['lowOrbit', 'lunarOrbit'], check: vector(factor(1.02)), why: `a circle at the scenario's altitude to 2 %; the place on it and its plane are the fake's own (${FLIGHT})` },
  { at: ['vessels[].r', 'vessels[].rRoot', 'vessels[].v', 'vessels[].vRoot'], scenes: ['translunar'], check: vector(factor(2.5)), why: 'the fake coasts on a circle at 180,000 km; the session is 82,000 km out on its transfer ellipse' },
  { at: ['vessels[].r', 'vessels[].rRoot', 'vessels[].v', 'vessels[].vRoot'], scenes: ['reentry'], check: vector(factor(1.5)), why: 'the scenario starts 840 km up on the way down to the interface; the fake stands at peak heating, 68 km up at circular speed' },
  { at: ['vessels[].r', 'vessels[].rRoot', 'vessels[].v', 'vessels[].vRoot'], scenes: ['chutes'], check: vector(factor(1.05)), why: 'a few kilometres up over the ocean, moving with the ground: the fake over its own recovery zone, sinking at 8 m/s' },
  { at: ['vessels[].q', 'navball.qVesselToHorizon'], scenes: ['ascent'], check: rotation(3), why: 'climbing nose up, the ventral side east; the session has no pilot and has leaned a degree in its minute' },
  { at: ['vessels[].q'], scenes: ['lunarSurface'], check: rotation(12), why: 'the same attitude at the landing point of a Moon whose pole the fake puts along the normal of its circular orbit' },
  { at: ['navball.qVesselToHorizon'], scenes: ['pad', 'lunarSurface'], check: rotation(0.5), why: 'standing nose up, the ventral side east, against the local horizon: the same' },
  { at: ['vessels[].q', 'navball.qVesselToHorizon'], check: rotation(), why: ATTITUDE },
  { at: ['vessels[].w'], check: vector(within(0, 1)), why: 'rad/s: the fake turns by the inputs alone; standing it does not turn with its body, and it does not swing under a parachute' },
  { at: ['vessels[].situation'], scenes: ['reentry'], check: { is: 'among', values: ['flying', 'suborbital'] }, why: 'the fake is in the air at peak heating (flying); the session still above it (suborbital)' },
  { at: ['vessels[].translationMode'], scenes: ['reentry'], check: { is: 'among', values: ['integrated', 'rails'] }, why: 'for the same reason: integrated in the air, on rails above it' },

  // ---- the air and what it does
  { at: ['vessels[].aero.pressure', 'vessels[].aero.airDensity'], scenes: ['pad', 'ascent', 'chutes'], check: factor(2), why: 'the fake\'s air is one exponential of 7.2 km scale height from sea-level values' },
  { at: ['vessels[].aero.pressure', 'vessels[].aero.airDensity'], scenes: ['reentry'], check: within(0, 2e5), why: 'Pa, kg/m^3: the fake is in the upper air, the session above it' },
  { at: ['vessels[].aero.temperature'], scenes: IN_AIR, check: within(2, 400), why: 'K: the fake\'s air is 250 K at every height' },
  { at: ['vessels[].aero.q', 'readouts.dynamicPressure'], scenes: IN_AIR, check: within(0, 1e5), why: `Pa: ${FLIGHT}` },
  { at: ['vessels[].aero.mach', 'readouts.mach'], scenes: IN_AIR, check: within(0, 40), why: 'the speed over a speed of sound of 300 m/s' },
  { at: ['vessels[].aero.aoa', 'readouts.angleOfAttack'], check: within(0, Math.PI), why: `rad: ${ATTITUDE}` },
  { at: ['vessels[].aero.airVelocity'], check: vector(within(0, 20000)), why: `m/s: ${FLIGHT}` },
  { at: ['vessels[].aero.heatFlux', 'readouts.heatFlux'], scenes: ['ascent', 'reentry', 'chutes'], check: within(0, 1e7), why: 'W/m^2: the fake heats in its entry scene only, at the peak' },
  { at: ['vessels[].aero.plasmaIntensity'], scenes: ['reentry'], check: within(0, 1), why: 'the plasma of that peak, 0 to 1; the session is still above the air' },
  { at: ['vessels[].gLoad', 'readouts.gLoad'], scenes: STANDING, check: close(1e-3), why: 'standing: the local gravity over g0, at the fake\'s own height' },
  { at: ['vessels[].gLoad', 'readouts.gLoad'], scenes: ['ascent', 'reentry', 'chutes'], check: within(0, 15), why: 'g: the thrust over the weight; 4.5 g at the peak of the entry; none under the canopy (the fake sinks at a constant rate)' },
  { at: ['vessels[].properAccel'], scenes: STANDING, check: vector(close(1e-3), 0.1), why: 'the ground\'s reaction: the local gravity along the nose' },
  { at: ['vessels[].properAccel'], scenes: ['ascent', 'reentry', 'chutes'], check: vector(within(0, 150)), why: 'm/s^2: the fake states the thrust along the nose and no drag' },
  { at: ['vessels[].contact.maxForce'], scenes: STANDING, check: close(1e-3), why: 'N: the weight on the ground at that gravity' },
  { at: ['vessels[].thrust', 'readouts.thrust', 'readouts.twr', 'vessels[].parts[].modules[].thrust'], scenes: ['ascent'], check: close(0.1), why: 'the same engines at full throttle in air of another pressure (the specific impulse between sea level and vacuum)' },
  { at: ['vessels[].mass', 'readouts.mass'], scenes: ['ascent'], check: close(1e-4), why: 'under thrust the session states the mass its last step began with: one step of propellant, 4e-5 of the stack' },
  { at: ['vessels[].comLocal'], scenes: ['ascent'], check: vector(close(1e-4), 0.01), why: 'the centre of that mass' },

  // ---- the parts: the session's own list, with what the fake drives
  { at: ['vessels[].parts[].modules[].ambientPressure'], scenes: ['pad', 'ascent', 'chutes', 'reentry'], check: within(0, 2e5), why: 'Pa: the fake restates every engine\'s ambient pressure from its own air; a session states it where the engine last ran' },
  { at: ['vessels[].parts[].modules[].pressureRatio'], scenes: ['pad', 'ascent', 'chutes', 'reentry'], check: within(0, 1e6), why: 'the exit pressure over that' },
  { at: ['vessels[].parts[].modules[].throttleActual', 'vessels[].parts[].modules[].massFlow'], scenes: ['ascent'], check: close(5e-3), why: 'the fake\'s engines have spooled up for five seconds' },
  { at: ['vessels[].parts[].modules[].ignitionAge'], scenes: ['ascent'], check: within(0, 600), why: 's: they lit when the fake began' },

  // ---- the stage stack
  { at: ['staging.stages[].deltaVVac', 'staging.stages[].deltaVNow', 'vessels[].crafts[].staging.stages[].deltaVVac', 'vessels[].crafts[].staging.stages[].deltaVNow'], check: { is: 'standIn', max: 20000 }, why: `m/s: ${STAGE_FIGURES}` },
  { at: ['staging.stages[].twr', 'vessels[].crafts[].staging.stages[].twr'], check: { is: 'standIn', max: 200 }, why: STAGE_FIGURES },
  { at: ['staging.stages[].burnTime', 'vessels[].crafts[].staging.stages[].burnTime'], check: { is: 'standIn', max: 3600 }, why: `s: ${STAGE_FIGURES}` },
  { at: ['staging.stages[].propellantFraction', 'vessels[].crafts[].staging.stages[].propellantFraction'], check: within(0, 1), why: 'the fake states a full group until the throttle opens, then half of it' },
  { at: ['readouts.deltaVTotal'], check: { is: 'standIn', max: 60000 }, why: 'm/s: the sum of those stand-in figures (that it is the sum is held for both)' },

  // ---- the navball
  { at: ['navball.markers.prograde', 'navball.markers.retrograde', 'navball.markers.normal', 'navball.markers.antinormal', 'navball.markers.radialOut', 'navball.markers.radialIn', 'navball.markers.target', 'navball.markers.antiTarget'], check: unit(), why: `unit directions in the vessel's frame: ${ATTITUDE}` },
  { at: ['navball.markers.liftVector'], scenes: ['reentry', 'chutes'], check: unit(), nullable: true, why: 'the fake states a lift vector in its entry scene only; a session wherever a lifting capsule is in the air' },
  { at: ['navball.markers.relativePrograde', 'navball.markers.relativeRetrograde'], check: apart('expectTargets'), why: 'v2 members no session states before wave 4: held to the contract' },
  { at: ['navball.pitchDeg'], check: within(-90, 90), why: `degrees: ${ATTITUDE}` },
  { at: ['navball.headingDeg'], check: within(0, 360), why: `degrees: ${ATTITUDE}` },
  { at: ['navball.rollDeg'], check: within(-180, 180), why: `degrees: ${ATTITUDE}` },

  // ---- the read-outs of the flight
  { at: ['readouts.altitudeAsl', 'readouts.altitudeRadar'], scenes: ['pad'], check: within(0, 200), why: 'm: the fake stands with its origin 60 m up on a body without relief; the session on its pad' },
  { at: ['readouts.altitudeAsl', 'readouts.altitudeRadar'], scenes: ['lunarSurface'], check: within(0, 100), why: 'm: the same on the Moon: the fake stands with its origin 30 m up, the session on its legs' },
  { at: ['readouts.altitudeAsl'], scenes: ['ascent'], check: close(1e-3), why: 'put at the session\'s altitude' },
  { at: ['readouts.altitudeRadar'], scenes: ['ascent'], check: factor(1.2), why: 'the fake has no relief and measures from its origin; the session from its lowest point to the ground' },
  { at: ['readouts.altitudeAsl', 'readouts.altitudeRadar'], scenes: ['lowOrbit', 'lunarOrbit'], check: factor(1.1), why: 'the scenario\'s altitude: 200 km against 202, 100 km against 105' },
  { at: ['readouts.altitudeAsl', 'readouts.altitudeRadar'], scenes: ['translunar', 'chutes'], check: factor(4), why: '180,000 km against 82,000 on the way out; 2.5 km against 7 km under the canopy' },
  { at: ['readouts.altitudeAsl', 'readouts.altitudeRadar'], scenes: ['reentry'], check: factor(15), why: '68 km at peak heating against 840 km at the scenario\'s start' },
  { at: ['readouts.latitude', 'readouts.longitude'], scenes: ['pad', 'lunarSurface'], check: close(0, 1e-6), why: 'rad: the same place on the ground' },
  { at: ['readouts.latitude', 'readouts.longitude'], scenes: ['ascent'], check: close(0, 1e-3), why: 'rad: over the pad; the session has drifted from it by what the turning ground left behind' },
  { at: ['readouts.latitude'], check: within(-Math.PI / 2, Math.PI / 2), why: `rad: ${FLIGHT}` },
  { at: ['readouts.longitude'], check: within(-Math.PI, Math.PI), why: `rad: ${FLIGHT}` },
  { at: ['readouts.speedOrbital'], scenes: ['pad', 'lunarSurface'], check: close(1e-4), why: 'the ground\'s speed at that height' },
  { at: ['readouts.speedSurface', 'readouts.verticalSpeed', 'readouts.horizontalSpeed'], scenes: STANDING, check: close(0, 1e-6), why: 'm/s: at rest; the session to the rounding of its hold' },
  { at: ['readouts.speedOrbital', 'readouts.speedSurface', 'readouts.horizontalSpeed'], scenes: ['lowOrbit', 'lunarOrbit'], check: factor(1.02), why: 'the circular speed at that altitude' },
  { at: ['readouts.speedOrbital', 'readouts.speedSurface', 'readouts.horizontalSpeed'], scenes: ['translunar', 'reentry'], check: factor(2.5), why: 'the circular speed where the fake is against the speed on the session\'s ellipse' },
  { at: ['readouts.speedOrbital'], scenes: ['ascent', 'chutes'], check: factor(1.5), why: 'the ground\'s speed and the climb or the sink' },
  { at: ['readouts.speedSurface', 'readouts.horizontalSpeed'], scenes: ['ascent', 'chutes'], check: within(0, 1000), why: 'm/s: the fake climbs at 350 m/s and sinks at 8 m/s, straight up and down' },
  { at: ['readouts.verticalSpeed'], check: within(-12000, 12000), why: 'm/s: none on the fake\'s circle; its constant climb and sink' },
  { at: ['readouts.apoapsisAltitude'], scenes: ['pad', 'lunarSurface', 'ascent', 'chutes'], check: within(0, 2e4), why: 'm: the orbit of a point that moves with the ground is as high as the point' },
  { at: ['readouts.timeToApoapsis'], scenes: STANDING, check: within(0, 3000), why: 's: standing, the point is at the top of that orbit: the time to the next top is nothing or a whole period, by the rounding of where it is' },
  { at: ['readouts.periapsisAltitude', 'readouts.eccentricity', 'readouts.period', 'readouts.timeToApoapsis', 'readouts.timeToPeriapsis'], scenes: ['pad', 'lunarSurface', 'chutes'], check: close(2e-2), why: 'that orbit: the same to the height of the point' },
  { at: ['readouts.periapsisAltitude', 'readouts.eccentricity', 'readouts.period'], scenes: ['ascent'], check: close(2e-2), why: 'that orbit, with the climb' },
  { at: ['readouts.timeToApoapsis', 'readouts.timeToPeriapsis'], scenes: ['ascent'], check: within(0, 2000), why: 's: the climb puts the top of that orbit a few seconds ahead' },
  { at: ['readouts.apoapsisAltitude', 'readouts.periapsisAltitude'], scenes: ['lowOrbit', 'lunarOrbit'], check: factor(1.5), why: 'a circle at the scenario\'s altitude against its slightly eccentric orbit' },
  { at: ['readouts.apoapsisAltitude', 'readouts.periapsisAltitude'], scenes: ['translunar', 'reentry'], check: within(4e4, 6e8), why: 'm: the fake\'s circle against the session\'s transfer and return ellipses' },
  { at: ['readouts.period'], scenes: ['lowOrbit', 'lunarOrbit'], check: factor(1.02), why: 'the period of that circle' },
  { at: ['readouts.period'], scenes: ['translunar', 'reentry'], check: within(3000, 2e6), why: 's: the period of the fake\'s circle against the ellipse\'s' },
  { at: ['readouts.timeToApoapsis', 'readouts.timeToPeriapsis'], scenes: ORBITS, check: within(0, 2e6), why: 's: a circle has its apsides where the fake puts them (it starts at its periapsis)' },
  { at: ['readouts.eccentricity'], scenes: ORBITS, check: within(0, 1), why: 'the fake\'s orbit is a circle' },
  { at: ['readouts.inclination'], scenes: ['ascent'], check: close(0, 1e-4), why: 'rad, to the body\'s equator: the latitude of the pad, from which the session has drifted a little' },
  { at: ['readouts.inclination'], scenes: ['lowOrbit', 'translunar', 'lunarOrbit', 'reentry', 'chutes'], check: within(0, Math.PI), why: `rad, to the body's equator: ${FLIGHT}` },
  { at: ['readouts.tiltFromVertical'], check: within(0, Math.PI), why: `rad: ${ATTITUDE}` },
  { at: ['readouts.sasEnabled', 'readouts.rcsEnabled'], check: { is: 'kind' }, why: 'the pilot\'s switches: the fake starts with the SAS on (its holds work at once) and the thrusters off; a session with the SAS off and the thrusters on once a fired stage enabled them' },
  { at: ['readouts.chuteEnvelope'], scenes: ['ascent', 'reentry', 'chutes'], check: { is: 'among', values: ['safe', 'risky', 'unsafe'] }, nullable: true, why: 'the light is judged at each producer\'s own flight condition; that it is the contract\'s judgement of that condition is held for both (chuteLightOf)' },
  { at: ['readouts.liftVectorUp'], scenes: ['reentry', 'chutes'], check: { is: 'kind' }, nullable: true, why: 'with the lift vector above' },
  { at: ['readouts.launchWindow.timeToPlaneCrossing'], check: within(0, 86400), why: `s: ${NO_PREDICTION}; it counts ten minutes down` },
  { at: ['readouts.launchWindow.launchAzimuthDeg'], check: within(0, 360), why: `degrees: ${NO_PREDICTION}; it states one azimuth` },
  { at: ['readouts.landingTarget.targetId'], check: { is: 'kind' }, why: 'the nearest landing or recovery target to each producer\'s own sub-point' },
  { at: ['readouts.landingTarget.distance'], check: within(0, 2.1e7), why: `m along the surface: ${FLIGHT}` },
  { at: ['readouts.landingTarget.bearingDeg'], check: within(0, 360), why: 'degrees: from that sub-point' },
  { at: ['readouts.landingTarget.downRange', 'readouts.landingTarget.crossRange'], check: within(-2.1e7, 2.1e7), why: 'm: along and across that ground track' },
  { at: ['readouts.landingTarget.predicted'], check: { is: 'shape' }, nullable: true, why: NO_PREDICTION },

  // ---- the target, the trajectory, what happened
  { at: ['readouts.target*', 'readouts.docking'], check: apart('compare: through targetOf of the access module, as every consumer reads them; expectTargets'), why: '`target` and `docking` are v2 members no session states before wave 4, and the deprecated pair beside them is read through the access module only' },
  { at: ['targetOf(readouts).relativeInclination'], scenes: ['pad', 'ascent'], check: close(0, 0.2), why: 'rad: the fake\'s Moon keeps the orbit plane of its definition\'s epoch (a session\'s precesses); standing, both state that plane\'s inclination less the latitude' },
  { at: ['targetOf(readouts).relativeInclination'], check: within(0, Math.PI), why: `rad: the angle between the two orbit planes, and the fake's is its own (${FLIGHT})` },
  { at: ['targetOf(readouts).closestApproaches'], check: apart('compare: the fake lists none'), why: NO_PREDICTION },
  { at: ['patches.current'], check: apart('compare: one closed patch about the session\'s body in an orbit scene, none on a surface scene; the contract of a patch for both'), why: 'the fake draws its own circle; a session its chain of patches to the next event' },
  { at: ['events', 'milestones'], scenes: ['ascent'], check: apart('named in the row'), why: 'what happened in the session\'s minute of flight (the ignitions, the release, lift-off); the fake starts in the climb' },
];

const ROWS_AT = new Map<string, Row[]>();
const ROWS_BEGINNING: { prefix: string; row: Row }[] = [];
for (const row of TOLERANCES) {
  for (const at of row.at) {
    if (at.endsWith('*')) ROWS_BEGINNING.push({ prefix: at.slice(0, -1), row });
    else ROWS_AT.set(at, [...(ROWS_AT.get(at) ?? []), row]);
  }
}

/** The row of the table for a field in a scene: the first that names the field and is for the scene. */
function rowAt(at: string, scene: FakeScene): Row | undefined {
  const named = ROWS_AT.get(at)?.find((r) => r.scenes === undefined || r.scenes.includes(scene));
  return named ?? ROWS_BEGINNING.find((b) => at.startsWith(b.prefix) && (b.row.scenes === undefined || b.row.scenes.includes(scene)))?.row;
}

const isVec = (x: unknown): x is Vec3 => typeof x === 'object' && x !== null && !Array.isArray(x) && Object.keys(x).length === 3 && ['x', 'y', 'z'].every((k) => typeof (x as Record<string, unknown>)[k] === 'number');
const isQuat = (x: unknown): x is Quat => typeof x === 'object' && x !== null && !Array.isArray(x) && Object.keys(x).length === 4 && ['x', 'y', 'z', 'w'].every((k) => typeof (x as Record<string, unknown>)[k] === 'number');
const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const absent = (x: unknown): boolean => x === null || x === undefined;
const show = (x: unknown): string => {
  const text = x === undefined ? 'absent' : JSON.stringify(x);
  return text.length > 80 ? `${text.slice(0, 80)}...` : text;
};

/** Equal as two producers of the same thing are: numbers to the rounding, a vector as a vector, a rotation as a rotation, null with null. */
function same(f: unknown, r: unknown): boolean {
  if (f === r) return true;
  if (absent(f) || absent(r)) return absent(f) && absent(r) && (f === undefined) === (r === undefined);
  if (typeof f === 'number' && typeof r === 'number') return Math.abs(f - r) <= 1e-9 * Math.max(Math.abs(f), Math.abs(r));
  if (isVec(f) && isVec(r)) return v3.dist(f, r) <= 1e-9 * Math.max(v3.len(f), v3.len(r));
  if (isQuat(f) && isQuat(r)) return Math.min(Math.hypot(f.x - r.x, f.y - r.y, f.z - r.z, f.w - r.w), Math.hypot(f.x + r.x, f.y + r.y, f.z + r.z, f.w + r.w)) <= 1e-9;
  if (Array.isArray(f) && Array.isArray(r)) return f.length === r.length && f.every((x, i) => same(x, r[i]));
  if (isRecord(f) && isRecord(r)) return [...new Set([...Object.keys(f), ...Object.keys(r)])].every((k) => same(f[k], r[k]));
  return false;
}

/** Where two values do not state the same fields of the same types (every element of every array). */
function shapeDifferences(a: unknown, b: unknown, path = ''): string[] {
  if (absent(a) || absent(b)) return [];
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return [`${path}: a list against ${typeof (Array.isArray(a) ? b : a)}`];
    return a.flatMap((x, i) => (i < b.length ? shapeDifferences(x, b[i], `${path}[${i}]`) : []));
  }
  if (typeof a !== typeof b) return [`${path}: ${typeof a} against ${typeof b}`];
  if (!isRecord(a) || !isRecord(b)) return [];
  const out: string[] = [];
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if ((a[key] !== undefined) !== (b[key] !== undefined)) out.push(`${path}.${key}: only in the ${a[key] !== undefined ? 'fake' : 'session'}`);
    else out.push(...shapeDifferences(a[key], b[key], `${path}.${key}`));
  }
  return out;
}

interface Comparison {
  scene: FakeScene;
  fake: SimSnapshot;
  real: SimSnapshot;
  /** The session's id each id of the fake stands for, and back. */
  ids: Map<string, string>;
  idsBack: Map<string, string>;
  differences: string[];
  /** The rows without which a field would have been a difference. */
  needed: Set<Row>;
}

/** Vessel and part a key names, as their places in the lists; null when nothing has that key. */
function placeOf(s: SimSnapshot, key: string): string | null {
  for (const [i, v] of s.vessels.entries()) {
    const j = v.parts.findIndex((p) => partKeyOf(v, p) === key);
    if (j >= 0) return `${v.id === s.activeVesselId ? 'active' : i}:${j}`;
  }
  return null;
}

/** What is wrong between the two values under a check of the table; null when it holds. */
function judge(c: Comparison, check: Check, f: unknown, r: unknown): string | null {
  const numbers = typeof f === 'number' && typeof r === 'number' && Number.isFinite(f) && Number.isFinite(r);
  switch (check.is) {
    case 'close':
      if (!numbers) return `${show(f)} against ${show(r)}: not two numbers`;
      return Math.abs(f - r) <= check.abs + check.rel * Math.max(Math.abs(f), Math.abs(r)) ? null : `${f} against ${r}: further apart than ${check.rel} relative and ${check.abs} absolute`;
    case 'factor':
      if (!numbers) return `${show(f)} against ${show(r)}: not two numbers`;
      if (f === 0 && r === 0) return null;
      return f * r > 0 && Math.max(f / r, r / f) <= check.by ? null : `${f} against ${r}: not within a factor of ${check.by}`;
    case 'within':
      if (!numbers) return `${show(f)} against ${show(r)}: not two numbers`;
      return [f, r].every((x) => x >= check.min && x <= check.max) ? null : `${f} against ${r}: outside ${check.min} .. ${check.max}`;
    case 'standIn':
      if (!numbers) return `${show(f)} against ${show(r)}: not two numbers`;
      if (f === 0 || r === 0) return f === r ? null : `${f} against ${r}: zero on one side only`;
      return [f, r].every((x) => x > 0 && x <= check.max) ? null : `${f} against ${r}: outside 0 .. ${check.max}`;
    case 'among':
      return [f, r].every((x) => check.values.includes(x)) ? null : `${show(f)} against ${show(r)}: not among ${show(check.values)}`;
    case 'kind':
      return typeof f === typeof r && !isRecord(f) && !Array.isArray(f) ? null : `${show(f)} against ${show(r)}: not of one simple type`;
    case 'id': {
      if (typeof f !== 'string' || typeof r !== 'string') return `${show(f)} against ${show(r)}: not two ids`;
      const known = c.ids.get(f);
      const back = c.idsBack.get(r);
      if (known === undefined && back === undefined) {
        c.ids.set(f, r);
        c.idsBack.set(r, f);
        return null;
      }
      return known === r && back === f ? null : `${f} stands for ${known ?? 'nothing yet'} and ${r} is stood for by ${back ?? 'nothing yet'}: the ids do not correspond one to one`;
    }
    case 'partKey': {
      if (typeof f !== 'string' || typeof r !== 'string') return `${show(f)} against ${show(r)}: not two part keys`;
      const [a, b] = [placeOf(c.fake, f), placeOf(c.real, r)];
      return a !== null && a === b ? null : `${f} is the part ${a ?? 'of no part list'} and ${r} the part ${b ?? 'of no part list'}`;
    }
    case 'vector': {
      if (!isVec(f) || !isVec(r)) return `${show(f)} against ${show(r)}: not two vectors`;
      const [a, b] = [v3.len(f), v3.len(r)];
      const length = judge(c, check.length, a, b);
      if (length) return `the lengths: ${length}`;
      if (check.angleDeg === undefined || a === 0 || b === 0) return null;
      const angle = v3.angle(f, r) / DEG;
      return angle <= check.angleDeg ? null : `${angle.toFixed(3)} degrees apart: more than ${check.angleDeg}`;
    }
    case 'unit': {
      if (!isVec(f) || !isVec(r)) return `${show(f)} against ${show(r)}: not two vectors`;
      if (!isUnit(f) || !isUnit(r)) return `lengths ${v3.len(f)} and ${v3.len(r)}: not unit vectors`;
      if (check.angleDeg === undefined) return null;
      const angle = v3.angle(f, r) / DEG;
      return angle <= check.angleDeg ? null : `${angle.toFixed(3)} degrees apart: more than ${check.angleDeg}`;
    }
    case 'rotation': {
      if (!isQuat(f) || !isQuat(r)) return `${show(f)} against ${show(r)}: not two quaternions`;
      if (!isUnitQuat(f) || !isUnitQuat(r)) return 'not unit quaternions';
      if (check.angleDeg === undefined) return null;
      const angle = quat.angleBetween(f, r) / DEG;
      return angle <= check.angleDeg ? null : `${angle.toFixed(3)} degrees apart: more than ${check.angleDeg}`;
    }
    case 'shape': {
      const d = shapeDifferences(f, r);
      return d.length === 0 ? null : `not the same fields: ${d.slice(0, 3).join('; ')}`;
    }
    case 'apart':
      return null;
  }
}

/** Hold one value of the fake against the session's: by its row of the table, else equal, field by field and element by element. */
function hold(c: Comparison, f: unknown, r: unknown, at: string, where: string): void {
  const row = rowAt(at, c.scene);
  if (row) {
    if (row.check.is === 'apart' || !same(f, r)) c.needed.add(row);
    if (row.check.is === 'apart') return;
    if (absent(f) || absent(r)) {
      if (absent(f) !== absent(r) && !row.nullable) c.differences.push(`${where}: ${show(f)} against ${show(r)}: null on one side only`);
      return;
    }
    // Equal is always right: a row says what holds where the two are not (an id is still held to its correspondence).
    if (row.check.is !== 'id' && same(f, r)) return;
    const problem = judge(c, row.check, f, r);
    if (problem) c.differences.push(`${where}: ${problem}`);
    return;
  }
  if (same(f, r)) return;
  if (Array.isArray(f) && Array.isArray(r)) {
    if (f.length !== r.length) c.differences.push(`${where}: ${f.length} elements against ${r.length}`);
    for (let i = 0; i < Math.min(f.length, r.length); i++) hold(c, f[i], r[i], `${at}[]`, `${where}[${i}]`);
    return;
  }
  if (isRecord(f) && isRecord(r) && !isVec(f) && !isQuat(f)) {
    for (const key of new Set([...Object.keys(f), ...Object.keys(r)])) hold(c, f[key], r[key], at === '' ? key : `${at}.${key}`, where === '' ? key : `${where}.${key}`);
    return;
  }
  c.differences.push(`${where}: ${show(f)} against ${show(r)}`);
}

/** The body a patch is about, its span and its markers keep the contract of a patch (contracts/sim.ts, `Patch`). */
function patchProblems(s: SimSnapshot, label: string): string[] {
  const out: string[] = [];
  for (const [i, p] of s.patches.current.entries()) {
    if (!s.bodies.some((b) => b.id === p.bodyId)) out.push(`${label} patch ${i}: about no body of the snapshot`);
    if (!(p.tEnd > p.tStart)) out.push(`${label} patch ${i}: ends before it starts`);
    if (i === 0 && Math.abs(p.tStart - s.ut) > 1) out.push(`${label} patch 0: does not start now`);
    if (p.endReason === 'closed' && Math.abs(p.nuEnd - p.nuStart - 2 * Math.PI) > 1e-9) out.push(`${label} patch ${i}: a closed patch is one revolution`);
    for (const m of p.markers) if (m.ut < p.tStart - 1e-6 || m.ut > p.tEnd + 1e-6) out.push(`${label} patch ${i}: the marker ${m.kind} lies outside the patch`);
  }
  return out;
}

/** The fake's snapshot held against the session's in the same situation: every difference the table does not allow. */
function compare(scene: FakeScene, fake: SimSnapshot, real: SimSnapshot, needed: Set<Row> = new Set()): string[] {
  const c: Comparison = { scene, fake, real, ids: new Map(), idsBack: new Map(), differences: [], needed };
  hold(c, fake, real, '', '');

  // Vessel by vessel: the active one against the active one; any other must have its like on the other side.
  const [fv, rv] = [activeVesselOf(fake), activeVesselOf(real)];
  if (!fv || !rv) c.differences.push('vessels: no active vessel');
  else hold(c, fv, rv, 'vessels[]', 'vessels[active]');
  if (fake.vessels.length > 1) c.differences.push(`vessels: the fake has ${fake.vessels.length - 1} vessel(s) the session has not`);
  if (real.vessels.length > 1) {
    const row = rowAt('vessels(session only)', scene);
    if (row) needed.add(row);
    else c.differences.push(`vessels: the session has ${real.vessels.length - 1} vessel(s) the fake has not: ${real.vessels.filter((v) => v !== rv).map((v) => v.id).join(', ')}`);
  }

  // The target, as the access module reads it from either producer: the selection, the inclination, the approaches.
  const view = (s: SimSnapshot): unknown => {
    const t = targetOf(s.readouts);
    return t === null ? null : { ref: t.ref, relativeInclination: t.relativeInclination, closestApproaches: t.closestApproaches };
  };
  hold(c, view(fake), view(real), 'targetOf(readouts)', 'targetOf(readouts)');
  if ((targetOf(fake.readouts)?.closestApproaches.length ?? 0) !== 0) c.differences.push('targetOf(readouts).closestApproaches: the fake lists an approach to a body');

  // The trajectory: the fake's circle about the session's body in an orbit, nothing on the ground or under a canopy.
  const orbit = fv !== null && fv.situation === 'orbiting';
  const entry = scene === 'reentry';
  c.differences.push(...patchProblems(fake, 'fake'), ...patchProblems(real, 'session'));
  if (fake.patches.current.length !== (orbit || entry ? 1 : 0)) c.differences.push(`patches.current: the fake draws ${fake.patches.current.length} patch(es) in the situation '${fv?.situation}'`);
  const [fp, rp] = [fake.patches.current[0], real.patches.current[0]];
  if (fp) {
    if (fp.endReason !== 'closed' || fp.markers.map((m) => m.kind).join() !== 'periapsis,apoapsis') c.differences.push('patches.current[0]: the fake\'s patch is not its closed circle with its two apsides');
    if (!rp) c.differences.push('patches.current: the fake draws a patch where the session has none');
    else {
      if (fp.bodyId !== rp.bodyId) c.differences.push(`patches.current[0].bodyId: ${fp.bodyId} against ${rp.bodyId}`);
      const { markers: _fm, nextBodyId: _fn, ...fakePatch } = fp;
      const { markers: _rm, nextBodyId: _rn, ...realPatch } = rp;
      c.differences.push(...shapeDifferences(fakePatch, realPatch, 'patches.current[0]'));
    }
  }

  // The sun's direction from every body but the star itself.
  for (const [i, b] of fake.bodies.entries()) {
    const twin = real.bodies[i];
    if (!twin || b.id === fake.starId) continue;
    const angle = v3.angle(b.sunDir, twin.sunDir) / DEG;
    if (angle > 0.2) c.differences.push(`bodies[${i}].sunDir: ${angle.toFixed(3)} degrees from the session's`);
  }
  return c.differences;
}

describe('conformance: the fake session against createSession in the same situation', () => {
  for (const scene of FAKE_SCENES) {
    it(`${scene} (${SCENARIO_OF[scene]}): every field of every vessel equal, or within its row of the table`, async () => {
      const { fake, real, session, scenario, options } = await situationOf(scene);
      expectContract(fake, `fake ${scene}`);
      expectContract(real, `real ${scenario.id}`);
      expect(compare(scene, fake, real)).toEqual([]);

      // What holds of both, each from its own snapshot: the stack, the whole and its parts, the parachute light.
      for (const [s, label] of [
        [fake, `fake ${scene}`],
        [real, `real ${scenario.id}`],
      ] as const) {
        expectStack(s, label);
        // Under thrust a session's mass lags its tanks by a step (the table: mass in the ascent).
        expectWhole(s, label, scene === 'ascent' && s === real ? 1e-4 : 1e-9);
        expect(s.readouts.chuteEnvelope, `${label}: the light is the contract's judgement of the flight condition`).toBe(chuteLightOf(s));
      }
      expectNamedParts(fake, session.portStates(), `fake ${scene}`);
      expectNamedParts(real, [], `real ${scenario.id}`);
      expectTargets(fake, options.target ?? null, `fake ${scene}`);
      expectStores(session, fake, `fake ${scene}`);

      // The same situation, stated outright: one vessel of one craft with the session's parts, mass and size, on
      // the session's body, about the session's origin, with the session's stages fired and its target selected.
      const fv = activeVesselOf(fake)!;
      const rv = activeVesselOf(real)!;
      expect(fake.vessels.length).toBe(1);
      expect(fv.crafts!.map((c) => c.id)).toEqual([fv.id]);
      expect(rv.crafts!.map((c) => c.id)).toEqual([rv.id]);
      expect(fv.parts.map((p) => [p.instanceId, p.def, p.stageGroup, p.stageLabel])).toEqual(rv.parts.map((p) => [p.instanceId, p.def, p.stageGroup, p.stageLabel]));
      expect(fake.frame).toEqual(real.frame);
      expect(fv.bodyId).toBe(rv.bodyId);
      expect(fake.staging.nextStage).toBe(real.staging.nextStage);
      expect(fake.staging.stages.length).toBe(real.staging.stages.length);
      expect(fake.staging.stages.map((x) => x.fired)).toEqual(real.staging.stages.map((x) => x.fired));
      if (scene !== 'ascent') expect(fake.staging.nextStage).toBe(scenario.stagesAlreadyFired);
      expect(fv.boundingRadius).toBeCloseTo(rv.boundingRadius, 9);
      expect(Math.abs(fv.mass - rv.mass) / rv.mass).toBeLessThan(scene === 'ascent' ? 1e-4 : 1e-12);
      expect(targetOf(fake.readouts)!.ref).toEqual({ kind: 'body', id: scenario.target });
      expect(targetOf(real.readouts)!.ref).toEqual({ kind: 'body', id: scenario.target });
      if (scene === 'ascent') {
        // The session did climb: the comparison is of two vessels in the air under thrust, not of two on the pad.
        expect(real.readouts.altitudeAsl).toBeGreaterThan(2000);
        expect(rv.situation).toBe('flying');
        expect(fv.thrust).toBeGreaterThan(3e7);
      }
    });
  }

  it('the table holds no tolerance that nothing needs: every row is used by a scene in which the field does differ', async () => {
    const needed = new Set<Row>();
    for (const scene of FAKE_SCENES) {
      const { fake, real } = await situationOf(scene);
      compare(scene, fake, real, needed);
    }
    expect(TOLERANCES.filter((row) => !needed.has(row)).map((row) => `${row.at.join(', ')}${row.scenes ? ` (${row.scenes.join(', ')})` : ''}`)).toEqual([]);
    // And every row says why.
    for (const row of TOLERANCES) expect(row.why.length, row.at.join(', ')).toBeGreaterThan(20);
  });
});

/**
 * The comparison is not vacuous: a value of the fake that is wrong on purpose is found, each by the field
 * it is in. These are the differences an earlier version of this test let pass (it compared the presence of
 * keys and the types of first elements): a stack of four stages with none fired against ten with four to
 * nine fired, 50 t against the vehicle's mass, a 55 m radius against 4 to 21 m, no target against the Moon,
 * a parachute light that is not the judgement of the flight condition.
 */
describe('conformance: the comparison finds a wrong value', () => {
  /** The fake's snapshot of a scene with one thing changed, and what the comparison then says. */
  async function wrong(scene: FakeScene, change: (s: SimSnapshot) => void): Promise<string[]> {
    const { fake, real } = await situationOf(scene);
    const copy = structuredClone(fake);
    change(copy);
    return compare(scene, copy, real);
  }
  const vesselOf = (s: SimSnapshot): VesselSnapshot => activeVesselOf(s)!;

  it('unchanged, the fake of the low orbit conforms (the control)', async () => {
    expect(await wrong('lowOrbit', () => undefined)).toEqual([]);
  });

  const cases: [string, FakeScene, (s: SimSnapshot) => void, RegExp][] = [
    ['the mass times ten', 'lowOrbit', (s) => (vesselOf(s).mass *= 10), /^vessels\[active\]\.mass: /],
    ['the mass of the read-outs at 50 t', 'lowOrbit', (s) => (s.readouts.mass = 50000), /^readouts\.mass: 50000 against 154093/],
    ['a bounding radius of 55 m', 'lowOrbit', (s) => (vesselOf(s).boundingRadius = 55), /^vessels\[active\]\.boundingRadius: 55 against 21\.4/],
    ['the centre of mass at the origin', 'lowOrbit', (s) => (vesselOf(s).comLocal = v3.zero()), /^vessels\[active\]\.comLocal: /],
    ['a stage list of four', 'lowOrbit', (s) => (s.staging.stages.length = 4), /^staging\.stages: 4 elements against 10$/],
    ['a craft block with a stage list of four', 'lowOrbit', (s) => (vesselOf(s).crafts![0]!.staging.stages.length = 4), /^vessels\[active\]\.crafts\[0\]\.staging\.stages: 4 elements against 10$/],
    ['no stage fired', 'lowOrbit', (s) => (s.staging.nextStage = 0), /^staging\.nextStage: 0 against 4$/],
    ['a fired stage not marked fired', 'lowOrbit', (s) => (s.staging.stages[2]!.fired = false), /^staging\.stages\[2\]\.fired: false against true$/],
    ['a label of the generic stack', 'lowOrbit', (s) => (s.staging.stages[1]!.label = 'Stage separation'), /^staging\.stages\[1\]\.label: /],
    ['a burn figure for a stage that burns nothing', 'lowOrbit', (s) => (s.staging.stages[5]!.deltaVVac = 3000), /^staging\.stages\[5\]\.deltaVVac: 3000 against 0: zero on one side only$/],
    ['no burn figure for the stage that burns', 'lowOrbit', (s) => (s.staging.stages[3]!.burnTime = 0), /^staging\.stages\[3\]\.burnTime: 0 against 376\.\d+: zero on one side only$/],
    ['no scenario stages fired', 'lowOrbit', (s) => (s.scenario.stagesAlreadyFired = 0), /^scenario\.stagesAlreadyFired: 0 against 4$/],
    ['no target', 'lowOrbit', (s) => Object.assign(s.readouts, { target: null }), /^targetOf\(readouts\): null against /],
    ['another body targeted', 'lowOrbit', (s) => (s.readouts.target!.ref = { kind: 'body', id: 'sun' }), /^targetOf\(readouts\)\.ref\.id: "sun" against "moon"$/],
    ['a parachute light on the pad that is not the session\'s', 'pad', (s) => (s.readouts.chuteEnvelope = null), /^readouts\.chuteEnvelope: null against "safe"$/],
    ['a parachute light in orbit', 'lowOrbit', (s) => (s.readouts.chuteEnvelope = 'safe'), /^readouts\.chuteEnvelope: "safe" against null$/],
    ['a part missing', 'lowOrbit', (s) => void vesselOf(s).parts.pop(), /^vessels\[active\]\.parts: 13 elements against 14$/],
    ['a part of the list in another place', 'lowOrbit', (s) => (vesselOf(s).parts[3]!.localPos.y += 0.01), /^vessels\[active\]\.parts\[3\]\.localPos: /],
    ['a tank with other contents', 'lowOrbit', (s) => { const tank = vesselOf(s).parts.find((p) => Object.keys(p.resources).length > 0)!; tank.resources[Object.keys(tank.resources)[0]!]! *= 0.5; }, /^vessels\[active\]\.parts\[\d+\]\.resources\.\w+: /],
    ['an engine no longer armed', 'lowOrbit', (s) => { for (const p of vesselOf(s).parts) for (const m of p.modules) if (m.type === 'engine' && m.active) m.active = false; }, /^vessels\[active\]\.parts\[\d+\]\.modules\[\d+\]\.active: false against true$/],
    ['a control part that is another part', 'lowOrbit', (s) => (vesselOf(s).helm!.controlPart = partKeyOf(vesselOf(s), vesselOf(s).parts[1]!)), /^vessels\[active\]\.helm\.controlPart: .* is the part active:1 and .* the part active:0$/],
    ['a control part that is no part', 'lowOrbit', (s) => (vesselOf(s).helm!.controlPart = `${FAKE_VESSEL_ID}/port`), /is the part of no part list/],
    ['a part of another craft than the vessel\'s', 'lowOrbit', (s) => (vesselOf(s).parts[0]!.craftId = 'someone-else'), /the ids do not correspond one to one/],
    ['ten times the altitude', 'lowOrbit', (s) => (s.readouts.altitudeAsl *= 10), /^readouts\.altitudeAsl: 2000000 against 201771\.\d+: not within a factor of 1\.1$/],
    ['the vessel at ten times the distance', 'lowOrbit', (s) => (vesselOf(s).r = v3.scale(vesselOf(s).r, 10)), /^vessels\[active\]\.r: the lengths: /],
    ['an attitude that is no rotation', 'lowOrbit', (s) => (vesselOf(s).q.w += 0.5), /^vessels\[active\]\.q: not unit quaternions$/],
    ['a navball marker that is no direction', 'lowOrbit', (s) => (s.navball.markers.prograde = v3.scale(s.navball.markers.prograde, 2)), /^navball\.markers\.prograde: lengths \S+ and \S+: not unit vectors$/],
    ['a latitude in degrees', 'lowOrbit', (s) => (s.readouts.latitude /= DEG), /^readouts\.latitude: .* outside -1\.57\d* \.\. 1\.57\d*$/],
    ['the pad a kilometre off', 'pad', (s) => (s.readouts.longitude += 1000 / 6371000), /^readouts\.longitude: /],
    ['weight on the ground of 50 t', 'pad', (s) => (vesselOf(s).contact.maxForce = 50000 * 9.82), /^vessels\[active\]\.contact\.maxForce: /],
    ['the Moon twice as far', 'lowOrbit', (s) => { const moon = s.bodies.find((b) => b.id === 'moon')!; moon.rRoot = v3.scale(moon.rRoot, 2); }, /^bodies\[1\]\.rRoot: the lengths: /],
    ['another origin of ROOT', 'lunarOrbit', (s) => (s.frame!.origin = { kind: 'body', bodyId: 'earth' }), /^frame\.origin\.bodyId: "earth" against "moon"$/],
    ['a second vessel', 'lowOrbit', (s) => void s.vessels.push(structuredClone(s.vessels[0]!)), /^vessels: the fake has 1 vessel\(s\) the session has not$/],
    ['a patch on the pad', 'pad', (s) => void s.patches.current.push({ bodyId: 'earth', conic: s.bodies[1]!.orbit!, tStart: s.ut, tEnd: s.ut + 100, nuStart: 0, nuEnd: 1, endReason: 'horizon', bodyPosAtEnd: v3.zero(), markers: [] }), /^patches\.current: the fake draws 1 patch\(es\) in the situation 'prelaunch'$/],
    ['a field left out', 'lowOrbit', (s) => { delete (s.readouts as Partial<SimSnapshot['readouts']>).rcsFraction; }, /^readouts\.rcsFraction: absent against 0\.99\d+$/],
    ['a field of the wrong type', 'lowOrbit', (s) => Object.assign(s.readouts, { legsDeployed: 0 }), /^readouts\.legsDeployed: 0 against false$/],
  ];
  for (const [what, scene, change, found] of cases) {
    it(`${what} (${scene})`, async () => {
      const differences = await wrong(scene, change);
      expect(differences.length, `nothing found for: ${what}`).toBeGreaterThan(0);
      expect(differences.some((d) => found.test(d)), `${what}: found ${JSON.stringify(differences.slice(0, 4))}`).toBe(true);
    });
  }

  it("v1's stand-in figures do not conform: the comparison names each of them (what createFakeSim keeps, and why it is not held to a session)", async () => {
    const { options, real } = await situationOf('lowOrbit');
    const standIn = createFakeSession(defs, { ...options, figures: 'standIn' }).snapshot();
    const fields = new Set(compare('lowOrbit', standIn, real).map((d) => d.slice(0, d.indexOf(':')).replace(/\[\d+\]/g, '[]')));
    expect([...fields].sort()).toEqual(
      [
        // The mass, its centre and the size of the vessel: 50 t at the origin in 55 m.
        'vessels[active].mass',
        'readouts.mass',
        'vessels[active].comLocal',
        'vessels[active].boundingRadius',
        // What the read-outs take from the parts: the constants.
        'readouts.ablatorFraction',
        'readouts.maxTempFraction',
        'readouts.rcsFraction',
        // The stack: the generic four (their labels, their icons, a burn figure for every one of them), in the
        // panel and in the craft block.
        ...['staging', 'vessels[active].crafts[].staging'].flatMap((stack) => [`${stack}.stages`, ...['label', 'icon', 'deltaVVac', 'deltaVNow', 'twr', 'burnTime', 'propellantFraction'].map((field) => `${stack}.stages[].${field}`)]),
        // The launch site named without its pad.
        'surfaceTargets[].name',
      ].sort(),
    );
    // The same options and nothing else changed: the two constructors differ in the figures (and the render root) only.
    const sim = createFakeSim(defs, { ...options, renderRoot: 'focusBody' }).snapshot();
    expect(sim).toEqual(standIn);
    const v = activeVesselOf(sim)!;
    expect([v.mass, v.boundingRadius, v.comLocal, sim.staging.stages.length, sim.readouts.deltaVTotal, sim.readouts.rcsFraction]).toEqual([50000, 55, v3.zero(), 4, 3000, 0.9]);
  });

  it('createFakeSim against createFakeSession with the same options: the fields that differ in the eight scenes are the figures, and only they', async () => {
    /** The fields (every element of a list as one) in which two snapshots are not equal. */
    function differing(a: unknown, b: unknown, at: string, out: Set<string>): void {
      if (same(a, b)) return;
      if (Array.isArray(a) && Array.isArray(b)) {
        if (a.length !== b.length) out.add(`${at}.length`);
        for (let i = 0; i < Math.min(a.length, b.length); i++) differing(a[i], b[i], `${at}[]`, out);
      } else if (isRecord(a) && isRecord(b) && !isVec(a) && !isQuat(a)) for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) differing(a[key], b[key], at === '' ? key : `${at}.${key}`, out);
      else out.add(at);
    }
    // The v1 name as a lab calls it (labs/integration: the parts, the vehicle, its stage labels; no stage is
    // stated as fired) against the session-like fake of the same situation, both about the same origin.
    const stageLabels = defs.vehicles[VEHICLE]!.stages.map((x) => x.label);
    const fields = new Set<string>();
    for (const scene of FAKE_SCENES) {
      const { options } = await situationOf(scene);
      const { stagesAlreadyFired: _fired, ...lab } = options;
      differing(createFakeSim(defs, { ...lab, stageLabels, renderRoot: 'focusBody' }).snapshot(), createFakeSession(defs, options).snapshot(), '', fields);
    }
    const stackFields = ['fired', 'icon', 'deltaVVac', 'deltaVNow', 'twr', 'burnTime', 'propellantFraction'];
    expect([...fields].sort()).toEqual(
      [
        // From the parts: the mass, its centre, the size; and what is computed with the mass (standing: the weight
        // on the ground and the ground's reaction; under thrust, which no scene has at its start, also the
        // thrust-to-weight ratio and the g load).
        'vessels[].mass',
        'readouts.mass',
        'vessels[].comLocal',
        'vessels[].boundingRadius',
        'vessels[].contact.maxForce',
        'vessels[].properAccel',
        // From the parts, in the read-outs.
        'readouts.ablatorFraction',
        'readouts.maxTempFraction',
        'readouts.rcsFraction',
        'readouts.legsDeployed',
        // From the vehicle: the stack (in the panel and in the craft block) with the stages fired, the delta-v left,
        // the parachute light.
        ...['staging', 'vessels[].crafts[].staging'].flatMap((stack) => [`${stack}.nextStage`, ...stackFields.map((field) => `${stack}.stages[].${field}`)]),
        'scenario.stagesAlreadyFired',
        'readouts.deltaVTotal',
        'readouts.chuteEnvelope',
        // Standing: the orbit of the point on the turning ground. In flight at the Moon: the inclination to its equator.
        'readouts.apoapsisAltitude',
        'readouts.periapsisAltitude',
        'readouts.timeToApoapsis',
        'readouts.timeToPeriapsis',
        'readouts.eccentricity',
        'readouts.period',
        'readouts.inclination',
        // The target: the relative inclination to a body (in the read-out and its deprecated copy), the site by its pad.
        'readouts.target.relativeInclination',
        'readouts.targetRelativeInclination',
        'surfaceTargets[].name',
      ].sort(),
    );
  });
});

/**
 * What no session can be asked yet is held to the contract: the scenes of the shared universe, each at its
 * start and after it has run for a while, and the eight flight scenes without a session beside them.
 */
describe('the contract invariants of every scene: ids, the whole and its craft, the stores, the target', () => {
  const lander = (): PartSnapshot[] => vesselPartSnapshots(assembleVessel(defs, VEHICLE, { stagesAlreadyFired: 6 }));
  /** The target each scene of the shared universe starts with. */
  const selectedOf = (session: FakeSession): TargetRef | null => {
    switch (session.scene) {
      case 'rendezvous':
      case 'timeLive':
        return { kind: 'vessel', id: FAKE_TARGET_ID };
      case 'echoes':
        return { kind: 'vessel', id: FAKE_ECHO_RECORDED_ID };
      case 'dockingApproach':
        return session.peek().readouts.target!.ref;
      default:
        return null;
    }
  };
  function expectInvariants(session: FakeSession, s: SimSnapshot, selected: TargetRef | null, label: string): void {
    expectContract(s, label);
    expectNamedParts(s, session.portStates(), label);
    expectWhole(s, label);
    expectStack(s, label);
    expect(s.readouts.chuteEnvelope, `${label}: the parachute light`).toBe(chuteLightOf(s));
    expectTargets(s, selected, label);
    expectStores(session, s, label);
    // Every vessel of a scene is one of the scenario's craft: its ids are unique and its parts are its own.
    expect(new Set(s.vessels.map((v) => v.id)).size, `${label}: vessel ids`).toBe(s.vessels.length);
    const craftIds = s.vessels.flatMap((v) => v.crafts!.map((c) => c.id));
    expect(new Set(craftIds).size, `${label}: a craft is in one vessel`).toBe(craftIds.length);
    expect(s.vessels.some((v) => v.id === s.activeVesselId), label).toBe(true);
  }

  for (const scene of FAKE_V2_SCENES) {
    it(`${scene}: at its start, after a second of frames and after three minutes`, () => {
      const session = createFakeSession(defs, { scene, vehicleId: VEHICLE, parts: lander(), stagesAlreadyFired: 6 });
      const selected = selectedOf(session);
      if (scene === 'dockingApproach') expect(selected).toMatchObject({ kind: 'port', vesselId: FAKE_STATION_ID });
      expectInvariants(session, session.snapshot(), selected, `${scene} at the start`);
      for (let i = 0; i < 60; i++) session.advance(1 / 60);
      expectInvariants(session, session.snapshot(), selected, `${scene} after a second`);
      // Three minutes on, a snapshot every frame as the app takes them: the docking scene has docked, the queue has
      // moved up, the others have gone round a little. A frame that carries an event is held to all of it.
      let later = session.snapshot();
      for (let i = 0; i < 1800; i++) {
        session.advance(0.1);
        later = session.snapshot();
        if (later.events.length > 0) expectInvariants(session, later, selected, `${scene} at ${later.events.map((e) => e.type).join(' and ')}`);
      }
      expectInvariants(session, later, selected, `${scene} after three minutes`);
      if (scene === 'dockingApproach') expect(later.vessels.map((v) => v.crafts!.map((c) => c.id))).toEqual([[FAKE_STATION_ID, FAKE_VESSEL_ID]]);
      // A target taken away takes its read-outs with it; a body target has the read-outs of a body.
      expect(session.commands.setTarget(null).ok).toBe(true);
      expectTargets(session.snapshot(), null, `${scene} without a target`);
      expect(session.commands.setTarget({ kind: 'body', id: 'moon' }).ok).toBe(true);
      expectTargets(session.snapshot(), { kind: 'body', id: 'moon' }, `${scene} with a body target`);
    });
  }

  it('the eight flight scenes of the vehicle, each with the stages of its part of the flight fired', () => {
    const fired: Record<FakeScene, number> = { pad: 0, ascent: 1, lowOrbit: 4, translunar: 5, lunarOrbit: 5, lunarSurface: 6, reentry: 8, chutes: 9 };
    for (const scene of FAKE_SCENES) {
      const parts = vesselPartSnapshots(assembleVessel(defs, VEHICLE, { stagesAlreadyFired: fired[scene] }));
      const session = createFakeSession(defs, { scene, vehicleId: VEHICLE, parts, stagesAlreadyFired: fired[scene] });
      const s = session.snapshot();
      expectInvariants(session, s, null, scene);
      expect(s.staging.nextStage).toBe(fired[scene]);
      expect(s.scenario.stagesAlreadyFired).toBe(fired[scene]);
      // The next press fires the stage after those, and it is an event of that stage.
      const press = session.commands.stage();
      const after = session.snapshot();
      expect(press.ok).toBe(true);
      expect(after.staging.nextStage).toBe(fired[scene] + 1);
      expect(after.events).toEqual([{ type: 'stageFired', ut: after.ut, vesselId: FAKE_VESSEL_ID, stageIndex: fired[scene], label: s.staging.stages[fired[scene]]!.label }]);
      expectStack(after, `${scene} after a press`);
    }
    // More stages fired than the stack has is no situation.
    expect(() => createFakeSession(defs, { scene: 'lowOrbit', vehicleId: VEHICLE, stagesAlreadyFired: 11 })).toThrow(/stagesAlreadyFired is 11, and the stack has 10 stages/);
    expect(() => createFakeSession(defs, { scene: 'lowOrbit', stagesAlreadyFired: 5 })).toThrow(/the stack has 4 stages/);
    expect(() => createFakeSession(defs, { scene: 'lowOrbit', target: { kind: 'vessel', id: 'nobody' } })).toThrow(/cannot start with the target/);
  });

  it('the parachute light follows the flight condition: none in vacuum, and against the envelopes of the next canopy in the air', () => {
    const light = (scene: FakeScene, stagesAlreadyFired: number, altitude?: number): ChuteEnvelope | null => {
      const parts = vesselPartSnapshots(assembleVessel(defs, VEHICLE, { stagesAlreadyFired }));
      const s = createFakeSession(defs, { scene, vehicleId: VEHICLE, parts, stagesAlreadyFired, ...(altitude === undefined ? {} : { altitude }) }).snapshot();
      expect(s.readouts.chuteEnvelope).toBe(chuteLightOf(s));
      return s.readouts.chuteEnvelope;
    };
    // Standing in the air: inside the drogues' safe envelope. Climbing through 9 km at Mach 1.2: outside it.
    expect(light('pad', 0)).toBe('safe');
    expect(['risky', 'unsafe']).toContain(light('ascent', 1));
    // Above the air: no light, whatever is left to deploy.
    expect(light('lowOrbit', 4)).toBeNull();
    expect(light('lunarSurface', 6)).toBeNull();
    // Under the drogues at 8 m/s: the mains may come out. With the mains out too nothing is left to judge.
    expect(light('chutes', 9)).toBe('safe');
    expect(light('chutes', 10)).toBeNull();
  });
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

  it("the v1 name gives the same session with the v1 render root and v1's figures: createFakeSim is createFakeSession about the root body with the stand-in figures", () => {
    const parts = vesselPartSnapshots(assembleVessel(defs, VEHICLE, { stagesAlreadyFired: 6 }));
    for (const scene of FAKE_SCENES) {
      // Without a part list and with the parts and the vehicle a lab gives it.
      for (const given of [{}, { parts, vehicleId: VEHICLE }]) {
        const a = createFakeSim(defs, { scene, ...given });
        const b = createFakeSession(defs, { scene, ...given, renderRoot: 'rootBody', figures: 'standIn' });
        expect(a.peek().frame!.origin).toEqual({ kind: 'body', bodyId: defs.rootBodyId });
        // Asked for the session's root or the session's figures, the v1 name gives them.
        expect(createFakeSim(defs, { scene, ...given, renderRoot: 'focusBody' }).peek()).toEqual(createFakeSession(defs, { scene, ...given, figures: 'standIn' }).peek());
        expect(createFakeSim(defs, { scene, ...given, renderRoot: 'focusBody', figures: 'derived' }).peek()).toEqual(createFakeSession(defs, { scene, ...given }).peek());
        for (let i = 0; i < 5; i++) {
          a.advance(1 / 60);
          b.advance(1 / 60);
        }
        const [sa, sb] = [a.snapshot(), b.snapshot()];
        expect(sa).toEqual(sb);
        // What the renderer draws from, whatever the parts: v1's vessel of 50 t in a sphere of 55 m.
        expect([sa.vessels[0]!.mass, sa.vessels[0]!.boundingRadius, sa.vessels[0]!.comLocal, sa.readouts.mass, sa.staging.stages.length, sa.staging.nextStage]).toEqual([50000, 55, v3.zero(), 50000, 4, 0]);
      }
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
