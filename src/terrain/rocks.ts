/**
 * Procedural rocks: the same planet-fixed hash grid serves the height function (collidable rocks are bumps
 * in H) and RockField.rocksNear (instances the renderer draws), so drawn and collidable rocks coincide.
 *
 * Size-frequency (Golombek & Rapp 1997 form): the fractional area covered by rocks of diameter >= D is
 *     F_k(D) = k exp(-q(k) D),   q(k) = 1.79 + 0.152 / k        (D in m, k = total rock area fraction)
 * so the number density per unit diameter is n(D; k) = 4 k q e^(-q D) / (pi D^2) per m^2.
 * Classes are octaves of diameter [D_c, 2 D_c). Candidates are placed at the density of the largest k
 * anywhere (kMax) and thinned by n(D; k_local) / n(D; kMax) <= 1 with k_local from the model (fresh crater
 * ejecta on the Moon, land cover on Earth, 0 on a launch pad). Placement uses the shell-in-cell hash grid
 * (shellCells.ts), so a point query visits the 2 x 2 x 2 nearest cells of each class.
 *
 * A rock of diameter D is an ellipsoidal cap: horizontal radius r = D/2, height above its base
 * hR = heightRatio * r, bump(rho) = hR sqrt(1 - (rho/r)^2) for rho < r (rockBump()).
 */
import { hashToUnit, hashU32 } from '../core/math/hash';
import type { Vec3 } from '../core/math/vec3';
import type { RockInstance } from '../core/contracts/terrain';
import { subSeed } from './noise';
import { cellLayout, SHELL_ALPHA, shellCellsInCap } from './shellCells';
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

const CDF_STEPS = 64;

export const golombekQ = (k: number): number => 1.79 + 0.152 / k;
/** Number density per unit diameter, per m^2 (k > 0). */
export const golombekDensity = (D: number, k: number): number => {
  const q = golombekQ(k);
  return (4 * k * q * Math.exp(-q * D)) / (Math.PI * D * D);
};
/** Cumulative fractional area covered by rocks of diameter >= D. */
export const golombekArea = (D: number, k: number): number => k * Math.exp(-golombekQ(k) * D);

/**
 * Characteristic length of a rock of diameter D for band limiting: its dominant wavelength, 2 D. With the
 * band weight smootherstep(log2(len / lambdaMin)) a rock is fully present for D >= lambdaMin and absent for
 * D <= lambdaMin / 2; at the collision band (~0.3 m) every collidable rock (D >= 0.3 m) has weight >= 0.99.
 */
export const rockLog2Length = (D: number): number => Math.log2(2 * D);

