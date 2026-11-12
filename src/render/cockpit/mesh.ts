/**
 * Mesh builder for the cockpit interior: one interleaved vertex format (48 bytes) carrying everything the
 * interior shader needs per vertex, plus the primitives the cabin generators are made of (parametric
 * patches, bevelled boxes, extruded outlines with holes, swept tubes, lathes).
 *
 * Vertex layout (byte offsets):
 *    0 position   float32x3   capsule part frame, m
 *   12 normal     snorm16x4   xyz (w unused)
 *   20 tangent    snorm16x4   xyz along +uv0.x, w = bitangent sign
 *   28 uv0        float32x2   surface coordinates in metres (procedural detail)
 *   36 uv1        unorm16x2   label-atlas coordinates (when FLAG_LABEL is set); otherwise x = the longest
 *                             triangle edge at this vertex / EDGE_REACH_MAX
 *   40 misc       uint8x4     material index, cavity (0..255: 255 = open; modelled creases only, the
 *                             occlusion by other geometry is baked separately, occlusion.ts), flags,
 *                             ink colour (labels) or part seed (everything else)
 *   44 control    uint16x2    control index (0 = static), sub index (segment bit of a seven-segment digit)
 *
 * Every primitive call starts a new PART: its vertices carry a part seed (0..255) so that the shader can
 * vary tone, wear and pattern phase from part to part (no two panels or blankets look identical).
 */
import { v3, type Vec3 } from '@/core/math';

export const VERTEX_STRIDE = 48;
export const FLAG_LABEL = 1;
/** Vertex flag: a chamfer or bevel along an edge (where paint wears through first). */
export const FLAG_EDGE = 2;
/**
 * A chamfer's second surface coordinate runs 0 .. EDGE_SPAN across it whatever its width, so the shader
 * knows where on the chamfer a pixel lies (paint wears through along its middle first).
 */
export const EDGE_SPAN = 0.01;
/** Largest edge length (m) a vertex's stored reach can state (see MeshBuilder.build). */
export const EDGE_REACH_MAX = 4;
/** Reach assumed for a label's vertices, whose atlas slot is taken (no label is larger). */
export const LABEL_REACH = 0.35;

export interface Attr {
  /** Material index into the layout's material list. */
  mat: number;
  /** Modelled cavity 0..1 (creases of a quilt or a cushion seam; default 1 = open). */
  ao?: number;
  /** Control index (0 = static) and sub index. */
  ctl?: number;
  sub?: number;
  flags?: number;
  /** Label ink colour (index into LABEL_COLORS); only with `label`. */
  ink?: number;
  /** Label atlas rectangle [u0, v0, u1, v1] mapped onto uv0 normalised by `labelSize`. */
  label?: { rect: [number, number, number, number]; origin: [number, number]; size: [number, number] };
}

export interface Frame {
  o: Vec3;
  /** Unit axes: x (width / +u), y (height / +v), n (out of the face). */
  x: Vec3;
  y: Vec3;
  n: Vec3;
}

export function frameAt(o: Vec3, x: Vec3, y: Vec3): Frame {
  const xn = v3.normalize(x);
  const n = v3.normalize(v3.cross(xn, y));
  return { o, x: xn, y: v3.cross(n, xn), n };
}

export const local = (f: Frame, a: number, b: number, c = 0): Vec3 => ({
  x: f.o.x + f.x.x * a + f.y.x * b + f.n.x * c,
  y: f.o.y + f.x.y * a + f.y.y * b + f.n.y * c,
  z: f.o.z + f.x.z * a + f.y.z * b + f.n.z * c,
});
export const localDir = (f: Frame, a: number, b: number, c = 0): Vec3 => ({
  x: f.x.x * a + f.y.x * b + f.n.x * c,
  y: f.x.y * a + f.y.y * b + f.n.y * c,
  z: f.x.z * a + f.y.z * b + f.n.z * c,
});
/** Frame moved by (a, b, c) in its own axes. */
export const offsetFrame = (f: Frame, a: number, b: number, c = 0): Frame => ({ ...f, o: local(f, a, b, c) });
/** Frame rotated about its own x axis by angle (rad): y toward n for positive angles. */
export function tiltFrame(f: Frame, angle: number): Frame {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return { o: f.o, x: f.x, y: v3.add(v3.scale(f.y, c), v3.scale(f.n, s)), n: v3.sub(v3.scale(f.n, c), v3.scale(f.y, s)) };
}
/** Frame rotated about its own y axis by angle (rad): x toward -n for positive angles (turns the face toward +x). */
export function yawFrame(f: Frame, angle: number): Frame {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return { o: f.o, x: v3.add(v3.scale(f.x, c), v3.scale(f.n, -s)), y: f.y, n: v3.add(v3.scale(f.n, c), v3.scale(f.x, s)) };
}

const clamp16 = (x: number): number => Math.max(-32767, Math.min(32767, Math.round(x * 32767)));

export interface BuiltMesh {
  vertices: ArrayBuffer;
  vertexCount: number;
  indices: Uint32Array;
  /** Index ranges of each part (LOD) that was closed with `mark`. */
  ranges: Record<string, { start: number; count: number }>;
  /** Vertex ranges of the same parts (each LOD's vertices are contiguous). */
  vertexRanges: Record<string, { start: number; count: number }>;
  bounds: { min: Vec3; max: Vec3 };
  /**
   * The assembly every vertex belongs to (MeshBuilder.group): an index into groupNames per vertex. A
   * triangle belongs to the assembly of its first vertex. The penetration check (penetration.ts) tests the
   * assemblies against the hull and against each other.
   */
  groupNames: string[];
  vertexGroup: Uint16Array;
}

