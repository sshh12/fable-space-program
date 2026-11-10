import { describe, expect, it } from 'vitest';
import {
  conicApsides,
  conicFromState,
  conicPosition,
  conicRadiusCrossing,
  conicTrueAnomaly,
  conicVelocity,
  DEG,
  hash4,
  hashToUnit,
  hashU32,
  interpTable,
  mat3,
  mat4,
  Prng,
  quat,
  timeSincePeriapsis,
  v3,
  wrapPi,
  wrapTwoPi,
} from './index';

const MU_EARTH = 3.986004418e14;

describe('vec3', () => {
  it('cross is right-handed', () => {
    expect(v3.cross(v3.unitX(), v3.unitY())).toEqual(v3.unitZ());
    expect(v3.cross(v3.unitY(), v3.unitZ())).toEqual(v3.unitX());
  });
  it('angle is stable near 0 and pi', () => {
    const a = v3.new(1, 0, 0);
    expect(v3.angle(a, v3.new(1, 1e-9, 0))).toBeCloseTo(1e-9, 15);
    expect(v3.angle(a, v3.new(-1, 1e-9, 0))).toBeCloseTo(Math.PI - 1e-9, 12);
  });
  it('normalize never returns NaN', () => {
    expect(v3.isFinite(v3.normalize(v3.zero()))).toBe(true);
  });
  it('anyOrthogonal is orthogonal and unit', () => {
    for (const a of [v3.new(1, 2, 3), v3.new(0, 0, 5), v3.new(-4, 0, 0)]) {
      const o = v3.anyOrthogonal(a);
      expect(Math.abs(v3.dot(o, a))).toBeLessThan(1e-12);
      expect(v3.len(o)).toBeCloseTo(1, 12);
    }
  });
});

describe('quat conventions', () => {
  it('rotate is the active rotation: +90 deg about Z takes X to Y', () => {
    const q = quat.fromAxisAngle(v3.unitZ(), 90 * DEG);
    expect(v3.equalsApprox(quat.rotate(q, v3.unitX()), v3.unitY(), 1e-12)).toBe(true);
  });
  it('mul(a, b) applies b first', () => {
    const a = quat.fromAxisAngle(v3.unitZ(), 90 * DEG);
    const b = quat.fromAxisAngle(v3.unitX(), 90 * DEG);
    const v = v3.new(0.3, -1.2, 2.5);
    expect(v3.equalsApprox(quat.rotate(quat.mul(a, b), v), quat.rotate(a, quat.rotate(b, v)), 1e-12)).toBe(true);
  });
  it('matches the rotation matrix', () => {
    const q = quat.normalize({ x: 0.1, y: -0.4, z: 0.7, w: 0.5 });
    const v = v3.new(1, 2, 3);
    expect(v3.equalsApprox(mat3.mulVec(mat3.fromQuat(q), v), quat.rotate(q, v), 1e-12)).toBe(true);
  });
  it('rotVec round trip and small-angle stability', () => {
    for (const r of [v3.new(0.2, -0.5, 1.1), v3.new(1e-12, 0, 0), v3.new(0, 3.0, 0)]) {
      expect(v3.equalsApprox(quat.toRotVec(quat.fromRotVec(r)), r, 1e-12)).toBe(true);
    }
  });
  it('fromBasis reproduces the basis', () => {
    const q0 = quat.normalize({ x: 0.3, y: 0.2, z: -0.6, w: 0.7 });
    const q = quat.fromBasis(quat.rotate(q0, v3.unitX()), quat.rotate(q0, v3.unitY()), quat.rotate(q0, v3.unitZ()));
    expect(quat.angleBetween(q, q0)).toBeLessThan(1e-7);
  });
  it('fromTo handles antiparallel vectors', () => {
    const q = quat.fromTo(v3.unitY(), v3.new(0, -1, 0));
    expect(v3.equalsApprox(quat.rotate(q, v3.unitY()), v3.new(0, -1, 0), 1e-12)).toBe(true);
  });
  it('slerp end points and midpoint', () => {
    const a = quat.identity();
    const b = quat.fromAxisAngle(v3.unitZ(), 100 * DEG);
    expect(quat.angleBetween(quat.slerp(a, b, 0.5), quat.fromAxisAngle(v3.unitZ(), 50 * DEG))).toBeLessThan(1e-7);
    expect(quat.angleBetween(quat.slerp(a, b, 1), b)).toBeLessThan(1e-7);
  });
});

