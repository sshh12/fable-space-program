/**
 * The single-clock host (docs/ARCHITECTURE.md 7.1; MIGRATION_V2 step 4.1a): what is left of v1's world
 * orchestrator. It owns the ONE pilot's active vessel, the warp ladder and island formation about that
 * vessel, and nothing else. The simulation is the island (src/sim/island); the objects of the clock outside
 * it are the far set (src/sim/island/far.ts); the snapshot, the plan and the event queue are the view's
 * (src/sim/view: `Presenter`, `Planning`); the objectives, the debris rules, the start protocol and the
 * frame pacing are their own modules beside this one (./mission.ts, ./debris.ts, ./start.ts, ./pacing.ts).
 * It contains no physics. `LocalSession` over `src/universe` replaces it (step 4.3).
 */
import type { ControlInputs, PlayerCommands } from '@/core/contracts/controls';
import { MAX_PHYSICS_WARP_INDEX, PHYSICS_DT, WARP_LEVELS, type DefLibrary, type ScenarioDef } from '@/core/contracts/defs';
import { DEFAULT_UNIVERSE_RULES, type UniverseRules } from '@/core/contracts/net';
import { CONTROL_TICK_STEPS, type SimSnapshot } from '@/core/contracts/sim';
import type { SessionDebug } from '@/core/contracts/session';
import type { TerrainProvider } from '@/core/contracts/terrain';
import { v3 } from '@/core/math/vec3';
import { createBodySystem, type BodySystem } from '../bodies/bodySystem';
import { ceilTick, tickOfInstant, utOfTick } from '../clock';
import { BodyFrames, createIsland, FarSet, TerrainPolicy, type AdvanceReport, type Island, type IslandCounters } from '../island';
import { warpFactor } from '../orbit/warp';
import { anyPending, seededCraftIds, type CraftIdSource, type Vessel } from '../vessel';
import { anyEngineBurning } from '../vessel/modules/engine';
import { PATCH_REFRESH_STEPS, Planning } from '../view/planning';
import { Presenter, type HostBlocks, type PresentedHost } from '../view/presenter';
import { PilotSeat, type PilotInput, type SeatHost } from '../view/seat';
import { PILOT_ACCOUNT, type CreateSimOptions, type DebrisFate, type SimWorld, type WorldStats } from './api';
import { makeCommands, makeDebug } from './commands';
import { Debris } from './debris';
import { MissionWatch } from './mission';
import { FramePacer, type PacedClock } from './pacing';
import { awaitStartTerrain, placeStart, scenarioOf, settleLanded, warmStartSurface } from './start';
import { sessionStateHash } from './stateHash';
import { WarpLadder } from './warpLadder';

export type { CreateSimOptions, DebrisFate, PilotInput, SimWorld, WorldStats };

export class World implements SimWorld, PresentedHost, PacedClock, SeatHost {
  readonly defs: DefLibrary;
  readonly scenario: ScenarioDef;
  readonly ready: Promise<void>;
  readonly commands: PlayerCommands;
  readonly debug: SessionDebug;
  readonly system: BodySystem;
  readonly frames: BodyFrames;
  readonly rules: UniverseRules;
  readonly terrain: TerrainProvider;
  readonly policy: TerrainPolicy;
  readonly plan: Planning;
  readonly view: Presenter;
  readonly seat: PilotSeat;
  readonly ladder: WarpLadder;
  readonly far: FarSet;
  readonly mission: MissionWatch;
  readonly debris: Debris;
  island!: Island;

  private readonly pacer: FramePacer;
  private readonly ids: CraftIdSource;
  private readonly startPad: string;
  private readonly startCraftId: string;
  /** Step counters of the islands this host has replaced (a new island about another body, a debug jump). */
  private readonly retired: IslandCounters = { steps: 0, railsAdvances: 0, freeSteps: 0, probeSubsteps: 0, pairSubsteps: 0, armedTests: 0 };

  /** Every vessel of the session in the order it came into being (the order of the snapshot and of the state hash). */
  roster: Vessel[] = [];
  active!: Vessel;
  /** Vessels that are gone since the last control tick (they leave the roster there, as v1's entries did). */
  readonly gone = new Set<Vessel>();
  private readonly arrival = new WeakMap<Vessel, number>();
  private arrivals = 0;

