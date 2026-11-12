/**
 * Meshes of the ground cover (cover.ts): what stands up from the ground and is not in the height function.
 * Five shapes, COVER_VARIANTS variants of each, three levels of detail:
 *
 *  - `tuft`: a tussock of grass, blades that lean outwards and droop. The levels of detail are nested: the
 *    coarser ones keep the first blades of the finer ones and widen them, so a tussock changes level without
 *    changing its outline.
 *  - `bush`: a low, wind-shaped shrub: woody stems from one foot that fork into twigs, and at the end of every
 *    twig a few sprays of leaves (cards that carry a spray of the set's leaf atlas, bent along their length).
 *  - `tree`: a low spreading tree (kiawe): a short trunk with a flared foot that forks into four crooked
 *    limbs, each limb into branches and twigs, sprays of leaves at the twig ends.
 *  - `grove`: a stand of such trees as one mesh, for the distances at which a single tree is a few pixels:
 *    crowns of leaf clusters ("puffs", small flattened solids), no stems.
 *  - `stone`: a loose stone, the rock meshes of rockMesh.ts without the soil at their foot (smaller than
 *    anything that collides).
 *
 * The twig ends of a bush or a tree are where the puffs of its crown would be (one sequence of random
 * numbers places both), and a coarser level keeps the first of them with larger sprays: a plant changes
 * level without changing its outline or its mass of leaves.
 *
 * Unit meshes: footprint radius 1, height 1, base on z = 0, +x downwind. Vertex (COVER_VERTEX_FLOATS):
 * position, normal, two numbers the shader shades by, a texture coordinate and two more numbers:
 *  - grass: height above the base (0..1), a random number per blade;
 *  - leaf sprays: height in the plant (0..1), how near the spray is to the crown's envelope (1) or its middle
 *    (0); uv on the spray (v = 0 at its foot); cell of the leaf atlas; level of detail + a random number;
 *  - puffs: as sprays, with cell -1 (no atlas);
 *  - wood: height, 2; u = ridges of bark around the stem (whole numbers at the seam), v = length along it in
 *    ridge widths; radius of the stem; a random number per stem;
 *  - stones: the soil share at the foot and the cavity (as in rockMesh.ts).
 */
import { hash4, hashToUnit } from '@/core/math';
import { buildRockMesh, ROCK_VERTEX_FLOATS } from './rockMesh';

export const COVER_VERTEX_FLOATS = 12;
export const COVER_LODS = 3;
export const COVER_VARIANTS = 3;
export const COVER_SHAPES = ['tuft', 'bush', 'tree', 'grove', 'stone'] as const;
export type CoverShape = (typeof COVER_SHAPES)[number];
/** Cells of the leaf atlas (tools/terrain/gen_foliage.py): two builds of the tree's spray, two of the shrub's. */
export const FOLIAGE_CELLS = 4;
const TREE_CELLS = [0, 1] as const;
const BUSH_CELLS = [2, 3] as const;

export interface CoverMeshData {
  vertices: Float32Array<ArrayBuffer>;
  indices: Uint16Array<ArrayBuffer>;
}

type P3 = [number, number, number];

