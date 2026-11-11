/**
 * Lab sky for the ocean lab: a compact single-scattering atmosphere (Rayleigh + Mie + ozone from
 * BodyDef.render.atmosphere through the frame uniforms, plus an isotropic multiple-scattering estimate) that
 * publishes what the water reads - 'atmosphere.transmittanceLut', 'atmosphere.skyIrradianceLut',
 * 'atmosphere.skyViewLut', 'env.probeCube', 'env.sh9' - and draws the sky background with the sun disc and
 * the aerial perspective over the scene. It stands in for the atmosphere-clouds and sky-lighting features,
 * which are built at the same time; lab code, never used by the app.
 *
 * `overcast`: a CIE overcast sky everywhere, the sun hidden by a uniform deck through the core's far
 * cloud-shadow term (coverage map 1 x 1 = 1, optical depth 9).
 */
import { RENDER_FORMATS, type FrameContext, type RenderContext, type RenderFeature } from '@/core/contracts/render';
import { coreOf, createSolidTexture, type ManagedTarget, type Tracked } from '@/render/core';

const COMMON = /* wgsl */ `
#include "frame"
#include "atmosphere_common"
struct LabSkyParams { info: vec4f }   // x = frame body index of the atmosphere, y = overcast 0/1, z = probe face size, w = multiple-scattering factor
@group(1) @binding(0) var<uniform> lsp: LabSkyParams;
@group(1) @binding(1) var transmittanceLut: texture_2d_array<f32>;
fn skyBody() -> BodyUniform { return frame.bodies[u32(lsp.info.x)]; }
fn densities(h: f32) -> vec3f {
  let b = skyBody();
  let hh = max(h, 0.0);
  return vec3f(exp(-hh / b.rayleigh.a), exp(-hh / b.mie.z), max(0.0, 1.0 - abs(h - b.ozone.a) / max(b.misc.x, 1.0)));
}
fn extinctionAt(h: f32) -> vec3f {
  let b = skyBody();
  let d = densities(h);
  return b.rayleigh.rgb * d.x + vec3f(b.mie.x + b.mie.y) * d.y + b.ozone.rgb * d.z;
}
fn rayleighPhase(c: f32) -> f32 { return 3.0 / (16.0 * PI) * (1.0 + c * c); }
fn miePhase(c: f32, g: f32) -> f32 {
  let k = 3.0 / (8.0 * PI) * (1.0 - g * g) / (2.0 + g * g);
  return k * (1.0 + c * c) / pow(max(1.0 + g * g - 2.0 * g * c, 1e-4), 1.5);
}
fn rayToTop(r: f32, mu: f32, rt: f32) -> f32 { return max(-r * mu + sqrt(max(r * r * (mu * mu - 1.0) + rt * rt, 0.0)), 0.0); }
fn rayHitsGround(r: f32, mu: f32, rb: f32) -> bool { return mu < 0.0 && r * r * (mu * mu - 1.0) + rb * rb >= 0.0; }
fn sunTransmittance(r: f32, muS: f32) -> vec3f {
  if (rayHitsGround(r, muS, skyBody().center.w)) { return vec3f(0.0); }
  return atmosphereSunTransmittance(transmittanceLut, u32(lsp.info.x), r, muS);
}
fn overcastZenith() -> f32 {
  let b = skyBody();
  return 0.07 * frame.sunIlluminance.a / PI * saturate(dot(b.cameraUp.xyz, b.sunDir.xyz) + 0.1);
}
struct Scatter { inscatter: vec3f, transmittance: vec3f }
/// Single + isotropic multiple scattering along a ray of length tMax from radius r0 / altitude h0 (not pre-exposed).
fn integrateRay(r0: f32, h0: f32, up0: vec3f, dir: vec3f, sunDir: vec3f, tMax: f32, steps: u32) -> Scatter {
  let b = skyBody();
  let mu = dot(dir, up0);
  let c = dot(dir, sunDir);
  let pr = rayleighPhase(c);
  let pm = miePhase(c, b.mie.w);
  var T = vec3f(1.0);
  var L = vec3f(0.0);
  let E = frame.sunIlluminance.rgb;
  for (var i = 0u; i < steps; i++) {
    let tP = tMax * sq(f32(i) / f32(steps));
    let tN = tMax * sq((f32(i) + 1.0) / f32(steps));
    let t = 0.5 * (tP + tN);
    let ds = tN - tP;
    let h = altitudeAt(t, r0, h0, mu);
    let r = b.center.w + h;
    let up = normalize(up0 * r0 + dir * t);
    let muS = dot(up, sunDir);
    let d = densities(h);
    let sigR = b.rayleigh.rgb * d.x;
    let sigM = vec3f(b.mie.x * d.y);
    let ext = extinctionAt(h);
    let single = (sigR * pr + sigM * pm) * sunTransmittance(r, muS);
    let multi = (sigR + sigM) * lsp.info.w * saturate(muS + 0.2) * atmosphereSunTransmittance(transmittanceLut, u32(lsp.info.x), r, max(muS, 0.0)) / (4.0 * PI);
    let stepT = exp(-ext * ds);
    L += T * (single + multi) * E * (1.0 - stepT) / max(ext, vec3f(1e-12));
    T *= stepT;
  }
  return Scatter(L, T);
}
`;

