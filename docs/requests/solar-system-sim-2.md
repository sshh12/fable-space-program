Status: resolved (lead, 2026-11-24: MIGRATION_V2 step 4.1c is made; the Resolution at the end)
From: solar-system-sim
Owner path: src/core/contracts/defs.ts (WARP_LEVELS, BodyDef.warpAltitudeLimits; the lead)
Blocking: no

## Problem
Decision 40 and MIGRATION_V2's row "with 4.1c": the lead adds 1,000,000x and 10,000,000x to `WARP_LEVELS` (nine
rails levels) and makes `BodyDef.warpAltitudeLimits` optional, in the same commit as the body-system change that
defaults absent limits from the radius. That change is committed (c-ids in docs/handoff/solar-system-sim.md,
section 0): the request the lead note of 2026-11-12 asks for.

## Evidence
- `warpAltitudeLimitsOf(def)` (src/sim/bodies/shape.ts) resolves one limit per rails level for every
  attractor: the stated list, completed by the default (max(atmosphere top, factor x radius), factors
  `DEFAULT_WARP_LIMIT_RADII` = 0, 0.003, 0.006, 0.015, 0.035, 0.3, 1.7, 6, 25 radii from 5x up) for the levels a
  body does not state, never below its own last entry; the default throughout for a body that states none (all
  30 new staged bodies). `maxWarpIndexForAltitude` / `warpAltitudeLimit` (src/sim/orbit/warp.ts) and
  `BodyInfo.warpAltitudeLimits` read it; `createBodySystem` no longer refuses a list shorter than the level count,
  and refuses one longer. Code uses `RAILS_WARP_LEVEL_COUNT` / `WARP_LEVELS.length` only.
- With today's table (seven rails levels) the shipped Earth and Moon resolve to their own seven entries
  unchanged (`tests/unit/solar-system/bodySystem.test.ts`, "rails limits"); the mission flies 36 of 36 at the
  golden 72c0893583aa427d.
- With nine levels the shipped Earth and Moon keep their seven entries and get the default for the two new levels:
  Earth max(140 km, 6 R) = 38,226 km for 1e6x and 25 R = 159,275 km for 1e7x; the Moon 10,424 km and 43,435 km.
  No file under data/defs/bodies needs to change for the library to load.

## Requested change
In one commit (as the migration row says): `WARP_LEVELS = [1, 2, 3, 4, 5, 10, 50, 100, 1000, 10000, 100000, 1e6,
1e7]` and `BodyDef.warpAltitudeLimits?: number[]` (the comment: absent = the default from the radius and the
atmosphere top; a shorter list is completed by it). Then `npm run test:mission` through the gate: the mission
pilot asks for the highest rails level that leaves its margin (`PilotCore.warpFor`), so the two levels may change
how often the pilot is asked during the long coasts; if the golden moves, that is a behaviour change of the lead's
own step (principle 5), not something this package can show in advance. `src/core/contracts/net.test.ts` asserts
the count formula only. The provider already honours `BodyTerrainDef.residentLevel` (src/terrain/body.ts:
min(manifest.residentHeightLevel, residentLevel)); the shipped Earth and Moon state none, so nothing moved.

Must NOT change: the shipped bodies' seven stated limits (they stay as the first seven entries).

## Lead note (2026-11-24): proven, and held for one recording that is not the lead's

Made on a clean worktree of HEAD (06b05ba) exactly as requested (`WARP_LEVELS` with 1e6 and 1e7,
`BodyDef.warpAltitudeLimits?`): `npm run typecheck` clean after two narrowings in tests
(`src/core/defs/loader.test.ts:68`, `tests/unit/solar-system/bodySystem.test.ts:228`: the Earth's stated
list read with `!`), and THE MISSION FLIES 36 OF 36 AT THE GOLDEN f6efbe54f52a40de (the golden of that HEAD): the pilot's margin
never reaches the two new levels, so the flight does not move. NOT COMMITTED, because the headless suites do
not stay green without changing a recording of a package that is in the middle of its work:
- `tests/unit/sim-world/viewReference.test.ts` (island-core's snapshot reference of the wave-3 World, 200
  states): the block "clock" differs from sample 0 on. The clock block states the warp table, so EVERY
  recorded state changes; the reference has to be re-recorded, and island-core holds it as the proof that
  its refactor of World changes no snapshot. That re-record is island-core's, at a moment of its choosing.
