/**
 * The island (docs/ARCHITECTURE.md 6.2, 7.1-7.4, 7.6; ./api.ts): N vessels on one clock's tick grid in one
 * frame, stepped by one loop. The per-vessel state machine, the exact rails advance, the hand-overs, the
 * step loop and the terrain triggers are v1's `World` algorithms, moved here unchanged in numerics: an
 * island of one with no reference orbit produces exactly the numbers of v1's `stepVessel` on the tick grid.
 *
 * Nothing here reads a clock, a socket or storage. Time moves only through `step` and `advanceTo`.
 */
import { NEUTRAL_CONTROLS, type ControlInputs } from '@/core/contracts/controls';
import { PHYSICS_DT } from '@/core/contracts/defs';
import type { IslandOpChecksum } from '@/core/contracts/net';
import type { SimEvent } from '@/core/contracts/sim';
import type { VesselEnvironment } from '@/core/contracts/simInternal';
import { quat, type Quat } from '@/core/math/quat';
import { DEG } from '@/core/math/scalar';
import { v3, type Vec3 } from '@/core/math/vec3';
import { CONTROL_TICKS, SUN_SAMPLE_TICKS, TICKS_PER_SECOND, ceilTick, utOfTick } from '../clock';
import { rcsTranslationActive } from '../control/allocation';
import { substepForces, substepIntegrate, type StepOptions, type SubstepRun } from '../dynamics/integrator';
import { dirFromLatLon, enuBasis } from '../frames/bodyFrames';
import { flightDirections } from '../nav/navball';
import { propagate, type Orbit } from '../orbit/kepler';
import {
  abort as abortVessel,
  fireNextStage,
  holdOnGround,
  isControllable,
  needsIntegration as vesselNeedsIntegration,
  vesselClearance,
  rideBody,
  setFineControl,
  setLights,
  setRcsEnabled,
  setSasEnabled,
  setSasHoldDirection,
  setSasMode,
  stepVessel,
  structureOf,
  toggleLegs,
  type StepResult,
  type Vessel,
} from '../vessel';
import type { StructuralRecord } from '../vessel/types';
import {
  ARMED_TEST_TICKS,
  COAST_TIME_TO_RAILS,
  REACH_ACCELERATION,
  type AddOptions,
  type AdvanceReport,
  type AppliedOp,
  type CaptureConstraint,
  type ClearingPair,
  type CommandOutcome,
  type Departure,
  type InputReceipt,
  type Island,
  type IslandCommand,
  type IslandCounters,
  type IslandDeps,
  type IslandEvent,
  type IslandInit,
  type IslandInput,
  type IslandMember,
  type IslandOp,
  type MemberMode,
  type MemberTier,
  type PairHook,
  type PairRef,
  type Reach,
  type ReferenceOrbit,
  type ReservationState,
  type StepMode,
} from './api';
import { IslandEnv } from './environment';
import { BodyFrames, comStateOf, setFromCom } from './frames';
import { encodeIsland, islandHash } from './codec';
import { applyIslandOp, checksumOfVessel, decodeBlob, opFromRecord } from './ops';
import { computeRailsEvent, crossSoi, eventAfterCrossing, orbitOf, railsStateAt, shifted, type RailsEvent } from './rails';
import { IMPACT_DISC_RADIUS, IMPACT_REFRESH_DISTANCE, TerrainPolicy, VESSEL_DISC_RADIUS, VESSEL_REFRESH_DISTANCE } from './terrainPolicy';

/** Inertial body rate above which a vessel keeps turning through a rails advance instead of being frozen, rad/s. */
export const ROTATION_WARP_LIMIT = 0.5 * DEG;
/** SAS pointing error below which the attitude tracks the hold direction across a rails advance, rad. */
export const SAS_TRACK_ERROR = 2 * DEG;
/** Collision vertices warmed per control tick around the predicted touchdown point of a piloted member. */
export const PREWARM_BUDGET = 48;
/** Radar altitude below which the touchdown area is warmed, m. */
export const PREWARM_RADAR_ALTITUDE = 1500;

/** The pilot's seat: what the island latches for one account (ARCHITECTURE 7.2). */
export interface Seat {
  accountId: string;
  vesselId: string;
  controls: ControlInputs;
  sasHold: Vec3 | null;
  reference: 'surface' | 'orbit';
  /** Tick the latch and dead-man timers opened (socket lost); null = none open. */
  latchOpenTick: number | null;
}

/** A member with everything the island keeps about it (the read view is `IslandMember`). */
export interface Rec {
  vessel: Vessel;
  slot: number;
  mode: MemberMode;
  tier: MemberTier;
  orbit: Orbit | null;
  railsEvent: RailsEvent | null;
  pilot: string | null;
  attended: boolean;
  bornTick: number;
  revision: number;
  controllable: boolean;
  thresholdWatch: boolean;
  terrainRegime: boolean;
  previous: { r: Vec3; v: Vec3; q: Quat } | null;
  trackHold: boolean;
  /** Seconds without any force while integrated. */
  coastTime: number;
  /** Integrate until the vessel's own state says it must be (a vessel that left rails at an atmosphere entry or before the ground). */
  forceIntegrate: boolean;
  /** Inside the armed margin of another member: both are integrated. */
  nearOther: boolean;
  env: IslandEnv;
  prevR: Vec3;
  prevV: Vec3;
  prevQ: Quat;
  admittedFromHead: number | null;
  reservation: ReservationState;
  removed: boolean;
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

const byId = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const pairKey = (a: string, b: string): string => (a < b ? `${a}\n${b}` : `${b}\n${a}`);
export const orderedPair = (a: string, b: string): PairRef => (a < b ? { a, b } : { a: b, b: a });

const FREE_HOOK: PairHook = { regime: () => 'free', solve: () => undefined };

function emptyReport(): AdvanceReport {
  return { events: [], ops: [], commands: [], departures: [], arrivals: [], replan: [], incompleteTerrain: false, frameChange: null };
}

export class IslandImpl implements Island {
  readonly id: string;
  tick: number;
  bodyId: string;
  reference: ReferenceOrbit | null = null;
  mode: StepMode;
  rate: number;
  mergeTick: number | null = null;
  readonly counters: IslandCounters = { steps: 0, railsAdvances: 0, freeSteps: 0, probeSubsteps: 0, pairSubsteps: 0, armedTests: 0 };

  readonly frames: BodyFrames;
  readonly policy: TerrainPolicy;
  readonly recs: Rec[] = [];
  readonly seats = new Map<string, Seat>();
  /** Inputs stamped for ticks the island has not reached, in arrival order. */
  queue: IslandInput[] = [];
  nascentPairs: PairRef[] = [];
  clearingPairs: ClearingPair[] = [];
  captures: CaptureConstraint[] = [];
  /** A rails advance is under way since the last step: attitudes were frozen or set to track once. */
  railsWarp = false;

  private hook: PairHook = FREE_HOOK;
  private report: AdvanceReport = emptyReport();
  private refOrbit: Orbit | null = null;
  private refCacheUt = NaN;
  private refCache: { r: Vec3; v: Vec3 } = { r: v3.zero(), v: v3.zero() };
  private readonly impactHints = new Map<string, { bodyId: string; latitude: number; longitude: number }>();

  constructor(
    readonly deps: IslandDeps,
    init: IslandInit,
    frames?: BodyFrames,
  ) {
    if (!Number.isInteger(init.tick)) throw new Error(`island ${init.id}: tick ${init.tick} is not a whole tick`);
    if (!deps.defs.bodies[init.bodyId]) throw new Error(`island ${init.id}: unknown body "${init.bodyId}"`);
    this.id = init.id;
    this.tick = init.tick;
    this.bodyId = init.bodyId;
    this.mode = init.mode ?? 'authoritative';
    this.rate = init.rate ?? 1;
    this.frames = frames ?? new BodyFrames(deps.system, deps.terrain);
    this.policy = deps.policy ?? new TerrainPolicy(deps.terrain);
  }

  // ---------------------------------------------------------------------------------------- read side

  get ut(): number {
    return utOfTick(this.tick);
  }

  get members(): readonly IslandMember[] {
    return this.recs;
  }

  get anchorId(): string | null {
    const a = this.anchor();
    return a ? a.vessel.id : null;
  }

  member(vesselId: string): IslandMember | null {
    return this.rec(vesselId);
  }

  rec(vesselId: string): Rec | null {
    for (const r of this.recs) if (r.vessel.id === vesselId) return r;
    return null;
  }

  tierOf(vesselId: string): MemberTier | null {
    return this.rec(vesselId)?.tier ?? null;
  }

  seatOf(accountId: string): Seat | null {
    return this.seats.get(accountId) ?? null;
  }

  /** The anchor: the lowest vessel id among the attended members, else the lowest id (ARCHITECTURE 5.1). */
  private anchor(): Rec | null {
    for (const r of this.recs) if (r.attended) return r;
    return this.recs[0] ?? null;
  }

  // ------------------------------------------------------------------------------------------ frame

  /** The reference point in BCI of the island's body at `ut` (only while there is a reference orbit). */
  private refAt(ut: number): { r: Vec3; v: Vec3 } {
    if (ut !== this.refCacheUt) {
      this.refCache = railsStateAt(this.refOrbit!, ut);
      this.refCacheUt = ut;
    }
    return this.refCache;
  }

