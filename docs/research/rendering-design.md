# Rendering Design (implementation-ready)

Scope: the complete renderer for the true-scale Earth/Moon spaceflight simulator. Raw WebGPU + WGSL, TypeScript, desktop Chrome/Edge, RTX 5090 class GPU, 60 fps at 1440p native and 4K via TAA upscaling. Everything here is a decision unless marked *option*. Numbers are starting values that are expected to be tuned against screenshots, not placeholders.

Units: metres, seconds, photometric radiometry (luminance cd/m2, illuminance lux) end to end. This matters: star visibility, night lights, earthshine and sun glint all fall out of one exposure value instead of per-effect fudge factors.

---

## 1. Top-level decisions

| Topic | Decision | Why |
|---|---|---|
| Shading architecture | Deferred opaque (thin G-buffer) + forward for ocean near-field, volumetrics, glass, particles | One dominant light, but many material branches (terrain, Hapke regolith, water, PBR metal), heavy terrain overdraw, and SSAO/contact shadows/TAA all want a G-buffer |
| Depth | ONE pass, `depth32float`, reversed-Z, infinite far, near = 0.05 m | Constant relative depth resolution (~1e-7..1e-6) from the cockpit panel to the Moon. No depth partitioning, no scene swap, no compositing seams |
| Precision | float64 on CPU for everything positional; GPU sees only camera-relative float32 with per-tile/per-object local origins | Sub-millimetre at the camera, at any distance from any body |
| Terrain | Cube-sphere quadtree, CDLOD geomorph (vertex + normal map + albedo all morph with the same factor), skirts as a streaming safety net | No pops, no cracks, seamless pad to deep space |
| Height authority | A pure TypeScript function `H(body, dir, lambdaMin)` (real data + deterministic procedural amplification). Workers bake it into tiles for the GPU; physics calls the same function | Rendered surface == collision surface, and physics stays headless |
| Atmosphere | Hillaire 2020 LUTs (transmittance, multi-scatter, sky-view for IBL) + one unified half-res per-pixel ray march for every pixel, from ground to space | A single code path means there is no ground/space mode switch to hide |
| Clouds | Raymarched shell driven by a real coverage map, quarter-area with 2x2 temporal checkerboard, composited inside the atmosphere march | Visible from ground and orbit with the same code |
| Shadows | 8 logarithmic sun cascades (12 m .. body scale) + screen-space contact shadows | One sampling function covers cockpit self-shadowing, lander shadow, crater shadows at the lunar terminator |
| AA | TAA (Halton-8 jitter, variance clipping) with TAAU dynamic resolution; LDR overlays (orbit lines, markers) drawn after resolve with analytic AA | Volumetrics and specular need temporal integration anyway |
| Tonemap | AgX (base + mild "punchy" look), sRGB SDR canvas | Graceful desaturation of the sun, sunsets and plasma; no ACES hue skew |

Required WebGPU setup:

```ts
const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
// Verify adapter.info.vendor / architecture; if it reports the AMD iGPU, show a blocking
// message telling the user to set Chrome to "High performance" in Windows Graphics settings.
const want: GPUFeatureName[] = ['float32-filterable', 'texture-compression-bc', 'timestamp-query',
  'rg11b10ufloat-renderable', 'depth-clip-control', 'indirect-first-instance',
  'dual-source-blending', 'float32-blendable', 'clip-distances'];
const device = await adapter.requestDevice({
  requiredFeatures: want.filter(f => adapter.features.has(f)),
  requiredLimits: {
    maxTextureArrayLayers: Math.min(2048, adapter.limits.maxTextureArrayLayers),
    maxColorAttachmentBytesPerSample: Math.min(64, adapter.limits.maxColorAttachmentBytesPerSample),
    maxBufferSize: adapter.limits.maxBufferSize,
    maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
    maxSampledTexturesPerShaderStage: adapter.limits.maxSampledTexturesPerShaderStage,
    maxBindGroups: adapter.limits.maxBindGroups,
  },
});
```

Hard requirements: `float32-filterable`, `depth-clip-control`, `timestamp-query` (perf tests). The rest have code fallbacks (manual bilinear, two-pass compositing). Playwright must run headed Chrome with `--force_high_performance_gpu --ignore-gpu-blocklist --enable-gpu` (plus `--disable-gpu-vsync --disable-frame-rate-limit` for perf runs) and assert the adapter vendor is NVIDIA before taking measurements.

---

## 2. Precision strategy

### 2.1 Coordinate spaces

- **Inertial frame** (f64, CPU only): origin at the system barycentre or root body. All body centres, vessel positions, camera position.
- **Body-fixed frame** (f64, CPU): rotates with the body. Terrain tiles, launch sites, landed vessels live here.
- **Camera-relative render frame** (f32, GPU): axes aligned with the inertial frame, origin at the camera eye. `viewMatrix` is rotation only; translation is always zero.
- **Local frames** (f32, GPU): tile-local (origin = tile centre on the reference sphere, body-fixed axes), object-local (vehicle part origin).

Per frame the CPU computes, in f64, `originRelCam = R_bodyToInertial * tileCentreBody + bodyCentre - cameraPos` and narrows to f32. Each drawable gets `{ originRelCam: vec3f, rot: mat3x3f, prevOriginRelCam, prevRot }` (prev for motion vectors). The GPU does `posRelCam = rot * local + originRelCam`. `local` is small for anything near the camera, so error is `|local| * 6e-8`: 0.6 micrometres for a 10 m tile, 6 cm for a 1000 km tile that is by construction thousands of km away.

Rule enforced in code review: **no shader ever receives a body-centre-relative or inertial position of something that is rendered at high detail.** Atmosphere/cloud shaders that need altitude use the stable form in 2.3.

### 2.2 Depth: single reversed-Z infinite pass

Right-handed view, looking down -Z, WebGPU clip z in [0,1]:

```wgsl
// f = 1/tan(fovY/2), n = 0.05
// clip = vec4(f/aspect * x, f * y, n, -z)   =>  depth = n / (-z_view)
const proj = mat4x4f(
  vec4f(f/aspect, 0, 0, 0), vec4f(0, f, 0, 0), vec4f(0, 0, 0, -1), vec4f(0, 0, n, 0));
// depthCompare: 'greater', depth clear value 0.0 (= infinitely far = sky)
// linear distance along view axis: zView = n / depth
```

Why this is enough (and why depth partitioning is rejected): float32 stores `d = n/z` with constant *relative* spacing 2^-24, so `dz/z ~ 1.2e-7` everywhere. Resolution: 12 micrometres at 100 m, 1.2 cm at 100 km, 46 m at the Moon's distance (384,400 km, `d = 1.3e-10`, far above the float32 denormal limit). Real-world precision is closer to 1e-6 after vertex transform error, still orders of magnitude better than any surface separation that exists in the scene at that distance. Depth partitioning (near/far frusta) would reintroduce a seam exactly where the vehicle meets the terrain and doubles the passes that read depth (TAA, atmosphere, contact shadows) for no gain.

Rules that keep it true:
- The projection matrix is never multiplied with a translation on the CPU in f32; `clip = proj * (viewRot * posRelCam)` in the shader.
- Sky is exactly depth 0; "is sky" tests are `depth == 0.0`.
- Shadow maps are orthographic `depth32float`, standard (non-reversed) with `unclippedDepth` for caster pancaking.
- Position reconstruction: `posRelCam = viewRay(uv) * (n / depth)` where `viewRay` has z = -1 in view space.

### 2.3 Stable planet math in f32

Tile vertices on the sphere (avoids `normalize(big) * R - centre` cancellation). Per tile the CPU supplies (f64 -> f32): `cHat` = unit direction of the tile centre, `a`, `b` = cube-face tangent vectors scaled so that `delta = (u-0.5)*a + (v-0.5)*b` is the cube-space offset divided by `|Pc|`, `R` = reference radius, `h0` = height baked into the tile origin.

