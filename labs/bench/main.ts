/**
 * Bench lab (capability-settings): the calibration of ARCHITECTURE 24 on the real renderer with every render
 * package, the real session (createSession of src/session) and the scenarios of the quality table's shots,
 * as the app will run it. It is the `CalibrationHost` of src/bench for the acceptance specs
 * (tests/browser/bench) and the measurements of the hand-off.
 *
 *   ?shot=<id>              the shot the page opens on (default: the table's first)
 *   &ballast=<iterations>   a slower GPU (slowGpu.ts): a march over every internal pixel, counted as fixed cost
 *   &safe=1                 the seed is the safe preset (as the gate's ?safe=1)
 *   &timestamps=0           measure as a device without timestamp queries does (queue completion latency per frame)
 * The page's library holds the presentable vehicles (src/core/access/presentable.ts; request
 * capability-settings-2) and their scenarios; the shots fly meridian-lunar.
 * plus the camera / renderer parameters of createLabApp.
 *
 * On load the renderer runs on the SEED preset of the adapter class hint (no calibration has run: the state
 * the title is in). `window.__bench`:
 *   warmUp()      prefetch the needs of data/defs/render/quality.json (what the title streams); `resident()`
 *                 is false before (and always, while the file records no needs)
 *   visitShots()  open and settle every shot in turn (the spec records each shot's requests as its needs)
 *   calibrate()   runCalibration over this page (refuses while not resident); the result is applied
 *   showShot(id, profile?)  place a shot for a picture or a measurement
 *   showScene(scene)        place any scenario with a chase or a cockpit camera (the measurements' scenes)
 *   cpuProbe()    the CPU score's simulation workload, ms
 */
import type { LocalSession } from '@/core/contracts/session';
import type { QualityProfile } from '@/core/contracts/render';
import type { SimSnapshot } from '@/core/contracts/sim';
import { NEUTRAL_CONTROLS } from '@/core/contracts/controls';
import { presentableLibrary } from '@/core/access/presentable';
import { fetchDefSource } from '@/core/defs/fetchSource';
import { loadDefs } from '@/core/defs/loader';
import { DEG, quat, v3, type Vec3 } from '@/core/math';
import { findCockpitSeat } from '@/camera';
import { createLabApp, lookRotation } from '@/render/core/lab';
import { createFetchTileSource, createTerrainProvider } from '@/terrain';
import { createMfdPainter, createNavballRenderer } from '@/ui';
import {
  CalibrationNotReady,
  parseQualityTable,
  presetProfile,
  progressLine,
  prefetchNeeds,
  residentFor,
  runCalibration,
  seedPreset,
  type CalibrationHost,
  type CalibrationProgress,
  type CalibrationResult,
  type FrameSample,
  type ShotDef,
  type ShotRun,
} from '@/bench';
import { buildFeatures, FEATURE_PACKAGES, importPackages, importRealSession } from '../integration/features';
import { createSlowGpu } from './slowGpu';

/** A scene of the measurements: a scenario, its camera, whether the pilot ignites. */
export interface BenchScene {
  scenario: string;
  camera: 'chase' | 'cockpit';
  chaseDistanceM: number;
  yawDeg: number;
  pitchDeg: number;
  ignite: boolean;
}

export interface BenchLab {
  seed: string;
  showScene(scene: BenchScene): Promise<void>;
  /** Settle a shot at a profile (the current one when absent), for a picture. */
  showShot(shotId: string, profile?: QualityProfile): Promise<void>;
  /** Open and settle every shot in turn (the spec records the requests of each: `onShot` names the shot that starts). */
  visitShots(onShot?: (shotId: string) => void): Promise<void>;
  /** Prefetch the table's needs (what the title streams): the files in, and those that failed. */
  warmUp(): Promise<{ files: number; failed: string[] }>;
  resident(): boolean;
  calibrate(): Promise<CalibrationResult>;
  progress: CalibrationProgress[];
  setBallast(iterations: number): void;
  cpuProbe(): Promise<number>;
  settingIds(): string[];
  problems: string[];
}

declare global {
  interface Window {
    __bench?: BenchLab;
  }
}

const query = new URLSearchParams(location.search);
const info = document.getElementById('info')!;
/** Set once the lab app exists: a failure after that resolves the page's ready as failed. */
let failed: ((message: string) => void) | null = null;

