/**
 * Collision surface = rendered surface; lazy, memoised vertex evaluation; deterministic prewarming; normals
 * and surface kind.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { dirToTile, tileUvToDir, type TileKey } from '../../../src/core/geo/cubeSphere';
import type { Vec3 } from '../../../src/core/math/vec3';
import type { TerrainAuthority } from '../../../src/terrain/provider';
import { EARTH_R, FIXTURE_POINTS, MOON_R } from '../../../tools/terrain-core/fixtures';
import { fixtureProvider, offset, prng } from './helpers';

const SITES: { body: string; dir: Vec3; R: number; name: string }[] = [
  { body: 'moon', dir: FIXTURE_POINTS.moonGlobal, R: MOON_R, name: 'moon global' },
  { body: 'moon', dir: FIXTURE_POINTS.moonDeep, R: MOON_R, name: 'moon deepest region' },
  { body: 'moon', dir: FIXTURE_POINTS.moonCubeEdge, R: MOON_R, name: 'moon cube edge' },
  { body: 'earth', dir: offset(FIXTURE_POINTS.padDir, 3000, 1500, EARTH_R), name: 'earth near pad', R: EARTH_R },
];

describe('collision surface', () => {
  let tp: TerrainAuthority;

  beforeAll(async () => {
    tp = (await fixtureProvider()).tp;
    for (const s of SITES) await tp.ensureLoaded(s.body, s.dir, 400, `site-${s.name}`);
  }, 120_000);

  it('heightAt equals the baked max-level geometry at vertices (< 1 mm) and its bilinear anywhere (< 3 cm)', async () => {
    const rng = prng(5);
    let worstVertex = 0;
    let worstInterior = 0;
    let worstAnalytic = 0;
    for (const s of SITES) {
      const level = s.body === 'moon' ? 18 : 20;
      for (let k = 0; k < 3; k++) {
        const key = dirToTile(offset(s.dir, 40 * k, -25 * k, s.R), level).key;
        await tp.prepareTile(s.body, key, `bake-${s.name}-${k}`);
        const g = tp.bakeGeometry(s.body, key);
        expect(g.complete).toBe(true);
        for (let j = 0; j <= 64; j += 4) {
          for (let i = 0; i <= 64; i += 4) {
            const h = tp.heightAt(s.body, tileUvToDir(key, i / 64, j / 64));
            worstVertex = Math.max(worstVertex, Math.abs(h - g.heights[j * 65 + i]!));
          }
        }
        for (let q = 0; q < 200; q++) {
          const u = rng.next();
          const v = rng.next();
          const gu = u * 64;
          const gv = v * 64;
          const i0 = Math.min(63, Math.floor(gu));
          const j0 = Math.min(63, Math.floor(gv));
          const a = gu - i0;
          const c = gv - j0;
          const H = g.heights;
          const bil = (1 - c) * ((1 - a) * H[j0 * 65 + i0]! + a * H[j0 * 65 + i0 + 1]!) + c * ((1 - a) * H[(j0 + 1) * 65 + i0]! + a * H[(j0 + 1) * 65 + i0 + 1]!);
          const d = tileUvToDir(key, u, v);
          worstInterior = Math.max(worstInterior, Math.abs(tp.heightAt(s.body, d) - bil));
          worstAnalytic = Math.max(worstAnalytic, Math.abs(tp.heightAt(s.body, d) - tp.heightAt(s.body, d, (Math.PI * s.R) / 2 / 2 ** level / 32)));
        }
      }
    }
    console.log(`[collision] vertex max |heightAt - bake| = ${worstVertex} m, interior max |heightAt - bilinear(bake)| = ${worstInterior} m, max |collision - analytic(2 quads)| = ${worstAnalytic.toFixed(4)} m`);
    expect(worstVertex).toBeLessThan(1e-3);
    expect(worstInterior).toBeLessThan(0.03);
  });

  it('the first query in a fresh area evaluates at most 4 vertices and stays well under 0.2 ms', async () => {
    const fresh = (await fixtureProvider({ bodies: ['moon'] })).tp;
    const centre = FIXTURE_POINTS.moonDeep;
    await fresh.ensureLoaded('moon', centre, 3000, 'area');
    const rng = prng(11);
    // Warm the JIT on a separate area first.
    for (let i = 0; i < 300; i++) fresh.heightAt('moon', offset(centre, -2900 + rng.next() * 20, rng.next() * 20, MOON_R));
    let maxEvals = 0;
    const times: number[] = [];
    for (let i = 0; i < 500; i++) {
      const d = offset(centre, rng.range(-2500, 2500), rng.range(-2500, 2500), MOON_R);
      const before = fresh.diagnostics().vertexEvaluations['moon']!;
      const t0 = performance.now();
      fresh.heightAt('moon', d);
      times.push(performance.now() - t0);
      maxEvals = Math.max(maxEvals, fresh.diagnostics().vertexEvaluations['moon']! - before);
    }
    times.sort((a, b) => a - b);
    const p99 = times[Math.floor(times.length * 0.99)]!;
    const max = times[times.length - 1]!;
    console.log(`[collision] fresh query: max ${maxEvals} vertex evaluations, median ${(times[250]! * 1000).toFixed(1)} us, p99 ${(p99 * 1000).toFixed(1)} us, max ${(max * 1000).toFixed(1)} us`);
    expect(maxEvals).toBeLessThanOrEqual(4);
    // Timing budget (0.2 ms per query): asserted on a quiet machine (TERRAIN_PERF=1); wave-1 runs share the
    // CPU with the data bakes, where scheduling preemption dominates the tail (PACKAGE_RULES 16).
    if (process.env['TERRAIN_PERF'] === '1') expect(max).toBeLessThan(0.2);
    // A repeated query evaluates nothing.
    const d = offset(centre, 10, 10, MOON_R);
    fresh.heightAt('moon', d);
    const before = fresh.diagnostics().vertexEvaluations['moon']!;
    fresh.heightAt('moon', d);
    expect(fresh.diagnostics().vertexEvaluations['moon']!).toBe(before);
  });

  it('prewarmCollision is deterministic, nearest first, and reaches 0 remaining', async () => {
    const run = async (): Promise<number[]> => {
      const p = (await fixtureProvider({ bodies: ['moon'] })).tp;
      const c = FIXTURE_POINTS.moonGlobal;
      await p.ensureLoaded('moon', c, 200, 'pw');
      const remaining: number[] = [];
      for (let k = 0; k < 400; k++) {
        const r = p.prewarmCollision('moon', c, 30, 2000);
        remaining.push(r);
        if (r === 0) break;
      }
      // After warming, queries inside the radius evaluate nothing.
      const before = p.diagnostics().vertexEvaluations['moon']!;
      const rng = prng(3);
      for (let i = 0; i < 200; i++) p.heightAt('moon', offset(c, rng.range(-20, 20), rng.range(-20, 20), MOON_R));
      expect(p.diagnostics().vertexEvaluations['moon']!).toBe(before);
      // Nearest first: the centre quad was warmed by the first call.
      return remaining;
    };
    const a = await run();
    const b = await run();
    expect(a).toEqual(b);
    expect(a[a.length - 1]).toBe(0);
    for (let k = 1; k < a.length; k++) expect(a[k]!).toBeLessThan(a[k - 1]!);
    console.log(`[collision] prewarm 30 m: ${a.length} calls of 2000 vertices, remaining ${a.slice(0, 4).join(', ')} ... 0`);
  });

  it('prewarm evaluates the nearest vertices first', async () => {
    const p = (await fixtureProvider({ bodies: ['moon'] })).tp;
    const c = FIXTURE_POINTS.moonDeep;
    await p.ensureLoaded('moon', c, 200, 'pw');
    p.prewarmCollision('moon', c, 50, 300);
    // The 4 vertices around the centre are warm: a centre query costs nothing.
    const before = p.diagnostics().vertexEvaluations['moon']!;
    p.heightAt('moon', c);
    expect(p.diagnostics().vertexEvaluations['moon']!).toBe(before);
    // A point 45 m away is not warm yet.
    p.heightAt('moon', offset(c, 45, 0, MOON_R));
    expect(p.diagnostics().vertexEvaluations['moon']!).toBeGreaterThan(before);
  });

  it('normalAt is the outward normal of the collision surface', () => {
    for (const s of SITES) {
      const n = tp.normalAt(s.body, s.dir, 1);
      expect(Math.hypot(n.x, n.y, n.z)).toBeCloseTo(1, 12);
      const cos = n.x * s.dir.x + n.y * s.dir.y + n.z * s.dir.z;
      expect(cos).toBeGreaterThan(0.5);
      // Consistent with finite differences along one tangent.
      const e = offset(s.dir, 0.5, 0, s.R);
      const w = offset(s.dir, -0.5, 0, s.R);
      const slope = (tp.heightAt(s.body, e) - tp.heightAt(s.body, w)) / 1;
      const tan = { x: e.x - w.x, y: e.y - w.y, z: e.z - w.z };
      const l = Math.hypot(tan.x, tan.y, tan.z);
      const along = (n.x * tan.x + n.y * tan.y + n.z * tan.z) / l;
      expect(along).toBeCloseTo(-slope / Math.sqrt(1 + slope * slope), 1);
    }
    // Flat pad: radial normal.
    const n = tp.normalAt('earth', FIXTURE_POINTS.padDir, 2);
    const d = FIXTURE_POINTS.padDir;
    expect(n.x * d.x + n.y * d.y + n.z * d.z).toBeGreaterThan(1 - 1e-9);
  });

  it('surfaceKind: water where the body has an ocean and the solid surface is below sea level', async () => {
    const sea = offset(FIXTURE_POINTS.padDir, -400e3, -300e3, EARTH_R);
    await tp.ensureLoaded('earth', sea, 10, 'sea');
    expect(tp.heightAt('earth', sea)).toBeLessThan(-1000);
    expect(tp.surfaceKind('earth', sea)).toBe('water');
    expect(tp.surfaceKind('earth', FIXTURE_POINTS.padDir)).toBe('land');
    expect(tp.surfaceKind('moon', FIXTURE_POINTS.moonDeep)).toBe('land');
  });

  it('elevationRange comes from the definition', () => {
    expect(tp.elevationRange('moon')).toEqual({ min: -9130, max: 10790 });
    expect(tp.elevationRange('earth')).toEqual({ min: -10930, max: 8850 });
  });
});

export type { TileKey };
