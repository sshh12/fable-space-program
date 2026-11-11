/**
 * LOD maths, tile geometry, coverage weights and the generated meshes of the terrain renderer.
 */
import { describe, expect, it } from 'vitest';
import type { TileLayerManifest } from '@/core/contracts/terrain';
import { faceStToDir, tileUvToDir, type FaceId, type TileKey } from '@/core/geo/cubeSphere';
import type { Vec3 } from '@/core/math';
import { buildGridMesh } from '@/render/terrain/gridMesh';
import { capMaxLevel, capMorph, fadeMorph, levelRange, lodK, LOD_K_MIN, morphFactor, morphWindow, warpLevelCap } from '@/render/terrain/lod';
import { buildNoiseVolume, NOISE_SIZE } from '@/render/terrain/materials';
import { coverageWeight, imageryLevelAt } from '@/render/terrain/records';
import { buildRockMesh, ROCK_LODS, ROCK_RADIUS_MAX, ROCK_RADIUS_MIN, ROCK_VARIANTS } from '@/render/terrain/rockMesh';
import { angleToFootprint, frameDir, patchBelowHorizon, shellBoundSphere, shellDistance, tileFrame, tileLocalF32 } from '@/render/terrain/tileMath';

const R_EARTH = 6_371_000;

describe('lod', () => {
  it('K follows the internal render height, the field of view and the quad size in pixels', () => {
    expect(lodK(1440, Math.PI / 3, 8)).toBeCloseTo(2.436, 2);
    expect(lodK(720, Math.PI / 3, 8)).toBe(LOD_K_MIN);
    expect(lodK(1440, Math.PI / 3, 4)).toBeCloseTo(2 * lodK(1440, Math.PI / 3, 8), 6);
  });

  it('the morph window keeps the coarser side of every LOD border unmorphed', () => {
    for (const K of [1.25, 1.5, 1.83, 2.44, 4, 16]) {
      const w = morphWindow(K);
      expect(w.m1).toBeLessThanOrEqual(1);
      expect(w.m1).toBeGreaterThan(w.m0);
      // Border points of level l are at most one tile diagonal (1.27 x the mean tile, cube distortion)
      // beyond range(l): on the coarser level, whose range is twice as long, that must be before m0.
      const diag = (Math.SQRT2 * 1.3) / (4 * K);
      expect(0.5 + diag).toBeLessThanOrEqual(w.m0 + 1e-9);
    }
    expect(morphWindow(2.44).m0).toBeCloseTo(0.705, 2);
  });

  it('morph factor: 0 near, 1 from m1 x range on, never for level 0', () => {
    const K = 2.44;
    const face = (Math.PI * R_EARTH) / 2;
    const w = morphWindow(K);
    const range = levelRange(7, K, face);
    expect(range).toBeCloseTo((2 * K * face) / 128, 3);
    expect(morphFactor(7, 0.5 * range, K, face, w)).toBe(0);
    expect(morphFactor(7, w.m1 * range, K, face, w)).toBeCloseTo(1, 9);
    expect(morphFactor(7, 2 * range, K, face, w)).toBe(1);
    expect(morphFactor(0, 1e9, K, face, w)).toBe(0);
    expect(levelRange(0, K, face)).toBe(Infinity);
  });

  it('the warp cap is continuous: the finest allowed level has faded out when it is dropped', () => {
    const face = (Math.PI * R_EARTH) / 2;
    // 7.4 km/s of ground speed in low orbit, 1x .. 1000x warp.
    expect(warpLevelCap(face, 7400, 20)).toBeCloseTo(9.4, 1);
    expect(warpLevelCap(face, 7400 * 50, 20)).toBeCloseTo(3.76, 1);
    expect(warpLevelCap(face, 0, 20)).toBe(21);
    let prevDetail = Infinity;
    for (let speed = 10; speed < 1e7; speed *= 1.01) {
      const cap = warpLevelCap(face, speed, 20);
      const deepest = capMaxLevel(cap, 20);
      // "Detail" = deepest level minus how far it has morphed into its parent: continuous and monotonic.
      const detail = deepest - capMorph(deepest, cap);
      expect(detail).toBeLessThanOrEqual(prevDetail + 1e-9);
      if (prevDetail !== Infinity) expect(prevDetail - detail).toBeLessThan(0.02);
      prevDetail = detail;
      // A level that is no longer allowed would have been fully morphed.
      expect(capMorph(deepest + 1, cap)).toBe(1);
    }
    expect(capMorph(5, 21)).toBe(0);
  });

  it('fade-in: fully morphed at first, relaxed after 0.35 s', () => {
    expect(fadeMorph(0)).toBe(1);
    expect(fadeMorph(0.175)).toBeCloseTo(0.5, 6);
    expect(fadeMorph(0.35)).toBe(0);
    expect(fadeMorph(1)).toBe(0);
  });
});

