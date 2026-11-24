/**
 * validateVehicle (docs/ARCHITECTURE.md 9.2; contracts/vehicle.ts): what is wrong with a vehicle, as issues
 * a player, a builder or a test can read. A vehicle with an 'error' is not spawned.
 *
 *   validateVehicle(defs, vehicle, context?): Issue[]
 *
 * 1. The structural checks of src/core/defs/vehicleStructure.ts (the loader's): unknown parts, one root,
 *    reachability, placement, node kinds and occupancy, stage groups, actions on parts with the needed module,
 *    a command part. When the part graph cannot be assembled, these are all that is reported.
 * 2. Assembled by the simulation's assembler (part poses from attach nodes):
 *    - 'nodeSizeMismatch': a part whose mating node is larger than the node it stands on (a narrower part on a
 *      wider face is a bulkhead mount and is fine; equal within NODE_SIZE_TOLERANCE);
 *    - 'overlap': two part colliders interpenetrating by more than OVERLAP_TOLERANCE, measured by the
 *      simulation's clearance code (clearance.ts: the bounds cylinder, the legs at their deployment), between
 *      parts that are not joined. Not compared: a part and its parent or a docked peer (they meet at the mated
 *      faces), two parts mounted on one parent (their layout is the parent's: engines in a cluster, an engine
 *      in the interstage hung from the same stage), a fairing and what it shields, and landing legs (their
 *      collider is the cylinder round folded struts, not the struts);
 *    - 'launchSequence': a stage whose actions name parts of more than one craft (a vehicle that mates trees
 *      by docking ports is several craft from its first tick; its stage list must compile into entries that
 *      each name ONE craft: ARCHITECTURE 7.2, the launch sequence);
 *    - 'noClamps' (pad start): nothing holds the vehicle on the pad;
 *    - 'padClassExceeded': the lift-off mass or the stack diameter over the pad's limits (padLimitsOf with the
 *      rules document in force), or the vehicle's pad class larger than the pad's.
 *
 * Pure; the vehicle may be one the library does not hold.
 */
import type { DefLibrary, PadDef, VehicleDef } from '@/core/contracts/defs';
import { DEFAULT_PAD_CLASS_LIMITS, type PadClass, type UniverseRules } from '@/core/contracts/net';
import type { Issue } from '@/core/contracts/vehicle';
import { padLimitsOf } from '@/core/defs/sites';
import { actionParts, nodeOf, structuralIssues } from '@/core/defs/vehicleStructure';
import { analyzeVehicle } from './analyze';
import { buildVehicle } from './assemble';
import { vesselClearance } from './clearance';
import type { PartRuntime, Vessel } from './types';

/** Mated node sizes may differ by this share of the larger, or 0.1 m, whichever is more. */
export const NODE_SIZE_TOLERANCE = 0.1;
/** Colliders may interpenetrate this much (m) before it is an overlap. */
export const OVERLAP_TOLERANCE = 0.05;

export interface ValidationContext {
  /** How it starts: 'pad' (the default: a spawn on a pad) needs clamps; any other start does not. */
  start?: 'pad' | 'orbit' | 'landed' | 'state';
  /** The pad it is spawned on: its class and limits are checked. Absent = the limits of the vehicle's own pad class. */
  pad?: PadDef;
  /** The rules document in force (its pad class limits); absent = the contract's defaults. */
  rules?: UniverseRules;
}

const CLASS_ORDER: readonly PadClass[] = ['light', 'medium', 'heavy'];

/** Structural codes after which the part graph cannot be assembled. */
const FATAL = new Set(['unknownPart', 'noRoot', 'multipleRoots', 'unknownParent', 'unreachablePart', 'noPlacement', 'unknownNode', 'unknownStageGroup', 'duplicatePart', 'badId']);

export function validateVehicle(defs: DefLibrary, vehicle: VehicleDef, context: ValidationContext = {}): Issue[] {
  const issues: Issue[] = structuralIssues(defs.parts, vehicle);
  if (issues.some((i) => FATAL.has(i.code))) return issues;
  const lib = defs.vehicles[vehicle.id] === vehicle ? defs : { ...defs, vehicles: { ...defs.vehicles, [vehicle.id]: vehicle } };
  let vessel: Vessel;
  try {
    vessel = buildVehicle(lib, vehicle.id);
  } catch (e) {
    issues.push({ severity: 'error', code: 'assembly', message: `The vehicle cannot be assembled: ${(e as Error).message}`, parts: [] });
    return issues;
  }
  issues.push(...nodeSizeIssues(lib, vehicle), ...overlapIssues(vessel, vehicle), ...sequenceIssues(vessel, vehicle));
  const start = context.start ?? 'pad';
  if (start === 'pad') {
    if (!vessel.parts.some((p) => p.def.modules.some((m) => m.type === 'launchClamp'))) {
      issues.push({ severity: 'error', code: 'noClamps', message: 'Nothing holds the vehicle on the pad: it has no launch clamps.', parts: [] });
    }
    issues.push(...padIssues(lib, vehicle, context));
  }
  return issues;
}

function nodeSizeIssues(defs: DefLibrary, vehicle: VehicleDef): Issue[] {
  const out: Issue[] = [];
  const byId = new Map(vehicle.parts.map((p) => [p.id, p]));
  for (const p of vehicle.parts) {
    if (p.parent === null || p.parentNode === undefined || p.node === undefined || p.position !== undefined) continue;
    const parent = byId.get(p.parent)!;
    const pn = nodeOf(defs.parts[parent.def]!, p.parentNode)!;
    const cn = nodeOf(defs.parts[p.def]!, p.node)!;
    const allowed = Math.max(0.1, NODE_SIZE_TOLERANCE * Math.max(pn.size, cn.size));
    if (cn.size - pn.size > allowed) {
      out.push({ severity: 'error', code: 'nodeSizeMismatch', message: `Part "${p.id}" mates a ${cn.size} m node to the ${pn.size} m node "${p.parentNode}" of "${p.parent}": it is wider than what it stands on.`, parts: [p.id, p.parent], value: cn.size - pn.size });
    }
  }
  return out;
}

