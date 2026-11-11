/**
 * window.__test for the game (src/core/contracts/testApi.ts) and window.__app, the app's debug handle for its
 * own specs. Both are read-only with respect to physics: `setControls` and `commands` are the sink and the
 * commands the keyboard drives, the pilot acts through the same two, and nothing here reaches `Sim.debug`.
 */
import type { TestApi } from '@/core/contracts/testApi';
import type { TestApiController } from '@/core/testing/testApi';
import type { ExposureInfo } from '@/render/core';
import type { Game } from './game';
import type { FrameStage, WindowStats } from './timing';

/** What the app's own specs read besides window.__test. */
export interface AppDebug {
  /** Registered render features in registration order, with their package. */
  features(): { id: string; pkg: string }[];
  /** Feature ids in the order the core calls a hook (sorted by `order`, then registration). */
  featureOrder(): string[];
  /** Main-thread time of the frame function and its stages over the last 300 frames, ms. */
  cpu(): { frame: WindowStats; stages: Record<FrameStage, WindowStats> };
  resetCpu(): void;
  exposure(): ExposureInfo;
  viewMode(): string;
  viewBlending(): boolean;
  hudVisible(): boolean;
  keyboardLocked(): boolean;
  heldCodes(): string[];
  paused(): boolean;
  frames(): number;
  /** Controller's throttle lever (0..1). */
  lever(): number;
  /** Simulation diagnostics (steps, rails advances, terrain requests and clamps). */
  simStats(): Record<string, number>;
  /** Whether the beforeunload guard asks before leaving the page now. */
  inFlight(): boolean;
  /** Notifications currently shown by the HUD. */
  notifications(): string[];
  /** The numbers the test pilot noted (delta-v per maneuver, landing miss...), when it has flown. */
  pilotReport(): Record<string, number> | null;
  /** Pages of the cockpit's displays (left, centre, right). */
  mfdPages(): string[];
  /** A few numbers of the latest snapshot, cheap enough to poll every frame (state() copies everything). */
  brief(): AppBrief;
  /** Local lights of the last rendered frame: kind, peak intensity (cd), distance from the eye and range, m. */
  frameLights(): { kind: string; intensity: number; distance: number; range: number }[];
  /** Ids of the render features that report work in progress (`isIdle()` false): what `window.__test.isIdle()` waits for. */
  busyFeatures(): string[];
  /** The terrain feature's streaming counters and per-body selection (fading tiles, deepest level, nodes). */
  terrainStats(): {
    stream: Record<string, number>;
    bodies: Record<string, { fading: number; deepestLevel: number; nodes: number }>;
    rocks: Record<string, number>;
    cover: Record<string, number>;
    /** Main-thread time of the terrain feature in the last frame, ms (hooks and their parts). */
    cpu: Record<string, number>;
  };
}

export interface AppBrief {
  ut: number;
  met: number;
  altitudeAsl: number;
  altitudeRadar: number;
  verticalSpeed: number;
  speedSurface: number;
  throttle: number;
  thrust: number;
  nextStage: number;
  situation: string;
  vessels: number;
  sasEnabled: boolean;
  sasMode: string;
  rcsEnabled: boolean;
  warpIndex: number;
  warpFactor: number;
  navballMode: string;
  milestones: string[];
  cameraKind: string;
  viewMode: string;
  paused: boolean;
}

declare global {
  interface Window {
    __app?: AppDebug;
  }
}

