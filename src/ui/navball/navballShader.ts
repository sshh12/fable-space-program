/**
 * WGSL for the navball: an analytically ray-cast textured sphere (exact silhouette and per-pixel normal)
 * rotated by qVesselToHorizon, then the markers and, last, the fixed vessel reticle as premultiplied icon quads
 * clipped to the ball's visible disc. Output is sRGB-encoded, premultiplied by coverage (alpha = coverage).
 *
 * Two looks (Ball.params.z):
 *   0  the shared 512 texture ('ui.navball'): soft shading only, no highlight. The cockpit lights this image
 *      itself as the albedo of its instrument ball, so nothing view-dependent is baked in.
 *   1  the HUD instrument: a strongly rounded sphere (wrap-diffuse key light from the upper left with a dark
 *      terminator side, limb darkening, a contact shadow under the bezel's lip), a faint graded window
 *      reflection on its varnish, a faint Fresnel rim and the bank sky pointer. Label ink (the white markings)
 *      is darkened less than the painted background, so numerals on the shaded side keep their contrast, and it
 *      fades into the background toward the lip, where the sphere foreshortens it.
 * Ball.params.w is the lip: the part of the ball's radius that is drawn (1 for the shared texture; the HUD's
 * bezel covers the outer rim).
 */
export const NAVBALL_WGSL = /* wgsl */ `
struct Ball {
  // Rows of the VES -> horizon rotation matrix.
  r0: vec4f,
  r1: vec4f,
  r2: vec4f,
  // x: ball radius fraction, y: target size in px, z: look (0 shared texture, 1 HUD instrument), w: lip
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

/**
 * The varnish reflection of a window light up and to the left of the instrument. On an orthographic sphere the
 * normal at screen radius r reflects the view ray to the polar angle 2 asin(r), at the screen azimuth of the
 * pixel, so a window spanning a band of polar angles and azimuths reflects as a curved strip parallel to the rim.
 * It lies in the outer band just inside the lip (clear of the numerals nearer the centre), is graded across and
 * along (soft edges several pixels wide, brightest toward the rim and its middle) and stays faint.
 */
fn windowReflection(p: vec2f, r: f32, lip: f32) -> f32 {
  let ang = atan2(p.y, p.x);
  let centre = 1.98;
  let da = abs(atan2(sin(ang - centre), cos(ang - centre)));
  let r0 = lip - 0.15;
  let r1 = lip - 0.02;
  let radial = smoothstep(r0, r0 + 0.06, r) * (1.0 - smoothstep(r1 - 0.03, r1, r));
  let along = 1.0 - smoothstep(0.12, 0.34, da);
  return radial * along * mix(0.45, 1.0, smoothstep(r0, r1, r));
}

/** Signed distance to an isosceles triangle with its tip at the origin and its base at y = q.y (iq). */
fn sdTriangleIsosceles(p0: vec2f, q: vec2f) -> f32 {
  let p = vec2f(abs(p0.x), p0.y);
  let a = p - q * clamp(dot(p, q) / dot(q, q), 0.0, 1.0);
  let b = p - q * vec2f(clamp(p.x / q.x, 0.0, 1.0), 1.0);
  let s = -sign(q.y);
  let d = min(vec2f(dot(a, a), s * (p.x * q.y - p.y * q.x)), vec2f(dot(b, b), s * (p.y - q.y)));
  return -sqrt(d.x) * sign(d.y);
}

@fragment
fn fsBall(in: VsOut) -> @location(0) vec4f {
  let p = in.p;
  let r = length(p);
  let lip = ball.params.w;
  let radiusPx = ball.params.x * ball.params.y * 0.5;
  let coverage = clamp((lip - r) * radiusPx + 0.5, 0.0, 1.0);
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

  let n = vec3f(p.x, p.y, z) / max(1.0, r);
  let L = normalize(vec3f(-0.42, 0.58, 0.7));
  let ndl = dot(n, L);
  var lit: vec3f;
  if (ball.params.z < 0.5) {
    // Shared texture: soft shading only (the cockpit relights it).
    let diffuse = 0.62 + 0.38 * max(ndl, 0.0);
    let limb = 1.0 - 0.36 * pow(1.0 - z, 2.2);
    lit = albedo * diffuse * limb;
  } else {
    // The painted background without its markings: a coarse mip of the same texture (the ink is sparse).
    let bg = textureSampleGrad(ballTex, ballSamp, vec2f(u, v), vec2f(gu.x, gv.x) * 12.0, vec2f(gu.y, gv.y) * 12.0).rgb;
    let ink = smoothstep(0.18, 0.55, min(albedo.r, min(albedo.g, albedo.b)));
    // Markings fade into the paint where the sphere foreshortens them, just inside the lip.
    let inkVisible = mix(0.3, 1.0, smoothstep(0.3, 0.52, z));
    let paint = mix(bg, albedo, inkVisible);
    // Wrap diffuse with a dark terminator side, limb darkening, contact shadow under the lip.
    let wrap = clamp((ndl + 0.3) / 1.3, 0.0, 1.0);
    let diffuse = 0.3 + 0.86 * wrap * wrap * (3.0 - 2.0 * wrap);
    let limb = mix(0.42, 1.0, smoothstep(0.2, 0.75, z));
    let contact = 1.0 - 0.55 * smoothstep(lip - 0.1, lip - 0.004, r);
    let shade = diffuse * limb * contact;
    // Ink keeps more of its brightness than the background (numerals on the dark side stay readable).
    let shadeInk = 0.5 + 0.5 * shade;
    let fresnel = pow(1.0 - z, 5.0);
    let reflection = windowReflection(p, r, lip);
    lit = paint * mix(shade, shadeInk, ink * inkVisible) + vec3f(0.62, 0.68, 0.74) * (reflection * 0.17) + vec3f(0.08, 0.1, 0.13) * fresnel * contact;

    // Bank sky pointer: a white triangle on the rim pointing out at the bezel's roll scale, toward the zenith
    // as projected on the ball (rides with the horizon; fades out with the nose near the vertical, where bank
    // is undefined).
    let zen = ball.r2.xyz;
    let zl = length(zen.xz);
    let show = smoothstep(0.04, 0.14, zl);
    if (show > 0.0) {
      let dir = zen.xz / max(zl, 1e-6);
      let tip = dir * (lip - 0.006);
      let rel = p - tip;
      let q = vec2f(dot(rel, vec2f(-dir.y, dir.x)), dot(rel, -dir));
      let d = sdTriangleIsosceles(q, vec2f(0.062, 0.12));
      let fill = clamp(0.5 - d * radiusPx, 0.0, 1.0) * show;
      let edge = clamp(0.5 - (d - 1.4 / radiusPx) * radiusPx, 0.0, 1.0) * show;
      lit = mix(lit, vec3f(0.006, 0.008, 0.012), edge * 0.85);
      lit = mix(lit, vec3f(0.92, 0.95, 0.98), fill);
    }
  }
  return vec4f(toSrgb(lit) * coverage, coverage);
}

struct VsMarker {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
  @location(1) alpha: f32,
  // Position in normalised ball units (unit disc = ball).
  @location(2) bp: vec2f,
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
  let bp = m.pos.xy + c * half;
  var o: VsMarker;
  o.pos = vec4f(bp * ball.params.x, 0.0, 1.0);
  let t = c * 0.5 + 0.5;
  o.uv = vec2f(mix(m.uv.x, m.uv.z, t.x), mix(m.uv.w, m.uv.y, t.y));
  o.alpha = m.pos.w;
  o.bp = bp;
  return o;
}

@fragment
fn fsMarker(in: VsMarker) -> @location(0) vec4f {
  let c = textureSample(atlasTex, ballSamp, in.uv);
  // Markers lie on the sphere: nothing is drawn outside its visible disc (same edge as the ball's coverage).
  let radiusPx = ball.params.x * ball.params.y * 0.5;
  let inside = clamp((ball.params.w - length(in.bp)) * radiusPx + 0.5, 0.0, 1.0);
  return c * (in.alpha * inside);
}
`;
