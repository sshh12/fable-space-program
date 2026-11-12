/**
 * `CraftSnapshot.parent` (request sim-core-v2-4): the snapshot states the lineage of a craft, so that no
 * consumer takes a vessel id or a craft id apart to find what a piece of debris came from.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { DefLibrary } from '@/core/contracts/defs';
import type { CraftSnapshot } from '@/core/contracts/sim';
import { assembleVessel, craftSnapshots, fireNextStage, stepVessel, type Vessel } from '@/sim/vessel';
import { controls, DT, earthAir, loadLibrary, makeEnv, placeUpright, VEHICLE } from './helpers';

let lib: DefLibrary;
beforeAll(async () => {
  lib = await loadLibrary();
});

/** The stack on the pad, flown through the clamp release and the first stage separation: the stack first, then every piece that left it. */
function flownThroughFirstSeparation(craftId: string): Vessel[] {
  const v = assembleVessel(lib, VEHICLE, { craft: { craftId, ownerId: 'acct' } });
  const env = makeEnv({ atmosphere: earthAir });
  placeUpright(v, env, 120);
  const all = [v, ...fireNextStage(v, env).spawned];
  for (let i = 0; i < 480; i++) all.push(...stepVessel(v, env, controls({ throttle: 1 }), DT).spawned);
  for (let i = 0; i < 4 && all.length < 3; i++) {
    all.push(...fireNextStage(v, env).spawned);
    for (let k = 0; k < 240; k++) all.push(...stepVessel(v, env, controls({ throttle: 1 }), DT).spawned);
  }
  return all;
}

describe('CraftSnapshot.parent', () => {
  it('is null for the launched craft and the id of the craft it left for every piece', () => {
    const all = flownThroughFirstSeparation('c7');
    expect(all.length).toBeGreaterThanOrEqual(3);
    const [stack, ...pieces] = all;
    const launched = craftSnapshots(stack!);
    expect(launched).toHaveLength(1);
    expect(launched[0]!.id).toBe('c7');
    expect(launched[0]!.parent).toBeNull();
    for (const piece of pieces) {
      const crafts = craftSnapshots(piece);
      expect(crafts, piece.id).toHaveLength(1);
      // The snapshot says what the simulation recorded, and a piece is not its parent.
      expect(crafts[0]!.parent, piece.id).toBe(piece.crafts[0]!.parent);
      expect(crafts[0]!.parent, piece.id).toBe('c7');
      expect(crafts[0]!.id, piece.id).not.toBe('c7');
    }
  });

  it('finds the launched craft of a piece by following parents, with no string taken apart', () => {
    const all = flownThroughFirstSeparation('c7');
    const byId = new Map<string, CraftSnapshot>(all.flatMap((v) => craftSnapshots(v)).map((c) => [c.id, c] as const));
    const launchedOf = (craft: CraftSnapshot): string => {
      let at = craft;
      // A parent that is still in the snapshot is followed; one that is gone is the answer as far as it is known.
      for (let hops = 0; at.parent != null && hops < 64; hops++) {
        const up = byId.get(at.parent);
        if (!up) return at.parent;
        at = up;
      }
      return at.id;
    };
    for (const v of all) for (const c of craftSnapshots(v)) expect(launchedOf(c), c.id).toBe('c7');
    // The vessel id of a piece is NOT its craft id (it keeps its derived form), which is why the field exists.
    for (const piece of all.slice(1)) expect(piece.id, piece.id).not.toBe(craftSnapshots(piece)[0]!.id);
    // Every craft id is in one vessel only.
    const ids = all.flatMap((v) => craftSnapshots(v).map((c) => c.id));
    expect(new Set(ids).size).toBe(ids.length);
  });
});
