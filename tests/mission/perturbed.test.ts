/**
 * The vehicle's margins and the pilot's robustness: the whole mission again from three perturbed starts -
 * lift-off 60 s after the plane crossing, every liquid engine 3 % short of its thrust, and a deliberately
 * sloppy pitch programme. Each must still land within 1,500 m of the lunar target and splash down on water
 * inside a recovery zone, by the same rules as the nominal flight (real Sim, real tiles, no cheat).
 */
import { describe, expect, it } from 'vitest';
import { deepestDataLevel, fly, milestone, writeFlightLog, type Flight, type FlightSetup } from './harness';

const VARIANTS: { name: string; setup: FlightSetup }[] = [
  { name: 'launch 60 s late', setup: { launchDelay: 60 } },
  { name: '3 % engine under-performance', setup: { thrustScale: 0.97 } },
  { name: 'sloppy pitch programme', setup: { sloppy: true } },
];

function check(f: Flight): void {
  expect(f.run.failure).toBeNull();
  expect(f.run.reason).toBe('done');
  const last = f.run.last;
  expect(last.scenario.startKind).toBe('pad');
  expect(last.cheatCounter).toBe(0);
  expect(last.mission.failed).toBe(false);
  expect(last.mission.crewAlive).toBe(true);
  expect(last.terrain.incompleteQueries).toBe(0);
  expect(f.milestones.map((m) => m.id)).toEqual(f.scenario.milestones.map((m) => m.id));
  expect(f.run.simTime / 86400).toBeLessThan(14);
  expect(f.observations.mostNegativeResource).toBeGreaterThanOrEqual(0);
  expect(f.observations.structuralEvents).toEqual([]);
  expect(f.observations.chuteFailed).toBe(false);
  // The Moon: on target, on the finest data, gently.
  const td = milestone(f, 'LUNAR_TOUCHDOWN').data;
  expect(td['distanceToLandingTarget']!).toBeGreaterThanOrEqual(0);
  expect(td['distanceToLandingTarget']!).toBeLessThanOrEqual(1500);
  expect(td['residentLevel']).toBe(deepestDataLevel('moon'));
  expect(td['terrainComplete']).toBe(1);
  expect(f.observations.finalDescent.notResident).toBe(0);
  expect(f.observations.finalDescent.discMinResidentLevel).toBe(deepestDataLevel('moon'));
  // The landing panel's distance, which the pilot steers by, agrees with the touchdown record.
  expect(Math.abs(f.report['landingMiss']! - td['distanceToLandingTarget']!)).toBeLessThan(1);
  expect(td['touchdownVerticalSpeed']!).toBeLessThan(2.5);
  expect(td['touchdownHorizontalSpeed']!).toBeLessThan(1.0);
  expect(td['touchdownTiltDeg']!).toBeLessThan(12);
  expect(td['legsIntact']).toBe(1);
  // Home: inside the corridor, inside the limits, on water inside a recovery zone.
  const entry = milestone(f, 'ENTRY_INTERFACE').data;
  expect(entry['speedOrbital']!).toBeGreaterThan(10900);
  expect(entry['speedOrbital']!).toBeLessThan(11100);
  expect(f.observations.perigeeAtInterface).toBeGreaterThanOrEqual(30000);
  expect(f.observations.perigeeAtInterface).toBeLessThanOrEqual(60000);
  const splash = milestone(f, 'SPLASHDOWN').data;
  expect(Math.max(splash['peakG']!, f.observations.peakGAfterInterface)).toBeLessThan(10);
  expect(splash['ablatorFraction']!).toBeGreaterThan(0.25);
  expect(milestone(f, 'DROGUE_DEPLOY').data['rcsFraction']!).toBeGreaterThan(0.2);
  expect(splash['surfaceWater']).toBe(1);
  expect(splash['insideRecoveryZone']).toBe(1);
  expect(splash['recoveryZoneDistance']!).toBeLessThan(splash['recoveryZoneRadius']!);
  expect(splash['touchdownVerticalSpeed']!).toBeLessThanOrEqual(9.5);
  expect(splash['crewAlive']).toBe(1);
}

describe('the mission from perturbed starts', () => {
  for (const variant of VARIANTS) {
    it(
      `${variant.name}: lands within 1,500 m of the target and splashes down on water inside a recovery zone`,
      async () => {
        const f = await fly({ scenario: 'lunar-direct', ...variant.setup });
        const td = f.milestones.find((m) => m.id === 'LUNAR_TOUCHDOWN')?.data;
        const sp = f.milestones.find((m) => m.id === 'SPLASHDOWN')?.data;
        writeFlightLog(`perturbed-${variant.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`, {
          variant: variant.name,
          reason: f.run.reason,
          failure: f.run.failure,
          hash: f.hash,
          wallSeconds: f.wallSeconds,
          simDays: f.run.simTime / 86400,
          landingMiss: td?.['distanceToLandingTarget'],
          splash: sp ? { latitudeDeg: sp['latitudeDeg'], longitudeDeg: sp['longitudeDeg'], zoneDistance: sp['recoveryZoneDistance'], zoneRadius: sp['recoveryZoneRadius'] } : null,
          milestones: f.milestones,
          report: f.report,
          stageDrops: f.observations.stageDrops,
        });
        check(f);
      },
      900_000,
    );
  }
});
