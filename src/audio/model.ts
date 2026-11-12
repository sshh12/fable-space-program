/**
 * The sound model: a pure, deterministic function of the AudioFrame sequence (plus its own memory of the
 * previous frames) that decides WHAT is heard - per-voice layer levels, two propagation paths per source
 * (airborne and structure-borne), one-shots to start, alarm state. It never touches Web Audio; the graph
 * (graph.ts) only applies these targets. That keeps every rule unit-testable in vitest.
 *
 * Listener rules: branch on AudioListener.kind only. 'interior' = cabin mix (structure-borne path from the
 * vessel the listener sits in, airborne sound only through the hull); 'external' and 'map' (and any kind
 * a future rig reports as such) = outside listener. `mode` is never inspected, so an unknown view mode
 * sounds exactly like the built-in rig of the same kind. A 'map' listener is placed where the last
 * external flight camera of the active vessel was (VES), in the vessel's own ambient pressure: the map
 * camera itself is 100 km or more away and would hear nothing.
 *
 * Airborne propagation is convected: delays are the exact retarded times for sources that move with their
 * vessel's air-relative velocity (mapping.retardedDelay), so a listener riding with a supersonic vessel
 * ahead of its nozzles gets no airborne engine sound, only the structure-borne path.
 */
import type { AudioFrame } from '@/core/contracts/audio';
import type { DefLibrary } from '@/core/contracts/defs';
import type { ModuleState, PartSnapshot, SimEvent, SimEventType, SimSnapshot, VesselSnapshot } from '@/core/contracts/sim';
import { Prng } from '@/core/math/hash';
import { quat } from '@/core/math/quat';
import { v3, type Vec3 } from '@/core/math/vec3';
import { readSnapshotPath, type AudioConfig, type EngineProfile, type EventSoundDef } from './config';
import {
  absorptionCutoff,
  attachFactor,
  buffetWeight,
  combineCutoffs,
  continuousAudible,
  crackleFactor,
  creakRate,
  entryLoad,
  dbToGain,
  distanceGain,
  engineLevelDb,
  eventScaleDb,
  hashString,
  lerp,
  localSoundSpeed,
  plasmaAmplitude,
  pressureCutoff,
  pressureGain,
  retardedDelay,
  structureDb,
  surfaceFactor,
  throttleLever,
  windDb,
} from './mapping';

/** Airborne path of one source: what arrives through the air (outside) or through the hull (cabin). */
export interface AirPath {
  gain: number;
  cutoff: number;
  /** Propagation delay, s. */
  delay: number;
  /** True when the delay must be set at once instead of swept (camera cut, sound newly reachable). */
  jump: boolean;
  /** Unit direction to the source in listener axes (+X right, +Y up, -Z forward). */
  pan: Vec3;
}
/** Structure-borne path: through the vessel's structure, no delay, unpanned. */
export interface BodyPath {
  gain: number;
  cutoff: number;
}
export interface SourcePaths {
  air: AirPath;
  body: BodyPath;
}

export interface EngineVoiceTarget {
  /** `${vesselId}|${profileId}`: one voice per cluster of same-profile engines on one vessel. */
  key: string;
  profileId: string;
  seed: number;
  engines: number;
  running: number;
  levelDb: number;
  /** Thrust-weighted position of the running engines in their throttle range (the lever), 0..1. */
  lever: number;
  core: { gain: number; rate: number; cutoff: number };
  rumble: { gain: number; cutoff: number };
  hiss: { gain: number };
  crackle: { gain: number; rate: number };
  /** Start the ignition / shutdown transient this frame, `offset` seconds into the asset. */
  ignition: { gain: number; offset: number } | null;
  shutdown: { gain: number; offset: number } | null;
  paths: SourcePaths;
}

export interface AeroTarget {
  wind: { gain: number; cutoff: number };
  noise: { gain: number; lowHz: number; highHz: number };
  buffet: { gain: number };
  paths: SourcePaths;
}
export interface ReentryTarget {
  roar: { gain: number };
  hiss: { gain: number };
  crackle: { gain: number; rate: number };
  rumble: { gain: number };
  paths: SourcePaths;
}
export interface CabinTarget {
  ambience: number;
  airflow: number;
  hum: number;
}
/** Surface ambience around the listener (air bed, sea): gain per ambience loop asset, one low-pass. */
export interface AmbienceTarget {
  gains: Record<string, number>;
  cutoff: number;
}

export type OneShotBus = 'events' | 'cabin' | 'ui';
export interface OneShotRequest {
  bus: OneShotBus;
  /** What caused it (event type, 'creak', 'click'), for probes and tests. */
  cause: string;
  asset: string;
  gain: number;
  rate: number;
  /** Played directly into the bus (player feedback, cabin sounds): no propagation. */
  direct: boolean;
  air: AirPath | null;
  body: BodyPath | null;
}

