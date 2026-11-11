/**
 * Parachutes: ring-sail canopies (gores, rings with slots, vent, tapes) and their suspension lines, drawn
 * from the parachute module states. Drogues and mains come from the same generator with different styles.
 *
 * A canopy is opaque cloth in the G-buffer (MATERIAL_ID.cloth: sheen, wrapped diffuse and light shining
 * through from the far side) and a moving shadow caster. Its shape is a function of `inflation` evaluated in
 * the vertex shader from a table of meridians (canopyModel.ts), with pillowing between the tapes, breathing
 * and skirt flutter. A canopy that is cut away or fails is handed over to the effect domain: it keeps
 * drifting on its own, collapsing (cut) or torn to shreds (failed), and fades.
 */
import { RENDER_FORMATS, type FrameContext, type RenderContext, type ShadowCascadeView } from '@/core/contracts/render';
import type { SimSnapshot } from '@/core/contracts/sim';
import { mat3, quat, v3, type Vec3 } from '@/core/math';
import type { Tracked } from '@/render/core';
import { buildCanopyMesh, buildProfileTable, canopyProfile, canopyRadius, clusterAngle, PROFILE_LEVELS, PROFILE_SAMPLES, type CanopyProfile } from './canopyModel';
import type { VfxCommon } from './common';
import type { CanopyStyleDef, VfxData } from './data';
import { applyRebase, type DomainFrame, type DomainRebase } from './domain';
import type { EmitterDesc } from './particles';

export const MAX_CANOPIES = 12;
const INST_FLOATS = 40;
const STYLE_FLOATS = 32;
const MAX_LINES = 1024;
const LINE_FLOATS = 12;
type StyleName = 'drogue' | 'main';

const canopyWgsl = (group: number): string => /* wgsl */ `
struct CanopyStyle {
  colors: array<vec4f, 4>,   // rgb = cloth colours
  pattern: vec4f,            // colour index of gores 0..3 (repeated around the canopy)
  band: vec4f,               // rgb = tape colour, a = pattern length
  params: vec4f,             // gores, rings, roughness, translucency
  reserved: vec4f,
}
struct CanopyInst {
  origin: vec4f,      // xyz = centre of the skirt relative to the camera, w = inflated projected radius R (m)
  axisX: vec4f,       // xyz, w = inflation (drag area fraction)
  axisY: vec4f,       // xyz = canopy axis (skirt to apex), w = shred 0..1
  axisZ: vec4f,       // xyz, w = fade 0..1
  prevOrigin: vec4f,  // the same relative to the previous eye; w = seed
  prevX: vec4f,       // w = time (s)
  prevY: vec4f,       // w = flutter gain
  prevZ: vec4f,
  reserved0: vec4f,
  reserved1: vec4f,
}
@group(${group}) @binding(0) var<uniform> style: CanopyStyle;
@group(${group}) @binding(1) var<storage, read> canopies: array<CanopyInst, ${MAX_CANOPIES}>;
@group(${group}) @binding(2) var profileTex: texture_2d<f32>;

/// Point of the cloth in the canopy frame (y along the axis from the skirt, m): s = 0 at the vent .. 1 at the
/// skirt, gc = gore coordinate (gore index + position across the gore).
fn canopyPoint(I: CanopyInst, s: f32, gc: f32) -> vec3f {
  let R = I.origin.w;
  let infl = I.axisX.w;
  let time = I.prevX.w;
  let seed = I.prevOrigin.w;
  let gain = I.prevY.w;
  let uv = vec2f((s * ${PROFILE_SAMPLES - 1}.0 + 0.5) / ${PROFILE_SAMPLES}.0, (sqrt(saturate(infl)) * ${PROFILE_LEVELS - 1}.0 + 0.5) / ${PROFILE_LEVELS}.0);
  let pr = textureSampleLevel(profileTex, linearClamp, uv, 0.0).rg;
  let theta = gc / style.params.x * TWO_PI;
  let u = fract(gc);
  let taut = smoothstep(0.02, 0.4, infl);
  var r = pr.x * R;
  var y = pr.y * R;
  // Pillowing between the radial tapes, breathing of the whole canopy, flutter of the skirt (more when slack).
  r *= 1.0 + (0.02 + 0.035 * taut) * sin(PI * u);
  r *= 1.0 + 0.012 * gain * sin(time * 1.9 + seed * 6.28);
  let slack = 1.0 - 0.75 * taut;
  let wave = 0.6 * sin(theta * 5.0 + time * 7.0 + seed * 17.0) + 0.4 * sin(theta * 9.0 - time * 11.0 + seed * 5.0);
  r *= 1.0 + gain * slack * 0.1 * s * s * wave;
  y += gain * slack * 0.06 * R * s * s * sin(theta * 3.0 + time * 5.0 + seed * 3.0);
  var p = vec3f(cos(theta) * r, y, sin(theta) * r);
  // A streaming canopy whips sideways, most at its free end.
  let whip = (1.0 - smoothstep(0.0, 0.08, infl)) * gain * 0.22 * R * pr.y;
  p.x += whip * sin(pr.y * 2.2 + time * 9.0 + seed * 9.0);
  p.z += whip * cos(pr.y * 1.7 + time * 7.3 + seed * 4.0);
  return p;
}
fn canopyWorld(I: CanopyInst, p: vec3f) -> vec3f { return I.origin.xyz + I.axisX.xyz * p.x + I.axisY.xyz * p.y + I.axisZ.xyz * p.z; }
`;

