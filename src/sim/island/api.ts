/**
 * The island API (docs/ARCHITECTURE.md 6.2, 7.1-7.4, 7.6; MIGRATION_V2 step 4.1a).
 *
 * An ISLAND is the unit of simulation: N vessels on one clock's tick grid, in one frame, stepped by one
 * loop on one thread. It knows no player, no socket, no storage and no clock other than its own tick:
 * EVERYTHING FROM OUTSIDE REACHES IT AS A TICK-STAMPED INPUT (`applyInput`) or as a structural operation
 * given as data (`applyOp`). The state of an island at a tick is a function of that tick, its vessels and
 * the island's own items of ARCHITECTURE 7.2 (what `encode` writes): there is no clock base, no phase of
 * the control tick and no phase of the sun sample to carry (src/sim/clock.ts).
 *
 * The same code is the shard's authority, the in-process universe's and the client's replica. Two step
 * modes: 'authoritative' produces every outcome; 'predict' suppresses threshold transitions (a part is
 * held at its limit, a canopy does not fail, a joint does not break, the crew is not lost) so that a
 * client never shows an outcome before the server's event (ARCHITECTURE 6.4).
 *
 * This file is types only and is what `universe-directory`, `netcode-client`, `server-persistence` and the
 * thin `World` host compile against. The functions are exported by ./index.ts with exactly the signatures
 * of `IslandFactory` below.
 *
 * FRAME. Every member's `Vessel.r`, `Vessel.v` are those of its VES origin in the island's frame: BCI of
 * `bodyId` when `reference` is null, and OFFSETS from the reference-orbit point (frame ISL) when it is
 * set. An island changes frame as a unit (the SOI hand-over, a rebase); nothing ever subtracts the states
 * of two members that were expressed about different origins.
 *
 * ORDER. Members are ordered by vessel id (code-unit order); a member's SLOT is its index in that order
 * at the tick. Inputs of one tick are applied in the order (tick, account id, sequence); operations in
 * the order they are given.
 */
import type { ControlInputs, SasMode } from '@/core/contracts/controls';
import type { DefLibrary } from '@/core/contracts/defs';
import type { IslandOpBody, IslandOpChecksum, UniverseRules } from '@/core/contracts/net';
import type { SimEvent } from '@/core/contracts/sim';
import type { VesselEnvironment } from '@/core/contracts/simInternal';
import type { TerrainProvider } from '@/core/contracts/terrain';
import type { Quat } from '@/core/math/quat';
import type { Vec3 } from '@/core/math/vec3';
import type { BodySystem } from '../bodies/bodySystem';
import type { SubstepRun } from '../dynamics/integrator';
import type { Orbit } from '../orbit/kepler';
import type { DefResolver, Vessel } from '../vessel';
import type { RailsEvent } from './rails';
import type { TerrainPolicy } from './terrainPolicy';

// ------------------------------------------------------------------------------------------ vocabulary

/** How an island steps (ARCHITECTURE 6.4, 7.1). */
export type StepMode = 'authoritative' | 'predict';

/**
 * The per-vessel state machine.
 *  - 'landed': held on the body (clamps, fixed to the ground, asleep); rides the rotating body.
 *  - 'rails': quiescent, on the conic of its centre of mass; no step cost between its events.
 *  - 'armed': quiescent and on its conic like 'rails', inside the island but farther than the armed margin
 *    from every other member; only the swept-sphere test at `ARMED_TEST_TICKS` looks at it.
 *  - 'integrated': stepped every tick (RK4 at 120 Hz; the sub-stepped path only as `SubstepReason` says).
 */
export type MemberMode = 'landed' | 'rails' | 'armed' | 'integrated';

/** The tier flag of a member (ARCHITECTURE 6.2, 7.2): Armed, or Full for every other mode. */
export type MemberTier = 'armed' | 'full';

/** Why a vessel took the sub-stepped path in a step: its own ground or water probe, or its pair. */
export type SubstepReason = 'probe' | 'pair';

