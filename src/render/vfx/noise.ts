/**
 * Tileable 3-D noise for every vfx shader, generated once on the GPU at start-up (no asset files):
 *
 *  - `density` 64^3 rgba8unorm: r = Perlin fbm (large billows), g = Perlin-Worley (cauliflower), b = Worley
 *    fbm at three times the frequency (edge erosion), a = a second, decorrelated Perlin fbm.
 *  - `curl` 32^3 rgba16float: xyz = a divergence-free vector field (curl of a Perlin potential) with unit
 *    rms magnitude, for turbulence that does not compress what it carries.
 *
 * Both tile with period 1 in texture coordinates; sample with the frame group's `linearRepeat`.
 */
import type { RenderContext } from '@/core/contracts/render';
import { coreOf } from '@/render/core';

export const NOISE_SIZE = 64;
export const CURL_SIZE = 32;

const WGSL = /* wgsl */ `
#include "hash"
@group(0) @binding(0) var densityOut: texture_storage_3d<rgba8unorm, write>;
@group(0) @binding(1) var curlOut: texture_storage_3d<rgba16float, write>;

fn wrapi(p: vec3i, per: i32) -> vec3i { return ((p % vec3i(per)) + vec3i(per)) % vec3i(per); }
fn h1(p: vec3i, per: i32, seed: i32) -> f32 { let q = wrapi(p, per); return hash_to_unit(hash4(q.x, q.y, q.z, seed)); }
fn gradAt(p: vec3i, per: i32, seed: i32) -> vec3f {
  let q = wrapi(p, per);
  let h = hash4(q.x, q.y, q.z, seed);
  let z = hash_to_unit(h) * 2.0 - 1.0;
  let a = hash_to_unit(hash_u32(h)) * 6.2831853;
  let r = sqrt(max(1.0 - z * z, 0.0));
  return vec3f(r * cos(a), r * sin(a), z);
}
/// Perlin gradient noise in about [-1, 1]; 'p' in lattice units, tiles with integer period 'per'.
fn perlin(p: vec3f, per: i32, seed: i32) -> f32 {
  let i = vec3i(floor(p));
  let f = fract(p);
  let u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  var n: array<f32, 8>;
  for (var k = 0; k < 8; k++) {
    let o = vec3i(k & 1, (k >> 1) & 1, (k >> 2) & 1);
    n[k] = dot(gradAt(i + o, per, seed), f - vec3f(o));
  }
  return mix(mix(mix(n[0], n[1], u.x), mix(n[2], n[3], u.x), u.y), mix(mix(n[4], n[5], u.x), mix(n[6], n[7], u.x), u.y), u.z) * 1.6;
}
fn perlinFbm(uvw: vec3f, freq: i32, octaves: i32, seed: i32) -> f32 {
  var s = 0.0;
  var a = 0.5;
  var f = freq;
  for (var o = 0; o < octaves; o++) {
    s += a * perlin(uvw * f32(f), f, seed + o * 17);
    f *= 2;
    a *= 0.5;
  }
  return s;
}
/// Inverted Worley noise in [0, 1] (1 at a feature point); tiles with integer period 'per'.
fn worley(p: vec3f, per: i32, seed: i32) -> f32 {
  let i = vec3i(floor(p));
  let f = fract(p);
  var best = 9.0;
  for (var z = -1; z <= 1; z++) { for (var y = -1; y <= 1; y++) { for (var x = -1; x <= 1; x++) {
    let o = vec3i(x, y, z);
    let c = i + o;
    let jit = vec3f(h1(c, per, seed), h1(c, per, seed + 101), h1(c, per, seed + 211));
    let d = vec3f(o) + jit - f;
    best = min(best, dot(d, d));
  } } }
  return 1.0 - saturate(sqrt(best));
}
fn worleyFbm(uvw: vec3f, freq: i32, seed: i32) -> f32 {
  return worley(uvw * f32(freq), freq, seed) * 0.625 + worley(uvw * f32(freq * 2), freq * 2, seed + 7) * 0.25 + worley(uvw * f32(freq * 4), freq * 4, seed + 13) * 0.125;
}
fn remap(x: f32, a: f32, b: f32, c: f32, d: f32) -> f32 { return c + (x - a) / (b - a) * (d - c); }

fn potential(uvw: vec3f) -> vec3f {
  return vec3f(perlinFbm(uvw, 3, 2, 301), perlinFbm(uvw, 3, 2, 433), perlinFbm(uvw, 3, 2, 577));
}

@compute @workgroup_size(4, 4, 4) fn densityMain(@builtin(global_invocation_id) id: vec3u) {
  let uvw = (vec3f(id) + 0.5) / ${NOISE_SIZE}.0;
  let pf = perlinFbm(uvw, 4, 4, 11) * 0.5 + 0.5;
  let wf = worleyFbm(uvw, 4, 23);
  let pw = saturate(remap(pf, 1.0 - wf, 1.0, 0.0, 1.0) * 1.35 + 0.08);
  let detail = worleyFbm(uvw, 12, 47);
  let pf2 = perlinFbm(uvw, 4, 4, 91) * 0.5 + 0.5;
  textureStore(densityOut, id, vec4f(saturate(pf), pw, detail, saturate(pf2)));
}

@compute @workgroup_size(4, 4, 4) fn curlMain(@builtin(global_invocation_id) id: vec3u) {
  let uvw = (vec3f(id) + 0.5) / ${CURL_SIZE}.0;
  let e = 0.5 / ${CURL_SIZE}.0;
  let dx = (potential(uvw + vec3f(e, 0.0, 0.0)) - potential(uvw - vec3f(e, 0.0, 0.0))) / (2.0 * e);
  let dy = (potential(uvw + vec3f(0.0, e, 0.0)) - potential(uvw - vec3f(0.0, e, 0.0))) / (2.0 * e);
  let dz = (potential(uvw + vec3f(0.0, 0.0, e)) - potential(uvw - vec3f(0.0, 0.0, e))) / (2.0 * e);
  // curl = (dPz/dy - dPy/dz, dPx/dz - dPz/dx, dPy/dx - dPx/dy); 0.16 brings the rms magnitude to about 1.
  let c = vec3f(dy.z - dz.y, dz.x - dx.z, dx.y - dy.x) * 0.16;
  textureStore(curlOut, id, vec4f(c, 1.0));
}
`;

