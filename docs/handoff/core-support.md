# Hand-off: core-support (running log)

Wave-2 maintainer of the finished wave-1 code (`src/core`, `src/render/core`, `src/terrain`, `src/ui`,
`src/input`, `src/camera`, `src/map`, `src/audio`, the tools, the browser harness, the shared docs). This
file is kept current from the first commit so that a successor can continue from it: it is a log first and
a hand-off second. Newest state is always in the tables; the dated notes at the end are the journal.

Starting point: `docs/handoff/lead-baseline.md` (commit `6912e11`): nothing open in `docs/requests/`,
typecheck / vitest / functional browser suite green, wave-1 perf numbers provisional.

Differences between my brief and what I was told to do at start (the task wins):

- The request waiter runs against the marker files `out/wave2-done/<package>.done` (a package is built, then
  reviewed, then fixed; requests keep arriving after its hand-off exists), not against the hand-offs.
- Heavy commands go through `tools/dev/heavy.mjs` (cpu / gpu / bake classes); the brief's "8 below-normal
  workers" rule is replaced by the gate and a 6-process cap.
- The wave-1 requests were already answered by the lead; I start from an empty queue.

## 1. Requests

| Request | From | Against | Result | One line |
|---|---|---|---|---|
| `ocean-1` | ocean | contracts/render.ts, render core | resolved `b812ec4` | `'gbuffer.albedo'` / `'gbuffer.normal'` / `'gbuffer.material'` (live RT0-RT2, readable from `drawWater` on) and binding set `gbuffer`: the forward water band can shade with the deferred sheet's inputs |
| `ocean-2` | ocean | render core lab (LabPlanet) | resolved `9debd1f` | Inside `'ocean.nearField'.fadeStart` the LabPlanet seabed follows the sheet (`seabedDepth: 'sheet'`, new default: sheet depth and map colour); a number keeps the fixed sand floor |
| `ocean-3` | ocean | contracts/render.ts, render core | resolved `9debd1f` | `'ocean.wetness'` (uniform, 400 bytes, up to 8 vessels at the water) and binding set `oceanWetness`; two differences from the request: `plane.w` is an influence radius and slots are not tied to vessel indices. The mesh system applies the wet line itself |

## 2. API and contract changes made in wave 2

| Change | Where | Affects | Migration |
|---|---|---|---|
| `SharedResourceMap`: `'gbuffer.albedo'`, `'gbuffer.normal'`, `'gbuffer.material'` (the live RT0 / RT1 / RT2 views of this frame; valid from deferred lighting on; never in a bind group set inside `drawGBuffer`); `SceneBindingSet` `'gbuffer'` | `contracts/render.ts`, `src/render/core/{resources,renderer,sceneBindings}.ts` | ocean (uses it); anyone after lighting | None (additive) |
| `SharedResourceMap['ocean.wetness']: GPUBuffer`, `OCEAN_WETNESS_SLOTS` (8), `OCEAN_WETNESS_BYTES` (400); `SceneBindingSet` `'oceanWetness'`; the mesh system's G-buffer shader reads it (`hullWetness`): wetness 1 below a slot's wet line within its radius, max with `MeshInstance.wetness` | `contracts/render.ts`, `src/render/core/{resources,sceneBindings}.ts`, `src/render/core/mesh/meshSystem.ts` (`createMeshSystem` takes `resources`; batch bind group has binding 2) | ocean (publishes), vehicle-pad (hulls get a wet line with no change) | None; with the default buffer mesh output is bit-identical |
| `LabPlanetOptions.seabedDepth?: number \| 'sheet'`, default `'sheet'` (was a number, default 30) | `src/render/core/lab/labPlanet.ts`; `labs/render-core` `?seabed=<m>` | ocean lab; any lab with a near field over the LabPlanet | Pass `seabedDepth: 30` for the old fixed sand floor |
| `Sampler.resample(...)`, `SampledCurve.c / s / maxError / initial`, `MapStats.reuse`; scene lines carry 10-12 % more vertices | `src/map/{sampler,scene,controller}.ts` | the lead's app shell (none of it is contract) | None |

## 3. Wave-1 numbers re-measured on the quiet machine (Job 2)

Run 2026-11-10 17:00-17:10 local, before any wave-2 package had started heavy work: no heavy slot held but
mine, 39 GB free, whole-machine CPU busy 6 % during the terrain bench. Everything through the gate; perf
specs under `withGpuLock`, 2560 x 1440. Raw logs: `out/core-support/perf-1.log`, `vitest-1.log`,
`terrain-bench-1.log`, `terrain-perf-1.log`, `map-perf-2.log` (git-ignored).

