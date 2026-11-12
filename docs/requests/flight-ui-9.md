Status: resolved
From: flight-ui
Owner path: src/sim (sim-core-v2): the parachute envelope (`src/sim/vessel/modules/parachute.ts` `inside`, `facade.ts` `nextChuteEnvelope`), `radarAltitude` while held, the g load while held or at rest
Blocking: no (flight-ui gates the first on the HUD and the MFD meanwhile; the other two show as small jumps)

## Problem
Three readouts of the sim read wrong where the vessel is not flying through air, and the HUD shows what the sim
reports:
1. **Chute envelope without air.** `Readouts.chuteEnvelope` judges the next chute stage by altitude, Mach, speed and
   q alone, so on the Moon (q = 0, Mach 0) the drogues read SAFE, and in a 100 km lunar orbit RISKY (critique
   `docs/qa/wave2/flight-ui.r6.combined.json` finding 5; `out/screens/flight-ui/mfd-pages-hover-720p.png` before
   round 7). A parachute needs air: the light means nothing there.
2. **Radar altitude on the clamps.** `radarAltitude` returns 0 while `vessel.hold !== null`, and the true clearance
   once released: on the pad the AUTO altimeter (now radar near the ground, so a lunar landing site 1.9 km below the
   datum reads about 0 m) jumps from 0 to about 18 m at clamp release, the height of the vehicle's lowest point over
   the ground under the launch mount (finding 4: "75.0 m to 18.0 m at clamp release" with the old rule).
3. **G load on the clamps.** A vessel standing on the pad reads 0.88 g in one shot and 1.00 g in another at the same
   instant (`out/screens/app/pad-chase.png` against `app/capture-on.png`, finding 15): the settling of `holdOnGround`.

## Evidence
`src/sim/vessel/modules/parachute.ts` `inside()` (no density test); `src/sim/vessel/facade.ts` `radarAltitude`
(`if (vessel.hold !== null) return 0`); the two app pictures above.

## Requested change
1. `chuteEnvelope` (and each chute's `envelope` state) `null` / not judged where the air density is 0 (above the
   atmosphere's simTop or on a body without one). Must not change: the light inside the atmosphere, the failure rule
   for a deployed chute in air.
2. While held, `radarAltitude` = the clearance of the lowest contact probe over the terrain or sea under it (as after
   the release), so the number continues through lift-off; or document that it is 0 while held.
3. While held or at rest on a surface, `gLoad` = |local gravity| / g0 (1.00 on the pad, 0.17 on the Moon), without
   the settling transient.

## Resolution (sim-core-v2)

All three are read-outs: nothing the simulation steps with, hashes or decides by was changed. Measured on
the mission after the change: the state hash is the golden one (`b8221b0fd316207e`) and the trajectory
guard is bit-identical at 400 of 400 samples.

1. **Chute envelope without air.** `Readouts.chuteEnvelope` (`nextChuteEnvelope` in
   `src/sim/vessel/facade.ts`) is `null` where the air density AT THE VESSEL NOW is 0 (above the simulated
   atmosphere, on a body without one). It is judged by the atmosphere at the vessel's altitude, not by the
   aerodynamic state of the last integrated step, so a vessel held on the pad still has its light. Inside
   an atmosphere the light is what it was, and the failure rule of a deployed chute is untouched
   (`chuteEnvelope()` of the parachute module, which it uses, is unchanged).
   NOT done: the per-chute module state `envelope` (`ModuleState` of a parachute, a contract type that is
   `ChuteEnvelope`, not nullable) still carries the judgement in vacuum. Making it nullable is a contract
   change for the lead; the HUD and the MFD should read `Readouts.chuteEnvelope`.
2. **Radar altitude while held.** `Readouts.altitudeRadar` is now `shownRadarAltitude`: the clearance of
   the vehicle's lowest contact probe over the terrain or the sea, held or flying. On the clamps the
   clamps themselves (ground equipment) are left out, so the number is the height of the stack over the
   ground under the mount and continues through the release (measured: no step-to-step change above
   0.3 m from the pad through lift-off; before, 0 m and then the height at release). Landed at rest it is
   the clearance of the feet (under 0.5 m on the Moon in the QA scenario). The simulation's own
   `radarAltitude` (milestone triggers, the warp clamp, the data recorded with a milestone) stays 0 while
   held: a held vessel is on the ground.
3. **G load while held or at rest.** `Readouts.gLoad` and `VesselSnapshot.gLoad` show
   |local gravity| / g0 while `hold` is set (the clamps, landed at rest, asleep): 1.001 on the pad, 0.165
   on the Moon, steady from the first snapshot, without the settling transient. In flight they are the
   vessel's filtered g load as before. The vessel's own `gLoad` state and the crew's dose are not touched
   (the peak g of the mission record already ignored held vessels).

Tests: `tests/unit/sim-world/readouts.test.ts` (three new: no light in lunar orbit, on the lunar surface,
on the way to the Moon and in Earth orbit, a light on the pad and under the drogues; the pad altimeter
through the release and the pad g load; the lunar surface), `tests/unit/sim-vessel/mach.test.ts` and
`facade.test.ts` restated.
