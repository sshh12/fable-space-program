/**
 * The effect director: turns the snapshot (module states, aero state, events) into particle emitters,
 * flashes, fireballs and splashes, in the coordinates of the effect domain. CPU only; every random choice
 * is an integer hash of what caused it, so the same event stream produces the same effects.
 */
import type { DefLibrary, PartDef } from '@/core/contracts/defs';
import type { FrameContext } from '@/core/contracts/render';
import type { PartSnapshot, SimEvent, SimSnapshot, VesselSnapshot } from '@/core/contracts/sim';
import { latLonToDir } from '@/core/geo/cubeSphere';
import { DEG, hashU32, quat, v3, type Vec3, type Vec3Tuple } from '@/core/math';
import type { VfxData } from './data';
import { EffectDomain, type DomainFrame } from './domain';
import type { EmitterDesc } from './particles';
import type { PlacedCluster } from './plumes';

export interface Flash {
  /** Domain coordinates. */
  pos: Vec3;
  start: number;
  /** e-folding time, s. */
  time: number;
  /** Peak luminous intensity, cd, and colour. */
  intensity: number;
  color: Vec3Tuple;
  range: number;
}

export interface FireballSpawn {
  pos: Vec3;
  vel: Vec3;
  energy: number;
  seed: number;
}

export interface SplashSpawn {
  /** Entry point on the water, domain coordinates. */
  pos: Vec3;
  radius: number;
  speed: number;
  seed: number;
}

export interface DirectorOutput {
  emitters: EmitterDesc[];
  fireballs: FireballSpawn[];
  splashes: SplashSpawn[];
  /** Ground and water level in the domain as dot(up, p); null = unknown / none. */
  ground: number | null;
  water: number | null;
  /** True when the ground under the focus vessel is the flat pad of a launch site (pad smoke replaces dust). */
  onPad: boolean;
}

const hashSeed = (...parts: (number | string)[]): number => {
  let h = 0x9e3779b9;
  for (const p of parts) {
    if (typeof p === 'number') h = hashU32((h ^ (Math.round(p * 1000) | 0)) >>> 0);
    else for (let i = 0; i < p.length; i++) h = hashU32((h ^ p.charCodeAt(i)) >>> 0);
  }
  return h >>> 0;
};

/** Lowest point of a vessel's part envelopes along `upVes` (vessel frame): dot(up, p) of that point (<= 0 below the origin). */
export function lowestPoint(defs: DefLibrary, vessel: VesselSnapshot, upVes: Vec3): number {
  let low = Infinity;
  for (const part of vessel.parts) {
    const def = defs.parts[part.def];
    if (!def) continue;
    const axis = quat.rotate(part.localRot, v3.unitY());
    const c = v3.dot(axis, upVes);
    const side = def.bounds.radius * Math.sqrt(Math.max(0, 1 - c * c));
    for (const y of [def.bounds.yMin, def.bounds.yMax]) {
      const p = v3.addScaled(part.localPos, axis, y);
      low = Math.min(low, v3.dot(p, upVes) - side);
    }
  }
  return Number.isFinite(low) ? low : 0;
}

export class EffectDirector {
  private readonly acc = new Map<string, number>();
  private readonly liftoff = new Map<string, number>();
  private lastEvents: readonly SimEvent[] | null = null;
  readonly flashes: Flash[] = [];
  private frameCounter = 0;

  constructor(
    private readonly defs: DefLibrary,
    private readonly data: VfxData,
  ) {}

  /** Whole particles to emit now for a source running at `rate` per second (carries the fraction over). */
  private take(key: string, rate: number, dt: number): number {
    const a = (this.acc.get(key) ?? 0) + rate * dt;
    const n = Math.floor(a);
    this.acc.set(key, a - n);
    return n;
  }

