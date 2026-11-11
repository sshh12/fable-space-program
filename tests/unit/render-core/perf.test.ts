import { describe, expect, it } from 'vitest';
import { Perf } from '@/render/core/perf';

/** Spin for `ms` milliseconds of wall time. */
function busy(ms: number): void {
  const t0 = performance.now();
  while (performance.now() - t0 < ms) {
    // spin
  }
}

describe('perf recorder: CPU frame time (request app-integration-1)', () => {
  it('is the caller\'s whole "frame" zone when it brackets renderer.render with one, else the renderer\'s own time', () => {
    // Without a 'frame' zone: core.render, as before.
    const plain = new Perf({} as GPUDevice, false);
    for (let i = 0; i < 12; i++) {
      plain.beginFrame(performance.now());
      plain.cpuBegin('core.render');
      busy(1);
      plain.cpuEnd('core.render');
      plain.resolve({} as GPUCommandEncoder);
    }
    const p = plain.snapshot(1, 1).cpu.p50;
    expect(p).toBeGreaterThanOrEqual(1);
    expect(p).toBeLessThan(2.5);

    // The app's frame: 3 ms of its own work around a 1 ms render. resolve() runs inside render(), with the
    // 'frame' zone still open; the zone's time is counted when it closes.
    const app = new Perf({} as GPUDevice, false);
    for (let i = 0; i < 12; i++) {
      app.beginFrame(performance.now());
      app.cpuBegin('frame');
      busy(1.5);
      app.cpuBegin('core.render');
      busy(1);
      app.cpuEnd('core.render');
      app.resolve({} as GPUCommandEncoder);
      busy(1.5);
      app.cpuEnd('frame');
    }
    const a = app.snapshot(1, 1).cpu.p50;
    expect(a).toBeGreaterThanOrEqual(4);
    expect(a).toBeLessThan(6);
  });
});
