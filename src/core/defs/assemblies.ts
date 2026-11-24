/**
 * Sub-assemblies of vehicles (docs/ARCHITECTURE.md 9.2, 12): a vehicle file may compose itself of
 * assemblies (`VehicleDef.uses`, `data/defs/assemblies/<id>.json`), which the loader flattens into an
 * ordinary flat `VehicleDef`: the part graph the simulation reads. Nothing downstream knows that a vehicle
 * was composed.
 *
 * How a `uses` entry is flattened:
 *   - every instance id of the assembly becomes `<prefix>-<id>`, and so does every id an action names; the
 *     stage groups become `<prefix>-<group>` with their labels;
 *   - the assembly's root part is placed by the entry: its parent is `use.parent` (an instance id of the
 *     flattened vehicle, a prefixed one included, or null for the vehicle's root) on `use.parentNode`, by the
 *     root's own node `use.node`;
 *   - `use.resources` overrides the load of the named parts (prefixed instance id -> resource -> kg: an
 *     off-loaded tank);
 *   - the stage stacks are CONCATENATED in the order of `uses` (launcher first) and the vehicle's own stages
 *     follow; so are the abort sequences; action groups of one name are joined.
 * The vehicle's own `parts`, `stageGroups`, `stages`, `abort` and `actionGroups` come after those of its
 * assemblies; its crew, cameras and cockpit name the flattened (prefixed) ids. The flattened vehicle has no
 * `uses`.
 *
 * The launch sequence that results is ONE ordered stage list for the whole vehicle (ARCHITECTURE 7.2): an
 * assembly's stages may only name its own parts, so a vehicle is composed so that the concatenation is the
 * order of flight (a payload carries its own separation and jettisons; see the hand-off of fleet-data).
 */
import type { AssemblyDef, StageAction, TimedStageAction, VehicleDef, VehiclePartPlacement, VehicleUseDef } from '../contracts/defs';
import { separatorOf } from './vehicleStructure';

