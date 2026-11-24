/**
 * Pure builders of the presentation blocks from island state plus the view's planning state (ARCHITECTURE
 * 7.1 "View"): the `SimSnapshot` with presentation interpolation, the frame and its rebase, read-outs,
 * navball, staging figures per craft, patches in the render root, nodes, events. Never runs on a server.
 *
 * The numbers are v1's `World` snapshot code, moved here unchanged: `tests/unit/sim-world/viewReference`
 * compares every block at 200 recorded states.
 */
import type { ControlInputs } from '@/core/contracts/controls';
import { PHYSICS_DT } from '@/core/contracts/defs';
import type { TimeLimitKind, TimeView } from '@/core/contracts/net';
import type { FidelityTier, MilestoneRecord, Readouts, SimEvent, SimSnapshot, StageInfo, SurfaceTarget, VesselSituation, VesselSnapshot } from '@/core/contracts/sim';
import type { VesselEnvironment } from '@/core/contracts/simInternal';
import type { Quat } from '@/core/math/quat';
import { quat } from '@/core/math/quat';
import { v3, type Vec3 } from '@/core/math/vec3';
import { utOfTick } from '../clock';
import { comStateOf, type BodyFrames } from '../island/frames';
import { computeLandingTargetReadout, groundTrackDirection } from '../nav/landingTarget';
import { launchWindowReadout } from '../nav/launchWindow';
import { computeNavball } from '../nav/navball';
import { bodyTargetReadout, computeOrbitalReadouts } from '../nav/readouts';
import { makeOrbit, propagate, type Orbit } from '../orbit/kepler';
import { G_DOSE_LIMIT, helmCraft, nextLiveStage, shownRadarAltitude, stagingInfo, surfaceSituation, toVesselSnapshot, vesselReadouts, type Vessel } from '../vessel';
import type { RenderRoot } from './frame';
import { craftTargetReadout, craftTargetVectors } from './target';
import { PATCH_REFRESH_STEPS, type Planning, type PlanSubject } from './planning';

/** A vessel as the view reads it: an island member, or an object of the clock outside the island. */
export interface ViewVessel {
  vessel: Vessel;
  bodyId: string;
  /** 'full': a member of the island; 'rails' and 'reduced': outside it. */
  tier: FidelityTier;
  mode: VesselSnapshot['translationMode'];
  /** Orbit of the centre of mass while on a conic. */
  orbit: Orbit | null;
  revision: number;
  /** The vessel's step environment (the sun sample it flies with, the air of its body). */
  env: VesselEnvironment;
  /** Pose at the start of the last step (presentation interpolation); null = none. */
  previous: { r: Vec3; v: Vec3; q: Quat } | null;
  /** Tick the reduced-tier state refers to. */
  reducedTick: number;
}

const cloneControls = (c: ControlInputs): ControlInputs => ({ pitch: c.pitch, yaw: c.yaw, roll: c.roll, translate: { x: c.translate.x, y: c.translate.y, z: c.translate.z }, throttle: c.throttle });

/** The situation of a vessel that is not on a surface: flying, or the kind of its conic. */
export function situationOf(frames: BodyFrames, e: ViewVessel, ut: number): VesselSituation {
  const v = e.vessel;
  const s = surfaceSituation(v);
  if (s !== null) return s;
  const base = frames.base(e.bodyId);
  const com = comStateOf(v);
  const atm = base.def.atmosphere;
  if (atm && frames.altitudeAt(e.bodyId, com.r, ut) < atm.simTop) return 'flying';
  const o = e.orbit ?? makeOrbit(e.bodyId, base.info.mu, com.r, com.v, ut);
  const rp = o.conic.p / (1 + o.conic.e);
  if (o.period === null) return 'escaping';
  const ra = 2 / o.alpha - rp;
  if (base.info.soiRadius !== null && ra > base.info.soiRadius) return 'escaping';
  const floor = base.info.radius + (atm ? atm.simTop : base.def.terrain ? base.def.terrain.maxElevation : 0);
  return rp < floor ? 'suborbital' : 'orbiting';
}

/** Stage figures of craft that are not the focus vessel's helm craft, refreshed at the cadence of the staging panel. */
export class StageFigures {
  private readonly cache = new WeakMap<object, { step: number; parts: number; infos: StageInfo[]; acceleration: number[] }>();

  constructor(private readonly frames: BodyFrames) {}

