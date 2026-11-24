/**
 * The gate a server stands behind when players bring their own vehicles (fix round, finding 5 and 6): a fixture
 * for every way a vehicle can fly wrong or cheat that validateVehicle and the loader now refuse, each with its code.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { DefLibrary, PartDef, VehicleDef } from '@/core/contracts/defs';
import { fsDefSource } from '@/core/defs/fsSource';
import { loadDefs, type DefSource } from '@/core/defs/loader';
import { analyzeVehicle } from '@/sim/vessel/analyze';
import { validateVehicle } from '@/sim/vessel/validate';

let lib: DefLibrary;
beforeAll(async () => {
  lib = await loadDefs(fsDefSource());
});

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
const vehicle = (id: string): VehicleDef => clone(lib.vehicles[id]!);
const codes = (v: VehicleDef, start: 'pad' | 'orbit' = 'pad'): string[] => validateVehicle(lib, v, { start }).map((i) => `${i.severity}:${i.code}`);

describe('validateVehicle refuses what flies wrong or cheats', () => {
  it('resourceLoad: a load outside 0 .. capacity (free propellant), or of a resource the part does not hold', () => {
    const v = vehicle('azimuth-pathfinder');
    v.parts.find((p) => p.id === 'lv-s1')!.resources = { LOX: 999999 };
    expect(codes(v)).toContain('error:resourceLoad');
    v.parts.find((p) => p.id === 'lv-s1')!.resources = { LH2: 10 };
    expect(codes(v)).toContain('error:resourceLoad');
  });

  it('crewSeats: more crew than seats, a seat twice, an unknown seat', () => {
    const v = vehicle('solstice-kestrel');
    v.crew = [...v.crew, { seat: 'cdr', name: 'Extra' }, { seat: 'roof', name: 'Stowaway' }];
    expect(codes(v).filter((c) => c === 'error:crewSeats')).toHaveLength(2);
  });

  it('unknownField and badId: a misspelt placement field, an id that is not lower-kebab', () => {
    const v = vehicle('azimuth-pathfinder');
    (v.parts[1] as unknown as Record<string, unknown>)['possition'] = [0, 0, 0];
    v.parts[2]!.id = 'x#panel0';
    expect(codes(v)).toEqual(expect.arrayContaining(['error:unknownField', 'error:badId']));
  });

  it('engineBlocked: an engine turned 180 degrees fires into its own stage, and its stage states no delta-v', () => {
    const v = vehicle('azimuth-pathfinder');
    v.parts.find((p) => p.id === 'lv-wren-1')!.rotationDeg = [180, 0, 0];
    expect(codes(v)).toContain('error:engineBlocked');
    expect(analyzeVehicle(lib, v).stages[0]!.deltaVVac).toBe(0);
  });

  it('clampsNeverReleased, separationAtLiftoff, emptyStageList', () => {
    const v = vehicle('azimuth-pathfinder');
    v.stages[0]!.actions = v.stages[0]!.actions.filter((a) => a.kind !== 'releaseClamps');
    expect(codes(v)).toContain('error:clampsNeverReleased');
    const w = vehicle('azimuth-pathfinder');
    w.stages[0]!.actions.push({ kind: 'decouple', part: 'sc-adapter' });
    expect(codes(w)).toContain('error:separationAtLiftoff');
    const x = vehicle('azimuth-pathfinder');
    x.stages = [];
    expect(codes(x)).toContain('error:emptyStageList');
  });

  it('warnings: an engine no stage lights, a decoupler fired again, every engine lit at lift-off, a decoupler with nothing on it', () => {
    const v = vehicle('azimuth-pathfinder');
    v.stages[1]!.actions = v.stages[1]!.actions.filter((a) => a.kind !== 'igniteEngines');
    v.stages[3]!.actions.push({ kind: 'decouple', part: 'lv-interstage' });
    v.stages[0]!.actions.push({ kind: 'igniteEngines', parts: ['sc-engine'] });
    expect(codes(v)).toEqual(expect.arrayContaining(['warning:engineNeverIgnited', 'warning:actionRepeated', 'warning:upperStageLitAtLiftoff']));
    const w = vehicle('azimuth-pathfinder');
    w.parts.push({ id: 'lone-ring', def: 'azimuth-payload-adapter', parent: 'sc-bus', position: [0, 1.6, 0], stageGroup: 'sc-probe' });
    w.stages.push({ label: 'Ring', icon: 'decoupler', actions: [{ kind: 'decouple', part: 'lone-ring' }] });
    expect(codes(w)).toContain('warning:decouplerAlone');
  });

  it('fairingOverhang: a 6.6 m fairing round the 2.2 m Azimuth stage', () => {
    const v = vehicle('azimuth-pathfinder');
    v.parts.find((p) => p.id === 'sc-fairing')!.def = 'fairing-6m6-ogive';
    expect(codes(v)).toContain('error:fairingOverhang');
  });

  it('fairingContainment: a payload that reaches through its fairing', () => {
    const v = vehicle('solstice-atoll');
    v.parts.find((p) => p.id === 'sc-aft-port')!.position = [2.6, 2, 2.6];
    expect(codes(v)).toContain('error:fairingContainment');
  });

  it('craftWithoutCommand: a stray port pre-docked on a port is a craft nothing can fly', () => {
    const v = vehicle('solstice-pelican');
    v.parts.push({ id: 'stray', def: 'dock-port-c', parent: 'sc-nose-port', parentNode: 'face', node: 'face', stageGroup: 'sc-pelican' });
    expect(codes(v)).toContain('warning:craftWithoutCommand');
  });
});

describe('the loader refuses nonsense in a part', () => {
  const withPart = (id: string, change: (p: PartDef) => void): DefSource => {
    const base = fsDefSource();
    return {
      list: () => base.list(),
      read: async (path) => {
        const raw = await base.read(path);
        if (path !== `parts/${id}.json`) return raw;
        const p = clone(raw) as PartDef;
        change(p);
        return p;
      },
    };
  };
  const engine = (p: PartDef) => p.modules.find((m) => m.type === 'engine') as Extract<PartDef['modules'][number], { type: 'engine' }>;
  it.each([
    ['dryMass 0', (p: PartDef) => (p.dryMass = 0), /"dryMass" must be a positive/],
    ['negative dryMass', (p: PartDef) => (p.dryMass = -5), /"dryMass" must be a positive/],
    ['thrust 0', (p: PartDef) => (engine(p).thrustVac = 0), /"thrustVac" must be a positive/],
    ['ispVac 0', (p: PartDef) => (engine(p).ispVac = 0), /"ispVac" must be a positive/],
    ['ispSL above ispVac', (p: PartDef) => (engine(p).ispSL = 400), /"ispSL" must be from 0 to its ispVac/],
    ['ratios summing to 2', (p: PartDef) => (engine(p).propellants = engine(p).propellants.map((x) => ({ ...x, ratio: x.ratio * 2 }))), /ratios must be positive and sum to 1/],
  ])('wren-1 with %s', async (_name, change, message) => {
    await expect(loadDefs(withPart('wren-1', change as (p: PartDef) => void))).rejects.toThrow(message);
  });
  it('a negative tank capacity', async () => {
    await expect(loadDefs(withPart('azimuth-s1', (p) => (p.resources![0]!.capacity = -1)))).rejects.toThrow(/capacity of "LOX" must be a number of kg from 0/);
  });
});
