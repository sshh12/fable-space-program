/**
 * Screen-space ambient occlusion (GTAO: 2 slices x 6 steps per side, cosine-weighted horizon integral)
 * and contact shadows towards the sun (a depth march), both at half resolution in one pass.
 * Output: rg8unorm (r = ambient visibility, g = contact-shadow visibility) plus the reversed-Z depth each
 * half-resolution pixel was computed at, which the lighting pass uses for its depth-aware upsample.
 * The per-pixel rotation and step jitter come from the frame blue noise; TAA integrates it.
 *
 * The contact shadow (requests cockpit-10, vehicle-pad-10). A depth buffer says what is in FRONT of a point
 * of the ray, not whether the ray goes through it. The first rule of the march: a sample that lies behind
 * a surface by less than 0.6 x the march length is shadowed (10 samples). Far from the camera that stands.
 * Near it the rule draws what is not there: a ray that passes behind the silhouette of a wall is "inside"
 * it for 18 cm of depth (a band of false shadow beside every cast shadow, stippled because the 3 cm steps
 * jump over it or not), a thin rail shadows everything within 18 cm behind it, and a face seen at a grazing
 * angle shadows itself where the depth of the pixel beside it is taken for its own. The rules for the near
 * field (`ContactShadowParams`, within `nearRange` of the camera):
 *  - a surface point in the receiver's own tangent plane, or under it, is never in the way (`planeReject`);
 *  - where the ray goes behind a surface between two samples, the place is found by bisection and the depth
 *    by which it is behind THERE decides, not the depth at whichever sample the jitter gave (`refine`);
 *  - an occluder counts as `thicknessTexels` texels of the finest sun cascade thick (what the cascade cannot
 *    draw; the cascade draws the rest), and only if it touches the receiver (the ray is behind it within one
 *    thickness of its start: a contact line) or is thin (the ray is seen again within `thinFactor`
 *    thicknesses: a rail, a cable, a handle) (`thinOnly`);
 *  - the march takes `nearSteps` samples, so that a caster as thin as the step is not jumped over.
 *
 * Shaders: the one with the near field's rules is the pass (run 2026-11-12 17:00: the cockpit's and the
 * vehicle's frames, the core's suite); the first rule alone, the pass as it was to the letter, is kept for
 * A/B (`contact=first`); and a candidate with one more rule, `crossShare` (under `thinOnly`, an occluder
 * whose visible face the ray enters counts too), is compiled only by a page that asks for it (`contact=v5`).
 */
import type { FrameContext, RenderContext } from '@/core/contracts/render';
import type { CoreApi } from '../coreApi';
import type { Perf } from '../perf';
import type { CoreShaderLibrary, Tracked } from '../shaders/library';
import { createTextureChecked } from '../util/gpu';

/** The rules of the contact-shadow march (see the file comment). `CoreRenderer.setContactShadow` changes them. */
export interface ContactShadowParams {
  enabled: boolean;
  /** Near the camera: surface points in or under the receiver's tangent plane do not occlude. */
  planeReject: boolean;
  /** Near the camera: the place where the ray goes behind a surface is found by bisection. */
  refine: boolean;
  /** Near the camera: only occluders that touch the receiver or are thin count (implies `refine`). */
  thinOnly: boolean;
  /** Samples of the march within `nearRange` (beyond it: 10). */
  nearSteps: number;
  /** Distance from the camera within which the rules above apply, m (0 = nowhere: the first rule everywhere). */
  nearRange: number;
  /** Assumed thickness of an occluder near the camera, in texels of the finest sun cascade. */
  thicknessTexels: number;
  /** Distances between which that thickness gives way to 0.6 x the march length, m. */
  blendFrom: number;
  blendTo: number;
  /** A surface point occludes only if it stands over the receiver's plane by more than this share of the ray's own height there. */
  planeMargin: number;
  /** Pixels per texel of the finest cascade between which the contact shadow fades out (the cascade resolves the picture there); null = never. */
  fade: readonly [number, number] | null;
  /** The same for an interior camera. */
  interiorFade: readonly [number, number] | null;
  /** An occluder is thin when the ray is seen again within this many thicknesses. */
  thinFactor: number;
  /**
   * Candidate (shader `cross` only): under `thinOnly`, a ray that enters the visible face of an occluder (it
   * is behind the surface by less than this share of the thickness where it goes behind) is shadowed too,
   * however thick the occluder: the light leak of the cascades along a contact line. 0 = off.
   */
  crossShare: number;
}

/** Which shader the pass runs (see the file comment). */
export type ContactShader = 'first' | 'near' | 'cross';

