/**
 * The cloud derating benchmark (platform-delivery D7; ARCHITECTURE 29.2 "one worker thread at 50 %"): real
 * simulation regimes stepped by 1, 2, 4 and 8 worker threads that step the SAME tick together (a shared tick
 * counter; the main thread advances it every 8.333 ms by sleeping, the workers block on it: sleep-scheduled,
 * nothing spins), with per-thread step times (p50, p99), billed vCPU-seconds per vessel-second and the idle
 * CPU of the process, so the numbers can be compared between the development machine and a Railway replica.
 *
 * Regimes: the whole world step of `createSim` (stepVessel and the world around it, real terrain) in six states
 * of the real mission: the pad ascent with the first stage burning (the stack, nine engines, SAS), low Earth
 * orbit coasting (qa-leo), Earth entry with heating (qa-entry), the descent under drogues (qa-drogues), the
 * lunar powered descent (qa-powered-descent, throttle on) and landed on the Moon (qa-lunar-surface). Each
 * worker holds one sim of each regime and steps all six every tick: per worker 6 vessel-steps a tick, 720 a
 * second of simulated time.
 *
 * Terrain: the pack source over the deployed pack list (BENCH_PACK_LIST, the cloud form) or the plain files of
 * data/tiles (BENCH_TILES_DIR, the development machine). Definitions: BENCH_DEFS_DIR (the image ships them
 * at /app/client/defs). Output: one JSON line `derating-result` in the log.
 *
 *   ROLES=derating BENCH_TILES_DIR=data/tiles BENCH_DEFS_DIR=data/defs node <bundle>/main.mjs
 *   (Railway) node deploy/railway/provision.mjs ops derating   with the ops service at 8 vCPU / 8 GB
 */
import os from 'node:os';
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads';
import type { ControlInputs } from '../../src/core/contracts/controls';
import { fsDefSource } from '../../src/core/defs/fsSource';
import { loadDefs } from '../../src/core/defs/loader';
import { createSim } from '../../src/sim';
import { createTerrainProvider } from '../../src/terrain/provider';
import { createTileSource } from '../../src/terrain/tileSource.node';
import type { RoleContext, RoleHandle, RoleModule } from '../roles/types';

const TICK_MS = 1000 / 120;
export const REGIMES: { name: string; scenario: string; throttle: number; stage: boolean }[] = [
  { name: 'ascent, first stage burning', scenario: 'lunar-direct', throttle: 1, stage: true },
  { name: 'low Earth orbit, coasting', scenario: 'qa-leo', throttle: 0, stage: false },
  { name: 'Earth entry, heating', scenario: 'qa-entry', throttle: 0, stage: false },
  { name: 'descent under drogues', scenario: 'qa-drogues', throttle: 0, stage: false },
  { name: 'lunar powered descent', scenario: 'qa-powered-descent', throttle: 0.6, stage: false },
  { name: 'landed on the Moon', scenario: 'qa-lunar-surface', throttle: 0, stage: false },
];

interface WorkerInit {
  kind: 'derating-worker';
  index: number;
  tick: SharedArrayBuffer;
  defsDir: string;
  tilesDir: string | null;
  packList: string | null;
}

interface WorkerReport {
  index: number;
  ticks: number;
  stepUs: number[];
  error?: string;
}

const controls = (throttle: number): ControlInputs => ({ pitch: 0, yaw: 0, roll: 0, translate: { x: 0, y: 0, z: 0 }, throttle });

/** One worker: build the six sims, then step them on every tick until the counter goes negative. */
async function workerMain(init: WorkerInit): Promise<void> {
  const defs = await loadDefs(fsDefSource(init.defsDir));
  const source = init.packList ? createTileSource({ kind: 'pack', packListUrl: init.packList }) : createTileSource({ kind: 'fs', root: init.tilesDir! });
  const terrain = await createTerrainProvider(defs, source);
  const sims = [];
  for (const r of REGIMES) {
    const sim = createSim(defs, r.scenario, { terrain });
    await sim.ready;
    sim.setControls(controls(r.throttle));
    if (r.stage) sim.commands.stage();
    for (let i = 0; i < 120; i++) sim.step(); // warm: one simulated second
    sims.push(sim);
  }
  const tick = new Int32Array(init.tick);
  parentPort!.postMessage({ ready: init.index });
  const stepUs: number[] = [];
  let seen = Atomics.load(tick, 0);
  for (;;) {
    Atomics.wait(tick, 0, seen);
    const now = Atomics.load(tick, 0);
    if (now < 0) break;
    // Every tick is stepped: a worker that wakes late (or a timer that fired late) catches up, as a shard does.
    for (; seen < now; seen++) {
      const t0 = performance.now();
      for (const s of sims) s.step();
      stepUs.push((performance.now() - t0) * 1000);
    }
  }
  parentPort!.postMessage({ index: init.index, ticks: stepUs.length, stepUs } satisfies WorkerReport);
}

if (!isMainThread && (workerData as WorkerInit | undefined)?.kind === 'derating-worker') {
  workerMain(workerData as WorkerInit).catch((e: unknown) => parentPort!.postMessage({ index: (workerData as WorkerInit).index, ticks: 0, stepUs: [], error: (e as Error).stack ?? String(e) }));
}

