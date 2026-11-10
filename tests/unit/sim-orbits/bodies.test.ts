import { beforeAll, describe, expect, it } from 'vitest';
import type { BodyDef, DefLibrary } from '../../../src/core/contracts/defs';
import { quat } from '../../../src/core/math/quat';
import { DEG, RAD } from '../../../src/core/math/scalar';
import { v3 } from '../../../src/core/math/vec3';
import { atmosphereAt, atmosphereModelRaw } from '../../../src/sim/bodies/atmosphere';
import { createBodySystem, type BodySystem } from '../../../src/sim/bodies/bodySystem';
import { occultedFraction, sunVisibleFraction } from '../../../src/sim/bodies/sunVisibility';
import { primeMeridianAngle } from '../../../src/sim/bodies/rotation';
import { latLonAlt } from '../../../src/sim/frames/bodyFrames';
import { padState } from '../../../src/sim/frames/padState';
import { orbitalEnvironment } from '../../../src/sim/bodies/environment';
import { loadWorld, mainIds, utOf } from './fixtures';

let defs: DefLibrary;
let sys: BodySystem;
let EARTH = '';
let MOON = '';
let SUN = '';
const T_REF = utOf(2028, 3, 1);

beforeAll(async () => {
  ({ defs, system: sys } = await loadWorld());
  ({ root: EARTH, moon: MOON, star: SUN } = mainIds(sys));
});

describe('Moon ephemeris', () => {
  it('period 27.285 d +/- 0.01', () => {
    const k = sys.body(MOON).kepler!;
    expect(Math.abs(k.period / 86400 - 27.285)).toBeLessThan(0.01);
    const a = sys.stateRelParent(MOON, T_REF).r;
    const b = sys.stateRelParent(MOON, T_REF + k.period).r;
    expect(v3.dist(a, b)).toBeLessThan(1e-3);
  });

  it('perigee 363,300 km and apogee 405,500 km +/- 500 km', () => {
    const P = sys.body(MOON).kepler!.period;
    let min = Infinity;
    let max = 0;
    for (let i = 0; i < 20000; i++) {
      const d = v3.len(sys.stateRelParent(MOON, T_REF + (P * i) / 20000).r);
      min = Math.min(min, d);
      max = Math.max(max, d);
    }
    expect(Math.abs(min / 1000 - 363300)).toBeLessThan(500);
    expect(Math.abs(max / 1000 - 405500)).toBeLessThan(500);
  });

  it("inclination to Earth's equator 20.9 +/- 0.1 deg", () => {
    const n = sys.body(MOON).kepler!.normal;
    expect(Math.abs(v3.angle(n, v3.unitZ()) * RAD - 20.9)).toBeLessThan(0.1);
    const c = sys.orbitConic(MOON, T_REF)!;
    expect(Math.abs(c.inc * RAD - 20.9)).toBeLessThan(0.1);
  });

  it('velocity is the time derivative of position (Moon and Sun)', () => {
    for (const id of [MOON, SUN]) {
      const s = sys.stateRelParent(id, T_REF);
      const a = sys.stateRelParent(id, T_REF - 1).r;
      const b = sys.stateRelParent(id, T_REF + 1).r;
      const num = v3.scale(v3.sub(b, a), 0.5);
      expect(v3.dist(num, s.v) / v3.len(s.v)).toBeLessThan(1e-6);
    }
  });

  it('is tidally locked: sub-Earth point librates within +/- 8 deg around (0, 0)', () => {
    let maxLat = 0;
    let maxLon = 0;
    let sumLon = 0;
    let n = 0;
    for (let t = T_REF; t < T_REF + 200 * 86400; t += 6 * 3600) {
      const toEarth = v3.neg(sys.stateRelParent(MOON, t).r);
      const f = quat.rotateInv(sys.orientation(MOON, t), toEarth);
      const ll = latLonAlt(f, 1);
      maxLat = Math.max(maxLat, Math.abs(ll.latitude * RAD));
      maxLon = Math.max(maxLon, Math.abs(ll.longitude * RAD));
      sumLon += ll.longitude * RAD;
      n++;
    }
    expect(maxLat).toBeLessThan(8);
    expect(maxLon).toBeLessThan(8);
    // libration is real: ~6.3 deg in longitude (eccentricity), several degrees in latitude (pole tilt)
    expect(maxLon).toBeGreaterThan(5);
    expect(maxLat).toBeGreaterThan(4);
    expect(Math.abs(sumLon / n)).toBeLessThan(1);
  });

  it('SOI radius is the data value; "auto" gives a (m/M)^0.4', () => {
    expect(sys.body(MOON).soiRadius).toBe(defs.bodies[MOON]!.soiRadius);
    const auto: DefLibrary = { ...defs, bodies: { ...defs.bodies, [MOON]: { ...defs.bodies[MOON]!, soiRadius: 'auto' } } };
    const s2 = createBodySystem(auto);
    const m = defs.bodies[MOON]!;
    const a = (m.orbit as { a: number }).a;
    expect(s2.body(MOON).soiRadius).toBeCloseTo(a * Math.pow(m.mu / defs.bodies[EARTH]!.mu, 0.4), 6);
    expect(Math.abs(s2.body(MOON).soiRadius! - 66.1e6)).toBeLessThan(0.3e6);
  });
});

