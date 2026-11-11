/**
 * CPU mirror of the WGSL `OceanUniforms` block (shaders/waves.ts): float64 inputs, float32 payload. Every
 * planet-scale quantity is reduced here (phases modulo 2 pi, cascade origins modulo the patch length,
 * positions relative to the camera) so the shaders only ever add small numbers.
 */
import { MAX_RIPPLES, MAX_VESSELS, OCEAN_UNIFORM_VEC4 } from './shaders/waves';
import { MAX_SWELL, type PreparedSwell } from './swell';
import { CASCADE_COUNT, CASCADE_MIPS, type CascadeSpectrum } from './spectrum';
import type { Vec3 } from '@/core/math';

export interface OceanVesselZone {
  /** Plane offset from the reference point, m. */
  x: number;
  y: number;
  /** Radius of complete damping and the radius where the chop is back to full strength, m. */
  hullRadius: number;
  dampRadius: number;
  strength: number;
  wobble: number;
}

export interface OceanRippleSource {
  x: number;
  y: number;
  age: number;
  amplitude: number;
}

export interface OceanFrameData {
  cHat: Vec3;
  seaRadius: number;
  e: Vec3;
  f: Vec3;
  /** 1 / (R |q_c|). */
  invQR: number;
  cameraHeight: number;
  /** Body-fixed -> ROOT rotation columns, this and the previous frame (9 numbers each, column-major). */
  rot: number[];
  prevRot: number[];
  refRel: Vec3;
  refRelPrev: Vec3;
  prevValid: boolean;
  bodyIndex: number;
  fadeStart: number;
  fadeEnd: number;
  detailRadius: number;
  bandLift: number;
  windSpeed: number;
  coxMunk: number;
  subVariance: number;
  choppiness: number;
  tau: number;
  tauPrev: number;
  repeatPeriod: number;
  dt: number;
  foamDecay: number;
  foamThreshold: number;
  foamGain: number;
  foamAlbedo: number;
  shoreFoamDepth: number;
  refractionDistortion: number;
  chromaticOffset: number;
  whitecaps: number;
  swell: PreparedSwell;
  swellPrevPhase: Float32Array;
  /** Reference point / L modulo 1, per cascade. */
  cascadeOrigin: [number, number][];
  cascades: readonly CascadeSpectrum[];
  cascadeResidual: readonly number[];
  vessels: readonly OceanVesselZone[];
  ripples: readonly OceanRippleSource[];
  ripple: { k: number; lifetime: number; groupSpeed: number; omega: number };
  wake: { x: number; y: number; extent: number; valid: boolean };
  seaLevel: number;
  waveBound: number;
  /** FFT chop scale (1 = data; a debug hook for the swell-agreement views). */
  chopScale: number;
  /** Largest value written to the TAA reactive mask (0 = none). */
  taaReactive: number;
  /** Debug view: 0 = normal shading; see OCEAN_DEBUG_VIEWS. */
  debugView: number;

  /** Capillary detail layers: compression, rotation (rad), slope amplitude, origin (texture coordinates mod 1). */
  detail: { scale: number; angle: number; amplitude: number; origin: [number, number] }[];
}

