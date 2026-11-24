Status: open
From: island-core
Owner path: src/core/contracts/net.ts (`UniverseRules`, `WireCommand` / `InputSample`), docs/MIGRATION_V2.md (principle 5)
Blocking: no

## Problem
Three things the island needs from the lead's files; each has a workaround inside island-core's paths.
1. Numbers of ARCHITECTURE 6.2 and 7.3 that have no `UniverseRules` field are named constants in
   `src/sim/island/api.ts` and `island.ts`: the Armed tier's test interval (`ARMED_TEST_TICKS` = 12 ticks,
   10 Hz), the worst-case mutual acceleration of the reach time (`REACH_ACCELERATION` = 60 m/s^2), the
   threshold-watch fractions (`WATCH_TEMPERATURE_FRACTION` 0.9, `WATCH_JOINT_FRACTION` 0.8,
   `WATCH_GROUND_TIME` 2 s), the Reduced tier's step (`REDUCED_DT` 0.5 s), `COAST_TIME_TO_RAILS` (0.5 s) and
   the offset at which a reference orbit is replaced (30 km; not built yet).
2. The velocity that a pilot's prograde / normal / radial SAS hold refers to (surface or orbit: v1 took it
   from the navball mode, which switches by altitude and which the pilot sets) changes the held direction
   and so the flight. It is the seat's state in the island and reaches it as an input
   (`IslandInput` `kind: 'reference'`). The wire has no message for it: `WireControlState` and `InputSample`
   carry `sasHold` only for the maneuver and target modes.
3. The golden mission hash was re-baselined by island-core on 2026-11-24: `f6efbe54f52a40de`, it was
   `72c0893583aa427d` (commit 91119ab). Cause: the Armed tier (a coasting piece of debris that nobody
   attends is no longer stepped, so its attitude, temperatures and step count differ). Proof: the EXACT
   comparison of the mission record before and after, 17 of 17 milestones equal, 596,933 steps both
   (`npx tsx tools/dev/record-mission-baseline.ts --exact tests/mission/rebaseline/2026-11-24-armed-after.json
   --reference tests/mission/rebaseline/2026-11-24-armed-before.json`); the trajectory guard passes in full.

## Evidence
`grep -n "ARMED_TEST_TICKS\|REACH_ACCELERATION\|WATCH_\|REDUCED_DT\|COAST_TIME_TO_RAILS" src/sim/island/*.ts`;
`src/sim/island/api.ts`, `IslandInput`; `tests/mission/golden.json`.

## Requested change
1. Fields in `UniverseRules` (suggested: `claim.armedTestInterval`, `claim.reachAcceleration`,
   `time.thresholdWatch { temperatureFraction, jointFraction, groundTime }`, `time.reducedStep`,
   `time.coastTimeToRails`, `claim.referenceOffsetMax`) with today's values as defaults; island-core's
   successor then reads them.
2. A wire form for the velocity reference: a `WireCommand` `{ kind: 'velocityReference'; reference:
   'surface' | 'orbit' }`, or a bit of `InputSample`.
3. MIGRATION_V2 principle 5 counts the re-baseline of 91119ab (and the one that formation by the join
   distance will need, request island-core-1).
