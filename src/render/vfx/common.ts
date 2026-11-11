/**
 * What every vfx pipeline shares: bind group 1 (globals, light probes, noise, the scene copies and the
 * atmosphere inputs of the render core), the WGSL chunk "vfx_common" that declares it, and the light probe
 * pass that evaluates sun and sky light at a few points once per frame.
 *
 * Group 1 layout (all vfx render and compute pipelines except the canopy G-buffer / shadow ones):
 *   0 VfxGlobals (uniform)        1 light probes (read-only storage)   2 noise 3-D    3 curl noise 3-D
 *   4 'scene.depth'               5 'scene.depthHalf'                  6-8 transparency set
 *   9-10 shadow set               11-13 atmosphere LUTs                14 'env.sh9'
 */
import type { FrameContext, RenderContext } from '@/core/contracts/render';
import type { Vec3 } from '@/core/math';
import { coreOf, type CoreApi, type SceneBindings } from '@/render/core';
import { createNoiseTextures, NOISE_MIPS, NOISE_SIZE, type NoiseTextures } from './noise';

export const VFX_GLOBAL_FLOATS = 64;
export const VFX_PROBES = 8;
/** Probe slots with a fixed role. */
export const PROBE_FOCUS = 0;
export const PROBE_PAD = 1;

/** Float offsets into VfxGlobals. */
export const G = {
  time: 0,
  half: 4,
  domOrigin: 8,
  domX: 12,
  domY: 16,
  domZ: 20,
  domUp: 24,
  domPrevOrigin: 28,
  domPrevX: 32,
  domPrevY: 36,
  domPrevZ: 40,
  sunDom: 44,
  windDom: 48,
  misc: 52,
} as const;

const GLOBALS_WGSL = /* wgsl */ `
struct VfxGlobals {
  time: vec4f,          // x = effect time (s; simulation clock, frozen while not animating), y = simulated dt of this frame (s), z = noise time (s), w = quality scale
  half: vec4f,          // half-resolution target: width, height, 1 / width, 1 / height
  domOrigin: vec4f,     // xyz = particle domain origin relative to the camera (ROOT axes), w = air density at the origin (kg/m^3)
  domX: vec4f,          // xyz = domain +X in ROOT axes, w = gravity (m/s^2, along -up)
  domY: vec4f,          // xyz = domain +Y, w = density scale height (m)
  domZ: vec4f,          // xyz = domain +Z, w = 1 surface domain (body-fixed) / 0 free-fall domain
  domUp: vec4f,         // xyz = local vertical in DOMAIN axes, w = ground level as dot(up, p) (-1e30 = none)
  domPrevOrigin: vec4f, // xyz = domain origin relative to the PREVIOUS eye, w = water level as dot(up, p) (-1e30 = none)
  domPrevX: vec4f,      // previous-frame domain axes (ROOT)
  domPrevY: vec4f,
  domPrevZ: vec4f,
  sunDom: vec4f,        // xyz = unit direction to the sun in domain axes
  windDom: vec4f,       // xyz = velocity of the air in domain axes (m/s)
  misc: vec4f,          // x = count of frames in which simulated time advanced (staggered work), y = 1 when the scene depth copy holds a usable previous frame
  reserved0: vec4f,
  reserved1: vec4f,
}
struct VfxProbe {
  sun: vec4f,           // rgb = sun illuminance at the probe (lux; eclipses and atmosphere applied), w = visibility 0..1
  sky: vec4f,           // rgb = sky illuminance on a horizontal surface (lux), w = body index (-1 = none)
  env: vec4f,           // rgb = mean illuminance of the environment probe (lux)
  up: vec4f,            // xyz = local vertical (ROOT axes), w = altitude above the reference radius (m)
}
`;

