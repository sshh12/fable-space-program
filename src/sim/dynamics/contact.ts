/**
 * Ground contact and water (sim-design 9.2-9.4): penalty probes with stick-slip friction evaluated in the
 * rotating body frame, telescoping landing-leg struts, crash tolerances on land and water, buoyancy
 * spheres with slam drag on the shared swell surface.
 *
 * Friction is a bristle model: each touching probe keeps an anchor point fixed to the ground; a spring
 * and damper pull the probe toward it, and the anchor slides when the force would exceed mu * Fn. A
 * resting vessel therefore truly stops instead of creeping.
 */
import type { SimEvent } from '@/core/contracts/sim';
import type { VesselEnvironment } from '@/core/contracts/simInternal';
import type { Quat } from '@/core/math/quat';
import { LEG_BOTTOM_STIFFNESS, LEG_LATERAL_TOLERANCE_RATIO, LEG_LOCKED, LEG_OVERSTROKE, LEG_REBOUND_DAMPING_FACTOR } from '../vessel/modules/legs';
import { eventPartId } from '../vessel/ids';
import type { Probe, Structure } from '../vessel/structure';
import type { Vessel } from '../vessel/types';

/** Default stiffness of a structural probe for a 20 t vessel, N/m (scaled with vessel mass). */
export const PROBE_STIFFNESS = 4e6;
export const PROBE_REFERENCE_MASS = 20000;
export const PROBE_DAMPING_RATIO = 0.6;
/** Sub-stepping starts when a probe is within this distance of ground or water, m. */
export const CONTACT_RANGE = 5;
/** Above this altitude no terrain query is made at all, m. */
const TERRAIN_QUERY_CEILING = 25000;
export const WATER_DRAG_CD = 0.8;
/** Linear water damping: force = k rho V_submerged sqrt(g / a) v for a sphere of radius a. */
export const WATER_LINEAR_DAMPING = 0.5;
/** Lateral strut stiffness as a multiple of the axial spring. */
const LEG_LATERAL_STIFFNESS_FACTOR = 4;

/** Rigid-body state used inside the contact sub-steps: CoM position/velocity (BCI), rotation matrix VES->BCI, body rate (VES). */
export interface BodyState {
  rx: number;
  ry: number;
  rz: number;
  vx: number;
  vy: number;
  vz: number;
  /** Row-major 3x3. */
  m: number[];
  wx: number;
  wy: number;
  wz: number;
}

export interface ContactOut {
  /** Force in BCI axes and torque about the CoM in VES axes. */
  fx: number;
  fy: number;
  fz: number;
  tx: number;
  ty: number;
  tz: number;
  maxForce: number;
  anyContact: boolean;
  submergedVolume: number;
  /** Parts destroyed by impact and collapsed legs found in this evaluation. */
  crashedParts: number[];
  collapsedLegs: { probe: Probe }[];
}

export const contactOut: ContactOut = { fx: 0, fy: 0, fz: 0, tx: 0, ty: 0, tz: 0, maxForce: 0, anyContact: false, submergedVolume: 0, crashedParts: [], collapsedLegs: [] };

function rotInvQ(q: Quat, x: number, y: number, z: number, out: number[]): void {
  // rotate by conj(q)
  const qx = -q.x;
  const qy = -q.y;
  const qz = -q.z;
  const tx = 2 * (qy * z - qz * y);
  const ty = 2 * (qz * x - qx * z);
  const tz = 2 * (qx * y - qy * x);
  out[0] = x + q.w * tx + (qy * tz - qz * ty);
  out[1] = y + q.w * ty + (qz * tx - qx * tz);
  out[2] = z + q.w * tz + (qx * ty - qy * tx);
}

function rotQ(q: Quat, x: number, y: number, z: number, out: number[]): void {
  const tx = 2 * (q.y * z - q.z * y);
  const ty = 2 * (q.z * x - q.x * z);
  const tz = 2 * (q.x * y - q.y * x);
  out[0] = x + q.w * tx + (q.y * tz - q.z * ty);
  out[1] = y + q.w * ty + (q.z * tx - q.x * tz);
  out[2] = z + q.w * tz + (q.x * ty - q.y * tx);
}

const tmp = [0, 0, 0];
const dirObj = { x: 0, y: 0, z: 0 };

function legActive(pr: Probe): boolean {
  const lg = pr.legs;
  return lg === null || (lg.state.deploy >= LEG_LOCKED && !lg.state.broken[pr.leg]);
}

