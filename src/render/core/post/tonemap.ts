/**
 * Final pass to the canvas: RCAS sharpening of the resolved image, bloom mix, AgX tonemap with a mild
 * "punchy" look and a linear, hue-preserving toe, sRGB OETF and triangular blue-noise dither. The LDR overlay
 * hooks draw into the same canvas attachment afterwards.
 *
 * The UI scrim step (scrim.ts; ARCHITECTURE 18.8) is part of this pass: inside the rectangles of
 * 'ui.scrimRects' the scene, before the display transform, is cross-faded to a blurred and dimmed copy of
 * itself read from the bloom's down chain.
 *
 * The pass has two shaders (finding 12 of the presentation sweep's review). TONEMAP_BASE_WGSL is the pass
 * without the scrim, the text it had before the scrim existed: no scrim binding, no scrim branch. It is drawn
 * over the whole frame. TONEMAP_WGSL is the same text with the scrim step in it (the one draw of the pass as
 * the sweep made it); it is drawn afterwards, with the same triangle, inside the scissor rectangles of the
 * published rectangles only (scrim.ts `scrimScissors`), where it writes the pixel anew. So with no rectangle
 * the pass is the pass before the scrim, and a rectangle costs by its area. See `Tonemap.draw` for when the
 * pass falls back to the one draw over the whole frame.
 */
import { UI_SCRIM_BYTES, UI_SCRIM_SLOTS, type RenderContext } from '@/core/contracts/render';
import type { CoreShaderLibrary, Tracked } from '../shaders/library';
import { SCRIM_LEVELS, scrimRectsOf, scrimScissors, type ScrimLevels, type ScrimScissor } from './scrim';

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

/**
 * Which display curve (the one switch of request ocean-10 and ocean-13, RendererOptions.look): 1 = the curve
 * as it is; 2 = the camera curve above mid-grey (below) and, in the meter, the bounds of exposure.ts.
 */
export type Look = 1 | 2;
/**
 * The game's look since the lead's decision of 2026-11-24 (docs/requests/ocean-10.md): the camera curve and
 * the meter's bounds. Look 1 (the curve and the meter as they were) stays reachable for one round, as the
 * comparison: `RendererOptions.look`, `corelook=1` in a page's address, VITE_CORE_LOOK=1.
 */
export const DEFAULT_LOOK: Look = 2;

/**
 * The camera curve (look 2; lead decision in docs/requests/ocean-10.md). The present curve shows sunlit white
 * paper at sunny 16 (0.93 pre-exposed) at 0.54 of display-linear white (193 of 255) and reaches 250 of 255
 * only at ten times that: a daylight photograph has sunlit white at 235 to 245 and clips two to three times
 * above it. Look 2 keeps the present curve from one stop under mid-grey down (shadows, the toe, every dark
 * scene) and mid-grey itself where it is, and above it follows the SCENE: display-linear = scene-linear
 * (through mid-grey: x CAMERA_GAIN) up to CAMERA_SHOULDER_FROM of display white, then a shoulder that reaches
 * white at CAMERA_WHITE with no slope left (no hard clip). Sunlit white lands at 0.88 (241 of 255), 1.4
 * times sunlit white at 0.98 (253), twice at white.
 *
 * It is applied where AgX applies its own curve: per channel, on the inset (desaturated) primaries, before
 * the look and the outset. So greys follow the numbers above exactly, and a bright saturated colour still
 * goes to white the way AgX takes it there (channel by channel, through the inset), not along a hue-true
 * clip. Between CAMERA_BLEND_FROM and CAMERA_BLEND_TO stops about mid-grey the two curves are mixed by a
 * smoothstep on the channel's own value; the present curve's log-log slope is 1 half a stop under mid-grey,
 * the line's is 1 everywhere, so the join has no kink, and the mix is monotone (the line is above the
 * present curve on both sides of mid-grey).
 */
