# Hand-off: ocean

How water is shaded everywhere (the shared `brdf_water` chunk, deferred far sheet and forward near field
alike), the FFT wind waves on top of the physics swell, the near-field forward surface and its hand-over with
the terrain's far sheet (ARCHITECTURE 10.2), refraction and foam, vessel interaction and the hull wet line.
Per-body data only: a body without `BodyDef.ocean` + `render.ocean` costs nothing, and with the camera higher
than `fadeEnd` above the sea no compute or draw of this package runs at all.

## 1. Where things are

```
src/render/ocean/index.ts            public API
src/render/ocean/oceanFeature.ts     createOceanFeature: the RenderFeature, frame logic, debug hooks
src/render/ocean/params.ts           tunables from BodyDef.ocean + render.ocean (validated), Cox-Munk, GGX_KAPPA
src/render/ocean/spectrum.ts         JONSWAP + spreading, high-pass, cascade bands, h0 realisation (CPU, float64)
src/render/ocean/cascades.ts         the four cascade spectra of a body (no GPU dependency)
src/render/ocean/swell.ts            float64 phase preparation of the shared swell + float32 emulation for tests
src/render/ocean/nearField.ts        near-field uniform, planet-fixed chart, CDLOD patch selection
src/render/ocean/fft.ts              GPU: spectrum evolution, 2 x 256-point IFFT passes, assembly, foam, mips
src/render/ocean/vessels.ts          damping zones, splash ripples, wake texture, 'ocean.wetness' slots
src/render/ocean/uniforms.ts         CPU mirror of the WGSL OceanUniforms block
src/render/ocean/shaders/waves.ts    chunk "ocean_waves": chart, swell, cascades, displaced-surface function
src/render/ocean/shaders/waterBrdf.ts  the "brdf_water" override (shared shading function)
src/render/ocean/shaders/surfaceWgsl.ts  forward surface (vertex + fragment) and the readback compute
src/render/ocean/shaders/reactiveWgsl.ts  TAA reactive mask of the near-field water ('post.reactive')
src/render/ocean/shaders/fftWgsl.ts  FFT compute shaders
data/defs/render/earth.ocean.json    tunables (section 7)
labs/ocean/                          lab: main.ts (presets, window.__ocean), labSky.ts, labSim.ts, props.ts, ballast.ts
tests/unit/ocean/                    swellPhases, spectrum, nearField (vitest)
tests/browser/ocean/                 swell, handover, glint, stability, screens (functional); ocean.perf (perf)
```

## 2. Public API (exact signatures)

```ts
// '@/render/ocean'
createOceanFeature(options?: { id?: string; order?: number }): OceanFeature   // id 'ocean', requires ['scene.colorCopy', 'post.reactive']
type OceanFeature = RenderFeature & { readonly debug: OceanDebug };
interface OceanDebug {
  nearField(): OceanNearFieldValue;                       // what 'ocean.nearField' holds this frame
  forceNearFieldOff(off: boolean): void;                  // deferred water only (A/B checks)
  setChopScale(scale: number): void;                      // FFT chop x scale (0 = swell alone)
  setDebugView(view: 'none' | 'skyReflection' | 'body' | 'sunSpecular' | 'foam' | 'normal' | 'roughness'): void;
  setRefractionScale(scale: number): void;
  setReactiveScale(scale: number): void;                  // x the TAA reactive values (0 = no mask)
  setDirectSpecular(on: boolean): void;                   // re-registers brdf_water without the direct specular
  readOpaqueDepth(pixels: readonly [number, number][]): Promise<number[]>;   // 'scene.depthOpaque' at render pixels
  sampleSurface(dirsFixed: readonly Vec3[]): Promise<{ ut: number; samples: OceanSurfaceSample[] }>;
  state(): { active; bodyId; patches; cameraHeight; chartAnchor; coxMunk; swellSlopeVariance; cascades[];
             subCascadeVariance; capillaryAmplitude; vesselZones; ripples; wetSlots };
}
interface OceanSurfaceSample { total; swell; fft; ripple; swellCpu; residual }   // m; swellCpu = oceanSwellHeight (float64)
oceanTunables(body: BodyDef): OceanTunables | null
coxMunkVariance(windSpeed: number): number                // 0.003 + 0.00512 U10
GGX_KAPPA = sqrt(ln 2) / sqrt(sqrt 2 - 1) = 1.2936         // GGX alpha per Gaussian slope sigma (equal half-max width)
nearFieldValue(bodyIndex, hasOcean, altitudeAboveSea, fadeStart, fadeEnd): OceanNearFieldValue
packNearField(v: OceanNearFieldValue, out?: ArrayBuffer): ArrayBuffer      // the 16-byte contract layout
physicsWaterHeight(t: OceanTunables, seaLevel: number, dirFixed: Vec3, ut: number): number   // = sim/world environment
```

