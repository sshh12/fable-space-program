Status: open
From: app-integration-v1
Owner path: src/render/terrain (tile pool size / LOD selection at 1440p; terrain-render)
Blocking: no   (the app's perf spec measures without waiting for idle meanwhile; a deterministic screenshot at 1440p cannot be taken)

## Problem
At the game's stated resolution (1440p internal, ARCHITECTURE 17) the terrain on the pad never finishes
streaming: the selection wants more tiles than the tile pool holds, the pool fills (`freeTileLayers` 0 at 1,280
ready tiles), 315 tiles wait in `uploading` for ever and `stalledTotal` grows by 315 every frame (94,500 per 300
frames). `TerrainFeature.isIdle()` therefore stays false, and with it `window.__test.isIdle()`: the harness's
`waitIdle` never returns at 2560 x 1440 (it does at 1280 x 720), and whatever those 315 tiles would have drawn is
drawn by their parents for as long as the camera stays.

## Evidence
App at 2560 x 1440, `/?capture=0&scale=1&governor=off&mute=1`, chase camera on the pad (scratch probe in
`tests/browser/app`, `window.__app.terrainStats()` / `busyFeatures()` every 300 frames for 30 s):
- 5 s: queued 10, loading 8, ready 658, free tile layers 622, Earth deepest level 5, 578 nodes.
- 10 s: queued 540, ready 1,280, free tile layers 0, evicted 192, deepest level 19, 2,434 nodes.
- 15-30 s: queued 0, loading 0, **uploading 315**, ready 1,280, free tile layers 0, evicted 428,
  **stalledTotal 63,665 -> 158,165 -> 252,665 -> 347,165**, deepest level 20, 2,438 nodes; `busyFeatures()` =
  `['terrain']` throughout. Pool 1.097 GB.
Picture at the end: `out/screens/app-probe/idle-1440p.png`. At 1280 x 720 the same view is idle within the
harness's default wait (`out/screens/app/pad-chase.png`).

## Requested change
At 1440p internal the pad view must settle with every selected tile resident and the feature idle: either the
selection's demand fits the pool at that resolution (the LOD target, or which tiles are worth a pool slot near the
pad), or the pool is sized for it within the terrain's 1.1 GB VRAM line, or a tile that cannot get a slot is
dropped from the wanted set instead of waiting in `uploading` (so `isIdle()` can become true with the parents
drawn). Must not change: crack-free geomorphing, no pops, the VRAM line of ARCHITECTURE 17.

## Also measured (main thread, for the CPU line of ARCHITECTURE 17)
At 1280 x 720 with the pad idle (`window.__app.terrainStats().cpu` over 240 frames, machine shared): the terrain
feature's hooks take p50 1.69 / p95 2.48 / max 3.24 ms per frame (selection `selectMs` p50 0.69 / p95 1.09, ground
cover p50 0.63 / p95 0.93, build 0.15, shadow 0.12, rocks 0.06, uploads 0), against "quadtree + cascades <= 1 ms";
the whole app frame was p50 4.1 / p99 6.2 ms (budget 6). At 1440p with the stall above, `window.__perf.features
.terrain.cpuMs` read p99 14.9 ms at the pad and 11.4 ms in the climb (`out/app/perf-1440p.json`, under load).