/** What the island was created with. Nothing here is state: a decoded island is given the same. */
export interface IslandDeps {
  defs: DefLibrary;
  system: BodySystem;
  terrain: TerrainProvider;
  /** The rules document in force. Every number of the time model, contact, claim and terrain triggers is read from it. */
  rules: UniverseRules;
  /** Resolves the vehicle references of vessel blobs (`add`, `replace`, `decode`). Default: the library. */
  resolver?: DefResolver;
  /**
   * The terrain request policy the island pins its discs with. Default: one of its own. A host that holds
   * several islands over one terrain store, or that outlives its island, hands them its own.
   */
  policy?: TerrainPolicy;
}

/** The reference orbit of an island in the Sun's sphere of influence (frame ISL): an exact Kepler orbit about `bodyId`. */
export interface ReferenceOrbit {
  /** State of the reference point in BCI(bodyId) at `tick`; the orbit is evaluated from it (never accumulated). */
  r0: Vec3;
  v0: Vec3;
  tick: number;
}

/** One member as the host and the view read it. The vessel object is the island's live state: read it, never write it. */
export interface IslandMember {
  readonly vessel: Vessel;
  readonly slot: number;
  readonly mode: MemberMode;
  readonly tier: MemberTier;
  /** Orbit of the centre of mass in the island's frame body while the mode is 'rails' or 'armed'; null otherwise. */
  readonly orbit: Orbit | null;
  /** The next event of that conic (the end of its first patch); null = none, or not on a conic. */
  readonly railsEvent: RailsEvent | null;
  /** Account whose latched controls steer this vessel (the pilot at the helm); null = nobody: neutral controls. */
  readonly pilot: string | null;
  /** A connected pilot is aboard, or the server still carries the vessel for one (ARCHITECTURE 5.1, "attended"). */
  readonly attended: boolean;
  /** Tick the vessel came into being. `Vessel.age` is kept equal to (island tick - bornTick) / 120 for every member. */
  readonly bornTick: number;
  /** Changes when the vessel's orbit changes other than by coasting (`VesselSnapshot.revision`). */
  readonly revision: number;
  /** A command part with authority is aboard. */
  readonly controllable: boolean;
  /** The vessel is under a threshold watch (ARCHITECTURE 6.2): evaluated at control ticks. */
  readonly thresholdWatch: boolean;
  /** In the terrain regime (low, or slow near the ground): final terrain data must be resident under it. */
  readonly terrainRegime: boolean;
  /** Pose at the start of the last step of this member (presentation interpolation); null after anything but a step. */
  readonly previous: { r: Vec3; v: Vec3; q: Quat } | null;
  /** Attitude follows the SAS hold direction across a rails advance. */
  readonly trackHold: boolean;
  /** The head the member had as a passive vessel when it was admitted as a copy (ARCHITECTURE U4); null = not an admitted copy. */
  readonly admittedFromHead: number | null;
  /** Where the reservation of an admitted copy stands. */
  readonly reservation: ReservationState;
}

// ---------------------------------------------------------------------------------------------- inputs

/** Commands of a seat that the island executes this wave (the subset of `WireCommand` whose mechanics exist; contact-docking adds ports, undocking and transfers). */
export type IslandCommand =
  | { kind: 'stage' }
  | { kind: 'abort' }
  | { kind: 'sas'; on: boolean }
  | { kind: 'sasMode'; mode: SasMode }
  | { kind: 'rcs'; on: boolean }
  | { kind: 'legs' }
  | { kind: 'lights' }
  | { kind: 'fineControl'; on: boolean };

/** What the reservation of an admitted copy stands at (ARCHITECTURE U4). */
export type ReservationState = 'none' | 'requested' | 'granted' | 'denied';

