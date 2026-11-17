/**
 * The foam a hull churns at its waterline (OceanVessels' wake): by its speed through the water, not by the time it
 * lies in it. The input that made a white patch metres wide around the capsule after the splashdown, and with it
 * the camera's exposure fall: a hull floating at rest, fully wet, under the test pilot's physics warp (0.07 s of
 * simulation per frame).
 */
import { describe, expect, it } from 'vitest';
import { WAKE_FULL_SPEED, wakeChurn } from '@/render/ocean/vessels';

describe('wake churn', () => {
  it('a hull at rest churns nothing, whatever the time step', () => {
    for (const dt of [0, 1 / 60, 0.07, 0.25, 4]) {
      expect(wakeChurn(1, dt, 0)).toBe(0);
      expect(wakeChurn(0.5, dt, 0)).toBe(0);
    }
    // Sixty frames of a capsule lying in the swell at warp x4 (the offending input): no foam builds up.
    let ring = 0;
    for (let i = 0; i < 60; i++) ring = Math.min(1, ring * Math.exp(-0.07 / 25) + wakeChurn(1, 0.07, 0));
    expect(ring).toBe(0);
  });

  it('a drifting capsule leaves a thin ring, a moving hull the whole one', () => {
    // Steady state of the ring's foam (decay 25 s) for a capsule drifting at 0.4 m/s and for a hull at 2 m/s.
    const steady = (speed: number): number => {
      let ring = 0;
      for (let i = 0; i < 6000; i++) ring = Math.min(1, ring * Math.exp(-(1 / 60) / 25) + wakeChurn(1, 1 / 60, speed));
      return ring;
    };
    expect(steady(0.4)).toBeGreaterThan(0.3);
    expect(steady(0.4)).toBeLessThan(0.7);
    expect(steady(0.1)).toBeLessThan(0.05);
    expect(steady(WAKE_FULL_SPEED)).toBe(1);
    expect(wakeChurn(1, 1 / 60, WAKE_FULL_SPEED)).toBeCloseTo(0.01, 6);
    expect(wakeChurn(1, 1 / 60, 50)).toBeCloseTo(0.01, 6);
  });

  it('grows with the speed and the wet share, and is nothing for inputs that are not numbers', () => {
    for (let v = 0.1; v < 2; v += 0.1) expect(wakeChurn(1, 0.02, v + 0.1)).toBeGreaterThan(wakeChurn(1, 0.02, v));
    expect(wakeChurn(0.2, 0.02, 1)).toBeLessThan(wakeChurn(0.5, 0.02, 1));
    expect(wakeChurn(0, 0.02, 1)).toBe(0);
    for (const bad of [Number.NaN, -1, Number.NEGATIVE_INFINITY]) {
      expect(wakeChurn(bad, 0.02, 1)).toBe(0);
      expect(wakeChurn(1, bad, 1)).toBe(0);
      expect(wakeChurn(1, 0.02, bad)).toBe(0);
    }
    expect(wakeChurn(1, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY)).toBe(1);
  });
});