/** A vessel of one part, for the clearance query between two parts of one vessel. */
const alone = (v: Vessel, p: PartRuntime): Vessel => ({ ...v, parts: [p] });

/**
 * A part that is hollow by function, whose bounds cylinder (solid, in the clearance code) stands for a shell:
 * a fairing, a decoupler (an interstage, an adapter ring), and a ring of fixed-burn motors placed round a
 * stage (its bounds wider than the part it is fixed to). What sits inside one is not an overlap.
 */
function isHollow(vessel: Vessel, p: PartRuntime, byPosition: boolean): boolean {
  if (p.def.category === 'decoupler' || p.def.modules.some((m) => m.type === 'fairing')) return true;
  const parent = p.parent >= 0 ? vessel.parts[p.parent] : undefined;
  return byPosition && parent !== undefined && p.def.modules.some((m) => m.type === 'engine' && m.fixedBurn !== undefined) && p.def.bounds.radius > parent.def.bounds.radius;
}

function overlapIssues(vessel: Vessel, vehicle: VehicleDef): Issue[] {
  const out: Issue[] = [];
  const parts = vessel.parts;
  const linked = new Set(vessel.links.map((l) => `${Math.min(l.a, l.b)}:${Math.max(l.a, l.b)}`));
  const byPosition = new Set(vehicle.parts.filter((p) => p.position !== undefined).map((p) => p.id));
  const hollow = parts.map((p) => isHollow(vessel, p, byPosition.has(p.instanceId)));
  const isLegs = (p: PartRuntime): boolean => p.def.modules.some((m) => m.type === 'legs');
  for (let i = 0; i < parts.length; i++) {
    for (let j = i + 1; j < parts.length; j++) {
      const a = parts[i]!;
      const b = parts[j]!;
      // Joined at mated faces, or a docked pair.
      if (a.parent === j || b.parent === i || linked.has(`${i}:${j}`)) continue;
      // Two parts mounted on attach nodes of one parent: their layout is the parent's.
      if (a.parent >= 0 && a.parent === b.parent && !byPosition.has(a.instanceId) && !byPosition.has(b.instanceId)) continue;
      if (hollow[i] || hollow[j] || isLegs(a) || isLegs(b)) continue;
      const d = vesselClearance(alone(vessel, a), alone(vessel, b));
      if (d < -OVERLAP_TOLERANCE) {
        out.push({ severity: 'error', code: 'overlap', message: `Parts "${a.instanceId}" and "${b.instanceId}" overlap by ${(-d).toFixed(2)} m.`, parts: [a.instanceId, b.instanceId], value: -d });
      }
    }
  }
  return out;
}

/** Every stage's actions must name parts of one craft: the launch sequence compiles into entries that name their craft. */
function sequenceIssues(vessel: Vessel, vehicle: VehicleDef): Issue[] {
  const out: Issue[] = [];
  if (vessel.crafts.length < 2) return out;
  const craftOf = new Map(vessel.parts.map((p) => [p.instanceId, p.craft]));
  vehicle.stages.forEach((s, i) => {
    const crafts = new Set<number>();
    for (const a of s.actions) for (const id of actionParts(a)) crafts.add(craftOf.get(id)!);
    if (crafts.size > 1) {
      out.push({ severity: 'error', code: 'launchSequence', message: `Stage ${i} ("${s.label}") acts on ${crafts.size} craft (${[...crafts].map((c) => vessel.crafts[c]!.root).join(', ')}): an entry of the launch sequence names one craft.`, parts: s.actions.flatMap(actionParts), stageIndex: i });
    }
  });
  return out;
}

function padIssues(defs: DefLibrary, vehicle: VehicleDef, context: ValidationContext): Issue[] {
  const out: Issue[] = [];
  const caps = analyzeVehicle(defs, vehicle, context.rules ? { rules: context.rules } : {});
  const cls = caps.padClass;
  const limits = context.pad ? padLimitsOf(context.pad, context.rules) : (context.rules?.pads.classLimits ?? DEFAULT_PAD_CLASS_LIMITS)[cls];
  const where = context.pad ? `pad "${context.pad.id}"` : `a ${cls} pad`;
  if (context.pad && CLASS_ORDER.indexOf(cls) > CLASS_ORDER.indexOf(context.pad.class)) {
    out.push({ severity: 'error', code: 'padClassExceeded', message: `A ${cls} vehicle cannot launch from ${where}, which is ${context.pad.class}.`, parts: [] });
  }
  if (caps.massWet > limits.maxLiftoffMass) {
    out.push({ severity: 'error', code: 'padClassExceeded', message: `Lift-off mass ${(caps.massWet / 1000).toFixed(1)} t is over the ${(limits.maxLiftoffMass / 1000).toFixed(1)} t that ${where} takes.`, parts: [], value: caps.massWet });
  }
  if (caps.diameter > limits.maxDiameter) {
    out.push({ severity: 'error', code: 'padClassExceeded', message: `The stack is ${caps.diameter.toFixed(2)} m across, over the ${limits.maxDiameter} m that ${where} takes.`, parts: [], value: caps.diameter });
  }
  return out;
}
