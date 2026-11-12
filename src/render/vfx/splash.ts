/**
 * What a splashdown does to the water.
 *
 *  - The crown: a sheet of white water thrown up around the body, leaning outwards, that rises on the
 *    speed of the impact, thins, tears from its rim downwards into ligaments and falls back. A volume in
 *    the half-resolution pass (a thin shell marched around the entry point), lit white by sun and sky. The
 *    droplets that leave its rim and the mist are particles (director.ts).
 *  - The foam: a patch of white water at the entry point that spreads as a ring and breaks up over half a
 *    minute. A decal on the water surface in the transparent pass: on whatever water the scene holds there
 *    (the far sheet of the G-buffer or the forward-drawn sea in front of the opaque scene), so it rides the
 *    swell and never paints a hull.
 */
import { RENDER_FORMATS, type FrameContext, type RenderContext } from '@/core/contracts/render';
import { quat, v3, type Vec3 } from '@/core/math';
import type { SceneBindings, Tracked } from '@/render/core';
import type { VfxCommon } from './common';
import type { VfxData } from './data';
import type { SplashSpawn } from './director';
import { applyRebase, type DomainFrame, type DomainRebase } from './domain';
import { createVolumePipeline, type VolumeItem } from './volumes';

export const MAX_FOAM = 8;
const INST_FLOATS = 8;
const CROWN_FLOATS = 20;
/** The mist of a crown hangs in the air for this many flight times of its rim. */
const MIST_LIFE = 1.1;
const GRAVITY_FALLBACK = 9.81;

/** Rim height of a crown (m) `age` seconds after an impact that throws the sheet up at `speed` m/s. */
export function crownHeight(speed: number, gravity: number, age: number): number {
  return Math.max(0, speed * age - 0.5 * gravity * age * age);
}

