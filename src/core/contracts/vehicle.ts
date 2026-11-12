/**
 * What is known about a vehicle before it flies (docs/ARCHITECTURE.md section 9.2): the read-outs the menu
 * shows and the generic pilots plan with (`VehicleCapabilities`, computed by `analyzeVehicle` in
 * src/sim/vessel, never authored), and the findings of `validateVehicle` (`Issue`). Both are plain data so
 * that the shell's stores, the hangar and the pilots receive them without importing the simulation.
 *
 *   analyzeVehicle(defs: DefLibrary, vehicle: VehicleDef): VehicleCapabilities     (src/sim/vessel/analyze.ts)
 *   validateVehicle(defs: DefLibrary, vehicle: VehicleDef): Issue[]                (src/sim/vessel/validate.ts)
 *
 * Both are pure; `validateVehicle` runs in the definition tests, on every spawn (server and LocalSession) and
 * later in a builder, and reports the overlap the simulation would see (it shares the assembler and the
 * collider library).
 */
import type { BodyId, ResourceId, VehicleId } from './defs';
import type { PadClass } from './net';

/** One entry of the stage stack as the hangar shows it (full tanks, nothing fired). */
export interface StageCapability {
  /** Index into `VehicleDef.stages` and its label. */
  stageIndex: number;
  label: string;
  /** Delta-v of this stage's engines with everything above it attached, m/s: in vacuum and at sea level of the launch body (0 for a stage without engines). */
  deltaVVac: number;
  deltaVSeaLevel: number;
  /** Thrust-to-weight at ignition: in vacuum against the launch body's surface gravity, and at sea level. */
  twrVac: number;
  twrSeaLevel: number;
  /** Full-throttle burn time, s, and the mass at ignition and at burn-out, kg. */
  burnTime: number;
  massStart: number;
  massEnd: number;
}

/** A docking port of the vehicle. */
export interface PortCapability {
  /** Instance id of the port part and its type (ports mate only with the same type). */
  part: string;
  portType: string;
  /** False when a stacked part covers the face at launch (it frees when that part is dropped). */
  freeAtLaunch: boolean;
}

/** One rung of the "can reach" ladder: what the vehicle's delta-v budget allows from low orbit of the launch body. */
export interface ReachEntry {
  bodyId: BodyId;
  /** 'orbit': a closed orbit (a bound capture ellipse at a giant); 'flyby': an encounter without capture; 'land': a landing (bodies with a surface, later). */
  kind: 'flyby' | 'orbit' | 'land';
  /** Delta-v needed from low orbit of the launch body, m/s, and what is left (negative = short by that much). */
  deltaVRequired: number;
  margin: number;
  /** True when the margin exists only with the refuelled profile (a depot visit before departure). */
  needsRefuel: boolean;
}

/** Everything the menu and the generic pilots read about a vehicle (ARCHITECTURE 9.2). */
export interface VehicleCapabilities {
  vehicleId: VehicleId;
  /** Lift-off mass and dry mass, kg; height and largest diameter of the stack, m; part count. */
  massWet: number;
  massDry: number;
  height: number;
  diameter: number;
  partCount: number;
  /** The pad class it needs (from `VehicleDef.padInterface`; derived from mass and diameter when absent). */
  padClass: PadClass;
  stages: StageCapability[];
  /** Sum of the stages' vacuum delta-v, m/s, and what is left once in low orbit of the launch body (null when it cannot reach orbit). */
  deltaVTotal: number;
  deltaVInOrbit: number | null;
  /** Crew seats, and whether a command part can fly without crew. */
  crewCapacity: number;
  remote: boolean;
  /** What the first-person view is: a cabin interior (its layout id in `cockpit`), or the sensor camera of a command part without one. */
  firstPerson: 'cockpit' | 'sensorCamera';
  cockpit: string | null;
  ports: PortCapability[];
  /** Attitude and translation: RCS present, its delta-v (m/s, craft after staging to its last stage) and reaction wheels. */
  rcs: boolean;
  rcsDeltaV: number;
  reactionWheels: boolean;
  /** Heat shield: fastest survivable entry of the launch body's atmosphere, m/s; null without a shield. */
  entrySpeedLimit: number | null;
  parachutes: boolean;
  legs: boolean;
  /** Resources the craft can give or take through its ports. */
  transferable: ResourceId[];
  /** The "can reach" ladder, nearest first, from the bodies' data. */
  reach: ReachEntry[];
}

/** A finding of `validateVehicle`. A vehicle with an 'error' is not spawned. */
export interface Issue {
  severity: 'error' | 'warning';
  /**
   * Stable machine-readable code, e.g. 'noRoot', 'unreachablePart', 'nodeOccupied', 'nodeSizeMismatch',
   * 'overlap', 'stageActionTarget', 'noCommand', 'noClamps', 'padClassExceeded', 'unknownPart'.
   */
  code: string;
  /** Player-facing sentence. */
  message: string;
  /** Instance ids of the parts concerned, and the stage index for a stage finding. */
  parts: string[];
  stageIndex?: number;
  /** Code-specific number (overlap depth in m, the mass or diameter that exceeds a limit, ...). */
  value?: number;
}
