Status: open
From: bodies-ephemeris
Owner path: tools/bake/planet (planet-bake: the baked albedo of the simple bodies)
Blocking: no

## Problem
The lead's decision on request bodies-ephemeris-4 (item 4) takes the far-field mean colour
(`render.meanColor`) of the bodies with no published colour index from the global colour maps planet-bake
bakes. Io and Ganymede have colour maps, and the generator now takes their area-weighted mean linear colour
from your cached sources (`tools/bodies/mapcolour.py` on `data/cache/planets/{io,ganymede}/dl/...`, read only):
Io (0.359, 0.248, 0.114), Ganymede (0.193, 0.179, 0.147). The other seven have no colour map: Europa,
Callisto and Iapetus are monochrome mosaics that your bake tints, and Mimas, Miranda, Ariel and Umbriel are
procedural. Their staged mean colour is neutral grey at the geometric albedo until the far impostor can match
what you bake.

## Evidence
`tools/bodies/sources/colours.json` (the seven rows carry that note); `tools/bake/planet/bodies/*.json`
`albedo.tint` / `albedo.procedural.color` for the seven.

## Requested change
When the level-0 albedo of these bodies is baked, report the mean LINEAR RGB of each body's level-0 albedo
(the six level-0 tiles decoded from sRGB, each texel weighted by its solid angle) for Europa, Callisto,
Iapetus, Mimas, Miranda, Ariel and Umbriel (and Io and Ganymede as a cross-check), e.g. as a small JSON file
under your paths or in your hand-off. The owner of `tools/bodies` (bodies-ephemeris now, solar-system-sim in
wave 4) then reads it into `tools/bodies/sources/colours.json` and regenerates; the generator keeps the
chromaticity and scales the luminance to the body's geometric albedo.

## Addendum (after the review of bodies-ephemeris)
1. Iapetus: its staged geometric albedo is the JPL Horizons value 0.6, its bright hemisphere only (NSSDC lists
   0.05 / 0.5 for the two hemispheres). Please include in the report its DISC-mean linear colour AND the
   disc-mean albedo of the baked level-0 map (solid-angle weighted), so the far impostor carries the
   two-tone body's mean rather than its bright side.
2. Large procedural craters: the generic models' crater population uses one depth-to-diameter ratio at every
   size (`freshDepthToDiameter` 0.196 x D, src/terrain/craters.ts), and your configs extend it to
   `maxDiameterRadii` 0.4 R; on Titania, Oberon, Ariel and Umbriel that is a 300-316 km basin 47-62 km deep,
   while basins that size are complex craters a few km deep. The staged terrain sections' `minElevation`
   follows what the bake produces (Titania -63.6 km, Oberon -61.4, Ariel -47.9, Umbriel -47.1), so it is right
   for your bake but the relief is not. If you move large craters to a complex-crater depth (or cap the depth),
   say so; the generator recomputes the bounds from your parameters, and from your manifests'
   `layers.height.elevation` as soon as they exist.