| Package | Line (source) | Required | Wave 1 (loaded) | Quiet machine | Verdict |
|---|---|---|---|---|---|
| render-core | Core fixed GPU, p99 with a 7 ms ballast (ARCH 17.1) | 3.0 ms | 0.51 | **0.526** (AO + contact 0.093, lighting 0.172, TAA 0.110, bloom 0.045, tonemap + histogram 0.047, copies + pyramid 0.058) | met |
| render-core | 1.7 M triangle scene, G-buffer p99 + amortised shadows (brief) | 2.0 ms | 0.39 | **0.633** (0.394 + 0.239) | met |
| render-core | CPU frame, lab (brief) | 2 ms p99 | 0.39-1.08 | **0.57** (p50 0.30) | met |
| render-core | Governor: quality first, resolution second, 60 fps held | qualitative | passed | passed: quality at frame 6, resolution at frame 13, settled GPU p99 8.71 ms, 0 frames over 33 ms | met |
| flight-ui | HUD main-thread cost per frame (ARCH 17: UI 0.5 ms) | 0.5 ms mean | 0.09 / 0.11 | **0.116** (low orbit + node) / **0.140** (powered ascent) | met |
| flight-ui | Navball GPU p99, 512 texture, with ballast (ARCH 17.1) | 0.05 ms | 0.008 | **0.0082** / 0.0083 | met |
| map-view | Overlay GPU p99, 8 patches + 20 debris (ARCH 17.1) | 0.1 ms | 0.013 | **0.009** overview, **0.012** close-up | met |
| map-view | Overlay CPU p99, overview (brief) | 0.5 ms | 0.475 | 0.425 before, **0.340** after the fix below | met |
| map-view | Overlay CPU p99, Earth close-up (brief) | 0.5 ms | 0.560 | **0.525 before: missed on the quiet machine too**; **0.390** after the fix below | met after fix |
| terrain-core | Analytic `heightAt`, lambdaMin 100 m | 3 us | 0.42 / 0.30 | **0.56** (Moon) / **0.38** (Earth) | met |
| terrain-core | Cached collision query | 0.5 us | 0.055 / 0.050 | **0.055** / **0.049** | met |
| terrain-core | First collision query in a fresh area | 0.2 ms each | max 203 / 119 us | median 12.9 / 10.7 us, p99 33.7 / 23.9 us, max **194** / **216** us in the bench; the `TERRAIN_PERF=1` assertions of `collision.test.ts` pass (10 of 10) | met at p99; the single worst query of the Earth bench run is 8 % over |
| terrain-core | Tile bake, geometry + normal map (ARCH 17: 6-12 ms per tile) | 12 ms | 6.4-9.0 at L6-10, 13.3-19.3 at L13+ | Moon L6 / 10 / 13 / 16 / 18: 6.0 / 9.9 / **15.4 / 16.7 / 13.4** ms; Earth L6 / 10 / 13 / 16 / 20: 8.7 / **12.3 / 13.7 / 20.3 / 18.8** ms | **not met at level 13 and deeper** (see below) |
| all | `npx vitest run` (whole tree) | green | 657 passed | 58 files, 657 tests passed, 53 s | met |

**Map-view close-up fix** (commit below). The scene builder refined every line from scratch on every
frame. It now keeps each line's breakpoints (parameters and their cos / sin) under the line id and, while
the conic keeps its shape, evaluates the curve at them for the new view and verifies the exact chord error
of every piece (`Sampler.resample`): one evaluation and one error per vertex, no trigonometry, no heap. A
piece over the tolerance, a changed eccentricity or an uncovered range falls back to a fresh sampling, so
every frame is still within 0.3 px (0.9 px for the faint lines). A whole revolution may start anywhere
(vessels moving along their orbits keep their breakpoints); a view that has zoomed out is re-sampled so
vertices do not pile up. Fresh samplings refine to 0.8 of the tolerance so a slowly turning view does not
fall out of it on the next frame: 10-12 % more vertices (close-up 857 -> 956 at 720p). Node, tight loop,
same machine, A/B: overview p50 0.090 -> 0.055 ms, close-up 0.124 -> 0.076 ms (-39 %). Browser, under the
lock: overview p50 0.220 -> 0.185, p99 0.425 -> 0.340 ms; close-up p50 0.270 -> 0.200, p99 0.525 -> 0.390 ms.
Tests: `tests/unit/map-view/breakpointReuse.test.ts` (8 tests: exactness over a 240-frame turn, a zoom in
and out, vessels moving 3 deg per frame, a changed conic; the fast path is taken on more than 90 % of the
lines). `MapStats.reuse` reports the split per build.

**Terrain bake budget.** Still missed at render levels 13 and deeper on the quiet machine, by 1.1-1.7 x,
as terrain-core reported. Status and plan: see the journal.

## 4. Cross-feature checks (Job 3)

Filled in as features land.

## 5. Problems filed against wave-2 packages

| Request | Owner | Status | One line |
|---|---|---|---|
| (none yet) | | | |

## 6. Journal

- 17:30. Requests `ocean-1`, `ocean-2`, `ocean-3` answered (all blocking; table in section 1). Render-core
  functional suite re-run after each change (23 specs + the new wet-line and seabed specs). RENDER_API has
  section 17 (five recipes) and section 18 (wave-2 change list) from this point on.
- 17:10-17:17. Job 2 measurements on the quiet machine (section 3). Two misses: the map-view close-up CPU
  line (fixed, commit `1be550f`) and the terrain bake budget at level 13 and deeper (open).
- 2026-11-10, start. Read PROMPT, ARCHITECTURE, PACKAGE_RULES, requests README, RENDER_API, the render
  contract, lead-baseline and the wave-1 hand-offs of the five packages I own (measured / not met / known
  limits / requests sections). Waiter started on the eight marker files. Machine idle (39 GB free, no slot
  held): started the four wave-1 perf specs at once through the gpu gate
  (`out/core-support/perf-1.log`).
