/**
 * CDLOD selection on a synthetic body: the CPU twin of the vertex shader (float64) is evaluated on the
 * boundary of every selected tile, and every boundary vertex must coincide with a vertex of a neighbour.
 * That is the crack-freedom of the design: a fine tile is fully morphed wherever it meets a coarser one,
 * and the coarser one has not started morphing there.
 */
import { describe, expect, it } from 'vitest';
import { dirToTile } from '@/core/geo/cubeSphere';
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

  it('a step in the frame index is not a cut when the selection is told the frame before it (resetTemporal)', () => {
    const obs = [observer(12, 31, 400e3)];
    const K = lodK(1440, Math.PI / 3, 8);
    const key = (tree: BodyQuadtree): string[] => tree.items.map((it) => `${it.node.key.face}/${it.node.level}/${it.node.key.x}/${it.node.key.y}/${it.quadrant}`);
    /** A view at rest: every tile resident, 200 frames at 60 Hz with fade-ins of 0.35 s. Returns the next frame and time. */
    const settle = (tree: BodyQuadtree): { p: SelectParams; frame: number; time: number } => {
      const p = { ...params(obs, K, 12), fadeSeconds: 0.35 };
      converge(tree, p);
      let frame = 1000;
      let time = 5000;
      for (let i = 0; i < 200; i++) {
        tree.select({ ...p, frameIndex: frame++, time });
        time += 1 / 60;
      }
      expect(tree.fading).toBe(0);
      return { p, frame, time };
    };
    // Untold, a step of 37 frames is a cut: the drawn tiles fade in again, and only level by level (the
    // children of a tile that fades are left to it), so the view is its coarse levels for a while.
    const cut = new BodyQuadtree(R, -9130, 10790);
    const a = settle(cut);
    const before = key(cut);
    const deepest = Math.max(...cut.items.map((it) => it.node.level));
    expect(deepest).toBeGreaterThanOrEqual(4);
    cut.select({ ...a.p, frameIndex: a.frame + 37, time: a.time });
    expect(cut.fading).toBeGreaterThan(0);
    expect(Math.max(...cut.items.map((it) => it.node.level))).toBeLessThan(deepest);
    // Told which frame came before, the selection is what it was and nothing fades; the frame after is an
    // ordinary frame.
    const told = new BodyQuadtree(R, -9130, 10790);
    const b = settle(told);
    expect(key(told)).toEqual(before);
    told.select({ ...b.p, frameIndex: b.frame + 37, time: b.time, resume: b.frame - 1 });
    expect(told.fading).toBe(0);
    expect(key(told)).toEqual(before);
    told.select({ ...b.p, frameIndex: b.frame + 38, time: b.time + 1 / 60 });
    expect(told.fading).toBe(0);
    expect(key(told)).toEqual(before);
  });

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

  it('the relief floor keeps level 3 in the geometry of a distant body, without cracks where it gives way', () => {
    const K = lodK(1440, Math.PI / 3, 8);
    const relief = { level: 3, range: 16 * R };
    // From 20,000 km the whole body is inside the floor's range: every tile is level 3 (without the floor: level 0 and 1).
    {
      const tree = new BodyQuadtree(R, -9130, 10790);
      const obs = [observer(-18, 8, 20_000e3)];
      const p = { ...params(obs, K, 12), relief };
      const items = converge(tree, p);
      expect(items.every((it) => it.node.level === 3 && it.quadrant < 0)).toBe(true);
      expect(items.length).toBe(6 * 64);
      const r = countCracks(items, { observers: obs, K, window: p.window, faceSize: tree.faceSize, relief });
      expect({ cracks: r.cracks, worst: r.worst }).toEqual({ cracks: 0, worst: 0 });
      const plain = new BodyQuadtree(R, -9130, 10790);
      expect(Math.max(...converge(plain, params(obs, K, 12)).map((it) => it.node.level))).toBeLessThanOrEqual(1);
    }
    // From 15 radii up the near side is level 3 and the far side level 2: the border between them morphs shut.
    {
      const tree = new BodyQuadtree(R, -9130, 10790);
      const obs = [observer(40, -70, 15 * R)];
      const p = { ...params(obs, K, 12), relief };
      const items = converge(tree, p);
      const levels = new Set(items.map((it) => it.node.level));
      expect(levels.has(3) && levels.has(2)).toBe(true);
      const r = countCracks(items, { observers: obs, K, window: p.window, faceSize: tree.faceSize, relief });
      expect(r.vertices).toBeGreaterThan(1000);
      expect({ cracks: r.cracks, worst: r.worst }).toEqual({ cracks: 0, worst: 0 });
    }
    // Close to the ground the floor changes nothing.
    {
      const obs = [observer(1, 23, 4000)];
      const withFloor = new BodyQuadtree(R, -9130, 10790);
      const without = new BodyQuadtree(R, -9130, 10790);
      const a = converge(withFloor, { ...params(obs, K, 12), relief });
      const b = converge(without, params(obs, K, 12));
      const near = (items: typeof a): string[] => items.filter((it) => it.node.level >= 5).map((it) => `${it.node.id}:${it.quadrant}`).sort();
      expect(near(a)).toEqual(near(b));
    }
  });

  it('over deep water a tile is in view when the sea surface over it is: the far water sheet is drawn from the same tile', () => {
    const sea = 0;
    const ocean = new BodyQuadtree(R, -9130, 10790, sea);
    const dry = new BodyQuadtree(R, -9130, 10790);
    const eye = observer(3.1, 7.3, 200);
    for (const tree of [ocean, dry]) {
      // The level-9 tile under the camera, its sea bed 5.0 to 5.3 km down.
      const n = tree.ensureNode(dirToTile(eye.dir, 9).key);
      tree.applyBake(n, -5300, -5000);
      // The point of the sea surface straight below the camera.
      const surface = { x: eye.dir.x * R, y: eye.dir.y * R, z: eye.dir.z * R };
      const inside = (b: { cx: number; cy: number; cz: number; r: number }): boolean => Math.hypot(surface.x - b.cx, surface.y - b.cy, surface.z - b.cz) <= b.r;
      // The level-of-detail distance stays the distance to the terrain.
      expect(n.hMax).toBeLessThan(-4900);
      expect(inside(n.sphere)).toBe(false);
      if (tree === ocean) {
        expect(n.cullTop).toBe(sea);
        expect(inside(n.cull)).toBe(true);
      } else {
        expect(n.cullTop).toBe(n.hMax);
        expect(n.cull).toBe(n.sphere);
      }
    }
    // Land above the sea keeps its own bounds.
    const hill = ocean.childrenOf(ocean.roots[0]!)[0]!;
    ocean.applyBake(hill, 20, 900);
    expect(hill.cull).toBe(hill.sphere);
  });

  it('a prefetch pass only requests: tiles around the predicted position are wanted at reduced priority, nothing is drawn or activated', () => {
    const tree = new BodyQuadtree(R, -9130, 10790);
    const here = [observer(0, 0, 30e3)];
    const p = params(here, 2.44, 12);
    const items = converge(tree, p);
    const frame = 1000;
    tree.select({ ...p, frameIndex: frame, time: 10000 });
    expect(tree.wanted.length).toBe(0);
    const drawn = tree.items.length;
    const activated = tree.items.map((it) => it.node.activatedAt);
    // Two seconds ahead at 1.6 km/s: 3.2 km further east, where finer tiles are not loaded yet.
    const ahead = [observer(0, 0.4, 8e3)];
    tree.select({ ...p, frameIndex: frame, time: 10000, observers: ahead, prefetch: 0.3 });
    expect(tree.items.length).toBe(drawn);
    expect(tree.items.map((it) => it.node.activatedAt)).toEqual(activated);
    expect(tree.wanted.length).toBeGreaterThan(0);
    // Requests of the camera pass itself would have priority >= 1 (range / distance); these are scaled down.
    const camera = new BodyQuadtree(R, -9130, 10790);
    for (const root of camera.roots) makeReady(camera, root);
    camera.select({ ...p, frameIndex: 1, time: 10, observers: ahead });
    const direct = Math.max(...camera.wanted.map((n) => n.priority));
    const prefetched = Math.max(...tree.wanted.map((n) => n.priority));
    expect(direct).toBeGreaterThanOrEqual(1);
    expect(prefetched).toBeGreaterThan(0);
    for (const n of tree.wanted) expect(n.lastTouched).toBe(frame);
    expect(items.length).toBeGreaterThan(0);
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
