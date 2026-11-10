/**
 * Float64 3-vectors. Plain objects, SI units. All functions are pure unless the name ends in `To`
 * (which writes into `out` and returns it, for hot loops).
 */
export interface Vec3 {
  x: number;
  y: number;
  z: number;
}
/** JSON-friendly form used in data files. */
export type Vec3Tuple = [number, number, number];

export const v3 = {
  new: (x = 0, y = 0, z = 0): Vec3 => ({ x, y, z }),
  zero: (): Vec3 => ({ x: 0, y: 0, z: 0 }),
  unitX: (): Vec3 => ({ x: 1, y: 0, z: 0 }),
  unitY: (): Vec3 => ({ x: 0, y: 1, z: 0 }),
  unitZ: (): Vec3 => ({ x: 0, y: 0, z: 1 }),
  clone: (a: Vec3): Vec3 => ({ x: a.x, y: a.y, z: a.z }),
  copyTo: (out: Vec3, a: Vec3): Vec3 => {
    out.x = a.x;
    out.y = a.y;
    out.z = a.z;
    return out;
  },
  fromTuple: (t: Readonly<Vec3Tuple>): Vec3 => ({ x: t[0], y: t[1], z: t[2] }),
  toTuple: (a: Vec3): Vec3Tuple => [a.x, a.y, a.z],
  add: (a: Vec3, b: Vec3): Vec3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z }),
  sub: (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z }),
  scale: (a: Vec3, s: number): Vec3 => ({ x: a.x * s, y: a.y * s, z: a.z * s }),
  neg: (a: Vec3): Vec3 => ({ x: -a.x, y: -a.y, z: -a.z }),
  /** a + b * s */
  addScaled: (a: Vec3, b: Vec3, s: number): Vec3 => ({ x: a.x + b.x * s, y: a.y + b.y * s, z: a.z + b.z * s }),
  addTo: (out: Vec3, a: Vec3, b: Vec3): Vec3 => {
    out.x = a.x + b.x;
    out.y = a.y + b.y;
    out.z = a.z + b.z;
    return out;
  },
  subTo: (out: Vec3, a: Vec3, b: Vec3): Vec3 => {
    out.x = a.x - b.x;
    out.y = a.y - b.y;
    out.z = a.z - b.z;
    return out;
  },
  addScaledTo: (out: Vec3, a: Vec3, b: Vec3, s: number): Vec3 => {
    out.x = a.x + b.x * s;
    out.y = a.y + b.y * s;
    out.z = a.z + b.z * s;
    return out;
  },
  dot: (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z,
  cross: (a: Vec3, b: Vec3): Vec3 => ({
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  }),
  lenSq: (a: Vec3): number => a.x * a.x + a.y * a.y + a.z * a.z,
  len: (a: Vec3): number => Math.hypot(a.x, a.y, a.z),
  dist: (a: Vec3, b: Vec3): number => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z),
  /** Unit vector; returns +X for a zero-length input (never NaN). */
  normalize: (a: Vec3): Vec3 => {
    const l = Math.hypot(a.x, a.y, a.z);
    return l > 0 ? { x: a.x / l, y: a.y / l, z: a.z / l } : { x: 1, y: 0, z: 0 };
  },
  lerp: (a: Vec3, b: Vec3, t: number): Vec3 => ({
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
    z: a.z + (b.z - a.z) * t,
  }),
  /** Angle between two vectors in radians, numerically stable near 0 and pi. */
  angle: (a: Vec3, b: Vec3): number => {
    const c = v3.cross(a, b);
    return Math.atan2(Math.hypot(c.x, c.y, c.z), v3.dot(a, b));
  },
  /** Component of `a` orthogonal to unit vector `n`. */
  reject: (a: Vec3, n: Vec3): Vec3 => v3.addScaled(a, n, -v3.dot(a, n)),
  /** Any unit vector orthogonal to `a` (a need not be unit). */
  anyOrthogonal: (a: Vec3): Vec3 => {
    const ax = Math.abs(a.x);
    const ay = Math.abs(a.y);
    const az = Math.abs(a.z);
    const other: Vec3 =
      ax <= ay && ax <= az ? { x: 1, y: 0, z: 0 } : ay <= az ? { x: 0, y: 1, z: 0 } : { x: 0, y: 0, z: 1 };
    return v3.normalize(v3.cross(a, other));
  },
  isFinite: (a: Vec3): boolean => Number.isFinite(a.x) && Number.isFinite(a.y) && Number.isFinite(a.z),
  equalsApprox: (a: Vec3, b: Vec3, eps = 1e-12): boolean =>
    Math.abs(a.x - b.x) <= eps && Math.abs(a.y - b.y) <= eps && Math.abs(a.z - b.z) <= eps,
};
