/**
 * Procedural rock meshes: ROCK_VARIANTS shapes x 3 levels of detail. A shape is a convex polyhedron, the
 * intersection of half-spaces (flat faces, straight edges, real corners), in four classes: blocks (upright
 * sides, a tilted top, a bevelled corner or two), slabs (low, wide blocks), wedges (a steep top face) and
 * boulders (many faces, sub-rounded). Every plane lies at least one unit from the centre, so the polyhedron
 * encloses the unit ball: a collidable rock is the ellipsoidal cap of the height function, and the mesh
 * scaled by the cap's radius and height encloses it (faces touch the cap, corners and edges stand out).
 *
 * The centre of the unit rock is its base point on the ground: what lies below z = 0 is buried. The
 * levels of detail share the polyhedron. At every level the corners and edges are worn: a point is pulled
 * towards the unit ball by a share of its distance from it (ROCK_WEAR; faces, which touch the ball, hardly
 * move, corners lose most), so a rock is a block with broken edges, not a paper solid. Level 2 is the worn
 * faces; levels 1 and 0 subdivide them (4 and 16 triangles per fan triangle of a face) and chip the surface
 * outwards with noise that depends on the position only (edges stay closed). No point comes nearer to the
 * centre than the unit ball.
 */
import { hash4, hashToUnit } from '@/core/math';

export const ROCK_VARIANTS = 12;
export const ROCK_LODS = 3;
/** Number of shape classes; variant v is of class v % ROCK_CLASSES. */
export const ROCK_CLASSES = 4;
/** Depth below the base point to which the sides reach (unit rock). */
const BURIED = 0.7;
/** Largest horizontal distance of a face from the axis, and largest height, of the unit rock. */
export const ROCK_REACH = 1.5;
export const ROCK_TOP = 1.45;

export interface RockMeshData {
  /** xyz position, xyz normal per vertex (6 floats). */
  vertices: Float32Array<ArrayBuffer>;
  indices: Uint16Array<ArrayBuffer>;
}

type P3 = [number, number, number];
interface Plane {
  n: P3;
  d: number;
}
interface Face {
  plane: Plane;
  verts: P3[];
}

const dot = (a: P3, b: P3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a: P3, b: P3): P3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: P3, b: P3): P3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: P3): P3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

/** The half-spaces n . x <= d of a variant. The last plane is the buried bottom (never drawn). */
export function rockPlanes(variant: number): Plane[] {
  const cls = variant % ROCK_CLASSES;
  const seed = 0x7f4a7c15 + variant * 977;
  let counter = 0;
  const u = (): number => hashToUnit(hash4(counter++, variant, 17, seed));
  const planes: Plane[] = [];
  const dir = (azimuth: number, z: number): P3 => {
    const r = Math.sqrt(Math.max(0, 1 - z * z));
    return [r * Math.cos(azimuth), r * Math.sin(azimuth), z];
  };
  if (cls === 3) {
    // Boulder: faces all around, each touching or nearly touching the unit ball.
    const count = 13 + Math.floor(u() * 4);
    for (let i = 0; i < count; i++) {
      // Spread by a Fibonacci spiral over the upper two thirds of the sphere, jittered.
      const z = 1 - ((i + 0.5) / count) * 1.5 + (u() - 0.5) * 0.18;
      planes.push({ n: dir(i * 2.39996 + (u() - 0.5) * 0.7, Math.max(-0.5, Math.min(0.98, z))), d: 1.0 + 0.1 * u() });
    }
  } else {
    // Sides: four or five nearly upright faces (leaning in or out by a few degrees), unevenly spaced.
    const sides = cls === 2 ? 4 : 4 + Math.floor(u() * 2);
    const phase = u() * 2 * Math.PI;
    for (let i = 0; i < sides; i++) {
      const az = phase + ((i + (u() - 0.5) * 0.4) / sides) * 2 * Math.PI;
      planes.push({ n: dir(az, (u() - 0.35) * 0.3), d: 1.0 + (cls === 1 ? 0.3 : 0.18) * u() });
    }
    // Top: level-ish for blocks and slabs, steep for wedges. It touches the unit ball (the cap's top).
    const tilt = cls === 2 ? 0.45 + 0.25 * u() : cls === 1 ? 0.04 + 0.1 * u() : 0.1 + 0.25 * u();
    const topAz = u() * 2 * Math.PI;
    planes.push({ n: dir(topAz, Math.cos(tilt)), d: 1.0 + 0.04 * u() });
    // Bevels: broken corners and edges between the top and the sides.
    const bevels = cls === 1 ? 1 + Math.floor(u() * 2) : 2 + Math.floor(u() * 2);
    for (let i = 0; i < bevels; i++) {
      planes.push({ n: dir(u() * 2 * Math.PI, 0.45 + 0.4 * u()), d: 1.03 + 0.14 * u() });
    }
    // A wedge's back, opposite its top slope, is cut by a second sloping face.
    if (cls === 2) planes.push({ n: dir(topAz + Math.PI + (u() - 0.5) * 0.8, 0.55 + 0.2 * u()), d: 1.1 + 0.2 * u() });
  }
  // Nothing reaches further than ROCK_REACH from the axis or higher than ROCK_TOP: long corners between two
  // sides that happen to meet at a sharp angle are broken off.
  for (let i = 0; i < 8; i++) planes.push({ n: dir((i / 8) * 2 * Math.PI + 0.3 * variant, 0), d: ROCK_REACH });
  planes.push({ n: [0, 0, 1], d: ROCK_TOP });
  planes.push({ n: [0, 0, -1], d: BURIED });
  return planes;
}

