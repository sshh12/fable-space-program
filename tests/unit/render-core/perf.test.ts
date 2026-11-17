import { describe, expect, it } from 'vitest';
import { Perf } from '@/render/core/perf';

/** Spin for `ms` milliseconds of wall time. */
function busy(ms: number): void {
  const t0 = performance.now();
  while (performance.now() - t0 < ms) {
    // spin
  }
}

/** A recorder on a clock the test owns: its CPU zones read `clock.t` (ms), which moves only when the test moves it. */
function onInjectedClock(): { perf: Perf; clock: { t: number } } {
  const clock = { t: 1000 };
  return { perf: new Perf({} as GPUDevice, false, () => clock.t), clock };
}

/**
 * What this runner's own clock says the frames took, measured the way the recorder measures them: the real clock
 * read just outside each zone the recorder times, in the same frames, and the recorder's statistic of them (its
 * median: the sorted sample at index floor(n / 2)). The recorder reads the same clock between those two reads, so
 * its time is never the larger one. A real-time bound is then this time plus a fixed margin, never less than the
 * acceptance line: on a machine that holds the line it is the line; on a shared CI runner it is what the runner
 * allows, and a recorder that is wrong by more than the margin still fails.
 */
function runnerOwnTime(samples: number[]): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

/** The real-time bound: the acceptance line, or the runner's own measured time plus `margin` when that is larger. */
function realTimeBound(line: number, measured: number, margin: number): number {
  return Math.max(line, measured + margin);
}

describe('perf recorder: CPU frame time (request app-integration-1)', () => {
  it('is the caller\'s whole "frame" zone when it brackets renderer.render with one, else the renderer\'s own time, EXACTLY on the injected clock (everywhere, CI included)', () => {
    // Twelve frames whose render takes 1..12 ms, out of order.
    const RENDER = [5, 1, 9, 3, 12, 7, 2, 11, 4, 8, 6, 10];

    // Without a 'frame' zone: core.render, as before.
    const { perf: plain, clock: pc } = onInjectedClock();
    for (const r of RENDER) {
      plain.beginFrame(pc.t);
      plain.cpuBegin('core.render');
      pc.t += r;
      plain.cpuEnd('core.render');
      plain.resolve({} as GPUCommandEncoder);
    }
    // A percentile p of n frames is the sorted sample at index floor(p * n): of 1..12 ms, the 7th and the 12th.
    expect(plain.snapshot(1, 1).cpu).toEqual({ p50: 7, p95: 12, p99: 12 });

    // The app's frame: 1.5 ms of its own work on each side of the same render. resolve() runs inside render(),
    // with the 'frame' zone still open; the zone's time is counted when it closes.
    const { perf: app, clock: ac } = onInjectedClock();
    for (const r of RENDER) {
      app.beginFrame(ac.t);
      app.cpuBegin('frame');
      ac.t += 1.5;
      app.cpuBegin('core.render');
      ac.t += r;
      app.cpuEnd('core.render');
      app.resolve({} as GPUCommandEncoder);
      ac.t += 1.5;
      app.cpuEnd('frame');
    }
    // 3 ms more than the render in every frame: 4..15 ms, the 7th is 10 and the 12th is 15.
    const s = app.snapshot(1, 1);
    expect(s.cpu).toEqual({ p50: 10, p95: 15, p99: 15 });
    // The renderer's own time is still the core's in the per-feature breakdown (p99 of 1..12 ms).
    expect(s.features).toEqual({ core: { gpuMs: 0, cpuMs: 12 } });
  });

  it('is the caller\'s whole "frame" zone when it brackets renderer.render with one, else the renderer\'s own time, on the real clock: 1 ms of render within 2.5 ms, a 4 ms frame within 6 ms (or the runner\'s own time for the same frames, measured)', () => {
    // Without a 'frame' zone: core.render, as before.
    const plain = new Perf({} as GPUDevice, false);
    const plainOwn: number[] = [];
    for (let i = 0; i < 12; i++) {
      plain.beginFrame(performance.now());
      const t0 = performance.now();
      plain.cpuBegin('core.render');
      busy(1);
      plain.cpuEnd('core.render');
      plainOwn.push(performance.now() - t0);
      plain.resolve({} as GPUCommandEncoder);
    }
    const p = plain.snapshot(1, 1).cpu.p50;

    // The app's frame: 3 ms of its own work around a 1 ms render.
    const app = new Perf({} as GPUDevice, false);
    const appOwn: number[] = [];
    for (let i = 0; i < 12; i++) {
      app.beginFrame(performance.now());
      const t0 = performance.now();
      app.cpuBegin('frame');
      busy(1.5);
      app.cpuBegin('core.render');
      busy(1);
      app.cpuEnd('core.render');
      app.resolve({} as GPUCommandEncoder);
      busy(1.5);
      app.cpuEnd('frame');
      appOwn.push(performance.now() - t0);
    }
    const a = app.snapshot(1, 1).cpu.p50;

    const renderOwn = runnerOwnTime(plainOwn);
    const frameOwn = runnerOwnTime(appOwn);
    const renderBound = realTimeBound(2.5, renderOwn, 0.5);
    const frameBound = realTimeBound(6, frameOwn, 0.5);
    console.log(
      `perf recorder: CPU frame time p50 ${p.toFixed(2)} ms (the renderer alone, 1 ms spun) and ${a.toFixed(2)} ms (the app's frame, 4 ms spun); ` +
        `runner's own time for the same frames ${renderOwn.toFixed(2)} ms and ${frameOwn.toFixed(2)} ms; ` +
        `bounds ${renderBound.toFixed(2)} ms (the 2.5 ms line ${renderBound === 2.5 ? 'holds here' : 'is beyond this runner'}) ` +
        `and ${frameBound.toFixed(2)} ms (the 6 ms line ${frameBound === 6 ? 'holds here' : 'is beyond this runner'})`,
    );
    // A spin never ends early, so the lower bounds need no calibration.
    expect(p).toBeGreaterThanOrEqual(1);
    expect(p).toBeLessThan(renderBound);
    expect(a).toBeGreaterThanOrEqual(4);
    expect(a).toBeLessThan(frameBound);
  });
});

