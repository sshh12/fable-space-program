/**
 * Scenario files: the start time of `lunar-direct` still satisfies the three start constraints for the
 * site and target of the definitions, and every QA scenario loads into a self-consistent state.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { DefLibrary } from '@/core/contracts/defs';
import type { MilestoneId } from '@/core/contracts/sim';
import type { TerrainProvider } from '@/core/contracts/terrain';
import { DEG, RAD } from '@/core/math/scalar';
import { v3 } from '@/core/math/vec3';
import { createBodySystem } from '@/sim/bodies';
import { checkStartConstraints, type StartConstraintOptions, type StartLaunchKind } from '@/sim/nav';
import { repoRoot } from '../../../tools/sim/realWorld';
import { active, createRealTerrain, loadLibrary, makeSim, settleTerrain } from './helpers';

interface StartTimeFile {
  startUt: number;
  site: { id: string; bodyId: string; latDeg: number; lonDeg: number; padElevation: number };
  targetBodyId: string;
  landing: { bodyId: string; latDeg: number; lonDeg: number };
  launch: { launchAzimuthDeg: number; ascending: boolean };
  constraints: {
    launchKind: StartLaunchKind;
    launchDelaySeconds: number;
    launchDelayToleranceSeconds: number;
    padSunElevationDeg: [number, number];
    landingWindowDays: [number, number];
    landingSunElevationDeg: [number, number];
  };
}

let defs: DefLibrary;
let terrain: TerrainProvider;
let st: StartTimeFile;

beforeAll(async () => {
  defs = await loadLibrary();
  terrain = await createRealTerrain(defs);
  st = JSON.parse(await fs.readFile(path.join(repoRoot, 'tools', 'sim', 'start-time.json'), 'utf8')) as StartTimeFile;
});

describe('lunar-direct', () => {
  it('starts at the time of tools/sim/start-time.json, which records the site and target of the definitions', () => {
    const sc = defs.scenarios['lunar-direct']!;
    expect(sc.start.kind).toBe('pad');
    expect(sc.stagesAlreadyFired).toBe(0);
    expect(sc.startUt).toBe(st.startUt);
    const site = defs.sites[sc.site]!;
    expect(st.site.id).toBe(sc.site);
    expect(st.site.bodyId).toBe(site.bodyId);
    expect(st.site.latDeg).toBe(site.location.latDeg);
    expect(st.site.lonDeg).toBe(site.location.lonDeg);
    expect(st.site.padElevation).toBe(site.location.padElevation);
    expect(st.targetBodyId).toBe(sc.target);
    expect(sc.suggestedLanding).not.toBeNull();
    expect(st.landing.bodyId).toBe(sc.suggestedLanding!.bodyId);
    expect(st.landing.latDeg).toBe(sc.suggestedLanding!.latDeg);
    expect(st.landing.lonDeg).toBe(sc.suggestedLanding!.lonDeg);
  });

  it('the start time satisfies the three constraints (launch opportunity on either azimuth, pad Sun, landing-site Sun)', () => {
    const sc = defs.scenarios['lunar-direct']!;
    const site = defs.sites[sc.site]!;
    const system = createBodySystem(defs);
    expect(st.constraints.launchKind).toBe('either');
    const options: StartConstraintOptions = {
      launchKind: st.constraints.launchKind,
      launchDelay: st.constraints.launchDelaySeconds,
      launchDelayTolerance: st.constraints.launchDelayToleranceSeconds,
      padSunElevationDeg: st.constraints.padSunElevationDeg,
      landingWindow: [st.constraints.landingWindowDays[0] * 86400, st.constraints.landingWindowDays[1] * 86400],
      landingSunElevationDeg: st.constraints.landingSunElevationDeg,
    };
    const report = checkStartConstraints(
      system,
      { bodyId: site.bodyId, latitude: site.location.latDeg * DEG, longitude: site.location.lonDeg * DEG, elevation: site.location.padElevation as number },
      sc.target!,
      { bodyId: sc.suggestedLanding!.bodyId, latitude: sc.suggestedLanding!.latDeg * DEG, longitude: sc.suggestedLanding!.lonDeg * DEG },
      sc.startUt,
      options,
    );
    expect(report.launch.ok).toBe(true);
    expect(Math.abs(report.launch.delay! - 600)).toBeLessThan(30);
    expect(report.launch.ascending).toBe(false);
    expect(report.launch.launchAzimuthDeg!).toBeCloseTo(st.launch.launchAzimuthDeg, 3);
    expect(report.padSun.ok).toBe(true);
    expect(report.padSun.elevationDeg).toBeGreaterThan(10);
    expect(report.padSun.elevationDeg).toBeLessThan(35);
    expect(report.landingSun.ok).toBe(true);
    expect(report.landingSun.minDeg).toBeGreaterThan(5);
    expect(report.landingSun.maxDeg).toBeLessThan(35);
    expect(report.landingSun.rising).toBe(true);
    expect(report.ok).toBe(true);
  });

  it('lists the seventeen milestones of the mission as generic rules, in order', () => {
    const ids: MilestoneId[] = [
      'LIFTOFF',
      'MAX_Q',
      'STAGE_SEP_1',
      'FAIRING_JETTISON',
      'STAGE_SEP_2',
      'EARTH_ORBIT',
      'TLI_COMPLETE',
      'MOON_SOI_ENTER',
      'LUNAR_ORBIT',
      'LUNAR_TOUCHDOWN',
      'LUNAR_LIFTOFF',
      'MOON_SOI_EXIT',
      'EARTH_PERIGEE_TARGETED',
      'ENTRY_INTERFACE',
      'DROGUE_DEPLOY',
      'MAIN_DEPLOY',
      'SPLASHDOWN',
    ];
    expect(defs.scenarios['lunar-direct']!.milestones.map((m) => m.id)).toEqual(ids);
  });

  it('the pad start: standing on the pad of the site, held by the clamps, terrain resident', async () => {
    const sim = await makeSim(defs, 'lunar-direct', terrain);
    const s = sim.peek();
    const site = defs.sites['ka-lae-lc1']!;
    const v = active(s);
    expect(s.scenario).toEqual({ id: 'lunar-direct', startKind: 'pad', stagesAlreadyFired: 0 });
    expect(v.situation).toBe('prelaunch');
    expect(v.translationMode).toBe('landed');
    expect(v.parts.length).toBe(42);
    expect(s.readouts.latitude * RAD).toBeCloseTo(site.location.latDeg, 5);
    expect(s.readouts.longitude * RAD).toBeCloseTo(site.location.lonDeg, 5);
    expect(s.readouts.speedSurface).toBeLessThan(1e-6);
    expect(Math.abs(s.readouts.speedOrbital - 439)).toBeLessThan(2);
    expect(s.terrain).toEqual({ complete: true, pending: false, incompleteQueries: 0 });
    expect(s.readouts.launchWindow!.timeToPlaneCrossing).toBeCloseTo(600, 3);
    expect(s.readouts.launchWindow!.launchAzimuthDeg).toBeCloseTo(st.launch.launchAzimuthDeg, 3);
    expect(s.surfaceTargets.map((t) => t.kind).sort()).toEqual(['landing', 'recovery', 'recovery', 'recovery', 'site']);
    // The base of the clamps stands on the launch mount: pad elevation + clamp height.
    const base = v3.len(v.r) - 6371000 - (site.location.padElevation as number) - site.pad.clampHeight;
    expect(base).toBeGreaterThan(100);
    expect(base).toBeLessThan(102);
    expect(s.cheatCounter).toBe(0);
  });
});

describe('QA scenarios', () => {
  const ids = ['qa-leo', 'qa-translunar', 'qa-lunar-orbit', 'qa-powered-descent', 'qa-lunar-surface', 'qa-trans-earth', 'qa-entry', 'qa-drogues'];

  it('exist, carry no mission milestones and are not pad starts', () => {
    for (const id of ids) {
      const sc = defs.scenarios[id];
      expect(sc, id).toBeDefined();
      expect(sc!.start.kind, id).not.toBe('pad');
      expect(sc!.milestones.length, id).toBeLessThanOrEqual(3);
      expect(sc!.vehicle).toBe('meridian-lunar');
    }
  });

  it('qa-leo: third stage and lander in the parking orbit, in the plane of the Moon', async () => {
    const sim = await makeSim(defs, 'qa-leo', terrain);
    const s = sim.peek();
    const v = active(s);
    expect(s.scenario.startKind).toBe('state');
    expect(v.bodyId).toBe('earth');
    expect(v.situation).toBe('orbiting');
    expect(v.translationMode).toBe('rails');
    expect(s.readouts.periapsisAltitude).toBeGreaterThan(160000);
    expect(s.readouts.apoapsisAltitude).toBeLessThan(400000);
    expect(s.readouts.targetRelativeInclination! * RAD).toBeLessThan(0.5);
    expect(s.staging.nextStage).toBe(4);
    expect(v.parts.some((p) => p.def === 'meridian-m3')).toBe(true);
    expect(v.parts.some((p) => p.def === 'meridian-m2')).toBe(false);
    expect(Math.abs(v.mass - 154100)).toBeLessThan(200);
  });

  it('qa-translunar: the lander stack on its way to a lunar encounter near 100 km', async () => {
    const sim = await makeSim(defs, 'qa-translunar', terrain);
    const s = sim.peek();
    const v = active(s);
    expect(v.bodyId).toBe('earth');
    expect(s.staging.nextStage).toBe(5);
    expect(v.parts.some((p) => p.def === 'heron-descent-stage')).toBe(true);
    expect(v.parts.some((p) => p.def === 'meridian-m3')).toBe(false);
    const first = s.patches.current[0]!;
    expect(first.endReason).toBe('soiEnter');
    expect(first.nextBodyId).toBe('moon');
    const arrival = s.patches.current[1]!;
    const perilune = arrival.conic.p / (1 + arrival.conic.e) - 1737400;
    expect(perilune).toBeGreaterThan(60000);
    expect(perilune).toBeLessThan(160000);
    expect(s.readouts.altitudeAsl).toBeGreaterThan(5e7);
  });

  it('qa-lunar-orbit: the lander stack in a 100 km lunar orbit', async () => {
    const sim = await makeSim(defs, 'qa-lunar-orbit', terrain);
    const s = sim.peek();
    const v = active(s);
    expect(v.bodyId).toBe('moon');
    expect(v.situation).toBe('orbiting');
    expect(s.readouts.eccentricity).toBeLessThan(0.05);
    expect(s.readouts.periapsisAltitude).toBeGreaterThan(80000);
    expect(s.readouts.apoapsisAltitude).toBeLessThan(130000);
    expect(s.staging.nextStage).toBe(5);
    expect(s.readouts.legsDeployed).toBe(false);
    expect(s.readouts.landingTarget).not.toBeNull();
    expect(s.readouts.landingTarget!.targetId).toBe('landing');
  });

  it('qa-powered-descent: on the descent orbit, perilune near 15 km, the landing target ahead', async () => {
    const sim = await makeSim(defs, 'qa-powered-descent', terrain);
    await settleTerrain(sim);
    const s = sim.peek();
    const v = active(s);
    expect(v.bodyId).toBe('moon');
    expect(s.readouts.periapsisAltitude).toBeGreaterThan(11000);
    expect(s.readouts.periapsisAltitude).toBeLessThan(19000);
    expect(s.readouts.legsDeployed).toBe(true);
    expect(s.staging.nextStage).toBe(6);
    const lt = s.readouts.landingTarget!;
    expect(lt.downRange).toBeGreaterThan(300000);
    expect(lt.downRange).toBeLessThan(1.7e6);
    expect(Math.abs(lt.crossRange)).toBeLessThan(20000);
    // The perilune of the descent orbit lies up-range of the target.
    expect(s.readouts.timeToPeriapsis).not.toBeNull();
    expect(s.readouts.timeToPeriapsis! * s.readouts.speedSurface).toBeLessThan(lt.downRange);
  });

  it('qa-lunar-surface: landed at the target on the finest lunar data, at rest', async () => {
    const sim = await makeSim(defs, 'qa-lunar-surface', terrain);
    await settleTerrain(sim);
    const s = sim.peek();
    const v = active(s);
    expect(s.scenario.startKind).toBe('landed');
    expect(v.bodyId).toBe('moon');
    expect(v.situation).toBe('landed');
    expect(v.translationMode).toBe('landed');
    expect(s.readouts.landingTarget!.distance).toBeLessThan(20);
    expect(s.readouts.speedSurface).toBeLessThan(1e-3);
    expect(s.readouts.altitudeRadar).toBe(0);
    expect(s.readouts.tiltFromVertical * RAD).toBeLessThan(6);
    expect(s.readouts.legsDeployed).toBe(true);
    expect(s.terrain.complete).toBe(true);
    const legs = v.parts.flatMap((p) => p.modules).find((m) => m.type === 'legs');
    expect(legs && legs.type === 'legs' && legs.broken.every((b) => !b)).toBe(true);
    // Still there after a minute of physics and an hour of warp.
    for (let i = 0; i < 120 * 60; i++) sim.step();
    sim.commands.setWarpLevel(8);
    for (let i = 0; i < 300; i++) sim.advance(1 / 60);
    const later = sim.peek();
    expect(active(later).situation).toBe('landed');
    expect(later.readouts.landingTarget!.distance).toBeCloseTo(s.readouts.landingTarget!.distance, 3);
    expect(later.terrain.incompleteQueries).toBe(0);
  });

  it('qa-trans-earth: ascent stage and capsule falling home with a vacuum perigee in the entry corridor', async () => {
    const sim = await makeSim(defs, 'qa-trans-earth', terrain);
    const s = sim.peek();
    const v = active(s);
    expect(v.bodyId).toBe('earth');
    expect(s.staging.nextStage).toBe(7);
    expect(v.parts.some((p) => p.def === 'heron-ascent-stage')).toBe(true);
    expect(v.parts.some((p) => p.def === 'heron-descent-stage')).toBe(false);
    expect(s.readouts.verticalSpeed).toBeLessThan(0);
    const entry = s.patches.current.flatMap((p) => p.markers).find((m) => m.kind === 'atmosphereEntry');
    expect(entry).toBeDefined();
    expect(entry!.vacuumPeriapsisAltitude!).toBeGreaterThan(30000);
    expect(entry!.vacuumPeriapsisAltitude!).toBeLessThan(60000);
    expect(s.readouts.landingTarget!.predicted!.kind).toBe('entry');
  });

  it('qa-entry: the capsule five minutes before the entry interface, 45 km vacuum perigee, aimed at a recovery zone', async () => {
    const sim = await makeSim(defs, 'qa-entry', terrain);
    const s = sim.peek();
    const v = active(s);
    expect(v.parts.map((p) => p.def).sort()).toEqual(['kestrel-apex-cover', 'kestrel-capsule']);
    expect(s.staging.nextStage).toBe(8);
    expect(s.readouts.rcsFraction).toBe(1);
    expect(s.readouts.ablatorFraction).toBe(1);
    const entry = s.patches.current.flatMap((p) => p.markers).find((m) => m.kind === 'atmosphereEntry')!;
    expect(entry.vacuumPeriapsisAltitude!).toBeGreaterThan(30000);
    expect(entry.vacuumPeriapsisAltitude!).toBeLessThan(60000);
    expect(entry.value!).toBeGreaterThan(10900);
    expect(entry.value!).toBeLessThan(11100);
    // About five minutes to the 122 km interface.
    const toInterface = (s.readouts.altitudeAsl - 122000) / -s.readouts.verticalSpeed;
    expect(toInterface).toBeGreaterThan(200);
    expect(toInterface).toBeLessThan(360);
    // The entry point lies within one entry down-range (about 3 000 km) of the edge of a recovery zone.
    const lt = s.readouts.landingTarget!;
    const zone = s.surfaceTargets.find((t) => t.id === lt.targetId)!;
    expect(zone.kind).toBe('recovery');
    expect(lt.predicted!.missDistance).toBeLessThan(zone.radius + 3.6e6);
  });

  it('qa-drogues: the capsule under its drogues at 7 km over water inside a recovery zone', async () => {
    const sim = await makeSim(defs, 'qa-drogues', terrain);
    await settleTerrain(sim);
    const s = sim.peek();
    const v = active(s);
    expect(s.readouts.altitudeAsl).toBeGreaterThan(6000);
    expect(s.readouts.altitudeAsl).toBeLessThan(7100);
    expect(s.staging.nextStage).toBe(9);
    const chutes = v.parts.flatMap((p) => p.modules).filter((m) => m.type === 'parachute');
    expect(chutes.some((m) => m.type === 'parachute' && m.state !== 'stowed' && m.inflation > 0)).toBe(true);
    const lt = s.readouts.landingTarget!;
    const zone = s.surfaceTargets.find((t) => t.id === lt.targetId)!;
    expect(zone.kind).toBe('recovery');
    expect(lt.distance).toBeLessThan(zone.radius);
    // Fly it for half a minute: it comes down on the drogues at a few tens of metres per second.
    for (let i = 0; i < 120 * 30; i++) {
      sim.step();
      await settleTerrain(sim);
    }
    const later = sim.peek();
    expect(later.readouts.verticalSpeed).toBeLessThan(-25);
    expect(later.readouts.verticalSpeed).toBeGreaterThan(-90);
    expect(later.mission.failed).toBe(false);
    expect(later.terrain.incompleteQueries).toBe(0);
  });
});
