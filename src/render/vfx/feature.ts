/**
 * createVfxFeature: the RenderFeature that draws every visual effect from the snapshot.
 *
 * Hooks: prepare (gather effects from module states, aero state and events; register lights; upload),
 * compute (light probes, smoke advection, particle simulation), drawShadow / drawGBuffer (parachute
 * canopies), preTransparent (half-resolution volumes), drawTransparent (composite, foam, lines, particles).
 */
import type { FrameContext, LocalLight, RenderContext, RenderFeature } from '@/core/contracts/render';
import { quat, v3, type Vec3, type Vec3Tuple } from '@/core/math';
import { coreOf } from '@/render/core';
import { ChuteSystem } from './chutes';
import { gatherPlumeClusters, type PlumeCluster } from './clusters';
import { G, PROBE_FOCUS, PROBE_PAD, VfxCommon } from './common';
import { loadVfxData, type VfxData } from './data';
import { EffectDirector } from './director';
import { applyRebase, EffectDomain, type DomainFrame } from './domain';
import { DustSheetRenderer } from './dust';
import { FireballRenderer } from './fireball';
import { ParticleSystem } from './particles';
import { PlasmaRenderer } from './plasma';
import { plumeLightIntensity } from './plumeModel';
import { PlumeRenderer, type PlacedCluster, type PlumeSlice } from './plumes';
import { SmokeSystem } from './smoke';
import { FoamRenderer } from './splash';
import { TrailSystem } from './trail';
import { VolumePass, type EmitterHint, type VolumeItem } from './volumes';

export const VFX_FEATURE_ID = 'vfx';

export interface VfxOptions {
  /** Feature id (default 'vfx') and order within each hook (default 0). */
  id?: string;
  order?: number;
  /**
   * Compile every shader without the core's applyAtmosphere (the call is replaced by the identity). Only for
   * the test that proves the default atmosphere inputs leave the output bit-identical.
   */
  debugSkipAtmosphere?: boolean;
}

export interface VfxClusterInfo {
  key: string;
  kind: 'engine' | 'rcs';
  lookId: string;
  vesselId: string;
  thrust: number;
  length: number;
  radius: number;
  mergeDistance: number;
  nozzles: { exitRadius: number; eta: number; theta: number; lExp: number; mixSlope: number; mixDev: number; shockSpacing: number; cellAmp: number; throttle: number }[];
}

/** Introspection for labs and tests (not used by the app). */
export interface VfxDebug {
  /** Plume clusters drawn in the last frame, in instance order. */
  clusters(): VfxClusterInfo[];
  /** Lights this feature registered in the last frame. */
  lights(): LocalLight[];
  /** Density slice of a drawn cluster (see PlumeRenderer.slice). */
  plumeSlice(instance: number, nozzle: number, x0: number, x1: number, rMax: number, width?: number, height?: number): Promise<PlumeSlice>;
  /** The whole particle pool (PARTICLE_FLOATS floats per particle). */
  readParticles(): Promise<Float32Array>;
  /** Counters of the last frame. */
  stats(): Record<string, number>;
  /** Kind of the effect domain ('surface' | 'space'), null before the first frame. */
  domainKind(): string | null;
}

export interface VfxFeature extends RenderFeature {
  readonly debug: VfxDebug;
}

interface LightCandidate {
  light: LocalLight;
  power: number;
}

const lum = (c: Vec3Tuple): number => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
/** Luminance of a sunlit grey surface, cd/m^2: what a daylight exposure is set for. */
const DAYLIGHT_WHITE = 12000;

/**
 * The vfx feature. `ctx` is optional: the feature receives its RenderContext in `init` (pass
 * `renderer.context` or nothing).
 */
