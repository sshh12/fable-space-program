Status: resolved (lead, 2026-11-12: golden.json tiles.earth updated; the guard's tile summary re-recorded after a full-form audit; the Madrakah place group appended; baseline-v1.json left as recorded)
From: site-bake
Owner path: tests/mission/golden.json, tests/mission/baseline-v1.json, tests/unit/terrain-core/terrain-guard.*
Blocking: no

## Problem
The Madrakah region (`earth-madrakah`) was swapped into the live `earth` tile set on 2026-11-12 05:00 Pacific. The
swap is purely additive (840 new tile directories on face 2, levels 8-12; no existing tile changed), but the
manifest changed, so its `contentHash` went from `ab20fdfc579d4015` to `f70a61d55dca902f`. Three lead-owned
records hold the old value or the old directory summary.

## Evidence
- `tests/mission/golden.json` `tiles.earth` = `ab20fdfc579d4015`: `npm run test:mission` stops at "the tile sets
  were re-baked since the golden hash was recorded" before it compares the state hash.
- `tests/mission/baseline-v1.json` line 22 `"earth": "ab20fdfc579d4015"`.
- `node tools/dev/heavy.mjs --class=cpu -- npx vitest run tests/unit/terrain-core/terrain-guard.test.ts`: the
  heights pass bit for bit; the directory summary fails with `earth/.: 15109 bytes recorded, 21925 now` (the
  manifest) and 840 new directories `earth/{height,albedo,watermask,landcover}/2/{8..12}/{x}`
  (`docs/handoff/site-bake.md` section 6 lists them and the full-form check of every existing directory).

## Requested change
- Update `golden.json` `tiles.earth` and `baseline-v1.json` to `f70a61d55dca902f` (re-fly with
  `MISSION_UPDATE_GOLDEN=1` if the state hash must be re-confirmed: no tile the mission reads changed, so the state
  hash `b8221b0fd316207e` should come out identical).
- Re-record the guard's tile summary after checking that only the listed directories and `manifest.json` changed,
  and append the two new places (`--add-place`): site `ka-lae` gains 15 pads, site `madrakah` 16
  (`data/staged/sites/*.pads.json`; flatten discs in section 6 of the hand-off).
- Nothing else changes: the Moon set, the global levels, `globals/` and every Ka Lae tile are byte-identical.

## Resolution (2026-11-12, lead)

**The claim was checked independently before anything was re-recorded**, with the guard's own summary code
in the full form (every file read: names, bytes and a content hash per directory) against the recording
made before the swap (`terrain-guard.record.ts --tiles-additions --changed earth/.`, through the bake slot;
the audit is in `out/terrain-guard/additions.json`):

| | Recorded | Byte-identical | Changed | Added |
|---|---|---|---|---|
| `earth` | 8,380 directories | 8,379 | 1, as named: `.` (`manifest.json`, 15,109 -> 21,925 bytes) | 840 directories, 53,140 files, 0.461 GB |
| `moon` | 2,344 directories | 2,344 | 0 | 0 |

The 840 added directories are exactly `{height,albedo,watermask,landcover}/2/{8..12}/{x}` with x 43..51 (9),
87..102 (16), 175..203 (29), 352..404 (53), 706..808 (103) per layer, and 81, 224, 754, 2,544 and 9,682
files per layer: the table of the hand-off's section 6. No recorded directory is gone or differs in files,
names, bytes or content. The manifest's `contentHash` is `f70a61d55dca902f`.

1. `tests/mission/golden.json`: `tiles.earth` = `f70a61d55dca902f`. Not re-flown for it: the flight on the
   new tiles had been flown before (state hash `b8221b0fd316207e`, 596,933 steps, equal to the golden), and
   the mission suite passes 36 of 36 with the new value.
2. `tests/mission/baseline-v1.json`: NOT changed. It is the record of the v1 flight on the tiles of its day
   (`ab20fdfc579d4015`), nothing compares that field, and the file is pinned
   (`tools/dev/guard-pins.test.ts`).
3. `tests/unit/terrain-core/terrain-guard.tiles.json`: re-recorded by the same run that made the audit
   (it writes only when the audit has no violation): Earth 9,220 directories, 750,489 files, 10.76 GB.
4. `tests/unit/terrain-core/terrain-guard.heights.json`: the place group `site:madrakah` appended (800
   points in discs of 200 km, 20 km, 2 km and 200 m about the reference pad, 18.996043 N 57.793818 E,
   sampled on `f70a61d55dca902f`). Earth has 2,800 points. Every one of the 2,000 earlier Earth points and
   of the 2,000 Moon points keeps its index, its direction and its three recorded heights (the committed
   strings are prefixes of the new ones), and the guard passes on all of them, in the every-commit form and
   in the full form.
5. **Ka Lae gets no group of its own**: its fifteen new pads lie inside the 20 km and 200 km discs of the
   existing group `site:ka-lae-lc1`. **The flatten discs of the 31 new pads do not exist yet**: they appear
   when fleet-data writes the site files. The lead then re-records the heights (`--resample`) under the
   rule "only points inside new flatten discs may change" (MIGRATION_V2, lead steps, "with fleet-data").
