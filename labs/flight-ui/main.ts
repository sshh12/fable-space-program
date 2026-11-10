/**
 * flight-ui lab: the full HUD, navball, input system, flight controller and view manager running against the
 * FakeSim, with the cameras shown against a simple ray-traced backdrop (backdrop.ts).
 *
 * Query parameters:
 *   scene=<FakeScene>          default lowOrbit
 *   view=chase|cockpit|map     initial view (default chase)
 *   capture=1                  request fullscreen + keyboard lock on the first gesture (the app default)
 *   extraRig=1                 register an extra rig of unknown mode 'lab-orbit-cam' (kind external)
 *   node=1                     plan a 120 m/s prograde maneuver node 10 minutes ahead (orbit scenes)
 *   target=<bodyId>            set a target body at start
 *   predicted=impact|entry     lab decoration: a predicted arrival point in the landing-target readout
 *   failed=1, terrainPending=1 lab decorations: mission-failed banner, terrain-loading notice
 *   mfd=1                      show the six MFD pages instead of the flight view
 *   help=1                     open the key-help overlay
 *   orbit=<yawDeg>,<pitchDeg>,<distance>   initial chase / map orbit
 */
import type { ButtonAction, ControlInputs } from '@/core/contracts/controls';
import type { CameraRig, CameraState } from '@/core/contracts/render';
import type { SimSnapshot } from '@/core/contracts/sim';
import type { TerrainProvider } from '@/core/contracts/terrain';
import type { MfdPage } from '@/core/contracts/ui';
import { fetchDefSource } from '@/core/defs/fetchSource';
import { loadDefs } from '@/core/defs/loader';
import { createFakeSim, type FakeScene } from '@/core/fakes/fakeSim';
import { acquireGpu } from '@/core/gpu/device';
import { quat, type Quat } from '@/core/math/quat';
import { DEG } from '@/core/math/scalar';
import { v3, type Vec3 } from '@/core/math/vec3';
import { installTestApi } from '@/core/testing/testApi';
import { createCameraInputMapper, createChaseRig, createCockpitRig, createMapRig, createViewManager, vesselComRoot, type ViewFrame } from '@/camera';
import { createFlightController, createInputSystem, DEFAULT_BINDINGS, keyHelpEntries, keyLabel } from '@/input';
import { buildMfdPage, createHud, createMfdPainter, createNavballRenderer, MFD_PAGES, projectMarker, type NavballRendererImpl } from '@/ui';
import { createLabBackdrop, LAB_GROUND } from './backdrop';
import { createGpuTimer } from './gpuTimer';
import { labCylinders, labVehicleParts, tagLabVehicle, withLabVehicle, type LabGroup } from './labVehicle';

const params = new URLSearchParams(location.search);
const scene = (params.get('scene') ?? 'lowOrbit') as FakeScene;
const testApi = installTestApi({ kind: 'lab', name: 'flight-ui', scenarioId: `fake-${scene}` });

const STAGES = ['Launch', 'M-1 separation', 'Tower + fairing jettison', 'M-2 separation', 'M-3 separation', 'Landing gear', 'Lunar lift-off', 'Capsule separation', 'Drogues', 'Mains'];

interface SceneSetup {
  groups: LabGroup[];
  fill: Partial<Record<LabGroup, number>>;
  fired: number;
}
const SETUP: Record<FakeScene, SceneSetup> = {
  pad: { groups: ['booster', 'upper', 'lander', 'capsule'], fill: {}, fired: 0 },
  ascent: { groups: ['booster', 'upper', 'lander', 'capsule'], fill: { booster: 0.62 }, fired: 1 },
  lowOrbit: { groups: ['upper', 'lander', 'capsule'], fill: { upper: 0.34 }, fired: 4 },
  translunar: { groups: ['lander', 'capsule'], fill: { lander: 0.97 }, fired: 5 },
  lunarOrbit: { groups: ['lander', 'capsule'], fill: { lander: 0.81 }, fired: 5 },
  lunarSurface: { groups: ['lander', 'capsule'], fill: { lander: 0.22 }, fired: 6 },
  reentry: { groups: ['capsule'], fill: { capsule: 0.8 }, fired: 8 },
  chutes: { groups: ['capsule'], fill: { capsule: 0.55 }, fired: 9 },
};