export class AssemblyError extends Error {
  constructor(
    public readonly file: string,
    message: string,
  ) {
    super(`${file}: ${message}`);
    this.name = 'AssemblyError';
  }
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function renameAction<T extends StageAction | TimedStageAction>(action: T, rename: (id: string) => string): T {
  if ('parts' in action) return { ...action, parts: action.parts.map(rename) };
  return { ...action, part: rename(action.part) };
}

/** The assembly's fields checked for shape, so a broken file is refused by name rather than half read. */
export function checkAssemblyShape(a: unknown, file: string): asserts a is AssemblyDef {
  if (!isObject(a)) throw new AssemblyError(file, 'an assembly must be an object');
  if (typeof a['name'] !== 'string' || a['name'].trim() === '') throw new AssemblyError(file, '"name" must be a non-empty string');
  for (const k of ['parts', 'stageGroups', 'stages', 'abort']) if (!Array.isArray(a[k])) throw new AssemblyError(file, `"${k}" must be an array (it may be empty)`);
  if (!isObject(a['actionGroups'])) throw new AssemblyError(file, '"actionGroups" must be an object (it may be empty)');
  const roots = (a['parts'] as VehiclePartPlacement[]).filter((p) => isObject(p) && p.parent === null);
  if (roots.length !== 1) throw new AssemblyError(file, `an assembly needs exactly one root part (parent null), found ${roots.length}`);
}

/**
 * The flat vehicle a vehicle file stands for. A vehicle without `uses` is returned as it is (the same
 * object: its simulation projection, and so its hash, is untouched). Throws an AssemblyError naming the
 * vehicle file for an unknown assembly, a bad prefix, an override of a part the assembly does not have, or
 * an id that two sources both produce.
 */
export function flattenVehicle(vehicle: VehicleDef, assemblies: Readonly<Record<string, AssemblyDef>>, file = `vehicles/${vehicle.id}.json`): VehicleDef {
  const uses: unknown = vehicle.uses;
  if (uses === undefined) return vehicle;
  if (!Array.isArray(uses) || uses.length === 0) throw new AssemblyError(file, '"uses" must be a non-empty array when present');
  const parts: VehiclePartPlacement[] = [];
  const stageGroups: VehicleDef['stageGroups'] = [];
  const stages: VehicleDef['stages'] = [];
  const abort: TimedStageAction[] = [];
  const actionGroups: Record<string, StageAction[]> = {};
  const prefixes = new Set<string>();
  const joinGroups = (groups: Record<string, StageAction[]>, rename: (id: string) => string): void => {
    for (const [name, list] of Object.entries(groups)) (actionGroups[name] ??= []).push(...list.map((a) => renameAction(a, rename)));
  };
  (uses as VehicleUseDef[]).forEach((use, i) => {
    const at = `uses[${i}]`;
    if (!isObject(use)) throw new AssemblyError(file, `${at} must be an object`);
    const asm = assemblies[use.assembly];
    if (!asm) throw new AssemblyError(file, `${at}: unknown assembly "${String(use.assembly)}" (data/defs/assemblies/<id>.json)`);
    const prefix = use.prefix;
    if (typeof prefix !== 'string' || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(prefix)) throw new AssemblyError(file, `${at}: "prefix" must be a lower-kebab id, got ${JSON.stringify(prefix)}`);
    const sep = separatorOf(prefix);
    if (sep !== null) throw new AssemblyError(file, `${at}: the prefix "${prefix}" contains '${sep}', which composes runtime ids`);
    if (prefixes.has(prefix)) throw new AssemblyError(file, `${at}: the prefix "${prefix}" is used twice`);
    prefixes.add(prefix);
    if (use.parent !== null && typeof use.parent !== 'string') throw new AssemblyError(file, `${at}: "parent" must be an instance id or null`);
    const rename = (id: string): string => `${prefix}-${id}`;
    const own = new Set(asm.parts.map((p) => rename(p.id)));
    const overrides = use.resources ?? {};
    if (!isObject(overrides)) throw new AssemblyError(file, `${at}: "resources" must be an object: prefixed instance id -> resource id -> kg`);
    for (const id of Object.keys(overrides)) {
      if (!own.has(id)) throw new AssemblyError(file, `${at}: "resources" names "${id}", which is not a part of assembly "${asm.id}" under the prefix "${prefix}"`);
    }
    for (const p of asm.parts) {
      const id = rename(p.id);
      const placed: VehiclePartPlacement = { ...p, id, stageGroup: rename(p.stageGroup), parent: p.parent === null ? use.parent : rename(p.parent) };
      if (p.parent === null) {
        delete placed.parentNode;
        delete placed.node;
        if (use.parentNode !== undefined) placed.parentNode = use.parentNode;
        if (use.node !== undefined) placed.node = use.node;
      }
      const load = overrides[id];
      if (load !== undefined) placed.resources = { ...(p.resources ?? {}), ...load };
      if (p.symmetry) placed.symmetry = { ...p.symmetry, group: rename(p.symmetry.group) };
      parts.push(placed);
    }
    stageGroups.push(...asm.stageGroups.map((g) => ({ id: rename(g.id), label: g.label })));
    stages.push(...asm.stages.map((s) => ({ label: s.label, icon: s.icon, actions: s.actions.map((a) => renameAction(a, rename)) })));
    abort.push(...asm.abort.map((a) => renameAction(a, rename)));
    joinGroups(asm.actionGroups, rename);
  });
  parts.push(...vehicle.parts);
  stageGroups.push(...vehicle.stageGroups);
  stages.push(...vehicle.stages);
  abort.push(...vehicle.abort);
  joinGroups(vehicle.actionGroups, (id) => id);
  const ids = new Set<string>();
  for (const p of parts) {
    if (ids.has(p.id)) throw new AssemblyError(file, `the instance id "${p.id}" is produced twice (an assembly's prefixed id and another part)`);
    ids.add(p.id);
  }
  const groupIds = new Set<string>();
  for (const g of stageGroups) {
    if (groupIds.has(g.id)) throw new AssemblyError(file, `the stage group "${g.id}" is produced twice`);
    groupIds.add(g.id);
  }
  const { uses: _uses, ...rest } = vehicle;
  return { ...rest, parts, stageGroups, stages, abort, actionGroups };
}
