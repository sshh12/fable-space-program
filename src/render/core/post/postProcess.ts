/**
 * Temporal anti-aliasing / upscaling (TAAU) and bloom.
 *
 * TAA resolves at DISPLAY resolution from the jittered internal-resolution HDR target: jitter-aware
 * 3 x 3 reconstruction, closest-depth velocity dilation, 5-tap Catmull-Rom history, YCoCg variance
 * clipping, luminance-weighted blend. Inputs and history are sanitised (NaN / Inf -> 0, clamp to HDR_MAX).
 * RCAS sharpening happens in the tonemap pass. Bloom is threshold-free and linear: 13-tap downsamples,
 * 9-tap tent upsamples blended level by level, mixed into the image at 4 % by the tonemapper.
 *
 * Shape of the bloom (request atmosphere-clouds-7). The chain is a glare spread function: of the energy it
 * spreads, each level twice as wide carries BLOOM_FALLOFF (half) of the one before, the widest included,
 * which is a point spread falling with about the third power of the distance, as the veiling glare of a
 * lens does: a saturated source keeps a small clipped core with a tight veil around it and no plateau. The
 * widths are fixed in ANGLE (fractions of the frame height), not in pixels: the levels are counted from a
 * frame 720 pixels high, a higher frame gets more levels (bloomLevelCount) and its finest ones carry less.
 *
 * Energy of saturated sources (ARCHITECTURE 10.4: the sun disc at HDR_MAX still drives bloom). The spatial
 * reconstruction of the resolve and the whole bloom chain are LINEAR, so a source of a pixel or two (the
 * sun at a wide field of view, a glint) keeps its energy. Only the temporal blend runs in the reversible
 * tonemap space: that is where fireflies are rejected (a value that is bright in one jittered frame and
 * dark in the others converges towards the dark ones), and a pixel that is bright in every frame is not
 * touched by it. Averaging the 3 x 3 taps in that space instead let a single dark tap of 0.7 % weight pull
 * a 60,000 tap down to about 140, and a Karis average on the first bloom level clamped whatever was left
 * of an isolated source to about 1.
 */
import type { FrameContext, RenderContext } from '@/core/contracts/render';
import type { CoreApi } from '../coreApi';
import type { Perf } from '../perf';
import type { CoreShaderLibrary, Tracked } from '../shaders/library';
import { createTextureChecked } from '../util/gpu';

export interface PostInputs {
  hdr: GPUTextureView;
  velocity: GPUTextureView;
  depth: GPUTextureView;
  /** True when the history is invalid (first frame, resize, mode switch). */
  reset: boolean;
  /** Multiplier on the history weight (0.5 under fast view rotation or high time warp). */
  historyScale: number;
  /** This frame's exposure over the previous frame's: the history is pre-exposed with the old one. */
  exposureRatio: number;
  /** 'post.reactive' (r8unorm): the history weight of a pixel is multiplied by 1 - value. */
  reactive: GPUTextureView;
}
export interface PostOutputs {
  color: GPUTextureView;
  bloom: GPUTextureView;
  bloomMix: number;
  sharpness: number;
}

/** Levels of the bloom chain for a frame BLOOM_REFERENCE_HEIGHT pixels high (level l is blurred over about 2^(l+1) of its pixels). */
export const BLOOM_LEVELS = 6;
export const BLOOM_REFERENCE_HEIGHT = 720;
/** Share of the bloom's energy at a level, relative to the level half as wide. */
export const BLOOM_FALLOFF = 0.5;
export const BLOOM_MIX = 0.04;

/** Levels of the chain for a display `height` pixels high: the widest level keeps its size relative to the frame. */
export function bloomLevelCount(height: number): number {
  return Math.max(3, Math.min(9, BLOOM_LEVELS + Math.round(Math.log2(Math.max(height, 1) / BLOOM_REFERENCE_HEIGHT))));
}

/**
 * The bloom's distribution over its levels for a display `height` pixels high: `weights[l]` = share of the
 * spread energy at level l (sum 1), `blend[l]` = the up pass's mix factor at level l (the share of
 * everything wider than l in everything from l on; none for the widest level). A level as wide, relative
 * to the frame, as level k of the reference frame carries (1 - f) / (1 - f^BLOOM_LEVELS) x f^k with f =
 * BLOOM_FALLOFF; the finest level takes what is left (nothing when the frame is a power of two times the
 * reference: its levels then are the reference's, one step wider each).
 */
