/**
 * Aerothermal model (sim-design 10.1): Sutton-Graves convective + Tauber-Sutton radiative stagnation
 * flux, per-part exposure, wake shielding, radiative cooling, ablative heat shields, overheating.
 */
import type { AtmosphereHeatingDef } from '@/core/contracts/defs';
import type { VesselEnvironment } from '@/core/contracts/simInternal';
import { smoothstep } from '@/core/math/scalar';
import type { Structure } from '../vessel/structure';
import type { Vessel } from '../vessel/types';

export const STEFAN_BOLTZMANN = 5.670374419e-8;
/** Surface temperature ceiling of a charring ablator, K. */
export const ABLATION_TEMP = 3100;
/** Exposure multiplier inside the wake of an upstream body. */
export const WAKE_FACTOR = 0.03;
const WAKE_COS = Math.cos((30 * Math.PI) / 180);
/** Wake shadowing is re-evaluated every this many steps (the flow direction changes slowly). */
const WAKE_REFRESH_STEPS = 8;
/** Density at which the radiative environment is half atmosphere, half space (about 80 km on Earth). */
const ENV_BLEND_DENSITY = 1.8e-5;

/** Convective stagnation-point flux, W/m^2. */
export function convectiveFlux(h: AtmosphereHeatingDef, rho: number, speed: number, noseRadius: number): number {
  if (!(rho > 0) || !(noseRadius > 0)) return 0;
  return h.kConv * Math.sqrt(rho / noseRadius) * speed * speed * speed;
}

function fTable(table: [number, number][], v: number): number {
  const n = table.length;
  if (n === 0) return 0;
  if (v <= table[0]![0]) return table[0]![1];
  if (v >= table[n - 1]![0]) return table[n - 1]![1];
  for (let i = 1; i < n; i++) {
    const b = table[i]!;
    if (v <= b[0]) {
      const a = table[i - 1]!;
      return a[1] + ((b[1] - a[1]) * (v - a[0])) / (b[0] - a[0]);
    }
  }
  return table[n - 1]![1];
}

/** Radiative stagnation-point flux, W/m^2 (zero below vMin or when the body has no radiative model). */
export function radiativeFlux(h: AtmosphereHeatingDef, rho: number, speed: number, noseRadius: number): number {
  const r = h.radiative;
  if (!r || !(rho > 0) || speed < r.vMin || !(noseRadius > 0)) return 0;
  const a = Math.min(r.aMax, r.aCoef * Math.pow(speed, r.aVExp) * Math.pow(rho, r.aRhoExp));
  return r.kRad * r.c * Math.pow(noseRadius, a) * Math.pow(rho, r.rhoExp) * fTable(r.fTable, speed);
}

export function stagnationFlux(h: AtmosphereHeatingDef, rho: number, speed: number, noseRadius: number): number {
  return convectiveFlux(h, rho, speed, noseRadius) + radiativeFlux(h, rho, speed, noseRadius);
}

/** Radiative environment temperature: deep space (warmer in sunlight) blended to the air temperature. */
export function environmentTemperature(env: VesselEnvironment, rho: number, airTemp: number): number {
  const space = 4 + 250 * env.sunVisibility;
  const w = rho / (rho + ENV_BLEND_DENSITY);
  return space + (airTemp - space) * w;
}

function refreshWake(st: Structure, vessel: Vessel, hx: number, hy: number, hz: number): void {
  const th = st.thermal;
  const wake = st.carried.wake;
  const parts = vessel.parts;
  for (let i = 0; i < th.length; i++) {
    const p = th[i]!;
    wake[i] = 1;
    if (parts[p.part]!.shielded) continue;
    for (let j = 0; j < th.length; j++) {
      if (j === i) continue;
      const q = th[j]!;
      if (q.radius < 0.99 * p.radius || parts[q.part]!.shielded) continue;
      // q is upstream of p when the vector q -> p points against the direction of travel.
      const dx = p.cx - q.cx;
      const dy = p.cy - q.cy;
      const dz = p.cz - q.cz;
      const along = -(dx * hx + dy * hy + dz * hz);
      if (along <= 0) continue;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (along * along >= WAKE_COS * WAKE_COS * d2) {
        wake[i] = WAKE_FACTOR;
        break;
      }
    }
  }
}

/**
 * One thermal step. (hx, hy, hz) is the unit direction of travel through the air in VES.
 * Appends the indices of overheated parts to `overheated` and updates vessel.aero.heatFlux / plasmaIntensity.
 */