/** Timer-derived inputs: the host turns up-time and wall-clock timers into "at tick k" (ARCHITECTURE 3, 7.2, U16). */
export type IslandTimer =
  /** The pilot's socket is declared lost: the latch and dead-man timers open (they run on up-time, outside). */
  | 'socketLost'
  /** The socket is back: the open timers close and the latched controls stand. */
  | 'socketBack'
  /** Solo island, end of the latch: rotation and translation zeroed and the throttle closed. */
  | 'latchEnd'
  /** Shared island or crewed helm: rotation and translation zeroed. */
  | 'deadManRotation'
  /** Shared island or crewed helm: the throttle closed. */
  | 'deadManThrottle'
  /** End of the reconnect grace: the vessel is no longer attended. */
  | 'graceEnd';

interface InputBase {
  /** The tick the input is stamped for. Applied at that tick when it arrives before the island steps it; later, at the island's tick. */
  tick: number;
  /** Order among the inputs of one tick: by account id, then by this sequence number. */
  accountId: string;
  seq: number;
}

/**
 * Everything that reaches an island from outside (ARCHITECTURE 7.2, "Nothing reaches an island except as a
 * tick-stamped, journaled input"). A journal of these, applied to the island state of a checkpoint,
 * reproduces the island hash.
 */
export type IslandInput =
  /** Continuous controls of a pilot, latched until replaced; `sasHold` is the hold direction of a 'maneuver' or target SAS mode (unit, island axes), null otherwise. */
  | (InputBase & { kind: 'controls'; vesselId: string; controls: ControlInputs; sasHold: Vec3 | null })
  /**
   * The velocity the pilot's prograde, normal and radial holds refer to: relative to the rotating surface or
   * to the body's inertial frame (the pilot's navball mode; v1 switched it by altitude). It changes the held
   * direction, so it is an input and the seat's state.
   */
  | (InputBase & { kind: 'reference'; vesselId: string; reference: 'surface' | 'orbit' })
  | (InputBase & { kind: 'command'; vesselId: string; command: IslandCommand })
  /** A pilot takes or leaves a vessel: the island latches that account's controls for it. `accountId` of the base is the pilot; `aboard` false = left. */
  | (InputBase & { kind: 'seat'; vesselId: string; aboard: boolean })
  /** Helm grant: the account that flies the vessel from now on (null = vacant), its craft and control part by key. */
  | (InputBase & { kind: 'helm'; vesselId: string; pilot: string | null; craftId: string | null; controlPartKey: string | null })
  /** A vessel enters the island in the vessel codec (the host's add; also the admission of a passive copy, with its old head). */
  | (InputBase & { kind: 'add'; vessel: Uint8Array; bornTick: number; admittedFromHead: number | null })
  /** A vessel leaves the island: parted, handed over, removed at safing, or expired. */
  | (InputBase & { kind: 'remove'; vesselId: string; reason: 'left' | 'removed' })
  /** Reservation of an admitted copy: requested by the island's host, granted, denied or released by the directory. */
  | (InputBase & { kind: 'reservation'; vesselId: string; state: ReservationState })
  /** Range-safety destruct: every part of the vessel is destroyed at the tick. */
  | (InputBase & { kind: 'destruct'; vesselId: string })
  | (InputBase & { kind: 'timer'; timer: IslandTimer; vesselId: string })
  /** The clock's rate from this tick on. Above the rules' `physicsWarpMax` the island is advanced on rails only. */
  | (InputBase & { kind: 'rate'; rate: number })
  /** The directory has decided a merge at `mergeTick` (null = withdrawn): `step` and `advanceTo` never pass it. */
  | (InputBase & { kind: 'mergeAt'; mergeTick: number | null });

/** The answer to `applyInput`: where the input will be (or was) applied, and why it was refused if it was. */
export interface InputReceipt {
  /** The tick the input is applied at (`InputAck.appliedTick`). */
  appliedTick: number;
  /** False when the input can never apply (unknown vessel, a pilot who is not at the helm): it is not queued. */
  accepted: boolean;
  reason?: string;
  /** The result of a command that was applied at once (an input stamped at or before the island's tick). */
  outcome?: CommandOutcome;
  /** Events, operations and arrivals of an input that was applied at once (a staging command's, a destruct's). */
  report?: AdvanceReport;
}

