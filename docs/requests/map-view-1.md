Status: resolved (commit 264d8ac)
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

## Resolution
flight-ui fix stage, commit 264d8ac, src/input/inputSystem.ts:
1. Already in place since the first flight-ui commit and kept: keyboard events whose target is an editable
   element (`input` other than button-like types, `textarea`, `select`, contenteditable) reach no binding and
   are not `preventDefault`ed; focusing such an element releases every held key.
2. New: the default `overUi` predicate is "the pointer event's target is an element other than the canvas (and
   not inside it)" (it was "inside an element marked `data-hud-interactive`", which the node panel is not).
   Edges and wheel steps are still reported, with `overUi` set, exactly as the field is documented; the
   camera mapper and the map controller already ignore them. A press on the canvas still captures the pointer,
   so a drag that started on the scene keeps `overUi` false until release. The option is now
   `isOverUi?: (target) => boolean` (the unused `HUD_INTERACTIVE_ATTR` export is gone; the HUD's own
   `INTERACTIVE_ATTR` now only marks which HUD parts take pointer events).
Verified by tests/browser/flight-ui/controls.spec.ts "a text field over the scene (the map node panel) keeps its
keys, clicks and wheel away from the flight": a held W is released when the field takes focus; "25",
Backspace, Space, Enter edit the field to "2" with no action logged and SAS / staging unchanged; the click on
the field, the click on a panel button and a wheel step over the panel all arrive with overUi; a later click on
the canvas is a scene press and T toggles SAS again. The binding table and the PointerState fields are unchanged.