The debug hooks are for labs and specs; the app never needs them.

### Shared resources published

| Key | Content |
|---|---|
| `'ocean.nearField'` | 16 bytes: i32 bodyIndex (frame body index, -1 = none), f32 fadeStart, f32 fadeEnd, f32 0. Active while the camera is at most `fadeEnd` above the sea of the NEAREST body and that body has an ocean. From higher up no water pixel is closer than fadeEnd, so the switch is invisible. |
| `'ocean.displacement'` | `rgba16float` 256 x 256 x 4 layers (one per cascade), 9 mips: x = Dx (east, m), y = height (m), z = Dy (north, m), w = dDx/dy. Choppiness already applied. Chart axes (section 4). |
| `'ocean.derivatives'` | same shape: x = dh/dx, y = dh/dy, z = dDx/dx, w = dDy/dy. Jacobian J = (1 + z)(1 + w) - (displacement.w)^2. |
| `'ocean.wetness'` | `OceanWetness` (request ocean-3): slots 0..count-1 are the vessels at the water, active first; `plane.xyz` = camera-relative point of the PHYSICS swell (`physicsWaterHeight`) under the vessel origin, `plane.w` = boundingRadius + 2 m, `normal.xyz` = swell normal there, `normal.w` = wet line above the plane (highest water level reached on the hull, dries at `wetLineDryingRateMps`, a splash raises it to the bounding radius), `params` = (waterSubmersion, seconds since the last splash / water touchdown or -1, 0.05 m chop bound, drying rate). The core mesh system applies it to every standard / terrain fragment (no vehicle change needed). Published even without a near field. |

The `brdf_water` chunk is replaced in `init` (and re-registered when the frame body list changes).

## 3. The shared water shading (`brdf_water`)

One chunk, compiled into the deferred lighting module and into the forward pass; the forward pass replicates
the deferred lighting terms exactly (sun x `sunVisibility` x `atmosphereSunTransmittance` x cloud shadow
(documented placement) x `sampleSunShadow`, sky irradiance tilted by `0.5 + 0.5 n.up`, planetshine of the
same receiver, local lights, map fill light). Not replicated: screen-space AO and the contact-shadow term
(water ignores `s.ao`; the contact term is 1 on open water).

