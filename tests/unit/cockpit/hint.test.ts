/**
 * What the cockpit tells the exposure meter about the entry sheath in its panes (request cockpit-19): the
 * sheath's luminance through a window from the layout's table, and the share of the frame the panes cover.
 */
import { describe, expect, it } from 'vitest';
import { mat4, quat, v3 } from '@/core/math';
import { loadCockpitLayout } from '@/render/cockpit/layout';
import { frameCoverage, sheathLuminance } from '@/render/cockpit/lighting';
import { testDefs } from './helpers';

describe('cockpit exposure hint for the entry sheath', () => {
  it('the layout carries the sheath table; the luminance follows it and rises with the intensity', async () => {
    const { layout } = loadCockpitLayout(await testDefs(), 'kestrel');
    const t = layout.lighting.sheathHint;
    expect(t.length).toBeGreaterThanOrEqual(2);
    for (const [i, L] of t) expect(sheathLuminance(t, i)).toBeCloseTo(L, 6);
    expect(sheathLuminance(t, 0)).toBe(0);
    expect(sheathLuminance(t, -1)).toBe(0);
    let last = 0;
    for (let i = 0.02; i <= 1.3; i += 0.02) {
      const L = sheathLuminance(t, i);
      expect(L).toBeGreaterThanOrEqual(last);
      last = L;
    }
    // Beyond the table: the last entry.
    expect(sheathLuminance(t, 2)).toBe(t[t.length - 1]![1]);
    // Between two entries: between their luminances.
    const mid = sheathLuminance(t, (t[0]![0] + t[1]![0]) / 2);
    expect(mid).toBeGreaterThan(t[0]![1]);
    expect(mid).toBeLessThan(t[1]![1]);
  });

  it('the share of the frame an outline covers: a square seen head-on, one beside the view, one behind the eye', () => {
    const fov = (60 * Math.PI) / 180;
    const viewProj = mat4.mul(mat4.perspectiveReversedZInfinite(fov, 16 / 9, 0.05), mat4.viewRotation(quat.identity()));
    // The view looks down -Z. A square of side s at distance d covers (s / (2 d tan(fov/2)))^2 / aspect of the frame.
    const square = (cx: number, z: number, s: number) => [v3.new(cx - s / 2, -s / 2, z), v3.new(cx + s / 2, -s / 2, z), v3.new(cx + s / 2, s / 2, z), v3.new(cx - s / 2, s / 2, z)];
    const expected = (0.4 / (2 * 2 * Math.tan(fov / 2))) ** 2 / (16 / 9);
    expect(frameCoverage([square(0, -2, 0.4)], viewProj)).toBeCloseTo(expected, 6);
    expect(frameCoverage([square(0, -2, 0.4), square(0, -2, 0.4)], viewProj)).toBeCloseTo(2 * expected, 6);
    // Far to the side: clamped to the frame's edge, nothing.
    expect(frameCoverage([square(50, -2, 0.4)], viewProj)).toBeCloseTo(0, 9);
    // Behind the eye: nothing.
    expect(frameCoverage([square(0, 2, 0.4)], viewProj)).toBe(0);
    // Filling the view: the whole frame, never more.
    expect(frameCoverage([square(0, -0.2, 40)], viewProj)).toBeCloseTo(1, 9);
  });
});