const TRANSMITTANCE_WGSL = /* wgsl */ `
${COMMON}
@group(1) @binding(2) var outTex: texture_storage_2d_array<rgba16float, write>;
@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= 256u || id.y >= 64u) { return; }
  let b = skyBody();
  let rm = rMuFromTransmittanceUv((vec2f(id.xy) + 0.5) / vec2f(256.0, 64.0), b.center.w, b.prevCenter.w);
  let tMax = rayToTop(rm.x, rm.y, b.prevCenter.w);
  var od = vec3f(0.0);
  for (var i = 0u; i < 80u; i++) {
    let t = tMax * (f32(i) + 0.5) / 80.0;
    od += extinctionAt(altitudeAt(t, rm.x, rm.x - b.center.w, rm.y)) * (tMax / 80.0);
  }
  textureStore(outTex, vec2i(id.xy), 0, vec4f(exp(-od), 1.0));
}
`;

const IRRADIANCE_WGSL = /* wgsl */ `
${COMMON}
@group(1) @binding(2) var outTex: texture_storage_2d_array<rgba16float, write>;
@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= 64u || id.y >= 16u) { return; }
  let b = skyBody();
  let rm = rMuSFromSkyIrradianceUv((vec2f(id.xy) + 0.5) / vec2f(64.0, 16.0), b.center.w, b.prevCenter.w);
  let r = rm.x;
  let muS = rm.y;
  let up = vec3f(0.0, 0.0, 1.0);
  let sunDir = vec3f(sqrt(max(1.0 - muS * muS, 0.0)), 0.0, muS);
  var E = vec3f(0.0);
  for (var i = 0u; i < 8u; i++) {
    let ct = (f32(i) + 0.5) / 8.0;
    let st = sqrt(1.0 - ct * ct);
    for (var j = 0u; j < 16u; j++) {
      let ph = (f32(j) + 0.5) / 16.0 * TWO_PI;
      let dir = vec3f(st * cos(ph), st * sin(ph), ct);
      var L = integrateRay(r, r - b.center.w, up, dir, sunDir, rayToTop(r, ct, b.prevCenter.w), 16u).inscatter;
      if (lsp.info.y > 0.5) { L = vec3f(0.94, 0.97, 1.0) * 0.07 * frame.sunIlluminance.a / PI * saturate(muS + 0.1) * (1.0 + 2.0 * ct) / 3.0; }
      E += L * ct * (1.0 / 8.0) * (TWO_PI / 16.0);
    }
  }
  textureStore(outTex, vec2i(id.xy), 0, vec4f(E, 1.0));
}
`;

