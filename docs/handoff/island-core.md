# island-core: hand-off (RUNNING STATE - the package is in progress)

Work package `island-core` (wave 4.1a, MIGRATION_V2): the island and the view builders; `World` shrinks in
place to a thin single-clock host. This file is kept current while the work runs, so that a successor can
continue from it and `git log --oneline -- src/sim tests/mission tests/unit/sim-island tests/unit/sim-world`
alone. The final form (PACKAGE_RULES rule 17) replaces this header when the package closes.

## 0. Where the work stands

| Step | State | Commit |
|---|---|---|
| A. `src/sim/island/api.ts` (types of the island API), first commit | done; revised with what the build showed | e2285eb, 8edcf83 |
| Reference of the wave-3 `World`'s snapshots, recorded BEFORE any change (200 states, one hash per block) | done | 82bf05a |
| B1. `stepVessel` options: step mode, pair-forced sub-step with a lockstep run, path report, structural records, Encke origin (Battin) | done; without options it is v1's step bit for bit (six fixtures; mission at the golden) | e1d4d18 |
| B2. `src/sim/island`: the island, the far set (rails, held, reduced tier), frames, rails, terrain policy, operations, codec | built; used by the mission through `World`; NOT YET unit-tested on its own (section 5) | 8edcf83, 3d50295 |
| D. `src/sim/view`: planning, render root, snapshot builders | done; 200 of 200 recorded states equal in every block | 8edcf83, 3d50295 |
| E1. `World` is the host over island, far set and view, with v1's formation numbers (25 / 27 km) | done; mission 36 of 36 at the golden `72c0893583aa427d` | 3d50295 |
| E2. Formation by the join distance; the Armed tier; golden re-baselined on proof | see section 5 | |
| `World` under 500 lines | NOT YET: `src/sim/world/sim.ts` is 1,080 lines (it was 2,847) with no physics in it | |
| C-tests. Island codec, operations, replay, pairs, predict mode, reference orbit: `tests/unit/sim-island` | see section 5 | |
| Acceptance measurements, requests, final hand-off | see section 5 | |

## 1. What exists (read this before the code)

- **`src/sim/island/api.ts`** - the contract, types only. `index.ts` exports `createIsland(deps, init)`,
  `decodeIsland(deps, bytes, { mode })`, `islandHash(bytes)` (`IslandFactory`), and the pieces a host
  needs: `BodyFrames`, `FarSet`, `TerrainPolicy`, `IslandEnv`, `computeRailsEvent`, `railsStateAt`,
  `orbitOf`, `checksumOfVessel`, `IslandOpError`.