const add = (a: P3, b: P3): P3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: P3, b: P3): P3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a: P3, s: number): P3 => [a[0] * s, a[1] * s, a[2] * s];
const lerp = (a: P3, b: P3, t: number): P3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const dot = (a: P3, b: P3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: P3, b: P3): P3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a: P3): number => Math.hypot(a[0], a[1], a[2]);
const unit = (a: P3, fallback: P3 = [0, 0, 1]): P3 => {
  const l = len(a);
  return l > 1e-9 ? [a[0] / l, a[1] / l, a[2] / l] : fallback;
};
/** A unit vector at right angles to `d`. */
const perpendicular = (d: P3): P3 => unit(cross(d, Math.abs(d[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0]));

class Builder {
  readonly v: number[] = [];
  readonly i: number[] = [];
  get count(): number {
    return this.v.length / COVER_VERTEX_FLOATS;
  }
  vertex(p: P3, n: P3, a: number, b: number, u = 0, v = 0, c = -1, d = 0): number {
    this.v.push(p[0], p[1], p[2], n[0], n[1], n[2], a, b, u, v, c, d);
    return this.count - 1;
  }
  tri(a: number, b: number, c: number): void {
    this.i.push(a, b, c);
  }
  data(): CoverMeshData {
    if (this.count > 65535) throw new Error(`cover mesh: ${this.count} vertices`);
    return { vertices: new Float32Array(this.v), indices: new Uint16Array(this.i) };
  }
}

const rng = (seed: number): (() => number) => {
  let n = 0;
  return () => hashToUnit(hash4(n++, seed, 0x5eed, 77));
};

/** Smooth value noise of a direction, about -1..1 (two octaves). */
function lump(d: P3, seed: number, freq: number): number {
  let sum = 0;
  let amp = 1;
  let f = freq;
  for (let o = 0; o < 2; o++) {
    const x = d[0] * f + 13.7;
    const y = d[1] * f + 7.3;
    const z = d[2] * f + 21.1;
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
    sum += amp * (2 * v - 1);
    amp *= 0.5;
    f *= 2.3;
  }
  return sum / 1.5;
}

function buildTuft(variant: number, lod: number): CoverMeshData {
  const b = new Builder();
  const blades = [46, 18, 8][lod]!;
  const segs = [3, 2, 1][lod]!;
  const widen = [1, 1.8, 3.2][lod]!;
  const u = rng(1000 + variant);
  // The blades of the finest level; a coarser level keeps the first of them. The mesh is scaled to the unit
  // footprint and height by the tips of all of them, so every level has the same size.
  const all = Array.from({ length: 46 }, () => {
    const ang = 2 * Math.PI * u();
    const rb = 0.4 * Math.sqrt(u());
    const out = ang + (u() - 0.5) * 1.3;
    const lean = 0.1 + 0.95 * Math.pow(rb / 0.4, 0.8) * (0.55 + 0.45 * u());
    return { ang, rb, out, lean, droop: 0.25 + 1.0 * u(), len: 0.75 + 0.5 * u(), w: 0.05 + 0.045 * u(), part: u() };
  });
  let reach = 0;
  let top = 0;
  for (const q of all) {
    const phi = q.lean + 0.5 * q.droop;
    reach = Math.max(reach, Math.hypot(q.rb * Math.cos(q.ang) + q.len * Math.cos(q.out) * Math.sin(phi), q.rb * Math.sin(q.ang) + q.len * Math.sin(q.out) * Math.sin(phi)));
    top = Math.max(top, q.len * Math.cos(phi));
  }
  for (let k = 0; k < blades; k++) {
    const { ang, rb, out, lean, droop, part } = all[k]!;
    const bladeLen = all[k]!.len;
    const w0 = all[k]!.w * widen;
    const base: P3 = [rb * Math.cos(ang), rb * Math.sin(ang), 0];
    const dh: P3 = [Math.cos(out), Math.sin(out), 0];
    const wa: P3 = [-Math.sin(out), Math.cos(out), 0];
    let prev: [number, number] | null = null;
    for (let j = 0; j <= segs; j++) {
      const t = j / segs;
      const phi = lean + 0.5 * droop * t;
      const c: P3 = [base[0] + bladeLen * t * dh[0] * Math.sin(phi), base[1] + bladeLen * t * dh[1] * Math.sin(phi), bladeLen * t * Math.cos(phi)];
      // Tangent of the blade's centre line, and the normal of its upper face.
      const dphi = lean + droop * t;
      const tan: P3 = [dh[0] * Math.sin(dphi), dh[1] * Math.sin(dphi), Math.cos(dphi)];
      let n: P3 = [wa[1] * tan[2] - wa[2] * tan[1], wa[2] * tan[0] - wa[0] * tan[2], wa[0] * tan[1] - wa[1] * tan[0]];
      if (n[2] < 0) n = [-n[0], -n[1], -n[2]];
      const l = Math.hypot(n[0], n[1], n[2]) || 1;
      n = [n[0] / l, n[1] / l, n[2] / l];
      const w = 0.5 * w0 * (1 - Math.pow(t, 1.3));
      if (j === segs) {
        const tip = b.vertex(c, n, t, part);
        if (prev) b.tri(prev[0], prev[1], tip);
      } else {
        const left = b.vertex([c[0] - w * wa[0], c[1] - w * wa[1], c[2]], n, t, part);
        const right = b.vertex([c[0] + w * wa[0], c[1] + w * wa[1], c[2]], n, t, part);
        if (prev) {
          b.tri(prev[0], prev[1], right);
          b.tri(prev[0], right, left);
        }
        prev = [left, right];
      }
    }
  }
  for (let k = 0; k < b.v.length; k += COVER_VERTEX_FLOATS) {
    b.v[k] = b.v[k]! / reach;
    b.v[k + 1] = b.v[k + 1]! / reach;
    b.v[k + 2] = b.v[k + 2]! / top;
  }
  if (lod === 2) {
    // From afar a tussock is a dark mound with a few blades standing out of it.
    const top = b.vertex([0, 0, 0.5], [0, 0, 1], 0.3, 0.5);
    const ring: number[] = [];
    for (let k = 0; k < 5; k++) {
      const a = (2 * Math.PI * k) / 5;
      ring.push(b.vertex([0.55 * Math.cos(a), 0.55 * Math.sin(a), 0], [0.6 * Math.cos(a), 0.6 * Math.sin(a), 0.8], 0, 0.5));
    }
    for (let k = 0; k < 5; k++) b.tri(top, ring[k]!, ring[(k + 1) % 5]!);
  }
  return b.data();
}

/** Numbers of the leaf clusters of a crown at the three levels of detail, and how much larger the fewer ones are. */
const PUFFS = [230, 60, 14];
const PUFF_SCALE = [0.72, 1.3, 2.3];

const OCTA: P3[] = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
const OCTA_TRIS = [0, 2, 4, 2, 1, 4, 1, 3, 4, 3, 0, 4, 2, 0, 5, 1, 2, 5, 3, 1, 5, 0, 3, 5];

/** One leaf cluster of a crown: where it is, how near the envelope, its size and the numbers that shape it. */
interface Cluster {
  p: P3;
  shell: number;
  size: number;
  flat: number;
  yaw: number;
  tilt: number;
  jitter: number[];
}

interface Crown {
  centre: P3;
  radius: number;
  height: number;
  /** The point leaf normals lean away from. */
  mid: P3;
  clusters: Cluster[];
}

/**
 * The leaf clusters of a crown: scattered through a lumpy envelope that leans towards +x, most of them near
 * its surface. Twelve random numbers per cluster, the same at every level: the first clusters of the finest
 * level are the clusters of the coarser ones.
 */
function crownOf(count: number, scale: number, seed: number, centre: P3, radius: number, height: number, grounded: boolean): Crown {
  const u = rng(seed);
  const zMin = grounded ? -0.05 : -0.45;
  const clusters: Cluster[] = [];
  for (let k = 0; k < count; k++) {
    const az = 2 * Math.PI * u();
    const cz = zMin + (1 - zMin) * Math.pow(u(), 0.8);
    const sz = Math.sqrt(Math.max(0, 1 - cz * cz));
    const d: P3 = [sz * Math.cos(az), sz * Math.sin(az), cz];
    const shell = 0.5 + 0.5 * Math.sqrt(u());
    const size = (0.15 + 0.13 * u()) * (1.2 - 0.35 * shell) * scale;
    const flat = 0.45 + 0.35 * u();
    const yaw = 2 * Math.PI * u();
    const tilt = (u() - 0.5) * 1.4;
    const jitter = [u(), u(), u(), u(), u()];
    const r = (1 + 0.3 * lump(d, seed, 2.1) + 0.14 * lump(d, seed + 5, 5.7)) * shell;
    let z = 0.42 + d[2] * r * (d[2] > 0 ? 0.58 : 0.5);
    if (grounded) z = Math.max(z, 0.12 * size);
    const taper = 1 - 0.22 * Math.max(0, z);
    clusters.push({ p: [centre[0] + radius * (d[0] * r * taper + 0.3 * z * z), centre[1] + radius * d[1] * r * taper, centre[2] + height * z], shell, size, flat, yaw, tilt, jitter });
  }
  return { centre, radius, height, mid: [centre[0] + 0.12 * radius, centre[1], centre[2] + 0.3 * height], clusters };
}

/** Shading normal of a point of a crown: mostly the direction from the crown's middle (the crown shades as one mass), a little its own. */
function crownNormal(c: Crown, q: P3, own: P3, share: number): P3 {
  const out = unit([q[0] - c.mid[0], q[1] - c.mid[1], (q[2] - c.mid[2]) * (c.radius / c.height)]);
  return unit([share * own[0] + (1 - share) * out[0], share * own[1] + (1 - share) * out[1], share * own[2] + (1 - share) * out[2]], out);
}

/**
 * A crown as leaf clusters ("puffs": small flattened solids, turned every way). The outline is ragged and has
 * gaps because the clusters are separate things; they shade as one mass because their normals lean towards
 * the direction from the crown's middle. For stands of trees, which are never large on screen.
 */
function puffs(b: Builder, c: Crown): void {
  for (const k of c.clusters) {
    const cy = Math.cos(k.yaw);
    const sy = Math.sin(k.yaw);
    const ct = Math.cos(k.tilt);
    const st = Math.sin(k.tilt);
    const v0 = b.count;
    OCTA.forEach((o, n) => {
      // Flattened, tilted about x, turned about z; corners pushed in and out a little.
      const j = 0.75 + 0.5 * k.jitter[n % k.jitter.length]!;
      const x0 = o[0] * j;
      const y0 = o[1] * j * ct - o[2] * k.flat * j * st;
      const z0 = o[1] * j * st + o[2] * k.flat * j * ct;
      const local: P3 = [x0 * cy - y0 * sy, x0 * sy + y0 * cy, z0];
      const q: P3 = [k.p[0] + c.radius * k.size * local[0], k.p[1] + c.radius * k.size * local[1], k.p[2] + c.radius * k.size * local[2]];
      b.vertex(q, crownNormal(c, q, unit(local), 0.12), Math.min(1, Math.max(0, (q[2] - c.centre[2]) / c.height)), Math.min(1, Math.max(0, (k.shell - 0.5) * 2)));
    });
    for (const t of OCTA_TRIS) b.i.push(v0 + t);
  }
}

/**
 * A stem: a tube along `pts` with radii `radii`, `sides` faces around. The frame is carried along the stem
 * (no twist), so the ridges of the bark run along it. Bark coordinates: u counts ridges around (whole numbers
 * at the seam), v is the length along the stem in ridge widths.
 */
function tube(b: Builder, pts: P3[], radii: number[], sides: number, random: number): void {
  const ridges = Math.max(3, Math.min(9, sides + 2));
  const ridgeWidth = (2 * Math.PI * radii[0]!) / ridges;
  let n1 = perpendicular(unit(sub(pts[1]!, pts[0]!)));
  let along = 0;
  const rings: number[][] = [];
  for (let j = 0; j < pts.length; j++) {
    const t = unit(j === 0 ? sub(pts[1]!, pts[0]!) : j === pts.length - 1 ? sub(pts[j]!, pts[j - 1]!) : sub(pts[j + 1]!, pts[j - 1]!));
    n1 = unit(sub(n1, mul(t, dot(n1, t))), perpendicular(t));
    const n2 = cross(t, n1);
    if (j > 0) along += len(sub(pts[j]!, pts[j - 1]!));
    const ring: number[] = [];
    for (let s = 0; s <= sides; s++) {
      const a = (2 * Math.PI * s) / sides;
      const n = add(mul(n1, Math.cos(a)), mul(n2, Math.sin(a)));
      ring.push(b.vertex(add(pts[j]!, mul(n, radii[j]!)), n, Math.min(1, Math.max(0, pts[j]![2])), 2, (s / sides) * ridges, along / ridgeWidth, radii[j]!, random));
    }
    rings.push(ring);
  }
  for (let j = 0; j + 1 < rings.length; j++) {
    for (let s = 0; s < sides; s++) {
      const a = rings[j]![s]!;
      const c = rings[j]![s + 1]!;
      const d = rings[j + 1]![s]!;
      const e = rings[j + 1]![s + 1]!;
      b.tri(a, c, e);
      b.tri(a, e, d);
    }
  }
}

/** A stem seen from afar: two crossed ribbons of wood (four triangles). */
function ribbons(b: Builder, from: P3, to: P3, halfWidth: number): void {
  const t = unit(sub(to, from));
  const n1 = perpendicular(t);
  const n2 = cross(t, n1);
  for (const [side, face] of [[n1, n2], [n2, n1]] as const) {
    const o = b.count;
    b.vertex(sub(from, mul(side, halfWidth)), face, 0, 2, 0, 0, halfWidth, 0);
    b.vertex(add(from, mul(side, halfWidth)), face, 0, 2, 1, 0, halfWidth, 0);
    b.vertex(sub(to, mul(side, 0.6 * halfWidth)), face, 1, 2, 0, 4, halfWidth, 0);
    b.vertex(add(to, mul(side, 0.6 * halfWidth)), face, 1, 2, 1, 4, halfWidth, 0);
    b.tri(o, o + 1, o + 3);
    b.tri(o, o + 3, o + 2);
  }
}

/** Points of a crooked stem from `from` to `to`: a bow towards `bow` with kinks of `kink` (share of its length) at the inner points. */
function crooked(u: () => number, from: P3, to: P3, segments: number, bow: P3, kink: number): P3[] {
  const d = sub(to, from);
  const l = len(d);
  const t = unit(d);
  const pts: P3[] = [];
  for (let j = 0; j <= segments; j++) {
    const s = j / segments;
    let p = add(lerp(from, to, s), mul(bow, 4 * s * (1 - s)));
    if (j > 0 && j < segments) {
      const r: P3 = [u() - 0.5, u() - 0.5, u() - 0.5];
      p = add(p, mul(sub(r, mul(t, dot(r, t))), 2 * kink * l));
    }
    pts.push(p);
  }
  return pts;
}

/** Point at parameter s (0..1) of a polyline with equal parameter steps, and its direction there. */
function along(pts: P3[], s: number): { p: P3; dir: P3 } {
  const x = Math.min(0.9999, Math.max(0, s)) * (pts.length - 1);
  const j = Math.floor(x);
  return { p: lerp(pts[j]!, pts[j + 1]!, x - j), dir: unit(sub(pts[j + 1]!, pts[j]!)) };
}

/**
 * A spray of leaves: a card that carries one cell of the leaf atlas, its foot at `foot`, growing along `dir`,
 * bent along its length (it droops) when `bent`; `face` is the side its upper face looks to.
 */
function spray(b: Builder, crown: Crown, foot: P3, dir: P3, face: P3, length: number, width: number, bent: boolean, shell: number, cell: number, lod: number, random: number): void {
  const side = unit(cross(face, dir));
  const up = unit(cross(dir, side));
  const depth = Math.min(1, Math.max(0, (shell - 0.5) * 2));
  const rows = bent ? 3 : 2;
  const first = b.count;
  for (let j = 0; j < rows; j++) {
    const t = j / (rows - 1);
    // The far half hangs: it turns down by about 25 degrees.
    const droop = bent && j === 2 ? -0.23 * length : 0;
    const c = add(add(foot, mul(dir, t * length)), mul(up, droop));
    const n = crownNormal(crown, c, unit(add(up, mul(dir, bent ? 0.45 * (t - 0.5) : 0))), 0.3);
    const h = Math.min(1, Math.max(0, (c[2] - crown.centre[2]) / crown.height));
    b.vertex(sub(c, mul(side, 0.5 * width)), n, h, depth, 0, t, cell, lod + 0.98 * random);
    b.vertex(add(c, mul(side, 0.5 * width)), n, h, depth, 1, t, cell, lod + 0.98 * random);
  }
  for (let j = 0; j + 1 < rows; j++) {
    const o = first + 2 * j;
    b.tri(o, o + 1, o + 3);
    b.tri(o, o + 3, o + 2);
  }
}

interface FoliagePlan {
  /** Sprays per twig end, their length (in the crown's units, before the plant is fitted) and the atlas cells they take. */
  sprays: number;
  sprayLength: number;
  cells: readonly [number, number];
  /** Branches a hub forks into, their radius at the hub; twigs are drawn (finest level only) with this radius. */
  branches: number;
  branchRadius: number;
  twigRadius: number;
  sides: number;
}

/**
 * The woody frame of a crown from its hub outwards, and its leaves: the clusters are gathered into
 * `plan.branches` groups (each to the nearest of the first clusters), a crooked branch runs from the hub
 * towards the middle of each group, a twig from the branch to every cluster (finest level), and every cluster
 * is a few sprays that grow on from the twig, turned every way round it, their faces mostly up and outwards.
 */
function leafyCrown(b: Builder, crown: Crown, hub: P3, lod: number, seed: number, plan: FoliagePlan): void {
  const u = rng(seed + 911);
  const clusters = crown.clusters;
  const groups = Math.max(1, Math.min(plan.branches, clusters.length));
  const owner = clusters.map((c) => {
    let best = 0;
    let bestD = Infinity;
    for (let g = 0; g < groups; g++) {
      const d = len(sub(c.p, clusters[g]!.p));
      if (d < bestD) {
        bestD = d;
        best = g;
      }
    }
    return best;
  });
  for (let g = 0; g < groups; g++) {
    const members = clusters.filter((_, i) => owner[i] === g);
    let mean: P3 = [0, 0, 0];
    for (const m of members) mean = add(mean, mul(m.p, 1 / members.length));
    const end = lerp(hub, mean, 0.72);
    const reach = len(sub(end, hub));
    const branch = crooked(u, hub, end, lod === 0 ? 3 : 2, [0, 0, 0.12 * reach], 0.05);
    if (lod < 2 && plan.branches > 0) {
      const r0 = plan.branchRadius * (0.8 + 0.4 * u());
      tube(b, branch, branch.map((_, j) => r0 * (1 - 0.6 * (j / (branch.length - 1)))), lod === 0 ? plan.sides : 3, u());
    }
    for (const m of members) {
      const at = along(branch, 0.35 + 0.65 * u());
      const reachOut = sub(m.p, at.p);
      const dir = unit(reachOut, at.dir);
      if (lod === 0) tube(b, [at.p, m.p], [plan.twigRadius, 0.5 * plan.twigRadius], 3, u());
      const outward = unit(sub(m.p, crown.mid));
      for (let s = 0; s < plan.sprays; s++) {
        // Round the twig, leaning out from it and a little down; the first one grows straight on.
        const turn = 2 * Math.PI * (s / plan.sprays + u());
        const p1 = perpendicular(dir);
        const p2 = cross(dir, p1);
        const lean = s === 0 ? 0.25 : 0.7 + 0.5 * u();
        const d = unit(add(add(dir, mul(add(mul(p1, Math.cos(turn)), mul(p2, Math.sin(turn))), lean)), [0, 0, -0.22]));
        // The face of a spray looks up and outwards, each with its own roll.
        const roll: P3 = [u() - 0.5, u() - 0.5, u() - 0.5];
        let face = unit(add(add([0, 0, 0.9], mul(outward, 0.6)), mul(roll, 1.5)));
        face = unit(sub(face, mul(d, dot(face, d))), perpendicular(d));
        const length = plan.sprayLength * (0.75 + 0.5 * u()) * (m.size / 0.2);
        const cell = plan.cells[u() < 0.6 ? 0 : 1];
        spray(b, crown, sub(m.p, mul(d, 0.22 * length)), d, face, length, 0.92 * length, lod < 2, m.shell, cell, lod, u());
      }
    }
  }
}

/** Scale to the unit footprint and height by numbers that do not depend on the level of detail. */
function fit(b: Builder, reach: number, top: number): void {
  for (let k = 0; k < b.v.length; k += COVER_VERTEX_FLOATS) {
    b.v[k] = b.v[k]! / reach;
    b.v[k + 1] = b.v[k + 1]! / reach;
    b.v[k + 2] = b.v[k + 2]! / top;
    // The normal of a scaled surface, and what was measured in the crown's units.
    const n = unit([b.v[k + 3]! * reach, b.v[k + 4]! * reach, b.v[k + 5]! * top]);
    b.v[k + 3] = n[0];
    b.v[k + 4] = n[1];
    b.v[k + 5] = n[2];
    if (b.v[k + 7]! > 1.5) b.v[k + 10] = b.v[k + 10]! / reach;
  }
}

function extent(b: Builder): { reach: number; top: number } {
  let reach = 0;
  let top = 0;
  for (let k = 0; k < b.v.length; k += COVER_VERTEX_FLOATS) {
    reach = Math.max(reach, Math.hypot(b.v[k]!, b.v[k + 1]!));
    top = Math.max(top, b.v[k + 2]!);
  }
  return { reach, top };
}

/** Sprays per twig end and how much larger they are at the coarser levels (fewer twig ends carry the same leaves). */
const SPRAYS = [4, 3, 2];
const SPRAY_SCALE = [1, 1.9, 3.4];

function rawBush(variant: number, lod: number): Builder {
  const b = new Builder();
  const seed = 2000 + variant * 17;
  const u = rng(seed + 3);
  const crown = crownOf(Math.max(2, Math.round(PUFFS[lod]! * 0.6)), 1, seed, [0, 0, 0], 1, 1, true);
  const foot: P3 = [0.05 * (u() - 0.5), 0.05 * (u() - 0.5), -0.03];
  // A shrub forks at the ground: its "hub" is its foot, and the branches are its stems.
  leafyCrown(b, crown, foot, lod, seed, { sprays: SPRAYS[lod]!, sprayLength: 0.265 * SPRAY_SCALE[lod]!, cells: BUSH_CELLS, branches: [8, 5, 0][lod]!, branchRadius: 0.028, twigRadius: 0.008, sides: 5 });
  return b;
}

function rawTree(variant: number, lod: number): Builder {
  const b = new Builder();
  const seed = 3000 + variant * 23;
  const u = rng(seed);
  const lobes = 4;
  const w = rng(seed + 77);
  // A short trunk that leans downwind, its foot flared where the roots run out.
  const fork: P3 = [0.07 + 0.05 * w(), 0.06 * (w() - 0.5), 0.2 + 0.07 * w()];
  const trunkR = 0.044 + 0.01 * w();
  const trunk: P3[] = [[0, 0, -0.05], [0.003, 0.002, 0.012], lerp([0, 0, 0], fork, 0.3), lerp([0, 0, 0], fork, 0.65), fork];
  trunk[2] = add(trunk[2]!, [0.035 * (w() - 0.5), 0.035 * (w() - 0.5), 0]);
  trunk[3] = add(trunk[3]!, [0.03 * (w() - 0.5), 0.03 * (w() - 0.5), 0]);
  if (lod < 2) tube(b, trunk, [1.9 * trunkR, 1.25 * trunkR, 1.03 * trunkR, 0.97 * trunkR, 0.92 * trunkR], [7, 5][lod]!, w());
  else ribbons(b, [0, 0, -0.05], [0.6 * fork[0], 0.6 * fork[1], 0.45], 1.6 * trunkR);
  for (let k = 0; k < lobes; k++) {
    const a = (2 * Math.PI * (k + 0.7 * u())) / lobes;
    const off = k === 0 ? 0.1 : 0.42 + 0.25 * u();
    const centre: P3 = [off * Math.cos(a) + 0.15, off * Math.sin(a), 0.42 + 0.16 * u()];
    const radius = 0.5 + 0.18 * u();
    const height = 0.4 + 0.12 * u();
    const crown = crownOf(Math.max(2, Math.round(PUFFS[lod]! * 0.42)), 1, seed + 31 * k, centre, radius, height, false);
    // The limb: from the fork to a hub under the middle of its crown, bowed upwards, with a kink or two.
    const hub: P3 = [fork[0] + 0.72 * (centre[0] - fork[0]), fork[1] + 0.72 * (centre[1] - fork[1]), centre[2] + 0.12 * height];
    const limbR = 0.032 + 0.008 * w();
    const limb = crooked(w, fork, hub, [4, 3, 2][lod]!, [0, 0, 0.1], 0.07);
    if (lod < 2) tube(b, limb, limb.map((_, j) => limbR * (1 - 0.45 * (j / (limb.length - 1)))), [6, 4][lod]!, w());
    leafyCrown(b, crown, hub, lod, seed + 31 * k, { sprays: SPRAYS[lod]!, sprayLength: 0.175 * SPRAY_SCALE[lod]!, cells: TREE_CELLS, branches: [9, 4, 0][lod]!, branchRadius: 0.017, twigRadius: 0.0045, sides: 4 });
  }
  return b;
}

/** A plant mesh at a level of detail, scaled by the extent of its finest level (every level has the same size). */
function fitted(raw: (variant: number, lod: number) => Builder, variant: number, lod: number): CoverMeshData {
  const e = extent(raw(variant, 0));
  const b = raw(variant, lod);
  fit(b, e.reach, e.top);
  return b.data();
}

/** Eight crowns over a disc, without stems (nobody sees them from where a grove is drawn). */
function rawGrove(variant: number, lod: number): Builder {
  const b = new Builder();
  const seed = 4000 + variant * 29;
  const u = rng(seed);
  for (let k = 0; k < 8; k++) {
    const a = 2 * Math.PI * u();
    const off = 0.85 * Math.sqrt(u());
    const radius = 0.24 + 0.14 * u();
    const centre: P3 = [off * Math.cos(a), off * Math.sin(a), 0.3 + 0.25 * u()];
    // A grove is never large on screen: its finest level is the middle build of a crown.
    const build = lod === 2 ? 2 : 1;
    puffs(b, crownOf(Math.max(2, Math.round(PUFFS[build]! * (lod === 2 ? 0.14 : 0.12))), PUFF_SCALE[build]!, seed + 37 * k, centre, radius, 0.55, false));
  }
  return b;
}

const buildBush = (variant: number, lod: number): CoverMeshData => fitted(rawBush, variant, lod);
const buildGrove = (variant: number, lod: number): CoverMeshData => fitted(rawGrove, variant, lod);
const buildTree = (variant: number, lod: number): CoverMeshData => fitted(rawTree, variant, lod);

/** Blocks and wedges: clinker is angular. */
const STONE_ROCKS = [0, 2, 6];

function buildStone(variant: number, lod: number): CoverMeshData {
  const m = buildRockMesh(STONE_ROCKS[variant % STONE_ROCKS.length]!, lod, false);
  // A rock vertex is position, normal, soil share and cavity: the first eight numbers of a cover vertex.
  const count = m.vertices.length / ROCK_VERTEX_FLOATS;
  const vertices = new Float32Array(count * COVER_VERTEX_FLOATS);
  for (let i = 0; i < count; i++) {
    vertices.set(m.vertices.subarray(i * ROCK_VERTEX_FLOATS, i * ROCK_VERTEX_FLOATS + 8), i * COVER_VERTEX_FLOATS);
    vertices[i * COVER_VERTEX_FLOATS + 10] = -1;
  }
  return { vertices, indices: m.indices };
}

export function buildCoverMesh(shape: CoverShape, variant: number, lod: number): CoverMeshData {
  if (shape === 'tuft') return buildTuft(variant, lod);
  if (shape === 'bush') return buildBush(variant, lod);
  if (shape === 'tree') return buildTree(variant, lod);
  if (shape === 'grove') return buildGrove(variant, lod);
  return buildStone(variant, lod);
}
