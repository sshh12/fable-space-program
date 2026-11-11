/**
 * Compute shaders of the Tessendorf FFT: time evolution of the layer spectra (the four cascades and the long-wave
 * normals layer; phases exact through the quantised dispersion), two 256-point radix-2 passes per layer (rows,
 * then columns + assembly into the displacement / derivative / foam texture arrays), and the mip chain of those
 * arrays.
 *
 * Packing: four complex inverse FFTs per cascade carry eight real fields, two per transform
 * (IFFT(A + iB) = a + ib for Hermitian A, B):
 *   P0 = Dx + i Dy, P1 = h + i Dxy, P2 = dh/dx + i dh/dy, P3 = dDx/dx + i dDy/dy
 * with Dx = -i kx/k H lambda, Dxy = kx ky/k H lambda, dDx/dx = kx^2/k H lambda (lambda = choppiness), x = east,
 * y = north of the chart. Outputs per cascade layer:
 *   'ocean.displacement'  rgba16float: Dx, h, Dy, dDx/dy   (m)
 *   'ocean.derivatives'   rgba16float: dh/dx, dh/dy, dDx/dx, dDy/dy
 *   foam (internal)       rgba16float: r = foam 0..1 (Jacobian folding with temporal decay), g = Jacobian
 */
import { FFT_LAYERS, FFT_SIZE } from '../spectrum';

export const FFT_SPECTRUM_WGSL = /* wgsl */ `
struct FftParams {
  time: vec4f,      // x = tau = frac(t / T), y = choppiness, z = dt (s), w = foam decay (1/s)
  foam: vec4f,      // x = foam threshold below J = 1 in standard deviations of the cascade's Jacobian, y = ramp width (same unit)
  lengths: vec4f,   // patch length of layers 0..3 (m)
  sigmaJ: vec4f,    // standard deviation of the Jacobian of layers 0..3
  layer4: vec4f,    // x = patch length, y = Jacobian spread of layer 4 (the long-wave layer)
}
@group(0) @binding(0) var<uniform> fp: FftParams;
@group(0) @binding(1) var<storage, read> h0: array<vec4f>;
@group(0) @binding(2) var<storage, read> omegaIndex: array<f32>;
@group(0) @binding(3) var<storage, read_write> work: array<vec2f>;   // [cascade][signal 0..3][row][column]

const N = ${FFT_SIZE}u;
fn cmul(a: vec2f, b: vec2f) -> vec2f { return vec2f(a.x * b.x - a.y * b.y, a.x * b.y + a.y * b.x); }
fn ci(a: vec2f) -> vec2f { return vec2f(-a.y, a.x); }   // i a
fn fi(i: u32) -> f32 { return select(f32(i), f32(i) - f32(N), i >= N / 2u); }

@compute @workgroup_size(16, 16, 1)
fn spectrum(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x;
  let j = id.y;
  let c = id.z;
  if (i >= N || j >= N || c >= ${FFT_LAYERS}u) { return; }
  let o = (c * N + j) * N + i;
  let s = h0[o];
  // Phase 2 pi frac(m tau): exact in float32 because m is an integer and tau < 1.
  let ph = 6.283185307179586 * fract(omegaIndex[o] * fp.time.x);
  let e = vec2f(cos(ph), sin(ph));
  // h0(k) e^{-i omega t}: the mode h0(k) travels along +k (downwind for the wind-aligned half of the spectrum).
  let H = cmul(s.xy, vec2f(e.x, -e.y)) + cmul(s.zw, e);
  let dk = 6.283185307179586 / select(fp.layer4.x, fp.lengths[min(c, 3u)], c < 4u);
  let kx = fi(i) * dk;
  let ky = fi(j) * dk;
  let k = sqrt(kx * kx + ky * ky);
  var p0 = vec2f(0.0);
  var p1 = H;
  var p2 = vec2f(0.0);
  var p3 = vec2f(0.0);
  if (k > 0.0) {
    let lam = fp.time.y;
    let dx = ci(H) * (-kx / k * lam);
    let dy = ci(H) * (-ky / k * lam);
    let dxy = H * (kx * ky / k * lam);
    let hx = ci(H) * kx;
    let hy = ci(H) * ky;
    let dxx = H * (kx * kx / k * lam);
    let dyy = H * (ky * ky / k * lam);
    p0 = dx + ci(dy);
    p1 = H + ci(dxy);
    p2 = hx + ci(hy);
    p3 = dxx + ci(dyy);
  }
  let base = c * 4u * N * N + j * N + i;
  work[base] = p0;
  work[base + N * N] = p1;
  work[base + 2u * N * N] = p2;
  work[base + 3u * N * N] = p3;
}
`;

/** One 256-point inverse FFT of four signals per workgroup (row or column `line` of cascade `z`). */
const FFT_CORE = /* wgsl */ `
const N = ${FFT_SIZE}u;
const LOG_N = ${Math.log2(FFT_SIZE)}u;
var<workgroup> buf: array<vec2f, ${4 * FFT_SIZE}>;

fn bitrev(x: u32) -> u32 { return reverseBits(x) >> (32u - LOG_N); }
fn cmul(a: vec2f, b: vec2f) -> vec2f { return vec2f(a.x * b.x - a.y * b.y, a.x * b.y + a.y * b.x); }

/// In-place radix-2 decimation-in-time inverse transform (e^{+i...}, no 1/N) of the four signals in 'buf'.
fn fftWorkgroup(t: u32) {
  for (var s = 1u; s <= LOG_N; s++) {
    workgroupBarrier();
    let half = 1u << (s - 1u);
    let grp = t / half;
    let pos = t % half;
    let i0 = grp * 2u * half + pos;
    let i1 = i0 + half;
    let ang = 3.141592653589793 * f32(pos) / f32(half);
    let tw = vec2f(cos(ang), sin(ang));
    for (var q = 0u; q < 4u; q++) {
      let a = buf[q * N + i0];
      let b = cmul(buf[q * N + i1], tw);
      buf[q * N + i0] = a + b;
      buf[q * N + i1] = a - b;
    }
  }
  workgroupBarrier();
}
`;

