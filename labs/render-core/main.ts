/**
 * Render-core lab. One page, selected by query string:
 *
 *   ?lab=stand        (default) the test stand on a LabPlanet: material sweep, shadows, emissive objects
 *   &scene=<FakeScene>          pad (default), lunarOrbit, translunar, ...
 *   &site=lat,lon[,alt]         where the stand sits (default: the scenario's launch site; `site=moonview`
 *                               picks a spot on the root body from which the moon stands 35 deg high)
 *   &sun=az,el                  pin the sun at this azimuth / elevation (deg) at the site
 *   &planet=0                   no LabPlanet;  &stand=0  no stand;  &stand=dense  slab + dense LOD spheres only
 *   &soft=<m>                   shadow softness of the slab (PbrMaterialDef.shadowSoftness, request terrain-render-4)
 *   &grating=cutout|opaque      a bar-grating panel 2 m up at (14, -10), alpha-tested or not (request vehicle-pad-4)
 *   &tris=<n>                   add dense spheres (130k triangles each, two LODs) up to n triangles
 *   &maps=tileset|ocean         LabPlanet albedo: the baked albedoLowRes maps, or open ocean everywhere
 *   &seabed=<m>                 LabPlanet: fixed sand seabed that deep inside 'ocean.nearField' (default: as deep as the sheet)
 *   &probe=<name>[,<name>...]   extra lab features (see probes.ts)
 * plus every camera / renderer parameter of createLabApp. Specs drive the rest through window.__lab and
 * window.__rc (this page's own handle).
 */
import type { DefLibrary } from '@/core/contracts/defs';
import type { RenderFeature } from '@/core/contracts/render';
import type { Sim, SimSnapshot } from '@/core/contracts/sim';
import { createFakeSim, type FakeScene } from '@/core/fakes/fakeSim';
import { dirToLatLon } from '@/core/geo/cubeSphere';
import { mat4, quat, RAD, v3 } from '@/core/math';
import { createLabApp, createLabPlanetFeature, lookRotation, type LabApp, type LabCameraSpec } from '@/render/core/lab';
import { createProbes, type Probes } from './probes';
import { createStandFeature, type StandFeature } from './stand';
import { proceduralPlanetMap, siteFrameFixed, sunAtSite, withSunOverride, type Site, type SunOverride } from './world';

export interface RenderCoreLab {
  app: LabApp;
  site: Site;
  stand: StandFeature | null;
  probes: Probes;
  /** Pin the sun at azimuth / elevation (deg) at the site, or release it with null. */
  setSun(azEl: [number, number] | null): void;
  /** Pin the sun along an arbitrary ROOT direction provider. */
  setSunOverride(o: SunOverride | null): void;
  /** Pin the sun at azimuth / elevation (deg) as seen from another body-fixed site. */
  setSunAtSite(site: Site, azEl: [number, number]): void;
  /**
   * Aim the camera at a point given in a site's ENU frame (m): yaw clockwise from north, pitch above the
   * horizontal (deg), distance in metres. The camera stays fixed to the body. null releases it.
   */
  lookAt(target: [number, number, number] | null, yawDeg?: number, pitchDeg?: number, distance?: number, atSite?: Site): void;
  /**
   * Keep the camera `distance` metres from the centre of a body, at `phaseDeg` from the body -> sun direction
   * (0 = full disc, 180 = new), looking at the centre. `towardsDeg` rotates the camera about the sun axis.
   */
  viewBodyAtPhase(bodyId: string, phaseDeg: number, distance: number, towardsDeg?: number): void;
  /** Ride with the active vessel (eye `offsetUp` metres above it, along the local vertical) and keep looking at a site. */
  trackSiteFromVessel(atSite: Site, offsetUp?: number): void;
  /** Render-target pixel of a point given in a site's ENU frame (m), for the frame last rendered; null when behind the camera. */
  projectSitePoint(posEnu: [number, number, number], atSite?: Site): { x: number; y: number } | null;
  /** Render-target pixel of a body centre in the frame last rendered, and its radius in pixels. */
  projectBody(bodyId: string): { x: number; y: number; radius: number } | null;
  /** Azimuth (deg clockwise from north) and elevation (deg) of a body's centre as seen from the stand's site. */
  directionAtSite(bodyId: string): { azDeg: number; elDeg: number };
  /** Replace the brdf_terrain chunk at run time (null restores the default). */
  overrideTerrainBrdf(wgsl: string | null): void;
}

