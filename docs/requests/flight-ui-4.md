Status: resolved (routed to its owner: docs/requests/vfx-cs-1.md)
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

## Resolution
Identified and passed on. The streak is drawn by the vfx feature: its ablation sparks (`src/render/vfx/director.ts`,
"ablation sparks in the shock layer"), single sparks that leave the shock layer and are drawn as streaks hundreds of
metres long far from the capsule. Found in the integration lab's reentry scene at 2560 x 1440 by switching the
packages off one at a time in one page (`window.__integration.setEnabled`) and counting red-dominant pixels in the
sky right of the capsule: 74 px in a line from (2196, 337) to (2279, 340) with everything on, 0 px without vfx, and
still there (elsewhere each time: it moves) without the sky, the atmosphere, the ocean, the terrain or the vehicle.
The scene holds one vessel and nothing else that emits. It is not the airglow, not the plasma trail and not a line
primitive of the HUD or the map.

Request `docs/requests/vfx-cs-1.md` is open against `src/render/vfx` with the evidence
(`out/screens/core-support/streak-all.png`, `streak-crop-all.png`, `streak-without-vfx.png`). Nothing changes in
`labs/integration` or in flight-ui; re-shoot `real-reentry-*.png` once vfx-cs-1 is resolved.

