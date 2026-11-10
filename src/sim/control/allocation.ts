/**
 * Control authority and actuator allocation (sim-design 7.2-7.5): gimbals, reaction wheels and RCS.
 *
 * Torque commands are normalised per VES axis: u.x = pitch (+ nose toward +Z), u.y = roll (+ about +Y),
 * u.z = MINUS yaw (yaw + turns the nose toward +X, which is a rotation about -Z).
 *
 * Every actuator degree of freedom gets one weight per axis, w = a_i / max|a_i| with a = torque per unit
 * deflection (gimbal) or per unit level (thruster): the best-placed actuator saturates at |u| = 1 and
 * symmetric layouts produce no cross-coupling. RCS joins an axis only when gimbals and wheels do not
 * already dominate it, which keeps the thrusters quiet during main-engine burns.
 */
import type { SimEvent } from '@/core/contracts/sim';
import { G0 } from '@/core/math/scalar';
import type { Vec3 } from '@/core/math/vec3';
import type { Structure } from '../vessel/structure';
import { GIMBAL_MIN_THRUST_FRACTION, type Vessel } from '../vessel/types';

/** Thruster levels below this are suppressed (chatter and propellant waste). */
export const RCS_DEADBAND = 0.05;
/** RCS is left out of an axis when gimbal + wheel torque exceeds this multiple of the RCS torque. */
export const RCS_QUIET_RATIO = 3;
const RCS_PULSE_EVENT_INTERVAL = 0.25;

export interface Authority {
  /** Gimbal, wheel and RCS torque available per VES axis, N m. */
  gimbal: [number, number, number];
  wheel: [number, number, number];
  rcs: [number, number, number];
  useRcs: [boolean, boolean, boolean];
  rcsMaxArm: [number, number, number];
}

export const authority: Authority = {
  gimbal: [0, 0, 0],
  wheel: [0, 0, 0],
  rcs: [0, 0, 0],
  useRcs: [false, false, false],
  rcsMaxArm: [0, 0, 0],
};

function tankAmount(vessel: Vessel, tanks: { part: number; res: number }[]): number {
  let a = 0;
  for (let i = 0; i < tanks.length; i++) a += vessel.parts[tanks[i]!.part]!.resources[tanks[i]!.res]!;
  return a;
}

const dofA: number[] = [];

