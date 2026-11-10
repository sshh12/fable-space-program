/**
 * Baseline window.__test for the app shell and for lab pages. Installs global error capture immediately,
 * counts presented frames, and lets the page fill in what it supports. Everything a page does not provide
 * keeps a neutral implementation (null / no-op), so specs can rely on the full TestApi shape everywhere.
 */
import type { AdapterReport, TestApi } from '../contracts/testApi';

export interface TestApiController {
  api: TestApi;
  /** Record an error (also used as the GPU onError callback). */
  reportError(message: string): void;
  /** Call once per presented frame (inside requestAnimationFrame, after submitting GPU work). */
  frameDone(): void;
  setAdapter(report: AdapterReport): void;
  /** Resolve `ready` (true = initialised, false = failed; failures should also reportError). */
  markReady(ok: boolean): void;
  /** Merge page-specific implementations over the defaults. */
  extend(partial: Partial<TestApi>): void;
}

export function installTestApi(page: TestApi['page']): TestApiController {
  const errors: string[] = [];
  let frame = 0;
  const waiters: { target: number; resolve: () => void }[] = [];
  let resolveReady!: (ok: boolean) => void;
  const ready = new Promise<boolean>((r) => {
    resolveReady = r;
  });

  const reportError = (message: string): void => {
    errors.push(message);
    console.error(`[test-api] ${message}`);
  };
  window.addEventListener('error', (e) => errors.push(`window error: ${e.message}`));
  window.addEventListener('unhandledrejection', (e) => {
    const reason = e.reason as unknown;
    errors.push(`unhandled rejection: ${reason instanceof Error ? reason.message : String(reason)}`);
  });

  const api: TestApi = {
    ready,
    errors,
    adapter: null,
    state: () => null,
    milestones: () => [],
    isIdle: () => true,
    waitFrames: (n) =>
      new Promise<void>((resolve) => {
        waiters.push({ target: frame + Math.max(1, n), resolve });
      }),
    perf: () => null,
    resetPerf: () => undefined,
    setControls: () => undefined,
    commands: null,
    pilot: null,
    setView: () => undefined,
    camera: () => null,
    setCameraOrbit: () => undefined,
    setDeterministic: () => undefined,
    setPaused: () => undefined,
    hdrStats: () => Promise.resolve({ maxLuminance: 0, meanLuminance: 0, nanPixels: 0 }),
    audio: () => null,
    map: () => [],
    page,
  };
  window.__test = api;

  return {
    api,
    reportError,
    frameDone() {
      frame++;
      for (let i = waiters.length - 1; i >= 0; i--) {
        if (waiters[i]!.target <= frame) {
          waiters[i]!.resolve();
          waiters.splice(i, 1);
        }
      }
    },
    setAdapter(report) {
      api.adapter = report;
    },
    markReady(ok) {
      resolveReady(ok);
    },
    extend(partial) {
      Object.assign(api, partial);
    },
  };
}
