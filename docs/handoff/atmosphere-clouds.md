# Hand-off: atmosphere-clouds

The sky of every body with an atmosphere, from the pad to the Moon's distance: scattering tables, one
per-pixel march composited into the HDR target, volumetric clouds driven by the baked coverage map, cloud
shadows for the deferred lighting, and the buffers every transparent draws through (`applyAtmosphere`).
Per-body data only; a frame with no atmosphere in view runs no pass of this package and publishes neutral
buffers.

This is the state after visual fix round 1 (section 11: every item of the round-0 visual critique, what
was done, what was not and why, measured numbers). Sections 1 - 10 describe the package; where round 1
changed them they say so. Two things are NOT met and are stated first:

- **The clouds are not yet photoreal in every view.** Cumulus from the pad, a cloud sea from above, the
  day side from low orbit and the low-sun views now read as clouds (section 11), but a deck seen from just
  under its base is smooth painted lobes, cloud seen into a setting sun is one warm tan, and from orbit
  the fields are popcorn of one size with soft edges and soft shadows.
- **The atmosphere budget line could not be confirmed as a p99.** Its medians are 0.36 - 0.59 ms (budget
  0.8 / 0.9); the p99 of the median window was inside the budget in 15 of 16 rows of the last run and at
  0.93 ms in one, and in an earlier run on a loaded machine three rows read 1.3 - 4.1 ms. The excess is
  always a single spike of 0.2 - 0.4 ms (quiet) or milliseconds (loaded) in one pass, with nothing of the
  package's own behind it (section 5, "the composite spike"). The lead has to re-measure on a quiet machine.

## 1. Where things are

```
src/render/atmosphere/index.ts          public API
src/render/atmosphere/feature.ts        createAtmosphereFeature: the RenderFeature, march + composite passes (half-resolution and tile), debug hooks
src/render/atmosphere/tables.ts         AtmosphereTables: transmittance, multi-scattering, sky irradiance, sky view, aerial volume (compute)
src/render/atmosphere/clouds.ts         CloudSystem: noise, coverage map, shadow map, quarter-area march + temporal resolve, tile march, cloud clock
src/render/atmosphere/select.ts         which bodies are marched, with how many samples, in which screen rectangle; FINE_TILE_SIZE
src/render/atmosphere/airglow.ts        airglow layers of an atmosphere definition (validated), airglowTop
src/render/atmosphere/params.ts         cloud tunables (validated: unknown keys and out-of-range values are reported)
src/render/atmosphere/uniforms.ts       one field table -> WGSL struct AtmoU + CPU writer
src/render/atmosphere/math.ts           CPU mirrors of the table parameterisations, stable altitude, ray / shell geometry (float32-faithful)
src/render/atmosphere/reference.ts      float64 brute-force reference model (tests)
src/render/atmosphere/shaders/model.ts  chunk "atmosphere_model": medium, phases, AtmoRay, importance CDF, sample
src/render/atmosphere/shaders/luts.ts   compute shaders of the five tables
src/render/atmosphere/shaders/march.ts  chunk "atmosphere_cloud_shadow", marchFsWgsl(fine), the two composites
src/render/atmosphere/shaders/clouds.ts chunk "atmosphere_cloud_density", cloudMarchFsWgsl(fine), resolve, cloudShadowFsWgsl(inPlace), blit, noise
data/defs/render/earth.atmosphere.json, earth.clouds.json    tunables (section 6)
labs/atmosphere/                        lab (query parameters in main.ts; window.__atmo)
tests/unit/atmosphere/                  math.test.ts, model.test.ts, airglow.test.ts (40 tests)
tests/browser/atmosphere/               sky, screens, transparents, clouds, cloudlight, smallshell, shadows, sampling, tunables,
                                        eclipse, native (1440p animated) specs; atmosphere.perf.spec.ts; explore.spec.ts (tuning tool, skipped)
docs/requests/atmosphere-clouds-1.md ... -9.md   (section 8)
```

## 2. Public API

```ts
import { createAtmosphereFeature } from '@/render/atmosphere';
renderer.addFeature(createAtmosphereFeature());   // options: { id?, order?, clouds?: boolean, coverageMaps?, fineTile?: boolean }
```

`createAtmosphereFeature(options | RenderContext = {}): AtmosphereFeature` - a `RenderFeature` with hooks
`prepare`, `compute`, `compositeAtmosphere`, `isIdle`, `dispose`, plus `invalidate()` (rebuild static tables
after editing definitions) and `debug` (`readTable(name)`, `selection()` with `fine`, `clouds()`). A
`RenderContext` passed in place of options is accepted (the brief's spelling) and ignored: `init` receives
the context. `fineTile: false` keeps the half-resolution march at every distance (lab A/B only).
Pass names: `atmosphere.tables`, `.skyAerial`, `.march`, `.composite` (the atmosphere line) and
`atmosphere.cloudShadow`, `.cloudShadowBlit`, `.cloudMarch`, `.cloudResolve`, `.cloudMarchFine` (the cloud line).

Published every frame (`prepare`), neutral when nothing is in range:

| Key | Content |
|---|---|
| `atmosphere.transmittanceLut` | 256 x 64 x layers, render-core parameterisation (layer = rank among frame bodies with an atmosphere) |
| `atmosphere.skyIrradianceLut` | 64 x 16 x layers, u = (mu_s + 0.2) / 1.2 |
| `atmosphere.skyViewLut` | 192 x 108, the nearest atmosphere body, core `skyViewUv`; a = mean transmittance of the path |
| `atmosphere.aerialPerspective` | 32^3 rgba16float; rgb = in-scatter in cd/m^2 (clamped to HDR_MAX), a = LUMINANCE-weighted transmittance |
| `clouds.screen` | half resolution, rgb = pre-exposed premultiplied radiance, a = transmittance (the view never changes: stable for bind groups) |
| `clouds.depth` | r32float, see section 7 for what the value is; 3.0e38 = none |
| `clouds.shadowMap` | rgba32float 1024^2: r = optical depth of the layer as the ground sees it (beam + diffuse transmission, request 6), g = distance along the projection direction `L = cross(axisU, axisV)` at which the cloud begins on the sun side (clear texels: the top of the layer), b = mean extinction behind that point, a = optical depth of the direct beam divided by r. A receiver at distance s has `tau = clamp((g - s) b, 0, r)` (core chunk `cloud_shadow` / `cloudLight`). Since round 1 this is the marched map FILTERED for the core's single bilinear tap (mean transmittance over a tent, section 11 item 3), and `axisV` is longer than unit by the factor by which the map is narrower along v under a low sun (the core's lookup needs no change) |
| `clouds.coverageMap` | the body's coverage map (rg8unorm with mips) |

