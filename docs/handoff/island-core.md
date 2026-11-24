# island-core: hand-off

Work package `island-core` (wave 4.1a, MIGRATION_V2): the island and the view builders; `World` shrinks in
place to a thin single-clock host. State of 2026-11-24, first builder. **The package is NOT closed**: the
island, the view and the host over them are built and the mission flies on them, but four items of the
brief are open (section 5). A successor continues from this file and
`git log --oneline -- src/sim tests/mission tests/unit/sim-island tests/unit/sim-world`.

## 0. Where the work stands

| Step | State | Commit |
|---|---|---|
| A. `src/sim/island/api.ts`, first commit (types of the island API) | done; revised with what the build showed | e2285eb ... 91119ab |
| Reference of the wave-3 `World`'s snapshots, recorded before any change (200 states, one hash per block) | done | 82bf05a |
| B1. `stepVessel` options: step mode, pair-forced sub-step with a lockstep run, path report, structural records, Encke origin (Battin) | done; without options it is v1's step bit for bit | e1d4d18 |
| B2. `src/sim/island`: the island, the far set, frames, rails, terrain policy, operations, codec | done | 8edcf83, 3d50295 |
| D. `src/sim/view`: planning, render root, snapshot builders | done; 200 of 200 recorded states equal in every block | 8edcf83, 3d50295 |
| E1. `World` is the host over island, far set and view | done; the mission flew at the UNCHANGED golden `72c0893583aa427d` on it | 3d50295 |
| The Armed tier | done; golden re-baselined to `f6efbe54f52a40de` on the EXACT proof | 91119ab |
| `tests/unit/sim-island` (15 tests) | done for the lines of section 4 that say so | 4469cdf, d7d751b |
| E2. Formation by the join distance | built and measured, NOT switched on: request island-core-1 (section 6) | - |
| `World` under 500 lines | NOT met: `src/sim/world/sim.ts` is 1,084 lines (it was 2,847) | - |
| Vessel and port targets in the view; SOI test of an island of two; snapshot cost for 64 vessels | NOT done | - |

## 1. Public API (the signatures are the files; this is the map)

**`src/sim/island`** (`index.ts`; contract and every doc comment in `api.ts`)
- `createIsland(deps: IslandDeps, init: IslandInit): Island`,
  `decodeIsland(deps: IslandDeps, bytes: Uint8Array, options?: { mode?: StepMode }): Island`,
  `islandHash(bytes: Uint8Array): string` (`IslandFactory`).
- `IslandDeps { defs, system: BodySystem, terrain: TerrainProvider, rules: UniverseRules, resolver?, policy? }`;
  `IslandInit { id, tick, bodyId, mode?, rate? }`.
- `Island`: `id`, `tick`, `ut`, `bodyId`, `reference`, `mode`, `members` (slot order = vessel id order),
  `anchorId`, `rate`, `mergeTick`, `counters`; `member(id)`; `add(vessel, AddOptions)`, `remove(id)`,
  `settle(id)`, `refreshMargins()`; `step(): AdvanceReport`, `advanceTo(tick): AdvanceReport`,
  `mustIntegrate()`, `nextEvent()`; `applyInput(input): InputReceipt`, `applyOp(op): IslandOpChecksum | null`,
  `checksumOf(id)`; `encode({ names? })`, `hash()`; `tierOf`, `stateOf` (BCI), `seatOf(accountId)`,
  `environmentOf`, `reach(point, exceptId?)`, `thresholdWatch()`, `terrainPending()`,
  `terrainFinalUnder(id)`, `hintImpact(id, point)`; `setPairHook(hook)`, `nascentPairs`, `clearingPairs`,
  `captures`, `setNascent`, `setClearing`, `setCapture`.
- `IslandMember` (read view of a member): `vessel`, `slot`, `mode` ('landed' | 'rails' | 'armed' |
  'integrated'), `tier` ('armed' | 'full'), `orbit`, `railsEvent`, `pilot`, `attended`, `bornTick`,
  `revision`, `controllable`, `thresholdWatch`, `terrainRegime`, `previous`, `trackHold`,
  `admittedFromHead`, `reservation`.
- `IslandInput` kinds: `controls`, `reference`, `command`, `seat`, `helm`, `add`, `remove`, `reservation`,
  `destruct`, `timer` (`socketLost`, `socketBack`, `latchEnd`, `deadManRotation`, `deadManThrottle`,
  `graceEnd`), `rate`, `mergeAt`. `IslandCommand`: `stage`, `abort`, `sas`, `sasMode`, `rcs`, `legs`,
  `lights`, `fineControl`. `IslandOp` = the wire's `IslandOpBody` for `split`, `destroy`, `add`, `remove`,
  `rebase`, `replace`.
