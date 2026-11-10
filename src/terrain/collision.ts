/**
 * The collision surface: bilinear interpolation of the height function sampled on the 65 x 65 vertex grid of
 * the body's maxRenderLevel tiles at the geometry band limit (2 quads) - exactly the vertices bakeGeometry
 * returns for those tiles, so contact happens on the drawn mesh.
 *
 * Vertices are evaluated lazily, one at a time, and memoised per max-level tile (Float32, identical to the
 * baked Float32Array). A query evaluates at most the four vertices of its quad. The memo is bounded
 * (capacity in tiles, one slab allocated by allocate(): ensureLoaded and prewarmCollision call it, so the
 * first contact query never pays for it); tiles are evicted least-recently-used by the call-sequence counter,
 * so eviction depends only on the call sequence. Vertices computed while data was incomplete are provisional
 * and are discarded as soon as the body's resident data changes.
 *
 * prewarm(): see PrewarmJob.
 */
import type { FaceId } from '../core/geo/cubeSphere';
import { CUBE_FACES } from '../core/geo/cubeSphere';
import type { Vec3 } from '../core/math/vec3';
import { faceStDir, GEOMETRY_GRID, GEOMETRY_QUADS, type BodyTerrain } from './body';
import { POW2 } from './util';

const NV = GEOMETRY_GRID * GEOMETRY_GRID;
const EPS1 = 1 - Number.EPSILON;

/** Face coordinate of vertex `i` (0..64) of tile column/row `x` at `level` (shared by collision and bakes). */
export function vertexFaceCoord(x: number, i: number, level: number): number {
  return -1 + (2 * (x + i / GEOMETRY_QUADS)) / POW2[level]!;
}

export class MemoTile {
  face: FaceId = 0;
  x = 0;
  y = 0;
  key = -1;
  constructor(
    readonly h: Float32Array,
    readonly prov: Uint8Array,
  ) {}
  evaluated = 0;
  provisional = 0;
  gen = 0;
  /** Bumped whenever the tile is cleared (its vertices are missing again). */
  epoch = 0;
  /** LRU list links (most recently used at the head). */
  prev: MemoTile | null = null;
  next: MemoTile | null = null;

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
  /** Edge length of a collision quad at the face centre (m): the scale of prewarm slack and ordering. */
  readonly quad: number;
  /** Total vertex evaluations (instrumented counter). */
  vertexEvaluations = 0;
  /**
   * Bookkeeping work of prewarm (instrumented, deterministic): vertex slots scanned or sorted, heap
   * operations and tiles visited. Lets tests check that a call's cost follows its budget.
   */
  prewarmWork = 0;
  /** Bumped whenever any memo tile is cleared or recycled (prewarm jobs revalidate). */
  epochSum = 0;
  private readonly tiles = new Map<number, MemoTile>();
  private last: MemoTile | null = null;
  private job: PrewarmJob | null = null;
  // LRU list: head = most recently used. The order is the order of calls, never of time.
  private head: MemoTile | null = null;
  private tail: MemoTile | null = null;
  private free: MemoTile[] | null = null;

  constructor(
    readonly body: BodyTerrain,
    readonly capacity: number,
  ) {
    this.level = body.maxRenderLevel;
    this.n = POW2[this.level]!;
    this.log2Lambda = body.collisionLog2Lambda;
    this.quad = body.tileSize(this.level) / GEOMETRY_QUADS;
    if (!(capacity >= 4)) throw new Error('collision cache capacity must be at least 4 tiles');
  }

  get tileCount(): number {
    return this.tiles.size;
  }

  /** Bytes of the memo slab (0 until allocated). */
  get memoBytes(): number {
    return this.free ? this.capacity * NV * 5 : 0;
  }

  /** Radius (m) and centre of the current prewarm job, and whether its radius was clamped to the memo. */
  get prewarmState(): { radius: number; clamped: boolean } | null {
    return this.job ? { radius: this.job.r0, clamped: this.job.clamped } : null;
  }

