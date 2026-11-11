/**
 * Meshes of the ground cover (cover.ts): what stands up from the ground and is not in the height function.
 * Five shapes, COVER_VARIANTS variants of each, three levels of detail:
 *
 *  - `tuft`: a tussock of grass, blades that lean outwards and droop. The levels of detail are nested: the
 *    coarser ones keep the first blades of the finer ones and widen them, so a tussock changes level without
 *    changing its outline.
 *  - `bush`: a low, wind-shaped shrub: leaf clusters ("puffs", small flattened solids) scattered through a
 *    lumpy envelope that sits on the ground. The shader cuts fine gaps into them when they are near.
 *  - `tree`: a low spreading tree (kiawe): four such crowns on leaning stems.
 *  - `grove`: a stand of such trees as one mesh, for the distances at which a single tree is a few pixels.
 *  - `stone`: a loose stone, the rock meshes of rockMesh.ts without the soil at their foot (smaller than
 *    anything that collides).
 *
 * Unit meshes: footprint radius 1, height 1, base on z = 0, +x downwind. Vertex: position, normal, and two
 * numbers the shader shades by: for plants the height above the base (0..1) and the part (grass: a random
 * number per blade; crowns: 0 = deep inside .. 1 = at the envelope, 2 = wood), for stones the soil share at
 * the foot and the cavity (as in rockMesh.ts).
 */
import { hash4, hashToUnit } from '@/core/math';
import { buildRockMesh, ROCK_VERTEX_FLOATS } from './rockMesh';

export const COVER_VERTEX_FLOATS = 8;
export const COVER_LODS = 3;
export const COVER_VARIANTS = 3;
export const COVER_SHAPES = ['tuft', 'bush', 'tree', 'grove', 'stone'] as const;
export type CoverShape = (typeof COVER_SHAPES)[number];

export interface CoverMeshData {
  vertices: Float32Array<ArrayBuffer>;
  indices: Uint16Array<ArrayBuffer>;
}

type P3 = [number, number, number];

