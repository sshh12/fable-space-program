/**
 * Mesh system for every render package: ModelData upload, PBR materials (incl. anisotropy and clearcoat
 * into RT4), instanced draws into the G-buffer and the sun shadow cascades with camera-relative
 * per-instance transforms (current + previous), per-instance parameters, LOD pick by projected size with
 * dithered cross-fade, Kaplanyan specular AA, and the body-fixed / moving caster split.
 *
 * Bind groups of the G-buffer pipeline: 0 frame, 1 batch (instances), 2 material.
 * Bind groups of the shadow pipeline:   0 frame, 1 core shadow pass (cascade matrix), 2 batch.
 */
import { MATERIAL_ID, OCEAN_WETNESS_SLOTS, RENDER_FORMATS, type FrameContext, type MeshData, type ModelData, type PbrMaterialDef, type ShadowCascadeView, type SharedResources } from '@/core/contracts/render';
import { mat3, quat, v3, type Mat4, type Quat, type Vec3, type Vec3Tuple } from '@/core/math';
import type { CoreShaderLibrary, Tracked } from '../shaders/library';
import { createBufferChecked, f32ToF16 } from '../util/gpu';
import type { ProceduralTexture, TextureManager, TextureRef } from './textures';

export const INSTANCE_FLOATS = 32;
/** Default LOD switch sizes: LOD 1 below 220 px projected diameter, LOD 2 below 60 px, ... */
export const DEFAULT_LOD_PIXELS: readonly number[] = [220, 60, 16];
/** Half-width of the dithered LOD cross-fade band, as a fraction of the switch size. */
export const LOD_FADE_BAND = 0.15;

export const SHADOW_PASS_WGSL = /* wgsl */ `
// Group 1 of every drawShadow pipeline; the core binds it before calling the hooks.
struct ShadowPassUniforms {
  viewProj: mat4x4f,   // camera-relative ROOT axes -> shadow clip of the cascade being rendered
  params: vec4f,       // x = texel size along u (m; the coarser axis), y = depth range (m), z = array layer, w = 1 when re-rendered every frame
}
@group(1) @binding(0) var<uniform> shadowPass: ShadowPassUniforms;
`;

/**
 * Alpha test shared by the G-buffer and the cut-out shadow shader (request vehicle-pad-4). Near (a texel
 * covers a pixel or more) the cut is at `cutoff`, dithered by half the alpha's screen-space gradient so that
 * the TAA anti-aliases the edge. Far (several texels per pixel, coarse mips) the mip-averaged alpha is the
 * share of the surface that is solid, and a fixed cut would make a 70 % open grating vanish (its average
 * alpha falls under the cutoff) or close up: there the test becomes stochastic (keep with probability alpha),
 * which the TAA and the shadow filter turn into the right partial coverage.
 */
const CUTOUT_WGSL = /* wgsl */ `
fn cutoutFootprint(uv: vec2f, size: vec2f) -> f32 {
  return max(length(dpdx(uv * size)), length(dpdy(uv * size)));
}
fn cutoutThreshold(cutoff: f32, alphaWidth: f32, texelsPerPixel: f32, noise: f32) -> f32 {
  return mix(cutoff - (noise - 0.5) * alphaWidth, noise, smoothstep(1.0, 4.0, texelsPerPixel));
}
`;

const INSTANCE_WGSL = /* wgsl */ `
struct MeshInstance {
  m0: vec4f, m1: vec4f, m2: vec4f,   // rows of the 3x4 local -> camera-relative transform (ROOT axes)
  p0: vec4f, p1: vec4f, p2: vec4f,   // the same for the previous frame, relative to the PREVIOUS eye
  params: vec4f,                     // temperature (K), soot, frost, wetness
  params2: vec4f,                    // dither fade (1 = solid), inverted dither pattern (0 / 1), emissive scale, display brightness
}
fn instancePos(m0: vec4f, m1: vec4f, m2: vec4f, p: vec3f) -> vec3f {
  return vec3f(dot(m0.xyz, p) + m0.w, dot(m1.xyz, p) + m1.w, dot(m2.xyz, p) + m2.w);
}
`;

