# island-core: hand-off

Work package `island-core` (wave 4.1a, MIGRATION_V2): the island and the view builders; `World` shrinks in
place to a thin single-clock host. State after the FIX ROUND that followed the independent review of
55995c5 (second builder; last commit of the round: see `git log --oneline -- src/sim tests/mission
tests/unit/sim-island tests/unit/sim-world tools/sim`). **Open: section 5** (the Armed tier's cost, three
smaller review findings, the docking instrument). Section 0.1 answers the review finding by finding.

## 0. Where the work stands

| Step | State | Commit |
|---|---|---|
| The island, the far set, the codec; `stepVessel` options; the view; the Armed tier | done | 8edcf83 ... 91119ab |
| Formation by the join distance; `World` under 500 lines (497); SOI of an island of two; snapshot of 64; step paths on the mission | done | 2e23f69, 3976a55, 4c9a569 |
| Reference rebase at 30 km and at burn end; vessel and port targets; requests solar-system-sim-1, fleet-data-5, fleet-data-7 | done | 8e029b8, a7d53a5, 4c9a569 |
| **Fix round**: findings 1, 2, 3, 4, 5, 6, 7, 8, 9, 11, 13, 14 fixed; 10, 12, 16, 17 partly; 15 not | section 0.1 | 26d272a ... 0fd47bf |

Golden: **`27dd19a26303c181`** (section 9). `npm run test:mission`: 37 of 39; red are the two tests of the
pinned guard's UNATTENDED entries (section 6), which the lead's records agent re-records once from this
tree: the attended craft is judged at all 400 samples again and is green.

### 0.1 The review's findings