const FOAM_WGSL = (scene: string): string => /* wgsl */ `
#include "vfx_common"
#include "gbuffer"
${scene}
struct Foam {
  centre: vec4f,   // xyz = entry point in domain coordinates, w = radius now (m)
  state: vec4f,    // x = age / lifetime, y = strength 0..1, z = seed, w = radius of the body that fell in (m)
}
struct FoamU { albedo: vec4f, count: vec4f }   // albedo.w = half height of the band of water levels the decal follows (m)
@group(2) @binding(0) var<uniform> foamU: FoamU;
@group(2) @binding(1) var<storage, read> foams: array<Foam, ${MAX_FOAM}>;

const CUBE = array<u32, 36>(0u, 2u, 3u, 0u, 3u, 1u, 4u, 5u, 7u, 4u, 7u, 6u, 0u, 1u, 5u, 0u, 5u, 4u, 2u, 6u, 7u, 2u, 7u, 3u, 0u, 4u, 6u, 0u, 6u, 2u, 1u, 3u, 7u, 1u, 7u, 5u);
struct VOut { @builtin(position) pos: vec4f, @location(0) @interpolate(flat) inst: u32 }
@vertex fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VOut {
  let F = foams[ii];
  let ci = CUBE[vi];
  let c = vec3f(f32(ci & 1u), f32((ci >> 1u) & 1u), f32((ci >> 2u) & 1u)) * 2.0 - 1.0;
  // A flat box around the patch, built on the local vertical, as high as the swell may stand.
  let up = vfx.domUp.xyz;
  var t1 = cross(up, vec3f(0.0, 0.0, 1.0));
  if (dot(t1, t1) < 1e-4) { t1 = cross(up, vec3f(1.0, 0.0, 0.0)); }
  t1 = normalize(t1);
  let t2 = cross(up, t1);
  let p = F.centre.xyz + (t1 * c.x + t2 * c.z) * (F.centre.w * 1.55) + up * (c.y * (foamU.albedo.w + 1.0));
  var o: VOut;
  o.pos = frame.viewProj * vec4f(vfxDomainToRel(p), 1.0);
  o.inst = ii;
  return o;
}
@fragment fn fs(in: VOut) -> @location(0) vec4f {
  let F = foams[in.inst];
  let px = vec2i(in.pos.xy);
  let depth = textureLoad(sceneDepthTex, px, 0);
  if (depth <= 0.0) { discard; }
  // Water only: the forward-drawn sea stands in front of the opaque scene, the far sheet is in the G-buffer.
  let opaque = textureLoad(sceneDepthOpaqueTex, px, 0);
  let material = u32(textureLoad(gbufferMaterialTex, px, 0).b * 255.0 + 0.5);
  if (!(depth > opaque * 1.000001 || material == MATERIAL_WATER)) { discard; }
  let uv = in.pos.xy * frame.renderSize.zw;
  let rel = positionFromDepth(uv, depth);
  let d = vfxRelToDomain(rel) - F.centre.xyz;
  let up = vfx.domUp.xyz;
  let h = dot(d, up);
  // The decal lies on the water wherever the swell has carried it, within the band.
  let band = foamU.albedo.w;
  if (abs(h) > band) { discard; }
  let hz = d - up * h;
  let rho0 = length(hz) / F.centre.w;
  if (rho0 >= 1.5) { discard; }
  let age = F.state.x;
  // Noise no finer than the pixel shows it (a threshold on unfiltered noise is a speckle of pinholes).
  let fpx = length(rel) * 2.0 * frame.cameraUp.w * frame.renderSize.w / max(abs(dot(normalize(rel), vfxDomainDir(up))), 0.08);
  let n0 = vfxNoiseLod(hz * (0.9 / F.centre.w) + vec3f(F.state.z * 7.0), fpx * 0.9 / F.centre.w);
  let n1 = vfxNoiseLod(hz * 0.09 + vec3f(F.state.z), fpx * 0.09);
  let n2 = vfxNoiseLod(hz * 0.31 + vec3f(F.state.z * 3.0), fpx * 0.31);
  // The patch has no outline to speak of: its edge wanders by forty per cent and more, in lobes, tongues and
  // small bays, and fades out softly.
  let rho = rho0 / (1.0 + 0.9 * (n0.r - 0.5) + 0.45 * (n1.g - 0.5) + 0.2 * (n2.r - 0.5));
  let edge = 1.0 - smoothstep(0.62, 1.0, rho);
  if (edge <= 0.0) { discard; }
  // White foam: churned water in the middle while it is fresh, and from the first seconds a lace of thin
  // filaments (the ridges of two octaves of noise, drawn out by the drift into streaks) that thins out as the
  // bubbles burst. Where the filaments are finer than the pixel they are their average cover, not a white
  // sheet. Under and around it the water is full of air: a faint pale-green tint that fades within seconds.
  let drift = vec3f(1.0, 0.0, 0.0) - up * up.x;
  let hs = hz + drift * (dot(hz, drift) * 0.6);
  let n3 = vfxNoiseLod(hs * 0.62 + vec3f(F.state.z * 5.0), fpx * 0.62);
  let n4 = vfxNoiseLod(hs * 1.7 + vec3f(F.state.z * 9.0), fpx * 1.7);
  let seen3 = 1.0 - smoothstep(0.15, 0.5, fpx * 0.62);
  let seen4 = 1.0 - smoothstep(0.15, 0.5, fpx * 1.7);
  let ridge3 = mix(0.3, smoothstep(0.82, 0.97, 1.0 - abs(2.0 * n3.g - 1.0)), seen3);
  let ridge4 = mix(0.25, smoothstep(0.8, 0.97, 1.0 - abs(2.0 * n4.r - 1.0)), seen4);
  let lace = max(ridge3, 0.8 * ridge4) * (0.4 + 0.9 * n1.g) * (1.0 - 0.6 * age);
  let churn = (1.0 - smoothstep(0.0, 0.55, rho)) * (1.0 - smoothstep(0.02, 0.3, age)) * (0.5 + 0.7 * n2.b);
  let white = saturate(max(0.9 * lace, churn)) * edge;
  let air = (1.0 - smoothstep(0.2, 0.9, rho)) * (1.0 - smoothstep(0.05, 0.4, age)) * edge * 0.6;
  let fadeOut = 1.0 - smoothstep(0.6, 1.0, age);
  let band_ = 1.0 - smoothstep(0.7 * band, band, abs(h));
  let a = saturate(max(white, 0.7 * air) * F.state.y * fadeOut) * band_;
  if (a < 0.003) { discard; }
  let probe = vfxProbes[0];
  let E = (probe.sun.rgb * saturate(dot(probe.up.xyz, frame.sunDir.xyz)) + vfxProbeAmbient(0u)) * (1.0 / PI);
  let tint = mix(vec3f(0.2, 0.42, 0.42), foamU.albedo.rgb, saturate(white / max(max(white, 0.7 * air), 1e-4)));
  let c = vfxAtmosphere(uv, length(rel), tint * E * frame.exposure.x * a, a);
  return vec4f(writeHdr(c.rgb), saturate(c.a));
}
`;

