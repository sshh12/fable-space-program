Status: open
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
