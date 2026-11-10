/**
 * Audio configuration: the typed form of data/defs/audio/*.json, read ONLY through DefLibrary.sections
 * (getSection) and validated here with errors that name the file and the field. The same code runs in
 * vitest against the fs def source and in the browser against the fetch source.
 */
import type { DefLibrary } from '@/core/contracts/defs';
import type { NavballState, Readouts, SimEventType, SimSnapshot, WarpState } from '@/core/contracts/sim';
import { DefError, getSection } from '@/core/defs/loader';

export type Range = readonly [number, number];

export interface AssetDef {
  file: string;
  loop: boolean;
}

export interface EngineLayerCore {
  asset: string;
  gainDb: number;
  /** Playback rate at throttle 0 and 1. */
  rate: Range;
  /** Low-pass cutoff at throttle 0 and 1, Hz. */
  cutoffHz: Range;
  /** Depth of slow random amplitude modulation (0..1). */
  turbulence: number;
}
export interface EngineLayerRumble {
  gainDb: number;
  cutoffHz: number;
  /** Cutoff is multiplied by n^-clusterExponent for a cluster of n engines (bigger = deeper). */
  clusterExponent: number;
  turbulence: number;
  turbulenceHz: number;
}
export interface BandLayer {
  gainDb: number;
  highpassHz: number;
  lowpassHz: number;
}
export interface EngineLayerCrackle {
  gainDb: number;
  /** Impulse rate at throttle 0 and 1, per second. */
  rateHz: Range;
  highpassHz: number;
  /** Level factor (nozzle ambient pressure / referencePressure)^pressureExponent: zero in vacuum. */
  pressureExponent: number;
}
export interface TransientDef {
  asset: string;
  gainDb: number;
}
export interface EngineProfile {
  refThrust: number;
  efficiencyDb: number;
  throttleExponent: number;
  /** Level drop from full throttle to the bottom of the engine's throttle range (lever 0), dB. */
  throttleRangeDb: number;
  refDistance: number;
  core: EngineLayerCore;
  rumble: EngineLayerRumble | null;
  hiss: BandLayer | null;
  crackle: EngineLayerCrackle | null;
  ignition: TransientDef | null;
  shutdown: (TransientDef & { minRunTime: number }) | null;
  body: { gainDb: number; cutoffHz: number; resonanceHz: number; resonanceDb: number };
  clusterWindow: number;
}
export interface EnginesConfig {
  level: { refThrust: number; levelDb: number };
  /** A cluster keeps its voice this long after it last sounded (no churn on brief throttle dips), s. */
  voiceHold: number;
  rcsModuleProfile: string;
  profiles: Record<string, EngineProfile>;
}

export type EventSourceKind = 'part' | 'vessel' | 'explosion' | 'listener';
export interface EventSoundDef {
  assets: string[];
  gainDb: number;
  source: EventSourceKind;
  structureBorne: boolean;
  refDistance: number;
  minInterval: number;
  maxVoices: number;
  rate: Range | null;
  match: Record<string, string | number | boolean> | null;
  variantBy: { field: string; thresholds: number[] } | null;
  scaleBy: { field: string; ref: number; exponent: number; minDb: number; maxDb: number } | null;
}
export type EventsConfig = Partial<Record<SimEventType, EventSoundDef>>;

export type AmbienceSurface = 'land' | 'water';
export const AMBIENCE_SURFACES: readonly AmbienceSurface[] = ['land', 'water'];
export interface AmbienceLayer {
  asset: string;
  gainDb: number;
}

export interface EnvironmentConfig {
  aero: {
    qRef: number;
    maxDb: number;
    refDistance: number;
    hullCutoffHz: number;
    hullGainDb: number;
    wind: { asset: string; gainDb: number; cutoffHz: Range; machForMaxCutoff: number };
    noise: { gainDb: number; bandHz: Range; bandAtMachMax: Range };
    buffet: { gainDb: number; machCenter: number; machWidth: number; cutoffHz: number; turbulence: number; turbulenceHz: number };
  };
  reentry: {
    refDistance: number;
    hullCutoffHz: number;
    hullGainDb: number;
    roar: { asset: string; gainDb: number; exponent: number };
    hiss: BandLayer & { exponent: number };
    crackle: { gainDb: number; rateHz: Range; highpassHz: number };
    rumble: { gainDb: number; cutoffHz: number; gLoadRef: number; turbulence: number; turbulenceHz: number };
  };
  ambience: {
    /** Radar altitude of the active vessel up to which the land bed is full, and above which it is silent, m. */
    surfaceAltitude: Range;
    hullGainDb: number;
    hullCutoffHz: number;
    beds: Record<AmbienceSurface, AmbienceLayer[]>;
  };
  cabin: {
    ambience: { asset: string; gainDb: number };
    airflow: { gainDb: number; bandHz: Range };
    hum: { freqHz: number; harmonics: number[]; gainDb: number };
    creaks: {
      assets: string[];
      gainDb: number;
      gMin: number;
      gMax: number;
      maxRate: number;
      jerkRate: number;
      thermalRate: number;
      gainPerG: number;
      seed: number;
      minInterval: number;
    };
  };
}