const GBUFFER_WGSL = /* wgsl */ `
#include "frame"
#include "gbuffer"
${canopyWgsl(1)}
struct VOut {
  @builtin(position) clip: vec4f,
  @location(0) n: vec3f,
  @location(1) coord: vec3f,                 // s, gore coordinate, ring coordinate
  @location(2) currClip: vec4f,
  @location(3) prevClip: vec4f,
  @location(4) @interpolate(flat) inst: u32,
}
@vertex fn vs(@location(0) a: vec3f, @builtin(instance_index) ii: u32) -> VOut {
  let I = canopies[ii];
  let p = canopyPoint(I, a.x, a.y);
  let ds = select(0.02, -0.02, a.x > 0.97);
  let ps = canopyPoint(I, a.x + ds, a.y);
  let pg = canopyPoint(I, a.x, a.y + 0.1);
  let nl = normalize(cross(pg - p, (ps - p) * sign(ds)));
  let world = canopyWorld(I, p);
  var o: VOut;
  o.clip = frame.viewProj * vec4f(world, 1.0);
  o.currClip = frame.viewProjUnjittered * vec4f(world, 1.0);
  o.prevClip = frame.prevViewProj * vec4f(I.prevOrigin.xyz + I.prevX.xyz * p.x + I.prevY.xyz * p.y + I.prevZ.xyz * p.z, 1.0);
  o.n = I.axisX.xyz * nl.x + I.axisY.xyz * nl.y + I.axisZ.xyz * nl.z;
  o.coord = a;
  o.inst = ii;
  return o;
}
fn hash2(a: f32, b: f32) -> f32 { return fract(sin(a * 12.9898 + b * 78.233) * 43758.5453); }
@fragment fn fs(v: VOut, @builtin(front_facing) front: bool) -> GBufferOut {
  let I = canopies[v.inst];
  let gore = floor(min(v.coord.y, style.params.x - 0.001));
  let ring = floor(min(v.coord.z, style.params.y - 0.001));
  // Shredding: whole panels go, the more the further the canopy is torn.
  if (I.axisY.w > 0.0 && hash2(gore + I.prevOrigin.w * 31.0, ring) < I.axisY.w) { discard; }
  if (I.axisZ.w < 1.0 && blueNoise(vec2u(v.clip.xy)).a >= I.axisZ.w) { discard; }
  let u = fract(v.coord.y);
  let w = fract(v.coord.z);
  let ci = u32(style.pattern[u32(gore) % u32(style.band.a)]);
  var albedo = style.colors[ci].rgb;
  // Radial tapes along the gore seams, hems at the ring edges.
  let tape = max(1.0 - smoothstep(0.02, 0.05, min(u, 1.0 - u)), 1.0 - smoothstep(0.03, 0.09, min(w, 1.0 - w)));
  albedo = mix(albedo, style.band.rgb, tape * 0.8);
  // The canopy mesh is wound clockwise seen from outside: front-facing fragments are the inside of the cloth.
  let outside = !front;
  var n = normalize(v.n);
  if (!outside) { n = -n; }
  // Cloth is a little rougher and denser under the tapes; fine pleats run along the gores.
  let pleat = sin(u * TWO_PI * 7.0) * 0.05 * (1.0 - tape);
  let translucency = style.params.w * (1.0 - 0.55 * tape);
  // The canopy is a lantern: sunlight that came in through the cloth on the sunny side fills the cavity and
  // shines out through every surface turned away from the sun (the deferred pass only knows the first pass
  // through one layer). Emitted here as cloth-coloured light, strongest where the surface faces away.
  //  - inside face, sun beyond the sheet: sunlight straight through one layer (the bright, saturated glow of
  //    a canopy seen from below against the light);
  //  - inside face turned to the sun: lit by what came in through the far wall;
  //  - outside face turned away from the sun: cavity light through one more layer.
  // The outside face in the sun is the deferred pass's business. The G-buffer gets translucency 0, so that
  // nothing of this is counted twice where the shadow map lets the core's own transmission term through.
  let sun = frame.sunIlluminance.rgb * frame.misc.y;
  let NoL = dot(n, frame.sunDir.xyz);
  let T = translucency;
  let forward = 0.75 + 0.9 * pow(saturate(dot(normalize(viewRay(v.clip.xy * frame.renderSize.zw)), frame.sunDir.xyz)), 4.0);
  var g = 0.0;
  if (outside) { g = T * T * saturate(-NoL); }
  else { g = T * (saturate(-NoL) * forward + 0.8 * saturate(NoL)); }
  // Light that crossed the cloth takes its colour.
  let tint = albedo * mix(vec3f(1.0), albedo / max(max(albedo.r, max(albedo.g, albedo.b)), 1e-3), 0.6);
  let filled = 0.35 + 0.65 * smoothstep(0.02, 0.5, I.axisX.w);
  let cavity = tint * sun * (g * filled / PI);
  return gbufferPack(albedo * ((1.0 + pleat) * (1.0 - 0.5 * T)), 1.0, n, style.params.z, 0.0, MATERIAL_CLOTH, 0.0, velocityFromClip(v.currClip, v.prevClip), cavity * frame.exposure.x);
}
`;

