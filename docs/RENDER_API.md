# Render core API

For authors of `RenderFeature`s (terrain, atmosphere, sky, ocean, vehicle, cockpit, vfx, map/UI overlays)
and of lab pages. The contracts are `src/core/contracts/render.ts`; this file documents what the render
core (`src/render/core`) adds to them: exact WGSL layouts, bind group 0, shader chunks, the rules of every
hook, the mesh system, the lab app and the photometric conventions.

Import only from `@/render/core` (engine code) and `@/render/core/lab` (lab pages and specs).

```ts
import { coreOf, createRenderer, instanceInFrame, type CoreRenderer } from '@/render/core';
import { createLabApp, createLabPlanetFeature } from '@/render/core/lab';
```

Contents: 1 Quick start · 2 Frame graph and hook rules · 3 Bind groups · 4 Frame uniforms (group 0) ·
5 Shader library and chunks · 6 G-buffer · 7 Lighting inputs (what to publish) · 8 Sun shadows ·
9 Transparents · 10 Mesh system · 11 Utilities (`coreOf`) · 12 Photometric conventions · 13 Exposure,
TAA, governor · 14 Perf and attribution · 15 Lab app · 16 Checklist · 17 Recipes · 18 Changes in wave 2

---

## 1. Quick start: a feature

```ts
export function createMyFeature(): RenderFeature {
  let ctx: RenderContext, batch: MeshBatch, model: ModelHandle;
  return {
    id: 'my-feature',                       // unique; prefix of your pass names and perf rows
    order: 0,                               // ascending within each hook, ties in registration order
    init(c) {
      ctx = c;
      const core = coreOf(c);               // helpers beyond the contract (section 11)
      batch = core.meshes.createBatch('my-feature');
      model = core.meshes.createModel(myModelData);
    },
    prepare(frame) {                        // CPU only: culling, uploads, frame.lights.push(...)
      batch.begin(frame);
      const v = frame.vesselPose(frame.snapshot.activeVesselId)!;
      batch.add(model, instanceInFrame(v, { x: 0, y: 0, z: 0 }, null, { bodyFixed: false }));
      batch.finish();
    },
    drawGBuffer(_frame, pass) { batch.drawGBuffer(pass); },
    drawShadow(_frame, pass, cascade) { batch.drawShadow(pass, cascade); },
    isIdle: () => coreOf(ctx).meshes.isIdle(),
  };
}
```

A lab page for it is section 15.

---

## 2. Frame graph and hook rules

`renderer.render(snapshot, camera, observers, realDt)` runs, in this order (ARCHITECTURE 10.0). In every
core-owned pass the core has already called `pass.setBindGroup(0, frame.frameBindGroup)`.

| # | Stage | Hook | Attachments / what you may sample |
|---|---|---|---|
| 0 | CPU | `prepare(frame)` | No GPU pass. Upload buffers, register `frame.lights`, call `setCloudShadowParams`. Frame uniforms are written AFTER all `prepare` hooks. |
| 1 | compute | `compute(frame, encoder)` | Your own compute/render passes. `scene.*` copies still hold the PREVIOUS frame. |
| 2 | sun shadows | `drawShadow(frame, pass, cascade)` | Once per cascade that is re-rendered this frame. Depth-only: `depth32float` layer, cleared to 1, compare `less` (standard Z, 0 at the sun side). The core has bound group 1 = cascade matrix (chunk `shadow_pass`). Rules in section 8. |
| 3 | G-buffer | `drawGBuffer(frame, pass)` | Colour: RT0 albedo `rgba8unorm-srgb`, RT1 normal `rg16float`, RT2 material `rgba8unorm`, RT3 velocity `rg16float`, RT4 extra `rgba8unorm`, RT5 emissive `rgba16float`. Depth `depth32float` writable, compare `greater`, cleared to 0. Use `GBufferOut` / `gbufferPack` (section 6). |
| 3a | copy | core | depth -> `'scene.depthOpaque'` |
| 4 | AO, contact shadows, deferred lighting | core | Writes the HDR target (`rgba16float`): lit colour + RT5 emissive, through `writeHdr`. |
| 4a | copy | core | HDR -> `'scene.colorCopy'`, only if a registered feature lists it in `requires`. |
| 5 | forward water | `drawWater(frame, pass)` | Colour: target 0 = HDR (blending allowed), target 1 = RT3 velocity. Depth writable, compare `greater-equal`. Sample the seabed from `'scene.depthOpaque'` and `'scene.colorCopy'`; the G-buffer inputs of the pixel underneath (far sheet or seabed) from `'gbuffer.albedo'` / `'gbuffer.normal'` / `'gbuffer.material'` (section 6). The pass is skipped when no feature has `drawWater`. |
| 5a | copy | core | depth -> `'scene.depth'`; 2 x 2 min/max -> `'scene.depthHalf'` (`rg32float`, r = farthest = min, g = nearest = max) |
| 6 | background | `drawBackground(frame, pass)` | Colour: HDR. Depth read-only; use compare `equal` with clip z = 0 so only sky pixels (depth == 0) are written. |
| 7 | atmosphere + clouds | `compositeAtmosphere(frame, encoder, hdrTarget)` | Your own passes; the last one blends into `hdrTarget` (loadOp `load`). May sample `'scene.depth'`, `'scene.depthHalf'`. Publish `'atmosphere.aerialPerspective'`, `'clouds.screen'`, `'clouds.depth'`. |
| 8 | offscreen transparents | `preTransparent(frame, encoder)` | Your own passes into your own targets (half-resolution volumes). Read `'scene.depth'` / `'scene.depthHalf'`. Never touch the HDR target. |
| 8a | copy | core | HDR -> `'scene.colorCopyTransparent'`, only if required. |
| 9 | transparents | `drawTransparent(frame, pass)` | Colour: HDR with blending (premultiplied: `one`, `one-minus-src-alpha`; or dual-source). Depth read-only (`depthWriteEnabled: false`), compare `greater-equal`. Every fragment goes through `applyAtmosphere()` (section 9). |
| 10 | TAA / TAAU, bloom, exposure, tonemap | core | Dynamic resolution on GPU time; inputs sanitised. |
| 11 | LDR overlay | `drawOverlay(frame, pass)` | Colour: the canvas (`ctx.canvasFormat`), display resolution, sRGB-encoded values, no depth. Drawn after the tonemap in the same pass. |

Rules that hold everywhere:

- **Never bind a live attachment for sampling.** Depth and colour are sampled through the published copies
  only (`ctx.resources.get('scene.depth')` etc., or the binding sets of section 11). WebGPU rejects the
  pass otherwise.
- **Every HDR write goes through `writeHdr()`** (chunk `frame`): NaN and negatives to 0, clamp to
  `HDR_MAX` = 60000. Emissive in the G-buffer included (`gbufferPack` does it).
- `scene.depthOpaque` is valid from lighting to the end of the frame; `scene.depth` and `scene.depthHalf`
  from `drawBackground` on; in `prepare` / `compute` they hold the previous frame.
- Colour copies exist only when some registered feature has `requires: ['scene.colorCopy']` (or
  `'scene.colorCopyTransparent'`); otherwise the key returns a 1 x 1 black default.
- `'gbuffer.albedo'`, `'gbuffer.normal'` and `'gbuffer.material'` are the live RT0 / RT1 / RT2 of this frame
  (no copy). They may be read in every hook from `drawWater` on, where they are not attachments. **Never set
  a bind group that contains them inside `drawGBuffer`** (also not one that no draw uses): keep them in a
  bind group of their own.
- Pipelines must match the attachment formats of the pass exactly (all six targets in `drawGBuffer`, two in
  `drawWater`, one elsewhere) and the depth format `depth32float`.
- If you change the scissor rect or viewport inside a core-owned pass, restore the full target before
  returning (other features draw after you).
- Resolution: `frame.renderSize` is the internal resolution (all scene targets and copies), `frame.displaySize`
  the canvas. Internal resolution changes at run time (dynamic resolution): rebuild bind groups when
  `ctx.resources.version(key)` changes and size your own targets with `core.createTarget` (section 11).
- `ctx.resources.publish(key, value)` bumps the version only when `value` is a different object than the
  current one, so publishing the same view every frame is free.

---

## 3. Bind groups

`maxBindGroups` is 4. The plan:

| Group | Owner | Content |
|---|---|---|
| 0 | core, always | frame uniforms, shared samplers, blue noise (`ctx.frameBindGroupLayout`, `frame.frameBindGroup`); section 4 |
| 1 | the pass | In `drawShadow`: the core's cascade group (`coreOf(ctx).shadowPassLayout`, chunk `shadow_pass`), already bound. In every other hook: yours; put SharedResources here with `createSceneBindings` (shadow maps, LUTs, scene copies; section 11) |
| 2 | material | yours |
| 3 | object / instances | yours |

The core mesh system uses: G-buffer 0 frame / 1 instances / 2 material; shadow 0 frame / 1 cascade / 2 instances.

---

## 4. Frame uniforms (bind group 0)

`#include "frame"` declares everything below. Layout (every member is a `vec4` or `mat4x4`, 2768 bytes).