export function createVfxFeature(_ctx?: RenderContext | null, options: VfxOptions = {}): VfxFeature {
  let ctx: RenderContext;
  let data: VfxData;
  let common: VfxCommon;
  let plumes: PlumeRenderer;
  let volumes: VolumePass;
  let particles: ParticleSystem;
  let director: EffectDirector;
  let smoke: SmokeSystem;
  let trails: TrailSystem;
  let plasma: PlasmaRenderer;
  let fireballs: FireballRenderer;
  let dust: DustSheetRenderer;
  let chutes: ChuteSystem;
  let foam: FoamRenderer;
  const domain = new EffectDomain();

  let effectTime = 0;
  /** Frames in which simulated time advanced (schedules staggered work independently of the frame index). */
  let stepCount = 0;
  let noiseTime = 0;
  let lastFrame: FrameContext | null = null;
  let lastRenderSize = '';
  let placed: PlacedCluster[] = [];
  let myLights: LocalLight[] = [];
  let dom: DomainFrame | null = null;
  const stats: Record<string, number> = {};

  /**
   * Tell the exposure meter about an emitter seen against the sky (it meters geometry only; an emitter in
   * front of geometry is in its histogram already). Coverage = the ellipse's solid angle over the frame's.
   */
  const emissiveHint = (frame: FrameContext, h: EmitterHint): void => {
    const d = v3.len(h.rel);
    if (!(h.luminance > 0) || d < 1e-3) return;
    const dir = v3.scale(h.rel, 1 / d);
    const vw = frame.view;
    const vx = vw[0]! * h.rel.x + vw[4]! * h.rel.y + vw[8]! * h.rel.z;
    const vy = vw[1]! * h.rel.x + vw[5]! * h.rel.y + vw[9]! * h.rel.z;
    const vz = vw[2]! * h.rel.x + vw[6]! * h.rel.y + vw[10]! * h.rel.z;
    const m = frame.projUnjittered;
    const size = Math.max(h.a, h.b) / d;
    if (vz >= 0 || Math.abs((m[0]! * vx) / -vz) > 1 + m[0]! * size || Math.abs((m[5]! * vy) / -vz) > 1 + m[5]! * size) return;
    let overBody = false;
    for (const body of frame.snapshot.bodies) {
      const def = ctx.defs.bodies[body.id];
      if (!def) continue;
      const c = frame.bodyPose(body.id).centerRelCam;
      const along = v3.dot(c, dir);
      if (along > 0 && v3.lenSq(v3.addScaled(c, dir, -along)) < def.radius * def.radius) overBody = true;
    }
    // As the image shows it: a streak thinner than a pixel is drawn a pixel wide and that much dimmer, and
    // the glare of a small bright thing spreads over a few pixels around it; nothing is wider than the frame.
    const px = (2 * d) / (m[5]! * frame.renderSize[1]);
    // A flame is meant to clip: the meter is asked to hold it three stops over its white, not under it.
    let luminance = Math.min(h.luminance / 2 ** (h.clipStops ?? 3), h.cap ?? Infinity);
    if (h.a < 0.5 * px) luminance *= h.a / (0.5 * px);
    if (h.b < 0.5 * px) luminance *= h.b / (0.5 * px);
    const reach = d * Math.hypot(1 / m[0]!, 1 / m[5]!);
    const a = Math.min(Math.max(h.a, 2 * px), reach);
    const b = Math.min(Math.max(h.b, 2 * px), reach);
    const frameSolidAngle = 4 / (m[0]! * m[5]!);
    const coverage = Math.min(1, (Math.PI * a * b) / (d * d) / frameSolidAngle);
    // An emitter in front of a body lights pixels the meter sees anyway (what it lights is in the histogram),
    // unless it is too small for those to count: under half a per cent of the frame the meter goes by its
    // prior, and the hint is what raises that (request vfx-3).
    if (overBody && coverage >= 0.005) return;
    if (coverage > 0 && luminance > 0) coreOf(ctx).addEmissiveHint(luminance, coverage);
  };

  /** The bright part of a plume cluster as an exposure hint. */
  const plumeHint = (pc: PlacedCluster): EmitterHint | null => {
    const c = pc.cluster;
    const shape = c.nozzles[0]?.shape;
    if (!shape) return null;
    let throttle = 0;
    let reMax = 0;
    for (const nz of c.nozzles) {
      throttle += nz.throttle / c.nozzles.length;
      reMax = Math.max(reMax, nz.exitRadius);
    }
    if (throttle <= 0) return null;
    const length = Math.min(c.length, 2 * shape.coreLength);
    const radius = Math.min(c.radius, Math.max(2 * reMax, 0.12 * length));
    const rel = v3.addScaled(pc.originRelCam, pc.axisX, 0.5 * length);
    const along = v3.dot(pc.axisX, v3.normalize(rel));
    const luminance = 0.35 * throttle * c.look.core.luminance * (1 + (c.look.core.vacuumGain - 1) * shape.vacuum);
    // A thruster puff is a faint cone, not a flame: it is held at the meter's white so that its shape survives.
    // An engine flame is held three stops over the meter's white, and never reported brighter than a sunlit
    // white surface: by day the plume leaves the exposure where the sun puts it and clips.
    return { rel, a: 0.5 * length * Math.sqrt(Math.max(0, 1 - along * along)) + radius, b: radius, luminance, clipStops: c.kind === 'rcs' ? 0 : 3, cap: c.kind === 'rcs' ? undefined : DAYLIGHT_WHITE };
  };

  const placeCluster = (frame: FrameContext, cluster: PlumeCluster): PlacedCluster | null => {
    const pose = frame.vesselPose(cluster.vesselId);
    if (!pose) return null;
    const axisX = v3.normalize(quat.rotate(pose.q, cluster.axisVes));
    let ref = quat.rotate(pose.q, v3.unitZ());
    if (Math.abs(v3.dot(ref, axisX)) > 0.95) ref = quat.rotate(pose.q, v3.unitX());
    const axisY = v3.normalize(v3.reject(ref, axisX));
    const axisZ = v3.cross(axisX, axisY);
    const toFrame = (v: Vec3): Vec3 => ({ x: v3.dot(v, axisX), y: v3.dot(v, axisY), z: v3.dot(v, axisZ) });
    return {
      cluster,
      originRelCam: v3.add(pose.originRelCam, quat.rotate(pose.q, cluster.centreVes)),
      axisX,
      axisY,
      axisZ,
      nozzlePos: cluster.nozzles.map((n) => toFrame(quat.rotate(pose.q, v3.sub(n.posVes, cluster.centreVes)))),
      nozzleDir: cluster.nozzles.map((n) => toFrame(quat.rotate(pose.q, n.dirVes))),
      probe: PROBE_FOCUS,
    };
  };

  const plumeLights = (candidates: LightCandidate[]): void => {
    const L = data.lights;
    for (const pc of placed) {
      const c = pc.cluster;
      const intensity = plumeLightIntensity(c.look, c.thrust);
      const power = lum(intensity);
      if (power < L.minIntensity) continue;
      let reMax = 0;
      let core = 0;
      for (const nz of c.nozzles) {
        reMax = Math.max(reMax, nz.exitRadius);
        core = Math.max(core, nz.shape.coreLength);
      }
      if (c.merged) core = Math.max(core, c.merged.shape.coreLength);
      candidates.push({
        power,
        light: {
          kind: 'capsule',
          posRelCam: v3.addScaled(pc.originRelCam, pc.axisX, reMax),
          endRelCam: v3.addScaled(pc.originRelCam, pc.axisX, reMax + 1.2 * core),
          intensity,
          range: Math.min(L.maxRange, Math.sqrt(power / L.rangeIlluminance)),
        },
      });
    }
  };

  const feature: VfxFeature = {
    id: options.id ?? VFX_FEATURE_ID,
    order: options.order ?? 0,

    init(c) {
      ctx = c;
      data = loadVfxData(c.defs);
      common = new VfxCommon(c, { skipAtmosphere: options.debugSkipAtmosphere === true });
      plumes = new PlumeRenderer(c, common);
      volumes = new VolumePass(c, common);
      particles = new ParticleSystem(c, common, data.particles.pool, data.particles.maxSpawnPerFrame);
      director = new EffectDirector(c.defs, data);
      smoke = new SmokeSystem(c, common, data);
      trails = new TrailSystem(c, common, data);
      plasma = new PlasmaRenderer(c, common, data);
      fireballs = new FireballRenderer(c, common, data);
      dust = new DustSheetRenderer(c, common, data);
      chutes = new ChuteSystem(c, common, data);
      foam = new FoamRenderer(c, common, data);
    },

    prepare(frame) {
      lastFrame = frame;
      const snap = frame.snapshot;
      const simDt = Math.min(0.1, Math.max(0, snap.ut - frame.prevSnapshot.ut));
      effectTime += simDt;
      if (frame.animate) noiseTime += simDt;
      const candidates: LightCandidate[] = [];

      // ---- plume clusters of every vessel with something burning
      placed = [];
      for (const vessel of snap.vessels) {
        let burning = false;
        for (const part of vessel.parts) {
          for (const m of part.modules) {
            if (m.type === 'engine' ? m.throttleActual > 0 || m.shutdownAge >= 0 : m.type === 'rcs' && m.enabled) {
              burning = true;
              break;
            }
          }
          if (burning) break;
        }
        if (!burning) continue;
        for (const cluster of gatherPlumeClusters(ctx.defs, data, vessel, frame.exposure)) {
          const pc = placeCluster(frame, cluster);
          if (pc) placed.push(pc);
        }
      }
      plumes.update(placed, noiseTime);
      plumeLights(candidates);
      common.setProbe(PROBE_PAD, smoke.update(frame, placed, effectTime, simDt));
      plasma.update(frame, effectTime, noiseTime);
      candidates.push(...plasma.lights);
      for (const pc of placed) {
        const h = plumeHint(pc);
        if (h) emissiveHint(frame, h);
      }
      for (const h of plasma.hints) emissiveHint(frame, h);

      // ---- effect domain, director, particles
      const g = common.globals;
      const focus = snap.vessels.find((v) => v.id === snap.activeVesselId) ?? snap.vessels[0];
      const renderSize = frame.renderSize.join('x');
      const depthUsable = frame.frameIndex > 0 && renderSize === lastRenderSize;
      lastRenderSize = renderSize;
      if (focus) {
        dom = domain.update(ctx.defs, snap, focus, simDt);
        if (dom.reset) {
          particles.clear();
          director.reset();
          fireballs.clear();
          chutes.clear();
          foam.clear();
        } else if (dom.rebase) {
          const rb = dom.rebase;
          director.rebase((p) => applyRebase(rb, p, v3.zero()).p);
          fireballs.rebase(rb);
          chutes.rebase(rb);
          foam.rebase(rb);
        }
        const d = dom;
        const bodyDef = ctx.defs.bodies[d.state.bodyId]!;
        const surface = d.state.kind === 'surface';
        // Air at the origin from the air at the focus vessel (isothermal layer between the two).
        let density = 0;
        let scaleHeight = 7000;
        if (surface && bodyDef.atmosphere && focus.aero.airDensity > 0) {
          scaleHeight = (bodyDef.atmosphere.gasConstant * Math.max(focus.aero.temperature, 50)) / Math.max(d.gravity, 0.1);
          const hv = v3.len(focus.r) - bodyDef.radius;
          density = focus.aero.airDensity * Math.exp(Math.min(20, Math.max(-20, (hv - d.altitude) / scaleHeight)));
        }
        const out = director.update(frame, d, placed, effectTime, simDt, density / 1.2);
        dust.update(frame, d, out.dustSheets, noiseTime);
        for (const e of out.emitters) particles.emit(e);
        for (const f of out.fireballs) fireballs.spawn(f, effectTime, d.up, Math.min(1, density / 1.2));
        for (const sp of out.splashes) foam.spawn(sp, effectTime);
        foam.update(frame, d, effectTime);
        const floorLevel = out.water !== null || out.ground !== null ? Math.max(out.water ?? -1e30, out.ground ?? -1e30) : null;
        for (const e of chutes.update(frame, d, effectTime, simDt, floorLevel)) particles.emit(e);
        for (const e of fireballs.update(frame, d, effectTime, simDt, density, floorLevel)) particles.emit(e);
        particles.prepare(frame, effectTime, d.rebase, depthUsable);

        const originRel = v3.sub(d.originRoot, frame.camera.positionRoot);
        const ax = quat.rotate(d.q, v3.unitX());
        const ay = quat.rotate(d.q, v3.unitY());
        const az = quat.rotate(d.q, v3.unitZ());
        g.set([originRel.x, originRel.y, originRel.z, density], G.domOrigin);
        g.set([ax.x, ax.y, ax.z, d.gravity], G.domX);
        g.set([ay.x, ay.y, ay.z, scaleHeight], G.domY);
        g.set([az.x, az.y, az.z, surface ? 1 : 0], G.domZ);
        g.set([d.up.x, d.up.y, d.up.z, out.ground ?? -1e30], G.domUp);
        let prevOrigin: Vec3;
        let pq = d.q;
        if (surface) {
          const pose = frame.bodyPose(d.state.bodyId);
          prevOrigin = v3.add(pose.prevCenterRelCam, quat.rotate(pose.prevQFixedToRoot, d.state.origin));
          pq = pose.prevQFixedToRoot;
        } else {
          prevOrigin = v3.sub(v3.addScaled(d.originRoot, d.velocityRoot, -simDt), frame.prevCamera.positionRoot);
        }
        const px = quat.rotate(pq, v3.unitX());
        const py = quat.rotate(pq, v3.unitY());
        const pz = quat.rotate(pq, v3.unitZ());
        g.set([prevOrigin.x, prevOrigin.y, prevOrigin.z, out.water ?? -1e30], G.domPrevOrigin);
        g.set([px.x, px.y, px.z, 0], G.domPrevX);
        g.set([py.x, py.y, py.z, 0], G.domPrevY);
        g.set([pz.x, pz.y, pz.z, 0], G.domPrevZ);
        const sunDom = quat.rotateInv(d.q, frame.sun.dirRoot);
        g.set([sunDom.x, sunDom.y, sunDom.z, 0], G.sunDom);
        g.set([0, 0, 0, 0], G.windDom);

        // Flashes (pyrotechnics, explosions) as point lights.
        for (const f of director.flashes) {
          const k = Math.exp(-(effectTime - f.start) / f.time);
          const intensity: Vec3Tuple = [f.color[0] * f.intensity * k, f.color[1] * f.intensity * k, f.color[2] * f.intensity * k];
          candidates.push({ power: lum(intensity), light: { kind: 'point', posRelCam: v3.add(originRel, quat.rotate(d.q, f.pos)), intensity, range: f.range } });
        }
        candidates.push(...fireballs.lights);
        for (const h of fireballs.hints) emissiveHint(frame, h);
        stats.ground = out.ground ?? NaN;
      } else dust.clear();
      // Trails last: they also take what the burning fragments of this frame leave behind.
      trails.update(frame, placed, effectTime, focus ? fireballs.trails : []);
      for (const h of trails.hints) emissiveHint(frame, h);

      // ---- lights: the strongest first, never more than the frame can hold
      myLights = [];
      candidates.sort((a, b) => b.power - a.power);
      for (const c of candidates.slice(0, data.lights.maxLights)) {
        if (frame.lights.length >= 16 || c.power < data.lights.minIntensity) break;
        frame.lights.push(c.light);
        myLights.push(c.light);
      }

      // ---- globals
      g[G.time] = effectTime;
      g[G.time + 1] = simDt;
      g[G.time + 2] = noiseTime;
      g[G.time + 3] = frame.qualityScale;
      const [hw, hh] = volumes.size;
      g[G.half] = hw;
      g[G.half + 1] = hh;
      g[G.half + 2] = 1 / hw;
      g[G.half + 3] = 1 / hh;
      if (simDt > 0) stepCount = (stepCount + 1) % 4096;
      g[G.misc] = stepCount;
      g[G.misc + 1] = depthUsable ? 1 : 0;
      const active = frame.vesselPose(snap.activeVesselId);
      common.setProbe(PROBE_FOCUS, active ? active.originRelCam : v3.zero());
      common.upload();

      stats.plumeInstances = plumes.instanceCount;
      stats.lights = myLights.length;
      stats.particles = particles.alive;
      stats.spawned = particles.spawnedTotal;
      stats.smoke = smoke.active() ? 1 : 0;
      stats.trailSegments = trails.segments;
      stats.plasma = plasma.count;
      stats.fireballs = fireballs.count;
      stats.dustSheets = dust.count;
      stats.canopies = chutes.canopyCount;
      stats.foam = foam.count;
      stats.crowns = foam.crownCount;
      stats.smokeSource = smoke.sourceRate;
      stats.smokeBox = smoke.active() ? smoke.boxShare : 0;
      ctx.perf.counter('vfx.plumes', plumes.instanceCount);
      ctx.perf.counter('vfx.particles', particles.alive);
    },

    compute(frame, encoder) {
      common.runProbes(frame, encoder);
      smoke.compute(frame, encoder);
      particles.compute(frame, encoder);
    },

    drawShadow(_frame, pass, cascade) {
      chutes.drawShadow(pass, cascade);
    },

    drawGBuffer(_frame, pass) {
      chutes.drawGBuffer(pass);
    },

    preTransparent(frame, encoder) {
      const items: VolumeItem[] = [];
      for (let i = 0; i < plumes.instanceCount; i++) {
        const index = i;
        items.push({ distance: plumes.distance(i), draw: (pass) => plumes.draw(pass, index) });
      }
      items.push(...trails.items(), ...plasma.items(), ...fireballs.items(), ...dust.items(), ...foam.items());
      volumes.run(frame, encoder, items, smoke);
      stats.volumes = volumes.drawn;
    },

    drawTransparent(_frame, pass) {
      smoke.drawGroundShadow(pass);
      volumes.draw(pass);
      foam.draw(pass);
      chutes.drawLines(pass);
      particles.draw(pass, volumes.image);
      if (volumes.hasImage || particles.alive > 0 || foam.count > 0 || chutes.canopyCount > 0) volumes.drawCeiling(pass);
    },

    isIdle: () => true,

    dispose() {
      plumes.dispose();
      volumes.dispose();
      particles.dispose();
      smoke.dispose();
      trails.dispose();
      plasma.dispose();
      fireballs.dispose();
      dust.dispose();
      chutes.dispose();
      foam.dispose();
      common.dispose();
    },

    debug: {
      clusters: () =>
        placed.slice(0, plumes.instanceCount).map((pc) => ({
          key: pc.cluster.key,
          kind: pc.cluster.kind,
          lookId: pc.cluster.lookId,
          vesselId: pc.cluster.vesselId,
          thrust: pc.cluster.thrust,
          length: pc.cluster.length,
          radius: pc.cluster.radius,
          mergeDistance: pc.cluster.mergeDistance,
          nozzles: pc.cluster.nozzles.map((n) => ({
            exitRadius: n.exitRadius,
            eta: n.shape.eta,
            theta: n.shape.theta,
            lExp: n.shape.lExp,
            mixSlope: n.shape.mixSlope,
            mixDev: n.shape.mixDev,
            shockSpacing: n.shape.shockSpacing,
            cellAmp: n.shape.cellAmp,
            throttle: n.throttle,
          })),
        })),
      lights: () => myLights.map((l) => ({ ...l })),
      plumeSlice: (instance, nozzle, x0, x1, rMax, width, height) => {
        if (!lastFrame) throw new Error('vfx: nothing has been rendered yet');
        return plumes.slice(lastFrame.frameBindGroup, instance, nozzle, x0, x1, rMax, width, height);
      },
      readParticles: () => particles.read(),
      stats: () => ({ ...stats }),
      domainKind: () => dom?.state.kind ?? null,
    },
  };
  return feature;
}
