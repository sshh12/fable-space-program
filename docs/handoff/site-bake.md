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
- 00:49. Full terrain guard (`TERRAIN_GUARD_FULL=1`, bytes of every file) passes on the tree as found.
- 00:55. Reconnaissance (Terrarium z12 over the coverage box, 1,496 tiles): the nominal point 19.0 N 57.8 E is 4 km
  inside Ras Madrakah; the coast runs north-south from the headland to Duqm, the south coast turns west; inland a
  very flat gravel plain (12-60 m) with hills of 50-110 m on the headland. Region centred on the nominal point.
- 00:59. Commit 6fcc425 (staging code, region file). Stage bake started (`bake.py stage --region earth-madrakah`,
  gate class bake, 6 workers). WorldCover grid 43,200 x 30,700 px (3x Ka Lae's): the ocean-connectivity step was
  rewritten to give identical output in about 4 GB instead of about 13 GB (uint16 labels, row-chunked sampling).
  572 water components, 1 of them the ocean; 24 km2 inland water; 2,204 Terrarium z14 tiles.
- 01:10. Pad rule question found on Ka Lae's own tiles (60 m gridded exploration within 45 km of LC-1): with every
  test of LC-1's rule gated (incl. bare land cover and the open-ocean sector 60-130 deg), NO second pad fits; LC-1
  itself reaches the bare-ground share exactly (0.80). Flat + dry + clear of the shore: 16 pads within 4.8 km of
  LC-1; + bare land cover: 16 pads 7-13 km west on the Kahuku lava flows (sector to the east blocked by the
  island); + ocean sector without land cover: 5 pads. First decision: gates flat, dry (= not water or wetland),
  clear of the shore; bare ground and the ocean sector reported.
- 01:22. Revised after LOOKING at the Ka Lae overview of that run: those 16 pads sit on pasture and tree cover on
  slopes of up to 4 deg at 60-260 m (LC-1 is the only one on bare lava). "Dry" in the brief is LC-1's land-cover test
  (bare, dry ground: WorldCover bare / sparse vegetation, the reason LC-1 is on lava), and the brief's own clause
  "if no acceptable ground exists near the nominal point, move along the coast and say so" covers exactly this.
  Final rule: flat + dry (bare ground) + clear of the shore + height + latitude, i.e. every test of LC-1's rule except
  the open-ocean sector, which is reported per pad (`--strict` gates it as a measurement).
- 01:14. Commit 08b23d2 (pad resolver, ground-quality tool, `verify.py --region`, tests). Swap atomicity test
  green (2 of 2).