describe('Earth rotation', () => {
  it('sidereal day 86,164.09 s', () => {
    const rot = sys.body(EARTH).rotation;
    if (rot.kind !== 'uniform') throw new Error('expected uniform rotation');
    const day = (2 * Math.PI) / rot.rate;
    expect(Math.abs(day - 86164.09)).toBeLessThan(0.01);
    const q0 = sys.orientation(EARTH, T_REF);
    const q1 = sys.orientation(EARTH, T_REF + day);
    expect(quat.angleBetween(q0, q1)).toBeLessThan(1e-9);
  });

  it('prime meridian follows GMST (w0 = 190.46 deg + 90 deg node offset)', () => {
    const rot = sys.body(EARTH).rotation;
    if (rot.kind !== 'uniform') throw new Error('expected uniform rotation');
    // At J2000.0 GMST = 280.46061837 deg: the prime meridian (BCBF +X) points at RA 280.46 deg.
    const x = quat.rotate(sys.orientation(EARTH, 0), v3.unitX());
    expect(Math.abs(((Math.atan2(x.y, x.x) * RAD + 360) % 360) - 280.46061837)).toBeLessThan(1e-9);
    expect(primeMeridianAngle(rot, 0) * RAD).toBeCloseTo(190.46061837, 9);
  });

  it('pad inertial speed 465.1 cos(lat) +/- 0.5 m/s, at rest relative to the ground', () => {
    const site = Object.values(defs.sites)[0]!;
    const pad = padState(sys, site, T_REF, 0);
    const lat = site.location.latDeg * DEG;
    expect(Math.abs(v3.len(pad.v) - 465.1 * Math.cos(lat))).toBeLessThan(0.5);
    // exactly omega (R + h) cos(lat) for the 6371 km datum sphere
    const rot = sys.body(EARTH).rotation as { rate: number };
    expect(v3.len(pad.v)).toBeCloseTo(rot.rate * defs.bodies[EARTH]!.radius * Math.cos(lat), 9);
  });
});

describe('low-precision Sun', () => {
  // UTC instants of the 2024 and 2025 equinoxes and solstices.
  const events: [number, number][] = [
    [utOf(2024, 3, 20, 3, 6), 0],
    [utOf(2024, 6, 20, 20, 51), 23.4362],
    [utOf(2024, 9, 22, 12, 44), 0],
    [utOf(2024, 12, 21, 9, 20), -23.4362],
    [utOf(2025, 3, 20, 9, 1), 0],
    [utOf(2025, 6, 21, 2, 42), 23.4362],
    [utOf(2025, 9, 22, 18, 19), 0],
    [utOf(2025, 12, 21, 15, 3), -23.4362],
  ];
  it('declination at solstices and equinoxes within 0.05 deg', () => {
    for (const [ut, dec] of events) {
      const s = sys.stateRoot(SUN, ut).r;
      const d = Math.asin(s.z / v3.len(s)) * RAD;
      expect(Math.abs(d - dec)).toBeLessThan(0.05);
    }
  });
  it('distance within the perihelion/aphelion range', () => {
    for (let k = 0; k < 24; k++) {
      const d = v3.len(sys.stateRoot(SUN, T_REF + k * 15.2 * 86400).r);
      expect(d).toBeGreaterThan(1.4709e11);
      expect(d).toBeLessThan(1.5210e11);
    }
  });
});

