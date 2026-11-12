Status: open
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