export class MeshBuilder {
  private pos: number[] = [];
  private nrm: number[] = [];
  private tan: number[] = [];
  private uv0: number[] = [];
  private uv1: number[] = [];
  private misc: number[] = [];
  private ctl: number[] = [];
  readonly idx: number[] = [];
  private rangeStart = 0;
  private vertexStart = 0;
  readonly ranges: Record<string, { start: number; count: number }> = {};
  readonly vertexRanges: Record<string, { start: number; count: number }> = {};
  /** Longest edge of a flat face before it is subdivided (m; Infinity = never), so baked occlusion has vertices to live on. */
  maxEdge = Infinity;
  private partSeed = 0;
  private grp: number[] = [];
  private readonly groupNames: string[] = [''];
  private currentGroup = 0;

  /**
   * Name the assembly the following vertices belong to (a console, one couch, its harness, a locker...): what
   * is bolted or sewn together and may overlap itself, but must not run into another assembly or the hull.
   */
  group(name: string): void {
    let i = this.groupNames.indexOf(name);
    if (i < 0) i = this.groupNames.push(name) - 1;
    this.currentGroup = i;
  }
  get groupName(): string {
    return this.groupNames[this.currentGroup]!;
  }

  /** Start a new part: the following vertices get a new seed. */
  part(): void {
    this.partSeed = (this.partSeed * 1103515245 + 12345) >>> 0;
  }

  get vertexCount(): number {
    return this.pos.length / 3;
  }
  get triangleCount(): number {
    return this.idx.length / 3;
  }

  position(i: number): Vec3 {
    return { x: this.pos[i * 3]!, y: this.pos[i * 3 + 1]!, z: this.pos[i * 3 + 2]! };
  }
  normal(i: number): Vec3 {
    return { x: this.nrm[i * 3]!, y: this.nrm[i * 3 + 1]!, z: this.nrm[i * 3 + 2]! };
  }
  materialOf(i: number): number {
    return this.misc[i * 4]!;
  }
  controlOf(i: number): number {
    return this.ctl[i * 2]!;
  }
  flagsOf(i: number): number {
    return this.misc[i * 4 + 2]!;
  }

  vertex(p: Vec3, n: Vec3, t: Vec3, uv: [number, number], a: Attr, tw = 1): number {
    const i = this.vertexCount;
    this.pos.push(p.x, p.y, p.z);
    const nl = Math.hypot(n.x, n.y, n.z) || 1;
    this.nrm.push(n.x / nl, n.y / nl, n.z / nl);
    // Tangent orthogonalised against the normal (Gram-Schmidt); any vector if degenerate.
    let tx = t.x - (n.x / nl) * ((t.x * n.x + t.y * n.y + t.z * n.z) / nl);
    let ty = t.y - (n.y / nl) * ((t.x * n.x + t.y * n.y + t.z * n.z) / nl);
    let tz = t.z - (n.z / nl) * ((t.x * n.x + t.y * n.y + t.z * n.z) / nl);
    let tl = Math.hypot(tx, ty, tz);
    if (tl < 1e-9) {
      const o = v3.anyOrthogonal({ x: n.x / nl, y: n.y / nl, z: n.z / nl });
      tx = o.x;
      ty = o.y;
      tz = o.z;
      tl = 1;
    }
    this.tan.push(tx / tl, ty / tl, tz / tl, tw >= 0 ? 1 : -1);
    this.uv0.push(uv[0], uv[1]);
    if (a.label) {
      const [u0, v0, u1, v1] = a.label.rect;
      const su = (uv[0] - a.label.origin[0]) / a.label.size[0];
      const sv = (uv[1] - a.label.origin[1]) / a.label.size[1];
      this.uv1.push(u0 + (u1 - u0) * Math.max(0, Math.min(1, su)), v0 + (v1 - v0) * Math.max(0, Math.min(1, 1 - sv)));
    } else this.uv1.push(0, 0);
    this.misc.push(a.mat, Math.round(255 * Math.max(0, Math.min(1, a.ao ?? 1))), (a.flags ?? 0) | (a.label ? FLAG_LABEL : 0), a.label ? (a.ink ?? 0) : (this.partSeed >>> 16) & 255);
    this.ctl.push(a.ctl ?? 0, a.sub ?? 0);
    this.grp.push(this.currentGroup);
    return i;
  }

  tri(a: number, b: number, c: number): void {
    this.idx.push(a, b, c);
  }
  /** Quad a-b-c-d counter-clockwise seen from the front. */
  quad(a: number, b: number, c: number, d: number): void {
    this.idx.push(a, b, c, a, c, d);
  }

  /** Close the current index and vertex ranges under `name` (a LOD). */
  mark(name: string): void {
    this.ranges[name] = { start: this.rangeStart, count: this.idx.length - this.rangeStart };
    this.vertexRanges[name] = { start: this.vertexStart, count: this.vertexCount - this.vertexStart };
    this.rangeStart = this.idx.length;
    this.vertexStart = this.vertexCount;
  }

