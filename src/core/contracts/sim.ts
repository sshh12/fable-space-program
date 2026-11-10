/**
 * Simulation <-> presentation contract. The sim (src/sim) produces immutable SimSnapshots; renderer,
 * audio, HUD, map view and pilots consume them and answer only with ControlInputs / PlayerCommands.
 *
 * Frames (all right-handed, SI units; see docs/ARCHITECTURE.md section 3):
 *  - ROOT: inertial frame centred on the root body (Earth), +Z = Earth north pole, +X = J2000 equinox.
 *  - BCI(b): centred on body b, axes parallel to ROOT.
 *  - BCBF(b): body-fixed, +Z spin axis, +X prime meridian.
 *  - VES: vessel frame, origin at the root part origin, +Y nose (thrust direction), +X starboard, +Z dorsal.
 */
import type { ConicElements } from '../math/conic';
import type { Quat } from '../math/quat';
import type { Vec3 } from '../math/vec3';
import type { ControlInputs, NavballMode, PlayerCommands, SasMode } from './controls';
import type { DefLibrary, ScenarioDef } from './defs';

// ------------------------------------------------------------------------------------------------ orbits

export type PatchEndReason = 'closed' | 'soiExit' | 'soiEnter' | 'atmosphere' | 'impact' | 'maneuver' | 'horizon';

export type MarkerKind =
  | 'apoapsis'
  | 'periapsis'
  | 'ascendingNode'
  | 'descendingNode'
  | 'soiEnter'
  | 'soiExit'
  | 'impact'
  | 'atmosphereEntry'
  | 'closestApproach'
  | 'maneuverNode';

export interface Marker {
  kind: MarkerKind;
  ut: number;
  /** Body whose BCI frame `r` is expressed in. */
  bodyId: string;
  r: Vec3;
  /** Altitude above the reference radius, m (apsides, impact, entry). */
  altitude?: number;
  /** Kind-specific number: relative inclination (rad) for AN/DN, separation (m) for closestApproach, speed for entry. */
  value?: number;
  /** For atmosphereEntry: flight-path angle (rad, negative = descending) and vacuum periapsis altitude (m). */
  flightPathAngle?: number;
  vacuumPeriapsisAltitude?: number;
  nodeId?: string;
}

/** One conic arc of a predicted trajectory. */
export interface Patch {
  bodyId: string;
  conic: ConicElements;
  tStart: number;
  tEnd: number;
  /** True anomaly at tStart / tEnd. For 'closed' patches nuEnd = nuStart + 2 pi. */
  nuStart: number;
  nuEnd: number;
  endReason: PatchEndReason;
  /** Body entered/returned to when endReason is soiEnter / soiExit. */
  nextBodyId?: string;
  /** Set on patches downstream of a maneuver node (drawn dashed). */
  afterNodeId?: string;
  /** ROOT-frame position of `bodyId` at tEnd (lets the map draw encounters "at intercept"). */
  bodyPosAtEnd: Vec3;
  markers: Marker[];
}

export interface ManeuverNode {
  id: string;
  ut: number;
  /** m/s in the node frame: prograde = v/|v|, normal = (r x v)/|r x v|, radial = prograde x normal (outward). */
  dv: { prograde: number; normal: number; radial: number };
}

/** Burn bookkeeping for the next node (information only). */
export interface NodeBurnInfo {
  nodeId: string;
  /** Remaining delta-v vector in ROOT axes, m/s, and its magnitude. */
  dvRemaining: Vec3;
  dvRemainingMag: number;
  /** Estimated burn duration with the current/next engines, s; null when no engine is available. */
  burnTime: number | null;
  /** node.ut - burnTime/2 - ut: seconds until the burn should start. */
  timeToBurnStart: number | null;
  timeToNode: number;
  insufficientDeltaV: boolean;
}

// ----------------------------------------------------------------------------------------------- vessels

export type VesselSituation = 'prelaunch' | 'landed' | 'splashed' | 'flying' | 'suborbital' | 'orbiting' | 'escaping';
export type FidelityTier = 'full' | 'reduced' | 'rails';
export type ChuteState = 'stowed' | 'reefed' | 'full' | 'cut' | 'failed';
export type ChuteEnvelope = 'safe' | 'risky' | 'unsafe';

