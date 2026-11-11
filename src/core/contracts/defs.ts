/**
 * Data-driven definitions: the JSON schemas under data/defs/**.
 *
 * Rules:
 *  - SI units; angles in DEGREES in data files (field names end in `Deg`), radians everywhere in code.
 *  - Ids are lower-kebab strings. Cross references are by id and resolved after all files are loaded.
 *  - Nothing in the engine may reference a specific body, vehicle, part or site id. Adding a planet,
 *    moon, vehicle or launch site means adding files under data/defs (and baked tiles), never engine code.
 *  - A value of the form { "$ref": "relative/path.json", "optional"?: true } is replaced by that file's
 *    content at load (see src/core/defs/loader.ts). This lets one definition be assembled from sections
 *    with different owners (e.g. a body's physical constants vs. its atmosphere look).
 */
import type { SwellComponent } from '../geo/oceanSwell';
import type { Vec3Tuple } from '../math/vec3';

export type BodyId = string;
export type PartDefId = string;
export type VehicleId = string;
export type SiteId = string;
export type ResourceId = string;
export type ScenarioId = string;

// ----------------------------------------------------------------------------------------------- bodies

export interface KeplerOrbitDef {
  kind: 'kepler';
  /** Reference plane of the elements. 'ecliptic' elements are rotated by the J2000 obliquity at load. */
  frame: 'ecliptic' | 'parentEquator';
  a: number;
  e: number;
  iDeg: number;
  lanDeg: number;
  argPeDeg: number;
  meanAnomalyDeg: number;
  epochUt: number;
}
/** Direction + distance of the root body's star (Astronomical Almanac low-precision Sun). No gravity. */
export interface SunLowPrecisionOrbitDef {
  kind: 'sunLowPrecision';
}
export type OrbitDef = KeplerOrbitDef | SunLowPrecisionOrbitDef;

export type RotationDef =
  | { mode: 'fixedRate'; poleRaDeg: number; poleDecDeg: number; w0Deg: number; rateDegPerDay: number; epochUt: number }
  | { mode: 'tidalLock'; poleRaDeg: number; poleDecDeg: number }
  | { mode: 'none' };

export interface AtmosphereHeatingDef {
  /** Sutton-Graves constant k in q = k sqrt(rho / Rn) V^3 (SI). */
  kConv: number;
  /**
   * Tauber-Sutton style radiative heating; null disables.
   *   q_rad = kRad * c * Rn^a * rho^rhoExp * f(V)   [W/m^2],   zero below vMin
   *   a = min(aMax, aCoef * V^aVExp * rho^aRhoExp);  f(V) by linear interpolation of fTable ([V m/s, f]).
   */
  radiative: null | {
    c: number;
    rhoExp: number;
    kRad: number;
    vMin: number;
    aCoef: number;
    aVExp: number;
    aRhoExp: number;
    aMax: number;
    fTable: [number, number][];
  };
}

/** Physical atmosphere used by the simulation (drag, heating, engine back-pressure, sound). */
export interface AtmosphereDef {
  model: 'ussa76' | 'table' | 'exponential';
  /** model 'table': rows of altitude km, density kg/m^3, pressure Pa, temperature K. */
  table?: { hKm: number; rho: number; p: number; T: number }[];
  /** model 'exponential'. */
  rho0?: number;
  p0?: number;
  scaleHeight?: number;
  temperature?: number;
  /** Altitude (m) above which the vessel may go on rails; density is faded to zero just below it. */
  simTop: number;
  gamma: number;
  /** Specific gas constant, J/(kg K). */
  gasConstant: number;
  heating: AtmosphereHeatingDef;
}

export interface OceanDef {
  /** kg/m^3 */
  density: number;
  /** Sea surface height above the reference radius, m. */
  seaLevel: number;
  /** Long-wave swell shared by buoyancy physics and the renderer (src/core/geo/oceanSwell.ts). */
  swell: SwellComponent[];
}

