/**
 * createSiteFeature: the launch complexes of the definition library. Every structure of
 * `LaunchSiteDef.structures` is generated once (generator registry in ./site) and placed in the site's
 * east / north / up frame on the pad surface of its body.
 *
 *  - Structures are BODY-FIXED shadow casters (drawn into every cascade of their body). An articulated arm
 *    is submitted as a MOVING caster while it swings, so a staggered cascade never holds a stale arm.
 *    Long, low structures (pipe runs) cast only into the cascades that can resolve their shadow.
 *  - Swing arms and the tail service mast retract when a vessel standing on the pad lights its engines (or
 *    when no vessel stands there); the crew access arm follows the same rule.
 *  - At night the lamp lenses glow and the nearest lamps are registered as local lights.
 */
import type { DefLibrary, LaunchSiteDef } from '@/core/contracts/defs';
import type { FrameContext, RenderContext, RenderFeature, ShadowCascadeView } from '@/core/contracts/render';
import type { SimSnapshot } from '@/core/contracts/sim';
import { latLonToDir } from '@/core/geo/cubeSphere';
import { DEG, quat, v3, type Quat, type Vec3 } from '@/core/math';
import { coreOf, type MeshBatch, type MeshInstance, type ModelHandle } from '@/render/core';
import './site';
import { NEAR_SHADOW_TEXEL, generateStructure, type SiteState, type SiteVisual } from './site/types';

export interface SiteFeatureOptions {
  /**
   * Pad surface height above the reference radius (default: `location.padElevation` when it is a number;
   * a site whose elevation is 'terrain' needs this resolver, e.g. from the terrain provider).
   */
  padElevation?: (site: LaunchSiteDef) => number;
  /** Most local lights registered per frame (default 8 of the core's 16). */
  maxLights?: number;
  /** Camera distance beyond which a site is not drawn, m (default 80 km). */
  drawDistance?: number;
}

export interface SiteStats {
  sites: number;
  instances: number;
  triangles: number;
  shadowTriangles: number;
  /** Instances submitted as moving casters in the last frame (arms in motion). */
  movingInstances: number;
  lights: number;
  updateMs: number;
}

export interface SiteFeature extends RenderFeature {
  readonly stats: SiteStats;
  /** Presentation state of a site (night, arm positions). */
  state(siteId: string): SiteState | undefined;
  /** Pin parts of a site's state (labs and tests); null releases it to the automatic rules. */
  override(siteId: string, patch: Partial<SiteState> | null): void;
}

interface Placed {
  visual: SiteVisual;
  handles: Record<string, ModelHandle>;
  /** Origin and orientation in the body-fixed frame. */
  origin: Vec3;
  q: Quat;
}

interface SiteRuntime {
  site: LaunchSiteDef;
  centre: Vec3;
  up: Vec3;
  east: Vec3;
  north: Vec3;
  placed: Placed[];
  state: SiteState;
  target: { arms: number; crewArm: number };
  seen: boolean;
  override: Partial<SiteState> | null;
}

