/**
 * Mass, centre of mass and inertia tensor of a vessel from its parts and current resource amounts
 * (sim-design 6.2). Propellant is settled at the bottom of its tank, so the CoM moves as tanks drain.
 */
import type { PartDef } from '@/core/contracts/defs';
import { mat3, type Mat3 } from '@/core/math/mat';
import type { PartRuntime, Vessel } from './types';
import { panelCentroid } from './structure';

/** Principal moments (about the shape's own CoM) per unit mass: [Ixx, Iyy (axial), Izz]. */
export function unitInertia(shape: PartDef['inertiaShape']): [number, number, number] {
  const r = shape.r ?? 0;
  const h = shape.h ?? 0;
  switch (shape.kind) {
    case 'solidCylinder': {
      const t = (3 * r * r + h * h) / 12;
      return [t, (r * r) / 2, t];
    }
    case 'shellCylinder': {
      const t = (6 * r * r + h * h) / 12;
      return [t, r * r, t];
    }
    case 'cone': {
      const t = (3 * r * r) / 20 + (3 * h * h) / 80;
      return [t, (3 * r * r) / 10, t];
    }
    case 'sphere': {
      const s = (2 * r * r) / 5;
      return [s, s, s];
    }
    case 'box': {
      const [x, y, z] = shape.size ?? [0, 0, 0];
      return [(y * y + z * z) / 12, (x * x + z * z) / 12, (x * x + y * y) / 12];
    }
  }
}

/** True for a part that is fixed to the ground and therefore not part of the flying mass (unreleased launch clamp). */
export function isGroundFixed(p: PartRuntime): boolean {
  for (let m = 0; m < p.modules.length; m++) {
    if (p.modules[m]!.type === 'launchClamp') return true;
  }
  return false;
}

export function partDryMass(p: PartRuntime): number {
  return p.panel ? p.def.dryMass / p.panel.count : p.def.dryMass;
}

export function partMass(p: PartRuntime): number {
  let m = partDryMass(p);
  for (let r = 0; r < p.resources.length; r++) m += p.resources[r]!;
  return m;
}

// Scratch accumulators (module-level, reused; the function is not re-entrant, which is fine on one thread).
let sm = 0;
let sx = 0;
let sy = 0;
let sz = 0;
let ixx = 0;
let iyy = 0;
let izz = 0;
let ixy = 0;
let ixz = 0;
let iyz = 0;

/** Add a body of mass m at c with principal unit inertia (px, py, pz) in a frame rotated by matrix R (row-major). */
function addBody(m: number, cx: number, cy: number, cz: number, px: number, py: number, pz: number, R: Mat3 | null): void {
  sm += m;
  sx += m * cx;
  sy += m * cy;
  sz += m * cz;
  // Parallel axis about the VES origin.
  ixx += m * (cy * cy + cz * cz);
  iyy += m * (cx * cx + cz * cz);
  izz += m * (cx * cx + cy * cy);
  ixy -= m * cx * cy;
  ixz -= m * cx * cz;
  iyz -= m * cy * cz;
  if (R === null) {
    ixx += m * px;
    iyy += m * py;
    izz += m * pz;
  } else {
    // R diag(p) R^T
    ixx += m * (R[0] * R[0] * px + R[1] * R[1] * py + R[2] * R[2] * pz);
    iyy += m * (R[3] * R[3] * px + R[4] * R[4] * py + R[5] * R[5] * pz);
    izz += m * (R[6] * R[6] * px + R[7] * R[7] * py + R[8] * R[8] * pz);
    ixy += m * (R[0] * R[3] * px + R[1] * R[4] * py + R[2] * R[5] * pz);
    ixz += m * (R[0] * R[6] * px + R[1] * R[7] * py + R[2] * R[8] * pz);
    iyz += m * (R[3] * R[6] * px + R[4] * R[7] * py + R[5] * R[8] * pz);
  }
}

interface RotCache {
  qx: number;
  qy: number;
  qz: number;
  qw: number;
  /** Part -> VES rotation matrix (null = identity) and the matrix that takes the inertia principal frame to VES. */
  rm: Mat3 | null;
  im: Mat3 | null;
  unit: [number, number, number];
}
const rotCache = new WeakMap<PartRuntime, RotCache>();

function partRot(p: PartRuntime): RotCache {
  let c = rotCache.get(p);
  const q = p.rot;
  if (!c || c.qx !== q.x || c.qy !== q.y || c.qz !== q.z || c.qw !== q.w) {
    const identity = q.x === 0 && q.y === 0 && q.z === 0;
    const rm = identity ? null : mat3.fromQuat(q);
    let unit = unitInertia(p.def.inertiaShape);
    let im = rm;
    if (p.panel) {
      // One fairing panel: a thin curved plate, approximated by a box chord x height x sagitta whose
      // principal frame is the part frame rotated about Y by the panel azimuth.
      const half = Math.PI / p.panel.count;
      const b = p.def.bounds;
      const chord = 2 * b.radius * Math.sin(half);
      const sag = b.radius * (1 - Math.cos(half));
      const h = b.yMax - b.yMin;
      unit = [(h * h + sag * sag) / 12, (chord * chord + sag * sag) / 12, (chord * chord + h * h) / 12];
      const az = ((p.panel.index + 0.5) * 2 * Math.PI) / p.panel.count;
      const cs = Math.cos(az);
      const sn = Math.sin(az);
      // Columns: tangential (cos, 0, -sin), Y, radial (sin, 0, cos).
      const local: Mat3 = [cs, 0, sn, 0, 1, 0, -sn, 0, cs];
      im = rm ? mat3.mul(rm, local) : local;
    }
    c = { qx: q.x, qy: q.y, qz: q.z, qw: q.w, rm, im, unit };
    rotCache.set(p, c);
  }
  return c;
}

