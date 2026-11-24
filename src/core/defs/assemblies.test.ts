import { describe, expect, it } from 'vitest';
import type { AssemblyDef, PartDef, VehicleDef } from '../contracts/defs';
import { AssemblyError, flattenVehicle } from './assemblies';
import { fsDefSource } from './fsSource';
import { canonicalText, hashLibrary, hashText } from './hash';
import { DefError, loadDefs, type DefSource } from './loader';
import { structuralIssues } from './vehicleStructure';

const node = (id: string, y: number, dir: number, size: number, kind?: 'stack' | 'mount' | 'dock'): PartDef['attachNodes'][number] => ({ id, pos: [0, y, 0], dir: [0, dir, 0], size, ...(kind ? { kind } : {}) });
const part = (id: string, more: Partial<PartDef> & Record<string, unknown> = {}): PartDef =>
  ({ id, name: id, category: 'structural', dryMass: 100, comOffset: [0, 0, 0], inertiaShape: { kind: 'sphere', r: 1 }, bounds: { radius: 1, yMin: 0, yMax: 1 }, attachNodes: [node('top', 1, 1, 2), node('bottom', 0, -1, 2)], thermal: { surfaces: [] }, joint: { maxAccelG: 10 }, modules: [], visual: null, ...more }) as PartDef;

const PARTS: Record<string, PartDef> = {
  pod: part('pod', { modules: [{ type: 'command', crewCapacity: 0, sas: true, maxRateDegPerS: 10, seats: [], remote: true }] }),
  tank: part('tank', { resources: [{ resource: 'LOX', capacity: 1000, tankBottomY: 0, tankHeight: 1 }], attachNodes: [node('top', 1, 1, 2), node('bottom', 0, -1, 2), node('engine', 0.2, -1, 1, 'mount')] }),
  engine: part('engine', { attachNodes: [node('top', 0, 1, 1)], modules: [{ type: 'engine', thrustVac: 1000, ispVac: 300, ispSL: 250, minThrottle: 0.5, throttleable: true, spoolUp: 0.5, spoolDown: 0.3, maxIgnitions: 1, propellants: [{ resource: 'LOX', ratio: 1 }], nozzles: [], chamberPressure: 1e6, plume: 'p', sound: 's' }] }),
  sep: part('sep', { category: 'decoupler', modules: [{ type: 'decoupler', impulse: 100, separationPlaneY: 1 }] }),
  port: part('port', { category: 'dock', attachNodes: [node('bottom', 0, -1, 1), node('face', 0.5, 1, 1.55, 'dock')] }),
};

const launcher: AssemblyDef = {
  id: 'lv',
  name: 'Launcher',
  parts: [
    { id: 'tank', def: 'tank', parent: null, stageGroup: 's1' },
    { id: 'engine', def: 'engine', parent: 'tank', parentNode: 'engine', node: 'top', stageGroup: 's1' },
  ],
  stageGroups: [{ id: 's1', label: 'Stage one' }],
  stages: [{ label: 'Launch', icon: 'engine', actions: [{ kind: 'igniteEngines', parts: ['engine'] }] }],
  abort: [{ kind: 'shutdownEngines', parts: ['engine'] }],
  actionGroups: { burn: [{ kind: 'igniteEngines', parts: ['engine'] }] },
};
const craft: AssemblyDef = {
  id: 'sc',
  name: 'Spacecraft',
  parts: [
    { id: 'pod', def: 'pod', parent: null, stageGroup: 'pod' },
    { id: 'sep', def: 'sep', parent: 'pod', parentNode: 'bottom', node: 'top', stageGroup: 'pod' },
  ],
  stageGroups: [{ id: 'pod', label: 'Pod' }],
  stages: [{ label: 'Separation', icon: 'decoupler', actions: [{ kind: 'decouple', part: 'sep' }] }],
  abort: [{ kind: 'decouple', part: 'sep' }],
  actionGroups: { burn: [{ kind: 'decouple', part: 'sep' }] },
};
const composed = (more: Partial<VehicleDef> = {}): VehicleDef =>
  ({
    id: 'stack',
    name: 'Stack',
    uses: [
      { assembly: 'lv', prefix: 'lv', parent: 'sc-sep', parentNode: 'bottom', node: 'top', resources: { 'lv-tank': { LOX: 400 } } },
      { assembly: 'sc', prefix: 'sc', parent: null },
    ],
    parts: [],
    stageGroups: [],
    stages: [],
    abort: [],
    actionGroups: {},
    crew: [],
    cameras: { chase: { defaultDistance: 10, minDistance: 1, maxDistance: 100 } },
    cockpit: null,
    ...more,
  }) as VehicleDef;

