/**
 * GPU particles: one pool (ring buffer), emitted, simulated and lit in compute, drawn as soft billboards and
 * motion streaks in the transparent pass.
 *
 * Allocation is a ring: each frame's new particles overwrite the oldest slots, and the CPU keeps the window
 * [cursor - live, cursor) that can still hold living particles, so empty slots are neither simulated nor
 * drawn. Everything random comes from integer hashes of (emitter seed, index): the same emitters give the
 * same particles.
 *
 * Kinds differ only by a few constants (drag, turbulence, ground response, look); the medium does the rest:
 * with no air there is no drag and no turbulence, so dust thrown up on an airless body flies ballistic,
 * radial sheets, and the same dust in air billows.
 */
import { RENDER_FORMATS, type FrameContext, type RenderContext } from '@/core/contracts/render';
import type { Vec3, Vec3Tuple } from '@/core/math';
import type { Tracked } from '@/render/core';
import type { VfxCommon } from './common';
import type { DomainRebase } from './domain';

export const PARTICLE_KIND = { dust: 0, ice: 1, gas: 2, spark: 3, chip: 4, droplet: 5, mist: 6 } as const;
export type ParticleKind = keyof typeof PARTICLE_KIND;
export const PARTICLE_FLOATS = 24;
export const MAX_EMITTERS = 64;
const EMITTER_FLOATS = 36;
const SIM_FLOATS = 44;
const SHAPE = { sphere: 0, ring: 1, cylinder: 2, disc: 3 } as const;

export interface EmitterDesc {
  kind: ParticleKind;
  shape: keyof typeof SHAPE;
  /** Centre of the source and its unit axis, domain coordinates. */
  pos: Vec3;
  axis: Vec3;
  /** Radius of the source (sphere, ring, cylinder, disc), m; length along the axis (cylinder), m. */
  radius: number;
  length?: number;
  /** Velocity added to every particle (domain axes, m/s) and motion of the source during this frame (m). */
  vel: Vec3;
  sweep?: Vec3;
  /** Launch speed range (m/s), distribution exponent (1 = uniform, > 1 = more slow ones). */
  speed: [number, number];
  speedExponent?: number;
  /** Polar angle of the launch direction from the axis, rad. Ring / cylinder / disc sources launch radially. */
  polar: [number, number];
  life: [number, number];
  size: [number, number];
  /** Radius growth, m/s. */
  growth?: number;
  color: Vec3Tuple;
  opacity: number;
  /** Per-kind extra (sparks: initial temperature range, K). */
  aux?: [number, number];
  count: number;
  seed: number;
}

const PARTICLE_WGSL = /* wgsl */ `
struct Particle {
  pos: vec3f, age: f32,        // domain coordinates (m); seconds since birth
  vel: vec3f, life: f32,       // m/s in domain axes; lifetime (0 = dead)
  color: vec4f,                // rgb = albedo (or emission tint), a = opacity
  size: f32, growth: f32, kind: f32, seed: f32,   // radius (m), radius growth (m/s), kind id, random 0..1
  aux: vec4f,                  // x = smoothed sun visibility, y = kind extra (temperature K), z = radius at birth, w = unused
  lum: vec4f,                  // rgb = luminance (cd/m^2, not pre-exposed), a = opacity now
}
struct ParticleU {
  counts: vec4u,       // x = cursor (next slot to write), y = particles to spawn, z = live window, w = emitters
  rebase0: vec4f,      // rows of A, w = a
  rebase1: vec4f,
  rebase2: vec4f,
  rebaseB0: vec4f,     // rows of B, w = b
  rebaseB1: vec4f,
  rebaseB2: vec4f,
  prevRight: vec4f,    // previous camera: right (ROOT axes), w = tan(fovX / 2)
  prevUp: vec4f,       // up, w = tan(fovY / 2)
  prevForward: vec4f,  // forward, w = 1 when the scene depth copy holds a usable previous frame
  flags: vec4f,        // x = 1 apply the re-base, y = shutter time (s), z = pool size, w = pixels per radian
}
const KIND_DUST = 0.0; const KIND_ICE = 1.0; const KIND_GAS = 2.0; const KIND_SPARK = 3.0; const KIND_CHIP = 4.0; const KIND_DROPLET = 5.0; const KIND_MIST = 6.0;
`;