const pct = (xs: number[], q: number): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))] ?? Number.NaN;
};

/** Run `count` synchronised workers for `seconds`; returns per-thread stats and CPU. */
async function runLevel(ctx: RoleContext, count: number, seconds: number, opts: Omit<WorkerInit, 'kind' | 'index' | 'tick'>): Promise<Record<string, unknown>> {
  const tick = new SharedArrayBuffer(4);
  const t = new Int32Array(tick);
  const workers: Worker[] = [];
  const reports: WorkerReport[] = [];
  let ready = 0;
  const done = new Promise<void>((resolve, reject) => {
    for (let i = 0; i < count; i++) {
      const w = new Worker(new URL(import.meta.url), { workerData: { kind: 'derating-worker', index: i, tick, ...opts } satisfies WorkerInit });
      w.on('message', (m: { ready?: number } & Partial<WorkerReport>) => {
        if (m.ready !== undefined) ready++;
        else {
          if (m.error) reject(new Error(`worker ${m.index}: ${m.error}`));
          reports.push(m as WorkerReport);
          if (reports.length === count) resolve();
        }
      });
      w.on('error', reject);
      workers.push(w);
    }
  });
  while (ready < count) await new Promise((r) => setTimeout(r, 50));
  // Ticks: the main thread sleeps to each boundary (no spinning) and wakes the workers.
  const cpu0 = process.cpuUsage();
  const wall0 = performance.now();
  const ticks = Math.round((seconds * 1000) / TICK_MS);
  for (let k = 1; k <= ticks; k++) {
    const due = wall0 + k * TICK_MS;
    const wait = due - performance.now();
    if (wait > 1) await new Promise((r) => setTimeout(r, wait - 0.5));
    Atomics.store(t, 0, k);
    Atomics.notify(t, 0);
  }
  const wall = (performance.now() - wall0) / 1000;
  const cpu = process.cpuUsage(cpu0);
  Atomics.store(t, 0, -1);
  Atomics.notify(t, 0);
  await done;
  await Promise.all(workers.map((w) => w.terminate()));
  const vesselSeconds = count * REGIMES.length * ticks * (TICK_MS / 1000);
  const cpuSeconds = (cpu.user + cpu.system) / 1e6;
  const perThread = reports
    .sort((a, b) => a.index - b.index)
    .map((r) => ({ thread: r.index, ticks: r.ticks, p50us: Math.round(pct(r.stepUs, 0.5)), p99us: Math.round(pct(r.stepUs, 0.99)), maxUs: Math.round(Math.max(...r.stepUs)), overrunTicks: r.stepUs.filter((u) => u > TICK_MS * 1000).length }));
  const row = {
    workers: count,
    seconds: wall,
    ticks,
    perThread,
    p50us: Math.round(pct(reports.flatMap((r) => r.stepUs), 0.5)),
    p99us: Math.round(pct(reports.flatMap((r) => r.stepUs), 0.99)),
    cpuSeconds,
    vesselSeconds,
    vcpuSecondsPerVesselSecond: cpuSeconds / vesselSeconds,
    utilisationPerThread: perThread.map((p) => p.p50us / (TICK_MS * 1000)),
  };
  ctx.log.info('derating-level', row);
  return row;
}

const deratingRole: RoleModule = {
  kind: 'job',
  async start(ctx: RoleContext): Promise<RoleHandle & { done: Promise<number> }> {
    const opts = {
      defsDir: ctx.env.BENCH_DEFS_DIR ?? '/app/client/defs',
      tilesDir: ctx.env.BENCH_TILES_DIR ?? null,
      packList: ctx.env.BENCH_PACK_LIST ?? null,
    };
    if (!opts.tilesDir && !opts.packList) throw new Error('derating: BENCH_PACK_LIST (a pack list URL) or BENCH_TILES_DIR is needed');
    const counts = (ctx.env.BENCH_WORKERS ?? '1,2,4,8').split(',').map(Number);
    const seconds = Number(ctx.env.BENCH_SECONDS ?? 30);
    const done = (async (): Promise<number> => {
      const machine = { cpus: os.cpus().length, model: os.cpus()[0]?.model ?? 'unknown', memGb: os.totalmem() / 1024 ** 3, node: process.version, railway: ctx.env.RAILWAY_REPLICA_ID ? 'yes' : 'no' };
      // Idle: the process with no worker (BENCH_IDLE_S, default 20 s).
      const idleS = Number(ctx.env.BENCH_IDLE_S ?? 20);
      const c0 = process.cpuUsage();
      await new Promise((r) => setTimeout(r, idleS * 1000));
      const c1 = process.cpuUsage(c0);
      const idleVcpu = (c1.user + c1.system) / 1e6 / idleS;
      const levels = [];
      for (const n of counts) levels.push(await runLevel(ctx, n, seconds, opts));
      ctx.log.info('derating-result', { machine, regimes: REGIMES.map((r) => r.name), idleVcpu, levels });
      return 0;
    })();
    return { done, health: () => ({ ok: true }), drain: async () => undefined };
  },
};

export default deratingRole;
