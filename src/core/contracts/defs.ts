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
 *
 * v2 (MIGRATION_V2 section 4, ARCHITECTURE 8.3, 9.2, 9.3, 12). Every v2 addition is an optional field or a
 * new union member, so every existing file still loads. Fields marked @deprecated are still read and are
 * removed at the tighten step after sub-wave 3.2.
 */
import type { SwellComponent } from '../geo/oceanSwell';
import type { Vec3Tuple } from '../math/vec3';
import type { PadClass, UniverseRules } from './net';

export type BodyId = string;
export type PartDefId = string;
export type VehicleId = string;
export type SiteId = string;
export type ResourceId = string;
export type ScenarioId = string;

// ----------------------------------------------------------------------------------------------- bodies

export interface KeplerOrbitDef {
  kind: 'kepler';
  /**
   * Reference plane of the elements. 'ecliptic' elements are rotated by the J2000 obliquity at load;
   * 'parentEquator' is the plane normal to the parent's spin pole. v2: `{ pole }` is an explicit plane given
   * by its normal in ICRF (right ascension and declination, degrees): the Laplace plane of a satellite, and
   * the POSITIVE pole for a parent whose IAU spin pole is retrograde.
   */
  frame: 'ecliptic' | 'parentEquator' | { pole: { raDeg: number; decDeg: number } };
  a: number;
  e: number;
  iDeg: number;
  lanDeg: number;
  argPeDeg: number;
  meanAnomalyDeg: number;
  epochUt: number;
  /**
   * v2: secular rates per Julian century (36525 days), applied as element(ut) = element0 + rate x (ut -
   * epochUt): semi-major axis (m), eccentricity, and the three angles (degrees). Absent members are 0; an
   * orbit without `rates` is a frozen ellipse (the Moon keeps its frozen ellipse so the lunar mission's
   * windows are unchanged).
   */
  rates?: { a?: number; e?: number; iDeg?: number; lanDeg?: number; argPeDeg?: number };
  /**
   * v2: rate of the mean anomaly, degrees per day (the fitted mean motion of the source table, with the
   * periapsis rate already taken out). Absent = sqrt(mu_parent / a^3).
   */
  meanMotionDegPerDay?: number;
}
/**
 * Astronomical Almanac low-precision Sun: direction and distance of the star seen from this body. No gravity
 * by itself. v2: `inverted: true` on a planet whose parent is the star means "this body's heliocentric
 * position is minus the Almanac Sun vector": Earth keeps the formula, inverted, when the system is rooted at
 * the Sun, so the lunar mission's lighting and windows are unchanged.
 */
export interface SunLowPrecisionOrbitDef {
  kind: 'sunLowPrecision';
  inverted?: boolean;
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
  /**
   * v2: on a body without a surface (`BodyDef.surface: 'none'`), the altitude above the reference surface
   * below which a vessel is destroyed (about the 10 bar level of a giant; may be negative). Unused on a
   * body with a solid surface.
   */
  floorAltitude?: number;
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
  /** Airglow layers (request atmosphere-clouds-9); absent = none. */
  airglow?: AirglowLayerDef[];
}

