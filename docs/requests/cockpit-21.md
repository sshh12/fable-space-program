Status: resolved for the rig and the labs (the seat is the cockpit layout's camera.defaultSeat, read by the rig; rig.cycleSeat(); unit-tested, not run in the browser); the key and its wiring: request core-6 (flight-ui, the lead)
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

## Resolution (shared-code maintainer, 2026-11-12 21:40): the rig's and the lab's half; the key is two other owners' (request core-6)

1. **The seat the rig sits in** (`src/camera/cockpitRig.ts`), in your order: the seat chosen with
   `cycleSeat` while the active vessel is the same; the cockpit layout's `camera.defaultSeat`; the craft's
   own camera seat. src/camera may import src/core only, so the layout is read with the loader
   (`listSections(defs, 'visuals/cockpits/')[cockpitId]?.camera?.defaultSeat`), as you offered. The command
   part and the cabin come from the snapshot's craft (`CraftSnapshot.commandPart` and `.cockpit`: the craft
   at the helm first, then the vessel's other craft with a cabin); a snapshot without craft (the FakeSim,
   hand-built ones) is still resolved through `VehicleDef.cameras.cockpit` and `VehicleDef.cockpit`,
   because `crafts` is optional in the contract until its tighten step. New exports of `@/camera`:
   `cockpitHost`, `cockpitDefaultSeatId`, `cockpitSeatOrder`, `CockpitRig`, `CockpitHost`, `CockpitSeat`;
   `findCockpitSeat(defs, vessel, seatId?)` and `resolveSeatPose(defs, vessel, seatId?)` take a seat and
   `findCockpitSeat` no longer returns the vehicle (it returns `seatId` and `cockpitId`).
2. **`rig.cycleSeat()`**: the next seat, wrapping round, the look back at the rest view (`restPitch`, yaw
   0); it returns the seat's id; `rig.seatId` is the seat of the last update. The order is the command
   part's own seats in the order of the layout's mould line where it lists them (cdr, plt, ms for the
   Kestrel), read from the layout's `mouldLine` section; I did not import `cockpitSeatIds` (the boundary
   above). Another vessel starts at its default again; taking the view again in the same vessel keeps the
   chosen seat.
   The action `cockpitSeat:next` and its wiring are not mine to write (`src/input/bindings.ts` is
   flight-ui's, `src/app/game.ts` the lead's): filed as request `core-6` with your two lines.
3. **The labs**: `labs/integration/main.ts` (`sitInCockpit`, `seatView`, the cabin's axes) takes the seat
   from the rig's `findCockpitSeat`; `labs/flight-ui/main.ts` creates the same rig and needed no change.

Checked: `tests/unit/flight-ui/camera.test.ts` (two new tests: the layout's default seat, the cycle, another
vessel, no layout; the craft path), `tests/unit/camera`, your `tests/unit/cockpit/geometry.test.ts`: 66 of
66. **Not run in the browser**: the GPU slot was more than an hour away when this went in. Your acceptance
(`app-leo-seat.png` with the three displays under both forward windows, the app spec's log line) is yours
to run; my integration seat test (`tests/browser/integration/exposure.spec.ts`, restated for the pilot's
couch earlier today) will sit in the layout's seat too.