| # | Finding | State | Evidence |
|---|---|---|---|
| 1 | The view read a reference-orbit member's offsets as the Sun-centred state | **fixed** (26d272a; request solar-system-sim-4 resolved) | `ViewVessel` carries the state about the body (`r`, `v`) and the reference point (`frame`); no builder reads `vessel.r/v`; the render root is `{ kind: 'orbit' }` with an epoch and a rebase at every hand-over and new reference; no impact hint without terrain. `tests/unit/sim-world/heliocentric.test.ts` read 1.74 m from the Sun before; now under 1 m and 1 mm/s from the Earth's state plus the craft's conic, warp at the top level, a ten-day cruise sane |
| 2 | A rails advance jumped over queued inputs | **fixed** (6d74667) | `advanceTo` lands on the earliest queued tick; `nextEvent` kind `'input'`; `mustIntegrate` true while an input is due. `inputs.test.ts`: 59 m became under 1 mm between the centres of mass; the command's outcome carries its stamped tick |
| 3, 11 | Inputs of one tick in arrival order; the queue hashed in arrival order | **fixed** (6d74667) | canonical order (tick, account, sequence) among everything due, whichever arrived first; the queue is encoded sorted. Test: three feeding orders, one hash |
| 4 | A Reduced piece re-joined with a state up to 0.49 s old | **fixed** (b9f1e8d; request lead-12) | `FarSet.stateAt` for the reach test, a last step over the rest of the half second at `take`. `far.test.ts` (it joined falsely before). Golden moved; new table in section 6 |
| 5 | Two seats on one vessel broke restore-equivalence | **fixed** (6d74667) | the helm's seat alone steers and sets the hold, members in slot order; a seat on an occupied vessel is a passenger's; a helm grant deletes nobody's seat. Test: two and three seats, restored at every one of 240 ticks |
| 6 | In the star's sphere the hash depended on the order of adds | **fixed** (ce8ca73) | `frameUp`: the reference orbit is made for the member set at the first step, advance or encoding. Three orders at 1 AU and at 30 AU: equal at once and after 600 steps |
| 7 | No way to reconcile a replica after a threshold outcome | **fixed** (682195a) | `outcome` and `pose` operations, `recordOps` in the interface (1.6). 40 seeded entries: the replica has the server's hash at every tick (it diverged at the first outcome) |
| 8 | Nothing distinguished debris from a ship | **fixed** (b9f1e8d) | `isDebris`, `FarSet.protect`, `receive` refuses, a ship whose conic meets the air waits for its run (section 10). Mission test: 0 commandable vessels in the Reduced tier |
| 9 | A non-anchor member's own SOI event was discarded for ever | **fixed** (ce8ca73) | put off and examined again 600 s later; `soi.test.ts` (it ended with `railsEvent: null`) |
| 10 | The hash depends on how a tick was reached | **partly** | a sun sample taken before a hand-over inside one rails advance is taken again (6d74667); stated in 1.4 that the sequence of `step` and `advanceTo` calls with their landing ticks is journal content (`railsWarp`, an attended member's attitude). The clamp's ulp: section 6 |
| 12 | `closestApproaches` stale on a coast, one period only | **partly** (0fd47bf) | passed approaches are not shown and the first passing refreshes the list (tested on a two-hour coast). NOT done: the search over three periods |
| 13 | A structural op left an Armed member Armed | **fixed** (6d74667) | `afterStructureChange` takes it off its conic |
| 14 | `applyOp(rebase)` not the server's rebase bit for bit | **fixed** (ce8ca73) | the replica moves by its anchor's own state with the sender's expression; one that rebased itself finds its reference in place (tested: hash unchanged) |
| 15 | The Armed tier costs per tick | **NOT done** | section 5.1 |
| 16 | `data.radarAltitude` differs between records with identical state; `sampleDifference` stops at the first | **cause found, fix requested; the guard fixed** (b9f1e8d, 0fd47bf) | a band-limited terrain height truncates at the finest RESIDENT level: request island-core-3 with the measurements (313.598 m on the pinned pyramid, 313.695 m with a disc nearby). `sampleDifferences` reports every difference, the attended craft's and the first shed vessel's apart |
| 17 | Behaviour changed without being stated | **partly** | restored: the pilot's held controls go with the pilot on a switch; a stage or abort that renames the vessel repairs the lists; a vessel destroyed outright is announced (`vesselRemoved` 'lost') and has a fate. Stated as decisions (section 2, 22-23): cycling reaches island members only; rails warp is not refused for debris in the air beyond the island. NOT done: an explosion in the very tick of a hand-over is tagged with the new body |
| - | `hash()` time | measured (machine under load) | 2 vessels: 4.4 kB, encode 0.63 ms, hash 0.25 ms; 64 capsules: 139 kB, 3.7 ms, 4.2 ms; 64 whole stacks (42 parts): 490 kB, 19.6 ms, 24 ms. More than a tick: a server calls `hash()` at checkpoints and audits, off the step path; per tick it compares `checksumOf` |

## 1. The island API, exactly (`src/sim/island/index.ts`; types and doc comments in `api.ts`)

For `universe-directory`, `netcode-client`, `server-persistence`, `contact-docking` and the wire package.
Written from ARCHITECTURE 6.1, 6.2, 6.4, 7.1-7.4, 7.6 and the lead's decisions of the fix round.

### 1.1 Functions

```ts
createIsland(deps: IslandDeps, init: IslandInit): Island
decodeIsland(deps: IslandDeps, bytes: Uint8Array, options?: { mode?: StepMode }): Island
islandHash(bytes: Uint8Array): string                    // 16 hex digits; every byte but the header and the names

interface IslandDeps { defs: DefLibrary; system: BodySystem; terrain: TerrainProvider; rules: UniverseRules;
                       resolver?: DefResolver; policy?: TerrainPolicy }      // not state
interface IslandInit { id: string; tick: number; bodyId: string; mode?: StepMode; rate?: number }
type StepMode = 'authoritative' | 'predict'
```

### 1.2 `Island`

```ts
readonly id: string
readonly tick: number                       // every member's state is the state at this tick
readonly ut: number                         // tick / 120
readonly bodyId: string                     // SOI body of the island's frame
readonly reference: ReferenceOrbit | null   // { r0, v0, tick }: set = members' own r, v are OFFSETS from it
readonly mode: StepMode
readonly members: readonly IslandMember[]   // slot order = vessel id order (code units)
readonly anchorId: string | null            // lowest attended id, else lowest id
readonly rate: number
readonly mergeTick: number | null
readonly counters: Readonly<IslandCounters> // steps, railsAdvances, freeSteps, probeSubsteps, pairSubsteps, armedTests
recordOps: boolean                          // journal split, destroy and outcome operations of the steps (not state)

member(vesselId: string): IslandMember | null
add(vessel: Vessel, options?: AddOptions): IslandMember     // vessel given in BCI of bodyId at the tick
remove(vesselId: string, reason?: 'left' | 'removed'): Vessel | null   // returned in BCI
settle(vesselId: string): void
refreshMargins(): void

step(): AdvanceReport                       // one tick; throws at a pending merge tick
advanceTo(tick: number): AdvanceReport      // rails advance; lands on the earliest of: tick, an island event, a queued input, the merge tick
mustIntegrate(): boolean                    // also true while a queued input is due
nextEvent(): IslandEvent | null             // 'atmosphere' | 'impact' of a member on a conic, or 'input' (a queued input's tick)

applyInput(input: IslandInput): InputReceipt
applyOp(op: IslandOp): IslandOpChecksum | null              // throws IslandOpError
checksumOf(vesselId: string): IslandOpChecksum | null

encode(options?: { names?: boolean }): Uint8Array
hash(): string

tierOf(vesselId: string): MemberTier | null
stateOf(vesselId: string): { r: Vec3; v: Vec3 } | null      // VES origin in BCI, whatever the frame
seatOf(accountId: string): { vesselId; controls; sasHold: Vec3 | null; reference: 'surface' | 'orbit'; latchOpenTick: number | null } | null
environmentOf(vesselId: string): VesselEnvironment | null
reach(point: { r: Vec3; v: Vec3; radius: number }, exceptId?: string): Reach
linkedTo(vesselId: string): ReadonlySet<string>
thresholdWatch(): boolean
terrainPending(): Promise<void> | null
terrainFinalUnder(vesselId: string): boolean
hintImpact(vesselId: string, point: { bodyId: string; latitude: number; longitude: number } | null): void   // dropped for a body without terrain

setPairHook(hook: PairHook): void
readonly nascentPairs: readonly PairRef[]; readonly clearingPairs: readonly ClearingPair[]; readonly captures: readonly CaptureConstraint[]
setNascent(pair: PairRef, on: boolean): void
setClearing(pair: ClearingPair | PairRef, on: boolean): void
setCapture(constraint: CaptureConstraint | PairRef, on: boolean): void
```

`IslandMember`: `vessel`, `slot`, `mode` ('landed' | 'rails' | 'armed' | 'integrated'), `tier`, `orbit`,
`railsEvent`, `pilot` (the HELM: the one account whose seat steers), `attended` (some account is seated),
`bornTick`, `revision`, `controllable`, `thresholdWatch`, `terrainRegime`, `previous`, `trackHold`,
`admittedFromHead`, `reservation`. `AddOptions { bornTick?, pilot?, attended?, conic?, revision?,
admittedFromHead? }`. `Reach { distance, closingSpeed, joinDistance, joins, parted, tau, vesselId }`.
`AdvanceReport { events, ops: AppliedOp[], commands, departures, arrivals, replan, incompleteTerrain,
frameChange }`; `AppliedOp { tick, body: IslandOp, checksum }`. `PairHook { regime; solve }`.

### 1.3 Inputs (`IslandInput`, each stamped `{ tick, accountId, seq }`)

`controls { vesselId, controls, sasHold }`, `reference { vesselId, reference: 'surface' | 'orbit' }`,
`command { vesselId, command: IslandCommand }` (stage, abort, sas, sasMode, rcs, legs, lights,
fineControl), `seat { vesselId, aboard }`, `helm { vesselId, pilot, craftId, controlPartKey }`,
`add { vessel, bornTick, admittedFromHead }`, `remove { vesselId, reason }`, `reservation`, `destruct`,
`timer` (socketLost, socketBack, latchEnd, deadManRotation, deadManThrottle, graceEnd), `rate`, `mergeAt`.

- **When.** An input stamped for a later tick is queued and applied AT that tick, at the start of the step
  of that tick; a rails advance lands there. One stamped for the island's tick or earlier is applied at
  once, at the island's tick, TOGETHER with whatever is still queued for that tick, all in the canonical
  order (tick, account id, sequence). `InputReceipt.appliedTick` is true in both cases. The outcome of a
  queued command is in `AdvanceReport.commands` of the advance that applied it; of an immediate one in the
  receipt.
- **Seats and the helm.** Several accounts may hold a seat in one vessel. `seat { aboard: true }` seats the
  account; it takes the helm only when the helm is vacant. `helm` grants it (and seats the account if it
  was not); nobody's seat is deleted by it. Only the helm's seat sets the SAS hold and feeds controls;
  `controls`, `reference` and `command` of any other account are refused ('Not at the helm'), and of
  anybody on a vessel without command authority ('No command authority').

### 1.4 Operations (`IslandOp`; the wire's `IslandOpBody` for the first six, and two that the wire must add)

Vessels by SLOT at the operation's tick, parts by index in `Vessel.parts`.

```ts
{ op: 'split';   slot: number; cutJoints: number[]; newVesselIds: string[] }
{ op: 'destroy'; slot: number; parts: number[]; cause: 'impact' | 'overheat' | 'overstress' | 'explosion' | 'collision' }
{ op: 'add';     vesselId: string; vessel: WireBlob }
{ op: 'remove';  slot: number; reason: 'left' | 'destroyed' | 'removed' }
{ op: 'rebase';  anchor: number; bodyId: string; r: Vec3; v: Vec3 }     // the new reference point: the anchor's centre of mass, BCI, float64
{ op: 'replace'; slot: number; vessel: WireBlob }
// NEW (src/sim/island/api.ts `OutcomeOp`, `PoseOp`; not in src/core/contracts/net.ts yet):
{ op: 'outcome'; slot: number; outcomes: ThresholdOutcome[]; member: Uint8Array }
{ op: 'pose';    slot: number; r: Vec3; v: Vec3; q: Quat; w: Vec3 }
type ThresholdOutcome = 'partDestroyed' | 'jointBroken' | 'crewLost' | 'chuteFailed' | 'touchdown' | 'splash' | 'splashed' | 'asleep' | 'awake'
```

- **`outcome`** (lead decision, finding 7). With `recordOps` the authoritative island journals, per step,
  first the `destroy` and `split` operations it executed, then ONE `outcome` for every member that had a
  threshold outcome in the step and still exists, and one (with `outcomes: []`) for every vessel such a
  step brought into being, in slot order. `outcomes` lists what happened, each kind once, in the order of
  `ThresholdOutcome`. `member` is the member in the island codec's own form (`encodeMember`: the vessel
  without labels and the island's items about it: mode, attended, pilot, born tick, revision, watch and
  regime flags, coast time, conic and its event), raw bytes, AS IT IS AFTER THE WHOLE STEP. A replica in
  predict mode holds at its limits as before and applies the operations of a step after its own step of
  that tick, in order (skipping an operation its own step also reported: a command's split): it then has
  the server's `hash()` at every tick (tested). The operations of a step carry the tick the step BEGAN at.
- **`pose`**: position and velocity of the member's VES origin IN THE ISLAND'S FRAME (the member vessel's
  own `r`, `v`: BCI of the island's body, or the offset from the reference point), attitude (unit
  quaternion, VES to inertial axes) and body rates (VES axes, rad/s), float64. Accepted within
  `POSE_CORRECTION_MAX_DISTANCE` (100 m), `_SPEED` (10 m/s), `_ANGLE` (0.2 rad), `_RATE` (1 rad/s) of the
  member's state; beyond them `IslandOpError` ('bound') and the sender sends `replace` (or `outcome`). A
  member on a conic whose position or velocity it changes is integrated from there; for a member on a conic
  the exact correction is the member blob.
- An operation applied on a control tick has the island derive its armed margins, overlapping pairs and
  watch flags again. Blobs are raw: the host inflates a `WireBlob`.
- `rebase` on a replica: one that rebased by the same rule at that tick finds its reference in place and
  moves nothing; otherwise it moves by its anchor's own state, the sender's expression.

### 1.5 Invariants

1. **State at a tick is a function of the tick, the vessels and the island's own items** (what `encode`
   writes): no clock base, no phase of the control tick (`tick % 4`), of the sun sample (`tick % 12`; an
   Armed member's `tick % 120`) or of the armed test (`tick % 12`).
2. **Order**: members by vessel id; inputs by (tick, account id, sequence); operations in the order given;
   vessels a step brings into being are stepped once in that tick, after the members.
3. **One frame**: BCI of `bodyId`, or offsets from `reference`. `add` takes and `remove`, `Departure.vessel`
   and `stateOf` give BCI. The island changes frame as a unit; `AdvanceReport.frameChange` says so. A
   member that is not the anchor never crosses a sphere of influence by itself: its own crossing is put off
   and its conic examined again 600 s later.
4. **An island of one with no reference orbit is v1's `stepVessel` on the tick grid, bit for bit**, and takes
   the sub-stepped path only where v1 did (asserted on the mission).
5. **A pair in the contact regime sub-steps together**, through an SOI hand-over too.
6. **`Vessel.age` = (tick - bornTick) / 120**; `controllable` is command authority and follows parts and crew.
7. **Never past a pending merge tick, never past a queued input.**
8. **The reference orbit** (only in the sphere of influence of the root star) is made FOR THE MEMBER SET, at
   the anchor's centre of mass, before the first step, rails advance or encoding after the island has
   members (not at the first vessel added), and replaced, as a `rebase` operation with a frame change, when
   the anchor changes, at a hand-over into the star's sphere, when the anchor is 30 km from it, and when
   the anchor has finished a burn (it coasts off the reference orbit by more than 1 m or 1 mm/s: read off
   the state).

### 1.6 What is deterministic, and under which inputs

Given the same `IslandDeps` content (definitions by `defsHash`, the rules, the body library, the same
terrain data level under every contact step), the same starting bytes and THE SAME SEQUENCE OF CALLS
(`applyInput`, `applyOp`, `add`, `remove`, `settle`, and each `step` and `advanceTo` with the tick it landed
on: that sequence is journal content), two islands have the same `hash()` at every tick. Within that:
the order in which inputs of one tick ARRIVE does not matter, nor the order in which vessels are added
before the first advance, nor whether the island was restored from its codec at any tick (tested: every
tick for 240 ticks with two and three seats; through an SOI crossing in the contact regime; in a burn at
30 AU; a replay of an input list; 40 entries with outcomes against a predicting replica). NOT covered by
the hash: names, `counters`, `recordOps`, `IslandMember.previous`, terrain requests and hints. NOT
guaranteed equal: stepping across ticks that another run coasts across on rails (an attended member's
attitude is integrated while it coasts and a slow residual turn is stopped by a rails advance; the centres
of mass agree: under 1 mm after a burn and 48 s), and the same flight on other terrain data levels.
Not a function of the state today: a band-limited terrain height above the terrain regime (request
island-core-3): it reaches `radarAltitude` read-outs and the terrain-regime flag, not the vessel states of
the golden flight.

### 1.7 `mode: 'predict'` may and may not

May: everything a command or a control input causes, the SOI hand-over, the rebase, rails and Armed
transitions, `applyOp` of the server's operations. May not, and does not: destroy a part (heat, impact,
burial, the floor of a body without a surface), collapse a leg, break a joint, lose the crew, fail a chute,
emit `touchdown` or `splash`, confirm a splashdown, put a vessel to sleep. It receives each of those as an
operation (1.4). 1,000 seeded runs: no threshold event in predict.

