/**
 * Pure mapping functions of the sound model: physics quantities -> gains, cutoffs and delays. No Web Audio
 * here; everything is unit-tested in vitest (tests/unit/audio/mapping.test.ts).
 */
import type { EngineProfile, EnginesConfig, MixConfig } from './config';

type Propagation = MixConfig['propagation'];

export const dbToGain = (db: number): number => (db === -Infinity ? 0 : 10 ** (db / 20));
export const gainToDb = (g: number): number => (g > 0 ? 20 * Math.log10(g) : -Infinity);
const saturate = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/**
 * Airborne gain factor from the ambient pressure at the listener: (p / pRef)^e, capped at 1, and EXACTLY 0
 * for p <= 0 (no medium: airborne sound cannot reach the listener).
 */
export function pressureGain(pressure: number, prop: Propagation): number {
  if (!(pressure > 0)) return 0;
  return Math.min(1, (pressure / prop.referencePressure) ** prop.pressureGainExponent);
}

/** Low-pass cutoff of the airborne path from the ambient pressure: thin air carries highs worse. */
export function pressureCutoff(pressure: number, prop: Propagation): number {
  const [lo, hi] = prop.pressureCutoffHz;
  const x = pressure > 0 ? Math.min(1, pressure / prop.referencePressure) : 0;
  return lo + (hi - lo) * x ** prop.pressureCutoffExponent;
}

/** Air absorption as a low-pass cutoff falling with distance (refCutoffHz at refDistance). */
export function absorptionCutoff(distance: number, prop: Propagation): number {
  const a = prop.absorption;
  if (distance <= 0) return a.maxCutoffHz;
  return Math.min(a.maxCutoffHz, a.refCutoffHz * (a.refDistance / distance) ** a.exponent);
}

/** Two low-pass mechanisms in series, combined smoothly: 1/fc^2 = 1/a^2 + 1/b^2. */
export function combineCutoffs(...cutoffs: number[]): number {
  let s = 0;
  for (const c of cutoffs) s += 1 / (c * c);
  return 1 / Math.sqrt(s);
}

/**
 * Spherical spreading of an extended source: unity inside its near-field radius `refDistance`, then
 * (refDistance / d)^distanceExponent (inverse distance = 6 dB per doubling), faded to exactly 0 between
 * airborneFadeStart and airborneFadeEnd (beyond the propagation delay line).
 */
export function distanceGain(distance: number, refDistance: number, prop: Propagation): number {
  const d = Math.max(distance, refDistance);
  const spread = (refDistance / d) ** prop.distanceExponent;
  if (distance >= prop.airborneFadeEnd) return 0;
  if (distance <= prop.airborneFadeStart) return spread;
  return spread * (1 - (distance - prop.airborneFadeStart) / (prop.airborneFadeEnd - prop.airborneFadeStart));
}

/**
 * Propagation delay of sound arriving now from a source at distance d that recedes at `recessionSpeed`
 * (m/s, negative when approaching): the retarded time solves tau = d(t - tau) / c, i.e.
 * tau = d / (c + v) to first order. Driving a delay line with it yields the Doppler shift; the playback
 * rate 1 - dtau/dt = c / (c + v) stays positive for any recession speed, also supersonic.
 */
export function propagationDelay(distance: number, recessionSpeed: number, prop: Propagation): number {
  const c = prop.speedOfSound;
  const v = Math.max(recessionSpeed, -0.5 * c);
  return Math.min(prop.maxDelay, Math.max(0, distance) / (c + v));
}

/** Attenuation of structure-borne sound along the vessel, dB (<= 0). */
export function structureDb(distance: number, prop: Propagation): number {
  return Math.max(prop.structure.minDb, -prop.structure.dbPerMetre * Math.max(0, distance));
}

/** Share of the faint structure-borne path an external camera near the vessel receives (0..1). */
export function attachFactor(distanceToVessel: number, prop: Propagation): number {
  const a = prop.attach;
  if (distanceToVessel <= a.fullDistance) return 1;
  if (distanceToVessel >= a.maxDistance) return 0;
  const t = (distanceToVessel - a.fullDistance) / (a.maxDistance - a.fullDistance);
  return 1 - t * t * (3 - 2 * t);
}

/**
 * Level of an engine cluster, dB: global reference + profile efficiency + engine size (acoustic power
 * ~ thrust at full throttle) + throttle response (10 throttleExponent dB per decade of thrust per engine)
 * + power sum of the n running engines. -Infinity when nothing produces thrust.
 */
export function engineLevelDb(thrustPerEngine: number, running: number, profile: EngineProfile, engines: EnginesConfig): number {
  if (!(thrustPerEngine > 0) || running <= 0) return -Infinity;
  return (
    engines.level.levelDb +
    profile.efficiencyDb +
    10 * Math.log10(profile.refThrust / engines.level.refThrust) +
    10 * profile.throttleExponent * Math.log10(thrustPerEngine / profile.refThrust) +
    10 * Math.log10(running)
  );
}

/** Crackle exists only where there is air at the nozzle: (p / pRef)^e, exactly 0 in vacuum. */
export function crackleFactor(nozzlePressure: number, exponent: number, prop: Propagation): number {
  if (!(nozzlePressure > 0)) return 0;
  return Math.min(1, nozzlePressure / prop.referencePressure) ** exponent;
}

/** Wind level from dynamic pressure, dB re qRef (pressure fluctuations scale with q), capped at maxDb. */
export function windDb(q: number, qRef: number, maxDb: number): number {
  if (!(q > 0)) return -Infinity;
  return Math.min(maxDb, 20 * Math.log10(q / qRef));
}

/** Transonic buffet weight: a Gaussian bump in Mach. */
export function buffetWeight(mach: number, center: number, width: number): number {
  const x = (mach - center) / width;
  return Math.exp(-0.5 * x * x);
}

/** Plasma-driven reentry amplitude, plasmaIntensity^exponent (0..1). */
export function plasmaAmplitude(plasma: number, exponent: number): number {
  return saturate(plasma) ** exponent;
}

/** Continuous sounds fade out above physics warp. */
export function continuousAudible(warpFactor: number, threshold: number): boolean {
  return warpFactor <= threshold;
}

/** Creak rate (Poisson events per second) from g-load, its rate of change and sunlight changes. */
export function creakRate(gLoad: number, dgdt: number, dSunDt: number, c: { gMin: number; gMax: number; maxRate: number; jerkRate: number; thermalRate: number }): number {
  const g = saturate((gLoad - c.gMin) / (c.gMax - c.gMin));
  return c.maxRate * g ** 1.5 + c.jerkRate * Math.abs(dgdt) + c.thermalRate * Math.abs(dSunDt);
}

/** Level offset of a scaled event, dB: 20 exponent log10(value / ref), clamped. */
export function eventScaleDb(value: number, s: { ref: number; exponent: number; minDb: number; maxDb: number }): number {
  if (!(value > 0)) return s.minDb;
  return Math.min(s.maxDb, Math.max(s.minDb, 20 * s.exponent * Math.log10(value / s.ref)));
}

/** Deterministic 32-bit string hash (FNV-1a) for seeds and variant choice. */
export function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}