export const CAMERA_WHITE = 2.33;
export const CAMERA_SHOULDER_FROM = 0.75;
export const CAMERA_BLEND_FROM = -1;
export const CAMERA_BLEND_TO = 0;
/** What the look does to a grey's display-linear value: (curve ^ 1.12) ^ 2.2. */
const AGX_GREY_POWER = 1.12 * 2.2;
const agxCurve = (x: number): number => agxContrast((Math.min(Math.max(Math.log2(Math.max(x, 1e-10)), AGX_MIN_EV), AGX_MAX_EV) - AGX_MIN_EV) / (AGX_MAX_EV - AGX_MIN_EV));
/** Display-linear over scene-linear of the present curve at mid-grey (0.989): the line of look 2 goes through it. */
export const CAMERA_GAIN = Math.max(agxCurve(0.18), 0) ** AGX_GREY_POWER / 0.18;
const CAMERA_SHOULDER_X = CAMERA_SHOULDER_FROM / CAMERA_GAIN;
/** Exponent of the shoulder: its slope where it leaves the line is the line's. */
const CAMERA_SHOULDER_POWER = (CAMERA_GAIN * (CAMERA_WHITE - CAMERA_SHOULDER_X)) / (1 - CAMERA_SHOULDER_FROM);
/** The camera curve's display-linear value of a grey (before the mix with the present curve). */
export const cameraGrey = (x: number): number =>
  x <= CAMERA_SHOULDER_X ? CAMERA_GAIN * x : 1 - (1 - CAMERA_SHOULDER_FROM) * (1 - Math.min((x - CAMERA_SHOULDER_X) / (CAMERA_WHITE - CAMERA_SHOULDER_X), 1)) ** CAMERA_SHOULDER_POWER;
/** One channel through the curve of the look (the value AgX's look and outset then take). */
const channelCurve = (x: number, look: Look): number => {
  const present = agxCurve(x);
  if (look === 1) return present;
  const u = Math.min(Math.max((Math.log2(Math.max(x, 1e-10) / 0.18) - CAMERA_BLEND_FROM) / (CAMERA_BLEND_TO - CAMERA_BLEND_FROM), 0), 1);
  return present + (cameraGrey(x) ** (1 / AGX_GREY_POWER) - present) * (u * u * (3 - 2 * u));
};

