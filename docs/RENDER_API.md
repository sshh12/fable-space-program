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
TAA, governor · 14 Perf and attribution · 15 Lab app · 16 Checklist

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
| 5 | forward water | `drawWater(frame, pass)` | Colour: target 0 = HDR (blending allowed), target 1 = RT3 velocity. Depth writable, compare `greater-equal`. Sample the seabed from `'scene.depthOpaque'` and `'scene.colorCopy'`. The pass is skipped when no feature has `drawWater`. |
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
struct AmbientInput {
  skyIrradiance: vec3f,     // lux from 'atmosphere.skyIrradianceLut', already tilted to the normal
  envIrradiance: vec3f,     // lux from 'env.sh9' along the normal (0 for terrain and water)
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
`gbufferPack` sets. `MATERIAL_DISPLAY` is lit as a standard surface (glass over the emitter).

Emissive: luminance in cd/m^2 times `frame.exposure.x`. Velocity of sky pixels stays 0 (TAA reprojects
depth-0 pixels by camera rotation).

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
| `env.sh9` | uniform `array<vec4f, 9>`: IRRADIANCE coefficients (cosine lobe already convolved), lux, real SH basis in ROOT axes, order `Y00, Y1-1 (y), Y10 (z), Y11 (x), Y2-2 (xy), Y2-1 (yz), Y20 (3z^2-1), Y21 (xz), Y22 (x^2-y^2)` with the usual constants (0.282095, 0.488603, 1.092548, 0.315392, 0.546274). `E(n) = sum c_i Y_i(n)`. Standard, cloth and regolith. | 0 |
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
- Ambient by material: terrain and water use the sky irradiance LUT (never the probe); standard and cloth
  use `env.sh9` (+ `env.probeCube` specular for standard); regolith uses both irradiance terms.
- `CameraState.fillLight` adds `albedo x fill x E_sun / pi` (map view only).

Request `docs/requests/render-core-1.md` asks for the cloud-shadow placement to become a SharedResources
key; until then `setCloudShadowParams` is the API.

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
  params: vec4f,       // x = texel size (m), y = depth range (m), z = blend weight 0..1, w = fit (0 camera, 1 body)
  lightDir: vec4f,     // xyz = unit direction to the sun of this cascade (ROOT), w = cascade radius (m)
  axisU: vec4f,        // xyz = world direction of +u, w = array layer of 'shadow.cascades'
  axisV: vec4f,        // xyz = world direction of +v, w = 1 when re-rendered every frame
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
bias (1.5 texels, slope scaled) plus a receiver-plane depth bias. Returns 1 where no cascade covers the point
and with the default resources.

Cascades (ARCHITECTURE 10.1): radii 12 m, 60 m, 300 m, 1.5 km, 8 km, 40 km, 200 km, 1500 km around the
camera (texel = 2 r / 2048), a `depth32float` 2048^2 x 8 array.

- **Anchoring.** Each cascade is captured in the body-fixed frame of the nearest body (cascade 0 in the
  active vessel's frame for an interior camera): light basis, extents and a texel-snapped centre are stored
  in anchor coordinates. `ShadowCascadeView.viewProj` and `shadow.uniforms` are re-derived EVERY frame in
  float64 as capture matrix x current anchor pose, so a cascade rendered several frames ago still matches
  the ground it was rendered from.
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
   smaller than half of `cascade.texelSize`. Do not cull by clip z on the sun side (pancaking).
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
}
function instanceInFrame(parent: ParentPose, localPos: Vec3, localRot: Quat | null, rest): MeshInstance
// ParentPose = { originRelCam, q, prevOriginRelCam, prevQ }: a VesselPose is one; for a body use
// { originRelCam: pose.centerRelCam, q: pose.qFixedToRoot, prevOriginRelCam: pose.prevCenterRelCam, prevQ: pose.prevQFixedToRoot }
```

- `ModelData`: LOD 0 first; all LODs share `materials`. Vertex streams are used as given (positions,
  normals, tangents xyzw, uvs, optional masks rgba8: r = edge wear, g = baked AO, b = soot weight,
  a = frost weight; without masks: wear 0, the others 1).
- Materials (`PbrMaterialDef`): `shading` selects the material id; `anisotropy`, `clearcoat`,
  `clearcoatRoughness` go to RT4 (standard only); `translucency` to RT2.a (cloth); `emissive` in cd/m^2;
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
(`reset(key)`, `isDefault(key)`), `setDeterministic(on)`, `setExposureOverride(ev100 | null)`,
`exposureInfo()`, `readHdrPixels(target?, rect?)`, `readHdrStats(target?)`, `readDepth()`, `resetPerf()`,
`passStats()`, `featureOrder()`, `frameContext`.

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
  alone (sunny 16 x sun visibility at the camera when a lit body or vessel is in view, EV -3 otherwise);
  between 0.5 % and 10 % the two are blended. `CameraState.exposureCompensation` (EV, positive = brighter),
  `minEv100` (lower bound of EV100) and `kind: 'interior'` (meters geometry within 8 m, no highlight cap)
  are honoured. Adaptation 2.5 EV/s towards brighter scenes, 0.8 EV/s towards darker ones.
- TAA: Halton(2, 3) jitter of 8 samples (more when upscaling) in `frame.proj`; write correct RT3 velocity
  for everything that moves on screen, or it will ghost. `frame.animate` is false in deterministic mode:
  do not animate noise then.
- `frame.qualityScale` (0.5..1): multiply march step counts and particle counts by it. The core lowers it
  when the measured GPU time exceeds 92 % of the 11 ms budget and only when it is at 0.5 lowers the
  internal resolution (`QualitySettings.renderScaleMin..Max`, steps of 1/16); recovery below 72 % runs in
  the opposite order. It is 1 in deterministic mode.

---

## 14. Perf and attribution

- Name your own passes `<featureId>.<pass>`: `timestampWrites: ctx.perf.gpuPass('my-feature.march')`
  (undefined without `timestamp-query`; pass it through). CPU zones: `ctx.perf.cpuBegin/cpuEnd(name)`;
  counters: `ctx.perf.counter(name, value)`.
- `window.__perf` (`PerfSnapshot`) is updated every frame: rAF, CPU and GPU percentiles over the last 300
  frames, `passes` (latest), `features` (p99 per feature id and `core`), `qualityScale`, `renderScale`.
- Draws inside core-owned passes (`shadow`, `gbuffer`, `water`, `background`, `transparent`, `overlay`)
  cannot be timed separately in one pass. **Attribution mode** (`createRenderer(..., { perfFeatures: true })`
  or `?perf=features` in a lab) runs each feature's hook in its own pass named `<featureId>.<hook pass>`
  with loadOp `load`: `features[id].gpuMs` is then exact. Perf specs use it. In normal mode one frame in
  64 is rendered in attribution mode and the measured shares split the pass time, so the breakdown stays
  close without the extra passes.
- `renderer.passStats()` gives p50 / p99 per pass name.

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

Query string: `scene=`, `perf=features`, `scale=<render scale>`, `ev=<forced EV100>`, `deterministic=1`,
`paused=1`, and the camera:

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
inside `'ocean.nearField'.fadeStart` the water is replaced by a seabed sphere 30 m below. No relief: a
backdrop for labs, never used by the app.

Specs follow `tests/browser/shell/lab-template.spec.ts`: `openPage`, `assertDiscreteGpu`,
`window.__test.setDeterministic(true)` + `waitIdle` before screenshots, `expectNoErrors`.
`tests/browser/render-core/*.spec.ts` are worked examples (HDR readback, frame diffs, perf under the lock).

---

## 16. Checklist for a feature

- [ ] Unique `id`; own passes named `<id>.<pass>` with `ctx.perf.gpuPass`.
- [ ] Positions camera-relative from float64; `prev*` relative to the previous eye; RT3 velocity written.
- [ ] G-buffer through `gbufferPack`; emissive pre-exposed; correct `MATERIAL_ID` and parameter.
- [ ] Every HDR write through `writeHdr`; transparents through `applyAtmosphere`.
- [ ] Samples copies (`scene.*`), never live attachments; bind groups rebuilt on `resources.version` change.
- [ ] `drawShadow`: body-fixed casters in every cascade of their body, moving casters only when `cascade.everyFrame`.
- [ ] Scales work with `frame.qualityScale`; no noise animation when `!frame.animate`; `isIdle()` reports loading.
- [ ] Lab page with `createLabApp`, spec with screenshots you looked at, perf spec under `withGpuLock` in attribution mode.
