import { describe, expect, it } from 'vitest';
import { judgeIntervals, medianOf } from './frameIntervals';

const PERIOD = 1000 / 60;
/** `n` intervals of a 60 Hz display with the 0.1 ms steps of the browser's clock. */
const steady = (n: number): number[] => Array.from({ length: n }, (_, i) => (i % 3 === 0 ? 16.6 : 16.7));

describe('medianOf', () => {
  it('is the middle value, or the mean of the two middle ones', () => {
    expect(medianOf([3, 1, 2])).toBe(2);
    expect(medianOf([4, 1, 3, 2])).toBe(2.5);
    expect(Number.isNaN(medianOf([]))).toBe(true);
  });
});

describe('judgeIntervals (ARCHITECTURE 29, the frame-interval line as restated on 2026-11-12)', () => {
  it('passes a steady 60 Hz phase', () => {
    const v = judgeIntervals(steady(2000), PERIOD);
    expect(v.failures).toEqual([]);
    expect(v.frames).toBe(2000);
    expect(v.dropped).toBe(0);
    expect(v.longFrames).toBe(0);
    expect(v.medianDeviation).toBeLessThan(0.01);
  });

  it('passes what the old "p95 < 16.7 ms" line failed: intervals that scatter round the period', () => {
    const xs = Array.from({ length: 1000 }, (_, i) => PERIOD + ((i % 11) - 5) * 0.2);
    expect(judgeIntervals(xs, PERIOD).failures).toEqual([]);
  });

  it('counts an interval over 1.5 periods as a dropped frame and allows 0.5 % of them', () => {
    // 1 in 200 is exactly 0.5 %: allowed. 2 in 200 is 1 %: not.
    const one = [...steady(199), 26];
    expect(judgeIntervals(one, PERIOD)).toMatchObject({ dropped: 1, droppedShare: 0.005, longFrames: 0, failures: [] });
    const two = [...steady(198), 26, 26];
    const v = judgeIntervals(two, PERIOD);
    expect(v.dropped).toBe(2);
    expect(v.failures).toHaveLength(1);
    expect(v.failures[0]).toContain('2 dropped frame(s) in 200, 1.00 %');
    // Exactly 1.5 periods is not over it.
    expect(judgeIntervals([...steady(199), 1.5 * PERIOD], PERIOD).dropped).toBe(0);
  });

  it('a phase of fewer than 200 frames fails on a single dropped frame (the ignition phase of 2026-11-12: 1 in 182)', () => {
    const v = judgeIntervals([...steady(181), 28.4], PERIOD);
    expect(v.droppedShare).toBeCloseTo(1 / 182, 12);
    expect(v.failures).toHaveLength(1);
    expect(v.failures[0]).toContain('0.55 %');
  });

  it('fails on a frame of 33 ms or more, however few', () => {
    const v = judgeIntervals([...steady(5000), 33.4], PERIOD);
    expect(v.dropped).toBe(1);
    expect(v.longFrames).toBe(1);
    expect(v.failures).toEqual(['1 frame(s) of 33 ms or more (the longest 33.4 ms; line: none)']);
  });

  it('fails when the median is more than 1 % off the period (a page paced at 57.5 Hz, or at half rate)', () => {
    const slow = judgeIntervals(Array.from({ length: 500 }, () => 17.4), PERIOD);
    expect(slow.failures).toHaveLength(1);
    expect(slow.failures[0]).toContain('median interval 17.400 ms is 4.40 % off');
    const half = judgeIntervals(Array.from({ length: 500 }, () => 33.3), PERIOD);
    expect(half.failures).toHaveLength(3);
  });

  it('judges against the period it is given (a 144 Hz display)', () => {
    const p = 1000 / 144;
    expect(judgeIntervals(Array.from({ length: 1000 }, () => 6.9), p).failures).toEqual([]);
    expect(judgeIntervals([...Array.from({ length: 150 }, () => 6.9), 13.9], p).dropped).toBe(1);
  });

  it('no interval is a failure, not a pass', () => {
    expect(judgeIntervals([], PERIOD).failures).toEqual(['no frame interval was measured']);
  });
});
