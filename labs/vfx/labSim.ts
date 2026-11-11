/**
 * LabSim: the vfx lab's stand-in simulation. Bodies, sun and time come from the FakeSim; the vessels are
 * placed and driven by the lab itself (real assembled parts from the vessel facade, module states, aero
 * state and events written directly), so that every regime can be shown without flying there.
 *
 * Vessels live in the east / north / up frame of a "site": a point fixed on a body. They move with the
 * rotating body, so `velEnu` is the velocity relative to the air.
 */
import { NEUTRAL_CONTROLS } from '@/core/contracts/controls';
import type { DefLibrary, ModuleDef, ScenarioDef } from '@/core/contracts/defs';
import type { ModuleState, PartSnapshot, Sim, SimDebug, SimEvent, SimSnapshot, VesselAeroState, VesselSituation, VesselSnapshot } from '@/core/contracts/sim';
import { createFakeSim } from '@/core/fakes/fakeSim';
import { latLonToDir } from '@/core/geo/cubeSphere';
import { DEG, G0, quat, v3, type Quat, type Vec3 } from '@/core/math';

export interface LabSite {
  bodyId: string;
  latDeg: number;
  lonDeg: number;
  /** Height of the site origin above the body's reference radius, m. */
  alt: number;
}

export interface LabVessel {
  id: string;
  name: string;
  parts: PartSnapshot[];
  /** VES origin relative to the site origin (east, north, up), m, and velocity relative to the rotating body, m/s. */
  enu: Vec3;
  velEnu: Vec3;
  /** VES -> site ENU orientation (identity = +Y nose pointing north; use `noseUp()` for a standing vehicle). */
  qVesToEnu: Quat;
  /** Angular velocity in the VES frame, rad/s (kinematic: applied to qVesToEnu by the sim). */
  w: Vec3;
  aero: VesselAeroState;
  boundingRadius: number;
  situation: VesselSituation;
  controllable: boolean;
  waterSubmersion: number;
  age: number;
}

export type LabScript = (sim: LabSim, t: number, dt: number) => void;

type EngineDef = Extract<ModuleDef, { type: 'engine' }>;
type EngineState = Extract<ModuleState, { type: 'engine' }>;

/** VES -> ENU orientation of a vehicle standing nose up with its ventral side (-Z) facing `azimuthDeg`. */
export function noseUp(azimuthDeg = 90): Quat {
  const a = azimuthDeg * DEG;
  const y = v3.unitZ();
  const z = v3.neg({ x: Math.sin(a), y: Math.cos(a), z: 0 });
  return quat.fromBasis(v3.cross(y, z), y, z);
}

/** VES -> ENU orientation with the nose along `nose` and the dorsal side as close to `dorsal` as possible (ENU vectors). */
export function noseAlong(nose: Vec3, dorsal: Vec3 = v3.unitZ()): Quat {
  const y = v3.normalize(nose);
  let z = v3.reject(dorsal, y);
  if (v3.lenSq(z) < 1e-9) z = v3.anyOrthogonal(y);
  z = v3.normalize(z);
  return quat.fromBasis(v3.cross(y, z), y, z);
}

export const stillAir = (pressure = 0, density = 0, temperature = 4): VesselAeroState => ({
  q: 0,
  mach: 0,
  aoa: 0,
  airDensity: density,
  pressure,
  temperature,
  airVelocity: v3.zero(),
  heatFlux: 0,
  plasmaIntensity: 0,
});

/** Standard-atmosphere-like pressure (Pa), density (kg/m^3) and temperature (K) for lab scenes on a body with air. */
export function labAtmosphere(altitude: number): { pressure: number; density: number; temperature: number } {
  const h = Math.max(0, altitude);
  let temperature: number;
  let pressure: number;
  if (h < 11000) {
    temperature = 288.15 - 0.0065 * h;
    pressure = 101325 * Math.pow(temperature / 288.15, 5.2559);
  } else if (h < 20000) {
    temperature = 216.65;
    pressure = 22632 * Math.exp(-(h - 11000) / 6341.6);
  } else if (h < 32000) {
    temperature = 216.65 + 0.001 * (h - 20000);
    pressure = 5474.9 * Math.pow(216.65 / temperature, 34.163);
  } else if (h < 47000) {
    temperature = 228.65 + 0.0028 * (h - 32000);
    pressure = 868.02 * Math.pow(228.65 / temperature, 12.2011);
  } else {
    temperature = Math.max(186, 270.65 - 0.0028 * Math.max(0, h - 51000));
    pressure = 110.91 * Math.exp(-(h - 47000) / 7200);
  }
  if (h > 140000) pressure = 0;
  return { pressure, density: pressure / (287.05 * temperature), temperature };
}

