/**
 * The game: every subsystem attached through its contract and driven by one frame loop, exactly as
 * ARCHITECTURE section 5 draws a frame:
 *
 *   input  = inputSystem.sample()
 *   map    = mapView.update(lastSnapshot, lastCamera, sim.commands, input.pointer, cssSize)   (map view only)
 *   ctl    = controller.update(input, lastSnapshot, sim.commands, realDt, { view, pointerCaptured: map.consumed })
 *   cockpit.cyclePage(i) for each 'mfdCycle:i'
 *   sim.setControls(ctl); sim.advance(realDt, onControlTick)          (the test pilot acts in the control ticks)
 *   snapshot = sim.snapshot()
 *   view   = viewManager.update(snapshot, cameraInput(input, map), realDt, input.pressed)   (camera, observers, listener)
 *   hud.update(snapshot, camera, realDt)                               (also renders the navball texture)
 *   audio.update({ snapshot, listener, realDt, warpFactor, paused })
 *   renderer.render(snapshot, camera, observers, realDt)
 *
 * The snapshot is the only thing that flows from the simulation to presentation; ControlInputs and
 * PlayerCommands are the only things that flow back. This file never reaches into a subsystem's internals.
 *
 * Loading (loading.ts shows it): the frame loop starts as soon as every subsystem exists and runs UNDER the
 * loading screen, with the simulation held at the scenario's first instant and the controls ignored, until
 * the view at the start position is final (`viewPending` below is empty): every render feature idle (terrain
 * resident at the levels the camera selects, nothing fading, sky data and probe in place, tables built,
 * textures loaded), no shader module compiling, no terrain load of the simulation outstanding, the exposure at
 * its target (or no longer adapting quickly), for SETTLE_FRAMES consecutive frames. Then the screen fades and
 * the game begins.
 */
import type { ButtonAction, ControlInputs } from '@/core/contracts/controls';
import type { DefLibrary } from '@/core/contracts/defs';
import type { CameraState, ViewMode } from '@/core/contracts/render';
import type { SimSnapshot } from '@/core/contracts/sim';
import type { MapUpdateResult } from '@/core/contracts/ui';
import type { GpuHandle } from '@/core/gpu/device';
import { createAudioEngine, type FableAudioEngine } from '@/audio';
import { createCameraInputMapper, createChaseRig, createCockpitRig, createMapRig, createViewManager, type ViewFrame, type ViewManager } from '@/camera';
import { createFlightController, createInputSystem, DEFAULT_BINDINGS, installUnloadGuard, keyHelpEntries, keyLabel, type FlightController, type InputSystem } from '@/input';
import { coreOf, createRenderer, type CoreRenderer } from '@/render/core';
import { createSim, type SimWorld } from '@/sim';
import { createFetchTileSource, createTerrainProvider, type TerrainAuthority } from '@/terrain';
import { createHud, createMfdPainter, createNavballRenderer, type HudImpl, type NavballRendererImpl } from '@/ui';
import { timedFeature } from './featureTiming';
import { createGameFeatures, type GameFeatures } from './features';
import type { LoadingReport, LoadingScreen, StepProgress } from './loading';
import { createPilotDriver, type PilotDriver } from './pilot';
import type { AppSettings } from './settings';
import { createStatusLine } from './statusLine';
import { createFrameTimings, type FrameTimings } from './timing';

/** Longest frame step handed to the simulation and the presentation, s (ARCHITECTURE 5). */
export const MAX_FRAME_SECONDS = 0.1;
/** Frames between two hand-overs of the HUD's panel boxes to the map view (its labels keep clear of them). */
const OBSTACLE_INTERVAL = 10;
/** The flight HUD's panels: the selectors of its own coverage check (request map-view-5). */
const HUD_OBSTACLE_SELECTOR = '.hud .panel, .hud .later, .hud .tile:not(.compact), .hud .pill, .hud .helpbtn, .hud .more, .hud .housing, .hud .prw, .hud .toast, .hud .ball';

