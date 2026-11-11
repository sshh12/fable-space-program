# Hand-off: core-support (running log)

Wave-2 maintainer of the finished wave-1 code (`src/core`, `src/render/core`, `src/terrain`, `src/ui`,
`src/input`, `src/camera`, `src/map`, `src/audio`, the tools incl. the bakes, the browser harness, the shared
docs). This file is kept current so that a successor can continue from it: the tables are the state, the
journal at the end is the history.

Starting point: `docs/handoff/lead-baseline.md` (commit `6912e11`).

Differences between my brief and what I was told at start (the task wins):

- The request waiter runs against the marker files `out/wave2-done/<package>.done`, not the hand-offs:
  `node tools/dev/wait-requests.mjs --open --until out/wave2-done/terrain-render.done,...,out/wave2-done/sim-world-pilot.done --timeout 540`.
- Heavy commands go through `tools/dev/heavy.mjs` (cpu / gpu / bake); it replaces the "8 below-normal
  workers" rule. One heavy command at a time.
- The wave-1 requests were already answered by the lead.
- **The scratchpad directory is shared between the agents of this session**: another agent overwrote
  scripts of mine there. Keep helper scripts under a sub-directory of your own.

## 1. Requests

Fifteen requests so far; none against my paths is open. Details under `## Resolution` in each file.

| Request | Blocking | Against | Result | One line |
|---|---|---|---|---|
| `ocean-1` | yes | contracts/render.ts, render core | resolved `b812ec4` | `'gbuffer.albedo'` / `'gbuffer.normal'` / `'gbuffer.material'` (live RT0-RT2, readable from `drawWater` on), binding set `gbuffer`: the forward water band shades with the deferred sheet's inputs |
| `ocean-2` | yes | render core lab (LabPlanet) | resolved `9debd1f` | Inside `'ocean.nearField'.fadeStart` the LabPlanet seabed follows the sheet (`seabedDepth: 'sheet'`, new default); a number keeps the fixed sand floor |
| `ocean-3` | yes | contracts/render.ts, render core | resolved `9debd1f` | `'ocean.wetness'` (uniform, 400 bytes, up to 8 vessels at the water), binding set `oceanWetness`. Differences from the request: `plane.w` is an influence radius, slots are not tied to vessel indices. The mesh system applies the wet line itself |
| `ocean-4` | no | TAA resolve, contracts | resolved `2cc2aea` | `'post.reactive'` mask (r8unorm, cleared per frame, `requires: ['post.reactive']`): history weight x (1 - value). Also: the TAA history is rescaled by the exposure ratio |
| `cockpit-1` | no | deferred lighting | resolved `113438e` | Cloth looks the sun shadow up with the normal turned to the sun: back-lit fabric is shadowed by casters |
| `cockpit-2` | no | deferred lighting | resolved `113438e` | Planetshine x baked AO (RT0.a): none through a closed cabin |
| `cockpit-3` | yes | exposure | resolved `113438e` | Interior metering = log-average of the near histogram over everything above the floor: the cabin stays readable under a sun patch |
| `cockpit-4` | no | shadow cascades | resolved `03242a3` | Interior camera: cascade 0 is 6 m instead of 12 m (0.59 cm texels). More taps / fixed grid not done; offered as a next step |
| `vfx-1` | no | exposure | resolved `03242a3` | `coreOf(ctx).addEmissiveHint(luminance, coverage)`: emitters over sky pixels are metered (prior raised by coverage, full from 1 %) |
| `terrain-render-1` | no | src/terrain | resolved `37f6f54` | Bakes of prepared tiles are complete from level 14 on: rock candidates of km-wide cells are dropped before their abundance (land cover 7 km away) is read |
| `terrain-render-2` | yes | tools/bake/earth, Earth height tiles | resolved `b8ea6a7` | Needles (up to 1,135 m) in the regional Earth heights removed: despike pass in the bake, repair of the stored tiles, verifier check. Manifest contentHash `ab20fdfc579d4015` |
| `terrain-render-3` | no | Earth night layer | **declined** | The 1.2 km blocks are the instrument footprint in the published source; `nightMinMip: 2` is the smooth filter. Alternatives inside terrain-render given |
| `sky-lighting-1` | no | TAA resolve | **declined** | Energy loss of sub-pixel bright geometry and the jitter-cycle ripple need a redesign of the resolve (a linear blend for still pixels was tried: it creates energy at saturated sources). Recorded for the lead, section 7 |
| `sim-world-pilot-1` | no | contracts/defs.ts, defs loader | resolved `c2e2ed3` | `ScenarioDef.resources` (part instance id -> resource id -> kg at the start), validated by the loader against the scenario's vehicle and the parts' capacities |
| `sky-lighting-2` | no | ARCHITECTURE 17 (lead) | **declined, Escalate: lead** | Raising the sky VRAM line to 0.15 GB for the 2048 Milky Way cube is the lead's decision; the 1024 default keeps the line |

