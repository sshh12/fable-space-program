import { describe, expect, it } from 'vitest';
import { runToRest } from './cameraRest';

describe('runToRest', () => {
  it('takes one step when the state is at rest already', () => {
    const r = runToRest(5, () => 5, String, 100);
    expect(r).toEqual({ value: 5, atRest: true, steps: 1 });
  });

  it('runs an exponential approach until a step changes nothing', () => {
    // What a rig does: x approaches its target by a fixed share per step (float64, so it stops moving).
    const approach = (start: number): { rest: ReturnType<typeof runToRest<number>>; x: number } => {
      let x = start;
      const rest = runToRest(x, () => (x += (120 - x) * 0.13), String, 5000);
      return { rest, x };
    };
    const a = approach(0);
    const again = approach(0);
    const b = approach(4000);
    expect(a.rest.atRest && b.rest.atRest).toBe(true);
    expect(a.rest.steps).toBeGreaterThan(100);
    expect(a.rest.steps).toBeLessThan(1000);
    // One more step at rest changes nothing: that is what "at rest" means here.
    expect(a.x + (120 - a.x) * 0.13).toBe(a.x);
    // The same start gives the same rest to the last bit (a frozen page starts the same way on every load);
    // another start ends within a few units in the last place of it, far below anything a picture shows.
    expect(again.rest.value).toBe(a.rest.value);
    expect(Math.abs(a.x - 120)).toBeLessThan(1e-12);
    expect(Math.abs(b.x - a.x)).toBeLessThan(1e-12);
  });

  it('gives up after maxSteps and says so', () => {
    let x = 0;
    const r = runToRest(x, () => (x += 1), String, 50);
    expect(r).toEqual({ value: 50, atRest: false, steps: 50 });
  });
});
