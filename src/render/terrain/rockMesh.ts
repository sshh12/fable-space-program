/**
 * Procedural rock meshes: 6 shapes x 3 levels of detail. Every shape is a star-shaped solid r(d) over the
 * unit sphere: a blend of a faceted hull (the intersection of random half-spaces: flat faces and edges)
 * and smooth lumps, sampled on icospheres of 3, 2 and 1 subdivisions, so the levels of detail share one
 * silhouette. The radius stays within ROCK_RADIUS_MIN..MAX of the unit sphere: a collidable rock is the
 * ellipsoidal cap of the height function scaled by its radius and cap height, and the mesh encloses it
 * (faces touch the cap, corners and edges stand out from it).
 */
import { hash4, hashToUnit } from '@/core/math';

export const ROCK_VARIANTS = 6;
export const ROCK_LODS = 3;
export const ROCK_RADIUS_MIN = 1.0;
export const ROCK_RADIUS_MAX = 1.55;

export interface RockMeshData {
  /** xyz position, xyz normal per vertex (6 floats). */
  vertices: Float32Array<ArrayBuffer>;
  indices: Uint16Array<ArrayBuffer>;
}

function icosphere(subdivisions: number): { positions: number[]; indices: number[] } {
  const t = (1 + Math.sqrt(5)) / 2;
  const raw = [-1, t, 0, 1, t, 0, -1, -t, 0, 1, -t, 0, 0, -1, t, 0, 1, t, 0, -1, -t, 0, 1, -t, t, 0, -1, t, 0, 1, -t, 0, -1, -t, 0, 1];
  const positions: number[] = [];
  for (let i = 0; i < raw.length; i += 3) {
    const l = Math.hypot(raw[i]!, raw[i + 1]!, raw[i + 2]!);
    positions.push(raw[i]! / l, raw[i + 1]! / l, raw[i + 2]! / l);
  }
  let indices = [0, 11, 5, 0, 5, 1, 0, 1, 7, 0, 7, 10, 0, 10, 11, 1, 5, 9, 5, 11, 4, 11, 10, 2, 10, 7, 6, 7, 1, 8, 3, 9, 4, 3, 4, 2, 3, 2, 6, 3, 6, 8, 3, 8, 9, 4, 9, 5, 2, 4, 11, 6, 2, 10, 8, 6, 7, 9, 8, 1];
  for (let s = 0; s < subdivisions; s++) {
    const cache = new Map<number, number>();
    const mid = (a: number, b: number): number => {
      const key = a < b ? a * 65536 + b : b * 65536 + a;
      let m = cache.get(key);
      if (m === undefined) {
        const x = positions[a * 3]! + positions[b * 3]!;
        const y = positions[a * 3 + 1]! + positions[b * 3 + 1]!;
        const z = positions[a * 3 + 2]! + positions[b * 3 + 2]!;
        const l = Math.hypot(x, y, z);
        m = positions.length / 3;
        positions.push(x / l, y / l, z / l);
        cache.set(key, m);
      }
      return m;
    };
    const next: number[] = [];
    for (let i = 0; i < indices.length; i += 3) {
      const a = indices[i]!;
      const b = indices[i + 1]!;
      const c = indices[i + 2]!;
      const ab = mid(a, b);
      const bc = mid(b, c);
      const ca = mid(c, a);
      next.push(a, ab, ca, b, bc, ab, c, ca, bc, ab, bc, ca);
    }
    indices = next;
  }
  return { positions, indices };
}

interface RockShape {
  /** Unit normals and distances of the hull's half-spaces. */
  planes: number[];
  /** Lump directions, widths and amplitudes. */
  lumps: number[];
  faceting: number;
}

