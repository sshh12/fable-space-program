/**
 * Re-entry corridor sweep: the capsule alone on lunar-return trajectories with vacuum perigees from 10 to
 * 90 km, flown by the pilot's entry and parachute phases through the real Sim on the real Earth tiles
 * (tools/sim/entryCorridor.ts). Outcome classes, down-range from the entry point to the splash, ablator
 * use and thruster propellant left.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { entryDownRange } from '@/pilot';
import { corridorSweep, type CorridorResult } from '../../tools/sim/entryCorridor';
import { writeFlightLog } from './harness';

const PERIGEES = [10, 20, 30, 40, 45, 50, 60, 70, 80, 90];
/** The band the mission's perigee gate allows (docs/ARCHITECTURE.md 18.1, milestone 10). */
const GATE_BAND: readonly [number, number] = [30, 60];
const NOMINAL = 45;

let results: CorridorResult[];
const at = (km: number): CorridorResult => results.find((r) => r.perigeeKm === km)!;

beforeAll(async () => {
  results = await corridorSweep(PERIGEES);
  writeFlightLog('entry-corridor', results);
}, 600_000);

describe('re-entry corridor, vacuum perigee 10 to 90 km', () => {
  it('falls into three classes: too steep (crew lost), survivable, too shallow (skips out)', () => {
    expect(results.map((r) => r.perigeeKm)).toEqual(PERIGEES);
    for (const r of results) expect(['landed', 'skipped', 'crewLost', 'destroyed'], `${r.perigeeKm} km`).toContain(r.outcome);
    // The classes are contiguous: fatal below, a corridor, a skip above.
    const landed = results.filter((r) => r.outcome === 'landed').map((r) => r.perigeeKm);
    expect(landed.length).toBeGreaterThanOrEqual(4);
    const lo = Math.min(...landed);
    const hi = Math.max(...landed);
    for (const r of results) {
      if (r.perigeeKm < lo) expect(['crewLost', 'destroyed'], `${r.perigeeKm} km`).toContain(r.outcome);
      else if (r.perigeeKm > hi) expect(r.outcome, `${r.perigeeKm} km`).toBe('skipped');
      else expect(r.outcome, `${r.perigeeKm} km`).toBe('landed');
    }
    expect(at(10).outcome).not.toBe('landed');
    expect(at(10).failure).toBeTruthy();
    expect(at(80).outcome).toBe('skipped');
    expect(at(90).outcome).toBe('skipped');
    // Everything the mission gate allows is survivable.
    expect(lo).toBeLessThanOrEqual(GATE_BAND[0]);
    expect(hi).toBeGreaterThanOrEqual(GATE_BAND[1]);
  });

  it('inside the corridor: under 10 g, no g-dose, on the water under the mains, with thruster propellant to spare', () => {
    for (const r of results.filter((x) => x.outcome === 'landed')) {
      expect(r.peakG, `${r.perigeeKm} km: peak g`).toBeLessThan(10);
      expect(r.gDose, `${r.perigeeKm} km: g-dose`).toBeLessThan(5);
      expect(r.onWater, `${r.perigeeKm} km: water`).toBe(true);
      expect(r.splashSpeed, `${r.perigeeKm} km: splash speed`).toBeLessThanOrEqual(9.5);
      expect(r.ablatorLeft, `${r.perigeeKm} km: ablator left`).toBeGreaterThan(0.25);
      // Fail if the thrusters run low anywhere in the survivable corridor.
      expect(r.rcsLeftAtDrogues, `${r.perigeeKm} km: RCS left`).toBeGreaterThanOrEqual(0.2);
      expect(r.entrySpeed).toBeGreaterThan(10900);
      expect(r.entrySpeed).toBeLessThan(11100);
    }
    // The load falls as the entry gets shallower.
    const landed = results.filter((x) => x.outcome === 'landed');
    for (let i = 1; i < landed.length; i++) expect(landed[i]!.peakG).toBeLessThan(landed[i - 1]!.peakG);
  });

  it('the nominal entry uses at least 30 % of the ablator (the shield is sized for the job, not for show)', () => {
    const n = at(NOMINAL);
    expect(n.outcome).toBe('landed');
    expect(1 - n.ablatorLeft).toBeGreaterThanOrEqual(0.3);
    expect(1 - n.ablatorLeft).toBeLessThan(0.6);
  });

  it('down-range from the entry point to the splash: 2,000 to 5,000 km in the corridor, and what the pilot aims with at the nominal perigee', () => {
    for (const r of results.filter((x) => x.outcome === 'landed')) {
      expect(r.downRangeKm, `${r.perigeeKm} km`).toBeGreaterThan(2000);
      expect(r.downRangeKm, `${r.perigeeKm} km`).toBeLessThan(5000);
    }
    // The sweep enters heading east: the pilot's range model must be within 500 km of what is flown there.
    const model = entryDownRange(Math.PI / 2) / 1000;
    expect(Math.abs(at(NOMINAL).downRangeKm - model)).toBeLessThan(500);
    expect(Math.abs(at(40).downRangeKm - model)).toBeLessThan(500);
    expect(Math.abs(at(50).downRangeKm - model)).toBeLessThan(500);
  });
});
