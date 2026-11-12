/**
 * Scenario files: the start time of `lunar-direct` still satisfies the three start constraints for the
 * site and target of the definitions, and every QA scenario loads into a self-consistent state.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { DefLibrary } from '@/core/contracts/defs';
import type { MilestoneId, VesselSnapshot } from '@/core/contracts/sim';
import type { TerrainProvider } from '@/core/contracts/terrain';
import { DEG, RAD } from '@/core/math/scalar';
import { v3 } from '@/core/math/vec3';
import { createBodySystem } from '@/sim/bodies';
import { checkStartConstraints, type StartConstraintOptions, type StartLaunchKind } from '@/sim/nav';
import { repoRoot } from '../../../tools/sim/realWorld';
import { active, createRealTerrain, loadLibrary, makeSim, orbitScenario, settleTerrain } from './helpers';

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
    // (the start is the crossing minus 600 s snapped to the tick grid: half a tick from it at most)
    expect(Math.abs(s.readouts.launchWindow!.timeToPlaneCrossing - 600)).toBeLessThanOrEqual(0.5 / 120 + 1e-6);
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

  it('start with the resources of that point of the mission (ScenarioDef.resources), not with full tanks', async () => {
    const dryMass = (v: VesselSnapshot): number => v.parts.reduce((n, p) => n + defs.parts[p.def]!.dryMass, 0);
    const fraction = (v: VesselSnapshot, part: string, resources: string[]): number => {
      const p = v.parts.find((x) => x.instanceId === part)!;
      const tanks = defs.parts[p.def]!.resources!.filter((r) => resources.includes(r.resource));
      return tanks.reduce((n, r) => n + p.resources[r.resource]!, 0) / tanks.reduce((n, r) => n + r.capacity, 0);
    };
    const masses: Record<string, number> = {};
    const starts: Record<string, VesselSnapshot> = {};
    for (const id of ids) {
      const sc = defs.scenarios[id]!;
      expect(sc.resources, id).toBeDefined();
      const sim = await makeSim(defs, id, terrain);
      const v = active(sim.peek());
      starts[id] = v;
      masses[id] = v.mass;
      // Every tank, thruster-propellant and ablator amount of the start vessel is the scenario's.
      let onBoard = 0;
      let listed = 0;
      for (const p of v.parts) {
        const held = Object.entries(p.resources);
        if (held.length === 0) continue;
        const amounts = sc.resources![p.instanceId];
        expect(amounts, `${id}: ${p.instanceId}`).toBeDefined();
        for (const [res, kg] of held) {
          expect(amounts![res], `${id}: ${p.instanceId} ${res}`).toBeDefined();
          // (To the gram the file is written in; a full tank is its capacity.)
          expect(Math.abs(kg - amounts![res]!), `${id}: ${p.instanceId} ${res}`).toBeLessThan(1e-3);
          onBoard += kg;
          listed++;
        }
      }
      expect(listed, id).toBeGreaterThan(0);
      // (The scenario lists nothing that is not on board.)
      expect(Object.values(sc.resources!).reduce((n, part) => n + Object.keys(part).length, 0), id).toBe(listed);
      expect(v.mass, id).toBeCloseTo(dryMass(v) + onBoard, 3);
    }
    const engine = ['LOX', 'CH4', 'LH2'];
    // Parking orbit: the third stage has not burnt yet (the second stage made the orbit).
    expect(fraction(starts['qa-leo']!, 'm3', engine)).toBeGreaterThan(0.9);
    // On the way out the lander has spent a few metres per second on the first correction.
    expect(fraction(starts['qa-translunar']!, 'descent-stage', engine)).toBeGreaterThan(0.97);
    expect(fraction(starts['qa-translunar']!, 'descent-stage', engine)).toBeLessThan(1);
    // In lunar orbit the insertion burn is behind it; the descent orbit costs a few metres per second more.
    const inOrbit = fraction(starts['qa-lunar-orbit']!, 'descent-stage', engine);
    expect(inOrbit).toBeGreaterThan(0.5);
    expect(inOrbit).toBeLessThan(0.8);
    const descending = fraction(starts['qa-powered-descent']!, 'descent-stage', engine);
    expect(descending).toBeLessThan(inOrbit);
    expect(descending).toBeGreaterThan(inOrbit - 0.03);
    // Landed: the descent tanks hold the landing margin (the mission lands with about 5 t of 36 t), the
    // ascent stage is untouched; the lander weighs what the mission's lander weighs at touchdown, not 56.8 t.
    const landed = starts['qa-lunar-surface']!;
    expect(fraction(landed, 'descent-stage', engine)).toBeGreaterThan(0.05);
    expect(fraction(landed, 'descent-stage', engine)).toBeLessThan(0.25);
    expect(fraction(landed, 'ascent-stage', engine)).toBeGreaterThan(0.999);
    expect(masses['qa-lunar-surface']!).toBeGreaterThan(22000);
    expect(masses['qa-lunar-surface']!).toBeLessThan(30000);
    // On the way home the ascent stage is nearly spent.
    expect(fraction(starts['qa-trans-earth']!, 'ascent-stage', engine)).toBeGreaterThan(0.03);
    expect(fraction(starts['qa-trans-earth']!, 'ascent-stage', engine)).toBeLessThan(0.3);
    // Under the drogues the entry has burnt a good part of the ablator and a little thruster propellant.
    const drogues = starts['qa-drogues']!;
    expect(fraction(drogues, 'capsule', ['Ablator'])).toBeGreaterThan(0.3);
    expect(fraction(drogues, 'capsule', ['Ablator'])).toBeLessThan(0.8);
    expect(fraction(drogues, 'capsule', ['RCSProp'])).toBeGreaterThan(0.8);
    expect(fraction(drogues, 'capsule', ['RCSProp'])).toBeLessThan(0.99);
    const shield = drogues.parts.flatMap((p) => p.modules).find((m) => m.type === 'heatShield');
    expect(shield && shield.type === 'heatShield' ? shield.ablatorFraction : NaN).toBeCloseTo(fraction(drogues, 'capsule', ['Ablator']), 9);
  });

  it('ScenarioDef.resources: listed amounts override, everything else keeps the vehicle amount, dropped parts are passed over', async () => {
    const base = orbitScenario(defs.scenarios['lunar-direct']!, 't-resources', 'moon', 100000, 100000, 5);
    const full = active((await makeSim(defs, base, terrain)).peek());
    const sc = { ...base, id: 't-resources-set', resources: { 'descent-stage': { LOX: 1000 }, capsule: { Ablator: 60, RCSProp: 0 }, m1: { LOX: 5 } } };
    const sim = await makeSim(defs, sc, terrain);
    const v = active(sim.peek());
    const part = (x: VesselSnapshot, id: string) => x.parts.find((p) => p.instanceId === id)!;
    expect(part(v, 'descent-stage').resources['LOX']).toBe(1000);
    expect(part(v, 'descent-stage').resources['CH4']).toBe(part(full, 'descent-stage').resources['CH4']);
    expect(part(v, 'ascent-stage').resources).toEqual(part(full, 'ascent-stage').resources);
    expect(part(v, 'capsule').resources['Ablator']).toBe(60);
    expect(part(v, 'capsule').resources['RCSProp']).toBe(0);
    expect(v.parts.some((p) => p.instanceId === 'm1')).toBe(false);
    // Mass, the centre of mass and the read-outs follow.
    const removed = part(full, 'descent-stage').resources['LOX']! - 1000 + (150 - 60) + 150;
    expect(v.mass).toBeCloseTo(full.mass - removed, 6);
    expect(v.comLocal.y).toBeGreaterThan(full.comLocal.y);
    expect(sim.peek().readouts.ablatorFraction!).toBeCloseTo(0.4, 12);
    expect(sim.peek().readouts.mass).toBeCloseTo(v.mass, 6);
    // On its conic from the first moment: the start state is that of the lighter vehicle.
    expect(v.translationMode).toBe('rails');
    expect(sim.cheatCounter).toBe(0);
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
    // The shield is untouched, and so nearly are the capsule's thrusters: the service stage turned the
    // stack heat shield forward before it let go.
    expect(s.readouts.rcsFraction!).toBeGreaterThan(0.97);
    expect(s.readouts.rcsFraction!).toBeLessThanOrEqual(1);
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