describe('mat3 / mat4', () => {
  it('invert', () => {
    const m = mat3.fromQuat(quat.normalize({ x: 0.2, y: 0.5, z: -0.1, w: 0.8 }));
    const scaled = mat3.mul(m, mat3.diag(2, 3, 4));
    const id = mat3.mul(scaled, mat3.invert(scaled));
    mat3.identity().forEach((e, i) => expect(id[i]).toBeCloseTo(e, 12));
    expect(() => mat3.invert(mat3.zero())).toThrow();
  });
  it('rotateTensor keeps the trace', () => {
    const r = mat3.fromQuat(quat.fromAxisAngle(v3.new(1, 1, 0), 0.7));
    const t = mat3.rotateTensor(r, mat3.diag(1, 2, 3));
    expect(t[0] + t[4] + t[8]).toBeCloseTo(6, 12);
  });
  it('reversed-Z infinite projection: depth = near / distance', () => {
    const near = 0.05;
    const p = mat4.perspectiveReversedZInfinite(60 * DEG, 16 / 9, near);
    for (const dist of [near, 1, 1000, 3.844e8]) {
      const c = mat4.transformPoint(p, v3.new(0, 0, -dist));
      expect(c.z / c.w).toBeCloseTo(near / dist, 15);
    }
  });
  it('viewRotation maps the camera forward axis to -Z', () => {
    const qViewToWorld = quat.fromAxisAngle(v3.unitY(), 90 * DEG);
    const forwardWorld = quat.rotate(qViewToWorld, v3.new(0, 0, -1));
    const c = mat4.transformPoint(mat4.viewRotation(qViewToWorld), forwardWorld);
    expect(c.x).toBeCloseTo(0, 12);
    expect(c.y).toBeCloseTo(0, 12);
    expect(c.z).toBeCloseTo(-1, 12);
  });
  it('mul composes column-major', () => {
    const a = mat4.viewRotation(quat.fromAxisAngle(v3.unitZ(), 0.4));
    const b = mat4.viewRotation(quat.fromAxisAngle(v3.unitX(), -1.1));
    const p = v3.new(1, 2, 3);
    const viaMul = mat4.transformPoint(mat4.mul(a, b), p);
    const bp = mat4.transformPoint(b, p);
    const seq = mat4.transformPoint(a, v3.new(bp.x, bp.y, bp.z));
    expect(viaMul.x).toBeCloseTo(seq.x, 12);
    expect(viaMul.y).toBeCloseTo(seq.y, 12);
    expect(viaMul.z).toBeCloseTo(seq.z, 12);
  });
});

describe('scalar helpers', () => {
  it('wraps angles', () => {
    expect(wrapPi(3 * Math.PI)).toBeCloseTo(Math.PI, 12);
    expect(wrapPi(-Math.PI - 0.1)).toBeCloseTo(Math.PI - 0.1, 12);
    expect(wrapTwoPi(-0.1)).toBeCloseTo(2 * Math.PI - 0.1, 12);
  });
  it('interpolates tables with clamped ends', () => {
    const xs = [0, 1, 3];
    const ys = [10, 20, 0];
    expect(interpTable(xs, ys, -5)).toBe(10);
    expect(interpTable(xs, ys, 0.5)).toBe(15);
    expect(interpTable(xs, ys, 2)).toBe(10);
    expect(interpTable(xs, ys, 9)).toBe(0);
  });
});

