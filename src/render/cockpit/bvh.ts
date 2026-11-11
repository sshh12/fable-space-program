/**
 * Bounding-volume hierarchy over the interior's triangles: built on the CPU (binned SAH), traversed on the
 * CPU (the sun-patch ray cast, unit tests) and on the GPU (the occlusion bake, occlusion.ts), which reads
 * the same flattened arrays.
 *
 * Layout (shared with the WGSL in occlusion.ts):
 *   nodes: 8 words per node: bmin xyz (f32), a (u32), bmax xyz (f32), count (u32). An inner node has
 *          count 0 and its children at a and a + 1; a leaf holds triangles a .. a + count - 1.
 *   tris:  12 floats per triangle: v0 xyz, material index, v1 xyz, 0, v2 xyz, 0.
 */
import type { Vec3 } from '@/core/math';

export const BVH_NODE_WORDS = 8;
export const BVH_TRI_FLOATS = 12;

export interface Bvh {
  nodes: ArrayBuffer;
  nodeCount: number;
  tris: Float32Array<ArrayBuffer>;
  triCount: number;
}

const BINS = 16;
const LEAF = 4;

/**
 * Build over the triangles indices[start .. start + count) of a mesh whose vertex positions are
 * positions[3 i .. 3 i + 2]; `material(i)` gives the material index of vertex i.
 */
