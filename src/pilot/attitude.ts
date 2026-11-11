/**
 * "Flying the navball" by hand: pitch / yaw / roll inputs that bring the nose onto a wanted direction.
 *
 * The pilot has no access to the vessel's control authority, so it does what a human does: it learns how
 * briskly the vehicle answers the stick (an estimate of the angular acceleration at full deflection per
 * axis, from the observed change of body rate under its own commands) and plans a rate that it can still
 * stop: w_des = sign(theta) min(maxRate, sqrt(2 k a |theta|), |theta| / tau). The command is the rate
 * error over the estimated authority. The same law flies the 2 750 t launch stack and the 5 t capsule.
 *
 * Sign conventions (ARCHITECTURE section 3): pitch + = nose toward +Z (rotation about +X), yaw + = nose
 * toward +X (rotation about -Z), roll + = rotation about +Y.
 */
import { quat, type Quat } from '@/core/math/quat';
import { DEG } from '@/core/math/scalar';
import type { Vec3 } from '@/core/math/vec3';

/** Fraction of the estimated authority the stopping profile plans with. */
const PROFILE_MARGIN = 0.5;
const TAU_ANGLE = 1.2;
const TAU_RATE = 0.4;
const ALPHA_MIN = 0.004;
const ALPHA_MAX = 4;
const ALPHA_START = 0.04;
/** Commands above this magnitude are used to learn the authority. */
const LEARN_MIN_COMMAND = 0.3;
const LEARN_GAIN = 0.08;
const DEADBAND_ANGLE = 0.03 * DEG;
const DEADBAND_RATE = 0.02 * DEG;

export interface AttitudeCommand {
  pitch: number;
  yaw: number;
  roll: number;
  /** Angle between the nose and the wanted direction, rad. */
  error: number;
}

export interface AttitudeOptions {
  /** Direction (ROOT axes) the dorsal side (+Z) should face as nearly as the nose direction allows; omitted = leave roll to the SAS. */
  dorsal?: Vec3 | null;
  /** Rate limit, rad/s (default 8 deg/s). */
  maxRate?: number;
}

export class AttitudeController {
  /** Estimated angular acceleration at full command about VES x (pitch), y (roll), z (yaw axis), rad/s^2. */
  readonly alpha: [number, number, number] = [ALPHA_START, ALPHA_START, ALPHA_START];
  private prevW: [number, number, number] | null = null;
  private prevU: [number, number, number] = [0, 0, 0];

  /** Forget the learned authority (after staging: the vehicle is a different one). */
  reset(alpha = ALPHA_START): void {
    this.alpha[0] = this.alpha[1] = this.alpha[2] = alpha;
    this.prevW = null;
    this.prevU = [0, 0, 0];
  }

  /** Drop the rate history without forgetting the authority (after a pause in manual control). */
  pause(): void {
    this.prevW = null;
    this.prevU = [0, 0, 0];
  }

  update(q: Quat, w: Vec3, noseDir: Vec3, dt: number, opts: AttitudeOptions = {}): AttitudeCommand {
    const wv: [number, number, number] = [w.x, w.y, w.z];
    // Learn the authority from the response to the previous command.
    if (this.prevW && dt > 0) {
      for (let i = 0; i < 3; i++) {
        const u = this.prevU[i]!;
        if (Math.abs(u) < LEARN_MIN_COMMAND) continue;
        const a = (wv[i]! - this.prevW[i]!) / dt / u;
        if (a > 0) this.alpha[i] = Math.min(ALPHA_MAX, Math.max(ALPHA_MIN, this.alpha[i]! + (a - this.alpha[i]!) * LEARN_GAIN));
      }
    }
    const d = quat.rotateInv(q, noseDir);
    const s = Math.hypot(d.x, d.z);
    const angle = Math.atan2(s, d.y);
    const theta: [number, number, number] = [0, 0, 0];
    if (s > 1e-12) {
      theta[0] = (angle * d.z) / s;
      theta[2] = (-angle * d.x) / s;
    } else if (d.y < 0) theta[0] = Math.PI;
    let rollActive = false;
    if (opts.dorsal) {
      const h = quat.rotateInv(q, opts.dorsal);
      if (Math.hypot(h.x, h.z) > 1e-6) {
        theta[1] = Math.atan2(h.x, h.z);
        rollActive = true;
      }
    }
    const maxRate = opts.maxRate ?? 8 * DEG;
    const u: [number, number, number] = [0, 0, 0];
    for (let i = 0; i < 3; i++) {
      if (i === 1 && !rollActive) continue;
      const th = theta[i]!;
      const a = this.alpha[i]!;
      const mag = Math.abs(th);
      if (mag < DEADBAND_ANGLE && Math.abs(wv[i]!) < DEADBAND_RATE) continue;
      const wDes = Math.sign(th) * Math.min(maxRate, Math.sqrt(2 * PROFILE_MARGIN * a * mag), mag / TAU_ANGLE);
      const c = (wDes - wv[i]!) / (a * TAU_RATE);
      u[i] = c < -1 ? -1 : c > 1 ? 1 : c;
    }
    this.prevW = wv;
    this.prevU = u;
    return { pitch: u[0], yaw: -u[2], roll: u[1], error: angle };
  }
}
