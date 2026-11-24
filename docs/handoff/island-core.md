# island-core: hand-off

Work package `island-core` (wave 4.1a, MIGRATION_V2): the island and the view builders; `World` shrinks in
place to a thin single-clock host. State of 2026-11-24, second builder (the first stopped at 06b05ba with
the island, the view and the host built and the mission flying on them). **Open: section 5** (vessel and
port targets in the view; three smaller items). Everything else of the brief is built, measured and
committed. Continue from this file and
`git log --oneline -- src/sim tests/mission tests/unit/sim-island tests/unit/sim-world tools/sim`.

## 0. Where the work stands

| Step | State | Commit |
|---|---|---|
| `src/sim/island`: the island, the far set, frames, rails, terrain policy, operations, codec | done | 8edcf83, 3d50295, 91119ab |
| `stepVessel` options (step mode, pair-forced sub-steps with a lockstep run, path report, records, Encke origin) | done; without options it is v1's step bit for bit | e1d4d18 |
| `src/sim/view`: planning, render root, snapshot builders, `Presenter`, `PilotSeat` | done; 200 recorded states equal (12 `patches` blocks differ by design, section 4) | 8edcf83, 3976a55, 4c9a569 |
| The Armed tier | done; golden `f6efbe54f52a40de` on the EXACT proof | 91119ab |
| **Formation by the join distance** (lead decision on request island-core-1) | done; golden `f0c0855ea40d8c59` on the EXACT proof; section 6 | 2e23f69 |
| **`World` under 500 lines, hosting only** | done: `src/sim/world/sim.ts` is 499 lines (1,084 before, 2,847 in v1); section 2, decision 16 | 3976a55 |
| **SOI crossing of an island of two; snapshot of 64 vessels; step paths asserted on the mission** | done; section 4 | 4c9a569 |
| **The reference orbit's rebase at 30 km and at burn end** | done | 8e029b8 |
| **Requests solar-system-sim-1 (items 1-4, 6), fleet-data-5, fleet-data-7** | resolved in their files | 4c9a569, 6847116 |
| Vessel and port targets in the view (`Readouts.target` / `.docking` for a vessel or port, the SAS target modes, the navball's target mode) | **NOT done**; section 5 | - |

Expected red until the lead's records agent re-records the pinned guard: two tests of `npm run test:mission`
(section 6). Red in the working tree and NOT this package's: `tests/unit/sim-vessel/codec.test.ts` (two
corpus tests: "pathfinder-bus was 7940b14643a94c75 ... and is fe5a659608638419 now") and several
`tests/unit/fleet` flights, from uncommitted edits of part definitions by another agent
(`git diff -- data/defs/parts`); `tools/dev/boundaries.test.ts` (one line of
`src/pilot/generic/transfer.ts`, solar-system-sim's file).

## 1. The island API, exactly (`src/sim/island/index.ts`; types and doc comments in `api.ts`)

This is what `universe-directory`, `netcode-client`, `server-persistence` and `contact-docking` build on.
It was written from ARCHITECTURE 6.2, 7.1-7.4, 7.6 (no signed-off text existed); it is the lead's to sign.

### 1.1 Functions

```ts
createIsland(deps: IslandDeps, init: IslandInit): Island
decodeIsland(deps: IslandDeps, bytes: Uint8Array, options?: { mode?: StepMode }): Island
islandHash(bytes: Uint8Array): string                    // 16 hex digits; every byte but the header and the names

interface IslandDeps { defs: DefLibrary; system: BodySystem; terrain: TerrainProvider; rules: UniverseRules;
                       resolver?: DefResolver; policy?: TerrainPolicy }      // not state: a decoded island is given the same
interface IslandInit { id: string; tick: number; bodyId: string; mode?: StepMode; rate?: number }
type StepMode = 'authoritative' | 'predict'
```

### 1.2 `Island`

```ts
readonly id: string
readonly tick: number                       // every member's state is the state at this tick
readonly ut: number                         // tick / 120
readonly bodyId: string                     // SOI body of the island's frame
readonly reference: ReferenceOrbit | null   // { r0, v0, tick }: set = members' r, v are OFFSETS from it (the star's SOI)
readonly mode: StepMode
readonly members: readonly IslandMember[]   // slot order = vessel id order (code units)
readonly anchorId: string | null            // lowest attended id, else lowest id
readonly rate: number
readonly mergeTick: number | null
readonly counters: Readonly<IslandCounters> // steps, railsAdvances, freeSteps, probeSubsteps, pairSubsteps, armedTests

member(vesselId: string): IslandMember | null
add(vessel: Vessel, options?: AddOptions): IslandMember     // vessel given in BCI of bodyId at the tick
remove(vesselId: string, reason?: 'left' | 'removed'): Vessel | null   // returned in BCI
settle(vesselId: string): void                              // decide the mode now (rails at once when quiescent)
refreshMargins(): void                                      // armed margins now (the island does it every control tick)

step(): AdvanceReport                       // one tick; throws at a pending merge tick
advanceTo(tick: number): AdvanceReport      // rails advance; lands earlier on an island event; no-op while mustIntegrate()
mustIntegrate(): boolean
nextEvent(): IslandEvent | null             // next 'atmosphere' | 'impact' of a member on a conic

applyInput(input: IslandInput): InputReceipt
applyOp(op: IslandOp): IslandOpChecksum | null              // throws IslandOpError when it does not fit the state
checksumOf(vesselId: string): IslandOpChecksum | null

encode(options?: { names?: boolean }): Uint8Array
hash(): string                              // islandHash(encode({ names: false }))

tierOf(vesselId: string): MemberTier | null                 // 'armed' | 'full'
stateOf(vesselId: string): { r: Vec3; v: Vec3 } | null      // VES origin in BCI, whatever the frame
seatOf(accountId: string): { vesselId; controls; sasHold: Vec3 | null; reference: 'surface' | 'orbit'; latchOpenTick: number | null } | null
environmentOf(vesselId: string): VesselEnvironment | null   // start-of-step values at the tick
reach(point: { r: Vec3; v: Vec3; radius: number }, exceptId?: string): Reach
linkedTo(vesselId: string): ReadonlySet<string>             // what hangs together with it inside the parting distance (NEW)
thresholdWatch(): boolean
terrainPending(): Promise<void> | null
terrainFinalUnder(vesselId: string): boolean
hintImpact(vesselId: string, point: { bodyId: string; latitude: number; longitude: number } | null): void

setPairHook(hook: PairHook): void
readonly nascentPairs: readonly PairRef[]; readonly clearingPairs: readonly ClearingPair[]; readonly captures: readonly CaptureConstraint[]
setNascent(pair: PairRef, on: boolean): void
setClearing(pair: ClearingPair | PairRef, on: boolean): void
setCapture(constraint: CaptureConstraint | PairRef, on: boolean): void
```

`IslandMember` (read view; never write the vessel): `vessel`, `slot`, `mode` ('landed' | 'rails' | 'armed'
| 'integrated'), `tier`, `orbit`, `railsEvent`, `pilot`, `attended`, `bornTick`, `revision`, `controllable`,
`thresholdWatch`, `terrainRegime`, `previous`, `trackHold`, `admittedFromHead`, `reservation`.
`AddOptions { bornTick?, pilot?, attended?, conic?: { orbit; event }, revision?, admittedFromHead? }`.
`Reach { distance, closingSpeed, joinDistance, joins, parted, tau, vesselId }`.
`AdvanceReport { events, ops: AppliedOp[], commands: CommandOutcome[], departures, arrivals, replan, incompleteTerrain, frameChange }`.
`PairHook { regime(a, b, tick): 'free' | 'contact'; solve(a, b, runA, runB, tick, subStep): void }`.
`IslandInput` kinds: `controls`, `reference`, `command` (`IslandCommand`: stage, abort, sas, sasMode, rcs,
legs, lights, fineControl), `seat`, `helm`, `add`, `remove`, `reservation`, `destruct`, `timer`
(socketLost, socketBack, latchEnd, deadManRotation, deadManThrottle, graceEnd), `rate`, `mergeAt`; each
`{ tick, accountId, seq }`-stamped. `IslandOp` = the wire's `IslandOpBody` for `split`, `destroy`, `add`,
`remove`, `rebase`, `replace` (`merge`, `capture`, `release` join with contact-docking).
Also exported for hosts: `FarSet` (`add`, `take`, `receive(island, id, order)`, `release(island, id, tick)`,
`joinInto(island, tick)`, `step`, `advanceTo`, `sync`, `compact`), `BodyFrames` (`orientAt`, `aim`,
`altitudeAt`, `sunSample`, `gravityAt`), `TerrainPolicy` (`throwIfBroken()` new), `pairReach`, `reachTime`,
`checksumOfVessel`, `checksumsAgree`, `craftListHash`, `underThresholdWatch`, `computeRailsEvent`,
`railsStateAt`, `orbitOf`, `ISLAND_CODEC_VERSION` (1), the constants `ARMED_TEST_TICKS` (12),
`COAST_TIME_TO_RAILS` (0.5 s), `REDUCED_DT` (0.5 s), `REACH_ACCELERATION` (60), `REFERENCE_OFFSET_MAX`
(30 km), `REFERENCE_SETTLE_DISTANCE` (1 m), `REFERENCE_SETTLE_SPEED` (1 mm/s).

### 1.3 Invariants

1. **State at a tick is a function of the tick, the vessels and the island's own items** (what `encode`
   writes): no clock base, no phase of the control tick (`tick % 4`), none of the sun sample (`tick % 12`;
   an Armed member's at `tick % 120`), none of the armed test (`tick % 12`).
2. **Order**: members by vessel id; inputs of one tick by `(tick, accountId, seq)`; operations in the order
   given; vessels a step brings into being are stepped once in that tick, after the members.
3. **One frame**: BCI of `bodyId`, or offsets from `reference`. `add` takes and `remove`, `Departure.vessel`
   and `stateOf` give BCI. The island changes frame as a unit (`handOver`, `rebase`); `AdvanceReport
   .frameChange` says so. A member that is not the anchor never crosses a sphere of influence by itself.
4. **An island of one with no reference orbit is v1's `stepVessel` on the tick grid, bit for bit**, and takes
   the sub-stepped path only where v1 did (`counters.pairSubsteps` is 0 without a hook: asserted on the
   mission).
5. **A pair the hook puts in the contact regime sub-steps together**: both in the tick the hook first says
   'contact', both out at the first tick it says 'free'; `solve` runs once per sub-step after the forces of
   every vessel of the group and before any is integrated.
6. **`Vessel.age` = (tick - bornTick) / 120** for every member; `controllable` is command authority
   (`hasCommandAuthority`: living crew in a command part, or a remote one) and follows the parts and the
   crew; a seat on a vessel without it has its `controls` and `command` inputs refused.
7. **Never past a pending merge tick**: `step` throws, `advanceTo` stops there.
8. **The reference orbit** (only in the sphere of influence of the root star) is replaced, as a `rebase`
   operation with a frame change, when the anchor changes, at a hand-over into the star's sphere, when the
   anchor's offset passes 30 km, and when the anchor has finished a burn (it coasts off the reference orbit
   by more than 1 m or 1 mm/s: read off the state, so a restored island rebases at the same tick).