export function installGameTestHooks(testApi: TestApiController, game: Game): void {
  const pilot: NonNullable<TestApi['pilot']> = {
    start: () => game.pilot.start(),
    stop: () => {
      game.pilot.stop();
      game.controller.setThrottle(game.snapshot().appliedControls.throttle);
    },
    phase: () => game.pilot.pilot?.phase ?? null,
    done: () => game.pilot.pilot?.done ?? false,
    failure: () => game.pilot.pilot?.failure ?? null,
  };
  testApi.extend({
    page: { kind: 'app', name: 'main', scenarioId: game.scenarioId },
    state: () => structuredClone(game.snapshot()),
    milestones: () => structuredClone(game.snapshot().milestones),
    isIdle: () => game.renderer.isIdle(),
    perf: () => game.renderer.perfSnapshot(),
    resetPerf: () => {
      game.renderer.resetPerf();
      game.timings.reset();
    },
    setControls: (partial) => game.setTestControls(partial),
    commands: game.sim.commands,
    pilot,
    setView: (mode) => {
      game.setView(mode);
    },
    camera: () => structuredClone(game.camera()),
    setCameraOrbit: (yaw, pitch, distance) => game.setCameraOrbit(yaw, pitch, distance),
    setDeterministic: (on) => game.setDeterministic(on),
    setPaused: (p) => game.setPaused(p),
    hdrStats: () => game.renderer.readHdrStats(),
    audio: () => game.audio.probe(),
    map: () => game.features.map.describe(),
  });

  window.__app = {
    features: () => game.features.list.map((f) => ({ id: f.id, pkg: game.features.packageOf[f.id] ?? '?' })),
    featureOrder: () => game.renderer.featureOrder(),
    cpu: () => game.timings.stats(),
    resetCpu: () => game.timings.reset(),
    exposure: () => game.renderer.exposureInfo(),
    viewMode: () => game.views.mode,
    viewBlending: () => game.views.blending,
    hudVisible: () => game.hud.visible,
    keyboardLocked: () => game.input.keyboardLocked,
    heldCodes: () => game.input.heldCodes(),
    paused: () => game.paused,
    frames: () => game.frames,
    lever: () => game.controller.throttle,
    simStats: () => ({ ...game.sim.stats() }) as unknown as Record<string, number>,
    inFlight: () => game.inFlight(),
    notifications: () => game.hud.notifications(),
    pilotReport: () => (game.pilot.pilot ? { ...game.pilot.pilot.report } : null),
    mfdPages: () => Array.from({ length: game.features.cockpitControls.displayCount }, (_, i) => game.features.cockpitControls.page(i)),
    brief: () => {
      const s = game.snapshot();
      const r = s.readouts;
      const v = s.vessels.find((x) => x.id === s.activeVesselId);
      return {
        ut: s.ut,
        met: r.met,
        altitudeAsl: r.altitudeAsl,
        altitudeRadar: r.altitudeRadar,
        verticalSpeed: r.verticalSpeed,
        speedSurface: r.speedSurface,
        throttle: s.appliedControls.throttle,
        thrust: r.thrust,
        nextStage: s.staging.nextStage,
        situation: v?.situation ?? 'none',
        vessels: s.vessels.length,
        sasEnabled: r.sasEnabled,
        sasMode: r.sasMode,
        rcsEnabled: r.rcsEnabled,
        warpIndex: s.warp.index,
        warpFactor: s.warp.factor,
        navballMode: s.navball.mode,
        milestones: s.milestones.map((m) => m.id),
        cameraKind: game.camera().kind,
        viewMode: game.views.mode,
        paused: game.paused,
      };
    },
    frameLights: () =>
      (game.renderer.frameContext?.lights ?? []).map((l) => ({
        kind: l.kind,
        intensity: Math.max(...l.intensity),
        distance: Math.hypot(l.posRelCam.x, l.posRelCam.y, l.posRelCam.z),
        range: l.range,
      })),
    busyFeatures: () => game.features.list.filter((f) => f.isIdle !== undefined && !f.isIdle()).map((f) => f.id),
    terrainStats: () => {
      const t = game.features.terrain.debug.stats();
      return {
        stream: { ...t.stream } as unknown as Record<string, number>,
        bodies: Object.fromEntries(Object.entries(t.bodies).map(([id, b]) => [id, { fading: b.fading, deepestLevel: b.deepestLevel, nodes: b.nodes }])),
        rocks: { ...t.rocks },
        cover: { ...t.cover },
        cpu: { ...t.cpu, selectMs: t.selectMs, prefetchMs: t.prefetchMs },
      };
    },
  };
}
