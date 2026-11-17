/**
 * The UI scrim step (src/render/core/post/scrim.ts, the shader in tonemap.ts): the levels of the bloom chain it
 * reads, the packing of 'ui.scrimRects' in the contract's layout, the coverage of a rounded rectangle, and
 * the shader's declarations against the contract's constants.
 */
import { describe, expect, it } from 'vitest';
import { UI_SCRIM_BYTES, UI_SCRIM_SLOTS } from '@/core/contracts/render';
import { bloomLevelCount } from '@/render/core/post/postProcess';
import { packScrimRects, SCRIM_LEVELS, scrimCoverage, scrimLevelIndices, scrimLevelOf, type UiScrimRect } from '@/render/core/post/scrim';
import { TONEMAP_WGSL } from '@/render/core/post/tonemap';

const rect = (o: Partial<UiScrimRect> = {}): UiScrimRect => ({ x0: 100, y0: 50, x1: 500, y1: 350, cornerRadius: 24, blur: 0.6, dim: 0.5, opacity: 1, ...o });

describe('scrim levels', () => {
  it('are the widest levels of the bloom chain, so a blur is as wide relative to the frame at every resolution', () => {
    // 720p: six levels, all of them. Level l is 1 / 2^(l + 1) of the frame: the widest is 720 / 64 texels high.
    expect(scrimLevelIndices(bloomLevelCount(720))).toEqual([0, 1, 2, 3, 4, 5]);
    // 1440p: seven levels; the scrim reads 1..6, each as wide in the frame as 0..5 at 720p.
    expect(scrimLevelIndices(bloomLevelCount(1440))).toEqual([1, 2, 3, 4, 5, 6]);
    expect(scrimLevelIndices(bloomLevelCount(2160))).toEqual([2, 3, 4, 5, 6, 7]);
    for (const h of [720, 1440, 2880]) {
      const idx = scrimLevelIndices(bloomLevelCount(h));
      // Texels of the widest and of the finest scrim level across the frame height: the same at every height.
      expect(h / 2 ** (idx[SCRIM_LEVELS - 1]! + 1)).toBeCloseTo(720 / 64, 9);
      expect(h / 2 ** (idx[0]! + 1)).toBeCloseTo(360, 9);
    }
  });

  it('repeat the finest level where the chain is shorter than the scrim', () => {
    expect(bloomLevelCount(90)).toBe(3);
    expect(scrimLevelIndices(3)).toEqual([0, 0, 0, 0, 1, 2]);
    expect(scrimLevelIndices(9)).toEqual([3, 4, 5, 6, 7, 8]);
  });

  it('map blur 0..1 onto the levels, clamped', () => {
    expect(scrimLevelOf(0)).toBe(0);
    expect(scrimLevelOf(1)).toBe(SCRIM_LEVELS - 1);
    expect(scrimLevelOf(0.6)).toBeCloseTo(3, 12);
    expect(scrimLevelOf(-2)).toBe(0);
    expect(scrimLevelOf(7)).toBe(SCRIM_LEVELS - 1);
  });
});

