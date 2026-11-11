# Hand-off: sky-lighting

The sky as seen from anywhere in the system, photometrically: catalogue stars as images of one point-spread
function (Gaussian core + r^-3 wings), the Milky Way cube with a luminance detail layer at the baked
resolution, the solar disc with per-channel limb darkening, distant bodies as analytic far images (their sunlit
sphere through the point-spread function, with the body's own photometric function) handed over to their
geometry by the width of the sunlit part, the live environment probe at the active vessel ('env.probeCube',
'env.sh9'), and the lens flare of one lens design (7-blade iris). One `RenderFeature`; no brightness knobs
anywhere: every luminance follows from the data (`data/sky`, `BodyDef`, the tile sets' albedo maps) and the
frame's exposure.

State: built and reviewed (section 11), then reworked after a visual critique (section 12, "Visual close-out,
round 1"). Read section 12 first if you continue the visual work.

## 1. Where things are

```
src/render/sky/index.ts        public API (import from '@/render/sky')
src/render/sky/feature.ts      createSkyFeature: data loading, background, far images, flare, hooks
src/render/sky/probe.ts        EnvironmentProbe: face evaluation, mip chain + SH9, GGX prefilter, blend, publication; albedo maps (GPU + a coarse CPU grid)
src/render/sky/probeScene.ts   probe scene in float64 (bodies, ground sphere, planetshine weights) + CPU reference (brute force, SH, Hapke)
src/render/sky/photometry.ts   point-spread function, disc, Lambert sphere, Hapke function, far-image grid and hand-over, visible-face albedo, air mass, scintillation, cloud two-stream, SH, cube maths
src/render/sky/flare.ts        the lens: glare, rays of the iris, ghosts; their normalisation; cone bounds, lens hood; CPU model of the flare image
src/render/sky/skyData.ts      SkyManifest validation, star catalogue parsing, rgb9e5 layout / decoding, luminance detail layer (half floats)
src/render/sky/shaders.ts      all WGSL
labs/sky/                      lab page (main.ts, world.ts: sun / vessel-altitude / ground-elevation overrides)
tests/unit/sky/                vitest (photometry, sky data against data/sky, probe weights + ground sphere + CPU reference, flare)
tests/browser/sky/             Playwright: stars, sun, impostor, probe, flare, scintillation, views, sky.perf
docs/requests/sky-lighting-*.md   1 declined (TAA), 2 escalated to the lead (VRAM; now moot, see 6.12), 3 resolved (dark floor + toe), 4-6 open (section 9)
```

## 2. Public API (exact signatures)

```ts
// '@/render/sky'
createSkyFeature(options?: SkyFeatureOptions): SkyFeature
interface SkyFeatureOptions extends Partial<SkyParts> {
  id?: string;                              // default 'sky' (prefix of passes and perf rows)
  order?: number;                           // default 0
  probeAlbedo?: 'tileset' | 'meanColor';    // probe body colour: albedoLowRes where baked (default), or BodyDef meanColor
  milkyWayFaceSize?: number;                // largest Milky Way COLOUR face size kept in VRAM (default MILKY_WAY_FACE_SIZE = 1024)
  milkyWayDetail?: boolean;                 // keep the next finer baked level as r16float luminance (default true)
}
interface SkyParts { stars: boolean; milkyWay: boolean; sun: boolean; impostors: boolean; probe: boolean; flare: boolean }
interface SkyFeature extends RenderFeature {
  readonly parts: SkyParts;                  // mutable switches (all true by default; labs use them for A/B readbacks)
  status(): SkyStatus;                       // { manifest, starsLoaded, milkyWayLoaded, milkyWayFaceSize, milkyWayDetailSize, error, flareDrawn }
  stars(): StarCatalogue | null;             // parsed stars.f32 (records: STAR_RECORD_FLOATS per star)
  impostors(): ImpostorInfo[];               // last frame: { bodyId, diameterPx, weight, illuminance (lux), litWidthPx, kernelPx }
  probe(): ProbeState;                       // { completed, step, holding, scene, albedoMaps }
  readProbeSh(): Promise<number[][]>;        // published SH9 irradiance coefficients, 9 x rgb, lux
  readProbeFace(face: number, mip?: number): Promise<{ size: number; data: Float32Array }>;
  readFlareState(): Promise<FlareStateInfo>; // { visible, cloud, inView, hood, transmittance }
}
```

Also exported: everything in `photometry.ts` (e.g. `starPsf(r, radius, share?)`, `starImageRadius(p, share?)`,
`starWing(radius, share?)`, `starPeakLuminance(e, omegaPx, exposure?)`, `discMeanLuminance`,
`lambertSphereIlluminance`, `impostorWeight(diameterPx, phase)`, `litWidthPx`, `impostorLune`, `farBodyRadiance`,
`farBodyDiscIntegral`, `farBodyLuneSum`, `hapkeBrdfMu0`, `hapkeSingleScattering`, `albedoGridFromSrgb`,
`visibleFaceAlbedo`, `chapman`, `scintillationVariance`, `shBasis`, `shIrradiance`, `cubeTexelDirection`,
`raDecToDir`), `probeSceneOf`, `probeGroundSphere(referenceRadius, distance, groundHeight)`,
`PROBE_MIN_GROUND_HEIGHT` (1 m), `planetshineWeights`, `referenceRadiance`, `projectSh`, `bruteForceIrradiance`,
`clipOfDirection`, `PROBE_SIZE` (64), `PROBE_MIPS` (5), `PROBE_CYCLE` (12), `PROBE_MAX_CAMERA_OFFSET` (50 km),
`FLARE_TOTAL_ENERGY`, `STARBURST`, `GHOSTS`, `HOOD_DEPTH` (2), `hoodTransmission(ex, ey)`, `coneNdcBounds`,
`ghostSupport(g, sunRadius)`, `ndcDirection`, `flareRadiance(geometry, dir, pixelAngle)` (CPU model of the flare
image), `MILKY_WAY_FACE_SIZE`, the sky-data helpers.

Hooks used: `prepare`, `compute` (probe), `drawBackground` (Milky Way + sun disc, stars), `preTransparent`
(flare visibility), `drawTransparent` (far images, flare). Perf rows: `sky.background`, `sky.probe.face`,
`sky.probe.mips`, `sky.probe.prefilter`, `sky.flareVis`, `sky.transparent` (attribution mode), all under
feature `sky`.

## 3. What each part does

- **Point-spread function** (stars and point-like bodies; `photometry.ts starPsf`): a Gaussian core of sigma
  1.0 px holding 70 % of the flux plus Moffat wings `(1 + r^2 / 4)^-1.5` (the r^-3 envelope of a diffraction
  pattern) holding 30 %. The image is drawn out to where the wings fall under 1/1024 pre-exposed (at least
  4.3 px, at most 48 px); the wings are `amp x (profile - its value at that radius)`, so they end without a step
  and hold exactly their share. The pixels of an image add up to illuminance / pixel solid angle x exposure to
  2e-3 at any sub-pixel position. Consequence: the image of a star grows with its flux and with the exposure
  (at EV -6, 720 lines: Sirius 27 px radius, a V 5 star the core alone), and its skirt keeps the star's colour
  around a burned-out core.
- **Stars** (`data/sky/stars.f32`, 8,920 stars to V 6.5): instanced quads at clip z = 0 (depth == 0 only,
  additive), directions in ROOT = J2000 axes, projected with the jittered projection; quad half size = the
  image radius (computed per star in the vertex stage from its flux and the frame's exposure).
- **Scintillation**: only when the camera is inside a body's atmosphere shell (below `topAltitude`). Mean-
  preserving log-normal factor per star and channel, variance `s / (1 + s)`, `s = 0.03 X^(11/6) e^(-h / H)`
  (Rytov small-aperture law, saturation, Dravins et al. 1997 zenith value), X from the Chapman function of the
  body's Rayleigh scale height; colours decorrelate towards the horizon; noise at about 6 Hz on the presentation
  clock (frozen while `frame.animate` is false). The image radius uses the unmodulated flux (no size flicker).
- **Milky Way**: the rgb9e5ufloat cube (colour chain uploaded from 1024 per face, 34 MB) sampled along the
  jitter-free view ray of each sky pixel, x `luminanceScale` x exposure, in the same fullscreen pass as the sun
  disc. Where a pixel is smaller than a texel of that chain, the luminance comes from the **detail layer**: the
  baked 2048 level kept as r16float luminance (50 MB instead of the 100 MB of its rgb9e5 texels), multiplied by
  the colour chain's chromaticity; the two cross-fade between one detail texel and one colour texel per pixel
  (the 2 x 2 mean of the detail layer is the colour chain's luminance, so nothing changes level). Sharpness of
  the faint stars equals the full 2048 cube (section 5).
- **Sun disc**: analytic, angular radius `frame.sunDir.w`; per channel `E_c / (pi sin^2 theta) / (1 - u_c / 3)
  x (1 - u_c (1 - mu))` with `u = BodyDef.emission.limbDarkening`, so the disc integrates to the illuminance;
  edge anti-aliased by the pixel footprint (a disc under a pixel becomes a Gaussian of the same flux). Written
  through writeHdr: it saturates at HDR_MAX at any exposure where it would exceed it. Bodies cut it by depth.
- **Far images of distant bodies** (`IMPOSTOR_WGSL`, `photometry.ts`): the sunlit lune of the body's disc is
  sampled on a grid fixed to the body (latitude / longitude about the axis perpendicular to the sun-observer
  plane, from the bright limb to the terminator: every sample is lit however thin the crescent; spacing 0.6 px,
  at least 8 rows of 2), each sample shaded with the body's photometric function and spread with a Gaussian
  kernel (sigma 1.0 px for a point, 0.6 px for a resolved disc, cut at 2.8 sigma and rescaled). A body with
  `surface.brdf = 'hapke'` uses its Hapke function (rendering-design 8.2) with the mean albedo of the face it
  shows (sunlit and visible cells of a 64 x 32 grid of its albedoLowRes map, `visibleFaceAlbedo`; the body's
  `meanColor` without a map); any other body is the Lambert sphere of its `geometricAlbedo` and `meanColor`
  (the brief's formula, the render core's planetshine). The image's pixels add up to the phase-integrated disc
  (Lambert: closed form; Hapke: a 24 x 16 quadrature, recomputed only when phase or albedo change): grids of
  up to 600 samples are normalised to it on the CPU, finer ones are within 2 % by themselves. Bodies under
  6 px also get the star's wings about their photocentre (share fading from 30 % at 2 px to 0 at 6 px), so a
  body shrinks into exactly a star of its flux. **Hand-over** (`impostorWeight`): weight 1 while the SUNLIT
  PART is narrower than 4 px (`litWidthPx` = D / 2 x (1 + cos phase)), fading to 0 at 7 px, and to 0 between
  20 and 32 px of diameter in any case; in DISPLAY pixels, so dynamic resolution does not switch the
  representation. Drawn in the TRANSPARENT stage: on pixels whose 'scene.depth' lies on the body the blend is
  `(1 - a) geometry + image` with a = weight x (1 for bodies under 6 px; for larger ones the PSF-convolved
  sunlit region, so the night side keeps what the geometry shows there); elsewhere the image is added; its depth
  is the body's near side, so nearer geometry hides it; through `applyAtmosphere`.
- **Environment probe** (rendering-design 8.3): position = the active vessel (the camera without one). Per frame
  one face of a 64^2 x 6 rgba16float raw cube is evaluated analytically: nearest body hit (cancellation-free
  sphere test, centres relative to the probe from float64), albedo from the tile set's `albedoLowRes` (footprint-
  matched mip) or `meanColor`; lit by the sun (exact disc visibility against the body's own horizon and every
  other body, the atmosphere's sun transmittance from 'atmosphere.transmittanceLut'), sky irradiance from
  'atmosphere.skyIrradianceLut' and planetshine (`frame.shine` of that body); seen through the view path's
  transmittance (ratio of two transmittance-table lookups) plus the in-scatter of 'atmosphere.skyViewLut'.
  A body flagged Hapke (`BODY_FLAG_HAPKE`) reflects the direct sun through its Hapke function (single-scattering
  albedo by a 14-step bisection of the albedo, the normalisation of the maps), the diffuse rest stays Lambert:
  the ground under a lander is as bright and as coloured in the probe as the terrain renders it.
  Clouds from 'clouds.coverageMap' and the far cloud term (`frame.cloudFar`), the coverage averaged over the
  probe texel's footprint on the layer (4 x 4 taps, each at the matching mip where the map has mips): from above
  the layer the cloud tops (two-stream conservative reflectance, g 0.85) over the ground by the adding method;
  from below, the direct sun on the ground is cloud-shadowed exactly as the core does and the sky is seen
  through the layer with its lit base. Misses: sky-view in-scatter + Milky Way through the atmosphere. The sun
  is not in the probe. Then: raw mip chain + SH9 projection (exact texel solid angles, cosine-lobe convolved,
  the 'env.sh9' order and constants) in frame 7, GGX prefilter of mips 0-4 (filtered importance sampling, 64
  samples, roughness = mip / 4) in frames 8-12 into one of three slots; the published cube and SH are
  `mix(prev, cur, t)` of the two latest completed probes every frame, so lighting changes as a ramp over 12
  frames, never as a step.
- **Ground sphere of the vessel's own body** (`probeGroundSphere`): every body is a sphere in the probe; for the
  active vessel's central body the sphere goes through the actual ground under the vessel wherever that ground
  lies below the reference radius (a landing site in a basin: the mission's lunar site is at -1907.8 m; a capsule
  floating with its origin under the sea surface). The ground's depth comes from `readouts.altitudeRadar`
  (clamped to at least `PROBE_MIN_GROUND_HEIGHT` = 1 m). Continuous in position; in orbit it is the reference
  sphere. GPU (`hitSphere`, origin radius = sphere radius + height from float64) and the CPU reference use the
  same sphere.
- **No double counting with planetshine**: the core lights vessels with planetshine from bodies beyond 2-4 R
  (smoothstep weight w). The probe carries each body with weight `1 - w` computed with the core's own receiver
  rule (`planetshineWeights`).
- **Lens flare** (`flare.ts`; one lens: a 7-blade iris behind coated glass; total 0.93 % of the illuminance at
  the lens): glare core `(1 + (theta / 0.012)^2)^-1.5` (0.28 %), glare skirt `1 / (1 + (theta / 0.02)^2)`
  (the theta^-2 law of veiling glare, to the far side of the sphere; 0.30 %), a veil uniform over the frame
  (0.06 %), fourteen diffraction rays (0.28 %): two per blade, perpendicular to its edge; across, a Gaussian as
  wide as the solar disc at the base (sigma = half the solar radius) opening into a fan (width growing with the
  angle: the peak falls as theta^-3), along, flat to a knee (0.03 rad), theta^-2 beyond and ending as
  `exp(-(theta / L)^2)`; each blade has its own strength (0.72-1.24), length L (0.053-0.076 rad), fan and
  angular error (table `BLADES`); angles scale with wavelength (red rays 4 % longer). Eleven ghosts (0.007 %
  together): images of the iris (heptagons turned like the rays, some inverted, edges rounded and blurred by 1
  to 4 solar radii) on the line through the image centre, tinted at low saturation, with lateral colour (red and
  blue images displaced along that line), an uneven fill (edge caustic or hollow centre, a gradient along the
  line) and a cat's-eye clip that grows with the sun's distance from the axis. Each profile is normalised
  numerically. Geometry: the starburst is one fullscreen quad; each ghost is drawn on the screen-space bounding
  box of its cone (`coneNdcBounds`, + 1.5 px for the jitter). Source = sun illuminance x the atmosphere's
  transmittance at the camera x visible disc fraction x 'clouds.screen'.a at the sun where a cloud is in front x
  the lens hood's transmission, computed on the GPU in `preTransparent` (no readback): 64 Vogel samples over the
  disc, tested against 'scene.depth' on screen and against the frame bodies' reference spheres off screen.
  Lens hood: rectangular, matched to the frame, `HOOD_DEPTH` = 2 entrance-pupil diameters deep: the glare of a
  sun outside the frame fades to nothing 0.5 in tangent beyond the edge. Nothing is added over the disc itself.
  Off for `CameraState.kind === 'interior'`. `flareRadiance` is the CPU model of the same image; the flare specs
  compare the GPU against it pixel by pixel.
- **Additive cap**: every additive write (stars, far images, each flare term) is capped at 500 (pre-exposed,
  about 2,800 x mid-grey, far above display white): blending cannot clamp, and over a solar-disc pixel at 60,000
  a full-strength stack would overflow rgba16float to Inf.

## 4. How to run and verify

All through the gate (`node tools/dev/heavy.mjs --class=cpu|gpu -- ...`), one at a time:

```
npm run typecheck:paths -- src/render/sky labs/sky tests/browser/sky tests/unit/sky
npx vitest run src/render/sky tests/unit/sky tools/dev/boundaries.test.ts         # 51 + boundaries (cpu)
npx playwright test tests/browser/sky --project=functional                        # 26 tests, about 7 min (gpu): three of them wait 30 s for dark adaptation
npx playwright test tests/browser/sky --project=perf                              # 1 spec, GPU lock (gpu)
```

Lab: `/labs/sky/` (query: `scene=`, `sky=0`, `parts=-stars,-milkyWay,-sun,-impostors,-probe,-flare`,
`probeAlbedo=mean`, `planet=0`, `maps=tileset|none|lambert`, `spheres=1` (+`spacing=`), `clouds=1`,
`cloudUnder=1` (turn the stand-in cloud layer so that a cloud field lies under the vessel), `valt=<m>`,
`ground=<m>` (with `valt`: ground elevation under the vessel; the read-outs' radar altitude follows and a lab
ground cap is drawn there, with the albedo the tile set's map has at that place), `mwSize=<n>` (Milky Way colour
face size in VRAM), `mwDetail=0` (no luminance detail layer), `night=1`, `heavy=<n>`, `hud=0`, plus every
createLabApp parameter). `window.__sky`: `sky` (the feature), `setSunDirection`,
`setSunForVessel('night' | { elevationDeg, azimuthDeg, fromCamera? })`, `setVesselAltitude(h, groundAltitude = 0)`,
`lookAtRaDec(ra, dec, fov?, position?)`, `lookFrom`, `projectDir`, `setCloudCover(on)` (synthetic opaque
'clouds.screen'), `setHeavy(n)`, `referenceScene()`, `flareGeometry()`, `cpu.{referenceRadiance, projectSh,
bruteForceIrradiance, shIrradiance, flareRadiance, ndcDirection, starImageRadius, starPsf}`. `clouds=1` is a lab
stand-in for the cloud renderer (not shipped): it publishes the Earth's real coverage map with the far cloud term
(optical depth 20), draws the layer as a thin translucent shell with the probe's cloud model, and (since the
exposure meter's histogram is taken before the transparent pass) reports the sunlit deck to the meter with
`addEmissiveHint` from a 16 x 9 grid of view rays.

Automatic exposure in the lab: nothing lit in view settles at the dark floor EV -6 (after 25 s of dark
adaptation: specs wait for `|ev100 - targetEv100| < 0.02`); the star-field views use `scene=lowOrbit&night=1&
planet=0&parts=-impostors,-sun,-flare` for that (in `translunar` the sunlit vessel is in view and the meter
exposes for it).

## 5. Acceptance criteria, measured

RTX 5090, Chrome headless, 1280 x 720 unless stated; 2026-11-11 (after the visual close-out), other agents' jobs
on the machine.

| Criterion | Result | Spec |
|---|---|---|
| Sirius, Canopus, Polaris, Orion's belt, Southern Cross at the projected pixel within 1 px | centroid errors 0.02-0.09 px for all 10 stars (5 x 5 px centroid of the wider image) | `stars.spec.ts` |
| Milky Way band crosses the expected constellations | Sagittarius 5.96e-4, Carina 1.15e-3, Crux 1.03e-3, Cygnus 3.79e-4, Cassiopeia 3.74e-4 cd/m^2 vs galactic poles 4.98e-5 / 3.93e-5 and Ursa Major 3.59e-5 | `stars.spec.ts` |
| Integrated luminance of an isolated star = E / Omega_px x exposure within 5 % | Sirius on axis 0.9998 (image radius 23.5 px), Sirius 14 deg off axis 1.0000, Rigel 1.0028, a V 4.75 star 0.9994 | `stars.spec.ts` |
| At EV100 14-15 no star exceeds 1/255 after tonemapping | at EV 14 and at EV 15 all stars + Milky Way change no display pixel (max difference 0/255, static floor 0); the lab's sunlit cloud deck meters to EV 13.7 | `stars.spec.ts` |
| In Earth's shadow at the dark-adapted exposure the 100 brightest stars are visible and the Milky Way faintly | LEO night settles at EV **-5.98** (the core's new floor): 100 of the 100 brightest in view across 8 views, faintest peak 147/255, median 227/255; 14,920 star images above 16/255 in the 60 deg frame; Milky Way (8-bit mean of a 60 px window) 39.8 (galactic centre), 25.5 (Cygnus), 61.1 (Crux) vs 3.7 / 3.1 at the poles; hue of the band R/G 1.30, R/B 1.81 at EV -6 and 1.34, 1.84 three stops under | `stars.spec.ts` |
| Stars do not influence auto-exposure | settled EV 11.5645 with, 11.5679 without | `stars.spec.ts` |
| Sun disc subtends 0.533 deg | 0.5379 deg measured = 2 x angular radius at the FakeSim's date (0.99 AU) exactly; 0.533 at 1 AU | `sun.spec.ts` |
| Darker limb, mean within 5 % of 1.9e9 cd/m^2 x exposure | mean 1.8816e9 vs E / (pi sin^2) 1.8839e9 (ratio 0.9988); integrated 130,361 vs 130,405 lux; L(0.9 R) / L(centre) 0.6710 vs model 0.6711 | `sun.spec.ts` |
| EV100 -3: exactly HDR_MAX, nanPixels 0 | HDR target max 60000, NaN 0 (flare on); resolved max 59680, NaN 0 | `sun.spec.ts` |
| Body shrinking 20 px -> 0.5 px keeps its flux within 10 % through the cross-fade | Lambert Earth backdrop (`maps=lambert`), 40 px -> 0.5 px in 30 steps, phase 50 deg and phase 125 deg (crescent): HDR flux / Lambert-sphere law 0.996-1.030 at every size; AFTER the temporal resolve 0.975-1.020 (it was 0.34 at 6.6 px); one colour throughout (channels within 1 %) | `impostor.spec.ts` |
| The far image matches the geometry it hands over to (visual close-out) | Moon (lab regolith sphere, the tile set's albedo map), far image / geometry in HDR flux: 0.98 (phase 30 deg), 1.01 (90 deg), 1.04 (125 deg); colour within 1 %; resolved flux step to step within 20 % from 1.5 to 44 px | `impostor.spec.ts` |
| Probe SH9 irradiance in LEO matches a brute-force integration within 10 %; Earth- vs space-facing ratio | probe / brute force: Earth-facing 0.976, horizontal 0.986-0.988, 45 deg down 1.007; space-facing exact irradiance 0 | `probe.spec.ts` |
| Probe energy responds to day / night side and altitude | Earth-facing irradiance: day 200 km 2.73e4 lux (brute 2.79e4), night 3.7e-5 lux, 2000 km 1.66e4, 6000 km 7.27e3, 12,742 km 1.42e3 (Earth weight 0.5), 20,000 km 5.9e-4 (planetshine only) | `probe.spec.ts` |
| Probe at a landing site below the datum | ground-facing SH9 irradiance (sun 35 deg up, mean colours, Hapke): 9879 lux 30 m over the datum; descending over the site's ground 9738 / 9759 / 9759 / 9759 / 9801, landed 9893 lux; each within 1 % of the brute force of the same scene | `probe.spec.ts`, `probeScene.test.ts` |
| Flare vanishes when a synthetic cloud layer covers the sun | cloud transmittance at the sun 0.000, flare contribution max 0 | `flare.spec.ts` |
| Flare energy under 1 % of the source | on screen 0.82 / 0.81 / 0.80 / 0.69 % of the sun's illuminance with the sun 6 / 25 / 35 / 44 deg off axis (design total 0.93 %); GPU = CPU model per pixel within 0.99 % (every pixel of the frame); visible fraction 1.0 / 0.5 / 0.0 with the sun centre 1 deg above / on / 1 deg below the Earth's limb; off for an interior camera | `flare.spec.ts` |
| Glare fades as the sun leaves the frame | 0.1 deg steps across the edge change the on-screen flare by under 10 %; monotonic fall to 0 at the hood's cut-off (+11.5 deg); GPU = model at every step | `flare.spec.ts` |
| Flare as a picture, at the exposure of a sunlit scene (visual close-out) | section 12, item 1 / 2 / 5 | `flare.spec.ts` "display image" |
| Static-camera frame difference with TAA is zero for stars | **Not met as stated** (see 6.1): the feature's output is exactly constant (HDR target, no jitter: max difference 0); through the core's TAA the resolved stars follow the 8-phase jitter cycle: 0.35 % mean, 3.1 % max relative change between consecutive frames (0.82 % / 7.5 % with the 0.7 px core), 2.3 % between frames 8 apart | `stars.spec.ts` |
| Scintillation only inside an atmosphere, growing with air mass | passes as before (pad at night; in space the HDR frame difference is 0) | `scintillation.spec.ts` |
| Perf (1440p internal, quality 1, attribution mode, 7-8 ms ballast; two runs, other agents' GPU jobs running in the second) | background p99 **0.0136 / 0.0175 ms** (budget 0.08; 0.0140 / 0.0141 ms on the night side at EV -6, every star above black), probe amortised **0.0195 / 0.0244 ms** (p99 of any step 0.033; budget 0.08), flare p99 **0.0348 / 0.0389 ms** (vis 0.005 + transparent 0.029-0.034; budget 0.04), sum **0.068 / 0.081 ms** (line 0.2 / 0.3 in orbit); the Moon's far image (11 px) alone 0.004-0.005 ms. The feature row 'sky' (p99 of the per-frame sum) read 0.080 ms on the quieter machine and 0.28-0.32 ms with other GPU jobs running (single passes spike in different frames); provisional under rule 16 | `sky.perf.spec.ts` |
| expectNoErrors everywhere | yes, every spec | all |

VRAM: Milky Way colour chain 33.6 MB + luminance detail layer 50.3 MB + albedo maps 5.6 MB + probe 1.3 MB +
stars 0.3 MB = **91 MB** (line: 0.1 GB).

Reviewed screenshots (`out/screens/sky/`, all looked at, all written by the specs of the last run):
`starfield-deep-space-auto.png`, `orion-closeup-auto.png`, `crux-centaurus-auto.png` (the dark-adapted
automatic exposure), `milky-way-1024-default-2048-{orion-closeup,galactic-centre}-crop-3x.png` (1024 colour only |
the default | the full baked cube), `milky-way-band-ev-3.png`, `orientation-*.png`,
`leo-day-stars-invisible.png`, `leo-night-dark-adapted.png`, `sun-at-earth-limb-leo-flare.png`,
`flare-deep-space-ev14.png` / `-ev12.png` / `-ev9.png`, `flare-off-axis-35deg-ev14.png` / `-ev12.png`,
`flare-off-axis-30deg-ev14.png`, `flare-sun-just-outside-frame-ev14.png` / `-ev12.png`,
`flare-display-check-ev14.png`, `flare-sun-outside-display-check-ev14.png`, `sun-disc-limb-darkening-filter.png`,
`sun-ev-3-saturated.png`, `crescent-earth-approach-sheet.png` (phase 125 deg, 0.5 to 40 px),
`crescent-earth-lunar-distance.png`, `crescent-moon-approach-sheet.png` (1.5 to 40 px), `pbr-spheres-leo-day.png`,
`pbr-spheres-leo-night.png`, `pbr-spheres-lunar-surface.png`, `perf-1440p-leo-horizon.png`,
`perf-1440p-leo-horizon-night.png`.

## 6. Deviations from the brief and decisions

1. **"Frame difference zero for stars with TAA"**: the sky writes an exactly constant image; the core's TAA
   resolve turns any point source into a signal that follows the jitter cycle. `docs/requests/sky-lighting-1.md`
   was DECLINED (a fix is a redesign of the resolve, recorded for the lead in `docs/handoff/core-support.md`);
   its advice was applied here: the PSF core is 1.0 px (the ripple more than halved, table above) and bodies
   stay on the far image by lit width. The spec asserts the measured bounds (mean under 1 %, worst under 6 %).
2. **`createSkyFeature(options)`** instead of `createSkyFeature(ctx)`: features receive the RenderContext in
   `init`.
3. **Far images are drawn in `drawTransparent`**, not `drawBackground`: a cross-fade with the body's geometry has
   to replace geometry pixels, which the background pass (depth == 0 only) cannot touch.
4. **PSF**: sigma 1.0 px with wings instead of the brief's "sigma about 0.7 px" Gaussian (visual QA items 6, 9).
5. **Hand-over on the lit width (4 to 7 px, and by 32 px of diameter), in display pixels**, instead of the
   brief's 3 to 6 px of diameter (visual QA item 4; core-support's advice in the resolution of request 1). At full
   phase that is 4 to 7 px of diameter.
6. **A regolith body's far image uses its Hapke function and its albedo map's visible-face mean**, not the
   Lambert sphere of the brief: the Lambert sphere is 3 x too bright at quadrature against the geometry it hands
   over to. Bodies without a Hapke surface keep the brief's Lambert sphere of `geometricAlbedo` and `meanColor`:
   the hand-over to a rendered Earth is continuous only if terrain + ocean + clouds + atmosphere integrate to
   that (not measurable in this package's lab; request 5 asks for the integration views).
7. **The probe holds while the camera is more than 50 km from the vessel** (map view).
8. **Bodies carried by the core's planetshine are scaled out of the probe** (weight 1 - w, section 3).
9. **The 0.533 deg check** uses the disc's angular radius at the scene's real Sun distance.
10. **Additive cap 500** on stars / far images / flare terms and **no flare over the disc** (section 3). A test
    that opens the exposure until a point's peak passes 500 pre-exposed (2,800 x mid-grey) sees the cap.
11. **Scintillation strength** is a physical constant in `photometry.ts`; there is no per-body field for
    turbulence in `AtmosphereRenderDef`.
12. **VRAM**: the default now carries the baked 2048 resolution as luminance (91 MB in all, inside the 0.1 GB
    line): the question of request sky-lighting-2 (raise the line for the full-colour 2048 cube) no longer needs
    a decision; `milkyWayFaceSize: 2048` still loads the full cube (134 MB).
13. **Lens constants** (`STARBURST`, `BLADES`, `GHOSTS`, `HOOD_DEPTH`) are the design of one lens, like a blade
    count: energies sum to 0.93 % of the source (brief: under 1 %).
14. **The lab's ground cap takes the albedo map's value at the site** (it used the body's mean colour), so the
    ground and its reflection in the probe describe the same ground.

## 7. Known weaknesses (plainly)

- The TAA items of 6.1 (core-side): a star's rim pixels still ripple by up to 3 % with the jitter cycle.
- No emission nebulae and no galaxies beyond the Magellanic Clouds, and the Clouds are magenta: the cube's data
  (request 4, open). The Orion view has no M42.
- The far image of a body WITH an atmosphere is a Lambert sphere of its mean colour: no blue limb, no ocean
  glint, no cloud pattern; from 20 px of diameter the geometry takes over. Its match with the real
  terrain + atmosphere renderers at the hand-over has not been measured (request 5, open).
- The far image is a smooth sphere of one albedo: maria appear only as the geometry fades in (above 7 px of
  lit width).
- The flare is analytic and of one lens design; no flare from other bright sources (glints, the Moon); cockpit
  window glare is not done here (interior cameras get no flare). A sun just outside the frame is hidden only by
  bodies (not by a vessel or by clouds beyond the edge pixel). In the lab the glare is seen on black: without an
  atmosphere around the sun it reads as a soft round glow.
- The probe's ground sphere is a single sphere through the ground under the vessel (no crater walls, no slope);
  bodies in it are smooth spheres with their low-resolution albedo maps: no relief, no night lights, no ocean
  glint, no shadows of the vessel. Only the first 4 bodies of the snapshot are in it.
- SH9 band limit: on a 45 deg upward normal in LEO the probe gives 11 % more than the exact irradiance.
- Probe latency: a change reaches the published probe within one to two cycles (12-24 frames, a ramp).
- The lab's Earth (LabPlanet + a stand-in cloud shell, no atmosphere) is not the game's Earth: the LEO day and
  limb views cannot be held against a photograph (request 5).
- Moon albedo: the map is blue above red at the landing site and its mean differs from `meanColor` (request 6).
- Perf idle numbers (GPU otherwise idle, low clocks) are noisy; the budget numbers are with the ballast.

## 8. Data notes

- `data/sky` is used as the bake describes it (manifest validated, file sizes checked against a full mip chain,
  catalogue records validated). The cube's orientation is confirmed independently by `skyData.test.ts`.
- The detail layer is computed at load from the baked level 0 (4.2 M texels per face to half floats, a few
  tens of ms per face); nothing new is baked.
- Albedo maps: `/tiles/index.json` first (no 404s), then each tile set's `globals.albedoLowRes`; a 64 x 32
  linear-albedo grid of each is kept on the CPU for the far images.

## 9. Requests

- `sky-lighting-1` (core-support, TAA energy and static convergence): **declined**; advice applied (6.1, 6.5).
- `sky-lighting-2` (lead, VRAM line for the full 2048 cube): escalated to the lead; **no longer needed** (6.12).
- `sky-lighting-3` (core-support, dark exposure floor and the tonemap's toe): **resolved** (commit 5d3e0ee):
  floor EV -6 with slow dark adaptation, linear hue-preserving toe. The sky's specs assert at the new floor.
- `sky-lighting-4` (sky bake): emission nebulae and M31 in the cube; the Magellanic Clouds' magenta. **Open.**
- `sky-lighting-5` (integration lab): three views of the sky with the real terrain, atmosphere and ocean (sun at
  the limb, hull over cloud, LEO night at the automatic exposure). **Open.**
- `sky-lighting-6` (Moon bake / defs): albedo colour (blue above red at the mare), `meanColor` against the map's
  mean. **Open.**
- Against this package's paths: none.

## 10. For the packages that build on this

- **App shell (lead)**: register `createSkyFeature()` once; nothing else to wire. It loads `/sky/*` and the
  tile sets' `albedoLowRes` itself and reports `isIdle()` false until a probe has been built from all data.
- **atmosphere-clouds**: the background (Milky Way, sun disc, stars) is drawn before your composite and must be
  attenuated by it; far images and flare come after it and apply `applyAtmosphere` / the transmittance table
  themselves. The probe reads 'atmosphere.skyViewLut', 'atmosphere.transmittanceLut',
  'atmosphere.skyIrradianceLut', 'clouds.coverageMap' (mips are used when it has them) and `frame.cloudFar`; the
  flare reads 'clouds.screen'.a and 'clouds.depth' at the sun.
- **vehicle / cockpit**: standard materials are lit by 'env.sh9' and 'env.probeCube' from the vessel's position.
- **terrain-render**: nothing to do; a distant body whose sunlit part is narrower than 7 px (or that is under
  7 px across) is covered by its far image over your geometry automatically (by depth).

## 11. Review round (2026-11-11, before the visual critique)

| Finding | Severity | What was done |
|---|---|---|
| Probe loses the ground below the datum | major | Fixed: `probeGroundSphere`, GPU and CPU reference alike; probe spec over a descent from +2500 m to landed at the site; unit tests. |
| Flare quads sized with the on-axis image scale clip the flare off axis | major | Fixed: starburst over the whole frame, ghosts on the projected bounding box of their cones; GPU = CPU model per pixel far off axis. |
| Glare pops off when the disc leaves the frame | minor | Fixed: off-screen disc samples tested against the frame bodies; the lens hood fades the source over 11 deg beyond the edge. |
| TAA star stability criterion not met | minor | Core-side; request 1 declined; mitigated in round 1 below. |
| Sky over its 0.1 GB VRAM line | minor | Fixed: colour chain from 1024 per face; in round 1 the 2048 level came back as luminance. |

## 12. Visual close-out, round 1 (2026-11-11)

Two visual critics scored the package 4.5 (photo) and 5 (artifact); their merged list is
`out/qa/wave2/sky-lighting.md`. What was done per item, with the screenshot that shows it:

| # | Item | Done | Evidence |
|---|---|---|---|
| 1 | Starburst: 14 hairlines to the frame edges (blocker) | **Fixed at the cause.** The rays are the diffraction of a 7-blade iris for a DISC source: as wide as the solar disc at the base, opening into fans (peak falling as theta^-3), ending within about 5 deg, each blade with its own strength (0.72-1.24), length and angular error, 30 % of the starburst's energy. Display checks at EV 14.4 on true cones about the sun: the strongest ray is 7.3 px wide at half maximum 60 px from the sun (disc 5.9 px), stands 15 levels over the glare there, the fourteen peaks at 4 deg spread from 5 to 23 levels, and from 8.5 deg out nothing stands more than 0.8/255 over the glare; a sun 0.3 deg outside the frame gives haze only (largest excess over the ring median 4.7/255). | `flare-deep-space-ev14.png`, `flare-off-axis-30deg-ev14.png`, `flare-sun-just-outside-frame-ev14.png`; `flare.spec.ts` "display image" |
| 2 | Glare: a grey ball with a rim | **Fixed** (profile here, toe in the core). The single theta^-3 halo became a core + a theta^-2 skirt + a veil; request 3 gave the display a linear toe. Median 8-bit profile at EV 14.4 (px from the sun): 248 at 16, 188 at 40, 133 at 64, 100 at 88, 54 at 136, 23 at 184, 16 at 208, 10 at 256, 7 at 352, 5 at 496: monotonic, under 16/255 from 212 px and still 6/255 at twice that radius, slope under 0.15 levels/px beyond; the tail has the sun's own colour (R/G 1.04, B/G 0.96 at every radius: no cast). | `flare-display-check-ev14.png`, `sun-at-earth-limb-leo-flare.png` |
| 3 | Night sky almost black at the darkest exposure the game reaches | **Fixed** (request 3: floor EV -6). At the settled automatic exposure in Earth's shadow: 14,920 star images above 16/255 in a 60 deg frame, Milky Way 40 / 26 / 61 of 255 (galactic centre / Cygnus / Crux), all 100 brightest stars at 147/255 or more. All star-field views are now taken at that exposure (no hand-set EV -5). | `leo-night-dark-adapted.png`, `starfield-deep-space-auto.png`, `crux-centaurus-auto.png`, `pbr-spheres-leo-night.png` |
| 4 | Distant body blinks dark and changes colour and shape at the hand-over | **Fixed at the cause.** The blob became the analytic far image (section 3): phase-shaped from a few pixels (the light sits 0.36-0.38 diameters off centre from 2.5 px up, as the photocentre of a crescent does), the body's own photometric function, handed over on lit width in display pixels. Earth sheet (Lambert backdrop, phase 125 deg, 0.5 to 40 px): resolved flux 0.975-1.02 of the law at every size (was 0.34 at 6.6 px), display sums rising smoothly 21 -> 45 (a point burns out more of its light than a crescent), chromaticity within 0.03. Moon: far image / geometry 0.98 / 1.01 / 1.04 at three phases, colour within 1 %. Hand-off corrected. | `crescent-earth-approach-sheet.png`, `crescent-moon-approach-sheet.png`; `impostor.spec.ts` |
| 5 | Ghosts: bright flat pastel discs with a red outline | **Fixed.** Eleven iris images of very different size (0.011 to 0.15 rad), soft-edged, with lateral colour instead of a radial outline, uneven fills and a cat's-eye clip; energies 1e-6 to 2e-5 of the source (0.007 % together, was 0.036 %). At EV 14.4 the brightest pixel further than 20 deg from the sun is 31/255 (a quarter of mid-grey is 55). | `flare-off-axis-35deg-ev14.png`, `flare-off-axis-35deg-ev12.png` |
| 6 | Every star the same hard dot | **Fixed.** One point-spread function with wings for every point source (section 3). Orion at the automatic exposure: Betelgeuse 71 px at 128/255 or more with an orange skirt (110, 87, 62), Rigel 86 px, blue-white (89, 96, 116), Mintaka (V 2.2) 29 px; unit test: a V 0 star more than 3 x as wide as a V 5 star at EV -5, monotonic in flux. | `orion-closeup-auto.png`, `leo-night-dark-adapted.png` |
| 7 | Faint diffuse light changes hue | **Fixed in the core** (request 3, hue-preserving toe): band R/G 1.30, R/B 1.81 at EV -6 and 1.34, 1.84 three stops under (asserted within 20 %). The Magellanic Clouds are still magenta: that is in the cube's data (request 4). | `milky-way-band-ev-3.png`, `starfield-deep-space-auto.png` |
| 8 | Faint stars from the 1024 cube are rectangular smudges | **Fixed** inside the VRAM line: the baked 2048 level is kept as luminance (section 3). Sharpness (mean horizontal gradient of a 24 deg crop): 1024 only 1.89, default 3.19, full 2048 cube 3.17 (Orion); 2.50 / 4.74 / 4.82 (galactic centre). | `milky-way-1024-default-2048-orion-closeup-crop-3x.png` |
| 9 | Stars shimmer for a static camera | **Mitigated as far as this package can**: core 1.0 px: ripple 0.35 % mean / 3.1 % max (was 0.82 % / 7.5 %); spec bounds tightened to 1 % / 6 %. Zero needs the resolve redesign (lead). | `stars.spec.ts` "static camera" |
| 10 | Probe: dashed white line and specks from the cloud map | **Fixed**: coverage averaged over the probe texel's footprint (16 taps, matching mip). The chrome sphere over the cloud deck shows a smooth deck and limb. | `pbr-spheres-leo-day.png` |
| 11 | On the Moon the probe reflects the ground darker and colder than the ground | **Fixed** for brightness and hue match: the probe shades a regolith body through its Hapke function, and the lab's ground cap takes the map's albedo at the site, so ground and reflection are the same ground. What remains is the data: that ground is a cold blue-grey (request 6). | `pbr-spheres-lunar-surface.png` |
| 12 | No emission nebulae | **Not fixable here** (the cube's data, owned by the sky bake): request 4, open. | - |
| 13 | Main views staged on the lab stand-in Earth; three stale screenshots | **Partly**: the vessel now sits over a cloud field (`cloudUnder=1`), every view is taken at the automatic exposure, every file in the folder is written by a spec of the last run (stale ones deleted, the comparison crops are a spec). The views with the real atmosphere are the integration lab's: request 5, open. | `pbr-spheres-leo-day.png`, `sun-at-earth-limb-leo-flare.png` |

Not fixed, and why: item 12 (data); the integration views of item 13 (other owner); the residual of item 9
(core resolve); the colour of the lunar ground in item 11 and the Clouds' colour in item 7 (data, requests 6
and 4). Requests filed in this round: 3 (resolved), 4, 5, 6 (open).

Measured perf after the round (1440p, 7-8 ms ballast, two runs): background p99 0.0136 / 0.0175 ms (night side at
EV -6: 0.0140 ms), probe 0.0195 / 0.0244 ms amortised, flare p99 0.0348 / 0.0389 ms (budget 0.04: little room),
sum 0.068 / 0.081 ms; the Moon's far image 0.005 ms. Two things cost
GPU time on the way and are worth knowing: a per-vertex sum over the far image's whole grid (a single GPU
thread doing thousands of samples: 0.05 ms for an 11 px body; it is now a CPU sum for coarse grids only) and a
frame-sized ghost (dropped: the veil shows the same).
