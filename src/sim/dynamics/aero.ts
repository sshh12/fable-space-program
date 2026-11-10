/**
 * Aerodynamic forces (sim-design 8.2) and parachute drag, evaluated in the vessel frame about the CoM.
 *
 * Sign convention used throughout: `V` is the velocity of a point of the vessel RELATIVE TO THE AIR (the
 * atmosphere co-rotates with the body). Drag opposes V.
 */
import type { MachTable } from '@/core/contracts/defs';
import { AERO_AXISYM, AERO_CAPSULE, type AeroElem, type Structure } from '../vessel/structure';
import type { Vessel } from '../vessel/types';

export const FLAT_PLATE_CD = 1.28;
/** Axial-force factor of a blunt capsule flying apex-first, relative to shield-first. */
export const CAPSULE_APEX_FIRST_FACTOR = 0.6;

export function machLookup(table: MachTable, mach: number): number {
  const n = table.length;
  if (n === 0) return 0;
  if (mach <= table[0]![0]) return table[0]![1];
  if (mach >= table[n - 1]![0]) return table[n - 1]![1];
  for (let i = 1; i < n; i++) {
    const b = table[i]!;
    if (mach <= b[0]) {
      const a = table[i - 1]!;
      return a[1] + ((b[1] - a[1]) * (mach - a[0])) / (b[0] - a[0]);
    }
  }
  return table[n - 1]![1];
}

/** Refresh the Mach-dependent coefficients of every element (once per step). */
export function refreshAeroCoefficients(st: Structure, mach: number): void {
  for (let i = 0; i < st.aero.length; i++) {
    const e = st.aero[i]!;
    if (e.tabF) e.cdF = machLookup(e.tabF, mach);
    if (e.tabA) e.cdA = machLookup(e.tabA, mach);
  }
}

export interface AeroOut {
  fx: number;
  fy: number;
  fz: number;
  tx: number;
  ty: number;
  tz: number;
}

export const aeroOut: AeroOut = { fx: 0, fy: 0, fz: 0, tx: 0, ty: 0, tz: 0 };

/** Force and moment of one blunt-capsule element for the air-relative velocity V (VES) of its reference point. */
function capsule(e: AeroElem, rho: number, vx: number, vy: number, vz: number, wx: number, wy: number, wz: number, out: AeroOut, lx: number, ly: number, lz: number): void {
  const speed = Math.sqrt(vx * vx + vy * vy + vz * vz);
  if (speed < 1e-6) return;
  const tx = vx / speed;
  const ty = vy / speed;
  const tz = vz / speed;
  const qA = 0.5 * rho * speed * speed * e.area;
  // cos(alpha): alpha is the angle between the shield normal (-axis) and the direction of travel.
  const ta = tx * e.ax + ty * e.ay + tz * e.az;
  const cosA = -ta;
  const sinA = Math.sqrt(Math.max(0, 1 - cosA * cosA));
  const ca = (cosA >= 0 ? 1 : CAPSULE_APEX_FIRST_FACTOR) * e.cdF * cosA * cosA;
  // Axial force opposes the motion along the axis.
  const fa = -qA * ca * (ta >= 0 ? 1 : -1);
  let fx = fa * e.ax;
  let fy = fa * e.ay;
  let fz = fa * e.az;
  // Normal force: along the lateral component of the air's motion relative to the body (-V lateral).
  if (sinA > 1e-9) {
    const cn = e.cn * Math.abs(2 * sinA * cosA);
    const k = (-qA * cn) / sinA;
    fx += k * (tx - ta * e.ax);
    fy += k * (ty - ta * e.ay);
    fz += k * (tz - ta * e.az);
  }
  // Static moment restoring toward shield-first: q A D Cm_alpha ((-axis) x t).
  const ms = qA * e.diameter * e.cmAlpha;
  let mx = ms * (-e.ay * tz + e.az * ty);
  let my = ms * (-e.az * tx + e.ax * tz);
  let mz = ms * (-e.ax * ty + e.ay * tx);
  // Pitch/yaw damping on the rate component normal to the axis.
  const wa = wx * e.ax + wy * e.ay + wz * e.az;
  const md = (qA * e.diameter * e.diameter * e.cmq) / (2 * speed);
  mx -= md * (wx - wa * e.ax);
  my -= md * (wy - wa * e.ay);
  mz -= md * (wz - wa * e.az);
  out.fx += fx;
  out.fy += fy;
  out.fz += fz;
  out.tx += mx + (ly * fz - lz * fy);
  out.ty += my + (lz * fx - lx * fz);
  out.tz += mz + (lx * fy - ly * fx);
}