describe('assemblies: a vehicle composed of sub-assemblies is flattened into one flat vehicle', () => {
  it('prefixes ids and groups, places each assembly root by its use, overrides loads, concatenates the stacks in the order of uses', () => {
    const flat = flattenVehicle(composed(), { lv: launcher, sc: craft });
    expect(flat.uses).toBeUndefined();
    expect(flat.parts.map((p) => p.id)).toEqual(['lv-tank', 'lv-engine', 'sc-pod', 'sc-sep']);
    const tank = flat.parts[0]!;
    expect(tank).toMatchObject({ parent: 'sc-sep', parentNode: 'bottom', node: 'top', stageGroup: 'lv-s1', resources: { LOX: 400 } });
    expect(flat.parts[1]).toMatchObject({ parent: 'lv-tank', parentNode: 'engine', node: 'top' });
    expect(flat.parts[2]!.parent).toBeNull();
    expect(flat.stageGroups.map((g) => g.id)).toEqual(['lv-s1', 'sc-pod']);
    expect(flat.stages.map((s) => s.label)).toEqual(['Launch', 'Separation']);
    expect(flat.stages[0]!.actions).toEqual([{ kind: 'igniteEngines', parts: ['lv-engine'] }]);
    expect(flat.stages[1]!.actions).toEqual([{ kind: 'decouple', part: 'sc-sep' }]);
    expect(flat.abort).toEqual([{ kind: 'shutdownEngines', parts: ['lv-engine'] }, { kind: 'decouple', part: 'sc-sep' }]);
    expect(flat.actionGroups['burn']).toHaveLength(2);
    expect(structuralIssues(PARTS, flat)).toEqual([]);
    // The assembly itself is untouched.
    expect(launcher.parts[0]!.id).toBe('tank');
  });

  it("the vehicle's own parts and stages follow those of its assemblies", () => {
    const flat = flattenVehicle(
      composed({ parts: [{ id: 'extra', def: 'engine', parent: 'lv-tank', position: [0, -1, 0], stageGroup: 'own' }], stageGroups: [{ id: 'own', label: 'Own' }], stages: [{ label: 'Last', icon: 'engine', actions: [{ kind: 'igniteEngines', parts: ['extra'] }] }] }),
      { lv: launcher, sc: craft },
    );
    expect(flat.parts.at(-1)!.id).toBe('extra');
    expect(flat.stages.map((s) => s.label)).toEqual(['Launch', 'Separation', 'Last']);
  });

  it('a vehicle without uses is the same object (its simulation projection, and its hash, are untouched)', () => {
    const v = composed();
    delete v.uses;
    expect(flattenVehicle(v, {})).toBe(v);
  });

  it('refuses an unknown assembly, a bad or repeated prefix, an override of a foreign part, and an id produced twice', () => {
    const asm = { lv: launcher, sc: craft };
    const uses = (over: Record<string, unknown>[]) => composed({ uses: over as unknown as VehicleDef['uses'] });
    expect(() => flattenVehicle(uses([{ assembly: 'nope', prefix: 'a', parent: null }]), asm)).toThrow(/unknown assembly "nope"/);
    expect(() => flattenVehicle(uses([{ assembly: 'sc', prefix: 'A b', parent: null }]), asm)).toThrow(/lower-kebab/);
    expect(() => flattenVehicle(uses([{ assembly: 'sc', prefix: 'x', parent: null }, { assembly: 'lv', prefix: 'x', parent: 'x-sep' }]), asm)).toThrow(/used twice/);
    expect(() => flattenVehicle(uses([{ assembly: 'sc', prefix: 'sc', parent: null, resources: { 'sc-nope': { LOX: 1 } } }]), asm)).toThrow(/"resources" names "sc-nope"/);
    expect(() => flattenVehicle(composed({ parts: [{ id: 'sc-pod', def: 'pod', parent: null, stageGroup: 'g' }] }), asm)).toThrow(/"sc-pod" is produced twice/);
    expect(() => flattenVehicle(uses([]), asm)).toThrow(AssemblyError);
  });
});