/** The result of a command once it has been applied at its tick (`CommandResult` of the seat). */
export interface CommandOutcome {
  accountId: string;
  seq: number;
  vesselId: string;
  tick: number;
  ok: boolean;
  reason?: string;
}

// ------------------------------------------------------------------------------------------ operations

/**
 * A structural operation as data (`IslandOpBody` of the wire contract; ARCHITECTURE 13.3): what this wave
 * executes. `merge`, `capture` and `release` are contact-docking's and join this type with it.
 * Vessels are named by SLOT at the operation's tick, parts by index in `Vessel.parts`.
 */
export type IslandOp = Extract<IslandOpBody, { op: 'split' | 'destroy' | 'add' | 'remove' | 'rebase' | 'replace' }>;

/** An operation the island executed, with the check both sides compute after it. */
export interface AppliedOp {
  tick: number;
  body: IslandOp;
  /** Result for the vessel the operation leaves at the body's first slot; null for `remove`, and for a `destroy` that left nothing. */
  checksum: IslandOpChecksum | null;
}

// ------------------------------------------------------------------------------------------- advancing

/** A vessel that left the island in an advance, with what became of it. */
export interface Departure {
  vesselId: string;
  name: string;
  /** Instant of the fate, s (an event instant may lie inside a tick). */
  ut: number;
  reason: 'burnedUp' | 'impact' | 'destroyed' | 'left' | 'removed';
  /** Body and sub-point of the vessel when it went (planetocentric, rad). */
  bodyId: string;
  latitude: number;
  longitude: number;
  /** The vessel as it was when it went (no longer the island's) and its revision counter. */
  vessel: Vessel;
  revision: number;
}

/** What one `step` or `advanceTo` did. The arrays are fresh per call and in canonical order. */
export interface AdvanceReport {
  /** Events of the advance. In predict mode no threshold outcome is among them. */
  events: SimEvent[];
  /** Structural operations executed (authoritative: every one; predict: the command-triggered ones only). */
  ops: AppliedOp[];
  commands: CommandOutcome[];
  departures: Departure[];
  /** Vessels that came into being (a split, a jettison): each with the vessel it left, in the order they were made. */
  arrivals: { vesselId: string; fromVesselId: string }[];
  /**
   * Members whose trajectory changed otherwise than by coasting, or whose conic was examined again (it went
   * on rails or left them, left the ground, passed the end of its predicted patch): a host that holds a
   * prediction for one of them refreshes it. An id may be listed more than once.
   */
  replan: string[];
  /** A terrain query of the advance ran on data that was not final (ARCHITECTURE 7.6). */
  incompleteTerrain: boolean;
  /** The frame changed: the SOI body before, or a new reference orbit (the view starts a new frame epoch). */
  frameChange: { fromBodyId: string; toBodyId: string; ut: number } | null;
}

/**
 * The next instant at which the island cannot go on coasting on rails: a member enters an atmosphere or
 * meets the ground and must be integrated from there. (A sphere-of-influence change does not stop a rails
 * advance: the island hands over at the event's own instant and goes on.)
 */
export interface IslandEvent {
  /** Event instant, s; a rails advance lands on the first whole tick at or after it. */
  ut: number;
  tick: number;
  kind: 'atmosphere' | 'impact';
  vesselId: string;
}

/** Counters of the step loop since the island was made (not state: not encoded, not hashed). */
export interface IslandCounters {
  steps: number;
  railsAdvances: number;
  /** Vessel steps on the RK4 path and on the sub-stepped path, the latter by reason. */
  freeSteps: number;
  probeSubsteps: number;
  pairSubsteps: number;
  armedTests: number;
}