  /**
   * Stage figures of one craft of a vessel for its craft block. The focus vessel's helm craft has the figures
   * of the staging panel; any other craft with a command part aboard has its own; a craft nobody can fire
   * (debris) lists none.
   */
  of(e: ViewVessel, craft: number, focus: ViewVessel | null, planning: Planning, subject: PlanSubject, env: () => VesselEnvironment): StageInfo[] {
    const v = e.vessel;
    if (e === focus && craft === v.helm.craft) return planning.stageInfos(subject).map((s) => ({ ...s, actionKinds: s.actionKinds.slice() }));
    if (!v.parts.some((p) => p.craft === craft && p.command !== null)) return [];
    const record = v.crafts[craft]!;
    const bucket = subject.stepCount - (subject.stepCount % PATCH_REFRESH_STEPS);
    let c = this.cache.get(record);
    if (!c || c.step !== bucket || c.parts !== v.parts.length) {
      const infos = stagingInfo(v, env(), craft);
      const g = this.frames.gravityAt(e.bodyId, v.r);
      c = { step: bucket, parts: v.parts.length, infos, acceleration: infos.map((s) => s.twr * g) };
      this.cache.set(record, c);
    }
    const g = this.frames.gravityAt(e.bodyId, v.r);
    const cached = c;
    return cached.infos.map((s, i) => ({ ...s, twr: cached.acceleration[i]! / g, actionKinds: s.actionKinds.slice() }));
  }
}

/** Place a vessel snapshot at the presentation time utP = simUt - lag (alpha = fraction of the last step). */
export function present(frames: BodyFrames, e: ViewVessel, snap: VesselSnapshot, tick: number, utP: number, lag: number, alpha: number, bodyRoot: Vec3, bodyVel: Vec3): void {
  const v = e.vessel;
  if (v.hold !== null && v.anchor) {
    // Landed vessels ride the body: evaluate exactly at the presentation time.
    const qf = frames.orientPresented(e.bodyId, tick, lag);
    const sp = frames.info(e.bodyId).spin;
    snap.r = quat.rotate(qf, v.anchor.rFixed);
    snap.v = v3.cross(sp, snap.r);
    snap.q = quat.normalize(quat.mul(qf, v.anchor.qFixed));
  } else if (e.orbit !== null) {
    // On rails: the conic at the presentation time. For a vessel that is kept current every step this is
    // taken back from the state at simUt over the (exactly known) lag along the conic's own acceleration
    // (error below 1e-8 m); `ut` itself resolves only 1.2e-7 s at this epoch, a millimetre at orbital speed.
    let s: { r: Vec3; v: Vec3 };
    if (e.tier === 'full') {
      const c = comStateOf(v);
      const rl = v3.len(c.r);
      const g = v3.scale(c.r, -frames.info(e.bodyId).mu / (rl * rl * rl));
      s = { r: v3.add(v3.addScaled(c.r, c.v, -lag), v3.scale(g, 0.5 * lag * lag)), v: v3.addScaled(c.v, g, -lag) };
    } else s = propagate(e.orbit, utP);
    if (e.tier === 'full' && e.previous) snap.q = quat.slerp(e.previous.q, v.q, alpha);
    const com = v.mp.com;
    snap.r = v3.sub(s.r, quat.rotate(snap.q, com));
    snap.v = v3.sub(s.v, quat.rotate(snap.q, v3.cross(v.w, com)));
  } else if (e.tier === 'full' && e.previous) {
    snap.r = v3.lerp(e.previous.r, v.r, alpha);
    snap.v = v3.lerp(e.previous.v, v.v, alpha);
    snap.q = quat.slerp(e.previous.q, v.q, alpha);
  } else if (e.tier === 'reduced') {
    snap.r = v3.addScaled(v.r, v.v, utP - utOfTick(e.reducedTick));
  } else return;
  snap.rRoot = v3.add(bodyRoot, snap.r);
  snap.vRoot = v3.add(bodyVel, snap.v);
}

