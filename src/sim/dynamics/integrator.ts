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
import { contactBroadphase, contactOut, evalContact, type BodyState } from './contact';
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

/** Acceleration of the CoM at (p, v): gravity + held body force + aerodynamics re-evaluated for v. */
function accel(px: number, py: number, pz: number, vx: number, vy: number, vz: number): void {
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

export function stepVessel(vessel: Vessel, env: VesselEnvironment, controls: ControlInputs, dt: number): StepResult {
  const ctx: StepContext = { ut: env.ut, env, instant: false, events: [], spawned: [] };
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
  const rLen = Math.sqrt(rcx * rcx + rcy * rcy + rcz * rcz);
  const altitude = rLen - env.radius;
  const atm = env.atmosphereAt(altitude);
  const sp = env.spin;
  const uax = vcx - (sp.y * rcz - sp.z * rcy);
  const uay = vcy - (sp.z * rcx - sp.x * rcz);
  const uaz = vcz - (sp.x * rcy - sp.y * rcx);
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
  if (st.chutes.length > 0) updateParachutes(vessel, st, altitude, mach, speed, qDyn, hx, hy, hz, dt, env.ut, ctx.events);
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
    vessel.properAccel.x = (m[0]! * rcx + m[3]! * rcy + m[6]! * rcz) * k;
    vessel.properAccel.y = (m[1]! * rcx + m[4]! * rcy + m[7]! * rcz) * k;
    vessel.properAccel.z = (m[2]! * rcx + m[5]! * rcy + m[8]! * rcz) * k;
    vessel.gLoad += (gLocal / G0 - vessel.gLoad) * (1 - Math.exp(-dt / G_FILTER_TAU));
    vessel.contact.anyContact = true;
    vessel.contact.maxForce = mp.mass * gLocal;
    vessel.contact.waterSubmersion = 0;
    vessel.groundClearance = 0;
    vessel.airborneTime = 0;
    vessel.surface = vessel.hold === 'clamps' ? 'prelaunch' : 'landed';
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
  const near = contactBroadphase(vessel, st, env, dt);
  if (st.buried) {
    // Entirely below the terrain (it got past the probes, e.g. at extreme speed): an impact.
    const all: number[] = [];
    for (let i = 0; i < vessel.parts.length; i++) all.push(i);
    destroyParts(vessel, all, 'impact', ctx);
    return ctx;
  }
  const contact = vessel.contact;

  if (!near) {
    // -------------------------------------------------------------- free flight: RK4 + attitude
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
    const h = dt / CONTACT_SUBSTEPS;
    body.rx = rcx;
    body.ry = rcy;
    body.rz = rcz;
    body.vx = vcx;
    body.vy = vcy;
    body.vz = vcz;
    body.m = m;
    let q = vessel.q;
    let sumx = 0;
    let sumy = 0;
    let sumz = 0;
    let maxForce = 0;
    let any = false;
    let submerged = 0;
    contactOut.crashedParts.length = 0;
    contactOut.collapsedLegs.length = 0;
    for (let i = 0; i < CONTACT_SUBSTEPS; i++) {
      const bm = body.m;
      const tau = i * h;
      const qf = tau === 0 ? env.qFixedToInertial : quat.mul(quat.fromRotVec({ x: sp.x * tau, y: sp.y * tau, z: sp.z * tau }), env.qFixedToInertial);
      // Aerodynamics for the current sub-state (density of the step start; the vessel is within metres of the surface).
      let fx = bfx;
      let fy = bfy;
      let fz = bfz;
      let tx = btx;
      let ty = bty;
      let tz = btz;
      if (inAir) {
        const ux = body.vx - (sp.y * body.rz - sp.z * body.ry);
        const uy = body.vy - (sp.z * body.rx - sp.x * body.rz);
        const uz = body.vz - (sp.x * body.ry - sp.y * body.rx);
        evalAero(vessel, st, rho, bm[0]! * ux + bm[3]! * uy + bm[6]! * uz, bm[1]! * ux + bm[4]! * uy + bm[7]! * uz, bm[2]! * ux + bm[5]! * uy + bm[8]! * uz, body.wx, body.wy, body.wz, aeroOut);
        fx += aeroOut.fx;
        fy += aeroOut.fy;
        fz += aeroOut.fz;
        tx += aeroOut.tx;
        ty += aeroOut.ty;
        tz += aeroOut.tz;
      }
      evalContact(vessel, st, env, body, qf, env.ut, ctx.events, contactOut);
      // Total non-gravitational force in BCI.
      const Fx = bm[0]! * fx + bm[1]! * fy + bm[2]! * fz + contactOut.fx;
      const Fy = bm[3]! * fx + bm[4]! * fy + bm[5]! * fz + contactOut.fy;
      const Fz = bm[6]! * fx + bm[7]! * fy + bm[8]! * fz + contactOut.fz;
      sumx += bm[0]! * Fx + bm[3]! * Fy + bm[6]! * Fz;
      sumy += bm[1]! * Fx + bm[4]! * Fy + bm[7]! * Fz;
      sumz += bm[2]! * Fx + bm[5]! * Fy + bm[8]! * Fz;
      if (contactOut.maxForce > maxForce) maxForce = contactOut.maxForce;
      if (contactOut.anyContact) any = true;
      submerged = contactOut.submergedVolume;
      const r2 = body.rx * body.rx + body.ry * body.ry + body.rz * body.rz;
      const kg = -env.mu / (r2 * Math.sqrt(r2));
      body.vx += (kg * body.rx + Fx * invMass) * h;
      body.vy += (kg * body.ry + Fy * invMass) * h;
      body.vz += (kg * body.rz + Fz * invMass) * h;
      integrateRate(vessel, tx + contactOut.tx, ty + contactOut.ty, tz + contactOut.tz, h, 1, body);
      body.rx += body.vx * h;
      body.ry += body.vy * h;
      body.rz += body.vz * h;
      q = quat.normalize(quat.mul(q, quat.fromRotVec({ x: body.wx * h, y: body.wy * h, z: body.wz * h })));
      body.m = mat3.fromQuat(q) as number[];
    }
    rcx = body.rx;
    rcy = body.ry;
    rcz = body.rz;
    vcx = body.vx;
    vcy = body.vy;
    vcz = body.vz;
    qNew = q;
    mNew = body.m;
    ngx = sumx / CONTACT_SUBSTEPS;
    ngy = sumy / CONTACT_SUBSTEPS;
    ngz = sumz / CONTACT_SUBSTEPS;
    contact.anyContact = any;
    contact.maxForce = maxForce;
    contact.waterSubmersion = st.buoyVolume > 0 ? submerged / st.buoyVolume : 0;
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
    if (vessel.splashTimer >= SPLASH_TIME && vessel.surface !== 'splashed') {
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
  stepThermal(vessel, st, env, rho, speed, hx, hy, hz, atm.temperature, dt, overheated);
  let structureChanged = false;
  if (near && contactOut.collapsedLegs.length > 0) collapseLegs(vessel, contactOut.collapsedLegs, ctx);
  if (near && contactOut.crashedParts.length > 0) {
    const crashed = contactOut.crashedParts.slice();
    contactOut.crashedParts.length = 0;
    destroyParts(vessel, crashed, 'impact', ctx);
    structureChanged = true;
  }
  if (!structureChanged && overheated.length > 0) {
    destroyParts(vessel, overheated.slice(), 'overheat', ctx);
    structureChanged = true;
  }
  if (!structureChanged && !vessel.destroyed) checkLoads(vessel, dt, ctx);
  if (vessel.destroyed || structureChanged) return ctx;

  // Sleep: resting on the ground, slow, not rotating relative to it, nothing thrusting or pending.
  if (contact.anyContact && !floating && vessel.thrust === 0 && !anyPending(vessel)) {
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
