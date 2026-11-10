Status: open
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
