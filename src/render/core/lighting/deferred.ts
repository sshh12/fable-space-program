/**
 * Deferred lighting: sun x atmosphere transmittance x eclipse x cloud shadow x cascade + contact shadows,
 * sky irradiance, environment probe (SH9 diffuse + prefiltered cube specular), planetshine, local lights,
 * map fill light, and emissive. Material branches by MATERIAL_ID; terrain, regolith and water go through
 * the overridable chunks.
 */
import { RENDER_FORMATS, type RenderContext } from '@/core/contracts/render';
import type { DefLibrary } from '@/core/contracts/defs';
import { createSceneBindings, type SceneBindings } from '../sceneBindings';
import { MAX_BODIES } from '../shaders/chunksFrame';
import { SPOT_SHADOW_MAX, SPOT_SHADOW_SIZE } from '../shadows/spotShadows';
import type { CoreShaderLibrary, Tracked } from '../shaders/library';
import { f32ToF16 } from '../util/gpu';

export interface HapkeParams {
  b0: number;
  hS: number;
  bP: number;
  cP: number;
}
export const DEFAULT_HAPKE: HapkeParams = { b0: 1.8, hS: 0.065, bP: 0.25, cP: 0.3 };

/** Scalar Hapke BRDF x mu0 (rendering-design 8.2); mirrors the WGSL `hapke`. */
export function hapkeBrdfMu0(w: number, mu0: number, mu: number, g: number, p: HapkeParams): number {
  const B = p.b0 / (1 + Math.tan(g / 2) / p.hS);
  const cg = Math.cos(g);
  const P = 1 + p.bP * cg + p.cP * (1.5 * cg * cg - 0.5);
  const gam = Math.sqrt(1 - w);
  const H0 = (1 + 2 * mu0) / (1 + 2 * mu0 * gam);
  const H = (1 + 2 * mu) / (1 + 2 * mu * gam);
  return (w / (4 * Math.PI)) * (mu0 / (mu0 + mu)) * ((1 + B) * P + H0 * H - 1);
}

/** Normalisation geometry of the albedo maps: incidence 30 deg, emission 0, phase 30 deg. */
export const HAPKE_NORM = { mu0: Math.cos(Math.PI / 6), mu: 1, g: Math.PI / 6 };

/** Lambert-equivalent albedo of a Hapke surface with single-scattering albedo w at the normalisation geometry. */
export const hapkeAlbedoAtNorm = (w: number, p: HapkeParams): number => (Math.PI * hapkeBrdfMu0(w, HAPKE_NORM.mu0, HAPKE_NORM.mu, HAPKE_NORM.g, p)) / HAPKE_NORM.mu0;

/**
 * 256-entry inversion table: map albedo (0..1) -> single-scattering albedo w such that rendering at the
 * normalisation geometry reproduces the map value exactly. Albedos above what w -> 1 can reach saturate.
 */
export function buildHapkeLut(p: HapkeParams, n = 256): Float32Array {
  const out = new Float32Array(n);
  const wMax = 0.999999;
  const aMax = hapkeAlbedoAtNorm(wMax, p);
  for (let i = 0; i < n; i++) {
    const a = i / (n - 1);
    if (a >= aMax) {
      out[i] = wMax;
      continue;
    }
    let lo = 0;
    let hi = wMax;
    for (let k = 0; k < 40; k++) {
      const mid = 0.5 * (lo + hi);
      if (hapkeAlbedoAtNorm(mid, p) < a) lo = mid;
      else hi = mid;
    }
    out[i] = 0.5 * (lo + hi);
  }
  return out;
}

