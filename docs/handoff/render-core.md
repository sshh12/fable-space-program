# Hand-off: render-core

Renderer core: device setup on top of `GpuHandle`, the frame graph of ARCHITECTURE 10.0 with scene copies,
bind group 0, the shader library and chunks, G-buffer + deferred lighting (sun, atmosphere transmittance,
eclipses, cloud shadow, sky irradiance, IBL, planetshine, local lights), body-anchored sun shadow cascades,
GTAO + contact shadows, TAA / TAAU with dynamic resolution, bloom, auto-exposure, AgX tonemap, the quality
governor, perf attribution, the mesh system and the lab harness.

**The manual for feature authors is `docs/RENDER_API.md`** (WGSL layouts, hook rules, chunk signatures, mesh
and lab APIs, photometric conventions). This note covers what was built, how to verify it, what was
measured, and what is weak. Section 8 lists what the second review found and what was done about it.

## 1. Where things are

```
src/render/core/index.ts            public API for engine code            (import from '@/render/core')
src/render/core/lab/index.ts        createLabApp, createLabPlanetFeature  (import from '@/render/core/lab')
src/render/core/renderer.ts         createRenderer: frame graph, FrameContext, targets, governor wiring
src/render/core/coreApi.ts          coreOf(ctx): helpers beyond the RenderContext contract
src/render/core/frame/              float64 frame maths (jitter, poses, sun, eclipse, planetshine), uniform packing
src/render/core/shaders/            library (#include, tracked pipelines) and every WGSL chunk
src/render/core/shadows/            cascadeMath.ts (pure float64 planning, receiver fit, scheduler), shadowSystem.ts (GPU)
src/render/core/lighting/           deferred.ts (lighting pass, Hapke table), ao.ts (GTAO + contact shadows)
src/render/core/post/               postProcess.ts (TAA, bloom), exposure.ts + exposureMeter.ts, governor.ts, tonemap.ts
src/render/core/mesh/               meshSystem.ts, textures.ts, primitives.ts
src/render/core/util/gpu.ts         half floats, checked allocation, mip generation, readback, blue noise
src/render/core/perf.ts, resources.ts, sceneBindings.ts
labs/render-core/                   the lab page: stand.ts (test stand), probes.ts (probe features), world.ts, main.ts
tests/browser/render-core/          functional specs + *.perf.spec.ts
tests/unit/render-core/             vitest: frame maths, cascades, exposure, governor, Hapke table
```

`public/assets/render/` holds the one shipped asset of the package (a grid texture used by the mesh-texture
test). No `.env` key is used anywhere in the package.

## 2. Public API (exact signatures)