/** Write OceanUniforms into `f` (Float32Array of OCEAN_UNIFORM_VEC4 * 4) / `u` (Uint32Array view of the same buffer). */
export function packOceanUniforms(d: OceanFrameData, f: Float32Array, u: Uint32Array): void {
  f.fill(0);
  let o = 0;
  const v4 = (a: number, b: number, c: number, w: number): void => {
    f[o] = a;
    f[o + 1] = b;
    f[o + 2] = c;
    f[o + 3] = w;
    o += 4;
  };
  v4(d.cHat.x, d.cHat.y, d.cHat.z, d.seaRadius);
  v4(d.e.x, d.e.y, d.e.z, d.invQR);
  v4(d.f.x, d.f.y, d.f.z, d.cameraHeight);
  for (let c = 0; c < 3; c++) v4(d.rot[c * 3]!, d.rot[c * 3 + 1]!, d.rot[c * 3 + 2]!, 0);
  for (let c = 0; c < 3; c++) v4(d.prevRot[c * 3]!, d.prevRot[c * 3 + 1]!, d.prevRot[c * 3 + 2]!, 0);
  v4(d.refRel.x, d.refRel.y, d.refRel.z, d.bodyIndex);
  v4(d.refRelPrev.x, d.refRelPrev.y, d.refRelPrev.z, d.prevValid ? 1 : 0);
  v4(d.fadeStart, d.fadeEnd, d.detailRadius, d.bandLift);
  v4(d.windSpeed, d.coxMunk, d.subVariance, d.choppiness);
  v4(d.tau, d.tauPrev, d.repeatPeriod, d.dt);
  v4(d.foamDecay, d.foamThreshold, d.foamGain, d.foamAlbedo);
  v4(d.shoreFoamDepth, d.refractionDistortion, d.chromaticOffset, d.whitecaps);
  u[o] = d.swell.count;
  u[o + 1] = Math.min(d.vessels.length, MAX_VESSELS);
  u[o + 2] = Math.min(d.ripples.length, MAX_RIPPLES);
  u[o + 3] = (d.wake.valid ? 1 : 0) | ((d.debugView & 15) << 8);
  o += 4;
  v4(d.wake.x, d.wake.y, d.wake.extent, 1 / d.wake.extent);
  for (let i = 0; i < MAX_SWELL; i++) v4(d.swell.dirK[i * 4]!, d.swell.dirK[i * 4 + 1]!, d.swell.dirK[i * 4 + 2]!, d.swell.dirK[i * 4 + 3]!);
  for (let i = 0; i < MAX_SWELL; i++) v4(d.swell.ampPhase[i * 4]!, d.swell.ampPhase[i * 4 + 1]!, d.swell.ampPhase[i * 4 + 2]!, d.swellPrevPhase[i]!);
  for (let c = 0; c < CASCADE_COUNT; c++) {
    const cs = d.cascades[c]!;
    const L = cs.band.length;
    v4(L, 1 / L, d.cascadeOrigin[c]![0], d.cascadeOrigin[c]![1]);
    const ff = cs.filteredSlopeFraction;
    v4(ff[0]!, ff[1]!, ff[2]!, ff[3]!);
    v4(ff[4]!, ff[5]!, ff[6]!, ff[7]!);
    if (CASCADE_MIPS < 9) throw new Error('ocean: filtered-variance table expects 9 mips');
    v4(cs.slopeVariance, Math.sqrt(cs.heightVariance), cs.meanOmega, d.cascadeResidual[c]!);
  }
  for (let i = 0; i < MAX_VESSELS; i++) {
    const z = d.vessels[i];
    if (z) {
      v4(z.x, z.y, z.hullRadius, z.dampRadius);
      v4(z.strength, z.wobble, 0, 0);
    } else {
      v4(0, 0, 0, 0);
      v4(0, 0, 0, 0);
    }
  }
  for (let i = 0; i < MAX_RIPPLES; i++) {
    const r = d.ripples[i];
    if (r) v4(r.x, r.y, r.age, r.amplitude);
    else v4(0, 0, 0, 0);
  }
  v4(d.ripple.k, d.ripple.lifetime, d.ripple.groupSpeed, d.ripple.omega);
  v4(d.seaLevel, d.waveBound, d.chopScale, d.taaReactive);
  for (let k = 0; k < 2; k++) {
    const l = d.detail[k]!;
    v4(l.scale, Math.cos(l.angle), Math.sin(l.angle), l.amplitude);
  }
  v4(d.detail[0]!.origin[0], d.detail[0]!.origin[1], d.detail[1]!.origin[0], d.detail[1]!.origin[1]);

  if (o !== OCEAN_UNIFORM_VEC4 * 4) throw new Error(`ocean: uniform packing wrote ${o / 4} vec4, expected ${OCEAN_UNIFORM_VEC4}`);
}
