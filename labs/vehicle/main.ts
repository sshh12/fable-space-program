/**
 * Vehicle and launch-complex lab: the real vessel and site features on the render core, driven by a lab
 * simulation built on the frozen vessel facade.
 *
 * Query string (besides the lab camera parameters of createLabApp: vessel= / offset= / look=, orbit= / target=,
 * body= ..., fov=, ev=, deterministic=1, perf=features, scale=, governor=off):
 *
 *   scene=pad|lowOrbit|lunarSurface|translunar|...   FakeSim scene that supplies bodies and time (default pad)
 *   place=pad|ground|space        where the stack stands (default from the scene)
 *   stage=<n>                     stages already fired (0 = full stack with clamps)
 *   only=<id,id,...>              keep only these part instance ids
 *   sun=<azDeg>,<elDeg>           sun fixed in the local horizon frame (pad / ground)
 *   sunv=<x>,<y>,<z>              sun direction in the frame of the vessel (of the focus= vessel when given)
 *   env=day|night|orbit|moon|void lab environment (default from the scene)
 *   site=0|1                      launch complex (default 1 on the pad)
 *   slab=0|1                      concrete test slab under a 'ground' placement (default 1)
 *   planet=0|1                    analytic lab planet (default 1)
 *   glass=0|1                     opaque exterior window panes (default 1)
 *   stages=<n>&coast=<s>&hold=1   fire n stages at start, let the pieces drift s seconds, then freeze time
 *   solo=1                        with focus=: show that vessel alone (the others are parked 200 km away)
 *   focus=<text>                  vessel that eye= / at= refer to: the first whose id, or one of whose part instance ids,
 *                                 contains the text (default: the active vessel)
 *   eye=<x,y,z>&at=<x,y,z>        camera and look-at point in the active vessel's frame with the nose (+Y) up
 *                                 (up=z for the dorsal side up); on the pad -Z is east and +X south
 *   ballast=<iterations>          GPU ballast pass for perf measurements
 *   hud=0                         hide the text overlay
 *
 * window.__veh is the lab handle: sim (VehicleLabSim), vehicle (VesselVisualFeature), site (SiteFeature),
 * env, and helpers used by the specs.
 */
import type { RenderFeature } from '@/core/contracts/render';
import { boxMesh, type MeshBatch, type ModelHandle, coreOf } from '@/render/core';
import { createLabApp, createLabPlanetFeature, type LabApp } from '@/render/core/lab';
import { createSiteFeature, createVesselVisualFeature, materialDef, type SiteFeature, type VesselVisualFeature } from '@/render/vehicle';
import type { FakeScene } from '@/core/fakes/fakeSim';
import { latLonToDir } from '@/core/geo/cubeSphere';
import { DEG, quat, v3 } from '@/core/math';
import { enuAt, lookRotation } from '@/render/core/lab';
import { createLabEnvFeature, type LabEnvKind } from './labEnv';
import { VehicleLabSim, type LabPlace, type SunSpec } from './labSim';

const params = new URLSearchParams(location.search);
const scene = (params.get('scene') ?? 'pad') as FakeScene;
const num = (key: string, fallback: number): number => {
  const v = params.get(key);
  return v === null || v === '' || !Number.isFinite(Number(v)) ? fallback : Number(v);
};
const flag = (key: string, fallback: boolean): boolean => (params.has(key) ? params.get(key) !== '0' : fallback);

/** Ground placement of the lunar and test scenes (the FakeSim's lunar site). */
const GROUND = { moon: { latDeg: 0.674, lonDeg: 23.473 } };

/** Flat concrete slab under a ground-placed vehicle (lab only). */
function createSlabFeature(sim: VehicleLabSim, place: Extract<LabPlace, { kind: 'ground' }>): RenderFeature {
  let batch: MeshBatch;
  let model: ModelHandle;
  return {
    id: 'lab-slab',
    init(ctx) {
      const core = coreOf(ctx);
      batch = core.meshes.createBatch('lab-slab');
      model = core.meshes.createModel({ name: 'lab-slab', lods: [boxMesh(60, 0.5, 60)], materials: [{ ...materialDef('concrete-wall'), name: 'lab-slab', baseColor: [0.62, 0.62, 0.6] }] });
    },
    prepare(frame) {
      batch.begin(frame);
      const body = frame.bodyPose(place.bodyId);
      const dir = latLonToDir(place.latDeg * DEG, place.lonDeg * DEG);
      const e = enuAt({ x: 0, y: 0, z: 0, w: 1 }, dir);
      // Slab frame: +Y up, top face at the placement height.
      const q = quat.fromBasis(e.east, e.up, v3.cross(e.east, e.up));
      const radius = sim.defs.bodies[place.bodyId]!.radius;
      const local = v3.scale(dir, radius + place.height - 0.25);
      batch.add(model, {
        originRelCam: v3.add(body.centerRelCam, quat.rotate(body.qFixedToRoot, local)),
        q: quat.mul(body.qFixedToRoot, q),
        prevOriginRelCam: v3.add(body.prevCenterRelCam, quat.rotate(body.prevQFixedToRoot, local)),
        prevQ: quat.mul(body.prevQFixedToRoot, q),
        bodyFixed: true,
      });
      batch.finish();
    },
    drawGBuffer: (_f, pass) => batch.drawGBuffer(pass),
    drawShadow: (_f, pass, cascade) => batch.drawShadow(pass, cascade),
  };
}