/** The first rule everywhere: 10 samples, every sample on its own, 0.6 x the march length thick. */
export const CONTACT_SHADOW_LEGACY: ContactShadowParams = {
  enabled: true,
  planeReject: false,
  refine: false,
  thinOnly: false,
  nearSteps: 10,
  nearRange: 0,
  thicknessTexels: 2,
  blendFrom: 3,
  blendTo: 8,
  planeMargin: 0.5,
  fade: null,
  interiorFade: null,
  thinFactor: 2,
  crossShare: 0,
};

/**
 * The game's rules: the plane and the bisection, every occluder two texels thick. Chosen on the pictures of
 * 2026-11-12 17:00 (out/screens/integration/contact-*-sheet*.png): the stipple on a window well's floor
 * from the cabin is gone and its shadow edge is one clean line (4.4 % isolated dark pixels -> 0.00 %); the
 * band beside a grab rail from 2.5 m is 18.5 px wide instead of 22.5 and stands off the rail. `thinOnly`
 * makes that band a line (16 px), but lets the cascades' light leak through along the foot of a wall seen
 * from the cabin, so it waits for `crossShare`.
 */
export const CONTACT_SHADOW_DEFAULT: ContactShadowParams = {
  enabled: true,
  planeReject: true,
  refine: true,
  thinOnly: false,
  nearSteps: 20,
  nearRange: 8,
  thicknessTexels: 2,
  blendFrom: 3,
  blendTo: 8,
  planeMargin: 0.5,
  fade: null,
  interiorFade: null,
  thinFactor: 2,
  crossShare: 0,
};

/** Occluder thickness near the camera when no sun cascade exists (m). */
const CONTACT_THICKNESS_NO_CASCADE = 0.025;

const AO_HEAD = /* wgsl */ `
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
`;

/** Declarations of the near field's rules. */
const CONTACT_NEAR_DECLS = /* wgsl */ `
struct ContactParams {
  a: vec4f,   // x = rules near the camera (1 plane, 2 bisection, 4 thin or touching only), y = samples near the camera, z = how far "near" reaches (m), w = 0: no contact shadow
  b: vec4f,   // x = occluder thickness near the camera (m), y, z = distances between which it gives way to 0.6 x the march length (m), w = plane margin
  c: vec4f,   // x, y = pixels per texel of the finest cascade between which the contact shadow fades out, z = that texel (m), w = thin: seen again within this many thicknesses
}
@group(1) @binding(2) var<uniform> contactU: ContactParams;

/// One sample of the contact march against the depth buffer.
struct ContactTap {
  delta: f32,   // view depth by which the sample lies behind the surface drawn at its pixel (negative: in front of it)
  w: f32,       // the sample's view depth; 0 = off screen or behind the near plane (the march ends)
  h: f32,       // height of that surface point over the receiver's tangent plane (m)
}
fn contactTap(S: vec3f, P: vec3f, N: vec3f, size: vec2i) -> ContactTap {
  let c = projectToUv(S);
  if (c.w <= frame.cameraForward.w) { return ContactTap(0.0, 0.0, 0.0); }
  // Depth was rasterised with the jittered projection.
  let uv = c.xy + frame.jitter.zw * vec2f(0.5, -0.5);
  if (uv.x <= 0.0 || uv.y <= 0.0 || uv.x >= 1.0 || uv.y >= 1.0) { return ContactTap(0.0, 0.0, 0.0); }
  let ip = vec2i(uv * frame.renderSize.xy);
  let sd = loadDepth(ip, size);
  if (sd == 0.0) { return ContactTap(-1.0e9, c.w, 0.0); }
  return ContactTap(c.w - viewZFromDepth(sd), c.w, dot(posAt(ip, sd) - P, N));
}
/// Whether the sample is behind a surface that can be in the ray's way. 'hRay' is the smaller of the ray's
/// and the camera's height over the receiver's plane: a surface point between the camera and the sample
/// stands at least that high, a point of the receiver's own plane (found where the depth of a neighbouring
/// pixel is taken for the sample's, on a face seen at a grazing angle) stands at 0.
fn contactBehind(tap: ContactTap, hRay: f32, rules: u32, margin: f32) -> bool {
  if (tap.delta <= 0.002 * tap.w + 0.001) { return false; }
  if ((rules & 1u) != 0u && tap.h < margin * hRay) { return false; }
  return true;
}
`;

const AO_MAIN = /* wgsl */ `
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
`;

