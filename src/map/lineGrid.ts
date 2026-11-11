/**
 * Coarse occupancy grid of the drawn lines on screen, so labels, the hover tooltip and the node panel can be
 * placed off the trajectories instead of on top of them. Built once per draw list from the scene's projected
 * vertices: one pass over the drawn segments, clipped to the screen, visiting the cells along each at one step
 * per cell.
 *  - `cost(rect)`: each cell holds the largest weight of the lines through it (trajectories weigh more than
 *    reference orbits); a rectangle's cost is the sum over the cells it covers (the panel and the tooltip).
 *  - `length(rect)`: the drawn length of line inside a rectangle, exactly (each cell also lists the segments
 *    through it; the segments found are clipped to the rectangle), weighted per kind (labels: a label is placed
 *    off the lines, not merely off the cells they pass through).
 */
import type { LineKind, MapScene } from './scene';

/**
 * Weight of a line kind (0 = not an obstacle: the faint SOI, ghost and debris lines may pass under the panel;
 * leaving them out also keeps the grid cheap with every debris orbit drawn).
 */
export function lineWeight(kind: LineKind): number {
  switch (kind) {
    case 'current':
    case 'planned':
      return 4;
    case 'recoveryZone':
    case 'bodyOrbit':
    case 'vesselOrbit':
      return 2;
    case 'soi':
    case 'ghostBody':
    case 'debrisOrbit':
    case 'limb':
      return 0;
  }
}

/**
 * Weight per pixel of drawn line under a label (LineGrid.length): a trajectory counts fully, a zone ring or a
 * reference orbit about half, an SOI circle or a ghost outline a third (a thin line through a body name still
 * strikes it out); debris orbits and body silhouettes not at all.
 */
export function labelLineWeight(kind: LineKind): number {
  switch (kind) {
    case 'current':
    case 'planned':
      return 1;
    case 'recoveryZone':
      return 0.6;
    case 'bodyOrbit':
    case 'vesselOrbit':
      return 0.5;
    case 'soi':
    case 'ghostBody':
      return 0.35;
    case 'debrisOrbit':
    case 'limb':
      return 0;
  }
}

export class LineGrid {
  cell = 6;
  cols = 0;
  rows = 0;
  private w = new Uint8Array(0);
  /** Segment lists per cell (linked through `next`), for `length`. */
  private head = new Int32Array(0);
  private next = new Int32Array(1024);
  private segOf = new Int32Array(1024);
  private wOf = new Float32Array(1024);
  private nEntries = 0;
  /** Query stamp per vertex index (a segment found in several cells is counted once). */
  private stamp = new Int32Array(0);
  private query = 0;
  private scene: MapScene | null = null;

  /** Rasterise the drawn segments of `scene` into cells of `cellPx` device px. */
  build(scene: MapScene, cellPx: number): void {
    const width = scene.proj.width;
    const height = scene.proj.height;
    this.scene = scene;
    this.cell = cellPx;
    this.cols = Math.max(1, Math.ceil(width / cellPx));
    this.rows = Math.max(1, Math.ceil(height / cellPx));
    const n = this.cols * this.rows;
    if (this.w.length < n) {
      this.w = new Uint8Array(n);
      this.head = new Int32Array(n);
    } else this.w.fill(0, 0, n);
    this.head.fill(-1, 0, n);
    this.nEntries = 0;
    const v = scene.verts;
    if (this.stamp.length < v.n) this.stamp = new Int32Array(Math.ceil(v.n * 1.5));
    for (const line of scene.lines) {
      const weight = lineWeight(line.kind);
      const lw = labelLineWeight(line.kind);
      if (weight === 0 && lw === 0) continue;
      const end = line.start + line.count - 1;
      for (let i = line.start; i < end; i++) {
        if (v.seg[i] !== 1 || v.cover[i] === 1) continue;
        this.segment(i, v.sx[i]!, v.sy[i]!, v.sx[i + 1]!, v.sy[i + 1]!, width, height, weight, lw);
      }
    }
  }

  /** Sum of the cell weights a rectangle (device px) covers; its edges are pulled in by a pixel. */
  cost(x0: number, y0: number, x1: number, y1: number): number {
    const c = this.cell;
    const i0 = Math.max(0, Math.floor((x0 + 1) / c));
    const i1 = Math.min(this.cols - 1, Math.floor((x1 - 1) / c));
    const j0 = Math.max(0, Math.floor((y0 + 1) / c));
    const j1 = Math.min(this.rows - 1, Math.floor((y1 - 1) / c));
    let sum = 0;
    for (let j = j0; j <= j1; j++) {
      const row = j * this.cols;
      for (let i = i0; i <= i1; i++) sum += this.w[row + i]!;
    }
    return sum;
  }

