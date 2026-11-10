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

/// Cloud transmittance towards the sun: near-field optical-depth map around the camera, coverage map beyond.
fn cloudShadow(pos: vec3f, bodyIndex: i32, up: vec3f, r: f32, sunDir: vec3f) -> f32 {
  let muS = max(dot(up, sunDir), 0.05);
  var far = 1.0;
  if (i32(frame.cloudFar.x) == bodyIndex && r < frame.cloudFar.y) {
    // Point where the sun ray crosses the layer mid-height.
    let b = frame.bodies[bodyIndex];
    let rel = pos - b.center.xyz;
    let bq = dot(rel, sunDir);
    let t = -bq + sqrt(max(bq * bq - (r * r - frame.cloudFar.y * frame.cloudFar.y), 0.0));
    let d = normalize(rootToFixed(u32(bodyIndex), rel + sunDir * t));
    let lon = atan2(d.y, d.x) + frame.cloudFar.w;
    let uv = vec2f(fract(lon / TWO_PI + 0.5), acos(clamp(d.z, -1.0, 1.0)) / PI);
    far = exp(-textureSampleLevel(cloudCoverageMapTex, linearClamp, uv, 0.0).r * frame.cloudFar.z / muS);
  }
  let he = frame.cloudNear0.w;
  if (he > 0.0 && i32(frame.cloudNear1.w) == bodyIndex) {
    let rel = pos - frame.cloudNear0.xyz;
    let q = vec2f(dot(rel, frame.cloudNear1.xyz), dot(rel, frame.cloudNear2.xyz)) / he;
    let edge = 1.0 - max(abs(q.x), abs(q.y));
    if (edge > 0.0) {
      let tau = textureSampleLevel(cloudShadowMapTex, linearClamp, q * 0.5 + 0.5, 0.0).r * frame.cloudNear2.w;
      return mix(far, exp(-tau / muS), saturate(edge * 8.0));
    }
  }
  return far;
}

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
  if (vis > 0.0) {
    var sunE = frame.sunIlluminance.rgb * vis;
    if (bi >= 0) {
      sunE *= atmosphereSunTransmittance(transmittanceLut, u32(bi), r, muS);
      sunE *= cloudShadow(pos, bi, s.up, r, sunDir);
    }
    let shadow = sampleSunShadow(pos, s.n, pix) * aoc.y;
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
      amb.skyIrradiance = skyHorizontal * (0.5 + 0.5 * dot(s.n, s.up));
    }
  }
  let refl = reflect(-s.v, s.n);
  let NoV = max(dot(s.n, s.v), 1e-4);
  amb.specularOcclusion = saturate(pow(NoV + s.ao, exp2(-16.0 * s.roughness - 1.0)) - 1.0 + s.ao);
  amb.envIrradiance = vec3f(0.0);
  amb.envSpecular = vec3f(0.0);
  amb.envSpecularCoat = vec3f(0.0);
  amb.skyReflection = vec3f(0.0);
  if (s.materialId == MATERIAL_STANDARD || s.materialId == MATERIAL_CLOTH || (s.materialId == MATERIAL_REGOLITH && !hasSkyTable)) {
    amb.envIrradiance = envIrradiance(s.n);
    if (s.materialId == MATERIAL_STANDARD) {
      let mips = f32(textureNumLevels(envProbeCube)) - 1.0;
      amb.envSpecular = textureSampleLevel(envProbeCube, linearClamp, refl, s.roughness * mips).rgb;
      if (s.clearcoat > 0.0) { amb.envSpecularCoat = textureSampleLevel(envProbeCube, linearClamp, refl, s.clearcoatRoughness * mips).rgb; }
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
      lit += brdfDirect(s, sh.dir.xyz) * sh.illuminance.rgb;
    }
  }

  // ---- local lights (point and capsule, inverse square, smooth window at the influence radius)
  for (var i = 0u; i < min(frame.counts.y, MAX_LIGHTS); i++) {
    let L = frame.lights[i];
    var toL = L.posRange.xyz - pos;
    if (L.endKind.w > 0.5) {
      let ab = L.endKind.xyz - L.posRange.xyz;
      let t = saturate(dot(pos - L.posRange.xyz, ab) / max(dot(ab, ab), 1e-6));
      toL = L.posRange.xyz + ab * t - pos;
    }
    let d2 = dot(toL, toL);
    let range2 = L.posRange.w * L.posRange.w;
    if (d2 < range2) {
      let window = sq(saturate(1.0 - sq(d2 / range2)));
      lit += brdfDirect(s, toL * inverseSqrt(max(d2, 1e-8))) * L.intensity.rgb * (window / max(d2, 1e-4));
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
  private readonly hapkeView: GPUTextureView;
  private sceneGroup: GPUBindGroup | null = null;
  private sceneVersion = -1;
  private gbufferGroup: GPUBindGroup | null = null;
  private inputs: LightingInputs | null = null;

  constructor(
    private readonly ctx: RenderContext,
    shaders: CoreShaderLibrary,
    defs: DefLibrary,
    bodyIds: string[],
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

    // Albedo -> single-scattering albedo, one row per frame body (rows of non-Hapke bodies use the default parameters).
    const lut = new Uint16Array(256 * MAX_BODIES);
    for (let b = 0; b < MAX_BODIES; b++) {
      const params = defs.bodies[bodyIds[b] ?? '']?.render.surface?.hapke ?? DEFAULT_HAPKE;
      const row = buildHapkeLut(params);
      for (let i = 0; i < 256; i++) lut[b * 256 + i] = f32ToF16(row[i]!);
    }
    const tex = device.createTexture({ label: 'lighting.hapkeLut', format: 'r16float', size: [256, MAX_BODIES], usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
    device.queue.writeTexture({ texture: tex }, lut, { bytesPerRow: 512 }, [256, MAX_BODIES]);
    this.hapkeView = tex.createView();

    this.pipeline = shaders.tracked(() => {
      const module = shaders.createModule('core.lighting', LIGHTING_FS(this.bindings.wgsl));
      return device.createRenderPipeline({
        label: 'core.lighting',
        layout: device.createPipelineLayout({ label: 'core.lighting', bindGroupLayouts: [ctx.frameBindGroupLayout, this.sceneLayout, this.gbufferLayout] }),
        vertex: { module, entryPoint: 'fullscreenVs' },
        fragment: { module, entryPoint: 'fs', targets: [{ format: RENDER_FORMATS.hdr }] },
        primitive: { topology: 'triangle-list' },
        // Fullscreen triangle at clip z = 0: with reversed-Z 'less' passes only where geometry was drawn.
        depthStencil: { format: RENDER_FORMATS.depth, depthWriteEnabled: false, depthCompare: 'less' },
      });
    });
  }

  setInputs(inputs: LightingInputs): void {
    this.inputs = inputs;
    this.gbufferGroup = null;
  }

  /** Force the pipeline to exist (and report compile errors) before the first frame. */
  warm(): void {
    this.pipeline.get();
  }

  draw(pass: GPURenderPassEncoder): void {
    if (!this.inputs) return;
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
    pass.draw(3);
  }
}
