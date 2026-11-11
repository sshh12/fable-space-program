/**
 * Coarse occupancy grid of the drawn lines on screen, so labels, the node panel and the tooltip can be placed
 * off the trajectories instead of on top of them. Each cell holds the largest weight of the lines through it
 * (trajectories weigh more than reference orbits); a rectangle's cost is the sum over the cells it covers.
 * Rebuilt every draw list from the scene's projected vertices: one pass over the drawn segments, clipped to
 * the screen, marking the cells along each at half-cell steps.
 */
import type { LineKind, MapScene } from './scene';

/** Weight of a line kind (0 = not an obstacle). */
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
      return 1;
  }
}

export class LineGrid {
  cell = 6;
  cols = 0;
  rows = 0;
  private w = new Uint8Array(0);

  /** Rasterise the drawn segments of `scene` into cells of `cellPx` device px. */
  build(scene: MapScene, cellPx: number): void {
    const width = scene.proj.width;
    const height = scene.proj.height;
    this.cell = cellPx;
    this.cols = Math.max(1, Math.ceil(width / cellPx));
    this.rows = Math.max(1, Math.ceil(height / cellPx));
    const n = this.cols * this.rows;
    if (this.w.length < n) this.w = new Uint8Array(n);
    else this.w.fill(0, 0, n);
    const v = scene.verts;
    for (const line of scene.lines) {
      const weight = lineWeight(line.kind);
      if (weight === 0) continue;
      const end = line.start + line.count - 1;
      for (let i = line.start; i < end; i++) {
        if (v.seg[i] !== 1) continue;
        this.segment(v.sx[i]!, v.sy[i]!, v.sx[i + 1]!, v.sy[i + 1]!, width, height, weight);
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

  private segment(ax: number, ay: number, bx: number, by: number, width: number, height: number, weight: number): void {
    const dx = bx - ax;
    const dy = by - ay;
    this.t0 = 0;
    this.t1 = 1;
    if (!this.clip(-dx, ax) || !this.clip(dx, width - ax) || !this.clip(-dy, ay) || !this.clip(dy, height - ay)) return;
    const t0 = this.t0;
    const t1 = this.t1;
    const x0 = ax + dx * t0;
    const y0 = ay + dy * t0;
    const len = Math.hypot(dx, dy) * (t1 - t0);
    const c = this.cell;
    const steps = Math.max(1, Math.ceil((2 * len) / c));
    const sx = (dx * (t1 - t0)) / steps;
    const sy = (dy * (t1 - t0)) / steps;
    for (let s = 0; s <= steps; s++) {
      const i = Math.min(this.cols - 1, Math.max(0, Math.floor((x0 + sx * s) / c)));
      const j = Math.min(this.rows - 1, Math.max(0, Math.floor((y0 + sy * s) / c)));
      const k = j * this.cols + i;
      if (this.w[k]! < weight) this.w[k] = weight;
    }
  }
}