/** Consecutive frames with nothing pending before the loading screen fades (a stable picture, not one lucky frame). */
export const SETTLE_FRAMES = 12;
/** The exposure counts as settled within this many EV of the meter's target... */
const EXPOSURE_SETTLED_EV = 0.25;
/**
 * ...or, further off, once it no longer moves towards it faster than this, EV per second: the eye-like dark
 * adaptation of the renderer (a tenth of a stop per second below EV -3) is the camera's behaviour, not loading,
 * and an exposure that stands still (an override, a floor) must never hold the screen.
 */
const EXPOSURE_MOVING_EV_PER_S = 0.3;
/** Words for the render packages on the loading screen. */
const PACKAGE_LABEL: Record<string, string> = { terrain: 'terrain', vehicle: 'vehicle and site', ocean: 'ocean', sky: 'sky', atmosphere: 'atmosphere and clouds', vfx: 'effects', cockpit: 'cockpit', map: 'map view' };

const NO_MAP: MapUpdateResult = { consumed: false };
const count = (n: number): string => Math.round(n).toLocaleString('en-US');

export interface GameDeps {
  canvas: HTMLCanvasElement;
  uiRoot: HTMLElement;
  gpu: GpuHandle;
  defs: DefLibrary;
  scenarioId: string;
  settings: AppSettings;
  /** The loading screen: createGame reports its steps to it and fades it when the view is final. */
  loading: LoadingScreen;
  /** Error sink (window.__test.errors and the console). */
  reportError: (message: string) => void;
  /** Called once per presented frame after the GPU work is submitted. */
  onFrameDone: () => void;
  /** A frame threw: the loop has stopped; show the message. */
  onFatal: (message: string) => void;
}

export interface Game {
  readonly defs: DefLibrary;
  readonly scenarioId: string;
  readonly sim: SimWorld;
  readonly terrain: TerrainAuthority;
  readonly renderer: CoreRenderer;
  readonly features: GameFeatures;
  readonly views: ViewManager;
  readonly hud: HudImpl;
  readonly navball: NavballRendererImpl;
  readonly input: InputSystem;
  readonly controller: FlightController;
  readonly audio: FableAudioEngine;
  readonly pilot: PilotDriver;
  readonly timings: FrameTimings;
  /** Latest presented snapshot and camera. */
  snapshot(): SimSnapshot;
  camera(): CameraState;
  readonly paused: boolean;
  setPaused(paused: boolean): void;
  /** Fixed 1/60 s frame steps and the renderer's deterministic mode (frozen presentation noise). */
  setDeterministic(on: boolean): void;
  /** The test sink of `window.__test.setControls`: throttle moves the lever, the axes are held like keys. */
  setTestControls(partial: Partial<ControlInputs>): void;
  setView(mode: ViewMode): boolean;
  setCameraOrbit(yaw: number, pitch: number, distance: number): void;
  /** Frames presented since the loop started (the frames under the loading screen included). */
  readonly frames: number;
  /** True until the loading screen has gone: the simulation is held and the controls are ignored. */
  readonly loading: boolean;
  /** Resolves when the view at the start position is final and the loading screen has faded. */
  readonly revealed: Promise<void>;
  loadingReport(): LoadingReport;
  /** Wall time of every render feature's start-up (`init`), ms, by feature id. */
  readonly featureInitMs: Readonly<Record<string, number>>;
  /** Fullscreen + keyboard lock on (needs a user gesture) / off: what a click on the HUD's capture switch does. */
  toggleKeyboardCapture(): void;
  /** True while the stage stack has been touched and the mission is neither failed nor over (beforeunload guard). */
  inFlight(): boolean;
  stop(): void;
}

