/**
 * What the single-clock host offers beside the session contract (`LocalSession`): its options and the
 * read-only diagnostics tests and tools use. Types, and the account id of the session's one pilot.
 */
import type { LocalSession } from '@/core/contracts/session';
import type { TerrainProvider } from '@/core/contracts/terrain';
import type { CraftIdSource } from '../vessel';
import type { DebrisFate } from './debris';

export type { DebrisFate };

export interface CreateSimOptions {
  terrain: TerrainProvider;
  /** Where craft ids come from (ARCHITECTURE section 3). Default: the local universe's seeded counter, so a session is reproducible. */
  ids?: CraftIdSource;
  /**
   * The render root of the snapshots (ARCHITECTURE section 3). 'soiBody' (the default, what `createSession`
   * gives): the origin of every `...Root` field is the centre of the active vessel's SOI body. 'rootBody':
   * the origin is the library's root body and is never replaced, for a tool that wants every ROOT position of
   * a whole flight about one body.
   */
  renderRoot?: 'soiBody' | 'rootBody';
}

export interface WorldStats {
  steps: number;
  railsAdvances: number;
  patchRefreshes: number;
  terrainRequests: number;
  /** Times warp was clamped to 1x because final terrain data was missing below 300 m. */
  terrainWarpClamps: number;
  /**
   * Vessel steps of the session's islands by path (`IslandCounters`): RK4 free flight; the sub-stepped path
   * with the vessel's own ground or water probe near (where v1 took it); the sub-stepped path WITHOUT one (a
   * pair in the contact regime: never, while no pair hook is installed).
   */
  freeSteps: number;
  probeSubsteps: number;
  pairSubsteps: number;
}

/** The session plus read-only diagnostics for tests and tools (not part of the contract). */
export interface SimWorld extends LocalSession {
  debrisLog(): readonly DebrisFate[];
  stats(): WorldStats;
  /** Clearance between the part envelopes of two vessels on the same body, m (null when unknown ids or different bodies). */
  clearance(vesselIdA: string, vesselIdB: string): number | null;
}

/** The one pilot of a single-clock session, as the island knows the seat. */
export const PILOT_ACCOUNT = 'local';