### 1.8 What the wire layer carries of it (docs/handoff/wire-protocol.md)

| Wire | Island |
|---|---|
| `IslandEnterMessage.state`, `.members`, `.tick` | `island.encode()` (inflate before `decodeIsland`), member ids in slot order, `island.tick` |
| `IslandOpMessage.body`, `.checksum`, `.tick` | `AppliedOp` of `AdvanceReport.ops` / `InputReceipt.report.ops` with `recordOps` set. **The wire must add `outcome` and `pose`** (1.4; request island-core-2) |
| `IslandKeyMessage` / `IslandDeltaMessage` (pose by slot) | `stateOf(id)` and the member vessel's `q`, `w`; a replica is corrected by `pose` inside its bounds, else by `outcome` / `replace` |
| `InputSample` | `applyInput({ kind: 'controls', tick: applyTick, ... })`; `InputReceipt.appliedTick` is `InputAck` |
| `WireCommand` of the seat | `applyInput({ kind: 'command', ... })`; `CommandOutcome` |
| (none) | the velocity reference (`kind: 'reference'`): no wire form yet (request island-core-2) |

Island codec: `FSPI`, u16 version (1), defsHash, island id, the body as one block (tick, body, rate, merge
tick, rails-warp flag, reference orbit, members, anchor, nascent pairs, U5 pairs, capture slots, seats sorted
by account, queued inputs in the canonical order), the names block.

