/**
 * The fixed-step vessel integrator (sim-design 4.2):
 *
 *   1. delayed stage actions; controls -> SAS -> actuator commands; engine spool, gimbal servo, RCS
 *   2. mass properties
 *   3. RK4 on the CoM with gravity + thrust + aerodynamics + parachutes (thrust and attitude held, aero
 *      re-evaluated at every stage)
 *   4. attitude with the semi-implicit rigid-body update
 *   5. instead of 3-4, when any probe is within 5 m of ground or water: 4 sub-steps of semi-implicit
 *      Euler with all forces plus penalty contact and buoyancy
 *   6. propellant consumption and flame-out (inside the engine update)
 *   7. thermal step, g-load and dose, failure checks, sleep detection
 *
 * `env` describes the world at the START of the step (env.ut). Every vessel in the physics bubble is
 * stepped with this function; debris gets NEUTRAL_CONTROLS.
 */
import type { ControlInputs } from '@/core/contracts/controls';
import type { SimEvent } from '@/core/contracts/sim';
import type { VesselEnvironment } from '@/core/contracts/simInternal';
import { mat3 } from '@/core/math/mat';
import { quat, type Quat } from '@/core/math/quat';
import { DEG, G0 } from '@/core/math/scalar';
import { applyActuators, computeAuthority, rcsTranslationActive } from '../control/allocation';
import { sasOut, sasUpdate } from '../control/sas';
import { computeMassProps } from '../vessel/massProps';
import { updateEngines } from '../vessel/modules/engine';
import { legsMoving, updateLegs } from '../vessel/modules/legs';
import { updateParachutes } from '../vessel/modules/parachute';
import { eventPartId } from '../vessel/ids';
import { anyPending, processPending } from '../vessel/staging';
import { structureOf, type Structure } from '../vessel/structure';
import type { StepContext, StepResult, Vessel } from '../vessel/types';
import { aeroOut, evalAero, hasLiftingCapsule, refreshAeroCoefficients } from './aero';
import { contactBroadphase, contactOut, evalContact, noContactBroadphase, type BodyState, type ContactOut } from './contact';
import { checkLoads, collapseLegs, destroyParts } from './failure';
import { stepThermal } from './thermal';

export const CONTACT_SUBSTEPS = 4;
export const G_FILTER_TAU = 0.1;
export const SLEEP_SPEED = 0.05;
export const SLEEP_RATE = 0.2 * DEG;
export const SLEEP_TIME = 2.0;
export const SPLASH_SPEED = 1.0;
export const SPLASH_TIME = 3.0;
/** Lift direction is reported above this dynamic pressure, Pa. */
const LIFT_MIN_Q = 10;

// Scratch shared by the acceleration function (single-threaded, not re-entrant).
let sEnv: VesselEnvironment;
let sVessel: Vessel;
let sSt: Structure;
let sM: number[];
let sInAir = false;
let sBfx = 0;
let sBfy = 0;
let sBfz = 0;
let sInvMass = 0;
const acc = [0, 0, 0];
const body: BodyState = { rx: 0, ry: 0, rz: 0, vx: 0, vy: 0, vz: 0, m: [1, 0, 0, 0, 1, 0, 0, 0, 1], wx: 0, wy: 0, wz: 0 };
const overheated: number[] = [];
/** Where the touchdown and splash events of a predict-mode step go (ARCHITECTURE 6.4: never predicted). */
const unconfirmed: SimEvent[] = [];
// The island's reference point for the step in hand (VesselEnvironment.origin): its state and acceleration
// at the step start, and the time into the step of the evaluation in hand. Unused without an origin.
let sOrigin = false;
let sTau = 0;
let sRx = 0;
let sRy = 0;
let sRz = 0;
let sRVx = 0;
let sRVy = 0;
let sRVz = 0;
let sRAx = 0;
let sRAy = 0;
let sRAz = 0;

/** How a step is taken (ARCHITECTURE 6.2, 6.4, 7.4). Absent = exactly v1's step. */
export interface StepOptions {
  /** 'predict' suppresses threshold transitions: nothing is destroyed, no joint breaks, no canopy fails, no touchdown is confirmed. Default 'authoritative'. */
  mode?: 'authoritative' | 'predict';
  /** The vessel's pair is inside the speculative-contact margin: the step takes the sub-stepped path whatever its own probes say. */
  pairContact?: boolean;
  /**
   * The island's lockstep: called once, when the vessel is ready for its sub-steps, with the run that holds
   * them. The callee runs `substepForces` and `substepIntegrate` for every sub-step of this run (and of the
   * runs of the other vessels of the group, which it may start from inside this call, each with its own
   * `stepVessel`); the step finishes when it returns. Absent = the vessel sub-steps alone.
   */
  lockstep?: (run: SubstepRun) => void;
  /** Collect the structural changes of the step in `StepResult.records`. */
  records?: boolean;
}

/**
 * One vessel's sub-stepped step between two sub-steps: what `substepForces` evaluates and
 * `substepIntegrate` advances. The pair pass reads and changes `body` (the centre of mass in the frame of
 * the step, the rotation matrix VES -> frame, the body rate in VES) and the totals `Fx..Tz` in between.
 */
export interface SubstepRun {
  vessel: Vessel;
  st: Structure;
  env: VesselEnvironment;
  events: SimEvent[];
  /** Length of one sub-step, s, and the number of sub-steps of the step. */
  h: number;
  count: number;
  inAir: boolean;
  rho: number;
  /** Body-fixed force and torque about the centre of mass held over the step (VES). */
  bfx: number;
  bfy: number;
  bfz: number;
  btx: number;
  bty: number;
  btz: number;
  invMass: number;
  body: BodyState;
  q: Quat;
  /** Non-gravitational force of the sub-step in hand (frame axes, N) and torque about the centre of mass (VES axes, N m). */
  Fx: number;
  Fy: number;
  Fz: number;
  Tx: number;
  Ty: number;
  Tz: number;
  sumx: number;
  sumy: number;
  sumz: number;
  maxForce: number;
  any: boolean;
  submerged: number;
  out: ContactOut;
  /** The state is an offset from the island's reference point: its state and acceleration at the step start. */
  offset: boolean;
  ox: number;
  oy: number;
  oz: number;
  ovx: number;
  ovy: number;
  ovz: number;
  oax: number;
  oay: number;
  oaz: number;
}

