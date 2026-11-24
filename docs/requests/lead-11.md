Status: resolved (2026-11-24: taken by the lead; the six entries are in, with step 4.1c)
From: the lead (contract owner), for request solar-system-sim-2 (MIGRATION_V2 step 4.1c, the two warp levels)
Owner path: tests/unit/sim-world/viewReference.test.ts (island-core: the list `BY_DESIGN`). NOT the recording tests/unit/sim-world/viewReference.json, which stays as it is
Blocking: yes (step 4.1c is proven on a clean copy and waits for this answer and for nothing else: Evidence 5)

## Problem
The lead's change of step 4.1c (`WARP_LEVELS` with 1,000,000x and 10,000,000x, nine rails levels;
`BodyDef.warpAltitudeLimits` optional) makes the snapshot reference of the wave-3 World fail at "sample 0
(lunar-direct, start, peek): block "clock" differs". The difference is by design of the contract change and
it is small: the `clock` block of SIX of the 200 states, and in them two numbers, `warp.maxIndex` (10 -> 12)
and `time.maxRate` (100,000 -> 10,000,000). The test has the place for exactly that, `BY_DESIGN` (a block of
a single state with its old value, its new value and the reason), but that list is island-core's statement
of what its view may differ by, in island-core's file, and island-core is closed: the lead asks before it
writes in it.

This corrects the lead's note of 2026-11-24 in request solar-system-sim-2 ("The clock block states the warp
table, so EVERY recorded state changes; the reference has to be re-recorded"). That note read the first
difference only. The clock block does not state the table; it states the highest level the pilot may take
now. And nothing is to be re-recorded.

## Evidence
Measured on 2026-11-24 on a clean worktree of HEAD dbe8e8f (`node_modules` and `data/tiles` by junction,
every run through the gate), without and with the change: the two declarations of
`src/core/contracts/defs.ts` and the narrowings `!` of `src/core/defs/loader.test.ts:68` and
`tests/unit/solar-system/bodySystem.test.ts:245`.

1. **The recording is not to be re-made, in the test's own words.** `viewReference.test.ts`: "The recording
   itself is never changed; the comparison is made against the recording with these entries put in, so that
   every other block of every state is still the wave-3 World's to the bit." `viewReference.record.ts`: "It
   ran once, on the World of the tag `post-tighten-2026-11-24`, and REFUSES to overwrite the recording" (it
   returns when the file exists; it has no switch). The note inside `viewReference.json`: "Never
   re-recorded." Decision 21 of docs/handoff/island-core.md (section 2) did the same for the three-period
   search: "the wave-3 recording is not re-recorded, the test states the 12 blocks that differ".
2. **Block by block.** 200 states of 14 blocks are 2,800 hashes. One `driveAll` at HEAD and one with the
   change, each compared with the recording with the twelve `patches` entries of `BY_DESIGN` put in:

   | tree | blocks equal | blocks that differ |
   |---|---|---|
   | HEAD | 2,800 of 2,800 | none |
   | HEAD + the nine rails levels | 2,794 of 2,800 | `clock` in 6 states: samples 0, 1, 2, 3, 4 (`lunar-direct`: start and frame 0 to 3, prelaunch on the pad) and 112 (`qa-lunar-surface`: start, landed on the Moon) |

   `frame`, `session`, `bodies`, `activeVessel`, `otherVessels`, `controls`, `navball`, `readouts`,
   `staging`, `patches`, `nodes`, `events`, `milestones`: 0 of 200 states each. `myTick` and the number of
   vessels: equal in all 200. The drive at HEAD against the drive with the change, directly: the same six
   blocks and nothing else.
3. **What the six differ by.** The clock block is the hash of `[ut, simUt, revision, time, warp]`
   (`blocksOf`). Hashed without `warp.maxIndex`, `warp.limitedBy`, `time.maxRate` and `time.limitedBy` it is
   equal before and after in 200 of 200 states. In the six states `warp.maxIndex` is 10 -> 12 and
   `time.maxRate` 100,000 -> 10,000,000; `limitedBy` is null and the level in use is 1x, before and after.
   They are the states of a vessel held on a surface with no node ahead, for which `WarpLadder.refresh`
   (src/sim/world/warpLadder.ts, "Landed: any level") starts from `WARP_LEVELS.length - 1`. In the other 194
   states the highest level is bound below the old top, and the index, the rate and the sentence are the
   same before and after: physics warp only in 177 (integrating 166, rotating 10, a node at its lead time
   1); by the altitude in 10 (50x in 7, 1,000x in 2, 10,000x in 1); 100x by a node ahead in 5; 10,000x by a
   change of the sphere of influence ahead in 2. No pending `warpChanged` event differs in any state.
