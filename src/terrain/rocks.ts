/**
 * Procedural rocks: the same planet-fixed hash grid serves the height function (collidable rocks are bumps
 * in H) and RockField.rocksNear (instances the renderer draws), so drawn and collidable rocks coincide.
 *
 * Size-frequency (Golombek & Rapp 1997 form): the fractional area covered by rocks of diameter >= D is
 *     F_k(D) = k exp(-q(k) D),   q(k) = 1.79 + 0.152 / k        (D in m, k = total rock area fraction)
 * so the number density per unit diameter is n(D; k) = 4 k q e^(-q D) / (pi D^2) per m^2.
 * Classes are octaves of diameter [D_c, 2 D_c). Candidates are placed at the density of the largest k
 * anywhere (kMax) and thinned by n(D; k_local) / n(D; kMax) <= 1 with k_local from the model (fresh crater
 * ejecta on the Moon, land cover on Earth, 0 on a launch pad). Placement uses the radially projected
 * shell-in-cell scheme of craters.ts, so a point query visits the 2 x 2 x 2 nearest cells of each class.
 *
 * A rock of diameter D is an ellipsoidal cap: horizontal radius r = D/2, height above its base
 * hR = heightRatio * r, bump(rho) = hR sqrt(1 - (rho/r)^2) for rho < r (see rockBump()).
 */
import { hashToUnit, hashU32 } from '../core/math/hash';
import type { Vec3 } from '../core/math/vec3';
import type { RockInstance } from '../core/contracts/terrain';
import { subSeed } from './noise';
import { smootherstep01 } from './util';

export interface RockParams {
  seed: number;
  radius: number;
  minDiameter: number;
  maxDiameter: number;
  /** Rocks of at least this diameter are bumps in the height function (collidable). */
  collisionMinDiameter: number;
  /** Largest rock area fraction k anywhere on the body (thinning upper bound). */
  kMax: number;
  heightRatioMin: number;
  heightRatioMax: number;
  /** Number of mesh variants the renderer offers (RockInstance.variant in [0, variants)). */
  variants: number;
}

const SHELL_ALPHA = 0.5;
const REACH_MARGIN = 1.02;
const CDF_STEPS = 64;

export const golombekQ = (k: number): number => 1.79 + 0.152 / k;
/** Number density per unit diameter, per m^2 (k > 0). */
export const golombekDensity = (D: number, k: number): number => {
  const q = golombekQ(k);
  return (4 * k * q * Math.exp(-q * D)) / (Math.PI * D * D);
};
/** Cumulative fractional area covered by rocks of diameter >= D. */
export const golombekArea = (D: number, k: number): number => k * Math.exp(-golombekQ(k) * D);

/** Ellipsoidal-cap rock bump height at horizontal distance rho from the rock centre (0 outside). */
export function rockBump(rho2: number, r2: number, hR: number): number {
  if (rho2 >= r2) return 0;
  return hR * Math.sqrt(1 - rho2 / r2);
}

/** A rock candidate (before thinning). */
export interface RockCandidate {
  cx: number;
  cy: number;
  cz: number;
  diameter: number;
  heightRatio: number;
  /** Uniform in [0, 1): accepted when below n(D; k_local) / n(D; kMax). */
  accept: number;
  variant: number;
  seed: number;
}

export class RockClass {
  readonly dLo: number;
  readonly dHi: number;
  readonly cell: number;
  readonly invCell: number;
  readonly shellHalf: number;
  readonly slots: number;
  readonly pSlot: number;
  readonly hs: number;
  /** Expected rocks per m^2 of this class at kMax. */
  readonly densityMax: number;
  private readonly cdfD = new Float64Array(CDF_STEPS + 1);
  private readonly cdfF = new Float64Array(CDF_STEPS + 1);
  private bx = 0x7fffffff;
  private by = 0;
  private bz = 0;
  readonly block: RockCandidate[] = [];

