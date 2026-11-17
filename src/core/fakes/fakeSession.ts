/**
 * FakeSession: a kinematic stand-in for a session (docs/ARCHITECTURE.md 17.1), for developing and testing the
 * consumers of SimSnapshot (HUD, navball, map view, audio, renderer features, cameras) in lab pages and unit
 * tests. It implements `LocalSession` with plausible, internally consistent numbers, and it is NOT physics:
 * the vessel follows a circular orbit or sits on the surface, attitude follows the inputs directly, nothing
 * consumes propellant and nothing can fail. It is deterministic: the same options and the same sequence of
 * calls give the same snapshots, bit for bit (no clock, no random number).
 *
 * Never use it in the shipped app, in mission tests, or to judge flight behaviour.
 *
 * Scenes. The eight flight scenes of v1 (`FakeScene`: one vessel on the pad, climbing, in low orbit, on the
 * way to the Moon, about it, on it, in an entry, under parachutes), and the scenes of the shared universe
 * that no session produces before waves 4 and 5 (`FakeV2Scene`), each on the low-orbit flight unless it says
 * otherwise:
 *   rendezvous        two craft; the other is the selected target: `Readouts.target` with range, rates, the
 *                     local-vertical position and the next closest approach; the navball's target markers;
 *   dockingApproach   a parked station (another owner's, nobody aboard) ahead on the track and closing, its port
 *                     the target and the own port the control point: `Readouts.docking`, the two port states
 *                     (`portStates()`), `dockCapture` when the faces meet, ten seconds of soft capture, then
 *                     the hard dock. The ports are PARTS of the part list (the first part with an attach node
 *                     of kind 'dock', else the craft's first part and the top of its envelope), the two faces
 *                     look at each other, and the scene starts with the hold on the port engaged. The hard
 *                     dock is the simulation's merge (ARCHITECTURE 7.5, docs/handoff/sim-core-v2.md step 3):
 *                     ONE vessel with an assembly id, the base's craft first (the station: equal mass, the
 *                     lower id) and the viewer's after it, every part of both in the base's frame, a link
 *                     between the two port parts, the base's vacant helm granted to the viewer
 *                     (`helmChanged` after `docked`, whose `absorbedVesselId` is the viewer's former
 *                     vessel), and the census, the ships, the assembly panel and the roster restated;
 *   assembly          three craft in one vessel: craft blocks, dock links between parts of the craft, the
 *                     helm, a bounding radius that spans them, the assembly store with its ports.
 *                     (These two scenes are about parts: they need `parts` and say so without them.)
 *   echoes            a recorded echo behind the viewer's clock and a projected one ahead of it, with their
 *                     time offsets and the offers that make them reachable;
 *   timeLive / timeAhead / timeBehind   the time strip for each `TimeView.relation`: a shared clock with a
 *                     member who has not agreed and an open proposal, a private clock ahead of the live one,
 *                     an island held behind it;
 *   launchQueue       the pad scene with the session's next launch waiting for a pad, as the contract of the
 *                     visible launch queue has it (session.ts, `LaunchQueueEntry`): the request's `spawn` is
 *                     pending (`pendingSpawn`) while `stores.launchQueue` holds its entry, the place moves up,
 *                     and `universe.cancelSpawn()` leaves the queue: the store is null and the pending spawn
 *                     resolves refused with the reason that the player left. A `spawn` while nothing waits
 *                     joins the queue again; a second one while one waits is refused.
 *
 * The snapshot is the v2 snapshot as `createSession` gives it (tests/unit/fakes holds the two against each
 * other): `revision`, `frame` with the history of earlier origins, `time`, craft blocks with the cockpit and
 * the chase distances, the helm, part keys, `Readouts.target`. The deprecated fields are filled beside them
 * until the contract tighten removes them.
 *
 * Figures. What a session derives from the vessel's parts and its vehicle, the fake derives from them too
 * (`figures: 'derived'`, the default), so that a consumer sees a vessel that agrees with itself and with the
 * session in the same situation (tests/unit/fakes/fakeSession.test.ts holds every field against one, with the
 * simplifications in one table):
 *   from the parts      the mass, the centre of mass and the bounding radius (the simulation's own sums), of
 *                       every craft and of a vessel of several; the ablator, the hottest skin, the thruster
 *                       propellant and whether there are legs, in the read-outs; the orbit a standing vessel
 *                       has; the ground's reaction it feels;
 *   from the vehicle    the stage stack with its labels and icons, the stages fired at the start
 *                       (`stagesAlreadyFired`), which stages state burn figures (the burn under way and
 *                       every engine stage still to fire; the others state zeros), the sum of them as the
 *                       remaining delta-v, and the light of the next parachute stage against its envelopes;
 *   from the scene      the relative inclination to a body target, the launch site's target by its pad.
 * Without `parts` (or without a vehicle, for the stack) there is nothing to derive from and the stand-in
 * values hold: 50 t, 55 m, a generic stack. `figures: 'standIn'` states those constants WHATEVER the parts,
 * as v1's FakeSim did: it is what `createFakeSim` asks for, because the renderer draws from the mass and the
 * bounding radius and the labs' reference images were recorded with them. Still stand-ins in both: the burn
 * figures of a stage (the fake runs no staging analysis) and everything about the flight itself.
 *
 * The render root. Like a session, the fake states ROOT positions relative to the centre of the active
 * vessel's SOI body (`renderRoot: 'focusBody'`, the default). `renderRoot: 'rootBody'` keeps the origin at
 * the library's root body, which is where v1's FakeSim had it (for the Moon's scenes that is 384,000 km
 * away: the same picture from numbers of another size). `setRenderRoot(bodyId)` replaces the origin while the
 * session runs, as a sphere-of-influence change does: a new frame epoch, a rebase, the old origin in the
 * history of every later snapshot.
 */
import { NEUTRAL_CONTROLS, SAS_MODES, type CommandResult, type ControlInputs, type NavballMode, type NodeEdit, type PlayerCommands, type SasMode } from '../contracts/controls';
import { MAX_PHYSICS_WARP_INDEX, PHYSICS_DT, WARP_LEVELS, type BodyDef, type DefLibrary, type ParachuteEnvelope, type ScenarioDef, type VehicleDef } from '../contracts/defs';
import {
  DEFAULT_UNIVERSE_RULES,
  TICKS_PER_SECOND,
  type AssemblyView,
  type CensusEntry,
  type FeedEvent,
  type LinkState,
  type LobbySummary,
  type PadState,
  type Presence,
  type PresenceSummary,
  type Prompt,
  type RosterEntry,
  type ShipRecord,
  type TargetRef,
  type TimeOffer,
  type TimeView,
  type UniverseRules,
} from '../contracts/net';
import type { ClientStores, LaunchQueueEntry, LocalSession, SeatResult, SessionDebug, Store, UniverseCommands } from '../contracts/session';
import type {
  BodySnapshot,
  ChuteEnvelope,
  CraftCockpit,
  CraftSnapshot,
  DockingPortState,
  DockingReadout,
  DockLinkSnapshot,
  ManeuverNode,
  Marker,
  ModuleState,
  NavballMarkers,
  PartSnapshot,
  Patch,
  Readouts,
  SimEvent,
  SimSnapshot,
  SnapshotFrame,
  StageInfo,
  SurfaceTarget,
  TargetReadout,
  VesselSnapshot,
} from '../contracts/sim';
import { padLocationOf, padOf, padsOf, padTitle } from '../defs/sites';
import { dirToLatLon, latLonToDir } from '../geo/cubeSphere';
import { conicApsides, conicFromState, conicPosition, conicTrueAnomaly, timeSincePeriapsis, type ConicElements } from '../math/conic';
import { FRAME_HISTORY_EPOCHS, type FrameEpochOrigin, type FrameRebase } from '../math/frame';
import { quat, type Quat } from '../math/quat';
import { clamp, DEG, G0, TWO_PI } from '../math/scalar';
import { v3, type Vec3 } from '../math/vec3';
import { partKey } from '../access/snapshotAccess';
import { describeStages, type StageWords } from '../defs/stageWords';

/** The flight scenes of v1: one vessel. */
export type FakeScene = 'pad' | 'ascent' | 'lowOrbit' | 'translunar' | 'lunarOrbit' | 'lunarSurface' | 'reentry' | 'chutes';
/** The scenes of the shared universe (see the file header). */
export type FakeV2Scene = 'rendezvous' | 'dockingApproach' | 'assembly' | 'echoes' | 'timeLive' | 'timeAhead' | 'timeBehind' | 'launchQueue';
export type FakeSessionScene = FakeScene | FakeV2Scene;

export const FAKE_SCENES: readonly FakeScene[] = ['pad', 'ascent', 'lowOrbit', 'translunar', 'lunarOrbit', 'lunarSurface', 'reentry', 'chutes'];
export const FAKE_V2_SCENES: readonly FakeV2Scene[] = ['rendezvous', 'dockingApproach', 'assembly', 'echoes', 'timeLive', 'timeAhead', 'timeBehind', 'launchQueue'];

/** The flight a scene of the shared universe is set in. */
const FLIGHT_OF: Record<FakeV2Scene, FakeScene> = {
  rendezvous: 'lowOrbit',
  dockingApproach: 'lowOrbit',
  assembly: 'lowOrbit',
  echoes: 'lowOrbit',
  timeLive: 'lowOrbit',
  timeAhead: 'lowOrbit',
  timeBehind: 'lowOrbit',
  launchQueue: 'pad',
};

const isV2Scene = (scene: FakeSessionScene): scene is FakeV2Scene => (FAKE_V2_SCENES as readonly string[]).includes(scene);

export interface FakeSessionOptions {
  scene: FakeSessionScene;
  /** Start time, seconds since J2000 (default: 2028-03-01 roughly). */
  ut?: number;
  /** Parts of the active vessel (e.g. from the real vessel assembler). Engine module states follow the throttle. */
  parts?: PartSnapshot[];
  /**
   * Vehicle definition the active vessel is published as (`VesselSnapshot.vehicleId`, `scenario.vehicle`): the
   * one `parts` were assembled from. The craft block takes its cockpit and its chase distances from it, as a
   * session's assembler does. Default '': the stand-in vessel belongs to no vehicle, has no cabin and is
   * framed from its bounding radius.
   */
  vehicleId?: string;
  /** Site used by the surface scenes (default: first site in the library). */
  siteId?: string;
  /**
   * Put a surface scene ('pad', 'ascent', 'lunarSurface', 'chutes') at this point instead of its own (labs: a
   * launch under an overcast sky, a landing at the scenario's target). The site definition itself, and what
   * the snapshot says about it, is unchanged.
   */
  location?: { latDeg: number; lonDeg: number };
  /**
   * Altitude of the vessel origin above the reference radius at the start of a surface scene, m (default: the
   * scene's own; 'ascent' 9,000 climbing, 'chutes' 2,500 sinking). A standing scene with `ground` ignores it.
   */
  altitude?: number;
  /**
   * The real ground under a surface scene (labs that draw the baked terrain; the default is a body without
   * relief): `height` = terrain or sea surface above the reference radius under the vessel, `originHeight` =
   * height of the vessel origin above the vessel's lowest point (both m). `readouts.altitudeRadar` is then
   * the height of the lowest point above that ground, a descent ends with the lowest point on it, and the
   * scenes that stand ('pad', 'lunarSurface') start with the lowest point `clearance` metres above it
   * (default 0: standing; a launch mount's clamp height; a hover height).
   */
  ground?: { height: number; originHeight: number; clearance?: number };
  /**
   * Stage labels for the staging stack. Default: with derived figures (`figures`) and a vehicle, the stages of
   * that vehicle with their labels and icons, as a session lists them; else a generic 4-entry stack. Labels
   * given here are the stack whatever the figures.
   */
  stageLabels?: string[];
  /**
   * Stages of the stack already fired at the start, as `ScenarioDef.stagesAlreadyFired` (default 0): a scene
   * in the middle of a flight then lists them fired, as a session started from such a scenario does, the next
   * press fires the one after them, and `SimSnapshot.scenario` says so. It says nothing about `parts`: give the
   * part list of that state of the vehicle (`assembleVessel(defs, id, { stagesAlreadyFired })`).
   */
  stagesAlreadyFired?: number;
  /**
   * The target selected at the start, as `commands.setTarget` would be given it (a scenario's target body:
   * `{ kind: 'body', id }`; null = none). Default: the scene's own (the other vessel of 'rendezvous',
   * 'timeLive' and 'echoes', the station's port of 'dockingApproach'; none in every other scene). A target the
   * scene does not have is an error.
   */
  target?: TargetRef | null;
  /**
   * The scenario's suggested landing (`ScenarioDef.suggestedLanding`; null = none), listed first among the
   * surface targets as a session lists it, whatever body it is on. Default: the fake's own point, and only in
   * the scenes at the moon.
   */
  landing?: ScenarioDef['suggestedLanding'];
  /**
   * Landing legs of the active vessel deployed from the start (default false: stowed, as at launch). A landed
   * scene stands on them (request vehicle-pad-5); `toggleLegs` works from there as usual.
   */
  legsDeployed?: boolean;
  /** Name of the active vessel in the snapshot (request map-view-7; default 'Fake vessel'). The id stays 'fake-vessel'. */
  vesselName?: string;
  /** Where the origin of ROOT positions is (the file header). Default 'focusBody', as a session. */
  renderRoot?: 'focusBody' | 'rootBody';
  /**
   * Where the figures come from that a session derives from the vessel's parts and its vehicle (the file
   * header, "Figures"). 'derived' (the default of `createFakeSession`): from `parts` and the vehicle, as a
   * session derives them. 'standIn' (the default of `createFakeSim`): v1's constants whatever the parts.
   */
  figures?: 'derived' | 'standIn';
}

const OBLIQUITY = 23.4392911 * DEG;
/** Start time of a fake session that is given none, seconds since J2000. */
export const FAKE_SESSION_DEFAULT_UT = 8.89e8;
const DEFAULT_UT = FAKE_SESSION_DEFAULT_UT;

/** Ids the fake gives what it shows: its own vessel (one launched craft: the vessel has the craft's id) and the others. */
export const FAKE_VESSEL_ID = 'fake-vessel';
export const FAKE_TARGET_ID = 'fake-target';
export const FAKE_STATION_ID = 'fake-station';
export const FAKE_ASSEMBLY_ID = `a~${FAKE_VESSEL_ID}~0`;
export const FAKE_ECHO_RECORDED_ID = 'fake-echo-recorded';
export const FAKE_ECHO_PROJECTED_ID = 'fake-echo-projected';
const FAKE_ACCOUNT = 'fake-account';
const FAKE_CALLSIGN = 'YOU';
const OTHER_ACCOUNT = 'fake-account-vega';
const OTHER_CALLSIGN = 'VEGA';