const CROWN_WGSL = /* wgsl */ `
#include "vfx_common"
#include "vfx_volume"
struct Crown {
  centre: vec4f,   // xyz = entry point on the water, domain coordinates, w = radius of the crown's foot now (m)
  shape: vec4f,    // x = height of the rim now (m), y = outward lean (m per m of height), z = thickness of the sheet at its foot (m), w = age (s)
  look: vec4f,     // x = optical depth across the sheet at its foot, y = break-up 0..1, z = seed, w = march steps
  bound: vec4f,    // x = radius of the proxy (m), y = its height (m), z = time of flight of the rim (s), w = the height the rim reaches (m)
  mist: vec4f,     // x = radius of the body that fell in (m), y = optical depth across the body of mist (0 = none), z, w unused
}
struct CrownU { albedo: vec4f }
@group(2) @binding(0) var<uniform> crownU: CrownU;
@group(2) @binding(1) var<storage, read> crowns: array<Crown, ${MAX_FOAM}>;

struct CrownFrame { origin: vec3f, X: vec3f, Y: vec3f, Z: vec3f }
/// The crown's frame relative to the camera: Y = local vertical, origin on the water.
fn crownFrame(C: Crown) -> CrownFrame {
  var f: CrownFrame;
  f.origin = vfxDomainToRel(C.centre.xyz);
  f.Y = vfxDomainDir(vfx.domUp.xyz);
  var t = cross(f.Y, vec3f(0.0, 0.0, 1.0));
  if (dot(t, t) < 1e-4) { t = cross(f.Y, vec3f(1.0, 0.0, 0.0)); }
  f.X = normalize(t);
  f.Z = cross(f.X, f.Y);
  return f;
}

struct VOut { @builtin(position) pos: vec4f, @location(0) @interpolate(flat) inst: u32 }
@vertex fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VOut {
  let C = crowns[ii];
  let f = crownFrame(C);
  var o: VOut;
  o.pos = volumeBoxVertex(vi, f.origin, f.X, f.Y, f.Z, vec3f(-C.bound.x, -0.5, -C.bound.x), vec3f(C.bound.x, C.bound.y, C.bound.x));
  o.inst = ii;
  return o;
}

@fragment fn fs(in: VOut) -> VolumeOut {
  let C = crowns[in.inst];
  let f = crownFrame(C);
  let R = volumeRay(in.pos, f.origin, f.X, f.Y, f.Z, vec3f(-C.bound.x, -0.5, -C.bound.x), vec3f(C.bound.x, C.bound.y, C.bound.x));
  if (R.t1 <= R.t0) { return volumeNone(); }
  let foot = C.centre.w;
  let H = max(C.shape.x, 0.05);
  let lean = C.shape.y;
  let thick = C.shape.z;
  let age = C.shape.w;
  let breakup = C.look.y;
  let seed = C.look.z;
  let body = C.mist.x;
  let peak = C.bound.w;
  let flight = max(C.bound.z, 1e-3);
  let steps = max(10.0, floor(C.look.w * vfx.time.w + 0.5));
  let dt = (R.t1 - R.t0) / steps;
  let jitter = blueNoise(vec2u(in.pos.xy)).g;
  let probe = vfxProbes[0];
  let sunL = vec3f(dot(frame.sunDir.xyz, f.X), dot(frame.sunDir.xyz, f.Y), dot(frame.sunDir.xyz, f.Z));
  let sunH = sunL.xz / max(length(sunL.xz), 1e-3);
  let low = saturate(1.0 - 1.4 * sunL.y);
  let amb = vfxProbeAmbient(0u);
  let fp = 2.0 * frame.cameraUp.w * vfx.half.w;
  // Looking towards the sun through spray: the drops throw its light forward.
  let forward = pow(saturate(dot(R.rd, sunL)), 6.0);
  // The body of mist: a ring of fine spray that the sheet leaves in the air, wider and higher with time,
  // settling and thinning long after the sheet has fallen back.
  let mistR = foot + 0.5 * lean * peak * (1.0 - exp(-age / (0.5 * flight)));
  let mistW = 0.45 * body + 0.25 * lean * peak * saturate(age / flight);
  let mistH = max(peak * (0.1 + 0.1 * saturate(age / (0.6 * flight))) * (1.0 - 0.3 * saturate(age / (2.0 * flight) - 0.5)), 0.2);
  var L = vec3f(0.0);
  var T = 1.0;
  var wsum = 0.0;
  var tsum = 0.0;
  for (var i = 0.0; i < steps; i += 1.0) {
    let t = R.t0 + (i + jitter) * dt;
    let p = R.ro + R.rd * t;
    if (p.y < 0.0) { continue; }
    let r = length(p.xz);
    let ang = p.xz / max(r, 1e-3);
    let lod = max(t * fp, 0.5 * dt) / foot;
    // Nothing about the crown is the same all the way round: here the wall stands high and far out and leans
    // over, there it is low and steep (slow noise in the angle), and its rim is a row of fingers (fast noise).
    let slow = vfxNoiseLod(vec3f(ang * 0.42, seed), lod * 0.3);
    let mid = vfxNoiseLod(vec3f(ang * 0.95, seed * 1.9 + 0.6), lod * 0.6);
    let fast = vfxNoiseLod(vec3f(ang * 1.9, seed * 2.7 + 0.3), lod);
    // (Three scales round the rim: where the wall stands, tongues a few to a side, and fingers.)
    let rim = H * (0.28 + 1.1 * slow.r + 0.55 * (mid.r - 0.5) + 0.8 * (fast.g - 0.5));
    let leanA = lean * (0.55 + 0.95 * slow.a);
    let footA = foot * (0.9 + 0.22 * slow.g);
    let s = p.y / max(rim, 0.05);
    var sigma = 0.0;
    var toSun = 0.0;
    var relief = 1.0;
    if (s < 1.0 && C.look.x > 0.0) {
      // The sheet is a wall of water with lumps: thick at its root, thin between the lumps, and it tears from
      // the rim downwards into ligaments (holes where the noise is low, more of them with time).
      let lump = vfxNoiseLod(vec3f(ang * 3.1, p.y / foot * 1.3 - age * 0.3 + seed * 5.1), lod * 1.5);
      let fine = vfxNoiseLod(vec3f(ang * 8.0, p.y / foot * 3.2 - age * 0.7 + seed * 1.3), lod * 4.0);
      let rs = footA + p.y * leanA * (1.0 + 0.35 * s);
      let w = thick * (1.0 - 0.6 * s) * (0.45 + 1.3 * lump.r) + 0.03;
      let across = (r - rs) / w;
      if (abs(across) < 2.6) {
        let hold = 0.6 * lump.g + 0.4 * fine.b;
        let cut = breakup * (0.2 + 1.1 * s) - 0.1;
        let whole = smoothstep(cut, cut + 0.2, hold) * (1.0 - smoothstep(0.8, 1.0, s));
        sigma = C.look.x / thick * exp(-across * across) * whole * (0.25 + 1.6 * (1.0 - s) * (1.0 - s) + 0.6 * lump.g);
        // Water between this point and the sun: the rest of this wall's thickness on its sunward side, and
        // (with a low sun) the wall across the crown for the side that faces away.
        let side = dot(ang, sunH);
        toSun = sigma * w * (1.3 - clamp(across, -1.3, 1.3) * sign(side)) + C.look.x * low * saturate(-side) * (1.0 - s);
        // The lumps stand out of the wall and shade the water between them: white water is never one flat white.
        relief = 0.62 + 0.55 * smoothstep(0.2, 0.8, lump.g) + 0.2 * (fine.b - 0.5);
      }
    }
    var mist = 0.0;
    if (C.mist.y > 0.0 && p.y < 3.0 * mistH) {
      // A torus of spray around the rim, thin in the middle, lumpy, with no top and no side to it: it thins out
      // upwards and outwards as a bell curve does.
      let n = vfxNoiseLod(vec3f(p.x, p.y - 0.6 * age, p.z) * (0.35 / body) + vec3f(seed * 3.3), max(t * fp, 0.5 * dt) * 0.35 / body);
      let n2 = vfxNoiseLod(vec3f(p.x, p.y - 0.9 * age, p.z) * (1.1 / body) + vec3f(seed * 1.7), max(t * fp, 0.5 * dt) * 1.1 / body);
      let rN = r * (1.0 + 0.5 * (n.r - 0.5)) + 0.6 * mistW * (slow.g - 0.5);
      let ring = exp(-sq((rN - mistR) / mistW)) + 0.2 * (1.0 - smoothstep(0.0, mistR, rN));
      let hN = mistH * (0.55 + 0.9 * slow.r) * (0.7 + 0.6 * n.a);
      mist = C.mist.y / mistW * ring * exp(-sq(p.y / (1.3 * hN))) * saturate((0.1 + 1.6 * n.g) * (0.5 + 1.0 * n2.b) - 0.15);
    }
    let total = sigma + mist;
    if (total <= 0.0) { continue; }
    let stepT = exp(-total * dt);
    // White water: sunlight that has come through little of it is bright, the lee of a thick wall is grey; what
    // is scattered about inside keeps a floor under it. Never brighter than a sunlit white surface, except
    // against the sun, where thin spray shines.
    let lit = (0.3 + 0.7 * exp(-toSun)) * mix(1.0, relief, sigma / max(total, 1e-6));
    let glare = 1.0 + 1.6 * forward * exp(-1.5 * toSun);
    let J = crownU.albedo.rgb * (probe.sun.rgb * (lit * glare) + amb) * (1.0 / PI);
    let c = J * (1.0 - stepT);
    let lw = T * luminance(c) + 1e-12;
    L += T * c;
    wsum += lw;
    tsum += lw * t;
    T *= stepT;
    if (T < 0.01) { break; }
  }
  if (T > 0.999) { return volumeNone(); }
  return volumeOut(R.uv, L, T, clamp(tsum / max(wsum, 1e-20), R.t0, R.t1));
}
`;