export function bloomWeights(height: number): { weights: number[]; blend: number[] } {
  const n = bloomLevelCount(height);
  const shift = Math.log2(Math.max(height, 1) / BLOOM_REFERENCE_HEIGHT);
  const a = (1 - BLOOM_FALLOFF) / (1 - BLOOM_FALLOFF ** BLOOM_LEVELS);
  const weights = new Array<number>(n).fill(0);
  let rest = 1;
  for (let l = n - 1; l >= 1; l--) {
    weights[l] = Math.min(rest, a * BLOOM_FALLOFF ** (l - shift));
    rest -= weights[l]!;
  }
  weights[0] = Math.max(0, rest);
  const blend = new Array<number>(n - 1).fill(0);
  let wider = 0;
  for (let l = n - 1; l >= 0; l--) {
    const from = wider + weights[l]!;
    if (l < n - 1) blend[l] = from > 0 ? wider / from : 0;
    wider = from;
  }
  return { weights, blend };
}
export const TAA_HISTORY_WEIGHT = 0.9;
export const RCAS_SHARPNESS = 0.87; // exp2(-0.2): the FSR "0.2 stops" setting

const TAA_FS = /* wgsl */ `
struct TaaUniforms { v: vec4f }   // x = 1 when the history is invalid, y = history weight, z = exposure now / exposure of the history
@group(1) @binding(0) var<uniform> taa: TaaUniforms;
@group(1) @binding(5) var reactiveTex: texture_2d<f32>;
@group(1) @binding(1) var hdrTex: texture_2d<f32>;
@group(1) @binding(2) var velocityTex: texture_2d<f32>;
@group(1) @binding(3) var depthTex: texture_depth_2d;
@group(1) @binding(4) var historyTex: texture_2d<f32>;

fn toYcocg(c: vec3f) -> vec3f { return vec3f(0.25 * c.r + 0.5 * c.g + 0.25 * c.b, 0.5 * c.r - 0.5 * c.b, -0.25 * c.r + 0.5 * c.g - 0.25 * c.b); }
fn fromYcocg(c: vec3f) -> vec3f { return vec3f(c.x + c.y - c.z, c.x + c.z, c.x - c.y - c.z); }
// Reversible tonemap: the space of the variance clip and of the temporal blend (never of a spatial average).
fn squash(c: vec3f) -> vec3f { return c / (1.0 + luminance(c)); }
fn unsquash(c: vec3f) -> vec3f { return c / max(1.0 - luminance(c), 1e-5); }

// The history was written with the previous frame's exposure: bring it to this frame's before anything else.
fn historyTap(uv: vec2f) -> vec3f { return squash(writeHdr(textureSampleLevel(historyTex, linearClamp, uv, 0.0).rgb * taa.v.z)); }
/// 5-tap Catmull-Rom (the four corner taps of the 9-tap bilinear form are dropped).
fn historyCatmullRom(uv: vec2f) -> vec3f {
  let size = vec2f(textureDimensions(historyTex));
  let pos = uv * size;
  let tc1 = floor(pos - 0.5) + 0.5;
  let f = pos - tc1;
  let w0 = f * (-0.5 + f * (1.0 - 0.5 * f));
  let w1 = 1.0 + f * f * (-2.5 + 1.5 * f);
  let w2 = f * (0.5 + f * (2.0 - 1.5 * f));
  let w3 = f * f * (-0.5 + 0.5 * f);
  let w12 = w1 + w2;
  let tc0 = (tc1 - 1.0) / size;
  let tc3 = (tc1 + 2.0) / size;
  let tc12 = (tc1 + w2 / w12) / size;
  let wa = w12.x * w0.y;
  let wb = w0.x * w12.y;
  let wc = w12.x * w12.y;
  let wd = w3.x * w12.y;
  let we = w12.x * w3.y;
  let c = historyTap(vec2f(tc12.x, tc0.y)) * wa + historyTap(vec2f(tc0.x, tc12.y)) * wb + historyTap(tc12) * wc
        + historyTap(vec2f(tc3.x, tc12.y)) * wd + historyTap(vec2f(tc12.x, tc3.y)) * we;
  return max(c / (wa + wb + wc + wd + we), vec3f(0.0));
}

@fragment fn fs(in: FullscreenOut) -> @location(0) vec4f {
  let rs = vec2i(frame.renderSize.xy);
  // This output pixel in render-pixel coordinates. A render pixel with centre c shows the scene point that
  // sits at c - jitter on the unjittered screen, so the nearest input sample to p is at floor(p + jitter).
  let p = in.uv * frame.renderSize.xy;
  let base = vec2i(floor(p + frame.jitter.xy));

  var sumLinear = vec3f(0.0);
  var wsum = 0.0;
  // Moments of the squashed taps are taken about the centre tap. Near saturation the taps differ from 1 by
  // 1e-5, and m2 / 9 - mean^2 of such values is float32 noise: a box 4e-4 wide, i.e. "anything above 2,400".
  let pivot = toYcocg(squash(writeHdr(textureLoad(hdrTex, clamp(base, vec2i(0), rs - 1), 0).rgb)));
  var m1 = vec3f(0.0);
  var m2 = vec3f(0.0);
  var tapMin = pivot;
  var tapMax = pivot;
  var closest = 0.0;
  var closestAt = base;
  var wCentre = 0.0;
  for (var j = -1; j <= 1; j++) {
    for (var i = -1; i <= 1; i++) {
      let q = clamp(base + vec2i(i, j), vec2i(0), rs - 1);
      let texel = writeHdr(textureLoad(hdrTex, q, 0).rgb);
      let c = squash(texel);
      // Distance from the output pixel centre to this sample's true position, in render pixels.
      let d = (vec2f(q) + 0.5 - frame.jitter.xy) - p;
      let w = exp(-2.29 * dot(d, d));
      sumLinear += texel * w;
      wsum += w;
      if (i == 0 && j == 0) { wCentre = w; }
      let y = toYcocg(c);
      m1 += y - pivot;
      m2 += (y - pivot) * (y - pivot);
      tapMin = min(tapMin, y);
      tapMax = max(tapMax, y);
      let dz = textureLoad(depthTex, q, 0);
      if (dz > closest) { closest = dz; closestAt = q; }
    }
  }
  // Linear (energy-conserving) reconstruction of this frame; squashed only for the temporal blend below.
  let colour = squash(sumLinear / wsum);
  let meanRel = m1 / 9.0;
  let mean = pivot + meanRel;
  let sigma = sqrt(max(m2 / 9.0 - meanRel * meanRel, vec3f(0.0)));

  // Velocity of the closest surface in the neighbourhood (keeps silhouettes of moving objects sharp).
  var velocity = textureLoad(velocityTex, closestAt, 0).xy;
  if (closest == 0.0) {
    // Sky: no geometry wrote a velocity; reproject the view direction (camera rotation only).
    let ndc = vec2f(in.uv.x * 2.0 - 1.0, 1.0 - in.uv.y * 2.0);
    let dir = frame.cameraForward.xyz + frame.cameraRight.xyz * (ndc.x * frame.cameraRight.w) + frame.cameraUp.xyz * (ndc.y * frame.cameraUp.w);
    let prev = frame.prevViewProj * vec4f(dir, 0.0);
    velocity = select(vec2f(0.0), (ndc - prev.xy / prev.w) * vec2f(0.5, -0.5), prev.w > 1e-6);
  }
  let prevUv = in.uv - velocity;
  let speedPx = length(velocity * frame.displaySize.xy);

  var weight = taa.v.y * (1.0 - taa.v.x);
  if (prevUv.x <= 0.0 || prevUv.y <= 0.0 || prevUv.x >= 1.0 || prevUv.y >= 1.0) { weight = 0.0; }
  var result = colour;
  if (weight > 0.0) {
    var h = toYcocg(historyCatmullRom(prevUv));
    // Variance clip towards the neighbourhood mean (wider box when static: less flicker on thin features).
    let gamma = mix(1.25, 1.0, saturate(speedPx * 0.5));
    var lo = mean - sigma * gamma;
    var hi = mean + sigma * gamma;
    // Where the neighbourhood holds very bright taps (above about 10 x white) the box is widened to the
    // range of the taps. In the squashed space every such tap sits just below 1, so a source of a few
    // pixels has a neighbourhood mean far below its own value, and the variance box would cut its history
    // down to about 10 in every frame in which the jitter leaves it three bright taps or fewer. Nothing is
    // lost for ghosting: a bright history over a pixel that has gone dark fades within a few frames
    // anyway, because the blend below weights dark values up.
    let bright = smoothstep(0.75, 0.95, tapMax.x);
    lo = mix(lo, min(lo, tapMin), bright);
    hi = mix(hi, max(hi, tapMax), bright);
    let centre = 0.5 * (lo + hi);
    let extent = 0.5 * (hi - lo) + vec3f(1e-5);
    let off = h - centre;
    let unit = abs(off / extent);
    let k = max(unit.x, max(unit.y, unit.z));
    if (k > 1.0) { h = centre + off / k; }
    let hist = fromYcocg(h);
    // When upscaling, an output pixel far from this frame's nearest sample trusts the history more.
    let fresh = mix(0.35, 1.0, saturate(wCentre * 1.6));
    weight = clamp(1.0 - (1.0 - weight) * fresh, 0.0, 0.98) * mix(1.0, 0.85, saturate(speedPx / 24.0));
    // A feature may ask for less history where its pattern has no motion vector ('post.reactive').
    weight *= 1.0 - saturate(textureSampleLevel(reactiveTex, linearClamp, in.uv, 0.0).r);
    result = mix(colour, hist, weight);
  }
  return vec4f(writeHdr(unsquash(max(result, vec3f(0.0)))), 1.0);
}
`;