/** Per-module runtime state; array index matches PartDef.modules. */
export type ModuleState =
  | { type: 'command'; crew: number; crewAlive: boolean }
  | {
      type: 'engine';
      /** Activated by staging (thrust then follows the shared throttle). */
      active: boolean;
      /** 0..1 after spool lag. */
      throttleActual: number;
      /** Current thrust, N, and mass flow, kg/s. */
      thrust: number;
      massFlow: number;
      /** Ambient pressure at the nozzle, Pa, and exit/ambient pressure ratio (clamped to 1e6 in vacuum). */
      ambientPressure: number;
      pressureRatio: number;
      /** Gimbal deflection about the part's X and Z axes, rad. */
      gimbal: [number, number];
      /** Seconds since the last ignition (-1 when never ignited) and since the last shutdown (-1 when running). */
      ignitionAge: number;
      shutdownAge: number;
      ignitionsLeft: number | null;
      flameout: boolean;
    }
  | { type: 'rcs'; enabled: boolean; /** 0..1 firing level per thruster. */ levels: number[] }
  | { type: 'reactionWheel'; torque: Vec3 }
  | { type: 'decoupler'; fired: boolean }
  | { type: 'fairing'; jettisoned: boolean }
  | { type: 'launchClamp'; released: boolean }
  | { type: 'les'; fired: boolean; jettisoned: boolean }
  | { type: 'legs'; /** 0 stowed .. 1 deployed. */ deploy: number; /** Stroke compression per leg, m. */ compression: number[]; broken: boolean[]; contact: boolean[] }
  | {
      type: 'parachute';
      state: ChuteState;
      /** Current drag area as a fraction of the fully open canopy, 0..1. */
      inflation: number;
      /** Seconds since deployment (-1 when stowed). */
      deployAge: number;
      envelope: ChuteEnvelope;
      /** Unit direction from the attach point to the canopy in the VES frame (trails the airflow). */
      lineDir: Vec3;
    }
  | { type: 'heatShield'; ablatorFraction: number; surfaceTemp: number }
  | { type: 'light'; on: boolean }
  | { type: 'antenna'; deployed: boolean };

export interface PartSnapshot {
  /** Instance id from VehicleDef.parts (unique within the original vehicle; survives staging). */
  instanceId: string;
  def: string;
  /** Pose of the part frame in the vessel frame: v_VES = rotate(localRot, v_part) + localPos. */
  localPos: Vec3;
  localRot: Quat;
  /** Skin temperature and its limit, K. */
  tempSkin: number;
  maxTemp: number;
  /** Remaining resources, kg. */
  resources: Record<string, number>;
  modules: ModuleState[];
  /** True while hidden inside a closed fairing (no aero/heating; still rendered). */
  shielded: boolean;
}

export interface VesselAeroState {
  /** Dynamic pressure, Pa. */
  q: number;
  mach: number;
  /** Angle of attack between the nose and the air-relative velocity, rad. */
  aoa: number;
  /** Ambient density kg/m^3, static pressure Pa, temperature K. */
  airDensity: number;
  pressure: number;
  temperature: number;
  /** Air-relative velocity in ROOT axes, m/s. */
  airVelocity: Vec3;
  /** Stagnation heat flux, W/m^2 (convective + radiative). */
  heatFlux: number;
  /** 0..1 driver for the reentry plasma effect. */
  plasmaIntensity: number;
}

export interface VesselSnapshot {
  id: string;
  name: string;
  /** Id of the VehicleDef this vessel (or the vessel it separated from) was built from. */
  vehicleId: string;
  controllable: boolean;
  tier: FidelityTier;
  situation: VesselSituation;
  translationMode: 'landed' | 'rails' | 'integrated';
  /** Central body and state in BCI(bodyId). */
  bodyId: string;
  r: Vec3;
  v: Vec3;
  /** Same state in the ROOT frame (convenience for rendering; float64). */
  rRoot: Vec3;
  vRoot: Vec3;
  /** VES -> ROOT orientation. */
  q: Quat;
  /** Angular velocity in the VES frame, rad/s. */
  w: Vec3;
  /** Total mass kg and centre of mass in the VES frame. */
  mass: number;
  comLocal: Vec3;
  /** Bounding sphere radius about the VES origin, m. */
  boundingRadius: number;
  parts: PartSnapshot[];
  aero: VesselAeroState;
  /** Non-gravitational acceleration magnitude in g (filtered) and its vector in VES axes (m/s^2, unfiltered). */
  gLoad: number;
  properAccel: Vec3;
  contact: {
    anyContact: boolean;
    /** Largest contact normal force this step, N. */
    maxForce: number;
    /** 0..1 submerged volume fraction (water). */
    waterSubmersion: number;
  };
  /** Sun visibility fraction at the vessel (0 in umbra .. 1 in full light). */
  sunVisibility: number;
  /** Total thrust N (for audio/FX convenience). */
  thrust: number;
  /** Seconds this vessel has existed (debris fade-out). */
  age: number;
}

