/**
 * WGSL of the map overlay: three pipelines sharing one uniform block.
 *  - lines: instanced screen-space quads per polyline segment, analytic anti-aliased capsules whose union
 *    gives round joins without double blending (a fragment belongs to the nearest of the segment and its
 *    two neighbours), a dark casing on both sides, dashes along screen arc length (phase per vertex plus the
 *    segment's own screen length, so the phase stays exact in float32 however long the line), and
 *    per-fragment analytic sphere occlusion with a short soft fade at the limb (the twin of occlusion.ts).
 *    Lines arrive cut in float64 where they pass behind the eye (scene.ts, VertexArrays.push): every drawn
 *    segment has both ends safely in front, so the vertex stage never clips.
 *  - icons: signed-distance shapes evaluated per fragment (crisp at any size, dark outline for contrast).
 *  - glyphs: 1:1 texel copies from a Canvas-2D-rasterised atlas (fill + halo channels).
 * Output is premultiplied, display-referred colour into the LDR target after tonemapping.
 */

import { CASING_ALPHA } from '../constants';

export const MAX_OCCLUDERS = 16;

const COMMON = /* wgsl */ `
struct Uniforms {
  proj: mat4x4f,
  viewport: vec4f,   // width, height, 1/width, 1/height (device px)
  params: vec4f,     // pxScale, focal px, near plane, occluder count
  style: vec4f,      // occlusion fade px, dash period px, dash on px, casing width px
  bodies: array<vec4f, ${MAX_OCCLUDERS}>, // view-space centre, radius
};
@group(0) @binding(0) var<uniform> U: Uniforms;

// slack: radial depth (m) below a body surface that still counts as on it (lines lying on a surface); such
// points are tested against the sphere shrunk by it. Twin of occlusionWeight() in occlusion.ts.
fn occlusion(p: vec3f, slack: f32) -> f32 {
  let tp = length(p);
  if (tp <= 0.0) { return 0.0; }
  let dir = p / tp;
  var w = 0.0;
  let n = u32(U.params.w);
  for (var i = 0u; i < n; i++) {
    let b = U.bodies[i];
    let c = b.xyz;
    let L = length(c);
    if (L <= b.w) { continue; }
    let tc = dot(dir, c);
    if (tc <= 0.0) { continue; }
    let R = b.w - slack;
    let dperp = length(cross(dir, c));
    if (dperp >= R) { continue; }
    let t1 = tc - sqrt((R - dperp) * (R + dperp));
    let tol = select(max(1e-3 * b.w, 4e-7 * L), 0.0, slack > 0.0);
    if (tp <= t1 + tol) { continue; }
    let inside = (asin(R / L) - atan2(dperp, tc)) * U.params.y;
    let s = clamp(inside / U.style.x, 0.0, 1.0);
    w = max(w, s * s * (3.0 - 2.0 * s));
  }
  return w;
}

fn unpackColor(c: u32) -> vec4f {
  return vec4f(f32(c & 255u), f32((c >> 8u) & 255u), f32((c >> 16u) & 255u), f32(c >> 24u)) / 255.0;
}
`;

