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

export interface Retarded {
  /** Propagation delay of the sound arriving now, s (maxDelay where it cannot arrive). */
  delay: number;
  /** 0..1: 1 = the sound reaches the listener, 0 = it cannot (outside the Mach cone, beyond the delay line). */
  reach: number;
}

/**
 * Exact retarded time of sound that arrives at the listener now from a source moving with constant
 * velocity `airVelocity` RELATIVE TO THE AIR (both vectors in one frame, m and m/s). With D the current
 * listener-minus-source vector, the sound left the source when it was at -V tau, so |D + V tau| = c tau:
 *   tau = D^2 / (sqrt((D.V)^2 + D^2 (c^2 - V^2)) - D.V)   (the stable form of the smaller root).
 * The listener's own motion does not enter (it is where it is now), so a static source gives d / c and a
 * listener co-moving with the source gets a constant delay (no Doppler), however fast the airflow.
 * Supersonic sources reach only listeners inside their Mach cone behind them; a listener ahead of the
 * nozzles of a vessel flying faster than sound hears nothing through the air. `reach` fades to 0 at the
 * cone (disc / (D^2 c^2) below coneEdge) and over the last 10 % of the delay line. Driving a delay line
 * with tau gives the Doppler shift; its playback rate 1 - dtau/dt stays positive.
 */
export function retardedDelay(D: { x: number; y: number; z: number }, airVelocity: { x: number; y: number; z: number }, c: number, maxDelay: number, coneEdge: number): Retarded {
  const d2 = D.x * D.x + D.y * D.y + D.z * D.z;
  if (d2 < 1e-12) return { delay: 0, reach: 1 };
  const dv = D.x * airVelocity.x + D.y * airVelocity.y + D.z * airVelocity.z;
  const v2 = airVelocity.x * airVelocity.x + airVelocity.y * airVelocity.y + airVelocity.z * airVelocity.z;
  const disc = dv * dv + d2 * (c * c - v2);
  if (!(disc > 0)) return { delay: maxDelay, reach: 0 };
  const den = Math.sqrt(disc) - dv;
  if (!(den > 0)) return { delay: maxDelay, reach: 0 };
  const tau = d2 / den;
  if (tau >= maxDelay) return { delay: maxDelay, reach: 0 };
  const cone = coneEdge > 0 ? saturate(disc / (d2 * c * c) / coneEdge) : 1;
  const line = saturate((maxDelay - tau) / (0.1 * maxDelay));
  const s = (x: number): number => x * x * (3 - 2 * x);
  return { delay: tau, reach: s(cone) * s(line) };
}

/**
 * Local speed of sound for a vessel's airborne sources: from its own Mach number and air-relative speed
 * when it is moving (so "Mach 1" here is the sim's Mach 1), else the configured reference.
 */
export function localSoundSpeed(mach: number, airSpeed: number, prop: Propagation): number {
  return mach > 0.05 && airSpeed > 1 ? airSpeed / mach : prop.speedOfSound;
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
 * ~ thrust at full throttle) + thrust response (10 throttleExponent dB per decade of thrust per engine)
 * + throttle-range response (-throttleRangeDb (1 - lever): what the player's lever does to an engine whose
 * thrust can only go down to minThrottle) + power sum of the n running engines. -Infinity when nothing
 * produces thrust.
 */
export function engineLevelDb(thrustPerEngine: number, running: number, lever: number, profile: EngineProfile, engines: EnginesConfig): number {
  if (!(thrustPerEngine > 0) || running <= 0) return -Infinity;
  return (
    engines.level.levelDb +
    profile.efficiencyDb +
    10 * Math.log10(profile.refThrust / engines.level.refThrust) +
    10 * profile.throttleExponent * Math.log10(thrustPerEngine / profile.refThrust) -
    profile.throttleRangeDb * (1 - saturate(lever)) +
    10 * Math.log10(running)
  );
}

/**
 * Where an engine's actual throttle sits in its throttle range, 0..1 (the lever that commands it, by the
 * sim's law throttleActual = minThrottle + (1 - minThrottle) lever); 1 for engines without a range
 * (solids, fixed burns) and 0 while spooling below minThrottle.
 */
export function throttleLever(throttleActual: number, minThrottle: number, throttleable: boolean): number {
  if (!throttleable || minThrottle >= 1) return throttleActual > 0 ? 1 : 0;
  return saturate((throttleActual - minThrottle) / (1 - minThrottle));
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

/** Surface ambience share from the height above the surface: 1 up to `full` m, smoothly 0 at `none` m. */
export function surfaceFactor(altitude: number, full: number, none: number): number {
  if (altitude <= full) return 1;
  if (altitude >= none) return 0;
  const t = (altitude - full) / (none - full);
  return 1 - t * t * (3 - 2 * t);
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

/**
 * The automatic makeup gain a DynamicsCompressorNode applies (Web Audio spec / the Blink, WebKit and Gecko
 * DynamicsCompressorKernel): with the node's static curve y(x) - linear below the threshold, an
 * exponential knee of width `knee` dB whose curvature k is found by bisection so its slope reaches
 * 1 / ratio at threshold + knee, then a constant ratio - the node multiplies its output by
 * (1 / y(1))^0.6. Returned in dB, so the graph can cancel it exactly and the master's small-signal gain is
 * what mix.json says.
 */
export function compressorMakeupDb(thresholdDb: number, kneeDb: number, ratio: number): number {
  const toDb = (x: number): number => 20 * Math.log10(x);
  const fromDb = (d: number): number => 10 ** (d / 20);
  const linearThreshold = fromDb(thresholdDb);
  const kneeCurve = (x: number, k: number): number => (x < linearThreshold ? x : linearThreshold + (1 - Math.exp(-k * (x - linearThreshold))) / k);
  const slopeAt = (x: number, k: number): number => {
    if (x < linearThreshold) return 1;
    const x2 = x * 1.001;
    return (toDb(kneeCurve(x2, k)) - toDb(kneeCurve(x, k))) / (toDb(x2) - toDb(x));
  };
  const kneeThresholdDb = thresholdDb + kneeDb;
  const kneeThreshold = fromDb(kneeThresholdDb);
  let minK = 0.1;
  let maxK = 10000;
  let k = 5;
  for (let i = 0; i < 15; i++) {
    if (slopeAt(kneeThreshold, k) < 1 / ratio) maxK = k;
    else minK = k;
    k = Math.sqrt(minK * maxK);
  }
  const yKneeDb = toDb(kneeCurve(kneeThreshold, k));
  // y(1): 0 dBFS lies above the knee for any threshold + knee < 0.
  const y1 = kneeThreshold >= 1 ? kneeCurve(1, k) : fromDb(yKneeDb + (0 - kneeThresholdDb) / ratio);
  return 0.6 * -toDb(y1);
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