/**
 * Decide whether this step needs contact sub-steps: finds the probes within CONTACT_RANGE (plus the
 * distance covered in one step) of terrain or water, samples the water surface, and stores the height of
 * the lowest probe in vessel.groundClearance. `qFixed` is BCBF -> BCI at the start of the step.
 */
export function contactBroadphase(vessel: Vessel, st: Structure, env: VesselEnvironment, dt: number): boolean {
  const r = vessel.r;
  const rr = Math.sqrt(r.x * r.x + r.y * r.y + r.z * r.z);
  const alt = rr - env.radius;
  st.waterHere = false;
  st.waterHeight = -Infinity;
  st.buried = false;
  if (alt - st.boundingRadius > TERRAIN_QUERY_CEILING || !(rr > 0)) {
    vessel.groundClearance = Infinity;
    clearNear(st);
    return false;
  }
  const qf = env.qFixedToInertial;
  rotInvQ(qf, r.x / rr, r.y / rr, r.z / rr, tmp);
  dirObj.x = tmp[0]!;
  dirObj.y = tmp[1]!;
  dirObj.z = tmp[2]!;
  let hT = env.terrainHeight(dirObj, Math.max(0.3, 0.02 * Math.max(alt, 0)));
  if (alt - hT - st.boundingRadius < 50) hT = env.terrainHeight(dirObj);
  // Backstop: no point of a vessel whose origin is deeper than its bounding radius can be above ground.
  st.buried = alt - hT < -st.boundingRadius;
  let surface = hT;
  if (env.ocean !== null && env.surfaceKind(dirObj) === 'water') {
    st.waterHere = true;
    st.waterHeight = env.ocean.waterHeight(dirObj);
    if (st.waterHeight > surface) surface = st.waterHeight;
  }
  // Speed relative to the rotating surface.
  const sp = env.spin;
  const vx = vessel.v.x - (sp.y * r.z - sp.z * r.y);
  const vy = vessel.v.y - (sp.z * r.x - sp.x * r.z);
  const vz = vessel.v.z - (sp.x * r.y - sp.y * r.x);
  const margin = CONTACT_RANGE + Math.sqrt(vx * vx + vy * vy + vz * vz) * dt * 2;
  const clear = alt - surface - st.boundingRadius;
  if (clear > margin + st.boundingRadius) {
    vessel.groundClearance = Math.max(0, clear);
    clearNear(st);
    return false;
  }
  // Per-probe pass.
  const q = vessel.q;
  let minGap = Infinity;
  let any = false;
  const visit = (pr: Probe): void => {
    if (!legActive(pr)) {
      pr.near = false;
      return;
    }
    rotQ(q, pr.x, pr.y, pr.z, tmp);
    const px = r.x + tmp[0]!;
    const py = r.y + tmp[1]!;
    const pz = r.z + tmp[2]!;
    const pl = Math.sqrt(px * px + py * py + pz * pz);
    rotInvQ(qf, px / pl, py / pl, pz / pl, tmp);
    dirObj.x = tmp[0]!;
    dirObj.y = tmp[1]!;
    dirObj.z = tmp[2]!;
    let gap = pl - env.radius - env.terrainHeight(dirObj) - pr.radius;
    if (st.waterHere) gap = Math.min(gap, pl - env.radius - st.waterHeight);
    pr.near = gap < margin;
    pr.hasNormal = false;
    if (pr.near) any = true;
    if (gap < minGap) minGap = gap;
  };
  for (let i = 0; i < st.probes.length; i++) visit(st.probes[i]!);
  for (let i = 0; i < st.legs.length; i++) for (let l = 0; l < st.legs[i]!.probes.length; l++) visit(st.legs[i]!.probes[l]!);
  if (st.waterHere && env.ocean !== null) {
    for (let i = 0; i < st.buoy.length; i++) {
      const b = st.buoy[i]!;
      rotQ(q, b.x, b.y, b.z, tmp);
      const px = r.x + tmp[0]!;
      const py = r.y + tmp[1]!;
      const pz = r.z + tmp[2]!;
      const pl = Math.sqrt(px * px + py * py + pz * pz);
      rotInvQ(qf, px / pl, py / pl, pz / pl, tmp);
      dirObj.x = tmp[0]!;
      dirObj.y = tmp[1]!;
      dirObj.z = tmp[2]!;
      b.waterHeight = env.ocean.waterHeight(dirObj);
      const gap = pl - env.radius - b.waterHeight - b.radius;
      if (gap < margin) any = true;
      if (gap < minGap) minGap = gap;
    }
  } else {
    for (let i = 0; i < st.buoy.length; i++) st.buoy[i]!.waterHeight = -Infinity;
  }
  vessel.groundClearance = Number.isFinite(minGap) ? Math.max(0, minGap) : Math.max(0, clear);
  return any;
}

