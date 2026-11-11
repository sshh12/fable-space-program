# Hand-off: atmosphere-clouds

The sky of every body with an atmosphere, from the pad to the Moon's distance: scattering tables, one
per-pixel march composited into the HDR target, volumetric clouds driven by the baked coverage map, cloud
shadows for the deferred lighting, and the buffers every transparent draws through (`applyAtmosphere`).
Per-body data only; a frame with no atmosphere in view runs no pass of this package and publishes neutral
buffers.

This is the state after the review fixes (section 10 lists what the review found and what was done).
Two things are NOT met and are stated first:

- **The clouds are not photoreal.** They are better than at the first hand-off (section 9 says where and
  where not), but cumulus from the ground still read as modelled shapes, and a cloud sea from just above as
  dunes with creases.
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
tests/unit/atmosphere/                  math.test.ts, model.test.ts (35 tests)
tests/browser/atmosphere/               sky, screens, transparents, clouds, smallshell, shadows, sampling, tunables, eclipse specs;
                                        atmosphere.perf.spec.ts; explore.spec.ts (tuning tool, skipped)
docs/requests/atmosphere-clouds-1.md ... -5.md   (section 8)
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
| `clouds.shadowMap` | rgba32float 1024^2: r = optical depth of the layer along the sun line, g = distance along the projection direction `L = cross(axisU, axisV)` at which the cloud begins on the sun side (clear texels: the top of the layer), b = mean extinction behind that point. A receiver at distance s has `tau = clamp((g - s) b, 0, r)`: the core's chunk `cloud_shadow` reads it that way since core-support commit b5dceb7 |
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
- **Shadow map.** Sun-aligned orthographic (elevation clamped to 4 deg, off below -2 deg), body-fixed
  anchor, origin in whole texels, one texel in 16 re-marched per frame IN PLACE; in a frame in which the
  origin moves, into a scratch target and back with a blit pass (both timed). Density is read no finer than
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

Functional suite: 45 passed, 1 skipped (the tuning tool). Unit: 35. Boundary test green.

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
- No open request against this package's paths.

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