/** Recompute vessel.mp from the parts. Unreleased launch clamps are ground structure and carry no flight mass. */
export function computeMassProps(vessel: Vessel): void {
  sm = sx = sy = sz = ixx = iyy = izz = ixy = ixz = iyz = 0;
  const parts = vessel.parts;
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]!;
    const def = p.def;
    if (vessel.hold === 'clamps' && isGroundFixed(p)) continue;
    const rc = partRot(p);
    const R = rc.rm;
    const dry = partDryMass(p);
    let ox = def.comOffset[0];
    let oy = def.comOffset[1];
    let oz = def.comOffset[2];
    if (p.panel) {
      const c = panelCentroid(def, p.panel.index, p.panel.count);
      ox = c.x;
      oy = c.y;
      oz = c.z;
    }
    let cx: number;
    let cy: number;
    let cz: number;
    if (R === null) {
      cx = p.pos.x + ox;
      cy = p.pos.y + oy;
      cz = p.pos.z + oz;
    } else {
      cx = p.pos.x + R[0] * ox + R[1] * oy + R[2] * oz;
      cy = p.pos.y + R[3] * ox + R[4] * oy + R[5] * oz;
      cz = p.pos.z + R[6] * ox + R[7] * oy + R[8] * oz;
    }
    if (dry > 0) addBody(dry, cx, cy, cz, rc.unit[0], rc.unit[1], rc.unit[2], rc.im);
    const res = def.resources;
    if (res) {
      const rad = def.inertiaShape.r ?? def.bounds.radius;
      for (let k = 0; k < res.length; k++) {
        const amount = p.resources[k]!;
        if (amount <= 0) continue;
        const rd = res[k]!;
        const fill = rd.capacity > 0 ? amount / rd.capacity : 0;
        const hf = fill * rd.tankHeight;
        const y = rd.tankBottomY + hf / 2;
        // Tank axis = part Y; the propellant column is a solid cylinder of height hf.
        let tx = p.pos.x;
        let ty = p.pos.y + y;
        let tz = p.pos.z;
        if (R !== null) {
          tx = p.pos.x + R[1] * y;
          ty = p.pos.y + R[4] * y;
          tz = p.pos.z + R[7] * y;
        }
        const t = (3 * rad * rad + hf * hf) / 12;
        addBody(amount, tx, ty, tz, t, (rad * rad) / 2, t, R);
      }
    }
  }
  const mp = vessel.mp;
  if (sm <= 0) {
    mp.mass = 0;
    mp.com.x = mp.com.y = mp.com.z = 0;
    mp.i = [1, 1, 1, 0, 0, 0];
    mp.inv = [1, 1, 1, 0, 0, 0];
    return;
  }
  const cx = sx / sm;
  const cy = sy / sm;
  const cz = sz / sm;
  mp.mass = sm;
  mp.com.x = cx;
  mp.com.y = cy;
  mp.com.z = cz;
  // Shift from the origin to the CoM.
  const a = ixx - sm * (cy * cy + cz * cz);
  const b = iyy - sm * (cx * cx + cz * cz);
  const c = izz - sm * (cx * cx + cy * cy);
  const d = ixy + sm * cx * cy;
  const e = ixz + sm * cx * cz;
  const f = iyz + sm * cy * cz;
  const I = mp.i;
  I[0] = a;
  I[1] = b;
  I[2] = c;
  I[3] = d;
  I[4] = e;
  I[5] = f;
  // Symmetric inverse.
  const c00 = b * c - f * f;
  const c01 = e * f - d * c;
  const c02 = d * f - e * b;
  const det = a * c00 + d * c01 + e * c02;
  const inv = mp.inv;
  if (!(Math.abs(det) > 1e-30)) {
    inv[0] = a > 0 ? 1 / a : 1;
    inv[1] = b > 0 ? 1 / b : 1;
    inv[2] = c > 0 ? 1 / c : 1;
    inv[3] = inv[4] = inv[5] = 0;
    return;
  }
  const id = 1 / det;
  inv[0] = c00 * id;
  inv[1] = (a * c - e * e) * id;
  inv[2] = (a * b - d * d) * id;
  inv[3] = c01 * id;
  inv[4] = c02 * id;
  inv[5] = (d * e - a * f) * id;
}

/** Flight mass of a vessel without recomputing the tensor. */
export function vesselMass(vessel: Vessel): number {
  let m = 0;
  for (const p of vessel.parts) {
    if (vessel.hold === 'clamps' && isGroundFixed(p)) continue;
    m += partMass(p);
  }
  return m;
}
