/**
 * Headless flight loop (docs/research/sim-design.md 4.3) under the terrain protocol of the Sim contract:
 *
 *   await sim.ready
 *   loop:  await sim.terrainPending() while it is non-null
 *          every CONTROL_TICK_STEPS-th physics step, and before every rails advance:
 *              controls = pilot.update(sim.peek(), commands, dt);  sim.setControls(controls)
 *          sim.needsIntegration or physics warp ?  sim.step()
 *                                                :  sim.advanceRails(min(sim.nextEventUt, ut + warpFactor / 60))
 *
 * Only `ready`, `terrainPending`, `peek`, `setControls`, `commands`, `step`, `advanceRails`,
 * `needsIntegration` and `nextEventUt` of the Sim are used. Every control input and command is recorded
 * in an input log that `replayHeadless` feeds back through the same loop: the replayed run reproduces the
 * state hash of the original.
 */
import { NEUTRAL_CONTROLS, type CommandResult, type ControlInputs, type NavballMode, type NodeEdit, type Pilot, type PlayerCommands, type SasMode } from '@/core/contracts/controls';
import { MAX_PHYSICS_WARP_INDEX, PHYSICS_DT, WARP_LEVELS } from '@/core/contracts/defs';
import { CONTROL_TICK_STEPS, type Sim, type SimSnapshot } from '@/core/contracts/sim';

/** Real-time frame the rails quantum mirrors (the browser's 60 Hz). */
export const RAILS_FRAME = 1 / 60;

export type LoggedCommand =
  | { name: 'stage' | 'abort' | 'toggleLegs' | 'toggleLights' }
  | { name: 'setSasEnabled' | 'setRcsEnabled' | 'setFineControl'; on: boolean }
  | { name: 'setSasMode'; mode: SasMode }
  | { name: 'setNavballMode'; mode: NavballMode }
  | { name: 'setWarpLevel'; index: number }
  | { name: 'addNode'; ut: number }
  | { name: 'setNode'; id: string; edit: NodeEdit }
  | { name: 'removeNode'; id: string }
  | { name: 'setTarget'; bodyId: string | null }
  | { name: 'cycleActiveVessel'; direction: 1 | -1 };

/** One control tick at which the pilot changed something: its ordinal, the commands issued, the controls set. */
export interface InputLogEntry {
  tick: number;
  ut: number;
  commands: LoggedCommand[];
  /** Present when the controls differ from the previous tick's. */
  controls?: ControlInputs;
}

export type StopReason = 'done' | 'pilotFailure' | 'missionFailed' | 'cheat' | 'nan' | 'simTimeLimit' | 'tickLimit' | 'until' | 'logEnd';

export interface RunStats {
  /** Control ticks, physics steps and rails advances of the run. */
  ticks: number;
  steps: number;
  railsAdvances: number;
  /** Longest single physics step, ms (0 without a clock). */
  maxStepMs: number;
  /** Total wall time inside sim.step(), ms (0 without a clock). */
  stepMs: number;
}

export interface RunContext {
  sim: Sim;
  stats: RunStats;
  /** Longest physics step in the last `seconds` of simulation time, ms (needs `clock`). */
  recentMaxStepMs(seconds: number): number;
  /** Wall time of every physics step in the last `seconds` of simulation time, oldest first, ms (needs `clock`). */
  recentStepMs(seconds: number): Float32Array;
}

export interface RunOptions {
  /** Stop once this much simulation time has passed since the start, s (default 14 days). */
  maxSimTime?: number;
  maxTicks?: number;
  /** Stop predicate, evaluated at every control tick before the pilot acts. */
  until?: (snapshot: SimSnapshot, ctx: RunContext) => boolean;
  /** Observer, called at every control tick after the pilot acted. */
  onTick?: (snapshot: SimSnapshot, ctx: RunContext) => void;
  /** Wall clock in ms (e.g. performance.now); enables the step timings. The loop never reads a clock itself. */
  clock?: () => number;
  /** false = do not wait for terrain (terrain-protocol tests only). */
  awaitTerrain?: boolean;
  /** Record the input log (default true). */
  record?: boolean;
}

