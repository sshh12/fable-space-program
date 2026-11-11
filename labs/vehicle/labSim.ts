/**
 * Lab simulation for the vehicle package: a FakeSim (bodies, time, readouts) whose vessel list is replaced
 * by vessels assembled with the frozen vessel facade (src/sim/vessel/public.ts). It places the stack on the
 * launch mount, on a ground slab or in space, lets the lab drive module states, and fires stages with
 * `splitForStage`: the separated vessels drift apart kinematically on their separation velocities, so
 * debris is drawn as full models. It is a stand for looking at models, not physics.
 */
import type { PlayerCommands } from '@/core/contracts/controls';
import type { DefLibrary, ScenarioDef } from '@/core/contracts/defs';
import type { ModuleState, PartSnapshot, Sim, SimDebug, SimEvent, SimSnapshot, VesselSnapshot } from '@/core/contracts/sim';
import { createFakeSim, type FakeScene } from '@/core/fakes/fakeSim';
import { latLonToDir } from '@/core/geo/cubeSphere';
import { DEG, quat, v3, type Quat, type Vec3 } from '@/core/math';
import { enuAt } from '@/render/core/lab';
import { legPose } from '@/render/vehicle';
import { assembleVessel, setModuleStateForLab, splitForStage, vesselPartSnapshots, type Vessel } from '@/sim/vessel/public';

export type LabPlace =
  /** Standing on the launch mount of a site: lowest point at pad elevation + clamp height. */
  | { kind: 'pad'; siteId: string; padElevation: number }
  /** Lowest point at `height` above the reference radius of a body. */
  | { kind: 'ground'; bodyId: string; latDeg: number; lonDeg: number; height: number; headingDeg: number }
  /** Where the FakeSim scene puts its vessel; attitude: nose across the sun line, dorsal side to the zenith. */
  | { kind: 'space' };

export interface LabSimOptions {
  scene: FakeScene;
  vehicleId: string;
  stagesFired: number;
  place: LabPlace;
  /** Keep only these part instance ids (to look at one part or one stage alone). */
  onlyParts?: string[];
  ut?: number;
}

interface LabVessel {
  vessel: Vessel;
  parts: PartSnapshot[];
  /** Lab time at which this vessel appeared (separation), for the kinematic drift. */
  t0: number;
}

export type SunSpec =
  /** Compass azimuth / elevation at the placement point, degrees. */
  | { kind: 'local'; azDeg: number; elDeg: number }
  /** Direction in the vessel frame (VES axes). */
  | { kind: 'vessel'; dir: [number, number, number]; focus?: string };

/** Stable number in [0, 1) from a vessel id (which way a piece on the axis drifts off it). */
function hash01(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return ((h >>> 0) % 100000) / 100000;
}

export class VehicleLabSim implements Sim {
  readonly defs: DefLibrary;
  private readonly fake: Sim;
  private readonly vehicleId: string;
  private place: LabPlace;
  private list: LabVessel[] = [];
  private stage: number;
  private t = 0;
  private drift = true;
  private solo: string | null = null;
  private sun: SunSpec | null = null;
  private pendingEvents: SimEvent[] = [];
  private removed = new Set<string>();
  readonly mainId: string;

  constructor(defs: DefLibrary, opts: LabSimOptions) {
    this.defs = defs;
    this.fake = createFakeSim(defs, { scene: opts.scene, ...(opts.ut !== undefined ? { ut: opts.ut } : {}) });
    this.vehicleId = opts.vehicleId;
    this.place = opts.place;
    this.stage = opts.stagesFired;
    const vessel = assembleVessel(defs, opts.vehicleId, { stagesAlreadyFired: opts.stagesFired });
    vessel.id = opts.vehicleId;
    this.mainId = vessel.id;
    let parts = vesselPartSnapshots(vessel);
    if (opts.onlyParts) parts = parts.filter((p) => opts.onlyParts!.includes(p.instanceId));
    this.list.push({ vessel, parts, t0: 0 });
  }

