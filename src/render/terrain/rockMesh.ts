/**
 * Procedural rock meshes: ROCK_VARIANTS shapes x 3 levels of detail. A shape starts as a convex polyhedron,
 * the intersection of half-spaces, in four classes: blocks (upright sides, a tilted top, a bevelled corner
 * or two), slabs (low, wide blocks), wedges (a steep top face) and boulders (many faces, sub-rounded). Every
 * plane lies at least one unit from the centre, so the polyhedron encloses the unit ball: a collidable rock
 * is the ellipsoidal cap of the height function, and the mesh scaled by the cap's radius and height encloses
 * it.
 *
 * The mesh is not the polyhedron but a broken rock made from it (buildRockMesh): its faces as patches that
 * meet in creases, with worn corners, scoops where pieces have spalled off, a crack, the steps and pits of
 * fracture faces, and a foot that flares where soil is banked against it. The centre of the unit rock is its
 * base point on the ground: what lies below z = 0 is buried. No point comes nearer to the centre than the
 * unit ball.
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
  /** Per vertex (ROCK_VERTEX_FLOATS): xyz position, xyz normal, soil share, cavity. */
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

/** Largest outward displacement of the surface by its relief, and of its foot by the soil banked against it (unit rock). */
export const ROCK_CHIP = 0.2;
/** Share of a point's distance from the unit ball that wear removes: blocks, slabs, wedges; boulders. */
export const ROCK_WEAR = [0.1, 0.3] as const;
/** Floats per vertex: position, normal, soil share (1 at the foot, 0 from a quarter of the height up), cavity (1 = open face, less in scoops and cracks). */
export const ROCK_VERTEX_FLOATS = 8;

