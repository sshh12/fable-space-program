import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFrameTimings, FRAME_STAGES } from './timing';

/** A clock the test steps by hand (the timings read `performance.now()`). */
let now = 0;
beforeEach(() => {
  now = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
});
afterEach(() => vi.restoreAllMocks());

/** One frame: `render` ms in the render stage, of which the hooks given; `sim` ms in the simulation stage. */
function frame(t: ReturnType<typeof createFrameTimings>, n: number, render: number, hooks: [string, string, number][] = [], sim = 0): void {
  t.begin();
  now += sim;
  t.mark('sim');
  for (const [feature, hook, ms] of hooks) t.hook(feature, `${feature}.${hook}`, ms);
  now += render;
  t.mark('render');
  t.end(n, () => `frame ${n}`);
}

describe('frame timings', () => {
  it('books stage time between marks and the rest of the render stage to the core', () => {
    const t = createFrameTimings();
    frame(t, 0, 5, [['terrain', 'prepare', 2], ['terrain', 'drawShadow', 0.5], ['vfx', 'prepare', 1]], 1);
    const s = t.stats();
    expect(s.frame.max).toBeCloseTo(6, 9);
    expect(s.stages.sim.max).toBeCloseTo(1, 9);
    expect(s.stages.render.max).toBeCloseTo(5, 9);
    expect(s.features['terrain']!.max).toBeCloseTo(2.5, 9);
    expect(s.features['vfx']!.max).toBeCloseTo(1, 9);
    expect(s.features['core']!.max).toBeCloseTo(1.5, 9);
    expect(Object.keys(s.stages).sort()).toEqual([...FRAME_STAGES].sort());
  });

  it('counts a feature that did not run in a frame as zero for that frame', () => {
    const t = createFrameTimings();
    frame(t, 0, 3, [['cockpit', 'compute', 2]]);
    frame(t, 1, 1);
    frame(t, 2, 1);
    const c = t.stats().features['cockpit']!;
    expect(c.count).toBe(3);
    expect(c.p50).toBe(0);
    expect(c.max).toBeCloseTo(2, 9);
  });

  it('keeps the slowest frames with their breakdown and note, slowest first, and drops them on reset', () => {
    const t = createFrameTimings();
    for (let n = 0; n < 30; n++) frame(t, n, n === 17 ? 20 : n === 4 ? 9 : 1, n === 17 ? [['cockpit', 'compute', 16]] : []);
    const slow = t.slowest();
    expect(slow).toHaveLength(12);
    expect(slow[0]!.frame).toBe(17);
    expect(slow[0]!.note).toBe('frame 17');
    expect(slow[0]!.features['cockpit']).toBeCloseTo(16, 9);
    expect(slow[0]!.hooks['cockpit.compute']).toBeCloseTo(16, 9);
    expect(slow[0]!.features['core']).toBeCloseTo(4, 9);
    expect(slow[1]!.frame).toBe(4);
    t.reset();
    expect(t.slowest()).toEqual([]);
    expect(t.stats().frame.count).toBe(0);
  });

  it('traces consecutive frames with a column per feature, padded where a feature came late', () => {
    const t = createFrameTimings();
    frame(t, 9, 1);
    t.startTrace(3);
    frame(t, 10, 2);
    frame(t, 11, 4, [['vfx', 'prepare', 3]], 0.5);
    frame(t, 12, 2);
    frame(t, 13, 2);
    const tr = t.takeTrace()!;
    expect(tr.firstFrame).toBe(10);
    expect(tr.total).toHaveLength(3);
    expect(tr.render).toEqual([2, 4, 2]);
    expect(tr.sim[1]).toBeCloseTo(0.5, 9);
    expect(tr.features['vfx']).toEqual([0, 3, 0]);
    expect(tr.features['core']).toEqual([2, 1, 2]);
    expect(tr.notes).toEqual(['frame 10', 'frame 11', 'frame 12']);
    expect(t.takeTrace()).toBeNull();
  });
});
