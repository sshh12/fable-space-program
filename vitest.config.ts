import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const repoRoot = path.dirname(fileURLToPath(import.meta.url));

/**
 * Headless tests (Node, no GPU). Unit tests live next to the code as `*.test.ts` (src, tools, server, bots);
 * cross-module tests live in tests/unit; the universe rule, fuzz and adversarial suites in tests/universe; the
 * load-test scenarios' own tests in tests/load. Two suites are behind a switch because they cost minutes or
 * need other processes:
 *   MISSION=1   tests/mission   the full headless mission                   npm run test:mission
 *   NET=1       tests/net       separate-process multi-client suites, run inside a local stack
 *                               (npm run stack -- [options] -- npm run test:net)
 */
const suite = process.env.MISSION ? 'mission' : process.env.NET ? 'net' : 'unit';
const INCLUDE = {
  mission: ['tests/mission/**/*.test.ts'],
  net: ['tests/net/**/*.test.ts'],
  unit: ['src/**/*.test.ts', 'tests/unit/**/*.test.ts', 'tests/universe/**/*.test.ts', 'tests/load/**/*.test.ts', 'tools/**/*.test.ts', 'server/**/*.test.ts', 'bots/**/*.test.ts'],
} as const;
const TIMEOUT = { mission: 900_000, net: 600_000, unit: 30_000 } as const;

export default defineConfig({
  resolve: { alias: { '@': path.join(repoRoot, 'src') } },
  test: {
    environment: 'node',
    // Several agents run suites on this machine at once; the default (one worker per core) multiplied the
    // real-data suites into tens of GB. Raise with VITEST_MAX_WORKERS only on a quiet machine.
    maxWorkers: Number(process.env.VITEST_MAX_WORKERS ?? 6),
    include: [...INCLUDE[suite]],
    exclude: ['node_modules/**', 'dist/**', 'spikes/**'],
    testTimeout: TIMEOUT[suite],
    passWithNoTests: false,
  },
});
