/**
 * Mesh checks shared by the unit tests and the lab's model report: unit normals, orthonormal tangents,
 * degenerate triangles, per-component watertightness, bounding cylinder, axis-parallel ray casts.
 */
import type { MeshData } from '@/core/contracts/render';
import type { BuiltMesh } from './builder';

export interface MeshReport {
  vertices: number;
  triangles: number;
  /** Vertices whose normal is not unit length within 1e-3. */
  badNormals: number;
  /** Vertices whose tangent is not unit, not orthogonal to the normal (2e-3) or has a handedness other than +-1. */
  badTangents: number;
  /** Triangles with a repeated vertex or an area below 1e-10 m^2. */
  degenerate: number;
  /** Components declared closed that are not watertight: [component, tag, open or mismatched edges]. */
  leaks: [number, string, number][];
  /** Boundary edges of the components declared open, per tag. */
  openEdges: Record<string, number>;
  /** Triangles whose winding disagrees with their vertex normals, in total and per component tag. */
  flipped: number;
  flippedByTag: Record<string, number>;
  /** Closed components with a non-positive signed volume (built inside-out): [component, tag]. */
  insideOut: [number, string][];
}

/** Weld vertices by position (grid of `eps` metres); returns a welded id per vertex. */
export function weld(positions: Float32Array, eps = 2e-5): Uint32Array {
  const n = positions.length / 3;
  const ids = new Uint32Array(n);
  const map = new Map<string, number>();
  for (let i = 0; i < n; i++) {
    const key = `${Math.round(positions[i * 3]! / eps)},${Math.round(positions[i * 3 + 1]! / eps)},${Math.round(positions[i * 3 + 2]! / eps)}`;
    let id = map.get(key);
    if (id === undefined) {
      id = map.size;
      map.set(key, id);
    }
    ids[i] = id;
  }
  return ids;
}

