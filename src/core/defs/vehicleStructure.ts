/**
 * The STRUCTURAL checks of a vehicle (docs/ARCHITECTURE.md 9.2): what can be said of a `VehicleDef` from the
 * part library alone, without placing a part. The loader refuses a library whose vehicle fails one of them
 * (src/core/defs/loader.ts); `validateVehicle` of src/sim/vessel/validate.ts runs them first and reports them
 * as issues, then adds what needs the assembler and the collider library (sizes of mated nodes, overlap,
 * clamps for a pad start, the pad class, the launch sequence).
 *
 *   - every part names a part definition of the library, and its instance id composes no runtime id
 *     (no '/', '~' or '.': contracts/sim.ts, "Ids"); instance ids are unique;
 *   - exactly one root (a part without a parent), every other part reaches it through its parents;
 *   - every non-root part is placed by an attach node on each side (`parentNode` and `node`, both existing on
 *     the two definitions) or by an explicit `position`;
 *   - node kinds: a 'mount' node never mates a 'mount' or a 'dock' node; a 'dock' node mates a 'dock' node
 *     (a docked joint, recorded as a dock link) or carries a part that stands on its face;
 *   - occupancy: at most one child on any attach node of a part;
 *   - every part's stage group is declared;
 *   - every stage, abort and action-group action names parts of the vehicle that carry the module the
 *     action needs (an engine to ignite, a decoupler to cut, a parachute of the named mode to deploy, ...);
 *   - at least one part with a `command` module.
 *
 * Pure; src/core imports nothing outside src/core.
 */
import type { DockingPortModuleDef, ModuleDef, PartDef, StageAction, VehicleDef } from '../contracts/defs';
import type { Issue } from '../contracts/vehicle';

/** The characters that compose runtime ids ('/' part key, '~' derived vessel ids, '.' the lineage of a piece). */
export const RUNTIME_ID_SEPARATORS: readonly string[] = ['/', '~', '.'];

/** The separator a candidate id contains, or null. */
export function separatorOf(id: string): string | null {
  return RUNTIME_ID_SEPARATORS.find((c) => id.includes(c)) ?? null;
}

/** A module as the part data may state it: the members of `ModuleDef` and the docking port (contracts/defs.ts). */
export type AnyModuleDef = ModuleDef | DockingPortModuleDef;

/** The modules of a part definition, the docking port included. */
export function modulesOf(def: PartDef): readonly AnyModuleDef[] {
  return def.modules as readonly AnyModuleDef[];
}

/** The attach node `id` of a part definition. */
export function nodeOf(def: PartDef, id: string): PartDef['attachNodes'][number] | undefined {
  return def.attachNodes.find((n) => n.id === id);
}

/** The kind of an attach node ('stack' when the file states none). */
export function nodeKind(node: PartDef['attachNodes'][number]): 'stack' | 'mount' | 'dock' {
  return node.kind ?? 'stack';
}

/** Which module an action needs on each part it names, and how it is said in a sentence. */
function moduleTest(action: StageAction): { test: (m: AnyModuleDef) => boolean; what: string } {
  switch (action.kind) {
    case 'igniteEngines':
    case 'shutdownEngines':
      return { test: (m) => m.type === 'engine', what: 'an engine' };
    case 'fireSeparationMotors':
      return { test: (m) => m.type === 'engine' && m.fixedBurn !== undefined, what: 'a fixed-burn motor' };
    case 'releaseClamps':
      return { test: (m) => m.type === 'launchClamp', what: 'a launch clamp' };
    case 'decouple':
    case 'jettisonLES':
      return { test: (m) => m.type === 'decoupler', what: 'a decoupler' };
    case 'jettisonFairing':
      return { test: (m) => m.type === 'fairing', what: 'a fairing' };
    case 'deployParachute': {
      const mode = action.mode;
      return { test: (m) => m.type === 'parachute' && m.mode === mode, what: `a ${mode} parachute` };
    }
    case 'cutParachute':
      return { test: (m) => m.type === 'parachute', what: 'a parachute' };
    case 'deployLegs':
      return { test: (m) => m.type === 'legs', what: 'landing legs' };
    case 'enableRcs':
      return { test: (m) => m.type === 'rcs', what: 'RCS thrusters' };
    case 'undock':
      return { test: (m) => m.type === 'dockingPort', what: 'a docking port' };
  }
}

/** The instance ids an action names. */
export function actionParts(action: StageAction): string[] {
  return 'parts' in action ? action.parts : [action.part];
}

/** Where an action is listed, for a finding. */
type ActionPlace = { list: 'stage'; index: number } | { list: 'abort' } | { list: 'actionGroup'; name: string };

const placeWords = (at: ActionPlace): string => (at.list === 'stage' ? `stage ${at.index}` : at.list === 'abort' ? 'the abort sequence' : `action group "${at.name}"`);

/**
 * The structural findings of a vehicle against a part library, every one an 'error' (a vehicle that fails
 * one cannot be assembled the way its file says). Empty for a vehicle the assembler can build.
 */
