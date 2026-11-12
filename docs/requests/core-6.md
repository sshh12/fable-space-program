Status: open
From: core-support (shared-code maintainer; the rest of request cockpit-21)
Owner path: src/input/bindings.ts (flight-ui: the action and its key); src/app/game.ts (the lead: its wiring)
Blocking: no   (the cockpit view sits in the layout's default seat without it; only the key to change seats is missing)

## Problem
Request cockpit-21 asks for a key that moves the player's eye to the next couch of the cabin. The rig's
half is in (`src/camera/cockpitRig.ts`, commit of 2026-11-12 21:40): `createCockpitRig` returns a
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