export function buildBvh(positions: Float32Array, indices: Uint32Array, start: number, count: number, material: (vertex: number) => number): Bvh {
  const n = Math.floor(count / 3);
  const bmin = new Float32Array(n * 3);
  const bmax = new Float32Array(n * 3);
  const cen = new Float32Array(n * 3);
  for (let t = 0; t < n; t++) {
    for (let k = 0; k < 3; k++) {
      let lo = Infinity;
      let hi = -Infinity;
      for (let j = 0; j < 3; j++) {
        const v = positions[indices[start + t * 3 + j]! * 3 + k]!;
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
      bmin[t * 3 + k] = lo;
      bmax[t * 3 + k] = hi;
      cen[t * 3 + k] = (lo + hi) / 2;
    }
  }
  const order = new Uint32Array(n);
  for (let i = 0; i < n; i++) order[i] = i;
  // Upper bound on nodes for a binary tree with leaves of at least one triangle.
  const maxNodes = Math.max(1, 2 * n);
  const nodeF = new Float32Array(maxNodes * BVH_NODE_WORDS);
  const nodeU = new Uint32Array(nodeF.buffer);
  let nodeCount = 1;
  const setBounds = (node: number, first: number, cnt: number): void => {
    let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    for (let i = first; i < first + cnt; i++) {
      const t = order[i]! * 3;
      if (bmin[t]! < x0) x0 = bmin[t]!;
      if (bmin[t + 1]! < y0) y0 = bmin[t + 1]!;
      if (bmin[t + 2]! < z0) z0 = bmin[t + 2]!;
      if (bmax[t]! > x1) x1 = bmax[t]!;
      if (bmax[t + 1]! > y1) y1 = bmax[t + 1]!;
      if (bmax[t + 2]! > z1) z1 = bmax[t + 2]!;
    }
    const o = node * BVH_NODE_WORDS;
    nodeF[o] = x0;
    nodeF[o + 1] = y0;
    nodeF[o + 2] = z0;
    nodeF[o + 4] = x1;
    nodeF[o + 5] = y1;
    nodeF[o + 6] = z1;
  };
  const area = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): number => {
    const dx = x1 - x0;
    const dy = y1 - y0;
    const dz = z1 - z0;
    return dx < 0 ? 0 : dx * dy + dy * dz + dz * dx;
  };
  const binCount = new Uint32Array(BINS);
  const binB = new Float32Array(BINS * 6);
  const leftA = new Float32Array(BINS);
  const leftN = new Uint32Array(BINS);
  const stack: [number, number, number][] = [[0, 0, n]];
  while (stack.length > 0) {
    const [node, first, cnt] = stack.pop()!;
    setBounds(node, first, cnt);
    const o = node * BVH_NODE_WORDS;
    const makeLeaf = (): void => {
      nodeU[o + 3] = first;
      nodeU[o + 7] = cnt;
    };
    if (cnt <= LEAF) {
      makeLeaf();
      continue;
    }
    // Centroid bounds and the axis of their largest extent.
    let c0x = Infinity, c0y = Infinity, c0z = Infinity, c1x = -Infinity, c1y = -Infinity, c1z = -Infinity;
    for (let i = first; i < first + cnt; i++) {
      const t = order[i]! * 3;
      c0x = Math.min(c0x, cen[t]!);
      c0y = Math.min(c0y, cen[t + 1]!);
      c0z = Math.min(c0z, cen[t + 2]!);
      c1x = Math.max(c1x, cen[t]!);
      c1y = Math.max(c1y, cen[t + 1]!);
      c1z = Math.max(c1z, cen[t + 2]!);
    }
    const ext = [c1x - c0x, c1y - c0y, c1z - c0z];
    const axis = ext[0]! >= ext[1]! && ext[0]! >= ext[2]! ? 0 : ext[1]! >= ext[2]! ? 1 : 2;
    const lo = [c0x, c0y, c0z][axis]!;
    const span = ext[axis]!;
    if (span < 1e-9) {
      makeLeaf();
      continue;
    }
    binCount.fill(0);
    for (let b = 0; b < BINS; b++) {
      binB.set([Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity], b * 6);
    }
    const binOf = (t: number): number => Math.min(BINS - 1, Math.floor(((cen[t * 3 + axis]! - lo) / span) * BINS));
    for (let i = first; i < first + cnt; i++) {
      const t = order[i]!;
      const b = binOf(t);
      binCount[b]!++;
      const q = b * 6;
      for (let k = 0; k < 3; k++) {
        binB[q + k] = Math.min(binB[q + k]!, bmin[t * 3 + k]!);
        binB[q + 3 + k] = Math.max(binB[q + 3 + k]!, bmax[t * 3 + k]!);
      }
    }
    // Sweep: area and count of everything left of each split plane, then right of it.
    let ax0 = Infinity, ay0 = Infinity, az0 = Infinity, ax1 = -Infinity, ay1 = -Infinity, az1 = -Infinity;
    let acc = 0;
    for (let b = 0; b < BINS - 1; b++) {
      const q = b * 6;
      acc += binCount[b]!;
      if (binCount[b]! > 0) {
        ax0 = Math.min(ax0, binB[q]!);
        ay0 = Math.min(ay0, binB[q + 1]!);
        az0 = Math.min(az0, binB[q + 2]!);
        ax1 = Math.max(ax1, binB[q + 3]!);
        ay1 = Math.max(ay1, binB[q + 4]!);
        az1 = Math.max(az1, binB[q + 5]!);
      }
      leftN[b] = acc;
      leftA[b] = area(ax0, ay0, az0, ax1, ay1, az1);
    }
    let bx0 = Infinity, by0 = Infinity, bz0 = Infinity, bx1 = -Infinity, by1 = -Infinity, bz1 = -Infinity;
    let bestCost = Infinity;
    let bestSplit = -1;
    let rightN = 0;
    for (let b = BINS - 1; b > 0; b--) {
      const q = b * 6;
      rightN += binCount[b]!;
      if (binCount[b]! > 0) {
        bx0 = Math.min(bx0, binB[q]!);
        by0 = Math.min(by0, binB[q + 1]!);
        bz0 = Math.min(bz0, binB[q + 2]!);
        bx1 = Math.max(bx1, binB[q + 3]!);
        by1 = Math.max(by1, binB[q + 4]!);
        bz1 = Math.max(bz1, binB[q + 5]!);
      }
      const ln = leftN[b - 1]!;
      if (ln === 0 || rightN === 0) continue;
      const cost = leftA[b - 1]! * ln + area(bx0, by0, bz0, bx1, by1, bz1) * rightN;
      if (cost < bestCost) {
        bestCost = cost;
        bestSplit = b;
      }
    }
    const parentArea = area(nodeF[o]!, nodeF[o + 1]!, nodeF[o + 2]!, nodeF[o + 4]!, nodeF[o + 5]!, nodeF[o + 6]!);
    // Leaf cost: intersecting every triangle; split cost: one traversal step plus the children.
    if (bestSplit < 0 || (cnt <= 16 && bestCost >= parentArea * cnt)) {
      makeLeaf();
      continue;
    }
    // Partition in place.
    let i = first;
    let j = first + cnt - 1;
    while (i <= j) {
      if (binOf(order[i]!) < bestSplit) i++;
      else {
        const tmp = order[i]!;
        order[i] = order[j]!;
        order[j] = tmp;
        j--;
      }
    }
    const leftCount = i - first;
    if (leftCount === 0 || leftCount === cnt) {
      makeLeaf();
      continue;
    }
    const left = nodeCount;
    nodeCount += 2;
    nodeU[o + 3] = left;
    nodeU[o + 7] = 0;
    stack.push([left, first, leftCount], [left + 1, i, cnt - leftCount]);
  }
  const tris = new Float32Array(n * BVH_TRI_FLOATS);
  for (let i = 0; i < n; i++) {
    const t = order[i]!;
    const q = i * BVH_TRI_FLOATS;
    for (let j = 0; j < 3; j++) {
      const v = indices[start + t * 3 + j]!;
      tris[q + j * 4] = positions[v * 3]!;
      tris[q + j * 4 + 1] = positions[v * 3 + 1]!;
      tris[q + j * 4 + 2] = positions[v * 3 + 2]!;
      tris[q + j * 4 + 3] = j === 0 ? material(v) : 0;
    }
  }
  return { nodes: nodeF.buffer.slice(0, nodeCount * BVH_NODE_WORDS * 4), nodeCount, tris, triCount: n };
}

