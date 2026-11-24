/**
 * The single-clock host (docs/ARCHITECTURE.md 7.1; MIGRATION_V2 step 4.1a): what is left of v1's world
 * orchestrator. It owns the ONE pilot's active vessel, the warp ladder and island formation about that
 * vessel, and nothing else: the simulation is the island (src/sim/island), the objects of the clock outside
 * it are the far set (src/sim/island/far.ts), the presentation blocks are the view's (src/sim/view). It
 * contains no physics. `LocalSession` over `src/universe` replaces it (step 4.3).
 */
import { NEUTRAL_CONTROLS, type ControlInputs, type PlayerCommands } from '@/core/contracts/controls';
import { MAX_PHYSICS_WARP_INDEX, PHYSICS_DT, WARP_LEVELS, type DefLibrary, type ScenarioDef } from '@/core/contracts/defs';
import { DEFAULT_UNIVERSE_RULES, type UniverseRules } from '@/core/contracts/net';
import { CONTROL_TICK_STEPS, type MilestoneRecord, type Patch, type SimEvent, type SimSnapshot, type SurfaceTarget, type VesselSnapshot } from '@/core/contracts/sim';
import type { LocalSession, SessionDebug } from '@/core/contracts/session';
import type { VesselEnvironment } from '@/core/contracts/simInternal';
import type { TerrainProvider } from '@/core/contracts/terrain';
import { padLocationOf, padOf } from '@/core/defs/sites';
import { quat } from '@/core/math/quat';
import { DEG, RAD } from '@/core/math/scalar';
import { v3 } from '@/core/math/vec3';
import { createBodySystem, type BodySystem } from '../bodies/bodySystem';
import { ceilTick, TICK_EPSILON, TICKS_PER_SECOND, tickOfInstant, utOfTick } from '../clock';
import { dirFromLatLon } from '../frames/bodyFrames';
import { BodyFrames, comStateOf, createIsland, FarSet, IslandEnv, TerrainPolicy, type AddOptions, type AdvanceReport, type FarObject, type InputReceipt, type Island, type IslandInput } from '../island';
import { VESSEL_DISC_RADIUS, WARP_CLAMP_RADAR_ALTITUDE } from '../island/terrainPolicy';
import { buildSurfaceTargets } from '../nav/surfaceTargets';
import { nextRadiusCrossing } from '../orbit/events';
import { makeOrbit } from '../orbit/kepler';
import { warpFactor } from '../orbit/warp';
import { anyPending, helmCraft, radarAltitude, seededCraftIds, structureOf, vesselClearance, vesselStateHash, type CraftIdSource, type Vessel } from '../vessel';
import { anyEngineBurning } from '../vessel/modules/engine';
import { RenderRoot } from '../view/frame';
import { PATCH_REFRESH_STEPS, Planning, type PlanSubject } from '../view/planning';
import { buildSnapshot, privateClockView, StageFigures, wreckSnapshot, type ViewVessel } from '../view/snapshot';
import { makeCommands, makeDebug } from './commands';
import { MilestoneEvaluator, type MilestoneFrame, type MilestoneHost, type OrbitSummary } from './milestones';
import { FlightRecord } from './record';
import { placeStart, settleLanded } from './start';
import { StateHasher } from './stateHash';
import { WarpLadder } from './warpLadder';

/** Formation about the active vessel: a vessel joins the island inside the first distance and leaves it beyond the second, m. */
export const BUBBLE_RADIUS = 25000;
export const BUBBLE_EXIT_RADIUS = 27000;
export const MAX_DEBRIS = 24;
/** Uncontrollable fragments lighter than this (kg) expire after FRAGMENT_LIFETIME seconds (the rules' contact.fragmentMassLimit and fragmentLifetime). */
export const FRAGMENT_MASS = DEFAULT_UNIVERSE_RULES.contact.fragmentMassLimit;
export const FRAGMENT_LIFETIME = DEFAULT_UNIVERSE_RULES.contact.fragmentLifetime;
/** Physics steps per frame allowed at 1x (multiplied by the warp factor). */
export const MAX_STEPS_PER_FRAME_1X = 16;
/** Pending events kept for consumers that never drain the queue. */
export const MAX_PENDING_EVENTS = 1024;
/** The one pilot of this session. */
const PILOT = 'local';

type Stamp = 'tick' | 'accountId' | 'seq';
/** An input of the pilot without its stamp (the host stamps it for the clock's tick). */
export type PilotInput = { [K in IslandInput['kind']]: Omit<Extract<IslandInput, { kind: K }>, Stamp> }['controls' | 'reference' | 'command' | 'seat'];

export interface CreateSimOptions {
  terrain: TerrainProvider;
  /** Where craft ids come from (ARCHITECTURE section 3). Default: the local universe's seeded counter, so a session is reproducible. */
  ids?: CraftIdSource;
  /**
   * The render root of the snapshots (ARCHITECTURE section 3). 'soiBody' (the default, what `createSession`
   * gives): the origin of every `...Root` field is the centre of the active vessel's SOI body. 'rootBody':
   * the origin is the library's root body and is never replaced, for a tool that wants every ROOT position of
   * a whole flight about one body.
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

/** The session plus read-only diagnostics for tests and tools (not part of the contract). */
export interface SimWorld extends LocalSession {
  debrisLog(): readonly DebrisFate[];
  stats(): WorldStats;
  /** Clearance between the part envelopes of two vessels on the same body, m (null when unknown ids or different bodies). */
  clearance(vesselIdA: string, vesselIdB: string): number | null;
}

export class World implements SimWorld, MilestoneHost {
  readonly defs: DefLibrary;
  readonly scenario: ScenarioDef;
  readonly ready: Promise<void>;
  readonly commands: PlayerCommands;
  readonly debug: SessionDebug;
  readonly system: BodySystem;
  readonly frames: BodyFrames;
  readonly rules: UniverseRules;
  readonly policy: TerrainPolicy;
  readonly plan: Planning;
  readonly ladder: WarpLadder;
  readonly far: FarSet;
  island!: Island;

