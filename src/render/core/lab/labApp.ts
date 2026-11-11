/**
 * createLabApp: boots GPU + defs + FakeSim (or a given Sim) + the render core for a lab page, with a
 * simple camera placeable by query string and by window.__test.setCameraOrbit, any number of features, and
 * the full TestApi wiring (isIdle, perf, hdrStats, setDeterministic, setPaused). Used by every render lab.
 *
 * Query parameters (all optional): scene=<FakeScene>, the camera parameters of labCameraFromQuery,
 * perf=features (attribution mode), scale=<render scale>, governor=off, ev=<forced EV100>, deterministic=1
 * (with noise=cycle: the blue-noise offset keeps cycling), paused=1.
 */
import { NEUTRAL_CONTROLS } from '@/core/contracts/controls';
import type { DefLibrary } from '@/core/contracts/defs';
import type { CameraState, RenderFeature } from '@/core/contracts/render';
import type { Sim, SimSnapshot } from '@/core/contracts/sim';
import { fetchDefSource } from '@/core/defs/fetchSource';
import { loadDefs } from '@/core/defs/loader';
import { createFakeSim, type FakeScene } from '@/core/fakes/fakeSim';
import { acquireGpu, type GpuHandle } from '@/core/gpu/device';
import { v3 } from '@/core/math';
import { installTestApi, type TestApiController } from '@/core/testing/testApi';
import { createRenderer, type CoreRenderer, type RendererOptions } from '../renderer';
import { labCameraFromQuery, type LabCamera, type LabCameraSettings, type LabCameraSpec } from './camera';

export interface LabAppOptions {
  canvas: HTMLCanvasElement;
  /** Lab name reported in window.__test.page (default: the directory name of the page). */
  name?: string;
  /** FakeSim scene (default: ?scene=, else 'lowOrbit'). Ignored when `sim` is given. */
  scene?: FakeScene;
  /** A simulation to drive instead of the FakeSim (or a factory receiving the loaded defs). */
  sim?: Sim | ((defs: DefLibrary) => Sim);
  /** Features to register before the first frame (or a factory called once defs and sim exist). */
  features?: RenderFeature[] | ((defs: DefLibrary, sim: Sim) => RenderFeature[]);
  /** Camera placement (or a factory receiving the first snapshot); default: from the query string. */
  camera?: LabCameraSpec | ((snapshot: SimSnapshot, defs: DefLibrary) => LabCameraSpec);
  cameraSettings?: Partial<LabCameraSettings>;
  renderer?: RendererOptions;
  /** Already-loaded definitions (default: fetched from /defs). */
  defs?: DefLibrary;
  /** Query string to read (default: location.search). */
  query?: URLSearchParams;
  /** Called every frame before rendering (advance lab animation, move the camera). */
  onFrame?: (snapshot: SimSnapshot, realDt: number) => void;
  /**
   * Resolve window.__test.ready when createLabApp returns (default true). Pass false when the page still
   * has set-up to do afterwards, then call `app.testApi.markReady(true)` itself.
   */
  autoReady?: boolean;
}

export interface LabApp {
  readonly renderer: CoreRenderer;
  readonly gpu: GpuHandle;
  readonly defs: DefLibrary;
  readonly sim: Sim;
  readonly camera: LabCamera;
  readonly testApi: TestApiController;
  readonly query: URLSearchParams;
  /** Latest snapshot and camera handed to the renderer. */
  snapshot(): SimSnapshot;
  cameraState(): CameraState;
  setPaused(paused: boolean): void;
  /** Fixed time step and the renderer's deterministic mode; `cycleNoise` as in CoreRenderer.setDeterministic. */
  setDeterministic(on: boolean, opts?: { cycleNoise?: boolean }): void;
  /** Replace the per-frame callback. */
  onFrame(cb: ((snapshot: SimSnapshot, realDt: number) => void) | null): void;
  /** Render one frame now (outside requestAnimationFrame), e.g. to step while the loop is stopped. */
  renderFrame(realDt?: number): void;
  /** Stop / restart the requestAnimationFrame loop (renderFrame still works). */
  setLoop(running: boolean): void;
  dispose(): void;
}

declare global {
  interface Window {
    /** The lab application of the page (labs only). */
    __lab?: LabApp;
  }
}

