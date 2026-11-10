Status: open
From: terrain-core
Owner path: src/core/contracts/terrain.ts (TileLayerManifest, COVERAGE_BLEND_TILES comment); tools/bake/moon and tools/bake/earth (manifest writers)
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
  left of the line, smoother terrain right of it.
- The synthetic sparse set, whose regional tiles carry real detail up to the coverage edge, shows no texture
  change (`out/terrain-core/fixture-edge-L5-close.png`): the mechanism is right, the input is not describing
  where detail really exists.
- `npx vitest run tests/unit/terrain-core/realData.test.ts`: continuity and parent identity hold exactly on all
  six regional levels (the problem is visual, not geometric).

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