  // ------------------------------------------------------------------------------------------ lab API

  get nextStage(): number {
    return this.stage;
  }

  /** Labels of the vehicle's stage stack, in firing order. */
  get stageLabels(): string[] {
    return this.defs.vehicles[this.vehicleId]!.stages.map((s) => s.label);
  }

  get placement(): LabPlace {
    return this.place;
  }

  get vesselIds(): string[] {
    return this.list.map((v) => v.vessel.id);
  }

  partsOf(vesselId: string): PartSnapshot[] {
    const v = this.list.find((x) => x.vessel.id === vesselId);
    if (!v) throw new Error(`lab sim: no vessel "${vesselId}"`);
    return v.parts;
  }

  /** Merge a patch into one module state (any vessel that holds the part). */
  setModule(instanceId: string, moduleIndex: number, patch: Record<string, unknown>): void {
    for (const v of this.list) {
      if (v.parts.some((p) => p.instanceId === instanceId)) {
        setModuleStateForLab(v.parts, instanceId, moduleIndex, patch);
        return;
      }
    }
    throw new Error(`lab sim: no part "${instanceId}"`);
  }

  /** Patch every module of a type on every vessel; returns how many were changed. */
  setAll(type: ModuleState['type'], patch: Record<string, unknown>, filter?: (part: PartSnapshot) => boolean): number {
    let n = 0;
    for (const v of this.list) {
      for (const p of v.parts) {
        if (filter && !filter(p)) continue;
        p.modules.forEach((m, i) => {
          if (m.type === type) {
            setModuleStateForLab(v.parts, p.instanceId, i, patch);
            n++;
          }
        });
      }
    }
    return n;
  }

  /** Run engines at a throttle (thrust follows the definition's vacuum thrust). */
  setEngines(throttle: number, filter?: (part: PartSnapshot) => boolean, gimbal: [number, number] = [0, 0]): number {
    let n = 0;
    for (const v of this.list) {
      for (const p of v.parts) {
        if (filter && !filter(p)) continue;
        const def = this.defs.parts[p.def]!;
        p.modules.forEach((m, i) => {
          const md = def.modules[i]!;
          if (m.type !== 'engine' || md.type !== 'engine') return;
          setModuleStateForLab(v.parts, p.instanceId, i, { active: throttle > 0, throttleActual: throttle, thrust: md.thrustVac * throttle, gimbal });
          n++;
        });
      }
    }
    return n;
  }

  setSkinTemperature(instanceId: string, kelvin: number): void {
    for (const v of this.list) for (const p of v.parts) if (p.instanceId === instanceId) p.tempSkin = kelvin;
  }

