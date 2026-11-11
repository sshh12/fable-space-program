/**
 * Ocean lab: the ocean feature on the LabPlanet backdrop (which implements the terrain side of the near-field
 * hand-over), under the lab sky, with props for the shoreline, refraction and splashdown scenes.
 *
 *   ?preset=midday|sunset|overcast|alt500|alt10k|alt100k|leo|shore|splash|night|refraction   (default midday)
 *   &ocean=0      without the ocean feature (the far water alone, default brdf_water)
 *   &near=0       the ocean feature with its near field forced off (deferred far water only)
 *   &chop=<s>     scale of the FFT chop (debug; 1 = data)
 * plus every camera / renderer parameter of createLabApp. Specs drive the rest through window.__ocean.
 */
import type { RenderFeature } from '@/core/contracts/render';
import { createFakeSim } from '@/core/fakes/fakeSim';
import { DEG, quat, v3, type Vec3 } from '@/core/math';
import { createLabApp, createLabPlanetFeature, type LabApp, type LabCameraSpec } from '@/render/core/lab';
import { createOceanFeature, type OceanFeature } from '@/render/ocean';
import { createBallastFeature, type Ballast } from './ballast';
import { createLabSkyFeature, type LabSky } from './labSky';
import { offsetDir, OceanLabWorld, waterHeight, type LabSite } from './labSim';
import { createLabPropsFeature, type LabProps } from './props';

export interface OceanPreset {
  sun: [number, number] | null;
  moon?: [number, number] | null;
  /** Camera: ENU offset from the site (m), height above sea level (m), heading / pitch (deg). */
  camera: { east?: number; north?: number; alt: number; heading: number; pitch: number; fov?: number };
  overcast?: boolean;
  beach?: boolean;
  submerged?: boolean;
  floating?: boolean;
  markers?: { east: number; north: number }[];
  ev?: number;
}

const markerLine = (north0: number, count: number, step: number, east = 0): { east: number; north: number }[] =>
  Array.from({ length: count }, (_, i) => ({ east: east + (i - (count - 1) / 2) * 1.4, north: north0 + i * step }));

// Orbital and high views are exposed like a real camera in sunlight (sunny 16, EV 15): with no clouds or land in
// the lab the meter would otherwise expose the dark sea to mid-grey.
export const PRESETS: Record<string, OceanPreset> = {
  midday: { sun: [12, 62], camera: { alt: 2, heading: 12, pitch: -9 } },
  sunset: { sun: [268, 2.5], camera: { alt: 2, heading: 268, pitch: -2.5 } },
  overcast: { sun: [40, 35], overcast: true, camera: { alt: 2, heading: 200, pitch: -7 } },
  alt500: { sun: [10, 48], camera: { alt: 500, heading: 10, pitch: -28 }, ev: 15 },
  alt10k: { sun: [15, 50], camera: { alt: 10000, heading: 15, pitch: -40 }, ev: 15 },
  alt100k: { sun: [20, 55], camera: { alt: 100000, heading: 20, pitch: -52, fov: 55 }, ev: 15 },
  leo: { sun: [0, 58], camera: { alt: 400000, heading: 0, pitch: -55, fov: 60 }, ev: 15 },
  shore: { sun: [150, 38], beach: true, camera: { north: 215, alt: 3.5, heading: 4, pitch: -7 } },
  splash: { sun: [140, 36], floating: true, markers: markerLine(14, 6, 1.6, 3.2), camera: { north: -2, east: -6, alt: 3.2, heading: 32, pitch: -9 } },
  night: { sun: [300, -32], moon: [110, 24], camera: { alt: 2, heading: 110, pitch: -4 }, ev: -1.5 },
  refraction: { sun: [160, 58], beach: true, submerged: true, camera: { north: 300, east: 0, alt: 2.5, heading: 0, pitch: -16 } },
};

