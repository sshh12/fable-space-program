/**
 * The session: what the app, the pilots, the labs and the tests hold of a universe
 * (docs/ARCHITECTURE.md section 17.1).
 *
 *   FlightSession   the common contract. Two implementations:
 *   LocalSession      an in-process universe (src/session, headless): the headless mission, every lab, the
 *                     calibration benchmark, offline practice. `createSession(defs, scenarioId, { terrain })`
 *                     in src/session returns it.
 *   NetSession        the network replica with prediction (src/client), the same FlightSession over a gateway.
 *
 * Migration (MIGRATION_V2). v1's `Sim` (sim.ts) is now an alias of `LocalSession`, and v1's `World`
 * (src/sim/world) is the implementation until `LocalSession` over src/universe replaces it (step 4.3).
 * `universe`, `stores` and `planning` are therefore OPTIONAL in this contract until that step: `World` has
 * none of them, a `LocalSession` over src/universe and every `NetSession` have all three. The contract
 * tighten after step 4.3 makes them required; until then a consumer that needs one checks for it.
 */
import type { ConicElements } from '../math/conic';
import type { Vec3 } from '../math/vec3';
import type { ControlInputs, CommandResult, PlayerCommands } from './controls';
import type { BodyId, DefLibrary, ScenarioDef, SiteId, VehicleId } from './defs';
import type { AssemblyView, CensusEntry, FeedEvent, LinkState, LobbySummary, PadState, PresenceSummary, Prompt, RosterEntry, ShipRecord, TargetRef, UniverseRules } from './net';
import type { Marker, Patch, SimSnapshot } from './sim';

// ------------------------------------------------------------------------------------------------ stores

/**
 * A client-side replica of something the directory publishes. `get()` returns the current value (the same
 * object until it changes); `version` increases with every change, so a panel redraws only when it moved.
 */
export interface Store<T> {
  get(): T;
  readonly version: number;
  /** Calls `listener` after every change; returns the function that removes it. */
  subscribe(listener: () => void): () => void;
}

/**
 * The stores the DOM panels, the map and the menu read (ARCHITECTURE 17.1, 21, 23). A `LocalSession` fills
 * them from its in-process directory; a `NetSession` from the socket and the public documents.
 */
export interface ClientStores {
  /** Objects of the subscribed spheres of influence plus the pilot's relevant set, by vessel id. */
  census: Store<ReadonlyMap<string, CensusEntry>>;
  /** Pads of the subscribed sites. */
  pads: Store<readonly PadState[]>;
  /** The account's ships (My Ships). */
  ships: Store<readonly ShipRecord[]>;
  /** The assembly the pilot is aboard; null when the vessel is a single craft. */
  assembly: Store<AssemblyView | null>;
  /** The subscribed roster page. */
  roster: Store<readonly RosterEntry[]>;
  /** The rules document in force. */
  rules: Store<UniverseRules>;
  /** Lobbies and who is where (title, hub). */
  presence: Store<{ lobbies: readonly LobbySummary[]; summary: PresenceSummary }>;
  /** Feed ticker and ops log, newest last. */
  feed: Store<readonly FeedEvent[]>;
  /** Open prompt cards, oldest first. */
  prompts: Store<readonly Prompt[]>;
  /** The state of the link to the universe. */
  link: Store<LinkState>;
}

// ---------------------------------------------------------------------------------------------- universe

/** A launch slot: now on the live clock, a cohort bucket, or a friend's clock (ARCHITECTURE 5.9). */
export type SpawnSlot = { kind: 'live' } | { kind: 'cohort'; tick: number } | { kind: 'clock'; clockId: string };

export interface SpawnRequest {
  vehicleId: VehicleId;
  site: SiteId;
  pad: string;
  slot: SpawnSlot;
  /** Name of the new craft. */
  name: string;
}

/** Answer to a spawn or an attach. A refusal names the reason and, where one exists, an alternative. */
export type SeatResult =
  | { ok: true; vesselId: string; clockId: string | null }
  | { ok: false; reason: string; alternative: { site: SiteId; pad: string; slot: SpawnSlot } | { clockId: string } | null };

/** What the session asks the directory to keep it informed about (ARCHITECTURE 13.3 `Subscribe`, 14). */
export interface Subscriptions {
  /** Spheres of influence whose public census the map shows. */
  censusBodies?: BodyId[];
  /** Distance tier of the relevant set around the pilot, m. */
  relevantDistance?: number;
  /** Sites whose pads are watched. */
  padSites?: SiteId[];
  /** Roster page: which list, and the paging cursor (null = first page). */
  roster?: { filter: 'nearby' | 'docked' | 'lobby'; cursor: string | null } | null;
  /** The vessel whose committed worldline is wanted (the target, for echoes and the map), null = none. */
  worldlineOf?: string | null;
}

/**
 * Everything a player does to the universe from outside the seat (ARCHITECTURE 17.1): spawn, attach,
 * detach, subscriptions, rename, abandon. What a pilot does from the seat is `PlayerCommands`.
 */
