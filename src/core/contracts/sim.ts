/**
 * Simulation <-> presentation contract. The sim (src/sim) produces immutable SimSnapshots; renderer,
 * audio, HUD, map view and pilots consume them and answer only with ControlInputs / PlayerCommands.
 *
 * Frames (all right-handed, SI units; see docs/ARCHITECTURE.md section 3):
 *  - ROOT: the RENDER ROOT. Axes inertial (+Z = Earth north pole of J2000, +X = J2000 equinox); origin near
 *    the viewer, stated by `SimSnapshot.frame`: the centre of the SOI body of the focus when that body is a
 *    planet or moon, the focus island's reference-orbit point in the Sun's sphere of influence. It is NOT
 *    the system's root body (the Sun, `DefLibrary.rootBodyId`). Every field named `...Root` (`rRoot`,
 *    `vRoot`, `positionRoot`, `posRoot`, `qFixedToRoot`, `spinRoot`, `bodyPosAtEnd`) is expressed in it.
 *    Presentation uses only differences of ROOT positions and ROOT axes, so it is origin-agnostic; whatever
 *    holds a ROOT position across frames applies `frame.rebase` once when `frame.epoch` changes
 *    (src/core/math/frame.ts). Until `frame` is produced (MIGRATION_V2 step 3.5) the origin is the centre
 *    of the library's root body and never changes.
 *  - BCI(b): centred on body b, axes parallel to ROOT.
 *  - BCBF(b): body-fixed, +Z spin axis, +X prime meridian.
 *  - VES: vessel frame, origin at the root part origin of the vessel's base craft, +Y nose (thrust
 *    direction), +X starboard, +Z dorsal.
 *  - CTL: the frame of the helm's control part; control inputs and the navball refer to it.
 *
 * Ids (docs/ARCHITECTURE.md section 3). A CRAFT id (`CraftSnapshot.id`) is unique in the universe, never
 * changes and is never reused. A part's INSTANCE id (`PartSnapshot.instanceId`) is unique within its craft
 * only. Three characters compose ids, and an id issued for a launched craft, a vehicle id and an instance id
 * contain none of them:
 *   '/'  joins a craft id and an instance id into the PART KEY `craftId/instanceId`, which is how a part is
 *        addressed outside its craft;
 *   '.'  joins the id of a craft that left another as a piece: `<parent craft id>.<instance id of its root
 *        part>`. So a craft id may contain '.', and never '/' or '~';
 *   '~'  separates the fields of derived VESSEL ids: the vessel of one piece craft is `<launched craft at
 *        the top of its lineage>~<instance id of its root part>` (not its craft id), a vessel of several
 *        craft is `a~<vessel id>~<tick>`. The vessel of one launched craft has that craft's id.
 * The simulation composes these forms; A CONSUMER NEVER TAKES AN ID APART. Ids are compared, and what an id
 * would tell is a field: the craft a piece left is `CraftSnapshot.parent`, the craft of a part is
 * `PartSnapshot.craftId`, the craft of a vessel are `VesselSnapshot.crafts`. A part in an event is named by
 * its part key, which is compared with the key of a part and never taken apart (see `SimEvent`).
 *
 * v2 fields (MIGRATION_V2 section 4) are REQUIRED since the tighten step after sub-wave 3.2 (2026-11-24):
 * every producer states them, the session and the hand-built snapshots of the fakes, the labs and the tests
 * alike, and no consumer has a fallback for a missing one. The v1 members they replaced are gone
 * (`SimSnapshot.tick`, `Readouts.targetBodyId` and `.targetClosestApproach`, the aliases `Sim` and
 * `SimDebug`). A member that is still optional says why in its own comment.
 */
import type { ConicElements } from '../math/conic';
import type { FrameEpochOrigin, FrameRebase } from '../math/frame';
import type { Quat } from '../math/quat';
import type { Vec3, Vec3Tuple } from '../math/vec3';
import type { ControlInputs, NavballMode, SasMode } from './controls';
import type { ParachuteEnvelope, ScenarioDef } from './defs';
import type { LendPolicy, Presence, TargetRef, TimeOffer, TimeView } from './net';
import type { LocalSession, SessionDebug } from './session';

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
  | 'maneuverNode'
  /**
   * v2: a closest approach to a targeted VESSEL, drawn as a pair (the marker and the target's position
   * then; `Marker.otherVesselId` and the fields after it). A member since the lead step of sub-wave 3.2
   * (2026-11-16); no producer emits it before the navigation of wave 4.
   */
  | 'targetApproach';