const SKYVIEW_WGSL = /* wgsl */ `
${COMMON}
@group(1) @binding(2) var outTex: texture_storage_2d<rgba16float, write>;
@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= 192u || id.y >= 108u) { return; }
  let b = skyBody();
  let up = b.cameraUp.xyz;
  let sunDir = b.sunDir.xyz;
  let uv = (vec2f(id.xy) + 0.5) / vec2f(192.0, 108.0);
  var e = sunDir - up * dot(sunDir, up);
  if (dot(e, e) < 1e-8) { e = cross(up, vec3f(0.0, 0.0, 1.0)) + cross(up, vec3f(1.0, 0.0, 0.0)) * 1e-3; }
  e = normalize(e);
  let nrm = cross(up, e);
  let s = (0.5 - uv.y) * 2.0;
  let l = sign(s) * s * s * PI * 0.5;
  let az = (uv.x - 0.5) * TWO_PI;
  let dir = normalize((e * cos(az) + nrm * sin(az)) * cos(l) + up * sin(l));
  let r0 = b.cameraUp.w;
  let h0 = b.sunDir.w;
  let mu = dot(dir, up);
  var tMax = rayToTop(r0, mu, b.prevCenter.w);
  if (rayHitsGround(r0, mu, b.center.w)) { tMax = h0 * (2.0 * b.center.w + h0) / (r0 * -mu + sqrt(max(b.center.w * b.center.w - r0 * r0 * (1.0 - mu * mu), 0.0))); }
  var L = integrateRay(r0, h0, up, dir, sunDir, tMax, 40u).inscatter;
  if (lsp.info.y > 0.5) { L = vec3f(0.94, 0.97, 1.0) * overcastZenith() * (1.0 + 2.0 * max(mu, 0.0)) / 3.0; }
  textureStore(outTex, vec2i(id.xy), vec4f(L, 1.0));
}
`;

const PROBE_WGSL = /* wgsl */ `
${COMMON}
@group(1) @binding(2) var skyView: texture_2d<f32>;
@group(1) @binding(3) var outTex: texture_storage_2d_array<rgba16float, write>;
@group(1) @binding(4) var<storage, read_write> shOut: array<vec4f, 9>;
fn cubeDir(face: u32, uv: vec2f) -> vec3f {
  let a = uv * 2.0 - 1.0;
  switch (face) {
    case 0u: { return normalize(vec3f(1.0, -a.y, -a.x)); }
    case 1u: { return normalize(vec3f(-1.0, -a.y, a.x)); }
    case 2u: { return normalize(vec3f(a.x, 1.0, a.y)); }
    case 3u: { return normalize(vec3f(a.x, -1.0, -a.y)); }
    case 4u: { return normalize(vec3f(a.x, -a.y, 1.0)); }
    default: { return normalize(vec3f(-a.x, -a.y, -1.0)); }
  }
}
fn probeRadiance(d: vec3f) -> vec3f {
  let b = skyBody();
  let up = b.cameraUp.xyz;
  let mu = dot(d, up);
  let sky = textureSampleLevel(skyView, linearClamp, skyViewUv(d, up, b.sunDir.xyz), 0.0).rgb;
  // Below the horizon: the sea, which at grazing angles mirrors the horizon sky and is dark towards the nadir.
  let hz = textureSampleLevel(skyView, linearClamp, skyViewUv(normalize(d - up * mu + up * 0.01), up, b.sunDir.xyz), 0.0).rgb;
  return select(sky, hz * mix(0.05, 0.6, pow(1.0 + mu, 10.0)), mu < 0.0);
}
@compute @workgroup_size(8, 8, 1)
fn faces(@builtin(global_invocation_id) id: vec3u) {
  let size = u32(lsp.info.z);
  if (id.x >= size || id.y >= size) { return; }
  textureStore(outTex, vec2i(id.xy), i32(id.z), vec4f(probeRadiance(cubeDir(id.z, (vec2f(id.xy) + 0.5) / f32(size))), 1.0));
}
@compute @workgroup_size(1, 1, 1)
fn sh() {
  var c: array<vec3f, 9>;
  for (var k = 0u; k < 9u; k++) { c[k] = vec3f(0.0); }
  let n = 24u;
  for (var i = 0u; i < n; i++) {
    let z = 1.0 - 2.0 * (f32(i) + 0.5) / f32(n);
    let rr = sqrt(1.0 - z * z);
    for (var j = 0u; j < 2u * n; j++) {
      let ph = (f32(j) + 0.5) / f32(2u * n) * TWO_PI;
      let d = vec3f(rr * cos(ph), rr * sin(ph), z);
      let L = probeRadiance(d) * (4.0 * PI / f32(2u * n * n));
      c[0] += L * 0.282095;
      c[1] += L * 0.488603 * d.y;
      c[2] += L * 0.488603 * d.z;
      c[3] += L * 0.488603 * d.x;
      c[4] += L * 1.092548 * d.x * d.y;
      c[5] += L * 1.092548 * d.y * d.z;
      c[6] += L * 0.315392 * (3.0 * d.z * d.z - 1.0);
      c[7] += L * 1.092548 * d.x * d.z;
      c[8] += L * 0.546274 * (d.x * d.x - d.y * d.y);
    }
  }
  // Radiance SH -> irradiance SH (cosine-lobe convolution: pi, 2 pi / 3, pi / 4 per band).
  shOut[0] = vec4f(c[0] * PI, 0.0);
  for (var k = 1u; k < 4u; k++) { shOut[k] = vec4f(c[k] * 2.0943951, 0.0); }
  for (var k = 4u; k < 9u; k++) { shOut[k] = vec4f(c[k] * 0.785398, 0.0); }
}
`;