```wgsl
fn tileLocal(uv: vec2f, h: f32, t: Tile) -> vec3f {
  let delta = (uv.x - 0.5) * t.a + (uv.y - 0.5) * t.b;     // small
  let e = 2.0 * dot(t.cHat, delta) + dot(delta, delta);     // |cHat+delta|^2 - 1
  let s = sqrt(1.0 + e);
  let invLenM1 = -e / (s * (1.0 + s));                       // 1/|q| - 1, no cancellation
  let dn = delta * (1.0 + invLenM1) + t.cHat * invLenM1;     // n - cHat
  // (R+h) n - (R+h0) cHat  ==  (R+h) (n - cHat) + (h - h0) cHat
  return (t.R + h) * dn + (h - t.h0) * t.cHat;
}
// unit normal of the reference sphere at the vertex: n = cHat + dn (renormalise)
```

Altitude along a ray (atmosphere, clouds, far shadows) with camera radius `r0` and altitude `h0` supplied from f64, `mu = dot(rayDir, up)`:

```wgsl
fn altitudeAt(t: f32, r0: f32, h0: f32, mu: f32) -> f32 {
  let r = sqrt(r0*r0 + 2.0*r0*mu*t + t*t);
  return h0 + (2.0*r0*mu*t + t*t) / (r + r0);   // exact, stable for t from 1 m to 1e8 m
}
```

Planet-fixed detail coordinates (triplanar textures, ocean cascades): the CPU sends `originMod = tileCentreBody mod P` in f64 for a period `P` (4096 m for material tiling, 8192 m for ocean cascades); the shader uses `(originMod + local) / tileLength`. Sub-millimetre precise anywhere on the planet, no seams, no re-anchoring pops.

### 2.4 Time warp and motion vectors

Previous-frame transforms are built from the previous f64 camera and body states, so motion vectors are exact under body rotation. When the per-frame angular change of the view exceeds 2 degrees or warp >= 50x, TAA history weight drops to 0.5 and cloud reprojection is reset per affected pixel (variance clip does the rest). During warp > 1000x near a surface, terrain LOD is capped so that a tile stays on screen for >= 2 s (`maxLevel = floor(log2(faceSize / (groundSpeedPerWallSecond * 2 s)))`), which keeps streaming bounded.

---

## 3. Frame graph

Formats: HDR scene `rgba16float` (pre-exposed, see 11.1). Internal render resolution = display * `renderScale` (0.67..1.0, dynamic).

| # | Pass | Type | Target / notes |
|---|---|---|---|
| 0 | CPU: sim step, camera, quadtree selection, tile uploads (<= 2 ms budget), instance buffers | - | - |
| 1a | Atmosphere LUTs: transmittance 256x64 and multi-scatter 32x32 (only when params or body change), sky-view 192x108 + sky irradiance 64x16 (every frame) | compute | `rgba16float` |
| 1b | Ocean FFT: 4 cascades x 256^2 | compute | `rgba16float` arrays |
| 1c | Particles sim, pad smoke volume advection, env probe (1 cube face/frame + filter) | compute | - |
| 2 | Sun shadow cascades (staggered updates) | depth-only raster | `depth32float` 2048^2 x 8 array |
| 3 | G-buffer: terrain (front-to-back), far-LOD water surface, vehicles, pad, debris, rocks, cockpit interior | raster | RT0..RT3 + HDR emissive + depth |
| 4 | GTAO + screen-space contact shadows | half-res compute | `rg8unorm` |
| 5 | Deferred lighting (sun, sky irradiance, IBL, planetshine, plume/local lights) | fullscreen | adds into HDR |
| 6 | Ocean near-field forward (refraction from a copy of HDR + depth) | raster | HDR, depth, velocity |
| 7 | Background: Milky Way + catalog stars + sun disk + distant-body impostors where `depth == 0` | raster | HDR |
| 8 | Cloud raymarch (1/4 area, 2x2 checkerboard, reprojected) | compute | `rgba16float` half-res + depth |
| 9 | Atmosphere march + cloud composite + bilateral upsample | half-res fragment, then fullscreen | HDR |
| 10 | Forward volumetrics/transparents: plumes, reentry plasma, smoke volume (half-res march, depth-aware upsample), particles, parachute fabric, cockpit glass | raster | HDR |
| 11 | TAA resolve / TAAU to display resolution | compute | `rgba16float` history |
| 12 | Bloom chain (7 mips), lens flare, luminance histogram + exposure | compute | `rg11b10ufloat` |
| 13 | Tonemap (AgX), grade, dither | fullscreen | canvas (`navigator.gpu.getPreferredCanvasFormat()`) |
| 14 | LDR overlays: orbit lines, map markers, navball, HUD | raster | canvas |

G-buffer (24 bytes/sample, inside the default 32-byte limit):

| RT | Format | Content |
|---|---|---|
| 0 | `rgba8unorm-srgb` | base colour rgb, a = baked AO / cavity |
| 1 | `rg16float` | octahedral world normal (16-bit needed: water glint and clean metal banding at 10 bits) |
| 2 | `rgba8unorm` | roughness, metallic, material id, material param (foam / wetness / clearcoat / translucency) |
| 3 | `rg16float` | screen-space velocity |
| 4 | `rgba16float` | HDR target: emissive written here directly (night lights, heat glow, displays) |
| D | `depth32float` | reversed-Z |

Material ids: 0 standard PBR, 1 terrain (Lambert + GGX, sky-irradiance ambient), 2 regolith (Hapke), 3 water (far-LOD material path), 4 cloth/translucent, 5 emissive display.

---

## 4. Terrain

### 4.1 Quadtree and tile definition