export type TerrainModifier = {
  kind: 'flattenDisc';
  latDeg: number;
  lonDeg: number;
  /** Inside this radius (m) the height equals `elevation`. */
  flatRadius: number;
  /** Smoothstep back to natural terrain between flatRadius and blendRadius (m). */
  blendRadius: number;
  /** Metres above the reference radius, or 'sample' = natural terrain height at the disc centre. */
  elevation: number | 'sample';
};

/** Procedural amplification below data resolution. `model` selects a registered generator in src/terrain. */
export interface TerrainAmplificationDef {
  model: string;
  seed: number;
  params: Record<string, number>;
}

export interface BodyTerrainDef {
  /** Tile set id: tiles live under /tiles/{tileset}/ with /tiles/{tileset}/manifest.json. */
  tileset: string;
  maxElevation: number;
  minElevation: number;
  /** Deepest quadtree level the renderer subdivides to (beyond data: procedural). */
  maxRenderLevel: number;
  modifiers: TerrainModifier[];
  surfaceFriction: number;
  amplification: TerrainAmplificationDef;
}

/** Light source parameters for a star. */
export interface StarEmissionDef {
  /** Photosphere radius, m. */
  radius: number;
  /** Illuminance (lux) received at `refDistance` metres. */
  illuminance: number;
  refDistance: number;
  /** Linear-sRGB colour normalised to luminance 1. */
  color: Vec3Tuple;
  /** Per-channel linear limb-darkening coefficients u in I(mu) = 1 - u (1 - mu). */
  limbDarkening: Vec3Tuple;
}

// Render-side body sections (opaque to the simulation). Each is its own file referenced by $ref.

export interface AtmosphereRenderDef {
  /** Top of the scattering shell above the reference radius, m. */
  topAltitude: number;
  rayleighScattering: Vec3Tuple;
  rayleighScaleHeight: number;
  mieScattering: number;
  mieAbsorption: number;
  mieScaleHeight: number;
  miePhaseG: number;
  ozoneAbsorption: Vec3Tuple;
  ozoneCenterAltitude: number;
  ozoneHalfWidth: number;
  groundAlbedo: number;
}

export interface CloudRenderDef {
  /** Global maps under the tile set's `globals` (see TileManifest.globals). */
  coverageMap: string;
  bottomAltitude: number;
  topAltitude: number;
  /** Free-form tunables owned by the cloud renderer. */
  params: Record<string, number>;
}

export interface OceanRenderDef {
  /** Wind speed at 10 m, m/s (drives the FFT spectrum and the Cox-Munk glint width). */
  windSpeed: number;
  windDirDeg: number;
  /** Absorption per metre, linear RGB. */
  absorption: Vec3Tuple;
  params: Record<string, number>;
}

export interface SurfaceRenderDef {
  brdf: 'terrain' | 'hapke';
  /** Hapke parameters when brdf = 'hapke'. */
  hapke?: { b0: number; hS: number; bP: number; cP: number };
  /** Detail material set id (assets under public/assets/terrain/{materialSet}/). */
  materialSet: string;
  nightLights: boolean;
  params: Record<string, number>;
}

export interface BodyRenderDef {
  /** Mean visible colour of the lit disc (linear sRGB albedo); used for planetshine and far impostors. */
  meanColor: Vec3Tuple;
  /** Geometric albedo for planetshine. */
  geometricAlbedo: number;
  surface: SurfaceRenderDef | null;
  atmosphere: AtmosphereRenderDef | null;
  clouds: CloudRenderDef | null;
  ocean: OceanRenderDef | null;
}

