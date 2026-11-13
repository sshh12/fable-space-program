/**
 * The displays' pacing rule (src/render/cockpit/pacing.ts; the lead's decision of visual round 5): a display
 * showing a fast flight-data page is painted at the full rate or better whenever a camera can read it; the
 * other pages share what is left of the main-thread budget; one paint per frame unless a fast page would
 * otherwise fall under its rate.
 */
import { describe, expect, it } from 'vitest';
import { DISPLAY_CPU_BUDGET } from '@/render/cockpit/displays';
import { DisplayPacer, type PacingRule } from '@/render/cockpit/pacing';
import { testDefs } from './helpers';
import { loadCockpitLayout } from '@/render/cockpit/layout';

const RULE: PacingRule = { rateHz: 15, fastPages: ['flight', 'entry', 'landing'], cpuBudget: DISPLAY_CPU_BUDGET, slowMinHz: 2 };

interface Run {
  paints: number[];
  /** Longest time between two paints of each display, s. */
  longestGap: number[];
  cpuMs: number;
  mostPerFrame: number;
  framesWithTwo: number;
}

/** Drive a pacer at `fps` for `seconds`; cost(page) = main-thread ms of one paint; visible(t) = a camera can read the screens. */
function run(pages: string[], cost: (page: string, n: number) => number, fps: number, seconds: number, visible: (t: number) => boolean = () => true, rule = RULE): Run {
  const pacer = new DisplayPacer(pages.length, rule);
  const pageOf = (i: number): string => pages[i]!;
  const out: Run = { paints: pages.map(() => 0), longestGap: pages.map(() => 0), cpuMs: 0, mostPerFrame: 0, framesWithTwo: 0 };
  const last: (number | null)[] = pages.map(() => null);
  for (let f = 0; f < fps * seconds; f++) {
    const t = f / fps;
    if (!visible(t)) {
      pacer.hidden();
      continue;
    }
    const due = pacer.due(t, pageOf);
    out.mostPerFrame = Math.max(out.mostPerFrame, due.length);
    if (due.length > 1) out.framesWithTwo++;
    for (const i of due) {
      const c = cost(pages[i]!, out.paints[i]!);
      out.paints[i]!++;
      out.cpuMs += c;
      if (last[i] !== null && t > 1) out.longestGap[i] = Math.max(out.longestGap[i]!, t - last[i]!);
      last[i] = t;
      pacer.painted(i, t, pages[i]!, c, pageOf);
    }
  }
  return out;
}

