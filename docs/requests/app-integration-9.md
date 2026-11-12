Status: open
From: app-integration-v1
Owner path: src/ui/hud (the keyboard-capture pill of the flight HUD; flight-ui), src/input (inputSystem / keyboardCapture; shared-code maintainer)
Blocking: no   (the app works around both parts inside src/app meanwhile; see "Workaround")

## Problem
User feedback (docs/STATUS.md, 2026-11-11): "this keyboard capture thing and auto full screen is disorienting".
The app now starts windowed and uncaptured (`createInputSystem(canvas, { captureKeyboard: false })` unless
`?capture=1`), so the HUD's pill is the only way into fullscreen + keyboard lock, and it has to be an explicit
toggle. Today it is a one-way button: `kbCapture` ("Capture keyboard") calls `HudOptions.requestKeyboardCapture`,
and once captured it is replaced by `kbOk`, a `div` ("Keyboard captured") that cannot be clicked: the only way
back is Esc, which the player has to know. There is also no way to switch the control off for footage (the mission
video shows "Capture keyboard" in every frame), and `InputSystem` has no call that releases the capture.

## Evidence
- `src/ui/hud/hud.ts` 379-391: `kbCapture` is a `hudButton`, `kbOk` is `el('div', 'pill kbok', ...)` with no handler;
  `setKeyboardLocked(locked)` swaps the two.
- `src/input/inputSystem.ts`: `requestKeyboardCapture()` only; `keyboardCapture.ts` has `request()` and `dispose()`.
- `out/screens/mission/*.png`: the amber "Capture keyboard" pill top right in all 20 pictures.
- `tests/browser/app/app.spec.ts`, "keyboard capture and fullscreen are opt-in": clicks `.hud .kbcap` (fullscreen and
  lock granted), then has to call `window.__app.toggleKeyboardCapture()` to get out because nothing in the HUD can.

## Requested change
flight-ui (`src/ui/hud`):
1. The pill is one control with two states, both clickable, both calling the same callback
   `HudOptions.requestKeyboardCapture` (the app's handler already toggles: it leaves fullscreen when the keyboard
   is locked or the page is fullscreen, and requests the capture otherwise). Suggested wording: off = "Fullscreen
   + keyboard" with the open-lock icon and the existing tooltip; on = "Exit fullscreen" with the closed-lock icon
   and "Keyboard captured: browser shortcuts reach the game. Click or press Esc to release". The off state should
   read as an offer, not a warning (it is amber today, the colour of cautions).
2. `HudOptions.captureControl?: boolean` (default true): false = the pill is not built / not shown (clean footage,
   `?capturepill=0`). The `?` help button stays.
3. The key-help note "Keys with an amber outline work only while the keyboard is captured (fullscreen)" is right
   as it is; please keep the classes `kbcap` / `kbok` or tell me the new ones (the app's map-obstacle selector
   lists `.hud .pill`).

shared-code maintainer (`src/input`):
4. `InputSystem.releaseKeyboardCapture(): Promise<void>`: `navigator.keyboard.unlock()` and
   `document.exitFullscreen()` when the page is fullscreen; never rejects. `keyboardLocked` and the lock listeners
   follow as they do on Esc.
5. `InputSystemOptions.captureKeyboard` default: `false` would match the product decision (opt-in); the app passes
   it explicitly either way, so this is only about what a lab gets by default.

Must not change: the bindings (they avoid Ctrl / Alt / Meta, so every one works uncaptured; `ControlLeft` as the
extra throttle-down key stays lock-only), `HudImpl.setKeyboardLocked`.

## Workaround (in src/app, to be removed when this is resolved)
- Release: the app's handler calls `document.exitFullscreen()` itself (`src/app/game.ts`, `toggleKeyboardCapture`).
  It is reachable only through `window.__app.toggleKeyboardCapture()` and Esc until the captured pill is clickable.
- Hiding the pill: `?capturepill=0` appends a style rule `.hud .kbcap, .hud .kbok { display: none !important }` to
  the HUD root. That reaches the HUD's class names; `captureControl: false` replaces it.