describe('hash', () => {
  it('is a fixed, well-distributed 32-bit function', () => {
    // Golden values: the WGSL mirror (HASH_WGSL) must reproduce these exactly.
    expect(hashU32(0)).toBe(129708002);
    expect(hashU32(1)).toBe(2831084092);
    expect(hashU32(0xffffffff)).toBe(3861530882);
    expect(hash4(1, 2, 3, 4)).toBe(4257183816);
    let mean = 0;
    for (let i = 0; i < 20000; i++) mean += hashToUnit(hash4(i, -i, 7, 3));
    expect(mean / 20000).toBeGreaterThan(0.49);
    expect(mean / 20000).toBeLessThan(0.51);
  });
  it('Prng is deterministic', () => {
    const a = new Prng(42);
    const b = new Prng(42);
    for (let i = 0; i < 10; i++) expect(a.nextU32()).toBe(b.nextU32());
    const x = new Prng(7).next();
    expect(x).toBeGreaterThanOrEqual(0);
    expect(x).toBeLessThan(1);
  });
});

describe('conic', () => {
  it('round-trips an eccentric inclined orbit', () => {
    const r = v3.new(7.0e6, 1.2e6, -0.8e6);
    const v = v3.new(-1200, 7900, 2100);
    const c = conicFromState(MU_EARTH, r, v, 1000);
    const nu = conicTrueAnomaly(c, r);
    expect(v3.dist(conicPosition(c, nu), r)).toBeLessThan(1e-6);
    expect(v3.dist(conicVelocity(c, nu), v)).toBeLessThan(1e-9);
    expect(c.tPeriapsis + timeSincePeriapsis(c, nu)).toBeCloseTo(1000, 6);
    expect(c.e).toBeGreaterThan(0);
    expect(c.e).toBeLessThan(1);
    const { rp, ra } = conicApsides(c);
    expect(rp).toBeLessThan(v3.len(r));
    expect(ra).toBeGreaterThan(v3.len(r));
    expect(v3.dot(c.W, v3.normalize(v3.cross(r, v)))).toBeCloseTo(1, 12);
  });
  it('gives the textbook period and half-period for an ellipse', () => {
    const rp = 6.6e6;
    const ra = 4.2e7;
    const a = (rp + ra) / 2;
    const vp = Math.sqrt(MU_EARTH * (2 / rp - 1 / a));
    const c = conicFromState(MU_EARTH, v3.new(rp, 0, 0), v3.new(0, vp, 0), 0);
    const T = 2 * Math.PI * Math.sqrt((a * a * a) / MU_EARTH);
    expect(c.period).toBeCloseTo(T, 4);
    expect(timeSincePeriapsis(c, Math.PI)).toBeCloseTo(T / 2, 4);
    expect(timeSincePeriapsis(c, -Math.PI / 2)).toBeCloseTo(-timeSincePeriapsis(c, Math.PI / 2), 6);
    expect(c.inc).toBeCloseTo(0, 12);
  });
  it('handles circular and hyperbolic orbits', () => {
    const rc = 6.771e6;
    const vc = Math.sqrt(MU_EARTH / rc);
    const circ = conicFromState(MU_EARTH, v3.new(0, rc, 0), v3.new(-vc, 0, 0), 50);
    expect(circ.e).toBeLessThan(1e-9);
    expect(circ.period).toBeCloseTo(2 * Math.PI * Math.sqrt(rc ** 3 / MU_EARTH), 3);
    expect(conicRadiusCrossing(circ, rc * 2)).toBeNull();

    const hyp = conicFromState(MU_EARTH, v3.new(rc, 0, 0), v3.new(0, vc * 1.6, 0), 0);
    expect(hyp.e).toBeGreaterThan(1);
    expect(hyp.a).toBeLessThan(0);
    expect(hyp.period).toBeNull();
    const nuSoi = conicRadiusCrossing(hyp, 9.0e8)!;
    expect(v3.len(conicPosition(hyp, nuSoi))).toBeCloseTo(9.0e8, 0);
    const t = timeSincePeriapsis(hyp, nuSoi);
    expect(t).toBeGreaterThan(0);
    expect(Number.isFinite(t)).toBe(true);
  });
  it('inclination and node of a polar orbit', () => {
    const rc = 7.0e6;
    const vc = Math.sqrt(MU_EARTH / rc);
    const c = conicFromState(MU_EARTH, v3.new(rc, 0, 0), v3.new(0, 0, vc), 0);
    expect(c.inc).toBeCloseTo(Math.PI / 2, 12);
    expect(c.lan).toBeCloseTo(0, 12);
  });
});