`coreOf(ctx).setCloudShadowParams({ near, far })` is called in `prepare` every frame (null terms when off).
Shader chunks registered at init: `"atmosphere_model"`, `"atmosphere_cloud_shadow"`. Nothing outside imports
`@/render/atmosphere` except the app shell and labs.

## 3. How it works (what a maintainer must know)

- **Ray frame.** Every path is measured from where the ray enters the atmosphere shell (`AtmoRay`: the eye
  when inside), and altitudes come from the stable formula started there: exact to centimetres from the pad
  and to tens of metres from 384,400 km (unit-tested against float64). The cloud march uses the same frame.
- **March, half resolution.** 24 x qualityScale samples placed by a piecewise-linear CDF whose knots crowd
  around the ray's lowest point (searched forward, the samples come in order); medium and smooth light at
  stratum midpoints, only the cloud shadow lookup is dithered. Two candidates per half-res texel (farthest /
  nearest depth of its 2 x 2 block); the composite interpolates them at the pixel's depth.
- **March, tile (new).** While the screen rectangle of the selected shells fits 512 x 512 px
  (`FINE_TILE_SIZE`), atmosphere and clouds are marched once per FULL-resolution pixel of that rectangle into
  tile targets, to each pixel's own depth, and composited texel for texel. This is every view of a planet
  from afar (Earth from the Moon is 46 px at 60 deg / 1440p): one half-resolution texel spans hundreds of
  kilometres there. The half-resolution cloud buffers are still rendered (transparents read them). The
  switch between the two paths at 512 px is a cut, not a blend.
- **HDR bound.** `add <= HDR_MAX (1 - mul)` with a slack of 8.
- **Clouds, density.** Low layer (noise x height gradient above 1 - coverage), high sheet under the map's
  cloud top (analytic bell integral per step), deep fill near coverage 1; fair-weather fields where the map
  is clear, broken into cells by the finer octaves of the weather noise. The map is read one level above its
  finest. The extinction of the low layer grows with the map's coverage (it is an opacity as much as a
  cover) and is mottled at the mesoscale and the weather scale (`lowThinDensity`, `lowDensityVariation`).
  Detail erosion DISPLACES the surface of resolved shapes by up to `detailErosion` noise units (the edge
  keeps its own softness); a finer octave is added within about 40 m of footprint.
- **Clouds, unresolved.** Noise is read one mip above the footprint; what the mips averaged away becomes a
  cloud FRACTION (maximum overlap along the ray). Past mip 5.5 the noise is its mean exactly
  (`cloudNoiseKeep`): the last mips of a tiling texture show the tile as a stipple. Every layer is integrated
  over the altitudes a step covers (`span`: overlap with the low layer and the filled column, bell integral
  of the sheet), so a long step neither misses a layer nor counts it twice whatever its phase.
- **Clouds, march.** Steps grow with distance (`stepFactor`, `stepMinM`, `stepMaxM`); when a ray would need
  more than the budget the rule is coarsened to fit. The noise level follows the uncoarsened rule up to a
  factor 2 (so the relief of a deck does not depend on the budget). Entering a resolved cloud the slabs
  restart at its surface (bisection); entering a smooth layer (a sheet, or low cloud that is only a
  fraction) at the crossing of its top or bottom (`cloudSlab`). Half steps while the cloud is still
  translucent. Columns above every cloud top the map allows are returned empty after one lookup.
- **Light.** Six cone samples towards the sun (the first two see the erosion), then shadow map / coverage
  map; three multi-scatter octaves, a two-stream diffuse term scaled by the reflectance of the optical depth
  around the sample `k tau / (1 + k tau)`, sky and ground ambient. Slabs that add little reuse the light of
  the last lit slab (4 % of the cloud in a pixel, 10 % at qualityScale 0.7).
- **Quality scale.** Step budget = `cloudSteps x q^2` (deviation 8), light reuse, and below 0.85 no finest
  erosion octave for the eye. Step sizes, thresholds and light samples do not change.
- **Temporal.** One ray per 2 x 2 half-res block per frame (4-frame cycle). Each pixel keeps its own
  radiance AND its own cloud geometry between its marches (history and geometry targets alternate between
  two textures; the resolve writes the next history itself, nothing is copied). A still pixel averages about
  eight of its marches (weight 0.125), a moving one follows the newest (0.5), a pixel that jumped (view cut)
  starts again. While the camera is within about 150 km of the cloud tops (footprint under 150 - 600 m) the
  rays of successive marches go through different points of the pixel (the frame's TAA sequence, also in
  deterministic mode): edges are averaged instead of stair-stepped.
- **Shadow map.** Sun-aligned orthographic (elevation clamped to 3 deg, off below -2 deg), body-fixed
  anchor, origin in whole texels, one texel in 16 (32 under a low sun) re-marched per frame IN PLACE; in a
  frame in which the origin moves, into a scratch target and back with a blit pass (both timed). Under a
  low sun the map is narrower along v (its texels are about square on the ground). A full re-march uses
  the same step count as the incremental refresh. The core reads a filtered copy (`cloudShadowFilter`,
  timed): every texel the mean transmittance over a tent of 3 x 3 texels, 7 x 3 under a low sun.