  /**
   * Allocate the memo slab (once). Zero-filled memory from the allocator (cheap); a tile is NaN-filled when it
   * is taken into use. Steady-state queries never allocate (no GC pauses at touchdown).
   */
  allocate(): void {
    if (this.free) return;
    const hs = new Float32Array(this.capacity * NV);
    const ps = new Uint8Array(this.capacity * NV);
    const free: MemoTile[] = [];
    for (let k = this.capacity - 1; k >= 0; k--) free.push(new MemoTile(hs.subarray(k * NV, (k + 1) * NV), ps.subarray(k * NV, (k + 1) * NV)));
    this.free = free;
  }

  keyOf(face: number, x: number, y: number): number {
    return (face * this.n + x) * this.n + y;
  }

  private unlink(t: MemoTile): void {
    if (t.prev) t.prev.next = t.next;
    else this.head = t.next;
    if (t.next) t.next.prev = t.prev;
    else this.tail = t.prev;
    t.prev = null;
    t.next = null;
  }

  private pushFront(t: MemoTile): void {
    t.prev = null;
    t.next = this.head;
    if (this.head) this.head.prev = t;
    this.head = t;
    if (!this.tail) this.tail = t;
  }

  /** Memo tile for (face, x, y), created on demand; marks it used by the current call. */
  tile(face: FaceId, x: number, y: number): MemoTile {
    const key = this.keyOf(face, x, y);
    let t = this.last;
    if (!t || t.key !== key) {
      t = this.tiles.get(key) ?? null;
      if (!t) t = this.create(face, x, y, key);
      else if (t !== this.head) {
        this.unlink(t);
        this.pushFront(t);
      }
      this.last = t;
    }
    if (t.provisional > 0 && t.gen !== this.body.dataGeneration()) {
      t.clear();
      this.epochSum++;
    }
    return t;
  }

  /** Existing memo tile or null (no creation, no use marking). */
  peekTile(key: number): MemoTile | null {
    const t = this.tiles.get(key) ?? null;
    if (t && t.provisional > 0 && t.gen !== this.body.dataGeneration()) {
      t.clear();
      this.epochSum++;
    }
    return t;
  }