export function stepThermal(
  vessel: Vessel,
  st: Structure,
  env: VesselEnvironment,
  rho: number,
  speed: number,
  hx: number,
  hy: number,
  hz: number,
  airTemp: number,
  dt: number,
  overheated: number[],
): void {
  const heating = env.heating;
  const parts = vessel.parts;
  const th = st.thermal;
  const base = heating && rho > 0 ? heating.kConv * Math.sqrt(rho) * speed * speed * speed : 0;
  const radiating = heating !== null && heating.radiative !== null && rho > 0 && speed >= heating.radiative.vMin;
  const hot = base > 50;
  if (hot && vessel.stepCount % WAKE_REFRESH_STEPS === 0) refreshWake(st, vessel, hx, hy, hz);
  const tEnv = environmentTemperature(env, rho, airTemp);
  const tEnv4 = tEnv * tEnv * tEnv * tEnv;
  let maxFlux = 0;
  for (let i = 0; i < th.length; i++) {
    const ref = th[i]!;
    const part = parts[ref.part]!;
    const temps = part.temps;
    const exposed = hot && !part.shielded;
    // Exposure of the part's blunt face (if any) decides whether its skin sits in its own wake.
    let flatExposure = 0;
    if (exposed && ref.hasFlat) {
      for (let k = 0; k < ref.surfaces.length; k++) {
        const s = ref.surfaces[k]!;
        if (!s.axisym) flatExposure = Math.max(flatExposure, s.nx * hx + s.ny * hy + s.nz * hz);
      }
    }
    for (let k = 0; k < ref.surfaces.length; k++) {
      const s = ref.surfaces[k]!;
      let qIn = 0;
      if (exposed) {
        const d = s.nx * hx + s.ny * hy + s.nz * hz;
        let e = s.axisym ? 0.15 + 0.85 * (d > 0 ? d : 0) : d > 0 ? d : 0;
        e *= st.carried.wake[i]!;
        if (s.axisym && flatExposure > 0.5) e *= WAKE_FACTOR;
        if (e > 0) {
          let q = base / Math.sqrt(s.noseRadius);
          if (radiating) q += radiativeFlux(heating!, rho, speed, s.noseRadius);
          qIn = e * q;
        }
      }
      if (qIn > maxFlux) maxFlux = qIn;
      const T = temps[s.index]!;
      const qOut = s.emissivity * STEFAN_BOLTZMANN * (T * T * T * T - tEnv4);
      const sh = ref.shield;
      if (sh && !s.axisym) {
        // Ablative shield on the part's flat face.
        const amount = sh.res >= 0 ? part.resources[sh.res]! : 0;
        const capacity = sh.res >= 0 ? part.def.resources![sh.res]!.capacity : 0;
        if (amount > 0) {
          if (qIn > sh.def.qThreshold) {
            const dm = (sh.def.area * (qIn - sh.def.qThreshold) * dt) / sh.def.heff;
            part.resources[sh.res] = Math.max(0, amount - dm);
          }
          // The char layer insulates the substrate: only a fraction of the net flux is conducted.
          temps[s.index] = T + (sh.def.conductFraction * (qIn - qOut) * dt) / s.heatCap;
          const tEq = Math.pow(Math.max(qIn, 0) / (s.emissivity * STEFAN_BOLTZMANN) + tEnv4, 0.25);
          sh.state.surfaceTemp = Math.max(temps[s.index]!, Math.min(tEq, ABLATION_TEMP));
        } else {
          temps[s.index] = T + ((qIn - qOut) * dt) / s.heatCap;
          sh.state.surfaceTemp = temps[s.index]!;
        }
        sh.state.ablatorFraction = capacity > 0 ? part.resources[sh.res]! / capacity : 0;
      } else {
        temps[s.index] = T + ((qIn - qOut) * dt) / s.heatCap;
      }
      const Tn = temps[s.index]!;
      if (Tn < 2.7) temps[s.index] = 2.7;
      if (Tn > s.maxTemp) {
        if (overheated.indexOf(ref.part) < 0) overheated.push(ref.part);
      }
    }
  }
  vessel.aero.heatFlux = maxFlux;
  vessel.aero.plasmaIntensity = smoothstep(0.05e6, 1.0e6, maxFlux);
}

/** Hottest surface of a part as [temperature, limit] (the pair with the highest ratio). */
export function partSkinTemperature(temps: readonly number[], surfaces: readonly { maxTemp: number }[]): [number, number] {
  let bestT = temps[0] ?? 0;
  let bestMax = surfaces[0]?.maxTemp ?? 1;
  for (let k = 1; k < surfaces.length; k++) {
    const m = surfaces[k]!.maxTemp;
    if (temps[k]! / m > bestT / bestMax) {
      bestT = temps[k]!;
      bestMax = m;
    }
  }
  return [bestT, bestMax];
}
