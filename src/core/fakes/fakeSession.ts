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
 *   dockingApproach   a station 15 m ahead and closing; its port is the target: `Readouts.docking`, the two
 *                     port states (`portStates()`), soft capture and hard dock as events;
 *   assembly          three craft in one vessel: craft blocks, dock links, the helm, a bounding radius that
 *                     spans them, the assembly store;
 *   echoes            a recorded echo behind the viewer's clock and a projected one ahead of it, with their
 *                     time offsets and the offers that make them reachable;
 *   timeLive / timeAhead / timeBehind   the time strip for each `TimeView.relation`: a shared clock with a
 *                     member who has not agreed and an open proposal, a private clock ahead of the live one,
 *                     an island held behind it;
 *   launchQueue       the pad scene with a launch request waiting for a pad (`stores.launchQueue`).
 *
 * The snapshot is the v2 snapshot as `createSession` gives it (tests/unit/fakes holds the two against each
 * other): `revision`, `frame` with the history of earlier origins, `time`, craft blocks with the cockpit and
 * the chase distances, the helm, part keys, `Readouts.target`. The deprecated fields are filled beside them
 * until the contract tighten removes them.
 *
 * The render root. Like a session, the fake states ROOT positions relative to the centre of the active
 * vessel's SOI body (`renderRoot: 'focusBody'`, the default). `renderRoot: 'rootBody'` keeps the origin at
 * the library's root body, which is where v1's FakeSim had it (for the Moon's scenes that is 384,000 km
 * away: the same picture from numbers of another size). `setRenderRoot(bodyId)` replaces the origin while the
 * session runs, as a sphere-of-influence change does: a new frame epoch, a rebase, the old origin in the
 * history of every later snapshot.
 */
