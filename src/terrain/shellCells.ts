/**
 * Hash-grid geometry shared by craters and rocks: features are candidates at hashed positions in cubic cells
 * of size s, accepted when they lie in the shell | |c| - R | < SHELL_ALPHA s / 2 and projected radially to the
 * datum sphere. With s >= cellSizeForReach(reach) every feature that can reach a point P lies in the
 * 2 x 2 x 2 block of cells nearest P.
 */
import type { Vec3 } from '../core/math/vec3';

/** Shell thickness as a fraction of the cell size. */
export const SHELL_ALPHA = 0.5;
/** Safety factor on the reach bound (curvature of the sphere within one cell). */
const REACH_MARGIN = 1.02;
/** Smallest cell size for which a feature reaching `reach` m is always in the nearest 2 x 2 x 2 block. */
export function cellSizeForReach(reach: number): number {
  return (2 * REACH_MARGIN * reach) / Math.sqrt(1 - REACH_MARGIN * REACH_MARGIN * SHELL_ALPHA * SHELL_ALPHA);
}

/**
 * Cell size, slot count and slot probability for features of areal density `density` (per m^2) with the
 * given reach: the cell is the reach minimum, enlarged when that would hold fewer than `targetPerCell`
 * candidates (fewer cells to visit per candidate when enumerating an area, at the price of more candidates
 * per point query: craters use 0.5, rocks 2).
 */
export function cellLayout(density: number, reach: number, targetPerCell: number): { cell: number; slots: number; pSlot: number } {
  const sMin = cellSizeForReach(reach);
  const sSparse = density > 0 ? Math.sqrt((SHELL_ALPHA * targetPerCell) / density) : sMin;
  const cell = Math.max(sMin, sSparse);
  const perCell = (density * cell * cell) / SHELL_ALPHA;
  const slots = Math.max(1, Math.ceil(perCell));
  return { cell, slots, pSlot: perCell / slots };
}

/**
 * Integer cells (xyz triples) of size `cell` that intersect the shell R +- shellHalf within (radius + 2 cell)
 * of the surface point `centre` (unit dir). Exact enumeration by columns along the axis most aligned with the
 * centre normal; per column the axis range is bounded from the shell radii over the column square. Every
 * candidate whose projected centre lies within `radius` of the centre is in a returned cell. The order is the
 * deterministic column order (a pure function of the arguments).
 */
export function shellCellsInCap(centre: Vec3, radius: number, R: number, cell: number, shellHalf: number): Int32Array {
  const n = [centre.x, centre.y, centre.z];
  const ax = Math.abs(n[0]!) >= Math.abs(n[1]!) && Math.abs(n[0]!) >= Math.abs(n[2]!) ? 0 : Math.abs(n[1]!) >= Math.abs(n[2]!) ? 1 : 2;
  const j = (ax + 1) % 3;
  const k = (ax + 2) % 3;
  const sign = n[ax]! >= 0 ? 1 : -1;
  const reach = radius + cell * 2;
  const cj = n[j]! * R;
  const ck = n[k]! * R;
  const j0 = Math.floor((cj - reach) / cell);
  const j1 = Math.floor((cj + reach) / cell);
  const k0 = Math.floor((ck - reach) / cell);
  const k1 = Math.floor((ck + reach) / cell);
  const rIn = R - shellHalf;
  const rOut = R + shellHalf;
  // Columns whose centre point on the sphere lies farther than this angle from the cap centre cannot hold a
  // candidate inside the cap (column half-diagonal on the sphere <= sqrt(3/2) cell for |n_ax| >= 1/sqrt(3)).
  const cosMax = Math.cos(Math.min(Math.PI, (reach + 1.25 * cell + shellHalf) / R));
  let out = new Int32Array(1024);
  let count = 0;
  const v = [0, 0, 0];
  for (let a = j0; a <= j1; a++) {
    const xj0 = a * cell;
    const xj1 = xj0 + cell;
    const nj = xj0 > 0 ? xj0 : xj1 < 0 ? -xj1 : 0;
    const fj = Math.max(Math.abs(xj0), Math.abs(xj1));
    const mj = (xj0 + xj1) / 2;
    for (let b = k0; b <= k1; b++) {
      const xk0 = b * cell;
      const xk1 = xk0 + cell;
      const nk = xk0 > 0 ? xk0 : xk1 < 0 ? -xk1 : 0;
      const fk = Math.max(Math.abs(xk0), Math.abs(xk1));
      const qMin = nj * nj + nk * nk;
      if (qMin >= rOut * rOut) continue;
      const qMax = fj * fj + fk * fk;
      const mk = (xk0 + xk1) / 2;
      const ma = Math.sqrt(Math.max(0, R * R - mj * mj - mk * mk));
      const dotc = (mj * n[j]! + mk * n[k]! + sign * ma * n[ax]!) / R;
      if (dotc < cosMax) continue;
      const hiA = Math.sqrt(rOut * rOut - qMin);
      const loA = qMax < rIn * rIn ? Math.sqrt(rIn * rIn - qMax) : 0;
      const c0 = sign > 0 ? Math.floor(loA / cell) : Math.floor(-hiA / cell);
      const c1 = sign > 0 ? Math.floor(hiA / cell) : Math.floor(-loA / cell);
      for (let c = c0; c <= c1; c++) {
        v[ax] = c;
        v[j] = a;
        v[k] = b;
        if (count + 3 > out.length) {
          const grown = new Int32Array(out.length * 2);
          grown.set(out);
          out = grown;
        }
        out[count++] = v[0]!;
        out[count++] = v[1]!;
        out[count++] = v[2]!;
      }
    }
  }
  return out.subarray(0, count);
}
