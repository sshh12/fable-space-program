/**
 * The near-field uniform (activation by altitude, byte layout), the planet-fixed chart and the CDLOD patch
 * selection (covers the disc out to fadeEnd exactly once, never draws beyond it, and satisfies the
 * crack-free morph condition between neighbouring levels).
 */
import { describe, expect, it } from 'vitest';
import { latLonToDir } from '@/core/geo/cubeSphere';
import { DEG, v3 } from '@/core/math';
import {
  ANCHOR_MAX_DRIFT,
  anchorChart,
  ChartKeeper,
  chartCoords,
  chartDir,
  horizonDistance,
  LOD_RANGE,
  lodRange,
  MORPH_FRACTION,
  nearFieldValue,
  nodeSize,
  packNearField,
  PATCH_CELLS,
  selectPatches,
  type SurfacePatch,
} from '@/render/ocean/nearField';

const R = 6371000;

describe('ocean.nearField uniform', () => {
  it('is active from sea level up to fadeEnd above the sea, and -1 above it or without an ocean', () => {
    expect(nearFieldValue(0, true, 2, 15000, 30000)).toEqual({ bodyIndex: 0, fadeStart: 15000, fadeEnd: 30000 });
    expect(nearFieldValue(1, true, 29999, 15000, 30000).bodyIndex).toBe(1);
    expect(nearFieldValue(1, true, 30000, 15000, 30000).bodyIndex).toBe(1);
    expect(nearFieldValue(1, true, 30001, 15000, 30000).bodyIndex).toBe(-1);
    expect(nearFieldValue(0, true, 400e3, 15000, 30000).bodyIndex).toBe(-1);
    expect(nearFieldValue(0, false, 2, 15000, 30000).bodyIndex).toBe(-1);
    expect(nearFieldValue(-1, true, 2, 15000, 30000).bodyIndex).toBe(-1);
    expect(nearFieldValue(0, true, Number.NaN, 15000, 30000).bodyIndex).toBe(-1);
    // Below sea level (an eye in a wave trough) the near field stays on.
    expect(nearFieldValue(0, true, -0.4, 15000, 30000).bodyIndex).toBe(0);
  });

  it('packs to the 16-byte contract layout: i32 bodyIndex, f32 fadeStart, f32 fadeEnd, f32 reserved', () => {
    const buf = packNearField({ bodyIndex: 2, fadeStart: 15000, fadeEnd: 30000 });
    expect(buf.byteLength).toBe(16);
    expect(new Int32Array(buf, 0, 1)[0]).toBe(2);
    expect(Array.from(new Float32Array(buf, 4, 3))).toEqual([15000, 30000, 0]);
    expect(new Int32Array(packNearField({ bodyIndex: -1, fadeStart: 0, fadeEnd: 0 }), 0, 1)[0]).toBe(-1);
  });
});

describe('ocean chart', () => {
  it('maps plane coordinates and directions both ways, with plane metres = surface metres at the anchor', () => {
    const n = latLonToDir(18.98 * DEG, -155.6 * DEG);
    const c = anchorChart(n, R);
    for (const [x, y] of [
      [0, 0],
      [1, 1],
      [-12345.6, 9876.5],
      [200000, -150000],
    ] as const) {
      const d = chartDir(c, x, y);
      const back = chartCoords(c, d)!;
      expect(back.x).toBeCloseTo(x, 6);
      expect(back.y).toBeCloseTo(y, 6);
    }
    const p = chartDir(c, 1, 0);
    expect(v3.dist(v3.scale(p, R), v3.scale(c.a, R))).toBeCloseTo(1, 6);
    expect(Math.abs(v3.dot(c.e, c.a))).toBeLessThan(1e-12);
    expect(Math.abs(v3.dot(c.f, c.a))).toBeLessThan(1e-12);
    // f points north (towards +Z) wherever the anchor is not at a pole.
    expect(c.f.z).toBeGreaterThan(0);
  });

  it('keeps its anchor while active and within the drift limit, re-anchors otherwise', () => {
    const k = new ChartKeeper();
    const n0 = latLonToDir(8 * DEG, -146 * DEG);
    const a0 = k.update('earth', n0, R, true).a;
    // 300 km away: the cube tile changes, the anchor does not (active, within ANCHOR_MAX_DRIFT).
    const n1 = latLonToDir(8 * DEG, (-146 + 300e3 / R / DEG) * DEG);
    expect(k.update('earth', n1, R, true).a).toEqual(a0);
    const far = latLonToDir(8 * DEG, (-146 + (ANCHOR_MAX_DRIFT + 200e3) / R / DEG) * DEG);
    expect(k.update('earth', far, R, true).a).not.toEqual(a0);
    // Re-activation picks the tile of the nadir: deterministic for a place.
    const k2 = new ChartKeeper();
    expect(k2.update('earth', far, R, false).a).toEqual(k.update('earth', far, R, false).a);
  });
});

function covering(patches: SurfacePatch[], x: number, y: number): SurfacePatch[] {
  return patches.filter((p) => {
    const size = p.cell * PATCH_CELLS;
    return x >= p.x0 && x < p.x0 + size && y >= p.y0 && y < p.y0 + size;
  });
}

