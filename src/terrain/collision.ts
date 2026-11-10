/**
 * The collision surface: bilinear interpolation of the height function sampled on the 65 x 65 vertex grid of
 * the body's maxRenderLevel tiles at the geometry band limit (2 quads) - exactly the vertices bakeGeometry
 * returns for those tiles, so contact happens on the drawn mesh.
 *
 * Vertices are evaluated lazily, one at a time, and memoised per max-level tile (Float32, identical to the
 * baked Float32Array). A query evaluates at most the four vertices of its quad. The memo is bounded
 * (capacity in tiles); tiles are evicted least-recently-used by the call-sequence counter, so eviction depends
 * only on the call sequence. Vertices computed while data was incomplete are provisional and are discarded
 * as soon as the body's resident data changes.
 */
import type { FaceId } from '../core/geo/cubeSphere';
import { CUBE_FACES } from '../core/geo/cubeSphere';
import type { Vec3 } from '../core/math/vec3';
import { faceStDir, GEOMETRY_GRID, GEOMETRY_QUADS, type BodyTerrain } from './body';
import { tilesInDisc } from './discTiles';

const NV = GEOMETRY_GRID * GEOMETRY_GRID;
const EPS1 = 1 - Number.EPSILON;

/** Face coordinate of vertex `i` (0..64) of tile column/row `x` at `level` (shared by collision and bakes). */
export function vertexFaceCoord(x: number, i: number, level: number): number {
  return -1 + (2 * (x + i / GEOMETRY_QUADS)) / 2 ** level;
}

export class MemoTile {
  face: FaceId = 0;
  x = 0;
  y = 0;
  key = -1;
  readonly h = new Float32Array(NV).fill(NaN);
  readonly prov = new Uint8Array(NV);
  evaluated = 0;
  provisional = 0;
  gen = 0;
  lastUse = 0;
  epoch = 0;

  clear(): void {
    this.h.fill(NaN);
    this.prov.fill(0);
    this.evaluated = 0;
    this.provisional = 0;
    this.epoch++;
  }
  /** Vertices evaluated on final data. */
  get final(): number {
    return this.evaluated - this.provisional;
  }
}

export class CollisionSurface {
  readonly level: number;
  readonly n: number;
  readonly log2Lambda: number;
  /** Total vertex evaluations (instrumented counter). */
  vertexEvaluations = 0;
  /** Bumped whenever any memo tile is cleared or recycled (prewarm jobs revalidate). */
  epochSum = 0;
  private readonly tiles = new Map<number, MemoTile>();
  private readonly pool: MemoTile[] = [];
  private last: MemoTile | null = null;
  private job: PrewarmJob | null = null;

  constructor(
    readonly body: BodyTerrain,
    readonly capacity: number,
  ) {
    this.level = body.maxRenderLevel;
    this.n = 2 ** this.level;
    this.log2Lambda = body.collisionLog2Lambda;
    if (!(capacity >= 4)) throw new Error('collision cache capacity must be at least 4 tiles');
  }

  get tileCount(): number {
    return this.tiles.size;
  }

  private keyOf(face: number, x: number, y: number): number {
    return (face * this.n + x) * this.n + y;
  }

  /** Memo tile for (face, x, y), created on demand; marks it used by the current call. */
  tile(face: FaceId, x: number, y: number): MemoTile {
    const key = this.keyOf(face, x, y);
    let t = this.last;
    if (!t || t.key !== key) {
      t = this.tiles.get(key) ?? null;
      if (!t) t = this.create(face, x, y, key);
      this.last = t;
    }
    t.lastUse = this.body.store.tick;
    if (t.provisional > 0 && t.gen !== this.body.dataGeneration()) {
      t.clear();
      this.epochSum++;
    }
    return t;
  }

  /** Existing memo tile or null (no creation, no use marking). */
  peekTile(face: number, x: number, y: number): MemoTile | null {
    const t = this.tiles.get(this.keyOf(face, x, y)) ?? null;
    if (t && t.provisional > 0 && t.gen !== this.body.dataGeneration()) {
      t.clear();
      this.epochSum++;
    }
    return t;
  }