### 1.4 What is deterministic, and under which inputs

Given the same `IslandDeps` content (definitions by `defsHash`, the rules document, the body library, the
SAME terrain data level under every contact step), the same starting bytes and the same list of
`applyInput` / `applyOp` / `add` / `remove` / `settle` calls at the same ticks, two islands produce the same
`hash()` at every tick, in one process or two, stepping (`step`) or mixing steps and rails advances the same
way (tested: checkpoint and continue for 6,000 steps, at a staging tick, with a U5 pair, an occupied capture
slot, queued inputs, through an SOI crossing in the contact regime, in the middle of a burn at 30 AU; a
replay of an input list; two arrival orders of a merge). NOT covered by the hash and free to differ:
names (the LABELS blocks), `counters`, `IslandMember.previous`, terrain requests and hints. NOT
guaranteed equal: a `step` sequence against one `advanceTo` over the same ticks (an attended member's
attitude is integrated while it coasts; positions agree: 0 m in the SOI test), and the same flight on
different terrain data levels (`AdvanceReport.incompleteTerrain` says when a step ran on data that was not
final; a shard waits instead, ARCHITECTURE 7.6).

### 1.5 `mode: 'predict'` may and may not

May: everything a command or a control input causes (staging, abort, legs, chutes deploying, the split of
the pilot's own craft: `AdvanceReport.ops` lists the command-triggered operations), the SOI hand-over, the
rebase, rails and Armed transitions, `applyOp` of the server's operations with the checksum to compare
(`checksumsAgree`). May not, and does not: destroy a part by heat (held at its limit), by impact or burial,
or below the floor of a body without a surface; collapse a leg; break a joint; lose the crew (stress and
dose stop at their limits); fail a chute; emit `touchdown` or `splash`; put a vessel to sleep; confirm a
splashdown. 1,000 seeded runs: no event of `THRESHOLD_EVENTS` in predict, over 950 with outcomes in
authoritative. `decodeIsland(deps, bytes, { mode: 'predict' })` reads a server checkpoint as a replica.

### 1.6 What the wire layer's key, delta and op carry of it (docs/handoff/wire-protocol.md)

| Wire | Island |
|---|---|
| `IslandEnterMessage.state` (a `WireBlob`), `.members`, `.tick` | `island.encode()` (inflate before `decodeIsland`), `island.members.map((m) => m.vessel.id)` (slot order), `island.tick` |
| `IslandOpMessage.body`, `.checksum`, `.tick` | `AppliedOp.body`, `.checksum`, `.tick` of `AdvanceReport.ops` / `InputReceipt.report.ops` (a host sets `IslandImpl.recordOps = true` to have the steps report their structural operations); the receiver calls `applyOp(body)` at that tick and compares with `checksumsAgree`. Blobs inside `add` / `replace` must be raw |
| `IslandKeyMessage` / `IslandDeltaMessage` vessels (pose by slot) | `stateOf(id)` (BCI r, v) and the member vessel's `q`, `w`. **The island has no call that sets a member's pose from a key**: a replica is corrected by `replace` (the whole vessel as a blob) or by `decodeIsland` of a checkpoint and a replay of its inputs. If netcode-client wants a pose-only correction, that is a request against `src/sim/island` |
| `InputSample { applyTick, seq, controls, sasHold }` | `applyInput({ kind: 'controls', tick: applyTick, accountId, seq, vesselId, controls, sasHold })`; `InputReceipt.appliedTick` is `InputAck` (stamped when equal to `applyTick`, else late) |
| `WireCommand` of the seat | `applyInput({ kind: 'command', ... })`; `InputReceipt.outcome` / `AdvanceReport.commands` is the `CommandResult` |
| `IslandSlowMessage` | not produced here (slow part state is read off `member.vessel`) |
| (none) | the velocity reference of the prograde / normal / radial holds (`kind: 'reference'`): **no wire form yet**, request island-core-2 |

Island codec: `FSPI`, u16 version, defsHash, island id, the body as one block (members with tier flags and
the anchor, the reference orbit, nascent pairs, U5 pairs with timers, capture slots with timers, threshold
flags, admitted copies with old heads and reservation state, the merge tick, per pilot the latched controls,
hold direction, velocity reference, latch timer and queued inputs), the names block. Vessels are version-4
vessel blobs without their LABELS block.

## 2. Decisions (each with its reason)

1-15 are the first builder's and stand (types-only `api.ts`; operations are the wire's `IslandOpBody`; an
input stamped at or before the tick is applied at once; the velocity reference is the seat's state; the
hand-over is one instant for the whole island; the lockstep is nested calls; the host hands the island its
terrain policy; roster order kept; the Armed tier places a member on its conic every tick; the reference
orbit only in the star's sphere; the predict list; the fixtures are not flown through an island). New:

16. **What "World under 500 lines" moved, and where.** Into the ISLAND: the linked set of a member
    (`Island.linkedTo`), the far set's `receive` / `release` / `joinInto`, `TerrainPolicy.throwIfBroken`.
    Into the VIEW: `Presenter` (how each vessel of the clock is read, the event queue, the render root, the
    snapshot and its peek cache; it reads a `PresentedHost`), `PilotSeat` (how the plan reaches the island
    in the pilot's inputs: hold direction, velocity reference, impact hint, node bookkeeping; it reads a
    `SeatHost`), `Planning.frameChanged` / `.noteEvent`, `host.ts` (`viewOfMember`, `viewOfFar`,
    `viewOfDeparted`, `planSubject`). BESIDE the host in `src/sim/world`, because `src/session` and
    `src/universe` are not this package's: `mission.ts` (`MissionWatch`: milestones, the flight record,
    mission state; the universe's objective observer takes it), `debris.ts` (`Debris`: fragment expiry, the
    cap, the fates; the universe's expiry takes it), `pacing.ts` (`FramePacer`: wall time to ticks and the
    presentation lag; `LocalSession` takes it), `start.ts` (the start protocol), `api.ts` (the host's
    types), `stateHash.ts` (`sessionStateHash`), `WarpLadder.refreshFor` / `.blocks`. `World` keeps the
    clock's tick, the active vessel and its hand-over, the warp ladder, formation, `absorb(report)`.