describe('sun visibility', () => {
  it('circle overlap: limits and known geometries', () => {
    const rs = 0.0047;
    expect(occultedFraction(rs, 0.01, 0.02)).toBe(0);
    expect(occultedFraction(rs, 0.01, 0)).toBe(1);
    // annular: ratio of the cap areas, 2 pi (1 - cos r); the tangent-plane model is good to O(r^2) ~ 1e-5
    expect(occultedFraction(rs, 0.002, 0)).toBeCloseTo((1 - Math.cos(0.002)) / (1 - Math.cos(rs)), 5);
    // straight limb through the Sun's centre (rb = 90 deg): exactly half
    expect(occultedFraction(rs, Math.PI / 2, Math.PI / 2)).toBeCloseTo(0.5, 12);
    // equal small circles, centres one radius apart: lens area 2 r^2 (pi/3 - sqrt(3)/4)
    const lens = (2 * (Math.PI / 3 - Math.sqrt(3) / 4)) / Math.PI;
    expect(occultedFraction(rs, rs * 1.0000001, rs * 1.0000001 + rs)).toBeCloseTo(0, 6);
    expect(occultedFraction(1e-3, 1e-3, 1e-3)).toBeCloseTo(lens, 6);
    // monotonic through an eclipse
    let prev = -1;
    for (let s = 0.03; s >= 0; s -= 0.0005) {
      const f = occultedFraction(rs, 0.0045, s);
      expect(f).toBeGreaterThanOrEqual(prev - 1e-12);
      prev = f;
    }
  });

  it('pad: lit by day, dark at night, partial at sunrise', () => {
    const site = Object.values(defs.sites)[0]!;
    let sawDay = false;
    let sawNight = false;
    let sawPartial = false;
    for (let t = T_REF; t < T_REF + 86400; t += 20) {
      const pad = padState(sys, site, t, 0, 2);
      const pos = v3.add(sys.stateRoot(EARTH, t).r, pad.r);
      const vis = sys.sunVisibility(pos, t);
      const sun = sys.sunDirection(pos, t).dir;
      const elev = Math.asin(v3.dot(sun, pad.enu.up)) * RAD;
      if (elev > 1) {
        expect(vis).toBe(1);
        sawDay = true;
      } else if (elev < -1) {
        expect(vis).toBe(0);
        sawNight = true;
      } else if (vis > 0 && vis < 1) sawPartial = true;
    }
    expect(sawDay && sawNight && sawPartial).toBe(true);
  });

  it("vessel in Earth's shadow: umbra behind Earth, penumbra at the shadow edge", () => {
    const sun = sys.stateRoot(SUN, T_REF).r;
    const anti = v3.normalize(v3.neg(sun));
    const R = defs.bodies[EARTH]!.radius;
    expect(sys.sunVisibility(v3.scale(anti, R + 400e3), T_REF)).toBe(0);
    expect(sys.sunVisibility(v3.scale(v3.normalize(sun), R + 400e3), T_REF)).toBe(1);
    // Scan across the shadow edge at 400 km (edge near asin(R / (R + 400 km)) = 70 deg off the axis):
    // visibility rises monotonically from 0 to 1 through a penumbra.
    const side = v3.normalize(v3.cross(anti, v3.unitZ()));
    let prev = -1;
    let partial = 0;
    for (let a = 0; a <= 90 * DEG; a += 0.01 * DEG) {
      const p = v3.scale(v3.add(v3.scale(anti, Math.cos(a)), v3.scale(side, Math.sin(a))), R + 400e3);
      const vis = sys.sunVisibility(p, T_REF);
      expect(vis).toBeGreaterThanOrEqual(prev - 1e-9);
      if (vis > 0 && vis < 1) partial++;
      prev = vis;
    }
    expect(prev).toBe(1);
    expect(partial).toBeGreaterThan(3);
  });

  it('a surface point below the datum (lunar maria) still has day and night', () => {
    const R = defs.bodies[MOON]!.radius;
    let day = 0;
    let night = 0;
    for (let t = T_REF; t < T_REF + 30 * 86400; t += 6 * 3600) {
      const q = sys.orientation(MOON, t);
      const up = quat.rotate(q, { x: Math.cos(23.4 * DEG), y: Math.sin(23.4 * DEG), z: 0 });
      const pos = v3.add(sys.stateRoot(MOON, t).r, v3.scale(up, R - 1908));
      const vis = sys.sunVisibility(pos, t);
      const elev = Math.asin(v3.dot(up, sys.sunDirection(pos, t).dir)) * RAD;
      if (elev > 1) {
        expect(vis).toBe(1);
        day++;
      } else if (elev < -1) {
        expect(vis).toBe(0);
        night++;
      }
    }
    expect(day).toBeGreaterThan(20);
    expect(night).toBeGreaterThan(20);
  });

  it('two occulters at once: strip integration agrees with the single-body formula', () => {
    const star = { x: 1.5e11, y: 0, z: 0 };
    const sr = 6.957e8;
    const one = sunVisibleFraction({ x: 0, y: 0, z: 0 }, star, sr, [{ centre: { x: 4e8, y: 0.6e6, z: 0 }, radius: 1.7374e6 }]);
    const both = sunVisibleFraction({ x: 0, y: 0, z: 0 }, star, sr, [
      { centre: { x: 4e8, y: 0.6e6, z: 0 }, radius: 1.7374e6 },
      { centre: { x: 4e8, y: 1e9, z: 0 }, radius: 1.7374e6 }, // far off the disc
    ]);
    expect(both).toBeCloseTo(one, 12);
    const twoOn = sunVisibleFraction({ x: 0, y: 0, z: 0 }, star, sr, [
      { centre: { x: 4e8, y: 0.6e6, z: 0 }, radius: 1.7374e6 },
      { centre: { x: 3e8, y: -0.5e6, z: 0 }, radius: 1.0e6 },
    ]);
    expect(twoOn).toBeLessThan(one);
    expect(twoOn).toBeGreaterThan(0);
  });
});

