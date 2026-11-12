# Hand-off: core-support (running log)

Wave-2 maintainer of the finished wave-1 code (`src/core`, `src/render/core`, `src/terrain`, `src/ui`,
`src/input`, `src/camera`, `src/map`, `src/audio`, the tools incl. the bakes, the browser harness, the shared
docs). This file is kept current so that a successor can continue from it: the tables are the state, the
journal at the end is the history.

Starting point: `docs/handoff/lead-baseline.md` (commit `6912e11`).

Differences between my brief and what I was told at start (the task wins):

- The request waiter runs against the marker files `out/wave2-done/<package>.done`, not the hand-offs:
  `node tools/dev/wait-requests.mjs --open --until out/wave2-done/terrain-render.done,...,out/wave2-done/sim-world-pilot.done --timeout 540`.
  It reports ANY open request, also the ones I filed against wave-2 packages and the ones between two
  other packages, and returns at once while one is open.
- Heavy commands go through `tools/dev/heavy.mjs` (cpu / gpu / bake); it replaces the "8 below-normal
  workers" rule. One heavy command at a time.
- The wave-1 requests were already answered by the lead.
- **The scratchpad directory is shared between the agents of this session**: another agent overwrote
  scripts of mine there. Keep helper scripts under a sub-directory of your own.
- `PROMPT.txt` carries an uncommitted "expansion" section (solar system, multiplayer, fleet) and
  `docs/ARCHITECTURE_V2.md` is untracked: neither is part of this package; nothing here acts on them.

## 1. Requests

Twenty-three answered; none against my paths is open. Details under `## Resolution` in each file.