function rockShape(variant: number): RockShape {
  const seed = 0x7f4a7c15 + variant * 977;
  const u = (i: number, j: number): number => hashToUnit(hash4(i, j, variant, seed));
  const planes: number[] = [];
  // Few faces make slabs and wedges, more make rounder boulders. Every rock has a roughly level top face.
  const count = 6 + (variant % 3) * 4;
  planes.push(0.12 * (u(90, 0) - 0.5), 0.12 * (u(90, 1) - 0.5), 1, 1.0);
  for (let i = 0; i < count; i++) {
    const z = u(i, 0) * 1.5 - 0.75;
    const a = ((i + 0.7 * u(i, 1)) / count) * 2 * Math.PI;
    const r = Math.sqrt(Math.max(0, 1 - z * z));
    // Faces sit between 1.0 and 1.12 radii from the centre: they touch the collision cap.
    planes.push(r * Math.cos(a), r * Math.sin(a), z, 1.0 + 0.12 * u(i, 2));
  }
  const lumps: number[] = [];
  for (let i = 0; i < 7; i++) {
    const z = u(i, 3) * 2 - 1;
    const a = u(i, 4) * 2 * Math.PI;
    const r = Math.sqrt(Math.max(0, 1 - z * z));
    lumps.push(r * Math.cos(a), r * Math.sin(a), z, 0.35 + 0.5 * u(i, 5), (u(i, 6) - 0.2) * 0.2);
  }
  // Variants alternate between blocky (angular ejecta) and rounded (weathered) rocks.
  return { planes, lumps, faceting: variant % 2 === 0 ? 0.95 : 0.7 };
}

/** Radius of the rock surface along unit direction (x, y, z). */
function rockRadius(shape: RockShape, x: number, y: number, z: number): number {
  let hull = Infinity;
  for (let i = 0; i < shape.planes.length; i += 4) {
    const c = x * shape.planes[i]! + y * shape.planes[i + 1]! + z * shape.planes[i + 2]!;
    if (c > 0.05) hull = Math.min(hull, shape.planes[i + 3]! / c);
  }
  hull = Math.min(hull, ROCK_RADIUS_MAX);
  let smooth = 1.12;
  for (let i = 0; i < shape.lumps.length; i += 5) {
    const c = x * shape.lumps[i]! + y * shape.lumps[i + 1]! + z * shape.lumps[i + 2]!;
    const w = shape.lumps[i + 3]!;
    const t = Math.max(0, (c - (1 - w)) / w);
    smooth += shape.lumps[i + 4]! * t * t * (3 - 2 * t);
  }
  const r = smooth + (hull - smooth) * shape.faceting;
  return Math.min(ROCK_RADIUS_MAX, Math.max(ROCK_RADIUS_MIN, r));
}

export function buildRockMesh(variant: number, lod: number): RockMeshData {
  const shape = rockShape(variant);
  const { positions, indices } = icosphere(3 - lod);
  const n = positions.length / 3;
  const vertices = new Float32Array(n * 6);
  for (let i = 0; i < n; i++) {
    const x = positions[i * 3]!;
    const y = positions[i * 3 + 1]!;
    const z = positions[i * 3 + 2]!;
    const r = rockRadius(shape, x, y, z);
    vertices[i * 6] = x * r;
    vertices[i * 6 + 1] = y * r;
    vertices[i * 6 + 2] = z * r;
  }
  // Area-weighted vertex normals of the displaced mesh.
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t]! * 6;
    const b = indices[t + 1]! * 6;
    const c = indices[t + 2]! * 6;
    const ux = vertices[b]! - vertices[a]!;
    const uy = vertices[b + 1]! - vertices[a + 1]!;
    const uz = vertices[b + 2]! - vertices[a + 2]!;
    const vx = vertices[c]! - vertices[a]!;
    const vy = vertices[c + 1]! - vertices[a + 1]!;
    const vz = vertices[c + 2]! - vertices[a + 2]!;
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    for (const o of [a, b, c]) {
      vertices[o + 3] = vertices[o + 3]! + nx;
      vertices[o + 4] = vertices[o + 4]! + ny;
      vertices[o + 5] = vertices[o + 5]! + nz;
    }
  }
  for (let i = 0; i < n; i++) {
    const o = i * 6;
    const l = Math.hypot(vertices[o + 3]!, vertices[o + 4]!, vertices[o + 5]!) || 1;
    vertices[o + 3] = vertices[o + 3]! / l;
    vertices[o + 4] = vertices[o + 4]! / l;
    vertices[o + 5] = vertices[o + 5]! / l;
  }
  return { vertices, indices: new Uint16Array(indices) };
}
