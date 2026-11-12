/**
 * The flood lights' shadow maps (src/render/cockpit/lampmap.ts): the projection the maps are rendered and
 * read with, and that every lamp looks into the cabin (not into a part standing in front of its lens).
 */
import { describe, expect, it } from 'vitest';
import { v3 } from '@/core/math';
import { bvhRay } from '@/render/cockpit/bvh';
import { LAMP_FAR, LAMP_HALF_ANGLE, LAMP_NEAR, lampMatrix, lampProject } from '@/render/cockpit/lampmap';
import { testModel } from './helpers';

describe('cockpit lamp shadow maps', () => {
  it('a lamp map looks along the lens normal from the middle of the lens and holds the whole beam', async () => {
    const model = await testModel();
    expect(model.floods.length).toBeGreaterThan(0);
    for (const f of model.floods) {
      const m = lampMatrix(f);
      const eye = v3.scale(v3.add(f.p0, f.p1), 0.5);
      const n = v3.normalize(f.n);
      const along = v3.normalize(v3.reject(v3.sub(f.p1, f.p0), n));
      const across = v3.cross(along, n);
      // On the axis: the middle of the map, depth growing with distance from 0 at the near plane to 1 at the far.
      const near = lampProject(m, v3.addScaled(eye, n, LAMP_NEAR));
      const mid = lampProject(m, v3.addScaled(eye, n, 1));
      const far = lampProject(m, v3.addScaled(eye, n, LAMP_FAR));
      expect(near.depth).toBeCloseTo(0, 6);
      expect(far.depth).toBeCloseTo(1, 6);
      expect(mid.depth).toBeGreaterThan(near.depth);
      expect(mid.depth).toBeLessThan(far.depth);
      expect(mid.u).toBeCloseTo(0.5, 9);
      expect(mid.v).toBeCloseTo(0.5, 9);
      expect(mid.w).toBeCloseTo(1, 9);
      // The edge of the beam (the half angle off the normal) lies on the edge of the map, along and across the lens.
      const t = Math.tan(LAMP_HALF_ANGLE);
      const right = lampProject(m, v3.add(v3.addScaled(eye, n, 0.7), v3.scale(along, 0.7 * t)));
      const up = lampProject(m, v3.add(v3.addScaled(eye, n, 0.7), v3.scale(across, 0.7 * t)));
      expect(Math.abs(right.u - 0.5)).toBeCloseTo(0.5, 6);
      expect(right.v).toBeCloseTo(0.5, 6);
      expect(Math.abs(up.v - 0.5)).toBeCloseTo(0.5, 6);
      expect(up.u).toBeCloseTo(0.5, 6);
      // Inside the beam: inside the map.
      const inside = lampProject(m, v3.add(v3.addScaled(eye, n, 0.7), v3.add(v3.scale(along, 0.3), v3.scale(across, -0.4))));
      expect(inside.u).toBeGreaterThan(0);
      expect(inside.u).toBeLessThan(1);
      expect(inside.v).toBeGreaterThan(0);
      expect(inside.v).toBeLessThan(1);
      // Behind the lens: not in front of the map's eye.
      expect(lampProject(m, v3.addScaled(eye, n, -0.2)).w).toBeLessThan(0);
    }
  });

  it('no lamp is buried: along its lens normal the first surface is more than a hand away', async () => {
    const model = await testModel();
    for (const [i, f] of model.floods.entries()) {
      const eye = v3.scale(v3.add(f.p0, f.p1), 0.5);
      const n = v3.normalize(f.n);
      const hit = bvhRay(model.bvh, v3.addScaled(eye, n, LAMP_NEAR), n, 1e-4, 16, false);
      expect(hit?.t ?? Infinity, `flood ${i}: distance to the first surface along the lens normal`).toBeGreaterThan(0.2);
    }
  });
});
