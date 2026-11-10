Status: open
From: map-view
Owner path: src/input (flight-ui: DOM events -> InputFrame / PointerState)
Blocking: no

## Problem
The map view's maneuver-node panel is a small DOM element over the canvas with numeric `<input>` fields
(prograde / normal / radial / UT) and buttons (+1 orbit, -1 orbit, delete). Typing "25" into a field must not
fire the digit key bindings (SAS modes 2 and 5), Enter/Backspace/Space must not stage or abort, and a click on
a panel button must not reach the scene as a press. The panel stops propagation of key events in the bubble
phase, but a window listener in the capture phase (or one that calls preventDefault on every bound code)
would still see them, and PointerState.overUi depends on how src/input decides what "over UI" means.

## Evidence
src/map/panel.ts (`NodePanel`): element `div.fable-map-panel[data-map-panel]` appended to the HUD container
(or document.body); keydown/keyup/keypress listeners call stopPropagation. The lab reproduces the intended
behaviour with its own pointer source (labs/map-view/pointerInput.ts): overUi = event target is not the canvas.
tests/browser/map-view/map-view.spec.ts types into the panel (`fill('25')` + Enter) and asserts the value
is applied; with the real input layer it must also leave SAS and staging untouched.

## Requested change
1. Key bindings ignore keyboard events whose target is an editable element (`input`, `textarea`,
   `select`, `[contenteditable]`) and do not preventDefault them (Backspace, digits, Enter must edit text).
2. PointerState.overUi is true while the pointer is over any DOM element other than the canvas (the HUD,
   the map node panel), and presses/wheel over such elements are not reported as scene presses.
What must NOT change: the binding table, PointerState field meanings, pointer capture during drags that
started on the canvas (a drag that leaves the canvas keeps overUi false until release).