export const LINE_WGSL = /* wgsl */ `
${COMMON}
struct LinePoint {
  pos: vec3f,
  phase: f32,    // screen length from the line start, modulo the dash period (device px)
  color: u32,
  flags: u32,    // bit 0: the segment to the next point is drawn; bit 1: dashed; bit 2: the segment to the next point
                 // is a join neighbour only (seam of a closed ring); bits 16-31: width * 64 (device px)
  seglen: f32,   // screen length of the segment to the next point (device px)
  slack: f32,    // radial allowance below a body surface (m), see occlusion()
};
@group(0) @binding(1) var<storage, read> pts: array<LinePoint>;

struct LineOut {
  @builtin(position) pos: vec4f,
  @location(0) @interpolate(flat) seg: vec4f,
  @location(1) @interpolate(flat) nb: vec4f,
  @location(2) @interpolate(flat) aw: vec4f,
  @location(3) @interpolate(flat) bw: vec4f,
  @location(4) @interpolate(flat) ca: vec4f,
  @location(5) @interpolate(flat) cb: vec4f,
  @location(6) @interpolate(flat) misc: vec4f,
  @location(7) @interpolate(flat) misc2: vec4f,
};

fn toScreen(p: vec3f) -> vec2f {
  let c = U.proj * vec4f(p, 1.0);
  let ndc = c.xy / c.w;
  return vec2f(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5) * U.viewport.xy;
}

var<private> CORNERS: array<vec2f, 6> = array<vec2f, 6>(vec2f(0.0, -1.0), vec2f(1.0, -1.0), vec2f(0.0, 1.0), vec2f(0.0, 1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0));

@vertex
fn vsLine(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> LineOut {
  var o: LineOut;
  o.pos = vec4f(2.0, 2.0, 0.0, 1.0);
  let n = arrayLength(&pts);
  if (ii + 1u >= n) { return o; }
  let A = pts[ii];
  if ((A.flags & 1u) == 0u) { return o; }
  let B = pts[ii + 1u];
  let pa = A.pos;
  let pb = B.pos;
  // The CPU cut the line in front of the eye (both ends of a drawn segment are well past the near plane).
  if (min(-pa.z, -pb.z) < U.params.z) { return o; }
  let hasPrev = ii > 0u && (pts[ii - 1u].flags & 5u) != 0u;
  let hasNext = ii + 2u < n && (B.flags & 5u) != 0u;
  let sa = toScreen(pa);
  let sb = toScreen(pb);
  var sp = vec2f(0.0);
  var sn = vec2f(0.0);
  if (hasPrev) { sp = toScreen(pts[ii - 1u].pos); }
  if (hasNext) { sn = toScreen(pts[ii + 2u].pos); }
  let hw = f32(A.flags >> 16u) / 128.0;
  let d = sb - sa;
  let L = length(d);
  let dir = select(vec2f(1.0, 0.0), d / L, L > 1e-4);
  let nrm = vec2f(-dir.y, dir.x);
  let ext = hw + U.style.w + 1.5;
  let c = CORNERS[vi];
  let base = select(sa - dir * ext, sb + dir * ext, c.x > 0.5);
  let corner = base + nrm * ext * c.y;
  o.pos = vec4f(corner.x * U.viewport.z * 2.0 - 1.0, 1.0 - corner.y * U.viewport.w * 2.0, 0.0, 1.0);
  o.seg = vec4f(sa, sb);
  o.nb = vec4f(sp, sn);
  o.aw = vec4f(pa, -pa.z);
  o.bw = vec4f(pb, -pb.z);
  o.ca = unpackColor(A.color);
  o.cb = unpackColor(B.color);
  let flags = select(0.0, 1.0, hasPrev) + select(0.0, 2.0, hasNext) + select(0.0, 4.0, (A.flags & 2u) != 0u);
  o.misc = vec4f(hw, A.phase, A.seglen, flags);
  o.misc2 = vec4f(A.slack, 0.0, 0.0, 0.0);
  return o;
}

fn segDist(p: vec2f, a: vec2f, b: vec2f) -> f32 {
  let ab = b - a;
  let l2 = dot(ab, ab);
  let t = select(0.0, clamp(dot(p - a, ab) / l2, 0.0, 1.0), l2 > 1e-12);
  return length(p - (a + ab * t));
}

@fragment
fn fsLine(i: LineOut) -> @location(0) vec4f {
  let p = i.pos.xy;
  let sa = i.seg.xy;
  let sb = i.seg.zw;
  let ab = sb - sa;
  let l2 = dot(ab, ab);
  let s = select(0.0, clamp(dot(p - sa, ab) / l2, 0.0, 1.0), l2 > 1e-12);
  let d = length(p - (sa + ab * s));
  let flags = u32(i.misc.w + 0.5);
  if ((flags & 1u) != 0u) {
    if (segDist(p, i.nb.xy, sa) < d) { discard; }
  }
  if ((flags & 2u) != 0u) {
    if (segDist(p, sb, i.nb.zw) < d) { discard; }
  }
  let casing = U.style.w;
  var cov = clamp(i.misc.x + 0.5 - d, 0.0, 1.0);
  var cas = clamp(i.misc.x + casing + 0.5 - d, 0.0, 1.0);
  if ((flags & 4u) != 0u) {
    // Signed distance along the line to the nearest dash (negative inside it); the casing follows the dash.
    let L = i.misc.y + s * i.misc.z;
    let period = U.style.y;
    let on = U.style.z;
    let m = L - floor(L / period) * period;
    let sd = select(min(m - on, period - m), -min(m, on - m), m <= on);
    cov *= clamp(0.5 - sd, 0.0, 1.0);
    cas *= clamp(casing + 0.5 - sd, 0.0, 1.0);
  }
  if (cas <= 0.0) { discard; }
  let wa = i.aw.w;
  let wb = i.bw.w;
  let t = s * wa / max((1.0 - s) * wb + s * wa, 1e-30);
  let P = mix(i.aw.xyz, i.bw.xyz, t);
  let vis = 1.0 - occlusion(P, i.misc2.x);
  let col = mix(i.ca, i.cb, s);
  let a = col.a * cov * vis;
  let ac = ${CASING_ALPHA.toFixed(3)} * col.a * cas * vis * (1.0 - a);
  if (a + ac <= 0.0) { discard; }
  return vec4f(col.rgb * a + vec3f(0.004, 0.006, 0.01) * ac, a + ac);
}
`;