/** Distance and time of reach between the island and a point outside it (ARCHITECTURE 6.2 `tau`, 7.3). */
export interface Reach {
  /** Smallest distance between the point's bounding sphere and a member's, m (negative = overlapping). */
  distance: number;
  /** Closing speed along the line to that member, m/s (positive = approaching). */
  closingSpeed: number;
  /** `joinDistanceBase + joinClosingTime x closing speed` for that pair. */
  joinDistance: number;
  /** Inside the join distance now. */
  joins: boolean;
  /** Past `islandPartFactor` times the join distance from every member: a member there has parted. */
  parted: boolean;
  /** (distance - join distance) / closing speed with the worst-case mutual acceleration included, s; Infinity when it is never reached, 0 when inside. */
  tau: number;
  /** The member the numbers refer to (the nearest by reach time); null for an empty island. */
  vesselId: string | null;
}

// ------------------------------------------------------------------------------------- the pair hook

/** A pair of members by vessel id, `a < b` in code-unit order. */
export interface PairRef {
  a: string;
  b: string;
}

/** A U5 pair: contact and capture are off between the two until they are clear, or the timer runs out (universe ticks). */
export interface ClearingPair extends PairRef {
  /** Tick the exemption began. */
  sinceTick: number;
}

/** A soft-capture constraint slot (ARCHITECTURE 7.2, 7.5). Defined here and carried by the codec; filled and solved by contact-docking. */
export interface CaptureConstraint extends PairRef {
  /** Port part indices in the two vessels. */
  aPort: number;
  bPort: number;
  /** The constraint's own state, opaque to the island (`IslandOpBody` capture `state`). */
  state: Uint8Array;
  /** Universe-tick timers: ticks the constraint was clamped, ticks since capture, ticks inside the hard-dock envelope. */
  clampTicks: number;
  ageTicks: number;
  dwellTicks: number;
}

/**
 * The pair pass (ARCHITECTURE 7.4). The island calls `regime` for every pair of Full-tier members at each
 * tick BEFORE stepping; a pair it answers 'contact' for takes the sub-stepped path TOGETHER in that tick,
 * both vessels, whatever their own probes say, and leaves it together at the first tick it answers 'free'.
 * `solve` is called once per sub-step for each such pair, after the per-vessel force evaluation of EVERY
 * vessel of the group and before any of them is integrated: it reads and changes the two runs (the bodies'
 * sub-states and the force and torque totals; src/sim/dynamics/integrator.ts, `SubstepRun`). A run is null
 * for a vessel that does not move in the step (held on the body, or gone). This wave the island's own hook
 * is empty (it answers 'free' and solves nothing); contact-docking supplies the sweep, the speculative
 * contacts and the response.
 */
export interface PairHook {
  regime(a: IslandMember, b: IslandMember, tick: number): 'free' | 'contact';
  solve(a: IslandMember, b: IslandMember, runA: SubstepRun | null, runB: SubstepRun | null, tick: number, subStep: number): void;
}

// ---------------------------------------------------------------------------------------------- island

export interface Island {
  readonly id: string;
  /** The island's tick: every member's state is the state at this tick. */
  readonly tick: number;
  /** `tick / 120`, s. */
  readonly ut: number;
  /** SOI body of the island's frame. */
  readonly bodyId: string;
  /** The reference orbit while the island integrates offsets (the Sun's sphere of influence); null = BCI(bodyId). */
  readonly reference: ReferenceOrbit | null;
  readonly mode: StepMode;
  /** Members in slot order (by vessel id). */
  readonly members: readonly IslandMember[];
  /** The anchor: the lowest vessel id among the attended members, else the lowest id; null for an empty island. */
  readonly anchorId: string | null;
  /** The clock's rate the island was last told. */
  readonly rate: number;
  /** A pending merge tick the island does not pass; null = none. */
  readonly mergeTick: number | null;
  readonly counters: Readonly<IslandCounters>;

  member(vesselId: string): IslandMember | null;

  // ---- membership (the host's direct calls; `applyInput` 'add' / 'remove' are the journaled forms of the same)

