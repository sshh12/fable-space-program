/**
 * The vfx data section: data/defs/visuals/plumes.json, read through `getSection(defs, 'visuals/plumes')`
 * and validated here against a schema (every error names the file and the JSON path).
 *
 * Nothing in src/render/vfx names an engine, a vehicle or a site: engines refer to their look by the
 * `plume` id of their module, sites to their flame trench by a structure model id listed in this file.
 */
import type { DefLibrary, ModuleDef } from '@/core/contracts/defs';
import { DefError, getSection } from '@/core/defs/loader';
import type { Vec3Tuple } from '@/core/math';

export const VFX_SECTION = 'visuals/plumes';
const FILE = `${VFX_SECTION}.json`;

export type Range = [number, number];

/** One engine look (keyed by the `plume` id of engine modules). */
export interface PlumeLookDef {
  /** Ratio of specific heats of the exhaust gas. */
  gamma: number;
  /** Wall angle of the nozzle at its exit, deg (added to the Prandtl-Meyer turn at the lip). */
  nozzleHalfAngleDeg: number;
  core: {
    color: Vec3Tuple;
    /** Luminance of the jet seen side-on through the exit diameter at full throttle, cd/m^2. */
    luminance: number;
    /** e-folding length of the core emission in the atmosphere / in vacuum, exit radii. */
    lengthRe: number;
    vacuumLengthRe: number;
    /** Radius of the luminous core as a fraction of the jet boundary. */
    radius: number;
    /** Emission ~ (relative gas density)^exponent. */
    densityExponent: number;
  };
  /** Shock cells: colour shift towards `color` and emission gain at a Mach disc, e-folding count of cells. */
  diamonds: { color: Vec3Tuple; gain: number; cells: number };
  /** Afterburning mixing layer at the jet boundary (needs ambient air: scaled by pressure). */
  shear: { color: Vec3Tuple; luminance: number; lengthRe: number };
  /** Turbulent flame brush downstream of the potential core (needs ambient air). */
  afterburn: { color: Vec3Tuple; luminance: number; lengthRe: number };
  /** Particulates: optical depth across the exit diameter (extinction, and the part that scatters sunlight). */
  smoke: { extinction: number; albedo: Vec3Tuple; sunScatter: number };
  /** Turbulent break-up: feature size in exit radii, convection speed m/s, strength 0..1. */
  noise: { scaleRe: number; speed: number; amount: number };
  ignition: { frontSpeed: number; flash: number; flashColor: Vec3Tuple; flashTime: number };
  shutdown: { fadeTime: number };
  /** Local light: luminous intensity per newton of thrust (cd/N) and colour. */
  light: { efficacy: number; color: Vec3Tuple };
  /** What the exhaust leaves behind in air: particulate smoke and condensation, 0..1 each. */
  trail: { smoke: number; contrail: number };
  /** Surface interaction weights: pad smoke source and dust erosion. */
  ground: { smoke: number; dust: number };
}

export interface CanopyStyleDef {
  gores: number;
  rings: number;
  /** Open fraction of each ring's width (slots between rings / crescent gaps of the sails). */
  slotFraction: number;
  /** Vent radius as a fraction of the gore length. */
  ventFraction: number;
  /** Gore length (vent to skirt along the cloth) over the inflated projected radius. */
  goreLengthRatio: number;
  /** Part of ParachuteDef.lineLength taken by the suspension lines (the rest is the riser). */
  suspensionFraction: number;
  /** Suspension line diameter, m. */
  lineWidth: number;
  colors: Vec3Tuple[];
  /** Index into `colors` per gore, repeated around the canopy. */
  pattern: number[];
  bandColor: Vec3Tuple;
  translucency: number;
  roughness: number;
  /** Distance between neighbouring canopy axes in a cluster, in inflated diameters. */
  clusterGap: number;
  /** Radius of the streaming (not yet inflated) canopy as a fraction of the inflated radius. */
  streamRadius: number;
}

