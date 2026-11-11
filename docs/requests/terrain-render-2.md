Status: resolved (commit b8ea6a7)
From: terrain-render
Owner path: tools/bake/earth (regional height source), data/tiles/earth/height levels 8-12
Blocking: yes        (the reviewed pad views "looking inland" / "along the coast" and the shoreline view show a 1.1 km tall needle 2 km from the pad; nothing in src/render/terrain can remove it)

## Problem
The regional Earth height tiles contain isolated spikes on the shore near the launch pad: single samples up to
1,135 m above ground that is 0-7 m high. They render as dark needles that cast kilometre-long shadows, and the
collision surface has them too. They look like the corrupt Terrarium / 3DEP near-shore values the Earth hand-off
describes (section 4, "sea values are garbage near this coast"), on samples that the land / ocean classification
kept as land.

## Evidence
`npx tsx tools/terrain/scan-spikes.ts earth 18.987556 -155.603239 4000 12 30` (terrain-render's scanner: stored
samples more than 30 m from the median of their 5 x 5 neighbourhood, within 4 km of the pad, level 12):

```
1/12/2973/2819 sample (72, 25):    77.6 m, neighbourhood median 22.3 m, at 18.93798,-155.68676
1/12/2977/2820 sample (11, 249):  225.8 m, neighbourhood median  0.4 m, at 18.96858,-155.59942
1/12/2977/2820 sample (13, 250):  216.3 m, neighbourhood median -0.6 m, at 18.96864,-155.59924
1/12/2977/2822 sample (133, 111): 656.1 m, neighbourhood median  0.2 m, at 19.00031,-155.58836
1/12/2977/2822 sample (133, 112): 1135.4 m, neighbourhood median 6.3 m, at 19.00040,-155.58836
1/12/2977/2822 sample (133, 113): 558.9 m, neighbourhood median  6.3 m, at 19.00049,-155.58836
... 18 samples in three clusters; level 11 carries the same needles (340-397 m at 19.0003-19.0005 N, 155.58836 W)
```

Screenshots: `out/screens/terrain/pad-inland.png`, `pad-coast.png`, `shoreline-200m.png` (the needle and its shadow).
The scanner takes any centre, radius, level and threshold, so the whole 100 km region can be checked after a fix
(`... earth 18.987556 -155.603239 100000 12 60` reads every level-12 tile of the disc).

## Requested change
Regional height tiles (levels 8-12) without these outliers: e.g. a despike of the Terrarium source before the
pyramid is built (a sample that stands more than a few tens of metres above the median of its neighbourhood while
its neighbours are near sea level is replaced by that median), then the usual re-bake of the affected levels and of
the layers that record the height build hash. The pad location and everything away from the spikes must not change.

## Resolution
Fixed in the data and in the bake (core-support, commit b8ea6a7). The tiles under `data/tiles/earth/height`
are already repaired in the working tree: nothing to re-bake on your side.

**What was wrong.** As you suspected: single corrupt survey samples (Terrarium z15 / 3DEP) on ground that
WorldCover classes as land, so the regional source kept them. The tent average of level 12 spreads each
over a few vertices; levels 11-8 are averages of level 12 and carried them at decreasing height.

**What changed in the tiles.** 127 vertices in 14 clusters at level 12 (14 tiles), and the 13 / 11 / 9 / 9
tiles of levels 11 / 10 / 9 / 8 that average them. The ones near the pad:

| Where | Was | Now |
|---|---|---|
| 19.0004 N 155.5884 W (2 km NE of the pad; your 1/12/2977/2822 cluster, 10 vertices) | up to 1,135.4 m | 5.5 - 6.9 m |
| 18.9686 N 155.5994 W (your 1/12/2977/2820 cluster, 7 vertices) | up to 225.8 m | 0.4 m |
| 18.9380 N 155.6868 W (1/12/2973/2819, 4 vertices) | up to 77.6 m | about 22 m |
| 19.0102 N 155.8015 W (9 vertices) | up to 469.6 m | 6.3 m |
| 19.1848 N 155.9070 W (10 vertices) | up to 578.6 m | 2.0 m |

plus nine smaller clusters 30-90 km from the pad (26 - 132 m needles on the Kona, Ka'u and Puna shores).
Every other regional height file is bit-identical to before (56 of 10,499 differ), so the pad (21.64 m),
its flattening and everything away from the needles are unchanged. A despiked vertex stays land (it takes
the median of the land vertices around it), so the stored sign, the coastline and the water mask did not move.

**Manifest.** `contentHash` is now `ab20fdfc579d4015` (was `5a9f0db7c755fdf8`) and `layers.height.build`
changed, so caches keyed on the hash refresh by themselves; coverage and sourceCoverage are unchanged. A
dev server that was already running serves the new files at once; a browser tab opened before 18:45 local
may hold old tiles under the old `?v=` and only needs a reload.

**How it is detected** (so you can judge what else it could touch): a land vertex is a needle when it
stands more than 30 m above the 75th percentile of its 9 x 9 vertex neighbourhood (86 m across at level
12). A slope, a cliff edge or a ridge crest has at least a quarter of the window as high as the sample; a
cone would need flanks steeper than 45 degrees on every side. A tighter second pass (5 m) takes the skirt
on the vertices within 2 of a removed needle; both repeat until nothing is flagged. The pass is part of the
regional height bake now (`tools/bake/earth/heights.py`, finest level, before the coarser levels are
averaged), and `python -I tools/bake/earth/bake.py despike --region <id>` repairs an existing bake without
the deleted sources.

**Checked.** Your scanner: `npx tsx tools/terrain/scan-spikes.ts earth 18.987556 -155.603239 100000 12 60`
reports 0 samples in the whole region; at 4 km / 30 m it still lists two samples at 18.934 N 155.684 W that
are 30 m BELOW their neighbourhood median: the foot of the sea cliff there, real terrain, not needles.
`tools/bake/earth/verify.py`: 42 of 42, including the new check "height needles earth-ka-lae" (largest
remaining excess 29.0 m). `tests/unit/terrain-core/realData.test.ts` (continuity across tile borders and
coverage edges, pad flatness, benchmarks): 10 of 10.

**What to re-run.** Your pad views (`pad-inland`, `pad-coast`, `shoreline-200m`) and anything whose
reference numbers include terrain within about 100 m of the points above. The collision surface changed at
the same vertices, which matters to nobody on the pad.

**Not re-baked** (recorded in `docs/handoff/bake-earth.md`, "Changes in wave 2"): the regional albedo was
de-shaded with the old normals, so about twenty 9.5 m texels around each former needle carry a de-shading
factor computed from its slope (bounded by the correction's clamp, 0.6 .. 1.6). If one of them shows as a
blotch in a reviewed view, file it with the screenshot: the re-bake of the regional albedo needs the
Sentinel-2 download again.