export interface UniverseCommands {
  /** Launch a vehicle from a pad at a slot; resolves when the directory has answered. */
  spawn(request: SpawnRequest): Promise<SeatResult>;
  /** Take the seat of one of the account's craft. `clockId` is honoured only as rule U8b allows. */
  attach(vesselId: string, clockId?: string): Promise<SeatResult>;
  /** Leave the seat (the flight menu states what then happens to the craft, U16). */
  detach(): Promise<CommandResult>;
  /** Replace the given parts of the session's subscriptions; absent keys keep their value. */
  subscribe(change: Subscriptions): void;
  rename(craftId: string, name: string): Promise<CommandResult>;
  /** Give up ownership of a craft (it becomes unowned; a docked craft stays part of its assembly). */
  abandon(craftId: string): Promise<CommandResult>;
}

// ---------------------------------------------------------------------------------------------- planning

/** Key of a planning result: the same key always gives the same answer, so results are cached by it. */
export interface PlanningKey {
  vesselId: string;
  /** `VesselSnapshot.revision` of the vessel the plan is for (changes when its orbit or its nodes change). */
  vesselRevision: number;
  target: TargetRef | null;
  /** `CensusEntry.revision` of the target (0 for a body). */
  targetRevision: number;
}

/** A closest approach between the planned trajectory and a target, as a pair of markers across SOI changes. */
export interface ClosestApproach {
  ut: number;
  /** Separation, m, and relative speed, m/s, at that time. */
  distance: number;
  relSpeed: number;
  /** Where each is then: sphere of influence and BCI position. */
  self: { bodyId: BodyId; r: Vec3 };
  target: { bodyId: BodyId; r: Vec3 };
  /** True when the target's part of the pair lies on its forecast (after its head), not on committed history. */
  onForecast: boolean;
}

/** Relative motion about a target in the target's local-vertical frame (radial out, along track, cross track), m. */
export interface ProximityPlot {
  /** Sample times and positions; `samples[i]` is at `ut0 + i x step`. */
  ut0: number;
  step: number;
  samples: { radial: number; along: number; cross: number }[];
  /** Index of the closest sample. */
  closestIndex: number;
}

/** A launch opportunity toward a target from a site. */
export interface LaunchWindow {
  /** Time of the plane crossing at the pad, the launch azimuth for it (deg, compass), and the plane's relative inclination when launched then, rad. */
  ut: number;
  azimuthDeg: number;
  relativeInclination: number;
  /** Phase angle of the target at that time, rad (interplanetary and rendezvous planning). */
  phaseAngle: number;
}

/**
 * Every call of the service is keyed by the revisions of what it depends on (ARCHITECTURE 6.3): the vessel's
 * and the target's in `PlanningKey`, and for the two calls that take no vessel the target's revision as an
 * argument (`CensusEntry.revision`; 0 for a body, whose ephemeris never changes). The same arguments always
 * give the same answer, which is what lets a provider cache and the API endpoint share results.
 *
 * Planning as a service with three providers (ARCHITECTURE 6.3): in process (`LocalSession`, tests, bots), a
 * planning worker in the browser, and the API endpoint, all running the same pure functions of
 * src/sim/orbit and src/sim/nav. Every call is asynchronous and keyed by vessel and target revision, so the
 * map and the HUD never import the simulation and never block a frame. A call whose key is superseded
 * before it resolves may reject with an `Error` whose `name` is 'PlanningSuperseded'.
 */
export interface PlanningService {
  /** Patches of a vessel from its state and nodes: what `SimSnapshot.patches` holds for the active vessel, for any vessel of the relevant set. */
  predictPatches(key: PlanningKey, opts?: { maxPatches?: number; includeNodes?: boolean }): Promise<{ current: Patch[]; planned: Patch[] }>;
  /** The next closest approaches (at most `count`, default 3) between the vessel's planned trajectory and the target's chain. */
  closestApproaches(key: PlanningKey, opts?: { count?: number; horizon?: number }): Promise<ClosestApproach[]>;
  /** Relative motion about the target over `duration` seconds from `fromUt` in `samples` steps. */
  proximityPlot(key: PlanningKey, fromUt: number, duration: number, samples: number): Promise<ProximityPlot>;
  /** Launch opportunities from a pad toward the target (at its `targetRevision`) between two times. */
  launchWindows(site: SiteId, pad: string, target: TargetRef, targetRevision: number, fromUt: number, toUt: number): Promise<LaunchWindow[]>;
  /** Markers (apsides, nodes against the target's plane, SOI events) of one conic, for a vessel that is not the active one. */
  describeConic(bodyId: BodyId, conic: ConicElements, fromUt: number, toUt: number, target: TargetRef | null, targetRevision: number): Promise<Marker[]>;
}

// ----------------------------------------------------------------------------------------------- session