const GBUFFER_SHADER = /* wgsl */ `
#include "frame"
#include "noise"
#include "gbuffer"
${INSTANCE_WGSL}
${CUTOUT_WGSL}
@group(1) @binding(0) var<storage, read> instances: array<MeshInstance>;
@group(1) @binding(1) var blackbodyLut: texture_2d<f32>;
// 'ocean.wetness' (src/core/contracts/render.ts): the water at the vessels that float or are entering it.
struct OceanVesselWater { plane: vec4f, normal: vec4f, params: vec4f }
struct OceanWetness { count: vec4u, vessels: array<OceanVesselWater, ${OCEAN_WETNESS_SLOTS}> }
@group(1) @binding(2) var<uniform> oceanWetness: OceanWetness;
struct Material {
  baseColor: vec4f,   // rgb, a = metallic
  params: vec4f,      // roughness, shading id, material parameter, anisotropy
  emissive: vec4f,    // rgb cd/m^2, a = clearcoat
  misc: vec4f,        // clearcoat roughness, shadow softness (m; terrain and regolith), uv scale
  cutout: vec4f,      // x = alpha cutoff (0 = opaque), yzw unused
}
@group(2) @binding(0) var<uniform> material: Material;
@group(2) @binding(1) var baseColorTex: texture_2d<f32>;
@group(2) @binding(2) var normalTex: texture_2d<f32>;
@group(2) @binding(3) var ormTex: texture_2d<f32>;
@group(2) @binding(4) var emissiveTex: texture_2d<f32>;

struct VIn {
  @location(0) pos: vec3f,
  @location(1) normal: vec3f,
  @location(2) tangent: vec4f,
  @location(3) uv: vec2f,
  @location(4) masks: vec4f,
  @builtin(instance_index) inst: u32,
}
struct VOut {
  @builtin(position) clip: vec4f,
  @location(0) n: vec3f,
  @location(1) t: vec4f,
  @location(2) uv: vec2f,
  @location(3) masks: vec4f,
  @location(4) currClip: vec4f,
  @location(5) prevClip: vec4f,
  @location(6) @interpolate(flat) inst: u32,
  @location(7) pos: vec3f,           // camera-relative position (ROOT axes, m)
}
@vertex fn vs(v: VIn) -> VOut {
  let I = instances[v.inst];
  let p = instancePos(I.m0, I.m1, I.m2, v.pos);
  let q = instancePos(I.p0, I.p1, I.p2, v.pos);
  var o: VOut;
  o.clip = frame.viewProj * vec4f(p, 1.0);
  o.currClip = frame.viewProjUnjittered * vec4f(p, 1.0);
  o.prevClip = frame.prevViewProj * vec4f(q, 1.0);
  // Normals transform with the cofactor matrix (correct under non-uniform scale).
  let r0 = I.m0.xyz; let r1 = I.m1.xyz; let r2 = I.m2.xyz;
  o.n = normalize(vec3f(dot(cross(r1, r2), v.normal), dot(cross(r2, r0), v.normal), dot(cross(r0, r1), v.normal)));
  o.t = vec4f(normalize(vec3f(dot(r0, v.tangent.xyz), dot(r1, v.tangent.xyz), dot(r2, v.tangent.xyz))), v.tangent.w);
  o.uv = v.uv * material.misc.zw;
  o.masks = v.masks;
  o.inst = v.inst;
  o.pos = p;
  return o;
}

/// Wetness (0..1) of a surface point from 'ocean.wetness': 1 below the highest level the water has reached on
/// the hull of a vessel at the water (its wet line, 2 cm soft edge), 0 above it and away from any such vessel.
fn hullWetness(p: vec3f) -> f32 {
  var wet = 0.0;
  let n = min(oceanWetness.count.x, ${OCEAN_WETNESS_SLOTS}u);
  for (var i = 0u; i < n; i++) {
    let w = oceanWetness.vessels[i];
    let rel = p - w.plane.xyz;
    if (dot(rel, rel) < w.plane.w * w.plane.w) {
      wet = max(wet, 1.0 - smoothstep(w.normal.w - 0.02, w.normal.w + 0.02, dot(rel, w.normal.xyz)));
    }
  }
  return wet;
}

/// Value noise in [0, 1] over a 2-D lattice.
fn latticeNoise2(p: vec2f, seed: i32) -> f32 {
  let i = vec2i(floor(p));
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash2f(i, seed), hash2f(i + vec2i(1, 0), seed), u.x), mix(hash2f(i + vec2i(0, 1), seed), hash2f(i + vec2i(1, 1), seed), u.x), u.y);
}
/// Streak noise of a layer on a painted surface (soot, frost) in texture space, in [0, 1] about 0.5: 'uvm' is
/// the mesh UV before the material's scale (metres on a vehicle: u round the part, v along it); cells of
/// 'cell' metres, long along v, and an octave four times larger; gives way to its mean where a cell is under
/// a pixel (no shimmer far away).
fn layerStreaks(uvm: vec2f, cell: vec2f, seed: i32) -> f32 {
  let p = uvm / cell;
  let footprint = max(fwidth(p.x), fwidth(p.y));
  let fine = mix(latticeNoise2(p, seed), 0.5, smoothstep(0.5, 2.0, footprint));
  let coarse = mix(latticeNoise2(p * 0.25, seed + 31), 0.5, smoothstep(0.5, 2.0, footprint * 0.25));
  return 0.55 * fine + 0.45 * coarse;
}

/// Black-body emission (cd/m^2, linear sRGB) from the 256-entry table: T = 500 .. 5000 K.
fn blackbody(T: f32) -> vec3f {
  let u = clamp((T - 500.0) / 4500.0, 0.0, 1.0) * 255.0;
  let i = u32(floor(u));
  let a = textureLoad(blackbodyLut, vec2u(i, 0u), 0);
  let b = textureLoad(blackbodyLut, vec2u(min(i + 1u, 255u), 0u), 0);
  let c = mix(a, b, fract(u));
  return c.rgb * exp2(c.a);
}

@fragment fn fs(v: VOut, @builtin(front_facing) front: bool) -> GBufferOut {
  let I = instances[v.inst];
  let fade = I.params2.x;
  if (fade < 1.0) {
    let nz = blueNoise(vec2u(v.clip.xy)).a;
    if (select(nz, 1.0 - nz, I.params2.y > 0.5) >= fade) { discard; }
  }
  let base = textureSample(baseColorTex, anisoRepeat, v.uv);
  // Alpha test of cut-out materials (request vehicle-pad-4). (Derivatives first: they need uniform control flow.)
  let alphaWidth = fwidth(base.a);
  let texelsPerPixel = cutoutFootprint(v.uv, vec2f(textureDimensions(baseColorTex)));
  if (material.cutout.x > 0.0) {
    if (base.a < cutoutThreshold(material.cutout.x, alphaWidth, texelsPerPixel, blueNoise(vec2u(v.clip.xy)).g)) { discard; }
  }
  let orm = textureSample(ormTex, anisoRepeat, v.uv);
  let tn = textureSample(normalTex, anisoRepeat, v.uv).xyz * 2.0 - 1.0;
  let em = textureSample(emissiveTex, anisoRepeat, v.uv).rgb;

  var N = normalize(v.n);
  if (!front) { N = -N; }
  var T = v.t.xyz - N * dot(v.t.xyz, N);
  T = select(normalize(T), tangentFrame(N)[0], dot(T, T) < 1e-8);
  let B = cross(N, T) * v.t.w;
  var n = normalize(T * tn.x + B * tn.y + N * tn.z);

  var albedo = base.rgb * material.baseColor.rgb;
  var roughness = clamp(material.params.x * orm.g, 0.02, 1.0);
  var metallic = saturate(material.baseColor.a * orm.b);
  let ao = orm.r * v.masks.g;
  let shading = u32(material.params.y + 0.5);
  var param = material.params.z;

  // What lies ON the paint (soot, frost) covers its clear coat and its brushed highlight: 1 = bare.
  var coat = 1.0;
  if (shading == MATERIAL_STANDARD) {
    // Edge wear exposes bare, slightly rough metal; soot and frost are driven per instance, each as a density
    // (requests vehicle-pad-7, vehicle-pad-11).
    let wear = v.masks.r * 0.6;
    albedo = mix(albedo, vec3f(0.56, 0.57, 0.58), wear);
    metallic = mix(metallic, 1.0, wear);
    roughness = mix(roughness, 0.42, wear);
    let uvm = v.uv / max(abs(material.misc.zw), vec2f(1e-6));
    // Soot is a density, not a mask: the weight, modulated by a third in streaks of 6 cm x 1.5 m (and
    // 24 cm x 6 m) along the flow. A thin deposit is a grey veil with a little warmth over the surface (its
    // albedo is multiplied, so tiles, seams and markings still show); a thick one is neutral black (request
    // vehicle-pad-13: soot is close to neutral, not coffee brown). Roughness, metalness and the clear coat
    // follow the density continuously: nothing has an edge unless the weight has one.
    let sootDensity = saturate(saturate(I.params.y * v.masks.b) * (0.67 + 0.66 * layerStreaks(uvm, vec2f(0.06, 1.5), 7)));
    let sootVeil = smoothstep(0.0, 0.5, sootDensity);
    let soot = smoothstep(0.2, 0.85, sootDensity);
    albedo = mix(albedo * mix(vec3f(1.0), vec3f(0.42, 0.38, 0.33), sootVeil), vec3f(0.022, 0.021, 0.020), soot * 0.96);
    roughness = mix(roughness, 0.92, smoothstep(0.0, 0.7, sootDensity));
    metallic *= 1.0 - smoothstep(0.15, 0.9, sootDensity);
    // Frost is a coat with a thickness, not a mask (request vehicle-pad-11): the weight, modulated by a
    // quarter in runnels of 8 cm x 1.2 m. A thin coat is a translucent haze (the paint and its markings show
    // through, greyed); from a weight of about 0.6 the coat is opaque rime, cool white and dead matte.
    // Nothing has an edge unless the weight has one.
    let frostWeight = saturate(I.params.z * v.masks.a);
    let frostDensity = saturate(frostWeight * (0.75 + 0.5 * layerStreaks(uvm, vec2f(0.08, 1.2), 19)));
    let frostCover = smoothstep(0.0, 0.6, frostDensity);
    albedo = mix(albedo, vec3f(0.90, 0.94, 1.0), frostCover);
    roughness = mix(roughness, 0.95, frostCover);
    metallic *= 1.0 - frostCover;
    coat = (1.0 - smoothstep(0.0, 0.35, sootDensity)) * (1.0 - frostCover);
    param = max(param, max(I.params.w, hullWetness(v.pos)));
  } else if (shading == MATERIAL_TERRAIN) {
    // Site structures: soot is grime and frost is rime, plain blends of the vertex masks.
    let soot = saturate(I.params.y * v.masks.b);
    albedo = mix(albedo, vec3f(0.018, 0.017, 0.016), soot * 0.92);
    roughness = mix(roughness, 0.9, soot);
    metallic *= 1.0 - soot;
    let frost = saturate(I.params.z * v.masks.a);
    albedo = mix(albedo, vec3f(0.86, 0.89, 0.93), frost);
    roughness = mix(roughness, 0.62, frost);
    metallic *= 1.0 - frost;
    param = max(param, max(I.params.w, hullWetness(v.pos)));
  } else if (shading == MATERIAL_DISPLAY) {
    // RT2.a of a display is its brightness; the deferred pass scales the emitted image (RT5) by it.
    param = saturate(param * I.params2.w);
  }

  // Kaplanyan-Hill geometric specular anti-aliasing: widen the lobe by the normal variance in the pixel.
  let du = dpdx(N);
  let dv = dpdy(N);
  let kernel = min(2.0 * 0.25 * (dot(du, du) + dot(dv, dv)), 0.18);
  let a = roughness * roughness;
  roughness = sqrt(sqrt(saturate(a * a + kernel)));

  var emissive = material.emissive.rgb * em * I.params2.z;
  if (I.params.x > 500.0) { emissive += blackbody(I.params.x) * (0.85 * (1.0 - 0.6 * metallic)); }

  var o = gbufferPack(albedo, ao, n, roughness, metallic, shading, param,
                      velocityFromClip(v.currClip, v.prevClip), emissive * frame.exposure.x);
  if (shading == MATERIAL_STANDARD) {
    let Ta = normalize(T - n * dot(T, n));
    o.extra = gbufferExtra(n, Ta, material.params.w * coat, material.emissive.a * coat, material.misc.x);
  } else if (shading == MATERIAL_TERRAIN || shading == MATERIAL_REGOLITH) {
    o.extra.a = encodeShadowSoftness(material.misc.y);
  }
  return o;
}
`;