  /**
   * Flat grid over a planar quad: corner(0, 0) .. corner(1, 1) bilinear, subdivided so no cell edge exceeds
   * `maxEdge`. uv0 = metric coordinates along the two edges from `uvOrigin`.
   */
  private grid(at: (s: number, t: number) => Vec3, lu: number, lv: number, n: Vec3, t: Vec3, a: Attr, uvOrigin: [number, number]): void {
    const nu = Math.max(1, Math.min(64, Math.ceil(lu / this.maxEdge)));
    const nv = Math.max(1, Math.min(64, Math.ceil(lv / this.maxEdge)));
    const base = this.vertexCount;
    for (let j = 0; j <= nv; j++) {
      for (let i = 0; i <= nu; i++) this.vertex(at(i / nu, j / nv), n, t, [uvOrigin[0] + (lu * i) / nu, uvOrigin[1] + (lv * j) / nv], a);
    }
    const row = nu + 1;
    for (let j = 0; j < nv; j++) {
      for (let i = 0; i < nu; i++) {
        const k = base + j * row + i;
        this.quad(k, k + 1, k + row + 1, k + row);
      }
    }
  }

  // ----------------------------------------------------------------------------------------- primitives

  /**
   * Parametric surface patch: `at(s, t)` for s, t in [0, 1] on an (ns x nt) grid. Normals by central
   * differences (orientation: ds x dt points to the front unless `flip`), tangents along s, uv0 = accumulated
   * arc length (metres) along s and t, scaled by `uvScale`.
   */
  patch(at: (s: number, t: number) => Vec3, ns: number, nt: number, a: Attr, opts: { flip?: boolean; uvOffset?: [number, number]; aoAt?: (s: number, t: number) => number; normalAt?: (s: number, t: number) => Vec3 } = {}): void {
    this.part();
    const h = 1e-4;
    const base = this.vertexCount;
    const flip = opts.flip ? -1 : 1;
    // Arc lengths for uv0 along the middle lines.
    const su: number[] = [0];
    for (let i = 1; i <= ns; i++) su.push(su[i - 1]! + v3.dist(at((i - 1) / ns, 0.5), at(i / ns, 0.5)));
    const tv: number[] = [0];
    for (let j = 1; j <= nt; j++) tv.push(tv[j - 1]! + v3.dist(at(0.5, (j - 1) / nt), at(0.5, j / nt)));
    const off = opts.uvOffset ?? [0, 0];
    for (let j = 0; j <= nt; j++) {
      for (let i = 0; i <= ns; i++) {
        const s = i / ns;
        const t = j / nt;
        const p = at(s, t);
        const ds = v3.sub(at(Math.min(1, s + h), t), at(Math.max(0, s - h), t));
        const dt = v3.sub(at(s, Math.min(1, t + h)), at(s, Math.max(0, t - h)));
        let n = opts.normalAt ? opts.normalAt(s, t) : v3.scale(v3.cross(ds, dt), flip);
        if (v3.len(n) < 1e-12) n = v3.scale(v3.cross(ds, dt), flip);
        const ao = opts.aoAt ? opts.aoAt(s, t) * (a.ao ?? 1) : a.ao;
        this.vertex(p, n, ds, [su[i]! + off[0], tv[j]! + off[1]], { ...a, ao }, flip);
      }
    }
    const row = ns + 1;
    for (let j = 0; j < nt; j++) {
      for (let i = 0; i < ns; i++) {
        const a0 = base + j * row + i;
        if (flip > 0) this.quad(a0, a0 + 1, a0 + row + 1, a0 + row);
        else this.quad(a0, a0 + row, a0 + row + 1, a0 + 1);
      }
    }
  }

  /**
   * Surface from an explicit (ni + 1) x (nj + 1) grid of points: `at(i, j)` gives a vertex's position `p`, its
   * surface coordinates `uv` and optionally `base`, the point of the smooth surface under a displaced one.
   * Normals and tangents are central differences of the base grid, so relief that the shader adds per
   * pixel (a quilt's pillows) is not counted twice. The front is d/di x d/dj unless `flip`.
   */
  surface(ni: number, nj: number, at: (i: number, j: number) => { p: Vec3; uv: [number, number]; base?: Vec3 }, a: Attr, opts: { flip?: boolean } = {}): void {
    this.part();
    const flip = opts.flip ? -1 : 1;
    const pts: { p: Vec3; uv: [number, number]; base?: Vec3 }[] = [];
    for (let j = 0; j <= nj; j++) for (let i = 0; i <= ni; i++) pts.push(at(i, j));
    const row = ni + 1;
    const basePoint = (i: number, j: number): Vec3 => {
      const q = pts[j * row + i]!;
      return q.base ?? q.p;
    };
    const first = this.vertexCount;
    for (let j = 0; j <= nj; j++) {
      for (let i = 0; i <= ni; i++) {
        const di = v3.sub(basePoint(Math.min(ni, i + 1), j), basePoint(Math.max(0, i - 1), j));
        const dj = v3.sub(basePoint(i, Math.min(nj, j + 1)), basePoint(i, Math.max(0, j - 1)));
        const q = pts[j * row + i]!;
        this.vertex(q.p, v3.scale(v3.cross(di, dj), flip), di, q.uv, a, flip);
      }
    }
    for (let j = 0; j < nj; j++) {
      for (let i = 0; i < ni; i++) {
        const k = first + j * row + i;
        if (flip > 0) this.quad(k, k + 1, k + row + 1, k + row);
        else this.quad(k, k + row, k + row + 1, k + 1);
      }
    }
  }

  /** Flat quad from four corners (counter-clockwise from the front, a parallelogram), uv0 in metres from the first corner. */
  flatQuad(p0: Vec3, p1: Vec3, p2: Vec3, p3: Vec3, a: Attr, uvOrigin: [number, number] = [0, 0]): void {
    this.part();
    const ex = v3.sub(p1, p0);
    const ey = v3.sub(p3, p0);
    const n = v3.cross(ex, ey);
    const at = (s: number, t: number): Vec3 => v3.lerp(v3.lerp(p0, p1, s), v3.lerp(p3, p2, s), t);
    this.grid(at, v3.len(ex), v3.len(ey), n, ex, a, uvOrigin);
  }