  revision = 0;
  stepCount = 0;
  private lastAdvanceOnRails = false;
  railsWarpActive = false;
  private railsAdvances = 0;
  stateSerial = 0;
  warpStamp = -1;
  mustStamp = -1;
  private mustCached = false;
  /** Uses of the debug interface (a flight with any is no mission proof). */
  cheatCounter = 0;
  incompleteQueries = 0;
  terrainWarpClamps = 0;

  constructor(defs: DefLibrary, scenarioId: string, opts: CreateSimOptions) {
    const { scenario, startPad } = scenarioOf(defs, scenarioId);
    this.startPad = startPad;
    this.defs = defs;
    this.scenario = scenario;
    this.terrain = opts.terrain;
    this.rules = defs.rules?.['local'] ?? DEFAULT_UNIVERSE_RULES;
    this.system = createBodySystem(defs);
    this.frames = new BodyFrames(this.system, opts.terrain);
    this.policy = new TerrainPolicy(opts.terrain);
    this.mission = new MissionWatch(this);
    this.debris = new Debris(this, startPad);
    this.plan = new Planning(this.frames);
    this.plan.targetBodyId = scenario.target && defs.bodies[scenario.target] ? scenario.target : null;
    this.plan.onPatches = () => this.relimit();
    this.ladder = new WarpLadder(this.system);
    this.view = new Presenter(this, opts.renderRoot ?? 'soiBody');
    this.seat = new PilotSeat(this, PILOT_ACCOUNT);
    this.pacer = new FramePacer(this);
    // One island: a ship about another body that meets the air unattended is flown by the Reduced tier (`reduceUnhosted`), a targeted vessel never is.
    this.far = new FarSet(this.frames, { event: (e) => this.view.push(e), removed: (o, reason, ut) => this.debris.gone(o.vessel, o.bodyId, reason, ut) }, { reduceUnhosted: true });
    this.far.protect = (v) => this.plan.targetCraft?.vesselId === v.id;
    this.ids = opts.ids ?? seededCraftIds();
    this.startCraftId = this.ids.next(scenario.vehicle);
    this.commands = makeCommands(this);
    this.debug = makeDebug(this);
    this.place(tickOfInstant(scenario.startUt, `scenarios/${scenarioId}.json: startUt`), false);
    this.ready = this.initialise();
    // A caller that never awaits `ready` still gets its errors through the next step.
    this.ready.catch(() => undefined);
  }

  // ---------------------------------------------------------------------------------------- the clock

  get tick(): number {
    return this.island.tick;
  }

  get ut(): number {
    return utOfTick(this.island.tick);
  }

  touch(): void {
    this.stateSerial++;
  }

  /** The cached command-authority flag of a vessel, as the island or the far set keeps it. */
  controllable(v: Vessel): boolean {
    return this.island.member(v.id)?.controllable ?? this.far.find(v.id)?.controllable ?? false;
  }

  /** The place of a vessel in the order the session's vessels came into being. */
  orderOf(v: Vessel): number {
    let n = this.arrival.get(v);
    if (n === undefined) this.arrival.set(v, (n = this.arrivals++));
    return n;
  }

  /** A new island of this clock; the step counters of the one it replaces are kept. */
  newIsland(tick: number, bodyId: string): Island {
    if (this.island) for (const k of Object.keys(this.retired) as (keyof IslandCounters)[]) this.retired[k] += this.island.counters[k];
    return createIsland({ defs: this.defs, system: this.system, terrain: this.terrain, rules: this.rules, policy: this.policy }, { id: 'local', tick, bodyId });
  }

  // ------------------------------------------------------------------------------------- start state

  /** Build the scenario vessel and an island about it at `tick`. `final` = terrain under the start point is resident. */
  private place(tick: number, final: boolean): void {
    const sc = this.scenario;
    const placed = placeStart(this.defs, this.frames, sc, this.startPad, { craftId: this.startCraftId, ids: this.ids }, tick, final);
    if (final) settleLanded(this.frames, sc, placed, tick);
    this.island = this.newIsland(tick, placed.bodyId);
    this.island.add(placed.vessel, { pilot: PILOT_ACCOUNT, attended: true });
    this.roster = [placed.vessel];
    this.orderOf(placed.vessel);
    this.active = placed.vessel;
    const body = this.frames.info(placed.bodyId);
    this.view.reset(placed.bodyId);
    this.plan.resetNavball(v3.len(this.island.stateOf(placed.vessel.id)!.r) - body.radius, body.def.navballSwitchAltitude);
    this.seat.sendReference();
    if (sc.start.kind !== 'pad') this.mission.liftoffUt = sc.startUt;
  }