export interface ModelOutput {
  interior: boolean;
  /** 1 = continuous sounds audible, 0 = faded out (time warp above physics warp). */
  continuous: number;
  paused: boolean;
  /** Engine clusters that sound now (running, a transient, or within voiceHold of either). */
  engines: EngineVoiceTarget[];
  aero: AeroTarget;
  reentry: ReentryTarget;
  ambience: AmbienceTarget;
  cabin: CabinTarget;
  oneShots: OneShotRequest[];
  alarm: boolean;
  /** Problems with the input that the engine reports once (e.g. a part without a definition). */
  problems: string[];
}

/** An ignition seen for the first time is fresh (gets its transient) if it is younger than this. */
const FRESH_IGNITION = 0.5;

interface ListenerGeometry {
  pos: Vec3;
  right: Vec3;
  up: Vec3;
  fwd: Vec3;
  interior: boolean;
  /**
   * Vessel whose structure carries sound to the listener: the one it sits in, or the vessel an outside camera
   * is attached to (AudioListener.attachedVesselId); null for a free outside camera, which hears no
   * structure-borne sound at all.
   */
  vesselId: string | null;
  pressure: number;
  active: VesselSnapshot;
  /** Distance from an attached outside listener to that vessel's bounding sphere (about its VES origin), m. */
  attachDistance: number;
}

interface ClusterAcc {
  key: string;
  vessel: VesselSnapshot;
  profileId: string;
  profile: EngineProfile;
  engines: number;
  running: number;
  thrust: number;
  leverWeighted: number;
  pressureWeighted: number;
  posWeighted: Vec3;
  posSum: Vec3;
  ignitionOffset: number | null;
  shutdownOffset: number | null;
}

interface SourceTrack {
  distance: number;
  time: number;
  reach: number;
}

interface EngineAges {
  ignitionAge: number;
  shutdownAge: number;
}

/** A source's motion through the air, in the active vessel's VES axes. */
interface SourceAir {
  velocity: Vec3;
  soundSpeed: number;
}

export class SoundModel {
  private time = 0;
  private readonly engineAges = new Map<string, EngineAges>();
  /** Last time each engine cluster sounded (running or transient), for voiceHold. */
  private readonly lastSounding = new Map<string, number>();
  private readonly tracks = new Map<string, SourceTrack>();
  /** Sources seen this frame; tracks of sources that disappeared (debris, one-shots) are dropped. */
  private readonly touched = new Set<string>();
  private readonly lastTransient = new Map<string, number>();
  private readonly lastEventPlay = new Map<string, number[]>();
  private readonly watched = new Map<string, unknown>();
  private watchInitialised = false;
  private lastClick = -Infinity;
  private alarmOn = false;
  private alarmSince = -Infinity;
  private alarmClearedAt = -Infinity;
  private prevG: number | null = null;
  private prevSun: number | null = null;
  private lastCreak = -Infinity;
  private readonly creakRng: Prng;
  private readonly reported = new Set<string>();
  /** The last outside (non-map) listener, in the VES frame of the vessel that was active then. */
  private lastOutside: { vesselId: string; attachedVesselId: string | null; pos: Vec3; fwd: Vec3; up: Vec3 } | null = null;
  private readonly ambienceAssets: string[];

  constructor(
    private readonly config: AudioConfig,
    private readonly defs: DefLibrary,
  ) {
    this.creakRng = new Prng(config.environment.cabin.creaks.seed);
    this.ambienceAssets = ambienceAssetIds(config);
  }

  update(frame: AudioFrame): ModelOutput {
    const dt = Math.max(0, frame.realDt);
    this.time += dt;
    const snap = frame.snapshot;
    const problems: string[] = [];
    const geom = this.listenerGeometry(frame, problems);
    const continuous = continuousAudible(frame.warpFactor, this.config.mix.warp.threshold) ? 1 : 0;
    const eventsAllowed = !snap.warp.onRails && !frame.paused;

    const out: ModelOutput = {
      interior: geom.interior,
      continuous,
      paused: frame.paused,
      engines: this.engineVoices(snap, geom, problems),
      aero: this.aero(geom),
      reentry: this.reentry(geom),
      ambience: this.ambience(snap, geom),
      cabin: this.cabinTarget(geom),
      oneShots: [],
      alarm: this.alarm(snap),
      problems,
    };
    if (eventsAllowed) {
      for (const e of snap.events) this.eventOneShot(e, snap, geom, out.oneShots);
      if (geom.interior && continuous === 1) this.creaks(geom.active, dt, out.oneShots);
    }
    this.clicks(snap, out.oneShots, !frame.paused);
    for (const k of this.tracks.keys()) if (!this.touched.has(k)) this.tracks.delete(k);
    this.touched.clear();
    if (geom.interior) {
      this.prevG = geom.active.gLoad;
      this.prevSun = geom.active.sunVisibility;
    } else {
      this.prevG = null;
      this.prevSun = null;
    }
    return out;
  }