function newRun(own: boolean): SubstepRun {
  return {
    vessel: null as unknown as Vessel,
    st: null as unknown as Structure,
    env: null as unknown as VesselEnvironment,
    events: unconfirmed,
    h: 0,
    count: CONTACT_SUBSTEPS,
    inAir: false,
    rho: 0,
    bfx: 0,
    bfy: 0,
    bfz: 0,
    btx: 0,
    bty: 0,
    btz: 0,
    invMass: 0,
    body: own ? { rx: 0, ry: 0, rz: 0, vx: 0, vy: 0, vz: 0, m: [1, 0, 0, 0, 1, 0, 0, 0, 1], wx: 0, wy: 0, wz: 0 } : body,
    q: { x: 0, y: 0, z: 0, w: 1 },
    Fx: 0,
    Fy: 0,
    Fz: 0,
    Tx: 0,
    Ty: 0,
    Tz: 0,
    sumx: 0,
    sumy: 0,
    sumz: 0,
    maxForce: 0,
    any: false,
    submerged: 0,
    out: own ? { fx: 0, fy: 0, fz: 0, tx: 0, ty: 0, tz: 0, maxForce: 0, anyContact: false, submergedVolume: 0, crashedParts: [], collapsedLegs: [] } : contactOut,
    offset: false,
    ox: 0,
    oy: 0,
    oz: 0,
    ovx: 0,
    ovy: 0,
    ovz: 0,
    oax: 0,
    oay: 0,
    oaz: 0,
  };
}
/** The run of a vessel that sub-steps alone: the module's own scratch, as before the lockstep existed. */
const soloRun = newRun(false);

/**
 * Battin's form of the gravity difference of Encke's method (ARCHITECTURE section 4): the acceleration of a
 * point at offset p from a reference point at R, both attracted by mu at the origin, less the acceleration of
 * the reference point, evaluated without the cancellation of two nearly equal vectors. With
 * q = p.(p + 2R) / R.R and s = (1 + q)^(3/2): -mu / (|R|^3 s) x (p - F R), F = s - 1 = q (3 + 3q + q^2) / (1 + s).
 */
export function gravityDifference(mu: number, Rx: number, Ry: number, Rz: number, px: number, py: number, pz: number, out: number[]): void {
  const R2 = Rx * Rx + Ry * Ry + Rz * Rz;
  const q = (px * (px + 2 * Rx) + py * (py + 2 * Ry) + pz * (pz + 2 * Rz)) / R2;
  const s = Math.pow(1 + q, 1.5);
  const F = (q * (3 + q * (3 + q))) / (1 + s);
  const k = -mu / (R2 * Math.sqrt(R2) * s);
  out[0] = k * (px - F * Rx);
  out[1] = k * (py - F * Ry);
  out[2] = k * (pz - F * Rz);
}
const gd = [0, 0, 0];

/** Acceleration of the CoM at (p, v): gravity + held body force + aerodynamics re-evaluated for v. */
function accel(px: number, py: number, pz: number, vx: number, vy: number, vz: number): void {
  if (sOrigin) {
    accelOffset(px, py, pz, vx, vy, vz);
    return;
  }
  const r2 = px * px + py * py + pz * pz;
  const r1 = Math.sqrt(r2);
  const k = -sEnv.mu / (r2 * r1);
  let ax = k * px + sBfx * sInvMass;
  let ay = k * py + sBfy * sInvMass;
  let az = k * pz + sBfz * sInvMass;
  if (sInAir) {
    const rho = sEnv.atmosphereAt(r1 - sEnv.radius).density;
    if (rho > 0) {
      const sp = sEnv.spin;
      const ux = vx - (sp.y * pz - sp.z * py);
      const uy = vy - (sp.z * px - sp.x * pz);
      const uz = vz - (sp.x * py - sp.y * px);
      const m = sM;
      const w = sVessel.w;
      evalAero(sVessel, sSt, rho, m[0]! * ux + m[3]! * uy + m[6]! * uz, m[1]! * ux + m[4]! * uy + m[7]! * uz, m[2]! * ux + m[5]! * uy + m[8]! * uz, w.x, w.y, w.z, aeroOut);
      ax += (m[0]! * aeroOut.fx + m[1]! * aeroOut.fy + m[2]! * aeroOut.fz) * sInvMass;
      ay += (m[3]! * aeroOut.fx + m[4]! * aeroOut.fy + m[5]! * aeroOut.fz) * sInvMass;
      az += (m[6]! * aeroOut.fx + m[7]! * aeroOut.fy + m[8]! * aeroOut.fz) * sInvMass;
    }
  }
  acc[0] = ax;
  acc[1] = ay;
  acc[2] = az;
}

/**
 * The same for a state that is an OFFSET from the island's reference point: gravity is the difference
 * between the acceleration at the vessel and at the reference point, which moves on its own orbit during
 * the step (to second order in the time into the step, which is exact to far below a nanometre for a step
 * of 1/120 s on any orbit about the star).
 */