export const FFT_ROWS_WGSL = /* wgsl */ `
@group(0) @binding(3) var<storage, read_write> work: array<vec2f>;
${FFT_CORE}
@compute @workgroup_size(${FFT_SIZE / 2}, 1, 1)
fn rows(@builtin(local_invocation_id) lid: vec3u, @builtin(workgroup_id) wg: vec3u) {
  let t = lid.x;
  let row = wg.x;
  let c = wg.y;
  let base = c * 4u * N * N + row * N;
  for (var q = 0u; q < 4u; q++) {
    for (var k = 0u; k < 2u; k++) {
      let i = t * 2u + k;
      buf[q * N + bitrev(i)] = work[base + q * N * N + i];
    }
  }
  fftWorkgroup(t);
  for (var q = 0u; q < 4u; q++) {
    for (var k = 0u; k < 2u; k++) {
      let i = t * 2u + k;
      work[base + q * N * N + i] = buf[q * N + i];
    }
  }
}
`;

export const FFT_COLUMNS_WGSL = /* wgsl */ `
struct FftParams {
  time: vec4f,
  foam: vec4f,
  lengths: vec4f,
  sigmaJ: vec4f,
  layer4: vec4f,
}
@group(0) @binding(0) var<uniform> fp: FftParams;
@group(0) @binding(3) var<storage, read_write> work: array<vec2f>;
@group(0) @binding(4) var dispOut: texture_storage_2d_array<rgba16float, write>;
@group(0) @binding(5) var derivOut: texture_storage_2d_array<rgba16float, write>;
@group(0) @binding(6) var foamOut: texture_storage_2d_array<rgba16float, write>;
@group(0) @binding(7) var foamPrev: texture_2d_array<f32>;
${FFT_CORE}
@compute @workgroup_size(${FFT_SIZE / 2}, 1, 1)
fn columns(@builtin(local_invocation_id) lid: vec3u, @builtin(workgroup_id) wg: vec3u) {
  let t = lid.x;
  let col = wg.x;
  let c = wg.y;
  let base = c * 4u * N * N + col;
  for (var q = 0u; q < 4u; q++) {
    for (var k = 0u; k < 2u; k++) {
      let j = t * 2u + k;
      buf[q * N + bitrev(j)] = work[base + q * N * N + j * N];
    }
  }
  fftWorkgroup(t);
  let decay = exp(-fp.time.w * fp.time.z);
  for (var k = 0u; k < 2u; k++) {
    let j = t * 2u + k;
    let p0 = buf[j];
    let p1 = buf[N + j];
    let p2 = buf[2u * N + j];
    let p3 = buf[3u * N + j];
    let texel = vec2i(i32(col), i32(j));
    textureStore(dispOut, texel, c, vec4f(p0.x, p1.x, p0.y, p1.y));
    textureStore(derivOut, texel, c, vec4f(p2.x, p2.y, p3.x, p3.y));
    // Jacobian of the horizontal map x -> x + D: folding (J < threshold) breeds foam, which then decays.
    let J = (1.0 + p3.x) * (1.0 + p3.y) - p1.y * p1.y;
    let sj = select(fp.layer4.y, fp.sigmaJ[min(c, 3u)], c < 4u);
    let fresh = saturate(((1.0 - fp.foam.x * sj) - J) / max(fp.foam.y * sj, 1e-6));
    let old = textureLoad(foamPrev, texel, c, 0).r * decay;
    textureStore(foamOut, texel, c, vec4f(max(old, fresh), J, 0.0, 1.0));
  }
}
`;

/** 2 x 2 box downsample of three cascade arrays from mip l - 1 to mip l. */
export const FFT_MIP_WGSL = /* wgsl */ `
@group(0) @binding(0) var srcA: texture_2d_array<f32>;
@group(0) @binding(1) var srcB: texture_2d_array<f32>;
@group(0) @binding(2) var srcC: texture_2d_array<f32>;
@group(0) @binding(3) var dstA: texture_storage_2d_array<rgba16float, write>;
@group(0) @binding(4) var dstB: texture_storage_2d_array<rgba16float, write>;
@group(0) @binding(5) var dstC: texture_storage_2d_array<rgba16float, write>;
@compute @workgroup_size(8, 8, 1)
fn mip(@builtin(global_invocation_id) id: vec3u) {
  let size = textureDimensions(dstA);
  if (id.x >= size.x || id.y >= size.y) { return; }
  let layer = i32(id.z);
  let p = vec2i(id.xy) * 2;
  var a = vec4f(0.0);
  var b = vec4f(0.0);
  var c = vec4f(0.0);
  for (var k = 0; k < 4; k++) {
    let q = p + vec2i(k & 1, k >> 1);
    a += textureLoad(srcA, q, layer, 0);
    b += textureLoad(srcB, q, layer, 0);
    c += textureLoad(srcC, q, layer, 0);
  }
  textureStore(dstA, vec2i(id.xy), layer, a * 0.25);
  textureStore(dstB, vec2i(id.xy), layer, b * 0.25);
  textureStore(dstC, vec2i(id.xy), layer, c * 0.25);
}
`;