## 2. API and contract changes made in wave 2

Everything is additive unless "Migration" says otherwise. RENDER_API section 18 has the same list for
feature authors.

| Change | Where | Affects | Migration |
|---|---|---|---|
| `ScenarioDef.resources?: Record<partInstanceId, Record<ResourceId, kg>>`; `validateLibrary` checks it (part of the vehicle, resource the part holds, 0 <= kg <= capacity x (1 + 1e-6)) | `contracts/defs.ts`, `defs/loader.ts` | sim-world-pilot (applies it in `createSim`), the `qa-*` scenarios | None: files without the field load as before. The FakeSim ignores it |
| `FakeSimOptions.location` (stand the 'pad' / 'ascent' scenes anywhere), `FAKE_SIM_DEFAULT_UT` | `src/core/fakes/fakeSim.ts` | labs | None |
| `SharedResourceMap`: `'gbuffer.albedo'`, `'gbuffer.normal'`, `'gbuffer.material'`; `SceneBindingSet` `'gbuffer'` | `contracts/render.ts`, `src/render/core/{resources,renderer,sceneBindings}.ts` | ocean; anyone after lighting | None. Never in a bind group set inside `drawGBuffer` |
| `SharedResourceMap['ocean.wetness']`, `OCEAN_WETNESS_SLOTS` (8), `OCEAN_WETNESS_BYTES` (400); set `'oceanWetness'`; mesh G-buffer shader applies the wet line (`hullWetness`) | `contracts/render.ts`, `resources.ts`, `sceneBindings.ts`, `mesh/meshSystem.ts` (`createMeshSystem` takes `resources`; batch bind group binding 2) | ocean (publishes), vehicle-pad | None |
| `SharedResourceMap['post.reactive']`; `RenderFeature.requires` accepts `'post.reactive'`; TAA binding 5; `PostInputs.exposureRatio / reactive` | `contracts/render.ts`, `renderer.ts`, `post/postProcess.ts`, `resources.ts` | ocean, later vfx | None |
| `CoreApi.addEmissiveHint(luminance, coverage)`; `MeterInput.emissive`, `EmissiveHint`, `EMISSIVE_FULL` | `coreApi.ts`, `renderer.ts`, `post/exposure.ts` | vfx | None |
| Interior metering: log-average, whole near histogram; `histogramStats(h, n, litRangeEv)` returns `logMean` | `post/exposure.ts` | cockpit | None; a cabin with sun patches is exposed several stops brighter |
| Cloth sun-shadow lookup with the flipped normal; planetshine x baked AO | `lighting/deferred.ts` | cockpit, vehicle-pad | None; surfaces with baked AO < 1 get that much less planetshine |
| `INTERIOR_CASCADE_RADIUS` = 6 (cascade 0 of an interior camera) | `shadows/cascadeMath.ts` | cockpit | None |
| `LabPlanetOptions.seabedDepth?: number \| 'sheet'`, default `'sheet'` (was a number, default 30); lab `?seabed=<m>` | `lab/labPlanet.ts`, `labs/render-core` | ocean lab | Pass `seabedDepth: 30` for the old sand floor |
| `BandRasterJob.reaches(x, y, z, reach)` (required member, implemented by the baker) | `src/terrain/amplification/types.ts`, `baker.ts`, `amplification/common.ts` | amplification model authors | A custom job implementation must provide it |
| `Sampler.resample(...)`, `SampledCurve.c / s / maxError / initial`, `MapStats.reuse`; lines carry 10-12 % more vertices | `src/map/{sampler,scene,controller}.ts` | app shell | None |
| Audio: `propagation.attach.maxDistance` 250 -> 3000 m | `data/defs/audio/mix.json` | app shell | None |
| Earth bake: despike pass in the regional height bake, `bake.py despike`, verifier check "height needles" | `tools/bake/earth/{heights,pipeline,bake,verify}.py` | whoever re-bakes | A later `bake.py region` re-bakes the regional water mask, albedo and land cover (stale by bookkeeping) |
| RENDER_API: section 17 "Recipes" (half-resolution volume, seabed and sheet inputs, moving shadow, shared resources, qualityScale), section 18 "Changes in wave 2" | `docs/RENDER_API.md` | everyone | - |