/** What is left in view of a destroyed vessel: no parts, no craft, the state it had (ROOT fields about the system's root body). */
export function wreckSnapshot(frames: BodyFrames, e: ViewVessel, ut: number): VesselSnapshot {
  const v = e.vessel;
  const root = frames.system.stateRoot(e.bodyId, ut);
  return {
    id: v.id,
    name: v.name,
    vehicleId: v.crafts[0]!.vehicleId,
    crafts: [],
    links: [],
    helm: { accountId: null, callsign: null, craftId: v.crafts[v.helm.craft]?.craftId ?? '', controlPart: '' },
    presence: 'solid',
    timeOffset: 0,
    revision: e.revision,
    controllable: false,
    tier: 'full',
    situation: 'landed',
    translationMode: 'landed',
    bodyId: e.bodyId,
    r: v3.clone(v.r),
    v: v3.clone(v.v),
    rRoot: v3.add(root.r, v.r),
    vRoot: v3.add(root.v, v.v),
    q: quat.clone(v.q),
    w: v3.zero(),
    mass: 0,
    comLocal: v3.zero(),
    boundingRadius: 0,
    parts: [],
    aero: { q: 0, mach: 0, aoa: 0, airDensity: 0, pressure: 0, temperature: 0, airVelocity: v3.zero(), heatFlux: 0, plasmaIntensity: 0 },
    gLoad: 0,
    properAccel: v3.zero(),
    contact: { anyContact: false, maxForce: 0, waterSubmersion: 0 },
    sunVisibility: 1,
    thrust: 0,
    age: v.age,
  };
}

/** The read-outs of a session without a vessel. */
export const emptyReadouts = (target: Readouts['target']): Readouts => ({
  met: 0,
  altitudeAsl: 0,
  altitudeRadar: 0,
  latitude: 0,
  longitude: 0,
  speedOrbital: 0,
  speedSurface: 0,
  verticalSpeed: 0,
  horizontalSpeed: 0,
  apoapsisAltitude: 0,
  periapsisAltitude: 0,
  timeToApoapsis: null,
  timeToPeriapsis: null,
  inclination: 0,
  eccentricity: 0,
  period: null,
  throttle: 0,
  thrust: 0,
  twr: 0,
  mass: 0,
  gLoad: 0,
  gDose: 0,
  gDoseLimit: G_DOSE_LIMIT,
  dynamicPressure: 0,
  mach: 0,
  angleOfAttack: 0,
  heatFlux: 0,
  ablatorFraction: null,
  maxTempFraction: 0,
  sasEnabled: false,
  sasMode: 'stability',
  sasModesAvailable: [],
  rcsEnabled: false,
  fineControl: false,
  legsDeployed: null,
  lightsOn: false,
  chuteEnvelope: null,
  rcsFraction: null,
  deltaVTotal: 0,
  targetRelativeInclination: null,
  target,
  docking: null,
  launchWindow: null,
  nodeBurn: null,
  liftVectorUp: null,
  tiltFromVertical: 0,
  landingTarget: null,
});

/** The read-outs of the focus vessel. */
export function buildReadouts(frames: BodyFrames, a: ViewVessel, env: VesselEnvironment, planning: Planning, subject: PlanSubject, surfaceTargets: readonly SurfaceTarget[], liftoffUt: number | null): Readouts {
  const v = a.vessel;
  const ut = subject.ut;
  const system = frames.system;
  const base = frames.base(a.bodyId);
  // Orbital read-outs are those of the centre of mass (the point that follows the conic).
  const com = subject.com;
  const orbital = computeOrbitalReadouts({ system, bodyId: a.bodyId, r: com.r, v: com.v, ut, targetBodyId: planning.targetBodyId, patches: planning.patches });
  const vr = vesselReadouts(v, env, planning.stageInfos(subject));
  const dirFixed = quat.rotateInv(env.qFixedToInertial, v3.normalize(v.r));
  let launchWindow: Readouts['launchWindow'] = null;
  if (v.hold !== null && a.bodyId === system.rootId && planning.targetBodyId !== null && frames.info(planning.targetBodyId).parentId === a.bodyId) {
    launchWindow = launchWindowReadout({
      system,
      bodyId: a.bodyId,
      latitude: orbital.latitude,
      longitude: orbital.longitude,
      elevation: v3.len(v.r) - base.info.radius,
      ut,
      targetBodyId: planning.targetBodyId,
    });
  }
  const track = groundTrackDirection(system, a.bodyId, v.r, v.v, ut);
  return {
    met: liftoffUt === null ? 0 : Math.max(0, ut - liftoffUt),
    ...orbital,
    // On a body with a shape the altitude is above its spheroid (Jupiter's 1-bar level is 1,580 km above its mean sphere at the equator).
    ...(base.def.shape ? { altitudeAsl: frames.altitudeAt(a.bodyId, com.r, ut) } : {}),
    docking: null,
    altitudeRadar: shownRadarAltitude(v, env),
    ...vr,
    sasModesAvailable: planning.sasModesAvailable(),
    launchWindow,
    nodeBurn: planning.nodeBurnReadout(subject),
    landingTarget: computeLandingTargetReadout(surfaceTargets, a.bodyId, dirFixed, track, base.info.radius, planning.patches.current),
  };
}