const MIP_WGSL = /* wgsl */ `
@group(0) @binding(0) var src: texture_2d_array<f32>;
@group(0) @binding(1) var dst: texture_storage_2d_array<rgba16float, write>;
@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let size = textureDimensions(dst);
  if (id.x >= size.x || id.y >= size.y) { return; }
  let p = vec2i(id.xy) * 2;
  let l = i32(id.z);
  let s = textureLoad(src, p, l, 0) + textureLoad(src, p + vec2i(1, 0), l, 0) + textureLoad(src, p + vec2i(0, 1), l, 0) + textureLoad(src, p + vec2i(1, 1), l, 0);
  textureStore(dst, vec2i(id.xy), l, s * 0.25);
}
`;

const BACKGROUND_WGSL = /* wgsl */ `
#include "atmosphere_common"
struct BgParams { info: vec4f }
@group(1) @binding(0) var skyView: texture_2d<f32>;
@group(1) @binding(1) var<uniform> bg: BgParams;
@group(1) @binding(2) var transmittanceLut: texture_2d_array<f32>;
@fragment fn fs(in: FullscreenOut) -> @location(0) vec4f {
  let b = frame.bodies[u32(bg.info.x)];
  let d = normalize(viewRay(in.uv));
  let up = b.cameraUp.xyz;
  var L = textureSampleLevel(skyView, linearClamp, skyViewUv(d, up, b.sunDir.xyz), 0.0).rgb;
  let ang = acos(clamp(dot(d, frame.sunDir.xyz), -1.0, 1.0));
  let rs = frame.sunDir.w;
  if (ang < rs && bg.info.y < 0.5) {
    let mu = sqrt(max(1.0 - sq(ang / rs), 0.0));
    let u = vec3f(0.397, 0.503, 0.652);
    let limb = (vec3f(1.0) - u * (1.0 - mu)) / (vec3f(1.0) - u / 3.0);
    let Ts = atmosphereSunTransmittance(transmittanceLut, u32(bg.info.x), b.cameraUp.w, dot(up, frame.sunDir.xyz));
    L += frame.sunIlluminance.rgb / (PI * rs * rs) * limb * Ts * frame.misc.y;
  }
  return vec4f(writeHdr(L * frame.exposure.x), 1.0);
}
`;