  /** Fire the next stage of the main vessel structurally; the separated vessels start drifting. */
  fireStage(): { stage: number; spawned: string[] } {
    const main = this.list[0]!;
    const index = this.stage;
    const res = splitForStage(this.defs, main.vessel, index);
    // Module states the lab changed on the old vessel are carried over by instance id.
    const carry = new Map<string, PartSnapshot>();
    for (const v of this.list) for (const p of v.parts) carry.set(p.instanceId, p);
    const adopt = (vessel: Vessel): PartSnapshot[] =>
      vesselPartSnapshots(vessel).map((p) => {
        const old = carry.get(p.instanceId);
        if (old) p.tempSkin = old.tempSkin;
        return p;
      });
    // Positions are kept continuous: the continuing vessel inherits the drift it had so far.
    const dtMain = this.drift ? this.t - main.t0 : 0;
    const base = v3.addScaled(main.vessel.r, main.vessel.v, dtMain);
    const shift = v3.sub(base, main.vessel.r);
    res.vessel.r = v3.add(res.vessel.r, shift);
    this.list[0] = { vessel: res.vessel, parts: adopt(res.vessel), t0: this.t };
    const centreOf = (vessel: Vessel, parts: PartSnapshot[]): Vec3 => {
      let c = v3.zero();
      for (const p of parts) c = v3.add(c, p.localPos);
      return v3.add(vessel.r, v3.scale(c, 1 / Math.max(1, parts.length)));
    };
    const mainCentre = centreOf(res.vessel, this.list[0].parts);
    for (const s of res.spawned) {
      s.r = v3.add(s.r, shift);
      const parts = adopt(s);
      // The lab's stack does not accelerate, so what it drops would hang beside it and be run through by the
      // next stage. A piece that leaves therefore gets the relative motion it has in flight: jettisoned
      // hardware ahead of the stack (escape tower, fairing petals) is thrown forward and aside, spent
      // hardware behind it falls back and drifts off the axis.
      const c = v3.sub(centreOf(s, parts), mainCentre);
      const side = Math.hypot(c.x, c.z);
      const az = hash01(s.id) * 2 * Math.PI;
      const out = side > 0.3 ? v3.new(c.x / side, 0, c.z / side) : v3.new(Math.sin(az), 0, Math.cos(az));
      const ahead = c.y > 0;
      s.v = v3.add(s.v, v3.add(v3.scale(out, ahead ? 7 : 2.5), v3.new(0, ahead ? 16 : -7, 0)));
      this.list.push({ vessel: s, parts, t0: this.t });
    }
    this.stage = index + 1;
    return { stage: index, spawned: res.spawned.map((s) => s.id) };
  }

  /** Remove a vessel as the simulation would expire small debris (the feature fades it out). */
  expire(vesselId: string): void {
    const i = this.list.findIndex((v) => v.vessel.id === vesselId);
    if (i <= 0) throw new Error(`lab sim: cannot expire "${vesselId}"`);
    this.list.splice(i, 1);
    this.removed.add(vesselId);
    this.pendingEvents.push({ type: 'vesselRemoved', ut: 0, vesselId, reason: 'expired' });
  }

  /**
   * Show one vessel alone: every vessel whose id and part instance ids do not contain the text is parked
   * 200 km away (null = everything where it is). For pictures of one separated piece with nothing of the
   * rest of the stack in the frame or between it and the sun.
   */
  setSolo(text: string | null): void {
    this.solo = text;
  }

  /** Freeze or resume the kinematic drift of separated vessels. */
  setDrift(on: boolean): void {
    this.drift = on;
  }

  setSun(sun: SunSpec | null): void {
    this.sun = sun;
  }

  setPlace(place: LabPlace): void {
    this.place = place;
  }

  // ------------------------------------------------------------------------------------------ placing

  /** Lowest point of a vessel along its Y axis (upright parts). */
  private baseY(parts: PartSnapshot[]): number {
    let y = Infinity;
    for (const p of parts) {
      const def = this.defs.parts[p.def]!;
      const legs = p.modules.find((m) => m.type === 'legs');
      let low = def.bounds.yMin;
      if (legs && legs.type === 'legs') {
        // A vessel on legs stands on its foot pads: the contact point of every leg for its deployment and
        // stroke, one contact radius below the foot joint (where the pad's underside is drawn).
        const legsDef = def.modules.find((m) => m.type === 'legs');
        if (legs.deploy < 0.5 || !legsDef || legsDef.type !== 'legs') low = 0;
        else {
          low = Infinity;
          legsDef.legs.forEach((leg, i) => {
            const contact = def.contactPoints?.[i]?.radius ?? def.contactPoints?.[0]?.radius ?? 0;
            low = Math.min(low, legPose(leg, legs.deploy, legs.compression[i] ?? 0).foot[1] - contact);
          });
        }
      }
      y = Math.min(y, p.localPos.y + low);
    }
    return Number.isFinite(y) ? y : 0;
  }

