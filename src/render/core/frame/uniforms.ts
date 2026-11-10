/**
 * Packs FrameUniforms (bind group 0, binding 0). Mirrors the WGSL struct in shaders/chunksFrame.ts
 * (offsets below are in 4-byte units) and is documented in docs/RENDER_API.md.
 */
import type { BodyDef, DefLibrary } from '@/core/contracts/defs';
import type { BodyPose, FrameContext } from '@/core/contracts/render';
import { quat, v3, type Vec3 } from '@/core/math';
import { BODY_FLAG, MAX_BODIES, MAX_LIGHTS, SHINE_PER_RECEIVER, SHINE_RECEIVERS } from '../shaders/chunksFrame';
import type { Projection, ShineLight } from './math';

export const BODY_UNIFORM_FLOATS = 64;
export const OFFSET = {
  view: 0,
  proj: 16,
  projUnjittered: 32,
  viewProj: 48,
  viewProjUnjittered: 64,
  prevViewProj: 80,
  cameraRight: 96,
  cameraUp: 100,
  cameraForward: 104,
  prevEyeOffset: 108,
  renderSize: 112,
  displaySize: 116,
  jitter: 120,
  time: 124,
  exposure: 128,
  sunDir: 132,
  sunIlluminance: 136,
  misc: 140,
  counts: 144,
  cloudNear0: 148,
  cloudNear1: 152,
  cloudNear2: 156,
  cloudFar: 160,
  bodies: 164,
  shine: 164 + MAX_BODIES * BODY_UNIFORM_FLOATS,
  lights: 164 + MAX_BODIES * BODY_UNIFORM_FLOATS + SHINE_RECEIVERS * SHINE_PER_RECEIVER * 8,
} as const;
export const FRAME_UNIFORM_FLOATS = OFFSET.lights + MAX_LIGHTS * 12;

/** Near-field cloud shadow map placement, set by the cloud feature every frame (see setCloudShadowParams). */
export interface CloudShadowNear {
  /** Index into FrameContext.bodies of the body the clouds belong to. */
  bodyIndex: number;
  /** Centre of the orthographic map relative to the camera (ROOT axes, float64). */
  originRelCam: Vec3;
  /** Unit world directions of +u and +v of the map (ROOT axes); the map looks along the local vertical. */
  axisU: Vec3;
  axisV: Vec3;
  /** Half the width of the map, m. */
  halfExtent: number;
  /** Optical depth per unit stored in the map (transmittance = exp(-texel * opticalDepthScale / max(mu_s, 0.05))). */
  opticalDepthScale: number;
}

/** Far-field cloud shadow from the global coverage map ('clouds.coverageMap', equirect, row 0 = north, column 0 = lon -180). */
export interface CloudShadowFar {
  bodyIndex: number;
  /** Radius of the layer mid-height, m. */
  layerRadius: number;
  /** Vertical optical depth at coverage 1. */
  opticalDepth: number;
  /** Longitude advection of the coverage map, rad (added to the body-fixed longitude before sampling). */
  longitudeOffset: number;
}

export interface CloudShadowParams {
  near: CloudShadowNear | null;
  far: CloudShadowFar | null;
}

export interface FrameUniformExtras {
  projection: Projection;
  prevEyeOffset: Vec3;
  basis: { right: Vec3; up: Vec3; forward: Vec3 };
  renderScale: number;
  sunVisibility: number;
  noiseOffset: [number, number];
  cloudShadow: CloudShadowParams;
  /** Planetshine per receiver: index = frame body index, last = free space at the camera. */
  shine: ShineLight[][];
  defs: DefLibrary;
  near: number;
}

function put3(f: Float32Array, o: number, v: Vec3, w: number): void {
  f[o] = v.x;
  f[o + 1] = v.y;
  f[o + 2] = v.z;
  f[o + 3] = w;
}

