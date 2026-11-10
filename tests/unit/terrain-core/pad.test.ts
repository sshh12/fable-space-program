/**
 * Launch-pad flattening (flattenDisc derived from LaunchSiteDef): flat for physics and rendering, smooth
 * blend to natural terrain, 'terrain' elevation sampled from final data, numeric elevation respected.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { dirToTile } from '../../../src/core/geo/cubeSphere';
import type { TerrainAuthority } from '../../../src/terrain/provider';
import { EARTH_R, FIXTURE_POINTS } from '../../../tools/terrain-core/fixtures';
import { fixtureProvider, offset, prng } from './helpers';

const pad = FIXTURE_POINTS.padDir;

describe('launch pad', () => {
  let tp: TerrainAuthority;
  let elevation: number;

  beforeAll(async () => {
    tp = (await fixtureProvider({ bodies: ['earth'] })).tp;
    await tp.ensureLoaded('earth', pad, 1500, 'pad');
    // 'terrain' = the natural data height at the centre (final data, no procedural detail).
    const natural = (await fixtureProvider({ bodies: ['earth'], model: 'none' })).tp;
    await natural.ensureLoaded('earth', pad, 10, 'pad');
    elevation = tp.heightAt('earth', pad, 1);
    expect(elevation).toBeCloseTo(natural.heightParts('earth', pad, 1e-3).data, 9);
    // The collision surface stores Float32 vertices (the baked mesh format).
    expect(Math.abs(tp.heightAt('earth', pad) - elevation)).toBeLessThan(1e-4);
  }, 120_000);

  it('is flat within 5 cm over flatRadius on the collision surface and at every band limit', () => {
    const rng = prng(21);
    let worst = 0;
    for (let i = 0; i < 2000; i++) {
      const r = 445 * Math.sqrt(rng.next());
      const a = rng.range(0, 2 * Math.PI);
      const d = offset(pad, r * Math.cos(a), r * Math.sin(a), EARTH_R);
      for (const lam of [undefined, 0.3, 5, 300]) worst = Math.max(worst, Math.abs(tp.heightAt('earth', d, lam) - elevation));
    }
    console.log(`[pad] max deviation from the pad elevation (${elevation.toFixed(3)} m) inside 445 m: ${worst.toExponential(2)} m`);
    expect(worst).toBeLessThan(0.05);
  });

  it('the baked max-level geometry on the pad is flat too', async () => {
    const key = dirToTile(pad, 20).key;
    await tp.prepareTile('earth', key);
    const g = tp.bakeGeometry('earth', key);
    expect(g.hMax - g.hMin).toBeLessThan(0.05);
    expect(Math.abs(g.hMin - elevation)).toBeLessThan(0.05);
  });

  it('blends smoothly back to natural terrain between flatRadius and blendRadius', () => {
    const smooth = (x: number): number => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));
    for (const az of [0, 1.3, 2.9, 4.4]) {
      for (let r = 450; r <= 900; r += 7) {
        const d = offset(pad, r * Math.cos(az), r * Math.sin(az), EARTH_R);
        const p = tp.heightParts('earth', d, 1);
        // Great-circle distance of the sample from the pad centre.
        const c = d.x * pad.x + d.y * pad.y + d.z * pad.z;
        const dist = EARTH_R * Math.acos(Math.min(1, c));
        const w = 1 - smooth((dist - 450) / 450);
        const nat = p.data + p.amplification;
        expect(p.height).toBeCloseTo(nat + w * (elevation - nat), 4);
      }
      // Beyond blendRadius the surface is natural (amplification present again).
      const d = offset(pad, 960 * Math.cos(az), 960 * Math.sin(az), EARTH_R);
      const parts = tp.heightParts('earth', d, 0.3);
      expect(parts.height).toBeCloseTo(parts.data + parts.amplification, 9);
    }
  });

  it('a numeric pad elevation is used as given', async () => {
    const p = (await fixtureProvider({ bodies: ['earth'], padElevation: 123.5 })).tp;
    await p.ensureLoaded('earth', pad, 600, 'pad');
    expect(p.heightAt('earth', pad)).toBe(123.5);
    expect(p.heightAt('earth', offset(pad, 300, -200, EARTH_R), 2)).toBe(123.5);
  });
});
