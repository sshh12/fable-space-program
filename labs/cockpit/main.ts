/**
 * Cockpit lab: the Kestrel interior in the one scene against the FakeSim, with the real vehicle's part
 * snapshots (src/sim/vessel/public.ts), the shared navball renderer and MFD painter (src/ui), a lab-only
 * sky and probe (sky.ts) and a lab-only exterior stand-in (hull.ts).
 *
 * Query parameters:
 *   scene=pad|leo|night|reentry|moon     lab scene (default leo); each fixes the FakeSim scene, the stages
 *                                        already fired, attitude, sun and cabin lights
 *   view=cockpit|chase                   initial camera (default cockpit)
 *   look=<yawDeg>,<pitchDeg>             seat look direction (yaw right, pitch up), fov=<deg>
 *   aim=mfd0|mfd1|mfd2|fdai|switches|annunciator|hatch|windowL   look at a cockpit point
 *   g=<gLoad>, throttle=<0..1>, lights=0|1   lab decorations: g-load shown to the cabin, throttle, lights
 * Plus every createLabApp parameter (perf=features, scale=, governor=off, deterministic=1, ...).
 *
 * Keys 9 / 0 / minus cycle the pages of the three displays through a minimal mapping (the app shell does the
 * same through the input layer's 'mfdCycle:i' actions).
 */
import type { CapsuleMouldLineDef, DefLibrary } from '@/core/contracts/defs';
import type { Sim, SimSnapshot } from '@/core/contracts/sim';
import type { MfdPage } from '@/core/contracts/ui';
import { getSection } from '@/core/defs/loader';
import { createFakeSim, type FakeScene } from '@/core/fakes/fakeSim';
import { DEG, quat, v3, type Quat, type Vec3 } from '@/core/math';
import { createLabApp, createLabPlanetFeature, enuAt, lookRotation } from '@/render/core/lab';
import { createCockpitFeature, loadCockpitLayout, type CockpitFeature } from '@/render/cockpit';
import { seatFrames } from '@/render/cockpit/cabin/context';
import { assembleVessel, vesselPartSnapshots } from '@/sim/vessel/public';
import { createMfdPainter, createNavballRenderer } from '@/ui';
import { buildLabHull, createLabHullFeature } from './hull';
import { createLabSkyFeature } from './sky';

const params = new URLSearchParams(location.search);

type SunSpec = { site: [number, number] } | { window: string; target: string } | 'eclipse' | 'sim';
interface LabScene {
  fake: FakeScene;
  fired: number;
  attitude?: { roll?: number; pitch?: number; yaw?: number };
  sun: SunSpec;
  lights: boolean;
  look: [number, number];
}
const SCENES: Record<string, LabScene> = {
  pad: { fake: 'pad', fired: 0, sun: { site: [205, 64] }, lights: false, look: [18, 46] },
  leo: { fake: 'lowOrbit', fired: 4, attitude: { roll: -90 }, sun: { window: 'fwd-right', target: 'fdai' }, lights: false, look: [8, 2] },
  night: { fake: 'lowOrbit', fired: 4, attitude: { roll: -90 }, sun: 'eclipse', lights: true, look: [20, -2] },
  reentry: { fake: 'reentry', fired: 8, sun: 'eclipse', lights: false, look: [16, 40] },
  moon: { fake: 'lunarSurface', fired: 6, sun: { site: [255, 16] }, lights: false, look: [-88, -6] },
};
const sceneName = params.get('scene') ?? 'leo';
const scene = SCENES[sceneName] ?? SCENES.leo!;