describe('atmosphere models', () => {
  let earth: BodyDef;
  beforeAll(() => {
    earth = defs.bodies[EARTH]!;
  });
  // [km, T K, p Pa, rho kg/m^3] - U.S. Standard Atmosphere 1976, geometric altitude.
  const table: [number, number, number, number][] = [
    [0, 288.15, 101325, 1.225],
    [11, 216.774, 22700.0, 0.364802],
    [20, 216.65, 5529.31, 0.0889099],
    [32, 228.49, 889.064, 0.0135552],
    [47, 269.684, 115.851, 0.00149652],
    [51, 270.65, 70.458, 0.000906902],
    [71, 216.846, 4.47956, 7.19652e-5],
    [86, 186.87, 0.3734, 6.958e-6],
    [100, 195.08, 0.03201, 5.604e-7],
    [150, 634.39, 4.542e-4, 2.076e-9],
  ];
  it('USSA-76 within 0.1 % of the standard tables', () => {
    for (const [km, T, p, rho] of table) {
      const s = atmosphereModelRaw(earth, km * 1000);
      expect(Math.abs(s.temperature / T - 1)).toBeLessThan(1e-3);
      expect(Math.abs(s.pressure / p - 1)).toBeLessThan(1e-3);
      expect(Math.abs(s.density / rho - 1)).toBeLessThan(1e-3);
    }
  });
  it('faded sample equals the model below the fade band and is zero at simTop', () => {
    const top = earth.atmosphere!.simTop;
    for (const km of [0, 11, 47, 86, 100, 125]) {
      expect(atmosphereAt(earth, km * 1000).density).toBe(atmosphereModelRaw(earth, km * 1000).density);
    }
    expect(atmosphereAt(earth, top).density).toBe(0);
    expect(atmosphereAt(earth, top + 1).density).toBe(0);
    expect(atmosphereAt(earth, top - 1).density).toBeGreaterThan(0);
    expect(atmosphereAt(earth, top - 1).density).toBeLessThan(1e-14);
    // smooth and monotonic through the fade band
    let prev = Infinity;
    for (let h = top - 12000; h <= top; h += 100) {
      const d = atmosphereAt(earth, h).density;
      expect(d).toBeLessThanOrEqual(prev);
      prev = d;
    }
  });
  it('speed of sound: sqrt(gamma R T) below 86 km, 275 m/s above; Moon is vacuum', () => {
    const s = atmosphereAt(earth, 0);
    expect(s.speedOfSound).toBeCloseTo(Math.sqrt(1.4 * 287.053 * 288.15), 6);
    expect(atmosphereAt(earth, 100e3).speedOfSound).toBe(275);
    expect(atmosphereAt(defs.bodies[MOON]!, 0).density).toBe(0);
  });
  it("'table' and 'exponential' models", () => {
    const base = earth.atmosphere!;
    const tab: BodyDef = {
      ...earth,
      id: 'tab-body',
      atmosphere: { ...base, model: 'table', simTop: 100e3, table: [{ hKm: 0, rho: 1, p: 1e5, T: 300 }, { hKm: 10, rho: 0.1, p: 1e4, T: 250 }, { hKm: 50, rho: 1e-4, p: 10, T: 200 }] },
    };
    const m = atmosphereAt(tab, 5000);
    expect(m.density).toBeCloseTo(Math.sqrt(0.1), 12);
    expect(m.pressure).toBeCloseTo(Math.sqrt(1e9), 6);
    expect(m.temperature).toBeCloseTo(275, 12);
    expect(atmosphereAt(tab, 0).density).toBeCloseTo(1, 12);
    const ex: BodyDef = { ...earth, id: 'exp-body', atmosphere: { ...base, model: 'exponential', simTop: 120e3, rho0: 0.02, p0: 600, scaleHeight: 11000 } };
    const e = atmosphereAt(ex, 22000);
    expect(e.density).toBeCloseTo(0.02 * Math.exp(-2), 14);
    expect(e.pressure).toBeCloseTo(600 * Math.exp(-2), 10);
    expect(e.temperature).toBeCloseTo(600 / (0.02 * base.gasConstant), 9);
    expect(atmosphereAt(ex, 120e3).density).toBe(0);
  });
});

