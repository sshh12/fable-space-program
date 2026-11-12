Status: open (parts 2-6 done in 189d1e2, aea5efa, 1e5bceb; part 7 done in cce44d3; part 1: the core's half built in 038cf6f (`shaders.warm`, the core's own pipelines), the packages' creation sites open: terrain by request core-2, the others by NOTICE-core-5)
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

## Resolution of parts 2 to 6 (shared-code maintainer; also for src/render/terrain this round)
- **2.** `CoreShaderLibrary.compilations(): { pending, total }` (modules created so far and still compiling) and
  `MeshSystem.loads(): { pending, total }` (texture loads started and outstanding). `coreOf(ctx).shaders` /
  `.meshes`, or `renderer.core`.
- **3.** The streamer hands the next job to a worker when it reports back (`TileStreamer.onMessage`), not only in
  `update()`: the bake rate no longer depends on the frame rate.
- **4.** The always-resident levels (0 to `pinLevel`, 126 tiles a body) are requested from `init` on, and bake
  while the other features start. After a cut and at the start (the first frame is a cut) the selection asks for
  the tiles under the view three levels at a time until one selection wants nothing (`SelectParams.eager`,
  `EAGER_LEVELS`): children of tiles that are not resident yet, by the bounds they inherit. The view then streams
  in a third of the round trips with the same tiles (unit test: 15 passes -> 6, 15 % more bakes at most). I tried
  the whole chain at once first: the inherited bounds are too wide for that deep, it asked for twice the pad
  view's tiles. No `startView` option: without the view direction a start view asks for the whole ring (four
  times the tiles of the frustum), and the first frame's eager pass does the same job with the real camera.
- **5.** `TerrainDebug.residency(bodyId): { wantedLevel, residentLevel, wanted: number[], resident: number[] } | null`
  for the latest camera selection of the body (levels 0..maxRenderLevel; a tile counts as wanted when the
  selection drew it, a parent of something drawn, or asked for it; a tile given up for want of a pool layer is
  not wanted until its retry). `residentLevel` = the deepest level down to which every wanted tile is READY.
  One walk over the body's nodes (a few thousand): fine for every frame of the loading screen.
- **6.** `TerrainDebug.setUploadBudget(tiles, ms)` (default 8 tiles and 2 ms a frame; set it back when the scene
  is revealed).
- Also from request app-integration-7: a tile that cannot get a pool layer is given up after 240 frames
  (`StreamStats.droppedTotal`) and `isIdle()` is reached at 1440p; `StreamStats.stalled`, `demandTiles`,
  `demandImages`, `lodScale`.

Tests: `tests/browser/terrain/smoke.spec.ts` (residency equals wanted level by level at rest, counts of shaders
and textures), `tests/unit/terrain-render/pools.test.ts` (eager requests). In `tests/browser/integration/pad-pools.spec.ts`
the terrain is at rest 28.1 s after navigation on the pad at 2560 x 1440 and 21.7 s on the Moon (one run each,
with the compile stall of part 1 still in it); your spec has the finer clock ("the loading screen shows real
progress").

## Part 1 (asynchronous pipeline creation): measured, planned, not built
What blocks: every package creates its pipelines with the synchronous `device.createRenderPipeline` /
`createComputePipeline` inside `core.shaders.tracked(build)`, and most call `.get()` in their `init`. The GPU
process then compiles them one after another on its device thread and the first frames queue behind them.
A plan that needs no change to how features hold their pipelines:

1. The GPU experiment is done (this round's probe, a device of its own in the lab page, eight pipelines with a
   heavy fragment shader each, RTX 5090): created synchronously and used, 7.39 s (one after another: 0.92 s
   each; a second set of eight, 7.44 s); eight others created with `createRenderPipelineAsync`, 1.31 s (5.6
   times faster: they compile side by side); and those eight created AGAIN synchronously from equal descriptors
   (new module objects of the same WGSL, the same explicit layout) and used: 5 ms. Dawn returns the cached
   pipeline. So a warm-up with the asynchronous call makes the features' synchronous creation free.
2. `CoreShaderLibrary.warm(): Promise<void>`: for every tracked item that is not built yet, run its `build`
   with `device.createRenderPipeline` / `createComputePipeline` replaced for the duration by functions that start
   the asynchronous creation of the same descriptor and throw a private marker; catch the marker, await the
   creations (all items in parallel), and repeat until a `build` runs through (a build that creates several
   pipelines takes one round each). Then `.get()` is a cache hit.
3. Each feature replaces the `.get()` calls at the end of its `init` by one `await coreOf(ctx).shaders.warm()`
   (core: `createRenderer` would have to return its promise, or the app awaits `renderer.core.shaders.warm()`
   before the first frame). 65 creation sites: core 8, terrain 7, cockpit 12, vfx 15, ocean 6, sky 6,
   atmosphere 5, ui / map / app 6.

## Resolution of part 7 (atmosphere-clouds, cce44d3)
`AtmosphereFeature.status(): AtmosphereStatus` (`src/render/atmosphere/feature.ts`, type exported from
`@/render/atmosphere`):

```ts
interface AtmosphereStatus {
  tablesReady: boolean;                         // the static scattering tables of the bodies in the frame hold data
  noiseReady: boolean;                          // the two cloud noise volumes are generated and uploaded
  coverage: { loaded: number; total: number };  // cloud coverage maps asked for so far / of those, finished
}
```

- `tablesReady` is false until the first frame with an atmosphere body in range has built the transmittance,
  multi-scattering and sky-irradiance tables (one compute pass, a few milliseconds), and false again while they are
  rebuilt (`invalidate()`, a change of the atmosphere definitions).
- `noiseReady`: the noise is generated in compute at `init`, read back, equalised on the CPU and uploaded
  (asynchronously; not timed here); true at once when the definitions hold no body with clouds.
- `coverage.total` counts the bodies whose clouds a frame has asked for so far (a map is first asked for in the
  first frame that has its body in range: 0 of 0 before that), `loaded` those whose map is in (with its mips and
  the block statistics built from it) or has turned out not to exist. Earth: 0 / 0, then 0 / 1 while the 8192 x
  4096 map is fetched and decoded, then 1 / 1.
- `isIdle()` is unchanged (tables ready, noise ready, no map loading).
Test: `tests/browser/atmosphere/clouds.spec.ts`, "status: tables, noise and the coverage map are reported as built
once the page is idle" (with the baked map `{ tablesReady: true, noiseReady: true, coverage: { loaded: 1, total: 1 } }`;
with `clouds: false` `coverage: { loaded: 0, total: 0 }`).

