/**
 * What keeps a view inside the fixed tile pools and the ground under a vessel at full depth (requests
 * app-integration-6 and -7): one warp cap per observer, the ground speed that feeds it, the live demand of
 * the selection and the factor on K that fits it into the pools.
 */
import { describe, expect, it } from 'vitest';
import { capMaxLevel, fitLodScale, GroundSpeed, levelRange, LOD_SCALE_MIN, lodK, morphWindow, POOL_HIGH, POOL_LOW, POOL_TARGET, SPEED_RISE_LEVELS, SPEED_WINDOW_SECONDS, warpLevelCap } from '@/render/terrain/lod';
import { BodyQuadtree, TILE_EMPTY, type LodObserverFixed, type SelectParams } from '@/render/terrain/quadtree';
import { converge, countCracks, makeReady, observer, R, type Sim } from './cdlodTwin';

const DT = 1 / 60;

function params(observers: LodObserverFixed[], K: number, maxLevel: number, cap = maxLevel + 1): SelectParams {
  return { frameIndex: 0, time: 0, observers, K, window: morphWindow(K), cap, maxLevel, frustum: null, occluderRadius: 0, fadeSeconds: 0, prefetch: 0 };
}

describe('ground speed of an observer', () => {
  const run = (g: GroundSpeed, speed: number, seconds: number): number => {
    let v = g.speed;
    for (let t = 0; t < seconds - 1e-9; t += DT) v = g.update(speed * DT, DT);
    return v;
  };

  it('follows a steady flight and rises smoothly when the warp goes up', () => {
    const g = new GroundSpeed();
    expect(run(g, 7400, 3)).toBe(7400);
    // Warp x 1000: the cap falls level by level, SPEED_RISE_LEVELS of them a second, so that every level has
    // the frames to fade into its parent; it is there within two seconds.
    const face = (Math.PI * 6371000) / 2;
    let prev = warpLevelCap(face, g.speed, 20);
    let reached = 0;
    let frames = 0;
    for (let t = 0; t < 2; t += DT) {
      const cap = warpLevelCap(face, g.update(7.4e6 * DT, DT), 20);
      expect(prev - cap).toBeLessThanOrEqual(SPEED_RISE_LEVELS * DT + 1e-9);
      expect(cap).toBeLessThanOrEqual(prev + 1e-9);
      if (cap < prev) frames++;
      prev = cap;
      reached = cap;
    }
    expect(reached).toBe(warpLevelCap(face, 7.4e6, 20));
    expect(frames).toBeGreaterThan(60);
    // From rest: no level is capped below SPEED_FLOOR, and orbital speed is reached in under two seconds.
    const h = new GroundSpeed();
    expect(run(h, 7400, 0.2)).toBeLessThan(7400);
    expect(run(h, 7400, 1.8)).toBe(7400);
  });

  it('a camera cut and a single long frame are not flight', () => {
    const g = new GroundSpeed();
    run(g, 0, 1);
    expect(g.update(20e6, DT)).toBe(0);
    expect(g.update(0, DT)).toBe(0);
    run(g, 100, 3);
    const steady = g.speed;
    expect(steady).toBe(100);
    // A hitch of a quarter of a second with a cut in it.
    g.update(1e5, 0.25);
    expect(g.speed).toBeLessThanOrEqual(100);
    expect(g.speed).toBeGreaterThanOrEqual(steady);
  });

  it('the view blend back from the map leaves no trace the moment the camera rests', () => {
    const g = new GroundSpeed();
    // In the map the camera sweeps the turning planet at 1.9 km/s (inertially fixed, 20,000 km up).
    expect(run(g, 1900, 3)).toBe(1900);
    // 0.6 s of blend: 20,000 km in 36 frames, slowing towards the end.
    for (let i = 0; i < 36; i++) g.update((20e6 / 36) * (i < 30 ? 1.15 : 0.25), DT);
    expect(g.speed).toBeGreaterThan(1000);
    // The first frame at rest: the pad camera does not move over the ground.
    expect(g.update(0, DT)).toBe(0);
    const face = (Math.PI * 6371000) / 2;
    expect(warpLevelCap(face, g.speed, 20)).toBe(21);
  });

  it('a speed that falls is taken at once, one that rises only after the window', () => {
    const g = new GroundSpeed();
    run(g, 5000, 2);
    expect(g.update(10 * DT, DT)).toBeCloseTo(10, 6);
    const before = g.speed;
    for (let t = 0; t < SPEED_WINDOW_SECONDS - 2 * DT; t += DT) g.update(5000 * DT, DT);
    // The slow frame is still inside the window.
    expect(g.speed).toBeCloseTo(before, 6);
    run(g, 5000, 3);
    expect(g.speed).toBe(5000);
    g.reset();
    expect(g.speed).toBe(0);
  });
});