  private create(face: FaceId, x: number, y: number, key: number): MemoTile {
    if (!this.free) this.allocate();
    let t: MemoTile;
    if (this.free!.length > 0) {
      t = this.free!.pop()!;
      t.clear();
    } else {
      // Recycle the least recently used tile (O(1)).
      t = this.tail!;
      this.unlink(t);
      this.tiles.delete(t.key);
      t.clear();
      this.epochSum++;
    }
    t.face = face;
    t.x = x;
    t.y = y;
    t.key = key;
    this.tiles.set(key, t);
    this.pushFront(t);
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
   * remain missing in the job's disc (which contains the requested disc). See PrewarmJob for reuse and slack.
   */
  prewarm(dir: Vec3, radius: number, maxVertices: number): number {
    this.allocate();
    const job = this.job;
    const R = this.body.radius;
    let reuse = false;
    let moved = false;
    if (job) {
      const dx = (dir.x - job.dx) * R;
      const dy = (dir.y - job.dy) * R;
      const dz = (dir.z - job.dz) * R;
      const off = Math.sqrt(dx * dx + dy * dy + dz * dz);
      moved = off > 0;
      // A clamped job (radius beyond what the memo holds) is kept while the centre stays within the slack.
      if (!job.clamped) reuse = off + radius <= job.r0 * (1 + 1e-12);
      else reuse = radius === job.requested && off <= Math.max(4 * this.quad, 0.1 * job.r0);
    }
    if (!reuse) {
      // A caller that keeps its centre gets exactly its disc; a moving centre gets a job with slack, reused
      // while the requested disc stays inside it (the predicted touchdown point moves every tick).
      const slack = moved ? Math.max(4 * this.quad, 0.1 * radius) : 0;
      this.job = new PrewarmJob(this, dir, radius, radius + slack);
    }
    return this.job!.run(Math.max(0, Math.floor(maxVertices)));
  }
}

/** One max-level tile of a prewarm job. */
interface JobTile {
  face: FaceId;
  x: number;
  y: number;
  key: number;
  /** Bilinear-position corners (m): 00, 10, 01, 11. */
  c: Float64Array;
  /** Lower bound of the distance from the centre to any vertex of the tile, in order buckets. */
  minBucket: number;
  /** In-disc vertex interval per row (lo > hi = empty); null = every vertex of the tile is in the disc. */
  lo: Int8Array | null;
  hi: Int8Array | null;
  inDisc: number;
  /** In-disc vertices not evaluated on final data (exact while seenEpoch / seenFinal match the memo). */
  missing: number;
  seenEpoch: number;
  seenFinal: number;
  seenMemo: boolean;
  /** Once opened: in-disc vertex indices in (bucket, index) order, their buckets, and the merge cursor. */
  order: Uint16Array | null;
  bucket: Uint16Array | null;
  cursor: number;
}

/** Work units charged against the vertex budget for sorting one tile's vertices (per this many vertices). */
const OPEN_VERTICES_PER_UNIT = 256;

/**
 * A prewarm job: disc (centre c0, radius r0) on the vertex grid of the collision level.
 *  - Tiles: enumerated at creation from the face-coordinate extent of the disc (O(tiles)); a radius whose tiles
 *    exceed half the memo capacity is clamped to the largest disc whose tiles fit (prewarmState.clamped).
 *  - Per tile, the in-disc vertices are found row by row (interval of a convex quadratic, endpoints verified
 *    with the exact per-vertex distance) and counted at creation; they are ordered (counting sort on distance
 *    buckets of a quarter quad, then index) only when the merge reaches the tile, and opening a tile is charged
 *    against the budget (one unit per 256 vertices), so a call's work follows maxVertices.
 *  - Nearest first: a k-way merge over the opened tiles by (bucket, tile, index), opening tiles in order of
 *    their nearest possible bucket: exact distance order up to a quarter quad.
 *  - remaining(): the sum of per-tile missing counts, revalidated in O(1) per tile (memo epoch and final
 *    counters) and recounted only for tiles whose memo changed by other means (queries, eviction, new data).
 */
class PrewarmJob {
  readonly dx: number;
  readonly dy: number;
  readonly dz: number;
  readonly r0: number;
  readonly clamped: boolean;
  private readonly cx: number;
  private readonly cy: number;
  private readonly cz: number;
  private readonly r2: number;
  private readonly bw: number;
  private readonly tiles: JobTile[] = [];
  private next = 0;
  private heapKey: number[] = [];
  private heapTile: number[] = [];
  private seenEpochSum: number;

  constructor(
    private readonly surf: CollisionSurface,
    dir: Vec3,
    readonly requested: number,
    radius: number,
  ) {
    const R = surf.body.radius;
    this.dx = dir.x;
    this.dy = dir.y;
    this.dz = dir.z;
    this.cx = dir.x * R;
    this.cy = dir.y * R;
    this.cz = dir.z * R;
    this.bw = surf.quad / 4;
    this.seenEpochSum = surf.epochSum;
    const found = this.enumerate(dir, radius);
    found.sort((a, b) => a.minD - b.minD || a.key - b.key);
    let r0 = radius;
    let clamped = false;
    const maxTiles = Math.floor(surf.capacity / 2);
    if (found.length > maxTiles) {
      // Every vertex closer than the nearest excluded tile lies in a kept tile.
      r0 = Math.max(0, found[maxTiles]!.minD);
      found.length = maxTiles;
      clamped = true;
    }
    this.r0 = r0;
    this.clamped = clamped;
    this.r2 = r0 * r0;
    for (const f of found) {
      if (f.minD > r0) continue;
      const t: JobTile = {
        face: f.face,
        x: f.x,
        y: f.y,
        key: f.key,
        c: f.c,
        minBucket: Math.floor(f.minD / this.bw),
        lo: null,
        hi: null,
        inDisc: NV,
        missing: NV,
        seenEpoch: -1,
        seenFinal: -1,
        seenMemo: false,
        order: null,
        bucket: null,
        cursor: 0,
      };
      if (f.maxD > r0) this.rows(t);
      if (t.inDisc === 0) continue;
      this.recount(t);
      this.tiles.push(t);
    }
    surf.prewarmWork += found.length;
  }