declare global {
  interface Window {
    __rc?: RenderCoreLab;
  }
}

const query = new URLSearchParams(location.search);
const scene = (query.get('scene') as FakeScene | null) ?? 'pad';
let sunOverride: SunOverride | null = null;
let site!: Site;
let stand: StandFeature | null = null;
let probes!: Probes;
let defaultTerrain: string | null = null;

function pickSite(defs: DefLibrary, sim: Sim): Site {
  const root = defs.rootBodyId;
  const arg = query.get('site');
  const vesselBody = sim.peek().vessels[0]?.bodyId ?? root;
  if (arg === 'moonview') {
    // A point on the root body from which its moon is about 35 deg above the horizon.
    const s = sim.peek();
    const earth = s.bodies.find((b) => b.id === root)!;
    const moon = s.bodies.find((b) => defs.bodies[b.id]?.parent === root && defs.bodies[b.id]?.gravityRole === 'attractor')!;
    const toMoon = v3.normalize(quat.rotateInv(earth.qFixedToRoot, v3.sub(moon.rRoot, earth.rRoot)));
    const axis = v3.anyOrthogonal(toMoon);
    const dir = quat.rotate(quat.fromAxisAngle(axis, (55 * Math.PI) / 180), toMoon);
    const ll = dirToLatLon(dir);
    return { bodyId: root, latDeg: ll.lat * RAD, lonDeg: ll.lon * RAD, alt: 1 };
  }
  if (arg) {
    const [lat, lon, alt] = arg.split(',').map(Number);
    return { bodyId: query.get('siteBody') ?? vesselBody, latDeg: lat ?? 0, lonDeg: lon ?? 0, alt: alt ?? 1 };
  }
  const first = Object.values(defs.sites)[0];
  if (vesselBody === root && first) return { bodyId: root, latDeg: first.location.latDeg, lonDeg: first.location.lonDeg, alt: 1 };
  return { bodyId: vesselBody, latDeg: 0.674, lonDeg: 23.473, alt: 1 };
}