const SHADOW_SHADER = /* wgsl */ `
#include "frame"
#include "shadow_pass"
${INSTANCE_WGSL}
@group(2) @binding(0) var<storage, read> instances: array<MeshInstance>;
@vertex fn vs(@location(0) pos: vec3f, @builtin(instance_index) inst: u32) -> @builtin(position) vec4f {
  let I = instances[inst];
  return shadowPass.viewProj * vec4f(instancePos(I.m0, I.m1, I.m2, pos), 1.0);
}
`;

/** Shadow pass of cut-out materials (request vehicle-pad-4): the alpha test of the G-buffer shader, with uv. */
const SHADOW_CUTOUT_SHADER = /* wgsl */ `
#include "frame"
#include "shadow_pass"
${INSTANCE_WGSL}
@group(2) @binding(0) var<storage, read> instances: array<MeshInstance>;
struct Material { baseColor: vec4f, params: vec4f, emissive: vec4f, misc: vec4f, cutout: vec4f }
@group(3) @binding(0) var<uniform> material: Material;
@group(3) @binding(1) var baseColorTex: texture_2d<f32>;
struct SOut {
  @builtin(position) clip: vec4f,
  @location(0) uv: vec2f,
}
@vertex fn vs(@location(0) pos: vec3f, @location(1) uv: vec2f, @builtin(instance_index) inst: u32) -> SOut {
  let I = instances[inst];
  var o: SOut;
  o.clip = shadowPass.viewProj * vec4f(instancePos(I.m0, I.m1, I.m2, pos), 1.0);
  o.uv = uv * material.misc.zw;
  return o;
}
${CUTOUT_WGSL}
@fragment fn fs(v: SOut) {
  let a = textureSample(baseColorTex, anisoRepeat, v.uv).a;
  let alphaWidth = fwidth(a);
  let texelsPerPixel = cutoutFootprint(v.uv, vec2f(textureDimensions(baseColorTex)));
  if (a < cutoutThreshold(material.cutout.x, alphaWidth, texelsPerPixel, blueNoise(vec2u(v.clip.xy)).g)) { discard; }
}
`;

/** Pose of a frame (body-fixed or vessel) relative to the camera, now and one frame ago. */
export interface ParentPose {
  originRelCam: Vec3;
  q: Quat;
  prevOriginRelCam: Vec3;
  prevQ: Quat;
}