/** Compute the torque authority of every actuator about the current CoM and store vessel.authority. */
export function computeAuthority(vessel: Vessel, st: Structure): Authority {
  const A = authority;
  const com = vessel.mp.com;
  A.gimbal[0] = A.gimbal[1] = A.gimbal[2] = 0;
  A.rcs[0] = A.rcs[1] = A.rcs[2] = 0;
  A.rcsMaxArm[0] = A.rcsMaxArm[1] = A.rcsMaxArm[2] = 0;
  const controllable = vessel.hold === null;

  // Gimbals: torque derivative of each gimbal axis, per radian.
  const engines = st.engines;
  dofA.length = 0;
  let maxX = 0;
  let maxY = 0;
  let maxZ = 0;
  for (let i = 0; i < engines.length; i++) {
    const e = engines[i]!;
    const live = controllable && e.gimbalRange > 0 && e.rt.lit && e.state.thrust >= GIMBAL_MIN_THRUST_FRACTION * e.def.thrustVac;
    if (!live) {
      dofA.push(0, 0, 0, 0, 0, 0);
      continue;
    }
    const T = e.state.thrust;
    const lx = e.nozzlePos[0]! - com.x;
    const ly = e.nozzlePos[1]! - com.y;
    const lz = e.nozzlePos[2]! - com.z;
    const ex = e.nozzleDir[0]!;
    const ey = e.nozzleDir[1]!;
    const ez = e.nozzleDir[2]!;
    for (let k = 0; k < 2; k++) {
      const g = k === 0 ? e.axisX : e.axisZ;
      // dF/dangle = -T (g x e0)
      const fx = -T * (g.y * ez - g.z * ey);
      const fy = -T * (g.z * ex - g.x * ez);
      const fz = -T * (g.x * ey - g.y * ex);
      const ax = ly * fz - lz * fy;
      const ay = lz * fx - lx * fz;
      const az = lx * fy - ly * fx;
      dofA.push(ax, ay, az);
      if (Math.abs(ax) > maxX) maxX = Math.abs(ax);
      if (Math.abs(ay) > maxY) maxY = Math.abs(ay);
      if (Math.abs(az) > maxZ) maxZ = Math.abs(az);
    }
  }
  // An axis whose best lever is a tiny fraction of the largest one is numerical dust (e.g. roll of a centred engine).
  const floor = 1e-4 * Math.max(maxX, maxY, maxZ);
  for (let i = 0; i < engines.length; i++) {
    const e = engines[i]!;
    const s = Math.sin(e.gimbalRange);
    for (let k = 0; k < 2; k++) {
      const o = (i * 2 + k) * 3;
      const w = k === 0 ? e.wX : e.wZ;
      w[0] = maxX > floor ? dofA[o]! / maxX : 0;
      w[1] = maxY > floor ? dofA[o + 1]! / maxY : 0;
      w[2] = maxZ > floor ? dofA[o + 2]! / maxZ : 0;
      A.gimbal[0] += Math.abs(dofA[o]! * w[0]) * s;
      A.gimbal[1] += Math.abs(dofA[o + 1]! * w[1]) * s;
      A.gimbal[2] += Math.abs(dofA[o + 2]! * w[2]) * s;
    }
  }

  A.wheel[0] = controllable ? st.wheel[0] : 0;
  A.wheel[1] = controllable ? st.wheel[1] : 0;
  A.wheel[2] = controllable ? st.wheel[2] : 0;

  // RCS: torque of each thruster at full level.
  const pos = [0, 0, 0];
  const neg = [0, 0, 0];
  if (controllable && vessel.rcsEnabled) {
    for (let i = 0; i < st.rcs.length; i++) {
      const r = st.rcs[i]!;
      if (!r.state.enabled || tankAmount(vessel, r.tanks) <= 0) continue;
      const n = r.def.thrusters.length;
      for (let t = 0; t < n; t++) {
        const o = t * 3;
        const T = r.def.thrusters[t]!.thrust;
        const lx = r.pos[o]! - com.x;
        const ly = r.pos[o + 1]! - com.y;
        const lz = r.pos[o + 2]! - com.z;
        const fx = r.force[o]! * T;
        const fy = r.force[o + 1]! * T;
        const fz = r.force[o + 2]! * T;
        const ax = ly * fz - lz * fy;
        const ay = lz * fx - lx * fz;
        const az = lx * fy - ly * fx;
        r.arm[o] = ax;
        r.arm[o + 1] = ay;
        r.arm[o + 2] = az;
        if (Math.abs(ax) > A.rcsMaxArm[0]) A.rcsMaxArm[0] = Math.abs(ax);
        if (Math.abs(ay) > A.rcsMaxArm[1]) A.rcsMaxArm[1] = Math.abs(ay);
        if (Math.abs(az) > A.rcsMaxArm[2]) A.rcsMaxArm[2] = Math.abs(az);
      }
    }
    for (let i = 0; i < st.rcs.length; i++) {
      const r = st.rcs[i]!;
      if (!r.state.enabled || tankAmount(vessel, r.tanks) <= 0) continue;
      const n = r.def.thrusters.length;
      for (let t = 0; t < n; t++) {
        for (let k = 0; k < 3; k++) {
          const a = r.arm[t * 3 + k]!;
          const m = A.rcsMaxArm[k]!;
          if (m <= 0) continue;
          if (a > 0) pos[k] = pos[k]! + (a * a) / m;
          else neg[k] = neg[k]! + (a * a) / m;
        }
      }
    }
  }
  for (let k = 0; k < 3; k++) {
    A.rcs[k] = Math.min(pos[k]!, neg[k]!);
    const primary = A.gimbal[k]! + A.wheel[k]!;
    A.useRcs[k] = A.rcs[k]! > 0 && primary < RCS_QUIET_RATIO * A.rcs[k]!;
    vessel.authority[k] = primary + (A.useRcs[k] ? A.rcs[k]! : 0);
  }
  return A;
}

export interface ActuatorOut {
  fx: number;
  fy: number;
  fz: number;
  tx: number;
  ty: number;
  tz: number;
  /** Magnitude sum of thruster forces, N. */
  thrust: number;
}
export const actuatorOut: ActuatorOut = { fx: 0, fy: 0, fz: 0, tx: 0, ty: 0, tz: 0, thrust: 0 };

/**
 * Turn the normalised torque command (ux, uy, uz) and the translation command into gimbal targets, wheel
 * torques and thruster levels; consume RCS propellant. Returns the wheel + RCS force and torque (VES).
 * computeAuthority() must have run in this step.
 */
