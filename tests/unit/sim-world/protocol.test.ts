/**
 * The terrain protocol of the Sim contract and the replay of an input log, on the real baked tiles with
 * the scripted pilot flying short legs of the mission (the QA starts):
 *
 *  - a run that awaits `terrainPending()` ends in the same state whether the tile I/O answers at once or
 *    late and out of order;
 *  - a run that does not await is DETECTED (`terrain.incompleteQueries`, the warp clamp), never a crash;
 *  - feeding the recorded input log to a fresh Sim reproduces the state hash.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { DefLibrary } from '@/core/contracts/defs';
import type { SimSnapshot } from '@/core/contracts/sim';
import { createMissionPilot, replayHeadless, runHeadless, type RunResult } from '@/pilot';
import { openSession, type DiagnosedSession } from '../../../tools/sim/realWorld';
import { createRealTerrain, delayedSource } from '../../../tools/sim/realWorld';
import { active, controls, loadLibrary, stepUntil } from './helpers';

let defs: DefLibrary;
beforeAll(async () => {
  defs = await loadLibrary();
});

interface Leg {
  sim: DiagnosedSession;
  run: RunResult;
  hash: string;
  reads: number;
}

/** Fly a QA start with the pilot until `until` holds (or the pilot is done). */
async function flyLeg(scenario: string, until: (s: SimSnapshot) => boolean, opts: { delayed?: boolean; awaitTerrain?: boolean; maxSimTime?: number } = {}): Promise<Leg> {
  let delayed: ReturnType<typeof delayedSource> | null = null;
  const terrain = await createRealTerrain(defs, opts.delayed ? { wrapSource: (source) => (delayed = delayedSource(source)) } : {});
  const sim = openSession(defs, scenario, { terrain });
  const pilot = createMissionPilot(defs, sim.scenario);
  const run = await runHeadless(sim, pilot, { until, maxSimTime: opts.maxSimTime ?? 3 * 3600, ...(opts.awaitTerrain === false ? { awaitTerrain: false } : {}) });
  // (TypeScript cannot see the assignment inside the callback.)
  const reads = (delayed as ReturnType<typeof delayedSource> | null)?.reads ?? 0;
  return { sim, run, hash: sim.stateHash(), reads };
}

/** Landed on the Moon and at rest for ten seconds. */
const landedForTenSeconds = (): ((s: SimSnapshot) => boolean) => {
  let since = NaN;
  return (s) => {
    const v = active(s);
    if (v.bodyId !== 'moon' || v.situation !== 'landed') {
      since = NaN;
      return false;
    }
    if (Number.isNaN(since)) since = s.simUt;
    return s.simUt - since >= 10;
  };
};

