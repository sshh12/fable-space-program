/**
 * Physical atmosphere models (docs/research/sim-design.md 8.1): 'ussa76', 'table', 'exponential'.
 *
 * Every model fades density AND pressure smoothly to zero between simTop - 10 km and simTop
 * (factor 1 - smoothstep), so drag is exactly zero at the rails boundary; at and above simTop the sample
 * is VACUUM. Temperature and speed of sound are not faded below simTop.
 *
 * 'ussa76' below 86 km geometric altitude: geopotential H = r0 h / (r0 + h), r0 = 6 356 766 m, the seven
 * layers of the standard (base H, base T, lapse, base p as tabulated in sim-design 8.1),
 * T = Tb + L (H - Hb), p = pb (Tb/T)^(g0 M/(R L)) or pb exp(-g0 M (H - Hb)/(R Tb)) for L = 0,
 * rho = p M/(R T), M = 0.0289644, R = 8.314462, g0 = 9.80665; a = sqrt(gamma R_specific T).
 * 86 km and above: log-linear interpolation of rho and p and linear T in the USSA-76 table rows of
 * sim-design 8.1 (extrapolated log-linearly beyond 200 km); a = 275 m/s there (free-molecular regime,
 * Mach only selects the drag plateau).
 *
 * 'table': rows {hKm, rho, p, T}, log-linear rho and p, linear T, extrapolated with the end segments.
 * 'exponential': rho = rho0 exp(-h/H), p = p0 exp(-h/H) (or rho R T when p0 is absent), T = temperature
 * (or p0/(rho0 R) when absent).
 */
import type { AtmosphereDef, BodyDef } from '../../core/contracts/defs';
import { VACUUM, type AtmosphereSample } from '../../core/contracts/simInternal';
import { smoothstep } from '../../core/math/scalar';

export const USSA76_R0 = 6356766;
const G0 = 9.80665;
const M_AIR = 0.0289644;
const R_GAS = 8.314462;
const GMR = (G0 * M_AIR) / R_GAS;
/** Speed of sound used above 86 km, m/s. */
export const USSA76_UPPER_SPEED_OF_SOUND = 275;
/** Width of the density fade below simTop, m. */
export const ATMOSPHERE_FADE_WIDTH = 10000;

/** [H base m, T base K, lapse K/m, p base Pa] */
const USSA76_LAYERS: readonly (readonly [number, number, number, number])[] = [
  [0, 288.15, -0.0065, 101325],
  [11000, 216.65, 0, 22632.06],
  [20000, 216.65, 0.001, 5474.889],
  [32000, 228.65, 0.0028, 868.0187],
  [47000, 270.65, 0, 110.9063],
  [51000, 270.65, -0.0028, 66.93887],
  [71000, 214.65, -0.002, 3.95642],
  [84852, 186.946, 0, 0.3733836],
];

/** [h km, rho, p, T] from 86 km up. */
const USSA76_UPPER: readonly (readonly [number, number, number, number])[] = [
  [86, 6.958e-6, 3.734e-1, 186.87],
  [90, 3.416e-6, 1.836e-1, 186.87],
  [100, 5.604e-7, 3.201e-2, 195.08],
  [110, 9.708e-8, 7.104e-3, 240.0],
  [120, 2.222e-8, 2.538e-3, 360.0],
  [130, 8.152e-9, 1.251e-3, 469.27],
  [140, 3.831e-9, 7.203e-4, 559.63],
  [150, 2.076e-9, 4.542e-4, 634.39],
  [160, 1.233e-9, 3.04e-4, 696.29],
  [180, 5.194e-10, 1.527e-4, 790.07],
  [200, 2.541e-10, 8.474e-5, 854.56],
];

/** Un-faded state of an atmosphere model at an altitude. */
interface RawSample {
  rho: number;
  p: number;
  T: number;
  a: number;
}

interface Model {
  raw(h: number): RawSample;
  simTop: number;
}

/** Log-linear table interpolation (rows sorted by altitude in metres), extrapolating the end segments. */
function tableModel(rows: readonly { h: number; rho: number; p: number; T: number }[], gamma: number, gasConstant: number, fixedA: number | null): (h: number) => RawSample {
  const n = rows.length;
  if (n < 2) throw new Error('atmosphere table needs at least two rows');
  for (let i = 1; i < n; i++) {
    if (!(rows[i]!.h > rows[i - 1]!.h)) throw new Error('atmosphere table altitudes must increase strictly');
  }
  for (const r of rows) {
    if (!(r.rho > 0) || !(r.p > 0) || !(r.T > 0)) throw new Error('atmosphere table values must be positive');
  }
  const lnRho = rows.map((r) => Math.log(r.rho));
  const lnP = rows.map((r) => Math.log(r.p));
  return (h: number): RawSample => {
    let i = 0;
    if (h >= rows[n - 1]!.h) i = n - 2;
    else if (h > rows[0]!.h) {
      let lo = 0;
      let hi = n - 1;
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (rows[mid]!.h <= h) lo = mid;
        else hi = mid;
      }
      i = lo;
    }
    const a = rows[i]!;
    const b = rows[i + 1]!;
    const t = (h - a.h) / (b.h - a.h);
    const rho = Math.exp(lnRho[i]! + (lnRho[i + 1]! - lnRho[i]!) * t);
    const p = Math.exp(lnP[i]! + (lnP[i + 1]! - lnP[i]!) * t);
    const T = Math.max(1, a.T + (b.T - a.T) * t);
    return { rho, p, T, a: fixedA ?? Math.sqrt(gamma * gasConstant * T) };
  };
}

