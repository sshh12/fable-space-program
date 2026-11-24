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

/** An instance id: lower-kebab, as an assembly prefix ('#' names fairing panel pieces, spaces and '__proto__' are not ids). */
export const INSTANCE_ID = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** The fields of a part placement (`VehiclePartPlacement`): anything else is a misspelling, refused by name. */
export const PLACEMENT_KEYS: ReadonlySet<string> = new Set(['id', 'def', 'parent', 'parentNode', 'node', 'position', 'rotationDeg', 'resources', 'stageGroup', 'symmetry']);

/**
 * What the stage list does, checked as a sequence: a stage list at all; every clamp released by a stage (an
 * error); nothing separated while the vehicle still stands on its clamps (an error); and as warnings, an engine
 * that no stage or abort lights, an action that names a part another stage already used up (a decoupler fired
 * twice), a lift-off stage that lights engines of more than one stage group, and a decoupler with nothing on it.
 */
function sequenceChecks(parts: Readonly<Record<string, PartDef>>, vehicle: VehicleDef, byId: Map<string, VehicleDef['parts'][number]>): Issue[] {
  const out: Issue[] = [];
  const has = (id: string, type: string): boolean => {
    const pl = byId.get(id);
    return pl !== undefined && parts[pl.def] !== undefined && modulesOf(parts[pl.def]!).some((m) => m.type === type);
  };
  if (vehicle.stages.length === 0) out.push({ severity: 'error', code: 'emptyStageList', message: 'The vehicle has no stages: nothing can launch it or fly it.', parts: [] });
  const clamps = vehicle.parts.filter((p) => has(p.id, 'launchClamp')).map((p) => p.id);
  const released = new Set(vehicle.stages.flatMap((s) => s.actions.filter((a) => a.kind === 'releaseClamps').flatMap(actionParts)));
  const held = clamps.filter((c) => !released.has(c));
  if (held.length > 0) out.push({ severity: 'error', code: 'clampsNeverReleased', message: `No stage releases the clamps ${held.join(', ')}: the vehicle never leaves the pad.`, parts: held });
  const liftoff = vehicle.stages.findIndex((s) => s.actions.some((a) => a.kind === 'releaseClamps'));
  if (liftoff >= 0) {
    for (const s of vehicle.stages.slice(0, liftoff + 1)) {
      for (const a of s.actions) if (a.kind === 'decouple' || a.kind === 'jettisonLES' || a.kind === 'jettisonFairing' || a.kind === 'undock') out.push({ severity: 'error', code: 'separationAtLiftoff', message: `"${a.kind}" of "${actionParts(a)[0]}" fires while the vehicle stands on its clamps.`, parts: actionParts(a), stageIndex: vehicle.stages.indexOf(s) });
    }
    const groups = new Set(vehicle.stages[liftoff]!.actions.filter((a) => a.kind === 'igniteEngines').flatMap(actionParts).map((id) => byId.get(id)?.stageGroup));
    if (groups.size > 1) out.push({ severity: 'warning', code: 'upperStageLitAtLiftoff', message: `The lift-off stage lights engines of ${groups.size} stage groups (${[...groups].join(', ')}).`, parts: [], stageIndex: liftoff });
  }
  const lit = new Set([...vehicle.stages.flatMap((s) => s.actions), ...vehicle.abort].filter((a) => a.kind === 'igniteEngines' || a.kind === 'fireSeparationMotors').flatMap(actionParts));
  for (const p of vehicle.parts) {
    const def = parts[p.def];
    // (A separation or ullage motor left unused is not a flight's engine: only throttled engines are held to it.)
    if (def && modulesOf(def).some((m) => m.type === 'engine' && m.fixedBurn === undefined) && !lit.has(p.id)) out.push({ severity: 'warning', code: 'engineNeverIgnited', message: `No stage lights the engine "${p.id}".`, parts: [p.id] });
  }
  const usedUp = new Map<string, number>();
  vehicle.stages.forEach((s, i) => {
    for (const a of s.actions) {
      if (a.kind !== 'decouple' && a.kind !== 'jettisonFairing' && a.kind !== 'jettisonLES' && a.kind !== 'releaseClamps') continue;
      for (const id of actionParts(a)) {
        const key = `${a.kind}:${id}`;
        if (usedUp.has(key)) out.push({ severity: 'warning', code: 'actionRepeated', message: `Stage ${i} fires "${a.kind}" of "${id}" again (stage ${usedUp.get(key)} did).`, parts: [id], stageIndex: i });
        else usedUp.set(key, i);
      }
    }
  });
  for (const p of vehicle.parts) {
    if (has(p.id, 'decoupler') && !vehicle.parts.some((q) => q.parent === p.id) && [...usedUp.keys()].includes(`decouple:${p.id}`)) out.push({ severity: 'warning', code: 'decouplerAlone', message: `The decoupler "${p.id}" carries nothing: firing it drops only itself.`, parts: [p.id] });
  }
  return out;
}

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
    else if (!INSTANCE_ID.test(p.id)) add('badId', `Part instance id "${p.id}" is not a lower-kebab id (a-z, 0-9 and single dashes).`, [p.id]);
    for (const k of Object.keys(p)) if (!PLACEMENT_KEYS.has(k)) add('unknownField', `Part "${p.id}" states "${k}", which is not a field of a part placement.`, [p.id]);
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
  // Loads: a known resource of the part, from 0 to its capacity.
  for (const p of vehicle.parts) {
    const def = parts[p.def];
    if (!def || p.resources === undefined) continue;
    for (const [res, kg] of Object.entries(p.resources)) {
      const tank = (def.resources ?? []).find((r) => r.resource === res);
      if (!tank) add('resourceLoad', `Part "${p.id}" (${def.id}) is loaded with "${res}", which it holds none of.`, [p.id]);
      else if (!(typeof kg === 'number' && Number.isFinite(kg) && kg >= 0 && kg <= tank.capacity * (1 + 1e-9))) add('resourceLoad', `Part "${p.id}" is loaded with ${String(kg)} kg of ${res}; its tank holds 0 to ${tank.capacity} kg.`, [p.id], { value: typeof kg === 'number' ? kg : NaN });
    }
  }
  // Crew: every crew member in a seat of a command part of the vehicle, one to a seat; a crewed module has seats.
  const seats = new Set<string>();
  for (const p of vehicle.parts) {
    for (const m of parts[p.def] ? modulesOf(parts[p.def]!) : []) {
      if (m.type !== 'command') continue;
      if (m.crewCapacity > 0 && m.seats.length === 0) add('crewSeats', `Part "${p.id}" seats ${m.crewCapacity} crew but has no seat.`, [p.id]);
      if (m.seats.length > m.crewCapacity) add('crewSeats', `Part "${p.id}" has ${m.seats.length} seats for a crew of ${m.crewCapacity}.`, [p.id]);
      for (const s of m.seats) seats.add(s.id);
    }
  }
  const taken = new Set<string>();
  for (const c of vehicle.crew) {
    if (!seats.has(c.seat)) add('crewSeats', `Crew member "${c.name}" sits in the unknown seat "${c.seat}".`, []);
    else if (taken.has(c.seat)) add('crewSeats', `Two crew members sit in seat "${c.seat}".`, []);
    taken.add(c.seat);
  }
  issues.push(...sequenceChecks(parts, vehicle, byId));
  return issues;
}
