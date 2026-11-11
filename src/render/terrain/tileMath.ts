/**
 * Float64 geometry of cube-sphere tiles for the renderer: the tile frame of the stable vertex formula
 * (rendering-design 2.3), exact distances from an observer to a tile's shell patch, bounding spheres and
 * horizon tests. Pure maths, no GPU: unit-tested in Node.
 *
 * A tile's VOLUME is its shell patch: every point r * d with d a direction inside the tile's footprint
 * (a spherical quadrilateral bounded by four great-circle arcs, because tile edges are straight lines in
 * gnomonic space) and r between R + hMin and R + hMax. Every vertex the GPU can produce for the tile lies in
 * that volume, so distances to it are true lower bounds of vertex distances - which is what makes the
 * CDLOD ranges and the morph window agree between the CPU selection and the vertex shader.
 */
import { CUBE_FACES, type FaceId, type TileKey } from '@/core/geo/cubeSphere';
import type { Vec3 } from '@/core/math';

export interface TileFrame {
  /** Unit direction of the tile centre (body-fixed). */
  cHat: Vec3;
  /**
   * Cube-space tangent steps divided by |Pc|: dir(u, v) = normalize(cHat + (u - 0.5) a + (v - 0.5) b).
   * Linear in (u, v), so shared edges of neighbouring tiles coincide.
   */
  a: Vec3;
  b: Vec3;
  /** Unit directions of the corners (u, v) = (0,0), (1,0), (1,1), (0,1): counter-clockwise seen from outside. */
  corners: [Vec3, Vec3, Vec3, Vec3];
  /** Unit inward normals of the four great-circle edge planes (edge i runs from corner i to corner i + 1). */
  edgeNormals: [Vec3, Vec3, Vec3, Vec3];
}

const norm = (x: number, y: number, z: number): Vec3 => {
  const l = Math.hypot(x, y, z);
  return { x: x / l, y: y / l, z: z / l };
};
const cross = (p: Vec3, q: Vec3): Vec3 => ({ x: p.y * q.z - p.z * q.y, y: p.z * q.x - p.x * q.z, z: p.x * q.y - p.y * q.x });
const dot = (p: Vec3, q: Vec3): number => p.x * q.x + p.y * q.y + p.z * q.z;

export function tileFrame(key: TileKey): TileFrame {
  const f = CUBE_FACES[key.face]!;
  const n = 2 ** key.level;
  const ds = 2 / n;
  const sc = -1 + ds * (key.x + 0.5);
  const tc = -1 + ds * (key.y + 0.5);
  const px = f.n[0] + sc * f.u[0] + tc * f.v[0];
  const py = f.n[1] + sc * f.u[1] + tc * f.v[1];
  const pz = f.n[2] + sc * f.u[2] + tc * f.v[2];
  const l = Math.hypot(px, py, pz);
  const k = ds / l;
  const cHat = { x: px / l, y: py / l, z: pz / l };
  const a = { x: f.u[0] * k, y: f.u[1] * k, z: f.u[2] * k };
  const b = { x: f.v[0] * k, y: f.v[1] * k, z: f.v[2] * k };
  const corner = (u: number, v: number): Vec3 => norm(cHat.x + (u - 0.5) * a.x + (v - 0.5) * b.x, cHat.y + (u - 0.5) * a.y + (v - 0.5) * b.y, cHat.z + (u - 0.5) * a.z + (v - 0.5) * b.z);
  const corners: TileFrame['corners'] = [corner(0, 0), corner(1, 0), corner(1, 1), corner(0, 1)];
  const en = (i: number): Vec3 => {
    const c = cross(corners[i]!, corners[(i + 1) & 3]!);
    return norm(c.x, c.y, c.z);
  };
  return { cHat, a, b, corners, edgeNormals: [en(0), en(1), en(2), en(3)] };
}

