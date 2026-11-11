/**
 * vfx lab: every effect of src/render/vfx in isolation, on the render core's lab app.
 *
 *   /labs/vfx/?scene=<name>&...      scenes: labs/vfx/scenes.ts
 *   common parameters: night=1 | sun=<elevation deg>, ev=<EV100>, paused=1, hud=0, overcast=<m>, haze=<m>,
 *   noatmo=1 (compile the vfx shaders without applyAtmosphere), hide=<part def ids> (no stand-in geometry
 *   for them), ballast=<iterations> (GPU ballast pass), perf=features, scale=1, governor=off
 *
 * window.__vfx is the handle for specs: deterministic stepping, camera placement, scene controls and the
 * debug interface of the feature.
 */
import type { DefLibrary } from '@/core/contracts/defs';
import { DEG, quat, v3, type Vec3, type Vec3Tuple } from '@/core/math';
import { createLabApp, createLabPlanetFeature, lookRotation, type LabApp } from '@/render/core/lab';
import { createVfxFeature, type VfxFeature } from '@/render/vfx';
import { LabSim, utForSunElevation } from './labSim';
import { createLabBallast, createLabProps, createLabSky, type LabBallast, type LabProps, type LabSky } from './props';
import { sceneFor, type SceneCamera, type SceneDef, type SceneSetup } from './scenes';

export interface VfxLab {
  app: LabApp;
  sim: LabSim;
  feature: VfxFeature;
  props: LabProps;
  sky: LabSky;
  ballast: LabBallast;
  scene: SceneSetup;
  camera: SceneCamera;
  /** Advance the lab by `frames` frames of 1/60 s (the animation loop is stopped meanwhile), then pause. */
  step(frames: number): Promise<void>;
  /** Advance until the lab clock reaches `t` seconds, then pause. */
  runTo(t: number): Promise<void>;
  /** Render `frames` frames with the sim paused (TAA convergence). */
  settle(frames?: number): Promise<void>;
  /** Change the camera (any subset of the fields). */
  setCamera(c: Partial<SceneCamera>): void;
  /** Site-frame (east, north, up) position of a vessel. */
  vesselEnu(id: string): Vec3;
  /** Site-frame position of the middle of a vessel's burning nozzle exits (of its origin when nothing burns). */
  nozzleEnu(id: string): Vec3;
  /** Mean unit exhaust direction of a vessel's burning nozzles in the site frame (down when nothing burns). */
  plumeAxisEnu(id: string): Vec3;
  /**
   * Put the camera side-on to the first `length` metres of a vessel's plume, far enough away for them to
   * fill `fill` of the frame's height (the camera no longer follows the vessel).
   */
  framePlume(id: string, length: number, fill?: number): void;
  /**
   * Stop the animation loop and render exactly `frames` frames of 1/60 s, advancing the sim (`advance` true)
   * or not. The loop stays stopped (for exact readbacks); `resume()` starts it again.
   */
  renderExact(frames: number, advance: boolean): Promise<void>;
  /** Unit direction to the sun in the site frame (east, north, up). */
  sunEnu(): Vec3;
  resume(): void;
  /** Pixel of the internal render target that a site-frame point projects to (null behind the camera) and its distance from the eye. */
  project(enu: Vec3): { x: number; y: number; distance: number } | null;
}

declare global {
  interface Window {
    __vfx?: VfxLab;
  }
}

const query = new URLSearchParams(location.search);
const sceneName = query.get('scene') ?? 'engine';

const groundMap = (rgb: Vec3Tuple): { width: number; height: number; data: Uint8Array<ArrayBuffer> } => {
  const srgb = rgb.map((c) => Math.round(255 * Math.pow(c, 1 / 2.2)));
  return { width: 2, height: 1, data: new Uint8Array([srgb[0]!, srgb[1]!, srgb[2]!, 255, srgb[0]!, srgb[1]!, srgb[2]!, 255]) };
};