async function main(): Promise<void> {
  const canvas = document.getElementById('viewport') as HTMLCanvasElement;
  const library = await loadDefs(fetchDefSource());
  const defs = presentableLibrary(library);
  const table = parseQualityTable(await (await fetch('/defs/render/quality.json', { cache: 'no-store' })).json());
  const terrain = await createTerrainProvider(defs, createFetchTileSource('/tiles'));
  const createSession = await importRealSession();
  if (!createSession) throw new Error('bench lab: src/session does not export createSession');
  const problems: string[] = [];

  // One page, several scenarios: the lab app drives this session, whose inner session each shot replaces.
  const firstShot = table.shots.find((s) => s.id === query.get('shot')) ?? table.shots[0]!;
  let current: LocalSession = createSession(defs, firstShot.scenario, { terrain });
  const session = new Proxy({} as LocalSession, {
    get(_t, key) {
      const v = Reflect.get(current as object, key, current) as unknown;
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(current) : v;
    },
  });

  const app = await createLabApp({ canvas, name: 'bench', defs, sim: session, features: [], autoReady: false, camera: { type: 'orbit', target: { vesselId: 'active' }, yaw: 0, pitch: 0.15, distance: 300 } });
  failed = () => app.testApi.markReady(false);
  const ctx = app.renderer.context;
  const navball = createNavballRenderer(app.gpu);
  ctx.resources.publish('ui.navball', navball.view);
  const imported = await importPackages(FEATURE_PACKAGES);
  problems.push(...imported.problems);
  const built = buildFeatures(imported.modules, { defs, sim: session, ctx, gpu: app.gpu, terrain, navball, mfdPainter: createMfdPainter(), query });
  problems.push(...built.problems);
  for (const f of built.features) await app.renderer.addFeature(f);
  const slow = createSlowGpu();
  await app.renderer.addFeature(slow.feature);
  if (query.has('ballast')) slow.setIterations(Number(query.get('ballast')));
  await app.renderer.warm();

  const settingIds = (): string[] => app.renderer.core.quality.settings().map((s) => s.setting.id);
  // Before any calibration the page runs on the seed preset of the adapter class hint (the title's state).
  const seed = seedPreset(table, app.gpu.adapterClass, query.get('safe') === '1');
  await app.renderer.setQuality!(presetProfile(table, seed, settingIds()));

  // -------------------------------------------------------------------------------------------- shots
  const seatCamera = (snapshot: SimSnapshot): { positionRoot: Vec3; qViewToRoot: ReturnType<typeof lookRotation> } | null => {
    const v = snapshot.vessels.find((x) => x.id === snapshot.activeVesselId);
    const found = v ? findCockpitSeat(defs, v) : null;
    if (!v || !found) return null;
    const { part, seat } = found;
    const L = v3.normalize(v3.fromTuple(seat.lookDir));
    const U = v3.normalize(v3.reject(v3.fromTuple(seat.upDir), L));
    // The commander's seat, turned towards the side window (the Earth below in low orbit).
    const qLook = quat.mul(quat.fromAxisAngle(v3.unitY(), -70 * DEG), quat.fromAxisAngle(v3.unitX(), -5 * DEG));
    return {
      positionRoot: v3.add(v.rRoot, quat.rotate(v.q, v3.add(part.localPos, quat.rotate(part.localRot, v3.fromTuple(seat.pos))))),
      qViewToRoot: quat.normalize(quat.mul(quat.mul(v.q, part.localRot), quat.mul(lookRotation(L, U), qLook))),
    };
  };
  let follow: ((s: SimSnapshot) => void) | null = null;
  app.onFrame((s) => follow?.(s));
  let shotNow: string | null = null;
  const placeShot = (shot: ShotDef): Promise<void> => placeScene({ ...shot, yawDeg: 250, pitchDeg: 8 }).then(() => void (shotNow = shot.id));
  const placeScene = async (shot: BenchScene, fresh = true): Promise<void> => {
    if (fresh) {
      current = createSession(defs, shot.scenario, { terrain });
      await current.ready;
    }
    follow = null;
    if (shot.camera === 'cockpit') {
      app.camera.settings.kind = 'interior';
      follow = (s) => {
        const at = seatCamera(s);
        if (at) app.camera.spec = { type: 'free', ...at };
      };
      follow(current.snapshot());
    } else {
      app.camera.settings.kind = 'external';
      app.camera.spec = { type: 'orbit', target: { vesselId: 'active' }, yaw: shot.yawDeg * DEG, pitch: shot.pitchDeg * DEG, distance: shot.chaseDistanceM };
    }
    if (shot.ignite) {
      current.setControls({ ...NEUTRAL_CONTROLS, translate: v3.zero(), throttle: 1 });
      const res = current.commands.stage();
      if (!res.ok) throw new Error(`bench lab: ignition refused (${res.reason ?? ''})`);
    }
  };
  const seconds = (s: number): Promise<void> => new Promise((r) => setTimeout(r, 1000 * s));

  // Per-pass GPU timings when the device has timestamp queries; else the coarser path of runShot.
  const timestamps = app.gpu.hasFeature('timestamp-query') && query.get('timestamps') !== '0';
  // The shots' needs that this page has prefetched (the app streams them behind the title the same way).
  const resident = new Set<string>();
  let prefetchFailed: string[] = [];

  const host: CalibrationHost = {
    settings: () => app.renderer.core.quality.settings(),
    displayPx: () => [canvas.width, canvas.height],
    resident: () => table.needs !== null && residentFor(table.needs, (p) => resident.has(p)),
    async runShot(shot, profile, o): Promise<ShotRun> {
      await app.renderer.setQuality!(profile);
      app.renderer.setGovernor(o.governor);
      // The shots measure every pass (attribution); the confirmation measures the game's own frame.
      app.renderer.setPerfAttribution(!o.governor);
      let lost = false;
      void app.gpu.device.lost.then(() => (lost = true));
      await placeShot(shot);
      await seconds(o.settleS);
      const frames: FrameSample[] = [];
      const cpuFrameMs: number[] = [];
      if (timestamps) {
        app.renderer.onGpuFrame((f) => {
          frames.push({ total: f.total, passes: f.passes });
          cpuFrameMs.push(f.cpuMs);
        });
        await seconds(o.measureS);
        app.renderer.onGpuFrame(null);
      } else {
        // No timestamp queries (frontend-ux 9.3): the frame's GPU time is the latency from the end of its
        // encoding to the queue's completion, one sample per displayed frame; no per-pass split.
        const end = performance.now() + 1000 * o.measureS;
        while (performance.now() < end) {
          await new Promise<void>((r) => requestAnimationFrame(() => r()));
          const t0 = performance.now();
          await app.gpu.device.queue.onSubmittedWorkDone();
          frames.push({ total: performance.now() - t0, passes: {} });
          cpuFrameMs.push(app.renderer.perfSnapshot().cpu.p50);
        }
      }
      app.renderer.setPerfAttribution(false);
      app.renderer.setGovernor(true);
      const [w, h] = app.renderer.frameContext?.renderSize ?? [canvas.width, canvas.height];
      return { frames, cpuFrameMs, pixels: w * h, lost };
    },
    async cpuProbe(): Promise<number> {
      const s = createSession(defs, table.shots.find((x) => x.ignite)?.scenario ?? table.shots[0]!.scenario, { terrain });
      await s.ready;
      s.setControls({ ...NEUTRAL_CONTROLS, translate: v3.zero(), throttle: 1 });
      s.commands.stage();
      const t0 = performance.now();
      for (let i = 0; i < table.cpuReference.simSteps; i++) s.step();
      return performance.now() - t0;
    },
  };

  const progress: CalibrationProgress[] = [];
  const bench: BenchLab = {
    seed,
    problems,
    progress,
    settingIds,
    resident: () => host.resident(),
    setBallast: (n) => slow.setIterations(n),
    cpuProbe: () => host.cpuProbe(),
    async showScene(scene) {
      await placeScene(scene);
    },
    async showShot(id, profile) {
      const shot = table.shots.find((s) => s.id === id);
      if (!shot) throw new Error(`bench lab: no shot "${id}"`);
      if (profile) await app.renderer.setQuality!(profile);
      await placeShot(shot);
    },
    async visitShots(onShot) {
      for (const shot of table.shots) {
        onShot?.(shot.id);
        await placeShot(shot);
        // Until the renderer is idle at the shot (its tiles, models and maps in), and over its settle and measure time.
        for (let i = 0; i < 600 && !app.renderer.isIdle(); i++) await app.testApi.api.waitFrames(5);
        await seconds(shot.settleS + shot.measureS);
      }
    },
    async warmUp() {
      if (!table.needs) return { files: 0, failed: [] };
      const r = await prefetchNeeds(table.needs, async (p) => (await fetch(p)).ok, resident);
      prefetchFailed = r.failed;
      return { files: resident.size, failed: prefetchFailed };
    },
    async calibrate() {
      progress.length = 0;
      if (!host.resident()) throw new CalibrationNotReady();
      const result = await runCalibration(host, table, {
        now: () => performance.now(),
        cpuReference: table.cpuReference,
        onProgress: (p) => {
          progress.push(p);
          info.textContent = `CALIBRATING GRAPHICS FOR YOUR GPU\n${progressLine(p)}`;
        },
      });
      await app.renderer.setQuality!(result.profile);
      info.textContent = `${result.preset.toUpperCase()} · ${result.predictedWorstMs.toFixed(2)} ms predicted · confirm p95 ${result.confirm.measuredP95.toFixed(2)} ms`;
      return result;
    },
  };
  window.__bench = bench;
  info.textContent = `seed preset ${seed} (${app.gpu.adapterClass}) · shot ${shotNow ?? table.shots[0]!.id}`;
  app.testApi.markReady(app.testApi.api.errors.length === 0);
}

main().catch((e: unknown) => {
  const message = e instanceof Error ? e.message : String(e);
  info.textContent = `bench lab failed: ${message}`;
  window.__test?.errors.push(message);
  failed?.(message);
});
