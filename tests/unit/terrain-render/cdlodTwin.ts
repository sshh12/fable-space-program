/**
 * The float64 twin of the terrain vertex shader on a synthetic body, for tests: a band-limited height
 * function per level, a selection that converges with every wanted tile becoming ready, and the search for
 * boundary vertices that no neighbouring tile shares (cracks).
 */
import type { Vec3 } from '@/core/math';
import { GRID_QUADS, morphFactor, type MorphWindow, type ReliefFloor } from '@/render/terrain/lod';
import { BodyQuadtree, TILE_READY, type DrawItem, type LodObserverFixed, type SelectParams, type TileNode } from '@/render/terrain/quadtree';
import { frameDir, snapDirection } from '@/render/terrain/tileMath';

export const R = 1_737_400;

/** Band-limited synthetic height: every level adds an octave, so heights of a tile and its parent differ. */
export function heightAt(dir: Vec3, level: number): number {
  let h = 2500 * Math.sin(dir.x * 7.3 + dir.y * 3.1) * Math.cos(dir.z * 5.7);
  for (let l = 1; l <= level; l++) {
    const f = 6 * 2 ** l;
    h += (1800 / 2 ** l) * Math.sin(dir.x * f + 1.3 * l) * Math.sin(dir.y * f * 1.13 + 0.7 * l) * Math.cos(dir.z * f * 0.91);
  }
  return h;
}

export function makeReady(tree: BodyQuadtree, n: TileNode): void {
  let lo = Infinity;
  let hi = -Infinity;
  for (let j = 0; j <= 8; j++) {
    for (let i = 0; i <= 8; i++) {
      const h = heightAt(frameDir(n.frame, i / 8, j / 8), n.level);
      lo = Math.min(lo, h);
      hi = Math.max(hi, h);
    }
  }
  // The 9 x 9 sample is not the exact range of the 65 x 65 vertices: widen it by the finest octave.
  const pad = 1800 / 2 ** Math.max(n.level, 1) + 5;
  tree.applyBake(n, lo - pad, hi + pad);
  n.state = TILE_READY;
}

export function observer(latDeg: number, lonDeg: number, altitude: number, bias = 0, vessel = false): LodObserverFixed {
  const la = (latDeg * Math.PI) / 180;
  const lo = (lonDeg * Math.PI) / 180;
  const dir = { x: Math.cos(la) * Math.cos(lo), y: Math.cos(la) * Math.sin(lo), z: Math.sin(la) };
  const r = R + heightAt(dir, 12) + altitude;
  return { pos: { x: dir.x * r, y: dir.y * r, z: dir.z * r }, r, dir, bias, vessel };
}

/** Run the selection until nothing more is wanted (every wanted tile becomes ready at once). */
export function converge(tree: BodyQuadtree, params: SelectParams): DrawItem[] {
  for (const root of tree.roots) makeReady(tree, root);
  let p = params;
  for (let pass = 0; pass < 200; pass++) {
    p = { ...p, frameIndex: p.frameIndex + 1, time: p.time + 10 };
    tree.select(p);
    if (tree.wanted.length === 0) return tree.items.slice();
    for (const n of tree.wanted) makeReady(tree, n);
    tree.wanted.length = 0;
  }
  throw new Error('selection did not converge');
}

export interface Sim {
  observers: LodObserverFixed[];
  K: number;
  window: MorphWindow;
  faceSize: number;
  relief?: ReliefFloor | null;
}

/** Body-fixed position of grid vertex (i, j) of a selected tile after the morph: the float64 twin of terrainVertex. */
export function vertex(n: TileNode, i: number, j: number, sim: Sim): Vec3 {
  const dir0 = frameDir(n.frame, i / GRID_QUADS, j / GRID_QUADS);
  const hc = heightAt(dir0, n.level);
  let d = Infinity;
  for (const o of sim.observers) {
    const rr = R + hc;
    d = Math.min(d, Math.max(0, Math.hypot(dir0.x * rr - o.pos.x, dir0.y * rr - o.pos.y, dir0.z * rr - o.pos.z) - o.bias));
  }
  const k = morphFactor(n.level, d, sim.K, sim.faceSize, sim.window, sim.relief);
  const [slideU, slideV] = snapDirection(n.key.face);
  const si = i + (i % 2) * slideU;
  const sj = j + (j % 2) * slideV;
  const u = (i + (si - i) * k) / GRID_QUADS;
  const v = (j + (sj - j) * k) / GRID_QUADS;
  let h = hc;
  if (n.level > 0 && k > 0) {
    // The snapped vertex is a vertex of the parent tile, with the parent's height.
    const hp = heightAt(frameDir(n.frame, si / GRID_QUADS, sj / GRID_QUADS), n.level - 1);
    h = hc + (hp - hc) * k;
  }
  const dir = frameDir(n.frame, u, v);
  return { x: dir.x * (R + h), y: dir.y * (R + h), z: dir.z * (R + h) };
}

export function boundaryVertices(it: DrawItem, sim: Sim): Vec3[] {
  const half = GRID_QUADS / 2;
  const i0 = it.quadrant < 0 ? 0 : (it.quadrant & 1) * half;
  const j0 = it.quadrant < 0 ? 0 : (it.quadrant >> 1) * half;
  const size = it.quadrant < 0 ? GRID_QUADS : half;
  const out: Vec3[] = [];
  for (let t = 0; t <= size; t++) {
    out.push(vertex(it.node, i0 + t, j0, sim), vertex(it.node, i0 + t, j0 + size, sim));
    if (t > 0 && t < size) out.push(vertex(it.node, i0, j0 + t, sim), vertex(it.node, i0 + size, j0 + t, sim));
  }
  return out;
}

/** Number of boundary vertices that no other tile shares (cracks), and the worst gap to the nearest other vertex. */
export function countCracks(items: DrawItem[], sim: Sim): { cracks: number; vertices: number; worst: number; examples: { item: DrawItem; p: Vec3; gap: number }[] } {
  const examples: { item: DrawItem; p: Vec3; gap: number }[] = [];
  const cell = 0.05;
  const map = new Map<string, { p: Vec3; item: number }[]>();
  const key = (x: number, y: number, z: number): string => `${Math.round(x / cell)},${Math.round(y / cell)},${Math.round(z / cell)}`;
  const all: { p: Vec3; item: number }[] = [];
  items.forEach((it, index) => {
    for (const p of boundaryVertices(it, sim)) {
      const e = { p, item: index };
      all.push(e);
      const k = key(p.x, p.y, p.z);
      let list = map.get(k);
      if (!list) map.set(k, (list = []));
      list.push(e);
    }
  });
  let cracks = 0;
  let worst = 0;
  for (const e of all) {
    let best = Infinity;
    const cx = Math.round(e.p.x / cell);
    const cy = Math.round(e.p.y / cell);
    const cz = Math.round(e.p.z / cell);
    for (let a = -1; a <= 1; a++) {
      for (let b = -1; b <= 1; b++) {
        for (let c = -1; c <= 1; c++) {
          for (const o of map.get(`${cx + a},${cy + b},${cz + c}`) ?? []) {
            if (o.item === e.item) continue;
            best = Math.min(best, Math.hypot(o.p.x - e.p.x, o.p.y - e.p.y, o.p.z - e.p.z));
          }
        }
      }
    }
    if (best > 1e-4) {
      cracks++;
      worst = Math.max(worst, best);
      if (examples.length < 12) examples.push({ item: items[e.item]!, p: e.p, gap: best });
    }
  }
  return { cracks, vertices: all.length, worst, examples };
}