const COMPUTE_WGSL = /* wgsl */ `
#include "vfx_common"
#include "hash"
${PARTICLE_WGSL}
struct Emitter {
  pos: vec4f,      // xyz = centre (domain), w = radius
  axis: vec4f,     // xyz = unit axis, w = shape (0 sphere, 1 ring, 2 cylinder, 3 disc)
  vel: vec4f,      // xyz = base velocity, w = cylinder length
  sweep: vec4f,    // xyz = motion of the source during the frame
  speed: vec4f,    // min, max speed; min, max polar angle from the axis (rad)
  life: vec4f,     // min, max life (s); min, max radius (m)
  color: vec4f,    // rgb, a = opacity
  misc: vec4f,     // kind, growth, first index, count
  misc2: vec4f,    // seed, speed exponent, aux min, aux max
}
@group(2) @binding(0) var<uniform> pu: ParticleU;
@group(2) @binding(1) var<storage, read> emitters: array<Emitter, ${MAX_EMITTERS}>;
@group(2) @binding(2) var<storage, read_write> particles: array<Particle>;

fn rnd(seed: u32, j: u32, k: u32) -> f32 { return hash_to_unit(hash4(i32(seed), i32(j), i32(k), 9173)); }
fn slotOf(i: u32) -> u32 { let n = u32(pu.flags.z); return (pu.counts.x + n - 1u - i) % n; }

@compute @workgroup_size(64) fn emit(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x;
  if (i >= pu.counts.y) { return; }
  var e: Emitter;
  var j = 0u;
  var found = false;
  for (var k = 0u; k < pu.counts.w; k++) {
    let start = u32(emitters[k].misc.z);
    let count = u32(emitters[k].misc.w);
    if (i >= start && i < start + count) { e = emitters[k]; j = i - start; found = true; break; }
  }
  if (!found) { return; }
  let seed = u32(e.misc2.x);
  let ax = e.axis.xyz;
  let t1 = normalize(cross(ax, select(vec3f(0.0, 0.0, 1.0), vec3f(1.0, 0.0, 0.0), abs(ax.z) > 0.9)));
  let t2 = cross(ax, t1);
  let az = rnd(seed, j, 1u) * TWO_PI;
  let radial = t1 * cos(az) + t2 * sin(az);
  let shape = u32(e.axis.w);
  var pos = e.pos.xyz;
  var dirAz = az;
  if (shape == 0u) {
    let z = rnd(seed, j, 2u) * 2.0 - 1.0;
    let a = rnd(seed, j, 3u) * TWO_PI;
    let s = sqrt(max(1.0 - z * z, 0.0));
    pos += vec3f(s * cos(a), s * sin(a), z) * (e.pos.w * pow(rnd(seed, j, 4u), 0.3333));
    dirAz = rnd(seed, j, 5u) * TWO_PI;
  } else if (shape == 1u) {
    pos += radial * (e.pos.w * (0.85 + 0.3 * rnd(seed, j, 2u)));
  } else if (shape == 2u) {
    pos += radial * e.pos.w + ax * (e.vel.w * rnd(seed, j, 2u));
  } else {
    pos += radial * (e.pos.w * sqrt(rnd(seed, j, 2u)));
  }
  // Directions are spread evenly over the solid angle between the two polar angles (evenly in the angle itself
  // they would crowd along the axis: a burst in all directions would be two columns of chips).
  let theta = acos(clamp(mix(cos(e.speed.z), cos(e.speed.w), rnd(seed, j, 6u)), -1.0, 1.0));
  let dir = ax * cos(theta) + (t1 * cos(dirAz) + t2 * sin(dirAz)) * sin(theta);
  let speed = mix(e.speed.x, e.speed.y, pow(rnd(seed, j, 7u), e.misc2.y));
  let sub = rnd(seed, j, 8u);
  var p: Particle;
  p.vel = dir * speed + e.vel.xyz;
  p.age = sub * vfx.time.y;
  // Spread the births over the frame: along the path of the source, then along the particle's own flight.
  p.pos = pos - e.sweep.xyz * sub + p.vel * p.age;
  p.life = mix(e.life.x, e.life.y, rnd(seed, j, 9u));
  p.color = e.color;
  // Sizes: evenly spread for puffs of gas and mist; for things (ice, chips, drops) a wide spread with many
  // small pieces and a few large ones (equal steps of the logarithm, weighted towards the small end).
  let pick = rnd(seed, j, 10u);
  p.size = mix(e.life.z, e.life.w, pick);
  if (e.misc.x == KIND_ICE || e.misc.x == KIND_CHIP || e.misc.x == KIND_DROPLET) { p.size = e.life.z * pow(e.life.w / max(e.life.z, 1e-6), pick * pick * pick); }
  p.growth = e.misc.y;
  p.kind = e.misc.x;
  p.seed = rnd(seed, j, 11u);
  p.aux = vec4f(1.0, mix(e.misc2.z, e.misc2.w, rnd(seed, j, 12u)), p.size, 0.0);
  p.lum = vec4f(0.0);
  particles[slotOf(pu.counts.y - 1u - i)] = p;
}

/// Colour (unit luminance-ish) and luminance (cd/m^2) of a glowing body at temperature T (K).
fn glow(T: f32) -> vec3f {
  let g = pow(saturate((T - 900.0) / 2300.0), 1.3);
  let b = pow(saturate((T - 1700.0) / 2600.0), 2.0);
  return vec3f(1.0, g, b) * (2.5e4 * pow(max(T, 300.0) / 2000.0, 6.0));
}

@compute @workgroup_size(64) fn simulate(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= pu.counts.z) { return; }
  let slot = slotOf(id.x);
  var p = particles[slot];
  if (p.life <= 0.0) { return; }
  let dt = vfx.time.y;
  if (pu.flags.x > 0.5) {
    let q = p.pos;
    p.pos = vec3f(dot(pu.rebase0.xyz, q) + pu.rebase0.w, dot(pu.rebase1.xyz, q) + pu.rebase1.w, dot(pu.rebase2.xyz, q) + pu.rebase2.w);
    p.vel = vec3f(dot(pu.rebase0.xyz, p.vel), dot(pu.rebase1.xyz, p.vel), dot(pu.rebase2.xyz, p.vel))
          + vec3f(dot(pu.rebaseB0.xyz, q) + pu.rebaseB0.w, dot(pu.rebaseB1.xyz, q) + pu.rebaseB1.w, dot(pu.rebaseB2.xyz, q) + pu.rebaseB2.w);
  }
  p.age += dt;
  if (p.age >= p.life) {
    p.life = 0.0;
    p.lum = vec4f(0.0);
    particles[slot] = p;
    return;
  }
  let kind = p.kind;
  let up = vfx.domUp.xyz;
  let surface = vfx.domZ.w > 0.5;
  let h = dot(up, p.pos);
  let rho = select(0.0, vfx.domOrigin.w * exp(-clamp(h / max(vfx.domY.w, 100.0), -4.0, 30.0)), surface);

  // Per kind: drag area per mass (m^2/kg), turbulence (m/s at sea-level density), weight (fraction of gravity).
  var k = 40.0; var turb = 2.5; var weight = 1.0;
  if (kind == KIND_ICE) { k = 0.6; turb = 0.6; }
  else if (kind == KIND_GAS) { k = 300.0; turb = 3.0; weight = 0.0; }
  else if (kind == KIND_SPARK) { k = 0.15; turb = 0.0; }
  else if (kind == KIND_CHIP) { k = 0.03; turb = 0.0; }
  else if (kind == KIND_DROPLET) { k = 0.09; turb = 0.0; }
  else if (kind == KIND_MIST) { k = 7.0; turb = 1.6; weight = 0.3; }

  if (dt > 0.0) {
    var v = p.vel;
    if (surface) { v -= up * (vfx.domX.w * weight * dt); }
    // Quadratic drag against the air (at rest in a surface domain), implicit in the speed.
    let wind = vfx.windDom.xyz;
    var rel = v - wind;
    rel = rel / (1.0 + k * rho * length(rel) * dt);
    if (turb > 0.0 && rho > 1e-6) {
      let c = vfxCurl(p.pos * 0.011 + vec3f(0.0, vfx.time.z * 0.03, p.seed * 0.2)) + 0.5 * vfxCurl(p.pos * 0.037 - vec3f(vfx.time.z * 0.05));
      rel += c * (turb * sqrt(min(rho / 1.2, 1.0)) * min(1.0, k * rho * dt * 8.0));
    }
    v = rel + wind;
    var pos = p.pos + v * dt;

    // Ground plane and water plane of the domain.
    let ground = vfx.domUp.w;
    let water = vfx.domPrevOrigin.w;
    var hh = dot(up, pos);
    var floor = ground;
    // Terrain from the previous frame's depth: where the visible surface next to the particle stands higher
    // than the plane, the particle rides over it.
    if (pu.prevForward.w > 0.5 && (kind == KIND_DUST || kind == KIND_CHIP || kind == KIND_SPARK)) {
      let pr = vfxDomainToRelPrev(pos);
      let clip = frame.prevViewProj * vec4f(pr, 1.0);
      if (clip.w > 0.1) {
        let ndc = clip.xy / clip.w;
        if (abs(ndc.x) < 0.98 && abs(ndc.y) < 0.98) {
          let size = vec2f(textureDimensions(sceneDepthTex));
          let pix = vec2i(vec2f(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5) * size);
          let d = textureLoad(sceneDepthTex, pix, 0);
          if (d > 0.0) {
            let z = frame.cameraForward.w / d;
            let ray = pu.prevForward.xyz + pu.prevRight.xyz * (ndc.x * pu.prevRight.w) + pu.prevUp.xyz * (ndc.y * pu.prevUp.w);
            let surf = ray * z;
            if (distance(surf, pr) < 1.5 + 0.02 * z) {
              let ds = surf - vfx.domPrevOrigin.xyz;
              let sDom = vec3f(dot(ds, vfx.domPrevX.xyz), dot(ds, vfx.domPrevY.xyz), dot(ds, vfx.domPrevZ.xyz));
              floor = max(floor, dot(up, sDom));
            }
          }
        }
      }
    }
    if (kind == KIND_DROPLET || kind == KIND_MIST) { floor = max(floor, water); }
    if (hh < floor + p.size) {
      let vn = dot(v, up);
      if (kind == KIND_DROPLET || kind == KIND_ICE) {
        // Falling back into the water / onto the ground ends it; on the way up it has only just been thrown.
        if (vn < 0.0 && hh < floor) { p.life = 0.0; }
      } else {
        if (kind == KIND_SPARK || kind == KIND_CHIP) {
          if (vn < 0.0) { v = (v - up * vn) * 0.6 - up * (vn * 0.3); }
        } else if (vn < 0.0) {
          v -= up * vn;
        }
        pos += up * (floor + p.size - hh);
      }
    }
    p.vel = v;
    p.pos = pos;
    p.size += p.growth * dt;
  }

  // ---- lighting (every frame, also while the clock stands still: the camera may move)
  let rel = vfxDomainToRel(p.pos);
  let dist = max(length(rel), 1e-3);
  let V = -rel / dist;
  let probe = vfxProbes[0];
  var lit = p.aux.x;
  if (kind != KIND_SPARK && ((id.x + u32(vfx.misc.x)) & 3u) == 0u) {
    // One jittered shadow tap every fourth step, smoothed over about a quarter of a second: a particle at
    // the edge of a shadow fades across it and does not flicker with the jitter.
    let s = sampleSunShadow(rel, frame.sunDir.xyz, vec2u(id.x & 63u, (id.x >> 6u) & 63u));
    lit = mix(lit, s, 0.22);
  }
  p.aux.x = lit;
  let fade = smoothstep(0.0, 0.06 * p.life + 0.01, p.age) * (1.0 - smoothstep(0.65 * p.life, p.life, p.age));
  var alpha = p.color.a * fade;
  var lum: vec3f;
  if (kind == KIND_SPARK) {
    let T = p.aux.y * pow(max(1.0 - p.age / p.life, 0.0), 0.6);
    lum = p.color.rgb * glow(T);
  } else {
    // Small scatterers: forward-peaked for dust, spray and ice, nearly isotropic for gas and mist.
    var g = 0.55;
    if (kind == KIND_GAS || kind == KIND_MIST) { g = 0.25; }
    if (kind == KIND_CHIP) { g = 0.0; }
    let cosT = dot(-frame.sunDir.xyz, V);
    let hg = (1.0 - g * g) / pow(1.0 + g * g - 2.0 * g * cosT, 1.5);
    let phase = mix(1.0, hg, 0.75);
    let direct = probe.sun.rgb * (lit * phase) + vfxLocalLights(rel);
    lum = p.color.rgb * (direct * (0.5 / PI) + vfxProbeAmbient(0u) * (1.0 / PI));
    if (kind == KIND_ICE || kind == KIND_CHIP) {
      // Tumbling facets flash in the sun.
      let glint = pow(saturate(sin(p.seed * 91.0 + p.age * (9.0 + 30.0 * p.seed))), 24.0);
      lum += probe.sun.rgb * (lit * glint * select(0.5, 2.5, kind == KIND_ICE));
    }
    if (kind == KIND_DROPLET) {
      // White water: as bright as the sheet it was torn from (a sunlit white surface), and every drop is a lens
      // that flashes when it lines up with the sun.
      lum = p.color.rgb * (probe.sun.rgb * lit + vfxLocalLights(rel) + vfxProbeAmbient(0u)) * (1.0 / PI);
      let glint = pow(saturate(sin(p.seed * 113.0 + p.age * (14.0 + 45.0 * p.seed))), 16.0);
      lum += probe.sun.rgb * (lit * glint * 1.2);
    }
    if (kind == KIND_GAS) { alpha *= sq(p.aux.z / max(p.size, 1e-3)); }
  }
  p.lum = vec4f(lum, alpha);
  particles[slot] = p;
}
`;