export interface BodyDef {
  id: BodyId;
  name: string;
  /** Parent body id; null for the root body of the system. */
  parent: BodyId | null;
  /** m^3/s^2 */
  mu: number;
  /** Reference (datum) sphere radius, m. */
  radius: number;
  /** Sphere of influence radius in metres, 'auto' = a (m/M)^(2/5), null for the root body. */
  soiRadius: number | 'auto' | null;
  orbit: OrbitDef | null;
  rotation: RotationDef;
  /** 'attractor' bodies take part in patched conics; 'lightOnly' bodies only illuminate (the Sun). */
  gravityRole: 'attractor' | 'lightOnly';
  emission: StarEmissionDef | null;
  atmosphere: AtmosphereDef | null;
  ocean: OceanDef | null;
  terrain: BodyTerrainDef | null;
  /** Lowest allowed altitude (m) for each rails warp level (see WARP_LEVELS). */
  warpAltitudeLimits: number[];
  /** Navball switches between surface and orbit mode when crossing this altitude, m. */
  navballSwitchAltitude: number;
  render: BodyRenderDef;
}

// ------------------------------------------------------------------------------------------ launch sites

export interface SiteLocationDef {
  latDeg: number;
  lonDeg: number;
  /** Pad surface elevation above the reference radius, m; 'terrain' = natural height at the pad centre. */
  padElevation: number | 'terrain';
}

export interface LaunchSiteDef {
  id: SiteId;
  name: string;
  bodyId: BodyId;
  /** Resolved coordinates (written by the site-resolve bake tool so the pad sits on real, flat, dry terrain). */
  location: SiteLocationDef;
  /** Compass direction (deg, clockwise from north) that the vessel's ventral side (-Z) faces on the pad. */
  padAzimuthDeg: number;
  pad: { flatRadius: number; blendRadius: number; clampHeight: number };
  /** Static structures: procedural model generator id + placement in the pad's east/north/up frame (m). */
  structures: { model: string; offsetEnu: Vec3Tuple; headingDeg: number; params?: Record<string, number | string> }[];
  recoveryZones: { name: string; latDeg: number; lonDeg: number; radiusKm: number }[];
}

// --------------------------------------------------------------------------------------------- resources

export interface ResourceDef {
  id: ResourceId;
  name: string;
  /** kg/m^3 */
  density: number;
}

// ------------------------------------------------------------------------------------------------- parts

export type MachTable = [number, number][];

export type AeroElementDef =
  | {
      kind: 'axisymBody';
      refArea: number;
      length: number;
      diameter: number;
      cdAxialFwd: MachTable;
      cdAxialAft: MachTable;
      cdCross: number;
      cpFraction: number;
    }
  | { kind: 'bluntCapsule'; refArea: number; diameter: number; cdTable: MachTable; cn: number; cmAlpha: number; cmq: number; refPoint: Vec3Tuple }
  | { kind: 'flatPlate'; area: number; normal: Vec3Tuple; pos: Vec3Tuple };

export interface ThermalSurfaceDef {
  area: number;
  normal: Vec3Tuple | 'axisym';
  noseRadius: number;
  emissivity: number;
  /** J/(m^2 K) */
  arealHeatCapacity: number;
  /** K */
  maxTemp: number;
}

/**
 * A contact probe of a part (part frame). On a part with a `legs` module, `PartDef.contactPoints[i]`
 * describes the FOOT PAD of leg `i` (`radius`, `mu`, `crashTolerance`; `pos` repeats that leg's
 * `footDeployed`) and is not a structural probe: the engine adds one probe at each leg hinge itself. The
 * lateral touchdown limit of a foot pad is 0.625 x `crashTolerance`. On every other part the points are
 * structural probes; where they are missing, empty, or leave an end face of `PartDef.bounds` uncovered, the
 * engine derives probes from `bounds` there.
 */
export interface ContactPointDef {
  pos: Vec3Tuple;
  radius: number;
  k?: number;
  c?: number;
  mu?: number;
  /** m/s normal closing speed above which the part is destroyed. */
  crashTolerance: number;
  /** Separate tolerance for water entry, m/s. */
  crashToleranceWater?: number;
}

export interface NozzleDef {
  pos: Vec3Tuple;
  /** Unit exhaust direction in the part frame (thrust acts opposite). */
  dir: Vec3Tuple;
  exitDiameter: number;
  /** Nozzle exit static pressure at full throttle, Pa. */
  exitPressure: number;
}

