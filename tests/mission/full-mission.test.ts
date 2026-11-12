/**
 * The headless mission (docs/ARCHITECTURE.md 18.1): the scripted pilot flies `lunar-direct` from the pad to
 * splashdown through the real Sim and the real TerrainProvider on the real baked tiles, calling only
 * `ready`, `terrainPending`, `step` / `advanceRails`, `peek`, `setControls` and `commands`. Every milestone
 * and gate is asserted from the milestone records and the observer of ./harness.ts.
 *
 * The flight is made twice: once by the pilot, once by feeding the recorded input log to a fresh Sim whose
 * tile I/O answers late (the terrain protocol). Both must end in the same state hash, and that hash must be
 * the stored golden one (tests/mission/golden.json, which belongs to the content hashes of the tile sets
 * it was recorded on; `MISSION_UPDATE_GOLDEN=1 npm run test:mission` records it anew after a re-bake or an
 * intended change of the simulation).
 *
 * The flight is also held against the two references of the tick-grid step (MIGRATION_V2 step 3.1; lead
 * decision in docs/requests/sim-core-v2-1.md): the ascent of the v1 clock from the same start, state by state
 * (tests/mission/reference-v1-aligned.json), and the v1 baseline inside twice the spread of the v1 control
 * flights (tests/mission/baseline-v1.json, tests/mission/controls-v1.json; tools/dev/mission-baseline.ts).
 */
import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { isTickInstant } from '@/sim/clock';
import { compareEnvelope, describeEnvelope, parseControls, type MissionRecord } from '../../tools/dev/mission-baseline';
import { BASELINE_FILE, captureMilestones, readRecord } from '../../tools/dev/record-mission-baseline';
import { ScenarioCapturer, scenarioFileText } from '../../tools/sim/qaScenarios';
import { compareToReference, readReference, referenceRecorder, referenceTable, type ReferenceDifference } from '../../tools/sim/referenceFlight';
import {
  CLEARANCE_SETTLE,
  deepestDataLevel,
  delayedSource,
  fly,
  loadLibrary,
  maxOf,
  milestone,
  repoRoot,
  reproducibleMaxMs,
  STEP_WINDOW_SECONDS,
  SURFACE_STAY_SECONDS,
  TARGET_DISC_RADIUS,
  tileContentHashes,
  writeFlightLog,
  type Flight,
} from './harness';

const GOLDEN_FILE = path.join(repoRoot, 'tests', 'mission', 'golden.json');
const SCENARIO = 'lunar-direct';

interface Golden {
  hash: string;
  steps: number;
  tiles: Record<string, string>;
  node: string;
}

let a: Flight;
let b: Flight;
let capturer: ScenarioCapturer;
let record: MissionRecord;
let sameStart: ReferenceDifference[];
/** Control ticks of the nominal flight whose state time is not a whole tick (none on the tick grid). */
let offGridTicks = 0;
let delayed: ReturnType<typeof delayedSource> | null = null;
const gates: { milestone: string; measured: string; gate: string }[] = [];
const note = (id: string, measured: string, gate: string): void => {
  gates.push({ milestone: id, measured, gate });
};
const km = (m: number): string => `${(m / 1000).toFixed(1)} km`;

beforeAll(async () => {
  const defs = await loadLibrary();
  capturer = new ScenarioCapturer(defs.scenarios[SCENARIO]!, (bodyId) => defs.bodies[bodyId]!.radius);
  const milestones = captureMilestones('this flight');
  const reference = readReference();
  const ascent = referenceRecorder(reference.lastMilestone);
  a = await fly({
    scenario: SCENARIO,
    onPilotTick: (s, phase) => {
      capturer.onTick(s, phase);
      milestones.onPilotTick(s);
      ascent.onTick(s);
      if (!isTickInstant(s.simUt)) offGridTicks++;
    },
  });
  record = milestones.finish(a, tileContentHashes(a.defs));
  sameStart = compareToReference(reference, ascent.states((bodyId) => a.defs.bodies[bodyId]!.mu));
  b = await fly({ scenario: SCENARIO, replay: { inputLog: a.run.inputLog, ticks: a.run.stats.ticks }, wrapSource: (source) => (delayed = delayedSource(source)) });
}, 900_000);

