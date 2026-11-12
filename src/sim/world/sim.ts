/**
 * The world orchestrator: the `Sim` implementation (src/core/contracts/sim.ts; ARCHITECTURE sections 5-7,
 * docs/research/sim-design.md sections 4, 5, 14).
 *
 * Owns the vessel list and the active vessel, the per-vessel landed / rails / integrated state machine,
 * fidelity tiers, SOI transitions, warp rules with event look-ahead, maneuver nodes and burn bookkeeping,
 * the patch refresh policy, the deterministic terrain request policy, the generic milestone evaluator,
 * snapshots with presentation interpolation, PlayerCommands, the cheat counter and the state hash.
 *
 * Conventions: every vessel's `r`, `v` are those of its VES origin in BCI of `Entry.bodyId`; rails orbits
 * are orbits of the CENTRE OF MASS (the origin is re-derived from the attitude), so a vessel rotating
 * about its centre of mass stays exactly on its conic. The same point-mass gravity is used on rails and
 * when integrating, so both hand-overs are exact.
 */
import { NEUTRAL_CONTROLS, SAS_MODES, type CommandResult, type ControlInputs, type NavballMode, type NodeEdit, type PlayerCommands, type SasMode } from '@/core/contracts/controls';
import { MAX_PHYSICS_WARP_INDEX, PHYSICS_DT, WARP_LEVELS, type DefLibrary, type ScenarioDef } from '@/core/contracts/defs';
import {
  CONTROL_TICK_STEPS,
  type FidelityTier,
  type ManeuverNode,
  type MilestoneRecord,
  type NodeBurnInfo,
  type Patch,
  type Readouts,
  type Sim,
  type SimDebug,
  type SimEvent,
  type SimSnapshot,
  type StageInfo,
  type SurfaceTarget,
  type VesselSituation,
  type VesselSnapshot,
} from '@/core/contracts/sim';
import type { TerrainProvider } from '@/core/contracts/terrain';
import { padLocationOf, padOf } from '@/core/defs/sites';
import { FRAME_HISTORY_EPOCHS, type FrameEpochOrigin, type FrameRebase } from '@/core/math/frame';
import { quat, type Quat } from '@/core/math/quat';
import { DEG, G0, RAD } from '@/core/math/scalar';
import { v3, type Vec3 } from '@/core/math/vec3';
import { ceilTick, nearestTick, TICK_EPSILON, TICKS_PER_SECOND, tickOfInstant, utOfTick } from '../clock';
import type { BodyInfo, BodySystem } from '../bodies/bodySystem';
import { createBodySystem } from '../bodies/bodySystem';
import { dirFromLatLon, enuBasis } from '../frames/bodyFrames';
import { resolvePadElevation } from '../frames/padState';
import { computeLandingTargetReadout, greatCircle, groundTrackDirection, targetDirection } from '../nav/landingTarget';
import { launchWindowReadout } from '../nav/launchWindow';
import { computeNavball, defaultNavballMode, flightDirections, navballModeAfter } from '../nav/navball';
import { computeOrbitalReadouts } from '../nav/readouts';
import { buildSurfaceTargets } from '../nav/surfaceTargets';
import { nextRadiusCrossing } from '../orbit/events';
import { makeOrbit, propagate, type Orbit } from '../orbit/kepler';
import { nodeBurnInfo, nodeDeltaVInertial, type BurnEngine } from '../orbit/maneuver';
import { predictPatchesWithOrbits, stateOnPatches, type PatchWithOrbit } from '../orbit/patches';
import { lookAheadWarpIndex, maxWarpIndexForAltitude, nextWarpEvent, warpFactor, type WarpEvent } from '../orbit/warp';
import {
  abort as abortVessel,
  anyPending,
  assembleVessel,
  chuteEnvelope,
  fireNextStage,
  G_DOSE_LIMIT,
  helmCraft,
  holdOnGround,
  isControllable,
  needsIntegration as vesselNeedsIntegration,
  nextLiveStage,
  radarAltitude,
  reportedMach,
  rideBody,
  setFineControl,
  setLights,
  setRcsEnabled,
  setSasEnabled,
  setSasHoldDirection,
  setSasMode,
  seededCraftIds,
  stagingInfo,
  stepVessel,
  stepVesselReduced,
  structureOf,
  surfaceSituation,
  toggleLegs,
  toVesselSnapshot,
  vesselClearance,
  vesselReadouts,
  vesselStateHash,
  type CraftIdSource,
  type Vessel,
} from '../vessel';
import { anyEngineBurning } from '../vessel/modules/engine';
import { rcsTranslationActive } from '../control/allocation';
import { bodyEnvBase, OrientationCache, WorldEnv, type BodyEnvBase } from './environment';
import { MilestoneEvaluator, type MilestoneFrame, type MilestoneHost, type OrbitSummary } from './milestones';
import { applyPose, applyStartResources, landedPose, orbitPose, padPose, statePose } from './scenarioStart';
import { StateHasher } from './stateHash';
import {
  IMPACT_DISC_RADIUS,
  IMPACT_REFRESH_DISTANCE,
  LOW_RADAR_ALTITUDE,
  SLOW_ALTITUDE,
  SLOW_GROUND_SPEED,
  TerrainPolicy,
  VESSEL_DISC_RADIUS,
  VESSEL_REFRESH_DISTANCE,
  WARP_CLAMP_RADAR_ALTITUDE,
} from './terrainPolicy';

// ------------------------------------------------------------------------------------------- constants

/** Physics bubble radius about the active vessel, m, and the distance at which a full-tier vessel leaves it. */
export const BUBBLE_RADIUS = 25000;
export const BUBBLE_EXIT_RADIUS = 27000;
/** Seconds without any force before an integrated vessel goes on rails. */
export const COAST_TIME_TO_RAILS = 0.5;
/** Another free vessel closer than this keeps both integrated, m (between bounding spheres). */
export const PROXIMITY_DISTANCE = 200;
/** Step of the reduced fidelity tier, s, and the same in ticks (a whole number: the tier stays on the tick grid). */
export const REDUCED_DT = 0.5;
const REDUCED_STEP_TICKS = REDUCED_DT * TICKS_PER_SECOND;
export const MAX_DEBRIS = 24;
/** Uncontrollable fragments lighter than this (kg) expire after FRAGMENT_LIFETIME seconds. */
export const FRAGMENT_MASS = 50;
export const FRAGMENT_LIFETIME = 60;
/** Patch refresh interval while the active vessel is integrated, steps (10 Hz). */
export const PATCH_REFRESH_STEPS = 12;
/** Physics steps per frame allowed at 1x (multiplied by the warp factor). */
export const MAX_STEPS_PER_FRAME_1X = 16;
/** Inertial body rate above which rails warp is refused, rad/s. */
export const ROTATION_WARP_LIMIT = 0.5 * DEG;
/** SAS pointing error below which the attitude tracks the hold direction during rails warp, rad. */
export const SAS_TRACK_ERROR = 2 * DEG;
/** Node burn bookkeeping (sim-design 3.5). */
export const NODE_LOCK_LEAD = 60;
export const NODE_THROTTLE_WINDOW = 300;
export const NODE_COMPLETE_DV = 0.1;
/** Band limit of the terrain used for impact prediction, m. */
export const IMPACT_PREDICTION_LAMBDA = 150;
/** Collision vertices warmed per control tick around the predicted touchdown point. */
export const PREWARM_BUDGET = 48;
/** Radar altitude below which the touchdown area is warmed, m. */
export const PREWARM_RADAR_ALTITUDE = 1500;
/** Pending events kept for consumers that never drain the queue. */
export const MAX_PENDING_EVENTS = 1024;
/** Sun direction / visibility refresh interval per vessel, steps. */
const SUN_REFRESH_STEPS = 12;
/** Seconds a 'landed' scenario vessel is given to come to rest before startUt. */
const LANDED_SETTLE_TIME = 40;
const LANDED_DROP_HEIGHT = 0.25;

const RAILS_REFUSED = 'Cannot warp on rails while under acceleration, in an atmosphere or near terrain';
const ROTATING_REFUSED = 'Cannot warp while rotating';

// ----------------------------------------------------------------------------------------------- types

export interface CreateSimOptions {
  terrain: TerrainProvider;
  /**
   * Where craft ids come from (ARCHITECTURE section 3). Default: the local universe's seeded counter
   * (`seededCraftIds()`), so a session is reproducible.
   */
  ids?: CraftIdSource;
  /**
   * The render root of the snapshots (ARCHITECTURE section 3). 'soiBody' (the default, what `createSession`
   * gives): the origin of every `...Root` field is the centre of the active vessel's SOI body, replaced
   * with a new frame epoch and a rebase when that body changes. 'rootBody': the origin is the library's root
   * body and is never replaced, as in v1; this is what the deprecated `createSim` gives, so that
   * presentation code that does not apply rebases yet sees no origin change. It goes with that alias.
   */
  renderRoot?: 'soiBody' | 'rootBody';
}

/** What became of a vessel the world removed. */
export interface DebrisFate {
  vesselId: string;
  name: string;
  ut: number;
  reason: 'burnedUp' | 'impact' | 'expired' | 'limit';
  bodyId: string;
  latitudeDeg: number;
  longitudeDeg: number;
  /** Great-circle distance from the scenario's launch site, m (-1 when on another body). */
  distanceFromSite: number;
}

export interface WorldStats {
  steps: number;
  railsAdvances: number;
  patchRefreshes: number;
  terrainRequests: number;
  /** Times warp was clamped to 1x because final terrain data was missing below 300 m. */
  terrainWarpClamps: number;
}

/** The Sim plus read-only diagnostics for tests and tools (not part of the contract). */
export interface SimWorld extends Sim {
  debrisLog(): readonly DebrisFate[];
  stats(): WorldStats;
  /** Clearance between the part envelopes of two vessels on the same body, m (null when unknown ids or different bodies). */
  clearance(vesselIdA: string, vesselIdB: string): number | null;
}

type RailsEventKind = 'soiEnter' | 'soiExit' | 'atmosphere' | 'impact' | 'recheck';

interface RailsEvent {
  ut: number;
  kind: RailsEventKind;
  nextBodyId: string | null;
}

interface Entry {
  vessel: Vessel;
  bodyId: string;
  mode: 'landed' | 'rails' | 'integrated';
  tier: FidelityTier;
  /** Orbit of the centre of mass while mode === 'rails'. */
  orbit: Orbit | null;
  railsEvent: RailsEvent | null;
  coastTime: number;
  forceIntegrate: boolean;
  nearOther: boolean;
  env: WorldEnv;
  controllable: boolean;
  /** Pose at the start of the last physics step (presentation interpolation). */
  prevR: Vec3;
  prevV: Vec3;
  prevQ: Quat;
  prevValid: boolean;
  /** Tick the reduced-tier state refers to. */
  reducedTick: number;
  /** Counter that changes when the vessel's orbit or plan changes (VesselSnapshot.revision). */
  revision: number;
  sunStep: number;
  /** Attitude follows the SAS hold direction during rails warp. */
  trackHold: boolean;
  /** In the terrain regime (low or slow near the ground): final data must be resident under it. */
  regime: boolean;
  /**
   * Tick the vessel came into being: the scenario start, or the start of the step (or the command) whose
   * separation made it. `Vessel.age` is kept equal to the world time minus this for EVERY entry, whatever
   * its tier (the vessel package itself only counts the steps it is given).
   */
  bornTick: number;
  removed: boolean;
}

interface BurnState {
  nodeId: string;
  dv0: Vec3;
  dvRemaining: Vec3;
}

interface TouchState {
  verticalSpeed: number;
  horizontalSpeed: number;
  tilt: number;
}

const cloneControls = (c: ControlInputs): ControlInputs => ({ pitch: c.pitch, yaw: c.yaw, roll: c.roll, translate: { x: c.translate.x, y: c.translate.y, z: c.translate.z }, throttle: c.throttle });

function hasArmedEngine(v: Vessel): boolean {
  for (const p of v.parts) {
    for (let m = 0; m < p.modules.length; m++) {
      const ms = p.modules[m]!;
      const md = p.def.modules[m]!;
      if (ms.type === 'engine' && md.type === 'engine' && !md.fixedBurn && ms.active && !ms.flameout) return true;
    }
  }
  return false;
}

// ------------------------------------------------------------------------------------------------ world

class World implements SimWorld, MilestoneHost {
  readonly defs: DefLibrary;
  readonly scenario: ScenarioDef;
  readonly ready: Promise<void>;
  readonly commands: PlayerCommands;
  readonly debug: SimDebug;

  private readonly system: BodySystem;
  private readonly terrain: TerrainProvider;
  private readonly policy: TerrainPolicy;
  private readonly bases = new Map<string, BodyEnvBase>();
  private readonly orient: OrientationCache;
  private readonly surfaceTargets: SurfaceTarget[];
  private readonly milestones: MilestoneEvaluator;

  /** Id of the pad of the scenario's site that the scenario stands on. */
  private readonly startPad: string;

  // render root (SimSnapshot.frame)
  private readonly renderRoot: 'soiBody' | 'rootBody';
  private frameEpoch = 0;
  /** Body whose centre is the origin now, and the origins of earlier epochs, newest first. */
  private frameBody: string;
  private frameHistory: { epoch: number; bodyId: string }[] = [];
  /** Epoch and origin the last snapshot() carried: the rebase of the next one starts there. */
  private frameSeenEpoch = 0;
  private frameSeenBody: string;
  /** SOI body an event's ROOT position was produced in (the vessel package works in the BCI frame of its body). */
  private readonly eventBody = new WeakMap<SimEvent, string>();
  private shiftedPatches: { source: { current: Patch[]; planned: Patch[] }; bodyId: string; out: { current: Patch[]; planned: Patch[] } } | null = null;
  /** Stage figures of craft that are not the active vessel's helm craft, by craft record. */
  private readonly craftStages = new WeakMap<object, { step: number; parts: number; infos: StageInfo[]; acceleration: number[] }>();

  /** The id of the scenario's craft, issued once by the id source (the start vessel is built twice: before and after its terrain is resident). */
  private readonly startCraftId: string;

  private entries: Entry[] = [];
  private active!: Entry;
  /** Snapshot of the last active vessel when it was destroyed with nothing left to take over. */
  private wreck: VesselSnapshot | null = null;

  // time: the clock is a whole tick (src/sim/clock.ts); `ut` = clockTick / TICKS_PER_SECOND is derived.
  private clockTick: number;
  private ut: number;
  /**
   * The clock base: the tick of the scenario start, of the last rails landing or of the last debug time
   * change. Body orientations and the rails time of flight of a step are evaluated as "at the base, plus
   * whole steps since" (see OrientationCache), so the rotation is exactly uniform from step to step.
   */
  private baseTick: number;
  private utBase: number;
  private stepsSinceBase = 0;
  /** Monotonic count of physics steps + rails advances (SimSnapshot.tick, deprecated name). */
  private revision = 0;
  private stepsSinceControl = 0;
  private stepCount = 0;
  /** Presentation lag behind the sim state, s in [0, PHYSICS_DT). */
  private lag = 0;
  /** The step time being computed, and its offset from the clock base (kept apart for precision). */
  private splitUt = NaN;
  private splitOffset = 0;
  private lastAdvanceOnRails = false;
  private railsWarpActive = false;

  // controls and player state
  private controls: ControlInputs = cloneControls(NEUTRAL_CONTROLS);
  private navballMode: NavballMode = 'surface';
  private prevNavAltitude = 0;
  private targetBodyId: string | null;
  private nodes: ManeuverNode[] = [];
  private nodeSerial = 0;
  private burn: BurnState | null = null;

