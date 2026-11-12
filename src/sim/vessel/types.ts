/**
 * Runtime vessel model shared by src/sim/vessel, src/sim/dynamics and src/sim/control
 * (docs/ARCHITECTURE.md 7.2; docs/research/v2/fleet-docking.md 2.7).
 *
 * A vessel is one rigid body made of the parts of one or more CRAFT. Each craft keeps its own part tree
 * with its own root (`parent = -1`); docked joints are `links` between port parts, never parent pointers,
 * so a decoupler keeps cutting the same joint, a tree is never re-rooted by docking, and rings are
 * expressible. A vessel that never docked has exactly one craft and no link.
 *
 * Frames: VES (+Y nose, +X starboard, +Z dorsal) has its origin at the origin of `parts[0]`, the root part
 * of the base craft; `q` maps VES to the inertial axes of the central body (BCI, parallel to ROOT); `w` is
 * the angular velocity in VES axes; `r`, `v` are the position and velocity of the VES origin in BCI.
 */
import type { ControlInputs, SasMode } from '@/core/contracts/controls';
import type { ModuleDef, PartDef, TimedStageAction, VehicleDef } from '@/core/contracts/defs';
import type { LendPolicy } from '@/core/contracts/net';
import type { ModuleState, SimEvent } from '@/core/contracts/sim';
import type { VesselEnvironment } from '@/core/contracts/simInternal';
import type { Quat } from '@/core/math/quat';
import type { Vec3, Vec3Tuple } from '@/core/math/vec3';

export type EngineDef = Extract<ModuleDef, { type: 'engine' }>;
export type RcsDef = Extract<ModuleDef, { type: 'rcs' }>;
export type LegsDef = Extract<ModuleDef, { type: 'legs' }>;
export type ParachuteDef = Extract<ModuleDef, { type: 'parachute' }>;
export type HeatShieldDef = Extract<ModuleDef, { type: 'heatShield' }>;
export type DecouplerDef = Extract<ModuleDef, { type: 'decoupler' }>;
export type FairingDef = Extract<ModuleDef, { type: 'fairing' }>;
export type CommandDef = Extract<ModuleDef, { type: 'command' }>;

export type EngineState = Extract<ModuleState, { type: 'engine' }>;
export type RcsState = Extract<ModuleState, { type: 'rcs' }>;
export type LegsState = Extract<ModuleState, { type: 'legs' }>;
export type ParachuteState = Extract<ModuleState, { type: 'parachute' }>;
export type HeatShieldState = Extract<ModuleState, { type: 'heatShield' }>;

/** Internal per-module state that is not part of the snapshot contract. Index matches PartDef.modules. */
export type ModuleRt =
  | {
      type: 'engine';
      /** Burning (between the ignition and shutdown events). */
      lit: boolean;
      /** Fixed-burn motors: seconds of burn left once started (0 when spent). */
      burnLeft: number;
      started: boolean;
      /** Commanded gimbal deflection about the part X and Z axes, rad. */
      cmdX: number;
      cmdZ: number;
    }
  | { type: 'rcs'; /** Seconds until the next rcsPulse event may be emitted. */ pulseCooldown: number; firing: boolean }
  | { type: 'legs'; /** 0 = retract, 1 = deploy. */ target: number }
  | { type: 'parachute'; /** Canopies still intact (starts at the def's count). */ canopies: number }
  | { type: 'none' };

/**
 * What the vehicle says about one command part, copied onto it by the assembler (ARCHITECTURE 7.2: crew,
 * cockpit interior, camera seat, sensor camera and the remote flag live on the command part; seats and the
 * hatch are read from its definition). `VehicleDef.crew`, `.cockpit` and `.cameras.cockpit` are the authoring
 * conveniences they come from.
 */
export interface CommandRuntime {
  /** Index of the command module in `def.modules`. */
  module: number;
  /** Who sits in which seat of this part. */
  crew: { seat: string; name: string }[];
  /** Cockpit interior layout id of this part; null = no cabin (the first-person view is the sensor camera). */
  cockpit: string | null;
  /** Seat the cockpit camera sits in; null when the vehicle places none on this part. */
  cameraSeat: string | null;
  /** Where the sensor camera sits on a part without a cabin (part frame); null = derived from the part's nose. */
  sensorCamera: { pos: Vec3Tuple; lookDir: Vec3Tuple; upDir: Vec3Tuple } | null;
  /** Command authority with no crew aboard. */
  remote: boolean;
  /**
   * Accumulated g dose of the crew of THIS part, g s (0 without crew). The dose belongs to the people in the
   * seats: it stays with the part through a dock, an undock and a separation. `Vessel.gDose` is the largest
   * dose among the live crewed command parts aboard.
   */
  gDose: number;
}

/**
 * One craft of a vessel: what was launched as one vehicle, with its own stage stack, abort sequence, owner
 * and lend policy. A piece that separates from a craft (staging debris, a fragment) carries a COPY of the
 * record, so the owner stays known for attribution and expiry; the record with the live stage stack stays
 * with the piece that holds the craft's root part.
 */
