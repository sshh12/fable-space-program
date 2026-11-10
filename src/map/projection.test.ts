import { describe, expect, it } from 'vitest';
import { v3, type Vec3 } from '@/core/math/vec3';
import { Projector } from './projection';
import { lookAtCamera } from './testing/camera';

const VIEWPORT = { width: 1280, height: 720, pxScale: 1 };
const f32 = Math.fround;

/** The same projection evaluated with every input and intermediate rounded to float32 (what a GPU-side world-space path would do). */
function projectF32(eye: Vec3, p: Vec3, proj: Projector): { x: number; y: number } {
  const e = { x: f32(eye.x), y: f32(eye.y), z: f32(eye.z) };
  const q = { x: f32(p.x), y: f32(p.y), z: f32(p.z) };
  const rel = { x: f32(q.x - e.x), y: f32(q.y - e.y), z: f32(q.z - e.z) };
  const v = proj.rotate(rel);
  const k = f32(proj.focal / f32(-v.z));
  return { x: f32(proj.cx + f32(v.x * k)), y: f32(proj.cy - f32(v.y * k)) };
}

describe('float64 projection', () => {
  it('resolves 1 m next to a vessel in lunar orbit (planet-scale ROOT coordinates)', () => {
    // A vessel 100 km above the Moon, the Moon 3.8e8 m from the root body, camera 60 m from the vessel.
    const moon = { x: 3.62e8, y: -1.21e8, z: -0.44e8 };
    const vessel = v3.add(moon, { x: 1.2e6, y: 1.25e6, z: 0.4e6 });
    const eye = v3.add(vessel, { x: 0, y: 0, z: 60 });
    const proj = new Projector(lookAtCamera(eye, vessel, 0.8, { x: 0, y: 1, z: 0 }), VIEWPORT);
    const a = proj.projectRoot(vessel);
    const b = proj.projectRoot(v3.add(vessel, { x: 1, y: 0, z: 0 }));
    // exact: 1 m at 60 m, perpendicular to the view axis
    const expected = proj.focal / 60;
    expect(Math.hypot(b.x - a.x, b.y - a.y)).toBeCloseTo(expected, 9);
    expect(a.x).toBeCloseTo(VIEWPORT.width / 2, 9);
    expect(a.y).toBeCloseTo(VIEWPORT.height / 2, 9);
    // float32 world coordinates cannot even represent the metre (ulp at 3.9e8 m is 32 m)
    const af = projectF32(eye, vessel, proj);
    const bf = projectF32(eye, v3.add(vessel, { x: 1, y: 0, z: 0 }), proj);
    expect(Math.abs(Math.hypot(bf.x - af.x, bf.y - af.y) - expected)).toBeGreaterThan(1);
  });

  it('keeps sub-pixel accuracy with the camera 2e9 m away', () => {
    const target = { x: 1.0e7, y: -2.0e7, z: 3.0e6 };
    const eye = v3.add(target, { x: 1.2e9, y: 1.4e9, z: 0.6e9 });
    const proj = new Projector(lookAtCamera(eye, target), VIEWPORT);
    const dist = v3.dist(eye, target);
    // A point displaced perpendicular to the line of sight by exactly 37.25 px worth of metres.
    const los = v3.normalize(v3.sub(target, eye));
    const side = v3.normalize(v3.cross(los, { x: 0, y: 0, z: 1 }));
    const metresPerPx = dist / proj.focal;
    const p = v3.add(target, v3.scale(side, 37.25 * metresPerPx));
    const s0 = proj.projectRoot(target);
    const s1 = proj.projectRoot(p);
    expect(Math.hypot(s1.x - s0.x, s1.y - s0.y)).toBeCloseTo(37.25, 6);
    // 1 m resolution at the target is 1e-6 px here; float64 keeps it, the f32 path cannot.
    const q = proj.projectRoot(v3.add(target, v3.scale(side, 1000)));
    expect(Math.hypot(q.x - s0.x, q.y - s0.y)).toBeCloseTo(1000 / metresPerPx, 9);
  });

  it('round-trips rays and flags points behind the near plane', () => {
    const eye = { x: 7e6, y: 0, z: 0 };
    const proj = new Projector(lookAtCamera(eye, v3.zero()), VIEWPORT);
    const behind = proj.projectRoot({ x: 8e6, y: 0, z: 0 });
    expect(behind.front).toBe(false);
    const ray = proj.rayView(100, 650);
    const p = proj.projectView(v3.scale(ray, 1234.5));
    expect(p.x).toBeCloseTo(100, 9);
    expect(p.y).toBeCloseTo(650, 9);
  });

  it('matches the GPU projection matrix', () => {
    const eye = { x: 1e7, y: 2e6, z: -3e6 };
    const proj = new Projector(lookAtCamera(eye, { x: 0, y: 1e6, z: 0 }), VIEWPORT);
    const m = proj.projectionMatrix();
    const v = { x: 1.5e5, y: -2.2e5, z: -9e6 };
    const cx = m[0]! * v.x + m[8]! * v.z + m[12]!;
    const cy = m[5]! * v.y + m[9]! * v.z + m[13]!;
    const cw = m[3]! * v.x + m[7]! * v.y + m[11]! * v.z + m[15]!;
    const gx = (cx / cw * 0.5 + 0.5) * VIEWPORT.width;
    const gy = (0.5 - (cy / cw) * 0.5) * VIEWPORT.height;
    const s = proj.projectView(v);
    expect(gx).toBeCloseTo(s.x, 9);
    expect(gy).toBeCloseTo(s.y, 9);
  });
});
