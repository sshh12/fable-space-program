/**
 * Pad smoke and steam: a density volume anchored to a launch site, advected in compute through an analytic
 * flow, lit by the sun (a light volume holds the transmittance towards it) and by the plume, eroded with
 * detail noise in the march.
 *
 * The flow: the jets of the vehicle run down to the pad as a free jet that carries no smoke of its own and
 * draws the air around it in (entrainment); where it meets the ground it runs out as a wall jet focused
 * along the flame trench, slows, rises on its own heat once it has slowed and drifts with the wind. While
 * the vehicle stands over the trench, smoke and steam come out at the far end of the trench, not at the
 * mount; as it climbs, its jet spreads over the open pad and the source moves under it. So the cloud forms
 * from the wall jet outwards and rises around the jet, never through it.
 *
 * Grid: rgba16float, r = extinction of exhaust smoke (1/m), g = extinction of deluge steam (1/m), b = heat
 * 0..1. The cells are 3.75 m at the pad and grow outwards and upwards (x = S a / (1 - c |a|)), so the same
 * 160 x 96 x 160 cells resolve the mount and still hold a cloud 1.8 km across. Only the box of cells that
 * the cloud has reached is simulated.
 *
 * The march runs at a QUARTER of the internal resolution, inside the screen rectangle of the cloud, so its
 * cost does not follow the screen coverage of the cloud; a second pass brings it to the half-resolution
 * volume image with depth-aware weights and composes it with the emitters drawn before it (plumes,
 * fireballs): the march accumulates the smoke in front of and behind their mean distance separately. Each
 * quarter-resolution ray keeps two results, cut at the nearest and at the farthest scene depth of its 2 x 2
 * block of half-resolution pixels, so a mast or a hull edge in front of the cloud is not painted over.
 */
import type { LaunchSiteDef } from '@/core/contracts/defs';
import { RENDER_FORMATS, type FrameContext, type RenderContext } from '@/core/contracts/render';
import { latLonToDir } from '@/core/geo/cubeSphere';
import { DEG, quat, v3, type Vec3, type Vec3Tuple } from '@/core/math';
import type { ManagedTarget, Tracked } from '@/render/core';
import type { VfxCommon } from './common';
import { PROBE_PAD } from './common';
import type { VfxData } from './data';
import type { PlacedCluster } from './plumes';
import type { VolumeCombiner } from './volumes';

const U_FLOATS = 96;
/** Float offsets into SmokeU that are written outside `update`. */
const U_EMITTERS = 47;
const U_BOX = 88;

const GRID_WGSL = /* wgsl */ `
struct SmokeU {
  origin: vec4f,      // xyz = pad centre on the ground relative to the camera (ROOT axes), w = source strength 0..1
  axisE: vec4f,       // xyz = east (ROOT axes), w = S: horizontal scale of the grid (m)
  axisU: vec4f,       // xyz = up, w = c: horizontal warp
  axisN: vec4f,       // xyz = north, w = Sy: vertical scale (m)
  grid: vec4f,        // x = cy: vertical warp, y = half extent (m), z = height (m), w = march steps
  source: vec4f,      // xyz = where the jet meets the pad, site frame (east, up, north), w = height of the nozzles above the pad (m)
  rate: vec4f,        // x = smoke source (m^2 of extinction cross-section per second), y = steam source, z = source radius (m), w = trench focus now
  trench: vec4f,      // xy = unit direction of the flame trench (east, north), z = trench length (m), w = unused
  flow: vec4f,        // wall-jet speed at the source (m/s), wall-jet radius (m), buoyant rise at heat 1 (m/s), cooling (1/s)
  flow2: vec4f,       // turbulence, dissipation (1/s), wind east, wind north (m/s)
  sunSite: vec4f,     // xyz = unit direction to the sun in the site frame (east, up, north), w = dt (s)
  lightA: vec4f,      // xyz = near end of the plume light (a segment along the jet) in the site frame, w = 1 when emitters were drawn this frame
  lightColor: vec4f,  // rgb = plume light intensity (cd), w = strength of the cloud's shadow on the ground 0..1
  smokeAlbedo: vec4f, // rgb, w = erosion amount
  steamAlbedo: vec4f, // rgb, w = erosion noise scale (1/m)
  misc: vec4f,        // x = 1: clear the grid, y = time (s)
  glow: vec4f,        // rgb = colour x luminance of gas fresh from the plume (cd/m^2)
  cloud: vec4f,       // a cylinder that holds the cloud: xy = centre (east, north), z = radius (m), w = height (m)
  jetTop: vec4f,      // xyz = where the jets leave the vehicle, site frame, w = radius of the jet there (m)
  jetDir: vec4f,      // xyz = unit direction of the jet (site frame), w = its length down to the pad (m)
  jetFlow: vec4f,     // x = gas speed in the jet (m/s), y = entrainment coefficient, z = spread (m of radius per m), w = strength 0..1
  lightB: vec4f,      // xyz = far end of the plume light, site frame
  box: vec4f,         // xyz = first cell of the simulated box (advection), w = unused
  boxLight: vec4f,    // xyz = first cell of the box in the light volume
}
fn smokeToUvw(p: vec3f) -> vec3f {
  let S = su.axisE.w;
  let c = su.axisU.w;
  let y = max(p.y, 0.0);
  return vec3f(0.5 + 0.5 * p.x / (S + c * abs(p.x)), y / (su.axisN.w + su.grid.x * y), 0.5 + 0.5 * p.z / (S + c * abs(p.z)));
}
fn smokeFromUvw(u: vec3f) -> vec3f {
  let a = u.x * 2.0 - 1.0;
  let b = u.z * 2.0 - 1.0;
  return vec3f(su.axisE.w * a / (1.0 - su.axisU.w * abs(a)), su.axisN.w * u.y / (1.0 - su.grid.x * u.y), su.axisE.w * b / (1.0 - su.axisU.w * abs(b)));
}
/// Nearest point of the plume light (the segment lightA..lightB) to 'p'.
fn plumeLightPoint(p: vec3f) -> vec3f {
  let ab = su.lightB.xyz - su.lightA.xyz;
  let t = saturate(dot(p - su.lightA.xyz, ab) / max(dot(ab, ab), 1e-3));
  return su.lightA.xyz + ab * t;
}
`;