const LIGHTING_FS = (bindings: string): string => /* wgsl */ `
#include "frame"
#include "fullscreen"
#include "gbuffer"
#include "brdf"
#include "eclipse"
#include "local_lights"
#include "atmosphere_common"
#include "shadows"
${bindings}
@group(2) @binding(0) var gAlbedo: texture_2d<f32>;
@group(2) @binding(1) var gNormal: texture_2d<f32>;
@group(2) @binding(2) var gMaterial: texture_2d<f32>;
@group(2) @binding(3) var gExtra: texture_2d<f32>;
@group(2) @binding(4) var gEmissive: texture_2d<f32>;
@group(2) @binding(5) var aoTex: texture_2d<f32>;        // half resolution: r = ambient occlusion, g = contact shadow
@group(2) @binding(6) var aoDepthTex: texture_2d<f32>;   // half resolution: the reversed-Z depth the AO was computed at
@group(2) @binding(7) var hapkeLut: texture_2d<f32>;
// Shadow maps of spot lights (request vehicle-pad-2): a light whose endKind.w is 3 + k has map k.
struct SpotShadowU { viewProj: array<mat4x4f, ${SPOT_SHADOW_MAX}>, params: array<vec4f, ${SPOT_SHADOW_MAX}> }   // params: tan(half fov), near, far
@group(3) @binding(0) var spotShadowTex: texture_depth_2d_array;
@group(3) @binding(1) var<uniform> spotShadowU: SpotShadowU;
/// Visibility (0..1) of spot light map k at a camera-relative point with unit normal n, distance d from the light:
/// normal offset of 1.5 texels at that distance, 3 x 3 bilinear PCF. Outside the map: 1.
fn spotShadow(k: u32, pos: vec3f, n: vec3f, d: f32) -> f32 {
  let texel = 2.0 * d * spotShadowU.params[k].x / ${SPOT_SHADOW_SIZE}.0;
  let c = spotShadowU.viewProj[k] * vec4f(pos + n * (1.5 * texel), 1.0);
  if (c.w <= 0.0) { return 1.0; }
  let ndc = c.xyz / c.w;
  if (abs(ndc.x) >= 1.0 || abs(ndc.y) >= 1.0 || ndc.z >= 1.0) { return 1.0; }
  let uv = vec2f(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5);
  var s = 0.0;
  for (var y = -1; y <= 1; y++) {
    for (var x = -1; x <= 1; x++) {
      s += textureSampleCompareLevel(spotShadowTex, shadowCompare, uv + vec2f(f32(x), f32(y)) / ${SPOT_SHADOW_SIZE}.0, i32(k), ndc.z);
    }
  }
  return s / 9.0;
}
#include "brdf_terrain"
#include "brdf_regolith"
#include "brdf_water"

fn brdfDirect(s: Surface, l: vec3f) -> vec3f {
  switch (s.materialId) {
    case MATERIAL_TERRAIN: { return brdfTerrainDirect(s, l); }
    case MATERIAL_REGOLITH: { return brdfRegolithDirect(s, l); }
    case MATERIAL_WATER: { return brdfWaterDirect(s, l); }
    case MATERIAL_CLOTH: { return brdfClothDirect(s, l); }
    default: { return brdfStandardDirect(s, l); }
  }
}
fn brdfAmbient(s: Surface, a: AmbientInput) -> vec3f {
  switch (s.materialId) {
    case MATERIAL_TERRAIN: { return brdfTerrainAmbient(s, a); }
    case MATERIAL_REGOLITH: { return brdfRegolithAmbient(s, a); }
    case MATERIAL_WATER: { return brdfWaterAmbient(s, a); }
    case MATERIAL_CLOTH: { return brdfClothAmbient(s, a); }
    default: { return brdfStandardAmbient(s, a); }
  }
}

/// Depth-aware 4-tap upsample of the half-resolution AO / contact-shadow target.
fn sampleAo(uv: vec2f, depth: f32) -> vec2f {
  let size = vec2i(textureDimensions(aoTex));
  let st = uv * vec2f(size) - 0.5;
  let base = floor(st);
  let f = st - base;
  let zFull = viewZFromDepth(depth);
  var sum = vec2f(0.0);
  var wsum = 0.0;
  for (var k = 0; k < 4; k++) {
    let o = vec2i(k & 1, k >> 1);
    let ip = clamp(vec2i(base) + o, vec2i(0), size - 1);
    let z = viewZFromDepth(textureLoad(aoDepthTex, ip, 0).r);
    let diff = min(abs(z - zFull) / max(min(z, zFull), 1e-3), 1000.0);
    let w = (select(1.0 - f.x, f.x, o.x == 1) * select(1.0 - f.y, f.y, o.y == 1) + 0.02) / (1.0 + diff * 300.0);
    sum += textureLoad(aoTex, ip, 0).rg * w;
    wsum += w;
  }
  return sum / wsum;
}

#include "cloud_shadow"

fn envIrradiance(n: vec3f) -> vec3f {
  let c = envSh9.c;
  let e = c[0].rgb * 0.282095
    + c[1].rgb * (0.488603 * n.y) + c[2].rgb * (0.488603 * n.z) + c[3].rgb * (0.488603 * n.x)
    + c[4].rgb * (1.092548 * n.x * n.y) + c[5].rgb * (1.092548 * n.y * n.z)
    + c[6].rgb * (0.315392 * (3.0 * n.z * n.z - 1.0)) + c[7].rgb * (1.092548 * n.x * n.z)
    + c[8].rgb * (0.546274 * (n.x * n.x - n.y * n.y));
  return max(e, vec3f(0.0));
}

@fragment fn fs(in: FullscreenOut) -> @location(0) vec4f {
  let pix = vec2u(in.position.xy);
  let depth = textureLoad(sceneDepthOpaqueTex, pix, 0);
  let emissive = textureLoad(gEmissive, pix, 0).rgb;
  let g = gbufferUnpack(textureLoad(gAlbedo, pix, 0), textureLoad(gNormal, pix, 0), textureLoad(gMaterial, pix, 0), textureLoad(gExtra, pix, 0));
  let pos = positionFromDepth(in.uv, depth);
  let dist = length(pos);
  let aoc = sampleAo(in.uv, depth);

  var s: Surface;
  s.pos = pos;
  s.viewDist = dist;
  s.n = g.normal;
  s.ao = g.ao * aoc.x;
  s.v = -pos / max(dist, 1e-6);
  s.roughness = g.roughness;
  s.albedo = g.albedo;
  s.metallic = g.metallic;
  s.t = g.tangent;
  s.anisotropy = g.anisotropy;
  s.clearcoat = g.clearcoat;
  s.clearcoatRoughness = g.clearcoatRoughness;
  s.param = g.param;
  s.materialId = g.materialId;
  s.lightAlpha = 0.0;
  let bi = nearestBody(pos);
  s.bodyIndex = bi;
  s.up = s.n;
  s.altitude = 0.0;
  var sunDir = frame.sunDir.xyz;
  var r = 0.0;
  var bodyRadius = 0.0;
  if (bi >= 0) {
    let b = frame.bodies[bi];
    let rel = pos - b.center.xyz;
    r = length(rel);
    s.up = rel / max(r, 1.0);
    bodyRadius = b.center.w;
    s.altitude = r - bodyRadius;
    sunDir = b.sunDir.xyz;
  }
  var emissiveScale = 1.0;
  if (s.materialId == MATERIAL_DISPLAY) {
    // A display is an emitter behind a glass front: a dielectric (F0 0.04) at the G-buffer roughness, never
    // metallic, never wet, RT4 unused. RT5 holds its image at full brightness; RT2.a (brightness 0..1)
    // scales it here, together with the transmission of the glass towards the eye relative to normal
    // incidence, (1 - F(NoV)) / (1 - F0): a display states its luminance as seen head-on and fades into
    // the reflection at grazing angles.
    emissiveScale = s.param * (1.0 - pow5(1.0 - saturate(dot(s.n, s.v))));
    s.metallic = 0.0;
    s.anisotropy = 0.0;
    s.clearcoat = 0.0;
    s.param = 0.0;
    s.materialId = MATERIAL_STANDARD;
  } else if (s.materialId == MATERIAL_STANDARD) {
    // Wetness darkens dielectrics and smooths the surface.
    s.albedo *= mix(1.0, 0.6, s.param * (1.0 - s.metallic));
    s.roughness = mix(s.roughness, min(s.roughness, 0.2), s.param);
  }

  // ---- sun
  var lit = vec3f(0.0);
  let muS = dot(s.up, sunDir);
  var vis = sunVisibility(pos, sunDir);
  // Clouds (request atmosphere-clouds-6): x = share of the sun's illuminance in the direct beam, y = share
  // that arrives at all. The beam is the sun term; y - x comes from the cloud base and is ambient light.
  // (Looked up at night as well: the share of the sky that is seen under cloud must not jump at sunset.)
  var cl = vec2f(1.0);
  if (bi >= 0) { cl = cloudLight(pos, bi, s.up, r, sunDir); }
  var cloudBase = vec3f(0.0);
  if (vis > 0.0) {
    var sunE = frame.sunIlluminance.rgb * vis;
    if (bi >= 0) {
      sunE *= atmosphereSunTransmittance(transmittanceLut, u32(bi), r, muS);
      // Illuminance of a horizontal surface by the cloud base: what the cloud passes on diffusely.
      cloudBase = sunE * (max(muS, 0.0) * (cl.y - cl.x));
      sunE *= cl.x;
    }
    // Cloth is lit on both sides (wrapped diffuse, light shining through), so its cascade lookup uses the
    // normal turned towards the sun: whatever stands between the fabric and the sun shadows it whichever way
    // it faces. Every other material is dark through its BRDF on faces turned away (the lookup returns 1).
    var nShadow = s.n;
    if (s.materialId == MATERIAL_CLOTH && dot(s.n, sunDir) < 0.0) { nShadow = -s.n; }
    // Terrain and regolith may ask for a wider filter in RT4.a (request terrain-render-4): the shadow of a
    // coarse terrain mesh on itself is softened to the size of its caster quads.
    var soft = 0.0;
    if (s.materialId == MATERIAL_TERRAIN || s.materialId == MATERIAL_REGOLITH) { soft = decodeShadowSoftness(g.clearcoatRoughness); }
    let shadow = sampleSunShadowSoft(pos, nShadow, pix, soft) * aoc.y;
    if (shadow > 0.0) {
      s.lightAlpha = 0.6 * frame.sunDir.w;
      lit += brdfDirect(s, sunDir) * sunE * shadow;
    }
  }
  s.lightAlpha = 0.0;

  // ---- ambient
  // The sky table and the probe are alternatives, never summed (the probe already contains the sky):
  // terrain and water take the table, standard and cloth the probe, regolith the table on a body that
  // has one and the probe on an airless body.
  var amb: AmbientInput;
  let skyShare = mix(0.35, 1.0, cl.x);
  amb.skyIrradiance = vec3f(0.0);
  var skyHorizontal = vec3f(0.0);
  var hasSkyTable = false;
  if (bi >= 0) {
    let b = frame.bodies[bi];
    let layer = i32(b.fixedX.w);
    hasSkyTable = layer >= 0;
    if (layer >= 0 && r < b.prevCenter.w) {
      let uv = skyIrradianceUvFromRMuS(max(r, bodyRadius), muS, bodyRadius, b.prevCenter.w);
      skyHorizontal = textureSampleLevel(skyIrradianceLut, linearClamp, uv, layer, 0.0).rgb;
    }
    // Under cloud about a third of the blue sky is still seen (between and beside the clouds), and the
    // cloud base adds its white light. Both are diffuse: no cast shadows, ambient occlusion applies.
    skyHorizontal = skyHorizontal * skyShare + cloudBase;
    amb.skyIrradiance = skyHorizontal * (0.5 + 0.5 * dot(s.n, s.up));
  }
  let refl = reflect(-s.v, s.n);
  let NoV = max(dot(s.n, s.v), 1e-4);
  amb.specularOcclusion = saturate(pow(NoV + s.ao, exp2(-16.0 * s.roughness - 1.0)) - 1.0 + s.ao);
  amb.envIrradiance = vec3f(0.0);
  amb.envSpecular = vec3f(0.0);
  amb.envSpecularCoat = vec3f(0.0);
  amb.skyReflection = vec3f(0.0);
  if (s.materialId == MATERIAL_STANDARD || s.materialId == MATERIAL_CLOTH || (s.materialId == MATERIAL_REGOLITH && !hasSkyTable)) {
    // The probe is captured at the vessel: it does not hold the cloud base over THIS surface. Under cloud
    // the surface sees a third of what the probe shows, and the cloud base as a uniform white sky over it
    // (irradiance cloudBase on a horizontal face, luminance cloudBase / pi in a mirror that looks up).
    // On the ground of an airless body the probe (captured at the active vessel, and held while the camera
    // is far from it) stands for the light of the lit ground around a surface, and that ground is lit only
    // where the sun is over the LOCAL horizon. Without this the whole night side of the Moon took the fill
    // of the ground under a vessel over the day side (from 20,000 km at a fixed exposure the night side
    // stood at display level 37 beside the day side's 144: tests/browser/integration/shadows.spec.ts).
    var envShare = skyShare;
    if (s.materialId == MATERIAL_REGOLITH) { envShare *= smoothstep(-0.02, 0.08, muS); }
    amb.envIrradiance = envIrradiance(s.n) * envShare + cloudBase * (0.5 + 0.5 * dot(s.n, s.up));
    if (s.materialId == MATERIAL_STANDARD) {
      let mips = f32(textureNumLevels(envProbeCube)) - 1.0;
      let base = cloudBase * ((0.5 + 0.5 * dot(refl, s.up)) / PI);
      amb.envSpecular = textureSampleLevel(envProbeCube, linearClamp, refl, s.roughness * mips).rgb * skyShare + base;
      if (s.clearcoat > 0.0) { amb.envSpecularCoat = textureSampleLevel(envProbeCube, linearClamp, refl, s.clearcoatRoughness * mips).rgb * skyShare + base; }
    }
  } else if (bi >= 0) {
    // Water and terrain reflect the sky: the camera's sky-view table nearby, the local sky irradiance far away.
    let near = saturate(1.0 - dist / 50000.0);
    let camUp = frame.bodies[bi].cameraUp.xyz;
    let sv = textureSampleLevel(skyViewLut, linearClamp, skyViewUv(refl, camUp, sunDir), 0.0).rgb;
    amb.skyReflection = mix(skyHorizontal / PI, sv, near);
  }
  lit += brdfAmbient(s, amb);

  // ---- planetshine (directional fills computed on the CPU from the snapshot)
  var receiver = MAX_BODIES;
  if (bi >= 0 && s.altitude < 0.5 * bodyRadius) { receiver = u32(bi); }
  for (var k = 0u; k < 2u; k++) {
    let sh = frame.shine[receiver * 2u + k];
    if (sh.illuminance.r + sh.illuminance.g + sh.illuminance.b > 0.0) {
      // The other bodies hide the shining one by the overlap of their discs (request sky-lighting-8: the Moon
      // under a low orbit's horizon lights nothing). A planet's disc is an extended source without a shadow
      // map: the baked occlusion (RT0.a) stands in for the vessel's own parts, as it does for the probe. A
      // closed cabin writes 0 and receives none of it.
      let shVis = shineVisibility(pos, sh);
      if (shVis > 0.0) { lit += brdfDirect(s, sh.dir.xyz) * sh.illuminance.rgb * (g.ao * shVis); }
    }
  }

  // ---- local lights (point, capsule and spot; source radius; chunk local_lights)
  for (var i = 0u; i < min(frame.counts.y, MAX_LIGHTS); i++) {
    let ll = localLightSample(i, pos, s.n);
    if (ll.w > 0.0) {
      var vis = 1.0;
      let kind = frame.lights[i].endKind.w;
      if (kind > 2.5) { vis = spotShadow(u32(round(kind - 3.0)), pos, s.n, distance(frame.lights[i].posRange.xyz, pos)); }
      lit += brdfDirect(s, ll.xyz) * frame.lights[i].intensity.rgb * (ll.w * vis);
    }
  }

  // ---- map-view fill light (declared ambient, unshadowed)
  lit += s.albedo * frame.sunIlluminance.rgb * (frame.misc.x / PI);

  return vec4f(writeHdr(lit * frame.exposure.x + emissive * emissiveScale), 1.0);
}
`;

