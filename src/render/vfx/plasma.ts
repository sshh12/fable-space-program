/**
 * Reentry plasma: the bow-shock layer wrapped around the windward side of a vessel, the sheath of glowing
 * gas that leaves its shoulder and the streaked wake it closes into, marched at half resolution in a box
 * aligned with the air flow.
 *
 * The vessel is represented by a shape proxy (pure function `reentryProxy`): a blunt body of revolution, a
 * spherical cap of the nose radius on a tapering afterbody. It comes from PartVisualDef.reentryShape of the
 * windward part when present (a capsule: heat shield, shoulder, back shell), else from the parts' bounds (a
 * cylinder with a shallow cap turned into the wind). The shock stands off the wall by `standoff x nose
 * radius` at the stagnation point and further where the wall turns away from the flow; the gas in the layer
 * streams from the stagnation point outwards along the wall, and its streaks move with it. Emission follows
 * the heat flux, the colour runs from orange through pink to white-violet with the air speed, and the whole
 * flickers at 8 - 30 Hz. `plasmaIntensity` shapes it: a faint rim of orange at 0.3, a white-hot cap with a
 * long streaming wake at 1.
 */
import type { DefLibrary } from '@/core/contracts/defs';
import type { FrameContext, LocalLight, RenderContext } from '@/core/contracts/render';
import type { VesselSnapshot } from '@/core/contracts/sim';
import { hashToUnit, hashU32, quat, v3, type Vec3, type Vec3Tuple } from '@/core/math';
import type { Tracked } from '@/render/core';
import type { VfxCommon } from './common';
import type { VfxData } from './data';
import { createVolumePipeline, type EmitterHint, type VolumeItem } from './volumes';

export const MAX_PLASMA = 4;
const INST_FLOATS = 36;
/** Seconds one cycle of the flow maps of the shock layer takes. */
const FLOW_CYCLE = 0.4;

export interface ReentryProxy {
  /** Centre of the shoulder plane (where the windward cap meets the afterbody) and the unit axis from the cap towards the lee end, vessel frame. */
  centreVes: Vec3;
  axisVes: Vec3;
  /** Radius at the shoulder, nose radius of the windward cap, length and end radius of the afterbody, m. */
  radius: number;
  noseRadius: number;
  afterLength: number;
  tipRadius: number;
  /** True when the windward part carries a PartVisualDef.reentryShape. */
  shaped: boolean;
}

/** Height of a spherical cap of radius `nose` over a base of radius `base`. */
export function capHeight(nose: number, base: number): number {
  return nose > base ? nose - Math.sqrt(nose * nose - base * base) : base;
}

/**
 * Shape proxy of a vessel for the shock layer. `windVes` = unit direction the air flows in, vessel frame.
 * The windward part is the one that reaches furthest upstream. With a reentryShape the proxy is that shape
 * (its blunt face is the part's thermal surface with an explicit normal, else its -Y end), lengthened to
 * hold the rest of the vessel; without one it is the cylinder of the parts' bounds about the vessel's long
 * axis with a cap of the windward part's thermal nose radius turned into the wind.
 */