export class LabSim implements Sim {
  readonly defs: DefLibrary;
  readonly scenario: ScenarioDef;
  readonly ready: Promise<void> = Promise.resolve();
  readonly debug: SimDebug;
  readonly site: LabSite;
  vessels: LabVessel[] = [];
  activeIndex = 0;
  /** Seconds of lab time since the start (advances with the sim). */
  time = 0;
  /** Called before every snapshot is built while the sim advances. */
  script: LabScript | null = null;
  /** Height of the active vessel's lowest point above the ground / sea (Readouts.altitudeRadar); null = far away. */
  radarAltitude: number | null = null;
  /** Throttle lever shown in the readouts. */
  throttle = 0;
  private readonly fake: Sim;
  private pending: SimEvent[] = [];

  constructor(defs: DefLibrary, site: LabSite, ut?: number) {
    this.defs = defs;
    this.site = site;
    this.fake = createFakeSim(defs, { scene: 'lowOrbit', ut });
    this.scenario = { ...this.fake.scenario, id: 'vfx-lab', name: 'vfx lab' };
    this.debug = this.fake.debug;
  }

  get commands(): Sim['commands'] {
    return this.fake.commands;
  }
  get needsIntegration(): boolean {
    return true;
  }
  get nextEventUt(): number {
    return Infinity;
  }
  get cheatCounter(): number {
    return this.fake.cheatCounter;
  }
  terrainPending(): Promise<void> | null {
    return null;
  }
  setControls(): void {
    this.fake.setControls({ ...NEUTRAL_CONTROLS, translate: v3.zero() });
  }
  stateHash(): string {
    return `${this.time.toFixed(6)}`;
  }

  advance(realDt: number): void {
    const dt = Math.min(0.1, Math.max(0, realDt));
    this.fake.advance(dt);
    this.time += dt;
    for (const v of this.vessels) {
      v.enu = v3.addScaled(v.enu, v.velEnu, dt);
      v.age += dt;
      if (v3.lenSq(v.w) > 0) v.qVesToEnu = quat.normalize(quat.mul(v.qVesToEnu, quat.fromRotVec(v3.scale(v.w, dt))));
    }
    this.script?.(this, this.time, dt);
  }
  step(): void {
    this.advance(1 / 120);
  }
  advanceRails(targetUt: number): number {
    return targetUt;
  }

  /** Queue an event for the next snapshot. */
  emit(event: SimEvent): void {
    this.pending.push(event);
  }
  get ut(): number {
    return this.fake.peek().ut;
  }

  addVessel(v: Partial<LabVessel> & { id: string; parts: PartSnapshot[] }): LabVessel {
    const vessel: LabVessel = {
      name: v.id,
      enu: v3.zero(),
      velEnu: v3.zero(),
      qVesToEnu: noseUp(),
      w: v3.zero(),
      aero: stillAir(),
      boundingRadius: 60,
      situation: 'flying',
      controllable: true,
      waterSubmersion: 0,
      age: 0,
      ...v,
    };
    this.vessels.push(vessel);
    return vessel;
  }

  vessel(id: string): LabVessel {
    const v = this.vessels.find((x) => x.id === id);
    if (!v) throw new Error(`LabSim: no vessel "${id}"`);
    return v;
  }

  /** Engine modules of a vessel, optionally only those of parts whose def id is `partDef`. */
  engines(vessel: LabVessel, partDef?: string): { part: PartSnapshot; def: EngineDef; state: EngineState }[] {
    const out: { part: PartSnapshot; def: EngineDef; state: EngineState }[] = [];
    for (const part of vessel.parts) {
      if (partDef && part.def !== partDef) continue;
      const pd = this.defs.parts[part.def];
      part.modules.forEach((m, i) => {
        const md = pd?.modules[i];
        if (m.type === 'engine' && md?.type === 'engine') out.push({ part, def: md, state: m });
      });
    }
    return out;
  }

  /**
   * Write the module state of running engines the way the simulation does: thrust and mass flow from the
   * throttle and the vessel's ambient pressure, pressure ratio exit / ambient.
   */
  setEngines(vessel: LabVessel, partDef: string | undefined, s: { throttle: number; ignitionAge?: number; shutdownAge?: number; gimbal?: [number, number] }): void {
    const pressure = vessel.aero.pressure;
    for (const e of this.engines(vessel, partDef)) {
      const massFlow = (s.throttle * e.def.thrustVac) / (e.def.ispVac * G0);
      const isp = e.def.ispVac - (e.def.ispVac - e.def.ispSL) * (pressure / 101325);
      e.state.active = s.throttle > 0;
      e.state.throttleActual = s.throttle;
      e.state.massFlow = massFlow;
      e.state.thrust = Math.max(0, massFlow * G0 * isp);
      e.state.ambientPressure = pressure;
      e.state.pressureRatio = pressure > 0 ? Math.min(1e6, ((e.def.nozzles[0]?.exitPressure ?? 0) * s.throttle) / pressure) : 1e6;
      e.state.ignitionAge = s.ignitionAge ?? (s.throttle > 0 ? 100 : -1);
      e.state.shutdownAge = s.shutdownAge ?? -1;
      if (s.gimbal) e.state.gimbal = s.gimbal;
    }
  }

