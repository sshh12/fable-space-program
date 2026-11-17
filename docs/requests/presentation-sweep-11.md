Status: open
From: presentation-sweep
Owner path: src/app/game.ts (the app-integration package)
Blocking: no

## Problem
Two findings of the review of the presentation sweep end in src/app, which the sweep's fix round does not
edit while app-integration works there.

1. Review minor 11: the camera key of the frozen start (`cameraKey`, game.ts:326-331) leaves out
   `CameraState.lensShift`. `runToRest` (cameraRest.ts) takes the rigs to their rest by comparing that key as
   text; a rig step whose only change is the lens shift (the view manager blends it, a menu view slides the
   picture aside with it) reads as "nothing changed", so a frozen page can stand with a shift that is still on
   its way, and the capture then depends on how many frames the page has drawn. The map's scene cache had the
   same omission and is fixed (src/map/controller.ts `sameCamera`, commit a776345).

2. Review minor 14, Esc. Before the sweep Esc was not bound (the browser's key: it leaves fullscreen and the
   keyboard capture) and P toggled the pause (`pause`). The sweep bound Esc and P to `flightMenu`
   (ARCHITECTURE 19, decision D3) and game.ts:512-514 answers `flightMenu` with the local pause, so Esc paused
   the flight. That is fixed in src/input with no change here (commit 7588ff2): the Esc binding is live only on
   a page that says it has a flight menu (`ServedActions.flightMenu`), so `f.pressed` carries `flightMenu` for
   P alone, as it carried `pause`. What is left in src/app is one comment now and two arguments in wave 4.

## Evidence
- game.ts:330: the joined key has mode, kind, position, orientation, fovY, exposureCompensation, minEv100,
  fillLight and `views.blending`; no `lensShift`. src/camera/viewManager.ts `mix` interpolates `lensShift`.
- game.ts:512-513, the comment "Esc / P: the flight menu ... answers the key with its local pause".
- game.ts:214 `createInputSystem(canvas, { captureKeyboard })` and game.ts:233 `keyHelpEntries(input.bindings)`:
  nothing is stated as served, which is right today (the card reads "Pause  P" and lists none of B, O, Y,
  Enter, =; the three holds against a target appear by themselves while the session lists their modes).
- `npx vitest run src/input/inputCore.test.ts tests/unit/flight-ui/bindings.test.ts` ("Esc and the flight
  menu", "the reference card lists what something serves").

## Requested change
1. game.ts:330, the shift in the key, absent = 0:
   `[..., c.fillLight, c.lensShift?.[0] ?? 0, c.lensShift?.[1] ?? 0, views.blending].join('|')`.
   What must NOT change: the rest a camera without a shift comes to (two constant fields more in every key
   change no comparison, so the reference images of today stand).
2. game.ts:512-513: the comment says P (Esc does not reach the game until the page serves the menu). No code.
3. With the shell's flight menu (wave 4): one `served: ServedActions` value, `{ flightMenu: true, actions:
   [<the deferred actions the page answers>] }` (`DEFERRED_ACTIONS` of '@/input'), handed to both
   `createInputSystem(canvas, { captureKeyboard, served })` and `keyHelpEntries(input.bindings, served)`;
   `flightMenu` then opens the menu in place of `setPaused`. Esc becomes the game's key and the card names
   the menu and the served actions from that same value.
4. `keyFor` (game.ts:219-222) returns the first binding of an action; for `flightMenu` that is Esc, which is
   not live without the menu. If a control ever shows that key before then, skip bindings with
   `requiresServed`.
