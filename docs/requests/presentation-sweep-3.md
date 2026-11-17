Status: resolved in the contract and the simulation (lead, 2026-11-17: `StageInfo.burnLabel`, `thrustVac`, `weightFlowVac`, `actionChutes`, `chuteEnvelopes`; `CraftCockpit.crew`; `describeStages` for the fakes); the read sites are the sweep's
From: presentation-sweep
Owner path: src/core/contracts/sim.ts (`StageInfo`; the lead), src/sim/vessel/facade.ts (`stagingInfo`; the producer)
Blocking: yes for one acceptance line ("a grep test proves no file ... indexes defs.vehicles[ by a runtime id": ONE lookup remains, by design, until this is answered)

## Problem
The HUD's stage tiles, the staging and entry pages of the cockpit displays and one toast say things about a
stage and a seat that the snapshot does not state, and that the presentation therefore still reads from the
vehicle's file:
1. what a stage burns: the labels of the stage groups of the engines it ignites ("Meridian M-3"; the title
   of the active stage's tile, `stageBurnLabel`);
2. which chutes a stage deploys or releases ("separate · deploy drogues", "release drogues · deploy mains";
   `stageActionWords`), and the chute the envelope light is about with its safe and failure envelopes
   (`describeChuteEnvelope`);
3. the full-throttle acceleration of a stage where local gravity is too weak for a thrust-to-weight ratio
   (`stageAcceleration`: thrust and mass flow of the engines the stage ignites; request flight-ui-8 is why
   the session's own `twr` cannot be used there);
4. the name of the crew member in a seat ("Seat: Tobias Achterberg", `src/app/seat.ts`), where the cockpit
   layout has no label for the seat.
`StageInfo` has `label`, `icon`, `actionKinds` and the stage figures; `CraftSnapshot` has no crew names.
Dropping the four would have changed the HUD (the stage tiles are in exact reference images:
`sweep-hud-leo`, `sweep-map-translunar`, `sweep-rails-warp`, `sweep-app-pad`), so the sweep kept them and
made the lookup ONE function: `labelVehicleOf(defs, vessel, craft)` in `src/core/fakes/snapshotAccess.ts`,
keyed by the vehicle id of the craft concerned (the helm craft for the stage stack, the craft with the
cabin for a seat), used for words only, with every caller saying less when the library does not have the
design. The contract allows that use of `CraftSnapshot.vehicleId` ("for labels and icons only"), but it is
a `defs.vehicles[<runtime id>]`, and the grep test (`tests/unit/fakes/deprecated.test.ts`, still to be
written) has to list it.

## Evidence
`grep -rn "labelVehicleOf" src --include=*.ts` (two callers: `src/ui/model.ts`, `src/app/seat.ts`).
`tests/unit/flight-ui/displays.test.ts` holds the words; the craft's vehicle id is what they are looked up by.

## Requested change
Per stage in `StageInfo` (all optional until the producer fills them):
- `burnLabel?: string | null`: the labels of the stage groups of the engines the stage ignites, joined as
  the HUD shows them; null for a stage that ignites none;
- `chute?: { deploys: 'drogue' | 'main' | null; releases: 'drogue' | 'main' | null }`: what its parachute
  actions do, and for the next chute stage the envelopes of the chute it deploys (or the part key of that
  chute, from which the part definition gives them);
- `thrustVac?: number` and `massFlowVac?: number` of the engines it ignites (fixed-burn motors left out),
  so that the acceleration is `ve (1 - exp(-dv / ve)) / burnTime` without a definition.
And in `CraftSnapshot` (or the command part's module state): the crew by seat, `{ seat, name }[]`.
With these `labelVehicleOf` and its two callers' use of it go, and the grep test loses its one exception.
What must NOT change: the strings the HUD shows today for `meridian-lunar` (they are in the reference images).

## Resolution (lead, 2026-11-17): the members, and one derivation for every producer

```ts
// src/core/contracts/sim.ts, StageInfo (all optional until the tighten step)
burnLabel?: string | null;
thrustVac?: number;
weightFlowVac?: number;
actionChutes?: ('drogue' | 'main' | null)[];
chuteEnvelopes?: { safe: ParachuteEnvelope; destroy: ParachuteEnvelope } | null;

// src/core/contracts/sim.ts, CraftCockpit (CraftSnapshot.cockpit)
crew?: { seat: string; name: string }[];
```

**What each is, and what the HUD does with it** (the values are to the letter and to the bit what
`src/ui/model.ts` computed from the vehicle's file: the same iteration orders, the same sums in the same
order; `tests/unit/sim-vessel/snapshotWords.test.ts` holds the old computation against the new fields for
every stage of `meridian-lunar`):

1. `burnLabel`: what `stageBurnLabel` returned: the labels of the stage groups of the engines the stage's
   ignite actions light, each once, joined with ' + '; null for a stage that ignites none.
   `burnName: info.burnLabel ?? null`.
2. `actionChutes`: one entry per entry of `actionKinds`: for a `deployParachute` action the kind it deploys,
   for a `cutParachute` action the kind it releases (what the latest deploy before it put out, null when
   nothing was), null for every other action. `stageActionWords` becomes: for each `actionKinds[i]`,
   `deployParachute` -> `deploy ${CHUTE_NAMES[actionChutes[i]]}`; `cutParachute` -> `actionChutes[i]` ?
   `release ${CHUTE_NAMES[actionChutes[i]]}` : `ACTION_WORDS.cutparachute`; anything else ->
   `ACTION_WORDS[kind.toLowerCase()]`; each word once, joined with ' · '. (It is an array and not the
   `{ deploys, releases }` the request offered: a stage's words follow its actions in order, and this is
   exact for any stage.)
3. `chuteEnvelopes`: `safe` and `destroy` of the parachute the stage's FIRST deploy action puts out (the
   module of that kind on the first part of the vehicle, in the order of its part list, that the action
   names); null when the stage deploys none. `describeChuteEnvelope` becomes: the first stage `i >=
   staging.nextStage` that has a `deployParachute` in `actionKinds`; its kind is the `actionChutes` entry at
   that action; with `chuteEnvelopes` the long sentence, without it the short one.
4. `thrustVac`, `weightFlowVac`: of the engines the stage ignites, fixed-burn motors and engines without a
   vacuum Isp left out: the sum of `thrustVac`, N, and the sum of `thrustVac / ispVac`, N/s (the weight flow
   at standard gravity: mass flow times g0). They are the HUD's `thrust` and `flow`, so `stageAcceleration`
   keeps its arithmetic: `ve = (G0 * info.thrustVac) / info.weightFlowVac`, null unless `weightFlowVac > 0`.
   (A mass flow in kg/s, as the request offered, would have changed the order of two floating-point
   operations and with it, possibly, a last digit.)
5. `cockpit.crew`: the crew of the craft by seat, as the vehicle it was built from lists them.
   `seatName`: the layout's label, else `cabin.craft.cockpit?.crew?.find((c) => c.seat === seatId)?.name`,
   else the seat's id.

With these `labelVehicleOf` and its two callers' use of it can go.

**The producer, and the fakes.** The derivation is ONE pure function in shared code, so that a FakeSession
states what a real session states: `describeStages(vehicle, partDef)` in `src/core/defs/stageWords.ts`
returns one `StageWords` per stage (`burnLabel`, `thrustVac`, `weightFlowVac`, `actionChutes`,
`chuteEnvelopes`), from the `VehicleDef` the craft was built from and a part-definition lookup
(`(id) => defs.parts[id]`). The simulation calls it where a craft is made from its vehicle (`buildVehicle`,
the decoder: `rememberStages`) and `stagingInfo` in `src/sim/vessel/facade.ts` copies the result into every
`StageInfo`; `craftSnapshots` fills `cockpit.crew` from `craft.vehicle.crew`. In `src/core/fakes` (yours):
spread `describeStages(vehicle, (id) => defs.parts[id])[i]` into the fake's `StageInfo` of stage `i`, and
state `crew: vehicle.crew.map(...)` in the fake's `cockpit`. A fake built that way passes a conformance
test that compares these members with a real session's.

Nothing of this is state: it is derived when the snapshot is built, the codec corpus (23) and the golden
(b8221b0fd316207e) are as they were, and no definition file changed.

**What the fake's conformance test shows now** (`tests/unit/fakes/fakeSession.test.ts`, yours; it is RED in
its eight flight scenes from the lead's commit until the fake states the members, which is this request's
work order for `src/core/fakes`):
- line 174 (the snapshot without its vessels): `.staging.stages[0].burnLabel`, `.thrustVac`,
  `.weightFlowVac`, `.actionChutes`, `.chuteEnvelopes`: "only in the second" (the real session);
- line 185 (the active vessel without its parts): the craft's `cockpit.crew`, and the five members again in
  `crafts[0].staging.stages[0]`;
- line 187 (the first part): `panel` (request presentation-sweep-2).
Nothing else in the unit suite fails: 2,138 tests, 2,115 pass, 15 skipped, and these eight scenes.
