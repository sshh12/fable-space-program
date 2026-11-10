/**
 * Screen-space ambient occlusion (GTAO: 2 slices x 6 steps per side, cosine-weighted horizon integral)
 * and contact shadows towards the sun (10-step depth march), both at half resolution in one pass.
 * Output: rg8unorm (r = ambient visibility, g = contact-shadow visibility) plus the reversed-Z depth each
 * half-resolution pixel was computed at, which the lighting pass uses for its depth-aware upsample.
 * The per-pixel rotation and step jitter come from the frame blue noise; TAA integrates it.
 */
import type { FrameContext, RenderContext } from '@/core/contracts/render';
import type { CoreApi } from '../coreApi';
import type { Perf } from '../perf';
import type { CoreShaderLibrary, Tracked } from '../shaders/library';
import { createTextureChecked } from '../util/gpu';

const AO_FS = /* wgsl */ `
#include "gbuffer"
@group(1) @binding(0) var depthTex: texture_depth_2d;   // 'scene.depthOpaque'
@group(1) @binding(1) var normalTex: texture_2d<f32>;   // G-buffer RT1

struct Out {
  @location(0) ao: vec4f,
  @location(1) depth: vec4f,
}

const AO_SLICES = 2;
const AO_STEPS = 6;
const CONTACT_STEPS = 10;

fn loadDepth(p: vec2i, size: vec2i) -> f32 { return textureLoad(depthTex, clamp(p, vec2i(0), size - 1), 0); }
fn posAt(p: vec2i, d: f32) -> vec3f { return positionFromDepth((vec2f(p) + 0.5) * frame.renderSize.zw, d); }

@fragment fn fs(in: FullscreenOut) -> Out {
  let size = vec2i(textureDimensions(depthTex));
  let hp = vec2i(in.position.xy);
  // Which pixel of the 2 x 2 block: chosen per pixel by blue noise (which is re-offset every frame while
  // animating), so TAA sees every pixel over time without a global 4-frame cycle.
  let pick = u32(blueNoise(vec2u(hp)).w * 3.999);
  let fp = min(hp * 2 + vec2i(i32(pick & 1u), i32(pick >> 1u)), size - 1);
  let d = loadDepth(fp, size);
  if (d == 0.0) { return Out(vec4f(1.0, 1.0, 0.0, 1.0), vec4f(0.0)); }
  let P = posAt(fp, d);
  let viewZ = viewZFromDepth(d);
  let dist = length(P);
  let V = -P / dist;
  let N = octDecode(textureLoad(normalTex, fp, 0).xy);
  let noise = blueNoise(vec2u(hp));
  let pxPerMetre = frame.renderSize.y / (2.0 * frame.cameraUp.w * viewZ);

  // ---- GTAO. World radius grows with distance so far terrain keeps a visible, bounded screen radius.
  let radius = max(0.6, 0.05 * viewZ);
  let radiusPx = min(radius * pxPerMetre, 96.0);
  var visibility = 1.0;
  if (radiusPx >= 2.0) {
    visibility = 0.0;
    for (var s = 0; s < AO_SLICES; s++) {
      let phi = (f32(s) + noise.x) * (PI / f32(AO_SLICES));
      let dir = vec2f(cos(phi), sin(phi));
      // Slice direction in the world (screen y points down).
      let omega = frame.cameraRight.xyz * dir.x - frame.cameraUp.xyz * dir.y;
      let ortho = normalize(omega - V * dot(omega, V));
      let axis = cross(ortho, V);
      let projN = N - axis * dot(N, axis);
      let projLen = max(length(projN), 1e-4);
      let cosN = clamp(dot(projN, V) / projLen, -1.0, 1.0);
      let n = sign(dot(ortho, projN)) * acos(cosN);
      var horizon = vec2f(-1.0, -1.0);
      for (var side = 0; side < 2; side++) {
        let sgn = f32(side) * 2.0 - 1.0;
        var c = -1.0;
        for (var j = 0; j < AO_STEPS; j++) {
          let t = (f32(j) + noise.y) / f32(AO_STEPS);
          let o = dir * (sgn * max(radiusPx * t * t, 1.5));
          let sp = fp + vec2i(round(o));
          let sd = loadDepth(sp, size);
          if (sd == 0.0) { continue; }
          let D = posAt(sp, sd) - P;
          let len2 = dot(D, D);
          let falloff = saturate(1.0 - len2 / (radius * radius));
          c = max(c, mix(-1.0, dot(D * inverseSqrt(max(len2, 1e-12)), V), falloff));
        }
        if (side == 0) { horizon.x = c; } else { horizon.y = c; }
      }
      // Clamp the horizons to the normal's hemisphere and integrate the cosine-weighted visible arc.
      let h0 = n + max(-acos(horizon.x) - n, -PI * 0.5);
      let h1 = n + min(acos(horizon.y) - n, PI * 0.5);
      let sinN = sin(n);
      visibility += projLen * 0.25 * ((cosN + 2.0 * h0 * sinN - cos(2.0 * h0 - n)) + (cosN + 2.0 * h1 * sinN - cos(2.0 * h1 - n)));
    }
    visibility = saturate(visibility / f32(AO_SLICES));
  }

  // ---- Contact shadow: short march towards the sun against the depth buffer (fills in what is below a shadow texel).
  var contact = 1.0;
  let L = frame.sunDir.xyz;
  let NoL = dot(N, L);
  if (NoL > 0.0) {
    let marchLen = max(0.3, 0.015 * dist);
    let thickness = marchLen * 0.6;
    let origin = P + N * (0.0015 * viewZ + 0.002);
    for (var i = 0; i < CONTACT_STEPS; i++) {
      let t = marchLen * (f32(i) + noise.z) / f32(CONTACT_STEPS);
      let S = origin + L * t;
      let c = projectToUv(S);
      if (c.w <= frame.cameraForward.w) { break; }
      // Depth was rasterised with the jittered projection.
      let uv = c.xy + frame.jitter.zw * vec2f(0.5, -0.5);
      if (uv.x <= 0.0 || uv.y <= 0.0 || uv.x >= 1.0 || uv.y >= 1.0) { break; }
      let sd = loadDepth(vec2i(uv * frame.renderSize.xy), size);
      if (sd == 0.0) { continue; }
      let delta = c.w - viewZFromDepth(sd);
      if (delta > 0.002 * c.w + 0.001 && delta < thickness) {
        contact = 0.0;
        break;
      }
    }
  }
  return Out(vec4f(visibility, contact, 0.0, 1.0), vec4f(d, 0.0, 0.0, 0.0));
}
`;