describe('one warp cap per observer', () => {
  const K = lodK(1440, (55 * Math.PI) / 180, 8);
  const MAX = 14;

  // A camera 200 km up on the other side of the body, sweeping it (cap 4.4), and a vessel standing still.
  const CAM_CAP = 4.4;
  const camera = (): LodObserverFixed => ({ ...observer(40, 120, 200e3), cap: CAM_CAP });
  const vessel = (): LodObserverFixed => ({ ...observer(5.3, 10.4, 30, 6, true), cap: MAX + 1 });
  /** A lower bound of the distance from an observer to a tile, as the selection's first test has it. */
  const lower = (o: LodObserverFixed, s: { cx: number; cy: number; cz: number; r: number }): number => Math.hypot(s.cx - o.pos.x, s.cy - o.pos.y, s.cz - o.pos.z) - s.r - o.bias;

  it('a vessel standing still keeps its ground at full depth under a camera that sweeps the body', () => {
    const tree = new BodyQuadtree(R, -9130, 10790);
    const cam = camera();
    const ves = vessel();
    const p = params([cam, ves], K, MAX, CAM_CAP);
    const items = converge(tree, p);
    expect(Math.max(...items.map((it) => it.node.level))).toBe(MAX);
    const face = tree.faceSize;
    let underCamera = 0;
    for (const it of items) {
      const n = it.node;
      // Every tile deeper than the camera's cap is there for the vessel: within the range of its level of it.
      if (n.level > capMaxLevel(CAM_CAP, MAX)) expect(lower(ves, n.sphere), `level ${n.level}`).toBeLessThan(levelRange(n.level, K, face));
      // Under the camera the cap holds, although 200 km up asks for more.
      if (lower(cam, n.sphere) < 300e3) {
        expect(n.level).toBeLessThanOrEqual(capMaxLevel(CAM_CAP, MAX));
        underCamera++;
      }
    }
    expect(underCamera).toBeGreaterThan(3);
    const free = new BodyQuadtree(R, -9130, 10790);
    expect(Math.max(...converge(free, params([{ ...cam, cap: MAX + 1 }], K, MAX)).map((it) => it.node.level))).toBeGreaterThan(capMaxLevel(CAM_CAP, MAX) + 1);
    // Near the vessel the tiles are exactly those it would have alone.
    const alone = new BodyQuadtree(R, -9130, 10790);
    const own = converge(alone, params([ves], K, MAX));
    const deep = (list: typeof items): string[] =>
      list
        .filter((it) => it.node.level > capMaxLevel(CAM_CAP, MAX) + 1)
        .map((it) => `${it.node.id}:${it.quadrant}`)
        .sort();
    expect(deep(items).length).toBeGreaterThan(30);
    expect(deep(items)).toEqual(deep(own));
    // The geometry still closes: a fine tile is fully morphed wherever it meets a coarser one.
    const sim: Sim = { observers: [cam, ves], K, window: p.window, faceSize: face };
    const r = countCracks(items, sim);
    expect(r.vertices).toBeGreaterThan(1000);
    expect({ cracks: r.cracks, worst: r.worst }).toEqual({ cracks: 0, worst: 0 });
  });

  it('each drawn tile carries the cap of the observers it is drawn for (its morph floor)', () => {
    const tree = new BodyQuadtree(R, -9130, 10790);
    const cam = camera();
    const ves = vessel();
    const items = converge(tree, params([cam, ves], K, MAX, CAM_CAP));
    const frame = Math.max(...items.map((it) => it.node.capFrame));
    const face = tree.faceSize;
    let forVessel = 0;
    let forCamera = 0;
    for (const it of items) {
      const n = it.node;
      expect(n.capFrame).toBe(frame);
      if (n.level > capMaxLevel(CAM_CAP, MAX)) {
        expect(n.cap).toBe(MAX + 1);
        forVessel++;
      } else if (n.level >= 3 && lower(ves, n.sphere) >= levelRange(n.level, K, face)) {
        // Out of the vessel's range for its level: the camera's tile, with the camera's cap.
        expect(n.cap).toBe(CAM_CAP);
        forCamera++;
      }
    }
    expect(forVessel).toBeGreaterThan(20);
    expect(forCamera).toBeGreaterThan(3);
  });

  it('with one cap for every observer the selection is what it was', () => {
    const a = new BodyQuadtree(R, -9130, 10790);
    const b = new BodyQuadtree(R, -9130, 10790);
    const obs = [observer(5, 10, 60e3), observer(5.3, 10.4, 30, 30, true)];
    const plain = converge(a, params(obs, K, 12, 7.3));
    const withCaps = converge(b, params(obs.map((o) => ({ ...o, cap: 7.3 })), K, 12, 3));
    const key = (list: typeof plain): string[] => list.map((it) => `${it.node.id}:${it.quadrant}`).sort();
    expect(key(withCaps)).toEqual(key(plain));
    expect(Math.max(...plain.map((it) => it.node.level))).toBe(7);
  });
});

