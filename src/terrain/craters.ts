/**
 * Procedural impact craters on a hash grid in planet-fixed 3-D space (seamless across cube faces).
 *
 * Size classes are half-octaves of diameter: class k holds diameters in [D_k, sqrt(2) D_k) with
 * D_k = minDiameter * 2^(k/2). Placement per class: cubic cells of size s; each cell holds `slots` candidate
 * craters, each present with probability pSlot, at a hashed position c in the cell; a candidate is accepted
 * when it lies in the shell | |c| - R | < alpha s / 2 and is projected radially to the datum sphere. That gives
 * a uniform areal density of slots * pSlot * alpha / s^2, which is set to the equilibrium size-frequency law
 *     N(>D) = 1.54 * f * D^-2   per m^2   (D in m; f = equilibrium fraction of geometric saturation)
 * integrated over the class. The cell size is chosen so every crater that can reach a point P lies in the
 * 2 x 2 x 2 block of cells nearest P, i.e. a point query visits 8 cells per class.
 *
 * Profile in r = distance / (D/2) (Pike 1977; McGetchin et al. 1973 for the r^-3 ejecta):
 *   bowl   hb(r) = h_r - (d + h_r) (1 - r^2)        depth d below the pre-impact surface at the centre
 *   ejecta he(r) = h_r r^-3 (1 - smoothstep(e - 1, e, r)),  e = ejecta extent in radii
 *   h(r) = smoothMin(hb, he, rounding)               rim crest rounded more for degraded craters
 * with freshness phi in [0, 1] (phi = u^freshnessExponent, weighted to degraded craters):
 *   d   = D (dDdegraded + (dDfresh - dDdegraded) phi),   h_r = rimHeightToDiameter D (rimDegraded + (1 - rimDegraded) phi).
 * Each class is weighted by the effective data level E (classes fade in below craterMaxDiameterInPostings
 * data postings) and by the band limit lambdaMin (classes fade out as D approaches lambdaMin).
 */
import { hashToUnit, hashU32 } from '../core/math/hash';
import { subSeed } from './noise';
import { smoothMin, smootherstep01, smoothstepEdges } from './util';

export interface CraterParams {
  seed: number;
  /** Datum sphere radius, m. */
  radius: number;
  minDiameter: number;
  /** Largest diameter any class must reach (the classes stop above it). */
  maxDiameter: number;
  equilibriumFraction: number;
  extentRadii: number;
  freshDepthToDiameter: number;
  degradedDepthToDiameter: number;
  rimHeightToDiameter: number;
  /** Rim height of a fully degraded crater as a fraction of the fresh rim. */
  rimDegraded: number;
  freshnessExponent: number;
  /** smoothMin rounding of the rim crest as a fraction of (depth + rim height): fresh and degraded. */
  rimRoundingFresh: number;
  rimRoundingDegraded: number;
}

/** Shell thickness as a fraction of the cell size. */
const SHELL_ALPHA = 0.5;
/** Safety factor on the reach bound (curvature of the sphere within one cell). */
const REACH_MARGIN = 1.02;

export interface CraterRecord {
  /** Centre on the datum sphere, m. */
  cx: number;
  cy: number;
  cz: number;
  diameter: number;
  freshness: number;
  depth: number;
  rim: number;
  rounding: number;
  reach2: number;
  invHalfD: number;
  /** Class index. */
  k: number;
}

export class CraterClass {
  readonly dLo: number;
  readonly dHi: number;
  readonly log2DLo: number;
  readonly log2DHi: number;
  readonly cell: number;
  readonly invCell: number;
  readonly shellHalf: number;
  readonly slots: number;
  readonly pSlot: number;
  readonly hs: number;
  /** Expected crater count per m^2 of this class (the target law). */
  readonly density: number;
  // 2x2x2 block cache
  private bx = 0x7fffffff;
  private by = 0;
  private bz = 0;
  count = 0;
  readonly rec: Float64Array;
  static readonly STRIDE = 10;

  constructor(
    readonly k: number,
    readonly p: CraterParams,
  ) {
    this.dLo = p.minDiameter * 2 ** (k / 2);
    this.dHi = this.dLo * Math.SQRT2;
    this.log2DLo = Math.log2(this.dLo);
    this.log2DHi = Math.log2(this.dHi);
    const reach = (p.extentRadii / 2) * this.dHi;
    this.cell = (2 * REACH_MARGIN * reach) / Math.sqrt(1 - REACH_MARGIN * REACH_MARGIN * SHELL_ALPHA * SHELL_ALPHA);
    this.invCell = 1 / this.cell;
    this.shellHalf = (SHELL_ALPHA * this.cell) / 2;
    const c = 1.54 * p.equilibriumFraction;
    this.density = c / (this.dLo * this.dLo) - c / (this.dHi * this.dHi);
    const perCell = (this.density * this.cell * this.cell) / SHELL_ALPHA;
    this.slots = Math.max(1, Math.ceil(perCell));
    this.pSlot = perCell / this.slots;
    this.hs = hashU32(subSeed(p.seed, k));
    this.rec = new Float64Array(8 * this.slots * CraterClass.STRIDE);
  }