/** Unit direction of tile-local (u, v) from the frame (the float64 twin of the vertex shader). */
export function frameDir(fr: TileFrame, u: number, v: number): Vec3 {
  return norm(fr.cHat.x + (u - 0.5) * fr.a.x + (v - 0.5) * fr.b.x, fr.cHat.y + (u - 0.5) * fr.a.y + (v - 0.5) * fr.b.y, fr.cHat.z + (u - 0.5) * fr.a.z + (v - 0.5) * fr.b.z);
}

/** Angle between two unit vectors, accurate for tiny angles (chord form). */
function angleBetween(p: Vec3, q: Vec3): number {
  const c = Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z);
  return c >= 2 ? Math.PI : 2 * Math.asin(c / 2);
}

/** Smallest angle (rad) between unit direction `p` and the tile's footprint; 0 when `p` is inside it. */
export function angleToFootprint(fr: TileFrame, p: Vec3): number {
  const m = fr.edgeNormals;
  const s0 = dot(p, m[0]);
  const s1 = dot(p, m[1]);
  const s2 = dot(p, m[2]);
  const s3 = dot(p, m[3]);
  if (s0 >= 0 && s1 >= 0 && s2 >= 0 && s3 >= 0 && dot(p, fr.cHat) > 0) return 0;
  let best = Math.PI;
  for (let i = 0; i < 4; i++) {
    const mi = m[i]!;
    const s = i === 0 ? s0 : i === 1 ? s1 : i === 2 ? s2 : s3;
    const A = fr.corners[i]!;
    const B = fr.corners[(i + 1) & 3]!;
    // Foot of p on the great circle of this edge.
    const qx = p.x - s * mi.x;
    const qy = p.y - s * mi.y;
    const qz = p.z - s * mi.z;
    const ql = Math.hypot(qx, qy, qz);
    let ang: number;
    if (ql > 1e-12) {
      const q = { x: qx / ql, y: qy / ql, z: qz / ql };
      // Inside the arc when q lies counter-clockwise of A and clockwise of B about the edge normal.
      if (dot(cross(A, q), mi) >= 0 && dot(cross(q, B), mi) >= 0) ang = Math.asin(Math.min(1, Math.abs(s)));
      else ang = Math.min(angleBetween(p, A), angleBetween(p, B));
    } else {
      ang = Math.min(angleBetween(p, A), angleBetween(p, B));
    }
    if (ang < best) best = ang;
  }
  return best;
}

/**
 * Exact smallest distance (m) from a point at radius `rEye` in unit direction `dirEye` to the shell patch
 * of the tile between radii `r1` <= `r2`.
 */
export function shellDistance(fr: TileFrame, dirEye: Vec3, rEye: number, r1: number, r2: number): number {
  const theta = angleToFootprint(fr, dirEye);
  if (theta === 0) return Math.max(0, rEye - r2, r1 - rEye);
  const rs = Math.min(r2, Math.max(r1, rEye * Math.cos(theta)));
  const sh = Math.sin(theta / 2);
  const dr = rEye - rs;
  return Math.sqrt(dr * dr + 4 * rEye * rs * sh * sh);
}

export interface BoundSphere {
  /** Centre in the body-fixed frame (m) and radius (m). */
  cx: number;
  cy: number;
  cz: number;
  r: number;
}

/** Bounding sphere of the shell patch (corners are its farthest points from the centre line). */
export function shellBoundSphere(fr: TileFrame, r1: number, r2: number): BoundSphere {
  const rc = 0.5 * (r1 + r2);
  const cx = fr.cHat.x * rc;
  const cy = fr.cHat.y * rc;
  const cz = fr.cHat.z * rc;
  let r = 0;
  for (const c of fr.corners) {
    r = Math.max(r, Math.hypot(c.x * r2 - cx, c.y * r2 - cy, c.z * r2 - cz), Math.hypot(c.x * r1 - cx, c.y * r1 - cy, c.z * r1 - cz));
  }
  // The patch bulges beyond the chord between corners by (1 - cos(half angle)) of its radius.
  const half = angleBetween(fr.corners[0], fr.corners[2]) * 0.5;
  r += r2 * (1 - Math.cos(half)) * 0.5;
  return { cx, cy, cz, r: r * 1.001 };
}