export interface CraftRuntime {
  /** Issued by the universe (an injected CraftIdSource); never changes, never reused, never names a vessel of several craft. */
  craftId: string;
  vehicleId: string;
  vehicle: VehicleDef;
  /** Owner account; null = nobody. */
  ownerId: string | null;
  name: string;
  /** Tick at which the craft became part of this vessel (seniority inside an assembly). */
  joinedTick: number;
  /**
   * Lineage: the craft this one separated from. null = it was launched (assembled) as a craft. A piece that
   * leaves a craft is a craft of its own from that tick on (ids.ts), so no two vessels ever carry one craft.
   */
  parent: string | null;
  /** Instance id of the craft's root part: the part its identity goes with (the piece that holds it keeps the craft). */
  root: string;
  /** Next stage-stack entry to fire, lockout seconds left, queued delayed actions, seconds since the last staging action. */
  nextStage: number;
  stageLockout: number;
  pending: PendingAction[];
  sinceStaging: number;
  /** What the helm may use of this craft while it is docked. */
  policy: LendPolicy;
}

/** A docked joint: indices into `Vessel.parts` of the two port parts, and the roll of port b about the shared axis relative to port a, rad. */
export interface DockLink {
  a: number;
  b: number;
  roll: number;
}

export interface PartRuntime {
  instanceId: string;
  def: PartDef;
  /** Index into `Vessel.crafts` of the craft this part belongs to. `instanceId` is unique within the craft. */
  craft: number;
  /** Index of the parent part in Vessel.parts; -1 for a root (every craft has its own; a pre-mated dock makes one more). */
  parent: number;
  /** Propellant-flow group within the craft: a flow group is (craft, stageGroup). */
  stageGroup: string;
  /** Pose of the part frame in VES: v_VES = rotate(rot, v_part) + pos. */
  pos: Vec3;
  rot: Quat;
  /** Remaining resources in kg, parallel to def.resources. */
  resources: number[];
  modules: ModuleState[];
  rt: ModuleRt[];
  /** Temperature of each thermal surface, K (parallel to def.thermal.surfaces). */
  temps: number[];
  shielded: boolean;
  /** Set on the debris part of one jettisoned fairing panel: sector `index` of `count`. */
  panel: { index: number; count: number } | null;
  /** Seconds the joint to the parent has been over its acceleration / q-alpha limit. */
  stress: number;
  /** Set on a part with a command module: crew, cockpit, cameras and the remote flag of this part. */
  command: CommandRuntime | null;
}

/** Contact state of one probe that outlives a step: touching, under water, and the friction anchor in the body-fixed frame. */
export interface ProbeState {
  inContact: boolean;
  wet: boolean;
  hasAnchor: boolean;
  ax: number;
  ay: number;
  az: number;
}

/**
 * State that lives between steps and belongs to the vessel, not to its structure cache (ARCHITECTURE 7.2,
 * "State is whole"): the contact flags and friction anchors of the probes, which buoyancy spheres are
 * under water, and the thermal wake factors. Each list is in the order of the structure it belongs to
 * (`probes`: the structural probes, then the feet of each leg set; `buoyWet`: the buoyancy spheres;
 * `wake`: the thermal entries) and has exactly that structure's lengths. A change of the part set starts
 * it afresh (`invalidateStructure`); a copy and the codec carry it.
 */
export interface CarriedState {
  probes: ProbeState[];
  buoyWet: boolean[];
  wake: number[];
}

export interface PendingAction {
  action: TimedStageAction;
  /** Seconds until it executes. */
  timeLeft: number;
  /** Stage index it belongs to (-1 for the abort sequence). */
  stageIndex: number;
}

export interface SasState {
  enabled: boolean;
  mode: SasMode;
  /** Unit direction to hold, BCI/ROOT axes; supplied by the orchestrator for every non-stability mode. */
  holdDir: Vec3 | null;
  /** Stability target (VES -> BCI) and whether one is captured. */
  target: Quat;
  hasTarget: boolean;
  /** Per VES torque axis (x pitch, y roll, z -yaw): input was active, seconds since release (-1 = idle). */
  inputActive: [boolean, boolean, boolean];
  releaseTimer: [number, number, number];
  /** Hold weight per axis, 1 = full direction hold, 0 = rate damping only (authority-aware anti-windup). */
  hold: [number, number, number];
  /** Integrated attitude error per axis, rad s (removes steady offsets under full hold). */
  integral: [number, number, number];
  /** External torque that holding the target attitude would have to oppose, N m (VES axes, diagnostic). */
  externalTorque: [number, number, number];
}

export interface MassProps {
  mass: number;
  /** Centre of mass in VES. */
  com: Vec3;
  /** Inertia tensor about the CoM in VES axes (symmetric) and its inverse: xx, yy, zz, xy, xz, yz. */
  i: [number, number, number, number, number, number];
  inv: [number, number, number, number, number, number];
}