export async function createGame(deps: GameDeps): Promise<Game> {
  const { canvas, uiRoot, gpu, defs, scenarioId, settings, reportError, loading } = deps;

  // ------------------------------------------------------------------------- simulation and height authority
  loading.begin('sim', { detail: 'height authority, vehicle, scenario' });
  const terrain = await createTerrainProvider(defs, createFetchTileSource('/tiles'));
  const sim = createSim(defs, scenarioId, { terrain });
  loading.update('sim', { detail: 'ground under the vehicle for the physics' });
  const simReady = sim.ready.then(() => loading.finish('sim', { detail: 'ready' }));

  // --------------------------------------------------------------------------------------------- renderer
  loading.begin('pipelines', { detail: 'render core' });
  const renderer = await createRenderer(canvas, gpu, defs, {
    onError: reportError,
    perfFeatures: settings.perfFeatures,
    quality: settings.renderScale !== null ? { renderScaleMin: settings.renderScale, renderScaleMax: settings.renderScale } : {},
    governor: settings.governorOff ? { qualityMin: 1 } : {},
  });
  const ctx = renderer.context;
  const core = coreOf(ctx);
  const fit = (): void => {
    const dpr = window.devicePixelRatio || 1;
    const max = gpu.device.limits.maxTextureDimension2D;
    renderer.resize(Math.max(1, Math.min(max, Math.round(canvas.clientWidth * dpr))), Math.max(1, Math.min(max, Math.round(canvas.clientHeight * dpr))));
  };
  fit();
  const resizeObserver = new ResizeObserver(fit);
  resizeObserver.observe(canvas);

  // The navball texture: the HUD renders it every update; the cockpit's instrument shows the same texture.
  const navball = createNavballRenderer(gpu, { perf: ctx.perf });
  ctx.resources.publish('ui.navball', navball.view);
  const mfdPainter = createMfdPainter();

  // ------------------------------------------------------------------------------------- input and HUD
  // Windowed and uncaptured unless asked for (`?capture=1`): every binding works without the keyboard lock (they
  // avoid Ctrl / Alt / Meta); the HUD's capture switch turns fullscreen + lock on and off (request flight-ui-7).
  const input = createInputSystem(canvas, { captureKeyboard: settings.captureKeyboard });
  const toggleKeyboardCapture = (): void => {
    if (input.fullscreen) input.releaseKeyboardCapture();
    else void input.requestKeyboardCapture();
  };
  const keyFor = (action: ButtonAction): string | null => {
    const b = DEFAULT_BINDINGS.find((x) => x.kind === 'button' && x.action === action && !x.requiresKeyboardLock);
    return b ? keyLabel(b.code) : null;
  };
  const startKind = sim.scenario.start.kind;
  const hud = createHud({
    defs,
    gpu,
    navball,
    dispatch: (a) => input.trigger(a),
    requestKeyboardCapture: () => void input.requestKeyboardCapture(),
    releaseKeyboardCapture: () => input.releaseKeyboardCapture(),
    // Clean footage: `?capturepill=0`.
    showCaptureControl: settings.capturePill,
    keyHelp: keyHelpEntries(input.bindings),
    keyFor,
    commands: () => sim.commands,
    // A failed mission: start the scenario again from its beginning (a fresh simulation; nothing is edited).
    failureActions: [{ label: startKind === 'pad' ? 'Revert to launch' : 'Restart scenario', title: 'Start this scenario again from its beginning', run: () => location.reload() }],
  });
  hud.mount(uiRoot);
  hud.setVisible(settings.hud);
  hud.setKeyboardLocked(input.keyboardLocked, input.fullscreen);
  const unsubscribeLock = input.onKeyboardLockChange((locked, fullscreen) => hud.setKeyboardLocked(locked, fullscreen));
  const controller = createFlightController({ notify: (m) => hud.notify(m) });
  const status = createStatusLine(uiRoot, { pilotLabel: settings.pilotLabel });

  // ------------------------------------------------------------------------------------ cameras and views
  const views = createViewManager([createChaseRig({ defs, terrain }), createCockpitRig({ defs }), createMapRig({ defs })], { defs, terrain, initialMode: settings.view });
  const mapper = createCameraInputMapper();

  // ------------------------------------------------------------------------------------- render features
  const features = createGameFeatures({ ctx, gpu, defs, terrain, navball, mfdPainter, uiRoot });

  // ------------------------------------------------------------------------------------------------ audio
  const audio = createAudioEngine({ onError: reportError });
  if (settings.mute) audio.setMasterVolume(0);
  // Every real gesture resumes the context (cheap while it runs; it is also when a lost device comes back).
  const resumeAudio = (): void => void audio.resume();
  window.addEventListener('keydown', resumeAudio, true);
  window.addEventListener('pointerdown', resumeAudio, true);

  // Features initialise (shader compiles, data loads) while the sound assets decode and the pad terrain loads.
  // Each one is registered behind a timer of its hooks (featureTiming.ts): the per-feature main-thread numbers.
  const timings = createFrameTimings();
  const steps = 1 + features.list.length;
  /** How long each feature's start-up took, ms (the loading timeline of the hand-off). */
  const featureInitMs: Record<string, number> = {};
  const featureInit = (async () => {
    let done = 1;
    for (const f of features.list) {
      loading.update('pipelines', { detail: PACKAGE_LABEL[features.packageOf[f.id] ?? ''] ?? f.id, done, total: steps });
      const t0 = performance.now();
      await renderer.addFeature(timedFeature(f, timings.hook));
      featureInitMs[f.id] = performance.now() - t0;
      done++;
    }
    loading.update('pipelines', { detail: 'shader modules compiling', done, total: steps });
  })();
  loading.begin('audio');
  loading.watch('audio', () => {
    const p = audio.probe();
    return { detail: 'sound assets decoded', done: p.assetsLoaded, total: p.assetsTotal };
  });
  const audioInit = audio.init(defs, '/assets/audio').then(() => loading.finish('audio'));
  await Promise.all([featureInit, audioInit, simReady]);

  // ------------------------------------------------------------------------------------------ frame state
  const pilot = createPilotDriver(defs, sim);
  let snapshot = sim.snapshot();
  let view: ViewFrame = views.update(snapshot, { yaw: 0, pitch: 0, zoom: 1 }, 0);
  let paused = false;
  let deterministic = false;
  let frames = 0;
  let running = true;
  let last = performance.now();
  /** Axes held through the test API (like held keys); undefined = the keyboard's value. */
  const testAxes: Partial<Pick<ControlInputs, 'pitch' | 'yaw' | 'roll' | 'translate'>> = {};

  const inFlight = (): boolean => !snapshot.mission.failed && (snapshot.scenario.startKind !== 'pad' || snapshot.staging.nextStage > 0);
  const removeGuard = installUnloadGuard(inFlight);

  // The status line shows PAUSED for as long as it lasts (a toast would fade while the game stays paused).
  const setPaused = (p: boolean): void => {
    paused = p;
  };

  // ------------------------------------------------------------------------------- loading: what is pending
  let settled = 0;
  let lastUploaded = -1;
  let lastStalled = 0;
  let lastEv100 = Number.NaN;
  /** Terrain numbers of the latest frame under the loading screen. */
  const ground = { resident: 0, queued: 0, baking: 0, uploading: 0, poolFull: false, deepestLevel: 0, levelUnderVehicle: null as number | null };
  let pending: string[] = [];

  const readGround = (): void => {
    const t = features.terrain.debug.stats();
    const st = t.stream;
    const active = snapshot.vessels.find((v) => v.id === snapshot.activeVesselId);
    const body = active ? t.bodies[active.bodyId] : undefined;
    const fading = Object.values(t.bodies).some((b) => b.fading > 0);
    // The tile pool is full and nothing can be evicted: every tile that waits for a layer was refused one in this
    // frame and nothing was uploaded. Those tiles stay drawn by their parents for as long as the camera stays
    // (request app-integration-7); the view is as final as it gets.
    ground.poolFull = st.queued === 0 && st.loading === 0 && st.uploading > 0 && !fading && st.uploadedTotal === lastUploaded && st.stalledTotal - lastStalled >= st.uploading;
    lastUploaded = st.uploadedTotal;
    lastStalled = st.stalledTotal;
    ground.resident = st.ready;
    ground.queued = st.queued;
    ground.baking = st.loading;
    ground.uploading = st.uploading;
    ground.deepestLevel = body?.deepestLevel ?? 0;
    const r = snapshot.readouts;
    ground.levelUnderVehicle = active ? (features.terrain.debug.readyTileAt(active.bodyId, (r.latitude * 180) / Math.PI, (r.longitude * 180) / Math.PI)?.level ?? null) : null;
  };

  const groundProgress = (): StepProgress => {
    const waiting = ground.queued + ground.baking + ground.uploading;
    // The level of the deepest resident tile under the vehicle (on the ground) or in the view (in flight).
    const level = ground.levelUnderVehicle !== null ? `level ${ground.levelUnderVehicle} under the vehicle` : `level ${ground.deepestLevel} in view`;
    if (ground.poolFull) return { detail: `${level} · tile pool full, ${count(ground.uploading)} left to coarser tiles`, done: ground.resident, total: ground.resident };
    const parts = [ground.queued > 0 ? `${count(ground.queued)} queued` : '', ground.baking > 0 ? `${count(ground.baking)} baking` : '', ground.uploading > 0 ? `${count(ground.uploading)} uploading` : ''].filter((x) => x !== '');
    return { detail: `${level}${parts.length > 0 ? ` · ${parts.join(', ')}` : ' · tiles resident'}`, done: ground.resident, total: ground.resident + waiting };
  };

  const skyProgress = (): StepProgress => {
    const st = features.sky.status();
    const probe = features.sky.probe().completed >= 1;
    const parts = [st.starsLoaded, st.milkyWayLoaded, probe];
    const words = ['star catalogue', st.milkyWayLoaded ? `Milky Way cube (${st.milkyWayFaceSize} px faces)` : 'Milky Way cube', 'light probe'];
    const next = parts.findIndex((x) => !x);
    return { detail: next < 0 ? words.join(', ') : words[next]!, done: parts.filter(Boolean).length, total: parts.length };
  };

  loading.watch('sky', skyProgress);
  loading.watch('terrain', groundProgress);

  /**
   * One frame under the loading screen (after it was rendered): update the steps from the subsystems and
   * return the names of what is still pending for the view to be final.
   */
  const viewPending = (realDt: number): string[] => {
    readGround();
    const compiling = core.shaders.pendingCompilations();
    const idle = (f: { isIdle?(): boolean }): boolean => f.isIdle === undefined || f.isIdle();
    const out: string[] = [];

    if (compiling === 0) loading.finish('pipelines', { detail: `render core and ${steps - 1} features` });
    else loading.update('pipelines', { detail: `${count(compiling)} shader modules compiling` });
    if (compiling > 0) out.push('shaders');

    loading.begin('sky');
    if (idle(features.sky)) loading.finish('sky');
    else out.push('sky');

    loading.begin('atmosphere', { detail: 'scattering tables, cloud maps' });
    if (idle(features.atmosphere) && idle(features.ocean)) loading.finish('atmosphere', { detail: 'ready' });
    else out.push('atmosphere');

    loading.begin('models', { detail: 'meshes and textures' });
    if (core.meshes.isIdle() && idle(features.vessels) && idle(features.site) && idle(features.cockpit)) loading.finish('models', { detail: 'ready' });
    else out.push('models');

    loading.begin('terrain');
    if (idle(features.terrain) || ground.poolFull) loading.finish('terrain');
    else out.push('terrain');
    if (sim.terrainPending() !== null) out.push('simulation terrain');

    // Anything a step above does not name (effects, map) and anything that became busy again after its step.
    for (const f of features.list) {
      if (idle(f) || (f === features.terrain && ground.poolFull)) continue;
      const name = PACKAGE_LABEL[features.packageOf[f.id] ?? ''] ?? f.id;
      if (!out.some((x) => name.startsWith(x) || (x === 'models' && (name === 'vehicle and site' || name === 'cockpit')))) out.push(name);
    }
    const e = renderer.exposureInfo();
    const evRate = realDt > 0 && !Number.isNaN(lastEv100) ? Math.abs(e.ev100 - lastEv100) / realDt : Number.POSITIVE_INFINITY;
    lastEv100 = e.ev100;
    if (e.override === null && Math.abs(e.ev100 - e.targetEv100) > EXPOSURE_SETTLED_EV && evRate > EXPOSURE_MOVING_EV_PER_S) out.push('exposure');
    return out;
  };

  const whileLoading = (realDt: number): void => {
    pending = viewPending(realDt);
    settled = pending.length === 0 ? settled + 1 : 0;
    if (pending.length === 0 || loading.state('view') !== 'waiting') {
      loading.begin('view');
      loading.update('view', { detail: pending.length === 0 ? 'consecutive frames with nothing pending' : `waiting for ${pending.join(', ')}`, done: Math.min(settled, SETTLE_FRAMES), total: SETTLE_FRAMES });
    }
    loading.refresh();
    if (settled < SETTLE_FRAMES) return;
    const e = renderer.exposureInfo();
    loading.finish('view', { detail: 'the view is final' });
    loading.reveal({
      frame: frames,
      busy: features.list.filter((f) => f.isIdle !== undefined && !f.isIdle()).map((f) => f.id),
      terrain: { ...ground },
      ev100: e.ev100,
      targetEv100: e.targetEv100,
      settledFrames: settled,
    });
  };

  const hudObstacles = (): { x: number; y: number; width: number; height: number }[] => {
    const out: { x: number; y: number; width: number; height: number }[] = [];
    const origin = canvas.getBoundingClientRect();
    for (const e of hud.root.querySelectorAll(HUD_OBSTACLE_SELECTOR)) {
      if (e.getClientRects().length === 0 || getComputedStyle(e).visibility === 'hidden') continue;
      const r = e.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) out.push({ x: r.left - origin.left, y: r.top - origin.top, width: r.width, height: r.height });
    }
    return out;
  };

  const frame = (now: number): void => {
    const realDt = deterministic ? 1 / 60 : Math.min(MAX_FRAME_SECONDS, Math.max(0, (now - last) / 1000));
    last = now;
    // The whole frame function is the CPU line of ARCHITECTURE 17 (window.__perf.cpu, request app-integration-1).
    ctx.perf.cpuBegin('frame');
    timings.begin();

    // Input, then the map view sees the pointer against the frame that is on screen.
    // Under the loading screen the keys do nothing (a Space pressed while waiting must not fire a stage).
    const held = loading.active;
    const sampled = input.sample();
    const f = held ? { ...sampled, pressed: new Set<ButtonAction>(), ui: new Set<never>() } : sampled;
    if (f.ui.has('ui:keyHelp')) hud.toggleKeyHelp();
    if (f.pressed.has('toggleHud')) hud.setVisible(!hud.visible);
    if (f.pressed.has('pause')) setPaused(!paused);
    timings.mark('input');
    const mapActive = view.camera.kind === 'map';
    features.map.setActive(mapActive);
    const map = mapActive ? features.map.update(snapshot, view.camera, sim.commands, f.pointer, [canvas.clientWidth, canvas.clientHeight]) : NO_MAP;
    if (mapActive && frames % OBSTACLE_INTERVAL === 0) features.map.setObstacles(hudObstacles());
    timings.mark('map');

    // Controls: the keyboard (and the test API's held axes) unless the test pilot flies; nothing while paused.
    if (!paused && !held && !pilot.engaged) {
      const ctl = controller.update(f, snapshot, sim.commands, realDt, { view: view.camera.kind, pointerCaptured: map.consumed });
      sim.setControls({
        ...ctl,
        pitch: testAxes.pitch ?? ctl.pitch,
        yaw: testAxes.yaw ?? ctl.yaw,
        roll: testAxes.roll ?? ctl.roll,
        translate: testAxes.translate ?? ctl.translate,
      });
    }
    for (const a of f.pressed) if (a.startsWith('mfdCycle:')) features.cockpitControls.cyclePage(Number(a.slice('mfdCycle:'.length)));
    timings.mark('controls');

    if (!paused && !held) sim.advance(realDt, pilot.onControlTick);
    snapshot = sim.snapshot();
    if (pilot.afterFrame().finished) {
      // Back to the keyboard: the lever starts where the pilot left the throttle.
      controller.setThrottle(snapshot.appliedControls.throttle);
      const p = pilot.pilot;
      hud.notify(p?.failure ? `Test pilot gave up: ${p.failure}` : 'Test pilot finished');
    }
    timings.mark('sim');

    view = views.update(snapshot, mapper.map(f, realDt, { pointerConsumed: map.consumed, ...(map.focus ? { focus: map.focus } : {}) }), realDt, f.pressed);
    timings.mark('views');
    hud.update(snapshot, view.camera, realDt);
    status.update({ paused, pilotPhase: pilot.engaged ? (pilot.pilot?.phase ?? null) : null, hudVisible: hud.visible });
    timings.mark('hud');
    audio.update({ snapshot, listener: view.listener, realDt, warpFactor: snapshot.warp.factor, paused: paused || held });
    timings.mark('audio');
    renderer.render(snapshot, view.camera, view.observers, realDt);
    timings.mark('render');
    timings.end(frames, frameNote);
    ctx.perf.cpuEnd('frame');
    if (held) {
      if (loading.fading) loading.frame(now);
      else whileLoading(realDt);
      // The game begins with the first frame after the screen has gone.
      if (!loading.active && settings.pilot) pilot.start();
    }
    frames++;
    deps.onFrameDone();
  };

  /** What the timings keep with a slow or traced frame. */
  const frameNote = (): string => {
    const r = snapshot.readouts;
    return `${view.camera.kind} thr ${snapshot.appliedControls.throttle.toFixed(2)} thrust ${(r.thrust / 1000).toFixed(0)} kN warp ${snapshot.warp.factor} alt ${(r.altitudeAsl / 1000).toFixed(1)} km vessels ${snapshot.vessels.length}`;
  };

  const loop = (now: number): void => {
    if (!running) return;
    try {
      frame(now);
    } catch (e) {
      running = false;
      const message = `frame: ${e instanceof Error ? e.message : String(e)}`;
      reportError(message);
      deps.onFatal(message);
      return;
    }
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);

  return {
    defs,
    scenarioId,
    sim,
    terrain,
    renderer,
    features,
    views,
    hud,
    navball,
    input,
    controller,
    audio,
    pilot,
    timings,
    snapshot: () => snapshot,
    camera: () => view.camera,
    get paused() {
      return paused;
    },
    setPaused,
    setDeterministic(on) {
      deterministic = on;
      renderer.setDeterministic(on);
    },
    setTestControls(partial) {
      if (partial.throttle !== undefined) controller.setThrottle(Math.min(1, Math.max(0, partial.throttle)));
      if (partial.pitch !== undefined) testAxes.pitch = partial.pitch;
      if (partial.yaw !== undefined) testAxes.yaw = partial.yaw;
      if (partial.roll !== undefined) testAxes.roll = partial.roll;
      if (partial.translate !== undefined) testAxes.translate = { ...partial.translate };
    },
    setView: (mode) => views.setMode(mode, snapshot),
    setCameraOrbit(yaw, pitch, distance) {
      const rig = views.rig(views.mode) as { setOrbit?: (az: number, el: number, d: number) => void } | undefined;
      rig?.setOrbit?.(yaw, pitch, distance);
    },
    get frames() {
      return frames;
    },
    get loading() {
      return loading.active;
    },
    revealed: loading.revealed,
    loadingReport: () => loading.report(),
    featureInitMs,
    toggleKeyboardCapture,
    inFlight,
    stop() {
      running = false;
      removeGuard();
      unsubscribeLock();
      resizeObserver.disconnect();
      window.removeEventListener('keydown', resumeAudio, true);
      window.removeEventListener('pointerdown', resumeAudio, true);
      input.dispose();
      hud.dispose();
      audio.dispose();
      renderer.dispose();
    },
  };
}