/** Fill one BodyUniform. `atmoLayer` = index among the frame bodies that have an atmosphere, or -1. */
export function packBody(f: Float32Array, o: number, pose: BodyPose, def: BodyDef | undefined, atmoLayer: number, isStar: boolean): void {
  f.fill(0, o, o + BODY_UNIFORM_FLOATS);
  const radius = def?.radius ?? 0;
  const r = def?.render;
  const atm = r?.atmosphere ?? null;
  const dist = v3.len(pose.centerRelCam);
  put3(f, o, pose.centerRelCam, radius);
  put3(f, o + 4, pose.prevCenterRelCam, atm ? radius + atm.topAltitude : 0);
  put3(f, o + 8, dist > 0 ? v3.scale(pose.centerRelCam, -1 / dist) : { x: 0, y: 0, z: 1 }, dist);
  put3(f, o + 12, pose.sunDir, pose.cameraAltitude);
  let flags = 0;
  if (isStar) flags |= BODY_FLAG.star;
  if (atm) flags |= BODY_FLAG.atmosphere;
  if (def?.ocean) flags |= BODY_FLAG.ocean;
  if (r?.surface?.brdf === 'hapke') flags |= BODY_FLAG.hapke;
  if (def?.terrain) flags |= BODY_FLAG.terrain;
  put3(f, o + 16, quat.rotate(pose.qFixedToRoot, { x: 1, y: 0, z: 0 }), atm ? atmoLayer : -1);
  put3(f, o + 20, quat.rotate(pose.qFixedToRoot, { x: 0, y: 1, z: 0 }), def?.ocean ? radius + def.ocean.seaLevel : 0);
  put3(f, o + 24, quat.rotate(pose.qFixedToRoot, { x: 0, y: 0, z: 1 }), flags);
  if (r) {
    f.set([r.meanColor[0], r.meanColor[1], r.meanColor[2], r.geometricAlbedo], o + 28);
    const h = r.surface?.hapke ?? { b0: 1.8, hS: 0.065, bP: 0.25, cP: 0.3 };
    f.set([h.b0, h.hS, h.bP, h.cP], o + 32);
    const oc = r.ocean;
    f.set(oc ? [oc.absorption[0], oc.absorption[1], oc.absorption[2], oc.windSpeed] : [0.45, 0.06, 0.028, 7], o + 36);
    if (atm) {
      f.set([atm.rayleighScattering[0], atm.rayleighScattering[1], atm.rayleighScattering[2], atm.rayleighScaleHeight], o + 40);
      f.set([atm.mieScattering, atm.mieAbsorption, atm.mieScaleHeight, atm.miePhaseG], o + 44);
      f.set([atm.ozoneAbsorption[0], atm.ozoneAbsorption[1], atm.ozoneAbsorption[2], atm.ozoneCenterAltitude], o + 48);
    }
    const cl = r.clouds;
    f.set([atm?.ozoneHalfWidth ?? 0, atm?.groundAlbedo ?? 0, cl ? radius + cl.bottomAltitude : 0, cl ? radius + cl.topAltitude : 0], o + 52);
  }
}

