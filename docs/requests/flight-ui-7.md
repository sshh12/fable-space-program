Status: open
From: flight-ui
Owner path: src/app/game.ts (app fixer; the settings `captureKeyboard` / `capturePill` / `pilotLabel` already in progress in src/app/settings.ts)
Blocking: no

## Problem
The user found the keyboard capture disorienting (STATUS, user feedback 2026-11-11). Flight-ui's side is done:
`src/input` asks for nothing by itself any more (`InputSystemOptions.captureKeyboard` now defaults to **false**;
true is the app's opt-in to ask on the first gesture), and the HUD's "Capture keyboard" pill is now an explicit,
labelled switch ("Keyboard capture  OFF / ON / NO LOCK", `role="switch"`, `aria-checked`): a click asks for
fullscreen + keyboard lock, a second click leaves, Esc leaves too (Escape is no longer in the lock list, so one
press exits; Chrome asked for press-and-hold before). Every binding works uncaptured (only ControlLeft as an extra
throttle-down needs the lock). The app has to wire the second click and the hide option.

## Evidence
`src/app/game.ts` lines 125-146: `createInputSystem(canvas, { captureKeyboard: settings.captureKeyboard })` (fine as
is with the new default), `requestKeyboardCapture: () => void input.requestKeyboardCapture()` (fine),
`hud.setKeyboardLocked(input.keyboardLocked)` and `input.onKeyboardLockChange((locked) => hud.setKeyboardLocked(locked))`
(the switch then only shows ON while the lock is granted, and the second click does nothing: no release wired).
Flight-ui lab and spec: `labs/flight-ui/main.ts` (search `releaseKeyboardCapture`), `tests/browser/flight-ui/controls.spec.ts`
("keyboard capture is opt-in", "the capture switch asks on a click and leaves on the second").

## Requested change
In `createHud({...})`:
- `releaseKeyboardCapture: () => input.releaseKeyboardCapture()` (new `InputSystem` method; never throws);
- `showCaptureControl: settings.capturePill` (new `HudOptions` field, default true; `hud.setCaptureControlVisible(v)`
  switches it at run time, e.g. for a footage key).

And pass the fullscreen state on (new second argument of the listener and of `setKeyboardLocked`):
- `hud.setKeyboardLocked(input.keyboardLocked, input.fullscreen)`;
- `input.onKeyboardLockChange((locked, fullscreen) => hud.setKeyboardLocked(locked, fullscreen))`.

Also in the same file (request flight-ui-3's app part, still open): `HUD_OBSTACLE_SELECTOR` (line 52) names
`.hud .nbchips > div`, which no longer exists since the round-6 instrument housing; replace it by
`.hud .housing, .hud .prw` so map labels and the node panel keep off the SAS controls, the gauges and the pitch /
roll windows (`.hud .pill` already covers the capture switch).

Must not change: the bindings, `keyboardLocked` semantics (true only while fullscreen with the lock granted), the
`?capture=1` opt-in (it keeps asking on the first gesture). The "TEST PILOT" line is the app's own
(`statusLine.ts`, `?pilotlabel=0` in progress): nothing in flight-ui draws it.