export interface ParachuteEnvelope {
  maxAlt?: number;
  maxMach?: number;
  maxSpeed?: number;
  maxQ: number;
}

export type StageAction =
  | { kind: 'igniteEngines'; parts: string[] }
  | { kind: 'shutdownEngines'; parts: string[] }
  | { kind: 'releaseClamps'; parts: string[]; minThrustToWeight?: number }
  /** Cuts the joint between the named part (instance id; it carries a `decoupler` module) and its PARENT. */
  | { kind: 'decouple'; part: string }
  | { kind: 'fireSeparationMotors'; parts: string[] }
  | { kind: 'jettisonFairing'; part: string }
  /** Cuts the joint between the named part (the escape tower, with its `decoupler` module) and its PARENT. */
  | { kind: 'jettisonLES'; part: string }
  | { kind: 'deployParachute'; parts: string[]; mode: 'drogue' | 'main' }
  | { kind: 'cutParachute'; parts: string[] }
  | { kind: 'deployLegs'; parts: string[] }
  | { kind: 'enableRcs'; parts: string[] };

export type TimedStageAction = StageAction & { delay?: number };

export type ModuleDef =
  | {
      type: 'command';
      crewCapacity: number;
      sas: boolean;
      maxRateDegPerS: number;
      seats: { id: string; pos: Vec3Tuple; lookDir: Vec3Tuple; upDir: Vec3Tuple }[];
      /** Hatch for future EVA: position and outward direction in the part frame. */
      hatch?: { pos: Vec3Tuple; dir: Vec3Tuple };
    }
  | {
      type: 'engine';
      thrustVac: number;
      ispVac: number;
      ispSL: number;
      /** Fraction of full thrust at the lowest stable throttle (ignored when throttleable = false). */
      minThrottle: number;
      throttleable: boolean;
      spoolUp: number;
      spoolDown: number;
      maxIgnitions: number | null;
      propellants: { resource: ResourceId; ratio: number }[];
      nozzles: NozzleDef[];
      gimbal?: { rangeDeg: number; rateDegPerS: number };
      /** Solid / fixed-duration motors (LES, separation, ullage). */
      fixedBurn?: { duration: number };
      /** Chamber pressure, Pa (plume shock-cell model). */
      chamberPressure: number;
      /** Plume look id (data/defs/visuals/plumes.json) and sound profile id (data/defs/audio/engines.json). */
      plume: string;
      sound: string;
    }
  | {
      type: 'rcs';
      /**
       * `dir` = unit EXHAUST direction in the part frame; the thrust (N) acts opposite, at `pos`. Same
       * meaning as `NozzleDef.dir`, so plumes are drawn along `dir` for engines and thrusters alike.
       */
      thrusters: { pos: Vec3Tuple; dir: Vec3Tuple; thrust: number }[];
      isp: number;
      resource: ResourceId;
    }
  | { type: 'reactionWheel'; torque: Vec3Tuple }
  | {
      type: 'decoupler';
      /**
       * Separation impulse, N s. When the part is decoupled (`StageAction` 'decouple' / 'jettisonLES') the
       * joint between this part and its PARENT is cut; the impulse acts along this part's Y axis, equal and
       * opposite on the two sides.
       */
      impulse: number;
      /** Height (y in this part's frame, m) of the plane the two sides part at. */
      separationPlaneY: number;
    }
  | {
      type: 'fairing';
      panels: number;
      /** Separation impulse per panel, N s. */
      impulse: number;
      /** Parts the closed fairing shields from the airflow: each entry matches a part's instance id OR its def id. */
      shields: string[];
    }
  | { type: 'launchClamp' }
  | { type: 'les' }
  | {
      type: 'legs';
      /**
       * Pad radius, friction and crash tolerance of leg `i` are `PartDef.contactPoints[i]` (see
       * `ContactPointDef`); `stroke` (m), `k` (N/m), `c` (N s/m) and `preload` (N) describe the strut.
       */
      legs: { hinge: Vec3Tuple; footDeployed: Vec3Tuple; footStowed: Vec3Tuple; stroke: number; k: number; c: number; preload: number }[];
      deployTime: number;
    }
  | {
      type: 'parachute';
      mode: 'drogue' | 'main';
      count: number;
      /** Drag area Cd*A of ONE canopy fully open, m^2. */
      cdAFull: number;
      reefStages: { fraction: number; duration: number }[];
      fullInflateTime: number;
      safe: ParachuteEnvelope;
      destroy: ParachuteEnvelope;
      attach: Vec3Tuple;
      lineLength: number;
      canopyDiameter: number;
    }
  | { type: 'heatShield'; ablatorResource: ResourceId; area: number; qThreshold: number; heff: number; conductFraction: number }
  | { type: 'light'; params: Record<string, number> }
  | { type: 'antenna'; params: Record<string, number> };