export const BUS_NAMES = ['engines', 'aero', 'reentry', 'events', 'cabin', 'ui'] as const;
export type BusId = (typeof BUS_NAMES)[number];

export interface MixConfig {
  /** gainDb for an outside listener, interiorGainDb for the cabin mix (ramped over smoothing.listenerKind on a view change). */
  buses: Record<BusId, { gainDb: number; interiorGainDb: number; fadeAboveWarp: boolean }>;
  master: {
    gainDb: number;
    /** makeupDb is the makeup applied after the compressor; the node's own automatic makeup is cancelled. */
    compressor: { thresholdDb: number; kneeDb: number; ratio: number; attack: number; release: number; makeupDb: number };
    /** The node's built-in makeup gain is cancelled (mapping.compressorMakeupDb): the output settles at the threshold. */
    limiter: { thresholdDb: number; kneeDb: number; ratio: number; attack: number; release: number };
    /** Absolute output ceiling (< 1): the final soft saturator never exceeds it. */
    ceiling: number;
    /** Below this amplitude the saturator is exactly linear. */
    linearUntil: number;
    /** Input amplitude (> 1) that the saturator still maps smoothly onto the ceiling. */
    headroom: number;
  };
  propagation: {
    speedOfSound: number;
    referencePressure: number;
    pressureGainExponent: number;
    pressureCutoffHz: Range;
    pressureCutoffExponent: number;
    absorption: { refDistance: number; refCutoffHz: number; exponent: number; maxCutoffHz: number };
    distanceExponent: number;
    maxDelay: number;
    airborneFadeStart: number;
    airborneFadeEnd: number;
    teleportSpeed: number;
    hull: { gainDb: number; cutoffHz: number };
    structure: { dbPerMetre: number; minDb: number };
    attach: { gainDb: number; fullDistance: number; maxDistance: number };
    events: { bodyCutoffHz: number; bodyGainDb: number };
    interiorPanWidth: number;
    /** Width of the airborne fade at a supersonic source's Mach cone (mapping.retardedDelay). */
    coneEdge: number;
    /** Where a 'map' listener stands (VES) before any external flight camera was seen. */
    mapListener: { positionVes: { x: number; y: number; z: number } };
  };
  warp: { threshold: number; fadeTime: number };
  pause: { fadeTime: number };
  smoothing: { gain: number; filter: number; position: number; delay: number; listenerKind: number; volume: number };
}

export interface AlarmCondition {
  path: string;
  relativeTo: string | null;
  above: number | null;
  below: number | null;
  equals: string | number | boolean | null;
}
export interface UiConfig {
  clicks: { assets: string[]; gainDb: number; minInterval: number; watch: string[] };
  alarm: {
    gainDb: number;
    tones: { freqHz: number; duration: number }[];
    gap: number;
    lowpassHz: number;
    minDuration: number;
    rearm: number;
    conditions: AlarmCondition[];
  };
}

export interface AudioConfig {
  assets: Record<string, AssetDef>;
  engines: EnginesConfig;
  events: EventsConfig;
  environment: EnvironmentConfig;
  mix: MixConfig;
  ui: UiConfig;
}

/** Section keys under DefLibrary.sections. */
export const AUDIO_SECTIONS = {
  assets: 'audio/assets',
  engines: 'audio/engines',
  events: 'audio/events',
  environment: 'audio/environment',
  mix: 'audio/mix',
  ui: 'audio/ui',
} as const;

// ------------------------------------------------------------------------------------------- validation

/** Every SimEvent type (exhaustive: adding a type to the contract fails compilation until listed here). */
const EVENT_TYPES: Record<SimEventType, true> = {
  stageFired: true,
  engineIgnition: true,
  engineShutdown: true,
  clampsReleased: true,
  decoupled: true,
  fairingJettisoned: true,
  lesFired: true,
  legsToggled: true,
  chuteDeployed: true,
  chuteInflated: true,
  chuteCut: true,
  chuteFailed: true,
  rcsPulse: true,
  touchdown: true,
  splash: true,
  partDestroyed: true,
  explosion: true,
  jointBroken: true,
  crewLost: true,
  soiChange: true,
  vesselRemoved: true,
  activeVesselChanged: true,
  warpChanged: true,
  nodeCompleted: true,
  milestone: true,
  missionFailed: true,
};
export const ALL_EVENT_TYPES = Object.keys(EVENT_TYPES) as SimEventType[];