  /** Crater candidates of one cell, appended to `sink` (in slot order) when accepted. */
  cellCraters(ix: number, iy: number, iz: number, sink: (r: CraterRecord) => void): void {
    const hc = hashU32((iz ^ hashU32((iy ^ hashU32((ix ^ this.hs) >>> 0)) >>> 0)) >>> 0);
    for (let m = 0; m < this.slots; m++) this.slot(hc, m, ix, iy, iz, sink);
  }

  private slot(hc: number, m: number, ix: number, iy: number, iz: number, sink: (r: CraterRecord) => void): void {
    const hm = hashU32((hc + Math.imul(m, 0x632be5ab)) >>> 0);
    if (hashToUnit(hm) >= this.pSlot) return;
    const s = this.cell;
    const x = (ix + hashToUnit(hashU32(hm ^ 0x1))) * s;
    const y = (iy + hashToUnit(hashU32(hm ^ 0x2))) * s;
    const z = (iz + hashToUnit(hashU32(hm ^ 0x3))) * s;
    const len = Math.sqrt(x * x + y * y + z * z);
    const R = this.p.radius;
    if (Math.abs(len - R) >= this.shellHalf) return;
    const f = R / len;
    // Diameter from the class power law (cumulative slope -2): D = D_lo / sqrt(1 - F/2), F uniform.
    const D = this.dLo / Math.sqrt(1 - hashToUnit(hashU32(hm ^ 0x4)) / 2);
    const phi = hashToUnit(hashU32(hm ^ 0x5)) ** this.p.freshnessExponent;
    sink(makeRecord(this.p, this.k, x * f, y * f, z * f, D, phi));
  }

  /** Make the block cache hold the 2 x 2 x 2 cells nearest (px, py, pz). */
  private ensureBlock(px: number, py: number, pz: number): void {
    const bx = Math.floor(px * this.invCell - 0.5) | 0;
    const by = Math.floor(py * this.invCell - 0.5) | 0;
    const bz = Math.floor(pz * this.invCell - 0.5) | 0;
    if (bx === this.bx && by === this.by && bz === this.bz) return;
    this.bx = bx;
    this.by = by;
    this.bz = bz;
    this.count = 0;
    const rec = this.rec;
    const sink = (r: CraterRecord): void => {
      const o = this.count * CraterClass.STRIDE;
      rec[o] = r.cx;
      rec[o + 1] = r.cy;
      rec[o + 2] = r.cz;
      rec[o + 3] = r.reach2;
      rec[o + 4] = r.invHalfD;
      rec[o + 5] = r.depth;
      rec[o + 6] = r.rim;
      rec[o + 7] = r.rounding;
      rec[o + 8] = r.freshness;
      rec[o + 9] = r.diameter;
      this.count++;
    };
    for (let dx = 0; dx < 2; dx++) for (let dy = 0; dy < 2; dy++) for (let dz = 0; dz < 2; dz++) this.cellCraters(bx + dx, by + dy, bz + dz, sink);
  }

  /** Sum of crater profiles at P (m), in canonical order. */
  heightAt(px: number, py: number, pz: number, ext: number): number {
    this.ensureBlock(px, py, pz);
    const rec = this.rec;
    let sum = 0;
    for (let i = 0, o = 0; i < this.count; i++, o += CraterClass.STRIDE) {
      const dx = px - rec[o]!;
      const dy = py - rec[o + 1]!;
      const dz = pz - rec[o + 2]!;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 >= rec[o + 3]!) continue;
      sum += profile(Math.sqrt(d2) * rec[o + 4]!, rec[o + 5]!, rec[o + 6]!, rec[o + 7]!, ext);
    }
    return sum;
  }

  /** max over craters of freshness * interior/ejecta proximity (material weight), and the rock source term. */
  freshnessAt(px: number, py: number, pz: number, ext: number, rockSource: boolean): number {
    this.ensureBlock(px, py, pz);
    const rec = this.rec;
    let best = 0;
    for (let i = 0, o = 0; i < this.count; i++, o += CraterClass.STRIDE) {
      const dx = px - rec[o]!;
      const dy = py - rec[o + 1]!;
      const dz = pz - rec[o + 2]!;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 >= rec[o + 3]!) continue;
      const r = Math.sqrt(d2) * rec[o + 4]!;
      const phi = rec[o + 8]!;
      const v = rockSource ? phi * phi * (1 - smoothstepEdges(1.2, ext, r)) : phi * (1 - smoothstepEdges(1, ext, r));
      if (v > best) best = v;
    }
    return best;
  }
}

export function makeRecord(p: CraterParams, k: number, cx: number, cy: number, cz: number, D: number, phi: number): CraterRecord {
  const depth = D * (p.degradedDepthToDiameter + (p.freshDepthToDiameter - p.degradedDepthToDiameter) * phi);
  const rim = D * p.rimHeightToDiameter * (p.rimDegraded + (1 - p.rimDegraded) * phi);
  const rounding = (p.rimRoundingDegraded + (p.rimRoundingFresh - p.rimRoundingDegraded) * phi) * (depth + rim);
  const reach = (p.extentRadii / 2) * D;
  return { cx, cy, cz, diameter: D, freshness: phi, depth, rim, rounding, reach2: reach * reach, invHalfD: 2 / D, k };
}