  // warp
  private warpIndex = 0;
  private warpMax = MAX_PHYSICS_WARP_INDEX;
  private warpLimitedBy: string | null = null;
  private warpEvent: WarpEvent | null = null;
  private warpStamp = -1;
  private mustStamp = -1;
  private mustCached = false;

  // prediction
  private patchItems: { current: PatchWithOrbit[]; planned: PatchWithOrbit[] } = { current: [], planned: [] };
  private patches: { current: Patch[]; planned: Patch[] } = { current: [], planned: [] };
  private patchesDirty = true;
  private stageInfo: StageInfo[] = [];
  private stageInfoDirty = true;
  private soiPrediction: { from: string; to: string; ut: number } | null = null;

  // events, mission
  private events: SimEvent[] = [];
  private eventsView: SimEvent[] | null = null;
  private missionFailed = false;
  private failureReason: string | null = null;
  private crewAlive = true;
  private cheats = 0;
  private liftoffUt: number | null = null;

  // per-mission bookkeeping for milestone data
  private peakG = 0;
  private peakGDose = 0;
  private wasTouching = false;
  private preContact: TouchState = { verticalSpeed: 0, horizontalSpeed: 0, tilt: 0 };
  private touchdown: TouchState = { verticalSpeed: 0, horizontalSpeed: 0, tilt: 0 };
  private readonly stageFiredUt = new Map<number, number>();
  private readonly separations: number[] = [];

  // terrain accounting
  private incompleteQueries = 0;
  private terrainWarpClamps = 0;
  private terrainClampActive = false;

  // diagnostics
  private readonly fates: DebrisFate[] = [];
  private railsAdvances = 0;
  private patchRefreshes = 0;
  private peekCache: SimSnapshot | null = null;
  private stateSerial = 0;
  private peekSerial = -1;

  constructor(defs: DefLibrary, scenarioId: string, opts: CreateSimOptions) {
    const scenario = defs.scenarios[scenarioId];
    if (!scenario) throw new Error(`createSim: unknown scenario "${scenarioId}"`);
    if (!defs.vehicles[scenario.vehicle]) throw new Error(`scenarios/${scenarioId}.json: unknown vehicle "${scenario.vehicle}"`);
    const startSite = defs.sites[scenario.site];
    if (!startSite) throw new Error(`scenarios/${scenarioId}.json: unknown site "${scenario.site}"`);
    // The pad the scenario stands on (absent = the site's first pad); an unknown pad is refused here by name.
    this.startPad = padOf(startSite, scenario.pad).id;
    this.defs = defs;
    this.scenario = scenario;
    this.terrain = opts.terrain;
    this.system = createBodySystem(defs);
    this.policy = new TerrainPolicy(opts.terrain);
    this.orient = new OrientationCache(this.system);
    for (const id of this.system.ids) this.bases.set(id, bodyEnvBase(this.system.body(id)));
    this.surfaceTargets = buildSurfaceTargets(defs, scenario);
    this.milestones = new MilestoneEvaluator(scenario.milestones);
    this.targetBodyId = scenario.target && defs.bodies[scenario.target] ? scenario.target : null;
    this.clockTick = tickOfInstant(scenario.startUt, `scenarios/${scenarioId}.json: startUt`);
    this.baseTick = this.clockTick;
    this.ut = utOfTick(this.clockTick);
    this.utBase = this.ut;
    this.startCraftId = (opts.ids ?? seededCraftIds()).next(scenario.vehicle);
    this.renderRoot = opts.renderRoot ?? 'soiBody';
    this.frameBody = this.system.rootId;
    this.frameSeenBody = this.system.rootId;
    this.commands = this.makeCommands();
    this.debug = this.makeDebug();
    this.placeStartVessel(false);
    this.ready = this.initialise();
    // A caller that never awaits `ready` still gets its errors through the next step.
    this.ready.catch(() => undefined);
  }

  // ------------------------------------------------------------------------------------------ helpers

  private info(bodyId: string): BodyInfo {
    return this.bases.get(bodyId)!.info;
  }

  private pushEvent(e: SimEvent): void {
    this.events.push(e);
    if (this.events.length > MAX_PENDING_EVENTS) this.events.splice(0, this.events.length - MAX_PENDING_EVENTS);
    this.eventsView = null;
  }

  private touch(): void {
    this.stateSerial++;
  }

  /**
   * BCBF -> ROOT orientation of a body at `ut`, evaluated as the orientation at the clock base plus the
   * rotation over the offset from it.
   */
  private orientAt(bodyId: string, ut: number): Quat {
    return this.orient.at(bodyId, this.utBase, this.offsetFromBase(ut));
  }

  /**
   * Seconds from the clock base to `ut`: whole ticks times the step for an instant on the grid (exactly
   * uniform from step to step), the plain difference for an event instant inside a tick.
   */
  private offsetFromBase(ut: number): number {
    if (ut === this.ut) return this.stepsSinceBase * PHYSICS_DT;
    const tick = nearestTick(ut);
    return utOfTick(tick) === ut ? (tick - this.baseTick) * PHYSICS_DT : ut - this.utBase;
  }

  private envAt(e: Entry, ut: number): WorldEnv {
    const base = this.bases.get(e.bodyId)!;
    const r = e.vessel.r;
    e.env.aim(base, ut, this.orientAt(e.bodyId, ut), Math.hypot(r.x, r.y, r.z) - base.info.radius);
    return e.env;
  }

  private refreshSun(e: Entry, ut: number): void {
    const posRoot = v3.add(this.system.stateRoot(e.bodyId, ut).r, e.vessel.r);
    e.env.sunDir = this.system.sunDirection(posRoot, ut).dir;
    e.env.sunVisibility = this.system.sunVisibility(posRoot, ut);
    e.sunStep = this.stepCount;
  }

  private comState(e: Entry): { r: Vec3; v: Vec3 } {
    const v = e.vessel;
    const com = v.mp.com;
    return { r: v3.add(v.r, quat.rotate(v.q, com)), v: v3.add(v.v, quat.rotate(v.q, v3.cross(v.w, com))) };
  }

  private setFromCom(e: Entry, rCom: Vec3, vCom: Vec3): void {
    const v = e.vessel;
    const com = v.mp.com;
    const off = quat.rotate(v.q, com);
    const voff = quat.rotate(v.q, v3.cross(v.w, com));
    v.r.x = rCom.x - off.x;
    v.r.y = rCom.y - off.y;
    v.r.z = rCom.z - off.z;
    v.v.x = vCom.x - voff.x;
    v.v.y = vCom.y - voff.y;
    v.v.z = vCom.z - voff.z;
  }

  private newEntry(vessel: Vessel, bodyId: string): Entry {
    if (!(vessel.mp.mass > 0)) structureOf(vessel);
    return {
      vessel,
      bodyId,
      mode: vessel.hold !== null ? 'landed' : 'integrated',
      tier: 'full',
      orbit: null,
      railsEvent: null,
      coastTime: 0,
      forceIntegrate: false,
      nearOther: false,
      env: new WorldEnv(this.terrain),
      controllable: isControllable(vessel),
      prevR: v3.clone(vessel.r),
      prevV: v3.clone(vessel.v),
      prevQ: quat.clone(vessel.q),
      prevValid: false,
      reducedTick: this.clockTick,
      revision: 0,
      sunStep: -1000000,
      trackHold: false,
      regime: false,
      bornTick: this.clockTick,
      removed: false,
    };
  }

  /** Age of every vessel at the current world time (rails-tier and held vessels are not stepped). */
  private stampAges(): void {
    for (const e of this.entries) e.vessel.age = (this.clockTick - e.bornTick) / TICKS_PER_SECOND;
  }

  private coarseHeight = (bodyId: string, dirFixed: Vec3): number => this.terrain.heightAt(bodyId, dirFixed, IMPACT_PREDICTION_LAMBDA);

  // ------------------------------------------------------------------------------------- start state

  /** Build the scenario vessel and place it. `final` = terrain under the start point is resident. */
  private placeStartVessel(final: boolean): void {
    const sc = this.scenario;
    const vessel = assembleVessel(this.defs, sc.vehicle, { stagesAlreadyFired: sc.stagesAlreadyFired, craft: { craftId: this.startCraftId, joinedTick: this.clockTick } });
    if (sc.resources) applyStartResources(vessel, sc.resources);
    const start = sc.start;
    const ut = sc.startUt;
    let bodyId: string;
    switch (start.kind) {
      case 'pad': {
        const site = this.defs.sites[sc.site]!;
        bodyId = site.bodyId;
        const where = padLocationOf(site, this.startPad);
        const dir = dirFromLatLon(where.latDeg * DEG, where.lonDeg * DEG);
        const elevation = resolvePadElevation(site, this.bases.get(bodyId)!.hasTerrain ? this.terrain.heightAt(bodyId, dir, final ? undefined : IMPACT_PREDICTION_LAMBDA) : 0, this.startPad);
        applyPose(vessel, padPose(this.system, site, vessel, ut, elevation, this.startPad));
        break;
      }
      case 'orbit': {
        const pose = orbitPose(this.system, start);
        bodyId = pose.bodyId;
        applyPose(vessel, pose);
        break;
      }
      case 'state': {
        const pose = statePose(start);
        bodyId = pose.bodyId;
        applyPose(vessel, pose);
        break;
      }
      case 'landed': {
        bodyId = start.bodyId;
        const dir = dirFromLatLon(start.latDeg * DEG, start.lonDeg * DEG);
        const base = this.bases.get(bodyId)!;
        const h = base.hasTerrain ? this.terrain.heightAt(bodyId, dir, final ? undefined : IMPACT_PREDICTION_LAMBDA) : 0;
        applyPose(vessel, landedPose(this.system, bodyId, start.latDeg, start.lonDeg, vessel, ut, h, 0));
        break;
      }
    }
    if (!this.defs.bodies[bodyId]) throw new Error(`scenarios/${sc.id}.json: unknown body "${bodyId}"`);
    const e = this.newEntry(vessel, bodyId);
    this.entries = [e];
    this.active = e;
    if (vessel.hold !== null || start.kind === 'landed') {
      holdOnGround(vessel, this.envAt(e, ut));
      e.mode = 'landed';
    }
    const alt = v3.len(vessel.r) - this.info(bodyId).radius;
    this.navballMode = defaultNavballMode(alt, this.info(bodyId).def.navballSwitchAltitude);
    this.prevNavAltitude = alt;
    if (start.kind !== 'pad') this.liftoffUt = ut;
    this.refreshSun(e, ut);
    // The first frame of a session has its origin at the start vessel's SOI body: no epoch before it.
    this.frameBody = this.renderRoot === 'soiBody' ? bodyId : this.system.rootId;
    this.frameSeenBody = this.frameBody;
    this.frameEpoch = 0;
    this.frameSeenEpoch = 0;
    this.frameHistory = [];
  }

  /**
   * Keep the render root at the active vessel's SOI body: when that body is another one than the origin, a
   * new frame epoch starts and the old origin goes into the history that every snapshot describes.
   */
  private updateRenderRoot(): void {
    if (this.renderRoot !== 'soiBody') return;
    const want = this.active.bodyId;
    if (want === this.frameBody) return;
    this.frameHistory.unshift({ epoch: this.frameEpoch, bodyId: this.frameBody });
    if (this.frameHistory.length > FRAME_HISTORY_EPOCHS) this.frameHistory.length = FRAME_HISTORY_EPOCHS;
    this.frameEpoch++;
    this.frameBody = want;
    this.touch();
  }

  private async initialise(): Promise<void> {
    const sc = this.scenario;
    const e = this.active;
    const base = this.bases.get(e.bodyId)!;
    if (base.hasTerrain) {
      const dirFixed = quat.rotateInv(this.orientAt(e.bodyId, this.ut), v3.normalize(e.vessel.r));
      const alt = v3.len(e.vessel.r) - base.info.radius;
      if (sc.start.kind === 'pad') {
        const site = this.defs.sites[sc.site]!;
        await this.policy.request('pad', e.bodyId, base.info.radius, dirFixed, padOf(site, this.startPad).blendRadius + 600);
      } else if (sc.start.kind === 'landed' || alt < SLOW_ALTITUDE) {
        await this.policy.request(`vessel:${e.vessel.id}`, e.bodyId, base.info.radius, dirFixed, VESSEL_DISC_RADIUS);
      }
    }
    const waiting = this.policy.pending();
    if (waiting) await waiting;
    if (sc.start.kind === 'pad' || sc.start.kind === 'landed') {
      // Re-place on the final surface (pad elevation 'terrain' resolved; the landed vessel set down).
      this.placeStartVessel(true);
      if (sc.start.kind === 'landed') this.settleLanded();
      const a = this.active;
      const abase = this.bases.get(a.bodyId)!;
      if (abase.hasTerrain) {
        const dirFixed = quat.rotateInv(this.orientAt(a.bodyId, this.ut), v3.normalize(a.vessel.r));
        const radius = Math.max(8, structureOf(a.vessel).boundingRadius * 0.25 + 3);
        for (let guard = 0; guard < 4096; guard++) if (this.terrain.prewarmCollision(a.bodyId, dirFixed, radius, 4096) === 0) break;
      }
    }
    this.initialiseModes();
    this.stampAges();
    this.events.length = 0;
    this.eventsView = null;
    this.touch();
  }

  /** Let a 'landed' scenario vessel come to rest on the real surface before startUt. */
  private settleLanded(): void {
    const sc = this.scenario;
    if (sc.start.kind !== 'landed') return;
    const e = this.active;
    const v = e.vessel;
    const steps = Math.round(LANDED_SETTLE_TIME / PHYSICS_DT);
    const tick0 = this.clockTick - steps;
    const t0 = utOfTick(tick0);
    const dir = dirFromLatLon(sc.start.latDeg * DEG, sc.start.lonDeg * DEG);
    const base = this.bases.get(e.bodyId)!;
    // Highest terrain under the footprint, so that no probe starts below the surface.
    let h = base.hasTerrain ? this.terrain.heightAt(e.bodyId, dir) : 0;
    if (base.hasTerrain) {
      const foot = structureOf(v).boundingRadius;
      const east = v3.normalize(v3.cross({ x: 0, y: 0, z: 1 }, dir));
      const north = v3.cross(dir, east);
      for (let k = 0; k < 16; k++) {
        const a = (k * Math.PI) / 8;
        for (const f of [0.5, 1]) {
          const d = v3.normalize(v3.add(dir, v3.scale(v3.add(v3.scale(east, Math.cos(a)), v3.scale(north, Math.sin(a))), (foot * f) / base.info.radius)));
          h = Math.max(h, this.terrain.heightAt(e.bodyId, d));
        }
      }
    }
    v.hold = null;
    v.surface = 'none';
    applyPose(v, landedPose(this.system, e.bodyId, sc.start.latDeg, sc.start.lonDeg, v, t0, h, LANDED_DROP_HEIGHT));
    for (let i = 0; i < steps; i++) {
      stepVessel(v, this.envAt(e, utOfTick(tick0 + i)), NEUTRAL_CONTROLS, PHYSICS_DT);
      if (v.destroyed) throw new Error(`scenarios/${sc.id}.json: the vessel broke up while being set down`);
    }
    if (v.hold === null) holdOnGround(v, this.envAt(e, sc.startUt));
    else rideBody(v, this.envAt(e, sc.startUt), 0);
    e.mode = 'landed';
    e.prevValid = false;
  }

