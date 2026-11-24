/**
 * The Sun-rooted body system on the staged library (32 bodies; MIGRATION_V2 step 4.1c), against the shipped
 * three-body library where they share a body:
 *  - every staged file loads through the loader's overlay source and the body system accepts the library;
 *  - the runtime ephemeris equals the generator's reference evaluator (tools/bodies/lib/kepler.mjs) and keeps
 *    every body inside its Horizons tolerance at the committed held-out instants (the generator's check
 *    repeated against the TypeScript code);
 *  - the Sun's direction at the Earth reproduces v1 (declination within 0.0035 deg over 2029-2031);
 *  - the v2 members: SOI rule, rails warp limits by default, shapes, the floor of the giants, the planet
 *    systems of sunVisibility, the boundary queries.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { RAILS_WARP_LEVEL_COUNT, type BodyDef } from '../../../src/core/contracts/defs';
import { quat } from '../../../src/core/math/quat';
import { DEG } from '../../../src/core/math/scalar';
import { v3 } from '../../../src/core/math/vec3';
import { AU, SecularKeplerEphemeris } from '../../../src/sim/bodies/ephemeris';
import { belowFloor, floorAltitude, surfaceRadius, warpAltitudeLimitsOf } from '../../../src/sim/bodies/shape';
import { maxWarpIndexForAltitude } from '../../../src/sim/orbit/warp';
import { orbitState, type V3 } from '../../../tools/bodies/lib/kepler.mjs';
import { BODY_LIST, loadShipped, loadStaged, repoRoot, utOf, type World } from './fixtures';

let staged: World;
let shipped: World;

beforeAll(async () => {
  [staged, shipped] = await Promise.all([loadStaged(), loadShipped()]);
});

const readJson = (p: string): unknown => JSON.parse(readFileSync(path.join(repoRoot, p), 'utf8'));
const tuple = (v: { x: number; y: number; z: number }): V3 => [v.x, v.y, v.z];

describe('the staged library loads and the body system accepts it', () => {
  it('every body of the list is staged, loads through the overlay source, and the root is the Sun as star and attractor', () => {
    const ids = Object.keys(staged.defs.bodies).sort();
    expect(ids).toEqual([...BODY_LIST].sort());
    const sys = staged.system;
    expect(sys.ids.length).toBe(32);
    expect(sys.rootId).toBe('sun');
    expect(sys.starId).toBe('sun');
    expect(sys.body('sun').attractor).toBe(true);
    // parents before children, siblings by id
    for (const id of sys.ids) {
      const p = sys.body(id).parentId;
      if (p !== null) expect(sys.ids.indexOf(p)).toBeLessThan(sys.ids.indexOf(id));
    }
    // three levels, no moon of a moon
    for (const id of sys.ids) {
      const p = sys.body(id).parentId;
      if (p !== null && p !== 'sun') expect(sys.body(p).parentId).toBe('sun');
    }
  });

  it('the shipped library is unchanged: Earth at the root, the Sun a light on the Almanac formula, three bodies', () => {
    const sys = shipped.system;
    expect(sys.ids.length).toBe(3);
    expect(sys.rootId).not.toBe(sys.starId);
    expect(sys.body(sys.starId).attractor).toBe(false);
    expect(sys.orbitConic(sys.starId, 0)).toBeNull();
  });

  it('every body is an attractor with an SOI inside its parent SOI and outside its radius', () => {
    const sys = staged.system;
    for (const id of sys.ids) {
      const b = sys.body(id);
      expect(b.attractor).toBe(true);
      if (b.parentId === null) continue;
      expect(b.soiRadius!).toBeGreaterThan(b.radius);
      const parent = sys.body(b.parentId);
      const a = sys.stateRelParent(id, utOf(2030, 1, 1)).r;
      if (parent.soiRadius !== null) expect(v3.len(a) + b.soiRadius!).toBeLessThan(parent.soiRadius);
    }
  });
});

describe('the SOI rule', () => {
  it("'auto' = min(Hill, max(a (m/M)^0.4, 2.5 R)): Phobos 16.6 km, Deimos 15.5 km, Mimas 495 km", () => {
    const sys = staged.system;
    expect(sys.body('phobos').soiRadius! / 1000).toBeCloseTo(16.6, 1);
    expect(sys.body('deimos').soiRadius! / 1000).toBeCloseTo(15.5, 1);
    expect(Math.abs(sys.body('mimas').soiRadius! / 1000 - 495)).toBeLessThan(1);
    // Earth states its number; the planets' SOIs are the Laplace radius (Jupiter 48.2 M km, Neptune 86.8 M km)
    expect(sys.body('earth').soiRadius).toBe(staged.defs.bodies['earth']!.soiRadius);
    expect(sys.body('jupiter').soiRadius! / 1e9).toBeCloseTo(48.2, 1);
    expect(Math.abs(sys.body('neptune').soiRadius! / 1e9 - 86.8)).toBeLessThan(0.5);
  });

  it("the Moon's sphere is PINNED at 66,100 km by its definitions in both libraries; the rule would give 61,500 km (Hill binds)", async () => {
    // What the golden and the original mission fly is the stated number; the v2 rule reaches the Moon only
    // through a definition that says 'auto' (none does; sim-orbits' synthetic 'auto' test holds the 61.5e6).
    const shippedWorld = await loadShipped();
    for (const w of [shippedWorld, staged]) {
      expect(w.defs.bodies['moon']!.soiRadius).toBe(66.1e6);
      expect(w.system.body('moon').soiRadius).toBe(66.1e6);
    }
    const m = staged.defs.bodies['moon']!;
    const a = (m.orbit as { a: number }).a;
    const ratio = m.mu / staged.defs.bodies['earth']!.mu;
    const hill = a * Math.cbrt(ratio / 3);
    const laplace = a * Math.pow(ratio, 0.4);
    expect(Math.abs(Math.min(hill, Math.max(laplace, 2.5 * m.radius)) - 61.5e6)).toBeLessThan(0.3e6);
    expect(Math.abs(laplace - 66.1e6)).toBeLessThan(0.3e6);
  });
});

describe('the runtime ephemeris', () => {
  const instants = [938240818, utOf(2035, 3, 1), utOf(2045, 7, 1), utOf(2059, 12, 1)];

  it('equals the generator reference evaluator (tools/bodies/lib/kepler.mjs) for every body, position and velocity', () => {
    const sys = staged.system;
    let worstR = 0;
    let worstV = 0;
    for (const id of sys.ids) {
      const b = staged.defs.bodies[id]!;
      if (b.parent === null) continue;
      const p = staged.defs.bodies[b.parent]!;
      for (const ut of instants) {
        const ref = orbitState(b.orbit!, ut, { muSum: p.mu + b.mu, parentPole: null });
        const s = sys.stateRelParent(id, ut);
        const r = tuple(s.r);
        const v = tuple(s.v);
        worstR = Math.max(worstR, Math.hypot(r[0] - ref.r[0], r[1] - ref.r[1], r[2] - ref.r[2]) / Math.hypot(...ref.r));
        worstV = Math.max(worstV, Math.hypot(v[0] - ref.v[0], v[1] - ref.v[1], v[2] - ref.v[2]) / Math.hypot(...ref.v));
      }
    }
    // the same expressions; the rotation into ICRF is a quaternion here and a matrix there, and Kepler's
    // equation is solved by another routine (Mimas' mean anomaly is 4e6 deg by 2060): 1e-11 relative is 2 mm
    // at Mimas and 5 cm at Neptune
    expect(worstR).toBeLessThan(2e-11);
    expect(worstV).toBeLessThan(2e-11);
  });

  it('the velocity is the exact derivative of the position (rates included) for the precessing orbits', () => {
    const sys = staged.system;
    for (const id of ['phobos', 'io', 'europa', 'mimas', 'triton', 'mercury', 'neptune', 'charon']) {
      const eph = sys.body(id).ephemeris!;
      expect(eph).toBeInstanceOf(SecularKeplerEphemeris);
      for (const ut of instants) {
        const h = eph.meanPeriod * 1e-5;
        const a = eph.stateAt(ut - h).r;
        const c = eph.stateAt(ut + h).r;
        const fd = v3.scale(v3.sub(c, a), 1 / (2 * h));
        const v = eph.stateAt(ut).v;
        expect(v3.len(v3.sub(fd, v)) / v3.len(v)).toBeLessThan(1e-6);
      }
    }
  });

  it('keeps every judged body inside its Horizons tolerance at the held-out instants (the generator check, on the runtime)', () => {
    const sys = staged.system;
    const truth = readJson('tests/unit/bodies/horizons-heldout.json') as { bodies: Record<string, { rows: number[][] }> };
    const tol = readJson('tools/bodies/tolerances.json') as { classes: Record<string, { angleDeg: number; radial: number }>; bodies: { id: string; class: string; angleDeg?: number; radial?: number }[] };
    const judged = tol.bodies.filter((r) => r.class !== 'pinned');
    expect(judged.length).toBe(29);
    const lines: string[] = [];
    for (const row of judged) {
      const cls = tol.classes[row.class]!;
      const maxAngle = row.angleDeg ?? cls.angleDeg;
      const maxRadial = row.radial ?? cls.radial;
      let angle = 0;
      let radial = 0;
      for (const [ut, x, y, z] of truth.bodies[row.id]!.rows as [number, number, number, number][]) {
        const m = sys.stateRelParent(row.id, ut).r;
        const r = { x, y, z };
        angle = Math.max(angle, v3.angle(m, r) / DEG);
        radial = Math.max(radial, Math.abs(v3.len(m) - v3.len(r)) / v3.len(r));
      }
      lines.push(`${row.id} ${angle.toFixed(4)} deg (<= ${maxAngle}), ${(radial * 100).toFixed(3)} % (<= ${(maxRadial * 100).toFixed(1)} %)`);
      expect(angle, row.id).toBeLessThanOrEqual(maxAngle);
      expect(radial, row.id).toBeLessThanOrEqual(maxRadial);
    }
    if (process.env['SOLAR_SYSTEM_VERBOSE']) console.log(lines.join('\n'));
  });
});

describe("the Sun's direction at the Earth (inverted Almanac orbit)", () => {
  it('declination within 0.0035 deg of the v1 value over 2029-2031 (and the same direction to rounding)', () => {
    const a = staged.system;
    const b = shipped.system;
    const earth = 'earth';
    let worstDec = 0;
    let worstAngle = 0;
    const t0 = utOf(2029, 1, 1);
    const t1 = utOf(2031, 1, 1);
    for (let k = 0; k <= 2000; k++) {
      const ut = t0 + ((t1 - t0) * k) / 2000;
      // a point on the Earth's surface under the Sun's sub-point direction: the pad's view of the Sun
      const dV1 = b.sunDirection(b.stateRoot(earth, ut).r, ut).dir;
      const dV2 = a.sunDirection(a.stateRoot(earth, ut).r, ut).dir;
      worstDec = Math.max(worstDec, Math.abs(Math.asin(dV1.z) - Math.asin(dV2.z)) / DEG);
      worstAngle = Math.max(worstAngle, v3.angle(dV1, dV2));
    }
    expect(worstDec).toBeLessThan(0.0035);
    expect(worstAngle).toBeLessThan(1e-12);
  });

  it('the Earth has an osculating heliocentric conic (the v1 star on the formula has none)', () => {
    const c = staged.system.orbitConic('earth', utOf(2030, 6, 1))!;
    expect(c).not.toBeNull();
    expect(c.a / AU).toBeGreaterThan(0.99);
    expect(c.a / AU).toBeLessThan(1.01);
    expect(c.e).toBeLessThan(0.03);
  });
});

describe('shapes, surfaces and warp limits', () => {
  it('surfaceRadius follows the spheroid (Jupiter equator and pole) and is the radius for a sphere', () => {
    const j = staged.defs.bodies['jupiter']!;
    expect(surfaceRadius(j, { x: 1, y: 0, z: 0 })).toBeCloseTo(j.shape!.equatorialRadius, 6);
    expect(surfaceRadius(j, { x: 0, y: 0, z: 5 })).toBeCloseTo(j.shape!.polarRadius, 6);
    const lat = 45 * DEG;
    const rr = surfaceRadius(j, { x: Math.cos(lat), y: 0, z: Math.sin(lat) });
    expect(rr).toBeLessThan(j.shape!.equatorialRadius);
    expect(rr).toBeGreaterThan(j.shape!.polarRadius);
    const earth = staged.defs.bodies['earth']!;
    expect(surfaceRadius(earth, { x: 0.3, y: 0.4, z: 0.5 })).toBe(earth.radius);
  });

  it("the giants have no surface and a floor; a vessel below it is reported, one above it is not", () => {
    for (const id of ['jupiter', 'saturn', 'uranus', 'neptune']) {
      const b = staged.defs.bodies[id]!;
      expect(staged.system.body(id).surface).toBe('none');
      const f = floorAltitude(b)!;
      expect(f).toBeLessThan(0);
      const dir = { x: 0, y: 0.6, z: 0.8 };
      const R = surfaceRadius(b, dir);
      expect(belowFloor(b, v3.scale(dir, R + f - 1000))).toBe(true);
      expect(belowFloor(b, v3.scale(dir, R + f + 1000))).toBe(false);
    }
    expect(belowFloor(staged.defs.bodies['mars']!, { x: 1, y: 0, z: 0 })).toBe(false);
  });

  it('rails limits: one per rails level for every attractor, the shipped lists kept, defaults non-decreasing from the atmosphere top', () => {
    const sys = staged.system;
    for (const id of sys.ids) {
      const lim = sys.body(id).warpAltitudeLimits;
      expect(lim.length).toBe(RAILS_WARP_LEVEL_COUNT);
      for (let k = 1; k < lim.length; k++) expect(lim[k]!).toBeGreaterThanOrEqual(lim[k - 1]!);
      const def: BodyDef = staged.defs.bodies[id]!;
      if (def.atmosphere) expect(lim[0]!).toBeGreaterThanOrEqual(def.atmosphere.simTop);
    }
    const earth = shipped.defs.bodies['earth']!;
    expect(warpAltitudeLimitsOf(earth).slice(0, earth.warpAltitudeLimits!.length)).toEqual(earth.warpAltitudeLimits);
    // Phobos: rails warp from a few tens of metres up; the highest level only far outside its tiny sphere
    const phobos = staged.defs.bodies['phobos']!;
    expect(maxWarpIndexForAltitude(phobos, 100)).toBeGreaterThan(3);
  });
});

describe('sunVisibility restricted to the planet system', () => {
  it('in the Earth system it is v1 (Earth and Moon occult); a heliocentric point sees the planets only', () => {
    const a = staged.system;
    const b = shipped.system;
    const ut = utOf(2030, 3, 20, 12);
    // A point in the Earth's shadow, 10,000 km behind it (umbra): 0 in both
    const anti = v3.neg(a.sunDirection(a.stateRoot('earth', ut).r, ut).dir);
    const inShadowStaged = v3.add(a.stateRoot('earth', ut).r, v3.scale(anti, 1e7));
    const inShadowShipped = v3.scale(anti, 1e7);
    expect(a.sunVisibility(inShadowStaged, ut, 'earth')).toBe(0);
    expect(a.sunVisibility(inShadowStaged, ut)).toBe(0);
    expect(b.sunVisibility(inShadowShipped, ut)).toBe(0);
    // A point beside the Earth, lit
    const side = v3.add(a.stateRoot('earth', ut).r, v3.scale(v3.normalize(v3.cross(anti, { x: 0, y: 0, z: 1 })), 1e7));
    expect(a.sunVisibility(side, ut)).toBe(1);
    // Behind Jupiter, inside its SOI, its moons' system
    const janti = v3.neg(a.sunDirection(a.stateRoot('jupiter', ut).r, ut).dir);
    expect(a.sunVisibility(v3.add(a.stateRoot('jupiter', ut).r, v3.scale(janti, 2e8)), ut)).toBe(0);
  });
});

describe('the boundary queries', () => {
  it("'lost' beyond the lost distance on an escape trajectory about the root; 'photosphere' inside the star; else null", () => {
    const sys = staged.system;
    const lost = 100 * AU;
    const mu = sys.body('sun').mu;
    const r = { x: 101 * AU, y: 0, z: 0 };
    const vEsc = Math.sqrt((2 * mu) / v3.len(r));
    expect(sys.boundaryOf('sun', r, { x: vEsc * 1.01, y: 0, z: 0 }, lost)).toBe('lost');
    expect(sys.boundaryOf('sun', r, { x: vEsc * 0.9, y: 0, z: 0 }, lost)).toBeNull();
    expect(sys.boundaryOf('sun', { x: 99 * AU, y: 0, z: 0 }, { x: vEsc * 2, y: 0, z: 0 }, lost)).toBeNull();
    expect(sys.boundaryOf('sun', { x: 6.9e8, y: 0, z: 0 }, { x: 0, y: 1e5, z: 0 }, lost)).toBe('photosphere');
    expect(sys.boundaryOf('earth', { x: 7e6, y: 0, z: 0 }, { x: 0, y: 8000, z: 0 }, lost)).toBeNull();
  });
});

describe('orientation of the new bodies', () => {
  it('every body has a unit orientation quaternion and a finite spin', () => {
    for (const id of staged.system.ids) {
      const q = staged.system.orientation(id, utOf(2031, 5, 5));
      expect(Math.hypot(q.x, q.y, q.z, q.w)).toBeCloseTo(1, 12);
      expect(Number.isFinite(v3.len(staged.system.spin(id)))).toBe(true);
      expect(quat.rotate(q, { x: 1, y: 0, z: 0 }).x).not.toBeNaN();
    }
  });
});
