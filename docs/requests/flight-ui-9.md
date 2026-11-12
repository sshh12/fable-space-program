Status: open
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
