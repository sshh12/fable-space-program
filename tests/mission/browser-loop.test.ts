/**
 * The mission through the browser's door: the same pilot, driven by `Sim.advance(1/60, onControlTick)` once
 * per frame with a `snapshot()` per frame, as the app loop does (docs/ARCHITECTURE.md 18.2), on the real
 * Sim and the real tiles. The number of frames is the real time the browser mission will take at 60 Hz.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { flyFrames, type FramesFlight } from '../../tools/sim/flyFrames';
import { deepestDataLevel, writeFlightLog } from './harness';

let f: FramesFlight;

beforeAll(async () => {
  f = await flyFrames({ scenario: 'lunar-direct' });
  writeFlightLog('browser-loop', { frames: f.frames, realMinutes: f.realMinutes, ticks: f.ticks, wallSeconds: f.wallSeconds, phases: f.phases, milestones: f.milestones, report: f.report, world: f.sim.stats() });
}, 900_000);

describe('lunar-direct through Sim.advance, one 60 Hz frame at a time', () => {
  it('the pilot completes the mission: seventeen milestones, no cheat, crew alive', () => {
    expect(f.failure).toBeNull();
    expect(f.done).toBe(true);
    expect(f.milestones.map((m) => m.id)).toEqual(f.sim.scenario.milestones.map((m) => m.id));
    expect(f.last.scenario.startKind).toBe('pad');
    expect(f.last.cheatCounter).toBe(0);
    expect(f.last.mission.failed).toBe(false);
    expect(f.last.mission.crewAlive).toBe(true);
    expect(f.last.terrain.incompleteQueries).toBe(0);
  });

  it('lands within 1,500 m of the target on the deepest data and splashes down on water inside a recovery zone', () => {
    const td = f.milestones.find((m) => m.id === 'LUNAR_TOUCHDOWN')!.data;
    expect(td['distanceToLandingTarget']!).toBeLessThanOrEqual(1500);
    expect(td['residentLevel']).toBe(deepestDataLevel('moon'));
    expect(td['touchdownVerticalSpeed']!).toBeLessThan(2.5);
    expect(td['touchdownHorizontalSpeed']!).toBeLessThan(1.0);
    expect(td['legsIntact']).toBe(1);
    const sp = f.milestones.find((m) => m.id === 'SPLASHDOWN')!.data;
    expect(sp['surfaceWater']).toBe(1);
    expect(sp['insideRecoveryZone']).toBe(1);
    expect(sp['touchdownVerticalSpeed']!).toBeLessThanOrEqual(9.5);
    expect(sp['crewAlive']).toBe(1);
    expect(f.milestones.find((m) => m.id === 'DROGUE_DEPLOY')!.data['rcsFraction']!).toBeGreaterThan(0.2);
  });

  it('paces itself: under an hour of real time at 60 Hz, a control tick every fourth physics step', () => {
    // 7.9 days of flight in well under an hour: the coasts are warped, the burns and the waits for them are
    // at physics warp, lift-off, the final descent and the landings are in real time.
    expect(f.realMinutes).toBeLessThan(60);
    expect(f.realMinutes).toBeGreaterThan(20);
    const steps = f.sim.stats().steps;
    const rails = f.sim.stats().railsAdvances;
    // One tick per four steps and one per rails frame (a few more where a frame ends on a partial group of steps).
    expect(f.ticks).toBeGreaterThanOrEqual(Math.floor(steps / 4));
    expect(f.ticks).toBeLessThan(steps / 4 + rails + 1000);
  });
});
