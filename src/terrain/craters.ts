/**
 * Procedural impact craters on a hash grid in planet-fixed 3-D space (seamless across cube faces).
 *
 * Size classes are half-octaves of diameter: class k holds diameters in [D_k, sqrt(2) D_k) with
 * D_k = minDiameter * 2^(k/2). Placement per class (shellCells.ts): cubic cells of size s; each cell holds
 * `slots` candidates, each present with probability pSlot, at a hashed position; a candidate is accepted in
 * the shell | |c| - R | < SHELL_ALPHA s / 2 and projected radially to the datum sphere. That gives a uniform
 * areal density slots * pSlot * SHELL_ALPHA / s^2, set to the equilibrium size-frequency law
 *     N(>D) = 1.54 * f * D^-2   per m^2   (D in m; f = equilibrium fraction of geometric saturation)
 * integrated over the class; diameters inside a class follow the same law (cumulative slope -2).
 * Every crater that can reach a point lies in the 2 x 2 x 2 block of cells nearest it: a point query visits
 * 8 cells per class.
 *
 * Profile in r = distance / (D/2) (Pike 1977 depth and rim; McGetchin et al. 1973 r^-3 ejecta):
 *   bowl   hb(r) = h_r - (d + h_r) (1 - r^2)        depth d below the pre-impact surface at the centre
 *   ejecta he(r) = h_r r^-3 (1 - smoothstep(e - 1, e, r)),  e = ejecta extent in radii
 *   h(r) = smoothMin(hb, he, rounding)               rim crest rounded more for degraded craters
 * with freshness phi in [0, 1] (phi = u^freshnessExponent, weighted to degraded craters):
 *   d = D (dD_degraded + (dD_fresh - dD_degraded) phi),  h_r = rimHeightToDiameter D (rimDegraded + (1 - rimDegraded) phi).
 * Each class is weighted by the effective data level E (classes fade in below craterMaxDiameterInPostings
 * data postings) and by the band limit lambdaMin (classes fade out as D_k approaches lambdaMin).
 */
import { hashToUnit, hashU32 } from '../core/math/hash';
import { subSeed } from './noise';
import { cellLayout } from './shellCells';
import { SHELL_ALPHA } from './shellCells';
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
}

