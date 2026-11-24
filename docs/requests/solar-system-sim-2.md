Status: open
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
