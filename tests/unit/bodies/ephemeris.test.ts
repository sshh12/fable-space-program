/**
 * The generator's orbit evaluator against the v1 runtime (src/sim/bodies), so that its Horizons validation
 * judges the staged definitions as the body system will evaluate them; and the acceptance line on Earth: its
 * staged orbit (the v1 Almanac Sun, inverted) reproduces the v1 Sun direction at 1,000 instants over 2029-2031.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { KeplerOrbitDef, OrbitDef } from '../../../src/core/contracts/defs';
import { quat } from '../../../src/core/math/quat';
import { KeplerEphemeris, Q_ECLIPTIC_TO_EQUATORIAL, sunLowPrecisionState } from '../../../src/sim/bodies/ephemeris';
import { poleQuat } from '../../../src/sim/bodies/rotation';
import { angleBetween, keplerState, matVec, orbitState, poleFrame, type V3 } from '../../../tools/bodies/lib/kepler.mjs';

const ROOT = join(__dirname, '../../..');
const staged = (id: string): { orbit: OrbitDef; mu: number; parent: string } => JSON.parse(readFileSync(join(ROOT, 'data/staged/bodies', `${id}.json`), 'utf8'));
const tuple = (v: { x: number; y: number; z: number }): V3 => [v.x, v.y, v.z];

/** ut of 2029-01-01T00:00 and 2031-01-01T00:00 (seconds since J2000.0). */
const UT_2029 = (Date.UTC(2029, 0, 1) - Date.UTC(2000, 0, 1, 12)) / 1000;
const UT_2031 = (Date.UTC(2031, 0, 1) - Date.UTC(2000, 0, 1, 12)) / 1000;

describe("Earth's staged orbit reproduces the v1 Sun direction", () => {
  it('at 1,000 instants over 2029-2031, to rounding', () => {
    const earth = staged('earth');
    expect(earth.orbit).toEqual({ kind: 'sunLowPrecision', inverted: true });
    let worst = 0;
    let worstDist = 0;
    for (let k = 0; k < 1000; k++) {
      const ut = UT_2029 + ((UT_2031 - UT_2029) * k) / 999;
      // v1: the Sun about the Earth. v2: the Earth about the Sun; the Sun seen from the Earth is minus that.
      const v1 = tuple(sunLowPrecisionState(ut).r);
      const earthAboutSun = orbitState(earth.orbit, ut).r;
      const sunFromEarth: V3 = [-earthAboutSun[0], -earthAboutSun[1], -earthAboutSun[2]];
      worst = Math.max(worst, angleBetween(v1, sunFromEarth));
      worstDist = Math.max(worstDist, Math.abs(Math.hypot(...v1) - Math.hypot(...sunFromEarth)));
    }
    expect(worst).toBeLessThan(1e-15);
    expect(worstDist).toBe(0);
  });
});

describe('tool orbit evaluator = runtime KeplerEphemeris', () => {
  it('frames: the pole frame and the ecliptic rotation equal the runtime quaternions', () => {
    for (const [ra, dec] of [[268.05, 64.49], [77.311, 15.175], [40.589, 83.537], [299.36, 43.46]] as const) {
      const q = poleQuat(ra, dec);
      const M = poleFrame(ra, dec);
      for (const v of [[1, 0, 0], [0, 1, 0], [0, 0, 1]] as V3[]) {
        const a = tuple(quat.rotate(q, { x: v[0], y: v[1], z: v[2] }));
        const b = matVec(M, v);
        for (let i = 0; i < 3; i++) expect(Math.abs(a[i]! - b[i]!)).toBeLessThan(1e-15);
      }
    }
    const e = tuple(quat.rotate(Q_ECLIPTIC_TO_EQUATORIAL, { x: 0, y: 1, z: 0 }));
    const f = orbitState({ kind: 'kepler', frame: 'ecliptic', a: 1, e: 0, iDeg: 0, lanDeg: 90, argPeDeg: 0, meanAnomalyDeg: 0, epochUt: 0 }, 0, { muSum: 1 }).r;
    for (let i = 0; i < 3; i++) expect(Math.abs(e[i]! - f[i]!)).toBeLessThan(1e-15);
  });

  it("the Moon's frozen ellipse (no rates, no fitted mean motion) evaluates as the runtime does", () => {
    const moon = staged('moon');
    const earth = staged('earth');
    const def = moon.orbit as KeplerOrbitDef;
    const eph = new KeplerEphemeris(def, earth.mu + moon.mu, Q_ECLIPTIC_TO_EQUATORIAL);
    for (const ut of [0, 938240818, 1.5e9, 1.9e9]) {
      const a = tuple(eph.stateAt(ut).r);
      const b = keplerState(def, ut, { muSum: earth.mu + moon.mu }).r;
      expect(Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])).toBeLessThan(1e-3);
    }
  });

  it('a body with a fitted mean motion: the runtime with n replaced by meanMotionDegPerDay gives the same state', () => {
    const io = staged('io');
    const def = io.orbit as KeplerOrbitDef;
    expect(def.meanMotionDegPerDay).toBeGreaterThan(0);
    // At the epoch the rates do not act; the runtime ephemeris with mu chosen so that sqrt(mu/a^3) = n matches.
    const n = (def.meanMotionDegPerDay! * Math.PI) / 180 / 86400;
    const mu = n * n * def.a ** 3;
    const frame = def.frame as { pole: { raDeg: number; decDeg: number } };
    const eph = new KeplerEphemeris(def, mu, poleQuat(frame.pole.raDeg, frame.pole.decDeg));
    for (const dt of [0, 3600, 86400]) {
      const ut = def.epochUt + dt;
      const a = tuple(eph.stateAt(ut).r);
      const noRates = { ...def, rates: undefined };
      const b = keplerState(noRates, ut).r;
      expect(Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])).toBeLessThan(1e-3);
    }
  });
});