  private initialiseModes(): void {
    for (const e of this.entries) {
      if (e.vessel.hold !== null) {
        e.mode = 'landed';
        continue;
      }
      e.mode = 'integrated';
      if (!this.mustIntegrate(e, this.envAt(e, this.ut))) this.toRails(e);
    }
    this.patchesDirty = true;
    this.stageInfoDirty = true;
    this.warpStamp = -1;
    this.mustStamp = -1;
  }

  // ------------------------------------------------------------------------------- rails machinery

  private toRails(e: Entry): void {
    const s = this.comState(e);
    e.orbit = makeOrbit(e.bodyId, this.info(e.bodyId).mu, s.r, s.v, this.ut);
    e.mode = 'rails';
    e.coastTime = 0;
    e.forceIntegrate = false;
    e.railsEvent = this.computeRailsEvent(e, this.ut);
    e.revision++;
    if (e === this.active) this.patchesDirty = true;
  }

  private computeRailsEvent(e: Entry, t: number): RailsEvent | null {
    const o = e.orbit!;
    const s = propagate(o, t);
    const p = predictPatchesWithOrbits(this.system, { bodyId: e.bodyId, r: s.r, v: s.v }, t, [], { maxPatches: 1, terrainHeight: this.coarseHeight }).current[0];
    if (!p) return null;
    const patch = p.patch;
    switch (patch.endReason) {
      case 'soiEnter':
      case 'soiExit':
        return { ut: patch.tEnd, kind: patch.endReason, nextBodyId: patch.nextBodyId ?? null };
      case 'atmosphere':
        return { ut: patch.tEnd, kind: 'atmosphere', nextBodyId: null };
      case 'impact':
        return { ut: patch.tEnd, kind: 'impact', nextBodyId: null };
      default:
        return { ut: patch.tEnd, kind: 'recheck', nextBodyId: null };
    }
  }

  /**
   * Move a rails vessel to `utNew`, processing its events in (now, utNew] exactly at their times. Returns
   * false when the vessel was removed (impact of far debris).
   */
  private advanceOnRails(e: Entry, utNew: number): boolean {
    for (let guard = 0; guard < 64; guard++) {
      const ev = e.railsEvent;
      if (!ev || ev.ut > utNew || e.orbit === null) break;
      const s = propagate(e.orbit, ev.ut);
      if (ev.kind === 'soiEnter' || ev.kind === 'soiExit') {
        const from = e.bodyId;
        const to = ev.nextBodyId!;
        if (ev.kind === 'soiEnter') {
          const cs = this.system.stateRelParent(to, ev.ut);
          s.r = v3.sub(s.r, cs.r);
          s.v = v3.sub(s.v, cs.v);
        } else {
          const bs = this.system.stateRelParent(from, ev.ut);
          s.r = v3.add(s.r, bs.r);
          s.v = v3.add(s.v, bs.v);
        }
        e.bodyId = to;
        e.orbit = makeOrbit(to, this.info(to).mu, s.r, s.v, ev.ut);
        e.prevValid = false;
        this.onSoiChange(e, from, to, ev.ut);
        e.railsEvent = this.computeRailsEvent(e, ev.ut + 1e-3);
        // The boundary just crossed is not an event again for the first second (hysteresis).
        if (e.railsEvent && e.railsEvent.ut <= ev.ut + 1 && (e.railsEvent.kind === 'soiEnter' || e.railsEvent.kind === 'soiExit')) {
          e.railsEvent = this.computeRailsEvent(e, ev.ut + 1.001);
        }
        continue;
      }
      if (ev.kind === 'atmosphere') {
        if (e.tier === 'full') {
          // Integrate from here on. The vessel leaves rails at the grid tick `utNew`, by an exact Kepler
          // evaluation there: the caller clamps the bubble's advance to the tick the event lies in.
          const at = this.railsState(e, utNew);
          this.setFromCom(e, at.r, at.v);
          e.mode = 'integrated';
          e.orbit = null;
          e.railsEvent = null;
          e.coastTime = 0;
          e.forceIntegrate = true;
          return true;
        }
        // Reduced tier: its steps start at the first whole tick at or after the entry.
        const entryTick = Math.min(ceilTick(ev.ut), nearestTick(utNew));
        const at = propagate(e.orbit, utOfTick(entryTick));
        this.setFromCom(e, at.r, at.v);
        e.tier = 'reduced';
        e.mode = 'integrated';
        e.orbit = null;
        e.railsEvent = null;
        e.reducedTick = entryTick;
        return this.advanceReduced(e, utNew);
      }
      if (ev.kind === 'impact') {
        if (e.tier === 'full') {
          const at = this.railsState(e, utNew);
          this.setFromCom(e, at.r, at.v);
          e.mode = 'integrated';
          e.orbit = null;
          e.railsEvent = null;
          e.forceIntegrate = true;
          return true;
        }
        this.setFromCom(e, s.r, s.v);
        this.removeEntry(e, 'impact', ev.ut);
        return false;
      }
      // 'recheck': end of a closed revolution or of the prediction horizon.
      e.railsEvent = this.computeRailsEvent(e, ev.ut + 1e-3);
      if (e.railsEvent && e.railsEvent.ut <= ev.ut) e.railsEvent = null;
      if (e === this.active) this.patchesDirty = true;
    }
    if (e.orbit !== null) {
      const s = this.railsState(e, utNew);
      this.setFromCom(e, s.r, s.v);
    }
    return true;
  }

  /**
   * Centre-of-mass state of a rails vessel at `utNew`. A step time is the clock base plus whole steps:
   * propagate with the two apart (exact time of flight).
   */
  private railsState(e: Entry, utNew: number): { r: Vec3; v: Vec3 } {
    return utNew === this.splitUt ? propagate(e.orbit!, this.utBase, this.splitOffset) : propagate(e.orbit!, utNew);
  }

  private advanceReduced(e: Entry, utNew: number): boolean {
    const v = e.vessel;
    const tickNew = nearestTick(utNew);
    while (e.reducedTick + REDUCED_STEP_TICKS <= tickNew) {
      const t = utOfTick(e.reducedTick);
      const env = this.envAt(e, t);
      if (this.stepCount - e.sunStep >= SUN_REFRESH_STEPS * 10) this.refreshSun(e, t);
      const res = stepVesselReduced(v, env, REDUCED_DT);
      e.reducedTick += REDUCED_STEP_TICKS;
      if (res.removed !== null) {
        this.removeEntry(e, res.removed, utOfTick(e.reducedTick));
        return false;
      }
      // Out of the atmosphere on a coast: Kepler takes over.
      const alt = v3.len(v.r) - this.info(e.bodyId).radius;
      const atm = this.info(e.bodyId).def.atmosphere;
      if ((!atm || alt >= atm.simTop) && v3.dot(v.r, v.v) > 0) {
        const s = this.comState(e);
        e.orbit = makeOrbit(e.bodyId, this.info(e.bodyId).mu, s.r, s.v, utOfTick(e.reducedTick));
        e.tier = 'rails';
        e.mode = 'rails';
        e.railsEvent = this.computeRailsEvent(e, utOfTick(e.reducedTick));
        return this.advanceOnRails(e, utNew);
      }
    }
    return true;
  }

  private onSoiChange(e: Entry, from: string, to: string, ut: number): void {
    this.pushEvent({ type: 'soiChange', ut, vesselId: e.vessel.id, fromBodyId: from, toBodyId: to });
    e.revision++;
    if (e !== this.active) return;
    this.updateRenderRoot();
    const pred = this.soiPrediction && this.soiPrediction.from === from && this.soiPrediction.to === to ? this.soiPrediction.ut : null;
    this.milestones.noteSoiChange(from, to, this.info(to).parentId === from, ut, pred);
    this.soiPrediction = null;
    this.patchesDirty = true;
    const alt = v3.len(e.vessel.r) - this.info(to).radius;
    this.navballMode = defaultNavballMode(Math.max(alt, 0), this.info(to).def.navballSwitchAltitude);
    this.prevNavAltitude = alt;
    this.warpStamp = -1;
  }

  /** SOI transition of a vessel that is being integrated (checked at control-tick cadence). */
  private checkSoiIntegrated(e: Entry): void {
    const body = this.info(e.bodyId);
    const v = e.vessel;
    if (body.soiRadius !== null && body.parentId !== null && v3.len(v.r) > body.soiRadius && v3.dot(v.r, v.v) > 0) {
      const bs = this.system.stateRelParent(e.bodyId, this.ut);
      const from = e.bodyId;
      v.r = v3.add(v.r, bs.r);
      v.v = v3.add(v.v, bs.v);
      e.bodyId = body.parentId;
      e.prevValid = false;
      this.onSoiChange(e, from, e.bodyId, this.ut);
      return;
    }
    for (const cid of body.childIds) {
      const child = this.info(cid);
      if (child.soiRadius === null) continue;
      const cs = this.system.stateRelParent(cid, this.ut);
      const d = v3.sub(v.r, cs.r);
      if (v3.len(d) < child.soiRadius && v3.dot(d, v3.sub(v.v, cs.v)) < 0) {
        const from = e.bodyId;
        v.r = d;
        v.v = v3.sub(v.v, cs.v);
        e.bodyId = cid;
        e.prevValid = false;
        this.onSoiChange(e, from, cid, this.ut);
        return;
      }
    }
  }

  // --------------------------------------------------------------------------------- integration rule

  private mustIntegrate(e: Entry, env: WorldEnv): boolean {
    const v = e.vessel;
    if (e.forceIntegrate || e.nearOther) return true;
    if (vesselNeedsIntegration(v, env)) return true;
    if (e === this.active && v.hold !== 'clamps' && v.hold !== 'ground') {
      const c = this.controls;
      if (c.throttle > 0 && hasArmedEngine(v)) return true;
      if (rcsTranslationActive(v, c.translate)) return true;
    }
    return false;
  }

  /** True when any vessel of the physics bubble must be integrated. */
  private bubbleMustIntegrate(): boolean {
    if (this.mustStamp === this.stateSerial) return this.mustCached;
    let must = false;
    for (const e of this.entries) {
      if (e.tier !== 'full' || e.removed) continue;
      if (this.mustIntegrate(e, this.envAt(e, this.ut))) {
        must = true;
        break;
      }
    }
    this.mustStamp = this.stateSerial;
    this.mustCached = must;
    return must;
  }

  get needsIntegration(): boolean {
    return this.bubbleMustIntegrate();
  }

  // ---------------------------------------------------------------------------------------- stepping

  private throwIfBroken(): void {
    if (this.policy.error !== null) {
      const e = this.policy.error;
      throw e instanceof Error ? e : new Error(String(e));
    }
  }

  step(): void {
    this.throwIfBroken();
    this.ensurePatches();
    if (this.stepsSinceControl % CONTROL_TICK_STEPS === 0) this.boundaryWork();
    const ut0 = this.ut;
    const dt = PHYSICS_DT;
    const stepNumber = this.stepsSinceBase + 1;
    const utNew = utOfTick(this.clockTick + 1);
    this.splitUt = utNew;
    this.splitOffset = stepNumber * dt;
    this.updateSasHold(this.active);
    let incomplete = false;
    for (let k = 0; k < this.entries.length; k++) {
      const e = this.entries[k]!;
      if (e.removed) continue;
      if (e.tier === 'full') {
        if (this.stepFull(e, ut0, utNew, dt)) incomplete = true;
      } else if (e.tier === 'reduced') {
        this.advanceReduced(e, utNew);
      } else if (e.railsEvent && e.railsEvent.ut <= utNew) {
        this.advanceOnRails(e, utNew);
      }
    }
    if (incomplete) this.incompleteQueries++;
    this.stepsSinceBase = stepNumber;
    this.clockTick += 1;
    this.ut = utNew;
    this.stampAges();
    this.revision++;
    this.stepCount++;
    this.stepsSinceControl++;
    this.lastAdvanceOnRails = false;
    this.railsWarpActive = false;
    this.afterAdvance(dt, this.stepsSinceControl % CONTROL_TICK_STEPS === 0);
    if (this.active.mode !== 'rails' && this.stepCount % PATCH_REFRESH_STEPS === 0) this.patchesDirty = true;
    this.touch();
  }

  /** One physics step of a full-tier vessel. Returns true when a terrain query ran on non-final data. */
  private stepFull(e: Entry, ut0: number, utNew: number, dt: number): boolean {
    const v = e.vessel;
    const isActive = e === this.active;
    v3.copyTo(e.prevR, v.r);
    v3.copyTo(e.prevV, v.v);
    e.prevQ.x = v.q.x;
    e.prevQ.y = v.q.y;
    e.prevQ.z = v.q.z;
    e.prevQ.w = v.q.w;
    e.prevValid = true;
    const env = this.envAt(e, ut0);
    if (this.stepCount - e.sunStep >= SUN_REFRESH_STEPS) this.refreshSun(e, ut0);
    const must = v.hold !== null ? false : this.mustIntegrate(e, env);
    if (e.mode === 'rails' && must) {
      e.mode = 'integrated';
      e.orbit = null;
      e.railsEvent = null;
      e.coastTime = 0;
      if (isActive) this.patchesDirty = true;
    }
    const qStart = isActive && this.burn ? quat.clone(v.q) : null;
    const partsBefore = v.parts.length;
    const res = stepVessel(v, env, isActive ? this.controls : NEUTRAL_CONTROLS, dt);
    for (const ev of res.events) this.handleVesselEvent(e, ev);
    for (const s of res.spawned) this.adopt(s, e);
    if (v.parts.length !== partsBefore) {
      e.controllable = isControllable(v);
      this.stageInfoDirty = true;
    }
    if (v.destroyed || v.parts.length === 0) {
      const burned = res.events.some((x) => x.type === 'partDestroyed' && x.cause === 'overheat');
      this.removeEntry(e, burned ? 'burnedUp' : 'impact', utNew);
      return false;
    }
    if (e.mode === 'rails') {
      this.advanceOnRails(e, utNew);
    } else if (v.hold !== null) {
      e.mode = 'landed';
      e.coastTime = 0;
      e.forceIntegrate = false;
    } else {
      if (e.mode === 'landed') {
        e.mode = 'integrated';
        if (isActive) this.patchesDirty = true;
      }
      if (must) {
        e.coastTime = 0;
        if (e.forceIntegrate && vesselNeedsIntegration(v, env)) e.forceIntegrate = false;
      } else {
        e.coastTime += dt;
        if (e.coastTime >= COAST_TIME_TO_RAILS) {
          this.ut = utNew;
          this.toRails(e);
          this.ut = ut0;
        }
      }
    }
    if (isActive && this.burn && qStart && v.thrust > 0) {
      // dvRemaining -= a_thrust dt, with the thrust acceleration of this step in ROOT axes.
      const a = quat.rotate(qStart, v.properAccel);
      const b = this.burn.dvRemaining;
      b.x -= a.x * dt;
      b.y -= a.y * dt;
      b.z -= a.z * dt;
    }
    // Terrain data accounting: contact probes ran, or the vessel is in the terrain regime.
    if (v.hold === null && this.bases.get(e.bodyId)!.hasTerrain) {
      const st = structureOf(v);
      if (e.regime || v.groundClearance < 10 + 2 * st.boundingRadius) {
        const dirFixed = quat.rotateInv(env.qFixedToInertial, v3.normalize(v.r));
        if (!this.policy.isFinalAt(e.bodyId, dirFixed)) return true;
      }
    }
    return false;
  }