  // ------------------------------------------------------------------------------------------ geometry

  private listenerGeometry(frame: AudioFrame, problems: string[]): ListenerGeometry {
    const snap = frame.snapshot;
    const l = frame.listener;
    const active = snap.vessels.find((v) => v.id === snap.activeVesselId) ?? snap.vessels[0];
    if (!active) throw new Error('audio: snapshot has no vessels');
    if (active.id !== snap.activeVesselId) this.report(problems, `active vessel ${snap.activeVesselId} is not in the snapshot`);
    let position = l.positionVes;
    let forward = l.forwardVes;
    let upHint = l.upVes;
    let pressure = l.ambientPressure;
    let attachedId = l.attachedVesselId;
    if (l.kind === 'map') {
      const last = this.lastOutside?.vesselId === active.id ? this.lastOutside : null;
      if (last) {
        position = last.pos;
        forward = last.fwd;
        upHint = last.up;
        attachedId = last.attachedVesselId;
      } else {
        // The stand-in is a chase camera of the active vessel that was never shown.
        position = this.config.mix.propagation.mapListener.positionVes;
        forward = v3.len(position) > 1e-6 ? v3.neg(position) : v3.unitY();
        upHint = v3.unitY();
        attachedId = active.id;
      }
      pressure = active.aero.pressure;
    } else if (l.kind !== 'interior') {
      this.lastOutside = { vesselId: active.id, attachedVesselId: l.attachedVesselId, pos: v3.clone(l.positionVes), fwd: v3.clone(l.forwardVes), up: v3.clone(l.upVes) };
    }
    const fwd = v3.len(forward) > 1e-9 ? v3.normalize(forward) : v3.unitY();
    const side = v3.cross(fwd, upHint);
    const right = v3.len(side) > 1e-9 ? v3.normalize(side) : v3.anyOrthogonal(fwd);
    const up = v3.cross(right, fwd);
    const interior = l.kind === 'interior';
    const attached = interior || attachedId === null ? null : (snap.vessels.find((v) => v.id === attachedId) ?? null);
    if (!interior && attachedId !== null && !attached) this.report(problems, `listener is attached to vessel ${attachedId}, which is not in the snapshot`);
    const vesselId = interior ? (l.insideVesselId ?? active.id) : (attached?.id ?? null);
    // `position` is in the active vessel's VES frame; another vessel's origin is carried into it.
    const attachOrigin = !attached || attached.id === active.id ? v3.zero() : quat.rotateInv(active.q, v3.sub(attached.rRoot, active.rRoot));
    return {
      pos: v3.clone(position),
      right,
      up,
      fwd,
      interior,
      vesselId,
      pressure,
      active,
      attachDistance: attached ? Math.max(0, v3.dist(position, attachOrigin) - attached.boundingRadius) : Infinity,
    };
  }

  /** Position of a point given in vessel V's frame, relative to the listener, in the active VES axes. */
  private relative(geom: ListenerGeometry, vessel: VesselSnapshot, local: Vec3): Vec3 {
    if (vessel.id === geom.active.id) return v3.sub(local, geom.pos);
    const a = geom.active;
    const worldOffset = v3.add(v3.sub(vessel.rRoot, a.rRoot), quat.rotate(vessel.q, local));
    return v3.sub(quat.rotateInv(a.q, worldOffset), geom.pos);
  }

  private relativeRoot(geom: ListenerGeometry, posRoot: Vec3): Vec3 {
    return v3.sub(quat.rotateInv(geom.active.q, v3.sub(posRoot, geom.active.rRoot)), geom.pos);
  }

  /** Air-relative motion of sources carried by a vessel, in the active VES axes. */
  private airOf(geom: ListenerGeometry, vessel: VesselSnapshot): SourceAir {
    const v = vessel.aero.airVelocity;
    return { velocity: quat.rotateInv(geom.active.q, v), soundSpeed: localSoundSpeed(vessel.aero.mach, v3.len(v), this.config.mix.propagation) };
  }

  private panOf(geom: ListenerGeometry, rel: Vec3): Vec3 {
    const d = v3.len(rel);
    if (d < 1e-6) return { x: 0, y: 0, z: -1 };
    const n = v3.scale(rel, 1 / d);
    const p = { x: v3.dot(n, geom.right), y: v3.dot(n, geom.up), z: -v3.dot(n, geom.fwd) };
    if (!geom.interior) return p;
    // Inside the cabin sound arrives through the whole hull: keep only a hint of direction.
    const w = this.config.mix.propagation.interiorPanWidth;
    return v3.normalize({ x: p.x * w, y: p.y * w, z: -1 + (p.z + 1) * w });
  }