  /** Pose of the assembly frame (the main vessel's VES at separation time) in ROOT, and the local ENU there. */
  private anchor(snap: SimSnapshot): { origin: Vec3; q: Quat; east: Vec3; north: Vec3; up: Vec3; bodyId: string } {
    const place = this.place;
    const fakeVessel = snap.vessels[0]!;
    if (place.kind === 'space') {
      const body = snap.bodies.find((b) => b.id === fakeVessel.bodyId)!;
      const up = v3.normalize(v3.sub(fakeVessel.rRoot, body.rRoot));
      const star = snap.bodies.find((b) => b.id === snap.starId)!;
      const toSun = v3.normalize(v3.sub(star.rRoot, fakeVessel.rRoot));
      let y = v3.cross(toSun, up);
      y = v3.lenSq(y) < 1e-8 ? v3.anyOrthogonal(up) : v3.normalize(y);
      const z = up;
      const x = v3.cross(y, z);
      return { origin: fakeVessel.rRoot, q: quat.fromBasis(x, y, z), east: x, north: y, up, bodyId: body.id };
    }
    const bodyId = place.kind === 'pad' ? this.defs.sites[place.siteId]!.bodyId : place.bodyId;
    const site = place.kind === 'pad' ? this.defs.sites[place.siteId]! : null;
    const lat = site ? site.location.latDeg : (place as { latDeg: number }).latDeg;
    const lon = site ? site.location.lonDeg : (place as { lonDeg: number }).lonDeg;
    const body = snap.bodies.find((b) => b.id === bodyId)!;
    const { east, north, up } = enuAt(body.qFixedToRoot, latLonToDir(lat * DEG, lon * DEG));
    const radius = this.defs.bodies[bodyId]!.radius;
    const baseHeight = place.kind === 'pad' ? place.padElevation + site!.pad.clampHeight : place.height;
    const az = (place.kind === 'pad' ? site!.padAzimuthDeg : place.headingDeg) * DEG;
    // Ventral side (-Z) faces the pad azimuth; +Y up.
    const z = v3.neg(v3.add(v3.scale(east, Math.sin(az)), v3.scale(north, Math.cos(az))));
    const x = v3.cross(up, z);
    const origin = v3.addScaled(body.rRoot, up, radius + baseHeight - this.baseY(this.list[0]!.parts));
    return { origin, q: quat.fromBasis(x, up, z), east, north, up, bodyId };
  }