  update(frame: FrameContext, dom: DomainFrame, clusters: PlacedCluster[], effectTime: number, dt: number): DirectorOutput {
    const snap = frame.snapshot;
    const out: DirectorOutput = { emitters: [], fireballs: [], splashes: [], ground: null, water: null, onPad: false };
    const data = this.data;
    const P = data.particles;
    const up = dom.up;
    const domOriginRel = v3.sub(dom.originRoot, frame.camera.positionRoot);
    const toDom = (rel: Vec3): Vec3 => quat.rotateInv(dom.q, v3.sub(rel, domOriginRel));
    const dirDom = (d: Vec3): Vec3 => quat.rotateInv(dom.q, d);
    const surface = dom.state.kind === 'surface';
    const bodyDef = this.defs.bodies[dom.state.bodyId]!;
    this.frameCounter++;

    const vesselDom = (v: VesselSnapshot): { pos: Vec3; vel: Vec3; q: typeof v.q } | null => {
      const pose = frame.vesselPose(v.id);
      if (!pose || v.bodyId !== dom.state.bodyId) return null;
      return { pos: toDom(pose.originRelCam), vel: EffectDomain.velToDomain(dom, snap, v.rRoot, v.vRoot), q: pose.q };
    };
    const partFrame = (vd: { pos: Vec3; q: VesselSnapshot['q'] }, part: PartSnapshot): { origin: Vec3; axis: Vec3 } => ({
      origin: v3.add(vd.pos, dirDom(quat.rotate(vd.q, part.localPos))),
      axis: dirDom(quat.rotate(vd.q, quat.rotate(part.localRot, v3.unitY()))),
    });

    // ---- ground and water under the focus vessel
    const focus = snap.vessels.find((v) => v.id === snap.activeVesselId);
    if (surface) {
      if (bodyDef.ocean) out.water = bodyDef.radius + bodyDef.ocean.seaLevel - v3.len(dom.state.origin);
      if (focus) {
        const fd = vesselDom(focus);
        if (fd) {
          const radar = snap.readouts.altitudeRadar;
          if (Number.isFinite(radar) && radar < 5000) {
            const upVes = quat.rotateInv(focus.q, quat.rotate(dom.q, up));
            out.ground = v3.dot(up, fd.pos) + lowestPoint(this.defs, focus, upVes) - radar;
          }
          // The flat pad of a launch site is exact: prefer it while the vessel is over it.
          for (const site of Object.values(this.defs.sites)) {
            if (site.bodyId !== dom.state.bodyId) continue;
            const pe = site.location.padElevation;
            if (typeof pe !== 'number') continue;
            const dirFixed = latLonToDir(site.location.latDeg * DEG, site.location.lonDeg * DEG);
            const pFixed = v3.scale(dirFixed, bodyDef.radius + pe);
            const rel = v3.sub(pFixed, dom.state.origin);
            const horizontal = v3.len(v3.reject(v3.sub(fd.pos, rel), up));
            if (horizontal < site.pad.flatRadius) {
              out.ground = v3.dot(up, rel);
              out.onPad = true;
            }
          }
        }
      }
    }

    // ---- dust thrown up where a plume meets the ground
    if (surface && out.ground !== null && !out.onPad) {
      for (const pc of clusters) {
        const c = pc.cluster;
        if (c.kind !== 'engine' || c.look.ground.dust <= 0) continue;
        const origin = toDom(pc.originRelCam);
        const axis = dirDom(pc.axisX);
        const cosDown = -v3.dot(axis, up);
        const height = v3.dot(up, origin) - out.ground;
        if (cosDown < 0.25 || height <= 0) continue;
        let reMax = 0;
        let throttle = 0;
        for (const nz of c.nozzles) {
          reMax = Math.max(reMax, nz.exitRadius);
          throttle += nz.throttle / c.nozzles.length;
        }
        const reEff = reMax * Math.sqrt(c.nozzles.length);
        const h = height / cosDown;
        const reach = P.dust.maxHeightRe * reEff;
        const f = throttle > 0.01 ? Math.max(0, 1 - h / reach) ** 2 : 0;
        if (f <= 0) continue;
        const n = this.take(`dust|${c.key}`, P.dust.rate * f * c.look.ground.dust * Math.min(1.5, Math.sqrt(c.thrust / 5e4)) * frame.qualityScale, dt);
        if (n <= 0) continue;
        const hit = v3.addScaled(origin, axis, h);
        out.emitters.push({
          kind: 'dust',
          shape: 'ring',
          pos: v3.addScaled(hit, up, 0.05),
          axis: up,
          radius: 0.35 * h + 1.5 * reEff,
          vel: v3.zero(),
          speed: [P.dust.speed[0], P.dust.speed[1] * (0.4 + 0.6 * Math.sqrt(f))],
          speedExponent: 2.4,
          polar: [Math.PI / 2 - P.dust.elevationDeg[1] * DEG, Math.PI / 2 - P.dust.elevationDeg[0] * DEG],
          life: P.dust.life,
          size: P.dust.size,
          color: P.dust.albedo,
          opacity: P.dust.opacity,
          count: n,
          seed: hashSeed('dust', c.key, this.frameCounter),
        });
      }
    }

    // ---- events (each snapshot's list is handled once)
    if (snap.events !== this.lastEvents) {
      this.lastEvents = snap.events;
      for (const ev of snap.events) this.onEvent(ev, snap, dom, out, effectTime, vesselDom, partFrame);
    }

    // ---- frost shedding for a while after lift-off
    for (const [vesselId, t0] of this.liftoff) {
      const age = effectTime - t0;
      if (age > P.ice.sheddingTime) {
        this.liftoff.delete(vesselId);
        continue;
      }
      const vessel = snap.vessels.find((v) => v.id === vesselId);
      const vd = vessel && vesselDom(vessel);
      if (!vessel || !vd) continue;
      const tanks = this.cryoParts(vessel);
      if (tanks.length === 0) continue;
      const n = this.take(`ice|${vesselId}`, P.ice.sheddingRate * (1 - age / P.ice.sheddingTime) ** 2 * frame.qualityScale, dt);
      if (n > 0) {
        const pick = tanks[this.frameCounter % tanks.length]!;
        out.emitters.push(this.iceEmitter(vd, partFrame(vd, pick.part), pick.def, n, hashSeed('shed', vesselId, this.frameCounter), dt));
      }
    }

    // ---- ablation sparks in the shock layer
    for (const vessel of snap.vessels) {
      const plasma = vessel.aero.plasmaIntensity;
      if (plasma < 0.15) continue;
      const vd = vesselDom(vessel);
      if (!vd) continue;
      const n = this.take(`ablation|${vessel.id}`, P.ablation.rate * plasma * frame.qualityScale, dt);
      if (n <= 0) continue;
      const speed = v3.len(vd.vel);
      if (speed < 100) continue;
      const wind = v3.scale(vd.vel, -1 / speed);
      const radius = Math.min(vessel.boundingRadius, this.maxPartRadius(vessel));
      out.emitters.push({
        kind: 'spark',
        shape: 'ring',
        pos: v3.addScaled(vd.pos, wind, -0.2 * radius),
        axis: wind,
        radius: 0.95 * radius,
        vel: vd.vel,
        sweep: v3.scale(vd.vel, dt),
        speed: P.ablation.speed,
        polar: [0.15, 1.2],
        life: P.ablation.life,
        size: P.ablation.size,
        color: [1, 1, 1],
        opacity: 1,
        aux: P.ablation.temperature,
        count: n,
        seed: hashSeed('ablation', vessel.id, this.frameCounter),
      });
    }

    // ---- flashes fade
    for (let i = this.flashes.length - 1; i >= 0; i--) if (effectTime - this.flashes[i]!.start > 6 * this.flashes[i]!.time) this.flashes.splice(i, 1);
    return out;
  }