/** Snapshot paths a click watch or an alarm condition may name: `<group>.<field>`. */
const READOUT_FIELDS: Record<keyof Readouts, true> = {
  met: true, altitudeAsl: true, altitudeRadar: true, latitude: true, longitude: true, speedOrbital: true, speedSurface: true,
  verticalSpeed: true, horizontalSpeed: true, apoapsisAltitude: true, periapsisAltitude: true, timeToApoapsis: true,
  timeToPeriapsis: true, inclination: true, eccentricity: true, period: true, throttle: true, thrust: true, twr: true,
  mass: true, gLoad: true, gDose: true, gDoseLimit: true, dynamicPressure: true, mach: true, angleOfAttack: true,
  heatFlux: true, ablatorFraction: true, maxTempFraction: true, sasEnabled: true, sasMode: true, sasModesAvailable: true,
  rcsEnabled: true, fineControl: true, legsDeployed: true, lightsOn: true, chuteEnvelope: true, rcsFraction: true,
  deltaVTotal: true, targetBodyId: true, targetRelativeInclination: true, targetClosestApproach: true, launchWindow: true,
  nodeBurn: true, liftVectorUp: true, tiltFromVertical: true, landingTarget: true,
};
const NAVBALL_FIELDS: Record<keyof NavballState, true> = { mode: true, qVesselToHorizon: true, markers: true, pitchDeg: true, headingDeg: true, rollDeg: true };
const WARP_FIELDS: Record<keyof WarpState, true> = { index: true, factor: true, maxIndex: true, limitedBy: true, onRails: true };
const MISSION_FIELDS: Record<keyof SimSnapshot['mission'], true> = { failed: true, failureReason: true, crewAlive: true };
const PATH_GROUPS: Record<string, Record<string, true>> = { readouts: READOUT_FIELDS, navball: NAVBALL_FIELDS, warp: WARP_FIELDS, mission: MISSION_FIELDS };

class Field {
  constructor(
    readonly file: string,
    readonly path: string,
    readonly value: unknown,
  ) {}
  fail(message: string): never {
    throw new DefError(this.file, `${this.path === '' ? '(root)' : this.path}: ${message}`);
  }
  private child(key: string | number, value: unknown): Field {
    const p = typeof key === 'number' ? `${this.path}[${key}]` : this.path === '' ? key : `${this.path}.${key}`;
    return new Field(this.file, p, value);
  }
  obj(): Record<string, unknown> {
    if (typeof this.value !== 'object' || this.value === null || Array.isArray(this.value)) this.fail('must be an object');
    return this.value as Record<string, unknown>;
  }
  has(key: string): boolean {
    const o = this.obj();
    return key in o && o[key] !== undefined;
  }
  get(key: string): Field {
    const o = this.obj();
    if (!(key in o) || o[key] === undefined) this.child(key, undefined).fail('is required');
    return this.child(key, o[key]);
  }
  /** Null when the field is absent or null. */
  opt(key: string): Field | null {
    const o = this.obj();
    return o[key] === undefined || o[key] === null ? null : this.child(key, o[key]);
  }
  entries(): [string, Field][] {
    return Object.entries(this.obj())
      .filter(([k]) => !k.startsWith('$'))
      .map(([k, v]) => [k, this.child(k, v)]);
  }
  arr(minLength = 0): Field[] {
    if (!Array.isArray(this.value)) this.fail('must be an array');
    const a = this.value as unknown[];
    if (a.length < minLength) this.fail(`must have at least ${minLength} element(s)`);
    return a.map((v, i) => this.child(i, v));
  }
  num(opts: { min?: number; max?: number; gt?: number; int?: boolean } = {}): number {
    const v = this.value;
    if (typeof v !== 'number' || !Number.isFinite(v)) this.fail('must be a finite number');
    if (opts.int && !Number.isInteger(v)) this.fail('must be an integer');
    if (opts.min !== undefined && v < opts.min) this.fail(`must be >= ${opts.min}`);
    if (opts.gt !== undefined && !(v > opts.gt)) this.fail(`must be > ${opts.gt}`);
    if (opts.max !== undefined && v > opts.max) this.fail(`must be <= ${opts.max}`);
    return v;
  }
  str(): string {
    if (typeof this.value !== 'string' || this.value === '') this.fail('must be a non-empty string');
    return this.value;
  }
  bool(): boolean {
    if (typeof this.value !== 'boolean') this.fail('must be true or false');
    return this.value;
  }
  oneOf<T extends string>(values: readonly T[]): T {
    const s = this.str();
    if (!values.includes(s as T)) this.fail(`must be one of ${values.join(', ')}`);
    return s as T;
  }
  /** [lo, hi] with lo <= hi. */
  range(opts: { min?: number; max?: number; gt?: number } = {}): Range {
    const a = this.arr();
    if (a.length !== 2) this.fail('must be a [low, high] pair');
    const lo = a[0]!.num(opts);
    const hi = a[1]!.num(opts);
    if (lo > hi) this.fail('low must not exceed high');
    return [lo, hi];
  }
  scalar(): string | number | boolean {
    const v = this.value;
    if (typeof v === 'string' || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))) return v;
    this.fail('must be a string, number or boolean');
  }
}