  /**
   * Candidate tiles of the collision level near the disc: per face whose plane the disc reaches, the index
   * range of the disc's face-coordinate extent (padded), filtered by the exact parallelogram distance.
   */
  private enumerate(dir: Vec3, radius: number): { face: FaceId; x: number; y: number; key: number; c: Float64Array; minD: number; maxD: number }[] {
    const surf = this.surf;
    const R = surf.body.radius;
    const n = surf.n;
    const out: { face: FaceId; x: number; y: number; key: number; c: Float64Array; minD: number; maxD: number }[] = [];
    // Angular radius of the disc (chord <= arc), plus slack for the 1 cm minD margin.
    const ang = (radius + 0.02) / R;
    for (let face = 0; face < 6; face++) {
      const f = CUBE_FACES[face]!;
      const dn = dir.x * f.n[0] + dir.y * f.n[1] + dir.z * f.n[2];
      // A unit direction on face f has q.n_f >= 1/sqrt(3); within `ang` of dir that needs dir.n_f >= 1/sqrt(3) - ang.
      if (dn <= 0 || dn < 1 / Math.sqrt(3) - ang - 1e-9) continue;
      const s = (dir.x * f.u[0] + dir.y * f.u[1] + dir.z * f.u[2]) / dn;
      const t = (dir.x * f.v[0] + dir.y * f.v[1] + dir.z * f.v[2]) / dn;
      // |grad_q s| <= 1 / (q.n)^2 on the gnomonic plane, and q.n >= dn - ang along the arc from dir: the disc
      // stays within ang / (dn - ang)^2 of (s, t); pad by two tiles (2 / n each in face coordinates).
      const lowest = Math.max(dn - ang, 1e-3);
      const ext = ang / (lowest * lowest) + 4 / n;
      const x0 = Math.max(0, Math.floor(((s - ext + 1) / 2) * n));
      const x1 = Math.min(n - 1, Math.floor(((s + ext + 1) / 2) * n));
      const y0 = Math.max(0, Math.floor(((t - ext + 1) / 2) * n));
      const y1 = Math.min(n - 1, Math.floor(((t + ext + 1) / 2) * n));
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          const c = this.corners(face as FaceId, x, y);
          const minD = Math.max(0, Math.sqrt(parallelogramD2(c, this.cx, this.cy, this.cz)) - 0.01);
          if (minD > radius) continue;
          const maxD = Math.sqrt(Math.max(d2Of(c, 0, this.cx, this.cy, this.cz), d2Of(c, 1, this.cx, this.cy, this.cz), d2Of(c, 2, this.cx, this.cy, this.cz), d2Of(c, 3, this.cx, this.cy, this.cz))) + 0.01;
          out.push({ face: face as FaceId, x, y, key: surf.keyOf(face, x, y), c, minD, maxD });
        }
      }
    }
    return out;
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

  /** Squared distance of vertex (i, j)'s bilinear position from the centre (the in-disc predicate). */
  private vd2(c: Float64Array, i: number, j: number): number {
    const a = i / GEOMETRY_QUADS;
    const b = j / GEOMETRY_QUADS;
    const w00 = (1 - a) * (1 - b);
    const w10 = a * (1 - b);
    const w01 = (1 - a) * b;
    const w11 = a * b;
    const px = w00 * c[0]! + w10 * c[3]! + w01 * c[6]! + w11 * c[9]! - this.cx;
    const py = w00 * c[1]! + w10 * c[4]! + w01 * c[7]! + w11 * c[10]! - this.cy;
    const pz = w00 * c[2]! + w10 * c[5]! + w01 * c[8]! + w11 * c[11]! - this.cz;
    return px * px + py * py + pz * pz;
  }