  private create(face: FaceId, x: number, y: number, key: number): MemoTile {
    let t: MemoTile;
    if (this.tiles.size >= this.capacity) {
      let victim: MemoTile | null = null;
      for (const c of this.tiles.values()) if (!victim || c.lastUse < victim.lastUse || (c.lastUse === victim.lastUse && c.key < victim.key)) victim = c;
      this.tiles.delete(victim!.key);
      t = victim!;
      t.clear();
      this.epochSum++;
    } else t = this.pool.pop() ?? new MemoTile();
    t.face = face;
    t.x = x;
    t.y = y;
    t.key = key;
    this.tiles.set(key, t);
    return t;
  }

  /** Height of vertex (i, j) of memo tile t, evaluating it if needed. */
  vertex(t: MemoTile, i: number, j: number): number {
    const idx = j * GEOMETRY_GRID + i;
    const v = t.h[idx]!;
    if (v === v) return v;
    return this.evaluate(t, i, j);
  }

  /** Evaluate (or re-evaluate a provisional) vertex and memoise it. */
  evaluate(t: MemoTile, i: number, j: number): number {
    const idx = j * GEOMETRY_GRID + i;
    const ev = this.body.vertexEval;
    ev.setFaceSt(t.face, vertexFaceCoord(t.x, i, this.level), vertexFaceCoord(t.y, j, this.level));
    ev.incomplete = false;
    const h = ev.height(this.log2Lambda);
    this.vertexEvaluations++;
    const old = t.h[idx]!;
    if (old !== old) t.evaluated++;
    if (t.prov[idx]) {
      t.prov[idx] = 0;
      t.provisional--;
    }
    t.h[idx] = h;
    if (ev.incomplete) {
      t.prov[idx] = 1;
      t.provisional++;
      t.gen = this.body.dataGeneration();
    }
    return t.h[idx]!;
  }

  /** Collision height at a unit body-fixed direction. */
  heightAt(dir: Vec3): number {
    const ax = Math.abs(dir.x);
    const ay = Math.abs(dir.y);
    const az = Math.abs(dir.z);
    let face: FaceId;
    if (ax >= ay && ax >= az) face = dir.x >= 0 ? 0 : 1;
    else if (ay >= az) face = dir.y >= 0 ? 2 : 3;
    else face = dir.z >= 0 ? 4 : 5;
    const f = CUBE_FACES[face]!;
    const dn = dir.x * f.n[0] + dir.y * f.n[1] + dir.z * f.n[2];
    const s = (dir.x * f.u[0] + dir.y * f.u[1] + dir.z * f.u[2]) / dn;
    const tt = (dir.x * f.v[0] + dir.y * f.v[1] + dir.z * f.v[2]) / dn;
    const n = this.n;
    let fx = ((s + 1) / 2) * n;
    let fy = ((tt + 1) / 2) * n;
    if (fx < 0) fx = 0;
    else if (fx > n * EPS1) fx = n * EPS1;
    if (fy < 0) fy = 0;
    else if (fy > n * EPS1) fy = n * EPS1;
    let x = Math.floor(fx);
    let y = Math.floor(fy);
    if (x > n - 1) x = n - 1;
    if (y > n - 1) y = n - 1;
    const gu = (fx - x) * GEOMETRY_QUADS;
    const gv = (fy - y) * GEOMETRY_QUADS;
    let i0 = Math.floor(gu);
    let j0 = Math.floor(gv);
    if (i0 > GEOMETRY_QUADS - 1) i0 = GEOMETRY_QUADS - 1;
    if (j0 > GEOMETRY_QUADS - 1) j0 = GEOMETRY_QUADS - 1;
    const a = gu - i0;
    const c = gv - j0;
    const t = this.tile(face, x, y);
    const h = t.h;
    const o = j0 * GEOMETRY_GRID + i0;
    let h00 = h[o]!;
    let h10 = h[o + 1]!;
    let h01 = h[o + GEOMETRY_GRID]!;
    let h11 = h[o + GEOMETRY_GRID + 1]!;
    if (h00 !== h00) h00 = this.evaluate(t, i0, j0);
    if (h10 !== h10) h10 = this.evaluate(t, i0 + 1, j0);
    if (h01 !== h01) h01 = this.evaluate(t, i0, j0 + 1);
    if (h11 !== h11) h11 = this.evaluate(t, i0 + 1, j0 + 1);
    return (1 - c) * ((1 - a) * h00 + a * h10) + c * ((1 - a) * h01 + a * h11);
  }