export class AmbientOcclusion {
  view!: GPUTextureView;
  depthView!: GPUTextureView;
  private aoTex: GPUTexture | null = null;
  private depthTex: GPUTexture | null = null;
  private readonly layout: GPUBindGroupLayout;
  private readonly pipeline: Tracked<GPURenderPipeline>;
  private group: GPUBindGroup | null = null;
  private groupKey = -1;
  private normal: GPUTextureView | null = null;

  constructor(
    private readonly ctx: RenderContext,
    _shaders: CoreShaderLibrary,
    private readonly core: CoreApi,
  ) {
    this.layout = ctx.device.createBindGroupLayout({
      label: 'core.ao',
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'depth' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
      ],
    });
    this.pipeline = core.fullscreenPipeline({ label: 'core.ao', fragment: AO_FS, layouts: [this.layout], targets: [{ format: 'rg8unorm' }, { format: 'r32float' }] });
    this.resize(2, 2);
  }

  resize(w: number, h: number): void {
    const hw = Math.ceil(w / 2);
    const hh = Math.ceil(h / 2);
    if (this.aoTex && this.aoTex.width === hw && this.aoTex.height === hh) return;
    this.aoTex?.destroy();
    this.depthTex?.destroy();
    const usage = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING;
    this.aoTex = createTextureChecked(this.ctx.device, { label: 'core.ao', format: 'rg8unorm', size: [hw, hh], usage }, this.core.reportError);
    this.depthTex = createTextureChecked(this.ctx.device, { label: 'core.aoDepth', format: 'r32float', size: [hw, hh], usage }, this.core.reportError);
    this.view = this.aoTex.createView();
    this.depthView = this.depthTex.createView();
    this.group = null;
  }

  warm(): void {
    this.pipeline.get();
  }

  run(encoder: GPUCommandEncoder, _frame: FrameContext, perf: Perf, frameGroup: GPUBindGroup, normal: GPUTextureView): void {
    const key = this.ctx.resources.version('scene.depthOpaque');
    if (!this.group || key !== this.groupKey || normal !== this.normal) {
      this.groupKey = key;
      this.normal = normal;
      this.group = this.ctx.device.createBindGroup({
        label: 'core.ao',
        layout: this.layout,
        entries: [
          { binding: 0, resource: this.ctx.resources.get('scene.depthOpaque') },
          { binding: 1, resource: normal },
        ],
      });
    }
    const pass = encoder.beginRenderPass({
      label: 'ao',
      colorAttachments: [
        { view: this.view, clearValue: { r: 1, g: 1, b: 0, a: 1 }, loadOp: 'clear', storeOp: 'store' },
        { view: this.depthView, clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: 'clear', storeOp: 'store' },
      ],
      timestampWrites: perf.gpuPass('core.ao'),
    });
    pass.setBindGroup(0, frameGroup);
    pass.setPipeline(this.pipeline.get());
    pass.setBindGroup(1, this.group);
    pass.draw(3);
    pass.end();
  }
}