const SHADOW_WGSL = /* wgsl */ `
#include "frame"
#include "shadow_pass"
${canopyWgsl(2)}
@vertex fn vs(@location(0) a: vec3f, @builtin(instance_index) ii: u32) -> @builtin(position) vec4f {
  let I = canopies[ii];
  return shadowPass.viewProj * vec4f(canopyWorld(I, canopyPoint(I, a.x, a.y)), 1.0);
}
`;

const LINES_WGSL = /* wgsl */ `
#include "vfx_common"
struct Line {
  a: vec4f,      // xyz = end A relative to the camera, w = diameter (m)
  b: vec4f,      // xyz = end B
  color: vec4f,  // rgb = albedo, a = opacity
}
@group(2) @binding(0) var<storage, read> lines: array<Line>;
struct VOut {
  @builtin(position) clip: vec4f,
  @location(0) across: f32,
  @location(1) @interpolate(flat) color: vec4f,
  @location(2) dist: f32,
}
@vertex fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VOut {
  let L = lines[ii];
  let end = f32(vi & 1u);
  let sideSign = f32((vi >> 1u) & 1u) * 2.0 - 1.0;
  let p = mix(L.a.xyz, L.b.xyz, end);
  let dir = normalize(L.b.xyz - L.a.xyz);
  var side = cross(dir, normalize(p));
  if (dot(side, side) < 1e-8) { side = frame.cameraRight.xyz; }
  side = normalize(side);
  // Never thinner than a pixel: widen and dim instead.
  let viewZ = max(dot(p, frame.cameraForward.xyz), 0.05);
  let pixel = 2.0 * frame.cameraUp.w * frame.renderSize.w * viewZ;
  let half = max(0.5 * L.a.w, 0.6 * pixel);
  var o: VOut;
  o.clip = frame.viewProj * vec4f(p + side * (sideSign * half), 1.0);
  o.across = sideSign;
  // Lit like a thin cylinder of cord: half of it faces the sun whatever the view.
  let probe = vfxProbes[0];
  let lum = L.color.rgb * (probe.sun.rgb * (0.5 / PI) + vfxProbeAmbient(0u) * (1.0 / PI) + vfxLocalLights(p) * (0.5 / PI));
  o.color = vec4f(lum * frame.exposure.x, L.color.a * min(1.0, 0.5 * L.a.w / half));
  o.dist = length(p);
  return o;
}
@fragment fn fs(v: VOut) -> @location(0) vec4f {
  let a = v.color.a * (1.0 - smoothstep(0.6, 1.0, abs(v.across)));
  let c = vfxAtmosphere(v.clip.xy * frame.renderSize.zw, v.dist, v.color.rgb * a, a);
  return vec4f(writeHdr(c.rgb), saturate(c.a));
}
`;

interface StyleGpu {
  def: CanopyStyleDef;
  vertexBuffer: GPUBuffer;
  indexBuffer: GPUBuffer;
  indexCount: number;
  instanceData: Float32Array;
  instanceBuffer: GPUBuffer;
  group: GPUBindGroup;
  count: number;
}

