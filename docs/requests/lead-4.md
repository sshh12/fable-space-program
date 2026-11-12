Status: open
From: the lead (on site-bake's report: docs/handoff/site-bake.md section 10, "Deviations, known limits")
Owner path: tools/bake/earth and its state in data/cache/earth/state (site-bake has finished; no later package of WORK_PACKAGES_V2 owns the Earth bake: whoever the lead gives the next regional bake to)
Blocking: no (nothing runs the Earth bake at present); it becomes a trap the moment someone does

## Problem
The unit records of the Ka Lae region no longer match the region's configuration, although no tile of it
changed. A regional step that is run without `--region` would therefore treat every Ka Lae unit as not
done and re-bake the region from re-downloaded sources: hours of work, and tiles that need not come out
byte-identical (the sources are downloaded again), in the live tile set that the terrain guard, the mission
golden and the pad resolution of both sites stand on.

## Evidence
- `tools/bake/earth/util.py`: a unit is done when `data/cache/earth/state/<name>/<key>.done` holds
  `config_hash(config)`, the hash of the unit's whole configuration dictionary.
- The regional steps put the region's dictionary into that configuration (`heights.py`
  `{"v": 5, "region": reg, ...}`, `regalbedo.py`, `regmask.py`, `landcover.py` likewise), so every field of
  `data/defs/regions/earth-ka-lae.json` is hashed, including the ones that do not affect a tile.
- Commit a2c6318 (sim-core-v2, the site rename) changed one line of that file: `"site": "ka-lae-lc1"` ->
  `"site": "ka-lae"`. The records in `data/cache/earth/state` (111 directories on this machine) hold the
  hash of the configuration before it. Checked with the tools' own read-only question on 2026-11-12:
  `heights.region_is_baked('earth-ka-lae')` is False, `region_is_baked('earth-madrakah')` is True.
- site-bake worked around it by running every regional step with `--region earth-madrakah` and says so in
  its hand-off: "Run regional steps with `--region` until the records are re-stamped (as `bake.py despike`
  does after a repair)".
- The Ka Lae tiles themselves are as they were: the terrain guard's full form found all 8,379 Earth
  directories recorded before the Madrakah swap byte-identical (request site-bake-1).

## Requested change
1. Re-stamp the Ka Lae unit records to the present configuration WITHOUT baking: the way the end of the
   height repair does it (`heights.py`: "the stored levels now match the present configuration: adopt it
   in the unit records"), for every layer of the region, as a command of its own (`bake.py restamp --region
   earth-ka-lae` or the name you prefer) that refuses unless the live tiles of the region are present.
   Proof that nothing was baked: the terrain guard in its full form passes unchanged
   (`TERRAIN_GUARD_FULL=1 node tools/dev/heavy.mjs --class=bake -- npx vitest run tests/unit/terrain-core/terrain-guard.test.ts`),
   and `bake.py region` without `--region` then reports every Ka Lae unit as already done.
2. Keep fields that cannot change a tile out of the configuration hash (the region's `site` label and
   whatever else is a name), so that a rename is not a re-bake. Say in the hand-off which fields are hashed.
3. Until then the rule stands for everyone: a regional step of the Earth bake is run with `--region <id>`.
   A run without it is a re-bake of Ka Lae.
