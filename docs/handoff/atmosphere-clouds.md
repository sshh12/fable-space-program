# Hand-off: atmosphere-clouds

The sky of every body with an atmosphere, from the pad to the Moon's distance: scattering tables, one
per-pixel march at half resolution composited into the HDR target, volumetric clouds driven by the baked
coverage map, cloud shadows for the deferred lighting, and the buffers every transparent draws through
(`applyAtmosphere`). Per-body data only; a frame with no atmosphere in view runs no pass of this package and
publishes neutral buffers.

## 1. Where things are

```
src/render/atmosphere/index.ts          public API
src/render/atmosphere/feature.ts        createAtmosphereFeature: the RenderFeature, march + composite passes, debug hooks
src/render/atmosphere/tables.ts         AtmosphereTables: transmittance, multi-scattering, sky irradiance, sky view, aerial volume (compute)
src/render/atmosphere/clouds.ts         CloudSystem: noise, coverage map, shadow map, quarter-area march + temporal resolve, cloud clock
src/render/atmosphere/select.ts         which bodies are marched, with how many samples, in which screen rectangle
src/render/atmosphere/params.ts         cloud tunables (validated; unknown keys are reported)
src/render/atmosphere/uniforms.ts       one field table -> WGSL struct AtmoU + CPU writer
src/render/atmosphere/math.ts           CPU mirrors of the table parameterisations, stable altitude, ray / shell geometry (float32-faithful)
src/render/atmosphere/reference.ts      float64 brute-force reference model (tests)
src/render/atmosphere/shaders/model.ts  chunk "atmosphere_model": medium, phases, AtmoRay, importance CDF, sample
src/render/atmosphere/shaders/luts.ts   compute shaders of the five tables
src/render/atmosphere/shaders/march.ts  chunk "atmosphere_cloud_shadow", the march, the composite
src/render/atmosphere/shaders/clouds.ts chunk "atmosphere_cloud_density", cloud march, resolve, shadow map, noise generation
data/defs/render/earth.atmosphere.json, earth.clouds.json    tunables (section 6)
labs/atmosphere/                        lab (query parameters in main.ts; window.__atmo)
tests/unit/atmosphere/                  math.test.ts, model.test.ts (32 tests)
tests/browser/atmosphere/               sky, screens, transparents, clouds specs; atmosphere.perf.spec.ts; explore.spec.ts (tuning tool, skipped)
docs/requests/atmosphere-clouds-1.md, -2.md   open, non-blocking (section 8)
```

## 2. Public API

```ts
import { createAtmosphereFeature } from '@/render/atmosphere';
renderer.addFeature(createAtmosphereFeature());          // options: { id?, order?, clouds?: boolean, coverageMaps? }
```