const COMPUTE_WGSL = /* wgsl */ `
#include "vfx_common"
${GRID_WGSL}
@group(2) @binding(0) var<uniform> su: SmokeU;
@group(2) @binding(1) var src: texture_3d<f32>;
@group(2) @binding(2) var dst: texture_storage_3d<rgba16float, write>;

struct JetAt {
  core: f32,      // 1 inside the jet .. 0 outside
  column: f32,    // 1 between the nozzles and the pad
  radial: vec3f,  // from the axis to the point (m)
  dist: f32,      // distance from the axis (m)
  radius: f32,    // radius of the jet at this station (m)
}
/// Where 'p' (site frame) lies relative to the free jet between the vehicle and the pad.
fn jetAt(p: vec3f) -> JetAt {
  var j: JetAt;
  let q = p - su.jetTop.xyz;
  let along = dot(q, su.jetDir.xyz);
  j.radial = q - su.jetDir.xyz * along;
  j.dist = length(j.radial);
  let r0 = max(su.jetTop.w, 0.5);
  j.radius = r0 + su.jetFlow.z * max(along, 0.0);
  let L = su.jetDir.w;
  j.column = smoothstep(-1.5 * r0, 0.0, along) * (1.0 - smoothstep(L, L + 4.0, along)) * su.jetFlow.w * step(1.0, L);
  j.core = (1.0 - smoothstep(0.75 * j.radius, 1.35 * j.radius, j.dist)) * j.column;
  return j;
}

/// The analytic flow at a point of the site frame (east, up, north), m/s. 'heat' = heat of the gas there.
fn smokeVelocity(p: vec3f, heat: f32) -> vec3f {
  let d = p.xz - su.source.xz;
  let r = length(d);
  let rh = d / max(r, 0.5);
  // Wall jet from the foot of the plume: 1 / r decay, thickening with distance, focused along the trench.
  let F = su.rate.w;
  let lobe = pow(max(dot(rh, su.trench.xy), 0.0), 3.0);
  let w = (1.0 - F) + F * 2.6 * lobe;
  let r0 = su.flow.y;
  let delta = 5.0 + 0.14 * r;
  let U = su.origin.w * su.flow.x * (r0 / (r + r0)) * w * exp(-p.y / delta);
  var v = vec3f(rh.x * U, U * 0.14 * (p.y / delta), rh.y * U);
  // The free jet above it: straight down inside (stagnating at the pad), and the air around is drawn in.
  let j = jetAt(p);
  let stagnation = saturate(p.y / (1.2 * j.radius));
  v += su.jetDir.xyz * (su.jetFlow.x * j.core * stagnation);
  let inflow = su.jetFlow.y * su.jetFlow.x * j.column * (1.0 - j.core) * (j.radius / max(j.dist, j.radius));
  v -= j.radial * (inflow / max(j.dist, 0.5));
  // Hot gas rises where the jets do not hold it down and once the wall jet has let go of it; the wind takes
  // over where the wall jet has died.
  let held = j.column * (1.0 - smoothstep(1.5 * j.radius, 6.0 * j.radius, j.dist));
  v.y += su.flow.z * heat * (0.35 + 0.65 * saturate(p.y / 25.0)) * (1.0 - held) * (1.0 - 0.85 * saturate(U / 10.0));
  let windShare = (0.3 + 0.7 * saturate(p.y / 120.0)) * (1.0 - saturate(U / 8.0));
  v += vec3f(su.flow2.z, 0.0, su.flow2.w) * windShare;
  // Turbulence: two octaves of divergence-free noise that drift up with the cloud, stronger where the gas is fast.
  let t = su.misc.y;
  // The noise texture is trilinear: its slope jumps at every texel, and a flow with such creases shears the
  // smoke into shelves along the texel planes. Two taps half a texel apart along the diagonal soften them.
  let h = vec3f(0.5 / 32.0);
  let q0 = p * 0.0042 + vec3f(0.0, -t * 0.012, 0.0);
  let q1 = p * 0.0137 + vec3f(t * 0.008, -t * 0.03, 0.0);
  let c = 0.5 * (vfxCurl(q0 + h) + vfxCurl(q0 - h)) + 0.275 * (vfxCurl(q1 + h) + vfxCurl(q1 - h));
  v += c.xzy * (su.flow2.x * (2.0 + 0.07 * min(length(v), 60.0)) * (1.0 - 0.8 * held)) * vec3f(1.0, 0.6 + 0.4 * saturate(p.y / 20.0), 1.0);
  return v;
}

@compute @workgroup_size(4, 4, 4) fn advect(@builtin(global_invocation_id) gid: vec3u) {
  let dims = textureDimensions(dst);
  let id = gid + vec3u(su.box.xyz);
  if (any(id >= dims)) { return; }
  if (su.misc.x > 0.5) { textureStore(dst, id, vec4f(0.0)); return; }
  let uvw = (vec3f(id) + 0.5) / vec3f(dims);
  let p = smokeFromUvw(uvw);
  let dt = su.sunSite.w;
  let here = textureLoad(src, vec3i(id), 0);
  let v = smokeVelocity(p, here.b);
  let p0 = p - v * dt;
  var s = textureSampleLevel(src, linearClamp, smokeToUvw(p0), 0.0);
  // Nothing comes in through the sides or the top.
  if (abs(p0.x) > su.grid.y || abs(p0.z) > su.grid.y || p0.y > su.grid.z) { s = vec4f(0.0); }
  let diss = su.flow2.y;
  s.r *= exp(-diss * dt);
  s.g *= exp(-diss * 3.0 * dt);
  s.b *= exp(-su.flow.w * dt);
  // Sources: where the exhaust and the deluge steam come out of the trench (its far end while the jet goes
  // down the duct, the foot of the jet once it spreads over the open pad), close to the ground.
  let R = su.rate.z;
  let H = 2.5;
  let out = su.source.xz + su.trench.xy * (su.trench.z * su.rate.w);
  let dSmoke = p.xz - out;
  let gSmoke = exp(-dot(dSmoke, dSmoke) / (R * R)) * exp(-p.y / H) / (PI * R * R * H);
  let Rw = 1.5 * R;
  let dSteam = p.xz - mix(su.source.xz, out, 0.8);
  let gSteam = exp(-dot(dSteam, dSteam) / (Rw * Rw)) * exp(-p.y / (1.6 * H)) / (PI * Rw * Rw * 1.6 * H);
  // The jet itself is clear, fast gas: nothing condenses in it and what strays into it is torn apart.
  let core = jetAt(p).core;
  s.r += su.rate.x * dt * gSmoke * (1.0 - core);
  s.g += su.rate.y * dt * gSteam * (1.0 - core);
  s.b = max(s.b, saturate((su.rate.x * gSmoke + 0.6 * su.rate.y * gSteam) * 40.0));
  let clear = exp(-10.0 * core * dt);
  s.r *= clear;
  s.g *= clear;
  textureStore(dst, id, max(s, vec4f(0.0)));
}

fn sigmaAt(p: vec3f) -> f32 {
  if (abs(p.x) > su.grid.y || abs(p.z) > su.grid.y || p.y > su.grid.z || p.y < 0.0) { return 0.0; }
  let s = textureSampleLevel(src, linearClamp, smokeToUvw(p), 0.0);
  return s.r + s.g;
}

/// Light volume: r = transmittance towards the sun, g = towards the plume light, b = occupancy (largest
/// density within reach of the march's displacement), a = exp(-0.3 x sun optical depth) for the wide octaves.
@compute @workgroup_size(4, 4, 4) fn light(@builtin(global_invocation_id) gid: vec3u) {
  let dims = textureDimensions(dst);
  let id = gid + vec3u(su.boxLight.xyz);
  if (any(id >= dims)) { return; }
  if (su.misc.x > 0.5) { textureStore(dst, id, vec4f(1.0, 1.0, 0.0, 1.0)); return; }
  let p = smokeFromUvw((vec3f(id) + 0.5) / vec3f(dims));
  var tau = 0.0;
  var step = 5.0;
  var q = p;
  for (var i = 0; i < 7; i++) {
    q += su.sunSite.xyz * step;
    tau += sigmaAt(q) * step;
    step *= 1.7;
  }
  // Towards the plume light, a line: once to its nearest point and once to a point near its upper end (the
  // top of a cloud is lit by the jet above it even where the way to the nearest point runs through the cloud).
  // Steps start below the cell size and grow, so that the nearby gas (which decides the local shading) is
  // resolved and the result varies smoothly from cell to cell. Stored relative to the nearest point's distance.
  let nearL = plumeLightPoint(p);
  let dNear2 = max(dot(nearL - p, nearL - p), 25.0);
  var lit = 0.0;
  for (var k = 0; k < 2; k++) {
    let aim = select(mix(su.lightA.xyz, su.lightB.xyz, 0.12), nearL, k == 0);
    let toL = aim - p;
    let distL = length(toL);
    let dirL = toL / max(distL, 1.0);
    var tauL = 0.0;
    var hL = 2.5;
    var tL = 0.0;
    for (var i = 0; i < 9; i++) {
      let h = min(hL, distL - tL);
      if (h <= 0.0) { break; }
      tauL += sigmaAt(p + dirL * (tL + 0.5 * h)) * h;
      tL += h;
      hL *= 1.65;
    }
    lit += 0.5 * exp(-tauL) * dNear2 / max(distL * distL, 25.0);
  }
  // Occupancy: the largest density within the reach of the march's noise displacement. The march looks for
  // gas in this (dilated, smooth) field: testing the density itself would cut the displaced billows off along
  // the cell faces where the stored field ends.
  let reach = 0.42 / su.steamAlbedo.w;
  var occ = sigmaAt(p);
  for (var i = 0; i < 6; i++) {
    let axis = vec3f(f32(i / 2 == 0), f32(i / 2 == 1), f32(i / 2 == 2)) * select(-1.0, 1.0, (i & 1) == 0);
    occ = max(occ, sigmaAt(p + axis * reach));
  }
  for (var i = 0; i < 8; i++) {
    let corner = vec3f(select(-1.0, 1.0, (i & 1) == 0), select(-1.0, 1.0, (i & 2) == 0), select(-1.0, 1.0, (i & 4) == 0));
    occ = max(occ, sigmaAt(p + corner * (0.6 * reach)));
  }
  // Stored as transmittances: the march interpolates them between cells, and a linearly interpolated
  // optical depth put through exp() turns the surface of a dense cloud into terraces along the cell faces.
  textureStore(dst, id, vec4f(exp(-tau), lit, occ, exp(-0.3 * tau)));
}
`;