## 2. Decisions (each with its reason)

1-21 stand as in the history of this file (types-only `api.ts`; operations are data; the hand-over is one
instant for the whole island; the lockstep is nested calls; the Armed tier places a member on its conic
every tick; the predict list; what `World` under 500 lines moved and where: `Presenter` and `PilotSeat` in
the view, `linkedTo` and the far set's transfers in the island, `mission.ts`, `debris.ts`, `pacing.ts`,
`start.ts` beside the host; controllable is command authority; the floor of a body without a surface; the
three-period encounter search in the view). New in the fix round:

22. **Cycling reaches the vessels of the pilot's island only** (about 2 km; v1: the 27 km bubble). A vessel
    outside it is in the far set, where nothing can be flown; the universe attaches a pilot to any vessel.
23. **Rails warp is not refused for debris in the air beyond the island**: it is in the Reduced tier, which
    a rails advance steps in whole half seconds. (v1 refused because such debris was in the bubble.)
24. **The Reduced tier is for debris only** (lead decision): `isDebris` (no command authority, nobody aboard,
    no open chute, no docked craft) and what the host protects. `World`, which has ONE island, lets the
    Reduced tier fly a ship about ANOTHER body than its island's that meets the air unattended
    (`FarOptions.reduceUnhosted`): the one case left, and it ends with `World`.
