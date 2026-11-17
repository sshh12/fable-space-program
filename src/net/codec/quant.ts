/**
 * Pose quantisation of island deltas and the near tier (ARCHITECTURE 13.4).
 *
 * A delta carries residuals against the LAST KEY the receiver holds, in fixed units: position 1/64 mm
 * against keyPos + keyVel x dt, velocity 1 um/s against keyVel, attitude as the smallest three components of
 * the unit quaternion on a 2^-34 grid against the key's attitude advanced by its rate to first order, angular
 * velocity 1 urad/s against the key's rate. Both sides use only +, -, *, /, sqrt and Math.round, which are
 * exactly rounded IEEE operations in every JavaScript engine (no fused multiply-add), so the receiver
 * reconstructs bit for bit what the sender meant, in Node and in Chrome alike.
 *
 * Quantisation error: position 7.8 um (1/128 mm), velocity 0.5 um/s, attitude below 2e-10 rad (three
 * components off by at most 2^-35 each, the fourth rebuilt from them), angular velocity 0.5 urad/s.
 */
import type { DeltaPose, KeyVessel } from '@/core/contracts/net';
import type { Quat } from '@/core/math/quat';
import type { Vec3 } from '@/core/math/vec3';
import { TICKS_PER_SECOND } from '@/core/contracts/net';

/** Position units per metre: 1/64 mm, and 1 mm when coarse. */
export const POS_FINE = 64_000;
export const POS_COARSE = 1000;
/** Velocity units per m/s: 1 um/s, and 16 um/s when coarse. */
export const VEL_FINE = 1_000_000;
export const VEL_COARSE = 62_500;
/** Attitude component grid: 2^-34. */
export const ATT_SCALE = 2 ** 34;
/** Angular velocity units per rad/s: 1 urad/s. */
export const RATE_SCALE = 1_000_000;
/** A fine residual above this magnitude switches its group to the coarse unit. */
const FINE_LIMIT = 2_147_483_647;

/** The pose of one vessel in the island frame (what a key holds and what a delta reconstructs). */
export interface IslandPose {
  pos: Vec3;
  vel: Vec3;
  att: Quat;
  rate: Vec3;
}

/** Make a pose with zero vectors and the identity attitude. */
export function makePose(): IslandPose {
  return { pos: { x: 0, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 }, att: { x: 0, y: 0, z: 0, w: 1 }, rate: { x: 0, y: 0, z: 0 } };
}

const scratchPred: number[] = [0, 0, 0, 0];
const scratchCur: number[] = [0, 0, 0, 0];

/**
 * The key's attitude advanced by `dt` seconds with its rate (VES axes): q + dt/2 q (x) (w, 0), normalised.
 * Writes x, y, z, w into `out`.
 */
/** The key's acceleration term (a key vessel's `acc`; null for a coasting vessel or a plain pose). */
function keyAcc(key: KeyVessel | IslandPose): { x: number; y: number; z: number } | null {
  return 'acc' in key ? (key as KeyVessel).acc : null;
}

function predictAttitude(key: KeyVessel | IslandPose, dt: number, out: number[]): void {
  const q = key.att;
  const w = key.rate;
  const h = 0.5 * dt;
  // q (x) (wx, wy, wz, 0) for q = (x, y, z, w): Hamilton product with a pure quaternion.
  const dx = q.w * w.x + q.y * w.z - q.z * w.y;
  const dy = q.w * w.y + q.z * w.x - q.x * w.z;
  const dz = q.w * w.z + q.x * w.y - q.y * w.x;
  const dw = -(q.x * w.x + q.y * w.y + q.z * w.z);
  const x = q.x + h * dx;
  const y = q.y + h * dy;
  const z = q.z + h * dz;
  const ww = q.w + h * dw;
  const n = Math.sqrt(x * x + y * y + z * z + ww * ww);
  if (n > 0) {
    out[0] = x / n;
    out[1] = y / n;
    out[2] = z / n;
    out[3] = ww / n;
  } else {
    out[0] = 0;
    out[1] = 0;
    out[2] = 0;
    out[3] = 1;
  }
}

