Status: resolved (commit 37f6f54)
From: terrain-render
Owner path: src/terrain (baker.ts / body.ts load sets)
Blocking: no        (workaround in src/render/terrain: the tile is drawn and counted in `debug.stats().stream.incompleteBakes`)

## Problem
On the real Earth tile set, `bakeNormalMaterial` / `bakeTile` report `normalMaterial.complete === false` for every
render tile of level 14 and deeper near the pad, although `prepareTile` for the same tile has resolved (the hand-off
says every bake of a prepared tile is complete). Geometry is complete; levels up to 13 and the Moon are complete.
The renderer cannot tell whether such a normal/material map is final, so it cannot assert "no incomplete bakes".

## Evidence
`npx tsx tools/terrain/probe-bake.ts <body> <face>/<level>/<x>/<y> [residentLevel] [cacheMiB]` (terrain-render's
probe; it does exactly what a tile worker does: `prepareTile(body, key, 'render')` then `bakeTile`):

```
earth 1/12/2976/2821:      geometry complete true, normal complete true
earth 1/13/5952/5643:      geometry complete true, normal complete true
earth 1/14/11905/11287:    geometry complete true, normal complete false     (also with residentLevel 3, cache 384 MiB)
earth 1/16/47627/45147:    geometry complete true, normal complete false
earth 1/18/190519/180589:  geometry complete true, normal complete false
moon  0/14/11735/8253:     geometry complete true, normal complete true
```

The step from level 13 to 14 is where the normal band (tileSize / 128 = 4.8 m at level 14) first reaches the
Earth rock sizes (up to 3 m), so the suspect is the rock-abundance / land-cover read of the band raster (`ev.incomplete`
after `addBandRaster`) reading a land-cover tile that `prepareTile`'s load set does not contain; I did not trace it
further.

## Requested change
After `prepareTile(body, key)` resolves, `bakeTile(body, key).normalMaterial.complete` is true for every tile
(load set of `prepareTile` extended, or the flag corrected if the data read is in fact final). Nothing else changes.
If the map baked today is already final (a false alarm of the flag), say so in the resolution: the renderer then
needs no re-run of anything.

## Resolution
A real defect in terrain-core, fixed (core-support, commit 37f6f54). The map you baked was final
everywhere a rock could matter, but the flag was right to complain about what was read.

**Cause.** `splatRocks` (the band raster of the normal map) enumerates rock candidates by size class. The
cells of the largest, rarest classes are kilometres wide (the cell grows until it holds two candidates), so
for a 611 m tile at level 14 the candidates of those classes lay up to 7.1 km from the tile centre. Each
had its abundance read (land cover at the rock's own position, at the true effective level) BEFORE the
geometric test that drops rocks that cannot touch the tile, and land cover that far away is not in
`prepareTile`'s load set: 1,904 reads of non-resident tiles in your level-14 probe. From level 14 on because
that is where rocks first reach the normal band, as you guessed.

**Fix.** `BandRasterJob` has a new member `reaches(x, y, z, reach)` (exactly the index range `forEachNear`
would visit), and `splatRocks` asks it before it reads the abundance. No candidate that is dropped could
have contributed, so every bake is bit-identical to before; only the far reads are gone. Nothing changes in
the load sets.

**Result.** Your probe: `earth 1/14/11905/11287` and `earth 1/18/190519/180589` now report
`normal complete true`. New test in `tests/unit/terrain-core/realData.test.ts` ("bakes of prepared render
tiles are complete"): levels 12, 13, 14, 15, 16, 18, 20 near the pad with the worker configuration
(`residentLevel: 2`, 96 MiB cache), geometry and normal / material map complete at each; it failed at level
14 before the fix. terrain-core suite: 86 of 86.

**What to do.** Nothing has to be re-baked or re-run for correctness. You can now assert
`debug.stats().stream.incompleteBakes === 0` after streaming settles; if it is ever non-zero again, the
tile key is the evidence I need.