  constructor(
    readonly k: number,
    readonly p: RockParams,
  ) {
    this.dLo = p.minDiameter * 2 ** k;
    this.dHi = this.dLo * 2;
    const reach = this.dHi / 2;
    this.cell = (2 * REACH_MARGIN * reach) / Math.sqrt(1 - REACH_MARGIN * REACH_MARGIN * SHELL_ALPHA * SHELL_ALPHA);
    this.invCell = 1 / this.cell;
    this.shellHalf = (SHELL_ALPHA * this.cell) / 2;
    // Integrate n(D; kMax) over the class (trapezoid on a fine grid) and keep the CDF for sampling.
    let acc = 0;
    this.cdfD[0] = this.dLo;
    this.cdfF[0] = 0;
    for (let i = 1; i <= CDF_STEPS; i++) {
      const d0 = this.dLo + ((i - 1) * (this.dHi - this.dLo)) / CDF_STEPS;
      const d1 = this.dLo + (i * (this.dHi - this.dLo)) / CDF_STEPS;
      acc += 0.5 * (golombekDensity(d0, p.kMax) + golombekDensity(d1, p.kMax)) * (d1 - d0);
      this.cdfD[i] = d1;
      this.cdfF[i] = acc;
    }
    this.densityMax = acc;
    for (let i = 0; i <= CDF_STEPS; i++) this.cdfF[i] = this.cdfF[i]! / acc;
    const perCell = (acc * this.cell * this.cell) / SHELL_ALPHA;
    this.slots = Math.max(1, Math.ceil(perCell));
    this.pSlot = perCell / this.slots;
    this.hs = hashU32(subSeed(p.seed ^ 0x5bd1e995, k));
  }

  private sampleDiameter(u: number): number {
    let lo = 0;
    let hi = CDF_STEPS;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (this.cdfF[mid]! <= u) lo = mid;
      else hi = mid;
    }
    const f0 = this.cdfF[lo]!;
    const f1 = this.cdfF[hi]!;
    const t = f1 > f0 ? (u - f0) / (f1 - f0) : 0;
    return this.cdfD[lo]! + t * (this.cdfD[hi]! - this.cdfD[lo]!);
  }

  /** Candidates of one cell in slot order (shell-accepted, not yet thinned). */
  cellRocks(ix: number, iy: number, iz: number, sink: (c: RockCandidate) => void): void {
    const hc = hashU32((iz ^ hashU32((iy ^ hashU32((ix ^ this.hs) >>> 0)) >>> 0)) >>> 0);
    const s = this.cell;
    const R = this.p.radius;
    for (let m = 0; m < this.slots; m++) {
      const hm = hashU32((hc + Math.imul(m, 0x632be5ab)) >>> 0);
      if (hashToUnit(hm) >= this.pSlot) continue;
      const x = (ix + hashToUnit(hashU32(hm ^ 0x11))) * s;
      const y = (iy + hashToUnit(hashU32(hm ^ 0x12))) * s;
      const z = (iz + hashToUnit(hashU32(hm ^ 0x13))) * s;
      const len = Math.sqrt(x * x + y * y + z * z);
      if (Math.abs(len - R) >= this.shellHalf) continue;
      const f = R / len;
      const h5 = hashU32(hm ^ 0x15);
      sink({
        cx: x * f,
        cy: y * f,
        cz: z * f,
        diameter: this.sampleDiameter(hashToUnit(hashU32(hm ^ 0x14))),
        heightRatio: this.p.heightRatioMin + (this.p.heightRatioMax - this.p.heightRatioMin) * hashToUnit(h5),
        accept: hashToUnit(hashU32(hm ^ 0x16)),
        variant: hashU32(hm ^ 0x17) % this.p.variants,
        seed: hashU32(hm ^ 0x18),
      });
    }
  }

  /** The candidates of the 2 x 2 x 2 cells nearest P (memoised per block). */
  nearBlock(px: number, py: number, pz: number): RockCandidate[] {
    const bx = Math.floor(px * this.invCell - 0.5) | 0;
    const by = Math.floor(py * this.invCell - 0.5) | 0;
    const bz = Math.floor(pz * this.invCell - 0.5) | 0;
    if (bx !== this.bx || by !== this.by || bz !== this.bz) {
      this.bx = bx;
      this.by = by;
      this.bz = bz;
      this.block.length = 0;
      const sink = (c: RockCandidate): void => {
        this.block.push(c);
      };
      for (let dx = 0; dx < 2; dx++) for (let dy = 0; dy < 2; dy++) for (let dz = 0; dz < 2; dz++) this.cellRocks(bx + dx, by + dy, bz + dz, sink);
    }
    return this.block;
  }
}