Lead-owned data touched: **none** (`data/defs/bodies`, the site file and `visuals/shared` are unchanged).
Baked data touched: `data/tiles/earth/height` levels 8-12 (56 of 10,499 regional files) and
`data/tiles/earth/manifest.json` (terrain-render-2). A backup of the regional heights, the bake state and the
old manifest is in `data/cache/earth/backup-height-regional` (282 MB): delete it when the pad views are
accepted.

## 3. Wave-1 numbers re-measured on the quiet machine (Job 2)

Run 2026-11-10 17:00-17:10 local, before any wave-2 package had started heavy work: no heavy slot held but
mine, 39 GB free, whole-machine CPU busy 6 % during the terrain bench. Everything through the gate; perf
specs under `withGpuLock`, 2560 x 1440. Raw logs: `out/core-support/perf-1.log`, `vitest-1.log`,
`terrain-bench-1.log`, `terrain-perf-1.log`, `map-perf-2.log` (git-ignored).

| Package | Line (source) | Required | Wave 1 (loaded) | Quiet machine | Verdict |
|---|---|---|---|---|---|
| render-core | Core fixed GPU, p99 with a 7 ms ballast (ARCH 17.1) | 3.0 ms | 0.51 | **0.526** (AO + contact 0.093, lighting 0.172, TAA 0.110, bloom 0.045, tonemap + histogram 0.047, copies + pyramid 0.058) | met |
| render-core | 1.7 M triangle scene, G-buffer p99 + amortised shadows | 2.0 ms | 0.39 | **0.633** (0.394 + 0.239) | met |
| render-core | CPU frame, lab | 2 ms p99 | 0.39-1.08 | **0.57** (p50 0.30) | met |
| render-core | Governor: quality first, resolution second, 60 fps held | qualitative | passed | passed: quality at frame 6, resolution at frame 13, settled GPU p99 8.71 ms, 0 frames over 33 ms | met |
| flight-ui | HUD main-thread cost per frame (ARCH 17: UI 0.5 ms) | 0.5 ms mean | 0.09 / 0.11 | **0.116** (low orbit + node) / **0.140** (powered ascent) | met |
| flight-ui | Navball GPU p99, 512 texture, with ballast (ARCH 17.1) | 0.05 ms | 0.008 | **0.0082** / 0.0083 | met |
| map-view | Overlay GPU p99, 8 patches + 20 debris (ARCH 17.1) | 0.1 ms | 0.013 | **0.009** overview, **0.012** close-up | met |
| map-view | Overlay CPU p99, overview | 0.5 ms | 0.475 | 0.425 before, **0.340** after the fix below | met |
| map-view | Overlay CPU p99, Earth close-up | 0.5 ms | 0.560 | **0.525: missed on the quiet machine too**; **0.390** after the fix | met after fix |
| audio | `update()` main-thread cost (no line; live spec) | - | p50 0.05, p99 0.21, max 0.76 | p50 **0.06**, p99 **0.13**, max 0.45 ms (17:33, other agents starting) | - |
| terrain-core | Analytic `heightAt`, lambdaMin 100 m | 3 us | 0.42 / 0.30 | **0.56** (Moon) / **0.38** (Earth) | met |
| terrain-core | Cached collision query | 0.5 us | 0.055 / 0.050 | **0.055** / **0.049** | met |
| terrain-core | First collision query in a fresh area | 0.2 ms each | max 203 / 119 us | median 12.9 / 10.7 us, p99 33.7 / 23.9 us, max **194** / **216** us; `TERRAIN_PERF=1 collision.test.ts` passes (10 of 10) | met at p99; the single worst query of the Earth bench run is 8 % over |
| terrain-core | Tile bake, geometry + normal map (ARCH 17: 6-12 ms per tile) | 12 ms | 6.4-9.0 at L6-10, 13.3-19.3 at L13+ | Moon L6 / 10 / 13 / 16 / 18: 6.0 / 9.9 / **15.4 / 16.7 / 13.4**; Earth L6 / 10 / 13 / 16 / 20: 8.7 / **12.3 / 13.7 / 20.3 / 18.8** ms | **not met at level 13 and deeper** |
| all | `npx vitest run` (whole tree at 17:08) | green | 657 passed | 58 files, 657 tests, 53 s | met |
| terrain-core | Coverage-edge continuity on both real tile sets (`realData.test.ts`, verbose) | pass | pass | 10 of 10 (Moon L7-12, Earth L8-12), again after the height repair | met |