  /** True when an island about `bodyId` integrates offsets from a reference orbit: the sphere of influence of the root star (ARCHITECTURE section 4). */
  private usesReference(bodyId: string): boolean {
    return this.deps.system.rootId === bodyId && this.deps.system.starId === bodyId;
  }

  /** BCI position of a member's origin about the island's body at `ut` (its own `r` without a reference orbit: no copy, no arithmetic). */
  private posOf(rec: Rec, ut: number): Vec3 {
    return this.reference === null ? rec.vessel.r : v3.add(this.refAt(ut).r, rec.vessel.r);
  }

  private velOf(rec: Rec, ut: number): Vec3 {
    return this.reference === null ? rec.vessel.v : v3.add(this.refAt(ut).v, rec.vessel.v);
  }

  stateOf(vesselId: string): { r: Vec3; v: Vec3 } | null {
    const rec = this.rec(vesselId);
    return rec ? { r: this.posOf(rec, this.ut), v: this.velOf(rec, this.ut) } : null;
  }

  /** Centre-of-mass state of a member in BCI at `ut`. */
  private comBci(rec: Rec, ut: number): { r: Vec3; v: Vec3 } {
    const s = comStateOf(rec.vessel);
    if (this.reference === null) return s;
    const o = this.refAt(ut);
    return { r: v3.add(o.r, s.r), v: v3.add(o.v, s.v) };
  }

  /** Set a member's state from the BCI state of its centre of mass at `ut`. */
  private placeCom(rec: Rec, s: { r: Vec3; v: Vec3 }, ut: number): void {
    if (this.reference === null) setFromCom(rec.vessel, s.r, s.v);
    else {
      const o = this.refAt(ut);
      setFromCom(rec.vessel, v3.sub(s.r, o.r), v3.sub(s.v, o.v));
    }
  }

  /**
   * Run `fn` with the member's vessel expressed in BCI (the vessel package's read-only helpers take `r`, `v`
   * as BCI). Without a reference orbit the vessel is in BCI already and nothing is touched.
   */
  private inBci<T>(rec: Rec, ut: number, fn: () => T): T {
    if (this.reference === null) return fn();
    const v = rec.vessel;
    const o = this.refAt(ut);
    const r0 = v.r;
    const v0 = v.v;
    v.r = v3.add(o.r, r0);
    v.v = v3.add(o.v, v0);
    try {
      return fn();
    } finally {
      v.r = r0;
      v.v = v0;
    }
  }

  private envAt(rec: Rec, ut: number): IslandEnv {
    const env = this.frames.aim(rec.env, this.bodyId, this.posOf(rec, ut), ut);
    env.origin = this.reference === null ? undefined : this.refAt(ut);
    return env;
  }

  environmentOf(vesselId: string): VesselEnvironment | null {
    const rec = this.rec(vesselId);
    return rec ? this.envAt(rec, this.ut) : null;
  }

  private refreshSun(rec: Rec, ut: number): void {
    rec.vessel.sun = this.frames.sunSample(this.bodyId, this.posOf(rec, ut), ut);
    this.sunToEnv(rec);
  }

  private sunToEnv(rec: Rec): void {
    rec.env.sunDir = rec.vessel.sun.dir;
    rec.env.sunVisibility = rec.vessel.sun.visibility;
  }

  /** Start a reference orbit at the anchor's centre of mass, or move the one there is (a `rebase` operation). */
  private rebase(ut: number, why: 'frame' | 'offset' | 'anchor'): void {
    const a = this.anchor();
    if (!a) return;
    const com = comStateOf(a.vessel);
    let state: { r: Vec3; v: Vec3 };
    let delta: { r: Vec3; v: Vec3 };
    if (this.reference === null) {
      // From BCI: the new origin is the anchor's centre of mass; every member's offset is its BCI state less that.
      state = { r: v3.clone(com.r), v: v3.clone(com.v) };
      delta = { r: v3.neg(com.r), v: v3.neg(com.v) };
    } else {
      // From one reference to the next: the anchor's own offset is the shift, exactly (no state about the body is subtracted).
      const o = this.refAt(ut);
      state = { r: v3.add(o.r, com.r), v: v3.add(o.v, com.v) };
      delta = { r: v3.neg(com.r), v: v3.neg(com.v) };
    }
    for (const rec of this.recs) {
      const v = rec.vessel;
      v.r = v3.add(v.r, delta.r);
      v.v = v3.add(v.v, delta.v);
      rec.previous = null;
    }
    this.reference = { r0: state.r, v0: state.v, tick: this.tick };
    this.refOrbit = orbitOf(this.frames, this.bodyId, state, utOfTick(this.tick));
    this.refCacheUt = NaN;
    if (why !== 'frame') this.report.frameChange = { fromBodyId: this.bodyId, toBodyId: this.bodyId, ut };
    this.report.ops.push({ tick: this.tick, body: { op: 'rebase', anchor: a.slot, bodyId: this.bodyId, r: v3.clone(state.r), v: v3.clone(state.v) }, checksum: checksumOfVessel(a.vessel) });
  }

  /** Give the reference orbit up: every member's state becomes its BCI state. */
  private dropReference(ut: number): void {
    if (this.reference === null) return;
    const o = this.refAt(ut);
    for (const rec of this.recs) {
      rec.vessel.r = v3.add(o.r, rec.vessel.r);
      rec.vessel.v = v3.add(o.v, rec.vessel.v);
      rec.previous = null;
    }
    this.reference = null;
    this.refOrbit = null;
    this.refCacheUt = NaN;
  }

  /** Install a reference orbit as data (a replica's `rebase` operation, the decoder). */
  setReference(ref: ReferenceOrbit | null): void {
    this.reference = ref;
    this.refOrbit = ref ? orbitOf(this.frames, this.bodyId, { r: ref.r0, v: ref.v0 }, utOfTick(ref.tick)) : null;
    this.refCacheUt = NaN;
  }

  // ------------------------------------------------------------------------------------- membership

  private newRec(vessel: Vessel, o: AddOptions): Rec {
    if (!(vessel.mp.mass > 0)) structureOf(vessel);
    return {
      vessel,
      slot: 0,
      mode: vessel.hold !== null ? 'landed' : 'integrated',
      tier: 'full',
      orbit: null,
      railsEvent: null,
      pilot: o.pilot ?? null,
      attended: o.attended ?? false,
      bornTick: o.bornTick ?? this.tick,
      revision: o.revision ?? 0,
      controllable: isControllable(vessel),
      thresholdWatch: false,
      terrainRegime: false,
      previous: null,
      trackHold: false,
      coastTime: 0,
      forceIntegrate: false,
      nearOther: false,
      env: new IslandEnv(this.deps.terrain),
      prevR: v3.clone(vessel.r),
      prevV: v3.clone(vessel.v),
      prevQ: quat.clone(vessel.q),
      admittedFromHead: o.admittedFromHead ?? null,
      reservation: 'none',
      removed: false,
    };
  }

  private insert(rec: Rec): void {
    let i = 0;
    while (i < this.recs.length && byId(this.recs[i]!.vessel.id, rec.vessel.id) < 0) i++;
    if (i < this.recs.length && this.recs[i]!.vessel.id === rec.vessel.id) throw new Error(`island ${this.id}: vessel "${rec.vessel.id}" is already a member`);
    this.recs.splice(i, 0, rec);
    for (let k = i; k < this.recs.length; k++) this.recs[k]!.slot = k;
  }

  add(vessel: Vessel, options: AddOptions = {}): IslandMember {
    const rec = this.newRec(vessel, options);
    const first = this.recs.length === 0;
    this.insert(rec);
    this.sunToEnv(rec);
    // The age of a member is the island's time since it came into being (the vessel package only counts the steps it is given).
    vessel.age = (this.tick - rec.bornTick) / TICKS_PER_SECOND;
    if (this.reference !== null) {
      // The vessel is given in BCI: its state becomes the offset from the reference point.
      const o = this.refAt(this.ut);
      vessel.r = v3.sub(vessel.r, o.r);
      vessel.v = v3.sub(vessel.v, o.v);
    } else if (first && this.usesReference(this.bodyId) && vessel.hold === null) this.rebase(this.ut, 'frame');
    if (options.conic && vessel.hold === null) {
      rec.orbit = options.conic.orbit;
      rec.railsEvent = options.conic.event;
      rec.mode = 'rails';
    }
    if (rec.pilot !== null && !this.seats.has(rec.pilot)) this.seats.set(rec.pilot, this.newSeat(rec.pilot, rec));
    return rec;
  }

  settle(vesselId: string): void {
    const rec = this.rec(vesselId);
    if (!rec) return;
    if (rec.vessel.hold !== null) {
      rec.mode = 'landed';
      return;
    }
    rec.mode = 'integrated';
    rec.orbit = null;
    rec.railsEvent = null;
    if (!this.memberMustIntegrate(rec, this.envAt(rec, this.ut), this.ut)) this.toRails(rec, this.ut);
  }

  /** Put a decoded member back exactly as it was encoded: its state is already in the island's frame, and nothing is derived. */
  restoreMember(vessel: Vessel, o: AddOptions): Rec {
    const rec = this.newRec(vessel, o);
    this.insert(rec);
    this.sunToEnv(rec);
    return rec;
  }

  private newSeat(accountId: string, rec: Rec): Seat {
    return { accountId, vesselId: rec.vessel.id, controls: cloneControls(NEUTRAL_CONTROLS), sasHold: null, reference: 'surface', latchOpenTick: null };
  }