/** Record layout in the block cache. */
const STRIDE = 10;
const O_CX = 0;
const O_CY = 1;
const O_CZ = 2;
const O_REACH2 = 3;
const O_INVHALF = 4;
const O_DEPTH = 5;
const O_RIM = 6;
const O_ROUND = 7;
const O_FRESH = 8;
const O_DIAM = 9;

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
  /** Maximum reach of a crater of this class, m. */
  readonly reach: number;
  private bx = 0x7fffffff;
  private by = 0;
  private bz = 0;
  private count = 0;
  private readonly rec: Float64Array;

  constructor(
    readonly k: number,
    readonly p: CraterParams,
  ) {
    this.dLo = p.minDiameter * 2 ** (k / 2);
    this.dHi = this.dLo * Math.SQRT2;
    this.log2DLo = Math.log2(this.dLo);
    this.log2DHi = Math.log2(this.dHi);
    this.reach = (p.extentRadii / 2) * this.dHi;
    const c = 1.54 * p.equilibriumFraction;
    this.density = c / (this.dLo * this.dLo) - c / (this.dHi * this.dHi);
    const lay = cellLayout(this.density, this.reach);
    this.cell = lay.cell;
    this.slots = lay.slots;
    this.pSlot = lay.pSlot;
    this.invCell = 1 / this.cell;
    this.shellHalf = (SHELL_ALPHA * this.cell) / 2;
    this.hs = hashU32(subSeed(p.seed, k));
    this.rec = new Float64Array(8 * this.slots * STRIDE);
  }

  /** Decode slot m of cell (ix, iy, iz) (cell hash hc) into out[o..o+STRIDE); false when absent. */
  private decode(hc: number, m: number, ix: number, iy: number, iz: number, out: Float64Array, o: number): boolean {
    const hm = hashU32((hc + Math.imul(m, 0x632be5ab)) >>> 0);
    if (hashToUnit(hm) >= this.pSlot) return false;
    const s = this.cell;
    const x = (ix + hashToUnit(hashU32(hm ^ 0x1))) * s;
    const y = (iy + hashToUnit(hashU32(hm ^ 0x2))) * s;
    const z = (iz + hashToUnit(hashU32(hm ^ 0x3))) * s;
    const len = Math.sqrt(x * x + y * y + z * z);
    const p = this.p;
    const R = p.radius;
    if (Math.abs(len - R) >= this.shellHalf) return false;
    const f = R / len;
    // Diameter from the class power law (cumulative slope -2): D = D_lo / sqrt(1 - F/2), F uniform.
    const D = this.dLo / Math.sqrt(1 - hashToUnit(hashU32(hm ^ 0x4)) / 2);
    const phi = hashToUnit(hashU32(hm ^ 0x5)) ** p.freshnessExponent;
    const depth = D * (p.degradedDepthToDiameter + (p.freshDepthToDiameter - p.degradedDepthToDiameter) * phi);
    const rim = D * p.rimHeightToDiameter * (p.rimDegraded + (1 - p.rimDegraded) * phi);
    const reach = (p.extentRadii / 2) * D;
    out[o + O_CX] = x * f;
    out[o + O_CY] = y * f;
    out[o + O_CZ] = z * f;
    out[o + O_REACH2] = reach * reach;
    out[o + O_INVHALF] = 2 / D;
    out[o + O_DEPTH] = depth;
    out[o + O_RIM] = rim;
    out[o + O_ROUND] = (p.rimRoundingDegraded + (p.rimRoundingFresh - p.rimRoundingDegraded) * phi) * (depth + rim);
    out[o + O_FRESH] = phi;
    out[o + O_DIAM] = D;
    return true;
  }

  private cellHash(ix: number, iy: number, iz: number): number {
    return hashU32((iz ^ hashU32((iy ^ hashU32((ix ^ this.hs) >>> 0)) >>> 0)) >>> 0);
  }

  /** Accepted craters of one cell in slot order (object form, for splatting and tests). */
  cellCraters(ix: number, iy: number, iz: number, out: CraterRecord[]): void {
    const hc = this.cellHash(ix, iy, iz);
    const tmp = new Float64Array(STRIDE);
    for (let m = 0; m < this.slots; m++) {
      if (!this.decode(hc, m, ix, iy, iz, tmp, 0)) continue;
      out.push({
        cx: tmp[O_CX]!,
        cy: tmp[O_CY]!,
        cz: tmp[O_CZ]!,
        reach2: tmp[O_REACH2]!,
        invHalfD: tmp[O_INVHALF]!,
        depth: tmp[O_DEPTH]!,
        rim: tmp[O_RIM]!,
        rounding: tmp[O_ROUND]!,
        freshness: tmp[O_FRESH]!,
        diameter: tmp[O_DIAM]!,
      });
    }
  }

  /** Make the block cache hold the 2 x 2 x 2 cells nearest (px, py, pz) (canonical order dx, dy, dz, slot). */
  private ensureBlock(px: number, py: number, pz: number): void {
    const bx = Math.floor(px * this.invCell - 0.5) | 0;
    const by = Math.floor(py * this.invCell - 0.5) | 0;
    const bz = Math.floor(pz * this.invCell - 0.5) | 0;
    if (bx === this.bx && by === this.by && bz === this.bz) return;
    this.bx = bx;
    this.by = by;
    this.bz = bz;
    let count = 0;
    const rec = this.rec;
    const slots = this.slots;
    for (let dx = 0; dx < 2; dx++) {
      const hx = hashU32(((bx + dx) ^ this.hs) >>> 0);
      for (let dy = 0; dy < 2; dy++) {
        const hy = hashU32(((by + dy) ^ hx) >>> 0);
        for (let dz = 0; dz < 2; dz++) {
          const hc = hashU32(((bz + dz) ^ hy) >>> 0);
          for (let m = 0; m < slots; m++) if (this.decode(hc, m, bx + dx, by + dy, bz + dz, rec, count * STRIDE)) count++;
        }
      }
    }
    this.count = count;
  }

  /** Sum of crater profiles at P (m), in canonical order. */
  heightAt(px: number, py: number, pz: number, ext: number): number {
    this.ensureBlock(px, py, pz);
    const rec = this.rec;
    let sum = 0;
    for (let i = 0, o = 0; i < this.count; i++, o += STRIDE) {
      const dx = px - rec[o]!;
      const dy = py - rec[o + 1]!;
      const dz = pz - rec[o + 2]!;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 >= rec[o + O_REACH2]!) continue;
      sum += profile(Math.sqrt(d2) * rec[o + O_INVHALF]!, rec[o + O_DEPTH]!, rec[o + O_RIM]!, rec[o + O_ROUND]!, ext);
    }
    return sum;
  }

  /**
   * max over craters of freshness * proximity: material weight (interior and ejecta), or with `rockSource`
   * the fresh-ejecta term phi^2 (1 - smoothstep(1.2, e, r)) that drives rock abundance.
   */
  freshnessAt(px: number, py: number, pz: number, ext: number, rockSource: boolean): number {
    this.ensureBlock(px, py, pz);
    const rec = this.rec;
    let best = 0;
    for (let i = 0, o = 0; i < this.count; i++, o += STRIDE) {
      const dx = px - rec[o]!;
      const dy = py - rec[o + 1]!;
      const dz = pz - rec[o + 2]!;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 >= rec[o + O_REACH2]!) continue;
      const r = Math.sqrt(d2) * rec[o + O_INVHALF]!;
      const phi = rec[o + O_FRESH]!;
      const v = rockSource ? phi * phi * (1 - smoothstepEdges(1.2, ext, r)) : phi * (1 - smoothstepEdges(1, ext, r));
      if (v > best) best = v;
    }
    return best;
  }
}

/** Crater height profile at normalised radius r (see module comment). */
export function profile(r: number, depth: number, rim: number, rounding: number, ext: number): number {
  const bowl = rim - (depth + rim) * (1 - r * r);
  if (r <= 0) return bowl;
  const ejecta = (rim / (r * r * r)) * (1 - smoothstepEdges(ext - 1, ext, r));
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
   * classes with log2 D_lo >= skipAboveLog2 are omitted (used to split bands). Canonical order: coarse to fine.
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
      if (c.dHi < minDiameter) break;
      const wE = smootherstep01(log2MaxD - c.log2DHi);
      if (wE === 0) continue;
      const v = wE * c.freshnessAt(px, py, pz, ext, true);
      if (v > best) best = v;
    }
    return best;
  }

  /** Largest fresh crater depth + rim of a class with upper diameter dHi (bounds). */
  static reliefBound(p: CraterParams, dHi: number): number {
    return dHi * (p.freshDepthToDiameter + p.rimHeightToDiameter);
  }
}
