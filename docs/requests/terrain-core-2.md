Status: open
From: terrain-core
Owner path: tools/bake/moon (region.py, NAC seam correction) and the baked data/tiles/moon levels 10-12
Blocking: no

## Problem
North-south stripes are visible in hillshades of the regional Moon levels 10-12 inside and next to the NAC
strip: narrow parallel ridges/grooves a few metres apart and tens of centimetres high, running the length of
the strip. They look like residuals of the NAC left/right image boundary (the region file's `seamCorrection`
note mentions a step of up to 0.7 m near DTM columns 940-1060) and of the DTM's own along-track artefacts.
Under a low sun the renderer will draw them as furrows; the procedural amplification cannot hide them because
the data is used as given wherever it exists.

## Evidence
- `npx tsx tools/terrain-core/render-hillshade.ts`: `out/terrain-core/moon-edge-L10.png` (right third:
  vertical stripes), `moon-edge-L12.png` (left half: vertical banding), `moon-target-2000m.png`.
- Sun azimuth 100 deg, elevation 12 deg; each pixel samples the height function at a band limit of 1.5 pixels.

## Requested change
Check the NAC DTM seam correction and filter remaining along-track stripes in levels 10-12 (e.g. a narrow
across-track high-pass notch on the DTM before resampling), or confirm that the stripes are real topography.
No change in terrain-core is needed either way.