```wgsl
struct BodyUniform {      // 256 bytes; frame.bodies[i] <-> FrameContext.bodies[i] (first 4 bodies of the snapshot)
  center: vec4f,          // xyz = body centre relative to the camera (ROOT axes, m), w = reference radius (m)
  prevCenter: vec4f,      // xyz = centre relative to the PREVIOUS camera, w = atmosphere top radius (0 = none)
  cameraUp: vec4f,        // xyz = unit vector centre -> camera, w = camera distance from the centre (m)
  sunDir: vec4f,          // xyz = unit direction body -> star (ROOT), w = camera altitude above the radius (m, from f64)
  fixedX: vec4f,          // xyz = body-fixed +X in ROOT axes, w = atmosphere LUT layer (-1 = none)
  fixedY: vec4f,          // xyz = body-fixed +Y, w = sea-level radius (0 = no ocean)
  fixedZ: vec4f,          // xyz = body-fixed +Z (spin axis), w = flags BODY_FLAG_* as a float
  meanColor: vec4f,       // rgb = BodyDef.render.meanColor, a = geometricAlbedo
  hapke: vec4f,           // b0, hS, bP, cP
  ocean: vec4f,           // rgb = absorption per metre, a = wind speed at 10 m (m/s)
  rayleigh: vec4f,        // rgb = scattering per metre, a = scale height (m)
  mie: vec4f,             // scattering, absorption (per metre), scale height (m), phase g
  ozone: vec4f,           // rgb = absorption per metre, a = layer centre altitude (m)
  misc: vec4f,            // ozone half width (m), ground albedo, cloud bottom radius, cloud top radius (0 = no clouds)
  reserved0: vec4f, reserved1: vec4f,
}
struct LightUniform { posRange: vec4f, endKind: vec4f, intensity: vec4f }   // FrameContext.lights[i]
struct ShineLight { dir: vec4f, illuminance: vec4f }                         // planetshine, section 7

struct FrameUniforms {
  view: mat4x4f,               // ROOT axes -> view, rotation only (the eye is the origin)
  proj: mat4x4f,               // reversed-Z infinite, WITH TAA jitter
  projUnjittered: mat4x4f,
  viewProj: mat4x4f,           // proj * view: rasterise with this
  viewProjUnjittered: mat4x4f, // motion vectors: current position
  prevViewProj: mat4x4f,       // motion vectors: apply to the position relative to the PREVIOUS eye
  cameraRight: vec4f,          // xyz (ROOT), w = tan(fovX / 2)
  cameraUp: vec4f,             // xyz, w = tan(fovY / 2)
  cameraForward: vec4f,        // xyz, w = near plane (0.05 m)
  prevEyeOffset: vec4f,        // xyz = previous eye - current eye (m)
  renderSize: vec4f,           // w, h, 1/w, 1/h (internal resolution)
  displaySize: vec4f,          // w, h, 1/w, 1/h (canvas)
  jitter: vec4f,               // xy = jitter in render px, zw = in NDC (already inside proj)
  time: vec4f,                 // realTime (s), realDt (s), frameIndex, animate (1 / 0)
  exposure: vec4f,             // exposure, ev100, qualityScale, renderScale
  sunDir: vec4f,               // xyz = unit direction to the star at the camera, w = angular radius (rad)
  sunIlluminance: vec4f,       // rgb = colour x illuminance at the camera (lux, unoccluded), a = lux
  misc: vec4f,                 // x = map fill light, y = sun visibility at the camera, zw = blue-noise offset
  counts: vec4u,               // x = bodies, y = lights, z = frame index, w = star body index (0xffffffff = none)
  cloudNear0: vec4f, cloudNear1: vec4f, cloudNear2: vec4f, cloudFar: vec4f,   // setCloudShadowParams, section 7
  bodies: array<BodyUniform, 4>,
  shine: array<ShineLight, 10>,       // receiver r (frame body index, or 4 = free space) owns entries 2r and 2r+1
  lights: array<LightUniform, 16>,
}
@group(0) @binding(0) var<uniform> frame: FrameUniforms;
@group(0) @binding(1) var linearClamp: sampler;                // trilinear, clamp
@group(0) @binding(2) var linearRepeat: sampler;               // trilinear, repeat
@group(0) @binding(3) var nearestClamp: sampler;               // non-filtering (depth textures, integer lookups)
@group(0) @binding(4) var shadowCompare: sampler_comparison;   // 'less-equal', linear
@group(0) @binding(5) var blueNoiseTex: texture_2d<f32>;       // 64 x 64 rgba8unorm, 4 decorrelated channels
@group(0) @binding(6) var anisoRepeat: sampler;                // trilinear, 8x anisotropic, repeat (fragment stage only)
```

TypeScript mirror: `FRAME_UNIFORM_OFFSET` / `FRAME_UNIFORM_FLOATS` (`frame/uniforms.ts`). `BODY_FLAG` =
`{ star: 1, atmosphere: 2, ocean: 4, hapke: 8, terrain: 16 }`. At most 4 bodies and 16 lights reach the
shaders (`MAX_BODIES`, `MAX_LIGHTS`); `FrameContext.bodies` lists every snapshot body.

Functions of the `frame` chunk:

| Function | Use |
|---|---|
| `writeHdr(rgb) -> vec3f`, `writeHdr4(rgba)` | mandatory clamp of every HDR write |
| `viewRay(uv) -> vec3f` | unnormalised camera-relative ray through a pixel centre (unit component along the view axis), jitter removed |
| `viewZFromDepth(d)`, `positionFromDepth(uv, d)` | reversed-Z depth -> metres along the view axis / camera-relative position |
| `projectToUv(posRelCam) -> vec4f` | xy = screen UV (y down, unjittered), z = depth, w = clip w |
| `velocityFromClip(currClipUnjittered, prevClip) -> vec2f` | RT3 value |
| `blueNoise(pixel: vec2u) -> vec4f` | 4 blue-noise values in [0, 1); re-offset per frame only while `frame.time.w == 1` |
| `nearestBody(posRelCam) -> i32`, `bodyFlags(i)`, `rootToFixed(i, v)` | body helpers |
| `luminance(rgb)`, `sq(x)`, `saturate3(v)` | small helpers; `PI`, `TWO_PI`, `HDR_MAX`, `NEAR_PLANE` constants |

UV convention: `uv = (0, 0)` is the top-left corner of the target; `ndc = (uv.x * 2 - 1, 1 - uv.y * 2)`.

### Precision rules (ARCHITECTURE section 4)

- World space on the GPU is **camera-relative with ROOT axes**. Compute `object - eye` in float64 on the CPU
  (`FrameContext.bodyPose(id)`, `vesselPose(id)`, or your own float64 maths), narrow to float32, add small
  local offsets in the shader. Clip position = `frame.viewProj * vec4f(posRelCam, 1)`.
- `prev*` values in `BodyPose` / `VesselPose` are relative to the **previous** eye, so
  `prevClip = frame.prevViewProj * vec4f(prevPosRelPrevEye, 1)` is exact under body rotation and orbital
  motion. For a point static in a body frame: `prev = prevCenterRelCam + rotate(prevQFixedToRoot, pFixed)`.
- A fullscreen pass that needs the previous position of a body-fixed point computes, per frame in float64,
  `dM = Rprev * R^T - I` and `t = prevCenter - Rprev * R^T * center` and uses `prev = p + dM * p + t`
  (see `lab/labPlanet.ts`).
- Depth is reversed-Z, infinite far: `depth = 0.05 / viewZ`, sky is exactly 0, compare `greater`.
- For bodies use `BodyUniform.cameraUp.w` (camera radius) and `sunDir.w` (camera altitude, from float64)
  instead of `length(center) - radius`, and the cancellation-free forms `altitudeAt` (chunk
  `atmosphere_common`) and `hitSphere` (`lab/labPlanet.ts`).

---

## 5. Shader library and chunks

`ctx.shaders.register(name, wgsl)` adds or REPLACES a chunk; `ctx.shaders.createModule(label, wgsl)` expands
`#include "name"` lines (each chunk at most once per module, nested includes allowed) and compiles.
Compile errors go to `window.__test.errors` with the expanded line. Pipelines built through
`coreOf(ctx).shaders.tracked(() => ...)` or `coreOf(ctx).fullscreenPipeline(...)` are rebuilt automatically
when a chunk they included is registered again (call `.get()` each frame to obtain the current pipeline).

| Chunk | Provides | Needs declared by the includer |
|---|---|---|
| `frame` | section 4 | - |
| `fullscreen` | `FullscreenOut { position, uv }`, `fullscreenVs` (draw 3 vertices) | - |
| `hash` | `HASH_WGSL` from `src/core`: `hash_u32`, `hash4`, `hash_to_unit` (bit-identical to TS) | - |
| `noise` | `valueNoise3`, `gradientNoise3`, `fbm3`, `interleavedGradientNoise` (includes `hash`) | - |
| `gbuffer` | section 6 | `frame` |
| `brdf` | `Surface`, `AmbientInput`, GGX isotropic + anisotropic (height-correlated Smith), Burley, multiscatter compensation, clearcoat, cloth sheen / translucency: `brdfStandardDirect/Ambient`, `brdfClothDirect/Ambient`, `D_GGX`, `V_SmithGGXCorrelated`, `D_GGX_Anisotropic`, `V_SmithGGXCorrelated_Anisotropic`, `F_Schlick`, `Fd_Burley`, `envBrdfApprox`, `energyCompensation`, `ggxAlpha` | - (includes `frame`, `gbuffer`) |
| `brdf_terrain` (overridable) | `brdfTerrainDirect`, `brdfTerrainAmbient` | `brdf` |
| `brdf_regolith` (overridable) | `brdfRegolithDirect`, `brdfRegolithAmbient`, `hapke`, `hapkeW` | `brdf`, `hapkeLut: texture_2d<f32>` |
| `brdf_water` (overridable) | `brdfWaterDirect`, `brdfWaterAmbient`, `waterAlpha`, `waterBodyColor` | `brdf` |
| `eclipse` | `discVisibleFraction(rs, ro, d)`, `sunVisibility(posRelCam, sunDir)` | - |
| `atmosphere_common` | `altitudeAt`, `transmittanceUvFromRMu` / `rMuFromTransmittanceUv`, `skyIrradianceUvFromRMuS` / `rMuSFromSkyIrradianceUv`, `skyViewUv`, `aerialSliceToDistance` / `aerialDistanceToSlice`, `atmosphereSunTransmittance(lut, bodyIndex, r, mu)` | - |
| `shadows` | `ShadowUniforms`, `sampleSunShadow(posRelCam, n, pixel)`, `shadowCascadeIndex(posRelCam)` | `shadowCascades`, `shadowU` (binding set `shadow`) |
| `shadow_pass` | `ShadowPassUniforms`, `shadowPass` at `@group(1) @binding(0)` | - |
| `transparency` | `applyAtmosphere(uv, distance, colour, alpha)` | `aerialPerspectiveTex`, `cloudsScreenTex`, `cloudsDepthTex` (binding set `transparency`) |
| `upsample` | `upsampleDepthAware(src, depthHalf, uv, fullDepth, useNearest)` | - |

### Overridable BRDF chunks (fixed signatures)

The deferred lighting module includes `brdf_terrain`, `brdf_regolith` and `brdf_water` after `brdf`.
Register a chunk with the same name to replace the default; lighting is rebuilt on the next frame.
Each chunk must define exactly these two functions (helpers may be added, prefixed with the chunk's
topic to avoid name clashes):