export const ICON_WGSL = /* wgsl */ `
${COMMON}
struct IconIn {
  @location(0) center: vec2f,
  @location(1) half: vec2f,
  @location(2) rot: f32,
  @location(3) shape: u32,
  @location(4) color: vec4f,
  @location(5) alpha: f32,
};
struct IconOut {
  @builtin(position) pos: vec4f,
  @location(0) local: vec2f,
  @location(1) @interpolate(flat) half: vec2f,
  @location(2) @interpolate(flat) shape: u32,
  @location(3) @interpolate(flat) color: vec4f,
};

var<private> QUAD: array<vec2f, 6> = array<vec2f, 6>(vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(-1.0, 1.0), vec2f(-1.0, 1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0));

@vertex
fn vsIcon(@builtin(vertex_index) vi: u32, v: IconIn) -> IconOut {
  var o: IconOut;
  let margin = 3.0 * U.params.x;
  let local = QUAD[vi] * (v.half + vec2f(margin));
  let cs = vec2f(cos(v.rot), sin(v.rot));
  let p = v.center + vec2f(local.x * cs.x - local.y * cs.y, local.x * cs.y + local.y * cs.x);
  o.pos = vec4f(p.x * U.viewport.z * 2.0 - 1.0, 1.0 - p.y * U.viewport.w * 2.0, 0.0, 1.0);
  o.local = local;
  o.half = v.half;
  o.shape = v.shape;
  o.color = vec4f(v.color.rgb, v.color.a * v.alpha);
  return o;
}

fn sdCircle(p: vec2f, r: f32) -> f32 { return length(p) - r; }
fn sdRing(p: vec2f, r: f32, w: f32) -> f32 { return abs(length(p) - r) - w * 0.5; }
fn sdSeg(p: vec2f, a: vec2f, b: vec2f, w: f32) -> f32 {
  let ab = b - a;
  let t = clamp(dot(p - a, ab) / dot(ab, ab), 0.0, 1.0);
  return length(p - (a + ab * t)) - w * 0.5;
}
fn sdBox(p: vec2f, h: vec2f, r: f32) -> f32 {
  let q = abs(p) - h + vec2f(r);
  return length(max(q, vec2f(0.0))) + min(max(q.x, q.y), 0.0) - r;
}
// Equilateral triangle with its apex toward the top of the screen (y down), circumradius R.
fn sdTri(p0: vec2f, R: f32) -> f32 {
  let k = sqrt(3.0);
  let r = R * 0.8660254;
  var p = vec2f(abs(p0.x) - r, -p0.y + r / k);
  if (p.x + k * p.y > 0.0) { p = vec2f(p.x - k * p.y, -k * p.x - p.y) / 2.0; }
  p.x -= clamp(p.x, -2.0 * r, 0.0);
  return -length(p) * sign(p.y);
}
fn rot2(p: vec2f, a: f32) -> vec2f { let c = cos(a); let s = sin(a); return vec2f(c * p.x - s * p.y, s * p.x + c * p.y); }

// Chevron (two strokes meeting at the apex) pointing up (y down on screen), apex at (0, -k), arms down to (+-k, 0).
fn sdChevron(p: vec2f, k: f32, w: f32) -> f32 {
  return min(sdSeg(p, vec2f(-k, k * 0.45), vec2f(0.0, -k * 0.55), w), sdSeg(p, vec2f(k, k * 0.45), vec2f(0.0, -k * 0.55), w));
}
// Arrow along +x from a to b with a solid head at b.
fn sdArrow(p: vec2f, a: f32, b: f32, head: f32, w: f32) -> f32 {
  let shaft = sdSeg(p, vec2f(a, 0.0), vec2f(b - head * 0.8, 0.0), w);
  let tip = sdTri(vec2f(p.y, -(p.x - b + head * 0.55)), head);
  return min(shaft, tip);
}

// Returns (distance to the shape, mode): 0 = solid with a dark halo, 1 = panel with an edge, 2 = plain fill.
fn shapeSd(shape: u32, p: vec2f, h: vec2f, px: f32) -> vec2f {
  let r = h.x;
  let w = 1.6 * px;
  switch (shape) {
    case 0u: { // apoapsis: ring with an up chevron
      return vec2f(min(sdRing(p, r * 0.82, w), sdChevron(p + vec2f(0.0, r * 0.08), r * 0.4, w * 1.1)), 0.0);
    }
    case 24u: { // periapsis: ring with a down chevron
      return vec2f(min(sdRing(p, r * 0.82, w), sdChevron(vec2f(p.x, -p.y) + vec2f(0.0, r * 0.08), r * 0.4, w * 1.1)), 0.0);
    }
    case 1u: { // inclination: diamond outline
      let q = abs(p);
      return vec2f(abs((q.x + q.y) * 0.7071 - r * 0.62) - w * 0.5, 0.0);
    }
    case 2u: { // SOI entry: ring with an arrow coming in from the left to the centre
      return vec2f(min(sdRing(p, r * 0.8, w), sdArrow(p, -r * 1.25, r * 0.12, r * 0.42, w)), 0.0);
    }
    case 25u: { // SOI exit: ring with an arrow from the centre out to the right
      return vec2f(min(sdRing(p, r * 0.8, w), sdArrow(p, -r * 0.1, r * 1.3, r * 0.42, w)), 0.0);
    }
    case 26u: { // maneuver node behind a body: dashed ring with a dot
      let a = atan2(p.y, p.x) * 1.2732395; // 8 dashes per turn
      let gap = (abs(fract(a) - 0.5) - 0.28) * 0.7853982 * r * 0.78;
      return vec2f(min(max(sdRing(p, r * 0.78, w * 1.15), gap), sdCircle(p, r * 0.22)), 0.0);
    }
    case 23u: { // label plate
      return vec2f(sdBox(p, h, 3.0 * px), 2.0);
    }
    case 3u: { // impact: X inside a ring
      let a = r * 0.45;
      let x = min(sdSeg(p, vec2f(-a, -a), vec2f(a, a), w * 1.2), sdSeg(p, vec2f(-a, a), vec2f(a, -a), w * 1.2));
      return vec2f(min(x, sdRing(p, r * 0.9, w)), 0.0);
    }
    case 4u: { // entry: downward triangle, filled
      return vec2f(sdTri(vec2f(p.x, -p.y), r * 0.95), 0.0);
    }
    case 5u: { // closest approach: ring with four ticks
      let q = abs(p);
      let ticks = min(sdSeg(q, vec2f(r * 0.55, 0.0), vec2f(r * 1.05, 0.0), w), sdSeg(q, vec2f(0.0, r * 0.55), vec2f(0.0, r * 1.05), w));
      return vec2f(min(sdRing(p, r * 0.55, w), ticks), 0.0);
    }
    case 6u: { // node: filled disc with a light rim
      return vec2f(min(sdCircle(p, r * 0.62), sdRing(p, r * 0.9, w)), 0.0);
    }
    case 7u: { // surface point: small X
      let a = r * 0.65;
      return vec2f(min(sdSeg(p, vec2f(-a, -a), vec2f(a, a), w * 1.3), sdSeg(p, vec2f(-a, a), vec2f(a, -a), w * 1.3)), 0.0);
    }
    case 8u: { // pin: head + tail to the tip at the bottom, with a hole
      let head = sdCircle(p - vec2f(0.0, -r * 0.3), r * 0.58);
      let tail = sdSeg(p, vec2f(0.0, -r * 0.1), vec2f(0.0, r * 0.95), r * 0.38);
      let body = min(head, tail);
      let hole = sdCircle(p - vec2f(0.0, -r * 0.3), r * 0.22);
      return vec2f(max(body, -hole), 0.0);
    }
    case 9u: { // pad: rounded square outline with a centre dot
      return vec2f(min(abs(sdBox(p, vec2f(r * 0.8), r * 0.2)) - w * 0.5, sdCircle(p, r * 0.25)), 0.0);
    }
    case 10u, 12u: { // zone centre / debris
      return vec2f(sdCircle(p, r * 0.8), 0.0);
    }
    case 11u: { // vessel: solid arrowhead pointing along +x (the icon is rotated to the velocity on screen)
      let tri = sdTri(vec2f(p.y, -(p.x + r * 0.1)), r * 1.05);
      return vec2f(max(tri, -sdCircle(p + vec2f(r * 1.05, 0.0), r * 0.62)), 0.0);
    }
    case 13u: { // body ring
      return vec2f(sdRing(p, r * 0.8, w), 0.0);
    }
    case 14u: { // prograde: ring, dot, three legs (left, right, up)
      let ring = sdRing(p, r * 0.55, w);
      let legs = min(min(sdSeg(p, vec2f(-r * 0.55, 0.0), vec2f(-r, 0.0), w), sdSeg(p, vec2f(r * 0.55, 0.0), vec2f(r, 0.0), w)), sdSeg(p, vec2f(0.0, -r * 0.55), vec2f(0.0, -r), w));
      return vec2f(min(min(ring, legs), sdCircle(p, r * 0.16)), 0.0);
    }
    case 15u: { // retrograde: ring with an X and three legs (down-left, down-right, up)
      let ring = sdRing(p, r * 0.55, w);
      let a = r * 0.39;
      let x = min(sdSeg(p, vec2f(-a, -a), vec2f(a, a), w), sdSeg(p, vec2f(-a, a), vec2f(a, -a), w));
      let l1 = sdSeg(p, rot2(vec2f(0.0, r * 0.55), 0.785), rot2(vec2f(0.0, r), 0.785), w);
      let l2 = sdSeg(p, rot2(vec2f(0.0, r * 0.55), -0.785), rot2(vec2f(0.0, r), -0.785), w);
      let l3 = sdSeg(p, vec2f(0.0, -r * 0.55), vec2f(0.0, -r), w);
      return vec2f(min(min(ring, x), min(min(l1, l2), l3)), 0.0);
    }
    case 16u: { // normal: triangle outline with a centre dot
      return vec2f(min(abs(sdTri(p, r * 0.95)) - w * 0.5, sdCircle(p, r * 0.15)), 0.0);
    }
    case 17u: { // antinormal: triangle outline with spokes from the centre to the corners
      let tri = abs(sdTri(vec2f(p.x, -p.y), r * 0.95)) - w * 0.5;
      let c = r * 0.95;
      let s1 = sdSeg(p, vec2f(0.0, 0.0), vec2f(0.0, c * 0.75), w);
      let s2 = sdSeg(p, vec2f(0.0, 0.0), vec2f(c * 0.65, -c * 0.37), w);
      let s3 = sdSeg(p, vec2f(0.0, 0.0), vec2f(-c * 0.65, -c * 0.37), w);
      return vec2f(min(tri, min(s1, min(s2, s3))), 0.0);
    }
    case 18u, 19u: { // radial out / in: ring with four diagonal ticks pointing out / in
      let ring = sdRing(p, r * 0.5, w);
      let q = abs(p) * 0.7071;
      let along = q.x + q.y;
      let across = abs(abs(p.x) - abs(p.y)) * 0.7071;
      var tick: f32;
      if (shape == 18u) {
        tick = max(abs(along - r * 0.8) - r * 0.2, across - w * 0.5);
      } else {
        tick = max(abs(along - r * 0.32) - r * 0.13, across - w * 0.5);
        tick = min(tick, sdCircle(p, r * 0.12));
      }
      return vec2f(min(ring, tick), 0.0);
    }
    case 20u: { // bar (rotated rectangle)
      return vec2f(sdBox(p, h, min(h.x, h.y)), 0.0);
    }
    case 21u: { // rounded panel (tooltip background)
      return vec2f(sdBox(p, h, 5.0 * px), 1.0);
    }
    case 22u: { // add-node preview: ring with a plus
      let a = r * 0.42;
      let plus = min(sdSeg(p, vec2f(-a, 0.0), vec2f(a, 0.0), w), sdSeg(p, vec2f(0.0, -a), vec2f(0.0, a), w));
      return vec2f(min(sdRing(p, r * 0.85, w), plus), 0.0);
    }
    default: {
      return vec2f(sdCircle(p, r), 0.0);
    }
  }
}

@fragment
fn fsIcon(i: IconOut) -> @location(0) vec4f {
  let px = U.params.x;
  let r = shapeSd(i.shape, i.local, i.half, px);
  let d = r.x;
  let cov = clamp(0.5 - d, 0.0, 1.0);
  if (r.y > 1.5) {
    // Label plate: plain fill.
    let a = i.color.a * cov;
    if (a <= 0.0) { discard; }
    return vec4f(i.color.rgb * a, a);
  }
  if (r.y > 0.5) {
    // Panel: filled background plus a 1 px edge.
    let edge = clamp(0.5 - abs(d + 0.5 * px), 0.0, 1.0);
    let bg = i.color;
    let a = bg.a * cov;
    let ec = vec3f(0.23, 0.29, 0.38);
    let rgb = mix(bg.rgb, ec, edge * 0.9);
    return vec4f(rgb * a, a);
  }
  // Solid shape over a soft dark outline for contrast on bright planets.
  let halo = clamp(0.5 - (d - 1.6 * px), 0.0, 1.0) * 0.55;
  let a = i.color.a * cov;
  let ha = i.color.a * halo * (1.0 - cov);
  if (a + ha <= 0.0) { discard; }
  return vec4f(i.color.rgb * a, a + ha);
}
`;