  /**
   * Jump detection for a tracked source: a camera cut (distance changing faster than teleportSpeed), a
   * source seen for the first time, or a source that just became reachable through the air.
   */
  private track(key: string, distance: number, reach: number): boolean {
    this.touched.add(key);
    const prev = this.tracks.get(key);
    this.tracks.set(key, { distance, time: this.time, reach });
    if (!prev) return true;
    if (prev.reach === 0 && reach > 0) return true;
    const dt = this.time - prev.time;
    return dt > 1e-6 && Math.abs(distance - prev.distance) / dt > this.config.mix.propagation.teleportSpeed;
  }

  /**
   * Both paths for a source at `rel` (source minus listener, active VES axes) moving with `air`.
   * `sourceVesselId` couples structure-borne sound when it is the vessel the listener is coupled to;
   * `bodyGain` is the source's structure coupling (linear) before path losses.
   */
  private paths(
    geom: ListenerGeometry,
    key: string,
    rel: Vec3,
    air: SourceAir,
    refDistance: number,
    sourceVesselId: string,
    structureBorne: boolean,
    bodyGain: number,
    bodyCutoff: number,
    hullOverride: { gainDb: number; cutoffHz: number } | null = null,
  ): SourcePaths {
    const prop = this.config.mix.propagation;
    const d = v3.len(rel);
    const ret = retardedDelay(v3.neg(rel), air.velocity, air.soundSpeed, prop.maxDelay, prop.coneEdge);
    const jump = this.track(key, d, ret.reach);
    const coupled = structureBorne && sourceVesselId === geom.vesselId;
    let airGain = pressureGain(geom.pressure, prop) * distanceGain(d, refDistance, prop) * ret.reach;
    let cutoff = combineCutoffs(pressureCutoff(geom.pressure, prop), absorptionCutoff(d, prop));
    let body = 0;
    if (geom.interior) {
      const hull = hullOverride ?? prop.hull;
      airGain *= dbToGain(hull.gainDb);
      cutoff = combineCutoffs(cutoff, hull.cutoffHz);
      if (coupled) body = bodyGain * dbToGain(structureDb(d, prop));
    } else if (coupled) {
      body = bodyGain * dbToGain(prop.attach.gainDb) * attachFactor(geom.attachDistance, prop);
    }
    return {
      air: { gain: airGain, cutoff, delay: ret.delay, jump, pan: this.panOf(geom, rel) },
      body: { gain: body, cutoff: bodyCutoff },
    };
  }

  private report(problems: string[], message: string): void {
    if (this.reported.has(message)) return;
    this.reported.add(message);
    problems.push(message);
  }

  // ------------------------------------------------------------------------------------------- engines