```wgsl
// "brdf_terrain"  (MATERIAL_TERRAIN; s.param = wetness 0..1, not yet applied)
fn brdfTerrainDirect(s: Surface, l: vec3f) -> vec3f      // BRDF x NoL for a unit light direction l (ROOT axes)
fn brdfTerrainAmbient(s: Surface, a: AmbientInput) -> vec3f   // luminance (cd/m^2) from ambient light
// "brdf_regolith" (MATERIAL_REGOLITH; s.param = crater freshness 0..1)
fn brdfRegolithDirect(s: Surface, l: vec3f) -> vec3f
fn brdfRegolithAmbient(s: Surface, a: AmbientInput) -> vec3f
// "brdf_water"    (MATERIAL_WATER; s.param = encodeWaterDepth(depth), s.albedo = imagery colour)
fn brdfWaterDirect(s: Surface, l: vec3f) -> vec3f
fn brdfWaterAmbient(s: Surface, a: AmbientInput) -> vec3f
```

```wgsl
struct Surface {
  pos: vec3f, viewDist: f32,        // camera-relative position (m), distance from the eye
  n: vec3f, ao: f32,                // unit shading normal (ROOT axes); baked AO x screen-space AO
  v: vec3f, roughness: f32,         // unit vector to the eye; perceptual roughness
  albedo: vec3f, metallic: f32,     // linear base colour
  t: vec3f, anisotropy: f32,        // unit tangent; -1..1
  up: vec3f, altitude: f32,         // local vertical of the nearest body; height above its reference radius (m)
  clearcoat: f32, clearcoatRoughness: f32,
  param: f32,                       // RT2.a (MATERIAL_PARAM)
  lightAlpha: f32,                  // extra GGX alpha for the light being evaluated (sun: 0.6 x angular radius); use ggxAlpha(roughness, s.lightAlpha)
  materialId: u32, bodyIndex: i32,  // bodyIndex = nearest frame body, -1 = none
}
struct AmbientInput {           // the two irradiance terms are ALTERNATIVES (the probe already contains the sky): see section 7
  skyIrradiance: vec3f,     // lux from 'atmosphere.skyIrradianceLut', already tilted to the normal (terrain, water, regolith)
  envIrradiance: vec3f,     // lux from 'env.sh9' along the normal (standard, cloth; regolith on an airless body; 0 otherwise)
  envSpecular: vec3f,       // cd/m^2, 'env.probeCube' along the reflection vector at s.roughness (standard only)
  envSpecularCoat: vec3f,   // the same at the clearcoat roughness
  skyReflection: vec3f,     // cd/m^2, sky along the reflection vector, valid at any distance (terrain, water)
  specularOcclusion: f32,
}
```

`Direct` returns BRDF x cos(theta_i): the caller multiplies by the illuminance (lux) of the light and
gets luminance. Inside the lighting module these names are also in scope for overrides: every binding of
the sets `shadow`, `atmosphereLuts`, `env`, `cloudShadow`, `sceneDepthOpaque`, plus `hapkeLut`
(256 x 4 `r16float`: column = albedo, row = frame body, value = single-scattering albedo w).

Defaults: `brdf_terrain` = Lambert + a low GGX lobe (F0 0.02..0.04); `brdf_regolith` = the Hapke function
of rendering-design 8.2 with the albedo -> w inversion table (rendering at incidence 30 deg, emission 0
reproduces the albedo map exactly), freshness widening and weakening the opposition surge;
`brdf_water` = GGX with F0 0.02 and alpha from the Cox-Munk slope variance `0.003 + 0.00512 U10`
(`BodyUniform.ocean.a`), sky reflection, body colour `albedo * exp(-k d) + deep * (1 - exp(-k d))` with
`d = 2.5 * decodeWaterDepth(s.param)`.

A forward shader (ocean near field) that wants the same water shading includes `brdf` and `brdf_water`,
fills a `Surface` and an `AmbientInput` itself and calls the two functions.

---

## 6. G-buffer

`#include "gbuffer"` (needs `frame`).

```wgsl
struct GBufferOut {                 // return this from every drawGBuffer fragment shader
  @location(0) albedo: vec4f,       // rgb = base colour, write LINEAR (the target is sRGB); a = baked AO / cavity
  @location(1) normal: vec2f,       // octEncode(unit world normal, ROOT axes)
  @location(2) material: vec4f,     // perceptual roughness, metallic, material id / 255, material parameter
  @location(3) velocity: vec2f,     // UV-space velocity, current - previous
  @location(4) extra: vec4f,        // tangent angle, anisotropy * 0.5 + 0.5, clearcoat, clearcoat roughness
  @location(5) emissive: vec4f,     // pre-exposed emitted radiance through writeHdr, a = 1
}
fn gbufferPack(albedo: vec3f, ao: f32, n: vec3f, roughness: f32, metallic: f32, materialId: u32, param: f32,
               velocity: vec2f, emissivePreExposed: vec3f) -> GBufferOut     // RT4 = neutral (0, 0.5, 0, 0)
fn gbufferExtra(n: vec3f, tangent: vec3f, anisotropy: f32, clearcoat: f32, clearcoatRoughness: f32) -> vec4f
fn gbufferUnpack(albedoTexel: vec4f, normalTexel: vec4f, materialTexel: vec4f, extraTexel: vec4f) -> GBufferPixel
fn octEncode(n: vec3f) -> vec2f;  fn octDecode(e: vec2f) -> vec3f
fn tangentFrame(n: vec3f) -> mat3x3f            // canonical (tangent, bitangent, normal); continuous except at n = -Z
fn encodeTangentAngle(n, t) -> f32;  fn decodeTangentAngle(n, enc) -> vec3f
fn encodeWaterDepth(metres: f32) -> f32;  fn decodeWaterDepth(enc: f32) -> f32     // sqrt(depth / 200)
const MATERIAL_STANDARD = 0u; MATERIAL_TERRAIN = 1u; MATERIAL_REGOLITH = 2u; MATERIAL_WATER = 3u; MATERIAL_CLOTH = 4u; MATERIAL_DISPLAY = 5u;
```

Typical fragment shader:

```wgsl
let vel = velocityFromClip(in.currClip, in.prevClip);        // both UNJITTERED clip positions from the vertex shader
var o = gbufferPack(albedo, ao, n, roughness, metallic, MATERIAL_STANDARD, wetness, vel, emissive_cd_m2 * frame.exposure.x);
o.extra = gbufferExtra(n, tangent, anisotropy, clearcoat, clearcoatRoughness);   // MATERIAL_STANDARD only
return o;
```

Material parameter (RT2.a) per id: standard and terrain = wetness; regolith = crater freshness; water =
`encodeWaterDepth(depth)`; cloth = translucency; display = brightness (the emitted colour itself goes to
RT5). RT4 is read for `MATERIAL_STANDARD` only; every other material writes the neutral value that
`gbufferPack` sets.

`MATERIAL_DISPLAY` is an emitter behind a glass front. Write the image at FULL brightness to RT5 (cd/m^2
x exposure, as any emissive), the brightness 0..1 to RT2.a, the off-state colour of the panel to RT0 and
the roughness of the glass to RT2.r. The deferred pass shades it as a dielectric (F0 0.04, never
metallic, no wetness, no anisotropy or clearcoat) and emits `RT5 x brightness x (1 - (1 - NoV)^5)`: the
stated luminance head-on, fading into the reflection at grazing angles (the transmission of the glass
relative to normal incidence). Do not pre-multiply the brightness into RT5.

Emissive: luminance in cd/m^2 times `frame.exposure.x`. Velocity of sky pixels stays 0 (TAA reprojects
depth-0 pixels by camera rotation).

**Reading the G-buffer back** (hooks from `drawWater` on; added in wave 2 for request `ocean-1`). The keys
`'gbuffer.albedo'` (RT0; the target is sRGB, so a read returns linear colour; a = baked AO),
`'gbuffer.normal'` (RT1) and `'gbuffer.material'` (RT2) hold this frame's G-buffer at render resolution;
binding set `gbuffer` (section 11) declares `gbufferAlbedoTex`, `gbufferNormalTex`, `gbufferMaterialTex`.
Read with `textureLoad(tex, vec2i(fragCoord.xy), 0)` and decode with this chunk:

```wgsl
let m = textureLoad(gbufferMaterialTex, px, 0);              // roughness, metallic, id / 255, parameter
let id = u32(m.b * 255.0 + 0.5);                             // MATERIAL_WATER where the far sheet is underneath
let n = octDecode(textureLoad(gbufferNormalTex, px, 0).xy);  // unit normal, ROOT axes
let albedo = textureLoad(gbufferAlbedoTex, px, 0).rgb;       // linear; for water: the imagery colour
let depth = decodeWaterDepth(m.a);                           // metres, MATERIAL_WATER only
```

Or all at once: `gbufferUnpack(albedoTexel, normalTexel, materialTexel, vec4f(0.0, 0.5, 0.0, 0.0))` (RT4 is
not published: pass the neutral value). Inside `'ocean.nearField'.fadeStart` the far sheet is discarded, so
the three targets hold the seabed (terrain or regolith material) there and the sheet outside it. RT3
(velocity) is an attachment of the water pass, RT4 and RT5 are consumed by lighting: none of them is
published. Before the first frame the keys return 1 x 1 zero textures.

Far water (terrain): `MATERIAL_WATER`, albedo = imagery colour, roughness = resolved roughness (0 = none),
param = `encodeWaterDepth(depth)`, normal = the sea surface normal. Honour `'ocean.nearField'`
(`OceanNearField { bodyIndex: i32, fadeStart, fadeEnd, reserved: f32 }`, binding set `oceanNearField`):
discard the sheet where the eye distance is below `fadeStart` and `bodyIndex` is your body.

---

## 7. Lighting inputs: what features publish and how the core reads it

Deferred lighting per pixel: `sun illuminance x sunVisibility (eclipses, the body's own night side) x
atmosphere transmittance x cloud shadow x cascade shadow x contact shadow`, plus ambient, planetshine, local
lights, the map fill light and RT5 emissive. Eclipses and planetshine are computed by the core.