interface CockpitLabApi {
  scene: string;
  look(yawDeg: number, pitchDeg: number, fovDeg?: number): void;
  aim(target: string, fovDeg?: number): [number, number];
  chase(windowId: string, distance: number, offsetDeg?: number): void;
  cockpit(): void;
  stats(): ReturnType<CockpitFeature['stats']> & { displays: { paints: number; cpuMs: number; frames: number }; painted: { page: MfdPage | null; tick: number; at: number }[] };
  resetDisplayStats(): void;
  page(i: number): MfdPage;
  setPage(i: number, p: MfdPage): void;
  cyclePage(i: number): void;
  mfdPixels(layer: number, x: number, y: number, w: number, h: number): Promise<number[]>;
  geometry(): { triangles: Record<string, number>; controls: number; labels: number; windows: number; floods: number };
  set(opts: { g?: number; throttle?: number; lights?: boolean }): void;
  keysSeen(): string[];
}
declare global {
  interface Window {
    __cockpit?: CockpitLabApi;
  }
}

/** Wraps the FakeSim: tags the vessel with the real vehicle, pins the sun, applies lab decorations. */
function labSim(inner: Sim, defs: DefLibrary, vehicleId: string, sun: () => SunSpec, deco: { g: number | null }, partSun: (s: SimSnapshot, spec: { window: string; target: string }) => Vec3 | null): Sim {
  const fix = (raw: SimSnapshot): SimSnapshot => {
    let s: SimSnapshot = { ...raw, vessels: raw.vessels.map((v) => (v.id === raw.activeVesselId ? { ...v, vehicleId, name: defs.vehicles[vehicleId]!.name } : v)) };
    if (deco.g !== null) s = { ...s, readouts: { ...s.readouts, gLoad: deco.g }, vessels: s.vessels.map((v) => (v.id === s.activeVesselId ? { ...v, gLoad: deco.g! } : v)) };
    const spec = sun();
    if (spec === 'sim') return s;
    const vessel = s.vessels.find((v) => v.id === s.activeVesselId)!;
    const body = s.bodies.find((b) => b.id === vessel.bodyId)!;
    let dir: Vec3 | null = null;
    if (spec === 'eclipse') dir = v3.normalize(v3.sub(body.rRoot, vessel.rRoot));
    else if ('site' in spec) {
      const up = v3.normalize(v3.sub(vessel.rRoot, body.rRoot));
      const fixedDir = quat.rotateInv(body.qFixedToRoot, up);
      const { east, north, up: u } = enuAt(body.qFixedToRoot, fixedDir);
      const az = spec.site[0] * DEG;
      const el = spec.site[1] * DEG;
      dir = v3.normalize(v3.add(v3.scale(v3.add(v3.scale(north, Math.cos(az)), v3.scale(east, Math.sin(az))), Math.cos(el)), v3.scale(u, Math.sin(el))));
    } else dir = partSun(s, spec);
    if (!dir) return s;
    const star = s.bodies.find((b) => b.id === s.starId)!;
    const root = s.bodies.find((b) => b.id === defs.rootBodyId)!;
    const dist = v3.dist(star.rRoot, root.rRoot);
    // The star is placed so that it is seen along `dir` from the vessel.
    const starPos = v3.addScaled(vessel.rRoot, dir, dist);
    return { ...s, bodies: s.bodies.map((b) => (b.id === s.starId ? { ...b, rRoot: starPos } : { ...b, sunDir: v3.normalize(v3.sub(starPos, b.rRoot)), sunDistance: v3.dist(starPos, b.rRoot) })) };
  };
  return {
    defs: inner.defs,
    scenario: inner.scenario,
    ready: inner.ready,
    terrainPending: () => inner.terrainPending(),
    advance: (dt, cb) => inner.advance(dt, cb),
    step: () => inner.step(),
    advanceRails: (t) => inner.advanceRails(t),
    get needsIntegration() {
      return inner.needsIntegration;
    },
    get nextEventUt() {
      return inner.nextEventUt;
    },
    setControls: (c) => inner.setControls(c),
    commands: inner.commands,
    snapshot: () => fix(inner.snapshot()),
    peek: () => fix(inner.peek()),
    get cheatCounter() {
      return inner.cheatCounter;
    },
    stateHash: () => inner.stateHash(),
    debug: inner.debug,
  };
}

