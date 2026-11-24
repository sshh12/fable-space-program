/**
 * analyzeVehicle against hand-computed rocket-equation values (fleet-data acceptance: the Meridian stack and
 * two new vehicles to 0.5 %). The masses are added up here from the part files, stage by stage, as a person
 * with the sheets would: what each stage drops, what each burn consumes. Nothing of the analyser is used to
 * get them.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { DefLibrary, VehicleDef } from '@/core/contracts/defs';
import { fsDefSource } from '@/core/defs/fsSource';
import { loadDefs } from '@/core/defs/loader';
import { analyzeVehicle, deltaVToLowOrbit, idealDeltaV, launchBodyOf } from '@/sim/vessel/analyze';

const G0 = 9.80665;
let lib: DefLibrary;
beforeAll(async () => {
  lib = await loadDefs(fsDefSource());
});

const dry = (def: string): number => lib.parts[def]!.dryMass;
const cap = (def: string, ...res: string[]): number => (lib.parts[def]!.resources ?? []).filter((r) => res.length === 0 || res.includes(r.resource)).reduce((s, r) => s + r.capacity, 0);
const full = (def: string): number => dry(def) + cap(def);
const isClampDef = (def: string): boolean => lib.parts[def]!.modules.some((m) => m.type === 'launchClamp');
/** Lift-off mass: every part of the vehicle, full, but the clamps (they stay on the pad). */
const liftoff = (v: VehicleDef): number => v.parts.filter((p) => !isClampDef(p.def)).reduce((s, p) => s + full(p.def), 0);
const rocket = (isp: number, m0: number, m1: number): number => isp * G0 * Math.log(m0 / m1);
const ispOf = (def: string): number => {
  const m = lib.parts[def]!.modules.find((x) => x.type === 'engine');
  if (!m || m.type !== 'engine') throw new Error(def);
  return m.ispVac;
};
const near = (got: number, want: number, what: string): void => {
  expect(Math.abs(got - want) / want, `${what}: ${got.toFixed(1)} against ${want.toFixed(1)}`).toBeLessThan(0.005);
};