| Request | Blocking | Against | Result | One line |
|---|---|---|---|---|
| `ocean-1` | yes | contracts/render.ts, render core | resolved `b812ec4` | `'gbuffer.albedo'` / `'gbuffer.normal'` / `'gbuffer.material'` (live RT0-RT2, readable from `drawWater` on), binding set `gbuffer` |
| `ocean-2` | yes | render core lab (LabPlanet) | resolved `9debd1f` | Inside `'ocean.nearField'.fadeStart` the LabPlanet seabed follows the sheet (`seabedDepth: 'sheet'`, new default) |
| `ocean-3` | yes | contracts/render.ts, render core | resolved `9debd1f` | `'ocean.wetness'` (uniform, 400 bytes, up to 8 vessels at the water), binding set `oceanWetness`; the mesh system applies the wet line |
| `ocean-4` | no | TAA resolve, contracts | resolved `2cc2aea` | `'post.reactive'` mask (`requires: ['post.reactive']`): history weight x (1 - value). The TAA history is rescaled by the exposure ratio |
| `ocean-5` | no | data/defs/bodies/earth.json (lead) | **declined, Escalate: lead** | More swell components for the 1.5-15 km views: the list is shared with the splashdown physics |
| `cockpit-1` | no | deferred lighting | resolved `113438e` | Cloth looks the sun shadow up with the normal turned to the sun |
| `cockpit-2` | no | deferred lighting | resolved `113438e` | Planetshine x baked AO (RT0.a) |
| `cockpit-3` | yes | exposure | resolved `113438e` | Interior metering = log-average of the near histogram |
| `cockpit-4` | no | shadow cascades | resolved `03242a3` | Interior camera: cascade 0 is 6 m instead of 12 m |
| `vfx-1` | no | exposure | resolved `03242a3` | `coreOf(ctx).addEmissiveHint(luminance, coverage)` |
| `vfx-2` | no | src/core/fakes/fakeSim.ts | resolved `0f1979d` | FakeSim engines keep time since ignition and since shutdown (the plume in labs was a permanent start-up flash) |
| `vfx-3` | no | exposure | resolved `aa8fd79` | Not the adaptation law (it was fast enough): a lit area brighter than the prior now sets the target from 2 % of the frame instead of 10 %. Night lift-off: EV100 16.5 from T+2 s (was 1.6 / 4.6 / 13.3) |
| `terrain-render-1` | no | src/terrain | resolved `37f6f54` | Bakes of prepared tiles are complete from level 14 on |
| `terrain-render-2` | yes | tools/bake/earth, Earth height tiles | resolved `b8ea6a7` | Needles (up to 1,135 m) in the regional Earth heights removed: despike pass, repair of the stored tiles, verifier check. Manifest contentHash `ab20fdfc579d4015` |
| `terrain-render-3` | no | Earth night layer | **declined** | The 1.2 km blocks are the instrument footprint in the published source |
| `sky-lighting-1` | no | TAA resolve | **declined** | Energy loss of sub-pixel bright geometry and the jitter-cycle ripple need a redesign of the resolve (a linear blend for still pixels creates energy at saturated sources) |
| `sky-lighting-2` | no | ARCHITECTURE 17 (lead) | **declined, Escalate: lead** | Sky VRAM line 0.1 -> 0.15 GB for the 2048 Milky Way cube |
| `sim-world-pilot-1` | no | contracts/defs.ts, defs loader | resolved `c2e2ed3` | `ScenarioDef.resources` (part instance id -> resource id -> kg at the start), validated by the loader |
| `sim-world-pilot-2` | no | ARCHITECTURE 18.2 (lead) | **declined, Escalate: lead** | The browser mission takes about 45 minutes, not 20-25 |
| `atmosphere-clouds-1` | no | applyAtmosphere, `'clouds.depth'` | resolved `ff1beb8` | `'clouds.depth'` is rg32float (begin, end of the cloud on the pixel's ray); attenuation by the position inside that span |
| `atmosphere-clouds-2` | no | TAA | **declined** | No second velocity source; documented statement in RENDER_API 13 (the clip is the answer for volumetrics, `'post.reactive'` where it is not enough) |
| `atmosphere-clouds-3` | yes | deferred lighting, `'clouds.shadowMap'` | resolved `b5dceb7` | Near cloud shadow is depth-resolved (r, g, b of the map); new chunk `cloud_shadow`; surfaces above a deck are no longer in its shade |
| `atmosphere-clouds-4` | no | `'atmosphere.aerialPerspective'`, applyAtmosphere | **declined** (plan for the lead) | Per-channel transmittance for transparents needs a fourth texture in the `transparency` set, which collides with the delivered cockpit's fixed binding 19 |

Not mine and left alone: `atmosphere-clouds-5` (atmosphere to ocean, about a deleted ocean spec).

## 2. API and contract changes made in wave 2

Everything is additive unless "Migration" says otherwise. RENDER_API section 18 has the render part of this
list for feature authors.

| Change | Where | Affects | Migration |
|---|---|---|---|
| `ScenarioDef.resources?`; `validateLibrary` checks it | `contracts/defs.ts`, `defs/loader.ts` | sim-world-pilot, the `qa-*` scenarios | None |
| `FakeSimOptions.location`, `FAKE_SIM_DEFAULT_UT`; engine clocks (`ignitionAge`, `shutdownAge`) advance | `src/core/fakes/fakeSim.ts` | labs | None |
| `SharedResourceMap`: `'gbuffer.albedo'`, `'gbuffer.normal'`, `'gbuffer.material'`; binding set `'gbuffer'` | `contracts/render.ts`, render core | ocean; anyone after lighting | None. Never in a bind group set inside `drawGBuffer` |
| `'ocean.wetness'`, `OCEAN_WETNESS_SLOTS` (8), `OCEAN_WETNESS_BYTES` (400); set `'oceanWetness'`; mesh G-buffer shader applies the wet line | `contracts/render.ts`, `mesh/meshSystem.ts` (`createMeshSystem` takes `resources`) | ocean (publishes), vehicle-pad | None |
| `'post.reactive'`; `RenderFeature.requires` accepts it; TAA history rescaled by the exposure ratio | `contracts/render.ts`, `renderer.ts`, `post/postProcess.ts` | ocean, later vfx, atmosphere | None |
| `'clouds.shadowMap'` is read depth-resolved (r = layer optical depth, g = where the cloud begins along the projection direction, b = mean extinction); chunk `cloud_shadow` (`cloudShadow(pos, bodyIndex, up, r, sunDir)`) | `contracts/render.ts`, `shaders/chunksLighting.ts`, `lighting/deferred.ts` | atmosphere (publisher), cockpit and ocean (own copies of the old lookup) | A single-channel map casts no near shadow. Forward-lit shaders: `#include "cloud_shadow"` |
| `'clouds.depth'` is rg32float: r = begin, g = end of the cloud on the pixel's ray (was r32float, mean distance) | `contracts/render.ts`, `resources.ts`, `applyAtmosphere` | atmosphere (publisher), sky (reads `r < 3.0e38`) | Publisher writes both; r alone gives a step at r |
| `CoreApi.addEmissiveHint(luminance, coverage)`; `MeterInput.emissive`, `EmissiveHint`, `EMISSIVE_FULL` | `coreApi.ts`, `renderer.ts`, `post/exposure.ts` | vfx | None |
| Exposure target: `LIT_FULL_BRIGHT` = 2 % (a lit area brighter than the prior takes over from 2 % of the frame; dimmer ones keep the ramp to 10 %) | `post/exposure.ts` | everything bright in a dark frame | None; such frames are exposed for the bright area sooner |
| Interior metering: log-average, whole near histogram; `histogramStats(h, n, litRangeEv)` returns `logMean` | `post/exposure.ts` | cockpit | None |
| Cloth sun-shadow lookup with the flipped normal; planetshine x baked AO | `lighting/deferred.ts` | cockpit, vehicle-pad | None |
| `INTERIOR_CASCADE_RADIUS` = 6 | `shadows/cascadeMath.ts` | cockpit | None |
| `LabPlanetOptions.seabedDepth?: number \| 'sheet'`, default `'sheet'`; lab `?seabed=<m>` | `lab/labPlanet.ts` | ocean lab | Pass `seabedDepth: 30` for the old sand floor |
| `BandRasterJob.reaches(x, y, z, reach)` (required member) | `src/terrain/amplification/types.ts`, `baker.ts` | amplification model authors | A custom job implementation must provide it |
| `Sampler.resample(...)`, `SampledCurve.c / s / maxError / initial`, `MapStats.reuse` | `src/map` | app shell | None |
| Audio: `propagation.attach.maxDistance` 250 -> 3000 m | `data/defs/audio/mix.json` | app shell | None |
| Earth bake: despike pass, `bake.py despike`, verifier check "height needles" | `tools/bake/earth` | whoever re-bakes | A later `bake.py region` re-bakes the regional water mask, albedo and land cover (stale by bookkeeping) |
| RENDER_API: section 17 "Recipes", section 18 "Changes in wave 2", chunk table (`cloud_shadow`), TAA statement about composited pixels | `docs/RENDER_API.md` | everyone | - |

Lead-owned data touched: **none**. Baked data touched: `data/tiles/earth/height` levels 8-12 (56 of 10,499
regional files) and `data/tiles/earth/manifest.json` (terrain-render-2). A backup of the regional heights,
the bake state and the old manifest is in `data/cache/earth/backup-height-regional` (282 MB): delete it when
the pad views are accepted.

## 3. Wave-1 numbers re-measured on the quiet machine (Job 2)

Run 2026-11-10 17:00-17:10 local, before any wave-2 package had started heavy work: no heavy slot held but
mine, 39 GB free, whole-machine CPU busy 6 %. Everything through the gate; perf specs under `withGpuLock`,
2560 x 1440. Raw logs: `out/core-support/perf-1.log`, `vitest-1.log`, `terrain-bench-1.log`,
`terrain-perf-1.log`, `map-perf-2.log` (git-ignored).

| Package | Line (source) | Required | Wave 1 (loaded) | Quiet machine | Verdict |
|---|---|---|---|---|---|
| render-core | Core fixed GPU, p99 with a 7 ms ballast (ARCH 17.1) | 3.0 ms | 0.51 | **0.526** (AO + contact 0.093, lighting 0.172, TAA 0.110, bloom 0.045, tonemap + histogram 0.047, copies + pyramid 0.058) | met |
| render-core | 1.7 M triangle scene, G-buffer p99 + amortised shadows | 2.0 ms | 0.39 | **0.633** (0.394 + 0.239) | met |
| render-core | CPU frame, lab | 2 ms p99 | 0.39-1.08 | **0.57** (p50 0.30) | met |
| render-core | Governor: quality first, resolution second, 60 fps held | qualitative | passed | passed: quality at frame 6, resolution at frame 13, settled GPU p99 8.71 ms, 0 frames over 33 ms | met |
| flight-ui | HUD main-thread cost per frame (UI 0.5 ms) | 0.5 ms mean | 0.09 / 0.11 | **0.116** / **0.140** | met |
| flight-ui | Navball GPU p99, 512 texture, with ballast | 0.05 ms | 0.008 | **0.0082** / 0.0083 | met |
| map-view | Overlay GPU p99, 8 patches + 20 debris | 0.1 ms | 0.013 | **0.009** overview, **0.012** close-up | met |
| map-view | Overlay CPU p99, overview | 0.5 ms | 0.475 | 0.425 before, **0.340** after the fix below | met |
| map-view | Overlay CPU p99, Earth close-up | 0.5 ms | 0.560 | **0.525: missed on the quiet machine too**; **0.390** after the fix | met after fix |
| audio | `update()` main-thread cost (no line) | - | p50 0.05, p99 0.21 | p50 **0.06**, p99 **0.13**, max 0.45 ms | - |
| terrain-core | Analytic `heightAt`, lambdaMin 100 m | 3 us | 0.42 / 0.30 | **0.56** (Moon) / **0.38** (Earth) | met |
| terrain-core | Cached collision query | 0.5 us | 0.055 / 0.050 | **0.055** / **0.049** | met |
| terrain-core | First collision query in a fresh area | 0.2 ms each | max 203 / 119 us | p99 33.7 / 23.9 us, max **194** / **216** us; `TERRAIN_PERF=1 collision.test.ts` passes | met at p99; one query of the Earth bench run 8 % over |
| terrain-core | Tile bake, geometry + normal map (6-12 ms per tile) | 12 ms | 6.4-9.0 at L6-10, 13.3-19.3 at L13+ | Moon L6 / 10 / 13 / 16 / 18: 6.0 / 9.9 / **15.4 / 16.7 / 13.4**; Earth L6 / 10 / 13 / 16 / 20: 8.7 / **12.3 / 13.7 / 20.3 / 18.8** ms | **not met at level 13 and deeper** |
| all | `npx vitest run` | green | 657 passed | 17:08: 58 files, 657 tests. 20:13 (with the wave-2 packages' tests): 88 files, 924 tests | met |
| terrain-core | Coverage-edge continuity on both real tile sets (`realData.test.ts`) | pass | pass | 10 of 10 (Moon L7-12, Earth L8-12), again after the height repair | met |

**Map-view close-up fix** (`1be550f`): the scene builder keeps each line's breakpoints and, while the conic
keeps its shape, evaluates the curve at them for the new view and verifies the exact chord error of every
piece (`Sampler.resample`); a piece over the tolerance, a changed eccentricity or an uncovered range falls
back to a fresh sampling. Tests: `tests/unit/map-view/breakpointReuse.test.ts` (8).

**Terrain bake budget: not met, not closed.** Profile of an Earth level-16 bake (19.8 ms): gradient noise
19 %, the model's band raster 14 %, the evaluator's land-cover and data-scale reads 18 %, normal-map
assembly 8 %, the rest spread thin. No single hot spot; the measures that would close the gap (geometry
band from the per-texel raster, or the high band on the GPU in terrain-render) restructure the baker and
the collision-equals-render identity with it. 8 workers at 20 ms are 400 tiles per second against an
upload budget of 480 per second; the terrain renderer measures 22.6 ms per bake in the integration lab
(`debug.stats().stream.bakeMs`). terrain-render's descent and pop specs are the acceptance that would show
a real shortfall.

**Wave-1 "known limits" walked** (the rest stands as recorded in each hand-off; "Changes in wave 2"
sections were appended to the map-view, audio, bake-earth, terrain-core and render-core hand-offs):

| Item | Decision |
|---|---|
| audio: chase camera beyond 250 m hears no structure-borne share | Fixed: 3000 m |
| map-view: close-up CPU line | Fixed |
| terrain-core: bake budget | Not met, reasons above |
| terrain-core: bake `complete` flag from level 14 | Fixed (terrain-render-1) |
| bake-earth: corrupt near-shore survey values | Fixed for the heights (terrain-render-2) |
| render-core: cascades of 8 km and below get no receiver fit | Not built: no request; to do when the lunar descent at low sun is reviewed |
| render-core: resolve loses energy of sub-pixel sources under jitter | Open, for the lead (sky-lighting-1) |
| render-core: local lights unshadowed; GTAO grain | Unchanged |
| render-core: bloom strength and exposure compensation tuned on lab scenes | For the lead, in the integrated game |
| flight-ui, map-view: HUD text at 10 Hz, at-intercept gap at SOI exit, `MapView.mount` | Unchanged, as decided by the lead |
| audio: not listened to by a human | Unchanged; for the lead |

## 4. Cross-feature checks (Job 3)

Lab: `labs/integration` (`/labs/integration/?scene=<FakeScene>&features=all|<list>&without=<list>` plus the
camera / renderer parameters of `createLabApp`). It discovers `src/render/<package>/index.ts` with
`import.meta.glob`, builds each package through an adapter (`labs/integration/features.ts`), registers the
features one at a time and **switches off a feature that reports an error** (its errors move to
`window.__integration.problems`), so work in progress in one package does not take the others' checks down.
The FakeSim flies the REAL vehicle (vessel facade, staged per scene: pad 0, ascent 1, low orbit 4, translunar
and lunar orbit 5, lunar surface 6, reentry 8, chutes 10; `&vehicle=`, `&stage=`), `&throttle=` burns the
staged engines, `&at=lat,lon` puts the pad and ascent scenes anywhere, `&sim=real&scenario=` uses
`createSim`. Handle `window.__integration`: `loaded`, `problems`, `quarantined`, `handles` (every factory's
return value, for debug hooks), cameras (`surface`, `aboveGround`, `viewBodyAtPhase`, `watchVesselFrom`,
`watchVesselAlong`, `watchSiteFromVessel`, `lookFromTo`, `lookNearSun`, `sitInCockpit`), `project`,
`projectVessel`, `setSun`, `showGBuffer`, `setEnabled(package, on)`, `setBallast`, `cascadeLog`; query
`noshadow=<packages>`, `ballast=1`, `probe=casters`.

Specs: `tests/browser/integration/`; numbers of every run in `out/core-support/integration-results.json`;
screenshots (all looked at) in `out/screens/integration/`. Run, through the gate:
`npx playwright test tests/browser/integration --project=functional` (about 15 minutes) and
`--project=perf` for the budget.

State on 2026-11-10 at 22:45. Finished (done markers): cockpit, vehicle-pad, sky-lighting, sim-world-pilot,
ocean. Still changing their code: terrain-render, atmosphere-clouds, vfx: a row below can move again
until they finish; re-run the suite then.

| Check | Spec | Result | Numbers |
|---|---|---|---|
| lab | `lab.spec.ts` | passes when no package is mid-edit | all seven packages load |
| (a) climb 2 m - 400 km, open ocean, frozen time | `water.spec.ts` "climb" (251 steps of 5 %; terrain + ocean + sky, and every package) | **pass** | no step above 3 x its neighbours, pixel by pixel or of 16 px block averages; with clouds (clear place of the cloud map, 12 N 33 W) none inside the cloud shell either. Control test: a 5 % brightness step is reported (block-average mean 1.71 against 0.46); the near field vanishing in one step is NOT seen by this method (the waves' own step-to-step change is as large) and is covered by the next row |
| (a) forward = deferred at fadeStart | `water.spec.ts` "fadeStart" (1, 6, 14 km up; towards and away from the sun; with and without the atmosphere; a second take of the same frame removes pixels that change by themselves) | **pass after the ocean's later commits** (`ocean-cs-1`, closed) | last 50 m inside fadeStart from 1 km up: 0.73-0.74 % without the atmosphere, 0.07-0.32 % with it (was 4.41 % / 2.90 %); 6 km: 0.41 %, 14 km: 0.15-0.38 %; fadeStart to fadeEnd 0.1 % without the atmosphere. **Open observation**: with the real clouds between camera and sea (6 and 14 km up) 1-7 % of the pixels from fadeStart outwards, beyond fadeEnd too, differ by more than 2 % between the frame with and without the near field (mean under 0.25 %): cloud-edge pixels whose resolve reacts to the sea's depth; not a ring in the water, not traced further; held by its mean in the spec |
| (a) shoreline at 200 m over the real seabed | `water.spec.ts` "shoreline" | **pass** | opaque depth under the water = real seabed within 0.7 m at 46 points 3-40 m deep; refraction changes the image by 2-4 % in the shallows, 0.2-0.4 % over deep water, 0 on land; foam (the most of five instants a second apart: the swash comes and goes with the run-up) 0.50 on the waterline against 0.07 offshore |
| (a) the sea without the ocean feature | `water.spec.ts` "without the ocean" | **pass after `terrain-render-cs-1`** (was: 6 % of the sea drawn from 200 m) | 100.00 % sheet at sea level at 200 m, 3, 10, 14.2, 20 km; no thin dark pixels |
| (b) plume and trail above an overcast deck, pad camera | `clouds.spec.ts` | **pass** | launch at 42 S 19 E (map coverage 1.00, tops 12.3 km), vehicle 14.1 km up, 36 trail segments: with minus without vfx 0.0000 % from the pad, peak pixel 156 % of the window's luminance from above the deck |
| (b) a plume 50 km away takes aerial perspective | `clouds.spec.ts` | **pass** against the contract's MEAN transmittance | with / without the atmosphere 0.758 / 0.756 / 0.753 (r, g, b); the air transmits 0.880 / 0.749 / 0.499 (mean 0.734): brightness right, reddening missing (atmosphere-clouds-4, for the lead) |
| (c) lunar terminator from 20,000 and 5,000 km | `shadows.spec.ts` | **pass after `terrain-render-cs-2`** | lit pixels shadowed by the terrain's casters: 301 of 95,646 (0.31 %) and 466 of 103,612 (0.45 %), within 0.04 disc radii of the terminator (12 and 23 before the owner's fix; bound 0.2 %). The body cascade holds level-3 casters: craters wider than about 20 km (level 4 does not fit the tile pools) |
| (c) approach through 1,500 km | `shadows.spec.ts` (the frame of the game's 60 degree camera at 1,500 km) | **pass** | no step above 3 x its neighbours (mean 1.40-1.70 of 255, worst block 48.6). Through a frame of 600 km (texels of both cascades 3-4 px wide) the change of texel grid at the hand-over is one step of 28 of 255 in a 16 px block: not resolvable by the game's camera |
| (c) pad, Earth turning: shadow edges | `shadows.spec.ts` | **pass** | ground alone: 0.0004-0.0007 % of the mean luminance per frame, worst 16 px block 0.037 %, no period 2 / 4 / 8. With site and vehicle: 0.07 %, block 73 % with their shadows, 70 % without (the sub-pixel lattice towers shimmer without TAA jitter; the shadows add nothing) |
| (c) 100 km lunar orbit pass | `shadows.spec.ts` | **pass** | 0.064 % per frame, block 0.84 %, period strengths 0.00 |
| (d) coverage edges, both bodies, 5 and 50 km | `terrain.spec.ts` (terrain + sky; median over rows of the column step) | **pass** | largest step along a boundary: Earth shading 0.65 %, imagery 0.63 %, geometry 0.012 % of the height; Moon 1.23 %, 1.04 %, 0.006 % (threshold 2 %). Seen, not measured as a line: a change of sharpness where level-12 imagery ends, and dark quadrilaterals in the regional Earth imagery (`coverage-edge-earth-5km-L11-y1.png`) |
| (e) image decode | `terrain.spec.ts` | **pass** | tile 1/7/93/88 in the terrain's GPU pool = reference decode: 26,870 land texels, largest byte difference 0; G-buffer / reference luminance median 1.007, correlation 0.966 |
| (f) exposure and HDR, all packages | `exposure.spec.ts` | **pass** | vehicle in space: EV100 15.08 against sunny-16 15.08; crescent Earth 15.06 / 15.07; the sun into a dark-adapted frame: EV -3.00, peak 60,000 (HDR_MAX), NaN 0 everywhere, back to 15.08 |
| (g) summed budget | `budget.perf.spec.ts` | **measured under load, not valid as a verdict** | frame p99 without the ballast 5.3 / 1.6 / 1.8 / 0.8 / 4.4 / 6.1 / 4.1 ms at the seven checkpoints (budget 11): the sum holds. Per package the p99s were taken while other agents' Chrome jobs shared the GPU (the core's fixed passes read 1.4-3.2 ms against 0.53 quiet) and are 3-6 x too high; over their lines in that run: atmosphere 3.0-3.4 (pad, reentry, splashdown), ocean 1.9-2.1 (pad, splashdown), sky 0.4-4.3 (ascent, LEO, lunar descent, reentry), terrain 2.7 (pad), vfx 2.5 (reentry). LEO cockpit: cockpit and atmosphere read 0.000: the seat view of the lab needs a look. **Re-run on the quiet machine** before anything is concluded: `node tools/dev/heavy.mjs --class=gpu -- npx playwright test tests/browser/integration/budget.perf.spec.ts --project=perf`; table in `out/core-support/budget.md` |

Method notes worth keeping: the real cloud map drifts with the feature's own cloud clock (it read 0, not the
simulation time): places are located with `cloudClock(page)`, never with an assumed time. Frame comparisons
run with `freeze()` (fixed time step, no jitter) on the HDR targets. The exposure prior counts a vessel whose
bounding sphere touches the frustum as "in view": stand 400 m away for a dark-adapted frame.

## 5. Problems filed against wave-2 packages

| Request | Owner | Status | One line |
|---|---|---|---|
| `terrain-render-cs-1` | terrain-render | **resolved by the owner** (`d43e8fd`), verified by re-running the spec | Sea sheet missing near a low camera over open ocean (seabed visible without the ocean feature), lines along sheet tile edges, water material at the seabed inside fadeStart |
| `terrain-render-cs-2` | terrain-render | **resolved by the owner** (`d3bac0a`), verified; closed by me | The whole-body shadow cascade held level 0-1 casters: no crater shadows at the terminator from afar. Now level 3 |
| `ocean-cs-1` | ocean | **fixed by the owner's later commits** (`3923a99`), verified; closed by me | From a low camera the forward water was 3-4.6 % off the deferred sheet in the last metres inside fadeStart; now 0.7-0.8 % |

Not filed (the owner had finished; for the lead): the cockpit's cabin shader carries its own copy of the old
near cloud-shadow lookup (`src/render/cockpit/shaders.ts`): a cabin above a deck is shaded by it until the
copy is replaced by `#include "cloud_shadow"`.

## 6. What the lead should look at first when integrating `src/app`

1. **Re-run `tests/browser/integration`** when terrain-render, atmosphere-clouds and vfx have their markers
   (section 4 is the state at 22:45, with those three still changing). Open observation: cloud-edge pixels
   react to the near field being on or off (row "(a) forward = deferred"). `atmosphere-clouds-5` (a
   deleted ocean spec) is open between two other packages and the ocean package has finished.
2. **Budget** (g): re-run on the quiet machine; look at the LEO cockpit row (cockpit 0.000).
3. **Decisions asked of the lead**: `sky-lighting-2` (Milky Way cube at 2048: sky VRAM 0.1 -> 0.15 GB),
   `sim-world-pilot-2` (ARCHITECTURE 18.2: the mission takes about 45 minutes), `ocean-5` (more swell
   components in `earth.json`: changes the splashdown physics as well), `atmosphere-clouds-4` (per-channel
   transmittance for transparents: plan in the request, about thirty lines in the core plus one binding
   number in the cockpit).
4. **The resolve** (`sky-lighting-1`): sub-pixel bright geometry loses energy under jitter (25 % kept at
   1.4 px lit width); star pixels ripple by up to 10 % for a static camera. Needs a resolve with per-pixel
   accumulation. `'post.reactive'` exists for evolving patterns.
5. **Exposure rules changed in wave 2**: interior metering, emissive hints, bright-area take-over at 2 %,
   interior shadow cascade. Tune `exposureCompensation` of the cockpit rig and the bloom on the game.
6. **Earth data**: regional heights despiked (manifest `ab20fdfc579d4015`); regional water mask, albedo and
   land cover are stale by the bake's bookkeeping only. Delete `data/cache/earth/backup-height-regional`.
7. **Terrain bake budget** (section 3) is the one wave-1 line still missed.
8. Wiring: the core publishes `'post.reactive'` and `'gbuffer.*'` itself; factories as the lab's adapters
   call them (`labs/integration/features.ts`): `createTerrainFeature(ctx, () => terrain)`,
   `createVesselVisualFeature()`, `createSiteFeature()`, `createCockpitFeature(ctx, { navball, mfdPainter })`,
   `createOceanFeature()`, `createSkyFeature()`, `createAtmosphereFeature()`, `createVfxFeature(ctx)`,
   `createSim(defs, scenarioId, { terrain })`.
9. An orphan `vite` dev server (node, started 18:27, `--host 127.0.0.1`, not by this package) was running
   at 20:45; `PROMPT.txt` and `docs/ARCHITECTURE_V2.md` carry uncommitted scope changes.

## 7. Journal

- 2026-11-10 17:00. Start. Machine idle: wave-1 perf specs, the unit suite, the terrain bench (section 3).
- 17:10-17:35. Map-view close-up fixed. `ocean-1`, `ocean-2`, `ocean-3`. RENDER_API sections 17, 18. Audio
  attach range. Terrain bake profiled.
- 17:35-18:05. Integration lab, helpers, lab spec, budget spec, exposure check (f), terrain checks (d), (e).
- 18:06-18:55. `terrain-render-2`: despike of the regional Earth heights.
- 18:45-19:31. `cockpit-1..4`, `vfx-1`, `terrain-render-1`, `terrain-render-3`, `ocean-4`, `sky-lighting-1`,
  `sky-lighting-2`.
- 19:31-20:15. Lab flies the real vehicle; FakeSim location; checks (a), (b), (c) written.
  `sim-world-pilot-1`.
- 20:15-21:00. Check (a) run and calibrated (three places; the cloud clock); `terrain-render-cs-1`,
  `ocean-cs-1` filed. Check (c): `terrain-render-cs-2` filed. Check (b), (d), (e), (f) run.
- 21:00-21:30. `atmosphere-clouds-1..4`, `ocean-5`, `sim-world-pilot-2`, `vfx-2`, `vfx-3`. Owner's fix of
  `terrain-render-cs-1` verified. Budget run under load.
- 21:30-22:45. Hand-off rewritten. Owners' fixes verified and `terrain-render-cs-2`, `ocean-cs-1` closed;
  checks (a) and (c) re-judged (game camera's frame, foam over the run-up, unstable pixels left out).
  Wave-1 functional suites (flight-ui + shell, map-view, audio) 87 of 87; unit suite 959 of 959 after the
  loader test stopped pinning an atmosphere tunable.
- State at 22:45: no request against my paths open; render-core browser suite 28 of 28 (after the cloud
  shadow change), exposure specs 6 of 6, unit tests of the core, the render core and the fakes green,
  `npm run typecheck` clean for my paths. Markers present: cockpit, sim-world-pilot, sky-lighting,
  vehicle-pad. Waiting for terrain-render, atmosphere-clouds, ocean, vfx.
- 2026-11-11 00:29. The machine restarted (Windows Update) while this package waited for terrain-render.
- 2026-11-11 07:20, closing pass (in progress; sections 2-6 are rewritten when it ends). So far:
  - The budget scenes of pass 1 did not show what their checkpoint is about, found by looking at the
    pictures: the cockpit was not drawn in the seat view (the FakeSim published no vehicle id), the stack on
    the pad stood 30 m deep in the ground and the lander 1.9 km above the real mare floor (the FakeSim knew
    only the reference sphere), the capsule hung nose down under its canopies, the ascent camera cut the
    plume off. Fixed in `src/core/fakes/fakeSim.ts` (options `vehicleId`, `ground`, `altitude`; `location` for
    every surface scene; nose up under parachutes) and `labs/integration/main.ts` (surface scenes stand on the
    baked terrain, `orbitVesselPoint`, `&hover=`, `&start=`).
  - `budget.perf.spec.ts` reports the median over six windows of 240 frames of each window's p99 (one hitch
    in one window decided a number before) and frames every scene; a first quiet run has every budgeted
    package inside its line except the sky (0.37 ms against 0.2-0.3), which is an artefact of the ballast
    (the pass after the long ballast pass pays about 0.23 ms of it in one frame out of five; being fixed in
    `labs/render-core/probes.ts`).
  - New lab switches for a check of cloud shadows above a deck (`setNearCloudShadow`, `setSunInVesselFrame`).
  - terrain-render regenerated its material sets at 07:40 while a run was going: terrain-dependent checks
    wait for its marker.
- 08:00-08:40. The ballast artefact traced per frame (the first compute pass behind the long pass, about
  0.23 ms in a quarter of the frames; none without the ballast; four kinds of pass in between did not take
  it). The budget runs now put the ballast at the end of the frame (`labs/integration/ballast.ts`): sky
  0.04 ms everywhere. First complete table with every package loaded (terrain in its working state): every
  budgeted line inside, sums of the p99s 1.9-5.5 ms against 11 (`out/core-support/budget.md`; to be repeated
  after terrain-render's marker).
- 08:40-08:55. Check (b) extended: above an overcast deck the hull keeps its light (1.000) and the cabin
  loses 56 % of it; `cockpit-cs-1` filed (the cabin shader's own copy of the old cloud-shadow lookup).
  The LEO cockpit budget row now looks at the two forward windows with the Earth in them (`&roll=180`,
  `sitAtWindowBelow`).
- 08:55-09:10. Wave-1 suites after the FakeSim changes: functional 115 of 115 (flight-ui, shell, map-view,
  audio, render-core), perf 5 of 5 (numbers for section 3), unit suite 967 of 968 (the one failure is
  terrain-render's own selection test, mid-edit). Dry run of the integration suite with terrain in its
  working state: 22 of 24 (the cabin check, and the climb's control: the water's own step-to-step change had
  doubled with the ocean's long-wave normals and hid a 5 % brightness step; the climb now compares region
  means too and reports it). New check (c) at the landing site under an 8 degree sun. Check (f) looks at
  the vehicle's sunlit side. The dark quadrilaterals of pass 1's remark on (d) are tree stands and
  windbreaks in the Sentinel-2 source (level-12 tiles looked at). Waiting for terrain-render's marker.
- 09:18. terrain-render's marker: all eight packages done. Final run of the integration suite on the final
  code: 24 of 25 (the cabin check: `cockpit-cs-1`); numbers in `out/core-support/final-int.log`.
- 09:26 on: the visual close-out of wave 2 started (`out/qa/wave2/*.md`); the feature packages, and fixers
  for flight-ui and map-view (who now edit `src/ui` and `src/map`), are working again and file requests.
  The budget run that was in flight was disturbed by their edits and is to be repeated at the end.
  Answered so far, blocking first: `cockpit-5` (0dbebd3) and its correction `cockpit-6` (9997263): interior
  night key out of the sun, bounded highlight term; `sky-lighting-3` and `vfx-4` (5d3e0ee): dark floor at
  EV -6 with slow dark adaptation, a linear hue-preserving toe under the tone curve, the exposure histogram
  before the transparent pass, the target bounded at sunny 16 + 0.5 EV under the sun; `vehicle-pad-1`
  (ad38ab3): soot and frost broken up in texture space, the clear coat covered. Open and non-blocking at
  10:22: `map-view-4`, `ocean-6`, `sky-lighting-4`, `-5`, `-6`, `vehicle-pad-2`, `-4`, `vfx-5`, `-6`.
- 11:20. Answered since: `ocean-6` (declined, escalated to the lead with `ocean-5`: swell data or the
  long-wave rule), `map-view-4` (d3134ab, `src/core/ui/theme.ts`), `vfx-6` (f52f358, `setDeterministic(on,
  { cycleNoise })`), `cockpit-7` (703b7c3, blocking: interior metering weighs what fills the frame through
  the windows; the requester's evidence view holds 5 % of Earth, not a fifth, and does not change; with the
  eye at the window the Earth is exposed: `exposure-window-leaning.png`), `cockpit-8` (cae38b8, blocking:
  the lab creates the vehicle with `exteriorGlass: false` when the cockpit is loaded; RENDER_API 17.7 for
  the app shell). `cockpit-cs-1` was resolved by the cockpit (77e2f72); the cabin check is to be re-run.
  Open and non-blocking: `atmosphere-clouds-6`, `-7`, `-8`, `flight-ui-2`, `sky-lighting-4`, `-5`, `-6`,
  `vehicle-pad-2`, `-4`, `vfx-5`.

## 8. Visual close-out (wave 2, from 2026-11-11 13:30: second maintainer)

The first maintainer was cut off by a spend limit at about 13:00; this section is kept by its successor. The
work in progress it left (`tonemap.ts`, `tonemap.test.ts`: request `sky-lighting-7`) was checked, one unit test
corrected (a warm grey at -6 stops is still inside the join) and committed.

Waiter for this pass: `node tools/dev/wait-requests.mjs --open --until out/closeout2-done/<package>.done,...`
(the nine packages: atmosphere-clouds, ocean, vehicle-pad, vfx, terrain-render, sky-lighting, cockpit,
flight-ui, map-view). `src/ui` and `src/map` have their own fixers now; they are not handled here.

### Requests of the close-out

| Request | Blocking | Result | One line |
|---|---|---|---|
| `sky-lighting-7` | yes | resolved `c60735e` | Tone curve joins AgX to the linear toe over five stops (-1 to -6): no contour at 17-21 of 255 in smooth gradients |
| `sky-lighting-8` | yes | resolved `4752c2d` | Planetshine occluded per pixel by every other body (`shineVisibility`, `shineVisibleFraction`, `planetshineAt(..., visibleFrom)`) |
| `vfx-5` | no | resolved `d48e735` | `LocalLight.radius`: falloff floored at the source's surface, horizon-cut sources; chunk `local_lights` |
| `vehicle-pad-2` | no | part 1 resolved `d48e735` | `LocalLight.kind: 'spot'` (`dirRelCam`, `cone`); part 2 (shadowed spots) **not built**: first open item below |
| `cockpit-10` | no | resolved `c417fb0` | Shadow kernel stops turning per pixel where a texel covers 2-8+ pixels: smooth edges at arm's length |
| `terrain-render-4` | no | resolved `c417fb0` | RT4.a of terrain / regolith = smallest shadow filter radius (`encodeShadowSoftness`, `sampleSunShadowSoft`, `PbrMaterialDef.shadowSoftness`) |
| `vehicle-pad-4` | no | resolved `95d2c70` | `PbrMaterialDef.alphaCutoff`: G-buffer and shadow alpha test, stochastic coverage on coarse mips |
| `atmosphere-clouds-9` | no | resolved `edfd096` | `AtmosphereRenderDef.airglow` / `AirglowLayerDef` in the defs contract |
| `vehicle-pad-6` | no | resolved `94e4266` | Frost veil under the break-up cells |
| `cockpit-12` | no | part 1 resolved `6e0c7a2`, part 2 declined | Interior bright areas of 1-8 % of the frame brought into the shoulder; no camera-dependent tone curve |
| `vehicle-pad-5` | no | resolved `f184651` | `FakeSimOptions.legsDeployed`; integration lab `lunarSurface` stands on deployed legs (`&legs=0`) |
| `lead-1` | no | resolved `bc3e291` | Loader test holds the swell count to 1..8 (lead's data change: eight components) |
| `app-integration-1` | no | resolved `fdf3cde` | `PerfSnapshot.cpu` is the caller's whole `'frame'` zone |
| `app-integration-2` | no | resolved `37932b8` | Shell spec boots the game at `/` |
| `cockpit-13` | no | core part resolved `4cdeb62` | `'vfx.plasmaWindow'` key, default, binding set `plasmaWindow`; vfx publishes (NOTICE-core-1) |
| `atmosphere-clouds-4` | no | core part resolved `3e69d76` (lead decision) | `'atmosphere.aerialTransmittance'`, last in the `transparency` set; `applyAtmosphere` per channel when published (NOTICE-core-2) |
| `sky-lighting-10` | no | resolved `7e953e8` | Camera in space: meter's sun illuminance after the air (`atmosphereTransmittanceAlong`); sun in the frame = exposure floor |
| `map-view-7` | no | resolved `ecc9238` | `FakeSimOptions.vesselName`; the integration lab names the vessel after its vehicle |
| `map-view-5` | no | labs/integration part resolved `298f785` | `&map=1&flighthud=1`: the map view and the flight HUD mounted as the app mounts them; `mapCamera()` |
| `terrain-render-6` | no | resolved `1581cf9` | `LaunchSiteDef.pad.shape`: exactly flat core and areas, a share of the relief elsewhere, ragged blends. **Lead-owned data changed: `data/defs/sites/ka-lae-lc1.json`** |
| `atmosphere-clouds-8` | no | **declined** | Cloud map re-bake: the real-time source snapshot is not cached (a re-download moves every cloud mid close-out); cloud-top source needs an Earthdata login |
| `vehicle-pad-2` part 2 | no | resolved `1426e0d` | `LocalLight.castShadow`: perspective maps for the 2 brightest spots, all mesh batches cast, deferred PCF |
| `sky-lighting-6` | no | resolved `81a26d0` | Moon albedo colour constrained (`tools/bake/moon/colour.py`, all 131,070 tiles); **Moon `meanColor` changed (lead-owned)** |
| `sky-lighting-4` | no | Clouds' colour done `81a26d0`; nebulae **declined** | `tools/bake/sky/clouds_colour.py`; nebulae need licensed imagery, placement, photometry, star removal |
| `terrain-render-5` | no | **declined** (tint fixed by `sky-lighting-6`) | Strip steps are in the WAC detail of levels 6-7; needs the WAC + SVS sources again (7 GB) and the detail step re-run |

### Lead-owned data changed in this pass

- `data/defs/sites/ka-lae-lc1.json`: `pad.shape` (request `terrain-render-6`): core 115 + 40 m, relief share
  0.25, five areas, ragged edges. `flatRadius` / `blendRadius` unchanged.
- `data/defs/bodies/moon.json`: `render.meanColor` (0.12, 0.115, 0.105) -> (0.1332, 0.1263, 0.1221), the
  near-side mean of the colour-constrained albedo map (request `sky-lighting-6`).

### Open items of this pass (for the lead)

1. Milky Way nebulae (`sky-lighting-4`): a bake of licensed photographic sources into the cube.
2. Moon strip equalisation (`terrain-render-5`): re-run `albedo.py` detail with per-strip gain / offset; keep
   the WAC and SVS sources (7 GB) for it. Then re-run `colour.py` (it is idempotent per bake).
3. Cloud map (`atmosphere-clouds-8`): keep the raw composite with the bake; an optical-depth index for channel 0,
   an Earthdata token for an L3 cloud-top source for channel 1.
4. `cockpit-12` part 2 (a longer shoulder for interior frames) declined: the tone curve is one transform for
   every camera; a local-exposure pass would be the way, a design of its own.
5. The resolve and sub-pixel bright sources (`sky-lighting-1`, from the first maintainer): unchanged.

### Journal

- 13:30. Take-over. `sky-lighting-7` finished and committed; render-core exposure specs 6 of 6.
- 13:40. `sky-lighting-8`; render-core browser suite 34 of 34.
- 13:50. `vfx-5`, `vehicle-pad-2` part 1 (lighting spec 9 of 9 with the new checks).
- 14:00. `cockpit-10`, `terrain-render-4` (render-core suite 36 of 36), `vehicle-pad-4`, `atmosphere-clouds-9`.
- 14:10. `vehicle-pad-6`, `cockpit-12` (unit suite of the meter 31 of 31; render-core exposure specs 6 of 6),
  `vehicle-pad-5` (integration landing-site check passes with the legs out).
- 14:15-14:45. `lead-1`, `app-integration-1` (render-core perf: CPU p50 0.52 / p99 0.85 ms with the lab's frame
  zone), `app-integration-2`, `cockpit-13` (core part), NOTICE-core-1, `atmosphere-clouds-4` (core part; the
  cockpit-cs-2 step of the lead's plan was not needed: the cockpit's own bindings are below the scene sets
  since its restructure; integration lab spec 3 of 3), NOTICE-core-2, `sky-lighting-10` (integration exposure
  specs unchanged: vehicle in space 15.09, crescent 15.07).
- 14:45-15:40. `map-view-7`, `map-view-5` (lab part), `terrain-render-6` (terrain-core unit suite 89 of 89, sim
  suites 212 of 212; looked at from 1.8 m), `atmosphere-clouds-8` declined, `sky-lighting-6` (bake: 131,070
  tiles recoloured in 10 min), `sky-lighting-4` (Clouds), `terrain-render-5` declined, `vehicle-pad-2` part 2
  (render-core lighting / mesh / shadows specs 22 of 22), NOTICE-core-3.

## 9. Visual close-out, third maintainer (2026-11-11, 22:00 on)

Ownership in this round: `src/render/core`, `src/terrain`, `src/camera`, `src/audio`, `src/input`, `src/core`
except `src/core/contracts` (the v2-baseline agent's), `tools` except `tools/dev`, the labs and specs of the
render core, the integration lab and audio, `data/defs/audio`, `data/defs/terrain`, and for this round
`src/render/terrain` (no terrain fixer was running). One GPU slot for five agents from 22:20 on (third bugcheck
0x119 at 22:16, during this round's first probe and a cockpit spec): browser runs waited 10 to 20 minutes each,
so they were batched into three.

### Requests

| Request | Blocking | Result | One line |
|---|---|---|---|
| `flight-ui-4` | no | resolved by routing (`e153012`) | The reentry streak is the vfx ablation sparks (per-package switch in one page: 74 px with everything, 0 without vfx); `vfx-cs-1` filed, resolved by vfx (`cb47e66`, `11da1a3`) |
| `vfx-7` | no | resolved `3e95313` | Exterior exposure bounded from below under the sun (sunny 16 - 0.5 EV) while sunlit surfaces are in the frame and the sun stands above 10-25 degrees |
| `vfx-8` | no | resolved `6a2fb76`, re-opened, resolved `81d7b95` | Under the sun, what is brighter than sunlit white, and the highlight term as such, move the target by 0.25 EV at most; the lift-off sequence swings 0.50 EV (was 0.57), the rest is the mean of the lit pixels (needs the sun-only share from the lighting pass: not built) |
| `cockpit-14` | yes | resolved `6a2fb76` | A change of `CameraState.kind` is a cut: the exposure follows the target with 0.06 s for 0.75 s |
| `app-integration-5` | no | core half answered `9b951c9` | Nothing to change in the deferred local lights: the cabin's and the displays' records are the cockpit's and inert (27fb5c8, 38da0ee) |
| `app-integration-7` | no | resolved `189d1e2` | The pad at 1440p fits the tile pools: vessel observer at the foot, live demand, fit of the ranges, one eviction search per frame, give-up |
| `app-integration-6` | no | resolved `189d1e2` | One warp cap per observer, ground speed without cuts and blends, parked view while in the map: the ground is as it was left |
| `app-integration-10` | no | resolved `189d1e2`, `1e5bceb` | Chase rig: body in the frame, sun behind the camera, distance for what is left of the vehicle, the player's input persists |
| `app-integration-11` | no | parts 2-6 done (`189d1e2`, `aea5efa`, `1e5bceb`); part 1 measured and planned, not built; part 7 is the atmosphere's | `compilations()`, `loads()`, `residency()`, `setUploadBudget()`, bakes independent of the frame rate, pinned levels from init, the view asked for whole after a cut |
| `sky-lighting-11` | no | terrain part declined `c4097fe` | Measured: the ground the terrain draws is a sphere of albedo 0.057 (land 0.18); the missing half of the far Earth is cloud tops and air |
| `flight-ui-5` | no | resolved `15c6393` (+ contract `95dac27` by the v2-baseline agent) | Milestone titles: loader validation, the 17 titles of the mission scenario |
| `lead-2` | no | resolved `2c879f1` | The stale real-data pad test follows the shaped pad (flat over the core and the areas; 2.65 m of kept relief inside `flatRadius`) |

Not mine and left alone: `flight-ui-6`, `flight-ui-8` (both `src/sim`: no sim owner is running this round),
`app-integration-8` (harness), `-12` (cockpit / flight-ui), `-13` (sim / vfx), `cockpit-15` (mission spec).

### The sound during entry (work item 2)

Cause, found by running the sound model over the mission's entry as the real Sim flies it
(`tools/audio/entryProfile.ts` -> `labs/audio/entryProfile.json`, nominal 45 km perigee, 2 Hz, 1,164 s): after the
heat pulse the capsule lofts to 77 km and comes down again through 60 to 45 km at Mach 16 to 10, 11 kPa and
3.3 g, with a tenth of the glow (heat flux 0.2 MW/m^2). For a chase camera (1) the boundary-layer wind had no
path at all: the camera rides outside the Mach cone, the air at 10-100 Pa carries nothing, and the wind had no
structure-borne share (the engines and the entry sounds had); (2) the entry roar and rumble followed
`plasmaIntensity` alone. So the game went quiet at about 66 km on the way down and silent from Mach 8 to Mach 1.

Fix (`src/audio/model.ts`, `mapping.ts`, `config.ts`, `data/defs/audio/environment.json`): the wind reaches an
attached outside camera through the structure (`aero.bodyGainDb`, with `mix.propagation.attach`), and the roar
and the rumble follow the larger of the plasma and the hypersonic aerodynamic load
`smoothstep(Mach 4, 8) x min(1, q / 18 kPa)` (`reentry.load`, `mapping.entryLoad`); hiss and crackle stay with
the plasma. Vacuum is silent as before (q = 0).

Proof, offline renders of the real graph in Chrome over the profile, 6 s of real time every 30 s, master RMS in
dBFS, with the rules before the fix rendered in the same page (`tests/browser/audio/audio-offline.spec.ts`, "the
mission's entry ..."; numbers in `out/audio/acceptance.json` `missionEntry`):

| t, s | altitude, km | Mach | q, kPa | plasma | g | chase camera: now (before) | cabin: now (before) |
|---|---|---|---|---|---|---|---|
| 30 | 90.7 | 38.3 | 0.2 | 0.05 | 0.05 | -48.8 (-48.9) | -31.6 (-31.6) |
| 60 | 67.7 | 34.5 | 6.2 | 1.00 | 1.83 | -25.6 (-26.0) | -17.1 (-17.1) |
| 90 | 58.0 | 29.1 | 17.1 | 1.00 | 5.15 | -23.8 (-25.3) | -16.3 (-16.3) |
| 120 | 54.5 | 23.9 | 18.1 | 0.94 | 5.44 | -23.7 (-25.8) | -16.4 (-16.6) |
| 150 | 56.8 | 20.4 | 9.7 | 0.38 | 2.93 | -28.0 (-33.2) | -19.3 (-20.7) |
| 180 | 64.0 | 19.5 | 3.3 | 0.09 | 1.01 | -37.5 (-46.8) | -24.8 (-28.3) |
| 210 | 70.8 | 19.7 | 1.3 | 0.02 | 0.38 | -46.1 (-60.3) | -31.0 (-35.2) |
| 240 | 75.3 | 19.8 | 0.6 | 0.00 | 0.19 | -52.0 (-72.7) | -34.6 (-36.7) |
| 270 | 77.0 | 19.8 | 0.5 | 0.00 | 0.14 | -46.8 (-47.7) | -28.2 (-28.4) |
| 300 | 75.7 | 19.6 | 0.6 | 0.00 | 0.17 | -52.6 (-75.4) | -34.9 (-36.8) |
| 330 | 71.4 | 19.0 | 1.1 | 0.01 | 0.32 | -47.2 (-64.6) | -31.8 (-35.8) |
| 360 | 64.6 | 17.8 | 2.6 | 0.04 | 0.77 | -39.3 (-53.5) | -26.0 (-31.6) |
| 390 | 56.3 | 15.9 | 6.4 | 0.09 | 1.91 | -31.3 (-46.1) | -21.2 (-25.6) |
| 420 | 49.2 | 13.2 | 10.9 | 0.08 | 3.28 | -26.8 (-46.8) | -18.5 (-22.8) |
| 450 | 45.3 | 10.4 | 10.9 | 0.02 | 3.30 | -26.9 (-59.0) | -18.6 (-22.9) |
| 480 | 43.5 | 8.0 | 8.2 | 0.00 | 2.50 | -29.2 (-88.1) | -20.0 (-24.9) |
| 510 | 40.9 | 6.2 | 6.8 | 0.00 | 2.07 | -33.1 (silent) | -23.2 (-26.4) |
| 540 | 36.7 | 4.6 | 6.6 | 0.00 | 2.03 | -34.7 (-47.9) | -25.0 (-25.0) |
| 570 | 31.4 | 3.0 | 6.1 | 0.00 | 1.94 | -35.7 (silent) | -27.2 (-27.2) |
| 600 | 25.7 | 1.7 | 4.5 | 0.00 | 1.48 | -35.4 (-38.2) | -20.2 (-20.2) |
| 630 | 19.7 | 1.0 | 4.1 | 0.00 | 1.12 | -34.8 (-40.1) | -26.2 (-26.2) |
| 660 | 13.7 | 0.7 | 5.1 | 0.00 | 1.19 | -33.3 (-34.6) | -20.5 (-20.5) |
| 690 | 8.8 | 0.5 | 5.0 | 0.00 | 1.12 | -33.7 (-34.2) | -28.4 (-28.4) |

Chase camera: the heat pulse (t 120 s) is at -23.7 dBFS; the second dip (t 420 to 480 s, Mach 13 to 8, 11 kPa, 3.3 g) was at -46.8, -59.0, -88.1 dBFS and is at -26.8, -26.9, -29.2 dBFS. The loft between the dips (q under 0.7 kPa) is 20 to 29 dB under the
heat pulse: the level is the load's, not a bed.

Unit tests: `tests/unit/audio/entryProfile.test.ts` (10: the level follows 20 log10 q from Mach 30 to Mach 0.5
for both listeners, the loft is quiet, vacuum is silent), `mapping.test.ts` (`entryLoad`).

### The chase camera (work item 3, request app-integration-10)

`src/camera/chaseRig.ts`; API for the app (nothing has to change in `src/app/game.ts`:
`createChaseRig({ defs, terrain })` gets the new defaults; a key for `resetView()` is the app's to add):

```ts
interface ChaseRigOptions { defs; terrain?; fovY?; clearance?; elevation?;
  frameBody?: boolean;              // default true; false = the fixed 12 degrees and the nose-based azimuth of before
  distanceRadii?: number;           // default 3.2 radii about the centre of mass; Infinity = always the vehicle default
  startBehindPreviousView?: boolean // default false: the rig keeps the placement the player left
}
interface ChaseRig extends FlightCameraRig {
  setOrbit(azimuth, elevation, distance): void;   // absolute, counts as player input (unchanged)
  resetView(): void;                              // back to the default framing in a 1.5 s swing (bind a key to it)
  readonly distance: number;
  readonly offsets: { azimuth: number; pitch: number; zoom: number };  // the player's part
  readonly autoAzimuth: boolean;                  // true until the player turns the camera
  readonly roll: number;                          // roll of the default view now, rad (0 once the player has the camera)
}
chaseReferenceElevation(angularRadius, fovY, base = 12 deg, side = 0): number
chaseReferenceRoll(angularRadius): number
chaseAutoDistance(defs, vessel, radii = 3.2): number
vesselRadiusAboutCom(defs, vessel): number | null
```

- Frame: up = the local vertical of the SOI body in both navball modes (orbit mode: azimuth from the horizontal
  part of the velocity). A navball-mode change re-expresses the azimuth and moves nothing; a change of body
  swings the camera to the same angles in the new body's frame over 3 s.
- Elevation = reference + the player's pitch. Reference: 12 degrees near a body (the limb less than about 22
  degrees under the horizontal: up to about 500 km over the Earth, 140 km over the Moon), then
  `90 deg - angular radius - 10 deg`, so the limb stays a third of the half frame under the centre.
- A body that has become a disc (angular radius from 16 down to 6 degrees: the Earth beyond 16,000 to 55,000
  km) stands to the lower left of the vehicle: the default view rolls up to 65 degrees and the disc moves out to
  20 degrees from the centre. Straight below the vehicle is where the HUD has its navball: the first version of
  this round put the Earth there, whole and hidden (found by looking at the picture). The roll belongs to the
  default: when the player turns or tilts the camera it eases out (0.6 s) and the frame is level.
- Azimuth: on a surface the vessel's (behind the nose, from starboard while it stands: app-integration-3). In
  orbit mode the sunward side, 35 degrees off the sun's line, following the sun round the orbit at up to 15
  degrees a second, until the player turns the camera; then it is the player's, fixed to the track.
- Distance = `chaseAutoDistance` (the vehicle's `defaultDistance`, or 3.2 radii of what is left of it if that
  is nearer; followed over 0.8 s after a separation) x the player's zoom factor, inside the vehicle's limits.
- Persistence: yaw, pitch and zoom are kept through cockpit and map and back, navball modes, staging and
  spheres of influence; another active vessel starts from the defaults.

In the app, nothing touched (`tests/browser/integration/chase-framing.spec.ts`; pictures looked at:
`out/screens/core-support/chase-<scenario>.png`):

| Scenario | Body, altitude | Angular radius | Body in the frame | Sun from the view axis | Camera distance (it was 140 m) |
|---|---|---|---|---|---|
| `qa-leo` | Earth, 202 km | 75.8 deg | limb 2.2 deg under the centre, the frame level | 104 deg | 49.0 m (stack of bounding radius 21.4 m) |
| `qa-translunar` | Earth, 81,806 km | 4.1 deg | whole disc, 21.6 deg left and 9.9 deg under the centre | 138 deg | 31.6 m |
| `qa-lunar-orbit` | Moon, 97 km | 71.3 deg | limb 6.7 deg under the centre, the frame level | 145 deg | 32.2 m |
| `qa-trans-earth` | Earth, 322,567 km | 1.1 deg | whole disc, 18.9 deg left and 8.7 deg under the centre | 107 deg | 14.2 m |
| `qa-entry` | Earth, 836 km | 62.1 deg | limb 9.9 deg under the centre (the night side: black) | 128 deg | 10.6 m (capsule) |

What geometry does not allow: over the night side the ground below is black at the daylight exposure the lit
vehicle sets (qa-entry), and far out the vehicle is side-lit when the sun stands across the line to the body
(qa-trans-earth). The player can turn the camera; the default cannot have both.

### Terrain (requests app-integration-6, -7, -11)

Details and the table of numbers: `docs/handoff/terrain-render.md` section 13. In short, measured in the app at
2560 x 1440 on the pad (`tests/browser/integration/pad-pools.spec.ts`): the terrain's main-thread time went
from 5.27 / 6.74 ms (p50 / p99) to 1.41 / 2.10 ms, the app's frame from 8.0 / 11.0 ms to 3.4 / 4.8 ms (line:
6 ms), `isIdle()` is reached (it never was; 28 s after navigation), and a map round trip streams nothing again
(deepest level 20 in the map and in the first frame back; it was 11 and 2). The lander on the Moon at 1440p
(`qa-lunar-surface`): at rest after 22 s, terrain 0.96 / 1.33 ms, the app's frame p99 under 6 ms. The terrain
package's functional browser suite passes on the final code (20 of 20: integrity, pops with and without delayed
streaming, views), and its time-warp perf test (5x, 10x, 50x in a 200 km orbit: caps 7.1 / 6.1 / 3.8, no frame
over 33 ms, queue at most 5).

### API and behaviour changes of this round

| Change | Where | Affects | Migration |
|---|---|---|---|
| Exposure: lower sunlit bound, over-white bound, cut adaptation; `MeterInput.sunElevationSin`, `MeterResult.sunlitFloor`, `exposureInfo().sunlitFloor`, `adaptEv100Cut` | `src/render/core/post/exposure.ts`, `renderer.ts` | every exterior daylight frame, every view change | None in code (RENDER_API 13, 18) |
| `CoreShaderLibrary.compilations()`, `MeshSystem.loads()` | `src/render/core` | loading screens | None |
| Chase rig (above); `CHASE_FRAME_BLEND_SECONDS` deprecated | `src/camera/chaseRig.ts` | app, flight-ui lab, footage director | `frameBody: false, distanceRadii: Infinity, startBehindPreviousView: true` pins the old behaviour |
| `vesselGroundObserver`: vessel LOD observers at the foot with the footprint as bias | `src/camera/listener.ts` | terrain (only consumer) | None |
| Terrain: `LodObserverFixed.cap`, `SelectParams.counted / eager`, `TileNode.cap / neededFrame / deferUntil / queuedAt`, `GroundSpeed`, `fitLodScale`, `TileStreamer.demand / setUploadBudget / noteFit`, `TerrainDebug.residency / setUploadBudget`, stats | `src/render/terrain` | app (stats), terrain specs | None |
| Audio: `aero.bodyGainDb`, `reentry.load` (required in `data/defs/audio/environment.json`); `entryLoad`; the config's event and readout lists know the v2 contract's additions | `src/audio`, `data/defs/audio` | chase views in fast flight, every entry | None |
| Audio lab: `missionEntryScript`, `__audioLab.entry(kind, starts, seconds, rules)` | `labs/audio` | acceptance spec | None |
| Loader: `MilestoneRuleDef.title` validated | `src/core/defs/loader.ts` | scenario authors | None |

Announced in `docs/requests/NOTICE-core-4.md`.

### Lead-owned data changed in this round

- `data/defs/scenarios/lunar-direct.json`: a `title` on each of the 17 milestones (request `flight-ui-5`). Ids,
  triggers and order unchanged.

### Tests added or corrected

`tests/unit/audio/entryProfile.test.ts` (11), `tests/unit/camera/chase.test.ts` (21), `observers.test.ts` (4),
`tests/unit/terrain-render/pools.test.ts` (12), exposure (10 new in `exposureGovernor.test.ts`), loader (2);
browser: `tests/browser/integration/pad-pools.spec.ts`, `chase-framing.spec.ts`, a cut test in
`exposure.spec.ts`, the mission entry in `tests/browser/audio/audio-offline.spec.ts`, residency in
`tests/browser/terrain/smoke.spec.ts`. Corrected: `tests/unit/terrain-core/realData.test.ts` "launch-site pads
are flat" had failed since the shaped pad of `terrain-render-6` (it asked for 5 cm over `flatRadius`; the
contract is the core and the areas).

### Open items of this round (for the lead)

1. `app-integration-11` part 1: pipelines are still created synchronously (about 70 modules compile one after
   another in the GPU process while the first frames wait: 11 s of the 32 s load). Measured in this round's
   probe: eight heavy pipelines take 7.4 s created synchronously, 1.3 s with `createRenderPipelineAsync`, and
   5 ms when created synchronously AGAIN from equal descriptors (Dawn's cache). So a `CoreShaderLibrary.warm()`
   that runs every tracked build once through the asynchronous call makes the features' own creation free: plan
   in the request. It needs one awaited call in every feature's `init` (65 creation sites in eight packages).
2. Terrain main thread on the pad at 1440p: 1.4 ms p50 against the 1 ms line of "quadtree + cascades"
   (selection 0.59, ground cover 0.52).
3. `flight-ui-6`, `flight-ui-8`: `src/sim` has no owner in this round.
4. The 12-level "always resident" coarse tiles of the Moon take 126 of the 1,280 tile layers also when the Moon
   is a few pixels wide (and so will every v2 body): pin by distance.
5. The cross-feature suite and the budget table were not re-run (by the brief). The integration lab's `water`,
   `clouds`, `shadows`, `terrain` checks have not seen this round's terrain and exposure changes.
6. `vfx-8`: the last 0.1 EV the critics ask for in the daylight lift-off needs the lighting pass to hand the
   meter the sun-and-sky share of each pixel (a second histogram); the meter's rules are at their end.
7. The heavy gate is not fair: a waiter that polls at the right moment takes the slot. This round's last three
   runs waited 13, 31 and 5 minutes while later arrivals went first.

### Journal

- 2026-11-11 22:00. Start. Probe 1 (pad at 1440p, reentry streak by package, map round trip). 22:16: third
  bugcheck during it; the gate went to one GPU slot. The probe's first two parts had finished: the pad view asks
  for 1,660 of 1,280 tile layers and the streamer spends 2.6 ms a frame on waiting tiles; the streak is vfx.
- 22:25. `flight-ui-4` routed (`vfx-cs-1`). Entry profile from the real Sim; the sound model over it in node shows
  the chase camera silent from Mach 8 to Mach 1. Audio fix, unit tests, lab timeline, offline acceptance test.
- 22:40. `vfx-7` (lower sunlit bound). The v2 contract's new event types and readouts listed in the audio
  config's exhaustive maps (they broke `typecheck:paths src/audio`).
- 22:45-23:10. Terrain: demand simulation in node (the 101 m bias), vessel observer at the foot, per-observer
  caps, ground speed, pool fit, give-up, parked view. Chase rig rewritten. `cockpit-14`, `vfx-8`.
- 23:10-23:30. Run A (pad pools, mission entry audio): the numbers of sections above; two over-tight assertions.
  `app-integration-5` core half, `sky-lighting-11` terrain part, `flight-ui-5`, `app-integration-11` parts 2-6,
  the stale pad test of terrain-core, the footage director's frame.
- 23:30-23:55. Run B (87 tests: integration exposure, pad pools, chase framing, render-core, terrain, audio):
  80 passed, 1 failed (the audio lab's plasma case ran at 9 kPa: corrected), 6 of the same serial file skipped.
  Looked at the chase pictures: the far Earth stood behind the HUD's navball; default view rolled for small discs.
  Eager requests cut to three levels (the whole chain asked for twice the tiles).
- 2026-11-12 00:00-00:35. Run C waited 31 minutes for the slot, then 6 minutes: audio offline suite 11 of 11
  (the mission entry table), chase framing 5 of 5 with the roll, pad pools 2 of 2 (pad and lunar surface at
  1440p), the pipeline cache probe, the terrain warp perf test. Unit suite 1,252 of 1,252, typecheck clean for
  every owned path. Hand-offs, resolutions, NOTICE-core-4.
- 00:35-00:50. `vfx-8` re-opened by vfx (the sequence unchanged: the pixels are at or under sunlit white): the
  highlight term bounded at a quarter stop under the sun. Run D (exposure specs of the core and the integration
  lab 11 of 11, vfx's three daylight exposure tests pass: 15.40 / 15.51 / 15.45 / 15.01).