describe('terrain protocol', () => {
  it('powered descent to the lunar surface: the same state with prompt and with late tile I/O', async () => {
    const prompt = await flyLeg('qa-powered-descent', landedForTenSeconds());
    const late = await flyLeg('qa-powered-descent', landedForTenSeconds(), { delayed: true });
    expect(prompt.run.reason).toBe('until');
    expect(late.run.reason).toBe('until');
    expect(late.reads).toBeGreaterThan(50);
    for (const leg of [prompt, late]) {
      const s = leg.run.last;
      expect(s.terrain.incompleteQueries).toBe(0);
      expect(s.terrain.complete).toBe(true);
      expect(leg.sim.stats().terrainWarpClamps).toBe(0);
      expect(s.readouts.landingTarget!.distance).toBeLessThan(1500);
      expect(s.mission.failed).toBe(false);
    }
    expect(late.run.stats.steps).toBe(prompt.run.stats.steps);
    expect(late.run.stats.ticks).toBe(prompt.run.stats.ticks);
    expect(late.run.finalUt).toBe(prompt.run.finalUt);
    expect(late.hash).toBe(prompt.hash);
    // The descent really used the deep data: the sim asked for it again and again on the way down.
    expect(prompt.sim.stats().terrainRequests).toBeGreaterThan(20);
  }, 120_000);

  it('entry to splashdown: the same state with prompt and with late tile I/O', async () => {
    const prompt = await flyLeg('qa-entry', () => false);
    const late = await flyLeg('qa-entry', () => false, { delayed: true });
    expect(prompt.run.reason).toBe('done');
    expect(late.run.reason).toBe('done');
    expect(late.reads).toBeGreaterThan(20);
    expect(prompt.run.last.terrain.incompleteQueries).toBe(0);
    expect(late.run.last.terrain.incompleteQueries).toBe(0);
    expect(active(prompt.run.last).situation).toBe('splashed');
    expect(late.run.stats.steps).toBe(prompt.run.stats.steps);
    expect(late.hash).toBe(prompt.hash);
  }, 120_000);

  it('a run that does not await the terrain is detected - counted queries, the warp clamp -, not crashed', async () => {
    // Nothing ever yields to the tile I/O: the data for the descent never arrives. Down to 450 m above the ground.
    const leg = await flyLeg('qa-powered-descent', (s) => active(s).bodyId === 'moon' && active(s).situation !== 'landed' && s.readouts.altitudeRadar < 450, { awaitTerrain: false, maxSimTime: 2400 });
    expect(leg.run.reason).toBe('until');
    const sim = leg.sim;
    const s = leg.run.last;
    // Detected: the queries on unfinished data were counted, and the snapshot says the data is not final.
    expect(s.terrain.incompleteQueries).toBeGreaterThan(0);
    expect(s.terrain.complete).toBe(false);
    expect(s.terrain.pending).toBe(true);
    const v = active(s);
    for (const x of [v.r.x, v.r.y, v.r.z, v.v.x, v.v.y, v.v.z, v.q.w, s.readouts.altitudeRadar, s.readouts.altitudeAsl]) expect(Number.isFinite(x)).toBe(true);
    // Physics warp is still to be had above 300 m ...
    sim.setControls(controls());
    sim.commands.setWarpLevel(2);
    expect(sim.peek().warp.index).toBe(2);
    expect(sim.stats().terrainWarpClamps).toBe(0);
    // ... and is taken away on the way down through 300 m, because the ground below is not final.
    expect(stepUntil(sim, (x) => x.readouts.altitudeRadar < 298, 120 * 120)).toBeGreaterThan(0);
    let w = sim.peek().warp;
    expect(w.index).toBe(0);
    expect(w.maxIndex).toBe(0);
    expect(w.limitedBy).toBe('Terrain data loading');
    expect(sim.stats().terrainWarpClamps).toBe(1);
    sim.commands.setWarpLevel(1);
    expect(sim.peek().warp.index).toBe(0);
    expect(sim.peek().events.some((e) => e.type === 'warpChanged' && e.index === 0 && e.reason === 'Terrain data loading')).toBe(true);
    // Under the protocol again: once awaited, the data is final and the clamp is gone.
    for (let p = sim.terrainPending(); p !== null; p = sim.terrainPending()) await p;
    sim.step();
    for (let p = sim.terrainPending(); p !== null; p = sim.terrainPending()) await p;
    const after = sim.peek();
    expect(after.terrain.complete).toBe(true);
    expect(after.terrain.pending).toBe(false);
    expect(after.readouts.altitudeRadar).toBeGreaterThan(100);
    sim.commands.setWarpLevel(1);
    w = sim.peek().warp;
    expect(w.index).toBe(1);
    expect(w.limitedBy).not.toBe('Terrain data loading');
  }, 120_000);
});

describe('replay', () => {
  it('the recorded input log of a flown leg reproduces the state hash on a fresh Sim', async () => {
    const terrain = await createRealTerrain(defs);
    const sim = openSession(defs, 'qa-entry', { terrain });
    const pilot = createMissionPilot(defs, sim.scenario);
    const flown = await runHeadless(sim, pilot, { maxSimTime: 3 * 3600 });
    expect(flown.reason).toBe('done');
    expect(flown.inputLog.length).toBeGreaterThan(50);
    expect(flown.inputLog.some((e) => e.commands.some((c) => c.name === 'stage'))).toBe(true);
    expect(flown.inputLog.some((e) => e.controls !== undefined && e.controls.roll !== 0)).toBe(true);
    // The log is plain data: it survives a round trip through JSON.
    const log = JSON.parse(JSON.stringify(flown.inputLog)) as typeof flown.inputLog;
    const again = openSession(defs, 'qa-entry', { terrain: await createRealTerrain(defs) });
    const replayed = await replayHeadless(again, log, { ticks: flown.stats.ticks, maxSimTime: 3 * 3600 });
    expect(replayed.reason).toBe('logEnd');
    expect(replayed.stats.steps).toBe(flown.stats.steps);
    expect(replayed.stats.railsAdvances).toBe(flown.stats.railsAdvances);
    expect(replayed.finalUt).toBe(flown.finalUt);
    expect(again.stateHash()).toBe(sim.stateHash());
    // A log with one input changed ends somewhere else.
    const changed = log.map((e) => ({ ...e, commands: e.commands.slice() }));
    const firstRoll = changed.find((e) => e.controls !== undefined && e.controls.roll !== 0)!;
    firstRoll.controls = { ...firstRoll.controls!, roll: -firstRoll.controls!.roll };
    const other = openSession(defs, 'qa-entry', { terrain: await createRealTerrain(defs) });
    await replayHeadless(other, changed, { ticks: flown.stats.ticks, maxSimTime: 3 * 3600 });
    expect(other.stateHash()).not.toBe(sim.stateHash());
  }, 120_000);
});
