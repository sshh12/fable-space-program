/**
 * TerrainBaker: geometry and normal/material maps for the renderer's workers.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { dirToTile, tileUvToDir, type TileKey } from '../../../src/core/geo/cubeSphere';
import type { TerrainAuthority } from '../../../src/terrain/provider';
import { EARTH_R, FIXTURE_POINTS, MOON_R } from '../../../tools/terrain-core/fixtures';
import { fixtureProvider, offset } from './helpers';

const decode = (byte: number, scale: number): number => scale * Math.atanh(Math.max(-0.999, Math.min(0.999, (2 * byte) / 255 - 1)));

describe('baker', () => {
  let tp: TerrainAuthority;
  const cases: { body: string; key: TileKey; R: number }[] = [];

  beforeAll(async () => {
    tp = (await fixtureProvider()).tp;
    for (const level of [4, 9, 13, 18]) cases.push({ body: 'moon', key: dirToTile(FIXTURE_POINTS.moonDeep, level).key, R: MOON_R });
    for (const level of [7, 14, 20]) cases.push({ body: 'earth', key: dirToTile(offset(FIXTURE_POINTS.padDir, 2500, 900, EARTH_R), level).key, R: EARTH_R });
    for (const c of cases) await tp.prepareTile(c.body, c.key, `bake-${c.body}-${c.key.level}`);
  }, 120_000);

  it('reports incomplete data when the tile was not prepared', async () => {
    const fresh = (await fixtureProvider({ bodies: ['moon'] })).tp;
    const key = dirToTile(FIXTURE_POINTS.moonDeep, 16).key;
    expect(fresh.bakeGeometry('moon', key).complete).toBe(false);
    await fresh.prepareTile('moon', key);
    expect(fresh.bakeGeometry('moon', key).complete).toBe(true);
    expect(fresh.bakeNormalMaterial('moon', key).complete).toBe(true);
  });

  it('bakeTile equals bakeGeometry + bakeNormalMaterial bit for bit', () => {
    for (const c of cases) {
      const t = tp.bakeTile(c.body, c.key);
      expect(Array.from(t.geometry.heights)).toEqual(Array.from(tp.bakeGeometry(c.body, c.key).heights));
      const nm = tp.bakeNormalMaterial(c.body, c.key);
      expect(t.normalMaterial.slopeScale).toBe(nm.slopeScale);
      expect(Array.from(t.normalMaterial.rgba)).toEqual(Array.from(nm.rgba));
    }
  });

  it('geometry heights equal heightAt at the tile band limit at the vertices', () => {
    for (const c of cases) {
      const g = tp.bakeGeometry(c.body, c.key).heights;
      const lam = (Math.PI * c.R) / 2 / 2 ** c.key.level / 32;
      let worst = 0;
      for (let j = 0; j <= 64; j += 8) for (let i = 0; i <= 64; i += 8) worst = Math.max(worst, Math.abs(g[j * 65 + i]! - tp.heightAt(c.body, tileUvToDir(c.key, i / 64, j / 64), lam)));
      expect(worst, `${c.body} L${c.key.level}`).toBeLessThan(1e-3);
    }
  });

  it('tileBounds contains the baked range', () => {
    for (const c of cases) {
      const g = tp.bakeGeometry(c.body, c.key);
      const b = tp.tileBounds(c.body, c.key);
      expect(b.hMin).toBeLessThanOrEqual(g.hMin);
      expect(b.hMax).toBeGreaterThanOrEqual(g.hMax);
    }
  });

  it('normal map slopes are the directional derivatives of H at the normal band limit', () => {
    for (const c of cases) {
      const nm = tp.bakeNormalMaterial(c.body, c.key);
      const lam = (Math.PI * c.R) / 2 / 2 ** c.key.level / 128;
      let se = 0;
      let ss = 0;
      let n = 0;
      for (let j = 8; j < 256; j += 24) {
        for (let i = 8; i < 256; i += 24) {
          const k = j * 256 + i;
          const su = decode(nm.rgba[4 * k]!, nm.slopeScale);
          // Reference: central difference of H along the texel row (one texel each side).
          const a = tileUvToDir(c.key, (i + 1.5) / 256, (j + 0.5) / 256);
          const b = tileUvToDir(c.key, (i - 0.5) / 256, (j + 0.5) / 256);
          const dist = Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) * c.R;
          const ref = (tp.heightAt(c.body, a, lam) - tp.heightAt(c.body, b, lam)) / dist;
          // Compared in the encoded (tanh) domain the shader reads: steep rock flanks saturate by design.
          const e1 = Math.tanh(su / nm.slopeScale);
          const e2 = Math.tanh(ref / nm.slopeScale);
          se += (e1 - e2) ** 2;
          ss += e2 * e2;
          n++;
        }
      }
      const rel = Math.sqrt(se / Math.max(ss, 1e-12));
      console.log(`[bake] ${c.body} L${c.key.level}: slopeScale ${nm.slopeScale.toFixed(3)}, RMS slope ${Math.sqrt(ss / n).toFixed(4)}, relative RMS error of encoded slopes ${rel.toFixed(3)}`);
      expect(rel, `${c.body} L${c.key.level}`).toBeLessThan(0.08);
    }
  });

  it('AO and material are in range and vary with the terrain', () => {
    for (const c of cases) {
      const nm = tp.bakeNormalMaterial(c.body, c.key);
      let aoMin = 255;
      let aoMax = 0;
      for (let k = 0; k < 256 * 256; k++) {
        aoMin = Math.min(aoMin, nm.rgba[4 * k + 2]!);
        aoMax = Math.max(aoMax, nm.rgba[4 * k + 2]!);
      }
      expect(aoMax).toBeGreaterThan(200);
      expect(aoMin).toBeLessThanOrEqual(aoMax);
    }
  });

  it('normal maps of neighbouring tiles agree along the shared edge: both edge columns match H there', async () => {
    for (const [body, dir, level, R] of [
      ['moon', FIXTURE_POINTS.moonDeep, 16, MOON_R],
      ['earth', offset(FIXTURE_POINTS.padDir, 2500, 900, EARTH_R), 16, EARTH_R],
      ['moon', FIXTURE_POINTS.moonDeep, 11, MOON_R],
    ] as const) {
      const a = dirToTile(dir, level).key;
      const b: TileKey = { ...a, x: a.x + 1 };
      await tp.prepareTile(body, a, 'ea');
      await tp.prepareTile(body, b, 'eb');
      const na = tp.bakeNormalMaterial(body, a);
      const nb = tp.bakeNormalMaterial(body, b);
      const lam = (Math.PI * R) / 2 / 2 ** level / 128;
      // Each tile's texels next to the seam (a's last column, b's first) against the central difference of H at
      // the same texel centres (u slope, encoded domain), and the two tiles' decoded slopes reconstructed at the
      // same points of the seam (midpoint of the two columns) against each other.
      let seA = 0;
      let seB = 0;
      let ss = 0;
      let sd = 0;
      for (let j = 0; j < 256; j += 2) {
        const ref = (key: TileKey, i: number): number => {
          const p = tileUvToDir(key, (i + 1.5) / 256, (j + 0.5) / 256);
          const q = tileUvToDir(key, (i - 0.5) / 256, (j + 0.5) / 256);
          return (tp.heightAt(body, p, lam) - tp.heightAt(body, q, lam)) / (Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z) * R);
        };
        const sa = decode(na.rgba[4 * (j * 256 + 255)]!, na.slopeScale);
        const sb = decode(nb.rgba[4 * (j * 256)]!, nb.slopeScale);
        const ra = ref(a, 255);
        const rb = ref(b, 0);
        seA += (Math.tanh(sa / na.slopeScale) - Math.tanh(ra / na.slopeScale)) ** 2;
        seB += (Math.tanh(sb / nb.slopeScale) - Math.tanh(rb / nb.slopeScale)) ** 2;
        ss += Math.tanh(ra / na.slopeScale) ** 2 + Math.tanh(rb / nb.slopeScale) ** 2;
        // Both tiles' view of the seam midpoint, each corrected by H's own change over the half texel.
        const mid = (ra + rb) / 2;
        sd += (sa + (mid - ra) - (sb + (mid - rb))) ** 2;
      }
      const relA = Math.sqrt(seA / (ss / 2));
      const relB = Math.sqrt(seB / (ss / 2));
      const relSeam = Math.sqrt(sd / ((ss / 2) * (na.slopeScale * nb.slopeScale)));
      console.log(`[bake] seam ${body} L${level}: edge columns vs H ${relA.toFixed(3)} / ${relB.toFixed(3)}, tiles vs each other at the seam ${relSeam.toFixed(3)}`);
      expect(relA).toBeLessThan(0.08);
      expect(relB).toBeLessThan(0.08);
      expect(relSeam).toBeLessThan(0.08);
    }
  });
});