export interface VfxData {
  version: number;
  plumes: Record<string, PlumeLookDef>;
  rcs: { plume: string; exitDiameterPerSqrtNewton: number; exitPressure: number; chamberPressure: number; minLevel: number; puffRate: number };
  lights: { maxLights: number; rangeIlluminance: number; maxRange: number; minIntensity: number };
  trail: {
    maxNodes: number;
    maxTrails: number;
    nodeInterval: number;
    nodeMinSpacing: number;
    initialRadiusRe: number;
    expansionSpeed: number;
    expansionTime: number;
    diffusivity: number;
    smokeLifetime: number;
    contrailLifetime: number;
    contrailTemperature: Range;
    contrailPressure: Range;
    minPressure: number;
    smokeOpticalDepth: number;
    contrailOpticalDepth: number;
    smokeAlbedo: Vec3Tuple;
    contrailAlbedo: Vec3Tuple;
    glowLifetime: number;
    noiseScale: number;
    noiseAmount: number;
  };
  padSmoke: {
    trenchModels: string[];
    activationRange: number;
    plumeReach: number;
    grid: Vec3Tuple;
    halfExtent: number;
    height: number;
    centerCell: number;
    bottomCell: number;
    jetSpeed: number;
    jetRadius: number;
    trenchFocus: number;
    trenchLength: number;
    buoyancy: number;
    cooling: number;
    turbulence: number;
    wind: { headingDeg: number; speed: number };
    dissipation: number;
    smokeRate: number;
    steamRate: number;
    deluge: { duration: number; ramp: number };
    smoke: { albedo: Vec3Tuple; extinction: number };
    steam: { albedo: Vec3Tuple; extinction: number };
    steps: number;
    erosion: number;
    erosionScale: number;
  };
  particles: {
    pool: number;
    maxSpawnPerFrame: number;
    dust: { maxHeightRe: number; rate: number; speed: Range; elevationDeg: Range; life: Range; size: Range; albedo: Vec3Tuple; opacity: number };
    ice: { liftoffCount: number; stagingCount: number; sheddingRate: number; sheddingTime: number; size: Range; life: Range; speed: Range; albedo: Vec3Tuple };
    gas: { count: number; speed: Range; size: Range; life: Range; color: Vec3Tuple; opacity: number };
    sparks: { count: number; speed: Range; size: Range; life: Range; temperature: Range };
    debris: { count: number; speed: Range; size: Range; life: Range; albedo: Vec3Tuple };
    spray: { count: number; mistCount: number; size: Range; mistSize: Range; life: Range; albedo: Vec3Tuple; opacity: number };
    ablation: { rate: number; speed: Range; size: Range; life: Range; temperature: Range };
  };
  frost: { resources: string[]; vibrationThrottle: number };
  staging: { flashIntensity: number; flashTime: number; flashColor: Vec3Tuple; puffSpeed: number };
  reentry: {
    standoff: number;
    luminance: number;
    referenceFlux: number;
    fluxExponent: number;
    minIntensity: number;
    wakeLengthRadii: number;
    colorSpeeds: Vec3Tuple;
    colors: [Vec3Tuple, Vec3Tuple, Vec3Tuple];
    flicker: { lowHz: number; highHz: number; amount: number };
    light: { efficacy: number; range: number };
    trail: { luminance: number; lifetime: number; radiusScale: number; smoke: number };
    steps: number;
  };
  explosion: {
    radiusPerCbrtJoule: number;
    minRadius: number;
    maxRadius: number;
    durationPerCbrtJoule: number;
    minDuration: number;
    luminance: number;
    flashEfficacy: number;
    flashTime: number;
    color: Vec3Tuple;
    smokeAlbedo: Vec3Tuple;
    partBurst: { energy: number; sparks: number; debris: number };
    steps: number;
  };
  parachutes: {
    drogue: CanopyStyleDef;
    main: CanopyStyleDef;
    cutDrift: { fadeTime: number; collapseTime: number; sinkSpeed: number };
    shred: { time: number; pieces: number };
  };
  splash: { crownSpeedFactor: number; crownAngleDeg: Range; minSpeed: number; foamRadiusFactor: number; foamTime: number; foamAlbedo: Vec3Tuple };
}