```ts
// '@/render/core'
createRenderer(canvas: HTMLCanvasElement, gpu: GpuHandle, defs: DefLibrary, opts?: RendererOptions): Promise<CoreRenderer>
interface RendererOptions { quality?: Partial<QualitySettings>; tilesUrl?: string; skyUrl?: string; assetsUrl?: string;
                            onError?: (message: string) => void; perfFeatures?: boolean; governor?: Partial<GovernorConfig> }
interface CoreRenderer extends Renderer {          // Renderer = the contract in src/core/contracts/render.ts
  core: CoreApi; resources: CoreSharedResources; canvas: HTMLCanvasElement; frameContext: FrameContext | null;
  setDeterministic(on: boolean): void; setJitter(enabled: boolean): void; setExposureOverride(ev100: number | null): void;
  exposureInfo(): ExposureInfo;
  readHdrPixels(target?: 'hdr' | 'resolved', rect?): Promise<{ width; height; data: Float32Array }>;
  readHdrStats(target?: 'hdr' | 'resolved'): Promise<{ maxLuminance; meanLuminance; nanPixels }>;
  readDepth(): Promise<{ width; height; data: Float32Array }>;
  resetPerf(): void; passStats(): Record<string, { p50; p99; mean }>; featureOrder(): string[]; dispose(): void;
}
coreOf(ctx: RenderContext): CoreApi
interface CoreApi { meshes: MeshSystem; shaders: CoreShaderLibrary; mips: MipGenerator; shadowPassLayout: GPUBindGroupLayout;
  reportError(message: string): void;
  createSceneBindings(group: number, firstBinding: number, sets: readonly SceneBindingSet[]): SceneBindings;
  fullscreenPipeline(desc: FullscreenPipelineDesc): Tracked<GPURenderPipeline>;
  createTarget(label: string, format: GPUTextureFormat, scale: number, usage?: GPUTextureUsageFlags): ManagedTarget;
  setCloudShadowParams(params: Partial<CloudShadowParams>): void;
  createTextureChecked(desc: GPUTextureDescriptor): GPUTexture }
interface MeshSystem { createModel(data: ModelData, options?: ModelOptions): ModelHandle;
  registerProceduralTexture(id: string, texture: ProceduralTexture): void; createBatch(label: string): MeshBatch; isIdle(): boolean }
interface MeshBatch { begin(frame: FrameContext): void; add(model: ModelHandle, instance: MeshInstance): void; finish(): void;
  drawGBuffer(pass: GPURenderPassEncoder): void; drawShadow(pass: GPURenderPassEncoder, cascade: ShadowCascadeView): void;
  readonly stats: { instances: number; triangles: number; shadowTriangles: number }; destroy(): void }
interface MeshInstance { originRelCam; q; scale?; prevOriginRelCam?; prevQ?; bodyFixed: boolean; castShadow?; temperature?;
  soot?; frost?; wetness?; fade?; emissiveScale?; displayBrightness? }      // displayBrightness: 'display' materials, 0..1
instanceInFrame(parent: ParentPose, localPos: Vec3, localRot: Quat | null, rest): MeshInstance
boxMesh(sx, sy, sz) | sphereMesh(radius, segments?, rings?) | planeMesh(sizeX, sizeY, segments?) | cylinderMesh(radius, height, segments?): MeshData

// '@/render/core/lab'
createLabApp(options: LabAppOptions): Promise<LabApp>
createLabPlanetFeature(options?: LabPlanetOptions): RenderFeature
labCameraFromQuery(params, snapshot, defs): LabCamera;  lookRotation(forward, upHint): Quat;  enuAt(qFixedToRoot, dirFixed)
```

Shader chunks (names for `#include`): `frame`, `fullscreen`, `hash`, `noise`, `gbuffer`, `brdf`,
`brdf_terrain`, `brdf_regolith`, `brdf_water` (the three overridable ones), `eclipse`, `atmosphere_common`,
`shadows`, `shadow_pass`, `transparency`, `upsample`. Signatures: RENDER_API.md sections 4-9.

Changed in the second review (all documented in RENDER_API.md):

- `ShadowCascade` in `'shadow.uniforms'`: `params.w` is now the texel size along v (it was the fit flag),
  `axisV.w` is now a flag word (1 = re-rendered every frame, 2 = fitted to a whole body; it was 0 / 1).
  Same size and offsets. Nothing outside the core read these two.
- A staggered camera cascade can be a band instead of a square (section 8 of RENDER_API). Casters must cull
  against `cascade.viewProj`, never by distance from the camera; `cascade.texelSize` is the texel along u.
- `MATERIAL_DISPLAY` has its own shading branch and honours RT2.a (brightness); `MeshInstance.displayBrightness`.
- `AmbientInput`: standard and cloth ignore `skyIrradiance`; the two irradiance terms are never both set.
- `window.__perf.passes['core.copies']` exists and is part of the GPU total.

## 3. How to run and verify

Every command below is a heavy job on the shared machine: run it through the gate
(`node tools/dev/heavy.mjs --class=cpu|gpu -- <command>`, PACKAGE_RULES "Machine load").

```
npm run typecheck:paths -- src/render/core labs/render-core tests/browser/render-core tests/unit/render-core      (cpu)
npx vitest run src/render/core tests/unit/render-core tools/dev/boundaries.test.ts          # 50 tests              (cpu)
npx playwright test tests/browser/render-core --project=functional                          # 23 specs, 1.5 min     (gpu)
npx playwright test tests/browser/render-core --project=perf                                # 2 specs, GPU lock     (gpu)
```

Lab page: `/labs/render-core/` (dev server). Useful URLs:

