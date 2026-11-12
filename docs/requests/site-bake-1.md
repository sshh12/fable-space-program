Status: resolved twice (lead, 2026-11-12: 05:25 after the additive swap, 10:45 after the GLO-30 re-bake replaced the region in place; each time after a full-form audit; baseline-v1.json left as recorded)
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

## Second time (2026-11-12, lead): the GLO-30 re-bake, replaced in place

site-bake re-baked the Madrakah region on Copernicus GLO-30 and replaced its tiles in the live `earth` set
at 09:44 (manifest content hash `f70a61d55dca902f` -> `f5e6ef420bda7cea`; hand-off section 0.7). A bake that
REPLACES is not one that adds, so the audit asked a different question, and asked it of the guard's own
records, not of the builder's snapshot:

- **The footprint** is what the guard recorded as the region when it first appeared: the 840 directories
  that the recording of f072a36 has and its parent commit does not
  (`{height,albedo,watermask,landcover}/2/{8..12}/{x}`, taken from git).
- **Tiles**, full form through the bake slot (`terrain-guard.record.ts --tiles-replaced --footprint <the 840>
  --changed earth/.`; every file read once; the audit is `out/terrain-guard/replaced.json`): no directory
  added or removed; every recorded directory outside the footprint byte-identical in files, names, bytes
  and content, the root excepted as named; every footprint directory that differs keeps its file names.
- **Heights** (`--resample-group earth site:madrakah --dry-run` first): every stored direction of both
  bodies sampled on the new tiles; nothing may differ from the recording outside the group `site:madrakah`.

| | Recorded | Byte-identical | Changed | Added or removed |
|---|---|---|---|---|
| `earth` | 9,220 directories | 8,713 | 507: the root as named (`manifest.json`, 21,925 -> 22,126 bytes) and 506 of the footprint's 840 directories (30,989 files, 0.349 GB) | 0 |
| `moon` | 2,344 directories | 2,344 | 0 | 0 |

Replaced directories `{layer}/2/{level}/{x}`, as the audit printed them (they are site-bake's table, row for row):

| Layer | Level 8 | Level 9 | Level 10 | Level 11 | Level 12 |
|---|---|---|---|---|---|
| height | 4 (44-47) | 8 (88-95) | 15 (176-190) | 29 (353-381) | 56 (707-762) |
| albedo | 9 (43-51) | 13 (87-95, 99-102) | 20 (175-190, 199-202) | 36 (352-381, 398-403) | 67 (706-763, 797-805) |
| watermask | 8 (43-50) | 9 (88-95, 100) | 18 (176-190, 199-201) | 32 (352-380, 399-401) | 55 (706, 709-760, 799-800) |
| landcover | 8 (43-50) | 11 (87-95, 99-100) | 19 (175-190, 199-201) | 32 (352-380, 399-401) | 57 (706-760, 799-800) |

Heights: Earth 2,800 points: 497 of the 800 of `site:madrakah` changed on the collision query, 525 on the
25 m band-limited query, 0 on the 1,000 m one; **0 of the 2,000 points outside the group changed** (the
1,200 uniform ones and all 800 of `site:ka-lae-lc1`). Moon: all 2,000 as recorded. No finding: the claim
holds in every number.

Re-recorded, and only this:

1. `tests/unit/terrain-core/terrain-guard.tiles.json`: by the audit's own run (507 Earth entries differ from
   the committed file, the key set is the same; the Moon's entries are untouched).
2. `tests/unit/terrain-core/terrain-guard.heights.json`: the heights of `site:madrakah` alone
   (`--resample-group`), its `recordedOn` now `f5e6ef420bda7cea`. Checked against the committed file: every
   direction and every height outside the group is the same string.
3. `tests/mission/golden.json`: `tiles.earth` = `f5e6ef420bda7cea`. Mission through the gate: 35 of 36. The one failure is not of this step: the determinism test gets the state hash e7cdbc4b452f686d where the golden has b8221b0fd316207e (596,933 steps both), because commit 01c4d2f (10:16, cockpit round 6) changed a field of the vehicle file that is in the hashed state; with that field put back in memory the flight on the new tiles ends at the golden exactly, and it asks for no tile of the Madrakah footprint (hand-off of lead-baseline-v2, section 16). The golden hash was not touched.
4. `tools/dev/guard-pins.test.ts`: no pin changed, because none of the three files above is pinned (the
   golden and the terrain guard's two files are left out of the pins on purpose, the file's header says
   why); the pin test passes. `tests/mission/baseline-v1.json` is not touched.

**For the lead to decide.** The place group `site:madrakah` is centred on the reference point of the FIRST
pad layout (18.996043 N 57.793818 E). The pads have moved 9-41 km north along the coast (reference pad lc-1
now at 19.078241 N 57.786868 E): the group's 200 m and 2 km discs hold no pad any more, its 20 km disc
reaches the three southern heavy pads thinly, the rest lie in the 200 km disc only. When fleet-data writes
the site file, the rule "only points inside new flatten discs may change" will find almost no point to
change at Madrakah. A group about the new reference pad (and one further north in the medium and light
field) can be appended with `--add-place` at any time before that; it was not done here, where the order
was to re-record this group only.