25. **A threshold outcome's operation carries the member, not a field per outcome**: what a replica held at
    a limit (a temperature, a stress, a dose, a canopy load) differs from the server's in continuous state,
    so only the member's state makes the two equal to the bit; the operation names the outcomes for the
    journal and the UI.
26. **The view's vessel state is the state about the body**; the render root in the star's sphere is the
    reference-orbit point, so a member's offset is its ROOT position and nothing near the craft is a
    difference of two astronomical units.
27. **A reference orbit is made lazily for the member set** (invariant 8): `island.reference` is null between
    the adds and the first step, advance or encoding.

## 3. How to run and verify

- `node tools/dev/heavy.mjs --class=cpu -- npm run test:mission`: 37 of 39 at `27dd19a26303c181`, 596,933
  steps, 88 s.
- `node tools/dev/heavy.mjs --class=cpu -- npx vitest run src/sim src/pilot tests/unit/sim-island
  tests/unit/sim-world tests/unit/sim-vessel`: 412 of 412.
- The proofs of the golden: `npx tsx tools/sim/vesselRecord.ts --compare <before> <after>` (every vessel at
  the guard's 400 control ticks; exit 1 when an attended sample differs) and `npx tsx
  tools/dev/record-mission-baseline.ts --exact tests/mission/rebaseline/2026-11-25-reduced-after.json
  --reference tests/mission/rebaseline/2026-11-24-formation-after.json` (1 of 17 milestones differs, in
  `LUNAR_ORBIT.data.radarAltitude` alone: finding 16).
- `npx vitest run tools/dev/boundaries.test.ts`; `node tools/dev/check-stubs.mjs`.

## 4. The brief's acceptance lines

| Line | Result |
|---|---|
| An island of one equals `stepVessel` on the tick-grid World bit for bit; debris by fate | **Met for the attended craft and the six fixtures** (400 of 400 guard samples, green in the mission). Debris: section 6 |
| A counter proves it never takes the sub-stepped path where v1 would not | **Met** on the mission (0) |
| Two craft 20 m apart, low orbit and 30 AU, across the pair-regime boundary: under 0.1 mm/s, same tick | **Met**: 3.5e-10 m/s, 4.3e-28 m/s |
| Island codec: checkpoint at a staging tick, a U5 pair, an occupied slot: 6,000 steps; replay of an input list | **Met**; restored at every tick with several seats; queue order not hashed |
| SimSnapshot from the view equals the wave-3 World's on 200 recorded states | **Met** but for the `patches` block of 12 states of `qa-translunar` (the three-period encounter search, by design, stated in the test) |
| `npm run test:mission` on the shrunk World under 5 minutes, zero incomplete terrain queries | **37 of 39**, 88 s; red: the pinned guard's clamps and debris entries |
| World is under 500 lines and contains no physics | **Met**: 497 lines |
| An island crossing an SOI boundary keeps relative positions to 1 um, an Armed member included | **Met**: 1.5e-11 m; a pair in the contact regime 3e-12 m, lockstep kept |
| Two vessels 100 m apart at 30 AU: under 1 mm/s over 10 minutes | **Met**: 8.8e-14 m/s |
| A two-island merge is independent of arrival order | **Met**, now at 1 AU and 30 AU too (it was not: finding 6) |
| Predict mode: 1,000 seeded runs | **Met**; and with the operations a replica is the server at every tick |
| Measured: step cost per regime; armed-tier cost | 2.5-3.5 us per vessel step; **Armed 0.20 us per member per TICK: over the line of ARCHITECTURE 6.2** (finding 15, open) |
| Measured: snapshot of 64 vessels, cut 10 (1.0 ms) | 0.45 ms (5-part vessels), 0.62 ms (42-part) |
| Measured: island codec | section 0.1, last row |

Timings were taken with other agents' jobs running (PACKAGE_RULES 16): provisional.

## 5. What is left, in order

1. **Finding 15: an Armed member must cost nothing per tick.** Today `stepArmed` places every Armed member
   on its conic every tick (one Kepler evaluation, 0.2 us) and `refreshMargins` tests every pair with an
   Armed member every 12 ticks (quadratic). To build: the member's vessel state is NOT kept current (the
   host and the view ask `stateOf`, which evaluates the conic on demand: `Presenter` already reads through
   `ViewVessel.r`, `v`); its wake-ups are events of the island (`nextEvent`: the air, the ground, an SOI
   edge, once each, as the rails events are now), and proximity is the time of closest approach of two
   conics against the armed margin (`chainClosestApproaches` of `src/sim/orbit`, or a spatial index over
   conics), computed when a member becomes Armed and again when a neighbour's conic changes (its
   `revision`), with integrated neighbours tested at the control tick against the conic's evaluated state.
   Measure with 1,000 and 10,000 coasting members. Nothing of it is started; the golden will move for the
   unattended pieces again (an Armed member's `Vessel.r` is hashed by the session), with the attended
   craft to be proven exact as before.
2. **Finding 12, the rest**: closest approaches searched over three periods (`chainClosestApproaches`
   takes a horizon; the target's forecast chain must be predicted as far).
3. **Finding 17, the rest**: an explosion in the tick of a hand-over is tagged with the island's new body
   (`World.absorb` gives the events of a report one body; the report would have to say which events precede
   the hand-over).
4. **Finding 16**: request island-core-3 (the terrain provider); then clamp or slot the band-limited
   queries in `IslandEnv.terrainHeight` and `probeClearance`. `probeClearance` and `FlightRecord
   .touchdownData` / `.chuteDeployData` still read `vessel.r` (near a surface there is no reference orbit).
5. **The docking instrument, `Readouts.docking`**: null for every target. It must share one envelope
   measurement with contact-docking's capture test (`DockingPortModuleDef.capture`; the geometry is
   `targetGeometry` of `src/sim/view/target.ts`, the roll reference `linkRoll`).
6. The rule fields and wire forms of request island-core-2 (now also the pose bounds, `SOI_RECHECK_TIME`,
   and the two new operations).

## 6. The trajectory guard: what the records agent re-records

Formation by the join distance (2e23f69, lead decision) and the Reduced tier at the tick (b9f1e8d, request
lead-12) changed what becomes of UNATTENDED pieces. **The attended craft is equal to the pinned guard at
400 of 400 samples** (its own test in the mission, green) and, flight against flight,
`vesselRecord.ts --compare` shows 0 of 400 samples differing across each change.

Against the PINNED guard (2 s, 500 m), this tree (`27dd19a26303c181`):

| Vessel | Fate against the guard | |
|---|---|---|
| Launch clamps (`samples[].firstShed`) | samples 7 to 11 (control ticks 2806, 3367, 3928, 4183, 4489) differ by up to 8 / 5 / 17 ulp in r / v / q | **re-record**: a held vessel rides its body by `rideBody(vessel, env, dt)` inside the island (orientation at the step's start turned by spin x dt) and by `rideBody(..., 0)` outside it (orientation at the tick); it now leaves the island 33 s after lift-off |
| Meridian M-1 | +0.100 s, 62.0 m | inside |
| Launch escape system | -0.008 s, 18.2 m | inside |
| Fairing panel 1 / 2 / 4 | +0.125 s, 240.3 m / +0.100 s, 493.8 m / +0.175 s, 242.7 m | inside |
| Fairing panel 3 | +0.100 s, **511.9 m** | **outside: re-record** |
| Meridian M-2, M-3, Heron descent stage | 0 | inside |
| Heron ascent stage | **-28.633 s, 262,856 m** (burned up at T+679,501.1 s) | **outside: re-record**. It stays in the Reduced tier from the top of the air on (it re-joined the island 20 ticks old before the fix and broke up there): against the flight before the fix -20.067 s, 205,129 m |
| Lyra-A ascent engine | **no such fate** | **remove the row**: it came into being only because the ascent stage broke up in the Full tier; 9 fates now, the guard has 10 |
| Kestrel apex cover | -1.567 s, **695.8 m** | **outside: re-record** |

Flight against flight across the Reduced-tier fix (b9f1e8d), every other piece is EXACTLY as it was (0
samples differing, fates 0.000 s and 0.000 m): only the ascent stage moved and the engine went.
MIGRATION_V2 principle 5 counts three re-baselines of this package: 91119ab (`72c0893583aa427d` to
`f6efbe54f52a40de`), 2e23f69 (to `f0c0855ea40d8c59`), b9f1e8d (to `27dd19a26303c181`). Finding 15 will
be a fourth.

## 7. Known limits and notes

- An island has ONE body. `World` has ONE island (decision 24).
- A waiting vessel (no debris, at the top of the air) stands at its entry state until its host takes it;
  `FarSet.nextRunTick` lets a rails advance land there, `step` / `advanceTo` with the island take it.
- The floor of a body without a surface, the rebase triggers and formation are looked at every 4 ticks.
- The threshold watch's "probe within 2 s of the ground" bounds the descent rate by the air-relative speed.
- An immediate `helm` input's `helmChanged` event is pushed into a report that the next advance replaces.
- `hash()` is not for the step path (section 0.1, last row).

## 8. Requests

- `island-core-1`: resolved in the code; `lead-12`: fixed in b9f1e8d (its file is the lead's to close).
- `island-core-2` (open, with the lead): rule fields for the island's constants, a wire form for the
  velocity reference, and since the fix round the wire forms of `outcome` and `pose` and their bounds.
- `island-core-3` (open, terrain): band-limited heights that do not depend on the cache.
- Against this package's paths, resolved: `solar-system-sim-1`, `solar-system-sim-4`, `fleet-data-5`,
  `fleet-data-7`.

## 9. The golden's history through this package

`72c0893583aa427d` (post-tighten); `f6efbe54f52a40de` since 91119ab (the Armed tier); `f0c0855ea40d8c59`
since 2e23f69 (formation by the join distance); **`27dd19a26303c181` since b9f1e8d** (a Reduced piece at
the tick; debris only), unchanged through every other fix of the round. Each on the proof that the
attended craft is exactly equal: 400 of 400 samples every time; 17 of 17 milestones EXACT for the first
two, and for the third 17 of 17 in every field but `LUNAR_ORBIT.data.radarAltitude` (104688.159 against
104688.063: the read-out of finding 16, already different at 55995c5 as the review measured).

## 10. For the next packages

- **universe-directory**. What the far set may be handed and what needs a run: `FarSet.receive` takes a
  member that is held on its body, any member in vacuum (it coasts on its conic: passive), and DEBRIS in
  the air (the Reduced tier). It REFUSES a free vessel in the air that is no debris (`isDebris` false, or
  `protect` true): that vessel stays in an island and runs unattended at full fidelity. A vessel on rails
  that is no debris and whose conic meets the air must be given an island at `nextRunTick()` (the far set
  holds it at its entry state, `FarObject.waiting`, and says so: `FarSink.needsRun`); set `protect` for
  every vessel a session targets, has selected, is docked to or owns a seat or session on. Leave
  `reduceUnhosted` unset. Formation is `linkedTo` (who has parted) and `joinInto` / `reach` (who joins);
  compare a Reduced piece through `stateAt`. `mergeAt` and queued inputs are honoured by `advanceTo`.
- **session-switch**: `World` is the model of a host; `Presenter` takes a `PresentedHost`, `PilotSeat` a
  `SeatHost`, `FramePacer` a `PacedClock`. The view reads `ViewVessel.r`, `v`, never the vessel's own.
- **contact-docking**: `PairHook` and `SubstepRun`; `IslandOp` gains `merge`, `capture`, `release`; the
  docking instrument (5.5); a collision's outcomes are `outcome` operations like the others.
- **netcode-client**: 1.4, 1.7, 1.8: apply the operations of a step after the replica's own step of that
  tick; `pose` inside its bounds, else the member blob; skip an operation the replica's own step reported.
- **server-persistence**: `island.encode()` is `island_ckpt.state`; the journal is the sequence of calls of
  1.6, the landing tick of every rails advance included; `hash()` off the step path.