const MARCH_WGSL = /* wgsl */ `
#include "vfx_common"
${GRID_WGSL}
@group(2) @binding(0) var<uniform> su: SmokeU;
@group(2) @binding(1) var densityTex: texture_3d<f32>;
@group(2) @binding(2) var lightTex: texture_3d<f32>;
@group(2) @binding(3) var momentTex: texture_2d<f32>;

struct MarchOut {
  @location(0) frontNear: vec4f,   // rgb = smoke in front of the emitters (premultiplied, pre-exposed), a = its transmittance; cut at the nearer depth
  @location(1) backNear: vec4f,    // the smoke behind the emitters, same cut
  @location(2) frontFar: vec4f,    // both again, cut at the farther depth
  @location(3) backFar: vec4f,
  @location(4) aux: vec4f,         // r, g = log2 of the two cut depths (m along the view axis), b = log2 of the mean distance of the smoke in front (m)
}

@fragment fn fs(in: FullscreenOut) -> MarchOut {
  let pix = vec2i(in.position.xy);
  // The 2 x 2 half-resolution pixels of this ray: the nearest and the farthest of their depths, their emitters.
  let hsize = vec2i(textureDimensions(sceneDepthHalfTex));
  var dNear = 0.0;
  var dFar = 1.0;
  var mr = 0.0;
  var mg = 0.0;
  for (var k = 0; k < 4; k++) {
    let ip = min(pix * 2 + vec2i(k & 1, k >> 1), hsize - 1);
    let d = textureLoad(sceneDepthHalfTex, ip, 0).r;
    dNear = max(dNear, d);
    dFar = min(dFar, d);
    if (su.lightA.w > 0.5) {
      let m = textureLoad(momentTex, ip, 0);
      mr += m.r;
      mg += m.g;
    }
  }
  var tE = 3.0e38;
  if (mg > 1e-4) { tE = exp2(mr / mg); }
  let zNear = min(viewZFromDepth(dNear), 1.0e7);
  let zFar = min(viewZFromDepth(dFar), 1.0e7);
  var out: MarchOut;
  out.frontNear = vec4f(0.0, 0.0, 0.0, 1.0);
  out.backNear = vec4f(0.0, 0.0, 0.0, 1.0);
  out.frontFar = vec4f(0.0, 0.0, 0.0, 1.0);
  out.backFar = vec4f(0.0, 0.0, 0.0, 1.0);
  out.aux = vec4f(log2(zNear), log2(zFar), 0.0, 0.0);

  let ray = viewRay(in.uv);
  let rayLen = length(ray);
  let dW = ray / rayLen;
  let tCut = zNear * rayLen;
  let tScene = zFar * rayLen;
  let o = su.origin.xyz;
  let ro = -vec3f(dot(o, su.axisE.xyz), dot(o, su.axisU.xyz), dot(o, su.axisN.xyz));
  var rd = vec3f(dot(dW, su.axisE.xyz), dot(dW, su.axisU.xyz), dot(dW, su.axisN.xyz));
  rd = select(rd, vec3f(1e-7), abs(rd) < vec3f(1e-7));
  let ext = su.grid.y;
  let ta = (vec3f(-ext, 0.0, -ext) - ro) / rd;
  let tb = (vec3f(ext, su.grid.z, ext) - ro) / rd;
  let tmn = min(ta, tb);
  let tmx = max(ta, tb);
  var t0 = max(max(tmn.x, max(tmn.y, tmn.z)), 0.0);
  var t1 = min(min(tmx.x, min(tmx.y, tmx.z)), tScene);
  // The cloud itself is much smaller than the grid: march only through the cylinder that holds it.
  let oc = ro.xz - su.cloud.xy;
  let qa = dot(rd.xz, rd.xz);
  let qb = dot(oc, rd.xz);
  let disc = qb * qb - qa * (dot(oc, oc) - su.cloud.z * su.cloud.z);
  if (disc <= 0.0) { return out; }
  let sq_ = sqrt(disc);
  t0 = max(t0, (-qb - sq_) / qa);
  t1 = min(t1, (-qb + sq_) / qa);
  let ty = (vec2f(0.0, su.cloud.w) - ro.y) / rd.y;
  t0 = max(t0, min(ty.x, ty.y));
  t1 = min(t1, max(ty.x, ty.y));
  if (t1 <= t0) { return out; }

  // Steps grow gently with the distance from the point of the ray nearest to the pad, like the cells of the grid.
  let tc = clamp(-dot(ro, rd), t0, t1);
  let d0 = max(24.0, 0.3 * length(ro + rd * tc));
  let s0 = t0 - tc;
  let s1 = t1 - tc;
  let w0 = sign(s0) * log(1.0 + abs(s0) / d0);
  let w1 = sign(s1) * log(1.0 + abs(s1) / d0);
  let steps = max(12.0, floor(su.grid.w * vfx.time.w + 0.5));
  let dw = (w1 - w0) / steps;
  let jitter = blueNoise(vec2u(pix)).g;
  let probe = vfxProbes[${PROBE_PAD}];
  let sunE = probe.sun.rgb;
  let amb = vfxProbeAmbient(${PROBE_PAD}u);
  let cosT = dot(dW, frame.sunDir.xyz);
  let g = 0.5;
  let phase = (1.0 - g * g) / pow(1.0 + g * g - 2.0 * g * cosT, 1.5);
  let time = su.misc.y;
  let exposure = frame.exposure.x;
  let scale = su.steamAlbedo.w;
  let scroll = vec3f(-su.flow2.z * time, -3.0 * time, -su.flow2.w * time);
  // Size of a ray of this pass at one metre (two half-resolution pixels).
  let pixel = 4.0 * frame.cameraUp.w * vfx.half.w;

  var Lf = vec3f(0.0); var Tf = 1.0;     // smoke in front of the emitters
  var Lb = vec3f(0.0); var Tb = 1.0;     // smoke behind them
  var slabL = vec3f(0.0); var slabT = 1.0; var slabW = 0.0; var slabD = 0.0;
  var back = false;
  var cut = false;
  var slabCount = 0;
  var dSum = 0.0;                        // opacity-weighted distance of the smoke in front
  var dWeight = 0.0;
  // Coarse steps through empty air; where gas is found the march backs up one step and goes on with steps a
  // quarter as long, so that the first metres of a dense cloud (which are all that is seen of it) are resolved.
  // Deep inside, where most of the light is gone, the steps lengthen again.
  var t = t0 + (d0 + abs(t0 - tc)) * dw * jitter;
  var fine = 0.0;
  let maxIter = i32(steps * 2.5);
  for (var i = 0; i < maxIter && t < t1; i++) {
    let base = (d0 + abs(t - tc)) * dw;
    let deep = 1.0 + 2.0 * (1.0 - smoothstep(0.05, 0.4, Tf * Tb));
    let dt = base * select(1.0, 0.25 * deep, fine > 0.0);
    let p = ro + rd * (t + 0.5 * dt);
    let uvw = smokeToUvw(p);
    var sigma = textureSampleLevel(lightTex, linearClamp, uvw, 0.0).b;
    if (sigma > 1e-5 && fine <= 0.0) {
      // Entering gas: redo this stretch finely.
      fine = 6.0;
      continue;
    }
    var cell = vec4f(0.0);
    var warp = vec3f(0.0);
    var ng = 0.5;
    var cavity = 0.5;
    var hard = 0.0;
    var noiseQ = vec3f(0.0);
    var noiseFoot = 0.0;
    if (sigma > 1e-5) {
      // Billows: the density is looked up at a position displaced by two octaves of noise that ride up with
      // the cloud (lumpy edges however smooth the advected field is). Detail finer than a ray of this pass
      // can show is left out (it would come back as blocks).
      let q = (p + scroll) * scale;
      let foot = max(dt, 1.5 * pixel * (t + 0.5 * dt)) * scale;
      let n = vfxNoiseLod(q, foot);
      let n2 = vfxNoiseLod(q * 3.1 + vec3f(0.37, 0.11, 0.73), foot * 3.1);
      let amp = 0.3 / scale;
      warp = (vec3f(n.r, n.a, n.g) - 0.5) * (1.4 * amp) + (vec3f(n2.r, n2.a, n2.g) - 0.5) * (0.6 * amp);
      cell = textureSampleLevel(densityTex, linearClamp, smokeToUvw(p + warp), 0.0);
      let raw = cell.r + cell.g;
      cavity = n2.b;
      let cover = saturate(raw / 0.03);
      let billow = 0.5 * n.g + 0.3 * n2.g + 0.2 * n2.b;
      ng = n.g;
      // Dense gas has a surface: where the advected field plus the billow noise passes a threshold the gas is
      // several times as dense as the field says, so that the cloud ends in a hard, lumpy edge within a metre
      // or two. Inside the cloud the noise can not open a hole (a gap shows more cloud, never the ground);
      // thin gas at the fringe stays a haze that fades out smoothly.
      let field = cover + (billow - 0.5) * (2.0 * su.smokeAlbedo.w) * (1.0 - 0.45 * cover);
      hard = smoothstep(0.3, 0.6, field);
      // (Where the billows dip, dense gas keeps a floor of its density: a gap between billows shows more cloud,
      // grey in its own shade, never a dark hole down to the ground.)
      sigma = raw * (3.0 * hard + (0.6 + 1.2 * smoothstep(0.5, 1.0, cover)) * cover * (1.0 - hard));
      noiseQ = q;
      noiseFoot = foot;
      fine = 6.0;
    } else {
      fine -= 1.0;
    }
    if (sigma > 1e-5) {
      // The light is looked up where the density was: the shading follows the billows, not the cells.
      let lt = textureSampleLevel(lightTex, linearClamp, smokeToUvw(p + warp), 0.0);
      let albedo = (su.smokeAlbedo.rgb * cell.r + su.steamAlbedo.rgb * cell.g) / max(cell.r + cell.g, 1e-6);
      // Sun. A dense cloud is lit like a surface: the side towards the sun (transmittance of the light volume)
      // is bright, the lee side keeps only what is scattered about inside (two wide octaves). The lumps shade
      // each other: where the billow noise rises towards the sun, this sample lies in a fold.
      let wide = pow(lt.a, 0.0833);
      let towards = vfxNoiseLod(noiseQ + su.sunSite.xyz * 0.1, noiseFoot);
      // (The small cells of the detail noise are crevices between their feature points: darker there.)
      let relief = clamp(1.0 - 7.0 * (towards.g - ng) * hard, 0.2, 1.7) * mix(1.0, 0.5 + 0.75 * smoothstep(0.15, 0.7, cavity), hard);
      let sun = sunE * ((0.7 + 0.3 * phase) * 2.2 * lt.r * relief + (0.45 * lt.a + 0.3 * wide) * (0.5 + 0.5 * relief)) * (1.0 / (4.0 * PI));
      // Plume: the jet is a line of light; gas next to it glows from the light that has been scattered about
      // inside the cloud as well as from what reaches it directly.
      let toL = plumeLightPoint(p) - p;
      let dl2 = max(dot(toL, toL), 25.0);
      // (What is scattered about inside the cloud reaches round its billows, but not through the whole of it:
      // the side of the cloud away from the flame stays dark brown, as in every night-launch photograph.)
      let plume = su.lightColor.rgb * ((lt.g + 0.35 * pow(lt.g, 0.4)) / (dl2 * PI));
      let sky = amb * ((0.45 + 0.55 * pow(lt.a, 0.833)) / PI);
      // Gas fresh from the plume still glows, faintly and smoothly (what lights the cloud at the jet is the jet).
      let h2 = cell.b * cell.b;
      let glow = su.glow.rgb * (0.3 * h2 * h2 * h2);
      let J = (albedo * (sun + plume + sky) + glow) * exposure;
      let stepT = exp(-sigma * dt);
      slabL += slabT * J * (1.0 - stepT);
      slabT *= stepT;
      slabW += (1.0 - stepT);
      slabD += (1.0 - stepT) * (t + 0.5 * dt);
    }
    t += dt;
    slabCount++;
    // A slab ends every eighth step, where the ray passes the emitters or the nearer cut depth, and at the end.
    let last = t >= t1 || i + 1 >= maxIter;
    let crossing = !back && t >= tE;
    let cutting = !cut && t >= tCut;
    if (last || crossing || cutting || slabCount >= 8) {
      if (slabW > 0.0) {
        let dist = slabD / slabW;
        let c = vfxAtmosphere(in.uv, dist, slabL, 1.0 - slabT);
        if (back) { Lb += Tb * c.rgb; Tb *= 1.0 - c.a; }
        else { dSum += Tf * c.a * dist; dWeight += Tf * c.a; Lf += Tf * c.rgb; Tf *= 1.0 - c.a; }
      }
      slabL = vec3f(0.0); slabT = 1.0; slabW = 0.0; slabD = 0.0; slabCount = 0;
      if (cutting) {
        cut = true;
        out.frontNear = vec4f(writeHdr(Lf), Tf);
        out.backNear = vec4f(writeHdr(Lb), Tb);
      }
      if (crossing) { back = true; }
    }
    if (Tf * Tb < 0.003) { break; }
  }
  out.frontFar = vec4f(writeHdr(Lf), Tf);
  out.backFar = vec4f(writeHdr(Lb), Tb);
  if (!cut) {
    out.frontNear = out.frontFar;
    out.backNear = out.backFar;
  }
  out.aux.b = log2(max(dSum / max(dWeight, 1e-6), 1e-3));
  return out;
}
`;