async function boot(): Promise<void> {
  const canvas = document.getElementById('viewport') as HTMLCanvasElement;
  const info = document.getElementById('info') as HTMLDivElement;
  let scene!: SceneDef;
  let setup!: SceneSetup;
  let sim!: LabSim;
  let feature!: VfxFeature;
  let props!: LabProps;
  let sky!: LabSky;
  let camera!: SceneCamera;
  const ballast = createLabBallast(Number(query.get('ballast') ?? 0));

  const app = await createLabApp({
    canvas,
    name: 'vfx',
    autoReady: false,
    sim: (defs: DefLibrary) => {
      scene = sceneFor(sceneName, query, defs);
      sim = new LabSim(defs, scene.site, utForSunElevation(defs, scene.site, scene.sunElevationDeg));
      setup = scene.build(sim);
      sim.script = setup.script ?? sim.script;
      camera = { ...setup.camera };
      return sim;
    },
    features: (defs) => {
      const maps: Record<string, 'none' | { width: number; height: number; data: Uint8Array<ArrayBuffer> }> = {};
      for (const id of Object.keys(defs.bodies)) maps[id] = 'none';
      if (scene.ground === 'land') maps[scene.site.bodyId] = groundMap([0.2, 0.17, 0.13]);
      if (scene.ground === 'water') maps[scene.site.bodyId] = groundMap([0.012, 0.035, 0.085]);
      props = createLabProps(sim, defs, { pad: scene.pad ?? null, hideParts: (query.get('hide') ?? '').split(',').filter(Boolean) });
      sky = createLabSky(sim, defs);
      feature = createVfxFeature(null, { debugSkipAtmosphere: query.get('noatmo') === '1' });
      return [ballast.feature, createLabPlanetFeature({ maps }), props.feature, sky.feature, feature];
    },
  });
  if (!query.has('ev') && scene.ev !== undefined && scene.ev !== null) app.renderer.setExposureOverride(scene.ev);
  if (query.has('overcast')) sky.setOvercast({ altitude: Number(query.get('overcast')), transmittance: 0.02 });
  if (query.has('haze')) sky.setHaze({ length: Number(query.get('haze')), luminance: [5200, 6000, 7000] });

  const placeCamera = (): void => {
    const snap = app.snapshot();
    const f = sim.siteFrame(snap);
    let target = camera.target;
    if (camera.follow) target = v3.add(target, sim.vessel(camera.follow).enu);
    const yaw = camera.yawDeg * DEG;
    const pitch = camera.pitchDeg * DEG;
    const out = { x: Math.sin(yaw) * Math.cos(pitch), y: Math.cos(yaw) * Math.cos(pitch), z: Math.sin(pitch) };
    const eye = v3.addScaled(target, out, camera.distance);
    const toRoot = (v: Vec3): Vec3 => v3.add(v3.add(v3.scale(f.east, v.x), v3.scale(f.north, v.y)), v3.scale(f.up, v.z));
    app.camera.spec = { type: 'free', positionRoot: v3.add(f.origin, toRoot(eye)), qViewToRoot: lookRotation(toRoot(v3.neg(out)), f.up) };
    if (camera.fovDeg) app.camera.settings.fovY = camera.fovDeg * DEG;
  };
  const hud = query.get('hud') !== '0';
  app.onFrame(() => {
    placeCamera();
    if (hud) {
      const s = feature.debug.stats();
      info.textContent = `vfx lab: ${sceneName}   t ${sim.time.toFixed(2)} s\n${Object.entries(s)
        .map(([k, v]) => `${k} ${Number.isInteger(v) ? v : v.toFixed(2)}`)
        .join('   ')}`;
    }
  });
  placeCamera();

  const device = app.renderer.context.device;
  const lab: VfxLab = {
    app,
    sim,
    feature,
    props,
    sky,
    ballast,
    scene: setup,
    camera,
    async step(frames) {
      app.setLoop(false);
      app.setPaused(false);
      for (let i = 0; i < frames; i++) {
        app.renderFrame(1 / 60);
        if (i % 16 === 15) await device.queue.onSubmittedWorkDone();
      }
      app.setPaused(true);
      app.setLoop(true);
      await app.testApi.api.waitFrames(1);
    },
    async runTo(t) {
      const frames = Math.max(0, Math.round((t - sim.time) * 60));
      await lab.step(frames);
    },
    async settle(frames = 48) {
      app.setPaused(true);
      await app.testApi.api.waitFrames(frames);
    },
    setCamera(c) {
      Object.assign(camera, c);
      placeCamera();
    },
    vesselEnu: (id) => v3.clone(sim.vessel(id).enu),
    nozzleEnu(id) {
      const v = sim.vessel(id);
      let sum = v3.zero();
      let n = 0;
      for (const e of sim.engines(v)) {
        if (e.state.throttleActual <= 0) continue;
        for (const nz of e.def.nozzles) {
          const inVessel = v3.add(quat.rotate(e.part.localRot, v3.fromTuple(nz.pos)), e.part.localPos);
          sum = v3.add(sum, v3.add(v.enu, quat.rotate(v.qVesToEnu, inVessel)));
          n++;
        }
      }
      return n > 0 ? v3.scale(sum, 1 / n) : v3.clone(v.enu);
    },
    plumeAxisEnu(id) {
      const v = sim.vessel(id);
      let sum = v3.zero();
      for (const e of sim.engines(v)) {
        if (e.state.throttleActual <= 0) continue;
        for (const nz of e.def.nozzles) sum = v3.add(sum, quat.rotate(v.qVesToEnu, quat.rotate(e.part.localRot, v3.fromTuple(nz.dir))));
      }
      return v3.lenSq(sum) > 1e-9 ? v3.normalize(sum) : { x: 0, y: 0, z: -1 };
    },
    framePlume(id, length, fill = 0.8) {
      const from = lab.nozzleEnu(id);
      const axis = lab.plumeAxisEnu(id);
      let side = v3.cross(axis, { x: 0, y: 0, z: 1 });
      side = v3.lenSq(side) < 1e-6 ? { x: Math.sin(camera.yawDeg * DEG), y: Math.cos(camera.yawDeg * DEG), z: 0 } : v3.normalize(side);
      // Of the two sides, the one the camera is on already.
      const out = { x: Math.sin(camera.yawDeg * DEG), y: Math.cos(camera.yawDeg * DEG), z: 0 };
      if (v3.dot(side, out) < 0) side = v3.neg(side);
      const fov = (camera.fovDeg ?? 45) * DEG;
      lab.setCamera({
        follow: undefined,
        target: v3.addScaled(from, axis, 0.5 * length),
        yawDeg: Math.atan2(side.x, side.y) / DEG,
        pitchDeg: Math.asin(Math.max(-1, Math.min(1, side.z))) / DEG,
        distance: (0.5 * length) / Math.tan(fov / 2) / fill,
      });
    },
    async renderExact(frames, advance) {
      app.setLoop(false);
      app.setPaused(!advance);
      for (let i = 0; i < frames; i++) {
        app.renderFrame(1 / 60);
        if (i % 16 === 15) await device.queue.onSubmittedWorkDone();
      }
      app.setPaused(true);
      await device.queue.onSubmittedWorkDone();
    },
    resume() {
      app.setLoop(true);
    },
    sunEnu() {
      const snap = app.snapshot();
      const f = sim.siteFrame(snap);
      const body = snap.bodies.find((b) => b.id === sim.site.bodyId)!;
      return { x: v3.dot(body.sunDir, f.east), y: v3.dot(body.sunDir, f.north), z: v3.dot(body.sunDir, f.up) };
    },
    project(enu) {
      const fc = app.renderer.frameContext;
      if (!fc) return null;
      const f = sim.siteFrame(app.snapshot());
      const rel = v3.sub(v3.add(f.origin, v3.add(v3.add(v3.scale(f.east, enu.x), v3.scale(f.north, enu.y)), v3.scale(f.up, enu.z))), fc.camera.positionRoot);
      const m = fc.projUnjittered;
      const vw = fc.view;
      const vx = vw[0]! * rel.x + vw[4]! * rel.y + vw[8]! * rel.z;
      const vy = vw[1]! * rel.x + vw[5]! * rel.y + vw[9]! * rel.z;
      const vz = vw[2]! * rel.x + vw[6]! * rel.y + vw[10]! * rel.z;
      if (vz >= -0.05) return null;
      const ndcX = (m[0]! * vx) / -vz;
      const ndcY = (m[5]! * vy) / -vz;
      return { x: (ndcX * 0.5 + 0.5) * fc.renderSize[0], y: (0.5 - ndcY * 0.5) * fc.renderSize[1], distance: v3.len(rel) };
    },
  };
  window.__vfx = lab;
  await app.testApi.api.waitFrames(2);
  app.testApi.markReady(app.testApi.api.errors.length === 0);
}

boot().catch((err: unknown) => {
  console.error(err);
  window.__test?.errors.push(err instanceof Error ? err.message : String(err));
});
