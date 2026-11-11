/**
 * createVfxFeature: the RenderFeature that draws every visual effect from the snapshot.
 *
 * Hooks: prepare (gather effects from module states, aero state and events; register lights; upload),
 * compute (light probes, smoke advection, particle simulation), drawShadow / drawGBuffer (parachute
 * canopies), preTransparent (half-resolution volumes), drawTransparent (composite, foam, lines, particles).
 */
import type { FrameContext, LocalLight, RenderContext, RenderFeature } from '@/core/contracts/render';
import { quat, v3, type Vec3 } from '@/core/math';
import { gatherPlumeClusters, type PlumeCluster } from './clusters';
import { G, PROBE_FOCUS, VfxCommon } from './common';
import { loadVfxData, type VfxData } from './data';
import { plumeLightIntensity } from './plumeModel';
import { PlumeRenderer, type PlacedCluster, type PlumeSlice } from './plumes';
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
  /** Counters of the last frame. */
  stats(): Record<string, number>;
}

export interface VfxFeature extends RenderFeature {
  readonly debug: VfxDebug;
}

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

  let effectTime = 0;
  let noiseTime = 0;
  let lastFrame: FrameContext | null = null;
  let placed: PlacedCluster[] = [];
  let myLights: LocalLight[] = [];
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

  const registerLights = (frame: FrameContext): void => {
    myLights = [];
    const L = data.lights;
    const candidates: { light: LocalLight; power: number }[] = [];
    for (const pc of placed) {
      const c = pc.cluster;
      const intensity = plumeLightIntensity(c.look, c.thrust);
      const power = 0.2126 * intensity[0] + 0.7152 * intensity[1] + 0.0722 * intensity[2];
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
    candidates.sort((a, b) => b.power - a.power);
    for (const c of candidates.slice(0, L.maxLights)) {
      if (frame.lights.length >= 16) break;
      frame.lights.push(c.light);
      myLights.push(c.light);
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
    },

    prepare(frame) {
      lastFrame = frame;
      const snap = frame.snapshot;
      const simDt = Math.min(0.1, Math.max(0, snap.ut - frame.prevSnapshot.ut));
      effectTime += simDt;
      if (frame.animate) noiseTime += simDt;

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
        for (const cluster of gatherPlumeClusters(ctx.defs, data, vessel)) {
          const pc = placeCluster(frame, cluster);
          if (pc) placed.push(pc);
        }
      }
      plumes.update(placed, noiseTime);
      registerLights(frame);

      // ---- globals
      const g = common.globals;
      g[G.time] = effectTime;
      g[G.time + 1] = simDt;
      g[G.time + 2] = noiseTime;
      g[G.time + 3] = frame.qualityScale;
      const [hw, hh] = volumes.size;
      g[G.half] = hw;
      g[G.half + 1] = hh;
      g[G.half + 2] = 1 / hw;
      g[G.half + 3] = 1 / hh;
      const active = frame.vesselPose(snap.activeVesselId);
      common.setProbe(PROBE_FOCUS, active ? active.originRelCam : v3.zero());
      common.upload();

      stats.plumeInstances = plumes.instanceCount;
      stats.lights = myLights.length;
      ctx.perf.counter('vfx.plumes', plumes.instanceCount);
    },

    compute(frame, encoder) {
      common.runProbes(frame, encoder);
    },

    preTransparent(frame, encoder) {
      const items: VolumeItem[] = [];
      for (let i = 0; i < plumes.instanceCount; i++) {
        const index = i;
        items.push({ distance: plumes.distance(i), draw: (pass) => plumes.draw(pass, index) });
      }
      volumes.run(frame, encoder, items, null);
      stats.volumes = volumes.drawn;
    },

    drawTransparent(_frame, pass) {
      volumes.draw(pass);
    },

    isIdle: () => true,

    dispose() {
      plumes.dispose();
      volumes.dispose();
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
      stats: () => ({ ...stats }),
    },
  };
  return feature;
}