| Key | Format and meaning the core assumes | Default |
|---|---|---|
| `atmosphere.transmittanceLut` | `texture_2d_array<f32>` 256 x 64 `rgba16float`, one layer per body WITH an atmosphere, in frame-body order (layer index = `BodyUniform.fixedX.w`). Bruneton (r, mu) mapping = `transmittanceUvFromRMu`. rgb = transmittance to the top of the atmosphere for rays that do not hit the ground. | white |
| `atmosphere.skyIrradianceLut` | `texture_2d_array<f32>` 64 x 16, same layers; `skyIrradianceUvFromRMuS`. rgb = sky illuminance on a HORIZONTAL surface in lux (absolute, not pre-exposed). The core tilts it with `0.5 + 0.5 dot(n, up)`. | black |
| `atmosphere.skyViewLut` | `texture_2d<f32>` 192 x 108, `skyViewUv(dir, up, sunDir)`, rgb = sky luminance around the camera in cd/m^2. Used for water / terrain sky reflection within 50 km of the camera (beyond: sky irradiance / pi). | black |
| `env.probeCube` | `texture_cube<f32>` with mips, ROOT axes, cd/m^2 (not pre-exposed), GGX-prefiltered: mip = roughness x (mipCount - 1). Standard materials only. | black |
| `env.sh9` | uniform `array<vec4f, 9>`: IRRADIANCE coefficients (cosine lobe already convolved), lux, real SH basis in ROOT axes, order `Y00, Y1-1 (y), Y10 (z), Y11 (x), Y2-2 (xy), Y2-1 (yz), Y20 (3z^2-1), Y21 (xz), Y22 (x^2-y^2)` with the usual constants (0.282095, 0.488603, 1.092548, 0.315392, 0.546274). `E(n) = sum c_i Y_i(n)`. The probe INCLUDES the sky as seen from the active vessel (rendering-design 8.3). Standard and cloth; regolith on a body without an atmosphere table. | 0 |
| `clouds.shadowMap` | `texture_2d<f32>`, r = cloud optical depth along the local vertical, orthographic around the camera. Placement by `coreOf(ctx).setCloudShadowParams({ near: { bodyIndex, originRelCam, axisU, axisV, halfExtent, opticalDepthScale } })` every frame; uv = `0.5 + 0.5 * dot(p - origin, axis) / halfExtent`; transmittance = `exp(-r * scale / max(mu_s, 0.05))`. Fades to the far term over the outer 1/8. | off |
| `clouds.coverageMap` | `texture_2d<f32>` equirect (row 0 = north, column 0 = lon -180), r = coverage. `setCloudShadowParams({ far: { bodyIndex, layerRadius, opticalDepth, longitudeOffset } })`: transmittance = `exp(-coverage * opticalDepth / max(mu_s, 0.05))` at the point where the sun ray crosses `layerRadius`. | off |
| `FrameContext.lights` | push `LocalLight`s in `prepare`: point or capsule (closest point on the segment), `intensity` in cd, inverse square with a smooth window reaching 0 at `range`. At most 16 per frame. Unshadowed. | - |

- Sun colour and illuminance come from `BodyDef.emission` and the distance (`frame.sun`); the direction used
  for a pixel is `BodyUniform.sunDir` of its nearest body.
- `sunVisibility()` (chunk `eclipse`) is the exact lens-area fraction of the solar disc against every
  non-star body, including the body the pixel is on: that is the planet's shadow, the terminator penumbra
  and both kinds of eclipse. Atmosphere shaders use the same function for the sun term of a sample.
- `atmosphereSunTransmittance` handles points above the shell (ray moved to its entry point) and clamps mu
  to the horizon; the solid body's shadow is NOT in it (multiply by `sunVisibility`).
- Planetshine: for each receiver (each frame body, and free space at the camera) the two strongest other
  bodies as directional lights, `E = E_sun x geometricAlbedo x (R / d)^2 x Phi(phase)` (Lambert sphere),
  coloured by `meanColor`, faded out closer than 4 R (there the environment probe must carry it). A pixel
  uses its nearest body's list when it is lower than half a radius above it, else the free-space list.
  It has no shadow map: it is multiplied by the pixel's BAKED occlusion (RT0.a), as the probe ambient is,
  so a closed interior that writes AO 0 receives no planetshine through its walls (request `cockpit-2`).
- Cloth (`MATERIAL_CLOTH`) is lit on both sides (wrapped diffuse and translucency), so its sun-shadow
  lookup uses the normal turned towards the sun: a caster between the fabric and the sun shadows the lit
  side and the back-lit side alike (request `cockpit-1`). Every other material keeps the early-out for faces
  turned away from the sun.
- Ambient by material. The sky irradiance table and the probe are alternatives, never summed on one
  surface, because the probe already contains the sky: terrain and water use the table (never the probe);
  standard, cloth and display use `env.sh9` alone (+ `env.probeCube` specular for standard and display),
  so publishing the table does not change them; regolith uses the table on a body that has an atmosphere
  layer and `env.sh9` on an airless one. `brdfStandardAmbient` and `brdfClothAmbient` ignore
  `AmbientInput.skyIrradiance`; a forward shader that fills an `AmbientInput` itself follows the same rule.
- `CameraState.fillLight` adds `albedo x fill x E_sun / pi` (map view only).

Cloud-shadow placement stays with `setCloudShadowParams` (lead decision on `docs/requests/render-core-1.md`,
declined): it is per-frame CPU data, and one path is clearer than a second, GPU-side one. The contract
comment of `'clouds.shadowMap'` in `src/core/contracts/render.ts` says so.

---

## 8. Sun shadows

Sampling (any shader, any pass after the shadow passes):

```wgsl
#include "shadows"
// + the declarations of createSceneBindings(group, first, ['shadow']):
//   var shadowCascades: texture_depth_2d_array;   var<uniform> shadowU: ShadowUniforms;
let lit = sampleSunShadow(posRelCam, normalRootAxes, vec2u(fragCoord.xy));   // 0 shadowed .. 1 lit
```

```wgsl
struct ShadowCascade {
  viewProj: mat4x4f,   // camera-relative ROOT axes -> shadow clip (xy in [-1, 1], z = 0 at the sun side .. 1), valid THIS frame
  params: vec4f,       // x = texel size along u (m), y = depth range (m), z = blend weight 0..1, w = texel size along v (m; smaller than x in a cascade fitted to its receivers)
  lightDir: vec4f,     // xyz = unit direction to the sun of this cascade (ROOT), w = half extent along u (m)
  axisU: vec4f,        // xyz = world direction of +u, w = array layer of 'shadow.cascades'
  axisV: vec4f,        // xyz = world direction of +v, w = flags: 1 = re-rendered every frame, 2 = fitted to a whole body
}
struct ShadowUniforms {                 // 'shadow.uniforms', 1056 bytes (SHADOW_UNIFORM_BYTES)
  count: vec4u,                         // x = cascades in use; cascades[0 .. count) in sampling order
  settings: vec4f,                      // penumbra slope (2 tan(sun angular radius)), 1 / map size, map size, normal offset (texels)
  cascades: array<ShadowCascade, 8>,
}
```

`sampleSunShadow` walks the cascades in order (camera-fitted from the finest outwards, then body-fitted),
takes the first one that contains the point, cross-fades to the next over the outer 10 % by blue-noise
dither (TAA resolves it), and filters with PCSS-lite: 8-tap blocker search, 12-tap rotated Vogel PCF whose
radius follows the blocker distance and the true solar angular size (min 1.5, max 12 texels), normal-offset
bias (0.7 texel x sin of the incidence angle) plus an exact receiver-plane depth bias per tap (so grazing
light, e.g. the terminator in a 1.9 km whole-body cascade, neither shows acne nor loses low relief). Returns
1 where no cascade covers the point, on faces turned away from the sun, and with the default resources.

**Low sun.** At a sun elevation e one shadow texel covers 1 / sin(e) texels of ground along the light
(4 at 14 deg, 10 at 6 deg), so a one-texel step of a shadow edge is that long on the ground. Two things
keep the edges of the staggered cascades straight:

- *Receiver fit* (CPU, `cascadeMath.ts`). A staggered camera cascade holds body-fixed casters only, so
  everything it shadows is ground. Its footprint is narrowed along v (the map axis in the vertical plane
  of the light) from the square around the camera to the band that the terrain shell
  (`BodyDef.terrain.minElevation .. maxElevation`) occupies inside the cascade's reach (its radius, or the
  horizon if nearer): half height `radius x 2^(-k/2)`, k = 0..8, the narrowest step that holds the band
  with 25 % to spare. The map is turned so that v lies along the local vertical. The 200 km cascade of a
  100 km lunar orbit at 14 deg sun gets 2.8 times, the 1500 km cascade seen from 1000 km at 6 deg 5.7 times
  finer texels along the light. Band and orientation are kept from capture to capture (same texel grid)
  until the band no longer holds the ground, a narrower step would do, or the vertical has turned 10 deg;
  each of those re-phases the grid once. Cascades whose relief is as large as they are (8 km and below
  with the global elevation range) and all every-frame cascades stay square.
- *Receiver-space kernel* (shader). The PCF kernel is laid out along the receiver: "along" = the map
  direction in which the receiver plane recedes from the light, "across" = constant depth. In staggered
  cascades the 1.5 texel minimum is widened across the light until the kernel is round on the receiver
  (at most 4 times), which averages the steps of an edge instead of leaving them as teeth; taps in the
  widened part only count blockers that stand clear of the receiver plane by a slope of 0.3, so relief
  beside the receiver does not darken it. Every-frame cascades keep the round 1.5 texel minimum (thin
  shadows of nearby hardware stay crisp).

Measured on a 150 km straight ridge (`shadows.spec.ts`, 1280 x 720): low orbit at 14 deg, residual of the
shadow edge against a smooth curve 0.54 px rms / 0.99 px max with a 6.8 px penumbra (before: 1.33 / 2.33
px with 15 px); the terminator at 6 deg from 1000 km, 0.18 / 0.41 px (before: a comb of 70 km fringes).

Cascades (ARCHITECTURE 10.1): radii 12 m, 60 m, 300 m, 1.5 km, 8 km, 40 km, 200 km, 1500 km around the
camera (texel = 2 r / 2048 along u; along v the same or finer, see above), a `depth32float` 2048^2 x 8 array.

