Status: resolved (commit 189d1e2)
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

## Resolution (shared-code maintainer for src/render/terrain this round)
Three causes, none of them the eviction policy as such:

1. **The map camera's warp cap capped the vessel's ground.** The level cap under fast ground motion was one
   number per body, taken from the camera. In the map view the camera stands still in inertial space 20,000 km
   up, so in the body-fixed frame it sweeps the turning Earth at 1.9 km/s: cap 11.4. Every tile deeper than
   level 11 went unused, the vessel's included, and after 90 frames they were evictable. Now every LOD observer
   has the cap of its own ground speed (`LodObserverFixed.cap`, `src/render/terrain/quadtree.ts`): a tile is
   refined under the largest cap of the observers within range of it. In the map the pad keeps level 20.
2. **The view blend left a speed behind.** The camera's ground speed was a smoothed estimate that took the
   0.6 s flight back from the map for flight and needed one to five seconds to decay (the coarse patches you
   saw refining). It is now the slowest frame of the last quarter second, taken at once when it falls
   (`GroundSpeed`, `lod.ts`): the first frame at rest has the full depth.
3. **Nothing kept the view's own tiles.** The vessel observer keeps the ground near the vessel; the foreground
   of a chase camera 140 m away was the camera's alone. While `camera.kind === 'map'` the terrain now selects
   the last settled surface view (eye, frustum, K) request-only every eighth frame, so its tiles stay resident
   and count as demand (`ParkedView`, `feature.ts`); it is dropped when the vessel has moved 150 m.

Also in `src/camera`: the chase rig keeps the placement the player left when the map is closed (it used to
re-initialise), so the view that comes back is the view that was parked.

Measured (`tests/browser/integration/pad-pools.spec.ts`, the app at 2560 x 1440: M, 180 frames in the map, M
back): deepest Earth level in the map 20 (was 11), in the first frame after the blend 20 (was 2); tiles
streamed again after the return 0 (the map's own selection streams about 100-220 tiles and evicts as many of
the oldest unused ones, none of the parked view); pixels that differ from the picture before by more than 24 of
255: 5 % in the first frame (the temporal resolve gathering after the camera's flight: towers and markings a
little soft; `out/screens/core-support/pad-1440p-back-first.png`), 1 % three quarters of a second later (the
clouds have drifted). No sea, no coarse patches.

Not done: "a parent drawn in place of land must not drop the coast under the sea" (the coarse levels' heights at
this coast). With the three changes the view no longer falls back to those parents on a map round trip; the
same parents still show while the pad streams in for the first time, which the loading screen now covers.
