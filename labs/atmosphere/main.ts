/**
 * Atmosphere and cloud lab: the atmosphere feature alone on the LabPlanet backdrop, with the sun pinned
 * where a test wants it.
 *
 *   ?site=lat,lon[,alt]       reference site on the root body (default: the first launch site)
 *   &sun=az,el                sun azimuth / elevation (deg) at the site (default 135, 55)
 *   &view=lat,lon,alt,heading,pitch   camera on the root body (deg, m); default: 2 m above the site, looking north-east
 *   &atmosphere=0             no atmosphere feature at all (A/B against the bare backdrop)
 *   &clouds=0                 atmosphere only
 *   &fine=0                   half-resolution march at every distance (A/B against the full-resolution tile of small shells)
 *   &cover=c[,topKm]          replace the baked coverage map by a uniform one (c in 0..1, cloud top in km)
 *   &cp=key:value;key:value   override cloud tunables of the root body (CloudRenderDef.params) for this page
 *   &ap=key:value;...         override scalar atmosphere tunables of the root body (AtmosphereRenderDef)
 *   &planet=0  &sky=0  &relief=0   switch the LabPlanet, the sun disc + stars, the mountain backdrop off
 *   &maps=synthetic           LabPlanet albedo from a procedural map instead of the baked albedoLowRes
 *   &hud=0                    no text overlay
 *   &quality=q                pin FrameContext.qualityScale at q (< 1) through the governor (not in deterministic mode)
 *   &heavy=N                  ballast pass of N iterations (perf specs: a GPU at the clock of a real frame)
 *   &tail=1                   an empty timed pass behind the atmosphere composite ('lab-tail.composite', perf diagnosis)
 * plus every renderer parameter of createLabApp (scale, governor, perf, ev, fov, deterministic, paused).
 * Specs drive the rest through window.__lab and window.__atmo.
 */
import type { DefLibrary } from '@/core/contracts/defs';
import type { RenderFeature } from '@/core/contracts/render';
import type { SimSnapshot } from '@/core/contracts/sim';
import { createFakeSim } from '@/core/fakes/fakeSim';
import { DEG, quat, v3 } from '@/core/math';
import { createAtmosphereFeature, type AtmosphereFeature, type CoverageImage } from '@/render/atmosphere';
import { cameraBasis, discVisibleFraction } from '@/render/core';
import { createLabApp, createLabPlanetFeature, lookRotation, type LabApp, type LabCameraSpec } from '@/render/core/lab';
import { createLabHeavy, createLabQuads, createLabReliefFeature, createLabSkyFeature, createLabTail, createLabVolume, type LabHeavy, type LabQuad, type LabQuads, type LabVolume } from './probes';
import { sunAtSite, withSunOverride, type Site, type SunOverride } from './world';

export interface AtmosphereLabView {
  latDeg: number;
  lonDeg: number;
  /** Camera height above the reference radius, m. */
  alt: number;
  /** Compass heading (deg clockwise from north) and pitch above the horizon (deg). */
  headingDeg: number;
  pitchDeg: number;
  fovDeg?: number;
}

export interface AtmosphereLab {
  app: LabApp;
  site: Site;
  feature: AtmosphereFeature;
  quads: LabQuads;
  volume: LabVolume;
  heavy: LabHeavy;
  /** Put the camera on the root body. */
  view(v: AtmosphereLabView): void;
  /** Pin the sun at azimuth / elevation (deg) as seen from a point of the root body (default: the site). */
  setSun(azDeg: number, elDeg: number, at?: { latDeg: number; lonDeg: number }): void;
  /**
   * A solar eclipse by another body: the camera goes to the point of the root body that has `bodyId` at its
   * zenith, looking up at `pitchDeg`, and the sun is put behind that body as seen from there, `offsetDeg`
   * away from its centre (0 = central eclipse). Returns the place and the share of the solar disc that
   * stays visible from it.
   */
  viewEclipse(bodyId: string, offsetDeg: number, pitchDeg?: number, fovDeg?: number): { latDeg: number; lonDeg: number; visibleFraction: number };
  /** Camera `distance` metres from the centre of the root body, on the side given by sun-relative phase (0 = sub-solar, 180 = midnight). */
  viewFromSpace(distance: number, phaseDeg: number, fovDeg?: number): void;
  setQuads(q: LabQuad[]): void;
  /**
   * Start the clouds' temporal state again (no history, cloud clock at zero, shadow map re-marched): a
   * capture taken a fixed number of frames later repeats from run to run.
   */
  resetTemporal(): void;
  /**
   * Luminance (cd/m^2, linear sRGB) of render-target pixels: the pre-exposed HDR target divided by the
   * exposure of the frame. `rect` in render pixels (default: the centre pixel). `target`: 'hdr' = the scene
   * before temporal anti-aliasing (default), 'resolved' = after it (what goes to the tone mapper).
   */
  readLuminance(rect?: { x: number; y: number; width: number; height: number }, target?: 'hdr' | 'resolved'): Promise<{ width: number; height: number; data: Float32Array }>;
  /** Mean luminance (rgb) over a small square around a render-target pixel. */
  probe(x: number, y: number, half?: number): Promise<[number, number, number]>;
  /**
   * Where the view ray through a render-target pixel first meets the sphere `altitude` metres above the
   * reference radius of the root body: geographic position and distance from the eye (null: it misses).
   */
  surfacePoint(x: number, y: number, altitude: number): { latDeg: number; lonDeg: number; distance: number } | null;
}

