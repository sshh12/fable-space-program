Status: open
From: shell-menu
Owner path: src/render/core (renderer.ts spot shadow passes, `meshes.drawSpotShadows`) or src/render/vehicle (what it submits to them)
Blocking: no for the package (its night test's only failure); yes for any page that ends in `expectNoErrors` with the lunar stack on a flood-lit pad at night

## Problem
With the lunar stack standing on Ka Lae LC-1 at night (the pad's floodlights on), WebGPU warns once per run:
`Calling [RenderPassEncoder "shadow.spot0"].Draw with an index count of 0 is unusual.` A draw with no
indices is submitted to the first spot-light shadow pass. The harness's `expectNoErrors` counts the warning, so
`tests/browser/menu/legibility.spec.ts` "at a night pad" fails after every one of its own assertions passed
(hand-over 11.38 EV, settled 11.40; every text >= 7.7:1).

## Evidence
Run 7 of shell-menu (HEAD 6d74667, 2026-11-24), `out/screens/shell-menu/flight-night-*-1280.png`; the page is
`/labs/shell/?governor=off&queue=free&padhour=1` (the display vessel is the first presentable vehicle, built with
`assembleVessel` + `vesselPartSnapshots`, standing on the mount: `ground.originHeight` from the stack's lowest
point, `clearance` = the pad's mount height). The warning did not appear while the vessel stood below the ground
(run 6), so a mesh of the stack inside the floodlight's frustum is the likely source.

## Requested change
Skip a draw whose index (or vertex) count is 0 in the spot shadow passes, or do not submit an empty mesh to
them. Nothing else should change.