/** Ellipsoidal-cap rock bump height at squared horizontal distance rho2 from the centre (0 outside r). */
export function rockBump(rho2: number, r2: number, hR: number): number {
  if (rho2 >= r2) return 0;
  return hR * Math.sqrt(1 - rho2 / r2);
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

const STRIDE = 8;

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
  /** Block cache: count and records [cx, cy, cz, D, heightRatio, accept, variant, seed]. */
  count = 0;
  readonly rec: Float64Array;

  constructor(
    readonly k: number,
    readonly p: RockParams,
  ) {
    this.dLo = p.minDiameter * 2 ** k;
    this.dHi = this.dLo * 2;
    // Integrate n(D; kMax) over the class (trapezoid) and keep the CDF for sampling diameters.
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
    const lay = cellLayout(acc, this.dHi / 2, 2);
    this.cell = lay.cell;
    this.slots = lay.slots;
    this.pSlot = lay.pSlot;
    this.invCell = 1 / this.cell;
    this.shellHalf = (SHELL_ALPHA * this.cell) / 2;
    this.hs = hashU32(subSeed(p.seed ^ 0x5bd1e995, k));
    this.rec = new Float64Array(8 * this.slots * STRIDE);
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

  private cellHash(ix: number, iy: number, iz: number): number {
    return hashU32((iz ^ hashU32((iy ^ hashU32((ix ^ this.hs) >>> 0)) >>> 0)) >>> 0);
  }

  /**
   * Decode slot m of a cell into out[o..o+STRIDE); false when absent, outside the shell, or when its
   * acceptance draw is >= acceptMax (callers that know an upper bound of the thinning ratio reject early).
   */
  private decode(hc: number, m: number, ix: number, iy: number, iz: number, out: Float64Array, o: number, acceptMax = 1): boolean {
    const hm = hashU32((hc + Math.imul(m, 0x632be5ab)) >>> 0);
    if (hashToUnit(hm) >= this.pSlot) return false;
    if (acceptMax < 1 && hashToUnit(hashU32(hm ^ 0x16)) >= acceptMax) return false;
    const s = this.cell;
    const x = (ix + hashToUnit(hashU32(hm ^ 0x11))) * s;
    const y = (iy + hashToUnit(hashU32(hm ^ 0x12))) * s;
    const z = (iz + hashToUnit(hashU32(hm ^ 0x13))) * s;
    const len = Math.sqrt(x * x + y * y + z * z);
    const R = this.p.radius;
    if (Math.abs(len - R) >= this.shellHalf) return false;
    const f = R / len;
    out[o] = x * f;
    out[o + 1] = y * f;
    out[o + 2] = z * f;
    out[o + 3] = this.sampleDiameter(hashToUnit(hashU32(hm ^ 0x14)));
    out[o + 4] = this.p.heightRatioMin + (this.p.heightRatioMax - this.p.heightRatioMin) * hashToUnit(hashU32(hm ^ 0x15));
    out[o + 5] = hashToUnit(hashU32(hm ^ 0x16));
    out[o + 6] = hashU32(hm ^ 0x17) % this.p.variants;
    out[o + 7] = hashU32(hm ^ 0x18);
    return true;
  }

  private readonly scratch = new Float64Array(STRIDE);

  /**
   * Candidates of one cell in slot order (object form; rocksNear and splatting). `kBound` = an upper bound of
   * the local abundance wherever these candidates can be accepted: candidates that thinning must reject even
   * at kBound are skipped without decoding.
   */
  cellRocks(ix: number, iy: number, iz: number, out: RockCandidate[], kBound = Infinity): void {
    const hc = this.cellHash(ix, iy, iz);
    const t = this.scratch;
    const acceptMax = kBound >= this.p.kMax ? 1 : acceptanceRatio(this.dLo, kBound, this.p.kMax);
    if (acceptMax <= 0) return;
    for (let m = 0; m < this.slots; m++) {
      if (!this.decode(hc, m, ix, iy, iz, t, 0, acceptMax)) continue;
      out.push({ cx: t[0]!, cy: t[1]!, cz: t[2]!, diameter: t[3]!, heightRatio: t[4]!, accept: t[5]!, variant: t[6]!, seed: t[7]! });
    }
  }

  /** Fill the block cache with the candidates of the 2 x 2 x 2 cells nearest P. */
  nearBlock(px: number, py: number, pz: number): void {
    const bx = Math.floor(px * this.invCell - 0.5) | 0;
    const by = Math.floor(py * this.invCell - 0.5) | 0;
    const bz = Math.floor(pz * this.invCell - 0.5) | 0;
    if (bx === this.bx && by === this.by && bz === this.bz) return;
    this.bx = bx;
    this.by = by;
    this.bz = bz;
    let count = 0;
    for (let dx = 0; dx < 2; dx++) {
      const hx = hashU32(((bx + dx) ^ this.hs) >>> 0);
      for (let dy = 0; dy < 2; dy++) {
        const hy = hashU32(((by + dy) ^ hx) >>> 0);
        for (let dz = 0; dz < 2; dz++) {
          const hc = hashU32(((bz + dz) ^ hy) >>> 0);
          for (let m = 0; m < this.slots; m++) if (this.decode(hc, m, bx + dx, by + dy, bz + dz, this.rec, count * STRIDE)) count++;
        }
      }
    }
    this.count = count;
  }
}

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
   * smootherstep(rockLog2Length(D) - log2 lambda). Rocks with rockLog2Length(D) >= skipAboveLog2 are omitted.
   */
  addBumps(px: number, py: number, pz: number, log2Lambdas: Float64Array, n: number, out: Float64Array, skipAboveLog2: number, abundance: RockAbundance): void {
    const minD = this.p.collisionMinDiameter;
    for (const c of this.classes) {
      if (c.dHi < minD) break;
      let any = false;
      const l4 = rockLog2Length(c.dHi);
      for (let b = 0; b < n; b++) if (l4 > log2Lambdas[b]!) any = true;
      if (!any) break;
      c.nearBlock(px, py, pz);
      const rec = c.rec;
      for (let i = 0, o = 0; i < c.count; i++, o += STRIDE) {
        const D = rec[o + 3]!;
        if (D < minD) continue;
        const rad = D / 2;
        const dx = px - rec[o]!;
        const dy = py - rec[o + 1]!;
        const dz = pz - rec[o + 2]!;
        const d2 = dx * dx + dy * dy + dz * dz;
        const r2 = rad * rad;
        if (d2 >= r2) continue;
        const log2Len = rockLog2Length(D);
        if (log2Len >= skipAboveLog2) continue;
        if (rec[o + 5]! >= acceptanceRatio(D, abundance(rec[o]!, rec[o + 1]!, rec[o + 2]!), this.p.kMax)) continue;
        const h = rockBump(d2, r2, rec[o + 4]! * rad);
        for (let b = 0; b < n; b++) out[b] = out[b]! + smootherstep01(log2Len - log2Lambdas[b]!) * h;
      }
    }
  }

  /**
   * Accepted rocks with diameter >= 2 minRadius whose centre lies within `radius` m of the surface point
   * `centre` (unit dir), in canonical order (class coarse to fine, then cell, then slot).
   */
  rocksIn(centre: Vec3, radius: number, minRadius: number, abundance: RockAbundance, bound: RockAbundanceBound): RockCandidate[] {
    const out: RockCandidate[] = [];
    const R = this.p.radius;
    const px = centre.x * R;
    const py = centre.y * R;
    const pz = centre.z * R;
    const r2 = radius * radius;
    const list: RockCandidate[] = [];
    for (const cls of this.classes) {
      if (cls.dHi / 2 < minRadius) break;
      list.length = 0;
      this.cellsCandidates(cls, shellCellsInCap(centre, radius, R, cls.cell, cls.shellHalf), list, bound);
      for (const c of list) {
        if (c.diameter / 2 < minRadius) continue;
        const dx = c.cx - px;
        const dy = c.cy - py;
        const dz = c.cz - pz;
        if (dx * dx + dy * dy + dz * dz > r2) continue;
        if (c.accept >= acceptanceRatio(c.diameter, abundance(c.cx, c.cy, c.cz), this.p.kMax)) continue;
        out.push(c);
      }
    }
    return out;
  }

  /**
   * Candidates of the given cells (xyz triples) that thinning could accept: for each cell an upper bound of
   * the abundance around it (bound(x, y, z, extent) with extent = the farthest a candidate of the cell can lie
   * from the cell centre per axis) rejects hopeless candidates before they are decoded. Same survivors, in
   * the same order, as decoding every candidate and thinning exactly.
   */
  cellsCandidates(cls: RockClass, cells: Int32Array, out: RockCandidate[], bound: RockAbundanceBound): void {
    const s = cls.cell;
    const extent = s / 2 + cls.shellHalf;
    for (let i = 0; i < cells.length; i += 3) {
      const ix = cells[i]!;
      const iy = cells[i + 1]!;
      const iz = cells[i + 2]!;
      const kb = bound((ix + 0.5) * s, (iy + 0.5) * s, (iz + 0.5) * s, extent);
      if (kb <= 0) continue;
      cls.cellRocks(ix, iy, iz, out, kb);
    }
  }
}

/**
 * Upper bound of the rock abundance at every point within `extent` m (per axis) of (x, y, z); Infinity when
 * no bound is known.
 */
export type RockAbundanceBound = (x: number, y: number, z: number, extent: number) => number;

/** Convert an accepted candidate into the contract's RockInstance. */
export function toInstance(c: RockCandidate, baseHeight: number): RockInstance {
  const l = Math.sqrt(c.cx * c.cx + c.cy * c.cy + c.cz * c.cz);
  return { dir: { x: c.cx / l, y: c.cy / l, z: c.cz / l }, baseHeight, radius: c.diameter / 2, variant: c.variant, seed: c.seed };
}
