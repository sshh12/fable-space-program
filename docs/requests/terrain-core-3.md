Status: resolved (commit a6dc2b7; regional sea floor first replaced in 5b4f658)
From: terrain-core
Owner path: tools/bake/earth (regional heights near Ka Lae) and the baked data/tiles/earth levels 8-12
Blocking: no

## Problem
The regional sea floor around the launch site is terraced: large areas hold one constant height, separated
by steps of tens of metres over a few tens of metres, and the coastal cliff is stair-stepped in 60-120 m
blocks. In a hillshade the steps show as straight lines across the sea floor and the coast as a jagged
staircase. They will be visible through shallow water (refraction, shore foam reads the seabed) and along
the coast from the pad.

## Evidence
- `npx tsx tools/terrain-core/render-hillshade.ts`, `out/terrain-core/earth-pad-3000m.png` (right third:
  staircase coast, two horizontal lines across the sea floor).
- Data heights (terrain-core with amplification off, band limit 0.5 m) along a north-south line 1,300 m east
  of the pad centre: exactly -157.0000 m from 150 to 180 m north, a 59 m ramp from 182 to 232 m north, then
  exactly -98.0000 m beyond (all inside level-12 tile face 1 x 2977 y 2821).

## Requested change
Check the regional bathymetry source and the land/water sign correction near the coast (the constant
plateaus look like a filled no-data area or a coarse bathymetry grid upsampled with nearest-neighbour), and
resample it smoothly (bilinear/bicubic from the coarse grid, feathered into the regional land heights).
No change in terrain-core is needed.

## Resolution
The plateaus were Terrarium's own sea values (a blocky nearest-neighbour resampling of coarse bathymetry that
steps at every z15 tile edge). Since 5b4f658 the regional source uses Terrarium on land only; the sea floor is
ETOPO 2022 15" Catmull-Rom, ramped from 0 m at the ESA WorldCover coastline to the ETOPO depth over 1.5 km
(`tools/bake/earth/regsrc.py`). a6dc2b7 additionally drives that ramp with the coast distance smoothed over
300 m: the plain Euclidean distance made faint facets fan out from every bay and headland in a hillshade.
The regional height levels 8-12 were re-baked with it (the manifest contentHash changes with every re-bake
since a9d9f1a).
- Your profile 1,300 m east of the pad, 0-390 m north, level 12 Catmull-Rom every 10 m: -8.6 m to -9.2 m to
  -8.0 m, largest step between neighbouring samples 0.13 m (no constant runs, no ramps).
- `out/bake/earth/contact/region-earth-ka-lae-hillshade-pad-20km.png` and `-pad-3km.png`: no terraces or
  facets; beyond 1.5 km from the coast the sea floor equals ETOPO (identical to an ETOPO-only hillshade).
- Remaining limitation: no near-shore survey exists in the sources, so the first 200-300 m off the coast are
  a smooth shelf less than 5 m deep rather than the real drop-off of the lava coast.
Re-run `npx tsx tools/terrain-core/render-hillshade.ts` and the realData suite to pick up the new tiles.
