Status: open
From: terrain-render
Owner path: tools/bake/earth (night layer), data/tiles/earth/night
Blocking: no        (workaround in data/defs/render/earth.surface.json: `nightMinMip` 2 filters the layer to its real resolution)

## Problem
The `night` layer at level 7 (305 m texels) does not hold 500 m data: lights are square blocks of about 4 x 4
texels (1.2 km) with hard edges, as from a nearest-neighbour upsample of a coarser source, and large areas are
saturated (the level-7 tile over Milan has a mean of 104 / 255). From low orbit a pixel is 160-270 m, so the
blocks are 5-8 pixels wide and towns render as squares.

## Evidence
`data/tiles/earth/night/4/7/126/74.webp` (Milan and the Po plain): open the tile in any image viewer and enlarge
it; every lit spot is a square of about 4 x 4 texels (an enlarged copy was looked at as
`out/terrain/probe/night-milan-L7.png`, not tracked). With the layer sampled at mip 0 the lab view
`earth-leo-nadir-night` (tests/browser/terrain/views.ts; add `&p.earth.nightMinMip=0` to its URL) shows the towns
as squares.

## Requested change
Level-7 night tiles resampled from the 500 m Black Marble source with a smooth filter (bilinear or better, not
nearest), levels 6..0 from them as now. If the 500 m source is not available, the same layer resampled smoothly from
whatever source there is: the blocks are the problem, more than the resolution. Nothing else changes; the renderer's
`nightMinMip` can then go to 0 in `data/defs/render/earth.surface.json` (terrain-render's file).
