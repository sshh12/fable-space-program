/**
 * Final pass to the canvas: RCAS sharpening of the resolved image, bloom mix, AgX tonemap with a mild
 * "punchy" look and a linear, hue-preserving toe, sRGB OETF and triangular blue-noise dither. The LDR overlay
 * hooks draw into the same canvas attachment afterwards.
 */
import type { RenderContext } from '@/core/contracts/render';
import type { CoreShaderLibrary, Tracked } from '../shaders/library';

// --------------------------------------------------------------------------- the display transform on the CPU
// The same arithmetic as the WGSL below, for the unit tests and for the constant of the toe.

type Rgb = readonly [number, number, number];
const AGX_INSET: readonly Rgb[] = [
  [0.842479062253094, 0.0784335999999992, 0.0792237451477643],
  [0.0423282422610123, 0.878468636469772, 0.0791661274605434],
  [0.0423756549057051, 0.0784336, 0.879142973793104],
];
const AGX_OUTSET: readonly Rgb[] = [
  [1.19687900512017, -0.0980208811401368, -0.0990297440797205],
  [-0.0528968517574562, 1.15190312990417, -0.0989611768448433],
  [-0.0529716355144438, -0.0980434501171241, 1.15107367264116],
];
const AGX_MIN_EV = -12.47393;
const AGX_MAX_EV = 4.026069;
const mul = (m: readonly Rgb[], v: Rgb): [number, number, number] => [m[0]![0] * v[0] + m[0]![1] * v[1] + m[0]![2] * v[2], m[1]![0] * v[0] + m[1]![1] * v[1] + m[1]![2] * v[2], m[2]![0] * v[0] + m[2]![1] * v[1] + m[2]![2] * v[2]];
const agxContrast = (x: number): number => {
  const x2 = x * x;
  const x4 = x2 * x2;
  return 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4 - 6.868 * x2 * x + 0.4298 * x2 + 0.1191 * x - 0.00232;
};
const luma = (c: Rgb): number => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];

/** AgX with the pass's look: pre-exposed scene-linear sRGB -> display-linear sRGB (before the OETF). */
export function agxDisplayLinear(c: Rgb): [number, number, number] {
  let v = mul(AGX_INSET, [Math.max(c[0], 0), Math.max(c[1], 0), Math.max(c[2], 0)]);
  v = v.map((x) => agxContrast((Math.min(Math.max(Math.log2(Math.max(x, 1e-10)), AGX_MIN_EV), AGX_MAX_EV) - AGX_MIN_EV) / (AGX_MAX_EV - AGX_MIN_EV))) as [number, number, number];
  v = v.map((x) => Math.max(x, 0) ** 1.12) as [number, number, number];
  const l = luma(v);
  v = mul(AGX_OUTSET, [l + 1.15 * (v[0] - l), l + 1.15 * (v[1] - l), l + 1.15 * (v[2] - l)]);
  return v.map((x) => Math.min(Math.max(x, 0), 1) ** 2.2) as [number, number, number];
}

/**
 * The toe of the display transform (request sky-lighting-3). From TOE_START_STOPS under mid-grey upwards the
 * image is AgX alone. From TOE_FULL_STOPS downwards the display follows the scene: display-linear =
 * TOE_GAIN x scene-linear, applied to the colour as a whole, so a dim colour keeps its hue and a smooth
 * falloff never meets black at a visible slope (the sigmoid's foot falls 26 times while the scene falls 5.7
 * times between 3.5 and 6 stops under mid-grey, and it does so per channel: a warm grey turns rust-brown
 * as it dims). Between the two, by the scene's luminance, a smoothstep in stops. TOE_GAIN is what AgX gives
 * a grey in the middle of that span, so the two branches cross there and the blend stays monotonic.
 *
 * The span is five stops wide (request sky-lighting-7). AgX's log-log slope at the join is 1.5 to 1.9 and
 * the toe's is 1: joined over one stop (-3 to -4, as first built) the display contrast of every smooth
 * gradient fell by 40 % within half a stop, always at the same display level (21 -> 16.5 of 255), and a
 * glare, a terminator or a twilight sky that crossed that level showed a contour there. Over five stops the
 * slope changes by 0.12 per quarter stop at most. The middle of the span, and with it TOE_GAIN and the
 * toe's line, are where they were (-3.5 stops); a grey moves by 1.8 of 255 at most.
 */
export const TOE_START_STOPS = -1;
export const TOE_FULL_STOPS = -6;
const TOE_MID_GREY = 0.18;
const toeJoin = TOE_MID_GREY * 2 ** (0.5 * (TOE_START_STOPS + TOE_FULL_STOPS));
export const TOE_GAIN = agxDisplayLinear([toeJoin, toeJoin, toeJoin])[1] / toeJoin;

/** The whole display transform of the tonemap pass: pre-exposed scene-linear sRGB -> display-linear sRGB. */
export function displayLinear(c: Rgb): [number, number, number] {
  const p: Rgb = [Math.max(c[0], 0), Math.max(c[1], 0), Math.max(c[2], 0)];
  const a = agxDisplayLinear(p);
  const stops = Math.log2(Math.max(luma(p), 1e-10) / TOE_MID_GREY);
  const t = Math.min(Math.max((stops - TOE_FULL_STOPS) / (TOE_START_STOPS - TOE_FULL_STOPS), 0), 1);
  const w = 1 - t * t * (3 - 2 * t);
  return [a[0] + (TOE_GAIN * p[0] - a[0]) * w, a[1] + (TOE_GAIN * p[1] - a[1]) * w, a[2] + (TOE_GAIN * p[2] - a[2]) * w];
}

/** sRGB OETF of one channel, 0..1. */
export const srgbEncode = (x: number): number => (x <= 0.0031308 ? x * 12.92 : 1.055 * x ** (1 / 2.4) - 0.055);

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
/// AgX from ${-TOE_START_STOPS} stops under mid-grey upwards; from ${-TOE_FULL_STOPS} stops under it downwards the display follows the
/// scene (one gain on the whole colour: hue kept, no foot); a smoothstep in stops of scene luminance between.
fn displayTransform(c: vec3f) -> vec3f {
  let p = max(c, vec3f(0.0));
  let a = agx(p);
  let stops = log2(max(dot(p, vec3f(0.2126, 0.7152, 0.0722)), 1e-10) / ${TOE_MID_GREY});
  let w = 1.0 - smoothstep(${TOE_FULL_STOPS.toFixed(1)}, ${TOE_START_STOPS.toFixed(1)}, stops);
  return mix(a, ${TOE_GAIN.toFixed(9)} * p, w);
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
  var o = srgbOetf(displayTransform(c));
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

  /** The stage's tracked pipelines, for `shaders.warm`. */
  pipelines(): Tracked<unknown>[] {
    return [this.pipeline];
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
