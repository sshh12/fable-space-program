Status: resolved (flight-ui b90ade9; the wiring in src/app/game.ts: 732962c, not yet run in a browser)
From: app-integration-v1
Owner path: src/input/bindings.ts (the binding table and its key-help text; flight-ui)
Blocking: no

## Problem
The chase rig has `resetView()` (request app-integration-10: back to the default framing, which keeps the Earth
or the Moon in the frame, in a 1.5 s swing), and nothing a player can press calls it: once the camera has been
turned with the arrows or the mouse, the default framing is gone until another vessel becomes active. The app
cannot add the key itself: `InputFrame.pressed` and `FlightInputFrame.ui` are typed sets of the actions the
binding table knows (`ButtonAction | UiAction`), and the key-help sheet is generated from the same table
(`BUTTON_TEXT` must name every action).

## Evidence
- `src/camera/chaseRig.ts` `ChaseRig.resetView()`; `docs/handoff/core-support.md` section 9 ("a key for
  `resetView()` is the app's to add").
- `src/input/bindings.ts`: `UiAction = 'ui:keyHelp'`; the camera has axes only (`cameraYaw`, `cameraPitch`,
  `cameraZoom` on the arrows, PgUp / PgDn, numpad + / -); `Home` and `End` are unbound.
- `tests/browser/app/app.spec.ts`, "in low orbit: ...": turns the camera with ArrowUp / ArrowLeft (the rig's
  `autoAzimuth` goes false, its pitch offset non-zero), and has to call `window.__app.resetCameraView()` to get
  the default framing back (`out/screens/app/leo-chase-reset.png`).

## Requested change
A presentation action for it, like the key help (it is not a control of the vessel, so it need not enter the
`ButtonAction` contract of src/core):
1. `UiAction` gains `'ui:resetCamera'`; `DEFAULT_BINDINGS` gets `button('Home', 'ui:resetCamera')`;
   `BUTTON_TEXT['ui:resetCamera'] = { group: 'Views', text: 'Reset camera' }` (so the key-help sheet lists it next
   to the camera axes). If you would rather have it in `ButtonAction` (`'resetCamera'`, the lead's contract), say
   so in the resolution: the app's line is the same with `f.pressed`.
2. Nothing else: the app adds, next to the other presentation keys of its frame function (`src/app/game.ts`,
   where `ui:keyHelp` and `toggleHud` are handled):
   `if (f.ui.has('ui:resetCamera')) chase.resetView();`
   (in the map view the same key could later re-centre the map on the active vessel; not asked for here).

Must not change: the existing bindings; `Home` stays free of browser behaviour (the input system already cancels
the default of every bound code).

## Meanwhile
`window.__app.resetCameraView()` (specs) calls `chase.resetView()`. No key is bound.

## Resolution (flight-ui)
`src/input/bindings.ts`: `UiAction = 'ui:keyHelp' | 'ui:resetCamera' | 'ui:nextSeat'` (presentation actions, no
`ButtonAction` contract change); `DEFAULT_BINDINGS` gets `button('Home', 'ui:resetCamera')`; the key help lists it
under Views as "Reset camera" (key Home). No modifier; Home is bound to nothing else (the input system cancels its
browser default as for every bound code). Unit test: `tests/unit/flight-ui/bindings.test.ts`, "binds the
presentation actions ...".

To wire (src/app/game.ts, beside `ui:keyHelp` in the frame function):

```ts
if (f.ui.has('ui:resetCamera')) chase.resetView();
```

## Resolution (app shell)
`src/app/game.ts` (commit 732962c), beside the key help in the frame function:
`if (f.ui.has('ui:resetCamera') && views.mode === 'chase') chase.resetView();` (in the cockpit and the map the key
does nothing: a reset of a view that is not on screen would only be seen on the way back).
`window.__app.resetCameraView()` is gone; `tests/browser/app/app.spec.ts`, "in low orbit ...", turns the chase camera
with the arrows and presses Home (default framing back, the Earth in the frame). It runs with the app specs
before the mission.
