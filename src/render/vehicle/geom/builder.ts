/**
 * Mesh builder for the procedural vehicle and pad models.
 *
 * Conventions (render contract): right-handed, counter-clockwise front faces, metres. UVs are emitted in
 * METRES along the tangent (u) and the bitangent (v = cross(N, T) * w); each material carries its own
 * tiles-per-metre `uvScale`, so one tileable texture set serves every part at a fixed texel density.
 * Decal materials use uvScale 1 and atlas coordinates.
 *
 * Vertex masks (rgba8): r = edge wear, g = baked AO, b = soot / scorch weight, a = frost weight.
 *
 * Every primitive is emitted inside a COMPONENT. A component declared `closed` is a watertight solid (each
 * edge shared by exactly two triangles of opposite direction once vertices are welded by position); the
 * unit tests check that claim per component, so open sheets (foil, blankets, decal-free liners) are
 * declared open and everything else must really be closed.
 */
import type { MeshData, PbrMaterialDef } from '@/core/contracts/render';
import type { Vec3Tuple } from '@/core/math';
import { materialDef, type MatId } from '../materials';

/** Affine transform, row-major 3 x 4: rotation (orthonormal, det +1) and translation. */
export type Xf = Float64Array;

export const xf = {
  identity: (): Xf => new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0]),
  translate: (x: number, y: number, z: number): Xf => new Float64Array([1, 0, 0, x, 0, 1, 0, y, 0, 0, 1, z]),
  /** Rotation about +Y; azimuth convention of the vehicle (from +Z toward +X). */
  rotY: (a: number): Xf => {
    const c = Math.cos(a);
    const s = Math.sin(a);
    return new Float64Array([c, 0, s, 0, 0, 1, 0, 0, -s, 0, c, 0]);
  },
  rotX: (a: number): Xf => {
    const c = Math.cos(a);
    const s = Math.sin(a);
    return new Float64Array([1, 0, 0, 0, 0, c, -s, 0, 0, s, c, 0]);
  },
  rotZ: (a: number): Xf => {
    const c = Math.cos(a);
    const s = Math.sin(a);
    return new Float64Array([c, -s, 0, 0, s, c, 0, 0, 0, 0, 1, 0]);
  },
  /** a after b: p -> a(b(p)). */
  mul: (a: Xf, b: Xf): Xf => {
    const o = new Float64Array(12);
    for (let r = 0; r < 3; r++) {
      const a0 = a[r * 4]!;
      const a1 = a[r * 4 + 1]!;
      const a2 = a[r * 4 + 2]!;
      o[r * 4] = a0 * b[0]! + a1 * b[4]! + a2 * b[8]!;
      o[r * 4 + 1] = a0 * b[1]! + a1 * b[5]! + a2 * b[9]!;
      o[r * 4 + 2] = a0 * b[2]! + a1 * b[6]! + a2 * b[10]!;
      o[r * 4 + 3] = a0 * b[3]! + a1 * b[7]! + a2 * b[11]! + a[r * 4 + 3]!;
    }
    return o;
  },
  chain: (...m: Xf[]): Xf => m.reduce((acc, x) => xf.mul(acc, x)),
  /** Frame with the given origin and axes (columns); axes must be orthonormal and right-handed. */
  fromAxes: (o: Vec3Tuple, x: Vec3Tuple, y: Vec3Tuple, z: Vec3Tuple): Xf => new Float64Array([x[0], y[0], z[0], o[0], x[1], y[1], z[1], o[1], x[2], y[2], z[2], o[2]]),
  /** Frame at `from` whose +Y axis points to `to`; +X is as close to `xHint` as possible. */
  along: (from: Vec3Tuple, to: Vec3Tuple, xHint: Vec3Tuple = [1, 0, 0]): Xf => {
    const y = norm3(sub3(to, from));
    let x = sub3(xHint, scale3(y, dot3(xHint, y)));
    if (dot3(x, x) < 1e-10) {
      const alt: Vec3Tuple = Math.abs(y[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
      x = sub3(alt, scale3(y, dot3(alt, y)));
    }
    x = norm3(x);
    return xf.fromAxes(from, x, y, cross3(x, y));
  },
  apply: (m: Xf, p: Vec3Tuple): Vec3Tuple => [
    m[0]! * p[0] + m[1]! * p[1] + m[2]! * p[2] + m[3]!,
    m[4]! * p[0] + m[5]! * p[1] + m[6]! * p[2] + m[7]!,
    m[8]! * p[0] + m[9]! * p[1] + m[10]! * p[2] + m[11]!,
  ],
  dir: (m: Xf, d: Vec3Tuple): Vec3Tuple => [m[0]! * d[0] + m[1]! * d[1] + m[2]! * d[2], m[4]! * d[0] + m[5]! * d[1] + m[6]! * d[2], m[8]! * d[0] + m[9]! * d[1] + m[10]! * d[2]],
};

export const sub3 = (a: Vec3Tuple, b: Vec3Tuple): Vec3Tuple => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const add3 = (a: Vec3Tuple, b: Vec3Tuple): Vec3Tuple => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const scale3 = (a: Vec3Tuple, s: number): Vec3Tuple => [a[0] * s, a[1] * s, a[2] * s];
export const dot3 = (a: Vec3Tuple, b: Vec3Tuple): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross3 = (a: Vec3Tuple, b: Vec3Tuple): Vec3Tuple => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const len3 = (a: Vec3Tuple): number => Math.hypot(a[0], a[1], a[2]);
export const norm3 = (a: Vec3Tuple): Vec3Tuple => {
  const l = Math.hypot(a[0], a[1], a[2]);
  return l > 0 ? [a[0] / l, a[1] / l, a[2] / l] : [1, 0, 0];
};
export const lerp3 = (a: Vec3Tuple, b: Vec3Tuple, t: number): Vec3Tuple => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
/** Point at azimuth `phi` (from +Z toward +X), radius r, height y. */
export const polar = (r: number, phi: number, y: number): Vec3Tuple => [r * Math.sin(phi), y, r * Math.cos(phi)];

/** Extra data kept beside the render mesh for the unit tests. */
export interface MeshMeta {
  /** Component index per triangle (same order as `indices`). */
  triComponent: Uint16Array;
  /** Per component: 1 = declared watertight. */
  closed: Uint8Array;
  /** Per component: free-form tag ('skin', 'bolt', ...). */
  tags: string[];
}

export interface BuiltMesh extends MeshData {
  meta: MeshMeta;
  /** Material ids in group order (index = MeshData.groups[].material). */
  materialIds: MatId[];
}

class F32 {
  a: Float32Array;
  n = 0;
  constructor(cap: number) {
    this.a = new Float32Array(cap);
  }
  ensure(extra: number): void {
    if (this.n + extra > this.a.length) {
      const b = new Float32Array(Math.max(this.a.length * 2, this.n + extra));
      b.set(this.a.subarray(0, this.n));
      this.a = b;
    }
  }
}

class U32 {
  a: Uint32Array;
  n = 0;
  constructor(cap: number) {
    this.a = new Uint32Array(cap);
  }
  push3(x: number, y: number, z: number): void {
    if (this.n + 3 > this.a.length) {
      const b = new Uint32Array(this.a.length * 2);
      b.set(this.a.subarray(0, this.n));
      this.a = b;
    }
    this.a[this.n++] = x;
    this.a[this.n++] = y;
    this.a[this.n++] = z;
  }
}

interface MatBucket {
  id: MatId;
  idx: U32;
  comp: number[];
}

export class MeshBuilder {
  private readonly p = new F32(3 * 4096);
  private readonly nrm = new F32(3 * 4096);
  private readonly tan = new F32(4 * 4096);
  private readonly uv = new F32(2 * 4096);
  private mk = new Uint8Array(4 * 4096);
  private count = 0;
  private readonly buckets: MatBucket[] = [];
  private readonly bucketOf = new Map<MatId, MatBucket>();
  private current: MatBucket | null = null;
  private readonly stack: Xf[] = [];
  private m: Xf | null = null;
  private readonly compClosed: number[] = [];
  private readonly compTags: string[] = [];
  private comp = -1;

  /** Current vertex mask values 0..1. */
  wear = 0;
  ao = 1;
  soot = 0;
  frost = 0;

  /** `lod`: 0 = full detail, 1 = medium, 2 = silhouette only. */
  constructor(readonly lod: number) {}

  /** Choose a value by LOD. */
  pick<T>(l0: T, l1: T, l2: T): T {
    return this.lod === 0 ? l0 : this.lod === 1 ? l1 : l2;
  }

  get vertexCount(): number {
    return this.count;
  }

  get triangleCount(): number {
    let n = 0;
    for (const b of this.buckets) n += b.idx.n / 3;
    return n;
  }

  // ------------------------------------------------------------------------------------------ state

  mat(id: MatId): this {
    let b = this.bucketOf.get(id);
    if (!b) {
      materialDef(id); // throws for an unknown id
      b = { id, idx: new U32(3 * 1024), comp: [] };
      this.bucketOf.set(id, b);
      this.buckets.push(b);
    }
    this.current = b;
    return this;
  }

  get material(): MatId {
    if (!this.current) throw new Error('MeshBuilder: no material selected');
    return this.current.id;
  }

  masks(wear: number, ao: number, soot: number, frost: number): this {
    this.wear = wear;
    this.ao = ao;
    this.soot = soot;
    this.frost = frost;
    return this;
  }

  /** Push a transform (composed with the current one) for everything emitted until `pop`. */
  push(t: Xf): this {
    this.stack.push(this.m ?? xf.identity());
    this.m = this.m ? xf.mul(this.m, t) : t;
    return this;
  }

  pop(): this {
    const prev = this.stack.pop();
    if (!prev) throw new Error('MeshBuilder: pop without push');
    this.m = prev;
    return this;
  }

  /** Run `fn` with transform `t` pushed. */
  at(t: Xf, fn: () => void): this {
    this.push(t);
    fn();
    return this.pop();
  }

  /** Start a component; `closed` declares a watertight solid. Returns its index. */
  begin(closed: boolean, tag = ''): number {
    this.compClosed.push(closed ? 1 : 0);
    this.compTags.push(tag);
    this.comp = this.compClosed.length - 1;
    return this.comp;
  }

  // --------------------------------------------------------------------------------------- emission

  /** Add a vertex in local coordinates (the current transform is applied). Returns its index. */
  v(px: number, py: number, pz: number, nx: number, ny: number, nz: number, tx: number, ty: number, tz: number, u: number, v: number, tw = 1): number {
    const i = this.count++;
    this.p.ensure(3);
    this.nrm.ensure(3);
    this.tan.ensure(4);
    this.uv.ensure(2);
    if (i * 4 + 4 > this.mk.length) {
      const b = new Uint8Array(this.mk.length * 2);
      b.set(this.mk);
      this.mk = b;
    }
    const m = this.m;
    const P = this.p.a;
    const N = this.nrm.a;
    const T = this.tan.a;
    if (m) {
      P[i * 3] = m[0]! * px + m[1]! * py + m[2]! * pz + m[3]!;
      P[i * 3 + 1] = m[4]! * px + m[5]! * py + m[6]! * pz + m[7]!;
      P[i * 3 + 2] = m[8]! * px + m[9]! * py + m[10]! * pz + m[11]!;
      N[i * 3] = m[0]! * nx + m[1]! * ny + m[2]! * nz;
      N[i * 3 + 1] = m[4]! * nx + m[5]! * ny + m[6]! * nz;
      N[i * 3 + 2] = m[8]! * nx + m[9]! * ny + m[10]! * nz;
      T[i * 4] = m[0]! * tx + m[1]! * ty + m[2]! * tz;
      T[i * 4 + 1] = m[4]! * tx + m[5]! * ty + m[6]! * tz;
      T[i * 4 + 2] = m[8]! * tx + m[9]! * ty + m[10]! * tz;
    } else {
      P[i * 3] = px;
      P[i * 3 + 1] = py;
      P[i * 3 + 2] = pz;
      N[i * 3] = nx;
      N[i * 3 + 1] = ny;
      N[i * 3 + 2] = nz;
      T[i * 4] = tx;
      T[i * 4 + 1] = ty;
      T[i * 4 + 2] = tz;
    }
    T[i * 4 + 3] = tw;
    this.p.n += 3;
    this.nrm.n += 3;
    this.tan.n += 4;
    this.uv.a[i * 2] = u;
    this.uv.a[i * 2 + 1] = v;
    this.uv.n += 2;
    const M = this.mk;
    M[i * 4] = Math.round(clamp01(this.wear) * 255);
    M[i * 4 + 1] = Math.round(clamp01(this.ao) * 255);
    M[i * 4 + 2] = Math.round(clamp01(this.soot) * 255);
    M[i * 4 + 3] = Math.round(clamp01(this.frost) * 255);
    return i;
  }

  /** Vertex from tuples. */
  vt(p: Vec3Tuple, n: Vec3Tuple, t: Vec3Tuple, u: number, v: number, tw = 1): number {
    return this.v(p[0], p[1], p[2], n[0], n[1], n[2], t[0], t[1], t[2], u, v, tw);
  }

  /** Override the masks of an emitted vertex. */
  setMask(i: number, wear: number, ao: number, soot: number, frost: number): void {
    const M = this.mk;
    M[i * 4] = Math.round(clamp01(wear) * 255);
    M[i * 4 + 1] = Math.round(clamp01(ao) * 255);
    M[i * 4 + 2] = Math.round(clamp01(soot) * 255);
    M[i * 4 + 3] = Math.round(clamp01(frost) * 255);
  }

  /**
   * Re-evaluate the masks of every vertex from index `from` on: `fn` gets the (transformed) position and the
   * vertex's mask values 0..1 and edits them in place. For weathering that is a function of where a vertex
   * is (soot of the base flow, frost on a tank), applied across everything a generator has emitted, so that
   * a strap, a door or a cable tray on a sooted skin is as sooted as the skin under it.
   */
  remask(from: number, fn: (p: Vec3Tuple, m: { wear: number; ao: number; soot: number; frost: number }) => void): void {
    const M = this.mk;
    const P = this.p.a;
    const m = { wear: 0, ao: 0, soot: 0, frost: 0 };
    for (let i = Math.max(0, from); i < this.count; i++) {
      m.wear = M[i * 4]! / 255;
      m.ao = M[i * 4 + 1]! / 255;
      m.soot = M[i * 4 + 2]! / 255;
      m.frost = M[i * 4 + 3]! / 255;
      fn([P[i * 3]!, P[i * 3 + 1]!, P[i * 3 + 2]!], m);
      this.setMask(i, m.wear, m.ao, m.soot, m.frost);
    }
  }

  tri(a: number, b: number, c: number): void {
    const cur = this.current;
    if (!cur) throw new Error('MeshBuilder: no material selected');
    if (this.comp < 0) throw new Error('MeshBuilder: triangle outside a component (call begin)');
    cur.idx.push3(a, b, c);
    cur.comp.push(this.comp);
  }

  /** Quad a-b-c-d (counter-clockwise seen from the front). */
  quad(a: number, b: number, c: number, d: number): void {
    this.tri(a, b, c);
    this.tri(a, c, d);
  }

  /** Position of an emitted vertex (already transformed). */
  position(i: number): Vec3Tuple {
    const P = this.p.a;
    return [P[i * 3]!, P[i * 3 + 1]!, P[i * 3 + 2]!];
  }

  // ------------------------------------------------------------------------------------------ build

  build(): BuiltMesh {
    const used = this.buckets.filter((b) => b.idx.n > 0);
    const total = used.reduce((s, b) => s + b.idx.n, 0);
    const indices = new Uint32Array(total);
    const triComponent = new Uint16Array(total / 3);
    const groups: MeshData['groups'] = [];
    let o = 0;
    used.forEach((b, material) => {
      indices.set(b.idx.a.subarray(0, b.idx.n), o);
      triComponent.set(b.comp, o / 3);
      groups.push({ material, start: o, count: b.idx.n });
      o += b.idx.n;
    });
    const positions = this.p.a.slice(0, this.count * 3);
    const min: Vec3Tuple = [Infinity, Infinity, Infinity];
    const max: Vec3Tuple = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < positions.length; i += 3) {
      for (let k = 0; k < 3; k++) {
        const x = positions[i + k]!;
        if (x < min[k]!) min[k] = x;
        if (x > max[k]!) max[k] = x;
      }
    }
    if (this.count === 0) {
      min.fill(0);
      max.fill(0);
    }
    return {
      positions,
      normals: this.nrm.a.slice(0, this.count * 3),
      tangents: this.tan.a.slice(0, this.count * 4),
      uvs: this.uv.a.slice(0, this.count * 2),
      masks: this.mk.slice(0, this.count * 4),
      indices,
      groups,
      bounds: { min, max },
      meta: { triComponent, closed: Uint8Array.from(this.compClosed), tags: this.compTags.slice() },
      materialIds: used.map((b) => b.id),
    };
  }
}

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);

/**
 * Combine the LOD meshes of one model: every LOD must index the same material list, so the union of the
 * material ids is built and each mesh's groups are re-pointed to it.
 */
export function unifyMaterials(lods: BuiltMesh[]): { lods: BuiltMesh[]; materialIds: MatId[]; materials: PbrMaterialDef[] } {
  const ids: MatId[] = [];
  for (const m of lods) for (const id of m.materialIds) if (!ids.includes(id)) ids.push(id);
  for (const m of lods) {
    m.groups = m.groups.map((g) => ({ ...g, material: ids.indexOf(m.materialIds[g.material]!) }));
    m.materialIds = ids;
  }
  return { lods, materialIds: ids, materials: ids.map(materialDef) };
}