export interface OceanLab {
  app: LabApp;
  world: OceanLabWorld;
  ocean: OceanFeature | null;
  sky: LabSky;
  props: LabProps;
  /** GPU ballast for perf measurements (iterations of a fullscreen burn; 0 = off). */
  ballast: Ballast;
  site: LabSite;
  preset: string;
  applyPreset(name: string): void;
  /** Place the camera: ENU offset from the site (m), height above the reference radius (m), heading / pitch (deg). */
  setCamera(c: OceanPreset['camera']): void;
  setSun(azEl: [number, number] | null): void;
  /** Body-fixed unit direction of a point east / north of the site. */
  dirAt(east: number, north: number): Vec3;
  /** Physics water height above sea level there, at the snapshot time. */
  waterAt(east: number, north: number): number;
  /**
   * The unjittered view ray through render pixel (x, y) (centre) of the last frame, float64, and where it meets the
   * sea-level sphere: eye distance (m), body-fixed unit direction of the hit, and the ray in ROOT axes.
   */
  seaHit(x: number, y: number): { dist: number; dirFixed: Vec3; ray: Vec3 } | null;
  /** Height above sea level (m) of the point at eye distance t along the ray through pixel (x, y), float64. */
  altitudeAlong(x: number, y: number, t: number): number;
  /** Body-fixed unit direction of the point at eye distance t along the ray through pixel (x, y). */
  dirAlong(x: number, y: number, t: number): Vec3;
  /** Render pixel (x, y) of a body-fixed point (m from the body centre), or null behind the camera. */
  project(posFixed: Vec3): { x: number; y: number; dist: number } | null;
}

declare global {
  interface Window {
    __ocean?: OceanLab;
  }
}

const query = new URLSearchParams(location.search);
const presetName = query.get('preset') ?? 'midday';