// ------------------------------------------------------------------------------------------------ bodies

export interface BodySnapshot {
  id: string;
  /** Centre position and velocity in the ROOT frame. */
  rRoot: Vec3;
  vRoot: Vec3;
  /** BCBF -> ROOT orientation, and spin vector in ROOT axes (rad/s). */
  qFixedToRoot: Quat;
  spinRoot: Vec3;
  /** Unit direction from the body centre to the star, ROOT axes, and distance in metres. */
  sunDir: Vec3;
  sunDistance: number;
  /** Orbit about the parent (parent BCI frame); null for the root body and for the star. */
  orbit: ConicElements | null;
  soiRadius: number | null;
}

// ----------------------------------------------------------------------------------------- HUD / navball

/** Unit direction markers in the VES frame (so the navball can place them without knowing any other frame). */
export interface NavballMarkers {
  prograde: Vec3;
  retrograde: Vec3;
  normal: Vec3;
  antinormal: Vec3;
  radialOut: Vec3;
  radialIn: Vec3;
  maneuver: Vec3 | null;
  target: Vec3 | null;
  antiTarget: Vec3 | null;
  /** Capsule lift vector during atmospheric flight; null otherwise. */
  liftVector: Vec3 | null;
}

export interface NavballState {
  mode: NavballMode;
  /**
   * VES -> local horizon frame (ENU: +X east, +Y north, +Z up) at the vessel's sub-point of the current
   * SOI body. The ball is drawn as a real sphere whose texture is fixed in the horizon frame.
   */
  qVesselToHorizon: Quat;
  markers: NavballMarkers;
  /** Nose elevation above the horizon, compass heading of the nose, and roll; degrees. */
  pitchDeg: number;
  headingDeg: number;
  rollDeg: number;
}

export interface StageInfo {
  label: string;
  icon: string;
  fired: boolean;
  /** Delta-v (m/s) this stage's engines provide with current masses: vacuum and at current ambient pressure. */
  deltaVVac: number;
  deltaVNow: number;
  /** Thrust-to-weight at current local gravity (full throttle) and full-throttle burn time, s. */
  twr: number;
  burnTime: number;
  /** 0..1 propellant remaining in the stage's flow group; null when the stage has no engines. */
  propellantFraction: number | null;
  /** Icons of the individual actions (engine, decoupler, chute...). */
  actionKinds: string[];
}

/** Everything numeric the HUD, the cockpit MFDs and pilots display/read. Active vessel only. */
export interface Readouts {
  /** Mission elapsed time since liftoff, s (0 before). */
  met: number;
  altitudeAsl: number;
  /** Height of the lowest contact probe above terrain or sea, m. */
  altitudeRadar: number;
  /** Planetocentric latitude / east longitude of the sub-point, rad. */
  latitude: number;
  longitude: number;
  speedOrbital: number;
  speedSurface: number;
  verticalSpeed: number;
  horizontalSpeed: number;
  /** Current osculating orbit about the SOI body. Altitudes above the reference radius, m. */
  apoapsisAltitude: number;
  periapsisAltitude: number;
  timeToApoapsis: number | null;
  timeToPeriapsis: number | null;
  inclination: number;
  eccentricity: number;
  period: number | null;
  /** Throttle lever (0..1) and resulting acceleration. */
  throttle: number;
  thrust: number;
  twr: number;
  mass: number;
  gLoad: number;
  /** Accumulated crew g-dose (g s above tolerance) and the fatal limit. */
  gDose: number;
  gDoseLimit: number;
  dynamicPressure: number;
  mach: number;
  angleOfAttack: number;
  heatFlux: number;
  /** 0..1, null when the vessel has no heat shield. */
  ablatorFraction: number | null;
  /** Highest skin temperature as a fraction of that part's limit. */
  maxTempFraction: number;
  sasEnabled: boolean;
  sasMode: SasMode;
  /** SAS modes currently selectable (e.g. 'maneuver' only when a node exists). */
  sasModesAvailable: SasMode[];
  rcsEnabled: boolean;
  fineControl: boolean;
  legsDeployed: boolean | null;
  lightsOn: boolean;
  /** Worst-case envelope light of the next chute stage; null when no chute stage remains. */
  chuteEnvelope: ChuteEnvelope | null;
  /** RCS propellant fraction 0..1, null when none. */
  rcsFraction: number | null;
  /** Total remaining delta-v (vacuum) over all unfired stages. */
  deltaVTotal: number;
  targetBodyId: string | null;
  /** Relative inclination to the target's orbit plane, rad; null without target. */
  targetRelativeInclination: number | null;
  /** Closest approach to the target on the planned (or current) trajectory. */
  targetClosestApproach: { ut: number; distance: number } | null;
  /** Launch-window helper while landed on the root body with a target set. */
  launchWindow: { timeToPlaneCrossing: number; launchAzimuthDeg: number } | null;
  nodeBurn: NodeBurnInfo | null;
  /** Lift direction label for lifting capsules in atmosphere. */
  liftVectorUp: boolean | null;
  /** Tilt of the nose from local vertical, rad (landing). */
  tiltFromVertical: number;
}