function clearNear(st: Structure): void {
  for (let i = 0; i < st.probes.length; i++) {
    const p = st.probes[i]!;
    p.near = false;
    p.s.inContact = false;
    p.s.hasAnchor = false;
    p.s.wet = false;
  }
  for (let i = 0; i < st.legs.length; i++) {
    const lg = st.legs[i]!;
    for (let l = 0; l < lg.probes.length; l++) {
      const p = lg.probes[l]!;
      p.near = false;
      p.s.inContact = false;
      p.s.hasAnchor = false;
      p.s.wet = false;
      lg.state.contact[l] = false;
      lg.state.compression[l] = 0;
    }
  }
  for (let i = 0; i < st.buoy.length; i++) st.carried.buoyWet[i] = false;
}

const nrm = [0, 0, 0];
const anc = [0, 0, 0];

/**
 * Contact and buoyancy forces for the rigid-body state `b`. `qf` is BCBF -> BCI at the evaluation time.
 * First-contact crash checks append to out.crashedParts / out.collapsedLegs and emit touchdown / splash
 * events.
 */
export function evalContact(vessel: Vessel, st: Structure, env: VesselEnvironment, b: BodyState, qf: Quat, ut: number, events: SimEvent[], out: ContactOut): void {
  out.fx = out.fy = out.fz = out.tx = out.ty = out.tz = 0;
  out.maxForce = 0;
  out.anyContact = false;
  out.submergedVolume = 0;
  const com = vessel.mp.com;
  const mass = vessel.mp.mass;
  const m = b.m;
  const sp = env.spin;
  const kDef = PROBE_STIFFNESS * (mass / PROBE_REFERENCE_MASS);
  const cDef = 2 * PROBE_DAMPING_RATIO * Math.sqrt((kDef * mass) / 4);

  const doProbe = (pr: Probe): void => {
    if (!pr.near) return;
    const lx = pr.x - com.x;
    const ly = pr.y - com.y;
    const lz = pr.z - com.z;
    // Lever and point in BCI.
    const Lx = m[0]! * lx + m[1]! * ly + m[2]! * lz;
    const Ly = m[3]! * lx + m[4]! * ly + m[5]! * lz;
    const Lz = m[6]! * lx + m[7]! * ly + m[8]! * lz;
    const px = b.rx + Lx;
    const py = b.ry + Ly;
    const pz = b.rz + Lz;
    const pl = Math.sqrt(px * px + py * py + pz * pz);
    const upx = px / pl;
    const upy = py / pl;
    const upz = pz / pl;
    // Velocity of the point relative to the rotating ground.
    const cxv = b.wy * lz - b.wz * ly;
    const cyv = b.wz * lx - b.wx * lz;
    const czv = b.wx * ly - b.wy * lx;
    const vx = b.vx + m[0]! * cxv + m[1]! * cyv + m[2]! * czv - (sp.y * pz - sp.z * py);
    const vy = b.vy + m[3]! * cxv + m[4]! * cyv + m[5]! * czv - (sp.z * px - sp.x * pz);
    const vz = b.vz + m[6]! * cxv + m[7]! * cyv + m[8]! * czv - (sp.x * py - sp.y * px);

    // Water entry (crash check only; buoyancy comes from the spheres).
    if (st.waterHere) {
      const wet = pl - env.radius - st.waterHeight < 0;
      if (wet && !pr.s.wet) {
        const closing = -(vx * upx + vy * upy + vz * upz);
        if (closing > pr.crashWater) addCrash(pr, out);
      }
      pr.s.wet = wet;
    }

    rotInvQ(qf, upx, upy, upz, tmp);
    dirObj.x = tmp[0]!;
    dirObj.y = tmp[1]!;
    dirObj.z = tmp[2]!;
    const depth = env.radius + env.terrainHeight(dirObj) + pr.radius - pl;
    const lg = pr.legs;
    if (depth <= 0) {
      if (pr.s.inContact) {
        pr.s.inContact = false;
        pr.s.hasAnchor = false;
        if (lg) {
          lg.state.contact[pr.leg] = false;
          lg.state.compression[pr.leg] = 0;
        }
      }
      return;
    }
    if (!pr.hasNormal) {
      const n = env.terrainNormal(dirObj);
      rotQ(qf, n.x, n.y, n.z, nrm);
      pr.nx = nrm[0]!;
      pr.ny = nrm[1]!;
      pr.nz = nrm[2]!;
      pr.hasNormal = true;
    }
    const nx = pr.nx;
    const ny = pr.ny;
    const nz = pr.nz;
    const nUp = nx * upx + ny * upy + nz * upz;
    const dn = depth * nUp;
    const vn = vx * nx + vy * ny + vz * nz;
    const tvx = vx - vn * nx;
    const tvy = vy - vn * ny;
    const tvz = vz - vn * nz;

    if (!pr.s.inContact) {
      // First contact: the touchdown event, then the crash tolerances.
      const closing = -vn;
      const lateral = Math.sqrt(tvx * tvx + tvy * tvy + tvz * tvz);
      if (vessel.airborneTime > 0.5 && !out.anyContact && !vessel.contact.anyContact) {
        events.push({ type: 'touchdown', ut, vesselId: vessel.id, speed: Math.sqrt(vx * vx + vy * vy + vz * vz), surface: 'land', partId: eventPartId(vessel, vessel.parts[pr.part]!) });
        vessel.airborneTime = 0;
      }
      if (lg) {
        if (closing > pr.crash || lateral > LEG_LATERAL_TOLERANCE_RATIO * pr.crash) {
          out.collapsedLegs.push({ probe: pr });
          return;
        }
      } else if (closing > pr.crash) {
        addCrash(pr, out);
        return;
      }
      pr.s.inContact = true;
    }

    // Normal force.
    let fn: number;
    let kt: number;
    let ct: number;
    if (lg) {
      const legDef = lg.def.legs[pr.leg]!;
      const sv = lg.strut[pr.leg]!;
      const sx = m[0]! * sv.x + m[1]! * sv.y + m[2]! * sv.z;
      const sy = m[3]! * sv.x + m[4]! * sv.y + m[5]! * sv.z;
      const sz = m[6]! * sv.x + m[7]! * sv.y + m[8]! * sv.z;
      let un = sx * nx + sy * ny + sz * nz;
      if (un < 0.3) un = 0.3;
      const s = dn / un;
      const sDot = -vn / un;
      // Asymmetric damper: the strut resists extension harder than compression, so it does not kick back.
      let fa = legDef.preload * Math.min(1, s / 0.01) + legDef.k * s + legDef.c * (sDot >= 0 ? sDot : LEG_REBOUND_DAMPING_FACTOR * sDot);
      if (s > legDef.stroke) {
        fa += LEG_BOTTOM_STIFFNESS * (s - legDef.stroke);
        if (s > legDef.stroke + LEG_OVERSTROKE) {
          out.collapsedLegs.push({ probe: pr });
          return;
        }
      }
      if (fa < 0) fa = 0;
      fn = fa * un;
      lg.state.contact[pr.leg] = true;
      lg.state.compression[pr.leg] = Math.min(s, legDef.stroke);
      kt = legDef.k * LEG_LATERAL_STIFFNESS_FACTOR;
      ct = legDef.c;
    } else {
      const k = Number.isNaN(pr.k) ? kDef : pr.k;
      const c = Number.isNaN(pr.c) ? cDef : pr.c;
      fn = k * dn - c * vn;
      if (fn < 0) fn = 0;
      kt = k;
      ct = c;
    }

    // Friction toward the anchor.
    let ftx = 0;
    let fty = 0;
    let ftz = 0;
    if (!pr.s.hasAnchor) {
      rotInvQ(qf, px, py, pz, anc);
      pr.s.ax = anc[0]!;
      pr.s.ay = anc[1]!;
      pr.s.az = anc[2]!;
      pr.s.hasAnchor = true;
    }
    rotQ(qf, pr.s.ax, pr.s.ay, pr.s.az, anc);
    let dx = px - anc[0]!;
    let dy = py - anc[1]!;
    let dz = pz - anc[2]!;
    const dnn = dx * nx + dy * ny + dz * nz;
    dx -= dnn * nx;
    dy -= dnn * ny;
    dz -= dnn * nz;
    ftx = -kt * dx - ct * tvx;
    fty = -kt * dy - ct * tvy;
    ftz = -kt * dz - ct * tvz;
    const mu = Number.isNaN(pr.mu) ? env.surfaceFriction : pr.mu;
    const cap = mu * fn;
    const ft = Math.sqrt(ftx * ftx + fty * fty + ftz * ftz);
    if (ft > cap) {
      const sc = ft > 0 ? cap / ft : 0;
      ftx *= sc;
      fty *= sc;
      ftz *= sc;
      // Slide: move the anchor so that the spring alone carries at most the friction limit.
      const dl = Math.sqrt(dx * dx + dy * dy + dz * dz);
      const keep = dl > 0 ? Math.min(1, cap / (kt * dl)) : 0;
      rotInvQ(qf, px - dx * keep, py - dy * keep, pz - dz * keep, anc);
      pr.s.ax = anc[0]!;
      pr.s.ay = anc[1]!;
      pr.s.az = anc[2]!;
    }
    const fx = fn * nx + ftx;
    const fy = fn * ny + fty;
    const fz = fn * nz + ftz;
    out.fx += fx;
    out.fy += fy;
    out.fz += fz;
    // Torque in VES: l x (R^T F).
    const bx = m[0]! * fx + m[3]! * fy + m[6]! * fz;
    const by = m[1]! * fx + m[4]! * fy + m[7]! * fz;
    const bz = m[2]! * fx + m[5]! * fy + m[8]! * fz;
    out.tx += ly * bz - lz * by;
    out.ty += lz * bx - lx * bz;
    out.tz += lx * by - ly * bx;
    if (fn > out.maxForce) out.maxForce = fn;
    out.anyContact = true;
  };

  for (let i = 0; i < st.probes.length; i++) doProbe(st.probes[i]!);
  for (let i = 0; i < st.legs.length; i++) {
    const lg = st.legs[i]!;
    for (let l = 0; l < lg.probes.length; l++) if (legActive(lg.probes[l]!)) doProbe(lg.probes[l]!);
  }

  // Buoyancy and slam drag.
  if (st.waterHere && env.ocean !== null && st.buoy.length > 0) {
    const rhoW = env.ocean.density;
    for (let i = 0; i < st.buoy.length; i++) {
      const s = st.buoy[i]!;
      const lx = s.x - com.x;
      const ly = s.y - com.y;
      const lz = s.z - com.z;
      const Lx = m[0]! * lx + m[1]! * ly + m[2]! * lz;
      const Ly = m[3]! * lx + m[4]! * ly + m[5]! * lz;
      const Lz = m[6]! * lx + m[7]! * ly + m[8]! * lz;
      const px = b.rx + Lx;
      const py = b.ry + Ly;
      const pz = b.rz + Lz;
      const pl = Math.sqrt(px * px + py * py + pz * pz);
      const a = s.radius;
      let h = env.radius + s.waterHeight - pl + a;
      if (h <= 0) {
        st.carried.buoyWet[i] = false;
        continue;
      }
      if (h > 2 * a) h = 2 * a;
      const upx = px / pl;
      const upy = py / pl;
      const upz = pz / pl;
      const cxv = b.wy * lz - b.wz * ly;
      const cyv = b.wz * lx - b.wx * lz;
      const czv = b.wx * ly - b.wy * lx;
      const vx = b.vx + m[0]! * cxv + m[1]! * cyv + m[2]! * czv - (sp.y * pz - sp.z * py);
      const vy = b.vy + m[3]! * cxv + m[4]! * cyv + m[5]! * czv - (sp.z * px - sp.x * pz);
      const vz = b.vz + m[6]! * cxv + m[7]! * cyv + m[8]! * czv - (sp.x * py - sp.y * px);
      const speed = Math.sqrt(vx * vx + vy * vy + vz * vz);
      if (!st.carried.buoyWet[i]) {
        st.carried.buoyWet[i] = true;
        if (!vessel.inWater) {
          vessel.inWater = true;
          events.push({ type: 'splash', ut, vesselId: vessel.id, speed });
        }
      }
      const V = (Math.PI * h * h * (3 * a - h)) / 3;
      out.submergedVolume += V;
      const g = env.mu / (pl * pl);
      const fb = rhoW * g * V;
      // Quadratic slam drag plus a linear term standing in for wave-radiation damping of the floating body.
      const kd = -0.5 * rhoW * WATER_DRAG_CD * Math.PI * a * a * (V / s.volume) * speed - WATER_LINEAR_DAMPING * rhoW * V * Math.sqrt(g / a);
      const fx = fb * upx + kd * vx;
      const fy = fb * upy + kd * vy;
      const fz = fb * upz + kd * vz;
      out.fx += fx;
      out.fy += fy;
      out.fz += fz;
      const bx = m[0]! * fx + m[3]! * fy + m[6]! * fz;
      const by = m[1]! * fx + m[4]! * fy + m[7]! * fz;
      const bz = m[2]! * fx + m[5]! * fy + m[8]! * fz;
      out.tx += ly * bz - lz * by;
      out.ty += lz * bx - lx * bz;
      out.tz += lx * by - ly * bx;
    }
  }
}

function addCrash(pr: Probe, out: ContactOut): void {
  if (out.crashedParts.indexOf(pr.part) < 0) out.crashedParts.push(pr.part);
}
