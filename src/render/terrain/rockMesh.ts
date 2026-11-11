/**
 * Procedural rock meshes: ROCK_VARIANTS shapes x 3 levels of detail. A shape starts as a convex polyhedron,
 * the intersection of half-spaces, in four classes: blocks (upright sides, a tilted top, a bevelled corner
 * or two), slabs (low, wide blocks), wedges (a steep top face) and boulders (many faces, sub-rounded). Every
 * plane lies at least one unit from the centre, so the polyhedron encloses the unit ball: a collidable rock
 * is the ellipsoidal cap of the height function, and the mesh scaled by the cap's radius and height encloses
 * it.
 *
 * The mesh is not the polyhedron but a broken rock made from it (buildRockMesh): one welded surface with
 * smooth normals, worn corners, scoops where pieces have spalled off, a crack, lumps and pits, and a foot
 * that flares where soil is banked against it. The centre of the unit rock is its base point on the ground:
 * what lies below z = 0 is buried. No point comes nearer to the centre than the unit ball.
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
export const ROCK_WEAR = [0.35, 0.6] as const;
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

/** A welded icosphere: unit directions and triangles (wound outwards), `level` times subdivided. */
export function icosphere(level: number): { dirs: P3[]; tris: number[] } {
  const t = (1 + Math.sqrt(5)) / 2;
  const dirs: P3[] = (
    [
      [-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0],
      [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t],
      [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1],
    ] as P3[]
  ).map(norm);
  let tris = [0, 11, 5, 0, 5, 1, 0, 1, 7, 0, 7, 10, 0, 10, 11, 1, 5, 9, 5, 11, 4, 11, 10, 2, 10, 7, 6, 7, 1, 8, 3, 9, 4, 3, 4, 2, 3, 2, 6, 3, 6, 8, 3, 8, 9, 4, 9, 5, 2, 4, 11, 6, 2, 10, 8, 6, 7, 9, 8, 1];
  for (let l = 0; l < level; l++) {
    const mid = new Map<number, number>();
    const midpoint = (a: number, b: number): number => {
      const key = a < b ? a * 65536 + b : b * 65536 + a;
      let i = mid.get(key);
      if (i === undefined) {
        const pa = dirs[a]!;
        const pb = dirs[b]!;
        i = dirs.length;
        dirs.push(norm([pa[0] + pb[0], pa[1] + pb[1], pa[2] + pb[2]]));
        mid.set(key, i);
      }
      return i;
    };
    const next: number[] = [];
    for (let i = 0; i < tris.length; i += 3) {
      const a = tris[i]!;
      const b = tris[i + 1]!;
      const c = tris[i + 2]!;
      const ab = midpoint(a, b);
      const bc = midpoint(b, c);
      const ca = midpoint(c, a);
      next.push(a, ab, ca, b, bc, ab, c, ca, bc, ab, bc, ca);
    }
    tris = next;
  }
  return { dirs, tris };
}

/**
 * The mesh of a variant at a level of detail: a welded sphere of directions (1280, 320 and 80 triangles)
 * pushed out to the variant's polyhedron, worn towards the unit ball, and then given the relief of a broken
 * rock, all as functions of the direction alone (every level samples the same solid): scoops where a piece
 * has spalled off (the solid is not convex), a crack, lumps and pits of three sizes. Nothing comes nearer
 * to the centre than the unit ball. The foot flares out a little: soil is banked against a rock that has
 * lain long (vertex soil share, for the shader to colour). Directions that would leave the solid through
 * its buried bottom end on the bottom's rim; the bottom itself is not drawn.
 */