export interface BvhHit {
  t: number;
  /** Triangle index in the BVH's order, its geometric normal (unnormalised orientation of v0 v1 v2) and material. */
  tri: number;
  normal: Vec3;
  material: number;
}

/**
 * Closest (any = false) or any (any = true) hit of the ray o + t d, tMin < t < tMax, against the BVH.
 * d need not be unit length; t is in units of |d|.
 */
export function bvhRay(bvh: Bvh, o: Vec3, d: Vec3, tMin: number, tMax: number, any: boolean): BvhHit | null {
  const nf = new Float32Array(bvh.nodes);
  const nu = new Uint32Array(bvh.nodes);
  const T = bvh.tris;
  const ix = 1 / (Math.abs(d.x) > 1e-30 ? d.x : 1e-30);
  const iy = 1 / (Math.abs(d.y) > 1e-30 ? d.y : 1e-30);
  const iz = 1 / (Math.abs(d.z) > 1e-30 ? d.z : 1e-30);
  let best = tMax;
  let bestTri = -1;
  const stack = new Uint32Array(64);
  let sp = 0;
  stack[sp++] = 0;
  while (sp > 0) {
    const node = stack[--sp]!;
    const q = node * BVH_NODE_WORDS;
    let tx0 = (nf[q]! - o.x) * ix;
    let tx1 = (nf[q + 4]! - o.x) * ix;
    if (tx0 > tx1) [tx0, tx1] = [tx1, tx0];
    let ty0 = (nf[q + 1]! - o.y) * iy;
    let ty1 = (nf[q + 5]! - o.y) * iy;
    if (ty0 > ty1) [ty0, ty1] = [ty1, ty0];
    let tz0 = (nf[q + 2]! - o.z) * iz;
    let tz1 = (nf[q + 6]! - o.z) * iz;
    if (tz0 > tz1) [tz0, tz1] = [tz1, tz0];
    const tn = Math.max(tx0, ty0, tz0, tMin);
    const tf = Math.min(tx1, ty1, tz1, best);
    if (tn > tf) continue;
    const cnt = nu[q + 7]!;
    const a = nu[q + 3]!;
    if (cnt === 0) {
      stack[sp++] = a;
      stack[sp++] = a + 1;
      continue;
    }
    for (let t = a; t < a + cnt; t++) {
      const p = t * BVH_TRI_FLOATS;
      const ax = T[p]!, ay = T[p + 1]!, az = T[p + 2]!;
      const e1x = T[p + 4]! - ax, e1y = T[p + 5]! - ay, e1z = T[p + 6]! - az;
      const e2x = T[p + 8]! - ax, e2y = T[p + 9]! - ay, e2z = T[p + 10]! - az;
      const px = d.y * e2z - d.z * e2y;
      const py = d.z * e2x - d.x * e2z;
      const pz = d.x * e2y - d.y * e2x;
      const det = e1x * px + e1y * py + e1z * pz;
      if (Math.abs(det) < 1e-14) continue;
      const inv = 1 / det;
      const sx = o.x - ax, sy = o.y - ay, sz = o.z - az;
      const u = (sx * px + sy * py + sz * pz) * inv;
      if (u < 0 || u > 1) continue;
      const qx = sy * e1z - sz * e1y;
      const qy = sz * e1x - sx * e1z;
      const qz = sx * e1y - sy * e1x;
      const v = (d.x * qx + d.y * qy + d.z * qz) * inv;
      if (v < 0 || u + v > 1) continue;
      const tt = (e2x * qx + e2y * qy + e2z * qz) * inv;
      if (tt <= tMin || tt >= best) continue;
      best = tt;
      bestTri = t;
      if (any) sp = 0;
    }
  }
  if (bestTri < 0) return null;
  const p = bestTri * BVH_TRI_FLOATS;
  const e1 = { x: T[p + 4]! - T[p]!, y: T[p + 5]! - T[p + 1]!, z: T[p + 6]! - T[p + 2]! };
  const e2 = { x: T[p + 8]! - T[p]!, y: T[p + 9]! - T[p + 1]!, z: T[p + 10]! - T[p + 2]! };
  const normal = { x: e1.y * e2.z - e1.z * e2.y, y: e1.z * e2.x - e1.x * e2.z, z: e1.x * e2.y - e1.y * e2.x };
  return { t: best, tri: bestTri, normal, material: T[p + 3]! };
}
