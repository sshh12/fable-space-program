/**
 * The generic milestone evaluator: scenarios with their OWN rule lists and names run through the same
 * simulation as the lunar mission. The simulation source contains no milestone id and no mission rule.
 */
import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { DefLibrary, MilestoneRuleDef, ScenarioDef } from '@/core/contracts/defs';
import type { TerrainProvider } from '@/core/contracts/terrain';
import { repoRoot } from '../../../tools/sim/realWorld';
import { active, controls, flatTerrain, loadLibrary, makeSim, stepUntil } from './helpers';

let defs: DefLibrary;
let terrain: TerrainProvider;
beforeAll(async () => {
  defs = await loadLibrary();
  terrain = flatTerrain(defs, { earth: 21.62, moon: -1900 });
});

const withRules = (baseId: string, id: string, milestones: MilestoneRuleDef[]): ScenarioDef => ({ ...defs.scenarios[baseId]!, id, name: id, milestones });

describe('generic milestones', () => {
  it('a sounding flight with its own rule list: lift-off, altitude crossings, max-q, stage, ordering by `after`', async () => {
    const rules: MilestoneRuleDef[] = [
      { id: 'clamps-off', trigger: { kind: 'liftoff' } },
      { id: 'one-kilometre-up', trigger: { kind: 'altitudeCrossing', bodyId: 'earth', altitude: 1000, direction: 'ascending' }, after: ['clamps-off'] },
      // Armed only after the pressure peak, although the vehicle passes 5 km long before it.
      { id: 'pressure-peak', trigger: { kind: 'maxQ' } },
      { id: 'five-up-late', trigger: { kind: 'altitudeCrossing', bodyId: 'earth', altitude: 5000, direction: 'ascending' }, after: ['pressure-peak'] },
      { id: 'thirty-up', trigger: { kind: 'altitudeCrossing', bodyId: 'earth', altitude: 30000, direction: 'ascending' }, after: ['pressure-peak'] },
      { id: 'booster-gone', trigger: { kind: 'stageFired', stageIndex: 1 }, after: ['clamps-off'] },
      { id: 'never-an-orbit', trigger: { kind: 'orbit', bodyId: 'moon', minPeriapsisAltitude: 10000 } },
      { id: 'never-a-chute', trigger: { kind: 'chuteDeployed', mode: 'main' } },
      { id: 'coming-down', trigger: { kind: 'altitudeCrossing', bodyId: 'earth', altitude: 60000, direction: 'descending' }, after: ['booster-gone'] },
    ];
    const sim = await makeSim(defs, withRules('lunar-direct', 'sounding-flight', rules), terrain);
    sim.commands.setSasEnabled(true);
    sim.setControls(controls({ throttle: 1 }));
    expect(sim.commands.stage().ok).toBe(true);
    // Straight up on the first stage until it is spent, then drop it and coast over the top.
    const spent = stepUntil(sim, (s) => s.readouts.met > 30 && s.readouts.thrust < 1e6, 120 * 200);
    expect(spent).toBeGreaterThan(0);
    expect(sim.commands.stage().ok).toBe(true);
    sim.setControls(controls());
    const down = stepUntil(sim, (s) => s.milestones.some((m) => m.id === 'coming-down'), 120 * 900);
    expect(down).toBeGreaterThan(0);
    const s = sim.peek();
    const ids = s.milestones.map((m) => m.id);
    expect(ids).toEqual(['clamps-off', 'one-kilometre-up', 'pressure-peak', 'thirty-up', 'booster-gone', 'coming-down']);
    const by = (id: string) => s.milestones.find((m) => m.id === id)!;
    // Standard data set on every record.
    for (const m of s.milestones) {
      for (const k of ['ut', 'met', 'altitude', 'radarAltitude', 'latitudeDeg', 'longitudeDeg', 'speedOrbital', 'speedSurface', 'verticalSpeed', 'horizontalSpeed', 'mass', 'peakG', 'gDose', 'ablatorFraction', 'rcsFraction']) {
        expect(Number.isFinite(m.data[k]), `${m.id}.${k}`).toBe(true);
      }
      expect(m.data['ut']).toBe(m.ut);
    }
    expect(by('clamps-off').data['speedSurface']!).toBeLessThan(0.1);
    expect(by('one-kilometre-up').data['altitude']!).toBeGreaterThan(1000);
    expect(by('one-kilometre-up').data['altitude']!).toBeLessThan(1010);
    expect(by('one-kilometre-up').data['crossingAltitude']).toBe(1000);
    // A vertical flight sees a higher peak than the mission's gravity turn.
    expect(by('pressure-peak').data['peakDynamicPressure']!).toBeGreaterThan(20000);
    expect(by('pressure-peak').data['peakDynamicPressureAltitude']!).toBeLessThan(by('pressure-peak').data['altitude']!);
    expect(by('booster-gone').data['stageIndex']).toBe(1);
    expect(by('booster-gone').data['vesselsSeparated']!).toBeGreaterThanOrEqual(1);
    expect(by('booster-gone').data['propellantFraction:m1']).toBeUndefined();
    // (The second stage's group includes its ullage motors, which have fired.)
    expect(by('booster-gone').data['propellantFraction:m2']!).toBeGreaterThan(0.999);
    expect(by('clamps-off').data['propellantFraction:m1']!).toBeGreaterThan(0.98);
    expect(by('coming-down').data['verticalSpeed']!).toBeLessThan(0);
    // The milestone events were queued, one per record, in order.
    const events = s.events.filter((e) => e.type === 'milestone').map((e) => (e.type === 'milestone' ? e.milestone.id : ''));
    expect(events).toEqual(ids);
    expect(s.mission.failed).toBe(false);
  });

  it('orbit, predicted periapsis and encounter rules on other scenarios, under other names', async () => {
    const orbit = await makeSim(
      defs,
      withRules('qa-lunar-orbit', 'orbit-rules', [
        { id: 'round-the-moon', trigger: { kind: 'orbit', bodyId: 'moon', minPeriapsisAltitude: 60000, maxEccentricity: 0.05 } },
        { id: 'too-tight', trigger: { kind: 'orbit', bodyId: 'moon', minPeriapsisAltitude: 60000, maxApoapsisAltitude: 70000 } },
        { id: 'wrong-body', trigger: { kind: 'orbit', bodyId: 'earth', minPeriapsisAltitude: 0 } },
        { id: 'low-pass', trigger: { kind: 'predictedPeriapsis', bodyId: 'moon', minAltitude: 80000, maxAltitude: 130000 }, after: ['round-the-moon'] },
      ]),
      terrain,
    );
    for (let i = 0; i < 8; i++) orbit.step();
    const so = orbit.peek();
    expect(so.milestones.map((m) => m.id)).toEqual(['round-the-moon', 'low-pass']);
    const rec = so.milestones[0]!;
    expect(rec.data['eccentricity']!).toBeLessThan(0.05);
    expect(rec.data['periapsisAltitude']!).toBeGreaterThan(80000);
    expect(rec.data['period']!).toBeGreaterThan(6500);
    expect(so.milestones[1]!.data['predictedPeriapsisAltitude']!).toBeCloseTo(rec.data['periapsisAltitude']!, -2);

    const coast = await makeSim(
      defs,
      withRules('qa-translunar', 'coast-rules', [
        { id: 'moon-ahead', trigger: { kind: 'encounterPredicted', bodyId: 'moon' } },
        { id: 'arrived', trigger: { kind: 'soiEnter', bodyId: 'moon' }, after: ['moon-ahead'] },
        { id: 'left-earth', trigger: { kind: 'soiExit', bodyId: 'earth' } },
      ]),
      terrain,
    );
    for (let i = 0; i < 8; i++) coast.step();
    expect(coast.peek().milestones.map((m) => m.id)).toEqual(['moon-ahead']);
    const predicted = coast.peek().milestones[0]!.data['predictedSoiUt']!;
    let guard = 0;
    while (active(coast.peek()).bodyId !== 'moon' && guard++ < 100000) {
      coast.commands.setWarpLevel(10);
      coast.advance(1 / 60);
    }
    const sc = coast.peek();
    expect(sc.milestones.map((m) => m.id)).toEqual(['moon-ahead', 'arrived']);
    const arrived = sc.milestones[1]!;
    expect(arrived.data['soiTimeError']!).toBeLessThan(2);
    expect(Math.abs(arrived.ut - predicted)).toBeLessThan(2);
    expect(arrived.data['predictedSoiUt']!).toBeCloseTo(predicted, 2);
  });

  it('touchdown and lift-off-from-surface rules on the landed scenario', async () => {
    const sim = await makeSim(
      defs,
      withRules('qa-lunar-surface', 'surface-rules', [
        { id: 'standing', trigger: { kind: 'touchdown', bodyId: 'moon', surface: 'land', settleTime: 2 } },
        { id: 'not-water', trigger: { kind: 'touchdown', bodyId: 'moon', surface: 'water', settleTime: 0 } },
        { id: 'away', trigger: { kind: 'liftoffFromSurface', bodyId: 'moon', minAltitude: 30 }, after: ['standing'] },
      ]),
      terrain,
    );
    for (let i = 0; i < 120 * 3; i++) sim.step();
    let s = sim.peek();
    expect(s.milestones.map((m) => m.id)).toEqual(['standing']);
    const td = s.milestones[0]!;
    expect(td.data['legsIntact']).toBe(1);
    expect(td.data['legs']).toBe(4);
    expect(td.data['surfaceWater']).toBe(0);
    expect(td.data['distanceToLandingTarget']!).toBeLessThan(30);
    expect(td.data['tiltDeg']!).toBeLessThan(10);
    expect(td.data['recoveryZoneDistance']).toBe(-1);
    // Fire-in-the-hole lift-off: the ascent stage leaves the descent stage behind.
    sim.commands.setSasEnabled(true);
    sim.setControls(controls({ throttle: 1 }));
    expect(sim.commands.stage().ok).toBe(true);
    const up = stepUntil(sim, (x) => x.milestones.some((m) => m.id === 'away'), 120 * 60);
    expect(up).toBeGreaterThan(0);
    s = sim.peek();
    const away = s.milestones.find((m) => m.id === 'away')!;
    expect(away.data['radarAltitude']!).toBeGreaterThanOrEqual(30);
    expect(away.data['vesselsLeftOnSurface']).toBe(1);
    expect(away.data['surfaceStay']!).toBeGreaterThan(3);
    const left = s.vessels.find((v) => v.id !== s.activeVesselId && v.parts.some((p) => p.def === 'heron-descent-stage'))!;
    expect(left).toBeDefined();
    expect(left.controllable).toBe(false);
  });

  it('the simulation source knows no milestone id of the lunar mission', () => {
    const ids = defs.scenarios['lunar-direct']!.milestones.map((m) => m.id);
    expect(ids).toHaveLength(17);
    const walk = (dir: string, out: string[]): string[] => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p, out);
        else if (e.name.endsWith('.ts') && !e.name.endsWith('.test.ts')) out.push(p);
      }
      return out;
    };
    const hits: string[] = [];
    for (const file of walk(path.join(repoRoot, 'src', 'sim'), [])) {
      const text = fs.readFileSync(file, 'utf8');
      for (const id of ids) if (new RegExp(`['"\`]${id}['"\`]`).test(text)) hits.push(`${path.relative(repoRoot, file)}: ${id}`);
      for (const word of ['lunar-direct', 'meridian-lunar', 'ka-lae']) if (text.includes(word)) hits.push(`${path.relative(repoRoot, file)}: ${word}`);
    }
    expect(hits).toEqual([]);
  });
});