describe('ocean CDLOD surface patches', () => {
  const cases = [
    { name: '2 m above the sea', camX: 1234.567, camY: -987.25, camH: 2 },
    { name: '500 m', camX: 40213.1, camY: 1051.9, camH: 500 },
    { name: '10 km', camX: -5000.5, camY: 77777.7, camH: 10000 },
    { name: '25 km', camX: 0, camY: 0, camH: 25000 },
  ];
  for (const c of cases) {
    it(`covers the near-field disc exactly once and nothing beyond fadeEnd (${c.name})`, () => {
      const fadeEnd = 30000;
      const patches = selectPatches({ camX: c.camX, camY: c.camY, camH: c.camH, maxDistance: fadeEnd, waveMargin: 1.5 });
      expect(patches.length).toBeGreaterThan(0);
      expect(patches.length).toBeLessThan(4096);
      const reach = Math.sqrt(Math.max(fadeEnd * fadeEnd - c.camH * c.camH, 0));
      for (let i = 0; i < 3000; i++) {
        const r = reach * Math.sqrt((i + 0.5) / 3000) * 0.999;
        const a = i * 2.39996323;
        const x = c.camX + r * Math.cos(a);
        const y = c.camY + r * Math.sin(a);
        expect(covering(patches, x, y).length).toBe(1);
      }
      for (const p of patches) {
        const size = p.cell * PATCH_CELLS;
        const dx = Math.max(p.x0 - c.camX, 0, c.camX - (p.x0 + size));
        const dy = Math.max(p.y0 - c.camY, 0, c.camY - (p.y0 + size));
        expect(Math.hypot(dx, dy, Math.max(c.camH - 1.5, 0))).toBeLessThanOrEqual(fadeEnd + 1e-6);
        // Patch corners are exact multiples of their cell: the lattice is planet-fixed.
        expect(Math.abs(p.x0 / p.cell - Math.round(p.x0 / p.cell))).toBeLessThan(1e-9);
      }
    });
  }

  it('culls patches beyond the horizon (crests included) and keeps every point that can be seen', () => {
    for (const camH of [2, 3, 60, 500]) {
      const margin = 2.2;
      const all = selectPatches({ camX: 17.5, camY: -3.25, camH, maxDistance: 30000, waveMargin: margin });
      const culled = selectPatches({ camX: 17.5, camY: -3.25, camH, maxDistance: 30000, waveMargin: margin, seaRadius: R });
      const horizon = horizonDistance(camH, margin, R);
      // A crest at the margin height just at the horizon distance is still above the camera's horizon ray.
      expect(horizon).toBeGreaterThan(Math.sqrt(2 * R * camH) + Math.sqrt(2 * R * margin));
      for (let i = 0; i < 3000; i++) {
        const r = Math.min(horizon, 29990) * Math.sqrt((i + 0.5) / 3000) * 0.999;
        const a = i * 2.39996323;
        expect(covering(culled, 17.5 + r * Math.cos(a), -3.25 + r * Math.sin(a)).length).toBe(1);
      }
      for (const p of culled) {
        const size = p.cell * PATCH_CELLS;
        const dx = Math.max(p.x0 - 17.5, 0, 17.5 - (p.x0 + size));
        const dy = Math.max(p.y0 + 3.25, 0, -3.25 - (p.y0 + size));
        expect(Math.hypot(dx, dy)).toBeLessThanOrEqual(horizon);
      }
      if (camH < 20) expect(culled.length).toBeLessThan(all.length);
    }
  });

  it('is crack-free: every level-l vertex lies inside the unmorphed zone of level l + 1 at the level border', () => {
    // The farthest point of a selected level-l node must lie where level l + 1 has not started to morph.
    for (let l = 0; l < 10; l++) {
      const farthest = lodRange(l) + Math.SQRT2 * nodeSize(l);
      const morphStartNext = (1 - MORPH_FRACTION) * lodRange(l + 1);
      expect(farthest).toBeLessThanOrEqual(morphStartNext);
    }
    expect(LOD_RANGE).toBeGreaterThanOrEqual(Math.SQRT2 / (1 - 2 * MORPH_FRACTION));
    // And, measured on a selection: patch levels never jump by more than one between touching patches.
    const patches = selectPatches({ camX: 3.3, camY: 7.7, camH: 30, maxDistance: 30000, waveMargin: 1.5 });
    for (let i = 0; i < 2000; i++) {
      const r = 100 + 25000 * ((i + 0.5) / 2000);
      const a = i * 2.39996323;
      const x = 3.3 + r * Math.cos(a);
      const y = 7.7 + r * Math.sin(a);
      const here = covering(patches, x, y)[0]!;
      const step = here.cell * 0.5;
      for (const [dx, dy] of [
        [step * PATCH_CELLS, 0],
        [0, step * PATCH_CELLS],
      ] as const) {
        const nb = covering(patches, x + dx, y + dy)[0];
        if (nb) expect(Math.abs(nb.level - here.level)).toBeLessThanOrEqual(1);
      }
    }
  });
});
