/**
 * validateVehicle: nothing for the eight vehicles of the fleet; the right issue for each broken fixture.
 * Every fixture is a real vehicle of the library with one thing broken, so each finding is the only one.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { DefLibrary, PadDef, PartDef, VehicleDef } from '@/core/contracts/defs';
import { DEFAULT_PAD_CLASS_LIMITS, DEFAULT_UNIVERSE_RULES, type UniverseRules } from '@/core/contracts/net';
import { fsDefSource } from '@/core/defs/fsSource';
import { loadDefs } from '@/core/defs/loader';
import { validateVehicle } from '@/sim/vessel/validate';

let lib: DefLibrary;
beforeAll(async () => {
  lib = await loadDefs(fsDefSource());
});

/** The class limits fleet-data proposes from the fleet's table (request fleet-data-2): what the lead sets in UniverseRules.pads.classLimits. */
const PROPOSED: UniverseRules = {
  ...DEFAULT_UNIVERSE_RULES,
  pads: { ...DEFAULT_UNIVERSE_RULES.pads, classLimits: { light: { maxLiftoffMass: 70000, maxDiameter: 2.5 }, medium: { maxLiftoffMass: 700000, maxDiameter: 8.5 }, heavy: { maxLiftoffMass: 3000000, maxDiameter: 9.56 } } },
};

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
const vehicle = (id: string): VehicleDef => clone(lib.vehicles[id]!);
const codes = (v: VehicleDef, defs: DefLibrary = lib, context = { rules: PROPOSED }): string[] => validateVehicle(defs, v, context).map((i) => i.code);
const padOf = (cls: PadDef['class']): PadDef => ({ id: 'test-pad', name: 'Test pad', offsetEnu: [0, 0], azimuthDeg: 90, class: cls, flatRadius: 100, blendRadius: 200, mountHeight: 5, structures: [] });

describe('validateVehicle: the fleet', () => {
  it('reports nothing for the eight vehicles under the class limits proposed from the fleet table', () => {
    expect(Object.keys(lib.vehicles).sort()).toEqual(['azimuth-pathfinder', 'meridian-albatross', 'meridian-egret', 'meridian-lunar', 'meridian-pelican-heavy', 'solstice-atoll', 'solstice-kestrel', 'solstice-pelican']);
    for (const v of Object.values(lib.vehicles)) expect(validateVehicle(lib, v, { rules: PROPOSED }), v.id).toEqual([]);
  });

  it('the defaults of the contract are the proposed limits since the lead\'s decision on request fleet-data-4: nothing is reported without a rules document either', () => {
    expect(DEFAULT_PAD_CLASS_LIMITS).toEqual(PROPOSED.pads.classLimits);
    for (const v of Object.values(lib.vehicles)) expect(validateVehicle(lib, v), v.id).toEqual([]);
  });

  it('under the provisional limits that the defaults were until then (medium 7 m), only the Solstice stacks are over the medium class diameter (8.0 m with the M-3 RCS pods)', () => {
    const provisional: UniverseRules = { ...DEFAULT_UNIVERSE_RULES, pads: { ...DEFAULT_UNIVERSE_RULES.pads, classLimits: { light: { maxLiftoffMass: 70000, maxDiameter: 2.5 }, medium: { maxLiftoffMass: 700000, maxDiameter: 7 }, heavy: { maxLiftoffMass: 3000000, maxDiameter: 9.5 } } } };
    for (const v of Object.values(lib.vehicles)) {
      const found = validateVehicle(lib, v, { rules: provisional });
      if (v.id.startsWith('solstice-')) {
        expect(found.map((i) => i.code), v.id).toEqual(['padClassExceeded']);
        expect(found[0]!.value!).toBeCloseTo(8.0, 2);
      } else expect(found, v.id).toEqual([]);
    }
  });

  it('each vehicle fits a pad of its class, and a heavy one is refused by a medium pad', () => {
    for (const v of Object.values(lib.vehicles)) {
      const cls = v.padInterface?.class ?? 'heavy';
      expect(validateVehicle(lib, v, { rules: PROPOSED, pad: padOf(cls) }), v.id).toEqual([]);
    }
    expect(codes(vehicle('meridian-egret'), lib, { rules: PROPOSED, pad: padOf('medium') } as never)).toContain('padClassExceeded');
  });
});