function section(lib: DefLibrary, key: string): Field {
  return new Field(`${key}.json`, '', getSection<unknown>(lib, key));
}

function parseAssets(n: Field): Record<string, AssetDef> {
  const out: Record<string, AssetDef> = {};
  const files = new Set<string>();
  for (const [id, a] of n.get('assets').entries()) {
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(id)) a.fail('asset ids are lower-kebab');
    const file = a.get('file').str();
    if (!/^[a-z0-9][a-z0-9._-]*\.(flac|ogg|opus|wav|mp3|m4a)$/.test(file)) a.get('file').fail(`"${file}" is not a plain audio file name`);
    if (files.has(file)) a.get('file').fail(`"${file}" is used by two assets`);
    files.add(file);
    out[id] = { file, loop: a.get('loop').bool() };
  }
  if (Object.keys(out).length === 0) n.get('assets').fail('lists no assets');
  return out;
}

function assetRef(n: Field, assets: Record<string, AssetDef>, loop?: boolean): string {
  const id = n.str();
  const a = assets[id];
  if (!a) n.fail(`unknown asset "${id}" (not in audio/assets.json)`);
  if (loop !== undefined && a.loop !== loop) n.fail(`asset "${id}" must be ${loop ? 'a loop' : 'a one-shot'}`);
  return id;
}

const band = (n: Field): BandLayer => {
  const b = { gainDb: n.get('gainDb').num(), highpassHz: n.get('highpassHz').num({ gt: 0 }), lowpassHz: n.get('lowpassHz').num({ gt: 0 }) };
  if (b.lowpassHz <= b.highpassHz) n.get('lowpassHz').fail('must be above highpassHz');
  return b;
};

function parseEngines(n: Field, assets: Record<string, AssetDef>): EnginesConfig {
  const lv = n.get('level');
  const level = { refThrust: lv.get('refThrust').num({ gt: 0 }), levelDb: lv.get('levelDb').num() };
  const profiles: Record<string, EngineProfile> = {};
  for (const [id, p] of n.get('profiles').entries()) {
    const core = p.get('core');
    const rumble = p.opt('rumble');
    const hiss = p.opt('hiss');
    const crackle = p.opt('crackle');
    const ignition = p.opt('ignition');
    const shutdown = p.opt('shutdown');
    const body = p.get('body');
    profiles[id] = {
      refThrust: p.get('refThrust').num({ gt: 0 }),
      efficiencyDb: p.get('efficiencyDb').num({ min: -60, max: 60 }),
      throttleExponent: p.get('throttleExponent').num({ gt: 0, max: 4 }),
      throttleRangeDb: p.get('throttleRangeDb').num({ min: 0, max: 40 }),
      refDistance: p.get('refDistance').num({ gt: 0 }),
      core: {
        asset: assetRef(core.get('asset'), assets, true),
        gainDb: core.get('gainDb').num(),
        rate: core.get('rate').range({ gt: 0, max: 4 }),
        cutoffHz: core.get('cutoffHz').range({ gt: 0, max: 24000 }),
        turbulence: core.get('turbulence').num({ min: 0, max: 1 }),
      },
      rumble: rumble && {
        gainDb: rumble.get('gainDb').num(),
        cutoffHz: rumble.get('cutoffHz').num({ gt: 0 }),
        clusterExponent: rumble.get('clusterExponent').num({ min: 0, max: 1 }),
        turbulence: rumble.get('turbulence').num({ min: 0, max: 1 }),
        turbulenceHz: rumble.get('turbulenceHz').num({ gt: 0, max: 50 }),
      },
      hiss: hiss && band(hiss),
      crackle: crackle && {
        gainDb: crackle.get('gainDb').num(),
        rateHz: crackle.get('rateHz').range({ min: 0, max: 5000 }),
        highpassHz: crackle.get('highpassHz').num({ gt: 0 }),
        pressureExponent: crackle.get('pressureExponent').num({ gt: 0, max: 4 }),
      },
      ignition: ignition && { asset: assetRef(ignition.get('asset'), assets, false), gainDb: ignition.get('gainDb').num() },
      shutdown: shutdown && {
        asset: assetRef(shutdown.get('asset'), assets, false),
        gainDb: shutdown.get('gainDb').num(),
        minRunTime: shutdown.get('minRunTime').num({ min: 0 }),
      },
      body: {
        gainDb: body.get('gainDb').num(),
        cutoffHz: body.get('cutoffHz').num({ gt: 0 }),
        resonanceHz: body.get('resonanceHz').num({ gt: 0 }),
        resonanceDb: body.get('resonanceDb').num({ min: -24, max: 24 }),
      },
      clusterWindow: p.get('clusterWindow').num({ min: 0, max: 10 }),
    };
  }
  const rcsModuleProfile = n.get('rcsModuleProfile').str();
  if (!profiles[rcsModuleProfile]) n.get('rcsModuleProfile').fail(`"${rcsModuleProfile}" is not a profile`);
  return { level, voiceHold: n.get('voiceHold').num({ min: 0, max: 30 }), rcsModuleProfile, profiles };
}