  /**
   * Box in a frame (centre f.o, half sizes along x, y, n) with chamfered edges of width `bevel`.
   * Faces are flat-shaded (subdivided down to `maxEdge`); chamfers carry the averaged normal so edges catch
   * highlights, and FLAG_EDGE so that they wear.
   */
  box(f: Frame, hx: number, hy: number, hz: number, bevel: number, a: Attr, opts: { skipBack?: boolean; frontAttr?: Attr } = {}): void {
    this.part();
    const b = Math.max(0, Math.min(bevel, hx * 0.49, hy * 0.49, hz * 0.49));
    const edgeAttr: Attr = { ...a, flags: (a.flags ?? 0) | FLAG_EDGE };
    const dirs: [Vec3, Vec3, Vec3, number, number, number][] = [
      // normal, u axis, v axis, half extent along normal, half u, half v
      [f.n, f.x, f.y, hz, hx, hy],
      [v3.neg(f.n), v3.neg(f.x), f.y, hz, hx, hy],
      [f.x, v3.neg(f.n), f.y, hx, hz, hy],
      [v3.neg(f.x), f.n, f.y, hx, hz, hy],
      [f.y, f.x, v3.neg(f.n), hy, hx, hz],
      [v3.neg(f.y), f.x, f.n, hy, hx, hz],
    ];
    dirs.forEach(([n, u, v, hn, hu, hv], k) => {
      if (k === 1 && opts.skipBack) return;
      const c = v3.add(f.o, v3.scale(n, hn));
      const at = (su: number, sv: number): Vec3 => v3.add(c, v3.add(v3.scale(u, su), v3.scale(v, sv)));
      const eu = hu - b;
      const ev = hv - b;
      const attr = k === 0 && opts.frontAttr ? opts.frontAttr : a;
      if (attr.label) {
        // A labelled face (lamp lens legend) keeps its four corners: the atlas mapping is per vertex.
        const i0 = this.vertex(at(-eu, -ev), n, u, [-eu, -ev], attr);
        const i1 = this.vertex(at(eu, -ev), n, u, [eu, -ev], attr);
        const i2 = this.vertex(at(eu, ev), n, u, [eu, ev], attr);
        const i3 = this.vertex(at(-eu, ev), n, u, [-eu, ev], attr);
        this.quad(i0, i1, i2, i3);
      } else this.grid((s, t) => at(-eu + 2 * eu * s, -ev + 2 * ev * t), 2 * eu, 2 * ev, n, u, attr, [-eu, -ev]);
    });
    if (b <= 0) return;
    // Chamfer strips along the 12 edges and triangles at the 8 corners.
    const corner = (sx: number, sy: number, sz: number, inset: [number, number, number]): Vec3 =>
      local(f, sx * (hx - inset[0]), sy * (hy - inset[1]), sz * (hz - inset[2]));
    const signs = [-1, 1];
    // Edges parallel to x (vary y, z signs), to y and to n.
    for (const sy of signs) {
      for (const sz of signs) {
        const nrm = v3.normalize(localDir(f, 0, sy, sz));
        const p0 = corner(-1, sy, sz, [b, 0, b]);
        const p1 = corner(1, sy, sz, [b, 0, b]);
        const p2 = corner(1, sy, sz, [b, b, 0]);
        const p3 = corner(-1, sy, sz, [b, b, 0]);
        this.strip(p0, p1, p2, p3, nrm, f.x, edgeAttr);
      }
    }
    for (const sx of signs) {
      for (const sz of signs) {
        const nrm = v3.normalize(localDir(f, sx, 0, sz));
        const p0 = corner(sx, -1, sz, [0, b, b]);
        const p1 = corner(sx, 1, sz, [0, b, b]);
        const p2 = corner(sx, 1, sz, [b, b, 0]);
        const p3 = corner(sx, -1, sz, [b, b, 0]);
        this.strip(p0, p1, p2, p3, nrm, f.y, edgeAttr);
      }
    }
    for (const sx of signs) {
      for (const sy of signs) {
        const nrm = v3.normalize(localDir(f, sx, sy, 0));
        const p0 = corner(sx, sy, -1, [0, b, b]);
        const p1 = corner(sx, sy, 1, [0, b, b]);
        const p2 = corner(sx, sy, 1, [b, 0, b]);
        const p3 = corner(sx, sy, -1, [b, 0, b]);
        this.strip(p0, p1, p2, p3, nrm, f.n, edgeAttr);
      }
    }
    for (const sx of signs) {
      for (const sy of signs) {
        for (const sz of signs) {
          const nrm = v3.normalize(localDir(f, sx, sy, sz));
          const pa = corner(sx, sy, sz, [0, b, b]);
          const pb = corner(sx, sy, sz, [b, 0, b]);
          const pc = corner(sx, sy, sz, [b, b, 0]);
          this.triFacing(pa, pb, pc, nrm, edgeAttr);
        }
      }
    }
  }

  /** Quad strip p0..p3 with one normal, wound to face `n`. */
  strip(p0: Vec3, p1: Vec3, p2: Vec3, p3: Vec3, n: Vec3, t: Vec3, a: Attr): void {
    const face = v3.cross(v3.sub(p1, p0), v3.sub(p3, p0));
    const edge = ((a.flags ?? 0) & FLAG_EDGE) !== 0;
    const i0 = this.vertex(p0, n, t, [0, 0], a);
    const i1 = this.vertex(p1, n, t, [v3.dist(p0, p1), 0], a);
    const i2 = this.vertex(p2, n, t, [v3.dist(p0, p1), edge ? EDGE_SPAN : v3.dist(p1, p2)], a);
    const i3 = this.vertex(p3, n, t, [0, edge ? EDGE_SPAN : v3.dist(p0, p3)], a);
    if (v3.dot(face, n) >= 0) this.quad(i0, i1, i2, i3);
    else this.quad(i0, i3, i2, i1);
  }

