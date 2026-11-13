Status: resolved (the coverage-edge suite checks the regions one at a time and reuses its slots per level; 11 of 11 pass; both regions' edges at levels 8 to 12 within every bound, largest step beyond the local change 1.0e-9 m)
From: site-bake
Owner path: tests/unit/terrain-core/realData.test.ts (and tests/unit/terrain-core/edgeChecks.ts)
Blocking: no

## Problem
Since the Madrakah region was swapped into the live `earth` tile set (2026-11-12 05:00 Pacific; a second regional
pyramid, face 2, levels 8-12), the real-data provider test fails at the regional coverage-edge check: it pins
tiles per level in one provider whose cache budget is 384 MiB and never releases them, and with the boundary tiles
of two regions they no longer fit. The tile set is valid (`verify.py --region earth-madrakah` checks the coverage
edges of every level with the bake's own reader); the test's pinning is what overflows. As a result the level-12
edge continuity of the height authority at Madrakah is not yet checked by the provider test.

## Evidence
```
node tools/dev/heavy.mjs --class=cpu -- npx vitest run tests/unit/terrain-core/realData.test.ts
  x earth: every regional level - continuous across the coverage edge, parent surface on the boundary 16099ms
  Error: terrain tile cache: 200210 bytes of new tiles do not fit the budget of 402653184 bytes
         (402582024 in use, 0 evictable); raise opts.cacheBytes or request a smaller radius
  Tests  1 failed | 10 passed (11)
```
(2026-11-12 05:55, the tree at commit 8c97640; log `out/bake/earth/site-bake/realdata.log`.)

## Requested change
Make the coverage-edge suite release what it pinned between levels (or between regions), or pin per region with a
slot name it reuses, or give that provider a larger `cacheBytes`, so that the check runs over every regional
level of both regions. What must not change: the checks themselves (jump bounds, parent surface on the boundary)
and the tiles.

## Resolution (shared-code maintainer, 2026-11-12)

Fixed in the test's own handling (`tests/unit/terrain-core/realData.test.ts`, `coverageSuite`); the cache
budget, the bounds and the tiles are untouched. The suite now takes the regions one at a time (the coverage
rectangles of one cube face: Ka Lae is face 1, Madrakah face 2), with a pair of providers per region that is
dropped when the region's levels are done, and within a region the points of a level take the slots of the
level before. What is pinned at any time is one level of one region, where one provider used to keep the
boundary tiles of every level of both. Nothing is weaker: 1,000 points on the coverage edge per level AND
region (it was 1,000 per level over both regions together; the first region's points are the ones drawn
before), the same seven bounds, and a count at the end that every regional level of every region was
checked.

Run through the gate (`node tools/dev/heavy.mjs --class=cpu -- npx vitest run
tests/unit/terrain-core/realData.test.ts`): 11 of 11 pass, 66.7 s (out/core-support/realdata.log; the
numbers below from a second run of the two coverage tests with their output,
out/core-support/realdata-coverage.log). Earth, the height authority against the parent surface (the same
provider on a source cut off below the level), 1,000 points per row:

| region | level | largest raw step over 2 mm across the edge | step beyond the local change (bound 1 mm) | parent surface on the boundary (bound 1e-6 m) | slope change of the amplification (bound 0.005) | E jump (bound 1e-6) |
|---|---|---|---|---|---|---|
| Ka Lae (face 1) | 8 | 0.99 mm | 9.4e-10 m | 0 | 0.0000 | 0 |
| | 9 | 1.06 mm | 1.0e-9 m | 0 | 0.0000 | 0 |
| | 10 | 1.01 mm | 4.2e-10 m | 0 | 0.0000 | 0 |
| | 11 | 1.06 mm | 2.8e-10 m | 0 | 0.0000 | 0 |
| | 12 | 0.84 mm | 5.1e-10 m | 0 | 0.0000 | 8.0e-15 |
| Madrakah (face 2) | 8 | 1.16 mm | 2.6e-10 m | 0 | 0.0000 | 0 |
| | 9 | 1.17 mm | 3.3e-10 m | 0 | 0.0000 | 0 |
| | 10 | 0.78 mm | 1.3e-10 m | 0 | 0.0000 | 0 |
| | 11 | 1.15 mm | 3.4e-10 m | 0 | 0.0000 | 0 |
| | 12 | 0.43 mm | 6.5e-10 m | 0 | 0.0000 | 1.8e-13 |

(The raw step is the ground's own slope over the 2 mm between the two sample points; what the bound holds
is what is left after the local change is taken off.) The amplified surface's own jump is 0 in every row.
Every edge at Madrakah holds every bound, level 12 included; there is no finding for the lead. The Moon's
six levels pass as before (largest step beyond the local change 4.3e-9 m).