// ------------------------------------------------------------------------------------------------ events

export type MilestoneId =
  | 'LIFTOFF'
  | 'MAX_Q'
  | 'STAGE_SEP_1'
  | 'FAIRING_JETTISON'
  | 'STAGE_SEP_2'
  | 'EARTH_ORBIT'
  | 'TLI_COMPLETE'
  | 'MOON_SOI_ENTER'
  | 'LUNAR_ORBIT'
  | 'LUNAR_TOUCHDOWN'
  | 'LUNAR_LIFTOFF'
  | 'MOON_SOI_EXIT'
  | 'EARTH_PERIGEE_TARGETED'
  | 'ENTRY_INTERFACE'
  | 'DROGUE_DEPLOY'
  | 'MAIN_DEPLOY'
  | 'SPLASHDOWN';

/**
 * Mission milestones are detected by the sim from physical state only. Their ids are generic strings
 * so other scenarios can define their own; the lunar scenario uses MilestoneId.
 */
export interface MilestoneRecord {
  id: string;
  ut: number;
  /** Numeric facts captured at the milestone (speeds, altitudes, margins...) for test gates. */
  data: Record<string, number>;
}

interface EventBase {
  ut: number;
  vesselId: string;
}

export type SimEvent =
  | (EventBase & { type: 'stageFired'; stageIndex: number; label: string })
  | (EventBase & { type: 'engineIgnition'; partId: string })
  | (EventBase & { type: 'engineShutdown'; partId: string; flameout: boolean })
  | (EventBase & { type: 'clampsReleased' })
  | (EventBase & { type: 'decoupled'; partId: string; newVesselIds: string[] })
  | (EventBase & { type: 'fairingJettisoned'; partId: string; newVesselIds: string[] })
  | (EventBase & { type: 'lesFired'; partId: string })
  | (EventBase & { type: 'legsToggled'; deployed: boolean })
  | (EventBase & { type: 'chuteDeployed'; partId: string; mode: 'drogue' | 'main' })
  | (EventBase & { type: 'chuteInflated'; partId: string })
  | (EventBase & { type: 'chuteCut'; partId: string })
  | (EventBase & { type: 'chuteFailed'; partId: string })
  | (EventBase & { type: 'rcsPulse'; partId: string })
  | (EventBase & { type: 'touchdown'; speed: number; surface: 'land' | 'water'; partId: string })
  | (EventBase & { type: 'splash'; speed: number })
  | (EventBase & { type: 'partDestroyed'; partId: string; cause: 'impact' | 'overheat' | 'overstress' | 'explosion'; posVes: Vec3 })
  | (EventBase & { type: 'explosion'; posRoot: Vec3; energy: number })
  | (EventBase & { type: 'jointBroken'; partId: string })
  | (EventBase & { type: 'crewLost'; cause: string })
  | (EventBase & { type: 'soiChange'; fromBodyId: string; toBodyId: string })
  | (EventBase & { type: 'vesselRemoved'; reason: 'burnedUp' | 'impact' | 'expired' | 'limit' })
  | (EventBase & { type: 'activeVesselChanged'; previousVesselId: string })
  | (EventBase & { type: 'warpChanged'; index: number; factor: number; reason: string | null })
  | (EventBase & { type: 'nodeCompleted'; nodeId: string })
  | (EventBase & { type: 'milestone'; milestone: MilestoneRecord })
  | (EventBase & { type: 'missionFailed'; reason: string });