`createAtmosphereFeature(options | RenderContext = {}): AtmosphereFeature` - a `RenderFeature` with hooks
`prepare`, `compute`, `compositeAtmosphere`, `isIdle`, `dispose`, plus `invalidate()` (rebuild static tables
after editing definitions) and `debug` (`readTable(name)`, `selection()`, `clouds()`). A `RenderContext`
passed in place of options is accepted (the brief's spelling) and ignored: `init` receives the context.
One feature id (`atmosphere`); the cloud passes are named `atmosphere.cloudShadow`, `atmosphere.cloudMarch`,
`atmosphere.cloudResolve`, the others `atmosphere.tables`, `.skyAerial`, `.march`, `.composite`.

Published every frame (`prepare`), neutral when nothing is in range:

| Key | Content |
|---|---|
| `atmosphere.transmittanceLut` | 256 x 64 x layers, render-core parameterisation (layer = rank among frame bodies with an atmosphere) |
| `atmosphere.skyIrradianceLut` | 64 x 16 x layers, u = (mu_s + 0.2) / 1.2 |
| `atmosphere.skyViewLut` | 192 x 108, the nearest atmosphere body, core `skyViewUv`; a = mean transmittance of the path |
| `atmosphere.aerialPerspective` | 32^3 rgba16float; rgb = in-scatter in cd/m^2 (clamped to HDR_MAX), a = LUMINANCE-weighted transmittance |
| `clouds.screen` | half resolution, rgb = pre-exposed premultiplied radiance, a = transmittance, on the UNJITTERED pixel lattice |
| `clouds.depth` | r32float, see section 7 for what the value is; 3.0e38 = none |
| `clouds.shadowMap` | rgba32float 1024^2: r = optical depth along the projection (what the core reads), g = front distance, b = mean extinction |
| `clouds.coverageMap` | the body's coverage map (rg8unorm with mips) |

`coreOf(ctx).setCloudShadowParams({ near, far })` is called in `prepare` every frame (null terms when off).

Shader chunks registered at init: `"atmosphere_model"`, `"atmosphere_cloud_shadow"`. Nothing outside imports
`@/render/atmosphere` except the app shell and labs.

## 3. How it works (what a maintainer must know)

- **Ray frame.** Every path is measured from where the ray enters the atmosphere shell (`AtmoRay`: the eye
  when inside), and altitudes come from the stable formula started there. This is what keeps float32
  exact to centimetres from the pad and to tens of metres from 384,400 km (unit-tested against float64).
  The cloud march uses the same frame; a camera-origin altitude at lunar distance was the cause of
  per-pixel darkening of the clouds.
- **March.** 24 x qualityScale samples placed by a piecewise-linear CDF whose knots crowd around the ray's
  lowest point; medium and smooth light at stratum midpoints (a clear sky has no noise), only the cloud
  shadow lookup is dithered. Eclipses by other bodies are evaluated at the two ends of a path; the body's
  own shadow per sample. Two candidates per half-res texel (farthest / nearest depth of its 2 x 2 block);
  the composite interpolates them at the pixel's depth. Pixels whose four texels agree in depth take a
  two-lookup bilinear path (most of the frame).
- **HDR bound.** `add <= HDR_MAX (1 - mul)` with a slack of 8 (not storable in a half float at HDR_MAX).
  Without the slack the glow above 85 km vanished one colour channel at a time where 1 - T fell below
  float32 resolution: the climb test found it.
- **Clouds.** Low layer (noise x height gradient above 1 - coverage), high sheet under the map's cloud top
  (analytic bell integral per step), deep fill near coverage 1; fair-weather fields are synthesised where
  the map is clear. Noise is read one mip above the footprint; what the mips averaged away becomes a cloud
  FRACTION with spread sqrt(1 - kept^2), combined with maximum overlap. Steps grow with distance
  (`stepFactor`, `stepMinM`, `stepMaxM`); when a ray would need more than the budget the whole rule is
  coarsened by the factor that makes it fit (not a uniform floor). Entering a cloud the slabs restart at
  its surface: bisection to a fraction of a mean free path for shapes, the crossing of a linearly sloping
  top for sheets. The sheet top is carried along its slope to the lighting point. All of this is there
  because a dense cloud returns its light from the first tens of metres: errors in where it begins show as
  contour lines and streaks.
- **Light.** Six cone samples towards the sun (detail in the first two), then shadow map / coverage map;
  three multi-scatter octaves + a two-stream diffuse term + sky and ground ambient. Slabs that add little
  reuse the light of the last lit slab, up to 4 % of the cloud in a pixel (10 % at qualityScale 0.7). The
  quality scale changes only that and the step budget, never step sizes: shapes and opacity stay.
- **Temporal.** One ray per 2 x 2 half-res block per frame (4-frame cycle), history reprojected by cloud
  distance and body motion, clamp in proportion to pixel motion. Deterministic mode freezes the noise.
- **Shadow map.** Sun-aligned orthographic (elevation clamped to 4 deg, off below -2 deg), body-fixed anchor,
  origin in whole texels, one texel in 16 re-marched per frame, extent in sqrt(2) steps with altitude.
- **Cloud clock.** `advanceCloudClock`: simulation time, at most `maxTimeRate` x real time, never backwards.
  The coverage map drifts east rigidly (`coverageLongitudeOffset()`), the noise a little faster.

## 4. Run and verify

```
npm run typecheck:paths -- src/render/atmosphere labs/atmosphere tests/browser/atmosphere tests/unit/atmosphere
npx vitest run src/render/atmosphere tests/unit/atmosphere
node tools/dev/heavy.mjs --class=gpu -- npx playwright test tests/browser/atmosphere --project=functional
node tools/dev/heavy.mjs --class=gpu -- npx playwright test tests/browser/atmosphere --project=perf
```

Lab: `/labs/atmosphere/?sun=160,55&view=lat,lon,alt,heading,pitch&cover=0.4,3&cp=key:value;...` (all
parameters at the top of `labs/atmosphere/main.ts`). `window.__atmo`: `view`, `setSun`, `viewFromSpace`,
`setQuads`, `volume`, `heavy`, `readLuminance(rect, 'hdr' | 'resolved')`, `probe`, `surfacePoint`.
Tuning: `ATMO_EXPLORE=scenes.json npx playwright test tests/browser/atmosphere/explore.spec.ts` renders a
list of scenes with probes and pass times.

## 5. Measured (2026-11-10, this machine, last runs)

| Criterion | Result |
|---|---|
| Zenith luminance, noon (sun 70 deg) | 3,786 cd/m^2 (range 2,667-12,000); GPU / float64 reference 0.9955 |
| Horizon / zenith | 2.61 (> 2) |
| Sun transmittance at the horizon, R/B | 435 at mu = 0.009 (> 3); table vs reference worst 0.07 % |
| Climb 0-200 km, 500 m samples | no rise, largest departure from a smooth profile 0.54 % (see deviation 1) |
| Aerial volume vs march, 20 froxels | worst 0.34 % (in-scatter and transmittance) |
| Transparent vs opaque at 50 km | luminance ratio 0.964 (dark quad), 1.028 (bright quad) |
| Deck hides a climbing quad / fog volume | visibility 0.98 -> 0.00 across the base; volume 0.00 % above |
| Broken layer | 0.000 behind a cloud, 0.906 in a gap |
| From orbit | quad under the tops -0.002; 150 km up 0.999 |
| Energy | no NaN, no negative, max 60,000 in five views |
| Coverage map registration (60,000 km) | correlation 0.863 over 1,354 pixels, opacity monotonic in coverage |
| Static frame difference after TAA | mean 0.11 %, 99th percentile 1.1 % |
| 2 km/s ascent vs converged frame | mean 1.9 % / 5.2 %, pixels off by > 30 %: 1.3 % / 2.6 % |
| qualityScale 1 -> 0.7 | -0.09 % ground, +1.55 % above a deck, +0.79 % orbit |
| GPU, 1440p, quality 1 (p99) | atmosphere 0.16-0.81 ms (pad 0.59; budget 0.8 / 0.9), clouds 0.25-0.92 ms (budget 1.3) |
| GPU, 1440p, quality 0.7 (p99) | atmosphere 0.14-0.72 ms, clouds 0.25-0.75 ms (budget 0.9) |

Perf method: attribution mode, scale 1, 7 ms ballast encoded LAST in the compute hook (first, its tail was
charged to `atmosphere.cloudShadow`), five windows of 160 frames, each line's least disturbed window.
Not inside any timed pass: two `copyTextureToTexture` of the cloud history (22 MB) and one of the shadow
map (16 MB) per frame.

Screenshots (all looked at): `out/screens/atmosphere/` - `pad-*`, `ascent-*`, `leo-*`, `earth-*`,
`clouds-*`, `transparent-*`, `perf-*-1440p`.

## 6. Tunables changed from the research table

`earth.atmosphere.json`: `ozoneAbsorption` red 0.65e-6 -> 1.8e-6 and blue 0.085e-6 -> 0.13e-6 (twilight and
limb were purple through the AgX tone map), `mieScattering` 3.996e-6 -> 2.1e-5 and `mieAbsorption` -> 2.3e-6
(zenith luminance was 2,000 cd/m^2, half the brief's range). `earth.clouds.json`: rewritten; every key of
`CLOUD_PARAM_KEYS` is stated (a unit test enforces it) and unknown keys fail the lab at start-up.

## 7. Deviations from the brief (wave-1 reality and physics)

1. **Climb criterion.** "No step larger than 2 % between 500 m samples" cannot hold: an exponential
   atmosphere dims by 500 m / scale height = 6 % per sample (7.5 % at the ground with the Mie layer). The
   spec tests what a seam would add: departure of each sample from the geometric mean of its neighbours
   under 2 % (measured 0.54 %), no rise, steps under 9 % below 70 km.
2. **`clouds.depth`** is `min(max(mean, begin / 0.9), end / 1.1)`, not the mean distance, because of the
   +-10 % band in `applyAtmosphere` (request 1). From orbit a transparent up to ~70 km in front of a cloud
   is hidden with it.
3. **One transmittance for three channels** in `atmosphere.aerialPerspective.a` (contract). It is the
   luminance-weighted one: a white transparent 50 km away keeps its brightness within 3 % but not the
   reddening of the opaque scene (red -13 %, blue +29 % in the test).
4. **Wind** is a rigid eastward drift of the coverage map plus a faster drift of the noise, not latitude
   bands: the core's far shadow term takes one longitude offset.
5. **Shadow map** is sun-aligned, not vertical; the core reads only its `r` channel, as its contract says.
6. **Brief's "pad at night under an eclipsed sun"** is rendered with the sun 40 deg below the horizon. The
   lab's star field is faint; the test shows the sky adds exactly nothing between the stars and dims the
   brightest by airmass extinction only (ratio 0.78).
7. **Space screenshots use a forced daylight exposure** (EV 14.6): the lab's metering would expose for the
   black around the planet.

## 8. Requests

- `docs/requests/atmosphere-clouds-1.md` (open, non-blocking): begin / end distances in `clouds.depth`.
- `docs/requests/atmosphere-clouds-2.md` (open, non-blocking): velocity for cloud pixels in the core's TAA.
- No open request against this package's paths.

## 9. Known weaknesses

- **Cumulus from the ground are smooth.** Silhouettes are crisp, bases grey, tops lit, but the bodies read
  as soft modelled shapes: the cauliflower micro-structure of real cumulus is missing (detail erosion acts
  on edges only and the light samples see little of it). This is the part furthest from a photograph.
- **Cloud tops seen at a shallow angle** (just above a deck) are smooth dunes with relief only in the near
  field; a few hairline creases remain on a cloud sea.
- **Resolution dependence of partial cover.** At render scale 0.5 the unresolved fields seen from orbit
  are about 10 % brighter than at scale 1 (the fraction model versus resolved clouds).
- **From 60,000 km** the cloud field is flatter and harder-edged than photographs (little variation in
  opacity inside systems); the baked map's cloud-top channel is nearly a function of coverage.
- **God rays and shadows near the sun at sunset** show the shadow map's texels as facets.
- **Twilight zenith** is grey-lavender rather than deep blue after the tone map (HDR values are blue).
- **Core TAA** has no cloud velocity (request 2); the perf lines exclude three texture copies per frame.
- A one-off page start-up timeout (240 s in `openPage`) occurred once in the screenshot spec under
  concurrent load and did not recur.