- Cube-sphere, 6 faces, plain gnomonic cube mapping (`dir = normalize(faceOrigin + s * faceU + t * faceV)`, s,t in [-1,1]). Tile edges are then exact straight lines in cube space, so the shader's linear-in-tile offset (2.3) reproduces the CPU mapping exactly at every vertex and shared edges of neighbouring tiles coincide. The 1.7x linear cell-size variation across a face is absorbed by LOD selection, which measures real distance and real tile size. The mapping lives in one shared TS module used by the data pipeline, workers and physics. (A tangent-warped cube was considered and rejected: a warped tile is not linear in cube space, which would open sub-quad cracks between LOD levels.)
- Tile key `(body, face, level, x, y)`. Mean size at level L: Earth `10,007 km / 2^L`, Moon `2,729 km / 2^L` (face centre tiles are ~1.27x larger, corner tiles ~0.75x; `tileSize` everywhere below means the tile's actual measured edge length).
- Geometry: 64x64 quads (65x65 vertices) per tile, one shared grid mesh + index buffer (plus one skirt ring), drawn instanced; per-tile data in a storage buffer.
- Max level: Earth 20 (tile 9.5 m, quad 15 cm), Moon 18 (tile 10.4 m, quad 16 cm). Both are far below data resolution; levels beyond data are filled by amplification (4.6).

Per-tile GPU resources:

| Resource | Size / format | Pool |
|---|---|---|
| Height | 65x65 `r32float` (metres above reference sphere) | 2D array, 2048 layers (69 MB) |
| Normal + material | 256x256 `rgba8unorm` with mips: rg = slope d h/d(u,v) (per-tile scale), b = cavity/AO, a = material weight (landcover blend or crater freshness) | 2D array, 1536 layers (540 MB) |
| Albedo (data tile, shared by descendants) | 256x256 `rgba8unorm-srgb` with mips (BC7 when the pipeline provides KTX2), a = water mask | 2D array, 1024 layers (360 MB / 90 MB BC7) |
| Aux data (Earth): night lights, landcover ids | 256x256 `rg8unorm` | 2D array, 512 layers |

Render tiles deeper than the deepest data tile reference the deepest ancestor's albedo layer with a uv scale/offset. Total terrain VRAM budget: ~1.1 GB.

Per-tile instance record (storage buffer, 160 bytes): `originRelCam, prevOriginRelCam, cHat, a, b, R, h0, skirtDepth, level, heightLayer, parentHeightLayer, parentQuadrant, normalLayer, parentNormalLayer, albedoLayer + uvXform, parentAlbedoLayer + uvXform, auxLayer + uvXform, originMod4096, slopeScale, morphRange(start,end), bodyId`.

### 4.2 LOD selection (screen-space error) and culling

CDLOD requires distance-based ranges, so screen-space error is converted to a distance per level:

```
splitDist(L) = K * tileSize(L)
K = screenHeightPx / (2 tan(fovY/2) * 64 * pxPerQuad)       // 1440p, 60 deg, 8 px/quad -> K = 2.44
```

`pxPerQuad` = 8 (quality knob 6..12); it uses the *internal* render height so dynamic resolution also relieves geometry. A node is split when `distToBounds(node) < splitDist(L)` and `L < maxLevel`, where distance is the minimum over **LOD observers**: the camera, plus each active vessel within 2 km of a surface (observer radius bias 30 m). The vessel observer guarantees max-level terrain under the landing gear even from a distant chase camera, so visible contact matches physics.

Traversal per body per frame, in f64, camera in body-fixed coords:
1. Frustum cull with the tile OBB (8 corners at min/max height, planes in camera-relative f64). Infinite far plane: 5 planes.
2. Horizon cull (Cesium occluder-point test against the sphere of radius `R + minHeightOfBody`): tile is hidden if all 4 corners at `maxHeight` are below the horizon cone.
3. Select or recurse. A node renders only if its data is resident; otherwise the nearest resident ancestor renders the missing quadrant (quadrant mask per instance, 4 index ranges). Parents of resident tiles are pinned, levels 0..3 of every body are loaded at boot (510 tiles per body), so there is always something correct-looking to draw.

Expected load: 350..600 visible tiles, 3..5 M triangles in the G-buffer pass.

### 4.3 Geomorphing (no pops in geometry, normals, or colour)

```wgsl
// d = min over observers of distance to the unmorphed vertex
let k = clamp((d / splitDist(level - 1) - 0.70) / 0.25, 0.0, 1.0);   // fully morphed at 95% of range
// odd grid vertices slide to their even (parent) neighbour:
let g = vec2f(gridIJ);
let snapped = g - fract(g * 0.5) * 2.0;
let uvm = mix(g, snapped, k) / 64.0;
let hChild  = textureLoad(heights, gridIJ, t.heightLayer, 0).r;
let hParent = textureLoad(heights, parentBase(t.parentQuadrant) + vec2i(snapped) / 2, t.parentHeightLayer, 0).r;
let local = tileLocal(uvm, mix(hChild, hParent, k), t);
```

At `k = 1` the child mesh is geometrically identical to the parent's mesh over that quadrant (same vertices, same diagonal direction), so neighbouring LODs meet exactly. `k` is passed to the fragment shader and reused:
- normal/material map: `mix(sample(child), sample(parent with uv xform), k)`;
- albedo: same mix between own data tile and parent's;
- detail material fade distances are continuous functions of distance, never of level.

Because `H` is band-limited per level (4.6), `hChild - hParent` at any vertex is bounded by the amplitude of one octave, so morph motion is sub-pixel at the distance where it happens.

### 4.4 Cracks and skirts

CDLOD morphing is crack-free when neighbours are at their ideal level. Skirts cover the cases where it is not: a tile still streaming (ancestor quadrant drawn next to a finer neighbour) and f32 rounding between differently-originated tiles. Skirt ring vertices duplicate the edge and are displaced along `-n` by `skirtDepth = 2 * maxOctaveAmplitude(level) + 0.02 * tileSize`. Skirts use the edge vertex's normal/uv so they shade identically.

### 4.5 Normals and shading inputs

The worker evaluates `H` on a 259x259 grid (256 + border) at band limit `tileSize/128` and stores central-difference slopes in the tile's tangent frame (`dPdu`, `dPdv` directions on the sphere) as `rg8` with a per-tile `slopeScale` (slope encoded as `0.5 + 0.5 * tanh(slope / slopeScale)` to keep precision on flat mare and cliffs alike). The fragment shader rebuilds the normal: `n = normalize(nSphere - sU * tU - sV * tV)`. Cavity/AO in `b` is a cheap multi-scale height-difference term computed in the same worker pass. The normal map carries 4x finer relief than the geometry; its mip chain plus the parent blend keep it stable under minification. Slope variance lost by mipping is added to roughness (Toksvig-style) so distant rough terrain does not turn glossy.

### 4.6 The height function and procedural amplification

One module, `terrain/height.ts`, no DOM/GPU dependencies:

```ts
H(body, dir: Vec3 /* f64 unit, body-fixed */, lambdaMin: number): number
   = dataHeight(dir)                                   // bicubic (Catmull-Rom on a 4x4 neighbourhood) from the deepest data tile
   + sum over octaves o with wavelength_o >= lambdaMin of amp_o(dir) * noise3(dir * R / wavelength_o, seed_o)
   + bodySpecific(dir, lambdaMin)                      // craters for the Moon, dunes/erosion ridges for Earth
```

- Noise is 3D gradient noise on planet-fixed position (seamless across cube faces) with an **integer hash** (`Math.imul`-based, uint32 lattice coordinates). The identical hash is expressible in WGSL `u32` math, which keeps the door open for GPU tile generation with bit-identical lattice values.
- Octave wavelengths are `lambda_o = 2^-o * lambda_data`, where `lambda_data` is 2 texels of the deepest data level for that location. Amplitudes follow `amp_o = rough(dir) * lambda_o^Hurst` with `Hurst` 0.8 (Earth land), 0.65 (lunar highlands), 0.9 (maria), and `rough` derived from the *local data slope and curvature* (multifractal: rough where the real terrain is rough, flat on plains and seabed) and from landcover class.
- Band limiting: a tile at level L bakes geometry with `lambdaMin = tileSize/32` (2 quads) and normals with `tileSize/128`. Collision uses `lambdaMin = 2 * quad(maxLevel)` (0.30 m Earth, 0.32 m Moon).
- **Moon craters**: for each octave `j` (diameters `D_j = 2^-j * D0`, from just below LOLA resolution, D0 ~ 400 m, down to 0.6 m) a 3D hash grid with cell size `2 * D_j`; each cell spawns 0..2 craters (Poisson, density tuned to the equilibrium size-frequency law `N(>D) = 0.05 * D^-2` per m2 so every scale is equally saturated). Profile, with `r = dist / (D/2)`: bowl `-d * (1 - r^2)` for r < 1 with depth `d = 0.2 D * freshness`, raised rim `0.04 D * freshness * exp(-(r-1) * 4)`, ejecta blanket `r^-3` falloff to r = 2.5. `freshness` is hashed with a distribution heavily weighted to degraded craters (soft-clamped profile), giving the mix of crisp and ghost craters seen in LRO NAC frames. Crater freshness also goes to the material channel (brighter ejecta, more rocks).
- **Earth**: amplification is driven by landcover + slope: sand (dune ripples as anisotropic noise aligned to a per-region wind hash), bare rock (ridged multifractal), vegetated classes get soft low-amplitude relief only. Sea floor gets low-amplitude smooth noise. Heights of water-masked areas are not clamped: the true bathymetry is the solid surface.
- Cost control: octave lattices are evaluated scanline-wise per tile (lattice coordinates advance by a constant per sample), craters are gathered per tile into a small list before the per-sample loop. Target 6..12 ms per tile in a worker.

Close-range material layer (fragment shader, not geometry): triplanar PBR detail sets (1024^2, albedo/normal/roughness/height in 2D arrays, CC0 scans or generated, 8..10 materials per body), sampled at 3 scales (0.5 m, 4 m, 32 m tiling) with height-blend between materials and per-scale distance fades. **Colour is anchored to the real imagery**: `albedo = imageryLowpass * (detailAlbedo / meanDetailAlbedo)`, so regional colour stays true and detail only adds high-frequency structure. Weights come from landcover (Earth) or freshness/slope (Moon). Beyond ~3 km the detail fades out and pure imagery remains.

Lunar and desert rocks: 6 procedural rock meshes x 3 LODs, instanced, scattered by a hash grid in body-fixed coordinates within 250 m of the observers; density scales with crater freshness / slope. Rocks scale up from zero over the outer 30% of their range (no pop). Rocks above 0.5 m are also registered as bumps in `H` (same hash) so they collide; smaller ones are visual only.

### 4.7 Streaming, caching, eviction

- URL scheme (uniform, body-agnostic): `/tiles/{body}/{layer}/{face}/{level}/{x}/{y}.{ext}`, layers `height` (int16 or float32 raw, 257^2 + 1 border, little-endian), `albedo`, `aux`, plus per-body `manifest.json` listing layers, max data level per layer (optionally a sparse coverage quadtree for high-res regions of interest), radius, encoding scales. A 404 below the manifest's declared depth is a pipeline bug; beyond it the client never asks.
- Worker pool: `min(8, hardwareConcurrency - 2)` workers. A job = fetch data tiles (HTTP cache + in-worker LRU of decoded height tiles, 256 MB), run `H` for geometry + normals, return transferable `Float32Array`/`Uint8Array`. Image layers decode with `createImageBitmap` and upload via `copyExternalImageToTexture`.
- Priority = screen-space error of the missing tile x (in-frustum ? 1 : 0.25) x (near a vessel observer ? 4 : 1); re-evaluated each frame; stale requests are cancelled (`AbortController`) before the worker starts them.
- Upload budget: at most 8 tiles or 2 ms per frame, measured.
- Predictive prefetch: the selection runs a second time for the camera position extrapolated 2 s ahead (and at the predicted landing point when a suborbital trajectory intersects the surface); those tiles are requested at low priority.
- Eviction: LRU by last-selected frame, never evicting pinned tiles (ancestors of resident tiles, levels 0..3, tiles referenced by a shadow cascade this frame). Layer indices are recycled from free lists; the arrays are never reallocated.
- A newly arrived tile enters with `k` forced to 1 and relaxes to its distance-based value over 0.35 s, so even late streaming is a morph and not a pop.

### 4.8 CPU height queries for collision

`surfaceHeight(body, dir) = H(body, dir, lambdaMinFinal)` evaluated analytically, plus `surfaceNormal` by central differences at 0.15 m. The rendered max-level mesh is a 15 cm bilinear sampling of the same function, so the worst-case discrepancy is the bilinear interpolation error of the finest octave (< 1.5 cm). Physics needs a `TileSource` for data tiles: `fs`-backed in vitest, fetch-backed with a synchronous resident cache in the browser. The browser pre-loads the collision data tiles for a 4 km radius under every vessel below 30 km AGL; if the deepest data tile is not yet resident, the sim clamps time warp to 1x and uses the deepest resident ancestor (logged, and asserted never to happen during scripted missions). This contract belongs to the physics design; the renderer's side of it is only "use `H`, never a private copy".

---

## 5. Atmosphere (Hillaire 2020)

### 5.1 Model (Earth; all values in the body data file)

| Parameter | Value |
|---|---|
| Bottom / top radius | body radius / +100 km |
| Rayleigh scattering | (5.802, 13.558, 33.1) e-6 /m, density `exp(-h / 8 km)` |
| Mie scattering / absorption | 3.996e-6 / 4.40e-6 /m, density `exp(-h / 1.2 km)`, Cornette-Shanks phase g = 0.8 |
| Ozone absorption | (0.650, 1.881, 0.085) e-6 /m, tent profile centred 25 km, half-width 15 km |
| Ground albedo for multi-scatter | 0.3 |
| Solar illuminance at TOA | 128,000 lux, colour (1.0, 0.96, 0.92) normalised to luminance 1 |

Ozone is what makes the twilight zenith blue and the limb band cyan-to-deep-blue; it is not optional.

### 5.2 LUTs

- **Transmittance** 256x64 `rgba16float`, Bruneton parameterisation `(r, mu)`, 40 trapezoid steps. Rays hitting the ground return 0, which gives the planet's shadow in the atmosphere (terminator, twilight wedge, Belt of Venus) for free.
- **Multi-scattering** 32x32, `(mu_s, r)`, 64 directions x 20 steps, closed-form infinite series `Psi = L_2nd / (1 - f_ms)`.
- **Sky-view** 192x108, non-linear latitude (`v = 0.5 + 0.5 * sign(l) * sqrt(|l| / (pi/2))`), 32 steps, recomputed every frame at the camera. Used only for the environment probe, ocean/vehicle reflections of the sky, and cloud ambient. Not used for primary sky pixels.
- **Sky irradiance** 64x16, `(mu_s, r)`: hemispherical integral of single + multi scattering, used as terrain/cloud ambient at any point on the globe (each shaded pixel has its own sun zenith angle, so the terminator from orbit shades correctly).

### 5.3 Unified per-pixel march (pass 9)

Every pixel, at half resolution in each axis, marches `[tEnter, min(tExit, tScene)]` through the shell with 24 samples (16..40 by quality), blue-noise jittered, TAA-accumulated. Sample placement is uniform in *optical-depth-like* space: `t_i = tA + (tB - tA) * ((i + xi)/N)^p` with `p = 2` when the camera is inside the atmosphere (dense near the eye) and `p = 1` from space. Per sample:

```wgsl
let h   = altitudeAt(t, r0, h0, mu);                 // 2.3
let muS = dot(upAt(t), sunDir);
let Tsun = transmittanceLUT(h, muS) * eclipse(posAt(t)) * cloudShadowFar(posAt(t));
let sR = betaR * exp(-h/HR); let sM = betaM * exp(-h/HM);
let S  = Esun * (Tsun * (sR * phaseR(cosT) + sM * phaseM(cosT)) + multiScatLUT(h, muS) * (sR + sM));
let ext = sR + sM + betaMabs * exp(-h/HM) + ozone(h);
// Hillaire's analytic segment integral: energy-conserving at large steps
let Tseg = exp(-ext * dt);
L += T * (S - S * Tseg) / ext * cloudGate(t);         // cloudGate = Tcloud once t > cloud depth
T *= Tseg;
```

Outputs `inscatterFront`, `inscatterBack`, `transAtmToCloud`, `transAtmTotal`. Composite (full-res, depth-aware 4-tap bilateral upsample, falling back to nearest-depth at silhouettes):

```
final = inscatterFront + transAtmToCloud * Lcloud + Tcloud * (inscatterBack + transAtmTotal * Lscene)
```

Cost: 1440p -> 0.92 M rays x 24 samples x 2 LUT taps: ~0.5 ms; 4K internal 1440p identical. This is why one path suffices on the target GPU: the classic sky-view LUT + froxel split exists to save exactly this cost, and its two code paths are where the ground-to-space seam would come from.

What this delivers without special cases: blue sky and aerial perspective on the pad; reddening sun and orange horizon at sunset (transmittance on the sun term and on `Lscene`); the thin blue limb glow and the airglow-thin twilight arc from orbit; the hard-then-soft terminator; darkening sky with altitude during ascent (the shell simply gets thinner above the camera); correct appearance from the Moon (shell is a few pixels thick; N is reduced to 8 when the shell subtends < 64 px).

Sunlight on every lit surface and cloud sample is `Esun * transmittanceLUT(h, muS) * eclipse`, so the terrain goes orange at sunset and vessels in low orbit are lit red when the sun grazes the limb. For vessels above the atmosphere, the transmittance is evaluated at the sun ray's closest approach to the planet when that is below the top radius.

Atmospheres are per-body data (`atmosphere: null` for the Moon). The march loops over bodies whose shell intersects the view ray (max 2).

---

## 6. Volumetric clouds

- **Data**: a real global cloud coverage map (8192x4096 or 16384x8192 equirect, single channel, from a cloud-only composite) + a derived "cloud type/top height" channel (from brightness and latitude band: bright compact = deep convection up to 12 km, thin streaky = stratus 1.5..3 km, wispy high = cirrus at 9..11 km rendered as a thin 2D-ish layer). Stored as tiles in the same scheme or as two BC4 textures (86 MB at 16k).
- **Shape**: density at a sample = `remap(baseNoise, 1 - coverage', 1, 0, 1) * heightGradient(type, hNorm)`, eroded by detail noise at the edges (Schneider/Nubis). `coverage'` = map coverage modulated by a 40 km tiling Worley "mesoscale" texture so 2.5..5 km map texels break into cells and streets. Base noise: 128^3 Perlin-Worley `rgba8` tiled at 9 km; detail: 32^3 Worley tiled at 1.1 km; curl 128^2 for wisps. Noise is generated once at boot in a compute pass (deterministic).
- **March**: shell `[R + 1.2 km, R + 12.5 km]`, ray/shell intersection handles camera below, inside, above. Step = `clamp(t * 0.012, 60 m, 600 m)` in empty space, halved inside cloud; max 96 primary steps; detail erosion skipped when the pixel footprint exceeds 400 m (orbit). 6 cone light samples toward the sun (exponentially spaced to 2.5 km) + coverage-map-based far shadow term beyond.
- **Lighting**: dual-lobe HG (g 0.8 / -0.3, mix 0.5), Wrenninge multi-scatter octave approximation (3 octaves, a = b = c = 0.5), sun colour from the transmittance LUT at the sample (pink/orange cloud tops at sunset, dark bases), ambient from the sky irradiance LUT (top) and ground-bounce albedo (bottom). Extinction 0.04..0.12 /m scaled by type.
- **Temporal**: rendered at half resolution per axis; each frame updates one pixel of every 2x2 block (4-frame cycle, 1/16 of display pixels marched), the rest reprojected using cloud mean depth and body rotation; neighbourhood clamp rejects stale history. Output: radiance, transmittance, transmittance-weighted mean depth.
- **Shadows on the ground and in the air**: (a) near field: a 1024^2 orthographic cloud optical-depth map around the camera (60 km wide, 16 density steps per texel, 1/4 of the texels refreshed per frame); (b) far field: `exp(-tauVertical(coverage at the point where the sun ray crosses the layer mid-height) / max(muS, 0.05))` straight from the coverage map. Both multiply the sun term in deferred lighting, the ocean pass, and (far term only) the atmosphere march, which also yields crepuscular shading.
- **Motion**: coverage uv advected slowly by latitude-band wind (trade/westerlies) in sim time, clamped to real-time rate under time warp so clouds do not strobe.
- Cost: ~1.3 ms at 1440p internal.

Flying through a cloud deck during ascent or under parachutes works because the camera-inside case is the same march with `tEnter = 0`.

---

## 7. Ocean and water

Two representations that shade with the same BRDF function and blend by distance:

**Far (any distance, including orbit)**: a flat water surface tile (h = 0, same quadtree, trivial vertex shader) is drawn in the G-buffer pass for every tile whose min height < 0. Coastlines are decided **per pixel by the water mask** (albedo alpha), not by coarse geometry:
- ocean fragment where mask says land -> `discard`;
- terrain fragment where mask says water (coarse terrain poking above sea level, lakes, rivers) -> writes material id 3 (water) itself.
Mask influence fades to 0 once tile quad size < mask texel size; from there true geometry intersection defines the shoreline.

**Near (camera within ~30 km of the surface)**: forward pass 6 on the same tiles with FFT displacement and refraction; displacement amplitude and the refraction weight fade to zero between 15 and 30 km so it converges exactly onto the far representation.

Waves: Tessendorf FFT, 4 cascades of 256^2 with patch lengths `8192/7, 8192/29, 8192/113, 8192/449` m (1170, 282, 72.5, 18.2 m: coprime divisors of one 8192 m period, so `originMod8192` gives exact planet-fixed phases with no visible repetition). JONSWAP spectrum with TMA depth attenuation from local bathymetry near shore, directional spreading, wind from body data (default 7 m/s with a low-frequency global variation map). Each cascade outputs displacement (xyz), slopes, and the Jacobian; foam = temporal accumulation of `saturate(lambda - J)` with decay 0.6 /s. Sampled triplanar in planet-fixed space (weights `|n|^8`) to remain seamless over the sphere. Below the finest cascade, an 18 m-tiling detail normal adds capillary ripples.

Shading (shared WGSL function):
- Specular: GGX with `F0 = 0.02`, roughness from total slope variance = resolved normal + *unresolved* variance. The unresolved part is the variance of every cascade/mip filtered out at the pixel footprint, with the limit `sigma^2 = 0.003 + 0.00512 * U10` (Cox-Munk) and `alpha = sqrt(sigma^2)`. This is the term that produces the correct broad sun glint from orbit and the tight glitter path at the surface from one formula.
- Sky reflection from the environment probe / sky-view LUT with horizon-roughness fade; reflected sun occluded by cloud shadow.
- Body colour: single-scattering approximation with absorption (0.45, 0.06, 0.028) /m and backscatter tinted by the imagery's ocean colour (real regional variation: turquoise shelves, green plankton blooms, sediment plumes). Water thickness along the refracted ray comes from the depth buffer near (refraction with chromatic offset, seabed visible in the shallows) and from baked bathymetry far. Depth-based: `Lwater = Lseabed * exp(-k * path) + Lscatter * (1 - exp(-k * path))`.
- Foam: whitecaps from the Jacobian, shoreline foam from shallow depth + wave phase, wake/splash foam decals injected by vessels (a 512^2 vessel-centred foam accumulation texture).
- Splashdown close-up: capsule waterline uses the same displacement field on the CPU (sum of the 2 longest cascades read back at 64^2, 2-frame latency) for buoyancy visuals; meniscus darkening and wetness (roughness drop + darkening) on the hull by a "wet line" parameter.

Cost: FFT 0.35 ms, near pass ~0.8 ms.

---

## 8. Lighting model

### 8.1 Sun, eclipses, planetshine

- Sun is directional with angular radius 0.2666 deg at 1 AU (from data: radius / distance). Disk drawn analytically in pass 7: luminance `Esun / (pi * sin^2(theta_s))` = 1.9e9 cd/m2 with limb darkening `1 - 0.6 * (1 - sqrt(1 - r^2))`, multiplied by atmosphere transmittance in pass 9.
- **Eclipse / planet shadow** for any shaded point and any occluding body: fraction of the solar disk visible, from circle-circle overlap of the two angular disks (exact lens-area formula; penumbra and annular cases included). Up to 2 occluders per body in a uniform array. Gives lunar eclipses, solar eclipse shadow on Earth, and darkness for vessels in Earth's or the Moon's shadow.
- **Planetshine**: each body illuminates others with `E = Esun * A_geom * (R/d)^2 * Phi(phase)` (Lambert-sphere phase function), coloured by the body's mean visible colour. Earthshine on the lunar night side is ~10..15 lux at full Earth; it makes the dark limb visible at long exposure. For vessels and the lunar surface it is applied as a directional light; for vessels close to a body, the environment probe (8.3) carries it instead.

### 8.2 Surface BRDFs

- Standard: GGX (Smith height-correlated) + Burley diffuse, multiscatter energy compensation, clearcoat option (painted tank skin), sheen/translucency for fabric.
- Terrain (Earth): Lambert + low GGX lobe from material roughness; wetness near shore.
- **Regolith (Moon)**: Hapke with shadow-hiding opposition surge and Lommel-Seeliger limb behaviour:

```wgsl
fn hapke(w: vec3f, mu0: f32, mu: f32, g: f32) -> vec3f {      // returns BRDF * mu0
  let B  = B0 / (1.0 + tan(g * 0.5) / hS);                    // B0 = 1.8, hS = 0.065
  let P  = 1.0 + bP * cos(g) + cP * (1.5 * cos(g)*cos(g) - 0.5); // bP = 0.25, cP = 0.3 (backscattering)
  let gam = sqrt(1.0 - w);
  let H0 = (1.0 + 2.0*mu0) / (1.0 + 2.0*mu0*gam);
  let H  = (1.0 + 2.0*mu ) / (1.0 + 2.0*mu *gam);
  return w / (4.0 * PI) * mu0 / (mu0 + mu) * ((1.0 + B) * P + H0 * H - 1.0);
}
```
  `w` (single-scattering albedo) is derived per pixel from the LROC albedo map through a 256-entry LUT built at load: the LUT numerically inverts `hapke()` at the map's normalisation geometry (incidence 30 deg, emission 0, phase 30 deg) so that rendering at that geometry reproduces the map value exactly (highlands w ~0.33, maria ~0.17). Macroscopic roughness is supplied by the actual normal map + cascade shadows, so the Hapke roughness term is omitted. Result: the full Moon is flat-lit with a bright limb (not Lambert-dark edges), and the ground brightens visibly around the lander's own shadow at touchdown (the Apollo "heiligenschein").

### 8.3 Environment lighting (IBL from the live scene)

A 64^2 x 6 `rgba16float` cube at the active vessel: per texel, analytic evaluation (no scene re-render): direction hits a body -> body mean albedo from a 256x128 per-body colour map x sun/sky irradiance at the hit point x atmosphere in-scatter/transmittance (sky-view LUT) + cloud coverage whitening; misses -> sky-view LUT or space black; sun excluded (handled as the directional light). One face per frame, then GGX prefilter to 5 mips (one mip per frame) and SH9 projection for diffuse. In low orbit this lights the Earth-facing side of the vehicle blue-white and the space-facing side black, the single most important cue for "photoreal in orbit". Terrain ambient does not use the probe; it uses the sky irradiance LUT per pixel.

GTAO at half resolution (2 slices x 6 steps, temporal) multiplies ambient; bent normals are not needed.

### 8.4 Shadows

**Sun cascades**: 8 cascades, each 2048^2 `depth32float`, far distances 12 m, 60 m, 300 m, 1.5 km, 8 km, 40 km, 200 km, 1500 km (clamped to the distance to the horizon / body extent; unneeded cascades are skipped, e.g. only 2..3 exist in deep space). Texel sizes 1.2 cm .. 1 km.
- Cascade 0 is fitted to the active vessel's bounding sphere when in cockpit view (crisp sun patches moving across the panel).
- Casters: vessels, debris, pad, rocks in cascades 0..3; terrain tiles in all. Terrain casters per cascade are chosen by a second quadtree walk with the cascade's ortho frustum and a LOD matched to its texel size, **restricted to resident tiles** (falls back to ancestors, adds no streaming pressure).
- Update schedule: cascades 0..1 every frame, 2..3 every 2nd, 4..5 every 4th, 6..7 every 8th frame (also forced on sun-direction change > 0.05 deg, i.e. under time warp); matrices are texel-snapped and stored with the cascade so stale cascades remain valid.
- Filtering: PCSS-lite: 8-tap blocker search + 12-tap Vogel-disk PCF rotated by blue noise, penumbra width = blockerDistance x 0.0093 (true solar angular diameter), clamped to >= 1.5 texels; normal-offset bias 1.5 texels + slope-scaled depth bias; cross-cascade dither blend over the last 10%.
- **Contact shadows**: 12-step screen-space march toward the sun over 0.3 m .. 1.5% of view distance fills in what is below texel size (pebbles, panel gaps, crater rim crispness mid-field).

Why not horizon maps or height-field ray marching for the Moon: both need random access to heights across tile and cube-face boundaries in the fragment shader, or tens of ms per tile to bake; the long cascades reuse resident geometry and one sampling function, work for whole-disk terminator views (cascade 7 covers the body at ~1 km/texel, finer than a pixel at that range), and automatically include the lander's shadow.

---

## 9. Sky background

- **Stars**: Hipparcos/Yale-derived catalog to V = 8.0 (~41,000 stars: RA, Dec, Vmag, B-V) in a 16-byte-per-star buffer, drawn as instanced quads in pass 7. Illuminance `E = 2.54e-6 * 10^(-0.4 * V)` lux; colour from B-V via blackbody. Each star is a Gaussian PSF of sigma 0.7 px (stable under TAA jitter) whose pixel luminances integrate to `E / Omega_pixel`:

```wgsl
let L_peak = E / (omegaPx * 2.0 * PI * sigmaPx * sigmaPx);
out.color  = starColor * L_peak * exp(-0.5 * dot(dPx, dPx) / (sigmaPx*sigmaPx)) * exposure;
```
  A magnitude-0 star is ~5 cd/m2 per pixel at 1440p/60 deg: invisible next to a 10,000 cd/m2 sunlit Earth at EV 14, obvious at EV -2 in Earth's shadow. No "star fade" parameter exists. In atmosphere, stars are attenuated by transmittance in pass 9 and get scintillation (amplitude proportional to airmass).
- **Milky Way and faint stars**: an HDR all-sky map (NASA SVS Deep Star Maps 2020 / Gaia-derived, public domain), bright catalog stars removed in the data pipeline, stored as a 2048^2 x 6 BC6H cube calibrated so the galactic centre region is ~5e-3 cd/m2.
- **Distant bodies** below 3 px diameter are drawn as PSF points with correct phase-integrated flux (same code as stars), cross-fading with their geometry between 3 and 6 px, so the Moon from far away or Earth from lunar distance never aliases.

---

## 10. Vehicle, cockpit and effects

### 10.1 Vehicle models

Parametric geometry authored in code (lathe profiles, stringers, weld seams, corrugated intertank, grid fins or aero covers, engine bells with regenerative-channel banding, turbopump plumbing as swept tubes, landing legs, RCS quads, docking hardware, MLI foil on the lander as crinkled displaced panels). Vertex format: position f32x3, octahedral normal + tangent, uv, material index, part id. PBR materials from a shared 2048^2 x N texture array (painted aluminium with orange-peel clearcoat, bare stainless, soot gradient mask, ablative heat shield, MLI gold/silver foil with anisotropy, carbon composite, glass, decal atlas with fictional livery generated offline). Wear is a mask shader (edge wear from baked curvature in vertex colour, soot driven by sim state, frost on cryogenic tanks that sheds at launch). Triangle budget: 1.5 M full stack at LOD0; 3 LODs by projected size with dithered cross-fade (TAA resolves it). Specular AA: Kaplanyan geometric roughness clamp.

Heat glow: per-part temperature from the sim -> emissive `eps * blackbody(T)` written to the HDR target in the G-buffer pass; visible from ~800 K. Engine bells glow after burns and cool radiatively.

### 10.2 Engine plumes

Raymarched analytic volume per engine (or per cluster) in nozzle-local cylindrical coordinates `(x, r)`, half-res, 40 steps, blue-noise jitter, depth-tested, composited with dual-source blending (in-scatter + transmittance).

Inputs from the sim/engine data: throttle, chamber pressure, exit pressure `pe`, ambient pressure `pa`, exit radius `re`, exit Mach `Me`, propellant look (emission spectrum ramp, soot opacity).

- Pressure ratio `eta = pe / max(pa, 1 Pa)`.
- Boundary radius: `rb(x) = re + Lexp * tan(theta) * (1 - exp(-x / Lexp)) + 0.09 * x` (initial angle `theta`, relaxing over `Lexp = 6 re * sqrt(max(eta, 1))` to a 5 deg turbulent mixing spread) with initial expansion half-angle `theta = clamp(PrandtlMeyer(M_boundary(eta)) - PrandtlMeyer(Me) + thetaNozzle, -8 deg, 85 deg)`: slightly pinched at sea level (overexpanded), straight at design altitude, ballooning to a huge faint umbrella in near vacuum.
- Shock cells (visible for 0.25 < eta < 4): spacing from the Prandtl-Pack relation with the fully-expanded jet Mach number `Mj` (isentropic from chamber pressure and `pa`) and jet diameter `Dj = 2 re * sqrt(max(eta, 0.3))`: `Ls = 1.306 * Dj * sqrt(max(Mj^2 - 1, 0.05))`; emission multiplied by a sharpened `|cos(pi x / Ls)|` core pattern with radial pinch, decaying over 5..8 cells; turbulent break-up by advected 3D noise scrolling at exhaust speed.
- Emission: methalox booster = blue-violet core, orange-pink afterburning shear layer at low altitude, nearly transparent; hydrolox/vacuum engines = faint blue, visible mostly at the nozzle; lander hypergolic = almost invisible in vacuum with a faint red-orange core. Luminance up to 2e6 cd/m2 in the core (blooms naturally). Density and emission scale with throttle; ignition and shutdown have 0.3..1.5 s transients (startup flash, green TEA-TEB style flash optional per engine data).
- Lighting from plumes: each active cluster is a capsule light (colour, intensity proportional to thrust x luminous efficacy from data) evaluated in deferred lighting with inverse-square falloff and a cheap shadow from cascade 0/1 lookup along the light direction for the vehicle only. This lights the pad, smoke, lunar surface and the vehicle's aft.
- Exhaust trail in atmosphere: volumetric puff particles emitted along the path (condensation trail above ~8 km when humid layer flag set), lit like clouds.

### 10.3 Pad smoke, steam, dust, particles

- **Pad smoke/steam**: a pad-anchored density volume 160x96x160 (`r16float` density + `r8` temperature), 600 x 360 x 600 m, updated in compute: semi-Lagrangian advection through an analytic velocity field (impinging jet -> radial wall jet through the flame trench geometry from site data -> buoyant plume) plus curl noise, sources at plume-ground impact proportional to mass flow, deluge steam source. Raymarched with the plume pass (48 steps, 4 sun-shadow steps, plume capsule light), detail-eroded with the cloud noise so sub-voxel billows exist. Dissipates and drifts with wind after liftoff.
- **GPU particles** (compute, 262k pool, alpha-blended soft particles sorted by coarse bucket): lunar descent dust (ballistic radial sheets, no turbulence, no billowing, streaking along the surface and revealing rock shadows, as in Apollo footage), ice flakes at staging, separation gas puffs (fast free expansion in vacuum, 0.5 s lifetime), RCS bursts, pyro sparks, water spray and droplets at splashdown, debris chips.
- Spent stages are full vehicle meshes simulated by physics; they tumble, catch plume light, and get their own shadows.

### 10.4 Reentry

Driven by sim outputs: convective heat flux (Sutton-Graves `q = k sqrt(rho / Rn) v^3`), dynamic pressure, Mach, velocity direction in the vessel frame.
- **Shock layer + wake**: raymarched volume in a velocity-aligned OBB (half-res, 32 steps): bow shock as a paraboloid shell at standoff `0.14 * Rn` wrapping the windward shape (the windward silhouette is approximated by per-vessel ellipsoid/cone parameters in the vehicle data), streaked wake behind with noise advected along `-v`. Emission `proportional to q^0.75`, colour ramp orange -> pink -> white-violet with entry speed (lunar return at 11 km/s is white-violet), flicker in the 8..30 Hz band.
- **Surface glow** via part temperatures (10.1); ablator sparks via particles.
- **Trail**: camera-facing ribbon of the last 20 s of trajectory with volumetric shading, visible from chase cam and far away.
- **From the cockpit**: the same volume is marched from inside; windows show the flowing plasma sheath and it lights the interior (probe injection of the plasma colour).
- Destruction: parts exceeding limits detach as glowing debris with particle bursts; handled by sim events.

### 10.5 Parachutes and splash

Canopy: parametric ring-sail mesh (gores, vents, reinforcing bands, 96 suspension lines as camera-facing tubes), inflation parameter from the sim (packed -> streaming -> reefed -> full) driving a vertex-shader shape blend + breathing noise; two-sided thin-fabric BRDF with transmission (backlit canopy glows orange/white). Drogues and mains are instances of the same generator. Splash: crown sheet mesh burst + 20k spray particles + foam decal + a radial wave injected into the vessel-centred ocean displacement patch.

### 10.6 Cockpit interior

Rendered in the main G-buffer pass like any geometry (0.05 m near plane, cascade 0 fitted to the capsule). Contents: pressure-vessel structure, seats, window frames with multi-pane glass, three MFD displays, physical switches/breakers/handles, navball instrument, cable runs, stowage.
- **Windows**: forward transparent pass with Fresnel reflection of the interior (probe), dust/scratch layer that lights up at grazing sun, slight tint; the exterior is the real scene, not a texture.
- **Interior light**: sun through windows via cascade 0 (hard moving light patches), bounce approximated by an interior irradiance probe updated every 8 frames (12 texels x 6, from exterior probe x per-window visibility + lit-patch bounce), panel floodlights and display glow as local lights.
- **Displays**: UI drawn to `OffscreenCanvas` 2D at 1024x768 per MFD at 15 Hz, uploaded with `copyExternalImageToTexture`, shown through an emissive display material (subpixel grid at close range, glass reflection). The navball is a real 3D sphere rendered to a 512^2 texture each frame (textured ball with oriented markers) and used both in the cockpit instrument and in the HUD overlay.
- Exposure in the cockpit meters the interior-weighted centre so the cabin is readable while windows blow out realistically in sunlight.

---

## 11. Post-processing

### 11.1 Exposure

Photometric scene values are multiplied by the previous frame's exposure before being written (pre-exposure), so the sun disk (1.9e9 cd/m2 x 2.5e-5 at EV100 15 = 47,000) fits in half float. `exposure = 1 / (1.2 * 2^EV100)`.

Auto-exposure: 256-bin log-luminance histogram (range EV -8..+22) of the 1/4-res HDR, centre-weighted; average of the 50..92 percentile band; target EV with compensation curve `EC = clamp((EVavg - 4) * 0.12, -1.5, +1.5)` (keeps night dark and day bright); clamp EV100 to [-3, 16]; adaptation 2.5 EV/s when the scene gets brighter, 0.8 EV/s when darker (eye-like). Map view uses a manual/assisted exposure with a floor so night sides remain legible.

### 11.2 TAA / TAAU

Halton(2,3) 8-sample jitter in the projection (x,y offsets added to `clip.xy` so the infinite reversed-Z matrix is untouched). Resolve in a compute pass: closest-depth velocity dilation, Catmull-Rom history sample, YCoCg variance clipping (gamma 1.0, 1.25 when static), luminance-weighted blend (history weight 0.9, reduced by velocity and disocclusion), then RCAS sharpening (0.2). TAAU: internal resolution 67..100%, controlled by a PI loop on GPU frame time (timestamp queries) targeting 13.5 ms; 4K display normally runs 1440p..1800p internal.

### 11.3 Bloom, flare, tonemap

- Bloom: threshold-free, 7-level 13-tap downsample (Karis average on the first level against fireflies) and 9-tap tent upsample, mixed at 4% energy. Physically plausible because the input is real luminance: the sun, glints, plumes and plasma bloom; a sunlit hull does not.
- Lens flare: derived from the bloom chain (3 chromatic ghosts + a faint halo) plus a 6-blade diffraction starburst on the sun, occluded by the depth-tested sun visibility fraction; total energy < 1% of source; in cockpit view the flare is replaced by window-scatter glare.
- Tonemap: AgX (inset matrix -> log2 encoding over [-12.47, +4.03] EV -> sigmoid -> outset), mild contrast/saturation look, then sRGB OETF and +-0.5 LSB triangular blue-noise dither (prevents banding in the limb gradient and night sky).

---

## 12. Map view

The map is the same scene with a different camera: no second renderer, no scene swap. The camera detaches, orbits a focus body or vessel at distances from 100 km to 2e9 m (smooth exponential zoom), and the bodies remain real renders (terrain quadtree at whatever LOD the distance selects, atmosphere, clouds, shadows). The switch is an animated camera transition.

- **Trajectories**: the sim provides patched-conic segments (elements + SOI body + time span, and maneuver-node previews). The renderer samples each conic on the CPU in f64 adaptively in eccentric/hyperbolic anomaly until the screen-space chord error is < 0.3 px (max 2048 points per patch), in the SOI body's frame at the *current* time (toggle: body position at encounter time), converts to camera-relative f32, and draws instanced screen-space quads: 2.5 px wide, analytic edge AA, round joins, per-vertex colour/alpha (fade with time ahead, dashed for post-maneuver). Segments crossing the near plane are clipped analytically in the vertex shader; segments within 50 m of the camera are subdivided.
- Lines are drawn in pass 14 (after tonemap: crisp, no bloom, no TAA smear) with a depth test against the scene depth resolved to display resolution, with a 6 px soft fade where they pass behind a body.
- **Markers**: Ap/Pe, AN/DN, SOI entry/exit, closest approach, maneuver nodes with 6 drag handles (prograde/retrograde, normal/antinormal, radial in/out) as SDF icons at f64-projected screen positions, constant pixel size, hit-tested on the CPU against the same projections.
- Bodies smaller than 6 px get an icon ring; SOI spheres optional as faint Fresnel shells.
- A low "fill" ambient (0.5% of sun) is enabled only in map view so night hemispheres are readable; it is a declared map-view light, not used in flight views.

---

## 13. Performance budget (RTX 5090, 1440p internal; 4K output via TAAU)

| Pass | GPU ms |
|---|---|
| LUTs + sky-view + irradiance + probe | 0.3 |
| Ocean FFT | 0.35 |
| Particles + smoke volume sim | 0.3 |
| Shadow cascades (amortised) | 1.2 |
| G-buffer (4 M tris terrain + 1.5 M vehicle) | 2.2 |
| GTAO + contact shadows | 0.6 |
| Deferred lighting | 0.9 |
| Ocean near pass | 0.8 |
| Stars/background | 0.1 |
| Clouds | 1.3 |
| Atmosphere march + composite | 0.7 |
| Plumes / plasma / smoke march / particles / glass | 1.2 |
| TAA(U) | 0.5 |
| Bloom + flare + histogram + tonemap + overlays | 0.6 |
| **Total** | **~11.0** (headroom 5.6 ms) |

CPU main thread: quadtree selection for 2 bodies + cascades <= 1.0 ms, uploads <= 2.0 ms, instance buffers 0.3 ms, sim step per physics design; target <= 6 ms total. VRAM: ~3 GB (terrain 1.1, shadows 0.13, G-buffer + history at 4K 0.5, clouds/noise/LUTs 0.2, vehicle + materials 0.6, sky 0.1).

Instrumentation is part of the design: every pass has a timestamp query; an on-screen overlay and a `window.__perf` object expose per-pass ms, tile counts, queue depth, upload ms and dropped frames so Playwright can assert the 60 fps requirement at fixed mission checkpoints (pad, max-Q, orbit, lunar descent, reentry, splashdown).

---

## 14. Data-driven hooks (renderer side)

Body render config (JSON per body): radius, rotation model, `tiles` manifest URL + max levels, `surface: { brdf: 'terrain' | 'hapke', hapkeParams, materials[], amplification: { module, params } }`, `atmosphere | null` (all of 5.1), `clouds | null`, `ocean | null` (wind, colours), `nightLights | null`, mean colour map. Vehicle config: part generators + parameters, materials, engines (plume look, `pe`, `Me`, `re`, light), parachutes, reentry shape parameters, cockpit layout. Site config: pad geometry generator, trench/deluge parameters, flattening pad footprint injected into `H` (so the pad sits on real terrain without z-fighting or floating). The renderer iterates bodies/vessels generically; nothing references "earth" or "moon" by name. EVA later = one more LOD observer + a character drawable; nothing in the precision or terrain design assumes the camera is on a vessel.

---

## 15. Risks, ranked, with fallbacks that still look real

1. **Ground-level Earth realism at the pad** (satellite imagery is 10..500 m/px; no vegetation geometry). Mitigation in the main plan: site the pad on an arid coast (sand, scrub, rock) and rely on landcover-driven PBR detail tinted by imagery, plus rocks and a detailed pad complex. Fallback: author a 4 km "hero" material mask around the site in the site data (still data-driven) and widen the pad apron; avoid forested sites entirely.
2. **Tile generation throughput and hitches** (JS workers at 6..12 ms/tile, uploads on the main thread). Fallbacks in order: reduce normal maps to 128^2 for levels above data resolution; move normal/slope generation to a GPU compute pass using the bit-identical integer-hash noise (geometry heights stay on the CPU); WASM SIMD for `H`. The forced-morph-in on arrival keeps late tiles from popping in every case.
3. **Clouds seamless from ground to orbit, temporally stable**. Fallback: from above 60 km altitude switch the *march quality* (not the path) to 16 steps without detail noise; if checkerboard reprojection ghosts during fast ascent, render full half-res every frame at 48 steps (+1.5 ms, affordable in the headroom).
4. **Pad smoke volume** looking like a fluid rather than fog. Fallback: increase curl-noise energy and add 300 lit volumetric puff particles advected through the same velocity field and shaded with the same phase/shadow functions; both read as real smoke when lit by the plume and sun.
5. **Eight shadow cascades at grazing lunar sun** (acne, LOD mismatch between caster and receiver). Fallbacks: receiver-plane depth bias; restrict terrain cascades 6..7 to bodies viewed from > 500 km; if cost spikes, halve update rates of cascades 4..7 (they move slowly).
6. **TAA under time warp and fast ground motion**. Fallback: history reset heuristics in 2.4; at warp > 4x in map view, TAA runs with 0.6 history weight (lines and markers are post-TAA so the UI is unaffected).
7. **Half-res atmosphere upsampling halos at silhouettes/limb**. Fallback: run the atmosphere march at full internal resolution with 16 samples (+0.8 ms).
8. **Ocean triplanar blend zones** (slightly reduced wave contrast where two projections mix). Fallback: bias blend sharpness to `|n|^16` and rotate the cube so blend lines avoid the splashdown zone; the far-field glint is variance-based and unaffected.
9. **WebGPU limits/features differing from expectation** (array layers, `float32-filterable`, dual-source blending). Fallbacks: multiple array pools, manual bilinear via `textureLoad`, two-target compositing. All are checked once at startup with explicit error text; no silent degradation.
10. **TS/WGSL parity for height** only matters if item 2's GPU path is taken; the CPU remains the single authority for collision in every configuration.

Validation plan: golden-image Playwright checkpoints (pad noon, pad sunset, 10 km, 40 km, LEO day, LEO terminator, LEO night with city lights and stars, translunar Earth/Moon, low lunar orbit at low sun, lunar touchdown, reentry peak heating, parachute descent, splashdown) with per-pass timings recorded, plus a "LOD pop detector" test that flies a scripted camera path and asserts the frame-to-frame image difference stays below a threshold when sim time is frozen and only the camera moves.