describe('tile geometry', () => {
  const keys: TileKey[] = [
    { face: 0, level: 0, x: 0, y: 0 },
    { face: 1, level: 3, x: 5, y: 2 },
    { face: 4, level: 9, x: 300, y: 17 },
    { face: 1, level: 12, x: 2977, y: 2822 },
    { face: 0, level: 18, x: 187756, y: 132048 },
    { face: 1, level: 20, x: 762092, y: 722370 },
  ];

  it('the frame reproduces the cube mapping at every (u, v)', () => {
    for (const key of keys) {
      const fr = tileFrame(key);
      for (const [u, v] of [[0, 0], [1, 0], [0.5, 0.5], [0.3, 0.9], [1, 1]] as const) {
        const a = frameDir(fr, u, v);
        const b = tileUvToDir(key, u, v);
        expect(Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)).toBeLessThan(1e-15 * 4);
      }
    }
  });

  it('the float32 vertex formula is exact to micrometres at the finest level and to metres on a whole face', () => {
    for (const key of keys) {
      const fr = tileFrame(key);
      const h0 = 120;
      const size = (Math.PI * R_EARTH) / 2 / 2 ** key.level;
      let worst = 0;
      for (const [u, v, h] of [[0, 0, 100], [1, 1, 140], [0.25, 0.75, 120.5], [0.5, 0.5, 119], [0.015625, 0.984375, 133]] as const) {
        const d = frameDir(fr, u, v);
        const exact = { x: d.x * (R_EARTH + h) - fr.cHat.x * (R_EARTH + h0), y: d.y * (R_EARTH + h) - fr.cHat.y * (R_EARTH + h0), z: d.z * (R_EARTH + h) - fr.cHat.z * (R_EARTH + h0) };
        const f32 = tileLocalF32(fr, u, v, h, R_EARTH, h0);
        worst = Math.max(worst, Math.hypot(exact.x - f32.x, exact.y - f32.y, exact.z - f32.z));
      }
      // Relative error of a few float32 ulps of the tile size, plus the rounding of the height itself.
      expect(worst).toBeLessThan(size * 4e-7 + 2e-5);
    }
  });

  it('millimetre steps of a vertex are resolved at the finest level (no jitter)', () => {
    const key = keys[5]!;
    const fr = tileFrame(key);
    const size = (Math.PI * R_EARTH) / 2 / 2 ** key.level;
    // Move along u by 1 mm: the float32 result moves by 1 mm within a few micrometres.
    const du = 0.001 / size;
    const a = tileLocalF32(fr, 0.4, 0.6, 21.62, R_EARTH, 21.6);
    const b = tileLocalF32(fr, 0.4 + du, 0.6, 21.62, R_EARTH, 21.6);
    expect(Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)).toBeGreaterThan(0.00099);
    expect(Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)).toBeLessThan(0.00101);
  });

  it('shell distance is a lower bound of the distance to every point of the patch, and tight', () => {
    const rng = mulberry(7);
    for (const key of keys.slice(0, 5)) {
      const fr = tileFrame(key);
      const r1 = R_EARTH - 300;
      const r2 = R_EARTH + 2500;
      for (let trial = 0; trial < 60; trial++) {
        const c = frameDir(fr, rng() * 3 - 1, rng() * 3 - 1);
        const size = (Math.PI * R_EARTH) / 2 / 2 ** key.level;
        const alt = (rng() * 4 - 1) * size + (trial % 3) * 2000;
        const rEye = Math.max(R_EARTH - 200, R_EARTH + alt);
        const eye = { x: c.x * rEye, y: c.y * rEye, z: c.z * rEye };
        const d = shellDistance(fr, c, rEye, r1, r2);
        let brute = Infinity;
        const N = 24;
        for (let j = 0; j <= N; j++) {
          for (let i = 0; i <= N; i++) {
            const p = frameDir(fr, i / N, j / N);
            for (const r of [r1, r2, Math.min(r2, Math.max(r1, rEye))]) brute = Math.min(brute, Math.hypot(p.x * r - eye.x, p.y * r - eye.y, p.z * r - eye.z));
          }
        }
        expect(d).toBeLessThanOrEqual(brute + 1e-6);
        // The brute-force grid misses the true nearest point by at most half a grid cell.
        expect(brute - d).toBeLessThan((size / N) * 1.5 + 1e-3);
      }
    }
  });

  it('footprint angle is zero inside and positive outside; the bounding sphere holds the patch', () => {
    const key = keys[2]!;
    const fr = tileFrame(key);
    expect(angleToFootprint(fr, frameDir(fr, 0.2, 0.7))).toBe(0);
    expect(angleToFootprint(fr, frameDir(fr, 1.5, 0.5))).toBeGreaterThan(0);
    const s = shellBoundSphere(fr, R_EARTH - 100, R_EARTH + 3000);
    for (let j = 0; j <= 8; j++) {
      for (let i = 0; i <= 8; i++) {
        const p = frameDir(fr, i / 8, j / 8);
        for (const r of [R_EARTH - 100, R_EARTH + 3000]) expect(Math.hypot(p.x * r - s.cx, p.y * r - s.cy, p.z * r - s.cz)).toBeLessThanOrEqual(s.r);
      }
    }
  });

  it('horizon culling hides the far side and keeps what the eye can see', () => {
    const eyeDir = faceStToDir(0, 0, 0);
    const eye = { x: eyeDir.x * (R_EARTH + 400e3), y: eyeDir.y * (R_EARTH + 400e3), z: eyeDir.z * (R_EARTH + 400e3) };
    const e2 = eye.x * eye.x + eye.y * eye.y + eye.z * eye.z;
    const under = tileFrame({ face: 0, level: 4, x: 8, y: 8 });
    const far = tileFrame({ face: 1, level: 4, x: 8, y: 8 });
    const limb = tileFrame({ face: 2, level: 4, x: 4, y: 8 });
    expect(patchBelowHorizon(under, eye, e2, R_EARTH - 100, R_EARTH + 100)).toBe(false);
    expect(patchBelowHorizon(far, eye, e2, R_EARTH - 100, R_EARTH + 100)).toBe(true);
    // A tile 63-69 degrees from the sub-point is hidden at sea level, but a (hypothetical) 3000 km mountain on it is not.
    expect(patchBelowHorizon(limb, eye, e2, R_EARTH - 100, R_EARTH + 100)).toBe(true);
    expect(patchBelowHorizon(limb, eye, e2, R_EARTH - 100, R_EARTH + 3000e3)).toBe(false);
  });
});

