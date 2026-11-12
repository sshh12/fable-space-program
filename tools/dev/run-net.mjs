#!/usr/bin/env node
/**
 * Runs the separate-process multi-client suites (tests/net/**) with the NET switch that vitest.config.ts
 * reads. Kept out of `npm test` because they start server roles and clients as processes and need a local
 * stack around them (ARCHITECTURE 16.4, 28.4):
 *
 *   npm run stack -- [options] -- npm run test:net -- [vitest arguments]
 *
 * Refuses to run outside a stack (STACK_ENDPOINTS is how every client finds the roles; no test is handed a
 * gateway address by configuration). Extra arguments are passed to vitest.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
if (!process.env.STACK_ENDPOINTS && !process.env.NET_WITHOUT_STACK) {
  console.error('test:net: no local stack around this run (STACK_ENDPOINTS is not set). Start it as: npm run stack -- [options] -- npm run test:net');
  console.error('          (NET_WITHOUT_STACK=1 runs the suites that start their own processes, e.g. to list the collected files.)');
  process.exit(3);
}
const vitest = path.join(repoRoot, 'node_modules', 'vitest', 'vitest.mjs');
const res = spawnSync(process.execPath, [vitest, 'run', ...process.argv.slice(2)], {
  cwd: repoRoot,
  stdio: 'inherit',
  env: { ...process.env, NET: '1' },
});
process.exit(res.status ?? 1);
