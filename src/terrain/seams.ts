/**
 * Seam reconciliation of height tiles quantised with different power-of-two scales.
 *
 * Neighbouring height tiles share samples: the edge row/column (vertex-registered, also across cube edges) and
 * the 1-sample borders (= the neighbour's first interior samples, on the same face). The contract lets a tile
 * use a coarser scale than its level's preferred one (`TileLayerManifest.heightScales`), and then the copies
 * of a shared sample differ by up to half a count of the coarser scale, which makes the bicubic surface step
 * along the tile edge (real Earth L11/L12: up to 15 cm).
 *
 * Every lattice position that several tiles store gets ONE canonical value: the value of the storing tile with
 * the coarsest scale (ties: the smallest tile number; equal scales give identical values anyway). It is written
 * into every storing tile, exactly representable there (a multiple of a coarser or equal power of two, offsets
 * being multiples of their scale). The canonical value is a pure function of the tile files, so the surface
 * never depends on load order.
 *
 * A tile's shared samples form 8 bands (4 edge strips without their ends, 4 corner blocks, each 3 samples
 * deep). A band is reconciled once every tile storing one of its positions is resident at the same time; its
 * bit in TileEntry.seamDone then stays set for the life of the entry (later writes only repeat canonical
 * values). The evaluator flags a point incomplete when its bicubic stencil touches a band that is not
 * reconciled yet (seamMaskAt), exactly like a missing tile; load sets include the neighbours (SEAM_CELLS).
 *
 * Band bits: 0 low-u strip (i 0..2, j 3..255), 1 high-u strip (i 256..258), 2 low-v strip (j 0..2, i 3..255),
 * 3 high-v strip (j 256..258), 4 low-u/low-v corner, 5 high-u/low-v, 6 low-u/high-v, 7 high-u/high-v.
 */
import { CUBE_FACES } from '../core/geo/cubeSphere';
import { HEIGHT_TILE_CELLS, HEIGHT_TILE_STORED } from '../core/geo/tileCodec';
import type { LayerRef, TileEntry } from './tileStore';
import { POW2, tileNumber } from './util';

const S = HEIGHT_TILE_STORED;
const C = HEIGHT_TILE_CELLS;
export const SEAM_ALL = 0xff;
/**
 * Distance in samples of the level within which a point may depend on a neighbour tile through the seams
 * (stencil reach 2 + band depth 3, plus diagonal slack); load sets add this many cells per level.
 */
export const SEAM_CELLS = 6;

/** Index ranges [i0, i1] x [j0, j1] of the 8 bands. */
const BAND_I0 = [0, C, 3, 3, 0, C, 0, C];
const BAND_I1 = [2, C + 2, C - 1, C - 1, 2, C + 2, 2, C + 2];
const BAND_J0 = [3, 3, 0, C, 0, 0, C, C];
const BAND_J1 = [C - 1, C - 1, 2, C + 2, 2, 2, C + 2, C + 2];
/** Probe positions per band: their storers are exactly the band's storers (constant along strip interiors). */
const PROBE_I = [0, 1, 2, 129, C, C + 1, C + 2];
const BAND_PROBES: [number, number][][] = [];
for (let b = 0; b < 8; b++) {
  const list: [number, number][] = [];
  for (const i of PROBE_I) for (const j of PROBE_I) if (i >= BAND_I0[b]! && i <= BAND_I1[b]! && j >= BAND_J0[b]! && j <= BAND_J1[b]!) list.push([i, j]);
  BAND_PROBES.push(list);
}

/**
 * Bands touched by the Catmull-Rom stencil at tile-local (u, v) (cells i1 - 1 .. i1 + 2 with
 * i1 = clamp(floor(256 u + 1), 1, 256), as in bicubicSample).
 */
export function seamMaskAt(u: number, v: number): number {
  let i1 = Math.floor(u * C + 1);
  if (i1 < 1) i1 = 1;
  else if (i1 > C) i1 = C;
  let j1 = Math.floor(v * C + 1);
  if (j1 < 1) j1 = 1;
  else if (j1 > C) j1 = C;
  return seamMaskOfRange(i1 - 1, i1 + 2, j1 - 1, j1 + 2);
}

/** Bands touched by the sample index range [c0, c1] x [r0, r1]. */
export function seamMaskOfRange(c0: number, c1: number, r0: number, r1: number): number {
  const lu = c0 <= 2;
  const hu = c1 >= C;
  const lv = r0 <= 2;
  const hv = r1 >= C;
  let m = 0;
  if (lu) m |= 1;
  if (hu) m |= 2;
  if (lv) m |= 4;
  if (hv) m |= 8;
  if (lu && lv) m |= 16;
  if (hu && lv) m |= 32;
  if (lu && hv) m |= 64;
  if (hu && hv) m |= 128;
  return m;
}

export class SeamReconciler {
  // Storers of the current position: tile number, local sample index.
  private readonly sNum = new Float64Array(16);
  private readonly sIdx = new Int32Array(16);
  private readonly sEnt: (TileEntry | undefined)[] = new Array(16).fill(undefined);
  /** Positions rewritten so far (diagnostics). */
  writes = 0;

  constructor(readonly ref: LayerRef) {}

  /** Called by the tile store when a tile of the layer became resident (before its generation bump). */
  onResident(e: TileEntry): void {
    this.tryAll(e);
    const nb = this.neighbours(e);
    for (const t of nb) if (t.seamDone !== SEAM_ALL) this.tryAll(t);
  }

