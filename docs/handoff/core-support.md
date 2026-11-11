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

State on 2026-11-10 at 21:30, with terrain-render, ocean, atmosphere-clouds and vfx still changing their
code (their done markers were missing); cockpit, vehicle-pad, sky-lighting, sim-world-pilot finished.

| Check | Spec | Result | Numbers |
|---|---|---|---|
| lab | `lab.spec.ts` | passes when no package is mid-edit | all seven packages load |
| (a) climb 2 m - 400 km, open ocean, frozen time | `water.spec.ts` "climb" (251 steps of 5 %; terrain + ocean + sky, and every package) | **pass** | no step above 3 x its neighbours, pixel by pixel or of 16 px block averages; with clouds (clear place of the cloud map, 12 N 33 W) none inside the cloud shell either. Control test: a 5 % brightness step is reported (block-average mean 1.71 against 0.46); the near field vanishing in one step is NOT seen by this method (the waves' own step-to-step change is as large) and is covered by the next row |
| (a) forward = deferred at fadeStart | `water.spec.ts` "fadeStart" (1, 6, 14 km up; towards and away from the sun; with and without the atmosphere) | **fails from 1 km up** -> `ocean-cs-1` | last 50 m inside fadeStart: 4.41 % (no atmosphere), 2.90 % (all, towards the sun); 6 km: 0.41 %, 14 km: 0.15-0.38 %; fadeStart to fadeEnd 0.1 % everywhere |
| (a) shoreline at 200 m over the real seabed | `water.spec.ts` "shoreline" | seabed and refraction **pass**; foam **changed during the evening** | opaque depth under the water = real seabed within 0.7 m at 46 points 3-40 m deep; refraction changes the image by 2-4 % in the shallows, 0.2-0.4 % over deep water, 0 on land; foam coverage on the waterline 0.13-0.16 against 0.05 offshore at 20:20, 0.04 against 0.06 at 21:25 after ocean and terrain commits (re-run; file against ocean if it stays) |
| (a) the sea without the ocean feature | `water.spec.ts` "without the ocean" | **pass after `terrain-render-cs-1`** (was: 6 % of the sea drawn from 200 m) | 100.00 % sheet at sea level at 200 m, 3, 10, 14.2, 20 km; no thin dark pixels |
| (b) plume and trail above an overcast deck, pad camera | `clouds.spec.ts` | **pass** | launch at 42 S 19 E (map coverage 1.00, tops 12.3 km), vehicle 14.1 km up, 36 trail segments: with minus without vfx 0.0000 % from the pad, peak pixel 156 % of the window's luminance from above the deck |
| (b) a plume 50 km away takes aerial perspective | `clouds.spec.ts` | **pass** against the contract's MEAN transmittance | with / without the atmosphere 0.758 / 0.756 / 0.753 (r, g, b); the air transmits 0.880 / 0.749 / 0.499 (mean 0.734): brightness right, reddening missing (atmosphere-clouds-4, for the lead) |
| (c) lunar terminator from 20,000 and 5,000 km | `shadows.spec.ts` | **fails** -> `terrain-render-cs-2` (open; improving) | lit pixels shadowed by the terrain's casters: 12 and 23 of 100,000 at 20:50 (level 0-1 casters in the body cascade); 301 (0.31 %) and 466 (0.45 %) at 21:25; threshold 0.4 % |
| (c) approach through 1,500 km | `shadows.spec.ts` | **fails** -> `terrain-render-cs-2` | one step with a 16 px block change of 28.1 of 255 (8-10 around it) where cascade `4:camera` joins `2:body`; 8.3 with `noshadow=terrain` |
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
| `terrain-render-cs-2` | terrain-render | open | The whole-body shadow cascade holds level 0-1 casters: no crater shadows at the terminator from afar, shadows pop in at 1,500 km |
| `ocean-cs-1` | ocean | open | From a low camera the forward water is 3-4.6 % off the deferred sheet in the last metres inside fadeStart |

Not filed (the owner had finished; for the lead): the cockpit's cabin shader carries its own copy of the old
near cloud-shadow lookup (`src/render/cockpit/shaders.ts`): a cabin above a deck is shaded by it until the
copy is replaced by `#include "cloud_shadow"`.

## 6. What the lead should look at first when integrating `src/app`

1. **Open requests** `terrain-render-cs-2` and `ocean-cs-1` (section 5) and the shoreline foam (section 4):
   re-run `tests/browser/integration` when the last four packages have their markers.
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
- State at 21:30: no request against my paths open; render-core browser suite 28 of 28 (after the cloud
  shadow change), exposure specs 6 of 6, unit tests of the core, the render core and the fakes green,
  `npm run typecheck` clean for my paths. Markers present: cockpit, sim-world-pilot, sky-lighting,
  vehicle-pad. Waiting for terrain-render, atmosphere-clouds, ocean, vfx.