const BLOOM_DOWN_FS = /* wgsl */ `
@group(1) @binding(0) var srcTex: texture_2d<f32>;
fn tap(uv: vec2f) -> vec3f { return writeHdr(textureSampleLevel(srcTex, linearClamp, uv, 0.0).rgb); }
@fragment fn fs(in: FullscreenOut) -> @location(0) vec4f {
  let t = 1.0 / vec2f(textureDimensions(srcTex));
  let uv = in.uv;
  // 13-tap downsample (Jimenez, Call of Duty: Advanced Warfare): five overlapping 2 x 2 boxes, with linear
  // weights on every level. No Karis average: it clamps an isolated saturated source (a small sun disc, a
  // glint) to about 1; fireflies are rejected by the temporal blend of the resolve instead.
  let a = tap(uv + t * vec2f(-2.0, -2.0)); let b = tap(uv + t * vec2f(0.0, -2.0)); let c = tap(uv + t * vec2f(2.0, -2.0));
  let d = tap(uv + t * vec2f(-2.0, 0.0));  let e = tap(uv);                          let f = tap(uv + t * vec2f(2.0, 0.0));
  let g = tap(uv + t * vec2f(-2.0, 2.0));  let h = tap(uv + t * vec2f(0.0, 2.0));    let i = tap(uv + t * vec2f(2.0, 2.0));
  let j = tap(uv + t * vec2f(-1.0, -1.0)); let k = tap(uv + t * vec2f(1.0, -1.0));
  let l = tap(uv + t * vec2f(-1.0, 1.0));  let m = tap(uv + t * vec2f(1.0, 1.0));
  return vec4f(e * 0.125 + (a + c + g + i) * 0.03125 + (b + d + f + h) * 0.0625 + (j + k + l + m) * 0.125, 1.0);
}
`;

