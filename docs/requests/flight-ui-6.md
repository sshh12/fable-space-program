Status: resolved (sim-core-v2; the commit that adds this section)
From: flight-ui
Owner path: src/sim (VesselAeroState.mach / Readouts.mach in vacuum; `VACUUM` in src/core/contracts/simInternal.ts) - shared-code maintainer / sim owner
Blocking: no (flight-ui shows "—" for Mach and angle of attack outside an atmosphere: `describeAirData`, src/ui/model.ts)

## Problem
`VACUUM.speedOfSound` is 275 m/s, and the integrator and the reduced model compute `mach = speed / speedOfSound`
for every sample, so above the atmosphere's simTop and on airless bodies the sim reports Mach = speed / 275:
M 37.8 in a 300 km parking orbit, M 26.8 at 184 km, M 4 at the Moon (`out/screens/mission/05-stage-sep-2-chase.png`,
`07-tli-complete-chase.png`, `08-moon-soi-enter-chase.png`, all from the HUD before its fix). The HUD showed it as
a reading; other consumers may too: `src/render/cockpit/feature.ts` (line ~478) shakes the cabin by a Gaussian in
`vessel.aero.mach` around its buffet Mach, which a lunar descent passes through at about 275 m/s with no air at all;
`src/audio/model.ts` derives a sound speed from it.

## Evidence
`src/core/contracts/simInternal.ts` line 26: `VACUUM = { density: 0, pressure: 0, temperature: 4, speedOfSound: 275 }`;
`src/sim/dynamics/integrator.ts` line 214 and `src/sim/dynamics/reduced.ts` line 96.

## Requested change
Either report `mach = 0` where the density is 0 (and check the audio model's `localSoundSpeed`, which divides by it),
or document on `VesselAeroState.mach` / `Readouts.mach` that the value is nominal outside an atmosphere and must be
gated on `density > 0` / `q > 0` by its readers (and pass that on to the cockpit's buffet). Must not change: Mach
inside the atmosphere, the chute envelope (it reads the same Mach and is only evaluated in air).

## Resolution (sim-core-v2, 2026-11-12)

What a vessel REPORTS is now 0 where there is no air: `VesselSnapshot.aero.mach`, `Readouts.mach` and the
`deployMach` of a parachute milestone go through `reportedMach(vessel)` (`src/sim/vessel/facade.ts`, exported
from `src/sim/vessel`): the model's Mach number where the air density is above 0, else 0. Above an
atmosphere's top and on an airless body the reading is therefore 0 at any speed (300 km parking orbit, lunar
orbit, translunar coast: tested).

Not changed, on purpose:
- The model's own value (`Vessel.aero.mach`, internal to `src/sim`): speed over the speed of sound of the
  atmosphere sample, which `VACUUM` also carries (275 m/s). The dynamics and the parachute envelope
  (`updateParachutes`, `nextChuteEnvelope`, `Readouts.chuteEnvelope`) are evaluated with it exactly as before
  in every regime, so a parachute armed at orbital speed above the atmosphere still reads "unsafe" (with a
  reported Mach of 0 it would have read "safe" there). `AeroRuntime.mach` says so in its comment.
- Mach inside an atmosphere, the angle of attack (geometric: nose against the air-relative velocity, also
  in vacuum), `VACUUM` in `src/core/contracts/simInternal.ts` (the lead's file).
- The trajectory: `Vessel.aero` is derived state, not hashed, and the scripted pilot reads Mach only below
  40 km. `npm run test:mission` passes with the golden hash unchanged (b850b94ea2dcc1a5).

Readers: the cockpit's buffet (a Gaussian in `vessel.aero.mach` about its buffet Mach) is now quiet in
vacuum without a gate of its own; `src/audio/mapping.ts` `localSoundSpeed` already falls back to its
propagation speed for Mach below 0.05, so a 0 divides nothing. `describeAirData` of flight-ui can keep its
own gate or drop it.

Tests: `tests/unit/sim-vessel/mach.test.ts` (0 in vacuum at 275, 1,650 and 7,700 m/s over an atmosphere and
on an airless body; the model value in air; the parachute envelope unchanged), `tests/unit/sim-world/readouts.test.ts`
(the real scenarios: 0 in lunar orbit, on the translunar coast and in the parking orbit; a real value under
the drogues).