  /** Put a vessel into the island at the current tick. Its state is given in BCI of the island's body at that tick. */
  add(vessel: Vessel, options?: AddOptions): IslandMember;
  /** Take a vessel out at the current tick; returns it in BCI of the island's body at that tick (null = no such member). */
  remove(vesselId: string, reason?: 'left' | 'removed'): Vessel | null;
  /**
   * Decide a member's mode now: on rails at once when nothing forces integration (a vessel that starts on a
   * coast), else integrated. Without it a free member is integrated until it has coasted `COAST_TIME_TO_RAILS`.
   */
  settle(vesselId: string): void;
  /**
   * Evaluate the armed margin between the members now (the island does it at every control tick). A host
   * that changed the membership between two control ticks calls it once it is done.
   */
  refreshMargins(): void;

  // ---- time

  /**
   * One tick: inputs stamped for this tick, the control-tick work when `tick % 4 = 0`, every member by its
   * mode, the hand-overs. Never passes a pending merge tick (it throws: the host asks `mergeTick` first).
   */
  step(): AdvanceReport;
  /**
   * Rails advance to `tick` (a whole tick after the island's): every member must be quiescent
   * (`mustIntegrate()` false, else nothing moves and the report is empty). Lands on the first whole tick
   * at or after the next island event when that comes earlier; SOI events are processed at their own
   * instants. Returns the report; `island.tick` says where it landed.
   */
  advanceTo(tick: number): AdvanceReport;
  /** True when any member must be integrated at the next tick (no rails advance is possible). */
  mustIntegrate(): boolean;
  /** The earliest instant at which a rails member starts to integrate or the island changes frame; null = none known. */
  nextEvent(): IslandEvent | null;

  // ---- inputs and operations

  /** Queue an input for its tick (see `IslandInput`). Queued inputs are island state: the codec carries them. */
  applyInput(input: IslandInput): InputReceipt;
  /**
   * Execute a structural operation given as data, at the current tick: what a replica does with the
   * server's operation, and what `step` does internally with the operations of its own outcomes. Returns
   * the checksum of the result (null for `remove`). Throws `IslandOpError` when the operation does not fit
   * the state (unknown slot, a cut joint that is not a joint, ids that differ from the stated ones).
   */
  applyOp(op: IslandOp): IslandOpChecksum | null;
  /** The checksum of a member as it stands (what an operation's sender states and its receiver compares). */
  checksumOf(vesselId: string): IslandOpChecksum | null;

  // ---- state

  /** The whole island in the island codec (ARCHITECTURE 7.2). `names` false leaves the LABELS blocks of its vessels out. */
  encode(options?: { names?: boolean }): Uint8Array;
  /** `islandHash` of the island as it stands: the hash of its codec output without any name. */
  hash(): string;

  // ---- queries

  tierOf(vesselId: string): MemberTier | null;
  /** Position and velocity of a member's VES origin in BCI of the island's body (the vessel's own `r`, `v` while there is no reference orbit). */
  stateOf(vesselId: string): { r: Vec3; v: Vec3 } | null;
  /** The pilot's seat as the island holds it: the latched controls, the hold direction and the velocity reference; null = no such pilot. */
  seatOf(accountId: string): { vesselId: string; controls: ControlInputs; sasHold: Vec3 | null; reference: 'surface' | 'orbit'; latchOpenTick: number | null } | null;
  /** The step environment of a member at the island's tick (start-of-step values for the next step). */
  environmentOf(vesselId: string): VesselEnvironment | null;
  /**
   * Reach between the island and a sphere, given in BCI of the island's body at the island's tick. With
   * `exceptId` the member of that id is left out: the reach between a member and the rest of its island
   * (`parted` then says that the member has left it).
   */
  reach(point: { r: Vec3; v: Vec3; radius: number }, exceptId?: string): Reach;
  /**
   * The ids of the members that hang together with `vesselId` (itself included): linked one to the next by
   * less than the parting distance, `islandPartFactor` times the pair's join distance between their bounding
   * spheres (ARCHITECTURE 7.3). A member that is not in the set has parted from that member's island; an
   * island that is one set for any of its members has nothing to split off. Empty for an unknown id.
   */
  linkedTo(vesselId: string): ReadonlySet<string>;
  /** Any member under a threshold watch (ARCHITECTURE 6.2: the commit lag is 0 then). */
  thresholdWatch(): boolean;
  /** Null when no terrain request is outstanding; otherwise a promise that settles when every request so far is in. */
  terrainPending(): Promise<void> | null;
  /** True when the full-detail surface under the member is built from final data. */
  terrainFinalUnder(vesselId: string): boolean;
  /**
   * The predicted impact point of a member, for the terrain disc there (ARCHITECTURE 7.6). The host that
   * has a prediction passes it at control ticks; a hint changes which data is requested and never a number
   * of the state, so it is not an input.
   */
  hintImpact(vesselId: string, point: { bodyId: string; latitude: number; longitude: number } | null): void;