function largestIndex(c: number[]): 0 | 1 | 2 | 3 {
  let best: 0 | 1 | 2 | 3 = 0;
  let m = Math.abs(c[0]!);
  for (let i = 1; i < 4; i++) {
    const a = Math.abs(c[i]!);
    if (a > m) {
      m = a;
      best = i as 1 | 2 | 3;
    }
  }
  return best;
}

/** The three components other than `skip`, in x, y, z, w order, times `sign`. */
function others(c: number[], skip: number, sign: number, out: number[]): void {
  let j = 0;
  for (let i = 0; i < 4; i++) if (i !== skip) out[j++] = c[i]! * sign;
}

const scratchRef: number[] = [0, 0, 0];
const scratchVal: number[] = [0, 0, 0];

/**
 * Quantise `cur` against `key` (the key as the receiver holds it: float64 position and velocity, float32
 * attitude and rate) `dtTicks` after the key. Writes the POSE group into `out`.
 */
export function quantizePose(key: KeyVessel | IslandPose, dtTicks: number, cur: IslandPose, out: DeltaPose): void {
  const dt = dtTicks / TICKS_PER_SECOND;
  // Position against the key's straight-line extrapolation.
  // The prediction: key position + velocity x dt (+ acceleration x dt^2 / 2 when the key has the term).
  const acc = keyAcc(key);
  const h = 0.5 * dt * dt;
  const pxp = acc ? key.pos.x + key.vel.x * dt + acc.x * h : key.pos.x + key.vel.x * dt;
  const pyp = acc ? key.pos.y + key.vel.y * dt + acc.y * h : key.pos.y + key.vel.y * dt;
  const pzp = acc ? key.pos.z + key.vel.z * dt + acc.z * h : key.pos.z + key.vel.z * dt;
  const vxp = acc ? key.vel.x + acc.x * dt : key.vel.x;
  const vyp = acc ? key.vel.y + acc.y * dt : key.vel.y;
  const vzp = acc ? key.vel.z + acc.z * dt : key.vel.z;
  let px = Math.round(cur.pos.x * POS_FINE) - Math.round(pxp * POS_FINE);
  let py = Math.round(cur.pos.y * POS_FINE) - Math.round(pyp * POS_FINE);
  let pz = Math.round(cur.pos.z * POS_FINE) - Math.round(pzp * POS_FINE);
  out.coarsePos = Math.abs(px) > FINE_LIMIT || Math.abs(py) > FINE_LIMIT || Math.abs(pz) > FINE_LIMIT;
  if (out.coarsePos) {
    px = Math.round(cur.pos.x * POS_COARSE) - Math.round(pxp * POS_COARSE);
    py = Math.round(cur.pos.y * POS_COARSE) - Math.round(pyp * POS_COARSE);
    pz = Math.round(cur.pos.z * POS_COARSE) - Math.round(pzp * POS_COARSE);
  }
  out.px = px;
  out.py = py;
  out.pz = pz;
  let vx = Math.round(cur.vel.x * VEL_FINE) - Math.round(vxp * VEL_FINE);
  let vy = Math.round(cur.vel.y * VEL_FINE) - Math.round(vyp * VEL_FINE);
  let vz = Math.round(cur.vel.z * VEL_FINE) - Math.round(vzp * VEL_FINE);
  out.coarseVel = Math.abs(vx) > FINE_LIMIT || Math.abs(vy) > FINE_LIMIT || Math.abs(vz) > FINE_LIMIT;
  if (out.coarseVel) {
    vx = Math.round(cur.vel.x * VEL_COARSE) - Math.round(vxp * VEL_COARSE);
    vy = Math.round(cur.vel.y * VEL_COARSE) - Math.round(vyp * VEL_COARSE);
    vz = Math.round(cur.vel.z * VEL_COARSE) - Math.round(vzp * VEL_COARSE);
  }
  out.vx = vx;
  out.vy = vy;
  out.vz = vz;
  // Attitude: smallest three of the current quaternion, against the predicted key attitude.
  scratchCur[0] = cur.att.x;
  scratchCur[1] = cur.att.y;
  scratchCur[2] = cur.att.z;
  scratchCur[3] = cur.att.w;
  const L = largestIndex(scratchCur);
  others(scratchCur, L, scratchCur[L]! < 0 ? -1 : 1, scratchVal);
  predictAttitude(key, dt, scratchPred);
  const absolute = largestIndex(scratchPred) !== L;
  out.attLargest = L;
  out.attAbsolute = absolute;
  if (absolute) {
    out.qa = Math.round(scratchVal[0]! * ATT_SCALE);
    out.qb = Math.round(scratchVal[1]! * ATT_SCALE);
    out.qc = Math.round(scratchVal[2]! * ATT_SCALE);
  } else {
    others(scratchPred, L, scratchPred[L]! < 0 ? -1 : 1, scratchRef);
    out.qa = Math.round(scratchVal[0]! * ATT_SCALE) - Math.round(scratchRef[0]! * ATT_SCALE);
    out.qb = Math.round(scratchVal[1]! * ATT_SCALE) - Math.round(scratchRef[1]! * ATT_SCALE);
    out.qc = Math.round(scratchVal[2]! * ATT_SCALE) - Math.round(scratchRef[2]! * ATT_SCALE);
  }
  out.wx = Math.round(cur.rate.x * RATE_SCALE) - Math.round(key.rate.x * RATE_SCALE);
  out.wy = Math.round(cur.rate.y * RATE_SCALE) - Math.round(key.rate.y * RATE_SCALE);
  out.wz = Math.round(cur.rate.z * RATE_SCALE) - Math.round(key.rate.z * RATE_SCALE);
}