  private tryAll(e: TileEntry): void {
    for (let b = 0; b < 8; b++) {
      const bit = 1 << b;
      if ((e.seamDone & bit) !== 0) continue;
      if (this.reconcileBand(e, b)) e.seamDone |= bit;
    }
  }

  /** Resident tiles (other than e) storing any of e's shared samples. */
  private neighbours(e: TileEntry): TileEntry[] {
    const out: TileEntry[] = [];
    for (let b = 0; b < 8; b++) {
      for (const [i, j] of BAND_PROBES[b]!) {
        const k = this.storers(e, i, j);
        for (let s = 0; s < k; s++) {
          const t = this.sEnt[s];
          if (t && t !== e && t.state === 'resident' && !t.removed && !out.includes(t)) out.push(t);
        }
      }
    }
    return out;
  }

  /** Reconcile band b of e when every storing tile is resident; false (nothing changed) otherwise. */
  private reconcileBand(e: TileEntry, b: number): boolean {
    for (const [i, j] of BAND_PROBES[b]!) {
      const k = this.storers(e, i, j);
      for (let s = 0; s < k; s++) {
        const t = this.sEnt[s];
        if (!t || t.state !== 'resident' || t.removed) return false;
      }
    }
    let complete = true;
    for (let j = BAND_J0[b]!; j <= BAND_J1[b]!; j++) {
      for (let i = BAND_I0[b]!; i <= BAND_I1[b]!; i++) {
        const k = this.storers(e, i, j);
        if (k < 2) continue;
        // Canonical storer: coarsest scale, then smallest tile number.
        let c = -1;
        let ok = true;
        for (let s = 0; s < k; s++) {
          const t = this.sEnt[s];
          if (!t || t.state !== 'resident' || t.removed) {
            ok = false;
            break;
          }
          if (c < 0) c = s;
          else {
            const tc = this.sEnt[c]!;
            if (t.scale > tc.scale || (t.scale === tc.scale && this.sNum[s]! < this.sNum[c]!)) c = s;
          }
        }
        if (!ok) {
          complete = false;
          continue;
        }
        const tc = this.sEnt[c]!;
        const value = tc.offset + tc.scale * tc.q![this.sIdx[c]!]!;
        for (let s = 0; s < k; s++) {
          if (s === c) continue;
          const t = this.sEnt[s]!;
          let q = Math.round((value - t.offset) / t.scale);
          if (q > 32767) q = 32767;
          else if (q < -32768) q = -32768;
          const idx = this.sIdx[s]!;
          if (t.q![idx] !== q) {
            t.q![idx] = q;
            this.writes++;
          }
        }
      }
    }
    return complete;
  }

  /**
   * Tiles of e's level that store e's sample (i, j) (e included), into sNum / sIdx / sEnt; returns the count.
   * Same face: every tile whose bordered 259 x 259 range contains the lattice position (borders reach beyond
   * the face plane's edge as well). Across cube edges: positions on a face boundary line lie on the planes of
   * the adjacent faces too, at their lattice positions.
   */
  private storers(e: TileEntry, i: number, j: number): number {
    const L = e.level;
    const n = POW2[L]!;
    const N = C * n;
    const gi = C * e.x + i - 1;
    const gj = C * e.y + j - 1;
    let k = this.sameFace(L, e.face, gi, gj, 0);
    if (gi === 0 || gi === N || gj === 0 || gj === N) {
      const f = CUBE_FACES[e.face]!;
      const s = -1 + (2 * gi) / N;
      const t = -1 + (2 * gj) / N;
      const cx = f.n[0] + s * f.u[0] + t * f.v[0];
      const cy = f.n[1] + s * f.u[1] + t * f.v[1];
      const cz = f.n[2] + s * f.u[2] + t * f.v[2];
      for (let g = 0; g < 6; g++) {
        if (g === e.face) continue;
        const G = CUBE_FACES[g]!;
        const dn = cx * G.n[0] + cy * G.n[1] + cz * G.n[2];
        if (Math.abs(dn - 1) > 1e-12) continue;
        const ri = (((cx * G.u[0] + cy * G.u[1] + cz * G.u[2]) + 1) * N) / 2;
        const rj = (((cx * G.v[0] + cy * G.v[1] + cz * G.v[2]) + 1) * N) / 2;
        const gi2 = Math.round(ri);
        const gj2 = Math.round(rj);
        if (Math.abs(ri - gi2) > 1e-6 || Math.abs(rj - gj2) > 1e-6) continue;
        k = this.sameFace(L, g, gi2, gj2, k);
      }
    }
    return k;
  }

  private sameFace(L: number, face: number, gi: number, gj: number, k: number): number {
    const n = POW2[L]!;
    const tx0 = Math.max(0, Math.ceil((gi - (S - 2)) / C));
    const tx1 = Math.min(n - 1, Math.floor((gi + 1) / C));
    const ty0 = Math.max(0, Math.ceil((gj - (S - 2)) / C));
    const ty1 = Math.min(n - 1, Math.floor((gj + 1) / C));
    const cov = this.ref.coverage;
    const map = this.ref.maps[L];
    for (let ty = ty0; ty <= ty1; ty++) {
      for (let tx = tx0; tx <= tx1; tx++) {
        if (!cov.has(L, face, tx, ty)) continue;
        if (k >= this.sNum.length) throw new Error('seams: more than 16 tiles share one sample');
        const num = tileNumber(L, face, tx, ty);
        this.sNum[k] = num;
        this.sIdx[k] = (gj - C * ty + 1) * S + (gi - C * tx + 1);
        this.sEnt[k] = map?.get(num);
        k++;
      }
    }
    return k;
  }
}
