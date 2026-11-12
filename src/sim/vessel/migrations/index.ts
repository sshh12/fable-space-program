/**
 * The migration registry of the vessel codec (docs/ARCHITECTURE.md 7.2).
 *
 * A saved part belongs to the FINGERPRINT its definition had when it was written (the definition's modules,
 * resources, mass and number of thermal surfaces; `partFingerprint` in ../codec.ts). Rules that keep old
 * blobs readable: part, module and resource ids are never removed or renumbered, only deprecated; a change
 * of a part's modules, resources or mass is a new fingerprint WITH AN ENTRY HERE: a pure function from the
 * saved state under the old fingerprint to the saved state under the new one. The codec runs the chain of
 * entries from the written fingerprint to the current one on decode (lazily, on load) and then recomputes
 * the mass properties; a post-deploy sweep runs the same decode over every stored vessel before a lobby
 * opens. A blob whose part has no way to the current fingerprint is refused, naming the part.
 *
 * `MIGRATIONS` lists the migrations of released definition changes. It is empty: no definition has changed
 * since the first blob was written. The helpers below are what an entry is usually made of.
 */
import type { PartDef } from '@/core/contracts/defs';
import { createModuleRt, createModuleState } from '../assemble';

/** A module's saved state as plain data: its `ModuleState` and the internal run-time record beside it. */
export interface SavedModule {
  type: string;
  state: Record<string, unknown>;
  rt: Record<string, unknown>;
}

/** The saved state of one part, independent of the part's current definition. */
export interface SavedPart {
  instanceId: string;
  defId: string;
  /** Fingerprint of the definition this state is laid out for. */
  fingerprint: string;
  /** Resource amounts, kg, in the order of that definition's tanks. */
  resources: { resource: string; amount: number }[];
  /** One entry per module of that definition. */
  modules: SavedModule[];
  /** Temperature of each thermal surface, K. */
  temps: number[];
}

export interface PartMigration {
  /** Part definition id, the fingerprint the function reads and the one it produces. */
  defId: string;
  from: string;
  to: string;
  /** What changed, in a sentence (shown in the decode report and in the post-deploy sweep). */
  describe: string;
  /** Pure: returns the state laid out for `to`; `def` is the part's CURRENT definition. */
  migrate(saved: SavedPart, def: PartDef): SavedPart;
}

export class MigrationRegistry {
  private readonly byDef = new Map<string, PartMigration[]>();

  constructor(migrations: readonly PartMigration[] = []) {
    for (const m of migrations) {
      const list = this.byDef.get(m.defId) ?? [];
      if (list.some((x) => x.from === m.from)) throw new Error(`migration registry: two migrations of "${m.defId}" start at fingerprint ${m.from}`);
      list.push(m);
      this.byDef.set(m.defId, list);
    }
  }

  /** The chain of migrations that takes a part of `defId` from fingerprint `from` to `to`; null when there is none. */
  path(defId: string, from: string, to: string): PartMigration[] | null {
    const list = this.byDef.get(defId) ?? [];
    const out: PartMigration[] = [];
    let at = from;
    for (let guard = 0; guard <= list.length; guard++) {
      if (at === to) return out;
      const next = list.find((m) => m.from === at);
      if (!next) return null;
      out.push(next);
      at = next.to;
    }
    return null;
  }

  /** Every migration, for the corpus check. */
  all(): PartMigration[] {
    return [...this.byDef.values()].flat();
  }
}

/** Migrations of released definition changes, oldest first per definition. */
export const MIGRATIONS = new MigrationRegistry([]);

// ----------------------------------------------------------------------------------------------- helpers

/**
 * Lay the saved resources out for the current tanks: each tank keeps its amount CLAMPED to the new
 * capacity, a tank the definition gained starts empty, an amount whose tank is gone is dropped.
 */
export function fitResources(saved: SavedPart, def: PartDef): SavedPart {
  const tanks = def.resources ?? [];
  return {
    ...saved,
    resources: tanks.map((t) => {
      const old = saved.resources.find((x) => x.resource === t.resource);
      return { resource: t.resource, amount: old ? Math.min(Math.max(old.amount, 0), t.capacity) : 0 };
    }),
  };
}

/** The saved state with module `index` of the current definition inserted in its neutral start state (a module was added there). */
export function insertModule(saved: SavedPart, def: PartDef, index: number): SavedPart {
  const md = def.modules[index];
  if (!md) throw new Error(`insertModule: definition "${def.id}" has no module ${index}`);
  const modules = saved.modules.slice();
  modules.splice(index, 0, { type: md.type, state: createModuleState(md) as unknown as Record<string, unknown>, rt: createModuleRt(md) as unknown as Record<string, unknown> });
  return { ...saved, modules };
}

/** The saved state without module `index` (a module was retired from the definition). */
export function dropModule(saved: SavedPart, index: number): SavedPart {
  const modules = saved.modules.slice();
  modules.splice(index, 1);
  return { ...saved, modules };
}

/** The saved state with the number of surface temperatures the current definition has (new surfaces start at the part's mean). */
export function fitSurfaces(saved: SavedPart, def: PartDef): SavedPart {
  const n = def.thermal.surfaces.length;
  const mean = saved.temps.length > 0 ? saved.temps.reduce((a, b) => a + b, 0) / saved.temps.length : 290;
  const temps = saved.temps.slice(0, n);
  while (temps.length < n) temps.push(mean);
  return { ...saved, temps };
}