  private engineVoices(snap: SimSnapshot, geom: ListenerGeometry, problems: string[]): EngineVoiceTarget[] {
    const clusters = new Map<string, ClusterAcc>();
    const engines = this.config.engines;
    const seen = new Set<string>();
    const cluster = (vessel: VesselSnapshot, profileId: string): ClusterAcc => {
      const key = `${vessel.id}|${profileId}`;
      let c = clusters.get(key);
      if (!c) {
        c = {
          key,
          vessel,
          profileId,
          profile: engines.profiles[profileId]!,
          engines: 0,
          running: 0,
          thrust: 0,
          leverWeighted: 0,
          pressureWeighted: 0,
          posWeighted: v3.zero(),
          posSum: v3.zero(),
          ignitionOffset: null,
          shutdownOffset: null,
        };
        clusters.set(key, c);
      }
      return c;
    };

    for (const vessel of snap.vessels) {
      for (const part of vessel.parts) {
        const def = this.defs.parts[part.def];
        part.modules.forEach((m, i) => {
          if (m.type !== 'engine' && m.type !== 'rcs') return;
          const md = def?.modules[i];
          if (!def || !md || md.type !== m.type) {
            this.report(problems, `part ${part.instanceId} (def "${part.def}") module ${i}: no matching ${m.type} module definition; it is silent`);
            return;
          }
          if (m.type === 'engine' && md.type === 'engine') {
            const profileId = md.sound;
            if (!engines.profiles[profileId]) {
              this.report(problems, `part def "${part.def}" uses sound "${profileId}" which has no profile`);
              return;
            }
            const c = cluster(vessel, profileId);
            const nozzle = md.nozzles.length > 0 ? v3.scale(md.nozzles.reduce((s, n) => v3.add(s, v3.fromTuple(n.pos)), v3.zero()), 1 / md.nozzles.length) : v3.zero();
            const pos = v3.add(part.localPos, quat.rotate(part.localRot, nozzle));
            const lever = throttleLever(m.throttleActual, md.minThrottle, md.throttleable && md.fixedBurn === undefined);
            this.addEngine(c, `${vessel.id}|${part.instanceId}|${i}`, m, lever, pos, seen);
          } else if (m.type === 'rcs' && md.type === 'rcs') {
            const c = cluster(vessel, engines.rcsModuleProfile);
            c.engines += md.thrusters.length;
            md.thrusters.forEach((t, j) => {
              const level = m.enabled ? (m.levels[j] ?? 0) : 0;
              const pos = v3.add(part.localPos, quat.rotate(part.localRot, v3.fromTuple(t.pos)));
              c.posSum = v3.add(c.posSum, pos);
              if (level > 0.01) {
                const thrust = level * t.thrust;
                c.running++;
                c.thrust += thrust;
                c.leverWeighted += thrust;
                c.pressureWeighted += vessel.aero.pressure * thrust;
                c.posWeighted = v3.addScaled(c.posWeighted, pos, thrust);
              }
            });
          }
        });
      }
    }
    for (const k of [...this.engineAges.keys()]) if (!seen.has(k)) this.engineAges.delete(k);
    for (const k of [...this.lastSounding.keys()]) if (!clusters.has(k)) this.lastSounding.delete(k);

    // Only clusters that sound get a voice: running, starting a transient, or within voiceHold of either
    // (the graph keeps a released voice until its delay line and transients have drained).
    const out: EngineVoiceTarget[] = [];
    for (const c of clusters.values()) {
      const last = this.lastSounding.get(c.key);
      const held = last !== undefined && this.time - last <= engines.voiceHold;
      if (c.running === 0 && c.ignitionOffset === null && c.shutdownOffset === null && !held) continue;
      const t = this.engineTarget(c, geom);
      if (t.running > 0 || t.ignition || t.shutdown) this.lastSounding.set(c.key, this.time);
      if (t.running > 0 || t.ignition || t.shutdown || held) out.push(t);
    }
    return out;
  }

  private addEngine(c: ClusterAcc, engineKey: string, m: Extract<ModuleState, { type: 'engine' }>, lever: number, pos: Vec3, seen: Set<string>): void {
    seen.add(engineKey);
    c.engines++;
    c.posSum = v3.add(c.posSum, pos);
    if (m.thrust > 0) {
      c.running++;
      c.thrust += m.thrust;
      c.leverWeighted += lever * m.thrust;
      c.pressureWeighted += m.ambientPressure * m.thrust;
      c.posWeighted = v3.addScaled(c.posWeighted, pos, m.thrust);
    }
    const prev = this.engineAges.get(engineKey);
    const ig = m.ignitionAge;
    const sd = m.shutdownAge;
    let ignited = false;
    if (ig >= 0) ignited = prev === undefined ? ig < FRESH_IGNITION : prev.ignitionAge < 0 || ig + 1e-6 < prev.ignitionAge;
    if (ignited) c.ignitionOffset = Math.min(c.ignitionOffset ?? Infinity, ig);
    const shutdownProfile = c.profile.shutdown;
    if (prev && shutdownProfile && sd >= 0 && prev.shutdownAge < 0 && prev.ignitionAge >= shutdownProfile.minRunTime) {
      c.shutdownOffset = Math.min(c.shutdownOffset ?? Infinity, sd);
    }
    this.engineAges.set(engineKey, { ignitionAge: ig, shutdownAge: sd });
  }