17. **Formation is two island-level primitives**: `linkedTo` (who has parted) and `FarSet.joinInto` (who
    joins, each seeing those that joined before it); the host only says about which vessel.
18. **The burn-end rebase is a function of the state** (invariant 8), not of a remembered "was burning".
19. **Controllable means command authority** (request fleet-data-5), and the island refuses a seat's controls
    and commands without it; the latched controls stand.
20. **A member below the floor of a body without a surface** is destroyed on the control-tick cadence by a
    `destroy` operation, authoritative mode only (request solar-system-sim-1).
21. **The view predicts with the three-period encounter search**; the wave-3 recording is not re-recorded,
    the test states the 12 blocks that differ.

## 3. How to run and verify

- `node tools/dev/heavy.mjs --class=cpu -- npm run test:mission`: 35 of 37 at `f0c0855ea40d8c59`, 596,933
  steps, 85 s (the two red tests: section 6).
- `node tools/dev/heavy.mjs --class=cpu -- npx vitest run src/sim src/pilot tests/unit/sim-island
  tests/unit/sim-world tests/unit/sim-vessel`: 392 tests, all green but the two corpus tests named in
  section 0.
- The proofs of the golden: `npx tsx tools/dev/record-mission-baseline.ts --exact
  tests/mission/rebaseline/2026-11-24-formation-after.json --reference
  tests/mission/rebaseline/2026-11-24-armed-after.json`; per vessel:
  `node tools/dev/heavy.mjs --class=cpu -- npx tsx tools/sim/vesselRecord.ts --out <file> [--mission <record>]`
  on the tree before and after a change, then `npx tsx tools/sim/vesselRecord.ts --compare <before> <after>`
  (exit 1 when an attended sample differs; the table of section 6 is its output).
