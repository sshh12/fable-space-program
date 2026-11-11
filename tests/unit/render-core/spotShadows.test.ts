import { describe, expect, it } from 'vitest';
import type { LocalLight } from '@/core/contracts/render';
import { mat4, v3 } from '@/core/math';
import { SPOT_SHADOW_MAX, pickShadowedSpots, spotViewProj } from '@/render/core/shadows/spotShadows';

describe('spot-light shadow maps (request vehicle-pad-2)', () => {
  it('project along the beam: depth 0 at near, 1 at far, the cone edge on the map edge', () => {
    const pos = { x: 10, y: -4, z: 7 };
    const axis = v3.normalize({ x: 0.3, y: -0.2, z: -1 });
    const half = (30 * Math.PI) / 180;
    const m = spotViewProj(pos, axis, half, 0.1, 50);
    const ndc = (p: { x: number; y: number; z: number }): { x: number; y: number; z: number } => {
      const c = mat4.transformPoint(m, p);
      return { x: c.x / c.w, y: c.y / c.w, z: c.z / c.w };
    };
    const onAxis = (d: number): { x: number; y: number; z: number } => ndc(v3.addScaled(pos, axis, d));
    expect(onAxis(0.1).z).toBeCloseTo(0, 9);
    expect(onAxis(50).z).toBeCloseTo(1, 9);
    expect(Math.abs(onAxis(20).x)).toBeLessThan(1e-9);
    expect(Math.abs(onAxis(20).y)).toBeLessThan(1e-9);
    // Depth grows with the distance along the beam.
    expect(onAxis(10).z).toBeLessThan(onAxis(20).z);
    // A point 30 deg off the axis lies on the circle inscribed in the map (the cone touches its edges).
    const side = v3.normalize(v3.cross(axis, { x: 0, y: 0, z: 1 }));
    const edge = ndc(v3.addScaled(pos, v3.add(v3.scale(axis, Math.cos(half)), v3.scale(side, Math.sin(half))), 20));
    expect(Math.hypot(edge.x, edge.y)).toBeCloseTo(1, 9);
  });

  it('pick the brightest spots at the camera that ask for a shadow, at most SPOT_SHADOW_MAX', () => {
    const spot = (intensity: number, x: number, castShadow = true): LocalLight => ({ kind: 'spot', posRelCam: { x, y: 0, z: 0 }, dirRelCam: { x: 0, y: 0, z: -1 }, intensity: [intensity, intensity, intensity], range: 100, castShadow });
    const lights: LocalLight[] = [spot(1e5, 50), spot(1e6, 50), spot(1e7, 50, false), spot(1e6, 500), { kind: 'point', posRelCam: { x: 1, y: 0, z: 0 }, intensity: [1e9, 1e9, 1e9], range: 10 }];
    const picked = pickShadowedSpots(lights);
    expect(SPOT_SHADOW_MAX).toBe(2);
    expect(picked).toEqual([lights[1], lights[0]]);
  });
});