  private readonly terrain: TerrainProvider;
  private readonly surfaceTargets: SurfaceTarget[];
  private readonly milestones: MilestoneEvaluator;
  private readonly record: FlightRecord;
  private readonly root: RenderRoot;
  private readonly figures: StageFigures;
  private readonly ids: CraftIdSource;
  private readonly startPad: string;
  private readonly startCraftId: string;

  /** Every vessel of the session in the order it came into being (the order of the snapshot and of the state hash). */
  roster: Vessel[] = [];
  active!: Vessel;
  /** The active vessel was removed with nothing to take over: what it last was, and what is kept in view of it. */
  private lost: ViewVessel | null = null;
  private wreck: VesselSnapshot | null = null;
  private readonly lostEnv: IslandEnv;
  /** Vessels that are gone since the last control tick (they leave the roster there, as v1's entries did). */
  private readonly gone = new Set<Vessel>();

  revision = 0;
  stepCount = 0;
  /** Presentation lag behind the state, s in [0, PHYSICS_DT). */
  private lag = 0;
  private lastAdvanceOnRails = false;
  private railsWarpActive = false;
  private railsAdvances = 0;

  stateSerial = 0;
  warpStamp = -1;
  private mustStamp = -1;
  private mustCached = false;
  private peekCache: SimSnapshot | null = null;
  private peekSerial = -1;

  private events: SimEvent[] = [];
  private eventsView: SimEvent[] | null = null;
  missionFailed = false;
  private failureReason: string | null = null;
  private crewAlive = true;
  cheats = 0;
  private liftoffUt: number | null = null;
  private incompleteQueries = 0;
  private terrainWarpClamps = 0;
  private readonly fates: DebrisFate[] = [];

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
    this.rules = defs.rules?.['local'] ?? DEFAULT_UNIVERSE_RULES;
    this.system = createBodySystem(defs);
    this.frames = new BodyFrames(this.system, opts.terrain);
    this.policy = new TerrainPolicy(opts.terrain);
    this.surfaceTargets = buildSurfaceTargets(defs, scenario);
    this.milestones = new MilestoneEvaluator(scenario.milestones);
    this.record = new FlightRecord(this.frames, opts.terrain, this.surfaceTargets);
    this.plan = new Planning(this.frames);
    this.plan.targetBodyId = scenario.target && defs.bodies[scenario.target] ? scenario.target : null;
    this.plan.onPatches = () => {
      this.warpStamp = -1;
    };
    this.ladder = new WarpLadder(this.system);
    this.root = new RenderRoot(this.system, opts.renderRoot ?? 'soiBody');
    this.figures = new StageFigures(this.frames);
    this.far = new FarSet(this.frames, {
      event: (e) => this.pushEvent(e),
      removed: (o, reason, ut) => {
        this.gone.add(o.vessel);
        this.fate(o.vessel, o.bodyId, reason, ut, true);
      },
    });
    this.lostEnv = new IslandEnv(opts.terrain);
    this.ids = opts.ids ?? seededCraftIds();
    this.startCraftId = this.ids.next(scenario.vehicle);
    this.commands = makeCommands(this);
    this.debug = makeDebug(this);
    this.place(tickOfInstant(scenario.startUt, `scenarios/${scenarioId}.json: startUt`), false);
    this.ready = this.initialise();
    // A caller that never awaits `ready` still gets its errors through the next step.
    this.ready.catch(() => undefined);
  }

  // ------------------------------------------------------------------------------------------ helpers

  get tick(): number {
    return this.island.tick;
  }

  get ut(): number {
    return utOfTick(this.island.tick);
  }

  pushEvent(e: SimEvent): void {
    this.events.push(e);
    if (this.events.length > MAX_PENDING_EVENTS) this.events.splice(0, this.events.length - MAX_PENDING_EVENTS);
    this.eventsView = null;
  }

  touch(): void {
    this.stateSerial++;
  }

  /** The active vessel is a member of the island (false once it is gone). */
  get present(): boolean {
    return this.lost === null;
  }

  /** A vessel of the roster as the view reads it, brought to the clock's tick; null when it is gone. */
  entry(v: Vessel): ViewVessel | null {
    if (this.gone.has(v)) return null;
    const m = this.island.member(v.id);
    if (m && m.vessel === v) {
      return { vessel: v, bodyId: this.island.bodyId, tier: 'full', mode: m.mode === 'armed' ? 'rails' : m.mode, orbit: m.orbit, revision: m.revision, env: this.island.environmentOf(v.id)!, previous: m.previous, reducedTick: this.tick };
    }
    const o = this.far.find(v.id);
    if (!o || o.vessel !== v) return null;
    this.far.sync(o, this.tick);
    if (o.removed) return null;
    return { vessel: v, bodyId: o.bodyId, tier: o.tier, mode: v.hold !== null ? 'landed' : o.tier === 'reduced' ? 'integrated' : 'rails', orbit: o.orbit, revision: o.revision, env: this.frames.aim(o.env, o.bodyId, v.r, this.ut), previous: null, reducedTick: o.reducedTick };
  }

  /** The active vessel as the view reads it (what it last was once it is gone). */
  focus(): ViewVessel {
    return this.lost ?? this.entry(this.active)!;
  }

  subject(): PlanSubject {
    const a = this.focus();
    return { present: this.present, vessel: a.vessel, bodyId: a.bodyId, onRails: a.mode === 'rails', com: comStateOf(a.vessel), ut: this.ut, stepCount: this.stepCount, env: () => this.envOf(a) };
  }

