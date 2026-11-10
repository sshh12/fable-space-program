Status: open
From: audio
Owner path: src/core/contracts/audio.ts
Blocking: no

## Problem
`AudioListener` cannot say whether an external camera is rigidly following a vessel. The brief wants a faint
structure-borne share "for an external camera attached to the vessel"; without that information the audio
engine derives it from the distance between the listener and the active vessel's bounding sphere (full
share within 60 m, none beyond 250 m, `data/defs/audio/mix.json` `propagation.attach`). A chase camera zoomed
out beyond 250 m therefore loses it, and a fixed camera within 250 m of the pad gets it. Separately, the
meaning of `ambientPressure` for an interior listener is not stated (cabin air or outside air?).

## Evidence
`src/core/contracts/audio.ts` lines 11-24 (`AudioListener`): only `kind`, `mode`, `insideVesselId`, position,
orientation and `ambientPressure`. `src/audio/model.ts` `paths()` uses `attachFactor(distanceToActive)` as the
stand-in. `labs/audio` scene `liftoff-pad` (`out/audio/liftoff-pad.wav`) shows why the range had to shrink:
with an 800 m range the pad camera 445 m away heard the structure-borne rumble 1.3 s before the airborne roar.

## Requested change
1. Add `attachedVesselId: string | null` to `AudioListener`: the vessel an external rig follows (chase rigs,
   a future EVA third-person rig tethered to the ship), `null` for a free or ground-fixed camera and for the
   map. The audio engine will then use the attach share only for that vessel (still faded with distance) and
   drop the distance heuristic.
2. Document `ambientPressure` for `kind: 'interior'` as the static pressure OUTSIDE the hull at the listener
   (what the audio engine assumes today: it scales the hull-transmitted airborne path; cabin sounds always
   have cabin air).
Must not change: `kind` / `mode` semantics, `insideVesselId`, the existing fields' units.