/** The capture envelope of the fake's ports (what `DockingReadout.within` is judged against), and its soft-capture time. */
const FAKE_ENVELOPE = { lateral: 0.3, angleDeg: 5, rollDeg: 5, closing: 0.3, lateralSpeed: 0.1, rateDegPerS: 0.5 };
const FAKE_SOFT_CAPTURE_SECONDS = 10;
/** The least distance between the two vessel origins when the ports touch, m (a port face at its craft's origin), and the closing speed of the approach, m/s. */
const FAKE_PORT_STANDOFF = 1.2;
const FAKE_CLOSING_SPEED = 0.1;
/** Where the station of the docking scene starts: the gap between the two port faces, m. */
const FAKE_APPROACH_GAP = 13.8;
/** The port type the fake's ports state in the assembly store (the two types of ARCHITECTURE 7.5 are C and H). */
const FAKE_PORT_TYPE = 'C';

interface SceneSpec {
  bodyId: string;
  kind: 'surface' | 'orbit';
  altitude: number;
  inclinationDeg?: number;
  latDeg?: number;
  lonDeg?: number;
  climbRate?: number;
  plasma?: number;
  chutes?: boolean;
}

/** Another vessel of a scene: where it is about the viewer's orbit and how it exists for the viewer. */
interface OtherVessel {
  id: string;
  craftId: string;
  name: string;
  ownerId: string | null;
  ownerCallsign: string | null;
  /** Orbit radius above the viewer's, m, and distance ahead along the track at the scene's start, m. */
  higher: number;
  ahead: number;
  /** Along-track closing: the distance ahead shrinks at this rate (m/s) down to `standoff` m. 0 = a free orbit. */
  closing: number;
  standoff: number;
  presence: Presence;
  /** The vessel's time minus the viewer's clock, ticks. */
  timeOffset: number;
  /** A pilot is seated in it (it has its owner at the helm and the owner is in the roster); false = parked, the helm vacant. */
  attended: boolean;
}

/**
 * The docking port of a craft built from the fake's part list: the part that carries it, and the mating face
 * in the craft's VES frame (its centre and the outward axis).
 */
interface FakePort {
  instanceId: string;
  pos: Vec3;
  dir: Vec3;
}

function rotX(v: Vec3, a: number): Vec3 {
  const c = Math.cos(a);
  const s = Math.sin(a);
  return { x: v.x, y: c * v.y - s * v.z, z: s * v.y + c * v.z };
}