  triFacing(pa: Vec3, pb: Vec3, pc: Vec3, n: Vec3, a: Attr): void {
    const face = v3.cross(v3.sub(pb, pa), v3.sub(pc, pa));
    const t = v3.normalize(v3.sub(pb, pa));
    // A chamfered corner: the middle of the chamfer everywhere (corners wear first).
    const mid = ((a.flags ?? 0) & FLAG_EDGE) !== 0 ? EDGE_SPAN / 2 : null;
    const ia = this.vertex(pa, n, t, [0, mid ?? 0], a);
    const ib = this.vertex(pb, n, t, [v3.dist(pa, pb), mid ?? 0], a);
    const ic = this.vertex(pc, n, t, [0, mid ?? v3.dist(pa, pc)], a);
    if (v3.dot(face, n) >= 0) this.tri(ia, ib, ic);
    else this.tri(ia, ic, ib);
  }

  /**
   * Prism from a closed 2-D outline (counter-clockwise in the frame's x/y) extruded from c = 0 to c = depth
   * along +n, with an optional bevel on the front edge. `hole` (same count, also counter-clockwise) makes a
   * ring: front face between outline and hole, inner wall along the hole. Caps: 'front' / 'back' / both.
   */
  extrude(f: Frame, outline: [number, number][], depth: number, a: Attr, opts: { hole?: [number, number][]; bevel?: number; caps?: 'front' | 'back' | 'both' | 'none'; frontAttr?: Attr; backDepth?: number } = {}): void {
    this.part();
    const n = outline.length;
    const bevel = opts.bevel ?? 0;
    const back = opts.backDepth ?? 0;
    const caps = opts.caps ?? 'front';
    const centroid = outline.reduce<[number, number]>((s, p) => [s[0] + p[0] / n, s[1] + p[1] / n], [0, 0]);
    // Outward 2-D normals of the outline (per vertex, averaged).
    const outN = (loop: [number, number][], i: number, sign: number): [number, number] => {
      const p = loop[(i - 1 + loop.length) % loop.length]!;
      const q = loop[(i + 1) % loop.length]!;
      const dx = q[0] - p[0];
      const dy = q[1] - p[1];
      const l = Math.hypot(dx, dy) || 1;
      return [(sign * dy) / l, (sign * -dx) / l];
    };
    const wall = (loop: [number, number][], sign: number, inset: number): void => {
      // sign +1: outer wall (normals outward), -1: inner wall of a hole (normals toward the centre).
      const base = this.vertexCount;
      let s = 0;
      for (let i = 0; i <= loop.length; i++) {
        const k = i % loop.length;
        const [x, y] = loop[k]!;
        if (i > 0) s += Math.hypot(x - loop[(i - 1) % loop.length]![0], y - loop[(i - 1) % loop.length]![1]);
        const [nx, ny] = outN(loop, k, sign);
        const nn = localDir(f, nx, ny, 0);
        const tt = localDir(f, -ny * sign, nx * sign, 0);
        this.vertex(local(f, x, y, back), nn, tt, [s, 0], a);
        this.vertex(local(f, x, y, depth - inset), nn, tt, [s, depth - back - inset], a);
      }
      for (let i = 0; i < loop.length; i++) {
        const a0 = base + i * 2;
        if (sign > 0) this.quad(a0, a0 + 2, a0 + 3, a0 + 1);
        else this.quad(a0, a0 + 1, a0 + 3, a0 + 2);
      }
    };
    wall(outline, 1, bevel);
    if (opts.hole) wall(opts.hole, -1, bevel);
    const front = opts.frontAttr ?? a;
    if (bevel > 0) {
      // Bevel ring: from the wall top (inset) to the front face, moved inward by `bevel`.
      const bevelAttr: Attr = { ...front, flags: (front.flags ?? 0) | FLAG_EDGE };
      const ring = (loop: [number, number][], sign: number): void => {
        const base = this.vertexCount;
        let s = 0;
        for (let i = 0; i <= loop.length; i++) {
          const k = i % loop.length;
          const [x, y] = loop[k]!;
          if (i > 0) s += Math.hypot(x - loop[(i - 1) % loop.length]![0], y - loop[(i - 1) % loop.length]![1]);
          const [nx, ny] = outN(loop, k, sign);
          const nn = v3.normalize(localDir(f, nx, ny, 1));
          const tt = localDir(f, -ny, nx, 0);
          this.vertex(local(f, x, y, depth - bevel), nn, tt, [s, 0], bevelAttr);
          this.vertex(local(f, x - nx * bevel, y - ny * bevel, depth), nn, tt, [s, EDGE_SPAN], bevelAttr);
        }
        for (let i = 0; i < loop.length; i++) {
          const a0 = base + i * 2;
          if (sign > 0) this.quad(a0, a0 + 2, a0 + 3, a0 + 1);
          else this.quad(a0, a0 + 1, a0 + 3, a0 + 2);
        }
      };
      ring(outline, 1);
      if (opts.hole) ring(opts.hole, -1);
    }
    const shrink = (loop: [number, number][], sign: number): [number, number][] =>
      bevel > 0 ? loop.map((p, i) => { const [nx, ny] = outN(loop, i, sign); return [p[0] - nx * bevel, p[1] - ny * bevel]; }) : loop;
    const capAt = (c: number, nrm: Vec3, facing: number, attr: Attr, loopA: [number, number][], loopB?: [number, number][]): void => {
      const base = this.vertexCount;
      if (loopB) {
        for (let i = 0; i < n; i++) {
          this.vertex(local(f, loopA[i]![0], loopA[i]![1], c), nrm, f.x, [loopA[i]![0], loopA[i]![1]], attr);
          this.vertex(local(f, loopB[i]![0], loopB[i]![1], c), nrm, f.x, [loopB[i]![0], loopB[i]![1]], attr);
        }
        for (let i = 0; i < n; i++) {
          const a0 = base + i * 2;
          const b0 = base + ((i + 1) % n) * 2;
          if (facing > 0) this.quad(a0, b0, b0 + 1, a0 + 1);
          else this.quad(a0, a0 + 1, b0 + 1, b0);
        }
      } else {
        const ci = this.vertex(local(f, centroid[0], centroid[1], c), nrm, f.x, [centroid[0], centroid[1]], attr);
        for (let i = 0; i < n; i++) this.vertex(local(f, loopA[i]![0], loopA[i]![1], c), nrm, f.x, [loopA[i]![0], loopA[i]![1]], attr);
        for (let i = 0; i < n; i++) {
          const p = base + 1 + i;
          const q = base + 1 + ((i + 1) % n);
          if (facing > 0) this.tri(ci, p, q);
          else this.tri(ci, q, p);
        }
      }
    };
    const outer = shrink(outline, 1);
    const inner = opts.hole ? shrink(opts.hole, -1) : undefined;
    if (caps === 'front' || caps === 'both') capAt(depth, f.n, 1, front, outer, inner);
    if (caps === 'back' || caps === 'both') capAt(back, v3.neg(f.n), -1, a, outline, opts.hole);
  }