/** Fullscreen busy pass that keeps the GPU at a game-like load while passes are timed (lab only). */
function createBallastFeature(iterations: number): RenderFeature {
  let ctx: Parameters<RenderFeature['init']>[0];
  let pipeline: ReturnType<ReturnType<typeof coreOf>['fullscreenPipeline']>;
  let target: ReturnType<ReturnType<typeof coreOf>['createTarget']>;
  return {
    id: 'lab-ballast',
    init(c) {
      ctx = c;
      const core = coreOf(c);
      target = core.createTarget('lab-ballast', 'rgba8unorm', 1);
      pipeline = core.fullscreenPipeline({
        label: 'lab-ballast.burn',
        fragment: /* wgsl */ `
@fragment fn fs(in: FullscreenOut) -> @location(0) vec4f {
  var a = in.uv.x + frame.time.x * 0.001;
  for (var i = 0; i < ${Math.max(1, Math.round(iterations))}; i++) { a = fract(sin(a * 12.9898 + f32(i)) * 43758.5453); }
  return vec4f(a, a, a, 1.0);
}`,
        targets: [{ format: 'rgba8unorm' }],
      });
    },
    compute(frame, encoder) {
      const pass = encoder.beginRenderPass({
        label: 'lab-ballast.burn',
        colorAttachments: [{ view: target.view, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }],
        timestampWrites: ctx.perf.gpuPass('lab-ballast.burn') as GPURenderPassTimestampWrites | undefined,
      });
      pass.setBindGroup(0, frame.frameBindGroup);
      pass.setPipeline(pipeline.get());
      pass.draw(3);
      pass.end();
      // An empty pass behind the burn takes its tail, so the pass timed next is not charged for it.
      const tail = encoder.beginRenderPass({
        label: 'lab-ballast.tail',
        colorAttachments: [{ view: target.view, loadOp: 'load', storeOp: 'store' }],
        timestampWrites: ctx.perf.gpuPass('lab-ballast.tail') as GPURenderPassTimestampWrites | undefined,
      });
      tail.end();
    },
  };
}

export interface VehicleLab {
  app: LabApp;
  sim: VehicleLabSim;
  vehicle: VesselVisualFeature;
  /** The launch complex (null when the lab runs without it). */
  site: SiteFeature | null;
  env: ReturnType<typeof createLabEnvFeature>;
  setSun(sun: SunSpec | null): void;
  /** Camera and look-at point in the frame of the active vessel, or of the vessel matching `focus` (nose up). */
  setView(eye: [number, number, number], at: [number, number, number], focus?: string | null): void;
}

declare global {
  interface Window {
    __veh?: VehicleLab;
  }
}