const BLOOM_UP_FS = /* wgsl */ `
@group(1) @binding(0) var lowTex: texture_2d<f32>;    // the coarser, already blurred level
@group(1) @binding(1) var highTex: texture_2d<f32>;   // this level's downsample
@group(1) @binding(2) var<uniform> up: vec4f;         // x = share of the wider levels in the result (bloomWeights().blend)
@fragment fn fs(in: FullscreenOut) -> @location(0) vec4f {
  let t = 1.0 / vec2f(textureDimensions(lowTex));
  let uv = in.uv;
  // 9-tap upsample: the centre and eight bilinear taps on a circle of 1.25 texels (weights of the 3 x 3 tent,
  // but isotropic, so a saturated point source blooms round instead of square).
  var s = textureSampleLevel(lowTex, linearClamp, uv, 0.0).rgb * 4.0;
  for (var k = 0; k < 8; k++) {
    let a = f32(k) * 0.78539816;
    let w = select(1.0, 2.0, (k & 1) == 0);
    s += textureSampleLevel(lowTex, linearClamp, uv + t * vec2f(cos(a), sin(a)) * 1.25, 0.0).rgb * w;
  }
  let high = textureSampleLevel(highTex, linearClamp, uv, 0.0).rgb;
  // Convex blend: the chain conserves energy; each wider level carries half of the one before.
  return vec4f(mix(high, s / 16.0, up.x), 1.0);
}
`;