/**
 * What the app loop, the pilots and the tests hold (ARCHITECTURE 17.1). One frame of the app:
 * `setControls(inputs)`; `advance(realDt, onControlTick)`; `snapshot()` once, handed to renderer, audio, HUD
 * and map.
 */
export interface FlightSession {
  readonly defs: DefLibrary;
  /**
   * Advance by a real-time frame delta (s), honouring the clock's rate. Real time is accumulated and consumed
   * in whole PHYSICS_DT steps (the remainder carries over and drives the interpolation in snapshot()), so the
   * presented motion is uniform at 60, 120, 144 or 240 Hz alike. On rails the advance is an exact Kepler
   * step. `onControlTick`, when given, is invoked before every CONTROL_TICK_STEPS-th physics step and before
   * each rails advance; inside it a pilot may call peek(), setControls() and commands. This gives a scripted
   * pilot the same 30 Hz (sim time) cadence in the browser as in the headless loop.
   */
  advance(realDt: number, onControlTick?: () => void): void;
  setControls(inputs: ControlInputs): void;
  /** Flight, target, time, port, helm and transfer commands: everything a pilot does from the seat. */
  readonly commands: PlayerCommands;
  /**
   * Build a snapshot for presentation and DRAIN the event queue into it. Called exactly once per presented
   * frame by the app loop; the same object is handed to renderer, audio, HUD and map. Poses are interpolated
   * to the presentation time (see SimSnapshot.ut).
   */
  snapshot(): SimSnapshot;
  /**
   * The true state at simUt, never interpolated (ut === simUt), leaving the event queue untouched (`events`
   * lists what is pending). For pilots, tests and the headless runner.
   */
  peek(): SimSnapshot;
  /** Spawn, attach, detach, subscriptions, rename, abandon. Optional until step 4.3 (see the file header). */
  readonly universe?: UniverseCommands;
  /** Census, pads, ships, assembly, roster, rules, presence, feed, prompts, link state. Optional until step 4.3. */
  readonly stores?: ClientStores;
  /** Patch prediction, closest approaches, proximity plot, launch windows. Optional until step 4.3. */
  readonly planning?: PlanningService;
}

/** Debug-only mutators. Every call increments cheatCounter. Never used by mission tests or pilots; they exist only in a LocalSession. */
export interface SessionDebug {
  setVesselState(vesselId: string, bodyId: string, r: Vec3, v: Vec3): void;
  setResource(vesselId: string, partInstanceId: string, resource: string, kg: number): void;
  setUt(ut: number): void;
}

/**
 * The in-process session (implemented by src/session; faked by src/core/fakes for UI development).
 * Deterministic: same scenario + same sequence of calls => bit-identical state, PROVIDED the caller follows
 * the terrain protocol below.
 *
 * Terrain protocol. Terrain tiles load asynchronously, yet every method here is synchronous. The session
 * asks the TerrainProvider for data only from deterministic triggers evaluated at step boundaries (altitude
 * thresholds, the predicted impact point, scenario start) - never from wall-clock time. While such a request
 * is outstanding, terrainPending() returns a promise. A caller that needs reproducible results (the headless
 * runner, mission tests, replays) must `await session.ready` once and then `await session.terrainPending()`
 * whenever it is non-null BEFORE the next step()/advanceRails()/advance(); the state hash is defined only
 * under that rule. The browser loop does not wait: it keeps rendering and relies on the rule that warp is
 * clamped to 1x below 300 m radar altitude until final data is resident.
 */
export interface LocalSession extends FlightSession {
  /** The scenario this session was created from: the spawn recipe and, optionally, the objectives of its craft. */
  readonly scenario: ScenarioDef;
  /**
   * Resolves when the start state is usable: terrain under every scenario vessel is resident (collision
   * surface warmed, pad elevation resolved). Await it before the first step, advance or snapshot.
   */
  readonly ready: Promise<void>;
  /** Null when no terrain request of the session is outstanding; otherwise a promise that resolves when all are in. */
  terrainPending(): Promise<void> | null;
  /** Exactly one PHYSICS_DT step of integrated time (headless harness). */
  step(): void;
  /**
   * Rails advance toward `targetUt` (headless harness). The state lands on a whole tick: the first tick at
   * or after `targetUt`, or the first tick at or after the next event when that comes earlier (the event is
   * processed at its own instant inside that tick). Returns the ut reached, which is the ut of that tick:
   * at or after `targetUt` by less than one tick unless an event came first, and never an instant between
   * two ticks. A `targetUt` at or before the present ut does nothing and returns the present ut.
   */
  advanceRails(targetUt: number): number;
  /** True when the next advance must integrate forces (burn, atmosphere, contact...). */
  readonly needsIntegration: boolean;
  /** UT of the next event that limits warp (SOI change, atmosphere entry, node lead time...). */
  readonly nextEventUt: number;
  /** Non-zero means a debug mutator was used: the run is void as a mission proof. */
  readonly cheatCounter: number;
  /** Hash of the complete dynamic state (golden-run determinism check). */
  stateHash(): string;
  readonly debug: SessionDebug;
}