/** The v2 marker kind, a member of `MarkerKind`. */
export type MarkerKindV2 = 'targetApproach';

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
  /**
   * For impact and atmosphereEntry (optional on apsides): planetocentric latitude and east longitude (rad)
   * of the point in the BODY-FIXED frame of `bodyId` at `ut`, i.e. with the body's rotation until then
   * taken into account. This is where on the ground the trajectory arrives.
   */
  latitude?: number;
  longitude?: number;
  nodeId?: string;
  /**
   * For targetApproach (v2): the targeted vessel, the body whose BCI frame its position is in (the pair may
   * straddle a sphere-of-influence boundary) and that position at `ut`; `value` is the separation, m, and
   * `relSpeed` the relative speed there, m/s. `onForecast` is true when the target's position lies on its
   * forecast (after its head) and not on committed history.
   */
  otherVesselId?: string;
  otherBodyId?: string;
  otherR?: Vec3;
  relSpeed?: number;
  onForecast?: boolean;
}

/**
 * One conic arc of a predicted trajectory.
 *
 * Closed orbits and maneuver nodes: a closed patch with no event ends after one revolution
 * (endReason 'closed', nuEnd = nuStart + 2 pi). When a maneuver node lies further ahead than that, the
 * SAME conic is simply followed for as many revolutions as it takes: the patch ends at the node
 * (tEnd = node.ut, endReason 'maneuver') and nuEnd is unwrapped, nuEnd = nuStart + 2 pi k + (remaining
 * angle), so nuEnd - nuStart may exceed 2 pi. Consumers draw the ellipse once and place the node by nuEnd
 * modulo 2 pi. A node is therefore never lost, however many orbits ahead it is planned.
 */
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
  /**
   * ROOT-frame position of `bodyId` at tEnd (lets the map draw encounters "at intercept").
   *
   * At-intercept drawing anchors each encounter (the patches inside a child SOI) at the child body's ROOT
   * position at the SOI ENTRY, not at the encounter patch's own `bodyPosAtEnd` (the body at SOI exit or
   * impact, up to 65,000 km further along the Moon's orbit after a 17 h approach). With `prev` the patch
   * that ends with 'soiEnter' and `p` the first patch inside the SOI:
   *   anchor = prev.bodyPosAtEnd + conicPosition(prev.conic, prev.nuEnd) - conicPosition(p.conic, p.nuStart)
   * so the drawn chain is continuous at the intercept. Every encounter has its own anchor (a planned
   * encounter at another time than the current one is drawn around its own ghost of the body).
   */
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
      /**
       * The envelope light of THIS chute at the vessel's present altitude, Mach number and dynamic pressure;
       * null where there is no atmosphere at the vessel (on the Moon, above the air: a parachute needs air,
       * and nothing is judged there), as `Readouts.chuteEnvelope` is. A consumer shows no light for null.
       */
      envelope: ChuteEnvelope | null;
      /** Unit direction from the attach point to the canopy in the VES frame (trails the airflow). */
      lineDir: Vec3;
    }
  | { type: 'heatShield'; ablatorFraction: number; surfaceTemp: number }
  | { type: 'light'; on: boolean }
  | { type: 'antenna'; deployed: boolean }
  /** v2: a docking port (ARCHITECTURE 7.5); a member since the first port parts exist (request fleet-data-1, 2026-11-24). */
  | DockingPortState;

/**
 * v2: runtime state of a `dockingPort` module (ARCHITECTURE 7.5).
 *
 * A member of `ModuleState` since 2026-11-24 (request fleet-data-1), with `DockingPortModuleDef` in
 * `ModuleDef` (defs.ts).
 */
export type DockingPortState = {
  type: 'dockingPort';
  /**
   * 'disabled' (not armed or shielded), 'ready' (armed and free), 'occupied' (a stacked part or a docked
   * craft is on the face), 'soft' (soft capture in progress), 'hard' (docked), 'cooldown' (just released).
   */
  state: 'disabled' | 'ready' | 'occupied' | 'soft' | 'hard' | 'cooldown';
  /** Armed by its owner's command; persists offline. */
  armed: boolean;
  /** The port it is captured by or docked to: vessel id and part key `craftId/instanceId`; null otherwise. */
  peer: { vesselId: string; partKey: string } | null;
  /** 0..1 progress of the soft capture toward the hard dock (0 when not in soft capture). */
  progress: number;
};