/** Largest smallest-three component of a unit quaternion (1/sqrt(2)), with room for the grid. */
const MAX_COMPONENT = 0.7071067811865476 + 1e-9;

/**
 * Rebuild the pose a delta describes from the key it was made against. Returns false when the residuals do
 * not describe a unit quaternion (a malformed delta); `out` is then unspecified.
 */
export function dequantizePose(key: KeyVessel | IslandPose, dtTicks: number, d: DeltaPose, out: IslandPose): boolean {
  const dt = dtTicks / TICKS_PER_SECOND;
  const S = d.coarsePos ? POS_COARSE : POS_FINE;
  // The same prediction as quantizePose, operation for operation.
  const acc = keyAcc(key);
  const h = 0.5 * dt * dt;
  out.pos.x = (Math.round((acc ? key.pos.x + key.vel.x * dt + acc.x * h : key.pos.x + key.vel.x * dt) * S) + d.px) / S;
  out.pos.y = (Math.round((acc ? key.pos.y + key.vel.y * dt + acc.y * h : key.pos.y + key.vel.y * dt) * S) + d.py) / S;
  out.pos.z = (Math.round((acc ? key.pos.z + key.vel.z * dt + acc.z * h : key.pos.z + key.vel.z * dt) * S) + d.pz) / S;
  const V = d.coarseVel ? VEL_COARSE : VEL_FINE;
  out.vel.x = (Math.round((acc ? key.vel.x + acc.x * dt : key.vel.x) * V) + d.vx) / V;
  out.vel.y = (Math.round((acc ? key.vel.y + acc.y * dt : key.vel.y) * V) + d.vy) / V;
  out.vel.z = (Math.round((acc ? key.vel.z + acc.z * dt : key.vel.z) * V) + d.vz) / V;
  let a: number;
  let b: number;
  let c: number;
  if (d.attAbsolute) {
    a = d.qa / ATT_SCALE;
    b = d.qb / ATT_SCALE;
    c = d.qc / ATT_SCALE;
  } else {
    predictAttitude(key, dt, scratchPred);
    const L = d.attLargest;
    others(scratchPred, L, scratchPred[L]! < 0 ? -1 : 1, scratchRef);
    a = (Math.round(scratchRef[0]! * ATT_SCALE) + d.qa) / ATT_SCALE;
    b = (Math.round(scratchRef[1]! * ATT_SCALE) + d.qb) / ATT_SCALE;
    c = (Math.round(scratchRef[2]! * ATT_SCALE) + d.qc) / ATT_SCALE;
  }
  if (Math.abs(a) > MAX_COMPONENT || Math.abs(b) > MAX_COMPONENT || Math.abs(c) > MAX_COMPONENT) return false;
  const s = a * a + b * b + c * c;
  if (s > 1) return false;
  const big = Math.sqrt(1 - s);
  setQuat(out.att, d.attLargest, big, a, b, c);
  out.rate.x = (Math.round(key.rate.x * RATE_SCALE) + d.wx) / RATE_SCALE;
  out.rate.y = (Math.round(key.rate.y * RATE_SCALE) + d.wy) / RATE_SCALE;
  out.rate.z = (Math.round(key.rate.z * RATE_SCALE) + d.wz) / RATE_SCALE;
  return true;
}