- **`island.ts`** (`IslandImpl`) - members ordered by vessel id, each a `Rec` (mode landed / rails / armed /
  integrated, conic and next event, seat, attendance, tick of birth, coast timer, terrain regime,
  previous pose). `step()`: queued inputs, terrain work at control ticks, SAS hold directions of piloted
  members, pair groups, every member in id order (vessels born in the step are stepped once in the same
  tick, after the others), a pending hand-over, tick + 1, ages, control-tick upkeep (hand-over of an
  integrated anchor, armed margins, nascent pairs, threshold watch). `advanceTo(tick)`: the rails advance
  (clamped to the island's next atmosphere / impact event and to a pending merge tick). Inputs
  (`applyInput`: at once when stamped at or before the island's tick, else queued), commands, operations
  (`ops.ts`), reach, codec (`codec.ts`).
- **`far.ts`** (`FarSet`) - what is on the clock but in no island: v1's `rails` and `reduced` tiers and
  held vessels, each with its own SOI body. The host advances it (`step`, `advanceTo`, `sync`).
- **`frames.ts`** (`BodyFrames`) - tick-pure body orientation, environment aiming, sun sample;
  **`rails.ts`** - conic events, `railsStateAt` (the tick-pure expression), the hand-over shift;
  **`environment.ts`**, **`terrainPolicy.ts`** - moved from `src/sim/world` (the old files re-export).
- **`src/sim/view`** - `planning.ts` (`Planning`: target, nodes, burn bookkeeping, patches, stage figures,
  navball mode), `frame.ts` (`RenderRoot`: epoch, rebase, history, patches and events in the frame),
  `snapshot.ts` (`buildSnapshot(source)`, `buildReadouts`, `present`, `situationOf`, `StageFigures`,
  `wreckSnapshot`, `privateClockView`, `emptyReadouts`; `ViewVessel` is what a vessel looks like to it;
  `SnapshotSource.relevant` is the relevance cut: outside it a vessel is pose-only, no parts).
- **`src/sim/world`** - `sim.ts` (`World`: roster in arrival order, the active vessel, the pilot's seat
  inputs, `step` / `advance` / `advanceRails`, `absorb(report)`, formation `form()`, debris rules,
  milestone host, snapshot source, state hash), `commands.ts` (`PlayerCommands`, `SessionDebug`),
  `start.ts` (the scenario start), `warpLadder.ts` (`WarpLadder`), `record.ts` (`FlightRecord`: the
  milestone host's data). `milestones.ts`, `scenarioStart.ts`, `stateHash.ts` are untouched.
- **`src/sim/dynamics/integrator.ts`** - `stepVessel(vessel, env, controls, dt, opts?)`,
  `StepOptions { mode, pairContact, lockstep, records }`, `SubstepRun`, `substepForces`,
  `substepIntegrate`, `gravityDifference`. `StepResult` has `path` ('none' | 'held' | 'free' | 'substep'),
  `probeNear` and `records`.

## 2. Decisions (each with its reason)

1. **`api.ts` is types only.** The brief's first commit must let `universe-directory` compile against the
   API before the island exists, and a file of function bodies that throw would be a stub.
2. **No signed-off API text existed.** MIGRATION_V2 ("before 4.1") says the lead signs off the island API;
   no signature list was found in the repository. `api.ts` is written from ARCHITECTURE 6.2, 7.1-7.4 and
   7.6 and the brief's list. It is the lead's to sign.
3. **Structural operations are the wire contract's `IslandOpBody`**, the six this wave executes (`split`,
   `destroy`, `add`, `remove`, `rebase`, `replace`); `merge`, `capture`, `release` are left out of the
   `IslandOp` TYPE (contact-docking joins them), so nothing is a stub. The vessel code records what it did
   (`StepContext.records`: `separateVessel` and `destroyParts`), the island reports them as operations
   with the contract's `IslandOpChecksum` when `IslandImpl.recordOps` is on.
4. **An input stamped at or before the island's tick is applied at once**; a later one waits in the queue,
   which is island state (ARCHITECTURE 6.2). That gives the host v1's behaviour: a control or a command
   given between two steps acts on the next step, and a command's result is in the receipt.
5. **The velocity reference of the prograde / normal / radial SAS holds is the SEAT's state**, set by an
   input (`kind: 'reference'`): v1 took it from the navball mode, which switches by altitude and which the
   pilot can set; it changes the held direction and so the flight. The host (later the client) sends it
   when its navball mode changes. The hold direction of the 'maneuver' mode travels with the controls
   (`sasHold`), as the wire's `InputSample` already says. The wire has no message for the reference yet.
6. **Numbers without a rules field** are named constants (`api.ts`, `island.ts`) until the lead adds
   fields: the Armed tier's test interval (10 Hz), the worst-case acceleration of the reach time
   (60 m/s^2), the threshold-watch fractions (0.9, 0.8, 2 s), `COAST_TIME_TO_RAILS` (v1's 0.5 s), the
   Reduced tier's step (0.5 s). The terrain triggers, the armed margin, the join distance, the nascent
   clearance and the fragment rule are read from the rules document.
7. **The SOI hand-over is one instant for the whole island** (`handOver`): the anchor's event instant when
   no member is integrated (exact, inside a tick: v1 for an island of one); the control tick at which an
   integrated anchor is seen across (v1); the first tick at or after the event when the anchor is on a
   conic and a companion is integrated. A member that is not the anchor never crosses by itself.
8. **The lockstep of a pair group is nested calls, not a rewrite of the step.** `stepVessel` hands its
   `SubstepRun` to `opts.lockstep`; the island starts the next vessel's `stepVessel` from inside that call,
   and the innermost runs the sub-steps of all (`substepForces` for every run, the pair hook's `solve`,
   `substepIntegrate` for every run). The forty locals of the step stay locals, the free-flight path is
   untouched, and a vessel that sub-steps alone uses the module's scratch exactly as before.
9. **The host hands the island its terrain policy** (`IslandDeps.policy`): the policy outlives an island
   (the host forms a new one when the pilot's vessel changes body) and a shard with several islands shares
   one. The predicted impact point is a HINT (`hintImpact`), not an input: it changes which data is
   requested, never a number of the state; the island does the regime, the discs under its members and the
   collision warming itself.
10. **`World` keeps its vessels in arrival order (`roster`)** for the snapshot, the state hash and the far
    set's advance order: that is what keeps the golden hash through the move (an island orders by id). One
    difference showed in the first flight on the island: two debris fates of one rails advance came out in
    the far set's order; `FarObject.order` fixed it.
11. **Vessels that go are dropped from the roster at the next control tick** (`gone`), as v1 compacted
    its entries there: `vesselCount` of a milestone record is the same number.
12. **The reference orbit (frame ISL) is used only in the sphere of influence of the root star**
    (`usesReference`), i.e. never with today's three-body library. With it a member's `Vessel.r`, `v` are
    offsets; `Island.stateOf` gives BCI. The vessel package's read-only helpers are called through
    `inBci`. The integrator skips the ground broadphase for an offset state: the island must drop its
    reference before a member comes near a surface - NOT BUILT (nothing in the star's SOI is near one).
13. **Predict mode** suppresses: destruction by heat (the surface is held at its limit), by impact and by
    burial; leg collapse; joint breaks and crew loss in `checkLoads` (stress and dose stop at their limits);
    chute failure; the touchdown and splash events; the sleep transition and the splashdown confirmation.
14. **Not interpreted as a requirement:** the six fixtures are not flown THROUGH an island (they run on
    analytic environments and never coast to rails); they guard the per-vessel step the island calls, which
    is unchanged. The island-of-one equality is the mission's trajectory guard.

## 3. How the golden was kept (and how to check a change)

- `npm run test:mission` (through the cpu gate): 36 of 36 at `72c0893583aa427d`, 596,933 steps, 88 s.
- `npx vitest run tests/unit/sim-world/viewReference.test.ts`: the snapshot blocks at 200 states.
- When the hash moved once during the work, the cause was found by tracing: the tagged `sim.ts`
  (`git show post-tighten-2026-11-24:src/sim/world/sim.ts`) copied beside the new one as an untracked file,
  both flown with the mission pilot, the per-vessel `[id, vesselStateHash, body, mode, tier]`, the fates and
  the top-level numbers written at 447 checkpoints and compared (the scratch script is not committed; the
  method is these four lines). Every vessel state was equal; only the order of two fates differed.

## 4. Requests

None filed yet. To file: (1) rules fields for the constants of decision 6; (2) a wire message for the
velocity reference of decision 5 (`WireCommand` or a field of `InputSample`); (3) to the lead: MIGRATION_V2
principle 5 when E2 re-baselines the golden.

## 5. What is left, in order

1. **E2** (changes the golden; needs the proof): in `World.form()` replace the 25 / 27 km numbers by
   `island.reach(...)` (`joins`, `parted`; the rules' join distance and part factor); in the island make an
   unattended, quiescent member beyond the armed margin `mode: 'armed'` (not stepped; placed on its conic;
   the swept test every `ARMED_TEST_TICKS`; the margin grows with the closing speed). Proof: record the
   mission before and after with `tools/dev/record-mission-baseline.ts` and compare `--exact`; the
   trajectory guard (attended craft bit for bit, debris by fate). Then `tests/mission/golden.json`,
   `NOT_COMPARED` in `viewReference.test.ts` (`otherVessels`), `tests/unit/sim-world/debris.test.ts`.
2. **`tests/unit/sim-island`** (none exists yet): island of one against the host's flight with the
   counters (`pairSubsteps` 0, every sub-step a probe's); the pair regime forced by the hook at 20 m in low
   orbit and at 30 AU (staged library: `loadLibraryOver()` of `tools/sim/realWorld.ts`); codec checkpoint
   and continue at a staging tick, with a U5 pair, with a capture slot; replay of an input list; SOI
   crossing of an island of two with an Armed member; 100 m apart at 30 AU for 10 minutes; merge order;
   predict mode in 1,000 seeded runs; the measurements.
3. **`World` under 500 lines**: move `form` / `demote` / `upkeep` / `expire` / `handOver`, the milestone
   host and the snapshot source out of `sim.ts` into files of `src/sim/world`.
4. Vessel and port targets in the view (`Readouts.target` for a vessel, the relative navball markers);
   `World` still refuses them.
5. Two tests of `tests/unit/sim-vessel` fail since fleet-data's commit 7ebd5ee (33 new parts), not since
   anything here: `data.test.ts` (a new part has no visual section yet) and `debris.test.ts` (`lyra-k` on
   its side does not come to rest in the drop test). They are in this package's paths: adapt or request.
6. Requests of section 4; the final hand-off with the acceptance table.