  private async initialise(): Promise<void> {
    const kind = this.scenario.start.kind;
    await awaitStartTerrain(this.defs, this.frames, this.policy, this.rules, this.scenario, this.startPad, this.island.bodyId, this.active, this.ut);
    if (kind === 'pad' || kind === 'landed') {
      // Re-place on the final surface (pad elevation 'terrain' resolved; the landed vessel set down).
      this.place(this.tick, true);
      warmStartSurface(this.frames, this.island.bodyId, this.active, this.ut);
    }
    for (const v of this.roster) this.island.settle(v.id);
    this.plan.patchesDirty = true;
    this.plan.stageInfoDirty = true;
    this.warpStamp = -1;
    this.mustStamp = -1;
    this.far.stampAges(this.tick);
    this.view.clearEvents();
    this.touch();
  }

  // -------------------------------------------------------------------------------------- the pilot

  setControls(inputs: ControlInputs): void {
    this.seat.setControls(inputs);
  }

  /** A live control input ends rails warp. */
  liveInput(): void {
    if (this.ladder.index > MAX_PHYSICS_WARP_INDEX) this.setWarpIndex(0, 'Control input');
  }

  /** The plan changed: the warp limits are looked at again before the next advance. */
  relimit(): void {
    this.warpStamp = -1;
  }

  /** Move the pilot to another vessel: the plan is the old vessel's and is forgotten. */
  takeVessel(next: Vessel): void {
    const prev = this.active;
    if (this.view.present) this.seat.input({ kind: 'seat', vesselId: prev.id, aboard: false });
    this.active = next;
    this.view.regain();
    // A vessel outside the island (the one that takes over when the pilot's is lost): the island forms about it.
    if (!this.island.member(next.id)) this.form();
    this.seat.input({ kind: 'seat', vesselId: next.id, aboard: true });
    this.seat.sendReference();
    if (this.view.follow()) this.touch();
    this.plan.clear();
    this.warpStamp = -1;
    this.view.push({ type: 'activeVesselChanged', ut: this.ut, vesselId: next.id, previousVesselId: prev.id });
    this.touch();
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
    else this.view.keepWreck();
  }

  // ---------------------------------------------------------------------------------------- stepping

  get needsIntegration(): boolean {
    return this.mustIntegrate();
  }

  /** True when any member of the island must be integrated. */
  mustIntegrate(): boolean {
    if (this.mustStamp !== this.stateSerial) {
      this.mustStamp = this.stateSerial;
      this.mustCached = this.island.mustIntegrate();
    }
    return this.mustCached;
  }

  ensurePatches(): void {
    this.plan.ensurePatches(this.view.subject());
  }

  step(): void {
    this.policy.throwIfBroken();
    const burnFrom = this.seat.beforeStep(this.tick % CONTROL_TICK_STEPS === 0);
    const ut0 = this.ut;
    const report = this.island.step();
    this.far.step(this.tick, this.island);
    this.absorb(report, ut0);
    this.seat.afterStep(burnFrom);
    if (report.incompleteTerrain) this.incompleteQueries++;
    this.far.stampAges(this.tick);
    this.revision++;
    this.stepCount++;
    this.lastAdvanceOnRails = false;
    this.railsWarpActive = false;
    this.afterAdvance(PHYSICS_DT, this.tick % CONTROL_TICK_STEPS === 0);
    if (this.view.focus().mode !== 'rails' && this.stepCount % PATCH_REFRESH_STEPS === 0) this.plan.patchesDirty = true;
    this.touch();
  }

