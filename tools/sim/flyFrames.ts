/**
 * Fly a scenario the way the browser does: `Sim.advance(1/60, onControlTick)` once per frame with the
 * scripted pilot acting in the control ticks, a `snapshot()` per frame (which drains the event queue), on
 * the real baked terrain. Prints how many 60 Hz frames - minutes of real time - each phase of the flight
 * takes at the pilot's warp choices, which is what the browser mission run (docs/ARCHITECTURE.md 18.2)
 * will take on the wall clock.
 *
 *   node tools/dev/heavy.mjs --class=cpu -- npx tsx tools/sim/flyFrames.ts [--scenario lunar-direct] [--no-await]
 *
 * By default the loop awaits `terrainPending()` before every frame (the reproducible protocol); with
 * --no-await it only yields to the event loop, as a browser does.
 */
import path from 'node:path';
import type { MilestoneRecord, SimSnapshot } from '@/core/contracts/sim';
import { createMissionPilot, type MissionPilotOptions } from '@/pilot';
import { createSim, type SimWorld } from '@/sim';
import { createRealTerrain, loadLibrary } from './realWorld';

export const FRAME_SECONDS = 1 / 60;

export interface PhasePacing {
  phase: string;
  frames: number;
  /** Physics steps run in those frames. */
  steps: number;
  /** Simulation time covered, s. */
  simTime: number;
}

export interface FramesFlight {
  sim: SimWorld;
  done: boolean;
  failure: string | null;
  frames: number;
  /** frames / 60 / 60: minutes of real time at 60 Hz. */
  realMinutes: number;
  ticks: number;
  wallSeconds: number;
  phases: PhasePacing[];
  milestones: MilestoneRecord[];
  last: SimSnapshot;
  report: Record<string, number>;
}

export interface FramesOptions {
  scenario?: string;
  awaitTerrain?: boolean;
  maxFrames?: number;
  pilot?: MissionPilotOptions;
}

export async function flyFrames(opts: FramesOptions = {}): Promise<FramesFlight> {
  const defs = await loadLibrary();
  const sim = createSim(defs, opts.scenario ?? 'lunar-direct', { terrain: await createRealTerrain(defs) });
  const pilot = createMissionPilot(defs, sim.scenario, opts.pilot ?? {});
  await sim.ready;
  const awaitTerrain = opts.awaitTerrain !== false;
  const maxFrames = opts.maxFrames ?? 60 * 3600 * 3;
  let prevUt = sim.peek().simUt;
  let stop = false;
  let ticks = 0;
  const onControlTick = (): void => {
    if (stop) return;
    const s = sim.peek();
    sim.setControls(pilot.update(s, sim.commands, s.simUt - prevUt));
    prevUt = s.simUt;
    ticks++;
    if (pilot.done || pilot.failure !== null || s.mission.failed || s.cheatCounter > 0) stop = true;
  };
  const perPhase = new Map<string, PhasePacing>();
  let frames = 0;
  const t0 = performance.now();
  while (!stop && frames < maxFrames) {
    if (awaitTerrain) for (let p = sim.terrainPending(); p !== null; p = sim.terrainPending()) await p;
    else if (frames % 2 === 0) await new Promise<void>((resolve) => setImmediate(resolve));
    const stepsBefore = sim.stats().steps;
    const utBefore = sim.peek().simUt;
    sim.advance(FRAME_SECONDS, onControlTick);
    // One presentation per frame, as the app does.
    sim.snapshot();
    frames++;
    // A maneuver's stages ("tli:align", "tli:burn"...) are counted under the maneuver.
    const key = pilot.phase;
    let e = perPhase.get(key);
    if (!e) {
      e = { phase: key, frames: 0, steps: 0, simTime: 0 };
      perPhase.set(key, e);
    }
    e.frames++;
    e.steps += sim.stats().steps - stepsBefore;
    e.simTime += sim.peek().simUt - utBefore;
  }
  const last = sim.peek();
  return {
    sim,
    done: pilot.done,
    failure: pilot.failure ?? (last.mission.failed ? last.mission.failureReason : null),
    frames,
    realMinutes: frames / 3600,
    ticks,
    wallSeconds: (performance.now() - t0) / 1000,
    phases: [...perPhase.values()].sort((x, y) => y.frames - x.frames),
    milestones: last.milestones,
    last,
    report: pilot.report,
  };
}

const invokedDirectly = process.argv[1] !== undefined && path.resolve(process.argv[1]).replace(/\\/g, '/').endsWith('tools/sim/flyFrames.ts');
if (invokedDirectly) {
  const i = process.argv.indexOf('--scenario');
  const o: FramesOptions = { awaitTerrain: !process.argv.includes('--no-await') };
  if (i >= 0 && process.argv[i + 1] !== undefined) o.scenario = process.argv[i + 1]!;
  const f = await flyFrames(o);
  console.log(`${f.done ? 'done' : `stopped (${f.failure ?? 'frame limit'})`}: ${f.frames} frames = ${f.realMinutes.toFixed(1)} min of real time at 60 Hz; ${f.ticks} control ticks; ${f.wallSeconds.toFixed(1)} s of wall clock here`);
  console.log(`milestones: ${f.milestones.map((m) => m.id).join(' ')}`);
  console.log(`terrain: incompleteQueries ${f.last.terrain.incompleteQueries}; ${JSON.stringify(f.sim.stats())}`);
  console.log('phase                        real min   sim time     steps/frame');
  for (const p of f.phases.filter((x) => x.frames >= 600)) {
    const sim = p.simTime > 7200 ? `${(p.simTime / 3600).toFixed(1)} h` : `${p.simTime.toFixed(0)} s`;
    console.log(`${p.phase.padEnd(28)} ${(p.frames / 3600).toFixed(1).padStart(8)}   ${sim.padStart(10)}   ${(p.steps / p.frames).toFixed(2).padStart(8)}`);
  }
  const rest = f.phases.filter((x) => x.frames < 600).reduce((n, x) => n + x.frames, 0);
  console.log(`${'(shorter phases)'.padEnd(28)} ${(rest / 3600).toFixed(1).padStart(8)}`);
}