export function checkMesh(mesh: BuiltMesh): MeshReport {
  const { positions: P, normals: N, tangents: T, indices: I } = mesh;
  const nv = P.length / 3;
  const report: MeshReport = { vertices: nv, triangles: I.length / 3, badNormals: 0, badTangents: 0, degenerate: 0, leaks: [], openEdges: {}, flipped: 0, flippedByTag: {}, insideOut: [] };
  const volume = new Float64Array(mesh.meta.closed.length);
  const centre = new Float64Array(mesh.meta.closed.length * 3);
  const centreN = new Uint32Array(mesh.meta.closed.length);
  for (let t = 0; t < I.length / 3; t++) {
    const c = mesh.meta.triComponent[t]!;
    for (let k = 0; k < 3; k++) {
      const v = I[t * 3 + k]! * 3;
      centre[c * 3] = centre[c * 3]! + P[v]!;
      centre[c * 3 + 1] = centre[c * 3 + 1]! + P[v + 1]!;
      centre[c * 3 + 2] = centre[c * 3 + 2]! + P[v + 2]!;
    }
    centreN[c] = centreN[c]! + 3;
  }
  for (let i = 0; i < nv; i++) {
    const nx = N[i * 3]!;
    const ny = N[i * 3 + 1]!;
    const nz = N[i * 3 + 2]!;
    if (Math.abs(Math.hypot(nx, ny, nz) - 1) > 1e-3) report.badNormals++;
    const tx = T[i * 4]!;
    const ty = T[i * 4 + 1]!;
    const tz = T[i * 4 + 2]!;
    const w = T[i * 4 + 3]!;
    if (Math.abs(Math.hypot(tx, ty, tz) - 1) > 1e-3 || Math.abs(tx * nx + ty * ny + tz * nz) > 2e-3 || Math.abs(Math.abs(w) - 1) > 1e-6) report.badTangents++;
  }
  const ids = weld(P);
  const comps = mesh.meta.closed.length;
  const edges: Map<number, number>[] = [];
  for (let c = 0; c < comps; c++) edges.push(new Map());
  const stride = ids.reduce((m, x) => (x > m ? x : m), 0) + 1;
  for (let t = 0; t < I.length / 3; t++) {
    const a = I[t * 3]!;
    const b = I[t * 3 + 1]!;
    const c = I[t * 3 + 2]!;
    const wa = ids[a]!;
    const wb = ids[b]!;
    const wc = ids[c]!;
    const ux = P[b * 3]! - P[a * 3]!;
    const uy = P[b * 3 + 1]! - P[a * 3 + 1]!;
    const uz = P[b * 3 + 2]! - P[a * 3 + 2]!;
    const vx = P[c * 3]! - P[a * 3]!;
    const vy = P[c * 3 + 1]! - P[a * 3 + 1]!;
    const vz = P[c * 3 + 2]! - P[a * 3 + 2]!;
    const gx = uy * vz - uz * vy;
    const gy = uz * vx - ux * vz;
    const gz = ux * vy - uy * vx;
    const area = 0.5 * Math.hypot(gx, gy, gz);
    if (wa === wb || wb === wc || wa === wc || area < 1e-10) {
      report.degenerate++;
      continue;
    }
    const comp = mesh.meta.triComponent[t]!;
    if (gx * (N[a * 3]! + N[b * 3]! + N[c * 3]!) + gy * (N[a * 3 + 1]! + N[b * 3 + 1]! + N[c * 3 + 1]!) + gz * (N[a * 3 + 2]! + N[b * 3 + 2]! + N[c * 3 + 2]!) <= 0) {
      report.flipped++;
      const tag = mesh.meta.tags[comp] ?? '';
      report.flippedByTag[tag] = (report.flippedByTag[tag] ?? 0) + 1;
    }
    {
      // Signed volume about the component's centroid (numerically safe far from the origin).
      const n = centreN[comp]!;
      const ox = centre[comp * 3]! / n;
      const oy = centre[comp * 3 + 1]! / n;
      const oz = centre[comp * 3 + 2]! / n;
      volume[comp] = volume[comp]! + (gx * (P[a * 3]! - ox) + gy * (P[a * 3 + 1]! - oy) + gz * (P[a * 3 + 2]! - oz)) / 6;
    }
    const m = edges[comp]!;
    // Directed edge count: +1 for a -> b with a < b, -1 for the opposite direction.
    for (const [x, y] of [
      [wa, wb],
      [wb, wc],
      [wc, wa],
    ] as const) {
      const key = x < y ? x * stride + y : y * stride + x;
      const prev = m.get(key) ?? 0;
      // Low 16 bits: uses in one direction; high bits: uses in the other.
      m.set(key, prev + (x < y ? 1 : 65536));
    }
  }
  for (let c = 0; c < comps; c++) {
    let bad = 0;
    for (const v of edges[c]!.values()) if (v !== 65537) bad++;
    const tag = mesh.meta.tags[c] ?? '';
    if (mesh.meta.closed[c]) {
      if (bad > 0) report.leaks.push([c, tag, bad]);
      else if (edges[c]!.size > 0 && !(volume[c]! > 0)) report.insideOut.push([c, tag]);
    } else if (bad > 0) report.openEdges[tag] = (report.openEdges[tag] ?? 0) + bad;
  }
  return report;
}

/** Bounding cylinder about the Y axis. */
export function boundingCylinder(meshes: { positions: Float32Array }[]): { radius: number; yMin: number; yMax: number } {
  let radius = 0;
  let yMin = Infinity;
  let yMax = -Infinity;
  for (const m of meshes) {
    const P = m.positions;
    for (let i = 0; i < P.length; i += 3) {
      const r = Math.hypot(P[i]!, P[i + 2]!);
      if (r > radius) radius = r;
      if (P[i + 1]! < yMin) yMin = P[i + 1]!;
      if (P[i + 1]! > yMax) yMax = P[i + 1]!;
    }
  }
  return { radius, yMin, yMax };
}

/**
 * Heights at which the vertical line through (x, z) crosses the mesh (every triangle, both facings),
 * limited to [yLo, yHi].
 */