export function reentryProxy(defs: DefLibrary, vessel: VesselSnapshot, windVes: Vec3): ReentryProxy {
  let yMin = Infinity;
  let yMax = -Infinity;
  let radius = 0.3;
  let upstream = Infinity;
  let lead: { part: VesselSnapshot['parts'][number]; axis: Vec3 } | null = null;
  for (const part of vessel.parts) {
    const def = defs.parts[part.def];
    if (!def) continue;
    const axis = quat.rotate(part.localRot, v3.unitY());
    for (const y of [def.bounds.yMin, def.bounds.yMax]) {
      const p = v3.addScaled(part.localPos, axis, y);
      // The stack stands along the vessel's +Y: extent along it, radius about it.
      yMin = Math.min(yMin, p.y);
      yMax = Math.max(yMax, p.y);
      radius = Math.max(radius, Math.hypot(p.x, p.z) + def.bounds.radius * Math.abs(axis.y));
      const reach = v3.dot(p, windVes) - def.bounds.radius * Math.sqrt(Math.max(0, 1 - v3.dot(axis, windVes) ** 2));
      if (reach < upstream) {
        upstream = reach;
        lead = { part, axis };
      }
    }
  }
  if (!Number.isFinite(yMin) || !lead) {
    yMin = -vessel.boundingRadius;
    yMax = vessel.boundingRadius;
  }
  const leadDef = lead ? defs.parts[lead.part.def] : undefined;
  const shape = leadDef?.visual?.reentryShape;
  if (lead && leadDef && shape) {
    // The blunt face: the thermal surface with an explicit normal (the heat shield), else the part's -Y end.
    let faceY = -1;
    for (const s of leadDef.thermal.surfaces) if (Array.isArray(s.normal) && Math.abs(s.normal[1]) > 0.5) faceY = Math.sign(s.normal[1]);
    const axisVes = v3.scale(lead.axis, -faceY);
    const base = shape.baseRadius;
    const nose = Math.max(shape.noseRadius, base);
    const sag = capHeight(nose, base);
    const apex = v3.addScaled(lead.part.localPos, lead.axis, faceY < 0 ? leadDef.bounds.yMin : leadDef.bounds.yMax);
    const centreVes = v3.addScaled(apex, axisVes, sag);
    // What else the vessel carries behind the shield lengthens and widens the afterbody.
    let after = Math.max(shape.length - sag, 0.1);
    let tip = 0.2 * base;
    for (const part of vessel.parts) {
      const def = defs.parts[part.def];
      if (!def || part === lead.part) continue;
      const axis = quat.rotate(part.localRot, v3.unitY());
      for (const y of [def.bounds.yMin, def.bounds.yMax]) {
        const along = v3.dot(v3.sub(v3.addScaled(part.localPos, axis, y), centreVes), axisVes);
        if (along > after) {
          after = along;
          tip = Math.max(tip, def.bounds.radius);
        }
      }
    }
    return { centreVes, axisVes, radius: base, noseRadius: nose, afterLength: after, tipRadius: tip, shaped: true };
  }
  let thermal = 0;
  if (leadDef) for (const s of leadDef.thermal.surfaces) thermal = Math.max(thermal, s.noseRadius);
  const nose = Math.max(thermal > 0 ? thermal : 2.5 * radius, 1.02 * radius);
  const sag = capHeight(nose, radius);
  const down = windVes.y >= 0 ? 1 : -1;
  const axisVes = { x: 0, y: down, z: 0 };
  const length = Math.max(yMax - yMin, 0.4);
  return {
    centreVes: { x: 0, y: (down > 0 ? yMin : yMax) + down * Math.min(sag, 0.5 * length), z: 0 },
    axisVes,
    radius,
    noseRadius: nose,
    afterLength: Math.max(length - Math.min(sag, 0.5 * length), 0.1),
    tipRadius: radius,
    shaped: false,
  };
}

/** Colour of the plasma for an air speed (m/s): orange, pink, white-violet. */
export function plasmaColor(data: VfxData['reentry'], speed: number): Vec3Tuple {
  const [s0, s1, s2] = data.colorSpeeds;
  const [c0, c1, c2] = data.colors;
  const mix = (a: Vec3Tuple, b: Vec3Tuple, t: number): Vec3Tuple => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  if (speed <= s1) return mix(c0, c1, Math.min(1, Math.max(0, (speed - s0) / (s1 - s0))));
  return mix(c1, c2, Math.min(1, (speed - s1) / (s2 - s1)));
}

/** Luminance (cd/m^2) of the shock layer for a stagnation heat flux (W/m^2) and plasma intensity 0..1. */
export function plasmaLuminance(data: VfxData['reentry'], heatFlux: number, intensity: number): number {
  const flux = Math.max(heatFlux, intensity * data.referenceFlux * 0.05);
  return data.luminance * Math.pow(flux / data.referenceFlux, data.fluxExponent) * Math.min(1, intensity / Math.max(data.minIntensity * 2, 1e-3));
}

