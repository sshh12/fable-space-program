Status: open
From: flight-ui
Owner path: the reentry scene of labs/integration (core-support), to be routed to the package that draws the streak (src/render/vfx or src/render/atmosphere)
Blocking: no

## Problem
The integration's reentry still has a thin red horizontal streak in the dark sky above the limb, about 270 px long
and 2 px high at 2560 x 1440, with nothing in the scene that could cast or emit it. Flight-ui shows this still
behind its HUD (`out/screens/flight-ui/real-reentry-*.png`), and the round-5 artifact critic of flight-ui called
it out (`out/qa/wave2/flight-ui.r5.artifact.json`, finding 3: "a thin red streak across the sky at x 3230-3415,
y 885 (4K) ... part of the still and should go back to its owner").

## Evidence
`out/screens/integration/budget-reentry.png` (tests/browser/integration/budget.perf.spec.ts, checkpoint 'reentry',
`scene=reentry&orbit=160,10,30`): the streak runs from about (2155, 590) to (2275, 592), dull red on near-black.
It is not part of the HUD (the still has none). It may be a segment of the red airglow layer, the plasma trail
seen edge-on, or a line primitive of another feature.

## Requested change
Identify the feature that draws the streak and pass this on to its owner; re-shoot the still once fixed. Nothing
is needed in flight-ui.