export interface RunResult {
  reason: StopReason;
  /** Pilot failure text or the mission failure reason. */
  failure: string | null;
  simTime: number;
  finalUt: number;
  stats: RunStats;
  inputLog: InputLogEntry[];
  /** The last snapshot the loop looked at. */
  last: SimSnapshot;
}

const sameControls = (a: ControlInputs, b: ControlInputs): boolean =>
  a.pitch === b.pitch && a.yaw === b.yaw && a.roll === b.roll && a.throttle === b.throttle && a.translate.x === b.translate.x && a.translate.y === b.translate.y && a.translate.z === b.translate.z;

const copyControls = (c: ControlInputs): ControlInputs => ({ pitch: c.pitch, yaw: c.yaw, roll: c.roll, throttle: c.throttle, translate: { x: c.translate.x, y: c.translate.y, z: c.translate.z } });

const anyInput = (c: ControlInputs): boolean => c.throttle > 0 || c.pitch !== 0 || c.yaw !== 0 || c.roll !== 0 || c.translate.x !== 0 || c.translate.y !== 0 || c.translate.z !== 0;

/** PlayerCommands that pass every call on and note it down. */
function recordingCommands(target: PlayerCommands, sink: LoggedCommand[]): PlayerCommands {
  const note = <T>(entry: LoggedCommand, result: T): T => {
    sink.push(entry);
    return result;
  };
  return {
    stage: (): CommandResult => note({ name: 'stage' }, target.stage()),
    abort: (): CommandResult => note({ name: 'abort' }, target.abort()),
    setSasEnabled: (on: boolean): CommandResult => note({ name: 'setSasEnabled', on }, target.setSasEnabled(on)),
    setSasMode: (mode: SasMode): CommandResult => note({ name: 'setSasMode', mode }, target.setSasMode(mode)),
    setRcsEnabled: (on: boolean): CommandResult => note({ name: 'setRcsEnabled', on }, target.setRcsEnabled(on)),
    toggleLegs: (): CommandResult => note({ name: 'toggleLegs' }, target.toggleLegs()),
    toggleLights: (): CommandResult => note({ name: 'toggleLights' }, target.toggleLights()),
    setFineControl: (on: boolean): CommandResult => note({ name: 'setFineControl', on }, target.setFineControl(on)),
    setNavballMode: (mode: NavballMode): CommandResult => note({ name: 'setNavballMode', mode }, target.setNavballMode(mode)),
    setWarpLevel: (index: number): CommandResult => note({ name: 'setWarpLevel', index }, target.setWarpLevel(index)),
    addNode: (ut: number): string => note({ name: 'addNode', ut }, target.addNode(ut)),
    setNode: (id: string, edit: NodeEdit): CommandResult => note({ name: 'setNode', id, edit: { ...edit, ...(edit.dv ? { dv: { ...edit.dv } } : {}) } }, target.setNode(id, edit)),
    removeNode: (id: string): CommandResult => note({ name: 'removeNode', id }, target.removeNode(id)),
    setTarget: (bodyId: string | null): CommandResult => note({ name: 'setTarget', bodyId }, target.setTarget(bodyId)),
    cycleActiveVessel: (direction: 1 | -1): CommandResult => note({ name: 'cycleActiveVessel', direction }, target.cycleActiveVessel(direction)),
  };
}

function applyLogged(commands: PlayerCommands, c: LoggedCommand): void {
  switch (c.name) {
    case 'stage':
      commands.stage();
      break;
    case 'abort':
      commands.abort();
      break;
    case 'toggleLegs':
      commands.toggleLegs();
      break;
    case 'toggleLights':
      commands.toggleLights();
      break;
    case 'setSasEnabled':
      commands.setSasEnabled(c.on);
      break;
    case 'setRcsEnabled':
      commands.setRcsEnabled(c.on);
      break;
    case 'setFineControl':
      commands.setFineControl(c.on);
      break;
    case 'setSasMode':
      commands.setSasMode(c.mode);
      break;
    case 'setNavballMode':
      commands.setNavballMode(c.mode);
      break;
    case 'setWarpLevel':
      commands.setWarpLevel(c.index);
      break;
    case 'addNode':
      commands.addNode(c.ut);
      break;
    case 'setNode':
      commands.setNode(c.id, c.edit);
      break;
    case 'removeNode':
      commands.removeNode(c.id);
      break;
    case 'setTarget':
      commands.setTarget(c.bodyId);
      break;
    case 'cycleActiveVessel':
      commands.cycleActiveVessel(c.direction);
      break;
  }
}