  private engineTarget(c: ClusterAcc, geom: ListenerGeometry): EngineVoiceTarget {
    const p = c.profile;
    const engines = this.config.engines;
    const prop = this.config.mix.propagation;
    const lever = c.thrust > 0 ? Math.min(1, c.leverWeighted / c.thrust) : 0;
    const levelDb = engineLevelDb(c.running > 0 ? c.thrust / c.running : 0, c.running, lever, p, engines);
    const L = dbToGain(levelDb);
    const nozzlePressure = c.thrust > 0 ? c.pressureWeighted / c.thrust : 0;
    const pos = c.thrust > 0 ? v3.scale(c.posWeighted, 1 / c.thrust) : v3.scale(c.posSum, 1 / Math.max(1, c.engines));
    const rel = this.relative(geom, c.vessel, pos);
    const fullDb = engineLevelDb(p.refThrust, Math.max(1, c.engines), 1, p, engines);
    const now = this.time;
    const transient = (kind: 'ign' | 'sd', offset: number | null, def: { gainDb: number } | null): { gain: number; offset: number } | null => {
      if (offset === null || !def) return null;
      const k = `${c.key}|${kind}`;
      if (now - (this.lastTransient.get(k) ?? -Infinity) < p.clusterWindow) return null;
      this.lastTransient.set(k, now);
      return { gain: dbToGain(fullDb + def.gainDb), offset };
    };
    const rumbleCutoff = p.rumble ? p.rumble.cutoffHz * Math.max(1, c.running) ** -p.rumble.clusterExponent : 100;
    return {
      key: c.key,
      profileId: c.profileId,
      seed: hashString(c.key),
      engines: c.engines,
      running: c.running,
      levelDb,
      lever,
      core: { gain: L * dbToGain(p.core.gainDb), rate: lerp(p.core.rate[0], p.core.rate[1], lever), cutoff: lerp(p.core.cutoffHz[0], p.core.cutoffHz[1], lever) },
      rumble: { gain: p.rumble ? L * dbToGain(p.rumble.gainDb) : 0, cutoff: rumbleCutoff },
      hiss: { gain: p.hiss ? L * dbToGain(p.hiss.gainDb) : 0 },
      crackle: {
        gain: p.crackle ? L * dbToGain(p.crackle.gainDb) * crackleFactor(nozzlePressure, p.crackle.pressureExponent, prop) : 0,
        rate: p.crackle ? lerp(p.crackle.rateHz[0], p.crackle.rateHz[1], lever) : 0,
      },
      ignition: transient('ign', c.ignitionOffset, p.ignition),
      shutdown: transient('sd', c.shutdownOffset, p.shutdown),
      paths: this.paths(geom, `engine|${c.key}`, rel, this.airOf(geom, c.vessel), p.refDistance, c.vessel.id, true, dbToGain(p.body.gainDb), p.body.cutoffHz),
    };
  }

  // --------------------------------------------------------------------------------- aero and reentry

  private aero(geom: ListenerGeometry): AeroTarget {
    const a = this.config.environment.aero;
    const v = geom.active;
    const w = windDb(v.aero.q, a.qRef, a.maxDb);
    const m = Math.min(1, Math.max(0, v.aero.mach / a.wind.machForMaxCutoff));
    const rel = this.relative(geom, v, v.comLocal);
    const air = this.airOf(geom, v);
    let paths: SourcePaths;
    if (geom.interior) {
      paths = { air: { ...this.paths(geom, 'aero', rel, air, a.refDistance, v.id, false, 0, a.hullCutoffHz).air, gain: 0 }, body: { gain: w === -Infinity ? 0 : dbToGain(a.hullGainDb), cutoff: a.hullCutoffHz } };
    } else {
      // Outside: through the air where it carries, and through the skin to a camera that rides with the vessel
      // for the part the air does not carry (all of it while the camera is outside the Mach cone or the air is
      // too thin to carry sound; none of it beside a subsonic vessel at sea level, where the wind is heard as before).
      paths = this.paths(geom, 'aero', rel, air, Math.max(a.refDistance, v.boundingRadius), v.id, true, w === -Infinity ? 0 : dbToGain(a.bodyGainDb), a.hullCutoffHz);
      paths.body.gain *= 1 - Math.min(1, paths.air.gain);
    }
    return {
      wind: { gain: dbToGain(w + a.wind.gainDb), cutoff: lerp(a.wind.cutoffHz[0], a.wind.cutoffHz[1], m) },
      noise: { gain: dbToGain(w + a.noise.gainDb), lowHz: lerp(a.noise.bandHz[0], a.noise.bandAtMachMax[0], m), highHz: lerp(a.noise.bandHz[1], a.noise.bandAtMachMax[1], m) },
      buffet: { gain: dbToGain(w + a.buffet.gainDb) * buffetWeight(v.aero.mach, a.buffet.machCenter, a.buffet.machWidth) },
      paths,
    };
  }

  private reentry(geom: ListenerGeometry): ReentryTarget {
    const r = this.config.environment.reentry;
    const v = geom.active;
    const plasma = v.aero.plasmaIntensity;
    const rel = this.relative(geom, v, v.comLocal);
    const air = this.airOf(geom, v);
    const hull = { gainDb: r.hullGainDb, cutoffHz: r.hullCutoffHz };
    let paths: SourcePaths;
    if (geom.interior) {
      const base = this.paths(geom, 'reentry', rel, air, r.refDistance, v.id, false, 0, r.hullCutoffHz, hull);
      paths = { air: { ...base.air, gain: 0 }, body: { gain: dbToGain(r.hullGainDb), cutoff: r.hullCutoffHz } };
    } else {
      paths = this.paths(geom, 'reentry', rel, air, Math.max(r.refDistance, v.boundingRadius), v.id, true, 1, r.hullCutoffHz);
    }
    const gRatio = Math.min(1, Math.max(0, v.gLoad / r.rumble.gLoadRef));
    // The roar and the rumble are the shock layer's and the wake's: they follow the glow or the hypersonic
    // aerodynamic load, whichever is larger (after the heat pulse the capsule still decelerates at several g).
    const load = entryLoad(v.aero.q, v.aero.mach, r.load);
    return {
      roar: { gain: dbToGain(r.roar.gainDb) * Math.max(plasmaAmplitude(plasma, r.roar.exponent), load) },
      hiss: { gain: dbToGain(r.hiss.gainDb) * plasmaAmplitude(plasma, r.hiss.exponent) },
      crackle: { gain: dbToGain(r.crackle.gainDb) * plasmaAmplitude(plasma, 1), rate: lerp(r.crackle.rateHz[0], r.crackle.rateHz[1], Math.min(1, Math.max(0, plasma))) },
      rumble: { gain: dbToGain(r.rumble.gainDb) * Math.max(plasmaAmplitude(plasma, 1), load) * Math.sqrt(gRatio) },
      paths,
    };
  }