- **Specular**: GGX, F0 0.02, alpha^2 = KAPPA^2 x (0.003 + 0.00512 U10) x m(p) x (1 - s.roughness) +
  lightAlpha^2. KAPPA gives the GGX lobe the half-maximum width of the Gaussian Cox-Munk slope distribution
  (the brief's "angular width within 20 %"); its peak is 1/KAPPA^2 = 0.60 of the Gaussian's. `m(p)` is a
  planet-fixed mesoscale wind variability (log amplitude `windVariability`) times calm slick bands
  (`slickStrength`), giving the glint from altitude its structure.
- **Surface fields for MATERIAL_WATER** (what the far sheet writes leaves the extras 0): `roughness` = the
  FRACTION of the Cox-Munk slope variance the shading normal already carries (0 for the flat sheet: full lobe;
  near the camera about 0.9: glitter), `albedo` = imagery colour, `param` = `encodeWaterDepth(depth)`,
  `metallic` = resolved foam coverage and `clearcoatRoughness` its weight against the statistical whitecaps.
  The terrain renderer needs no change: RT2.r = 0, metallic 0, RT4 neutral.
- **Sky reflection**: the environment probe when one is published (`env.sh9` DC non-zero; mip = sqrt(alpha) x
  (levels - 1)), else the sky-view table blurred over the lobe (5 taps), within 50 km of the camera; the local
  sky irradiance / pi beyond (the core's rule). Directions reflected below the horizon are folded above it (x 0.85).
- **Body colour**: Lee et al. (1998/1999) shallow-water remote-sensing reflectance with per-channel absorption
  (`absorption`) and backscatter (`backscatterR/G/B`): rrs = rrs_deep (1 - e^-(1/muW + Du/muV) K H) + (rho_b/pi)
  e^-(1/muW + Db/muV) K H, Rrs = 0.5 rrs / (1 - 1.5 rrs), refracted sun and view cosines, Fresnel
  transmission. H = decoded depth; the bottom albedo rho_b is the imagery colour, whose chroma also tints the
  deep term (`imageryTint`). Deep open ocean: pi Rrs about (0.0006, 0.007, 0.024).
- **Foam**: statistical whitecaps 3.84e-6 U^3.41 (Monahan & O'Muircheartaigh) x 0.4 (aged foam) on the far
  water; resolved foam near the camera.

## 4. Waves

- **Swell** (`src/core/geo/oceanSwell.ts`, physics-shared): each frame the phase of every component is
  evaluated in float64 at the camera's nadir c (`prepareSwell`) and reduced mod 2 pi; the shader adds
  k (d . delta) for the point's offset delta = R (n - c) (cancellation-free). The drawn surface's height at a
  horizontal position IS `oceanSwellHeight` there: the vertex is displaced horizontally (swell orbits + FFT
  chop, Lagrangian) and the swell height is then evaluated at the FINAL horizontal position. Gradient of the
  fade weight w_i neglected (relative 1e-5). Band-limited per component only where the mesh or the pixel
  cannot resolve it (filter width = distance / 36 for vertices, the pixel footprint for normals).
- **FFT**: 4 cascades of 256^2, patch lengths 8192/7, /29, /113, /449 m; JONSWAP (fetch 200 km, gamma 3.3)
  with Mitsuyasu/Hasselmann cos^2s spreading, capillary-gravity dispersion, high-passed (zero at and above
  25 m, full from 15.6 m), disjoint k-bands (each cascade up to 0.7 of its Nyquist). Dispersion quantised to
  multiples of 2 pi / 3600 s, phase = 2 pi frac(m tau) with tau = frac(t / 3600) in float64: exact anywhere,
  at any mission time. h0(k) e^{-i omega t}: wind waves travel downwind. Realised (time-averaged) variances
  are computed per cascade and used for the unresolved-variance bookkeeping.
- **Capillary layers**: the JONSWAP tail stops at 31 rad/m, Cox-Munk counts the capillaries. Two compressed,
  rotated copies of the finest cascade (x 4.2 and x 17.6) carry what Cox-Munk has beyond swell + cascades
  (less 0.0025 left to the lobe), normals only. Where a pixel cannot resolve them their variance returns to
  the GGX lobe through the same footprint bookkeeping (filtered fraction per mip, CPU-tabulated).
- **Chart**: the wave field and the mesh live on a gnomonic chart of the sea-level sphere anchored at the
  centre of the level-5 cube tile under the camera when the near field switches on (east/north axes); kept
  while active unless the nadir drifts beyond 400 km (scale error 0.4 %). Cascades are sampled at chart
  coordinates modulo their patch length (reduced in float64).
- **Foam**: per cascade, fresh foam where its Jacobian falls more than `foamSigma` standard deviations below 1
  (ramp `foamRampSigma`), temporal decay `foamDecayPerS`, in texture space; coverage weighted (1, 0.85, 0.45,
  0) over the cascades and broken into lace by the short cascades' convergence. Shore (swash) foam where the
  water column over the SEABED (terrain / regolith in the G-buffer, never an object) is under
  `shoreFoamDepthM`, lace-modulated. Wake foam from the wake texture, lace-modulated.

## 5. Near field and hand-over (ARCHITECTURE 10.2)

- Mesh: CDLOD quadtree on the chart (leaf 4 m, 19 levels, patches of 16 x 16 cells, LOD range 3 x node size,
  morph over the outer 25 %: the crack-free condition is unit-tested), selected per frame in float64, frustum
  culled, out to `fadeEnd`. Vertices are placed relative to the nadir (float32 offsets of at most 30 km).
- Detail (displacement, resolved normals, refraction, shore and Jacobian foam) is complete inside
  `detailFadeFraction` x fadeStart (10.5 km) and exactly zero at fadeStart. Between fadeStart and fadeEnd the
  forward surface is the flat sea-level sphere, lifted 5 cm + the coarsest cells' chord sag (about 6 cm) so
  it never z-fights the sheet under `greater-equal`, shaded from the G-buffer's own inputs of the sheet
  under it (`gbuffer.*`, request ocean-1), opacity 1 - smoothstep(fadeStart, fadeEnd, d) over the lit sheet.
- Inside fadeStart the forward pass uses the seabed: water depth from `'scene.depthOpaque'` (vertical,
  stable altitude formula), quantised like RT2.a; the imagery colour from the seabed's `gbuffer.albedo`
  (the terrain draws the seabed with its albedo layer; LabPlanet does the same since request ocean-2).
- Refraction: a 6-step march of the refracted ray through the depth copy (at least 4 m deep, so it passes
  under objects in the water), refined at the crossing, sampling `'scene.colorCopy'` with a chromatic offset
  in the shallows; the in-water path of the march attenuates the seen radiance; it REPLACES the modelled
  bottom term of the body colour (so the near field converges to the far model as detail fades). When the
  refracted view leaves the frame (steep refraction near the bottom edge) the modelled bottom term stays
  (the seabed's own G-buffer albedo; no screen-space features), under an object the last on-screen sample is
  used. Skipped where the seabed cannot be seen (column x min absorption > 3: about 95 m of clear ocean) and
  in the band. A submerged object appears raised and flattened, as at a grazing angle in reality.
- TMA depth attenuation per cascade band (its mean omega) with the seabed depth from the depth copy (vertex
  and fragment); objects in the water do not count as seabed.
- Motion vectors: the surface's own motion (particle orbits, swell, body rotation, camera) from float64
  previous-frame poses, previous FFT field (a copy of last frame's arrays, all mips) and previous swell phases.
- TAA reactive mask (`'post.reactive'`, request ocean-4, pass `ocean.reactive` in `preTransparent`): the wave
  PATTERN evolves with no single motion vector, so where the forward water drew ('scene.depth' nearer than
  'scene.depthOpaque') the pass writes taaReactive x (1 - e^(-phase / 0.1 rad)) x the detail fade, phase =
  omega dt of the shortest wave the pixel resolves (2 x the footprint, longer by 1/sin(grazing) up to the
  4x anisotropy; gravity from the body's ripple dispersion). Frozen time writes nothing (a still sea keeps
  its full history); within metres of a low camera at 60 fps it reaches about 0.45.

## 6. Vessels (snapshot only)

- A vessel is "at the water" when it is in or within `vesselDampingHullRadii` x boundingRadius of the physics
  water surface, has waterSubmersion > 0, or is `splashed` (active vessel first, at most 8).
- Damping: within 3 hull radii the two long cascades vanish and the short ones keep a 3-sigma height under
  4 cm (residual 0.61 here); the chop returns over two more hull radii; the strength fades in as an entering
  vessel comes within its reach. The waterline then follows the physics swell (section 8: 3.8 cm worst).
- Ripples: a 'splash' event, or 'touchdown' on water, starts a radial capillary-gravity packet at the vessel
  (planet-fixed; `rippleWavelengthM`, amplitude x speed / 9 m/s, lifetime `rippleLifetimeS`), drawn in
  displacement and normals.
- Wake: 256^2 texture over 96 m centred on the first vessel at the water (planet-fixed texel grid, scrolled):
  a churn ring at the hull while it is wet, a splash disc on events, e-folding 25 s, slight spreading.
- Wet line: section 2, `'ocean.wetness'`.

## 7. Data (`data/defs/render/earth.ocean.json`)

`windSpeed` 7 m/s, `windDirDeg` 60 (compass direction the wind blows TOWARD), `absorption` (0.45, 0.06, 0.028)
/m, and params: cascade period and divisors, fetch, JONSWAP gamma, high-pass wavelength, choppiness 0.85,
repeat period 3600 s, seed, nearFieldFadeStartM 15000 / nearFieldFadeEndM 30000, detailFadeFraction 0.7,
backscatter (0.0021, 0.003, 0.0045) /m (deep-ocean Rrs at 443/555/670 nm of clear water), imageryTint 0.5,
foam (decay 0.6/s, sigma 3.0, ramp 0.8, albedo 0.72), shoreFoamDepthM 0.8, refractionDistortion 1 (physical),
chromaticOffset 0.012, vesselDampingHullRadii 3, wake extent / splash foam, ripple wavelength / amplitude /
lifetime, wet-line drying rate, capillaryScale 4.2, unresolvedSlopeVariance 0.0025, windVariability 0.35,
slickStrength 0.35, taaReactive 0.45. Every value is validated at load (`oceanTunables`, errors name the file).
Swell (physics) stays in `data/defs/bodies/earth.json` (lead-owned). Gravity for the swell = mu / R^2,
radius = R + seaLevel, exactly as `src/sim/world/environment.ts` calls `oceanSwellHeight`.

## 8. How to run and verify, and what was measured

```
npm run typecheck:paths -- src/render/ocean labs/ocean tests/browser/ocean tests/unit/ocean
node tools/dev/heavy.mjs --class=cpu -- npx vitest run src/render/ocean tests/unit/ocean tools/dev/boundaries.test.ts
node tools/dev/heavy.mjs --class=gpu -- npx playwright test tests/browser/ocean --project=functional    # 22 tests
node tools/dev/heavy.mjs --class=gpu -- npx playwright test tests/browser/ocean --project=perf          # GPU lock
```

Lab: `/labs/ocean/?preset=midday|sunset|overcast|alt500|alt10k|alt100k|leo|shore|refraction|splash|night`,
plus `&ocean=0` (feature removed), `&near=0` (near field off), `&chop=<s>`, `&ballast=<iterations>`, and every
createLabApp parameter. `window.__ocean` (lab handle): `applyPreset`, `setCamera({east, north, alt, heading,
pitch, fov})`, `setSun([az, el])`, `dirAt`, `waterAt`, `seaHit(x, y)`, `altitudeAlong`, `dirAlong`, `project`,
`world` (sun / moon / floating vessel / `splash(speed)`), `props`, `sky`, `ballast`, `ocean` (the feature).

Machine: RTX 5090, Chrome headless, 1280 x 720 unless noted, 2026-11-10/11, other agents' GPU jobs running
concurrently (up to three GPU slots busy).

| Criterion | Result | Spec |
|---|---|---|
| GPU readback of the displaced surface = `oceanSwellHeight` within 2 cm at 200 points and several times; FFT reported separately | worst 0.023 mm over 200 points at 3 sim times; FFT term rms 0.10-0.11 m, max 0.31 m; identity total = swell + fft + ripple to 6e-8 m; Lagrangian solve residual under 0.7 mm | swell.spec |
| Inside the vessel damping zone the total surface within 5 cm of the swell | worst 3.2 / 3.8 / 3.5 cm at 3 times (120 points within 3 hull radii); outside the zone rms 0.11-0.13 m (chop back) | swell.spec |
| Markers at the physics height sit on the rendered surface | RASTERISED surface from the depth buffer at 120 pixels near the camera: chop off, worst 0.011 mm from `oceanSwellHeight`; chop on, worst 6.2 mm from the readback total. Screenshots `markers-swell-only.png`, `markers-with-chop.png`: spheres centred on the physics height are half-submerged | swell.spec |
| Inside fadeStart the depth copy holds the seabed; a submerged object is refracted | `scene.depthOpaque` altitude -200.00 m at 24 pixels (LabPlanet seabed at the sheet's encoded depth); with the near field off 0.000 m (the sheet). The submerged ball's image (frame with minus without it) moves 23.5-24.7 px against the unrefracted lookup and overlaps it by 0.38-0.39 (it appears raised and flattened); `handover-refraction.png` | handover.spec |
| At fadeStart the forward pixel equals the deferred pixel within 2 % | worst 0.18 %, mean 0.03 % over 519 pixels 5-300 m inside fadeStart (camera 6 km up, A/B with the near field forced off, frozen time, jitter off) | handover.spec |
| Across the band the cross-fade of two equal images; a slow dolly shows no line | band worst 0.11 % (12,345 pixels); dolly frame differences at the fade radii about 1.3e-5 against 1.2e-3 elsewhere | handover.spec |
| Beyond fadeEnd nothing is drawn | 9,857 / 9,857 sampled pixels bit-identical to the deferred-only frame | handover.spec |
| Climb 2 m -> 400 km, no ring or pop (frozen time) | 150 log-spaced steps: largest step / local median 1.56 (at 99 km, deferred only); fade radii on screen in 59 steps, worst ring ratio 1.19 (change at the radii vs around them) | handover.spec |
| Feature removed: the far water alone unchanged | `?ocean=0`: 16,188 sampled sea pixels, 0 holes (depth and colour present everywhere) | handover.spec |
| LEO: broad glint at the mirror point, Cox-Munk width within 20 % | isolated exactly (A - B with the direct specular off): peak at facet tan(beta) 0.012; half maximum at tan(beta) 0.167 against 0.164 for sigma^2 = 0.0388 (ratio 1.02) | glint.spec |
| 2 m: a glitter path toward the sun, same function | glint centroid 643.7 px vs the sun's 640.0 px; coefficient of variation 2.06 (sparkles); 3.4 % of the energy off the path | glint.spec |
| Sun on the horizon: no pixel above HDR_MAX, nanPixels 0 | elevations +0.4, 0, -0.3 deg at EV 13 and 4: max 56,131 (saturating glint at EV 4), NaN 0 | glint.spec |
| No swimming when the camera translates | the surface at 64 planet-fixed points from two camera positions 3 km apart: worst 0.38-0.53 mm (2.2 m height spread); 25 steps 250 m away and back: frame bit-identical | stability.spec |
| Triplanar blend zones not visible | not applicable: a single planet-fixed chart replaces triplanar sampling (section 9.1) - no blend zones exist | - |
| Correct motion vectors | TAA output / single-frame gradient energy, camera flying 5 m/s and turning 3 deg/s over a frozen sea: 0.68 of the still camera (terrain with the core's mesh motion vectors: 0.81; this water with its motion vectors zeroed: 0.40). Animated sea with the reactive mask 0.89-0.92 of the still camera, without it 0.41-0.44 | stability.spec |
| Reviewed screenshots | `out/screens/ocean/{midday,sunset,overcast,alt500,alt10k,alt100k,leo,shore,refraction,splash,night}.png` (section 10) | screens.spec |
| Unit tests: float64 phase preparation, spectrum high-pass, near-field uniform | 20 tests (2000 points worldwide out to 30 km within 1 mm and a naive float32 evaluation off by > 10 cm; high-pass zero at >= 25 m on every grid mode; band partition; realised variance within 10 % of the integral; activation by altitude and the 16-byte layout; chart round trip; CDLOD coverage exactly once out to fadeEnd and the crack-free condition) + boundaries | tests/unit/ocean |
| `expectNoErrors` | in every spec | all |

### 8.1 Performance (ARCHITECTURE 17.1 ocean line; brief: FFT < 0.3 ms, near pass < 0.6 ms)

2560 x 1440 internal, `perf=features` (each hook in its own pass), governor off, a ~7-8 ms ballast pass so
the GPU runs at a real frame's clock; three 240-frame windows per scene, the least disturbed one counted
(other agents' GPU work only adds time). p99, ms:

| Scene | ocean total | FFT | water pass (p99 / p50) | line |
|---|---|---|---|---|
| splashdown (3 m, capsule, wake) | 0.666 | 0.282 | 0.609 / 0.333 | 0.9 |
| coast, 60 m above the shelf | 0.755 | 0.056 | 0.698 / 0.381 | 0.8 (pad) |
| 10 km above the sea | 0.615 | 0.277 | 0.546 / 0.284 | 0.3 (ascent) |
| LEO (near field inactive) | 0.000 | 0 | 0 | 0.1 |

Measured with other agents' browser jobs on the GPU at the same time (`tools/dev/heavy.mjs --status` showed
three GPU slots busy); p99 is about twice p50 in every window, so the p99 values are provisional. The
brief's "near pass under 0.6 ms" is missed by 0.009 ms at p99 at splashdown (p50 0.33 ms). The 10 km scene
exceeds the 0.3 ms ascent line: during ascent the camera is above the near field within ~2 minutes, but
between 0 and 30 km the near field is active and costs about what the 10 km row shows.

## 9. Deviations from the brief (and why)

1. **Planet-fixed chart instead of triplanar sampling.** The FFT is sampled on a gnomonic chart anchored per
   near-field session (deterministic: the level-5 cube tile under the camera), modulo the 8192 m period,
   instead of three planar projections. The near field is only 30 km wide, so one chart is exact to 0.4 %
   scale, the wind direction is the data's everywhere (triplanar would rotate it by up to 45 deg and stretch
   the waves up to 41 %), there are no blend zones, and one FFT per cascade suffices. Re-anchoring happens only
   while nothing is drawn or after 400 km of drift.
2. **GGX alpha = 1.2936 sigma.** Matches the glint's half-maximum width to the Gaussian Cox-Munk distribution
   (the acceptance metric); alpha = sigma would be 23 % too narrow.
3. **Capillary detail layers.** Not in the brief: without them more than half of the Cox-Munk variance would
   be GGX roughness even at 2 m and the sea looked milky (diagnosed with the debug views).
4. **Wind / slick roughness field** in `brdf_water` (planet-fixed, both paths): the far water's glint would be
   a featureless blob otherwise. Data: `windVariability`, `slickStrength`.
5. **Body colour model**: Lee et al. shallow-water reflectance instead of the core default's
   `albedo exp(-k d 2.5) + deep`; the imagery colour is the bottom albedo and tints the deep term.
6. **Surface field semantics for water** (section 3) - the far sheet's existing values mean "nothing extra".
7. **Wetness slots** follow the core-support resolution of ocean-3 (slot by position, active vessel first),
   not slot i = snapshot.vessels[i] as first proposed.
8. **Damping** covers the whole 3-hull-radius zone and fades over two more radii (the acceptance asks for the
   swell within 5 cm *within* three hull radii).
9. **Pattern motion**: a phase-velocity term in the motion vectors was tried and measured (it does not help a
   dispersive multi-directional field); motion vectors are those of the surface itself, and the evolving
   pattern is handled by the reactive mask (request ocean-4, resolved by core-support).

## 10. Screenshots (looked at)

`out/screens/ocean/`: `midday` (deep blue, glitter path, rare whitecaps), `sunset` (gold path to the sun on a
dark sea), `overcast` (grey sea, scattered whitecaps), `alt500` (glint path, haze, whitecaps as flecks),
`alt10k` and `alt100k` (curved limb, elongated glint), `leo` (broad glint patch with mesoscale structure),
`shore` and `refraction` (shelf water turquoise over sand, swash line, submerged ball seen through the
surface with its shadow on the seabed), `splash` (capsule-sized hull riding the swell, wake ring, marker
spheres on the physics height), `night` (moon path), `markers-*`, `handover-*`, `glint-*`, `climb-*`,
`stability-animated`, `far-water-alone`.

## 11. Known weaknesses (plainly)

- **Lab sky.** The lab draws its own single-scattering sky (`labs/ocean/labSky.ts`) because atmosphere-clouds
  and sky-lighting were being built at the same time; it has an isotropic multiple-scattering estimate and
  no clouds (overcast is a CIE sky plus a uniform deck in the core's cloud-shadow term). The 10 km and 100 km
  views are dominated by its haze; orbital presets use EV 15 (a camera in sunlight) because without clouds
  or land the meter exposes the dark sea to mid-grey. Re-judge these views in the integrated app.
- **Animated sea under TAA**: with the reactive mask the moving sea keeps its detail (0.89 against 0.41
  without), at the price of less temporal anti-aliasing on the nearest waves (a reactive pixel leans on this
  frame's 3 x 3 reconstruction). Moving sun glints are still rejected by the core's firefly guard.
- **Swell lattice from altitude**: the four discrete swell components of `bodies/earth.json` form a regular
  crossing pattern visible as a fine lattice in the glint from 5-15 km. Heights are physics and must stay;
  more components with directional spread (data, lead) would look natural.
- **Detail fade**: as the contract requires, wave detail is gone at fadeStart (15 km): from 10-30 km
  altitude the sea is the flat sheet with the roughness field only (no swell lines in the glint).
- **Whitecap calibration**: resolved foam is tuned by eye (rare white flecks at 7 m/s); its mean coverage is
  not calibrated against the statistical Monahan coverage used beyond the detail zone.
- **Refraction** is screen-space: what the refracted ray meets off screen (steep refraction near the bottom
  edge) falls back to the modelled bottom, and a faint seam can show between the two on a perfectly flat sea
  (not with waves); objects behind the water's own crests are not seen.
- **Underwater views** (eye below the surface) are not handled: the surface is drawn from above only.
- **TMA** uses the seabed under the pixel / vertex from the depth copy: vertices off screen use the nearest
  edge pixel. The swell is never depth-attenuated (it is the physics surface).
- **Perf margins are thin** at splashdown (near pass p99 at the 0.6 ms line); next steps if needed: a cheaper
  shadow lookup for water pixels far from casters, fewer capillary samples at grazing angles.
- **Lab props** (beach, capsule-sized cone, markers) are test geometry, not game assets.
- Body colour constants per body are embedded in the chunk text; the chunk is re-registered (pipelines
  rebuilt once) when the frame body list changes.

## 12. Requests

| Request | Against | Status |
|---|---|---|
| `ocean-1` G-buffer views for drawWater (`gbuffer.albedo/normal/material`, set `gbuffer`) | core | resolved b812ec4; used for the band and the seabed's imagery colour |
| `ocean-2` LabPlanet seabed = the water its sheet describes (depth and albedo) | core lab | resolved 9debd1f; the hand-over spec relies on it |
| `ocean-3` `'ocean.wetness'` shared uniform | contracts | resolved 9debd1f (slot-by-position, see section 2) |
| `ocean-4` TAA reactive mask for surfaces whose pattern has no single motion vector | core TAA | resolved (2cc2aea); used by `ocean.reactive` |

No request against the ocean's paths was open at hand-off.