describe('cockpit display pacing', () => {
  it('the layout names its fast pages: the flight, entry and landing pages; the rule is its data', async () => {
    const { layout } = loadCockpitLayout(await testDefs(), 'kestrel');
    expect(layout.displays.rateHz).toBe(15);
    expect(layout.displays.fastPages).toEqual(expect.arrayContaining(['flight', 'entry', 'landing']));
    expect(layout.displays.fastPages).not.toContain('systems');
    expect(layout.displays.slowMinHz).toBeGreaterThan(0);
  });

  it('cheap pages: every display at 15 Hz, one paint per frame', () => {
    const r = run(['flight', 'orbit', 'systems'], () => 0.3, 60, 20);
    for (const n of r.paints) expect(n / 20).toBeGreaterThan(14.8);
    for (const n of r.paints) expect(n / 20).toBeLessThan(15.3);
    expect(r.mostPerFrame).toBe(1);
  });

  it('pages at the measured cost (0.7 ms): the flight page keeps 15 Hz, the slow pages are paced into the budget', () => {
    const r = run(['flight', 'orbit', 'systems'], () => 0.7, 60, 20);
    expect(r.paints[0]! / 20, 'flight page').toBeGreaterThan(14.8);
    expect(r.longestGap[0], 'flight page, longest gap').toBeLessThan(1 / 15 + 1 / 60 + 1e-6);
    // What the flight page leaves of the budget, shared by the two slow displays: (21.6 - 15 x 0.7) / 2 / 0.7 = 7.9 Hz.
    for (const i of [1, 2]) {
      expect(r.paints[i]! / 20).toBeGreaterThan(7);
      expect(r.paints[i]! / 20).toBeLessThan(8.5);
    }
    expect(r.cpuMs / 20, 'main-thread ms per second').toBeLessThan(DISPLAY_CPU_BUDGET * 1.03);
    expect(r.mostPerFrame).toBe(1);
  });

  it('a dear slow page does not slow the flight page and is never painted under its floor', () => {
    const r = run(['flight', 'orbit', 'systems'], (p) => (p === 'orbit' ? 6 : 0.7), 60, 20);
    expect(r.paints[0]! / 20, 'flight page').toBeGreaterThan(14.8);
    expect(r.paints[1]! / 20, 'orbit page').toBeGreaterThanOrEqual(RULE.slowMinHz * 0.97);
    expect(r.paints[1]! / 20, 'orbit page').toBeLessThan(RULE.slowMinHz * 1.1);
    expect(r.longestGap[1]).toBeLessThan(1 / RULE.slowMinHz + 1 / 60 + 1e-6);
  });

  it('a dear fast page is still painted at 15 Hz (the rule puts fast flight data before the budget)', () => {
    const r = run(['entry', 'orbit', 'systems'], (p) => (p === 'entry' ? 3 : 0.7), 60, 20);
    expect(r.paints[0]! / 20).toBeGreaterThan(14.8);
    // The slow pages get nothing of the budget then, and sit at their floor.
    for (const i of [1, 2]) expect(r.paints[i]! / 20).toBeLessThan(RULE.slowMinHz * 1.1);
  });

  it('three fast pages at 30 frames a second: each still at 15 Hz, two paints in a frame where it takes that', () => {
    const r = run(['flight', 'entry', 'landing'], () => 0.7, 30, 20);
    for (const n of r.paints) expect(n / 20).toBeGreaterThan(14.5);
    expect(r.mostPerFrame).toBeGreaterThan(1);
    // ... and never two in a frame at 60 frames a second, where every display has a frame of its own.
    const q = run(['flight', 'entry', 'landing'], () => 0.7, 60, 20);
    for (const n of q.paints) expect(n / 20).toBeGreaterThan(14.8);
    expect(q.mostPerFrame).toBe(1);
  });

  it('a slow first paint (a cold page) does not slow its display down', () => {
    const r = run(['flight', 'orbit', 'systems'], (_p, n) => (n === 0 ? 40 : 0.3), 60, 10);
    for (const n of r.paints) expect(n / 10).toBeGreaterThan(14.5);
  });

  it('nothing is painted while no camera can read the screens; all are current within three frames after', () => {
    const pacer = new DisplayPacer(3, RULE);
    const pages = ['flight', 'orbit', 'systems'];
    const pageOf = (i: number): string => pages[i]!;
    let t = 0;
    for (let f = 0; f < 120; f++, t += 1 / 60) for (const i of pacer.due(t, pageOf)) pacer.painted(i, t, pages[i]!, 0.7, pageOf);
    for (let f = 0; f < 600; f++, t += 1 / 60) pacer.hidden();
    const seen = new Set<number>();
    for (let f = 0; f < 3; f++, t += 1 / 60) {
      for (const i of pacer.due(t, pageOf)) {
        seen.add(i);
        pacer.painted(i, t, pages[i]!, 0.7, pageOf);
      }
    }
    expect([...seen].sort()).toEqual([0, 1, 2]);
  });

  it('a page change repaints that display on the next frame', () => {
    const pacer = new DisplayPacer(3, RULE);
    const pages = ['flight', 'orbit', 'systems'];
    const pageOf = (i: number): string => pages[i]!;
    let t = 0;
    for (let f = 0; f < 60; f++, t += 1 / 60) for (const i of pacer.due(t, pageOf)) pacer.painted(i, t, pages[i]!, 0.7, pageOf);
    pages[2] = 'landing';
    pacer.markDirty(2);
    expect(pacer.due(t, pageOf)[0]).toBe(2);
  });
});

describe('reset (the frame-exact capture restarts the pacing)', () => {
  it('goes back to "nothing painted": the same paints in the same frames as from construction, whatever was measured before', () => {
    const rule = { rateHz: 15, fastPages: ['flight'], cpuBudget: 21.6, slowMinHz: 2 };
    const pageOf = (i: number): string => ['flight', 'orbit', 'systems'][i]!;
    const run = (p: DisplayPacer): string => {
      const log: string[] = [];
      for (let f = 0; f < 64; f++) {
        const t = f / 60;
        for (const i of p.due(t, pageOf)) {
          log.push(`${f}:${i}`);
          p.painted(i, t, pageOf(i), 0, pageOf);
        }
      }
      return log.join(' ');
    };
    const fresh = run(new DisplayPacer(3, rule));
    const used = new DisplayPacer(3, rule);
    // A history: wall-clock times and costs that make the slow pages slow.
    for (let f = 0; f < 200; f++) for (const i of used.due(100 + f * 0.0171, pageOf)) used.painted(i, 100 + f * 0.0171, pageOf(i), 9 + (f % 5), pageOf);
    expect(used.hasDirty()).toBe(false);
    used.reset();
    expect(used.hasDirty()).toBe(true);
    expect(run(used)).toBe(fresh);
    // The three displays are painted in the first three frames, one a frame.
    expect(fresh.startsWith('0:0 1:1 2:2')).toBe(true);
  });
});