// ------------------------------------------------------------------------------------------- schema

/**
 * Schema notation: 'n' finite number, 'p' number > 0, 'u' number in [0, 1], 'i' positive integer,
 * 'c' linear colour (3 numbers >= 0), 'r' ascending pair of numbers, 'n3' three numbers, 's' string,
 * 'ss' non-empty string array, 'is' array of non-negative integers, 'cs' non-empty array of colours,
 * an object = nested fields (all required).
 */
type Schema = string | { [key: string]: Schema };

const LOOK: Schema = {
  gamma: 'p',
  nozzleHalfAngleDeg: 'n',
  core: { color: 'c', luminance: 'n', lengthRe: 'p', vacuumLengthRe: 'p', radius: 'p', densityExponent: 'p' },
  diamonds: { color: 'c', gain: 'n', cells: 'p' },
  shear: { color: 'c', luminance: 'n', lengthRe: 'p' },
  afterburn: { color: 'c', luminance: 'n', lengthRe: 'p' },
  smoke: { extinction: 'n', albedo: 'c', sunScatter: 'n' },
  noise: { scaleRe: 'p', speed: 'n', amount: 'u' },
  ignition: { frontSpeed: 'p', flash: 'n', flashColor: 'c', flashTime: 'p' },
  shutdown: { fadeTime: 'p' },
  light: { efficacy: 'n', color: 'c' },
  trail: { smoke: 'u', contrail: 'u' },
  ground: { smoke: 'u', dust: 'u' },
};

const CANOPY: Schema = {
  gores: 'i',
  rings: 'i',
  slotFraction: 'u',
  ventFraction: 'u',
  goreLengthRatio: 'p',
  suspensionFraction: 'u',
  lineWidth: 'p',
  colors: 'cs',
  pattern: 'is',
  bandColor: 'c',
  translucency: 'u',
  roughness: 'u',
  clusterGap: 'p',
  streamRadius: 'p',
};

