/**
 * Public API of the terrain height authority (terrain-core). Browser- and worker-safe; the Node-only tile
 * source lives in ./fsTileSource (import it by path from Node code only).
 */
export { createTerrainProvider } from './provider';
export type { HeightParts, TerrainAuthority, TerrainBaker, TerrainDiagnostics, TerrainProviderOptions } from './provider';
export type { GeometryBake, NormalMaterialBake } from './baker';
export { AO_GAIN } from './baker';
export { createFetchTileSource, validateTileManifest } from './tileSource';
export { GEOMETRY_BAND_DIVISOR, GEOMETRY_GRID, GEOMETRY_QUADS, NORMAL_BAND_DIVISOR, NORMAL_MAP_SIZE } from './body';
export { vertexFaceCoord } from './collision';
export { rockBump, golombekArea, golombekDensity, golombekQ } from './rocks';
export { amplificationModelNames, registerAmplificationModel } from './amplification/registry';
export type { AmplificationFactory } from './amplification/registry';
export type { AmplificationModel, BandRasterJob, BodyServices, ModelContext, PointInfo } from './amplification/types';