describe('analyzeVehicle: delta-v per stage against the rocket equation by hand (0.5 %)', () => {
  it('the Meridian lunar stack: M-1, M-2, M-3, the Heron descent and ascent stages', () => {
    const v = lib.vehicles['meridian-lunar']!;
    const c = analyzeVehicle(lib, v);
    const L = liftoff(v);
    near(c.massWet, L, 'lift-off mass');
    // M-1: nine Atlas-9M on the M-1 tanks.
    const m1Prop = cap('meridian-m1', 'LOX', 'CH4');
    near(c.stages[0]!.deltaVVac, rocket(ispOf('atlas-9m'), L, L - m1Prop), 'M-1');
    // M-2: the M-1 side gone (tanks, interstage, nine engines, the retro motors with their propellant), the
    // ullage motors' propellant burnt, and the tower (with its jettison motor) and the lander fairing jettisoned early in the burn.
    let m0 = L - m1Prop - dry('meridian-m1') - dry('meridian-interstage-1') - 9 * dry('atlas-9m') - full('meridian-m1-retro-motors') - cap('meridian-m2-ullage-motors') - full('kestrel-les') - full('kestrel-les-jettison-motor') - dry('meridian-lander-fairing');
    const m2Prop = cap('meridian-m2', 'LOX', 'LH2');
    near(c.stages[1]!.deltaVVac, rocket(ispOf('vela-2'), m0, m0 - m2Prop), 'M-2');
    expect(c.stages[2]!.deltaVVac).toBe(0);
    // M-3: the M-2 side gone (tanks, six engines, the spent ullage motors, the interstage).
    m0 = m0 - m2Prop - dry('meridian-m2') - 6 * dry('vela-2') - dry('meridian-m2-ullage-motors') - dry('meridian-interstage-2');
    const m3Prop = cap('meridian-m3', 'LOX', 'LH2');
    near(c.stages[3]!.deltaVVac, rocket(ispOf('vela-2v'), m0, m0 - m3Prop), 'M-3');
    // Heron descent: the M-3, its engine, its two RCS pods (full: their thrusters' propellant is not burnt) and the payload adapter gone.
    m0 = m0 - m3Prop - dry('meridian-m3') - dry('vela-2v') - 2 * full('meridian-m3-rcs-pod') - dry('meridian-payload-adapter');
    const dProp = cap('heron-descent-stage', 'LOX', 'CH4');
    near(c.stages[4]!.deltaVVac, rocket(ispOf('lyra-d'), m0, m0 - dProp), 'Heron descent');
    // Heron ascent: the descent stage (with its RCS propellant), its engine, legs and the separator left on the Moon.
    m0 = m0 - dProp - dry('heron-descent-stage') - cap('heron-descent-stage', 'RCSProp') - dry('lyra-d') - dry('heron-landing-legs') - dry('heron-stage-separator');
    const aProp = cap('heron-ascent-stage', 'LOX', 'CH4');
    near(c.stages[6]!.deltaVVac, rocket(ispOf('lyra-a'), m0, m0 - aProp), 'Heron ascent');
  });

  it('Azimuth 1 / Pathfinder: both stages and the probe (fleet-docking 2.3: 4 205, 6 170, 4 999 m/s)', () => {
    const v = lib.vehicles['azimuth-pathfinder']!;
    const c = analyzeVehicle(lib, v);
    const L = liftoff(v);
    near(c.massWet, L, 'lift-off mass');
    const s1Prop = cap('azimuth-s1');
    near(c.stages[0]!.deltaVVac, rocket(330, L, L - s1Prop), 'stage 1');
    const m0 = L - s1Prop - dry('azimuth-s1') - 5 * dry('wren-1') - dry('azimuth-interstage') - dry('azimuth-fairing');
    near(c.stages[1]!.deltaVVac, rocket(355, m0, m0 - cap('azimuth-s2')), 'stage 2');
    const probe = full('pathfinder-bus') + dry('lyra-k');
    near(c.stages[3]!.deltaVVac, rocket(325, probe, probe - cap('pathfinder-bus')), 'probe');
    near(c.stages[3]!.deltaVVac, 4999, 'probe against the sheet');
  });

  it('Solstice / Pelican: with a 23 t payload the ideal ascent is about 9.9 km/s (fleet-docking 2.3: 9 910)', () => {
    const v = lib.vehicles['solstice-pelican']!;
    const c = analyzeVehicle(lib, v);
    const L = liftoff(v);
    const s1Prop = cap('solstice-s1');
    near(c.stages[0]!.deltaVVac, rocket(350, L, L - s1Prop), 'stage 1');
    const m0 = L - s1Prop - dry('solstice-s1') - 2 * dry('atlas-9m') - dry('solstice-interstage') - dry('fairing-6m6-ogive');
    near(c.stages[1]!.deltaVVac, rocket(452, m0, m0 - cap('meridian-m3', 'LOX', 'LH2')), 'stage 2');
    const payload = full('pelican-tank') + dry('lyra-d') + full('avionics-ring-4') + 2 * full('dock-port-c') + 4 * full('rcs-quad-220');
    expect(payload).toBeCloseTo(23000, 6);
    near(c.stages[3]!.deltaVVac, rocket(360, payload, payload - cap('pelican-tank', 'LOX', 'CH4')), 'Pelican');
    near(c.stages[3]!.deltaVVac, 5839, 'Pelican against the sheet');
    // The ideal sum to orbit: the lift-off stage at the mean of its sea-level and vacuum figures.
    const ideal = idealDeltaV(c.stages.slice(0, 2));
    expect(ideal).toBeGreaterThan(9800);
    expect(ideal).toBeLessThan(10000);
  });

  it('the Albatross has 10.9 km/s from low Earth orbit (+/- 2 %), and the Egret 6 261 m/s', () => {
    const alb = analyzeVehicle(lib, lib.vehicles['meridian-albatross']!);
    const cruiser = alb.stages.find((s) => s.label === 'Cruiser separation')!;
    expect(Math.abs(cruiser.deltaVVac - 10900) / 10900).toBeLessThan(0.02);
    expect(cruiser.massStart).toBeCloseTo(146600, 0);
    // A 20-minute departure burn: the three engines empty the tanks in about 1 224 s.
    expect(cruiser.burnTime).toBeGreaterThan(1150);
    expect(cruiser.burnTime).toBeLessThan(1300);
    const egret = analyzeVehicle(lib, lib.vehicles['meridian-egret']!);
    near(egret.stages.find((s) => s.label === 'Ferry separation')!.deltaVVac, 6261, 'Egret');
  });
});