- **Airglow.** Optically thin Gaussian emission layers per body (`AtmosphereRenderDef.airglow`), integrated
  along every eye ray of the march (8 samples per crossing of a layer); in front of the ray's lowest point
  it is in front of everything, beyond it it is attenuated by the whole path and by clouds in front. Density is read no finer than
  1.5 half-resolution pixels under the camera: from far away the map is as smooth as the screen needs.
- **Cloud clock.** `advanceCloudClock`: simulation time, at most `maxTimeRate` x real time, never backwards.

## 4. Run and verify

```
npm run typecheck:paths -- src/render/atmosphere labs/atmosphere tests/browser/atmosphere tests/unit/atmosphere
npx vitest run tests/unit/atmosphere tools/dev/boundaries.test.ts
node tools/dev/heavy.mjs --class=gpu -- npx playwright test tests/browser/atmosphere --project=functional
node tools/dev/heavy.mjs --class=gpu -- npx playwright test tests/browser/atmosphere --project=perf
```

Lab: `/labs/atmosphere/?sun=160,55&view=lat,lon,alt,heading,pitch&cover=0.4,3&cp=key:value;...` (all
parameters at the top of `labs/atmosphere/main.ts`; new: `fine=0`, `tail=1`). `window.__atmo`: `view`,
`setSun`, `viewFromSpace`, `viewEclipse(bodyId, offsetDeg)`, `setQuads` (kinds `transparent`, `opaque`,
`lit`), `volume`, `heavy`, `readLuminance(rect, 'hdr' | 'resolved')`, `probe`, `surfacePoint`.
Tuning: `ATMO_EXPLORE=scenes.json npx playwright test tests/browser/atmosphere/explore.spec.ts`.
Perf tuning: `ATMO_PERF_SCENES=ground,pad`, `ATMO_PERF_QUALITY=1`, `ATMO_PERF_TAIL=1`.
Self-check of the small-shell spec: `ATMO_FINE=0` runs it on the half-resolution march; it then fails.

## 5. Measured (2026-11-10 / 11, this machine, last runs)

Functional suite (end of round 1): 50 passed, 1 failed (`transparents.spec.ts`, broken layer: section 11), 1 skipped (the tuning tool). Unit: 40. Boundary test green. The tables below are from before round 1 where section 11 does not give newer numbers.

| Criterion | Result |
|---|---|
| Zenith luminance, noon (sun 70 deg) | 3,852 cd/m^2 (range 2,667-12,000); GPU / float64 reference 0.9957 |
| Horizon / zenith | 2.62 (> 2) |
| Sun transmittance at the horizon, R/B | 267 at mu = 0.009 (> 3); table vs reference worst 0.09 % |
| Climb 0-200 km, 500 m samples | no rise, largest departure from a smooth profile 0.53 % (deviation 1) |
| Aerial volume vs march, 20 froxels | worst 0.23 % |
| Transparent vs opaque at 50 km | luminance ratio 0.964 (dark quad), 1.027 (bright quad); colour: deviation 3 |
| Deck hides a climbing quad / fog volume | visibility 0.96 -> 0.00 across the base; volume 0.00 % above |
| Broken layer | 0.000 behind a cloud, 0.902 in a gap |
| From orbit | quad under the tops 0.003; 150 km up 0.999 |
| Energy | no NaN, no negative, max 60,000 in five views |
| Coverage map registration (60,000 km) | correlation 0.903 over 1,354 pixels, opacity monotonic in coverage (0.09 at 0 - 0.1, 0.99 at 0.9 - 1) |
| Static frame difference after TAA | mean 0.10 %, 99th percentile 0.87 % |
| 2 km/s ascent vs converged frame | mean 1.4 % / 2.4 %, pixels off by > 30 %: 0.10 % / 0.13 % |
| qualityScale 1 -> 0.7, mean cloud luminance | -0.01 % ground, +2.34 % above a deck, -0.04 % orbit (limit 3 %) |
| Small shell (Earth from the Moon, 29 - 130 px discs) | 0 lit pixels outside the bare planet's disc, 0 holes in its daylight side, air and clouds; with `fine=0` 4 - 109 pixels outside (the review's blocker) |
| Lit surface and cloud shadow | under an overcast deck 0.002 of the clear value; 6 km up, above the deck 1.000; at 400 km 1.000 |
| Frozen step phase vs accumulated (deterministic vs animated) | 10 km horizon bank 2.3 % mean difference, 0.17 % of pixels off by > 25 %; 5 km 1.9 % / 0.00 %; low-orbit limb 0.9 % / 0.00 %; row period 2 below the detail at 3 - 4 rows in all three |
| Tunable sweep (11 sets, overcast from 25 km) | no pixel above a sunlit white surface (brightest 29,000 - 37,000 of 41,446 cd/m^2), no isolated spike, mean cloud transmittance 0.0002 - 0.022 |
| Solar eclipse by the moon | visible share 0.584 -> sky 0.570 of the open sun; central, share 0.040 -> sky 0.041 |
| Twilight sky 40 deg up, 3 deg after sunset | scene rgb 40.5, 41.8, 78.8 cd/m^2; on the screen 32.7, 33.8, 59.6 of 255 (red below green below blue); arch rgb 46.4, 40.6, 66.1 (pink) |

GPU, 1440p, attribution mode, 7 ms ballast, five windows of 160 frames, MEDIAN window (last full run; the
three other GPU slots of the gate were free at its start and end):

| Scene | atmosphere p50 / p99, q 1 | clouds p50 / p99, q 1 | atmosphere, q 0.7 | clouds, q 0.7 |
|---|---|---|---|---|
| pad (budget 0.8) | 0.558 / 0.783 | 0.812 / 0.905 | 0.483 / 0.489 | 0.526 / 0.571 |
| ascent 10 km | 0.582 / 0.805 | 0.635 / 0.705 | 0.504 / 0.737 | 0.526 / 0.585 |
| low orbit | 0.415 / 0.633 | 0.618 / 0.742 | 0.357 / 0.573 | 0.526 / 0.602 |
| low orbit, low sun | 0.357 / 0.587 | 0.547 / 0.642 | 0.309 / 0.531 | 0.427 / 0.459 |
| 60,000 km | 0.163 / 0.386 | 0.355 / 0.418 | 0.141 / 0.147 | 0.277 / 0.303 |
| ground, cumulus overhead (0.8) | 0.564 / 0.578 | 0.978 / 1.147 | 0.482 / 0.527 | 0.626 / 0.703 |
| inside a deck | 0.582 / 0.591 | 0.245 / 0.267 | 0.490 / 0.499 | 0.224 / 0.230 |
| above a deck | 0.589 / **0.928** | 0.421 / 0.452 | 0.503 / 0.756 | 0.319 / 0.342 |