function accelOffset(px: number, py: number, pz: number, vx: number, vy: number, vz: number): void {
  const t = sTau;
  const Rx = sRx + (sRVx + 0.5 * sRAx * t) * t;
  const Ry = sRy + (sRVy + 0.5 * sRAy * t) * t;
  const Rz = sRz + (sRVz + 0.5 * sRAz * t) * t;
  gravityDifference(sEnv.mu, Rx, Ry, Rz, px, py, pz, gd);
  let ax = gd[0]! + sBfx * sInvMass;
  let ay = gd[1]! + sBfy * sInvMass;
  let az = gd[2]! + sBfz * sInvMass;
  if (sInAir) {
    const qx = Rx + px;
    const qy = Ry + py;
    const qz = Rz + pz;
    const rho = sEnv.atmosphereAt(Math.sqrt(qx * qx + qy * qy + qz * qz) - sEnv.radius).density;
    if (rho > 0) {
      const sp = sEnv.spin;
      const ux = sRVx + sRAx * t + vx - (sp.y * qz - sp.z * qy);
      const uy = sRVy + sRAy * t + vy - (sp.z * qx - sp.x * qz);
      const uz = sRVz + sRAz * t + vz - (sp.x * qy - sp.y * qx);
      const m = sM;
      const w = sVessel.w;
      evalAero(sVessel, sSt, rho, m[0]! * ux + m[3]! * uy + m[6]! * uz, m[1]! * ux + m[4]! * uy + m[7]! * uz, m[2]! * ux + m[5]! * uy + m[8]! * uz, w.x, w.y, w.z, aeroOut);
      ax += (m[0]! * aeroOut.fx + m[1]! * aeroOut.fy + m[2]! * aeroOut.fz) * sInvMass;
      ay += (m[3]! * aeroOut.fx + m[4]! * aeroOut.fy + m[5]! * aeroOut.fz) * sInvMass;
      az += (m[6]! * aeroOut.fx + m[7]! * aeroOut.fy + m[8]! * aeroOut.fz) * sInvMass;
    }
  }
  acc[0] = ax;
  acc[1] = ay;
  acc[2] = az;
}

/**
 * Forces of sub-step `i` of a run: the held body force, aerodynamics for the current sub-state and the
 * ground contact and buoyancy. Leaves the totals in `Fx..Tz`; nothing is integrated.
 */
export function substepForces(run: SubstepRun, i: number): void {
  const b = run.body;
  const bm = b.m;
  const env = run.env;
  const sp = env.spin;
  const tau = i * run.h;
  const qf = tau === 0 ? env.qFixedToInertial : quat.mul(quat.fromRotVec({ x: sp.x * tau, y: sp.y * tau, z: sp.z * tau }), env.qFixedToInertial);
  // Aerodynamics for the current sub-state (density of the step start; the vessel is within metres of the surface).
  let fx = run.bfx;
  let fy = run.bfy;
  let fz = run.bfz;
  let tx = run.btx;
  let ty = run.bty;
  let tz = run.btz;
  const out = run.out;
  if (run.offset) {
    // Offsets from the island's reference point: far from every surface (the island drops its reference
    // before a member comes near one), so there is no ground and no water to touch.
    if (run.inAir) {
      const Rx = run.ox + (run.ovx + 0.5 * run.oax * tau) * tau;
      const Ry = run.oy + (run.ovy + 0.5 * run.oay * tau) * tau;
      const Rz = run.oz + (run.ovz + 0.5 * run.oaz * tau) * tau;
      const qx = Rx + b.rx;
      const qy = Ry + b.ry;
      const qz = Rz + b.rz;
      const ux = run.ovx + run.oax * tau + b.vx - (sp.y * qz - sp.z * qy);
      const uy = run.ovy + run.oay * tau + b.vy - (sp.z * qx - sp.x * qz);
      const uz = run.ovz + run.oaz * tau + b.vz - (sp.x * qy - sp.y * qx);
      evalAero(run.vessel, run.st, run.rho, bm[0]! * ux + bm[3]! * uy + bm[6]! * uz, bm[1]! * ux + bm[4]! * uy + bm[7]! * uz, bm[2]! * ux + bm[5]! * uy + bm[8]! * uz, b.wx, b.wy, b.wz, aeroOut);
      fx += aeroOut.fx;
      fy += aeroOut.fy;
      fz += aeroOut.fz;
      tx += aeroOut.tx;
      ty += aeroOut.ty;
      tz += aeroOut.tz;
    }
    out.fx = out.fy = out.fz = out.tx = out.ty = out.tz = 0;
    out.maxForce = 0;
    out.anyContact = false;
    out.submergedVolume = 0;
  } else {
    if (run.inAir) {
      const ux = b.vx - (sp.y * b.rz - sp.z * b.ry);
      const uy = b.vy - (sp.z * b.rx - sp.x * b.rz);
      const uz = b.vz - (sp.x * b.ry - sp.y * b.rx);
      evalAero(run.vessel, run.st, run.rho, bm[0]! * ux + bm[3]! * uy + bm[6]! * uz, bm[1]! * ux + bm[4]! * uy + bm[7]! * uz, bm[2]! * ux + bm[5]! * uy + bm[8]! * uz, b.wx, b.wy, b.wz, aeroOut);
      fx += aeroOut.fx;
      fy += aeroOut.fy;
      fz += aeroOut.fz;
      tx += aeroOut.tx;
      ty += aeroOut.ty;
      tz += aeroOut.tz;
    }
    evalContact(run.vessel, run.st, env, b, qf, env.ut, run.events, out);
  }
  // Total non-gravitational force in the frame's axes.
  run.Fx = bm[0]! * fx + bm[1]! * fy + bm[2]! * fz + out.fx;
  run.Fy = bm[3]! * fx + bm[4]! * fy + bm[5]! * fz + out.fy;
  run.Fz = bm[6]! * fx + bm[7]! * fy + bm[8]! * fz + out.fz;
  run.Tx = tx + out.tx;
  run.Ty = ty + out.ty;
  run.Tz = tz + out.tz;
  if (out.maxForce > run.maxForce) run.maxForce = out.maxForce;
  if (out.anyContact) run.any = true;
  run.submerged = out.submergedVolume;
}