async function boot(): Promise<void> {
  const canvas = document.getElementById('viewport') as HTMLCanvasElement;
  const info = document.getElementById('info') as HTMLDivElement;
  let world!: OceanLabWorld;
  const holder: { ocean: OceanFeature | null } = { ocean: null };
  const ballast = createBallastFeature();
  ballast.iterations = Number(query.get('ballast') ?? 0) || 0;
  let sky!: LabSky;
  let props!: LabProps;
  const site: LabSite = { bodyId: 'earth', latDeg: 8, lonDeg: -146 };
  const camSpec = (c: OceanPreset['camera']): LabCameraSpec => {
    const dir = offsetDir(site, c.east ?? 0, c.north ?? 0, 6371000);
    const lat = Math.asin(dir.z) / DEG;
    const lon = Math.atan2(dir.y, dir.x) / DEG;
    return { type: 'surface', bodyId: site.bodyId, latDeg: lat, lonDeg: lon, alt: c.alt, headingDeg: c.heading, pitchDeg: c.pitch };
  };
  const preset = PRESETS[presetName] ?? PRESETS.midday!;
  const app = await createLabApp({
    canvas,
    name: 'ocean',
    autoReady: false,
    sim: (defs) => {
      site.bodyId = defs.rootBodyId;
      world = new OceanLabWorld(createFakeSim(defs, { scene: 'chutes' }), defs, site);
      return world.sim;
    },
    features: (defs) => {
      const list: RenderFeature[] = [ballast, createLabPlanetFeature({ defaultMap: 'tileset' })];
      sky = createLabSkyFeature();
      list.push(sky);
      props = createLabPropsFeature(world, defs);
      list.push(props);
      if (query.get('ocean') !== '0') {
        holder.ocean = createOceanFeature();
        list.push(holder.ocean);
      }
      return list;
    },
    camera: () => camSpec(preset.camera),
    cameraSettings: { fovY: (preset.camera.fov ?? 60) * DEG },
  });

  const ocean = holder.ocean;
  const unset = (): never => {
    throw new Error('ocean lab: not initialised');
  };
  const lab: OceanLab = {
    seaHit: unset,
    altitudeAlong: unset,
    dirAlong: unset,
    project: unset,
    app,
    world,
    ocean,
    sky,
    props,
    ballast,
    site,
    preset: presetName,
    applyPreset(name) {
      const p = PRESETS[name];
      if (!p) throw new Error(`unknown preset ${name}`);
      lab.preset = name;
      world.sun = p.sun;
      // The backdrop draws the Moon: keep it below the horizon unless the preset places it.
      world.moon = p.moon ?? [0, -60];
      world.floating = p.floating ? { east: 0, north: 22, draft: 0.95, boundingRadius: 2.6, submersion: 0.32 } : null;
      sky.overcast = p.overcast ?? false;
      props.beach = p.beach ?? false;
      props.submerged = p.submerged ?? false;
      props.markers = p.markers ?? [];
      app.camera.settings.fovY = (p.camera.fov ?? 60) * DEG;
      app.camera.spec = camSpec(p.camera);
      app.renderer.setExposureOverride(p.ev ?? (query.has('ev') ? Number(query.get('ev')) : null));
    },
    setCamera(c) {
      app.camera.spec = camSpec(c);
      if (c.fov) app.camera.settings.fovY = c.fov * DEG;
    },
    setSun(azEl) {
      world.sun = azEl;
    },
    dirAt: (east, north) => offsetDir(site, east, north, app.defs.bodies[site.bodyId]!.radius),
    waterAt: (east, north) => waterHeight(app.defs, site.bodyId, offsetDir(site, east, north, app.defs.bodies[site.bodyId]!.radius), app.snapshot().ut),
  };
  const rayOf = (x: number, y: number): Vec3 => {
    const fc = app.renderer.frameContext!;
    const cam = app.cameraState();
    const [w, h] = fc.renderSize;
    const ty = Math.tan(cam.fovY / 2);
    const tx = ty * (w / h);
    const ndcX = ((x + 0.5) / w) * 2 - 1;
    const ndcY = 1 - ((y + 0.5) / h) * 2;
    return v3.normalize(quat.rotate(cam.qViewToRoot, { x: ndcX * tx, y: ndcY * ty, z: -1 }));
  };
  const earthOf = (): { c: Vec3; q: ReturnType<typeof quat.identity>; R: number } => {
    const b = app.snapshot().bodies.find((x) => x.id === site.bodyId)!;
    const def = app.defs.bodies[site.bodyId]!;
    return { c: b.rRoot, q: b.qFixedToRoot, R: def.radius + (def.ocean?.seaLevel ?? 0) };
  };
  lab.seaHit = (x, y) => {
    const d = rayOf(x, y);
    const e = earthOf();
    const o = v3.sub(app.cameraState().positionRoot, e.c);
    const b = v3.dot(o, d);
    const r0 = v3.len(o);
    const h = r0 - e.R;
    const disc = b * b - (r0 * r0 - e.R * e.R);
    if (disc < 0 || b > 0) return null;
    // Cancellation-free near root: t = (r0^2 - R^2) / (-b + sqrt(disc)).
    const t = (h * (r0 + e.R)) / (-b + Math.sqrt(disc));
    const pFixed = quat.rotateInv(e.q, v3.addScaled(o, d, t));
    return { dist: t, dirFixed: v3.normalize(pFixed), ray: d };
  };
  lab.altitudeAlong = (x, y, t) => {
    const d = rayOf(x, y);
    const e = earthOf();
    const o = v3.sub(app.cameraState().positionRoot, e.c);
    const r0 = v3.len(o);
    const mu = v3.dot(o, d) / r0;
    const r = Math.sqrt(r0 * r0 + 2 * r0 * mu * t + t * t);
    // h0 + (2 r0 mu t + t^2) / (r + r0), stable for small heights.
    return r0 - e.R + (2 * r0 * mu * t + t * t) / (r + r0);
  };
  lab.dirAlong = (x, y, t) => {
    const d = rayOf(x, y);
    const e = earthOf();
    const o = v3.sub(app.cameraState().positionRoot, e.c);
    return v3.normalize(quat.rotateInv(e.q, v3.addScaled(o, d, t)));
  };
  lab.project = (posFixed) => {
    const fc = app.renderer.frameContext!;
    const cam = app.cameraState();
    const e = earthOf();
    const rel = v3.sub(v3.add(e.c, quat.rotate(e.q, posFixed)), cam.positionRoot);
    const v = quat.rotateInv(cam.qViewToRoot, rel);
    if (v.z >= 0) return null;
    const [w, h] = fc.renderSize;
    const ty = Math.tan(cam.fovY / 2);
    const tx = ty * (w / h);
    return { x: ((v.x / -v.z / tx + 1) / 2) * w - 0.5, y: ((1 - v.y / -v.z / ty) / 2) * h - 0.5, dist: v3.len(rel) };
  };
  window.__ocean = lab;
  const keepCamera = query.has('body') || query.has('orbit') || query.has('vessel');
  const camBefore = app.camera.spec;
  lab.applyPreset(presetName);
  if (keepCamera) app.camera.spec = camBefore;
  if (query.get('near') === '0') ocean?.debug.forceNearFieldOff(true);
  const chop = Number(query.get('chop') ?? '');
  if (Number.isFinite(chop) && query.has('chop')) ocean?.debug.setChopScale(chop);

  app.onFrame((s) => {
    const st = ocean?.debug.state();
    const nf = ocean?.debug.nearField();
    info.textContent =
      `ocean lab - preset ${lab.preset}   ut ${s.ut.toFixed(2)}\n` +
      (st ? `near field ${nf!.bodyIndex >= 0 ? 'on' : 'off'}   patches ${st.patches}   camera ${st.cameraHeight.toFixed(1)} m above the sea\n` : 'ocean feature off\n') +
      `exposure EV ${app.renderer.exposureInfo().ev100.toFixed(2)}`;
    void v3;
  });
  await app.testApi.api.waitFrames(4);
  app.testApi.markReady(app.testApi.api.errors.length === 0);
}

boot().catch((e: unknown) => {
  console.error(e);
});
