# Hand-off: sky-lighting

The sky as seen from anywhere in the system, photometrically: catalogue stars as Gaussian PSFs, the Milky Way
cube, the solar disc with per-channel limb darkening, distant bodies under 6 px as phase-integrated point
impostors cross-faded with their geometry, the live environment probe at the active vessel ('env.probeCube',
'env.sh9'), and the lens flare. One `RenderFeature`; no brightness knobs anywhere: every luminance follows from
the data (`data/sky`, `BodyDef`) and the frame's exposure.

## 1. Where things are

```
src/render/sky/index.ts        public API (import from '@/render/sky')
src/render/sky/feature.ts      createSkyFeature: data loading, background, impostors, flare, hooks
src/render/sky/probe.ts        EnvironmentProbe: face evaluation, mip chain + SH9, GGX prefilter, blend, publication
src/render/sky/probeScene.ts   probe scene in float64 (bodies, ground sphere, planetshine weights) + CPU reference (brute force, SH)
src/render/sky/photometry.ts   PSF, disc, Lambert sphere, impostor fade, air mass, scintillation, cloud two-stream, SH, cube maths
src/render/sky/flare.ts        flare terms, their normalisation, ghost cone bounds, lens hood, CPU model of the flare image
src/render/sky/skyData.ts      SkyManifest validation, star catalogue parsing, rgb9e5 layout / decoding
src/render/sky/shaders.ts      all WGSL
labs/sky/                      lab page (main.ts, world.ts: sun / vessel-altitude / ground-elevation overrides)
tests/unit/sky/                vitest (photometry, sky data against data/sky, probe weights + ground sphere + CPU reference, flare geometry)
tests/browser/sky/             Playwright: stars, sun, impostor, probe, flare, scintillation, views, sky.perf
docs/requests/sky-lighting-1.md   request to core-support (TAA resolve), open
docs/requests/sky-lighting-2.md   request to the lead (sky VRAM line vs the full-resolution Milky Way cube), open
```

## 2. Public API (exact signatures)

```ts
// '@/render/sky'
createSkyFeature(options?: SkyFeatureOptions): SkyFeature
interface SkyFeatureOptions extends Partial<SkyParts> {
  id?: string;                              // default 'sky' (prefix of passes and perf rows)
  order?: number;                           // default 0
  probeAlbedo?: 'tileset' | 'meanColor';    // probe body colour: albedoLowRes where baked (default), or BodyDef meanColor
  milkyWayFaceSize?: number;                // largest Milky Way face size kept in VRAM (default MILKY_WAY_FACE_SIZE = 1024)
}
interface SkyParts { stars: boolean; milkyWay: boolean; sun: boolean; impostors: boolean; probe: boolean; flare: boolean }
interface SkyFeature extends RenderFeature {
  readonly parts: SkyParts;                  // mutable switches (all true by default; labs use them for A/B readbacks)
  status(): SkyStatus;                       // { manifest, starsLoaded, milkyWayLoaded, milkyWayFaceSize, error, flareDrawn }
  stars(): StarCatalogue | null;             // parsed stars.f32 (records: STAR_RECORD_FLOATS per star)
  impostors(): ImpostorInfo[];               // last frame: { bodyId, diameterPx, weight, illuminance (lux), sigmaPx }
  probe(): ProbeState;                       // { completed, step, holding, scene, albedoMaps }
  readProbeSh(): Promise<number[][]>;        // published SH9 irradiance coefficients, 9 x rgb, lux
  readProbeFace(face: number, mip?: number): Promise<{ size: number; data: Float32Array }>;
  readFlareState(): Promise<FlareStateInfo>; // { visible, cloud, inView, hood, transmittance }
}
```

Also exported: everything in `photometry.ts` (e.g. `starPeakLuminance`, `discMeanLuminance`,
`lambertSphereIlluminance`, `impostorWeight`, `chapman`, `scintillationVariance`, `shBasis`, `shIrradiance`,
`cubeTexelDirection`, `raDecToDir`), `probeSceneOf`, `probeGroundSphere(referenceRadius, distance, groundHeight)`,
`PROBE_MIN_GROUND_HEIGHT` (1 m), `planetshineWeights`, `referenceRadiance`, `projectSh`, `bruteForceIrradiance`,
`clipOfDirection`, `PROBE_SIZE` (64), `PROBE_MIPS` (5), `PROBE_CYCLE` (12), `PROBE_MAX_CAMERA_OFFSET` (50 km),
`FLARE_TOTAL_ENERGY`, `HOOD_DEPTH` (2), `hoodTransmission(ex, ey)`, `coneNdcBounds`, `ghostSupport`, `ndcDirection`,
`flareRadiance(geometry, dir, pixelAngle)` (CPU model of the flare image), `MILKY_WAY_FACE_SIZE`, the sky-data
helpers.