  private decorate(snap: SimSnapshot, drain: boolean): SimSnapshot {
    const template = snap.vessels[0]!;
    // Sun override: move the star so that every consumer (lighting, shadows, exposure) agrees.
    const a0 = this.anchor(snap);
    if (this.sun) {
      let dir: Vec3;
      if (this.sun.kind === 'local') {
        const az = this.sun.azDeg * DEG;
        const el = this.sun.elDeg * DEG;
        dir = v3.add(v3.scale(v3.add(v3.scale(a0.east, Math.sin(az)), v3.scale(a0.north, Math.cos(az))), Math.cos(el)), v3.scale(a0.up, Math.sin(el)));
      } else {
        // In the frame of the main vessel, or of the separated vessel named by `focus` (which may be tumbling).
        const text = this.sun.focus;
        const lv = text ? this.list.find((x) => x.vessel.id.includes(text) || x.parts.some((p) => p.instanceId.includes(text))) : undefined;
        const q = lv ? quat.normalize(quat.mul(a0.q, quat.normalize(quat.mul(lv.vessel.q, quat.fromRotVec(v3.scale(lv.vessel.w, this.drift ? this.t - lv.t0 : 0)))))) : a0.q;
        dir = quat.rotate(q, v3.normalize(v3.fromTuple(this.sun.dir)));
      }
      const star = snap.bodies.find((b) => b.id === snap.starId)!;
      const centre = snap.bodies.find((b) => b.id === a0.bodyId)!;
      star.rRoot = v3.addScaled(centre.rRoot, dir, 1.495978707e11);
      for (const b of snap.bodies) {
        if (b.id === star.id) continue;
        const d = v3.sub(star.rRoot, b.rRoot);
        b.sunDir = v3.normalize(d);
        b.sunDistance = v3.len(d);
      }
    }
    // The anchor is taken before the override, so a sun given in the vessel frame stays where it was put.
    const a = a0;
    const body = snap.bodies.find((b) => b.id === a.bodyId)!;
    const surface = this.place.kind !== 'space';
    const spin = body.spinRoot;
    const vessels: VesselSnapshot[] = this.list.map((lv, index) => {
      const v = lv.vessel;
      const dt = this.drift ? this.t - lv.t0 : 0;
      const solo = this.solo;
      const parked = solo !== null && !(v.id.includes(solo) || lv.parts.some((p) => p.instanceId.includes(solo)));
      const rA = v3.add(v3.addScaled(v.r, v.v, dt), v3.new(0, parked ? 2e5 : 0, 0));
      const qA = quat.normalize(quat.mul(v.q, quat.fromRotVec(v3.scale(v.w, dt))));
      const rRoot = v3.add(a.origin, quat.rotate(a.q, rA));
      const anchorVel = surface ? v3.add(body.vRoot, v3.cross(spin, v3.sub(a.origin, body.rRoot))) : template.vRoot;
      const vRoot = v3.add(anchorVel, quat.rotate(a.q, v.v));
      let radius = 1;
      for (const p of lv.parts) {
        const d = this.defs.parts[p.def]!;
        radius = Math.max(radius, v3.len(p.localPos) + Math.hypot(d.bounds.radius, Math.max(Math.abs(d.bounds.yMin), Math.abs(d.bounds.yMax))));
      }
      return {
        ...template,
        id: v.id,
        name: v.name,
        vehicleId: this.vehicleId,
        controllable: index === 0,
        bodyId: a.bodyId,
        situation: surface && index === 0 && this.stage === 0 ? 'prelaunch' : surface && this.place.kind === 'ground' && index === 0 ? 'landed' : template.situation === 'prelaunch' ? 'flying' : template.situation,
        r: v3.sub(rRoot, body.rRoot),
        v: v3.sub(vRoot, body.vRoot),
        rRoot,
        vRoot,
        q: quat.normalize(quat.mul(a.q, qA)),
        w: v.w,
        mass: v.mp.mass,
        comLocal: v.mp.com,
        boundingRadius: radius,
        parts: lv.parts,
        thrust: 0,
        age: this.t - lv.t0,
      };
    });
    const events = drain ? this.pendingEvents.map((e) => ({ ...e, ut: snap.ut })) : [];
    if (drain) this.pendingEvents = [];
    return { ...snap, vessels, activeVesselId: this.mainId, events: [...snap.events, ...events] };
  }

  // -------------------------------------------------------------------------------------------- Sim

  get scenario(): ScenarioDef {
    return this.fake.scenario;
  }
  get ready(): Promise<void> {
    return this.fake.ready;
  }
  terrainPending(): Promise<void> | null {
    return null;
  }
  advance(realDt: number, onControlTick?: () => void): void {
    this.fake.advance(realDt, onControlTick);
    this.t += Math.max(0, Math.min(0.1, realDt));
  }
  step(): void {
    this.fake.step();
    this.t += 1 / 120;
  }
  advanceRails(targetUt: number): number {
    return this.fake.advanceRails(targetUt);
  }
  get needsIntegration(): boolean {
    return true;
  }
  get nextEventUt(): number {
    return Infinity;
  }
  setControls(inputs: Parameters<Sim['setControls']>[0]): void {
    this.fake.setControls(inputs);
  }
  get commands(): PlayerCommands {
    return this.fake.commands;
  }
  snapshot(): SimSnapshot {
    return this.decorate(this.fake.snapshot(), true);
  }
  peek(): SimSnapshot {
    return this.decorate(this.fake.peek(), false);
  }
  get cheatCounter(): number {
    return this.fake.cheatCounter;
  }
  stateHash(): string {
    return `${this.fake.stateHash()}|${this.stage}|${this.list.length}`;
  }
  get debug(): SimDebug {
    return this.fake.debug;
  }
}