  /** What an advance of the island did, as the session sees it: events, new vessels, lost vessels, a new frame. */
  absorb(report: AdvanceReport, ut0: number): void {
    const activeId = this.active.id;
    for (const ev of report.events) {
      this.view.push(ev, this.island.bodyId);
      this.plan.noteEvent(ev);
      this.mission.note(ev, ev.vesselId === activeId);
    }
    for (const a of report.arrivals) {
      const m = this.island.member(a.vesselId);
      if (!m || this.roster.includes(m.vessel)) continue;
      this.roster.push(m.vessel);
      this.orderOf(m.vessel);
      if (a.fromVesselId === activeId) this.mission.record.separations.push(ut0);
      this.plan.stageInfoDirty = true;
    }
    for (const d of report.departures) {
      if (d.reason === 'burnedUp' || d.reason === 'impact') this.debris.fate(d.vessel, d.bodyId, d.reason, d.ut, false);
      this.gone.add(d.vessel);
      if (d.vessel === this.active) this.view.lose(d);
    }
    if (report.replan.includes(activeId)) this.plan.patchesDirty = true;
    if (report.frameChange && this.view.present) {
      const f = report.frameChange;
      if (this.view.follow()) this.touch();
      this.mission.noteSoiChange(f.fromBodyId, f.toBodyId, f.ut, this.seat.frameChanged(f.fromBodyId, f.toBodyId));
      this.warpStamp = -1;
    }
  }

  /** Bookkeeping after a physics step (dt > 0) or a rails advance (dt = 0); `due`: at the control-tick cadence. */
  private afterAdvance(dt: number, due: boolean): void {
    if (this.view.present) {
      const a = this.view.focus();
      this.seat.afterAdvance();
      this.mission.observe(a, dt, due);
    }
    if (due) this.upkeep();
  }

  // -------------------------------------------------------------------------------------- formation

  /** Control-tick cadence: island formation about the active vessel, the debris rules, the hand-over of the pilot, the mission state. */
  private upkeep(): void {
    this.form();
    this.debris.sweep();
    this.far.compact();
    if (this.gone.size > 0) {
      if (!this.view.present) this.handOver();
      this.roster = this.roster.filter((v) => !this.gone.has(v));
      this.gone.clear();
    }
    if (!this.mission.failed && !this.roster.some((v) => this.controllable(v))) this.mission.fail('Every command part was lost');
  }

  /**
   * Island formation about the active vessel (ARCHITECTURE 7.3): a vessel of the clock joins the island inside
   * the rules' join distance (`joinDistanceBase + joinClosingTime x closing speed`, between bounding spheres)
   * of any member, and a member leaves it once it is past `islandPartFactor` times that from everything that
   * hangs together with the pilot's vessel (a vessel with something burning or pending stays). Outside the
   * island a vessel is on rails, held on its body, or in the reduced tier (the far set).
   */
  form(): void {
    const tick = this.tick;
    if (this.view.present && !this.island.member(this.active.id)) {
      // The pilot's vessel is outside the island: the island is formed anew about it.
      const o = this.far.find(this.active.id);
      if (o) this.far.sync(o, tick);
      if (!o || o.removed) return;
      for (const m of this.island.members.slice()) this.far.receive(this.island, m.vessel.id, this.orderOf(m.vessel), o.bodyId !== this.island.bodyId);
      if (o.bodyId !== this.island.bodyId) this.island = this.newIsland(tick, o.bodyId);
      this.far.release(this.island, this.active.id, tick);
    }
    if (!this.island.member(this.active.id)) return;
    let changed = false;
    const linked = this.island.linkedTo(this.active.id);
    for (const m of this.island.members.slice()) {
      const v = m.vessel;
      if (linked.has(v.id) || anyPending(v) || anyEngineBurning(v)) continue;
      // (A vessel that is no debris and is in the air is refused: it stays, at full fidelity.)
      if (this.far.receive(this.island, v.id, this.orderOf(v))) changed = true;
    }
    if (this.far.joinInto(this.island, tick) > 0) changed = true;
    if (changed) this.island.refreshMargins();
  }

  // ------------------------------------------------------------------------------- the clock's advance

  /**
   * Rails advance toward `targetUt`. The state lands on a whole tick: the first tick at or after the
   * requested instant, or the first tick at or after the next event when that comes earlier (the event
   * itself is processed at its own instant inside that tick). Returns the time reached.
   */
  advanceRails(targetUt: number): number {
    this.policy.throwIfBroken();
    if (targetUt > this.ut) this.advanceRailsToTick(ceilTick(targetUt));
    return this.ut;
  }