describe('the structural checks of a vehicle', () => {
  const base = (): VehicleDef => flattenVehicle(composed(), { lv: launcher, sc: craft });
  const codes = (v: VehicleDef): string[] => structuralIssues(PARTS, v).map((i) => i.code);

  it('find each defect by its code, naming the parts concerned', () => {
    const v1 = base();
    v1.parts[1] = { ...v1.parts[1]!, def: 'nothing' };
    expect(codes(v1)).toContain('unknownPart');
    const v2 = base();
    v2.parts[0] = { ...v2.parts[0]!, parent: null };
    expect(codes(v2)).toContain('multipleRoots');
    const v3 = base();
    v3.parts[2] = { ...v3.parts[2]!, parent: 'sc-sep' };
    expect(codes(v3)).toEqual(expect.arrayContaining(['noRoot', 'unreachablePart']));
    const v4 = base();
    v4.parts.push({ id: 'engine-2', def: 'engine', parent: 'lv-tank', parentNode: 'engine', node: 'top', stageGroup: 'lv-s1' });
    const occupied = structuralIssues(PARTS, v4).find((i) => i.code === 'nodeOccupied')!;
    expect(occupied.parts).toEqual(['lv-tank', 'lv-engine', 'engine-2']);
    const v5 = base();
    v5.parts.push({ id: 'p', def: 'port', parent: 'lv-tank', parentNode: 'engine', node: 'face', stageGroup: 'lv-s1' });
    expect(codes(v5)).toContain('nodeKind');
    const v6 = base();
    v6.parts.push({ id: 'loose', def: 'engine', parent: 'sc-pod', stageGroup: 'sc-pod' });
    expect(codes(v6)).toContain('noPlacement');
    const v7 = base();
    v7.stages.push({ label: 'Bad', icon: 'engine', actions: [{ kind: 'igniteEngines', parts: ['sc-pod'] }] });
    const target = structuralIssues(PARTS, v7).find((i) => i.code === 'stageActionTarget')!;
    expect(target).toMatchObject({ parts: ['sc-pod'], stageIndex: 2 });
    const v8 = base();
    v8.parts = v8.parts.map((p) => (p.def === 'pod' ? { ...p, def: 'tank' } : p));
    expect(codes(v8)).toContain('noCommand');
    const v9 = base();
    v9.parts[1] = { ...v9.parts[1]!, stageGroup: 'nowhere' };
    expect(codes(v9)).toContain('unknownStageGroup');
    const v10 = base();
    v10.parts[1] = { ...v10.parts[1]!, parentNode: 'nope' };
    expect(codes(v10)).toContain('unknownNode');
  });

  it('a dock node carries a dock node, or a part that stands on its face', () => {
    const v = base();
    v.parts.push({ id: 'p1', def: 'port', parent: 'sc-pod', parentNode: 'top', node: 'bottom', stageGroup: 'sc-pod' });
    v.parts.push({ id: 'p2', def: 'port', parent: 'p1', parentNode: 'face', node: 'face', stageGroup: 'sc-pod' });
    expect(structuralIssues(PARTS, v)).toEqual([]);
  });

  it('the repository library passes them: the loader holds every vehicle to them', async () => {
    const lib = await loadDefs(fsDefSource());
    for (const v of Object.values(lib.vehicles)) expect(structuralIssues(lib.parts, v), v.id).toEqual([]);
  });
});

describe('the loader reads assemblies and refuses a broken vehicle by file', () => {
  const memory = (files: Record<string, unknown>): DefSource => ({ list: async () => Object.keys(files).sort(), read: async (p) => (p in files ? structuredClone(files[p]) : undefined) });
  const body = { id: 'a', name: 'A', parent: null, mu: 1, radius: 1, orbit: null };
  const files = (vehicle: unknown): Record<string, unknown> => ({
    'bodies/a.json': body,
    'resources.json': [{ id: 'LOX', name: 'LOX', density: 1141 }],
    ...Object.fromEntries(Object.values(PARTS).map((p) => [`parts/${p.id}.json`, p])),
    'assemblies/lv.json': launcher,
    'assemblies/sc.json': craft,
    'vehicles/stack.json': vehicle,
  });

  it('a composed vehicle loads flat, and the library keeps its assemblies', async () => {
    const lib = await loadDefs(memory(files(composed())));
    expect(lib.vehicles['stack']!.parts.map((p) => p.id)).toEqual(['lv-tank', 'lv-engine', 'sc-pod', 'sc-sep']);
    expect(Object.keys(lib.assemblies!)).toEqual(['lv', 'sc']);
  });

  it('a structural defect or a bad use fails the load, naming the vehicle file', async () => {
    const broken = composed({ stages: [{ label: 'Bad', icon: 'engine', actions: [{ kind: 'releaseClamps', parts: ['sc-pod'] }] }] });
    await expect(loadDefs(memory(files(broken)))).rejects.toThrow(/vehicles\/stack\.json: stage 2: "releaseClamps" names "sc-pod" \(pod\), which has no launch clamp/);
    await expect(loadDefs(memory(files(composed({ uses: [{ assembly: 'zz', prefix: 'z', parent: null }] }))))).rejects.toThrow(DefError);
    const { stages: _s, ...noStages } = composed();
    await expect(loadDefs(memory(files(noStages)))).rejects.toThrow(/vehicles\/stack\.json: "stages" must be an array/);
    await expect(loadDefs(memory({ ...files(composed()), 'assemblies/sc.json': { ...craft, parts: [] } }))).rejects.toThrow(/assemblies\/sc\.json: an assembly needs exactly one root part/);
  });
});

describe('hashLibrary: the defsHash of a loaded library', () => {
  it('is stable, independent of key order, and changes with any value', async () => {
    const a = await loadDefs(fsDefSource());
    const b = await loadDefs(fsDefSource());
    const h = hashLibrary(a);
    expect(h).toMatch(/^[0-9a-f]{16}$/);
    expect(hashLibrary(b)).toBe(h);
    expect(canonicalText({ y: 1, x: [2, { b: 1, a: 2 }] })).toBe(canonicalText({ x: [2, { a: 2, b: 1 }], y: 1 }));
    b.parts['lyra-d']!.dryMass += 1e-9;
    expect(hashLibrary(b)).not.toBe(h);
    expect(hashText('ab')).not.toBe(hashText('ba'));
    expect(() => canonicalText({ x: Infinity })).toThrow(/no JSON form/);
  });
});
