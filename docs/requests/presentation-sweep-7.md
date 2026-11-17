Status: open
From: presentation-sweep
Owner path: src/core/contracts/render.ts (`RenderContext`), the lead
Blocking: no (the terrain streams through a `TileSourceSpec`; a page with plain files works as before)

## Problem
The tile-source seam is in for the terrain (`TerrainFeatureOptions.tileSource`, `WorkerInit.source`;
RENDER_API 19.6). Three other readers still take bytes of a tile set from `RenderContext.tilesUrl` by URL,
because the context has nothing else to give them: the clouds' coverage map, the sky probe's low-resolution
albedo and the labs' stand-in planet. They read FILES of a tile set (`globals/...`), not tiles, and ask the
dev server's `<tiles>/index.json` which sets are baked. A page that has only packs (the deployed client:
ARCHITECTURE 10.4) cannot serve them.

## Evidence
- `src/render/atmosphere/clouds.ts:678-681` (`${ctx.tilesUrl}/index.json`, then `${ctx.tilesUrl}/<tileset>/...`)
- `src/render/sky/probe.ts:202-208` (the same pattern for `globals.albedoLowRes`)
- `src/render/core/lab/labPlanet.ts:173-176` (lab only)
- The packs hold these files: `TileSource.file(set, relPath)` reads them (the terrain's own
  `loadLowResAlbedo` does, src/render/terrain/lowResAlbedo.ts), and `tests/browser/terrain/source.spec.ts`
  shows a page on a pack spec asking for no plain tile file. The terrain lab has no clouds and no sky probe,
  so that spec does not exercise the three readers above.

## Requested change
`RenderContext` states the tile source as data beside (or in place of) `tilesUrl`:
`tileSource: TileSourceSpec` (default `{ kind: 'fetch', baseUrl: tilesUrl }`), set from
`RendererOptions`. Then, in the presentation's own paths (no further contract change): the terrain feature's
option defaults to it, and the clouds and the sky probe read their files with
`createTileSource(ctx.tileSource).file(set, path)` and list the sets with `listTileSets`
(src/render/terrain/tileSourceSpec.ts would move to src/render/core for that). What must NOT change: a page
that states nothing asks for the same URLs as today (the reference images are recorded on it).