const COMBINE_WGSL = /* wgsl */ `
#include "vfx_common"
${GRID_WGSL}
@group(2) @binding(0) var<uniform> su: SmokeU;
@group(2) @binding(1) var emitTex: texture_2d<f32>;
@group(2) @binding(2) var momentTex: texture_2d<f32>;
@group(2) @binding(3) var frontNearTex: texture_2d<f32>;
@group(2) @binding(4) var backNearTex: texture_2d<f32>;
@group(2) @binding(5) var frontFarTex: texture_2d<f32>;
@group(2) @binding(6) var backFarTex: texture_2d<f32>;
@group(2) @binding(7) var auxTex: texture_2d<f32>;

struct CombineOut {
  @location(0) color: vec4f,    // the half-resolution volume image: premultiplied pre-exposed radiance, a = opacity
  @location(1) moment: vec4f,   // r = weight x log2(distance), g = weight, of what the image shows
}

@fragment fn fs(in: FullscreenOut) -> CombineOut {
  let pix = vec2i(in.position.xy);
  var E = vec4f(0.0);
  var m = vec2f(0.0);
  if (su.lightA.w > 0.5) {
    E = textureLoad(emitTex, pix, 0);
    m = textureLoad(momentTex, pix, 0).rg;
  }
  // The four nearest rays of the quarter-resolution march, each with its two depth cuts: weighted by the
  // bilinear weight and by how well the cut matches the depth this pixel was meant to be marched to.
  let z = min(viewZFromDepth(textureLoad(sceneDepthHalfTex, pix, 0).r), 1.0e7);
  let size = vec2i(textureDimensions(auxTex));
  let st = in.uv * vec2f(size) - 0.5;
  let base = floor(st);
  let f = st - base;
  // Each ray is composed with THIS pixel's emitters before the rays are mixed: mixing the smoke in front of
  // and behind the emitters separately darkens the pixel wherever neighbouring rays split their smoke at
  // different distances (a hairline along the outline of every plume inside the cloud).
  let TE = 1.0 - E.a;
  var C = vec4f(0.0);
  var M = vec2f(0.0);
  var wsum = 0.0;
  var bestC = vec4f(E.rgb, E.a);
  var bestM = m;
  var bestDiff = 3.0e38;
  // Cubic B-spline weights over the 4 x 4 rays around the pixel: no diamonds or blocks of quarter-resolution
  // pixels, and the per-ray jitter of a thin fringe is averaged instead of drawn as a stipple.
  let gx = 1.0 - f.x;
  let gy = 1.0 - f.y;
  let wx = vec4f(gx * gx * gx, 3.0 * f.x * f.x * f.x - 6.0 * f.x * f.x + 4.0, 3.0 * gx * gx * gx - 6.0 * gx * gx + 4.0, f.x * f.x * f.x) * (1.0 / 6.0);
  let wy = vec4f(gy * gy * gy, 3.0 * f.y * f.y * f.y - 6.0 * f.y * f.y + 4.0, 3.0 * gy * gy * gy - 6.0 * gy * gy + 4.0, f.y * f.y * f.y) * (1.0 / 6.0);
  for (var k = 0; k < 16; k++) {
    let o = vec2i(k & 3, k >> 2) - vec2i(1);
    let ip = clamp(vec2i(base) + o, vec2i(0), size - 1);
    let a = textureLoad(auxTex, ip, 0);
    let zn = exp2(a.r);
    let zf = exp2(a.g);
    let diffN = min(abs(zn - z) / max(min(zn, z), 1e-3), 1000.0);
    let diffF = min(abs(zf - z) / max(min(zf, z), 1e-3), 1000.0);
    let near = diffN < diffF;
    let diff = min(diffN, diffF);
    var fr: vec4f;
    var bk: vec4f;
    if (near) { fr = textureLoad(frontNearTex, ip, 0); bk = textureLoad(backNearTex, ip, 0); }
    else { fr = textureLoad(frontFarTex, ip, 0); bk = textureLoad(backFarTex, ip, 0); }
    let col = vec4f(fr.rgb + fr.a * (E.rgb + TE * bk.rgb), 1.0 - fr.a * TE * bk.a);
    let mom = vec2f((1.0 - fr.a) * a.b + fr.a * m.r, (1.0 - fr.a) + fr.a * m.g);
    // Depth steps of a few per cent are the slope of the ground under the cloud, not an edge: only a real
    // discontinuity may take a ray's weight away, or the cloud is drawn in blocks of quarter-resolution pixels.
    let w = wx[o.x + 1] * wy[o.y + 1] / (1.0 + sq(diff * 12.0));
    C += col * w;
    M += mom * w;
    wsum += w;
    if (all(o >= vec2i(0)) && all(o <= vec2i(1)) && diff < bestDiff) { bestDiff = diff; bestC = col; bestM = mom; }
  }
  if (wsum < 0.02) { C = bestC; M = bestM; }
  else { C /= wsum; M /= wsum; }
  var out: CombineOut;
  out.color = vec4f(writeHdr(C.rgb), saturate(C.a));
  out.moment = vec4f(M, 0.0, 0.0);
  return out;
}
`;