- **Anchoring.** Each cascade is captured in the body-fixed frame of the nearest body (cascade 0 in the
  active vessel's frame for an interior camera): light basis, extents and a texel-snapped centre are stored
  in anchor coordinates. `ShadowCascadeView.viewProj` and `shadow.uniforms` are re-derived EVERY frame in
  float64 as capture matrix x current anchor pose, so a cascade rendered several frames ago still matches
  the ground it was rendered from. The centre is snapped in whole texels RELATIVE to the previous capture
  of the same cascade, so the grid does not re-phase when the sun (and with it the light basis) turns.
- **Schedule.** `everyFrame` cascades: the 12 m and 60 m ones always, plus any cascade that a vessel reaches
  into unless the vessel and the room for its shadow fit in the next finer cascade (at most 4). The others
  are staggered: every 2nd, 2nd, 4th, 4th, 8th, 8th frame, and re-captured early when the sun has moved
  0.05 deg in the anchor frame (time warp) or the camera has moved 15 % of the radius.
- **Which cascades exist.** Cascades that reach neither a vessel nor the ground are dropped (low orbit:
  12 m, 60 m, 200 km, 1500 km). A terrain body gets a `fit: 'body'` cascade covering its whole sunlit
  disc (radius 1.1 x (R + maxElevation): 1.9 km per texel for the Moon) when it is the nearest body and its
  visible ground extends beyond the camera cascades (weight ramps with horizon distance / 1500 km from 0.8
  to 1.0, so the hand-over on approach is a cross-fade), or when it is another body larger than 64 px on
  screen (fades in from 32 px). At most 8 cascades: the four nearest camera cascades, then body cascades,
  then the far camera cascades.

**Rules for casters** (`drawShadow(frame, pass, cascade)`):

1. Pipeline: depth-only, `format: 'depth32float'`, `depthCompare: 'less'`, `depthWriteEnabled: true`,
   `primitive.unclippedDepth: true` (casters between the map and the sun are pancaked onto the near plane),
   cull `none` recommended, `depthBias: 2, depthBiasSlopeScale: 1.5`.
2. Layout: group 0 = `ctx.frameBindGroupLayout`, group 1 = `coreOf(ctx).shadowPassLayout`; both are already
   bound when the hook is called. `#include "shadow_pass"` and output
   `shadowPass.viewProj * vec4f(posRelCam, 1.0)`.
3. Draw **body-fixed casters** (terrain, rocks, site structures; anything static in `cascade.anchor`'s body
   frame) into every cascade whose anchor is their body. Draw **moving casters** (vessels, debris, canopies)
   ONLY when `cascade.everyFrame` is true. A staggered cascade must never contain anything that moves
   relative to its anchor.
4. Cull against `cascade.viewProj` (float64, this frame): `|clip.x|, |clip.y| <= 1 + margin`; skip casters
   smaller than half of `cascade.texelSize`. Do not cull by clip z on the sun side (pancaking). The
   footprint is not always a square around the camera (receiver fit, above): never cull by distance from
   the camera or by `cascade.farDistance`, only by the clip rectangle. `cascade.texelSize` is the texel
   along u, the coarser of the two: pick terrain LODs from it. `cascade.texelSizeV` is the texel along v
   (equal for a square cascade, finer for a receiver-fitted one).
5. `cascade.index` is the array layer (stable for the lifetime of a cascade), `cascade.fit` tells a
   whole-body cascade (`farDistance` is Infinity): terrain should draw coarse resident tiles of that body.

The mesh system implements rules 1-4 (`MeshInstance.bodyFixed`).

---

## 9. Transparents

Everything drawn in `drawTransparent` is drawn after the atmosphere and cloud composite, so it must apply
the aerial perspective and hide behind clouds itself:

```wgsl
#include "transparency"
// + createSceneBindings(group, first, ['transparency']):  aerialPerspectiveTex, cloudsScreenTex, cloudsDepthTex
let c = applyAtmosphere(uv, distanceFromEyeMetres, premultipliedPreExposedRgb, alpha);   // -> vec4f(rgb, alpha)
return vec4f(writeHdr(c.rgb), c.a);        // blend: src one, dst one-minus-src-alpha
```

- `'atmosphere.aerialPerspective'`: 32^3 `rgba16float`, xy = screen UV, w = `aerialDistanceToSlice(d) / 32`
  with `aerialSliceToDistance(s) = 50 m x (2^(s/2) - 1)` (texel centre of layer k is s = k + 0.5; 21 m to
  3277 km). rgb = in-scattered luminance from the eye to that distance in cd/m^2 (NOT pre-exposed),
  a = transmittance. Default (0, 0, 0, 1).
- `'clouds.screen'` (a = transmittance through the clouds) and `'clouds.depth'` (metres to the cloud in
  front of the pixel, 3.0e38 = none): a fragment farther than the cloud is multiplied by the cloud
  transmittance, with a smooth transition between 0.9 and 1.1 times the cloud distance.
- With the default resources `applyAtmosphere` returns its input bit-exactly.
- Volumes: call it per march sample with the sample's distance, or once with the distance of the volume's
  centre when the volume is small against the atmosphere.

Half-resolution volumes (plumes, smoke, plasma): render in `preTransparent` into
`core.createTarget(label, 'rgba16float', 0.5)` (same size as `'scene.depthHalf'`), marching each ray to
`viewZFromDepth(depthHalf.r)` (the FARTHEST depth of the 2 x 2 block); composite in `drawTransparent` with

```wgsl
#include "upsample"
let v = upsampleDepthAware(myHalfTex, sceneDepthHalfTex, uv, textureLoad(sceneDepthTex, pixel, 0), false);
```

which weights the four nearest half-resolution texels by bilinear weight x depth similarity and falls back
to the closest-depth texel at silhouettes. `labs/render-core/probes.ts` (`volume`) is a complete example.

Refraction (glass, heat shimmer): `requires: ['scene.colorCopyTransparent']` and sample it; for water use
`'scene.colorCopy'` + `'scene.depthOpaque'` in `drawWater`.

---

## 10. Mesh system

`const meshes = coreOf(ctx).meshes;`

```ts
interface MeshSystem {
  createModel(data: ModelData, options?: { lodPixels?: readonly number[] }): ModelHandle;
  registerProceduralTexture(id: string, texture: { width: number; height: number; data: Uint8Array }): void;  // rgba8
  createBatch(label: string): MeshBatch;
  isIdle(): boolean;                         // no texture still loading
}
interface MeshBatch {
  begin(frame: FrameContext): void;          // in prepare
  add(model: ModelHandle, instance: MeshInstance): void;
  finish(): void;                            // uploads; once per frame after the last add
  drawGBuffer(pass: GPURenderPassEncoder): void;
  drawShadow(pass: GPURenderPassEncoder, cascade: ShadowCascadeView): void;
  readonly stats: { instances: number; triangles: number; shadowTriangles: number };
  destroy(): void;
}
interface MeshInstance {
  originRelCam: Vec3; q: Quat;               // model origin relative to the camera (float64), model -> ROOT
  scale?: number | [number, number, number];
  prevOriginRelCam?: Vec3; prevQ?: Quat;     // previous frame, relative to the PREVIOUS eye (default: no screen motion)
  bodyFixed: boolean;                        // caster class (section 8)
  castShadow?: boolean;                      // default true
  temperature?: number;                      // K; above 500 K adds black-body emission (0.85 x (1 - 0.6 metallic) emissivity)
  soot?: number; frost?: number; wetness?: number;   // 0..1, multiplied by the vertex masks b / a (soot, frost)
  fade?: number;                             // dither fade 0..1 (1 = solid); below 0.5 the instance casts no shadow
  emissiveScale?: number;                    // multiplies PbrMaterialDef.emissive
  displayBrightness?: number;                // 'display' materials: brightness 0..1 -> RT2.a (default 1; section 6)
}
function instanceInFrame(parent: ParentPose, localPos: Vec3, localRot: Quat | null, rest): MeshInstance
// ParentPose = { originRelCam, q, prevOriginRelCam, prevQ }: a VesselPose is one; for a body use
// { originRelCam: pose.centerRelCam, q: pose.qFixedToRoot, prevOriginRelCam: pose.prevCenterRelCam, prevQ: pose.prevQFixedToRoot }
```

- `ModelData`: LOD 0 first; all LODs share `materials`. Vertex streams are used as given (positions,
  normals, tangents xyzw, uvs, optional masks rgba8: r = edge wear, g = baked AO, b = soot weight,
  a = frost weight; without masks: wear 0, the others 1).
- Materials (`PbrMaterialDef`): `shading` selects the material id; `anisotropy`, `clearcoat`,
  `clearcoatRoughness` go to RT4 (standard only); `translucency` to RT2.a (cloth); for `display` RT2.a is
  `MeshInstance.displayBrightness` and `emissive` is the image at full brightness; `emissive` in cd/m^2;
  `doubleSided` disables culling and flips the normal on back faces. Textures: `baseColor` and `emissive`
  are sRGB, `normal` is tangent-space (rgb * 2 - 1, +Y up in v), `orm` is r = AO, g = roughness factor,
  b = metallic factor; each string is a registered procedural id or a URL (absolute, or relative to
  `ctx.assetsUrl`), loaded with `createImageBitmap(..., { premultiplyAlpha: 'none', colorSpaceConversion:
  'none' })` and a full mip chain. Until a texture has loaded the factor alone is used.
- LOD: projected diameter of the bounding sphere in render pixels; LOD i + 1 replaces LOD i below
  `lodPixels[i]` (default 220, 60, 16). Within +-15 % of a switch size both LODs are drawn with
  complementary blue-noise dither patterns (TAA resolves the cross-fade); shadows use the dominant LOD.
- Culling: view frustum per instance for the G-buffer; cascade footprint and half-texel size for shadows.
- Specular anti-aliasing: Kaplanyan-Hill roughness widening from the screen-space normal derivatives.
- Wear / soot / frost / wetness are applied for `standard` and `terrain` shading.
- **Wet line.** The mesh system reads `'ocean.wetness'` (published by the ocean feature: the physics swell
  plane, an influence radius and the wet line for up to 8 vessels at the water). A `standard` / `terrain`
  fragment within `plane.w` of a slot's plane point whose height above the plane is below the wet line
  (`normal.w`, 2 cm soft edge) gets wetness 1, combined by max with `MeshInstance.wetness`. Nothing to do in
  the vehicle package: a hull drawn through a `MeshBatch` shows its wet line as soon as the ocean publishes
  the buffer. With the default buffer (count 0) the output is unchanged bit for bit.
- One batch = one storage buffer and a handful of draw calls per (model, LOD, caster class, material).
  Use one batch per feature (or per logical group); `begin` / `finish` every frame.

Primitive builders for labs and props: `boxMesh`, `sphereMesh`, `planeMesh`, `cylinderMesh` (with tangents).

---

## 11. Utilities: `coreOf(ctx)`

```ts
interface CoreApi {
  meshes: MeshSystem;
  shaders: CoreShaderLibrary;                 // + has(), chunkVersion(), expand(), tracked(build), pendingCompilations()
  mips: MipGenerator;                         // mips.generate(texture): render-based mip chain (needs RENDER_ATTACHMENT)
  shadowPassLayout: GPUBindGroupLayout;       // group 1 of drawShadow pipelines
  reportError(message: string): void;         // -> window.__test.errors
  createSceneBindings(group, firstBinding, sets): SceneBindings;
  fullscreenPipeline(desc): Tracked<GPURenderPipeline>;
  createTarget(label, format, scale, usage?): ManagedTarget;   // follows the internal resolution
  setCloudShadowParams(params): void;         // section 7
  createTextureChecked(desc): GPUTexture;     // out-of-memory error scope; use for every large allocation
}
```

**Binding sets.** `createSceneBindings(group, firstBinding, ['shadow', 'atmosphereLuts', ...])` returns
`{ wgsl, layoutEntries, nextBinding, entries(), version() }`: paste `wgsl` into the module, spread
`layoutEntries` into your bind group layout, rebuild the bind group from `entries()` whenever `version()`
changes. Sets and the names they declare:

| Set | Declarations |
|---|---|
| `shadow` | `shadowCascades: texture_depth_2d_array`, `shadowU: ShadowUniforms` (include chunk `shadows`) |
| `transparency` | `aerialPerspectiveTex: texture_3d<f32>`, `cloudsScreenTex`, `cloudsDepthTex: texture_2d<f32>` |
| `sceneDepth` / `sceneDepthOpaque` | `sceneDepthTex` / `sceneDepthOpaqueTex: texture_depth_2d` (read with `textureLoad`) |
| `sceneDepthHalf` | `sceneDepthHalfTex: texture_2d<f32>` (unfilterable; `textureLoad`) |
| `sceneColor` / `sceneColorTransparent` | `sceneColorTex` / `sceneColorTransparentTex: texture_2d<f32>` |
| `atmosphereLuts` | `transmittanceLut`, `skyIrradianceLut: texture_2d_array<f32>`, `skyViewLut: texture_2d<f32>` |
| `env` | `envProbeCube: texture_cube<f32>`, `envSh9: EnvSh9` (`struct EnvSh9 { c: array<vec4f, 9> }`) |
| `cloudShadow` | `cloudShadowMapTex`, `cloudCoverageMapTex: texture_2d<f32>` |
| `oceanNearField` | `oceanNearField: OceanNearField` |
| `oceanWetness` | `oceanWetness: OceanWetness` (`struct OceanVesselWater { plane, normal, params: vec4f }`, `struct OceanWetness { count: vec4u, vessels: array<OceanVesselWater, 8> }`; meaning in the `'ocean.wetness'` contract comment) |
| `gbuffer` | `gbufferAlbedoTex`, `gbufferNormalTex`, `gbufferMaterialTex: texture_2d<f32>` (`textureLoad`; never in a group set inside `drawGBuffer`) |

Visibility of the entries is fragment + compute (uniform buffers also vertex).

**Fullscreen passes.** `fullscreenPipeline({ label, fragment, targets, layouts?, depthStencil? })`: `fragment`
is WGSL with `@fragment fn fs(in: FullscreenOut) -> ...`; `frame` and `fullscreen` are included for you;
`layouts` are groups 1... Draw with `pass.setPipeline(p.get()); pass.draw(3);`. The triangle is at clip
z = 0: with `depthCompare: 'equal'` it touches sky pixels only, with `'less'` geometry pixels only.

**Targets.** `createTarget(label, format, scale)` returns `{ texture, view, size, version, destroy() }`;
texture and view are replaced (and `version` incremented) when the internal resolution changes.

Also exported from `@/render/core`: `MipGenerator`, `createSolidTexture`, `createTextureChecked`,
`readTexturePixels`, `f32ToF16` / `f16ToF32`, `mipCount`, frame maths (`buildProjection`, `taaJitter`,
`sunAt`, `sunVisibilityAt`, `planetshineAt`, `discVisibleFraction`), exposure helpers (`sunny16Ev`,
`exposureFromEv100`, `ev100ForMidGrey`).

`CoreRenderer` (what `createRenderer` returns) adds to the `Renderer` contract: `core`, `resources`
(`reset(key)`, `isDefault(key)`), `setDeterministic(on)`, `setJitter(enabled)` (identical sub-pixel sampling
every frame, for A/B readbacks), `setExposureOverride(ev100 | null)`, `exposureInfo()`,
`readHdrPixels(target?, rect?)` and `readHdrStats(target?)` with target `'hdr'` (the scene target before
TAA, internal resolution) or `'resolved'` (TAA output, display resolution), `readDepth()` (`'scene.depth'`),
`resetPerf()`, `passStats()`, `featureOrder()`, `frameContext`.

`createRenderer(canvas, gpu, defs, options)`: `options.quality` (partial `QualitySettings`),
`tilesUrl` / `skyUrl` / `assetsUrl`, `onError`, `perfFeatures` (attribution mode), `governor` (partial
`GovernorConfig`: `budgetMs`, `pressure`, `recovery`, `qualityMin`, ...).

---

## 12. Photometric conventions

Luminance in cd/m^2, illuminance in lux, linear sRGB primaries. Before writing to the HDR target multiply
by `frame.exposure.x` and clamp with `writeHdr`.

| Quantity | Value |
|---|---|
| Solar illuminance above the atmosphere | 128,000 lux (`BodyDef.emission`, scaled by 1 / d^2); colour (1.036, 0.994, 0.953) |
| Solar disc | angular radius 0.00465 rad; mean luminance E / (pi sin^2) = 1.9e9 cd/m^2 |
| Lambert surface, albedo rho, sun at incidence theta | L = rho E cos(theta) / pi: white (0.8) at normal incidence 32,600 cd/m^2; sunlit ground (0.25, about 100,000 lux through the atmosphere) about 8,000 = 10^4 cd/m^2; lunar regolith (0.12) 4,900 |
| Exposure | `exposure = 1 / (1.2 x 2^EV100)`; EV100 15 -> 2.54e-5 |
| Sunny 16 | `EV100 = log2(E / (1.2 pi))`: 128,000 lux -> 15.05. At that exposure a sunlit 18 % grey card is 0.18 in the HDR target, white (0.8) is 0.8 |
| Earthshine on the Moon at full Earth | 15 lux -> 0.57 cd/m^2 on regolith: 2.2e-5 at EV 15, 0.36 at EV -1 |
| Sun disc in the HDR target | 1.9e9 x exposure: 48,000 at EV 15, far above `HDR_MAX` at lower EV: saturates at 60,000 (intended; it still drives bloom) |
| Magnitude-0 star | 2.54e-6 lux; about 5 cd/m^2 over one 1440p pixel |
| `HDR_MAX` | 60,000 (pre-exposed). `rgba16float` overflows at 65,504 |

Emissive surfaces state luminance directly (`PbrMaterialDef.emissive`): a 300 cd/m^2 display is 0.0076 in
the HDR target at EV 15 (invisible in sunlight) and 0.25 at EV 10.

---

## 13. Exposure, TAA and the governor

- `frame.exposure` / `frame.ev100` are constant within a frame. Auto-exposure meters lit geometry only
  (depth != 0, luminance above 0.008 cd/m^2 and within 10 EV of the brightest lit pixels): arithmetic mean
  of the lit range to mid-grey with the compensation curve `clamp((EV - 4) x 0.08, -1, 0.8)`, capped so
  the 99th percentile stays below 4 x mid-grey. Below 0.5 % lit coverage the photometric prior is used
  alone (sunny 16 x sun visibility at the camera when a lit body, a lit vessel, any lit geometry or the
  unoccluded solar disc itself is in view; EV -3, the dark-adapted floor, otherwise);
  between 0.5 % and 10 % the two are blended. `CameraState.exposureCompensation` (EV, positive = brighter),
  `minEv100` (lower bound of EV100) and `kind: 'interior'` are honoured. An interior view meters the
  geometry within 8 m by its LOG-AVERAGE over everything above the floor, without the 10 EV range and
  without the highlight cap (request `cockpit-3`): a sun patch on a panel, several hundred times brighter
  than the cabin, moves the exposure by less than a stop, so the cabin stays readable and the patch and the
  windows blow out. Exterior and map metering are unchanged. Adaptation 2.5 EV/s towards brighter scenes, 0.8 EV/s towards darker ones.
- TAA / TAAU: Halton(2, 3) jitter of 8 samples (8 / scale^2 when upscaling, at most 32) in `frame.proj`;
  the resolve runs at display resolution (jitter-aware 3 x 3 reconstruction, closest-depth velocity,
  5-tap Catmull-Rom history, YCoCg variance clip), RCAS sharpening in the tonemap pass. Write correct RT3
  velocity for everything that moves on screen, or it will ghost. History weight is halved when the view
  turns more than 2 deg per frame or at warp >= 50x. `frame.animate` is false in deterministic mode: do
  not animate noise then.
- Screen-space AO (GTAO, 2 slices x 6 steps per side) and contact shadows (10 steps towards the sun over
  max(0.3 m, 1.5 % of the distance)) are computed at half resolution from `'scene.depthOpaque'` and RT1;
  AO multiplies ambient light only (`Surface.ao`), the contact term multiplies the sun.
- Bloom is threshold-free and linear (6 levels, 13-tap downsamples, no Karis average), mixed at 4 %; the
  tonemapper is AgX.
- Saturated sources keep their energy (ARCHITECTURE 10.4): the spatial reconstruction of the resolve and the
  bloom chain are linear, and the history clip does not cut very bright values down, so a sun disc of a
  few pixels or a stable glint at `HDR_MAX` reaches the bloom. Measured on a 9-pixel disc at `HDR_MAX`:
  the resolved peak is 60,000 two frames after the disc appears and 95 % of the disc's energy is in the
  resolved image once it has settled. Fireflies are rejected in one place only, the temporal blend of the
  resolve, which runs in a reversible tonemap space: a value that is bright in one jittered frame and dark
  in the others converges towards the dark ones. Two consequences: a highlight smaller than a pixel that
  flickers under the jitter does not bloom (keep sub-pixel emitters stable; the mesh system widens
  roughness for specular AA), and a pixel that turns from dark to saturated takes time to be believed
  unless its whole 3 x 3 neighbourhood is bright: the core of a new source is there at once, its rim
  (and with it the full glow) builds up over about two seconds. Darkening is immediate.
- `frame.qualityScale` (0.5..1): multiply march step counts and particle counts by it. The core lowers it
  when the measured GPU time exceeds 92 % of the 11 ms budget and only when it is at 0.5 lowers the
  internal resolution (`QualitySettings.renderScaleMin..Max`, steps of 1/16); recovery below 72 % runs in
  the opposite order. It is 1 in deterministic mode.

---

## 14. Perf and attribution

- Name your own passes `<featureId>.<pass>`: `timestampWrites: ctx.perf.gpuPass('my-feature.march')`
  (undefined without `timestamp-query`; pass it through). CPU zones: `ctx.perf.cpuBegin/cpuEnd(name)`;
  counters: `ctx.perf.counter(name, value)`.
- `window.__perf` (`PerfSnapshot`, computed on access): rAF, CPU and GPU percentiles over the last 300
  frames, `passes` (latest), `features` (p99 per feature id and `core`), `qualityScale`, `renderScale`.
  `cpu` is the zone named `'frame'` when the app brackets its frame function with
  `ctx.perf.cpuBegin('frame')` / `cpuEnd('frame')` (the lab app does), else the renderer's own time.
- Draws inside core-owned passes (`shadow`, `gbuffer`, `water`, `background`, `transparent`, `overlay`)
  cannot be timed separately in one pass. **Attribution mode** (`createRenderer(..., { perfFeatures: true })`
  or `?perf=features` in a lab) runs each feature's hook in its own pass named `<featureId>.<hook pass>`
  with loadOp `load`: `features[id].gpuMs` is then exact. Perf specs use it. In normal mode one frame in
  64 is rendered in attribution mode and the measured shares split the pass time, so the breakdown stays
  close without the extra passes.
- **Measure with the GPU busy.** An RTX 5090 with only a lab's 1-2 ms of work per frame clocks down:
  the same pass then reads 2-5 times longer and its p99 is unstable (TAA 0.32 ms idle, 0.10 ms inside a
  9 ms frame). Budgets are for the game's frame: add a ballast pass of about 7 ms while measuring (see
  `tests/browser/render-core/core.perf.spec.ts` and the `heavy` probe in `labs/render-core/probes.ts`,
  which encodes it in the `compute` hook, away from the core's copies) with `?governor=off&scale=1` so
  quality and resolution stay at 1. Calibrate any synthetic load while it is running, not on the idle
  GPU (`governor.perf.spec.ts`: a 40-iteration burst on the idle GPU read up to 6 times too slow).
- `renderer.passStats()` gives p50 / p99 / mean per pass name; a pass that does not run in a frame counts
  as 0, so `mean` is the amortised cost (staggered shadow cascades).
- `core.copies` is not a pass: it is the time of the core's texture copies (depth -> `'scene.depthOpaque'`,
  HDR -> `'scene.colorCopy'`, depth -> `'scene.depth'`, HDR -> `'scene.colorCopyTransparent'`), which are
  encoded between passes. Each is timed as the gap from the end timestamp of the pass before it to the
  begin timestamp of the pass after it, and the sum is part of the frame's GPU total (what the governor
  acts on) and of the `core` feature row. All four copies at 1440p: 0.04 ms (p50), 0.05 ms (p99). Two
  caveats of a gap: for the last copy the pass before it is whatever a feature encoded last in
  `compositeAtmosphere` / `preTransparent`, so give every pass of yours a timestamp (`ctx.perf.gpuPass`)
  or its time is counted as a copy; and a gap also holds whatever of the pass before it is still in
  flight (a 7 ms fullscreen pass right before a copy left 0.23 ms in the gap in one frame out of five).
  When `core.copies` looks large in the integrated app, read its p50 and look at the pass before the copy.