- `AdvanceReport { events, ops, commands, departures, arrivals, replan, incompleteTerrain, frameChange }`.
- `PairHook { regime(a, b, tick): 'free' | 'contact'; solve(a, b, runA, runB, tick, subStep) }`.
- For hosts: `BodyFrames`, `FarSet` / `FarObject` / `FarSink`, `TerrainPolicy`, `IslandEnv`,
  `computeRailsEvent`, `railsStateAt`, `orbitOf`, `pairReach`, `reachTime`, `checksumOfVessel`,
  `checksumsAgree`, `craftListHash`, `IslandOpError`, `underThresholdWatch`, `ISLAND_CODEC_VERSION` (1).
  `IslandImpl.recordOps = true` (not in the interface yet) makes the steps report their structural
  operations.
- Island codec: `FSPI`, u16 version, defsHash, island id, the body as one block, the names block.
  `islandHash` hashes the body. Vessels are version-4 vessel blobs written without their LABELS block
  (`EncodeOptions.labels: false`, new); names travel in the island's names block.

**`src/sim/view`**: `Planning` (`planning.ts`), `RenderRoot` (`frame.ts`), `buildSnapshot(source:
SnapshotSource): SimSnapshot`, `ViewVessel`, `buildReadouts`, `present`, `situationOf`, `StageFigures`,
`wreckSnapshot`, `privateClockView(tick, rate, maxRate, limit): TimeView`, `emptyReadouts`
(`snapshot.ts`). `SnapshotSource.relevant?: (e) => boolean` is the relevance cut (outside it:
`WorldSideSnapshotFields.poseOnly`, no parts).

**`src/sim/dynamics/integrator.ts`**: `stepVessel(vessel, env, controls, dt, opts?: StepOptions)`,
`StepOptions { mode?, pairContact?, lockstep?, records? }`, `SubstepRun`, `substepForces(run, i)`,
`substepIntegrate(run, i)`, `gravityDifference(...)`. `StepResult.path`, `.probeNear`, `.records`.

**`src/sim/world`**: `createWorld(defs, scenarioId, { terrain, ids?, renderRoot? }): SimWorld` unchanged;
`sim.ts` (`World`), `commands.ts`, `start.ts`, `warpLadder.ts`, `record.ts`; `environment.ts` and
`terrainPolicy.ts` re-export the island's.

## 2. Decisions (each with its reason)

1. **`api.ts` is types only**: the first commit had to let `universe-directory` compile before the island
   existed, and function bodies that throw would be stubs.
2. **No signed-off API text existed** (MIGRATION_V2 "before 4.1"; none in the repository). `api.ts` is
   written from ARCHITECTURE 6.2, 7.1-7.4, 7.6 and the brief's list. It is the lead's to sign.
3. **Operations are the wire contract's `IslandOpBody`**; `merge`, `capture`, `release` are left out of the
   `IslandOp` TYPE (contact-docking joins them), so nothing is a stub. `separateVessel` and `destroyParts`
   record what they did (`StepContext.records`); the island reports them with the contract's checksum. A
   fairing jettison and the weld of the clamps are not expressible as `split`: they show as `arrivals`.
4. **An input stamped at or before the island's tick is applied at once**, a later one is queued (state).
   A command's result is in the receipt. That is ARCHITECTURE 6.2 and gives the host v1's behaviour.
5. **The velocity reference of the prograde / normal / radial holds is the seat's state** (input
   `reference`): v1 took it from the navball mode; it changes the held direction, so the flight. The
   'maneuver' hold direction travels with the controls (`sasHold`). The wire has no form for the
   reference (request island-core-2).
6. **Numbers without a rules field are named constants** (request island-core-2): `ARMED_TEST_TICKS`,
   `REACH_ACCELERATION`, the watch fractions, `REDUCED_DT`, `COAST_TIME_TO_RAILS`. Armed margin, join
   distance, nascent clearance, terrain triggers and the fragment rule are read from the rules.
7. **The SOI hand-over is one instant for the whole island** (`handOver`): the anchor's event instant when
   no member is integrated (v1 for an island of one); the control tick at which an integrated anchor is
   seen across (v1); the first tick at or after the event when the anchor is on a conic and a companion is
   integrated. A member that is not the anchor never crosses by itself.