function ussa76Model(def: AtmosphereDef): (h: number) => RawSample {
  const upper = tableModel(
    USSA76_UPPER.map(([hKm, rho, p, T]) => ({ h: hKm * 1000, rho, p, T })),
    def.gamma,
    def.gasConstant,
    USSA76_UPPER_SPEED_OF_SOUND,
  );
  return (h: number): RawSample => {
    if (h >= 86000) return upper(h);
    const H = (USSA76_R0 * h) / (USSA76_R0 + h);
    let k = 0;
    for (let i = USSA76_LAYERS.length - 1; i > 0; i--) {
      if (H >= USSA76_LAYERS[i]![0]) {
        k = i;
        break;
      }
    }
    const [Hb, Tb, L, pb] = USSA76_LAYERS[k]!;
    const T = Tb + L * (H - Hb);
    const p = L === 0 ? pb * Math.exp((-GMR * (H - Hb)) / Tb) : pb * Math.pow(Tb / T, GMR / L);
    const rho = (p * M_AIR) / (R_GAS * T);
    return { rho, p, T, a: Math.sqrt(def.gamma * def.gasConstant * T) };
  };
}

function exponentialModel(def: AtmosphereDef, file: string): (h: number) => RawSample {
  const { rho0, p0, scaleHeight, temperature } = def;
  if (!(rho0 !== undefined && rho0 > 0)) throw new Error(`${file}: exponential atmosphere needs rho0 > 0`);
  if (!(scaleHeight !== undefined && scaleHeight > 0)) throw new Error(`${file}: exponential atmosphere needs scaleHeight > 0`);
  let T: number;
  if (temperature !== undefined) T = temperature;
  else if (p0 !== undefined) T = p0 / (rho0 * def.gasConstant);
  else throw new Error(`${file}: exponential atmosphere needs p0 or temperature`);
  if (!(T > 0)) throw new Error(`${file}: exponential atmosphere temperature must be positive`);
  const pRef = p0 ?? rho0 * def.gasConstant * T;
  const a = Math.sqrt(def.gamma * def.gasConstant * T);
  return (h: number): RawSample => {
    const f = Math.exp(-h / scaleHeight);
    return { rho: rho0 * f, p: pRef * f, T, a };
  };
}

const MODELS = new WeakMap<AtmosphereDef, Model>();

function modelFor(def: AtmosphereDef, bodyId: string): Model {
  let m = MODELS.get(def);
  if (m) return m;
  const file = `bodies/${bodyId}.json atmosphere`;
  if (!(def.simTop > ATMOSPHERE_FADE_WIDTH)) throw new Error(`${file}: simTop must exceed ${ATMOSPHERE_FADE_WIDTH} m`);
  if (!(def.gamma > 1) || !(def.gasConstant > 0)) throw new Error(`${file}: gamma > 1 and gasConstant > 0 required`);
  let raw: (h: number) => RawSample;
  switch (def.model) {
    case 'ussa76':
      raw = ussa76Model(def);
      break;
    case 'table':
      if (!def.table) throw new Error(`${file}: model 'table' needs "table" rows`);
      raw = tableModel(
        def.table.map((r) => ({ h: r.hKm * 1000, rho: r.rho, p: r.p, T: r.T })),
        def.gamma,
        def.gasConstant,
        null,
      );
      break;
    case 'exponential':
      raw = exponentialModel(def, file);
      break;
    default:
      throw new Error(`${file}: unknown atmosphere model "${String((def as { model: unknown }).model)}"`);
  }
  m = { raw, simTop: def.simTop };
  MODELS.set(def, m);
  return m;
}

/** Atmosphere state at `altitude` (m above the reference radius) of a body; VACUUM when it has none or above simTop. */
export function atmosphereAt(body: BodyDef, altitude: number): AtmosphereSample {
  const def = body.atmosphere;
  if (!def) return VACUUM;
  const m = modelFor(def, body.id);
  if (altitude >= m.simTop) return VACUUM;
  const s = m.raw(altitude);
  const fade = 1 - smoothstep(m.simTop - ATMOSPHERE_FADE_WIDTH, m.simTop, altitude);
  return { density: s.rho * fade, pressure: s.p * fade, temperature: s.T, speedOfSound: s.a };
}

/** Un-faded model values (diagnostics and tests): the model exactly as defined, ignoring simTop. */
export function atmosphereModelRaw(body: BodyDef, altitude: number): AtmosphereSample {
  const def = body.atmosphere;
  if (!def) return VACUUM;
  const s = modelFor(def, body.id).raw(altitude);
  return { density: s.rho, pressure: s.p, temperature: s.T, speedOfSound: s.a };
}

/** Bound accessor `(altitude) => sample` for VesselEnvironment.atmosphereAt. */
export function atmosphereFunction(body: BodyDef): (altitude: number) => AtmosphereSample {
  if (!body.atmosphere) return () => VACUUM;
  modelFor(body.atmosphere, body.id);
  return (altitude) => atmosphereAt(body, altitude);
}