export interface MeshInstance {
  /** Model origin relative to the camera (ROOT axes, float64) and model -> ROOT orientation. */
  originRelCam: Vec3;
  q: Quat;
  /** Uniform or per-axis scale (default 1). */
  scale?: number | Vec3Tuple;
  /** Previous frame, relative to the PREVIOUS camera eye (default: no motion on screen). */
  prevOriginRelCam?: Vec3;
  prevQ?: Quat;
  /**
   * Caster class: true = fixed to the body the shadow cascades are anchored to (terrain props, site
   * structures): drawn into every cascade. false = moving (vessels, debris): only into cascades that are
   * re-rendered every frame.
   */
  bodyFixed: boolean;
  castShadow?: boolean;
  /** Kelvin; above 500 K the surface glows as a black body. */
  temperature?: number;
  soot?: number;
  frost?: number;
  wetness?: number;
  /** Dither fade 0..1 (1 = solid). */
  fade?: number;
  /** Multiplier on the material's emissive luminance (default 1). */
  emissiveScale?: number;
  /** Brightness 0..1 of a 'display' material (default 1): written to RT2.a, applied to the emitted image by the deferred pass. */
  displayBrightness?: number;
}

/** Place something given in a parent frame (body-fixed or VES): exact float64 composition for now and the previous frame. */
export function instanceInFrame(parent: ParentPose, localPos: Vec3, localRot: Quat | null, rest: Omit<MeshInstance, 'originRelCam' | 'q' | 'prevOriginRelCam' | 'prevQ'>): MeshInstance {
  return {
    ...rest,
    originRelCam: v3.add(parent.originRelCam, quat.rotate(parent.q, localPos)),
    q: localRot ? quat.mul(parent.q, localRot) : parent.q,
    prevOriginRelCam: v3.add(parent.prevOriginRelCam, quat.rotate(parent.prevQ, localPos)),
    prevQ: localRot ? quat.mul(parent.prevQ, localRot) : parent.prevQ,
  };
}

export interface ModelOptions {
  /** Projected diameter (px) below which LOD i + 1 replaces LOD i. Default DEFAULT_LOD_PIXELS. */
  lodPixels?: readonly number[];
}

export interface ModelHandle {
  readonly name: string;
  readonly lodCount: number;
  /** Bounding sphere of LOD 0 in model space. */
  readonly boundsCenter: Vec3Tuple;
  readonly boundsRadius: number;
  /** Triangles per LOD. */
  readonly triangles: readonly number[];
  destroy(): void;
}

export interface MeshBatch {
  /** Start a new frame: clears the instance list. Call in `prepare`. */
  begin(frame: FrameContext): void;
  add(model: ModelHandle, instance: MeshInstance): void;
  /** Upload the instance buffer. Call once after the last `add`, still in `prepare`. */
  finish(): void;
  /** Call from `drawGBuffer`. */
  drawGBuffer(pass: GPURenderPassEncoder): void;
  /** Call from `drawShadow`: draws body-fixed casters always and moving casters only when `cascade.everyFrame`. */
  drawShadow(pass: GPURenderPassEncoder, cascade: ShadowCascadeView): void;
  /**
   * Every caster inside a perspective frustum (a spot light's shadow map; the core calls it for every batch,
   * request vehicle-pad-2). Group 1 (the shadow pass uniform) is bound by the caller.
   */
  drawSpotShadow(pass: GPURenderPassEncoder, viewProj: Mat4, frameIndex: number): void;
  /** Instances and triangles submitted to the G-buffer in the last frame. */
  readonly stats: { instances: number; triangles: number; shadowTriangles: number };
  destroy(): void;
}

export interface MeshSystem {
  createModel(data: ModelData, options?: ModelOptions): ModelHandle;
  /** Register a procedural texture that PbrMaterialDef.textures can name by id. */
  registerProceduralTexture(id: string, texture: ProceduralTexture): void;
  createBatch(label: string): MeshBatch;
  /** Draw every live batch's casters into a spot-light shadow map (the core's own pass; request vehicle-pad-2). */
  drawSpotShadows(pass: GPURenderPassEncoder, viewProj: Mat4, frameIndex: number): void;
  /** True when no texture is still loading. */
  isIdle(): boolean;
  /** Texture loads started so far and still outstanding, for a progress display (request app-integration-11). */
  loads(): { pending: number; total: number };
  /** The system's tracked pipelines (G-buffer both cull modes, shadow, cut-out shadow), for `shaders.warm`. */
  pipelines(): Tracked<unknown>[];
}

interface GpuMaterial {
  def: PbrMaterialDef;
  buffer: GPUBuffer;
  refs: TextureRef[];
  versions: number;
  bindGroup: GPUBindGroup | null;
}

interface GpuLod {
  buffers: GPUBuffer[];
  index: GPUBuffer;
  indexCount: number;
  groups: MeshData['groups'];
}

interface ModelImpl extends ModelHandle {
  lods: GpuLod[];
  materials: GpuMaterial[];
  /** Some material is alpha-tested: the shadow pass draws per material group (request vehicle-pad-4). */
  cutout: boolean;
  lodPixels: readonly number[];
  uid: number;
}

/** CIE 1931 colour matching functions, Wyman-Sloan-Shirley multi-lobe fit (wavelength in nm). */
function cieXyz(l: number): [number, number, number] {
  const g = (x: number, mu: number, s1: number, s2: number): number => {
    const t = (x - mu) / (x < mu ? s1 : s2);
    return Math.exp(-0.5 * t * t);
  };
  return [
    1.056 * g(l, 599.8, 37.9, 31.0) + 0.362 * g(l, 442.0, 16.0, 26.7) - 0.065 * g(l, 501.1, 20.4, 26.2),
    0.821 * g(l, 568.8, 46.9, 40.5) + 0.286 * g(l, 530.9, 16.3, 31.1),
    1.217 * g(l, 437.0, 11.8, 36.0) + 0.681 * g(l, 459.0, 26.0, 13.8),
  ];
}

/** Black-body luminance (cd/m^2) and linear-sRGB colour normalised to luminance 1 at temperature T (K). */
export function blackbodyRadiance(T: number): { luminance: number; color: Vec3Tuple } {
  const h = 6.62607015e-34;
  const c = 2.99792458e8;
  const k = 1.380649e-23;
  let X = 0;
  let Y = 0;
  let Z = 0;
  for (let nm = 380; nm <= 780; nm += 5) {
    const l = nm * 1e-9;
    const B = (2 * h * c * c) / l ** 5 / Math.expm1((h * c) / (l * k * T));
    const [x, y, z] = cieXyz(nm);
    X += B * x;
    Y += B * y;
    Z += B * z;
  }
  const d = 5e-9 * 683;
  X *= d;
  Y *= d;
  Z *= d;
  const r = Math.max(0, 3.2406 * X - 1.5372 * Y - 0.4986 * Z);
  const g = Math.max(0, -0.9689 * X + 1.8758 * Y + 0.0415 * Z);
  const b = Math.max(0, 0.0557 * X - 0.204 * Y + 1.057 * Z);
  const lum = Math.max(0.2126 * r + 0.7152 * g + 0.0722 * b, 1e-30);
  return { luminance: Y, color: [r / lum, g / lum, b / lum] };
}