8. **The lockstep of a pair group is nested calls**: `stepVessel` hands its `SubstepRun` to
   `opts.lockstep`; the island starts the next vessel's step inside that call and the innermost runs the
   sub-steps of all (forces of every run, the hook's `solve` per pair, integration of every run). The
   free-flight path and a vessel that sub-steps alone are untouched.
9. **The host hands the island its terrain policy** (`IslandDeps.policy`); the predicted impact point is a
   hint (`hintImpact`), not an input: it changes which data is requested, never the state.
10. **`World` keeps its vessels in arrival order** (`roster`, `FarObject.order`) for the snapshot, the
    state hash and the far set's advance: that kept the golden through the move.
11. **The Armed tier**: a member on a conic that nobody attends and that is outside every armed margin
    (`armedMarginBase + armedClosingTime x closing speed`, between bounding spheres) is not stepped; it is
    placed on its conic every tick (the host and the view read it every tick), its pairs are tested every
    12 ticks, its sun sample is taken at a tenth of the rate. An attended member is never Armed: its
    attitude is integrated while it coasts, as in v1.
12. **The reference orbit is used only in the sphere of influence of the root star** (`usesReference`),
    never with today's three-body library. A member's `Vessel.r`, `v` are then offsets; `stateOf` gives
    BCI. It is replaced when the frame or the anchor changes; the 30 km and end-of-burn triggers of
    ARCHITECTURE 7.3 are NOT built, nor is dropping the reference near a surface.
13. **Predict mode** suppresses destruction by heat (held at the limit), impact and burial, leg collapse,
    joint breaks and crew loss (stress and dose stop at their limits), chute failure, the touchdown and
    splash events, the sleep transition and the splashdown confirmation.
14. **The six fixtures are not flown through an island** (analytic environments, no coast to rails): they
    guard the per-vessel step, which is unchanged; the island-of-one equality is the mission's guard.
15. **Formation by the join distance is not switched on** (section 6): it cannot pass two checks of the
    pinned guard, and loosening a guard is the lead's.

## 3. How to run and verify

- `node tools/dev/heavy.mjs --class=cpu -- npm run test:mission`: 36 of 36 at `f6efbe54f52a40de`,
  596,933 steps, 91 s.
- `node tools/dev/heavy.mjs --class=cpu -- npx vitest run src/sim tests/unit/sim-island
  tests/unit/sim-world tests/unit/sim-vessel src/pilot`: 333 of 334 (the one failure: section 7).
- `npx vitest run tests/unit/sim-world/viewReference.test.ts`: the snapshot blocks at 200 states.
- `npx vitest run tools/dev/boundaries.test.ts tools/dev/guard-pins.test.ts`: 96 of 96;
  `node tools/dev/check-stubs.mjs`: clean.
- The proof of the golden: `npx tsx tools/dev/record-mission-baseline.ts --exact
  tests/mission/rebaseline/2026-11-24-armed-after.json --reference
  tests/mission/rebaseline/2026-11-24-armed-before.json` ("all 17 milestones equal").
- When a hash moves: copy the tagged world beside the new one
  (`git show post-tighten-2026-11-24:src/sim/world/sim.ts > src/sim/world/simV1.ts`, untracked), fly both
  with the mission pilot and compare per vessel `[id, vesselStateHash, body, mode, tier]`, the fates and
  the top-level numbers at checkpoints. Done once here: 447 checkpoints, every vessel state equal.

## 4. The brief's acceptance lines

| Line | Result |
|---|---|
| An island of one equals `stepVessel` on the tick-grid World bit for bit (trajectory guard: attended craft and the six fixtures; debris by fate) | **Met.** On the host over the island the mission's state hash was the unchanged golden and every vessel's state hash equal to v1's at 447 checkpoints (3d50295). Since the Armed tier: attended craft and clamps bit-identical at 400 ticks, 13 of 13 debris by fate, six fixtures bit-identical |
| ... and a counter proves it never takes the sub-stepped path where v1 would not | **Partly.** `Island.counters` (`freeSteps`, `probeSubsteps`, `pairSubsteps`) and `StepResult.probeNear` exist; unit tests assert `pairSubsteps` 0 without a hook and exactly 2 per tick of a forced pair. No assertion on the mission flight itself (the host does not expose the counters) |
| Two craft 20 m apart in low orbit and at 30 AU, crossing the pair-regime boundary both ways, gain under 0.1 mm/s; both switch at the same tick | **Met.** 3.5e-10 m/s in low orbit, 4.3e-28 m/s at 30 AU (staged library); both vessels sub-step in exactly the ticks of the regime |
| Island codec: checkpoint, restore and continue at a staging tick, with a U5 pair, with an occupied constraint slot: bit-identical for 6,000 steps; replay of an input list with admissions, removes and timer-derived inputs | **Met** (`tests/unit/sim-island/island.test.ts`) |
| SimSnapshot from the view equals the wave-3 World's on 200 recorded states | **Met**, every block |
| `npm run test:mission` passes on the shrunk World under 5 minutes, all gates, zero incomplete terrain queries | **Met**: 36 of 36, 91 s |
| World is under 500 lines and contains no physics | **Not met**: 1,084 lines. No integrator, force or orbit propagation is in it; what is left to move out is in section 5 |
| An island crossing an SOI boundary keeps relative positions to 1 um, an Armed member included | **Not measured.** The hand-over code flies in the mission for an island of one (bit-identical to v1); no test of an island of two exists |
| Two vessels 100 m apart at 30 AU keep relative velocity noise under 1 mm/s over 10 minutes | **Met**: 8.8e-14 m/s |
| A two-island merge is independent of arrival order | **Met** (equal hash for two arrival orders, and after 600 steps) |
| Predict mode: in 1,000 seeded runs no threshold outcome; authoritative produces them | **Met**: 0 in predict; over 950 of 1,000 authoritative runs with outcomes of at least three kinds |
| Measured: step cost per regime against codebase-audit 3.3 | 2.5 us per vessel step integrated in low orbit, 2.9 us coasting attended (attitude stepped), 3.1 / 3.5 us at 30 AU with the Encke origin; the audit's range is 2.6-14.5 us. Contact regimes were not re-measured (their code path is the same function) |
| Measured: armed-tier cost | 0.20 us per member per tick in low orbit, 0.32 us at 30 AU (one Kepler evaluation and the placement), plus the pair test at 10 Hz. More than the table's "under 0.1 us per second", which counts the swept test alone: the placement every tick is decision 11 |
| Measured: snapshot build for 64 vessels with a relevance cut of 10 (budget 1.0 ms) | **Not measured.** The cut exists (`SnapshotSource.relevant`); `World` passes none |
| Measured: island codec size and time | 4.6 kB for two vessels; encode 0.22 ms, decode 0.19 ms, hash 0.05 ms |

All timings were taken with other agents' jobs running (PACKAGE_RULES 16): provisional.

## 5. What is left, in order

1. **Formation by the join distance** once request island-core-1 is answered: apply the change of
   section 6, adapt `tests/unit/sim-world/debris.test.ts` (it imports `BUBBLE_EXIT_RADIUS`), fly, compare
   the record `--exact` against `tests/mission/rebaseline/2026-11-24-armed-after.json`, re-baseline.
2. **`World` under 500 lines**: move `form` / `demote` / `upkeep` / `expire` / `handOver` (formation and
   debris rules), the milestone host methods and the snapshot source out of `sim.ts` into files of
   `src/sim/world`; nothing in them needs to change.
3. **Tests not written**: an island of two (one Armed) across an SOI boundary, relative positions to 1 um;
   the counters asserted on the mission; snapshot build time for 64 vessels with a cut of 10.
4. **Vessel and port targets in the view**: `Readouts.target` for a vessel, `Readouts.docking`,
   `NavballMarkers.relativePrograde` / `relativeRetrograde`. `World` still refuses such a target; the
   navigation functions of `solar-system-sim` for it did not exist in `src/sim/nav` when this was written.
5. Reference orbit: the 30 km and end-of-burn rebase triggers, dropping the reference near a surface.
6. `IslandImpl.recordOps` into the `Island` interface; `helm` input beyond setting the helm fields.

## 6. Formation by the join distance (IN since the second builder; lead decision on request island-core-1)

`World.form()` reads the rules' join distance: the island is what hangs together with the pilot's vessel
(members linked one to the next by less than `islandPartFactor` times the pair's join distance, `pairReach`);
a vessel outside joins inside the join distance of any member (`island.reach(...).joins`); a member with
something burning or pending stays. The 25 / 27 km constants are gone.

**Golden: `f0c0855ea40d8c59`** (it was `f6efbe54f52a40de`); 596,933 steps, 65,670 rails advances, 214,908
control ticks and the end tick are unchanged.

**(a) Every attended vessel is EXACTLY equal before and after.**
- `npx tsx tools/dev/record-mission-baseline.ts --exact tests/mission/rebaseline/2026-11-24-formation-after.json
  --reference tests/mission/rebaseline/2026-11-24-armed-after.json`: "EXACT: all 17 milestones equal"
  (every field of every milestone; the step count).
- `npx tsx tools/sim/vesselRecord.ts --compare <before> <after>` (the record of EVERY vessel of the snapshot at
  the guard's 400 control ticks, float64 bit patterns; flown on the tree before and after the change): the
  one vessel that is ever attended, `meridian-lunar`, has 400 samples in both and 0 differ (body, r, v, q,
  mass); sample ticks and the active vessel at each are equal.
- The pinned guard itself says the same of the attended craft: its first difference is in the first shed
  vessel at sample 7, none in the attended craft before or after it (the per-vessel record covers all 400).

**(b) Every unattended piece** (before = the tree at `f6efbe54f52a40de`, after = this tree; "ulp" = units in
the last place of the float64; fates are after minus before; the last column is the same fate against the
PINNED guard, which is what its test judges at 2 s and 500 m):

| Vessel | Samples in both / differing | Max ulp r / v / q where it is still a few ulp; else max dr, dv | Fate, after - before | Against the pinned guard |
|---|---|---|---|---|
| Launch clamps (`~clamp-1`, the guard's "first shed vessel") | 395 / 5 (samples 7 to 11: control ticks 2806, 3367, 3928, 4183, 4489, while v1 still had it in the full tier) | 8 / 5 / 17 ulp (5.3e-9 m, 3.6e-13 m/s) | survives, landed on Earth, same place | **bit-exact check fails at sample 7** (2 ulp in r[0]); as a survivor 0.000 m |
| Meridian M-1 (`~interstage-1`) | 24 / 20 | 1.43 km, 5.3 m/s | impact: +0.100 s, 62.0 m | +0.100 s, 62.0 m (inside) |
| Launch escape system (`~les`) | 28 / 25 | 1.09 km, 4.1 m/s | impact: -0.008 s, 16.0 m | -0.008 s, 18.2 m (inside) |
| Fairing panel 1 (`~fairing#panel0`) | 33 / 30 | 0.98 km, 13.5 m/s | impact: +0.125 s, 240.3 m | +0.125 s, 240.3 m (inside) |
| Fairing panel 2 (`~fairing#panel1`) | 33 / 30 | 0.98 km, 5.3 m/s | impact: +0.100 s, 493.8 m | +0.100 s, 493.8 m (inside, by 6 m) |
| Fairing panel 3 (`~fairing#panel2`) | 33 / 30 | 1.00 km, 5.4 m/s | impact: +0.100 s, 511.9 m | **+0.100 s, 511.9 m: OUTSIDE** |
| Fairing panel 4 (`~fairing#panel3`) | 33 / 30 | 0.99 km, 17.5 m/s | impact: +0.175 s, 242.7 m | +0.175 s, 242.7 m (inside) |
| Meridian M-2 (`~interstage-2`) | 360 / 0 | 0 | survives in Earth orbit, equal | 0 |
| Meridian M-3 (`~payload-adapter`) | 69 / 0 | 0 | lunar impact: 0.000 s, 0.000 m | 0 |
| Heron descent stage (`~stage-separator`) | 160 / 6 (samples 244 to 249) | 10 / 13 / 66 ulp (1.3e-9 m, 3.4e-15 m/s) | survives, landed on the Moon, same place | 0.000 m (inside) |
| Heron ascent stage (`~capsule-adapter`) | 12 / 5 | 1.84 km, 2.2 m/s | burned up: -8.567 s, 57,869 m | **-8.567 s, 57,949 m: OUTSIDE** |
| Lyra-A ascent engine (`~lyra-a`) | 1 / 1 | 1.84 km, 1.6 m/s | burned up: +0.267 s, 105.0 m | +0.258 s, 157.7 m (inside) |
| Kestrel apex cover (`~apex-cover`) | 11 / 3 | 0.71 km, 17.4 m/s | impact: -1.567 s, 695.8 m | **-1.567 s, 695.8 m: OUTSIDE** |

Why each differs: a piece now leaves the island at twice the join distance (about 2 km) instead of 27 km, and
from there it is on its conic in vacuum and in the Reduced tier (a point mass with a tumbling-average drag
area at 2 Hz) in an atmosphere. The M-1, the escape system and the fairing panels fall about 100 km through
the atmosphere in the Reduced tier instead of the Full one; the ascent stage and its engine enter at
11 km/s beside the capsule and are now taken over by the Reduced tier during the entry (5.3 s of flight at
that speed are the 58 km); the apex cover falls under the parachutes' altitude in the Reduced tier. The two
held structures (clamps, descent stage) ride their body through the tick-pure expression outside the island
instead of the step's (a few ulp), from the tick they leave it.

**What the lead's records agent re-records in `tests/mission/trajectory-guard.json`** (pinned; not edited
here): (1) `samples[7..11].firstShed` (control ticks 2806, 3367, 3928, 4183, 4489: 5 of the 395 samples that
hold the clamps; or the clamps judged as a survivor, which they meet at 0.000 m); (2) `debris` entries
"Lander adapter fairing panel 3", "Heron ascent stage" and "Kestrel apex cover" (and, for a file that is one
flight's, the other seven fates that moved inside the tolerance). The first builder's request named only
panel 3: the test stopped at the first row outside; it now names every one.

**Expected red until then** (`npm run test:mission`: 34 of 36): "trajectory guard: the attended craft and
the launch clamps at 400 ticks are bit-identical to the recording" (the clamps, sample 7) and "trajectory
guard: every piece of debris meets its recorded fate within 2 s and 500 m" (the three rows above). The
golden test is green on `f0c0855ea40d8c59`.

## 7. Known limits and notes

- **`tests/unit/sim-vessel/debris.test.ts` fails in one test** ("a gentle drop of each part ... ends at
  rest": `lyra-k`, on its side) since fleet-data's commit of 33 new parts (7ebd5ee), not since anything
  here: the test drops every part of the library. It is in this package's paths; whether the part's
  contact points or the test's expectation is wrong was not looked into.
- `src/pilot/generic/transfer.ts` does not compile at the moment of writing (solar-system-sim's file,
  excluded from this package's paths).
- An island has ONE body: a vessel in another sphere of influence is never a member. v1 kept such a vessel
  in its bubble; nothing in the mission showed a difference.
- The threshold watch's "probe within 2 s of the ground" uses the vessel's air-relative speed as the bound
  of its descent rate (the clearance of the previous step is not kept).
- Blobs of operations must be raw: the host inflates a deflated `WireBlob` before `applyOp`.
- `debug.setVesselState` and `debug.setUt` rebuild the host's island (`World.reseat`): nothing in a flight
  does that.

## 8. Requests

- `docs/requests/island-core-1.md` (open, blocking scope item E): the two guard checks formation by the
  join distance cannot meet.
- `docs/requests/island-core-2.md` (open): rule fields for the island's constants; a wire form for the
  velocity reference; MIGRATION_V2 principle 5 counts the re-baseline of 91119ab.
- No open request against this package's paths was found in `docs/requests`.

## 9. The golden's history through this package

`72c0893583aa427d` (post-tighten) through e1d4d18 (step options), 8edcf83 (island and view beside World)
and 3d50295 (World on the island); `f6efbe54f52a40de` since 91119ab (the Armed tier), on the EXACT
comparison of the record before and after (17 of 17 milestones, 596,933 steps both).

## 10. For the next packages

- **universe-directory**: build against `src/sim/island/index.ts`. A passive vessel enters an island with
  its committed conic (`AddOptions.conic`), so nothing moves by a rounding; `Island.reach`, `pairReach`
  and `nextEvent` are what the clock schedule and formation need; `FarSet` is v1's rails / reduced tiers as
  a host uses them; `TerrainPolicy` can be shared across islands. Timers reach the island as `timer`
  inputs at ticks. `mergeAt` is honoured by `step` (it throws past the tick) and `advanceTo`.
- **session-switch**: `World` is a host like `LocalSession` will be: `absorb(report)` shows what a host
  does with an `AdvanceReport`; the roster order and `FarObject.order` are what the golden depends on.
- **contact-docking**: `PairHook` and `SubstepRun` are the seam; nascent pairs are kept and cleared by
  collider clearance; the capture slots are carried by the codec and untouched by the island;
  `IslandOp` gains `merge`, `capture`, `release`; `destroy` with cause `collision` is refused today.
- **netcode-client**: predict mode is `createIsland(..., { mode: 'predict' })` or `decodeIsland(...,
  { mode: 'predict' })`; `applyOp` executes the server's operations and returns the checksum to compare
  (`checksumsAgree`); the velocity reference needs a wire form.
- **server-persistence**: `island.encode()` is `island_ckpt.state`; `islandHash` is the comparison of
  replays; a journal of `IslandInput` applied at their ticks reproduces the hash (tested).