export const GLYPH_WGSL = /* wgsl */ `
${COMMON}
@group(0) @binding(1) var atlas: texture_2d<f32>;
struct GlyphIn {
  @location(0) pos: vec2f,
  @location(1) size: vec2f,
  @location(2) uv: vec2f,
  @location(3) color: vec4f,
  @location(4) halo: vec4f,
};
struct GlyphOut {
  @builtin(position) pos: vec4f,
  @location(0) @interpolate(flat) origin: vec2f,
  @location(1) @interpolate(flat) uv: vec2f,
  @location(2) @interpolate(flat) color: vec4f,
  @location(3) @interpolate(flat) halo: vec4f,
};
var<private> GQUAD: array<vec2f, 6> = array<vec2f, 6>(vec2f(0.0, 0.0), vec2f(1.0, 0.0), vec2f(0.0, 1.0), vec2f(0.0, 1.0), vec2f(1.0, 0.0), vec2f(1.0, 1.0));

@vertex
fn vsGlyph(@builtin(vertex_index) vi: u32, g: GlyphIn) -> GlyphOut {
  var o: GlyphOut;
  let p = g.pos + GQUAD[vi] * g.size;
  o.pos = vec4f(p.x * U.viewport.z * 2.0 - 1.0, 1.0 - p.y * U.viewport.w * 2.0, 0.0, 1.0);
  o.origin = g.pos;
  o.uv = g.uv;
  o.color = g.color;
  o.halo = g.halo;
  return o;
}

@fragment
fn fsGlyph(i: GlyphOut) -> @location(0) vec4f {
  let texel = vec2i(floor(i.uv + (i.pos.xy - i.origin)));
  let s = textureLoad(atlas, texel, 0);
  let fill = s.r * i.color.a;
  let halo = s.g * i.halo.a * (1.0 - fill);
  let a = fill + halo;
  if (a <= 0.0) { discard; }
  return vec4f(i.color.rgb * fill + i.halo.rgb * halo, a);
}
`;