  /** Apply a domain re-base to what the director keeps in domain coordinates. */
  rebase(map: (p: Vec3) => Vec3): void {
    for (const f of this.flashes) f.pos = map(f.pos);
  }

  reset(): void {
    this.flashes.length = 0;
    this.liftoff.clear();
    this.acc.clear();
  }

  private maxPartRadius(vessel: VesselSnapshot): number {
    let r = 0.5;
    for (const p of vessel.parts) r = Math.max(r, this.defs.parts[p.def]?.bounds.radius ?? 0);
    return r;
  }

  private cryoParts(vessel: VesselSnapshot): { part: PartSnapshot; def: PartDef }[] {
    const out: { part: PartSnapshot; def: PartDef }[] = [];
    for (const part of vessel.parts) {
      const def = this.defs.parts[part.def];
      if (def?.resources?.some((r) => this.data.frost.resources.includes(r.resource) && (part.resources[r.resource] ?? 0) > 0)) out.push({ part, def });
    }
    return out;
  }

  private iceEmitter(vd: { vel: Vec3 }, pf: { origin: Vec3; axis: Vec3 }, def: PartDef, count: number, seed: number, dt: number): EmitterDesc {
    const I = this.data.particles.ice;
    return {
      kind: 'ice',
      shape: 'cylinder',
      pos: v3.addScaled(pf.origin, pf.axis, def.bounds.yMin),
      axis: pf.axis,
      radius: def.bounds.radius * 1.01,
      length: def.bounds.yMax - def.bounds.yMin,
      vel: vd.vel,
      sweep: v3.scale(vd.vel, dt),
      speed: I.speed,
      speedExponent: 1.6,
      polar: [Math.PI / 2 - 0.35, Math.PI / 2 + 0.35],
      life: I.life,
      size: I.size,
      color: I.albedo,
      opacity: 0.9,
      count,
      seed,
    };
  }