4. **The six entries make the test pass, and only together with the change.** With them in `BY_DESIGN` (as
   below) and the nine-level table: `npx vitest run tests/unit/sim-world/viewReference.test.ts`, 3 of 3. With
   them and the table of eleven levels: it fails at sample 0. They belong in the commit of the contract
   change, not before it and not after it.
5. **Nothing else holds step 4.1c.** On the same clean copy with the change, the six entries and the two
   warp tests restated (`tests/unit/sim-orbits/warp.test.ts` and `tests/unit/sim-world/warp.test.ts`: "the top
   level" as the highest level the limits allow there; the lead's, with the same commit):
   - `tsc` on both projects: the output of HEAD to the line (three TS2307 for `@/core/access/presentable`, a
     file that is not committed at dbe8e8f), nothing added; `tsconfig.node.json` clean.
   - `npx vitest run src/sim src/session src/terrain src/pilot src/net src/core/defs src/core/math
     src/core/contracts tools tests/unit/sim-orbits tests/unit/sim-vessel tests/unit/sim-world
     tests/unit/solar-system tests/unit/fleet tests/unit/platform tests/unit/net`: 995 tests, 972 pass, 22
     skipped, 1 fails, before and after, test for test. The one is a timeout at 30 s of
     `tests/unit/fleet/reach.test.ts` ("the ladder offers a refuel only to a craft ..."), red at HEAD.
   - The readers of the table outside that selection (`src/ui`, `src/map`, `src/core/fakes`,
     `tests/unit/flight-ui`, `tests/unit/map-view`, `tests/unit/fakes`, `tests/unit/audio/mapping.test.ts`,
     `tests/unit/vfx/effects.test.ts`) and `tests/unit/sim-island`: 408 tests, 406 pass, before and after,
     test for test; the two red are `tests/unit/fakes/deprecated.test.ts` (rules "html" and "vehicles"), red
     at HEAD.
   - `npm run test:mission`: 35 of 37, "state hash f0c0855ea40d8c59 (pilot) = f0c0855ea40d8c59 (replay,
     3673 late tile reads) = golden f0c0855ea40d8c59" (the hash of `tests/mission/golden.json` of that
     tree); the two red are the two "trajectory guard" tests that wait for their own re-record.

## Requested change
The owner's word that the six entries below go into `BY_DESIGN` of `tests/unit/sim-world/viewReference.test.ts`
in the lead's commit of step 4.1c (the lead writes them and names this request in the commit), or the same
six stated by the owner in another form of its choosing. Either way they land with the contract change
(Evidence 4).

```ts
const NINE_RAILS_LEVELS = 'the warp table of nine rails levels (decision 40; MIGRATION_V2 step 4.1c, request solar-system-sim-2): a vessel held on a surface with no node ahead may take the top of the table, which is index 12 at 10,000,000x and was index 10 at 100,000x. Only warp.maxIndex and time.maxRate of the clock block; the clock, the level in use and the flight are the same.';
// sample, scenario, was (the recording), is (nine rails levels); block 'clock', why NINE_RAILS_LEVELS
[0, 'lunar-direct', 'e01e30e0120f00cc', '0fd028b63c7d69f8'],
[1, 'lunar-direct', '19867d783a5dcd32', '35c764f0a150d6f7'],
[2, 'lunar-direct', '607e19d67a2e0ddb', '6f58dcac59d65885'],
[3, 'lunar-direct', 'bed37541e0b0bce1', '60d4210ad2dd35e5'],
[4, 'lunar-direct', '589288700fb0cfbd', '943cc60c2ea44081'],
[112, 'qa-lunar-surface', 'e621f4e5569c56d2', '1bbaf3a7eda03aea'],
```

With them, two lines of the test that today say that every designed difference is a `patches` block of
`qa-translunar` are restated: an entry carries its scenario (`'qa-translunar'` for the twelve, the scenario
above for the six), the check reads `expect(reference.samples[d.sample]!.scenario, d.why).toBe(d.scenario)`,
and the comment over it names both groups. The check after it (every entry does differ from the recording
today) holds for all eighteen as it is written.

Must NOT change: `viewReference.json` (the recording); `viewReference.ts` (the drive and `blocksOf`);
`NOT_COMPARED` (it stays empty: the clock block of the other 194 states is still held to the bit, and so are
`ut`, `simUt`, `revision`, the level in use and the rest of `time` in the six); the twelve `patches` entries.

## Resolution (2026-11-24)

island-core is closed and the coordinator ordered step 4.1c to go in with the view reference, so the lead
took the decision this request asks for: the six `BY_DESIGN` entries (each with its old value, its new
value and the reason) are in `tests/unit/sim-world/viewReference.test.ts`, in the commit of the contract
change; the recording `viewReference.json` is untouched. The next owner of `tests/unit/sim-world`
(session-switch, wave 4.3) inherits the list as it stands: 12 `patches` entries of island-core's and these
six `clock` entries of the lead's.