export type ModuleType = ModuleDef['type'];

/**
 * Outer mould line and openings of a crew capsule, shared by the simulation part (bounds, seats, hatch),
 * the exterior model (which cuts the openings) and the cockpit interior (which frames them). ONE file per
 * capsule under data/defs/visuals/shared/, owned by the lead; nobody else restates these numbers.
 * All coordinates are in the capsule part frame (+Y nose, +X starboard, +Z dorsal), metres.
 * Azimuth is measured about +Y from +Z (dorsal) toward +X (starboard), degrees.
 */
export interface CapsuleMouldLineDef {
  /** Lathe profile of the outer surface about the Y axis as [radius, y] pairs, from the shield apex upward. */
  profile: [number, number][];
  heatShield: { maxDiameter: number; maxDiameterY: number; apexY: number; radiusOfCurvature: number; shoulderRadius: number };
  /** Half-angle of the conical back shell from the Y axis, degrees, and its y range. */
  cone: { halfAngleDeg: number; yBottom: number; yTop: number; radiusTop: number };
  apexTunnel: { radius: number; yBottom: number; yTop: number };
  /** Pressure-wall + insulation thickness measured normal to the mould line, and the cabin floor height. */
  wallThickness: number;
  cabinFloorY: number;
  /** Openings on the cone: centre given by azimuth and y on the mould line; width is tangential, height along the slope. */
  windows: { id: string; azimuthDeg: number; y: number; shape: 'rect' | 'round'; width: number; height: number; cornerRadius: number }[];
  hatch: { azimuthDeg: number; y: number; width: number; height: number; cornerRadius: number; window: { radius: number } };
  /** Eye points of the seats; must equal the seats of the capsule's `command` module. */
  seats: { id: string; pos: Vec3Tuple; lookDir: Vec3Tuple; upDir: Vec3Tuple }[];
}

/** Render/audio-facing description of a part. Owned by the vehicle model team; null until authored. */
export interface PartVisualDef {
  /** Procedural mesh generator id registered in src/render/vehicle. */
  generator: string;
  params: Record<string, number | string | boolean>;
  /** Reentry shock-layer proxy: nose radius and bluntness seen by the plasma effect. */
  reentryShape?: { noseRadius: number; baseRadius: number; length: number };
}