---

## 15. Lab app

```ts
// labs/<package>/main.ts
import { createLabApp, createLabPlanetFeature } from '@/render/core/lab';
const app = await createLabApp({
  canvas: document.getElementById('viewport') as HTMLCanvasElement,
  name: 'my-package',
  scene: 'lowOrbit',                         // FakeSim scene (or ?scene=); or sim: mySim / (defs) => mySim
  features: [createLabPlanetFeature(), createMyFeature()],     // or (defs, sim) => [...]
});
```

It acquires the GPU, loads the defs, creates the FakeSim and the renderer, registers the features, runs the
loop, and wires `window.__test` completely (`ready`, `errors`, `adapter`, `state`, `isIdle`, `waitFrames`,
`perf`, `resetPerf`, `hdrStats`, `setDeterministic`, `setPaused`, `camera`, `setCameraOrbit`, `setView`,
`setControls`, `commands`). `window.__lab` is the returned `LabApp`: `renderer`, `sim`, `defs`, `camera`,
`snapshot()`, `cameraState()`, `setPaused`, `setDeterministic`, `onFrame(cb)`, `renderFrame(dt?)`,
`setLoop(running)`.

Options: `scene` | `sim` (a `Sim` or `(defs) => Sim`), `features` (array or `(defs, sim) => array`),
`camera` (a `LabCameraSpec` or `(snapshot, defs) => spec`; camera parameters in the query string win),
`cameraSettings`, `renderer` (RendererOptions), `onFrame`, `autoReady: false` when the page has set-up to
do after `createLabApp` returns (then call `app.testApi.markReady(true)` itself).