describe('imagery coverage', () => {
  const layer: TileLayerManifest = {
    encoding: 'webp',
    ext: 'webp',
    globalMaxLevel: 2,
    coverage: { '3': [{ face: 0 as FaceId, x0: 2, y0: 2, x1: 5, y1: 5 }], '4': [{ face: 0 as FaceId, x0: 6, y0: 6, x1: 9, y1: 9 }] },
    sources: [],
  };
  const at = (level: number, x: number, y: number): [number, number] => [-1 + (2 * x) / 2 ** level, -1 + (2 * y) / 2 ** level];

  it('the coverage weight is 0 on the boundary, 1 a quarter tile inside, 0 outside', () => {
    const [s, t] = at(3, 2, 3.5);
    expect(coverageWeight(layer, 0, 3, s, t)).toBeCloseTo(0, 6);
    const [s1, t1] = at(3, 2.125, 3.5);
    expect(coverageWeight(layer, 0, 3, s1, t1)).toBeCloseTo(0.5, 6);
    const [s2, t2] = at(3, 2.25, 3.5);
    expect(coverageWeight(layer, 0, 3, s2, t2)).toBeCloseTo(1, 6);
    const [s3, t3] = at(3, 1.9, 3.5);
    expect(coverageWeight(layer, 0, 3, s3, t3)).toBe(0);
    expect(coverageWeight(layer, 0, 2, s3, t3)).toBe(1);
  });

  it('the imagery level rises smoothly from the global level to the regional levels', () => {
    const dirAt = (x3: number, y3: number): Vec3 => faceStToDir(0, ...at(3, x3, y3));
    expect(imageryLevelAt(layer, dirAt(1, 1))).toBe(2);
    expect(imageryLevelAt(layer, dirAt(2.4, 2.4))).toBeCloseTo(3, 6);
    expect(imageryLevelAt(layer, dirAt(4, 4))).toBeCloseTo(4, 6);
    let prev = 2;
    for (let x = 1.9; x <= 4; x += 0.002) {
      const e = imageryLevelAt(layer, dirAt(x, 4));
      expect(e).toBeGreaterThanOrEqual(prev - 1e-9);
      expect(e - prev).toBeLessThan(0.03);
      prev = e;
    }
    expect(prev).toBeCloseTo(4, 6);
  });
});