  private envOf(e: ViewVessel): VesselEnvironment {
    if (e === this.lost) return this.frames.aim(this.lostEnv, e.bodyId, e.vessel.r, this.ut);
    if (this.island.member(e.vessel.id)?.vessel === e.vessel) return this.island.environmentOf(e.vessel.id)!;
    const o = this.far.find(e.vessel.id);
    return o ? this.frames.aim(o.env, o.bodyId, e.vessel.r, this.ut) : e.env;
  }

  /** Give the pilot's seat an input stamped now (applied at once). */
  input(i: PilotInput): InputReceipt {
    return this.island.applyInput({ ...i, tick: this.tick, accountId: PILOT, seq: 0 });
  }

  /** The cached command-authority flag of a vessel, as the island or the far set keeps it. */
  controllable(v: Vessel): boolean {
    return this.island.member(v.id)?.controllable ?? this.far.find(v.id)?.controllable ?? false;
  }

  private throwIfBroken(): void {
    if (this.policy.error !== null) {
      const e = this.policy.error;
      throw e instanceof Error ? e : new Error(String(e));
    }
  }

  // ------------------------------------------------------------------------------------- start state

  /** Build the scenario vessel and an island about it at `tick`. `final` = terrain under the start point is resident. */
  private place(tick: number, final: boolean): void {
    const sc = this.scenario;
    const placed = placeStart(this.defs, this.frames, sc, this.startPad, { craftId: this.startCraftId, ids: this.ids }, tick, final);
    if (final) settleLanded(this.frames, sc, placed, tick);
    this.island = createIsland({ defs: this.defs, system: this.system, terrain: this.terrain, rules: this.rules, policy: this.policy }, { id: 'local', tick, bodyId: placed.bodyId });
    this.island.add(placed.vessel, { pilot: PILOT, attended: true });
    this.roster = [placed.vessel];
    this.orderOf(placed.vessel);
    this.active = placed.vessel;
    this.lost = null;
    const alt = v3.len(placed.vessel.r) - this.frames.info(placed.bodyId).radius;
    this.plan.resetNavball(alt, this.frames.info(placed.bodyId).def.navballSwitchAltitude);
    this.sendReference();
    if (sc.start.kind !== 'pad') this.liftoffUt = sc.startUt;
    // The first frame of a session has its origin at the start vessel's SOI body: no epoch before it.
    this.root.reset(placed.bodyId);
  }

  private async initialise(): Promise<void> {
    const sc = this.scenario;
    const bodyId = this.island.bodyId;
    const base = this.frames.base(bodyId);
    if (base.hasTerrain) {
      const dirFixed = quat.rotateInv(this.frames.orientAt(bodyId, this.ut), v3.normalize(this.active.r));
      const alt = v3.len(this.active.r) - base.info.radius;
      if (sc.start.kind === 'pad') {
        const site = this.defs.sites[sc.site]!;
        await this.policy.request('pad', bodyId, base.info.radius, dirFixed, padOf(site, this.startPad).blendRadius + 600);
      } else if (sc.start.kind === 'landed' || alt < this.rules.terrain.requestAltitude) {
        await this.policy.request(`vessel:${this.active.id}`, bodyId, base.info.radius, dirFixed, VESSEL_DISC_RADIUS);
      }
    }
    const waiting = this.policy.pending();
    if (waiting) await waiting;
    if (sc.start.kind === 'pad' || sc.start.kind === 'landed') {
      // Re-place on the final surface (pad elevation 'terrain' resolved; the landed vessel set down).
      this.place(this.tick, true);
      const a = this.active;
      if (this.frames.base(this.island.bodyId).hasTerrain) {
        const dirFixed = quat.rotateInv(this.frames.orientAt(this.island.bodyId, this.ut), v3.normalize(a.r));
        const radius = Math.max(8, structureOf(a).boundingRadius * 0.25 + 3);
        for (let guard = 0; guard < 4096; guard++) if (this.terrain.prewarmCollision(this.island.bodyId, dirFixed, radius, 4096) === 0) break;
      }
    }
    for (const v of this.roster) this.island.settle(v.id);
    this.plan.patchesDirty = true;
    this.plan.stageInfoDirty = true;
    this.warpStamp = -1;
    this.mustStamp = -1;
    this.stampAges();
    this.events.length = 0;
    this.eventsView = null;
    this.touch();
  }

  private stampAges(): void {
    this.far.stampAges(this.tick);
  }

  // -------------------------------------------------------------------------------------- the pilot

  /** The hold direction of the 'maneuver' SAS mode reaches the island with the pilot's controls. */
  private sendHold(): void {
    if (!this.present) return;
    const seat = this.island.seatOf(PILOT);
    if (!seat) return;
    const hold = this.active.sas.mode === 'maneuver' ? this.plan.maneuverHold() : null;
    if (hold === null && seat.sasHold === null) return;
    this.input({ kind: 'controls', vesselId: this.active.id, controls: seat.controls, sasHold: hold });
  }

  /** The velocity the pilot's holds refer to follows the navball's mode. */
  sendReference(): void {
    if (!this.present) return;
    const reference = this.plan.navballMode === 'surface' ? 'surface' : 'orbit';
    if (this.island.seatOf(PILOT)?.reference !== reference) this.input({ kind: 'reference', vesselId: this.active.id, reference });
  }

  setControls(inputs: ControlInputs): void {
    const before = this.island.seatOf(PILOT)?.controls ?? NEUTRAL_CONTROLS;
    const p = { ...before, translate: { ...before.translate } };
    const c = inputs;
    const live = (x: number): boolean => Number.isFinite(x) && x !== 0;
    const active = (Number.isFinite(c.throttle) && c.throttle > 0) || live(c.pitch) || live(c.yaw) || live(c.roll) || live(c.translate.x) || live(c.translate.y) || live(c.translate.z);
    if (active && this.ladder.index > MAX_PHYSICS_WARP_INDEX) this.setWarpIndex(0, 'Control input');
    if (!this.present) return;
    this.input({ kind: 'controls', vesselId: this.active.id, controls: inputs, sasHold: this.island.seatOf(PILOT)?.sasHold ?? null });
    const n = this.island.seatOf(PILOT)!.controls;
    if (p.throttle !== n.throttle || p.pitch !== n.pitch || p.yaw !== n.yaw || p.roll !== n.roll || p.translate.x !== n.translate.x || p.translate.y !== n.translate.y || p.translate.z !== n.translate.z) this.touch();
  }