Hooks used: `prepare`, `compute` (probe), `drawBackground` (Milky Way + sun disc, stars), `preTransparent`
(flare visibility), `drawTransparent` (impostors, flare). Perf rows: `sky.background`, `sky.probe.face`,
`sky.probe.mips`, `sky.probe.prefilter`, `sky.flareVis`, `sky.transparent` (attribution mode), all under
feature `sky`.

## 3. What each part does

- **Stars** (`data/sky/stars.f32`, 8,920 stars to V 6.5): instanced 6 x 6 px quads at clip z = 0 (depth == 0
  only, additive), directions in ROOT = J2000 axes, projected with the jittered projection. Pixel value
  `colour x E / (2 pi sigma^2 Omega_px) x exp(-d^2 / 2 sigma^2) x exposure`, sigma 0.7 px, Omega_px = on-axis
  pixel solid angle x cos^3 off-axis. The lattice sum of that Gaussian equals its integral to 1e-4 at any
  sub-pixel position, so the integrated luminance is E / Omega_px independent of the jitter.
- **Scintillation**: only when the camera is inside a body's atmosphere shell (below `topAltitude`). Mean-
  preserving log-normal factor per star and channel, variance `s / (1 + s)`, `s = 0.03 X^(11/6) e^(-h / H)`
  (Rytov small-aperture law, saturation, Dravins et al. 1997 zenith value), X from the Chapman function of the
  body's Rayleigh scale height; colours decorrelate towards the horizon; noise at about 6 Hz on the presentation
  clock (frozen while `frame.animate` is false).
- **Milky Way**: the rgb9e5ufloat cube sampled along the jitter-free view ray of each sky pixel, x
  `luminanceScale` x exposure, in the same fullscreen pass as the sun disc. The bake is 2048^2 x 12 mips; by
  default the chain is uploaded from 1024 per face (34 MB instead of 134 MB: the sky stays within its 0.1 GB VRAM
  line); `milkyWayFaceSize: 2048` loads it whole (request sky-lighting-2 asks the lead which to ship).
- **Sun disc**: analytic, angular radius `frame.sunDir.w`; per channel `E_c / (pi sin^2 theta) / (1 - u_c / 3)
  x (1 - u_c (1 - mu))` with `u = BodyDef.emission.limbDarkening`, so the disc integrates to the illuminance;
  edge anti-aliased by the pixel footprint (a disc under a pixel becomes a Gaussian of the same flux). Written
  through writeHdr: it saturates at HDR_MAX at any exposure where it would exceed it. Bodies cut it by depth.