/** Smooth noise in 0..1 of a position (trilinear value noise, three octaves). */
function chipNoise(p: P3, seed: number, freq0 = 2.3): number {
  let sum = 0;
  let amp = 0.55;
  let freq = freq0;
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

/** Edges of a face are divided into this many pieces at the three levels of detail (the coarsest has no inner vertices). */
const ROCK_SEGMENTS = [5, 2, 1] as const;

/**
 * The mesh of a variant at a level of detail: the variant's polyhedron, face by face, every face a patch of
 * its own (vertices are not shared between faces, so the edges where two faces meet are creases: a broken
 * rock is angular, and a mesh that is smooth across its edges shades as a loaf). A face is divided into
 * triangles about its middle (the coarsest level: from one corner) and every point of it is moved along its
 * direction from the centre by a function of the position alone, so the patches of two faces agree along
 * their common edge and every level samples the same solid: worn towards the unit ball (corners lose most),
 * scoops where a piece has spalled off (the solid is not convex), a crack, and the relief of a fracture face:
 * steps and pits of two sizes, small enough to leave the face a face. Nothing comes nearer to the centre
 * than the unit ball. The foot flares out a little: soil is banked against a rock that has lain long (vertex
 * soil share, for the shader to colour). The sides end on the rim of the buried bottom; the bottom itself is
 * not drawn. `banked = false` leaves the foot as it is (a loose stone that lies on the ground, not in it).
 */
export function buildRockMesh(variant: number, lod: number, banked = true): RockMeshData {
  const all = rockPlanes(variant);
  const boulder = variant % ROCK_CLASSES === 3;
  const wear = boulder ? ROCK_WEAR[1] : ROCK_WEAR[0];
  const seed = 0x51c0ffee + variant * 131;
  let counter = 0;
  const u = (): number => hashToUnit(hash4(counter++, variant, 91, seed));
  // Scoops (direction, angular radius, share of the stand-off they remove) and one crack (a great circle).
  const scoops: { c: P3; a: number; depth: number }[] = [];
  const scoopCount = 2 + Math.floor(u() * 3);
  for (let i = 0; i < scoopCount; i++) {
    const az = u() * 2 * Math.PI;
    const z = 0.15 + 0.75 * u();
    const s = Math.sqrt(1 - z * z);
    scoops.push({ c: [s * Math.cos(az), s * Math.sin(az), z], a: 0.4 + 0.35 * u(), depth: 0.55 + 0.4 * u() });
  }
  const crackAz = u() * 2 * Math.PI;
  const crackTilt = (u() - 0.5) * 1.2;
  const crack: P3 = norm([Math.cos(crackAz), Math.sin(crackAz), crackTilt]);

  /** A point of the polyhedron's surface as it lies on the broken rock, with its soil share and cavity. */
  const broken = (q: P3): { p: P3; soil: number; cavity: number } => {
    if (q[2] <= -BURIED + 1e-6) return { p: q, soil: banked ? 1 : 0, cavity: 1 };
    const t = Math.hypot(q[0], q[1], q[2]);
    const d: P3 = [q[0] / t, q[1] / t, q[2] / t];
    // Worn towards the unit ball (corners lose most), less so in the ground.
    const exposed = Math.min(1, Math.max(0, (t * d[2] + 0.35) / 0.45));
    let off = (t - 1) * (1 - wear * exposed * exposed * (3 - 2 * exposed) * Math.min(1, (t - 1) / 0.5));
    let open = 1;
    for (const sc of scoops) {
      const ang = Math.acos(Math.max(-1, Math.min(1, dot(sc.c, d))));
      const w = Math.max(0, 1 - ang / sc.a);
      const k = sc.depth * w * w * (3 - 2 * w);
      off *= 1 - k;
      open -= 0.5 * k;
    }
    const cd = dot(crack, d);
    // (Narrow and not much darker than the face: a wide dark groove read as a seam stitched across the rock.)
    const groove = Math.exp(-(cd * cd) / (0.022 * 0.022));
    off *= 1 - 0.4 * groove;
    open -= 0.25 * groove;
    // The relief of a fracture face: outwards only (the unit ball stays inside), ridged (steps and edges,
    // not bumps), a third of what a lump would be: the face stays a plane.
    const coarse = chipNoise(d, seed, 1.9);
    const fine = chipNoise(d, seed + 7, 6.5);
    off += ROCK_CHIP * (0.32 * coarse + 0.3 * Math.abs(2 * fine - 0.55)) * (0.35 + 0.65 * exposed);
    open -= 0.7 * Math.max(0, 0.45 - fine);
    const r = 1 + Math.max(off, 1e-4);
    const p: P3 = [d[0] * r, d[1] * r, d[2] * r];
    // The foot: soil banked against the rock flares it out.
    const foot = banked ? 1 - Math.min(1, Math.max(0, p[2] / 0.28)) : 0;
    const flare = foot * foot * Math.min(1, Math.max(0, (p[2] + 0.55) / 0.35));
    p[0] *= 1 + 0.08 * flare;
    p[1] *= 1 + 0.08 * flare;
    return { p, soil: !banked ? 0 : p[2] <= 0 ? 1 : foot * foot * (3 - 2 * foot), cavity: Math.min(1, Math.max(0.35, open)) };
  };

  // The corners of the polyhedron, welded (clipping leaves the same corner on several faces to rounding).
  const corners: P3[] = [];
  const cornerOf = (p: P3): number => {
    for (let i = 0; i < corners.length; i++) if (Math.hypot(p[0] - corners[i]![0], p[1] - corners[i]![1], p[2] - corners[i]![2]) < 2e-3) return i;
    corners.push(p);
    return corners.length - 1;
  };
  const faces: number[][] = [];
  for (const f of clipPolyhedron(all)) {
    // The buried bottom is not drawn.
    if (f.plane.n[2] < -0.999) continue;
    const loop: number[] = [];
    for (const v of f.verts) {
      const c = cornerOf(v);
      if (loop[loop.length - 1] !== c) loop.push(c);
    }
    if (loop.length > 1 && loop[0] === loop[loop.length - 1]) loop.pop();
    if (loop.length >= 3) faces.push(loop);
  }
  /** The point at k / m of the edge between two corners: the same numbers from either face that has the edge. */
  const onEdge = (a: number, b: number, k: number, m: number): P3 => {
    const [lo, hi, t] = a < b ? [a, b, k / m] : [b, a, 1 - k / m];
    const p = corners[lo]!;
    const q = corners[hi]!;
    return t <= 0 ? p : t >= 1 ? q : [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t, p[2] + (q[2] - p[2]) * t];
  };

  const m = ROCK_SEGMENTS[lod]!;
  const positions: P3[] = [];
  const soil: number[] = [];
  const cavity: number[] = [];
  const indices: number[] = [];
  const normals: number[] = [];
  const emit = (q: P3): number => {
    const o = broken(q);
    positions.push(o.p);
    soil.push(o.soil);
    cavity.push(o.cavity);
    normals.push(0, 0, 0);
    return positions.length - 1;
  };
  const triangle = (a: number, b: number, c: number): void => {
    const n = cross(sub(positions[b]!, positions[a]!), sub(positions[c]!, positions[a]!));
    if (Math.hypot(n[0], n[1], n[2]) < 1e-12) return;
    // Area-weighted normals within the face: its relief shades, its edges stay creases.
    for (const v of [a, b, c]) {
      normals[v * 3] = normals[v * 3]! + n[0];
      normals[v * 3 + 1] = normals[v * 3 + 1]! + n[1];
      normals[v * 3 + 2] = normals[v * 3 + 2]! + n[2];
    }
    indices.push(a, b, c);
  };
  for (const loop of faces) {
    const n = loop.length;
    if (m === 1) {
      // The coarsest level: the face from one corner.
      const vs = loop.map((c) => emit(corners[c]!));
      for (let i = 1; i + 1 < n; i++) triangle(vs[0]!, vs[i]!, vs[i + 1]!);
      continue;
    }
    const centre: P3 = [0, 0, 0];
    for (const c of loop) {
      centre[0] += corners[c]![0] / n;
      centre[1] += corners[c]![1] / n;
      centre[2] += corners[c]![2] / n;
    }
    const middle = emit(centre);
    // Rings 1 .. m around the middle: ring r has r points per side of the face; ring m is the face's edge.
    const rings: number[][] = [[middle]];
    for (let r = 1; r <= m; r++) {
      const ring: number[] = [];
      for (let i = 0; i < n; i++) {
        const a = loop[i]!;
        const b = loop[(i + 1) % n]!;
        for (let k = 0; k < r; k++) {
          let q: P3;
          if (r === m) q = onEdge(a, b, k, m);
          else {
            const e = onEdge(a, b, k, r);
            q = [centre[0] + (e[0] - centre[0]) * (r / m), centre[1] + (e[1] - centre[1]) * (r / m), centre[2] + (e[2] - centre[2]) * (r / m)];
          }
          ring.push(emit(q));
        }
      }
      rings.push(ring);
    }
    for (let r = 1; r <= m; r++) {
      const outer = rings[r]!;
      const inner = rings[r - 1]!;
      for (let i = 0; i < n; i++) {
        for (let k = 0; k < r; k++) {
          const o0 = outer[i * r + k]!;
          const o1 = outer[(i * r + k + 1) % outer.length]!;
          const i0 = r === 1 ? inner[0]! : inner[(i * (r - 1) + Math.min(k, r - 1)) % inner.length]!;
          triangle(i0, o0, o1);
          if (k < r - 1) {
            const i1 = inner[(i * (r - 1) + k + 1) % inner.length]!;
            triangle(i0, o1, i1);
          }
        }
      }
    }
  }
  // Vertices no triangle uses (corners of slivers) are dropped.
  const used = new Int32Array(positions.length).fill(-1);
  let kept = 0;
  for (const i of indices) if (used[i]! < 0) used[i] = kept++;
  const vertices = new Float32Array(kept * ROCK_VERTEX_FLOATS);
  for (let i = 0; i < positions.length; i++) {
    const o = used[i]!;
    if (o < 0) continue;
    let nv = norm([normals[i * 3]!, normals[i * 3 + 1]!, normals[i * 3 + 2]!]);
    if (!(Math.hypot(nv[0], nv[1], nv[2]) > 0.5)) nv = norm(positions[i]!);
    vertices.set([positions[i]![0], positions[i]![1], positions[i]![2], nv[0], nv[1], nv[2], soil[i]!, cavity[i]!], o * ROCK_VERTEX_FLOATS);
  }
  return { vertices, indices: new Uint16Array(indices.map((i) => used[i]!)) };
}