  // ---------------------------------------------------------------------------------- surface ambience

  /** The air and sea around the listener: a bed per surface type, scaled by listener pressure (0 in vacuum). */
  private ambience(snap: SimSnapshot, geom: ListenerGeometry): AmbienceTarget {
    const a = this.config.environment.ambience;
    const prop = this.config.mix.propagation;
    const v = geom.active;
    const water = v.situation === 'splashed' || v.contact.waterSubmersion > 0;
    const bed = water ? a.beds.water : a.beds.land;
    const share = water ? 1 : surfaceFactor(snap.readouts.altitudeRadar, a.surfaceAltitude[0], a.surfaceAltitude[1]);
    const level = pressureGain(geom.pressure, prop) * share * (geom.interior ? dbToGain(a.hullGainDb) : 1);
    const gains: Record<string, number> = {};
    for (const id of this.ambienceAssets) gains[id] = 0;
    if (level > 0) for (const layer of bed) gains[layer.asset] = (gains[layer.asset] ?? 0) + dbToGain(layer.gainDb) * level;
    const cutoff = geom.interior ? combineCutoffs(pressureCutoff(geom.pressure, prop), a.hullCutoffHz) : pressureCutoff(geom.pressure, prop);
    return { gains, cutoff };
  }

  // --------------------------------------------------------------------------------------------- cabin

  private cabinTarget(geom: ListenerGeometry): CabinTarget {
    const c = this.config.environment.cabin;
    if (!geom.interior) return { ambience: 0, airflow: 0, hum: 0 };
    return { ambience: dbToGain(c.ambience.gainDb), airflow: dbToGain(c.airflow.gainDb), hum: dbToGain(c.hum.gainDb) };
  }

  private creaks(active: VesselSnapshot, dt: number, out: OneShotRequest[]): void {
    const c = this.config.environment.cabin.creaks;
    const g = active.gLoad;
    const dg = this.prevG === null || dt <= 0 ? 0 : (g - this.prevG) / dt;
    const dSun = this.prevSun === null || dt <= 0 ? 0 : (active.sunVisibility - this.prevSun) / dt;
    const rate = creakRate(g, dg, dSun, c);
    const p = 1 - Math.exp(-rate * dt);
    const roll = this.creakRng.next();
    const pick = this.creakRng.next();
    const rateRoll = this.creakRng.next();
    if (roll >= p || this.time - this.lastCreak < c.minInterval) return;
    this.lastCreak = this.time;
    const extraDb = Math.min(12, Math.max(0, g - c.gMin) * c.gainPerG);
    out.push({
      bus: 'cabin',
      cause: 'creak',
      asset: c.assets[Math.floor(pick * c.assets.length)]!,
      gain: dbToGain(c.gainDb + extraDb),
      rate: 0.9 + 0.2 * rateRoll,
      direct: true,
      air: null,
      body: null,
    });
  }

  // -------------------------------------------------------------------------------------------- events