  /** Per-row in-disc intervals of a tile the disc boundary crosses (positions are affine along a row). */
  private rows(t: JobTile): void {
    const c = t.c;
    const lo = new Int8Array(GEOMETRY_GRID);
    const hi = new Int8Array(GEOMETRY_GRID);
    let count = 0;
    const r2 = this.r2;
    for (let j = 0; j < GEOMETRY_GRID; j++) {
      // d2(i) = A + 2 B i + C i^2 from three exact samples (a convex quadratic in i).
      const f0 = this.vd2(c, 0, j);
      const f1 = this.vd2(c, 32, j);
      const f2 = this.vd2(c, 64, j);
      const C2 = (f2 - 2 * f1 + f0) / (2 * 32 * 32);
      const B2 = (f1 - f0) / 32 - C2 * 32;
      const disc = B2 * B2 - 4 * C2 * (f0 - r2);
      let a = 1;
      let b = 0;
      if (disc >= 0 && C2 > 0) {
        const sq = Math.sqrt(disc);
        a = Math.max(0, Math.ceil((-B2 - sq) / (2 * C2)) - 1);
        b = Math.min(GEOMETRY_QUADS, Math.floor((-B2 + sq) / (2 * C2)) + 1);
        // Exact endpoints with the per-vertex predicate.
        while (a <= b && this.vd2(c, a, j) > r2) a++;
        while (b >= a && this.vd2(c, b, j) > r2) b--;
        while (a > 0 && a <= GEOMETRY_GRID && this.vd2(c, a - 1, j) <= r2) a--;
        while (b < GEOMETRY_QUADS && b >= -1 && this.vd2(c, b + 1, j) <= r2) b++;
      }
      if (a < 0 || a > GEOMETRY_QUADS || b < 0 || b > GEOMETRY_QUADS || b < a) {
        // Empty row (the stored interval must stay inside 0..64: Int8 storage).
        a = 1;
        b = 0;
      }
      lo[j] = a;
      hi[j] = b;
      if (b >= a) count += b - a + 1;
    }
    this.surf.prewarmWork += GEOMETRY_GRID;
    t.lo = lo;
    t.hi = hi;
    t.inDisc = count;
  }

  /** Recount a tile's missing in-disc vertices from its memo tile (and remember what the count was based on). */
  private recount(t: JobTile): void {
    const m = this.surf.peekTile(t.key);
    if (!m) {
      t.missing = t.inDisc;
      t.seenMemo = false;
      return;
    }
    t.seenMemo = true;
    t.seenEpoch = m.epoch;
    t.seenFinal = m.final;
    if (m.final === 0) {
      t.missing = t.inDisc;
      return;
    }
    if (t.lo === null) {
      // Every vertex of the tile is in the disc.
      t.missing = NV - m.final;
      return;
    }
    let missing = 0;
    const h = m.h;
    const p = m.prov;
    for (let j = 0; j < GEOMETRY_GRID; j++) {
      const a = t.lo ? t.lo[j]! : 0;
      const b = t.hi ? t.hi[j]! : GEOMETRY_QUADS;
      for (let i = a, o = j * GEOMETRY_GRID + a; i <= b; i++, o++) {
        const v = h[o]!;
        if (v !== v || p[o]) missing++;
      }
    }
    this.surf.prewarmWork += t.inDisc;
    t.missing = missing;
  }