/** The cloud's shadow on whatever stands under it: opaque pixels are darkened by the sun's share of their light. */
const SHADOW_WGSL = /* wgsl */ `
#include "vfx_common"
${GRID_WGSL}
@group(2) @binding(0) var<uniform> su: SmokeU;
@group(2) @binding(1) var lightTex: texture_3d<f32>;
@fragment fn fs(in: FullscreenOut) -> @location(0) vec4f {
  let d = textureLoad(sceneDepthTex, vec2i(in.position.xy), 0);
  let rel = positionFromDepth(in.uv, d) - su.origin.xyz;
  let p = vec3f(dot(rel, su.axisE.xyz), dot(rel, su.axisU.xyz), dot(rel, su.axisN.xyz));
  if (abs(p.x) > su.grid.y || abs(p.z) > su.grid.y || p.y > su.grid.z || p.y < -40.0) { discard; }
  let T = textureSampleLevel(lightTex, linearClamp, smokeToUvw(vec3f(p.x, max(p.y, 0.5), p.z)), 0.0).r;
  let probe = vfxProbes[${PROBE_PAD}];
  let direct = probe.sun.rgb * max(su.sunSite.y, 0.03);
  let share = direct / max(direct + vfxProbeAmbient(${PROBE_PAD}u), vec3f(1e-6));
  // An eye inside the cloud sees the ground through the gas that shades it: the gas is what is seen, and a
  // dark wedge painted on the ground under it would show through as a hard shape.
  let eye = -vec3f(dot(su.origin.xyz, su.axisE.xyz), dot(su.origin.xyz, su.axisU.xyz), dot(su.origin.xyz, su.axisN.xyz));
  let inside = saturate(textureSampleLevel(lightTex, linearClamp, smokeToUvw(vec3f(eye.x, max(eye.y, 0.5), eye.z)), 0.0).b / 0.02) * step(abs(eye.x), su.grid.y) * step(abs(eye.z), su.grid.y) * step(eye.y, su.grid.z);
  return vec4f(saturate3(vec3f(1.0) - share * ((1.0 - T) * su.lightColor.w * (1.0 - 0.85 * inside))), 1.0);
}
`;

interface CellBox {
  lo: [number, number, number];
  hi: [number, number, number];
}

export class SmokeSystem implements VolumeCombiner {
  private readonly device: GPUDevice;
  private readonly u = new Float32Array(U_FLOATS);
  private readonly uniform: GPUBuffer;
  private readonly density: [GPUTexture, GPUTexture];
  private readonly lightTex: GPUTexture;
  private readonly computeLayout: GPUBindGroupLayout;
  private readonly marchLayout: GPUBindGroupLayout;
  private readonly combineLayout: GPUBindGroupLayout;
  private readonly shadowLayout: GPUBindGroupLayout;
  private readonly advectPipeline: GPUComputePipeline;
  private readonly lightPipeline: GPUComputePipeline;
  private readonly marchPipeline: Tracked<GPURenderPipeline>;
  private readonly combinePipeline: Tracked<GPURenderPipeline>;
  private readonly shadowPipeline: Tracked<GPURenderPipeline>;
  private readonly advectGroups: [GPUBindGroup, GPUBindGroup];
  private readonly lightGroups: [GPUBindGroup, GPUBindGroup];
  private readonly shadowGroup: GPUBindGroup;
  /** Quarter-resolution results of the march: smoke in front of / behind the emitters at the two depth cuts, and the cuts. */
  private readonly quarter: [ManagedTarget, ManagedTarget, ManagedTarget, ManagedTarget, ManagedTarget];
  private marchGroups: [GPUBindGroup, GPUBindGroup] | null = null;
  private combineGroup: GPUBindGroup | null = null;
  private groupVersion = -1;
  private readonly dims: Vec3Tuple;
  /** Index of the density texture that holds the current state. */
  private cur = 0;
  private site: LaunchSiteDef | null = null;
  private lastSource = -1e9;
  private firstSource = -1e9;
  private isActive = false;
  private needsClear = true;
  private stepped = false;
  /** Advection steps taken: the light volume is refreshed on every second one. */
  private stepIndex = 0;
  /** Cells the cloud has reached since the grid was cleared (multiples of 8; only these are simulated). */
  private box: CellBox | null = null;
  /** Screen rectangle of the cloud in pixels of the quarter-resolution targets (null: not on screen). */
  private rect: [number, number, number, number] | null = null;
  private sunUp = false;
  /** Total source this frame (m^2/s) for diagnostics. */
  sourceRate = 0;
  /** Share of the grid's cells that is simulated (diagnostics). */
  boxShare = 0;

