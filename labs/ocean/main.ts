/**
 * Ocean lab: the ocean feature on the LabPlanet backdrop (which implements the terrain side of the near-field
 * hand-over), under the lab sky, with props for the shoreline, refraction and splashdown scenes.
 *
 *   ?preset=midday|sunset|overcast|down150|alt500|alt3k|alt10k|alt30k|alt100k|leo|shore|shoreAlong|coast60|splash|night|refraction
 *           (default midday)
 *   &stray=1      stray water-material fragments inside fadeStart (the terrain defect of request terrain-render-cs-1)
 *   &ocean=0      without the ocean feature (the far water alone, default brdf_water)
 *   &near=0       the ocean feature with its near field forced off (deferred far water only)
 *   &chop=<s>     scale of the FFT chop (debug; 1 = data)
 * plus every camera / renderer parameter of createLabApp. Specs drive the rest through window.__ocean.
 */
import type { RenderFeature } from '@/core/contracts/render';
import { createFakeSim } from '@/core/fakes/fakeSim';
import { DEG, quat, v3, type Vec3 } from '@/core/math';
import { createLabApp, createLabPlanetFeature, type LabApp, type LabCameraSpec } from '@/render/core/lab';
import { createOceanFeature, oceanRoughnessField, oceanTunables, type OceanFeature } from '@/render/ocean';
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

// Every daylight view is exposed by the renderer's meter, as the game's camera would expose it (`ev` only where a
// preset needs a fixed exposure: the night view, which the meter of a moonlit sea alone would turn into day).
export const PRESETS: Record<string, OceanPreset> = {
  midday: { sun: [12, 62], camera: { alt: 2, heading: 12, pitch: -9 } },
  sunset: { sun: [268, 2.5], camera: { alt: 2, heading: 268, pitch: -2.5 } },
  overcast: { sun: [40, 35], overcast: true, camera: { alt: 2, heading: 200, pitch: -7 } },
  // Straight down from 150 m: whitecaps and wave pattern as a parachute camera sees them (the sun low enough to
  // keep its glitter out of the frame).
  down150: { sun: [180, 30], camera: { alt: 150, heading: 0, pitch: -89.9 } },
  alt500: { sun: [10, 48], camera: { alt: 500, heading: 10, pitch: -28 } },
  // From 3 km up the views are the ones the reference photographs show (aircraft and orbital photographs of sun
  // glint are oblique, with the sun a third of the way up): the glint is seen at 55-60 deg from the vertical, where
  // the water mirrors three times more than under a high sun seen from above.
  alt3k: { sun: [12, 32], camera: { alt: 3000, heading: 12, pitch: -24 } },
  alt10k: { sun: [15, 30], camera: { alt: 10000, heading: 15, pitch: -27 } },
  alt30k: { sun: [18, 30], camera: { alt: 30000, heading: 18, pitch: -30 } },
  alt100k: { sun: [20, 30], camera: { alt: 100000, heading: 20, pitch: -24, fov: 55 } },
  leo: { sun: [0, 34], camera: { alt: 400000, heading: 0, pitch: -38, fov: 60 } },
  shore: { sun: [150, 38], beach: true, camera: { north: 215, alt: 3.5, heading: 4, pitch: -7 } },
  // Standing in the shallows 30 m off the waterline, looking along the shore: shelf water from 0 to 3 m deep.
  shoreAlong: { sun: [150, 38], beach: true, camera: { north: 335, east: -160, alt: 4, heading: 78, pitch: -6 } },
  // 60 m above the coast, looking along the shore: the shelf from the waterline to deep water, and the surf.
  coast60: { sun: [150, 38], beach: true, camera: { north: 120, alt: 60, heading: 70, pitch: -8 } },
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
  /**
   * The roughness field of the site body's sea (the factor on the Cox-Munk slope variance, mean 1) at a body-fixed
   * unit direction, seen with `footprint` metres.
   */
  roughness(dirFixed: Vec3, footprint: number): number;
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
    roughness: unset,
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
  const tunables = oceanTunables(app.defs.bodies[site.bodyId]!);
  const field = tunables ? oceanRoughnessField(tunables) : null;
  lab.roughness = (dirFixed, footprint) => (field ? field(dirFixed, footprint) : 1);
  window.__ocean = lab;
  const keepCamera = query.has('body') || query.has('orbit') || query.has('vessel');
  const camBefore = app.camera.spec;
  lab.applyPreset(presetName);
  if (keepCamera) app.camera.spec = camBefore;
  if (query.get('near') === '0') ocean?.debug.forceNearFieldOff(true);
  if (query.get('stray') === '1') props.strayWater = true;
  const chop = Number(query.get('chop') ?? '');
  if (Number.isFinite(chop) && query.has('chop')) ocean?.debug.setChopScale(chop);

  app.onFrame((s) => {
    const st = ocean?.debug.state();
    const nf = ocean?.debug.nearField();
    info.textContent =
      `ocean lab - preset ${lab.preset}   ut ${s.ut.toFixed(2)}\n` +
      (st ? `near field ${nf!.bodyIndex >= 0 ? 'on' : 'off'}   patches ${st.patches}   camera ${Number.isFinite(st.cameraHeight) ? `${st.cameraHeight.toFixed(1)} m above the sea` : 'not above a sea'}\n` : 'ocean feature off\n') +
      `exposure EV ${app.renderer.exposureInfo().ev100.toFixed(2)}`;
    void v3;
  });
  // Let the preset settle for a few frames. If frames stop coming, say so rather than leave the harness waiting.
  const settled = await Promise.race([
    app.testApi.api.waitFrames(4).then(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 30_000)),
  ]);
  if (!settled) app.testApi.reportError('ocean lab: no frame rendered within 30 s of set-up');
  app.testApi.markReady(settled && app.testApi.api.errors.length === 0);
}

boot().catch((e: unknown) => {
  // createLabApp reports its own failures; one in this lab's set-up must reach the harness too, not leave
  // window.__test.ready pending.
  const app = window.__lab;
  if (app) {
    app.testApi.reportError(e instanceof Error ? e.message : String(e));
    app.testApi.markReady(false);
  }
  console.error(e);
});