/** AgX with the pass's look: pre-exposed scene-linear sRGB -> display-linear sRGB (before the OETF). */
export function agxDisplayLinear(c: Rgb, look: Look = DEFAULT_LOOK): [number, number, number] {
  let v = mul(AGX_INSET, [Math.max(c[0], 0), Math.max(c[1], 0), Math.max(c[2], 0)]);
  v = v.map((x) => channelCurve(x, look)) as [number, number, number];
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
export const TOE_GAIN = agxDisplayLinear([toeJoin, toeJoin, toeJoin], 1)[1] / toeJoin;

/** The whole display transform of the tonemap pass: pre-exposed scene-linear sRGB -> display-linear sRGB. */
export function displayLinear(c: Rgb, look: Look = DEFAULT_LOOK): [number, number, number] {
  const p: Rgb = [Math.max(c[0], 0), Math.max(c[1], 0), Math.max(c[2], 0)];
  const a = agxDisplayLinear(p, look);
  const stops = Math.log2(Math.max(luma(p), 1e-10) / TOE_MID_GREY);
  const t = Math.min(Math.max((stops - TOE_FULL_STOPS) / (TOE_START_STOPS - TOE_FULL_STOPS), 0), 1);
  const w = 1 - t * t * (3 - 2 * t);
  return [a[0] + (TOE_GAIN * p[0] - a[0]) * w, a[1] + (TOE_GAIN * p[1] - a[1]) * w, a[2] + (TOE_GAIN * p[2] - a[2]) * w];
}

/** sRGB OETF of one channel, 0..1. */
export const srgbEncode = (x: number): number => (x <= 0.0031308 ? x * 12.92 : 1.055 * x ** (1 / 2.4) - 0.055);

/** Bindings of the scrim's levels in group 1: SCRIM_LEVEL_BINDING + i for scrim level i. */
const SCRIM_LEVEL_BINDING = 4;
const scrimLevels = Array.from({ length: SCRIM_LEVELS }, (_, i) => i);

// The shader text in pieces: the pass without the scrim is the pieces that are not the scrim's, in order.
const WGSL_HEAD = /* wgsl */ `
#include "frame"
#include "fullscreen"
struct TonemapUniforms {
  // x = bloom mix (fraction of energy), y = RCAS sharpness (0 = off, 1 = maximum), z = dither amplitude in LSB, w = unused
  params: vec4f,
}
@group(1) @binding(0) var<uniform> tm: TonemapUniforms;
@group(1) @binding(1) var sceneTex: texture_2d<f32>;
@group(1) @binding(2) var bloomTex: texture_2d<f32>;
`;
const WGSL_SCRIM_BINDINGS = /* wgsl */ `// The UI scrim ('ui.scrimRects', layout in the render contract): rect = x0, y0, x1, y1 in device pixels of the
// canvas (origin top-left); look = corner radius (px), blur 0..1, dim 0..1, opacity 0..1.
struct ScrimRect { rect: vec4f, look: vec4f }
struct ScrimUniforms {
  header: vec4f,   // x = rectangles in use
  rects: array<ScrimRect, ${UI_SCRIM_SLOTS}>,
}
@group(1) @binding(3) var<uniform> scrim: ScrimUniforms;
${scrimLevels.map((i) => `@group(1) @binding(${SCRIM_LEVEL_BINDING + i}) var scrimLevel${i}: texture_2d<f32>;`).join('\n')}
`;
const WGSL_DISPLAY = /* wgsl */ `
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
`;
const WGSL_SCRIM_FUNCTIONS = /* wgsl */ `
/// One level of the bloom's down chain at 'uv' through a four-tap tent (half a texel each way): the texel
/// grid of a level a few dozen texels across does not show in the backdrop.
fn scrimTent(level: texture_2d<f32>, uv: vec2f) -> vec3f {
  let o = 0.5 / vec2f(textureDimensions(level));
  return 0.25 * (textureSampleLevel(level, linearClamp, uv + vec2f(-o.x, -o.y), 0.0).rgb + textureSampleLevel(level, linearClamp, uv + vec2f(o.x, -o.y), 0.0).rgb
    + textureSampleLevel(level, linearClamp, uv + vec2f(-o.x, o.y), 0.0).rgb + textureSampleLevel(level, linearClamp, uv + vec2f(o.x, o.y), 0.0).rgb);
}
fn scrimTap(level: i32, uv: vec2f) -> vec3f {
  switch level {
${scrimLevels.slice(0, -1).map((i) => `    case ${i} { return scrimTent(scrimLevel${i}, uv); }`).join('\n')}
    default { return scrimTent(scrimLevel${SCRIM_LEVELS - 1}, uv); }
  }
}
/// The scene blurred as wide as 'blur' asks (0 = the finest scrim level, 1 = the widest level of the bloom
/// chain): the two nearest levels, mixed.
fn scrimBackdrop(uv: vec2f, blur: f32) -> vec3f {
  let l = clamp(blur, 0.0, 1.0) * ${(SCRIM_LEVELS - 1).toFixed(1)};
  let lo = min(i32(l), ${SCRIM_LEVELS - 1});
  let f = l - f32(lo);
  let a = scrimTap(lo, uv);
  if (f <= 0.0) { return a; }
  return mix(a, scrimTap(min(lo + 1, ${SCRIM_LEVELS - 1}), uv), f);
}
/// Share of the pixel centred at 'px' that a rectangle's scrim covers (scrim.ts scrimCoverage): one inside,
/// a one-pixel ramp across the edge of the rounded rectangle.
fn scrimCover(r: ScrimRect, px: vec2f) -> f32 {
  let half = 0.5 * (r.rect.zw - r.rect.xy);
  // A rectangle without an area covers nothing (not a hairline along its edge).
  if (min(half.x, half.y) <= 0.0) { return 0.0; }
  let radius = min(max(r.look.x, 0.0), min(half.x, half.y));
  let q = abs(px - 0.5 * (r.rect.xy + r.rect.zw)) - half + vec2f(radius);
  let sd = length(max(q, vec2f(0.0))) + min(max(q.x, q.y), 0.0) - radius;
  return clamp(0.5 - sd, 0.0, 1.0);
}
`;
const WGSL_FS_HEAD = /* wgsl */ `
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
`;
const WGSL_SCRIM_STEP = /* wgsl */ `  // The UI scrim: scene-linear, before the display transform, so a panel's backdrop is toned like the scene.
  let scrimCount = min(u32(scrim.header.x), ${UI_SCRIM_SLOTS}u);
  if (scrimCount > 0u) {
    for (var i = 0u; i < scrimCount; i++) {
      let r = scrim.rects[i];
      let cover = scrimCover(r, in.position.xy) * clamp(r.look.w, 0.0, 1.0);
      if (cover > 0.0) {
        c = mix(c, scrimBackdrop(in.uv, r.look.y) * clamp(r.look.z, 0.0, 1.0), cover);
      }
    }
  }
`;
const WGSL_FS_TAIL = /* wgsl */ `  var o = srgbOetf(displayTransform(c));
  let n = blueNoise(vec2u(in.position.xy));
  o += vec3f((n.x + n.y - 1.0) * tm.params.z / 255.0);
  return vec4f(o, 1.0);
}
`;

/**
 * The pass with its scrim step, in one shader (the text of the pass as the presentation sweep made it, to
 * the character). Drawn over the whole frame it is that pass; the tonemap pass draws it inside the scissors
 * of the published rectangles.
 */
export const TONEMAP_WGSL = WGSL_HEAD + WGSL_SCRIM_BINDINGS + WGSL_DISPLAY + WGSL_SCRIM_FUNCTIONS + WGSL_FS_HEAD + WGSL_SCRIM_STEP + WGSL_FS_TAIL;

/**
 * The pass without the scrim: no scrim binding, no scrim function, no scrim branch. It is TONEMAP_WGSL
 * without its scrim pieces and, to the character, the text of the pass before the scrim existed: RCAS, the
 * bloom mix, the display transform, the OETF and the dither, the same statements in the same order.
 */
export const TONEMAP_BASE_WGSL = WGSL_HEAD + WGSL_DISPLAY + WGSL_FS_HEAD + WGSL_FS_TAIL;

/**
 * A text of the pass with the camera curve (look 2): the three lines of `agx` that apply its curve replaced.
 * With look 1 the text is returned as it is. Throws if the lines are not there (a unit test holds it).
 */
function withLook(text: string, look: Look): string {
  if (look === 1) return text;
  const from = `  var v = inset * max(c, vec3f(0.0));
  v = (clamp(log2(max(v, vec3f(1e-10))), vec3f(minEv), vec3f(maxEv)) - minEv) / (maxEv - minEv);
  v = agxContrast(v);
`;
  const to = `  let lin = inset * max(c, vec3f(0.0));
  var v = (clamp(log2(max(lin, vec3f(1e-10))), vec3f(minEv), vec3f(maxEv)) - minEv) / (maxEv - minEv);
  v = agxContrast(v);
  // The camera curve above mid-grey (look 2; tonemap.ts, CAMERA_*): the scene's own line up to the shoulder,
  // white at CAMERA_WHITE, mixed with the present curve over the stop under mid-grey, per channel.
  let camU = clamp((lin - vec3f(${CAMERA_SHOULDER_X.toFixed(9)})) / ${(CAMERA_WHITE - CAMERA_SHOULDER_X).toFixed(9)}, vec3f(0.0), vec3f(1.0));
  let camGrey = select(vec3f(1.0) - ${(1 - CAMERA_SHOULDER_FROM).toFixed(9)} * pow(vec3f(1.0) - camU, vec3f(${CAMERA_SHOULDER_POWER.toFixed(9)})), ${CAMERA_GAIN.toFixed(9)} * lin, lin <= vec3f(${CAMERA_SHOULDER_X.toFixed(9)}));
  let camMix = smoothstep(vec3f(${CAMERA_BLEND_FROM.toFixed(1)}), vec3f(${CAMERA_BLEND_TO.toFixed(1)}), log2(max(lin, vec3f(1e-10)) / 0.18));
  v = mix(v, pow(max(camGrey, vec3f(0.0)), vec3f(${(1 / AGX_GREY_POWER).toFixed(9)})), camMix);
`;
  if (text.split(from).length !== 2) throw new Error('tonemap: the lines of agx() that look 2 replaces are not in the shader text');
  return text.replace(from, to);
}

/**
 * The pass's shader with its scrim step under a look: look 1 is TONEMAP_WGSL itself (with the switch off the
 * pass compiles the present text), look 2 the camera curve.
 */
export function tonemapWgsl(look: Look): string {
  return withLook(TONEMAP_WGSL, look);
}

/** The pass's shader without the scrim under a look: look 1 is TONEMAP_BASE_WGSL itself. */
export function tonemapBaseWgsl(look: Look): string {
  return withLook(TONEMAP_BASE_WGSL, look);
}

/**
 * How the pass is drawn.
 *   'auto'    the pass as it runs (`Tonemap.draw`)
 *   'split'   as 'auto', but never the one draw on account of the rectangles' area
 *   'single'  TONEMAP_WGSL in one draw over the whole frame: the pass as the presentation sweep made it
 *   'base'    TONEMAP_BASE_WGSL alone, whatever is published: the pass before the scrim existed
 * Everything but 'auto' is for tests and measurements (LabApp.setTonemapPath).
 */
export type TonemapPath = 'auto' | 'split' | 'single' | 'base';

/** What the last draw of the pass did. */
export interface TonemapDrawInfo {
  /**
   * 'base': the pass without the scrim alone; 'split': that, then the scrim shader inside the scissors;
   * 'single': the scrim shader over the whole frame.
   */
  drawn: 'base' | 'split' | 'single';
  /** The scissor rectangles the scrim shader was drawn in ('split'), and the pixels inside them. */
  scissors: number;
  scissorPixels: number;
  look: Look;
}

/** The switch of tests and measurements, for every Tonemap of the page, and what the last draw did. */
export const tonemapDebug: { path: TonemapPath; last: TonemapDrawInfo | null } = { path: 'auto', last: null };

/**
 * Above this share of the frame inside the scissors the pass is the one draw of the scrim shader again:
 * inside a scissor a pixel is shaded twice (by the pass without the scrim, then by the scrim shader), so a
 * scrim over most of the frame is cheaper in one draw. The picture is the same either way.
 *
 * As measured (tests/browser/render-core/scrim.perf.spec.ts, 2026-11-17, RTX 5090, 2560 x 1440, p50 of
 * `core.tonemap`): the pass without the scrim 0.032 ms; the one draw 0.104 to 0.110 ms with any rectangle;
 * with scissors 0.038 ms at 5 % of the frame, 0.082 at 40 %, 0.100 at 57 % (four panels), 0.101 at 60 %
 * (the one draw: 0.106) and 0.138 at 100 % (0.106). At 60 % the scissors are still the cheaper way; where
 * between 60 % and 100 % the two cross was not measured.
 */
export const SCRIM_SPLIT_MAX_SHARE = 0.6;

export class Tonemap {
  private readonly baseLayout: GPUBindGroupLayout;
  private readonly scrimLayout: GPUBindGroupLayout;
  private readonly basePipeline: Tracked<GPURenderPipeline>;
  private readonly scrimPipeline: Tracked<GPURenderPipeline>;
  private readonly uniform: GPUBuffer;
  private baseGroup: GPUBindGroup | null = null;
  private scrimGroup: GPUBindGroup | null = null;
  private scene: GPUTextureView | null = null;
  private bloom: GPUTextureView | null = null;
  private scrimRects: GPUBuffer | null = null;
  private scrimViews: readonly GPUTextureView[] = [];
  /** The scissors of the rectangles last seen (null: over the whole frame), and what they were made from. */
  private scissors: readonly ScrimScissor[] | null = null;
  private scissorPixels = 0;
  private scissorsOf: Float32Array | null = null;
  private scissorsWidth = 0;
  private scissorsHeight = 0;
  private readonly info: TonemapDrawInfo;

  constructor(
    private readonly ctx: RenderContext,
    shaders: CoreShaderLibrary,
    /** The display curve (RendererOptions.look): 1 = as it is, 2 = the camera curve. */
    look: Look = DEFAULT_LOOK,
  ) {
    const device = ctx.device;
    this.info = { drawn: 'base', scissors: 0, scissorPixels: 0, look };
    const baseEntries: GPUBindGroupLayoutEntry[] = [
      { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
      { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
    ];
    this.baseLayout = device.createBindGroupLayout({ label: 'tonemap', entries: baseEntries });
    this.scrimLayout = device.createBindGroupLayout({
      label: 'tonemap.scrim',
      entries: [
        ...baseEntries,
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform', minBindingSize: UI_SCRIM_BYTES } },
        ...scrimLevels.map((i): GPUBindGroupLayoutEntry => ({ binding: SCRIM_LEVEL_BINDING + i, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } })),
      ],
    });
    this.uniform = device.createBuffer({ label: 'tonemap', size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const pipeline = (label: string, wgsl: string, layout: GPUBindGroupLayout): Tracked<GPURenderPipeline> =>
      shaders.tracked(() => {
        const module = shaders.createModule(label, wgsl);
        return device.createRenderPipeline({
          label,
          layout: device.createPipelineLayout({ bindGroupLayouts: [ctx.frameBindGroupLayout, layout] }),
          vertex: { module, entryPoint: 'fullscreenVs' },
          fragment: { module, entryPoint: 'fs', targets: [{ format: ctx.canvasFormat }] },
        });
      });
    // Both under the same look: the display transform of a pixel is the same whichever of them shades it.
    this.basePipeline = pipeline('core.tonemap', tonemapBaseWgsl(look), this.baseLayout);
    this.scrimPipeline = pipeline('core.tonemap.scrim', tonemapWgsl(look), this.scrimLayout);
  }

  /** The stage's tracked pipelines, for `shaders.warm`: both, so the first frame of a menu compiles nothing. */
  pipelines(): Tracked<unknown>[] {
    return [this.basePipeline, this.scrimPipeline];
  }

  /**
   * `scene`: pre-exposed linear image at any resolution; `bloom`: blurred image to mix in (or a black texture);
   * `scrim`: the buffer published as 'ui.scrimRects' and the levels of the bloom's down chain the scrim reads
   * with the size of the canvas (PostOutputs.scrimLevels).
   *
   * What is drawn:
   * - The core knows what is in the buffer (its own default, or a buffer written through `writeScrimRects`):
   *   the pass without the scrim over the whole frame; then, if a rectangle can change a pixel, the scrim
   *   shader with the same triangle inside the scissors of the rectangles (`scrimScissors`), where it writes
   *   the pixel anew from the same inputs. No rectangle, rectangles without an area, of opacity 0 or off the
   *   canvas: the pass without the scrim and nothing else. The scissor is the whole canvas again afterwards
   *   (the overlays are drawn in this pass).
   * - The core does not know what is in the buffer (written with `queue.writeBuffer` directly), or the
   *   scissors hold more than SCRIM_SPLIT_MAX_SHARE of the frame: the scrim shader in one draw over the whole
   *   frame, the pass as the presentation sweep made it.
   * The picture is the same in every case: inside a scissor a pixel is what the scrim shader makes of it,
   * outside it no rectangle covers it and the two shaders do the same arithmetic.
   */
  draw(
    pass: GPURenderPassEncoder,
    scene: GPUTextureView,
    bloom: GPUTextureView,
    params: { bloomMix: number; sharpness: number; dither: number },
    scrim: { rects: GPUBuffer; levels: ScrimLevels },
  ): void {
    const device = this.ctx.device;
    const levels = scrim.levels;
    if (levels.views.length !== SCRIM_LEVELS) throw new Error(`tonemap: ${levels.views.length} scrim levels, the pass binds ${SCRIM_LEVELS}`);
    device.queue.writeBuffer(this.uniform, 0, new Float32Array([params.bloomMix, params.sharpness, params.dither, 0]));
    if (this.scene !== scene || this.bloom !== bloom) {
      this.scene = scene;
      this.bloom = bloom;
      this.baseGroup = null;
      this.scrimGroup = null;
    }
    if (this.scrimRects !== scrim.rects || levels.views.some((v, i) => v !== this.scrimViews[i])) {
      this.scrimRects = scrim.rects;
      this.scrimViews = [...levels.views];
      this.scrimGroup = null;
    }

    const path = tonemapDebug.path;
    const scissors = path === 'single' ? null : path === 'base' ? [] : this.scissorsFor(scrim.rects, levels, path === 'auto');
    const info = this.info;
    tonemapDebug.last = info;
    info.scissors = 0;
    info.scissorPixels = 0;
    if (scissors === null) {
      info.drawn = 'single';
      pass.setPipeline(this.scrimPipeline.get());
      pass.setBindGroup(1, this.scrimBindGroup());
      pass.draw(3);
      return;
    }
    info.drawn = 'base';
    pass.setPipeline(this.basePipeline.get());
    pass.setBindGroup(1, this.baseBindGroup());
    pass.draw(3);
    if (scissors.length === 0) return;
    info.drawn = 'split';
    info.scissors = scissors.length;
    info.scissorPixels = this.scissorPixels;
    pass.setPipeline(this.scrimPipeline.get());
    pass.setBindGroup(1, this.scrimBindGroup());
    for (const s of scissors) {
      pass.setScissorRect(s.x, s.y, s.width, s.height);
      pass.draw(3);
    }
    pass.setScissorRect(0, 0, levels.width, levels.height);
  }

  /**
   * The scissors of the rectangles in `rects`, or null when the scrim shader is to be drawn over the whole
   * frame: the contents or the canvas size are not known here, or (`bounded`) the scissors hold too much of
   * the frame.
   */
  private scissorsFor(rects: GPUBuffer, levels: ScrimLevels, bounded: boolean): readonly ScrimScissor[] | null {
    const packed = scrimRectsOf(rects);
    if (!packed || !(levels.width > 0 && levels.height > 0)) return null;
    if (packed !== this.scissorsOf || levels.width !== this.scissorsWidth || levels.height !== this.scissorsHeight) {
      this.scissorsOf = packed;
      this.scissorsWidth = levels.width;
      this.scissorsHeight = levels.height;
      this.scissors = scrimScissors(packed, levels.width, levels.height);
      this.scissorPixels = (this.scissors ?? []).reduce((a, s) => a + s.width * s.height, 0);
    }
    if (bounded && this.scissorPixels > SCRIM_SPLIT_MAX_SHARE * levels.width * levels.height) return null;
    return this.scissors;
  }

  private baseBindGroup(): GPUBindGroup {
    this.baseGroup ??= this.ctx.device.createBindGroup({
      label: 'tonemap',
      layout: this.baseLayout,
      entries: [
        { binding: 0, resource: { buffer: this.uniform } },
        { binding: 1, resource: this.scene! },
        { binding: 2, resource: this.bloom! },
      ],
    });
    return this.baseGroup;
  }

  private scrimBindGroup(): GPUBindGroup {
    this.scrimGroup ??= this.ctx.device.createBindGroup({
      label: 'tonemap.scrim',
      layout: this.scrimLayout,
      entries: [
        { binding: 0, resource: { buffer: this.uniform } },
        { binding: 1, resource: this.scene! },
        { binding: 2, resource: this.bloom! },
        { binding: 3, resource: { buffer: this.scrimRects! } },
        ...this.scrimViews.map((view, i): GPUBindGroupEntry => ({ binding: SCRIM_LEVEL_BINDING + i, resource: view })),
      ],
    });
    return this.scrimGroup;
  }
}