/** Debug surface of this lab for its Playwright specs. */
interface FlightUiLabApi {
  keyboardLocked(): boolean;
  heldCodes(): string[];
  /** Cumulative log of every ButtonAction / UI action seen in an InputFrame. */
  actions(): string[];
  /** Number of frames whose PointerState had each edge set. */
  pointerEdges(): { pressed: number; released: number; doubleClick: number; wheelFrames: number };
  /** Per-frame samples (performance.now ms, lever throttle as applied, pitch). */
  frames(): { t: number; throttle: number; pitch: number }[];
  /** Pixel position of a navball marker on the 512 x 512 texture (CPU projection of the current snapshot). */
  marker(name: string): { px: number; py: number; visible: boolean } | null;
  hudLandingRows(): [string, string][] | null;
  mfdRows(page: MfdPage): { label: string; value: string }[];
  mfdSection(page: MfdPage): { heading: string; rows: { label: string; value: string }[] } | null;
  notifications(): string[];
  hudTiming(): { last: number; mean: number };
  gpuTimes(): Record<string, number[]>;
  resetTimes(): void;
  setPointerCaptured(on: boolean): void;
  mode(): string;
  /** Render a navball for a pitch / heading / roll attitude and read pixels / horizon rows back. */
  navballProbe(att: { pitchDeg: number; headingDeg: number; rollDeg: number }, points: [number, number][], columns: number[]): Promise<{ pixels: number[][]; horizonRows: (number | null)[] }>;
}

declare global {
  interface Window {
    __flightUi?: FlightUiLabApi;
  }
}

/** Vessel attitude from navball angles (heading clockwise from north, roll right positive), as VES -> horizon. */
function attitudeToQuat(pitchDeg: number, headingDeg: number, rollDeg: number): Quat {
  const p = pitchDeg * DEG;
  const h = headingDeg * DEG;
  const nose: Vec3 = { x: Math.cos(p) * Math.sin(h), y: Math.cos(p) * Math.cos(h), z: Math.sin(p) };
  const up = v3.unitZ();
  let dorsal = v3.reject(up, nose);
  dorsal = v3.len(dorsal) < 1e-6 ? v3.neg({ x: Math.sin(h), y: Math.cos(h), z: 0 }) : v3.normalize(dorsal);
  dorsal = quat.rotate(quat.fromAxisAngle(nose, rollDeg * DEG), dorsal);
  return quat.fromBasis(v3.cross(nose, dorsal), nose, dorsal);
}