/** Crater height profile at normalised radius r (see module comment). */
export function profile(r: number, depth: number, rim: number, rounding: number, ext: number): number {
  const bowl = rim - (depth + rim) * (1 - r * r);
  let ejecta: number;
  if (r <= 0) ejecta = Infinity;
  else {
    const r3 = r * r * r;
    ejecta = (rim / r3) * (1 - smoothstepEdges(ext - 1, ext, r));
  }
  return smoothMin(bowl, ejecta, rounding);
}

/** All crater classes of a field, coarse to fine. */
export class CraterField {
  readonly classes: CraterClass[] = [];

  constructor(readonly p: CraterParams) {
    for (let k = 0; ; k++) {
      const c = new CraterClass(k, p);
      if (c.dLo > p.maxDiameter) break;
      this.classes.push(c);
    }
    this.classes.reverse();
  }

  /**
   * Add the craters at P to out[b] for each band limit b. `log2MaxD` = log2 of the largest diameter the data
   * leaves to procedural craters at the point (craterMaxDiameterInPostings postings of the effective level);
   * classes with D_lo >= 2^skipAboveLog2 are omitted (used to split bands). Canonical order: coarse to fine.
   */
  add(px: number, py: number, pz: number, log2MaxD: number, log2Lambdas: Float64Array, n: number, out: Float64Array, skipAboveLog2: number): void {
    const ext = this.p.extentRadii;
    const cls = this.classes;
    for (let ci = 0; ci < cls.length; ci++) {
      const c = cls[ci]!;
      if (c.log2DLo >= skipAboveLog2) continue;
      const wE = smootherstep01(log2MaxD - c.log2DHi);
      if (wE === 0) continue;
      let any = false;
      for (let b = 0; b < n; b++) if (c.log2DLo > log2Lambdas[b]!) any = true;
      if (!any) break;
      const h = c.heightAt(px, py, pz, ext);
      if (h === 0) continue;
      for (let b = 0; b < n; b++) {
        const w = wE * smootherstep01(c.log2DLo - log2Lambdas[b]!);
        out[b] = out[b]! + w * h;
      }
    }
  }

  /** Material freshness at P from classes with log2 D_lo in [minLog2, maxLog2). */
  freshness(px: number, py: number, pz: number, log2MaxD: number, minLog2: number, maxLog2: number): number {
    const ext = this.p.extentRadii;
    let best = 0;
    for (const c of this.classes) {
      if (c.log2DLo >= maxLog2 || c.log2DLo < minLog2) continue;
      const wE = smootherstep01(log2MaxD - c.log2DHi);
      if (wE === 0) continue;
      const v = wE * c.freshnessAt(px, py, pz, ext, false);
      if (v > best) best = v;
    }
    return best;
  }

  /** Fresh-ejecta proximity (0..1) of craters of diameter >= minDiameter: drives rock abundance. */
  rockSource(px: number, py: number, pz: number, log2MaxD: number, minDiameter: number): number {
    const ext = this.p.extentRadii;
    let best = 0;
    for (const c of this.classes) {
      if (c.dHi < minDiameter) continue;
      const wE = smootherstep01(log2MaxD - c.log2DHi);
      if (wE === 0) continue;
      const v = wE * c.freshnessAt(px, py, pz, ext, true);
      if (v > best) best = v;
    }
    return best;
  }

  /** Largest fresh crater depth + rim of class c (bound for tile ranges and the morph test). */
  static reliefBound(p: CraterParams, dHi: number): number {
    return dHi * (p.freshDepthToDiameter + p.rimHeightToDiameter);
  }

  /**
   * Craters of class `c` that can reach any point of a surface patch, deduplicated, in canonical cell order.
   * `pts` (xyz triples) must sample the patch (and its margin) at no more than half a cell spacing, so every
   * patch point lies within 0.36 cells of a sample and its reachable cells lie in the sample's 3 x 3 x 3 block.
   */
  gather(c: CraterClass, pts: Float64Array, count: number): CraterRecord[] {
    const seen = new Set<string>();
    const cells: [number, number, number][] = [];
    for (let i = 0; i < count; i++) {
      const bx = Math.floor(pts[3 * i]! * c.invCell) | 0;
      const by = Math.floor(pts[3 * i + 1]! * c.invCell) | 0;
      const bz = Math.floor(pts[3 * i + 2]! * c.invCell) | 0;
      for (let dx = -1; dx <= 1; dx++)
        for (let dy = -1; dy <= 1; dy++)
          for (let dz = -1; dz <= 1; dz++) {
            const key = `${bx + dx},${by + dy},${bz + dz}`;
            if (seen.has(key)) continue;
            seen.add(key);
            cells.push([bx + dx, by + dy, bz + dz]);
          }
    }
    cells.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
    const out: CraterRecord[] = [];
    for (const [x, y, z] of cells) c.cellCraters(x, y, z, (r) => out.push(r));
    return out;
  }
}