describe("the 'ui.scrimRects' buffer", () => {
  it('has the contract layout: a header with the count, then two vec4 per slot', () => {
    const f = packScrimRects([rect(), rect({ x0: 0, y0: 0, x1: 10, y1: 20, cornerRadius: 0, blur: 1, dim: 0.25, opacity: 0.5 })]);
    expect(f.byteLength).toBe(UI_SCRIM_BYTES);
    expect([...f.subarray(0, 4)]).toEqual([2, 0, 0, 0]);
    expect([...f.subarray(4, 12)]).toEqual([100, 50, 500, 350, 24, Math.fround(0.6), 0.5, 1]);
    expect([...f.subarray(12, 20)]).toEqual([0, 0, 10, 20, 0, 1, 0.25, 0.5]);
    expect([...f.subarray(20)].every((x) => x === 0)).toBe(true);
  });

  it('is written whole, so a rectangle that went away leaves nothing behind', () => {
    const f = packScrimRects([rect(), rect(), rect()]);
    packScrimRects([rect({ x0: 1 })], f);
    expect(f[0]).toBe(1);
    expect(f[4]).toBe(1);
    expect([...f.subarray(12)].every((x) => x === 0)).toBe(true);
    packScrimRects([], f);
    expect([...f].every((x) => x === 0)).toBe(true);
  });

  it('refuses more rectangles than the step holds, and a buffer of another size', () => {
    expect(() => packScrimRects(new Array<UiScrimRect>(UI_SCRIM_SLOTS + 1).fill(rect()))).toThrow(/9 rectangles/);
    expect(packScrimRects(new Array<UiScrimRect>(UI_SCRIM_SLOTS).fill(rect()))[0]).toBe(UI_SCRIM_SLOTS);
    expect(() => packScrimRects([rect()], new Float32Array(8))).toThrow(/8 floats/);
  });
});

describe('the coverage of a rounded rectangle', () => {
  const r = rect();
  it('is 1 inside, 0 outside and ramps over one pixel across a straight edge', () => {
    expect(scrimCoverage(r, 300.5, 200.5)).toBe(1);
    expect(scrimCoverage(r, 50.5, 200.5)).toBe(0);
    expect(scrimCoverage(r, 300.5, 400.5)).toBe(0);
    // Pixel centres half a pixel inside and outside the left edge at x = 100: fully in, fully out; on the edge, half.
    expect(scrimCoverage(r, 100.5, 200.5)).toBe(1);
    expect(scrimCoverage(r, 99.5, 200.5)).toBe(0);
    expect(scrimCoverage(r, 100, 200.5)).toBe(0.5);
  });

  it('cuts the corners by the radius', () => {
    // The corner pixel of the bounding box is outside the 24 px arc; the arc's own point on the diagonal is on the edge.
    expect(scrimCoverage(r, 100.5, 50.5)).toBe(0);
    const onArc = 24 - 24 / Math.SQRT2;
    expect(scrimCoverage(r, 100 + onArc, 50 + onArc)).toBeCloseTo(0.5, 9);
    expect(scrimCoverage({ ...r, cornerRadius: 0 }, 100.5, 50.5)).toBe(1);
  });

  it('clamps a radius larger than the rectangle and covers nothing for an empty rectangle', () => {
    const pill = rect({ x0: 0, y0: 0, x1: 200, y1: 40, cornerRadius: 1000 });
    expect(scrimCoverage(pill, 100, 20)).toBe(1);
    expect(scrimCoverage(pill, 1, 1)).toBe(0);
    expect(scrimCoverage(pill, 0, 20)).toBeCloseTo(0.5, 9);
    expect(scrimCoverage(rect({ x0: 300, x1: 300 }), 300, 200)).toBe(0);
    expect(scrimCoverage(rect({ x0: 400, x1: 300 }), 350, 200)).toBe(0);
  });
});

describe('the tonemap shader', () => {
  it('declares the scrim uniform with the contract slots and reads SCRIM_LEVELS textures', () => {
    expect(TONEMAP_WGSL).toContain(`rects: array<ScrimRect, ${UI_SCRIM_SLOTS}>`);
    for (let i = 0; i < SCRIM_LEVELS; i++) expect(TONEMAP_WGSL).toContain(`var scrimLevel${i}: texture_2d<f32>`);
    expect(TONEMAP_WGSL).not.toContain(`var scrimLevel${SCRIM_LEVELS}:`);
    // Two vec4f per slot after a vec4f header: the size the contract states.
    expect(16 + UI_SCRIM_SLOTS * 32).toBe(UI_SCRIM_BYTES);
  });

  it('does the scrim only when the header counts a rectangle', () => {
    expect(TONEMAP_WGSL).toMatch(/let scrimCount = min\(u32\(scrim\.header\.x\), \d+u\);\s*if \(scrimCount > 0u\)/);
  });
});