interface FoamPatch {
  pos: Vec3;
  start: number;
  bodyRadius: number;
  strength: number;
  seed: number;
  /** Speed at which the crown is thrown up, m/s. */
  crownSpeed: number;
}

export class FoamRenderer {
  private readonly device: GPUDevice;
  private readonly data = new Float32Array(MAX_FOAM * INST_FLOATS);
  private readonly buffer: GPUBuffer;
  private readonly group: GPUBindGroup;
  private readonly pipeline: Tracked<GPURenderPipeline>;
  private readonly waterLayout: GPUBindGroupLayout;
  private readonly water: SceneBindings;
  private waterGroup: GPUBindGroup | null = null;
  private waterVersion = -1;
  private readonly crownData = new Float32Array(MAX_FOAM * CROWN_FLOATS);
  private readonly crownBuffer: GPUBuffer;
  private readonly crownGroup: GPUBindGroup;
  private readonly crownPipeline: Tracked<GPURenderPipeline>;
  private crownDistances: number[] = [];
  private patches: FoamPatch[] = [];

  constructor(
    ctx: RenderContext,
    private readonly common: VfxCommon,
    private readonly vfx: VfxData,
  ) {
    const device = (this.device = ctx.device);
    const S = vfx.splash;
    this.buffer = device.createBuffer({ label: 'vfx.foam', size: this.data.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    const uniform = device.createBuffer({ label: 'vfx.foam.u', size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(uniform, 0, new Float32Array([...S.foamAlbedo, S.foamSwell, 0, 0, 0, 0]));
    const layout = device.createBindGroupLayout({
      label: 'vfx.foam',
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } },
      ],
    });
    this.group = device.createBindGroup({ label: 'vfx.foam', layout, entries: [{ binding: 0, resource: { buffer: uniform } }, { binding: 1, resource: { buffer: this.buffer } }] });
    // What tells water from a hull: the opaque depth and the G-buffer material, in a group of their own.
    this.water = common.core.createSceneBindings(3, 0, ['sceneDepthOpaque', 'gbuffer']);
    this.waterLayout = device.createBindGroupLayout({ label: 'vfx.foam.water', entries: this.water.layoutEntries });
    this.pipeline = common.core.shaders.tracked(() => {
      const module = ctx.shaders.createModule('vfx.foam', FOAM_WGSL(this.water.wgsl));
      return device.createRenderPipeline({
        label: 'vfx.foam',
        layout: device.createPipelineLayout({ label: 'vfx.foam', bindGroupLayouts: [ctx.frameBindGroupLayout, common.layout, layout, this.waterLayout] }),
        vertex: { module, entryPoint: 'vs' },
        fragment: { module, entryPoint: 'fs', targets: [{ format: RENDER_FORMATS.hdr, blend: { color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' }, alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' } } }] },
        // Back faces without a depth test: the box is drawn once per pixel whether the eye is inside it or not.
        primitive: { topology: 'triangle-list', cullMode: 'front' },
        depthStencil: { format: RENDER_FORMATS.depth, depthWriteEnabled: false, depthCompare: 'always' },
      });
    });
    this.pipeline.get();

    this.crownBuffer = device.createBuffer({ label: 'vfx.crown', size: this.crownData.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    const crownUniform = device.createBuffer({ label: 'vfx.crown.u', size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(crownUniform, 0, new Float32Array([...S.crown.albedo, 0]));
    const crownLayout = device.createBindGroupLayout({
      label: 'vfx.crown',
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } },
      ],
    });
    this.crownGroup = device.createBindGroup({ label: 'vfx.crown', layout: crownLayout, entries: [{ binding: 0, resource: { buffer: crownUniform } }, { binding: 1, resource: { buffer: this.crownBuffer } }] });
    this.crownPipeline = createVolumePipeline(ctx, common, 'vfx.crown', CROWN_WGSL, crownLayout);
    this.crownPipeline.get();
  }

  spawn(s: SplashSpawn, effectTime: number): void {
    if (this.patches.length >= MAX_FOAM) this.patches.shift();
    this.patches.push({
      pos: v3.clone(s.pos),
      start: effectTime,
      bodyRadius: s.radius,
      strength: Math.min(1, s.speed / 6),
      seed: (s.seed % 251) / 251,
      crownSpeed: s.speed * this.vfx.splash.crownSpeedFactor * this.vfx.splash.crown.rise,
    });
  }

  rebase(rb: DomainRebase): void {
    for (const p of this.patches) p.pos = applyRebase(rb, p.pos, v3.zero()).p;
  }

  clear(): void {
    this.patches = [];
    this.crownDistances = [];
  }

  /** Age the patches and pack the foam decals and the crowns. */
  update(frame: FrameContext, dom: DomainFrame, effectTime: number): void {
    const S = this.vfx.splash;
    const K = S.crown;
    this.patches = this.patches.filter((p) => effectTime - p.start < S.foamTime);
    this.crownDistances = [];
    const originRel = v3.sub(dom.originRoot, frame.camera.positionRoot);
    const gravity = dom.gravity > 0.1 ? dom.gravity : GRAVITY_FALLBACK;
    const lean = Math.tan(((90 - 0.5 * (S.crownAngleDeg[0] + S.crownAngleDeg[1])) * Math.PI) / 180);
    this.patches.forEach((p, i) => {
      const age = effectTime - p.start;
      const radius = p.bodyRadius * (1.2 + S.foamRadiusFactor * (1 - Math.exp(-age / 2.5)) + 0.04 * age);
      // (The decal's strength is the patch's times the data switch: 0 once the ocean draws the foam itself, request vfx-9.)
      this.data.set([p.pos.x, p.pos.y, p.pos.z, radius, age / S.foamTime, p.strength * S.foamDecal, p.seed, p.bodyRadius], i * INST_FLOATS);
      // The crown: up on the speed of the impact, down under gravity; it has torn apart by the time its rim is back at the water.
      const flight = (2 * p.crownSpeed) / gravity;
      const life = age / flight;
      if (life >= MIST_LIFE || p.strength <= 0) return;
      const peak = (p.crownSpeed * p.crownSpeed) / (2 * gravity);
      const height = crownHeight(p.crownSpeed, gravity, age);
      const foot = p.bodyRadius * (1.05 + K.spread * (1 - Math.exp(-age / (0.35 * flight))));
      const thick = K.thickness * p.bodyRadius * (1 - 0.55 * Math.min(1, life));
      const o = this.crownDistances.length * CROWN_FLOATS;
      const C = this.crownData;
      C.set([p.pos.x, p.pos.y, p.pos.z, foot], o);
      C.set([height, lean, thick, age], o + 4);
      C.set([life < 1 ? K.opticalDepth * p.strength * (1 - 0.6 * life * life) : 0, Math.min(1, K.breakup * Math.pow(Math.min(1, life), 0.8)), p.seed, K.steps], o + 8);
      // The rim reaches 1.8 heights where the noise stands it highest; the sheet leans out by up to twice lean x
      // height and stands up to 1.12 foot radii out; the mist reaches three of its scale heights and widths.
      const top = 1.8 * Math.max(height, 0.05);
      const mistHeight = 3 * 0.38 * peak;
      const mistReach = foot + 0.5 * lean * peak + 2.6 * (0.45 * p.bodyRadius + 0.25 * lean * peak);
      C.set([Math.max(1.12 * foot + 2.0 * lean * top + 4.6 * thick + 0.1, mistReach), Math.max(top, mistHeight) + 0.2, flight, peak], o + 12);
      // The mist comes up with the sheet and thins out over its life.
      const mist = K.mist * p.strength * Math.min(1, age / (0.25 * flight)) * (1 - life / MIST_LIFE) ** 1.5;
      C.set([p.bodyRadius, mist, 0, 0], o + 16);
      this.crownDistances.push(v3.len(v3.add(originRel, quat.rotate(dom.q, p.pos))));
    });
    if (this.patches.length > 0) this.device.queue.writeBuffer(this.buffer, 0, this.data, 0, this.patches.length * INST_FLOATS);
    if (this.crownDistances.length > 0) this.device.queue.writeBuffer(this.crownBuffer, 0, this.crownData, 0, this.crownDistances.length * CROWN_FLOATS);
  }

  get count(): number {
    return this.patches.length;
  }

  /** Crowns standing this frame. */
  get crownCount(): number {
    return this.crownDistances.length;
  }

  /** Volume-pass items: the crowns. */
  items(): VolumeItem[] {
    return this.crownDistances.map((distance, i) => ({
      distance,
      draw: (pass: GPURenderPassEncoder) => {
        pass.setPipeline(this.crownPipeline.get());
        pass.setBindGroup(2, this.crownGroup);
        pass.draw(36, 1, 0, i);
      },
    }));
  }

  draw(pass: GPURenderPassEncoder): void {
    if (this.patches.length === 0) return;
    const v = this.water.version();
    if (!this.waterGroup || v !== this.waterVersion) {
      this.waterVersion = v;
      this.waterGroup = this.device.createBindGroup({ label: 'vfx.foam.water', layout: this.waterLayout, entries: this.water.entries() });
    }
    pass.setPipeline(this.pipeline.get());
    pass.setBindGroup(1, this.common.bindGroup());
    pass.setBindGroup(2, this.group);
    pass.setBindGroup(3, this.waterGroup);
    pass.draw(36, this.patches.length);
  }

  dispose(): void {
    this.buffer.destroy();
    this.crownBuffer.destroy();
  }
}