  /** Revalidate a tile's count against its memo tile (O(1) when nothing changed behind the job's back). */
  private validate(t: JobTile): void {
    const m = this.surf.peekTile(t.key);
    if (!m) {
      if (t.seenMemo) this.recount(t);
      return;
    }
    if (!t.seenMemo || m.epoch !== t.seenEpoch || m.final !== t.seenFinal) this.recount(t);
  }

  /** Order the tile's in-disc vertices by (distance bucket, index): counting sort. */
  private open(ti: number): void {
    const t = this.tiles[ti]!;
    if (!t.order) {
      const c = t.c;
      const idx = new Uint16Array(t.inDisc);
      const bk = new Uint16Array(t.inDisc);
      let k = 0;
      let bMin = Infinity;
      let bMax = -Infinity;
      for (let j = 0; j < GEOMETRY_GRID; j++) {
        const a = t.lo ? t.lo[j]! : 0;
        const b = t.hi ? t.hi[j]! : GEOMETRY_QUADS;
        for (let i = a; i <= b; i++) {
          const q = Math.floor(Math.sqrt(this.vd2(c, i, j)) / this.bw);
          idx[k] = j * GEOMETRY_GRID + i;
          bk[k] = q;
          if (q < bMin) bMin = q;
          if (q > bMax) bMax = q;
          k++;
        }
      }
      const nb = bMax - bMin + 1;
      const counts = new Int32Array(nb + 1);
      for (let e = 0; e < k; e++) counts[bk[e]! - bMin + 1]!++;
      for (let e = 0; e < nb; e++) counts[e + 1]! += counts[e]!;
      const order = new Uint16Array(k);
      const obk = new Uint16Array(k);
      // Stable: indices stay in ascending order within a bucket.
      for (let e = 0; e < k; e++) {
        const slot = counts[bk[e]! - bMin]!++;
        order[slot] = idx[e]!;
        obk[slot] = bk[e]!;
      }
      t.order = order;
      t.bucket = obk;
      this.surf.prewarmWork += 3 * k;
    }
    t.cursor = 0;
    this.advance(ti);
  }

  private isFinal(m: MemoTile | null, idx: number): boolean {
    if (!m) return false;
    const v = m.h[idx]!;
    return v === v && m.prov[idx] === 0;
  }

  private advance(ti: number): void {
    const t = this.tiles[ti]!;
    const order = t.order!;
    const m = this.surf.peekTile(t.key);
    let k = t.cursor;
    while (k < order.length && this.isFinal(m, order[k]!)) k++;
    this.surf.prewarmWork += k - t.cursor + 1;
    t.cursor = k;
    if (k < order.length) this.push(t.bucket![k]!, ti);
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

  /** Memo tiles were cleared or recycled somewhere: restart the cursors of the opened tiles. */
  private restart(): void {
    this.seenEpochSum = this.surf.epochSum;
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
      if (surf.epochSum !== this.seenEpochSum) {
        if (restarts++ > 8) break;
        this.restart();
      }
      const nb = this.next < this.tiles.length ? this.tiles[this.next]!.minBucket : Infinity;
      const hk = this.heapKey.length > 0 ? this.heapKey[0]! : Infinity;
      if (this.next < this.tiles.length && nb <= hk) {
        const t = this.tiles[this.next]!;
        budget -= Math.ceil(t.inDisc / OPEN_VERTICES_PER_UNIT);
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
        this.validate(t);
        surf.evaluate(m, idx % GEOMETRY_GRID, Math.floor(idx / GEOMETRY_GRID));
        budget--;
        // The job's own evaluation: keep the count exact without a rescan.
        if (m.prov[idx] === 0) t.missing--;
        t.seenMemo = true;
        t.seenEpoch = m.epoch;
        t.seenFinal = m.final;
      }
      t.cursor++;
      this.advance(ti);
    }
    return this.remaining();
  }

  private remaining(): number {
    let missing = 0;
    for (const t of this.tiles) {
      this.validate(t);
      missing += t.missing;
    }
    this.surf.prewarmWork += this.tiles.length;
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