interface CanopyPlacement {
  key: string;
  style: StyleName;
  /** Radius R of the fully open canopy and length of the suspension lines, m. */
  radius: number;
  suspension: number;
  inflation: number;
  /** Skirt centre and frame (camera-relative, ROOT axes), now and one frame ago. */
  origin: Vec3;
  X: Vec3;
  Y: Vec3;
  Z: Vec3;
  prevOrigin: Vec3;
  prevX: Vec3;
  prevY: Vec3;
  prevZ: Vec3;
  /** Where the lines meet, camera-relative, and where the riser starts (null: the lines hang free). */
  confluence: Vec3;
  attach: Vec3 | null;
  shred: number;
  fade: number;
  seed: number;
  flutter: number;
  /** For the hand-over to a drifting canopy: velocity in domain axes, and who it belongs to. */
  velDom: Vec3;
  owner: { vesselId: string; partId: string; module: number };
}

interface Drifting {
  placement: CanopyPlacement;
  mode: 'cut' | 'failed';
  start: number;
  /** Skirt centre, axes and velocity in domain coordinates. */
  pos: Vec3;
  X: Vec3;
  Y: Vec3;
  Z: Vec3;
  vel: Vec3;
  inflation0: number;
  down: boolean;
}

export class ChuteSystem {
  private readonly device: GPUDevice;
  private readonly styles: Record<StyleName, StyleGpu>;
  private readonly gbufferPipeline: Tracked<GPURenderPipeline>;
  private readonly shadowPipeline: Tracked<GPURenderPipeline>;
  private readonly linesPipeline: Tracked<GPURenderPipeline>;
  private readonly lineData = new Float32Array(MAX_LINES * LINE_FLOATS);
  private readonly lineBuffer: GPUBuffer;
  private readonly lineGroup: GPUBindGroup;
  private lineCount = 0;
  private live = new Map<string, CanopyPlacement>();
  private drifting: Drifting[] = [];
  private readonly profiles = new Map<string, CanopyProfile>();
  /** Canopies drawn in the last frame. */
  canopyCount = 0;