  private adopt(vessel: Vessel, parent: Entry): void {
    const e = this.newEntry(vessel, parent.bodyId);
    e.env.sunDir = parent.env.sunDir;
    e.env.sunVisibility = parent.env.sunVisibility;
    e.sunStep = parent.sunStep;
    this.entries.push(e);
    if (parent === this.active) this.separations.push(this.ut);
    this.stageInfoDirty = true;
  }

  private handleVesselEvent(e: Entry, ev: SimEvent): void {
    if (ev.type === 'explosion') this.eventBody.set(ev, e.bodyId);
    this.pushEvent(ev);
    const isActive = e === this.active;
    switch (ev.type) {
      case 'stageFired':
        this.stageInfoDirty = true;
        if (isActive) {
          this.milestones.noteStageFired(ev.stageIndex);
          this.stageFiredUt.set(ev.stageIndex, ev.ut);
        }
        break;
      case 'clampsReleased':
        if (isActive && this.liftoffUt === null) this.liftoffUt = ev.ut;
        break;
      case 'chuteDeployed':
        if (isActive) this.milestones.noteChuteDeployed(ev.mode, this.chuteDeployData(e.vessel, ev.mode));
        break;
      case 'crewLost':
        this.crewAlive = false;
        this.failMission(`Crew lost: ${ev.cause}`);
        break;
      case 'engineIgnition':
      case 'engineShutdown':
      case 'decoupled':
      case 'fairingJettisoned':
        this.stageInfoDirty = true;
        break;
      default:
        break;
    }
  }

  private chuteDeployData(v: Vessel, mode: 'drogue' | 'main'): Record<string, number> {
    const base = this.bases.get(this.active.bodyId)!;
    const altitude = v3.len(v.r) - base.info.radius - base.seaLevel;
    const speed = v3.len(v.aero.airVelocity);
    let worst = 0;
    for (const p of v.parts) {
      for (const md of p.def.modules) {
        if (md.type !== 'parachute' || md.mode !== mode) continue;
        const env = chuteEnvelope(md, altitude, v.aero.mach, speed, v.aero.q);
        worst = Math.max(worst, env === 'safe' ? 0 : env === 'risky' ? 1 : 2);
      }
    }
    return { chuteEnvelope: worst, deployAltitude: altitude, deployMach: reportedMach(v), deploySpeed: speed, deployDynamicPressure: v.aero.q };
  }

  private failMission(reason: string): void {
    if (this.missionFailed) return;
    this.missionFailed = true;
    this.failureReason = reason;
    this.pushEvent({ type: 'missionFailed', ut: this.ut, vesselId: this.active.vessel.id, reason });
  }

  private removeEntry(e: Entry, reason: DebrisFate['reason'], ut: number): void {
    if (e.removed) return;
    e.removed = true;
    const body = this.info(e.bodyId);
    const dirFixed = quat.rotateInv(this.orientAt(e.bodyId, ut), v3.normalize(e.vessel.r));
    const site = this.defs.sites[this.scenario.site]!;
    const launchedFrom = padLocationOf(site, this.startPad);
    const siteDir = dirFromLatLon(launchedFrom.latDeg * DEG, launchedFrom.lonDeg * DEG);
    this.fates.push({
      vesselId: e.vessel.id,
      name: e.vessel.name,
      ut,
      reason,
      bodyId: e.bodyId,
      latitudeDeg: Math.atan2(dirFixed.z, Math.hypot(dirFixed.x, dirFixed.y)) * RAD,
      longitudeDeg: Math.atan2(dirFixed.y, dirFixed.x) * RAD,
      distanceFromSite: site.bodyId === e.bodyId ? v3.angle(siteDir, dirFixed) * body.radius : -1,
    });
    this.pushEvent({ type: 'vesselRemoved', ut, vesselId: e.vessel.id, reason });
    this.policy.drop(`vessel:${e.vessel.id}`);
  }

  // ------------------------------------------------------------------------------- periodic upkeep

  /** Work done at step boundaries on the control-tick cadence: terrain triggers and collision warming. */
  private boundaryWork(): void {
    const a = this.active;
    // Impact disc of the active vessel.
    if (!a.removed && a.vessel.hold === null) {
      const marker = this.impactMarker();
      if (marker) {
        this.policy.track('impact', marker.bodyId, this.info(marker.bodyId).radius, dirFromLatLon(marker.latitude, marker.longitude), IMPACT_DISC_RADIUS, IMPACT_REFRESH_DISTANCE);
      }
    }
    for (const e of this.entries) {
      if (e.removed || e.tier !== 'full') continue;
      const base = this.bases.get(e.bodyId)!;
      if (!base.hasTerrain) {
        e.regime = false;
        continue;
      }
      const v = e.vessel;
      const rl = v3.len(v.r);
      const alt = rl - base.info.radius;
      let regime = false;
      let radar = Infinity;
      let dirFixed: Vec3 | null = null;
      const maxElevation = base.def.terrain!.maxElevation;
      if (alt < Math.max(SLOW_ALTITUDE, maxElevation + LOW_RADAR_ALTITUDE + 100)) {
        dirFixed = quat.rotateInv(this.orientAt(e.bodyId, this.ut), v3.scale(v.r, 1 / rl));
        if (v.hold !== null) {
          regime = true;
          radar = 0;
        } else {
          const sp = base.info.spin;
          const gx = v.v.x - (sp.y * v.r.z - sp.z * v.r.y);
          const gy = v.v.y - (sp.z * v.r.x - sp.x * v.r.z);
          const gz = v.v.z - (sp.x * v.r.y - sp.y * v.r.x);
          const ground = Math.hypot(gx, gy, gz);
          let surface = this.terrain.heightAt(e.bodyId, dirFixed, Math.max(0.3, 0.02 * Math.max(alt, 0)));
          if (base.def.ocean) surface = Math.max(surface, base.seaLevel);
          radar = alt - surface;
          regime = radar < LOW_RADAR_ALTITUDE || (alt < SLOW_ALTITUDE && ground < SLOW_GROUND_SPEED);
        }
      }
      e.regime = regime;
      if (regime && e.controllable && dirFixed) {
        this.policy.track(`vessel:${v.id}`, e.bodyId, base.info.radius, dirFixed, VESSEL_DISC_RADIUS, VESSEL_REFRESH_DISTANCE);
      }
      if (e === a && regime && dirFixed && v.hold === null && radar < PREWARM_RADAR_ALTITUDE) {
        this.terrain.prewarmCollision(e.bodyId, this.touchdownPoint(e, dirFixed, radar), Math.min(40, 12 + 0.02 * radar), PREWARM_BUDGET);
      }
    }
  }

  /** Body-fixed direction of where the active vessel is heading for the ground (short ballistic look-ahead). */
  private touchdownPoint(e: Entry, dirFixed: Vec3, radar: number): Vec3 {
    const v = e.vessel;
    const base = this.bases.get(e.bodyId)!;
    const sp = base.info.spin;
    const g = v3.sub(v.v, v3.cross(sp, v.r));
    const up = v3.normalize(v.r);
    const vz = v3.dot(g, up);
    const horiz = v3.reject(g, up);
    const t = vz < -0.5 ? Math.min(20, radar / -vz) : 0;
    if (t <= 0 || v3.len(horiz) < 0.05) return dirFixed;
    const ahead = quat.rotateInv(this.orientAt(e.bodyId, this.ut), v3.scale(horiz, t / base.info.radius));
    return v3.normalize(v3.add(dirFixed, ahead));
  }

  private impactMarker(): { bodyId: string; latitude: number; longitude: number } | null {
    for (const p of this.patches.current) {
      for (const m of p.markers) {
        if (m.kind === 'impact' && m.latitude !== undefined && m.longitude !== undefined) return { bodyId: p.bodyId, latitude: m.latitude, longitude: m.longitude };
      }
      if (p.endReason === 'atmosphere') return null;
    }
    return null;
  }

  /** Bookkeeping after a physics step (dt > 0) or a rails advance (dt = 0). */
  private afterAdvance(dt: number, controlTick: boolean): void {
    const a = this.active;
    if (!a.removed) {
      const v = a.vessel;
      const base = this.bases.get(a.bodyId)!;
      const rl = v3.len(v.r);
      // Altitude and vertical speed of the centre of mass (what the read-outs and the records show).
      const com = this.comState(a);
      const comRadius = v3.len(com.r);
      const alt = comRadius - base.info.radius;
      // navball auto switch
      this.navballMode = navballModeAfter(this.navballMode, this.prevNavAltitude, alt, base.def.navballSwitchAltitude);
      this.prevNavAltitude = alt;
      if (v.gLoad > this.peakG && v.hold === null) this.peakG = v.gLoad;
      if (v.gDose > this.peakGDose) this.peakGDose = v.gDose;
      // surface-relative velocity for the touchdown capture and the milestone frame
      const up = v3.scale(v.r, 1 / rl);
      const sp = base.info.spin;
      const gx = v.v.x - (sp.y * v.r.z - sp.z * v.r.y);
      const gy = v.v.y - (sp.z * v.r.x - sp.x * v.r.z);
      const gz = v.v.z - (sp.x * v.r.y - sp.y * v.r.x);
      const vz = gx * up.x + gy * up.y + gz * up.z;
      const touching = v.contact.anyContact || v.contact.waterSubmersion > 0;
      if (dt > 0) {
        if (!touching) {
          if (v.groundClearance < 200) {
            this.preContact.verticalSpeed = vz;
            this.preContact.horizontalSpeed = Math.hypot(gx - vz * up.x, gy - vz * up.y, gz - vz * up.z);
            this.preContact.tilt = v3.angle(quat.rotate(v.q, { x: 0, y: 1, z: 0 }), up);
          }
        } else if (!this.wasTouching && v.hold === null) {
          this.touchdown = { ...this.preContact };
        }
        this.wasTouching = touching;
      }
      this.updateBurn();
      // milestones
      const frame: MilestoneFrame = {
        ut: this.ut,
        vesselId: v.id,
        bodyId: a.bodyId,
        altitude: alt,
        verticalSpeed: v3.dot(com.v, com.r) / comRadius,
        dynamicPressure: v.aero.q,
        engineBurning: anyEngineBurning(v),
        prelaunch: v.hold === 'clamps',
        restingOnLand: v.hold === 'asleep' || v.hold === 'ground' || (v.surface === 'landed' && v.contact.anyContact && v.contact.waterSubmersion === 0),
        restingOnWater: v.surface === 'splashed',
        touching,
        nextStage: helmCraft(v).nextStage,
        stagePending: (idx: number) => helmCraft(v).pending.some((p) => p.stageIndex === idx),
      };
      if (controlTick || dt === 0) this.ensurePatches();
      this.milestones.observe(frame, this, controlTick || dt === 0);
      if (!v.crewAlive && structureOf(v).crew > 0) {
        this.crewAlive = false;
        this.failMission('Crew lost');
      }
    }
    if (controlTick || dt === 0) this.upkeep();
  }

  /** Control-tick cadence: SOI checks for integrated vessels, tiers, proximity, removals, mission state. */
  private upkeep(): void {
    const a = this.active;
    const ut = this.ut;
    // SOI transitions of integrated vessels.
    for (const e of this.entries) if (!e.removed && e.tier === 'full' && e.mode === 'integrated') this.checkSoiIntegrated(e);
    // Tiers by distance from the active vessel.
    const aRoot = v3.add(this.system.stateRoot(a.bodyId, ut).r, a.vessel.r);
    const rootCache = new Map<string, Vec3>();
    const bodyRoot = (id: string): Vec3 => {
      let r = rootCache.get(id);
      if (!r) {
        r = this.system.stateRoot(id, ut).r;
        rootCache.set(id, r);
      }
      return r;
    };
    for (const e of this.entries) {
      if (e.removed || e === a) continue;
      this.syncEntry(e);
      const v = e.vessel;
      const d = e.bodyId === a.bodyId ? v3.dist(v.r, a.vessel.r) : v3.dist(v3.add(bodyRoot(e.bodyId), v.r), aRoot);
      const busy = anyPending(v) || anyEngineBurning(v);
      const inside = d < (e.tier === 'full' ? BUBBLE_EXIT_RADIUS : BUBBLE_RADIUS) || (e.tier === 'full' && busy);
      if (inside) {
        if (e.tier !== 'full') {
          e.tier = 'full';
          e.prevValid = false;
          if (v.hold !== null) e.mode = 'landed';
          else if (e.orbit === null) {
            e.mode = 'integrated';
            e.coastTime = 0;
          }
        }
        continue;
      }
      if (e.tier === 'full') {
        if (v.hold !== null) {
          e.tier = 'rails';
          e.mode = 'landed';
        } else {
          const base = this.bases.get(e.bodyId)!;
          const alt = v3.len(v.r) - base.info.radius;
          const atm = base.def.atmosphere;
          if (atm && alt < atm.simTop) {
            e.tier = 'reduced';
            e.mode = 'integrated';
            e.orbit = null;
            e.railsEvent = null;
            e.reducedTick = this.clockTick;
          } else {
            if (e.orbit === null) this.toRails(e);
            e.tier = 'rails';
          }
        }
      }
    }
    // Proximity rule: free vessels close to each other stay integrated.
    const full = this.entries.filter((e) => !e.removed && e.tier === 'full' && e.vessel.hold === null);
    for (const e of full) e.nearOther = false;
    for (let i = 0; i < full.length; i++) {
      for (let j = i + 1; j < full.length; j++) {
        const p = full[i]!;
        const q = full[j]!;
        if (p.bodyId !== q.bodyId) continue;
        const gap = v3.dist(p.vessel.r, q.vessel.r) - structureOf(p.vessel).boundingRadius - structureOf(q.vessel).boundingRadius;
        if (gap < PROXIMITY_DISTANCE) {
          p.nearOther = true;
          q.nearOther = true;
        }
      }
    }
    // Small fragments expire; the debris cap removes the oldest vessel outside the bubble.
    let debris = 0;
    for (const e of this.entries) {
      if (e.removed || e === a || e.controllable) continue;
      debris++;
      if (e.vessel.mp.mass < FRAGMENT_MASS && e.vessel.age > FRAGMENT_LIFETIME) {
        this.removeEntry(e, 'expired', ut);
        debris--;
      }
    }
    while (debris > MAX_DEBRIS) {
      let oldest: Entry | null = null;
      for (const e of this.entries) {
        if (e.removed || e === a || e.controllable || e.tier === 'full') continue;
        if (!oldest || e.vessel.age > oldest.vessel.age) oldest = e;
      }
      if (!oldest) break;
      this.removeEntry(oldest, 'limit', ut);
      debris--;
    }
    if (this.entries.some((e) => e.removed)) this.compact();
    // Mission state: every command part lost.
    if (!this.missionFailed && !this.entries.some((e) => e.controllable)) this.failMission('Every command part was lost');
  }

  private compact(): void {
    const a = this.active;
    if (a.removed) {
      // Hand over to the nearest survivor: a controllable one first, else the heaviest piece.
      const alive = this.entries.filter((e) => !e.removed);
      let next: Entry | null = null;
      for (const e of alive) {
        if (!next) next = e;
        else if (e.controllable !== next.controllable) next = e.controllable ? e : next;
        else if (e.vessel.mp.mass > next.vessel.mp.mass) next = e;
      }
      if (next) {
        this.pushEvent({ type: 'activeVesselChanged', ut: this.ut, vesselId: next.vessel.id, previousVesselId: a.vessel.id });
        this.active = next;
        this.updateRenderRoot();
        next.tier = 'full';
        if (next.vessel.hold !== null) next.mode = 'landed';
        else if (next.orbit === null) next.mode = 'integrated';
        this.nodes = [];
        this.burn = null;
        this.patchesDirty = true;
        this.stageInfoDirty = true;
        this.wreck = null;
      } else if (!this.wreck) {
        this.wreck = this.wreckSnapshot(a);
      }
    }
    this.entries = this.entries.filter((e) => !e.removed);
  }