/** The time block of a pilot alone on a private clock nobody else is on: the pilot's tick is the live tick. */
export function privateClockView(tick: number, rate: number, maxRate: number, limit: { kind: TimeLimitKind; text: string } | null): TimeView {
  return {
    myTick: tick,
    liveTick: tick,
    rate,
    maxRate,
    limitedBy: limit === null ? null : { kind: limit.kind, text: limit.text, vesselIds: [], accountIds: [] },
    relation: 'live',
    offset: 0,
    clockId: null,
    clockKind: 'private',
    members: [],
    proposals: [],
    offers: [],
  };
}

/** Everything a snapshot is built from. */
export interface SnapshotSource {
  frames: BodyFrames;
  planning: Planning;
  root: RenderRoot;
  figures: StageFigures;
  /** The clock's tick, the presentation lag behind it (s, in [0, PHYSICS_DT); 0 for the state itself) and the revision counter. */
  tick: number;
  lag: number;
  revision: number;
  /** The vessels in the order the snapshot lists them, already brought to the tick. */
  vessels: readonly ViewVessel[];
  /** The focus vessel (the pilot's). When it is gone `focusPresent` is false and this is what it last was. */
  focus: ViewVessel;
  focusPresent: boolean;
  /** Kept in view of a focus vessel that was destroyed with nothing left to take over. */
  wreck: VesselSnapshot | null;
  subject: PlanSubject;
  /** The step environment of a vessel at the tick. */
  envOf(e: ViewVessel): VesselEnvironment;
  /** The targeted vessel among `vessels` (a vessel or port target of the planner); null or absent = none. */
  target?: ViewVessel | null;
  /** Full part snapshots only for vessels inside the relevance cut; absent = every vessel. */
  relevant?: (e: ViewVessel) => boolean;
  time: TimeView;
  warp: SimSnapshot['warp'];
  scenario: SimSnapshot['scenario'];
  surfaceTargets: readonly SurfaceTarget[];
  terrain: { finalAt(bodyId: string, dirFixed: Vec3): boolean; pending: boolean; incompleteQueries: number };
  events: SimEvent[];
  milestones: readonly MilestoneRecord[];
  mission: SimSnapshot['mission'];
  cheatCounter: number;
  liftoffUt: number | null;
}

