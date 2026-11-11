/**
 * The browser entry point with the scripted pilot (docs/ARCHITECTURE.md 18.2): `Sim.advance(realDt,
 * onControlTick)` gives the pilot the same 30 Hz cadence of simulation time as the headless loop, so the
 * same pilot flies the same leg to the same state through either door - and still brings the capsule
 * home when the frames do not wait for the terrain (the browser never does).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { DefLibrary } from '@/core/contracts/defs';
import { createMissionPilot, runHeadless } from '@/pilot';
import { createSim, type SimWorld } from '@/sim';
import { active, createRealTerrain, loadLibrary, settleTerrain } from './helpers';

let defs: DefLibrary;
beforeAll(async () => {
  defs = await loadLibrary();
});

const FRAME = 1 / 60;

interface FramesResult {
  sim: SimWorld;
  /** State hash when the pilot's control tick number `stopTick` came up (before it acted). */
  hashAtStop: string | null;
  ticks: number;
  frames: number;
  done: boolean;
}

/** Drive the pilot through advance() in 60 Hz frames. `awaitTerrain` = the reproducible protocol; false = a browser. */
async function flyFrames(scenario: string, opts: { stopTick?: number; awaitTerrain: boolean; maxFrames: number }): Promise<FramesResult> {
  const sim = createSim(defs, scenario, { terrain: await createRealTerrain(defs) });
  const pilot = createMissionPilot(defs, sim.scenario);
  await sim.ready;
  let ticks = 0;
  let prevUt = sim.peek().simUt;
  let hashAtStop: string | null = null;
  let stop = false;
  const onControlTick = (): void => {
    if (stop) return;
    if (opts.stopTick !== undefined && ticks === opts.stopTick) {
      hashAtStop = sim.stateHash();
      stop = true;
      return;
    }
    const s = sim.peek();
    sim.setControls(pilot.update(s, sim.commands, s.simUt - prevUt));
    prevUt = s.simUt;
    ticks++;
    if (pilot.done || pilot.failure !== null) stop = true;
  };
  let frames = 0;
  while (!stop && frames < opts.maxFrames) {
    if (opts.awaitTerrain) await settleTerrain(sim);
    else if (frames % 4 === 0) await new Promise<void>((resolve) => setImmediate(resolve));
    sim.advance(FRAME, onControlTick);
    // The app presents every frame: the snapshot drains the event queue and never changes the state.
    sim.snapshot();
    frames++;
  }
  expect(pilot.failure).toBeNull();
  return { sim, hashAtStop, ticks, frames, done: pilot.done };
}

describe('the pilot through Sim.advance', () => {
  it('under drogues to the water: the same state as the headless loop after the same control ticks', async () => {
    const TICKS = 9000;
    const headless = createSim(defs, 'qa-drogues', { terrain: await createRealTerrain(defs) });
    const run = await runHeadless(headless, createMissionPilot(defs, headless.scenario), { maxTicks: TICKS });
    expect(run.reason).toBe('tickLimit');
    expect(run.stats.steps).toBe(TICKS * 4);
    const frames = await flyFrames('qa-drogues', { stopTick: TICKS, awaitTerrain: true, maxFrames: 60 * 600 });
    expect(frames.ticks).toBe(TICKS);
    expect(frames.hashAtStop).toBe(headless.stateHash());
    // Nine thousand ticks are five minutes of flight: the mains are out by then.
    expect(headless.peek().staging.nextStage).toBe(10);
  }, 120_000);

  it('from the entry coast (rails warp, then the atmosphere) to the water: the same flight as the headless loop', async () => {
    // On rails the two loops cut time into different pieces (a frame of real time times the warp factor here,
    // the runner's own quantum there), so the states are no longer bit-identical - the flight is the same.
    const headless = createSim(defs, 'qa-entry', { terrain: await createRealTerrain(defs) });
    const run = await runHeadless(headless, createMissionPilot(defs, headless.scenario), {});
    expect(run.reason).toBe('done');
    expect(run.stats.railsAdvances).toBeGreaterThan(100);
    const frames = await flyFrames('qa-entry', { awaitTerrain: true, maxFrames: 60 * 3600 });
    expect(frames.done).toBe(true);
    const a = headless.peek();
    const b = frames.sim.peek();
    expect(active(b).situation).toBe('splashed');
    expect(b.mission.failed).toBe(false);
    expect(b.terrain.incompleteQueries).toBe(0);
    expect(b.staging.nextStage).toBe(a.staging.nextStage);
    // Same splash point within a few kilometres, same time within seconds, same propellant within a per cent.
    const R = 6371000;
    const dLat = (b.readouts.latitude - a.readouts.latitude) * R;
    const dLon = (b.readouts.longitude - a.readouts.longitude) * R * Math.cos(a.readouts.latitude);
    expect(Math.hypot(dLat, dLon)).toBeLessThan(5000);
    expect(Math.abs(b.simUt - a.simUt)).toBeLessThan(10);
    expect(Math.abs(b.readouts.rcsFraction! - a.readouts.rcsFraction!)).toBeLessThan(0.02);
    expect(Math.abs(b.readouts.ablatorFraction! - a.readouts.ablatorFraction!)).toBeLessThan(0.01);
  }, 120_000);

  it('frames that never wait for the terrain still bring the capsule down alive', async () => {
    const frames = await flyFrames('qa-drogues', { awaitTerrain: false, maxFrames: 60 * 900 });
    expect(frames.done).toBe(true);
    const s = frames.sim.peek();
    expect(active(s).situation).toBe('splashed');
    expect(s.mission.failed).toBe(false);
    expect(s.mission.crewAlive).toBe(true);
    expect(s.cheatCounter).toBe(0);
    // Presentation lag stays inside one step, and peek() is the true state.
    const shown = frames.sim.snapshot();
    expect(shown.simUt - shown.ut).toBeGreaterThanOrEqual(0);
    expect(shown.simUt - shown.ut).toBeLessThan(1 / 120);
    expect(s.ut).toBe(s.simUt);
  }, 120_000);
});