export function applyActuators(vessel: Vessel, st: Structure, ux: number, uy: number, uz: number, translate: Vec3, dt: number, ut: number, events: SimEvent[]): ActuatorOut {
  const A = authority;
  const out = actuatorOut;
  out.fx = out.fy = out.fz = out.thrust = 0;
  const controllable = vessel.hold === null;

  // Gimbal targets.
  for (let i = 0; i < st.engines.length; i++) {
    const e = st.engines[i]!;
    if (e.gimbalRange <= 0) continue;
    let cx = e.wX[0] * ux + e.wX[1] * uy + e.wX[2] * uz;
    let cz = e.wZ[0] * ux + e.wZ[1] * uy + e.wZ[2] * uz;
    cx = cx < -1 ? -1 : cx > 1 ? 1 : cx;
    cz = cz < -1 ? -1 : cz > 1 ? 1 : cz;
    e.rt.cmdX = cx * e.gimbalRange;
    e.rt.cmdZ = cz * e.gimbalRange;
  }

  // Wheels.
  out.tx = ux * A.wheel[0];
  out.ty = uy * A.wheel[1];
  out.tz = uz * A.wheel[2];
  for (let i = 0; i < st.wheelParts.length; i++) {
    const wp = st.wheelParts[i]!;
    const part = vessel.parts[wp.part]!;
    const md = part.def.modules[wp.mod]!;
    const ms = part.modules[wp.mod]!;
    if (md.type === 'reactionWheel' && ms.type === 'reactionWheel') {
      ms.torque.x = controllable ? ux * md.torque[0] : 0;
      ms.torque.y = controllable ? uy * md.torque[1] : 0;
      ms.torque.z = controllable ? uz * md.torque[2] : 0;
    }
  }

  // RCS.
  const rx = A.useRcs[0] && A.rcsMaxArm[0] > 0 ? ux / A.rcsMaxArm[0] : 0;
  const ry = A.useRcs[1] && A.rcsMaxArm[1] > 0 ? uy / A.rcsMaxArm[1] : 0;
  const rz = A.useRcs[2] && A.rcsMaxArm[2] > 0 ? uz / A.rcsMaxArm[2] : 0;
  for (let i = 0; i < st.rcs.length; i++) {
    const r = st.rcs[i]!;
    const levels = r.state.levels;
    const n = r.def.thrusters.length;
    const amount = tankAmount(vessel, r.tanks);
    const live = controllable && vessel.rcsEnabled && r.state.enabled && amount > 0;
    if (r.rt.pulseCooldown > 0) r.rt.pulseCooldown -= dt;
    if (!live) {
      for (let t = 0; t < n; t++) levels[t] = 0;
      r.rt.firing = false;
      continue;
    }
    let flow = 0;
    let any = false;
    for (let t = 0; t < n; t++) {
      const o = t * 3;
      let level = r.arm[o]! * rx + r.arm[o + 1]! * ry + r.arm[o + 2]! * rz + (r.force[o]! * translate.x + r.force[o + 1]! * translate.y + r.force[o + 2]! * translate.z);
      if (level < RCS_DEADBAND) level = 0;
      else if (level > 1) level = 1;
      levels[t] = level;
      if (level > 0) {
        any = true;
        const T = level * r.def.thrusters[t]!.thrust;
        flow += T;
        out.fx += r.force[o]! * T;
        out.fy += r.force[o + 1]! * T;
        out.fz += r.force[o + 2]! * T;
        out.tx += level * r.arm[o]!;
        out.ty += level * r.arm[o + 1]!;
        out.tz += level * r.arm[o + 2]!;
        out.thrust += T;
      }
    }
    if (any) {
      // Propellant: drawn from the stage group's tanks in proportion to their content.
      const use = Math.min(amount, (flow / (r.def.isp * G0)) * dt);
      const frac = use / amount;
      for (let k = 0; k < r.tanks.length; k++) {
        const tk = r.tanks[k]!;
        const res = vessel.parts[tk.part]!.resources;
        res[tk.res] = res[tk.res]! * (1 - frac);
      }
      if (!r.rt.firing && r.rt.pulseCooldown <= 0) {
        events.push({ type: 'rcsPulse', ut, vesselId: vessel.id, partId: vessel.parts[r.part]!.instanceId });
        r.rt.pulseCooldown = RCS_PULSE_EVENT_INTERVAL;
      }
    }
    r.rt.firing = any;
  }
  return out;
}

/** True when an RCS translation command would actually fire a thruster. */
export function rcsTranslationActive(vessel: Vessel, translate: Vec3): boolean {
  if (!vessel.rcsEnabled || vessel.hold === 'clamps' || vessel.hold === 'ground') return false;
  if (translate.x === 0 && translate.y === 0 && translate.z === 0) return false;
  for (const p of vessel.parts) for (const m of p.modules) if (m.type === 'rcs' && m.enabled) return true;
  return false;
}
