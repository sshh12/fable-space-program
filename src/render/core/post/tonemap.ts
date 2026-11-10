/**
 * Final pass to the canvas: RCAS sharpening of the resolved image, bloom mix, AgX tonemap with a mild
 * "punchy" look, sRGB OETF and triangular blue-noise dither. The LDR overlay hooks draw into the same
 * canvas attachment afterwards.
 */
import type { RenderContext } from '@/core/contracts/render';
import type { CoreShaderLibrary, Tracked } from '../shaders/library';

const TONEMAP_FS = /* wgsl */ `
#include "frame"
#include "fullscreen"
struct TonemapUniforms {
  // x = bloom mix (fraction of energy), y = RCAS sharpness (0 = off, 1 = maximum), z = dither amplitude in LSB, w = unused
  params: vec4f,
}
@group(1) @binding(0) var<uniform> tm: TonemapUniforms;
@group(1) @binding(1) var sceneTex: texture_2d<f32>;
@group(1) @binding(2) var bloomTex: texture_2d<f32>;

fn agxContrast(x: vec3f) -> vec3f {
  let x2 = x * x;
  let x4 = x2 * x2;
  return 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4 - 6.868 * x2 * x + 0.4298 * x2 + 0.1191 * x - 0.00232;
}
/// AgX (Troy Sobotka; Wrensch's minimal fit): scene-linear sRGB -> display-linear sRGB.
fn agx(c: vec3f) -> vec3f {
  let inset = mat3x3f(0.842479062253094, 0.0423282422610123, 0.0423756549057051,
                      0.0784335999999992, 0.878468636469772, 0.0784336,
                      0.0792237451477643, 0.0791661274605434, 0.879142973793104);
  let outset = mat3x3f(1.19687900512017, -0.0528968517574562, -0.0529716355144438,
                       -0.0980208811401368, 1.15190312990417, -0.0980434501171241,
                       -0.0990297440797205, -0.0989611768448433, 1.15107367264116);
  let minEv = -12.47393;
  let maxEv = 4.026069;
  var v = inset * max(c, vec3f(0.0));
  v = (clamp(log2(max(v, vec3f(1e-10))), vec3f(minEv), vec3f(maxEv)) - minEv) / (maxEv - minEv);
  v = agxContrast(v);
  // Mild punchy look: a little more contrast and saturation than the base rendering.
  v = pow(max(v, vec3f(0.0)), vec3f(1.12));
  let l = dot(v, vec3f(0.2126, 0.7152, 0.0722));
  v = vec3f(l) + 1.15 * (v - vec3f(l));
  v = outset * v;
  return pow(clamp(v, vec3f(0.0), vec3f(1.0)), vec3f(2.2));
}
fn srgbOetf(c: vec3f) -> vec3f {
  return select(1.055 * pow(c, vec3f(1.0 / 2.4)) - 0.055, c * 12.92, c <= vec3f(0.0031308));
}
fn compress(c: vec3f) -> vec3f { return c / (1.0 + max(c.r, max(c.g, c.b))); }
fn expand(c: vec3f) -> vec3f { return c / max(1.0 - max(c.r, max(c.g, c.b)), 1e-4); }

@fragment fn fs(in: FullscreenOut) -> @location(0) vec4f {
  let size = vec2i(textureDimensions(sceneTex));
  let ip = clamp(vec2i(in.uv * vec2f(size)), vec2i(0), size - 1);
  var c = textureLoad(sceneTex, ip, 0).rgb;
  if (tm.params.y > 0.0) {
    // RCAS (FSR 1) on a reversibly compressed signal.
    let e = compress(c);
    let b = compress(textureLoad(sceneTex, clamp(ip + vec2i(0, -1), vec2i(0), size - 1), 0).rgb);
    let d = compress(textureLoad(sceneTex, clamp(ip + vec2i(-1, 0), vec2i(0), size - 1), 0).rgb);
    let f = compress(textureLoad(sceneTex, clamp(ip + vec2i(1, 0), vec2i(0), size - 1), 0).rgb);
    let h = compress(textureLoad(sceneTex, clamp(ip + vec2i(0, 1), vec2i(0), size - 1), 0).rgb);
    let mn = min(min(b, d), min(f, h));
    let mx = max(max(b, d), max(f, h));
    let hitMin = mn / max(4.0 * mx, vec3f(1e-5));
    let hitMax = (vec3f(1.0) - mx) / min(4.0 * mn - 4.0, vec3f(-1e-5));
    let lobeRgb = max(-hitMin, hitMax);
    let lobe = max(-0.1875, min(max(lobeRgb.r, max(lobeRgb.g, lobeRgb.b)), 0.0)) * tm.params.y;
    c = expand(clamp((lobe * (b + d + f + h) + e) / (4.0 * lobe + 1.0), vec3f(0.0), vec3f(0.9999)));
  }
  let bloom = textureSampleLevel(bloomTex, linearClamp, in.uv, 0.0).rgb;
  c = mix(c, bloom, tm.params.x);
  var o = srgbOetf(agx(c));
  let n = blueNoise(vec2u(in.position.xy));
  o += vec3f((n.x + n.y - 1.0) * tm.params.z / 255.0);
  return vec4f(o, 1.0);
}
`;

export class Tonemap {
  private readonly layout: GPUBindGroupLayout;
  private readonly pipeline: Tracked<GPURenderPipeline>;
  private readonly uniform: GPUBuffer;
  private group: GPUBindGroup | null = null;
  private scene: GPUTextureView | null = null;
  private bloom: GPUTextureView | null = null;

  constructor(
    private readonly ctx: RenderContext,
    shaders: CoreShaderLibrary,
  ) {
    const device = ctx.device;
    this.layout = device.createBindGroupLayout({
      label: 'tonemap',
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
      ],
    });
    this.uniform = device.createBuffer({ label: 'tonemap', size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.pipeline = shaders.tracked(() => {
      const module = shaders.createModule('core.tonemap', TONEMAP_FS);
      return device.createRenderPipeline({
        label: 'core.tonemap',
        layout: device.createPipelineLayout({ bindGroupLayouts: [ctx.frameBindGroupLayout, this.layout] }),
        vertex: { module, entryPoint: 'fullscreenVs' },
        fragment: { module, entryPoint: 'fs', targets: [{ format: ctx.canvasFormat }] },
      });
    });
  }

  warm(): void {
    this.pipeline.get();
  }

  /** `scene`: pre-exposed linear image at any resolution; `bloom`: blurred image to mix in (or a black texture). */
  draw(pass: GPURenderPassEncoder, scene: GPUTextureView, bloom: GPUTextureView, params: { bloomMix: number; sharpness: number; dither: number }): void {
    const device = this.ctx.device;
    device.queue.writeBuffer(this.uniform, 0, new Float32Array([params.bloomMix, params.sharpness, params.dither, 0]));
    if (!this.group || this.scene !== scene || this.bloom !== bloom) {
      this.scene = scene;
      this.bloom = bloom;
      this.group = device.createBindGroup({
        label: 'tonemap',
        layout: this.layout,
        entries: [
          { binding: 0, resource: { buffer: this.uniform } },
          { binding: 1, resource: scene },
          { binding: 2, resource: bloom },
        ],
      });
    }
    pass.setPipeline(this.pipeline.get());
    pass.setBindGroup(1, this.group);
    pass.draw(3);
  }
}