describe('orbital environment', () => {
  it('gives the body-system members of VesselEnvironment', () => {
    const site = Object.values(defs.sites)[0]!;
    const pad = padState(sys, site, T_REF, 0, 2);
    const env = orbitalEnvironment(sys, EARTH, T_REF, pad.r);
    expect(env.mu).toBe(defs.bodies[EARTH]!.mu);
    expect(env.radius).toBe(defs.bodies[EARTH]!.radius);
    expect(env.atmosphereAt(0).density).toBeCloseTo(1.225, 4); // R = 8.314462 (sim-design 8.1), not the 8.31432 of 1976
    expect(env.heating).toBe(defs.bodies[EARTH]!.atmosphere!.heating);
    expect(quat.angleBetween(env.qFixedToInertial, sys.orientation(EARTH, T_REF))).toBe(0);
    expect(env.sunVisibility).toBe(sys.sunVisibility(pad.r, T_REF));
    const moonEnv = orbitalEnvironment(sys, MOON, T_REF, { x: 2e6, y: 0, z: 0 });
    expect(moonEnv.heating).toBeNull();
    expect(moonEnv.atmosphereAt(0).density).toBe(0);
    expect(v3.len(moonEnv.sunDir)).toBeCloseTo(1, 12);
  });
});

describe('body snapshots', () => {
  it('one per body, consistent with the system', () => {
    const snaps = sys.buildBodySnapshots(T_REF);
    expect(snaps.map((s) => s.id)).toEqual([...sys.ids]);
    const moon = snaps.find((s) => s.id === MOON)!;
    expect(v3.dist(moon.rRoot, sys.stateRoot(MOON, T_REF).r)).toBe(0);
    expect(moon.orbit).not.toBeNull();
    expect(Math.abs(moon.orbit!.tPeriapsis - T_REF)).toBeLessThanOrEqual(moon.orbit!.period! / 2);
    expect(moon.soiRadius).toBe(sys.body(MOON).soiRadius);
    const earth = snaps.find((s) => s.id === EARTH)!;
    expect(earth.orbit).toBeNull();
    expect(earth.soiRadius).toBeNull();
    expect(v3.len(earth.sunDir)).toBeCloseTo(1, 12);
    const sun = snaps.find((s) => s.id === SUN)!;
    expect(sun.orbit).toBeNull();
    expect(sun.sunDistance).toBe(0);
    expect(v3.len(earth.spinRoot)).toBeCloseTo(7.2921159e-5, 12);
  });
});