export interface LightingInputs {
  albedo: GPUTextureView;
  normal: GPUTextureView;
  material: GPUTextureView;
  extra: GPUTextureView;
  emissive: GPUTextureView;
  ao: GPUTextureView;
  aoDepth: GPUTextureView;
}

export class DeferredLighting {
  private readonly bindings: SceneBindings;
  private readonly sceneLayout: GPUBindGroupLayout;
  private readonly gbufferLayout: GPUBindGroupLayout;
  private readonly pipeline: Tracked<GPURenderPipeline>;
  private readonly hapkeLut: GPUTexture;
  private readonly hapkeView: GPUTextureView;
  private readonly spotLayout: GPUBindGroupLayout;
  private spotGroup: GPUBindGroup | null = null;
  private sceneGroup: GPUBindGroup | null = null;
  private sceneVersion = -1;
  private gbufferGroup: GPUBindGroup | null = null;
  private inputs: LightingInputs | null = null;

  constructor(
    private readonly ctx: RenderContext,
    shaders: CoreShaderLibrary,
  ) {
    const device = ctx.device;
    this.bindings = createSceneBindings(ctx, 1, 0, ['shadow', 'atmosphereLuts', 'env', 'cloudShadow', 'sceneDepthOpaque']);
    this.sceneLayout = device.createBindGroupLayout({ label: 'lighting.scene', entries: this.bindings.layoutEntries });
    this.gbufferLayout = device.createBindGroupLayout({
      label: 'lighting.gbuffer',
      entries: [0, 1, 2, 3, 4, 5, 6, 7].map((binding) => ({
        binding,
        visibility: GPUShaderStage.FRAGMENT,
        texture: { sampleType: binding === 6 ? ('unfilterable-float' as const) : ('float' as const) },
      })),
    });

    // Albedo -> single-scattering albedo, one row per frame body: written by setBodies, when the first
    // snapshot says which bodies the session has. (The stage itself exists from the renderer's creation,
    // so that its pipeline can be created ahead: CoreRenderer.warm.)
    this.hapkeLut = device.createTexture({ label: 'lighting.hapkeLut', format: 'r16float', size: [256, MAX_BODIES], usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
    this.hapkeView = this.hapkeLut.createView();

    this.spotLayout = device.createBindGroupLayout({
      label: 'lighting.spotShadows',
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'depth', viewDimension: '2d-array' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
      ],
    });
    this.pipeline = shaders.tracked(() => {
      const module = shaders.createModule('core.lighting', LIGHTING_FS(this.bindings.wgsl));
      return device.createRenderPipeline({
        label: 'core.lighting',
        layout: device.createPipelineLayout({ label: 'core.lighting', bindGroupLayouts: [ctx.frameBindGroupLayout, this.sceneLayout, this.gbufferLayout, this.spotLayout] }),
        vertex: { module, entryPoint: 'fullscreenVs' },
        fragment: { module, entryPoint: 'fs', targets: [{ format: RENDER_FORMATS.hdr }] },
        primitive: { topology: 'triangle-list' },
        // Fullscreen triangle at clip z = 0: with reversed-Z 'less' passes only where geometry was drawn.
        depthStencil: { format: RENDER_FORMATS.depth, depthWriteEnabled: false, depthCompare: 'less' },
      });
    });
  }

  /** The spot-light shadow maps and their uniform (src/render/core/shadows/spotShadows.ts). */
  setSpotShadows(view: GPUTextureView, uniform: GPUBuffer): void {
    this.spotGroup = this.ctx.device.createBindGroup({ label: 'lighting.spotShadows', layout: this.spotLayout, entries: [{ binding: 0, resource: view }, { binding: 1, resource: { buffer: uniform } }] });
  }

  setInputs(inputs: LightingInputs): void {
    this.inputs = inputs;
    this.gbufferGroup = null;
  }

  /** The bodies of the session in frame order: their rows of the Hapke table (rows of non-Hapke bodies use the default parameters). */
  setBodies(defs: DefLibrary, bodyIds: readonly string[]): void {
    const lut = new Uint16Array(256 * MAX_BODIES);
    for (let b = 0; b < MAX_BODIES; b++) {
      const params = defs.bodies[bodyIds[b] ?? '']?.render.surface?.hapke ?? DEFAULT_HAPKE;
      const row = buildHapkeLut(params);
      for (let i = 0; i < 256; i++) lut[b * 256 + i] = f32ToF16(row[i]!);
    }
    this.ctx.device.queue.writeTexture({ texture: this.hapkeLut }, lut, { bytesPerRow: 512 }, [256, MAX_BODIES]);
  }

  /**
   * The stage's tracked pipeline, for `shaders.warm`. It includes chunks that features replace in their
   * `init` (the water, terrain and regolith BRDFs), so it is final only when the last feature was added.
   */
  pipelines(): Tracked<unknown>[] {
    return [this.pipeline];
  }

  draw(pass: GPURenderPassEncoder): void {
    if (!this.inputs || !this.spotGroup) return;
    const device = this.ctx.device;
    const v = this.bindings.version();
    if (!this.sceneGroup || v !== this.sceneVersion) {
      this.sceneVersion = v;
      this.sceneGroup = device.createBindGroup({ label: 'lighting.scene', layout: this.sceneLayout, entries: this.bindings.entries() });
    }
    if (!this.gbufferGroup) {
      const i = this.inputs;
      this.gbufferGroup = device.createBindGroup({
        label: 'lighting.gbuffer',
        layout: this.gbufferLayout,
        entries: [i.albedo, i.normal, i.material, i.extra, i.emissive, i.ao, i.aoDepth, this.hapkeView].map((resource, binding) => ({ binding, resource })),
      });
    }
    pass.setPipeline(this.pipeline.get());
    pass.setBindGroup(1, this.sceneGroup);
    pass.setBindGroup(2, this.gbufferGroup);
    pass.setBindGroup(3, this.spotGroup);
    pass.draw(3);
  }
}
