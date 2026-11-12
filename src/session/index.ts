/**
 * The in-process session (docs/ARCHITECTURE.md 7.1, "Session"; src/core/contracts/session.ts).
 *
 * `createSession(defs, scenarioId, { terrain })` is what the app loop, the pilots, the tools and the tests
 * hold: a `LocalSession`. Until `LocalSession` over the universe replaces it (MIGRATION_V2 steps 4.2 and
 * 4.3) the session IS the world orchestrator of src/sim/world, which speaks the v2 snapshot: the render
 * root at the active vessel's SOI body with a rebase when it changes, a private clock, craft blocks.
 */
import type { DefLibrary } from '@/core/contracts/defs';
import type { LocalSession } from '@/core/contracts/session';
import type { TerrainProvider } from '@/core/contracts/terrain';
import { createWorld, type CraftIdSource, type DebrisFate, type SimWorld, type WorldStats } from '@/sim';

export interface SessionOptions {
  /** The terrain authority the simulation collides with. */
  terrain: TerrainProvider;
  /** Where craft ids come from. Default: the local universe's seeded counter, so a session is reproducible. */
  ids?: CraftIdSource;
}

/** Read-only diagnostics of a session for tests and tools (not part of the `LocalSession` contract). */
export interface SessionDiagnostics {
  /** What became of every vessel the session removed. */
  debrisLog(): readonly DebrisFate[];
  stats(): WorldStats;
  /** Clearance between the part envelopes of two vessels on the same body, m (null when unknown ids or different bodies). */
  clearance(vesselIdA: string, vesselIdB: string): number | null;
}

export type { DebrisFate, WorldStats };

const diagnostics = new WeakMap<LocalSession, SimWorld>();

/** Create the session of scenario `scenarioId` of the definition library, on the given terrain authority. */
export function createSession(defs: DefLibrary, scenarioId: string, options: SessionOptions): LocalSession {
  const world = createWorld(defs, scenarioId, options.ids ? { terrain: options.terrain, ids: options.ids } : { terrain: options.terrain });
  diagnostics.set(world, world);
  return world;
}

/** The diagnostics of a session made by `createSession`. */
export function diagnosticsOf(session: LocalSession): SessionDiagnostics {
  const world = diagnostics.get(session);
  if (!world) throw new Error('diagnosticsOf: not a session made by createSession');
  return world;
}
