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

Revision after the first visual critique (wave 2, round 1, 2026-11-11; `out/qa/wave2/ocean.md`): glitter from
sea-anchored facet statistics, the sun mirrored with the Gaussian (Cox-Munk) slope distribution, the roughness
field in a planet-wide wind chart (slick filaments, calm pools, gusts, wind rows, internal waves), the far-wave
bank on the far sheet, whitecaps from a camera-centred foam map of the combined surface drawn through a foam
lace, surf bores, caustics, vessel reflections, a seabed depth that ignores objects, the forward pass lit under
cloud as the deferred pass is, lab views at the meter's exposure. Section 14 goes through the critique item by
item.

## 1. Where things are

```
src/render/ocean/index.ts            public API
src/render/ocean/oceanFeature.ts     createOceanFeature: the RenderFeature, frame logic, debug hooks
src/render/ocean/params.ts           tunables from BodyDef.ocean + render.ocean (validated), Cox-Munk, GGX_KAPPA
src/render/ocean/spectrum.ts         JONSWAP + spreading, high-pass, cascade bands, long-wave complement, h0 (CPU, float64)
src/render/ocean/cascades.ts         the four cascade spectra and the long-wave layer of a body (no GPU dependency)
src/render/ocean/swell.ts            float64 phase preparation of the shared swell + float32 emulation for tests
src/render/ocean/nearField.ts        near-field uniform, planet-fixed chart, CDLOD patch selection, horizon distance
src/render/ocean/fft.ts              GPU: spectrum evolution, 2 x 256-point IFFT passes, assembly, mips (5 layers, masked)
src/render/ocean/fieldModel.ts       the roughness field (wind chart, slicks, gusts, rows, internal waves): CPU reference of the WGSL
src/render/ocean/farWaves.ts         the far-wave bank (10 plane waves around the JONSWAP peak) shaded on the far sheet
src/render/ocean/foamMap.ts          GPU: whitecaps of the combined surface in 3 camera-centred levels, with history
src/render/ocean/foamLace.ts         the foam lace texture (uniform T, E[T], E[T^2] mips): density -> foam picture
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
tests/unit/ocean/                    swellPhases, spectrum, nearField, field (roughness field, far waves, foam lace) (vitest)
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
  setDebugView(view: 'none' | 'skyReflection' | 'body' | 'sunSpecular' | 'foam' | 'normal' | 'roughness' | 'foamMap' | 'refraction'): void;
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
oceanRoughnessField(t: OceanTunables): (dirFixed: Vec3, footprint: number) => number   // the field brdf_water uses (mean 1)
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
the deferred lighting terms exactly (sun x `sunVisibility` x `atmosphereSunTransmittance` x the clouds' beam
share (`cloudLight`) x `sampleSunShadow`, sky irradiance x mix(0.35, 1, beam share) + the cloud base, tilted by
`0.5 + 0.5 n.up`, planetshine of the same receiver, local lights, map fill light). Not replicated: screen-space AO and the contact-shadow term
(water ignores `s.ao`; the contact term is 1 on open water).

- **Unresolved slope variance**: sigma^2 = (0.003 + 0.00512 U10) x m(p) x (1 - s.roughness) (+ the light's own
  angular size); `waterAlpha` = KAPPA x sigma is the GGX alpha of the same half-maximum width.
- **Sun, Moon and lamps (direct specular)**: the Gaussian slope distribution of that variance (Beckmann D with
  m^2 = sigma^2, Smith shadowing of the same distribution), F0 0.02. Deviation from "GGX" (section 9): the GGX
  tail is energy no real sea has, and with the sun's radiance a tail of 1e-4 of the peak is visible (it gave a
  tan sheen of a sun 60 deg behind the camera on steep faces and a grey halo around the moon path).
- **Glitter** (the same lobe, drawn): the lobe is the EXPECTATION of the sun's image in the unresolved facets. A
  pixel whose footprint holds N facets (footprint area / `glintFacetSizeM`^2; at least one sea-anchored cell)
  has on average k = N x P(slope) x pi r_sun^2 / (4 l.h) of them mirroring the sun; the lobe is multiplied by a
  factor of expectation 1 drawn per cell, (1 + k)/k x u^(1/k): for k << 1 nearly every pixel is dark and a few
  carry the whole energy (sparkles of the sun's own radiance), for k >> 1 every pixel is near the mean (a sheen
  from 10 km and from orbit). Cells are squares of 2^n / 64 m no larger than the pixel's width, two levels
  blended, each re-drawn at its own instants about 14 times a second; inside the glitter path the TAA reactive
  value is `glintReactive`. Continuous in k: the forward and the deferred pass shade the same at the hand-over.
- **Roughness field m(p)** (`fieldModel.ts` = CPU reference, `WATER_FIELD_WGSL`; planet-fixed in a Mercator WIND
  CHART of the body, x along the wind; mean 1 over the planet): mesoscale wind (110 km, log amplitude
  `windVariability`) carried by a two-octave flow warp (45 km, 11 km) that everything else follows; where the wind
  is light, **slick filaments** (the zero set of a flow-warped noise stretched 5-6 : 1 along the wind: single
  meandering lines 50-300 m wide and kilometres long that end and rejoin, width and presence varying along them;
  depth `filamentStrength`) and **calm pools** (hard-edged tongues 140 x 7 km, depth `slickStrength`); **gusts
  and wind rows** (3.2 x 0.8 km, 2.6 x 0.23 km, 0.8 x 0.075 km along the wind, log amplitude `gustVariability`);
  **internal-wave packets** (narrow rough bands 1.3 km apart, bent by the flow, in a few places). Every term is
  filtered with the pixel's footprint (octaves fade out before they alias, lines contribute their covered
  fraction). The deferred path evaluates it per pixel; the forward pass reads it from a 2048^2 texture baked over
  the near field (as before) and evaluates it itself towards fadeStart.
- **Far-wave bank** (`farWaves.ts`): on the far sheet (and as the near field's own waves fade) the shading normal
  is tilted by 10 plane waves of 0.44-3.2 x the JONSWAP peak wavelength, directions within 38 deg of the wind,
  carrying the long-wave slope variance the near field resolves (swell + long-wave layer). Each is band-limited by
  the footprint along its own direction, has its own envelope (wave groups) and bent crests (both from two slow
  noises), and its variance leaves the lobe.
- **Surface fields for MATERIAL_WATER** (what the far sheet writes leaves the extras 0): `roughness` = the
  FRACTION of the Cox-Munk slope variance the shading normal already carries (0 for the flat sheet: full lobe),
  `albedo` = imagery colour, `param` = `encodeWaterDepth(depth)`, `metallic` = foam coverage and
  `clearcoatRoughness` its weight against the statistical whitecaps (0 far; the forward pass passes its complete
  coverage with weight 1). The terrain renderer needs no change: RT2.r = 0, metallic 0, RT4 neutral.
- **Sky reflection**: the mean Fresnel of the visible facets (Schlick at the incidence cosine the roughness
  leaves at grazing angles, at least about 1.1 sigma) x the sky along the mirror direction of the mean visible
  facet (lifted from the horizon by the roughness): the environment probe when one is published (`env.sh9` DC
  non-zero; mip = sqrt(alpha) x (levels - 1), the lookup kept above the horizon by the filter's reach), else the
  sky-view table (one tap for narrow lobes, a four-tap ring blended in up to 0.08 rad); within 50 km of the
  camera; the local sky irradiance / pi beyond (the core's rule). Directions reflected below the horizon are
  folded above it (x 0.85). Not dimmed under cloud in either pass (request ocean-cs-2, section 12).
- **Body colour**: Lee et al. (1998/1999) shallow-water remote-sensing reflectance with per-channel absorption
  and backscatter: rrs = rrs_deep (1 - e^-(1/muW + Du/muV) K H) + (rho_b/pi) e^-(1/muW + Db/muV) K H,
  Rrs = 0.5 rrs / (1 - 1.5 rrs), refracted sun and view cosines, Fresnel transmission. H = decoded depth; the
  bottom albedo rho_b is the imagery colour, whose chroma also tints the deep term (`imageryTint`).
- **Foam**: statistical whitecaps 3.84e-6 U^3.41 (Monahan & O'Muircheartaigh) x 0.4 (aged foam) = 0.117 % at
  7 m/s on the far water; the resolved foam of the near field is calibrated to the same mean (section 8). Foam
  is a diffuse layer lit on the slope of the wave it rides; it hides the specular and the body under it; the
  forward pass hands in its coverage (`metallic`) and its albedo relative to fresh foam (`clearcoat`: thin lace
  is greyer, bubbles vary it).

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
  carries (computed at start-up from the data; with the four-component swell of round 0 it was 0.00323 against the
  swell's 0.00124; the layer's height is NOT drawn). Drawn as SLOPES only, two copies rotated by -/+
  `longWaveSpreadDeg` (8 deg; 20 deg until round 1, which widened the layer's spread) at half variance each: the two lattices are
  incommensurate, so the sum does not repeat, and each copy's waves travel along their own rotated direction with
  the true dispersion. TMA-attenuated in shallow water, faded with the wave detail, in the variance bookkeeping
  (the capillary layers carry correspondingly less: 0.0152). The drawn heights stay exactly the physics swell.
  It turns the regular crossing pattern of the swell components into an irregular short-crested sea in the glint
  from 1-15 km (screenshots `alt3k`, `alt10k`).
- **Capillary layers**: two compressed, rotated copies of the finest cascade (x 4.2 and x 17.6) carry what
  Cox-Munk has beyond swell + cascades + long waves (less `unresolvedSlopeVariance` 0.0008 left to the lobe), normals only.
- **Shading slope**: the cascades' own slopes are divided by their own Jacobian (they pinch at their crests); the
  capillary, long-wave and ripple slopes are added unpinched, and the sum is limited softly from a slope of 0.4
  (a steeper wave breaks): no facet spikes out of the lobe along a crest (the dark hairlines of the critique).
- **Band limits**: a layer's mip follows the pixel footprint, the long axis filtered twice as wide once the
  footprint is elongated (no row-locked stripes at grazing angles); swell components exp(-(k w)^2 / 2) along their
  own direction (under 1 % at the Nyquist limit).
- **Layer skipping**: no pixel sees the sea sharper than the nadir does (footprint = (height - wave bound) x
  pixel angle). A layer filtered there beyond `OCEAN_LOD_CUT` + 0.75 mip is not updated that frame (FFT passes
  return at once for it) and has amplitude 0 in every shader; one that comes back starts a new history. At 1440p
  the finest cascade drops out above about 3 km, the third above about 12 km.
- **Per-pixel cut-off**: a layer filtered beyond 4.5 mips at the pixel (`OCEAN_LOD_CUT`: under 0.1 % of its
  slope variance survives, from `filteredSlopeFraction`) is not sampled; it fades out over the mip before, its
  variance returns to the lobe through the same bookkeeping.
- **Chart**: gnomonic chart of the sea-level sphere anchored at the centre of the level-5 cube tile under the
  camera when the near field switches on; kept while active unless the nadir drifts beyond 400 km.
- **Whitecaps: the foam map** (`foamMap.ts`): three levels of 512^2 texels (0.25 m, 1 m, 4 m: windows of 128 m,
  512 m, 2 km around the camera's nadir, snapped to their texel grids in chart coordinates, so the content is fixed
  to the sea and a moving camera only scrolls it). Per texel, a breaking criterion of the COMBINED surface: the
  convergence of the long-wave layer, cascade 0 and cascade 1 low-passed to about 2 m (long-crested, so its rare
  excursions are bars along the dominant crests, not round specks), plus a fine part that only frays the edges,
  normalised to unit variance; fresh foam above `foamSigma` (ramp `foamRampSigma`). Two states: the breaker
  (decay `foamDecayPerS`) and what it leaves (decay `foamResidualDecayPerS`, shown at `foamResidualDensity` and
  thinning into lace). Lagrangian texels: the crest moves through them at its phase speed and the foam stays on
  the water, so it trails behind the breaker. A texel without history (a level starting as the camera descends,
  a texel scrolling in) takes what the breakers of the last 2.4 s would have left there (the crests that are now
  downwind of it at 4.5 m/s, `FOAM_CREST_SPEED`, sampled every 0.2 s), plus old foam of density `foamOldDensity`
  where the criterion is within `foamOldDropSigma` of breaking. A level no pixel resolves is not updated; beyond the levels the
  statistical coverage. The surface pass reads the map with a cubic B-spline (four bilinear taps), so a level
  magnified beyond its texels gives rounded patches, not texel squares.
- **Foam picture: the lace** (`foamLace.ts`): a tileable field T with a uniform distribution, built from holes at
  three scales (2.1, 0.70, 0.28 m) torn by a displacement, tiled every 16.9 m (1/97 of the long-wave patch, in its
  first copy's rotated axes: planet-fixed and incommensurate with every cascade); foam of density rho is where T > 1 - rho, so thin foam
  is curved strands with water showing through, dense foam closes from the rims, and the covered area equals rho
  exactly. The texture holds E[T] and E[T^2] per texel with box mips: a pixel gets the covered FRACTION of its
  footprint (sharp at 3 m, the right mean from 3 km). A second, nine times finer lookup adds bubbles near the
  camera. Every foam source (whitecaps, surf, wake) is one density drawn through it; fresh foam is thick and
  white, residual foam thin and greyer (`foamLaceAlbedo`) except well inside the lace.
- **Surf**: where the seabed is shallower than `surfBreakDepthM` the swell breaks: bores run shoreward at
  sqrt(g h) (lines of equal travel time to the shore, one every `surfPeriodS`, made irregular along the shore by
  the swell's height), a sharp front with the foam it leaves behind, and the swash over the last `shoreFoamDepthM`.
- **Wake**: the wake texture (vessels.ts) as foam density: fresh only where the hull keeps churning it, lace
  further out.

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
  (`oceanDepthBelow`: the vertical is marched down through the depth copy, samples that show anything but the
  seabed (an object in the water, a stray fragment) are skipped, the crossing is bisected), so shore foam, TMA,
  surf and body colour depend neither on where the camera stands nor on what floats or lies in the water (an
  object in the water no longer changes the water's own look: the "stencil" of the critique). Where the object
  hides the whole vertical, the depth is that of the seabed seen beside it on screen (`oceanBedBeside`: 12-96 px to
  the left and right), else a few metres below the object. The vertex stage does the same. The imagery colour
  from the seabed's `gbuffer.albedo`.
- **The bed through the water from the scene itself**: where the pixel shows the seabed, the bed as the deferred
  pass lit it, attenuated along the column; the refracted image (a 6-step march of the refracted ray through the
  depth copy, bisected at the crossing, chromatic offset in the shallows) replaces it with a confidence that fades
  as the hit nears the end of the march or the frame border; one depth for the body colour and the bed. The
  modelled bottom of brdf_water takes over only as the detail fades. A ray that passes behind an object takes the
  bed it passed. **Caustics**: the bed is multiplied by 1 / |1 + a H| (a = (1 - 1/n) x path along the refracted
  sun, H from the convergence of cascades 2-3 at the point where the sunlight entered), softened at focus, fading
  out by about 8 m and with the sun's share of the light.
- **Vessels in the water**: within 4-9 hull radii of a vessel slot, a 12-step march of the mirrored ray through
  the scene copies (jittered by the unresolved slopes) puts the hull's image in the water; where the march finds
  nothing but the ray passes through the hull's bulk, the hull's shaded side replaces the sky (the water beside
  the hull darkens). Only what stands in the air is mirrored.
- **Clouds** (request ocean-cs-2): the forward pass lights with the core's `cloudLight` exactly as the deferred
  pass lights the far sheet: the sun term x the beam share, sky irradiance x mix(0.35, 1, beam) + the cloud base.
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
divisors, fetch, JONSWAP gamma, high-pass wavelength, longWaveDivisor 5, **longWaveSpreadDeg 8**, choppiness
0.85, repeat period 3600 s, seed, nearFieldFadeStartM 15000 / nearFieldFadeEndM 30000, detailFadeFraction 0.7,
backscatter, imageryTint 0.5, **foam map** (foamDecayPerS 1.4, foamResidualDecayPerS 0.4, foamSigma 2.82,
foamRampSigma 0.6, foamOldDropSigma 0.6, foamOldDensity 0.45, foamAlbedo 0.85, foamLaceAlbedo 0.5,
foamResidualDensity 0.9), **surf** (shoreFoamDepthM 0.35, surfBreakDepthM 2.2, surfPeriodS 9, surfBedSlope
0.04), refractionDistortion 1, chromaticOffset 0.012, vesselDampingHullRadii 3, wake / splash / ripple / wet-line
values, capillaryScale 4.2, **unresolvedSlopeVariance 0.0008**, roughness field (**windVariability 0.18,
slickStrength 0.45, gustVariability 0.3, filamentStrength 0.8**), **glintFacetSizeM 0.015, glintReactive 0.8**,
taaReactive 0.45. Every value is validated at load. The field's scales (FIELD in `fieldModel.ts`) and the far
bank's shape (`farWaves.ts`) are code constants: they are the recipe, the data sets its strengths.
Swell (physics) stays in `data/defs/bodies/earth.json` (lead-owned; eight components since 9d48042, request ocean-5).

## 8. How to run and verify, and what was measured

```
npm run typecheck:paths -- src/render/ocean labs/ocean tests/browser/ocean tests/unit/ocean
node tools/dev/heavy.mjs --class=cpu -- npx vitest run src/render/ocean tests/unit/ocean tools/dev/boundaries.test.ts
node tools/dev/heavy.mjs --class=gpu -- npx playwright test tests/browser/ocean --project=functional    # 27 tests
node tools/dev/heavy.mjs --class=gpu -- npx playwright test tests/browser/ocean --project=perf          # GPU lock
```

Lab: `/labs/ocean/?preset=midday|sunset|overcast|down150|alt500|alt3k|alt10k|alt30k|alt100k|leo|shore|shoreAlong|coast60|refraction|splash|night`
(daylight presets exposed by the renderer's meter, `night` at a fixed EV -1.5; `&ev=<EV>` overrides),
plus `&ocean=0` (feature removed), `&near=0` (near field off), `&stray=1` (stray water fragments inside fadeStart),
`&chop=<s>`, `&ballast=<iterations>`, and every createLabApp parameter. `window.__ocean` (lab handle):
`applyPreset`, `setCamera({east, north, alt, heading, pitch, fov})`, `setSun([az, el])`, `dirAt`, `waterAt`,
`seaHit(x, y)`, `altitudeAlong`, `dirAlong`, `project`, `world`, `props` (incl. `strayWater`), `sky`, `ballast`,
`ocean` (the feature).

Machine: RTX 5090, Chrome headless, 1280 x 720 unless noted, 2026-11-11 (re-measured at the end of visual round
1), other agents' GPU jobs running in the other GPU slots throughout (vfx, terrain, atmosphere, sky, core-support).
Other packages editing shared core files during the runs twice broke page start-up for a few seconds (a parse
error in `chunksLighting.ts`, a material uniform of the wrong size); the specs hit by that were re-run.

| Criterion | Result | Spec |
|---|---|---|
| GPU readback of the displaced surface = `oceanSwellHeight` within 2 cm at 200 points and 3 times; FFT separately | worst 0.022 mm; FFT term rms 0.11-0.12 m, max 0.32 m; total = swell + fft + ripple to 6e-8 m | swell.spec |
| Inside the vessel damping zone the total within 5 cm of the swell | worst 3.2 / 4.0 / 3.6 cm at 3 times; outside rms 0.11-0.13 m | swell.spec |
| Markers at the physics height sit on the rendered surface | rasterised surface (depth buffer, 120 px): chop off worst 0.011 mm from `oceanSwellHeight`; chop on worst 6.4 mm from the readback | swell.spec |
| Inside fadeStart the depth copy holds the seabed; a submerged object is refracted | depth copy altitude -200.00 m at 24 px (0.000 with the near field off); the submerged ball's image moves 22.8 px against the unrefracted lookup, overlap 0.41 | handover.spec |
| **Stray water fragments inside fadeStart leave the waves intact** (new) | annulus of water material 150 m deep, 0.2-4 km out (`props.strayWater`), confirmed in the depth copy at 15 of 24 sampled px: relative detail 6.372e-2 vs 6.371e-2 (ratio 1.000), mean luminance equal, 88,437 px. With the old per-pixel material test the same check gives ratio 0.563 and +21 % brightness (the flat band) | handover.spec |
| At fadeStart the forward pixel equals the deferred pixel within 2 % | worst 0.31 %, mean 0.05 % over 519 px (from 500 m: worst 0.20 %) | handover.spec |
| Across the band two equal images; slow dolly shows no line | band worst 0.12 % (12,345 px); dolly: no line at fadeStart | handover.spec |
| Beyond fadeEnd nothing is drawn | 9,857 / 9,857 px bit-identical to the deferred-only frame | handover.spec |
| Climb 2 m -> 400 km, no ring or pop | 150 log-spaced steps: largest step / local median 1.47 (99 km, deferred only); ring = change on the radius (+-4 %) against the bands on both sides (4-15 %): worst 1.21 over 47 steps (bound 1.6) | handover.spec |
| Feature removed: far water alone complete | 16,188 sea px, 0 holes | handover.spec |
| LEO: broad glint at the mirror point, Cox-Munk width within 20 % | half maximum at tan(beta) 0.1582 vs Cox-Munk 0.1588 (ratio 0.996, the Gaussian lobe; GGX gave 1.14); in facet-slope space over fully covered discs (64/64 cells) of radius 0.08 / 0.12 / 0.16: centroid 0.0014 / 0.0032 / 0.0038 (bound 0.02), paraboloid peak 0.0043 / 0.011 / 0.018 (bound 0.03) | glint.spec |
| 2 m: glitter path toward the sun, same function | centroid 644.1 px vs the sun's 640.0; coefficient of variation in the path 13.2 (discrete sparkles; 2.2 with the smooth lobe); 0.00 % of the energy off the path | glint.spec |
| Sun on the horizon: no pixel above HDR_MAX, nanPixels 0 | elevations +0.4, 0, -0.3 deg at EV 13 and 4: max 56,220 (saturating glint at EV 4), NaN 0 | glint.spec |
| Whitecaps calibrated, in patches, not repeating | from 150 m at 9 places with frozen time (texels without history: breaker, trail, old-foam proxy) mean 0.152 % (ratio 1.30 to the far water's statistical 0.117 %), after 12 s of running sea 0.136 % (ratio 1.16); area-weighted median patch 3.9 m2 or more in most frames, 3.3 patches of 1 m2 or more per frame; correlation at the 72.5 m cascade period at most 0.048 (bound 0.05: the thinnest-foam frame is close to it) | foam.spec |
| No swimming when the camera translates | 64 planet-fixed points from two camera positions 3 km apart: worst 0.53 mm; 250 m away and back: bit-identical | stability.spec |
| Triplanar blend zones not visible | not applicable: one planet-fixed chart (section 9.1) | - |
| Correct motion vectors | TAA / single-frame gradient energy, camera flying 5 m/s over a frozen sea 0.64 of still; animated sea 0.88 with the reactive mask, 0.41 without | stability.spec |
| Reviewed screenshots | `out/screens/ocean/` (section 10) | screens.spec |
| Unit tests | 36 tests in 5 files: swell phases, spectrum, near field, field (roughness field mean 1 and a decade of range, footprint filtering; far-wave bank around the peak; foam lace uniform, coverage = density at every mip) + boundaries | tests/unit/ocean |
| `expectNoErrors` | in every spec | all |

### 8.1 Performance (ARCHITECTURE 17.1: 0.9 splashdown, 0.8 pad, 0.3 ascent 10-40 km, 0.1 LEO; brief: FFT < 0.3, near pass < 0.6)

2560 x 1440, `perf=features`, governor off, ~7 ms ballast. Six 240-frame windows per scene, the MEDIAN of the
windows' p99 (and p50) is reported; each scene is asserted against its own line.

**After visual round 1 (2026-11-11 14:45, three other agents' GPU suites in the other slots): the budget is
FAILED, at p50 as well as p99.** ms:

| Scene | ocean p99 / p50 | water pass p99 / p50 | FFT p99 | line | result |
|---|---|---|---|---|---|
| splashdown (3 m, capsule, wake) | 1.66 / 0.96 | 1.55 / 0.87 | 0.07 | 0.9 (near pass 0.6) | FAILS (p50 too) |
| coast, 60 m above the shelf | 1.56 / 1.14 | 1.46 / 1.05 | 0.06 | 0.8 (near pass 0.6) | FAILS (p50 too) |
| 10 km above the sea | 1.17 / 0.71 | 1.00 / 0.63 | 0.15 | 0.3 | FAILS (p50 too) |
| LEO | 0 / 0 | 0 | 0 | 0.1 | holds |

`brdf_water` share of the core's lighting (with minus without the ocean feature): LEO +0.20 p50, 10 km +0.24 p50
(round 0: +0.13 / +0.13); the deferred far sheet now pays for the glitter cells, the Gaussian lobe, the far-wave
bank (two noises + ten components) and a third slick family.

Round 0 for comparison (06:15): splashdown water pass p50 0.41, coast 0.51, 10 km ocean p50 0.30. The forward
fragment shader roughly doubled in cost with round 1 (glitter, foam map read and lace, the bed from the scene and
caustics, vessel reflections, cloud lighting, the seabed beside objects); one probe-free cut was made (the vessel
reflection march only for rays that pass near the hull: splashdown water pass p50 1.04 -> 0.87). The cost has
not been profiled term by term in round 1; that is the first task of the next round (probe runs with terms
switched off, as in section 8.1 of round 0: likely candidates are the 4x-anisotropic cascade/capillary/long-wave
taps, the foam map's B-spline taps, the refraction and vertical seabed marches over the shelf, and register
pressure of one very large fragment shader). Nothing was loosened: the perf spec fails as it stands.

Round 0 table (06:15, vfx and terrain suites in the other two slots):

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
2. **GGX alpha = 1.2936 sigma** (half-maximum width of the Gaussian Cox-Munk distribution) for the sky
   reflection's lobe; **the direct lights (sun, Moon, lamps) are mirrored with the Gaussian slope distribution
   itself** (Beckmann with m^2 = sigma^2), not GGX: the slopes of a real sea are Gaussian (Cox and Munk), and the
   GGX tail, multiplied by the sun's radiance, painted a sheen of a sun 60 deg behind the camera onto steep faces
   and a grey halo around the moon path (round-1 critique items 2 and 9). Same half-maximum width, so the LEO
   width check is unaffected; the peak is 1.67 times the GGX peak.
2a. **Glitter** (section 3): the lobe is drawn per sea-anchored cell as a Poisson-like factor of expectation 1;
   energy is kept on average, not per pixel.
3. **Capillary detail layers** (without them half the Cox-Munk variance is GGX roughness at 2 m: milky sea).
4. **Roughness field** in `brdf_water` (mesoscale wind, slick filaments, pools, gusts, wind rows, internal
   waves) and the **far-wave bank** on the far sheet: the glint from altitude would be a featureless blob
   otherwise, and the sea beyond the near field a gradient.
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

`out/screens/ocean/` (all re-shot after the last shader change of round 1; section 14 says what each shows):
`midday`, `sunset`, `overcast`, `down150`, `alt500`, `alt3k`, `alt10k`, `alt30k`, `alt100k`, `leo`, `shore`,
`shoreAlong`, `coast60`, `refraction`, `splash`, `night` (screens.spec, exposed by the renderer's meter except
`night`); `splash-1440p`, `shore-1440p`, `alt10k-1440p` (the same at 2560 x 1440); `foam-coverage-*`,
`foam-running-debug`, `handover-*`, `glint-*`, `climb-*`, `markers-*`, `stability-animated`, `far-water-alone`
(the functional specs); `perf-*-1440p` (perf spec).

## 11. Known weaknesses (plainly)

- **Perf FAILS after visual round 1** (section 8.1): the forward water pass costs p50 0.87 ms at splashdown and
  1.05 ms at the coast against the 0.6 ms near-pass line, the 10 km scene 0.71 ms against 0.3. The round-1
  features roughly doubled the fragment cost; profiling and cutting it is the first job of the next round.
- **Haze from 10 km to orbit**: the lab's single-scattering sky (Rayleigh + Mie of `bodies/earth.json` plus an
  isotropic multiple-scattering estimate) and the real atmosphere of the integration lab
  (`out/screens/integration/water-climb-all-14km.png`, `-400km.png`) both lay a bright blue-grey veil over the
  open sea from 10 km up, so the off-glint sea is mid-blue, not the dark navy of ISS photographs (which are
  exposed for clouds). The water under the veil is not the cause; the veil and the exposure of cloudless frames
  are the atmosphere's and the camera's.
- **Swell data**: since commit 9d48042 (lead, ocean-5 / ocean-6) the heights the capsule floats on are eight
  components (a NW swell and a wind sea, steepness at most 0.0175). Still a sum of eight plane waves: their crests
  are long and regular compared with a real short-crested sea; the long-wave layer and the far-wave bank add the
  irregular short-crested part in the SHADING only (render-only heights were declined by the lead).
- **Detail fade**: as the contract requires, the resolved wave detail is gone at fadeStart; the far-wave bank
  takes over as it fades (same function on both sides), so the texture no longer stops at an arc, but from 5-15 km
  the near part is still finer than the far sheet.
- **Seabed depth** is marched down the vertical through the depth copy: where the bed directly below a water
  point is hidden behind a nearer bump of the bed (an irregular, non-monotonic shelf) the march stops early and
  the depth reads too shallow there.
- **Whitecaps**: calibrated in mean coverage (Monahan) and checked for patch size and repetition; their
  persistence, trail and lace are tuned by eye. At 7 m/s they are rare (0.12 % of the sea), so most close-up
  frames hold none or one; seen from 150 m they are compact patches a few metres across rather than long
  crescents with streaks.
- **Wet sand** behind the surf is not drawn: it needs a shore wetness band in a contract and the terrain's
  cooperation (not requested in round 1).
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
| `ocean-5` eight swell components with directional spread | `data/defs/bodies/earth.json` (lead) | done by the lead (commits 1ccd5e0 decision, 9d48042 data, 2026-11-11 14:11): a NW swell of three components and a wind sea of five, 200-32 m, variance 0.18 m^2, steepness at most 0.0175; mission re-flown |
| `ocean-6` the same, or permission to draw the long-wave layer's height away from vessels | lead | option 1 (the data) done (9d48042), option 2 (render-only heights) declined. The ocean needed no code change (MAX_SWELL is 8; the long-wave layer and the far-wave bank take the swell's share of the long-wave slopes at start-up; the swell spec compares against whatever the data holds) |

Requests against the ocean's paths, answered in round 1:

| Request | From | Resolution |
|---|---|---|
| `ocean-cs-2` forward pass lit under cloud like the deferred pass | core-support | done: `cloudLight` beam share for the sun, sky irradiance x mix(0.35, 1, beam) + cloud base; the sky REFLECTION stays undimmed in both passes (needs a decision on the sky-view table's cloud content) |
| `atmosphere-clouds-5` `tests/browser/ocean/diag.spec.ts` deleted by another package's commit | atmosphere-clouds | the spec was a temporary diagnosis: deletion stands, nothing restored |

Interaction with **terrain-render-cs-1** (open, core-support against the terrain): the terrain leaves water
fragments at the seabed's altitude inside fadeStart (29.8 % of the near field at 200 m). The ocean no longer
depends on that being fixed: such fragments are now shaded as open deep water with their waves (section 5,
`handover.spec` "stray water"). They still make the refraction and seabed depth of those pixels unknown (deep),
so the request stays needed for shallow water. The request file is core-support's; this note is here instead.
No request against the ocean's paths is open after round 1.

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

## 14. Visual close-out, round 1

The first visual critique (`out/qa/wave2/ocean.md`, photo 4/10, artifact 4/10, 17 items) was worked in parts:
part 1 (commit 707a928, the previous owner of the package, cut short by a spend limit before its hand-off), then
parts 2 and 3 by the next owner (a1f4f18 and the commits after it). Every screenshot in `out/screens/ocean/` was
re-shot after the last shader change and with the lead's eight-component swell, and looked at against the
reference photographs in `out/qa/ref/` (sea-surface-close, earth-orbit-ocean).

| # | Item (critique severity) | What was done | Where to look | State |
|---|---|---|---|---|
| 1 | Near whitecaps are soft white smudges (blocker) | Foam is a density drawn through the foam lace (sharp, binary at pixel scale, holes and strands, bubbles near the camera); fresh foam thick and white, residual foam thin, greyer lace; foam hides the specular; the capsule's wake is lace except right at the hull | `splash-1440p`, `shoreAlong`, `overcast` | Fixed as a picture; at 7 m/s whitecaps are rare (0.12 %), so the close-up views hold few. Foam has no normal of its own (lit on the wave's slope) |
| 2 | 100 m - 3 km sun path is a matt grey plate with dark worms (blocker) | Glitter: the lobe drawn per sea-anchored cell with the facet count of the pixel's footprint (sparkles of the sun's radiance on dark water, densest at the mirror point, a sheen from 10 km up); the sun mirrored with the Gaussian slope distribution (no GGX tail: no stray stars, no sheen far off the path); slopes limited softly, cascades pinched by their own Jacobian only (no worm lines) | `alt500`, `climb-273m`, `handover-stray-water`, `down150`, `night` | Fixed |
| 3 | 5-30 km: gradient + smudge, texture stops at an arc (blocker) | Far-wave bank on the far sheet (same function on both sides of fadeStart: no arc), its spread narrow at the long components (no plaid of two trains crossing at 60 deg on the glint's flank), each component with its own envelope and bent crests; roughness field with slick filaments in three families (zero sets of flow-warped noise along the wind, not the nested contour rings part 1 had), calm pools, gusts, wind rows, internal-wave trains; glint peak 1.67 x higher (Gaussian lobe) | `alt3k`, `climb-4796m`, `alt10k`, `alt10k-1440p`, `alt30k`, `climb-16389m` | Mostly fixed: structure everywhere, contrast flips in the glint (slicks bright in the core, dark outside). The frames are veiled by the atmosphere's haze (section 11); the gust streaks read as brush strokes on the glint's flank |
| 4 | Capsule pasted onto the sea (major) | Vessel reflections (12-step march of the mirrored ray, jittered by the unresolved slopes) and the hull's bulk darkening the sky reflection beside it; wake as lace | `splash`, `splash-1440p` | Partly: the hull's reflection breaks into a shimmering streak; no aqua glow of the submerged hull, the wet band is the vehicle's material (the lab hull is an untextured prop) |
| 5 | No wind-sea heights (major) | Long-wave layer copies 8 deg apart (its own spread), whitecaps break on its crests, far bank in the far shading | `midday`, `splash`, `stability-animated` | Fixed by data: the lead replaced the four-sinusoid swell with eight components (a NW swell of three and a wind sea of five, Hs about 1.7 m; ocean-5 / ocean-6, commit 9d48042) during this round; no ocean code change was needed, and the final screenshots and the swell spec use it. The heights stay a sum of eight plane waves (render-only heights declined by the lead) |
| 6 | Orbital glint a dim disc with soft blobs (major) | Gaussian lobe (brighter core), slick filaments and calm tongues that flip contrast across the glint, gusts, internal-wave packets | `alt100k`, `leo`, `glint-leo` | Fixed in the water; the LEO frame is dominated by the lab sky's haze at the meter's exposure |
| 7 | Whitecaps from above are a star field of specks (major) | Foam map of the combined surface (breaking on long-crested crests, statistical specks gone), foam left behind breakers, residual lace; texels without history get the trail of the last 3 s; the map is reconstructed with a cubic B-spline (no texel squares where a coarse level is magnified) | `down150`, `handover-stray-water`, `foam-*` | Partly: patches of 2-4 m, calibrated, no specks; they are compact rounded patches, not long crescents with streaks |
| 8 | Row-locked stripes in the middle distance (major) | Long axis of elongated footprints filtered twice as wide; swell band limit exp(-(kw)^2/2) | `splash-1440p` (rows 560-840) | Fixed: soft irregular bands; row-to-row luma change 7.8 against 1.7 across (natural foreshortening, no alternating rows) |
| 9 | Dark hairlines along crests; dull far band (major) | Slope limit and Jacobian on the cascades only; normals bent into the visible hemisphere; mean Fresnel of the visible facets and a lifted mirror direction for the sky reflection | `shore`, `refraction`, `overcast`, `midday` | Fixed (no hairlines in the re-shot views) |
| 10 | Shallow water in contour bands (major) | Exact (not 8-bit) depth inside fadeStart; the bed taken from the scene itself through one column, one depth for body colour and bed; seabed depth straight below the point, ignoring objects | `shoreAlong`, `coast60`, `shore-1440p` | Fixed: a continuous turquoise shelf, no terraces |
| 11 | No surf (major) | Bores from the swell phase where the bed is shallower than 2.2 m, travelling at sqrt(g h), fronts and their foam, swash | `shoreAlong`, `coast60`, `shore` | Partly: breaking lines and run-up foam; no wet sand (needs a contract entry and the terrain) |
| 12 | Hard stencil of a submerged object (major) | The object no longer changes the water's depth, waves, foam or colour: the seabed is found straight below, skipping the object, and where the object hides the whole vertical the depth is the bed's beside it on screen (part 1 fell back to "a few metres below the object", which painted a navy deep-water patch at the object's straight-line position); the object shows through the refraction path only | `refraction`, `handover-refraction` | Mostly fixed: no deep-water oval at the straight-line silhouette; a smaller darker patch remains just below the refracted image (the bed in the ball's shadow, seen unrefracted where the refraction march is not trusted) |
| 13 | Flat teal shallows, no caustics (major) | Caustics 1 / abs(det(1 + a H)) from the short waves' curvature, the bed through the column | `refraction`, `handover-refraction`, `shoreAlong` | Partly: soft moving caustic patterns; not the sharp bright net of strong sun over sand |
| 14 | Sunset foreground crushed to black (minor) | Sky reflection of the mean visible facet, Gaussian lobe | `sunset`, `glint-surface` | Fixed: slate-blue and orange facets, readable |
| 15 | Corduroy stripes 300 m - 10 km (minor) | Steeper swell band limit; far bank with bent crests | `alt10k`, `climb-4796m` | Fixed |
| 16 | 72.5 m repetition of whitecaps (minor) | Whitecaps from the camera-centred foam map (no tile); the foam lace re-tiled at 16.9 m in rotated axes, incommensurate with every cascade (at 18.2 m, 4 tiles fell within 0.5 m of cascade 2's 72.5 m and thin foam repeated there) | `foam-coverage-150m` | Fixed (foam.spec: correlation at the cascade period under 0.05) |
| 17 | Screenshot hygiene (minor) | Meter exposure (fixed only at night), "not above a sea" instead of NaN, converged `handover-refraction`, stale `refr-diag`/probe images removed, 1440p shots of splash, shore and alt10k | all | Fixed |

### 14.1 Not fixed, and why

- **Heights of a short-crested wind sea** (item 5): the drawn heights are the physics swell, now eight plane
  waves (lead data, 9d48042). The short-crested irregularity of a real 7 m/s sea is in the shading only; drawing the
  long-wave layer's height was declined by the lead (the picture must be the surface the capsule rides).
- **Whitecap shape from above** (item 7): breakers are compact rounded patches of 2-4 m with a short trail; real
  ones at Beaufort 4 are elongated crescents across the wind with streaks. The breaking criterion's excursions are
  compact; shaping them needs a crest-aligned criterion (convergence low-passed ALONG the crest only), not done.
- **Glint contrast from 10 km to orbit** (items 3 and 6): measured in the frames, glint core / off-glint sea is
  about 2.6 : 1 in linear terms at 30 km and from LEO, against 7.5-9 : 1 in ISS photographs. The sea itself is
  dark; the lab sky's aerial perspective adds a bright blue veil over it from 10 km up, and the renderer's meter
  exposes for that veil. This is the atmosphere's (lab sky / atmosphere-clouds) and the camera's, not the
  water's; it has to be judged in the integrated app.
- **Caustics** (item 13): soft moving patterns, not the sharp bright net of a sunny sandy shallow (the curvature
  comes from cascades 2-3 at their texel size; a dedicated caustics texture would be needed).
- **Wet sand behind the surf** (item 11): needs a shore-wetness band in a contract and the terrain's shading.
- **Capsule** (item 4): no aqua glow of the submerged part of the hull from above (the refraction of the hull is
  there but the lab hull is untextured white), the wet band is the vehicle package's material.

### 14.2 Requests in round 1

- Answered against the ocean's paths: `ocean-cs-2` (cloud lighting of the forward pass: done) and
  `atmosphere-clouds-5` (a deleted diagnostic spec: deletion stands).
- `ocean-5` / `ocean-6` (swell data): done by the lead during the round (1ccd5e0, 9d48042).
- No new request filed: everything else was inside the ocean's paths.

### 14.3 Measured at the end of round 1

- Functional suite (`tests/browser/ocean`, 32 specs): 31 passed in the full run at 14:16-14:27 with the lead's new
  swell; the foam spec, which failed there on a 72.5 m correlation of 0.077 in its thinnest frame, passes after the
  lace re-tiling and the criterion change (correlation at most 0.048). Glint: LEO half-width ratio 0.996, glitter
  path coefficient of variation 13.2, no NaN, max 56,219 below HDR_MAX with the sun on the horizon. Hand-over:
  fadeStart worst 0.33 %, band worst 0.12 %, beyond fadeEnd bit-identical, climb ring worst 1.21. Swell agreement
  with the eight-component data: worst 0.02 mm, damping zone worst 4.0 cm. TAA: animated sea 0.85 of still.
- Perf: FAILS (section 8.1).
- Honest score of the round-1 picture against the reference photographs (the critics' lenses, 10 = photograph):
  photo about 6, artifact about 6. Better than round 0 everywhere a critic looked (glitter instead of a grey plate,
  no worm lines, structure from 3 km to orbit, a continuous shelf, surf, foam with holes and edges), but not yet 8:
  the haze-veiled glint from 10 km up, compact whitecaps, soft caustics, and a perf budget that is broken.
