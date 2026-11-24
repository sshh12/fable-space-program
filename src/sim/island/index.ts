/**
 * The island: the unit of simulation (docs/ARCHITECTURE.md 7.1). `api.ts` is the contract; these are its
 * functions, with the signatures of `IslandFactory`.
 */
import type { Island, IslandDeps, IslandFactory, IslandInit, StepMode } from './api';
import { decodeIslandInto, islandHash as hashOfBytes } from './codec';
import { IslandImpl } from './island';

export * from './api';
export { BodyFrames, comStateOf, setFromCom, IMPACT_PREDICTION_LAMBDA } from './frames';
export { bodyEnvBase, IslandEnv, OrientationCache, type BodyEnvBase } from './environment';
export { FarSet, isDebris, type FarObject, type FarOptions, type FarSink } from './far';
export { computeRailsEvent, railsStateAt, orbitOf, type RailsEvent, type RailsEventKind } from './rails';
export { TerrainPolicy } from './terrainPolicy';
export { checksumOfVessel, checksumsAgree, craftListHash, IslandOpError } from './ops';
export { ISLAND_CODEC_VERSION } from './codec';
export { pairReach, reachTime, underThresholdWatch, ROTATION_WARP_LIMIT, SAS_TRACK_ERROR, type Seat } from './island';

/** A new, empty island at a tick about a body. */
export function createIsland(deps: IslandDeps, init: IslandInit): Island {
  return new IslandImpl(deps, init);
}

/** Restore an island from its codec bytes; `mode` may differ from the encoder's (a server checkpoint read by a replica). */
export function decodeIsland(deps: IslandDeps, bytes: Uint8Array, options?: { mode?: StepMode }): Island {
  return decodeIslandInto((init) => new IslandImpl(deps, init), deps, bytes, options?.mode);
}

/** Hash of island codec bytes (16 hex digits): every byte but the header and the names. */
export function islandHash(bytes: Uint8Array): string {
  return hashOfBytes(bytes);
}

/** The three functions as one value, checked against the contract. */
export const islandFactory: IslandFactory = { createIsland, decodeIsland, islandHash };