- `tests/unit/sim-orbits/warp.test.ts:39` expects the top index of the table above every limit of the Earth
  (12 with nine rails levels; the body system's default limit of the top level, 25 radii, gives 11 at the
  test's altitude), and `tests/unit/sim-world/warp.test.ts:201` counts frames "at the top level" of a
  15-day orbit, which is 100,000x there and no longer the table's top: both are restatements of "the top
  level" as "the highest level the limits allow", not changes of behaviour.
With the table at eleven levels and everything else of this note in place those three files pass. The
patch is two edits in `src/core/contracts/defs.ts` and the two narrowings; it goes in with the reference's
re-record, in one commit, as the migration row says.

**Correction (lead, 2026-11-24, later the same day).** The hash in the lead note above was first written
as `72c0893583aa427d`. That was wrong: the worktree was of HEAD 06b05ba, whose `tests/mission/golden.json`
already held island-core's re-baseline of 91119ab, `f6efbe54f52a40de`, and the mission test compares with
that file. The run flew 36 of 36 to `f6efbe54f52a40de`; the hash had been written from memory and not read
from the run. The conclusion is unchanged (the golden of that HEAD is met with the change in). The messages
of the commits d4d6d61, efc708f and 60c2da1 carry the wrong hash and cannot be changed.

## Resolution (lead, 2026-11-24, evening): step 4.1c is made

`WARP_LEVELS` has the nine rails levels and `BodyDef.warpAltitudeLimits` is optional, in one commit with
what follows from it:
- the two narrowings in tests (`src/core/defs/loader.test.ts`, `tests/unit/solar-system/bodySystem.test.ts`);
- `tests/unit/sim-orbits/warp.test.ts` restated: rails levels follow the limits and physics levels are always
  allowed, and now also 1,000,000x opens at exactly 6 radii and 10,000,000x at 25 radii for the Earth (not
  one metre below), the same for the Moon;
- `tests/unit/sim-world/warp.test.ts` restated: the node three revolutions ahead is reached at 100,000x
  (more than 1,000 frames at that level) and never overrun, and the look-ahead picks the level (the leg's
  highest is 1,000,000x for a few frames, never 10,000,000x although the altitude allows it);
- six entries in the `BY_DESIGN` list of island-core's snapshot reference
  (`tests/unit/sim-world/viewReference.test.ts`; request lead-11, taken by the lead: island-core is closed).

**The lead note above was wrong in one thing**, and it is corrected here: the `clock` block does NOT state
the warp table and does NOT differ in every state. It differs in 6 of the 200 recorded states (the five
prelaunch states of `lunar-direct` and the start of `qa-lunar-surface`: vessels held on a surface with no
node ahead), in two numbers, `warp.maxIndex` (10 -> 12) and `time.maxRate` (100,000 -> 10,000,000); the
other 2,794 block hashes are equal, and the recording itself is not touched. The first run had stopped at
the first failing sample, and "every state" was read into it.

Verified on a clean worktree of HEAD (dbe8e8f) with the whole change: the node configuration typechecks
(the whole project has three errors at that HEAD that are not this step's: a module of another package
that is not committed yet); the unit selection is test for test what it was before the change (972 pass,
22 skipped, 1 timeout in `tests/unit/fleet/reach.test.ts` before and after); `npm run test:mission`: the
determinism test passes at the golden read from that tree's `tests/mission/golden.json`,
`f0c0855ea40d8c59`, and the only failures are the two trajectory-guard tests that island-core's formation
change leaves for the lead's re-record.