  /** Cylinder (or cone frustum with radius1) from base along axis. Caps optional. */
  cylinder(base: Vec3, axis: Vec3, radius: number, length: number, sides: number, a: Attr, opts: { radius1?: number; caps?: 'both' | 'top' | 'bottom' | 'none'; ref?: Vec3; arc?: [number, number] } = {}): void {
    this.part();
    const ax = v3.normalize(axis);
    const ref = v3.normalize(v3.reject(opts.ref ?? v3.anyOrthogonal(ax), ax));
    const bi = v3.cross(ax, ref);
    const r1 = opts.radius1 ?? radius;
    const [a0, a1] = opts.arc ?? [0, 2 * Math.PI];
    const full = a1 - a0 >= 2 * Math.PI - 1e-9;
    const slopeN = (radius - r1) / length;
    const start = this.vertexCount;
    for (let i = 0; i <= sides; i++) {
      const ang = a0 + ((a1 - a0) * i) / sides;
      const d = v3.add(v3.scale(ref, Math.cos(ang)), v3.scale(bi, Math.sin(ang)));
      const n = v3.normalize(v3.add(d, v3.scale(ax, slopeN)));
      const t = v3.cross(ax, d);
      const s = ang * radius;
      this.vertex(v3.add(base, v3.scale(d, radius)), n, t, [s, 0], a);
      this.vertex(v3.add(v3.add(base, v3.scale(ax, length)), v3.scale(d, r1)), n, t, [s, length], a);
    }
    for (let i = 0; i < sides; i++) {
      const k = start + i * 2;
      this.quad(k, k + 2, k + 3, k + 1);
    }
    const cap = (c: Vec3, r: number, n: Vec3): void => {
      const ci = this.vertex(c, n, ref, [0, 0], a);
      const first = this.vertexCount;
      for (let i = 0; i <= sides; i++) {
        const ang = a0 + ((a1 - a0) * i) / sides;
        const d = v3.add(v3.scale(ref, Math.cos(ang)), v3.scale(bi, Math.sin(ang)));
        this.vertex(v3.add(c, v3.scale(d, r)), n, ref, [Math.cos(ang) * r, Math.sin(ang) * r], a);
      }
      for (let i = 0; i < sides; i++) {
        if (v3.dot(n, ax) > 0) this.tri(ci, first + i, first + i + 1);
        else this.tri(ci, first + i + 1, first + i);
      }
    };
    const caps = opts.caps ?? 'both';
    if (full && (caps === 'both' || caps === 'bottom')) cap(base, radius, v3.neg(ax));
    if (full && (caps === 'both' || caps === 'top')) cap(v3.add(base, v3.scale(ax, length)), r1, ax);
  }