const MIP_WGSL = /* wgsl */ `
@group(0) @binding(0) var src: texture_3d<f32>;
@group(0) @binding(1) var dst: texture_storage_3d<rgba8unorm, write>;
@compute @workgroup_size(4, 4, 4) fn main(@builtin(global_invocation_id) id: vec3u) {
  let size = textureDimensions(dst);
  if (any(id >= size)) { return; }
  var sum = vec4f(0.0);
  for (var k = 0u; k < 8u; k++) {
    sum += textureLoad(src, vec3i(id * 2u + vec3u(k & 1u, (k >> 1u) & 1u, (k >> 2u) & 1u)), 0);
  }
  textureStore(dst, id, sum * 0.125);
}
`;

export const NOISE_MIPS = 5;

export interface NoiseTextures {
  density: GPUTextureView;
  curl: GPUTextureView;
  destroy(): void;
}

export function createNoiseTextures(ctx: RenderContext): NoiseTextures {
  const device = ctx.device;
  const core = coreOf(ctx);
  const density = core.createTextureChecked({
    label: 'vfx.noise',
    format: 'rgba8unorm',
    dimension: '3d',
    size: [NOISE_SIZE, NOISE_SIZE, NOISE_SIZE],
    mipLevelCount: NOISE_MIPS,
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING,
  });
  const curl = core.createTextureChecked({
    label: 'vfx.curl',
    format: 'rgba16float',
    dimension: '3d',
    size: [CURL_SIZE, CURL_SIZE, CURL_SIZE],
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING,
  });
  const module = ctx.shaders.createModule('vfx.noise', WGSL);
  const layout = device.createBindGroupLayout({
    label: 'vfx.noise',
    entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: 'write-only', format: 'rgba8unorm', viewDimension: '3d' } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: 'write-only', format: 'rgba16float', viewDimension: '3d' } },
    ],
  });
  const pipelineLayout = device.createPipelineLayout({ label: 'vfx.noise', bindGroupLayouts: [layout] });
  const densityView = density.createView();
  const curlView = curl.createView();
  const group = device.createBindGroup({ label: 'vfx.noise', layout, entries: [{ binding: 0, resource: density.createView({ baseMipLevel: 0, mipLevelCount: 1 }) }, { binding: 1, resource: curlView }] });
  const encoder = device.createCommandEncoder({ label: 'vfx.noise' });
  for (const [entryPoint, size] of [
    ['densityMain', NOISE_SIZE],
    ['curlMain', CURL_SIZE],
  ] as const) {
    const pipeline = device.createComputePipeline({ label: `vfx.noise.${entryPoint}`, layout: pipelineLayout, compute: { module, entryPoint } });
    const pass = encoder.beginComputePass({ label: `vfx.noise.${entryPoint}` });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, group);
    pass.dispatchWorkgroups(size / 4, size / 4, size / 4);
    pass.end();
  }
  // Mip chain of the density noise (box filter), so that a march can band-limit the noise to its step size.
  const mipLayout = device.createBindGroupLayout({
    label: 'vfx.noise.mip',
    entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'float', viewDimension: '3d' } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: 'write-only', format: 'rgba8unorm', viewDimension: '3d' } },
    ],
  });
  const mipPipeline = device.createComputePipeline({
    label: 'vfx.noise.mip',
    layout: device.createPipelineLayout({ label: 'vfx.noise.mip', bindGroupLayouts: [mipLayout] }),
    compute: { module: ctx.shaders.createModule('vfx.noise.mip', MIP_WGSL), entryPoint: 'main' },
  });
  for (let level = 1; level < NOISE_MIPS; level++) {
    const pass = encoder.beginComputePass({ label: `vfx.noise.mip${level}` });
    pass.setPipeline(mipPipeline);
    pass.setBindGroup(
      0,
      device.createBindGroup({
        label: 'vfx.noise.mip',
        layout: mipLayout,
        entries: [
          { binding: 0, resource: density.createView({ baseMipLevel: level - 1, mipLevelCount: 1 }) },
          { binding: 1, resource: density.createView({ baseMipLevel: level, mipLevelCount: 1 }) },
        ],
      }),
    );
    const n = Math.max(1, Math.ceil((NOISE_SIZE >> level) / 4));
    pass.dispatchWorkgroups(n, n, n);
    pass.end();
  }
  device.queue.submit([encoder.finish()]);
  return {
    density: densityView,
    curl: curlView,
    destroy() {
      density.destroy();
      curl.destroy();
    },
  };
}