/** Aerial perspective over geometry, pass 1: multiply the scene by the transmittance, store the in-scatter. */
const AERIAL_WGSL = /* wgsl */ `
${COMMON.replace('#include "frame"\n', '')}
@group(1) @binding(2) var sceneDepthTex: texture_depth_2d;
struct AOut { @location(0) trans: vec4f, @location(1) inscatter: vec4f }
@fragment fn fs(in: FullscreenOut) -> AOut {
  let d = textureLoad(sceneDepthTex, vec2u(in.position.xy), 0);
  var o: AOut;
  o.trans = vec4f(1.0);
  o.inscatter = vec4f(0.0);
  if (d <= 0.0) { return o; }
  let b = skyBody();
  let p = positionFromDepth(in.uv, d);
  let t = length(p);
  let up = b.cameraUp.xyz;
  let s = integrateRay(b.cameraUp.w, b.sunDir.w, up, p / max(t, 1e-6), b.sunDir.xyz, t, 20u);
  var ins = s.inscatter;
  var tr = s.transmittance;
  if (lsp.info.y > 0.5) {
    let fog = 1.0 - exp(-t / 45000.0);
    ins = vec3f(0.94, 0.97, 1.0) * overcastZenith() * 0.55 * fog;
    tr = vec3f(1.0 - fog);
  }
  o.trans = vec4f(tr, 1.0);
  o.inscatter = vec4f(ins * frame.exposure.x, 1.0);
  return o;
}
`;

const ADD_WGSL = /* wgsl */ `
@group(1) @binding(0) var inscatterTex: texture_2d<f32>;
@fragment fn fs(in: FullscreenOut) -> @location(0) vec4f {
  return vec4f(writeHdr(textureLoad(inscatterTex, vec2u(in.position.xy), 0).rgb), 0.0);
}
`;

export interface LabSky extends RenderFeature {
  overcast: boolean;
}