  constructor(
    private readonly ctx: RenderContext,
    private readonly common: VfxCommon,
    private readonly data: VfxData,
  ) {
    const device = (this.device = ctx.device);
    const layout = device.createBindGroupLayout({
      label: 'vfx.canopy',
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } },
        { binding: 2, visibility: GPUShaderStage.VERTEX, texture: { sampleType: 'float' } },
      ],
    });
    const mkStyle = (name: StyleName): StyleGpu => {
      const def = data.parachutes[name];
      const mesh = buildCanopyMesh(def);
      const vertexBuffer = device.createBuffer({ label: `vfx.canopy.${name}.vb`, size: mesh.vertices.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
      device.queue.writeBuffer(vertexBuffer, 0, mesh.vertices);
      const indexBuffer = device.createBuffer({ label: `vfx.canopy.${name}.ib`, size: mesh.indices.byteLength, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST });
      device.queue.writeBuffer(indexBuffer, 0, mesh.indices);
      const table = buildProfileTable(def);
      const texture = common.core.createTextureChecked({ label: `vfx.canopy.${name}.profile`, format: 'rgba32float', size: [PROFILE_SAMPLES, PROFILE_LEVELS], usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
      device.queue.writeTexture({ texture }, table, { bytesPerRow: PROFILE_SAMPLES * 16 }, [PROFILE_SAMPLES, PROFILE_LEVELS]);
      const su = new Float32Array(STYLE_FLOATS);
      def.colors.slice(0, 4).forEach((c, i) => su.set([c[0], c[1], c[2], 1], i * 4));
      const pattern = [0, 1, 2, 3].map((i) => def.pattern[i % def.pattern.length]!);
      su.set(pattern, 16);
      su.set([def.bandColor[0], def.bandColor[1], def.bandColor[2], Math.min(4, def.pattern.length)], 20);
      su.set([def.gores, def.rings, def.roughness, def.translucency], 24);
      const styleBuffer = device.createBuffer({ label: `vfx.canopy.${name}.style`, size: STYLE_FLOATS * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      device.queue.writeBuffer(styleBuffer, 0, su);
      const instanceData = new Float32Array(MAX_CANOPIES * INST_FLOATS);
      const instanceBuffer = device.createBuffer({ label: `vfx.canopy.${name}.instances`, size: instanceData.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
      const group = device.createBindGroup({
        label: `vfx.canopy.${name}`,
        layout,
        entries: [{ binding: 0, resource: { buffer: styleBuffer } }, { binding: 1, resource: { buffer: instanceBuffer } }, { binding: 2, resource: texture.createView() }],
      });
      return { def, vertexBuffer, indexBuffer, indexCount: mesh.indices.length, instanceData, instanceBuffer, group, count: 0 };
    };
    this.styles = { drogue: mkStyle('drogue'), main: mkStyle('main') };
    const vertexLayout: GPUVertexBufferLayout = { arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }] };
    const core = common.core;
    this.gbufferPipeline = core.shaders.tracked(() => {
      const module = ctx.shaders.createModule('vfx.canopy.gbuffer', GBUFFER_WGSL);
      return device.createRenderPipeline({
        label: 'vfx.canopy.gbuffer',
        layout: device.createPipelineLayout({ label: 'vfx.canopy.gbuffer', bindGroupLayouts: [ctx.frameBindGroupLayout, layout] }),
        vertex: { module, entryPoint: 'vs', buffers: [vertexLayout] },
        fragment: {
          module,
          entryPoint: 'fs',
          targets: [RENDER_FORMATS.gbufferAlbedo, RENDER_FORMATS.gbufferNormal, RENDER_FORMATS.gbufferMaterial, RENDER_FORMATS.gbufferVelocity, RENDER_FORMATS.gbufferExtra, RENDER_FORMATS.hdr].map((format) => ({ format })),
        },
        primitive: { topology: 'triangle-list', cullMode: 'none' },
        depthStencil: { format: RENDER_FORMATS.depth, depthWriteEnabled: true, depthCompare: 'greater' },
      });
    });
    this.shadowPipeline = core.shaders.tracked(() => {
      const module = ctx.shaders.createModule('vfx.canopy.shadow', SHADOW_WGSL);
      return device.createRenderPipeline({
        label: 'vfx.canopy.shadow',
        layout: device.createPipelineLayout({ label: 'vfx.canopy.shadow', bindGroupLayouts: [ctx.frameBindGroupLayout, core.shadowPassLayout, layout] }),
        vertex: { module, entryPoint: 'vs', buffers: [vertexLayout] },
        primitive: { topology: 'triangle-list', cullMode: 'none', unclippedDepth: true },
        depthStencil: { format: RENDER_FORMATS.shadow, depthWriteEnabled: true, depthCompare: 'less', depthBias: 2, depthBiasSlopeScale: 1.5 },
      });
    });
    this.lineBuffer = device.createBuffer({ label: 'vfx.canopy.lines', size: this.lineData.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    const lineLayout = device.createBindGroupLayout({ label: 'vfx.canopy.lines', entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } }] });
    this.lineGroup = device.createBindGroup({ label: 'vfx.canopy.lines', layout: lineLayout, entries: [{ binding: 0, resource: { buffer: this.lineBuffer } }] });
    this.linesPipeline = core.shaders.tracked(() => {
      const module = ctx.shaders.createModule('vfx.canopy.lines', LINES_WGSL);
      return device.createRenderPipeline({
        label: 'vfx.canopy.lines',
        layout: device.createPipelineLayout({ label: 'vfx.canopy.lines', bindGroupLayouts: [ctx.frameBindGroupLayout, common.layout, lineLayout] }),
        vertex: { module, entryPoint: 'vs' },
        fragment: { module, entryPoint: 'fs', targets: [{ format: RENDER_FORMATS.hdr, blend: { color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' }, alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' } } }] },
        primitive: { topology: 'triangle-strip', cullMode: 'none' },
        depthStencil: { format: RENDER_FORMATS.depth, depthWriteEnabled: false, depthCompare: 'greater-equal' },
      });
    });
    this.gbufferPipeline.get();
    this.shadowPipeline.get();
    this.linesPipeline.get();
  }

  private profile(style: StyleName, inflation: number): CanopyProfile {
    const q = Math.round(Math.min(1, Math.max(0, inflation)) * 200);
    const key = `${style}:${q}`;
    let p = this.profiles.get(key);
    if (!p) {
      p = canopyProfile(this.data.parachutes[style], q / 200);
      this.profiles.set(key, p);
    }
    return p;
  }

  rebase(rb: DomainRebase): void {
    for (const d of this.drifting) {
      const r = applyRebase(rb, d.pos, d.vel);
      d.pos = r.p;
      d.vel = r.v;
      // Directions take the rotation only.
      d.X = v3.normalize(mat3.mulVec(rb.A, d.X));
      d.Y = v3.normalize(mat3.mulVec(rb.A, d.Y));
      d.Z = v3.normalize(mat3.mulVec(rb.A, d.Z));
    }
  }

  clear(): void {
    this.drifting = [];
    this.live.clear();
  }

  /**
   * Gather the canopies of this frame from the module states, hand cut and failed ones over to the domain,
   * move those, and upload everything. Returns particle emitters (cloth scraps of a canopy that failed).
   */
  update(frame: FrameContext, dom: DomainFrame, effectTime: number, dt: number, floor: number | null): EmitterDesc[] {
    const snap: SimSnapshot = frame.snapshot;
    const defs = this.ctx.defs;
    const emitters: EmitterDesc[] = [];
    const domOriginRel = v3.sub(dom.originRoot, frame.camera.positionRoot);
    const toDom = (rel: Vec3): Vec3 => quat.rotateInv(dom.q, v3.sub(rel, domOriginRel));
    const dirDom = (d: Vec3): Vec3 => quat.rotateInv(dom.q, d);
    const now = new Map<string, CanopyPlacement>();

    for (const vessel of snap.vessels) {
      const pose = frame.vesselPose(vessel.id);
      if (!pose) continue;
      for (const part of vessel.parts) {
        const def = defs.parts[part.def];
        if (!def) continue;
        for (let mi = 0; mi < part.modules.length; mi++) {
          const state = part.modules[mi]!;
          const md = def.modules[mi];
          if (state.type !== 'parachute' || md?.type !== 'parachute' || (state.state !== 'reefed' && state.state !== 'full')) continue;
          const styleName: StyleName = md.mode;
          const style = this.data.parachutes[styleName];
          const R = md.canopyDiameter / 2;
          const attachVes = v3.add(part.localPos, quat.rotate(part.localRot, v3.fromTuple(md.attach)));
          const frameAt = (origin: Vec3, q: typeof pose.q): { attach: Vec3; c: Vec3; e1: Vec3; e2: Vec3 } => {
            const c = v3.normalize(quat.rotate(q, state.lineDir));
            let ref = quat.rotate(q, v3.unitX());
            if (Math.abs(v3.dot(ref, c)) > 0.9) ref = quat.rotate(q, v3.unitZ());
            const e1 = v3.normalize(v3.reject(ref, c));
            return { attach: v3.add(origin, quat.rotate(q, attachVes)), c, e1, e2: v3.cross(c, e1) };
          };
          const cur = frameAt(pose.originRelCam, pose.q);
          const prev = frameAt(pose.prevOriginRelCam, pose.prevQ);
          const rp = R * canopyRadius(style, state.inflation);
          for (let k = 0; k < md.count; k++) {
            const key = `${vessel.id}|${part.instanceId}|${mi}|${k}`;
            const seed = ((k * 37 + mi * 11) % 97) / 97;
            const psi = (2 * Math.PI * k) / md.count + 0.08 * Math.sin(effectTime * 0.35 + k * 2.1);
            const alpha = clusterAngle(style, md.count, rp, md.lineLength) * (1 + 0.05 * Math.sin(effectTime * 0.5 + k * 1.3));
            const place = (f: typeof cur): { origin: Vec3; X: Vec3; Y: Vec3; Z: Vec3; confluence: Vec3 } => {
              const lateral = v3.add(v3.scale(f.e1, Math.cos(psi)), v3.scale(f.e2, Math.sin(psi)));
              const Y = v3.normalize(v3.add(v3.scale(f.c, Math.cos(alpha)), v3.scale(lateral, Math.sin(alpha))));
              const X = v3.normalize(v3.reject(v3.lenSq(v3.reject(f.e1, Y)) > 1e-6 ? f.e1 : f.e2, Y));
              return { origin: v3.addScaled(f.attach, Y, md.lineLength), X, Y, Z: v3.cross(X, Y), confluence: v3.addScaled(f.attach, Y, md.lineLength * (1 - style.suspensionFraction)) };
            };
            const a = place(cur);
            const b = place(prev);
            now.set(key, {
              key,
              style: styleName,
              radius: R,
              suspension: md.lineLength * style.suspensionFraction,
              inflation: state.inflation,
              origin: a.origin,
              X: a.X,
              Y: a.Y,
              Z: a.Z,
              prevOrigin: b.origin,
              prevX: b.X,
              prevY: b.Y,
              prevZ: b.Z,
              confluence: a.confluence,
              attach: cur.attach,
              shred: 0,
              fade: 1,
              seed,
              flutter: 1,
              velDom: quat.rotateInv(dom.q, v3.sub(vessel.vRoot, dom.velocityRoot)),
              owner: { vesselId: vessel.id, partId: part.instanceId, module: mi },
            });
          }
        }
      }
    }

    // Canopies that were there a frame ago and are gone: cut away or failed ones drift on.
    for (const [key, old] of this.live) {
      if (now.has(key)) continue;
      const vessel = snap.vessels.find((v) => v.id === old.owner.vesselId);
      const module = vessel?.parts.find((p) => p.instanceId === old.owner.partId)?.modules[old.owner.module];
      if (module?.type !== 'parachute' || (module.state !== 'cut' && module.state !== 'failed')) continue;
      if (this.drifting.length >= MAX_CANOPIES) this.drifting.shift();
      this.drifting.push({ placement: old, mode: module.state, start: effectTime, pos: toDom(old.origin), X: dirDom(old.X), Y: dirDom(old.Y), Z: dirDom(old.Z), vel: old.velDom, inflation0: old.inflation, down: false });
      if (module.state === 'failed') {
        const S = this.data.parachutes.shred;
        const style = this.data.parachutes[old.style];
        emitters.push({
          kind: 'chip',
          shape: 'sphere',
          pos: v3.addScaled(toDom(old.origin), dirDom(old.Y), 0.3 * old.radius),
          axis: dirDom(old.Y),
          radius: 0.6 * old.radius * canopyRadius(style, old.inflation),
          vel: old.velDom,
          speed: [1, 14],
          polar: [0, Math.PI],
          life: [2, 7],
          size: [0.08, 0.3],
          color: style.colors[0]!,
          opacity: 1,
          count: Math.round(S.pieces / Math.max(1, this.data.parachutes[old.style].pattern.length)),
          seed: Math.round(old.seed * 1e6) + 17,
        });
      }
    }
    this.live = now;

    // Drifting canopies: the air stops them, they sink, tip over and fade.
    const C = this.data.parachutes.cutDrift;
    const S = this.data.parachutes.shred;
    const surface = dom.state.kind === 'surface';
    const drawn: CanopyPlacement[] = [...now.values()];
    this.drifting = this.drifting.filter((d) => effectTime - d.start < C.fadeTime);
    for (const d of this.drifting) {
      const age = effectTime - d.start;
      if (surface && !d.down) {
        const target = v3.scale(dom.up, -C.sinkSpeed * (d.mode === 'failed' ? 2.5 : 1));
        d.vel = v3.add(d.vel, v3.scale(v3.sub(target, d.vel), 1 - Math.exp(-dt / 1.2)));
        // Tip over about a horizontal axis.
        const axis = v3.normalize(v3.cross(dom.up, v3.lenSq(v3.reject(d.X, dom.up)) > 1e-6 ? d.X : d.Z));
        const rot = quat.fromAxisAngle(axis, 0.12 * dt * Math.min(1, age));
        d.X = quat.rotate(rot, d.X);
        d.Y = quat.rotate(rot, d.Y);
        d.Z = quat.rotate(rot, d.Z);
      }
      d.pos = v3.addScaled(d.pos, d.vel, dt);
      if (floor !== null && v3.dot(dom.up, d.pos) < floor + 0.3) {
        d.pos = v3.addScaled(d.pos, dom.up, floor + 0.3 - v3.dot(dom.up, d.pos));
        d.vel = v3.zero();
        d.down = true;
      }
      const p = d.placement;
      const origin = v3.add(domOriginRel, quat.rotate(dom.q, d.pos));
      const X = quat.rotate(dom.q, d.X);
      const Y = quat.rotate(dom.q, d.Y);
      const Z = quat.rotate(dom.q, d.Z);
      const collapse = Math.exp(-age / C.collapseTime);
      const inflation = d.mode === 'failed' ? Math.max(0.004, d.inflation0 * Math.exp(-age / (0.3 * S.time))) : Math.max(0.05, d.inflation0 * collapse);
      // One frame ago: it has moved with the domain and by its own velocity, the eye by prevEyeOffset.
      const prevOrigin = v3.sub(v3.addScaled(origin, v3.add(dom.velocityRoot, quat.rotate(dom.q, d.vel)), -dt), frame.prevEyeOffset);
      drawn.push({
        ...p,
        inflation,
        origin,
        X,
        Y,
        Z,
        prevOrigin,
        prevX: X,
        prevY: Y,
        prevZ: Z,
        confluence: v3.addScaled(v3.addScaled(origin, Y, -0.45 * p.suspension), quat.rotate(dom.q, dom.up), -0.45 * p.suspension),
        attach: null,
        shred: d.mode === 'failed' ? Math.min(0.92, 0.25 + 0.7 * (age / S.time)) : 0,
        fade: 1 - Math.min(1, Math.max(0, (age - 0.7 * C.fadeTime) / (0.3 * C.fadeTime))),
        flutter: d.down ? 0.15 : 2.2,
      });
    }

    // Pack instances per style and the suspension lines.
    for (const s of Object.values(this.styles)) s.count = 0;
    const L = this.lineData;
    let lines = 0;
    const addLine = (a: Vec3, b: Vec3, width: number, alpha: number, color: readonly number[]): void => {
      if (lines >= MAX_LINES) return;
      L.set([a.x, a.y, a.z, width, b.x, b.y, b.z, 0, color[0]!, color[1]!, color[2]!, alpha], lines * LINE_FLOATS);
      lines++;
    };
    for (const p of drawn) {
      const s = this.styles[p.style];
      if (s.count >= MAX_CANOPIES) continue;
      const o = s.count * INST_FLOATS;
      const D = s.instanceData;
      D.set([p.origin.x, p.origin.y, p.origin.z, p.radius], o);
      D.set([p.X.x, p.X.y, p.X.z, p.inflation], o + 4);
      D.set([p.Y.x, p.Y.y, p.Y.z, p.shred], o + 8);
      D.set([p.Z.x, p.Z.y, p.Z.z, p.fade], o + 12);
      D.set([p.prevOrigin.x, p.prevOrigin.y, p.prevOrigin.z, p.seed], o + 16);
      D.set([p.prevX.x, p.prevX.y, p.prevX.z, frame.animate ? effectTime : 0], o + 20);
      D.set([p.prevY.x, p.prevY.y, p.prevY.z, p.flutter], o + 24);
      D.set([p.prevZ.x, p.prevZ.y, p.prevZ.z, 0], o + 28);
      s.count++;
      // Lines: one per gore from the confluence to the skirt, and the riser.
      const prof = this.profile(p.style, p.inflation);
      const mouth = prof.r[PROFILE_SAMPLES - 1]! * p.radius;
      const lineColor = [0.78, 0.76, 0.7];
      const gores = s.def.gores;
      const step = p.shred > 0 ? 2 : 1;
      for (let g = 0; g < gores; g += step) {
        const th = (g / gores) * 2 * Math.PI;
        const at = v3.add(p.origin, v3.add(v3.scale(p.X, Math.cos(th) * mouth), v3.scale(p.Z, Math.sin(th) * mouth)));
        addLine(p.confluence, at, s.def.lineWidth, p.fade, lineColor);
      }
      if (p.attach) addLine(p.attach, p.confluence, s.def.lineWidth * 3, p.fade, lineColor);
    }
    this.lineCount = lines;
    this.canopyCount = drawn.length;
    for (const s of Object.values(this.styles)) if (s.count > 0) this.device.queue.writeBuffer(s.instanceBuffer, 0, s.instanceData, 0, s.count * INST_FLOATS);
    if (lines > 0) this.device.queue.writeBuffer(this.lineBuffer, 0, L, 0, lines * LINE_FLOATS);
    return emitters;
  }

  private drawMeshes(pass: GPURenderPassEncoder, groupIndex: number): void {
    for (const s of Object.values(this.styles)) {
      if (s.count === 0) continue;
      pass.setBindGroup(groupIndex, s.group);
      pass.setVertexBuffer(0, s.vertexBuffer);
      pass.setIndexBuffer(s.indexBuffer, 'uint32');
      pass.drawIndexed(s.indexCount, s.count);
    }
  }

  drawGBuffer(pass: GPURenderPassEncoder): void {
    if (this.canopyCount === 0) return;
    pass.setPipeline(this.gbufferPipeline.get());
    this.drawMeshes(pass, 1);
  }

  /** Canopies move: they cast only into cascades that are re-rendered every frame. */
  drawShadow(pass: GPURenderPassEncoder, cascade: ShadowCascadeView): void {
    if (this.canopyCount === 0 || !cascade.everyFrame) return;
    pass.setPipeline(this.shadowPipeline.get());
    this.drawMeshes(pass, 2);
  }

  drawLines(pass: GPURenderPassEncoder): void {
    if (this.lineCount === 0) return;
    pass.setPipeline(this.linesPipeline.get());
    pass.setBindGroup(1, this.common.bindGroup());
    pass.setBindGroup(2, this.lineGroup);
    pass.draw(4, this.lineCount);
  }

  dispose(): void {
    for (const s of Object.values(this.styles)) {
      s.vertexBuffer.destroy();
      s.indexBuffer.destroy();
      s.instanceBuffer.destroy();
    }
    this.lineBuffer.destroy();
  }
}