function stateIsFinite(s: SimSnapshot): boolean {
  if (!Number.isFinite(s.ut)) return false;
  for (const v of s.vessels) {
    if (v.id !== s.activeVesselId) continue;
    const ok = Number.isFinite(v.r.x + v.r.y + v.r.z + v.v.x + v.v.y + v.v.z + v.q.x + v.q.y + v.q.z + v.q.w + v.w.x + v.w.y + v.w.z + v.mass);
    if (!ok) return false;
  }
  return Number.isFinite(s.readouts.altitudeAsl + s.readouts.speedOrbital);
}

/** What acts at a control tick: the pilot, or a recorded log. */
interface Driver {
  act(snapshot: SimSnapshot, tick: number, dt: number, commands: PlayerCommands): { controls: ControlInputs; done: boolean; failure: string | null; logEnd: boolean };
}

const STEP_RING = 16384;

async function runLoop(sim: Sim, driver: Driver, opts: RunOptions, log: InputLogEntry[] | null): Promise<RunResult> {
  await sim.ready;
  const awaitTerrain = opts.awaitTerrain !== false;
  const maxSimTime = opts.maxSimTime ?? 14 * 86400;
  const maxTicks = opts.maxTicks ?? Infinity;
  const clock = opts.clock;
  const stats: RunStats = { ticks: 0, steps: 0, railsAdvances: 0, maxStepMs: 0, stepMs: 0 };
  const ringMs = clock ? new Float32Array(STEP_RING) : null;
  const ringUt = clock ? new Float64Array(STEP_RING) : null;
  let ringHead = 0;
  let ringCount = 0;
  let lastUt = 0;
  const ctx: RunContext = {
    sim,
    stats,
    recentMaxStepMs: (seconds: number): number => {
      if (!ringMs || !ringUt) return 0;
      let m = 0;
      for (let i = 0; i < ringCount; i++) {
        const k = (ringHead - 1 - i + STEP_RING) % STEP_RING;
        if (ringUt[k]! < lastUt - seconds) break;
        if (ringMs[k]! > m) m = ringMs[k]!;
      }
      return m;
    },
    recentStepMs: (seconds: number): Float32Array => {
      if (!ringMs || !ringUt) return new Float32Array(0);
      let n = 0;
      while (n < ringCount && ringUt[(ringHead - 1 - n + STEP_RING) % STEP_RING]! >= lastUt - seconds) n++;
      const out = new Float32Array(n);
      for (let i = 0; i < n; i++) out[n - 1 - i] = ringMs[(ringHead - 1 - i + STEP_RING) % STEP_RING]!;
      return out;
    },
  };
  const issued: LoggedCommand[] = [];
  const commands = recordingCommands(sim.commands, issued);
  let controls = copyControls(NEUTRAL_CONTROLS);
  let sinceControl = 0;
  let snapshot = sim.peek();
  const startUt = snapshot.simUt;
  let prevTickUt = startUt;
  let warpIndex = snapshot.warp.index;
  let reason: StopReason | null = null;
  let failure: string | null = null;

  while (reason === null) {
    if (awaitTerrain) {
      for (let p = sim.terrainPending(); p !== null; p = sim.terrainPending()) await p;
    }
    if (sinceControl % CONTROL_TICK_STEPS === 0) {
      snapshot = sim.peek();
      lastUt = snapshot.simUt;
      warpIndex = snapshot.warp.index;
      if (!stateIsFinite(snapshot)) reason = 'nan';
      else if (snapshot.cheatCounter > 0) reason = 'cheat';
      else if (snapshot.mission.failed) {
        reason = 'missionFailed';
        failure = snapshot.mission.failureReason;
      } else if (snapshot.simUt - startUt > maxSimTime) reason = 'simTimeLimit';
      else if (stats.ticks >= maxTicks) reason = 'tickLimit';
      else if (opts.until && opts.until(snapshot, ctx)) reason = 'until';
      if (reason !== null) break;
      issued.length = 0;
      const res = driver.act(snapshot, stats.ticks, snapshot.simUt - prevTickUt, commands);
      prevTickUt = snapshot.simUt;
      const changed = !sameControls(res.controls, controls);
      if (changed) {
        controls = copyControls(res.controls);
        sim.setControls(controls);
      }
      if (log && (issued.length > 0 || changed)) {
        const entry: InputLogEntry = { tick: stats.ticks, ut: snapshot.simUt, commands: issued.slice() };
        if (changed) entry.controls = copyControls(controls);
        log.push(entry);
      }
      stats.ticks++;
      if (issued.length > 0) {
        snapshot = sim.peek();
        warpIndex = snapshot.warp.index;
      } else if (changed && anyInput(controls) && warpIndex > MAX_PHYSICS_WARP_INDEX) warpIndex = 0;
      opts.onTick?.(snapshot, ctx);
      if (res.failure !== null) {
        reason = 'pilotFailure';
        failure = res.failure;
      } else if (res.done) reason = 'done';
      else if (res.logEnd) reason = 'logEnd';
      if (reason !== null) break;
    }
    if (sim.needsIntegration || warpIndex <= MAX_PHYSICS_WARP_INDEX) {
      if (clock) {
        const t0 = clock();
        sim.step();
        const ms = clock() - t0;
        stats.stepMs += ms;
        if (ms > stats.maxStepMs) stats.maxStepMs = ms;
        lastUt += PHYSICS_DT;
        ringMs![ringHead] = ms;
        ringUt![ringHead] = lastUt;
        ringHead = (ringHead + 1) % STEP_RING;
        if (ringCount < STEP_RING) ringCount++;
      } else sim.step();
      stats.steps++;
      sinceControl++;
    } else {
      const ut = snapshot.simUt;
      const target = Math.min(sim.nextEventUt, ut + WARP_LEVELS[warpIndex]! * RAILS_FRAME);
      const reached = sim.advanceRails(target);
      if (reached > ut) {
        stats.railsAdvances++;
        sinceControl = 0;
      } else {
        // An event is due (the sim has stepped warp down): one physics step moves time on.
        sim.step();
        stats.steps++;
        sinceControl++;
      }
    }
  }
  const last = sim.peek();
  return { reason, failure, simTime: last.simUt - startUt, finalUt: last.simUt, stats, inputLog: log ?? [], last };
}