export interface PartDef {
  id: PartDefId;
  name: string;
  category: 'command' | 'tank' | 'engine' | 'structural' | 'decoupler' | 'aero' | 'utility' | 'legs' | 'chute';
  dryMass: number;
  comOffset: Vec3Tuple;
  inertiaShape: { kind: 'solidCylinder' | 'shellCylinder' | 'cone' | 'sphere' | 'box'; r?: number; h?: number; size?: Vec3Tuple };
  /** Overall envelope used for default probes, culling and LOD: cylinder radius and y-extent in the part frame. */
  bounds: { radius: number; yMin: number; yMax: number };
  attachNodes: { id: string; pos: Vec3Tuple; dir: Vec3Tuple; size: number }[];
  resources?: { resource: ResourceId; capacity: number; tankBottomY: number; tankHeight: number }[];
  aero?: AeroElementDef[];
  thermal: { surfaces: ThermalSurfaceDef[] };
  contactPoints?: ContactPointDef[];
  buoyancy?: { pos: Vec3Tuple; radius: number }[];
  /**
   * Strength of the joint to the parent: `maxAccelG` in g; `maxQAlpha` = dynamic pressure x angle of attack
   * the joint survives, in Pa rad (the launch stack's weakest joint carries about 3 500: 6 deg at 33 kPa).
   */
  joint: { maxAccelG: number; maxQAlpha?: number };
  modules: ModuleDef[];
  visual: PartVisualDef | null;
}

// ---------------------------------------------------------------------------------------------- vehicles

export interface VehiclePartPlacement {
  /** Instance id, unique within the vehicle (referenced by stage actions). */
  id: string;
  def: PartDefId;
  parent: string | null;
  /** Attach node on the parent and on this part that are mated. */
  parentNode?: string;
  node?: string;
  /** Explicit placement for radial parts, in the parent part frame. */
  position?: Vec3Tuple;
  rotationDeg?: Vec3Tuple;
  /** Initial resource amounts in kg (default: full). */
  resources?: Record<ResourceId, number>;
  /** Propellant-flow group (parts between the same decoupler boundaries). */
  stageGroup: string;
}

export interface VehicleDef {
  id: VehicleId;
  name: string;
  parts: VehiclePartPlacement[];
  stageGroups: { id: string; label: string }[];
  /** The stage stack, fired in order by the player (index 0 first). */
  stages: { label: string; icon: string; actions: TimedStageAction[] }[];
  abort: TimedStageAction[];
  actionGroups: Record<string, StageAction[]>;
  crew: { seat: string; name: string }[];
  cameras: {
    /** Instance id of the command part and seat id the cockpit camera sits in. */
    cockpit: { part: string; seat: string };
    chase: { defaultDistance: number; minDistance: number; maxDistance: number };
  };
  /** Cockpit interior layout id (src/render/cockpit registry); null = vehicle has no cockpit view. */
  cockpit: string | null;
}

// --------------------------------------------------------------------------------------------- scenarios

export type ScenarioStart =
  | { kind: 'pad' }
  | { kind: 'orbit'; bodyId: BodyId; periapsisAltitude: number; apoapsisAltitude: number; inclinationDeg: number; lanDeg: number; argPeDeg: number; trueAnomalyDeg: number }
  | { kind: 'landed'; bodyId: BodyId; latDeg: number; lonDeg: number }
  | { kind: 'state'; bodyId: BodyId; r: Vec3Tuple; v: Vec3Tuple; attitude?: 'prograde' | 'retrograde' | 'radialOut' };

/**
 * Generic, mission-independent milestone triggers. The simulation evaluates them against the ACTIVE vessel
 * with one generic evaluator; it has no knowledge of any particular mission. A new mission is a scenario
 * file listing rules; a new kind of trigger is a new member here plus its evaluator.
 */