Budgets: atmosphere 0.9 (0.8 at the pad), clouds 1.3 at quality 1 and 0.9 at 0.7. The cloud line is met in
every scene at both scales, in every window of the last two full runs. The atmosphere line is met by its
medians everywhere and by the p99 of the median window in 15 of 16 rows; the spec FAILS on "above a deck"
at quality 1 (0.928 against 0.9) in that run. In the run before it, while other agents' GPU jobs ran, the
same assertion failed on three rows (3.07, 1.29 and 4.11 ms; the cloud line was unaffected).

**The composite spike** (the review's finding 5). `atmosphere.composite` has a median of 0.042 ms and, in
about half of the windows, a p99 of 0.24 - 0.37 ms on a quiet GPU and of up to 2.7 ms on a loaded one.
What was established:
- Nothing of the composite's own work is hidden behind its end timestamp: an empty timed pass right behind
  it (lab query `tail=1`, `ATMO_PERF_TAIL=1`) measures 0.000 / 0.000 ms in every window.
- The spike is not specific to the composite: `atmosphere.skyAerial` (a compute pass, median 0.11 ms) shows
  the same thing (p99 0.27 - 0.33 ms quiet, up to 1.5 ms loaded). In a row it sits in one or the other.
- Its size on a quiet GPU is the same in every scene and at both quality scales, and unrelated to what the
  pass draws (the composite of the 60,000 km view covers a ninth of the screen).
- The medians of all passes repeat to 1 % between runs.
The reading that fits all four: a time slice of ANOTHER GPU context (about 0.25 ms on a quiet machine: the
size of a full-screen blit, i.e. the browser compositing the 2560 x 1440 canvas; milliseconds when other
agents' tests render) inserted where this frame changes engine or target - before the compute pass, before
the first full-resolution pass after the half-resolution ones - and charged to that pass by the timestamps.
This is an inference; what would settle it is the same spec on a machine with nothing else on the GPU.
The three texture copies per frame of the first hand-off are gone (history and geometry alternate between
two targets, the shadow map is refreshed in place), so every byte the package moves is inside a timed pass.

**Screenshots** in `out/screens/atmosphere/`. What was looked at, and in which state:
- In the final state, at full size or as enlarged crops: `earth-moon-distance-wide` and
  `small-shell-{bare,air,clouds}-fov30` (the blocker), the 60,000 km view at 1440p frozen and animated
  (`explore/z-60000-1440p*`, the lattice).
- In the final state, as half-size contact sheets: `clouds-ground-cumulus`, `clouds-ground-sunset`,
  `clouds-ground-cumulus-into-sun`, `clouds-ground-after-sunset`, `clouds-deck-top`, `clouds-above-deck`,
  `clouds-in-deck`, `ascent-10km`, `ascent-25km`, `leo-day`, `leo-day-limb`, `leo-terminator`, `leo-low-sun`,
  `leo-night-limb`, `earth-60000km`, `earth-moon-distance`, `pad-night`, `pad-eclipse-partial`.
- Before the last four changes to the temporal resolve (averaging weight, history reset on view cuts, cloud
  distance of edge pixels, no sub-pixel ray positions from orbit), at full size or as crops:
  `clouds-ground-cumulus`, `leo-day`, `shadow-lit-quad-above-the-deck`, `pad-eclipse`,
  `sampling-low-orbit-limb` and `-animated`, and crops of the 1440p perf frames `perf-low-orbit`,
  `perf-60-000-km` and `perf-ascent-10-km` (the last two are where the residual lattice of section 9 was seen).
- Clear-sky images, unaffected by those changes, as half-size contact sheets: `pad-noon`,
  `pad-sunset-minus-10min`, `pad-sunset`, `pad-anti-twilight`, `ascent-40km`, `ascent-80km`; also
  `clouds-under-deck` and `earth-60000km-crescent` in the earlier state only.
- NOT looked at: the `transparent-*`, `tunables-*` and `clouds-*` test images other than those named,
  `pad-eclipse-none`, `sampling-ascent-*`, and five of the eight 1440p perf frames.
No view was iterated against reference photographs at native 1440p in animated mode, as the review asked;
half-size contact sheets do not show pixel-scale defects.

## 6. Tunables

`earth.atmosphere.json`: `rayleighScattering` is now (7.101, 13.824, 32.476) e-6 and `ozoneAbsorption`
(1.9, 1.721, 0) e-6. These are the coefficients of the sRGB PRIMARIES, not of three wavelengths: the
average of the spectral coefficient over each primary's colour-matching function, weighted by a 5,778 K
sun (unit test in `tests/unit/atmosphere/model.test.ts` recomputes them from the CIE 1931 observer and
the Chappuis cross-sections). For Rayleigh that is a small change from the three-wavelength table (5.802,
13.558, 33.1). For ozone it is not: the red primary sits on the peak of the Chappuis band, its band
average is 2.7e-6 against the 0.65e-6 of 680 nm, and it stays 2.7 - 3.0 e-6 for paths up to 800 km. The
value shipped for red, 1.9e-6, lies between the two on purpose: with 2.7e-6 the twilight zenith is blue
but the anti-twilight arch loses its pink (its light has been reddened before the ozone absorbs from it,
and one coefficient per channel cannot follow that); with the first hand-off's 1.8e-6 and the old Rayleigh
table the arch was pink and the zenith slightly purple. `mieScattering` 2.1e-5 and `mieAbsorption` 2.3e-6
are unchanged from the first hand-off (raised from the research table for the zenith luminance).

`earth.clouds.json`: every key of `CLOUD_PARAM_KEYS` is stated (unit test); unknown keys and values outside
the ranges of `resolveCloudParams` are reported at start-up and replaced by the default. Changed in the
review fixes: `lowEdgeSoftness` 0.18 -> 0.12, `detailErosion` 0.35 -> 0.24 (now a displacement in noise
units), new `lowThinDensity` 0.2 and `lowDensityVariation` 1.0.

## 7. Deviations from the brief (wave-1 reality and physics)

1. **Climb criterion.** "No step larger than 2 % between 500 m samples" cannot hold: an exponential
   atmosphere dims by 6 - 7.5 % per 500 m. The spec tests what a seam would add: departure of each sample
   from the geometric mean of its neighbours under 2 % (measured 0.53 %), no rise, steps under 9 % below 70 km.
2. **`clouds.depth`** is `min(max(mean, begin / 0.9), end / 1.1)`, not the mean distance, because of the
   +-10 % band in `applyAtmosphere` (request 1, open). From orbit a transparent up to ~70 km in front of a
   cloud is hidden with it (a quad 15 km up: visibility 0.003).
3. **One transmittance for three channels** in `atmosphere.aerialPerspective.a` (contract). A white
   transparent 50 km away keeps its brightness within 3 % but not the reddening of the opaque scene (red
   -10 %, blue +27 %). Request 4 asked for a per-channel volume; core-support DECLINED it for this wave
   (a fourth texture in the `transparency` binding set breaks the cockpit's finished shader) and recorded
   the thirty-line change for the lead in `docs/handoff/core-support.md`. The spec asserts luminance only.
4. **Wind** is a rigid eastward drift of the coverage map plus a faster drift of the noise, not latitude bands.
5. **Shadow map** is sun-aligned, not vertical.
6. **"Pad at night under an eclipsed sun"** is two things now: `pad-night` (the sun 40 deg under the horizon,
   i.e. eclipsed by the planet; the sky adds nothing between the stars, the brightest is dimmed to 0.81 by
   extinction) and `pad-eclipse*` (the sun behind the moon; the sky dims by the covered share, measured).
   The lab's eclipse is annular (4 % of the disc stays visible, sky 131 cd/m^2): stars are not visible in it
   and no star assertion is made for it.
7. **Space screenshots use a forced daylight exposure** (EV 14.6).
8. **Step budget of cloud rays = `cloudSteps x qualityScale^2`**, not `x qualityScale` (67 -> 47 steps at
   0.7): with the linear rule the heaviest view missed the 0.9 ms line at quality 0.7 (1.02 ms).
9. **`leo-terminator` was re-framed** (heading 0, sun on the horizon at azimuth 270): the terminator, the
   twilight band and red-lit cloud tops cross the frame. The first hand-off's view (towards a sun 4 deg up)
   is kept as `leo-low-sun`, and is the view the perf spec calls "low orbit terminator".

## 8. Requests

- `atmosphere-clouds-1` (open, non-blocking): begin / end distances in `clouds.depth`.
- `atmosphere-clouds-2` (open, non-blocking): velocity for cloud pixels in the core's TAA.
- `atmosphere-clouds-3` (**resolved**, core-support b5dceb7): the deferred cloud shadow uses the depth
  channels of the map; receivers above the layer are no longer shaded. Still on the old r-only lookup, per
  the resolution: the ocean's own copy (harmless, the sea is under the clouds) and the cockpit's
  (`src/render/cockpit/shaders.ts`: a cabin above a deck is still shaded until it includes `cloud_shadow`).
- `atmosphere-clouds-4` (**declined** for this wave, plan recorded for the lead): per-channel aerial transmittance.
- `atmosphere-clouds-5` (open, to the ocean owner): commit 4ca98ab of this package contains the deletion of
  `tests/browser/ocean/diag.spec.ts`, staged by someone else and swept in by a commit without pathspec.
  Every commit since is made with `git commit -- <owned paths>`.
- `atmosphere-clouds-6` (**resolved**, core-support 926373f): the deferred lighting splits the sun under a
  cloud into beam and cloud-base light (`cloudLight`), and takes a reduced sky as ambient. The ocean's own
  copy of the lookup is `ocean-cs-2` (open, ocean owner).
- `atmosphere-clouds-7` (**resolved**, core-support 1523877): bloom as a glare spread function.
- `atmosphere-clouds-8` (open, bake-earth): a coverage map with dynamic range inside weather systems and a
  cloud-top channel independent of the coverage.
- `atmosphere-clouds-9` (**resolved**, core-support edfd096): `AtmosphereRenderDef.airglow`.
- Against this package: `sky-lighting-9` (airglow) **resolved** in round 1; `map-view-6` (clouds of the map
  view at 14,000 - 24,000 km) answered for the clouds in round 1 (section 11), still open for the stars.

## 9. Known weaknesses

- **Cumulus from the ground** have billows at mid distance now, but the clouds overhead are still large
  smooth bodies with fluted undersides, and the field covers more sky than its nominal coverage (the
  threshold is lowered by half the erosion depth, which over-compensates). Not a photograph.
- **Inside or right next to a cloud** (1.5 km up in a cumulus field) the picture is a featureless gradient.
- **A cloud sea from just above** is dunes with hairline creases; an attempt at finer relief on sheet tops
  made the brightness depend on the quality scale and was removed.
- **From 60,000 km and beyond** the cloud systems are still mostly white-or-not: a quarter of the baked map
  is at coverage 0.9 - 1, and the opacity variation added inside systems fades out by 25 km of footprint.
- **Lattice, residual.** From orbit the sub-pixel ray positions are off, and a faint regular texture is still
  visible at 3x zoom in thin cloud at 60,000 km / 1440p. Inside the atmosphere the positions are on: a far
  horizon bank at 1440p in animated mode shows faint horizontal lines (the four pixels of a block are at
  different points of their averaging schedule). The deterministic frame differs from the accumulated one
  by about 2 % on such banks.
- **God rays / shadows near the sun**: lookups of the shadow map across a cloud edge are smoother (clear
  texels carry the top of the layer as their front) but still a bilinear blend of unlike quantities; not
  re-examined at sunset in a close-up.
- **Resolution dependence of partial cover** (unresolved fields about 10 % brighter at render scale 0.5 than
  at 1) was not re-measured.
- **Tile switch**: the change between the half-resolution and the full-resolution march at 512 px of shell
  rectangle is a cut; nobody has watched an approach through it.
- **Core TAA** has no cloud velocity (request 2).
- **Perf margins**: clouds at quality 0.7 in the heaviest view 0.70 of 0.9 ms; at quality 1 1.15 of 1.3 ms.
  Atmosphere: see section 5.

## 10. Review findings and what was done

| Finding | Done |
|---|---|
| Blocker: Earth from the Moon deformed | Full-resolution tile march of small shells (section 3); `smallshell.spec.ts` with self-check |
| Major: surfaces above the layer shaded | Request 3, resolved by core-support; `shadows.spec.ts` (lit quad under a deck, above it, in orbit) |
| Major: row streaks, dot lattice | Causes: cloud distance borrowed from neighbouring rays (blocks and bars: now per-pixel history), layers point-sampled by long steps (now integrated), last mips of the tiling noise (now the exact mean), half steps blowing the budget of unresolved cloud (now whole steps). `sampling.spec.ts`. Residual: section 9 |
| Major: cloud look | Erosion as displacement seen by the light, opacity variation, soft sheet outlines, band-limited shadow map, sub-pixel averaging of edges, two-stream reflectance. Not photoreal: section 9 |
| Major: atmosphere budget | Copies removed, median window asserted, per-pass output, tail diagnostic; composite spike analysed, not removed: section 5 |
| Minor: screenshots, eclipse, hand-off statement | `leo-terminator` re-framed, `eclipse.spec.ts`, section 5 lists what was looked at |
| Minor: twilight colour, ozone | Finding rejected in part: the red coefficient was not non-physical (section 6, unit test); coefficients of the sRGB primaries; twilight zenith asserted blue in the scene and on the screen |
| Minor: foreign file in a commit | Request 5; pathspec commits |
| Minor: fragile tunables | Cause was a negative optical depth below a sample where the map's top lies under the low layer's (ambient term divided by ~0); fixed, relief clamped to the sheet, ranges validated, `tunables.spec.ts` |
| Minor: transparent colour at 50 km | Request 4, declined for this wave |

## 11. Visual close-out, round 1

The round-0 visual critique (`out/qa/wave2/atmosphere-clouds.md`: photo lens 4 / 10, artifact lens 4 / 10,
21 items) was worked in two runs. Parts 1 - 4 (a4eec0f, acec1f5, 89b4d1a, 3c95159) were made by the first
owner of round 1, whose run ended at a spend limit; the rest (6587a0d, ddf4a33, 77079f9 and the commit with
this section) by its successor, who took over the uncommitted low-sun shadow-map work, finished it and
checked the whole state again. The screenshots named below are the ones in `out/screens/atmosphere/`
written by the last full run of the functional suite (`native-*-1440p.png`: 2560 x 1440, animated, temporal
accumulation running; the rest 1280 x 720, deterministic). They were opened at full size and as enlarged
crops and compared with the photographs of `out/qa/ref/` named per item.

### What was done, item by item

| # | Item (severity) | Done | Look at | State |
|---|---|---|---|---|
| 1 | Pad cumulus are putty under a veil (blocker) | New cloud model (part 1): Perlin-Worley shapes eroded by detail noise, flat bases and domes from a height-dependent threshold, no sheet over fair-weather fields; surfaces found by bisection and marched from there, light from the density gradient, two-stream diffuse light (dark bases, bright tops) (part 2). `cloudlight.spec.ts` asserts the share of the sky the field covers: 0.465 for a map cover of 0.4 (band 0.3 - 0.5) | `native-ground-cumulus-1440p.png`, `native-ground-cumulus-into-sun-1440p.png`, `clouds-ground-cumulus.png`; ref `sky-ground-clouds/cu-humilis-nsw.jpg` | Separate cauliflower cumulus with flat grey bases and blue sky between them, ranks foreshortened towards the horizon. Not met: the large bodies overhead are smoother than in a photograph, and their cauliflower edges are soft at 1:1 |
| 2 | From low orbit: blurred equal blobs, no shadows (blocker) | Shadow map centred where the camera looks from above the layer, mesoscale relief shading, coverage map one level up beyond its resolution (part 3); the map the core reads is filtered (item 3), so the shadow of a cloud on the sea is a soft offset copy instead of the map's texel staircase | `native-leo-day-1440p.png`, `leo-day.png`; ref `earth-orbit-clouds/cloud-gazing-pacific.jpg` | Clouds have lit and shaded sides and relief. Not met: from 400 km a texel of the map is 1.3 - 1.9 km, so the shadow of a cloud a few km across is a soft smudge (sun 20 deg: beside the clouds; sun 50 deg: mostly under them); the fields are popcorn of one size with soft edges |
| 3 | Saw teeth, stripes and combs at low sun (blocker) | (a) Under a low sun the map is narrower along v, its texels about square on the ground (the first owner's uncommitted work, finished). (b) The core reads a FILTERED map: per texel the mean transmittance (beam and total separately) over a tent of 3 x 3 texels, 7 x 3 across the sun's azimuth when the sun is low; the depth channels follow as optical-depth-weighted means. (c) A full re-march uses the same step count as the incremental refresh: two counts in one map drew the 4 x 4 refresh pattern as stripes along the sun's azimuth for the first 64 frames after every re-anchor (the comb of the critique; it survived 4x the steps and the far term switched off, and vanished with a 4096 map and after one full refresh cycle). The density lookups of the map are no longer widened at low sun: the filter does that job | `native-leo-low-sun-1440p.png`, `leo-low-sun.png`, `native-ground-sunset-1440p.png`, `clouds-ground-sunset.png`; ref `earth-orbit-clouds/cloud-shadows-sunset-tanzania.jpg`, `sky-ground-clouds/sunset-crepuscular-pacific.jpg` | No saw teeth, no comb, no texel staircase. At sunset from the ground the shafts fan smoothly from the sun. From orbit under a 4 deg sun the shadows of the field are soft streaks along the sun's azimuth, as in the reference. Cost of the filter pass: 0.02 - 0.03 ms |
| 4 | Whatever a cloud shades turns navy (major) | Request `atmosphere-clouds-6`, resolved by core-support (926373f): the map carries beam and total transmission (two-stream diffuse + fill), the deferred lighting lights a shadow with white cloud-base light and a reduced sky. The air under a cloud follows the same share (`atmoCloudedSource`) | `native-under-deck-1440p.png`, `clouds-under-deck.png`, `shadow-lit-quad-under-the-deck.png`; ref `sky-ground-clouds/overcast-landscape.jpg` | `shadows.spec.ts`: lit quad under the deck at 0.16 of its clear value, blue / red within 1 % of the sunlit one; ground 500 m ahead 0.275 of clear. Deck neutral grey (175, 177, 184), sea slate (74, 84, 106). The ocean's forward surface still reads the map by hand (`ocean-cs-2`, ocean owner) |
| 5 | Overcast decks: contour lines, dunes, veins (major) | Bisection to the surface and steps stratified from it, per-pixel step phase (part 2), light interpolated instead of reused near the surface | `native-above-deck-1440p.png`, `tunables-shipped.png`, `clouds-under-deck.png` | From 6 km at 1440p: a cloud sea of lumps and pits, no contour lines in either mode. Not met: from 25 km (`tunables-*`) the deck is a flat two-tone camouflage of pale cells; from just under its base it is smooth painted lobes with hard edges, not the soft mottling of an overcast photograph |
| 6 | Ascent: flat white splats (major) | Items 1 and 2 | `native-ascent-10km-1440p.png`, `native-ascent-25km-1440p.png`, `ascent-10km.png` | Cumulus with tops, shaded sides and shadows on the islands. Large systems are still smooth white masses from 25 km |
| 7 | Far cloud edge-on: bars and blocks (major) | Far layers integrated analytically per step, candidates of a depth block agree about a cloud, row alternation tested over the whole frame below the horizon (part 4) | `native-ascent-10km-1440p.png`, `sampling-ascent-10km-horizon*.png` | `sampling.spec.ts`: pixels alternating row by row below the horizon 0.18 % (10 km) and 0.32 % (5 km), row period 2 at most 0.04 %; frozen vs accumulated 1.8 / 1.9 % |
| 8 | Clouds do not dim with the sun (major) | Flux on a layer times the two-stream reflectance (parts 1 - 2) | `earth-60000km-crescent.png`, `leo-terminator.png` | `cloudlight.spec.ts`, overcast from 25 km: 0.722 / 0.370 / 0.089 of the 60 deg value at 30 / 10 / 3 deg; the crescent dims towards the terminator, tops pink there |
| 9 | 60,000 km: two-tone white paint (major) | Opacity from the map with mottling kept at the weather scale (parts 1, 3); request `atmosphere-clouds-8` to bake-earth (open) for a map with dynamic range | `native-earth-60000km-1440p.png`, `clouds-orbit-vs-map.png` | Intermediate tones and structure inside systems. `clouds.spec.ts` now measures the picture the frame shows (the full-resolution tile): correlation with the map 0.913, opacity 0.08 at map cover 0 - 0.1 rising to 0.92 at 0.9 - 1. Inside the large systems the map itself is flat (request 8) |
| 10 | Sunset clouds one hue (major) | Shaded cloud lit by the sky away from the sun, sides see the horizon band (parts 2, 4) | `clouds-ground-sunset-side.png`, `native-ground-sunset-1440p.png`; ref `sky-ground-clouds/cb-sunset-panorama.jpg`, `sunset-crepuscular-pacific.jpg` | `cloudlight.spec.ts`: sunlit cloud R/B 3.74, shade 1.55, sky overhead B/R 2.0. Not met: looking INTO the setting sun the backlit clouds are one warm tan about as bright as the sky; the photographs show dark neutral silhouettes with bright rims |
| 11 | Light lags the sun, 2 px border (major) | Light-change detection in the resolve, border texels keep a history (parts 1, 4) | `clouds-ground-after-sunset.png` | `cloudlight.spec.ts`: eight frames after a 4.5 deg step of the sun the frame is at 0.999 of settled; border rows and columns within 0.6 % of their neighbours. After sunset the clouds are dark blue-grey silhouettes against the twilight |
| 12 | Single dark pixels on small discs (major) | Four rays per pixel in the tile, far layers integrated (part 4) | `earth-60000km.png`, `earth-moon-distance-wide.png` | `cloudlight.spec.ts`: isolated dark pixels 0 / 0 / 2 / 0 (60,000 km, crescent, Moon's distance, wide) |
| 13 | Telephoto: staircase limb and blur (major) | The tile is chosen by texel size, not by rectangle size alone (`FINE_TILE_SIZE` 1024, `FINE_TEXEL_SHARE`) (part 3) | `earth-moon-distance.png` | Smooth limb, crisp cloud. A faint speckle of thin cloud remains on the open sea at 3x |
| 14 | Stipple at quality 0.7 (major) | Linear budget; steps lengthen past it instead of light being reused (part 4) | `clouds-quality-0.7-*.png` | `clouds.spec.ts`: grain 0.32 / 0.35 % (ground, q 1 / 0.7), 0.75 / 0.75 % (above a deck); mean luminance -0.99 / -2.54 % |
| 15 | Interlaced scanlines on the sea (major) | Candidates of a block agree (part 4) | `sampling-ascent-5km-horizon.png` | See item 7 |
| 16 | Inside cloud: flat dark grey (minor) | Not worked in round 1 | `clouds-in-deck.png` | Not met: one flat grey |
| 17 | Twilight violet-grey (minor) | Not worked in round 1 | `sky-anti-twilight.png` | Not met: lavender above the belt |
| 18 | Limb stair-stepped at night (minor) | Side effect of items 7 and 15 | `leo-night-limb.png` | The orange layer is continuous; at 3x the lower edge shows a faint step where it crosses a half-resolution texel |
| 19 | Hard regime boundaries (minor) | Steps lengthen past the budget: opacity does not depend on it (part 4) | `tunables-coarse-steps.png`, `leo-low-sun.png` | No arc and no straight line seen |
| 20 | Sun glare (outside the package) | Request `atmosphere-clouds-7`, resolved by core-support (1523877) | `leo-low-sun.png` | The glare still covers a large part of a frame exposed for the sunlit planet with the sun in it |
| 21 | Evidence hygiene (minor) | `native.spec.ts`: ten acceptance views at 2560 x 1440, animated, temporal state reset, each compared with its deterministic frame (means within 1.7 %); every capture resets the cloud history and clock | all | The tuning output under `explore/` was deleted after this round, except the two map-distance frames `m-20000km-1080p.png` and `m-14000km-1080p.png` that request `map-view-6` cites |

New in round 1, from request `sky-lighting-9`: **airglow** (section 3; `leo-night-airglow.png`: a thin
yellow-green band on the night limb, 3.6e-3 cd/m^2, a faint red layer above it; from the ground at a
dark-adapted exposure a faint yellow glow towards the horizon).

### Requests

- Filed: `atmosphere-clouds-6` (resolved), `-7` (resolved), `-8` (open, bake-earth), `-9` (resolved).
- Against this package: `sky-lighting-9` resolved (airglow); `map-view-6` answered for the clouds (see the
  request), open for the stars (sky-lighting).

### Not fixed, and why

- Items 16 (inside a cloud) and 17 (twilight colour) were not worked: the blockers and majors came first.
- Item 5 from under the base, item 10 into the sun, and the soft edges and single size of the fields from
  orbit (items 1, 2, 6) each need a change of the cloud model or its lighting that could not be made and
  verified in the time of this round. What to try next: a base whose brightness follows the optical depth
  above it, with a mottling of its own (overcast from below); for a backlit cloud, the high-order term
  weighted by the transmitted rather than the reflected share of the two-stream solution; from orbit, a
  finer shape octave kept alive to footprints of 1 - 2 km.
- `transparents.spec.ts`, "above a broken layer ...": a quad IN FRONT of the cloud keeps 0.837 - 0.840 of
  its brightness (bound 0.85; behind the cloud 0.002, in the gap 0.86). It fails the same way on the files of
  3c95159 (run for comparison). The bound was not loosened; the spec fails. The missing share is not air
  (the quad in the gap, three times as far, keeps more): `clouds.depth` at that pixel must put the cloud's
  begin nearer than the cloud is.
- The half-resolution cloud buffer from 60,000 km (what transparents read there) is less opaque than the
  picture (mean 0.33 against 0.38).

### Perf
`atmosphere.perf.spec.ts` at the end of round 1 (1440p, attribution mode, 7 ms ballast, five windows of 160
frames, median window). The machine was loaded: the other three GPU slots of the gate ran other agents'
specs the whole time (two of them perf specs). ms, p99 / p50:

| Scene | atmosphere, q 1 | clouds, q 1 | atmosphere, q 0.7 | clouds, q 0.7 |
|---|---|---|---|---|
| pad (budget 0.8) | **0.869** / 0.589 | 0.780 / 0.711 | 0.549 / 0.511 | 0.682 / 0.618 |
| ascent 10 km | 0.648 / 0.610 | 0.771 / 0.704 | 0.582 / 0.530 | 0.664 / 0.614 |
| low orbit | 0.702 / 0.476 | 0.881 / 0.807 | **5.399** / 0.418 | 0.841 / 0.778 |
| low orbit, low sun | 0.636 / 0.405 | 0.814 / 0.737 | **2.220** / 0.358 | 0.769 / 0.697 |
| 60,000 km | 0.502 / 0.278 | 0.827 / 0.773 | 0.260 / 0.238 | 0.537 / 0.504 |
| ground, cumulus overhead (0.8) | **0.846** / 0.585 | 0.795 / 0.704 | 0.743 / 0.508 | 0.701 / 0.623 |
| inside a deck | 0.842 / 0.601 | 0.569 / 0.517 | 0.748 / 0.520 | 0.578 / 0.515 |
| above a deck | 0.819 / 0.606 | 0.886 / 0.838 | 0.758 / 0.524 | 0.785 / 0.736 |

- **Clouds** (budget 1.3 at q 1, 0.9 at q 0.7): met in every scene and every window, p99 at most 0.886 and
  0.841. Lower than at the hand-off before round 1 in the heaviest views (cumulus overhead 0.978 -> 0.704
  p50). New passes: `cloudShadowFilter` 0.018 - 0.020 ms.
- **Atmosphere** (budget 0.9, 0.8 at the pad and under cumulus): every median is inside (0.24 - 0.61 ms).
  The spec FAILS on p99 in this run: the pad at q 1 (0.869 against 0.8) and low orbit at q 0.7 (5.4 ms). The
  excess sits in single passes, as described in section 5 ("the composite spike"): in the pad row the
  composite's p99 is 0.255 ms against a median of 0.042; in the low-orbit row 4.8 ms against 0.042, with
  other GPU contexts running. The airglow added about 0.03 ms to the march's median at the pad (the
  atmosphere median there went from 0.558 to 0.589 ms). The assertion was not changed; the line has to be
  re-measured on a quiet machine.
- Map distances at 1080p in the lab (not in the spec): a disc of 790 - 810 px is marched in the
  full-resolution tile, `cloudMarchFine` 0.76 - 0.80 ms (p50, loaded machine), cloud line about 1.0 ms.
