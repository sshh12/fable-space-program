Status: open
From: cockpit
Owner path: labs/integration/features.ts (the vehicle's factory arguments); later whoever composes the features of the app shell
Blocking: yes (visual QA wave 2, cockpit items 4 and 5, blockers: the chase camera looking in through a window must be shown over the real world; in the integration lab the window is an opaque black pane)

## Problem
The vehicle package draws an opaque, dark outer pane over every capsule window while the camera is outside
the vessel, unless its feature is created with `exteriorGlass: false`
(`src/render/vehicle/vesselFeature.ts`, `VesselVisualOptions.exteriorGlass`: "Set false when a cockpit
feature shows its interior through its own transparent glazing from outside"; hand-off vehicle-pad,
deviation 5). The integration lab creates it with no options (`labs/integration/features.ts` line 94:
`{ name: 'createVesselVisualFeature', args: () => [] }`) although it loads the cockpit, whose interior is
ordinary scene geometry behind transparent panes. So from the chase camera the lit cabin, the sun patch on
the console and the cockpit's own glass are hidden behind a black sheet, by day and by night.

## Evidence
`node tools/dev/heavy.mjs --class=gpu -- npx playwright test tests/browser/cockpit/world.spec.ts --project=functional -g chase`
- `out/screens/cockpit/world-chase-window-sun.png`: the camera on the sun's way in through `side-right`
  onto MFD 1, one metre outside: the real hull, its window frame and the Earth behind are there; the opening
  is black (the sun patch on the console, 3,000 cd/m^2 and more, would be the brightest thing inside it).
- `world-chase-window-night.png`: the same at night with the floods on: 0.2 % of the frame is not black, the
  spec's `minNonBlack: 0.05` fails. The cockpit's own lab, whose stand-in hull has no pane
  (`out/screens/cockpit/chase-window-night.png`), shows the couch, the harness and the head rest through
  the same window.

## Requested change
In `labs/integration/features.ts`, pass `{ exteriorGlass: false }` to `createVesselVisualFeature` when the
cockpit package is among the packages being loaded (and keep the default when it is not, e.g. with
`without=cockpit`, so the vehicle alone still closes its windows). The same rule belongs in the app shell
when it composes the features; please note it in RENDER_API / the integration notes so the shell's author
finds it. Nothing changes in the vehicle package.