export function packFrameUniforms(f: Float32Array, u: Uint32Array, frame: FrameContext, x: FrameUniformExtras): void {
  const p = x.projection;
  f.set(frame.view, OFFSET.view);
  f.set(p.proj, OFFSET.proj);
  f.set(p.projUnjittered, OFFSET.projUnjittered);
  // proj * view in float64, then narrowed.
  const mul = (a: Float64Array, b: Float64Array, o: number): void => {
    for (let c = 0; c < 4; c++) {
      for (let r = 0; r < 4; r++) {
        let s = 0;
        for (let k = 0; k < 4; k++) s += a[4 * k + r]! * b[4 * c + k]!;
        f[o + 4 * c + r] = s;
      }
    }
  };
  mul(p.proj, frame.view, OFFSET.viewProj);
  mul(p.projUnjittered, frame.view, OFFSET.viewProjUnjittered);
  f.set(frame.prevViewProj, OFFSET.prevViewProj);
  put3(f, OFFSET.cameraRight, x.basis.right, p.tanHalfFovX);
  put3(f, OFFSET.cameraUp, x.basis.up, p.tanHalfFovY);
  put3(f, OFFSET.cameraForward, x.basis.forward, x.near);
  put3(f, OFFSET.prevEyeOffset, x.prevEyeOffset, 0);
  const [rw, rh] = frame.renderSize;
  const [dw, dh] = frame.displaySize;
  f.set([rw, rh, 1 / rw, 1 / rh], OFFSET.renderSize);
  f.set([dw, dh, 1 / dw, 1 / dh], OFFSET.displaySize);
  f.set([frame.jitterPx[0], frame.jitterPx[1], p.jitterNdc[0], p.jitterNdc[1]], OFFSET.jitter);
  f.set([frame.realTime, frame.realDt, frame.frameIndex, frame.animate ? 1 : 0], OFFSET.time);
  f.set([frame.exposure, frame.ev100, frame.qualityScale, x.renderScale], OFFSET.exposure);
  put3(f, OFFSET.sunDir, frame.sun.dirRoot, frame.sun.angularRadius);
  const e = frame.sun.illuminance;
  f.set([frame.sun.color[0] * e, frame.sun.color[1] * e, frame.sun.color[2] * e, e], OFFSET.sunIlluminance);
  f.set([frame.camera.fillLight, x.sunVisibility, x.noiseOffset[0], x.noiseOffset[1]], OFFSET.misc);

  const bodyCount = Math.min(MAX_BODIES, frame.bodies.length);
  let starIndex = 0xffffffff;
  let atmoLayer = 0;
  for (let i = 0; i < bodyCount; i++) {
    const pose = frame.bodies[i]!;
    const def = x.defs.bodies[pose.id];
    const isStar = pose.id === frame.sun.bodyId;
    if (isStar) starIndex = i;
    packBody(f, OFFSET.bodies + i * BODY_UNIFORM_FLOATS, pose, def, atmoLayer, isStar);
    if (def?.render.atmosphere) atmoLayer++;
  }
  const lightCount = Math.min(MAX_LIGHTS, frame.lights.length);
  u[OFFSET.counts] = bodyCount;
  u[OFFSET.counts + 1] = lightCount;
  u[OFFSET.counts + 2] = frame.frameIndex >>> 0;
  u[OFFSET.counts + 3] = starIndex;

  const cn = x.cloudShadow.near;
  if (cn) {
    put3(f, OFFSET.cloudNear0, cn.originRelCam, cn.halfExtent);
    put3(f, OFFSET.cloudNear1, cn.axisU, cn.bodyIndex);
    put3(f, OFFSET.cloudNear2, cn.axisV, cn.opticalDepthScale);
  } else {
    f.fill(0, OFFSET.cloudNear0, OFFSET.cloudNear0 + 12);
  }
  const cf = x.cloudShadow.far;
  f.set(cf ? [cf.bodyIndex, cf.layerRadius, cf.opticalDepth, cf.longitudeOffset] : [-1, 0, 0, 0], OFFSET.cloudFar);

  f.fill(0, OFFSET.shine, OFFSET.lights);
  for (let r = 0; r < SHINE_RECEIVERS; r++) {
    const list = x.shine[r] ?? [];
    for (let k = 0; k < Math.min(SHINE_PER_RECEIVER, list.length); k++) {
      const o = OFFSET.shine + (r * SHINE_PER_RECEIVER + k) * 8;
      put3(f, o, list[k]!.dir, 0);
      f.set(list[k]!.illuminance, o + 4);
    }
  }
  for (let i = 0; i < lightCount; i++) {
    const l = frame.lights[i]!;
    const o = OFFSET.lights + i * 12;
    put3(f, o, l.posRelCam, l.range);
    put3(f, o + 4, l.endRelCam ?? l.posRelCam, l.kind === 'capsule' ? 1 : 0);
    f.set([l.intensity[0], l.intensity[1], l.intensity[2], 0], o + 8);
  }
}