declare global {
  interface Window {
    __atmo?: AtmosphereLab;
  }
}

const query = new URLSearchParams(location.search);
const numbers = (key: string): number[] | null => {
  const v = query.get(key);
  if (!v) return null;
  const a = v.split(',').map(Number);
  return a.every(Number.isFinite) ? a : null;
};

let site!: Site;
let sunOverride: SunOverride | null = null;

function uniformCoverage(coverage: number, topKm: number): CoverageImage {
  const width = 64;
  const height = 32;
  const data = new Uint8Array(width * height * 2);
  for (let i = 0; i < width * height; i++) {
    data[i * 2] = Math.round(Math.min(Math.max(coverage, 0), 1) * 255);
    data[i * 2 + 1] = Math.round(Math.min(Math.max((topKm * 1000) / 50, 0), 255));
  }
  return { width, height, data };
}

function oceanMap(): { width: number; height: number; data: Uint8Array<ArrayBuffer> } {
  // Mid-latitude continents on an ocean: enough structure to see where one is.
  const width = 256;
  const height = 128;
  const data = new Uint8Array(width * height * 4);
  for (let j = 0; j < height; j++) {
    for (let i = 0; i < width; i++) {
      const lon = (i / width) * 2 * Math.PI;
      const lat = (0.5 - j / height) * Math.PI;
      const land = Math.sin(3 * lon + 2 * Math.sin(2 * lat)) * Math.cos(2.2 * lat) + 0.35 * Math.sin(7 * lon - 3 * lat) > 0.55;
      const o = (j * width + i) * 4;
      data.set(land ? [138, 122, 92, 255] : [18, 44, 82, 255], o);
    }
  }
  return { width, height, data };
}