export class PostProcess {
  /** The projection is jittered: temporal anti-aliasing is active. */
  readonly temporal = true;
  private readonly device: GPUDevice;
  private readonly bloomFormat: GPUTextureFormat;
  private readonly taaLayout: GPUBindGroupLayout;
  private readonly downLayout: GPUBindGroupLayout;
  private readonly upLayout: GPUBindGroupLayout;
  private readonly taaPipeline: Tracked<GPURenderPipeline>;
  private readonly downPipeline: Tracked<GPURenderPipeline>;
  private readonly upPipeline: Tracked<GPURenderPipeline>;
  private readonly taaUniform: GPUBuffer;
  private history: GPUTexture[] = [];
  private historyViews: GPUTextureView[] = [];
  private down: GPUTexture[] = [];
  private up: GPUTexture[] = [];
  private downViews: GPUTextureView[] = [];
  private upViews: GPUTextureView[] = [];
  private downGroups: GPUBindGroup[] = [];
  private upGroups: GPUBindGroup[] = [];
  private upUniforms: GPUBuffer[] = [];
  private levels = BLOOM_LEVELS;
  private taaGroups: (GPUBindGroup | null)[] = [null, null];
  private taaInputs: PostInputs | null = null;
  private current = 0;
  private width = 0;
  private height = 0;