**Map-view close-up fix** (`1be550f`). The scene builder keeps each line's breakpoints (parameters with
their cos / sin) under the line id and, while the conic keeps its shape, evaluates the curve at them for the
new view and verifies the exact chord error of every piece (`Sampler.resample`): no refinement, no heap, no
trigonometry. A piece over the tolerance, a changed eccentricity or an uncovered range falls back to a fresh
sampling, so every frame is still within 0.3 px (0.9 px faint lines). A whole revolution may start anywhere;
a zoomed-out view is re-sampled. Node A/B: overview p50 0.090 -> 0.055 ms, close-up 0.124 -> 0.076 ms.
Browser, under the lock: overview p99 0.425 -> 0.340, close-up 0.525 -> 0.390 ms. Tests:
`tests/unit/map-view/breakpointReuse.test.ts` (8).

**Terrain bake budget: not met, not closed.** Profile of an Earth level-16 bake (19.8 ms): gradient noise
19 %, the model's band raster 14 %, the evaluator's land-cover and data-scale reads 18 %, normal-map
assembly 8 %, the rest spread thin. No single hot spot; the two measures that would close the gap (the
geometry band from the per-texel raster, or the high band on the GPU in terrain-render) restructure the
baker and the collision-equals-render identity with it. What it costs the game: 8 workers at 20 ms are 400
tiles per second against an upload budget of 8 tiles per frame (480 per second), so streaming is bounded by
uploads nearly as much as by bakes; terrain-render's "zero frames over 33 ms during a descent" and pop
detector are the acceptance that would show a real shortfall. The request terrain-render-1 fix removes the
far land-cover reads from level 14 on (not measurable under the present machine load).

**What else was taken from the wave-1 "known limits"** (the rest is recorded as it stands in each hand-off):