function parseEvents(n: Field, assets: Record<string, AssetDef>): EventsConfig {
  const out: EventsConfig = {};
  for (const [type, e] of n.get('events').entries()) {
    if (!(type in EVENT_TYPES)) e.fail(`"${type}" is not a SimEvent type`);
    const match = e.opt('match');
    const variantBy = e.opt('variantBy');
    const scaleBy = e.opt('scaleBy');
    const rate = e.opt('rate');
    const def: EventSoundDef = {
      assets: e.get('assets').arr(1).map((a) => assetRef(a, assets, false)),
      gainDb: e.get('gainDb').num(),
      source: e.get('source').oneOf(['part', 'vessel', 'explosion', 'listener'] as const),
      structureBorne: e.get('structureBorne').bool(),
      refDistance: e.get('refDistance').num({ gt: 0 }),
      minInterval: e.get('minInterval').num({ min: 0 }),
      maxVoices: e.get('maxVoices').num({ min: 1, int: true }),
      rate: rate && rate.range({ gt: 0, max: 4 }),
      match: match && Object.fromEntries(match.entries().map(([k, v]) => [k, v.scalar()])),
      variantBy: variantBy && { field: variantBy.get('field').str(), thresholds: variantBy.get('thresholds').arr(1).map((t) => t.num()) },
      scaleBy: scaleBy && {
        field: scaleBy.get('field').str(),
        ref: scaleBy.get('ref').num({ gt: 0 }),
        exponent: scaleBy.get('exponent').num(),
        minDb: scaleBy.get('minDb').num(),
        maxDb: scaleBy.get('maxDb').num(),
      },
    };
    if (def.variantBy && def.variantBy.thresholds.length + 1 > def.assets.length) e.get('variantBy').fail(`needs ${def.variantBy.thresholds.length + 1} assets`);
    if (def.scaleBy && def.scaleBy.minDb > def.scaleBy.maxDb) e.get('scaleBy').fail('minDb must not exceed maxDb');
    if (def.source === 'listener' && def.structureBorne) e.get('structureBorne').fail('a listener-positioned sound cannot be structure-borne');
    out[type as SimEventType] = def;
  }
  return out;
}

