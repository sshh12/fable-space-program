Status: resolved (commit 189d1e2)
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

## Resolution (shared-code maintainer for src/render/terrain this round)
The cause was the vessel observer, not the pool: `buildLodObservers` gave every vessel near a surface its bounding
sphere about the VES origin as `radiusBias`, which is 101 m for the stack on the pad (the origin is the capsule,
100 m above the base). The level-20 ring around it alone asked for 628 of the 1,280 tile layers; the whole view
for about 1,880. Four changes, all in the working tree's HEAD:

1. `src/camera/listener.ts` `vesselGroundObserver`: a vessel observer is the point at the vessel's foot (on the
   vertical through its centre of mass, at the height of its lowest part) with the radius of its footprint as the
   bias, from the parts' `bounds` cylinders in their attitude: 9.3 m for the stack, 9.4 m for the lander on its
   legs, the length for a stage lying on its side. The pad view at 1440p now asks for 1,170 tiles with the pinned
   levels (ratio 0.92 of the pool).
2. `src/render/terrain/streamer.ts`, `lod.ts`, `feature.ts`: the terrain measures its live demand on each pool
   (`TileStreamer.demand`) and shrinks the level ranges by a factor on K (`lodScale`, `fitLodScale`) when it
   passes 0.92 of a pool, to 0.86; it grows back below 0.78. K follows smoothly as before, so the ranges morph:
   no pops. At 2560 x 1440 on the pad it rests between 1.0 and 0.95 (the view is at the edge of the pool).
3. A frame looks for an evictable tile once per kind of layer, not once per waiting tile (that search was the
   2.6 ms p50 / 3.3 ms p99 of streamer time at 1440p), and bakes are held back while finished tiles wait.
4. The third option of your request as the safety net: a tile that has waited 240 frames for a layer is given
   up, its parent stands in, it is not asked for again for 900 frames (`StreamStats.droppedTotal`). With 1 and 2
   it does not happen on the pad (0 in the spec).

Measured (`tests/browser/integration/pad-pools.spec.ts`: the app at 2560 x 1440,
`/?capture=0&scale=1&governor=off&mute=1`, chase view on the pad, 300 frames at rest; numbers in
`out/core-support/pad-pools.json`; before = the same probe on the tree as it was at 22:00):

| | before | after |
|---|---|---|
| `isIdle()` / `waitIdle` | never | reached (the harness's `waitIdle` returns) |
| tiles waiting for a layer | 380 for ever, `stalledTotal` + 114,000 per 300 frames | 0 |
| terrain hooks, main thread p50 / p99 | 5.27 / 6.74 ms | 1.41 / 2.10 ms |
| streamer of it | 2.63 / 3.25 ms | 0.025 / 0.04 ms |
| selection / ground cover of it | 1.13 / 0.96 ms (p50) | 0.59 / 0.52 ms (p50) |
| app frame, main thread p50 / p99 | 8.0 / 11.0 ms | 3.4 / 4.8 ms (line: 6) |

Still over "quadtree + cascades <= 1 ms": 1.4 ms p50 of terrain hooks at 1440p (selection 0.59, ground cover
0.52, the rest 0.3). The crack-free geomorphing, the VRAM line (pools unchanged, 1.097 GB) and "no pops" are as
they were: `tests/browser/terrain` (pops, integrity, views) re-run on the final code, and the selection's
crack test covers observers with different caps (`tests/unit/terrain-render/pools.test.ts`).

New for you: `window.__app.terrainStats().stream` carries `stalled`, `droppedTotal`, `demandTiles`,
`demandImages`, `lodScale`. The app's own recognition of a full pool can go.
