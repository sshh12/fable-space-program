Status: open
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