  private onEvent(
    ev: SimEvent,
    snap: SimSnapshot,
    dom: DomainFrame,
    out: DirectorOutput,
    effectTime: number,
    vesselDom: (v: VesselSnapshot) => { pos: Vec3; vel: Vec3; q: VesselSnapshot['q'] } | null,
    partFrame: (vd: { pos: Vec3; q: VesselSnapshot['q'] }, part: PartSnapshot) => { origin: Vec3; axis: Vec3 },
  ): void {
    const P = this.data.particles;
    const S = this.data.staging;
    const findPart = (instanceId: string): { vessel: VesselSnapshot; part: PartSnapshot } | null => {
      for (const vessel of snap.vessels) {
        const part = vessel.parts.find((p) => p.instanceId === instanceId);
        if (part) return { vessel, part };
      }
      return null;
    };
    const vessel = snap.vessels.find((v) => v.id === ev.vesselId);
    const seed = hashSeed(ev.type, ev.vesselId, ev.ut);

    switch (ev.type) {
      case 'clampsReleased': {
        const vd = vessel && vesselDom(vessel);
        if (!vessel || !vd) break;
        this.liftoff.set(vessel.id, effectTime);
        const tanks = this.cryoParts(vessel);
        let area = 0;
        for (const t of tanks) area += t.def.bounds.radius * (t.def.bounds.yMax - t.def.bounds.yMin);
        tanks.forEach((t, i) => {
          const share = (t.def.bounds.radius * (t.def.bounds.yMax - t.def.bounds.yMin)) / Math.max(area, 1e-6);
          out.emitters.push(this.iceEmitter(vd, partFrame(vd, t.part), t.def, Math.round(P.ice.liftoffCount * share), seed + i, 0));
        });
        break;
      }
      case 'decoupled':
      case 'fairingJettisoned': {
        const hit = findPart(ev.partId) ?? findPart(`${ev.partId}#panel0`);
        const vd = hit && vesselDom(hit.vessel);
        if (!hit || !vd) break;
        const def = this.defs.parts[hit.part.def];
        if (!def) break;
        const pf = partFrame(vd, hit.part);
        const decoupler = def.modules.find((m) => m.type === 'decoupler');
        const planeY = decoupler && decoupler.type === 'decoupler' ? decoupler.separationPlaneY : def.bounds.yMin;
        const centre = v3.addScaled(pf.origin, pf.axis, planeY);
        const radius = def.bounds.radius;
        const scale = Math.min(1.5, 0.3 + radius / 4);
        out.emitters.push({
          kind: 'gas',
          shape: 'ring',
          pos: centre,
          axis: pf.axis,
          radius,
          vel: vd.vel,
          speed: [P.gas.speed[0], Math.max(P.gas.speed[0], S.puffSpeed * (1 + scale))],
          speedExponent: 1.5,
          polar: [Math.PI / 2 - 0.5, Math.PI / 2 + 0.5],
          life: P.gas.life,
          size: P.gas.size,
          growth: 0.35 * S.puffSpeed,
          color: P.gas.color,
          opacity: P.gas.opacity,
          count: Math.round(P.gas.count * scale),
          seed,
        });
        out.emitters.push({
          kind: 'spark',
          shape: 'ring',
          pos: centre,
          axis: pf.axis,
          radius,
          vel: vd.vel,
          speed: P.sparks.speed,
          speedExponent: 2,
          polar: [Math.PI / 2 - 0.7, Math.PI / 2 + 0.7],
          life: P.sparks.life,
          size: P.sparks.size,
          color: [1, 1, 1],
          opacity: 1,
          aux: P.sparks.temperature,
          count: Math.round(P.sparks.count * 0.4 * scale),
          seed: seed + 1,
        });
        if (ev.type === 'decoupled') {
          out.emitters.push({
            kind: 'ice',
            shape: 'ring',
            pos: centre,
            axis: pf.axis,
            radius,
            vel: vd.vel,
            speed: [P.ice.speed[0], P.ice.speed[1] * 2.5],
            speedExponent: 1.5,
            polar: [Math.PI / 2 - 0.9, Math.PI / 2 + 0.9],
            life: P.ice.life,
            size: P.ice.size,
            color: P.ice.albedo,
            opacity: 0.9,
            count: Math.round(P.ice.stagingCount * scale),
            seed: seed + 2,
          });
        }
        this.flashes.push({ pos: centre, start: effectTime, time: S.flashTime, intensity: S.flashIntensity * scale, color: S.flashColor, range: 120 });
        break;
      }
      case 'chuteDeployed': {
        const hit = findPart(ev.partId);
        const vd = hit && vesselDom(hit.vessel);
        if (!hit || !vd) break;
        const def = this.defs.parts[hit.part.def];
        const chute = def?.modules.find((m) => m.type === 'parachute' && m.mode === ev.mode);
        if (!def || !chute || chute.type !== 'parachute') break;
        const pf = partFrame(vd, hit.part);
        const attach = v3.add(vd.pos, quat.rotateInv(dom.q, quat.rotate(vd.q, v3.add(hit.part.localPos, quat.rotate(hit.part.localRot, v3.fromTuple(chute.attach))))));
        out.emitters.push({
          kind: 'gas',
          shape: 'sphere',
          pos: attach,
          axis: pf.axis,
          radius: 0.3,
          vel: vd.vel,
          speed: [4, 30],
          polar: [0, 0.6],
          life: [0.4, 1.2],
          size: [0.25, 0.7],
          growth: 2.5,
          color: P.gas.color,
          opacity: P.gas.opacity,
          count: Math.round(P.gas.count * 0.25),
          seed,
        });
        break;
      }
      case 'partDestroyed': {
        const vd = vessel && vesselDom(vessel);
        if (!vd) break;
        const pos = v3.add(vd.pos, quat.rotateInv(dom.q, quat.rotate(vd.q, ev.posVes)));
        const B = this.data.explosion.partBurst;
        const hot = ev.cause === 'overheat' || ev.cause === 'explosion';
        this.burst(out, pos, vd.vel, Math.round(B.sparks * (hot ? 1 : 0.35)), B.debris, 1, seed);
        if (ev.cause === 'overheat') out.fireballs.push({ pos, vel: vd.vel, energy: B.energy, seed });
        break;
      }
      case 'explosion': {
        const pos = EffectDomain.toDomain(dom, ev.posRoot);
        const vd = vessel && vesselDom(vessel);
        const vel = vd ? vd.vel : v3.zero();
        const k = Math.cbrt(Math.max(ev.energy, 1) / this.data.explosion.partBurst.energy);
        out.fireballs.push({ pos, vel, energy: ev.energy, seed });
        this.burst(out, pos, vel, Math.round(P.sparks.count * Math.min(6, k)), Math.round(P.debris.count * Math.min(6, k)), Math.min(4, 0.6 + 0.4 * k), seed + 7);
        const E = this.data.explosion;
        this.flashes.push({ pos, start: effectTime, time: E.flashTime, intensity: E.flashEfficacy * ev.energy, color: E.color, range: 4000 });
        break;
      }
      case 'splash': {
        const vd = vessel && vesselDom(vessel);
        if (!vessel || !vd || out.water === null || ev.speed < this.data.splash.minSpeed) break;
        const up = dom.up;
        const pos = v3.addScaled(vd.pos, up, out.water - v3.dot(up, vd.pos));
        const radius = this.maxPartRadius(vessel);
        out.splashes.push({ pos, radius, speed: ev.speed, seed });
        const W = P.spray;
        const C = this.data.splash;
        const v0 = ev.speed * C.crownSpeedFactor;
        const amount = Math.min(1, ev.speed / 8);
        const horizontal = v3.reject(vd.vel, up);
        const droplets = (count: number, shape: 'ring' | 'disc', r: number, polar: [number, number], speed: [number, number], k: number): void => {
          out.emitters.push({
            kind: 'droplet',
            shape,
            pos: v3.addScaled(pos, up, 0.25),
            axis: up,
            radius: r,
            vel: v3.scale(horizontal, 0.5),
            speed,
            speedExponent: 1.4,
            polar,
            life: W.life,
            size: W.size,
            color: W.albedo,
            opacity: 0.85,
            count: Math.round(count * amount),
            seed: seed + k,
          });
        };
        // The crown: a steep sheet from the rim; a flatter outer skirt; the jet that rises in the middle.
        droplets(W.count * 0.6, 'ring', radius * 1.05, [(90 - C.crownAngleDeg[1]) * DEG, (90 - C.crownAngleDeg[0]) * DEG], [0.35 * v0, 1.25 * v0], 1);
        droplets(W.count * 0.3, 'ring', radius * 1.2, [50 * DEG, 82 * DEG], [0.25 * v0, 0.95 * v0], 2);
        droplets(W.count * 0.1, 'disc', radius * 0.45, [0, 0.16], [0.4 * v0, 1.35 * v0], 3);
        out.emitters.push({
          // The fine spray that gives the crown its body: thrown up with the sheet, stopped by the air within
          // a few metres, then hanging and settling.
          kind: 'mist',
          shape: 'ring',
          pos: v3.addScaled(pos, up, 0.4),
          axis: up,
          radius: 1.05 * radius,
          vel: v3.scale(horizontal, 0.3),
          speed: [0.4 * v0, 1.5 * v0],
          polar: [(90 - C.crownAngleDeg[1]) * DEG, (90 - C.crownAngleDeg[0] + 8) * DEG],
          life: [W.life[0] * 0.5, W.life[1] * 0.55],
          size: W.mistSize,
          growth: 0.45,
          color: W.albedo,
          opacity: W.opacity,
          count: Math.round(W.mistCount * amount),
          seed: seed + 4,
        });
        break;
      }
      default:
        break;
    }
  }

