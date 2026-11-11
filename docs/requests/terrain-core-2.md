Status: resolved (commits 2d0d820, c3fa50e; levels 7-12 re-baked)
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

## Resolution
Two different artefacts, one in each source; both are fixed in `tools/bake/moon/region.py` and levels 7-12 are
re-baked (`layers.height.build` changes the manifest's contentHash).
- **NAC stereo seam** (the line through the landing area): a step down to the east of up to 1.5 m (80-row block
  medians) along the NAC left/right image boundary, from DTM column ~970 (row 3000) to ~940 (row 13900) with a
  jog to columns 974-977 between rows ~7900 and ~8900 (the old note's "0.7 m, columns 940-1060" was wrong). The
  old correction picked the strongest excess of each 250-row block on its own, jumped between unrelated columns
  in the north and missed the seam beside the target. `correct_column_seam` now tracks the seam as one path
  (dynamic programming over 80-row blocks, one sign), corrects only blocks with a significant step at the path,
  replaces the step by a 240 m ramp and notches the thin ridge/groove residual along the path: step at the path
  RMS 0.74 -> 0.15 m, max 1.53 -> 0.72 m in the 108 corrected blocks; largest height change 0.99 m; nothing
  changes away from the path. `out/bake/moon/target.png` and your `moon-target-2000m.png` show no line.
- **SLDEM2015 altimeter-track stripes** (your `moon-edge-L10.png` right third and `moon-edge-L12.png` left half):
  both views lie 2.7-5 km outside the NAC strip, in SLDEM-based data. SLDEM2015 pulls the Kaguya TC DTM to LOLA
  shots, and LRO's polar ground tracks run along the columns of its grid, so track columns carry the shot-to-shot
  LOLA/TC differences (up to several metres). Not real topography: over the 64 km window the across-track
  roughness of fixed columns reached 2.13 x their neighbours' while no row exceeded 1.21 x (E-W control).
  `correct_track_stripes` (source option `trackStripeCorrection` on `sldem2015`) detects track pixels (across-track
  roughness above the neighbouring columns' and above their own along-track roughness) and replaces their narrow
  across-track residual (5-column median, clamped to 3 m): worst column 1.33 x, across/along-track roughness
  2.74 / 2.75 m (isotropic), change RMS 0.68 m; craters and wrinkle ridges are kept. `verify.py` checks the shipped
  level 9 over the disc: worst column 1.48 x its neighbours, 3 columns above 1.3 x (raw SLDEM over the same
  square 2.32 x, 58 columns; E-W control 1.29 x). Faint traces remain where a track's error exceeds the clamp (inside craters, and where
  several tracks lie within a few columns, e.g. beside the NAC strip's west edge).
- The NAC DTM's own along-track artefacts besides the seam are small: 2-10 cm RMS of column-coherent signal
  (block-to-block correlation of the column profile 0.11-0.13 against 0.01 for rows); not filtered.
Re-run `npx tsx tools/terrain-core/render-hillshade.ts` and the realData suite. Contact sheets:
`out/bake/moon/region-L9..L12.png`, `nac-strip-edge-L12.png`, `target.png`.