/** The march with its first rule alone, as it was. */
const CONTACT_FIRST = /* wgsl */ `
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
`;

/** The march with the near field's rules (with none of them set it is the first rule, sample for sample). */
const CONTACT_NEAR = /* wgsl */ `
  // Where one texel of the finest cascade covers many pixels, the cascade draws everything the picture can show.
  let strength = 1.0 - smoothstep(contactU.c.x, contactU.c.y, contactU.c.z * pxPerMetre);
  if (NoL > 0.0 && contactU.a.w > 0.5 && strength > 0.0) {
    let marchLen = max(0.3, 0.015 * dist);
    // The switch between the two sets of rules is dithered over 30 % of the distance.
    let nearField = dist < contactU.a.z * (0.85 + 0.3 * noise.y);
    let rules = select(0u, u32(contactU.a.x), nearField);
    let steps = select(CONTACT_STEPS, i32(contactU.a.y), nearField);
    let thickFar = marchLen * 0.6;
    let thickness = select(thickFar, mix(min(contactU.b.x, thickFar), thickFar, smoothstep(contactU.b.y, contactU.b.z, dist)), nearField);
    let lift = 0.0015 * viewZ + 0.002;
    let origin = P + N * lift;
    let hCam = dot(-P, N);
    let margin = contactU.b.w;
    var tPrev = 0.0;
    var front = true;        // the sample before was not behind a surface
    var thinUntil = -1.0;    // the ray went behind something that may be thin: shadowed if it is seen again before this
    for (var i = 0; i < steps; i++) {
      let t = marchLen * (f32(i) + noise.z) / f32(steps);
      let tap = contactTap(origin + L * t, P, N, size);
      if (tap.w == 0.0) { break; }
      let behind = contactBehind(tap, min(lift + t * NoL, hCam), rules, margin);
      if ((rules & 6u) == 0u) {
        // Every sample on its own: shadowed when it lies behind a surface by less than the thickness.
        if (behind && tap.delta < thickness) {
          contact = 0.0;
          break;
        }
      } else if (behind && front) {
        // The ray went behind a surface since the sample before: where, and by how much it is behind there.
        var lo = tPrev;
        var hi = t;
        var first = tap;
        for (var k = 0; k < 4; k++) {
          let mid = 0.5 * (lo + hi);
          let m = contactTap(origin + L * mid, P, N, size);
          if (m.w > 0.0 && contactBehind(m, min(lift + mid * NoL, hCam), rules, margin)) {
            hi = mid;
            first = m;
          } else {
            lo = mid;
          }
        }
        if (first.delta < thickness) {
          // As deep as an occluder is taken to be thick. One that touches the receiver shadows it; any
          // other has to prove thin (the cascade draws the shadows of the rest).
          if ((rules & 4u) == 0u || hi < thickness) {
            contact = 0.0;
            break;
          }
          thinUntil = hi + contactU.c.w * thickness;
        }
      } else if (behind) {
        if ((rules & 4u) == 0u && tap.delta < thickness) {
          contact = 0.0;
          break;
        }
        if (t > thinUntil) { thinUntil = -1.0; }
      } else if (thinUntil >= 0.0) {
        if (t <= thinUntil) {
          contact = 0.0;
          break;
        }
        thinUntil = -1.0;
      }
      front = !behind;
      tPrev = t;
    }
    contact = mix(1.0, contact, strength);
  }
`;

const AO_END = /* wgsl */ `
  return Out(vec4f(visibility, contact, 0.0, 1.0), vec4f(d, 0.0, 0.0, 0.0));
}
`;

const AO_FS_FIRST = AO_HEAD + AO_MAIN + CONTACT_FIRST + AO_END;
const AO_FS_NEAR = AO_HEAD + CONTACT_NEAR_DECLS + AO_MAIN + CONTACT_NEAR + AO_END;

/** The candidate: the near field's shader with the rule of `crossShare`. Two edits of its text; '' if either finds nothing to replace. */
function crossShader(): string {
  const edits: [string, string][] = [
    // (After `c`: the uniform's fourth vector.)
    [
      'w = thin: seen again within this many thicknesses\n}',
      'w = thin: seen again within this many thicknesses\n  d: vec4f,   // x = share of the thickness within which a ray that goes behind a surface has entered its visible face\n}',
    ],
    ['if ((rules & 4u) == 0u || hi < thickness) {', 'if ((rules & 4u) == 0u || hi < thickness || first.delta < 0.002 * first.w + 0.001 + contactU.d.x * thickness) {'],
  ];
  let out = AO_FS_NEAR;
  for (const [from, to] of edits) {
    if (out.split(from).length !== 2) return '';
    out = out.replace(from, to);
  }
  return out;
}