/** Integrate sub-step `i` of a run with the totals in `Fx..Tz` (semi-implicit Euler; gravity of the sub-state). */
export function substepIntegrate(run: SubstepRun, i: number): void {
  const b = run.body;
  const bm = b.m;
  const h = run.h;
  const Fx = run.Fx;
  const Fy = run.Fy;
  const Fz = run.Fz;
  run.sumx += bm[0]! * Fx + bm[3]! * Fy + bm[6]! * Fz;
  run.sumy += bm[1]! * Fx + bm[4]! * Fy + bm[7]! * Fz;
  run.sumz += bm[2]! * Fx + bm[5]! * Fy + bm[8]! * Fz;
  const invMass = run.invMass;
  if (run.offset) {
    const tau = i * h;
    gravityDifference(run.env.mu, run.ox + (run.ovx + 0.5 * run.oax * tau) * tau, run.oy + (run.ovy + 0.5 * run.oay * tau) * tau, run.oz + (run.ovz + 0.5 * run.oaz * tau) * tau, b.rx, b.ry, b.rz, gd);
    b.vx += (gd[0]! + Fx * invMass) * h;
    b.vy += (gd[1]! + Fy * invMass) * h;
    b.vz += (gd[2]! + Fz * invMass) * h;
  } else {
    const r2 = b.rx * b.rx + b.ry * b.ry + b.rz * b.rz;
    const kg = -run.env.mu / (r2 * Math.sqrt(r2));
    b.vx += (kg * b.rx + Fx * invMass) * h;
    b.vy += (kg * b.ry + Fy * invMass) * h;
    b.vz += (kg * b.rz + Fz * invMass) * h;
  }
  integrateRate(run.vessel, run.Tx, run.Ty, run.Tz, h, 1, b);
  b.rx += b.vx * h;
  b.ry += b.vy * h;
  b.rz += b.vz * h;
  run.q = quat.normalize(quat.mul(run.q, quat.fromRotVec({ x: b.wx * h, y: b.wy * h, z: b.wz * h })));
  b.m = mat3.fromQuat(run.q) as number[];
}

/** Semi-implicit rigid-body rate update: w' = w + dt I^-1 (tau - wm x I wm) with the mid-point rate, fixed-point iterated. */
function integrateRate(vessel: Vessel, tx: number, ty: number, tz: number, dt: number, iterations: number, out: BodyState): void {
  const I = vessel.mp.i;
  const J = vessel.mp.inv;
  const w0x = out.wx;
  const w0y = out.wy;
  const w0z = out.wz;
  let wx = w0x;
  let wy = w0y;
  let wz = w0z;
  for (let it = 0; it <= iterations; it++) {
    const mx = 0.5 * (w0x + wx);
    const my = 0.5 * (w0y + wy);
    const mz = 0.5 * (w0z + wz);
    const hx = I[0] * mx + I[3] * my + I[4] * mz;
    const hy = I[3] * mx + I[1] * my + I[5] * mz;
    const hz = I[4] * mx + I[5] * my + I[2] * mz;
    const nx = tx - (my * hz - mz * hy);
    const ny = ty - (mz * hx - mx * hz);
    const nz = tz - (mx * hy - my * hx);
    wx = w0x + dt * (J[0] * nx + J[3] * ny + J[4] * nz);
    wy = w0y + dt * (J[3] * nx + J[1] * ny + J[5] * nz);
    wz = w0z + dt * (J[4] * nx + J[5] * ny + J[2] * nz);
  }
  out.wx = wx;
  out.wy = wy;
  out.wz = wz;
}

function captureAnchor(vessel: Vessel, env: VesselEnvironment): void {
  vessel.anchor = {
    rFixed: quat.rotateInv(env.qFixedToInertial, vessel.r),
    qFixed: quat.normalize(quat.mul(quat.conj(env.qFixedToInertial), vessel.q)),
  };
}

/** Place a held vessel rigidly on the rotating body at time env.ut + dt. */
export function rideBody(vessel: Vessel, env: VesselEnvironment, dt: number): void {
  if (!vessel.anchor) captureAnchor(vessel, env);
  const a = vessel.anchor!;
  const sp = env.spin;
  const qf = dt === 0 ? env.qFixedToInertial : quat.mul(quat.fromRotVec({ x: sp.x * dt, y: sp.y * dt, z: sp.z * dt }), env.qFixedToInertial);
  const r = quat.rotate(qf, a.rFixed);
  vessel.r.x = r.x;
  vessel.r.y = r.y;
  vessel.r.z = r.z;
  vessel.v.x = sp.y * r.z - sp.z * r.y;
  vessel.v.y = sp.z * r.x - sp.x * r.z;
  vessel.v.z = sp.x * r.y - sp.y * r.x;
  vessel.q = quat.normalize(quat.mul(qf, a.qFixed));
  const w = quat.rotateInv(vessel.q, sp);
  vessel.w.x = w.x;
  vessel.w.y = w.y;
  vessel.w.z = w.z;
}

/**
 * Fix a vessel to the ground where it stands (used by the orchestrator after placing a landed vessel).
 * `kind` 'asleep' wakes on thrust or staging; a vessel assembled with launch clamps is held as 'clamps'.
 */
export function holdOnGround(vessel: Vessel, env: VesselEnvironment, kind: 'asleep' | 'ground' = 'asleep'): void {
  if (vessel.hold === null) {
    vessel.hold = kind;
    vessel.surface = 'landed';
  }
  captureAnchor(vessel, env);
  rideBody(vessel, env, 0);
}

function wantsThrust(vessel: Vessel, st: Structure, controls: ControlInputs): boolean {
  for (let i = 0; i < st.engines.length; i++) {
    const e = st.engines[i]!;
    if (e.rt.lit || e.state.throttleActual > 0) return true;
    if (e.state.active && !e.state.flameout && (e.def.fixedBurn ? e.rt.started && e.rt.burnLeft > 0 : controls.throttle > 0)) return true;
  }
  return rcsTranslationActive(vessel, controls.translate);
}

