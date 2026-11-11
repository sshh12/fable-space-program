/**
 * Time the quadtree selection on a synthetic body (no GPU, no tiles): a camera 1.7 m above the ground with
 * the frustum of a 16:9 view, every wanted tile ready.
 *
 *   npx tsx tools/terrain/bench-select.ts [K] [maxLevel]
 */
import { lodK, morphWindow } from '../../src/render/terrain/lod';
import { BodyQuadtree, type SelectParams, type ViewFrustum } from '../../src/render/terrain/quadtree';
import { converge, observer, R } from '../../tests/unit/terrain-render/cdlodTwin';

const K = Number(process.argv[2] ?? lodK(1440, Math.PI / 3, 8));
const maxLevel = Number(process.argv[3] ?? 18);
const tree = new BodyQuadtree(R, -9130, 10790);
const obs = [observer(0.66, 23.43, 1.7)];
const o = obs[0]!;
// Looking along the local east, 6 degrees below the horizontal, 60 degree vertical field of view.
const up = o.dir;
const east = (() => {
  const x = -up.y;
  const y = up.x;
  const l = Math.hypot(x, y);
  return { x: x / l, y: y / l, z: 0 };
})();
const north = { x: up.y * east.z - up.z * east.y, y: up.z * east.x - up.x * east.z, z: up.x * east.y - up.y * east.x };
const pitch = (-6 * Math.PI) / 180;
const f = { x: east.x * Math.cos(pitch) + up.x * Math.sin(pitch), y: east.y * Math.cos(pitch) + up.y * Math.sin(pitch), z: east.z * Math.cos(pitch) + up.z * Math.sin(pitch) };
const r = north;
const u = { x: r.y * f.z - r.z * f.y, y: r.z * f.x - r.x * f.z, z: r.x * f.y - r.y * f.x };
const tanY = Math.tan(Math.PI / 6);
const tanX = (tanY * 16) / 9;
const plane = (a: { x: number; y: number; z: number }, t: number, sign: number): { x: number; y: number; z: number } => {
  const v = { x: f.x * t + a.x * sign, y: f.y * t + a.y * sign, z: f.z * t + a.z * sign };
  const l = Math.hypot(v.x, v.y, v.z);
  return { x: v.x / l, y: v.y / l, z: v.z / l };
};
const frustum: ViewFrustum = { eye: o.pos, planes: [plane(r, tanX, -1), plane(r, tanX, 1), plane(u, tanY, -1), plane(u, tanY, 1)] };
const p: SelectParams = { frameIndex: 0, time: 0, observers: obs, K, window: morphWindow(K), cap: maxLevel + 1, maxLevel, frustum, occluderRadius: R - 9130, fadeSeconds: 0, prefetch: 0 };
const items = converge(tree, p);
let frame = 10_000;
for (let i = 0; i < 200; i++) tree.select({ ...p, frameIndex: frame++, time: frame });
const runs = 2000;
const t0 = performance.now();
for (let i = 0; i < runs; i++) tree.select({ ...p, frameIndex: frame++, time: frame });
const ms = (performance.now() - t0) / runs;
console.log(`K ${K.toFixed(2)}, max level ${maxLevel}: ${items.length} items (${items.filter((it) => it.visible).length} visible), ${tree.nodeCount} nodes; select ${ms.toFixed(3)} ms per frame`);