/** Thinning probability n(D; k) / n(D; kMax). */
export function acceptanceRatio(D: number, k: number, kMax: number): number {
  if (!(k > 0)) return 0;
  if (k >= kMax) return 1;
  const ql = golombekQ(k);
  const qm = golombekQ(kMax);
  return ((k * ql) / (kMax * qm)) * Math.exp(-(ql - qm) * D);
}

/** Local rock area fraction k at a point on the datum sphere (model-specific; 0 = no rocks). */
export type RockAbundance = (x: number, y: number, z: number) => number;

export class RockField {
  /** Classes coarse to fine. */
  readonly classes: RockClass[] = [];

  constructor(readonly p: RockParams) {
    for (let k = 0; ; k++) {
      const c = new RockClass(k, p);
      if (c.dLo >= p.maxDiameter) break;
      this.classes.push(c);
    }
    this.classes.reverse();
  }

  /**
   * Add the bumps of collidable rocks at P (on the datum sphere) to out[b] for each band limit: rock weight
   * smootherstep(log2(4 D) - log2 lambda) (full for D >= lambda / 2). Rocks with log2(4 D) >= skipAboveLog2
   * are omitted. `scale` multiplies every bump (1 - launch-pad flattening at P).
   */
  addBumps(px: number, py: number, pz: number, log2Lambdas: Float64Array, n: number, out: Float64Array, skipAboveLog2: number, abundance: RockAbundance): void {
    const minD = this.p.collisionMinDiameter;
    for (const c of this.classes) {
      if (c.dHi < minD) break;
      let any = false;
      const l4 = Math.log2(4 * c.dHi);
      for (let b = 0; b < n; b++) if (l4 > log2Lambdas[b]!) any = true;
      if (!any) break;
      const block = c.nearBlock(px, py, pz);
      for (let i = 0; i < block.length; i++) {
        const r = block[i]!;
        if (r.diameter < minD) continue;
        const rad = r.diameter / 2;
        const dx = px - r.cx;
        const dy = py - r.cy;
        const dz = pz - r.cz;
        const d2 = dx * dx + dy * dy + dz * dz;
        const r2 = rad * rad;
        if (d2 >= r2) continue;
        const log2Len = Math.log2(4 * r.diameter);
        if (log2Len >= skipAboveLog2) continue;
        if (r.accept >= acceptanceRatio(r.diameter, abundance(r.cx, r.cy, r.cz), this.p.kMax)) continue;
        const h = rockBump(d2, r2, r.heightRatio * rad);
        for (let b = 0; b < n; b++) out[b] = out[b]! + smootherstep01(log2Len - log2Lambdas[b]!) * h;
      }
    }
  }

  /**
   * Accepted rocks with diameter >= 2 minRadius whose centre lies within `radius` m of the surface point
   * `centre` (unit dir), in canonical order (class coarse to fine, then cell, then slot). Cells are enumerated
   * exactly: every cell whose shell slab can hold a candidate inside the cap.
   */
  rocksIn(centre: Vec3, radius: number, minRadius: number, abundance: RockAbundance): { c: RockCandidate; cls: RockClass }[] {
    const out: { c: RockCandidate; cls: RockClass }[] = [];
    const R = this.p.radius;
    const px = centre.x * R;
    const py = centre.y * R;
    const pz = centre.z * R;
    const r2 = radius * radius;
    for (const cls of this.classes) {
      if (cls.dHi / 2 < minRadius) break;
      const cells = shellCellsInCap(centre, radius, R, cls.cell, cls.shellHalf);
      for (let i = 0; i < cells.length; i += 3) {
        cls.cellRocks(cells[i]!, cells[i + 1]!, cells[i + 2]!, (c) => {
          if (c.diameter / 2 < minRadius) return;
          const dx = c.cx - px;
          const dy = c.cy - py;
          const dz = c.cz - pz;
          if (dx * dx + dy * dy + dz * dz > r2) return;
          if (c.accept >= acceptanceRatio(c.diameter, abundance(c.cx, c.cy, c.cz), this.p.kMax)) return;
          out.push({ c, cls });
        });
      }
    }
    return out;
  }
}

/**
 * Integer cells (xyz triples, sorted) of size `cell` that intersect the shell R +- shellHalf within angular
 * radius (radius + cell) / R of `centre`. Columns run along the axis most aligned with the centre normal; per
 * column the axis range is bounded from the shell radii at the column corners.
 */