  /** Weighted length (device px, labelLineWeight) of the drawn lines inside the rectangle [x0, x1] x [y0, y1]. */
  length(x0: number, y0: number, x1: number, y1: number): number {
    const scene = this.scene;
    if (!scene || this.nEntries === 0) return 0;
    const c = this.cell;
    const i0 = Math.max(0, Math.floor(x0 / c));
    const i1 = Math.min(this.cols - 1, Math.floor(x1 / c));
    const j0 = Math.max(0, Math.floor(y0 / c));
    const j1 = Math.min(this.rows - 1, Math.floor(y1 / c));
    if (i1 < i0 || j1 < j0) return 0;
    if (++this.query > 2e9) {
      this.stamp.fill(0);
      this.query = 1;
    }
    const q = this.query;
    const v = scene.verts;
    const sx = v.sx;
    const sy = v.sy;
    let sum = 0;
    for (let j = j0; j <= j1; j++) {
      const row = j * this.cols;
      for (let i = i0; i <= i1; i++) {
        for (let e = this.head[row + i]!; e >= 0; e = this.next[e]!) {
          const s = this.segOf[e]!;
          if (this.stamp[s] === q) continue;
          this.stamp[s] = q;
          const ax = sx[s]!;
          const ay = sy[s]!;
          const dx = sx[s + 1]! - ax;
          const dy = sy[s + 1]! - ay;
          // Liang-Barsky against the rectangle
          this.t0 = 0;
          this.t1 = 1;
          if (!this.clip(-dx, ax - x0) || !this.clip(dx, x1 - ax) || !this.clip(-dy, ay - y0) || !this.clip(dy, y1 - ay)) continue;
          sum += Math.sqrt(dx * dx + dy * dy) * (this.t1 - this.t0) * this.wOf[e]!;
        }
      }
    }
    return sum;
  }

  private t0 = 0;
  private t1 = 1;

  /** One Liang-Barsky boundary test; narrows [t0, t1]. */
  private clip(p: number, q: number): boolean {
    if (p === 0) return q >= 0;
    const r = q / p;
    if (p < 0) {
      if (r > this.t1) return false;
      if (r > this.t0) this.t0 = r;
    } else {
      if (r < this.t0) return false;
      if (r < this.t1) this.t1 = r;
    }
    return true;
  }

  private segment(index: number, ax: number, ay: number, bx: number, by: number, width: number, height: number, weight: number, lw: number): void {
    // wholly on one side of the screen: nothing to mark
    if ((ax < 0 && bx < 0) || (ay < 0 && by < 0) || (ax > width && bx > width) || (ay > height && by > height)) return;
    const dx = bx - ax;
    const dy = by - ay;
    this.t0 = 0;
    this.t1 = 1;
    // clip only what crosses the screen edge (most drawn segments lie inside it)
    const inside = ax >= 0 && ay >= 0 && ax <= width && ay <= height && bx >= 0 && by >= 0 && bx <= width && by <= height;
    if (!inside && (!this.clip(-dx, ax) || !this.clip(dx, width - ax) || !this.clip(-dy, ay) || !this.clip(dy, height - ay))) return;
    const t0 = this.t0;
    const t1 = this.t1;
    const x0 = ax + dx * t0;
    const y0 = ay + dy * t0;
    const len = Math.sqrt(dx * dx + dy * dy) * (t1 - t0);
    const inv = 1 / this.cell;
    // two steps per cell: no cell the segment crosses is skipped (its list must hold the segment)
    const steps = Math.max(1, Math.ceil(2 * len * inv));
    // walk in cell units (the clipped segment lies inside the screen: indices stay in range)
    let gx = x0 * inv;
    let gy = y0 * inv;
    const sx = (dx * (t1 - t0) * inv) / steps;
    const sy = (dy * (t1 - t0) * inv) / steps;
    const cols = this.cols;
    const maxI = cols - 1;
    const maxJ = this.rows - 1;
    const w = this.w;
    let last = -1;
    for (let s = 0; s <= steps; s++) {
      const i = gx < maxI ? gx | 0 : maxI;
      const j = gy < maxJ ? gy | 0 : maxJ;
      const k = j * cols + i;
      if (k !== last) {
        last = k;
        if (w[k]! < weight) w[k] = weight;
        if (lw > 0) this.push(k, index, lw);
      }
      gx += sx;
      gy += sy;
    }
  }

  private push(cell: number, seg: number, weight: number): void {
    const e = this.nEntries;
    if (e >= this.next.length) {
      const grow = <T extends Int32Array | Float32Array>(a: T, make: (n: number) => T): T => {
        const b = make(a.length * 2);
        b.set(a);
        return b;
      };
      this.next = grow(this.next, (n) => new Int32Array(n));
      this.segOf = grow(this.segOf, (n) => new Int32Array(n));
      this.wOf = grow(this.wOf, (n) => new Float32Array(n));
    }
    this.segOf[e] = seg;
    this.wOf[e] = weight;
    this.next[e] = this.head[cell]!;
    this.head[cell] = e;
    this.nEntries = e + 1;
  }
}