export function createLabSkyFeature(opts: { overcast?: boolean } = {}): LabSky {
  const PROBE = 64;
  const PROBE_MIPS = 7;
  let ctx: RenderContext;
  let device: GPUDevice;
  let params: GPUBuffer;
  const paramData = new Float32Array(4);
  let probeTex: GPUTexture;
  let shStorage: GPUBuffer;
  let shUniform: GPUBuffer;
  const groups: Record<'trans' | 'irr' | 'view' | 'probe', GPUBindGroup> = {} as never;
  const pipes: Record<'trans' | 'irr' | 'view' | 'faces' | 'sh' | 'mip', GPUComputePipeline> = {} as never;
  const mipGroups: GPUBindGroup[] = [];
  let bgPipe: Tracked<GPURenderPipeline>;
  let bgGroup: GPUBindGroup;
  let aerialPipe: Tracked<GPURenderPipeline>;
  let addPipe: Tracked<GPURenderPipeline>;
  let aerialLayout: GPUBindGroupLayout;
  let addLayout: GPUBindGroupLayout;
  let aerialGroup: GPUBindGroup | null = null;
  let addGroup: GPUBindGroup | null = null;
  let aerialKey = '';
  let inscatter: ManagedTarget;
  let transView: GPUTextureView;
  let staticKey = '';
  let bodyIndex = -1;
  let coverage: GPUTextureView | null = null;
  let coverageDefault: GPUTextureView | null = null;

  const sky: LabSky = {
    id: 'lab-sky',
    order: -50,
    overcast: opts.overcast ?? false,
    init(c) {
      ctx = c;
      device = c.device;
      const core = coreOf(c);
      params = device.createBuffer({ label: 'labSky.params', size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      const st = GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING;
      const transTex = device.createTexture({ label: 'labSky.transmittance', format: 'rgba16float', size: [256, 64, 1], usage: st });
      const irrTex = device.createTexture({ label: 'labSky.irradiance', format: 'rgba16float', size: [64, 16, 1], usage: st });
      const viewTex = device.createTexture({ label: 'labSky.skyView', format: 'rgba16float', size: [192, 108], usage: st });
      probeTex = device.createTexture({ label: 'labSky.probe', format: 'rgba16float', size: [PROBE, PROBE, 6], mipLevelCount: PROBE_MIPS, usage: st });
      shStorage = device.createBuffer({ label: 'labSky.sh', size: 144, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
      shUniform = device.createBuffer({ label: 'labSky.shUniform', size: 144, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      transView = transTex.createView({ dimension: '2d-array' });
      const C = GPUShaderStage.COMPUTE;
      const F = GPUShaderStage.FRAGMENT;
      const lut = (out: GPUBindGroupLayoutEntry, extra: GPUBindGroupLayoutEntry[] = []): GPUBindGroupLayout =>
        device.createBindGroupLayout({ entries: [{ binding: 0, visibility: C | F, buffer: { type: 'uniform' } }, { binding: 1, visibility: C | F, texture: { sampleType: 'float', viewDimension: '2d-array' } }, out, ...extra] });
      const arrOut = lut({ binding: 2, visibility: C, storageTexture: { access: 'write-only', format: 'rgba16float', viewDimension: '2d-array' } });
      const texOut = lut({ binding: 2, visibility: C, storageTexture: { access: 'write-only', format: 'rgba16float' } });
      const probeLayout = lut({ binding: 2, visibility: C, texture: { sampleType: 'float' } }, [
        { binding: 3, visibility: C, storageTexture: { access: 'write-only', format: 'rgba16float', viewDimension: '2d-array' } },
        { binding: 4, visibility: C, buffer: { type: 'storage' } },
      ]);
      const mipLayout = device.createBindGroupLayout({
        entries: [
          { binding: 0, visibility: C, texture: { sampleType: 'unfilterable-float', viewDimension: '2d-array' } },
          { binding: 1, visibility: C, storageTexture: { access: 'write-only', format: 'rgba16float', viewDimension: '2d-array' } },
        ],
      });
      const comp = (label: string, code: string, entry: string, layout: GPUBindGroupLayout, frameGroup = true): GPUComputePipeline =>
        device.createComputePipeline({
          label,
          layout: device.createPipelineLayout({ bindGroupLayouts: frameGroup ? [c.frameBindGroupLayout, layout] : [layout] }),
          compute: { module: c.shaders.createModule(label, code), entryPoint: entry },
        });
      pipes.trans = comp('labSky.transmittance', TRANSMITTANCE_WGSL, 'main', arrOut);
      pipes.irr = comp('labSky.irradiance', IRRADIANCE_WGSL, 'main', arrOut);
      pipes.view = comp('labSky.skyView', SKYVIEW_WGSL, 'main', texOut);
      pipes.faces = comp('labSky.probeFaces', PROBE_WGSL, 'faces', probeLayout);
      pipes.sh = comp('labSky.probeSh', PROBE_WGSL, 'sh', probeLayout);
      pipes.mip = comp('labSky.probeMip', MIP_WGSL, 'main', mipLayout, false);
      // The transmittance pass reads the core's white default (the LUT itself cannot be read while written).
      const white = c.resources.get('atmosphere.transmittanceLut');
      const g = (layout: GPUBindGroupLayout, read: GPUTextureView, rest: GPUBindGroupEntry[]): GPUBindGroup =>
        device.createBindGroup({ layout, entries: [{ binding: 0, resource: { buffer: params } }, { binding: 1, resource: read }, ...rest] });
      groups.trans = g(arrOut, white, [{ binding: 2, resource: transView }]);
      groups.irr = g(arrOut, transView, [{ binding: 2, resource: irrTex.createView({ dimension: '2d-array' }) }]);
      groups.view = g(texOut, transView, [{ binding: 2, resource: viewTex.createView() }]);
      groups.probe = g(probeLayout, transView, [
        { binding: 2, resource: viewTex.createView() },
        { binding: 3, resource: probeTex.createView({ dimension: '2d-array', baseMipLevel: 0, mipLevelCount: 1 }) },
        { binding: 4, resource: { buffer: shStorage } },
      ]);
      for (let m = 1; m < PROBE_MIPS; m++) {
        mipGroups.push(
          device.createBindGroup({
            layout: mipLayout,
            entries: [
              { binding: 0, resource: probeTex.createView({ dimension: '2d-array', baseMipLevel: m - 1, mipLevelCount: 1 }) },
              { binding: 1, resource: probeTex.createView({ dimension: '2d-array', baseMipLevel: m, mipLevelCount: 1 }) },
            ],
          }),
        );
      }
      c.resources.publish('atmosphere.transmittanceLut', transView);
      c.resources.publish('atmosphere.skyIrradianceLut', irrTex.createView({ dimension: '2d-array' }));
      c.resources.publish('atmosphere.skyViewLut', viewTex.createView());
      c.resources.publish('env.probeCube', probeTex.createView({ dimension: 'cube' }));
      c.resources.publish('env.sh9', shUniform);
      coverageDefault = c.resources.get('clouds.coverageMap');

      const bgLayout = device.createBindGroupLayout({
        entries: [
          { binding: 0, visibility: F, texture: { sampleType: 'float' } },
          { binding: 1, visibility: F, buffer: { type: 'uniform' } },
          { binding: 2, visibility: F, texture: { sampleType: 'float', viewDimension: '2d-array' } },
        ],
      });
      bgPipe = core.fullscreenPipeline({ label: 'labSky.background', fragment: BACKGROUND_WGSL, targets: [{ format: RENDER_FORMATS.hdr }], layouts: [bgLayout], depthStencil: { format: RENDER_FORMATS.depth, depthWriteEnabled: false, depthCompare: 'equal' } });
      bgGroup = device.createBindGroup({ layout: bgLayout, entries: [{ binding: 0, resource: viewTex.createView() }, { binding: 1, resource: { buffer: params } }, { binding: 2, resource: transView }] });
      aerialLayout = device.createBindGroupLayout({
        entries: [
          { binding: 0, visibility: F, buffer: { type: 'uniform' } },
          { binding: 1, visibility: F, texture: { sampleType: 'float', viewDimension: '2d-array' } },
          { binding: 2, visibility: F, texture: { sampleType: 'depth' } },
        ],
      });
      inscatter = core.createTarget('labSky.inscatter', 'rgba16float', 1);
      aerialPipe = core.fullscreenPipeline({
        label: 'labSky.aerial',
        fragment: AERIAL_WGSL,
        targets: [{ format: RENDER_FORMATS.hdr, blend: { color: { srcFactor: 'zero', dstFactor: 'src' }, alpha: { srcFactor: 'zero', dstFactor: 'one' } } }, { format: 'rgba16float' }],
        layouts: [aerialLayout],
      });
      addLayout = device.createBindGroupLayout({ entries: [{ binding: 0, visibility: F, texture: { sampleType: 'float' } }] });
      addPipe = core.fullscreenPipeline({ label: 'labSky.add', fragment: ADD_WGSL, targets: [{ format: RENDER_FORMATS.hdr, blend: { color: { srcFactor: 'one', dstFactor: 'one' }, alpha: { srcFactor: 'zero', dstFactor: 'one' } } }], layouts: [addLayout] });
      bgPipe.get();
      aerialPipe.get();
      addPipe.get();
    },

    prepare(frame: FrameContext) {
      bodyIndex = frame.bodies.findIndex((b, i) => i < 4 && ctx.defs.bodies[b.id]?.render.atmosphere != null);
      paramData.set([Math.max(bodyIndex, 0), sky.overcast ? 1 : 0, PROBE, 0.45]);
      device.queue.writeBuffer(params, 0, paramData);
      const core = coreOf(ctx);
      if (sky.overcast && bodyIndex >= 0) {
        coverage ??= createSolidTexture(device, 'labSky.overcast', 'r8unorm', [1]).createView();
        ctx.resources.publish('clouds.coverageMap', coverage);
        const def = ctx.defs.bodies[frame.bodies[bodyIndex]!.id]!;
        core.setCloudShadowParams({ far: { bodyIndex, layerRadius: def.radius + 2500, opticalDepth: 9, longitudeOffset: 0 } });
      } else {
        if (coverageDefault) ctx.resources.publish('clouds.coverageMap', coverageDefault);
        core.setCloudShadowParams({ far: null });
      }
    },

    compute(frame, encoder) {
      if (bodyIndex < 0) return;
      const id = frame.bodies[bodyIndex]!.id;
      const pass = encoder.beginComputePass({ label: 'lab-sky.luts', timestampWrites: ctx.perf.gpuPass('lab-sky.luts') as GPUComputePassTimestampWrites | undefined });
      pass.setBindGroup(0, frame.frameBindGroup);
      if (!staticKey.startsWith(`${id}:`)) {
        pass.setPipeline(pipes.trans);
        pass.setBindGroup(1, groups.trans);
        pass.dispatchWorkgroups(32, 8);
      }
      const key = `${id}:${sky.overcast}`;
      if (staticKey !== key) {
        pass.setPipeline(pipes.irr);
        pass.setBindGroup(1, groups.irr);
        pass.dispatchWorkgroups(8, 2);
        staticKey = key;
      }
      pass.setPipeline(pipes.view);
      pass.setBindGroup(1, groups.view);
      pass.dispatchWorkgroups(24, 14);
      pass.setPipeline(pipes.faces);
      pass.setBindGroup(1, groups.probe);
      pass.dispatchWorkgroups(PROBE / 8, PROBE / 8, 6);
      pass.setPipeline(pipes.sh);
      pass.dispatchWorkgroups(1);
      pass.setPipeline(pipes.mip);
      for (let m = 1; m < PROBE_MIPS; m++) {
        pass.setBindGroup(0, mipGroups[m - 1]!);
        const s = PROBE >> m;
        pass.dispatchWorkgroups(Math.ceil(s / 8), Math.ceil(s / 8), 6);
      }
      pass.end();
      encoder.copyBufferToBuffer(shStorage, 0, shUniform, 0, 144);
    },

    drawBackground(_frame, pass) {
      if (bodyIndex < 0) return;
      pass.setPipeline(bgPipe.get());
      pass.setBindGroup(1, bgGroup);
      pass.draw(3);
    },

    compositeAtmosphere(frame, encoder, hdr) {
      if (bodyIndex < 0) return;
      const key = `${ctx.resources.version('scene.depth')}:${inscatter.version}`;
      if (!aerialGroup || key !== aerialKey) {
        aerialKey = key;
        aerialGroup = device.createBindGroup({ layout: aerialLayout, entries: [{ binding: 0, resource: { buffer: params } }, { binding: 1, resource: transView }, { binding: 2, resource: ctx.resources.get('scene.depth') }] });
        addGroup = device.createBindGroup({ layout: addLayout, entries: [{ binding: 0, resource: inscatter.view }] });
      }
      const p1 = encoder.beginRenderPass({
        label: 'lab-sky.aerial',
        colorAttachments: [
          { view: hdr, loadOp: 'load', storeOp: 'store' },
          { view: inscatter.view, loadOp: 'clear', clearValue: { r: 0, g: 0, b: 0, a: 0 }, storeOp: 'store' },
        ],
        timestampWrites: ctx.perf.gpuPass('lab-sky.aerial') as GPURenderPassTimestampWrites | undefined,
      });
      p1.setBindGroup(0, frame.frameBindGroup);
      p1.setPipeline(aerialPipe.get());
      p1.setBindGroup(1, aerialGroup);
      p1.draw(3);
      p1.end();
      const p2 = encoder.beginRenderPass({ label: 'lab-sky.add', colorAttachments: [{ view: hdr, loadOp: 'load', storeOp: 'store' }], timestampWrites: ctx.perf.gpuPass('lab-sky.add') as GPURenderPassTimestampWrites | undefined });
      p2.setBindGroup(0, frame.frameBindGroup);
      p2.setPipeline(addPipe.get());
      p2.setBindGroup(1, addGroup!);
      p2.draw(3);
      p2.end();
    },
  };
  return sky;
}
