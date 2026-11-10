/**
 * SAS (sim-design 7.6): attitude hold only. Stability capture / re-capture, direction hold toward a
 * direction supplied by the orchestrator, gain scheduling by the current torque authority, deadband,
 * per-axis player override, fine control - plus authority-aware anti-windup (ARCHITECTURE section 6):
 *
 * Every step the external (aerodynamic + parachute) torque that the vessel would feel AT THE TARGET
 * ATTITUDE is evaluated per axis from the same force model the dynamics use. Where it exceeds what the
 * actuators can deliver, holding the target is impossible; the hold weight of that axis then fades to
 * zero (rate damping only) and returns, with hysteresis, when the authority is back. A lifting capsule
 * held "retrograde" therefore rides its aerodynamic trim and keeps its RCS for roll.
 */
import type { ControlInputs } from '@/core/contracts/controls';
import { quat } from '@/core/math/quat';
import { DEG } from '@/core/math/scalar';
import { aeroOut, evalAero } from '../dynamics/aero';
import type { Structure } from '../vessel/structure';
import type { Vessel } from '../vessel/types';

export const SAS_TAU_ANGLE = 1.5;
export const SAS_TAU_RATE = 0.3;
/** Fraction of the available angular acceleration that the rate profile plans with. */
export const SAS_ACCEL_MARGIN = 0.6;
export const FINE_CONTROL_SCALE = 0.3;
/** Integral time of the hold loop, s, and the error band in which it acts. */
export const SAS_TAU_INTEGRAL = 4;
const INTEGRAL_ZONE = 3 * DEG;
const INTEGRAL_MAX_RATE = 0.3 * DEG;
const DEADBAND_ANGLE = 0.05 * DEG;
const DEADBAND_RATE = 0.01 * DEG;
const RECAPTURE_RATE = 0.5 * DEG;
const RECAPTURE_TIME = 1.0;
/** Hysteresis band of the hold weight against rho = |external torque at target| / authority. */
const HOLD_RELEASE_LO = 0.6;
const HOLD_RELEASE_HI = 1.0;
const HOLD_RETURN_LO = 0.35;
const HOLD_RETURN_HI = 0.7;
const HOLD_FADE_RATE = 1.0;
const HOLD_RETURN_RATE = 0.5;
/** Below this dynamic pressure no external torque is evaluated. */
const MIN_Q_FOR_ESTIMATE = 0.5;
/** Coordinated-roll feed-forward needs the airflow to have this much component along the roll axis. */
const COORDINATED_ROLL_MIN_AXIAL = 0.3;
/** Rate deadband of an axis whose hold is released (rate damping only), rad/s. */
const RELEASED_RATE_DEADBAND = 0.5 * DEG;

const smooth = (e0: number, e1: number, x: number): number => {
  const t = x <= e0 ? 0 : x >= e1 ? 1 : (x - e0) / (e1 - e0);
  return t * t * (3 - 2 * t);
};

/** Result of the SAS for this step: normalised torque command per VES axis (x pitch, y roll, z -yaw). */
export const sasOut = { ux: 0, uy: 0, uz: 0 };

const theta = [0, 0, 0];
const u = [0, 0, 0];
const inp = [0, 0, 0];
const rate = [0, 0, 0];
const ref = [0, 0, 0];

export function setSasEnabled(vessel: Vessel, on: boolean): void {
  if (on && !vessel.sas.enabled) vessel.sas.hasTarget = false;
  vessel.sas.enabled = on;
}

export function setSasMode(vessel: Vessel, mode: Vessel['sas']['mode']): void {
  if (vessel.sas.mode !== mode) {
    vessel.sas.hasTarget = false;
    vessel.sas.integral[0] = vessel.sas.integral[1] = vessel.sas.integral[2] = 0;
    vessel.sas.hold[0] = vessel.sas.hold[1] = vessel.sas.hold[2] = 1;
  }
  vessel.sas.mode = mode;
}

/**
 * Direction (unit, BCI/ROOT axes) that the non-stability modes hold. The orchestrator sets it every step
 * from the navball frame; null makes a direction mode behave like stability.
 */
export function setSasHoldDirection(vessel: Vessel, dir: { x: number; y: number; z: number } | null): void {
  vessel.sas.holdDir = dir ? { x: dir.x, y: dir.y, z: dir.z } : null;
}

/**
 * Compute the torque command for this step into sasOut and vessel.appliedControls.
 * (vax, vay, vaz): air-relative velocity of the CoM in VES; rho: air density; qDyn: dynamic pressure.
 * vessel.authority must be current.
 */
