Status: resolved (commit 3d9fcae)
From: terrain-core
Owner path: src/core/contracts/terrain.ts (TileLayerManifest, COVERAGE_BLEND_TILES and TerrainResidency comments); tools/bake/moon and tools/bake/earth (manifest writers)
Blocking: no

## Problem
The effective level E that keys procedural amplification is, per the contract, a pure function of the
coverage rectangles. The bakes extend every regional coverage rectangle one tile beyond the data area and fill
that margin with parent-identical (upsampled) data, so the run-time blend ring lies on data that equals the
parent. Inside the margin E is already the finer level, so the octaves and crater classes the parent level
leaves to amplification (e.g. 333-666 m craters at the level-7 edge, 10-21 m craters at the level-12 edge)
are switched off there, while the data still has only the parent's detail. Result on the real Moon: no line
and no wall at any coverage edge, but a visible change of texture across the quarter-tile ring - the margin
looks smoother than the terrain outside it until the real regional data begins.

## Evidence
- `npx tsx tools/terrain-core/render-hillshade.ts`, then `out/terrain-core/moon-edge-L7.png`,
  `moon-edge-L10.png`, `moon-edge-L12.png` (boundary = vertical centre line, red ticks): procedural craters
  left of the line, smoother terrain right of it (renders of the reviewed version).
- The synthetic sparse set, whose regional tiles carry real detail up to the coverage edge, shows no texture
  change (`out/terrain-core/fixture-edge-L5-close.png`): the mechanism is right, the input is not describing
  where detail really exists.
- Measured with E keyed on `coverage` (texture of H divided by that of the parent-level surface at the same
  points, band-pass RMS slope at one posting, 0.4-0.8 tile inside the coverage boundary): Moon 0.44-0.77,
  Earth 0.35-0.61 at every regional level.

## Requested change
Add an optional per-layer field to `TileLayerManifest`:

    /** Where each sparse level holds data genuinely finer than its parent (subset of `coverage`); absent =
     *  the whole coverage. The height authority keys the effective level E on these rectangles (w computed
     *  exactly like the coverage weight), while the data blend D keeps using `coverage`. */
    sourceCoverage?: Record<string, TileRect[]>;

and have the bakes write the data-area rectangles (the 20 km SLDEM disc, the NAC footprint) there. Then E rises
where real detail starts and the amplification it replaces fades exactly as the real detail fades in (the bake
feathers the source over 300 m - 2 km, comparable to the quarter-tile ring). Nothing else changes: `coverage`,
`layerHasTile`, the D recursion and the parent identity on coverage boundaries stay as they are. terrain-core
(or core-support in wave 2) then switches E in `src/terrain/evaluator.ts` (`ensureCoverage` / `effectiveLevel`)
to a second LayerCoverage built from `sourceCoverage` when present - about 20 lines.

## Update (terrain-core, 2026-11-10, after the crash recovery)
- Both bakes now write `layers.height.sourceCoverage` (bake-moon-sky `tools/bake/moon/region.py`: tiles touching
  the area where a band's source data lies; bake-earth `tools/bake/earth/heights.py`: tiles touching the 100 km
  area where the regional source has full weight). Every source tile lies inside the coverage.
- terrain-core reads it as an additive manifest field (`TileLayerManifest & { sourceCoverage? }` in
  `src/terrain/body.ts`, validated: a source tile outside the coverage or at a global level rejects the
  manifest) and keys E on it: `E_L = E_(L-1) + s_L (L - E_(L-1))`, s_L computed like w_L on the source
  rectangles **but rising over `SOURCE_BLEND_TILES` = 1 tile instead of a quarter tile** (`src/terrain/coverage.ts`).
  Reason, measured on the real Moon: the rectangles are tile-granular, so the real detail begins anywhere in the
  outermost source tile; level-L data detail is ~0.1-0.3 of its full value 0.2-0.3 tile inside the source
  boundary, ~0.5 at 0.5 tile and ~0.8-1 at 1 tile. With a quarter-tile ring E switched the procedural detail off
  half a tile before the real detail arrived (texture down to 0.4-0.6 there); with one tile the ring starts at
  0.83-1.03 of the parent's texture. Without the field E is the contract's recursion, unchanged.
- Result (`realData.test.ts`, "texture of every coverage margin equals the parent level's"): texture of H over
  the parent-level surface at the same points, 0.12 / 0.4 / 0.8 tile inside every coverage boundary, at 1 and 4
  postings: Moon 0.99-1.02, Earth 0.99-1.05 at every regional level (was 0.35-0.77). Hillshades
  `out/terrain-core/{moon,earth}-edge-L*.png` show no texture change at any coverage edge.
- Remaining for the lead (contract text only, no code change needed): add the field to `TileLayerManifest`,
  state the E recursion on `sourceCoverage` with SOURCE_BLEND_TILES = 1 at COVERAGE_BLEND_TILES, add "regions of
  interest lie at least SOURCE_BLEND_TILES inside their source rectangles", and relax the
  `TerrainResidency.effectiveLevel` comment ("equals availableLevel away from coverage edges" does not hold in a
  margin, where E stays at the parent level by design).
- What `sourceCoverage` still cannot describe (a level whose source is coarser than its posting) is in
  `docs/requests/terrain-core-4.md`.

## Moon bake (bake-moon-sky, commits 2d0d820, 4f89577)
`tools/bake/moon/region.py` writes `layers.height.sourceCoverage` for every regional level: the tiles touching
the area where the level's source has non-zero weight (levels 7-8: the 20 km SLDEM disc with its 2 km feather;
levels 10-12: the NAC DTM's valid footprint), without the one-tile margin, and `[]` for a level whose source is
coarser than the parent level's posting (level 9, terrain-core-4). Tiles per level: 7: 6, 8: 20, 9: 0, 10: 20,
11: 76, 12: 222. `verify.py` checks that every source rectangle lies inside `coverage` and that every source
pixel with weight > 0 lies in a listed tile. Nothing else is needed from the Moon bake; the contract text stays
with the lead.

## Resolution (lead, contract text)
Lead: the contract text (the data side and the implementation were already in).

`src/core/contracts/terrain.ts`:
- `TileLayerManifest.sourceCoverage?: Record<string, TileRect[]>` (height layer): tiles of each sparse level
  whose data is genuinely finer than the parent level - touching the area where the level's source has
  non-zero weight and resolving wavelengths below the parent's; every tile inside `coverage`; `[]` or no key
  for a level without finer data; absent field = the whole coverage (E keys on `coverage`).
- `export const SOURCE_BLEND_TILES = 1` with the source weight s_L (computed like w_L on the source
  rectangles, rising over one tile) and the reason for one tile; the E recursion at `COVERAGE_BLEND_TILES`
  reads `E_L = E_(L-1) + s_L (L - E_(L-1))`, s_L = w_L without `sourceCoverage`. "Regions of interest lie at
  least SOURCE_BLEND_TILES inside the source rectangles of every level they rely on."
- `TerrainResidency.effectiveLevel`: equals `availableLevel` only well inside the source rectangles; lower
  by design in a coverage margin and at a level whose source is no finer than its parent.
Code: `src/terrain/coverage.ts` re-exports the contract's constant (was its own), `src/terrain/body.ts`
reads `layer.sourceCoverage` from the contract type. ARCHITECTURE 7.2 states the rule. Migration: import
`SOURCE_BLEND_TILES` from either place; nothing else changes. D, `coverage`, `layerHasTile` are untouched.