const ROOT: Schema = {
  version: 'i',
  rcs: { plume: 's', exitDiameterPerSqrtNewton: 'p', exitPressure: 'p', chamberPressure: 'p', minLevel: 'u', puffRate: 'n' },
  lights: { maxLights: 'i', rangeIlluminance: 'p', maxRange: 'p', minIntensity: 'n' },
  trail: {
    maxNodes: 'i',
    maxTrails: 'i',
    nodeInterval: 'p',
    nodeMinSpacing: 'p',
    initialRadiusRe: 'p',
    expansionSpeed: 'n',
    expansionTime: 'p',
    diffusivity: 'p',
    smokeLifetime: 'p',
    contrailLifetime: 'p',
    contrailTemperature: 'r',
    contrailPressure: 'r',
    minPressure: 'n',
    smokeOpticalDepth: 'n',
    contrailOpticalDepth: 'n',
    smokeAlbedo: 'c',
    contrailAlbedo: 'c',
    glowLifetime: 'p',
    noiseScale: 'p',
    noiseAmount: 'u',
  },
  padSmoke: {
    trenchModels: 'ss',
    activationRange: 'p',
    plumeReach: 'p',
    grid: 'n3',
    halfExtent: 'p',
    height: 'p',
    centerCell: 'p',
    bottomCell: 'p',
    jetSpeed: 'p',
    jetRadius: 'p',
    trenchFocus: 'u',
    trenchLength: 'p',
    buoyancy: 'n',
    cooling: 'p',
    turbulence: 'n',
    wind: { headingDeg: 'n', speed: 'n' },
    dissipation: 'n',
    smokeRate: 'n',
    steamRate: 'n',
    deluge: { duration: 'p', ramp: 'p' },
    smoke: { albedo: 'c', extinction: 'p' },
    steam: { albedo: 'c', extinction: 'p' },
    steps: 'i',
    erosion: 'u',
    erosionScale: 'p',
  },
  particles: {
    pool: 'i',
    maxSpawnPerFrame: 'i',
    dust: { maxHeightRe: 'p', rate: 'n', speed: 'r', elevationDeg: 'r', life: 'r', size: 'r', albedo: 'c', opacity: 'u' },
    ice: { liftoffCount: 'n', stagingCount: 'n', sheddingRate: 'n', sheddingTime: 'p', size: 'r', life: 'r', speed: 'r', albedo: 'c' },
    gas: { count: 'n', speed: 'r', size: 'r', life: 'r', color: 'c', opacity: 'u' },
    sparks: { count: 'n', speed: 'r', size: 'r', life: 'r', temperature: 'r' },
    debris: { count: 'n', speed: 'r', size: 'r', life: 'r', albedo: 'c' },
    spray: { count: 'n', mistCount: 'n', size: 'r', mistSize: 'r', life: 'r', albedo: 'c', opacity: 'u' },
    ablation: { rate: 'n', speed: 'r', size: 'r', life: 'r', temperature: 'r' },
  },
  frost: { resources: 'ss', vibrationThrottle: 'u' },
  staging: { flashIntensity: 'n', flashTime: 'p', flashColor: 'c', puffSpeed: 'n' },
  reentry: {
    standoff: 'p',
    luminance: 'n',
    referenceFlux: 'p',
    fluxExponent: 'p',
    minIntensity: 'u',
    wakeLengthRadii: 'p',
    colorSpeeds: 'n3',
    colors: 'cs',
    flicker: { lowHz: 'p', highHz: 'p', amount: 'u' },
    light: { efficacy: 'n', range: 'p' },
    trail: { luminance: 'n', lifetime: 'p', radiusScale: 'p', smoke: 'n' },
    steps: 'i',
  },
  explosion: {
    radiusPerCbrtJoule: 'p',
    minRadius: 'p',
    maxRadius: 'p',
    durationPerCbrtJoule: 'p',
    minDuration: 'p',
    luminance: 'n',
    flashEfficacy: 'n',
    flashTime: 'p',
    color: 'c',
    smokeAlbedo: 'c',
    partBurst: { energy: 'p', sparks: 'n', debris: 'n' },
    steps: 'i',
  },
  parachutes: { drogue: CANOPY, main: CANOPY, cutDrift: { fadeTime: 'p', collapseTime: 'p', sinkSpeed: 'n' }, shred: { time: 'p', pieces: 'n' } },
  splash: { crownSpeedFactor: 'p', crownAngleDeg: 'r', minSpeed: 'n', foamRadiusFactor: 'p', foamTime: 'p', foamAlbedo: 'c' },
};

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const numArray = (v: unknown, n: number | null): v is number[] => Array.isArray(v) && (n === null || v.length === n) && v.every(isNum);

function fail(path: string, message: string): never {
  throw new DefError(FILE, `${path}: ${message}`);
}

function check(value: unknown, schema: Schema, path: string): void {
  if (typeof schema !== 'string') {
    if (!isObject(value)) fail(path, 'expected an object');
    for (const key of Object.keys(schema)) {
      if (!(key in value)) fail(`${path}.${key}`, 'missing');
      check(value[key], schema[key]!, `${path}.${key}`);
    }
    for (const key of Object.keys(value)) if (!(key in schema)) fail(`${path}.${key}`, 'unknown field');
    return;
  }
  switch (schema) {
    case 'n':
      if (!isNum(value)) fail(path, 'expected a finite number');
      return;
    case 'p':
      if (!isNum(value) || value <= 0) fail(path, 'expected a number > 0');
      return;
    case 'u':
      if (!isNum(value) || value < 0 || value > 1) fail(path, 'expected a number in [0, 1]');
      return;
    case 'i':
      if (!isNum(value) || !Number.isInteger(value) || value <= 0) fail(path, 'expected a positive integer');
      return;
    case 'c':
      if (!numArray(value, 3) || value.some((x) => x < 0)) fail(path, 'expected a colour [r, g, b] with components >= 0');
      return;
    case 'n3':
      if (!numArray(value, 3)) fail(path, 'expected three numbers');
      return;
    case 'r':
      if (!numArray(value, 2) || value[0]! > value[1]!) fail(path, 'expected [min, max] with min <= max');
      return;
    case 's':
      if (typeof value !== 'string' || value === '') fail(path, 'expected a non-empty string');
      return;
    case 'ss':
      if (!Array.isArray(value) || value.length === 0 || value.some((x) => typeof x !== 'string' || x === '')) fail(path, 'expected a non-empty array of strings');
      return;
    case 'is':
      if (!numArray(value, null) || value.length === 0 || value.some((x) => !Number.isInteger(x) || x < 0)) fail(path, 'expected a non-empty array of non-negative integers');
      return;
    case 'cs':
      if (!Array.isArray(value) || value.length === 0) fail(path, 'expected a non-empty array of colours');
      value.forEach((c, k) => check(c, 'c', `${path}[${k}]`));
      return;
    default:
      fail(path, `internal: unknown schema type "${schema}"`);
  }
}