  constructor(
    private readonly ctx: RenderContext,
    _shaders: CoreShaderLibrary,
    private readonly core: CoreApi,
    rg11b10: boolean,
  ) {
    const device = (this.device = ctx.device);
    this.bloomFormat = rg11b10 ? 'rg11b10ufloat' : 'rgba16float';
    const tex = (binding: number, sampleType: GPUTextureSampleType = 'float'): GPUBindGroupLayoutEntry => ({ binding, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType } });
    const ubo = (binding: number): GPUBindGroupLayoutEntry => ({ binding, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } });
    this.taaLayout = device.createBindGroupLayout({ label: 'core.taa', entries: [ubo(0), tex(1), tex(2), tex(3, 'depth'), tex(4), tex(5)] });
    this.downLayout = device.createBindGroupLayout({ label: 'core.bloomDown', entries: [tex(0)] });
    this.upLayout = device.createBindGroupLayout({ label: 'core.bloomUp', entries: [tex(0), tex(1), ubo(2)] });
    this.taaPipeline = core.fullscreenPipeline({ label: 'core.taa', fragment: TAA_FS, layouts: [this.taaLayout], targets: [{ format: 'rgba16float' }] });
    this.downPipeline = core.fullscreenPipeline({ label: 'core.bloomDown', fragment: BLOOM_DOWN_FS, layouts: [this.downLayout], targets: [{ format: this.bloomFormat }] });
    this.upPipeline = core.fullscreenPipeline({ label: 'core.bloomUp', fragment: BLOOM_UP_FS, layouts: [this.upLayout], targets: [{ format: this.bloomFormat }] });
    this.taaUniform = device.createBuffer({ label: 'core.taa', size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  }

  warm(): void {
    this.taaPipeline.get();
    this.downPipeline.get();
    this.upPipeline.get();
  }

  /** (Re)allocate the display-resolution history and the bloom chain. */
  resize(w: number, h: number): void {
    if (w === this.width && h === this.height) return;
    this.width = w;
    this.height = h;
    for (const t of [...this.history, ...this.down, ...this.up, ...this.upUniforms]) t.destroy();
    const usage = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC;
    const make = (label: string, format: GPUTextureFormat, tw: number, th: number): GPUTexture =>
      createTextureChecked(this.device, { label, format, size: [Math.max(1, tw), Math.max(1, th)], usage }, this.core.reportError);
    this.history = [0, 1].map((i) => make(`core.taaHistory${i}`, 'rgba16float', w, h));
    this.historyViews = this.history.map((t) => t.createView());
    this.down = [];
    this.up = [];
    this.upUniforms = [];
    this.levels = bloomLevelCount(h);
    const { blend } = bloomWeights(h);
    for (let l = 0; l < this.levels; l++) {
      const tw = Math.ceil(w / 2 ** (l + 1));
      const th = Math.ceil(h / 2 ** (l + 1));
      this.down.push(make(`core.bloomDown${l}`, this.bloomFormat, tw, th));
      if (l < this.levels - 1) {
        this.up.push(make(`core.bloomUp${l}`, this.bloomFormat, tw, th));
        const u = this.device.createBuffer({ label: `core.bloomUp${l}`, size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
        this.device.queue.writeBuffer(u, 0, new Float32Array([blend[l]!, 0, 0, 0]));
        this.upUniforms.push(u);
      }
    }
    this.downViews = this.down.map((t) => t.createView());
    this.upViews = this.up.map((t) => t.createView());
    this.downGroups = [];
    this.upGroups = [];
    this.taaGroups = [null, null];
    this.taaInputs = null;
  }

  /** The texture holding the resolved image of the last frame (display resolution, pre-exposed). */
  resolvedTexture(): GPUTexture | null {
    return this.history[this.current] ?? null;
  }

  run(encoder: GPUCommandEncoder, _frame: FrameContext, perf: Perf, frameGroup: GPUBindGroup, inputs: PostInputs): PostOutputs {
    const device = this.device;
    const prev = this.current;
    const cur = 1 - prev;
    this.current = cur;
    const t = this.taaInputs;
    if (!t || t.hdr !== inputs.hdr || t.velocity !== inputs.velocity || t.depth !== inputs.depth || t.reactive !== inputs.reactive) {
      this.taaInputs = inputs;
      this.taaGroups = [null, null];
    }
    // Group i reads history i (the previous frame) while rendering into the other one.
    this.taaGroups[prev] ??= device.createBindGroup({
      label: 'core.taa',
      layout: this.taaLayout,
      entries: [
        { binding: 0, resource: { buffer: this.taaUniform } },
        { binding: 1, resource: inputs.hdr },
        { binding: 2, resource: inputs.velocity },
        { binding: 3, resource: inputs.depth },
        { binding: 4, resource: this.historyViews[prev]! },
        { binding: 5, resource: inputs.reactive },
      ],
    });
    device.queue.writeBuffer(this.taaUniform, 0, new Float32Array([inputs.reset ? 1 : 0, TAA_HISTORY_WEIGHT * inputs.historyScale, inputs.exposureRatio, 0]));
    {
      const pass = encoder.beginRenderPass({ label: 'taa', colorAttachments: [{ view: this.historyViews[cur]!, loadOp: 'clear', storeOp: 'store' }], timestampWrites: perf.gpuPass('core.taa') });
      pass.setBindGroup(0, frameGroup);
      pass.setPipeline(this.taaPipeline.get());
      pass.setBindGroup(1, this.taaGroups[prev]!);
      pass.draw(3);
      pass.end();
    }

    // Bloom chain from the resolved image. The first downsample reads the history texture that was just written.
    const resolved = this.historyViews[cur]!;
    const levels = this.levels;
    for (let l = 0; l < levels; l++) {
      const key = l === 0 ? cur : 2 + l;
      this.downGroups[key] ??= device.createBindGroup({
        label: `core.bloomDown${l}`,
        layout: this.downLayout,
        entries: [{ binding: 0, resource: l === 0 ? resolved : this.downViews[l - 1]! }],
      });
      const pass = encoder.beginRenderPass({ label: `bloomDown${l}`, colorAttachments: [{ view: this.downViews[l]!, loadOp: 'clear', storeOp: 'store' }], timestampWrites: perf.gpuPass('core.bloom') });
      pass.setBindGroup(0, frameGroup);
      pass.setPipeline(this.downPipeline.get());
      pass.setBindGroup(1, this.downGroups[key]!);
      pass.draw(3);
      pass.end();
    }
    for (let l = levels - 2; l >= 0; l--) {
      this.upGroups[l] ??= device.createBindGroup({
        label: `core.bloomUp${l}`,
        layout: this.upLayout,
        entries: [
          { binding: 0, resource: l === levels - 2 ? this.downViews[l + 1]! : this.upViews[l + 1]! },
          { binding: 1, resource: this.downViews[l]! },
          { binding: 2, resource: { buffer: this.upUniforms[l]! } },
        ],
      });
      const pass = encoder.beginRenderPass({ label: `bloomUp${l}`, colorAttachments: [{ view: this.upViews[l]!, loadOp: 'clear', storeOp: 'store' }], timestampWrites: perf.gpuPass('core.bloom') });
      pass.setBindGroup(0, frameGroup);
      pass.setPipeline(this.upPipeline.get());
      pass.setBindGroup(1, this.upGroups[l]!);
      pass.draw(3);
      pass.end();
    }
    return { color: resolved, bloom: this.upViews[0]!, bloomMix: BLOOM_MIX, sharpness: RCAS_SHARPNESS };
  }
}