function parseEnvironment(n: Field, assets: Record<string, AssetDef>): EnvironmentConfig {
  const a = n.get('aero');
  const r = n.get('reentry');
  const c = n.get('cabin');
  const wind = a.get('wind');
  const noise = a.get('noise');
  const buffet = a.get('buffet');
  const roar = r.get('roar');
  const hiss = r.get('hiss');
  const crackle = r.get('crackle');
  const rumble = r.get('rumble');
  const creaks = c.get('creaks');
  const hum = c.get('hum');
  const amb = n.get('ambience');
  const bedsNode = amb.get('beds');
  const beds = {} as Record<AmbienceSurface, AmbienceLayer[]>;
  for (const surface of AMBIENCE_SURFACES) {
    beds[surface] = bedsNode.get(surface).arr().map((l) => ({ asset: assetRef(l.get('asset'), assets, true), gainDb: l.get('gainDb').num() }));
  }
  for (const [k, b] of bedsNode.entries()) if (!(AMBIENCE_SURFACES as readonly string[]).includes(k)) b.fail(`unknown surface (surfaces are ${AMBIENCE_SURFACES.join(', ')})`);
  return {
    aero: {
      qRef: a.get('qRef').num({ gt: 0 }),
      maxDb: a.get('maxDb').num(),
      refDistance: a.get('refDistance').num({ gt: 0 }),
      hullCutoffHz: a.get('hullCutoffHz').num({ gt: 0 }),
      hullGainDb: a.get('hullGainDb').num(),
      wind: {
        asset: assetRef(wind.get('asset'), assets, true),
        gainDb: wind.get('gainDb').num(),
        cutoffHz: wind.get('cutoffHz').range({ gt: 0, max: 24000 }),
        machForMaxCutoff: wind.get('machForMaxCutoff').num({ gt: 0 }),
      },
      noise: { gainDb: noise.get('gainDb').num(), bandHz: noise.get('bandHz').range({ gt: 0 }), bandAtMachMax: noise.get('bandAtMachMax').range({ gt: 0 }) },
      buffet: {
        gainDb: buffet.get('gainDb').num(),
        machCenter: buffet.get('machCenter').num({ gt: 0 }),
        machWidth: buffet.get('machWidth').num({ gt: 0 }),
        cutoffHz: buffet.get('cutoffHz').num({ gt: 0 }),
        turbulence: buffet.get('turbulence').num({ min: 0, max: 1 }),
        turbulenceHz: buffet.get('turbulenceHz').num({ gt: 0, max: 50 }),
      },
    },
    reentry: {
      refDistance: r.get('refDistance').num({ gt: 0 }),
      hullCutoffHz: r.get('hullCutoffHz').num({ gt: 0 }),
      hullGainDb: r.get('hullGainDb').num(),
      roar: { asset: assetRef(roar.get('asset'), assets, true), gainDb: roar.get('gainDb').num(), exponent: roar.get('exponent').num({ gt: 0 }) },
      hiss: { ...band(hiss), exponent: hiss.get('exponent').num({ gt: 0 }) },
      crackle: { gainDb: crackle.get('gainDb').num(), rateHz: crackle.get('rateHz').range({ min: 0, max: 5000 }), highpassHz: crackle.get('highpassHz').num({ gt: 0 }) },
      rumble: {
        gainDb: rumble.get('gainDb').num(),
        cutoffHz: rumble.get('cutoffHz').num({ gt: 0 }),
        gLoadRef: rumble.get('gLoadRef').num({ gt: 0 }),
        turbulence: rumble.get('turbulence').num({ min: 0, max: 1 }),
        turbulenceHz: rumble.get('turbulenceHz').num({ gt: 0, max: 50 }),
      },
    },
    ambience: {
      surfaceAltitude: amb.get('surfaceAltitude').range({ min: 0 }),
      hullGainDb: amb.get('hullGainDb').num(),
      hullCutoffHz: amb.get('hullCutoffHz').num({ gt: 0 }),
      beds,
    },
    cabin: {
      ambience: { asset: assetRef(c.get('ambience').get('asset'), assets, true), gainDb: c.get('ambience').get('gainDb').num() },
      airflow: { gainDb: c.get('airflow').get('gainDb').num(), bandHz: c.get('airflow').get('bandHz').range({ gt: 0 }) },
      hum: { freqHz: hum.get('freqHz').num({ gt: 0, max: 20000 }), harmonics: hum.get('harmonics').arr(1).map((h) => h.num({ min: 0, max: 1 })), gainDb: hum.get('gainDb').num() },
      creaks: {
        assets: creaks.get('assets').arr(1).map((x) => assetRef(x, assets, false)),
        gainDb: creaks.get('gainDb').num(),
        gMin: creaks.get('gMin').num({ min: 0 }),
        gMax: creaks.get('gMax').num({ gt: creaks.get('gMin').num() }),
        maxRate: creaks.get('maxRate').num({ min: 0 }),
        jerkRate: creaks.get('jerkRate').num({ min: 0 }),
        thermalRate: creaks.get('thermalRate').num({ min: 0 }),
        gainPerG: creaks.get('gainPerG').num(),
        seed: creaks.get('seed').num({ int: true }),
        minInterval: creaks.get('minInterval').num({ min: 0 }),
      },
    },
  };
}