const RENDER_WGSL = /* wgsl */ `
#include "vfx_common"
${PARTICLE_WGSL}
@group(2) @binding(0) var<uniform> pu: ParticleU;
@group(2) @binding(1) var<storage, read> particles: array<Particle>;
@group(2) @binding(2) var volumeTex: texture_2d<f32>;        // the half-resolution volume image: a = opacity
@group(2) @binding(3) var volumeMomentTex: texture_2d<f32>;  // r = weight x log2(distance), g = weight

struct VOut {
  @builtin(position) clip: vec4f,
  @location(0) local: vec2f,                      // along / across the streak axis, in radii
  @location(1) @interpolate(flat) half: f32,      // half length of the streak in radii
  @location(2) @interpolate(flat) lum: vec4f,     // pre-exposed radiance, opacity
  @location(3) @interpolate(flat) info: vec4f,    // distance from the eye (m), soft-depth range (m), kind, view z
}
@vertex fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VOut {
  var o: VOut;
  o.clip = vec4f(2.0, 2.0, 2.0, 1.0);
  let n = u32(pu.flags.z);
  let p = particles[(pu.counts.x + n - 1u - ii) % n];
  if (p.life <= 0.0 || p.lum.a <= 0.0005) { return o; }
  let c = vfxDomainToRel(p.pos);
  let dist = length(c);
  let viewZ = dot(c, frame.cameraForward.xyz);
  if (viewZ < 0.1) { return o; }
  let V = -c / dist;
  // Velocity relative to the camera: the particle's own plus the motion of the domain past the eye.
  var vrel = vfxDomainDir(p.vel);
  if (frame.time.y > 1e-5) { vrel += (vfx.domOrigin.xyz - vfx.domPrevOrigin.xyz) / frame.time.y; }
  var vperp = vrel - V * dot(vrel, V);
  let speed = length(vperp);
  let kind = p.kind;
  // Streak length = relative speed x exposure time: long for the fast, fine stuff, none for puffs.
  var stretch = 1.0;
  if (kind == KIND_DUST) { stretch = 3.0; }
  if (kind == KIND_DROPLET) { stretch = 2.0; }
  if (kind == KIND_GAS || kind == KIND_MIST) { stretch = 0.0; }
  if (kind == KIND_ICE || kind == KIND_CHIP) { stretch = 0.35; }
  var axis = frame.cameraRight.xyz;
  if (speed > 1e-3) { axis = vperp / speed; }
  let side = normalize(cross(V, axis));
  // Never smaller than a pixel across: widen and dim instead (a dot smaller than the pixel grid is there in
  // one jittered frame and gone in the next, and the temporal filter turns that into flicker).
  let pixel = viewZ / pu.flags.w;
  var radius = p.size;
  var alpha = p.lum.a;
  // (The floor itself differs from particle to particle by a third, so that a cloud of specks is not a row of equal dots.)
  let minR = (0.7 + 0.45 * p.seed) * pixel;
  if (radius < minR) { alpha *= pow(radius / minR, 1.5); radius = minR; }
  // A particle that fills the view fades out (the eye is inside the cloud).
  alpha *= saturate(2.0 - radius / (220.0 * pixel));
  let halfLen = min(speed * pu.flags.y * 0.5 * stretch, 150.0 * radius + 4.0);
  // The same light spread over a longer streak is dimmer.
  alpha *= radius / (radius + 0.25 * halfLen);
  let q = vec2f(f32(vi & 1u) * 2.0 - 1.0, f32((vi >> 1u) & 1u) * 2.0 - 1.0);
  let world = c + axis * (q.x * (halfLen + radius)) + side * (q.y * radius);
  o.clip = frame.viewProj * vec4f(world, 1.0);
  o.local = vec2f(q.x * (halfLen + radius) / radius, q.y);
  o.half = halfLen / radius;
  o.lum = vec4f(p.lum.rgb * frame.exposure.x, alpha);
  o.info = vec4f(dist, max(2.0 * radius, 0.25), kind, viewZ);
  return o;
}

@fragment fn fs(in: VOut) -> @location(0) vec4f {
  let r = length(vec2f(max(abs(in.local.x) - in.half, 0.0), in.local.y));
  if (r >= 1.0) { discard; }
  let kind = in.info.z;
  var fall = 1.0 - smoothstep(0.3, 1.0, r);
  if (kind == KIND_GAS || kind == KIND_MIST) { fall = exp(-3.5 * r * r) * (1.0 - smoothstep(0.7, 1.0, r)); }
  if (kind == KIND_DUST || kind == KIND_DROPLET) {
    // A soft streak: no edge across it, and it thins out towards both ends.
    let u = in.local.x / (in.half + 1.0);
    let ends = 1.0 - u * u;
    fall = exp(-3.2 * in.local.y * in.local.y) * (1.0 - smoothstep(0.75, 1.0, abs(in.local.y))) * ends * ends;
  }
  let sceneZ = viewZFromDepth(textureLoad(sceneDepthTex, vec2i(in.clip.xy), 0));
  let soft = saturate((sceneZ - in.info.w) / in.info.y);
  let uv = in.clip.xy * frame.renderSize.zw;
  // The half-resolution volumes are in the image already. A particle behind what they show is hidden by
  // their opacity, and where they glow in front of it, it must not cover that glow.
  let vol = textureSampleLevel(volumeTex, linearClamp, uv, 0.0);
  let mom = textureSampleLevel(volumeMomentTex, linearClamp, uv, 0.0).rg;
  var seen = 1.0;
  var under = 0.0;
  if (mom.g > 1e-3) {
    let tv = exp2(mom.r / mom.g);
    let behind = smoothstep(0.9 * tv, 1.1 * tv + 0.5, in.info.x);
    let glow = luminance(vol.rgb);
    seen = 1.0 - behind * saturate(vol.a);
    under = behind * glow / (glow + 0.5);
  }
  let a = in.lum.a * fall * soft * seen;
  // Glowing particles add light and hide nothing.
  let cover = select(a * (1.0 - under), 0.0, kind == KIND_SPARK);
  let c = vfxAtmosphere(uv, in.info.x, in.lum.rgb * a, cover);
  return vec4f(writeHdr(c.rgb), saturate(c.a));
}
`;