  remove(vesselId: string, _reason: 'left' | 'removed' = 'left'): Vessel | null {
    const rec = this.rec(vesselId);
    if (!rec) return null;
    const wasAnchor = this.reference !== null && this.anchor() === rec;
    this.detach(rec);
    if (this.reference !== null) {
      const o = this.refAt(this.ut);
      rec.vessel.r = v3.add(o.r, rec.vessel.r);
      rec.vessel.v = v3.add(o.v, rec.vessel.v);
      if (this.recs.length === 0) this.setReference(null);
      else if (wasAnchor) this.rebase(this.ut, 'anchor');
    }
    return rec.vessel;
  }

  /** Take a record out of the lists (the vessel object and its state are left as they are). */
  private detach(rec: Rec): void {
    const i = this.recs.indexOf(rec);
    if (i < 0) return;
    rec.removed = true;
    this.recs.splice(i, 1);
    for (let k = i; k < this.recs.length; k++) this.recs[k]!.slot = k;
    const id = rec.vessel.id;
    this.policy.drop(`vessel:${id}`);
    this.policy.drop(`impact:${id}`);
    this.impactHints.delete(id);
    for (const [account, seat] of this.seats) if (seat.vesselId === id) this.seats.delete(account);
    this.nascentPairs = this.nascentPairs.filter((p) => p.a !== id && p.b !== id);
    this.clearingPairs = this.clearingPairs.filter((p) => p.a !== id && p.b !== id);
    this.captures = this.captures.filter((p) => p.a !== id && p.b !== id);
  }

  // -------------------------------------------------------------------------------- rails machinery

  private toRails(rec: Rec, ut: number): void {
    rec.orbit = orbitOf(this.frames, this.bodyId, this.comBci(rec, ut), ut);
    rec.mode = 'rails';
    rec.coastTime = 0;
    rec.forceIntegrate = false;
    rec.railsEvent = computeRailsEvent(this.frames, this.bodyId, rec.orbit, ut);
    rec.revision++;
    this.report.replan.push(rec.vessel.id);
  }

  private leaveRails(rec: Rec): void {
    rec.mode = 'integrated';
    rec.orbit = null;
    rec.railsEvent = null;
    rec.coastTime = 0;
  }

  private anyIntegrated(): boolean {
    for (const r of this.recs) if (r.mode === 'integrated') return true;
    return false;
  }

  /**
   * The sphere-of-influence hand-over of the whole island at one instant with one body state (ARCHITECTURE
   * 7.3): the anchor's event instant `ev.ut`. Members on a conic are propagated to that instant, shifted and
   * given their orbit about the new body from there; a member that is integrated or held is at the tick
   * `tickUt` and is shifted with the same body state.
   */
  private handOver(ev: { ut: number; kind: 'soiEnter' | 'soiExit'; nextBodyId: string | null }, tickUt: number): void {
    const from = this.bodyId;
    const x = crossSoi(this.frames, from, ev);
    const hadReference = this.reference !== null;
    if (hadReference) this.dropReference(tickUt);
    this.bodyId = x.to;
    for (const rec of this.recs) {
      if (rec.orbit !== null) {
        const t = shifted(propagate(rec.orbit, ev.ut), x);
        rec.orbit = orbitOf(this.frames, x.to, t, ev.ut);
      } else {
        const t = shifted({ r: rec.vessel.r, v: rec.vessel.v }, x);
        rec.vessel.r = t.r;
        rec.vessel.v = t.v;
        if (rec.vessel.hold !== null) rec.vessel.anchor = null;
      }
      rec.previous = null;
      this.report.events.push({ type: 'soiChange', ut: ev.ut, vesselId: rec.vessel.id, fromBodyId: from, toBodyId: x.to });
      rec.revision++;
      if (rec.orbit !== null) rec.railsEvent = eventAfterCrossing(this.frames, x.to, rec.orbit, ev.ut);
    }
    this.report.frameChange = { fromBodyId: from, toBodyId: x.to, ut: ev.ut };
    if (this.usesReference(x.to) && this.recs.every((r) => r.vessel.hold === null)) {
      // Into the star's sphere of influence: members on a conic are placed at the tick first (BCI), then every state becomes an offset.
      for (const rec of this.recs) if (rec.orbit !== null) setFromCom(rec.vessel, railsStateAt(rec.orbit, tickUt).r, railsStateAt(rec.orbit, tickUt).v);
      const saved = this.tick;
      this.tick = Math.round(tickUt * TICKS_PER_SECOND);
      this.rebase(tickUt, 'frame');
      this.tick = saved;
    }
  }

  /**
   * Move a member on its conic to `utNew`, processing its events in (now, utNew] exactly at their times.
   * A sphere-of-influence change is the island's when the member is its anchor, and nobody else's. An
   * atmosphere entry or the ground ahead takes the member off rails at the grid tick `utNew`, by an exact
   * Kepler evaluation there (the caller clamps a rails advance to the tick the event lies in).
   */
  private advanceOnRails(rec: Rec, utNew: number): void {
    for (let guard = 0; guard < 64; guard++) {
      const ev = rec.railsEvent;
      if (!ev || ev.ut > utNew || rec.orbit === null) break;
      if (ev.kind === 'soiEnter' || ev.kind === 'soiExit') {
        if (rec !== this.anchor()) {
          // The island crosses as a unit at its anchor's instant: until then the member stays on its conic.
          rec.railsEvent = null;
          continue;
        }
        if (this.anyIntegrated()) {
          // A companion is being integrated: the island hands over at the tick, when every state is one instant's.
          this.pendingHandOver = { ut: ev.ut, kind: ev.kind, nextBodyId: ev.nextBodyId };
          rec.railsEvent = null;
          continue;
        }
        this.handOver({ ut: ev.ut, kind: ev.kind, nextBodyId: ev.nextBodyId }, utNew);
        // The members that were already placed at the new instant on their old conics are placed again on the new ones.
        for (const other of this.recs) if (other !== rec && other.orbit !== null) this.placeCom(other, railsStateAt(other.orbit, utNew), utNew);
        continue;
      }
      if (ev.kind === 'atmosphere' || ev.kind === 'impact') {
        const at = railsStateAt(rec.orbit, utNew);
        this.placeCom(rec, at, utNew);
        rec.mode = 'integrated';
        rec.orbit = null;
        rec.railsEvent = null;
        if (ev.kind === 'atmosphere') rec.coastTime = 0;
        rec.forceIntegrate = true;
        return;
      }
      // 'recheck': end of a closed revolution or of the prediction horizon.
      rec.railsEvent = computeRailsEvent(this.frames, this.bodyId, rec.orbit, ev.ut + 1e-3);
      if (rec.railsEvent && rec.railsEvent.ut <= ev.ut) rec.railsEvent = null;
      this.report.replan.push(rec.vessel.id);
    }
    if (rec.orbit !== null) this.placeCom(rec, railsStateAt(rec.orbit, utNew), utNew);
  }
  private pendingHandOver: { ut: number; kind: 'soiEnter' | 'soiExit'; nextBodyId: string | null } | null = null;

  /** The hand-over of an island whose anchor is integrated: looked for at control ticks, at the tick's instant (v1's rule for an integrated vessel). */
  private checkSoiIntegrated(): void {
    const a = this.anchor();
    if (!a || a.mode !== 'integrated') return;
    const ut = this.ut;
    const body = this.frames.info(this.bodyId);
    const r = this.posOf(a, ut);
    const vel = this.velOf(a, ut);
    if (body.soiRadius !== null && body.parentId !== null && v3.len(r) > body.soiRadius && v3.dot(r, vel) > 0) {
      this.handOverAtTick({ ut, kind: 'soiExit', nextBodyId: body.parentId });
      return;
    }
    for (const cid of body.childIds) {
      const child = this.frames.info(cid);
      if (child.soiRadius === null) continue;
      const cs = this.deps.system.stateRelParent(cid, ut);
      const d = v3.sub(r, cs.r);
      if (v3.len(d) < child.soiRadius && v3.dot(d, v3.sub(vel, cs.v)) < 0) {
        this.handOverAtTick({ ut, kind: 'soiEnter', nextBodyId: cid });
        return;
      }
    }
  }

  /** A hand-over at the island's tick: members on a conic are first placed there, so that every state is the tick's. */
  private handOverAtTick(ev: { ut: number; kind: 'soiEnter' | 'soiExit'; nextBodyId: string | null }): void {
    this.handOver(ev, ev.ut);
    for (const rec of this.recs) if (rec.orbit !== null) this.placeCom(rec, railsStateAt(rec.orbit, ev.ut), ev.ut);
  }

  // ------------------------------------------------------------------------------- integration rule

  private controlsOf(rec: Rec): ControlInputs {
    const seat = rec.pilot !== null ? this.seats.get(rec.pilot) : undefined;
    return seat && seat.vesselId === rec.vessel.id ? seat.controls : NEUTRAL_CONTROLS;
  }

  private seatFor(rec: Rec): Seat | null {
    const seat = rec.pilot !== null ? this.seats.get(rec.pilot) : undefined;
    return seat && seat.vesselId === rec.vessel.id ? seat : null;
  }