async function boot(): Promise<void> {
  const canvas = document.getElementById('viewport') as HTMLCanvasElement;
  const uiRoot = document.getElementById('ui-root') as HTMLDivElement;
  const gpu = await acquireGpu({ onError: testApi.reportError });
  testApi.setAdapter(gpu.report);
  const context = canvas.getContext('webgpu')!;
  context.configure({ device: gpu.device, format: gpu.canvasFormat, alphaMode: 'opaque' });
  const resize = (): void => {
    canvas.width = Math.max(1, Math.round(canvas.clientWidth * devicePixelRatio));
    canvas.height = Math.max(1, Math.round(canvas.clientHeight * devicePixelRatio));
  };
  new ResizeObserver(resize).observe(canvas);
  resize();

  const defs = withLabVehicle(await loadDefs(fetchDefSource()));
  const setup = SETUP[scene];
  const parts = labVehicleParts(defs, setup.fill, setup.groups);
  const sim = createFakeSim(defs, { scene, parts, stageLabels: STAGES });
  for (let i = 0; i < setup.fired; i++) sim.commands.stage();
  if (params.get('target')) sim.commands.setTarget(params.get('target'));
  if (params.get('node') === '1') {
    const id = sim.commands.addNode(sim.peek().ut + 600);
    sim.commands.setNode(id, { dv: { prograde: 120, normal: 8, radial: -3 } });
  }
  sim.snapshot();

  const predicted = params.get('predicted');
  const decorate = (raw: SimSnapshot): SimSnapshot => {
    let s = tagLabVehicle(raw);
    if (params.get('failed') === '1') s = { ...s, mission: { failed: true, failureReason: 'Heat shield burned through at 61 km (lab decoration)', crewAlive: false } };
    if (params.get('terrainPending') === '1') s = { ...s, terrain: { ...s.terrain, pending: true, complete: false } };
    const lt = s.readouts.landingTarget;
    if (lt && (predicted === 'impact' || predicted === 'entry')) {
      const target = s.surfaceTargets.find((t) => t.id === lt.targetId)!;
      s = {
        ...s,
        readouts: {
          ...s.readouts,
          landingTarget: { ...lt, predicted: { kind: predicted, ut: s.ut + 1260, latitude: target.latitude + 0.0021, longitude: target.longitude - 0.0034, missDistance: 6840, missBearingDeg: 238.4 } },
        },
      };
    }
    return s;
  };

  const notifySink: { fn: (m: string) => void } = { fn: () => undefined };
  const input = createInputSystem(canvas, { captureKeyboard: params.get('capture') === '1' });
  const controller = createFlightController({ notify: (m) => notifySink.fn(m) });
  const terrain: TerrainProvider = {
    heightAt: (bodyId) => LAB_GROUND[bodyId] ?? 0,
    normalAt: (_b, dir) => dir,
    surfaceKind: () => 'land',
    ensureLoaded: () => Promise.resolve(),
    prewarmCollision: () => 0,
    residency: () => ({ availableLevel: 0, finalLevel: 0, complete: true }) as unknown as ReturnType<TerrainProvider['residency']>,
    elevationRange: (bodyId) => ({ min: LAB_GROUND[bodyId] ?? 0, max: LAB_GROUND[bodyId] ?? 0 }),
  };
  const chase = createChaseRig({ defs, terrain });
  const cockpit = createCockpitRig({ defs });
  const map = createMapRig({ defs });
  const rigs: CameraRig[] = [chase, cockpit, map];
  if (params.get('extraRig') === '1') {
    // A rig known only through the CameraRig contract: unknown mode, kind 'external'.
    rigs.push({
      mode: 'lab-orbit-cam',
      activate: () => undefined,
      update: (s) => {
        const v = s.vessels.find((x) => x.id === s.activeVesselId)!;
        const com = vesselComRoot(v);
        const up = v3.normalize(v.r);
        const side = v3.normalize(v3.cross(up, v3.unitZ()));
        const eye = v3.add(v3.add(com, v3.scale(side, 140)), v3.scale(up, 40));
        const fwd = v3.normalize(v3.sub(com, eye));
        const z = v3.neg(fwd);
        const x = v3.normalize(v3.cross(up, z));
        return { mode: 'lab-orbit-cam', kind: 'external', positionRoot: eye, qViewToRoot: quat.fromBasis(x, v3.cross(z, x), z), fovY: 50 * DEG, insideVesselId: null, focusVesselId: v.id, focusBodyId: v.bodyId, exposureCompensation: 0, minEv100: null, fillLight: 0 };
      },
    });
  }
  const viewManager = createViewManager(rigs, { defs, initialMode: params.get('view') ?? 'chase' });
  const mapper = createCameraInputMapper();
  const timer = createGpuTimer(gpu);
  const navball: NavballRendererImpl = createNavballRenderer(gpu, { perf: timer });
  const keyFor = (action: ButtonAction): string | null => {
    const b = DEFAULT_BINDINGS.find((x) => x.kind === 'button' && x.action === action && !x.requiresKeyboardLock);
    return b ? keyLabel(b.code) : null;
  };
  const hud = createHud({
    defs,
    gpu,
    navball,
    dispatch: (a) => input.trigger(a),
    requestKeyboardCapture: () => void input.requestKeyboardCapture(),
    keyHelp: keyHelpEntries(input.bindings),
    keyFor,
    commands: () => sim.commands,
  });
  hud.mount(uiRoot);
  notifySink.fn = (m) => hud.notify(m);
  hud.setKeyboardLocked(input.keyboardLocked);
  input.onKeyboardLockChange((locked) => hud.setKeyboardLocked(locked));
  if (params.get('help') === '1') hud.toggleKeyHelp(true);
  const backdrop = createLabBackdrop(gpu, defs, () => labCylinders(defs, parts));

  // MFD showcase.
  const mfdEl = document.getElementById('mfd') as HTMLDivElement;
  const painter = createMfdPainter();
  const mfdCanvases = MFD_PAGES.map(() => {
    const c = document.createElement('canvas');
    c.width = 1024;
    c.height = 768;
    mfdEl.append(c);
    return c;
  });
  const mfdOffscreen = new OffscreenCanvas(1024, 768);
  const mfdCtx = mfdOffscreen.getContext('2d')!;
  const showMfd = params.get('mfd') === '1';
  mfdEl.classList.toggle('visible', showMfd);

  let snapshot = decorate(sim.snapshot());
  let view: ViewFrame | null = null;
  let camera: CameraState | null = null;
  let paused = false;
  let pointerCaptured = false;
  const testOverride: Partial<ControlInputs> = {};
  const actionLog: string[] = [];
  const edges = { pressed: 0, released: 0, doubleClick: 0, wheelFrames: 0 };
  const frameLog: { t: number; throttle: number; pitch: number }[] = [];
  const orbitParam = params.get('orbit');
  let orbitApplied = false;
  let probe: NavballRendererImpl | null = null;

  testApi.extend({
    state: () => structuredClone(snapshot),
    commands: sim.commands,
    setControls: (partial) => {
      if (partial.throttle !== undefined) controller.setThrottle(partial.throttle);
      Object.assign(testOverride, partial);
      delete testOverride.throttle;
    },
    setPaused: (p) => {
      paused = p;
    },
    setView: (mode) => {
      viewManager.setMode(mode, snapshot);
    },
    camera: () => (camera ? structuredClone(camera) : null),
    setCameraOrbit: (yaw, pitch, distance) => {
      const rig = viewManager.rig(viewManager.mode) as { setOrbit?: (a: number, e: number, d: number) => void } | undefined;
      rig?.setOrbit?.(yaw, pitch, distance);
    },
  });

  window.__flightUi = {
    keyboardLocked: () => input.keyboardLocked,
    heldCodes: () => input.heldCodes(),
    actions: () => actionLog.slice(),
    pointerEdges: () => ({ ...edges }),
    frames: () => frameLog.slice(),
    marker: (name) => {
      const d = (snapshot.navball.markers as unknown as Record<string, Vec3 | null>)[name];
      if (!d) return null;
      const p = projectMarker(d, 512);
      return { px: p.px, py: p.py, visible: p.visible };
    },
    hudLandingRows: () => hud.landingTargetRows(),
    mfdRows: (page) => buildMfdPage(page, snapshot, defs).rows.map((r) => ({ label: r.label, value: r.value })),
    mfdSection: (page) => {
      const sec = buildMfdPage(page, snapshot, defs).section;
      return sec ? { heading: sec.heading, rows: sec.rows.map((r) => ({ label: r.label, value: r.value })) } : null;
    },
    notifications: () => hud.notifications(),
    hudTiming: () => ({ last: hud.lastUpdateMs, mean: hud.meanUpdateMs }),
    gpuTimes: () => structuredClone(timer.samples()),
    resetTimes: () => timer.reset(),
    setPointerCaptured: (on) => {
      pointerCaptured = on;
    },
    mode: () => viewManager.mode,
    async navballProbe(att, points, columns) {
      probe ??= createNavballRenderer(gpu);
      const q = attitudeToQuat(att.pitchDeg, att.headingDeg, att.rollDeg);
      const none = { prograde: { x: 0, y: -1, z: 0 }, retrograde: { x: 0, y: -1, z: 0 }, normal: { x: 0, y: -1, z: 0 }, antinormal: { x: 0, y: -1, z: 0 }, radialOut: { x: 0, y: -1, z: 0 }, radialIn: { x: 0, y: -1, z: 0 }, maneuver: null, target: null, antiTarget: null, liftVector: null };
      const enc = gpu.device.createCommandEncoder();
      probe.renderState(enc, { mode: 'surface', qVesselToHorizon: q, markers: none, pitchDeg: att.pitchDeg, headingDeg: att.headingDeg, rollDeg: att.rollDeg });
      const buf = gpu.device.createBuffer({ size: 512 * 512 * 4, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
      enc.copyTextureToBuffer({ texture: probe.texture }, { buffer: buf, bytesPerRow: 2048 }, [512, 512]);
      gpu.device.queue.submit([enc.finish()]);
      await buf.mapAsync(GPUMapMode.READ);
      const px = new Uint8Array(buf.getMappedRange().slice(0));
      buf.unmap();
      buf.destroy();
      const at = (x: number, y: number): number[] => {
        const i = (Math.round(y) * 512 + Math.round(x)) * 4;
        return [px[i]!, px[i + 1]!, px[i + 2]!, px[i + 3]!];
      };
      // Horizon row of a column: the centre of the brightest near-white run between sky and ground.
      const horizonRows = columns.map((x) => {
        let best: number | null = null;
        let bestScore = 0;
        for (let y = 8; y < 504; y++) {
          const [r, g, b] = at(x, y);
          const score = Math.min(r!, g!, b!);
          if (score > bestScore && score > 170) {
            bestScore = score;
            best = y;
          }
        }
        return best;
      });
      return { pixels: points.map(([x, y]) => at(x, y)), horizonRows };
    },
  };

  let last = performance.now();
  const frame = (now: number): void => {
    const realDt = Math.min(0.1, Math.max(0, (now - last) / 1000));
    last = now;
    const f = input.sample();
    for (const a of f.pressed) actionLog.push(a);
    for (const a of f.ui) {
      actionLog.push(a);
      if (a === 'ui:keyHelp') hud.toggleKeyHelp();
    }
    if (f.pointer.pressed) edges.pressed++;
    if (f.pointer.released) edges.released++;
    if (f.pointer.doubleClick) edges.doubleClick++;
    if (f.pointer.wheel !== 0) edges.wheelFrames++;
    if (f.pressed.has('toggleHud')) hud.setVisible(!hud.visible);
    if (f.pressed.has('pause')) paused = !paused;

    const ctl = controller.update(f, snapshot, sim.commands, realDt, { view: camera?.kind ?? 'external', pointerCaptured });
    sim.setControls({
      ...ctl,
      pitch: testOverride.pitch ?? ctl.pitch,
      yaw: testOverride.yaw ?? ctl.yaw,
      roll: testOverride.roll ?? ctl.roll,
      translate: testOverride.translate ?? ctl.translate,
    });
    if (!paused) sim.advance(realDt);
    snapshot = decorate(sim.snapshot());

    const camIn = mapper.map(f, realDt, { pointerConsumed: pointerCaptured });
    view = viewManager.update(snapshot, camIn, realDt, f.pressed);
    if (!orbitApplied && orbitParam) {
      const [y, p, d] = orbitParam.split(',').map(Number);
      const rig = viewManager.rig(viewManager.mode) as { setOrbit?: (a: number, e: number, d: number) => void } | undefined;
      rig?.setOrbit?.((y ?? 0) * DEG, (p ?? 0) * DEG, d ?? 100);
      view = viewManager.update(snapshot, { yaw: 0, pitch: 0, zoom: 1 }, 0);
      orbitApplied = true;
    }
    camera = view.camera;
    hud.update(snapshot, camera, realDt);

    const encoder = gpu.device.createCommandEncoder({ label: 'lab.frame' });
    backdrop.render(encoder, context.getCurrentTexture().createView(), snapshot, camera, [canvas.width, canvas.height]);
    gpu.device.queue.submit([encoder.finish()]);
    timer.endFrame();

    if (showMfd) {
      MFD_PAGES.forEach((page, i) => {
        painter.paint(mfdCtx, 1024, 768, page, snapshot, defs);
        mfdCanvases[i]!.getContext('2d')!.drawImage(mfdOffscreen, 0, 0);
      });
    }
    frameLog.push({ t: now, throttle: snapshot.appliedControls.throttle, pitch: snapshot.appliedControls.pitch });
    if (frameLog.length > 1500) frameLog.splice(0, frameLog.length - 1500);
    testApi.frameDone();
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  await testApi.api.waitFrames(3);
}

boot().then(
  () => testApi.markReady(true),
  (err: unknown) => {
    testApi.reportError(err instanceof Error ? err.message : String(err));
    testApi.markReady(false);
  },
);