export interface AeroRuntime {
  /** Dynamic pressure Pa, Mach, angle of attack (nose vs air-relative velocity) rad. */
  q: number;
  /**
   * The MODEL's Mach number: air-relative speed over the speed of sound of the atmosphere sample, which the
   * sample also carries where there is no air (VACUUM). The parachute envelopes are evaluated with it in
   * every regime. What a vessel REPORTS (VesselSnapshot.aero.mach, Readouts.mach, milestone data) is
   * `reportedMach`: 0 where the density is 0.
   */
  mach: number;
  aoa: number;
  density: number;
  pressure: number;
  temperature: number;
  /** Velocity of the CoM relative to the co-rotating air, BCI axes, m/s. */
  airVelocity: Vec3;
  heatFlux: number;
  plasmaIntensity: number;
  /** Unit direction of the aerodynamic lift (force component normal to the airflow) in VES, null when negligible. */
  liftDirVes: Vec3 | null;
  /** Aerodynamic force and torque about the CoM in VES axes at the start of the last step. */
  force: Vec3;
  torque: Vec3;
}

/** Why a vessel is not being integrated: held by launch clamps, permanently fixed to the ground, or asleep after landing. */
export type HoldKind = 'clamps' | 'ground' | 'asleep';
export type SurfaceState = 'none' | 'prelaunch' | 'landed' | 'splashed';

export interface Vessel {
  /**
   * Runtime id (ARCHITECTURE section 3): the craft id for a whole single craft, `<craftId>~<root instance id>`
   * for a piece of one craft without that craft's root, `a~<lowest id>~<tick>` for a vessel of two or more craft.
   */
  id: string;
  name: string;
  /** The craft of this vessel, the base craft first; length 1 for anything that never docked. */
  crafts: CraftRuntime[];
  /** Docked joints; empty for anything that never docked. */
  links: DockLink[];
  /**
   * Who flies the vessel and from where: the account at the helm (null = vacant), the craft whose stage stack
   * the helm's stage and abort presses act on, and the part whose axes are the control frame.
   */
  helm: { accountId: string | null; craft: number; controlPart: number };
  /** Every part of every craft: each craft's parents precede its children; `parts[0]` is the root of the base craft. */
  parts: PartRuntime[];
  r: Vec3;
  v: Vec3;
  q: Quat;
  w: Vec3;
  /** Seconds this vessel has existed and number of steps taken. */
  age: number;
  stepCount: number;

  sas: SasState;
  rcsEnabled: boolean;
  fineControl: boolean;
  lightsOn: boolean;
  /** Throttle lever of the last step (kept for needsIntegration and readouts). */
  throttle: number;
  /** Controls actually applied in the last step (after SAS, fine control and clamping). */
  appliedControls: ControlInputs;

  hold: HoldKind | null;
  /** Body-fixed pose while held: position and VES -> BCBF orientation. */
  anchor: { rFixed: Vec3; qFixed: Quat } | null;
  surface: SurfaceState;

  mp: MassProps;
  aero: AeroRuntime;
  /** Total engine + RCS thrust magnitude of the last step, N. */
  thrust: number;
  /** Available control torque per VES axis in the last step, N m. */
  authority: [number, number, number];
  /** Filtered g-load, unfiltered proper acceleration (VES, m/s^2), accumulated crew dose (g s). */
  gLoad: number;
  properAccel: Vec3;
  gDose: number;
  crewAlive: boolean;
  /**
   * The sun sample the vessel flies with: direction to the star (ROOT axes) and the visible fraction of
   * its disc at the vessel. The orchestrator takes it when the tick is a multiple of the sample period and
   * at a rails landing; it is state, so that a vessel restored between two samples goes on with the one it had.
   */
  sun: { dir: Vec3; visibility: number };
  contact: { anyContact: boolean; maxForce: number; waterSubmersion: number };
  /** Height of the lowest contact probe above terrain or water at the last step, m (Infinity when not evaluated). */
  groundClearance: number;
  /** Seconds the sleep / splashdown conditions have held, seconds since last ground contact. */
  restTimer: number;
  splashTimer: number;
  airborneTime: number;
  inWater: boolean;
  /** True once every part is gone (the orchestrator removes the vessel). */
  destroyed: boolean;
  /**
   * Contact, wetness and wake state between steps, in the order of the structure; null until the first
   * structure of this part set is built (every probe free, every sphere dry, every surface exposed).
   */
  carried: CarriedState | null;
  /** Derived, rebuilt after every structural change (a Structure, see structure.ts; null = stale). Holds no state of its own. */
  struct: unknown;
}

export interface StepResult {
  events: SimEvent[];
  spawned: Vessel[];
}

/** Collector handed through staging and failure code during one call. */
export interface StepContext {
  ut: number;
  /** Null when no environment is available (structural, dynamics-free use through the public facade). */
  env: VesselEnvironment | null;
  /** Structural mode: actions take their settled end state at once (no thrust checks, motors spent, chutes open). */
  instant: boolean;
  events: SimEvent[];
  spawned: Vessel[];
}

export const GIMBAL_MIN_THRUST_FRACTION = 0.05;
export const STAGE_LOCKOUT = 0.5;
export const INITIAL_PART_TEMP = 290;
export const G_DOSE_LIMIT = 15;