  private memberMustIntegrate(rec: Rec, env: IslandEnv, ut: number): boolean {
    const v = rec.vessel;
    if (rec.forceIntegrate || rec.nearOther) return true;
    if (this.inBci(rec, ut, () => vesselNeedsIntegration(v, env))) return true;
    const seat = this.seatFor(rec);
    if (seat && v.hold !== 'clamps' && v.hold !== 'ground') {
      const c = seat.controls;
      if (c.throttle > 0 && hasArmedEngine(v)) return true;
      if (rcsTranslationActive(v, c.translate)) return true;
    }
    return false;
  }

  mustIntegrate(): boolean {
    for (const rec of this.recs) if (this.memberMustIntegrate(rec, this.envAt(rec, this.ut), this.ut)) return true;
    return false;
  }

  nextEvent(): IslandEvent | null {
    let best: IslandEvent | null = null;
    for (const rec of this.recs) {
      const ev = rec.railsEvent;
      if (!ev || (ev.kind !== 'atmosphere' && ev.kind !== 'impact')) continue;
      if (!best || ev.ut < best.ut) best = { ut: ev.ut, tick: ceilTick(ev.ut), kind: ev.kind, vesselId: rec.vessel.id };
    }
    return best;
  }

  // ------------------------------------------------------------------------------------------- SAS

