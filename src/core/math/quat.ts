import type { Vec3 } from './vec3';
import { v3 } from './vec3';

/**
 * Unit quaternions, Hamilton convention, scalar last in storage ({x, y, z, w}).
 *
 * CONVENTION (binding for the whole code base):
 *  - `rotate(q, v)` is the ACTIVE rotation q v q*.
 *  - A quaternion named `qAToB` (or documented "A -> B") maps the COMPONENTS of a vector expressed in
 *    frame A to its components in frame B: v_B = rotate(qAToB, v_A). Equivalently it is the orientation
 *    of frame A's axes as seen from frame B.
 *  - `mul(a, b)` composes so that rotate(mul(a, b), v) = rotate(a, rotate(b, v))  (b is applied first).
 *    Hence qAToC = mul(qBToC, qAToB).
 *  - Right-handed frames; positive angle = counter-clockwise when looking down the axis toward the origin.
 */
export interface Quat {
  x: number;
  y: number;
  z: number;
  w: number;
}
export type QuatTuple = [number, number, number, number];

export const quat = {
  identity: (): Quat => ({ x: 0, y: 0, z: 0, w: 1 }),
  clone: (q: Quat): Quat => ({ x: q.x, y: q.y, z: q.z, w: q.w }),
  fromTuple: (t: Readonly<QuatTuple>): Quat => ({ x: t[0], y: t[1], z: t[2], w: t[3] }),
  toTuple: (q: Quat): QuatTuple => [q.x, q.y, q.z, q.w],
  fromAxisAngle: (axis: Vec3, angle: number): Quat => {
    const n = v3.normalize(axis);
    const s = Math.sin(angle / 2);
    return { x: n.x * s, y: n.y * s, z: n.z * s, w: Math.cos(angle / 2) };
  },
  /** Quaternion for a rotation vector (axis * angle, radians). Exact for any magnitude, stable near zero. */
  fromRotVec: (r: Vec3): Quat => {
    const angle = Math.hypot(r.x, r.y, r.z);
    if (angle < 1e-9) {
      return quat.normalize({ x: r.x / 2, y: r.y / 2, z: r.z / 2, w: 1 });
    }
    const s = Math.sin(angle / 2) / angle;
    return { x: r.x * s, y: r.y * s, z: r.z * s, w: Math.cos(angle / 2) };
  },
  /** Rotation vector (axis * angle) with angle in [0, pi]. */
  toRotVec: (q: Quat): Vec3 => {
    const sgn = q.w < 0 ? -1 : 1;
    const s = Math.hypot(q.x, q.y, q.z);
    if (s < 1e-12) return { x: 2 * q.x * sgn, y: 2 * q.y * sgn, z: 2 * q.z * sgn };
    const k = (2 * Math.atan2(s, q.w * sgn) * sgn) / s;
    return { x: q.x * k, y: q.y * k, z: q.z * k };
  },
  mul: (a: Quat, b: Quat): Quat => ({
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
  }),
  conj: (q: Quat): Quat => ({ x: -q.x, y: -q.y, z: -q.z, w: q.w }),
  normalize: (q: Quat): Quat => {
    const l = Math.hypot(q.x, q.y, q.z, q.w);
    return l > 0 ? { x: q.x / l, y: q.y / l, z: q.z / l, w: q.w / l } : { x: 0, y: 0, z: 0, w: 1 };
  },
  rotate: (q: Quat, v: Vec3): Vec3 => {
    // v + 2 w (u x v) + 2 u x (u x v), u = (x, y, z)
    const tx = 2 * (q.y * v.z - q.z * v.y);
    const ty = 2 * (q.z * v.x - q.x * v.z);
    const tz = 2 * (q.x * v.y - q.y * v.x);
    return {
      x: v.x + q.w * tx + (q.y * tz - q.z * ty),
      y: v.y + q.w * ty + (q.z * tx - q.x * tz),
      z: v.z + q.w * tz + (q.x * ty - q.y * tx),
    };
  },
  /** rotate(conj(q), v). */
  rotateInv: (q: Quat, v: Vec3): Vec3 => quat.rotate({ x: -q.x, y: -q.y, z: -q.z, w: q.w }, v),
  /** Shortest-arc rotation taking unit vector `from` to unit vector `to`. */
  fromTo: (from: Vec3, to: Vec3): Quat => {
    const d = v3.dot(from, to);
    if (d < -1 + 1e-12) return quat.fromAxisAngle(v3.anyOrthogonal(from), Math.PI);
    const c = v3.cross(from, to);
    return quat.normalize({ x: c.x, y: c.y, z: c.z, w: 1 + d });
  },
  /**
   * Quaternion "local -> parent" from the parent-frame components of the local frame's unit axes
   * (must be orthonormal and right-handed).
   */
  fromBasis: (xAxis: Vec3, yAxis: Vec3, zAxis: Vec3): Quat => {
    const m00 = xAxis.x;
    const m01 = yAxis.x;
    const m02 = zAxis.x;
    const m10 = xAxis.y;
    const m11 = yAxis.y;
    const m12 = zAxis.y;
    const m20 = xAxis.z;
    const m21 = yAxis.z;
    const m22 = zAxis.z;
    const tr = m00 + m11 + m22;
    let q: Quat;
    if (tr > 0) {
      const s = Math.sqrt(tr + 1) * 2;
      q = { w: s / 4, x: (m21 - m12) / s, y: (m02 - m20) / s, z: (m10 - m01) / s };
    } else if (m00 > m11 && m00 > m22) {
      const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
      q = { w: (m21 - m12) / s, x: s / 4, y: (m01 + m10) / s, z: (m02 + m20) / s };
    } else if (m11 > m22) {
      const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
      q = { w: (m02 - m20) / s, x: (m01 + m10) / s, y: s / 4, z: (m12 + m21) / s };
    } else {
      const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
      q = { w: (m10 - m01) / s, x: (m02 + m20) / s, y: (m12 + m21) / s, z: s / 4 };
    }
    return quat.normalize(q);
  },
  slerp: (a: Quat, b: Quat, t: number): Quat => {
    let d = a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w;
    const sgn = d < 0 ? -1 : 1;
    d *= sgn;
    if (d > 1 - 1e-10) {
      return quat.normalize({
        x: a.x + (b.x * sgn - a.x) * t,
        y: a.y + (b.y * sgn - a.y) * t,
        z: a.z + (b.z * sgn - a.z) * t,
        w: a.w + (b.w * sgn - a.w) * t,
      });
    }
    const th = Math.acos(d);
    const sa = Math.sin((1 - t) * th) / Math.sin(th);
    const sb = (Math.sin(t * th) / Math.sin(th)) * sgn;
    return { x: a.x * sa + b.x * sb, y: a.y * sa + b.y * sb, z: a.z * sa + b.z * sb, w: a.w * sa + b.w * sb };
  },
  /** Angle of the relative rotation between two orientations, radians in [0, pi]. */
  angleBetween: (a: Quat, b: Quat): number => {
    const d = Math.abs(a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w);
    return 2 * Math.acos(Math.min(1, d));
  },
  isFinite: (q: Quat): boolean =>
    Number.isFinite(q.x) && Number.isFinite(q.y) && Number.isFinite(q.z) && Number.isFinite(q.w),
};