/** Faces of the convex polyhedron cut from a large cube by the planes (vertices counter-clockwise seen from outside). */
export function clipPolyhedron(planes: Plane[]): Face[] {
  const B = 4;
  const quad = (n: P3, a: P3, b: P3, c: P3, d: P3): Face => ({ plane: { n, d: B }, verts: [a, b, c, d] });
  let faces: Face[] = [
    quad([1, 0, 0], [B, -B, -B], [B, B, -B], [B, B, B], [B, -B, B]),
    quad([-1, 0, 0], [-B, -B, -B], [-B, -B, B], [-B, B, B], [-B, B, -B]),
    quad([0, 1, 0], [-B, B, -B], [-B, B, B], [B, B, B], [B, B, -B]),
    quad([0, -1, 0], [-B, -B, -B], [B, -B, -B], [B, -B, B], [-B, -B, B]),
    quad([0, 0, 1], [-B, -B, B], [B, -B, B], [B, B, B], [-B, B, B]),
    quad([0, 0, -1], [-B, -B, -B], [-B, B, -B], [B, B, -B], [B, -B, -B]),
  ];
  const EPS = 1e-9;
  for (const pl of planes) {
    const next: Face[] = [];
    const cut: P3[] = [];
    for (const f of faces) {
      const out: P3[] = [];
      const m = f.verts.length;
      for (let i = 0; i < m; i++) {
        const a = f.verts[i]!;
        const b = f.verts[(i + 1) % m]!;
        const da = dot(pl.n, a) - pl.d;
        const db = dot(pl.n, b) - pl.d;
        if (da <= EPS) out.push(a);
        if ((da < -EPS && db > EPS) || (da > EPS && db < -EPS)) {
          const t = da / (da - db);
          const p: P3 = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
          out.push(p);
          cut.push(p);
        } else if (Math.abs(da) <= EPS) {
          cut.push(a);
        }
      }
      if (out.length >= 3) next.push({ plane: f.plane, verts: out });
    }
    // The cap: the cut points in order around the plane normal.
    const unique: P3[] = [];
    for (const p of cut) if (!unique.some((q) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) < 1e-7)) unique.push(p);
    if (unique.length >= 3) {
      const c: P3 = [0, 0, 0];
      for (const p of unique) {
        c[0] += p[0] / unique.length;
        c[1] += p[1] / unique.length;
        c[2] += p[2] / unique.length;
      }
      const ex = norm(sub(unique[0]!, c));
      const ey = cross(pl.n, ex);
      unique.sort((p, q) => Math.atan2(dot(sub(p, c), ey), dot(sub(p, c), ex)) - Math.atan2(dot(sub(q, c), ey), dot(sub(q, c), ex)));
      next.push({ plane: pl, verts: unique });
    }
    faces = next;
  }
  return faces;
}

/** Largest outward displacement of a chipped surface point (unit rock). */
export const ROCK_CHIP = 0.2;
/** Share of a point's distance from the unit ball that wear removes: blocks, slabs, wedges; boulders. */
export const ROCK_WEAR = [0.35, 0.6] as const;