import { NEUTRAL_CONTROLS, SAS_MODES, type CommandResult, type ControlInputs, type NavballMode, type NodeEdit, type PlayerCommands, type SasMode } from '../contracts/controls';
import { MAX_PHYSICS_WARP_INDEX, PHYSICS_DT, WARP_LEVELS, type BodyDef, type DefLibrary, type ScenarioDef } from '../contracts/defs';
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
import type { ClientStores, LaunchQueueEntry, LocalSession, SessionDebug, Store, UniverseCommands } from '../contracts/session';
import type {
  BodySnapshot,
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
import { padOf, padsOf } from '../defs/sites';
import { dirToLatLon, latLonToDir } from '../geo/cubeSphere';
import { conicApsides, conicFromState, conicPosition, conicTrueAnomaly, timeSincePeriapsis, type ConicElements } from '../math/conic';
import { FRAME_HISTORY_EPOCHS, type FrameEpochOrigin, type FrameRebase } from '../math/frame';
import { quat, type Quat } from '../math/quat';
import { clamp, DEG, G0, TWO_PI } from '../math/scalar';
import { v3, type Vec3 } from '../math/vec3';
import { partKey } from './snapshotAccess';

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
  /** Stage labels for the staging stack (default: a generic 4-entry stack). */
  stageLabels?: string[];
  /**
   * Landing legs of the active vessel deployed from the start (default false: stowed, as at launch). A landed
   * scene stands on them (request vehicle-pad-5); `toggleLegs` works from there as usual.
   */
  legsDeployed?: boolean;
  /** Name of the active vessel in the snapshot (request map-view-7; default 'Fake vessel'). The id stays 'fake-vessel'. */
  vesselName?: string;
  /** Where the origin of ROOT positions is (the file header). Default 'focusBody', as a session. */
  renderRoot?: 'focusBody' | 'rootBody';
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
/** The instance id the fake names a docking port by where the vessel has no part list. */
export const FAKE_PORT_INSTANCE = 'port';
const FAKE_ACCOUNT = 'fake-account';
const FAKE_CALLSIGN = 'YOU';
const OTHER_ACCOUNT = 'fake-account-vega';
const OTHER_CALLSIGN = 'VEGA';

/** The capture envelope of the fake's ports (what `DockingReadout.within` is judged against), and its soft-capture time. */
const FAKE_ENVELOPE = { lateral: 0.3, angleDeg: 5, rollDeg: 5, closing: 0.3, lateralSpeed: 0.1, rateDegPerS: 0.5 };
const FAKE_SOFT_CAPTURE_SECONDS = 10;
/** Distance between the two vessel origins when the ports touch, m, and the closing speed of the approach, m/s. */
const FAKE_PORT_STANDOFF = 1.2;
const FAKE_CLOSING_SPEED = 0.1;

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
    this.stageLabels = opts.stageLabels ?? ['Launch', 'Stage separation', 'Fairing jettison', 'Parachutes'];
    this.originBodyId = (opts.renderRoot ?? 'focusBody') === 'rootBody' ? root : this.spec.bodyId;
    this.scenario = {
      id: `fake-${opts.scene}`,
      name: `Fake scene: ${opts.scene}`,
      vehicle: opts.vehicleId ?? '',
      site: site?.id ?? '',
      startUt: this.ut0,
      start: { kind: 'state', bodyId: this.spec.bodyId, r: [0, 0, 0], v: [0, 0, 0] },
      stagesAlreadyFired: 0,
      target: null,
      suggestedLanding: this.spec.bodyId === moon && moon !== root ? { bodyId: moon, latDeg: 0.674, lonDeg: 23.473, name: 'Tranquility Base' } : null,
      milestones: [],
    };
    this.q = this.initialAttitude();
    this.others = this.sceneVessels(opts.scene);
    // The scenes about another vessel start with it selected: their readouts are there without a command.
    if (opts.scene === 'rendezvous' || opts.scene === 'timeLive') this.target = { kind: 'vessel', id: FAKE_TARGET_ID };
    else if (opts.scene === 'dockingApproach') this.target = { kind: 'port', vesselId: FAKE_STATION_ID, portId: partKey(FAKE_STATION_ID, FAKE_PORT_INSTANCE) };
    else if (opts.scene === 'echoes') this.target = { kind: 'vessel', id: FAKE_ECHO_RECORDED_ID };
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
        if (ref !== null && ref.kind === 'port' && !(this.scene === 'dockingApproach' && ref.vesselId === FAKE_STATION_ID && ref.portId === partKey(FAKE_STATION_ID, FAKE_PORT_INSTANCE))) return { ok: false, reason: 'No such port in this scene' };
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
    const cheat = (): void => {
      this.cheatCounter++;
    };
    this.debug = { setVesselState: cheat, setResource: cheat, setUt: cheat };
    this.fakeStores = this.buildStores(opts.scene, site?.id ?? '');
    this.stores = this.fakeStores;
    const refused = (what: string): CommandResult => ({ ok: false, reason: `The fake session cannot ${what}` });
    this.universe = {
      spawn: () => Promise.resolve({ ok: false, reason: 'The fake session launches nothing', alternative: null }),
      cancelSpawn: () => {
        if (this.fakeStores.launchQueue.get() === null) return Promise.resolve({ ok: false, reason: 'No launch request is waiting' });
        this.fakeStores.launchQueue.set(null);
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
    if (this.scene !== 'dockingApproach') return [];
    const own = partKey(FAKE_VESSEL_ID, FAKE_PORT_INSTANCE);
    const theirs = partKey(FAKE_STATION_ID, FAKE_PORT_INSTANCE);
    const state = this.dockPhase === 'approach' ? 'ready' : this.dockPhase;
    const progress = this.dockPhase === 'soft' ? clamp(this.softCaptureAge / FAKE_SOFT_CAPTURE_SECONDS, 0, 1) : 0;
    const captured = this.dockPhase !== 'approach';
    return [
      { partKey: own, state: { type: 'dockingPort', state, armed: true, peer: captured ? { vesselId: FAKE_STATION_ID, partKey: theirs } : null, progress } },
      { partKey: theirs, state: { type: 'dockingPort', state, armed: true, peer: captured ? { vesselId: this.vesselId(), partKey: own } : null, progress } },
    ];
  }

  // -------------------------------------------------------------------------------------------- kinematics

  /** The id of the viewer's vessel: the craft's own id, or the assembly's in the assembly scene. */
  private vesselId(): string {
    return this.scene === 'assembly' ? FAKE_ASSEMBLY_ID : FAKE_VESSEL_ID;
  }

  private sceneVessels(scene: FakeSessionScene): OtherVessel[] {
    const other = (id: string, name: string, higher: number, ahead: number, presence: Presence = 'solid', timeOffset = 0, closing = 0, standoff = 0): OtherVessel => ({ id, craftId: id, name, ownerId: OTHER_ACCOUNT, ownerCallsign: OTHER_CALLSIGN, higher, ahead, closing, standoff, presence, timeOffset });
    switch (scene) {
      case 'rendezvous':
        // 150 m higher (slower) and 2 km ahead: the viewer catches up in about two hours and passes 150 m below.
        return [other(FAKE_TARGET_ID, 'Vega 2', 150, 2000)];
      case 'timeLive':
        return [other(FAKE_TARGET_ID, 'Vega 2', 0, 3000)];
      case 'dockingApproach':
        return [other(FAKE_STATION_ID, 'Harbour', 0, 15, 'solid', 0, FAKE_CLOSING_SPEED, FAKE_PORT_STANDOFF)];
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
          const nose = quat.rotate(this.q, v3.unitY());
          const fix = quat.fromTo(nose, target);
          this.q = quat.normalize(quat.mul(quat.slerp(quat.identity(), fix, Math.min(1, attitudeDt * 1.5)), this.q));
        }
      }
    }
    this.nodes = this.nodes.filter((n) => n.ut > this.ut - 1);
    if (this.scene === 'dockingApproach') this.advanceDocking(simDt);
    if (this.scene === 'launchQueue') this.advanceQueue();
  }

  /** The docking of the station scene: the ports touch, hold in soft capture, and dock. Each change is an event. */
  private advanceDocking(simDt: number): void {
    const station = this.others[0]!;
    const own = partKey(FAKE_VESSEL_ID, FAKE_PORT_INSTANCE);
    const theirs = partKey(FAKE_STATION_ID, FAKE_PORT_INSTANCE);
    if (this.dockPhase === 'approach' && this.aheadOf(station, this.ut) <= station.standoff) {
      this.dockPhase = 'soft';
      this.softCaptureAge = 0;
      this.events.push({ type: 'dockCapture', ut: this.ut, vesselId: this.vesselId(), partId: own, otherVesselId: station.id, otherPartId: theirs });
    } else if (this.dockPhase === 'soft') {
      this.softCaptureAge += simDt;
      if (this.softCaptureAge >= FAKE_SOFT_CAPTURE_SECONDS) {
        this.dockPhase = 'hard';
        this.events.push({ type: 'docked', ut: this.ut, vesselId: this.vesselId(), partId: own, otherPartId: theirs, absorbedVesselId: station.id });
      }
    }
  }

  /** The waiting launch request of the queue scene: one place nearer every minute, the estimate with it. */
  private advanceQueue(): void {
    const entry = this.fakeStores.launchQueue.get();
    if (entry === null) return;
    const position = Math.max(1, 3 - Math.floor((this.ut - this.ut0) / 60));
    const etaSeconds = Math.max(0, 180 * position - Math.floor((this.ut - this.ut0) % 60));
    if (position !== entry.position || etaSeconds !== entry.etaSeconds) this.fakeStores.launchQueue.set({ ...entry, position, etaSeconds });
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
      out.push({ id: `site:${site.id}`, name: site.name, bodyId: site.bodyId, kind: 'site', latitude: site.location.latDeg * DEG, longitude: site.location.lonDeg * DEG, radius: padOf(site).flatRadius });
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
   * part stamped with the craft it belongs to, `shift` metres from the vessel's origin.
   */
  private buildParts(pressure: number, craftId: string, live: boolean, shift: Vec3 | null): PartSnapshot[] {
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
      return { ...p, craftId, ...(shift ? { localPos: v3.add(p.localPos, shift) } : {}), modules };
    });
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
    return { id, cameraSeat: id === null ? null : (authored?.cameras.cockpit?.seat ?? null), sensorMount: own?.sensorCamera ?? null };
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

  /** The part key a dock link or a control point names on a craft: its first part, or the fake's port where it has none. */
  private anchorKey(craftId: string): string {
    return partKey(craftId, this.parts[0]?.instanceId ?? FAKE_PORT_INSTANCE);
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
        relativeInclination: 0.01,
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
    // Velocity relative to the target: the viewer's minus the target's.
    const rel = v3.sub(st.v, os.v);
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
      range: t.kind === 'port' ? Math.max(0, range - FAKE_PORT_STANDOFF) : range,
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
      // The ports face each other along the track; the misalignments of the approach die away over a minute.
      const settle = Math.exp(-(ut - this.ut0) / 60);
      const axial = Math.max(0, range - FAKE_PORT_STANDOFF);
      const lateral: [number, number] = [0.35 * settle, -0.2 * settle];
      const angleDeg: [number, number] = [1.5 * settle, -0.8 * settle];
      const rollDeg = 4 * settle;
      const closing = this.dockPhase === 'approach' ? relSpeed : 0;
      const lateralSpeed = (Math.hypot(lateral[0], lateral[1]) / 60) * (this.dockPhase === 'approach' ? 1 : 0);
      const rateDegPerS = (Math.hypot(angleDeg[0], angleDeg[1], rollDeg) / 60) * (this.dockPhase === 'approach' ? 1 : 0);
      docking = {
        ownPort: partKey(FAKE_VESSEL_ID, FAKE_PORT_INSTANCE),
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
    const mass = 50000;
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

    const conic = landed ? null : conicFromState(body.mu, st.r, st.v, ut);
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
    const qFixedToRoot = this.bodyOrientation(body.id, ut).q;
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
      inclination: conic?.inc ?? 0,
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
      mach: hasAir ? speedSurf / 300 : 0,
      angleOfAttack: speedSurf > 1 ? v3.angle(nose, vSurf) : 0,
      heatFlux: (this.spec.plasma ?? 0) * 2.5e6,
      ablatorFraction: this.spec.plasma !== undefined ? 0.8 : null,
      maxTempFraction: this.spec.plasma !== undefined ? 0.55 : 0.15,
      sasEnabled: this.sasEnabled,
      sasMode: this.sasMode,
      sasModesAvailable,
      rcsEnabled: this.rcsEnabled,
      fineControl: this.fineControl,
      legsDeployed: this.legsDeployed,
      lightsOn: this.lightsOn,
      chuteEnvelope: this.spec.chutes ? 'safe' : null,
      rcsFraction: 0.9,
      deltaVTotal: 3000,
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

    const stages: StageInfo[] = this.stageLabels.map((label, i) => ({
      label,
      icon: i === this.stageLabels.length - 1 ? 'parachute' : 'engine',
      fired: i < this.nextStage,
      deltaVVac: 3000,
      deltaVNow: 2800,
      twr: 1.3,
      burnTime: 160,
      propellantFraction: i < this.nextStage ? 1 - this.throttleActual * 0.5 : 1,
      actionKinds: ['engine'],
    }));
    const staging = { nextStage: this.nextStage, stages, lockout: false };

    // The craft of the viewer's vessel: one, or three side by side in the assembly scene (60 m apart).
    const single = 55;
    const assembly = this.scene === 'assembly';
    const spacing = 60;
    const crafts: CraftSnapshot[] = [this.craftBlock(craftId, this.vesselName, assembly ? FAKE_ACCOUNT : null, assembly ? FAKE_CALLSIGN : null, staging, single)];
    const links: DockLinkSnapshot[] = [];
    let allParts = parts;
    if (assembly) {
      const aboard: [string, string, string | null, string | null, number][] = [
        ['fake-craft-b', 'Vega 2', OTHER_ACCOUNT, OTHER_CALLSIGN, spacing],
        ['fake-craft-c', 'Derelict', null, null, -spacing],
      ];
      for (const [id, name, ownerId, callsign, x] of aboard) {
        crafts.push(this.craftBlock(id, name, ownerId, callsign, { nextStage: 0, stages: [], lockout: false }, single));
        links.push({ a: this.anchorKey(craftId), b: this.anchorKey(id), roll: x > 0 ? 0 : Math.PI / 2 });
        allParts = [...allParts, ...this.buildParts(pressure, id, false, v3.new(x, 0, 0))];
      }
    }
    const vesselId = this.vesselId();
    const vessel: VesselSnapshot = {
      id: vesselId,
      name: this.vesselName,
      vehicleId: this.scenario.vehicle,
      crafts,
      links,
      // A session on its own has nobody at the helm by name; in the assembly the viewer holds it from the own craft.
      helm: { accountId: assembly ? FAKE_ACCOUNT : null, callsign: assembly ? FAKE_CALLSIGN : null, craftId, controlPart: this.scene === 'dockingApproach' ? partKey(craftId, FAKE_PORT_INSTANCE) : this.anchorKey(craftId) },
      presence: 'solid',
      timeOffset: 0,
      revision: 0,
      controllable: true,
      tier: 'full',
      situation: landed ? (body.id === root && this.nextStage === 0 ? 'prelaunch' : 'landed') : this.spec.kind === 'orbit' && !hasAir ? 'orbiting' : 'flying',
      translationMode: landed ? 'landed' : this.needsIntegration ? 'integrated' : 'rails',
      bodyId: body.id,
      r: st.r,
      v: st.v,
      rRoot: v3.add(bodyState.r, st.r),
      vRoot: v3.add(bodyState.v, st.v),
      q: quat.clone(this.q),
      w: v3.clone(this.w),
      mass: assembly ? 3 * mass : mass,
      comLocal: v3.zero(),
      boundingRadius: assembly ? spacing + single : single,
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
      properAccel: v3.new(0, thrust / mass, 0),
      contact: { anyContact: landed, maxForce: landed ? mass * gLocal : 0, waterSubmersion: 0 },
      sunVisibility: 1,
      thrust,
      age: ut - this.ut0,
    };

    // The other vessels of the scene: on rails about the same body, shown as the craft the fake was given.
    const docked = this.scene === 'dockingApproach' && this.dockPhase === 'hard';
    const vessels: VesselSnapshot[] = [vessel];
    for (const o of this.others) {
      // Once docked the station is part of the viewer's vessel; its own vessel is gone (the `docked` event names it).
      if (docked && o.id === FAKE_STATION_ID) continue;
      const os = this.otherState(o, ut);
      vessels.push({
        ...vessel,
        id: o.id,
        name: o.name,
        crafts: [this.craftBlock(o.craftId, o.name, o.ownerId, o.ownerCallsign, { nextStage: 0, stages: [], lockout: false }, single)],
        links: [],
        helm: { accountId: o.ownerId, callsign: o.ownerCallsign, craftId: o.craftId, controlPart: this.anchorKey(o.craftId) },
        presence: o.presence,
        timeOffset: o.timeOffset,
        controllable: false,
        situation: 'orbiting',
        translationMode: 'rails',
        r: os.r,
        v: os.v,
        rRoot: v3.add(bodyState.r, os.r),
        vRoot: v3.add(bodyState.v, os.v),
        w: v3.zero(),
        mass,
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
      scenario: { id: this.scenario.id, startKind: this.scenario.start.kind, stagesAlreadyFired: 0 },
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

  /** The client stores of the scene, as a directory would publish them for it. They are built from the start state. */
  private buildStores(scene: FakeSessionScene, siteId: string): FakeStores {
    const s = this.build(false);
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
        revision: 0,
      });
    }
    const pads: PadState[] = [];
    for (const site of Object.values(this.defs.sites)) {
      padsOf(site).forEach((pad, i) => {
        // In the pad scenes the viewer's vessel stands on the first pad of its site; in the queue scene every pad is taken.
        const own = site.id === siteId && i === 0 && active.situation === 'prelaunch' && scene !== 'launchQueue';
        const taken = scene === 'launchQueue';
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
    const orbiting = active.situation === 'orbiting';
    const ships: ShipRecord[] = [
      {
        craftId: FAKE_VESSEL_ID,
        vesselId: active.id,
        name: this.vesselName,
        vehicleId: active.vehicleId,
        isAssembly: scene === 'assembly',
        members: scene === 'assembly' ? [OTHER_CALLSIGN] : [],
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
    const assemblyView: AssemblyView | null =
      scene === 'assembly'
        ? {
            vesselId: active.id,
            crafts: (active.crafts ?? []).map((c, i) => ({ craftId: c.id, name: c.name, vehicleId: c.vehicleId, ownerId: c.ownerId, ownerCallsign: c.ownerCallsign, attended: i === 0, seniority: i, policy: c.policy, ports: [] })),
            links: (active.links ?? []).map((l) => ({ a: l.a, b: l.b })),
            anchorCraftId: FAKE_VESSEL_ID,
            helm: { accountId: FAKE_ACCOUNT, callsign: FAKE_CALLSIGN, craftId: FAKE_VESSEL_ID, request: null },
          }
        : null;
    const roster: RosterEntry[] = this.others.map((o) => ({ accountId: o.ownerId ?? o.id, callsign: o.ownerCallsign ?? o.name, relation: 'nearby', vesselId: o.id, bodyId: active.bodyId, timeOffset: o.timeOffset, linked: scene === 'timeLive', blocked: false }));
    if (scene === 'assembly') roster.push({ accountId: OTHER_ACCOUNT, callsign: OTHER_CALLSIGN, relation: 'docked', vesselId: active.id, bodyId: active.bodyId, timeOffset: 0, linked: true, blocked: false });
    const prompts: Prompt[] = scene === 'timeLive' ? [{ id: 'fake-prompt-1', kind: 'warpProposal', fromCallsign: FAKE_CALLSIGN, text: `Waiting for ${OTHER_CALLSIGN} to agree to 50x`, expiresUpMs: 20_000, onExpire: 'decline' }] : [];
    const pilots = 1 + new Set(roster.map((r) => r.accountId)).size;
    const site = this.defs.sites[siteId];
    const queued: LaunchQueueEntry | null =
      scene === 'launchQueue' && site
        ? { request: { vehicleId: this.scenario.vehicle, site: site.id, pad: padOf(site).id, slot: { kind: 'live' }, name: this.vesselName }, padClass: padOf(site).class, position: 3, etaSeconds: 540 }
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