export type MilestoneTrigger =
  /** The vessel leaves the 'prelaunch' situation (launch clamps released). */
  | { kind: 'liftoff' }
  /** Dynamic pressure has passed its maximum during the first ascent (recorded with the peak value). */
  | { kind: 'maxQ' }
  /** Stage-stack entry `stageIndex` (0-based) has fired. */
  | { kind: 'stageFired'; stageIndex: number }
  /** Engines off, on rails or coasting, in a closed orbit about `bodyId` within the given bounds. */
  | { kind: 'orbit'; bodyId: BodyId; minPeriapsisAltitude: number; maxApoapsisAltitude?: number; maxEccentricity?: number }
  /** Engines off and the node-free predicted trajectory enters the SOI of `bodyId`. */
  | { kind: 'encounterPredicted'; bodyId: BodyId }
  | { kind: 'soiEnter'; bodyId: BodyId }
  | { kind: 'soiExit'; bodyId: BodyId }
  /** At rest on `bodyId` (landed or splashed) for `settleTime` seconds after first contact. */
  | { kind: 'touchdown'; bodyId: BodyId; surface: 'land' | 'water' | 'any'; settleTime: number }
  /** Was landed on `bodyId` and has climbed above `minAltitude` radar altitude under thrust. */
  | { kind: 'liftoffFromSurface'; bodyId: BodyId; minAltitude: number }
  /** Engines off and the predicted trajectory has a vacuum periapsis about `bodyId` within the band. */
  | { kind: 'predictedPeriapsis'; bodyId: BodyId; minAltitude: number; maxAltitude: number }
  /** Altitude above the reference radius of `bodyId` crossed in the given direction. */
  | { kind: 'altitudeCrossing'; bodyId: BodyId; altitude: number; direction: 'ascending' | 'descending' }
  | { kind: 'chuteDeployed'; mode: 'drogue' | 'main' };

export interface MilestoneRuleDef {
  /** Free-form id recorded in MilestoneRecord.id, unique within the scenario. */
  id: string;
  trigger: MilestoneTrigger;
  /** Ids that must already be recorded before this rule is armed (default: none). Each rule fires once. */
  after?: string[];
}

/**
 * A scenario places a vehicle in the world. Only `start.kind === 'pad'` with `stagesAlreadyFired === 0`
 * is a valid basis for the mission acceptance run; the other start kinds exist for training scenarios,
 * labs and visual QA and are reported in SimSnapshot.scenario so tests can tell them apart.
 */
export interface ScenarioDef {
  id: ScenarioId;
  name: string;
  vehicle: VehicleId;
  site: SiteId;
  /** Seconds since J2000.0. */
  startUt: number;
  start: ScenarioStart;
  /** Number of stage-stack entries considered already fired (their dropped parts are not spawned). */
  stagesAlreadyFired: number;
  target: BodyId | null;
  /** Landing target: becomes the SurfaceTarget of kind 'landing' (HUD, map, landingTarget readout). */
  suggestedLanding: { bodyId: BodyId; latDeg: number; lonDeg: number; name: string } | null;
  /** Milestone rules, evaluated generically by the simulation (may be empty). */
  milestones: MilestoneRuleDef[];
}

// ----------------------------------------------------------------------------------------------- library

/** Everything under data/defs, loaded and cross-validated. Keys are ids. */
export interface DefLibrary {
  bodies: Record<BodyId, BodyDef>;
  /** Id of the root body (the one with parent === null and gravityRole === 'attractor'). */
  rootBodyId: BodyId;
  sites: Record<SiteId, LaunchSiteDef>;
  resources: Record<ResourceId, ResourceDef>;
  parts: Record<PartDefId, PartDef>;
  vehicles: Record<VehicleId, VehicleDef>;
  scenarios: Record<ScenarioId, ScenarioDef>;
  /**
   * Every JSON file under the section directories `audio/` and `visuals/` (with $refs resolved), keyed by
   * its path relative to data/defs without the extension, e.g. 'audio/engines', 'visuals/plumes',
   * 'visuals/cockpits/kestrel', 'visuals/shared/kestrel-mouldline'. This is how presentation packages get
   * their own data: read with getSection()/listSections() from src/core/defs/loader.ts and validate there.
   * Nobody fetches /defs/... on their own.
   */
  sections: Record<string, unknown>;
}

/** Warp table shared by sim, UI and pilot. Indices 0..3 are physics warp; 4.. are rails warp. */
export const WARP_LEVELS = [1, 2, 3, 4, 5, 10, 50, 100, 1000, 10000, 100000] as const;
export const MAX_PHYSICS_WARP_INDEX = 3;
/** Fixed physics step, seconds. */
export const PHYSICS_DT = 1 / 120;