async function boot(): Promise<void> {
  const canvas = document.getElementById('viewport') as HTMLCanvasElement;
  const info = document.getElementById('info') as HTMLDivElement;
  let feature!: AtmosphereFeature;
  let quads!: LabQuads;
  let volume!: LabVolume;
  let heavy!: LabHeavy;
  const viewArg = numbers('view');

  const app = await createLabApp({
    canvas,
    name: 'atmosphere',
    scene: 'pad',
    autoReady: false,
    // A budget no frame can meet drives the governor straight down to the requested quality and holds it there.
    renderer: Number(query.get('quality')) > 0 && Number(query.get('quality')) < 1 ? { governor: { qualityMin: Number(query.get('quality')), budgetMs: 0.01 } } : undefined,
    sim: (defs: DefLibrary) => {
      const inner = createFakeSim(defs, { scene: 'pad' });
      const first = Object.values(defs.sites)[0];
      const s = numbers('site');
      site = { bodyId: defs.rootBodyId, latDeg: s?.[0] ?? first?.location.latDeg ?? 19, lonDeg: s?.[1] ?? first?.location.lonDeg ?? -155.6, alt: s?.[2] ?? 0 };
      const sun = numbers('sun') ?? [135, 55];
      sunOverride = sunAtSite(site, sun[0]!, sun[1]!);
      return withSunOverride(inner, () => sunOverride);
    },
    features: (defs) => {
      const list: RenderFeature[] = [];
      // Tunable overrides for this page only (the lab owns its copy of the definitions).
      const render = defs.bodies[defs.rootBodyId]!.render;
      for (const pair of (query.get('cp') ?? '').split(';').filter(Boolean)) {
        const [k, v] = pair.split(':');
        if (render.clouds && k) render.clouds.params[k] = Number(v);
      }
      for (const pair of (query.get('ap') ?? '').split(';').filter(Boolean)) {
        const [k, v] = pair.split(':');
        if (render.atmosphere && k) (render.atmosphere as unknown as Record<string, number>)[k] = Number(v);
      }
      if (query.get('planet') !== '0') {
        const maps: NonNullable<Parameters<typeof createLabPlanetFeature>[0]>['maps'] = {};
        if (query.get('maps') === 'synthetic') for (const b of Object.values(defs.bodies)) if (b.ocean) maps[b.id] = oceanMap();
        list.push(createLabPlanetFeature({ maps }));
      }
      if (query.get('relief') !== '0') list.push(createLabReliefFeature(site, defs));
      if (query.get('sky') !== '0') list.push(createLabSkyFeature());
      const cover = numbers('cover');
      feature = createAtmosphereFeature({
        clouds: query.get('clouds') !== '0',
        fineTile: query.get('fine') !== '0',
        coverageMaps: cover ? { [defs.rootBodyId]: uniformCoverage(cover[0]!, cover[1] ?? 3) } : undefined,
      });
      if (query.get('atmosphere') !== '0') list.push(feature);
      quads = createLabQuads(site, defs);
      volume = createLabVolume(site, defs);
      heavy = createLabHeavy(Number(query.get('heavy') ?? 0));
      list.push(quads.feature, volume.feature, heavy.feature);
      if (query.get('tail') === '1') list.push(createLabTail());
      return list;
    },
    camera: (): LabCameraSpec => ({
      type: 'surface',
      bodyId: site.bodyId,
      latDeg: viewArg?.[0] ?? site.latDeg,
      lonDeg: viewArg?.[1] ?? site.lonDeg,
      alt: viewArg?.[2] ?? site.alt + 2,
      headingDeg: viewArg?.[3] ?? 40,
      pitchDeg: viewArg?.[4] ?? 8,
    }),
  });

  const lab: AtmosphereLab = {
    surfacePoint: () => null,
    app,
    site,
    feature,
    quads,
    volume,
    heavy,
    view(v) {
      app.onFrame(null);
      app.camera.spec = { type: 'surface', bodyId: site.bodyId, latDeg: v.latDeg, lonDeg: v.lonDeg, alt: v.alt, headingDeg: v.headingDeg, pitchDeg: v.pitchDeg };
      if (v.fovDeg) app.camera.settings.fovY = v.fovDeg * DEG;
    },
    setSun(azDeg, elDeg, at) {
      sunOverride = sunAtSite(at ? { ...site, latDeg: at.latDeg, lonDeg: at.lonDeg } : site, azDeg, elDeg);
    },
    viewFromSpace(distance, phaseDeg, fovDeg) {
      if (fovDeg) app.camera.settings.fovY = fovDeg * DEG;
      const place = (snapshot: SimSnapshot): void => {
        const b = snapshot.bodies.find((x) => x.id === site.bodyId)!;
        // The sub-solar direction turned about the spin axis by the phase angle; spin axis up in the image.
        const axis = quat.rotate(b.qFixedToRoot, { x: 0, y: 0, z: 1 });
        const out = v3.normalize(quat.rotate(quat.fromAxisAngle(axis, phaseDeg * DEG), b.sunDir));
        app.camera.spec = { type: 'free', positionRoot: v3.addScaled(b.rRoot, out, distance), qViewToRoot: lookRotation(v3.neg(out), axis) };
      };
      place(app.snapshot());
      app.onFrame(place);
    },
    viewEclipse(bodyId, offsetDeg, pitchDeg = 60, fovDeg) {
      const s = app.snapshot();
      const root = s.bodies.find((b) => b.id === site.bodyId)!;
      const other = s.bodies.find((b) => b.id === bodyId)!;
      const star = s.bodies.find((b) => b.id === s.starId)!;
      const rb = app.defs.bodies[site.bodyId]!.radius;
      // The point under the other body, in the root body's fixed frame.
      const toOther = v3.normalize(v3.sub(other.rRoot, root.rRoot));
      const fixed = quat.rotate(quat.conj(root.qFixedToRoot), toOther);
      const latDeg = Math.asin(fixed.z) / DEG;
      const lonDeg = Math.atan2(fixed.y, fixed.x) / DEG;
      const eye = v3.addScaled(root.rRoot, toOther, rb + 2);
      // Direction from the eye to the other body, turned by the offset about an axis across it.
      const dir = v3.normalize(v3.sub(other.rRoot, eye));
      const axis = v3.normalize(v3.cross(dir, quat.rotate(root.qFixedToRoot, { x: 0, y: 0, z: 1 })));
      const sunDir = quat.rotate(quat.fromAxisAngle(axis, offsetDeg * DEG), dir);
      sunOverride = { dirRoot: () => sunDir };
      lab.view({ latDeg, lonDeg, alt: 2, headingDeg: 0, pitchDeg, fovDeg });
      const rs = Math.asin(app.defs.bodies[s.starId]!.radius / v3.dist(star.rRoot, root.rRoot));
      const ro = Math.asin(app.defs.bodies[bodyId]!.radius / v3.dist(other.rRoot, eye));
      return { latDeg, lonDeg, visibleFraction: discVisibleFraction(rs, ro, offsetDeg * DEG) };
    },
    setQuads(q) {
      quads.set(q);
    },
    resetTemporal() {
      feature.debug.clouds()?.resetTemporal(0);
    },
    async readLuminance(rect, target = 'hdr') {
      const f = app.renderer.frameContext!;
      const r = rect ?? { x: f.renderSize[0] >> 1, y: f.renderSize[1] >> 1, width: 1, height: 1 };
      const px = await app.renderer.readHdrPixels(target, r);
      const e = app.renderer.exposureInfo().exposure;
      const data = new Float32Array(px.data.length);
      for (let i = 0; i < data.length; i++) data[i] = (i & 3) === 3 ? px.data[i]! : px.data[i]! / e;
      return { width: px.width, height: px.height, data };
    },
    async probe(x, y, half = 1) {
      const f = app.renderer.frameContext!;
      const x0 = Math.max(0, Math.min(f.renderSize[0] - 1, Math.round(x) - half));
      const y0 = Math.max(0, Math.min(f.renderSize[1] - 1, Math.round(y) - half));
      const w = Math.min(2 * half + 1, f.renderSize[0] - x0);
      const h = Math.min(2 * half + 1, f.renderSize[1] - y0);
      const px = await lab.readLuminance({ x: x0, y: y0, width: w, height: h });
      const s: [number, number, number] = [0, 0, 0];
      for (let i = 0; i < w * h; i++) for (let c = 0; c < 3; c++) s[c]! += px.data[i * 4 + c]! / (w * h);
      return s;
    },
  };
  lab.surfacePoint = (x, y, altitude) => {
    const f = app.renderer.frameContext!;
    const body = f.bodies.find((b) => b.id === site.bodyId)!;
    const basis = cameraBasis(f.camera);
    const tanY = Math.tan(f.camera.fovY / 2);
    const tanX = (tanY * f.renderSize[0]) / f.renderSize[1];
    const nx = ((x + 0.5) / f.renderSize[0]) * 2 - 1;
    const ny = 1 - ((y + 0.5) / f.renderSize[1]) * 2;
    const d = v3.normalize(v3.add(basis.forward, v3.add(v3.scale(basis.right, nx * tanX), v3.scale(basis.up, ny * tanY))));
    const r = app.defs.bodies[site.bodyId]!.radius + altitude;
    const b = v3.dot(d, body.centerRelCam);
    const disc = b * b - (v3.lenSq(body.centerRelCam) - r * r);
    if (disc < 0 || b - Math.sqrt(disc) <= 0) return null;
    const t = b - Math.sqrt(disc);
    const fixed = quat.rotate(quat.conj(body.qFixedToRoot), v3.sub(v3.scale(d, t), body.centerRelCam));
    const n = v3.normalize(fixed);
    return { latDeg: Math.asin(n.z) / DEG, lonDeg: Math.atan2(n.y, n.x) / DEG, distance: t };
  };
  window.__atmo = lab;

  if (query.get('hud') !== '0') {
    setInterval(() => {
      const p = app.renderer.perfSnapshot();
      const e = app.renderer.exposureInfo();
      const sel = feature.debug.selection();
      const cam = app.cameraState();
      const pose = app.renderer.frameContext?.bodies.find((b) => b.id === site.bodyId);
      const passes = app.renderer.passStats();
      const ms = (prefix: string): number =>
        Object.entries(passes)
          .filter(([n]) => n.startsWith(prefix))
          .reduce((a, [, v]) => a + v.p50, 0);
      info.textContent =
        `atmosphere lab   ${p.counters.renderWidth ?? 0} x ${p.counters.renderHeight ?? 0}  scale ${p.renderScale.toFixed(2)}  quality ${p.qualityScale.toFixed(2)}  fov ${(cam.fovY / DEG).toFixed(0)}\n` +
        `altitude ${((pose?.cameraAltitude ?? 0) / 1000).toFixed(2)} km   EV100 ${e.ev100.toFixed(2)}   gpu ${p.gpu.p50.toFixed(2)} ms\n` +
        `marched: ${sel.bodies.map((b) => `${b.bodyId} x${b.steps}`).join(', ') || 'none'}   clouds: ${sel.cloudBodyId ?? 'none'}\n` +
        `atmosphere ${(ms('atmosphere.') - ms('atmosphere.cloud')).toFixed(3)} ms   clouds ${ms('atmosphere.cloud').toFixed(3)} ms`;
    }, 250);
  }
  await app.testApi.api.waitFrames(3);
  app.testApi.markReady(app.testApi.api.errors.length === 0);
}

boot().catch((err: unknown) => {
  console.error(err);
  window.__test?.errors.push(`lab boot: ${err instanceof Error ? err.message : String(err)}`);
});