  /** Unit direction (island axes) that the member's SAS mode holds, or null for stability / nothing to hold. */
  private sasHoldDirection(rec: Rec, seat: Seat, ut: number): Vec3 | null {
    const v = rec.vessel;
    const mode = v.sas.mode;
    if (mode === 'stability') return null;
    if (mode === 'maneuver' || mode === 'target' || mode === 'antiTarget' || mode === 'portAlign') return seat.sasHold;
    const base = this.frames.base(this.bodyId);
    const qf = this.frames.orientAt(this.bodyId, ut);
    const r = this.posOf(rec, ut);
    const vel0 = this.velOf(rec, ut);
    const enu = enuBasis(qf, r);
    const vel = seat.reference === 'surface' ? v3.sub(vel0, v3.cross(base.info.spin, r)) : vel0;
    const d = flightDirections(r, vel, enu);
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

  private updateSasHold(rec: Rec, seat: Seat): void {
    const v = rec.vessel;
    if (!v.sas.enabled || v.sas.mode === 'stability') {
      if (v.sas.holdDir !== null) setSasHoldDirection(v, null);
      return;
    }
    setSasHoldDirection(v, this.sasHoldDirection(rec, seat, this.ut));
  }

  // ------------------------------------------------------------------------------------------ steps

  step(): AdvanceReport {
    if (this.mergeTick !== null && this.tick >= this.mergeTick) throw new Error(`island ${this.id}: step past the pending merge tick ${this.mergeTick}`);
    this.throwIfBroken();
    const report = this.begin();
    this.applyQueued();
    if (this.tick % CONTROL_TICKS === 0) this.terrainWork();
    const ut0 = this.ut;
    const dt = PHYSICS_DT;
    const utNew = utOfTick(this.tick + 1);
    for (const seat of this.seats.values()) {
      const rec = this.rec(seat.vesselId);
      if (rec) this.updateSasHold(rec, seat);
    }
    const groups = this.pairGroups();
    // Members in id order; vessels a step brings into being are stepped once in the same tick, after them.
    const turn = this.recs.slice();
    const born: Rec[] = [];
    let incomplete = false;
    for (const rec of turn) {
      if (rec.removed) continue;
      const group = groups?.get(rec);
      if (group) {
        if (group[0] === rec && this.stepGroup(group, groups!.pairs, ut0, utNew, dt, born)) incomplete = true;
      } else if (this.stepMember(rec, ut0, utNew, dt, born)) incomplete = true;
    }
    for (let k = 0; k < born.length; k++) {
      const rec = born[k]!;
      if (!rec.removed && this.stepMember(rec, ut0, utNew, dt, born)) incomplete = true;
    }
    if (this.pendingHandOver) {
      const ev = this.pendingHandOver;
      this.pendingHandOver = null;
      // Every state is at the new tick now; members on a conic are evaluated there by the hand-over itself.
      const saved = this.tick;
      this.tick = saved + 1;
      this.handOverAtTick({ ut: utNew, kind: ev.kind, nextBodyId: ev.nextBodyId });
      this.tick = saved;
    }
    report.incompleteTerrain = incomplete;
    this.tick += 1;
    this.stampAges();
    this.counters.steps++;
    this.railsWarp = false;
    if (this.tick % CONTROL_TICKS === 0) this.upkeep();
    return this.end();
  }

  private begin(): AdvanceReport {
    this.report = emptyReport();
    return this.report;
  }

  private end(): AdvanceReport {
    const r = this.report;
    this.report = emptyReport();
    return r;
  }

  private throwIfBroken(): void {
    if (this.policy.error !== null) {
      const e = this.policy.error;
      throw e instanceof Error ? e : new Error(String(e));
    }
  }

  private stampAges(): void {
    for (const rec of this.recs) rec.vessel.age = (this.tick - rec.bornTick) / TICKS_PER_SECOND;
  }

  /** What is done for a member before its vessel is stepped: the pose for interpolation, the environment, the sun sample, leaving rails. */
  private preStep(rec: Rec, ut0: number): { env: IslandEnv; must: boolean; parts: number; id: string } {
    const v = rec.vessel;
    v3.copyTo(rec.prevR, v.r);
    v3.copyTo(rec.prevV, v.v);
    rec.prevQ.x = v.q.x;
    rec.prevQ.y = v.q.y;
    rec.prevQ.z = v.q.z;
    rec.prevQ.w = v.q.w;
    rec.previous = { r: rec.prevR, v: rec.prevV, q: rec.prevQ };
    const env = this.envAt(rec, ut0);
    if (this.tick % SUN_SAMPLE_TICKS === 0) this.refreshSun(rec, ut0);
    const must = v.hold !== null ? false : this.memberMustIntegrate(rec, env, ut0);
    if (rec.mode === 'rails' && must) {
      this.leaveRails(rec);
      this.report.replan.push(v.id);
    }
    return { env, must, parts: v.parts.length, id: v.id };
  }

  /** A member's vessel id changed (a separation of an assembly renames its pieces): the order, the seat and the pair lists follow. */
  private renamed(rec: Rec, oldId: string): void {
    const id = rec.vessel.id;
    this.recs.sort((a, b) => byId(a.vessel.id, b.vessel.id));
    for (let k = 0; k < this.recs.length; k++) this.recs[k]!.slot = k;
    for (const seat of this.seats.values()) if (seat.vesselId === oldId) seat.vesselId = id;
    const rename = <T extends PairRef>(p: T): T => ({ ...p, ...orderedPair(p.a === oldId ? id : p.a, p.b === oldId ? id : p.b) });
    this.nascentPairs = this.nascentPairs.map(rename);
    this.clearingPairs = this.clearingPairs.map(rename);
    this.captures = this.captures.filter((c) => c.a !== oldId && c.b !== oldId);
    this.policy.drop(`vessel:${oldId}`);
    this.policy.drop(`impact:${oldId}`);
  }

  private stepOptions(extra?: Partial<StepOptions>): StepOptions | undefined {
    if (this.mode === 'authoritative' && !extra && !this.recordOps) return undefined;
    return { mode: this.mode, records: this.recordOps, ...extra };
  }
  /** Collect the structural operations of the steps (a host that journals or sends them turns it on). */
  recordOps = false;

  /** One physics step of a member. Returns true when a terrain query ran on data that was not final. */
  private stepMember(rec: Rec, ut0: number, utNew: number, dt: number, born: Rec[]): boolean {
    if (rec.mode === 'armed') {
      this.stepArmed(rec, ut0, utNew);
      return false;
    }
    const pre = this.preStep(rec, ut0);
    const res = stepVessel(rec.vessel, pre.env, this.controlsOf(rec), dt, this.stepOptions());
    return this.postStep(rec, pre, res, ut0, utNew, dt, born);
  }

  /** What follows a member's step: events, new vessels, a destroyed vessel, the state machine, the terrain accounting. */
  private postStep(rec: Rec, pre: { env: IslandEnv; must: boolean; parts: number; id: string }, res: StepResult, ut0: number, utNew: number, dt: number, born: Rec[]): boolean {
    const v = rec.vessel;
    if (v.id !== pre.id) this.renamed(rec, pre.id);
    const env = pre.env;
    const must = pre.must;
    if (res.path === 'free') this.counters.freeSteps++;
    else if (res.path === 'substep') {
      if (res.probeNear) this.counters.probeSubsteps++;
      else this.counters.pairSubsteps++;
    }
    for (const ev of res.events) this.report.events.push(ev);
    if (res.records) this.reportRecords(rec, res.records);
    for (const s of res.spawned) born.push(this.adopt(s, rec));
    if (v.parts.length !== pre.parts) rec.controllable = isControllable(v);
    if (v.destroyed || v.parts.length === 0) {
      const burned = res.events.some((x) => x.type === 'partDestroyed' && x.cause === 'overheat');
      this.depart(rec, burned ? 'burnedUp' : 'impact', utNew);
      return false;
    }
    if (rec.mode === 'rails') {
      this.advanceOnRails(rec, utNew);
    } else if (v.hold !== null) {
      rec.mode = 'landed';
      rec.coastTime = 0;
      rec.forceIntegrate = false;
    } else {
      if (rec.mode === 'landed') {
        rec.mode = 'integrated';
        this.report.replan.push(v.id);
      }
      if (must) {
        rec.coastTime = 0;
        if (rec.forceIntegrate && this.inBci(rec, utNew, () => vesselNeedsIntegration(v, env))) rec.forceIntegrate = false;
      } else {
        rec.coastTime += dt;
        if (rec.coastTime >= COAST_TIME_TO_RAILS) this.toRails(rec, utNew);
      }
    }
    // Terrain data accounting: contact probes ran, or the vessel is in the terrain regime.
    if (v.hold === null && this.frames.base(this.bodyId).hasTerrain) {
      const st = structureOf(v);
      if (rec.terrainRegime || v.groundClearance < 10 + 2 * st.boundingRadius) {
        const dirFixed = quat.rotateInv(env.qFixedToInertial, v3.normalize(this.posOf(rec, utNew)));
        if (!this.policy.isFinalAt(this.bodyId, dirFixed)) return true;
      }
    }
    return false;
  }

  /** A vessel a member brought into being: it flies on with the sample of the vessel it left, and the two ignore each other until they are clear. */
  private adopt(vessel: Vessel, parent: Rec): Rec {
    const rec = this.newRec(vessel, { bornTick: this.tick });
    this.insert(rec);
    this.sunToEnv(rec);
    this.report.arrivals.push({ vesselId: vessel.id, fromVesselId: parent.vessel.id });
    for (const other of this.report.arrivals) {
      if (other.fromVesselId !== parent.vessel.id || other.vesselId === vessel.id) continue;
      this.nascentPairs.push(orderedPair(other.vesselId, vessel.id));
    }
    this.nascentPairs.push(orderedPair(parent.vessel.id, vessel.id));
    return rec;
  }

  private depart(rec: Rec, reason: Departure['reason'], ut: number): void {
    if (rec.removed) return;
    const pos = this.posOf(rec, this.ut);
    const dirFixed = quat.rotateInv(this.frames.orientAt(this.bodyId, ut), v3.normalize(pos));
    const wasAnchor = this.reference !== null && this.anchor() === rec;
    const d: Departure = {
      vesselId: rec.vessel.id,
      name: rec.vessel.name,
      ut,
      reason,
      bodyId: this.bodyId,
      latitude: Math.atan2(dirFixed.z, Math.hypot(dirFixed.x, dirFixed.y)),
      longitude: Math.atan2(dirFixed.y, dirFixed.x),
      vessel: rec.vessel,
      revision: rec.revision,
    };
    if (this.reference !== null) {
      rec.vessel.r = v3.clone(pos);
      rec.vessel.v = v3.clone(this.velOf(rec, this.ut));
    }
    this.detach(rec);
    this.report.departures.push(d);
    if (reason === 'burnedUp' || reason === 'impact') this.report.events.push({ type: 'vesselRemoved', ut, vesselId: d.vesselId, reason });
    if (this.reference !== null) {
      if (this.recs.length === 0) this.setReference(null);
      else if (wasAnchor) this.rebase(this.ut, 'anchor');
    }
  }

  private reportRecords(rec: Rec, records: readonly StructuralRecord[]): void {
    for (const r of records) {
      const op = opFromRecord(r, rec.slot);
      this.report.ops.push({ tick: this.tick, body: op, checksum: rec.vessel.destroyed || rec.vessel.parts.length === 0 ? null : checksumOfVessel(rec.vessel) });
    }
  }

  // ------------------------------------------------------------------------------------ the pair pass

  setPairHook(hook: PairHook): void {
    this.hook = hook;
  }

  private exempt(a: string, b: string): boolean {
    for (const p of this.nascentPairs) if (p.a === a && p.b === b) return true;
    for (const p of this.clearingPairs) if (p.a === a && p.b === b) return true;
    return false;
  }

  /**
   * The pairs the hook puts in the contact regime at this tick, and the groups they connect. A pair switches
   * as a pair: both vessels take the sub-stepped path in the same tick and leave it in the same tick.
   */
  private pairGroups(): (Map<Rec, Rec[]> & { pairs: [Rec, Rec][] }) | null {
    if (this.hook === FREE_HOOK || this.recs.length < 2) return null;
    const pairs: [Rec, Rec][] = [];
    for (let i = 0; i < this.recs.length; i++) {
      const a = this.recs[i]!;
      if (a.tier !== 'full') continue;
      for (let j = i + 1; j < this.recs.length; j++) {
        const b = this.recs[j]!;
        if (b.tier !== 'full' || this.exempt(a.vessel.id, b.vessel.id)) continue;
        if (this.hook.regime(a, b, this.tick) === 'contact') pairs.push([a, b]);
      }
    }
    if (pairs.length === 0) return null;
    // Connected components over the pairs, each in id order.
    const root = new Map<Rec, Rec>();
    const find = (r: Rec): Rec => {
      let x = r;
      while (root.get(x) !== undefined && root.get(x) !== x) x = root.get(x)!;
      return x;
    };
    for (const [a, b] of pairs) {
      if (!root.has(a)) root.set(a, a);
      if (!root.has(b)) root.set(b, b);
      const ra = find(a);
      const rb = find(b);
      if (ra !== rb) root.set(byId(ra.vessel.id, rb.vessel.id) < 0 ? rb : ra, byId(ra.vessel.id, rb.vessel.id) < 0 ? ra : rb);
    }
    const groups = new Map<Rec, Rec[]>() as Map<Rec, Rec[]> & { pairs: [Rec, Rec][] };
    const byRoot = new Map<Rec, Rec[]>();
    for (const rec of this.recs) {
      if (!root.has(rec)) continue;
      const r = find(rec);
      let g = byRoot.get(r);
      if (!g) byRoot.set(r, (g = []));
      g.push(rec);
      groups.set(rec, g);
    }
    groups.pairs = pairs;
    return groups;
  }

  /**
   * One step of a group in the contact regime: every vessel takes the sub-stepped path, and the sub-steps of
   * all of them advance together, with the pair pass between the force evaluation and the integration.
   */
  private stepGroup(group: Rec[], pairs: [Rec, Rec][], ut0: number, utNew: number, dt: number, born: Rec[]): boolean {
    const pres = group.map((rec) => {
      // A member of a pair in the contact regime is integrated, whatever else holds.
      if (rec.vessel.hold === null) rec.forceIntegrate = true;
      return this.preStep(rec, ut0);
    });
    const runs: (SubstepRun | null)[] = group.map(() => null);
    const results: StepResult[] = [];
    const lockstep = (): void => {
      let count = 0;
      for (const run of runs) if (run) count = run.count;
      for (let i = 0; i < count; i++) {
        for (const run of runs) if (run) substepForces(run, i);
        for (const [a, b] of pairs) {
          const ia = group.indexOf(a);
          const ib = group.indexOf(b);
          if (ia >= 0 && ib >= 0) this.hook.solve(a, b, runs[ia]!, runs[ib]!, this.tick, i);
        }
        for (const run of runs) if (run) substepIntegrate(run, i);
      }
    };
    // Each vessel's step is entered in turn and stays open while the others enter theirs; the sub-steps of
    // all run inside the innermost, and every step then finishes with its own vessel.
    const enter = (k: number): void => {
      if (k === group.length) {
        lockstep();
        return;
      }
      const rec = group[k]!;
      let entered = false;
      results[k] = stepVessel(
        rec.vessel,
        pres[k]!.env,
        this.controlsOf(rec),
        dt,
        this.stepOptions({
          pairContact: true,
          lockstep: (run) => {
            entered = true;
            runs[k] = run;
            enter(k + 1);
          },
        }),
      );
      // A vessel that did not come to its sub-steps (held on the body, or gone): the others go on without it.
      if (!entered) enter(k + 1);
    };
    enter(0);
    let incomplete = false;
    for (let k = 0; k < group.length; k++) if (this.postStep(group[k]!, pres[k]!, results[k]!, ut0, utNew, dt, born)) incomplete = true;
    return incomplete;
  }

  setNascent(pair: PairRef, on: boolean): void {
    const p = orderedPair(pair.a, pair.b);
    this.nascentPairs = this.nascentPairs.filter((x) => !(x.a === p.a && x.b === p.b));
    if (on) this.nascentPairs.push(p);
    this.nascentPairs.sort((x, y) => byId(x.a, y.a) || byId(x.b, y.b));
  }

  setClearing(pair: ClearingPair | PairRef, on: boolean): void {
    const p = orderedPair(pair.a, pair.b);
    this.clearingPairs = this.clearingPairs.filter((x) => !(x.a === p.a && x.b === p.b));
    if (on) this.clearingPairs.push({ ...p, sinceTick: 'sinceTick' in pair ? pair.sinceTick : this.tick });
    this.clearingPairs.sort((x, y) => byId(x.a, y.a) || byId(x.b, y.b));
  }

  setCapture(constraint: CaptureConstraint | PairRef, on: boolean): void {
    const p = orderedPair(constraint.a, constraint.b);
    this.captures = this.captures.filter((x) => !(x.a === p.a && x.b === p.b));
    if (on && 'state' in constraint) {
      const swap = p.a !== constraint.a;
      this.captures.push({ a: p.a, b: p.b, aPort: swap ? constraint.bPort : constraint.aPort, bPort: swap ? constraint.aPort : constraint.bPort, state: constraint.state.slice(), clampTicks: constraint.clampTicks, ageTicks: constraint.ageTicks, dwellTicks: constraint.dwellTicks });
    }
    this.captures.sort((x, y) => byId(x.a, y.a) || byId(x.b, y.b));
  }

  // ------------------------------------------------------------------------------- periodic upkeep

  /** Control-tick cadence, after the step: the hand-over of an integrated anchor and the armed margins. */
  private upkeep(): void {
    this.checkSoiIntegrated();
    this.refreshMargins();
    this.clearNascent();
    this.watchThresholds();
  }

  /**
   * The armed margin (ARCHITECTURE 6.2): free members closer to each other than `armedMarginBase +
   * armedClosingTime x closing speed`, between their bounding spheres, are integrated (Full tier). A
   * quiescent member that nobody attends and that is outside the margin of every other member is ARMED:
   * not stepped at all, on its conic, looked at by this test alone. A pair with an Armed member is tested
   * every `ARMED_TEST_TICKS` (the swept test: the margin's closing term covers the travel between two
   * tests twenty times over); every other pair at every control tick.
   */
  refreshMargins(): void {
    const claim = this.deps.rules.claim;
    const armedTick = this.tick % ARMED_TEST_TICKS === 0;
    const free: Rec[] = [];
    for (const rec of this.recs) {
      // A flag found by the armed test stands until the next one.
      if (rec.mode !== 'armed' || armedTick) rec.nearOther = false;
      if (rec.vessel.hold === null) free.push(rec);
    }
    for (let i = 0; i < free.length; i++) {
      for (let j = i + 1; j < free.length; j++) {
        const p = free[i]!;
        const q = free[j]!;
        if ((p.mode === 'armed' || q.mode === 'armed') && !armedTick) continue;
        if (p.mode === 'armed' || q.mode === 'armed') this.counters.armedTests++;
        const dx = q.vessel.r.x - p.vessel.r.x;
        const dy = q.vessel.r.y - p.vessel.r.y;
        const dz = q.vessel.r.z - p.vessel.r.z;
        const range = Math.sqrt(dx * dx + dy * dy + dz * dz);
        const gap = range - structureOf(p.vessel).boundingRadius - structureOf(q.vessel).boundingRadius;
        let margin = claim.armedMarginBase;
        if (gap >= margin && range > 0) {
          // Closing speed along the line between the two (positive = approaching).
          const closing = -((q.vessel.v.x - p.vessel.v.x) * dx + (q.vessel.v.y - p.vessel.v.y) * dy + (q.vessel.v.z - p.vessel.v.z) * dz) / range;
          if (closing > 0) margin += claim.armedClosingTime * closing;
        }
        if (gap < margin) {
          p.nearOther = true;
          q.nearOther = true;
        }
      }
    }
    for (const rec of this.recs) {
      if (rec.mode === 'armed') {
        // Inside a margin, or attended again: back to the Full tier (on rails until the next step integrates it).
        if (rec.nearOther || rec.attended || rec.pilot !== null) {
          rec.mode = 'rails';
          rec.tier = 'full';
        }
      } else if (rec.mode === 'rails' && !rec.attended && rec.pilot === null && !rec.nearOther && rec.orbit !== null) {
        rec.mode = 'armed';
        rec.tier = 'armed';
        rec.previous = null;
      }
    }
  }

  /** One tick of an Armed member: nothing is stepped. It is placed on its conic, and an event of the conic takes it back to the Full tier. */
  private stepArmed(rec: Rec, ut0: number, utNew: number): void {
    // The sun sample at a tenth of the rate, as for every vessel that is not stepped.
    if (this.tick % (SUN_SAMPLE_TICKS * 10) === 0) this.refreshSun(rec, ut0);
    const ev = rec.railsEvent;
    if (ev && ev.ut <= utNew) {
      rec.mode = 'rails';
      rec.tier = 'full';
      this.advanceOnRails(rec, utNew);
      return;
    }
    this.placeCom(rec, railsStateAt(rec.orbit!, utNew), utNew);
  }

  /** Pairs born overlapping stop ignoring each other once their bounding spheres are clear by the rules' clearance. */
  private clearNascent(): void {
    if (this.nascentPairs.length === 0) return;
    const clearance = this.deps.rules.contact.nascentClearance;
    this.nascentPairs = this.nascentPairs.filter((p) => {
      const a = this.rec(p.a);
      const b = this.rec(p.b);
      if (!a || !b) return false;
      // Clear bounding spheres settle it; inside them the colliders are asked.
      if (v3.dist(a.vessel.r, b.vessel.r) - structureOf(a.vessel).boundingRadius - structureOf(b.vessel).boundingRadius >= clearance) return false;
      return vesselClearance(a.vessel, b.vessel) < clearance;
    });
  }

  private watchThresholds(): void {
    for (const rec of this.recs) rec.thresholdWatch = rec.mode === 'integrated' && underThresholdWatch(rec.vessel);
  }

  thresholdWatch(): boolean {
    for (const rec of this.recs) if (rec.thresholdWatch) return true;
    return false;
  }

  // ------------------------------------------------------------------------------------- terrain

  hintImpact(vesselId: string, point: { bodyId: string; latitude: number; longitude: number } | null): void {
    if (point === null) {
      this.impactHints.delete(vesselId);
      return;
    }
    this.impactHints.set(vesselId, point);
    this.policy.track(`impact:${vesselId}`, point.bodyId, this.frames.info(point.bodyId).radius, dirFromLatLon(point.latitude, point.longitude), IMPACT_DISC_RADIUS, IMPACT_REFRESH_DISTANCE);
  }

  terrainPending(): Promise<void> | null {
    return this.policy.pending();
  }

  terrainFinalUnder(vesselId: string): boolean {
    const rec = this.rec(vesselId);
    if (!rec || !this.frames.base(this.bodyId).hasTerrain) return true;
    return this.policy.isFinalAt(this.bodyId, quat.rotateInv(this.frames.orientAt(this.bodyId, this.ut), v3.normalize(this.posOf(rec, this.ut))));
  }

  /** Work done at tick boundaries on the control-tick cadence: the terrain regime of every member, the discs under them, collision warming. */
  terrainWork(): void {
    const base = this.frames.base(this.bodyId);
    const terrain = this.deps.rules.terrain;
    const ut = this.ut;
    for (const rec of this.recs) {
      if (!base.hasTerrain) {
        rec.terrainRegime = false;
        continue;
      }
      const v = rec.vessel;
      const r = this.posOf(rec, ut);
      const rl = v3.len(r);
      const alt = rl - base.info.radius;
      let regime = false;
      let radar = Infinity;
      let dirFixed: Vec3 | null = null;
      const maxElevation = base.def.terrain!.maxElevation;
      if (alt < Math.max(terrain.requestAltitude, maxElevation + terrain.requestRadarAltitude + 100)) {
        dirFixed = quat.rotateInv(this.frames.orientAt(this.bodyId, ut), v3.scale(r, 1 / rl));
        if (v.hold !== null) {
          regime = true;
          radar = 0;
        } else {
          const vel = this.velOf(rec, ut);
          const sp = base.info.spin;
          const gx = vel.x - (sp.y * r.z - sp.z * r.y);
          const gy = vel.y - (sp.z * r.x - sp.x * r.z);
          const gz = vel.z - (sp.x * r.y - sp.y * r.x);
          const ground = Math.hypot(gx, gy, gz);
          let surface = this.deps.terrain.heightAt(this.bodyId, dirFixed, Math.max(0.3, 0.02 * Math.max(alt, 0)));
          if (base.def.ocean) surface = Math.max(surface, base.seaLevel);
          radar = alt - surface;
          regime = radar < terrain.requestRadarAltitude || (alt < terrain.requestAltitude && ground < terrain.requestSpeed);
        }
      }
      rec.terrainRegime = regime;
      if (regime && rec.controllable && dirFixed) {
        this.policy.track(`vessel:${v.id}`, this.bodyId, base.info.radius, dirFixed, VESSEL_DISC_RADIUS, VESSEL_REFRESH_DISTANCE);
      }
      if (this.seatFor(rec) && regime && dirFixed && v.hold === null && radar < PREWARM_RADAR_ALTITUDE) {
        this.deps.terrain.prewarmCollision(this.bodyId, this.touchdownPoint(rec, dirFixed, radar), Math.min(40, 12 + 0.02 * radar), PREWARM_BUDGET);
      }
    }
  }

  /** Body-fixed direction of where a member is heading for the ground (short ballistic look-ahead). */
  private touchdownPoint(rec: Rec, dirFixed: Vec3, radar: number): Vec3 {
    const base = this.frames.base(this.bodyId);
    const r = this.posOf(rec, this.ut);
    const sp = base.info.spin;
    const g = v3.sub(this.velOf(rec, this.ut), v3.cross(sp, r));
    const up = v3.normalize(r);
    const vz = v3.dot(g, up);
    const horiz = v3.reject(g, up);
    const t = vz < -0.5 ? Math.min(20, radar / -vz) : 0;
    if (t <= 0 || v3.len(horiz) < 0.05) return dirFixed;
    const ahead = quat.rotateInv(this.frames.orientAt(this.bodyId, this.ut), v3.scale(horiz, t / base.info.radius));
    return v3.normalize(v3.add(dirFixed, ahead));
  }

  // ----------------------------------------------------------------------------------- rails advance

  advanceTo(tick: number): AdvanceReport {
    this.throwIfBroken();
    this.begin();
    let landing = tick;
    if (this.mergeTick !== null) landing = Math.min(landing, this.mergeTick);
    const next = this.nextEvent();
    if (next) landing = Math.min(landing, next.tick);
    if (!(landing > this.tick) || this.mustIntegrate()) return this.end();
    this.applyQueued();
    const target = utOfTick(landing);
    this.terrainWork();
    if (!this.railsWarp) this.enterRailsWarp();
    const dtAdvance = (landing - this.tick) * PHYSICS_DT;
    const before = this.ut;
    // Every free member is on its conic before any of them moves (a hand-over on the way takes them all).
    for (const rec of this.recs) if (rec.vessel.hold === null && rec.orbit === null) this.toRails(rec, before);
    for (const rec of this.recs.slice()) {
      if (rec.removed) continue;
      const v = rec.vessel;
      if (v.hold !== null) {
        rideBody(v, this.envAt(rec, target), 0);
        this.refreshSun(rec, target);
        continue;
      }
      const seat = this.seatFor(rec);
      const holdBefore = rec.trackHold && seat ? this.sasHoldDirection(rec, seat, before) : null;
      // Attitude: frozen, tracking the SAS hold direction, or (still turning) carried on at its body rate.
      if (!rec.trackHold && v3.len(v.w) > 0) {
        v.q = quat.normalize(quat.mul(v.q, quat.fromRotVec(v3.scale(v.w, dtAdvance))));
      }
      this.advanceOnRails(rec, target);
      this.refreshSun(rec, target);
      if (holdBefore && seat) {
        const holdAfter = this.sasHoldDirection(rec, seat, target);
        if (holdAfter) {
          const com = comStateOf(v);
          v.q = quat.normalize(quat.mul(quat.fromTo(holdBefore, holdAfter), v.q));
          setFromCom(v, com.r, com.v);
        }
      }
      rec.previous = null;
    }
    this.tick = landing;
    this.stampAges();
    this.counters.railsAdvances++;
    this.upkeep();
    return this.end();
  }

  private enterRailsWarp(): void {
    this.railsWarp = true;
    for (const rec of this.recs) {
      const v = rec.vessel;
      rec.trackHold = false;
      if (v.hold !== null) continue;
      const com = comStateOf(v);
      const seat = this.seatFor(rec);
      if (seat) {
        const dir = this.sasHoldDirection(rec, seat, this.ut);
        if (dir && v.sas.enabled && v3.angle(quat.rotate(v.q, { x: 0, y: 1, z: 0 }), dir) < SAS_TRACK_ERROR) rec.trackHold = true;
      }
      // Slow residual rates are stopped (frozen attitude); a vessel that is really turning keeps its rate.
      if (rec.trackHold || v3.len(v.w) < ROTATION_WARP_LIMIT) {
        v.w.x = v.w.y = v.w.z = 0;
        setFromCom(v, com.r, com.v);
      }
    }
  }

  // ------------------------------------------------------------------------------------------ inputs

  applyInput(input: IslandInput): InputReceipt {
    if (!Number.isFinite(input.tick)) return { appliedTick: this.tick, accepted: false, reason: 'Invalid tick' };
    if (input.tick > this.tick) {
      this.queue.push(input);
      return { appliedTick: input.tick, accepted: true };
    }
    return this.applyNow(input);
  }

  /** The inputs stamped for the island's tick, in the order (account, sequence). */
  private applyQueued(): void {
    if (this.queue.length === 0) return;
    const due = this.queue.filter((i) => i.tick <= this.tick);
    if (due.length === 0) return;
    this.queue = this.queue.filter((i) => i.tick > this.tick);
    due.sort((a, b) => a.tick - b.tick || byId(a.accountId, b.accountId) || a.seq - b.seq);
    const outer = this.report;
    for (const input of due) {
      const receipt = this.applyNow(input);
      if (receipt.outcome) outer.commands.push(receipt.outcome);
      if (receipt.report) mergeReports(outer, receipt.report);
    }
    this.report = outer;
  }

  private applyNow(input: IslandInput): InputReceipt {
    const appliedTick = this.tick;
    const refuse = (reason: string): InputReceipt => ({ appliedTick, accepted: false, reason });
    const ok: InputReceipt = { appliedTick, accepted: true };
    switch (input.kind) {
      case 'controls': {
        const seat = this.seats.get(input.accountId);
        if (!seat || seat.vesselId !== input.vesselId) return refuse('Not at the helm');
        seat.controls = clampControls(input.controls);
        seat.sasHold = input.sasHold ? v3.clone(input.sasHold) : null;
        return ok;
      }
      case 'reference': {
        const seat = this.seats.get(input.accountId);
        if (!seat || seat.vesselId !== input.vesselId) return refuse('Not at the helm');
        seat.reference = input.reference;
        return ok;
      }
      case 'command': {
        const rec = this.rec(input.vesselId);
        const seat = this.seats.get(input.accountId);
        if (!rec) return refuse('No vessel');
        if (!seat || seat.vesselId !== input.vesselId) return refuse('Not at the helm');
        const saved = this.report;
        this.report = emptyReport();
        const result = this.command(rec, input.command);
        const report = this.report;
        this.report = saved;
        const outcome: CommandOutcome = { accountId: input.accountId, seq: input.seq, vesselId: input.vesselId, tick: appliedTick, ok: result === null };
        if (result !== null) outcome.reason = result;
        return { appliedTick, accepted: true, outcome, report };
      }
      case 'seat': {
        const rec = this.rec(input.vesselId);
        if (!rec) return refuse('No vessel');
        if (input.aboard) {
          const old = this.seats.get(input.accountId);
          if (old) {
            const prev = this.rec(old.vesselId);
            if (prev && prev.pilot === input.accountId) prev.pilot = null;
            old.vesselId = rec.vessel.id;
          } else this.seats.set(input.accountId, this.newSeat(input.accountId, rec));
          rec.pilot = input.accountId;
          rec.attended = true;
          if (rec.mode === 'armed') {
            rec.mode = 'rails';
            rec.tier = 'full';
          }
        } else {
          if (rec.pilot === input.accountId) rec.pilot = null;
          rec.attended = false;
          this.seats.delete(input.accountId);
        }
        return ok;
      }
      case 'helm': {
        const rec = this.rec(input.vesselId);
        if (!rec) return refuse('No vessel');
        const v = rec.vessel;
        v.helm.accountId = input.pilot;
        if (input.craftId !== null) {
          const craft = v.crafts.findIndex((c) => c.craftId === input.craftId);
          if (craft < 0) return refuse('No such craft');
          v.helm.craft = craft;
        }
        if (input.controlPartKey !== null) {
          const part = v.parts.findIndex((p) => `${v.crafts[p.craft]!.craftId}/${p.instanceId}` === input.controlPartKey);
          if (part < 0) return refuse('No such part');
          v.helm.controlPart = part;
        }
        if (rec.pilot !== null && rec.pilot !== input.pilot) this.seats.delete(rec.pilot);
        rec.pilot = input.pilot;
        if (input.pilot !== null && !this.seats.has(input.pilot)) this.seats.set(input.pilot, this.newSeat(input.pilot, rec));
        this.report.events.push({ type: 'helmChanged', ut: this.ut, vesselId: v.id, accountId: input.pilot, callsign: null, craftId: v.crafts[v.helm.craft]!.craftId });
        return ok;
      }
      case 'add': {
        const saved = this.report;
        this.report = emptyReport();
        const vessel = decodeBlob(this, input.vessel, 'raw');
        if (this.rec(vessel.id)) {
          this.report = saved;
          return refuse('Already a member');
        }
        this.add(vessel, { bornTick: input.bornTick, admittedFromHead: input.admittedFromHead });
        vessel.age = (this.tick - input.bornTick) / TICKS_PER_SECOND;
        this.report.arrivals.push({ vesselId: vessel.id, fromVesselId: vessel.id });
        const report = this.report;
        this.report = saved;
        return { appliedTick, accepted: true, report };
      }
      case 'remove': {
        const rec = this.rec(input.vesselId);
        if (!rec) return refuse('No vessel');
        const saved = this.report;
        this.report = emptyReport();
        this.depart(rec, input.reason, this.ut);
        const report = this.report;
        this.report = saved;
        return { appliedTick, accepted: true, report };
      }
      case 'reservation': {
        const rec = this.rec(input.vesselId);
        if (!rec) return refuse('No vessel');
        rec.reservation = input.state;
        return ok;
      }
      case 'destruct': {
        const rec = this.rec(input.vesselId);
        if (!rec) return refuse('No vessel');
        const saved = this.report;
        this.report = emptyReport();
        const parts = rec.vessel.parts.map((_, i) => i);
        this.applyOp({ op: 'destroy', slot: rec.slot, parts, cause: 'explosion' });
        const report = this.report;
        this.report = saved;
        return { appliedTick, accepted: true, report };
      }
      case 'timer': {
        const rec = this.rec(input.vesselId);
        const seat = this.seats.get(input.accountId);
        if (!rec) return refuse('No vessel');
        if (!seat && input.timer !== 'graceEnd') return refuse('No such pilot');
        switch (input.timer) {
          case 'socketLost':
            seat!.latchOpenTick = this.tick;
            break;
          case 'socketBack':
            seat!.latchOpenTick = null;
            break;
          case 'latchEnd':
            seat!.controls = cloneControls(NEUTRAL_CONTROLS);
            break;
          case 'deadManRotation': {
            const c = seat!.controls;
            c.pitch = c.yaw = c.roll = 0;
            c.translate.x = c.translate.y = c.translate.z = 0;
            break;
          }
          case 'deadManThrottle':
            seat!.controls.throttle = 0;
            break;
          case 'graceEnd':
            rec.attended = false;
            if (rec.pilot === input.accountId) rec.pilot = null;
            this.seats.delete(input.accountId);
            break;
        }
        return ok;
      }
      case 'rate':
        if (!(input.rate >= 0)) return refuse('Invalid rate');
        this.rate = input.rate;
        return ok;
      case 'mergeAt':
        this.mergeTick = input.mergeTick;
        return ok;
    }
  }

  /** Execute a seat's command on its vessel now. Returns null when it was done, else why not (the words of v1's commands). */
  private command(rec: Rec, c: IslandCommand): string | null {
    const v = rec.vessel;
    const ut = this.ut;
    switch (c.kind) {
      case 'stage':
      case 'abort': {
        const env = this.envAt(rec, ut);
        const res = c.kind === 'stage' ? fireNextStage(v, env) : abortVessel(v, env);
        if (!res.ok) return res.reason ?? (c.kind === 'stage' ? 'Staging refused' : 'Abort refused');
        for (const ev of res.events) this.report.events.push(ev);
        for (const s of res.spawned) this.adopt(s, rec);
        this.afterStructureChange(rec);
        return null;
      }
      case 'sas':
        if (c.on && !structureOf(v).sasAvailable) return 'No SAS on this vessel';
        setSasEnabled(v, c.on);
        return null;
      case 'sasMode':
        setSasMode(v, c.mode);
        return null;
      case 'rcs':
        setRcsEnabled(v, c.on);
        return null;
      case 'legs': {
        const evs = toggleLegs(v, ut);
        if (evs.length === 0) return 'No landing legs';
        for (const ev of evs) this.report.events.push(ev);
        return null;
      }
      case 'lights':
        setLights(v, !v.lightsOn);
        return null;
      case 'fineControl':
        setFineControl(v, c.on);
        return null;
    }
  }

  private afterStructureChange(rec: Rec): void {
    rec.controllable = isControllable(rec.vessel);
    if (rec.vessel.hold === null && rec.mode === 'rails') {
      rec.mode = 'integrated';
      rec.orbit = null;
      rec.railsEvent = null;
    }
    rec.coastTime = 0;
  }

  // -------------------------------------------------------------------------------------- operations

  applyOp(op: IslandOp): IslandOpChecksum | null {
    return applyIslandOp(this, op);
  }

  checksumOf(vesselId: string): IslandOpChecksum | null {
    const rec = this.rec(vesselId);
    return rec ? checksumOfVessel(rec.vessel) : null;
  }

  /** The operations module's way in: the pieces of `applyOp` that touch the island's own lists. */
  readonly opAccess = {
    adopt: (vessel: Vessel, parent: Rec): Rec => this.adopt(vessel, parent),
    depart: (rec: Rec, reason: Departure['reason']): void => this.depart(rec, reason, this.ut),
    afterStructureChange: (rec: Rec): void => this.afterStructureChange(rec),
    pushEvents: (events: readonly SimEvent[]): void => {
      for (const e of events) this.report.events.push(e);
    },
    pushOp: (op: AppliedOp): void => {
      this.report.ops.push(op);
    },
    arrive: (vesselId: string): void => {
      this.report.arrivals.push({ vesselId, fromVesselId: vesselId });
    },
    envOf: (rec: Rec): IslandEnv => this.envAt(rec, this.ut),
    rebaseTo: (state: { r: Vec3; v: Vec3 }): void => {
      // A replica's rebase: the offsets move by the difference of the two reference points at the tick.
      const ut = this.ut;
      const old = this.reference !== null ? this.refAt(ut) : { r: v3.zero(), v: v3.zero() };
      const delta = { r: v3.sub(old.r, state.r), v: v3.sub(old.v, state.v) };
      for (const rec of this.recs) {
        rec.vessel.r = v3.add(rec.vessel.r, delta.r);
        rec.vessel.v = v3.add(rec.vessel.v, delta.v);
        rec.previous = null;
      }
      this.setReference({ r0: v3.clone(state.r), v0: v3.clone(state.v), tick: this.tick });
    },
  };

  // ------------------------------------------------------------------------------------------- reach

  reach(point: { r: Vec3; v: Vec3; radius: number }, exceptId?: string): Reach {
    const claim = this.deps.rules.claim;
    let best: Reach = { distance: Infinity, closingSpeed: 0, joinDistance: claim.joinDistanceBase, joins: false, parted: true, tau: Infinity, vesselId: null };
    const ut = this.ut;
    for (const rec of this.recs) {
      if (rec.vessel.id === exceptId) continue;
      const r: Reach = { ...pairReach(claim, point, { r: this.posOf(rec, ut), v: this.velOf(rec, ut), radius: structureOf(rec.vessel).boundingRadius }), vesselId: rec.vessel.id };
      if (r.tau < best.tau || (r.tau === best.tau && r.distance < best.distance)) best = { ...r, parted: best.parted && r.parted };
      else best.parted = best.parted && r.parted;
    }
    return best;
  }

  // -------------------------------------------------------------------------------------------- codec

  encode(options?: { names?: boolean }): Uint8Array {
    return encodeIsland(this, options?.names ?? true);
  }

  hash(): string {
    return islandHash(encodeIsland(this, false));
  }
}

/** Fold the report of an input that was applied at once into the report of the advance it happened in. */
function mergeReports(into: AdvanceReport, from: AdvanceReport): void {
  for (const e of from.events) into.events.push(e);
  for (const o of from.ops) into.ops.push(o);
  for (const c of from.commands) into.commands.push(c);
  for (const d of from.departures) into.departures.push(d);
  for (const a of from.arrivals) into.arrivals.push(a);
  for (const id of from.replan) into.replan.push(id);
  if (from.frameChange) into.frameChange = from.frameChange;
}

function clampControls(inputs: ControlInputs): ControlInputs {
  const c = cloneControls(inputs);
  const clampUnit = (x: number): number => (Number.isFinite(x) ? Math.max(-1, Math.min(1, x)) : 0);
  c.pitch = clampUnit(c.pitch);
  c.yaw = clampUnit(c.yaw);
  c.roll = clampUnit(c.roll);
  c.translate.x = clampUnit(c.translate.x);
  c.translate.y = clampUnit(c.translate.y);
  c.translate.z = clampUnit(c.translate.z);
  c.throttle = Number.isFinite(c.throttle) ? Math.max(0, Math.min(1, c.throttle)) : 0;
  return c;
}

/** Fractions of the threshold watch (ARCHITECTURE 6.2): within 10 % of a temperature limit, above 80 % of a joint limit, a probe within 2 s of the ground. */
export const WATCH_TEMPERATURE_FRACTION = 0.9;
export const WATCH_JOINT_FRACTION = 0.8;
export const WATCH_GROUND_TIME = 2;

/** True when a vessel is close to a threshold outcome (ARCHITECTURE 6.2, "threshold watch"). */
export function underThresholdWatch(v: Vessel): boolean {
  const st = structureOf(v);
  if (v.gLoad > WATCH_JOINT_FRACTION * st.minJointG) return true;
  for (const p of v.parts) {
    if (p.stress > 0) return true;
    const surfaces = p.def.thermal?.surfaces;
    if (surfaces) for (let k = 0; k < surfaces.length; k++) if (p.temps[k]! > WATCH_TEMPERATURE_FRACTION * surfaces[k]!.maxTemp) return true;
    for (const m of p.modules) if (m.type === 'parachute' && (m.state === 'reefed' || m.state === 'full') && m.envelope !== null && m.envelope !== 'safe') return true;
  }
  if (Number.isFinite(v.groundClearance)) {
    // Descent rate from the last step's clearance is not kept: the vessel's speed bounds it.
    const speed = v3.len(v.aero.airVelocity);
    if (v.groundClearance < WATCH_GROUND_TIME * Math.max(speed, 1)) return true;
  }
  return false;
}

/**
 * Reach between two spheres about one body (ARCHITECTURE 6.2 `tau`, 7.3): the distance between them, the
 * closing speed along the line, the join distance of the pair, and whether they join or have parted.
 */
export function pairReach(claim: IslandDeps['rules']['claim'], a: { r: Vec3; v: Vec3; radius: number }, b: { r: Vec3; v: Vec3; radius: number }): Omit<Reach, 'vesselId'> {
  const d = v3.sub(b.r, a.r);
  const range = v3.len(d);
  const distance = range - a.radius - b.radius;
  const closingSpeed = range > 0 ? -v3.dot(d, v3.sub(b.v, a.v)) / range : 0;
  const joinDistance = claim.joinDistanceBase + claim.joinClosingTime * Math.max(0, closingSpeed);
  return { distance, closingSpeed, joinDistance, joins: distance < joinDistance, parted: distance > claim.islandPartFactor * joinDistance, tau: reachTime(distance - joinDistance, closingSpeed, REACH_ACCELERATION) };
}

/** Time to close `gap` metres at `closingSpeed` with the worst-case mutual acceleration (ARCHITECTURE 6.2), s. */
export function reachTime(gap: number, closingSpeed: number, acceleration: number): number {
  if (gap <= 0) return 0;
  // gap = u t + a t^2 / 2 with u the closing speed (negative = opening): the positive root.
  const u = closingSpeed;
  return (-u + Math.sqrt(u * u + 2 * acceleration * gap)) / acceleration;
}
