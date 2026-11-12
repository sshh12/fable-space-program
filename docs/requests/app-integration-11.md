Status: open
From: app-integration-v1
Owner path: src/render/core (pipeline creation, shader library, mesh system; shared-code maintainer), src/render/terrain (streamer.ts, feature.ts; terrain-render), src/render/atmosphere (feature.ts; atmosphere-clouds)
Blocking: no   (the loading screen shows what each subsystem exposes today; this asks for a shorter load and for the numbers the screen lacks)

## Problem
The app now shows an honest loading screen until the view at the start position is final (`src/app/loading.ts`,
docs/handoff/app-integration-v1.md "Loading"). Measured on the pad it takes 32 s, and two thirds of that is not
loading data: (A) 14 s in which only 19 frames are presented while 70 shader modules of the pipelines created
during start-up are still compiling (`pendingCompilations()`; the frame rate recovers the moment it reaches 0), and (B) 11 s of terrain streaming that only starts after
that and proceeds one quadtree level per round trip. And (C) three subsystems expose no count the screen could
show.

## Evidence
`tests/browser/app/app.spec.ts`, "the loading screen shows real progress ..." (1280 x 720, `/?hud=0`, nothing else
on the GPU, 2026-11-11 23:10; times are `performance.now()` of the page):

| Step | start -> end, s | |
|---|---|---|
| Graphics device, definitions | 0.4 -> 0.7 | 84 of 86 definition files |
| Simulation (`sim.ready`), sound (38 assets) | 0.7 -> 2.6 | |
| `createRenderer`, then the features' `init` one by one | 2.1 -> about 5.7 | the features take 3.5 s of it: terrain 1.6 s, cockpit 1.0, ocean 0.5, vehicle 0.3, site 0.1, the rest < 0.05 |
| First frame | about 5.7 -> 9.3 | one frame in 3.6 s |
| Frames 2-19 | 9.3 -> 20.1 | **18 frames in 10.8 s**; `pendingCompilations()` 70 at 9.3 s, 0 at 20.1 s; sky probe and atmosphere tables done at 20.3 s |
| Terrain | 20.4 -> 31.3 | frame 19: 32 tiles resident, 546 queued, 8 baking, 50 uploading; 24.5 s: 636 resident (the pinned and preloaded levels), nothing queued; then 719 (26.6 s), 867 (28.6 s), 1,050 (30.6 s), 1,079 at level 20 (31.3 s), with the queue empty in every second sample |
| Fade | 31.5 -> 31.9 | 12 settled frames, exposure at its target |

So: (A) between 5.7 s and 20.1 s nothing the player waits for is being loaded; the frame loop delivers a frame
every 0.6 s and more. (B) In those 14 s the eight tile workers did 90 tiles (the streamer hands out jobs once per frame,
in `update()`); after it they bake the 636 pinned tiles in 4 s and then need 7 s for the 440 tiles of the pad view,
level after level, with idle workers in between (bake 25 ms + image 6 ms per tile: `stream.bakeMs`, `imageMs`).
The first run of the evening (before the pool fix under way for app-integration-7) showed the same shape: loop
start 8.5 s, compiles done 18.7 s, terrain done 32.0 s.

## Requested change
(A) render core and every feature (shared-code maintainer to coordinate):
1. Create pipelines with `createRenderPipelineAsync` / `createComputePipelineAsync` during `init` (in parallel,
   awaited before `init` resolves), or give the core a `warmPipelines(): Promise<void>` that does so for every
   `tracked` pipeline registered so far, so that compilation runs on Dawn's worker threads while the other
   features start, and the first frame does not wait for 70 modules. Target: first presented frame within 1 s
   of the last feature's `init`.
2. `CoreShaderLibrary.compilations(): { pending: number; total: number }` and
   `MeshSystem.loads(): { pending: number; total: number }` (texture loads started / outstanding): the "Render
   pipelines" row can then count modules, and "Vehicle and site models" gets a count at all.
(B) terrain-render:
3. Hand the next job to a worker when it reports back (`onMessage`), not only in `update()`: the bake rate must
   not depend on the frame rate (it matters most when frames are slow: start-up, a hitch).
4. Load the pinned and preloaded levels from `init` on (today only the six roots; the other 624 tiles are first
   asked for by the first frame's selection), and let a caller name the start view so the chain of tiles under it
   is requested at once instead of one level per round trip, e.g.
   `TerrainFeatureOptions.startView?: { bodyId: string; latDeg: number; lonDeg: number; altitude: number }`
   (the app has it from the scenario before any frame) or a request-only selection pass that descends through
   tiles that are not resident yet.
5. `TerrainDebug.residency(bodyId: string): { wantedLevel: number; residentLevel: number; wanted: number[]; resident: number[] } | null`
   for the latest camera selection (per level: tiles the selection wants drawn, and how many of those are READY).
   Today the screen can say "level 14 under the vehicle, 1,180 tiles resident, 212 pending" but not "level 14 of
   20", and its total (resident + pending) grows while the selection refines, so the bar can move backwards.
6. An upload budget the app can raise while the loading screen is up (`TerrainDebug.setUploadBudget(tiles, ms)`
   or a `loading` flag): 2 ms and 8 tiles per frame protects a frame nobody sees.
(C) atmosphere-clouds:
7. `AtmosphereFeature.status(): { tablesReady: boolean; noiseReady: boolean; coverage: { loaded: number; total: number } }`.

Must not change: `isIdle()` of any of them (the harness's `waitIdle` and the app's reveal condition use it), the
picture, the VRAM lines of ARCHITECTURE 17.
