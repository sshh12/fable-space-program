/**
 * Engines (sim-design 7.1, 7.2): shared throttle with a per-engine minimum, first-order spool lag,
 * ignition / shutdown events and ignition counts, thrust and Isp against ambient pressure, propellant
 * draw from the engine's stage group with flame-out, fixed-burn solid motors, gimbal servos.
 */
import type { SimEvent } from '@/core/contracts/sim';
import { G0 } from '@/core/math/scalar';
import { eventPartId } from '../ids';
import type { EngineRef, Structure } from '../structure';
import type { EngineDef, Vessel } from '../types';

export const IGNITION_THRESHOLD = 0.02;
export const SHUTDOWN_THRESHOLD = 0.01;
const SEA_LEVEL_PRESSURE = 101325;

/** Specific impulse at ambient pressure p (linear between the vacuum and sea-level values), s. */
export function ispAt(def: EngineDef, pressure: number): number {
  return def.ispVac - (def.ispVac - def.ispSL) * (pressure / SEA_LEVEL_PRESSURE);
}

/** Full-throttle thrust at ambient pressure p, N. */
export function thrustAt(def: EngineDef, pressure: number): number {
  return Math.max(0, (def.thrustVac / def.ispVac) * ispAt(def, pressure));
}

/** Effective throttle of an engine for a lever position (sim-design 7.1). */
export function throttleTarget(def: EngineDef, lever: number): number {
  if (def.fixedBurn) return 1;
  if (!def.throttleable) return lever > 0 ? 1 : 0;
  return lever <= 0 ? 0 : def.minThrottle + (1 - def.minThrottle) * Math.min(1, lever);
}

/** Seconds of full-throttle burn the tanks of this engine allow (the scarcest propellant decides). */
function burnAvailable(vessel: Vessel, e: EngineRef): number {
  let t = Infinity;
  for (let k = 0; k < e.def.propellants.length; k++) {
    const tanks = e.tanks[k]!;
    let amount = 0;
    for (let i = 0; i < tanks.length; i++) amount += vessel.parts[tanks[i]!.part]!.resources[tanks[i]!.res]!;
    const need = e.mdotMax * e.def.propellants[k]!.ratio;
    if (need > 0) t = Math.min(t, amount / need);
  }
  return t;
}

export interface EngineOut {
  fx: number;
  fy: number;
  fz: number;
  tx: number;
  ty: number;
  tz: number;
  thrust: number;
}
export const engineOut: EngineOut = { fx: 0, fy: 0, fz: 0, tx: 0, ty: 0, tz: 0, thrust: 0 };

/**
 * Advance every engine by dt: spool, events, propellant, gimbal servo. Returns the total thrust force
 * (VES) and its torque about the CoM.
 */
