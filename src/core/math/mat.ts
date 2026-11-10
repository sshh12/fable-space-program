import type { Quat } from './quat';
import type { Vec3 } from './vec3';

/**
 * 3x3 float64 matrix, ROW-major: m[3 * row + col]. Used for inertia tensors and rotation matrices on the CPU.
 * A rotation matrix built from `qAToB` maps components in A to components in B: v_B = M v_A.
 */
export type Mat3 = [number, number, number, number, number, number, number, number, number];

export const mat3 = {
  identity: (): Mat3 => [1, 0, 0, 0, 1, 0, 0, 0, 1],
  zero: (): Mat3 => [0, 0, 0, 0, 0, 0, 0, 0, 0],
  diag: (a: number, b: number, c: number): Mat3 => [a, 0, 0, 0, b, 0, 0, 0, c],
  fromQuat: (q: Quat): Mat3 => {
    const { x, y, z, w } = q;
    const xx = x * x;
    const yy = y * y;
    const zz = z * z;
    const xy = x * y;
    const xz = x * z;
    const yz = y * z;
    const wx = w * x;
    const wy = w * y;
    const wz = w * z;
    return [
      1 - 2 * (yy + zz),
      2 * (xy - wz),
      2 * (xz + wy),
      2 * (xy + wz),
      1 - 2 * (xx + zz),
      2 * (yz - wx),
      2 * (xz - wy),
      2 * (yz + wx),
      1 - 2 * (xx + yy),
    ];
  },
  mulVec: (m: Readonly<Mat3>, v: Vec3): Vec3 => ({
    x: m[0] * v.x + m[1] * v.y + m[2] * v.z,
    y: m[3] * v.x + m[4] * v.y + m[5] * v.z,
    z: m[6] * v.x + m[7] * v.y + m[8] * v.z,
  }),
  mul: (a: Readonly<Mat3>, b: Readonly<Mat3>): Mat3 => [
    a[0] * b[0] + a[1] * b[3] + a[2] * b[6],
    a[0] * b[1] + a[1] * b[4] + a[2] * b[7],
    a[0] * b[2] + a[1] * b[5] + a[2] * b[8],
    a[3] * b[0] + a[4] * b[3] + a[5] * b[6],
    a[3] * b[1] + a[4] * b[4] + a[5] * b[7],
    a[3] * b[2] + a[4] * b[5] + a[5] * b[8],
    a[6] * b[0] + a[7] * b[3] + a[8] * b[6],
    a[6] * b[1] + a[7] * b[4] + a[8] * b[7],
    a[6] * b[2] + a[7] * b[5] + a[8] * b[8],
  ],
  transpose: (m: Readonly<Mat3>): Mat3 => [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]],
  add: (a: Readonly<Mat3>, b: Readonly<Mat3>): Mat3 => [
    a[0] + b[0],
    a[1] + b[1],
    a[2] + b[2],
    a[3] + b[3],
    a[4] + b[4],
    a[5] + b[5],
    a[6] + b[6],
    a[7] + b[7],
    a[8] + b[8],
  ],
  scale: (m: Readonly<Mat3>, s: number): Mat3 => [
    m[0] * s,
    m[1] * s,
    m[2] * s,
    m[3] * s,
    m[4] * s,
    m[5] * s,
    m[6] * s,
    m[7] * s,
    m[8] * s,
  ],
  det: (m: Readonly<Mat3>): number =>
    m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * m[7] - m[4] * m[6]),
  /** Inverse; throws if singular. */
  invert: (m: Readonly<Mat3>): Mat3 => {
    const d = mat3.det(m);
    if (!(Math.abs(d) > 0)) throw new Error('mat3.invert: singular matrix');
    const i = 1 / d;
    return [
      (m[4] * m[8] - m[5] * m[7]) * i,
      (m[2] * m[7] - m[1] * m[8]) * i,
      (m[1] * m[5] - m[2] * m[4]) * i,
      (m[5] * m[6] - m[3] * m[8]) * i,
      (m[0] * m[8] - m[2] * m[6]) * i,
      (m[2] * m[3] - m[0] * m[5]) * i,
      (m[3] * m[7] - m[4] * m[6]) * i,
      (m[1] * m[6] - m[0] * m[7]) * i,
      (m[0] * m[4] - m[1] * m[3]) * i,
    ];
  },
  /** R * M * R^T: express a tensor given in the local frame in the parent frame (R = local -> parent). */
  rotateTensor: (r: Readonly<Mat3>, m: Readonly<Mat3>): Mat3 => mat3.mul(mat3.mul(r, m), mat3.transpose(r)),
  /** Column-major Float32Array(12) with vec4 column padding, as WGSL `mat3x3f` is laid out in a uniform buffer. */
  toGpu: (m: Readonly<Mat3>, out = new Float32Array(12)): Float32Array => {
    out[0] = m[0];
    out[1] = m[3];
    out[2] = m[6];
    out[3] = 0;
    out[4] = m[1];
    out[5] = m[4];
    out[6] = m[7];
    out[7] = 0;
    out[8] = m[2];
    out[9] = m[5];
    out[10] = m[8];
    out[11] = 0;
    return out;
  },
};

/**
 * 4x4 float64 matrix, COLUMN-major: m[4 * col + row] (the WebGPU/WGSL memory layout). Clip space is WebGPU's:
 * x, y in [-1, 1], z in [0, 1]. View space is right-handed, camera looks down -Z, +Y up.
 */
export type Mat4 = Float64Array;

export const mat4 = {
  identity: (): Mat4 => new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
  /**
   * Reversed-Z, infinite-far perspective: depth = near / (-zView); sky clears to 0; depthCompare 'greater'.
   * This is THE projection of the engine (docs/ARCHITECTURE.md, "Precision").
   */
  perspectiveReversedZInfinite: (fovY: number, aspect: number, near: number): Mat4 => {
    const f = 1 / Math.tan(fovY / 2);
    return new Float64Array([f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, 0, -1, 0, 0, near, 0]);
  },
  /** Rotation-only view matrix (world -> view) from the camera orientation `qViewToWorld`. */
  viewRotation: (qViewToWorld: Quat): Mat4 => {
    const r = mat3.fromQuat({ x: -qViewToWorld.x, y: -qViewToWorld.y, z: -qViewToWorld.z, w: qViewToWorld.w });
    return new Float64Array([r[0], r[3], r[6], 0, r[1], r[4], r[7], 0, r[2], r[5], r[8], 0, 0, 0, 0, 1]);
  },
  mul: (a: Mat4, b: Mat4): Mat4 => {
    const o = new Float64Array(16);
    for (let c = 0; c < 4; c++) {
      for (let r = 0; r < 4; r++) {
        let s = 0;
        for (let k = 0; k < 4; k++) s += a[4 * k + r]! * b[4 * c + k]!;
        o[4 * c + r] = s;
      }
    }
    return o;
  },
  /** Transform a point (w = 1); returns homogeneous clip coordinates. */
  transformPoint: (m: Mat4, p: Vec3): { x: number; y: number; z: number; w: number } => ({
    x: m[0]! * p.x + m[4]! * p.y + m[8]! * p.z + m[12]!,
    y: m[1]! * p.x + m[5]! * p.y + m[9]! * p.z + m[13]!,
    z: m[2]! * p.x + m[6]! * p.y + m[10]! * p.z + m[14]!,
    w: m[3]! * p.x + m[7]! * p.y + m[11]! * p.z + m[15]!,
  }),
  toF32: (m: Mat4, out = new Float32Array(16)): Float32Array => {
    out.set(m);
    return out;
  },
};