export function structuralIssues(parts: Readonly<Record<string, PartDef>>, vehicle: VehicleDef): Issue[] {
  const issues: Issue[] = [];
  const add = (code: string, message: string, ids: string[], extra: { stageIndex?: number; value?: number } = {}): void => {
    issues.push({ severity: 'error', code, message, parts: ids, ...extra });
  };
  const inVehicleId = separatorOf(vehicle.id);
  if (inVehicleId !== null) add('badId', `The vehicle id "${vehicle.id}" contains '${inVehicleId}', which composes runtime ids.`, []);
  const byId = new Map<string, VehicleDef['parts'][number]>();
  for (const p of vehicle.parts) {
    const sep = separatorOf(p.id);
    if (sep !== null) add('badId', `Part instance id "${p.id}" contains '${sep}', which composes runtime ids.`, [p.id]);
    if (byId.has(p.id)) add('duplicatePart', `Two parts have the instance id "${p.id}".`, [p.id]);
    else byId.set(p.id, p);
    if (!parts[p.def]) add('unknownPart', `Part "${p.id}" uses the unknown part definition "${p.def}".`, [p.id]);
  }
  // One root, every part reaches it.
  const roots = vehicle.parts.filter((p) => p.parent === null);
  if (roots.length === 0) add('noRoot', 'The vehicle has no root part (a part without a parent).', []);
  else if (roots.length > 1) add('multipleRoots', `The vehicle has ${roots.length} root parts; it needs exactly one.`, roots.map((p) => p.id), { value: roots.length });
  for (const p of vehicle.parts) {
    if (p.parent !== null && !byId.has(p.parent)) add('unknownParent', `Part "${p.id}" names the unknown parent "${p.parent}".`, [p.id]);
  }
  for (const p of vehicle.parts) {
    const seen = new Set<string>();
    let at: VehicleDef['parts'][number] | undefined = p;
    while (at && at.parent !== null && !seen.has(at.id)) {
      seen.add(at.id);
      at = byId.get(at.parent);
    }
    if (at && at.parent !== null) add('unreachablePart', `Part "${p.id}" does not reach the root: its parents form a cycle.`, [p.id]);
  }
  // Placement, node kinds and occupancy.
  const childrenOnNode = new Map<string, string[]>();
  for (const p of vehicle.parts) {
    if (p.parent === null) continue;
    const parent = byId.get(p.parent);
    const def = parts[p.def];
    const parentDef = parent ? parts[parent.def] : undefined;
    if (!def || !parentDef) continue;
    if (p.position !== undefined) continue;
    if (p.parentNode === undefined || p.node === undefined) {
      add('noPlacement', `Part "${p.id}" needs an attach node on each side (parentNode and node) or an explicit position.`, [p.id]);
      continue;
    }
    const pn = nodeOf(parentDef, p.parentNode);
    const cn = nodeOf(def, p.node);
    if (!pn) add('unknownNode', `Part "${p.id}": its parent's definition "${parentDef.id}" has no attach node "${p.parentNode}".`, [p.id, p.parent]);
    if (!cn) add('unknownNode', `Part "${p.id}": its definition "${def.id}" has no attach node "${p.node}".`, [p.id]);
    if (!pn || !cn) continue;
    const a = nodeKind(pn);
    const b = nodeKind(cn);
    if ((a === 'mount' && (b === 'mount' || b === 'dock')) || (b === 'mount' && a === 'dock')) {
      add('nodeKind', `Part "${p.id}": a ${b} node cannot mate the ${a} node "${p.parentNode}" of "${p.parent}".`, [p.id, p.parent]);
    }
    const key = `${p.parent}\u0000${p.parentNode}`;
    const list = childrenOnNode.get(key) ?? [];
    list.push(p.id);
    childrenOnNode.set(key, list);
  }
  for (const [key, list] of childrenOnNode) {
    if (list.length < 2) continue;
    const [parent, node] = key.split('\u0000') as [string, string];
    add('nodeOccupied', `The attach node "${node}" of "${parent}" carries ${list.length} parts (${list.join(', ')}); a node takes one.`, [parent, ...list], { value: list.length });
  }
  // Stage groups.
  const groups = new Set(vehicle.stageGroups.map((g) => g.id));
  for (const p of vehicle.parts) {
    if (!groups.has(p.stageGroup)) add('unknownStageGroup', `Part "${p.id}" is in the undeclared stage group "${p.stageGroup}".`, [p.id]);
  }
  // Actions.
  const checkAction = (action: StageAction, at: ActionPlace): void => {
    const need = moduleTest(action);
    const stageIndex = at.list === 'stage' ? { stageIndex: at.index } : {};
    for (const id of actionParts(action)) {
      const pl = byId.get(id);
      const def = pl ? parts[pl.def] : undefined;
      if (!pl) add('stageActionTarget', `${placeWords(at)}: "${action.kind}" names "${id}", which is not a part of the vehicle.`, [id], stageIndex);
      else if (def && !modulesOf(def).some(need.test)) add('stageActionTarget', `${placeWords(at)}: "${action.kind}" names "${id}" (${def.id}), which has no ${need.what.replace(/^an? /, '')}.`, [id], stageIndex);
    }
  };
  vehicle.stages.forEach((s, i) => s.actions.forEach((a) => checkAction(a, { list: 'stage', index: i })));
  vehicle.abort.forEach((a) => checkAction(a, { list: 'abort' }));
  for (const [name, list] of Object.entries(vehicle.actionGroups)) list.forEach((a) => checkAction(a, { list: 'actionGroup', name }));
  // A command part.
  if (!vehicle.parts.some((p) => parts[p.def] && modulesOf(parts[p.def]!).some((m) => m.type === 'command'))) {
    add('noCommand', 'The vehicle has no command part: nothing can fly it.', []);
  }
  return issues;
}