Query string: `scene=`, `perf=features`, `scale=<render scale>` (pins the internal resolution),
`governor=off` (pins qualityScale at 1), `ev=<forced EV100>`, `deterministic=1`, `paused=1`, and the camera:

```
body=<id>&lat=&lon=&alt=&heading=&pitch=            on a body (deg, m; heading clockwise from north)
vessel=<id|active>&offset=x,y,z[&look=x,y,z]        relative to a vessel, VES frame (m)
orbit=<yawDeg>,<pitchDeg>,<distance>[&target=vessel:<id>|body:<id>|site:<body>,<lat>,<lon>,<alt>]
fov=<deg>  kind=interior|external|map  ec=<EV>  minev=<EV100>  fill=<fraction>
```

Default: orbit the active vessel at three bounding radii. `window.__test.setCameraOrbit(yaw, pitch,
distance)` orbits the current target; `app.camera.spec = { type: 'free', positionRoot, qViewToRoot }`
places it programmatically. Mouse drag looks / orbits, the wheel zooms.

`createLabPlanetFeature(options?)`: every non-star body as an analytically ray-traced sphere in the G-buffer
with exact depth and velocity: `MATERIAL_REGOLITH` on Hapke bodies, `MATERIAL_TERRAIN` otherwise, albedo
from the tile set's `albedoLowRes` map when it exists (`maps: { [bodyId]: 'tileset' | 'none' | image }`,
`defaultMap`); on ocean bodies ocean-coloured texels become `MATERIAL_WATER` with an encoded depth, and
inside `'ocean.nearField'.fadeStart` the water sheet is replaced by the seabed. `seabedDepth: 'sheet'`
(default since request `ocean-2`): the seabed lies as deep as the sheet's encoded depth at that pixel (4 m on
turquoise shelves .. 200 m in open ocean) and carries the map colour the sheet would have written, so it
describes the same water as the sheet just outside `fadeStart`. `seabedDepth: <metres>`: a fixed sand floor
(the render-core lab: `?seabed=30`). No relief: a backdrop for labs, never used by the app.

Specs follow `tests/browser/shell/lab-template.spec.ts`: `openPage`, `assertDiscreteGpu`,
`window.__test.setDeterministic(true)` + `waitIdle` before screenshots, `expectNoErrors`.
`tests/browser/render-core/*.spec.ts` are worked examples (HDR readback, frame diffs, perf under the lock).

---

## 16. Checklist for a feature

- [ ] Unique `id`; own passes named `<id>.<pass>` with `ctx.perf.gpuPass`.
- [ ] Positions camera-relative from float64; `prev*` relative to the previous eye; RT3 velocity written.
- [ ] G-buffer through `gbufferPack`; emissive pre-exposed; correct `MATERIAL_ID` and parameter.
- [ ] Every HDR write through `writeHdr`; transparents through `applyAtmosphere`.
- [ ] Samples copies (`scene.*`), never live attachments; bind groups rebuilt on `resources.version` change;
      `gbuffer.*` only from `drawWater` on, in a bind group that is never set inside `drawGBuffer`.
- [ ] `drawShadow`: body-fixed casters in every cascade of their body, moving casters only when `cascade.everyFrame`.
- [ ] Scales work with `frame.qualityScale`; no noise animation when `!frame.animate`; `isIdle()` reports loading.
- [ ] Lab page with `createLabApp`, spec with screenshots you looked at, perf spec under `withGpuLock` in attribution mode.

---

## 17. Recipes

Answers to the questions that come up in `docs/requests/`. Each recipe is what the lab probes and specs of
the core do themselves (`labs/render-core/probes.ts`, `tests/browser/render-core/framegraph.spec.ts`), so it
is tested code, not a sketch.

### 17.1 Composite a half-resolution volume (plume, smoke, plasma, fog)

March in `preTransparent` into your own half-resolution target against `'scene.depthHalf'`, composite in
`drawTransparent` with the depth-aware upsample and `applyAtmosphere`.

```ts
init(c) {
  ctx = c; core = coreOf(c);
  target = core.createTarget('my-vfx.half', 'rgba16float', 0.5);        // follows the internal resolution
  transp = core.createSceneBindings(1, 4, ['transparency']);             // aerial perspective + cloud occlusion
  marchLayout = c.device.createBindGroupLayout({ entries: [
    { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
    { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'unfilterable-float' } } ] });   // scene.depthHalf
  compLayout = c.device.createBindGroupLayout({ entries: [
    { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
    { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'unfilterable-float' } },         // scene.depthHalf
    { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },                      // your half-res target
    { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'depth' } },                      // scene.depth
    ...transp.layoutEntries ] });
  march = core.fullscreenPipeline({ label: 'my-vfx.march', layouts: [marchLayout], targets: [{ format: 'rgba16float' }], fragment: MARCH_WGSL });
  comp = core.fullscreenPipeline({ label: 'my-vfx.composite', layouts: [compLayout], fragment: COMPOSITE_WGSL,
    targets: [{ format: RENDER_FORMATS.hdr, blend: { color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' }, alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' } } }],
    depthStencil: { format: RENDER_FORMATS.depth, depthWriteEnabled: false, depthCompare: 'always' } });
},
preTransparent(frame, encoder) {
  const v = target.version + ctx.resources.version('scene.depthHalf') + ctx.resources.version('scene.depth') + transp.version();
  if (v !== version) { version = v; /* rebuild marchGroup and compGroup from target.view and ctx.resources.get(...) */ }
  const pass = encoder.beginRenderPass({ colorAttachments: [{ view: target.view, loadOp: 'clear', storeOp: 'store' }],
    timestampWrites: ctx.perf.gpuPass('my-vfx.march') });               // every pass of yours gets a timestamp
  pass.setBindGroup(0, frame.frameBindGroup);
  pass.setPipeline(march.get()); pass.setBindGroup(1, marchGroup); pass.draw(3);
  pass.end();
},
drawTransparent(_frame, pass) { pass.setPipeline(comp.get()); pass.setBindGroup(1, compGroup); pass.draw(3); },
```