function setQuat(q: Quat, L: number, big: number, a: number, b: number, c: number): void {
  if (L === 0) {
    q.x = big;
    q.y = a;
    q.z = b;
    q.w = c;
  } else if (L === 1) {
    q.x = a;
    q.y = big;
    q.z = b;
    q.w = c;
  } else if (L === 2) {
    q.x = a;
    q.y = b;
    q.z = big;
    q.w = c;
  } else {
    q.x = a;
    q.y = b;
    q.z = c;
    q.w = big;
  }
}

/** Rotation angle between two unit quaternions, rad (q and -q are the same rotation). */
export function quatAngle(p: Quat, q: Quat): number {
  const dx = p.x - q.x;
  const dy = p.y - q.y;
  const dz = p.z - q.z;
  const dw = p.w - q.w;
  const sx = p.x + q.x;
  const sy = p.y + q.y;
  const sz = p.z + q.z;
  const sw = p.w + q.w;
  // Well conditioned for tiny angles: |p - q| = 2 sin(phi/2), |p + q| = 2 cos(phi/2) with phi the angle
  // between the two in 4-D, and the rotation angle is 2 phi for the nearer sign.
  const minus = Math.sqrt(dx * dx + dy * dy + dz * dz + dw * dw);
  const plus = Math.sqrt(sx * sx + sy * sy + sz * sz + sw * sw);
  return 4 * Math.atan2(Math.min(minus, plus), Math.max(minus, plus));
}

// ------------------------------------------------------------------------------------------ near tier

/** Near-tier attitude grid: 2^-15 per unit, so the three smallest components fit an i16. */
export const NEAR_ATT_SCALE = 32_768;
/** Near-tier units per metre and per m/s (1 mm, 1 mm/s), and when coarse (1 m, 1 m/s). */
export const NEAR_FINE = 1000;
export const NEAR_COARSE = 1;

/** Smallest three of a unit quaternion on the near grid: [largest index, a, b, c]. */
export function nearAttitude(q: Quat): [0 | 1 | 2 | 3, number, number, number] {
  scratchCur[0] = q.x;
  scratchCur[1] = q.y;
  scratchCur[2] = q.z;
  scratchCur[3] = q.w;
  const L = largestIndex(scratchCur);
  others(scratchCur, L, scratchCur[L]! < 0 ? -1 : 1, scratchVal);
  return [L, Math.round(scratchVal[0]! * NEAR_ATT_SCALE), Math.round(scratchVal[1]! * NEAR_ATT_SCALE), Math.round(scratchVal[2]! * NEAR_ATT_SCALE)];
}

/** The unit quaternion of a near-tier attitude. */
export function nearQuat(L: 0 | 1 | 2 | 3, qa: number, qb: number, qc: number, out: Quat): Quat {
  const a = qa / NEAR_ATT_SCALE;
  const b = qb / NEAR_ATT_SCALE;
  const c = qc / NEAR_ATT_SCALE;
  setQuat(out, L, Math.sqrt(Math.max(0, 1 - a * a - b * b - c * c)), a, b, c);
  return out;
}