/**
 * What a camera in the cabin sees through a window on the lee side (the afterbody about one shoulder radius
 * behind the shoulder): the sheath streaming past, as the shader draws it there, averaged over its streaks
 * and its flicker. Luminance in cd/m^2 and a colour of unit luminance; for the light the windows throw into
 * the cabin. `speed` = air speed (m/s).
 */
export function plasmaWindowRadiance(data: VfxData['reentry'], heatFlux: number, intensity: number, speed: number): { luminance: number; color: Vec3Tuple } {
  const k = Math.min(1, Math.max(0, intensity));
  if (k < data.minIntensity) return { luminance: 0, color: plasmaColor(data, speed) };
  // The shader at x = 1 shoulder radius: a ray from the hull crosses the skirt once (a Gaussian shell at
  // Rw = (0.28 + 0.8 e^(-1/1.3)) 1.012 = 0.659 radii, width 0.14 Rw + 0.04 = 0.132 radii, emission 0.9 x 0.3
  // per radius, e^-1 of its strength at the shoulder, as hot as the lee shoulder: 0.3 + 2.4 x 0.05^2), whose
  // glow has fallen most of the way to the wake's (smoothstep from -0.3 to 1.6 radii: 0.764 of the way) and
  // along the wake by 0.75 e^-0.5 plus a quarter at 1/34 of its e-folding length.
  const wS = 0.14 * (0.28 + 0.8 * Math.exp(-1 / 1.3)) * 1.012 + 0.04;
  const across = 0.9 * 0.3 * Math.sqrt(Math.PI) * wS * Math.exp(-1) * (0.3 + 2.4 * 0.05 * 0.05);
  const gain = 1 - 0.764 * (1 - data.wakeGain);
  const fade = 0.75 * Math.exp(-0.5) + 0.25 * Math.exp(-1 / (data.wakeLengthRadii * (0.3 + 0.7 * k)));
  const c = plasmaColor(data, speed);
  const cl = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  return { luminance: plasmaLuminance(data, heatFlux, k) * cl * across * gain * fade, color: [c[0] / cl, c[1] / cl, c[2] / cl] };
}

/** Smooth value noise in [-1, 1] for the flicker. */
function flickerNoise(x: number, seed: number): number {
  const i = Math.floor(x);
  const f = x - i;
  const a = hashToUnit(hashU32((i + seed * 7919) >>> 0)) * 2 - 1;
  const b = hashToUnit(hashU32((i + 1 + seed * 7919) >>> 0)) * 2 - 1;
  return a + (b - a) * f * f * (3 - 2 * f);
}