  /**
   * Evaluate up to maxVertices missing vertices within `radius` m of `dir`, nearest first, and return how many
   * remain missing. A job (centre, radius) persists across calls with the same arguments.
   */
  prewarm(dir: Vec3, radius: number, maxVertices: number): number {
    const key = `${dir.x},${dir.y},${dir.z},${radius}`;
    if (!this.job || this.job.key !== key) {
      const job = new PrewarmJob(this, key, dir, radius);
      if (job.tileCount > this.capacity / 2) {
        throw new Error(
          `prewarmCollision: a ${radius} m radius needs ${job.tileCount} collision tiles but the cache holds ${this.capacity}; raise opts.collisionCacheTiles to at least ${2 * job.tileCount} or warm a smaller radius`,
        );
      }
      this.job = job;
    }
    return this.job.run(Math.max(0, Math.floor(maxVertices)));
  }
}

interface JobTile {
  face: FaceId;
  x: number;
  y: number;
  /** Lower bound of the squared distance from the centre to any vertex of the tile. */
  minD2: number;
  /** Vertices within the radius: count, and once opened, indices sorted by (distance, index). */
  within: number;
  order: Uint16Array | null;
  d2: Float64Array | null;
  cursor: number;
  opened: boolean;
}

class PrewarmJob {
  private readonly tiles: JobTile[] = [];
  private next = 0;
  private heapKey: number[] = [];
  private heapTile: number[] = [];
  private seenEpoch: number;
  private readonly cx: number;
  private readonly cy: number;
  private readonly cz: number;
  private readonly r2: number;

  constructor(
    private readonly surf: CollisionSurface,
    readonly key: string,
    dir: Vec3,
    radius: number,
  ) {
    const R = surf.body.radius;
    this.cx = dir.x * R;
    this.cy = dir.y * R;
    this.cz = dir.z * R;
    this.r2 = radius * radius;
    this.seenEpoch = surf.epochSum;
    const level = surf.level;
    const keys = tilesInDisc(dir, radius, level, R, () => true);
    for (const k of keys) {
      const c = this.corners(k.face, k.x, k.y);
      const minD = Math.max(0, Math.sqrt(parallelogramD2(c, this.cx, this.cy, this.cz)) - 0.01);
      if (minD * minD > this.r2) continue;
      const maxD2 = Math.max(d2Of(c, 0, this.cx, this.cy, this.cz), d2Of(c, 1, this.cx, this.cy, this.cz), d2Of(c, 2, this.cx, this.cy, this.cz), d2Of(c, 3, this.cx, this.cy, this.cz));
      let within = NV;
      const t: JobTile = { face: k.face, x: k.x, y: k.y, minD2: minD * minD, within, order: null, d2: null, cursor: 0, opened: false };
      if (Math.sqrt(maxD2) + 0.01 > radius) {
        this.computeOrder(t);
        within = t.order!.length;
        t.within = within;
      }
      if (within > 0) this.tiles.push(t);
    }
    this.tiles.sort((a, b) => a.minD2 - b.minD2 || a.face - b.face || a.x - b.x || a.y - b.y);
  }

  /** Corner positions (m) of a max-level tile: 00, 10, 01, 11 as 12 numbers. */
  private corners(face: FaceId, x: number, y: number): Float64Array {
    const R = this.surf.body.radius;
    const level = this.surf.level;
    const out = new Float64Array(12);
    for (let k = 0; k < 4; k++) {
      const i = k & 1 ? GEOMETRY_QUADS : 0;
      const j = k & 2 ? GEOMETRY_QUADS : 0;
      const d = faceStDir(face, vertexFaceCoord(x, i, level), vertexFaceCoord(y, j, level));
      out[3 * k] = d.x * R;
      out[3 * k + 1] = d.y * R;
      out[3 * k + 2] = d.z * R;
    }
    return out;
  }