/**
 * Sum of aerodynamic and parachute forces (VES axes) and their torque about the CoM, written to `out`.
 * (vx, vy, vz): air-relative velocity of the CoM in VES; (wx, wy, wz): angular velocity in VES.
 */
export function evalAero(vessel: Vessel, st: Structure, rho: number, vx: number, vy: number, vz: number, wx: number, wy: number, wz: number, out: AeroOut): void {
  out.fx = out.fy = out.fz = out.tx = out.ty = out.tz = 0;
  if (!(rho > 0)) return;
  const com = vessel.mp.com;
  const half = 0.5 * rho;
  const elems = st.aero;
  for (let i = 0; i < elems.length; i++) {
    const e = elems[i]!;
    // Lever arm of the element reference point and its local velocity V + w x l.
    const lx = e.px - com.x;
    const ly = e.py - com.y;
    const lz = e.pz - com.z;
    const ux = vx + (wy * lz - wz * ly);
    const uy = vy + (wz * lx - wx * lz);
    const uz = vz + (wx * ly - wy * lx);
    if (e.kind === AERO_AXISYM) {
      const va = ux * e.ax + uy * e.ay + uz * e.az;
      // Axial: the leading face takes the drag.
      const fwd = va > 0;
      const cd = fwd ? e.cdF * e.expF : e.cdA * e.expA;
      if (cd > 0) {
        const f = -half * e.area * cd * va * Math.abs(va);
        const fx = f * e.ax;
        const fy = f * e.ay;
        const fz = f * e.az;
        const ax = (fwd ? e.fx : e.bx) - com.x;
        const ay = (fwd ? e.fy : e.by) - com.y;
        const az = (fwd ? e.fz : e.bz) - com.z;
        out.fx += fx;
        out.fy += fy;
        out.fz += fz;
        out.tx += ay * fz - az * fy;
        out.ty += az * fx - ax * fz;
        out.tz += ax * fy - ay * fx;
      }
      // Cross-flow on the side area, at the centre of pressure.
      const cx = ux - va * e.ax;
      const cy = uy - va * e.ay;
      const cz = uz - va * e.az;
      const cl = Math.sqrt(cx * cx + cy * cy + cz * cz);
      if (cl > 0) {
        const k = -half * e.ld * e.cdCross * cl;
        const fx = k * cx;
        const fy = k * cy;
        const fz = k * cz;
        out.fx += fx;
        out.fy += fy;
        out.fz += fz;
        out.tx += ly * fz - lz * fy;
        out.ty += lz * fx - lx * fz;
        out.tz += lx * fy - ly * fx;
      }
    } else if (e.kind === AERO_CAPSULE) {
      capsule(e, rho, ux, uy, uz, wx, wy, wz, out, lx, ly, lz);
    } else {
      const vn = ux * e.ax + uy * e.ay + uz * e.az;
      const f = -half * e.area * FLAT_PLATE_CD * Math.abs(vn) * vn;
      const fx = f * e.ax;
      const fy = f * e.ay;
      const fz = f * e.az;
      out.fx += fx;
      out.fy += fy;
      out.fz += fz;
      out.tx += ly * fz - lz * fy;
      out.ty += lz * fx - lx * fz;
      out.tz += lx * fy - ly * fx;
    }
  }
  const chutes = st.chutes;
  for (let i = 0; i < chutes.length; i++) {
    const c = chutes[i]!;
    const s = c.state;
    if (s.inflation <= 0 || (s.state !== 'reefed' && s.state !== 'full')) continue;
    const cdA = c.def.cdAFull * s.inflation * c.rt.canopies;
    const lx = c.attach.x - com.x;
    const ly = c.attach.y - com.y;
    const lz = c.attach.z - com.z;
    const ux = vx + (wy * lz - wz * ly);
    const uy = vy + (wz * lx - wx * lz);
    const uz = vz + (wx * ly - wy * lx);
    const sp = Math.sqrt(ux * ux + uy * uy + uz * uz);
    const k = -half * cdA * sp;
    const fx = k * ux;
    const fy = k * uy;
    const fz = k * uz;
    out.fx += fx;
    out.fy += fy;
    out.fz += fz;
    out.tx += ly * fz - lz * fy;
    out.ty += lz * fx - lx * fz;
    out.tz += lx * fy - ly * fx;
  }
}

/** True when the vessel currently flies on an active blunt-capsule element (a lifting capsule). */
export function hasLiftingCapsule(st: Structure): boolean {
  for (const e of st.aero) if (e.kind === AERO_CAPSULE) return true;
  return false;
}
