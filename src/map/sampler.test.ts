import { describe, expect, it } from 'vitest';
import { conicFromState, conicMaxTrueAnomaly, conicPosition, type ConicElements } from '@/core/math/conic';
import { Prng } from '@/core/math/hash';
import { quat } from '@/core/math/quat';
import { v3, type Vec3 } from '@/core/math/vec3';
import type { Viewport } from './projection';
import { ViewConic } from './conicCurve';
import { CHORD_ERROR_PX, MAX_POINTS_PER_CURVE } from './constants';
import { Projector } from './projection';
import { pointSegmentDistance2D, Sampler } from './sampler';
import { lookAtCamera } from './testing/camera';

const MU = 3.986004418e14;
const VIEWPORT: Viewport = { width: 1280, height: 720, pxScale: 1 };

/** A conic with periapsis radius rp and eccentricity e in a tilted plane. */
function conic(rp: number, e: number, tilt = 0.4, spin = 0.7): ConicElements {
  const q = quat.mul(quat.fromAxisAngle({ x: 0, y: 0, z: 1 }, spin), quat.fromAxisAngle({ x: 1, y: 0, z: 0 }, tilt));
  const r = quat.rotate(q, { x: rp, y: 0, z: 0 });
  const v = quat.rotate(q, { x: 0, y: Math.sqrt((MU * (1 + e)) / rp), z: 0 });
  return conicFromState(MU, r, v, 0);
}

interface Check {
  /** Greatest distance of an exact point from the chord of its own piece (what the sampler bounds). */
  maxErr: number;
  /** Greatest distance of an exact point from the whole polyline. */
  maxPolylineErr: number;
  checked: number;
  vertices: number;
  capped: boolean;
}

