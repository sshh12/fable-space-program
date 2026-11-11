# Hand-off: ocean

How water is shaded everywhere (the shared `brdf_water` chunk, deferred far sheet and forward near field
alike), the FFT wind waves and the long-wave normals layer on top of the physics swell, the near-field forward
surface and its hand-over with the terrain's far sheet (ARCHITECTURE 10.2), refraction and foam, vessel
interaction and the hull wet line. Per-body data only: a body without `BodyDef.ocean` + `render.ocean` costs
nothing; with no water within `fadeStart` of the camera no compute or draw of this package runs (only the
`brdf_water` override in the core's deferred lighting and the 'ocean.wetness' upload).

Revision after the independent review (2026-11-11): band shading chosen by distance (stray water fragments),
band beyond 1.05 fadeStart read from the deferred pass, no work while all water is beyond fadeStart, horizon
culling, per-layer FFT skipping, the long-wave normals layer, gust and filament octaves in the roughness field,
whitecap calibration, a view-independent seabed depth, continuous refraction blending, the perf spec against each
17.1 line, the LEO glint located in 2-D slope space. Section 13 lists every finding and what was done.

## 1. Where things are

```
src/render/ocean/index.ts            public API
src/render/ocean/oceanFeature.ts     createOceanFeature: the RenderFeature, frame logic, debug hooks
src/render/ocean/params.ts           tunables from BodyDef.ocean + render.ocean (validated), Cox-Munk, GGX_KAPPA
src/render/ocean/spectrum.ts         JONSWAP + spreading, high-pass, cascade bands, long-wave complement, h0 (CPU, float64)
src/render/ocean/cascades.ts         the four cascade spectra and the long-wave layer of a body (no GPU dependency)
src/render/ocean/swell.ts            float64 phase preparation of the shared swell + float32 emulation for tests
src/render/ocean/nearField.ts        near-field uniform, planet-fixed chart, CDLOD patch selection, horizon distance
src/render/ocean/fft.ts              GPU: spectrum evolution, 2 x 256-point IFFT passes, assembly, foam, mips (5 layers, masked)
src/render/ocean/vessels.ts          damping zones, splash ripples, wake texture, 'ocean.wetness' slots
src/render/ocean/uniforms.ts         CPU mirror of the WGSL OceanUniforms block
src/render/ocean/shaders/waves.ts    chunk "ocean_waves": chart, swell, cascades, displaced-surface function
src/render/ocean/shaders/waterBrdf.ts  the "brdf_water" override (shared shading function, roughness field)
src/render/ocean/shaders/surfaceWgsl.ts  forward surface (vertex + fragment) and the readback compute
src/render/ocean/shaders/reactiveWgsl.ts  TAA reactive mask of the near-field water ('post.reactive')
src/render/ocean/shaders/fieldWgsl.ts  bake of the roughness field into a mip-mapped texture over the near field
src/render/ocean/shaders/fftWgsl.ts  FFT compute shaders
data/defs/render/earth.ocean.json    tunables (section 7)
labs/ocean/                          lab: main.ts (presets, window.__ocean), labSky.ts, labSim.ts, props.ts, ballast.ts
tests/unit/ocean/                    swellPhases, spectrum, nearField (vitest)
tests/browser/ocean/                 swell, handover, glint, stability, foam, screens (functional); ocean.perf (perf)
```

## 2. Public API (exact signatures)

```ts
// '@/render/ocean'
createOceanFeature(options?: { id?: string; order?: number }): OceanFeature   // id 'ocean', requires ['scene.colorCopy', 'post.reactive']
type OceanFeature = RenderFeature & { readonly debug: OceanDebug };
interface OceanDebug {
  nearField(): OceanNearFieldValue;                       // what 'ocean.nearField' holds this frame
  forceNearFieldOff(off: boolean): void;                  // deferred water only (A/B checks)
  setChopScale(scale: number): void;                      // FFT chop and long-wave layer x scale (0 = swell alone)
  setDebugView(view: 'none' | 'skyReflection' | 'body' | 'sunSpecular' | 'foam' | 'normal' | 'roughness'): void;
  setRefractionScale(scale: number): void;
  setReactiveScale(scale: number): void;                  // x the TAA reactive values (0 = no mask)
  setDirectSpecular(on: boolean): void;                   // re-registers brdf_water without the direct specular
  readOpaqueDepth(pixels: readonly [number, number][]): Promise<number[]>;   // 'scene.depthOpaque' at render pixels
  sampleSurface(dirsFixed: readonly Vec3[]): Promise<{ ut: number; samples: OceanSurfaceSample[] }>;
  state(): { active; bodyId; patches; cameraHeight; chartAnchor; coxMunk; swellSlopeVariance; cascades[];
             subCascadeVariance; capillaryAmplitude; longWave; windSpeed; layerMask; vesselZones; ripples; wetSlots };
}
interface OceanSurfaceSample { total; swell; fft; ripple; swellCpu; residual }   // m; swellCpu = oceanSwellHeight (float64)
oceanTunables(body: BodyDef): OceanTunables | null
coxMunkVariance(windSpeed: number): number                // 0.003 + 0.00512 U10
GGX_KAPPA = sqrt(ln 2) / sqrt(sqrt 2 - 1) = 1.2936         // GGX alpha per Gaussian slope sigma (equal half-max width)
nearFieldValue(bodyIndex, hasOcean, altitudeAboveSea, fadeStart, fadeEnd): OceanNearFieldValue
packNearField(v: OceanNearFieldValue, out?: ArrayBuffer): ArrayBuffer      // the 16-byte contract layout
horizonDistance(camH: number, waveMargin: number, seaRadius: number): number   // patches beyond are culled
physicsWaterHeight(t: OceanTunables, seaLevel: number, dirFixed: Vec3, ut: number): number   // = sim/world environment
```

The debug hooks are for labs and specs; the app never needs them.

### Shared resources published

| Key | Content |
|---|---|
| `'ocean.nearField'` | 16 bytes: i32 bodyIndex (frame body index, -1 = none), f32 fadeStart, f32 fadeEnd, f32 0. Active while the camera is at most `fadeEnd` above the sea of the NEAREST body and that body has an ocean. From higher up no water pixel is closer than fadeEnd, so the switch is invisible. |
| `'ocean.displacement'` | `rgba16float` 256 x 256 x **5 layers**, 9 mips: layers 0-3 the cascades, x = Dx (east, m), y = height (m), z = Dy (north, m), w = dDx/dy, choppiness applied. Layer 4 is the long-wave NORMALS layer (section 4): only its slopes are used, it is not part of the displaced surface. Chart axes (section 4). A layer that no pixel can resolve is not updated that frame (`state().layerMask`) and holds stale content. |
| `'ocean.derivatives'` | same shape: x = dh/dx, y = dh/dy, z = dDx/dx, w = dDy/dy. Jacobian J = (1 + z)(1 + w) - (displacement.w)^2. |
| `'ocean.wetness'` | `OceanWetness` (request ocean-3): slots 0..count-1 are the vessels at the water, active first; `plane.xyz` = camera-relative point of the PHYSICS swell (`physicsWaterHeight`) under the vessel origin, `plane.w` = boundingRadius + 2 m, `normal.xyz` = swell normal there, `normal.w` = wet line above the plane (highest water level reached on the hull, dries at `wetLineDryingRateMps`, a splash raises it to the bounding radius), `params` = (waterSubmersion, seconds since the last splash / water touchdown or -1, 0.05 m chop bound, drying rate). The core mesh system applies it to every standard / terrain fragment. Published even without a near field. |

The `brdf_water` chunk is replaced in `init` (and re-registered when the frame body list changes); the
forward pass includes its variant `"ocean_water_forward"` (identical but for the roughness-field source).

## 3. The shared water shading (`brdf_water`)

One chunk, compiled into the deferred lighting module and into the forward pass; the forward pass replicates
the deferred lighting terms exactly (sun x `sunVisibility` x `atmosphereSunTransmittance` x cloud shadow
(documented placement) x `sampleSunShadow`, sky irradiance tilted by `0.5 + 0.5 n.up`, planetshine of the
same receiver, local lights, map fill light). Not replicated: screen-space AO and the contact-shadow term
(water ignores `s.ao`; the contact term is 1 on open water).

- **Specular**: GGX, F0 0.02, alpha^2 = KAPPA^2 x (0.003 + 0.00512 U10) x m(p) x (1 - s.roughness) +
  lightAlpha^2. KAPPA gives the GGX lobe the half-maximum width of the Gaussian Cox-Munk slope distribution;
  its peak is 1/KAPPA^2 = 0.60 of the Gaussian's.
- **Roughness field m(p)** (`WATER_FIELD_WGSL`, planet-fixed, mean about 1), which gives the glint from altitude
  its structure from about 100 m up: mesoscale wind (25-90 km, log amplitude `windVariability`), broad slicks
  (30 km x 2.5 km bands along the wind, depth `slickStrength`) where the wind is light, **gusts** ("cat's paws",
  1.5 km and 0.5 km octaves stretched 1.4 : 1 downwind, log amplitude `gustVariability`) and **slick filaments**
  (about 150 m wide, km long, depth `filamentStrength`) in the calmer regions. Octaves finer than the footprint
  fade out (`waterOctave`: 1 below 0.25 x their period, 0 above 0.6 x), so nothing aliases at any distance. The
  deferred path evaluates it once per pixel with the footprint across the view (distance x pixel angle; six
  gradient-noise calls where everything is resolved, four from orbit); the forward pass reads it from a 2048^2
  r16float texture baked over the near field (75 km, 37 m texels, the texel as footprint) with a 10-level box mip
  chain, sampled with the pixel's own derivatives (4x anisotropic), re-baked when the reference moves 1.9 km,
  the chart or the body changes.
- **Surface fields for MATERIAL_WATER** (what the far sheet writes leaves the extras 0): `roughness` = the
  FRACTION of the Cox-Munk slope variance the shading normal already carries (0 for the flat sheet: full lobe),
  `albedo` = imagery colour, `param` = `encodeWaterDepth(depth)`, `metallic` = foam coverage and
  `clearcoatRoughness` its weight against the statistical whitecaps (0 far; the forward pass passes its complete
  coverage with weight 1). The terrain renderer needs no change: RT2.r = 0, metallic 0, RT4 neutral.
- **Sky reflection**: the environment probe when one is published (`env.sh9` DC non-zero; mip = sqrt(alpha) x
  (levels - 1)), else the sky-view table: one tap where the lobe is narrow (spread under 0.03 rad: the near
  field's resolved waves leave a few hundredths), the four-tap ring blended in up to 0.08 rad; within 50 km of the
  camera; the local sky irradiance / pi beyond (the core's rule). Directions reflected below the horizon are
  folded above it (x 0.85).
- **Body colour**: Lee et al. (1998/1999) shallow-water remote-sensing reflectance with per-channel absorption
  and backscatter: rrs = rrs_deep (1 - e^-(1/muW + Du/muV) K H) + (rho_b/pi) e^-(1/muW + Db/muV) K H,
  Rrs = 0.5 rrs / (1 - 1.5 rrs), refracted sun and view cosines, Fresnel transmission. H = decoded depth; the
  bottom albedo rho_b is the imagery colour, whose chroma also tints the deep term (`imageryTint`).
- **Foam**: statistical whitecaps 3.84e-6 U^3.41 (Monahan & O'Muircheartaigh) x 0.4 (aged foam) = 0.117 % at
  7 m/s on the far water; the resolved foam of the near field is calibrated to the same mean (section 8).

## 4. Waves

- **Swell** (`src/core/geo/oceanSwell.ts`, physics-shared): each frame the phase of every component is
  evaluated in float64 at the camera's nadir c (`prepareSwell`) and reduced mod 2 pi; the shader adds
  k (d . delta) for the point's offset delta = R (n - c). The drawn surface's height at a horizontal position IS
  `oceanSwellHeight` there (Lagrangian displacement, swell evaluated at the final position). Band-limited per
  component only where the mesh or the pixel cannot resolve it.
- **FFT cascades**: 4 x 256^2, patch lengths 8192/7, /29, /113, /449 m; JONSWAP (fetch 200 km, gamma 3.3) with
  Mitsuyasu/Hasselmann cos^2s spreading, capillary-gravity dispersion, high-passed (zero at and above 25 m, full
  from 15.6 m), disjoint k-bands, dispersion quantised to multiples of 2 pi / 3600 s (exact at any mission time).
- **Long-wave normals layer** (new; layer 4 of the wave arrays, `longWaveDivisor` 5: 1638.4 m patch, waves from
  18 m to the patch size): the same spectrum where the cascades' high-pass does NOT pass it, with its amplitudes
  scaled so that its slope variance is the spectrum's long-wave slope variance LESS what the physics swell
  carries (0.00323 against the swell's 0.00124; gain 0.85, height RMS 0.47 m that is NOT drawn). Drawn as SLOPES
  only, two copies rotated by -/+ `longWaveSpreadDeg` (20 deg) at half variance each: the two lattices are
  incommensurate, so the sum does not repeat, and each copy's waves travel along their own rotated direction with
  the true dispersion. TMA-attenuated in shallow water, faded with the wave detail, in the variance bookkeeping
  (the capillary layers carry correspondingly less: 0.0152). The drawn heights stay exactly the physics swell.
  It replaces the regular crossing pattern of the four swell components with an irregular short-crested sea in
  the glint from 1-15 km (screenshots `alt3k`, `alt10k`).
- **Capillary layers**: two compressed, rotated copies of the finest cascade (x 4.2 and x 17.6) carry what
  Cox-Munk has beyond swell + cascades + long waves (less 0.0025 left to the lobe), normals only.
- **Layer skipping**: no pixel sees the sea sharper than the nadir does (footprint = (height - wave bound) x
  pixel angle). A layer filtered there beyond `OCEAN_LOD_CUT` + 0.75 mip is not updated that frame (FFT passes
  return at once for it) and has amplitude 0 in every shader; one that comes back starts a new history. At 1440p
  the finest cascade drops out above about 3 km, the third above about 12 km.
- **Per-pixel cut-off**: a layer filtered beyond 4.5 mips at the pixel (`OCEAN_LOD_CUT`: under 0.1 % of its
  slope variance survives, from `filteredSlopeFraction`) is not sampled; it fades out over the mip before, its
  variance returns to the lobe through the same bookkeeping.
- **Chart**: gnomonic chart of the sea-level sphere anchored at the centre of the level-5 cube tile under the
  camera when the near field switches on; kept while active unless the nadir drifts beyond 400 km.
- **Foam**: per cascade, fresh foam where its Jacobian falls more than `foamSigma` standard deviations below 1
  (ramp `foamRampSigma`), decay `foamDecayPerS`, in texture space. Coverage weights (0.55, 0.85, 0.45, 0) over
  the cascades: cascade 0 (13-25 m, long crests) only adds to what the shorter breaking crests of cascade 1 start.
  Lace from the convergence of cascades 1-3 (cascade 1 cuts long crests into breaking-crest lengths of 5-10 m);
  the lace threshold never drops below 0.22 and the brightness varies with the bubbles, so no whitecap is a
  uniform white disc. Where the footprint averages the lace away, the threshold widens by the lost spread (the
  pixel gets its expected partial coverage instead of a hard-edged blob), and where a cascade's foam is filtered
  beyond 2.5 mips its share is the statistical coverage. Shore (swash) foam where the water over the SEABED is
  under `shoreFoamDepthM`; wake foam from the wake texture; both lace-modulated.

## 5. Near field and hand-over (ARCHITECTURE 10.2)

- Mesh: CDLOD quadtree on the chart (leaf 4 m, 19 levels, patches of 16 x 16 cells, LOD range 3 x node size,
  morph over the outer 25 %), selected per frame in float64, frustum culled and **horizon culled** (a patch whose
  nearest horizontal point is beyond the camera's horizon plus a crest's, `horizonDistance`, is not drawn: from
  3 m only 11 km of the 30 km disc), out to `fadeEnd`.
- **Nothing is drawn while all water is beyond fadeStart** (camera height minus the wave bound above fadeStart):
  then every water pixel is in the band, where the forward surface would only repeat the deferred sheet's
  radiance; the FFT, the forward pass and the reactive mask are skipped ('ocean.nearField' stays as the contract
  says: active up to fadeEnd).
- Detail (displacement, resolved normals, refraction, shore and Jacobian foam) is complete inside
  `detailFadeFraction` x fadeStart (10.5 km) and exactly zero at fadeStart.
- **The band** (fadeStart to fadeEnd): the forward surface is the flat sea-level sphere (lifted 5 cm + the
  coarsest cells' chord sag) with opacity 1 - smoothstep(fadeStart, fadeEnd, d) over the lit sheet. Its colour:
  - from fadeStart to 1.05 fadeStart the forward pass evaluates `brdf_water` from the sheet's own G-buffer inputs
    (`gbuffer.*`, request ocean-1), as before; this ring is needed because the core's screen-space terms of the
    deferred pass (AO, 1.5 % of the distance wide) see the depth step down to the seabed inside fadeStart and
    darken the sheet beside it by up to 17 % (measured: pixels at 15.00-15.04 km, 6 km camera);
  - beyond 1.05 fadeStart it takes the deferred pixel's radiance from 'scene.colorCopy' (the same brdf_water on
    the same inputs, so the cross-fade of two equal images is exact) instead of evaluating it again.
- **Band shading is chosen by DISTANCE** (`dist >= fadeStart` and a water fragment underneath), never by the
  material id alone. Inside fadeStart the terrain has discarded its sheet; a WATER fragment found there anyway
  (the integrated terrain leaves misplaced sheet fragments at the seabed's altitude, request terrain-render-cs-1)
  is treated as open deep water: the pixel keeps its waves, normal and roughness, takes the fragment's imagery
  colour, no refraction, no TMA or shore foam from it. Before this fix such fragments turned into a flat,
  wave-less band 1-2 km from a low camera in the integrated app.
- Inside fadeStart the forward pass uses the seabed: water depth **straight below the water point**
  (`oceanDepthBelow`: the vertical is marched down through the depth copy over about twice the along-ray depth,
  refined between the last two steps; for a shelf that only rises or falls the bed under the point is in view),
  so shore foam and TMA no longer depend on where the camera stands; the along-ray depth is used where the
  vertical leaves the frame. The imagery colour from the seabed's `gbuffer.albedo`.
- Refraction: a 6-step march of the refracted ray through the depth copy (at least 4 m deep), refined at the
  crossing, sampling 'scene.colorCopy' with a chromatic offset in the shallows; the in-water path attenuates the
  seen radiance; it replaces the modelled bottom term with a **confidence** that fades to the model as the hit
  nears the end of the march or the frame border (12 % of the frame), so neighbouring pixels never switch between
  the two looks.
- TMA depth attenuation per band with the vertical seabed depth (vertex and fragment); the long-wave layer too.
- Motion vectors from float64 previous-frame poses, previous FFT field and previous swell phases.
- TAA reactive mask ('post.reactive', request ocean-4): taaReactive x (1 - e^(-phase / 0.1 rad)) x the detail
  fade, phase = omega dt of the shortest wave the pixel resolves. Frozen time writes nothing.

## 6. Vessels (snapshot only)

- A vessel is "at the water" when it is in or within `vesselDampingHullRadii` x boundingRadius of the physics
  water surface, has waterSubmersion > 0, or is `splashed` (active vessel first, at most 8).
- Damping: within 3 hull radii the two long cascades vanish and the short ones keep a 3-sigma height under
  4 cm; the chop returns over two more hull radii.
- Ripples on 'splash' / water 'touchdown' events; wake texture (256^2 over 96 m) around the first vessel at the
  water; wet line in 'ocean.wetness'.

## 7. Data (`data/defs/render/earth.ocean.json`)

`windSpeed` 7 m/s, `windDirDeg` 60 (toward), `absorption` (0.45, 0.06, 0.028) /m, and params: cascade period and
divisors, fetch, JONSWAP gamma, high-pass wavelength, **longWaveDivisor 5, longWaveSpreadDeg 20**, choppiness
0.85, repeat period 3600 s, seed, nearFieldFadeStartM 15000 / nearFieldFadeEndM 30000, detailFadeFraction 0.7,
backscatter, imageryTint 0.5, foam (decay 0.6/s, sigma 3.0, ramp 0.8, albedo 0.72), shoreFoamDepthM 0.8,
refractionDistortion 1, chromaticOffset 0.012, vesselDampingHullRadii 3, wake / splash / ripple / wet-line
values, capillaryScale 4.2, unresolvedSlopeVariance 0.0025, windVariability 0.35, slickStrength 0.35,
**gustVariability 0.3, filamentStrength 0.45**, taaReactive 0.45. Every value is validated at load.
Swell (physics) stays in `data/defs/bodies/earth.json` (lead-owned, request ocean-5).

## 8. How to run and verify, and what was measured

```
npm run typecheck:paths -- src/render/ocean labs/ocean tests/browser/ocean tests/unit/ocean
node tools/dev/heavy.mjs --class=cpu -- npx vitest run src/render/ocean tests/unit/ocean tools/dev/boundaries.test.ts
node tools/dev/heavy.mjs --class=gpu -- npx playwright test tests/browser/ocean --project=functional    # 27 tests
node tools/dev/heavy.mjs --class=gpu -- npx playwright test tests/browser/ocean --project=perf          # GPU lock
```

Lab: `/labs/ocean/?preset=midday|sunset|overcast|alt500|alt3k|alt10k|alt30k|alt100k|leo|shore|shoreAlong|refraction|splash|night`,
plus `&ocean=0` (feature removed), `&near=0` (near field off), `&stray=1` (stray water fragments inside fadeStart),
`&chop=<s>`, `&ballast=<iterations>`, and every createLabApp parameter. `window.__ocean` (lab handle):
`applyPreset`, `setCamera({east, north, alt, heading, pitch, fov})`, `setSun([az, el])`, `dirAt`, `waterAt`,
`seaHit(x, y)`, `altitudeAlong`, `dirAlong`, `project`, `world`, `props` (incl. `strayWater`), `sky`, `ballast`,
`ocean` (the feature).

Machine: RTX 5090, Chrome headless, 1280 x 720 unless noted, 2026-11-11, other agents' GPU jobs running in the
other GPU slots throughout (vfx, terrain, atmosphere, core-support).

| Criterion | Result | Spec |
|---|---|---|
| GPU readback of the displaced surface = `oceanSwellHeight` within 2 cm at 200 points and 3 times; FFT separately | worst 0.023 mm; FFT term rms 0.11-0.12 m, max 0.32 m; total = swell + fft + ripple to 6e-8 m | swell.spec |
| Inside the vessel damping zone the total within 5 cm of the swell | worst 3.2 / 3.8 / 3.5 cm at 3 times; outside rms 0.11-0.13 m | swell.spec |
| Markers at the physics height sit on the rendered surface | rasterised surface (depth buffer, 120 px): chop off worst 0.010 mm from `oceanSwellHeight`; chop on worst 6.4 mm from the readback | swell.spec |
| Inside fadeStart the depth copy holds the seabed; a submerged object is refracted | depth copy altitude -200.00 m at 24 px (0.000 with the near field off); the submerged ball's image moves 22.8 px against the unrefracted lookup, overlap 0.41 | handover.spec |
| **Stray water fragments inside fadeStart leave the waves intact** (new) | annulus of water material 150 m deep, 0.2-4 km out (`props.strayWater`), confirmed in the depth copy at 15 of 24 sampled px: relative detail 6.372e-2 vs 6.371e-2 (ratio 1.000), mean luminance equal, 88,437 px. With the old per-pixel material test the same check gives ratio 0.563 and +21 % brightness (the flat band) | handover.spec |
| At fadeStart the forward pixel equals the deferred pixel within 2 % | worst 0.18 %, mean 0.03 % over 519 px | handover.spec |
| Across the band two equal images; slow dolly shows no line | band worst 0.11 % (12,345 px); dolly change at fadeStart 6e-4 vs 6.6e-3 elsewhere | handover.spec |
| Beyond fadeEnd nothing is drawn | 9,857 / 9,857 px bit-identical to the deferred-only frame | handover.spec |
| Climb 2 m -> 400 km, no ring or pop | 150 log-spaced steps: largest step / local median 1.56 (99 km, deferred only); ring = change on the radius (+-4 %) against the bands on both sides (4-15 %): worst 1.09 over 56 steps | handover.spec |
| Feature removed: far water alone complete | 16,188 sea px, 0 holes | handover.spec |
| LEO: broad glint at the mirror point, Cox-Munk width within 20 % | half maximum at tan(beta) 0.188 vs 0.164 (ratio 1.14); in facet-slope space over fully covered discs (64/64 cells) of radius 0.08 / 0.12 / 0.16: centroid 0.0042 / 0.0044 / 0.0037 (bound 0.02), least-squares paraboloid peak 0.0065 / 0.019 at 0.12 / 0.16 (bound 0.03; the 0.08 disc is too flat to fit) | glint.spec |
| 2 m: glitter path toward the sun, same function | centroid 640.0 px vs the sun's 640.0; coefficient of variation 2.16; 2.6 % of the energy off the path | glint.spec |
| Sun on the horizon: no pixel above HDR_MAX, nanPixels 0 | elevations +0.4, 0, -0.3 deg at EV 13 and 4: max 56,220 (saturating glint at EV 4), NaN 0 | glint.spec |
| Whitecaps calibrated (new) | resolved foam coverage looking down from 150 m at 9 places: 0.095-0.135 %, mean 0.117 %, against the far water's statistical 0.117 % (ratio 1.00) | foam.spec |
| No swimming when the camera translates | 64 planet-fixed points from two camera positions 3 km apart: worst 0.53 mm; 250 m away and back: bit-identical | stability.spec |
| Triplanar blend zones not visible | not applicable: one planet-fixed chart (section 9.1) | - |
| Correct motion vectors | TAA / single-frame gradient energy, camera flying 5 m/s over a frozen sea 0.64 of still; animated sea 0.85 with the reactive mask, 0.41 without | stability.spec |
| Reviewed screenshots | `out/screens/ocean/` (section 10) | screens.spec |
| Unit tests | 22 ocean tests (long-wave layer: complement of the high-pass, swell + layer = the spectrum's long-wave slopes within 10 %; horizon culling keeps every visible point exactly once) + boundaries | tests/unit/ocean |
| `expectNoErrors` | in every spec | all |

### 8.1 Performance (ARCHITECTURE 17.1: 0.9 splashdown, 0.8 pad, 0.3 ascent 10-40 km, 0.1 LEO; brief: FFT < 0.3, near pass < 0.6)

2560 x 1440, `perf=features`, governor off, ~7 ms ballast. Six 240-frame windows per scene, the MEDIAN of the
windows' p99 (and p50) is reported; each scene is asserted against its own line. Latest run (2026-11-11 06:15,
vfx and terrain functional suites in the other two GPU slots), ms:

| Scene | ocean p99 / p50 | water pass p99 / p50 | FFT (quiet windows) | line | result |
|---|---|---|---|---|---|
| splashdown (3 m, capsule, wake) | 1.90 / 0.49 | 1.42 / 0.41 | 0.07 | 0.9 (near pass 0.6) | p99 FAILS; p50 within |
| coast, 60 m above the shelf | 0.87 / 0.59 | 0.79 / 0.51 | 0.07-0.09 | 0.8 (near pass 0.6) | p99 FAILS by 0.07 (ocean) / 0.19 (near pass) |
| 10 km above the sea | 0.54 / 0.30 | 0.46 / 0.23 | 0.06 (4 of 5 layers) | 0.3 | p99 FAILS; p50 at the line |
| LEO | 0 / 0 | 0 | 0 | 0.1 | holds |

Additionally reported: the `brdf_water` override's share of the core's deferred lighting ('core.lighting' with
minus without the ocean feature, same scene): LEO +0.134 p50 / +0.03 p99 ms, 10 km +0.130 p50 / +0.40 p99 ms. It
is the core's lighting line, not the ocean's; it rose by about 0.035 ms at 10 km with the gust and filament
octaves (six noise calls per pixel where resolved, four from orbit) and fell with the one-tap sky reflection.

What the p99 values are: within one run the windows of the same scene range 0.67-2.8 ms (splashdown water
pass), and the stalls are additive and independent of the pass's work. Probe runs (temporary switches in the
shader, removed): with the fragment returning at once the water pass measured p50 0.057 and still p99 0.29;
with all major fragment terms removed p50 0.175 and p99 0.63, the same p99 as the full pass; the core's own
lighting pass WITHOUT the ocean feature measured p50 0.173 / p99 0.41-0.45 at LEO in the same runs (the
reviewer's quieter run: 0.172 / 0.197). In windows without such stalls the p99 is within a few percent of the
p50 (10 km: 0.200 / 0.193). The p99 assertions therefore fail on this shared GPU; the p50 values are what the
pass costs. Per PACKAGE_RULES 16 these numbers are provisional until the lead re-measures on a quiet machine.

Where the splashdown fragment time goes (probe run, before the long-wave layer; water pass p50 0.352): cascade
and capillary sampling 0.057, sun shadow lookup 0.041 (the core's PCSS blocker search, 8 taps, on every lit
pixel), ambient term 0.030, direct sun term 0.024, swell evaluation 0.023, vertex + raster + pass overhead 0.057,
the rest (G-buffer and depth reads, amplitudes, ripples, wake, field, transmittance, sky irradiance, foam) about
0.12. The long-wave layer and the field octaves added about 0.02 ms p50 to the pass and 0.01 ms to the FFT.

## 9. Deviations from the brief (and why)

1. **Planet-fixed chart instead of triplanar sampling** (exact to 0.4 % scale over the 30 km near field, the
   wind direction is the data's everywhere, no blend zones, one FFT per cascade).
2. **GGX alpha = 1.2936 sigma** (half-maximum width of the Gaussian Cox-Munk distribution).
3. **Capillary detail layers** (without them half the Cox-Munk variance is GGX roughness at 2 m: milky sea).
4. **Roughness field** in `brdf_water` (mesoscale wind, slicks, gusts, filaments): the glint from altitude
   would be a featureless blob otherwise.
5. **Body colour model**: Lee et al. shallow-water reflectance.
6. **Surface field semantics for water** (section 3).
7. **Wetness slots** follow the core-support resolution of ocean-3.
8. **Damping** covers the whole 3-hull-radius zone and fades over two more radii.
9. **Pattern motion** handled by the reactive mask (ocean-4), not by a pattern motion vector (measured useless).
10. **Long-wave normals layer** (new): render-only slopes of the long-wave sea the physics swell does not carry.
    The brief makes the swell the only long-wave HEIGHT; this layer adds no height (swell agreement unchanged at
    0.023 mm). Its patch is 1638 m; two rotated copies keep it from tiling.
11. **The band beyond 1.05 fadeStart takes the deferred pixel's radiance** from 'scene.colorCopy' instead of
    re-evaluating `brdf_water` from the same G-buffer inputs: the same function on the same inputs, so the
    cross-fade is of two identical images (0.11 % worst, the ring next to fadeStart); the forward surface, its
    opacity ramp, depth and motion vectors are as the architecture describes.
12. **No forward draw, FFT or reactive mask while every water pixel is beyond fadeStart** (camera above
    fadeStart + wave bound): 'ocean.nearField' stays active up to fadeEnd as the contract says, but the band
    alone would only repeat the deferred image.
13. **Climb ring metric**: the change on each fade radius is compared with the bands on both sides of it, not
    with the whole 11-37.5 km region: with structure in the glint, the frame change of a climbing camera grows
    smoothly toward the nearer rows, which the old metric read as a "ring" at fadeEnd for a 23 km camera (2.4)
    although the per-row profile has no step at 30 km (diagnosed row by row, then removed).

## 10. Screenshots (looked at)

`out/screens/ocean/`: `midday` (deep blue, glitter path, long-wave texture, breaking crests of 5-10 m), `sunset`,
`overcast`, `alt500`, `alt3k` (irregular short-crested sea in the glint where the four-component lattice was),
`alt10k` (wave texture near, gust mottling in the far glint), `alt30k` and `alt100k` (mottled glint), `leo`,
`shore`, `shoreAlong` (standing in the shallows looking along the beach: sand bars as soft patches, no switching
between looks), `refraction`, `splash`, `night` (moon path), `foam-coverage-*`, `handover-*` (incl.
`handover-stray-water`), `glint-*`, `climb-*`, `markers-*`, `stability-animated`, `far-water-alone`, `perf-*`.

## 11. Known weaknesses (plainly)

- **Perf p99 on this shared GPU fails** the splashdown, coast and 10 km lines (section 8.1); p50 is under the
  near-pass line at splashdown (0.41) and the coast (0.51) and at the ascent line at 10 km (0.30 total). The
  10 km scene has no margin: between fadeStart 15 km and the 10 km camera the forward pass shades the whole
  detail region. Further cuts would be the shadow lookup (0.04 ms, the core's PCSS on every lit pixel; a water
  pixel cannot know whether a caster is near without the core's help) and the swell evaluation per pixel.
- **Lab sky**: the lab draws its own single-scattering sky with no clouds; its haze dominates the 10-100 km
  views. Re-judge those views in the integrated app (core-support's water spec).
- **Swell data**: the heights the capsule floats on are still the four sinusoids of `bodies/earth.json`; the
  long-wave layer hides their lattice in the shading (request ocean-5, escalated to the lead).
- **Detail fade**: as the contract requires, wave detail (including the long-wave layer) is gone at fadeStart;
  from 5-15 km altitude the wave texture of the near part changes into the field-only texture of the far sheet
  over 10.5-15 km (gradual, no line, but visible as a change of texture).
- **Shallow water**: the modelled bottom term and the screen-space refracted bed still differ somewhat in
  colour in very shallow water; the blend between them is now continuous (by march and frame-border
  confidence), so it shows as soft sand-bar-like patches, not edges.
- **Seabed depth** is marched down the vertical through the depth copy: where the bed directly below a water
  point is hidden behind a nearer bump of the bed (an irregular, non-monotonic shelf) the march stops early and
  the depth reads too shallow there.
- **Whitecaps**: calibrated in mean coverage only; their persistence and lace are tuned by eye. Seen at grazing
  angles near the horizon they still read as short smooth streaks.
- **Refraction** is screen-space; **underwater views** (eye below the surface) are not handled.
- **Stale wave layers**: a layer skipped for being unresolvable keeps old content in 'ocean.displacement' /
  'ocean.derivatives'; external readers must not rely on it above about 3 km (finest cascade) / 12 km.

## 12. Requests

| Request | Against | Status |
|---|---|---|
| `ocean-1` G-buffer views for drawWater | core | resolved b812ec4; used for the band ring and the seabed's imagery colour |
| `ocean-2` LabPlanet seabed = the water its sheet describes | core lab | resolved 9debd1f |
| `ocean-3` `'ocean.wetness'` shared uniform | contracts | resolved 9debd1f |
| `ocean-4` TAA reactive mask | core TAA | resolved 2cc2aea |
| `ocean-5` eight swell components with directional spread | `data/defs/bodies/earth.json` (lead) | declined by core-support as not its path: escalated to the lead (recorded in core-support's hand-off) |

Interaction with **terrain-render-cs-1** (open, core-support against the terrain): the terrain leaves water
fragments at the seabed's altitude inside fadeStart (29.8 % of the near field at 200 m). The ocean no longer
depends on that being fixed: such fragments are now shaded as open deep water with their waves (section 5,
`handover.spec` "stray water"). They still make the refraction and seabed depth of those pixels unknown (deep),
so the request stays needed for shallow water. The request file is core-support's; this note is here instead.
No request against the ocean's paths is open.

## 13. Review findings and what was done

| Finding | Done |
|---|---|
| Major: flat band 1-2 km out from stray water fragments | Fixed (section 5); lab injection `props.strayWater` / `&stray=1` and a spec that fails with the old code (ratio 0.563) and passes now (1.000) |
| Major: perf | Spec asserts every scene against its own line (10 km: 0.3), the near pass at the coast too, median of windows; FFT, forward and reactive skipped with all water beyond fadeStart; horizon culling; per-layer FFT skipping; per-pixel cut-off at 4.5 mips; one sky tap for narrow lobes; band beyond 1.05 fadeStart from the copy. The p99 lines still fail on the shared GPU (section 8.1, with the evidence that the p99 is additive stalls); p50 within the near-pass line, at the 10 km line |
| Major: featureless gradient + swell lattice from 1.5-30 km | Long-wave normals layer; gust and filament octaves in the roughness field (both paths, footprint-filtered); request ocean-5 for the swell data. Re-judged in the lab (alt3k / alt10k / alt30k); the integrated-app views need core-support's water spec rerun |
| Minor: crisp shallow-water patches | Continuous confidence blend (march end, frame border), vertical seabed depth; `shoreAlong` preset judged: soft patches, no switching. Colour difference of the two bottom models remains (section 11) |
| Minor: view-dependent shore foam / TMA | Depth straight below the water point by a vertical march through the depth copy (section 5); limit stated in section 11 |
| Minor: lighting-pass share not reported | Measured and reported in the perf spec and section 8.1 (+0.13 ms p50); octave count kept down (slick fine octave dropped, octaves skipped below the footprint) |
| Minor: LEO glint check weakened | 2-D facet-slope centroid over fully covered discs (bound 0.02) and an unbiased paraboloid-fit peak (bound 0.03) replace the radial-profile peak |
| Minor: plastic foam | Lace at every distance with the threshold widened by the lost lace spread (partial coverage instead of blobs), breakup in the cores, cascade 1 in the lace and cascade 0's weight lowered (no long bars), statistical share where unresolved, calibrated to Monahan (ratio 1.00) |
