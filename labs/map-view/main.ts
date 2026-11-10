/**
 * Map view lab: runs src/map alone against the FakeSim (scenes lowOrbit, translunar, lunarOrbit, ...) or
 * the synthetic multi-patch snapshot (?scene=synthetic, &perf=1 for the 8-patch load case), over a
 * lab-only backdrop of shaded spheres, with a simple orbit camera (exponential zoom) and its own
 * PointerState from DOM events. Frame order follows ARCHITECTURE section 5: map.update with the snapshot
 * and camera on screen, then camera and sim, then prepare + drawOverlay for the new frame.
 *
 * Query: ?scene=<FakeScene|synthetic> &paused=1 &intercept=1 &perf=1 &yaw=&pitch=&dist= (radians, metres)
 *        &quiet=1 (no lab text) &spin=<rad per frame> (camera orbits continuously: full rebuild every frame)
 * window.__mapLab: stats(), perf(), resetPerf(), setIntercept(on), setFocus(f), step(dt), results(), view.
 */
import type { PlayerCommands } from '@/core/contracts/controls';
import type { FrameContext, RenderContext, ShaderLibrary } from '@/core/contracts/render';
import type { Sim, SimSnapshot } from '@/core/contracts/sim';
import type { MapUpdateResult } from '@/core/contracts/ui';
import { fetchDefSource } from '@/core/defs/fetchSource';
import { loadDefs } from '@/core/defs/loader';
import { createFakeSim, type FakeScene } from '@/core/fakes/fakeSim';
import { acquireGpu } from '@/core/gpu/device';
import { v3, type Vec3 } from '@/core/math/vec3';
import { installTestApi } from '@/core/testing/testApi';
import { createMapView } from '@/map';
import { orbitCamera } from '@/map/testing/camera';
import { createSyntheticFixture } from '@/map/testing/syntheticSnapshots';
import { Backdrop } from './backdrop';
import { PassTimer } from './gpuTimer';
import { LabPointer } from './pointerInput';

const params = new URLSearchParams(location.search);
const sceneName = params.get('scene') ?? 'lowOrbit';
const testApi = installTestApi({ kind: 'lab', name: 'map-view', scenarioId: sceneName === 'synthetic' ? 'synthetic' : `fake-${sceneName}` });

interface LabSim {
  snapshot(): SimSnapshot;
  advance(dt: number): void;
  commands: PlayerCommands;
}

/** The synthetic snapshot is static (there is no predictor behind it): node edits are refused, targeting works. */
function staticSim(snapshot: SimSnapshot): LabSim {
  const refuse = { ok: false, reason: 'The synthetic scene is static (no trajectory predictor)' };
  let snap = snapshot;
  const commands: PlayerCommands = {
    stage: () => refuse,
    abort: () => refuse,
    setSasEnabled: () => refuse,
    setSasMode: () => refuse,
    setRcsEnabled: () => refuse,
    toggleLegs: () => refuse,
    toggleLights: () => refuse,
    setFineControl: () => refuse,
    setNavballMode: () => refuse,
    setWarpLevel: () => refuse,
    addNode: () => '',
    setNode: () => refuse,
    removeNode: () => refuse,
    setTarget: (bodyId) => {
      snap = { ...snap, readouts: { ...snap.readouts, targetBodyId: bodyId } };
      return { ok: true };
    },
    cycleActiveVessel: () => refuse,
  };
  return { snapshot: () => snap, advance: () => undefined, commands };
}

const percentiles = (xs: number[]): { p50: number; p95: number; p99: number; max: number; count: number } => {
  const s = [...xs].sort((a, b) => a - b);
  const at = (q: number): number => (s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))]! : NaN);
  return { p50: at(0.5), p95: at(0.95), p99: at(0.99), max: s.length ? s[s.length - 1]! : NaN, count: s.length };
};