  /** Site origin and ENU axes in the ROOT frame for a snapshot of the bodies. */
  siteFrame(snap: SimSnapshot): { origin: Vec3; east: Vec3; north: Vec3; up: Vec3; q: Quat; body: SimSnapshot['bodies'][number] } {
    const body = snap.bodies.find((b) => b.id === this.site.bodyId);
    if (!body) throw new Error(`LabSim: unknown body "${this.site.bodyId}"`);
    const dir = latLonToDir(this.site.latDeg * DEG, this.site.lonDeg * DEG);
    let e = v3.cross(v3.unitZ(), dir);
    e = v3.lenSq(e) < 1e-12 ? v3.unitY() : v3.normalize(e);
    const n = v3.cross(dir, e);
    const east = quat.rotate(body.qFixedToRoot, e);
    const north = quat.rotate(body.qFixedToRoot, n);
    const up = quat.rotate(body.qFixedToRoot, dir);
    const radius = this.defs.bodies[this.site.bodyId]!.radius + this.site.alt;
    return { origin: v3.addScaled(body.rRoot, up, radius), east, north, up, q: quat.fromBasis(east, north, up), body };
  }

  private build(base: SimSnapshot, events: SimEvent[]): SimSnapshot {
    const f = this.siteFrame(base);
    const toRoot = (v: Vec3): Vec3 => v3.add(v3.add(v3.scale(f.east, v.x), v3.scale(f.north, v.y)), v3.scale(f.up, v.z));
    const vessels: VesselSnapshot[] = this.vessels.map((lv) => {
      const rRoot = v3.add(f.origin, toRoot(lv.enu));
      const r = v3.sub(rRoot, f.body.rRoot);
      const vAir = toRoot(lv.velEnu);
      const v = v3.add(v3.cross(f.body.spinRoot, r), vAir);
      let thrust = 0;
      for (const p of lv.parts) for (const m of p.modules) if (m.type === 'engine') thrust += m.thrust;
      return {
        id: lv.id,
        name: lv.name,
        vehicleId: '',
        controllable: lv.controllable,
        tier: 'full',
        situation: lv.situation,
        translationMode: 'integrated',
        bodyId: this.site.bodyId,
        r,
        v,
        rRoot,
        vRoot: v3.add(f.body.vRoot, v),
        q: quat.normalize(quat.mul(f.q, lv.qVesToEnu)),
        w: v3.clone(lv.w),
        mass: 50000,
        comLocal: v3.zero(),
        boundingRadius: lv.boundingRadius,
        parts: lv.parts,
        aero: { ...lv.aero, airVelocity: vAir },
        gLoad: 1,
        properAccel: v3.zero(),
        contact: { anyContact: lv.situation === 'landed' || lv.situation === 'prelaunch', maxForce: 0, waterSubmersion: lv.waterSubmersion },
        sunVisibility: 1,
        thrust,
        age: lv.age,
      };
    });
    const active = this.vessels[this.activeIndex] ?? this.vessels[0];
    const altitude = active ? this.site.alt + active.enu.z : this.site.alt;
    return {
      ...base,
      vessels,
      activeVesselId: active?.id ?? base.activeVesselId,
      events: [...base.events, ...events],
      readouts: {
        ...base.readouts,
        altitudeAsl: altitude,
        altitudeRadar: this.radarAltitude ?? Math.max(altitude, 0),
        throttle: this.throttle,
        speedSurface: active ? v3.len(active.velEnu) : 0,
      },
    };
  }

  snapshot(): SimSnapshot {
    const events = this.pending;
    this.pending = [];
    return this.build(this.fake.snapshot(), events);
  }

  peek(): SimSnapshot {
    return this.build(this.fake.peek(), this.pending.slice());
  }
}

/**
 * A start time (seconds since J2000) at which the sun stands `elevationDeg` above the horizon of the site,
 * rising or setting as close as the day allows; found by scanning one day of the FakeSim's sky.
 */
export function utForSunElevation(defs: DefLibrary, site: LabSite, elevationDeg: number, from = 8.89e8): number {
  let best = from;
  let bestErr = Infinity;
  const dir = latLonToDir(site.latDeg * DEG, site.lonDeg * DEG);
  const day = site.bodyId === defs.rootBodyId ? 86400 : 86400 * 29.6;
  for (let i = 0; i < 720; i++) {
    const ut = from + (i / 720) * day;
    const snap = createFakeSim(defs, { scene: 'lowOrbit', ut }).peek();
    const body = snap.bodies.find((b) => b.id === site.bodyId);
    if (!body) break;
    const up = quat.rotate(body.qFixedToRoot, dir);
    const el = Math.asin(Math.min(1, Math.max(-1, v3.dot(up, body.sunDir)))) / DEG;
    const err = Math.abs(el - elevationDeg);
    if (err < bestErr) {
      bestErr = err;
      best = ut;
    }
  }
  return best;
}
