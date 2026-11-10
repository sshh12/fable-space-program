import { describe, expect, it } from 'vitest';
import { conicFromState, conicMaxTrueAnomaly, conicPosition, type ConicElements } from '@/core/math/conic';
import { quat } from '@/core/math/quat';
import { v3, type Vec3 } from '@/core/math/vec3';
import { ViewConic } from './conicCurve';
import { CHORD_ERROR_PX, MAX_POINTS_PER_CURVE } from './constants';
import { Projector } from './projection';
import { pointSegmentDistance2D, Sampler } from './sampler';
import { lookAtCamera } from './testing/camera';

const MU = 3.986004418e14;
const VIEWPORT = { width: 1280, height: 720, pxScale: 1 };

/** A conic with periapsis radius rp and eccentricity e in a tilted plane. */
function conic(rp: number, e: number, tilt = 0.4, spin = 0.7): ConicElements {
  const q = quat.mul(quat.fromAxisAngle({ x: 0, y: 0, z: 1 }, spin), quat.fromAxisAngle({ x: 1, y: 0, z: 0 }, tilt));
  const r = quat.rotate(q, { x: rp, y: 0, z: 0 });
  const v = quat.rotate(q, { x: 0, y: Math.sqrt((MU * (1 + e)) / rp), z: 0 });
  return conicFromState(MU, r, v, 0);
}

interface Check {
  maxErr: number;
  checked: number;
  vertices: number;
  capped: boolean;
}

/** Max screen distance of exactly projected conic points (48 per segment) from the sampled polyline. */
function check(c: ConicElements, nu0: number, nu1: number, eye: Vec3, target: Vec3): Check {
  const proj = new Projector(lookAtCamera(eye, target), VIEWPORT);
  const curve = new ViewConic().setFromElements(c, v3.zero(), proj);
  const s = new Sampler().sample(curve, curve.nuToU(nu0), curve.nuToU(nu1), proj);
  const tmp = new Float64Array(2);
  let maxErr = 0;
  let checked = 0;
  for (let i = 0; i + 1 < s.count; i++) {
    const ax = s.sx[i]!;
    const ay = s.sy[i]!;
    const bx = s.sx[i + 1]!;
    const by = s.sy[i + 1]!;
    if (!Number.isFinite(ax) || !Number.isFinite(bx)) continue;
    for (let k = 1; k < 48; k++) {
      const u = s.u[i]! + ((s.u[i + 1]! - s.u[i]!) * k) / 48;
      curve.perifocal(u, tmp);
      const p = {
        x: curve.ox + curve.px * tmp[0]! + curve.qx * tmp[1]!,
        y: curve.oy + curve.py * tmp[0]! + curve.qy * tmp[1]!,
        z: curve.oz + curve.pz * tmp[0]! + curve.qz * tmp[1]!,
      };
      const sp = proj.projectView(p);
      if (!sp.front || !proj.onScreen(sp.x, sp.y, 2)) continue;
      checked++;
      maxErr = Math.max(maxErr, pointSegmentDistance2D(sp.x, sp.y, ax, ay, bx, by));
    }
  }
  return { maxErr, checked, vertices: s.count, capped: s.capped };
}

describe('adaptive conic sampling', () => {
  const rp = 6.771e6;
  const eccentricities = [0, 0.1, 0.4, 0.7, 0.9, 0.95, 0.97];
  it.each(eccentricities)('ellipse e = %s stays within 0.3 px at several zoom levels', (e) => {
    const c = conic(rp, e);
    const ra = rp * (1 + e) / (1 - e);
    const peri = conicPosition(c, 0);
    const apo = conicPosition(c, Math.PI);
    const centre = v3.scale(v3.add(peri, apo), 0.5);
    const views: [Vec3, Vec3][] = [
      // whole orbit, face-on-ish and oblique
      [v3.add(centre, v3.scale(c.W, 3 * (ra + rp))), centre],
      [v3.add(centre, v3.add(v3.scale(c.W, 1.5 * (ra + rp)), v3.scale(c.Q, ra + rp))), centre],
      // zoomed onto periapsis from 200 km and from 2000 km, and nearly edge-on
      [v3.add(peri, v3.add(v3.scale(c.W, 2e5), v3.scale(v3.normalize(peri), 5e4))), peri],
      [v3.add(peri, v3.scale(v3.normalize(v3.add(c.W, v3.scale(c.Q, 0.3))), 2e6)), peri],
      [v3.add(peri, v3.add(v3.scale(c.P, 3e6), v3.scale(c.W, 1.5e5))), v3.zero()],
      // far away: 2e9 m
      [v3.add(centre, v3.scale(v3.normalize(v3.add(c.W, c.P)), 2e9)), centre],
    ];
    for (const [eye, target] of views) {
      const r = check(c, 0, 2 * Math.PI, eye, target);
      expect(r.capped).toBe(false);
      expect(r.vertices).toBeLessThanOrEqual(MAX_POINTS_PER_CURVE);
      expect(r.maxErr, `e=${e} eye=${JSON.stringify(eye)}`).toBeLessThan(CHORD_ERROR_PX);
    }
  });

  it.each([1.05, 1.5, 3, 8])('hyperbolic arc e = %s stays within 0.3 px at several zoom levels', (e) => {
    const c = conic(2e6, e, 0.2, 1.1);
    const lim = conicMaxTrueAnomaly(c) * 0.97;
    const peri = conicPosition(c, 0);
    const far = conicPosition(c, lim);
    const views: [Vec3, Vec3][] = [
      [v3.add(peri, v3.scale(c.W, 3 * v3.len(far))), v3.scale(v3.add(peri, far), 0.5)],
      [v3.add(peri, v3.add(v3.scale(c.W, 3e5), v3.scale(c.P, 2e5))), peri],
      [v3.add(peri, v3.add(v3.scale(c.W, 8e6), v3.scale(c.Q, -2e6))), peri],
      [v3.add(peri, v3.scale(c.W, 1e9)), peri],
    ];
    for (const [eye, target] of views) {
      const r = check(c, -lim, lim, eye, target);
      expect(r.capped).toBe(false);
      expect(r.maxErr, `e=${e}`).toBeLessThan(CHORD_ERROR_PX);
    }
  });

  it('keeps off-screen parts coarse and refines only what is visible', () => {
    const c = conic(rp, 0.0);
    const peri = conicPosition(c, 0);
    // Camera 300 km above one point of a LEO circle: most of the orbit is off-screen.
    const near = check(c, 0, 2 * Math.PI, v3.add(peri, v3.scale(c.W, 3e5)), peri);
    const whole = check(c, 0, 2 * Math.PI, v3.scale(c.W, 4e7), v3.zero());
    expect(near.maxErr).toBeLessThan(CHORD_ERROR_PX);
    expect(near.checked).toBeGreaterThan(100);
    expect(near.vertices).toBeLessThan(400);
    expect(whole.vertices).toBeLessThan(300);
  });

  it('handles an orbit passing behind the camera (near-plane crossing) without hitting the cap', () => {
    const c = conic(3.844e8, 0.05, 0.1, 0.3);
    const p = conicPosition(c, 0.2);
    // Eye right next to the orbit line (like a camera focused on a moon on its own orbit).
    const tangent = v3.normalize(v3.sub(conicPosition(c, 0.2001), p));
    const eye = v3.add(p, v3.scale(c.W, 1e6));
    const r = check(c, 0, 2 * Math.PI, eye, v3.add(p, v3.scale(tangent, 5e6)));
    expect(r.capped).toBe(false);
    expect(r.maxErr).toBeLessThan(CHORD_ERROR_PX);
  });
});