  // ---- the pair pass

  /** Replace the pair hook (contact-docking; tests force the pair regime with it). */
  setPairHook(hook: PairHook): void;
  /** Pairs born overlapping, U5 pairs and capture constraints, as the codec carries them. */
  readonly nascentPairs: readonly PairRef[];
  readonly clearingPairs: readonly ClearingPair[];
  readonly captures: readonly CaptureConstraint[];
  /** Add or clear an item of the three lists (contact-docking and the universe's materialisation; tests). */
  setNascent(pair: PairRef, on: boolean): void;
  setClearing(pair: ClearingPair | PairRef, on: boolean): void;
  setCapture(constraint: CaptureConstraint | PairRef, on: boolean): void;
}

/** How a vessel enters an island (`Island.add`). */
export interface AddOptions {
  /** Tick the vessel came into being; default the island's tick. */
  bornTick?: number;
  /** The account whose controls steer it, and whether it is attended. Defaults: nobody, not attended. */
  pilot?: string | null;
  attended?: boolean;
  /**
   * The conic the vessel is on (a passive vessel's committed orbit of its centre of mass about the island's
   * body, with its next event): the member is on rails on it from the same epoch state, so nothing moves
   * by a rounding at the admission. Absent: the member is integrated until it has coasted
   * `COAST_TIME_TO_RAILS`.
   */
  conic?: { orbit: Orbit; event: RailsEvent | null };
  /** Counter the member's `revision` continues from. */
  revision?: number;
  /** The head the admitted copy had as a passive vessel (ARCHITECTURE U4); null or absent = not an admitted copy. */
  admittedFromHead?: number | null;
}

/** What `createIsland` starts from. */
export interface IslandInit {
  id: string;
  /** The tick of the island's state. */
  tick: number;
  bodyId: string;
  mode?: StepMode;
  /** The clock's rate (default 1). */
  rate?: number;
}

/** Thrown by `applyOp` and `decodeIsland`: the data does not fit the state or the codec. */
export interface IslandErrorInfo {
  problem: 'format' | 'version' | 'slot' | 'joint' | 'ids' | 'vessel' | 'frame';
  detail: string;
}

/** The functions of ./index.ts. */
export interface IslandFactory {
  createIsland(deps: IslandDeps, init: IslandInit): Island;
  /** Restore an island from its codec bytes; `mode` may differ from the encoder's (a server checkpoint read by a replica). */
  decodeIsland(deps: IslandDeps, bytes: Uint8Array, options?: { mode?: StepMode }): Island;
  /** Hash of island codec bytes (16 hex digits): every byte but the names. Equal for two islands in the same state. */
  islandHash(bytes: Uint8Array): string;
}

/** Ticks between two control ticks of the island's upkeep and the swept test of the Armed tier (10 Hz). */
export const ARMED_TEST_TICKS = 12;
/** Seconds without any force before an integrated member goes on rails (v1's rule, unchanged). */
export const COAST_TIME_TO_RAILS = 0.5;
/** Step of the Reduced tier, s (2 Hz; ARCHITECTURE 6.2), a whole number of ticks. */
export const REDUCED_DT = 0.5;
/** Worst-case mutual acceleration in the reach time, m/s^2 (ARCHITECTURE 6.2). */
export const REACH_ACCELERATION = 60;
