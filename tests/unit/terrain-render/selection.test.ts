/**
 * CDLOD selection on a synthetic body: the CPU twin of the vertex shader (float64) is evaluated on the
 * boundary of every selected tile, and every boundary vertex must coincide with a vertex of a neighbour.
 * That is the crack-freedom of the design: a fine tile is fully morphed wherever it meets a coarser one,
 * and the coarser one has not started morphing there.
 */
import { describe, expect, it } from 'vitest';
import type { Vec3 } from '@/core/math';
import { levelRange, lodK, morphWindow } from '@/render/terrain/lod';
import { BodyQuadtree, type LodObserverFixed, type SelectParams } from '@/render/terrain/quadtree';
import { converge, countCracks, makeReady, observer, R, type Sim } from './cdlodTwin';

function params(observers: LodObserverFixed[], K: number, maxLevel: number): SelectParams {
  return { frameIndex: 0, time: 0, observers, K, window: morphWindow(K), cap: maxLevel + 1, maxLevel, frustum: null, occluderRadius: 0, fadeSeconds: 0, prefetch: 0 };
}

describe('CDLOD selection', () => {
  const cases: { name: string; observers: LodObserverFixed[]; K: number; maxLevel: number }[] = [
    { name: 'from 400 km, K at 1440p', observers: [observer(12, 31, 400e3)], K: lodK(1440, Math.PI / 3, 8), maxLevel: 12 },
    { name: 'from 10 km, K at 720p (the smallest K)', observers: [observer(-33, 140, 10e3)], K: lodK(720, Math.PI / 3, 8), maxLevel: 13 },
    { name: 'from 40 m, K at 1080p', observers: [observer(1, 23, 40)], K: lodK(1080, Math.PI / 3, 8), maxLevel: 14 },
    { name: 'near a cube corner and edge', observers: [observer(35.2, 44.9, 3e3)], K: lodK(1440, Math.PI / 3, 8), maxLevel: 12 },
    { name: 'camera high, vessel observer near the ground', observers: [observer(5, 10, 60e3), observer(5.3, 10.4, 30, 30, true)], K: lodK(1440, Math.PI / 3, 8), maxLevel: 13 },
    { name: 'wide field of view (K clamped)', observers: [observer(60, -100, 2e3)], K: lodK(1080, (110 * Math.PI) / 180, 12), maxLevel: 12 },
    { name: 'narrow field of view', observers: [observer(-10, 80, 3000e3)], K: lodK(1440, (4 * Math.PI) / 180, 8), maxLevel: 9 },
  ];
  for (const c of cases) {
    it(`covers the sphere without cracks: ${c.name}`, () => {
      const tree = new BodyQuadtree(R, -9130, 10790);
      const p = params(c.observers, c.K, c.maxLevel);
      const items = converge(tree, p);
      const sim: Sim = { observers: c.observers, K: c.K, window: p.window, faceSize: tree.faceSize };
      const r = countCracks(items, sim);
      const deepest = Math.max(...items.map((it) => it.node.level));
      expect(r.vertices).toBeGreaterThan(1000);
      expect(deepest).toBeGreaterThanOrEqual(4);
      expect({ cracks: r.cracks, worst: r.worst }).toEqual({ cracks: 0, worst: 0 });
    });
  }

  it('selects by the range of each level: a tile is never closer than the range of its children allows', () => {
    const tree = new BodyQuadtree(R, -9130, 10790);
    const obs = [observer(0.7, 23.4, 1500)];
    const K = lodK(1440, Math.PI / 3, 8);
    const p = params(obs, K, 16);
    const items = converge(tree, p);
    tree.select({ ...p, frameIndex: 999, time: 9999 });
    for (const it of items) {
      const n = it.node;
      if (n.level >= 16) continue;
      // A whole tile is drawn only when none of it is within the children's range; a quadrant likewise.
      const region = it.quadrant < 0 ? n : tree.childrenOf(n)[it.quadrant]!;
      const d = tree.distance(region, Infinity);
      expect(d).toBeGreaterThanOrEqual(levelRange(n.level + 1, K, tree.faceSize) - 1e-6);
    }
  });

  it('leaves a missing child to its parent by quadrant and wants it', () => {
    const tree = new BodyQuadtree(R, -9130, 10790);
    for (const root of tree.roots) makeReady(tree, root);
    const obs = [observer(0, 0, 100e3)];
    const p = params(obs, 2.44, 8);
    tree.select({ ...p, frameIndex: 1, time: 10 });
    // Only roots are ready: everything is drawn by level 0, by quadrants where children are wanted.
    expect(tree.items.every((it) => it.node.level === 0)).toBe(true);
    expect(tree.wanted.length).toBeGreaterThan(0);
    expect(tree.wanted.every((n) => n.level === 1)).toBe(true);
    const wantedIds = new Set(tree.wanted.map((n) => n.id));
    for (const root of tree.roots) {
      const kids = tree.childrenOf(root);
      const quadrants = tree.items.filter((it) => it.node === root && it.quadrant >= 0).map((it) => it.quadrant);
      const whole = tree.items.some((it) => it.node === root && it.quadrant < 0);
      for (let q = 0; q < 4; q++) if (wantedIds.has(kids[q]!.id)) expect(whole || quadrants.includes(q)).toBe(true);
    }
  });

  it('a new child waits until its parent has settled, then fades in', () => {
    const tree = new BodyQuadtree(R, -9130, 10790);
    for (const root of tree.roots) makeReady(tree, root);
    const obs = [observer(0, 0, 100e3)];
    const base = { ...params(obs, 2.44, 3), fadeSeconds: 0.35 };
    tree.select({ ...base, frameIndex: 1, time: 0 });
    for (const n of tree.wanted) makeReady(tree, n);
    tree.wanted.length = 0;
    // Level 1 became ready in the same instant its parents (level 0, no fade) were first drawn: usable at once.
    tree.select({ ...base, frameIndex: 2, time: 0.016 });
    const level1 = tree.items.filter((it) => it.node.level === 1);
    expect(level1.length).toBeGreaterThan(0);
    expect(level1.every((it) => it.node.activatedAt === 0.016)).toBe(true);
    for (const n of tree.wanted) makeReady(tree, n);
    tree.wanted.length = 0;
    // Level 2 is ready, but its parents are still fading in: they keep drawing their quadrants.
    tree.select({ ...base, frameIndex: 3, time: 0.032 });
    expect(tree.items.some((it) => it.node.level === 2)).toBe(false);
    expect(tree.fading).toBeGreaterThan(0);
    tree.select({ ...base, frameIndex: 4, time: 0.4 });
    expect(tree.items.some((it) => it.node.level === 2)).toBe(true);
    expect(tree.items.filter((it) => it.node.level === 2).every((it) => it.node.activatedAt === 0.4)).toBe(true);
  });

  it('the warp cap limits the deepest level and the frustum culls what is behind the camera', () => {
    const tree = new BodyQuadtree(R, -9130, 10790);
    const obs = [observer(0, 0, 20e3)];
    const p = params(obs, 2.44, 12);
    const full = converge(tree, p);
    expect(Math.max(...full.map((it) => it.node.level))).toBeGreaterThanOrEqual(9);
    tree.select({ ...p, frameIndex: 500, time: 5000, cap: 6.4 });
    expect(Math.max(...tree.items.map((it) => it.node.level))).toBe(6);
    // A camera looking straight down: tiles on the far side of the body are neither visible nor refined.
    const eye = obs[0]!.pos;
    const down = { x: -obs[0]!.dir.x, y: -obs[0]!.dir.y, z: -obs[0]!.dir.z };
    const side = (ax: Vec3, s: number): Vec3 => {
      const v = { x: down.x + ax.x * s, y: down.y + ax.y * s, z: down.z + ax.z * s };
      const l = Math.hypot(v.x, v.y, v.z);
      return { x: v.x / l, y: v.y / l, z: v.z / l };
    };
    const planes: [Vec3, Vec3, Vec3, Vec3] = [side({ x: 0, y: 1, z: 0 }, -1), side({ x: 0, y: 1, z: 0 }, 1), side({ x: 0, y: 0, z: 1 }, -1), side({ x: 0, y: 0, z: 1 }, 1)];
    tree.select({ ...p, frameIndex: 501, time: 5010, frustum: { eye, planes }, occluderRadius: R - 9130 });
    const visible = tree.items.filter((it) => it.visible);
    expect(visible.length).toBeGreaterThan(0);
    expect(visible.length).toBeLessThan(full.length);
    for (const it of visible) {
      const s = it.node.sphere;
      expect(s.cx * obs[0]!.dir.x + s.cy * obs[0]!.dir.y + s.cz * obs[0]!.dir.z).toBeGreaterThan(0);
    }
    // Horizon culling is conservative: every point that the eye can see over the occluder sphere lies in a
    // tile that is marked visible. Sample directions on a grid around the sub-point.
    const rOcc = R - 9130;
    const horizon = Math.acos(rOcc / obs[0]!.r);
    const visibleNodes = new Set(visible.map((it) => (it.quadrant < 0 ? it.node : tree.childrenOf(it.node)[it.quadrant]!)));
    let checked = 0;
    for (const it of tree.items) {
      const region = it.quadrant < 0 ? it.node : tree.childrenOf(it.node)[it.quadrant]!;
      const c = region.frame.cHat;
      const angle = Math.acos(Math.min(1, c.x * obs[0]!.dir.x + c.y * obs[0]!.dir.y + c.z * obs[0]!.dir.z));
      // The tile centre at its lowest possible height is above the horizon and inside the view cone.
      const inCone = angle < 0.5 && Math.atan2(Math.sin(angle) * (R + region.hMin), obs[0]!.r - Math.cos(angle) * (R + region.hMin)) < Math.PI / 4.2;
      if (inCone && angle < horizon + Math.acos(rOcc / (R + region.hMin)) - 1e-6) {
        expect(visibleNodes.has(region), `tile L${region.level} at ${angle.toFixed(4)} rad is visible`).toBe(true);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(10);
  });
});
