Status: resolved in flight-ui (commit b90ade9); the wiring in src/app/game.ts is the lead's (below)
From: core-support (shared-code maintainer; the rest of request cockpit-21)
Owner path: src/input/bindings.ts (flight-ui: the action and its key); src/app/game.ts (the lead: its wiring)
Blocking: no   (the cockpit view sits in the layout's default seat without it; only the key to change seats is missing)

## Problem
Request cockpit-21 asks for a key that moves the player's eye to the next couch of the cabin. The rig's
half is in (`src/camera/cockpitRig.ts`, b2406ef): `createCockpitRig` returns a
`CockpitRig` with `cycleSeat(): string | null` (the next seat of the active vessel's cabin in the mould
line's order, wrapping round, the look back at the rest view; the choice holds while the active vessel
stays the same) and `seatId` (the seat of the last update). Nothing calls it yet: the action and its key
are in flight-ui's binding table, the wiring is in the lead's `game.ts`.

## Requested change
1. `src/input/bindings.ts` (flight-ui): a button action `cockpitSeat:next` on a free key, listed with the
   camera keys in the help.
2. `src/app/game.ts` (the lead): keep the rig that is now created inline in the `createViewManager` call
   (line 209) in a variable, and beside the `mfdCycle:*` loop (line 436):

```ts
if (a === 'cockpitSeat:next' && views.mode === 'cockpit') cockpitRig.cycleSeat();
```

Must not change: the seat the view starts in (the cockpit layout's `camera.defaultSeat`, read by the rig).

## How to see it
`tests/unit/flight-ui/camera.test.ts`, "sits in the cockpit layout's default seat, steps through the seats
with cycleSeat ...", holds the rig's side. In the app: the key moves the eye from the pilot's couch to the
specialist's, the commander's and back (cockpit-21's acceptance).

## Resolution (flight-ui)
The action is a presentation action, not a `ButtonAction` (the contract union of src/core stays as it is):
`src/input/bindings.ts` `UiAction` gains `'ui:nextSeat'`, bound to **V** (`button('KeyV', 'ui:nextSeat')`: free, no
modifier), listed in the key help under Views as "Next couch (cockpit view)". It arrives in `FlightInputFrame.ui`
(not in `InputFrame.pressed`), so the line in the app reads the `ui` set. Unit test:
`tests/unit/flight-ui/bindings.test.ts`, "binds the presentation actions ...".

To wire (src/app/game.ts: keep the cockpit rig in a variable, then beside the `mfdCycle:*` handling):

```ts
if (f.ui.has('ui:nextSeat') && views.mode === 'cockpit') {
  const seat = cockpitRig.cycleSeat();
  if (seat !== null) hud.notify(`Seat: ${seatName(seat)}`, 'info');
}
```

The seat's name shown when it changes: the HUD's toast (`hud.notify(message, 'info')`, the same as a milestone)
is the place, not the app's status line (that one is for PAUSED and the test pilot). `seatName` is the app's lookup
of a readable name for the seat id (the cockpit layout's seat label, else the crew name of `VehicleDef.crew` for that
seat, else the id); flight-ui has no seat names of its own.