const VERTEX_LAYOUT: GPUVertexBufferLayout[] = [
  { arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }] },
  { arrayStride: 12, attributes: [{ shaderLocation: 1, offset: 0, format: 'float32x3' }] },
  { arrayStride: 16, attributes: [{ shaderLocation: 2, offset: 0, format: 'float32x4' }] },
  { arrayStride: 8, attributes: [{ shaderLocation: 3, offset: 0, format: 'float32x2' }] },
  { arrayStride: 4, attributes: [{ shaderLocation: 4, offset: 0, format: 'unorm8x4' }] },
];

class Group {
  data = new Float32Array(INSTANCE_FLOATS * 8);
  /** Bounding sphere per instance: x, y, z (camera-relative), radius. */
  spheres = new Float32Array(4 * 8);
  /** bit 0 = inside the view frustum, bit 1 = casts a shadow. */
  flags = new Uint8Array(8);
  count = 0;
  first = 0;
  constructor(
    readonly model: ModelImpl,
    readonly lod: number,
    readonly bodyFixed: boolean,
  ) {}
  grow(): void {
    const cap = this.flags.length * 2;
    const d = new Float32Array(INSTANCE_FLOATS * cap);
    d.set(this.data);
    this.data = d;
    const s = new Float32Array(4 * cap);
    s.set(this.spheres);
    this.spheres = s;
    const f = new Uint8Array(cap);
    f.set(this.flags);
    this.flags = f;
  }
}

