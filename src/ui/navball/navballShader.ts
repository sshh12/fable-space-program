/**
 * WGSL for the navball: an analytically ray-cast textured sphere (exact silhouette and per-pixel normal)
 * rotated by qVesselToHorizon and lit softly, then the markers and the reticle as premultiplied icon quads.
 * Output is sRGB-encoded, premultiplied by coverage (alpha = coverage of the ball).
 */
export const NAVBALL_WGSL = /* wgsl */ `
struct Ball {
  // Rows of the VES -> horizon rotation matrix.
  r0: vec4f,
  r1: vec4f,
  r2: vec4f,
  // x: ball radius fraction, y: target size in px, z: texture lod bias, w: unused
  params: vec4f,
};

struct Marker {
  // xy: centre (normalised ball units, +y up), z: half size (ball units), w: alpha
  pos: vec4f,
  // atlas rect u0 v0 u1 v1
  uv: vec4f,
};

struct Markers {
  count: vec4u,
  items: array<Marker, 16>,
};

@group(0) @binding(0) var<uniform> ball: Ball;
@group(0) @binding(1) var ballTex: texture_2d<f32>;
@group(0) @binding(2) var ballSamp: sampler;
@group(0) @binding(3) var<uniform> markers: Markers;
@group(0) @binding(4) var atlasTex: texture_2d<f32>;

const TAU: f32 = 6.283185307179586;
const PI: f32 = 3.141592653589793;

fn toSrgb(c: vec3f) -> vec3f {
  let lo = c * 12.92;
  let hi = 1.055 * pow(max(c, vec3f(0.0)), vec3f(1.0 / 2.4)) - 0.055;
  return select(hi, lo, c <= vec3f(0.0031308));
}

struct VsOut {
  @builtin(position) pos: vec4f,
  @location(0) p: vec2f,
};

@vertex
fn vsBall(@builtin(vertex_index) i: u32) -> VsOut {
  let xy = vec2f(f32((i << 1u) & 2u), f32(i & 2u)) * 2.0 - 1.0;
  var o: VsOut;
  o.pos = vec4f(xy, 0.0, 1.0);
  // Normalised ball coordinates: unit disc = ball, +y up.
  o.p = xy / ball.params.x;
  return o;
}

@fragment
fn fsBall(in: VsOut) -> @location(0) vec4f {
  let p = in.p;
  let r = length(p);
  let radiusPx = ball.params.x * ball.params.y * 0.5;
  let coverage = clamp((1.0 - r) * radiusPx + 0.5, 0.0, 1.0);
  let z = sqrt(max(0.0, 1.0 - min(r * r, 1.0)));

  // Direction shown at this pixel: VES (sx, z, sy) rotated into the horizon frame.
  let dv = vec3f(p.x, z, p.y) / max(1.0, r);
  let dh = vec3f(dot(ball.r0.xyz, dv), dot(ball.r1.xyz, dv), dot(ball.r2.xyz, dv));
  let pitch = asin(clamp(dh.z, -1.0, 1.0));
  let lon = atan2(dh.x, dh.y);
  // Two longitude parameterisations; take the one without the seam here so the mip level stays right.
  let u1 = fract(lon / TAU);
  let u2 = fract(lon / TAU + 0.5) - 0.5;
  let v = 0.5 - pitch / PI;
  let g1 = vec2f(dpdx(u1), dpdy(u1));
  let g2 = vec2f(dpdx(u2), dpdy(u2));
  let useSecond = (abs(g1.x) + abs(g1.y)) > (abs(g2.x) + abs(g2.y)) + 1e-7;
  let u = select(u1, u2, useSecond);
  let gu = select(g1, g2, useSecond);
  let gv = vec2f(dpdx(v), dpdy(v));
  let albedo = textureSampleGrad(ballTex, ballSamp, vec2f(u, v), vec2f(gu.x, gv.x), vec2f(gu.y, gv.y)).rgb;

  // Soft key light from the upper left, wrap-around diffuse, gentle limb darkening and a faint gloss.
  let n = vec3f(p.x, p.y, z) / max(1.0, r);
  let L = normalize(vec3f(-0.38, 0.55, 0.74));
  let diffuse = 0.58 + 0.42 * max(dot(n, L), 0.0);
  let limb = 1.0 - 0.42 * pow(1.0 - z, 2.2);
  let h = normalize(L + vec3f(0.0, 0.0, 1.0));
  let gloss = pow(max(dot(n, h), 0.0), 60.0) * 0.16 + pow(max(dot(n, h), 0.0), 8.0) * 0.035;
  let lit = albedo * diffuse * limb + vec3f(gloss);
  return vec4f(toSrgb(lit) * coverage, coverage);
}

struct VsMarker {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
  @location(1) alpha: f32,
};

@vertex
fn vsMarker(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VsMarker {
  let m = markers.items[ii];
  // Two triangles of a quad.
  var corners = array<vec2f, 6>(vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(-1.0, 1.0), vec2f(-1.0, 1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0));
  let c = corners[vi];
  // Width / height of the cell in pixels (the atlas is four times wider than tall).
  let aspect = (m.uv.z - m.uv.x) / (m.uv.w - m.uv.y) * 4.0;
  let half = vec2f(m.pos.z * aspect, m.pos.z);
  let centre = m.pos.xy * ball.params.x;
  var o: VsMarker;
  o.pos = vec4f(centre + c * half * ball.params.x, 0.0, 1.0);
  let t = c * 0.5 + 0.5;
  o.uv = vec2f(mix(m.uv.x, m.uv.z, t.x), mix(m.uv.w, m.uv.y, t.y));
  o.alpha = m.pos.w;
  return o;
}

@fragment
fn fsMarker(in: VsMarker) -> @location(0) vec4f {
  let c = textureSample(atlasTex, ballSamp, in.uv);
  return c * in.alpha;
}
`;