export function buildSnapshot(s: SnapshotSource): SimSnapshot {
  const { frames, planning, root } = s;
  const system = frames.system;
  const lag = s.lag;
  const simUt = utOfTick(s.tick);
  const utP = simUt - lag;
  const alpha = 1 - lag / PHYSICS_DT;
  const bodies = system.buildBodySnapshots(utP);
  const bodyIndex = new Map<string, number>();
  // The render root: every ROOT position and velocity below is relative to the centre of the root's body.
  const origin = root.shifted ? bodies.find((b) => b.id === root.bodyId)! : null;
  const originR = origin ? v3.clone(origin.rRoot) : null;
  const originV = origin ? v3.clone(origin.vRoot) : null;
  bodies.forEach((b, i) => {
    bodyIndex.set(b.id, i);
    // Orientation on the clock (base + offset): the same rotation the physics and landed vessels use.
    b.qFixedToRoot = frames.orientPresented(b.id, s.tick, lag);
    if (originR && originV) {
      b.rRoot = v3.sub(b.rRoot, originR);
      b.vRoot = v3.sub(b.vRoot, originV);
    }
  });
  const a = s.focus;
  const vessels: VesselSnapshot[] = [];
  for (const e of s.vessels) {
    const v = e.vessel;
    const b = bodies[bodyIndex.get(e.bodyId)!]!;
    const snap = toVesselSnapshot(v, {
      bodyId: e.bodyId,
      tier: e.tier,
      situation: situationOf(frames, e, simUt),
      translationMode: e.mode,
      rRoot: v3.add(b.rRoot, v.r),
      vRoot: v3.add(b.vRoot, v.v),
      sunVisibility: e.env.sunVisibility,
      gravity: frames.gravityAt(e.bodyId, v.r),
      stages: (craft: number) => s.figures.of(e, craft, s.focusPresent ? a : null, planning, s.subject, () => s.envOf(e)),
      revision: e.revision,
      // The air at the vessel now (the rule of `Readouts.chuteEnvelope`): without it no chute envelope is stated.
      inAir: e.env.atmosphereAt(v3.len(v.r) - e.env.radius).density > 0,
      poseOnly: s.relevant ? !s.relevant(e) : false,
    });
    if (lag > 0) {
      present(frames, e, snap, s.tick, utP, lag, alpha, b.rRoot, b.vRoot);
      snap.age = Math.max(0, snap.age - lag);
    }
    vessels.push(snap);
  }
  if (s.wreck && !s.focusPresent) {
    // The wreck's ROOT state is kept with the system's root body as origin: express it in this frame.
    vessels.push(originR && originV ? { ...s.wreck, rRoot: v3.sub(s.wreck.rRoot, originR), vRoot: v3.sub(s.wreck.vRoot, originV) } : s.wreck);
  }
  const env = s.envOf(a);
  let readouts: Readouts;
  let navball;
  let stages: StageInfo[] = [];
  let nextStage = 0;
  let lockout = false;
  let complete = true;
  if (!s.focusPresent) {
    readouts = emptyReadouts(planning.targetBodyId === null ? null : bodyTargetReadout(system, a.bodyId, a.vessel.r, a.vessel.v, simUt, planning.targetBodyId, null, null));
    navball = computeNavball({ mode: planning.navballMode, q: a.vessel.q, r: a.vessel.r, v: a.vessel.v, qFixedToInertial: env.qFixedToInertial, spin: env.spin });
  } else {
    const v = a.vessel;
    readouts = buildReadouts(frames, a, env, planning, s.subject, s.surfaceTargets, s.liftoffUt);
    const dv = planning.remainingDv();
    let targetDir: Vec3 | null = null;
    let relativeVelocity: Vec3 | null = null;
    const craft = planning.targetCraft;
    if (planning.targetBodyId !== null) {
      const tb = bodies[bodyIndex.get(planning.targetBodyId)!]!;
      const ab = bodies[bodyIndex.get(a.bodyId)!]!;
      targetDir = v3.sub(tb.rRoot, v3.add(ab.rRoot, v.r));
    } else if (craft && s.target) {
      // A vessel or a port: the read-out, the direction to it and the velocity relative to it (the relative markers; prograde in the target mode).
      readouts.target = craftTargetReadout(system, a, s.target, craft, planning.approaches, simUt);
      ({ targetDir, relativeVelocity } = craftTargetVectors(system, a, s.target, craft, simUt));
    }
    navball = computeNavball({ mode: planning.navballMode, q: v.q, r: v.r, v: v.v, qFixedToInertial: env.qFixedToInertial, spin: env.spin, maneuverDv: dv, targetDir, relativeVelocity, liftVectorVes: v.aero.liftDirVes });
    stages = planning.stageInfos(s.subject).map((x) => ({ ...x, actionKinds: x.actionKinds.slice() }));
    nextStage = nextLiveStage(v);
    lockout = helmCraft(v).stageLockout > 0;
    if (frames.base(a.bodyId).hasTerrain) complete = s.terrain.finalAt(a.bodyId, quat.rotateInv(env.qFixedToInertial, v3.normalize(v.r)));
  }
  return {
    ut: utP,
    simUt,
    revision: s.revision,
    frame: root.describe(utP),
    time: s.time,
    warp: s.warp,
    scenario: s.scenario,
    surfaceTargets: s.surfaceTargets.map((t) => ({ ...t })),
    terrain: { complete, pending: s.terrain.pending, incompleteQueries: s.terrain.incompleteQueries },
    bodies,
    starId: system.starId,
    vessels,
    activeVesselId: a.vessel.id,
    appliedControls: cloneControls(a.vessel.appliedControls),
    navball,
    readouts,
    staging: { nextStage, stages, lockout },
    patches: root.patchesInFrame(planning.patches),
    nodes: planning.sortedNodes().map((n) => ({ id: n.id, ut: n.ut, dv: { ...n.dv } })),
    events: s.events,
    milestones: s.milestones.slice(),
    mission: s.mission,
    cheatCounter: s.cheatCounter,
  };
}
