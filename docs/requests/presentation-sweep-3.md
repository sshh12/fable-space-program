Status: open
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
