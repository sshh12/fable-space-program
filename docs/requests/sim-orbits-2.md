Status: resolved (commit 3d9fcae)
From: sim-orbits
Owner path: src/core/contracts/sim.ts (NavballState doc comment), src/core/fakes/fakeSim.ts (rollDeg)
Blocking: no

## Problem
`NavballState.rollDeg` has no documented sign. The real navball (src/sim/nav/navball.ts) uses the sign of the
roll control in ARCHITECTURE section 3: positive = rotation about +Y (clockwise seen from behind, dorsal
toward starboard), which is also what flight-ui's attitude indicator assumes (`ctx.rotate(-roll)` in
src/ui/mfd/mfdPainter.ts drawAdi). FakeSim computes the opposite sign:
`atan2(dot(dorsal, cross(up, nose)), ...)` = positive when the dorsal side tips to PORT. Consumers developed
against FakeSim therefore see a mirrored roll readout.

## Evidence
src/core/fakes/fakeSim.ts line ~599: `rollDeg = atan2(dot(dorsal, cross(u, nose)), dot(dorsal, reject(u, nose)))`.
With nose east and dorsal up, a +30 deg rotation about +Y gives rollDeg = -30 in FakeSim and +30 in
computeNavball (tests/unit/sim-orbits/nav.test.ts "known attitudes").

## Requested change
1. Document in sim.ts: "pitchDeg = nose elevation above the horizon; headingDeg = compass direction of the
   nose in [0, 360) (of the ventral side when the nose is vertical); rollDeg = rotation about the nose,
   positive = rotation about +Y (dorsal toward starboard, the sign of ControlInputs.roll), 0 with the dorsal
   side up".
2. FakeSim: use `atan2(dot(dorsal, cross(nose, upRef)), dot(dorsal, upRef))` with upRef = normalize(reject(up, nose)),
   i.e. negate its current value. Nothing else changes.

## Resolution
Lead. Both points.

1. `src/core/contracts/sim.ts`, `NavballState`: `pitchDeg` = nose elevation above the horizon, [-90, 90];
   `headingDeg` = compass direction of the nose in [0, 360), of the ventral side when the nose points up (of
   the dorsal side when it points down); `rollDeg` = rotation about the nose in (-180, 180], 0 with the
   dorsal side up, positive = rotation about +Y (dorsal toward starboard, the sign of `ControlInputs.roll`),
   0 when the nose is vertical. This is what `attitudeAngles` in `src/sim/nav/navball.ts` computes.
2. `src/core/fakes/fakeSim.ts` computes the three angles with the same convention (the roll sign is flipped
   relative to before; on the pad the heading is now the ventral side's, 90 deg in the pad scene, instead
   of 0). Test: `src/core/fakes/fakeSim.test.ts` "rollDeg has the sign of the roll control".
Migration: none for code that follows ARCHITECTURE section 3 (flight-ui's ADI already did); anything tuned
against FakeSim's old mirrored roll sees the sign change.
