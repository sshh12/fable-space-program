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

## Addendum 2026-11-11 23:20 (app-integration): what the app's per-frame hook timers show
The app now times every feature hook in every frame (`window.__app.cpu().features`, `cpuSlowest()`,
`takeCpuTrace()`; `tests/browser/app/app.perf.spec.ts`, nothing else on the GPU). Two runs this evening, the first
with the tree as committed, the second with the pool work in progress for this request in the working tree
(`demandTiles` / `stalled` / `droppedTotal` in the stream stats):

| 2560 x 1440 | first run (22:47) | second run (23:16, pool work in the tree) |
|---|---|---|
| pad: stream at rest | never (316 waiting to upload, `stalledTotal` 1.2 million); the pool was full at 1280 x 720 too (1 tile waiting) | idle: 1,280 ready, `demandTiles` 1,172, stalled 0 |
| pad: terrain hooks p50 / p99 | 2.76 / 3.65 ms | 1.85 / 3.35 ms (the feature's own split, p50: selection 0.57, cover 0.52, build 0.11, shadow 0.08, rocks 0.07, stream 0.02) |
| pad: whole frame p50 / p99 (line 6 ms) | 4.63 / 6.31 | 4.25 / 6.69; its slowest frames are 7.2-7.9 ms with `terrain.prepare` 2.0-2.9 and `terrain.drawShadow` 0.7-1.3 |
| ignition to +200 m (930 frames): terrain p50 / p99 / max | 3.29 / 10.04 / 14.36 ms (frames of 15-19 ms, terrain 10-14 of them, six seconds after lift-off) | 1.69 / 4.94 / 6.79 ms (frames of 10.5-14.2 ms at 0.2 km, terrain 4.0-6.8 of them) |
| climb 0.3-1 km: terrain p50 / p99 | 2.18 / 3.07 | 1.59 / 2.79 |

At 1280 x 720 the second run reads: pad terrain 0.96 / 1.41 ms (frame 2.90 / 4.17), climb 0.96 / 1.63 (frame
3.16 / 4.43). So the pool work removes the stall and most of the lift-off spikes; what remains against the 6 ms
line at 1440p is `terrain.prepare` at 2-3 ms on the slow frames of the pad and the first kilometre (selection and
ground cover), next to the cockpit's 0.7-1.2 ms in the chase view (request app-integration-12).
The app's loading screen recognised the full pool and let go with the parents drawn (first run); with the pool
work it waits for `isIdle()` like everywhere else (second run: 31.9 s to the revealed view at 1440p, level 20
under the vehicle).