  private eventOneShot(e: SimEvent, snap: SimSnapshot, geom: ListenerGeometry, out: OneShotRequest[]): void {
    const def = this.config.events[e.type];
    if (!def) return;
    const fields = e as unknown as Record<string, unknown>;
    if (def.match) for (const [k, v] of Object.entries(def.match)) if (fields[k] !== v) return;
    if (!this.admitEvent(e.type, def)) return;
    const h = hashString(`${e.type}|${e.vesselId}|${e.ut}|${String(fields['partId'] ?? '')}`);
    let variant = h % def.assets.length;
    if (def.variantBy) {
      const value = Number(fields[def.variantBy.field]);
      variant = def.variantBy.thresholds.filter((t) => value >= t).length;
    }
    const scaleDb = def.scaleBy ? eventScaleDb(Number(fields[def.scaleBy.field]), def.scaleBy) : 0;
    const rate = def.rate ? lerp(def.rate[0], def.rate[1], ((h >>> 8) & 0xffff) / 65535) : 1;
    const gain = dbToGain(def.gainDb + scaleDb);
    const asset = def.assets[Math.min(variant, def.assets.length - 1)]!;
    if (def.source === 'listener') {
      out.push({ bus: 'events', cause: e.type, asset, gain, rate, direct: true, air: null, body: null });
      return;
    }
    const vessel = snap.vessels.find((v) => v.id === e.vesselId) ?? geom.active;
    const rel = this.eventPosition(e, def, vessel, geom);
    const prop = this.config.mix.propagation;
    // An explosion's fireball is at rest in the air; part events move with their vessel.
    const air = def.source === 'explosion' ? { velocity: v3.zero(), soundSpeed: prop.speedOfSound } : this.airOf(geom, vessel);
    const p = this.paths(geom, `event|${e.type}|${h}`, rel, air, def.refDistance, vessel.id, def.structureBorne, dbToGain(prop.events.bodyGainDb), prop.events.bodyCutoffHz);
    out.push({ bus: 'events', cause: e.type, asset, gain, rate, direct: false, air: p.air.gain > 0 ? p.air : null, body: p.body.gain > 0 ? p.body : null });
  }

  private eventPosition(e: SimEvent, def: EventSoundDef, vessel: VesselSnapshot, geom: ListenerGeometry): Vec3 {
    if (def.source === 'explosion' && e.type === 'explosion') return this.relativeRoot(geom, e.posRoot);
    if (def.source === 'part') {
      if (e.type === 'partDestroyed') return this.relative(geom, vessel, e.posVes);
      const partId = (e as { partId?: string }).partId;
      const part: PartSnapshot | undefined = partId === undefined ? undefined : vessel.parts.find((p) => p.instanceId === partId);
      if (part) return this.relative(geom, vessel, part.localPos);
    }
    return this.relative(geom, vessel, vessel.comLocal);
  }

  /** minInterval / maxVoices bookkeeping per event type (maxVoices counts plays within the asset length window of 2 s). */
  private admitEvent(type: SimEventType, def: EventSoundDef): boolean {
    const plays = (this.lastEventPlay.get(type) ?? []).filter((t) => this.time - t < 2);
    const last = plays[plays.length - 1];
    if (last !== undefined && this.time - last < def.minInterval) return false;
    if (plays.length >= def.maxVoices) return false;
    plays.push(this.time);
    this.lastEventPlay.set(type, plays);
    return true;
  }

  // ------------------------------------------------------------------------------------------------ ui

  private clicks(snap: SimSnapshot, out: OneShotRequest[], audible: boolean): void {
    const c = this.config.ui.clicks;
    let changed = false;
    for (const path of c.watch) {
      const v = readSnapshotPath(snap, path);
      if (this.watchInitialised && this.watched.get(path) !== v) changed = true;
      this.watched.set(path, v);
    }
    this.watchInitialised = true;
    if (!changed || !audible || this.time - this.lastClick < c.minInterval) return;
    this.lastClick = this.time;
    const h = hashString(`click|${snap.tick}|${snap.ut}`);
    out.push({ bus: 'ui', cause: 'click', asset: c.assets[h % c.assets.length]!, gain: dbToGain(c.gainDb), rate: 1, direct: true, air: null, body: null });
  }

  private alarm(snap: SimSnapshot): boolean {
    const a = this.config.ui.alarm;
    const active = a.conditions.some((cond) => {
      let v = readSnapshotPath(snap, cond.path);
      if (cond.equals !== null) return v === cond.equals;
      if (typeof v !== 'number') return false;
      if (cond.relativeTo !== null) {
        const ref = readSnapshotPath(snap, cond.relativeTo);
        if (typeof ref !== 'number' || ref === 0) return false;
        v = v / ref;
      }
      const x = v as number;
      return (cond.above !== null && x > cond.above) || (cond.below !== null && x < cond.below);
    });
    if (active && !this.alarmOn && this.time - this.alarmClearedAt >= a.rearm) {
      this.alarmOn = true;
      this.alarmSince = this.time;
    } else if (!active && this.alarmOn && this.time - this.alarmSince >= a.minDuration) {
      this.alarmOn = false;
      this.alarmClearedAt = this.time;
    }
    return this.alarmOn;
  }
}

/** Every loop asset any ambience bed uses, in a fixed order (the graph makes one source per asset). */
export function ambienceAssetIds(config: AudioConfig): string[] {
  const ids = new Set<string>();
  for (const bed of Object.values(config.environment.ambience.beds)) for (const l of bed) ids.add(l.asset);
  return [...ids].sort();
}
