Status: open (Moon part resolved by bake-moon-sky, commit 4f89577; the Earth part is bake-earth's)
From: terrain-core
Owner path: tools/bake/moon (region.py, sourceCoverage of the SLDEM band) and tools/bake/earth (heights.py, sourceCoverage over the regional sea floor)
Blocking: no

## Problem
`sourceCoverage` (docs/requests/terrain-core-1.md) tells the height authority where a sparse level holds data
genuinely finer than its parent; the effective level E rises to that level there and the procedural detail the
level would replace is switched off. Two kinds of listed tiles do not hold finer data, so the surface inside
them is smoother than outside the region (procedural detail removed, nothing real in its place):
- Moon level 9 (and partly 8): the SLDEM band (levels 7-9) samples SLDEM2015 at 512 ppd (~59 m pixels, shortest
  wavelength ~118 m). Level 9 (21 m posting) is meant to add the 41-83 m band, level 8 the 83-166 m band.
- Earth levels 8-12 over the sea: the regional sea floor is ETOPO 2022 15" (~460 m, shortest wavelength ~900 m)
  Catmull-Rom, posted at 150 m (level 8) down to 9.5 m (level 12).

## Evidence
- `npx vitest run tests/unit/terrain-core/realData.test.ts -t texture` prints, per level, the texture of H over
  the parent-level surface at the same points (band-pass RMS slope at 1 / 4 postings) 0.1, 0.5 and 1 tile inside
  the source boundary. Moon L9: 0.89/0.75 at 0.5 tile, 0.63/0.91 at 1 tile (L10, NAC: 1.17/1.06, 1.76/1.51). Earth,
  boundary points mostly over the sea: L9 0.48/0.81, 0.41/1.15; L11 0.48/0.56, 0.34/0.97; L12 0.89/0.61, 0.48/0.63.
- Level-L data detail (D at band lambda_L minus D at band 2 lambda_L, data only) 1.5 tiles inside the source
  boundary, RMS slope over one posting: Moon L9 0.005 (L10: 0.050, L12: 0.007); Earth L12 0.003.
- `out/terrain-core/earth-source-L11.png` (after `npx tsx tools/terrain-core/render-hillshade.ts`): left of the
  centre line the sea floor carries procedural relief, right of it (inside the source rectangle, 4.5 km deep)
  it is smooth and blurry. `moon-source-L9.png`: milder.
- Not a terrain-core defect: E is a pure function of the manifest (contract), so the manifest has to say where
  finer data exists. The coverage margins themselves are fixed (texture 0.99-1.05 of the parent's).

## Requested change
List in `sourceCoverage[L]` only tiles whose source resolves wavelengths below the parent's data wavelength
(two postings of level L-1):
- Moon: omit level 9 from the SLDEM band's source rectangles (an empty list, or no key), and level 8 too if its
  83-166 m band is mostly beyond SLDEM's resolution there. The NAC levels 10-12 stay as they are.
- Earth: at levels 8-12 list only tiles that contain land from the regional land source (3DEP); sea-only tiles
  stay in `coverage` but leave `sourceCoverage` (several rectangles per level are fine; terrain-core's weight
  handles any rectangle set).
- Consistency (both bakes): `sourceCoverage` = tiles touching the area where the level's source detail has a
  non-zero weight (the Moon's definition). bake-earth currently lists the tiles touching the full-weight area
  (100 km) while its feather reaches 105 km, so at levels 11-12 part of the feather lies in the margin.
Nothing else changes: `coverage`, tile contents and `layerHasTile` stay as they are; terrain-core needs no change.

## Resolution (Moon; bake-moon-sky, commit 4f89577)
`tools/bake/moon/region.py` lists a regional level in `sourceCoverage` only where its band's source pixel is
finer than the parent level's sample spacing at the region centre (`source_detail_levels`; the parent's data
reach two parent postings, so a coarser source adds nothing below them). Tranquility: SLDEM2015 59.2 m against
the parent spacings 186 m (level 7) and 93 m (level 8): levels 7-8 listed; 46.6 m (level 9): **level 9 lists
`[]`** (the key stays, with an empty rectangle set). NAC 2 m against 23 / 11.6 / 5.8 m: levels 10-12 listed,
unchanged. Level 8 stays listed: SLDEM resolves ~118-186 m, most of level 8's 93-186 m band. The definition
was already "tiles touching the area where the source has non-zero weight". `verify.py` checks it (levels
without finer source detail listed empty, all others covering every tile where their source has weight). The
manifest is re-written by the region bake; re-run the realData suite.