  constructor(
    private readonly ctx: RenderContext,
    private readonly common: VfxCommon,
    private readonly data: VfxData,
  ) {
    const device = (this.device = ctx.device);
    const S = data.padSmoke;
    const core = common.core;
    this.dims = S.grid;
    this.uniform = device.createBuffer({ label: 'vfx.smoke', size: U_FLOATS * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const mk = (label: string, size: Vec3Tuple): GPUTexture =>
      core.createTextureChecked({ label, format: 'rgba16float', dimension: '3d', size, usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING });
    this.density = [mk('vfx.smoke.a', S.grid), mk('vfx.smoke.b', S.grid)];
    this.lightTex = mk('vfx.smoke.light', [Math.ceil(S.grid[0] / 2), Math.ceil(S.grid[1] / 2), Math.ceil(S.grid[2] / 2)]);
    this.quarter = [
      core.createTarget('vfx.smoke.frontNear', 'rgba16float', 0.25),
      core.createTarget('vfx.smoke.backNear', 'rgba16float', 0.25),
      core.createTarget('vfx.smoke.frontFar', 'rgba16float', 0.25),
      core.createTarget('vfx.smoke.backFar', 'rgba16float', 0.25),
      core.createTarget('vfx.smoke.aux', 'rgba16float', 0.25),
    ];
    const tex3d: GPUBindGroupLayoutEntry['texture'] = { sampleType: 'float', viewDimension: '3d' };
    this.computeLayout = device.createBindGroupLayout({
      label: 'vfx.smoke.compute',
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, texture: tex3d },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: 'write-only', format: 'rgba16float', viewDimension: '3d' } },
      ],
    });
    this.marchLayout = device.createBindGroupLayout({
      label: 'vfx.smoke.march',
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: tex3d },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: tex3d },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
      ],
    });
    this.combineLayout = device.createBindGroupLayout({
      label: 'vfx.smoke.combine',
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        ...[1, 2, 3, 4, 5, 6, 7].map((binding): GPUBindGroupLayoutEntry => ({ binding, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } })),
      ],
    });
    this.shadowLayout = device.createBindGroupLayout({
      label: 'vfx.smoke.shadow',
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: tex3d },
      ],
    });
    const module = ctx.shaders.createModule('vfx.smoke.compute', COMPUTE_WGSL);
    const layout = device.createPipelineLayout({ label: 'vfx.smoke.compute', bindGroupLayouts: [ctx.frameBindGroupLayout, common.layout, this.computeLayout] });
    this.advectPipeline = device.createComputePipeline({ label: 'vfx.smoke.advect', layout, compute: { module, entryPoint: 'advect' } });
    this.lightPipeline = device.createComputePipeline({ label: 'vfx.smoke.light', layout, compute: { module, entryPoint: 'light' } });
    const views = this.density.map((t) => t.createView());
    const lightView = this.lightTex.createView();
    const group = (srcView: GPUTextureView, dstView: GPUTextureView): GPUBindGroup =>
      device.createBindGroup({ label: 'vfx.smoke.compute', layout: this.computeLayout, entries: [{ binding: 0, resource: { buffer: this.uniform } }, { binding: 1, resource: srcView }, { binding: 2, resource: dstView }] });
    // advectGroups[k]: read texture k, write the other; lightGroups[k]: read texture k, write the light volume.
    this.advectGroups = [group(views[0]!, views[1]!), group(views[1]!, views[0]!)];
    this.lightGroups = [group(views[0]!, lightView), group(views[1]!, lightView)];
    this.shadowGroup = device.createBindGroup({ label: 'vfx.smoke.shadow', layout: this.shadowLayout, entries: [{ binding: 0, resource: { buffer: this.uniform } }, { binding: 1, resource: lightView }] });
    const rgba: GPUColorTargetState = { format: 'rgba16float' };
    this.marchPipeline = core.fullscreenPipeline({ label: 'vfx.smoke.march', fragment: MARCH_WGSL, layouts: [common.layout, this.marchLayout], targets: [rgba, rgba, rgba, rgba, rgba] });
    this.combinePipeline = core.fullscreenPipeline({ label: 'vfx.smoke.combine', fragment: COMBINE_WGSL, layouts: [common.layout, this.combineLayout], targets: [rgba, { format: 'rg16float' }] });
    // Multiplies what is in the HDR target: geometry pixels only (the fullscreen triangle lies at the far plane).
    this.shadowPipeline = core.fullscreenPipeline({
      label: 'vfx.smoke.shadow',
      fragment: SHADOW_WGSL,
      layouts: [common.layout, this.shadowLayout],
      targets: [{ format: RENDER_FORMATS.hdr, blend: { color: { srcFactor: 'zero', dstFactor: 'src' }, alpha: { srcFactor: 'zero', dstFactor: 'one' } } }],
      depthStencil: { format: RENDER_FORMATS.depth, depthWriteEnabled: false, depthCompare: 'less' },
    });
    this.marchPipeline.get();
    this.combinePipeline.get();
    this.shadowPipeline.get();
  }

  active(): boolean {
    return this.isActive;
  }

  /** Site the volume is anchored to (null while inactive). */
  get anchor(): LaunchSiteDef | null {
    return this.isActive ? this.site : null;
  }

  /**
   * Choose the site, measure the sources and upload the uniforms (prepare). Returns the pad centre relative
   * to the camera while the volume is active (for the pad light probe), else null.
   */
  update(frame: FrameContext, clusters: PlacedCluster[], effectTime: number, dt: number): Vec3 | null {
    const S = this.data.padSmoke;
    const defs = this.ctx.defs;
    const snap = frame.snapshot;
    this.stepped = false;
    this.rect = null;

    // Nearest site to anything that burns, on a body of this frame.
    let best: { site: LaunchSiteDef; origin: Vec3; east: Vec3; north: Vec3; up: Vec3 } | null = null;
    let bestDist = Infinity;
    const candidates = this.isActive && this.site ? [this.site] : Object.values(defs.sites);
    for (const site of candidates) {
      const pe = site.location.padElevation;
      if (typeof pe !== 'number' || !snap.bodies.some((b) => b.id === site.bodyId)) continue;
      const pose = frame.bodyPose(site.bodyId);
      const dir = latLonToDir(site.location.latDeg * DEG, site.location.lonDeg * DEG);
      const origin = v3.add(pose.centerRelCam, quat.rotate(pose.qFixedToRoot, v3.scale(dir, defs.bodies[site.bodyId]!.radius + pe)));
      let d = this.isActive ? 0 : Infinity;
      for (const pc of clusters) if (pc.cluster.kind === 'engine' && pc.cluster.look.ground.smoke > 0) d = Math.min(d, v3.dist(pc.originRelCam, origin));
      if (d < bestDist) {
        let e = v3.cross(v3.unitZ(), dir);
        e = v3.lenSq(e) < 1e-12 ? v3.unitY() : v3.normalize(e);
        const n = v3.cross(dir, e);
        bestDist = d;
        best = { site, origin, east: quat.rotate(pose.qFixedToRoot, e), north: quat.rotate(pose.qFixedToRoot, n), up: quat.rotate(pose.qFixedToRoot, dir) };
      }
    }
    if (!best || (!this.isActive && bestDist > S.activationRange)) {
      this.isActive = false;
      return null;
    }

    // Sources: every engine cluster whose jet points at the pad, weighted by how much of it still reaches the ground.
    let smoke = 0;
    let strength = 0;
    let foot = v3.zero();
    let nozzleHeight = 0;
    let weight = 0;
    let top = v3.zero();
    let dir = v3.zero();
    let jetRadius = 0;
    let jetLength = 0;
    let light: { a: Vec3; b: Vec3; intensity: Vec3Tuple; power: number } | null = null;
    const toSite = (rel: Vec3): Vec3 => {
      const d = v3.sub(rel, best.origin);
      return { x: v3.dot(d, best.east), y: v3.dot(d, best.up), z: v3.dot(d, best.north) };
    };
    const dirToSite = (d: Vec3): Vec3 => ({ x: v3.dot(d, best.east), y: v3.dot(d, best.up), z: v3.dot(d, best.north) });
    for (const pc of clusters) {
      const c = pc.cluster;
      if (c.kind !== 'engine' || c.look.ground.smoke <= 0) continue;
      const p = toSite(pc.originRelCam);
      const cosDown = -v3.dot(pc.axisX, best.up);
      if (cosDown < 0.3 || p.y <= 0 || Math.hypot(p.x, p.z) > S.activationRange) continue;
      const h = p.y / cosDown;
      const reach = Math.max(0, 1 - h / S.plumeReach) ** 1.5;
      if (reach <= 0) continue;
      const hit = toSite(v3.addScaled(pc.originRelCam, pc.axisX, h));
      const w = c.massFlow * reach * c.look.ground.smoke;
      let reMax = 0;
      let core = 0;
      for (const nz of c.nozzles) {
        reMax = Math.max(reMax, nz.exitRadius);
        core = Math.max(core, nz.shape.coreLength);
      }
      if (c.merged) core = Math.max(core, c.merged.shape.coreLength);
      smoke += w;
      foot = v3.addScaled(foot, hit, w);
      top = v3.addScaled(top, p, w);
      dir = v3.addScaled(dir, dirToSite(pc.axisX), w);
      jetRadius += (c.merged?.exitRadius ?? reMax) * w;
      jetLength += h * w;
      nozzleHeight += p.y * w;
      weight += w;
      strength = Math.max(strength, reach * Math.min(1, c.massFlow / 2000 + 0.25));
      const li = c.look.light;
      const power = li.efficacy * c.thrust;
      if (!light || power > light.power) {
        const a = toSite(v3.addScaled(pc.originRelCam, pc.axisX, reMax));
        const b = toSite(v3.addScaled(pc.originRelCam, pc.axisX, Math.min(h, reMax + 1.2 * core)));
        light = { a, b, intensity: [li.color[0] * power, li.color[1] * power, li.color[2] * power], power };
      }
    }
    if (weight > 0) {
      foot = v3.scale(foot, 1 / weight);
      top = v3.scale(top, 1 / weight);
      dir = v3.normalize(dir);
      jetRadius /= weight;
      jetLength /= weight;
      nozzleHeight /= weight;
      if (effectTime - this.lastSource > S.linger) this.firstSource = effectTime;
      this.lastSource = effectTime;
    }
    if (effectTime - this.lastSource > S.linger) {
      this.isActive = false;
      this.needsClear = true;
      return null;
    }
    if (!this.isActive || this.site !== best.site) this.needsClear = true;
    this.isActive = true;
    this.site = best.site;

    // The trench of this site, from its structures; the focus fades as the vehicle climbs and its jet hits the open pad.
    const trench = best.site.structures.find((s) => S.trenchModels.includes(s.model));
    const th = (trench?.headingDeg ?? 0) * DEG;
    const focus = trench ? S.trenchFocus * Math.exp(-Math.max(0, nozzleHeight - best.site.pad.clampHeight * 1.5) / 40) : 0;
    const deluge = Math.min(1, (effectTime - this.firstSource) / S.deluge.ramp) * (effectTime - this.firstSource < S.deluge.duration ? 1 : Math.exp(-(effectTime - this.firstSource - S.deluge.duration) / 2));
    const wh = S.wind.headingDeg * DEG;
    const horizontalScale = (S.centerCell * S.grid[0]) / 2;
    const verticalScale = S.bottomCell * S.grid[1];
    const warpH = 1 - horizontalScale / S.halfExtent;
    const warpV = 1 - verticalScale / S.height;
    const sun = toSite(v3.add(best.origin, frame.sun.dirRoot));
    this.sunUp = sun.y > 0;
    this.sourceRate = smoke * S.smoke.yield;
    const u = this.u;
    u.set([best.origin.x, best.origin.y, best.origin.z, weight > 0 ? strength : 0], 0);
    u.set([best.east.x, best.east.y, best.east.z, horizontalScale], 4);
    u.set([best.up.x, best.up.y, best.up.z, warpH], 8);
    u.set([best.north.x, best.north.y, best.north.z, verticalScale], 12);
    u.set([warpV, S.halfExtent, S.height, S.steps], 16);
    u.set([foot.x, 0, foot.z, nozzleHeight], 20);
    u.set([smoke * S.smoke.yield, smoke * S.steam.yield * deluge, S.jetRadius, focus], 24);
    u.set([Math.sin(th), Math.cos(th), S.trenchLength, 0], 28);
    u.set([S.jetSpeed, S.jetRadius, S.buoyancy, S.cooling], 32);
    u.set([S.turbulence, S.dissipation, Math.sin(wh) * S.wind.speed, Math.cos(wh) * S.wind.speed], 36);
    u.set([sun.x, sun.y, sun.z, dt], 40);
    u.set([light?.a.x ?? 0, light?.a.y ?? 30, light?.a.z ?? 0, 0], 44);
    u.set([light?.intensity[0] ?? 0, light?.intensity[1] ?? 0, light?.intensity[2] ?? 0, S.groundShadow], 48);
    u.set([...S.smoke.albedo, S.erosion], 52);
    u.set([...S.steam.albedo, S.erosionScale], 56);
    u.set([this.needsClear ? 1 : 0, effectTime, 0, 0], 60);
    u.set([S.glow.color[0] * S.glow.luminance, S.glow.color[1] * S.glow.luminance, S.glow.color[2] * S.glow.luminance, 0], 64);
    // The cloud front runs out with the wall jet (r ~ sqrt(2 U0 r0 t)), rises on its heat and drifts with the wind.
    const age = effectTime - this.firstSource;
    const drift = S.wind.speed * Math.max(0, age - 10) * 0.6;
    const radius = Math.min(S.halfExtent, 90 + Math.sqrt(2 * S.jetSpeed * S.jetRadius * Math.min(age, 60)) * 1.25 + drift + 1.5 * Math.max(0, age - 60));
    const height = Math.min(S.height, 60 + (S.buoyancy + 4) * Math.min(age, 40) + 2 * Math.max(0, age - 40));
    const cx = foot.x * (weight > 0 ? 1 : 0) + Math.sin(wh) * drift;
    const cz = foot.z * (weight > 0 ? 1 : 0) + Math.cos(wh) * drift;
    u.set([cx, cz, radius, height], 68);
    u.set([top.x, top.y, top.z, jetRadius], 72);
    u.set([dir.x, dir.y, dir.z, weight > 0 ? jetLength : 0], 76);
    u.set([S.jet.speed, S.jet.entrainment, S.jet.spread, weight > 0 ? strength : 0], 80);
    u.set([light?.b.x ?? 0, light?.b.y ?? 0, light?.b.z ?? 0, 0], 84);

    // The box of cells the cloud has reached (it only grows until the grid is cleared).
    if (this.needsClear) this.box = null;
    const cellU = (x: number): number => (0.5 + (0.5 * x) / (horizontalScale + warpH * Math.abs(x))) * S.grid[0];
    const cellW = (z: number): number => (0.5 + (0.5 * z) / (horizontalScale + warpH * Math.abs(z))) * S.grid[2];
    const cellV = (y: number): number => (y / (verticalScale + warpV * y)) * S.grid[1];
    const snap8 = (lo: number, hi: number, n: number): [number, number] => [Math.max(0, Math.floor((lo - 3) / 8) * 8), Math.min(Math.ceil(n / 8) * 8, Math.ceil((hi + 3) / 8) * 8)];
    const bx = snap8(cellU(Math.max(-S.halfExtent, cx - radius)), cellU(Math.min(S.halfExtent, cx + radius)), S.grid[0]);
    const by = snap8(0, cellV(height), S.grid[1]);
    const bz = snap8(cellW(Math.max(-S.halfExtent, cz - radius)), cellW(Math.min(S.halfExtent, cz + radius)), S.grid[2]);
    const prev = this.box;
    this.box = prev
      ? { lo: [Math.min(prev.lo[0], bx[0]), Math.min(prev.lo[1], by[0]), Math.min(prev.lo[2], bz[0])], hi: [Math.max(prev.hi[0], bx[1]), Math.max(prev.hi[1], by[1]), Math.max(prev.hi[2], bz[1])] }
      : { lo: [bx[0], by[0], bz[0]], hi: [bx[1], by[1], bz[1]] };
    const b = this.box;
    // While clearing, the whole grid is written.
    const lo = this.needsClear ? [0, 0, 0] : b.lo;
    u.set([lo[0]!, lo[1]!, lo[2]!, 0], U_BOX);
    u.set([lo[0]! / 2, lo[1]! / 2, lo[2]! / 2, 0], U_BOX + 4);
    this.boxShare = ((b.hi[0] - b.lo[0]) * (b.hi[1] - b.lo[1]) * (b.hi[2] - b.lo[2])) / (S.grid[0] * S.grid[1] * S.grid[2]);
    this.device.queue.writeBuffer(this.uniform, 0, u);
    this.stepped = dt > 0 || this.needsClear;

    // Screen rectangle of the cylinder that holds the cloud, in pixels of the quarter-resolution targets.
    const [qw, qh] = this.quarter[0].size;
    const vw = frame.view;
    const m = frame.projUnjittered;
    let x0 = Infinity;
    let x1 = -Infinity;
    let y0 = Infinity;
    let y1 = -Infinity;
    let behind = false;
    for (let k = 0; k < 8; k++) {
      const px = cx + (k & 1 ? radius : -radius);
      const py = k & 2 ? height : 0;
      const pz = cz + (k & 4 ? radius : -radius);
      const rel = v3.add(best.origin, v3.add(v3.add(v3.scale(best.east, px), v3.scale(best.up, py)), v3.scale(best.north, pz)));
      const vx = vw[0]! * rel.x + vw[4]! * rel.y + vw[8]! * rel.z;
      const vy = vw[1]! * rel.x + vw[5]! * rel.y + vw[9]! * rel.z;
      const vz = vw[2]! * rel.x + vw[6]! * rel.y + vw[10]! * rel.z;
      if (vz > -0.5) {
        behind = true;
        break;
      }
      const sx = ((m[0]! * vx) / -vz) * 0.5 + 0.5;
      const sy = 0.5 - ((m[5]! * vy) / -vz) * 0.5;
      x0 = Math.min(x0, sx);
      x1 = Math.max(x1, sx);
      y0 = Math.min(y0, sy);
      y1 = Math.max(y1, sy);
    }
    if (behind) this.rect = [0, 0, qw, qh];
    else {
      const rx0 = Math.max(0, Math.floor(x0 * qw) - 2);
      const ry0 = Math.max(0, Math.floor(y0 * qh) - 2);
      const rx1 = Math.min(qw, Math.ceil(x1 * qw) + 2);
      const ry1 = Math.min(qh, Math.ceil(y1 * qh) + 2);
      this.rect = rx1 > rx0 && ry1 > ry0 ? [rx0, ry0, rx1 - rx0, ry1 - ry0] : null;
    }
    return best.origin;
  }

  /** compute hook: one advection step and the light volume. */
  compute(frame: FrameContext, encoder: GPUCommandEncoder): void {
    if (!this.isActive || !this.stepped || !this.box) return;
    const clearing = this.needsClear;
    if (clearing) this.stepIndex = 0;
    this.needsClear = false;
    const pass = encoder.beginComputePass({ label: 'vfx.smoke', timestampWrites: this.ctx.perf.gpuPass('vfx.smoke.sim') as GPUComputePassTimestampWrites | undefined });
    pass.setBindGroup(0, frame.frameBindGroup);
    pass.setBindGroup(1, this.common.bindGroup());
    const groups = (lo: number, hi: number, cell: number): number => Math.ceil((hi - lo) / cell / 4);
    const b: CellBox = clearing ? { lo: [0, 0, 0], hi: [this.dims[0], this.dims[1], this.dims[2]] } : this.box;
    pass.setPipeline(this.advectPipeline);
    // Clearing writes both textures (the box that is simulated afterwards never reads beyond what was cleared).
    for (let k = 0; k < (clearing ? 2 : 1); k++) {
      pass.setBindGroup(2, this.advectGroups[this.cur]!);
      pass.dispatchWorkgroups(groups(b.lo[0], b.hi[0], 1), groups(b.lo[1], b.hi[1], 1), groups(b.lo[2], b.hi[2], 1));
      this.cur = 1 - this.cur;
    }
    // The light volume (transmittances and occupancy) changes slowly: every second step is enough.
    if ((this.stepIndex++ & 1) === 0) {
      pass.setPipeline(this.lightPipeline);
      pass.setBindGroup(2, this.lightGroups[this.cur]!);
      pass.dispatchWorkgroups(groups(b.lo[0], b.hi[0], 2), groups(b.lo[1], b.hi[1], 2), groups(b.lo[2], b.hi[2], 2));
    }
    pass.end();
  }

  /** The march at quarter resolution, then the smoke composed with the emitters into `target` / `targetMoment`. */
  run(frame: FrameContext, encoder: GPUCommandEncoder, emit: ManagedTarget, moment: ManagedTarget, target: ManagedTarget, targetMoment: ManagedTarget, haveEmitters: boolean): void {
    const q = this.quarter;
    const v = emit.version + moment.version + q[0].version;
    if (!this.marchGroups || !this.combineGroup || v !== this.groupVersion) {
      this.groupVersion = v;
      const lightView = this.lightTex.createView();
      const mk = (k: number): GPUBindGroup =>
        this.device.createBindGroup({
          label: 'vfx.smoke.march',
          layout: this.marchLayout,
          entries: [
            { binding: 0, resource: { buffer: this.uniform } },
            { binding: 1, resource: this.density[k]!.createView() },
            { binding: 2, resource: lightView },
            { binding: 3, resource: moment.view },
          ],
        });
      this.marchGroups = [mk(0), mk(1)];
      this.combineGroup = this.device.createBindGroup({
        label: 'vfx.smoke.combine',
        layout: this.combineLayout,
        entries: [{ binding: 0, resource: { buffer: this.uniform } }, { binding: 1, resource: emit.view }, { binding: 2, resource: moment.view }, ...q.map((t, i) => ({ binding: 3 + i, resource: t.view }))],
      });
    }
    // The flag "emitters were drawn" is only known now: one float of the uniform.
    this.device.queue.writeBuffer(this.uniform, U_EMITTERS * 4, new Float32Array([haveEmitters ? 1 : 0]));
    const none = { r: 0, g: 0, b: 0, a: 1 };
    const march = encoder.beginRenderPass({
      label: 'vfx.smoke.march',
      colorAttachments: [
        ...q.slice(0, 4).map((t) => ({ view: t.view, loadOp: 'clear' as const, storeOp: 'store' as const, clearValue: none })),
        { view: q[4].view, loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 0 } },
      ],
      timestampWrites: this.ctx.perf.gpuPass('vfx.smoke.march') as GPURenderPassTimestampWrites | undefined,
    });
    if (this.rect) {
      const [qw, qh] = q[0].size;
      // The rectangle was measured in prepare; the targets may have been resized since.
      const x = Math.min(this.rect[0], qw - 1);
      const y = Math.min(this.rect[1], qh - 1);
      march.setScissorRect(x, y, Math.max(1, Math.min(this.rect[2], qw - x)), Math.max(1, Math.min(this.rect[3], qh - y)));
      march.setBindGroup(0, frame.frameBindGroup);
      march.setBindGroup(1, this.common.bindGroup());
      march.setBindGroup(2, this.marchGroups[this.cur]!);
      march.setPipeline(this.marchPipeline.get());
      march.draw(3);
    }
    march.end();
    const combine = encoder.beginRenderPass({
      label: 'vfx.smoke.combine',
      colorAttachments: [
        { view: target.view, loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 0 } },
        { view: targetMoment.view, loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 0 } },
      ],
      timestampWrites: this.ctx.perf.gpuPass('vfx.smoke.combine') as GPURenderPassTimestampWrites | undefined,
    });
    combine.setBindGroup(0, frame.frameBindGroup);
    combine.setBindGroup(1, this.common.bindGroup());
    combine.setBindGroup(2, this.combineGroup);
    combine.setPipeline(this.combinePipeline.get());
    combine.draw(3);
    combine.end();
  }

  /** drawTransparent, before the volume image: the cloud's shadow on the opaque scene (by day). */
  drawGroundShadow(pass: GPURenderPassEncoder): void {
    if (!this.isActive || !this.sunUp || this.data.padSmoke.groundShadow <= 0) return;
    pass.setPipeline(this.shadowPipeline.get());
    pass.setBindGroup(1, this.common.bindGroup());
    pass.setBindGroup(2, this.shadowGroup);
    pass.draw(3);
  }

  dispose(): void {
    for (const t of this.density) t.destroy();
    for (const t of this.quarter) t.destroy();
    this.lightTex.destroy();
    this.uniform.destroy();
  }
}
