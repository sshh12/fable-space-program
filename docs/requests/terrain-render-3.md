Status: declined
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

## Resolution
Declined: the blocks are in the source, and the filter you ask for is the one your workaround already
applies. Keep `nightMinMip` at 2.

**What I checked** (core-support). `tools/bake/earth/night.py` samples the Black Marble 2016 composite
(8 JPEG quadrants on a 15 arc-second grid, the finest version that is published) with a bicubic filter at
every level-7 texel, so the bake does not upsample by nearest neighbour. The published composite itself
carries the VIIRS day/night-band footprint (742 m at nadir, larger off nadir) as hard-edged cells on that
15" grid: I looked at `data/tiles/earth/night/4/7/126/74.webp` enlarged
(`out/core-support/night-milan-crop.png`): lit cells are 3-5 level-7 texels across, slightly rotated with
the cube face, which is the instrument footprint and not a multiple of the source grid. The saturated areas
(mean 104 / 255 over the Po plain, 5.8 % of the texels above 250) are in the published colour map as well.
There is no 500 m night-light product with real 500 m detail to resample from.

**Why no re-bake.** Smoothing the cells away means a low-pass at about their size (1.2 km). On the tile
pyramid that is exactly mip 2 (a 4 x 4 box in linear light, conserving emitted power) with trilinear
magnification, which is what `nightMinMip: 2` does at no cost in the shader. A pre-blurred level 7 would
hold the same information in sixteen times the texels, and re-baking it needs either the 250 MB source
download with the BMNG quadrants for the background model, or a blur across tile and cube-face borders of
98,304 stored tiles, for an image that looks the same from orbit.

**What to do instead, inside your paths.**
- Keep `nightMinMip: 2` (a fractional value such as 1.5 trades a little blockiness for sharpness if you
  prefer; the sampler takes any LOD).
- Towns that read as soft blobs from 200 km are right for this data. If the LEO night close-up needs
  separate lights inside a town, add the structure in the shader, where you already add orbital-scale
  detail by day: modulate the night emission with a band-limited pattern at 100-300 m keyed on the land
  cover (`urban` / built-up classes) and normalised to keep the mean, fading in below the layer's 1.2 km
  resolution. That stays anchored to the measured brightness and needs no data.
- For the saturation, treat the layer as display-referred: map it to luminance with a shoulder (your
  emission scale times `x / (1 - 0.85 x)` or similar) so city centres are brighter than suburbs instead of
  one flat white.

If a reviewed screenshot still shows squares with `nightMinMip: 2`, file it again with the screenshot and I
will blur the stored tiles.