  /**
   * Surface of revolution of a profile [radius, height] about `axis` through `base` (profile ordered so that
   * the outward side is to the right of the direction of travel when radius is horizontal and height up).
   */
  lathe(base: Vec3, axis: Vec3, profile: [number, number][], sides: number, a: Attr, opts: { ref?: Vec3; arc?: [number, number]; flip?: boolean } = {}): void {
    this.part();
    const ax = v3.normalize(axis);
    const ref = v3.normalize(v3.reject(opts.ref ?? v3.anyOrthogonal(ax), ax));
    const bi = v3.cross(ax, ref);
    const [a0, a1] = opts.arc ?? [0, 2 * Math.PI];
    const at = (s: number, t: number): Vec3 => {
      const ang = a0 + (a1 - a0) * s;
      const f = t * (profile.length - 1);
      const i = Math.min(profile.length - 2, Math.floor(f));
      const w = f - i;
      const r = profile[i]![0] * (1 - w) + profile[i + 1]![0] * w;
      const h = profile[i]![1] * (1 - w) + profile[i + 1]![1] * w;
      return v3.add(v3.add(base, v3.scale(ax, h)), v3.scale(v3.add(v3.scale(ref, Math.cos(ang)), v3.scale(bi, Math.sin(ang))), r));
    };
    // One grid row per profile point keeps creases where the profile has corners.
    const base0 = this.vertexCount;
    const rows = profile.length;
    for (let j = 0; j < rows; j++) {
      // Normal from the profile tangent (averaged at interior points).
      const p = profile[Math.max(0, j - 1)]!;
      const q = profile[Math.min(rows - 1, j + 1)]!;
      const dr = q[0] - p[0];
      const dh = q[1] - p[1];
      for (let i = 0; i <= sides; i++) {
        const s = i / sides;
        const ang = a0 + (a1 - a0) * s;
        const d = v3.add(v3.scale(ref, Math.cos(ang)), v3.scale(bi, Math.sin(ang)));
        const pos = at(s, j / (rows - 1));
        // Outward normal in the (d, ax) plane: rotate the profile tangent (dr, dh) by -90 deg -> (dh, -dr).
        let n = v3.add(v3.scale(d, dh), v3.scale(ax, -dr));
        if (opts.flip) n = v3.neg(n);
        const t = v3.cross(ax, d);
        this.vertex(pos, n, t, [ang * Math.max(profile[j]![0], 0.01), profile[j]![1]], a);
      }
    }
    const row = sides + 1;
    for (let j = 0; j + 1 < rows; j++) {
      for (let i = 0; i < sides; i++) {
        const k = base0 + j * row + i;
        if (opts.flip) this.quad(k, k + row, k + row + 1, k + 1);
        else this.quad(k, k + 1, k + row + 1, k + row);
      }
    }
  }

  /**
   * Tube swept along a polyline with parallel-transport frames (cables, ducts, handrails). `radiusAt(s)`
   * (s = 0..1 along the path) gives the radius; uv0.x runs along the path in metres.
   */
  tube(path: Vec3[], radius: number | ((s: number) => number), sides: number, a: Attr, opts: { caps?: boolean } = {}): void {
    if (path.length < 2) return;
    this.part();
    const rad = typeof radius === 'number' ? (): number => radius : radius;
    const tangents = path.map((p, i) => v3.normalize(v3.sub(path[Math.min(path.length - 1, i + 1)]!, path[Math.max(0, i - 1)]!)));
    let normal = v3.normalize(v3.reject(v3.anyOrthogonal(tangents[0]!), tangents[0]!));
    const lengths = [0];
    for (let i = 1; i < path.length; i++) lengths.push(lengths[i - 1]! + v3.dist(path[i - 1]!, path[i]!));
    const total = lengths[lengths.length - 1]!;
    const base0 = this.vertexCount;
    for (let i = 0; i < path.length; i++) {
      const t = tangents[i]!;
      if (i > 0) {
        normal = v3.normalize(v3.reject(normal, t));
      }
      const bin = v3.cross(t, normal);
      const r = rad(lengths[i]! / Math.max(total, 1e-9));
      for (let k = 0; k <= sides; k++) {
        const ang = (k / sides) * 2 * Math.PI;
        const d = v3.add(v3.scale(normal, Math.cos(ang)), v3.scale(bin, Math.sin(ang)));
        this.vertex(v3.add(path[i]!, v3.scale(d, r)), d, t, [lengths[i]!, (ang / (2 * Math.PI)) * 2 * Math.PI * r], a);
      }
    }
    const row = sides + 1;
    for (let i = 0; i + 1 < path.length; i++) {
      for (let k = 0; k < sides; k++) {
        const q = base0 + i * row + k;
        this.quad(q, q + row, q + row + 1, q + 1);
      }
    }
    if (opts.caps) {
      for (const end of [0, path.length - 1]) {
        const t = end === 0 ? v3.neg(tangents[0]!) : tangents[end]!;
        const c = this.vertex(path[end]!, t, normal, [0, 0], a);
        const ring = base0 + end * row;
        for (let k = 0; k < sides; k++) {
          if (end === 0) this.tri(c, ring + k + 1, ring + k);
          else this.tri(c, ring + k, ring + k + 1);
        }
      }
    }
  }

  /**
   * Disc or annulus in a frame (z = c), facing +n (or -n with flip): concentric rings no wider than `maxEdge`
   * (a wide disc as one ring of quads to its centre is a fan, and whatever is baked per vertex then runs along
   * its spokes). The rim has `sides` vertices; each ring inward has as many as keep its cells about as long
   * round the ring as the ring is wide (never fewer than six), and neighbouring rings are stitched vertex by
   * vertex in the order of their angles: the cells stay near square down to the centre, so a disc lit per
   * vertex shows no star of spokes (round 6: the docking hatch's face seen from the couch).
   */
  disc(f: Frame, rOuter: number, rInner: number, sides: number, a: Attr, opts: { c?: number; flip?: boolean } = {}): void {
    this.part();
    const c = opts.c ?? 0;
    const n = opts.flip ? v3.neg(f.n) : f.n;
    const rings = Math.max(1, Math.min(32, Math.ceil((rOuter - rInner) / this.maxEdge)));
    const width = (rOuter - rInner) / rings;
    const ring: { start: number; count: number }[] = [];
    for (let k = 0; k <= rings; k++) {
      const r = rOuter + ((rInner - rOuter) * k) / rings;
      const count = r < 1e-9 ? 1 : k === 0 ? sides : Math.max(6, Math.min(sides, Math.round((2 * Math.PI * r) / width)));
      ring.push({ start: this.vertexCount, count });
      for (let i = 0; i < count; i++) {
        const ang = (i / count) * 2 * Math.PI;
        const cx = Math.cos(ang);
        const sy = Math.sin(ang);
        this.vertex(local(f, cx * r, sy * r, c), n, f.x, [cx * r, sy * r], a);
      }
    }
    const tri = (p: number, q: number, s: number): void => {
      if (p === q || q === s || p === s) return;
      if (opts.flip) this.tri(p, s, q);
      else this.tri(p, q, s);
    };
    for (let k = 0; k < rings; k++) {
      const A = ring[k]!;
      const B = ring[k + 1]!;
      let i = 0;
      let j = 0;
      while (i < A.count || j < B.count) {
        const a0 = A.start + (i % A.count);
        const a1 = A.start + ((i + 1) % A.count);
        const b0 = B.start + (j % B.count);
        const b1 = B.start + ((j + 1) % B.count);
        if (j >= B.count || (i < A.count && (i + 1) / A.count <= (j + 1) / B.count)) {
          tri(a0, a1, b0);
          i++;
        } else {
          tri(a0, b1, b0);
          j++;
        }
      }
    }
  }

