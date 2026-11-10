import { describe, expect, it } from 'vitest';
import type { Patch } from '@/core/contracts/sim';
import { conicFromState, conicPosition, conicTrueAnomaly, timeSincePeriapsis, type ConicElements } from '@/core/math/conic';
import { v3 } from '@/core/math/vec3';
import { forwardTime, patchContainsAnomaly, utAtTrueAnomaly } from './anomalyTime';
import { stateAt } from './testing/kepler';

const MU = 3.986004418e14;
const T0 = 8.89e8;

function ellipse(rp: number, e: number): ConicElements {
  return conicFromState(MU, { x: rp, y: 0, z: 0 }, { x: 0, y: Math.sqrt((MU * (1 + e)) / rp), z: 0 }, T0 - 1000);
}

function patchOn(c: ConicElements, tStart: number, revs = 1): Patch {
  const nuStart = conicTrueAnomaly(c, stateAt(c, tStart).r);
  return { bodyId: 'earth', conic: c, tStart, tEnd: tStart + revs * (c.period ?? 0), nuStart, nuEnd: nuStart + 2 * Math.PI * revs, endReason: 'closed', bodyPosAtEnd: v3.zero(), markers: [] };
}

describe('true anomaly -> time on the right revolution', () => {
  const c = ellipse(6.771e6, 0.3);
  const P = c.period!;

  it('maps a point ahead of the vessel into the first lap after the patch start', () => {
    const p = patchOn(c, T0); // vessel ~1000 s after periapsis
    for (const dtAhead of [10, 600, 0.25 * P, 0.5 * P, 0.9 * P]) {
      const nu = conicTrueAnomaly(c, stateAt(c, T0 + dtAhead).r);
      expect(utAtTrueAnomaly(p, nu)).toBeCloseTo(T0 + dtAhead, 4);
    }
  });

  it('a point just behind the vessel is almost one period ahead, never in the past', () => {
    const p = patchOn(c, T0);
    const nu = conicTrueAnomaly(c, stateAt(c, T0 - 30).r);
    const ut = utAtTrueAnomaly(p, nu);
    expect(ut).toBeGreaterThan(T0);
    expect(ut).toBeCloseTo(T0 + P - 30, 4);
  });

  it('crossing apoapsis (nu wrapping from +pi to -pi) stays on the same lap', () => {
    const p = patchOn(c, T0);
    const tApo = T0 - 1000 + P / 2; // periapsis was 1000 s before T0
    for (const d of [-200, -1, 1, 200]) {
      const nu = conicTrueAnomaly(c, stateAt(c, tApo + d).r);
      expect(utAtTrueAnomaly(p, nu)).toBeCloseTo(tApo + d, 4);
    }
  });

  it('works with unwrapped patch anomalies (a patch starting several revolutions in)', () => {
    const p = patchOn(c, T0);
    const shifted: Patch = { ...p, nuStart: p.nuStart + 6 * Math.PI, nuEnd: p.nuEnd + 6 * Math.PI };
    const nu = conicTrueAnomaly(c, stateAt(c, T0 + 1234).r);
    expect(utAtTrueAnomaly(shifted, nu)).toBeCloseTo(T0 + 1234, 4);
  });

  it('dragging resolves to the lap closest to the previous time', () => {
    const p = patchOn(c, T0, 3);
    const nu = conicTrueAnomaly(c, stateAt(c, T0 + 500).r);
    expect(utAtTrueAnomaly(p, nu, T0 + 2 * P + 400)).toBeCloseTo(T0 + 2 * P + 500, 4);
    expect(utAtTrueAnomaly(p, nu, T0 + P - 100)).toBeCloseTo(T0 + P + 500, 4);
  });

  it('hyperbolic arcs map one-to-one', () => {
    const h = conicFromState(MU, { x: 7e6, y: 0, z: 0 }, { x: 0, y: 12e3, z: 0 }, T0);
    const nuStart = -1.2;
    const tStart = T0 + (timeSincePeriapsis(h, nuStart) - 0);
    const p: Patch = { bodyId: 'earth', conic: h, tStart, tEnd: tStart + 1e5, nuStart, nuEnd: 1.5, endReason: 'soiExit', bodyPosAtEnd: v3.zero(), markers: [] };
    for (const nu of [-1.1, -0.3, 0, 0.8, 1.4]) {
      expect(utAtTrueAnomaly(p, nu)).toBeCloseTo(T0 + timeSincePeriapsis(h, nu), 4);
    }
    expect(forwardTime(h, 0.5, 0.2)).toBeLessThan(0);
  });

  it('knows which anomalies a patch covers', () => {
    const p = patchOn(c, T0);
    expect(patchContainsAnomaly(p, 2)).toBe(true);
    const arc: Patch = { ...p, nuStart: 1, nuEnd: 2, endReason: 'impact' };
    expect(patchContainsAnomaly(arc, 1.5)).toBe(true);
    expect(patchContainsAnomaly(arc, 2.5)).toBe(false);
    expect(patchContainsAnomaly(arc, 1.5 + 2 * Math.PI)).toBe(true);
    expect(v3.len(conicPosition(c, 0))).toBeCloseTo(6.771e6, 3);
  });
});