const WGSL = /* wgsl */ `
#include "vfx_common"
#include "vfx_volume"
struct PlasmaInst {
  origin: vec4f,    // xyz = centre of the proxy's shoulder plane relative to the camera, w = length of the box downstream (m)
  windX: vec4f,     // xyz = unit direction of the air flow (ROOT axes), w = radius of the box (m)
  windY: vec4f,     // xyz, w = start of the box upstream (m, negative)
  windZ: vec4f,     // xyz, w = march steps
  bodyAxis: vec4f,  // xyz = axis of the proxy in the wind frame (windward cap -> lee end), w = shoulder radius (m)
  bodyDim: vec4f,   // x = nose radius of the cap (m), y = length of the afterbody (m), z = radius of its lee end (m), w = shock standoff at the stagnation point (m)
  color: vec4f,     // rgb = colour x luminance (cd/m^2), w = flicker gain
  params: vec4f,    // x = scroll of the wake streaks (m), y = intensity 0..1, z = seed, w = e-folding length of the wake (m)
  flow: vec4f,      // x = phase of the flow maps of the shock layer (cycles), y = emission of the wake relative to the layer, z, w unused
}
@group(2) @binding(0) var<storage, read> plasmaInst: array<PlasmaInst, ${MAX_PLASMA}>;

struct VOut { @builtin(position) pos: vec4f, @location(0) @interpolate(flat) inst: u32 }
@vertex fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VOut {
  let I = plasmaInst[ii];
  var o: VOut;
  o.pos = volumeBoxVertex(vi, I.origin.xyz, I.windX.xyz, I.windY.xyz, I.windZ.xyz, vec3f(I.windY.w, -I.windX.w, -I.windX.w), vec3f(I.origin.w, I.windX.w, I.windX.w));
  o.inst = ii;
  return o;
}

struct BodyAt {
  sd: f32,     // distance to the wall (m, negative inside)
  n: vec3f,    // unit direction away from the wall (wind frame)
}
/// The blunt body of revolution at 'p' (wind frame, origin at the centre of the shoulder plane): a spherical
/// cap on the windward side of the plane, a frustum on the lee side.
fn plasmaBody(I: PlasmaInst, p: vec3f) -> BodyAt {
  let a = I.bodyAxis.xyz;
  let Rb = I.bodyAxis.w;
  let Rn = I.bodyDim.x;
  let hh = 0.5 * I.bodyDim.y;
  let Rt = I.bodyDim.z;
  let h = dot(p, a);
  let radial = p - a * h;
  let rho = length(radial);
  let rdir = radial / max(rho, 1e-4);
  var o: BodyAt;
  // Cap: the nearest point of the sphere when that lies on the cap, else the rim.
  let cz = sqrt(max(Rn * Rn - Rb * Rb, 0.0));
  let toC = p - a * cz;
  let lc = max(length(toC), 1e-4);
  var dCap: f32;
  var nCap: vec3f;
  if (h <= 0.0 && Rn * rho <= Rb * lc) {
    dCap = lc - Rn;
    nCap = toC / lc;
  } else {
    // On the lee side of the plane the cap ends in the disc that the afterbody stands on.
    let e = vec2f(max(rho - Rb, 0.0), h);
    dCap = length(e);
    nCap = normalize(rdir * e.x + a * e.y + a * 1e-5);
  }
  // Afterbody: a capped cone from (Rb, 0) to (Rt, 2 hh).
  let q = vec2f(rho, h - hh);
  let k1 = vec2f(Rt, hh);
  let k2 = vec2f(Rt - Rb, 2.0 * hh);
  let ca = vec2f(q.x - min(q.x, select(Rt, Rb, q.y < 0.0)), abs(q.y) - hh);
  let cb = q - k1 + k2 * clamp(dot(k1 - q, k2) / dot(k2, k2), 0.0, 1.0);
  let inside = cb.x < 0.0 && ca.y < 0.0;
  let da = dot(ca, ca);
  let db = dot(cb, cb);
  let dF = select(1.0, -1.0, inside) * sqrt(min(da, db));
  if (dCap < dF) {
    o.sd = dCap;
    o.n = nCap;
  } else {
    o.sd = dF;
    let e = select(cb, vec2f(ca.x, ca.y * sign(q.y)), da < db);
    o.n = normalize(rdir * e.x + a * e.y + rdir * 1e-5);
  }
  return o;
}

@fragment fn fs(in: VOut) -> VolumeOut {
  let I = plasmaInst[in.inst];
  let R = volumeRay(in.pos, I.origin.xyz, I.windX.xyz, I.windY.xyz, I.windZ.xyz, vec3f(I.windY.w, -I.windX.w, -I.windX.w), vec3f(I.origin.w, I.windX.w, I.windX.w));
  if (R.t1 <= R.t0) { return volumeNone(); }
  let Rb = I.bodyAxis.w;
  let d0s = I.bodyDim.w;
  let k = I.params.y;
  let wakeLen = I.params.w;
  let boxLen = I.origin.w;
  let tc = clamp(-dot(R.ro, R.rd), R.t0, R.t1);
  let dc = length(R.ro + R.rd * tc);
  let d0 = max(0.12 * Rb, 0.3 * dc);
  let s0 = R.t0 - tc;
  let s1 = R.t1 - tc;
  let w0 = sign(s0) * log(1.0 + abs(s0) / d0);
  let w1 = sign(s1) * log(1.0 + abs(s1) / d0);
  let steps = max(10.0, floor(I.windZ.w * vfx.time.w + 0.5));
  let jitter = blueNoise(vec2u(in.pos.xy)).b;
  let seed = vec3f(I.params.z, I.params.z * 1.7, I.params.z * 0.3);
  let hot = vec3f(luminance(I.color.rgb)) * vec3f(1.3, 1.22, 1.12);
  let fp = 2.0 * frame.cameraUp.w * vfx.half.w;      // footprint of a pixel per metre of distance
  let ph = fract(vec2f(I.flow.x, I.flow.x + 0.5));
  let wa = 1.0 - abs(2.0 * ph.x - 1.0);
  // Is the eye in the vessel itself (a cabin camera)? Then the hull and the cabin stop every ray but those
  // that leave through a window, and those see the layer and the sheath streaming past right outside it.
  let inBody = select(0.0, 1.0, plasmaBody(I, R.ro).sd < 0.0);
  let wakeGain = I.flow.y;
  let a = I.bodyAxis.xyz;
  var L = vec3f(0.0);
  var wsum = 0.0;
  var tsum = 0.0;
  for (var i = 0.0; i < steps; i += 1.0) {
    let w = mix(w0, w1, (i + jitter) / steps);
    let ew = exp(abs(w));
    let t = tc + sign(w) * d0 * (ew - 1.0);
    let dt = d0 * ew * (w1 - w0) / steps;
    let p = R.ro + R.rd * t;
    let B = plasmaBody(I, p);
    if (B.sd <= 0.0) { continue; }
    var j = vec3f(0.0);
    // How far round to the windward side this point lies, from a point inside the body (smooth across the
    // shoulder, where the wall normal of the proxy jumps): 1 at the stagnation point, about 0.6 at the
    // windward shoulder of a capsule flying at its trim angle, near 0 at the lee shoulder and behind.
    let m = normalize(p - a * (0.4 * Rb));
    let e = saturate(-m.x);
    // Shock layer: the gas between the bow shock and the wall. Its glow is concentrated where the flow
    // stagnates (density and temperature are highest there: a few hundredths of a radius from the wall, it
    // falls off as e^3 round the face), and it fades out smoothly with the distance from the wall over the
    // standoff, thicker towards the shoulder. Seen face-on it is brightest in the middle (no rim ring); from
    // the side a compact clipped head whose glare the bloom carries. Its turbulence is carried along the
    // wall by the flow (two phases of a flow map, cross-faded): at the stagnation point, where the flow
    // stands still, it only boils; streaks form where the gas runs fast.
    let delta = d0s * (1.0 + 2.0 * (1.0 - e)) * (0.65 + 0.35 * k);
    if (B.sd < 6.0 * delta + 1.6 * Rb && e > 0.0) {
      let v = vec3f(1.0, 0.0, 0.0) - m * m.x;
      let adv = 1.6 * Rb;
      let qa = p - v * (ph.x * adv);
      let qb = p - v * (ph.y * adv);
      let lod = max(t * fp, 0.5 * dt) * 1.2 / Rb;
      let na = vfxNoiseLod((qa - v * (dot(qa, v) * 0.6)) * (1.2 / Rb) + seed, lod);
      let nb = vfxNoiseLod((qb - v * (dot(qb, v) * 0.6)) * (1.2 / Rb) + seed + vec3f(0.37, 0.71, 0.13), lod);
      let stream = 1.0 - e;
      let tex = 1.0 + (0.35 + 0.6 * stream) * (mix(nb.g, na.g, wa) - 0.5) + (0.25 + 0.5 * stream) * (mix(nb.r, na.r, wa) - 0.5);
      let face = e * e * e;
      // (Beyond the shock the air is cold: the glow ends within a couple of standoffs, softly, and what is seen
      // round it is the bloom of the clipped layer, not a long exponential tail that clips metres out.)
      let layer = exp(-sq(B.sd / (1.1 * delta))) * (1.13 / delta);
      let heat = saturate(e * e * (0.35 + 0.65 * k));
      j += mix(I.color.rgb, hot, heat) * (face * layer * tex * (0.55 + 0.45 * k));
      // The hot gas around the head: a faint envelope that reaches a third of a radius out on the windward
      // side (the glare round the head is the bloom's business: a bright envelope would be a halo disc).
      j += I.color.rgb * (0.003 * (0.3 + 0.7 * k) * exp(-B.sd / (0.3 * Rb)) * (0.05 + 0.95 * e * e * e) / (0.3 * Rb));
    }
    // Behind the shoulder: the gas leaves the wall as a skirt that is hot where the windward shoulder was hot,
    // necks down behind the body into a filled wake (brighter on its axis than at its edge), and streams away
    // narrowing, dimming and cooling: its glow falls to a twentieth of the layer's within a radius or two
    // (wakeGain) and by as much again within a few body lengths, its colour runs from white-hot through the
    // colour of the gas and orange to dull red, where the trail takes over.
    let xw = p.x;
    if (xw > -0.5 * Rb) {
      let rw = length(p.yz);
      let xs = max(xw, 0.0);
      let Rw = Rb * (0.28 + 0.8 * exp(-xs / (1.3 * Rb))) * (1.0 + 0.012 * xs / Rb);
      // The skirt where it leaves the shoulder: as hot as the shoulder at that azimuth.
      let radial = p - a * dot(p, a);
      let sh = radial * (Rb / max(length(radial), 1e-4));
      let msh = normalize(sh - a * (0.4 * Rb));
      let eSh = saturate(-msh.x);
      let skirtHeat = 0.3 + 2.4 * eSh * eSh;
      let shell = exp(-xs / Rb);
      let wS = 0.14 * Rw + 0.04 * Rb;
      let skirt = exp(-sq((rw - Rw) / wS)) * smoothstep(-0.45 * Rb, 0.2 * Rb, xw) * shell * skirtHeat;
      let core = exp(-sq(rw / (0.62 * Rw))) * smoothstep(0.2 * Rb, 1.6 * Rb, xw);
      // Streamers: the gas is drawn out along the flow into filaments far longer than they are wide, at three
      // scales, in coordinates that shrink with the wake (they converge with it), pushed sideways by a slow
      // warp (they kink), and of very different brightness; what the march cannot resolve is left out (it
      // averages to 1), not turned into grain.
      let foot = max(t * fp, 0.4 * dt);
      let kink = vfxNoiseLod(vec3f((xw - I.params.x * 0.5) * 0.045 / Rb, 0.31, 0.77) + seed * 1.9, foot * 0.045 / Rb);
      let yz = (p.yz + (vec2f(kink.r, kink.g) - 0.5) * (0.5 * Rw)) / Rw;
      let s1 = vfxNoiseLod(vec3f((xw - I.params.x) * 0.05 / Rb, yz.x * 1.6, yz.y * 1.6) + seed * 2.3, foot * 1.6 / Rw);
      let s2 = vfxNoiseLod(vec3f((xw - I.params.x * 1.4) * 0.11 / Rb, yz.x * 4.1, yz.y * 4.1) + seed * 3.7, foot * 4.1 / Rw);
      let s3 = vfxNoiseLod(vec3f((xw - I.params.x * 2.1) * 0.23 / Rb, yz.x * 9.5, yz.y * 9.5) + seed * 5.1, foot * 9.5 / Rw);
      let lines = (0.15 + 2.4 * s1.r * s1.r) * (0.45 + 1.1 * s2.a) * (0.7 + 0.6 * s3.g);
      let cool = xs / (6.0 * Rb);
      var tint = mix(I.color.rgb, vec3f(1.0, 0.38, 0.15) * luminance(I.color.rgb) * 1.25, smoothstep(0.15, 1.0, cool));
      tint = mix(tint, vec3f(1.0, 0.22, 0.07) * luminance(I.color.rgb) * 1.1, smoothstep(1.0, 3.0, cool));
      // (White-hot only where it leaves the shoulder, and in the middle more than at the edge.)
      tint = mix(tint, hot, saturate(0.45 * k * (1.0 - smoothstep(0.0, 1.4 * Rb, xs)) * (0.4 + 0.6 * exp(-sq(rw / Rw)))));
      // (The skirt keeps the glow of the layer round the shoulder a little longer than the wake core: it is the
      // gas that has just left it, and what wraps the back shell's rim.)
      let along = (0.75 * exp(-xs / (2.0 * Rb)) + 0.25 * exp(-xs / wakeLen)) * (1.0 - smoothstep(0.75, 1.0, xs / boxLen));
      let gSkirt = mix(1.0, wakeGain, smoothstep(-0.3 * Rb, 1.6 * Rb, xw));
      let gCore = mix(1.0, wakeGain, smoothstep(-0.3 * Rb, 1.0 * Rb, xw));
      j += tint * ((0.9 * skirt * gSkirt + core * gCore) * lines * along * (0.3 / Rb));
    }
    // Only what touches the lens is left out (one in the cabin has the hull between it and the gas).
    let c = j * (I.color.w * dt * max(smoothstep(0.3 * Rb, 2.0 * Rb, t), inBody));

    let lw = luminance(c) + 1e-12;
    L += c;
    wsum += lw;
    tsum += lw * t;
  }
  if (wsum < 1e-9) { return volumeNone(); }
  return volumeOut(R.uv, L, 1.0, clamp(tsum / wsum, R.t0, R.t1));
}
`;