export function sasUpdate(vessel: Vessel, st: Structure, controls: ControlInputs, rho: number, qDyn: number, vax: number, vay: number, vaz: number, dt: number): void {
  const sas = vessel.sas;
  const scale = vessel.fineControl ? FINE_CONTROL_SCALE : 1;
  const clampUnit = (x: number): number => (x < -1 ? -1 : x > 1 ? 1 : Number.isFinite(x) ? x : 0);
  inp[0] = clampUnit(controls.pitch) * scale;
  inp[1] = clampUnit(controls.roll) * scale;
  inp[2] = -clampUnit(controls.yaw) * scale;
  rate[0] = vessel.w.x;
  rate[1] = vessel.w.y;
  rate[2] = vessel.w.z;
  u[0] = inp[0]!;
  u[1] = inp[1]!;
  u[2] = inp[2]!;

  // Resting on the ground or floating with the engines out, the SAS lets go: it must not push against the
  // surface (and keep thrusters firing) for an attitude error it cannot remove.
  let engineLit = false;
  for (let i = 0; i < st.engines.length; i++) if (st.engines[i]!.rt.lit) engineLit = true;
  const resting = (vessel.surface === 'landed' || vessel.surface === 'splashed' || vessel.contact.waterSubmersion > 0) && !engineLit;
  const active = sas.enabled && st.sasAvailable && vessel.hold === null && vessel.crewAlive && !resting;
  if (!active) {
    sas.integral[0] = sas.integral[1] = sas.integral[2] = 0;
    sas.hasTarget = false;
    sas.hold[0] = sas.hold[1] = sas.hold[2] = 1;
  } else {
    const direction = sas.mode !== 'stability' && sas.holdDir !== null;
    // Error rotation vector in VES.
    let rollFree = false;
    if (direction) {
      const d = quat.rotateInv(vessel.q, sas.holdDir!);
      const ax = d.z;
      const az = -d.x;
      const s = Math.hypot(ax, az);
      if (s < 1e-9) {
        theta[0] = d.y < 0 ? Math.PI : 0;
        theta[2] = 0;
      } else {
        const ang = Math.atan2(s, d.y);
        theta[0] = (ax / s) * ang;
        theta[2] = (az / s) * ang;
      }
      theta[1] = 0;
      rollFree = true;
      sas.hasTarget = false;
    } else {
      if (!sas.hasTarget) {
        sas.target = quat.clone(vessel.q);
        sas.hasTarget = true;
      }
      // Player input: the axis is released from the hold; the target is re-captured once it has settled.
      for (let i = 0; i < 3; i++) {
        if (inp[i] !== 0) {
          sas.inputActive[i] = true;
          sas.releaseTimer[i] = 0;
        } else if (sas.inputActive[i]) {
          sas.releaseTimer[i] = sas.releaseTimer[i]! + dt;
          if (Math.abs(rate[i]!) < RECAPTURE_RATE || sas.releaseTimer[i]! >= RECAPTURE_TIME) {
            sas.inputActive[i] = false;
            sas.releaseTimer[i] = -1;
            sas.target = quat.clone(vessel.q);
          }
        }
      }
      const qe = quat.mul(quat.conj(vessel.q), sas.target);
      const rv = quat.toRotVec(qe);
      theta[0] = rv.x;
      theta[1] = rv.y;
      theta[2] = rv.z;
    }

    // External torque at the target attitude -> hold weights.
    let ex = 0;
    let ey = 0;
    let ez = 0;
    if (qDyn > MIN_Q_FOR_ESTIMATE) {
      const dq = quat.fromRotVec({ x: theta[0]!, y: theta[1]!, z: theta[2]! });
      const va = quat.rotateInv(dq, { x: vax, y: vay, z: vaz });
      evalAero(vessel, st, rho, va.x, va.y, va.z, 0, 0, 0, aeroOut);
      ex = aeroOut.tx;
      ey = aeroOut.ty;
      ez = aeroOut.tz;
    }
    sas.externalTorque[0] = ex;
    sas.externalTorque[1] = ey;
    sas.externalTorque[2] = ez;
    for (let i = 0; i < 3; i++) {
      const tauMax = vessel.authority[i]!;
      const ext = Math.abs(sas.externalTorque[i]!);
      const rho_i = tauMax > 0 ? ext / tauMax : ext > 0 ? Infinity : 0;
      const upper = 1 - smooth(HOLD_RELEASE_LO, HOLD_RELEASE_HI, rho_i);
      const lower = 1 - smooth(HOLD_RETURN_LO, HOLD_RETURN_HI, rho_i);
      let h = sas.hold[i]!;
      if (h > upper) h = Math.max(upper, h - HOLD_FADE_RATE * dt);
      else if (h < lower) h = Math.min(lower, h + HOLD_RETURN_RATE * dt);
      sas.hold[i] = h;
    }

    // Coordinated roll: a vessel riding its aerodynamic trim rolls ABOUT THE AIRFLOW, which shows up as
    // pitch/yaw body rates proportional to the roll rate. Those are not errors and must not be damped
    // away, so the rate reference of the pitch and yaw axes is the rotation about the air-relative
    // velocity that has the measured roll rate, weighted by how far the hold has been released.
    ref[0] = ref[1] = ref[2] = 0;
    const released = 1 - Math.min(sas.hold[0], sas.hold[2]);
    if (released > 0 && qDyn > MIN_Q_FOR_ESTIMATE) {
      const sp = Math.sqrt(vax * vax + vay * vay + vaz * vaz);
      const hy = sp > 0 ? vay / sp : 0;
      if (Math.abs(hy) > COORDINATED_ROLL_MIN_AXIAL) {
        const omega = (released * rate[1]!) / hy;
        ref[0] = (omega * vax) / sp;
        ref[2] = (omega * vaz) / sp;
      }
    }

    const I = vessel.mp.i;
    for (let i = 0; i < 3; i++) {
      if (inp[i] !== 0) {
        sas.integral[i] = 0;
        continue; // player override on this axis
      }
      const tauMax = vessel.authority[i]!;
      const inertia = I[i]!;
      if (!(tauMax > 0) || !(inertia > 0)) {
        u[i] = 0;
        continue;
      }
      const alpha = tauMax / inertia;
      const damping = (rollFree && i === 1) || sas.inputActive[i];
      let wDes = 0;
      if (!damping) {
        const th = theta[i]! * sas.hold[i]!;
        const wLim = Math.min(st.maxRate, Math.sqrt(2 * SAS_ACCEL_MARGIN * alpha * Math.PI));
        const lim = Math.min(wLim, Math.sqrt(2 * SAS_ACCEL_MARGIN * alpha * Math.abs(th)));
        // Slow integral action near the target removes the offset a steady disturbance (thrust line off
        // the CoM) would leave. It only runs under full hold, so it cannot wind up against aerodynamics.
        // And only once the vessel has all but stopped near the target: an approach must not charge it.
        if (Math.abs(theta[i]!) < INTEGRAL_ZONE && sas.hold[i]! > 0.99 && Math.abs(rate[i]!) < INTEGRAL_MAX_RATE) {
          // At most the rate bias that asks for the full authority.
          const cap = alpha * SAS_TAU_RATE * SAS_TAU_ANGLE * SAS_TAU_INTEGRAL;
          let acc = sas.integral[i]! + theta[i]! * dt;
          if (acc > cap) acc = cap;
          else if (acc < -cap) acc = -cap;
          sas.integral[i] = acc;
        } else {
          sas.integral[i] = sas.integral[i]! * Math.max(0, 1 - dt);
        }
        wDes = th / SAS_TAU_ANGLE;
        if (wDes > lim) wDes = lim;
        else if (wDes < -lim) wDes = -lim;
        wDes += sas.integral[i]! / (SAS_TAU_ANGLE * SAS_TAU_INTEGRAL);
        if (wDes > wLim) wDes = wLim;
        else if (wDes < -wLim) wDes = -wLim;
        if (Math.abs(theta[i]!) < DEADBAND_ANGLE && Math.abs(rate[i]!) < DEADBAND_RATE && Math.abs(sas.integral[i]!) < DEADBAND_ANGLE * SAS_TAU_INTEGRAL) {
          u[i] = 0;
          continue;
        }
      } else if (Math.abs(rate[i]!) < DEADBAND_RATE) {
        u[i] = 0;
        continue;
      }
      const rateError = wDes + ref[i]! - rate[i]!;
      // An axis that has lost its hold only damps: a wider rate deadband keeps the thrusters off the
      // small motions the airflow itself drives.
      if (sas.hold[i]! < 0.5 && Math.abs(rateError) < RELEASED_RATE_DEADBAND) {
        u[i] = 0;
        continue;
      }
      u[i] = clampUnit(rateError / (alpha * SAS_TAU_RATE));
    }
  }

  sasOut.ux = u[0]!;
  sasOut.uy = u[1]!;
  sasOut.uz = u[2]!;
  const ac = vessel.appliedControls;
  ac.pitch = u[0]!;
  ac.roll = u[1]!;
  ac.yaw = -u[2]!;
  ac.throttle = controls.throttle < 0 ? 0 : controls.throttle > 1 ? 1 : Number.isFinite(controls.throttle) ? controls.throttle : 0;
  ac.translate.x = clampUnit(controls.translate.x) * scale;
  ac.translate.y = clampUnit(controls.translate.y) * scale;
  ac.translate.z = clampUnit(controls.translate.z) * scale;
}