function parseMix(n: Field): MixConfig {
  const busesNode = n.get('buses');
  const buses = {} as MixConfig['buses'];
  for (const id of BUS_NAMES) {
    const b = busesNode.get(id);
    buses[id] = { gainDb: b.get('gainDb').num({ min: -60, max: 24 }), interiorGainDb: b.get('interiorGainDb').num({ min: -60, max: 24 }), fadeAboveWarp: b.get('fadeAboveWarp').bool() };
  }
  for (const [k, b] of busesNode.entries()) if (!(BUS_NAMES as readonly string[]).includes(k)) b.fail(`unknown bus (buses are ${BUS_NAMES.join(', ')})`);
  const m = n.get('master');
  const comp = m.get('compressor');
  const lim = m.get('limiter');
  const p = n.get('propagation');
  const abs = p.get('absorption');
  const sm = n.get('smoothing');
  const ceiling = m.get('ceiling').num({ gt: 0, max: 0.98 });
  const linearUntil = m.get('linearUntil').num({ gt: 0 });
  if (linearUntil >= ceiling) m.get('linearUntil').fail('must be below ceiling');
  const fadeStart = p.get('airborneFadeStart').num({ gt: 0 });
  const fadeEnd = p.get('airborneFadeEnd').num({ gt: fadeStart });
  const c = p.get('speedOfSound').num({ gt: 0 });
  const maxDelay = p.get('maxDelay').num({ gt: 0, max: 179 });
  if (fadeEnd / c > maxDelay) p.get('maxDelay').fail(`must cover airborneFadeEnd / speedOfSound = ${(fadeEnd / c).toFixed(2)} s`);
  return {
    buses,
    master: {
      gainDb: m.get('gainDb').num(),
      compressor: {
        thresholdDb: comp.get('thresholdDb').num({ min: -100, max: 0 }),
        kneeDb: comp.get('kneeDb').num({ min: 0, max: 40 }),
        ratio: comp.get('ratio').num({ min: 1, max: 20 }),
        attack: comp.get('attack').num({ min: 0, max: 1 }),
        release: comp.get('release').num({ min: 0, max: 1 }),
        makeupDb: comp.get('makeupDb').num({ min: -24, max: 24 }),
      },
      limiter: {
        thresholdDb: lim.get('thresholdDb').num({ min: -100, max: 0 }),
        kneeDb: lim.get('kneeDb').num({ min: 0, max: 40 }),
        ratio: lim.get('ratio').num({ min: 1, max: 20 }),
        attack: lim.get('attack').num({ min: 0, max: 1 }),
        release: lim.get('release').num({ min: 0, max: 1 }),
      },
      ceiling,
      linearUntil,
      headroom: m.get('headroom').num({ gt: 1, max: 64 }),
    },
    propagation: {
      speedOfSound: c,
      referencePressure: p.get('referencePressure').num({ gt: 0 }),
      pressureGainExponent: p.get('pressureGainExponent').num({ gt: 0, max: 4 }),
      pressureCutoffHz: p.get('pressureCutoffHz').range({ gt: 0, max: 24000 }),
      pressureCutoffExponent: p.get('pressureCutoffExponent').num({ gt: 0, max: 4 }),
      absorption: {
        refDistance: abs.get('refDistance').num({ gt: 0 }),
        refCutoffHz: abs.get('refCutoffHz').num({ gt: 0 }),
        exponent: abs.get('exponent').num({ gt: 0, max: 4 }),
        maxCutoffHz: abs.get('maxCutoffHz').num({ gt: 0, max: 24000 }),
      },
      distanceExponent: p.get('distanceExponent').num({ gt: 0, max: 2 }),
      maxDelay,
      airborneFadeStart: fadeStart,
      airborneFadeEnd: fadeEnd,
      teleportSpeed: p.get('teleportSpeed').num({ gt: c }),
      hull: { gainDb: p.get('hull').get('gainDb').num(), cutoffHz: p.get('hull').get('cutoffHz').num({ gt: 0 }) },
      structure: { dbPerMetre: p.get('structure').get('dbPerMetre').num({ min: 0 }), minDb: p.get('structure').get('minDb').num({ max: 0 }) },
      attach: {
        gainDb: p.get('attach').get('gainDb').num(),
        fullDistance: p.get('attach').get('fullDistance').num({ min: 0 }),
        maxDistance: p.get('attach').get('maxDistance').num({ gt: p.get('attach').get('fullDistance').num() }),
      },
      events: { bodyCutoffHz: p.get('events').get('bodyCutoffHz').num({ gt: 0 }), bodyGainDb: p.get('events').get('bodyGainDb').num() },
      interiorPanWidth: p.get('interiorPanWidth').num({ min: 0, max: 1 }),
      coneEdge: p.get('coneEdge').num({ min: 0, max: 0.5 }),
      mapListener: { positionVes: vec3Field(p.get('mapListener').get('positionVes')) },
    },
    warp: { threshold: n.get('warp').get('threshold').num({ min: 1 }), fadeTime: n.get('warp').get('fadeTime').num({ gt: 0, max: 1 }) },
    pause: { fadeTime: n.get('pause').get('fadeTime').num({ gt: 0, max: 5 }) },
    smoothing: {
      gain: sm.get('gain').num({ gt: 0, max: 2 }),
      filter: sm.get('filter').num({ gt: 0, max: 2 }),
      position: sm.get('position').num({ gt: 0, max: 2 }),
      delay: sm.get('delay').num({ gt: 0, max: 2 }),
      listenerKind: sm.get('listenerKind').num({ gt: 0, max: 2 }),
      volume: sm.get('volume').num({ gt: 0, max: 2 }),
    },
  };
}