  /** Within-radius vertices of a tile sorted by (bilinear-position distance, index). */
  private computeOrder(t: JobTile): void {
    const c = this.corners(t.face, t.x, t.y);
    const idx: number[] = [];
    const d2s: number[] = [];
    for (let j = 0; j < GEOMETRY_GRID; j++) {
      const b = j / GEOMETRY_QUADS;
      for (let i = 0; i < GEOMETRY_GRID; i++) {
        const a = i / GEOMETRY_QUADS;
        const w00 = (1 - a) * (1 - b);
        const w10 = a * (1 - b);
        const w01 = (1 - a) * b;
        const w11 = a * b;
        const px = w00 * c[0]! + w10 * c[3]! + w01 * c[6]! + w11 * c[9]! - this.cx;
        const py = w00 * c[1]! + w10 * c[4]! + w01 * c[7]! + w11 * c[10]! - this.cy;
        const pz = w00 * c[2]! + w10 * c[5]! + w01 * c[8]! + w11 * c[11]! - this.cz;
        const d2 = px * px + py * py + pz * pz;
        if (d2 > this.r2) continue;
        idx.push(j * GEOMETRY_GRID + i);
        d2s.push(d2);
      }
    }
    const perm = idx.map((_, k) => k);
    perm.sort((p, q) => d2s[p]! - d2s[q]! || idx[p]! - idx[q]!);
    t.order = Uint16Array.from(perm.map((p) => idx[p]!));
    t.d2 = Float64Array.from(perm.map((p) => d2s[p]!));
  }

  private push(key: number, tile: number): void {
    const hk = this.heapKey;
    const ht = this.heapTile;
    let i = hk.length;
    hk.push(key);
    ht.push(tile);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (hk[p]! < key || (hk[p] === key && ht[p]! < tile)) break;
      hk[i] = hk[p]!;
      ht[i] = ht[p]!;
      i = p;
    }
    hk[i] = key;
    ht[i] = tile;
  }

  private pop(): number {
    const hk = this.heapKey;
    const ht = this.heapTile;
    const top = ht[0]!;
    const lk = hk.pop()!;
    const lt = ht.pop()!;
    if (hk.length > 0) {
      let i = 0;
      const n = hk.length;
      for (;;) {
        const l = 2 * i + 1;
        if (l >= n) break;
        const r = l + 1;
        let m = l;
        if (r < n && (hk[r]! < hk[l]! || (hk[r] === hk[l] && ht[r]! < ht[l]!))) m = r;
        if (lk < hk[m]! || (lk === hk[m] && lt < ht[m]!)) break;
        hk[i] = hk[m]!;
        ht[i] = ht[m]!;
        i = m;
      }
      hk[i] = lk;
      ht[i] = lt;
    }
    return top;
  }

  private isFinal(t: JobTile, k: number): boolean {
    const m = this.surf.peekTile(t.face, t.x, t.y);
    if (!m) return false;
    const idx = t.order![k]!;
    const v = m.h[idx]!;
    return v === v && m.prov[idx] === 0;
  }

  private advance(ti: number): void {
    const t = this.tiles[ti]!;
    while (t.cursor < t.order!.length && this.isFinal(t, t.cursor)) t.cursor++;
    if (t.cursor < t.order!.length) this.push(t.d2![t.cursor]!, ti);
  }

  private open(ti: number): void {
    const t = this.tiles[ti]!;
    if (!t.order) this.computeOrder(t);
    t.opened = true;
    t.cursor = 0;
    this.advance(ti);
  }

  get tileCount(): number {
    return this.tiles.length;
  }

  /** Restart the cursors of opened tiles (memo tiles were cleared or recycled). */
  private restart(): void {
    this.seenEpoch = this.surf.epochSum;
    this.heapKey = [];
    this.heapTile = [];
    for (let i = 0; i < this.next; i++) {
      this.tiles[i]!.cursor = 0;
      this.advance(i);
    }
  }

  run(maxVertices: number): number {
    const surf = this.surf;
    let budget = maxVertices;
    let restarts = 0;
    while (budget > 0) {
      if (surf.epochSum !== this.seenEpoch) {
        if (restarts++ > 8) break;
        this.restart();
      }
      const lb = this.next < this.tiles.length ? this.tiles[this.next]!.minD2 : Infinity;
      const hk = this.heapKey.length > 0 ? this.heapKey[0]! : Infinity;
      if (this.next < this.tiles.length && lb <= hk) {
        this.open(this.next++);
        continue;
      }
      if (this.heapKey.length === 0) break;
      const ti = this.pop();
      const t = this.tiles[ti]!;
      const idx = t.order![t.cursor]!;
      const m = surf.tile(t.face, t.x, t.y);
      const v = m.h[idx]!;
      if (v !== v || m.prov[idx]) {
        surf.evaluate(m, idx % GEOMETRY_GRID, Math.floor(idx / GEOMETRY_GRID));
        budget--;
      }
      t.cursor++;
      this.advance(ti);
    }
    return this.remaining();
  }

  private remaining(): number {
    let missing = 0;
    for (const t of this.tiles) {
      const m = this.surf.peekTile(t.face, t.x, t.y);
      if (!m) {
        missing += t.within;
        continue;
      }
      if (m.final === NV) continue;
      if (t.within === NV) {
        missing += NV - m.final;
        continue;
      }
      if (!t.order) this.computeOrder(t);
      for (let k = 0; k < t.order!.length; k++) {
        const idx = t.order![k]!;
        const v = m.h[idx]!;
        if (v !== v || m.prov[idx]) missing++;
      }
    }
    return missing;
  }
}

