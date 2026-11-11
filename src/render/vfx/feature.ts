/**
 * createVfxFeature: the RenderFeature that draws every visual effect from the snapshot.
 *
 * Hooks: prepare (gather effects from module states, aero state and events; register lights; upload),
 * compute (light probes, smoke advection, particle simulation), drawShadow / drawGBuffer (parachute
 * canopies), preTransparent (half-resolution volumes), drawTransparent (composite, foam, lines, particles).
 */
import type { FrameContext, LocalLight, RenderContext, RenderFeature } from '@/core/contracts/render';
import { quat, v3, type Vec3, type Vec3Tuple } from '@/core/math';
import { ChuteSystem } from './chutes';
import { gatherPlumeClusters, type PlumeCluster } from './clusters';
import { G, PROBE_FOCUS, PROBE_PAD, VfxCommon } from './common';
import { loadVfxData, type VfxData } from './data';
import { EffectDirector } from './director';
import { applyRebase, EffectDomain, type DomainFrame } from './domain';
import { FireballRenderer } from './fireball';
import { ParticleSystem } from './particles';
import { PlasmaRenderer } from './plasma';
import { plumeLightIntensity } from './plumeModel';
import { PlumeRenderer, type PlacedCluster, type PlumeSlice } from './plumes';
import { SmokeSystem } from './smoke';
import { FoamRenderer } from './splash';
import { TrailSystem } from './trail';
import { VolumePass, type VolumeItem } from './volumes';

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
  let chutes: ChuteSystem;
  let foam: FoamRenderer;
  const domain = new EffectDomain();

  let effectTime = 0;
  let noiseTime = 0;
  let lastFrame: FrameContext | null = null;
  let lastRenderSize = '';
  let placed: PlacedCluster[] = [];
  let myLights: LocalLight[] = [];
  let dom: DomainFrame | null = null;
  const stats: Record<string, number> = {};

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
      trails.update(frame, placed, effectTime);
      plasma.update(frame, effectTime, noiseTime);
      candidates.push(...plasma.lights);

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
        const out = director.update(frame, d, placed, effectTime, simDt);
        for (const e of out.emitters) particles.emit(e);
        for (const f of out.fireballs) fireballs.spawn(f, effectTime);
        for (const sp of out.splashes) foam.spawn(sp, effectTime);
        foam.update(frame, effectTime);
        const floorLevel = out.water !== null || out.ground !== null ? Math.max(out.water ?? -1e30, out.ground ?? -1e30) : null;
        for (const e of chutes.update(frame, d, effectTime, simDt, floorLevel)) particles.emit(e);
        particles.prepare(frame, effectTime, d.rebase, depthUsable);

        const originRel = v3.sub(d.originRoot, frame.camera.positionRoot);
        const ax = quat.rotate(d.q, v3.unitX());
        const ay = quat.rotate(d.q, v3.unitY());
        const az = quat.rotate(d.q, v3.unitZ());
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
        fireballs.update(frame, d, effectTime, simDt, density);
        candidates.push(...fireballs.lights);
        stats.ground = out.ground ?? NaN;
      }

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
      g[G.misc] = frame.frameIndex & 1;
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
      stats.canopies = chutes.canopyCount;
      stats.foam = foam.count;
      stats.smokeSource = smoke.sourceRate;
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
      items.push(...trails.items(), ...plasma.items(), ...fireballs.items());
      volumes.run(frame, encoder, items, smoke);
      stats.volumes = volumes.drawn;
    },

    drawTransparent(_frame, pass) {
      volumes.draw(pass);
      foam.draw(pass);
      chutes.drawLines(pass);
      particles.draw(pass);
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
