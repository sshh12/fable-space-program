Status: open
From: cockpit
Owner path: src/camera/cockpitRig.ts (the seat the rig sits in), src/input/bindings.ts (a cycle-seat action), src/app/game.ts (its wiring); shared-code maintainer
Blocking: no   (the cockpit's own pictures select the seat through the layout already; the app's cockpit view does not until the rig does)

## Problem
The player's default cockpit view is to be from the pilot's centre couch, with both forward windows over the
three displays (lead decision on request cockpit-18). The first attempt changed `cameras.cockpit.seat` in the
vehicle definition; that field is inside the simulation's hashed state and the change was taken back. The
default eye point is presentation, so it now lives in the cockpit's own layout data:
`data/defs/visuals/cockpits/kestrel.json`, `"camera": { "defaultSeat": "plt" }` (validated against the mould
line's seats by `validateLayout`). The cockpit rig still takes the seat from the vehicle
(`findCockpitSeat`: `defs.vehicles[vessel.vehicleId].cameras.cockpit.seat`), so in the app the eye is at the
commander's couch again: `out/screens/cockpit/app-leo-seat.png`.

## Evidence
- `src/camera/cockpitRig.ts` lines 47-61, `findCockpitSeat`: reads the vehicle by the vessel's runtime id and
  takes `vehicle.cameras.cockpit.seat`.
- `tests/browser/cockpit/app.spec.ts` logs for every app picture which couch the rig sits in and why
  (`appSeat()`): today "the craft's own camera seat".
- The cockpit's lab and world pictures take the seat from the layout already (`labs/cockpit/main.ts`,
  `tests/browser/cockpit/world.ts`): `out/screens/cockpit/world-leo-pilot-seat.png` is the view asked for.

## Requested change
1. **The seat the rig sits in** (`src/camera/cockpitRig.ts`): in this order
   - the seat the player chose in this view (point 2), while the active vessel is the same;
   - the cockpit layout's default seat: `cockpitDefaultSeat(defs, cockpitId, fallback)` from
     `@/render/cockpit` (src/render/cockpit/layout.ts; it reads only the layout section
     `visuals/cockpits/<cockpitId>`, never a vehicle), where `cockpitId` and `fallback` are
     `CraftSnapshot.cockpit.id` and `CraftSnapshot.cockpit.cameraSeat` of the active vessel. If src/camera
     may not import a render package, the lookup is one line on the loader:
     `listSections<{ camera?: { defaultSeat?: string } }>(defs, 'visuals/cockpits/')[cockpitId]?.camera?.defaultSeat ?? fallback`;
   - the snapshot's seat (`CraftSnapshot.cockpit.cameraSeat`) when the layout names none.
   The seat's eye point and directions stay what they are today: the entry of that id in the command part's
   `command.seats` (`PartSnapshot.def`), through the part's pose. Nothing in this path needs
   `defs.vehicles[vessel.vehicleId]` any more: the part is the command part the snapshot names.
2. **A cycle-seat action**: `rig.cycleSeat()` steps to the next seat of `cockpitSeatIds(defs, cockpitId)`
   (the mould line's seats in their order: cdr, plt, ms for the Kestrel; also exported from
   `@/render/cockpit`), wraps round, and returns the look to the rest view (`restPitch`, yaw 0). Entering the
   cockpit view of another vessel starts at the default again.
   - `src/input/bindings.ts`: a new action `cockpitSeat:next` on a free key, listed with the camera keys.
   - `src/app/game.ts`, beside the `mfdCycle:*` loop (line 436): `if (a === 'cockpitSeat:next' && views.mode === 'cockpit') cockpitRig.cycleSeat();`
     (the rig instance is the one given to `createViewManager` at line 209).
3. `labs/integration/main.ts` `sitInCockpit` / `seatView` and `labs/flight-ui/main.ts` use the same rig or the
   same lookup, so their cockpit pictures show the default seat too.

## What the cockpit does meanwhile
- The layout's `camera.defaultSeat`, its validation and the two lookups (`cockpitDefaultSeat`,
  `cockpitSeatIds`) are in (`tests/unit/cockpit/geometry.test.ts` holds them, and the centre couch's line of
  sight through both forward windows and to the three displays).
- The cockpit's lab scenes, world recipes and the perf view sit in the layout's default seat.
- `tests/browser/cockpit/app.spec.ts` is aimed for either couch: it uses the pilot's aims as soon as the rig's
  source names `defaultSeat`, the commander's until then, and says which in its log.

## Acceptance
`out/screens/cockpit/app-leo-seat.png` shows the three displays under both forward windows (as
`world-leo-pilot-seat.png` does), the app spec's log says "the cockpit layout's camera.defaultSeat, read by
the rig", and the cycle-seat key moves the eye to the commander's and the specialist's couch and back.
