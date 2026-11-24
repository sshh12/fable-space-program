Status: resolved for the lead's files (2026-11-24); the wire form of the velocity reference is request lead-10 to wire-protocol
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

## Resolution (lead, 2026-11-24)

1. **Rule fields**, each with the value the island's code uses today (nothing reads them yet, so nothing
   moves; durations in seconds, as every rule):

   | Field | Default | The constant it replaces |
   |---|---|---|
   | `claim.armedTestInterval` | 0.1 s (12 ticks, 10 Hz; base 'ticks') | `ARMED_TEST_TICKS` |
   | `claim.reachAcceleration` | 60 m/s^2 | `REACH_ACCELERATION` |
   | `claim.referenceOffsetMax` | 30,000 m | the offset at which a reference orbit is replaced (not built yet) |
   | `time.watchTemperatureFraction` | 0.9 | `WATCH_TEMPERATURE_FRACTION` |
   | `time.watchJointFraction` | 0.8 | `WATCH_JOINT_FRACTION` |
   | `time.watchGroundTime` | 2 s (base 'ticks') | `WATCH_GROUND_TIME` |
   | `time.reducedStep` | 0.5 s (base 'ticks') | `REDUCED_DT` |
   | `time.coastTimeToRails` | 0.5 s (base 'ticks') | `COAST_TIME_TO_RAILS` |

   The three watch fields are flat members of `time`, not an object: every rule path is `group.field`
   (the timers table and its test read them that way). The interval is stated in seconds like every
   duration; convert with `Math.round(seconds * TICKS_PER_SECOND)` (0.1 x 120 is 12.000000000000002 in
   floating point). The wire's rules document carries all eight (`src/net/codec/common.ts`).
2. **The velocity reference on the wire** is not the lead's to add: `WireCommand`, `InputSample` and
   `WireControlState` are the wire section of net.ts, which is wire-protocol's. The session already has the
   command (`PlayerCommands.setNavballMode`); what is missing is its wire form. Request
   `docs/requests/lead-10.md` asks wire-protocol for it, with the exact member.
3. **MIGRATION_V2 principle 5 counts the re-baseline of 91119ab** (`f6efbe54f52a40de`, behind the EXACT
   comparison of the record before and after). The one that formation by the join distance needs is
   counted when island-core's successor reports with its table and the trajectory guard's debris entries
   are re-recorded (request island-core-1, accepted).
