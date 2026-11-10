/**
 * A smooth scalar field sampled on a planet-fixed cubic lattice and interpolated trilinearly, with a
 * direct-mapped cache of node values. Used for slowly varying inputs that are expensive to evaluate at every
 * query (rock abundance from crater ejecta or land cover). The cache only memoises pure node values, so
 * results never depend on the query history. Nodes computed from incomplete data (tiles still loading) are
 * provisional: they are recomputed once the body's resident data changes, and every use of one flags the
 * current evaluation incomplete.
 */
export interface DataDependence {
  /** Changes whenever the body's resident data changes. */
  generation(): number;
  /** True when the most recent raw() call read data that was not resident. */
  lastRawIncomplete(): boolean;
  /** Called whenever a provisional node is used. */
  onIncompleteUse(): void;
}

export class LatticeField {
  private readonly inv: number;
  private readonly keys: Int32Array;
  private readonly vals: Float64Array;
  /** 0 = empty, 1 = final, 2 = provisional. */
  private readonly state: Uint8Array;
  private readonly gens: Float64Array;
  private readonly mask: number;

  /** `raw(x, y, z)` is evaluated at node positions projected to the sphere of radius R. */
  constructor(
    readonly spacing: number,
    readonly R: number,
    private readonly raw: (x: number, y: number, z: number) => number,
    private readonly dep: DataDependence | null,
    cacheBits = 13,
  ) {
    this.inv = 1 / spacing;
    const n = 1 << cacheBits;
    this.mask = n - 1;
    this.keys = new Int32Array(3 * n);
    this.vals = new Float64Array(n);
    this.state = new Uint8Array(n);
    this.gens = new Float64Array(n);
  }

  private node(ix: number, iy: number, iz: number): number {
    const slot = (Math.imul(ix, 73856093) ^ Math.imul(iy, 19349663) ^ Math.imul(iz, 83492791)) & this.mask;
    const k = 3 * slot;
    const st = this.state[slot]!;
    if (st !== 0 && this.keys[k] === ix && this.keys[k + 1] === iy && this.keys[k + 2] === iz) {
      if (st === 1) return this.vals[slot]!;
      if (this.gens[slot] === this.dep!.generation()) {
        this.dep!.onIncompleteUse();
        return this.vals[slot]!;
      }
    }
    const s = this.spacing;
    const x = ix * s;
    const y = iy * s;
    const z = iz * s;
    const f = this.R / Math.sqrt(x * x + y * y + z * z);
    const v = this.raw(x * f, y * f, z * f);
    this.keys[k] = ix;
    this.keys[k + 1] = iy;
    this.keys[k + 2] = iz;
    this.vals[slot] = v;
    if (this.dep && this.dep.lastRawIncomplete()) {
      this.state[slot] = 2;
      this.gens[slot] = this.dep.generation();
      this.dep.onIncompleteUse();
    } else this.state[slot] = 1;
    return v;
  }

  private mbx = 0x7fffffff;
  private mby = 0;
  private mbz = 0;
  private mbv = 0;

  /**
   * Upper bound of the field over the cube [p - spacing/2, p + spacing/2]^3: the maximum of the 27 nodes of
   * the 2 x 2 x 2 lattice cells nearest p (trilinear interpolation never exceeds its nodes).
   */
  blockMax(x: number, y: number, z: number): number {
    const bx = Math.floor(x * this.inv - 0.5) | 0;
    const by = Math.floor(y * this.inv - 0.5) | 0;
    const bz = Math.floor(z * this.inv - 0.5) | 0;
    const gen = this.dep ? this.dep.generation() : 0;
    if (bx === this.mbx && by === this.mby && bz === this.mbz && gen === this.mbg) return this.mbv;
    let m = -Infinity;
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) m = Math.max(m, this.node(bx + i, by + j, bz + k));
    this.mbx = bx;
    this.mby = by;
    this.mbz = bz;
    this.mbg = gen;
    this.mbv = m;
    return m;
  }
  private mbg = -1;

  /** Field value at a point (m, body-fixed). */
  at(x: number, y: number, z: number): number {
    const gx = x * this.inv;
    const gy = y * this.inv;
    const gz = z * this.inv;
    const fx = Math.floor(gx);
    const fy = Math.floor(gy);
    const fz = Math.floor(gz);
    const tx = gx - fx;
    const ty = gy - fy;
    const tz = gz - fz;
    const ix = fx | 0;
    const iy = fy | 0;
    const iz = fz | 0;
    const c000 = this.node(ix, iy, iz);
    const c100 = this.node(ix + 1, iy, iz);
    const c010 = this.node(ix, iy + 1, iz);
    const c110 = this.node(ix + 1, iy + 1, iz);
    const c001 = this.node(ix, iy, iz + 1);
    const c101 = this.node(ix + 1, iy, iz + 1);
    const c011 = this.node(ix, iy + 1, iz + 1);
    const c111 = this.node(ix + 1, iy + 1, iz + 1);
    const a = c000 + tx * (c100 - c000);
    const b = c010 + tx * (c110 - c010);
    const c = c001 + tx * (c101 - c001);
    const d = c011 + tx * (c111 - c011);
    const e = a + ty * (b - a);
    const f = c + ty * (d - c);
    return e + tz * (f - e);
  }
}
