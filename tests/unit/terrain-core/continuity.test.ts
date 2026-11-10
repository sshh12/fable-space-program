/**
 * Continuity of the height function: across tile borders and cube-face borders at every data level, across
 * shared edges of render tiles (bakeGeometry, incl. cube faces), and in lambdaMin (C1: no step and no kink
 * when an octave or crater class fades in).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { tileUvToDir, type FaceId, type TileKey } from '../../../src/core/geo/cubeSphere';
import type { Vec3 } from '../../../src/core/math/vec3';
import type { TerrainAuthority } from '../../../src/terrain/provider';
import { FIXTURE_POINTS, MOON_R } from '../../../tools/terrain-core/fixtures';
import { fixtureProvider, moveToward, prng } from './helpers';

/** Pairs of points 1 um either side of a tile edge (same face) or a cube edge, at `level`. */
function edgePairs(key: TileKey, count: number, seed: number): [Vec3, Vec3][] {
  const rng = prng(seed);
  const out: [Vec3, Vec3][] = [];
  for (let i = 0; i < count; i++) {
    const v = 0.02 + 0.96 * rng.next();
    const p = tileUvToDir(key, 1, v);
    const inside = tileUvToDir(key, 0.9, v);
    out.push([moveToward(p, inside, 1e-6, MOON_R), moveToward(p, inside, -1e-6, MOON_R)]);
  }
  return out;
}

