/**
 * Public API of the terrain renderer (terrain-render). The app registers one feature:
 *
 *   const terrain = createTerrainFeature(renderer.context, () => terrainAuthorityTheSimUses);
 *   await renderer.addFeature(terrain);
 *
 * docs/handoff/terrain-render.md is the manual.
 */
export { createTerrainFeature } from './feature';
export type { TerrainBodyStats, TerrainDebug, TerrainFeature, TerrainFeatureOptions, TerrainProviderFactory } from './feature';
export { DEFAULT_STREAMER_OPTIONS } from './streamer';
export type { StreamerOptions, StreamStats } from './streamer';
export { SURFACE_PARAM_KEYS } from './materials';
export type { MaterialSetManifest, SurfaceParamKey, SurfaceParams } from './materials';