  /** Move the pilot to another vessel: the plan is the old vessel's and is forgotten. */
  takeVessel(next: Vessel): void {
    const prev = this.active;
    if (this.present) this.input({ kind: 'seat', vesselId: prev.id, aboard: false });
    this.active = next;
    this.lost = null;
    this.wreck = null;
    // A vessel outside the island (the one that takes over when the pilot's is lost): the island forms about it.
    if (!this.island.member(next.id)) this.form();
    this.input({ kind: 'seat', vesselId: next.id, aboard: true });
    this.sendReference();
    this.followRoot();
    this.plan.clear();
    this.warpStamp = -1;
    this.pushEvent({ type: 'activeVesselChanged', ut: this.ut, vesselId: next.id, previousVesselId: prev.id });
    this.touch();
  }

  private followRoot(): void {
    if (this.root.follow(this.focus().bodyId)) this.touch();
  }

  /**
   * Replace the island by one at `tick` about `bodyId` with the given members (the debug interface's teleport
   * and time jump: nothing in a flight does this). The pilot's seat goes with the active vessel.
   */
  reseat(tick: number, bodyId: string, members: { vessel: Vessel; options: AddOptions }[]): void {
    const seat = this.island.seatOf(PILOT);
    this.island = createIsland({ defs: this.defs, system: this.system, terrain: this.terrain, rules: this.rules, policy: this.policy }, { id: 'local', tick, bodyId });
    for (const m of members) this.island.add(m.vessel, m.options);
    if (!this.present || !this.island.member(this.active.id)) return;
    this.input({ kind: 'seat', vesselId: this.active.id, aboard: true });
    if (seat) this.input({ kind: 'controls', vesselId: this.active.id, controls: seat.controls, sasHold: seat.sasHold });
    this.sendReference();
    this.followRoot();
  }

  // ---------------------------------------------------------------------------------------- stepping

  get needsIntegration(): boolean {
    return this.mustIntegrate();
  }

  /** True when any member of the island must be integrated. */
  mustIntegrate(): boolean {
    if (this.mustStamp === this.stateSerial) return this.mustCached;
    this.mustStamp = this.stateSerial;
    this.mustCached = this.island.mustIntegrate();
    return this.mustCached;
  }

  ensurePatches(): void {
    this.plan.ensurePatches(this.subject());
  }

  /** The terrain disc at the predicted impact point of the active vessel (the island does the rest of the terrain work itself). */
  private hintImpact(): void {
    if (!this.present || this.active.hold !== null) return;
    const marker = this.plan.impactMarker();
    if (marker) this.island.hintImpact(this.active.id, marker);
  }

  step(): void {
    this.throwIfBroken();
    this.ensurePatches();
    if (this.tick % CONTROL_TICK_STEPS === 0) this.hintImpact();
    this.sendHold();
    const ut0 = this.ut;
    const qStart = this.present && this.plan.burn ? quat.clone(this.active.q) : null;
    const report = this.island.step();
    this.far.step(this.tick);
    this.absorb(report, ut0);
    if (qStart && this.present && this.active.thrust > 0) this.plan.burnStep(quat.rotate(qStart, this.active.properAccel), PHYSICS_DT);
    if (report.incompleteTerrain) this.incompleteQueries++;
    this.stampAges();
    this.revision++;
    this.stepCount++;
    this.lastAdvanceOnRails = false;
    this.railsWarpActive = false;
    this.afterAdvance(PHYSICS_DT, this.tick % CONTROL_TICK_STEPS === 0);
    if (this.focus().mode !== 'rails' && this.stepCount % PATCH_REFRESH_STEPS === 0) this.plan.patchesDirty = true;
    this.touch();
  }

  /** What an advance of the island did, as the session sees it: events, new vessels, lost vessels, a new frame. */
  absorb(report: AdvanceReport, ut0: number): void {
    const activeId = this.active.id;
    for (const ev of report.events) this.noteEvent(ev, this.island.bodyId, ev.vesselId === activeId);
    for (const a of report.arrivals) {
      const m = this.island.member(a.vesselId);
      if (!m || this.roster.includes(m.vessel)) continue;
      this.roster.push(m.vessel);
      this.orderOf(m.vessel);
      if (a.fromVesselId === activeId) this.record.separations.push(ut0);
      this.plan.stageInfoDirty = true;
    }
    for (const d of report.departures) {
      if (d.reason === 'burnedUp' || d.reason === 'impact') this.fate(d.vessel, d.bodyId, d.reason, d.ut, false);
      this.gone.add(d.vessel);
      if (d.vessel === this.active) {
        this.lostEnv.sunDir = d.vessel.sun.dir;
        this.lostEnv.sunVisibility = d.vessel.sun.visibility;
        this.lost = { vessel: d.vessel, bodyId: d.bodyId, tier: 'full', mode: 'integrated', orbit: null, revision: d.revision, env: this.frames.aim(this.lostEnv, d.bodyId, d.vessel.r, this.ut), previous: null, reducedTick: this.tick };
      }
    }
    if (report.replan.includes(activeId)) this.plan.patchesDirty = true;
    if (report.frameChange && this.present) {
      const f = report.frameChange;
      this.followRoot();
      const pred = this.plan.soiPrediction && this.plan.soiPrediction.from === f.fromBodyId && this.plan.soiPrediction.to === f.toBodyId ? this.plan.soiPrediction.ut : null;
      if (f.fromBodyId !== f.toBodyId) this.milestones.noteSoiChange(f.fromBodyId, f.toBodyId, this.frames.info(f.toBodyId).parentId === f.fromBodyId, f.ut, pred);
      this.plan.soiPrediction = null;
      this.plan.patchesDirty = true;
      const alt = v3.len(this.active.r) - this.frames.info(f.toBodyId).radius;
      this.plan.resetNavball(Math.max(alt, 0), this.frames.info(f.toBodyId).def.navballSwitchAltitude);
      this.plan.prevNavAltitude = alt;
      this.sendReference();
      this.warpStamp = -1;
    }
  }