/** Exactly projected conic points (`perSegment` per piece) against the sampled polyline. */
function check(c: ConicElements, nu0: number, nu1: number, eye: Vec3, target: Vec3, viewport = VIEWPORT, perSegment = 48, up?: Vec3): Check {
  const proj = new Projector(lookAtCamera(eye, target, undefined, up), viewport);
  const curve = new ViewConic().setFromElements(c, v3.zero(), proj);
  const s = new Sampler().sample(curve, curve.nuToU(nu0), curve.nuToU(nu1), proj);
  const tmp = new Float64Array(4);
  let maxErr = 0;
  let maxPolylineErr = 0;
  let checked = 0;
  const near = (x: number, y: number, i: number): number => {
    // the polyline around piece i (its neighbours cover any overshoot past a vertex)
    let d = Infinity;
    for (let j = Math.max(0, i - 3); j <= Math.min(s.count - 2, i + 3); j++) {
      if (!Number.isFinite(s.sx[j]!) || !Number.isFinite(s.sx[j + 1]!)) continue;
      d = Math.min(d, pointSegmentDistance2D(x, y, s.sx[j]!, s.sy[j]!, s.sx[j + 1]!, s.sy[j + 1]!));
    }
    return d;
  };
  for (let i = 0; i + 1 < s.count; i++) {
    const ax = s.sx[i]!;
    const ay = s.sy[i]!;
    const bx = s.sx[i + 1]!;
    const by = s.sy[i + 1]!;
    if (!Number.isFinite(ax) || !Number.isFinite(bx)) continue;
    for (let k = 1; k < perSegment; k++) {
      const u = s.u[i]! + ((s.u[i + 1]! - s.u[i]!) * k) / perSegment;
      curve.perifocalWithDerivative(u, tmp);
      const p = {
        x: curve.ox + curve.px * tmp[0]! + curve.qx * tmp[1]!,
        y: curve.oy + curve.py * tmp[0]! + curve.qy * tmp[1]!,
        z: curve.oz + curve.pz * tmp[0]! + curve.qz * tmp[1]!,
      };
      const sp = proj.projectView(p);
      if (!sp.front || !proj.onScreen(sp.x, sp.y, 2)) continue;
      checked++;
      maxErr = Math.max(maxErr, pointSegmentDistance2D(sp.x, sp.y, ax, ay, bx, by));
      maxPolylineErr = Math.max(maxPolylineErr, near(sp.x, sp.y, i));
    }
  }
  return { maxErr, maxPolylineErr, checked, vertices: s.count, capped: s.capped };
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

  it('stays within 0.3 px when the orbit is seen nearly edge-on (hairpin ends)', () => {
    // The view ray grazes the orbit plane (|ray . W| from 1e-4 to 0.02): the projected ellipse folds into a
    // thin hairpin whose tips overshoot the vertices next to them unless the tips are sampled finely.
    let worst = 0;
    for (const e of [0, 0.3, 0.636, 0.9, 0.97]) {
      const c = conic(4.25e7, e, 0.9, 0.2);
      const ra = (4.25e7 * (1 + e)) / (1 - e);
      const centre = v3.scale(v3.add(conicPosition(c, 0), conicPosition(c, Math.PI)), 0.5);
      for (const grazing of [1e-4, 1e-3, 0.004, 0.012, 0.024]) {
        for (const azimuth of [0.1, 0.9, 1.7, 2.6]) {
          const inPlane = v3.add(v3.scale(c.P, Math.cos(azimuth)), v3.scale(c.Q, Math.sin(azimuth)));
          const dir = v3.normalize(v3.add(v3.scale(inPlane, Math.sqrt(1 - grazing * grazing)), v3.scale(c.W, grazing)));
          for (const dist of [3 * ra, 10 * ra]) {
            const r = check(c, 0, 2 * Math.PI, v3.add(centre, v3.scale(dir, dist)), centre, { width: 1920, height: 1080, pxScale: 1.5 }, 32, c.W);
            expect(r.capped).toBe(false);
            worst = Math.max(worst, r.maxErr, r.maxPolylineErr);
          }
        }
      }
    }
    expect(worst).toBeLessThan(CHORD_ERROR_PX);
  });

  it('stays within 0.3 px over 1500 random views (ellipses, hyperbolas, grazing angles, 1 km to 2e9 m)', () => {
    const prng = new Prng(20261110);
    const viewport: Viewport = { width: 1920, height: 1080, pxScale: 1.5 };
    let worst = 0;
    let worstCase = '';
    let checked = 0;
    for (let i = 0; i < 1500; i++) {
      const hyper = prng.next() < 0.3;
      const e = hyper ? 1.02 + prng.range(0, 4) : prng.range(0, 0.97);
      const rpi = 6.6e6 * Math.pow(10, prng.range(0, 1.8));
      const c = conic(rpi, e, prng.range(0, Math.PI), prng.range(0, 2 * Math.PI));
      const lim = hyper ? conicMaxTrueAnomaly(c) * 0.95 : Math.PI;
      // A point on the arc, the eye 1 km .. 2e9 m from it in a random direction (often grazing the plane).
      const nuAt = prng.range(-lim, lim);
      const at = conicPosition(c, nuAt);
      const grazing = prng.next() < 0.5 ? prng.range(-0.03, 0.03) : prng.range(-1, 1);
      const az = prng.range(0, 2 * Math.PI);
      const inPlane = v3.add(v3.scale(c.P, Math.cos(az)), v3.scale(c.Q, Math.sin(az)));
      const dir = v3.normalize(v3.add(v3.scale(inPlane, Math.sqrt(1 - grazing * grazing)), v3.scale(c.W, grazing)));
      const dist = Math.pow(10, prng.range(3, Math.log10(2e9)));
      const eye = v3.add(at, v3.scale(dir, dist));
      // Look at the arc point, or somewhere between it and the focus.
      const target = v3.scale(at, prng.range(0, 1));
      const r = check(c, hyper ? -lim : 0, hyper ? lim : 2 * Math.PI, eye, target, viewport, 12, c.W);
      checked += r.checked;
      const err = Math.max(r.maxErr, r.maxPolylineErr);
      if (err > worst) {
        worst = err;
        worstCase = `view ${i}: e=${e.toFixed(3)} rp=${rpi.toExponential(2)} dist=${dist.toExponential(2)} grazing=${grazing.toFixed(4)}`;
      }
      expect(r.capped, `view ${i}`).toBe(false);
    }
    expect(checked).toBeGreaterThan(100_000);
    expect(worst, worstCase).toBeLessThan(CHORD_ERROR_PX);
  });

  it('keeps off-screen parts coarse and refines only what is visible', () => {
    const c = conic(rp, 0.0);
    const peri = conicPosition(c, 0);
    // Camera 300 km above one point of a LEO circle: most of the orbit is off-screen.
    const near = check(c, 0, 2 * Math.PI, v3.add(peri, v3.scale(c.W, 3e5)), peri);
    const whole = check(c, 0, 2 * Math.PI, v3.scale(c.W, 4e7), v3.zero());
    expect(near.maxErr).toBeLessThan(CHORD_ERROR_PX);
    expect(near.checked).toBeGreaterThan(100);
    expect(near.vertices).toBeLessThan(300);
    expect(whole.vertices).toBeLessThan(200);
  });

  it('measures the chord error exactly: the worst sampled piece is close to the tolerance, not far below it', () => {
    // A circle seen obliquely: with an exact error measure the polyline uses nearly the whole tolerance
    // (a bound that overestimated by 2x would leave the actual error near 0.15 px and cost 41 % more vertices).
    const c = conic(rp, 0.2);
    const r = check(c, 0, 2 * Math.PI, v3.add(v3.scale(c.W, 2.5e7), v3.scale(c.P, 1e7)), v3.zero(), VIEWPORT, 64);
    expect(r.maxErr).toBeLessThan(CHORD_ERROR_PX);
    expect(r.maxErr).toBeGreaterThan(0.2);
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