export class AmbientOcclusion {
  view!: GPUTextureView;
  depthView!: GPUTextureView;
  /** The rules of the contact march (the shader 'first' has none to change); change through `setContact`. */
  contact: ContactShadowParams = { ...CONTACT_SHADOW_DEFAULT };
  private aoTex: GPUTexture | null = null;
  private depthTex: GPUTexture | null = null;
  private readonly layout: GPUBindGroupLayout;
  private readonly pipeline: Tracked<GPURenderPipeline>;
  private readonly contactBuffer: GPUBuffer | null;
  private readonly contactData = new Float32Array(16);
  /** The shader the pass runs: 'cross' falls back to 'near' if its text could not be made. */
  readonly shader: ContactShader;
  private group: GPUBindGroup | null = null;
  private groupKey = -1;
  private normal: GPUTextureView | null = null;

  constructor(
    private readonly ctx: RenderContext,
    _shaders: CoreShaderLibrary,
    private readonly core: CoreApi,
    shader: ContactShader = 'near',
  ) {
    let fragment = shader === 'first' ? AO_FS_FIRST : AO_FS_NEAR;
    if (shader === 'cross') {
      const cross = crossShader();
      if (cross === '') {
        core.reportError("render core: the contact shadow's candidate shader could not be made from the near field's text; running the near field's");
        shader = 'near';
      } else fragment = cross;
    }
    this.shader = shader;
    const entries: GPUBindGroupLayoutEntry[] = [
      { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'depth' } },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
    ];
    if (shader !== 'first') entries.push({ binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } });
    this.layout = ctx.device.createBindGroupLayout({ label: 'core.ao', entries });
    this.contactBuffer = shader !== 'first' ? ctx.device.createBuffer({ label: 'core.ao.contact', size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }) : null;
    this.pipeline = core.fullscreenPipeline({ label: 'core.ao', fragment, layouts: [this.layout], targets: [{ format: 'rg8unorm' }, { format: 'r32float' }] });
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

  /** The stage's tracked pipelines, for `shaders.warm`. */
  pipelines(): Tracked<unknown>[] {
    return [this.pipeline];
  }

  /** Change the rules of the contact march (what is not given stays). */
  setContact(params: Partial<ContactShadowParams>): void {
    this.contact = { ...this.contact, ...params };
  }

  /**
   * `nearTexel`: the texel of the finest sun cascade (m; 0 = there is none); `interior`: the camera is an
   * interior one (its own fade applies).
   */
  run(encoder: GPUCommandEncoder, _frame: FrameContext, perf: Perf, frameGroup: GPUBindGroup, normal: GPUTextureView, nearTexel: number, interior: boolean): void {
    if (this.contactBuffer) {
      const p = this.contact;
      const fade = interior ? p.interiorFade : p.fade;
      const u = this.contactData;
      u[0] = (p.planeReject ? 1 : 0) + (p.refine || p.thinOnly ? 2 : 0) + (p.thinOnly ? 4 : 0);
      u[1] = Math.max(1, Math.min(64, Math.round(p.nearSteps)));
      u[2] = Math.max(0, p.nearRange);
      u[3] = p.enabled ? 1 : 0;
      u[4] = nearTexel > 0 ? p.thicknessTexels * nearTexel : CONTACT_THICKNESS_NO_CASCADE;
      u[5] = p.blendFrom;
      u[6] = Math.max(p.blendTo, p.blendFrom + 1e-3);
      u[7] = p.planeMargin;
      u[8] = fade ? fade[0] : 1e9;
      u[9] = fade ? Math.max(fade[1], fade[0] + 1e-3) : 2e9;
      u[10] = nearTexel;
      u[11] = p.thinFactor;
      u[12] = Math.max(0, p.crossShare);
      this.ctx.device.queue.writeBuffer(this.contactBuffer, 0, u);
    }

    const key = this.ctx.resources.version('scene.depthOpaque');
    if (!this.group || key !== this.groupKey || normal !== this.normal) {
      this.groupKey = key;
      this.normal = normal;
      const entries: GPUBindGroupEntry[] = [
        { binding: 0, resource: this.ctx.resources.get('scene.depthOpaque') },
        { binding: 1, resource: normal },
      ];
      if (this.contactBuffer) entries.push({ binding: 2, resource: { buffer: this.contactBuffer } });
      this.group = this.ctx.device.createBindGroup({ label: 'core.ao', layout: this.layout, entries });
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