class Builder {
  readonly v: number[] = [];
  readonly i: number[] = [];
  get count(): number {
    return this.v.length / COVER_VERTEX_FLOATS;
  }
  vertex(p: P3, n: P3, a: number, b: number): number {
    this.v.push(p[0], p[1], p[2], n[0], n[1], n[2], a, b);
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
    const len = all[k]!.len;
    const w0 = all[k]!.w * widen;
    const base: P3 = [rb * Math.cos(ang), rb * Math.sin(ang), 0];
    const dh: P3 = [Math.cos(out), Math.sin(out), 0];
    const wa: P3 = [-Math.sin(out), Math.cos(out), 0];
    let prev: [number, number] | null = null;
    for (let j = 0; j <= segs; j++) {
      const t = j / segs;
      const phi = lean + 0.5 * droop * t;
      const c: P3 = [base[0] + len * t * dh[0] * Math.sin(phi), base[1] + len * t * dh[1] * Math.sin(phi), len * t * Math.cos(phi)];
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

/** Numbers of the puffs of a crown at the three levels of detail, and how much larger the fewer ones are. */
const PUFFS = [230, 60, 14];
const PUFF_SCALE = [0.72, 1.3, 2.3];

const OCTA: P3[] = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
const OCTA_TRIS = [0, 2, 4, 2, 1, 4, 1, 3, 4, 3, 0, 4, 2, 0, 5, 1, 2, 5, 3, 1, 5, 0, 3, 5];

/**
 * A crown of foliage: leaf clusters ("puffs": small flattened solids, turned every way) scattered through a
 * lumpy envelope that leans towards +x, most of them near its surface. The outline is ragged and has gaps
 * because the clusters are separate things; they shade as one mass because their normals lean towards the
 * direction from the crown's middle. The first puffs of the finest level are the puffs of the coarser ones
 * (larger there), so a crown changes level without changing its build.
 * Vertex extras: height in the crown 0..1, and how near the puff is to the envelope (1) or the middle (0).
 */
function crown(b: Builder, lod: number, share: number, seed: number, centre: P3, radius: number, height: number, grounded: boolean): void {
  const u = rng(seed);
  const count = Math.max(2, Math.round(PUFFS[lod]! * share));
  const scale = PUFF_SCALE[lod]!;
  const zMin = grounded ? -0.05 : -0.45;
  for (let k = 0; k < count; k++) {
    // Twelve numbers per puff, the same at every level.
    let d: P3;
    const az = 2 * Math.PI * u();
    const cz = zMin + (1 - zMin) * Math.pow(u(), 0.8);
    const sz = Math.sqrt(Math.max(0, 1 - cz * cz));
    d = [sz * Math.cos(az), sz * Math.sin(az), cz];
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
    const p: P3 = [centre[0] + radius * (d[0] * r * taper + 0.3 * z * z), centre[1] + radius * d[1] * r * taper, centre[2] + height * z];
    const mid: P3 = [centre[0] + 0.12 * radius, centre[1], centre[2] + 0.3 * height];
    const cy = Math.cos(yaw);
    const sy = Math.sin(yaw);
    const ct = Math.cos(tilt);
    const st = Math.sin(tilt);
    const v0 = b.count;
    OCTA.forEach((o, n) => {
      // Flattened, tilted about x, turned about z; corners pushed in and out a little.
      const j = 0.75 + 0.5 * jitter[n % jitter.length]!;
      const x0 = o[0] * j;
      const y0 = o[1] * j * ct - o[2] * flat * j * st;
      const z0 = o[1] * j * st + o[2] * flat * j * ct;
      const local: P3 = [x0 * cy - y0 * sy, x0 * sy + y0 * cy, z0];
      const q: P3 = [p[0] + radius * size * local[0], p[1] + radius * size * local[1], p[2] + radius * size * local[2]];
      const out: P3 = [q[0] - mid[0], q[1] - mid[1], (q[2] - mid[2]) * (radius / height)];
      const ol = Math.hypot(out[0], out[1], out[2]) || 1;
      const ll = Math.hypot(local[0], local[1], local[2]) || 1;
      // (Mostly the crown's: with a third of its own facets a cluster near the eye shaded as a crumpled
      // sheet of paper. The shader adds the leaves' own scatter.)
      let n3: P3 = [0.12 * (local[0] / ll) + 0.88 * (out[0] / ol), 0.12 * (local[1] / ll) + 0.88 * (out[1] / ol), 0.12 * (local[2] / ll) + 0.88 * (out[2] / ol)];
      const nl = Math.hypot(n3[0], n3[1], n3[2]) || 1;
      n3 = [n3[0] / nl, n3[1] / nl, n3[2] / nl];
      b.vertex(q, n3, Math.min(1, Math.max(0, (q[2] - centre[2]) / height)), Math.min(1, Math.max(0, (shell - 0.5) * 2)));
    });
    for (const t of OCTA_TRIS) b.i.push(v0 + t);
  }
}

/** A leaning stem with a kink, thick at the foot. Wood: part 2. */
function trunk(b: Builder, from: P3, to: P3, r: number, sides: number): void {
  const rings: number[][] = [];
  const bend: P3 = [(to[1] - from[1]) * 0.18, -(to[0] - from[0]) * 0.18, 0];
  for (let j = 0; j <= 2; j++) {
    const t = j / 2;
    const k = 4 * t * (1 - t);
    const c: P3 = [from[0] + (to[0] - from[0]) * t + bend[0] * k, from[1] + (to[1] - from[1]) * t + bend[1] * k, from[2] + (to[2] - from[2]) * t];
    const ring: number[] = [];
    for (let s = 0; s < sides; s++) {
      const a = (2 * Math.PI * s) / sides;
      const n: P3 = [Math.cos(a), Math.sin(a), 0];
      const w = r * (1.5 - 0.9 * t);
      ring.push(b.vertex([c[0] + w * n[0], c[1] + w * n[1], c[2]], n, t * 0.5, 2));
    }
    rings.push(ring);
  }
  for (let j = 0; j < 2; j++) {
    for (let s = 0; s < sides; s++) {
      const a = rings[j]![s]!;
      const c = rings[j]![(s + 1) % sides]!;
      const d = rings[j + 1]![s]!;
      const e = rings[j + 1]![(s + 1) % sides]!;
      b.tri(a, c, e);
      b.tri(a, e, d);
    }
  }
}

/** Scale to the unit footprint and height by numbers that do not depend on the level of detail. */
function fit(b: Builder, reach: number, top: number): void {
  for (let k = 0; k < b.v.length; k += COVER_VERTEX_FLOATS) {
    b.v[k] = b.v[k]! / reach;
    b.v[k + 1] = b.v[k + 1]! / reach;
    b.v[k + 2] = b.v[k + 2]! / top;
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

function rawBush(variant: number, lod: number): Builder {
  const b = new Builder();
  crown(b, lod, 0.6, 2000 + variant * 17, [0, 0, 0], 1, 1, true);
  return b;
}

function rawTree(variant: number, lod: number): Builder {
  const b = new Builder();
  const seed = 3000 + variant * 23;
  const u = rng(seed);
  const lobes = 4;
  for (let k = 0; k < lobes; k++) {
    const a = (2 * Math.PI * (k + 0.7 * u())) / lobes;
    const off = k === 0 ? 0.1 : 0.42 + 0.25 * u();
    const centre: P3 = [off * Math.cos(a) + 0.15, off * Math.sin(a), 0.42 + 0.16 * u()];
    const radius = 0.5 + 0.18 * u();
    const height = 0.4 + 0.12 * u();
    if (lod < 2) {
      crown(b, lod, 0.42, seed + 31 * k, centre, radius, height, false);
      trunk(b, [0.07 * Math.cos(a), 0.07 * Math.sin(a), 0], [centre[0], centre[1], centre[2] + 0.35 * height], 0.035, lod === 0 ? 6 : 4);
    }
  }
  // From afar the four crowns are one: a few large pieces over the same ground.
  if (lod === 2) crown(b, 2, 0.5, seed + 5, [0.15, 0, 0.36], 1.05, 0.62, false);
  return b;
}

/** A crown mesh at a level of detail, scaled by the extent of its finest level (every level has the same size). */
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
    // A grove is never large on screen: its finest level is the trees' coarsest build.
    crown(b, lod === 2 ? 2 : 1, lod === 2 ? 0.14 : 0.12, seed + 37 * k, centre, radius, 0.55, false);
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
  if (ROCK_VERTEX_FLOATS !== COVER_VERTEX_FLOATS) throw new Error('cover: the rock vertex is not a cover vertex');
  return m;
}

export function buildCoverMesh(shape: CoverShape, variant: number, lod: number): CoverMeshData {
  if (shape === 'tuft') return buildTuft(variant, lod);
  if (shape === 'bush') return buildBush(variant, lod);
  if (shape === 'tree') return buildTree(variant, lod);
  if (shape === 'grove') return buildGrove(variant, lod);
  return buildStone(variant, lod);
}