describe('meshes', () => {
  it('the grid has one diagonal direction, a skirt ring and valid indices', () => {
    for (const quads of [64, 32]) {
      const g = buildGridMesh(quads);
      const n = quads + 1;
      expect(g.vertices.length / 4).toBe(n * n + 4 * n);
      expect(g.surfaceIndexCount).toBe(quads * quads * 6);
      expect(g.indices.length).toBe(quads * quads * 6 + 4 * quads * 6);
      expect(Math.max(...g.indices)).toBe(n * n + 4 * n - 1);
      // Every surface quad: (v00, v10, v11), (v00, v11, v01).
      for (let q = 0; q < quads * quads; q += 97) {
        const o = q * 6;
        const v00 = g.indices[o]!;
        expect([g.indices[o + 1], g.indices[o + 2], g.indices[o + 3], g.indices[o + 4], g.indices[o + 5]]).toEqual([v00 + 1, v00 + n + 1, v00, v00 + n + 1, v00 + n]);
      }
      // Skirt vertices duplicate edge vertices.
      for (let i = n * n; i < g.vertices.length / 4; i++) {
        const x = g.vertices[i * 4]!;
        const y = g.vertices[i * 4 + 1]!;
        expect(g.vertices[i * 4 + 2]).toBe(1);
        expect(x === 0 || y === 0 || x === quads || y === quads).toBe(true);
      }
    }
  });

  it('rock meshes enclose the unit cap, share a silhouette across levels of detail and have unit normals', () => {
    for (let variant = 0; variant < ROCK_VARIANTS; variant++) {
      const counts: number[] = [];
      for (let lod = 0; lod < ROCK_LODS; lod++) {
        const m = buildRockMesh(variant, lod);
        counts.push(m.indices.length / 3);
        for (let i = 0; i < m.vertices.length; i += 6) {
          const r = Math.hypot(m.vertices[i]!, m.vertices[i + 1]!, m.vertices[i + 2]!);
          expect(r).toBeGreaterThanOrEqual(ROCK_RADIUS_MIN - 1e-5);
          expect(r).toBeLessThanOrEqual(ROCK_RADIUS_MAX + 1e-5);
          expect(Math.hypot(m.vertices[i + 3]!, m.vertices[i + 4]!, m.vertices[i + 5]!)).toBeCloseTo(1, 4);
        }
      }
      expect(counts).toEqual([1280, 320, 80]);
    }
  });

  it('the noise volume is periodic, centred and uses its range', () => {
    const v = buildNoiseVolume(1234);
    expect(v.length).toBe(NOISE_SIZE ** 3 * 4);
    let sum = 0;
    let lo = 255;
    let hi = 0;
    for (let i = 3; i < v.length; i += 4) {
      sum += v[i]!;
      lo = Math.min(lo, v[i]!);
      hi = Math.max(hi, v[i]!);
    }
    expect(sum / (v.length / 4)).toBeGreaterThan(120);
    expect(sum / (v.length / 4)).toBeLessThan(135);
    expect(lo).toBeLessThan(40);
    expect(hi).toBeGreaterThan(215);
    // Periodic: the step across the wrap is as small as a step inside.
    const at = (i: number, j: number, k: number): number => v[((k * NOISE_SIZE + j) * NOISE_SIZE + i) * 4 + 3]!;
    let wrap = 0;
    let inside = 0;
    for (let j = 0; j < NOISE_SIZE; j++) {
      for (let k = 0; k < NOISE_SIZE; k++) {
        wrap = Math.max(wrap, Math.abs(at(NOISE_SIZE - 1, j, k) - at(0, j, k)));
        inside = Math.max(inside, Math.abs(at(31, j, k) - at(32, j, k)));
      }
    }
    expect(wrap).toBeLessThanOrEqual(inside * 1.5 + 4);
  });
});

function mulberry(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