```
/labs/render-core/?sun=120,40                          the stand under a pinned sun (az, el in deg)
/labs/render-core/?sun=215,38&probe=inputs             + constant lighting inputs (window.__rc.probes.inputs.*)
/labs/render-core/?scene=lunarOrbit&stand=0&probe=ridge,casters&fov=5     Moon with the body-fixed ridge
/labs/render-core/?scene=lunarOrbit&stand=0&probe=ridge,casters&ridge=track&fov=40&paused=1   low orbit over the ridge
/labs/render-core/?scene=translunar&planet=0&stand=0&probe=ball,mirror,sun&orbit=20,10,40&fov=100
/labs/render-core/?probe=hooks&planet=0&stand=0        frame-graph markers
/labs/render-core/?probe=heavy&heavy=15000             governor / dynamic resolution under load
/labs/render-core/?tris=1500000&perf=features&scale=1&governor=off&probe=heavy,copies   perf scene
```

`window.__rc` (the lab's handle): `lookAt(targetEnu, yawDeg, pitchDeg, distance, site?)`, `setSun([az, el])`,
`setSunAtSite(site, [az, el])`, `setSunOverride({ dirRoot })`, `viewBodyAtPhase(bodyId, phaseDeg, distance)`,
`trackSiteFromVessel(site)`, `projectSitePoint(enu, site?)`, `projectBody(id)`, `overrideTerrainBrdf(wgsl | null)`,
`stand.setDisplayBrightness(b)`, `probes.*`. Screenshots land in `out/screens/render-core/`.

## 4. Acceptance criteria: measured

Machine: RTX 5090, Chrome headless, 1280 x 720 unless noted. Measured on 2026-11-10 after the restart,
through the load gate, with one data bake and other agents' jobs on the machine: CPU numbers and rAF
cadence are provisional (the cadence of the test browser was 16.67 ms in some runs and 17.4 ms in others).

| Criterion | Result | Where |
|---|---|---|
| PBR sweep incl. anisotropic and clearcoat rows, shadowed geometry on a slab, emissive objects | done; `lighting-material-sweep.png` (sun only, vacuum), `lighting-material-sweep-env.png` (with a probe), `lighting-emissive.png`, `stand-overview.png` | `lighting.spec.ts`, `extras.spec.ts` |
| Vessel-sized object 6,371 km from the origin + Moon-sized sphere 384,400 km away in one frame | cylinder at 27.6 m and the Moon at 377,115 km (surface) in the same depth buffer, sky depth exactly 0; `stability-near-and-moon.png` | `stability.spec.ts` |
| Static scene with TAA: frame diff below 1/255 mean | mean 0.21 of 255, max single-channel difference 8 (after 4 s of convergence) | `stability.spec.ts` |
| Sub-millimetre stability while the camera moves | camera moved in 24 steps of 1 mm: the Moon slides 0.0953 px per step (expected 0.0948), max deviation from a straight line 0.042 px; the cylinder's silhouette moves 0.003 px over 23 mm | `stability.spec.ts` |
| HDR readback: sun-lit white Lambert within 10 % of E x albedo / pi x exposure; no NaN | ratio 1.0048 (the terrain BRDF's small specular lobe), perfectly uniform (min / mean 1.000), 0 NaN | `lighting.spec.ts` |
| Overflow at EV100 -3 with the sun disc and a mirror ball in view | the disc is in the frame (at pixel 781, 360; 8-10 saturated sky pixels in each of 12 frames, asserted) with 30 saturated pixels on the mirror ball: nanPixels 0 in the HDR target and in the TAA output, max exactly 60,000; exposure released: EV 15.08 after 400 frames, 0 NaN on the way; `overflow-recovered.png` | `exposure.spec.ts` |
| The saturated disc still drives bloom (ARCHITECTURE 10.4) | the 9-pixel disc: resolved peak 60,000 after 12 frames (60,000 from the second frame on), 95 % of its energy in the resolved image after 200 frames; the glow in the display image is 220 / 255 in a ring 5-9 px from the disc against 5 / 255 on the sky | `exposure.spec.ts` |
| Sunlit object covering 3 % of a black frame within 0.5 EV of sunny 16 | EV100 15.13 vs 15.07 (lit fraction 2.6 %) | `exposure.spec.ts` |
| Thin crescent within 0.5 EV of sunny 16 | EV100 15.02 vs 15.08 (lit fraction 1.4 %); `exposure-crescent.png` | `exposure.spec.ts` |
| Fully dark frame reaches the dark-adapted floor | EV100 -3.0, lit fraction 0 | `exposure.spec.ts` |
| Exposure adapts between a sunlit and an eclipsed scene | sunlit 15.1 -> Earth eclipses the sun at the vessel: -2.98 -> back to within 0.5 EV of sunny 16 | `exposure.spec.ts` |
| Contact hardening visible | 10-90 % penumbra 5.0 cm for a caster 0.4 m above the ground vs 10.4 cm for one 2.9 m up; `shadows-contact-hardening.png` | `shadows.spec.ts` |
| No acne at 85 deg sun incidence | open slab at 5 deg sun elevation: min / mean 0.997; `shadows-grazing-85deg.png` | `shadows.spec.ts` |
| `pad` scene (Earth rotating, body-fixed casters): bounded frame diff along shadow edges, no period-2/4/8 pattern | noise frozen: max frame diff 1.5e-3 of 255 over 32 frames while 5-6 cascades (staggered ones included) are re-rendered; with animated noise: mean 0.021, period strengths 0.004 / 0.005 / 0.005 (1 = everything every k-th frame) | `shadows.spec.ts` |
| `lunarOrbit` at 1.6 km/s over body-fixed casters | frame diff mean = max = 0.0024 of 255 over 64 frames (bound 0.6 from 0.4 px of image motion per frame), period strengths 0.001 | `shadows.spec.ts` |
| Shadow edges of the far staggered cascades at low sun (second review) | low orbit, sun 14 deg, 200 km cascade: residual of the ridge's shadow edge against a smooth curve 0.54 px rms / 0.99 px max over 889 px, 10-90 % width 6.8 px (before: 1.33 / 2.33 px, 15.3 px); terminator from 1,000 km, sun 6 deg, 1500 km cascade: 0.18 / 0.41 px over 171 px, width 11.2 px (before: a comb of fringes about 150 px long, no edge to measure); `shadows-low-sun-orbit-14deg.png`, `shadows-low-sun-terminator-6deg.png` | `shadows.spec.ts` |
| A vessel-frame caster never appears in a staggered cascade | 0 violations (probe `mover`); also enforced inside `MeshBatch.drawShadow` | `shadows.spec.ts`, `extras.spec.ts` |
| Ridge shadow at the terminator from 20,000 km | shadow 0.0007 vs lit ground 0.0506 (pre-exposed), from the body-fitted cascade; `shadows-ridge-terminator-20000km.png` | `shadows.spec.ts` |
| Approach through 1,500 km shows no pop | 3,000 km -> 600 km in 49 steps: shadow / lit ratio 0.000 .. 0.020, step-to-step change below 0.1, hand-over from the body cascade to the 1500 km camera cascade happened; `shadows-ridge-approach-*.png` | `shadows.spec.ts` |
| Frame graph: order, attachments, copies hold this frame, colour copies only when required | all markers exact (table in `framegraph.spec.ts`); `framegraph-markers.png` | `framegraph.spec.ts` |
| Half-resolution volume from preTransparent composited in drawTransparent, occluded by opaque geometry | tower pixels change by less than 2 % of the fog's contribution; `framegraph-volume.png` | `framegraph.spec.ts` |
| `applyAtmosphere` neutral with defaults, hides a quad behind a synthetic cloud | bit-exact 2.0 with defaults; behind the cloud 2 % remains | `framegraph.spec.ts` |
| Governor first, then dynamic resolution, 60 fps held | load calibrated under load (0.00323 ms per iteration; 15,300 iterations) and verified: 51.6 ms at quality 1 and scale 1 = 4.69 x budget. Quality lowered at frame 6 and at 0.5 before the first resolution drop at frame 13; settled at quality 0.5, scale 0.563, GPU p99 8.7 ms, 0 frames over 33 ms, rAF p95 within 0.15 ms of the same browser without the load. Passed 5 runs out of 5 with these numbers | `governor.perf.spec.ts` |
| Core fixed budget 3.0 ms at 1440p internal | p99 with the GPU as busy as a real frame (7 ms ballast pass, see 4.1): AO + contact 0.092, lighting 0.162, TAA 0.110, bloom 0.045, tonemap + histogram 0.047, copies 0.043 + depth pyramid 0.008 = **0.51 ms**. The four texture copies (two depth, two colour) are now timed, as the gaps between their neighbouring passes: p50 0.042 ms, p99 0.043 ms. With an otherwise idle GPU the total read 0.78 to 3.0 ms from run to run | `core.perf.spec.ts` |
| 1.5 M triangle scene: G-buffer + amortised shadows under 2.0 ms | 1,695,320 triangles: G-buffer p99 0.175 ms + shadows amortised 0.219 ms = **0.39 ms** (busy GPU; the shadow passes now follow the ballast pass and carry a little of its tail: 0.157 ms when it was encoded elsewhere) | `core.perf.spec.ts` |
| CPU frame under 2 ms | lab frame (FakeSim + camera + renderer): p50 0.22 - 0.61 ms, p99 0.39 - 1.08 ms over six runs on the loaded machine (1.65 ms and above 2 ms in runs before the restart, under heavier load): provisional, re-measure on a quiet machine | `core.perf.spec.ts` |
| All default SharedResources work with no feature; a brdf chunk can be overridden at run time | empty renderer: 0 errors, black frame; `brdf_terrain` replaced with a red BRDF and restored | `lighting.spec.ts` |
| Unit tests for CPU maths | 50 tests: jitter, projection, float64 poses, eclipse lens area, planetshine (15 lux earthshine), cascade snapping and per-frame re-derivation, receiver band and its brute-force check, band capture, planning, scheduler (staggering, receiver fit in low orbit, a 50 s descent without flapping), exposure rules, governor, Hapke inversion, black body; plus the boundaries test | `tests/unit/render-core` |
| Zero uncaptured GPU errors | `expectNoErrors` in every spec | all |

### 4.1 Measuring GPU time on this machine

**Keep the GPU busy.** An RTX 5090 that has only a lab's 1-2 ms of work per frame drops into a low clock
state. Measured in one session, same scene, same passes (p50 ms): TAA 0.32 idle vs 0.104 with 5-10 ms of
other GPU work in the frame; lighting 0.29 vs 0.153; the 1.7 M triangle G-buffer 0.23 vs 0.093; bloom
0.126 vs 0.048; and the idle p99 values jump by 2-3x from run to run. Budgets are for the game's 9-11 ms
frame, so `core.perf.spec.ts` asserts with a 7 ms ballast pass (the `heavy` probe) and logs the idle
numbers. **Every package's perf spec should do the same** (or it will report 2-5x too much and be flaky).

**Calibrate a synthetic load while it is running.** The governor spec used to time 40 iterations of the
heavy pass on the idle GPU and scale up: that read 0.004 to 0.021 ms per iteration against 0.0032 under
load, so its "50 ms" load was 7 to 50 ms and the spec failed two runs out of three. It now sets 3000
iterations, waits until the governor has held one quality and resolution for 120 frames, divides the pass
time by iterations x qualityScale x renderScale^2, and after the trace asserts that the applied load was at
least 4 x the budget.

**A long pass leaks into what follows it.** In about one frame out of five, 0.23 ms of the 7 ms ballast
pass was still in flight at its end timestamp and was charged to whatever was encoded next: to the gap that
times a texture copy when the ballast sat in `preTransparent` (copies p99 0.39 ms instead of 0.04), to the
G-buffer pass when it sat in `compute` (p99 0.39 ms instead of 0.18). The `heavy` probe therefore encodes
an empty pass of its own right behind the burn. In the integrated app the same will happen after the
atmosphere and cloud passes: when `core.copies` or the pass after a long one looks large at p99, read the
p50 and look at the pass before it.

Additional checks beyond the acceptance list: every lighting input against a hand calculation (transmittance
x 0.5; far cloud shadow exp(-tau / mu_s); near cloud shadow map; sky irradiance 0.12939 vs 0.12952; point
light 0.4082 vs 0.4016; `env.sh9` 0.1224 vs 0.1214; `env.probeCube` 10,000 cd/m^2 reflecting 9996 / 7610 /
3330 off polished gold); the sky irradiance table does not change a standard or a cloth pixel (bit-exact),
with or without the probe; the display material (400 cd/m^2 panel reads 399.9 head-on, 199.0 at brightness
0.5, 0 at brightness 0, reflects 442 cd/m^2 of a 10,000 cd/m^2 environment, 0.770 of its luminance at
75 deg); TAAU at 60 % internal resolution matching the native image (`taau-60-percent.png`); interior
camera: cascade 0 anchored to the vessel and every-frame.

## 5. Deviations from the brief and decisions worth knowing

1. **Emissive target.** The sixth G-buffer target is a separate `rgba16float` texture, not the HDR target
   itself: lighting reads it and writes `writeHdr(lit + emissive)`. Adding the lit result onto emissive by
   blending could exceed 65504 and produce Inf. Feature authors see the same six targets.
2. **Lit range for metering.** Besides the absolute floor (0.008 cd/m^2) the histogram ignores pixels more
   than 10 EV below the brightest lit pixels, and the mean of the lit range is arithmetic. Without this a
   thin sunlit crescent over a large earthshine-lit night side was metered for the night side.
3. **Photometric prior.** Used alone below 0.5 % lit coverage, blended with the histogram up to 10 %, so a
   small white object is not rendered grey. The unoccluded solar disc in view counts as "something lit in
   view" (a camera pointed at the sun stops down instead of blooming out the frame).
4. **Every-frame cascades.** Besides the two nearest, any cascade that a vessel reaches into is re-rendered
   every frame (unless the vessel and the room for its shadow fit in the finer one), at most four. Otherwise
   a rocket seen from a chase camera 150 m away would cast no shadow at all.
5. **Which cascades exist.** Cascades that reach neither a vessel nor the ground are dropped; a whole-body
   cascade exists for the nearest body when its visible ground extends past 1500 km (always in low orbit)
   and for another body once it is 64 px on screen. With 8 slots the far camera cascades give way to body
   cascades; from the ground with a strongly zoomed-in Moon the 1500 km camera cascade is dropped.
6. **Texel snapping** is relative to the previous capture of the same cascade (absolute snapping re-phased
   the grid every frame because the anchor origin is millions of metres from the cascade).
7. **Receiver fit of staggered cascades** (second review; not in ARCHITECTURE 10.1, compatible with it). A
   staggered camera cascade is not always a square around the camera: its footprint along v is narrowed to
   the band of ground it shadows (terrain shell between `BodyDef.terrain.minElevation` and `maxElevation`
   inside the cascade's reach), in steps of sqrt(2), and its map is turned so that v lies along the local
   vertical. Anchoring, per-frame matrix re-derivation and relative snapping are unchanged. A change of
   band or orientation re-phases the texel grid once (hysteresis: 25 % slack, 10 deg of roll; a 50 s
   descent from 300 km to 3 km changes a cascade's band fewer than 12 times and never back and forth).
8. **Shadow kernel in receiver space.** In staggered cascades the smallest PCF kernel is round on the
   receiver, not on the map (up to 4 times longer across the light), with a cone bias on the widened part.
   Every-frame cascades are unchanged.
9. **Resolve and bloom are linear in space.** The 3 x 3 reconstruction of the resolve is a linear average
   (only the temporal blend runs in the reversible tonemap space), the variance clip is taken about the
   centre tap and widened to the tap range where the neighbourhood is very bright, and the first bloom
   level has no Karis average. Fireflies are rejected by the temporal blend alone.
10. **Ambient terms are alternatives.** Standard, cloth and display take `env.sh9` only; terrain and water
    the sky irradiance table only; regolith the table on a body with an atmosphere layer and the probe on
    an airless one (on the Moon nothing changed).
11. **Cloud shadow placement** has no SharedResources key: `coreOf(ctx).setCloudShadowParams` (request 1).
12. **`resources.publish`** bumps the version only when the value object changes.
13. **LabPlanet albedo.** The lab passes synthetic maps by default because a missing tile set logs a 404
    (request 2); `?maps=tileset` uses the real `albedoLowRes` maps.
14. `window.__perf` is a getter (percentiles are computed on access).

## 6. Known weaknesses (plainly)

- **Low sun, cascades of 8 km and below.** The receiver fit needs to know how high the ground inside the
  cascade stands. The core only knows the global range of the body (Moon: -9.1 .. +10.8 km), so only
  cascades much larger than that are narrowed (200 km: 2.8 x at 14 deg, 1500 km: 5.7 x at 6 deg, both
  measured; 40 km: about 2 x by the same formula, not measured). Staggered cascades of 300 m to 8 km keep square maps: at a sun elevation e their texels are
  still 1 / sin(e) long on the ground, hidden only by the wider kernel (up to 6 texels across the light),
  so mid-range terrain shadows during a low-sun descent are soft rather than fine. A local elevation range
  from the terrain (min / max of the resident tiles inside a radius) fed into `PlanBody.minElevation /
  maxElevation` in `shadowSystem.ts` would extend the fit to them; it is not built.
- **Low sun, what remains in the far cascades.** On a ruler-straight 150 km edge seen from low orbit at
  14 deg a wobble of 0.5 px rms (1 px peak, period about 15 px at 1280 x 720) is left: the 70 m texels of
  the fitted map on an edge that runs almost along a texel row. It scales with resolution (about 2 px peak
  at 1440p). A longer kernel across the light removes more of it (0.24 px rms at 3 x) at the price of
  softer side edges and a worse terminator case; it was left round.
- **Whole-body cascades are not fitted.** They cover the whole sunlit disc at 1.9 km per texel (Moon); near
  the terminator a texel is 18 km long on the ground at 6 deg. The receiver-space kernel turns the former
  stair-steps into blur there (residual 0.26 px rms from 20,000 km at a 5 deg field of view), nothing more.
- **Vessels above the terrain get no shadow from a fitted staggered cascade** (they are outside its band);
  they fall through to the next cascade or the whole-body one. Terrain shadows on a vessel come from the
  every-frame cascades, as before, so this only matters for a mountain shadowing a craft more than 10 km
  above the datum at sunset.
- **Resolve: the rim of a new bright source takes about two seconds.** A pixel that turns from dark to
  saturated is believed at once only if its whole 3 x 3 neighbourhood is bright; otherwise it converges in
  the tonemap space (about 100 frames to 60,000). The 9-pixel sun disc has its peak after two frames, 22 %
  of its energy after 20 frames and 95 % after 140 (measured, static camera). Two things follow from the
  construction of the blend and were not measured: a highlight smaller than a pixel that flickers under
  the jitter stays near 1 and does not bloom, and under camera motion the history of a small disc is
  resampled in the tonemap space and its rim rebuilt each time, so its glow should be weaker while the
  view turns.
- **Bloom without a Karis average** blooms everything linearly; a single saturated frame after a history
  reset (camera cut) would flash for one frame. Not seen in the lab scenes.
- **Regolith ambient uses the probe at the active vessel everywhere on an airless body.** Far from the
  vessel (night side seen from a craft over the day side) slopes receive a bounce that is not there: by
  the SH formula about 0.3 % of the sunlit luminance on a 20 deg slope, which is above earthshine (an
  estimate, not a measurement). Unchanged by this round.
- **`core.copies` is a gap, not a pass** (4.1): it includes whatever of the preceding pass is still in
  flight, and for the copy before the transparents any feature pass without a timestamp.
- **CPU p99** was above the 2 ms line under the heaviest load before the restart and at 0.4 - 1.1 ms in
  this round's six runs. The bulk is WebGPU call overhead of about 35 passes per frame. If it is tight on
  a quiet machine, the first things to cut are the 11 bloom passes (merge levels) and per-frame allocations
  in cascade planning.
- **GTAO has no denoiser of its own.** It relies on the main TAA; in deterministic screenshots (frozen
  noise) a fine grain is visible in occluded areas, and penumbrae of staggered cascades are speckled
  (`shadows-pad-far.png`): 12 taps over a kernel that is now up to 4 times longer.
- **Contact shadows are binary** (no penumbra) and screen-space only; they vanish at screen edges.
- **Local lights and planetshine are unshadowed.** The research design mentions a cheap cascade lookup for
  plume light on the vehicle; it is not implemented.
- **Slot overflow** (section 5.5) changes which far cascade exists: a pop is possible only with a telescopic
  view of a second body from the ground.
- **AO / contact-shadow / TAA cost scales with pixels only**; `qualityScale` does not reduce core passes.
- The mesh system has no skinning, no alpha-tested materials and no per-instance tint; texture loading
  (procedural and URL), LOD cross-fade and the LabPlanet `'ocean.nearField'` path are each covered by a
  browser test (`mesh.spec.ts`), normal / ORM / emissive textures only by code review.
- Interior metering and the vessel-anchored cascade are exercised (`extras.spec.ts`) but there is no real
  cockpit to judge them on; cloth translucency and the wetness / soot / frost instance parameters were
  looked at in the lab only (no numeric test). The display branch is tested on a flat emitter; a display
  with an image texture goes through the same path (`textures.emissive`) but was not looked at.
- The exposure compensation curve and bloom strength are first values tuned on the lab scenes, not on the
  integrated game. Bloom strength (4 %) was not re-tuned after the bloom chain became linear: highlights
  glow more than before.

## 7. Requests filed

- `docs/requests/render-core-1.md` (non-blocking): add `'clouds.shadowParams'` to `SharedResourceMap`.
- `docs/requests/render-core-2.md` (non-blocking): `/tiles/index.json` listing so a missing tile set does
  not have to be probed with a 404.
- `docs/requests/render-core-3.md` (non-blocking, comment only): `ShadowCascadeView.texelSize` is the texel
  along u and the footprint is not always a square; optional `texelSizeV`.

No request against render-core paths was open at hand-off.

## 8. Second review (2026-11-10): findings and what was done

| Finding | Done |
|---|---|
| Major: standard and cloth received the sky twice (sky table + `env.sh9`) | `brdfStandardAmbient` and `brdfClothAmbient` take the probe alone; regolith takes the probe only on a body without an atmosphere layer. Asserted: publishing the table leaves a standard and a cloth pixel bit-identical, with and without the probe |
| Major: saw-toothed / combed shadow edges from the far staggered cascades at low sun | receiver fit of staggered camera cascades (finer texels along the light) + receiver-space PCF kernel. Edge residual 1.33 -> 0.54 px rms at 14 deg with a penumbra less than half as wide; the 6 deg terminator comb is gone (0.18 px rms). New spec fits the ridge's shadow edge at 14 and 6 deg; four new unit tests. Stability specs unchanged (pad, lunar orbit, approach) |
| Major: `governor.perf.spec.ts` flaky (2 of 3 runs failed) | load calibrated under load and verified after the trace (at least 4 x budget asserted): 5 passes out of 5, same numbers each time |
| Minor: the overflow spec never had the sun in view | sun placed from the camera's own basis with the sim paused; the spec asserts saturated depth == 0 pixels at the projected sun position in every frame before it looks at NaN counts |
| Minor: the resolve collapsed small saturated sources (resolved max 2,412 of 60,000) | linear spatial reconstruction, variance about the centre tap, clip box widened in very bright neighbourhoods, no Karis average in bloom: peak 60,000 after two frames, 95 % of the disc's energy when settled. Asserted (peak above 50 %, energy above 60 %, visible glow) |
| Minor: texture copies untimed and missing from the governor's GPU total | timed as gaps between passes (`core.copies`), part of the total and of the 0.35 ms line: 0.043 + 0.008 ms p99. The perf scene now runs all four copies |
| Minor: `MATERIAL_DISPLAY` had no shading branch, its parameter was ignored | display branch (emitter x brightness x glass transmission, dielectric front, never metallic or wet), `MeshInstance.displayBrightness`, a display on the lab stand and a numeric spec |

Also fixed on the way: the mesh system culled casters against a fitted cascade with the wrong scale along v;
the dark-frame step of the exposure spec depended on how fast the run was (its sun override followed the
camera, and its quaternion from a basis divided by a term that can be zero): it now pins the sun, pauses
the sim and uses a well-conditioned conversion (9 passes out of 9).

## Changes by the lead between the waves (2026-11-10)

- `render-core-1` declined: cloud-shadow placement stays with `coreOf(ctx).setCloudShadowParams({ near, far })`
  (per-frame CPU data; one path). The contract comment of `'clouds.shadowMap'` and RENDER_API section 7 say so;
  the atmosphere-clouds brief names the call. Section 5 item 11 above stands.
- `render-core-2` resolved: the dev server answers `/tiles/index.json` with `{ "tilesets": string[] }`
  (`tools/server/dataPlugin.ts`, `listTilesets`); the LabPlanet reads it and skips a tile set that is not
  baked without requesting its manifest (`src/render/core/lab/labPlanet.ts`). Section 5 item 13: both tile
  sets exist now, so `?maps=tileset` logs nothing either way.
- `render-core-3` resolved: `ShadowCascadeView.texelSize` is documented as the texel along u (the coarser
  axis), `farDistance` as not describing a square, and the view has a new field `texelSizeV: number` (m,
  equal to `texelSize` for a square cascade), filled from `CascadeCapture.texelSizeV` in
  `shadows/shadowSystem.ts`; asserted in `tests/browser/render-core/shadows.spec.ts` (low sun).

Full list: `docs/handoff/lead-baseline.md`.