- `npx vitest run tools/dev/boundaries.test.ts`; `node tools/dev/check-stubs.mjs` (clean).

## 4. The brief's acceptance lines

| Line | Result |
|---|---|
| An island of one equals `stepVessel` on the tick-grid World bit for bit; debris by fate | **Met for the attended craft and the six fixtures** (400 of 400 samples, 17 of 17 milestones EXACT). Debris: 10 of 13 within 2 s and 500 m of the pinned guard, 3 outside by design of formation (section 6) |
| ... and a counter proves it never takes the sub-stepped path where v1 would not | **Met**, on the mission: 0 vessel steps sub-stepped without their own probe near (`WorldStats.pairSubsteps`), the replay the same; unit tests: 0 without a hook, exactly 2 per tick of a forced pair |
| Two craft 20 m apart, low orbit and 30 AU, crossing the pair-regime boundary both ways: under 0.1 mm/s; same tick | **Met**: 3.5e-10 m/s, 4.3e-28 m/s |
| Island codec: checkpoint at a staging tick, with a U5 pair, with an occupied slot: 6,000 steps; replay of an input list | **Met** |
| SimSnapshot from the view equals the wave-3 World's on 200 recorded states | **Met** but for the `patches` block of 12 states of `qa-translunar` (samples 46-55, 66, 67), which shows the three-period encounter search by design (request solar-system-sim-1); each is stated with its old and new value in `viewReference.test.ts` |
| `npm run test:mission` passes on the shrunk World under 5 minutes, zero incomplete terrain queries | **35 of 37**, 85 s; the two red tests are the pinned guard's (section 6) |
| World is under 500 lines and contains no physics | **Met**: 499 lines; no integrator, force or propagation in it |
| An island crossing an SOI boundary keeps relative positions to 1 um, an Armed member included | **Met** (`tests/unit/sim-island/soi.test.ts`): on rails with an Armed member 1.5e-11 m and 7.9e-11 m/s across the hand-over; a rails advance lands where the steps do (0 m); a pair in the contact regime, together, bravo first and alpha first: both change body in the same tick, 2 sub-stepped vessel steps in every tick through it, 3e-12 m and 2e-11 m/s across it, under 1e-12 m/s against the free path; a checkpoint before and on the crossing continues to the same hash |
| Two vessels 100 m apart at 30 AU: relative velocity noise under 1 mm/s over 10 minutes | **Met**: 8.8e-14 m/s |
| A two-island merge is independent of arrival order | **Met** |
| Predict mode: 1,000 seeded runs | **Met** |
| Measured: step cost per regime | 2.5 us integrated in low orbit, 2.9 us coasting attended, 3.1 / 3.5 us at 30 AU (the audit: 2.6-14.5 us); contact regimes not re-measured (first builder's numbers) |
| Measured: armed-tier cost | 0.20 us per member per tick in low orbit, 0.32 us at 30 AU (first builder's numbers) |
| Measured: snapshot build for 64 vessels, relevance cut 10 (budget 1.0 ms) | **0.45 ms** (64 capsules of 5 parts), **0.62 ms** (64 whole lunar stacks of 42 parts); worst 1.0 / 1.2 ms (`tests/unit/sim-world/snapshotCost.test.ts`). `World` passes no cut (one pilot, a handful of vessels) |
| Measured: island codec | 4.6 kB for two vessels; encode 0.22 ms, decode 0.19 ms, hash 0.05 ms |

All timings were taken with other agents' jobs running (PACKAGE_RULES 16): provisional.

## 5. What is left, in order

1. **Vessel and port targets in the view** (brief D; request solar-system-sim-1 item 5). Nothing of it is
   built: `PlayerCommands.setTarget` still refuses a vessel or a port, `setSasMode` the three target modes,
   `setNavballMode` 'target'; `Readouts.target` is filled for a body only, `.docking` is null,
   `NavballMarkers.relativePrograde` / `.relativeRetrograde` are null. Where it goes: the target is
   `Planning` state (a `TargetRef` beside `targetBodyId`); `buildReadouts` / `buildSnapshot` call
   `vesselTargetReadout`, `navballTargetVectors` and `computeNavball({ relativeVelocity })` of
   `src/sim/nav/target.ts` with the two `ViewVessel`s of the `SnapshotSource` (the second vessel is in
   `source.vessels`; both states in BCI of their bodies); `PilotSeat.sendHold` sends the direction to the
   target (or away from it, or the port axis from `dockFace` of `src/sim/vessel/dock.ts`) as `sasHold` for
   the modes `target`, `antiTarget`, `portAlign` (the island already holds `seat.sasHold` for them);
   `Planning.sasModesAvailable` offers them while a vessel or port is targeted; the docking instrument
   needs the two port frames. No island change is needed.
2. The view over an island with a reference orbit: `viewOfMember` hands the view the member's `Vessel`
   whose `r`, `v` are OFFSETS there; the snapshot builders read them as BCI. Nothing reaches this with the
   shipped library; on the staged one a host must give the view BCI states (`stateOf`).
3. `IslandImpl.recordOps` into the `Island` interface; a pose-only correction if netcode-client asks.
4. Dropping the reference orbit near a surface (the root star has none that a vessel survives).
5. The rule fields of request island-core-2 (the constants of 1.2), once the lead has added them.

## 6. Formation by the join distance (lead decision on request island-core-1)

`World.form()`: the island is what hangs together with the pilot's vessel (`Island.linkedTo`: members
linked one to the next by less than `islandPartFactor` times the pair's join distance); a vessel outside
joins inside the join distance of any member (`FarSet.joinInto`); a member with something burning or
pending stays. The 25 / 27 km constants are gone.

**Golden: `f0c0855ea40d8c59`** (it was `f6efbe54f52a40de`); 596,933 steps, 65,670 rails advances, 214,908
control ticks and the end tick are unchanged.

**(a) Every attended vessel is EXACTLY equal before and after.**
- `record-mission-baseline.ts --exact ...formation-after.json --reference ...armed-after.json`: "EXACT: all
  17 milestones equal" (every field of every milestone; the step count).
- `vesselRecord.ts --compare` (every vessel of the snapshot at the guard's 400 control ticks, float64 bit
  patterns, flown before and after): the one vessel that is ever attended, `meridian-lunar`, has 400 samples
  in both and 0 differ (body, r, v, q, mass); sample ticks and the active vessel at each are equal.

**(b) Every unattended piece** (before = the tree at `f6efbe54f52a40de`; "ulp" = units in the last place;
fates are after minus before; the last column is against the PINNED guard, judged at 2 s and 500 m):

| Vessel | Samples in both / differing | Largest difference in flight | Fate, after - before | Against the pinned guard |
|---|---|---|---|---|
| Launch clamps (`~clamp-1`, the guard's "first shed vessel") | 395 / 5 (samples 7 to 11: control ticks 2806, 3367, 3928, 4183, 4489) | 8 / 5 / 17 ulp in r / v / q (5.3e-9 m, 3.6e-13 m/s) | survives, landed on Earth, same place | **bit-exact check fails from sample 7** (2 ulp in r[0]); as a survivor 0.000 m |
| Meridian M-1 (`~interstage-1`) | 24 / 20 | 1.43 km, 5.3 m/s | impact: +0.100 s, 62.0 m | inside |
| Launch escape system (`~les`) | 28 / 25 | 1.09 km, 4.1 m/s | impact: -0.008 s, 16.0 m | inside (18.2 m) |
| Fairing panel 1 (`~fairing#panel0`) | 33 / 30 | 0.98 km, 13.5 m/s | impact: +0.125 s, 240.3 m | inside |
| Fairing panel 2 (`~fairing#panel1`) | 33 / 30 | 0.98 km, 5.3 m/s | impact: +0.100 s, 493.8 m | inside, by 6 m |
| Fairing panel 3 (`~fairing#panel2`) | 33 / 30 | 1.00 km, 5.4 m/s | impact: +0.100 s, 511.9 m | **OUTSIDE: 511.9 m** |
| Fairing panel 4 (`~fairing#panel3`) | 33 / 30 | 0.99 km, 17.5 m/s | impact: +0.175 s, 242.7 m | inside |
| Meridian M-2 (`~interstage-2`) | 360 / 0 | 0 | survives in Earth orbit, equal | 0 |
| Meridian M-3 (`~payload-adapter`) | 69 / 0 | 0 | lunar impact: 0.000 s, 0.000 m | 0 |
| Heron descent stage (`~stage-separator`) | 160 / 6 (samples 244 to 249) | 10 / 13 / 66 ulp (1.3e-9 m, 3.4e-15 m/s) | survives, landed on the Moon, same place | inside (0.000 m) |
| Heron ascent stage (`~capsule-adapter`) | 12 / 5 | 1.84 km, 2.2 m/s | burned up: -8.567 s, 57,869 m | **OUTSIDE: -8.567 s, 57,949 m** |
| Lyra-A ascent engine (`~lyra-a`) | 1 / 1 | 1.84 km, 1.6 m/s | burned up: +0.267 s, 105.0 m | inside (+0.258 s, 157.7 m) |
| Kestrel apex cover (`~apex-cover`) | 11 / 3 | 0.71 km, 17.4 m/s | impact: -1.567 s, 695.8 m | **OUTSIDE: 695.8 m** |

Why: a piece now leaves the island at twice the join distance (about 2 km) instead of 27 km; from there it
is on its conic in vacuum and in the Reduced tier (a point mass, tumbling-average drag, 2 Hz) in an
atmosphere. The M-1, the escape system and the panels fall 100 km through the air in the Reduced tier; the
ascent stage and its engine enter at 11 km/s beside the capsule and are taken over during the entry (5.3 s
of flight at that speed are the 58 km); the apex cover falls under the parachutes in the Reduced tier. The
two held structures ride their body through the tick-pure expression outside the island (a few ulp).

**For the lead's records agent** (`tests/mission/trajectory-guard.json` and its pin; not edited here):
`samples[7..11].firstShed`, and the `debris` entries "Lander adapter fairing panel 3", "Heron ascent stage",
"Kestrel apex cover" (or the whole debris list from one flight of this tree: the other seven fates moved
inside the tolerance). MIGRATION_V2 principle 5 counts two re-baselines of this package: 91119ab
(`72c0893583aa427d` to `f6efbe54f52a40de`, the Armed tier) and 2e23f69 (to `f0c0855ea40d8c59`, formation).
The first builder's request named one fate: the test stopped at the first row; it now names every one.

**Expected red until then** (35 of 37): "trajectory guard: the attended craft and the launch clamps at 400
ticks are bit-identical to the recording" (the clamps, sample 7) and "trajectory guard: every piece of
debris meets its recorded fate within 2 s and 500 m" (the three rows).

## 7. Known limits and notes

- An island has ONE body: a vessel in another sphere of influence is never a member.
- The threshold watch's "probe within 2 s of the ground" bounds the descent rate by the air-relative speed.
- Blobs of operations must be raw: the host inflates a deflated `WireBlob` before `applyOp`.
- `debug.setVesselState` and `debug.setUt` rebuild the host's island (nothing in a flight does).
- The floor of a body without a surface and the rebase triggers are looked at every 4 ticks.
- `World.stats()` sums the step counters over the islands the host has replaced.

## 8. Requests

- `docs/requests/island-core-1.md`: resolved in the code by the lead's decision; the guard's re-record is
  the lead's (section 6).
- `docs/requests/island-core-2.md` (open, with the lead): rule fields for the island's constants (now also
  `REFERENCE_OFFSET_MAX`, `REFERENCE_SETTLE_DISTANCE`, `REFERENCE_SETTLE_SPEED`); a wire form for the
  velocity reference; the two re-baselines in MIGRATION_V2 principle 5.
- Against this package's paths: `solar-system-sim-1` (items 1-4 and 6 resolved; item 5 is section 5.1),
  `fleet-data-5`, `fleet-data-7` (resolved).

## 9. The golden's history through this package

`72c0893583aa427d` (post-tighten) through e1d4d18, 8edcf83, 3d50295; `f6efbe54f52a40de` since 91119ab (the
Armed tier; EXACT: 17 of 17 milestones, 596,933 steps); `f0c0855ea40d8c59` since 2e23f69 (formation by the
join distance; EXACT: 17 of 17, 596,933 steps, 400 of 400 attended samples) and unchanged through the
restructure of `World`, the three requests and the rebase triggers.

## 10. For the next packages

- **universe-directory**: build against `src/sim/island/index.ts`. `linkedTo` and `reach` are split and
  join; `FarSet` is v1's rails / reduced tiers as a host uses them (`receive`, `release`, `joinInto`);
  a passive vessel enters with its committed conic (`AddOptions.conic`); timers reach the island as `timer`
  inputs; `mergeAt` is honoured. `src/sim/world/mission.ts` and `debris.ts` are the objective observer and
  the expiry rules in the shape a single clock needed: lift them.
- **session-switch**: `World` is the model of a host: `absorb(report)` is what a host does with an
  `AdvanceReport`; `Presenter` and `PilotSeat` (src/sim/view) take any host that implements
  `PresentedHost` / `SeatHost`; `FramePacer` any `PacedClock`. The roster order and `FarObject.order` are
  what the golden depends on.
- **contact-docking**: `PairHook` and `SubstepRun` are the seam (the lockstep holds through an SOI
  crossing: tested); `IslandOp` gains `merge`, `capture`, `release`; port states follow every structure
  rebuild; the SAS target modes need only a `sasHold` (section 5.1).
- **netcode-client**: section 1.5 and 1.6; the velocity reference needs a wire form.
- **server-persistence**: `island.encode()` is `island_ckpt.state`; `islandHash` compares replays; a journal
  of `IslandInput` applied at their ticks reproduces the hash.
