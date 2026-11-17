/**
 * The lens shift (CameraState.lensShift, RENDER_API 19.5) where code outside the core's projection places
 * things on the screen itself: the atmosphere's screen bounds of a shell and the map's 2D projection. Both
 * must agree with the core's projection matrix.
 */
import { describe, expect, it } from 'vitest';
import { mat4, quat, v3 } from '@/core/math';
import { Projector } from '@/map/projection';
import { mapCamera } from '@/map/testing/camera';
import { sphereScreenBounds, type ViewFrustum } from '@/render/atmosphere/select';
import { buildProjection } from '@/render/core/frame/math';

const W = 1600;
const H = 900;
const FOV = (50 * Math.PI) / 180;
const SHIFT: [number, number] = [0.3, -0.2];

describe('the atmosphere screen bounds of a shell under a lens shift', () => {
  const tanY = Math.tan(FOV / 2);
  const view: ViewFrustum = { right: { x: 1, y: 0, z: 0 }, up: { x: 0, y: 1, z: 0 }, forward: { x: 0, y: 0, z: -1 }, tanHalfFovX: (tanY * W) / H, tanHalfFovY: tanY };
  const centre = { x: 2e6, y: -1e6, z: -4e7 };
  const radius = 3e6;

  it('are the unshifted bounds moved by the shift, and are what the projection gives the limb', () => {
    const plain = sphereScreenBounds(centre, radius, view) as [number, number, number, number];
    const shifted = sphereScreenBounds(centre, radius, { ...view, lensShift: SHIFT }) as [number, number, number, number];
    expect(shifted[0]).toBeCloseTo(plain[0] + SHIFT[0], 12);
    expect(shifted[2]).toBeCloseTo(plain[2] + SHIFT[0], 12);
    expect(shifted[1]).toBeCloseTo(plain[1] + SHIFT[1], 12);
    expect(shifted[3]).toBeCloseTo(plain[3] + SHIFT[1], 12);
    // The tangent points of the limb in the horizontal plane through the centre, through the core's matrix.
    const p = buildProjection(FOV, W, H, [0, 0], SHIFT).projUnjittered;
    const d = Math.hypot(centre.x, centre.z);
    const half = Math.asin(radius / d);
    const at = Math.atan2(centre.x, -centre.z);
    const edge = (a: number): number => {
      const c = mat4.transformPoint(p, { x: Math.sin(a), y: 0, z: -Math.cos(a) });
      return c.x / c.w;
    };
    expect(shifted[0]).toBeCloseTo(edge(at - half), 9);
    expect(shifted[2]).toBeCloseTo(edge(at + half), 9);
  });

  it('are the same to the bit with no shift stated and with a shift of zero', () => {
    expect(sphereScreenBounds(centre, radius, { ...view, lensShift: [0, 0] })).toEqual(sphereScreenBounds(centre, radius, view));
  });

  it('clip against the frame, not against the view axis', () => {
    // A shell that reaches past the right edge of the unshifted frame is cut at 1 there; shifted left it is whole.
    const wide = { x: 3.3e7, y: 0, z: -4e7 };
    const plain = sphereScreenBounds(wide, radius, view) as [number, number, number, number];
    expect(plain[2]).toBe(1);
    const left = sphereScreenBounds(wide, radius, { ...view, lensShift: [-0.5, 0] }) as [number, number, number, number];
    expect(left[2]).toBeLessThan(1);
  });
});

describe("the map's 2D projection under a lens shift", () => {
  const eye = { x: 1e7, y: -2e7, z: 3e6 };
  const q = quat.fromAxisAngle(v3.normalize({ x: 0.2, y: 1, z: -0.4 }), 0.7);
  const camera = { ...mapCamera(eye, q, FOV), lensShift: SHIFT };
  const viewport = { width: W, height: H, pxScale: 1 };
  const projection = new Projector(camera, viewport);

  it('puts the view axis where the shift says', () => {
    const ahead = v3.add(eye, quat.rotate(q, { x: 0, y: 0, z: -5e6 }));
    const s = projection.projectRoot(ahead);
    expect(s.x).toBeCloseTo((W / 2) * (1 + SHIFT[0]), 6);
    expect(s.y).toBeCloseTo((H / 2) * (1 - SHIFT[1]), 6);
    const plain = new Projector(mapCamera(eye, q, FOV), viewport).projectRoot(ahead);
    expect(plain.x).toBeCloseTo(W / 2, 6);
    expect(plain.y).toBeCloseTo(H / 2, 6);
  });

  it('agrees with the render core about every point: screen position and matrix', () => {
    const core = buildProjection(FOV, W, H, [0, 0], SHIFT).projUnjittered;
    expect([...projection.projectionMatrix()]).toEqual([...core]);
    for (const pv of [
      { x: 1e6, y: -2e5, z: -9e6 },
      { x: -4e6, y: 3e6, z: -5e6 },
    ]) {
      const c = mat4.transformPoint(core, pv);
      const s = projection.projectView(pv);
      expect(s.x).toBeCloseTo((0.5 + (0.5 * c.x) / c.w) * W, 6);
      expect(s.y).toBeCloseTo((0.5 - (0.5 * c.y) / c.w) * H, 6);
    }
  });
});