/** Fly the FakeSim to an attitude (body-frame roll, then pitch, then yaw, degrees) with its own rate controls. */
function flyAttitude(sim: Sim, att: LabScene['attitude']): void {
  if (!att) return;
  const rate = 20;
  const neutral = { pitch: 0, yaw: 0, roll: 0, throttle: 0, translate: { x: 0, y: 0, z: 0 } };
  for (const [axis, deg] of [['roll', att.roll ?? 0], ['pitch', att.pitch ?? 0], ['yaw', att.yaw ?? 0]] as const) {
    let left = Math.abs(deg);
    const dt = 1 / 60;
    while (left > 1e-9) {
      const stepDeg = Math.min(left, rate * dt);
      sim.setControls({ ...neutral, [axis]: (Math.sign(deg) * stepDeg) / (rate * dt) });
      sim.advance(dt);
      left -= stepDeg;
    }
  }
  sim.setControls(neutral);
}

async function boot(): Promise<void> {
  const deco: { g: number | null } = { g: params.has('g') ? Number(params.get('g')) : null };
  let vehicleId = '';
  let feature: CockpitFeature | null = null;
  const sunSpec: SunSpec = scene.sun;
  const app = await createLabApp({
    canvas: document.getElementById('viewport') as HTMLCanvasElement,
    name: 'cockpit',
    autoReady: false,
    sim: (defs) => {
      vehicleId = Object.values(defs.vehicles).find((v) => v.cockpit)!.id;
      const parts = vesselPartSnapshots(assembleVessel(defs, vehicleId, { stagesAlreadyFired: scene.fired }));
      const fake = createFakeSim(defs, { scene: scene.fake, parts });
      flyAttitude(fake, scene.attitude);
      if (scene.lights || params.get('lights') === '1') fake.commands.toggleLights();
      const partSun = (s: SimSnapshot, spec: { window: string; target: string }): Vec3 | null => {
        const model = feature?.model(defs.vehicles[vehicleId]!.cockpit!);
        const vessel = s.vessels.find((v) => v.id === s.activeVesselId)!;
        if (!model) return null;
        const w = model.windows.find((x) => x.id === spec.window);
        const target = targetPoint(model, spec.target);
        if (!w || !target) return null;
        const part = vessel.parts.find((p) => p.instanceId === defs.vehicles[vehicleId]!.cameras.cockpit.part)!;
        const dPart = v3.normalize(v3.sub(w.centre, target));
        return quat.rotate(quat.mul(vessel.q, part.localRot), dPart);
      };
      return labSim(fake, defs, vehicleId, () => sunSpec, deco, partSun);
    },
    features: (defs) => {
      const vehicle = Object.values(defs.vehicles).find((v) => v.cockpit)!;
      const { layout, mould } = loadCockpitLayout(defs, vehicle.cockpit!);
      return [createLabPlanetFeature(), createLabSkyFeature(defs), createLabHullFeature(() => buildLabHull(layout, mould), vehicle.cameras.cockpit.part)];
    },
  });
  const defs = app.defs;
  const vehicle = defs.vehicles[vehicleId]!;
  const mould = getSection<CapsuleMouldLineDef>(defs, loadCockpitLayout(defs, vehicle.cockpit!).layout.mouldLine);
  const navball = createNavballRenderer(app.gpu);
  const created = createCockpitFeature(app.renderer.context, { navball, mfdPainter: createMfdPainter() });
  feature = created.feature;
  const controls = created.controls;
  await app.renderer.addFeature(feature);
  const model = feature.model(vehicle.cockpit!)!;

  // ---- seat camera
  const seat = seatFrames(mould).find((s) => s.id === vehicle.cameras.cockpit.seat)!;
  const qSeat = lookRotation(seat.L, seat.U);
  const look = { yaw: 0, pitch: 0, fov: Number(params.get('fov') ?? 70) };
  const lp = params.get('look')?.split(',').map(Number);
  [look.yaw, look.pitch] = lp && lp.length === 2 ? (lp as [number, number]) : scene.look;
  let mode: 'cockpit' | 'chase' = params.get('view') === 'chase' ? 'chase' : 'cockpit';
  let chaseSpec: { offset: Vec3; lookAt: Vec3 } | null = null;
  const aimAt = (p: Vec3): [number, number] => {
    const d = v3.normalize(v3.sub(p, seat.eye));
    return [Math.atan2(v3.dot(d, seat.R), v3.dot(d, seat.L)) / DEG, Math.asin(v3.dot(d, seat.U)) / DEG];
  };
  const aim = params.get('aim');
  if (aim) {
    const t = targetPoint(model, aim);
    if (t) [look.yaw, look.pitch] = aimAt(t);
  }
  const placeCamera = (s: SimSnapshot): void => {
    const vessel = s.vessels.find((v) => v.id === s.activeVesselId)!;
    const part = vessel.parts.find((p) => p.instanceId === vehicle.cameras.cockpit.part)!;
    const qPart: Quat = quat.mul(vessel.q, part.localRot);
    if (mode === 'cockpit') {
      const qLook = quat.mul(quat.fromAxisAngle(v3.unitY(), -look.yaw * DEG), quat.fromAxisAngle(v3.unitX(), look.pitch * DEG));
      app.camera.settings.kind = 'interior';
      app.camera.settings.fovY = look.fov * DEG;
      app.camera.spec = {
        type: 'free',
        positionRoot: v3.add(vessel.rRoot, quat.rotate(vessel.q, v3.add(part.localPos, quat.rotate(part.localRot, seat.eye)))),
        qViewToRoot: quat.normalize(quat.mul(qPart, quat.mul(qSeat, qLook))),
      };
    } else if (chaseSpec) {
      app.camera.settings.kind = 'external';
      app.camera.settings.fovY = look.fov * DEG;
      const toVes = (p: Vec3): [number, number, number] => {
        const q = v3.add(part.localPos, quat.rotate(part.localRot, p));
        return [q.x, q.y, q.z];
      };
      app.camera.spec = { type: 'vessel', vesselId: 'active', offset: toVes(chaseSpec.offset), lookAt: toVes(chaseSpec.lookAt) };
    }
  };
  const chase = (windowId: string, distance: number, offsetDeg = 0): void => {
    const w = model.windows.find((x) => x.id === windowId) ?? model.windows[0]!;
    const out = v3.neg(w.inward);
    const side = v3.normalize(v3.cross(out, { x: 0, y: 1, z: 0 }));
    const dir = v3.normalize(v3.add(v3.scale(out, Math.cos(offsetDeg * DEG)), v3.scale(side, Math.sin(offsetDeg * DEG))));
    chaseSpec = { offset: v3.addScaled(w.centre, dir, distance), lookAt: v3.addScaled(w.centre, w.inward, 0.6) };
    mode = 'chase';
  };
  if (mode === 'chase') chase(params.get('window') ?? 'fwd-left', Number(params.get('distance') ?? 2.5));
  if (params.has('throttle')) app.testApi.api.setControls({ throttle: Number(params.get('throttle')) });

  // ---- navball into 'ui.navball' every frame (the HUD does this in the app)
  app.onFrame((s) => {
    placeCamera(s);
    const enc = app.gpu.device.createCommandEncoder({ label: 'lab.navball' });
    navball.render(enc, s);
    app.gpu.device.queue.submit([enc.finish()]);
  });

  // ---- 9 / 0 / minus -> cyclePage(0 / 1 / 2)
  const keys: string[] = [];
  const KEYMAP: Record<string, number> = { Digit9: 0, Digit0: 1, Minus: 2 };
  window.addEventListener('keydown', (e) => {
    const i = KEYMAP[e.code];
    if (i === undefined || e.repeat) return;
    e.preventDefault();
    keys.push(e.code);
    controls.cyclePage(i);
  });

  window.__cockpit = {
    scene: sceneName,
    look(yaw, pitch, fov) {
      look.yaw = yaw;
      look.pitch = pitch;
      if (fov) look.fov = fov;
      mode = 'cockpit';
    },
    aim(target, fov) {
      const t = targetPoint(model, target);
      if (!t) throw new Error(`no cockpit target "${target}"`);
      [look.yaw, look.pitch] = aimAt(t);
      if (fov) look.fov = fov;
      mode = 'cockpit';
      return [look.yaw, look.pitch];
    },
    chase,
    cockpit() {
      mode = 'cockpit';
    },
    stats: () => ({ ...feature!.stats(), displays: { ...feature!.displays!.stats }, painted: feature!.displays!.painted.map((p) => ({ ...p })) }),
    resetDisplayStats: () => feature!.displays!.resetStats(),
    page: (i) => controls.page(i),
    setPage: (i, p) => controls.setPage(i, p),
    cyclePage: (i) => controls.cyclePage(i),
    async mfdPixels(layer, x, y, w, h) {
      const device = app.gpu.device;
      const tex = feature!.displays!.texture;
      const bpr = Math.ceil((w * 4) / 256) * 256;
      const buf = device.createBuffer({ size: bpr * h, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
      const enc = device.createCommandEncoder();
      enc.copyTextureToBuffer({ texture: tex, origin: [x, y, layer] }, { buffer: buf, bytesPerRow: bpr }, [w, h, 1]);
      device.queue.submit([enc.finish()]);
      await buf.mapAsync(GPUMapMode.READ);
      const src = new Uint8Array(buf.getMappedRange());
      const out: number[] = [];
      for (let j = 0; j < h; j++) for (let i = 0; i < w * 4; i++) out.push(src[j * bpr + i]!);
      buf.unmap();
      buf.destroy();
      return out;
    },
    geometry: () => ({ triangles: { ...model.triangles }, controls: model.controls.length, labels: model.labels.length, windows: model.windows.length, floods: model.floods.length }),
    set(o) {
      if (o.g !== undefined) deco.g = o.g;
      if (o.throttle !== undefined) app.testApi.api.setControls({ throttle: o.throttle });
      if (o.lights !== undefined && o.lights !== app.snapshot().readouts.lightsOn) app.sim.commands.toggleLights();
    },
    keysSeen: () => keys.slice(),
  };
  await app.testApi.api.waitFrames(3);
  app.testApi.markReady(app.testApi.api.errors.length === 0);
}

/** Named points of the cabin (part frame) for camera aiming and sun placement. */
function targetPoint(model: NonNullable<ReturnType<CockpitFeature['model']>>, name: string): Vec3 | null {
  if (name.startsWith('mfd')) return model.displays[Number(name.slice(3))]?.frame.o ?? null;
  if (name === 'fdai') return model.navball.frame.o;
  const ctl = (kind: string): Vec3 | null => model.controls.find((c) => c.kind === kind)?.pivot ?? null;
  if (name === 'switches') return ctl('toggle');
  if (name === 'annunciator') return model.controls.find((c) => c.kind === 'lamp' && c.key.startsWith('ann:'))?.pivot ?? null;
  if (name === 'hatch') return model.windows.find((w) => w.id === 'hatch-window')?.centre ?? null;
  if (name === 'windowL') return model.windows.find((w) => w.id === 'fwd-left')?.centre ?? null;
  if (name === 'sideL') return model.windows.find((w) => w.id === 'side-left')?.centre ?? null;
  return null;
}

boot().catch((err: unknown) => {
  window.__test?.errors.push(err instanceof Error ? err.message : String(err));
  window.__lab?.testApi.markReady(false);
  console.error(err);
});