export function shellCellsInCap(centre: Vec3, radius: number, R: number, cell: number, shellHalf: number): Int32Array {
  const n = [centre.x, centre.y, centre.z];
  const ax = Math.abs(n[0]!) >= Math.abs(n[1]!) && Math.abs(n[0]!) >= Math.abs(n[2]!) ? 0 : Math.abs(n[1]!) >= Math.abs(n[2]!) ? 1 : 2;
  const j = (ax + 1) % 3;
  const k = (ax + 2) % 3;
  const sign = n[ax]! >= 0 ? 1 : -1;
  const reach = radius + cell * 2;
  // Projected extent of the cap onto the (j, k) plane (bounding square, conservative).
  const cj = n[j]! * R;
  const ck = n[k]! * R;
  const j0 = Math.floor((cj - reach) / cell);
  const j1 = Math.floor((cj + reach) / cell);
  const k0 = Math.floor((ck - reach) / cell);
  const k1 = Math.floor((ck + reach) / cell);
  const rIn = R - shellHalf;
  const rOut = R + shellHalf;
  // Columns whose centre point on the sphere lies farther than this angle from the cap centre cannot hold
  // a candidate inside the cap (column half-diagonal on the sphere <= sqrt(3/2) cell for |n_ax| >= 1/sqrt(3)).
  const maxAngle = (reach + 1.25 * cell + shellHalf) / R;
  const cells: number[] = [];
  for (let a = j0; a <= j1; a++) {
    for (let b = k0; b <= k1; b++) {
      const xj0 = a * cell;
      const xj1 = xj0 + cell;
      const xk0 = b * cell;
      const xk1 = xk0 + cell;
      // Range of the in-plane radius over the column square.
      const nj = xj0 > 0 ? xj0 : xj1 < 0 ? -xj1 : 0;
      const nk = xk0 > 0 ? xk0 : xk1 < 0 ? -xk1 : 0;
      const fj = Math.max(Math.abs(xj0), Math.abs(xj1));
      const fk = Math.max(Math.abs(xk0), Math.abs(xk1));
      const qMin = nj * nj + nk * nk;
      const qMax = fj * fj + fk * fk;
      if (qMin >= rOut * rOut) continue;
      const hiA = Math.sqrt(rOut * rOut - qMin);
      const loA = qMax < rIn * rIn ? Math.sqrt(rIn * rIn - qMax) : 0;
      const mj = (xj0 + xj1) / 2;
      const mk = (xk0 + xk1) / 2;
      const ma = Math.sqrt(Math.max(0, R * R - mj * mj - mk * mk));
      const dotc = Math.max(-1, Math.min(1, (mj * n[j]! + mk * n[k]! + sign * ma * n[ax]!) / R));
      if (Math.acos(dotc) > maxAngle) continue;
      const c0 = sign > 0 ? Math.floor(loA / cell) : Math.floor(-hiA / cell);
      const c1 = sign > 0 ? Math.floor(hiA / cell) : Math.floor(-loA / cell);
      for (let c = c0; c <= c1; c++) {
        const v = [0, 0, 0];
        v[ax] = c;
        v[j] = a;
        v[k] = b;
        cells.push(v[0]!, v[1]!, v[2]!);
      }
    }
  }
  const idx = Array.from({ length: cells.length / 3 }, (_, i) => i);
  idx.sort((p, q) => cells[3 * p]! - cells[3 * q]! || cells[3 * p + 1]! - cells[3 * q + 1]! || cells[3 * p + 2]! - cells[3 * q + 2]!);
  const out = new Int32Array(cells.length);
  idx.forEach((p, i) => {
    out[3 * i] = cells[3 * p]!;
    out[3 * i + 1] = cells[3 * p + 1]!;
    out[3 * i + 2] = cells[3 * p + 2]!;
  });
  return out;
}

/** Convert an accepted candidate into the contract's RockInstance. */
export function toInstance(c: RockCandidate, baseHeight: number): RockInstance {
  const l = Math.sqrt(c.cx * c.cx + c.cy * c.cy + c.cz * c.cz);
  return { dir: { x: c.cx / l, y: c.cy / l, z: c.cz / l }, baseHeight, radius: c.diameter / 2, variant: c.variant, seed: c.seed };
}