export interface PartSnapshot {
  /**
   * Instance id from VehicleDef.parts: unique within its CRAFT and stable through staging and docking. Outside
   * a vessel a part is addressed by the part key `craftId/instanceId` (two craft of one vehicle in an
   * assembly share instance ids). It contains none of '/', '~' and '.' (the header's "Ids").
   */
  instanceId: string;
  /** v2: the craft this part belongs to (`VesselSnapshot.crafts[].id`). */
  craftId: string;
  /**
   * v2: the propellant-flow group of the part within its craft
   * (VehiclePartPlacement.stageGroup) and that group's label, so that resource bars and stage displays never
   * index `defs.vehicles` by a runtime id (a design that is not in the library draws correctly).
   */
  stageGroup: string;
  stageLabel: string;
  /**
   * v2 (request presentation-sweep-10): the place of the part's group in the list of flow groups of the
   * vehicle its craft was built from (`VehicleDef.stageGroups`; 0 = the first). Resource bars and the
   * systems page list the groups of a craft in this order, which is the vehicle designer's and not the
   * order in which the part list happens to show them. -1 for a part whose group the vehicle does not list.
   */
  stageOrder: number;
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
  /**
   * v2 (request presentation-sweep-2): set on the one part of a jettisoned
   * fairing PETAL, which is a vessel and a craft of its own: sector `index` (0-based) of `count`, and `of`,
   * the instance id of the fairing part it was a petal of. That fairing was a part of the craft this petal's
   * craft left (`CraftSnapshot.parent`), and it is the part a `fairingJettisoned` event names. null for
   * every other part. With it nothing reads a petal's instance id, which is opaque like every other id.
   */
  panel: { index: number; count: number; of: string } | null;
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

/**
 * The cockpit of a craft, resolved from its command part (v2). The simulation states it per craft so that
 * no consumer indexes `defs.vehicles` by a runtime id for it: the cockpit eye is the viewer's own command
 * part (ARCHITECTURE 7.2, 9.1, 20), and a craft whose design is not in the library has one all the same.
 * The values are the command part's own (`command.cockpit`, `command.sensorCamera` of its definition, with
 * the vehicle's authoring conveniences `VehicleDef.cockpit` and `cameras.cockpit` copied onto the part at
 * assembly); nothing here changes during a flight.
 */
export interface CraftCockpit {
  /** Cockpit interior layout id (src/render/cockpit registry); null = the command part has no cabin, the first-person view is the sensor camera. */
  id: string | null;
  /**
   * Id of the seat of the command part that the cockpit camera sits in. Its eye point and directions are
   * the entry of that id in `command.seats` of the part's definition (`PartSnapshot.def`), in the part
   * frame. null = the craft places no camera on a seat of this part (always null without a cabin).
   */
  cameraSeat: string | null;
  /**
   * Mount of the sensor camera on a command part without a cabin: position, look and up directions in the
   * part frame of the command part (`command.sensorCamera`). null = the part states none and the view is
   * derived from the part's nose.
   */
  sensorMount: { pos: Vec3Tuple; lookDir: Vec3Tuple; upDir: Vec3Tuple } | null;
  /**
   * v2 (request presentation-sweep-3): the crew of the craft by seat, as
   * the vehicle the craft was built from lists them (`VehicleDef.crew`): `seat` is the id of a seat of the
   * command part (`command.seats`), `name` the crew member's. Empty for a craft without crew. A seat's
   * readable name is the cockpit layout's label where it has one, else this name, else the seat's id;
   * nothing looks a vehicle up for it.
   */
  crew: { seat: string; name: string }[];
}

/** One craft of a vessel (v2; ARCHITECTURE 7.2). A vessel that never docked has exactly one. */
export interface CraftSnapshot {
  /**
   * Unique in the universe: no two craft share it, whatever vessels they are part of. It never changes
   * (through staging, docking, undocking and every hand-over between islands and processes) and is never
   * reused. It contains neither '/' nor '~' (the header's "Ids"). At a separation the piece that holds the
   * craft's root part keeps the craft and its id; every other piece that takes parts of it away is a new
   * craft with the id `<parent craft id>.<instance id of its root part>` (a function of ids, so a replay
   * issues the same one) and `parent` set (ARCHITECTURE 7.2, "Craft identity"). It is not the vessel's id
   * in general and is never parsed.
   */
  id: string;
  /**
   * v2: lineage. The id of the craft this one separated from; null for a
   * craft that was launched. A piece of debris is a craft of its own, and this is how a consumer finds what
   * it came from (to carry per-part presentation state across a separation, to name it) without taking an
   * id apart. The parent may itself be a piece (follow `parent` to the launched craft) and need not be in
   * the snapshot any more. No separation tick is recorded.
   */
  parent: string | null;
  /** Vehicle the craft was built from: for labels and icons only (never index `defs.vehicles` with it for behaviour). */
  vehicleId: string;
  name: string;
  /** Owner's account id and callsign; null = unowned. */
  ownerId: string | null;
  ownerCallsign: string | null;
  /** Instance id of the craft's command part (crew, seats, cockpit interior id, the remote flag live on it); null when it has none (debris). */
  commandPart: string | null;
  /**
   * v2: the cockpit of `commandPart`, resolved from the definitions the craft was built from (it is not
   * part of the saved state: a cockpit, a camera seat or a sensor mount may change in a definition without
   * touching a save). null = the craft has no command part. No consumer reads `defs.vehicles` for it.
   */
  cockpit: CraftCockpit | null;
  /** The craft's own stage stack: only its owner fires it, docked or not. */
  staging: { nextStage: number; stages: StageInfo[]; lockout: boolean };
  /** Chase-camera distances for this craft, m (from its vehicle's camera data; the rig combines them with the vessel's bounding radius). */
  chase: { defaultDistance: number; minDistance: number; maxDistance: number };
  /** What the helm may use of this craft while docked. */
  policy: LendPolicy;
}

/** A dock link between two craft of a vessel (v2): the part keys `craftId/instanceId` of the two port parts. */
export interface DockLinkSnapshot {
  a: string;
  b: string;
  /** Roll of port b about the shared axis relative to port a, rad. */
  roll: number;
}

export interface VesselSnapshot {
  id: string;
  name: string;
  /**
   * Id of the VehicleDef this vessel (or the vessel it separated from) was built from: the BASE craft's, for
   * labels only. Per-craft data is in `crafts`.
   */
  vehicleId: string;
  /** v2: the craft of this vessel, base craft first: at least one for a vessel with parts (what a session keeps in view of a destroyed vessel has no parts and describes no craft). */
  crafts: CraftSnapshot[];
  /** v2: dock links between the craft; empty = never docked. */
  links: DockLinkSnapshot[];
  /**
   * v2: who flies the vessel and from where. `accountId` null = the helm is
   * vacant; `craftId` and `controlPart` (part key) name the craft whose pilot holds it and the part whose
   * axes are the CTL frame.
   */
  helm: { accountId: string | null; callsign: string | null; craftId: string; controlPart: string };
  /** v2: how the vessel exists for the viewer (ARCHITECTURE 5.4). */
  presence: Presence;
  /** v2: the vessel's time minus the viewer's clock, in ticks (0 when on the viewer's clock). */
  timeOffset: number;
  /**
   * v2: true for a presentation-only vessel (the turntable's display vessel in the menu). It has no physics
   * and no owner; nameplates, the map, audio and LOD observers ignore it. Absent = false.
   */
  presentation?: boolean;
  /**
   * v2: monotonic counter that changes when the vessel's orbit or its plan
   * changes (end of a burn, an SOI change, a node edit, a dock): the key of planning results
   * (`PlanningKey.vesselRevision`).
   */
  revision: number;
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
  /**
   * v2: direction of the velocity relative to the target and its opposite
   * (what prograde and retrograde show in navball mode 'target'); null without a vessel or port target or
   * when the relative speed is below 1 mm/s.
   */
  relativePrograde: Vec3 | null;
  relativeRetrograde: Vec3 | null;
}

export interface NavballState {
  mode: NavballMode;
  /**
   * VES -> local horizon frame (ENU: +X east, +Y north, +Z up) at the vessel's sub-point of the current
   * SOI body. The ball is drawn as a real sphere whose texture is fixed in the horizon frame.
   */
  qVesselToHorizon: Quat;
  markers: NavballMarkers;
  /** Nose (+Y of VES) elevation above the local horizon, degrees in [-90, 90]. */
  pitchDeg: number;
  /**
   * Compass direction of the nose, degrees in [0, 360), 0 = north, 90 = east. When the nose is vertical (on
   * the pad) it is the compass direction the ventral side (-Z of VES) faces for a nose-up vessel, of the
   * dorsal side for a nose-down one: the heading the nose takes up when it pitches over.
   */
  headingDeg: number;
  /**
   * Rotation about the nose, degrees in (-180, 180]: 0 with the dorsal side (+Z of VES) up, positive =
   * rotation about +Y (dorsal side toward starboard, clockwise seen from behind): the sign of
   * `ControlInputs.roll` (ARCHITECTURE section 3). 0 when the nose is vertical.
   */
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
  // v2 (request presentation-sweep-3): what the stage says about itself
  // that does not change during a flight, from the vehicle the craft was built from and its parts'
  // definitions (src/core/defs/stageWords.ts, `describeStages`: one derivation for every producer). No
  // consumer looks the vehicle up by a runtime id for them.
  /**
   * What the stage burns: the labels of the stage groups of the engines its ignite actions light, each group
   * once, in the order the actions name them, joined with ' + ' ("Meridian M-3"). null for a stage that
   * ignites none.
   */
  burnLabel: string | null;
  /**
   * The engines the stage ignites, fixed-burn motors and engines without a vacuum Isp left out: their thrust
   * in vacuum, N, and their propellant's weight flow at standard gravity, N/s (the sum of thrustVac /
   * ispVac: mass flow times g0). Both 0 for a stage that ignites none. The full-throttle acceleration at the
   * stage's present mass is ve (1 - exp(-deltaVVac / ve)) / burnTime with ve = g0 thrustVac / weightFlowVac:
   * a figure that does not depend on local gravity (request flight-ui-8).
   */
  thrustVac: number;
  weightFlowVac: number;
  /**
   * One entry per entry of `actionKinds`: for a 'deployParachute' action the kind of canopy it deploys; for
   * a 'cutParachute' action the kind it releases (what the latest deploy action before it put out; null
   * when nothing was deployed before it); null for every other action.
   */
  actionChutes: ('drogue' | 'main' | null)[];
  /**
   * The envelopes of the canopy the stage's first deploy action puts out (`safe` and `destroy` of that
   * parachute's definition); null when the stage deploys none. The chute envelope light
   * (`Readouts.chuteEnvelope`) is about the first stage from `nextStage` on that deploys a parachute.
   */
  chuteEnvelopes: { safe: ParachuteEnvelope; destroy: ParachuteEnvelope } | null;
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
  /**
   * Relative inclination to the orbit plane of a targeted BODY that orbits the body the vessel is about,
   * rad; null without such a target. The same number as `target.relativeInclination`.
   */
  targetRelativeInclination: number | null;
  /**
   * v2: navigation to the selected target (a body, a vessel or a port); null without one. The in-process
   * session (`World`) has body targets only and states for one: `ref`, the body's name, `presence` 'solid',
   * range and range rate to the body's centre, the relative inclination, and in `closestApproaches` the ONE
   * approach that is the closest on the planned (or current) trajectory, with the speed relative to the
   * body at it; `relVelocity`, `relSpeed`, `lvlh` and `offer` are null for a body.
   */
  target: TargetReadout | null;
  /** v2: the docking instrument; null unless a port is targeted and an own port is the control point. */
  docking: DockingReadout | null;
  /** Launch-window helper while landed on the root body with a target set. */
  launchWindow: { timeToPlaneCrossing: number; launchAzimuthDeg: number } | null;
  nodeBurn: NodeBurnInfo | null;
  /** Lift direction label for lifting capsules in atmosphere. */
  liftVectorUp: boolean | null;
  /** Tilt of the nose from local vertical, rad (landing). */
  tiltFromVertical: number;
  /**
   * Navigation to a surface target (precision landing, splashdown zone); null when the current SOI body has
   * no 'landing' or 'recovery' target. The target is the one of those nearest to the predicted arrival point
   * (or to the sub-point when nothing is predicted). Information only: the player or pilot does the steering.
   */
  landingTarget: LandingTargetReadout | null;
}

/** Navigation to the selected target (v2; ARCHITECTURE 21). Distances m, speeds m/s. */
export interface TargetReadout {
  ref: TargetRef;
  name: string;
  /** How the target exists for the viewer and its time offset in ticks (a body is always 'solid', 0). */
  presence: Presence;
  timeOffset: number;
  /**
   * Range: port to port when both a control port and a target port are selected, else centre of mass to
   * centre of mass (to the body centre for a body). `rangeRate` negative = closing.
   */
  range: number;
  rangeRate: number;
  /** Velocity relative to the target in the CTL frame and its magnitude; null for a body target. */
  relVelocity: Vec3 | null;
  relSpeed: number | null;
  /** Relative inclination to the target's orbit plane, rad; null when the two are not about the same body. */
  relativeInclination: number | null;
  /** The next closest approaches on the planned (or current) trajectory, in time order, at most three. */
  closestApproaches: { ut: number; distance: number; relSpeed: number }[];
  /**
   * Own position in the target's local-vertical frame (radial out, along track, cross track), m; null for a
   * body target and beyond the range in which the frame is meaningful.
   */
  lvlh: { radial: number; along: number; cross: number } | null;
  /** The one action that makes an echo reachable (ARCHITECTURE 5.4); null when the target is solid. */
  offer: TimeOffer | null;
}

/** The docking instrument (v2; ARCHITECTURE 7.5, 21): the control port against the targeted port. */
export interface DockingReadout {
  /** Part keys of the own (control) port and the target port. */
  ownPort: string;
  targetPort: string;
  /** Same port type; the target port is armed. */
  compatible: boolean;
  targetArmed: boolean;
  /** Offsets in the target port's frame, m: along its axis (positive = in front of the face) and the two lateral components. */
  axial: number;
  lateral: [number, number];
  /** Misalignment of the two port axes about the two lateral axes, degrees, and roll to the nearest allowed step, degrees. */
  angleDeg: [number, number];
  rollDeg: number;
  /** Closing speed along the axis (positive = approaching), lateral speed, m/s, and relative rotation rate, deg/s. */
  closing: number;
  lateralSpeed: number;
  rateDegPerS: number;
  /** One flag per limit of the capture envelope: true = inside it. */
  within: { lateral: boolean; angle: boolean; roll: boolean; closing: boolean; lateralSpeed: boolean; rate: boolean };
  /** 'far' (beyond the instrument's range), 'approach', 'soft' (soft capture), 'hard' (docked). The lamps follow server events. */
  phase: 'far' | 'approach' | 'soft' | 'hard';
}

export interface LandingTargetReadout {
  /** Id of the SurfaceTarget in SimSnapshot.surfaceTargets. */
  targetId: string;
  /** Great-circle distance along the surface from the vessel's sub-point to the target centre, m. */
  distance: number;
  /** Compass bearing from the sub-point to the target, degrees clockwise from north. */
  bearingDeg: number;
  /**
   * The same separation resolved along the current ground track (surface-relative velocity direction):
   * downRange > 0 = target ahead; crossRange > 0 = target to the right of the track. Both 0 when the
   * surface speed is below 0.1 m/s.
   */
  downRange: number;
  crossRange: number;
  /**
   * Where the current (node-free) trajectory arrives: the 'impact' marker when the vacuum conic hits
   * terrain, else the 'atmosphereEntry' marker (the entry interface point, NOT the splash point), else null.
   * `missDistance` / `missBearingDeg` go from the target centre to that point.
   */
  predicted: { kind: 'impact' | 'entry'; ut: number; latitude: number; longitude: number; missDistance: number; missBearingDeg: number } | null;
}

/** A named place on a body, shown by the HUD and the map and used by the landingTarget readout. */
export interface SurfaceTarget {
  id: string;
  name: string;
  bodyId: string;
  /** 'landing' = ScenarioDef.suggestedLanding; 'recovery' = LaunchSiteDef.recoveryZones; 'site' = the launch site. */
  kind: 'landing' | 'recovery' | 'site';
  /** Planetocentric latitude and east longitude, rad. */
  latitude: number;
  longitude: number;
  /** Radius of the zone on the surface, m (0 for a point target). */
  radius: number;
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
 * Mission milestones are detected by the sim from physical state only, by a GENERIC evaluator of the
 * declarative rules in ScenarioDef.milestones (defs.ts: MilestoneRuleDef). The sim contains no milestone
 * ids and no mission-specific logic; `MilestoneId` above is merely the vocabulary that
 * data/defs/scenarios/lunar-direct.json uses, typed here for the mission tests and the mission pilot.
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
  /**
   * v2: true while the outcome is not yet durable on the server (an outcome between two owners shown inside
   * the 250 ms a crash may re-run; ARCHITECTURE 15.1, decision 53 d). Absent = false. Never set by a
   * LocalSession.
   */
  provisional?: boolean;
}

/** Envelope limits of a docking port (v2), named in `captureLost`. */
export type CaptureLimit = 'lateral' | 'angle' | 'roll' | 'closing' | 'lateralSpeed' | 'rate';

/**
 * Part ids in events (`partId`, `otherPartId`, `partsDestroyed`) are PART KEYS, `craftId/instanceId`, in
 * every event and for a vessel of one craft too (one form since the tighten step after sub-wave 3.2). A
 * consumer finds the part by comparing with the key of a part (`craftId` + '/' + `instanceId`, which the
 * access module of the presentation builds once per part); it never takes a key apart.
 */
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
  | (EventBase & { type: 'partDestroyed'; partId: string; cause: 'impact' | 'overheat' | 'overstress' | 'explosion' | 'collision'; posVes: Vec3 })
  | (EventBase & { type: 'explosion'; posRoot: Vec3; energy: number })
  | (EventBase & { type: 'jointBroken'; partId: string })
  | (EventBase & { type: 'crewLost'; cause: string })
  | (EventBase & { type: 'soiChange'; fromBodyId: string; toBodyId: string })
  | (EventBase & { type: 'vesselRemoved'; reason: 'burnedUp' | 'impact' | 'expired' | 'limit' | 'rolledBack' | 'recovered' | 'lost' | 'pressure' })
  | (EventBase & { type: 'activeVesselChanged'; previousVesselId: string })
  | (EventBase & { type: 'warpChanged'; index: number; factor: number; reason: string | null })
  | (EventBase & { type: 'nodeCompleted'; nodeId: string })
  | (EventBase & { type: 'milestone'; milestone: MilestoneRecord })
  | (EventBase & { type: 'missionFailed'; reason: string })
  | SimEventV2;

/**
 * The events added by v2 (ARCHITECTURE 5, 7.4, 7.5, 9.4), all members of `SimEvent`. `activeVesselChanged`,
 * `warpChanged`, `milestone` and `missionFailed` above are per session: they describe the viewer's own
 * seat, clock and objectives. No session emits a v2 event before the code that causes it exists (docking
 * and contact in wave 5, the directory in wave 4.2).
 */
export type SimEventV2 =
  /** Two ports entered soft capture. `partId` / `otherPartId` are part keys. */
  | (EventBase & { type: 'dockCapture'; partId: string; otherVesselId: string; otherPartId: string })
  /** Hard dock: `vesselId` is the merged vessel, `absorbedVesselId` the id that became a tombstone. */
  | (EventBase & { type: 'docked'; partId: string; otherPartId: string; absorbedVesselId: string })
  /** A capture did not happen or let go: outside the envelope (`limit`), the port taken first by another craft, clamped too long, or timed out. */
  | (EventBase & { type: 'captureLost'; partId: string; otherVesselId: string; reason: 'envelope' | 'occupied' | 'clamped' | 'timeout'; limit?: CaptureLimit })
  /** `vesselId` keeps the helm's craft; `newVesselIds` are the other pieces. */
  | (EventBase & { type: 'undocked'; partId: string; otherPartId: string; newVesselIds: string[] })
  /** Contact above crash tolerance between two vessels, with the same numbers for both: relative speed m/s, part keys destroyed on either side. */
  | (EventBase & { type: 'collision'; otherVesselId: string; relSpeed: number; partsDestroyed: string[] })
  /** The helm of `vesselId` changed hands (null = vacant). */
  | (EventBase & { type: 'helmChanged'; accountId: string | null; callsign: string | null; craftId: string })
  /** Confirmation of a command that returned `pending` (CommandResult.cmdId). */
  | (EventBase & { type: 'commandResult'; cmdId: number; ok: boolean; appliedTick: number; reason?: string })
  /** Another clock's island took the reservation of a vessel this island had admitted (U4); `offer` is the action open to this pilot by relation. */
  | (EventBase & { type: 'claimLost'; otherVesselId: string; offer: TimeOffer | null })
  /** A close approach the server predicts: time to it, miss distance and relative speed. */
  | (EventBase & { type: 'proximityWarning'; otherVesselId: string; timeToClosest: number; distance: number; relSpeed: number })
  /** A pad left the vessel's hold: cleared after lift-off, rolled back, or safed. */
  | (EventBase & { type: 'padReleased'; siteId: string; padId: string; reason: 'cleared' | 'rolledBack' | 'safed' })
  /** The viewer's clock changed (rate, kind, membership, a fork); `reason` is the sentence the HUD shows, null for the pilot's own request. */
  | (EventBase & { type: 'clockChanged'; clockId: string | null; rate: number; reason: string | null })
  /** U5: the server is pushing this vessel clear of `otherVesselId` ("RANGE: CLEARING"); `active` false = clearance reached. */
  | (EventBase & { type: 'rangeClearing'; otherVesselId: string; active: boolean });

export type SimEventType = SimEvent['type'];
export type SimEventV2Type = SimEventV2['type'];

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

/** Where the origin of the render root is (ARCHITECTURE section 3). Axes are always parallel to ICRF. */
export type FrameOrigin =
  /** The centre of a body (the SOI body of the focus). */
  | { kind: 'body'; bodyId: string }
  /** A point on an exact Kepler orbit about `bodyId` (the focus island's reference orbit): its BCI state at `t0`. */
  | { kind: 'orbit'; bodyId: string; r0: Vec3; v0: Vec3; t0: number };

/**
 * The render root of a snapshot. `epoch` increases whenever the origin is replaced (focus change, a
 * sphere-of-influence change of the focus, a new island reference orbit). The snapshot() that first carries
 * a new epoch also carries `rebase`: the OLD origin's position and velocity in the NEW frame at the
 * snapshot time, composed over every replacement since the previous snapshot() of the session (so the
 * epoch may jump by more than one). Like `events`, it is pending until snapshot() drains it: peek() shows
 * it without clearing it. Anything that holds a ROOT position across frames (camera rigs, the renderer's
 * previous-frame state, world-anchored effects, the map focus) applies it once, through
 * src/core/math/frame.ts. Motion vectors need no rebase.
 *
 * `previous` makes that safe for a holder that does not see every snapshot: the origins of the most recent
 * earlier epochs (FRAME_HISTORY_EPOCHS of them once that many exist, newest first), each as its position and
 * velocity in THIS frame at this snapshot's time. It is filled in EVERY snapshot, also when the epoch did
 * not change (an old origin keeps moving in the current frame), in snapshot() and peek() alike. A holder that
 * last observed epoch k rebases with the entry of epoch k (`FrameEpochTracker` does), however many snapshots
 * it skipped. When `rebase` is not null it equals the entry of the epoch of the previous snapshot().
 * Optional in the type only for hand-built snapshots; a session always fills it.
 */
export interface SnapshotFrame {
  epoch: number;
  origin: FrameOrigin;
  rebase: FrameRebase | null;
  previous?: FrameEpochOrigin[];
}

export interface SimSnapshot {
  /**
   * Seconds since J2000.0 that every pose in this snapshot (bodies, vessels, parts) corresponds to.
   * For peek() this equals simUt. For snapshot() it is the PRESENTATION time: Sim.advance() accumulates
   * real time, runs whole fixed steps, and snapshot() interpolates integrated vessels between the last
   * two steps (bodies, rails and landed vessels are evaluated exactly at `ut`), so motion is smooth at any
   * display refresh rate. simUt - ut is in [0, PHYSICS_DT).
   */
  ut: number;
  /** Time of the latest completed physics step or rails advance: the true simulation state time. */
  simUt: number;
  /**
   * v2: monotonic counter that changes whenever anything in the snapshot may have changed (lets consumers
   * detect "no change"). It replaced v1's `tick` (in v2 "tick" means the universe tick of 1/120 s).
   */
  revision: number;
  /** v2: the render root this snapshot's ROOT positions are relative to (ARCHITECTURE section 3). */
  frame: SnapshotFrame;
  /**
   * v2: the viewer's clock for the time strip (ARCHITECTURE 5.4). `warp` below stays and is derived from
   * it.
   */
  time: TimeView;
  warp: WarpState;
  /**
   * The scenario the session was created from; null for a session without one (a lobby). `milestones`,
   * `mission` and `cheatCounter` then describe the active craft's objectives and are empty / not failed /
   * 0 without them.
   */
  scenario: { id: string; startKind: ScenarioDef['start']['kind']; stagesAlreadyFired: number } | null;
  /** Named surface places of this scenario (landing target, recovery zones, launch site). */
  surfaceTargets: SurfaceTarget[];
  /**
   * Terrain data status for the active vessel. `complete`: final-resolution data is resident under it.
   * `pending`: a load requested by the sim has not finished (Sim.terrainPending() is non-null).
   * `incompleteQueries`: number of physics steps so far in which a contact probe or a radar-altitude query
   * below 50 km ran on data that was not final. Mission proofs require 0.
   */
  terrain: { complete: boolean; pending: boolean; incompleteQueries: number };
  bodies: BodySnapshot[];
  /** Id of the star that lights the system. */
  starId: string;
  vessels: VesselSnapshot[];
  /**
   * The vessel the viewer is seated in; null when there is none (the menu, a spectator, a pilot between
   * ships). The singleton blocks below are then still present with neutral values (`neutralFlightBlocks()`
   * of the session). Every consumer handles null.
   */
  activeVesselId: string | null;
  /** Controls actually applied this step (after SAS, fine-control scaling and clamping). */
  appliedControls: ControlInputs;
  navball: NavballState;
  readouts: Readouts;
  staging: { nextStage: number; stages: StageInfo[]; lockout: boolean };
  /**
   * Predicted trajectory of the active vessel. `current` ignores maneuver nodes. `planned` is empty without
   * a node; otherwise it STARTS AT the first future node: `planned[0].tStart = nodes[0].ut`, from the state
   * on the current trajectory at that time plus the node's delta-v, and every planned patch carries
   * `afterNodeId` (the latest node applied before it). The arc from now to the first node is not repeated
   * in `planned`: it is the part of `current` before `nodes[0].ut`. A planned patch that runs into a later
   * node ends there with endReason 'maneuver'.
   */
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

// v1's names `Sim` and `SimDebug` are gone (the tighten step after sub-wave 3.2): the session contract is
// `LocalSession` / `FlightSession` and `SessionDebug` of session.ts, and `createSession` of src/session
// makes one.