async function boot(): Promise<void> {
  const canvas = document.getElementById('viewport') as HTMLCanvasElement;
  const info = document.getElementById('info') as HTMLDivElement;
  const interceptBox = document.getElementById('intercept') as HTMLInputElement;
  const gpu = await acquireGpu({ onError: testApi.reportError });
  testApi.setAdapter(gpu.report);
  const context = canvas.getContext('webgpu')!;
  context.configure({ device: gpu.device, format: gpu.canvasFormat, alphaMode: 'opaque' });
  const resize = (): void => {
    const w = Math.max(1, Math.round(canvas.clientWidth * devicePixelRatio));
    const h = Math.max(1, Math.round(canvas.clientHeight * devicePixelRatio));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
  };
  resize();

  const defs = await loadDefs(fetchDefSource());
  const perfScene = params.get('perf') === '1';
  let sim: LabSim;
  if (sceneName === 'synthetic') {
    sim = staticSim(createSyntheticFixture(defs, { correctionNodes: perfScene ? 3 : 0 }).snapshot);
  } else {
    const fake: Sim = createFakeSim(defs, { scene: sceneName as FakeScene });
    sim = { snapshot: () => fake.snapshot(), advance: (dt) => fake.advance(dt), commands: fake.commands };
  }

  // Shader library for the feature: compile errors go to window.__test.errors.
  const shaders: ShaderLibrary = {
    register: () => undefined,
    createModule(label, code) {
      const module = gpu.device.createShaderModule({ label, code });
      void module.getCompilationInfo().then((ci) => {
        for (const m of ci.messages) if (m.type === 'error') testApi.reportError(`shader ${label}:${m.lineNum}:${m.linePos} ${m.message}`);
      });
      return module;
    },
  };
  const { view, feature } = createMapView(gpu, defs);
  // The part of RenderContext the map feature reads.
  const renderContext: Pick<RenderContext, 'device' | 'canvasFormat' | 'defs' | 'shaders'> = { device: gpu.device, canvasFormat: gpu.canvasFormat, defs, shaders };
  await feature.init(renderContext as RenderContext);
  view.setActive(true);
  if (params.get('intercept') === '1') view.setDrawAtIntercept(true);
  interceptBox.checked = view.drawAtIntercept;
  interceptBox.addEventListener('change', () => view.setDrawAtIntercept(interceptBox.checked));

  const backdrop = new Backdrop(gpu.device, gpu.canvasFormat, defs);
  const timer = gpu.hasFeature('timestamp-query') ? new PassTimer(gpu.device) : null;
  const pointer = new LabPointer(canvas);

  // ---- orbit camera
  let snapshot = sim.snapshot();
  const active0 = snapshot.vessels.find((v) => v.id === snapshot.activeVesselId)!;
  const focusBody0 = sceneName === 'lunarOrbit' || sceneName === 'lunarSurface' ? active0.bodyId : defs.rootBodyId;
  // Default view: above the orbit plane, leaning toward the vessel (or toward the Moon's orbit plane).
  const moon = snapshot.bodies.find((b) => b.orbit !== null);
  const orbitW = snapshot.patches.current[0]?.conic.W;
  const viewDir: Vec3 =
    (sceneName === 'lowOrbit' || sceneName === 'lunarOrbit') && orbitW
      ? v3.normalize(v3.add(v3.scale(orbitW, 0.8), v3.scale(v3.normalize(active0.r), 0.6)))
      : v3.normalize(v3.add(moon?.orbit?.W ?? { x: 0, y: 0, z: 1 }, v3.scale(v3.normalize(active0.rRoot), -0.35)));
  const defaults: Record<string, number> = { lowOrbit: 2.4e7, translunar: 1.25e9, lunarOrbit: 7e6, synthetic: 1.15e9 };
  const cam = {
    focus: { bodyId: focusBody0 as string | undefined, vesselId: undefined as string | undefined },
    yaw: Number(params.get('yaw') ?? Math.atan2(viewDir.y, viewDir.x)),
    pitch: Number(params.get('pitch') ?? Math.asin(Math.max(-1, Math.min(1, viewDir.z)))),
    dist: Number(params.get('dist') ?? defaults[sceneName] ?? 3e7),
  };
  const focusPos = (s: SimSnapshot): { pos: Vec3; minDist: number } => {
    if (cam.focus.vesselId) {
      const v = s.vessels.find((x) => x.id === cam.focus.vesselId);
      if (v) return { pos: v.rRoot, minDist: 1e5 };
    }
    // "<body>@intercept" (or "<body>@intercept#2", ...): a ghost of an encounter body drawn at its intercept.
    const ghost = cam.focus.bodyId?.includes('@intercept') ? view.controller.currentScene?.ghostAnchors.get(cam.focus.bodyId) : undefined;
    if (ghost) return { pos: ghost, minDist: 1e5 };
    const b = s.bodies.find((x) => x.id === cam.focus.bodyId) ?? s.bodies.find((x) => x.id === defs.rootBodyId)!;
    return { pos: b.rRoot, minDist: Math.max(1e5, (defs.bodies[b.id]?.radius ?? 0) * 1.02 + 1e5) };
  };
  const cameraFor = (s: SimSnapshot) => {
    const f = focusPos(s);
    cam.dist = Math.min(2e9, Math.max(f.minDist, cam.dist));
    return orbitCamera(f.pos, cam.yaw, cam.pitch, cam.dist);
  };
  let camera = cameraFor(snapshot);

  const phases = { update: [] as number[], prepare: [] as number[], draw: [] as number[], scene: [] as number[], upload: [] as number[] };
  let paused = params.get('paused') === '1';
  // quiet=1 hides the lab's own text (it changes every frame); spin=<rad/frame> orbits the camera continuously.
  if (params.get('quiet') === '1') {
    info.style.display = 'none';
    (document.getElementById('toggles') as HTMLDivElement).style.display = 'none';
  }
  const spin = Number(params.get('spin') ?? 0);
  const cpu: number[] = [];
  const results: MapUpdateResult[] = [];
  testApi.extend({
    state: () => structuredClone(snapshot),
    commands: sim.commands,
    map: () => view.describe(),
    camera: () => camera,
    setPaused: (p) => {
      paused = p;
    },
    setCameraOrbit: (yaw, pitch, distance) => {
      cam.yaw = yaw;
      cam.pitch = Math.max(-1.5703, Math.min(1.5703, pitch));
      cam.dist = distance;
    },
    isIdle: () => true,
  });
  const lab = {
    view,
    stats: () => view.stats(),
    perf: () => ({
      cpu: percentiles(cpu),
      gpu: timer ? percentiles(timer.samples) : null,
      phases: Object.fromEntries(Object.entries(phases).map(([k, v]) => [k, percentiles(v)])),
    }),
    resetPerf: () => {
      cpu.length = 0;
      for (const a of Object.values(phases)) a.length = 0;
      if (timer) timer.samples.length = 0;
    },
    setIntercept: (on: boolean) => {
      view.setDrawAtIntercept(on);
      interceptBox.checked = on;
    },
    setFocus: (f: { bodyId?: string; vesselId?: string }) => {
      cam.focus = { bodyId: f.bodyId, vesselId: f.vesselId };
    },
    /** Advance the sim by `dt` seconds (with ?paused=1: one deterministic step; the next frame shows it). */
    step: (dt: number) => sim.advance(dt),
    results: () => results.slice(-200),
    camState: () => ({ ...cam }),
  };
  (window as unknown as { __mapLab: typeof lab }).__mapLab = lab;

  let last = performance.now();
  let frameIndex = 0;
  const frame = (now: number): void => {
    const realDt = Math.min(0.1, Math.max(0, (now - last) / 1000));
    last = now;
    resize();
    const p = pointer.sample();
    const css: [number, number] = [canvas.clientWidth, canvas.clientHeight];
    // 1. the map sees the pointer first, against the frame on screen
    const t0 = performance.now();
    const res = view.update(snapshot, camera, sim.commands, p, css);
    const tUpdate = performance.now() - t0;
    results.push(res);
    if (results.length > 400) results.splice(0, results.length - 400);
    // 2. camera input unless the map owns the pointer
    if (!res.consumed && !p.overUi) {
      if (p.buttons & 1 && (p.dx !== 0 || p.dy !== 0)) {
        cam.yaw -= p.dx * 0.005;
        cam.pitch = Math.max(-1.5703, Math.min(1.5703, cam.pitch + p.dy * 0.005));
      }
      if (p.wheel !== 0) cam.dist *= Math.pow(1.18, -p.wheel);
    }
    if (res.focus) {
      cam.focus = { bodyId: res.focus.bodyId, vesselId: res.focus.vesselId };
      if (res.focus.bodyId) cam.dist = Math.max(4 * (defs.bodies[res.focus.bodyId]?.radius ?? 1e6), 1e6);
    }
    cam.yaw += spin;
    // 3. sim and the new frame
    if (!paused) sim.advance(realDt);
    snapshot = sim.snapshot();
    camera = cameraFor(snapshot);
    const frameCtx: Pick<FrameContext, 'frameIndex' | 'snapshot' | 'camera' | 'displaySize' | 'realDt'> = {
      frameIndex: frameIndex++,
      snapshot,
      camera,
      displaySize: [canvas.width, canvas.height],
      realDt,
    };
    const t1 = performance.now();
    feature.prepare!(frameCtx as FrameContext);
    const tPrepare = performance.now() - t1;
    const encoder = gpu.device.createCommandEncoder({ label: 'mapLab.frame' });
    const target = context.getCurrentTexture().createView();
    backdrop.draw(encoder, target, snapshot, camera, canvas.width, canvas.height);
    const ts = timer?.begin();
    const pass = encoder.beginRenderPass({
      label: 'map.overlay',
      colorAttachments: [{ view: target, loadOp: 'load', storeOp: 'store' }],
      ...(ts ? { timestampWrites: ts } : {}),
    });
    const t2 = performance.now();
    feature.drawOverlay!(frameCtx as FrameContext, pass);
    const tDraw = performance.now() - t2;
    pass.end();
    timer?.end(encoder);
    gpu.device.queue.submit([encoder.finish()]);
    timer?.collect();
    cpu.push(tUpdate + tPrepare + tDraw);
    phases.update.push(tUpdate);
    phases.prepare.push(tPrepare);
    phases.draw.push(tDraw);
    const split = view.cpuTimes();
    phases.scene.push(split.sceneMs);
    phases.upload.push(split.uploadMs);
    for (const a of [cpu, ...Object.values(phases)]) if (a.length > 2000) a.splice(0, a.length - 2000);

    const st = view.stats();
    const d = v3.dist(camera.positionRoot, focusPos(snapshot).pos);
    info.textContent =
      `map-view lab  scene ${sceneName}${paused ? ' (paused)' : ''}   camera ${(d / 1e3).toFixed(0)} km from ${cam.focus.vesselId ?? cam.focus.bodyId}\n` +
      `lines ${st.lines.length}  markers ${st.markers}  nodes ${st.nodes}  map cpu ${(tUpdate + tPrepare + tDraw).toFixed(2)} ms   ` +
      `drag empty space: rotate   wheel: zoom   click orbit: add node   double-click: focus`;
    testApi.frameDone();
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  await testApi.api.waitFrames(3);
}

boot().then(
  () => testApi.markReady(true),
  (err: unknown) => {
    testApi.reportError(err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err));
    testApi.markReady(false);
  },
);