describe('live demand on the pools', () => {
  it('a camera selection stamps what it uses, a prefetch pass does not unless it is counted, a deferred tile is not wanted', () => {
    const tree = new BodyQuadtree(R, -9130, 10790);
    const obs = [observer(0, 0, 100e3)];
    const p = params(obs, 2.44, 8);
    const items = converge(tree, p);
    const frame = 900;
    tree.select({ ...p, frameIndex: frame, time: 9000 });
    const used = new Set(items.map((it) => it.node));
    for (const n of used) {
      expect(n.neededFrame).toBe(frame);
      // The parents of what is drawn are needed with it.
      for (let a = n.parent; a; a = a.parent) expect(a.neededFrame).toBe(frame);
    }
    // A request-only pass somewhere else: touched (kept from eviction), not demand.
    const there = [observer(40, 120, 100e3)];
    tree.select({ ...p, observers: there, frameIndex: frame + 1, time: 9010, prefetch: 0.3 });
    expect(tree.wanted.length).toBeGreaterThan(0);
    for (const n of tree.wanted) {
      expect(n.lastTouched).toBe(frame + 1);
      expect(n.neededFrame).toBeLessThan(frame + 1);
    }
    const wanted = tree.wanted.slice();
    tree.wanted.length = 0;
    // The same pass counted (the parked view of the map): demand.
    tree.select({ ...p, observers: there, frameIndex: frame + 2, time: 9020, prefetch: 1, counted: true });
    expect(tree.wanted.map((n) => n.id).sort()).toEqual(wanted.map((n) => n.id).sort());
    for (const n of tree.wanted) expect(n.neededFrame).toBe(frame + 2);
    tree.wanted.length = 0;
    // Given up for want of room: not asked for again before its time.
    const given = wanted[0]!;
    expect(given.state).toBe(TILE_EMPTY);
    given.deferUntil = frame + 100;
    tree.select({ ...p, observers: there, frameIndex: frame + 3, time: 9030, prefetch: 1, counted: true });
    expect(tree.wanted.includes(given)).toBe(false);
    expect(tree.wanted.length).toBe(wanted.length - 1);
    tree.wanted.length = 0;
    tree.select({ ...p, observers: there, frameIndex: frame + 100, time: 9900, prefetch: 1, counted: true });
    expect(tree.wanted.includes(given)).toBe(true);
    for (const n of tree.wanted) makeReady(tree, n);
  });
});

describe('fitting a view into the pools', () => {
  it('leaves the ranges alone inside the band and never grows them past their full size', () => {
    expect(fitLodScale(1, 1, 0.5, DT)).toBe(1);
    expect(fitLodScale(1, 1, POOL_HIGH, DT)).toBe(1);
    expect(fitLodScale(0.8, 0.8, 0.85, DT)).toBe(0.8);
    expect(fitLodScale(0.8, 0.8, POOL_LOW, DT)).toBe(0.8);
    expect(fitLodScale(0.999, 0.999, 0.1, 1)).toBe(1);
  });

  it('shrinks them at once by the square root of the excess, measured at the K in use', () => {
    expect(fitLodScale(1, 1, 1.3, DT)).toBeCloseTo(Math.sqrt(POOL_TARGET / 1.3), 12);
    // K has not caught up yet (it follows smoothly): the demand was measured at 0.9 of the full ranges.
    expect(fitLodScale(0.8, 0.9, 1.0, DT)).toBeCloseTo(0.8, 12);
    expect(fitLodScale(0.8, 0.8, 1.0, DT)).toBeCloseTo(0.8 * Math.sqrt(POOL_TARGET / 1.0), 12);
    expect(fitLodScale(0.45, 0.45, 5, DT)).toBe(LOD_SCALE_MIN);
  });

  it('settles a view that asks for 1.4 pools inside the band in a few steps, and gives the detail back when the view lets go', () => {
    // Demand of a view: a fixed part (pinned levels, coarse tiles) and rings that go with K^2.
    const capacity = 1280;
    const demandAt = (k: number, rings: number): number => (300 + rings * k * k) / capacity;
    let scale = 1;
    let used = 1;
    for (let i = 0; i < 180; i++) {
      scale = fitLodScale(scale, used, demandAt(used, 1500), DT);
      used += (scale - used) * (1 - Math.exp(-DT / 0.25));
    }
    // Three seconds later it rests: inside the band, and it stays there.
    const settled = scale;
    for (let i = 0; i < 600; i++) {
      scale = fitLodScale(scale, used, demandAt(used, 1500), DT);
      used += (scale - used) * (1 - Math.exp(-DT / 0.25));
    }
    expect(scale).toBe(settled);
    expect(demandAt(used, 1500)).toBeLessThanOrEqual(POOL_HIGH);
    expect(demandAt(used, 1500)).toBeGreaterThanOrEqual(POOL_LOW);
    expect(scale).toBeGreaterThan(0.7);
    expect(scale).toBeLessThan(0.85);
    // The view lets go (the vessel has left the pad): back to the full ranges within a few seconds, without overshoot.
    let seconds = 0;
    for (; scale < 1 && seconds < 20; seconds += DT) {
      scale = fitLodScale(scale, used, demandAt(used, 400), DT);
      used += (scale - used) * (1 - Math.exp(-DT / 0.25));
      expect(demandAt(used, 400)).toBeLessThanOrEqual(POOL_HIGH);
    }
    expect(scale).toBe(1);
    expect(seconds).toBeLessThan(3);
  });
});