async function boot(): Promise<void> {
  const canvas = document.getElementById('viewport') as HTMLCanvasElement;
  const info = document.getElementById('info') as HTMLDivElement;
  const app = await createLabApp({
    canvas,
    name: 'render-core',
    scene,
    autoReady: false,
    sim: (defs) => {
      const inner = createFakeSim(defs, { scene });
      site = pickSite(defs, inner);
      const sun = query.get('sun');
      if (sun) {
        const [az, el] = sun.split(',').map(Number);
        sunOverride = sunAtSite(site, az ?? 120, el ?? 40);
      }
      return withSunOverride(inner, () => sunOverride);
    },
    features: (defs, sim) => {
      const list: RenderFeature[] = [];
      if (query.get('planet') !== '0') {
        // Synthetic albedo maps by default (deterministic, no dependency on baked tiles); ?maps=tileset uses the real ones.
        const maps: NonNullable<Parameters<typeof createLabPlanetFeature>[0]>['maps'] = {};
        if (query.get('maps') !== 'tileset') {
          let seed = 100;
          for (const b of Object.values(defs.bodies)) if (!b.emission) maps[b.id] = proceduralPlanetMap(seed++, b.ocean !== null);
          // ?maps=ocean: open water everywhere on bodies with an ocean (LabPlanet water and near-field test).
          if (query.get('maps') === 'ocean') {
            for (const b of Object.values(defs.bodies)) if (b.ocean) maps[b.id] = { width: 2, height: 1, data: new Uint8Array([28, 52, 84, 255, 28, 52, 84, 255]) };
          }
        }
        // ?seabed=<m>: a fixed sand floor that deep inside 'ocean.nearField' (default: the floor follows the water sheet).
        list.push(createLabPlanetFeature({ maps, ...(query.has('seabed') ? { seabedDepth: Number(query.get('seabed')) } : {}) }));
      }
      if (query.get('stand') !== '0') {
        stand = createStandFeature({ site, defs, heavyTriangles: Number(query.get('tris') ?? 0) || undefined, vesselSizedObject: query.get('stack') !== '0', denseOnly: query.get('stand') === 'dense', slabShadowSoftness: Number(query.get('soft') ?? 0) || undefined, ...(query.get('grating') === 'cutout' || query.get('grating') === 'opaque' ? { grating: query.get('grating') as 'cutout' | 'opaque' } : {}) });
        list.push(stand);
      }
      probes = createProbes(query, site, defs, sim.peek());
      list.push(...probes.features);
      return list;
    },
    camera: (): LabCameraSpec => ({ type: 'orbit', target: { bodyId: site.bodyId, latDeg: site.latDeg, lonDeg: site.lonDeg, alt: site.alt + 1 }, yaw: (200 * Math.PI) / 180, pitch: (22 * Math.PI) / 180, distance: 16 }),
  });
  probes.attach(app);

  const lab: RenderCoreLab = {
    app,
    site,
    stand,
    probes,
    setSun(azEl) {
      sunOverride = azEl ? sunAtSite(site, azEl[0], azEl[1]) : null;
    },
    setSunOverride(o) {
      sunOverride = o;
    },
    setSunAtSite(s, azEl) {
      sunOverride = sunAtSite(s, azEl[0], azEl[1]);
    },
    lookAt(target, yawDeg = 0, pitchDeg = 30, distance = 10, atSite = site) {
      if (!target) {
        app.onFrame(null);
        return;
      }
      const place = (snapshot: SimSnapshot): void => {
        const b = snapshot.bodies.find((x) => x.id === atSite.bodyId)!;
        const { posFixed, qEnuToFixed } = siteFrameFixed(atSite, app.defs);
        const q = quat.mul(b.qFixedToRoot, qEnuToFixed);
        const yaw = (yawDeg * Math.PI) / 180;
        const pitch = (pitchDeg * Math.PI) / 180;
        // Direction from the target to the camera in ENU.
        const out = { x: Math.sin(yaw) * Math.cos(pitch), y: Math.cos(yaw) * Math.cos(pitch), z: Math.sin(pitch) };
        const targetRoot = v3.add(b.rRoot, quat.rotate(b.qFixedToRoot, v3.add(posFixed, quat.rotate(qEnuToFixed, v3.fromTuple(target)))));
        const outRoot = quat.rotate(q, out);
        const upHint = Math.abs(pitchDeg) > 89.5 ? quat.rotate(q, { x: 0, y: 1, z: 0 }) : quat.rotate(q, { x: 0, y: 0, z: 1 });
        app.camera.spec = { type: 'free', positionRoot: v3.addScaled(targetRoot, outRoot, distance), qViewToRoot: lookRotation(v3.neg(outRoot), upHint) };
      };
      place(app.snapshot());
      app.onFrame(place);
    },
    viewBodyAtPhase(bodyId, phaseDeg, distance, towardsDeg = 0) {
      const place = (snapshot: SimSnapshot): void => {
        const b = snapshot.bodies.find((x) => x.id === bodyId)!;
        const side = quat.rotate(quat.fromAxisAngle(b.sunDir, (towardsDeg * Math.PI) / 180), v3.anyOrthogonal(b.sunDir));
        const out = quat.rotate(quat.fromAxisAngle(v3.cross(b.sunDir, side), (phaseDeg * Math.PI) / 180), b.sunDir);
        app.camera.spec = { type: 'free', positionRoot: v3.addScaled(b.rRoot, out, distance), qViewToRoot: lookRotation(v3.neg(out), v3.cross(b.sunDir, side)) };
      };
      place(app.snapshot());
      app.onFrame(place);
    },
    trackSiteFromVessel(atSite, offsetUp = 30) {
      const place = (snapshot: SimSnapshot): void => {
        const b = snapshot.bodies.find((x) => x.id === atSite.bodyId)!;
        const v = snapshot.vessels.find((x) => x.id === snapshot.activeVesselId)!;
        const up = v3.normalize(v3.sub(v.rRoot, b.rRoot));
        const eye = v3.addScaled(v.rRoot, up, offsetUp);
        const target = v3.add(b.rRoot, quat.rotate(b.qFixedToRoot, siteFrameFixed(atSite, app.defs).posFixed));
        app.camera.spec = { type: 'free', positionRoot: eye, qViewToRoot: lookRotation(v3.sub(target, eye), up) };
      };
      place(app.snapshot());
      app.onFrame(place);
    },
    projectSitePoint(posEnu, atSite = site) {
      const f = app.renderer.frameContext;
      if (!f) return null;
      const b = f.bodyPose(atSite.bodyId);
      const { posFixed, qEnuToFixed } = siteFrameFixed(atSite, app.defs);
      const p = v3.add(b.centerRelCam, quat.rotate(b.qFixedToRoot, v3.add(posFixed, quat.rotate(qEnuToFixed, v3.fromTuple(posEnu)))));
      const c = mat4.transformPoint(mat4.mul(f.projUnjittered, f.view), p);
      if (c.w <= 0) return null;
      return { x: (0.5 + (0.5 * c.x) / c.w) * f.renderSize[0], y: (0.5 - (0.5 * c.y) / c.w) * f.renderSize[1] };
    },
    projectBody(bodyId) {
      const f = app.renderer.frameContext;
      if (!f) return null;
      const b = f.bodyPose(bodyId);
      const c = mat4.transformPoint(mat4.mul(f.projUnjittered, f.view), b.centerRelCam);
      if (c.w <= 0) return null;
      const r = app.defs.bodies[bodyId]!.radius / v3.len(b.centerRelCam);
      return { x: (0.5 + (0.5 * c.x) / c.w) * f.renderSize[0], y: (0.5 - (0.5 * c.y) / c.w) * f.renderSize[1], radius: (Math.asin(Math.min(1, r)) / f.camera.fovY) * f.renderSize[1] };
    },
    directionAtSite(bodyId) {
      const s = app.snapshot();
      const home = s.bodies.find((x) => x.id === site.bodyId)!;
      const other = s.bodies.find((x) => x.id === bodyId)!;
      const { posFixed, qEnuToFixed } = siteFrameFixed(site, app.defs);
      const q = quat.mul(home.qFixedToRoot, qEnuToFixed);
      const origin = v3.add(home.rRoot, quat.rotate(home.qFixedToRoot, posFixed));
      const d = v3.normalize(quat.rotateInv(q, v3.sub(other.rRoot, origin)));
      return { azDeg: (Math.atan2(d.x, d.y) * 180) / Math.PI, elDeg: (Math.asin(d.z) * 180) / Math.PI };
    },
    overrideTerrainBrdf(wgsl) {
      defaultTerrain ??= app.renderer.core.shaders.expand('default', '#include "brdf_terrain"').code;
      app.renderer.context.shaders.register('brdf_terrain', wgsl ?? defaultTerrain);
    },
  };
  window.__rc = lab;

  if (query.get('hud') !== '0') {
    setInterval(() => {
      const p = app.renderer.perfSnapshot();
      const e = app.renderer.exposureInfo();
      info.textContent =
        `render-core lab   scene ${scene}   ${p.counters.renderWidth ?? 0} x ${p.counters.renderHeight ?? 0}  scale ${p.renderScale.toFixed(2)}  quality ${p.qualityScale.toFixed(2)}\n` +
        `gpu ${p.gpu.p50.toFixed(2)} ms (p99 ${p.gpu.p99.toFixed(2)})   cpu ${p.cpu.p50.toFixed(2)} ms   raf ${p.raf.p50.toFixed(1)} ms\n` +
        `EV100 ${e.ev100.toFixed(2)} (target ${e.targetEv100.toFixed(2)}, lit ${(e.litFraction * 100).toFixed(2)} %)   cascades ${p.counters.shadowCascades ?? 0} (${p.counters.shadowCascadesRendered ?? 0} drawn)`;
    }, 250);
  }
  await app.testApi.api.waitFrames(3);
  app.testApi.markReady(app.testApi.api.errors.length === 0);
}

boot().catch((err: unknown) => {
  console.error(err);
  window.__test?.errors.push(`lab boot: ${err instanceof Error ? err.message : String(err)}`);
});