interface PlacedPlasma {
  originRelCam: Vec3;
  distance: number;
}

export class PlasmaRenderer {
  private readonly device: GPUDevice;
  private readonly data = new Float32Array(MAX_PLASMA * INST_FLOATS);
  private readonly buffer: GPUBuffer;
  private readonly group: GPUBindGroup;
  private readonly pipeline: Tracked<GPURenderPipeline>;
  private placed: PlacedPlasma[] = [];
  readonly lights: { light: LocalLight; power: number }[] = [];
  readonly hints: EmitterHint[] = [];

  constructor(
    private readonly ctx: RenderContext,
    common: VfxCommon,
    private readonly vfx: VfxData,
  ) {
    const device = (this.device = ctx.device);
    this.buffer = device.createBuffer({ label: 'vfx.plasma', size: this.data.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    const layout = device.createBindGroupLayout({ label: 'vfx.plasma', entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } }] });
    this.group = device.createBindGroup({ label: 'vfx.plasma', layout, entries: [{ binding: 0, resource: { buffer: this.buffer } }] });
    this.pipeline = createVolumePipeline(ctx, common, 'vfx.plasma', WGSL, layout);
    this.pipeline.get();
  }

  /** Gather the vessels with plasma, pack the instances and prepare their lights. */
  update(frame: FrameContext, effectTime: number, noiseTime: number): void {
    const R = this.vfx.reentry;
    const D = this.data;
    this.placed = [];
    this.lights.length = 0;
    this.hints.length = 0;
    const list = frame.snapshot.vessels.filter((v) => v.aero.plasmaIntensity >= R.minIntensity && v3.len(v.aero.airVelocity) > 500).sort((x, y) => y.aero.plasmaIntensity - x.aero.plasmaIntensity);
    for (const vessel of list.slice(0, MAX_PLASMA)) {
      const pose = frame.vesselPose(vessel.id);
      if (!pose) continue;
      const speed = v3.len(vessel.aero.airVelocity);
      const wind = v3.scale(vessel.aero.airVelocity, -1 / speed);
      const windVes = quat.rotateInv(pose.q, wind);
      const proxy = reentryProxy(this.ctx.defs, vessel, windVes);
      const origin = v3.add(pose.originRelCam, quat.rotate(pose.q, proxy.centreVes));
      let ref = quat.rotate(pose.q, v3.unitZ());
      if (Math.abs(v3.dot(ref, wind)) > 0.95) ref = quat.rotate(pose.q, v3.unitX());
      const wy = v3.normalize(v3.reject(ref, wind));
      const wz = v3.cross(wind, wy);
      const axisRoot = quat.rotate(pose.q, proxy.axisVes);
      const axisWind = { x: v3.dot(axisRoot, wind), y: v3.dot(axisRoot, wy), z: v3.dot(axisRoot, wz) };
      const intensity = Math.min(1, Math.max(0, vessel.aero.plasmaIntensity));
      const luminance = plasmaLuminance(R, vessel.aero.heatFlux, intensity);
      const color = plasmaColor(R, speed);
      const seed = hashU32(vessel.id.length * 131 + vessel.id.charCodeAt(0)) % 64;
      const flicker = 1 + R.flicker.amount * (0.6 * flickerNoise(effectTime * R.flicker.lowHz, seed) + 0.4 * flickerNoise(effectTime * R.flicker.highHz, seed + 11));
      const sag = capHeight(proxy.noseRadius, proxy.radius);
      const extent = Math.hypot(proxy.radius, Math.max(proxy.afterLength, sag));
      const standoff = R.standoff * proxy.noseRadius;
      const wakeLength = R.wakeLengthRadii * proxy.radius * (0.3 + 0.7 * intensity);
      const boxLength = proxy.afterLength + 2.5 * wakeLength;
      // The sheath is Rw + 3 wS wide at the far end (see the shader).
      // ... and the envelope of hot gas around the head reaches a radius and a half beyond the body.
      const boxRadius = 1.15 * Math.max(extent + 1.5 * proxy.radius, 0.5 * proxy.radius * (1 + (0.02 * boxLength) / proxy.radius) + 3 * (0.12 * proxy.radius + 0.012 * boxLength));
      this.hints.push({ rel: origin, a: extent + standoff, b: extent + standoff, luminance: 0.5 * luminance });
      const o = this.placed.length * INST_FLOATS;
      D.set([origin.x, origin.y, origin.z, boxLength], o);
      D.set([wind.x, wind.y, wind.z, boxRadius], o + 4);
      D.set([wy.x, wy.y, wy.z, -(extent + 1.5 * proxy.radius)], o + 8);
      D.set([wz.x, wz.y, wz.z, R.steps], o + 12);
      D.set([axisWind.x, axisWind.y, axisWind.z, proxy.radius], o + 16);
      D.set([proxy.noseRadius, proxy.afterLength, proxy.tipRadius, standoff], o + 20);
      D.set([color[0] * luminance, color[1] * luminance, color[2] * luminance, flicker], o + 24);
      // The streaks of the wake stream away at a speed the eye can follow (the gas itself is far faster).
      const period = 64 * proxy.radius;
      D.set([(noiseTime * R.streakSpeed) % period, intensity, seed / 64, wakeLength], o + 28);
      D.set([noiseTime / FLOW_CYCLE, R.wakeGain, 0, 0], o + 32);
      this.placed.push({ originRelCam: origin, distance: v3.len(origin) });

      // The glow lights the vessel and its cabin: a sphere of glowing gas just ahead of the windward face, as
      // wide as the shield (LocalLight.radius), so that the rim of the back shell, which faces away from its
      // centre, still sees the part of it beside the shoulder and glows orange there.
      const power = R.light.efficacy * luminance * Math.PI * proxy.radius * proxy.radius * flicker;
      const at = v3.addScaled(origin, wind, -(sag + 2 * standoff + 0.3 * proxy.radius));
      const lum = 0.2126 * color[0] + 0.7152 * color[1] + 0.0722 * color[2];
      this.lights.push({ power: power * lum, light: { kind: 'point', posRelCam: at, intensity: [color[0] * power, color[1] * power, color[2] * power], range: R.light.range, radius: 1.1 * proxy.radius } });
      // ... and the skirt and the wake behind it light the back shell: a second, dimmer and redder light where they close.
      const rear = 0.15 * power * (0.2 + 0.8 * intensity);
      const behind = v3.addScaled(origin, wind, proxy.afterLength + 1.2 * proxy.radius);
      this.lights.push({ power: rear * lum, light: { kind: 'point', posRelCam: behind, intensity: [color[0] * rear, color[1] * rear * 0.7, color[2] * rear * 0.5], range: R.light.range, radius: 1.3 * proxy.radius } });
    }
    if (this.placed.length > 0) this.device.queue.writeBuffer(this.buffer, 0, D, 0, this.placed.length * INST_FLOATS);
  }

  get count(): number {
    return this.placed.length;
  }

  items(): VolumeItem[] {
    return this.placed.map((p, i) => ({
      distance: p.distance,
      draw: (pass: GPURenderPassEncoder) => {
        pass.setPipeline(this.pipeline.get());
        pass.setBindGroup(2, this.group);
        pass.draw(36, 1, 0, i);
      },
    }));
  }

  dispose(): void {
    this.buffer.destroy();
  }
}