describe('validateVehicle: twelve broken fixtures, each with its issue', () => {
  it('1 unknownPart: a part names a definition the library does not have', () => {
    const v = vehicle('azimuth-pathfinder');
    v.parts[3]!.def = 'no-such-part';
    expect(codes(v)).toEqual(['unknownPart']);
  });

  it('2 multipleRoots: a second part without a parent', () => {
    const v = vehicle('azimuth-pathfinder');
    const i = v.parts.findIndex((p) => p.id === 'lv-wren-1');
    v.parts[i] = { ...v.parts[i]!, parent: null };
    expect(codes(v)).toContain('multipleRoots');
  });

  it('3 unreachablePart: parents in a cycle never reach the root', () => {
    const v = vehicle('azimuth-pathfinder');
    const s2 = v.parts.find((p) => p.id === 'lv-s2')!;
    s2.parent = 'lv-s1';
    expect(codes(v)).toContain('unreachablePart');
  });

  it('4 nodeOccupied: two engines on one mount node', () => {
    const v = vehicle('azimuth-pathfinder');
    v.parts.find((p) => p.id === 'lv-wren-2')!.parentNode = 'engine-1';
    expect(codes(v)).toEqual(['nodeOccupied']);
  });

  it('5 nodeKind: a docking face mated to an engine mount', () => {
    const v = vehicle('solstice-pelican');
    const port = v.parts.find((p) => p.id === 'sc-nose-port')!;
    Object.assign(port, { parent: 'sc-ring', parentNode: 'engine', node: 'face' });
    v.parts = v.parts.filter((p) => p.id !== 'sc-lyra-d');
    v.stages = v.stages.map((s) => ({ ...s, actions: s.actions.filter((a) => !('parts' in a && a.parts.includes('sc-lyra-d'))) }));
    // (The 1.55 m face is also wider than the 1 m mount it stands on.)
    expect(codes(v)).toEqual(['nodeKind', 'nodeSizeMismatch']);
  });

  it('6 stageActionTarget: a stage ignites a part without an engine', () => {
    const v = vehicle('solstice-atoll');
    v.stages[3]!.actions.push({ kind: 'igniteEngines', parts: ['sc-core'] });
    const issues = validateVehicle(lib, v, { rules: PROPOSED });
    expect(issues.map((i) => i.code)).toEqual(['stageActionTarget']);
    expect(issues[0]).toMatchObject({ parts: ['sc-core'], stageIndex: 3 });
  });

  it('7 noCommand: nothing can fly it', () => {
    const inert: PartDef = { ...clone(lib.parts['pathfinder-bus']!), id: 'inert-bus', modules: [] };
    const defs = { ...lib, parts: { ...lib.parts, 'inert-bus': inert } };
    const v = vehicle('azimuth-pathfinder');
    v.parts.find((p) => p.id === 'sc-bus')!.def = 'inert-bus';
    expect(codes(v, defs)).toEqual(['noCommand']);
  });

  it('8 nodeSizeMismatch: a 6.6 m stage hung from a 2.2 m interstage', () => {
    const v = vehicle('azimuth-pathfinder');
    v.parts.find((p) => p.id === 'lv-s1')!.def = 'solstice-s1';
    // The wider stage's engine nodes differ: keep the five engines off it and the clamps off the pad check.
    v.parts = v.parts.filter((p) => !p.id.startsWith('lv-wren-') && !p.id.startsWith('lv-clamp-'));
    v.stages = [];
    v.abort = [];
    expect(codes(v, lib, { rules: PROPOSED, start: 'orbit' } as never)).toEqual(['nodeSizeMismatch']);
  });

  it('9 overlap: an RCS quad placed inside the propellant tank of another stage', () => {
    const v = vehicle('solstice-pelican');
    v.parts.push({ id: 'stray-quad', def: 'rcs-quad-440', parent: 'lv-interstage', position: [0, -6, 0], stageGroup: 'lv-s1' });
    const issues = validateVehicle(lib, v, { rules: PROPOSED });
    expect(issues.map((i) => i.code)).toEqual(['overlap']);
    expect(issues[0]!.parts).toContain('stray-quad');
  });

  it('10 noClamps: a pad start with nothing holding the vehicle', () => {
    const v = vehicle('azimuth-pathfinder');
    v.parts = v.parts.filter((p) => !p.id.startsWith('lv-clamp-'));
    v.stages[0]!.actions = v.stages[0]!.actions.filter((a) => a.kind !== 'releaseClamps');
    expect(codes(v)).toEqual(['noClamps']);
    // An orbital start needs none.
    expect(codes(v, lib, { rules: PROPOSED, start: 'orbit' } as never)).toEqual([]);
  });

  it('11 padClassExceeded (mass): the lunar stack on a light pad', () => {
    const issues = validateVehicle(lib, vehicle('meridian-lunar'), { rules: PROPOSED, pad: padOf('light') });
    expect(issues.every((i) => i.code === 'padClassExceeded')).toBe(true);
    expect(issues.some((i) => i.message.includes('Lift-off mass'))).toBe(true);
  });

  it('12 padClassExceeded (diameter): a pad that states a narrower opening than its class', () => {
    const issues = validateVehicle(lib, vehicle('meridian-albatross'), { rules: PROPOSED, pad: { ...padOf('heavy'), maxDiameter: 9.0 } });
    expect(issues.map((i) => i.code)).toEqual(['padClassExceeded']);
    expect(issues[0]!.value).toBeCloseTo(9.5, 2);
  });

  it('13 launchSequence: a pre-docked tandem whose one stage acts on both craft', () => {
    const tandem = (stages: VehicleDef['stages']): VehicleDef => ({
      id: 'test-tandem',
      name: 'Tandem',
      parts: [
        { id: 'a', def: 'pathfinder-bus', parent: null, stageGroup: 'a' },
        { id: 'a-engine', def: 'lyra-k', parent: 'a', parentNode: 'engine', node: 'top', stageGroup: 'a' },
        { id: 'a-port', def: 'dock-port-c', parent: 'a', parentNode: 'top', node: 'bottom', stageGroup: 'a' },
        { id: 'b-port', def: 'dock-port-c', parent: 'a-port', parentNode: 'face', node: 'face', stageGroup: 'b' },
        { id: 'b', def: 'pathfinder-bus', parent: 'b-port', parentNode: 'bottom', node: 'top', stageGroup: 'b' },
        { id: 'b-engine', def: 'lyra-k', parent: 'b', parentNode: 'engine', node: 'top', stageGroup: 'b' },
      ],
      stageGroups: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }],
      stages,
      abort: [],
      actionGroups: {},
      crew: [],
      cameras: { chase: { defaultDistance: 10, minDistance: 2, maxDistance: 100 } },
      cockpit: null,
    });
    const orbit = { rules: PROPOSED, start: 'orbit' as const };
    // One entry per craft, in launch order: a launch sequence.
    expect(validateVehicle(lib, tandem([{ label: 'Undock', icon: 'decoupler', actions: [{ kind: 'undock', part: 'a-port' }] }, { label: 'A burns', icon: 'engine', actions: [{ kind: 'igniteEngines', parts: ['a-engine'] }] }, { label: 'B burns', icon: 'engine', actions: [{ kind: 'igniteEngines', parts: ['b-engine'] }] }]), orbit)).toEqual([]);
    const mixed = validateVehicle(lib, tandem([{ label: 'Both', icon: 'engine', actions: [{ kind: 'igniteEngines', parts: ['a-engine', 'b-engine'] }] }]), orbit);
    expect(mixed.map((i) => i.code)).toEqual(['launchSequence']);
    expect(mixed[0]!.stageIndex).toBe(0);
  });
});