function vec3Field(n: Field): { x: number; y: number; z: number } {
  const a = n.arr();
  if (a.length !== 3) n.fail('must be an [x, y, z] triple');
  return { x: a[0]!.num(), y: a[1]!.num(), z: a[2]!.num() };
}

function snapshotPath(n: Field): string {
  const s = n.str();
  const [group, field, ...rest] = s.split('.');
  const fields = group === undefined ? undefined : PATH_GROUPS[group];
  if (!fields || field === undefined || rest.length > 0) n.fail(`"${s}" must be <group>.<field> with group one of ${Object.keys(PATH_GROUPS).join(', ')}`);
  if (!(field in fields)) n.fail(`"${s}": ${group} has no field "${field}"`);
  return s;
}

function parseUi(n: Field, assets: Record<string, AssetDef>): UiConfig {
  const c = n.get('clicks');
  const a = n.get('alarm');
  return {
    clicks: {
      assets: c.get('assets').arr(1).map((x) => assetRef(x, assets, false)),
      gainDb: c.get('gainDb').num(),
      minInterval: c.get('minInterval').num({ min: 0 }),
      watch: c.get('watch').arr().map(snapshotPath),
    },
    alarm: {
      gainDb: a.get('gainDb').num(),
      tones: a.get('tones').arr(1).map((t) => ({ freqHz: t.get('freqHz').num({ gt: 0, max: 20000 }), duration: t.get('duration').num({ gt: 0, max: 5 }) })),
      gap: a.get('gap').num({ min: 0, max: 5 }),
      lowpassHz: a.get('lowpassHz').num({ gt: 0 }),
      minDuration: a.get('minDuration').num({ min: 0 }),
      rearm: a.get('rearm').num({ min: 0 }),
      conditions: a.get('conditions').arr().map((cn) => {
        const cond: AlarmCondition = {
          path: snapshotPath(cn.get('path')),
          relativeTo: cn.has('relativeTo') ? snapshotPath(cn.get('relativeTo')) : null,
          above: cn.has('above') ? cn.get('above').num() : null,
          below: cn.has('below') ? cn.get('below').num() : null,
          equals: cn.has('equals') ? cn.get('equals').scalar() : null,
        };
        if ([cond.above, cond.below, cond.equals].filter((x) => x !== null).length !== 1) cn.fail('needs exactly one of above, below, equals');
        return cond;
      }),
    },
  };
}

/** Engine modules in the part library must name a profile that exists (reported against the part file). */
function checkPartSounds(lib: DefLibrary, engines: EnginesConfig): void {
  for (const part of Object.values(lib.parts)) {
    part.modules.forEach((m, i) => {
      if (m.type === 'engine' && !engines.profiles[m.sound]) {
        throw new DefError(`parts/${part.id}.json`, `modules[${i}].sound "${m.sound}" has no profile in audio/engines.json`);
      }
    });
  }
}

/** Read and validate every audio section of the library. Throws DefError naming the offending file. */
export function parseAudioConfig(lib: DefLibrary): AudioConfig {
  const assets = parseAssets(section(lib, AUDIO_SECTIONS.assets));
  const engines = parseEngines(section(lib, AUDIO_SECTIONS.engines), assets);
  checkPartSounds(lib, engines);
  return {
    assets,
    engines,
    events: parseEvents(section(lib, AUDIO_SECTIONS.events), assets),
    environment: parseEnvironment(section(lib, AUDIO_SECTIONS.environment), assets),
    mix: parseMix(section(lib, AUDIO_SECTIONS.mix)),
    ui: parseUi(section(lib, AUDIO_SECTIONS.ui), assets),
  };
}

/** Resolve a validated `<group>.<field>` path in a snapshot. */
export function readSnapshotPath(snapshot: SimSnapshot, path: string): unknown {
  const dot = path.indexOf('.');
  const group = (snapshot as unknown as Record<string, Record<string, unknown> | undefined>)[path.slice(0, dot)];
  return group?.[path.slice(dot + 1)];
}
