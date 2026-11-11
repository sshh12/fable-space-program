import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const repoRoot = path.dirname(fileURLToPath(import.meta.url));

/**
 * Headless tests (Node, no GPU). Unit tests live next to the code as `*.test.ts`; cross-module tests live in
 * tests/unit. The full headless mission (minutes of CPU) lives in tests/mission and only runs with
 * `npm run test:mission` (MISSION=1).
 */
export default defineConfig({
  resolve: { alias: { '@': path.join(repoRoot, 'src') } },
  test: {
    environment: 'node',
    // Several agents run suites on this machine at once; the default (one worker per core) multiplied the
    // real-data suites into tens of GB. Raise with VITEST_MAX_WORKERS only on a quiet machine.
    maxWorkers: Number(process.env.VITEST_MAX_WORKERS ?? 6),
    include: process.env.MISSION
      ? ['tests/mission/**/*.test.ts']
      : ['src/**/*.test.ts', 'tests/unit/**/*.test.ts', 'tools/**/*.test.ts'],
    exclude: ['node_modules/**', 'dist/**', 'spikes/**'],
    testTimeout: process.env.MISSION ? 900_000 : 30_000,
    passWithNoTests: false,
  },
});
