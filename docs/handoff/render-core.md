# Hand-off: render-core

Renderer core: device setup on top of `GpuHandle`, the frame graph of ARCHITECTURE 10.0 with scene copies,
bind group 0, the shader library and chunks, G-buffer + deferred lighting (sun, atmosphere transmittance,
eclipses, cloud shadow, sky irradiance, IBL, planetshine, local lights), body-anchored sun shadow cascades,
GTAO + contact shadows, TAA / TAAU with dynamic resolution, bloom, auto-exposure, AgX tonemap, the quality
governor, perf attribution, the mesh system and the lab harness.

**The manual for feature authors is `docs/RENDER_API.md`** (WGSL layouts, hook rules, chunk signatures, mesh
and lab APIs, photometric conventions). This note covers what was built, how to verify it, what was
measured, and what is weak.

## 1. Where things are

```
src/render/core/index.ts            public API for engine code            (import from '@/render/core')
src/render/core/lab/index.ts        createLabApp, createLabPlanetFeature  (import from '@/render/core/lab')
src/render/core/renderer.ts         createRenderer: frame graph, FrameContext, targets, governor wiring
src/render/core/coreApi.ts          coreOf(ctx): helpers beyond the RenderContext contract
src/render/core/frame/              float64 frame maths (jitter, poses, sun, eclipse, planetshine), uniform packing
src/render/core/shaders/            library (#include, tracked pipelines) and every WGSL chunk
src/render/core/shadows/            cascadeMath.ts (pure float64 planning + scheduler), shadowSystem.ts (GPU)
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

## 3. How to run and verify

```
npm run typecheck:paths -- src/render/core labs/render-core tests/browser/render-core tests/unit/render-core
npx vitest run src/render/core tests/unit/render-core tools/dev/boundaries.test.ts          # 46 tests + boundaries
npx playwright test tests/browser/render-core --project=functional                          # 21 specs
npx playwright test tests/browser/render-core --project=perf                                # 2 specs, GPU lock
```

Lab page: `/labs/render-core/` (dev server). Useful URLs:

```
/labs/render-core/?sun=120,40                          the stand under a pinned sun (az, el in deg)
/labs/render-core/?sun=215,38&probe=inputs             + constant lighting inputs (window.__rc.probes.inputs.*)
/labs/render-core/?scene=lunarOrbit&stand=0&probe=ridge,casters&fov=5     Moon with the body-fixed ridge
/labs/render-core/?scene=translunar&planet=0&stand=0&probe=ball,mirror,sun&orbit=20,10,40&fov=100
/labs/render-core/?probe=hooks&planet=0&stand=0        frame-graph markers
/labs/render-core/?probe=heavy&heavy=15000             governor / dynamic resolution under load
/labs/render-core/?tris=1500000&perf=features&scale=1&governor=off        perf scene
```

`window.__rc` (the lab's handle): `lookAt(targetEnu, yawDeg, pitchDeg, distance, site?)`, `setSun([az, el])`,
`setSunAtSite(site, [az, el])`, `setSunOverride({ dirRoot })`, `viewBodyAtPhase(bodyId, phaseDeg, distance)`,
`trackSiteFromVessel(site)`, `projectSitePoint(enu, site?)`, `projectBody(id)`, `overrideTerrainBrdf(wgsl | null)`,
`probes.*`. Screenshots land in `out/screens/render-core/`; every one listed below was looked at.

The specs are slow to START on a loaded machine (the first navigation compiles the page through Vite: 40 s
to several minutes while the bakes ran), hence the 10 minute per-test timeout in the spec files.

## 4. Acceptance criteria: measured

Machine: RTX 5090, Chrome headless, 1280 x 720 unless noted. Everything was measured while the data bakes
and other agents' test runs were loading the machine, so CPU numbers and rAF cadence are provisional.

| Criterion | Result | Where |
|---|---|---|
| PBR sweep incl. anisotropic and clearcoat rows, shadowed geometry on a slab, emissive objects | done; `lighting-material-sweep.png` (sun only, vacuum), `lighting-material-sweep-env.png` (with a probe), `lighting-emissive.png`, `stand-overview.png` | `lighting.spec.ts`, `extras.spec.ts` |
| Vessel-sized object 6,371 km from the origin + Moon-sized sphere 384,400 km away in one frame | cylinder at 27.6 m and the Moon at 377,116 km (surface) in the same depth buffer, sky depth exactly 0; `stability-near-and-moon.png` | `stability.spec.ts` |
| Static scene with TAA: frame diff below 1/255 mean | mean 0.21 - 0.25 of 255 (max single-channel difference 20, on a thin clearcoat highlight) | `stability.spec.ts` |
| Sub-millimetre stability while the camera moves | camera moved in 24 steps of 1 mm: the Moon slides 0.0946 px per step (expected 0.0948), max deviation from a straight line 0.028 px; the cylinder's silhouette moves 0.0009 px over 23 mm | `stability.spec.ts` |
| HDR readback: sun-lit white Lambert within 10 % of E x albedo / pi x exposure; no NaN | ratio 1.0048 (the terrain BRDF's small specular lobe), perfectly uniform (min / mean 1.000), 0 NaN | `lighting.spec.ts` |
| Overflow at EV100 -3 with the sun disc and a mirror ball | 12 frames at EV -3: nanPixels 0 in the HDR target and in the TAA output, max exactly 60,000; exposure released: EV 15.08 after 400 frames, 0 NaN on the way; `overflow-recovered.png` | `exposure.spec.ts` |
| Sunlit object covering 3 % of a black frame within 0.5 EV of sunny 16 | EV100 15.13 vs 15.07 (lit fraction 2.5 %) | `exposure.spec.ts` |
| Thin crescent within 0.5 EV of sunny 16 | EV100 15.00 vs 15.08 (lit fraction 1.4 %); `exposure-crescent.png` | `exposure.spec.ts` |
| Fully dark frame reaches the dark-adapted floor | EV100 -3.0, lit fraction 0 | `exposure.spec.ts` |
| Exposure adapts between a sunlit and an eclipsed scene | sunlit 15.1 -> Earth eclipses the sun at the vessel: -2.98 -> back to within 0.5 EV of sunny 16 | `exposure.spec.ts` |
| Contact hardening visible | 10-90 % penumbra 5.0 cm for a caster 0.4 m above the ground vs 9.9 cm for one 2.9 m up; `shadows-contact-hardening.png` | `shadows.spec.ts` |
| No acne at 85 deg sun incidence | open slab at 5 deg sun elevation: min / mean 0.997; `shadows-grazing-85deg.png` | `shadows.spec.ts` |
| `pad` scene (Earth rotating, body-fixed casters): bounded frame diff along shadow edges, no period-2/4/8 pattern | noise frozen: max frame diff 4.9e-4 of 255 over 32 frames while 5-6 cascades (staggered ones included) are re-rendered; with animated noise: mean 0.020, period strengths 0.002 / 0.005 / 0.006 (1 = everything every k-th frame) | `shadows.spec.ts` |
| `lunarOrbit` at 1.6 km/s over body-fixed casters | frame diff mean = max = 0.0025 of 255 over 64 frames (bound 0.6 from 0.4 px of image motion per frame), period strengths 0.001 | `shadows.spec.ts` |
| A vessel-frame caster never appears in a staggered cascade | 0 violations (probe `mover`); also enforced inside `MeshBatch.drawShadow` | `shadows.spec.ts`, `extras.spec.ts` |
| Ridge shadow at the terminator from 20,000 km | shadow 0.0006 vs lit ground 0.0506 (pre-exposed), from the body-fitted cascade; `shadows-ridge-terminator-20000km.png` | `shadows.spec.ts` |
| Approach through 1,500 km shows no pop | 3,000 km -> 600 km in 49 steps: shadow / lit ratio 0.001 .. 0.014, step-to-step change below 0.1, hand-over from the body cascade to the 1500 km camera cascade happened; `shadows-ridge-approach-*.png` | `shadows.spec.ts` |
| Frame graph: order, attachments, copies hold this frame, colour copies only when required | all markers exact (table in `framegraph.spec.ts`); `framegraph-markers.png` | `framegraph.spec.ts` |
| Half-resolution volume from preTransparent composited in drawTransparent, occluded by opaque geometry | tower pixels change by less than 2 % of the fog's contribution; `framegraph-volume.png` | `framegraph.spec.ts` |
| `applyAtmosphere` neutral with defaults, hides a quad behind a synthetic cloud | bit-exact 2.0 with defaults; behind the cloud 2 % remains | `framegraph.spec.ts` |
| Governor first, then dynamic resolution, 60 fps held | 49 ms heavy pass at 1440p: quality lowered at frame 4, resolution at frame 11; settled quality 0.5, scale 0.5625, GPU p99 8.5 ms, 0 frames over 33 ms, rAF p95 18.05 ms against 18.03 ms for the same browser without load | `governor.perf.spec.ts` |
| Core fixed budget 3.0 ms at 1440p internal | p99: AO + contact 0.135, lighting 0.302, TAA 0.325, bloom 0.136, tonemap + histogram 0.083, depth pyramid 0.018 = **1.00 ms**. The three `copyTextureToTexture` calls are outside any pass and cannot be timed by timestamp queries; they are not in the sum | `core.perf.spec.ts` |
| 1.5 M triangle scene: G-buffer + amortised shadows under 2.0 ms | 1,695,306 triangles: G-buffer p99 0.642 ms + shadows amortised 0.198 ms = **0.84 ms** | `core.perf.spec.ts` |
| CPU frame under 2 ms | **not met at p99 in these runs**: lab frame (FakeSim + camera + renderer) p50 1.2 - 1.3 ms, p99 2.2 - 2.8 ms on the loaded machine. The spec keeps the 2.0 ms assertion; re-measure on a quiet machine. Breakdown of one frame: frame context 0.16, cascade planning 0.15, stand batch 0.14, uniforms 0.05, hook encoding 0.25, the rest is about 35 passes of WebGPU calls + submit | `core.perf.spec.ts` |
| All default SharedResources work with no feature; a brdf chunk can be overridden at run time | empty renderer: 0 errors, black frame; `brdf_terrain` replaced with a red BRDF and restored | `lighting.spec.ts` |
| Unit tests for CPU maths | 46 tests: jitter, projection, float64 poses, eclipse lens area, planetshine (15 lux earthshine), cascade snapping and per-frame re-derivation, planning, scheduler, exposure rules, governor, Hapke inversion, black body | `tests/unit/render-core` |
| Zero uncaptured GPU errors | `expectNoErrors` in every spec | all |

Additional checks beyond the acceptance list: every lighting input against a hand calculation (transmittance
x 0.5; far cloud shadow exp(-tau / mu_s); near cloud shadow map; sky irradiance 0.12939 vs 0.12952; point
light 0.4082 vs 0.4016; `env.sh9` 0.1224 vs 0.1214; `env.probeCube` 10,000 cd/m^2 reflecting 9996 / 7610 /
3330 off polished gold); TAAU at 60 % internal resolution matching the native image
(`taau-60-percent.png`); interior camera: cascade 0 anchored to the vessel and every-frame.

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
7. **Cloud shadow placement** has no SharedResources key: `coreOf(ctx).setCloudShadowParams` (request 1).
8. **`resources.publish`** bumps the version only when the value object changes.
9. **LabPlanet albedo.** The lab passes synthetic maps by default because a missing tile set logs a 404
   (request 2); `?maps=tileset` uses the real `albedoLowRes` maps.
10. `window.__perf` is a getter (percentiles are computed on access).

## 6. Known weaknesses (plainly)

- **CPU p99** above the 2 ms line on the loaded machine (section 4). Not investigated further; the bulk is
  WebGPU call overhead of about 35 passes per frame. If it holds on a quiet machine, the first things to
  cut are the 11 bloom passes (merge levels) and per-frame allocations in cascade planning.
- **GTAO has no denoiser of its own.** It relies on the main TAA; in deterministic screenshots (frozen
  noise) a fine grain is visible in occluded areas (`lighting-material-sweep-env.png`, under the spheres).
- **Contact shadows are binary** (no penumbra) and screen-space only; they vanish at screen edges.
- **Local lights and planetshine are unshadowed.** The research design mentions a cheap cascade lookup for
  plume light on the vehicle; it is not implemented.
- **Whole-body cascades at very low sun.** One texel is 1.9 km for the Moon; at 6 deg sun elevation a texel
  smears 18 km along the ground, so the tip of a long shadow is stair-stepped when zoomed in closely
  (invisible at the distances the cascade is meant for; visible at 1.2 deg field of view).
- **Slot overflow** (section 5.5) changes which far cascade exists: a pop is possible only with a telescopic
  view of a second body from the ground.
- **AO / contact-shadow / TAA cost scales with pixels only**; `qualityScale` does not reduce core passes.
- **Copies are not timed** (no timestamp query outside passes).
- **Texture loading from a URL**, LOD cross-fade and the LabPlanet `'ocean.nearField'` path have a browser
  test each (`mesh.spec.ts`), but skinned or alpha-tested meshes do not exist in the mesh system.
- `MATERIAL_DISPLAY` is lit as a standard surface; there is no display-specific shading.
- The exposure compensation curve and bloom strength are first values tuned on the lab scenes, not on the
  integrated game.

## 7. Requests filed

- `docs/requests/render-core-1.md` (non-blocking): add `'clouds.shadowParams'` to `SharedResourceMap`.
- `docs/requests/render-core-2.md` (non-blocking): `/tiles/index.json` listing so a missing tile set does
  not have to be probed with a 404.

No request against render-core paths was open at hand-off.