- **Impostors**: every non-star body under 6 px (diameter / pixel angle x cos^1.5 off-axis), flux
  `E_sun(body) x geometricAlbedo x (R/d)^2 x Phi_Lambert(phase) x eclipse(body)` coloured by
  `meanColor / luminance(meanColor)` (the render core's planetshine formula), drawn as a Gaussian of
  `sigma^2 = 0.7^2 + (D/4)^2` px. Weight 1 below 3 px, smoothstep to 0 at 6 px. Drawn in the TRANSPARENT stage:
  on pixels whose 'scene.depth' lies on the body the blend is `(1 - w) geometry + w impostor`, elsewhere the
  blob is added; its depth is the body's near side, so nearer geometry hides it; through `applyAtmosphere`.
- **Environment probe** (rendering-design 8.3): position = the active vessel (the camera without one). Per frame
  one face of a 64^2 x 6 rgba16float raw cube is evaluated analytically: nearest body hit (cancellation-free
  sphere test, centres relative to the probe from float64), albedo from the tile set's `albedoLowRes` (footprint-
  matched mip) or `meanColor`; lit by the sun (exact disc visibility against the body's own horizon and every
  other body, the atmosphere's sun transmittance from 'atmosphere.transmittanceLut'), sky irradiance from
  'atmosphere.skyIrradianceLut' and planetshine (`frame.shine` of that body); seen through the view path's
  transmittance (ratio of two transmittance-table lookups) plus the in-scatter of 'atmosphere.skyViewLut'.
  Clouds from 'clouds.coverageMap' and the far cloud term (`frame.cloudFar`): from above the layer the cloud tops
  (two-stream conservative reflectance, g 0.85) over the ground by the adding method; from below, the direct
  sun on the ground is cloud-shadowed exactly as the core does and the sky is seen through the layer with its
  lit base. Misses: sky-view in-scatter + Milky Way through the atmosphere. The sun is not in the probe. Then:
  raw mip chain + SH9 projection (exact texel solid angles, cosine-lobe convolved, the 'env.sh9' order and
  constants) in frame 7, GGX prefilter of mips 0-4 (filtered importance sampling, 64 samples, roughness =
  mip / 4) in frames 8-12 into one of three slots; the published cube and SH are `mix(prev, cur, t)` of the two
  latest completed probes every frame, so lighting changes as a ramp over 12 frames, never as a step.
- **Ground sphere of the vessel's own body** (`probeGroundSphere`): every body is a sphere in the probe; for the
  active vessel's central body the sphere goes through the actual ground under the vessel wherever that ground
  lies below the reference radius (a landing site in a basin: the mission's lunar site is at -1907.8 m; a capsule
  floating with its origin under the sea surface). The ground's depth comes from `readouts.altitudeRadar`
  (clamped to at least `PROBE_MIN_GROUND_HEIGHT` = 1 m: the vessel origin sits above its lowest contact point).
  While the probe is below the reference radius the sphere passes through that ground; as it climbs above the
  reference radius the sphere rises back to it, reaching it once the probe is as high above the datum as the
  ground is below it. Continuous in position; in orbit (higher than any depression is deep) it is the reference
  sphere, exactly as before. GPU (`hitSphere`, origin radius = sphere radius + height from float64) and the CPU
  reference use the same sphere. Before this fix the probe lost the ground below the datum (ground-facing
  irradiance 8.5e-4 lux instead of 7.5e3 lux; review finding).
- **No double counting with planetshine**: the core lights vessels with planetshine from bodies beyond 2-4 R
  (smoothstep weight w). The probe carries each body with weight `1 - w` computed with the core's own receiver
  rule (`planetshineWeights`): in LEO the Earth is in the probe and the Moon is planetshine; on the Moon the
  ground is in the probe and the Earth is planetshine; far out every body is planetshine.
- **Lens flare**: a 7-blade aperture starburst (14 chromatic diffraction spikes, theta^-2 along, plus a
  (1 + (theta/c)^2)^-1.5 veiling-glare halo, a pure power law with no window) and four soft chromatic ghosts on
  the line through the image centre. Each profile is normalised numerically over the whole sphere outside the
  disc: total energy `FLARE_TOTAL_ENERGY` = 0.436 % of the illuminance at the lens. Geometry: the starburst is
  drawn over the whole frame (one fullscreen quad); each ghost on the screen-space bounding box of its cone
  (`coneNdcBounds`: 48 rim directions projected, + 1.5 px for the jitter), so no profile is ever cut by its quad
  at any sun position. Source = sun illuminance x the atmosphere's transmittance at the camera x visible disc
  fraction x 'clouds.screen'.a at the sun where a cloud is in front x the lens hood's transmission, computed on
  the GPU in `preTransparent` (no readback). Visible fraction: 64 Vogel samples over the disc, tested against
  'scene.depth' where they fall on screen and against the frame bodies' reference spheres where they do not (a
  camera below a body's datum skips that body); off screen the cloud term is read at the nearest edge pixel.
  Lens hood: rectangular, matched to the frame, `HOOD_DEPTH` = 2 entrance-pupil diameters deep: a sun outside
  the frame lights the part of the pupil the hood does not shadow (circular segment per axis, product of the two
  axes), so the glare fades out from the frame edge to 0.5 in tangent beyond it (11 deg at a 60 deg / 16:9
  frame) instead of ending when the disc leaves the frame. Nothing is added over the disc itself. Off for
  `CameraState.kind === 'interior'`. Through `applyAtmosphere` at distance 0 (exactly neutral: the flare forms
  in the lens). `flareRadiance` is the CPU model of the same image; the flare specs compare the GPU against it
  pixel by pixel.
- **What the glare looks like on screen**: the HDR halo is the power law out to the far side of the frame (GPU =
  model per pixel, see 5). In the display image it still appears to end at a radius, because the core's AgX
  tonemap has a toe: its log encoding starts 12.5 stops below middle grey and the contrast curve reaches 0 just
  above that, so a theta^-3 tail fades to black over a short range of radii. That radius moves with the exposure
  (theta ~ exposure^(1/3)): the 8-bit glare (median over the upper half) reaches 3/255 at 225 px at EV 12 and
  at 400 px at EV 9 (`flare-deep-space-ev12.png` against `flare-deep-space-ev9.png`, where it veils the whole
  frame), as a real glare does; it is not a fixed sprite edge.
- **Additive cap**: every additive write (stars, impostors, each flare term) is capped at 500 (pre-exposed,
  about 2,800 x mid-grey, far above display white): blending cannot clamp, and over a solar-disc pixel at 60,000
  a full-strength stack would overflow rgba16float to Inf. Worst stack is 64,000.

## 4. How to run and verify

All through the gate (`node tools/dev/heavy.mjs --class=cpu|gpu -- ...`):

```
npm run typecheck:paths -- src/render/sky labs/sky tests/browser/sky tests/unit/sky
npx vitest run src/render/sky tests/unit/sky tools/dev/boundaries.test.ts         # 47 tests (cpu)
npx playwright test tests/browser/sky --project=functional                        # 23 specs, 2.8 min (gpu)
npx playwright test tests/browser/sky --project=perf                              # 1 spec, GPU lock (gpu)
```

Lab: `/labs/sky/` (query: `scene=`, `sky=0`, `parts=-stars,-milkyWay,-sun,-impostors,-probe,-flare`,
`probeAlbedo=mean`, `planet=0`, `maps=tileset|none|lambert`, `spheres=1` (+`spacing=`), `clouds=1`, `valt=<m>`,
`ground=<m>` (with `valt`: ground elevation under the vessel; the read-outs' radar altitude follows and a lab
ground cap is drawn there), `mwSize=<n>` (Milky Way face size in VRAM), `night=1`, `heavy=<n>`, `hud=0`, plus
every createLabApp parameter). `window.__sky`: `sky` (the feature), `setSunDirection`,
`setSunForVessel('night' | { elevationDeg, azimuthDeg, fromCamera? })`, `setVesselAltitude(h, groundAltitude = 0)`,
`lookAtRaDec(ra, dec, fov?, position?)`, `lookFrom`, `projectDir`, `setCloudCover(on)` (synthetic opaque
'clouds.screen'), `setHeavy(n)`, `referenceScene()`, `flareGeometry()`, `cpu.{referenceRadiance, projectSh,
bruteForceIrradiance, shIrradiance, flareRadiance, ndcDirection}`. `clouds=1` is a lab stand-in for the cloud
renderer (not shipped): it publishes the Earth's real coverage map with the far cloud term (optical depth 20) and
draws the layer as a thin translucent shell with the probe's cloud model, so the backdrop shows the clouds the
probe sees. `ground=` is likewise lab-only: a body-fixed spherical cap (regolith, or terrain on a body with an
atmosphere, of the body's mean colour) standing for the terrain renderer at a site below the datum, where the
LabPlanet sphere is above the camera and not drawn.

## 5. Acceptance criteria, measured

RTX 5090, Chrome headless, 1280 x 720 unless stated; 2026-11-10 (review fixes re-measured 2026-11-11), other
agents' jobs on the machine. Rows marked "review finding" were added by the review round (section 11).

| Criterion | Result | Spec |
|---|---|---|
| Sirius, Canopus, Polaris, Orion's belt, Southern Cross at the projected pixel (camera at ROOT origin, literature J2000 coordinates, stars off-centre) within 1 px | centroid errors 0.000-0.005 px for all 10 stars | `stars.spec.ts` |
| Milky Way band crosses the expected constellations | Sagittarius 5.9e-4, Carina 1.1e-3, Crux 1.0e-3, Cygnus 3.8e-4, Cassiopeia 3.8e-4 cd/m^2 vs galactic poles 4.9e-5 / 3.9e-5 and Ursa Major 3.6e-5 (ratios 12 / 23 / 21 / 7.7 / 7.6); `milky-way-band-ev-3.png` | `stars.spec.ts` |
| Integrated luminance of an isolated star = E / Omega_px x exposure within 5 % | Sirius on axis 1.0007, Sirius 14 deg off axis 1.0000, Rigel 1.0004, a V 4.75 star 1.0006 | `stars.spec.ts` |
| At EV100 14-15 no star exceeds 1/255 after tonemapping | sunlit Earth (lab cloud layer) meters to EV 14.4; at EV 14 and at EV 15 all stars + Milky Way change no display pixel (max difference 0/255, static floor 0) | `stars.spec.ts` |
| In Earth's shadow at the dark-adapted exposure the 100 brightest stars are visible and the Milky Way faintly | LEO night meters EV -2.9 (floor); 99 of the 100 brightest in view across 8 views (one behind the Earth or Moon), faintest peak 72/255, median 162/255; Milky Way 2.1 (galactic centre), 5.3 (Crux), 1.0 (Cygnus) vs 0.1-0.2 at the poles (8-bit mean of a 60 px window) | `stars.spec.ts` |
| Stars do not influence auto-exposure | settled EV 11.5641 with, 11.5672 without (re-run: 11.5648 / 11.5676; by construction: the meter skips depth == 0) | `stars.spec.ts` |
| Sun disc subtends 0.533 deg | 0.5379 deg measured = 2 x angular radius at the FakeSim's date (0.99 AU) exactly; 0.533 at 1 AU | `sun.spec.ts` |
| Darker limb, mean within 5 % of 1.9e9 cd/m^2 x exposure | mean 1.8816e9 vs E / (pi sin^2) 1.8839e9 (ratio 0.9988); integrated 130,361 vs 130,405 lux; centre 7428.7 vs model 7431.0; L(0.9 R) / L(centre) 0.6710 vs model 0.6711; `sun-disc-limb-darkening-filter.png` | `sun.spec.ts` |
| EV100 -3: exactly HDR_MAX, nanPixels 0 | HDR target max 60000, NaN 0 (8 frames, flare on); resolved max 59680, NaN 0 | `sun.spec.ts` |
| Body shrinking 20 px -> 0.5 px keeps its flux within 10 % through the cross-fade | Earth backdrop as a Lambert sphere of the body's geometric albedo (`maps=lambert`), phase 50 deg, HDR flux over 16 jitter frames / Lambert-sphere value: 1.016-1.026 as geometry (its small GGX lobe), 1.025 / 1.013 / 1.009 / 1.002 through the fade (weights 0.12 / 0.44 / 0.75 / 0.95), 0.999-1.000 as impostor, 1.016 at 0.5 px; step-to-step change at most 1.4 % | `impostor.spec.ts` |
| Probe SH9 irradiance in LEO matches a brute-force integration within 10 %; Earth- vs space-facing ratio | probe / brute force: Earth-facing 0.976, horizontal 0.986-0.988, 45 deg down 1.007; probe vs CPU SH projection within 0.5 %; space-facing exact irradiance 0 and SH9 negative there (clamped to 0, as the core does): ratio "infinite" both ways (brute force 2e13, probe 2e13) | `probe.spec.ts` |
| Probe energy responds to day / night side and altitude | Earth-facing irradiance: day 200 km 2.73e4 lux (brute 2.79e4), night 3.7e-5 lux, 2000 km 1.66e4 (1.65e4), 6000 km 7.27e3 (7.01e3), 12,742 km 1.42e3 (1.35e3; Earth weight 0.5, the other half is the core's planetshine), 20,000 km 5.9e-4 (Earth weight 0: planetshine only) | `probe.spec.ts` |
| Probe at a landing site below the datum (review finding; the mission's lunar site is at -1907.8 m) | ground-facing SH9 irradiance (sun 35 deg up, mean colours): +30 m over the datum 8625 lux; descending over the site's ground: +2500 m 8532, +1000 m 8547, +1 m 8547, -1 m 8547 (no step through the datum), -1000 m 8577, landed (origin 3 m above the ground) 8633 lux; each within 0.1-1 % of the brute force of the same scene (before the fix: 8.5e-4 lux below the datum); CPU reference landed / +30 m within 2 % (unit) | `probe.spec.ts`, `probeScene.test.ts` |
| Flare vanishes when a synthetic cloud layer covers the sun | cloud transmittance at the sun 0.000, flare contribution max 0 (HDR flare on - off) | `flare.spec.ts` |
| Flare energy under 1 % of the source | on screen 0.393 % of the sun's illuminance with the sun 6 deg off axis (design total 0.436 %); visible fraction 1.0 / 0.5 / 0.0 with the sun centre 1 deg above / on / 1 deg below the Earth's limb, flare 0.409 / 0.205 / 0 %; off for an interior camera; sun 1 deg outside the frame and 1 deg below the limb: visible 0 (body test), flare 0 | `flare.spec.ts` |
| Flare not cut by its geometry anywhere (review finding) | GPU image (flare on - off) against the CPU model of the whole-sphere flare (`flareRadiance`), every pixel where the model exceeds 1e-3 pre-exposed (273k-446k px), sun 6 / 25 / 35 / 44 deg off axis (half-field 45.7 deg): on-screen energy 0.3930 / 0.3920 / 0.3910 / 0.3461 % vs model 0.3931 / 0.3921 / 0.3912 / 0.3462 %, largest per-pixel difference 0.13 / 0.21 / 0.71 / 0.36 %; the 25-35 deg cases keep the energy of the 6 deg case within 0.5 %; `flare-off-axis-35deg-ev12.png` (round / elliptical ghosts, spikes and glow to the frame edges) | `flare.spec.ts` |
| Glare fades as the sun leaves the frame (review finding) | 0.1 deg steps from 0.5 deg inside to 0.5 deg outside the edge: 0.279 / 0.267 / 0.252 / 0.240 / 0.232 / 0.223 / 0.206 / 0.190 / 0.183 / 0.173 / 0.160 % (largest step 7.8 %, the halo core leaving the frame; before: 100 % at 0.27 deg); then +1 / +3 / +6 / +9 deg: 0.105 / 0.046 / 0.021 / 0.006 % (hood 0.97 / 0.84 / 0.53 / 0.18), 0 beyond the hood's cut-off at +11.0 deg; GPU = model within 0.4 % at every step; `flare-sun-just-outside-frame-ev12.png` | `flare.spec.ts` |
| Static-camera frame difference with TAA is zero for stars | **Not met as stated** (see 6.1): the feature's output is exactly constant (HDR target, no jitter: max difference 0); through the core's TAA the resolved stars follow the 8-phase jitter cycle: 0.82 % mean, 7.5-10.2 % max relative change between consecutive frames, 2.8-3.5 % max between frames 8 apart (static camera, deterministic, frames stepped synchronously; two runs). Request sky-lighting-1, still open | `stars.spec.ts` |
| Scintillation only inside an atmosphere, growing with air mass | pad at night: 13.4 % relative flux std at 72 deg elevation, 41.7 % at 11.6 deg; mean / unmodulated 0.98 / 0.93 over 6 s; in space the HDR frame difference is 0 | `scintillation.spec.ts` |
| Perf (1440p internal, quality 1, attribution mode, ~8 ms ballast) | background p99 **0.0127 ms** (budget 0.08, sky 53 % of the frame), probe amortised **0.022 ms** (face 0.011 + mips 0.002 + prefilter 0.009; p99 of any step 0.029; budget 0.08), flare p99 **0.0333 ms** (vis 0.005 + transparent 0.028, the starburst now covering the whole frame; budget 0.04), sum **0.068 ms** (line 0.2 / 0.3 in orbit); feature row 'sky' p99 0.075 ms | `sky.perf.spec.ts` |
| expectNoErrors everywhere | yes, every spec | all |

Reviewed screenshots (`out/screens/sky/`, all looked at): `starfield-deep-space-ev-5.png` (galactic centre
with dust lanes), `orion-closeup-ev-5.png`, `crux-centaurus-ev-5.png` (Coalsack, omega Centauri, alpha/beta
Centauri), `milky-way-band-ev-3.png`, `orientation-*.png`, `sun-at-earth-limb-leo-flare.png` (sun 7 deg above
the limb from 200 km, lit cloud band below the limb, 14-spike starburst, faint ghosts), `flare-deep-space-ev12.png`,
`sun-disc-limb-darkening-filter.png`, `sun-ev-3-saturated.png`, `crescent-earth-approach-sheet.png` (phase
125 deg at 16,000 / 6,400 / 3,200 / 1,900 / 1,200 / 600 / 384 Mm = 0.5 / 1.2 / 2.5 / 4.2 / 6.6 / 13.2 / 20.7 px,
exposure compensated for distance), `crescent-earth-lunar-distance.png`, `pbr-spheres-leo-day.png` (Earth-
facing halves lit by the cloudy Earth, space-facing halves black, chrome reflecting Earth and space),
`pbr-spheres-leo-night.png` (moonlight only), `pbr-spheres-lunar-surface.png` (now at the mission's landing site,
1907.8 m below the datum, on the lab ground cap: regolith bounce on the spheres' undersides, the chrome sphere
reflecting the ground below and black sky above), `leo-day-stars-invisible.png`, `leo-night-dark-adapted.png`,
`perf-1440p-leo-horizon.png`; added by the review round: `flare-off-axis-35deg-ev12.png`,
`flare-sun-just-outside-frame-ev12.png`, `flare-deep-space-ev9.png`, `starfield-deep-space-ev-5-mw2048.png`,
`orion-closeup-ev-5-mw2048.png` and the 3 x crops `milky-way-1024-vs-2048-*-crop-3x.png` (left 1024, right 2048).

## 6. Deviations from the brief and decisions

1. **"Frame difference zero for stars with TAA"**: the sky writes an exactly constant image; the core's TAA
   resolve (3 x 3 reconstruction with w = exp(-2.29 d^2), tonemap-space temporal blend) turns any point source
   into a signal that follows the jitter cycle. Computed: the per-frame reconstruction of a sigma 0.7 px PSF
   varies 48 % at its rim (22 % even at sigma 1.2 px), so no PSF choice fixes it. The same resolve keeps only
   25 % of the flux of a 1.4 px wide sunlit crescent (6.6 px Earth at phase 125 deg), 69-79 % at 13 px, 89 % at
   21 px, while the PSF impostors keep 99-100 %: in the display image the impostor-to-geometry hand-over of a
   crescent shows a brightness drop although the HDR flux is continuous within 3 %. Both filed as
   `docs/requests/sky-lighting-1.md` (core-support, non-blocking), still open after the review round: the
   package is not fully accepted on this criterion until it is resolved. When the core change lands,
   `stars.spec.ts` 'static camera' must be tightened to the criterion (resolved frame difference 0, or the
   tolerance the resolution states; today it asserts mean < 3 %, max < 15 %) and the crescent sheet's logged kept
   fraction turned into an assertion (above 90 % from 6.6 px), as the request proposes.
2. **`createSkyFeature(options)`** instead of `createSkyFeature(ctx)`: features receive the RenderContext in
   `init`; the factory runs before the renderer exists in the lab app and in the app shell.
3. **Impostors are drawn in `drawTransparent`**, not `drawBackground` (ARCHITECTURE 10.0 lists them under
   background): a cross-fade with the body's geometry has to replace geometry pixels, which the background pass
   (depth == 0 only) cannot touch. They go through `applyAtmosphere` like every transparent.
4. **Impostor flux is the Lambert sphere of BodyDef.render (as the brief says)**, so the cross-fade is
   flux-continuous only where the rendered body integrates to its `geometricAlbedo` with a Lambert-like phase
   curve. Measured with a Lambert backdrop (above). Not measured, estimated: the real Moon (and the Hapke
   regolith that approximates it) is several times darker than a Lambert sphere at quadrature (the observed
   quarter Moon is about 1/10 of full, Lambert gives 1/pi), and the Earth's geometric albedo 0.434 includes
   clouds and atmosphere, so a bare albedo-map Earth (the lab without them) is roughly half as bright as its
   impostor. In this mission impostors appear only in the map view near its 2e9 m zoom limit (Moon 2.2 px,
   Earth 8 px at 1440p, 60 deg).
5. **The probe holds while the camera is more than 50 km from the vessel** (map view): the sky-view table is
   computed at the camera; evaluating the probe at the vessel with it would be wrong. It resumes and ramps over
   one cycle when the camera returns.
6. **Bodies carried by the core's planetshine are scaled out of the probe** (weight 1 - w, section 3), so no
   light is counted twice. The hand-over between probe and planetshine at 2-4 R is continuous only if the
   body's rendered appearance integrates to its geometricAlbedo (the same caveat as item 4).
7. **The 0.533 deg check** uses the disc's angular radius at the scene's real Sun distance (0.5379 deg on the
   FakeSim date); 0.533 deg holds at 1 AU (unit test).
8. **"Crescent Earth as a point from lunar distance"**: at true scale the Earth is 20.7 px across from lunar
   distance at 60 deg / 720 p (34 px at 1440 p), never a point. The sheet runs from 16,000 Mm (0.5 px) to
   lunar distance (20.7 px).
9. **Daylight-exposure check on a pure-sky frame**: in a lab frame with the Earth, other effects (TAA history
   near the limb) change about 1,800 pixels by more than 1 level between identical frames even with the sim
   paused and jitter off, which would mask the stars' contribution. The sky frame is exactly static (floor 0);
   the Earth scene is still used to show that a sunlit Earth meters to EV 14.4.
10. **Additive cap 500** on stars / impostors / flare terms and **no flare over the disc** (section 3): without
    them EV -3 gave a max of 62,560 (ghosts collapse onto the sun on the optical axis) and an Inf was possible.
11. **Scintillation strength** (zenith variance 0.03, turbulence thinning with the Rayleigh scale height) is a
    physical constant in `photometry.ts`, applied to any body with an atmosphere; there is no per-body field for
    turbulence in `AtmosphereRenderDef`.
12. **VRAM**: the Milky Way cube at full resolution (2048^2 x 6 x 12 mips rgb9e5) is 134 MB. The feature now
    uploads the chain from 1024 per face by default (34 MB; the sky in total about 41 MB with albedo maps, probe
    and stars), within the 0.1 GB "sky" item of ARCHITECTURE 17. Cost, from the comparison views: invisible at a
    70 deg field (mean display difference 0.04 / 255), plain in a 24 deg close-up (1.26 / 255: the faint
    background stars below the catalogue's V 6.5 become soft blobs; the catalogue stars are PSFs and unaffected).
    Every acceptance number is unchanged (Milky Way band, dark-adapted visibility). `milkyWayFaceSize: 2048`
    restores the full cube; request sky-lighting-2 asks the lead whether to raise the line and ship it.
13. **Lens hood and off-screen sun** (review round): `HOOD_DEPTH` = 2 pupil diameters is a lens-design
    constant like the blade count, not a brightness knob: it sets how far beyond the frame edge the glare
    persists (to 0.5 in tangent, 11 deg at 60 deg / 16:9). Off-screen disc samples are tested against the frame
    bodies' reference spheres; geometry that is not a body (vessels, terrain above the datum, clouds beyond the
    edge pixel) cannot be seen off screen and does not hide an off-screen sun.

## 7. Known weaknesses (plainly)

- The TAA items of 6.1 (core-side; request open).
- The flare is analytic and of one lens design (7 blades, four ghosts); ghosts are round (elliptical off axis
  by projection), not aperture-shaped; no flare from other bright sources (glints, the Moon). Cockpit window
  glare is not done here (interior cameras get no flare at all). The fullscreen starburst costs 0.028 ms at
  1440p (flare 0.033 of its 0.04 ms budget). A sun just outside the frame is hidden only by bodies (section 6.13).
- In the display image the glare halo still fades to black at a finite radius: the AgX toe, not the profile
  (section 3); at the exposure of the LEO limb view the visible glow reaches about 0.3 rad from the sun.
- The probe's ground sphere comes from the radar altitude under the vessel: a single sphere through that point.
  In a crater the walls above the vessel are not in the probe (the sky is), so the bounce from crater walls is
  missing; over a slope the ground is treated as level.
- The probe sees bodies as smooth spheres with their low-resolution albedo maps: no terrain relief, no night
  lights, no ocean glint, no clouds' own shadows on the ground under them beyond the far cloud term; the sky-view
  table is assumed to hold in-scatter only (no clouds): from below a cloud deck the probe models the deck itself
  from the coverage map. Only the first 4 bodies of the snapshot (the frame uniforms' limit) are in it.
- SH9 band limit: on a 45 deg upward normal in LEO the probe gives 11 % more than the exact irradiance (1,274 vs
  1,147 lux, against 20,000 lux facing the Earth); straight up it gives a negative value that the core clamps.
- Probe latency: a change reaches the published probe within one to two cycles (12-24 frames, a ramp); under
  rails warp the lighting lags the sun by that time.
- Impostor shape is a round Gaussian; a crescent at 3-6 px cross-fades from a round blob into the crescent.
- Scintillation noise is a 6 Hz smoothed process; the TAA history (about 10 frames) smooths it further, so
  twinkling is gentler than the eye sees, but its statistics are as modelled before TAA.
- The lab's Earth (LabPlanet, no atmosphere) is darker than the real Earth from orbit; the LEO screenshots use
  the lab cloud layer stand-in. Integration with the atmosphere-clouds feature (which attenuates the background
  and provides the sky-view in-scatter the probe uses) was not run here: render packages do not import each
  other; the lead integrates.
- Perf idle numbers (GPU otherwise idle, low clocks) are 2-15 x the loaded ones and noisy (background 0.19-0.40,
  flare up to 0.8 ms p99); the budget numbers are with the ballast, as in render-core.

## 8. Data notes

- `data/sky` is used as the bake describes it (manifest validated, file sizes checked against a full mip chain,
  catalogue records validated). Sirius record 0 at RA 101.28721, Dec -16.71612; the cube's orientation is
  confirmed independently by `skyData.test.ts` (galactic centre / poles / Cygnus from the level-5 faces).
- Albedo maps: `/tiles/index.json` first (no 404s), then each tile set's `globals.albedoLowRes`.

## 9. Requests

- Filed: `docs/requests/sky-lighting-1.md` (core-support, `src/render/core/post/postProcess.ts`, TAA energy of
  thin bright features and static convergence; non-blocking; still open after the review round).
- Filed: `docs/requests/sky-lighting-2.md` (lead, ARCHITECTURE 17 VRAM "sky" line: keep 0.1 GB with the 1024
  Milky Way default, or raise to 0.15 GB and ship the 2048 cube; non-blocking; open).
- Against this package's paths: none.

## 10. For the packages that build on this

- **App shell (lead)**: register `createSkyFeature()` once; nothing else to wire. It loads `/sky/*` and the
  tile sets' `albedoLowRes` itself and reports `isIdle()` false until a probe has been built from all data.
- **atmosphere-clouds**: the background (Milky Way, sun disc, stars) is drawn before your composite and must be
  attenuated by it; impostors and flare come after it and apply `applyAtmosphere` / the transmittance table
  themselves. The probe reads 'atmosphere.skyViewLut' (in-scatter around the camera, any altitude),
  'atmosphere.transmittanceLut', 'atmosphere.skyIrradianceLut', 'clouds.coverageMap' and `frame.cloudFar`; the
  flare reads 'clouds.screen'.a and 'clouds.depth' at the sun.
- **vehicle / cockpit**: standard materials are lit by 'env.sh9' and 'env.probeCube' from the vessel's position;
  an interior should not let the probe light its walls (cockpit-2 discusses how).
- **terrain-render**: nothing to do; distant bodies under 6 px are replaced by impostors over your geometry
  automatically (by depth), so your far LOD may stay as it is.

## 11. Review round (2026-11-11)

| Finding | Severity | What was done |
|---|---|---|
| Probe loses the ground below the datum (lunar site at -1907.8 m; floating capsule under sea level) | major | Fixed: `probeGroundSphere` (section 3), GPU and CPU reference alike; `hitSphere` takes the origin radius from the float64 height. Probe spec over a descent from +2500 m to landed at the site (8532-8633 lux vs 8625 at +30 m; continuous through the datum), unit tests (orbit unchanged, continuity in 0.25 m steps, CPU reference landed vs +30 m within 2 %), `pbr-spheres-lunar-surface` redone at the site height on a lab ground cap (`ground=`; FakeSim clamps surface scenes to 30 m above the datum, so the lab moves the vessel and sets the radar altitude). |
| Flare quads sized with the on-axis image scale clip the flare off axis | major | Fixed: starburst drawn over the whole frame, ghosts on the projected bounding box of their cones (+1.5 px). Spec: GPU image = CPU whole-sphere model per pixel (max 0.71 %) with the sun 6 / 25 / 35 / 44 deg off axis and through the frame edge; energy at 25-35 deg equals the 6 deg case within 0.5 %. Unit tests of the cone bounds (contain every cone direction, tight within 1 %) and ghost supports. Stale "6 spikes / hexagonal aperture" comments corrected. Flare cost rose from 0.016 to 0.033 ms (budget 0.04). |
| Glare pops off when the disc leaves the frame; halo windowed to a rim at 0.35 rad | minor | Fixed: off-screen disc samples tested against the frame bodies instead of counting as hidden; the lens hood fades the source over 11 deg beyond the edge; halo and spikes unwindowed (normalised over the sphere). Spec: 0.1 deg steps across the edge change the on-screen glare by at most 7.8 % (was 100 %), monotonic fall to 0 at the hood cut-off; a sun just off screen behind the Earth's limb gives no glare. The remaining display "edge" is the AgX toe and moves with exposure (section 3). |
| TAA star stability criterion not met | minor | Not fixable in this package (core TAA resolve). Request sky-lighting-1 still open; `postProcess.ts` has not changed since it was filed. The follow-up (tighten `stars.spec`, assert the crescent's kept fraction) is written into 6.1 for when it lands. |
| Sky over its 0.1 GB VRAM line | minor | Fixed by default: Milky Way chain uploaded from 1024 per face (sky about 41 MB); `milkyWayFaceSize` keeps the full cube available; comparison views and request sky-lighting-2 to the lead for the final call (6.12). |