  /** An event of a vessel: into the queue, and what the session keeps of it. */
  noteEvent(ev: SimEvent, bodyId: string, isActive: boolean): void {
    this.root.noteEvent(ev, bodyId);
    this.pushEvent(ev);
    switch (ev.type) {
      case 'stageFired':
        this.plan.stageInfoDirty = true;
        if (isActive) {
          this.milestones.noteStageFired(ev.stageIndex);
          this.record.stageFiredUt.set(ev.stageIndex, ev.ut);
        }
        break;
      case 'clampsReleased':
        if (isActive && this.liftoffUt === null) this.liftoffUt = ev.ut;
        break;
      case 'chuteDeployed':
        if (isActive) this.milestones.noteChuteDeployed(ev.mode, this.record.chuteDeployData(this.active, this.focus().bodyId, ev.mode));
        break;
      case 'crewLost':
        this.crewAlive = false;
        this.failMission(`Crew lost: ${ev.cause}`);
        break;
      case 'engineIgnition':
      case 'engineShutdown':
      case 'decoupled':
      case 'fairingJettisoned':
      case 'partDestroyed':
        // (A destroyed part changes the part set, as a separation does: the stage figures are stale.)
        this.plan.stageInfoDirty = true;
        break;
      default:
        break;
    }
  }

  private failMission(reason: string): void {
    if (this.missionFailed) return;
    this.missionFailed = true;
    this.failureReason = reason;
    this.pushEvent({ type: 'missionFailed', ut: this.ut, vesselId: this.active.id, reason });
  }

  /** The record of a vessel that is gone. `announce`: the removal has no event yet. */
  private fate(v: Vessel, bodyId: string, reason: DebrisFate['reason'], ut: number, announce: boolean): void {
    const body = this.frames.info(bodyId);
    const dirFixed = quat.rotateInv(this.frames.orientAt(bodyId, ut), v3.normalize(v.r));
    const site = this.defs.sites[this.scenario.site]!;
    const launchedFrom = padLocationOf(site, this.startPad);
    const siteDir = dirFromLatLon(launchedFrom.latDeg * DEG, launchedFrom.lonDeg * DEG);
    this.fates.push({
      vesselId: v.id,
      name: v.name,
      ut,
      reason,
      bodyId,
      latitudeDeg: Math.atan2(dirFixed.z, Math.hypot(dirFixed.x, dirFixed.y)) * RAD,
      longitudeDeg: Math.atan2(dirFixed.y, dirFixed.x) * RAD,
      distanceFromSite: site.bodyId === bodyId ? v3.angle(siteDir, dirFixed) * body.radius : -1,
    });
    if (announce) this.pushEvent({ type: 'vesselRemoved', ut, vesselId: v.id, reason });
    this.policy.drop(`vessel:${v.id}`);
  }