| Item | Decision |
|---|---|
| audio: chase camera beyond 250 m hears no structure-borne share | Fixed: 3000 m (the chase rig's zoom range), tests in `mapping.test.ts`, `model.test.ts` |
| map-view: close-up CPU line | Fixed (above) |
| terrain-core: bake budget | Not met, reasons above |
| terrain-core: bake `complete` flag from level 14 | Fixed (terrain-render-1) |
| bake-earth: corrupt near-shore survey values | Fixed for the heights (terrain-render-2) |
| render-core: cascades of 8 km and below get no receiver fit (needs a local elevation range from the terrain) | Not built: no request from terrain-render; to do when the lunar descent at low sun is reviewed |
| render-core: resolve loses energy of sub-pixel sources under jitter; rim of a new bright source takes 2 s | Open, recorded for the lead (sky-lighting-1) |
| render-core: GTAO grain and speckled penumbrae in frozen-noise screenshots | Unchanged; interior cascade halved (cockpit-4) |
| render-core: local lights and planetshine unshadowed | Planetshine gated by baked AO (cockpit-2); local lights unchanged |
| render-core: bloom strength and exposure compensation tuned on lab scenes | For the lead, in the integrated game |
| flight-ui, map-view: remaining limits (HUD text at 10 Hz, at-intercept gap at SOI exit, `MapView.mount`) | Unchanged, as decided by the lead |
| audio: not listened to by a human; surface ambience follows the active vessel | Unchanged; for the lead |

## 4. Cross-feature checks (Job 3)

Lab: `labs/integration` (`/labs/integration/?scene=<FakeScene>&features=all|<list>&without=<list>` plus
every camera / renderer parameter of `createLabApp`; `sim=real&scenario=<id>` uses `createSim` of `src/sim`
when it exists). It discovers `src/render/<package>/index.ts` with `import.meta.glob`, builds each package
through an adapter (`labs/integration/features.ts`), registers the features one at a time and **switches
off a feature that reports an error while starting up or later** (its errors move to
`window.__integration.problems`), so work in progress in one package does not take the others' checks
down; the LabPlanet stands in while the terrain is absent or switched off. Handle: `window.__integration`
(`loaded`, `available`, `problems`, `quarantined`, `handles`, camera helpers `surface`, `aboveGround`,
`viewBodyAtPhase`, `watchVesselFrom`, `lookFromTo`, `lookNearSun`, `project`, `setSun`, `showGBuffer`,
`setBallast`, `cascadeLog`; query `noshadow=<packages>` for shadow A/B, `ballast=1`, `probe=casters`).

Specs: `tests/browser/integration/` (`helpers.ts`: `openIntegration`, `requireFeatures` (skips a check
with the missing package's name), `expectClean`, frame differences, spike and period detectors, `record`
into `out/core-support/integration-results.json`). Screenshots: `out/screens/integration/`.

| Check | Spec | Needs | State |
|---|---|---|---|
| lab itself | `lab.spec.ts` | - | passes; reports which packages load |
| (a) far / near water | not written yet | terrain, ocean | **to do**: climb 2 m - 400 km (frame-difference spikes), shoreline at 200 m, forward vs deferred at fadeStart (`handles['ocean.createOceanFeature'].debug.forceNearFieldOff`), `without=ocean` |
| (b) transparents through clouds | not written yet | atmosphere, vfx | **to do** |
| (c) distant shadows with real terrain | not written yet | terrain | **to do**: `noshadow=terrain` A/B at the terminator from 20,000 and 5,000 km, approach through 1,500 km, pad and lunar-orbit stability (`periodStrength`) |
| (d) coverage edges | `terrain.spec.ts` | terrain | written; first run timed out in `waitIdle` while the terrain package was still being written (its `isIdle` never came true in the lab). Re-run when terrain-render is delivered |
| (e) image decode | `terrain.spec.ts` | terrain | written; first run on the unfinished terrain showed level-2 imagery only (correlation with the reference tile -0.05). Re-run when delivered |
| (f) exposure and HDR | `exposure.spec.ts` | sky (sun test), vehicle (vehicle test) | crescent Earth: EV100 15.07 against sunny-16 15.07, NaN 0; sun into a dark-adapted frame: EV -3.0 -> 15.08, peak 59,045 (HDR_MAX 60,000), NaN 0; with ocean, sky, atmosphere (unfinished), vfx loaded. Vehicle against black space: waiting for vehicle-pad. Screenshots `exposure-*.png` |
| (g) summed budget | `budget.perf.spec.ts` | all | written (seven checkpoints, attribution mode, ballast for partial frames, table to `out/core-support/budget.md`); not run with features yet |

## 5. Problems filed against wave-2 packages

| Request | Owner | Status | One line |
|---|---|---|---|
| (none yet: every package the checks touch was still being written when they ran) | | | |

Seen in the lab while packages were unfinished (not filed; to be re-checked when each is delivered):
vehicle: `createSiteFeature` not exported from `src/render/vehicle/index.ts`, "part ... has no visual
definition" for every part; atmosphere: "earth.clouds: unknown cloud parameter extinctionMin / extinctionMax";
terrain: WGSL "'meta' is a reserved keyword" (fixed by its owner since).

## 6. What the lead should look at first when integrating `src/app`

1. **Exposure rules changed in wave 2**: interior metering (log-average), emissive hints, interior shadow
   cascade. Tune `CameraState.exposureCompensation` of the cockpit rig and the bloom strength on the
   integrated game, not in labs.
2. **The resolve** (declined `sky-lighting-1`): sub-pixel bright geometry loses energy under jitter (25 % kept
   at 1.4 px lit width) and star pixels ripple by up to 10 % per frame for a static camera. A proper fix is a
   resolve with per-pixel accumulation and a clip box over the jitter cycle. `'post.reactive'` exists for
   evolving patterns.
3. **Decision asked of the lead** (`sky-lighting-2`): Milky Way cube at 2048 per face costs 0.1 GB more VRAM
   than the sky's 0.1 GB line; 1024 is the default.
4. **Earth data**: regional heights despiked (manifest `ab20fdfc579d4015`); regional water mask, albedo and
   land cover are stale by the bake's bookkeeping but unchanged in content that shows. Delete
   `data/cache/earth/backup-height-regional` when satisfied.
5. **Terrain bake budget** (section 3) is the one wave-1 line that is still missed.
6. **Integration checks** (section 4): run `npx playwright test tests/browser/integration --project=functional`
   and the perf project through the gate once all packages are delivered; (a), (b), (c) are not written.
7. Wiring notes: publish nothing for `'post.reactive'` / `'gbuffer.*'` yourself (the core does); register the
   ocean before features that read `'ocean.wetness'` is not needed (the mesh system reads the key every
   frame); `createSkyFeature()`, `createAtmosphereFeature()`, `createOceanFeature()`,
   `createVesselVisualFeature()`, `createVfxFeature(ctx)`, `createTerrainFeature(ctx, () => terrain)` are the
   signatures the lab's adapters use (`labs/integration/features.ts`).

## 7. Journal

- 2026-11-10 17:00. Start. Read the binding documents, the wave-1 hand-offs of my five packages, the render
  contract. Waiter on the eight markers. Machine idle: all four wave-1 perf specs, the whole unit suite, the
  terrain bench (section 3).
- 17:10-17:17. Map-view close-up fixed (`1be550f`).
- 17:17-17:30. `ocean-1`, `ocean-2`, `ocean-3` (blocking). RENDER_API sections 17 and 18.
- 17:30-17:35. Audio attach range. Terrain bake profiled (not closed).
- 17:35-18:05. Integration lab, helpers, lab spec, budget spec, exposure check (f), terrain checks (d), (e).
- 18:06-18:55. `terrain-render-2` (blocking): despike of the regional Earth heights (dry run, backup, two
  repair runs, verify 42 of 42).
- 18:45-19:17. `cockpit-3` (blocking), `cockpit-1`, `cockpit-2`, `cockpit-4`, `vfx-1`, `terrain-render-1`,
  `terrain-render-3` (declined).
- 19:17-19:31. `ocean-4` (reactive mask), `sky-lighting-1` (declined after a withdrawn attempt),
  `sky-lighting-2` (escalated). Marker `sky-lighting.done` exists; hand-offs of cockpit, ocean, sky-lighting
  exist.
- State at 19:31: queue empty; render-core browser suite 28 of 28, render-core / core unit tests 112,
  terrain-core 86, map-view 73, audio 75; `npm run typecheck` clean for my paths.