/**
 * Fly `pilot` on `sim` until the pilot is done or gives up, the mission fails, a debug API is used, the
 * state stops being finite, or a limit of `opts` is reached.
 */
export function runHeadless(sim: Sim, pilot: Pilot, opts: RunOptions = {}): Promise<RunResult> {
  const driver: Driver = {
    act: (snapshot, _tick, dt, commands) => {
      const controls = pilot.update(snapshot, commands, dt);
      return { controls, done: pilot.done, failure: pilot.failure, logEnd: false };
    },
  };
  return runLoop(sim, driver, opts, opts.record === false ? null : []);
}

/**
 * Feed a recorded input log through the same loop on a fresh Sim of the same scenario. With the same
 * terrain protocol the replay passes through the same states as the original run; it ends after the last
 * recorded tick (`ticks` of the original run, when given) or when a limit of `opts` is reached.
 */
export function replayHeadless(sim: Sim, inputLog: readonly InputLogEntry[], opts: RunOptions & { ticks?: number } = {}): Promise<RunResult> {
  let next = 0;
  let controls = copyControls(NEUTRAL_CONTROLS);
  const lastTick = opts.ticks !== undefined ? opts.ticks - 1 : inputLog.length > 0 ? inputLog[inputLog.length - 1]!.tick : -1;
  const driver: Driver = {
    act: (_snapshot, tick, _dt, commands) => {
      const entry = inputLog[next];
      if (entry && entry.tick === tick) {
        next++;
        for (const c of entry.commands) applyLogged(commands, c);
        if (entry.controls) controls = copyControls(entry.controls);
      }
      return { controls, done: false, failure: null, logEnd: tick >= lastTick };
    },
  };
  return runLoop(sim, driver, { ...opts, record: false }, null);
}