export type SimEventType = SimEvent['type'];

// ---------------------------------------------------------------------------------------------- snapshot

export interface WarpState {
  /** Index into WARP_LEVELS and the resulting factor. */
  index: number;
  factor: number;
  /** Highest index currently allowed and why it is limited. */
  maxIndex: number;
  limitedBy: string | null;
  /** True when sim time is advancing on rails (no force integration this frame). */
  onRails: boolean;
}

export interface SimSnapshot {
  /** Seconds since J2000.0. */
  ut: number;
  /** Monotonic count of physics steps + rails advances (lets consumers detect "no change"). */
  tick: number;
  warp: WarpState;
  scenario: { id: string; startKind: ScenarioDef['start']['kind']; stagesAlreadyFired: number };
  bodies: BodySnapshot[];
  /** Id of the star that lights the system. */
  starId: string;
  vessels: VesselSnapshot[];
  activeVesselId: string;
  /** Controls actually applied this step (after SAS, fine-control scaling and clamping). */
  appliedControls: ControlInputs;
  navball: NavballState;
  readouts: Readouts;
  staging: { nextStage: number; stages: StageInfo[]; lockout: boolean };
  /** Predicted trajectory of the active vessel: without nodes, and with nodes (from the first node on). */
  patches: { current: Patch[]; planned: Patch[] };
  nodes: ManeuverNode[];
  /** Events since the previous snapshot() call, in time order. */
  events: SimEvent[];
  /** All milestones reached so far, in order. */
  milestones: MilestoneRecord[];
  mission: { failed: boolean; failureReason: string | null; crewAlive: boolean };
  /** Non-zero means a debug/cheat API was used: the run is void as a mission proof. */
  cheatCounter: number;
}

// --------------------------------------------------------------------------------------------------- sim

/** A pilot/controller gets a control tick every this many physics steps (30 Hz of simulation time). */
export const CONTROL_TICK_STEPS = 4;

/** Debug-only mutators. Every call increments cheatCounter. Never used by mission tests or pilots. */
export interface SimDebug {
  setVesselState(vesselId: string, bodyId: string, r: Vec3, v: Vec3): void;
  setResource(vesselId: string, partInstanceId: string, resource: string, kg: number): void;
  setUt(ut: number): void;
}

/**
 * The simulation facade (implemented by src/sim, faked by src/core/fakes for UI development).
 * Deterministic: same scenario + same sequence of calls => bit-identical state.
 */
export interface Sim {
  readonly defs: DefLibrary;
  readonly scenario: ScenarioDef;
  /**
   * Browser entry point: advance by a real-time frame delta (s), honouring warp.
   * `onControlTick`, when given, is invoked before every CONTROL_TICK_STEPS-th physics step and before
   * each rails advance; inside it a pilot may call peek(), setControls() and commands. This gives a
   * scripted pilot the same 30 Hz (sim time) cadence in the browser as in the headless loop.
   */
  advance(realDt: number, onControlTick?: () => void): void;
  /** Exactly one PHYSICS_DT step of integrated time (headless harness). */
  step(): void;
  /** Rails advance to `targetUt`, clamped to the next event; returns the ut reached (headless harness). */
  advanceRails(targetUt: number): number;
  /** True when the next advance must integrate forces (burn, atmosphere, contact...). */
  readonly needsIntegration: boolean;
  /** UT of the next event that limits warp (SOI change, atmosphere entry, node lead time...). */
  readonly nextEventUt: number;
  setControls(inputs: ControlInputs): void;
  readonly commands: PlayerCommands;
  /**
   * Build a snapshot of the current state and DRAIN the event queue into it. Called exactly once per
   * presented frame by the app loop; the same object is handed to renderer, audio, HUD and map.
   */
  snapshot(): SimSnapshot;
  /** Like snapshot() but leaves the event queue untouched (`events` lists what is pending). For pilots and tests. */
  peek(): SimSnapshot;
  readonly cheatCounter: number;
  /** Hash of the complete dynamic state (golden-run determinism check). */
  stateHash(): string;
  readonly debug: SimDebug;
}