/** Smooth noise in 0..1 of a position (trilinear value noise, three octaves). */
function chipNoise(p: P3, seed: number): number {
  let sum = 0;
  let amp = 0.55;
  let freq = 2.3;
  for (let o = 0; o < 3; o++) {
    const x = p[0] * freq + 31.7;
    const y = p[1] * freq + 17.3;
    const z = p[2] * freq + 5.1;
    const ix = Math.floor(x);
    const iy = Math.floor(y);
    const iz = Math.floor(z);
    const fx = x - ix;
    const fy = y - iy;
    const fz = z - iz;
    const sx = fx * fx * (3 - 2 * fx);
    const sy = fy * fy * (3 - 2 * fy);
    const sz = fz * fz * (3 - 2 * fz);
    let v = 0;
    for (let c = 0; c < 8; c++) {
      const ox = c & 1;
      const oy = (c >> 1) & 1;
      const oz = c >> 2;
      v += hashToUnit(hash4(ix + ox, iy + oy, iz + oz, seed + o)) * (ox ? sx : 1 - sx) * (oy ? sy : 1 - sy) * (oz ? sz : 1 - sz);
    }
    sum += amp * v;
    amp *= 0.5;
    freq *= 2.7;
  }
  return sum;
}

export function buildRockMesh(variant: number, lod: number): RockMeshData {
  const planes = rockPlanes(variant);
  const faces = clipPolyhedron(planes).filter((f) => f.plane !== planes[planes.length - 1] && f.plane.n[2] > -0.95);
  const subdivisions = lod === 0 ? 3 : lod === 1 ? 2 : 0;
  const boulder = variant % ROCK_CLASSES === 3;
  const chip = lod === 2 ? 0 : boulder ? ROCK_CHIP : 0.7 * ROCK_CHIP;
  const wear = boulder ? ROCK_WEAR[1] : ROCK_WEAR[0];
  const seed = 0x51c0ffee + variant * 131;
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  for (const f of faces) {
    const n = f.plane.n;
    const index = new Map<string, number>();
    const vertex = (p: P3): number => {
      const key = `${Math.round(p[0] * 1e5)},${Math.round(p[1] * 1e5)},${Math.round(p[2] * 1e5)}`;
      let i = index.get(key);
      if (i === undefined) {
        // Worn towards the unit ball, then chipped outwards, both along the direction from the centre and
        // by amounts that depend on the point only: the same for every face that holds the point.
        const r = norm(p);
        const len = Math.hypot(p[0], p[1], p[2]);
        // What lies in the ground keeps its shape (the buried rim stays at its depth).
        const exposed = Math.min(1, Math.max(0, (p[2] + 0.35) / 0.45));
        const worn = len + wear * exposed * exposed * (3 - 2 * exposed) * (Math.min(len, 1.02) - len);
        const k = worn - len + (chip > 0 ? chip * chipNoise(p, seed) : 0);
        i = positions.length / 3;
        positions.push(p[0] + r[0] * k, p[1] + r[1] * k, p[2] + r[2] * k);
        normals.push(n[0], n[1], n[2]);
        index.set(key, i);
      }
      return i;
    };
    const tri = (a: P3, b: P3, c: P3, depth: number): void => {
      if (depth === 0) {
        indices.push(vertex(a), vertex(b), vertex(c));
        return;
      }
      const ab: P3 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
      const bc: P3 = [(b[0] + c[0]) / 2, (b[1] + c[1]) / 2, (b[2] + c[2]) / 2];
      const ca: P3 = [(c[0] + a[0]) / 2, (c[1] + a[1]) / 2, (c[2] + a[2]) / 2];
      tri(a, ab, ca, depth - 1);
      tri(ab, b, bc, depth - 1);
      tri(ca, bc, c, depth - 1);
      tri(ab, bc, ca, depth - 1);
    };
    const m = f.verts.length;
    if (subdivisions === 0) {
      for (let i = 1; i + 1 < m; i++) tri(f.verts[0]!, f.verts[i]!, f.verts[i + 1]!, 0);
    } else {
      const c: P3 = [0, 0, 0];
      for (const p of f.verts) {
        c[0] += p[0] / m;
        c[1] += p[1] / m;
        c[2] += p[2] / m;
      }
      for (let i = 0; i < m; i++) tri(c, f.verts[i]!, f.verts[(i + 1) % m]!, subdivisions - 1);
    }
  }
  const count = positions.length / 3;
  if (count > 65535) throw new Error(`rock mesh ${variant}/${lod}: ${count} vertices`);
  const vertices = new Float32Array(count * 6);
  for (let i = 0; i < count; i++) {
    vertices.set([positions[i * 3]!, positions[i * 3 + 1]!, positions[i * 3 + 2]!, normals[i * 3]!, normals[i * 3 + 1]!, normals[i * 3 + 2]!], i * 6);
  }
  return { vertices, indices: new Uint16Array(indices) };
}