## Part 1, the core's half: built (shared-code maintainer, 038cf6f); the packages' halves are open

**What exists.** `CoreShaderLibrary.warm(items): Promise<void>` creates the pipelines of tracked builds with
`createRenderPipelineAsync` / `createComputePipelineAsync` (a dry run of each `build` in which the device's
two synchronous creation calls start the asynchronous creation of the same descriptor and hand back a
stand-in; rounds for builds that read their own pipeline; a chunk replaced meanwhile is followed), then
calls the ordinary `get()`: the synchronous creation that `build` performs is answered from the device's
pipeline cache. No feature changes how it holds its pipelines. Also `shaders.warmed()` (everything started
so far is there), `shaders.warming()` (`{ pending, total }`), both counted in `pendingCompilations()` /
`compilations()` so the loading screen's row and `isIdle()` see them; `CoreRenderer.warm()`;
`RendererOptions.pipelineWarm` and `?warm=0` for an A/B. RENDER_API section 5 ("Pipelines created ahead")
with the recipe in 17.8; NOTICE-core-5. Not as planned above in two points: the items are named by the
caller (a library-wide `warm()` would also build items of other packages that are not meant to exist yet),
and nothing is thrown (the dry run returns a stand-in, so a build with several pipelines takes one round).

**Who uses it.** The core's own thirteen pipelines (tone map, ambient occlusion, resolve and bloom, the
exposure meter, the far exposure, the half-resolution depth, the mesh system's, and the lighting stage,
which is now created with the renderer instead of in the first frame). The terrain renderer's adoption is
request `core-2` (the edits are written out there; the package has its own owner now). Every other package:
its next round, by the notice. `createLabApp` awaits `renderer.warm()` after its feature list; for `src/app`
that is one line before the frame loop starts and the lead's decision (with most pipelines still
synchronous it would hold the first frame until the GPU process's queue has drained).

**Measured on the device** (`tests/browser/render-core/warm.spec.ts`, RTX 5090, 2026-11-12 10:00): six
pipelines with a heavy fragment shader each, created synchronously and used: 886 ms; created ahead: 184 ms;
the synchronous creation after it: 0.6 ms (3.1 ms with `layout: 'auto'`).

**Measured on the pad load** (the game at its default start, `/?capture=0&scale=1&governor=off&mute=1`, 2560 x
1440, a fresh browser per column, back to back, 2026-11-12 12:53 to 12:59; `warm=0` is the tree without the
core's creation ahead; seconds; "frame 0" is the main thread's time in the first frame):

| | `warm=0` | default | `warm=0` again | default again |
|---|---|---|---|---|
| cold load: view revealed | 51.1 | 48.4 | 38.4 | 34.7 |
| reload: view revealed | 39.1 | 44.7 | 38.3 | 34.4 |
| cold: "shader modules compiled" row ends | 38.7 | 36.1 | 27.9 | 25.0 |
| reload: the row ends | 28.3 | 33.0 | 27.4 | 23.3 |
| cold: frame 0 | 6.1 | 5.7 | 4.4 | 3.6 |
| reload: frame 0 | 3.7 | 6.1 | 4.4 | 3.8 |

Three of the four pairs are 2.7 to 3.9 s shorter with the core's pipelines created ahead, one is 5.5 s
longer, and the two `warm=0` columns differ from each other by 12.7 s (other agents' jobs ran on the machine
throughout). So the core's half alone does not shorten the pad load by an amount these four runs can tell
from their own spread, which is what thirteen of roughly eighty pipelines would give: the queue in the GPU
process is the packages' pipelines, created synchronously in their `init`, and it is as long as before. The
28.7 s of the same probe at 09:36 is not a "before" for this table: the tree gained the visual fixers'
shaders in between and the machine was busier (the six-pipeline control took 886 ms at 10:00 and 1,610 ms
at 11:16).

**Open** (why the request stays open): the packages' creation sites (terrain 7, cockpit 12, vfx 15, ocean 6,
sky 6, atmosphere 5, ui / map / app 6, by this request's count), each by its owner; and the pad load measured
again once they have. Part B of the problem (the terrain's streaming that starts after the compiles and
proceeds a level per round trip) is unchanged by this.