describe('analyzeVehicle: the read-outs of the hangar', () => {
  it('every vehicle reaches low orbit of its launch body and is classified for a pad', () => {
    const body = launchBodyOf(lib);
    const toOrbit = deltaVToLowOrbit(lib, body);
    expect(toOrbit).toBeGreaterThan(9000);
    expect(toOrbit).toBeLessThan(9700);
    const classes: Record<string, string> = {};
    for (const v of Object.values(lib.vehicles)) {
      const c = analyzeVehicle(lib, v);
      expect(c.deltaVInOrbit, v.id).not.toBeNull();
      expect(c.stages).toHaveLength(v.stages.length);
      classes[v.id] = c.padClass;
    }
    expect(classes).toMatchObject({ 'azimuth-pathfinder': 'light', 'solstice-kestrel': 'medium', 'solstice-atoll': 'medium', 'solstice-pelican': 'medium', 'meridian-lunar': 'heavy', 'meridian-egret': 'heavy', 'meridian-albatross': 'heavy', 'meridian-pelican-heavy': 'heavy' });
  });

  it('crew, command and first-person view; ports by type and whether they are free at launch; RCS, wheels, shields, chutes, legs', () => {
    const kestrel = analyzeVehicle(lib, lib.vehicles['solstice-kestrel']!);
    expect(kestrel).toMatchObject({ crewCapacity: 3, remote: false, firstPerson: 'cockpit', cockpit: 'kestrel', rcs: true, parachutes: true, legs: false });
    // The escape tower stands on the ferry's port: occupied at launch.
    expect(kestrel.ports).toEqual([{ part: 'sc-port', portType: 'c', freeAtLaunch: false }]);
    expect(kestrel.rcsDeltaV).toBeGreaterThan(180);
    expect(kestrel.rcsDeltaV).toBeLessThan(240);
    expect(kestrel.entrySpeedLimit).toBeGreaterThan(11000);
    expect(kestrel.transferable).toEqual(['CH4', 'LOX', 'RCSProp']);
    const atoll = analyzeVehicle(lib, lib.vehicles['solstice-atoll']!);
    expect(atoll.ports.map((p) => p.portType).sort()).toEqual(['c', 'c', 'c', 'c', 'h', 'h']);
    expect(atoll).toMatchObject({ remote: true, firstPerson: 'sensorCamera', cockpit: null, crewCapacity: 6, entrySpeedLimit: null });
    const egret = analyzeVehicle(lib, lib.vehicles['meridian-egret']!);
    expect(egret).toMatchObject({ firstPerson: 'cockpit', cockpit: 'kestrel', remote: true, legs: true, parachutes: false, entrySpeedLimit: null });
    const albatross = analyzeVehicle(lib, lib.vehicles['meridian-albatross']!);
    expect(albatross.transferable).toContain('LH2');
    expect(albatross.ports.map((p) => `${p.part}:${p.portType}`)).toEqual(['sc-nose-port:c', 'sc-side-port:h']);
  });

  it('the can-reach ladder comes from the bodies of the library, nearest first, never authored', () => {
    const c = analyzeVehicle(lib, lib.vehicles['azimuth-pathfinder']!);
    const bodies = new Set(c.reach.map((r) => r.bodyId));
    for (const b of bodies) expect(lib.bodies[b]).toBeDefined();
    for (let i = 1; i < c.reach.length; i++) expect(c.reach[i]!.deltaVRequired).toBeGreaterThanOrEqual(c.reach[i - 1]!.deltaVRequired);
    for (const r of c.reach) expect(r.margin).toBeCloseTo(c.deltaVInOrbit! - r.deltaVRequired, 6);
  });

  it('is pure: the library is not written to, and a vehicle the library does not hold can be analysed', () => {
    const before = JSON.stringify(lib.vehicles);
    const copy = { ...lib.vehicles['solstice-atoll']!, id: 'builder-design' };
    const c = analyzeVehicle(lib, copy);
    expect(c.vehicleId).toBe('builder-design');
    expect(JSON.stringify(lib.vehicles)).toBe(before);
    expect(lib.vehicles['builder-design']).toBeUndefined();
  });
});