  advanceRailsToTick(requestTick: number): void {
    if (!(requestTick > this.tick)) return;
    this.refresh();
    if (this.mustIntegrate()) return;
    let landing = requestTick;
    if (this.ladder.event) landing = Math.min(landing, ceilTick(this.ladder.event.ut));
    const islandEvent = this.island.nextEvent();
    landing = Math.min(landing, islandEvent ? islandEvent.tick : Infinity, this.far.nextRunTick());
    if (!(landing > this.tick)) {
      // An event is due: time can only move on by integrating.
      this.setWarpIndex(Math.min(this.ladder.index, MAX_PHYSICS_WARP_INDEX), 'event due');
      return;
    }
    this.seat.hintImpact();
    const ut0 = this.ut;
    const report = this.island.advanceTo(landing);
    if (this.tick !== landing) throw new Error(`rails advance: the island landed on tick ${this.tick}, the clock asked for ${landing}`);
    this.far.advanceTo(landing, this.island);
    this.absorb(report, ut0);
    this.railsWarpActive = true;
    this.far.stampAges(this.tick);
    this.revision++;
    this.railsAdvances++;
    this.pacer.lag = 0;
    this.lastAdvanceOnRails = true;
    this.afterAdvance(0, true);
    this.touch();
  }

  advance(realDt: number, onControlTick?: () => void): void {
    this.policy.throwIfBroken();
    this.pacer.advance(realDt, onControlTick);
  }

  // --------------------------------------------------------------------------------------------- warp

  get warpIndex(): number {
    return this.ladder.index;
  }

  setWarpIndex(index: number, reason: string | null): void {
    const idx = Math.max(0, Math.min(WARP_LEVELS.length - 1, Math.round(index)));
    if (idx === this.ladder.index) return;
    this.ladder.index = idx;
    this.view.push({ type: 'warpChanged', ut: this.ut, vesselId: this.active.id, index: idx, factor: warpFactor(idx), reason });
    this.touch();
  }

  /** Recompute the highest allowed warp level, why, and the next warp-limiting event; step down if needed. */
  refreshWarp(): void {
    if (this.warpStamp === this.stateSerial) return;
    this.ladder.refreshFor(this);
    if (this.ladder.index > this.ladder.max) {
      if (this.ladder.terrainClampActive) this.terrainWarpClamps++;
      this.setWarpIndex(this.ladder.max, this.ladder.limitedBy);
    }
    this.warpStamp = this.stateSerial;
  }

  /** The plan and the warp limits brought up to date. */
  refresh(): void {
    this.ensurePatches();
    this.refreshWarp();
  }

  get nextEventUt(): number {
    this.refresh();
    const b = this.island.nextEvent();
    return Math.min(this.ladder.event ? this.ladder.event.ut : Infinity, b ? b.ut : Infinity);
  }

  terrainPending(): Promise<void> | null {
    return this.policy.pending();
  }

  // ------------------------------------------------------------------------- snapshot and diagnostics

  /** The blocks of the snapshot that are this host's: its one private clock, the scenario, the terrain protocol, the objectives. */
  blocks(): HostBlocks {
    return {
      ...this.ladder.blocks(this.tick, this.lastAdvanceOnRails),
      scenario: { id: this.scenario.id, startKind: this.scenario.start.kind, stagesAlreadyFired: this.scenario.stagesAlreadyFired },
      surfaceTargets: this.mission.surfaceTargets,
      terrain: { finalAt: (bodyId, dir) => this.policy.isFinalAt(bodyId, dir), pending: this.policy.pending() !== null, incompleteQueries: this.incompleteQueries },
      milestones: this.mission.milestones.records,
      mission: this.mission.state,
      cheatCounter: this.cheatCounter,
      liftoffUt: this.mission.liftoffUt,
    };
  }

  snapshot(): SimSnapshot {
    return this.view.snapshot(this.pacer.lag);
  }

  peek(): SimSnapshot {
    return this.view.peek();
  }

  stateHash(): string {
    return sessionStateHash(this);
  }

  debrisLog(): readonly DebrisFate[] {
    return this.debris.fates;
  }

  stats(): WorldStats {
    const c = this.island.counters;
    const r = this.retired;
    return { steps: this.stepCount, railsAdvances: this.railsAdvances, patchRefreshes: this.plan.patchRefreshes, terrainRequests: this.policy.requests, terrainWarpClamps: this.terrainWarpClamps, freeSteps: r.freeSteps + c.freeSteps, probeSubsteps: r.probeSubsteps + c.probeSubsteps, pairSubsteps: r.pairSubsteps + c.pairSubsteps };
  }

  clearance(vesselIdA: string, vesselIdB: string): number | null {
    return this.view.clearance(vesselIdA, vesselIdB);
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