  /** Bookkeeping after a physics step (dt > 0) or a rails advance (dt = 0). */
  private afterAdvance(dt: number, controlTick: boolean): void {
    if (this.present) {
      const a = this.focus();
      const v = a.vessel;
      const base = this.frames.base(a.bodyId);
      // Altitude and vertical speed of the centre of mass (what the read-outs and the records show).
      const com = comStateOf(v);
      const comRadius = v3.len(com.r);
      const alt = comRadius - base.info.radius;
      this.plan.followAltitude(alt, base.def.navballSwitchAltitude);
      this.sendReference();
      const touching = this.record.observe(v, a.bodyId, dt);
      const dropped = this.plan.updateBurn(this.subject());
      if (dropped) this.dropNode(dropped.id, dropped.completed);
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

  /** Remove a node: the event of a flown one, the SAS mode that has nothing left to hold. */
  dropNode(id: string, completed: boolean): void {
    if (!this.plan.dropNode(id)) return;
    if (completed) this.pushEvent({ type: 'nodeCompleted', ut: this.ut, vesselId: this.active.id, nodeId: id });
    if (this.plan.nodes.length === 0 && this.present && this.active.sas.mode === 'maneuver') this.input({ kind: 'command', vesselId: this.active.id, command: { kind: 'sasMode', mode: 'stability' } });
    this.warpStamp = -1;
    this.touch();
  }

  // -------------------------------------------------------------------------------------- formation

  /** Control-tick cadence: island formation about the active vessel, the debris rules, the hand-over of the pilot, the mission state. */
  private upkeep(): void {
    this.form();
    // Small fragments expire; the debris cap removes the oldest vessel outside the island.
    const contact = this.rules.contact;
    let debris = 0;
    for (const v of this.roster.slice()) {
      if (this.gone.has(v) || v === this.active || this.controllable(v)) continue;
      debris++;
      if (v.mp.mass < contact.fragmentMassLimit && v.age > contact.fragmentLifetime) {
        this.expire(v, 'expired');
        debris--;
      }
    }
    while (debris > MAX_DEBRIS) {
      let oldest: FarObject | null = null;
      for (const o of this.far.objects) {
        if (o.removed || o.controllable) continue;
        if (!oldest || o.vessel.age > oldest.vessel.age) oldest = o;
      }
      if (!oldest) break;
      this.expire(oldest.vessel, 'limit');
      debris--;
    }
    this.far.compact();
    if (this.gone.size > 0) {
      if (!this.present) this.handOver();
      this.roster = this.roster.filter((v) => !this.gone.has(v));
      this.gone.clear();
    }
    // Mission state: every command part lost.
    if (!this.missionFailed && !this.roster.some((v) => this.controllable(v))) this.failMission('Every command part was lost');
  }

  private expire(v: Vessel, reason: 'expired' | 'limit'): void {
    const m = this.island.member(v.id);
    const o = m ? null : this.far.find(v.id);
    const bodyId = m ? this.island.bodyId : o!.bodyId;
    if (m) this.island.remove(v.id, 'removed');
    else o!.removed = true;
    this.fate(v, bodyId, reason, this.ut, true);
    this.gone.add(v);
  }

  /**
   * Island formation about the active vessel: a vessel of the clock joins the island inside the formation
   * distance and leaves it beyond the exit distance (a vessel with something burning or pending stays).
   * Outside the island a vessel is on rails, held on its body, or in the reduced tier (the far set).
   */
  form(): void {
    const tick = this.tick;
    let a = this.island.member(this.active.id);
    if (!a && this.present) {
      // The pilot's vessel is outside the island: the island is formed anew about it.
      const o = this.far.take(this.active.id, tick);
      if (!o) return;
      for (const m of this.island.members.slice()) this.demote(m.vessel);
      if (o.bodyId !== this.island.bodyId) this.island = createIsland({ defs: this.defs, system: this.system, terrain: this.terrain, rules: this.rules, policy: this.policy }, { id: 'local', tick, bodyId: o.bodyId });
      this.island.add(o.vessel, { bornTick: o.bornTick, revision: o.revision, conic: o.orbit ? { orbit: o.orbit, event: o.railsEvent } : undefined });
      a = this.island.member(this.active.id);
    }
    if (!a) return;
    const here = this.island.bodyId;
    const aRoot = v3.add(this.system.stateRoot(here, this.ut).r, this.active.r);
    let changed = false;
    for (const v of this.roster) {
      if (v === this.active) continue;
      const m = this.island.member(v.id);
      const o = m ? null : this.far.find(v.id);
      if (!m && !o) continue;
      if (o) this.far.sync(o, tick);
      if (o && o.removed) continue;
      const bodyId = m ? here : o!.bodyId;
      const d = bodyId === here ? v3.dist(v.r, this.active.r) : v3.dist(v3.add(this.system.stateRoot(bodyId, this.ut).r, v.r), aRoot);
      const busy = anyPending(v) || anyEngineBurning(v);
      const inside = d < (m ? BUBBLE_EXIT_RADIUS : BUBBLE_RADIUS) || (m !== null && busy);
      if (inside && o && o.bodyId === here) {
        this.far.take(v.id, tick);
        this.island.add(v, { bornTick: o.bornTick, revision: o.revision, conic: o.orbit ? { orbit: o.orbit, event: o.railsEvent } : undefined });
        changed = true;
      } else if (!inside && m) {
        this.demote(v);
        changed = true;
      }
    }
    if (changed) this.island.refreshMargins();
  }

  /** The place of a vessel in the order the session's vessels came into being. */
  orderOf(v: Vessel): number {
    let n = this.arrival.get(v);
    if (n === undefined) this.arrival.set(v, (n = this.arrivals++));
    return n;
  }
  private readonly arrival = new WeakMap<Vessel, number>();
  private arrivals = 0;

  /** A member leaves the island: it goes on from the conic it is on, is held on its body, or enters the reduced tier. */
  private demote(v: Vessel): void {
    const m = this.island.member(v.id)!;
    const from = { bornTick: m.bornTick, revision: m.revision, orbit: m.orbit, railsEvent: m.railsEvent, order: this.orderOf(v) };
    const bodyId = this.island.bodyId;
    this.island.remove(v.id, 'left');
    this.far.add(v, bodyId, this.tick, from);
  }

  /** The active vessel is gone: the nearest survivor takes over, a controllable one first, else the heaviest piece. */
  private handOver(): void {
    let next: Vessel | null = null;
    for (const v of this.roster) {
      if (this.gone.has(v)) continue;
      if (!next) next = v;
      else if (this.controllable(v) !== this.controllable(next)) next = this.controllable(v) ? v : next;
      else if (v.mp.mass > next.mp.mass) next = v;
    }
    if (next) this.takeVessel(next);
    else if (!this.wreck) this.wreck = wreckSnapshot(this.frames, this.lost!, this.ut);
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
    if (!(requestTick > this.tick)) return;
    this.ensurePatches();
    this.refreshWarp();
    if (this.mustIntegrate()) return;
    let landing = requestTick;
    if (this.ladder.event) landing = Math.min(landing, ceilTick(this.ladder.event.ut));
    const islandEvent = this.island.nextEvent();
    if (islandEvent) landing = Math.min(landing, islandEvent.tick);
    if (!(landing > this.tick)) {
      // An event is due: time can only move on by integrating.
      this.setWarpIndex(Math.min(this.ladder.index, MAX_PHYSICS_WARP_INDEX), 'event due');
      return;
    }
    this.hintImpact();
    const ut0 = this.ut;
    const report = this.island.advanceTo(landing);
    if (this.tick !== landing) throw new Error(`rails advance: the island landed on tick ${this.tick}, the clock asked for ${landing}`);
    this.far.advanceTo(landing);
    this.absorb(report, ut0);
    this.railsWarpActive = true;
    this.stampAges();
    this.revision++;
    this.railsAdvances++;
    this.lag = 0;
    this.lastAdvanceOnRails = true;
    this.afterAdvance(0, true);
    this.touch();
  }

  /**
   * One frame of rails warp for the real-time loop: presentation time moves on by `seconds` and the state
   * lands on the first whole tick at or after it (the rest of that tick is the presentation lag, exactly as
   * after physics steps), or on the tick of the next event. False when no time could pass on rails.
   */
  private railsFrame(seconds: number): boolean {
    // Ticks from the state to the new presentation time (the state is ahead of the presentation by the lag).
    const ahead = (seconds - this.lag) * TICKS_PER_SECOND;
    if (ahead <= TICK_EPSILON) {
      this.lag = Math.max(0, this.lag - seconds);
      return true;
    }
    const n = Math.ceil(ahead - TICK_EPSILON);
    const before = this.tick;
    this.advanceRailsToTick(before + n);
    if (this.tick === before) return false;
    // Landed on the requested tick: the state leads the presentation by the rest of that tick. Stopped
    // earlier, on an event's tick: the presentation is at the state.
    this.lag = this.tick === before + n ? Math.max(0, (n - ahead) / TICKS_PER_SECOND) : 0;
    return true;
  }

  advance(realDt: number, onControlTick?: () => void): void {
    this.throwIfBroken();
    const dtReal = Number.isFinite(realDt) && realDt > 0 ? realDt : 0;
    this.ensurePatches();
    this.refreshWarp();
    // A control tick is due before every CONTROL_TICK_STEPS-th physics step and before each rails advance.
    let tickGiven = false;
    if (this.ladder.index > MAX_PHYSICS_WARP_INDEX) {
      onControlTick?.();
      tickGiven = true;
      this.ensurePatches();
      this.refreshWarp();
    }
    if (this.ladder.index > MAX_PHYSICS_WARP_INDEX) {
      if (dtReal === 0 || this.railsFrame(dtReal * warpFactor(this.ladder.index))) return;
      // No progress on rails (an event is due): the frame is spent in physics steps at the clamped level.
    }
    const factor = warpFactor(this.ladder.index);
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
      if (this.tick % CONTROL_TICK_STEPS === 0) {
        if (!tickGiven) onControlTick?.();
        if (this.ladder.index > MAX_PHYSICS_WARP_INDEX) {
          // Rails warp was engaged in the control tick: the rest of this frame's time is spent on rails.
          this.ensurePatches();
          this.refreshWarp();
          if (this.ladder.index > MAX_PHYSICS_WARP_INDEX) {
            const owed = this.lag;
            this.lag = 0;
            if (this.railsFrame((-owed / factor) * warpFactor(this.ladder.index))) return;
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

  setWarpIndex(index: number, reason: string | null): void {
    const idx = Math.max(0, Math.min(WARP_LEVELS.length - 1, Math.round(index)));
    if (idx === this.ladder.index) return;
    this.ladder.index = idx;
    this.pushEvent({ type: 'warpChanged', ut: this.ut, vesselId: this.active.id, index: idx, factor: warpFactor(idx), reason });
    this.touch();
  }

  /** Recompute the highest allowed warp level, why, and the next warp-limiting event; step down if needed. */
  refreshWarp(): void {
    if (this.warpStamp === this.stateSerial) return;
    const a = this.focus();
    const v = a.vessel;
    const base = this.frames.base(a.bodyId);
    const subject = this.subject();
    const com = subject.com;
    // Terrain rule: 1x below 300 m radar altitude until final data is resident.
    const terrainLoading =
      this.present && v.hold === null && base.hasTerrain && v.groundClearance < WARP_CLAMP_RADAR_ALTITUDE + structureOf(v).boundingRadius && radarAltitude(v, this.envOf(a)) < WARP_CLAMP_RADAR_ALTITUDE && !this.island.terrainFinalUnder(v.id);
    const mustIntegrate = this.present && this.mustIntegrate();
    this.ladder.refresh({
      gone: !this.present,
      mustIntegrate,
      held: v.hold !== null,
      rate: v3.len(v.w),
      railsWarpActive: this.railsWarpActive,
      ut: this.ut,
      bodyId: a.bodyId,
      bodyDef: base.def,
      bodyRadius: base.info.radius,
      com,
      patches: this.plan.patches.current,
      nodes: () => this.plan.nodes.map((node) => ({ node, burnTime: this.plan.burnTimeFor(subject, node) })),
      alarms: () => this.altitudeAlarms(a, com),
      nodeEvent: () => this.plan.nodeEvent(subject),
      terrainLoading,
    });
    if (this.ladder.index > this.ladder.max) {
      if (this.ladder.terrainClampActive) this.terrainWarpClamps++;
      this.setWarpIndex(this.ladder.max, this.ladder.limitedBy);
    }
    this.warpStamp = this.stateSerial;
  }

  /** Times at which an armed altitude-crossing rule would be passed on the current conic. */
  private altitudeAlarms(a: ViewVessel, com: PlanSubject['com']): number[] {
    const armed = this.milestones.armedAltitudes(a.bodyId);
    if (armed.length === 0) return [];
    const body = this.frames.info(a.bodyId);
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
    let t = this.ladder.event ? this.ladder.event.ut : Infinity;
    const b = this.island.nextEvent();
    if (b && b.ut < t) t = b.ut;
    return t;
  }

  get cheatCounter(): number {
    return this.cheats;
  }

  terrainPending(): Promise<void> | null {
    return this.policy.pending();
  }

  // ---------------------------------------------------------------------------- milestone host

  standardData(): Record<string, number> {
    const a = this.focus();
    return this.record.standardData(a.vessel, a.bodyId, this.envOf(a), comStateOf(a.vessel), this.ut, { liftoffUt: this.liftoffUt, incompleteQueries: this.incompleteQueries, terrainWarpClamps: this.terrainWarpClamps, vesselCount: this.roster.length });
  }

  radarAltitude(): number {
    const a = this.focus();
    return radarAltitude(a.vessel, this.envOf(a));
  }

  orbit(): OrbitSummary {
    const a = this.focus();
    const s = comStateOf(a.vessel);
    const body = this.frames.info(a.bodyId);
    const o = a.orbit ?? makeOrbit(a.bodyId, body.mu, s.r, s.v, this.ut);
    const c = o.conic;
    const rp = c.p / (1 + c.e);
    const closed = o.period !== null;
    return { closed, periapsisAltitude: rp - body.radius, apoapsisAltitude: closed ? 2 / o.alpha - rp - body.radius : Infinity, eccentricity: c.e, inclination: c.inc, period: o.period };
  }

  currentPatches(): readonly Patch[] {
    this.ensurePatches();
    return this.plan.patches.current;
  }

  bodyRadius(bodyId: string): number {
    return this.frames.info(bodyId).radius;
  }

  touchdownData(): Record<string, number> {
    const a = this.focus();
    return this.record.touchdownData(a.vessel, a.bodyId, this.envOf(a));
  }

  separatedSince(stageIndex: number): number {
    return this.record.separatedSince(stageIndex);
  }

  vesselsLeftOnSurface(bodyId: string): number {
    let n = 0;
    for (const v of this.roster) {
      if (v === this.active || v.hold === null) continue;
      const e = this.entry(v);
      if (e && e.bodyId === bodyId && v3.dist(v.r, this.active.r) < 5000) n++;
    }
    return n;
  }

  emit(record: MilestoneRecord): void {
    this.pushEvent({ type: 'milestone', ut: record.ut, vesselId: this.active.id, milestone: record });
  }

  // ------------------------------------------------------------------------------------------ snapshot

  private build(presentation: boolean): SimSnapshot {
    this.ensurePatches();
    this.refreshWarp();
    const vessels: ViewVessel[] = [];
    for (const v of this.roster) {
      const e = this.entry(v);
      if (e) vessels.push(e);
    }
    const focus = this.present ? vessels.find((e) => e.vessel === this.active)! : this.lost!;
    if (!this.eventsView) this.eventsView = this.events.map((ev) => this.root.eventInFrame(ev));
    const rate = warpFactor(this.ladder.index);
    const l = this.ladder;
    return buildSnapshot({
      frames: this.frames,
      planning: this.plan,
      root: this.root,
      figures: this.figures,
      tick: this.tick,
      lag: presentation ? this.lag : 0,
      revision: this.revision,
      vessels,
      focus,
      focusPresent: this.present,
      wreck: this.wreck,
      subject: this.subject(),
      envOf: (e) => this.envOf(e),
      // One private clock nobody else is on: the pilot's tick is the live tick.
      time: privateClockView(this.tick, rate, warpFactor(l.max), l.limitedBy === null ? null : { kind: l.limitKind ?? 'event', text: l.limitedBy }),
      warp: { index: l.index, factor: rate, maxIndex: l.max, limitedBy: l.limitedBy, onRails: this.lastAdvanceOnRails },
      scenario: { id: this.scenario.id, startKind: this.scenario.start.kind, stagesAlreadyFired: this.scenario.stagesAlreadyFired },
      surfaceTargets: this.surfaceTargets,
      terrain: { finalAt: (bodyId, dir) => this.policy.isFinalAt(bodyId, dir), pending: this.policy.pending() !== null, incompleteQueries: this.incompleteQueries },
      events: this.eventsView,
      milestones: this.milestones.records,
      mission: { failed: this.missionFailed, failureReason: this.failureReason, crewAlive: this.crewAlive },
      cheatCounter: this.cheats,
      liftoffUt: this.liftoffUt,
    });
  }

  snapshot(): SimSnapshot {
    const s = this.build(true);
    // The rebase is drained like the events: the next snapshot starts from this frame.
    this.root.drain();
    this.events = [];
    this.eventsView = null;
    this.peekCache = null;
    return s;
  }

  peek(): SimSnapshot {
    if (this.peekCache && this.peekSerial === this.stateSerial && !this.plan.patchesDirty) return this.peekCache;
    const s = this.build(false);
    this.peekCache = s;
    this.peekSerial = this.stateSerial;
    return s;
  }

  stateHash(): string {
    const h = new StateHasher();
    h.num(this.ut);
    h.num(this.revision);
    h.str(this.active.id);
    h.any([this.ladder.index, this.plan.navballMode, this.plan.targetBodyId ?? '', this.cheats, this.missionFailed, this.crewAlive, this.incompleteQueries]);
    for (const v of this.roster) {
      const e = this.entry(v);
      if (!e) continue;
      h.str(vesselStateHash(v));
      h.any([e.bodyId, e.mode, e.tier]);
    }
    const [nodes, burn] = this.plan.hashState();
    h.any(nodes);
    h.any(burn);
    h.any(this.milestones.stateForHash());
    h.any(this.fates.map((f) => [f.vesselId, f.ut, f.reason]));
    return h.hex();
  }

  // ---------------------------------------------------------------------------------------- diagnostics

  debrisLog(): readonly DebrisFate[] {
    return this.fates;
  }

  stats(): WorldStats {
    return { steps: this.stepCount, railsAdvances: this.railsAdvances, patchRefreshes: this.plan.patchRefreshes, terrainRequests: this.policy.requests, terrainWarpClamps: this.terrainWarpClamps };
  }

  clearance(vesselIdA: string, vesselIdB: string): number | null {
    const find = (id: string): ViewVessel | null => {
      const v = this.roster.find((x) => x.id === id);
      return v ? this.entry(v) : null;
    };
    const p = find(vesselIdA);
    const q = find(vesselIdB);
    if (!p || !q || p.bodyId !== q.bodyId) return null;
    return vesselClearance(p.vessel, q.vessel);
  }
}

/**
 * Create the session of scenario `scenarioId` of the definition library, on the given terrain authority:
 * the single-clock host over one island, which is the in-process session until `LocalSession` replaces it
 * (MIGRATION_V2 step 4.3). `createSession` of src/session is this.
 */
export function createWorld(defs: DefLibrary, scenarioId: string, opts: CreateSimOptions): SimWorld {
  return new World(defs, scenarioId, opts);
}
