#!/usr/bin/env node
/**
 * Runs the headless full-mission suite (tests/mission/**) with the MISSION switch that vitest.config.ts
 * reads. Kept out of `npm test` because it flies the whole Earth-Moon-Earth mission (minutes of CPU).
 * Extra arguments are passed to vitest, e.g. `npm run test:mission -- -t "reaches orbit"`.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const vitest = path.join(repoRoot, 'node_modules', 'vitest', 'vitest.mjs');
const res = spawnSync(process.execPath, [vitest, 'run', ...process.argv.slice(2)], {
  cwd: repoRoot,
  stdio: 'inherit',
  env: { ...process.env, MISSION: '1' },
});
process.exit(res.status ?? 1);
