# island-core: hand-off (RUNNING STATE - the package is in progress)

Work package `island-core` (wave 4.1a, MIGRATION_V2): the island and the view builders; `World` shrinks in
place to a thin single-clock host. This file is kept current while the work runs, so that a successor can
continue from it and `git log --oneline -- src/sim tests/mission tests/unit/sim-island` alone. The final
form (PACKAGE_RULES rule 17) replaces this header when the package closes.

## 0. Where the work stands

| Step | State | Commit |
|---|---|---|
| A. `src/sim/island/api.ts` (types of the island API) | done | e2285eb |
| Reference recordings of the wave-3 `World` taken BEFORE it changes (snapshot blocks at 200 states) | see section 3 | |
| B1. `stepVessel` options: step mode, pair-forced sub-step, path report, structural records, Encke origin | see section 3 | |
| B2. `src/sim/island`: frame, rails, reduced tier, terrain policy, the island | | |
| E1. `World` over the island with v1's formation numbers (25 / 27 km): golden unchanged | | |
| D. `src/sim/view` builders; `World` under 500 lines | | |
| E2. Formation by the join distance, the Armed tier: golden re-baselined on proof | | |
| C. Island codec, operations, replay | | |
| Acceptance measurements, final hand-off | | |

## 1. Decisions (each with its reason)

1. **`api.ts` is types only.** The brief's first commit must let `universe-directory` compile against the
   API before the island exists, and a file of function bodies that throw would be a stub. The functions
   (`createIsland`, `decodeIsland`, `islandHash`) are exported by `src/sim/island/index.ts` with the
   signatures of `IslandFactory`.
2. **No signed-off API text existed.** MIGRATION_V2 ("before 4.1") says the lead signs off the island API;
   no signature list was found in the repository (hand-off lead-baseline-v2 section 2 lists it as "to be
   signed off", written by island-core against ARCHITECTURE 7). `api.ts` is therefore written from
   ARCHITECTURE 6.2, 7.1-7.4 and 7.6 and the brief's list (create, add, remove, step, applyInput, applyOp,
   encode, decode, hash, queries for tier, reach and threshold watch). It is the lead's to sign.
3. **Structural operations are the wire contract's `IslandOpBody`** (`src/core/contracts/net.ts`), the six
   this wave executes (`split`, `destroy`, `add`, `remove`, `rebase`, `replace`); `merge`, `capture`,
   `release` are left out of the `IslandOp` TYPE (contact-docking joins them), so nothing is a stub. The
   checksum is the contract's `IslandOpChecksum`.
4. **An input stamped at or before the island's tick is applied at once** (its `appliedTick` is the
   island's tick); a later one waits in the queue, which is island state. That is ARCHITECTURE 6.2's rule
   ("applied at k when it arrives before the server steps k; later, at the arrival tick") and it gives the
   thin `World` v1's behaviour: a control or a command given between two steps acts on the next step.
5. **The velocity reference of the SAS hold directions is member state.** v1's prograde / normal / radial
   holds use the navball mode (surface or orbit), which switches by altitude with hysteresis: it changes the
   flight, so it cannot stay a view matter. The island keeps it per member with v1's rule; the wire has no
   command for it yet (see Requests).
6. **Numbers without a rules field** are named constants in `api.ts` until the lead adds fields (see
   Requests): the Armed tier's test interval (10 Hz), the worst-case acceleration of the reach time
   (60 m/s^2), the threshold-watch fractions, the rebase offset of the reference orbit (30 km),
   `COAST_TIME_TO_RAILS` (v1's 0.5 s) and the Reduced tier's step (0.5 s).
7. **The SOI hand-over is one instant for the whole island**: the anchor's event instant when no member is
   integrated (exact, inside a tick, as v1 for an island of one); the tick boundary at which an integrated
   anchor's crossing is seen at a control tick (as v1); the first tick at or after the event when the
   anchor is on rails and a companion is integrated.

## 2. Requests

(none filed yet; planned: rule fields for the constants of decision 6; a wire command for the velocity
reference of decision 5)

## 3. Log

- 2026-11-24: brief, rules, ARCHITECTURE 3, 4, 5.1, 6.2, 6.4, 7.1-7.6, MIGRATION 1, 3, 5, the contracts and
  the whole of `src/sim/world/sim.ts` read. `api.ts` committed (e2285eb).

## 4. What is left, in order

See the table of section 0. The order is chosen so that the golden hash stays `72c0893583aa427d` through
B1, B2, E1 and D (pure moves) and changes once, at E2, where debris changes tier by design.