```wgsl
// MARCH_WGSL (frame and fullscreen chunks are included for you)
@fragment fn fs(in: FullscreenOut) -> @location(0) vec4f {
  let ray = viewRay(in.uv); let len = length(ray); let dir = ray / len;
  let tScene = viewZFromDepth(textureLoad(depthHalfTex, vec2i(in.position.xy), 0).r) * len;   // .r = FARTHEST of the 2 x 2 block
  let steps = max(4, i32(f32(BASE_STEPS) * frame.exposure.z));                                // exposure.z = qualityScale
  // ... march from the volume's entry to min(exit, tScene); accumulate PREMULTIPLIED, PRE-EXPOSED colour and alpha
  return vec4f(writeHdr(colour), alpha);
}
// COMPOSITE_WGSL
#include "upsample"
#include "transparency"
@fragment fn fs(in: FullscreenOut) -> @location(0) vec4f {
  let d = textureLoad(depthTex, vec2i(in.position.xy), 0);
  let v = upsampleDepthAware(volTex, depthHalfTex, in.uv, d, false);    // false: the source was marched to depthHalf.r
  let c = applyAtmosphere(in.uv, distanceToVolumeCentre, v.rgb, v.a);   // or per march sample for a volume that is large against the atmosphere
  return vec4f(writeHdr(c.rgb), c.a);
}
```

Rules: never write the HDR target in `preTransparent`; the composite pipeline has `depthWriteEnabled: false`
and blends `one, one-minus-src-alpha`; a draw that covers only part of the screen restores the scissor
before returning. Complete example: the `volume` probe.

### 17.2 Read the seabed, and the far sheet's inputs, in `drawWater`

`requires: ['scene.colorCopy']` on the feature. Two bind groups: the scene copies may be bound anywhere,
the G-buffer set only from `drawWater` on, so it gets a group of its own.

```ts
sceneB = core.createSceneBindings(1, 1, ['sceneDepthOpaque', 'sceneColor', 'oceanNearField']);   // group 1, after your uniform at binding 0
gbufB  = core.createSceneBindings(2, 0, ['gbuffer']);                                            // group 2: never set inside drawGBuffer
// layouts from sceneB.layoutEntries / gbufB.layoutEntries; rebuild a bind group when its version() changes
```

```wgsl
#include "gbuffer"
// + sceneB.wgsl and gbufB.wgsl
let px = vec2i(in.position.xy);
let dBed = textureLoad(sceneDepthOpaqueTex, px, 0);                  // reversed-Z depth of what is under the water
let bed = positionFromDepth(uv, dBed);                               // camera-relative, m (uv = fragCoord / renderSize)
let column = length(bed) - length(surfacePosRelCam);                 // water path along the view ray, m
let litBed = textureLoad(sceneColorTex, px, 0).rgb;                  // lit, pre-exposed: refract by offsetting px
let m = textureLoad(gbufferMaterialTex, px, 0);
if (u32(m.b * 255.0 + 0.5) == MATERIAL_WATER) {                      // the far sheet is underneath (outside fadeStart)
  let imagery = textureLoad(gbufferAlbedoTex, px, 0).rgb;            // s.albedo of the deferred pixel
  let encodedDepth = m.a;                                            // s.param of the deferred pixel
  let nSheet = octDecode(textureLoad(gbufferNormalTex, px, 0).xy);   // its normal; m.r = its roughness
  // fill Surface with exactly these and call brdfWaterDirect / brdfWaterAmbient: the same radiance as the deferred pixel
}
```

Inside `oceanNearField.fadeStart` the sheet is discarded by the terrain renderer, so `gbuffer.*` and the
copies hold the seabed there (its material id is terrain or regolith). When the refracted `px` is offset,
re-test the depth at the offset pixel (a refracted ray must not pick up something in front of the surface).

### 17.3 Cast a moving shadow (vessel, debris, canopy)

With the mesh system: `batch.add(model, { ..., bodyFixed: false })` and call `batch.drawShadow(pass, cascade)`
from your `drawShadow`; the batch skips cascades that are not re-rendered every frame. By hand:

```ts
drawShadow(frame, pass, cascade) {
  if (!cascade.everyFrame) return;                                   // a staggered cascade holds body-fixed casters only
  // cull against cascade.viewProj (float64): |clip.x|, |clip.y| <= 1 + margin; skip casters under half of cascade.texelSize
  pass.setPipeline(shadowPipeline);                                  // groups 0 (frame) and 1 (cascade) are already bound
  pass.setBindGroup(2, instances); pass.draw(...);
}
```

Pipeline: depth-only `depth32float`, `depthCompare: 'less'`, `depthWriteEnabled: true`,
`primitive: { unclippedDepth: true, cullMode: 'none' }`, `depthBias: 2, depthBiasSlopeScale: 1.5`; layout
group 0 = `ctx.frameBindGroupLayout`, group 1 = `coreOf(ctx).shadowPassLayout`; vertex shader
`#include "shadow_pass"` and `return shadowPass.viewProj * vec4f(posRelCam, 1.0);`. A caster that is static
in a body frame (pad structures, rocks) is the opposite case: `bodyFixed: true`, drawn into EVERY cascade
whose `anchor` is its body, including `fit: 'body'` ones. To receive the shadow in a forward shader: binding
set `shadow`, `#include "shadows"`, `sampleSunShadow(posRelCam, n, vec2u(fragCoord.xy))`.

### 17.4 Publish and consume a shared resource

```ts
// publisher (init, and again whenever the texture is re-created)
ctx.resources.publish('atmosphere.skyViewLut', lutTexture.createView());   // same object again = no version bump
// consumer: through a binding set where one exists ...
const b = coreOf(ctx).createSceneBindings(1, 0, ['atmosphereLuts']);
if (b.version() !== seen) { seen = b.version(); group = ctx.device.createBindGroup({ layout, entries: b.entries() }); }
// ... or directly
const view = ctx.resources.get('ui.navball');                              // always usable: the default until published
if (ctx.resources.version('ui.navball') !== seenNavball) { /* rebuild the bind group */ }
```

- A key means what its comment in `src/core/contracts/render.ts` says (format, units, validity). Publish
  views, not textures; keep the texture alive for as long as the view is published.
- Never cache a `get()` result across frames without watching `version()`: targets that follow the internal
  resolution (`scene.*`, `gbuffer.*`, anything from `createTarget`) are replaced when the governor changes it.
- Per-frame CPU parameters are not resources: cloud-shadow placement goes through
  `coreOf(ctx).setCloudShadowParams({ near, far })` in `prepare`, every frame.
- A value that only your package and its lab read does not need a key. A new key is a contract change: file
  a request with the format, the units, who publishes and the neutral default.
- The publisher of a key that the core reads during lighting (`atmosphere.*`, `env.*`, `clouds.shadowMap`,
  `clouds.coverageMap`) must have this frame's content in it before the lighting pass: update it in
  `compute`, not later.

### 17.5 Scale with `qualityScale`

`frame.qualityScale` (CPU) and `frame.exposure.z` (WGSL) are the same number, 0.5..1; it is 1 in
deterministic mode and with `?governor=off`.

```ts
prepare(frame) { particleCount = Math.max(MIN_PARTICLES, Math.round(maxParticles * frame.qualityScale)); }
```

```wgsl
let steps = max(MIN_STEPS, i32(f32(BASE_STEPS) * frame.exposure.z));
let dt = (tEnd - tStart) / f32(steps);          // the same integral with fewer, longer steps: jitter the start with blueNoise
```

- Scale sample counts (march steps, particles, taps), never the result: the image must converge to the same
  picture at every scale, only noisier or softer. Keep a floor under which the effect breaks.
- Do not branch on a threshold of the scale (a switch pops when the governor crosses it); a count that
  changes by one step per frame is hidden by TAA.
- Budgets of ARCHITECTURE 17.1 are stated at scale 1: perf specs run with `?governor=off&scale=1`. The core's
  own passes (AO, lighting, TAA, bloom) do not scale; only when the scale has reached 0.5 does the core lower
  the internal resolution.

---

## 18. Changes in wave 2

Additive unless a migration is stated. Requests: `docs/requests/<id>.md`.

| Change | Request | Affects | Migration |
|---|---|---|---|
| Interior metering uses the log-average of the near histogram (`histogramStats(h, n, litRangeEv)` gained `logMean` and the range argument) | `cockpit-3` | cockpit; anything with `CameraState.kind === 'interior'` | None. A cabin with sun patches is exposed several stops brighter than before; a uniformly lit cabin is unchanged |
| Cloth looks the sun shadow up with the normal turned to the sun; planetshine is multiplied by the baked AO (RT0.a) | `cockpit-1`, `cockpit-2` | cockpit, vehicle-pad (canopies, blankets), anything that bakes AO into RT0.a | None. Surfaces with baked AO below 1 receive that much less planetshine |
| `SharedResourceMap` key `'ocean.wetness'` (uniform, `OCEAN_WETNESS_BYTES` = 400: water plane, influence radius and wet line per vessel at the water; layout in the contract comment), binding set `oceanWetness`; the mesh system applies it as a wet line on `standard` / `terrain` surfaces (section 10) | `ocean-3` | ocean (publishes), vehicle-pad (hulls get the line without a change) | None; the default (count 0) leaves every mesh pixel unchanged |
| LabPlanet: inside `'ocean.nearField'.fadeStart` the seabed follows the sheet (`seabedDepth: 'sheet'`, new default): sheet depth and map colour instead of a 30 m sand floor | `ocean-2` | ocean lab and specs; any lab that publishes a near field over the LabPlanet | A lab that relied on the fixed floor passes `seabedDepth: 30` |
| `SharedResourceMap` keys `'gbuffer.albedo'`, `'gbuffer.normal'`, `'gbuffer.material'` (live RT0 / RT1 / RT2, readable from `drawWater` on) and binding set `gbuffer` (section 6, section 11) | `ocean-1` | ocean (band between `fadeStart` and `fadeEnd`); anyone who wants the material under a pixel after lighting | None. Do not put the set into a bind group that is set inside `drawGBuffer` |