export function buildRockMesh(variant: number, lod: number): RockMeshData {
  const all = rockPlanes(variant);
  const planes = all.slice(0, -1);
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

  const sphere = icosphere(lod === 0 ? 3 : lod === 1 ? 2 : 1);
  const count = sphere.dirs.length;
  const pos: P3[] = new Array<P3>(count);
  const rim: boolean[] = new Array<boolean>(count).fill(false);
  const soil = new Float32Array(count);
  const cavity = new Float32Array(count);
  const ray = (d: P3): number => {
    let t = Infinity;
    for (const pl of planes) {
      const nd = dot(pl.n, d);
      if (nd > 1e-9) t = Math.min(t, pl.d / nd);
    }
    return t;
  };
  for (let i = 0; i < count; i++) {
    const d = sphere.dirs[i]!;
    const t = ray(d);
    if (!(t < 1e6) || t * d[2] < -BURIED) {
      // On the rim of the buried bottom, under the direction's azimuth.
      const h = Math.hypot(d[0], d[1]);
      const c = h > 1e-6 ? d[0] / h : 1;
      const s = h > 1e-6 ? d[1] / h : 0;
      let rho = Infinity;
      for (const pl of planes) {
        const nd = pl.n[0] * c + pl.n[1] * s;
        if (nd > 1e-9) rho = Math.min(rho, (pl.d + pl.n[2] * BURIED) / nd);
      }
      pos[i] = [rho * c, rho * s, -BURIED];
      rim[i] = true;
      soil[i] = 1;
      cavity[i] = 1;
      continue;
    }
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
    const groove = Math.exp(-(cd * cd) / (0.035 * 0.035));
    off *= 1 - 0.45 * groove;
    open -= 0.5 * groove;
    // Lumps and pits: outwards only (the unit ball stays inside), finer ones on top.
    const coarse = chipNoise(d, seed, 1.9);
    const fine = chipNoise(d, seed + 7, 6.5);
    off += ROCK_CHIP * (0.75 * coarse + 0.25 * fine) * (0.35 + 0.65 * exposed);
    open -= 0.7 * Math.max(0, 0.45 - fine);
    const r = 1 + Math.max(off, 1e-4);
    const p: P3 = [d[0] * r, d[1] * r, d[2] * r];
    // The foot: soil banked against the rock flares it out.
    const foot = 1 - Math.min(1, Math.max(0, p[2] / 0.28));
    const banked = foot * foot * Math.min(1, Math.max(0, (p[2] + 0.55) / 0.35));
    p[0] *= 1 + 0.16 * banked;
    p[1] *= 1 + 0.16 * banked;
    pos[i] = p;
    soil[i] = p[2] <= 0 ? 1 : foot * foot * (3 - 2 * foot);
    cavity[i] = Math.min(1, Math.max(0.35, open));
  }
  const indices: number[] = [];
  const normals = new Float64Array(count * 3);
  for (let i = 0; i < sphere.tris.length; i += 3) {
    const a = sphere.tris[i]!;
    const b = sphere.tris[i + 1]!;
    const c = sphere.tris[i + 2]!;
    if (rim[a] && rim[b] && rim[c]) continue;
    const n = cross(sub(pos[b]!, pos[a]!), sub(pos[c]!, pos[a]!));
    // Directions that end on the rim crowd together there: a sliver between them can fold over. It lies
    // at the buried bottom and is left out.
    if ((rim[a] || rim[b] || rim[c]) && dot(n, [pos[a]![0] + pos[b]![0] + pos[c]![0], pos[a]![1] + pos[b]![1] + pos[c]![1], pos[a]![2] + pos[b]![2] + pos[c]![2]]) <= 1e-9) continue;
    // Area-weighted vertex normals; a sliver on the rim has none to give.
    for (const v of [a, b, c]) {
      normals[v * 3] = normals[v * 3]! + n[0];
      normals[v * 3 + 1] = normals[v * 3 + 1]! + n[1];
      normals[v * 3 + 2] = normals[v * 3 + 2]! + n[2];
    }
    if (Math.hypot(n[0], n[1], n[2]) < 1e-9) continue;
    indices.push(a, b, c);
  }
  // Vertices no triangle uses (inside the bottom) are dropped.
  const used = new Int32Array(count).fill(-1);
  let kept = 0;
  for (const i of indices) if (used[i]! < 0) used[i] = kept++;
  const vertices = new Float32Array(kept * ROCK_VERTEX_FLOATS);
  for (let i = 0; i < count; i++) {
    const o = used[i]!;
    if (o < 0) continue;
    let n = norm([normals[i * 3]!, normals[i * 3 + 1]!, normals[i * 3 + 2]!]);
    if (!(Math.hypot(n[0], n[1], n[2]) > 0.5)) n = norm(pos[i]!);
    vertices.set([pos[i]![0], pos[i]![1], pos[i]![2], n[0], n[1], n[2], soil[i]!, cavity[i]!], o * ROCK_VERTEX_FLOATS);
  }
  return { vertices, indices: new Uint16Array(indices.map((i) => used[i]!)) };
}