export class ParticleSystem {
  readonly pool: number;
  private readonly device: GPUDevice;
  private readonly buffer: GPUBuffer;
  private readonly simData = new ArrayBuffer(SIM_FLOATS * 4);
  private readonly simF = new Float32Array(this.simData);
  private readonly simU = new Uint32Array(this.simData);
  private readonly simBuffer: GPUBuffer;
  private readonly emitterData = new Float32Array(MAX_EMITTERS * EMITTER_FLOATS);
  private readonly emitterBuffer: GPUBuffer;
  private readonly computeGroup: GPUBindGroup;
  private readonly renderLayout: GPUBindGroupLayout;
  private renderGroup: GPUBindGroup | null = null;
  private renderVersion = -1;
  private readonly emitPipeline: GPUComputePipeline;
  private readonly simPipeline: GPUComputePipeline;
  private readonly renderPipeline: Tracked<GPURenderPipeline>;
  private queue: EmitterDesc[] = [];
  private cursor = 0;
  private spawnNow = 0;
  private live = 0;
  /**
   * Births in ring order: [effect time by which all of them are dead, count]. The live window reaches back
   * to the oldest batch that can still hold a living particle.
   */
  private births: [number, number][] = [];
  private needsClear = false;
  /** Particles spawned in total (diagnostics). */
  spawnedTotal = 0;

