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
src/render/sky/probeScene.ts   probe scene in float64 (bodies, planetshine weights) + CPU reference (brute force, SH)
src/render/sky/photometry.ts   PSF, disc, Lambert sphere, impostor fade, air mass, scintillation, cloud two-stream, SH, cube maths
src/render/sky/flare.ts        flare terms and their numeric normalisation
src/render/sky/skyData.ts      SkyManifest validation, star catalogue parsing, rgb9e5 layout / decoding
src/render/sky/shaders.ts      all WGSL
labs/sky/                      lab page (main.ts, world.ts: sun / vessel-altitude overrides)
tests/unit/sky/                vitest (photometry, sky data against data/sky, probe weights + CPU reference)
tests/browser/sky/             Playwright: stars, sun, impostor, probe, flare, scintillation, views, sky.perf
docs/requests/sky-lighting-1.md   request to core-support (TAA resolve), open
```

## 2. Public API (exact signatures)

```ts
// '@/render/sky'
createSkyFeature(options?: SkyFeatureOptions): SkyFeature
interface SkyFeatureOptions extends Partial<SkyParts> {
  id?: string;                              // default 'sky' (prefix of passes and perf rows)
  order?: number;                           // default 0
  probeAlbedo?: 'tileset' | 'meanColor';    // probe body colour: albedoLowRes where baked (default), or BodyDef meanColor
}
interface SkyParts { stars: boolean; milkyWay: boolean; sun: boolean; impostors: boolean; probe: boolean; flare: boolean }
interface SkyFeature extends RenderFeature {
  readonly parts: SkyParts;                  // mutable switches (all true by default; labs use them for A/B readbacks)
  status(): SkyStatus;                       // { manifest, starsLoaded, milkyWayLoaded, error, flareDrawn }
  stars(): StarCatalogue | null;             // parsed stars.f32 (records: STAR_RECORD_FLOATS per star)
  impostors(): ImpostorInfo[];               // last frame: { bodyId, diameterPx, weight, illuminance (lux), sigmaPx }
  probe(): ProbeState;                       // { completed, step, holding, scene, albedoMaps }
  readProbeSh(): Promise<number[][]>;        // published SH9 irradiance coefficients, 9 x rgb, lux
  readProbeFace(face: number, mip?: number): Promise<{ size: number; data: Float32Array }>;
  readFlareState(): Promise<FlareStateInfo>; // { visible, cloud, inView, transmittance }
}
```

Also exported: everything in `photometry.ts` (e.g. `starPeakLuminance`, `discMeanLuminance`,
`lambertSphereIlluminance`, `impostorWeight`, `chapman`, `scintillationVariance`, `shBasis`, `shIrradiance`,
`cubeTexelDirection`, `raDecToDir`), `probeSceneOf`, `planetshineWeights`, `referenceRadiance`, `projectSh`,
`bruteForceIrradiance`, `clipOfDirection`, `PROBE_SIZE` (64), `PROBE_MIPS` (5), `PROBE_CYCLE` (12),
`PROBE_MAX_CAMERA_OFFSET` (50 km), `FLARE_TOTAL_ENERGY`, the sky-data helpers.

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
- **Milky Way**: the rgb9e5ufloat cube (2048^2, 12 mips) sampled along the jitter-free view ray of each sky pixel,
  x `luminanceScale` x exposure, in the same fullscreen pass as the sun disc.
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
- **No double counting with planetshine**: the core lights vessels with planetshine from bodies beyond 2-4 R
  (smoothstep weight w). The probe carries each body with weight `1 - w` computed with the core's own receiver
  rule (`planetshineWeights`): in LEO the Earth is in the probe and the Moon is planetshine; on the Moon the
  ground is in the probe and the Earth is planetshine; far out every body is planetshine.
- **Lens flare**: a 7-blade aperture starburst (14 chromatic diffraction spikes, theta^-2 along, plus a
  (1 + (theta/c)^2)^-1.5 glare halo, smoothly windowed to zero at 0.35 rad) and four soft chromatic ghosts on the
  line through the image centre. Each profile is normalised numerically over the drawn domain: total energy
  `FLARE_TOTAL_ENERGY` = 0.436 % of the illuminance at the lens. Source = sun illuminance x the atmosphere's
  transmittance at the camera x visible disc fraction (64 Vogel samples of 'scene.depth' over the disc; off-
  screen counts as hidden) x 'clouds.screen'.a at the sun where a cloud is in front, computed on the GPU in
  `preTransparent` (no readback). Nothing is added over the disc itself. Off for `CameraState.kind ===
  'interior'`. Through `applyAtmosphere` at distance 0 (exactly neutral: the flare forms in the lens).
- **Additive cap**: every additive write (stars, impostors, each flare term) is capped at 500 (pre-exposed,
  about 2,800 x mid-grey, far above display white): blending cannot clamp, and over a solar-disc pixel at 60,000
  a full-strength stack would overflow rgba16float to Inf. Worst stack is 64,000.

## 4. How to run and verify

All through the gate (`node tools/dev/heavy.mjs --class=cpu|gpu -- ...`):

```
npm run typecheck:paths -- src/render/sky labs/sky tests/browser/sky tests/unit/sky
npx vitest run src/render/sky tests/unit/sky tools/dev/boundaries.test.ts         # 35 tests (cpu)
npx playwright test tests/browser/sky --project=functional                        # 20 specs, 2.3 min (gpu)
npx playwright test tests/browser/sky --project=perf                              # 1 spec, GPU lock (gpu)
```

Lab: `/labs/sky/` (query: `scene=`, `sky=0`, `parts=-stars,-milkyWay,-sun,-impostors,-probe,-flare`,
`probeAlbedo=mean`, `planet=0`, `maps=tileset|none|lambert`, `spheres=1` (+`spacing=`), `clouds=1`, `valt=<m>`,
`night=1`, `heavy=<n>`, `hud=0`, plus every createLabApp parameter). `window.__sky`: `sky` (the feature),
`setSunDirection`, `setSunForVessel('night' | { elevationDeg, azimuthDeg, fromCamera? })`, `setVesselAltitude`,
`lookAtRaDec(ra, dec, fov?, position?)`, `lookFrom`, `projectDir`, `setCloudCover(on)` (synthetic opaque
'clouds.screen'), `setHeavy(n)`, `referenceScene()`, `cpu.{referenceRadiance, projectSh, bruteForceIrradiance,
shIrradiance}`. `clouds=1` is a lab stand-in for the cloud renderer (not shipped): it publishes the Earth's real
coverage map with the far cloud term (optical depth 20) and draws the layer as a thin translucent shell with the
probe's cloud model, so the backdrop shows the clouds the probe sees.

## 5. Acceptance criteria, measured

RTX 5090, Chrome headless, 1280 x 720 unless stated; 2026-11-10, other agents' jobs on the machine.

| Criterion | Result | Spec |
|---|---|---|
| Sirius, Canopus, Polaris, Orion's belt, Southern Cross at the projected pixel (camera at ROOT origin, literature J2000 coordinates, stars off-centre) within 1 px | centroid errors 0.000-0.005 px for all 10 stars | `stars.spec.ts` |
| Milky Way band crosses the expected constellations | Sagittarius 5.9e-4, Carina 1.1e-3, Crux 1.0e-3, Cygnus 3.8e-4, Cassiopeia 3.8e-4 cd/m^2 vs galactic poles 4.9e-5 / 3.9e-5 and Ursa Major 3.6e-5 (ratios 12 / 23 / 21 / 7.7 / 7.6); `milky-way-band-ev-3.png` | `stars.spec.ts` |
| Integrated luminance of an isolated star = E / Omega_px x exposure within 5 % | Sirius on axis 1.0007, Sirius 14 deg off axis 1.0000, Rigel 1.0004, a V 4.75 star 1.0006 | `stars.spec.ts` |
| At EV100 14-15 no star exceeds 1/255 after tonemapping | sunlit Earth (lab cloud layer) meters to EV 14.4; at EV 14 and at EV 15 all stars + Milky Way change no display pixel (max difference 0/255, static floor 0) | `stars.spec.ts` |
| In Earth's shadow at the dark-adapted exposure the 100 brightest stars are visible and the Milky Way faintly | LEO night meters EV -2.9 (floor); 99 of the 100 brightest in view across 8 views (one behind the Earth or Moon), faintest peak 72/255, median 162/255; Milky Way 2.1 (galactic centre), 5.3 (Crux), 1.0 (Cygnus) vs 0.1-0.2 at the poles (8-bit mean of a 60 px window) | `stars.spec.ts` |
| Stars do not influence auto-exposure | settled EV 11.5641 with, 11.5672 without (by construction: the meter skips depth == 0) | `stars.spec.ts` |
| Sun disc subtends 0.533 deg | 0.5379 deg measured = 2 x angular radius at the FakeSim's date (0.99 AU) exactly; 0.533 at 1 AU | `sun.spec.ts` |
| Darker limb, mean within 5 % of 1.9e9 cd/m^2 x exposure | mean 1.8816e9 vs E / (pi sin^2) 1.8839e9 (ratio 0.9988); integrated 130,361 vs 130,405 lux; centre 7428.7 vs model 7431.0; L(0.9 R) / L(centre) 0.6710 vs model 0.6711; `sun-disc-limb-darkening-filter.png` | `sun.spec.ts` |
| EV100 -3: exactly HDR_MAX, nanPixels 0 | HDR target max 60000, NaN 0 (8 frames, flare on); resolved max 59680, NaN 0 | `sun.spec.ts` |
| Body shrinking 20 px -> 0.5 px keeps its flux within 10 % through the cross-fade | Earth backdrop as a Lambert sphere of the body's geometric albedo (`maps=lambert`), phase 50 deg, HDR flux over 16 jitter frames / Lambert-sphere value: 1.016-1.026 as geometry (its small GGX lobe), 1.025 / 1.013 / 1.009 / 1.002 through the fade (weights 0.12 / 0.44 / 0.75 / 0.95), 0.999-1.000 as impostor, 1.016 at 0.5 px; step-to-step change at most 1.4 % | `impostor.spec.ts` |
| Probe SH9 irradiance in LEO matches a brute-force integration within 10 %; Earth- vs space-facing ratio | probe / brute force: Earth-facing 0.976, horizontal 0.986-0.988, 45 deg down 1.007; probe vs CPU SH projection within 0.5 %; space-facing exact irradiance 0 and SH9 negative there (clamped to 0, as the core does): ratio "infinite" both ways (brute force 2e13, probe 2e13) | `probe.spec.ts` |
| Probe energy responds to day / night side and altitude | Earth-facing irradiance: day 200 km 2.73e4 lux (brute 2.79e4), night 3.7e-5 lux, 2000 km 1.66e4 (1.65e4), 6000 km 7.27e3 (7.01e3), 12,742 km 1.42e3 (1.35e3; Earth weight 0.5, the other half is the core's planetshine), 20,000 km 5.9e-4 (Earth weight 0: planetshine only) | `probe.spec.ts` |
| Flare vanishes when a synthetic cloud layer covers the sun | cloud transmittance at the sun 0.000, flare contribution max 0 (HDR flare on - off) | `flare.spec.ts` |
| Flare energy under 1 % of the source | 0.394 % of the sun's illuminance on screen (design total 0.436 %); visible fraction 1.0 / 0.5 / 0.0 with the sun centre 1 deg above / on / 1 deg below the Earth's limb, flare 0.418 / 0.209 / 0 %; off for an interior camera | `flare.spec.ts` |
| Static-camera frame difference with TAA is zero for stars | **Not met as stated** (see 6.1): the feature's output is exactly constant (HDR target, no jitter: max difference 0); through the core's TAA the resolved stars follow the 8-phase jitter cycle: 0.83 % mean, 10.2 % max relative change between consecutive frames, 3.5 % max between frames 8 apart (static camera, deterministic, frames stepped synchronously). Request sky-lighting-1 | `stars.spec.ts` |
| Scintillation only inside an atmosphere, growing with air mass | pad at night: 13.4 % relative flux std at 72 deg elevation, 41.7 % at 11.6 deg; mean / unmodulated 0.98 / 0.93 over 6 s; in space the HDR frame difference is 0 | `scintillation.spec.ts` |
| Perf (1440p internal, quality 1, attribution mode, ~7 ms ballast) | background p99 **0.0138 ms** (budget 0.08, sky 53 % of the frame), probe amortised **0.021 ms** (face 0.009 + mips 0.003 + prefilter 0.009; p99 of any step 0.033; budget 0.08), flare p99 **0.0155 ms** (vis 0.005 + transparent 0.010; budget 0.04), sum **0.050 ms** (line 0.2 / 0.3 in orbit); feature row 'sky' p99 0.061 ms | `sky.perf.spec.ts` |
| expectNoErrors everywhere | yes, every spec | all |

Reviewed screenshots (`out/screens/sky/`, all looked at): `starfield-deep-space-ev-5.png` (galactic centre
with dust lanes), `orion-closeup-ev-5.png`, `crux-centaurus-ev-5.png` (Coalsack, omega Centauri, alpha/beta
Centauri), `milky-way-band-ev-3.png`, `orientation-*.png`, `sun-at-earth-limb-leo-flare.png` (sun 7 deg above
the limb from 200 km, lit cloud band below the limb, 14-spike starburst, faint ghosts), `flare-deep-space-ev12.png`,
`sun-disc-limb-darkening-filter.png`, `sun-ev-3-saturated.png`, `crescent-earth-approach-sheet.png` (phase
125 deg at 16,000 / 6,400 / 3,200 / 1,900 / 1,200 / 600 / 384 Mm = 0.5 / 1.2 / 2.5 / 4.2 / 6.6 / 13.2 / 20.7 px,
exposure compensated for distance), `crescent-earth-lunar-distance.png`, `pbr-spheres-leo-day.png` (Earth-
facing halves lit by the cloudy Earth, space-facing halves black, chrome reflecting Earth and space),
`pbr-spheres-leo-night.png` (moonlight only), `pbr-spheres-lunar-surface.png` (regolith bounce from below,
black sky above), `leo-day-stars-invisible.png`, `leo-night-dark-adapted.png`, `perf-1440p-leo-horizon.png`.

## 6. Deviations from the brief and decisions

1. **"Frame difference zero for stars with TAA"**: the sky writes an exactly constant image; the core's TAA
   resolve (3 x 3 reconstruction with w = exp(-2.29 d^2), tonemap-space temporal blend) turns any point source
   into a signal that follows the jitter cycle. Computed: the per-frame reconstruction of a sigma 0.7 px PSF
   varies 48 % at its rim (22 % even at sigma 1.2 px), so no PSF choice fixes it. The same resolve keeps only
   25 % of the flux of a 1.4 px wide sunlit crescent (6.6 px Earth at phase 125 deg), 79 % at 13 px, 89 % at
   21 px, while the PSF impostors keep 99-100 %: in the display image the impostor-to-geometry hand-over of a
   crescent shows a brightness drop although the HDR flux is continuous within 3 %. Both filed as
   `docs/requests/sky-lighting-1.md` (core-support, non-blocking, open at hand-off).
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
12. **VRAM**: the Milky Way cube at full resolution (2048^2 x 6 x 12 mips rgb9e5) is 134 MB, plus about 7 MB
    (albedo maps, probe, stars): about 0.14 GB against the 0.1 GB "sky" item of ARCHITECTURE 17. Dropping mip 0
    would bring it to 34 MB at the cost of a 2 x softer Milky Way (2048 per face matches 1440p at 60 deg).

## 7. Known weaknesses (plainly)

- The TAA items of 6.1 (core-side; request open).
- The flare is analytic and of one lens design (7 blades, four ghosts); ghosts are round, not aperture-shaped;
  no flare from other bright sources (glints, the Moon). Cockpit window glare is not done here (interior cameras
  get no flare at all).
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
  thin bright features and static convergence; non-blocking; open at hand-off).
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