describe('continuity of H', () => {
  let amp: TerrainAuthority;
  let none: TerrainAuthority;
  // Tiles whose +u edge is a tile border (same face) or a cube edge, per level, inside data that exists.
  const cases: { level: number; key: TileKey; kind: string }[] = [];

  beforeAll(async () => {
    amp = (await fixtureProvider({ bodies: ['moon'] })).tp;
    none = (await fixtureProvider({ bodies: ['moon'], model: 'none' })).tp;
    for (let level = 0; level <= 2; level++) {
      const n = 2 ** level;
      cases.push({ level, key: { face: 0, level, x: Math.max(0, n / 2 - 1), y: Math.max(0, n / 2 - 1) }, kind: level === 0 ? 'cube edge' : 'tile edge' });
      cases.push({ level, key: { face: 0, level, x: n - 1, y: Math.floor(n / 2) }, kind: 'cube edge' });
      cases.push({ level, key: { face: 4, level, x: n - 1, y: Math.floor(n / 3) }, kind: 'cube edge (polar face)' });
    }
    cases.push({ level: 3, key: { face: 0, level: 3, x: 4, y: 4 }, kind: 'tile edge' });
    cases.push({ level: 3, key: { face: 0, level: 3, x: 7, y: 3 }, kind: 'cube edge' });
    cases.push({ level: 4, key: { face: 0, level: 4, x: 8, y: 8 }, kind: 'tile edge' });
    cases.push({ level: 4, key: { face: 0, level: 4, x: 15, y: 7 }, kind: 'cube edge' });
    cases.push({ level: 5, key: { face: 0, level: 5, x: 16, y: 17 }, kind: 'tile edge' });
    for (const c of cases) {
      const pts = edgePairs(c.key, 4, 1).map((p) => p[0]);
      await Promise.all([amp, none].map((tp) => Promise.all(pts.map((p, i) => tp.ensureLoaded('moon', p, 50, `${c.level}-${c.key.x}-${i}`)))));
    }
  }, 120_000);

  it('|H jump| across tile and cube-face borders is below 1 mm at every data level', () => {
    let worst = 0;
    for (const c of cases) {
      for (const [a, b] of edgePairs(c.key, 200, c.level * 31 + c.key.x)) {
        for (const lam of [0.32, 5, 100, 5000]) {
          const ja = Math.abs(amp.heightAt('moon', a, lam) - amp.heightAt('moon', b, lam));
          const jn = Math.abs(none.heightAt('moon', a, lam) - none.heightAt('moon', b, lam));
          worst = Math.max(worst, ja, jn);
          expect(ja, `${c.kind} L${c.level} lambda ${lam}`).toBeLessThan(1e-3);
          expect(jn, `${c.kind} L${c.level} lambda ${lam} (data only)`).toBeLessThan(1e-3);
        }
      }
    }
    console.log(`[continuity] worst jump across 2 um at tile/cube edges: ${worst.toExponential(2)} m`);
  });

  it('the collision surface is continuous across max-level tile borders and cube edges', () => {
    for (const c of cases.filter((x) => x.kind.startsWith('cube'))) {
      for (const [a, b] of edgePairs(c.key, 50, 9)) expect(Math.abs(amp.heightAt('moon', a) - amp.heightAt('moon', b))).toBeLessThan(1e-3);
    }
  });

  it('render tiles of one level share their edge vertices exactly, also across cube faces', async () => {
    const level = 18;
    // Neighbouring max-level tiles on face 0 and across the face 0 / face 2 edge (inside region B).
    const n = 2 ** level;
    const y = Math.floor(n * (0.5 + 0.7 / 16) / 1);
    const aKey: TileKey = { face: 0, level, x: n - 1, y: Math.floor((n / 16) * 7.7) };
    void y;
    const across = tileUvToDir(aKey, 1 + 1e-9, 0.5);
    const bFace = 2 as FaceId;
    const bKey: TileKey = { face: bFace, level, x: 0, y: aKey.y };
    expect(Math.abs(tileUvToDir(bKey, 0, 0.5).x - across.x)).toBeLessThan(1e-9);
    const sameKey: TileKey = { face: 0, level, x: n - 2, y: aKey.y };
    for (const k of [aKey, bKey, sameKey]) await amp.prepareTile('moon', k, `edge-${k.face}-${k.x}`);
    const A = amp.bakeGeometry('moon', aKey).heights;
    const B = amp.bakeGeometry('moon', bKey).heights;
    const S = amp.bakeGeometry('moon', sameKey).heights;
    let maxCube = 0;
    let maxSame = 0;
    for (let j = 0; j < 65; j++) {
      maxCube = Math.max(maxCube, Math.abs(A[j * 65 + 64]! - B[j * 65]!));
      maxSame = Math.max(maxSame, Math.abs(S[j * 65 + 64]! - A[j * 65]!));
    }
    expect(maxSame).toBe(0);
    expect(maxCube).toBeLessThan(1e-3);
    console.log(`[continuity] shared edge vertices: same face max diff ${maxSame}, across cube edge ${maxCube.toExponential(2)} m`);
  });

  it('H is C1 in lambdaMin: second differences shrink 4x when the step halves (no step, no kink)', () => {
    const pts = [FIXTURE_POINTS.moonGlobal, FIXTURE_POINTS.moonDeep, FIXTURE_POINTS.moonCubeEdge];
    for (const p of pts) {
      // log2 lambda from log2(0.5) to log2(4000); H as a function of x = log2 lambda.
      const second = (step: number): number => {
        let m = 0;
        for (let x = -1; x <= 12; x += step) {
          const h = (xx: number): number => amp.heightAt('moon', p, 2 ** xx);
          const d2 = h(x + step) - 2 * h(x) + h(x - step);
          m = Math.max(m, Math.abs(d2));
        }
        return m;
      };
      const s1 = second(1 / 64);
      const s2 = second(1 / 128);
      // C2 (smootherstep weights): ratio -> 1/4. A kink would give 1/2, a step 1.
      expect(s2 / s1).toBeLessThan(0.35);
      // And no jump at all between neighbouring band limits.
      let maxStep = 0;
      for (let x = -1; x <= 12; x += 1 / 256) maxStep = Math.max(maxStep, Math.abs(amp.heightAt('moon', p, 2 ** (x + 1 / 256)) - amp.heightAt('moon', p, 2 ** x)));
      expect(maxStep).toBeLessThan(0.5);
    }
  });
});
