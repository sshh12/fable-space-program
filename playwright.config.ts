import { defineConfig } from '@playwright/test';
import { chromeArgs } from './tests/browser/chromeArgs';

/**
 * Browser tests run in the INSTALLED Chrome (or Edge with E2E_CHANNEL=msedge) in new-headless mode, which
 * has real WebGPU on the discrete GPU. Playwright's bundled headless shell has no WebGPU adapter: never
 * remove `channel`. See docs/research/webgpu-harness.md.
 *
 * Projects:
 *   functional  everything except *.perf.spec.ts and mission specs; safe to run while other agents use the GPU
 *   perf        *.perf.spec.ts; each test must wrap its measurement in withGpuLock()
 *   mission     tests/browser/mission/**; the long real-time acceptance flight
 *   acceptance  tests/acceptance/**; the two-browser stories, restart, expiry and whole flights of v2
 *               (ARCHITECTURE 28.5), run inside a local stack: npm run stack -- [options] --
 *               node tools/dev/heavy.mjs --class=gpu -- npx playwright test --project=acceptance
 *
 * The dev server is started per run on a free port by globalSetup (E2E_BASE_URL); tests use appUrl(). With
 * STACK_URL set (inside `npm run stack`) globalSetup starts no server and every spec loads the stack's page.
 */
const runId = (process.env.E2E_RUN_ID ??= `${Date.now()}-${process.pid}`);

export default defineConfig({
  testDir: 'tests/browser',
  globalSetup: './tests/browser/globalSetup.ts',
  outputDir: `test-results/${runId}`,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: true,
  reporter: [['list']],
  use: {
    channel: process.env.E2E_CHANNEL ?? 'chrome',
    headless: process.env.E2E_HEADED ? false : true,
    viewport: { width: 1280, height: 720 },
    deviceScaleFactor: 1,
    launchOptions: { args: chromeArgs() },
    trace: 'off',
    video: 'off',
  },
  projects: [
    { name: 'functional', testIgnore: ['**/*.perf.spec.ts', 'mission/**'] },
    { name: 'perf', testMatch: ['**/*.perf.spec.ts'] },
    { name: 'mission', testMatch: ['mission/**/*.spec.ts'], timeout: 3 * 60 * 60_000 },
    { name: 'acceptance', testDir: 'tests/acceptance', testMatch: ['**/*.spec.ts'], timeout: 60 * 60_000 },
  ],
});