describe('perf recorder: the windows EXACTLY on the injected clock (everywhere, CI included)', () => {
  it('percentiles are the sorted sample at index floor(p * n) of the last 300 frames', () => {
    const { perf, clock } = onInjectedClock();
    const frame = (renderMs: number): void => {
      perf.beginFrame(clock.t);
      perf.cpuBegin('core.render');
      clock.t += renderMs;
      perf.cpuEnd('core.render');
      perf.resolve({} as GPUCommandEncoder);
    };
    // 100 frames of 1..100 ms, out of order (37 has no factor in common with 100); the first one takes 1 ms.
    for (let i = 0; i < 100; i++) frame(((i * 37) % 100) + 1);
    expect(perf.snapshot(1, 1).cpu).toEqual({ p50: 51, p95: 96, p99: 100 });
    // 200 more, 101..300 ms: the window is full.
    for (let ms = 101; ms <= 300; ms++) frame(ms);
    expect(perf.snapshot(1, 1).cpu).toEqual({ p50: 151, p95: 286, p99: 298 });
    // Frame 301 (1000 ms) takes the place of the oldest, the 1 ms frame: 2..300 ms and 1000 ms.
    frame(1000);
    expect(perf.snapshot(1, 1).cpu).toEqual({ p50: 152, p95: 287, p99: 299 });
  });

  it('a zone opened twice in a frame adds up; a zone goes to its feature, any other to the core, "frame" to none and into the window only when it closes', () => {
    const { perf, clock } = onInjectedClock();
    perf.setFeatureIds(['ocean']);
    perf.beginFrame(clock.t);
    perf.cpuBegin('frame');
    perf.cpuBegin('ocean.update');
    clock.t += 2;
    perf.cpuEnd('ocean.update');
    perf.cpuBegin('core.render');
    clock.t += 1.5;
    perf.cpuEnd('core.render');
    perf.cpuBegin('ocean.update');
    clock.t += 0.5;
    perf.cpuEnd('ocean.update');
    perf.cpuBegin('hud.draw'); // not a feature id: the core's
    clock.t += 0.25;
    perf.cpuEnd('hud.draw');
    perf.cpuEnd('never.begun'); // ignored
    perf.resolve({} as GPUCommandEncoder);
    clock.t += 1;
    expect(perf.snapshot(1, 1).cpu).toEqual({ p50: 0, p95: 0, p99: 0 });
    perf.cpuEnd('frame');
    const s = perf.snapshot(1, 1);
    // 2 + 1.5 + 0.5 + 0.25 + 1 ms.
    expect(s.cpu).toEqual({ p50: 5.25, p95: 5.25, p99: 5.25 });
    expect(s.features).toEqual({ core: { gpuMs: 0, cpuMs: 1.75 }, ocean: { gpuMs: 0, cpuMs: 2.5 } });
  });

  it('frame intervals are the differences of the times beginFrame is given: none for the first frame, 33 ms and longer counted', () => {
    const { perf } = onInjectedClock();
    let t = 1000;
    perf.beginFrame(t);
    for (const d of [16, 20, 17, 33, 18, 50, 19, 32, 21, 22]) perf.beginFrame((t += d));
    // Sorted: 16 17 18 19 20 21 22 32 33 50; index floor(0.5 * 10) = 5, floor(0.95 * 10) = floor(0.99 * 10) = 9.
    expect(perf.snapshot(1, 1).raf).toEqual({ p50: 21, p95: 50, p99: 50, max: 50, count: 10, over33ms: 2 });
  });

  it('reset empties every window and the count of long frames; the next frame fills them again', () => {
    const { perf, clock } = onInjectedClock();
    perf.setFeatureIds(['ocean']);
    const frame = (oceanMs: number, renderMs: number, restMs: number): void => {
      perf.beginFrame(clock.t);
      perf.cpuBegin('ocean.update');
      clock.t += oceanMs;
      perf.cpuEnd('ocean.update');
      perf.cpuBegin('core.render');
      clock.t += renderMs;
      perf.cpuEnd('core.render');
      perf.resolve({} as GPUCommandEncoder);
      clock.t += restMs;
    };
    // Three frames 40 ms apart: 2 ms of ocean, 5 ms of render.
    for (let i = 0; i < 3; i++) frame(2, 5, 33);
    let s = perf.snapshot(1, 1);
    expect(s.raf).toEqual({ p50: 40, p95: 40, p99: 40, max: 40, count: 2, over33ms: 2 });
    expect(s.cpu).toEqual({ p50: 5, p95: 5, p99: 5 });
    expect(s.features).toEqual({ core: { gpuMs: 0, cpuMs: 5 }, ocean: { gpuMs: 0, cpuMs: 2 } });

    perf.reset();
    s = perf.snapshot(1, 1);
    expect(s.raf).toEqual({ p50: 0, p95: 0, p99: 0, max: 0, count: 0, over33ms: 0 });
    expect(s.cpu).toEqual({ p50: 0, p95: 0, p99: 0 });
    expect(s.features).toEqual({ core: { gpuMs: 0, cpuMs: 0 }, ocean: { gpuMs: 0, cpuMs: 0 } });

    // The next frame begins 40 ms after the last one before the reset: 1 ms of ocean, 3 ms of render.
    frame(1, 3, 12);
    s = perf.snapshot(1, 1);
    expect(s.raf).toEqual({ p50: 40, p95: 40, p99: 40, max: 40, count: 1, over33ms: 1 });
    expect(s.cpu).toEqual({ p50: 3, p95: 3, p99: 3 });
    expect(s.features).toEqual({ core: { gpuMs: 0, cpuMs: 3 }, ocean: { gpuMs: 0, cpuMs: 1 } });
  });
});
