Status: open
From: app-integration-v1
Owner path: src/render/terrain (streaming / eviction around surface LOD observers; terrain-render)
Blocking: no

## Problem
Back from the map view the land around the pad is drawn as open sea for the first frames, then as coarse grey
patches, and is complete about 1.3 s later: a visible LOD pop on every map round trip (PROMPT: "no loading
screens, visible LOD popping"). In map view the camera is 20,000 km away; the vessel on the pad is a LOD observer
(`buildLodObservers`: every vessel within 2 km of a surface, radius bias = its bounding radius) and keeps full
detail right under it, but the ground beyond about 100 m is evicted and comes back from parents whose heights put
the Ka Lae coast under sea level (the ocean and the far water sheet then show, the ground cover floats on it).

## Evidence
`tests/browser/app` probe (the app at `/?capture=0`, idle on the pad, M, 180 frames in the map, M back):
`out/screens/app-probe/rt-0-before.png` (before), `rt-after-1.png` (first frame after the 0.65 s blend back:
land flooded to the edge of the site's groundworks, scrub floating on the water), `rt-after-60.png` (land back,
darker coarse patches), `rt-idle.png` (complete; `isIdle()` 0.67 s after the blend ended). The same sequence in
`out/screens/app/pad-paused.png` during the keyboard spec.

## Requested change
Keep the tiles a surface LOD observer needs for the view from a nearby camera resident while the camera is away
(for instance: the observer's neighbourhood out to a few kilometres at the levels a chase camera at the vehicle's
`cameras.chase.maxDistance` would select, pinned like the levels loaded at boot), so that leaving the map shows the
ground exactly as it was left. If eviction must happen, a parent that is drawn in place of land must not drop the
coast under the sea. Must not change: the map view's own streaming of whole bodies, the VRAM line of
ARCHITECTURE 17 (terrain 1.1 GB).