  build(): BuiltMesh {
    const count = this.vertexCount;
    const buf = new ArrayBuffer(count * VERTEX_STRIDE);
    const f32 = new Float32Array(buf);
    const i16 = new Int16Array(buf);
    const u16 = new Uint16Array(buf);
    const u8 = new Uint8Array(buf);
    const min = { x: Infinity, y: Infinity, z: Infinity };
    const max = { x: -Infinity, y: -Infinity, z: -Infinity };
    for (let i = 0; i < count; i++) {
      const o = i * VERTEX_STRIDE;
      const x = this.pos[i * 3]!;
      const y = this.pos[i * 3 + 1]!;
      const z = this.pos[i * 3 + 2]!;
      f32[o / 4] = x;
      f32[o / 4 + 1] = y;
      f32[o / 4 + 2] = z;
      if (x < min.x) min.x = x;
      if (y < min.y) min.y = y;
      if (z < min.z) min.z = z;
      if (x > max.x) max.x = x;
      if (y > max.y) max.y = y;
      if (z > max.z) max.z = z;
      i16[(o + 12) / 2] = clamp16(this.nrm[i * 3]!);
      i16[(o + 12) / 2 + 1] = clamp16(this.nrm[i * 3 + 1]!);
      i16[(o + 12) / 2 + 2] = clamp16(this.nrm[i * 3 + 2]!);
      i16[(o + 12) / 2 + 3] = 0;
      i16[(o + 20) / 2] = clamp16(this.tan[i * 4]!);
      i16[(o + 20) / 2 + 1] = clamp16(this.tan[i * 4 + 1]!);
      i16[(o + 20) / 2 + 2] = clamp16(this.tan[i * 4 + 2]!);
      i16[(o + 20) / 2 + 3] = clamp16(this.tan[i * 4 + 3]!);
      f32[(o + 28) / 4] = this.uv0[i * 2]!;
      f32[(o + 28) / 4 + 1] = this.uv0[i * 2 + 1]!;
      u16[(o + 36) / 2] = Math.round(Math.max(0, Math.min(1, this.uv1[i * 2]!)) * 65535);
      u16[(o + 36) / 2 + 1] = Math.round(Math.max(0, Math.min(1, this.uv1[i * 2 + 1]!)) * 65535);
      u8[o + 40] = this.misc[i * 4]!;
      u8[o + 41] = this.misc[i * 4 + 1]!;
      u8[o + 42] = this.misc[i * 4 + 2]!;
      u8[o + 43] = this.misc[i * 4 + 3]!;
      u16[(o + 44) / 2] = this.ctl[i * 2]!;
      u16[(o + 44) / 2 + 1] = this.ctl[i * 2 + 1]!;
    }
    // Every vertex that carries no label keeps, in the label-atlas slot it does not use, the length of the
    // longest triangle edge that ends at it (EDGE_REACH_MAX at most, rounded up): how far a pixel of any of its
    // triangles can lie from it. (The interior's vertex stage turns distances taken at vertices into bounds
    // that hold for the pixels between them: shaders.ts cabinSunReach.)
    const reach = new Float32Array(count);
    for (let k = 0; k + 2 < this.idx.length; k += 3) {
      for (let e = 0; e < 3; e++) {
        const a = this.idx[k + e]!;
        const b = this.idx[k + ((e + 1) % 3)]!;
        const len = Math.hypot(this.pos[a * 3]! - this.pos[b * 3]!, this.pos[a * 3 + 1]! - this.pos[b * 3 + 1]!, this.pos[a * 3 + 2]! - this.pos[b * 3 + 2]!);
        if (len > reach[a]!) reach[a] = len;
        if (len > reach[b]!) reach[b] = len;
      }
    }
    for (let i = 0; i < count; i++) {
      if ((this.misc[i * 4 + 2]! & FLAG_LABEL) !== 0) continue;
      u16[(i * VERTEX_STRIDE + 36) / 2] = Math.min(65535, Math.ceil((Math.min(reach[i]!, EDGE_REACH_MAX) / EDGE_REACH_MAX) * 65535));
    }
    if (this.rangeStart < this.idx.length) this.mark('rest');
    return { vertices: buf, vertexCount: count, indices: Uint32Array.from(this.idx), ranges: { ...this.ranges }, vertexRanges: { ...this.vertexRanges }, bounds: { min, max }, groupNames: [...this.groupNames], vertexGroup: Uint16Array.from(this.grp) };
  }
}