/** One optically thin emitting layer of the upper atmosphere (airglow; request atmosphere-clouds-9). */
export interface AirglowLayerDef {
  /** Altitude of the emission peak above the reference radius, m. */
  altitude: number;
  /** Full width at half maximum of the (Gaussian) emission profile, m. */
  thickness: number;
  /** Luminance seen straight up from under the layer, cd/m^2. */
  zenithLuminance: number;
  /** Linear sRGB, any scale (the renderer normalises it to unit luminance). */
  color: Vec3Tuple;
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

/** One ring of a body (v2; render-only). */
export interface RingDef {
  /** Inner and outer radius in the body's equatorial plane, m. */
  innerRadius: number;
  outerRadius: number;
  /** Radial colour and opacity strip (asset id under the body's render assets). */
  texture: string;
  /** Scale applied to the optical depth read from the texture. */
  opticalDepthScale: number;
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
  /**
   * Sphere of influence radius in metres, null for the root body. 'auto' = a (m/M)^(2/5) in v1; in v2
   * (from the body-system change of wave 4) 'auto' = min(Hill radius, max(a (m/M)^(2/5), 2.5 x radius)), so
   * the smallest moons keep a usable sphere.
   */
  soiRadius: number | 'auto' | null;
  orbit: OrbitDef | null;
  rotation: RotationDef;
  /**
   * 'attractor' bodies take part in patched conics; 'lightOnly' bodies only illuminate. In v2 the star is
   * the root attractor; 'lightOnly' stays valid and is unused by the shipped library.
   */
  gravityRole: 'attractor' | 'lightOnly';
  /**
   * v2: oblate spheroid (m). One `surfaceRadius(body, dirFixed)` in src/sim/bodies is used by altitude,
   * atmosphere sampling, warp limits and the bake. Absent = a sphere of `radius`.
   */
  shape?: { equatorialRadius: number; polarRadius: number };
  /** v2: 'none' = a giant with no surface (a vessel below `atmosphere.floorAltitude` is destroyed). Absent = 'solid'. */
  surface?: 'solid' | 'none';
  /** v2: rings, inner first (render-only). Absent = none. */
  rings?: RingDef[];
  emission: StarEmissionDef | null;
  atmosphere: AtmosphereDef | null;
  ocean: OceanDef | null;
  terrain: BodyTerrainDef | null;
  /**
   * Lowest allowed altitude (m) for each rails warp level (see WARP_LEVELS; RAILS_WARP_LEVEL_COUNT entries on
   * an attractor). v2: becomes OPTIONAL when the warp table grows to nine rails levels (the lead step before
   * wave 4, with the body-system change): an absent list then defaults from the radius and the atmosphere top.
   */
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
  /**
   * v2: resolved location of each pad of the site, by pad id (written by the site-resolve bake tool, like
   * the fields above, which stay the site's reference point and are the location of the first pad).
   */
  pads?: Record<string, { latDeg: number; lonDeg: number; padElevation: number | 'terrain' }>;
}

/**
 * How the height authority levels a launch site (request terrain-render-6). Without it the site is one disc:
 * flat at the pad elevation out to `pad.flatRadius`, blended back to natural terrain by `pad.blendRadius`.
 * With it the ground is EXACTLY flat only inside `coreRadius` and on the `areas` (the slabs that need level
 * ground); elsewhere inside `pad.flatRadius` the natural relief keeps the share `reliefShare` (0 = flat,
 * 1 = natural), returning fully by `pad.blendRadius`. Every blend (core, areas, the disc) has a ragged edge:
 * its far end moves in by up to the fraction `edgeNoise.amplitude` with band-limited noise of
 * `edgeNoise.wavelength` metres, so no edge is a circle or a straight line. Nothing reaches beyond
 * `pad.blendRadius`; the collision surface stays the rendered surface.
 */
export interface SitePadShapeDef {
  /** Exactly flat disc about the pad centre (the hardstand), m, and the width of its ragged blend, m. */
  coreRadius: number;
  coreBlend: number;
  /** Share of the natural relief kept inside `pad.flatRadius` outside the core and the areas, 0..1. */
  reliefShare: number;
  /**
   * Exactly flat rectangles in the pad's east/north frame (m): centre, half extents along east and north
   * before the turn, turned clockwise by `headingDeg` (compass), and the width of their ragged blend (m).
   */
  areas: { east: number; north: number; halfEast: number; halfNorth: number; headingDeg: number; blend: number }[];
  edgeNoise: { amplitude: number; wavelength: number };
}

/** A static structure of a pad: procedural model generator id + placement in the pad's east/north/up frame (m). */
export interface SiteStructureDef {
  model: string;
  offsetEnu: Vec3Tuple;
  headingDeg: number;
  params?: Record<string, number | string>;
}

/** One launch pad of a site (v2; ARCHITECTURE 9.3). The pad count is the capacity dial of the launch complex. */
export interface PadDef {
  id: string;
  name: string;
  /** Metres east / north of the site's reference point (`LaunchSiteDef.location`); the resolved coordinates are in `location.pads`. */
  offsetEnu: [number, number];
  /** Compass direction (deg, clockwise from north) that the vessel's ventral side (-Z) faces on this pad. */
  azimuthDeg: number;
  /** A pad hosts its class and anything smaller. */
  class: PadClass;
  /** Largest lift-off mass (kg) and stack diameter (m) the pad takes. */
  maxLiftoffMass: number;
  maxDiameter: number;
  /** The flatten disc of the pad: flat inside `flatRadius`, blended back to natural terrain by `blendRadius` (m); `shape` refines it as for the single pad. */
  flatRadius: number;
  blendRadius: number;
  shape?: SitePadShapeDef;
  /** Height of the launch mount above the pad surface, m (v1: `pad.clampHeight`). */
  mountHeight: number;
  /** Nothing unheld may be inside this radius at a spawn, and wreckage inside it is removed at safing, m. Absent = the rules' value for the class. */
  keepOutRadius?: number;
  structures: SiteStructureDef[];
}

export interface LaunchSiteDef {
  id: SiteId;
  name: string;
  bodyId: BodyId;
  /** Resolved coordinates (written by the site-resolve bake tool so the pad sits on real, flat, dry terrain). */
  location: SiteLocationDef;
  /**
   * v2: the pads of the site. Optional until MIGRATION_V2 step 3.6 writes them (the loader then exposes the
   * deprecated single pad as `pads[0]`); required from the tighten step. Flatten-disc terrain modifiers are
   * derived from the pads at load.
   */
  pads?: PadDef[];
  /** @deprecated Use `pads[].azimuthDeg`. Compass direction (deg, clockwise from north) that the vessel's ventral side (-Z) faces on the pad. */
  padAzimuthDeg: number;
  /** @deprecated Use `pads[]` (`flatRadius`, `blendRadius`, `mountHeight`, `shape`). */
  pad: { flatRadius: number; blendRadius: number; clampHeight: number; shape?: SitePadShapeDef };
  /** @deprecated Use `pads[].structures`. Static structures of the single pad. */
  structures: SiteStructureDef[];
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
  | { kind: 'enableRcs'; parts: string[] }
  /** v2: releases the docked joint of the named port part (instance id), so a pre-mated pair can be released from a stage stack. */
  | { kind: 'undock'; part: string };

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
      /** v2: command authority with no crew aboard (uncrewed craft). Absent = false. */
      remote?: boolean;
      /**
       * v2: cockpit interior layout id of THIS command part (src/render/cockpit registry); null or absent = no
       * cabin, the first-person view is the sensor camera. `VehicleDef.cockpit` remains as an authoring
       * convenience that the assembler copies here; consumers read the command part.
       */
      cockpit?: string | null;
      /** v2: where the sensor camera sits on a command part without a cabin (part frame). Absent = derived from the part's nose. */
      sensorCamera?: { pos: Vec3Tuple; lookDir: Vec3Tuple; upDir: Vec3Tuple };
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

/**
 * v2: a docking port (ARCHITECTURE 7.5). The part carries an attach node of kind 'dock'.
 *
 * Not yet a member of `ModuleDef`: the assembler creates one module state per `ModuleDef` member
 * (src/sim/vessel/assemble.ts), so the lead joins this type to `ModuleDef` (and `DockingPortState` to
 * `ModuleState`, sim.ts) in the lead step before wave 4.1, when the first port parts are written.
 */
export type DockingPortModuleDef = {
  type: 'dockingPort';
  /** Id of the attach node (kind 'dock') that is the mating face. */
  node: string;
  /** Ports mate only with the same type (an adapter part joins two types). */
  portType: string;
  gender: 'androgynous' | 'active' | 'passive';
  /**
   * Capture envelope, measured between the two port frames when the faces come within `range` (m):
   * lateral offset (m), misalignment and roll to the nearest step (deg; `rollStepDeg` 0 = any roll),
   * closing speed band (m/s), lateral speed (m/s), relative rate (deg/s).
   */
  capture: { range: number; maxLateral: number; maxAngleDeg: number; maxRollDeg: number; rollStepDeg: number; minClosing: number; maxClosing: number; maxLateralSpeed: number; maxRateDegPerS: number };
  /** Soft capture: a compliant six-axis constraint (natural frequency Hz, damping ratio), clamped at these loads (N, N m), retracting at `retractRate` m/s, given up after `timeout` s. */
  soft: { frequencyHz: number; damping: number; maxForce: number; maxTorque: number; retractRate: number; timeout: number };
  /** Strength of the docked joint, N and N m. */
  hard: { maxForce: number; maxTorque: number };
  /** Spring impulse at undock, N s, equal and opposite on the two sides. */
  undockImpulse: number;
  /** What may pass through the docked port: crew, the listed resources, at most `maxRate` kg/s. */
  transfer: { crew: boolean; resources: ResourceId[]; maxRate: number };
};

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

/** A convex collision piece of a part, in the part frame (v2; ARCHITECTURE 7.4). */
export type CollisionShapeDef =
  | { kind: 'cylinder'; radius: number; yMin: number; yMax: number }
  /** A cone frustum about the Y axis (capsule side wall, engine bell). */
  | { kind: 'frustum'; r0: number; y0: number; r1: number; y1: number }
  /** A swept sphere between two points (struts, legs, booms). */
  | { kind: 'capsule'; a: Vec3Tuple; b: Vec3Tuple; radius: number }
  | { kind: 'box'; centre: Vec3Tuple; size: Vec3Tuple; rotationDeg?: Vec3Tuple }
  /** Convex hull of at most 32 points. */
  | { kind: 'hull'; points: Vec3Tuple[] }
  /** A hollow ring about the Y axis, expanded into `segments` wedges (interstages, adapters). */
  | { kind: 'shell'; rInner: number; rOuter: number; yMin: number; yMax: number; segments: number };

export interface PartDef {
  id: PartDefId;
  name: string;
  /** v2 adds 'dock' and 'habitat'. Part, module and resource ids are never removed or renumbered, only deprecated. */
  category: 'command' | 'tank' | 'engine' | 'structural' | 'decoupler' | 'aero' | 'utility' | 'legs' | 'chute' | 'dock' | 'habitat';
  dryMass: number;
  comOffset: Vec3Tuple;
  inertiaShape: { kind: 'solidCylinder' | 'shellCylinder' | 'cone' | 'sphere' | 'box'; r?: number; h?: number; size?: Vec3Tuple };
  /** Overall envelope used for default probes, culling and LOD: cylinder radius and y-extent in the part frame. */
  bounds: { radius: number; yMin: number; yMax: number };
  /**
   * Attach nodes. `size` is the interface diameter, m. v2: `kind` (default 'stack'; 'mount' = an engine or
   * utility mount inside a parent; 'dock' = the mating face of a docking port) and `rollStepDeg` (builder
   * snapping; 0 or absent = free).
   */
  attachNodes: { id: string; pos: Vec3Tuple; dir: Vec3Tuple; size: number; kind?: 'stack' | 'mount' | 'dock'; rollStepDeg?: number }[];
  /**
   * v2: radial attachment. `attachable`: this part may sit on another part's skin, touching it at `pos` with
   * outward direction `dir` (part frame); `accepts`: other parts may sit on this part's skin.
   */
  surfaceAttach?: { attachable: boolean; pos: Vec3Tuple; dir: Vec3Tuple; accepts: boolean };
  /** v2: builder hint only (how many radial copies make sense; whether a mirrored pair does). */
  symmetry?: { maxRadial: number; mirror: boolean };
  /** v2: authored collision pieces, only where the `bounds` cylinder is badly wrong. Absent = derived from `bounds` (and from the legs and fairing data) as the clearance query does. */
  collision?: CollisionShapeDef[];
  /** v2: propellant may flow through this part between its neighbours. Absent = true; false on decouplers and docking ports. */
  crossfeed?: boolean;
  /** v2: normal closing speed (m/s) above which a vessel-to-vessel contact destroys the part. Absent = the lowest `crashTolerance` of its contact points; a part with neither takes the rules' `contact.defaultCrashTolerance`. */
  crashTolerance?: number;
  /** Tanks. v2: `transferable` (absent = true) is false for resources that cannot be pumped (ablator, solid propellant). */
  resources?: { resource: ResourceId; capacity: number; tankBottomY: number; tankHeight: number; transferable?: boolean }[];
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
  /** v2: builder metadata only (each instance is still listed with its own pose). */
  symmetry?: { group: string; index: number; count: number; mode: 'radial' | 'mirror' };
}

/** A sub-assembly include of a vehicle (v2), flattened into `parts` / `stages` by the loader. */
export interface VehicleUseDef {
  /** Id of data/defs/assemblies/<id>.json. */
  assembly: string;
  /** Instance ids of its parts become '<prefix>-<id>'. */
  prefix: string;
  /** Where the assembly's root part attaches (instance id after prefixing, or null for the vehicle's root). */
  parent: string | null;
  parentNode?: string;
  node?: string;
  /** Per-part load overrides (off-loaded tanks), kg: prefixed instance id -> resource id -> kg. */
  resources?: Record<string, Record<ResourceId, number>>;
}

/**
 * A launcher or spacecraft sub-assembly (v2; data/defs/assemblies/<id>.json): the same fields as a vehicle.
 * The loader concatenates the stage stacks in the order of `VehicleDef.uses` (launcher first), prefixes
 * ids, checks uniqueness and hands the simulation an ordinary flat VehicleDef.
 */
export interface AssemblyDef {
  id: string;
  name: string;
  parts: VehiclePartPlacement[];
  stageGroups: { id: string; label: string }[];
  stages: { label: string; icon: string; actions: TimedStageAction[] }[];
  abort: TimedStageAction[];
  actionGroups: Record<string, StageAction[]>;
}

export interface VehicleDef {
  id: VehicleId;
  name: string;
  /**
   * The flat part graph: the only thing the simulation reads. Two docking ports may be mated in the file
   * (`node` and `parentNode` both of kind 'dock'): the assembler records that joint as a dock link, so the
   * craft can undock it in flight.
   */
  parts: VehiclePartPlacement[];
  /** v2: sub-assemblies, flattened into `parts`, `stageGroups` and `stages` by the loader. */
  uses?: VehicleUseDef[];
  /** v2: what a pad needs to know: the class, the umbilical heights (y in the root part frame, m, with the stack radius there) and the crew arm. */
  padInterface?: { class: PadClass; umbilicals: { y: number; radius: number }[]; crewArm?: { y: number; reach: number } };
  stageGroups: { id: string; label: string }[];
  /** The stage stack, fired in order by the player (index 0 first). */
  stages: { label: string; icon: string; actions: TimedStageAction[] }[];
  abort: TimedStageAction[];
  actionGroups: Record<string, StageAction[]>;
  crew: { seat: string; name: string }[];
  cameras: {
    /**
     * Instance id of the command part and seat id the cockpit camera sits in. v2: an authoring convenience
     * that the assembler copies onto the command part; it becomes OPTIONAL at the tighten step after
     * sub-wave 3.2 (uncrewed vehicles have none), so consumers read the viewer's own command part instead.
     */
    cockpit: { part: string; seat: string };
    chase: { defaultDistance: number; minDistance: number; maxDistance: number };
  };
  /**
   * Cockpit interior layout id (src/render/cockpit registry); null = vehicle has no cockpit view. v2: an
   * authoring convenience copied onto the command part (`command.cockpit`), which is what consumers read.
   */
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
  /**
   * What the HUD announces when the milestone is reached, in the scenario author's words ("TLI complete");
   * absent = worded from the trigger and the definitions' names (request flight-ui-5). Non-empty when present.
   */
  title?: string;
  trigger: MilestoneTrigger;
  /** Ids that must already be recorded before this rule is armed (default: none). Each rule fires once. */
  after?: string[];
}

/**
 * A scenario places a vehicle in the world. Only `start.kind === 'pad'` with `stagesAlreadyFired === 0`
 * is a valid basis for the mission acceptance run; the other start kinds exist for training scenarios,
 * labs and visual QA and are reported in SimSnapshot.scenario so tests can tell them apart.
 *
 * v2 (ARCHITECTURE 7.7): a scenario is a SPAWN RECIPE (vehicle, site and pad, start kind, stages already
 * fired) plus an OPTIONAL list of objectives (`milestones`), attached to one craft and evaluated by the
 * universe's milestone observer. A local scenario also fixes the local universe's epoch (`startUt`). No
 * vehicle is tied to a mission.
 */
export interface ScenarioDef {
  id: ScenarioId;
  name: string;
  vehicle: VehicleId;
  site: SiteId;
  /** v2: id of the pad of `site` the vehicle starts on (`PadDef.id`). Absent = the site's first pad. */
  pad?: string;
  /** Seconds since J2000.0. v2: on the tick grid (a whole number of 1/120 s) from MIGRATION_V2 step 3.1. */
  startUt: number;
  start: ScenarioStart;
  /** Number of stage-stack entries considered already fired (their dropped parts are not spawned). */
  stagesAlreadyFired: number;
  /**
   * Resource amounts at the start, kg: part instance id (VehicleDef.parts[].id) -> resource id -> kg.
   * Overrides the vehicle's own amounts (VehiclePartPlacement.resources, default full) for the parts and
   * resources listed; everything not listed keeps the vehicle's amount. Entries for parts that
   * `stagesAlreadyFired` has already dropped are ignored. The loader checks that every part is one of the
   * scenario's vehicle, that it holds the resource, and that 0 <= kg <= capacity (request sim-world-pilot-1).
   */
  resources?: Record<string, Record<ResourceId, number>>;
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
  /** v2: sub-assemblies by id (data/defs/assemblies). Optional until the loader fills it (wave 4, with `VehicleDef.uses`); absent = none. */
  assemblies?: Record<string, AssemblyDef>;
  /** v2: rules documents by id (data/defs/rules: 'default', 'staging', 'local'). Optional until the loader fills it (MIGRATION_V2 step 3.6); absent = none. */
  rules?: Record<string, UniverseRules>;
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

/**
 * Warp table shared by sim, UI and pilot. Indices 0..3 are physics warp; 4.. are rails warp.
 *
 * v2 (decision 40) adds 1,000,000x and 10,000,000x (nine rails levels). They are NOT in the table yet: the
 * body system requires one `warpAltitudeLimits` entry per rails level and the shipped bodies list seven, so
 * the two levels are added by the lead together with the body-system change of wave 4 (optional limits that
 * default from the radius), never alone. Code must use RAILS_WARP_LEVEL_COUNT and `WARP_LEVELS.length`,
 * never a literal count.
 */
export const WARP_LEVELS = [1, 2, 3, 4, 5, 10, 50, 100, 1000, 10000, 100000] as const;
export const MAX_PHYSICS_WARP_INDEX = 3;
/** Number of rails warp levels (entries of an attractor's `warpAltitudeLimits`). */
export const RAILS_WARP_LEVEL_COUNT = WARP_LEVELS.length - MAX_PHYSICS_WARP_INDEX - 1;
/** Fixed physics step, seconds. */
export const PHYSICS_DT = 1 / 120;
