/**
 * Vehicle and part data against sim-design section 13: masses, delta-v table, thrust-to-weight, engine
 * performance against pressure, the shared capsule mould line, definition completeness.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { CapsuleMouldLineDef, DefLibrary, PartDef } from '@/core/contracts/defs';
import { getSection } from '@/core/defs/loader';
import { DEG, G0 } from '@/core/math/scalar';
import { assembleVessel, computeMassProps, ispAt, stagingInfo, thrustAt, vesselReadouts, type Vessel } from '@/sim/vessel';
import { partMass } from '@/sim/vessel/massProps';
import { EARTH_MU, EARTH_RADIUS, earthAir, loadLibrary, makeEnv, placeUpright, VEHICLE } from './helpers';

let defs: DefLibrary;
let stack: Vessel;
beforeAll(async () => {
  defs = await loadLibrary();
  stack = assembleVessel(defs, VEHICLE);
});

const groupMass = (v: Vessel, groups: string[]): number => v.parts.filter((p) => groups.includes(p.stageGroup)).reduce((s, p) => s + partMass(p), 0);

describe('stack masses (sim-design 13.1)', () => {
  it('lift-off mass is 2,756,100 kg', () => {
    computeMassProps(stack);
    expect(Math.abs(stack.mp.mass - 2756100)).toBeLessThan(100);
    expect(Math.abs(stack.mp.mass - 2756100)).toBeLessThan(0.01);
  });

  it('element masses match the stage table', () => {
    expect(groupMass(stack, ['capsule'])).toBeCloseTo(5000, 3);
    expect(groupMass(stack, ['ascent'])).toBeCloseTo(12300, 3);
    expect(groupMass(stack, ['descent'])).toBeCloseTo(39500, 3);
    expect(groupMass(stack, ['m3'])).toBeCloseTo(97300, 3);
    expect(groupMass(stack, ['fairing'])).toBeCloseTo(6000, 3);
    expect(groupMass(stack, ['les', 'les-jettison'])).toBeCloseTo(4000, 3);
    expect(groupMass(stack, ['m2'])).toBeCloseTo(682000, 3);
    expect(groupMass(stack, ['m1'])).toBeCloseTo(1910000, 3);
  });

  it('stack masses after each separation', () => {
    const expected: [number, number][] = [
      [2, 846100],
      [3, 836100],
      [4, 154100],
      [5, 56800],
      [7, 17300],
      [8, 5000],
    ];
    for (const [fired, mass] of expected) {
      const v = assembleVessel(defs, VEHICLE, { stagesAlreadyFired: fired });
      // The M-2 ullage solids are spent in the structural model; add them back for the table value.
      const ullage = fired === 2 || fired === 3 ? defs.parts['meridian-m2-ullage-motors']!.resources![0]!.capacity : 0;
      expect(v.mp.mass + ullage, `after ${fired} stages`).toBeCloseTo(mass, 2);
    }
  });

  it('the stack is about 106 m tall and coaxial', () => {
    let top = -Infinity;
    let bottom = Infinity;
    for (const p of stack.parts) {
      if (p.def.id === 'meridian-launch-clamp') continue;
      top = Math.max(top, p.pos.y + p.def.bounds.yMax);
      bottom = Math.min(bottom, p.pos.y + p.def.bounds.yMin);
    }
    expect(top - bottom).toBeGreaterThan(104);
    expect(top - bottom).toBeLessThan(112);
    expect(Math.hypot(stack.mp.com.x, stack.mp.com.z)).toBeLessThan(0.01);
  });
});

describe('delta-v budget (sim-design 13.2)', () => {
  it('per-stage Tsiolkovsky delta-v equals the table within 1 m/s', () => {
    const vac = makeEnv({ mu: EARTH_MU, radius: EARTH_RADIUS });
    const info = stagingInfo(stack, vac);
    expect(info).toHaveLength(10);
    expect(info[0]!.deltaVVac).toBeCloseTo(3493, 0);
    expect(Math.abs(info[1]!.deltaVVac - 6197)).toBeLessThan(1);
    expect(Math.abs(info[3]!.deltaVVac - 3555)).toBeLessThan(1);
    expect(Math.abs(info[4]!.deltaVVac - 3547)).toBeLessThan(1);
    expect(Math.abs(info[6]!.deltaVVac - 3408)).toBeLessThan(1);
    for (const i of [2, 5, 7, 8, 9]) expect(info[i]!.deltaVVac).toBe(0);
    // Independent arithmetic.
    expect(Math.abs(info[0]!.deltaVVac - 350 * G0 * Math.log(2756100 / 996100))).toBeLessThan(0.01);
    expect(Math.abs(info[1]!.deltaVVac - 445 * G0 * Math.log(836100 / 202100))).toBeLessThan(0.01);
    expect(Math.abs(info[3]!.deltaVVac - 452 * G0 * Math.log(154100 / 69100))).toBeLessThan(0.01);
    expect(Math.abs(info[4]!.deltaVVac - 360 * G0 * Math.log(56800 / 20800))).toBeLessThan(0.01);
    expect(Math.abs(info[6]!.deltaVVac - 355 * G0 * Math.log(17300 / 6500))).toBeLessThan(0.01);
  });

  it('M-1 at sea-level pressure gives 3,264 m/s, burn times match the stage table', () => {
    const sea = makeEnv({ atmosphere: { rho0: 101325 / (287.053 * 250), scaleHeight: 7200 } });
    placeUpright(stack, sea, 0);
    const info = stagingInfo(stack, sea);
    expect(Math.abs(info[0]!.deltaVNow - 3264)).toBeLessThan(1);
    expect(info[0]!.burnTime).toBeCloseTo(160.8, 0);
    expect(info[1]!.burnTime).toBeCloseTo(419.2, 0);
    expect(info[3]!.burnTime).toBeCloseTo(376.8, 0);
    expect(info[4]!.burnTime).toBeCloseTo(635.5, 0);
    expect(info[6]!.burnTime).toBeCloseTo(626.6, 0);
    expect(info[0]!.propellantFraction).toBeCloseTo(1, 9);
    expect(info[2]!.propellantFraction).toBeNull();
    stack.r = { x: 0, y: 0, z: 0 };
  });

  it('lift-off thrust-to-weight is 1.30 and total delta-v is the sum of the stages', () => {
    const sea = makeEnv({ atmosphere: { rho0: 101325 / (287.053 * 250), scaleHeight: 7200 } });
    const v = assembleVessel(defs, VEHICLE);
    placeUpright(v, sea, 0);
    const info = stagingInfo(v, sea);
    expect(info[0]!.twr).toBeGreaterThan(1.29);
    expect(info[0]!.twr).toBeLessThan(1.305);
    expect((9 * 3.9e6) / (2756100 * G0)).toBeCloseTo(1.3, 2);
    const vac = makeEnv();
    const total = stagingInfo(v, vac).reduce((s, x) => s + x.deltaVVac, 0);
    expect(vesselReadouts(v, vac).deltaVTotal).toBeCloseTo(total, 6);
    expect(total).toBeGreaterThan(3493 + 6197 + 3555 + 3547 + 3408 - 3);
    // Table values: M-2 0.80, M-3 0.66 (Earth g), descent 2.78 and ascent 2.13 (lunar g at ignition mass).
    const g = EARTH_MU / EARTH_RADIUS ** 2;
    const vacInfo = stagingInfo(v, vac);
    expect((vacInfo[1]!.twr * g) / G0).toBeCloseTo(6.6e6 / (836100 * G0), 2);
    expect((vacInfo[3]!.twr * g) / G0).toBeCloseTo(0.66, 2);
  });
});

describe('engines against ambient pressure', () => {
  it('Atlas-9M: 3.90 MN at sea level, 4.174 MN in vacuum, Isp 327 / 350', () => {
    const def = defs.parts['atlas-9m']!.modules[0]!;
    if (def.type !== 'engine') throw new Error('not an engine');
    expect(thrustAt(def, 101325) / 1e6).toBeCloseTo(3.9, 2);
    expect(thrustAt(def, 0)).toBe(4174000);
    expect(ispAt(def, 101325)).toBeCloseTo(327, 9);
    expect(ispAt(def, 0)).toBe(350);
    expect(ispAt(def, 50662.5)).toBeCloseTo(338.5, 9);
  });

  it('vacuum engines lose most of their thrust at sea level but never go negative', () => {
    for (const id of ['vela-2', 'vela-2v', 'lyra-d', 'lyra-a']) {
      const def = defs.parts[id]!.modules[0]!;
      if (def.type !== 'engine') throw new Error('not an engine');
      expect(thrustAt(def, 101325)).toBeLessThan(0.7 * def.thrustVac);
      expect(thrustAt(def, 5e5)).toBeGreaterThanOrEqual(0);
    }
  });

  it('engine data of sim-design 13.1', () => {
    const eng = (id: string) => {
      const m = defs.parts[id]!.modules.find((x) => x.type === 'engine');
      if (!m || m.type !== 'engine') throw new Error(id);
      return m;
    };
    const rows: [string, number, number, number, number, number, number, number, number | null][] = [
      // id, thrustVac, ispVac, minThrottle, gimbal, exit pressure, exit diameter, spoolUp, maxIgnitions
      ['atlas-9m', 4174000, 350, 0.5, 6, 70000, 1.9, 1.2, 3],
      ['vela-2', 1100000, 445, 0.6, 5, 12000, 2.6, 0.8, 3],
      ['vela-2v', 1000000, 452, 0.6, 5, 6000, 2.9, 0.8, null],
      ['lyra-d', 200000, 360, 0.1, 6, 8000, 1.7, 0.25, null],
      ['lyra-a', 60000, 355, 0.2, 4, 10000, 0.9, 0.25, null],
    ];
    for (const [id, thrust, isp, minThr, gimbal, pe, de, spool, ign] of rows) {
      const e = eng(id);
      expect(e.thrustVac, id).toBe(thrust);
      expect(e.ispVac, id).toBe(isp);
      expect(e.minThrottle, id).toBe(minThr);
      expect(e.gimbal?.rangeDeg, id).toBe(gimbal);
      expect(e.nozzles[0]!.exitPressure, id).toBe(pe);
      expect(e.nozzles[0]!.exitDiameter, id).toBe(de);
      expect(e.spoolUp, id).toBe(spool);
      expect(e.maxIgnitions, id).toBe(ign);
      expect(e.chamberPressure, id).toBeGreaterThan(1e6);
    }
    const les = eng('kestrel-les');
    // 800 kN along the axis for 3.5 s from four nozzles canted 25 degrees.
    expect(les.thrustVac * Math.cos(25 * DEG)).toBeCloseTo(800000, 0);
    expect(les.fixedBurn?.duration).toBe(3.5);
    const plumes = new Set(['plume.methalox-booster', 'plume.hydrolox-vacuum', 'plume.methalox-lander', 'plume.solid', 'plume.rcs']);
    const sounds = new Set(['engine.methalox-booster', 'engine.hydrolox-vacuum', 'engine.lander-descent', 'engine.lander-ascent', 'engine.solid', 'rcs.thruster']);
    for (const p of Object.values(defs.parts)) {
      for (const m of p.modules) {
        if (m.type !== 'engine') continue;
        expect(plumes.has(m.plume), `${p.id} plume ${m.plume}`).toBe(true);
        expect(sounds.has(m.sound), `${p.id} sound ${m.sound}`).toBe(true);
        expect(m.propellants.reduce((s, x) => s + x.ratio, 0)).toBeCloseTo(1, 12);
      }
    }
  });
});

describe('capsule equals the shared mould line', () => {
  it('bounds, shield, aero reference, seats and hatch', () => {
    const mould = getSection<CapsuleMouldLineDef>(defs, 'visuals/shared/kestrel-mouldline');
    const cap: PartDef = defs.parts['kestrel-capsule']!;
    expect(cap.bounds.radius).toBe(mould.heatShield.maxDiameter / 2);
    expect(cap.bounds.yMin).toBe(mould.heatShield.apexY);
    expect(cap.bounds.yMax).toBe(mould.apexTunnel.yTop);
    expect(cap.bounds.yMax).toBe(Math.max(...mould.profile.map((p) => p[1])));
    expect(cap.bounds.radius).toBe(Math.max(...mould.profile.map((p) => p[0])));
    const aero = cap.aero!.find((a) => a.kind === 'bluntCapsule');
    if (!aero || aero.kind !== 'bluntCapsule') throw new Error('no capsule aero');
    expect(aero.diameter).toBe(mould.heatShield.maxDiameter);
    expect(aero.refArea).toBeCloseTo((Math.PI * mould.heatShield.maxDiameter ** 2) / 4, 9);
    expect(aero.refPoint).toEqual([0, mould.heatShield.maxDiameterY, 0]);
    const shield = cap.modules.find((m) => m.type === 'heatShield');
    if (!shield || shield.type !== 'heatShield') throw new Error('no shield');
    expect(shield.area).toBeCloseTo((Math.PI * mould.heatShield.maxDiameter ** 2) / 4, 9);
    const face = cap.thermal.surfaces.find((s) => s.normal !== 'axisym')!;
    expect(face.noseRadius).toBe(mould.heatShield.radiusOfCurvature);
    expect(face.normal).toEqual([0, -1, 0]);
    const cmd = cap.modules.find((m) => m.type === 'command');
    if (!cmd || cmd.type !== 'command') throw new Error('no command module');
    expect(cmd.seats).toEqual(mould.seats);
    expect(cmd.crewCapacity).toBe(mould.seats.length);
    // Hatch on the cone at the mould line's azimuth and height, pointing along the outward normal.
    const az = mould.hatch.azimuthDeg * DEG;
    const r = mould.heatShield.maxDiameter / 2 - (mould.hatch.y - mould.cone.yBottom) * Math.tan(mould.cone.halfAngleDeg * DEG);
    expect(cmd.hatch!.pos[0]).toBeCloseTo(r * Math.sin(az), 5);
    expect(cmd.hatch!.pos[1]).toBe(mould.hatch.y);
    expect(cmd.hatch!.pos[2]).toBeCloseTo(r * Math.cos(az), 5);
    const c = Math.cos(mould.cone.halfAngleDeg * DEG);
    expect(cmd.hatch!.dir[0]).toBeCloseTo(c * Math.sin(az), 5);
    expect(cmd.hatch!.dir[1]).toBeCloseTo(Math.sin(mould.cone.halfAngleDeg * DEG), 5);
    expect(cmd.hatch!.dir[2]).toBeCloseTo(c * Math.cos(az), 5);
    // Attach nodes sit on the mould line.
    expect(cap.attachNodes.find((n) => n.id === 'bottom')!.pos[1]).toBe(mould.heatShield.maxDiameterY);
    expect(cap.attachNodes.find((n) => n.id === 'top')!.pos[1]).toBe(mould.apexTunnel.yTop);
    // The vehicle's cockpit camera sits in the pilot's (centre) seat (lead decision on request cockpit-18).
    const vehicle = defs.vehicles[VEHICLE]!;
    expect(vehicle.cameras.cockpit).toEqual({ part: 'capsule', seat: 'plt' });
    expect(vehicle.cockpit).toBe('kestrel');
    expect(vehicle.crew.map((x) => x.seat)).toEqual(mould.seats.map((s) => s.id));
  });
});

describe('definition completeness', () => {
  it('every part fills every field and references its visual section', async () => {
    const fs = await import('node:fs');
    for (const p of Object.values(defs.parts)) {
      const raw = JSON.parse(fs.readFileSync(`data/defs/parts/${p.id}.json`, 'utf8')) as Record<string, unknown>;
      expect(raw['visual'], p.id).toEqual({ $ref: `../visuals/parts/${p.id}.json`, optional: true });
      for (const key of ['bounds', 'attachNodes', 'thermal', 'contactPoints', 'buoyancy', 'joint', 'modules', 'inertiaShape', 'comOffset']) expect(raw[key], `${p.id}.${key}`).toBeDefined();
      expect(p.bounds.yMax, p.id).toBeGreaterThan(p.bounds.yMin);
      expect(p.bounds.radius, p.id).toBeGreaterThan(0);
      expect(p.thermal.surfaces.length, p.id).toBeGreaterThan(0);
      for (const s of p.thermal.surfaces) expect(s.arealHeatCapacity, p.id).toBeGreaterThanOrEqual(4000);
      expect(p.dryMass, p.id).toBeGreaterThan(0);
    }
    expect(Object.keys(defs.resources).sort()).toEqual(['Ablator', 'CH4', 'LH2', 'LOX', 'RCSProp', 'SolidProp']);
  });

  it('the vehicle has the 10-entry stage stack, the abort sequence and valid references', () => {
    const vehicle = defs.vehicles[VEHICLE]!;
    expect(vehicle.stages.map((s) => s.label)).toEqual(['Launch', 'M-1 separation', 'Tower + fairing jettison', 'M-2 separation', 'M-3 separation', 'Landing gear', 'Lunar lift-off', 'Capsule separation', 'Drogues', 'Mains']);
    const ids = new Set(vehicle.parts.map((p) => p.id));
    const all = [...vehicle.stages.flatMap((s) => s.actions), ...vehicle.abort, ...Object.values(vehicle.actionGroups).flat()];
    for (const a of all) for (const id of 'parts' in a ? a.parts : [a.part]) expect(ids.has(id), id).toBe(true);
    expect(vehicle.abort.some((a) => a.kind === 'igniteEngines' && a.parts.includes('les'))).toBe(true);
    expect(vehicle.stages[0]!.actions.find((a) => a.kind === 'releaseClamps')?.delay).toBe(3);
    expect(stack.parts).toHaveLength(vehicle.parts.length);
    expect(stack.parts.filter((p) => p.def.id === 'atlas-9m')).toHaveLength(9);
    expect(stack.parts.filter((p) => p.def.id === 'vela-2')).toHaveLength(6);
    // Tanks are sized for their mixture ratio: both propellants of a stage run out together.
    for (const [engine, group] of [['atlas-9m', 'm1'], ['vela-2', 'm2'], ['vela-2v', 'm3'], ['lyra-d', 'descent'], ['lyra-a', 'ascent']] as const) {
      const e = defs.parts[engine]!.modules[0]!;
      if (e.type !== 'engine') throw new Error(engine);
      const times = e.propellants.map((pr) => {
        let amount = 0;
        for (const p of stack.parts) if (p.stageGroup === group) (p.def.resources ?? []).forEach((r, k) => (amount += r.resource === pr.resource ? p.resources[k]! : 0));
        return amount / pr.ratio;
      });
      expect(times[0]! / times[1]!, group).toBeCloseTo(1, 9);
    }
  });
});

describe('vacuum environment sanity', () => {
  it('fake environments report vacuum above the atmosphere', () => {
    const env = makeEnv({ atmosphere: earthAir });
    expect(env.atmosphereAt(200000).density).toBe(0);
    expect(env.atmosphereAt(0).density).toBeCloseTo(1.225, 6);
  });
});