/**
 * Is the point `p` (body-fixed, m) hidden from `eye` by the sphere of radius `rOcc` about the body centre?
 * (Cesium's occluder test: beyond the tangent plane of the horizon and inside the horizon cone.)
 */
export function pointBelowHorizon(eye: Vec3, eyeLenSq: number, rOcc: number, px: number, py: number, pz: number): boolean {
  const vh = eyeLenSq - rOcc * rOcc;
  if (vh <= 0) return false;
  const vx = px - eye.x;
  const vy = py - eye.y;
  const vz = pz - eye.z;
  const vtDotVc = -(vx * eye.x + vy * eye.y + vz * eye.z);
  return vtDotVc > vh && (vtDotVc * vtDotVc) / (vx * vx + vy * vy + vz * vz) > vh;
}

/** True when the whole shell patch up to radius `r2` is below the horizon of the occluder sphere. */
export function patchBelowHorizon(fr: TileFrame, eye: Vec3, eyeLenSq: number, rOcc: number, r2: number): boolean {
  if (eyeLenSq <= rOcc * rOcc) return false;
  // The eye above the patch always sees it.
  const el = Math.sqrt(eyeLenSq);
  if (angleToFootprint(fr, { x: eye.x / el, y: eye.y / el, z: eye.z / el }) === 0) return false;
  for (let j = 0; j <= 2; j++) {
    for (let i = 0; i <= 2; i++) {
      const d = frameDir(fr, i * 0.5, j * 0.5);
      if (!pointBelowHorizon(eye, eyeLenSq, rOcc, d.x * r2, d.y * r2, d.z * r2)) return false;
    }
  }
  return true;
}

/** Numeric key of a tile (unique per body): 3 bits face, 5 bits level, 20 bits x, 20 bits y. */
export function tileId(face: FaceId, level: number, x: number, y: number): number {
  return ((face * 32 + level) * 1048576 + x) * 1048576 + y;
}

/**
 * The stable vertex formula on the CPU with float32 rounding at every step the shader takes (the twin of
 * `tileLocal` in the WGSL): body-fixed offset of the vertex from the tile origin (R + h0) cHat.
 */
export function tileLocalF32(fr: { cHat: Vec3; a: Vec3; b: Vec3 }, u: number, v: number, h: number, radius: number, h0: number): Vec3 {
  const f = Math.fround;
  const du = f(u - 0.5);
  const dv = f(v - 0.5);
  const dx = f(f(du * f(fr.a.x)) + f(dv * f(fr.b.x)));
  const dy = f(f(du * f(fr.a.y)) + f(dv * f(fr.b.y)));
  const dz = f(f(du * f(fr.a.z)) + f(dv * f(fr.b.z)));
  const cx = f(fr.cHat.x);
  const cy = f(fr.cHat.y);
  const cz = f(fr.cHat.z);
  const e = f(f(2 * f(f(f(cx * dx) + f(cy * dy)) + f(cz * dz))) + f(f(f(dx * dx) + f(dy * dy)) + f(dz * dz)));
  const s = f(Math.sqrt(f(1 + e)));
  const inv = f(-e / f(s * f(1 + s)));
  const k = f(1 + inv);
  const rr = f(f(radius) + f(h));
  const dh = f(f(h) - f(h0));
  return {
    x: f(f(rr * f(f(dx * k) + f(cx * inv))) + f(dh * cx)),
    y: f(f(rr * f(f(dy * k) + f(cy * inv))) + f(dh * cy)),
    z: f(f(rr * f(f(dz * k) + f(cz * inv))) + f(dh * cz)),
  };
}
