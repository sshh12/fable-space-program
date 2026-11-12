# Hand-off: site-bake (wave 3.1)

Status: IN PROGRESS. This file is the running log of the package; the final sections are filled in at the end.

## Running log

- 2026-11-12 00:45 Pacific. Start. Read the brief, ARCHITECTURE 9.3/9.4/10.1/10.2/31.3, MIGRATION_V2, PACKAGE_RULES,
  user decisions, OPEN_QUESTIONS Q8/Q14, the bake-earth and lead-baseline-v2 hand-offs, the earth bake code.
  Disk 61 GB free; `data/` 17 GB (tiles 15 GB, cache 1.8 GB). Terrain guard (quick form) passes on the tree as
  found (4 of 4). The live earth manifest contentHash is `ab20fdfc579d4015`.
- Plan: (1) staging in the bake code: a region marked as staged has all its tile I/O routed to
  `data/cache/earth/stage/<region>/tiles/` and is invisible to every default region loop (`bake.py` without
  `--region`, `manifest`, `contact`, `verify`) until it is swapped in; (2) the Madrakah region file and its
  regional bake into the stage; (3) the pad-resolve tool (`bake.py pads`) evaluated on the baked tiles (level-12
  bilinear heights = the collision surface, level-12 water mask and land cover), for both sites; (4) region checks
  (`verify.py --region`), hillshades, contact sheets and the Q8 ground-quality note; (5) the swap: tiles moved into
  `data/tiles/earth` (new directories only, by rename), then the manifest written once, atomically.