/** Validate a parsed plumes.json. Throws a DefError naming the file and the JSON path of the first problem. */
export function validateVfxData(raw: unknown): VfxData {
  if (!isObject(raw)) fail('$', 'expected an object');
  const { plumes, ...rest } = raw;
  check(rest, ROOT, '$');
  if (!isObject(plumes) || Object.keys(plumes).length === 0) fail('$.plumes', 'expected a non-empty object of plume looks keyed by plume id');
  for (const [id, look] of Object.entries(plumes)) {
    check(look, LOOK, `$.plumes["${id}"]`);
    const l = look as PlumeLookDef;
    if (l.gamma <= 1 || l.gamma >= 1.67) fail(`$.plumes["${id}"].gamma`, 'expected a ratio of specific heats in (1, 1.67)');
  }
  const data = raw as unknown as VfxData;
  if (!(data.rcs.plume in data.plumes)) fail('$.rcs.plume', `unknown plume look "${data.rcs.plume}"`);
  if (data.reentry.colors.length !== 3) fail('$.reentry.colors', 'expected exactly three colours (slow, medium, fast)');
  if (!(data.reentry.colorSpeeds[0] < data.reentry.colorSpeeds[1] && data.reentry.colorSpeeds[1] < data.reentry.colorSpeeds[2])) fail('$.reentry.colorSpeeds', 'expected three ascending speeds');
  for (const kind of ['drogue', 'main'] as const) {
    const c = data.parachutes[kind];
    if (c.pattern.some((k) => k >= c.colors.length)) fail(`$.parachutes.${kind}.pattern`, 'index outside "colors"');
    if (c.gores < 6) fail(`$.parachutes.${kind}.gores`, 'expected at least 6 gores');
  }
  if (data.particles.pool > 1 << 20) fail('$.particles.pool', 'expected at most 1048576 particles');
  if (data.trail.maxNodes < 4 || data.trail.maxNodes > 256) fail('$.trail.maxNodes', 'expected 4..256');
  for (const k of [0, 1, 2] as const) if (!Number.isInteger(data.padSmoke.grid[k]) || data.padSmoke.grid[k] < 16 || data.padSmoke.grid[k] > 256) fail(`$.padSmoke.grid[${k}]`, 'expected an integer in 16..256');
  return data;
}

/**
 * Load and validate the vfx section of a definition library, and check that every engine module in the
 * library names a plume look that exists (the error names the part file).
 */
export function loadVfxData(defs: DefLibrary): VfxData {
  const data = validateVfxData(getSection<unknown>(defs, VFX_SECTION));
  for (const part of Object.values(defs.parts)) {
    part.modules.forEach((m: ModuleDef, i: number) => {
      if (m.type === 'engine' && !(m.plume in data.plumes)) {
        throw new DefError(`parts/${part.id}.json`, `modules[${i}].plume "${m.plume}" has no entry in ${FILE} ($.plumes)`);
      }
    });
  }
  return data;
}