  constructor(
    private readonly ctx: RenderContext,
    private readonly common: VfxCommon,
    pool: number,
    private readonly maxSpawn: number,
  ) {
    const device = (this.device = ctx.device);
    this.pool = pool;
    this.buffer = device.createBuffer({ label: 'vfx.particles', size: pool * PARTICLE_FLOATS * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
    this.simBuffer = device.createBuffer({ label: 'vfx.particles.sim', size: SIM_FLOATS * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.emitterBuffer = device.createBuffer({ label: 'vfx.particles.emitters', size: this.emitterData.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    const computeLayout = device.createBindGroupLayout({
      label: 'vfx.particles.compute',
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      ],
    });
    const renderLayout = (this.renderLayout = device.createBindGroupLayout({
      label: 'vfx.particles.render',
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
      ],
    }));
    this.computeGroup = device.createBindGroup({
      label: 'vfx.particles.compute',
      layout: computeLayout,
      entries: [
        { binding: 0, resource: { buffer: this.simBuffer } },
        { binding: 1, resource: { buffer: this.emitterBuffer } },
        { binding: 2, resource: { buffer: this.buffer } },
      ],
    });
    const computeModule = ctx.shaders.createModule('vfx.particles.compute', COMPUTE_WGSL);
    const pipelineLayout = device.createPipelineLayout({ label: 'vfx.particles.compute', bindGroupLayouts: [ctx.frameBindGroupLayout, common.layout, computeLayout] });
    this.emitPipeline = device.createComputePipeline({ label: 'vfx.particles.emit', layout: pipelineLayout, compute: { module: computeModule, entryPoint: 'emit' } });
    this.simPipeline = device.createComputePipeline({ label: 'vfx.particles.simulate', layout: pipelineLayout, compute: { module: computeModule, entryPoint: 'simulate' } });
    this.renderPipeline = common.core.shaders.tracked(() => {
      const module = ctx.shaders.createModule('vfx.particles.render', RENDER_WGSL);
      return device.createRenderPipeline({
        label: 'vfx.particles.render',
        layout: device.createPipelineLayout({ label: 'vfx.particles.render', bindGroupLayouts: [ctx.frameBindGroupLayout, common.layout, renderLayout] }),
        vertex: { module, entryPoint: 'vs' },
        fragment: {
          module,
          entryPoint: 'fs',
          targets: [{ format: RENDER_FORMATS.hdr, blend: { color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' }, alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' } } }],
        },
        primitive: { topology: 'triangle-strip', cullMode: 'none' },
        depthStencil: { format: RENDER_FORMATS.depth, depthWriteEnabled: false, depthCompare: 'greater-equal' },
      });
    });
    this.renderPipeline.get();
  }

  /** Queue an emitter for this frame (domain coordinates). Fractional counts must be accumulated by the caller. */
  emit(e: EmitterDesc): void {
    if (e.count >= 1 && this.queue.length < MAX_EMITTERS) this.queue.push(e);
  }

  /** Drop every particle (domain reset). */
  clear(): void {
    this.needsClear = true;
    this.births = [];
    this.live = 0;
    this.cursor = 0;
  }

  /** Size of the live window of the ring: an upper bound of the living particles (`read()` counts them exactly). */
  get alive(): number {
    return this.live;
  }

  /** Pack this frame's emitters and simulation constants (end of prepare). */
  prepare(frame: FrameContext, effectTime: number, rebase: DomainRebase | null, depthUsable: boolean): void {
    const E = this.emitterData;
    let total = 0;
    let count = 0;
    let expiry = 0;
    for (const e of this.queue) {
      const n = Math.min(Math.floor(e.count), this.maxSpawn - total);
      if (n <= 0) break;
      const o = count * EMITTER_FLOATS;
      E.set([e.pos.x, e.pos.y, e.pos.z, e.radius], o);
      E.set([e.axis.x, e.axis.y, e.axis.z, SHAPE[e.shape]], o + 4);
      E.set([e.vel.x, e.vel.y, e.vel.z, e.length ?? 0], o + 8);
      E.set([e.sweep?.x ?? 0, e.sweep?.y ?? 0, e.sweep?.z ?? 0, 0], o + 12);
      E.set([e.speed[0], e.speed[1], e.polar[0], e.polar[1]], o + 16);
      E.set([e.life[0], e.life[1], e.size[0], e.size[1]], o + 20);
      E.set([e.color[0], e.color[1], e.color[2], e.opacity], o + 24);
      E.set([PARTICLE_KIND[e.kind], e.growth ?? 0, total, n], o + 28);
      E.set([e.seed >>> 0, e.speedExponent ?? 1, e.aux?.[0] ?? 0, e.aux?.[1] ?? 0], o + 32);
      total += n;
      count++;
      expiry = Math.max(expiry, effectTime + e.life[1] + 0.1);
    }
    this.queue = [];
    this.spawnNow = total;
    this.spawnedTotal += total;
    if (count > 0) this.device.queue.writeBuffer(this.emitterBuffer, 0, E, 0, count * EMITTER_FLOATS);

    // Live window: from the oldest batch that may still hold a living particle to this frame's births.
    if (total > 0) this.births.push([expiry, total]);
    while (this.births.length > 0 && effectTime > this.births[0]![0]) this.births.shift();
    let live = 0;
    for (const b of this.births) live += b[1];
    this.live = Math.min(this.pool, live);
    this.cursor = (this.cursor + total) % this.pool;

    const f = this.simF;
    const u = this.simU;
    u[0] = this.cursor;
    u[1] = total;
    u[2] = this.live;
    u[3] = count;
    if (rebase) {
      for (let r = 0; r < 3; r++) {
        f.set([rebase.A[r * 3]!, rebase.A[r * 3 + 1]!, rebase.A[r * 3 + 2]!, r === 0 ? rebase.a.x : r === 1 ? rebase.a.y : rebase.a.z], 4 + r * 4);
        f.set([rebase.B[r * 3]!, rebase.B[r * 3 + 1]!, rebase.B[r * 3 + 2]!, r === 0 ? rebase.b.x : r === 1 ? rebase.b.y : rebase.b.z], 16 + r * 4);
      }
    }
    const cam = frame.prevCamera;
    const q = cam.qViewToRoot;
    const rot = (x: number, y: number, z: number): [number, number, number] => {
      const tx = 2 * (q.y * z - q.z * y);
      const ty = 2 * (q.z * x - q.x * z);
      const tz = 2 * (q.x * y - q.y * x);
      return [x + q.w * tx + (q.y * tz - q.z * ty), y + q.w * ty + (q.z * tx - q.x * tz), z + q.w * tz + (q.x * ty - q.y * tx)];
    };
    const tanY = Math.tan(cam.fovY / 2);
    const tanX = tanY * (frame.renderSize[0] / frame.renderSize[1]);
    f.set([...rot(1, 0, 0), tanX], 28);
    f.set([...rot(0, 1, 0), tanY], 32);
    f.set([...rot(0, 0, -1), depthUsable ? 1 : 0], 36);
    f.set([rebase ? 1 : 0, 1 / 120, this.pool, frame.renderSize[1] / (2 * Math.tan(frame.camera.fovY / 2))], 40);
    this.device.queue.writeBuffer(this.simBuffer, 0, this.simData);
  }

  /** compute hook: births, then one simulation and lighting step of the live window. */
  compute(frame: FrameContext, encoder: GPUCommandEncoder): void {
    if (this.needsClear) {
      this.needsClear = false;
      encoder.clearBuffer(this.buffer);
    }
    if (this.live === 0 && this.spawnNow === 0) return;
    const pass = encoder.beginComputePass({ label: 'vfx.particles', timestampWrites: this.ctx.perf.gpuPass('vfx.particles.sim') as GPUComputePassTimestampWrites | undefined });
    pass.setBindGroup(0, frame.frameBindGroup);
    pass.setBindGroup(1, this.common.bindGroup());
    pass.setBindGroup(2, this.computeGroup);
    if (this.spawnNow > 0) {
      pass.setPipeline(this.emitPipeline);
      pass.dispatchWorkgroups(Math.ceil(this.spawnNow / 64));
    }
    if (this.live > 0) {
      pass.setPipeline(this.simPipeline);
      pass.dispatchWorkgroups(Math.ceil(this.live / 64));
    }
    pass.end();
  }

  /** drawTransparent: one instanced draw of the live window, after (and aware of) the half-resolution volume image. */
  draw(pass: GPURenderPassEncoder, image: { color: GPUTextureView; moment: GPUTextureView; version: number }): void {
    if (this.live === 0) return;
    if (!this.renderGroup || image.version !== this.renderVersion) {
      this.renderVersion = image.version;
      this.renderGroup = this.device.createBindGroup({
        label: 'vfx.particles.render',
        layout: this.renderLayout,
        entries: [{ binding: 0, resource: { buffer: this.simBuffer } }, { binding: 1, resource: { buffer: this.buffer } }, { binding: 2, resource: image.color }, { binding: 3, resource: image.moment }],
      });
    }
    pass.setPipeline(this.renderPipeline.get());
    pass.setBindGroup(1, this.common.bindGroup());
    pass.setBindGroup(2, this.renderGroup);
    pass.draw(4, this.live);
  }

  /** Read back the whole pool (tests: determinism). */
  async read(): Promise<Float32Array> {
    const size = this.pool * PARTICLE_FLOATS * 4;
    const staging = this.device.createBuffer({ label: 'vfx.particles.read', size, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const encoder = this.device.createCommandEncoder({ label: 'vfx.particles.read' });
    encoder.copyBufferToBuffer(this.buffer, 0, staging, 0, size);
    this.device.queue.submit([encoder.finish()]);
    await staging.mapAsync(GPUMapMode.READ);
    const out = new Float32Array(staging.getMappedRange().slice(0));
    staging.unmap();
    staging.destroy();
    return out;
  }

  dispose(): void {
    this.buffer.destroy();
    this.simBuffer.destroy();
    this.emitterBuffer.destroy();
  }
}
