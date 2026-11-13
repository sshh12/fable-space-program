/**
 * window.__test for the game (src/core/contracts/testApi.ts) and window.__app, the app's debug handle for its
 * own specs. Both are read-only with respect to physics: `setControls` and `commands` are the sink and the
 * commands the keyboard drives, the pilot acts through the same two, and nothing here reaches `Sim.debug`.
 */
import type { TestApi } from '@/core/contracts/testApi';
import { quat } from '@/core/math/quat';
import { v3 } from '@/core/math/vec3';
import type { TestApiController } from '@/core/testing/testApi';
import { coreOf, type ExposureInfo } from '@/render/core';
import { bodyAngularRadius, discInFrame, projectToFrame } from './framing';
import type { PictureStop, PictureStopHit } from './pictureStops';
import type { Game } from './game';
import type { LoadingReport } from './loading';
import type { FrameBreakdown, FrameStage, FrameTrace, WindowStats } from './timing';

/** What the app's own specs read besides window.__test. */
export interface AppDebug {
  /** Registered render features in registration order, with their package. */
  features(): { id: string; pkg: string }[];
  /** Feature ids in the order the core calls a hook (sorted by `order`, then registration). */
  featureOrder(): string[];
  /**
   * Main-thread time over the last 300 frames, ms: the frame function, its stages, and every render feature's
   * hooks (`core` = the render stage minus the features' hooks).
   */
  cpu(): { frame: WindowStats; stages: Record<FrameStage, WindowStats>; features: Record<string, WindowStats> };
  resetCpu(): void;
  /** The slowest frames since the last reset with their breakdown (stages, features, hooks), slowest first. */
  cpuSlowest(): FrameBreakdown[];
  /** Record every frame's main-thread breakdown from now on (at most `frames`); `takeCpuTrace` returns and ends it. */
  startCpuTrace(frames: number): void;
  takeCpuTrace(): FrameTrace | null;
  /**
   * The chase rig's framing: `auto` = the default azimuth (the player has not turned the camera), the player's
   * pitch offset (rad) and zoom factor, the roll of the default view (rad) and the distance (m). The Home key
   * (`ui:resetCamera`) returns to the default.
   */
  chaseFraming(): { auto: boolean; pitch: number; zoom: number; roll: number; distance: number };
  /** The cabin seat the cockpit rig's eye is in (null before the cockpit view has been shown). */
  seat(): string | null;
  /**
   * Picture stops (src/app/pictureStops.ts): hand the game the moments of the flight to hold at; `pictureStop()`
   * is the stop the simulation is held at now (null = running); `resumeFromPictureStop()` lets it run on.
   */
  setPictureStops(stops: PictureStop[]): void;
  pictureStop(): PictureStopHit | null;
  resumeFromPictureStop(): void;
  pictureStopsFired(): PictureStopHit[];
  /**
   * Points of the ground on rings around the active vessel (metres from its sub-point, `bearings` per ring, from
   * north eastwards), each with what the height authority says is there (land or water, height above the sea
   * level, null on a body without a sea) and where it falls in the presented frame, in CSS pixels of the canvas
   * (null when it is outside the frame or behind the eye). Loads the height data of the rings first.
   */
  groundSamples(distances: number[], bearings: number): Promise<{ distance: number; bearingDeg: number; kind: string; heightAboveSea: number | null; x: number | null; y: number | null }[]>;
  /** Wall time of `renderer.warm()` before the first frame, ms. */
  warmMs(): number;
  /** The camera at a frozen start (`?deterministic=1&paused=1`): frozen now, at rest, rig steps of the last frame. */
  cameraRest(): { frozen: boolean; atRest: boolean; steps: number };
  /** The display's frame intervals (requestAnimationFrame time stamps) since the last `resetPerf` / `resetCpu`, ms. */
  rafIntervals(): number[];
  /** Of the last frame-exact capture: who was busy before and after its frames, and how many meterings its lead-in took. */
  exactInfo(): { busyBefore: string[]; busyAfter: string[]; rounds: number; busyLeadIn: string[] } | null;
  /**
   * Bodies whose disc is at least partly inside the presented frame (framing.ts): id, whether it is the star,
   * angular radius (rad), centre in normalised device coordinates (x right, y up, -1..1 inside; null when the
   * centre is behind the image plane and only the limb reaches in) and the angular radius as a share of the
   * frame's vertical half-angle.
   */
  bodiesInFrame(): { id: string; star: boolean; angularRadius: number; x: number | null; y: number | null; heightShare: number }[];
  /** What the camera's selection of the active vessel's body wants and has: tiles and levels (null without terrain). */
  terrainResidency(): { wanted: number; resident: number; wantedLevel: number; residentLevel: number } | null;
  /**
   * Shader modules (and pipelines created ahead) created and still compiling; texture loads started and
   * outstanding (the render core's counts); the atmosphere's one-off work: parts done and in all (the tables,
   * the cloud noise, each cloud coverage map).
   */
  renderLoads(): { shaders: { pending: number; total: number }; textures: { pending: number; total: number }; atmosphere: { done: number; total: number } };
  /** The loading screen: its steps with their counts and times, and what the frame loop found at the reveal. */
  loading(): LoadingReport;
  /** Wall time of every render feature's start-up, ms, by feature id. */
  featureInitMs(): Record<string, number>;
  exposure(): ExposureInfo;
  viewMode(): string;
  viewBlending(): boolean;
  hudVisible(): boolean;
  keyboardLocked(): boolean;
  /** What the HUD's capture control does: fullscreen + keyboard lock on (needs a user gesture) or off. */
  toggleKeyboardCapture(): void;
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
  /**
   * The cockpit displays' painting since the last `reset`: pages painted, frames, and the main-thread time of
   * the Canvas 2D painting, the upload and the mip encode, ms (null before the cockpit has displays).
   */
  mfdPaintStats(reset?: boolean): { paints: number; frames: number; cpuMs: number; paintMs: number; copyMs: number; mipMs: number } | null;
  /** What the cockpit feature drew in the last frame: its detail level, whether the eye is inside. */
  cockpitFrame(): { active: boolean; lod: string | null; inside: boolean };
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
  /** Attitude against the navball's horizon, degrees (roll 0 = heads up, 180 = heads down). */
  pitchDeg: number;
  rollDeg: number;
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
    // Idle: nothing of the renderer's is under way, and at a frozen start the camera stands (request lead-6).
    isIdle: () => game.renderer.isIdle() && game.cameraRest().atRest,
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
    // Frame-exact capture for the reference images (request lead-3): exactly `frames` of the game's frames at
    // the fixed step, the last one held (RENDER_API section 13).
    renderExact: (frames) => game.renderExact(frames),
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
    cpuSlowest: () => game.timings.slowest(),
    startCpuTrace: (frames) => game.timings.startTrace(frames),
    takeCpuTrace: () => game.timings.takeTrace(),
    chaseFraming: () => {
      const c = game.chase;
      return { auto: c.autoAzimuth, pitch: c.offsets.pitch, zoom: c.offsets.zoom, roll: c.roll, distance: c.distance };
    },
    seat: () => game.cockpitRig.seatId,
    setPictureStops: (stops) => game.setPictureStops(stops),
    pictureStop: () => game.pictureStop(),
    resumeFromPictureStop: () => game.resumeFromPictureStop(),
    pictureStopsFired: () => game.pictureStopsFired(),
    warmMs: () => game.warmMs,
    cameraRest: () => game.cameraRest(),
    rafIntervals: () => game.timings.intervals(),
    exactInfo: () => {
      const e = game.renderer.exactInfo();
      return e ? { busyBefore: [...e.busyBefore], busyAfter: [...e.busyAfter], rounds: e.rounds, busyLeadIn: [...e.busyLeadIn] } : null;
    },
    groundSamples: async (distances, bearings) => {
      const s = game.snapshot();
      const cam = game.camera();
      const vessel = s.vessels.find((x) => x.id === s.activeVesselId);
      const body = vessel ? s.bodies.find((b) => b.id === vessel.bodyId) : undefined;
      const def = vessel ? game.defs.bodies[vessel.bodyId] : undefined;
      if (!vessel || !body || !def) return [];
      // Local frame at the vessel's sub-point (ROOT axes): up, north along the body's pole, east.
      const up = v3.normalize(vessel.r);
      const pole = quat.rotate(body.qFixedToRoot, v3.unitZ());
      const eastRaw = v3.cross(pole, up);
      const east = v3.normalize(v3.len(eastRaw) < 1e-9 ? v3.anyOrthogonal(up) : eastRaw);
      const north = v3.cross(up, east);
      const fixed = (dirRoot: { x: number; y: number; z: number }): { x: number; y: number; z: number } => quat.rotateInv(body.qFixedToRoot, dirRoot);
      await game.terrain.ensureLoaded(vessel.bodyId, fixed(up), Math.max(...distances) + 100, 'app:ground-samples');
      const canvas = game.renderer.canvas;
      const tanY = Math.tan(cam.fovY / 2);
      const tanX = tanY * (canvas.width / Math.max(1, canvas.height));
      const seaLevel = def.ocean ? def.ocean.seaLevel : null;
      const out: { distance: number; bearingDeg: number; kind: string; heightAboveSea: number | null; x: number | null; y: number | null }[] = [];
      for (const distance of distances) {
        for (let k = 0; k < bearings; k++) {
          const a = distance / def.radius;
          const b = (2 * Math.PI * k) / bearings;
          const horizontal = v3.add(v3.scale(north, Math.cos(b)), v3.scale(east, Math.sin(b)));
          const dirRoot = v3.normalize(v3.add(v3.scale(up, Math.cos(a)), v3.scale(horizontal, Math.sin(a))));
          const dirFixed = fixed(dirRoot);
          const height = game.terrain.heightAt(vessel.bodyId, dirFixed);
          const kind = game.terrain.surfaceKind(vessel.bodyId, dirFixed);
          // What the picture shows at the point: the ground, or the water's surface where the ground is the sea
          // bed (off Ka Lae the bed is 100-200 m down within 600 m of the coast: projected at the bed, a point of
          // the sea falls on the land in front of it).
          const surface = kind === 'water' && seaLevel !== null ? Math.max(height, seaLevel) : height;
          const posRoot = v3.add(body.rRoot, v3.scale(dirRoot, def.radius + surface));
          const p = projectToFrame(quat.rotateInv(cam.qViewToRoot, v3.sub(posRoot, cam.positionRoot)), tanX, tanY);
          const inside = p !== null && Math.abs(p.x) < 1 && Math.abs(p.y) < 1;
          out.push({
            distance,
            bearingDeg: (360 * k) / bearings,
            kind,
            heightAboveSea: seaLevel === null ? null : height - seaLevel,
            x: inside ? (p.x * 0.5 + 0.5) * canvas.clientWidth : null,
            y: inside ? (0.5 - p.y * 0.5) * canvas.clientHeight : null,
          });
        }
      }
      return out;
    },
    bodiesInFrame: () => {
      const s = game.snapshot();
      const cam = game.camera();
      const canvas = game.renderer.canvas;
      const tanY = Math.tan(cam.fovY / 2);
      const tanX = tanY * (canvas.width / Math.max(1, canvas.height));
      const out: { id: string; star: boolean; angularRadius: number; x: number | null; y: number | null; heightShare: number }[] = [];
      for (const b of s.bodies) {
        const def = game.defs.bodies[b.id];
        if (!def) continue;
        // View space: x right, y up, the eye looks down -z.
        const d = quat.rotateInv(cam.qViewToRoot, v3.sub(b.rRoot, cam.positionRoot));
        const distance = Math.hypot(d.x, d.y, d.z);
        const angularRadius = bodyAngularRadius(def.radius, distance);
        const f = discInFrame(d, angularRadius, tanX, tanY);
        if (f.inFrame) out.push({ id: b.id, star: b.id === s.starId, angularRadius, x: f.x, y: f.y, heightShare: f.heightShare });
      }
      return out;
    },
    terrainResidency: () => {
      const s = game.snapshot();
      const v = s.vessels.find((x) => x.id === s.activeVesselId);
      const r = v ? game.features.terrain.debug.residency(v.bodyId) : null;
      if (!r) return null;
      return { wanted: r.wanted.reduce((a, n) => a + n, 0), resident: r.resident.reduce((a, n) => a + n, 0), wantedLevel: r.wantedLevel, residentLevel: r.residentLevel };
    },
    renderLoads: () => {
      const core = coreOf(game.renderer.context);
      const a = game.features.atmosphere.status();
      return {
        shaders: core.shaders.compilations(),
        textures: core.meshes.loads(),
        atmosphere: { done: (a.tablesReady ? 1 : 0) + (a.noiseReady ? 1 : 0) + a.coverage.loaded, total: 2 + a.coverage.total },
      };
    },
    loading: () => game.loadingReport(),
    featureInitMs: () => ({ ...game.featureInitMs }),
    exposure: () => game.renderer.exposureInfo(),
    viewMode: () => game.views.mode,
    viewBlending: () => game.views.blending,
    hudVisible: () => game.hud.visible,
    keyboardLocked: () => game.input.keyboardLocked,
    toggleKeyboardCapture: () => game.toggleKeyboardCapture(),
    heldCodes: () => game.input.heldCodes(),
    paused: () => game.paused,
    frames: () => game.frames,
    lever: () => game.controller.throttle,
    simStats: () => ({ ...game.sim.stats() }) as unknown as Record<string, number>,
    inFlight: () => game.inFlight(),
    notifications: () => game.hud.notifications(),
    pilotReport: () => (game.pilot.pilot ? { ...game.pilot.pilot.report } : null),
    mfdPages: () => Array.from({ length: game.features.cockpitControls.displayCount }, (_, i) => game.features.cockpitControls.page(i)),
    mfdPaintStats: (reset = false) => {
      const d = game.features.cockpit.displays;
      if (!d) return null;
      const s = { ...d.stats };
      if (reset) d.resetStats();
      return s;
    },
    cockpitFrame: () => {
      const s = game.features.cockpit.stats();
      return { active: s.active, lod: s.lod, inside: s.inside };
    },
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
        pitchDeg: s.navball.pitchDeg,
        rollDeg: s.navball.rollDeg,
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