  private wreckSnapshot(e: Entry): VesselSnapshot {
    const v = e.vessel;
    const root = this.system.stateRoot(e.bodyId, this.ut);
    return {
      id: v.id,
      name: v.name,
      vehicleId: v.crafts[0]!.vehicleId,
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

  /** Bring a vessel that is not stepped every step (rails or reduced tier) to the current time. */
  private syncEntry(e: Entry): void {
    if (e.removed) return;
    if (e.tier === 'full') return;
    if (e.tier === 'reduced') {
      this.advanceReduced(e, this.ut);
      return;
    }
    if (e.vessel.hold !== null) rideBody(e.vessel, this.envAt(e, this.ut), 0);
    else this.advanceOnRails(e, this.ut);
  }

  // ------------------------------------------------------------------------------------ rails advance

  /**
   * Rails advance toward `targetUt`. The state lands on a whole tick: the first tick at or after the
   * requested instant, or the first tick at or after the next event when that comes earlier (the event
   * itself is processed at its own instant inside that tick). Returns the time reached.
   */
  advanceRails(targetUt: number): number {
    this.throwIfBroken();
    if (!(targetUt > this.ut)) return this.ut;
    this.advanceRailsToTick(ceilTick(targetUt));
    return this.ut;
  }

  private advanceRailsToTick(requestTick: number): void {
    if (!(requestTick > this.clockTick)) return;
    this.ensurePatches();
    this.refreshWarp();
    if (this.bubbleMustIntegrate()) return;
    let landing = requestTick;
    if (this.warpEvent) landing = Math.min(landing, ceilTick(this.warpEvent.ut));
    const bubbleEvent = this.bubbleEventUt();
    if (bubbleEvent < Infinity) landing = Math.min(landing, ceilTick(bubbleEvent));
    if (!(landing > this.clockTick)) {
      // An event is due: time can only move on by integrating.
      this.setWarpIndex(Math.min(this.warpIndex, MAX_PHYSICS_WARP_INDEX), 'event due');
      return;
    }
    const target = utOfTick(landing);
    this.boundaryWork();
    if (!this.railsWarpActive) this.enterRailsWarp();
    const dtAdvance = (landing - this.clockTick) * PHYSICS_DT;
    for (let k = 0; k < this.entries.length; k++) {
      const e = this.entries[k]!;
      if (e.removed) continue;
      const v = e.vessel;
      if (e.tier === 'reduced') {
        this.advanceReduced(e, target);
        continue;
      }
      if (v.hold !== null) {
        if (e.tier === 'full') {
          rideBody(v, this.envAt(e, target), 0);
          this.refreshSun(e, target);
        }
        continue;
      }
      if (e.tier === 'full' && e.orbit === null) this.toRails(e);
      if (e.tier === 'rails' && !(e.railsEvent && e.railsEvent.ut <= target)) continue;
      const holdBefore = e.trackHold ? this.sasHoldDirection(e) : null;
      // Attitude: frozen, tracking the SAS hold direction, or (still turning) carried on at its body rate.
      if (!e.trackHold && e.tier === 'full' && v3.len(v.w) > 0) {
        v.q = quat.normalize(quat.mul(v.q, quat.fromRotVec(v3.scale(v.w, dtAdvance))));
      }
      if (!this.advanceOnRails(e, target)) continue;
      if (e.tier === 'full') this.refreshSun(e, target);
      if (holdBefore) {
        const saved = this.ut;
        this.ut = target;
        const holdAfter = this.sasHoldDirection(e);
        this.ut = saved;
        if (holdAfter) {
          const com = this.comState(e);
          v.q = quat.normalize(quat.mul(quat.fromTo(holdBefore, holdAfter), v.q));
          this.setFromCom(e, com.r, com.v);
        }
      }
      e.prevValid = false;
    }
    this.clockTick = landing;
    this.ut = target;
    this.baseTick = landing;
    this.utBase = target;
    this.stepsSinceBase = 0;
    this.splitUt = NaN;
    this.stampAges();
    this.revision++;
    this.railsAdvances++;
    this.stepsSinceControl = 0;
    this.lag = 0;
    this.lastAdvanceOnRails = true;
    this.afterAdvance(0, true);
    this.touch();
  }

  /**
   * One frame of rails warp for the real-time loop: presentation time moves on by `seconds` and the state
   * lands on the first whole tick at or after it (the rest of that tick is the presentation lag, exactly as
   * after physics steps), or on the tick of the next event. False when no time could pass on rails (an event
   * is due).
   */
  private railsFrame(seconds: number): boolean {
    // Ticks from the state to the new presentation time (the state is ahead of the presentation by the lag).
    const ahead = (seconds - this.lag) * TICKS_PER_SECOND;
    if (ahead <= TICK_EPSILON) {
      this.lag = Math.max(0, this.lag - seconds);
      return true;
    }
    const n = Math.ceil(ahead - TICK_EPSILON);
    const before = this.clockTick;
    this.advanceRailsToTick(before + n);
    if (this.clockTick === before) return false;
    // Landed on the requested tick: the state leads the presentation by the rest of that tick. Stopped
    // earlier, on an event's tick: the presentation is at the state.
    this.lag = this.clockTick === before + n ? Math.max(0, (n - ahead) / TICKS_PER_SECOND) : 0;
    return true;
  }

  /** Earliest time a full-tier rails vessel must start integrating (atmosphere entry or impact). */
  private bubbleEventUt(): number {
    let t = Infinity;
    for (const e of this.entries) {
      if (e.removed || e.tier !== 'full' || !e.railsEvent) continue;
      if ((e.railsEvent.kind === 'atmosphere' || e.railsEvent.kind === 'impact') && e.railsEvent.ut < t) t = e.railsEvent.ut;
    }
    return t;
  }

  private enterRailsWarp(): void {
    this.railsWarpActive = true;
    for (const e of this.entries) {
      if (e.removed || e.tier !== 'full') continue;
      const v = e.vessel;
      e.trackHold = false;
      if (v.hold !== null) continue;
      const com = this.comState(e);
      if (e === this.active) {
        const dir = this.sasHoldDirection(e);
        if (dir && v.sas.enabled && v3.angle(quat.rotate(v.q, { x: 0, y: 1, z: 0 }), dir) < SAS_TRACK_ERROR) e.trackHold = true;
      }
      // Slow residual rates are stopped (frozen attitude); a vessel that is really turning keeps its rate.
      if (e.trackHold || v3.len(v.w) < ROTATION_WARP_LIMIT) {
        v.w.x = v.w.y = v.w.z = 0;
        this.setFromCom(e, com.r, com.v);
      }
    }
  }

  // ------------------------------------------------------------------------------------------ advance

  advance(realDt: number, onControlTick?: () => void): void {
    this.throwIfBroken();
    const dtReal = Number.isFinite(realDt) && realDt > 0 ? realDt : 0;
    this.ensurePatches();
    this.refreshWarp();
    // A control tick is due before every CONTROL_TICK_STEPS-th physics step and before each rails advance.
    let tickGiven = false;
    if (this.warpIndex > MAX_PHYSICS_WARP_INDEX) {
      onControlTick?.();
      tickGiven = true;
      this.ensurePatches();
      this.refreshWarp();
    }
    if (this.warpIndex > MAX_PHYSICS_WARP_INDEX) {
      if (dtReal === 0 || this.railsFrame(dtReal * warpFactor(this.warpIndex))) return;
      // No progress on rails (an event is due): the frame is spent in physics steps at the clamped level.
    }
    const factor = warpFactor(this.warpIndex);
    this.lag -= dtReal * factor;
    const maxSteps = MAX_STEPS_PER_FRAME_1X * factor;
    let n = 0;
    // (A remainder within rounding of a whole step is no step: 8 x 1/120 s must cover 4 x 1/60 s.)
    while (this.lag < -1e-12) {
      if (n >= maxSteps) {
        // Surplus is dropped (slow motion), never a bigger step.
        this.lag = 0;
        break;
      }
      if (this.stepsSinceControl % CONTROL_TICK_STEPS === 0) {
        if (!tickGiven) onControlTick?.();
        if (this.warpIndex > MAX_PHYSICS_WARP_INDEX) {
          // Rails warp was engaged in the control tick: the rest of this frame's time is spent on rails.
          this.ensurePatches();
          this.refreshWarp();
          if (this.warpIndex > MAX_PHYSICS_WARP_INDEX) {
            const owed = this.lag;
            this.lag = 0;
            if (this.railsFrame((-owed / factor) * warpFactor(this.warpIndex))) return;
            this.lag = owed;
          }
        }
      }
      tickGiven = false;
      this.step();
      this.lag += PHYSICS_DT;
      n++;
    }
    if (this.lag < 0) this.lag = 0;
  }

  // --------------------------------------------------------------------------------------------- warp

  private setWarpIndex(index: number, reason: string | null): void {
    const idx = Math.max(0, Math.min(WARP_LEVELS.length - 1, Math.round(index)));
    if (idx === this.warpIndex) return;
    this.warpIndex = idx;
    this.pushEvent({ type: 'warpChanged', ut: this.ut, vesselId: this.active.vessel.id, index: idx, factor: warpFactor(idx), reason });
    this.touch();
  }

  /** Recompute the highest allowed warp level, why, and the next warp-limiting event; step down if needed. */
  private refreshWarp(): void {
    if (this.warpStamp === this.stateSerial) return;
    const a = this.active;
    const v = a.vessel;
    let max = WARP_LEVELS.length - 1;
    let limitedBy: string | null = null;
    let event: WarpEvent | null = null;
    const base = this.bases.get(a.bodyId)!;
    if (a.removed) {
      max = MAX_PHYSICS_WARP_INDEX;
      limitedBy = 'No vessel';
    } else if (this.bubbleMustIntegrate()) {
      max = MAX_PHYSICS_WARP_INDEX;
      limitedBy = RAILS_REFUSED;
    } else if (v.hold === null && v3.len(v.w) > ROTATION_WARP_LIMIT && !this.railsWarpActive) {
      max = MAX_PHYSICS_WARP_INDEX;
      limitedBy = ROTATING_REFUSED;
    } else if (v.hold !== null) {
      // Landed: any level; the only events are node lead times.
      event = this.nodeEvent();
      const la = lookAheadWarpIndex(this.ut, event);
      if (la < max) {
        max = Math.max(la, MAX_PHYSICS_WARP_INDEX);
        limitedBy = 'Maneuver node ahead';
      }
    } else {
      const com = this.comState(a);
      const alt = v3.len(com.r) - base.info.radius;
      let idx = maxWarpIndexForAltitude(base.def, alt);
      if (idx < max) limitedBy = 'Altitude too low for a higher warp level';
      const nodes = this.nodes.map((node) => ({ node, burnTime: this.burnTimeFor(node) }));
      const alarms = this.altitudeAlarms(a, com);
      const eventFor = (level: number): WarpEvent | null =>
        nextWarpEvent({ system: this.system, ut: this.ut, bodyId: a.bodyId, r: com.r, v: com.v, patches: this.patches.current, nodes, warpIndex: level, alarms });
      // The look-ahead depends on the level: step down until a level is admissible. The crossing of a
      // level's own altitude-limit shell is an event for that level alone - the next level down has its
      // own, lower shell - so it costs one level; every other event bounds all levels alike.
      for (let guard = 0; guard < WARP_LEVELS.length && idx > MAX_PHYSICS_WARP_INDEX; guard++) {
        const ev = eventFor(idx);
        const la = lookAheadWarpIndex(this.ut, ev);
        if (la >= idx) break;
        idx = ev !== null && ev.kind === 'altitudeLimit' ? idx - 1 : Math.max(la, MAX_PHYSICS_WARP_INDEX);
        limitedBy = this.describeEvent(ev);
      }
      max = idx;
      event = eventFor(Math.min(this.warpIndex, max));
    }
    // Terrain rule: 1x below 300 m radar altitude until final data is resident.
    this.terrainClampActive = false;
    if (!a.removed && v.hold === null && base.hasTerrain && v.groundClearance < WARP_CLAMP_RADAR_ALTITUDE + structureOf(v).boundingRadius) {
      const env = this.envAt(a, this.ut);
      if (radarAltitude(v, env) < WARP_CLAMP_RADAR_ALTITUDE) {
        const dirFixed = quat.rotateInv(env.qFixedToInertial, v3.normalize(v.r));
        if (!this.policy.isFinalAt(a.bodyId, dirFixed)) {
          max = 0;
          limitedBy = 'Terrain data loading';
          this.terrainClampActive = true;
        }
      }
    }
    this.warpMax = max;
    this.warpLimitedBy = limitedBy;
    this.warpEvent = event;
    if (this.warpIndex > max) {
      if (this.terrainClampActive) this.terrainWarpClamps++;
      this.setWarpIndex(max, limitedBy);
    }
    this.warpStamp = this.stateSerial;
  }

  private describeEvent(ev: WarpEvent | null): string {
    if (!ev) return 'Event ahead';
    switch (ev.kind) {
      case 'soiChange':
        return 'Sphere of influence change ahead';
      case 'atmosphere':
        return 'Atmosphere entry ahead';
      case 'terrainProximity':
        return 'Terrain ahead';
      case 'impact':
        return 'Impact ahead';
      case 'node':
        return 'Maneuver node ahead';
      case 'altitudeLimit':
        return 'Altitude too low for this warp level';
      default:
        return 'Event ahead';
    }
  }

  private nodeEvent(): WarpEvent | null {
    let best: WarpEvent | null = null;
    for (const node of this.nodes) {
      if (node.ut <= this.ut) continue;
      const t = Math.max(this.ut, node.ut - (this.burnTimeFor(node) ?? 0) / 2 - 30);
      if (!best || t < best.ut) best = { ut: t, kind: 'node', nodeId: node.id };
    }
    return best;
  }

  /** Times at which an armed altitude-crossing rule would be passed on the current conic. */
  private altitudeAlarms(a: Entry, com: { r: Vec3; v: Vec3 }): number[] {
    const armed = this.milestones.armedAltitudes(a.bodyId);
    if (armed.length === 0) return [];
    const body = this.info(a.bodyId);
    const o = a.orbit ?? makeOrbit(a.bodyId, body.mu, com.r, com.v, this.ut);
    const out: number[] = [];
    for (const x of armed) {
      const t = nextRadiusCrossing(o, body.radius + x.altitude, x.direction === 'ascending' ? 1 : -1, this.ut);
      if (t !== null && Number.isFinite(t)) out.push(t);
    }
    return out;
  }

  get nextEventUt(): number {
    this.ensurePatches();
    this.refreshWarp();
    let t = this.warpEvent ? this.warpEvent.ut : Infinity;
    const b = this.bubbleEventUt();
    if (b < t) t = b;
    return t;
  }

  // ------------------------------------------------------------------------------------------- nodes

  private sortedNodes(): ManeuverNode[] {
    return this.nodes.slice().sort((x, y) => x.ut - y.ut || (x.id < y.id ? -1 : 1));
  }

  private burnEngine(): BurnEngine | null {
    const v = this.active.vessel;
    let thrust = 0;
    let mdot = 0;
    const add = (ids: readonly string[] | null): void => {
      for (const p of v.parts) {
        if (ids && !ids.includes(p.instanceId)) continue;
        for (let m = 0; m < p.modules.length; m++) {
          const md = p.def.modules[m]!;
          const ms = p.modules[m]!;
          if (md.type !== 'engine' || ms.type !== 'engine' || md.fixedBurn || ms.flameout) continue;
          if (ids === null && !ms.active) continue;
          thrust += md.thrustVac;
          mdot += md.thrustVac / (md.ispVac * G0);
        }
      }
    };
    add(null);
    let owner = -1;
    const craft = helmCraft(v);
    const stages = craft.vehicle.stages;
    if (thrust === 0) {
      for (let s = nextLiveStage(v); s < stages.length && thrust === 0; s++) {
        for (const act of stages[s]!.actions) if (act.kind === 'igniteEngines') add(act.parts);
        if (thrust > 0) owner = s;
      }
    }
    if (!(thrust > 0)) return null;
    const info = this.stageInfos();
    let available = 0;
    if (owner >= 0) available = info[owner]?.deltaVVac ?? 0;
    else {
      for (let s = Math.min(craft.nextStage, stages.length) - 1; s >= 0; s--) {
        if ((info[s]?.deltaVVac ?? 0) > 0) {
          available = info[s]!.deltaVVac;
          break;
        }
      }
    }
    return { mass: v.mp.mass, thrust, isp: thrust / (mdot * G0), availableDeltaV: available };
  }

  private nodeDv(node: ManeuverNode): Vec3 | null {
    const pre = stateOnPatches(this.patchItems.current, node.ut);
    if (!pre) return null;
    return nodeDeltaVInertial(node.dv, pre.r, pre.v);
  }

  private burnTimeFor(node: ManeuverNode): number | null {
    const engine = this.burnEngine();
    if (!engine) return null;
    const dv = this.burn && this.burn.nodeId === node.id ? v3.len(this.burn.dvRemaining) : Math.hypot(node.dv.prograde, node.dv.normal, node.dv.radial);
    const ve = engine.isp * G0;
    return ((engine.mass - engine.mass * Math.exp(-dv / ve)) * ve) / engine.thrust;
  }

  /** Node burn bookkeeping: lock the remaining delta-v vector when the burn nears, complete the node when it is flown. */
  private updateBurn(): void {
    const node = this.sortedNodes()[0];
    if (!node) {
      this.burn = null;
      return;
    }
    const v = this.active.vessel;
    if (this.burn && this.burn.nodeId !== node.id) this.burn = null;
    if (!this.burn) {
      const burnTime = this.burnTimeFor(node) ?? 0;
      const near = this.ut >= node.ut - burnTime / 2 - NODE_LOCK_LEAD;
      const throttled = v.throttle > 0 && v.thrust > 0 && Math.abs(node.ut - this.ut) < NODE_THROTTLE_WINDOW;
      if (!(near || throttled)) return;
      this.ensurePatches();
      const dv = this.nodeDv(node);
      if (!dv) {
        if (this.ut > node.ut) this.dropNode(node.id, false);
        return;
      }
      this.burn = { nodeId: node.id, dv0: v3.clone(dv), dvRemaining: dv };
    }
    const rem = this.burn.dvRemaining;
    const mag = v3.len(rem);
    if (mag < NODE_COMPLETE_DV || (v3.dot(rem, this.burn.dv0) < 0 && v.throttle === 0)) this.dropNode(node.id, true);
  }

  private dropNode(id: string, completed: boolean): void {
    const i = this.nodes.findIndex((n) => n.id === id);
    if (i < 0) return;
    this.nodes.splice(i, 1);
    if (this.burn && this.burn.nodeId === id) this.burn = null;
    if (completed) this.pushEvent({ type: 'nodeCompleted', ut: this.ut, vesselId: this.active.vessel.id, nodeId: id });
    const v = this.active.vessel;
    if (this.nodes.length === 0 && v.sas.mode === 'maneuver') setSasMode(v, 'stability');
    this.patchesDirty = true;
    this.warpStamp = -1;
    this.touch();
  }

  private nodeBurnReadout(): NodeBurnInfo | null {
    const node = this.sortedNodes()[0];
    if (!node) return null;
    let dv: Vec3 | null;
    if (this.burn && this.burn.nodeId === node.id) dv = this.burn.dvRemaining;
    else dv = this.nodeDv(node);
    if (!dv) return null;
    return nodeBurnInfo(node, dv, this.ut, this.burnEngine());
  }

  // --------------------------------------------------------------------------------------- prediction

  private ensurePatches(): void {
    if (!this.patchesDirty) return;
    this.patchesDirty = false;
    const a = this.active;
    if (a.removed || a.vessel.hold !== null) {
      this.patchItems = { current: [], planned: [] };
      this.patches = { current: [], planned: [] };
      return;
    }
    const s = this.comState(a);
    const p = predictPatchesWithOrbits(this.system, { bodyId: a.bodyId, r: s.r, v: s.v }, this.ut, this.nodes, { targetBodyId: this.targetBodyId, terrainHeight: this.coarseHeight });
    this.patchItems = p;
    this.patches = { current: p.current.map((x) => x.patch), planned: p.planned.map((x) => x.patch) };
    this.patchRefreshes++;
    // The SOI change predicted when the vessel last went on rails (for the "predicted vs actual" record):
    // any integrated interval (burn, staging impulse, RCS translation) makes the old prediction void.
    if (a.mode !== 'rails') this.soiPrediction = null;
    else {
      const first = this.patches.current[0];
      if (first && (first.endReason === 'soiEnter' || first.endReason === 'soiExit') && first.nextBodyId) {
        if (!this.soiPrediction || this.soiPrediction.from !== first.bodyId || this.soiPrediction.to !== first.nextBodyId) {
          this.soiPrediction = { from: first.bodyId, to: first.nextBodyId, ut: first.tEnd };
        }
      } else this.soiPrediction = null;
    }
    this.warpStamp = -1;
  }

  private stageInfos(): StageInfo[] {
    const a = this.active;
    if (this.stageInfoDirty || this.stageInfoStep !== this.stepCount - (this.stepCount % PATCH_REFRESH_STEPS)) {
      this.stageInfo = a.removed ? [] : stagingInfo(a.vessel, this.envAt(a, this.ut));
      this.stageInfoDirty = false;
      this.stageInfoStep = this.stepCount - (this.stepCount % PATCH_REFRESH_STEPS);
      // Full-throttle acceleration of every stage: what its thrust-to-weight ratio is at any gravity.
      const g = a.removed ? 1 : this.localGravity(a);
      this.stageAcceleration = this.stageInfo.map((s) => s.twr * g);
    }
    // The cache is refreshed by physics steps and by changes of the vehicle, neither of which happens on a
    // coast: delta-v, burn time and propellant do not change there, the local gravity does (a translunar
    // coast, a sphere-of-influence change on rails). The ratio is restated at the gravity of now on every
    // read (request flight-ui-8).
    if (!a.removed) {
      const g = this.localGravity(a);
      for (let i = 0; i < this.stageInfo.length; i++) this.stageInfo[i]!.twr = this.stageAcceleration[i]! / g;
    }
    return this.stageInfo;
  }
  private stageInfoStep = -1;
  private stageAcceleration: number[] = [];

  /** Gravitational acceleration of the SOI body at a vessel's origin, m/s^2 (what `stagingInfo` weighs a stage with). */
  private localGravity(e: Entry): number {
    const r = e.vessel.r;
    const rl2 = r.x * r.x + r.y * r.y + r.z * r.z;
    const radius = this.info(e.bodyId).radius;
    return this.info(e.bodyId).mu / (rl2 > 0 ? rl2 : radius * radius);
  }

  // ---------------------------------------------------------------------------------------------- SAS

  /** Unit direction (ROOT axes) that the vessel's SAS mode holds, or null for stability / nothing to hold. */
  private sasHoldDirection(e: Entry): Vec3 | null {
    const v = e.vessel;
    const mode = v.sas.mode;
    if (mode === 'stability') return null;
    if (mode === 'maneuver') {
      if (e !== this.active) return null;
      const node = this.sortedNodes()[0];
      if (!node) return null;
      const dv = this.burn && this.burn.nodeId === node.id ? this.burn.dvRemaining : this.nodeDv(node);
      return dv && v3.len(dv) > 1e-9 ? v3.normalize(dv) : null;
    }
    const base = this.bases.get(e.bodyId)!;
    const qf = this.orientAt(e.bodyId, this.ut);
    const enu = enuBasis(qf, v.r);
    const vel = this.navballMode === 'surface' ? v3.sub(v.v, v3.cross(base.info.spin, v.r)) : v.v;
    const d = flightDirections(v.r, vel, enu);
    switch (mode) {
      case 'prograde':
        return d.prograde;
      case 'retrograde':
        return v3.neg(d.prograde);
      case 'normal':
        return d.normal;
      case 'antinormal':
        return v3.neg(d.normal);
      case 'radialOut':
        return d.radialOut;
      case 'radialIn':
        return v3.neg(d.radialOut);
      default:
        return null;
    }
  }

  private updateSasHold(e: Entry): void {
    if (e.removed) return;
    const v = e.vessel;
    if (!v.sas.enabled || v.sas.mode === 'stability') {
      if (v.sas.holdDir !== null) setSasHoldDirection(v, null);
      return;
    }
    setSasHoldDirection(v, this.sasHoldDirection(e));
  }

  private sasModesAvailable(): SasMode[] {
    return this.nodes.length > 0 ? SAS_MODES.slice() : SAS_MODES.filter((m) => m !== 'maneuver');
  }

  // ----------------------------------------------------------------------------------------- commands

  setControls(inputs: ControlInputs): void {
    const c = cloneControls(inputs);
    const clampUnit = (x: number): number => (Number.isFinite(x) ? Math.max(-1, Math.min(1, x)) : 0);
    c.pitch = clampUnit(c.pitch);
    c.yaw = clampUnit(c.yaw);
    c.roll = clampUnit(c.roll);
    c.translate.x = clampUnit(c.translate.x);
    c.translate.y = clampUnit(c.translate.y);
    c.translate.z = clampUnit(c.translate.z);
    c.throttle = Number.isFinite(c.throttle) ? Math.max(0, Math.min(1, c.throttle)) : 0;
    const active = c.throttle > 0 || c.pitch !== 0 || c.yaw !== 0 || c.roll !== 0 || c.translate.x !== 0 || c.translate.y !== 0 || c.translate.z !== 0;
    if (active && this.warpIndex > MAX_PHYSICS_WARP_INDEX) this.setWarpIndex(0, 'Control input');
    const p = this.controls;
    if (p.throttle !== c.throttle || p.pitch !== c.pitch || p.yaw !== c.yaw || p.roll !== c.roll || p.translate.x !== c.translate.x || p.translate.y !== c.translate.y || p.translate.z !== c.translate.z) this.touch();
    this.controls = c;
  }

  private makeCommands(): PlayerCommands {
    const ok: CommandResult = { ok: true };
    const refuse = (reason: string): CommandResult => ({ ok: false, reason });
    const act = (): Entry | null => (this.active.removed ? null : this.active);
    return {
      stage: (): CommandResult => {
        const a = act();
        if (!a) return refuse('No vessel');
        if (this.warpIndex > MAX_PHYSICS_WARP_INDEX) this.setWarpIndex(0, 'Staging');
        const res = fireNextStage(a.vessel, this.envAt(a, this.ut));
        if (!res.ok) return refuse(res.reason ?? 'Staging refused');
        for (const ev of res.events) this.handleVesselEvent(a, ev);
        for (const s of res.spawned) this.adopt(s, a);
        this.afterStructureChange(a);
        return ok;
      },
      abort: (): CommandResult => {
        const a = act();
        if (!a) return refuse('No vessel');
        if (this.warpIndex > MAX_PHYSICS_WARP_INDEX) this.setWarpIndex(0, 'Abort');
        const res = abortVessel(a.vessel, this.envAt(a, this.ut));
        if (!res.ok) return refuse(res.reason ?? 'Abort refused');
        for (const ev of res.events) this.handleVesselEvent(a, ev);
        for (const s of res.spawned) this.adopt(s, a);
        this.afterStructureChange(a);
        return ok;
      },
      setSasEnabled: (on: boolean): CommandResult => {
        const a = act();
        if (!a) return refuse('No vessel');
        if (on && !structureOf(a.vessel).sasAvailable) return refuse('No SAS on this vessel');
        setSasEnabled(a.vessel, on);
        this.touch();
        return ok;
      },
      setSasMode: (mode: SasMode): CommandResult => {
        const a = act();
        if (!a) return refuse('No vessel');
        if (!SAS_MODES.includes(mode)) return refuse('Unknown SAS mode');
        if (mode === 'maneuver' && this.nodes.length === 0) return refuse('No maneuver node');
        setSasMode(a.vessel, mode);
        this.touch();
        return ok;
      },
      setRcsEnabled: (on: boolean): CommandResult => {
        const a = act();
        if (!a) return refuse('No vessel');
        setRcsEnabled(a.vessel, on);
        this.touch();
        return ok;
      },
      toggleLegs: (): CommandResult => {
        const a = act();
        if (!a) return refuse('No vessel');
        const evs = toggleLegs(a.vessel, this.ut);
        if (evs.length === 0) return refuse('No landing legs');
        for (const ev of evs) this.handleVesselEvent(a, ev);
        this.touch();
        return ok;
      },
      toggleLights: (): CommandResult => {
        const a = act();
        if (!a) return refuse('No vessel');
        setLights(a.vessel, !a.vessel.lightsOn);
        this.touch();
        return ok;
      },
      setFineControl: (on: boolean): CommandResult => {
        const a = act();
        if (!a) return refuse('No vessel');
        setFineControl(a.vessel, on);
        this.touch();
        return ok;
      },
      setNavballMode: (mode: NavballMode): CommandResult => {
        if (mode !== 'surface' && mode !== 'orbit') return refuse('Unknown navball mode');
        this.navballMode = mode;
        this.touch();
        return ok;
      },
      setWarpLevel: (index: number): CommandResult => {
        if (!Number.isFinite(index)) return refuse('Invalid warp level');
        const want = Math.max(0, Math.min(WARP_LEVELS.length - 1, Math.round(index)));
        if (want <= this.warpIndex) {
          this.setWarpIndex(want, null);
          return ok;
        }
        this.ensurePatches();
        this.warpStamp = -1;
        this.refreshWarp();
        const allowed = Math.min(want, this.warpMax);
        const reason = allowed < want ? (this.warpLimitedBy ?? 'Warp limited') : null;
        this.setWarpIndex(Math.max(allowed, this.warpIndex), reason);
        this.warpStamp = -1;
        if (allowed < want) return { ok: allowed > MAX_PHYSICS_WARP_INDEX || want <= MAX_PHYSICS_WARP_INDEX, reason: reason ?? undefined } as CommandResult;
        return ok;
      },
      addNode: (ut: number): string => {
        const id = `node-${++this.nodeSerial}`;
        this.nodes.push({ id, ut: Number.isFinite(ut) ? ut : this.ut, dv: { prograde: 0, normal: 0, radial: 0 } });
        this.patchesDirty = true;
        this.warpStamp = -1;
        this.touch();
        return id;
      },
      setNode: (id: string, edit: NodeEdit): CommandResult => {
        const node = this.nodes.find((n) => n.id === id);
        if (!node) return refuse('No such node');
        if (edit.ut !== undefined) {
          if (!Number.isFinite(edit.ut)) return refuse('Invalid node time');
          node.ut = edit.ut;
        }
        if (edit.dv) {
          for (const k of ['prograde', 'normal', 'radial'] as const) {
            const x = edit.dv[k];
            if (x !== undefined) {
              if (!Number.isFinite(x)) return refuse('Invalid delta-v');
              node.dv[k] = x;
            }
          }
        }
        if (this.burn && this.burn.nodeId === id) this.burn = null;
        this.patchesDirty = true;
        this.warpStamp = -1;
        this.touch();
        return ok;
      },
      removeNode: (id: string): CommandResult => {
        if (!this.nodes.some((n) => n.id === id)) return refuse('No such node');
        this.dropNode(id, false);
        return ok;
      },
      setTarget: (bodyId: string | null): CommandResult => {
        if (bodyId !== null && !this.defs.bodies[bodyId]) return refuse('Unknown body');
        this.targetBodyId = bodyId;
        this.patchesDirty = true;
        this.touch();
        return ok;
      },
      cycleActiveVessel: (direction: 1 | -1): CommandResult => {
        const list = this.entries.filter((e) => !e.removed && e.controllable && e.tier === 'full');
        const i = list.indexOf(this.active);
        if (list.length < 2 || i < 0) return refuse('No other controllable vessel in range');
        const next = list[(i + (direction === -1 ? list.length - 1 : 1)) % list.length]!;
        const prev = this.active;
        this.active = next;
        this.updateRenderRoot();
        this.nodes = [];
        this.burn = null;
        this.patchesDirty = true;
        this.stageInfoDirty = true;
        this.warpStamp = -1;
        this.pushEvent({ type: 'activeVesselChanged', ut: this.ut, vesselId: next.vessel.id, previousVesselId: prev.vessel.id });
        this.touch();
        return ok;
      },
    };
  }

  private afterStructureChange(a: Entry): void {
    a.controllable = isControllable(a.vessel);
    if (a.vessel.hold === null && a.mode === 'rails') {
      a.mode = 'integrated';
      a.orbit = null;
      a.railsEvent = null;
    }
    a.coastTime = 0;
    this.stageInfoDirty = true;
    this.patchesDirty = true;
    this.warpStamp = -1;
    this.touch();
  }

  // -------------------------------------------------------------------------------------------- debug

  private makeDebug(): SimDebug {
    return {
      setVesselState: (vesselId: string, bodyId: string, r: Vec3, v: Vec3): void => {
        const e = this.entries.find((x) => x.vessel.id === vesselId && !x.removed);
        if (!e || !this.defs.bodies[bodyId]) throw new Error('debug.setVesselState: unknown vessel or body');
        this.cheats++;
        e.bodyId = bodyId;
        e.vessel.r = v3.clone(r);
        e.vessel.v = v3.clone(v);
        if (e.vessel.hold !== 'clamps' && e.vessel.hold !== 'ground') {
          e.vessel.hold = null;
          e.vessel.surface = 'none';
        }
        e.vessel.anchor = null;
        e.mode = e.vessel.hold !== null ? 'landed' : 'integrated';
        e.orbit = null;
        e.railsEvent = null;
        e.coastTime = 0;
        e.prevValid = false;
        if (e.tier !== 'full') e.tier = 'full';
        e.revision++;
        if (e === this.active) this.updateRenderRoot();
        this.patchesDirty = true;
        this.warpStamp = -1;
        this.touch();
      },
      setResource: (vesselId: string, partInstanceId: string, resource: string, kg: number): void => {
        const e = this.entries.find((x) => x.vessel.id === vesselId && !x.removed);
        const part = e?.vessel.parts.find((p) => p.instanceId === partInstanceId);
        const k = part ? (part.def.resources ?? []).findIndex((x) => x.resource === resource) : -1;
        if (!e || !part || k < 0 || !Number.isFinite(kg) || kg < 0) throw new Error('debug.setResource: unknown vessel, part or resource');
        this.cheats++;
        part.resources[k] = kg;
        this.stageInfoDirty = true;
        this.touch();
      },
      setUt: (ut: number): void => {
        if (!Number.isFinite(ut)) throw new Error('debug.setUt: invalid time');
        this.cheats++;
        // The clock stays on the tick grid: the time is set to the whole tick nearest to the request.
        const tick = nearestTick(ut);
        const to = utOfTick(tick);
        const shiftTicks = tick - this.clockTick;
        const shift = to - this.ut;
        for (const e of this.entries) {
          if (e.orbit) {
            const s = propagate(e.orbit, this.ut);
            e.orbit = makeOrbit(e.bodyId, this.info(e.bodyId).mu, s.r, s.v, to);
            if (e.railsEvent) e.railsEvent = this.computeRailsEvent(e, to);
          }
          e.reducedTick += shiftTicks;
          e.bornTick += shiftTicks;
          e.prevValid = false;
        }
        for (const n of this.nodes) n.ut += shift;
        this.clockTick = tick;
        this.ut = to;
        this.baseTick = tick;
        this.utBase = to;
        this.stepsSinceBase = 0;
        this.splitUt = NaN;
        for (const e of this.entries) if (e.vessel.hold !== null) rideBody(e.vessel, this.envAt(e, to), 0);
        this.patchesDirty = true;
        this.warpStamp = -1;
        this.touch();
      },
    };
  }

  get cheatCounter(): number {
    return this.cheats;
  }

  terrainPending(): Promise<void> | null {
    return this.policy.pending();
  }

  // ---------------------------------------------------------------------------- milestone host

  standardData(): Record<string, number> {
    const a = this.active;
    const v = a.vessel;
    const env = this.envAt(a, this.ut);
    const base = this.bases.get(a.bodyId)!;
    const com = this.comState(a);
    const o = computeOrbitalReadouts({ system: this.system, bodyId: a.bodyId, r: com.r, v: com.v, ut: this.ut });
    const vr = vesselReadouts(v, env);
    const data: Record<string, number> = {
      ut: this.ut,
      met: this.liftoffUt === null ? 0 : this.ut - this.liftoffUt,
      altitude: o.altitudeAsl,
      radarAltitude: radarAltitude(v, env),
      latitudeDeg: o.latitude * RAD,
      longitudeDeg: o.longitude * RAD,
      speedOrbital: o.speedOrbital,
      speedSurface: o.speedSurface,
      verticalSpeed: o.verticalSpeed,
      horizontalSpeed: o.horizontalSpeed,
      mass: v.mp.mass,
      gLoad: v.gLoad,
      peakG: this.peakG,
      gDose: v.gDose,
      peakGDose: this.peakGDose,
      ablatorFraction: vr.ablatorFraction ?? -1,
      rcsFraction: vr.rcsFraction ?? -1,
      maxTempFraction: vr.maxTempFraction,
      deltaVRemaining: vr.deltaVTotal,
      stagesFired: helmCraft(v).nextStage,
      incompleteQueries: this.incompleteQueries,
      terrainWarpClamps: this.terrainWarpClamps,
      vesselCount: this.entries.length,
      surfaceGravity: base.surfaceGravity,
    };
    // Remaining propellant per stage group (engine propellants only).
    const excluded = new Set<string>();
    for (const p of v.parts) {
      for (const md of p.def.modules) {
        if (md.type === 'rcs') excluded.add(md.resource);
        if (md.type === 'heatShield') excluded.add(md.ablatorResource);
      }
    }
    const kg = new Map<string, number>();
    const cap = new Map<string, number>();
    for (const p of v.parts) {
      const res = p.def.resources ?? [];
      for (let k = 0; k < res.length; k++) {
        if (excluded.has(res[k]!.resource)) continue;
        kg.set(p.stageGroup, (kg.get(p.stageGroup) ?? 0) + p.resources[k]!);
        cap.set(p.stageGroup, (cap.get(p.stageGroup) ?? 0) + res[k]!.capacity);
      }
    }
    for (const [group, amount] of kg) {
      data[`propellantKg:${group}`] = amount;
      const c = cap.get(group)!;
      data[`propellantFraction:${group}`] = c > 0 ? amount / c : 0;
    }
    return data;
  }

  radarAltitude(): number {
    const a = this.active;
    return radarAltitude(a.vessel, this.envAt(a, this.ut));
  }

  orbit(): OrbitSummary {
    const a = this.active;
    const s = this.comState(a);
    const body = this.info(a.bodyId);
    const o = a.orbit ?? makeOrbit(a.bodyId, body.mu, s.r, s.v, this.ut);
    const c = o.conic;
    const rp = c.p / (1 + c.e);
    const closed = o.period !== null;
    return {
      closed,
      periapsisAltitude: rp - body.radius,
      apoapsisAltitude: closed ? 2 / o.alpha - rp - body.radius : Infinity,
      eccentricity: c.e,
      inclination: c.inc,
      period: o.period,
    };
  }

  currentPatches(): readonly Patch[] {
    this.ensurePatches();
    return this.patches.current;
  }

  bodyRadius(bodyId: string): number {
    return this.info(bodyId).radius;
  }

  touchdownData(): Record<string, number> {
    const a = this.active;
    const v = a.vessel;
    const body = this.info(a.bodyId);
    const env = this.envAt(a, this.ut);
    const up = v3.normalize(v.r);
    const dirFixed = quat.rotateInv(env.qFixedToInertial, up);
    let broken = 0;
    let legs = 0;
    for (const p of v.parts) {
      for (const m of p.modules) {
        if (m.type !== 'legs') continue;
        legs += m.broken.length;
        for (const b of m.broken) if (b) broken++;
      }
    }
    let landingDistance = -1;
    let zoneDistance = -1;
    let zoneRadius = -1;
    for (const t of this.surfaceTargets) {
      if (t.bodyId !== a.bodyId) continue;
      const d = greatCircle(dirFixed, targetDirection(t)).angle * body.radius;
      if (t.kind === 'landing' && (landingDistance < 0 || d < landingDistance)) landingDistance = d;
      // The nearest zone is the one whose edge is closest (inside counts as negative distance to the edge).
      if (t.kind === 'recovery' && (zoneDistance < 0 || d - t.radius < zoneDistance - zoneRadius)) {
        zoneDistance = d;
        zoneRadius = t.radius;
      }
    }
    const hasTerrain = this.bases.get(a.bodyId)!.hasTerrain;
    const res = hasTerrain ? this.terrain.residency(a.bodyId, dirFixed) : { residentLevel: 0, availableLevel: 0, effectiveLevel: 0, complete: true };
    const water = v.contact.waterSubmersion > 0 || v.surface === 'splashed' || (hasTerrain && env.surfaceKind(dirFixed) === 'water');
    return {
      touchdownVerticalSpeed: Math.abs(Math.min(0, this.touchdown.verticalSpeed)),
      touchdownHorizontalSpeed: this.touchdown.horizontalSpeed,
      touchdownTiltDeg: this.touchdown.tilt * RAD,
      tiltDeg: v3.angle(quat.rotate(v.q, { x: 0, y: 1, z: 0 }), up) * RAD,
      legs,
      legsBroken: broken,
      legsIntact: legs > 0 && broken === 0 ? 1 : 0,
      distanceToLandingTarget: landingDistance,
      residentLevel: res.residentLevel,
      availableLevel: res.availableLevel,
      effectiveLevel: res.effectiveLevel,
      terrainComplete: res.complete ? 1 : 0,
      surfaceWater: water ? 1 : 0,
      recoveryZoneDistance: zoneDistance,
      recoveryZoneRadius: zoneRadius,
      insideRecoveryZone: zoneDistance >= 0 && zoneDistance < zoneRadius ? 1 : 0,
      crewAlive: v.crewAlive ? 1 : 0,
    };
  }

  separatedSince(stageIndex: number): number {
    const t = this.stageFiredUt.get(stageIndex);
    if (t === undefined) return 0;
    let n = 0;
    for (const s of this.separations) if (s >= t - 1e-9) n++;
    return n;
  }

  vesselsLeftOnSurface(bodyId: string): number {
    const a = this.active;
    let n = 0;
    for (const e of this.entries) {
      if (e === a || e.removed || e.bodyId !== bodyId || e.vessel.hold === null) continue;
      this.syncEntry(e);
      if (v3.dist(e.vessel.r, a.vessel.r) < 5000) n++;
    }
    return n;
  }

  emit(record: MilestoneRecord): void {
    this.pushEvent({ type: 'milestone', ut: record.ut, vesselId: this.active.vessel.id, milestone: record });
  }

  // ------------------------------------------------------------------------------------------ snapshot

  private situationOf(e: Entry): VesselSituation {
    const v = e.vessel;
    const s = surfaceSituation(v);
    if (s !== null) return s;
    const base = this.bases.get(e.bodyId)!;
    const com = this.comState(e);
    const rl = v3.len(com.r);
    const atm = base.def.atmosphere;
    if (atm && rl - base.info.radius < atm.simTop) return 'flying';
    const o = e.orbit ?? makeOrbit(e.bodyId, base.info.mu, com.r, com.v, this.ut);
    const rp = o.conic.p / (1 + o.conic.e);
    if (o.period === null) return 'escaping';
    const ra = 2 / o.alpha - rp;
    if (base.info.soiRadius !== null && ra > base.info.soiRadius) return 'escaping';
    const floor = base.info.radius + (atm ? atm.simTop : base.def.terrain ? base.def.terrain.maxElevation : 0);
    return rp < floor ? 'suborbital' : 'orbiting';
  }

  private buildReadouts(a: Entry, env: WorldEnv): Readouts {
    const v = a.vessel;
    const base = this.bases.get(a.bodyId)!;
    // Orbital read-outs are those of the centre of mass (the point that follows the conic).
    const com = this.comState(a);
    const orbital = computeOrbitalReadouts({ system: this.system, bodyId: a.bodyId, r: com.r, v: com.v, ut: this.ut, targetBodyId: this.targetBodyId, patches: this.patches });
    const vr = vesselReadouts(v, env, this.stageInfos());
    const dirFixed = quat.rotateInv(env.qFixedToInertial, v3.normalize(v.r));
    let launchWindow: Readouts['launchWindow'] = null;
    if (v.hold !== null && a.bodyId === this.system.rootId && this.targetBodyId !== null && this.info(this.targetBodyId).parentId === a.bodyId) {
      launchWindow = launchWindowReadout({
        system: this.system,
        bodyId: a.bodyId,
        latitude: orbital.latitude,
        longitude: orbital.longitude,
        elevation: v3.len(v.r) - base.info.radius,
        ut: this.ut,
        targetBodyId: this.targetBodyId,
      });
    }
    const track = groundTrackDirection(this.system, a.bodyId, v.r, v.v, this.ut);
    return {
      met: this.liftoffUt === null ? 0 : Math.max(0, this.ut - this.liftoffUt),
      ...orbital,
      altitudeRadar: radarAltitude(v, env),
      ...vr,
      sasModesAvailable: this.sasModesAvailable(),
      launchWindow,
      nodeBurn: this.nodeBurnReadout(),
      landingTarget: computeLandingTargetReadout(this.surfaceTargets, a.bodyId, dirFixed, track, base.info.radius, this.patches.current),
    };
  }

  private build(presentation: boolean): SimSnapshot {
    this.ensurePatches();
    this.refreshWarp();
    const lag = presentation ? this.lag : 0;
    const utP = this.ut - lag;
    const alpha = 1 - lag / PHYSICS_DT;
    const bodies = this.system.buildBodySnapshots(utP);
    const bodyIndex = new Map<string, number>();
    // The render root: every ROOT position and velocity below is relative to the centre of `frameBody`.
    const shifted = this.frameBody !== this.system.rootId;
    const origin = shifted ? bodies.find((b) => b.id === this.frameBody)! : null;
    const originR = origin ? v3.clone(origin.rRoot) : null;
    const originV = origin ? v3.clone(origin.vRoot) : null;
    bodies.forEach((b, i) => {
      bodyIndex.set(b.id, i);
      // Orientation on the world clock (base + offset): the same rotation the physics and landed vessels use.
      b.qFixedToRoot = this.orient.at(b.id, this.utBase, this.stepsSinceBase * PHYSICS_DT - lag);
      if (originR && originV) {
        b.rRoot = v3.sub(b.rRoot, originR);
        b.vRoot = v3.sub(b.vRoot, originV);
      }
    });
    const a = this.active;
    const vessels: VesselSnapshot[] = [];
    for (const e of this.entries) {
      if (e.removed) continue;
      if (e.tier !== 'full') this.syncEntry(e);
      if (e.removed) continue;
      const v = e.vessel;
      const b = bodies[bodyIndex.get(e.bodyId)!]!;
      const snap = toVesselSnapshot(v, {
        bodyId: e.bodyId,
        tier: e.tier,
        situation: this.situationOf(e),
        translationMode: e.mode,
        rRoot: v3.add(b.rRoot, v.r),
        vRoot: v3.add(b.vRoot, v.v),
        sunVisibility: e.env.sunVisibility,
        stages: (craft: number) => this.stagesOf(e, craft),
        revision: e.revision,
      });
      if (lag > 0) {
        this.present(e, snap, utP, lag, alpha, b.rRoot, b.vRoot);
        snap.age = Math.max(0, snap.age - lag);
      }
      vessels.push(snap);
    }
    if (this.wreck && a.removed) {
      // The wreck's ROOT state is kept with the system's root body as origin: express it in this frame.
      vessels.push(originR && originV ? { ...this.wreck, rRoot: v3.sub(this.wreck.rRoot, originR), vRoot: v3.sub(this.wreck.vRoot, originV) } : this.wreck);
    }
    const env = this.envAt(a, this.ut);
    let readouts: Readouts;
    let navball;
    let stages: StageInfo[] = [];
    let nextStage = 0;
    let lockout = false;
    let complete = true;
    if (a.removed) {
      readouts = EMPTY_READOUTS(this.targetBodyId);
      navball = computeNavball({ mode: this.navballMode, q: a.vessel.q, r: a.vessel.r, v: a.vessel.v, qFixedToInertial: env.qFixedToInertial, spin: env.spin });
    } else {
      const v = a.vessel;
      readouts = this.buildReadouts(a, env);
      const node = this.sortedNodes()[0];
      const dv = node ? (this.burn && this.burn.nodeId === node.id ? this.burn.dvRemaining : this.nodeDv(node)) : null;
      let targetDir: Vec3 | null = null;
      if (this.targetBodyId !== null) {
        const tb = bodies[bodyIndex.get(this.targetBodyId)!]!;
        const ab = bodies[bodyIndex.get(a.bodyId)!]!;
        targetDir = v3.sub(tb.rRoot, v3.add(ab.rRoot, v.r));
      }
      navball = computeNavball({ mode: this.navballMode, q: v.q, r: v.r, v: v.v, qFixedToInertial: env.qFixedToInertial, spin: env.spin, maneuverDv: dv, targetDir, liftVectorVes: v.aero.liftDirVes });
      stages = this.stageInfos().map((s) => ({ ...s, actionKinds: s.actionKinds.slice() }));
      nextStage = nextLiveStage(v);
      lockout = helmCraft(v).stageLockout > 0;
      if (this.bases.get(a.bodyId)!.hasTerrain) {
        complete = this.policy.isFinalAt(a.bodyId, quat.rotateInv(env.qFixedToInertial, v3.normalize(v.r)));
      }
    }
    if (!this.eventsView) this.eventsView = this.events.map((ev) => this.eventInFrame(ev));
    const events = this.eventsView;
    // The frame: a rebase from the origin of the previous snapshot() while that is another epoch, and the
    // origins of the earlier epochs in this frame at this snapshot's time.
    const relative = (bodyId: string): FrameRebase => {
      const s = this.system.stateRelative(bodyId, this.frameBody, utP);
      return { offset: s.r, velocity: s.v };
    };
    const rebase = this.frameEpoch !== this.frameSeenEpoch ? relative(this.frameSeenBody) : null;
    const previous: FrameEpochOrigin[] = this.frameHistory.map((h) => ({ epoch: h.epoch, ...relative(h.bodyId) }));
    const rate = warpFactor(this.warpIndex);
    return {
      ut: utP,
      simUt: this.ut,
      tick: this.revision,
      revision: this.revision,
      frame: { epoch: this.frameEpoch, origin: { kind: 'body', bodyId: this.frameBody }, rebase, previous },
      // One private clock nobody else is on: the pilot's tick is the live tick.
      time: {
        myTick: this.clockTick,
        liveTick: this.clockTick,
        rate,
        maxRate: warpFactor(this.warpMax),
        limitedBy: this.warpLimitedBy === null ? null : { kind: this.warpLimitedBy.startsWith('Altitude') ? 'altitude' : this.warpMax <= MAX_PHYSICS_WARP_INDEX ? 'physics' : 'event', text: this.warpLimitedBy, vesselIds: [], accountIds: [] },
        relation: 'live',
        offset: 0,
        clockId: null,
        clockKind: 'private',
        members: [],
        proposals: [],
        offers: [],
      },
      warp: { index: this.warpIndex, factor: warpFactor(this.warpIndex), maxIndex: this.warpMax, limitedBy: this.warpLimitedBy, onRails: this.lastAdvanceOnRails },
      scenario: { id: this.scenario.id, startKind: this.scenario.start.kind, stagesAlreadyFired: this.scenario.stagesAlreadyFired },
      surfaceTargets: this.surfaceTargets.map((t) => ({ ...t })),
      terrain: { complete, pending: this.policy.pending() !== null, incompleteQueries: this.incompleteQueries },
      bodies,
      starId: this.system.starId,
      vessels,
      activeVesselId: a.vessel.id,
      appliedControls: cloneControls(a.vessel.appliedControls),
      navball,
      readouts,
      staging: { nextStage, stages, lockout },
      patches: this.patchesInFrame(),
      nodes: this.sortedNodes().map((n) => ({ id: n.id, ut: n.ut, dv: { ...n.dv } })),
      events,
      milestones: this.milestones.records.slice(),
      mission: { failed: this.missionFailed, failureReason: this.failureReason, crewAlive: this.crewAlive },
      cheatCounter: this.cheats,
    };
  }

  /** An event as the snapshot shows it: a ROOT position the vessel package produced in the BCI frame of its body is moved to the render root. */
  private eventInFrame(ev: SimEvent): SimEvent {
    if (ev.type !== 'explosion') return ev;
    const bodyId = this.eventBody.get(ev);
    if (bodyId === undefined || bodyId === this.frameBody) return ev;
    return { ...ev, posRoot: v3.add(ev.posRoot, this.system.stateRelative(bodyId, this.frameBody, ev.ut).r) };
  }

  /**
   * The predicted patches in the render root: `bodyPosAtEnd` is the position of the patch's body at the end
   * of the patch relative to where the frame's origin body is then (zero for a patch about the origin body).
   */
  private patchesInFrame(): { current: Patch[]; planned: Patch[] } {
    if (this.frameBody === this.system.rootId) return { current: this.patches.current, planned: this.patches.planned };
    const cache = this.shiftedPatches;
    if (cache && cache.source === this.patches && cache.bodyId === this.frameBody) return { current: cache.out.current, planned: cache.out.planned };
    const move = (p: Patch): Patch => ({ ...p, bodyPosAtEnd: p.bodyId === this.frameBody ? v3.zero() : this.system.stateRelative(p.bodyId, this.frameBody, p.tEnd).r });
    const out = { current: this.patches.current.map(move), planned: this.patches.planned.map(move) };
    this.shiftedPatches = { source: this.patches, bodyId: this.frameBody, out };
    return { current: out.current, planned: out.planned };
  }

  /**
   * Stage figures of one craft of a vessel for its craft block. The active vessel's helm craft has the
   * figures of the staging panel; any other craft with a command part aboard has its own, refreshed at the
   * same cadence; a craft nobody can fire (debris) lists none.
   */
  private stagesOf(e: Entry, craft: number): StageInfo[] {
    const v = e.vessel;
    if (e === this.active && craft === v.helm.craft) return this.stageInfos().map((s) => ({ ...s, actionKinds: s.actionKinds.slice() }));
    if (!v.parts.some((p) => p.craft === craft && p.command !== null)) return [];
    const record = v.crafts[craft]!;
    const bucket = this.stepCount - (this.stepCount % PATCH_REFRESH_STEPS);
    let c = this.craftStages.get(record);
    if (!c || c.step !== bucket || c.parts !== v.parts.length) {
      const infos = stagingInfo(v, this.envAt(e, this.ut), craft);
      const g = this.localGravity(e);
      c = { step: bucket, parts: v.parts.length, infos, acceleration: infos.map((s) => s.twr * g) };
      this.craftStages.set(record, c);
    }
    const g = this.localGravity(e);
    return c.infos.map((s, i) => ({ ...s, twr: c!.acceleration[i]! / g, actionKinds: s.actionKinds.slice() }));
  }

  /** Place a vessel snapshot at the presentation time utP = simUt - lag (alpha = fraction of the last step). */
  private present(e: Entry, snap: VesselSnapshot, utP: number, lag: number, alpha: number, bodyRoot: Vec3, bodyVel: Vec3): void {
    const v = e.vessel;
    if (v.hold !== null && v.anchor) {
      // Landed vessels ride the body: evaluate exactly at the presentation time.
      const qf = this.orient.at(e.bodyId, this.utBase, this.stepsSinceBase * PHYSICS_DT - lag);
      const sp = this.info(e.bodyId).spin;
      snap.r = quat.rotate(qf, v.anchor.rFixed);
      snap.v = v3.cross(sp, snap.r);
      snap.q = quat.normalize(quat.mul(qf, v.anchor.qFixed));
    } else if (e.orbit !== null) {
      // On rails: the conic at the presentation time. For a vessel that is kept current every step this is
      // taken back from the state at simUt over the (exactly known) lag along the conic's own acceleration
      // (error below 1e-8 m); `ut` itself resolves only 1.2e-7 s at this epoch, a millimetre at orbital speed.
      let s: { r: Vec3; v: Vec3 };
      if (e.tier === 'full') {
        const c = this.comState(e);
        const rl = v3.len(c.r);
        const g = v3.scale(c.r, -this.info(e.bodyId).mu / (rl * rl * rl));
        s = { r: v3.add(v3.addScaled(c.r, c.v, -lag), v3.scale(g, 0.5 * lag * lag)), v: v3.addScaled(c.v, g, -lag) };
      } else s = propagate(e.orbit, utP);
      if (e.tier === 'full' && e.prevValid) snap.q = quat.slerp(e.prevQ, v.q, alpha);
      const com = v.mp.com;
      snap.r = v3.sub(s.r, quat.rotate(snap.q, com));
      snap.v = v3.sub(s.v, quat.rotate(snap.q, v3.cross(v.w, com)));
    } else if (e.tier === 'full' && e.prevValid) {
      snap.r = v3.lerp(e.prevR, v.r, alpha);
      snap.v = v3.lerp(e.prevV, v.v, alpha);
      snap.q = quat.slerp(e.prevQ, v.q, alpha);
    } else if (e.tier === 'reduced') {
      snap.r = v3.addScaled(v.r, v.v, utP - utOfTick(e.reducedTick));
    } else return;
    snap.rRoot = v3.add(bodyRoot, snap.r);
    snap.vRoot = v3.add(bodyVel, snap.v);
  }

  snapshot(): SimSnapshot {
    const s = this.build(true);
    // The rebase is drained like the events: the next snapshot starts from this frame.
    this.frameSeenEpoch = this.frameEpoch;
    this.frameSeenBody = this.frameBody;
    this.events = [];
    this.eventsView = null;
    this.peekCache = null;
    return s;
  }

  peek(): SimSnapshot {
    if (this.peekCache && this.peekSerial === this.stateSerial && !this.patchesDirty) return this.peekCache;
    const s = this.build(false);
    this.peekCache = s;
    this.peekSerial = this.stateSerial;
    return s;
  }

  stateHash(): string {
    const h = new StateHasher();
    h.num(this.ut);
    h.num(this.revision);
    h.str(this.active.vessel.id);
    h.any([this.warpIndex, this.navballMode, this.targetBodyId ?? '', this.cheats, this.missionFailed, this.crewAlive, this.incompleteQueries]);
    for (const e of this.entries) {
      if (e.removed) continue;
      this.syncEntry(e);
      if (e.removed) continue;
      h.str(vesselStateHash(e.vessel));
      h.any([e.bodyId, e.mode, e.tier]);
    }
    h.any(this.sortedNodes().map((n) => [n.id, n.ut, n.dv.prograde, n.dv.normal, n.dv.radial]));
    h.any(this.burn ? [this.burn.nodeId, this.burn.dvRemaining.x, this.burn.dvRemaining.y, this.burn.dvRemaining.z] : null);
    h.any(this.milestones.stateForHash());
    h.any(this.fates.map((f) => [f.vesselId, f.ut, f.reason]));
    return h.hex();
  }

  // ---------------------------------------------------------------------------------------- diagnostics

  debrisLog(): readonly DebrisFate[] {
    return this.fates;
  }

  stats(): WorldStats {
    return { steps: this.stepCount, railsAdvances: this.railsAdvances, patchRefreshes: this.patchRefreshes, terrainRequests: this.policy.requests, terrainWarpClamps: this.terrainWarpClamps };
  }

  clearance(vesselIdA: string, vesselIdB: string): number | null {
    const p = this.entries.find((e) => e.vessel.id === vesselIdA && !e.removed);
    const q = this.entries.find((e) => e.vessel.id === vesselIdB && !e.removed);
    if (!p || !q || p.bodyId !== q.bodyId) return null;
    this.syncEntry(p);
    this.syncEntry(q);
    if (p.removed || q.removed) return null;
    return vesselClearance(p.vessel, q.vessel);
  }
}

const EMPTY_READOUTS = (targetBodyId: string | null): Readouts => ({
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
  targetBodyId,
  targetRelativeInclination: null,
  targetClosestApproach: null,
  launchWindow: null,
  nodeBurn: null,
  liftVectorUp: null,
  tiltFromVertical: 0,
  landingTarget: null,
});

/**
 * Create the session of scenario `scenarioId` of the definition library, on the given terrain authority:
 * the world orchestrator, which is the in-process session until `LocalSession` replaces it (MIGRATION_V2
 * step 4.3). `createSession` of src/session is this.
 */
export function createWorld(defs: DefLibrary, scenarioId: string, opts: CreateSimOptions): SimWorld {
  return new World(defs, scenarioId, opts);
}

/**
 * @deprecated Use `createSession` of src/session. The same session with the v1 render root: the origin of
 * every `...Root` field is the library's root body and never changes (`renderRoot: 'rootBody'`), so
 * presentation code that does not yet apply `SimSnapshot.frame.rebase` keeps working. The lead removes it
 * after the presentation sweep.
 */
export function createSim(defs: DefLibrary, scenarioId: string, opts: CreateSimOptions): SimWorld {
  return new World(defs, scenarioId, { renderRoot: 'rootBody', ...opts });
}