function sunRoot(ut: number): Vec3 {
  const d = ut / 86400;
  const L = (280.46 + 0.9856474 * d) * DEG;
  const g = (357.528 + 0.9856003 * d) * DEG;
  const lambda = L + (1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * DEG;
  const eps = (23.439 - 0.0000004 * d) * DEG;
  const R = (1.00014 - 0.01671 * Math.cos(g) - 0.00014 * Math.cos(2 * g)) * 149597870700;
  return { x: R * Math.cos(lambda), y: R * Math.cos(eps) * Math.sin(lambda), z: R * Math.sin(eps) * Math.sin(lambda) };
}

/** A store of the fake: a value, a version that moves with it, and its listeners. */
class FakeStore<T> implements Store<T> {
  version = 0;
  private readonly listeners = new Set<() => void>();
  constructor(private value: T) {}
  get(): T {
    return this.value;
  }
  set(value: T): void {
    if (value === this.value) return;
    this.value = value;
    this.version++;
    for (const l of [...this.listeners]) l();
  }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}

interface FakeStores extends ClientStores {
  census: FakeStore<ReadonlyMap<string, CensusEntry>>;
  pads: FakeStore<readonly PadState[]>;
  ships: FakeStore<readonly ShipRecord[]>;
  assembly: FakeStore<AssemblyView | null>;
  roster: FakeStore<readonly RosterEntry[]>;
  rules: FakeStore<UniverseRules>;
  presence: FakeStore<{ lobbies: readonly LobbySummary[]; summary: PresenceSummary }>;
  feed: FakeStore<readonly FeedEvent[]>;
  prompts: FakeStore<readonly Prompt[]>;
  link: FakeStore<LinkState>;
  launchQueue: FakeStore<LaunchQueueEntry | null>;
}

export class FakeSession implements LocalSession {
  readonly defs: DefLibrary;
  readonly scenario: ScenarioDef;
  readonly commands: PlayerCommands;
  readonly universe: UniverseCommands;
  readonly stores: ClientStores;
  readonly debug: SessionDebug;
  readonly ready: Promise<void> = Promise.resolve();
  /** The scene this session was made for. */
  readonly scene: FakeSessionScene;
  cheatCounter = 0;

  private ut: number;
  private readonly ut0: number;
  private tick = 0;
  private readonly spec: SceneSpec;
  private readonly ground: { height: number; originHeight: number; clearance?: number } | null;
  private controls: ControlInputs = { ...NEUTRAL_CONTROLS, translate: v3.zero() };
  private q: Quat = quat.identity();
  private w: Vec3 = v3.zero();
  private sasEnabled = true;
  private sasMode: SasMode = 'stability';
  private rcsEnabled = false;
  private fineControl = false;
  private legsDeployed = false;
  private readonly vesselName: string;
  private lightsOn = false;
  private navballMode: NavballMode;
  private warpIndex = 0;
  private target: TargetRef | null = null;
  private nextStage = 0;
  private readonly stageLabels: string[];
  /** The figures a session derives from the parts and the vehicle are derived (true) or v1's stand-in constants (false). */
  private readonly derived: boolean;
  /** The stack is the one of the vehicle the fake is published as: its stages state their own icons and figures. */
  private readonly vehicleStack: boolean;
  /** What each stage of the vehicle the fake is published as says about itself (`describeStages`); empty without a vehicle. */
  private stageWords: StageWords[] | null = null;
  private nodes: ManeuverNode[] = [];
  private nodeSeq = 0;
  private events: SimEvent[] = [];
  private readonly parts: PartSnapshot[];
  private throttleActual = 0;
  /** The staged engines burn (throttle above 2 %); time since they last lit and since they last went out, s (-1: never / burning). */
  private enginesLit = false;
  private ignitionAge = -1;
  private shutdownAge = -1;
  private readonly orbitPhase0: number;
  private readonly siteDir: Vec3;
  private readonly others: OtherVessel[];
  private readonly fakeStores: FakeStores;
  /** The docking of the 'dockingApproach' scene: 'approach' until the ports touch, then soft capture, then docked. */
  private dockPhase: 'approach' | 'soft' | 'hard' = 'approach';
  private softCaptureAge = 0;
  /** The universe tick of the hard dock, which the assembly's id carries; -1 before it. */
  private dockTick = -1;
  /** The docking port of the craft the part list builds (the docking scene; null in every other). */
  private readonly port: FakePort | null;
  /** Distance between the two vessel origins when the two port faces lie on each other, m. */
  private readonly portStandoff: number;
  /** The half-turn that faces one port at the other: about an axis of the VES frame across the port axis. */
  private readonly facing: Quat;
  /** The attitude the viewer's vessel started in: the other vessels of a scene keep it. */
  private readonly q0: Quat;
  /** The launch request that waits for a pad: the promise `universe.spawn` gave for it and what resolves it; null when none waits. */
  private spawnInFlight: { promise: Promise<SeatResult>; resolve: (result: SeatResult) => void } | null = null;
  /** When the waiting request joined the queue, seconds since J2000 (its place moves up from then). */
  private queuedAt: number;
  /** The render root: its body, the frame epoch, the rebase the next snapshot() carries, and the earlier origins. */
  private originBodyId: string;
  private frameEpoch = 0;
  private pendingRebase: FrameRebase | null = null;
  private earlierOrigins: { epoch: number; bodyId: string }[] = [];

  constructor(defs: DefLibrary, opts: FakeSessionOptions) {
    this.defs = defs;
    this.scene = opts.scene;
    const flight: FakeScene = isV2Scene(opts.scene) ? FLIGHT_OF[opts.scene] : opts.scene;
    this.ut0 = this.ut = opts.ut ?? DEFAULT_UT;
    this.queuedAt = this.ut0;
    const site = defs.sites[opts.siteId ?? Object.keys(defs.sites)[0] ?? ''];
    const siteLat = opts.location?.latDeg ?? site?.location.latDeg ?? 19.1;
    const siteLon = opts.location?.lonDeg ?? site?.location.lonDeg ?? -155.5;
    const root = defs.rootBodyId;
    const moon = Object.values(defs.bodies).find((b) => b.parent === root && b.gravityRole === 'attractor')?.id ?? root;
    const specs: Record<FakeScene, SceneSpec> = {
      pad: { bodyId: root, kind: 'surface', altitude: 60, latDeg: siteLat, lonDeg: siteLon },
      ascent: { bodyId: root, kind: 'surface', altitude: 9000, latDeg: siteLat, lonDeg: siteLon, climbRate: 350 },
      lowOrbit: { bodyId: root, kind: 'orbit', altitude: 200e3, inclinationDeg: Math.abs(siteLat) },
      translunar: { bodyId: root, kind: 'orbit', altitude: 180e6, inclinationDeg: 21 },
      lunarOrbit: { bodyId: moon, kind: 'orbit', altitude: 100e3, inclinationDeg: 4 },
      lunarSurface: { bodyId: moon, kind: 'surface', altitude: 4, latDeg: 0.674, lonDeg: 23.473 },
      reentry: { bodyId: root, kind: 'orbit', altitude: 68e3, inclinationDeg: 21, plasma: 0.85 },
      chutes: { bodyId: root, kind: 'surface', altitude: 2500, latDeg: 8, lonDeg: -146, climbRate: -8, chutes: true },
    };
    this.spec = specs[flight];
    if (opts.location && this.spec.kind === 'surface') this.spec = { ...this.spec, latDeg: opts.location.latDeg, lonDeg: opts.location.lonDeg };
    if (opts.altitude !== undefined && this.spec.kind === 'surface') this.spec = { ...this.spec, altitude: opts.altitude };
    this.ground = opts.ground ?? null;
    this.legsDeployed = opts.legsDeployed ?? false;
    this.vesselName = opts.vesselName ?? 'Fake vessel';
    this.siteDir = latLonToDir((this.spec.latDeg ?? 0) * DEG, (this.spec.lonDeg ?? 0) * DEG);
    this.orbitPhase0 = 0.6;
    this.navballMode = this.spec.kind === 'orbit' ? 'orbit' : 'surface';
    this.parts = opts.parts ?? [];
    this.derived = (opts.figures ?? 'derived') === 'derived';
    this.originBodyId = (opts.renderRoot ?? 'focusBody') === 'rootBody' ? root : this.spec.bodyId;
    this.scenario = {
      id: `fake-${opts.scene}`,
      name: `Fake scene: ${opts.scene}`,
      vehicle: opts.vehicleId ?? '',
      site: site?.id ?? '',
      startUt: this.ut0,
      start: { kind: 'state', bodyId: this.spec.bodyId, r: [0, 0, 0], v: [0, 0, 0] },
      stagesAlreadyFired: opts.stagesAlreadyFired ?? 0,
      target: null,
      suggestedLanding: opts.landing !== undefined ? opts.landing : this.spec.bodyId === moon && moon !== root ? { bodyId: moon, latDeg: 0.674, lonDeg: 23.473, name: 'Tranquility Base' } : null,
      milestones: [],
    };
    // The stack: the labels given; else, where the figures are derived, the stages of the vehicle the fake is
    // published as; else the generic four. The stages a scenario starts with fired are fired.
    const vehicle = this.scenario.vehicle !== '' ? this.defs.vehicles[this.scenario.vehicle] : undefined;
    this.vehicleStack = opts.stageLabels === undefined && this.derived && vehicle !== undefined;
    this.stageLabels = opts.stageLabels ?? (this.vehicleStack ? vehicle!.stages.map((s) => s.label) : ['Launch', 'Stage separation', 'Fairing jettison', 'Parachutes']);
    const fired = this.scenario.stagesAlreadyFired;
    if (!Number.isInteger(fired) || fired < 0 || fired > this.stageLabels.length) throw new Error(`FakeSession: stagesAlreadyFired is ${fired}, and the stack has ${this.stageLabels.length} stages`);
    this.nextStage = fired;
    // A dock link and a port name PARTS: the two scenes about them are built from the part list.
    if ((opts.scene === 'dockingApproach' || opts.scene === 'assembly') && this.parts.length === 0) throw new Error(`FakeSession: the scene '${opts.scene}' needs a part list (options.parts): its ports, links and control point name parts of it`);
    this.port = opts.scene === 'dockingApproach' ? this.findPort() : null;
    this.portStandoff = this.port ? Math.max(FAKE_PORT_STANDOFF, 2 * v3.dot(this.port.pos, this.port.dir)) : 0;
    this.facing = quat.fromAxisAngle(v3.anyOrthogonal(this.port?.dir ?? v3.unitY()), Math.PI);
    // The approach starts with the own port looking along the track at the station's, and with the hold that keeps it there.
    this.q = this.port ? this.portAttitude(this.ut) : this.initialAttitude();
    this.q0 = quat.clone(this.q);
    this.others = this.sceneVessels(opts.scene);
    // The scenes about another vessel start with it selected: their readouts are there without a command.
    if (opts.scene === 'rendezvous' || opts.scene === 'timeLive') this.target = { kind: 'vessel', id: FAKE_TARGET_ID };
    else if (this.port) {
      this.target = { kind: 'port', vesselId: FAKE_STATION_ID, portId: partKey(FAKE_STATION_ID, this.port.instanceId) };
      this.sasMode = 'portAlign';
    } else if (opts.scene === 'echoes') this.target = { kind: 'vessel', id: FAKE_ECHO_RECORDED_ID };
    const ok = (): CommandResult => ({ ok: true });
    const needsTarget = { ok: false, reason: 'No vessel or port target' } as const;
    this.commands = {
      stage: () => {
        if (this.nextStage >= this.stageLabels.length) return { ok: false, reason: 'No stages left' };
        const stageIndex = this.nextStage++;
        this.events.push({ type: 'stageFired', ut: this.ut, vesselId: this.vesselId(), stageIndex, label: this.stageLabels[stageIndex]! });
        return ok();
      },
      abort: ok,
      setSasEnabled: (on) => ((this.sasEnabled = on), ok()),
      setSasMode: (mode) => {
        if (mode === 'maneuver' && this.nodes.length === 0) return { ok: false, reason: 'No maneuver node' };
        if ((mode === 'target' || mode === 'antiTarget') && (this.target === null || this.target.kind === 'body')) return needsTarget;
        if (mode === 'portAlign' && this.target?.kind !== 'port') return { ok: false, reason: 'No port target' };
        this.sasMode = mode;
        return ok();
      },
      setRcsEnabled: (on) => ((this.rcsEnabled = on), ok()),
      toggleLegs: () => {
        this.legsDeployed = !this.legsDeployed;
        this.events.push({ type: 'legsToggled', ut: this.ut, vesselId: this.vesselId(), deployed: this.legsDeployed });
        return ok();
      },
      toggleLights: () => ((this.lightsOn = !this.lightsOn), ok()),
      setFineControl: (on) => ((this.fineControl = on), ok()),
      setNavballMode: (mode) => {
        if (mode === 'target' && (this.target === null || this.target.kind === 'body')) return needsTarget;
        this.navballMode = mode;
        return ok();
      },
      setWarpLevel: (index) => {
        const max = this.maxWarpIndex();
        const next = clamp(Math.round(index), 0, WARP_LEVELS.length - 1);
        this.warpIndex = Math.min(next, max);
        this.events.push({ type: 'warpChanged', ut: this.ut, vesselId: this.vesselId(), index: this.warpIndex, factor: WARP_LEVELS[this.warpIndex]!, reason: next > max ? 'Cannot warp faster here' : null });
        return next > max ? { ok: false, reason: 'Cannot warp faster here' } : ok();
      },
      addNode: (ut) => {
        const id = `node-${++this.nodeSeq}`;
        this.nodes.push({ id, ut, dv: { prograde: 0, normal: 0, radial: 0 } });
        this.nodes.sort((a, b) => a.ut - b.ut);
        return id;
      },
      setNode: (id, edit: NodeEdit) => {
        const n = this.nodes.find((x) => x.id === id);
        if (!n) return { ok: false, reason: 'Unknown node' };
        if (edit.ut !== undefined) n.ut = edit.ut;
        if (edit.dv) Object.assign(n.dv, edit.dv);
        return ok();
      },
      removeNode: (id) => {
        const before = this.nodes.length;
        this.nodes = this.nodes.filter((x) => x.id !== id);
        return before === this.nodes.length ? { ok: false, reason: 'Unknown node' } : ok();
      },
      // A body, or what the scene has: another vessel of it, the port of its station.
      setTarget: (ref) => {
        if (ref !== null && ref.kind === 'body' && !this.defs.bodies[ref.id]) return { ok: false, reason: 'Unknown body' };
        if (ref !== null && ref.kind === 'vessel' && !this.others.some((o) => o.id === ref.id)) return { ok: false, reason: 'No such vessel in this scene' };
        if (ref !== null && ref.kind === 'port' && !(this.port !== null && ref.vesselId === FAKE_STATION_ID && ref.portId === partKey(FAKE_STATION_ID, this.port.instanceId))) return { ok: false, reason: 'No such port in this scene' };
        this.target = ref;
        // A hold or a navball mode that needs what is no longer selected falls back, as a session's does.
        if (ref === null || ref.kind === 'body') {
          if (this.sasMode === 'target' || this.sasMode === 'antiTarget' || this.sasMode === 'portAlign') this.sasMode = 'stability';
          if (this.navballMode === 'target') this.navballMode = this.spec.kind === 'orbit' ? 'orbit' : 'surface';
        } else if (ref.kind !== 'port' && this.sasMode === 'portAlign') this.sasMode = 'stability';
        return ok();
      },
      cycleActiveVessel: () => ({ ok: false, reason: 'No other controllable vessel' }),
    };
    // A target given for the start is selected as the command would select it.
    if (opts.target !== undefined) {
      const selected = this.commands.setTarget(opts.target);
      if (!selected.ok) throw new Error(`FakeSession: the scene '${opts.scene}' cannot start with the target ${JSON.stringify(opts.target)}: ${selected.reason}`);
    }
    const cheat = (): void => {
      this.cheatCounter++;
    };
    this.debug = { setVesselState: cheat, setResource: cheat, setUt: cheat };
    this.fakeStores = this.buildStores(opts.scene, site?.id ?? '');
    this.stores = this.fakeStores;
    const refused = (what: string): CommandResult => ({ ok: false, reason: `The fake session cannot ${what}` });
    // The queue scene starts with its launch request in flight: the entry in the store and the promise that waits.
    if (this.fakeStores.launchQueue.get() !== null) void this.waitInQueue();
    this.universe = {
      // Every pad of the queue scene is taken, so a launch asked for there waits (one at a time: a session has at
      // most one spawn in flight); in every other scene the fake launches nothing and says so at once.
      spawn: (request) => {
        if (this.scene !== 'launchQueue') return Promise.resolve({ ok: false, reason: 'The fake session launches nothing', alternative: null });
        if (this.spawnInFlight !== null) return Promise.resolve({ ok: false, reason: 'A launch request of this session is already waiting for a pad', alternative: null });
        const pad = this.defs.sites[request.site] ? padsOf(this.defs.sites[request.site]!).find((p) => p.id === request.pad) : undefined;
        if (!pad) return Promise.resolve({ ok: false, reason: 'No such pad', alternative: null });
        this.queuedAt = this.ut;
        this.fakeStores.launchQueue.set({ request: { ...request, slot: { ...request.slot } }, padClass: pad.class, ...this.queuePlace(this.ut) });
        this.setQueuedCount(1);
        return this.waitInQueue();
      },
      // Leaving the queue ends the waiting spawn as the contract says: refused, with the reason that the player left.
      cancelSpawn: () => {
        const waiting = this.spawnInFlight;
        if (waiting === null) return Promise.resolve({ ok: false, reason: 'No launch request is waiting' });
        this.spawnInFlight = null;
        this.fakeStores.launchQueue.set(null);
        this.setQueuedCount(0);
        waiting.resolve({ ok: false, reason: 'Left the launch queue', alternative: null });
        return Promise.resolve(ok());
      },
      attach: () => Promise.resolve({ ok: false, reason: 'The fake session has one seat', alternative: null }),
      detach: () => Promise.resolve(refused('leave its seat')),
      subscribe: () => undefined,
      rename: () => Promise.resolve(refused('rename a craft')),
      abandon: () => Promise.resolve(refused('abandon a craft')),
    };
  }

  get needsIntegration(): boolean {
    return this.controls.throttle > 0 || (this.spec.kind === 'surface' && (this.spec.climbRate ?? 0) !== 0) || this.spec.plasma !== undefined;
  }

  get nextEventUt(): number {
    return this.nodes[0]?.ut ?? Infinity;
  }

  terrainPending(): Promise<void> | null {
    return null;
  }

  setControls(inputs: ControlInputs): void {
    this.controls = { ...inputs, translate: v3.clone(inputs.translate), throttle: clamp(inputs.throttle, 0, 1) };
  }

  advance(realDt: number, onControlTick?: () => void): void {
    onControlTick?.();
    const dt = clamp(realDt, 0, 0.1) * WARP_LEVELS[this.warpIndex]!;
    this.integrate(dt, clamp(realDt, 0, 0.1));
  }

  step(): void {
    this.integrate(PHYSICS_DT, PHYSICS_DT);
  }

  advanceRails(targetUt: number): number {
    const t = Math.min(targetUt, this.nextEventUt);
    if (t > this.ut) this.integrate(t - this.ut, 0);
    return this.ut;
  }

  stateHash(): string {
    return `${this.ut.toFixed(6)}|${this.q.x.toFixed(9)},${this.q.y.toFixed(9)},${this.q.z.toFixed(9)},${this.q.w.toFixed(9)}|${this.nextStage}`;
  }

  /**
   * Replace the render root by the centre of `bodyId`, as a sphere-of-influence change of the focus does: the
   * frame epoch increases, the next snapshot() carries the rebase, and every later snapshot lists the old
   * origin among the earlier ones. The scene itself (where the vessel is, what it orbits) does not change.
   */
  setRenderRoot(bodyId: string): void {
    this.body(bodyId);
    if (bodyId === this.originBodyId) return;
    const oldState = this.bodyState(this.originBodyId, this.ut);
    const newState = this.bodyState(bodyId, this.ut);
    const step: FrameRebase = { offset: v3.sub(oldState.r, newState.r), velocity: v3.sub(oldState.v, newState.v) };
    // Composed over every replacement since the last snapshot(), as the contract says.
    this.pendingRebase = this.pendingRebase ? { offset: v3.add(this.pendingRebase.offset, step.offset), velocity: v3.add(this.pendingRebase.velocity, step.velocity) } : step;
    this.earlierOrigins.unshift({ epoch: this.frameEpoch, bodyId: this.originBodyId });
    this.earlierOrigins.length = Math.min(this.earlierOrigins.length, FRAME_HISTORY_EPOCHS);
    this.frameEpoch++;
    this.originBodyId = bodyId;
  }

  /**
   * The two ports of the 'dockingApproach' scene with their states (the own control port first), by part
   * key. `DockingPortState` is not a member of `ModuleState` before the lead step of wave 4.1, so the states
   * are not in the part list yet; empty in every other scene.
   */
  portStates(): { partKey: string; state: DockingPortState }[] {
    if (this.port === null) return [];
    const own = partKey(FAKE_VESSEL_ID, this.port.instanceId);
    const theirs = partKey(FAKE_STATION_ID, this.port.instanceId);
    const state = this.dockPhase === 'approach' ? 'ready' : this.dockPhase;
    const progress = this.dockPhase === 'soft' ? clamp(this.softCaptureAge / FAKE_SOFT_CAPTURE_SECONDS, 0, 1) : 0;
    // In soft capture each port names the other vessel; docked, the two are ports of the one merged vessel.
    const peerOf = (vesselId: string, key: string): DockingPortState['peer'] => (this.dockPhase === 'approach' ? null : { vesselId: this.dockPhase === 'hard' ? this.vesselId() : vesselId, partKey: key });
    return [
      { partKey: own, state: { type: 'dockingPort', state, armed: true, peer: peerOf(FAKE_STATION_ID, theirs), progress } },
      { partKey: theirs, state: { type: 'dockingPort', state, armed: true, peer: peerOf(FAKE_VESSEL_ID, own), progress } },
    ];
  }

  // -------------------------------------------------------------------------------------------- kinematics

  /**
   * The id of the viewer's vessel: the craft's own id while it is one launched craft; an assembly's id
   * (`a~<lower vessel id>~<tick>`, contracts/sim.ts "Ids") in the assembly scene and once the docking scene
   * has docked, where the lower of the two vessel ids is the station's and the tick is that of the hard dock.
   */
  private vesselId(): string {
    if (this.scene === 'assembly') return FAKE_ASSEMBLY_ID;
    return this.dockPhase === 'hard' ? `a~${FAKE_STATION_ID}~${this.dockTick}` : FAKE_VESSEL_ID;
  }

  /**
   * The docking port of the craft the part list builds: the first part with an attach node of kind 'dock'
   * (its face is that node), else the craft's first part, whose face is the top of its envelope along its +Y.
   */
  private findPort(): FakePort {
    const face = (p: PartSnapshot, pos: Vec3, dir: Vec3): FakePort => ({ instanceId: p.instanceId, pos: v3.add(p.localPos, quat.rotate(p.localRot, pos)), dir: v3.normalize(quat.rotate(p.localRot, dir)) });
    for (const p of this.parts) {
      const node = this.defs.parts[p.def]?.attachNodes.find((n) => n.kind === 'dock');
      if (node) return face(p, v3.fromTuple(node.pos), v3.fromTuple(node.dir));
    }
    const first = this.parts[0]!;
    return face(first, v3.new(0, this.defs.parts[first.def]?.bounds.yMax ?? 0, 0), v3.unitY());
  }

  /** The attitude of a craft whose port looks forward along the track at `ut` (the dorsal side away from the body). */
  private portAttitude(ut: number): Quat {
    const s = this.vesselState(ut);
    const y = v3.normalize(s.v);
    const z = v3.normalize(v3.reject(v3.normalize(s.r), y));
    return quat.normalize(quat.mul(quat.fromBasis(v3.cross(y, z), y, z), quat.fromTo(this.port!.dir, v3.unitY())));
  }

  private sceneVessels(scene: FakeSessionScene): OtherVessel[] {
    const other = (id: string, name: string, higher: number, ahead: number, presence: Presence = 'solid', timeOffset = 0, closing = 0, standoff = 0, attended = true): OtherVessel => ({ id, craftId: id, name, ownerId: OTHER_ACCOUNT, ownerCallsign: OTHER_CALLSIGN, higher, ahead, closing, standoff, presence, timeOffset, attended });
    switch (scene) {
      case 'rendezvous':
        // 150 m higher (slower) and 2 km ahead: the viewer catches up in about two hours and passes 150 m below.
        return [other(FAKE_TARGET_ID, 'Vega 2', 150, 2000)];
      case 'timeLive':
        return [other(FAKE_TARGET_ID, 'Vega 2', 0, 3000)];
      case 'dockingApproach':
        // A parked station (its owner is not aboard: the helm is vacant), its port 13.8 m in front of the viewer's.
        return [other(FAKE_STATION_ID, 'Harbour', 0, FAKE_APPROACH_GAP + this.portStandoff, 'solid', 0, FAKE_CLOSING_SPEED, this.portStandoff, false)];
      case 'echoes':
        // An hour behind the viewer's clock (what it did then, replayed), and two hours ahead of it (where it will be).
        return [
          other(FAKE_ECHO_RECORDED_ID, 'Vega 2', 60, 13_000, 'recordedEcho', -3600 * TICKS_PER_SECOND),
          other(FAKE_ECHO_PROJECTED_ID, 'Altair', -80, -20_000, 'projectedEcho', 7200 * TICKS_PER_SECOND),
        ];
      default:
        return [];
    }
  }

  private maxWarpIndex(): number {
    return this.needsIntegration ? MAX_PHYSICS_WARP_INDEX : WARP_LEVELS.length - 1;
  }

  private integrate(simDt: number, attitudeDt: number): void {
    this.ut += simDt;
    this.tick++;
    if (this.warpIndex > this.maxWarpIndex()) this.warpIndex = this.maxWarpIndex();
    const tau = this.controls.throttle > this.throttleActual ? 0.8 : 0.3;
    this.throttleActual += (this.controls.throttle - this.throttleActual) * Math.min(1, attitudeDt / tau);
    // Engine clocks, as the real engine module keeps them: 0 on the step the engines light, counting while
    // they burn; the shutdown clock starts at 0 on the step they go out and counts while they are off.
    const lit = this.throttleActual > 0.02;
    if (lit && !this.enginesLit) {
      this.ignitionAge = 0;
      this.shutdownAge = -1;
    } else if (lit) this.ignitionAge += simDt;
    else if (this.enginesLit) this.shutdownAge = 0;
    else if (this.shutdownAge >= 0) this.shutdownAge += simDt;
    this.enginesLit = lit;
    const rate = (this.fineControl ? 6 : 20) * DEG;
    const c = this.controls;
    // pitch up = +X rotation, yaw right = -Z rotation, roll right = +Y rotation (VES frame)
    this.w = { x: c.pitch * rate, y: c.roll * rate, z: -c.yaw * rate };
    if (attitudeDt > 0) {
      this.q = quat.normalize(quat.mul(this.q, quat.fromRotVec(v3.scale(this.w, attitudeDt))));
      if (this.sasEnabled && this.sasMode !== 'stability' && c.pitch === 0 && c.yaw === 0) {
        const target = this.holdDirection(this.sasMode);
        if (target) {
          // What a hold points: the nose, or the port's axis for the hold on a port.
          const nose = quat.rotate(this.q, this.sasMode === 'portAlign' && this.port ? this.port.dir : v3.unitY());
          const fix = quat.fromTo(nose, target);
          this.q = quat.normalize(quat.mul(quat.slerp(quat.identity(), fix, Math.min(1, attitudeDt * 1.5)), this.q));
        }
      }
    }
    this.nodes = this.nodes.filter((n) => n.ut > this.ut - 1);
    if (this.scene === 'dockingApproach') this.advanceDocking(simDt);
    if (this.scene === 'launchQueue') this.advanceQueue();
  }

  /**
   * The docking of the station scene: the port faces meet, hold in soft capture, and dock. Each change is an
   * event. The hard dock merges the two vessels as the simulation's `dockMerge` does (ARCHITECTURE 7.5,
   * docs/handoff/sim-core-v2.md step 3; `build` has the merged vessel): the two are the same craft and so equal
   * in mass, which makes the lower vessel id, the station, the base. Its helm stays, and being vacant (the
   * station is parked) it is granted at once to the pilot aboard, the viewer; the stores follow.
   */
  private advanceDocking(simDt: number): void {
    const station = this.others[0]!;
    const own = partKey(FAKE_VESSEL_ID, this.port!.instanceId);
    const theirs = partKey(FAKE_STATION_ID, this.port!.instanceId);
    if (this.dockPhase === 'approach' && this.aheadOf(station, this.ut) <= station.standoff) {
      this.dockPhase = 'soft';
      this.softCaptureAge = 0;
      this.events.push({ type: 'dockCapture', ut: this.ut, vesselId: FAKE_VESSEL_ID, partId: own, otherVesselId: station.id, otherPartId: theirs });
    } else if (this.dockPhase === 'soft') {
      this.softCaptureAge += simDt;
      if (this.softCaptureAge >= FAKE_SOFT_CAPTURE_SECONDS) {
        this.dockPhase = 'hard';
        this.dockTick = Math.round(this.ut * TICKS_PER_SECOND);
        const merged = this.vesselId();
        // The merged vessel, the base's port and the arriving one's; the arriving vessel's id is the tombstone.
        this.events.push({ type: 'docked', ut: this.ut, vesselId: merged, partId: theirs, otherPartId: own, absorbedVesselId: FAKE_VESSEL_ID });
        this.events.push({ type: 'helmChanged', ut: this.ut, vesselId: merged, accountId: FAKE_ACCOUNT, callsign: FAKE_CALLSIGN, craftId: FAKE_VESSEL_ID });
        this.publishVessels();
      }
    }
  }

  /**
   * The spawn that waits in the launch queue: the very promise `universe.spawn` returned for it, pending while
   * `stores.launchQueue` holds its entry (the queue scene starts with one, as if the menu had asked for the
   * launch before the scene began). It resolves when the request ends, which in the fake is `cancelSpawn()`
   * only: the fake's pads never come free. null when nothing waits.
   */
  get pendingSpawn(): Promise<SeatResult> | null {
    return this.spawnInFlight?.promise ?? null;
  }

  /** A launch request starts to wait: the promise its `spawn` stays pending on. */
  private waitInQueue(): Promise<SeatResult> {
    let resolve!: (result: SeatResult) => void;
    const promise = new Promise<SeatResult>((r) => {
      resolve = r;
    });
    this.spawnInFlight = { promise, resolve };
    return promise;
  }

  /** The place of the waiting request and its estimate at `ut`: third at first, one place nearer every minute. */
  private queuePlace(ut: number): { position: number; etaSeconds: number } {
    const waited = ut - this.queuedAt;
    const position = Math.max(1, 3 - Math.floor(waited / 60));
    return { position, etaSeconds: Math.max(0, 180 * position - Math.floor(waited % 60)) };
  }

  /** The waiting launch request of the queue scene moves up: a new entry whenever the place or the estimate changes. */
  private advanceQueue(): void {
    const entry = this.fakeStores.launchQueue.get();
    if (entry === null) return;
    const place = this.queuePlace(this.ut);
    if (place.position !== entry.position || place.etaSeconds !== entry.etaSeconds) this.fakeStores.launchQueue.set({ ...entry, ...place });
  }

  /** The presence summary counts the requests that wait for a pad. */
  private setQueuedCount(queued: number): void {
    const presence = this.fakeStores.presence.get();
    if (presence.summary.queued !== queued) this.fakeStores.presence.set({ ...presence, summary: { ...presence.summary, queued } });
  }

  private body(id: string): BodyDef {
    const b = this.defs.bodies[id];
    if (!b) throw new Error(`FakeSession: unknown body ${id}`);
    return b;
  }

  /** State of a body about the library's root body, ROOT axes (the frame every other number here is built in). */
  private bodyState(id: string, ut: number): { r: Vec3; v: Vec3; conic: ConicElements | null } {
    const b = this.body(id);
    if (b.parent === null || !b.orbit) return { r: v3.zero(), v: v3.zero(), conic: null };
    if (b.orbit.kind === 'sunLowPrecision') {
      const r = sunRoot(ut);
      const r2 = sunRoot(ut + 1);
      return { r, v: v3.sub(r2, r), conic: null };
    }
    // Circular approximation of the Kepler orbit (fake!): same plane and period, zero eccentricity.
    const o = b.orbit;
    const parent = this.body(b.parent);
    const n = Math.sqrt((parent.mu + b.mu) / o.a ** 3);
    const theta = (o.argPeDeg + o.meanAnomalyDeg) * DEG + n * (ut - o.epochUt);
    const inc = o.iDeg * DEG;
    const lan = o.lanDeg * DEG;
    const basis = (th: number): Vec3 => {
      const x = Math.cos(th);
      const y = Math.sin(th);
      let p: Vec3 = {
        x: Math.cos(lan) * x - Math.sin(lan) * Math.cos(inc) * y,
        y: Math.sin(lan) * x + Math.cos(lan) * Math.cos(inc) * y,
        z: Math.sin(inc) * y,
      };
      if (o.frame === 'ecliptic') p = rotX(p, OBLIQUITY);
      return p;
    };
    const r = v3.scale(basis(theta), o.a);
    const v = v3.scale(basis(theta + Math.PI / 2), o.a * n);
    const parentState = this.bodyState(b.parent, ut);
    return { r: v3.add(parentState.r, r), v: v3.add(parentState.v, v), conic: conicFromState(parent.mu + b.mu, r, v, ut) };
  }

  /** BCBF -> ROOT orientation and spin vector (fake: spin about ROOT +Z for fixedRate, orbit-locked otherwise). */
  private bodyOrientation(id: string, ut: number): { q: Quat; spin: Vec3 } {
    const b = this.body(id);
    if (b.rotation.mode === 'fixedRate') {
      const rate = (b.rotation.rateDegPerDay * DEG) / 86400;
      const angle = (90 + b.rotation.w0Deg) * DEG + rate * (ut - b.rotation.epochUt);
      return { q: quat.fromAxisAngle(v3.unitZ(), angle % TWO_PI), spin: v3.new(0, 0, rate) };
    }
    if (b.rotation.mode === 'tidalLock' && b.parent) {
      const s = this.bodyState(id, ut);
      const p = this.bodyState(b.parent, ut);
      const rel = v3.sub(s.r, p.r);
      const x = v3.normalize(v3.neg(rel));
      const z = v3.normalize(v3.cross(rel, v3.sub(s.v, p.v)));
      const y = v3.cross(z, x);
      const period = s.conic?.period ?? Infinity;
      return { q: quat.fromBasis(x, y, z), spin: v3.scale(z, TWO_PI / period) };
    }
    return { q: quat.identity(), spin: v3.zero() };
  }

  /** Vessel state in BCI of the scene body. */
  private vesselState(ut: number): { r: Vec3; v: Vec3; altitude: number } {
    const b = this.body(this.spec.bodyId);
    const t = ut - this.ut0;
    if (this.spec.kind === 'surface') {
      const { q, spin } = this.bodyOrientation(b.id, ut);
      const climb = this.spec.climbRate ?? 0;
      // On real ground a standing scene starts on it (plus its clearance) and nothing sinks below it.
      const g = this.ground;
      const floor = g ? g.height + g.originHeight : 30;
      const start = g && climb === 0 ? floor + (g.clearance ?? 0) : this.spec.altitude;
      const altitude = clamp(start + climb * t, floor, 150e3);
      const r = v3.scale(quat.rotate(q, this.siteDir), b.radius + altitude);
      const moving = altitude > floor && altitude < 150e3;
      const v = v3.add(v3.cross(spin, r), v3.scale(v3.normalize(r), moving ? climb : 0));
      return { r, v, altitude };
    }
    const radius = b.radius + this.spec.altitude;
    const n = Math.sqrt(b.mu / radius ** 3);
    const th = this.orbitPhase0 + n * t;
    const inc = (this.spec.inclinationDeg ?? 0) * DEG;
    const at = (a: number): Vec3 => ({ x: Math.cos(a), y: Math.sin(a) * Math.cos(inc), z: Math.sin(a) * Math.sin(inc) });
    return { r: v3.scale(at(th), radius), v: v3.scale(at(th + Math.PI / 2), radius * n), altitude: this.spec.altitude };
  }

  /** How far ahead of the viewer along the track another vessel is at `ut`, m (a closing vessel stops at its stand-off). */
  private aheadOf(o: OtherVessel, ut: number): number {
    return o.closing > 0 ? Math.max(o.standoff, o.ahead - o.closing * (ut - this.ut0)) : o.ahead;
  }

  /**
   * State of another vessel in BCI of the scene body: on the viewer's orbit plane, `higher` metres above the
   * viewer's orbit. A free one (`closing` 0) is on its own circular orbit from `ahead` metres in front of the
   * viewer at the start; a closing one keeps the viewer's rate and comes nearer along the track.
   */
  private otherState(o: OtherVessel, ut: number): { r: Vec3; v: Vec3 } {
    const b = this.body(this.spec.bodyId);
    const t = ut - this.ut0;
    const own = b.radius + this.spec.altitude;
    const radius = own + o.higher;
    const inc = (this.spec.inclinationDeg ?? 0) * DEG;
    const at = (a: number): Vec3 => ({ x: Math.cos(a), y: Math.sin(a) * Math.cos(inc), z: Math.sin(a) * Math.sin(inc) });
    if (o.closing > 0) {
      const n = Math.sqrt(b.mu / own ** 3);
      const ahead = this.aheadOf(o, ut);
      const th = this.orbitPhase0 + n * t + ahead / radius;
      const rate = ahead > o.standoff ? -o.closing : 0;
      return { r: v3.scale(at(th), radius), v: v3.scale(at(th + Math.PI / 2), radius * n + rate) };
    }
    const n = Math.sqrt(b.mu / radius ** 3);
    const th = this.orbitPhase0 + o.ahead / radius + n * t;
    return { r: v3.scale(at(th), radius), v: v3.scale(at(th + Math.PI / 2), radius * n) };
  }

  /** The other vessel the target selection names (a port's vessel for a port), or null. */
  private targetVessel(): OtherVessel | null {
    const t = this.target;
    if (t === null || t.kind === 'body') return null;
    const id = t.kind === 'vessel' ? t.id : t.vesselId;
    return this.others.find((o) => o.id === id) ?? null;
  }

  private surfaceVelocity(ut: number): Vec3 {
    const s = this.vesselState(ut);
    const { spin } = this.bodyOrientation(this.spec.bodyId, ut);
    return v3.sub(s.v, v3.cross(spin, s.r));
  }

  private frameDirs(ut: number): { prograde: Vec3; normal: Vec3; radialOut: Vec3 } {
    const s = this.vesselState(ut);
    const useSurface = this.navballMode === 'surface';
    let vel = useSurface ? this.surfaceVelocity(ut) : s.v;
    // Relative to the target: the velocity relative to it (the orbital one where the two do not move apart).
    const other = this.navballMode === 'target' ? this.targetVessel() : null;
    if (other) {
      const rel = v3.sub(s.v, this.otherState(other, ut).v);
      if (v3.len(rel) >= 1e-3) vel = rel;
    }
    if (v3.len(vel) < 0.05 && !other) vel = v3.normalize(s.r);
    const prograde = v3.normalize(vel);
    // Unit vectors first: crossing the raw position with a near-parallel velocity loses all precision.
    let normal = v3.cross(v3.normalize(s.r), prograde);
    normal = v3.len(normal) < 1e-6 ? v3.anyOrthogonal(prograde) : v3.normalize(normal);
    return { prograde, normal, radialOut: v3.cross(prograde, normal) };
  }

  private holdDirection(mode: SasMode): Vec3 | null {
    const f = this.frameDirs(this.ut);
    switch (mode) {
      case 'prograde':
        return f.prograde;
      case 'retrograde':
        return v3.neg(f.prograde);
      case 'normal':
        return f.normal;
      case 'antinormal':
        return v3.neg(f.normal);
      case 'radialOut':
        return f.radialOut;
      case 'radialIn':
        return v3.neg(f.radialOut);
      case 'maneuver':
        return this.nodeDvRoot(this.nodes[0]) ?? null;
      case 'target':
      case 'antiTarget':
      case 'portAlign': {
        // Toward the target, away from it, or (the two ports face each other along the track) toward its port.
        const other = this.targetVessel();
        if (!other) return null;
        const dir = v3.normalize(v3.sub(this.otherState(other, this.ut).r, this.vesselState(this.ut).r));
        return mode === 'antiTarget' ? v3.neg(dir) : dir;
      }
      default:
        return null;
    }
  }

  private nodeDvRoot(node: ManeuverNode | undefined): Vec3 | null {
    if (!node || this.spec.kind !== 'orbit') return null;
    const s = this.vesselState(node.ut);
    const p = v3.normalize(s.v);
    const n = v3.normalize(v3.cross(s.r, s.v));
    const ro = v3.cross(p, n);
    const dv = v3.add(v3.add(v3.scale(p, node.dv.prograde), v3.scale(n, node.dv.normal)), v3.scale(ro, node.dv.radial));
    return v3.len(dv) > 1e-6 ? v3.normalize(dv) : null;
  }

  private enu(ut: number): { e: Vec3; n: Vec3; u: Vec3 } {
    const s = this.vesselState(ut);
    const u = v3.normalize(s.r);
    let e = v3.cross(v3.unitZ(), u);
    e = v3.len(e) < 1e-9 ? v3.unitY() : v3.normalize(e);
    return { e, n: v3.cross(u, e), u };
  }

  private initialAttitude(): Quat {
    const { e, u } = this.enu(this.ut);
    if (this.spec.kind === 'surface') {
      // Nose up (also under parachutes: the lines leave at the apex and the heat shield faces the ground),
      // ventral (-Z) facing east; X = Y x Z keeps the frame right-handed.
      const y = u;
      const z = v3.neg(e);
      return quat.fromBasis(v3.cross(y, z), y, z);
    }
    const f = this.frameDirs(this.ut);
    const y = this.spec.plasma !== undefined ? v3.neg(f.prograde) : f.prograde;
    const z = v3.normalize(v3.reject(u, y));
    return quat.fromBasis(v3.cross(y, z), y, z);
  }

  // ------------------------------------------------------------------------------------------ render root

  /** True while the origin is the library's root body: every number is already relative to it. */
  private originIsRoot(): boolean {
    return this.originBodyId === this.defs.rootBodyId;
  }

  /** A body's ROOT state in the render root at `ut` (the origin body itself is at exactly zero). */
  private bodyStateRoot(id: string, ut: number): { r: Vec3; v: Vec3; conic: ConicElements | null } {
    const s = this.bodyState(id, ut);
    if (this.originIsRoot()) return s;
    if (id === this.originBodyId) return { r: v3.zero(), v: v3.zero(), conic: s.conic };
    const o = this.bodyState(this.originBodyId, ut);
    return { r: v3.sub(s.r, o.r), v: v3.sub(s.v, o.v), conic: s.conic };
  }

  private frameBlock(ut: number, drain: boolean): SnapshotFrame {
    const now = this.bodyState(this.originBodyId, ut);
    const previous: FrameEpochOrigin[] = this.earlierOrigins.map((e) => {
      const s = this.bodyState(e.bodyId, ut);
      return { epoch: e.epoch, offset: v3.sub(s.r, now.r), velocity: v3.sub(s.v, now.v) };
    });
    const rebase = this.pendingRebase;
    if (drain) this.pendingRebase = null;
    return { epoch: this.frameEpoch, origin: { kind: 'body', bodyId: this.originBodyId }, rebase, previous };
  }

  // ---------------------------------------------------------------------------------------------- snapshot

  private patchFor(conic: ConicElements, bodyId: string, tStart: number, rStart: Vec3, afterNodeId?: string): Patch {
    const body = this.body(bodyId);
    const nuStart = conicTrueAnomaly(conic, rStart);
    const closed = conic.period !== null;
    const tEnd = closed ? tStart + conic.period! : tStart + 5 * 86400;
    const { rp, ra } = conicApsides(conic);
    const markers: Marker[] = [];
    const tPe = tStart + (closed ? this.timeToNu(conic, nuStart, 0) : 0);
    if (closed) {
      markers.push({ kind: 'periapsis', ut: tPe, bodyId, r: conicPosition(conic, 0), altitude: rp - body.radius });
      markers.push({ kind: 'apoapsis', ut: tStart + this.timeToNu(conic, nuStart, Math.PI), bodyId, r: conicPosition(conic, Math.PI), altitude: ra - body.radius });
    }
    return {
      bodyId,
      conic,
      tStart,
      tEnd,
      nuStart,
      nuEnd: closed ? nuStart + TWO_PI : nuStart + 2,
      endReason: closed ? 'closed' : 'horizon',
      afterNodeId,
      // Where the patch's body is at the end of the patch, relative to where the origin body is then.
      bodyPosAtEnd: this.bodyStateRoot(bodyId, tEnd).r,
      markers,
    };
  }

  private timeToNu(conic: ConicElements, nuFrom: number, nuTo: number): number {
    let dt = timeSincePeriapsis(conic, nuTo) - timeSincePeriapsis(conic, nuFrom);
    if (conic.period !== null) dt = ((dt % conic.period) + conic.period) % conic.period;
    return dt;
  }

  /** Scenario landing target, the site and its recovery zones as SurfaceTargets. */
  private surfaceTargets(): SurfaceTarget[] {
    const out: SurfaceTarget[] = [];
    const l = this.scenario.suggestedLanding;
    if (l) out.push({ id: 'landing', name: l.name, bodyId: l.bodyId, kind: 'landing', latitude: l.latDeg * DEG, longitude: l.lonDeg * DEG, radius: 0 });
    const site = this.defs.sites[this.scenario.site];
    if (site) {
      // The launch site as a target is its first pad: with derived figures by the pad's full name and its own
      // coordinates, as a session states it; v1 named the site and stated the site's.
      const pad = padOf(site);
      const where = this.derived ? padLocationOf(site, pad.id) : site.location;
      out.push({ id: `site:${site.id}`, name: this.derived ? padTitle(site, pad.id) : site.name, bodyId: site.bodyId, kind: 'site', latitude: where.latDeg * DEG, longitude: where.lonDeg * DEG, radius: pad.flatRadius });
      site.recoveryZones.forEach((z, i) =>
        out.push({ id: `recovery:${i}`, name: z.name, bodyId: site.bodyId, kind: 'recovery', latitude: z.latDeg * DEG, longitude: z.lonDeg * DEG, radius: z.radiusKm * 1000 }),
      );
    }
    return out;
  }

  /** Range/bearing from the sub-point to the nearest landing or recovery target on the scene body (no prediction: fake). */
  private landingTargetReadout(targets: SurfaceTarget[], subDir: Vec3, groundTrackDir: Vec3 | null, radius: number): Readouts['landingTarget'] {
    let best: { t: SurfaceTarget; angle: number; dir: Vec3 } | null = null;
    for (const t of targets) {
      if (t.bodyId !== this.spec.bodyId || t.kind === 'site') continue;
      const dir = latLonToDir(t.latitude, t.longitude);
      const angle = v3.angle(subDir, dir);
      if (!best || angle < best.angle) best = { t, angle, dir };
    }
    if (!best) return null;
    // Local east/north at the sub-point in the body-fixed frame.
    let east = v3.cross(v3.unitZ(), subDir);
    east = v3.len(east) < 1e-9 ? v3.unitY() : v3.normalize(east);
    const north = v3.cross(subDir, east);
    const toTarget = v3.reject(best.dir, subDir);
    const hasDir = v3.len(toTarget) > 1e-12;
    const tHat = hasDir ? v3.normalize(toTarget) : north;
    const bearingDeg = ((Math.atan2(v3.dot(tHat, east), v3.dot(tHat, north)) / DEG) + 360) % 360;
    const distance = best.angle * radius;
    let downRange = 0;
    let crossRange = 0;
    if (groundTrackDir && hasDir) {
      const right = v3.cross(groundTrackDir, subDir);
      downRange = distance * v3.dot(tHat, groundTrackDir);
      crossRange = distance * v3.dot(tHat, right);
    }
    return { targetId: best.t.id, distance, bearingDeg, downRange, crossRange, predicted: null };
  }

  /**
   * The parts of one craft of the scene: the given part list with its module states following the fake's
   * throttle, legs and lights (`live`: the viewer's own craft; another craft is shown as it was given), every
   * part stamped with the craft it belongs to. `pose` is the craft's own frame in the vessel's VES frame (a
   * craft that is not the vessel's base: its origin and its orientation there); null = the base craft.
   */
  private buildParts(pressure: number, craftId: string, live: boolean, pose: { pos: Vec3; rot: Quat } | null): PartSnapshot[] {
    return this.parts.map((p) => {
      const def = this.defs.parts[p.def];
      const modules = !live
        ? p.modules
        : p.modules.map((m, i): ModuleState => {
            const md = def?.modules[i];
            if (m.type === 'engine' && md?.type === 'engine') {
              const thr = m.active ? this.throttleActual : 0;
              const isp = md.ispVac - (md.ispVac - md.ispSL) * (pressure / 101325);
              const massFlow = (thr * md.thrustVac) / (md.ispVac * G0);
              return {
                ...m,
                throttleActual: thr,
                massFlow,
                thrust: Math.max(0, massFlow * G0 * isp),
                ambientPressure: pressure,
                pressureRatio: Math.min(1e6, (md.nozzles[0]?.exitPressure ?? 1e4) / Math.max(pressure, 1e-3)),
                // Engines that staging has not activated keep the clocks they were given.
                ...(m.active ? { ignitionAge: this.ignitionAge, shutdownAge: this.shutdownAge } : {}),
              };
            }
            if (m.type === 'legs') return { ...m, deploy: this.legsDeployed ? 1 : 0 };
            if (m.type === 'light') return { ...m, on: this.lightsOn };
            return m;
          });
      // (No part of the fake is a fairing petal unless the given part says it is one.)
      return { ...p, panel: p.panel ?? null, craftId, ...(pose ? { localPos: v3.add(pose.pos, quat.rotate(pose.rot, p.localPos)), localRot: quat.normalize(quat.mul(pose.rot, p.localRot)) } : {}), modules };
    });
  }

  /**
   * Mass (kg), centre of mass (VES) and bounding radius about the VES origin (m) of a part list, derived as
   * the simulation derives them (src/sim/vessel: `computeMassProps`, the structure's bounding sphere): each
   * part's dry mass at its centre-of-mass offset and each tank's content as a column from the tank's bottom,
   * a launch clamp that still holds counting nothing (it is ground structure); the radius reaches the far
   * rim of every part's envelope. A jettisoned fairing petal weighs its share of the fairing, taken at the
   * fairing's own centre. null when there is nothing to derive from: no parts, or a part whose definition the
   * library does not have (the sums cannot be made, and a part of them would be a wrong figure).
   */
  private bodyOf(parts: readonly PartSnapshot[]): { mass: number; com: Vec3; radius: number } | null {
    let mass = 0;
    let radius = 0;
    const moment = v3.zero();
    const add = (m: number, at: Vec3): void => {
      mass += m;
      moment.x += m * at.x;
      moment.y += m * at.y;
      moment.z += m * at.z;
    };
    for (const p of parts) {
      const def = this.defs.parts[p.def];
      if (!def) return null;
      const at = (x: number, y: number, z: number): Vec3 => v3.add(p.localPos, quat.rotate(p.localRot, v3.new(x, y, z)));
      const b = def.bounds;
      radius = Math.max(radius, v3.len(at(0, (b.yMin + b.yMax) / 2, 0)) + Math.hypot(b.radius, (b.yMax - b.yMin) / 2));
      if (p.modules.some((m) => m.type === 'launchClamp' && !m.released)) continue;
      const dry = p.panel ? def.dryMass / p.panel.count : def.dryMass;
      if (dry > 0) add(dry, at(def.comOffset[0], def.comOffset[1], def.comOffset[2]));
      for (const tank of def.resources ?? []) {
        const amount = p.resources[tank.resource] ?? 0;
        if (amount <= 0) continue;
        const fill = tank.capacity > 0 ? amount / tank.capacity : 0;
        add(amount, at(0, tank.tankBottomY + (fill * tank.tankHeight) / 2, 0));
      }
    }
    return mass > 0 ? { mass, com: v3.scale(moment, 1 / mass), radius } : null;
  }

  /**
   * The stages of the vehicle's stack that state burn figures, as a session's staging analysis decides it
   * (src/sim/vessel/facade.ts, `stagingInfo`): `owner`, the latest fired stage that ignited an engine which is
   * aboard and armed (lit by staging, not flamed out, with an ignition left or running): the burn under way;
   * and every stage still to fire that ignites an engine aboard. A fixed-burn motor is no such engine.
   */
  private burningStages(stack: VehicleDef['stages']): { stages: Set<number>; owner: number } {
    const aboard = new Map(this.parts.map((p) => [p.instanceId, p]));
    const engineOn = (id: string, armed: boolean): boolean => {
      const part = aboard.get(id);
      const modules = part ? this.defs.parts[part.def]?.modules : undefined;
      if (!part || !modules) return false;
      return modules.some((md, k) => {
        if (md.type !== 'engine' || md.fixedBurn) return false;
        const ms = part.modules[k];
        return !armed || (ms?.type === 'engine' && ms.active && !ms.flameout && (ms.ignitionsLeft === null || ms.ignitionsLeft > 0 || ms.throttleActual > 0));
      });
    };
    const ignites = (i: number, armed: boolean): boolean => stack[i]!.actions.some((a) => a.kind === 'igniteEngines' && a.parts.some((id) => engineOn(id, armed)));
    let owner = -1;
    for (let i = Math.min(this.nextStage, stack.length) - 1; i >= 0 && owner < 0; i--) if (ignites(i, true)) owner = i;
    const stages = new Set<number>(owner >= 0 ? [owner] : []);
    for (let i = this.nextStage; i < stack.length; i++) if (ignites(i, false)) stages.add(i);
    return { stages, owner };
  }

  /**
   * Relative inclination to the orbit plane of a body target, rad: the angle between the vessel's orbit plane
   * and the plane the target moves in about the same body. Standing on that body it is the least a launch
   * from the vessel's latitude reaches: the plane's inclination to the equator less the latitude, not below
   * zero. null when the target does not orbit the vessel's body (the contract: "not about the same body").
   */
  private planeAngleTo(bodyId: string, st: { r: Vec3; v: Vec3 }, ut: number): number | null {
    const target = this.defs.bodies[bodyId];
    if (!target || target.parent !== this.spec.bodyId) return null;
    const t = this.bodyState(bodyId, ut);
    const p = this.bodyState(target.parent, ut);
    const normal = v3.cross(v3.sub(t.r, p.r), v3.sub(t.v, p.v));
    if (v3.len(normal) === 0) return null;
    if (this.spec.kind === 'surface' && (this.spec.climbRate ?? 0) === 0) {
      const pole = quat.rotate(this.bodyOrientation(this.spec.bodyId, ut).q, v3.unitZ());
      const latitude = Math.asin(clamp(v3.dot(v3.normalize(st.r), pole), -1, 1));
      return Math.max(0, v3.angle(normal, pole) - Math.abs(latitude));
    }
    const own = v3.cross(st.r, st.v);
    return v3.len(own) > 0 ? v3.angle(own, normal) : null;
  }

  /** The instance id of the part of the given list that holds the craft's command module; null without one. */
  private commandPartOf(): string | null {
    for (const p of this.parts) if (this.defs.parts[p.def]?.modules.some((m) => m.type === 'command')) return p.instanceId;
    return null;
  }

  /**
   * The cockpit of the fake's craft, resolved as a session's assembler resolves it: the command part's own
   * (`command.cockpit`, `command.sensorCamera`), with the authoring fields of the vehicle the fake is
   * published as (`VehicleDef.cockpit`, `cameras.cockpit`) where they name that part. null without a command part.
   */
  private cockpitOf(commandPart: string | null): CraftCockpit | null {
    if (commandPart === null) return null;
    const part = this.parts.find((p) => p.instanceId === commandPart)!;
    const command = this.defs.parts[part.def]?.modules.find((m) => m.type === 'command');
    const vehicle = this.scenario.vehicle !== '' ? this.defs.vehicles[this.scenario.vehicle] : undefined;
    const authored = vehicle && vehicle.cameras.cockpit?.part === commandPart ? vehicle : undefined;
    const own = command?.type === 'command' ? command : undefined;
    const id = own?.cockpit ?? authored?.cockpit ?? null;
    // The crew by seat, as the vehicle the fake is published as lists them (a session states it the same way).
    const crew = (vehicle?.crew ?? []).map((m) => ({ seat: m.seat, name: m.name }));
    return { id, cameraSeat: id === null ? null : (authored?.cameras.cockpit?.seat ?? null), sensorMount: own?.sensorCamera ?? null, crew };
  }

  /** One craft block. `staging` is the craft's own stage stack: the viewer's craft has the panel's, another lists none. */
  private craftBlock(id: string, name: string, ownerId: string | null, ownerCallsign: string | null, staging: CraftSnapshot['staging'], boundingRadius: number): CraftSnapshot {
    const vehicle = this.scenario.vehicle !== '' ? this.defs.vehicles[this.scenario.vehicle] : undefined;
    const commandPart = this.commandPartOf();
    // The chase distances of the craft's vehicle; a craft of no vehicle is framed from its size alone.
    const chase = vehicle ? { ...vehicle.cameras.chase } : { defaultDistance: 2.4 * boundingRadius, minDistance: 1.15 * boundingRadius, maxDistance: 60 * boundingRadius };
    return {
      id,
      parent: null,
      vehicleId: this.scenario.vehicle,
      name,
      ownerId,
      ownerCallsign,
      commandPart,
      cockpit: this.cockpitOf(commandPart),
      staging,
      chase,
      policy: { ...DEFAULT_UNIVERSE_RULES.docking.defaultLendPolicy },
    };
  }

  /**
   * The part key of a craft's control point: its docking port in the docking scene (the instrument is about
   * the control port), else its command part, else its first part. A craft without parts has none and states
   * the empty string, as a session does.
   */
  private controlKey(craftId: string): string {
    if (this.parts.length === 0) return '';
    return partKey(craftId, this.port?.instanceId ?? this.commandPartOf() ?? this.parts[0]!.instanceId);
  }

  /**
   * The part key a dock link of the assembly scene names on a craft (the scene needs a part list): the craft's
   * first part, or its last one for the second link of the craft in the middle (a port holds one craft).
   */
  private linkKey(craftId: string, second = false): string {
    return partKey(craftId, this.parts[second ? this.parts.length - 1 : 0]!.instanceId);
  }

  /** The viewer's clock for the time strip: trivial like a session's on its own, or the scene's. */
  private timeView(ut: number): TimeView {
    const myTick = Math.round(ut * TICKS_PER_SECOND);
    const max = this.maxWarpIndex();
    const base: TimeView = {
      myTick,
      liveTick: myTick,
      rate: WARP_LEVELS[this.warpIndex]!,
      maxRate: WARP_LEVELS[max]!,
      limitedBy: this.needsIntegration ? { kind: 'physics', text: 'under acceleration or in atmosphere', vesselIds: [], accountIds: [] } : null,
      relation: 'live',
      offset: 0,
      clockId: null,
      clockKind: 'private',
      members: [],
      proposals: [],
      offers: [],
    };
    switch (this.scene) {
      case 'timeLive':
        // A shared clock with a bound member who asks for 1x: the rate is held, and a proposal of 50x is open.
        return {
          ...base,
          maxRate: 1,
          limitedBy: { kind: 'members', text: `Cannot warp: ${OTHER_CALLSIGN} is 3 km away and has not agreed`, vesselIds: [FAKE_TARGET_ID], accountIds: [OTHER_ACCOUNT] },
          clockId: 'fake-clock',
          clockKind: 'shared',
          members: [
            { accountId: FAKE_ACCOUNT, callsign: FAKE_CALLSIGN, vesselId: this.vesselId(), bound: true, requestedRate: 50, accepted: true, idle: false },
            { accountId: OTHER_ACCOUNT, callsign: OTHER_CALLSIGN, vesselId: FAKE_TARGET_ID, bound: true, requestedRate: 1, accepted: false, idle: false },
          ],
          proposals: [{ id: 'fake-proposal-1', kind: 'rate', fromAccountId: FAKE_ACCOUNT, fromCallsign: FAKE_CALLSIGN, rate: 50, toTick: null, expiresUpMs: 20_000 }],
          offers: [{ kind: 'follow', accountId: OTHER_ACCOUNT, label: `Follow ${OTHER_CALLSIGN}` }],
        };
      case 'timeAhead': {
        // A private clock two hours ahead of the live one.
        const offset = 7200 * TICKS_PER_SECOND;
        return { ...base, liveTick: myTick - offset, relation: 'ahead', offset, clockId: 'fake-clock', offers: [{ kind: 'hold', label: 'Hold until the live clock arrives' }] };
      }
      case 'timeBehind': {
        // The island was held and is a quarter of an hour behind: nothing runs faster until it has rejoined.
        const offset = -900 * TICKS_PER_SECOND;
        return {
          ...base,
          liveTick: myTick - offset,
          maxRate: 1,
          limitedBy: { kind: 'held', text: 'Behind the live clock: this island was held', vesselIds: [], accountIds: [] },
          relation: 'behind',
          offset,
          clockId: 'fake-clock',
          offers: [{ kind: 'rejoin', toTick: myTick - offset, label: 'Rejoin the live clock' }],
        };
      }
      default:
        return base;
    }
  }

  /** The one action that makes an echo reachable. */
  private offerFor(o: OtherVessel, myTick: number): TimeOffer | null {
    if (o.presence === 'recordedEcho') return { kind: 'askAdvance', vesselId: o.id, label: `Ask ${o.ownerCallsign ?? o.name} to advance` };
    if (o.presence === 'projectedEcho') return { kind: 'jump', toTick: myTick + o.timeOffset, toClockId: null, vesselId: o.id, inPhase: true, label: `Jump ahead to ${o.name}` };
    return null;
  }

  /** Navigation to the selected target, and the docking instrument when a port is targeted. */
  private targetReadouts(ut: number, st: { r: Vec3; v: Vec3 }, bodyState: { r: Vec3; v: Vec3 }, myTick: number): { target: TargetReadout | null; docking: DockingReadout | null; dir: Vec3 | null; relVel: Vec3 | null } {
    const t = this.target;
    if (t === null) return { target: null, docking: null, dir: null, relVel: null };
    if (t.kind === 'body') {
      const b = this.defs.bodies[t.id];
      if (!b) return { target: null, docking: null, dir: null, relVel: null };
      const s = this.bodyStateRoot(t.id, ut);
      const dr = v3.sub(s.r, v3.add(bodyState.r, st.r));
      const dv = v3.sub(s.v, v3.add(bodyState.v, st.v));
      const range = v3.len(dr);
      const target: TargetReadout = {
        ref: t,
        name: b.name,
        presence: 'solid',
        timeOffset: 0,
        range,
        rangeRate: range > 0 ? v3.dot(dr, dv) / range : 0,
        relVelocity: null,
        relSpeed: null,
        relativeInclination: this.derived ? this.planeAngleTo(t.id, st, ut) : 0.01,
        closestApproaches: [],
        lvlh: null,
        offer: null,
      };
      return { target, docking: null, dir: v3.normalize(dr), relVel: null };
    }
    const o = this.targetVessel();
    if (!o) return { target: null, docking: null, dir: null, relVel: null };
    const os = this.otherState(o, ut);
    const dr = v3.sub(os.r, st.r);
    const range = v3.len(dr);
    // In soft capture and docked the two craft are joined at the faces of their ports: nothing moves between them.
    const joined = this.port !== null && o.id === FAKE_STATION_ID && this.dockPhase !== 'approach';
    // Velocity relative to the target: the viewer's minus the target's.
    const rel = joined ? v3.zero() : v3.sub(st.v, os.v);
    const relSpeed = v3.len(rel);
    // The target's local-vertical frame: radial out, along its track, across it.
    const radial = v3.normalize(os.r);
    const cross = v3.normalize(v3.cross(os.r, os.v));
    const along = v3.cross(cross, radial);
    const own = v3.neg(dr);
    const b = this.body(this.spec.bodyId);
    const approaches: TargetReadout['closestApproaches'] = [];
    if (o.closing === 0 && o.higher !== 0) {
      // Two circular orbits in one plane: the two pass each other where their phases meet, one synodic period apart.
      const rOwn = b.radius + this.spec.altitude;
      const rOther = rOwn + o.higher;
      const nOwn = Math.sqrt(b.mu / rOwn ** 3);
      const nOther = Math.sqrt(b.mu / rOther ** 3);
      const gain = nOwn - nOther;
      const synodic = TWO_PI / Math.abs(gain);
      let first = this.ut0 + o.ahead / rOther / gain;
      while (first < ut) first += synodic;
      // Inside thirty days (the horizon of a plan), at most three.
      for (let k = 0; k < 3 && first + k * synodic - ut < 30 * 86400; k++) approaches.push({ ut: first + k * synodic, distance: Math.abs(o.higher), relSpeed: Math.abs(nOwn * rOwn - nOther * rOther) });
    }
    const target: TargetReadout = {
      ref: t,
      name: o.name,
      presence: o.presence,
      timeOffset: o.timeOffset,
      range: t.kind === 'port' ? (joined ? 0 : Math.max(0, range - this.portStandoff)) : range,
      rangeRate: range > 0 ? -v3.dot(dr, rel) / range : 0,
      relVelocity: quat.rotateInv(this.q, rel),
      relSpeed,
      relativeInclination: 0,
      closestApproaches: approaches,
      lvlh: range < 100e3 ? { radial: v3.dot(own, radial), along: v3.dot(own, along), cross: v3.dot(own, cross) } : null,
      offer: this.offerFor(o, myTick),
    };
    let docking: DockingReadout | null = null;
    if (t.kind === 'port') {
      // The ports face each other along the track; the misalignments of the approach die away over a minute, and
      // the hard dock leaves none.
      const settle = this.dockPhase === 'hard' ? 0 : Math.exp(-(ut - this.ut0) / 60);
      const axial = joined ? 0 : Math.max(0, range - this.portStandoff);
      const lateral: [number, number] = [0.35 * settle, -0.2 * settle];
      const angleDeg: [number, number] = [1.5 * settle, -0.8 * settle];
      const rollDeg = 4 * settle;
      const closing = this.dockPhase === 'approach' ? relSpeed : 0;
      const lateralSpeed = (Math.hypot(lateral[0], lateral[1]) / 60) * (this.dockPhase === 'approach' ? 1 : 0);
      const rateDegPerS = (Math.hypot(angleDeg[0], angleDeg[1], rollDeg) / 60) * (this.dockPhase === 'approach' ? 1 : 0);
      docking = {
        ownPort: partKey(FAKE_VESSEL_ID, this.port!.instanceId),
        targetPort: t.portId,
        compatible: true,
        targetArmed: true,
        axial,
        lateral,
        angleDeg,
        rollDeg,
        closing,
        lateralSpeed,
        rateDegPerS,
        within: {
          lateral: Math.hypot(lateral[0], lateral[1]) <= FAKE_ENVELOPE.lateral,
          angle: Math.hypot(angleDeg[0], angleDeg[1]) <= FAKE_ENVELOPE.angleDeg,
          roll: Math.abs(rollDeg) <= FAKE_ENVELOPE.rollDeg,
          closing: closing <= FAKE_ENVELOPE.closing,
          lateralSpeed: lateralSpeed <= FAKE_ENVELOPE.lateralSpeed,
          rate: rateDegPerS <= FAKE_ENVELOPE.rateDegPerS,
        },
        phase: this.dockPhase === 'approach' ? (axial > 200 ? 'far' : 'approach') : this.dockPhase,
      };
    }
    return { target, docking, dir: range > 0 ? v3.normalize(dr) : null, relVel: relSpeed >= 1e-3 ? v3.normalize(rel) : null };
  }

  snapshot(): SimSnapshot {
    const snap = this.build(true);
    this.events = [];
    return snap;
  }

  peek(): SimSnapshot {
    return this.build(false);
  }

  private build(drain: boolean): SimSnapshot {
    const ut = this.ut;
    const root = this.defs.rootBodyId;
    const star = Object.values(this.defs.bodies).find((b) => b.emission !== null);
    const starPos = star ? this.bodyStateRoot(star.id, ut).r : v3.new(1.5e11, 0, 0);
    const bodies: BodySnapshot[] = Object.values(this.defs.bodies).map((b) => {
      const s = this.bodyStateRoot(b.id, ut);
      const o = this.bodyOrientation(b.id, ut);
      const toSun = v3.sub(starPos, s.r);
      return {
        id: b.id,
        rRoot: s.r,
        vRoot: s.v,
        qFixedToRoot: o.q,
        spinRoot: o.spin,
        sunDir: b.id === star?.id ? v3.unitX() : v3.normalize(toSun),
        sunDistance: v3.len(toSun),
        orbit: b.orbit?.kind === 'kepler' ? s.conic : null,
        soiRadius: typeof b.soiRadius === 'number' ? b.soiRadius : null,
      };
    });

    const body = this.body(this.spec.bodyId);
    const bodyState = this.bodyStateRoot(body.id, ut);
    const st = this.vesselState(ut);
    const vSurf = this.surfaceVelocity(ut);
    const { e, n, u } = this.enu(ut);
    const hasAir = body.atmosphere !== null && st.altitude < body.atmosphere.simTop;
    const pressure = hasAir ? 101325 * Math.exp(-st.altitude / 7200) : 0;
    const density = hasAir ? 1.225 * Math.exp(-st.altitude / 7200) : 0;
    const speedSurf = v3.len(vSurf);
    const q = 0.5 * density * speedSurf * speedSurf;
    const craftId = FAKE_VESSEL_ID;
    const parts = this.buildParts(pressure, craftId, true, null);
    let thrust = 0;
    for (const p of parts) for (const m of p.modules) if (m.type === 'engine') thrust += m.thrust;
    if (parts.length === 0) thrust = this.throttleActual * 2.0e6;

    // What a stage says about itself (what it burns, its chutes, the engines it ignites) is the vehicle's that
    // the fake is published as, stage by stage, through the derivation a session uses; with those words go the
    // stage's action kinds (the two lists are parallel). A fake of no vehicle, and a stage the vehicle does not
    // have, state the neutral values.
    const vehicle = this.scenario.vehicle !== '' ? this.defs.vehicles[this.scenario.vehicle] : undefined;
    this.stageWords ??= vehicle ? describeStages(vehicle, (id) => this.defs.parts[id]) : [];
    const stageWords = this.stageWords;
    // With the vehicle's own stack (derived figures) a stage states its icon, and its burn figures where a
    // session states any: the fired stage whose armed engines are aboard (the burn under way) and every stage
    // still to fire that ignites an engine aboard; every other stage states the zeros and no propellant. The
    // figures themselves are stand-ins (the fake runs no staging analysis); v1's stack states them for every stage.
    const stack = this.vehicleStack && vehicle ? vehicle.stages : null;
    const burning = stack ? this.burningStages(stack) : null;
    const stages: StageInfo[] = this.stageLabels.map((label, i) => {
      const words = stageWords[i];
      const actionKinds = words && vehicle ? vehicle.stages[i]!.actions.map((a): string => a.kind) : ['engine'];
      const burns = burning === null || burning.stages.has(i);
      const underWay = burning === null ? i < this.nextStage : i === burning.owner;
      return {
        label,
        icon: stack ? stack[i]!.icon : i === this.stageLabels.length - 1 ? 'parachute' : 'engine',
        fired: i < this.nextStage,
        deltaVVac: burns ? 3000 : 0,
        deltaVNow: burns ? 2800 : 0,
        twr: burns ? 1.3 : 0,
        burnTime: burns ? 160 : 0,
        propellantFraction: !burns ? null : underWay ? 1 - this.throttleActual * 0.5 : 1,
        actionKinds,
        burnLabel: words ? words.burnLabel : null,
        thrustVac: words ? words.thrustVac : 0,
        weightFlowVac: words ? words.weightFlowVac : 0,
        actionChutes: words ? [...words.actionChutes] : actionKinds.map(() => null),
        chuteEnvelopes: words ? words.chuteEnvelopes : null,
      };
    });
    const staging = { nextStage: this.nextStage, stages, lockout: false };

    // The figures of one craft built from the part list (every craft of a scene is that craft): derived from
    // the parts as the simulation derives them, or the stand-in constants (v1's, and a craft without parts).
    const body1 = this.derived ? this.bodyOf(parts) : null;
    const craftMass = body1?.mass ?? 50000;
    const single = body1?.radius ?? 55;
    // The craft of the viewer's vessel: one; three side by side in the assembly scene (60 m apart, or with a
    // gap of a fifth of their size where that is derived); two once the docking scene has docked. A scene of
    // the shared universe with other owners in it names the viewer.
    const assembly = this.scene === 'assembly';
    const docked = this.port !== null && this.dockPhase === 'hard';
    const named = assembly || this.port !== null;
    const spacing = body1 ? 2.2 * body1.radius : 60;
    const noStack: CraftSnapshot['staging'] = { nextStage: 0, stages: [], lockout: false };
    const ownCraft = this.craftBlock(craftId, this.vesselName, named ? FAKE_ACCOUNT : null, named ? FAKE_CALLSIGN : null, staging, single);
    let crafts: CraftSnapshot[] = [ownCraft];
    const links: DockLinkSnapshot[] = [];
    let allParts = parts;
    // The vessel's own frame: the viewer's craft is its base, except docked to the station (below).
    let rigid = { name: this.vesselName, r: st.r, v: st.v, q: quat.clone(this.q), w: v3.clone(this.w), mass: craftMass, com: body1?.com ?? v3.zero(), radius: single };
    if (assembly) {
      const aboard: [string, string, string | null, string | null, number][] = [
        ['fake-craft-b', 'Vega 2', OTHER_ACCOUNT, OTHER_CALLSIGN, spacing],
        ['fake-craft-c', 'Derelict', null, null, -spacing],
      ];
      for (const [id, name, ownerId, callsign, x] of aboard) {
        crafts.push(this.craftBlock(id, name, ownerId, callsign, noStack, single));
        links.push({ a: this.linkKey(craftId, links.length > 0), b: this.linkKey(id), roll: x > 0 ? 0 : Math.PI / 2 });
        allParts = [...allParts, ...this.buildParts(pressure, id, false, { pos: v3.new(x, 0, 0), rot: quat.identity() })];
      }
      rigid = { ...rigid, mass: 3 * craftMass, radius: spacing + single };
    } else if (docked) {
      // Hard dock (ARCHITECTURE 7.5; the simulation's `dockMerge`): the station is the base, so the vessel is in
      // ITS frame and has its name, its craft comes first, and the arriving craft's parts are re-expressed there
      // as their own tree: half a turn about the facing axis, the two port faces on each other. The link names
      // the base's port first. The vessel moves with the viewer's craft, which now flies it.
      const station = this.others[0]!;
      const port = this.port!;
      const offset = v3.scale(port.dir, this.portStandoff);
      const arm = quat.rotate(this.q, offset);
      crafts = [this.craftBlock(station.craftId, station.name, station.ownerId, station.ownerCallsign, noStack, single), ownCraft];
      links.push({ a: partKey(station.craftId, port.instanceId), b: partKey(craftId, port.instanceId), roll: 0 });
      allParts = [...this.buildParts(0, station.craftId, false, null), ...this.buildParts(pressure, craftId, true, { pos: offset, rot: this.facing })];
      rigid = {
        name: station.name,
        r: v3.add(st.r, arm),
        v: v3.add(st.v, v3.cross(quat.rotate(this.q, this.w), arm)),
        q: quat.normalize(quat.mul(this.q, quat.conj(this.facing))),
        w: quat.rotate(this.facing, this.w),
        mass: 2 * craftMass,
        com: v3.scale(offset, 0.5),
        radius: this.portStandoff + single,
      };
    }
    // A vessel of several craft: its figures are those of all its parts in its frame, where they are derived.
    const bodyAll = body1 !== null && crafts.length > 1 ? this.bodyOf(allParts) : null;
    if (bodyAll) rigid = { ...rigid, mass: bodyAll.mass, com: bodyAll.com, radius: bodyAll.radius };

    // What the read-outs take from the parts, where the figures are derived from them (a session reads them
    // there): the least ablator of the heat shields, the hottest skin against its limit, the thruster propellant
    // against its capacity, and whether there are legs at all.
    const fromParts = body1 !== null;
    let ablator: number | null = null;
    let hottest = 0;
    let rcsLeft = 0;
    let rcsCapacity = 0;
    let hasLegs = false;
    if (fromParts) {
      const rcsResources = new Set<string>();
      for (const p of parts) for (const md of this.defs.parts[p.def]?.modules ?? []) if (md.type === 'rcs') rcsResources.add(md.resource);
      for (const p of parts) {
        for (const m of p.modules) {
          if (m.type === 'heatShield') ablator = ablator === null ? m.ablatorFraction : Math.min(ablator, m.ablatorFraction);
          if (m.type === 'legs') hasLegs = true;
        }
        if (p.maxTemp > 0) hottest = Math.max(hottest, p.tempSkin / p.maxTemp);
        for (const tank of this.defs.parts[p.def]?.resources ?? []) {
          if (!rcsResources.has(tank.resource)) continue;
          rcsLeft += p.resources[tank.resource] ?? 0;
          rcsCapacity += tank.capacity;
        }
      }
    }
    const mach = hasAir ? speedSurf / 300 : 0;
    // The light of the next parachute stage, as a session judges it (the vehicle's own stack): none where there
    // is no air or no such stage is left, else the flight condition against the canopy's two envelopes.
    let chuteLight: ChuteEnvelope | null = this.spec.chutes ? 'safe' : null;
    if (stack) {
      chuteLight = null;
      const within = (env: ParachuteEnvelope): boolean => !(env.maxAlt !== undefined && st.altitude > env.maxAlt) && !(env.maxMach !== undefined && mach > env.maxMach) && !(env.maxSpeed !== undefined && speedSurf > env.maxSpeed) && q <= env.maxQ;
      const next = hasAir ? stages.slice(this.nextStage).find((s) => s.chuteEnvelopes)?.chuteEnvelopes : null;
      if (next) chuteLight = !within(next.destroy) ? 'unsafe' : within(next.safe) ? 'safe' : 'risky';
    }

    const mass = rigid.mass;
    const landed = this.spec.kind === 'surface' && (this.spec.climbRate ?? 0) === 0;
    const nose = quat.rotate(this.q, v3.unitY());
    const time = this.timeView(ut);

    const frame = this.frameDirs(ut);
    const toVes = (d: Vec3): Vec3 => quat.rotateInv(this.q, d);
    const maneuverDir = this.nodeDvRoot(this.nodes[0]);
    const nav = this.targetReadouts(ut, st, bodyState, time.myTick);
    const targetDir = nav.dir;
    const markers: NavballMarkers = {
      prograde: toVes(frame.prograde),
      retrograde: toVes(v3.neg(frame.prograde)),
      normal: toVes(frame.normal),
      antinormal: toVes(v3.neg(frame.normal)),
      radialOut: toVes(frame.radialOut),
      radialIn: toVes(v3.neg(frame.radialOut)),
      maneuver: maneuverDir ? toVes(maneuverDir) : null,
      target: targetDir ? toVes(targetDir) : null,
      antiTarget: targetDir ? toVes(v3.neg(targetDir)) : null,
      liftVector: this.spec.plasma !== undefined ? v3.unitZ() : null,
      relativePrograde: nav.relVel ? toVes(nav.relVel) : null,
      relativeRetrograde: nav.relVel ? toVes(v3.neg(nav.relVel)) : null,
    };
    const qHorizonToRoot = quat.fromBasis(e, n, u);
    const qVesselToHorizon = quat.mul(quat.conj(qHorizonToRoot), this.q);
    // Angle conventions of NavballState (contracts/sim.ts), the same as the real navball's.
    const sinPitch = clamp(v3.dot(nose, u), -1, 1);
    const pitchDeg = Math.asin(sinPitch) / DEG;
    const dorsal = quat.rotate(this.q, v3.unitZ());
    let horiz = v3.reject(nose, u);
    let upRef: Vec3;
    if (v3.len(horiz) > 1e-9) {
      upRef = v3.normalize(v3.reject(u, nose));
    } else {
      // Nose vertical: the heading is that of the ventral side and the roll is 0.
      horiz = v3.reject(sinPitch >= 0 ? v3.neg(dorsal) : dorsal, u);
      upRef = dorsal;
    }
    const headingDeg = ((Math.atan2(v3.dot(horiz, e), v3.dot(horiz, n)) / DEG) + 360) % 360;
    // Positive roll = rotation about +Y (the nose): the dorsal side tips toward starboard = cross(nose, upRef).
    const rollDeg = Math.atan2(v3.dot(dorsal, v3.cross(nose, upRef)), v3.dot(dorsal, upRef)) / DEG;

    // The osculating orbit; a session states it standing too (the orbit of a point that turns with the ground),
    // which v1's figures leave out.
    const conic = landed && !this.derived ? null : conicFromState(body.mu, st.r, st.v, ut);
    const aps = conic ? conicApsides(conic) : { rp: body.radius, ra: body.radius };
    const current: Patch[] = conic && this.spec.kind === 'orbit' ? [this.patchFor(conic, body.id, ut, st.r)] : [];
    const planned: Patch[] = [];
    const node = this.nodes[0];
    if (node && this.spec.kind === 'orbit') {
      const ns = this.vesselState(node.ut);
      const p = v3.normalize(ns.v);
      const nn = v3.normalize(v3.cross(ns.r, ns.v));
      const ro = v3.cross(p, nn);
      const v2 = v3.add(ns.v, v3.add(v3.add(v3.scale(p, node.dv.prograde), v3.scale(nn, node.dv.normal)), v3.scale(ro, node.dv.radial)));
      planned.push(this.patchFor(conicFromState(body.mu, ns.r, v2, node.ut), body.id, node.ut, ns.r, node.id));
      current[0]?.markers.push({ kind: 'maneuverNode', ut: node.ut, bodyId: body.id, r: ns.r, nodeId: node.id });
    }
    const dvMag = node ? Math.hypot(node.dv.prograde, node.dv.normal, node.dv.radial) : 0;

    const verticalSpeed = v3.dot(vSurf, u);
    const gLocal = body.mu / v3.lenSq(st.r);
    const turning = this.bodyOrientation(body.id, ut);
    const qFixedToRoot = turning.q;
    // The inclination a session states is to the body's equator; v1's figures state the conic's own, to the axes of ROOT.
    const pole = v3.len(turning.spin) > 0 ? v3.normalize(turning.spin) : v3.unitZ();
    const inclination = conic === null ? 0 : this.derived ? v3.angle(v3.cross(st.r, st.v), pole) : conic.inc;
    const subDir = quat.rotateInv(qFixedToRoot, u);
    const subLatLon = dirToLatLon(subDir);
    const vHorizontal = v3.reject(vSurf, u);
    const groundTrackDir = v3.len(vHorizontal) > 0.1 ? quat.rotateInv(qFixedToRoot, v3.normalize(vHorizontal)) : null;
    const surfaceTargets = this.surfaceTargets();
    const targetBodyId = this.target?.kind === 'body' ? this.target.id : null;
    const vesselTarget = this.target !== null && this.target.kind !== 'body';
    const sasModesAvailable: SasMode[] = [
      ...SAS_MODES.filter((m) => m !== 'maneuver' || node !== undefined),
      ...(vesselTarget ? (['target', 'antiTarget'] as SasMode[]) : []),
      ...(this.target?.kind === 'port' ? (['portAlign'] as SasMode[]) : []),
    ];
    const readouts: Readouts = {
      met: Math.max(0, ut - this.ut0),
      altitudeAsl: st.altitude,
      altitudeRadar: this.ground && this.spec.kind === 'surface' ? st.altitude - this.ground.originHeight - this.ground.height : st.altitude,
      latitude: subLatLon.lat,
      longitude: subLatLon.lon,
      speedOrbital: v3.len(st.v),
      speedSurface: speedSurf,
      verticalSpeed,
      horizontalSpeed: Math.sqrt(Math.max(0, speedSurf * speedSurf - verticalSpeed * verticalSpeed)),
      apoapsisAltitude: aps.ra - body.radius,
      periapsisAltitude: aps.rp - body.radius,
      timeToApoapsis: conic?.period ? this.timeToNu(conic, conicTrueAnomaly(conic, st.r), Math.PI) : null,
      timeToPeriapsis: conic?.period ? this.timeToNu(conic, conicTrueAnomaly(conic, st.r), 0) : null,
      inclination,
      eccentricity: conic?.e ?? 0,
      period: conic?.period ?? null,
      throttle: this.controls.throttle,
      thrust,
      twr: thrust / (mass * gLocal),
      mass,
      gLoad: landed ? gLocal / G0 : thrust / (mass * G0) + (this.spec.plasma !== undefined ? 4.5 : 0),
      gDose: 0,
      gDoseLimit: 15,
      dynamicPressure: q,
      mach,
      angleOfAttack: speedSurf > 1 ? v3.angle(nose, vSurf) : 0,
      heatFlux: (this.spec.plasma ?? 0) * 2.5e6,
      ablatorFraction: fromParts ? ablator : this.spec.plasma !== undefined ? 0.8 : null,
      maxTempFraction: fromParts ? hottest : this.spec.plasma !== undefined ? 0.55 : 0.15,
      sasEnabled: this.sasEnabled,
      sasMode: this.sasMode,
      sasModesAvailable,
      rcsEnabled: this.rcsEnabled,
      fineControl: this.fineControl,
      // A vessel without legs states none (null), as a session does.
      legsDeployed: fromParts && !hasLegs ? null : this.legsDeployed,
      lightsOn: this.lightsOn,
      chuteEnvelope: chuteLight,
      rcsFraction: fromParts ? (rcsCapacity > 0 ? rcsLeft / rcsCapacity : null) : 0.9,
      // What the stages still to burn add up to, as a session sums it; v1's constant without the vehicle's stack.
      deltaVTotal: stack ? stages.reduce((sum, s) => sum + s.deltaVVac, 0) : 3000,
      // The deprecated pair, filled until the contract tighten removes it: what `target` states for a body.
      targetBodyId,
      targetRelativeInclination: nav.target ? nav.target.relativeInclination : null,
      targetClosestApproach: null,
      target: nav.target,
      docking: nav.docking,
      launchWindow: landed && body.id === root && targetBodyId ? { timeToPlaneCrossing: 600 - ((ut - this.ut0) % 600), launchAzimuthDeg: 81 } : null,
      nodeBurn: node ? { nodeId: node.id, dvRemaining: v3.scale(maneuverDir ?? v3.unitX(), dvMag), dvRemainingMag: dvMag, burnTime: dvMag / 10, timeToBurnStart: node.ut - ut - dvMag / 20, timeToNode: node.ut - ut, insufficientDeltaV: false } : null,
      liftVectorUp: this.spec.plasma !== undefined ? v3.dot(dorsal, u) > 0 : null,
      tiltFromVertical: v3.angle(nose, u),
      landingTarget: this.landingTargetReadout(surfaceTargets, subDir, groundTrackDir, body.radius),
    };

    const vesselId = this.vesselId();
    const vessel: VesselSnapshot = {
      id: vesselId,
      name: rigid.name,
      vehicleId: this.scenario.vehicle,
      crafts,
      links,
      // A session on its own has nobody at the helm by name; in the assembly, and from the docking scene on, the
      // viewer holds it from the own craft (docked: the station's vacant helm was granted to the pilot aboard).
      helm: { accountId: named ? FAKE_ACCOUNT : null, callsign: named ? FAKE_CALLSIGN : null, craftId, controlPart: this.controlKey(craftId) },
      presence: 'solid',
      timeOffset: 0,
      // The counter moves when the vessel's orbit or plan changes: a dock is such a change.
      revision: docked ? 1 : 0,
      controllable: true,
      tier: 'full',
      situation: landed ? (body.id === root && this.nextStage === 0 ? 'prelaunch' : 'landed') : this.spec.kind === 'orbit' && !hasAir ? 'orbiting' : 'flying',
      translationMode: landed ? 'landed' : this.needsIntegration ? 'integrated' : 'rails',
      bodyId: body.id,
      r: rigid.r,
      v: rigid.v,
      rRoot: v3.add(bodyState.r, rigid.r),
      vRoot: v3.add(bodyState.v, rigid.v),
      q: rigid.q,
      w: rigid.w,
      mass: rigid.mass,
      comLocal: rigid.com,
      boundingRadius: rigid.radius,
      parts: allParts,
      aero: {
        q,
        mach: readouts.mach,
        aoa: readouts.angleOfAttack,
        airDensity: density,
        pressure,
        temperature: hasAir ? 250 : 4,
        airVelocity: vSurf,
        heatFlux: readouts.heatFlux,
        plasmaIntensity: this.spec.plasma ?? 0,
      },
      gLoad: readouts.gLoad,
      // What is felt aboard: the thrust along the nose; standing, the ground's reaction, which is the local
      // gravity upward (v1's figures state the thrust only).
      properAccel: landed && this.derived ? quat.rotateInv(this.q, v3.scale(u, gLocal)) : v3.new(0, thrust / mass, 0),
      contact: { anyContact: landed, maxForce: landed ? mass * gLocal : 0, waterSubmersion: 0 },
      sunVisibility: 1,
      thrust,
      age: ut - this.ut0,
    };

    // The other vessels of the scene: on rails about the same body, shown as the craft the fake was given, each
    // in the attitude the viewer started in (the station: its port turned back along the track at the viewer's).
    const vessels: VesselSnapshot[] = [vessel];
    for (const o of this.others) {
      // Once docked the station is the base craft of the viewer's vessel; neither of the two vessels is left.
      if (docked && o.id === FAKE_STATION_ID) continue;
      const os = this.otherState(o, ut);
      vessels.push({
        ...vessel,
        id: o.id,
        name: o.name,
        crafts: [this.craftBlock(o.craftId, o.name, o.ownerId, o.ownerCallsign, noStack, single)],
        links: [],
        // A parked craft has nobody at the helm.
        helm: { accountId: o.attended ? o.ownerId : null, callsign: o.attended ? o.ownerCallsign : null, craftId: o.craftId, controlPart: this.controlKey(o.craftId) },
        presence: o.presence,
        timeOffset: o.timeOffset,
        revision: 0,
        controllable: false,
        situation: 'orbiting',
        translationMode: 'rails',
        r: os.r,
        v: os.v,
        rRoot: v3.add(bodyState.r, os.r),
        vRoot: v3.add(bodyState.v, os.v),
        q: this.port !== null && o.id === FAKE_STATION_ID ? quat.normalize(quat.mul(this.portAttitude(ut), this.facing)) : quat.clone(this.q0),
        w: v3.zero(),
        mass: craftMass,
        comLocal: body1?.com ?? v3.zero(),
        boundingRadius: single,
        parts: this.buildParts(0, o.craftId, false, null),
        gLoad: 0,
        properAccel: v3.zero(),
        contact: { anyContact: false, maxForce: 0, waterSubmersion: 0 },
        thrust: 0,
      });
    }

    const events = this.events.slice();
    return {
      ut,
      simUt: ut,
      tick: this.tick,
      revision: this.tick,
      frame: this.frameBlock(ut, drain),
      time,
      warp: { index: this.warpIndex, factor: WARP_LEVELS[this.warpIndex]!, maxIndex: this.maxWarpIndex(), limitedBy: this.needsIntegration ? 'under acceleration or in atmosphere' : null, onRails: !this.needsIntegration },
      scenario: { id: this.scenario.id, startKind: this.scenario.start.kind, stagesAlreadyFired: this.scenario.stagesAlreadyFired },
      surfaceTargets,
      terrain: { complete: true, pending: false, incompleteQueries: 0 },
      bodies,
      starId: star?.id ?? root,
      vessels,
      activeVesselId: vessel.id,
      appliedControls: { ...this.controls, translate: v3.clone(this.controls.translate) },
      navball: { mode: this.navballMode, qVesselToHorizon, markers, pitchDeg, headingDeg, rollDeg },
      readouts,
      staging,
      patches: { current, planned },
      nodes: this.nodes.map((x) => ({ id: x.id, ut: x.ut, dv: { ...x.dv } })),
      events,
      milestones: [],
      mission: { failed: false, failureReason: null, crewAlive: true },
      cheatCounter: this.cheatCounter,
    };
  }

  // ------------------------------------------------------------------------------------------------ stores

  /**
   * What a directory publishes about the vessels of the snapshot `s`: the census, the account's ships, the
   * assembly the viewer is aboard and the roster. They are stated from the snapshot, so the two agree: every
   * vessel has its census entry with its craft, a vessel of several craft is an assembly with the links and
   * the helm the snapshot states, and a vessel that is gone is in none of them.
   */
  private vesselStores(s: SimSnapshot): { census: Map<string, CensusEntry>; ships: ShipRecord[]; assembly: AssemblyView | null; roster: RosterEntry[] } {
    const scene = this.scene;
    const myTick = s.time!.myTick;
    const active = s.vessels[0]!;
    const census = new Map<string, CensusEntry>();
    for (const v of s.vessels) {
      const crafts = v.crafts ?? [];
      const landed = v.situation === 'prelaunch' || v.situation === 'landed' || v.situation === 'splashed';
      const conic = landed ? null : conicFromState(this.body(v.bodyId).mu, v.r, v.v, s.ut);
      census.set(v.id, {
        vesselId: v.id,
        craftIds: crafts.map((c) => c.id),
        kind: crafts.length > 1 ? 'assembly' : 'ship',
        name: v.name,
        vehicleId: v.vehicleId,
        ownerIds: crafts.map((c) => c.ownerId),
        ownerCallsigns: crafts.map((c) => c.ownerCallsign),
        bodyId: v.bodyId,
        patches: conic ? [{ bodyId: v.bodyId, conic, fromTick: myTick, toTick: myTick + Math.round((conic.period ?? 86400) * TICKS_PER_SECOND), forecast: false }] : [],
        landed: landed ? { bodyId: v.bodyId, latitude: s.readouts.latitude, longitude: s.readouts.longitude, altitude: s.readouts.altitudeAsl } : null,
        headTick: myTick + (v.timeOffset ?? 0),
        horizonTick: null,
        chainEndTick: myTick + Math.round((conic?.period ?? 86400) * TICKS_PER_SECOND),
        clockId: v === active ? s.time!.clockId : null,
        reservedBy: null,
        limitTick: null,
        radius: v.boundingRadius,
        expiresWallMs: null,
        thrusting: false,
        revision: v.revision ?? 0,
      });
    }
    const crafts = active.crafts ?? [];
    const roster: RosterEntry[] = this.others
      .filter((o) => o.attended && s.vessels.some((v) => v.id === o.id))
      .map((o) => ({ accountId: o.ownerId ?? o.id, callsign: o.ownerCallsign ?? o.name, relation: 'nearby', vesselId: o.id, bodyId: active.bodyId, timeOffset: o.timeOffset, linked: scene === 'timeLive', blocked: false }));
    if (scene === 'assembly') roster.push({ accountId: OTHER_ACCOUNT, callsign: OTHER_CALLSIGN, relation: 'docked', vesselId: active.id, bodyId: active.bodyId, timeOffset: 0, linked: true, blocked: false });
    const orbiting = active.situation === 'orbiting';
    const otherOwners = crafts.filter((c) => c.id !== FAKE_VESSEL_ID && c.ownerCallsign !== null && c.ownerCallsign !== FAKE_CALLSIGN).map((c) => c.ownerCallsign!);
    const ships: ShipRecord[] = [
      {
        craftId: FAKE_VESSEL_ID,
        vesselId: active.id,
        name: this.vesselName,
        vehicleId: this.scenario.vehicle,
        isAssembly: crafts.length > 1,
        members: [...new Set(otherOwners)],
        situation: active.situation,
        bodyId: active.bodyId,
        orbit: orbiting ? { apoapsisAltitude: s.readouts.apoapsisAltitude, periapsisAltitude: s.readouts.periapsisAltitude, inclination: s.readouts.inclination } : null,
        surface: orbiting ? null : { latitude: s.readouts.latitude, longitude: s.readouts.longitude },
        crew: 3,
        deltaVRemaining: s.readouts.deltaVTotal,
        lastFlownWallMs: 0,
        expiry: { atWallMs: null, rule: 'craftRetention', reasonText: 'Kept while it is flown', protectedBy: null },
        nodesSaved: 0,
        sessionState: 'flownHere',
        flownBy: null,
        headTick: myTick,
        presence: 'solid',
      },
    ];
    // The assembly panel: the craft in the order of their seniority (the snapshot's), each with the ports its
    // links name; the anchor is the most senior craft that has an owner; the helm as the snapshot states it.
    const craftOfKey = new Map(active.parts.map((p) => [partKey(p.craftId!, p.instanceId), p.craftId!]));
    const portsOf = (craftId: string): AssemblyView['crafts'][number]['ports'] =>
      (active.links ?? []).flatMap((l) => [
        ...(craftOfKey.get(l.a) === craftId ? [{ portId: l.a, portType: FAKE_PORT_TYPE, state: 'hard' as const, armed: true, peerCraftId: craftOfKey.get(l.b) ?? null }] : []),
        ...(craftOfKey.get(l.b) === craftId ? [{ portId: l.b, portType: FAKE_PORT_TYPE, state: 'hard' as const, armed: true, peerCraftId: craftOfKey.get(l.a) ?? null }] : []),
      ]);
    const assembly: AssemblyView | null =
      crafts.length > 1
        ? {
            vesselId: active.id,
            crafts: crafts.map((c, i) => ({
              craftId: c.id,
              name: c.name,
              vehicleId: c.vehicleId,
              ownerId: c.ownerId,
              ownerCallsign: c.ownerCallsign,
              // A pilot is seated in the viewer's craft, and in the craft of an owner who is aboard (the roster's 'docked').
              attended: c.id === FAKE_VESSEL_ID || roster.some((r) => r.relation === 'docked' && r.accountId === c.ownerId),
              seniority: i,
              policy: c.policy,
              ports: portsOf(c.id),
            })),
            links: (active.links ?? []).map((l) => ({ a: l.a, b: l.b })),
            anchorCraftId: (crafts.find((c) => c.ownerId !== null) ?? crafts[0]!).id,
            helm: { accountId: active.helm!.accountId, callsign: active.helm!.callsign, craftId: active.helm!.craftId, request: null },
          }
        : null;
    return { census, ships, assembly, roster };
  }

  /** The vessels of the scene changed (a dock): the stores that list them state what the snapshot now states. */
  private publishVessels(): void {
    const now = this.vesselStores(this.build(false));
    this.fakeStores.census.set(now.census);
    this.fakeStores.ships.set(now.ships);
    this.fakeStores.assembly.set(now.assembly);
    this.fakeStores.roster.set(now.roster);
  }

  /** The client stores of the scene, as a directory would publish them for it: those about its vessels follow the snapshot, the others are built from the start state. */
  private buildStores(scene: FakeSessionScene, siteId: string): FakeStores {
    const s = this.build(false);
    const myTick = s.time!.myTick;
    const active = s.vessels[0]!;
    const { census, ships, assembly: assemblyView, roster } = this.vesselStores(s);
    const pads: PadState[] = [];
    for (const site of Object.values(this.defs.sites)) {
      padsOf(site).forEach((pad, i) => {
        // In the pad scenes the viewer's vessel stands on the first pad of its site, which it holds; in the queue
        // scene every other pad is taken too, which is why the request for the next launch waits.
        const own = site.id === siteId && i === 0 && active.situation === 'prelaunch';
        const taken = scene === 'launchQueue' && !own;
        pads.push({
          siteId: site.id,
          padId: pad.id,
          class: pad.class,
          state: own || taken ? 'occupied' : 'free',
          accountId: own ? FAKE_ACCOUNT : taken ? OTHER_ACCOUNT : null,
          callsign: own ? FAKE_CALLSIGN : taken ? OTHER_CALLSIGN : null,
          vesselId: own ? active.id : null,
          freeAtTick: own || taken ? myTick + 180 * TICKS_PER_SECOND * (i + 1) : null,
          nextLiveTick: own || taken ? myTick + 180 * TICKS_PER_SECOND * (i + 1) : myTick,
          nextCohortTick: null,
        });
      });
    }
    const prompts: Prompt[] = scene === 'timeLive' ? [{ id: 'fake-prompt-1', kind: 'warpProposal', fromCallsign: FAKE_CALLSIGN, text: `Waiting for ${OTHER_CALLSIGN} to agree to 50x`, expiresUpMs: 20_000, onExpire: 'decline' }] : [];
    const pilots = 1 + new Set(roster.map((r) => r.accountId)).size;
    const site = this.defs.sites[siteId];
    const queued: LaunchQueueEntry | null =
      scene === 'launchQueue' && site
        ? { request: { vehicleId: this.scenario.vehicle, site: site.id, pad: padOf(site).id, slot: { kind: 'live' }, name: this.vesselName }, padClass: padOf(site).class, ...this.queuePlace(this.ut0) }
        : null;
    return {
      census: new FakeStore<ReadonlyMap<string, CensusEntry>>(census),
      pads: new FakeStore<readonly PadState[]>(pads),
      ships: new FakeStore<readonly ShipRecord[]>(ships),
      assembly: new FakeStore<AssemblyView | null>(assemblyView),
      roster: new FakeStore<readonly RosterEntry[]>(roster),
      rules: new FakeStore<UniverseRules>(this.defs.rules?.['local'] ?? DEFAULT_UNIVERSE_RULES),
      presence: new FakeStore<{ lobbies: readonly LobbySummary[]; summary: PresenceSummary }>({ lobbies: [], summary: { online: pilots, flying: pilots, byBody: { [active.bodyId]: pilots }, queued: queued ? 1 : 0 } }),
      feed: new FakeStore<readonly FeedEvent[]>([]),
      prompts: new FakeStore<readonly Prompt[]>(prompts),
      link: new FakeStore<LinkState>({ state: 'local', rttMs: null, inputMarginMs: null, graceRemaining: null, queuePosition: null, durableTick: null, reason: null }),
      launchQueue: new FakeStore<LaunchQueueEntry | null>(queued),
    };
  }
}

export const createFakeSession = (defs: DefLibrary, opts: FakeSessionOptions): FakeSession => new FakeSession(defs, opts);