function d2Of(c: Float64Array, k: number, x: number, y: number, z: number): number {
  const dx = c[3 * k]! - x;
  const dy = c[3 * k + 1]! - y;
  const dz = c[3 * k + 2]! - z;
  return dx * dx + dy * dy + dz * dz;
}

/** Squared distance from point to the parallelogram c00 + a (c10 - c00) + b (c01 - c00), a, b in [0, 1]. */
function parallelogramD2(c: Float64Array, x: number, y: number, z: number): number {
  const ox = c[0]!;
  const oy = c[1]!;
  const oz = c[2]!;
  const e1x = c[3]! - ox;
  const e1y = c[4]! - oy;
  const e1z = c[5]! - oz;
  const e2x = c[6]! - ox;
  const e2y = c[7]! - oy;
  const e2z = c[8]! - oz;
  const qx = x - ox;
  const qy = y - oy;
  const qz = z - oz;
  const a11 = e1x * e1x + e1y * e1y + e1z * e1z;
  const a12 = e1x * e2x + e1y * e2y + e1z * e2z;
  const a22 = e2x * e2x + e2y * e2y + e2z * e2z;
  const b1 = qx * e1x + qy * e1y + qz * e1z;
  const b2 = qx * e2x + qy * e2y + qz * e2z;
  const det = a11 * a22 - a12 * a12;
  let a = (b1 * a22 - b2 * a12) / det;
  let b = (b2 * a11 - b1 * a12) / det;
  const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
  if (a < 0 || a > 1 || b < 0 || b > 1) {
    // Closest point on the boundary: try the four edges.
    let best = Infinity;
    const edge = (fa: number | null, fb: number | null): void => {
      let aa: number;
      let bb: number;
      if (fa !== null) {
        aa = fa;
        bb = clamp01((b2 - aa * a12) / a22);
      } else {
        bb = fb!;
        aa = clamp01((b1 - bb * a12) / a11);
      }
      const px = qx - aa * e1x - bb * e2x;
      const py = qy - aa * e1y - bb * e2y;
      const pz = qz - aa * e1z - bb * e2z;
      const d = px * px + py * py + pz * pz;
      if (d < best) best = d;
    };
    edge(0, null);
    edge(1, null);
    edge(null, 0);
    edge(null, 1);
    return best;
  }
  a = clamp01(a);
  b = clamp01(b);
  const px = qx - a * e1x - b * e2x;
  const py = qy - a * e1y - b * e2y;
  const pz = qz - a * e1z - b * e2z;
  return px * px + py * py + pz * pz;
}
