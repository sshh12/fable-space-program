/**
 * The acceptance flights beyond the ascent (fleet-data):
 *   - the Kestrel LF re-enters from low orbit and splashes down under chutes, crew alive;
 *   - the Egret, from a lunar-orbit start, lands and returns to orbit;
 *   - the Albatross's departure burn from low Earth orbit (about 20 minutes) completes at physics warp 4x and
 *     gives 10.9 km/s (+/- 2 %).
 * Flown on createSession from their fleet-*.json scenarios by the pilots of pilots.ts.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { MAX_PHYSICS_WARP_INDEX, type DefLibrary } from '@/core/contracts/defs';
import { fsDefSource } from '@/core/defs/fsSource';
import { loadDefs } from '@/core/defs/loader';
import { analyzeVehicle } from '@/sim/vessel/analyze';
import { fly } from './flights';
import { DeparturePilot, EntryPilot, LanderPilot } from './pilots';

let defs: DefLibrary;
beforeAll(async () => {
  defs = await loadDefs(fsDefSource());
});

describe('beyond the ascent', () => {
  it('the Kestrel LF re-enters from low orbit and splashes down under chutes, crew alive', async () => {
    const pilot = new EntryPilot(analyzeVehicle(defs, defs.vehicles['solstice-kestrel']!));
    const rec = await fly(defs, 'fleet-kestrel-entry', pilot, { maxSimTime: 7200 });
    expect(rec.result.failure).toBeNull();
    expect(rec.result.reason).toBe('done');
    expect(rec.active?.situation).toBe('splashed');
    expect(rec.final.mission.crewAlive).toBe(true);
    expect(rec.final.milestones.map((m) => m.id)).toEqual(expect.arrayContaining(['DROGUES', 'MAINS', 'SPLASHDOWN']));
    // Under the mains a capsule meets the water at a few m/s.
    expect(pilot.splashSpeed).toBeLessThan(12);
    // Nothing of the capsule was lost (what burns up is the service module, left behind before the air).
    expect(rec.damage.filter((d) => d.detail.includes('/sc-capsule'))).toEqual([]);
    console.log(`solstice-kestrel entry: splashdown at ${pilot.splashSpeed.toFixed(1)} m/s, ${rec.result.simTime.toFixed(0)} s after the start; peak q ${(rec.maxQ / 1000).toFixed(1)} kPa`);
  }, 300_000);

  it('the Egret, from low lunar orbit, lands and returns to orbit', async () => {
    const pilot = new LanderPilot(analyzeVehicle(defs, defs.vehicles['meridian-egret']!), { targetAltitude: 30000, cutoffPeriapsis: 18000, maxG: 3 });
    const rec = await fly(defs, 'fleet-egret-lunar', pilot, { maxSimTime: 7200 });
    expect(rec.result.failure).toBeNull();
    expect(rec.result.reason).toBe('done');
    expect(pilot.touchdownSpeed).not.toBeNull();
    expect(pilot.touchdownSpeed!).toBeLessThan(2.5);
    expect(rec.final.milestones.map((m) => m.id)).toEqual(expect.arrayContaining(['TOUCHDOWN', 'LUNAR_LIFTOFF']));
    expect(rec.active?.bodyId).toBe('moon');
    expect(rec.final.readouts.periapsisAltitude).toBeGreaterThan(15000);
    expect(rec.damage).toEqual([]);
    console.log(`meridian-egret lunar: touchdown at ${pilot.touchdownSpeed!.toFixed(2)} m/s; back in orbit ${(rec.final.readouts.periapsisAltitude / 1000).toFixed(1)} x ${(rec.final.readouts.apoapsisAltitude / 1000).toFixed(1)} km with ${rec.final.readouts.deltaVTotal.toFixed(0)} m/s left`);
  }, 300_000);

  it('the Albatross: a departure burn of about 20 minutes completes at 4x and gives 10.9 km/s (+/- 2 %)', async () => {
    const caps = analyzeVehicle(defs, defs.vehicles['meridian-albatross']!);
    const pilot = new DeparturePilot(caps);
    const rec = await fly(defs, 'fleet-albatross-departure', pilot, { maxSimTime: 3600 });
    expect(rec.result.failure).toBeNull();
    expect(pilot.maxWarpIndex).toBe(MAX_PHYSICS_WARP_INDEX);
    const burn = pilot.burnEndUt! - pilot.burnStartUt!;
    expect(burn).toBeGreaterThan(1150);
    expect(burn).toBeLessThan(1320);
    expect(Math.abs(pilot.deltaV - 10900) / 10900).toBeLessThan(0.02);
    expect(rec.damage).toEqual([]);
    console.log(`meridian-albatross departure: ${burn.toFixed(0)} s at warp index ${pilot.maxWarpIndex}, ${pilot.deltaV.toFixed(0)} m/s; ${rec.active?.situation}`);
  }, 300_000);
});
