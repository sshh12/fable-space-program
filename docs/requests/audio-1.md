Status: resolved (commit 3d9fcae)
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
3. Document for `kind: 'map'` that the audio engine does not use the listener's position, orientation or
   `ambientPressure`: it places a map listener where the last outside flight camera of the active vessel
   was, in that vessel's air (`src/audio/model.ts` listenerGeometry, `data/defs/audio/mix.json`
   `propagation.mapListener` before any outside camera was seen). Reason: `src/camera/listener.ts` places a
   map listener at the map camera, 100 km or more away in vacuum, which would make the map view silent;
   with this rule the producer needs no change.
Must not change: `kind` / `mode` semantics, `insideVesselId`, the existing fields' units.

## Resolution
Lead, between the waves. All three points, as requested.

1. `src/core/contracts/audio.ts`: new REQUIRED field `AudioListener.attachedVesselId: string | null` - the
   vessel an external rig rigidly follows; null for a free or ground-fixed camera, for an interior listener
   and for the map. Producer: `buildAudioListener` (`src/camera/listener.ts`) sets it to
   `camera.focusVesselId` for a `kind: 'external'` camera, else null. Consumer: `src/audio/model.ts` couples
   the faint structure-borne share only to sources on that vessel, faded with the listener's distance from
   that vessel's bounding sphere (`propagation.attach`, values unchanged; the distance heuristic about the
   active vessel is gone). A `kind: 'map'` listener inherits the attachment of the last outside flight camera;
   the stand-in used before any outside camera was seen counts as attached to the active vessel.
2. `ambientPressure` for `kind: 'interior'` is documented as the static pressure OUTSIDE the hull.
3. The `kind: 'map'` rule (position, orientation and pressure ignored; listener placed where the last outside
   flight camera was) is documented on `positionVes`.

Migration: every code that builds an `AudioListener` literal must add `attachedVesselId` (TypeScript reports
it). In the tree: `src/camera/listener.ts` and `labs/audio/scenes.ts` (`ListenerSpec.attachedVesselId?`,
default = the active vessel for external listeners; the pad camera of `liftoff-pad` passes null).
Tests: `tests/unit/audio/model.test.ts` ("only a camera attached to the vessel hears the structure-borne
share"), `tests/unit/flight-ui/camera.test.ts` ("attachedVesselId names the vessel ..."). `kind` / `mode`
semantics, `insideVesselId` and the units are unchanged. Not changed: `propagation.attach.maxDistance` stays
250 m, so a chase camera further out than that in vacuum still hears nothing; it can be widened in
`data/defs/audio/mix.json` now that a ground camera is excluded by construction.
