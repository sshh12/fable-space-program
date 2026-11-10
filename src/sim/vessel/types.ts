/**
 * Runtime vessel model shared by src/sim/vessel, src/sim/dynamics and src/sim/control.
 *
 * Frames: VES (+Y nose, +X starboard, +Z dorsal) has its origin at the root part origin; `q` maps VES to
 * the inertial axes of the central body (BCI, parallel to ROOT); `w` is the angular velocity in VES axes;
 * `r`, `v` are the position and velocity of the VES origin in BCI.
 */
import type { ControlInputs, SasMode } from '@/core/contracts/controls';
import type { ModuleDef, PartDef, TimedStageAction, VehicleDef } from '@/core/contracts/defs';
import type { ModuleState, SimEvent } from '@/core/contracts/sim';
import type { VesselEnvironment } from '@/core/contracts/simInternal';
import type { Quat } from '@/core/math/quat';
import type { Vec3 } from '@/core/math/vec3';

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

export interface PartRuntime {
  instanceId: string;
  def: PartDef;
  /** Index of the parent part in Vessel.parts; -1 for the root. */
  parent: number;
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
  id: string;
  name: string;
  vehicleId: string;
  vehicle: VehicleDef;
  parts: PartRuntime[];
  r: Vec3;
  v: Vec3;
  q: Quat;
  w: Vec3;
  /** Seconds this vessel has existed and number of steps taken. */
  age: number;
  stepCount: number;

  /** Next stage-stack entry to fire, lockout seconds left, queued delayed actions, seconds since the last staging action. */
  nextStage: number;
  stageLockout: number;
  pending: PendingAction[];
  sinceStaging: number;

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
  /** Derived, rebuilt after every structural change (a Structure, see structure.ts; null = stale). */
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