export function verticalHits(mesh: Pick<MeshData, 'positions' | 'indices'>, x: number, z: number, yLo: number, yHi: number): number[] {
  const P = mesh.positions;
  const I = mesh.indices;
  const out: number[] = [];
  for (let t = 0; t < I.length; t += 3) {
    const a = I[t]! * 3;
    const b = I[t + 1]! * 3;
    const c = I[t + 2]! * 3;
    const ax = P[a]! - x;
    const az = P[a + 2]! - z;
    const bx = P[b]! - x;
    const bz = P[b + 2]! - z;
    const cx = P[c]! - x;
    const cz = P[c + 2]! - z;
    // Signed areas of the sub-triangles in the XZ projection.
    const w0 = bx * cz - bz * cx;
    const w1 = cx * az - cz * ax;
    const w2 = ax * bz - az * bx;
    if (!((w0 >= 0 && w1 >= 0 && w2 >= 0) || (w0 <= 0 && w1 <= 0 && w2 <= 0))) continue;
    const s = w0 + w1 + w2;
    if (Math.abs(s) < 1e-14) continue;
    const y = (w0 * P[a + 1]! + w1 * P[b + 1]! + w2 * P[c + 1]!) / s;
    if (y >= yLo && y <= yHi) out.push(y);
  }
  return out;
}

/** Shortest distance from a point to the triangles of a mesh. */
export function distanceToMesh(mesh: Pick<MeshData, 'positions' | 'indices'>, p: [number, number, number], maxDist = Infinity): number {
  const P = mesh.positions;
  const I = mesh.indices;
  let best = maxDist;
  for (let t = 0; t < I.length; t += 3) {
    const d = pointTriangle(p, P, I[t]! * 3, I[t + 1]! * 3, I[t + 2]! * 3);
    if (d < best) best = d;
  }
  return best;
}

function pointTriangle(p: [number, number, number], P: Float32Array, a: number, b: number, c: number): number {
  // Ericson, Real-Time Collision Detection, closest point on a triangle.
  const ax = P[a]!;
  const ay = P[a + 1]!;
  const az = P[a + 2]!;
  const abx = P[b]! - ax;
  const aby = P[b + 1]! - ay;
  const abz = P[b + 2]! - az;
  const acx = P[c]! - ax;
  const acy = P[c + 1]! - ay;
  const acz = P[c + 2]! - az;
  const apx = p[0] - ax;
  const apy = p[1] - ay;
  const apz = p[2] - az;
  const d1 = abx * apx + aby * apy + abz * apz;
  const d2 = acx * apx + acy * apy + acz * apz;
  let qx: number;
  let qy: number;
  let qz: number;
  if (d1 <= 0 && d2 <= 0) {
    qx = ax;
    qy = ay;
    qz = az;
  } else {
    const bpx = p[0] - P[b]!;
    const bpy = p[1] - P[b + 1]!;
    const bpz = p[2] - P[b + 2]!;
    const d3 = abx * bpx + aby * bpy + abz * bpz;
    const d4 = acx * bpx + acy * bpy + acz * bpz;
    const cpx = p[0] - P[c]!;
    const cpy = p[1] - P[c + 1]!;
    const cpz = p[2] - P[c + 2]!;
    const d5 = abx * cpx + aby * cpy + abz * cpz;
    const d6 = acx * cpx + acy * cpy + acz * cpz;
    const vc = d1 * d4 - d3 * d2;
    const vb = d5 * d2 - d1 * d6;
    const va = d3 * d6 - d5 * d4;
    if (d3 >= 0 && d4 <= d3) {
      qx = P[b]!;
      qy = P[b + 1]!;
      qz = P[b + 2]!;
    } else if (d6 >= 0 && d5 <= d6) {
      qx = P[c]!;
      qy = P[c + 1]!;
      qz = P[c + 2]!;
    } else if (vc <= 0 && d1 >= 0 && d3 <= 0) {
      const v = d1 / (d1 - d3);
      qx = ax + abx * v;
      qy = ay + aby * v;
      qz = az + abz * v;
    } else if (vb <= 0 && d2 >= 0 && d6 <= 0) {
      const w = d2 / (d2 - d6);
      qx = ax + acx * w;
      qy = ay + acy * w;
      qz = az + acz * w;
    } else if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
      const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
      qx = P[b]! + (P[c]! - P[b]!) * w;
      qy = P[b + 1]! + (P[c + 1]! - P[b + 1]!) * w;
      qz = P[b + 2]! + (P[c + 2]! - P[b + 2]!) * w;
    } else {
      const den = 1 / (va + vb + vc);
      const v = vb * den;
      const w = vc * den;
      qx = ax + abx * v + acx * w;
      qy = ay + aby * v + acy * w;
      qz = az + abz * v + acz * w;
    }
  }
  return Math.hypot(p[0] - qx, p[1] - qy, p[2] - qz);
}