  /** Sparks and debris chips thrown out from a point. */
  private burst(out: DirectorOutput, pos: Vec3, vel: Vec3, sparks: number, debris: number, speedScale: number, seed: number): void {
    const P = this.data.particles;
    if (sparks > 0) {
      out.emitters.push({
        kind: 'spark',
        shape: 'sphere',
        pos,
        axis: v3.unitZ(),
        radius: 0.6 * speedScale,
        vel,
        speed: [P.sparks.speed[0], P.sparks.speed[1] * speedScale],
        speedExponent: 1.8,
        polar: [0, Math.PI],
        life: [P.sparks.life[0], P.sparks.life[1] * Math.sqrt(speedScale)],
        size: P.sparks.size,
        color: [1, 1, 1],
        opacity: 1,
        aux: P.sparks.temperature,
        count: sparks,
        seed,
      });
    }
    if (debris > 0) {
      out.emitters.push({
        kind: 'chip',
        shape: 'sphere',
        pos,
        axis: v3.unitZ(),
        radius: 0.8 * speedScale,
        vel,
        speed: [P.debris.speed[0], P.debris.speed[1] * speedScale],
        speedExponent: 1.6,
        polar: [0, Math.PI],
        life: P.debris.life,
        size: P.debris.size,
        color: P.debris.albedo,
        opacity: 1,
        count: debris,
        seed: seed + 3,
      });
    }
  }
}