export function createSiteFeature(options: SiteFeatureOptions = {}): SiteFeature {
  const maxLights = options.maxLights ?? 8;
  const drawDistance = options.drawDistance ?? 80_000;
  let ctx: RenderContext;
  let defs: DefLibrary;
  let batch: MeshBatch;
  /** Items whose shadow is drawn in the near cascades only. */
  let nearBatch: MeshBatch;
  const sites: SiteRuntime[] = [];
  let lastUt = Number.NaN;
  const stats: SiteStats = { sites: 0, instances: 0, triangles: 0, shadowTriangles: 0, movingInstances: 0, lights: 0, updateMs: 0 };

  const elevationOf = (site: LaunchSiteDef): number => {
    if (options.padElevation) return options.padElevation(site);
    if (typeof site.location.padElevation === 'number') return site.location.padElevation;
    throw new Error(`site "${site.id}": padElevation is 'terrain'; pass SiteFeatureOptions.padElevation to resolve it`);
  };

  const buildSite = (site: LaunchSiteDef): SiteRuntime => {
    const body = defs.bodies[site.bodyId];
    if (!body) throw new Error(`site "${site.id}": unknown body "${site.bodyId}"`);
    const up = latLonToDir(site.location.latDeg * DEG, site.location.lonDeg * DEG);
    let east = v3.cross({ x: 0, y: 0, z: 1 }, up);
    east = v3.lenSq(east) < 1e-12 ? { x: 0, y: 1, z: 0 } : v3.normalize(east);
    const north = v3.cross(up, east);
    const centre = v3.scale(up, body.radius + elevationOf(site));
    const meshes = coreOf(ctx).meshes;
    const cache = new Map<string, { visual: SiteVisual; handles: Record<string, ModelHandle> }>();
    const placed: Placed[] = site.structures.map((s) => {
      const key = `${s.model}|${JSON.stringify(s.params ?? {})}`;
      let entry = cache.get(key);
      if (!entry) {
        const visual = generateStructure(defs, site, s.model, s.params ?? {});
        const handles: Record<string, ModelHandle> = {};
        for (const [name, model] of Object.entries(visual.models)) handles[name] = meshes.createModel(model, model.lodPixels ? { lodPixels: model.lodPixels } : {});
        entry = { visual, handles };
        cache.set(key, entry);
      }
      const h = s.headingDeg * DEG;
      // Model +X = east turned clockwise by the heading, +Y = up, +Z = -(the heading direction).
      const x = v3.sub(v3.scale(east, Math.cos(h)), v3.scale(north, Math.sin(h)));
      const z = v3.neg(v3.add(v3.scale(east, Math.sin(h)), v3.scale(north, Math.cos(h))));
      const origin = v3.add(v3.add(v3.add(centre, v3.scale(east, s.offsetEnu[0])), v3.scale(north, s.offsetEnu[1])), v3.scale(up, s.offsetEnu[2]));
      return { visual: entry.visual, handles: entry.handles, origin, q: quat.fromBasis(x, up, z) };
    });
    return { site, centre, up, east, north, placed, state: { night: 0, arms: 1, crewArm: 1 }, target: { arms: 1, crewArm: 1 }, seen: false, override: null };
  };

  /** Is a vessel standing on this pad, and is it firing? */
  const padActivity = (rt: SiteRuntime, snapshot: SimSnapshot): { occupied: boolean; firing: boolean } => {
    const body = snapshot.bodies.find((b) => b.id === rt.site.bodyId);
    if (!body) return { occupied: false, firing: false };
    let occupied = false;
    let firing = false;
    for (const v of snapshot.vessels) {
      if (v.bodyId !== rt.site.bodyId || v.situation !== 'prelaunch') continue;
      const rel = quat.rotateInv(body.qFixedToRoot, v3.sub(v.rRoot, body.rRoot));
      const d = v3.sub(rel, rt.centre);
      const height = v3.dot(d, rt.up);
      if (v3.len(v3.addScaled(d, rt.up, -height)) > rt.site.pad.flatRadius * 0.25) continue;
      occupied = true;
      for (const p of v.parts) for (const m of p.modules) if (m.type === 'engine' && (m.thrust > 0 || (m.active && m.throttleActual > 0.01))) firing = true;
    }
    return { occupied, firing };
  };

  const feature: SiteFeature = {
    id: 'site',
    order: 0,
    stats,
    state: (id) => sites.find((s) => s.site.id === id)?.state,
    override(id, patch) {
      const rt = sites.find((s) => s.site.id === id);
      if (!rt) throw new Error(`site feature: unknown site "${id}"`);
      rt.override = patch;
    },

    init(c) {
      ctx = c;
      defs = c.defs;
      batch = coreOf(c).meshes.createBatch('site');
      nearBatch = coreOf(c).meshes.createBatch('site-near');
      for (const site of Object.values(defs.sites)) sites.push(buildSite(site));
    },

    prepare(frame: FrameContext) {
      const t0 = performance.now();
      ctx.perf.cpuBegin('site.instances');
      const snapshot = frame.snapshot;
      const dt = Number.isFinite(lastUt) ? Math.max(0, Math.min(60, snapshot.ut - lastUt)) : 0;
      lastUt = snapshot.ut;
      batch.begin(frame);
      nearBatch.begin(frame);
      stats.sites = 0;
      stats.instances = 0;
      stats.movingInstances = 0;
      const lamps: { pos: Vec3; intensity: [number, number, number]; range: number; d: number }[] = [];
      for (const rt of sites) {
        const pose = frame.bodies.find((b) => b.id === rt.site.bodyId);
        if (!pose) continue;
        if (v3.dist(pose.cameraFixed, rt.centre) > drawDistance) continue;
        stats.sites++;
        // ---- state
        const sunEl = Math.asin(Math.max(-1, Math.min(1, v3.dot(quat.rotate(pose.qFixedToRoot, rt.up), pose.sunDir)))) / DEG;
        const act = padActivity(rt, snapshot);
        const st = rt.state;
        st.night = Math.max(0, Math.min(1, (3 - sunEl) / 4));
        rt.target.arms = !act.occupied || act.firing ? 1 : 0;
        rt.target.crewArm = rt.target.arms;
        if (!rt.seen) {
          st.arms = rt.target.arms;
          st.crewArm = rt.target.crewArm;
          rt.seen = true;
        }
        const ease = (cur: number, target: number, seconds: number): number => (target > cur ? Math.min(target, cur + dt / seconds) : Math.max(target, cur - dt / seconds));
        st.arms = ease(st.arms, rt.target.arms, 3.5);
        st.crewArm = ease(st.crewArm, rt.target.crewArm, 6);
        if (rt.override) Object.assign(st, rt.override);
        const moving = { arms: rt.override?.arms === undefined && st.arms !== rt.target.arms, crewArm: rt.override?.crewArm === undefined && st.crewArm !== rt.target.crewArm };
        // ---- instances
        const parent = { originRelCam: pose.centerRelCam, q: pose.qFixedToRoot, prevOriginRelCam: pose.prevCenterRelCam, prevQ: pose.prevQFixedToRoot };
        for (const pl of rt.placed) {
          pl.visual.pose(
            st,
            (model, pos, rot, opts) => {
              const handle = pl.handles[model];
              if (!handle) throw new Error(`site: structure posed an unknown model "${model}"`);
              const p = pos ? v3.add(pl.origin, quat.rotate(pl.q, { x: pos[0], y: pos[1], z: pos[2] })) : pl.origin;
              const q = rot ? quat.mul(pl.q, { x: rot[0], y: rot[1], z: rot[2], w: rot[3] }) : pl.q;
              const inst: MeshInstance = {
                originRelCam: v3.add(parent.originRelCam, quat.rotate(parent.q, p)),
                q: quat.mul(parent.q, q),
                prevOriginRelCam: v3.add(parent.prevOriginRelCam, quat.rotate(parent.prevQ, p)),
                prevQ: quat.mul(parent.prevQ, q),
                bodyFixed: !opts?.moving,
              };
              if (opts?.castShadow === false) inst.castShadow = false;
              if (opts?.emissive !== undefined) inst.emissiveScale = opts.emissive;
              if (opts?.grime) inst.soot = opts.grime;
              (opts?.nearShadowOnly ? nearBatch : batch).add(handle, inst);
              stats.instances++;
              if (opts?.moving) stats.movingInstances++;
            },
            moving,
          );
          if (st.night > 0.05 && pl.visual.lights) {
            for (const l of pl.visual.lights) {
              const pFixed = v3.add(pl.origin, quat.rotate(pl.q, v3.fromTuple(l.pos)));
              const rel = v3.add(parent.originRelCam, quat.rotate(parent.q, pFixed));
              lamps.push({ pos: rel, intensity: [l.intensity[0] * st.night, l.intensity[1] * st.night, l.intensity[2] * st.night], range: l.range, d: v3.len(rel) - l.range });
            }
          }
        }
      }
      batch.finish();
      nearBatch.finish();
      // The lamps nearest to the camera's reach become local lights.
      lamps.sort((a, b) => a.d - b.d);
      stats.lights = 0;
      for (const l of lamps) {
        if (stats.lights >= maxLights || frame.lights.length >= 16) break;
        frame.lights.push({ kind: 'point', posRelCam: l.pos, intensity: l.intensity, range: l.range });
        stats.lights++;
      }
      ctx.perf.cpuEnd('site.instances');
      stats.updateMs = performance.now() - t0;
    },

    drawGBuffer(_frame, pass) {
      batch.drawGBuffer(pass);
      nearBatch.drawGBuffer(pass);
      stats.triangles = batch.stats.triangles + nearBatch.stats.triangles;
    },

    drawShadow(_frame, pass, cascade: ShadowCascadeView) {
      // The batch draws body-fixed instances into every cascade and the moving ones only where
      // `cascade.everyFrame` is true.
      batch.drawShadow(pass, cascade);
      if (cascade.texelSize <= NEAR_SHADOW_TEXEL) nearBatch.drawShadow(pass, cascade);
      stats.shadowTriangles = batch.stats.shadowTriangles + nearBatch.stats.shadowTriangles;
    },

    isIdle: () => coreOf(ctx).meshes.isIdle(),

    dispose() {
      batch.destroy();
      nearBatch.destroy();
      for (const rt of sites) for (const pl of rt.placed) for (const h of Object.values(pl.handles)) h.destroy();
      sites.length = 0;
    },
  };
  return feature;
}