export function stepVessel(vessel: Vessel, env: VesselEnvironment, controls: ControlInputs, dt: number, opts?: StepOptions): StepResult {
  const predict = opts !== undefined && opts.mode === 'predict';
  const ctx: StepContext = { ut: env.ut, env, instant: false, events: [], spawned: [], path: 'none', probeNear: false };
  if (predict) ctx.predict = true;
  if (opts !== undefined && opts.records) ctx.records = [];
  vessel.age += dt;
  vessel.stepCount++;
  processPending(vessel, dt, ctx);
  if (vessel.destroyed || vessel.parts.length === 0) return ctx;
  const st = structureOf(vessel);
  const lever = controls.throttle < 0 ? 0 : controls.throttle > 1 ? 1 : Number.isFinite(controls.throttle) ? controls.throttle : 0;
  vessel.throttle = lever;
  computeMassProps(vessel);
  const mp = vessel.mp;
  const com = mp.com;
  if (!(mp.mass > 0)) return ctx;

  if (vessel.hold === 'asleep' && wantsThrust(vessel, st, controls)) {
    vessel.hold = null;
    vessel.anchor = null;
    vessel.restTimer = 0;
  }
  if (vessel.hold !== null && !vessel.anchor) captureAnchor(vessel, env);

  // ------------------------------------------------------------------ ambient conditions at the CoM
  const m = mat3.fromQuat(vessel.q) as number[];
  const w = vessel.w;
  const r = vessel.r;
  const v = vessel.v;
  const lcx = m[0]! * com.x + m[1]! * com.y + m[2]! * com.z;
  const lcy = m[3]! * com.x + m[4]! * com.y + m[5]! * com.z;
  const lcz = m[6]! * com.x + m[7]! * com.y + m[8]! * com.z;
  const wcx = w.y * com.z - w.z * com.y;
  const wcy = w.z * com.x - w.x * com.z;
  const wcz = w.x * com.y - w.y * com.x;
  let rcx = r.x + lcx;
  let rcy = r.y + lcy;
  let rcz = r.z + lcz;
  let vcx = v.x + m[0]! * wcx + m[1]! * wcy + m[2]! * wcz;
  let vcy = v.y + m[3]! * wcx + m[4]! * wcy + m[5]! * wcz;
  let vcz = v.z + m[6]! * wcx + m[7]! * wcy + m[8]! * wcz;
  // The centre of mass about the body: the state itself, or the island's reference point plus the offset.
  const origin = env.origin;
  let arx = rcx;
  let ary = rcy;
  let arz = rcz;
  let avx = vcx;
  let avy = vcy;
  let avz = vcz;
  if (origin !== undefined) {
    arx = origin.r.x + rcx;
    ary = origin.r.y + rcy;
    arz = origin.r.z + rcz;
    avx = origin.v.x + vcx;
    avy = origin.v.y + vcy;
    avz = origin.v.z + vcz;
  }
  const rLen = Math.sqrt(arx * arx + ary * ary + arz * arz);
  const altitude = rLen - env.radius;
  const atm = env.atmosphereAt(altitude);
  const airTemp = atm.temperature;
  const sp = env.spin;
  const uax = avx - (sp.y * arz - sp.z * ary);
  const uay = avy - (sp.z * arx - sp.x * arz);
  const uaz = avz - (sp.x * ary - sp.y * arx);
  const speed = Math.sqrt(uax * uax + uay * uay + uaz * uaz);
  const rho = atm.density;
  const qDyn = 0.5 * rho * speed * speed;
  const mach = atm.speedOfSound > 0 ? speed / atm.speedOfSound : 0;
  // Air-relative velocity in VES and its unit vector.
  const vax = m[0]! * uax + m[3]! * uay + m[6]! * uaz;
  const vay = m[1]! * uax + m[4]! * uay + m[7]! * uaz;
  const vaz = m[2]! * uax + m[5]! * uay + m[8]! * uaz;
  const inv = speed > 1e-9 ? 1 / speed : 0;
  const hx = vax * inv;
  const hy = vay * inv;
  const hz = vaz * inv;
  const aero = vessel.aero;
  aero.q = qDyn;
  aero.mach = mach;
  aero.aoa = speed > 1e-3 ? Math.acos(hy < -1 ? -1 : hy > 1 ? 1 : hy) : 0;
  aero.density = rho;
  aero.pressure = atm.pressure;
  aero.temperature = atm.temperature;
  aero.airVelocity.x = uax;
  aero.airVelocity.y = uay;
  aero.airVelocity.z = uaz;
  const inAir = rho > 0;
  if (inAir) refreshAeroCoefficients(st, mach);

  // ------------------------------------------------------------------ modules, control, actuators
  if (st.legs.length > 0) updateLegs(vessel, st, dt);
  if (st.chutes.length > 0) updateParachutes(vessel, st, altitude, mach, speed, qDyn, hx, hy, hz, dt, env.ut, ctx.events, predict);
  computeAuthority(vessel, st);
  sasUpdate(vessel, st, controls, rho, qDyn, vax, vay, vaz, dt);
  const act = applyActuators(vessel, st, sasOut.ux, sasOut.uy, sasOut.uz, vessel.appliedControls.translate, dt, env.ut, ctx.events);
  const eng = updateEngines(vessel, st, lever, atm.pressure, dt, env.ut, ctx.events);
  vessel.thrust = eng.thrust + act.thrust;
  // Body-fixed force (VES) and torque about the CoM, held over the step.
  const bfx = eng.fx + act.fx;
  const bfy = eng.fy + act.fy;
  const bfz = eng.fz + act.fz;
  const btx = eng.tx + act.tx;
  const bty = eng.ty + act.ty;
  const btz = eng.tz + act.tz;
  const invMass = 1 / mp.mass;
  const gLocal = env.mu / (rLen * rLen);

  // ------------------------------------------------------------------ held vessels ride the body
  if (vessel.hold !== null) {
    rideBody(vessel, env, dt);
    aero.force.x = aero.force.y = aero.force.z = 0;
    aero.torque.x = aero.torque.y = aero.torque.z = 0;
    aero.liftDirVes = null;
    aero.heatFlux = 0;
    aero.plasmaIntensity = 0;
    // The ground carries the weight: proper acceleration = -gravity.
    const k = gLocal / rLen;
    vessel.properAccel.x = (m[0]! * arx + m[3]! * ary + m[6]! * arz) * k;
    vessel.properAccel.y = (m[1]! * arx + m[4]! * ary + m[7]! * arz) * k;
    vessel.properAccel.z = (m[2]! * arx + m[5]! * ary + m[8]! * arz) * k;
    vessel.gLoad += (gLocal / G0 - vessel.gLoad) * (1 - Math.exp(-dt / G_FILTER_TAU));
    vessel.contact.anyContact = true;
    vessel.contact.maxForce = mp.mass * gLocal;
    vessel.contact.waterSubmersion = 0;
    vessel.groundClearance = 0;
    vessel.airborneTime = 0;
    vessel.surface = vessel.hold === 'clamps' ? 'prelaunch' : 'landed';
    ctx.path = 'held';
    return ctx;
  }

  // ------------------------------------------------------------------ aerodynamics at the step start
  let afx = 0;
  let afy = 0;
  let afz = 0;
  let atx = 0;
  let aty = 0;
  let atz = 0;
  aero.liftDirVes = null;
  if (inAir) {
    evalAero(vessel, st, rho, vax, vay, vaz, w.x, w.y, w.z, aeroOut);
    afx = aeroOut.fx;
    afy = aeroOut.fy;
    afz = aeroOut.fz;
    atx = aeroOut.tx;
    aty = aeroOut.ty;
    atz = aeroOut.tz;
    if (qDyn > LIFT_MIN_Q && hasLiftingCapsule(st)) {
      const along = afx * hx + afy * hy + afz * hz;
      const lx = afx - along * hx;
      const ly = afy - along * hy;
      const lz = afz - along * hz;
      const ll = Math.sqrt(lx * lx + ly * ly + lz * lz);
      if (ll > 1e-6 * Math.abs(along) && ll > 0) aero.liftDirVes = { x: lx / ll, y: ly / ll, z: lz / ll };
    }
  }
  aero.force.x = afx;
  aero.force.y = afy;
  aero.force.z = afz;
  aero.torque.x = atx;
  aero.torque.y = aty;
  aero.torque.z = atz;

  // Non-gravitational force in VES for the g-load (averaged over sub-steps when in contact).
  let ngx = bfx + afx;
  let ngy = bfy + afy;
  let ngz = bfz + afz;

  const w0x = w.x;
  const w0y = w.y;
  const w0z = w.z;
  body.wx = w0x;
  body.wy = w0y;
  body.wz = w0z;
  let qNew: Quat = vessel.q;
  let mNew: number[] = m;
  // A state given as an offset from the island's reference point is far from every surface: no probe is asked.
  const probeNear = origin !== undefined ? noContactBroadphase(vessel, st) : contactBroadphase(vessel, st, env, dt);
  ctx.probeNear = probeNear;
  const near = probeNear || (opts !== undefined && opts.pairContact === true);
  let cOut: ContactOut = contactOut;
  if (st.buried && !predict) {
    // Entirely below the terrain (it got past the probes, e.g. at extreme speed): an impact.
    const all: number[] = [];
    for (let i = 0; i < vessel.parts.length; i++) all.push(i);
    destroyParts(vessel, all, 'impact', ctx);
    return ctx;
  }
  const contact = vessel.contact;

  if (!near) {
    // -------------------------------------------------------------- free flight: RK4 + attitude
    ctx.path = 'free';
    sOrigin = origin !== undefined;
    if (origin !== undefined) {
      sRx = origin.r.x;
      sRy = origin.r.y;
      sRz = origin.r.z;
      sRVx = origin.v.x;
      sRVy = origin.v.y;
      sRVz = origin.v.z;
      const o2 = sRx * sRx + sRy * sRy + sRz * sRz;
      const ok = -env.mu / (o2 * Math.sqrt(o2));
      sRAx = ok * sRx;
      sRAy = ok * sRy;
      sRAz = ok * sRz;
    }
    sTau = 0;
    sEnv = env;
    sVessel = vessel;
    sSt = st;
    sM = m;
    sInAir = inAir;
    sBfx = m[0]! * bfx + m[1]! * bfy + m[2]! * bfz;
    sBfy = m[3]! * bfx + m[4]! * bfy + m[5]! * bfz;
    sBfz = m[6]! * bfx + m[7]! * bfy + m[8]! * bfz;
    sInvMass = invMass;
    const h2 = dt / 2;
    accel(rcx, rcy, rcz, vcx, vcy, vcz);
    const k1x = acc[0]!;
    const k1y = acc[1]!;
    const k1z = acc[2]!;
    const v2x = vcx + k1x * h2;
    const v2y = vcy + k1y * h2;
    const v2z = vcz + k1z * h2;
    sTau = h2;
    accel(rcx + vcx * h2, rcy + vcy * h2, rcz + vcz * h2, v2x, v2y, v2z);
    const k2x = acc[0]!;
    const k2y = acc[1]!;
    const k2z = acc[2]!;
    const v3x = vcx + k2x * h2;
    const v3y = vcy + k2y * h2;
    const v3z = vcz + k2z * h2;
    accel(rcx + v2x * h2, rcy + v2y * h2, rcz + v2z * h2, v3x, v3y, v3z);
    const k3x = acc[0]!;
    const k3y = acc[1]!;
    const k3z = acc[2]!;
    const v4x = vcx + k3x * dt;
    const v4y = vcy + k3y * dt;
    const v4z = vcz + k3z * dt;
    sTau = dt;
    accel(rcx + v3x * dt, rcy + v3y * dt, rcz + v3z * dt, v4x, v4y, v4z);
    const s6 = dt / 6;
    rcx += s6 * (vcx + 2 * v2x + 2 * v3x + v4x);
    rcy += s6 * (vcy + 2 * v2y + 2 * v3y + v4y);
    rcz += s6 * (vcz + 2 * v2z + 2 * v3z + v4z);
    vcx += s6 * (k1x + 2 * k2x + 2 * k3x + acc[0]!);
    vcy += s6 * (k1y + 2 * k2y + 2 * k3y + acc[1]!);
    vcz += s6 * (k1z + 2 * k2z + 2 * k3z + acc[2]!);

    integrateRate(vessel, btx + atx, bty + aty, btz + atz, dt, 2, body);
    qNew = quat.normalize(quat.mul(vessel.q, quat.fromRotVec({ x: body.wx * dt, y: body.wy * dt, z: body.wz * dt })));
    mNew = mat3.fromQuat(qNew) as number[];
    contact.anyContact = false;
    contact.maxForce = 0;
    contact.waterSubmersion = 0;
  } else {
    // -------------------------------------------------------------- contact / buoyancy sub-steps
    ctx.path = 'substep';
    const lockstep = opts !== undefined ? opts.lockstep : undefined;
    // A vessel that sub-steps alone uses the module's scratch; one of a lockstep group has a run of its own,
    // because the runs of the group are advanced in turn.
    const run = lockstep !== undefined ? newRun(true) : soloRun;
    const b = run.body;
    run.vessel = vessel;
    run.st = st;
    run.env = env;
    run.events = predict ? unconfirmed : ctx.events;
    run.h = dt / CONTACT_SUBSTEPS;
    run.count = CONTACT_SUBSTEPS;
    run.inAir = inAir;
    run.rho = rho;
    run.bfx = bfx;
    run.bfy = bfy;
    run.bfz = bfz;
    run.btx = btx;
    run.bty = bty;
    run.btz = btz;
    run.invMass = invMass;
    b.rx = rcx;
    b.ry = rcy;
    b.rz = rcz;
    b.vx = vcx;
    b.vy = vcy;
    b.vz = vcz;
    b.m = m;
    b.wx = w0x;
    b.wy = w0y;
    b.wz = w0z;
    run.q = vessel.q;
    run.sumx = 0;
    run.sumy = 0;
    run.sumz = 0;
    run.maxForce = 0;
    run.any = false;
    run.submerged = 0;
    run.offset = origin !== undefined;
    if (origin !== undefined) {
      run.ox = origin.r.x;
      run.oy = origin.r.y;
      run.oz = origin.r.z;
      run.ovx = origin.v.x;
      run.ovy = origin.v.y;
      run.ovz = origin.v.z;
      const o2 = run.ox * run.ox + run.oy * run.oy + run.oz * run.oz;
      const ok = -env.mu / (o2 * Math.sqrt(o2));
      run.oax = ok * run.ox;
      run.oay = ok * run.oy;
      run.oaz = ok * run.oz;
    }
    cOut = run.out;
    cOut.crashedParts.length = 0;
    cOut.collapsedLegs.length = 0;
    unconfirmed.length = 0;
    if (lockstep !== undefined) lockstep(run);
    else {
      for (let i = 0; i < CONTACT_SUBSTEPS; i++) {
        substepForces(run, i);
        substepIntegrate(run, i);
      }
    }
    rcx = b.rx;
    rcy = b.ry;
    rcz = b.rz;
    vcx = b.vx;
    vcy = b.vy;
    vcz = b.vz;
    qNew = run.q;
    mNew = b.m;
    body.wx = b.wx;
    body.wy = b.wy;
    body.wz = b.wz;
    ngx = run.sumx / CONTACT_SUBSTEPS;
    ngy = run.sumy / CONTACT_SUBSTEPS;
    ngz = run.sumz / CONTACT_SUBSTEPS;
    contact.anyContact = run.any;
    contact.maxForce = run.maxForce;
    contact.waterSubmersion = st.buoyVolume > 0 ? run.submerged / st.buoyVolume : 0;
  }

  // ------------------------------------------------------------------ write back (origin from the CoM)
  vessel.q = qNew;
  w.x = body.wx;
  w.y = body.wy;
  w.z = body.wz;
  const n = mNew;
  r.x = rcx - (n[0]! * com.x + n[1]! * com.y + n[2]! * com.z);
  r.y = rcy - (n[3]! * com.x + n[4]! * com.y + n[5]! * com.z);
  r.z = rcz - (n[6]! * com.x + n[7]! * com.y + n[8]! * com.z);
  const ocx = w.y * com.z - w.z * com.y;
  const ocy = w.z * com.x - w.x * com.z;
  const ocz = w.x * com.y - w.y * com.x;
  v.x = vcx - (n[0]! * ocx + n[1]! * ocy + n[2]! * ocz);
  v.y = vcy - (n[3]! * ocx + n[4]! * ocy + n[5]! * ocz);
  v.z = vcz - (n[6]! * ocx + n[7]! * ocy + n[8]! * ocz);

  // ------------------------------------------------------------------ g-load
  vessel.properAccel.x = ngx * invMass;
  vessel.properAccel.y = ngy * invMass;
  vessel.properAccel.z = ngz * invMass;
  let gNow = Math.sqrt(ngx * ngx + ngy * ngy + ngz * ngz) * invMass;
  if (st.seats.length > 0) {
    // The crew feel the acceleration of their seats: CoM value plus the centripetal and tangential terms
    // of the rotation (mean angular acceleration of this step), worst seat.
    const alx = (w.x - w0x) / dt;
    const aly = (w.y - w0y) / dt;
    const alz = (w.z - w0z) / dt;
    const ax0 = ngx * invMass;
    const ay0 = ngy * invMass;
    const az0 = ngz * invMass;
    gNow = 0;
    for (let k = 0; k < st.seats.length; k += 3) {
      const sx = st.seats[k]! - com.x;
      const sy = st.seats[k + 1]! - com.y;
      const sz = st.seats[k + 2]! - com.z;
      const ux = w.y * sz - w.z * sy;
      const uy = w.z * sx - w.x * sz;
      const uz = w.x * sy - w.y * sx;
      const gx = ax0 + (w.y * uz - w.z * uy) + (aly * sz - alz * sy);
      const gy = ay0 + (w.z * ux - w.x * uz) + (alz * sx - alx * sz);
      const gz = az0 + (w.x * uy - w.y * ux) + (alx * sy - aly * sx);
      const gs = Math.sqrt(gx * gx + gy * gy + gz * gz);
      if (gs > gNow) gNow = gs;
    }
  }
  gNow /= G0;
  vessel.gLoad += (gNow - vessel.gLoad) * (1 - Math.exp(-dt / G_FILTER_TAU));

  // ------------------------------------------------------------------ surface state and sleep
  if (contact.anyContact) vessel.airborneTime = 0;
  else vessel.airborneTime += dt;
  const gx = vcx - (sp.y * rcz - sp.z * rcy);
  const gy = vcy - (sp.z * rcx - sp.x * rcz);
  const gz = vcz - (sp.x * rcy - sp.y * rcx);
  const groundSpeed = Math.sqrt(gx * gx + gy * gy + gz * gz);
  const floating = contact.waterSubmersion > 0;
  if (!floating && vessel.airborneTime > 1) vessel.inWater = false;
  if (floating && groundSpeed < SPLASH_SPEED) {
    vessel.splashTimer += dt;
    // Predict mode: the splashdown is confirmed by the server's state, never here.
    if (!predict && vessel.splashTimer >= SPLASH_TIME && vessel.surface !== 'splashed') {
      vessel.surface = 'splashed';
      // Parachutes are released once the capsule is down.
      for (let i = 0; i < st.chutes.length; i++) {
        const c = st.chutes[i]!;
        if (c.state.state === 'reefed' || c.state.state === 'full') {
          c.state.state = 'cut';
          c.state.inflation = 0;
          ctx.events.push({ type: 'chuteCut', ut: env.ut, vesselId: vessel.id, partId: eventPartId(vessel, vessel.parts[c.part]!) });
        }
      }
    }
  } else {
    vessel.splashTimer = 0;
    if (!floating && vessel.surface === 'splashed') vessel.surface = 'none';
  }
  if (vessel.surface !== 'splashed') vessel.surface = contact.anyContact && groundSpeed < SPLASH_SPEED ? 'landed' : 'none';

  // ------------------------------------------------------------------ thermal and failures
  overheated.length = 0;
  stepThermal(vessel, st, env, rho, speed, hx, hy, hz, airTemp, dt, overheated, predict);
  let structureChanged = false;
  if (predict) {
    // Threshold outcomes are the server's (ARCHITECTURE 6.4): a leg does not collapse and nothing is crushed here.
    cOut.collapsedLegs.length = 0;
    cOut.crashedParts.length = 0;
  }
  if (near && cOut.collapsedLegs.length > 0) collapseLegs(vessel, cOut.collapsedLegs, ctx);
  if (near && cOut.crashedParts.length > 0) {
    const crashed = cOut.crashedParts.slice();
    cOut.crashedParts.length = 0;
    destroyParts(vessel, crashed, 'impact', ctx);
    structureChanged = true;
  }
  if (!structureChanged && overheated.length > 0) {
    destroyParts(vessel, overheated.slice(), 'overheat', ctx);
    structureChanged = true;
  }
  if (!structureChanged && !vessel.destroyed) checkLoads(vessel, dt, ctx);
  if (vessel.destroyed || structureChanged) return ctx;

  // Sleep: resting on the ground, slow, not rotating relative to it, nothing thrusting or pending. (Predict
  // mode: the touchdown is confirmed by the server's state; the replica keeps the vessel in contact.)
  if (!predict && contact.anyContact && !floating && vessel.thrust === 0 && !anyPending(vessel)) {
    const wrx = w.x - (n[0]! * sp.x + n[3]! * sp.y + n[6]! * sp.z);
    const wry = w.y - (n[1]! * sp.x + n[4]! * sp.y + n[7]! * sp.z);
    const wrz = w.z - (n[2]! * sp.x + n[5]! * sp.y + n[8]! * sp.z);
    if (groundSpeed < SLEEP_SPEED && Math.sqrt(wrx * wrx + wry * wry + wrz * wrz) < SLEEP_RATE && !legsMoving(vessel)) {
      vessel.restTimer += dt;
      if (vessel.restTimer >= SLEEP_TIME) {
        vessel.hold = 'asleep';
        vessel.surface = 'landed';
        vessel.anchor = null;
        // Anchor at the pose reached at the end of this step (time env.ut + dt).
        const qfEnd = quat.mul(quat.fromRotVec({ x: sp.x * dt, y: sp.y * dt, z: sp.z * dt }), env.qFixedToInertial);
        vessel.anchor = { rFixed: quat.rotateInv(qfEnd, vessel.r), qFixed: quat.normalize(quat.mul(quat.conj(qfEnd), vessel.q)) };
      }
    } else {
      vessel.restTimer = 0;
    }
  } else {
    vessel.restTimer = 0;
  }
  return ctx;
}
