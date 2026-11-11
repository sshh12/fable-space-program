/**
 * Ascent only: the pilot flies `lunar-direct` from the pad until the parking orbit is recorded. A quick
 * check of the launch half of the mission (a few seconds of wall clock) on the real Sim and the real tiles.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { RAD } from '@/core/math/scalar';
import { CLEARANCE_SETTLE, fly, milestone, writeFlightLog, type Flight } from './harness';

let f: Flight;

beforeAll(async () => {
  f = await fly({ scenario: 'lunar-direct', untilMilestone: 'EARTH_ORBIT', maxDays: 0.2 });
}, 300_000);

describe('ascent to the parking orbit', () => {
  it('reaches orbit from the pad without a cheat, on final terrain data', () => {
    expect(f.run.failure).toBeNull();
    expect(f.run.reason).toBe('until');
    expect(f.run.last.scenario.startKind).toBe('pad');
    expect(f.run.last.cheatCounter).toBe(0);
    expect(f.run.last.mission.failed).toBe(false);
    expect(f.run.last.terrain.incompleteQueries).toBe(0);
    expect(f.milestones.map((m) => m.id)).toEqual(['LIFTOFF', 'MAX_Q', 'STAGE_SEP_1', 'FAIRING_JETTISON', 'STAGE_SEP_2', 'EARTH_ORBIT']);
  });

  it('lifts off at rest 600 s after the scenario start, on the azimuth of the launch window', () => {
    const lift = milestone(f, 'LIFTOFF');
    expect(lift.data['speedSurface']!).toBeLessThan(0.1);
    expect(Math.abs(lift.data['speedOrbital']! - 439)).toBeLessThan(2);
    // The plane crossing is 600 s after the start (tools/sim/start-time.json); the engines need a few seconds.
    expect(Math.abs(lift.ut - f.scenario.startUt - 600)).toBeLessThan(15);
  });

  it('passes max-q between 20 and 40 kPa and stages in order, the fairing above 80 km', () => {
    const q = milestone(f, 'MAX_Q').data;
    expect(q['peakDynamicPressure']!).toBeGreaterThan(20000);
    expect(q['peakDynamicPressure']!).toBeLessThan(40000);
    expect(f.observations.structuralEvents).toEqual([]);
    expect(milestone(f, 'FAIRING_JETTISON').data['altitude']!).toBeGreaterThan(80000);
    expect(milestone(f, 'STAGE_SEP_1').data['peakG']!).toBeLessThan(5);
    for (const s of f.observations.separations) {
      for (const p of s.pairs) {
        // (A separation in the last seconds before the stop is followed for less than the full 30 s.)
        expect(p.positiveFrom, `${p.a} / ${p.b}`).toBeLessThanOrEqual(CLEARANCE_SETTLE);
        if (p.minimum !== Infinity) expect(p.minimum, `${p.a} / ${p.b}`).toBeGreaterThan(0);
      }
    }
  });

  it('ends in a parking orbit above 160 km, below 400 km, in the plane of the Moon, with second-stage propellant to spare', () => {
    const d = milestone(f, 'EARTH_ORBIT').data;
    expect(d['periapsisAltitude']!).toBeGreaterThanOrEqual(160000);
    expect(d['apoapsisAltitude']!).toBeLessThanOrEqual(400000);
    expect(d['eccentricity']!).toBeLessThan(0.02);
    const rd = f.run.last.readouts;
    expect(rd.targetRelativeInclination! * RAD).toBeLessThan(0.2);
    const m2 = f.report['m2PropellantFractionAtSeparation'];
    expect(m2).toBeGreaterThan(0.005);
    // The third stage and the lander ride on untouched.
    expect(d['propellantFraction:m3'] ?? 1).toBeGreaterThan(0.99);
    expect(f.run.simTime).toBeLessThan(1500);
    writeFlightLog('ascent', { hash: f.hash, wallSeconds: f.wallSeconds, milestones: f.milestones, report: f.report, stageDrops: f.observations.stageDrops, separations: f.observations.separations });
  });

  it('costs seconds, not minutes', () => {
    expect(f.wallSeconds).toBeLessThan(60);
    expect(f.meanStepMicroseconds).toBeLessThan(100);
  });
});
