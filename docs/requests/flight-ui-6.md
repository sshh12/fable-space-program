Status: open
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