async function boot(): Promise<void> {
  const canvas = document.getElementById('viewport') as HTMLCanvasElement;
  const info = document.getElementById('info') as HTMLDivElement;
  const placeKind = params.get('place') ?? (scene === 'pad' ? 'pad' : scene === 'lunarSurface' ? 'ground' : 'space');
  const envKind = (params.get('env') ?? (placeKind === 'pad' ? 'day' : scene === 'lunarSurface' ? 'moon' : placeKind === 'ground' ? 'day' : scene === 'lowOrbit' || scene === 'reentry' ? 'orbit' : 'void')) as LabEnvKind;
  let lab: VehicleLab | null = null;
  const tuple3 = (key: string): [number, number, number] | null => {
    const a = params.get(key)?.split(',').map(Number);
    return a && a.length === 3 && a.every(Number.isFinite) ? [a[0]!, a[1]!, a[2]!] : null;
  };
  let eye = tuple3('eye');
  let at = tuple3('at') ?? [0, 0, 0];
  const upAxis = params.get('up') ?? 'y';
  let focus = params.get('focus');
  const vehicle = createVesselVisualFeature({ exteriorGlass: flag('glass', true) });
  const env = createLabEnvFeature({ kind: envKind });
  // The lab planet has no relief: the pad surface is the reference sphere here.
  const site = flag('site', placeKind === 'pad') ? createSiteFeature({ padElevation: () => 0 }) : null;

  const app = await createLabApp({
    canvas,
    name: 'vehicle',
    scene,
    sim: (defs) => {
      const vehicleId = params.get('vehicle') ?? Object.keys(defs.vehicles)[0]!;
      const siteId = Object.keys(defs.sites)[0]!;
      let place: LabPlace;
      if (placeKind === 'pad') place = { kind: 'pad', siteId, padElevation: 0 };
      else if (placeKind === 'ground') {
        const bodyId = scene === 'lunarSurface' ? Object.values(defs.bodies).find((b) => b.parent === defs.rootBodyId && b.gravityRole === 'attractor')!.id : defs.rootBodyId;
        const site = defs.sites[siteId]!;
        const at = scene === 'lunarSurface' ? GROUND.moon : { latDeg: site.location.latDeg, lonDeg: site.location.lonDeg };
        place = { kind: 'ground', bodyId, latDeg: at.latDeg, lonDeg: at.lonDeg, height: num('height', 0.5), headingDeg: num('heading', 90) };
      } else place = { kind: 'space' };
      const only = params.get('only');
      const sim = new VehicleLabSim(defs, { scene, vehicleId, stagesFired: num('stage', 0), place, ...(only ? { onlyParts: only.split(',') } : {}) });
      const sun = params.get('sun')?.split(',').map(Number);
      const sunv = params.get('sunv')?.split(',').map(Number);
      if (sun && sun.length === 2) sim.setSun({ kind: 'local', azDeg: sun[0]!, elDeg: sun[1]! });
      else if (sunv && sunv.length === 3) sim.setSun({ kind: 'vessel', dir: [sunv[0]!, sunv[1]!, sunv[2]!], ...(focus ? { focus } : {}) });
      return sim;
    },
    features: (defs, sim) => {
      const s = sim as VehicleLabSim;
      const list: RenderFeature[] = [env];
      // On the ground the lab planet is a plain of weathered lava and scrub (one colour): the backdrop of the
      // pad, not a terrain. In space it shows the low-resolution albedo maps.
      const ground = { width: 2, height: 1, data: new Uint8Array([122, 108, 92, 255, 122, 108, 92, 255]) };
      if (flag('planet', true)) list.push(createLabPlanetFeature(placeKind === 'pad' || (placeKind === 'ground' && scene !== 'lunarSurface') ? { maps: { [defs.rootBodyId]: ground } } : {}));
      const place = s.placement;
      if (place.kind === 'ground' && flag('slab', true)) list.push(createSlabFeature(s, place));
      if (site) list.push(site);
      list.push(vehicle);
      if (params.has('ballast')) list.push(createBallastFeature(num('ballast', 2000)));
      return list;
    },
    onFrame: (snapshot) => {
      if (eye && lab) {
        // eye= / at= are given in the active vessel's frame with +Y (the nose) as "up": the view a person
        // standing by the stack has, which the lab's vessel camera (dorsal side up) does not give.
        const text = focus;
        const v = (text ? snapshot.vessels.find((x) => x.id.includes(text) || x.parts.some((p) => p.instanceId.includes(text))) : undefined) ?? snapshot.vessels.find((x) => x.id === snapshot.activeVesselId)!;
        const pos = v3.add(v.rRoot, quat.rotate(v.q, v3.fromTuple(eye)));
        const target = v3.add(v.rRoot, quat.rotate(v.q, v3.fromTuple(at)));
        const up = quat.rotate(v.q, upAxis === 'z' ? v3.unitZ() : v3.unitY());
        lab.app.camera.spec = { type: 'free', positionRoot: pos, qViewToRoot: lookRotation(v3.sub(target, pos), up) };
      }
      if (!lab || params.get('hud') === '0') return;
      const st = vehicle.stats;
      const perf = lab.app.renderer.perfSnapshot();
      info.textContent =
        `vehicle lab  scene ${scene}  stage ${lab.sim.nextStage}  vessels ${snapshot.vessels.length}\n` +
        `instances ${st.instances}  triangles ${st.triangles}  shadow tris ${st.shadowTriangles}  update ${st.updateMs.toFixed(3)} ms\n` +
        `gpu p50 ${perf.gpu.p50.toFixed(2)} ms  cpu p50 ${perf.cpu.p50.toFixed(2)} ms  ev ${lab.app.renderer.exposureInfo().ev100.toFixed(1)}`;
    },
    autoReady: false,
  });
  const sim = app.sim as VehicleLabSim;
  lab = {
    app,
    sim,
    vehicle,
    site,
    env,
    setSun: (sun) => sim.setSun(sun),
    setView: (e, a, f = null) => {
      eye = e;
      at = a;
      focus = f;
    },
  };
  window.__veh = lab;
  // stages=<n>: fire that many stages now; coast=<s>: let the separated vessels drift for s seconds.
  for (let i = 0; i < num('stages', 0); i++) sim.fireStage();
  for (let t = 0; t < num('coast', 0); t += 1 / 60) sim.advance(1 / 60);
  if (params.get('solo') === '1' && focus) sim.setSolo(focus);
  if (params.get('hold') === '1') app.setPaused(true);
  if (params.get('hud') === '0') info.style.display = 'none';
  await app.testApi.api.waitFrames(2);
  app.testApi.markReady(app.testApi.api.errors.length === 0);
}

boot().catch((err: unknown) => {
  console.error(err);
});