export function createMeshSystem(args: {
  device: GPUDevice;
  shaders: CoreShaderLibrary;
  frameLayout: GPUBindGroupLayout;
  shadowPassLayout: GPUBindGroupLayout;
  textures: TextureManager;
  /** For 'ocean.wetness' (the wet line on hulls). */
  resources: SharedResources;
  reportError: (m: string) => void;
}): MeshSystem {
  const { device, shaders, frameLayout, shadowPassLayout, textures, resources, reportError } = args;

  const batchLayout = device.createBindGroupLayout({
    label: 'mesh.batch',
    entries: [
      { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
      { binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
    ],
  });
  const materialLayout = device.createBindGroupLayout({
    label: 'mesh.material',
    entries: [
      { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
      ...[1, 2, 3, 4].map((binding) => ({ binding, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' as const } })),
    ],
  });

  // Black-body table: rgb = colour at luminance 1, a = log2(luminance).
  const bb = new Uint16Array(256 * 4);
  for (let i = 0; i < 256; i++) {
    const { luminance, color } = blackbodyRadiance(500 + (i / 255) * 4500);
    bb[i * 4] = f32ToF16(color[0]);
    bb[i * 4 + 1] = f32ToF16(color[1]);
    bb[i * 4 + 2] = f32ToF16(color[2]);
    bb[i * 4 + 3] = f32ToF16(Math.log2(Math.max(luminance, 1e-9)));
  }
  const bbTex = device.createTexture({ label: 'mesh.blackbody', format: 'rgba16float', size: [256, 1], usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
  device.queue.writeTexture({ texture: bbTex }, bb, {}, [256, 1]);
  const bbView = bbTex.createView();

  const gbufferTargets: GPUColorTargetState[] = [
    { format: RENDER_FORMATS.gbufferAlbedo },
    { format: RENDER_FORMATS.gbufferNormal },
    { format: RENDER_FORMATS.gbufferMaterial },
    { format: RENDER_FORMATS.gbufferVelocity },
    { format: RENDER_FORMATS.gbufferExtra },
    { format: RENDER_FORMATS.hdr },
  ];
  const gbufferPipelines: Tracked<{ back: GPURenderPipeline; none: GPURenderPipeline }> = shaders.tracked(() => {
    const module = shaders.createModule('mesh.gbuffer', GBUFFER_SHADER);
    const layout = device.createPipelineLayout({ label: 'mesh.gbuffer', bindGroupLayouts: [frameLayout, batchLayout, materialLayout] });
    const make = (cullMode: GPUCullMode): GPURenderPipeline =>
      device.createRenderPipeline({
        label: `mesh.gbuffer.${cullMode}`,
        layout,
        vertex: { module, entryPoint: 'vs', buffers: VERTEX_LAYOUT },
        fragment: { module, entryPoint: 'fs', targets: gbufferTargets },
        primitive: { topology: 'triangle-list', cullMode, frontFace: 'ccw' },
        depthStencil: { format: RENDER_FORMATS.depth, depthWriteEnabled: true, depthCompare: 'greater' },
      });
    return { back: make('back'), none: make('none') };
  });
  const shadowPipeline: Tracked<GPURenderPipeline> = shaders.tracked(() => {
    const module = shaders.createModule('mesh.shadow', SHADOW_SHADER);
    return device.createRenderPipeline({
      label: 'mesh.shadow',
      layout: device.createPipelineLayout({ label: 'mesh.shadow', bindGroupLayouts: [frameLayout, shadowPassLayout, batchLayout] }),
      vertex: { module, entryPoint: 'vs', buffers: [VERTEX_LAYOUT[0]!] },
      primitive: { topology: 'triangle-list', cullMode: 'none', unclippedDepth: true },
      depthStencil: { format: RENDER_FORMATS.shadow, depthWriteEnabled: true, depthCompare: 'less', depthBias: 2, depthBiasSlopeScale: 1.5 },
    });
  });
  // Cut-out materials (request vehicle-pad-4): position and uv, the base colour's alpha tested in the fragment.
  const shadowCutoutPipeline: Tracked<GPURenderPipeline> = shaders.tracked(() => {
    const module = shaders.createModule('mesh.shadow.cutout', SHADOW_CUTOUT_SHADER);
    return device.createRenderPipeline({
      label: 'mesh.shadow.cutout',
      layout: device.createPipelineLayout({ label: 'mesh.shadow.cutout', bindGroupLayouts: [frameLayout, shadowPassLayout, batchLayout, materialLayout] }),
      vertex: { module, entryPoint: 'vs', buffers: [VERTEX_LAYOUT[0]!, { arrayStride: 8, attributes: [{ shaderLocation: 1, offset: 0, format: 'float32x2' }] }] },
      fragment: { module, entryPoint: 'fs', targets: [] },
      primitive: { topology: 'triangle-list', cullMode: 'none', unclippedDepth: true },
      depthStencil: { format: RENDER_FORMATS.shadow, depthWriteEnabled: true, depthCompare: 'less', depthBias: 2, depthBiasSlopeScale: 1.5 },
    });
  });

  const vertexBuffer = (label: string, data: ArrayBufferView<ArrayBuffer>, usage: GPUBufferUsageFlags): GPUBuffer => {
    const b = createBufferChecked(device, { label, size: Math.max(16, Math.ceil(data.byteLength / 4) * 4), usage: usage | GPUBufferUsage.COPY_DST }, reportError);
    device.queue.writeBuffer(b, 0, data);
    return b;
  };

  const materialBindGroup = (m: GpuMaterial): GPUBindGroup => {
    let v = 0;
    for (const r of m.refs) v += r.version;
    if (!m.bindGroup || v !== m.versions) {
      m.versions = v;
      m.bindGroup = device.createBindGroup({
        label: `mesh.material.${m.def.name}`,
        layout: materialLayout,
        entries: [{ binding: 0, resource: { buffer: m.buffer } }, ...m.refs.map((r, i) => ({ binding: i + 1, resource: r.view }))],
      });
    }
    return m.bindGroup;
  };

  let nextModelUid = 1;
  /** Every live batch: the core draws them all into the spot-light shadow maps (request vehicle-pad-2). */
  const batches = new Set<MeshBatch>();
  const system: MeshSystem = {
    drawSpotShadows(pass, viewProj, frameIndex) {
      for (const b of batches) b.drawSpotShadow(pass, viewProj, frameIndex);
    },
    registerProceduralTexture: (id, texture) => textures.registerProcedural(id, texture),
    isIdle: () => textures.pendingLoads() === 0,
    loads: () => ({ pending: textures.pendingLoads(), total: textures.startedLoads() }),
    pipelines: () => [gbufferPipelines, shadowPipeline, shadowCutoutPipeline],

    createModel(data, options = {}) {
      if (data.lods.length === 0) throw new Error(`model ${data.name}: no LODs`);
      const lods: GpuLod[] = data.lods.map((mesh, li) => {
        const vcount = mesh.positions.length / 3;
        const masks = mesh.masks ?? new Uint8Array(vcount * 4).fill(255).map((x, i) => (i % 4 === 0 ? 0 : x));
        const label = `mesh.${data.name}.lod${li}`;
        return {
          buffers: [
            vertexBuffer(`${label}.pos`, mesh.positions as Float32Array<ArrayBuffer>, GPUBufferUsage.VERTEX),
            vertexBuffer(`${label}.nrm`, mesh.normals as Float32Array<ArrayBuffer>, GPUBufferUsage.VERTEX),
            vertexBuffer(`${label}.tan`, mesh.tangents as Float32Array<ArrayBuffer>, GPUBufferUsage.VERTEX),
            vertexBuffer(`${label}.uv`, mesh.uvs as Float32Array<ArrayBuffer>, GPUBufferUsage.VERTEX),
            vertexBuffer(`${label}.mask`, masks as Uint8Array<ArrayBuffer>, GPUBufferUsage.VERTEX),
          ],
          index: vertexBuffer(`${label}.idx`, mesh.indices as Uint32Array<ArrayBuffer>, GPUBufferUsage.INDEX),
          indexCount: mesh.indices.length,
          groups: mesh.groups,
        };
      });
      const materials: GpuMaterial[] = data.materials.map((def) => {
        const u = new Float32Array(20);
        u.set([def.baseColor[0], def.baseColor[1], def.baseColor[2], def.metallic], 0);
        const param = def.shading === 'cloth' ? (def.translucency ?? 0) : def.shading === 'display' ? 1 : 0;
        u.set([def.roughness, MATERIAL_ID[def.shading], param, def.anisotropy ?? 0], 4);
        const e = def.emissive ?? [0, 0, 0];
        u.set([e[0], e[1], e[2], def.clearcoat ?? 0], 8);
        u.set([def.clearcoatRoughness ?? 0.1, def.shadowSoftness ?? 0, def.uvScale?.[0] ?? 1, def.uvScale?.[1] ?? 1], 12);
        u.set([Math.max(def.alphaCutoff ?? 0, 0), 0, 0, 0], 16);
        const buffer = device.createBuffer({ label: `mesh.material.${def.name}`, size: 80, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
        device.queue.writeBuffer(buffer, 0, u);
        const t = def.textures ?? {};
        return {
          def,
          buffer,
          refs: [textures.resolve(t.baseColor, 'baseColor'), textures.resolve(t.normal, 'normal'), textures.resolve(t.orm, 'orm'), textures.resolve(t.emissive, 'emissive')],
          versions: -1,
          bindGroup: null,
        };
      });
      const b = data.lods[0]!.bounds;
      const center: Vec3Tuple = [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2];
      const model: ModelImpl = {
        uid: nextModelUid++,
        name: data.name,
        lodCount: lods.length,
        boundsCenter: center,
        boundsRadius: Math.hypot(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]) / 2,
        triangles: lods.map((l) => l.indexCount / 3),
        lods,
        materials,
        cutout: materials.some((m) => (m.def.alphaCutoff ?? 0) > 0),
        lodPixels: options.lodPixels ?? DEFAULT_LOD_PIXELS,
        destroy() {
          for (const l of lods) {
            for (const buf of l.buffers) buf.destroy();
            l.index.destroy();
          }
          for (const m of materials) m.buffer.destroy();
        },
      };
      for (const l of data.lods) {
        for (const g of l.groups) if (!materials[g.material]) throw new Error(`model ${data.name}: group refers to missing material ${g.material}`);
      }
      return model;
    },

    createBatch(label) {
      const groups = new Map<string, Group>();
      let buffer: GPUBuffer | null = null;
      let capacity = 0;
      let bindGroup: GPUBindGroup | null = null;
      let boundWetness = -1;
      let upload = new Float32Array(INSTANCE_FLOATS * 64);
      let frame: FrameContext | null = null;
      let pxScale = 1;
      let tanX = 1;
      let tanY = 1;
      const stats = { instances: 0, triangles: 0, shadowTriangles: 0 };

      const groupOf = (model: ModelImpl, lod: number, bodyFixed: boolean): Group => {
        const key = `${model.uid}|${lod}|${bodyFixed ? 1 : 0}`;
        let g = groups.get(key);
        if (!g) {
          g = new Group(model, lod, bodyFixed);
          groups.set(key, g);
        }
        return g;
      };

      const push = (g: Group, rows: Float64Array, prevRows: Float64Array, inst: MeshInstance, sphere: [number, number, number, number], inView: boolean, fade: number, invert: number): void => {
        if (g.count === g.flags.length) g.grow();
        const o = g.count * INSTANCE_FLOATS;
        const d = g.data;
        for (let i = 0; i < 12; i++) {
          d[o + i] = rows[i]!;
          d[o + 12 + i] = prevRows[i]!;
        }
        d[o + 24] = inst.temperature ?? 0;
        d[o + 25] = inst.soot ?? 0;
        d[o + 26] = inst.frost ?? 0;
        d[o + 27] = inst.wetness ?? 0;
        d[o + 28] = fade;
        d[o + 29] = invert;
        d[o + 30] = inst.emissiveScale ?? 1;
        d[o + 31] = inst.displayBrightness ?? 1;
        g.spheres.set(sphere, g.count * 4);
        g.flags[g.count] = (inView ? 1 : 0) | (inst.castShadow !== false && fade >= 0.5 ? 2 : 0);
        g.count++;
      };

      const rowsOf = (out: Float64Array, origin: Vec3, q: Quat, sx: number, sy: number, sz: number): void => {
        const r = mat3.fromQuat(q);
        out[0] = r[0] * sx;
        out[1] = r[1] * sy;
        out[2] = r[2] * sz;
        out[3] = origin.x;
        out[4] = r[3] * sx;
        out[5] = r[4] * sy;
        out[6] = r[5] * sz;
        out[7] = origin.y;
        out[8] = r[6] * sx;
        out[9] = r[7] * sy;
        out[10] = r[8] * sz;
        out[11] = origin.z;
      };
      const rows = new Float64Array(12);
      const prevRows = new Float64Array(12);

      const batch: MeshBatch = {
        stats,
        begin(f) {
          frame = f;
          for (const g of groups.values()) g.count = 0;
          stats.shadowTriangles = 0;
          tanX = 1 / f.projUnjittered[0]!;
          tanY = 1 / f.projUnjittered[5]!;
          pxScale = f.renderSize[1] / tanY;
        },

        add(handle, inst) {
          if (!frame) throw new Error(`mesh batch ${label}: add() before begin()`);
          const model = handle as ModelImpl;
          const s = inst.scale ?? 1;
          const sx = typeof s === 'number' ? s : s[0];
          const sy = typeof s === 'number' ? s : s[1];
          const sz = typeof s === 'number' ? s : s[2];
          rowsOf(rows, inst.originRelCam, inst.q, sx, sy, sz);
          rowsOf(prevRows, inst.prevOriginRelCam ?? inst.originRelCam, inst.prevQ ?? inst.q, sx, sy, sz);
          const c = model.boundsCenter;
          const cx = rows[0]! * c[0] + rows[1]! * c[1] + rows[2]! * c[2] + rows[3]!;
          const cy = rows[4]! * c[0] + rows[5]! * c[1] + rows[6]! * c[2] + rows[7]!;
          const cz = rows[8]! * c[0] + rows[9]! * c[1] + rows[10]! * c[2] + rows[11]!;
          const radius = model.boundsRadius * Math.max(Math.abs(sx), Math.abs(sy), Math.abs(sz));
          // View-space sphere test against the four side planes and the eye plane (infinite far).
          const m = frame.view;
          const vx = m[0]! * cx + m[4]! * cy + m[8]! * cz;
          const vy = m[1]! * cx + m[5]! * cy + m[9]! * cz;
          const depth = -(m[2]! * cx + m[6]! * cy + m[10]! * cz);
          const inView = depth > -radius && Math.abs(vx) < depth * tanX + radius * Math.hypot(1, tanX) && Math.abs(vy) < depth * tanY + radius * Math.hypot(1, tanY);
          const dist = Math.max(Math.hypot(cx, cy, cz), 1e-3);
          const sizePx = (radius / dist) * pxScale;
          const sphere: [number, number, number, number] = [cx, cy, cz, radius];
          const fade = inst.fade ?? 1;

          let lod = 0;
          while (lod < model.lodCount - 1 && sizePx < (model.lodPixels[lod] ?? 0) * (1 - LOD_FADE_BAND)) lod++;
          // Inside the band around the next switch size both LODs are drawn with complementary dither patterns.
          const t = lod < model.lodCount - 1 ? (model.lodPixels[lod] ?? 0) : 0;
          if (t > 0 && sizePx < t * (1 + LOD_FADE_BAND)) {
            const k = (sizePx - t * (1 - LOD_FADE_BAND)) / (2 * LOD_FADE_BAND * t);
            push(groupOf(model, lod, inst.bodyFixed), rows, prevRows, inst, sphere, inView, fade * k, 0);
            push(groupOf(model, lod + 1, inst.bodyFixed), rows, prevRows, inst, sphere, inView, fade * (1 - k), 1);
          } else {
            push(groupOf(model, lod, inst.bodyFixed), rows, prevRows, inst, sphere, inView, fade, 0);
          }
        },

        finish() {
          let total = 0;
          for (const g of groups.values()) {
            g.first = total;
            total += g.count;
          }
          stats.instances = total;
          if (total === 0) return;
          if (upload.length < total * INSTANCE_FLOATS) upload = new Float32Array(Math.max(total * INSTANCE_FLOATS, upload.length * 2));
          for (const g of groups.values()) upload.set(g.data.subarray(0, g.count * INSTANCE_FLOATS), g.first * INSTANCE_FLOATS);
          const wetnessVersion = resources.version('ocean.wetness');
          if (!buffer || capacity < total || wetnessVersion !== boundWetness) {
            if (!buffer || capacity < total) {
              buffer?.destroy();
              capacity = Math.max(64, 2 ** Math.ceil(Math.log2(total)));
              buffer = createBufferChecked(device, { label: `mesh.batch.${label}`, size: capacity * INSTANCE_FLOATS * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST }, reportError);
            }
            boundWetness = wetnessVersion;
            bindGroup = device.createBindGroup({
              label: `mesh.batch.${label}`,
              layout: batchLayout,
              entries: [
                { binding: 0, resource: { buffer } },
                { binding: 1, resource: bbView },
                { binding: 2, resource: { buffer: resources.get('ocean.wetness') } },
              ],
            });
          }
          device.queue.writeBuffer(buffer, 0, upload, 0, total * INSTANCE_FLOATS);
        },

        drawGBuffer(pass) {
          stats.triangles = 0;
          if (!bindGroup || stats.instances === 0) return;
          const pipes = gbufferPipelines.get();
          pass.setBindGroup(1, bindGroup);
          for (const g of groups.values()) {
            if (g.count === 0) continue;
            const lod = g.model.lods[g.lod]!;
            let bound = false;
            let i = 0;
            while (i < g.count) {
              if (!(g.flags[i]! & 1)) {
                i++;
                continue;
              }
              let j = i + 1;
              while (j < g.count && g.flags[j]! & 1) j++;
              if (!bound) {
                for (let b = 0; b < lod.buffers.length; b++) pass.setVertexBuffer(b, lod.buffers[b]!);
                pass.setIndexBuffer(lod.index, 'uint32');
                bound = true;
              }
              for (const mg of lod.groups) {
                const mat = g.model.materials[mg.material]!;
                pass.setPipeline(mat.def.doubleSided ? pipes.none : pipes.back);
                pass.setBindGroup(2, materialBindGroup(mat));
                pass.drawIndexed(mg.count, j - i, mg.start, 0, g.first + i);
              }
              stats.triangles += (lod.indexCount / 3) * (j - i);
              i = j;
            }
          }
        },

        drawShadow(pass, cascade) {
          const m = cascade.viewProj;
          // Clip units per metre along u and along v (they differ in a cascade fitted to its receivers).
          const scaleU = Math.hypot(m[0]!, m[4]!, m[8]!);
          const scaleV = Math.hypot(m[1]!, m[5]!, m[9]!);
          drawCasters(pass, (g) => g.bodyFixed || cascade.everyFrame, (g, k) => {
            const o = k * 4;
            const r = g.spheres[o + 3]!;
            if (r < 0.5 * cascade.texelSize) return false;
            const x = g.spheres[o]!;
            const y = g.spheres[o + 1]!;
            const z = g.spheres[o + 2]!;
            return Math.abs(m[0]! * x + m[4]! * y + m[8]! * z + m[12]!) < 1 + r * scaleU && Math.abs(m[1]! * x + m[5]! * y + m[9]! * z + m[13]!) < 1 + r * scaleV;
          });
        },

        drawSpotShadow(pass, viewProj, frameIndex) {
          // Only a batch filled this frame (a feature that was switched off keeps last frame's instances).
          if (!frame || frame.frameIndex !== frameIndex) return;
          // A perspective frustum (request vehicle-pad-2): every caster whose bounding sphere is inside its six planes.
          const m = viewProj;
          const planes: number[][] = [];
          const row = (i: number): number[] => [m[i]!, m[4 + i]!, m[8 + i]!, m[12 + i]!];
          const r0 = row(0);
          const r1 = row(1);
          const r2 = row(2);
          const r3 = row(3);
          for (const p of [r3.map((v, i) => v + r0[i]!), r3.map((v, i) => v - r0[i]!), r3.map((v, i) => v + r1[i]!), r3.map((v, i) => v - r1[i]!), r2, r3.map((v, i) => v - r2[i]!)]) {
            const l = Math.hypot(p[0]!, p[1]!, p[2]!) || 1;
            planes.push(p.map((v) => v / l));
          }
          drawCasters(pass, () => true, (g, k) => {
            const o = k * 4;
            const x = g.spheres[o]!;
            const y = g.spheres[o + 1]!;
            const z = g.spheres[o + 2]!;
            const r = g.spheres[o + 3]!;
            for (const p of planes) if (p[0]! * x + p[1]! * y + p[2]! * z + p[3]! < -r) return false;
            return true;
          });
        },

        destroy() {
          batches.delete(batch);
          buffer?.destroy();
          buffer = null;
          bindGroup = null;
          groups.clear();
        },
      };

      /** Draw the shadow casters of the groups `useGroup` accepts that `visibleIn` keeps (castShadow flag first). */
      const drawCasters = (pass: GPURenderPassEncoder, useGroup: (g: Group) => boolean, visibleIn: (g: Group, k: number) => boolean): void => {
          if (!bindGroup || stats.instances === 0) return;
          let pipelineSet = false;
          for (const g of groups.values()) {
            if (g.count === 0 || !useGroup(g)) continue;
            const lod = g.model.lods[g.lod]!;
            const visible = (k: number): boolean => (g.flags[k]! & 2) !== 0 && visibleIn(g, k);
            let bound = false;
            let i = 0;
            while (i < g.count) {
              if (!visible(i)) {
                i++;
                continue;
              }
              let j = i + 1;
              while (j < g.count && visible(j)) j++;
              if (g.model.cutout) {
                // Per material group: cut-out materials through the alpha-tested pipeline (request vehicle-pad-4).
                for (const mg of lod.groups) {
                  const mat = g.model.materials[mg.material]!;
                  const cut = (mat.def.alphaCutoff ?? 0) > 0;
                  pass.setPipeline(cut ? shadowCutoutPipeline.get() : shadowPipeline.get());
                  pass.setBindGroup(2, bindGroup);
                  if (cut) pass.setBindGroup(3, materialBindGroup(mat));
                  pass.setVertexBuffer(0, lod.buffers[0]!);
                  if (cut) pass.setVertexBuffer(1, lod.buffers[3]!);
                  pass.setIndexBuffer(lod.index, 'uint32');
                  pass.drawIndexed(mg.count, j - i, mg.start, 0, g.first + i);
                }
                // The next opaque model rebinds the plain pipeline.
                pipelineSet = false;
                bound = false;
              } else {
                if (!pipelineSet) {
                  pass.setPipeline(shadowPipeline.get());
                  pass.setBindGroup(2, bindGroup);
                  pipelineSet = true;
                }
                if (!bound) {
                  pass.setVertexBuffer(0, lod.buffers[0]!);
                  pass.setIndexBuffer(lod.index, 'uint32');
                  bound = true;
                }
                pass.drawIndexed(lod.indexCount, j - i, 0, 0, g.first + i);
              }
              stats.shadowTriangles += (lod.indexCount / 3) * (j - i);
              i = j;
            }
          }
      };
      batches.add(batch);
      return batch;
    },
  };
  return system;
}
