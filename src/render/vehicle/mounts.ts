/**
 * Which parts an engine is mounted on, from the part list of a vessel and the part definitions alone
 * (docs/ARCHITECTURE.md 18.7): the vessel feature stains a part with the soot of the engines it carries, and a
 * snapshot states no part tree. Nothing here reads a vehicle definition, so a design that is not in the
 * library and the second craft of one type in an assembly are handled like any other.
 *
 * The mount of an engine part, within its own craft:
 *  - an engine with attach nodes sits where a node of its own meets a node of another part: every part that
 *    shares a node position with it (the thrust structure it hangs from);
 *  - an engine without attach nodes is placed on another part's skin or inside it (retro and ullage motor
 *    packs, RCS pods, a tower's jettison motor): the part whose envelope (`PartDef.bounds`, a cylinder in the
 *    part frame) is nearest to the engine's origin, and of several that hold it the one whose own origin is
 *    nearest.
 * For a stack built by the simulation's assembler this is the engine's parent in the vehicle tree
 * (tests/unit/vehicle/mounts.test.ts holds it against every vehicle of the library).
 */
import type { DefLibrary, PartDef } from '@/core/contracts/defs';
import type { PartSnapshot } from '@/core/contracts/sim';
import { quat, v3 } from '@/core/math';

/** Two attach nodes closer than this are one joint, m. */
const NODE_MATE_DISTANCE = 0.01;

const hasEngine = (def: PartDef): boolean => {
  for (const m of def.modules) if (m.type === 'engine') return true;
  return false;
};

/**
 * For every part of `parts` (by index) the indices of the engine parts mounted on it; parts that carry no
 * engine have no entry. `craftOf(part)` tells the craft of a part: an engine is mounted on a part of its own
 * craft only (two docked craft touch at their ports, and a port is no thrust structure).
 */
export function engineMounts(defs: DefLibrary, parts: readonly PartSnapshot[], craftOf: (part: PartSnapshot) => string): Map<number, number[]> {
  const mounts = new Map<number, number[]>();
  const partDefs = parts.map((p) => defs.parts[p.def]);
  const crafts = parts.map(craftOf);
  const add = (host: number, engine: number): void => {
    const list = mounts.get(host);
    if (list) list.push(engine);
    else mounts.set(host, [engine]);
  };
  for (let e = 0; e < parts.length; e++) {
    const eDef = partDefs[e];
    if (!eDef || !hasEngine(eDef)) continue;
    const engine = parts[e]!;
    if (eDef.attachNodes.length > 0) {
      for (let x = 0; x < parts.length; x++) {
        const xDef = partDefs[x];
        if (x === e || !xDef || crafts[x] !== crafts[e]) continue;
        const other = parts[x]!;
        let mated = false;
        for (const n of eDef.attachNodes) {
          const pe = v3.add(engine.localPos, quat.rotate(engine.localRot, v3.fromTuple(n.pos)));
          for (const m of xDef.attachNodes) {
            if (v3.dist(pe, v3.add(other.localPos, quat.rotate(other.localRot, v3.fromTuple(m.pos)))) < NODE_MATE_DISTANCE) {
              mated = true;
              break;
            }
          }
          if (mated) break;
        }
        if (mated) add(x, e);
      }
      continue;
    }
    let best = -1;
    let bestGap = Number.POSITIVE_INFINITY;
    let bestOrigin = Number.POSITIVE_INFINITY;
    for (let x = 0; x < parts.length; x++) {
      const xDef = partDefs[x];
      if (x === e || !xDef || crafts[x] !== crafts[e]) continue;
      const other = parts[x]!;
      const local = quat.rotateInv(other.localRot, v3.sub(engine.localPos, other.localPos));
      const radial = Math.max(0, Math.hypot(local.x, local.z) - xDef.bounds.radius);
      const axial = local.y < xDef.bounds.yMin ? xDef.bounds.yMin - local.y : local.y > xDef.bounds.yMax ? local.y - xDef.bounds.yMax : 0;
      const gap = Math.hypot(radial, axial);
      const origin = v3.dist(engine.localPos, other.localPos);
      if (gap < bestGap || (gap === bestGap && origin < bestOrigin)) {
        best = x;
        bestGap = gap;
        bestOrigin = origin;
      }
    }
    if (best >= 0) add(best, e);
  }
  return mounts;
}