export function updateEngines(vessel: Vessel, st: Structure, lever: number, pressure: number, dt: number, ut: number, events: SimEvent[]): EngineOut {
  const out = engineOut;
  out.fx = out.fy = out.fz = out.tx = out.ty = out.tz = out.thrust = 0;
  const com = vessel.mp.com;
  const engines = st.engines;
  for (let i = 0; i < engines.length; i++) {
    const e = engines[i]!;
    const s = e.state;
    const rt = e.rt;
    const def = e.def;
    s.ambientPressure = pressure;
    if (rt.lit) s.ignitionAge += dt;
    else if (s.shutdownAge >= 0) s.shutdownAge += dt;

    // Target throttle.
    let target = 0;
    if (s.active && !s.flameout) {
      if (def.fixedBurn) target = rt.started && rt.burnLeft > 0 ? 1 : 0;
      else target = throttleTarget(def, lever);
      // An engine that is out of ignitions cannot relight.
      if (target > 0 && !rt.lit && s.ignitionsLeft !== null && s.ignitionsLeft <= 0) target = 0;
    }
    // Propellant check before lighting or continuing.
    if (target > 0 || s.throttleActual > 0) {
      if (burnAvailable(vessel, e) <= 0) {
        if (target > 0 || rt.lit) s.flameout = true;
        target = 0;
      }
    }
    if (target === 0 && s.throttleActual === 0 && !rt.lit) {
      s.thrust = 0;
      s.massFlow = 0;
      s.pressureRatio = 1e6;
      servo(e, dt);
      continue;
    }

    // Spool lag (exact first-order response).
    const tau = target > s.throttleActual ? def.spoolUp : def.spoolDown;
    const k = tau > 0 ? 1 - Math.exp(-dt / tau) : 1;
    let actual = s.throttleActual + (target - s.throttleActual) * k;
    if (s.flameout) actual = Math.min(actual, s.throttleActual);

    if (!rt.lit && actual > IGNITION_THRESHOLD) {
      rt.lit = true;
      s.ignitionAge = 0;
      s.shutdownAge = -1;
      if (s.ignitionsLeft !== null) s.ignitionsLeft -= 1;
      events.push({ type: 'engineIgnition', ut, vesselId: vessel.id, partId: eventPartId(vessel, vessel.parts[e.part]!) });
    }
    if (target === 0 && actual < SHUTDOWN_THRESHOLD) {
      actual = 0;
      if (rt.lit) {
        rt.lit = false;
        s.shutdownAge = 0;
        events.push({ type: 'engineShutdown', ut, vesselId: vessel.id, partId: eventPartId(vessel, vessel.parts[e.part]!), flameout: s.flameout });
      }
    }
    s.throttleActual = actual;

    // Propellant draw; a short tank ends the step's burn early.
    let mdot = actual * e.mdotMax;
    if (mdot > 0) {
      const avail = burnAvailable(vessel, e) * e.mdotMax;
      let used = mdot * dt;
      if (used >= avail) {
        used = avail;
        mdot = used / dt;
        s.flameout = true;
      }
      for (let p = 0; p < def.propellants.length; p++) {
        const need = used * def.propellants[p]!.ratio;
        const tanks = e.tanks[p]!;
        let amount = 0;
        for (let t = 0; t < tanks.length; t++) amount += vessel.parts[tanks[t]!.part]!.resources[tanks[t]!.res]!;
        if (amount <= 0) continue;
        const keep = Math.max(0, 1 - need / amount);
        for (let t = 0; t < tanks.length; t++) {
          const res = vessel.parts[tanks[t]!.part]!.resources;
          res[tanks[t]!.res] = res[tanks[t]!.res]! * keep;
        }
      }
      if (def.fixedBurn && rt.started) {
        rt.burnLeft -= dt;
        if (rt.burnLeft <= 0) {
          rt.burnLeft = 0;
          s.active = false;
        }
      }
    }
    const isp = ispAt(def, pressure);
    const thrust = Math.max(0, mdot * G0 * isp);
    s.massFlow = mdot;
    s.thrust = thrust;
    const pExit = (def.nozzles[0]?.exitPressure ?? 0) * actual;
    s.pressureRatio = pressure > 0 ? Math.min(1e6, pExit / pressure) : 1e6;

    servo(e, dt);

    if (thrust > 0) {
      const nN = def.nozzles.length;
      const per = thrust / nN;
      const gx = s.gimbal[0];
      const gz = s.gimbal[1];
      for (let n = 0; n < nN; n++) {
        const o = n * 3;
        let ex = e.nozzleDir[o]!;
        let ey = e.nozzleDir[o + 1]!;
        let ez = e.nozzleDir[o + 2]!;
        if (gx !== 0 || gz !== 0) {
          // Deflect the exhaust: e + gx (X x e) + gz (Z x e), renormalised (angles are a few degrees).
          const X = e.axisX;
          const Z = e.axisZ;
          const dx = gx * (X.y * ez - X.z * ey) + gz * (Z.y * ez - Z.z * ey);
          const dy = gx * (X.z * ex - X.x * ez) + gz * (Z.z * ex - Z.x * ez);
          const dz = gx * (X.x * ey - X.y * ex) + gz * (Z.x * ey - Z.y * ex);
          ex += dx;
          ey += dy;
          ez += dz;
          const l = 1 / Math.sqrt(ex * ex + ey * ey + ez * ez);
          ex *= l;
          ey *= l;
          ez *= l;
        }
        const fx = -per * ex;
        const fy = -per * ey;
        const fz = -per * ez;
        const lx = e.nozzlePos[o]! - com.x;
        const ly = e.nozzlePos[o + 1]! - com.y;
        const lz = e.nozzlePos[o + 2]! - com.z;
        out.fx += fx;
        out.fy += fy;
        out.fz += fz;
        out.tx += ly * fz - lz * fy;
        out.ty += lz * fx - lx * fz;
        out.tz += lx * fy - ly * fx;
      }
      out.thrust += thrust;
    }
  }
  return out;
}

function servo(e: EngineRef, dt: number): void {
  if (e.gimbalRange <= 0) return;
  const g = e.state.gimbal;
  const step = e.gimbalRate * dt;
  const tx = e.rt.lit ? e.rt.cmdX : 0;
  const tz = e.rt.lit ? e.rt.cmdZ : 0;
  const dx = tx - g[0];
  const dz = tz - g[1];
  g[0] += dx > step ? step : dx < -step ? -step : dx;
  g[1] += dz > step ? step : dz < -step ? -step : dz;
}

/** True when an engine is producing thrust or about to (active with the lever up, or a motor mid-burn). */
export function anyEngineBurning(vessel: Vessel): boolean {
  for (const p of vessel.parts) {
    for (let m = 0; m < p.modules.length; m++) {
      const ms = p.modules[m]!;
      if (ms.type !== 'engine') continue;
      if (ms.throttleActual > 0) return true;
      const md = p.def.modules[m]!;
      const rt = p.rt[m]!;
      if (!ms.active || ms.flameout || md.type !== 'engine' || rt.type !== 'engine') continue;
      if (md.fixedBurn ? rt.started && rt.burnLeft > 0 : vessel.throttle > 0 && (ms.ignitionsLeft === null || ms.ignitionsLeft > 0 || rt.lit)) return true;
    }
  }
  return false;
}