export async function createLabApp(options: LabAppOptions): Promise<LabApp> {
  const query = options.query ?? new URLSearchParams(location.search);
  const sceneName = options.scene ?? ((query.get('scene') as FakeScene | null) ?? 'lowOrbit');
  const labName = options.name ?? location.pathname.split('/').filter(Boolean).slice(-1)[0] ?? 'lab';
  const testApi = installTestApi({ kind: 'lab', name: labName, scenarioId: `fake-${sceneName}` });

  try {
    const gpu = await acquireGpu({ onError: testApi.reportError });
    testApi.setAdapter(gpu.report);
    const defs = options.defs ?? (await loadDefs(fetchDefSource()));
    const sim = typeof options.sim === 'function' ? options.sim(defs) : (options.sim ?? createFakeSim(defs, { scene: sceneName }));
    await sim.ready;

    const canvas = options.canvas;
    const scale = Number(query.get('scale') ?? '');
    const rendererOptions: RendererOptions = {
      onError: testApi.reportError,
      perfFeatures: query.get('perf') === 'features',
      ...options.renderer,
      quality: { ...(Number.isFinite(scale) && scale > 0 ? { renderScaleMin: scale, renderScaleMax: scale } : {}), ...options.renderer?.quality },
      // ?governor=off pins qualityScale at 1 (budgets are stated at scale 1); combine with ?scale= to pin the resolution.
      governor: { ...(query.get('governor') === 'off' ? { qualityMin: 1 } : {}), ...options.renderer?.governor },
    };
    const renderer = await createRenderer(canvas, gpu, defs, rendererOptions);
    const fit = (): void => renderer.resize(Math.max(1, Math.round(canvas.clientWidth * devicePixelRatio)), Math.max(1, Math.round(canvas.clientHeight * devicePixelRatio)));
    fit();
    window.addEventListener('resize', fit);
    const featureList = typeof options.features === 'function' ? options.features(defs, sim) : (options.features ?? []);
    for (const f of featureList) await renderer.addFeature(f);

    const controls = { ...NEUTRAL_CONTROLS, translate: v3.zero() };
    let snapshot = sim.snapshot();
    const camera = labCameraFromQuery(query, snapshot, defs);
    Object.assign(camera.settings, options.cameraSettings);
    // An explicit spec is the default placement; camera parameters in the query string still win.
    const queryPlaces = query.has('body') || query.has('vessel') || query.has('orbit');
    if (options.camera && !queryPlaces) camera.spec = typeof options.camera === 'function' ? options.camera(snapshot, defs) : options.camera;
    let cameraState = camera.state(snapshot);
    let paused = query.get('paused') === '1';
    let deterministic = false;
    let onFrame = options.onFrame ?? null;
    let looping = true;
    let disposed = false;
    let last = performance.now();
    if (query.has('ev')) renderer.setExposureOverride(Number(query.get('ev')));

    // Mouse: drag to look / orbit, wheel to zoom.
    let dragging = false;
    canvas.addEventListener('pointerdown', (e) => {
      dragging = true;
      canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener('pointerup', () => {
      dragging = false;
    });
    canvas.addEventListener('pointermove', (e) => {
      if (dragging) camera.nudge(-e.movementX * 0.005, e.movementY * 0.005, 1);
    });
    canvas.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        camera.nudge(0, 0, e.deltaY > 0 ? 1.1 : 1 / 1.1);
      },
      { passive: false },
    );

    const renderFrame = (realDt = 1 / 60): void => {
      const dt = deterministic ? 1 / 60 : realDt;
      renderer.context.perf.cpuBegin('frame');
      if (!paused) sim.advance(dt);
      snapshot = sim.snapshot();
      onFrame?.(snapshot, dt);
      cameraState = camera.state(snapshot);
      renderer.render(snapshot, cameraState, [{ positionRoot: cameraState.positionRoot, radiusBias: 0 }], dt);
      renderer.context.perf.cpuEnd('frame');
      testApi.frameDone();
    };
    const loop = (now: number): void => {
      if (disposed) return;
      const dt = Math.min(0.1, Math.max(0, (now - last) / 1000));
      last = now;
      if (looping) {
        try {
          renderFrame(dt);
        } catch (e) {
          testApi.reportError(e instanceof Error ? `frame: ${e.message}` : String(e));
          looping = false;
        }
      }
      requestAnimationFrame(loop);
    };

    const app: LabApp = {
      renderer,
      gpu,
      defs,
      sim,
      camera,
      testApi,
      query,
      snapshot: () => snapshot,
      cameraState: () => cameraState,
      setPaused(p) {
        paused = p;
      },
      setDeterministic(on, o) {
        deterministic = on;
        renderer.setDeterministic(on, o);
      },
      onFrame(cb) {
        onFrame = cb;
      },
      renderFrame,
      setLoop(running) {
        looping = running;
        last = performance.now();
      },
      dispose() {
        disposed = true;
        window.removeEventListener('resize', fit);
        renderer.dispose();
      },
    };
    window.__lab = app;

    testApi.extend({
      state: () => structuredClone(snapshot),
      milestones: () => structuredClone(snapshot.milestones),
      commands: sim.commands,
      setControls: (partial) => {
        Object.assign(controls, partial);
        sim.setControls(controls);
      },
      isIdle: () => renderer.isIdle(),
      perf: () => renderer.perfSnapshot(),
      resetPerf: () => renderer.resetPerf(),
      hdrStats: () => renderer.readHdrStats(),
      setDeterministic: (on) => app.setDeterministic(on),
      setPaused: (p) => app.setPaused(p),
      camera: () => structuredClone(cameraState),
      setCameraOrbit: (yaw, pitch, distance) => camera.setOrbit(yaw, pitch, distance),
      setView: (mode) => {
        camera.settings.kind = mode === 'cockpit' ? 'interior' : mode === 'map' ? 'map' : 'external';
      },
    });
    if (query.get('deterministic') === '1') app.setDeterministic(true, { cycleNoise: query.get('noise') === 'cycle' });

    requestAnimationFrame(loop);
    await testApi.api.waitFrames(3);
    if (options.autoReady !== false) testApi.markReady(testApi.api.errors.length === 0);
    return app;
  } catch (err) {
    testApi.reportError(err instanceof Error ? err.message : String(err));
    testApi.markReady(false);
    throw err;
  }
}