describe('lunar-direct flown headless from the pad to splashdown', () => {
  it('runs to the end under the rules: pad start, no cheat, no NaN, no phase timeout, every terrain query on final data', () => {
    expect(a.run.failure).toBeNull();
    expect(a.run.reason).toBe('done');
    const last = a.run.last;
    expect(last.scenario).toEqual({ id: SCENARIO, startKind: 'pad', stagesAlreadyFired: 0 });
    expect(last.cheatCounter).toBe(0);
    expect(a.sim.cheatCounter).toBe(0);
    expect(last.mission.failed).toBe(false);
    expect(last.mission.crewAlive).toBe(true);
    expect(last.terrain.incompleteQueries).toBe(0);
    expect(a.world.terrainWarpClamps).toBe(0);
    for (const m of a.milestones) for (const [k, v] of Object.entries(m.data)) expect(Number.isFinite(v), `${m.id}.${k}`).toBe(true);
  });

  it('reaches the seventeen milestones in order', () => {
    const expected = a.scenario.milestones.map((m) => m.id);
    expect(expected).toHaveLength(17);
    expect(a.milestones.map((m) => m.id)).toEqual(expected);
    for (let i = 1; i < a.milestones.length; i++) expect(a.milestones[i]!.ut).toBeGreaterThanOrEqual(a.milestones[i - 1]!.ut);
  });

  it('1-2. LIFTOFF at rest on the rotating Earth; MAX_Q between 20 and 40 kPa without structural failure', () => {
    const lift = milestone(a, 'LIFTOFF').data;
    expect(lift['speedSurface']!).toBeLessThan(0.1);
    expect(Math.abs(lift['speedOrbital']! - 439)).toBeLessThan(2);
    note('LIFTOFF', `surface speed ${lift['speedSurface']!.toFixed(3)} m/s, inertial ${lift['speedOrbital']!.toFixed(1)} m/s`, '< 0.1 m/s; 439 +/- 2 m/s');
    const q = milestone(a, 'MAX_Q').data;
    expect(q['peakDynamicPressure']!).toBeGreaterThan(20000);
    expect(q['peakDynamicPressure']!).toBeLessThan(40000);
    // No part destroyed and no joint broken on the vessel being flown, at max-q or at any other time.
    expect(a.observations.structuralEvents).toEqual([]);
    note('MAX_Q', `${(q['peakDynamicPressure']! / 1000).toFixed(2)} kPa at ${km(q['peakDynamicPressureAltitude']!)}; no part destroyed, no joint broken on the stack in the whole mission`, '20-40 kPa, no structural failure');
  });

  it('3. STAGE_SEP_1, FAIRING_JETTISON above 80 km, STAGE_SEP_2, each leaving debris vessels', () => {
    const s1 = milestone(a, 'STAGE_SEP_1').data;
    const fj = milestone(a, 'FAIRING_JETTISON').data;
    const s2 = milestone(a, 'STAGE_SEP_2').data;
    expect(s1['vesselsSeparated']!).toBeGreaterThanOrEqual(1);
    expect(fj['vesselsSeparated']!).toBeGreaterThanOrEqual(1);
    expect(s2['vesselsSeparated']!).toBeGreaterThanOrEqual(1);
    expect(fj['altitude']!).toBeGreaterThan(80000);
    note('STAGE_SEP_1', `${km(s1['altitude']!)}, ${s1['speedSurface']!.toFixed(0)} m/s, ${s1['vesselsSeparated']} debris vessel(s)`, 'leaves debris');
    note('FAIRING_JETTISON', `${km(fj['altitude']!)}, ${fj['vesselsSeparated']} debris vessels`, 'above 80 km, leaves debris');
    note('STAGE_SEP_2', `${km(s2['altitude']!)}, ${s2['speedOrbital']!.toFixed(0)} m/s, ${s2['vesselsSeparated']} debris vessel(s)`, 'leaves debris');
  });

  it('4. EARTH_ORBIT with Pe >= 160 km and Ap <= 400 km; one revolution on rails matches Kepler to 1 m', () => {
    const d = milestone(a, 'EARTH_ORBIT').data;
    expect(d['periapsisAltitude']!).toBeGreaterThanOrEqual(160000);
    expect(d['apoapsisAltitude']!).toBeLessThanOrEqual(400000);
    const k = a.observations.kepler;
    expect(k.checked).toBe(true);
    expect(k.samples).toBeGreaterThan(50);
    expect(k.maxError).toBeLessThan(1);
    expect(k.closureError).toBeLessThan(1);
    note('EARTH_ORBIT', `${km(d['periapsisAltitude']!)} x ${km(d['apoapsisAltitude']!)}, incl. ${d['inclinationDeg']!.toFixed(2)} deg; revolution of ${k.period.toFixed(0)} s on rails: ${(k.maxError * 1000).toFixed(3)} mm from Kepler at worst (${k.samples} samples)`, 'Pe >= 160 km, Ap <= 400 km; 1 m');
  });

  it('5-7. TLI_COMPLETE with a Moon encounter ahead; MOON_SOI_ENTER at the predicted time; LUNAR_ORBIT', () => {
    const tli = milestone(a, 'TLI_COMPLETE');
    expect(tli.data['predictedSoiUt']!).toBeGreaterThan(tli.ut);
    note('TLI_COMPLETE', `encounter predicted ${((tli.data['predictedSoiUt']! - tli.ut) / 3600).toFixed(1)} h ahead; TLI ${(a.report['tliDeltaV'] ?? NaN).toFixed(0)} m/s`, 'patches contain a Moon encounter');
    const soi = milestone(a, 'MOON_SOI_ENTER');
    expect(soi.data['soiTimeError']!).toBeLessThanOrEqual(2);
    const earlier = a.observations.soiPredictedEarlier;
    expect(earlier).not.toBeNull();
    expect(Math.abs(soi.ut - earlier!)).toBeLessThanOrEqual(2);
    note('MOON_SOI_ENTER', `${Math.abs(soi.ut - earlier!).toFixed(3)} s from the time predicted an hour and more before (${soi.data['soiTimeError']!.toFixed(3)} s from the last prediction)`, '+/- 2 s');
    const lo = milestone(a, 'LUNAR_ORBIT').data;
    expect(lo['eccentricity']!).toBeLessThan(0.05);
    expect(lo['periapsisAltitude']!).toBeGreaterThan(60000);
    note('LUNAR_ORBIT', `${km(lo['periapsisAltitude']!)} x ${km(lo['apoapsisAltitude']!)}, e ${lo['eccentricity']!.toFixed(4)}`, 'e < 0.05, Pe > 60 km');
  });

  it('8. LUNAR_TOUCHDOWN within 1,500 m of the target on the deepest data level, resident for the whole final descent, gently, and still there after 600 s', () => {
    const d = milestone(a, 'LUNAR_TOUCHDOWN').data;
    const deepest = deepestDataLevel('moon');
    expect(deepest).toBeGreaterThanOrEqual(12);
    expect(d['distanceToLandingTarget']!).toBeGreaterThanOrEqual(0);
    expect(d['distanceToLandingTarget']!).toBeLessThanOrEqual(1500);
    expect(d['availableLevel']).toBe(deepest);
    expect(d['residentLevel']).toBe(deepest);
    expect(d['terrainComplete']).toBe(1);
    // The whole final descent: everything the tile set offers under the vehicle was resident and final on
    // every tick. It starts kilometres from the target, where the regional data is coarser; inside the
    // mission disc of 1,500 m about the target the deepest level is on offer and was resident throughout.
    const f = a.observations.finalDescent;
    expect(f.ticks).toBeGreaterThan(300);
    expect(f.startRadar).toBeGreaterThan(1900);
    expect(f.notResident).toBe(0);
    expect(f.notComplete).toBe(0);
    expect(f.discTicks).toBeGreaterThan(300);
    expect(f.discMinAvailableLevel).toBe(deepest);
    expect(f.discMinResidentLevel).toBe(deepest);
    // The distance the pilot steered by (the landing panel's, at first contact) is the one the record measures.
    expect(Math.abs(a.report['landingMiss']! - d['distanceToLandingTarget']!)).toBeLessThan(1);
    expect(d['touchdownVerticalSpeed']!).toBeLessThan(2.5);
    expect(d['touchdownHorizontalSpeed']!).toBeLessThan(1.0);
    expect(d['touchdownTiltDeg']!).toBeLessThan(12);
    expect(d['tiltDeg']!).toBeLessThan(12);
    expect(d['legs']).toBe(4);
    expect(d['legsBroken']).toBe(0);
    expect(d['legsIntact']).toBe(1);
    const st = a.observations.surfaceStay;
    expect(st.leftEarly).toBe(false);
    // (Observed at the control ticks, which are up to a few seconds apart while the stay is warped through.)
    expect(st.observedFor).toBeGreaterThan(SURFACE_STAY_SECONDS - 5);
    expect(milestone(a, 'LUNAR_LIFTOFF').ut - milestone(a, 'LUNAR_TOUCHDOWN').ut).toBeGreaterThan(SURFACE_STAY_SECONDS);
    expect(st.maxDrift).toBeLessThan(0.02);
    expect(st.maxTiltDeg).toBeLessThan(12);
    note(
      'LUNAR_TOUCHDOWN',
      `${d['distanceToLandingTarget']!.toFixed(2)} m from the target; data level ${d['residentLevel']} of ${d['availableLevel']} there (deepest ${deepest}); final descent from ${f.startRadar.toFixed(0)} m, ${km(f.startDistance)} out: the available data resident and final on all ${f.ticks} ticks (level ${f.minResidentLevel} at the coarsest, out there), level ${f.discMinResidentLevel} on all ${f.discTicks} ticks within ${TARGET_DISC_RADIUS} m of the target; ${d['touchdownVerticalSpeed']!.toFixed(2)} m/s down, ${d['touchdownHorizontalSpeed']!.toFixed(3)} m/s across, tilt ${d['touchdownTiltDeg']!.toFixed(2)} deg, ${d['legs']! - d['legsBroken']!} of ${d['legs']} legs intact; landed for ${st.observedFor.toFixed(0)} s, moved ${(st.maxDrift * 1000).toFixed(2)} mm`,
      '<= 1,500 m; deepest level resident; < 2.5 m/s; < 1.0 m/s; < 12 deg; legs intact; landed after 600 s',
    );
  });

  it('9-10. LUNAR_LIFTOFF leaves the descent stage landed; MOON_SOI_EXIT; EARTH_PERIGEE_TARGETED between 30 and 60 km', () => {
    const lift = milestone(a, 'LUNAR_LIFTOFF').data;
    expect(lift['vesselsLeftOnSurface']!).toBeGreaterThanOrEqual(1);
    const left = a.run.last.vessels.filter((v) => v.bodyId === 'moon' && v.situation === 'landed' && !v.controllable);
    expect(left).toHaveLength(1);
    expect(left[0]!.parts.some((p) => p.def === 'heron-descent-stage')).toBe(true);
    note('LUNAR_LIFTOFF', `after ${lift['surfaceStay']!.toFixed(0)} s on the surface; "${left[0]!.name}" still landed at the end of the mission`, 'descent stage stays behind as landed debris');
    const exit = milestone(a, 'MOON_SOI_EXIT');
    expect(exit.data['soiTimeError']!).toBeLessThanOrEqual(2);
    note('MOON_SOI_EXIT', `TEI ${(a.report['teiDeltaV'] ?? NaN).toFixed(1)} m/s after ${a.report['teiRevolutionsWaited'] ?? 0} revolutions of waiting`, 'reached');
    const pe = milestone(a, 'EARTH_PERIGEE_TARGETED').data;
    expect(pe['predictedPeriapsisAltitude']!).toBeGreaterThanOrEqual(30000);
    expect(pe['predictedPeriapsisAltitude']!).toBeLessThanOrEqual(60000);
    const atInterface = a.observations.perigeeAtInterface;
    expect(atInterface).toBeGreaterThanOrEqual(30000);
    expect(atInterface).toBeLessThanOrEqual(60000);
    note('EARTH_PERIGEE_TARGETED', `vacuum perigee ${km(pe['predictedPeriapsisAltitude']!)} when first inside the band, ${km(atInterface)} at the entry interface`, '30-60 km');
  });

  it('11-12. ENTRY_INTERFACE at 122 km and 10.9-11.1 km/s; loads, ablator and thruster propellant inside the limits; parachutes inside their envelopes', () => {
    const e = milestone(a, 'ENTRY_INTERFACE').data;
    expect(Math.abs(e['altitude']! - 122000)).toBeLessThan(50);
    expect(e['speedOrbital']!).toBeGreaterThan(10900);
    expect(e['speedOrbital']!).toBeLessThan(11100);
    const splash = milestone(a, 'SPLASHDOWN').data;
    const drogue = milestone(a, 'DROGUE_DEPLOY').data;
    const main = milestone(a, 'MAIN_DEPLOY').data;
    const peak = Math.max(a.observations.peakGAfterInterface, splash['peakG']!);
    expect(peak).toBeLessThan(10);
    expect(splash['peakGDose']!).toBeLessThan(5);
    expect(splash['ablatorFraction']!).toBeGreaterThan(0.25);
    expect(drogue['rcsFraction']!).toBeGreaterThan(0.2);
    note('ENTRY_INTERFACE', `${km(e['altitude']!)}, ${(e['speedOrbital']! / 1000).toFixed(3)} km/s; peak ${peak.toFixed(2)} g, g-dose ${splash['peakGDose']!.toFixed(2)}, ablator left ${(splash['ablatorFraction']! * 100).toFixed(1)} %, capsule RCS left at drogues ${(drogue['rcsFraction']! * 100).toFixed(1)} %`, '122 km, 10.9-11.1 km/s; < 10 g; dose < 5; ablator > 25 %; RCS > 20 %');
    expect(drogue['chuteEnvelope']).toBe(0);
    expect(main['chuteEnvelope']).toBe(0);
    expect(a.observations.chuteFailed).toBe(false);
    note('DROGUE_DEPLOY', `${drogue['deployAltitude']!.toFixed(0)} m, Mach ${drogue['deployMach']!.toFixed(2)}, ${(drogue['deployDynamicPressure']! / 1000).toFixed(2)} kPa: inside the envelope`, 'inside the envelope, no chute failure');
    note('MAIN_DEPLOY', `${main['deployAltitude']!.toFixed(0)} m, ${main['deploySpeed']!.toFixed(1)} m/s, ${(main['deployDynamicPressure']! / 1000).toFixed(2)} kPa: inside the envelope`, 'inside the envelope, no chute failure');
  });

  it('13. SPLASHDOWN on water inside a recovery zone, at no more than 9.5 m/s, crew alive, floating upright after 30 s', () => {
    const d = milestone(a, 'SPLASHDOWN').data;
    expect(d['surfaceWater']).toBe(1);
    expect(d['insideRecoveryZone']).toBe(1);
    expect(d['recoveryZoneDistance']!).toBeGreaterThanOrEqual(0);
    expect(d['recoveryZoneDistance']!).toBeLessThan(d['recoveryZoneRadius']!);
    expect(d['touchdownVerticalSpeed']!).toBeLessThanOrEqual(9.5);
    expect(d['crewAlive']).toBe(1);
    expect(d['settledFor']!).toBeGreaterThanOrEqual(30);
    expect(d['tiltDeg']!).toBeLessThan(25);
    expect(a.observations.maxFloatTiltDeg).toBeLessThan(60);
    const zone = a.run.last.surfaceTargets.filter((t) => t.kind === 'recovery').find((t) => Math.abs(t.radius - d['recoveryZoneRadius']!) < 1);
    note(
      'SPLASHDOWN',
      `${d['latitudeDeg']!.toFixed(2)} deg, ${d['longitudeDeg']!.toFixed(2)} deg on water, ${km(d['recoveryZoneDistance']!)} from the centre of "${zone?.name ?? '?'}" (radius ${km(d['recoveryZoneRadius']!)}); ${d['touchdownVerticalSpeed']!.toFixed(2)} m/s; floating at ${d['tiltDeg']!.toFixed(1)} deg after ${d['settledFor']!.toFixed(0)} s`,
      'water, inside a recovery zone; <= 9.5 m/s; crew alive; upright after 30 s',
    );
  });

  it('14. budgets: under 14 days, no negative propellant, positive clearance after every separation, no slow step before the two landings', () => {
    const days = a.run.simTime / 86400;
    expect(days).toBeLessThan(14);
    expect(a.observations.mostNegativeResource).toBeGreaterThanOrEqual(0);
    // Clearance: every pair of every separation, from CLEARANCE_SETTLE after it for 30 s.
    const seps = a.observations.separations;
    expect(seps.length).toBeGreaterThanOrEqual(8);
    for (const s of seps) {
      expect(s.pairs.length, `pairs after ${s.newVessels.join(', ')}`).toBeGreaterThan(0);
      for (const p of s.pairs) {
        expect(p.samples, `${p.a} / ${p.b}`).toBeGreaterThan(100);
        expect(p.positiveFrom, `${p.a} / ${p.b}: positive from`).toBeLessThanOrEqual(CLEARANCE_SETTLE);
        expect(p.minimum, `${p.a} / ${p.b}: minimum`).toBeGreaterThan(0);
      }
    }
    // Step cost in the last 60 s before first contact: the same steps were timed in both flights; a step is
    // slow when it was slow both times (a pause of the garbage collector or of the machine is not).
    const o = a.observations;
    const p = b.observations;
    expect(o.stepsBeforeLunarContact).not.toBeNull();
    expect(o.stepsBeforeSplash).not.toBeNull();
    expect(p.stepsBeforeLunarContact).not.toBeNull();
    expect(p.stepsBeforeSplash).not.toBeNull();
    const expectedSteps = STEP_WINDOW_SECONDS * 120;
    expect(o.stepsBeforeLunarContact!.length).toBeGreaterThanOrEqual(expectedSteps);
    expect(o.stepsBeforeSplash!.length).toBeGreaterThanOrEqual(expectedSteps);
    expect(p.stepsBeforeLunarContact!.length).toBe(o.stepsBeforeLunarContact!.length);
    expect(p.stepsBeforeSplash!.length).toBe(o.stepsBeforeSplash!.length);
    const lunar = reproducibleMaxMs(o.stepsBeforeLunarContact!, p.stepsBeforeLunarContact!);
    const splash = reproducibleMaxMs(o.stepsBeforeSplash!, p.stepsBeforeSplash!);
    expect(lunar).toBeLessThan(2);
    expect(splash).toBeLessThan(2);
    note('budgets', `${days.toFixed(2)} days; slowest step in the last 60 s before lunar contact ${lunar.toFixed(3)} ms (single flights ${maxOf(o.stepsBeforeLunarContact!).toFixed(3)} / ${maxOf(p.stepsBeforeLunarContact!).toFixed(3)} ms), before splashdown ${splash.toFixed(3)} ms (${maxOf(o.stepsBeforeSplash!).toFixed(3)} / ${maxOf(p.stepsBeforeSplash!).toFixed(3)} ms)`, '< 14 days; no step above 2 ms');
    // Every stage that went overboard is logged with what it had left.
    expect(a.observations.stageDrops.length).toBeGreaterThanOrEqual(5);
  });

  it('debris: the first stage falls into the sea down-range, the third stage ends at the Moon', () => {
    const m1 = a.debris.find((f) => f.name.includes('M-1'));
    expect(m1).toBeDefined();
    expect(m1!.bodyId).toBe('earth');
    expect(m1!.reason === 'impact' || m1!.reason === 'burnedUp').toBe(true);
    expect(m1!.distanceFromSite).toBeGreaterThan(200e3);
    expect(m1!.distanceFromSite).toBeLessThan(2000e3);
    // The third stage flies by the Moon or hits it: it never comes back into the Earth's atmosphere.
    const m3 = a.debris.find((f) => f.name.includes('M-3'));
    const stillFlying = a.run.last.vessels.find((v) => v.name.includes('M-3'));
    expect(m3 !== undefined || stillFlying !== undefined).toBe(true);
    if (m3) expect(m3.bodyId).toBe('moon');
    else expect(['orbiting', 'escaping']).toContain(stillFlying!.situation);
    note('debris', a.debris.map((f) => `${f.name}: ${f.reason} on ${f.bodyId}${f.distanceFromSite >= 0 ? ` ${km(f.distanceFromSite)} from the site` : ''}`).join('; '), 'M-1 impact down-range, M-3 lunar flyby or impact');
  });

  it('the QA scenarios on disk are the captures of this flight: state, time, stages fired and the resources on board', () => {
    const captured = capturer.scenarios();
    expect(captured.map((sc) => sc.id)).toEqual(['qa-leo', 'qa-translunar', 'qa-lunar-orbit', 'qa-powered-descent', 'qa-lunar-surface', 'qa-trans-earth', 'qa-entry', 'qa-drogues']);
    for (const sc of captured) {
      const file = path.join(repoRoot, 'data', 'defs', 'scenarios', `${sc.id}.json`);
      expect(fs.readFileSync(file, 'utf8'), `${sc.id}.json is not the capture of the nominal flight: run tools/sim/captureScenarios.ts`).toBe(scenarioFileText(sc));
    }
    // What they carry is what the mission had on board at that point.
    const engineKg = (id: string, part: string): number => {
      const amounts = captured.find((sc) => sc.id === id)!.resources![part]!;
      return Object.entries(amounts).reduce((n, [res, kg]) => (res === 'RCSProp' ? n : n + kg), 0);
    };
    const td = milestone(a, 'LUNAR_TOUCHDOWN').data;
    expect(Math.abs(engineKg('qa-lunar-surface', 'descent-stage') - td['propellantKg:descent']!)).toBeLessThan(1);
    expect(Math.abs(engineKg('qa-trans-earth', 'ascent-stage') - a.report['ascentPropellantLeftKg']!)).toBeLessThan(2);
    const drogue = milestone(a, 'DROGUE_DEPLOY').data;
    const capsule = captured.find((sc) => sc.id === 'qa-drogues')!.resources!['capsule']!;
    const ablatorCapacity = a.defs.parts['kestrel-capsule']!.resources!.find((r) => r.resource === 'Ablator')!.capacity;
    expect(capsule['Ablator']! / ablatorCapacity).toBeCloseTo(drogue['ablatorFraction']!, 3);
    note(
      'QA scenarios',
      `the eight files are the captures of this flight; the landed start holds ${engineKg('qa-lunar-surface', 'descent-stage').toFixed(0)} kg of descent propellant, the trans-Earth start ${engineKg('qa-trans-earth', 'ascent-stage').toFixed(0)} kg in the ascent stage, the drogue start ${capsule['Ablator']!.toFixed(1)} kg of ablator`,
      'files equal the captures',
    );
  });

  it('the clock is on the tick grid: the start, every control tick and the end of the flight', () => {
    expect(isTickInstant(a.scenario.startUt)).toBe(true);
    expect(a.run.stats.ticks).toBeGreaterThan(100000);
    expect(offGridTicks).toBe(0);
    expect(isTickInstant(a.run.finalUt)).toBe(true);
    note('tick grid', `start tick ${Math.round(a.scenario.startUt * 120)}; all ${a.run.stats.ticks} control ticks (${a.run.stats.railsAdvances} of them rails landings) on whole ticks`, 'no state time off the grid');
  });

  it('same-start equality: the ascent to EARTH_ORBIT is the one the v1 clock flew from this start', () => {
    // tests/mission/reference-v1-aligned.json: the v1 clock from the same tick-aligned start, at every milestone
    // up to EARTH_ORBIT and every 30 s of the ascent. The v1 clock summed float instants while it warped on the
    // pad and lifted off 18.6 microseconds before the tick: the Earth turns 1.4e-9 rad in that time, which is
    // the difference of the two flights in the plane angles and in the inertial position (9 mm).
    const reference = readReference();
    expect(a.scenario.startUt).toBe(reference.startUt);
    expect(sameStart).toHaveLength(reference.states.length);
    expect(sameStart.filter((r) => r.kind === 'milestone').map((r) => r.id)).toEqual(['LIFTOFF', 'MAX_Q', 'STAGE_SEP_1', 'FAIRING_JETTISON', 'STAGE_SEP_2', 'EARTH_ORBIT']);
    const worst = (f: (r: ReferenceDifference) => number): number => Math.max(...sameStart.map((r) => Math.abs(f(r))));
    for (const r of sameStart) {
      expect(r.sameBody && r.sameControlTick, `${r.id}: same control tick, same body`).toBe(true);
      expect(Math.abs(r.dUt), `${r.id}: event time`).toBeLessThan(1e-4);
      expect(Math.abs(r.dCaptureUt), `${r.id}: capture time`).toBeLessThan(1e-4);
      expect(r.da, `${r.id}: da/a`).toBeLessThan(1e-9);
      expect(r.de, `${r.id}: de`).toBeLessThan(1e-9);
      expect(r.dEnergy, `${r.id}: dE/E`).toBeLessThan(1e-9);
      expect(r.dh, `${r.id}: dh/h`).toBeLessThan(1e-9);
      expect(r.di, `${r.id}: di`).toBeLessThan(1e-8);
      expect(r.dlan, `${r.id}: dLAN`).toBeLessThan(1e-8);
      expect(r.dMass, `${r.id}: dm/m`).toBeLessThan(1e-12);
      expect(Math.abs(r.dAltitude), `${r.id}: altitude`).toBeLessThan(1e-4);
      expect(r.dPosition, `${r.id}: position`).toBeLessThan(0.05);
      expect(r.dVelocity, `${r.id}: velocity`).toBeLessThan(1e-4);
    }
    const sci = (x: number): string => x.toExponential(2);
    note(
      'same start',
      `${sameStart.length} states to EARTH_ORBIT at the same control ticks as the v1 clock from this start: event times within ${sci(worst((r) => r.dUt))} s, da/a ${sci(worst((r) => r.da))}, de ${sci(worst((r) => r.de))}, dE/E ${sci(worst((r) => r.dEnergy))}, dh/h ${sci(worst((r) => r.dh))}, di ${sci(worst((r) => r.di))} rad, dLAN ${sci(worst((r) => r.dlan))} rad, dm/m ${sci(worst((r) => r.dMass))}, altitude ${sci(worst((r) => r.dAltitude))} m, position ${sci(worst((r) => r.dPosition))} m`,
      '1e-4 s; 1e-9 in a, e, E, h; 1e-8 rad in i and LAN; 1e-12 in mass; 0.1 mm; 5 cm',
    );
    console.log(`\nSame-start comparison (tests/mission/reference-v1-aligned.json):\n${referenceTable(sameStart)}`);
  });

  it('envelope: every milestone lies within twice the spread of the v1 control flights from the v1 baseline', () => {
    const baseline = readRecord(BASELINE_FILE);
    const controls = parseControls(JSON.parse(fs.readFileSync(path.join(repoRoot, 'tests', 'mission', 'controls-v1.json'), 'utf8')));
    expect(controls.length).toBeGreaterThanOrEqual(4);
    const rows = compareEnvelope(baseline, record, controls);
    expect(rows).toHaveLength(17);
    for (const r of rows) expect(r.pass, `${r.id}: ${r.why ?? ''}`).toBe(true);
    // The touchdown point and the recovery zone are the baseline's.
    expect(record.final.recoveryZone).toBe(baseline.final.recoveryZone);
    const td = record.milestones.find((m) => m.id === 'LUNAR_TOUCHDOWN')!;
    const btd = baseline.milestones.find((m) => m.id === 'LUNAR_TOUCHDOWN')!;
    const cosang = Math.sin(td.latitude) * Math.sin(btd.latitude) + Math.cos(td.latitude) * Math.cos(btd.latitude) * Math.cos(td.longitude - btd.longitude);
    const apart = Math.acos(Math.max(-1, Math.min(1, cosang))) * a.defs.bodies[td.bodyId]!.radius;
    expect(apart).toBeLessThan(50);
    note('envelope', `all 17 milestones inside twice the spread of ${controls.length} v1 control flights; touchdown ${apart.toFixed(2)} m from the baseline's point; splashdown in "${record.final.recoveryZone}"`, 'event time and da/a within 2 x the controls; 50 m; the same recovery zone');
    console.log(`\nEnvelope against tests/mission/baseline-v1.json:\n${describeEnvelope(rows)}`);
  });

  it('cost: under 5 minutes of wall clock and under 100 microseconds per step', () => {
    expect(a.wallSeconds).toBeLessThan(300);
    expect(a.meanStepMicroseconds).toBeLessThan(100);
    note('cost', `${a.wallSeconds.toFixed(1)} s wall (replay with delayed tile I/O ${b.wallSeconds.toFixed(1)} s); ${a.run.stats.steps} steps at ${a.meanStepMicroseconds.toFixed(1)} us, ${a.run.stats.railsAdvances} rails advances, ${a.run.stats.ticks} control ticks`, '< 5 min (target 90 s); < 100 us per step');
  });

  it('determinism: the replayed input log on late tile I/O ends in the same state, and that state is the golden one', () => {
    expect(b.run.reason).toBe('logEnd');
    expect(delayed).not.toBeNull();
    expect(delayed!.reads).toBeGreaterThan(100);
    expect(b.run.stats.steps).toBe(a.run.stats.steps);
    expect(b.run.stats.railsAdvances).toBe(a.run.stats.railsAdvances);
    expect(b.run.last.terrain.incompleteQueries).toBe(0);
    expect(b.milestones).toEqual(a.milestones);
    expect(b.hash).toBe(a.hash);
    const tiles = tileContentHashes(a.defs);
    const record: Golden = { hash: a.hash, steps: a.run.stats.steps, tiles, node: process.version };
    if (process.env['MISSION_UPDATE_GOLDEN']) fs.writeFileSync(GOLDEN_FILE, `${JSON.stringify(record, null, 2)}\n`);
    expect(fs.existsSync(GOLDEN_FILE), 'tests/mission/golden.json is missing: record it with MISSION_UPDATE_GOLDEN=1 npm run test:mission').toBe(true);
    const golden = JSON.parse(fs.readFileSync(GOLDEN_FILE, 'utf8')) as Golden;
    // The golden state belongs to the baked tiles it was flown on.
    expect(tiles, 'the tile sets were re-baked since the golden hash was recorded: record it anew with MISSION_UPDATE_GOLDEN=1 npm run test:mission').toEqual(golden.tiles);
    expect(a.run.stats.steps).toBe(golden.steps);
    expect(a.hash).toBe(golden.hash);
    note('determinism', `state hash ${a.hash} (pilot) = ${b.hash} (replay, ${delayed!.reads} late tile reads) = golden ${golden.hash}`, 'same hash on every run');
  });

  it('writes the mission log', () => {
    const o = a.observations;
    const file = writeFlightLog('nominal', {
      scenario: SCENARIO,
      hash: a.hash,
      tiles: tileContentHashes(a.defs),
      wallSeconds: a.wallSeconds,
      stats: a.run.stats,
      world: a.world,
      simDays: a.run.simTime / 86400,
      gates,
      milestones: a.milestones,
      report: a.report,
      separations: o.separations,
      stageDrops: o.stageDrops,
      observations: { finalDescent: o.finalDescent, kepler: o.kepler, surfaceStay: o.surfaceStay, perigeeAtInterface: o.perigeeAtInterface, maxFloatTiltDeg: o.maxFloatTiltDeg, soiPredictedEarlier: o.soiPredictedEarlier },
      debris: a.debris,
      pilotLog: a.log,
    });
    expect(fs.existsSync(file)).toBe(true);
    console.log(`\nMission log (${file}):`);
    for (const g of gates) console.log(`  ${g.milestone.padEnd(22)} ${g.measured}   [gate: ${g.gate}]`);
    console.log('  separations:');
    for (const s of o.separations) {
      const worst = s.pairs.reduce((m, p) => (p.minimum < m.minimum ? p : m), s.pairs[0]!);
      console.log(`    T+${s.met.toFixed(1)} s (stage ${s.stagesFired - 1}): ${s.newVessels.join(', ')} - ${s.pairs.length} pair(s), all positive from ${Math.max(...s.pairs.map((p) => p.positiveFrom)).toFixed(2)} s, closest ${worst.minimum.toFixed(2)} m (${worst.a} / ${worst.b})`);
    }
    console.log('  stages dropped with:');
    for (const d of o.stageDrops) console.log(`    ${d.label} (stage ${d.stageIndex}): ${d.deltaVLeft.toFixed(0)} m/s left${d.propellantFractionLeft !== null ? `, ${(d.propellantFractionLeft * 100).toFixed(1)} % of its propellant` : ''}`);
  });
});