const PROBE_WGSL = /* wgsl */ `
#include "frame"
#include "eclipse"
#include "atmosphere_common"
${GLOBALS_WGSL}
struct EnvSh9 { c: array<vec4f, 9> }
struct ProbeRequests { pos: array<vec4f, ${VFX_PROBES}> }   // xyz = position relative to the camera, w = 1 when in use
@group(1) @binding(0) var<uniform> requests: ProbeRequests;
@group(1) @binding(1) var<storage, read_write> probesOut: array<VfxProbe, ${VFX_PROBES}>;
@group(1) @binding(2) var transmittanceLut: texture_2d_array<f32>;
@group(1) @binding(3) var skyIrradianceLut: texture_2d_array<f32>;
@group(1) @binding(4) var<uniform> envSh9: EnvSh9;

@compute @workgroup_size(${VFX_PROBES}) fn main(@builtin(global_invocation_id) id: vec3u) {
  let req = requests.pos[id.x];
  var out: VfxProbe;
  out.sun = vec4f(0.0);
  out.sky = vec4f(0.0, 0.0, 0.0, -1.0);
  out.env = vec4f(envSh9.c[0].rgb * 0.282095, 0.0);
  out.up = vec4f(0.0, 0.0, 1.0, 0.0);
  if (req.w > 0.5) {
    let p = req.xyz;
    var sun = frame.sunIlluminance.rgb * sunVisibility(p, frame.sunDir.xyz);
    let bi = nearestBody(p);
    if (bi >= 0) {
      let b = frame.bodies[bi];
      let toP = p - b.center.xyz;
      let r = length(toP);
      let up = toP / max(r, 1.0);
      let muS = dot(up, b.sunDir.xyz);
      sun *= atmosphereSunTransmittance(transmittanceLut, u32(bi), r, muS);
      out.up = vec4f(up, r - b.center.w);
      out.sky.w = f32(bi);
      let layer = i32(b.fixedX.w);
      let rt = b.prevCenter.w;
      if (layer >= 0 && rt > 0.0) {
        let uv = skyIrradianceUvFromRMuS(clamp(r, b.center.w, rt), muS, b.center.w, rt);
        out.sky = vec4f(textureSampleLevel(skyIrradianceLut, linearClamp, uv, layer, 0.0).rgb, f32(bi));
      }
    }
    out.sun = vec4f(sun, luminance(sun) / max(frame.sunIlluminance.a, 1e-6));
  }
  probesOut[id.x] = out;
}
`;

export interface VfxCommonOptions {
  /** Compile every shader with applyAtmosphere replaced by the identity (A/B test of the neutral defaults). */
  skipAtmosphere: boolean;
}

export class VfxCommon {
  readonly ctx: RenderContext;
  readonly core: CoreApi;
  readonly device: GPUDevice;
  readonly layout: GPUBindGroupLayout;
  readonly noise: NoiseTextures;
  readonly globals = new Float32Array(VFX_GLOBAL_FLOATS);
  readonly globalsBuffer: GPUBuffer;
  readonly probeBuffer: GPUBuffer;
  private readonly scene: SceneBindings;
  private group: GPUBindGroup | null = null;
  private groupVersion = -1;
  private readonly probeRequests = new Float32Array(VFX_PROBES * 4);
  private readonly probeRequestBuffer: GPUBuffer;
  private readonly probeLayout: GPUBindGroupLayout;
  private readonly probePipeline: GPUComputePipeline;
  private probeGroup: GPUBindGroup | null = null;
  private probeVersion = -1;

  constructor(ctx: RenderContext, options: VfxCommonOptions) {
    this.ctx = ctx;
    this.core = coreOf(ctx);
    const device = (this.device = ctx.device);
    this.noise = createNoiseTextures(ctx);
    this.globalsBuffer = device.createBuffer({ label: 'vfx.globals', size: VFX_GLOBAL_FLOATS * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.probeBuffer = device.createBuffer({ label: 'vfx.probes', size: VFX_PROBES * 64, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    this.probeRequestBuffer = device.createBuffer({ label: 'vfx.probeRequests', size: VFX_PROBES * 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });

    this.scene = this.core.createSceneBindings(1, 4, ['sceneDepth', 'sceneDepthHalf', 'transparency', 'shadow', 'atmosphereLuts', 'env']);
    const all = GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT | GPUShaderStage.COMPUTE;
    this.layout = device.createBindGroupLayout({
      label: 'vfx.common',
      entries: [
        { binding: 0, visibility: all, buffer: { type: 'uniform' } },
        { binding: 1, visibility: all, buffer: { type: 'read-only-storage' } },
        { binding: 2, visibility: all, texture: { sampleType: 'float', viewDimension: '3d' } },
        { binding: 3, visibility: all, texture: { sampleType: 'float', viewDimension: '3d' } },
        ...this.scene.layoutEntries,
      ],
    });
    ctx.shaders.register(
      'vfx_common',
      /* wgsl */ `
#include "frame"
#include "atmosphere_common"
#include "shadows"
#include "transparency"
${GLOBALS_WGSL}
@group(1) @binding(0) var<uniform> vfx: VfxGlobals;
@group(1) @binding(1) var<storage, read> vfxProbes: array<VfxProbe, ${VFX_PROBES}>;
@group(1) @binding(2) var vfxNoiseTex: texture_3d<f32>;
@group(1) @binding(3) var vfxCurlTex: texture_3d<f32>;
${this.scene.wgsl}

/// applyAtmosphere of the render core (aerial perspective and cloud occlusion) for a premultiplied,
/// pre-exposed contribution at 'distance' metres from the eye.
fn vfxAtmosphere(uv: vec2f, distance: f32, colour: vec3f, alpha: f32) -> vec4f {
  ${options.skipAtmosphere ? 'return vec4f(colour, alpha);' : 'return applyAtmosphere(uv, distance, colour, alpha);'}
}
/// Tileable noise: r = Perlin fbm, g = Perlin-Worley, b = Worley detail, a = second Perlin fbm (all 0..1).
fn vfxNoise(p: vec3f) -> vec4f { return textureSampleLevel(vfxNoiseTex, linearRepeat, p, 0.0); }
/// The same, band-limited: 'footprint' is the sample spacing in texture coordinates (features finer than it are filtered out).
fn vfxNoiseLod(p: vec3f, footprint: f32) -> vec4f { return textureSampleLevel(vfxNoiseTex, linearRepeat, p, clamp(log2(max(footprint * ${NOISE_SIZE}.0, 1e-6)), 0.0, ${NOISE_MIPS - 1}.0)); }
/// Divergence-free vector noise with unit rms magnitude.
fn vfxCurl(p: vec3f) -> vec3f { return textureSampleLevel(vfxCurlTex, linearRepeat, p, 0.0).xyz; }
fn vfxDomainToRel(p: vec3f) -> vec3f { return vfx.domOrigin.xyz + vfx.domX.xyz * p.x + vfx.domY.xyz * p.y + vfx.domZ.xyz * p.z; }
fn vfxDomainToRelPrev(p: vec3f) -> vec3f { return vfx.domPrevOrigin.xyz + vfx.domPrevX.xyz * p.x + vfx.domPrevY.xyz * p.y + vfx.domPrevZ.xyz * p.z; }
fn vfxDomainDir(v: vec3f) -> vec3f { return vfx.domX.xyz * v.x + vfx.domY.xyz * v.y + vfx.domZ.xyz * v.z; }
fn vfxRelToDomain(p: vec3f) -> vec3f { let d = p - vfx.domOrigin.xyz; return vec3f(dot(d, vfx.domX.xyz), dot(d, vfx.domY.xyz), dot(d, vfx.domZ.xyz)); }
/// Luminance (cd/m^2) of a Lambert-like scatterer with the given albedo under the probe's sun and sky.
fn vfxProbeAmbient(i: u32) -> vec3f { return vfxProbes[i].sky.rgb * 0.5 + vfxProbes[i].env.rgb; }
/// Sum of the frame's local lights at a camera-relative point: illuminance (lux) on a surface facing each light.
fn vfxLocalLights(pos: vec3f) -> vec3f {
  var e = vec3f(0.0);
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
    if (d2 < range2) { e += L.intensity.rgb * (sq(saturate(1.0 - sq(d2 / range2))) / max(d2, 1.0)); }
  }
  return e;
}
`,
    );

    this.probeLayout = device.createBindGroupLayout({
      label: 'vfx.probe',
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'float', viewDimension: '2d-array' } },
        { binding: 3, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'float', viewDimension: '2d-array' } },
        { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
      ],
    });
    this.probePipeline = device.createComputePipeline({
      label: 'vfx.probe',
      layout: device.createPipelineLayout({ label: 'vfx.probe', bindGroupLayouts: [ctx.frameBindGroupLayout, this.probeLayout] }),
      compute: { module: ctx.shaders.createModule('vfx.probe', PROBE_WGSL), entryPoint: 'main' },
    });
  }

  /** Bind group 1 for this frame (rebuilt when a shared resource was re-published). */
  bindGroup(): GPUBindGroup {
    const v = this.scene.version();
    if (!this.group || v !== this.groupVersion) {
      this.groupVersion = v;
      this.group = this.device.createBindGroup({
        label: 'vfx.common',
        layout: this.layout,
        entries: [
          { binding: 0, resource: { buffer: this.globalsBuffer } },
          { binding: 1, resource: { buffer: this.probeBuffer } },
          { binding: 2, resource: this.noise.density },
          { binding: 3, resource: this.noise.curl },
          ...this.scene.entries(),
        ],
      });
    }
    return this.group;
  }

  /** Ask for sun / sky light at a camera-relative point this frame. */
  setProbe(index: number, posRelCam: Vec3 | null): void {
    const o = index * 4;
    if (posRelCam) this.probeRequests.set([posRelCam.x, posRelCam.y, posRelCam.z, 1], o);
    else this.probeRequests.fill(0, o, o + 4);
  }

  /** Upload the globals and the probe requests (end of prepare). */
  upload(): void {
    this.device.queue.writeBuffer(this.globalsBuffer, 0, this.globals);
    this.device.queue.writeBuffer(this.probeRequestBuffer, 0, this.probeRequests);
  }

  /** The light probe pass (first thing in the compute hook). */
  runProbes(frame: FrameContext, encoder: GPUCommandEncoder): void {
    const res = this.ctx.resources;
    const v = res.version('atmosphere.transmittanceLut') + res.version('atmosphere.skyIrradianceLut') + res.version('env.sh9');
    if (!this.probeGroup || v !== this.probeVersion) {
      this.probeVersion = v;
      this.probeGroup = this.device.createBindGroup({
        label: 'vfx.probe',
        layout: this.probeLayout,
        entries: [
          { binding: 0, resource: { buffer: this.probeRequestBuffer } },
          { binding: 1, resource: { buffer: this.probeBuffer } },
          { binding: 2, resource: res.get('atmosphere.transmittanceLut') },
          { binding: 3, resource: res.get('atmosphere.skyIrradianceLut') },
          { binding: 4, resource: { buffer: res.get('env.sh9') } },
        ],
      });
    }
    const pass = encoder.beginComputePass({ label: 'vfx.probe', timestampWrites: this.ctx.perf.gpuPass('vfx.probe') as GPUComputePassTimestampWrites | undefined });
    pass.setPipeline(this.probePipeline);
    pass.setBindGroup(0, frame.frameBindGroup);
    pass.setBindGroup(1, this.probeGroup);
    pass.dispatchWorkgroups(1);
    pass.end();
  }

  dispose(): void {
    this.noise.destroy();
    this.globalsBuffer.destroy();
    this.probeBuffer.destroy();
    this.probeRequestBuffer.destroy();
  }
}
